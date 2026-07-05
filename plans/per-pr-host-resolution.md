# Per-PR Host Resolution (dual GitHub + alt-host repos)

## Problem

Alt-host support (`api_host` in repo config, see `docs/alt-host.md`) is repo-exclusive:
if a repo has `api_host` configured, **every** PR for that repo is resolved against the
alternate host. Real migration scenarios are mixed — some PRs for a repo still live on
GitHub/Graphite while newer ones exist only on the alternate host.

Additionally, the dashboard collections (`src/routes/github-collections.js`) query
github.com only, with the top-level token. Alt-host PRs never appear in any list today;
they are reachable only by pasting a URL.

**Assumption (confirmed):** PR numbers do NOT collide between systems for the same repo.
A given `(repository, pr_number)` identifies exactly one PR, whichever host it lives on.
Therefore `UNIQUE(pr_number, repository)` stays; the `/pr/:owner/:repo/:number` URL
scheme is unchanged.

## Design summary

1. **Config:** new per-repo boolean `exclusive` (only valid alongside `api_host`).
   `exclusive: true` (the default) = today's behavior, alt host only.
   `exclusive: false` = dual repo — PRs may live on github.com OR the alt host.
2. **Persistence:** new `host TEXT` column on `pr_metadata` and `github_pr_cache`.
   `NULL` = github.com; otherwise the `api_host` URL string. Store the URL string, not
   the config key — config keys can be renamed; token/features are re-resolved from
   config at runtime by matching the string.
3. **Resolution:** `resolveHostBinding(repository, config, { host })` gains an optional
   per-PR host override. `resolveBindingForRequest` (PR-mode routes) reads the stored
   host from `pr_metadata` and passes it through.
4. **Derivation:** host is learned from (a) which URL pattern matched a pasted URL,
   (b) which host a PR was found on during collections refresh, (c) probing at setup
   time for bare PR numbers, in that order of confidence. Once learned, it is stored.

## Backward compatibility rules

- Repo with `api_host`, no `exclusive` key → `exclusive: true` → identical to today.
- Existing `pr_metadata` rows have `host = NULL`. Fallback rule when stored host is
  NULL/missing: derive from repo config exactly as today (exclusive alt-host repo →
  alt host; otherwise github). No migration backfill needed — the fallback makes old
  rows resolve identically, and rows are re-stamped on next fetch.
- Repos without `api_host`: completely unaffected on every path.

## Ambiguity rule (dual repo, host unknown)

When a dual repo (`exclusive: false`) needs a binding and no per-PR host is available:

- **Probing contexts** (PR setup with a bare number): probe the alt host first
  (`GET /repos/{owner}/{repo}/pulls/{n}`), on 404 fall back to github.com. A repo
  configured with `api_host` is actively using it, so alt-first is the common case.
  Record the winner in `pr_metadata.host`.
- **Non-probing contexts** (local-mode branch enrichment, repo-level operations with
  no PR identity): use the **github** binding. The repo also exists on github.com and
  top-level credentials exist there; this is opt-in behavior only for repos newly
  marked `exclusive: false`.

---

## Phase 1 — Config: `exclusive` flag

**Files:** `src/config.js`, `docs/alt-host.md`, `README.md`

- `getRepoConfig` output gains `exclusive`. Resolution helper (new):
  `isExclusiveAltHost(repoConfig)` → `repoConfig.api_host && repoConfig.exclusive !== false`.
- `validateRepoConfig` (`src/config.js:790`):
  - `exclusive` must be a boolean if present.
  - `exclusive` without `api_host` → startup error (meaningless).
- **Feature resolution per binding, not per repo.** `_resolveFeatures(apiHost, explicit)`
  (`src/config.js:508`) already keys on `apiHost`. For a dual repo:
  - alt-host binding → explicit repo `features` apply, defaults as today (`rest`/`host`).
  - github binding → standard github defaults (`graphql`-preferred); the repo's explicit
    `features` block does NOT apply (it was written for the alt host). Document this.
- Token resolution split (inside `resolveHostBinding`):
  - alt-host binding → repo `token` / `token_command` only (unchanged).
  - github binding of a dual repo → the normal github.com chain (`GITHUB_TOKEN` →
    top-level `github_token` / `github_token_command`). Do **not** use the repo-scoped
    alt-host token for github.com. If the repo config has BOTH github and alt
    credentials needs in future, that's a follow-up (`github_token` override per repo
    already exists via the top-level chain).

## Phase 2 — Database: `host` column

**Files:** `src/database.js`, `tests/e2e/global-setup.js`, `tests/integration/routes.test.js`

- Migration v50 (`CURRENT_SCHEMA_VERSION` 49 → 50):
  - `ALTER TABLE pr_metadata ADD COLUMN host TEXT` — guarded by `columnExists`.
  - `ALTER TABLE github_pr_cache ADD COLUMN host TEXT` — guarded by `columnExists`.
  - No backfill (see back-compat rules). No table rebuild, no uniqueness change.
- Update `SCHEMA_SQL` for fresh databases.
- Update BOTH test schemas (e2e global-setup, integration routes.test.js) — column and
  any index names must match production exactly.
- `storePRData` (`src/setup/pr-setup.js:79-114`) accepts and writes `host` on both the
  UPDATE and INSERT arms.
- New read helper on database: `getPRHost(repository, prNumber)` → stored host or
  `undefined` (row missing) — distinguish "no row" from "row says github (NULL)".
  NOTE: with the NULL-means-github convention, an old row (NULL from before migration)
  and a new github row (NULL on purpose) resolve identically under the fallback rule
  only for non-dual repos. For dual repos, a NULL stored host means "github" — that is
  correct for rows written after this change, and old rows for such repos get
  re-stamped on next fetch. Acceptable: a repo becomes dual only when the user edits
  config, and the probe path self-heals stale rows (see Phase 4).

## Phase 3 — Core resolution: per-PR host override

**Files:** `src/config.js`, `src/routes/pr.js`, `src/github/client.js` (no change
expected — it already takes a binding object)

- `resolveHostBinding(repository, config, options = {})`:
  - `options.host === undefined` → legacy behavior + ambiguity rule: exclusive alt-host
    repo → alt binding; dual repo → github binding; plain repo → github binding.
  - `options.host === null` → github binding. For an **exclusive** alt-host repo this is
    a caller bug — throw with a clear message rather than silently using github.
  - `options.host === '<url>'` → alt binding; must equal the repo's configured
    `api_host` (else throw: stale stored host after a config change — the error message
    should say the stored host no longer matches config and suggest re-opening the PR
    from a URL).
  - Returned binding gains a `host` echo field so callers can persist what was used.
- `resolveBindingForRequest(req, repository)` (`src/routes/pr.js:138`):
  - Extract `prNumber` from `req.params` (all 11 current call sites are
    `/:owner/:repo/:number` routes — verify each), call `getPRHost`, pass
    `{ host }` when a row exists; omit when not.
  - Keep the existing loud failure for alt-host bindings with no token.
- Repo-level callers keep two-arg calls (ambiguity rule applies):
  `src/routes/config.js:152,313`, `src/routes/setup.js:70`, `src/git/base-branch.js:17`,
  `src/routes/mcp.js:797`, local-mode sites (see Phase 7).

## Phase 4 — Derivation at setup time

**Files:** `src/github/parser.js`, `src/routes/pr.js` (parse-pr-url), `src/routes/setup.js`,
`src/setup/pr-setup.js`, `src/main.js`

- **Parser carries host.** `parsePRUrl` result gains `host`:
  - `_matchUrlPatternFromConfig` matched → the matched repo's `api_host`.
  - `parseGitHubURL` / `parseGraphiteURL` / protocol URL → `host: null`.
  - Bare number / git-remote paths → `host: undefined` (unknown; probe later).
- **Fix `POST /api/parse-pr-url`** (`src/routes/pr.js:1948-1955`): it currently drops
  `bindingRepository`. Return `host` (and `bindingRepository`) so the web client can
  pass them to setup.
- **Setup endpoint** `POST /api/setup/pr/:owner/:repo/:number` (`src/routes/setup.js:53`)
  accepts an optional `host` in the body. Precedence when choosing the fetch binding:
  1. explicit `host` from the request (URL paste knows best),
  2. stored `pr_metadata.host`,
  3. ambiguity rule + probe for dual repos: fetch from alt host, on 404 retry github.
     Distinguish 404 (try next host) from auth/network errors (fail loudly — a 401 on
     the alt host must NOT silently fall back to github and fetch the wrong PR).
- **CLI path** (`src/main.js:947-957`, `src/setup/pr-setup.js:436-467`): same precedence.
  The parser's `host` (URL paste into CLI) or DB row wins; bare numbers probe.
- After a successful fetch, `storePRData` stamps the host actually used — this is the
  self-healing step for stale/NULL rows.

## Phase 5 — Collections: list PRs from both systems

**Files:** `src/routes/github-collections.js`, `src/github/client.js` (maybe a small
list helper), frontend dashboard JS that renders collection rows

- Refresh handler (`github-collections.js:148-201`), after the existing github.com
  search, iterates config repos with `api_host` (both exclusive and dual):
  - Build an alt-host client from `resolveHostBinding(repoKey, config, { host: apiHost })`.
  - Alt hosts speak a REST subset — the Search API very likely doesn't exist. Use
    `GET /repos/{owner}/{repo}/pulls?state=open` (octokit `pulls.list`) and classify
    locally into collections: `my-prs` → `pr.user.login === login`; `review-requests` →
    `requested_reviewers` contains login; `team-reviews` → `requested_teams` non-empty
    match. Get `login` from `GET /user` on the alt host once per refresh, cached.
  - **Best-effort per host:** wrap each alt-host repo in try/catch; log failures via
    `logger`; never let an alt-host timeout or 501 break the github.com refresh. Include
    per-host status in the refresh response so the UI can show partial results honestly.
- Stamp `host` on every `github_pr_cache` row (NULL for github.com results).
- `GET /api/github/:collection` returns `host` per row.
- **Frontend:** when a collection row is clicked, pass its `host` through to the setup
  call (`POST /api/setup/pr/...` body) so a dual repo's alt-host PR opens against the
  right system without probing.
- Dedup note: for a dual repo, the same PR cannot appear on both hosts (no-collision
  assumption + a PR lives in exactly one system), so no cross-host dedup is needed;
  `UNIQUE(collection, owner, repo, number)` already collapses accidental duplicates —
  last write wins, and both writes would describe the same logical PR only if a host
  lies. Acceptable.

## Phase 6 — Links and display

**Files:** `src/links/repo-links.js`, `src/routes/pr.js:1752` (resolveHostName caller),
frontend header rendering

- `resolveRepoLinks` / `resolveHostName` become host-aware: accept the PR's resolved
  host. For a dual repo:
  - github-hosted PR → GitHub (and Graphite, if enabled) links; hide the external link
    unless configured otherwise.
  - alt-hosted PR → external link from `links.external`; hide GitHub/Graphite links.
  - `links.github: false` etc. remain user overrides on top of this default.
- Exclusive repos and plain repos render exactly as today.

## Phase 7 — Local mode parity

**Files:** `src/routes/local.js`, `src/local-review.js`

- Local mode has no PR identity; it uses the host binding for best-effort enrichment
  (`local.js:501-509, 723-724, 2119-2120`; `local-review.js:802`). Apply the ambiguity
  rule: dual repo → github binding; exclusive alt-host repo → alt binding (unchanged).
  All these sites stay two-arg `resolveHostBinding` calls and must keep swallowing
  absence (best-effort), never throwing like PR mode.
- No local-mode DB changes: `reviews.review_type='local'` rows have no PR host.

## Phase 8 — Tests

- **Unit** (`tests/unit/`):
  - config: `exclusive` validation (boolean check, requires `api_host`); binding
    resolution matrix — {plain, exclusive, dual} × {host undefined, null, url,
    stale-url} including the throw cases.
  - parser: `host` on every parse path (url_pattern, github URL, graphite URL, bare
    number, git remote).
  - probe logic: alt 200 → alt; alt 404 → github; alt 401 → loud error, no fallback.
  - migration v50: fresh DB has columns; v49 DB migrates; migration is idempotent
    (re-run guarded by `columnExists`).
  - repo-links host-awareness matrix.
- **Integration** (`tests/integration/`): setup endpoint host precedence (body host >
  stored host > probe); parse-pr-url returns host; collections refresh stamps host and
  survives a failing alt host (mock server per `tests/CONVENTIONS.md` — loopback
  server, no real network, no fixed sleeps).
- **E2E**: dashboard row with alt host opens PR against alt host (mocked); dual-repo
  PR page shows the correct link set. Frontend changed → run `pnpm run test:e2e`.
- Regression: a repo with `api_host` and no `exclusive` key behaves byte-identically
  to today across the existing alt-host test suite.

## Phase 9 — Docs, changeset

- `docs/alt-host.md`: `exclusive` flag, per-PR host storage, derivation order,
  ambiguity rule, feature-resolution-per-binding note, collections behavior.
- `README.md`: brief mention under alt-host config.
- Changeset: `minor` — new user-facing feature ("dual-host repos: per-PR host
  resolution").
- Regenerate skill prompts only if `src/ai/prompts/` is touched (not expected).

---

## Hazards

- **`resolveHostBinding` has ~25 call sites** (`src/main.js:957,1110,1124,1739,1751`;
  `src/routes/pr.js` via `resolveBindingForRequest` ×11; `src/routes/stack-analysis.js:213,256`;
  `src/routes/external-comments.js:119` (adapter); `src/routes/mcp.js:797`;
  `src/routes/config.js:152,313`; `src/routes/setup.js:70`; `src/setup/pr-setup.js:436`;
  `src/setup/stack-setup.js:49`; `src/routes/local.js:501,723,2119`;
  `src/local-review.js:802`; `src/git/base-branch.js:17`). Every caller must be
  classified as PR-scoped (pass `{host}`) or repo-scoped (ambiguity rule). The
  signature change is additive (optional third arg) so unclassified callers get the
  ambiguity rule — which CHANGES behavior for dual repos (github instead of alt).
  That is the intended default, but each repo-scoped caller must be checked against it.
- **`resolveBindingForRequest` is the shared chokepoint for 11 PR-mode routes** (get,
  refresh, diff, drafts, submit-review, analyses, council, share, stack-info). Verify
  each has `:number` in its route params before assuming PR scope; any repo-scoped
  route piggybacking on it must not pass a PR host.
- **Token semantics change for dual repos:** alt binding skips ALL github credentials
  by design (`config.js:582-644`). The github binding of a dual repo must take the
  normal top-level chain. A mistake here silently authenticates against the wrong host.
- **Probe fallback must distinguish 404 from auth failure.** 401/403 on the alt host
  falling through to github.com would fetch a same-numbered PR from the wrong system
  and stamp the wrong host. Only 404 (and the host's documented "not found" shape)
  may trigger fallback.
- **Async: collections refresh now fans out to N hosts.** The completion handler
  previously assumed one search was the only thing in flight. Partial failure must not
  poison the cache: write github rows and alt rows independently; a thrown alt-host
  error after github rows are written must not roll them back or double-write on retry
  (`UNIQUE(collection, owner, repo, number)` upsert semantics protect the latter).
- **Stale stored host after config edit** (user removes/changes `api_host`): stored
  `pr_metadata.host` no longer matches config. `resolveHostBinding` throws a targeted
  error (Phase 3) rather than binding to a dead host; re-opening from a URL re-stamps.
- **`POST /api/parse-pr-url` currently drops `bindingRepository`** (`pr.js:1948-1955`)
  — the web setup path re-derives it. Returning host/bindingRepository changes this
  endpoint's response shape; check all frontend consumers of the response.
- **Migration test schemas are duplicated** in `tests/e2e/global-setup.js` and
  `tests/integration/routes.test.js` — both must add the `host` columns or CI diverges
  from production.
- **Local vs PR mode parity:** local mode treats bindings as optional enrichment and
  swallows absence; PR mode throws. Phase 7 must preserve that split — the ambiguity
  rule must not introduce a throw on any local path.
- **Prior guard to preserve:** `syncPendingDraftFromGitHub` (`pr.js:187`) already
  tolerates alt-host REST responses lacking `node_id`; the github binding of a dual
  repo re-enables GraphQL paths — verify the graphql/rest dispatch per binding doesn't
  regress that reconciliation.
