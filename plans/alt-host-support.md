# Alternate Git-Host Support

## Goal

Allow pair-review to operate against a self-hosted, GitHub-compatible Git
host on a per-repo basis. The alternate host (referred to here as the
"alt-host") advertises a GitHub-compatible REST API surface but does **not**
implement GitHub's GraphQL API. The alt-host operator may also expose
extension endpoints beyond GitHub's REST surface (e.g. bulk-add comments to
a pending review), which pair-review can opt into per-area.

The mechanism must be entirely config-driven. No code in this repository
should reference any specific operator, product name, or organisation that
runs an alt-host instance — only the generic concept.

## Non-Goals

- Multi-host federation in a single review session. One review = one host.
- Automatic discovery of alt-host capabilities. Capabilities are declared
  via config feature flags.
- Migration of existing GitHub-tied reviews to an alt-host repo.
- Changing how Local mode (uncommitted-diff review) works. Local mode
  performs no remote API calls today, so it is unaffected. Submission paths
  that talk to a remote (PR mode) are the only thing touched.

## High-Level Approach

1. Extend per-repo config (`config.repos["owner/repo"]`) with three new
   keys: `api_host`, `token` / `token_command`, and `features`.
2. Add an optional `url_pattern` (regex) per repo so that URLs pasted on the
   CLI can be resolved to the right repo entry without hardcoded host
   parsing.
3. Replace direct reads of `config.github_token*` / `'https://api.github.com'`
   with a single `resolveHostBinding(repository, config)` helper that
   returns `{ apiHost, token, features }`.
4. Refactor `GitHubClient` to accept that binding at construction; pass
   `baseUrl: apiHost` to Octokit unchanged. The class keeps its name and
   external shape — only its internals branch on `features`.
5. Add REST equivalents for the eight GraphQL operations that GitHub itself
   supports via REST. Each operation becomes a dispatched call: GraphQL or
   REST, decided by a `features.<area>` value.
6. Add a thin "extensions" sidecar (`src/github/extensions/`) for endpoints
   beyond GitHub's REST surface. Each extension module is opt-in via a
   `features.<area>: "host"` value and hard-fails if `api_host` is not set.
7. Validate config at startup: hard-fail when `api_host` is set and any
   feature still requests `"graphql"`, or when `api_host` is unset and any
   feature requests `"host"`.
8. Allow per-repo UI link customisation: a new external-host link with a
   configurable URL template and icon, plus the ability to suppress the
   built-in GitHub and Graphite links.

## Configuration Shape

```jsonc
{
  "repos": {
    "owner/repo": {
      // Existing keys (path, worktree_directory, ...) unchanged

      // NEW — when present, pair-review routes API traffic to this host
      "api_host": "https://althost.example/api/v3",

      // NEW — token resolution, parallel to existing top-level keys
      "token": "...",            // optional, literal token
      "token_command": "...",    // optional, shell command, stdout is token

      // NEW — optional regex for matching pasted URLs to this repo entry.
      // Use named capture groups for `owner`, `repo`, and `number`; the
      // matcher uses those groups as the canonical identifiers, replacing
      // the host-specific URL parsing path entirely for this repo.
      // Anchor with `^` so the pattern matches a whole URL, not a
      // substring.
      "url_pattern": "^https://althost\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>[0-9]+)",

      // NEW — UI link customisation. Each entry under "links" either
      // configures or suppresses a link in the review header.
      "links": {
        "external": {
          "label": "Open on AltHost",
          "url_template": "https://althost.example/{owner}/{repo}/pull/{number}",
          "icon": "<svg xmlns=\"http://www.w3.org/2000/svg\" ...>...</svg>"
        },
        "github": false,    // hide the default "Open on GitHub" link
        "graphite": false   // hide the Graphite stack link
      },

      // NEW — per-area dispatch mode. Omitted areas use the default for the
      // host kind: "graphql" when api_host is unset, "rest" when set.
      "features": {
        "pending_review_check": "rest",        // Q1, Q2
        "stack_walker": "rest",                // Q3-5
        "review_lifecycle": "rest",            // M2, M3, M4
        "pending_review_comments": "host"      // M1 — must be "host" when api_host is set
      }
      // Note: existing-comment dedup fetch is hardcoded to REST in
      // analyzer.js (no feature flag) — alt-hosts that expose
      // `/repos/{owner}/{repo}/pulls/{n}/comments` get dedup for free.
    }
  }
}
```

Allowed `features.<area>` values: `"graphql"`, `"rest"`, `"host"`.

**Defaulting rules:**

- `api_host` unset → all areas default to `"graphql"` where a GraphQL impl
  exists, `"rest"` otherwise. Existing behaviour preserved.
- `api_host` set → all areas default to `"rest"`. Users may upgrade
  individual areas to `"host"` if their host advertises the extension.

**Hard-fail rules** (applied in `validateRepoConfig()` at startup):

- `api_host` set + any area = `"graphql"` → fail. The alt-host has no
  GraphQL endpoint; silent fallback would mislead.
- `api_host` unset + any area = `"host"` → fail. Host extensions require a
  host.
- `pending_review_comments` ≠ `"host"` while `api_host` is set + the user
  invokes a workflow that creates a draft review with comments → fail at
  the workflow boundary (REST has no way to add comments to a *pending*
  review). This is a runtime check, not startup, because the workflow may
  never be invoked.

## Implementation Phases

### Phase 1 — Config foundation

- Add `resolveHostBinding(repository, config)` in `src/config.js`. Returns
  `{ apiHost, token, features, source }` where `source` describes how the
  token was resolved (for logging).
- Refactor `getGitHubToken()` to delegate to `resolveHostBinding()` when a
  repository is known. Preserve the no-repo-known fallback (used by
  setup/auth-test flows) — that path keeps the current top-level
  `github_token` / `github_token_command` / `GITHUB_TOKEN` priority.
- Add `validateRepoConfig(config)` invoked from `loadConfig()`. Hard-fails
  on the invariants above with a precise error message naming the
  offending repo and feature.
- Add `matchRepoByUrl(url, config)` that returns `{ repository, repoConfig }`
  by testing `repos[*].url_pattern` regexes. Falls back to the existing
  `parseGitHubUrl()` for `github.com` URLs.

**Files touched:** `src/config.js`, `tests/unit/config.test.js`.

### Phase 2 — URL resolution

- Update the CLI entry point that parses the PR argument
  (`bin/pair-review.js` or wherever `parseGitHubUrl()` is called) to first
  try `matchRepoByUrl()`. If matched, carry the resolved repo identifier
  forward into route handlers.
- Update PR-mode route construction (`src/routes/comments.js` and friends)
  so the repo identifier reaching `GitHubClient` is the canonical
  `owner/repo` key from config, regardless of how the URL was written.

**Files touched:** `bin/*`, `src/main.js`, `src/routes/comments.js`,
relevant tests.

### Phase 3 — GitHubClient refactor

- Add a constructor parameter `binding` (the object returned by
  `resolveHostBinding()`). Use `binding.apiHost` as Octokit's `baseUrl`,
  `binding.token` for auth. Keep the old single-token constructor as a
  thin wrapper for tests and any caller that has no repo context.
- Extract every GraphQL call into a method on a per-area dispatcher:

  ```
  src/github/operations/pending-review.js   // Q1, Q2
  src/github/operations/stack-walker.js     // Q3-5 (move existing module here)
  src/github/operations/review-lifecycle.js // M2, M3, M4
  ```

  Each module exports a single function whose first arg is the binding's
  `features` and which dispatches to a `graphql.js` or `rest.js`
  implementation in a sibling directory.

- `GitHubClient` becomes thin orchestration over these dispatchers.

**Files touched:** `src/github/client.js`, `src/github/stack-walker.js`
(move), new `src/github/operations/`, new `src/github/impl/{graphql,rest}/`.

### Phase 4 — REST replacements

For each GraphQL operation, write the REST equivalent against existing
Octokit methods. Each replacement must be observationally identical for
GitHub.com (same return shape, same error handling, same batching
behaviour).

| Op | REST equivalent | Notes |
|---|---|---|
| Q1 getPendingReviewForUser | `pulls.listReviews()` + filter `state: 'PENDING'` + `user.id === authenticatedUser.id` | Need user id; cache from `users.getAuthenticated()`. |
| Q2 getReviewById | `pulls.getReview({ review_id })` | Direct mapping. |
| Q3 FETCH_PR_QUERY | `pulls.get()` | Already used elsewhere in client.js. |
| Q4 FIND_PRS_BY_HEAD | `pulls.list({ head: 'owner:branch' })` | Octokit handles encoding. |
| Q5 FIND_PRS_BY_BASE | `pulls.list({ base: 'branch' })` | — |
| M2 addPullRequestReview | `pulls.createReview()` with no comments | Already in `pulls.createReview()` family. |
| M3 submitPullRequestReview | `pulls.submitReview()` | Direct mapping. |
| M4 deletePullRequestReview | `pulls.deletePendingReview()` | Direct mapping. |

For M1 (`addPullRequestReviewThread`), there is no GitHub REST
equivalent — Phase 5 must ship the host extension before alt-host launch.
When `features.pending_review_comments` is anything other than `"host"`
on an `api_host`-configured repo, the operation rejects with a clear
error: the only supported path is the host extension. A REST-only
fallback via per-comment `pulls.createReviewComment()` is **not** offered
— GitHub bug reports indicate it does not reliably attach to a pending
draft, and offering an unreliable path here would produce silent data
loss in user reviews.

**Files touched:** `src/github/impl/rest/*`, parity tests in
`tests/unit/github/impl/rest/*`.

### Phase 5 — Host-extension sidecar

- New directory: `src/github/impl/host/`.
- Each extension is one file with a known generic contract. The first one:

  ```
  src/github/impl/host/pending-review-comments.js
  ```

  Documented contract:

  > `POST {api_host}/repos/{owner}/{repo}/pulls/{n}/reviews/{review_id}/comments`
  > with a JSON body of `{ comments: [...] }` to append multiple inline
  > comments to a pending (draft) review in one call. Hosts that
  > advertise compatibility with this contract may be selected via
  > `features.pending_review_comments: "host"`.

- The actual endpoint path lives in config (`features.pending_review_comments_endpoint`)
  with the contract above as the default. Hosts that diverge can override.

- Authentication uses the same `binding.token`; transport uses Octokit's
  `request()` against the configured `baseUrl`.

**Files touched:** `src/github/impl/host/*`, tests.

### Phase 6 — Replace the `gh` CLI call

`src/ai/analyzer.js:243` shells out to `gh api repos/.../comments --paginate`.
The alt-host has no `gh` CLI. Replace the shell-out with an Octokit
`pulls.listReviewComments()` call routed through the same `GitHubClient`
the rest of the analyzer already uses. This is a strict improvement
regardless of alt-host work — removes an external dependency and a process
spawn.

**Hazard:** see `analyzer.js` notes in `CLAUDE.md` — three analysis code
paths exist (`analyzeAllLevels`, `runReviewerCentricCouncil`,
`runCouncilAnalysis`). Verify the comment-fetch is invoked from all three
and the replacement reaches all three.

**Files touched:** `src/ai/analyzer.js`, related tests.

### Phase 7 — UI: external-host link & link suppression

The review header today renders fixed links (an "Open on GitHub" anchor,
and a Graphite stack link when `enable_graphite` is set). For alt-host
repos these links are either wrong (GitHub link points at a non-existent
page) or irrelevant. Configurable per repo:

- **External link.** `repos["owner/repo"].links.external` declares a new
  link in the header. Shape: `{ label, url_template, icon? }`. The
  `url_template` accepts `{owner}`, `{repo}`, `{number}`, `{branch}`,
  `{base_branch}`, `{head_sha}` placeholders, substituted from the
  current review context. `icon` is an inline SVG string sanitised the
  same way the existing `share.icon` is in the user's config (see how
  `share.icon` is rendered today for the precedent).
- **Hide built-in links.** `links.github = false` suppresses the default
  GitHub link; `links.graphite = false` suppresses the Graphite link.
  When both are unset, current behaviour is preserved.
- Both PR mode and Local mode render the same header. The "external"
  link is rendered in Local mode only when the local review is
  associated with a `repos` entry that has the binding — otherwise it's
  omitted silently.

**Sanitisation hazard.** The `icon` value is user-supplied SVG. Render
through the same sanitisation path the existing `share.icon` uses (or
add one if `share.icon` is currently rendered without sanitisation —
that would be a pre-existing bug to fix). Do not interpolate the icon
string into HTML via `innerHTML` without sanitisation.

**Template hazard.** `url_template` is also user-supplied. Substitute
only the documented placeholders (whitelist), URL-encode the values, and
reject templates that don't resolve to an `https://` URL.

**Files touched:** `public/js/pr.js`, `public/js/local.js`,
`public/css/*`, a header component if one exists, related Vitest unit
tests and an E2E test that verifies the link renders with the correct
substituted URL and that built-in links are hidden when configured.

### Phase 8 — Documentation

- New `docs/alt-host.md` describing the configuration model in entirely
  generic terms. Example config uses `althost.example` as the placeholder.
- README adds a one-sentence pointer to `docs/alt-host.md` under the
  configuration section.
- No mention of any specific operator, internal product, or
  organisation.

### Phase 9 — Tests

- Unit tests for `resolveHostBinding()`, `matchRepoByUrl()`,
  `validateRepoConfig()`.
- Parity tests: every REST replacement is run against a mocked Octokit
  and asserted to return the same shape as the GraphQL equivalent against
  a mocked GraphQL endpoint, for a canonical set of inputs.
- A small fake alt-host server (Express, in-test) that implements the
  extension contract and is exercised by integration tests.
- E2E coverage: at minimum, smoke-test that a repo configured with
  `api_host` plus the right `features` map starts a review and posts a
  draft comment against the fake alt-host without touching github.com.

## Hazards

- **`getGitHubToken()` has many callers.** Repo-aware token resolution
  must not break callers that have no repo context (setup, auth-test,
  `users.getAuthenticated()` for token validation). Keep the no-repo
  fallback and audit every caller — at last count, the function is read
  from setup/, routes/, hooks/, and at least eight files via
  `GitHubClient`.

- **`GitHubClient` constructor is invoked from many places.** Adding a
  required `binding` argument must be done with a default-to-github
  fallback to avoid a flag day. All call sites must be updated to pass
  the resolved repository.

- **`src/ai/analyzer.js` has three independent analysis paths.** Per
  `CLAUDE.md`, `analyzeAllLevels`, `runReviewerCentricCouncil`, and
  `runCouncilAnalysis` each construct their own option/instruction
  objects. The `gh api` replacement (Phase 6) must reach all three; do
  not assume modifying `analyzeAllLevels` is sufficient.

- **Stack walker is consumed by features beyond the obvious caller.**
  `src/github/stack-walker.js` is used by the Graphite stack feature and
  the branch-review flow. Moving it under `src/github/operations/` must
  update both call sites; the parent/child-PR data shape must remain
  identical for both consumers.

- **`gh api repos/.../comments --paginate` is the only `gh` CLI call we
  have.** Removing it (Phase 6) is a small but cross-cutting change:
  CI/local environments that *relied* on `gh` for auth via `gh auth
  token` are unaffected (that path is in `github_token_command`, not in
  analyzer), but anyone debugging analyzer behaviour by reading shell
  output will lose that signal. Confirm logging is preserved through the
  Octokit path.

- **GraphQL → REST behavioural drift for stack-walker.** The GraphQL
  `pullRequests(orderBy: UPDATED_AT, first: 5)` query returns up to 5
  most-recent matches. The REST equivalent `pulls.list({ sort:
  'updated', direction: 'desc', per_page: 5 })` *should* be equivalent
  but uses different ordering semantics (REST sorts by `updated_at`
  desc; GraphQL `orderBy: UPDATED_AT` order direction is configurable).
  Verify ordering matches in the parity test before declaring done.

- **Pending-review comment attachment is fragile on GitHub REST.** The
  M1 fallback path (Phase 4 option 2 — `createReviewComment` against a
  pending review) is documented in places to *not* reliably attach to
  the draft. The REST-only path for alt-hosts MUST go through `"host"`;
  the github.com path should keep using GraphQL. Make `"rest"` mode for
  this single area either (a) emit a clear runtime error, or (b) verify
  attachment works against real github.com before shipping. Do not
  guess.

- **URL pattern matching has injection risk.** `url_pattern` is a
  user-supplied regex from config. Compile with `new RegExp(pattern)` —
  not a string-concat into another regex — and catch compilation errors
  at startup with a clear "invalid regex in repos[x].url_pattern"
  message. Document that the regex should be anchored (`^...`) to avoid
  matching inside arbitrary text.

- **Token caching across hosts.** The existing token cache in
  `getGitHubToken()` keys on nothing — it just caches "the token". With
  per-repo tokens, the cache key must become `(repository,
  command-or-source)`. Re-using a github.com token against an alt-host
  request (or vice versa) is a quiet bug waiting to happen.

- **Local mode parity.** `CLAUDE.md` requires Local + PR mode parity.
  Local mode does not make remote API calls today, so most of this
  plan does not apply. *However*, the URL-pattern matcher and config
  validation run at startup regardless of mode, so an invalid `repos`
  config will fail both. Verify the failure message is clear when the
  user is only doing local reviews.

- **Tests must not touch the network.** Per `CLAUDE.md`, all browser
  opens and external calls in tests must be gated. The fake alt-host
  server must bind to a loopback ephemeral port and the
  `PAIR_REVIEW_NO_OPEN` env must remain respected. The Octokit
  instance pointed at the fake server must not silently fall back to
  `api.github.com` if a path is missing — set a strict 404 policy on
  the fake server.

## Open Questions for Implementation Time

These are not blockers for the plan but will need answers before phases
4–5:

1. Does the alt-host accept the standard GitHub `Authorization: Bearer`
   header, or does it require a different scheme? Confirm before
   implementing Phase 3.

2. Will the alt-host's REST `pulls.list({ head, base })` filters match
   GitHub's exact semantics, particularly around fork-PR detection? The
   stack walker assumes head/base filters are sufficient.

3. What is the exact endpoint and payload shape the alt-host operator
   has chosen for the pending-review-comments extension? The plan
   documents a contract, but the operator's actual choice may differ —
   if so, the contract here is the one we expose to config and the
   adapter normalises.

4. Should `features.<area>` accept a `"host"` value that *also* needs an
   endpoint override, or is one alt-host's contract assumed to match the
   documented default? The plan currently allows per-feature endpoint
   overrides — confirm whether that flexibility is wanted or premature.

## Acceptance Criteria

- A repo configured with `api_host` + `features.*` set appropriately can
  start a PR review, fetch the PR and its files, run analysis, create a
  draft review, attach inline comments to it via the host extension, and
  submit it — all without touching `api.github.com` or invoking `gh`.
- All existing github.com behaviour is byte-identical (same return
  shapes, same error messages, same batching) — verified by the parity
  test suite.
- Startup fails loudly with an actionable message when config is
  inconsistent (graphql requested with `api_host`, host requested
  without `api_host`, invalid regex).
- For an alt-host repo with `links.external` set and `links.github =
  false`, the review header shows the configured external link (with
  its icon and substituted URL) and does not show the GitHub link. Same
  applies to Graphite when `links.graphite = false`. Default behaviour
  is unchanged for github.com repos with no `links` block.
- No string in the repository (source, comments, docs, fixtures) names a
  specific alt-host operator, product, or organisation.
