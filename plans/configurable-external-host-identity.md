# Configurable External Host Identity (name, URL, icon) for Alt-Host Reviews

> On implementation, rename this file to `plans/configurable-external-host-identity.md` (repo convention: plan filenames match the functionality).

## Context

On alt-host repos, after submitting a draft review pair-review opens a browser tab to the URL the API returned (`result.github_url`). The alt-host (gitstream / "Meteorite") returns the **review** object's `html_url` as a `github.com/.../issues/<n>` URL — wrong host, wrong page (verified in the DB: the review URL is github.com `/issues/`, while the PR's own `html_url` is the correct `https://staging-2.gitstream.shopify.io/.../pull/2000121`).

An interim fix already in the working tree (`ReviewModal.resolveDraftPrUrl` + tests + changeset `draft-submit-open-alt-host-url.md`) makes the auto-open prefer `pr.html_url`. But `pr.html_url` is itself an API response value and not guaranteed correct for the host. The robust, config-driven approach is to **build the URL from the per-repo `links.external.url_template`** that already exists, and to surface a configurable host **name** ("Meteorite") and **icon** so user-facing text and buttons stop hardcoding "GitHub".

Most machinery already exists: `repos[...].links.external = { label, url_template, icon }`, the `substituteUrlTemplate()` helper on both backend (`src/links/repo-links.js`) and frontend (`public/js/repo-links.js`), server-side SVG sanitisation, and a header-button renderer. The gaps are: (1) a new `name` field, and (2) a **reachable accessor** so any code can read the host name / built URL / icon for the current review — today `fetchAndApplyRepoLinks` applies links to the DOM and discards them.

## Config shape (Option A — extend the existing `links.external`)

```jsonc
"repos": {
  "shop/world-gitstream-perf": {
    "api_host": "...", "token": "...",
    "links": {
      "external": {
        "name": "Meteorite",                 // NEW — host display name for prose
        "label": "Open in Meteorite",        // existing — header button caption
        "url_template": "https://staging-2.gitstream.shopify.io/{owner}/{repo}/pull/{number}",
        "icon": "<svg ...>...</svg>"          // existing — sanitised SVG
      }
    }
  }
}
```

Defaults preserve today's behaviour: no `name` → `"GitHub"`; no `links.external` → existing GitHub/Graphite header links and "GitHub" text unchanged.

## Backend changes

1. **`src/config.js`** `validateRepoConfig` (`links.external` block, ~L935–955): accept optional `name` — if present, must be a non-empty string (mirror the existing `label` check); else fail startup.
2. **`src/links/repo-links.js`** `resolveRepoLinks()`: add `name` to the returned `external` object. Add + export `resolveHostName(config, repository)` → `external.name || 'GitHub'` (reuses the already-imported `getRepoConfig`).
3. **`src/routes/config.js`** `/api/repos/:owner/:repo/links`: no change beyond the resolver — it already returns `links`, now carrying `name`.
4. **`src/routes/pr.js`** submit-review success `message` (L1743): interpolate `resolveHostName(...)` instead of literal "GitHub". (Lower priority — the frontend renders its own toast. Leave auth/token/log strings as "GitHub"; they refer to credential config, out of scope.)

## Frontend changes

5. **`public/js/repo-links.js`** — the central accessor gap. After `fetchAndApplyRepoLinks` resolves, store the resolved `links` + `context` at module scope and expose on `window.RepoLinks`:
   - `hostName()` → `_links?.external?.name || 'GitHub'`
   - `externalUrl()` → `substituteUrlTemplate(_links.external.url_template, _context)` or `null`
   - `externalIcon()` → `_links?.external?.icon || null`

   Store the `links` object (not just the substituted URL) so `hostName()`/`externalIcon()` work even when URL substitution fails (e.g. local mode without `{number}`).
6. **`public/js/components/ReviewModal.js`**:
   - `resolveDraftPrUrl(pr, result)`: change precedence to `RepoLinks.externalUrl()` → `pr.html_url` → `result.github_url` → `null`. Never fabricate `github.com`. Update the existing unit tests.
   - Replace literal "GitHub" in user-facing strings (L67, L123, L534, L544) with `RepoLinks.hostName()`. Static template strings (L67, L123) refresh when the modal opens / `updatePendingDraftNotice` runs; dynamic strings (success toast L534, link text L544) read at submit time.
   - Submit button `#submit-review-btn-modal` (L153 + `setSubmittingState` L435–452): when `RepoLinks.externalIcon()` is set, prepend the SVG (via `RepoLinks.parseSvgIcon`, never `innerHTML`); re-apply inside `setSubmittingState` since it rewrites innerHTML.
7. **`public/js/pr.js`**: pending-draft indicator strings (L2995 "…on GitHub", L3004 "Draft on GitHub") → `RepoLinks.hostName()`; indicator `href` (L2992) → `RepoLinks.externalUrl()` with the existing value as fallback.
8. **`public/js/components/Toast.js`** (L45): keep the `'View on GitHub'` default; ReviewModal passes `linkText: 'View on ' + RepoLinks.hostName()` so the default only applies when a caller omits it.

## Hazards

- **Two copies of `substituteUrlTemplate` / `ALLOWED_PLACEHOLDERS`** (backend + frontend) kept in sync by contract. `name` doesn't touch substitution — no sync risk; do not alter placeholders.
- **`resolveRepoLinks` consumers**: only `/api/repos/:owner/:repo/links` + tests. Adding `name` is additive; the header renderer ignores unknown fields.
- **Async timing**: `fetchAndApplyRepoLinks` is async; the modal's static labels may render before it resolves. Reading `hostName()` at submit/open time is safe; build-time labels must be refreshed on modal open (they already re-run via `updatePendingDraftNotice`). Watch for a "GitHub"→"Meteorite" flicker.
- **Both modes**: `pr.js:2465` (PR) and `local.js:1081` (Local) both call `fetchAndApplyRepoLinks`, so the accessor populates in both. Local omits `{number}` → `externalUrl()` is null there (expected; no PR/draft submit). `hostName()`/`externalIcon()` still work.
- **Interim work to fold in**: the working tree already has `resolveDraftPrUrl` + 4 tests + changeset `draft-submit-open-alt-host-url.md`. This plan supersedes it — update the helper, expand the tests, and replace/rename the changeset to cover the full feature.
- **Icon = user-supplied SVG** — must route through `parseSvgIcon` (DOMParser + attribute stripping), never `innerHTML`. `setSubmittingState` rebuilds the button innerHTML, so icon insertion must be idempotent and re-applied there.

## Tests

- **Unit** (`pnpm exec vitest run`):
  - `src/links/repo-links.js`: `resolveRepoLinks` returns `name`; `resolveHostName` falls back to "GitHub"; validation rejects a non-string `name`.
  - `public/js/repo-links.js`: `hostName()` / `externalUrl()` / `externalIcon()` incl. defaults when no links fetched.
  - `ReviewModal.resolveDraftPrUrl`: new precedence (template > pr.html_url > github_url > null).
- **E2E** (`pnpm exec playwright test tests/e2e/review-submission*.spec.js`): keep green **under Node 24** (`export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"` — better-sqlite3 binary is ABI 137; do NOT rebuild). Optionally add a spec with a configured `links.external` asserting the host-named toast + submit-button icon.

## Docs & changeset

- `docs/alt-host.md`: document `links.external.name`; note that `name`/`url_template`/`icon` now also drive the draft auto-open URL, the submit/pending-draft text, the success toast, and the submit-button icon.
- README: update only if it documents the submit UI / host naming.
- Changeset: `minor`. Replace the interim `draft-submit-open-alt-host-url.md` with one covering the full feature.

## Verification (end-to-end)

1. Add `links.external` with `name: "Meteorite"`, a `url_template`, and an `icon` to an alt-host repo in `~/.pair-review/config.json`.
2. Start pair-review on an alt-host PR; confirm the header external link + submit-button icon render and modal text reads "…on Meteorite".
3. Submit a draft; confirm the auto-opened tab is the substituted `url_template` URL (correct host, `/pull/`), the success toast says "View on Meteorite", and the pending-draft indicator says "Draft on Meteorite" linking to the same URL.
4. On a normal github.com repo (no `links.external`): everything still says "GitHub" and links to github.com — no regression.
