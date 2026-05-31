# Plan: Filter Team Review Requests by a Specific Team

## Goal
Let the user narrow the **Team Review Requests** tab to a single team they care
about, instead of always seeing the union of every team they belong to.

The default stays unchanged ("all my teams" — the current behavior). When the
user enters a team in `org/team` form, the tab re-queries GitHub for just that
team's open review requests.

## Key Insight (why this is small)
GitHub's search API supports a `team-review-requested:ORG/TEAM` qualifier that
runs over the **same search scope the tab already uses**. Filtering by a named
team requires **no new token scope** — only *enumerating* a user's teams would
need `read:org`. By having the user type the team name, we skip team
enumeration entirely:

- No `/user/teams` call, no `read:org`, no scope-degradation logic.
- Works with whatever token the user already has configured.
- The empty result for a typo'd or non-member team degrades gracefully on its
  own (just shows the empty state).

The current tab query is:
```
is:pr is:open archived:false review-requested:${login} -user-review-requested:${login}
```
The filtered query becomes:
```
is:pr is:open archived:false team-review-requested:${team}
```

### Design decision (settled)
When a specific team is selected we **drop** the `-user-review-requested:<you>`
exclusion. Once the user explicitly picks a team, "show everything awaiting this
team" is the least surprising behavior, even if they're also named individually.
The exclusion only applies to the default all-teams view.

## Scope Notes
- **Home-page feature only** — not tied to a review session, so the
  Local-mode/PR-mode parity requirement does **not** apply here.
- **No DB migration** — we reuse the existing `github_pr_cache` table and
  namespace the `collection` column value (see Caching below).
- Auto-populated team dropdown (the `read:org` path) is explicitly **out of
  scope** for this change; it can be layered on later as an optional
  enhancement that pre-fills suggestions.

## Implementation

### 1. Backend — `src/routes/github-collections.js`
- Generalize the collection definition from `buildQuery(login)` to
  `buildQuery(login, params)`. Only `team-reviews` uses `params`; the other two
  ignore it (keep their existing single-arg arrow, or accept and ignore the 2nd
  arg).
- `team-reviews` `buildQuery(login, { team })`:
  - If `team` is a valid `org/team` string → `is:pr is:open archived:false team-review-requested:${team}`
  - Else → current default query (`review-requested:${login} -user-review-requested:${login}`).
- **Validate `team` server-side** before interpolating into the query. Accept
  only `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`. On invalid non-empty input, return
  `400` with a clear message rather than silently falling back (a silent
  fallback to all-teams would mislead the user into thinking the filter
  applied). Empty/absent `team` is valid and means "all teams".
- Read the param from `req.query.team` on the GET route and from
  `req.query.team` (or body) on the POST `/refresh` route. Apply the same
  validation in both.
- **Caching:** namespace the cache key so a filtered view never clobbers the
  all-teams cache. Use the bare `team-reviews` collection key for all-teams, and
  `team-reviews:<org>/<team>` for a filtered view. Both the
  `DELETE ... WHERE collection = ?` in refresh and the
  `SELECT ... WHERE collection = ?` in GET already key on this single value, so
  namespacing requires no schema or index change (unique index is
  `(collection, owner, repo, number)`).
  - Derive the storage key in one helper, e.g.
    `cacheKey(name, team) => team ? name + ':' + team : name`, and use it in
    both GET and POST handlers so they never diverge.

### 2. Frontend — `public/index.html`
- Add a small text input + clear/apply affordance inside the existing
  `#team-reviews-tab` `.tab-pane-header` (next to `#team-reviews-fetched-at`
  and `#refresh-team-reviews`). Placeholder: `org/team`. Include an inline
  validation hint element (hidden by default).

### 3. Frontend — `public/js/index.js`
- Persist the entered team in `localStorage` (key e.g.
  `github-collection-team:team-reviews`); restore it on load.
- Thread the team value through `loadCollectionPrs` / `refreshCollectionPrs`:
  append `?team=<encoded>` to both the GET and POST `/refresh` fetch URLs when a
  team is set. (These two functions currently take
  `(collection, containerId, state)` — add an optional `team` arg, or read it
  from a small accessor so the tab-activation and refresh-button call sites stay
  simple.)
- Apply the same client-side format validation as the server before firing the
  request; show the inline hint and skip the fetch on invalid input.
- Wire an input/apply handler (debounced or on Enter / on blur / on a small
  "Filter" button) that re-runs `refreshCollectionPrs('team-reviews', ...)`.
- Update the `fetched-at` localStorage key handling so the timestamp reflects
  the active view. Simplest: keep the existing single key; acceptable since the
  label is informational. (Note this in code if we don't per-team it.)

## Hazards
- **`refreshCollectionPrs` / `loadCollectionPrs` are shared by all three
  collections.** Call sites:
  - Tab activation block (`public/js/index.js` ~1889–1906) — one per collection.
  - Refresh-button delegation (`~1792–1809`) — `#refresh-review-requests`,
    `#refresh-team-reviews`, `#refresh-my-prs`.
  Any signature change (adding a `team` arg) must be applied/validated at
  **all** these call sites, and must remain a no-op for `review-requests` and
  `my-prs`.
- **`buildQuery` shape change** ripples to the integration tests, which assert
  the exact query string passed to `searchPullRequests`
  (`tests/integration/github-collections.test.js` ~203, ~427, and the
  team-reviews block ~563+). Update those expectations and add new cases.
- **Cache-key namespacing touches two handlers that must agree.** GET reads
  `WHERE collection = ?` and POST refresh writes/deletes `WHERE collection = ?`.
  If one uses the namespaced key and the other doesn't, the GET will read stale
  or empty data. Route both through the single `cacheKey` helper.
- **Cache growth:** every distinct team string the user tries creates its own
  cached rows that are never garbage-collected. Likely negligible (home-page,
  local SQLite), but worth a one-line comment. If we want to avoid it, an
  alternative is to **not persist** filtered views (fetch live, cache only the
  all-teams view) — simpler storage story, loses offline cache for filtered
  views. Decide before implementing; default recommendation: namespace + accept
  the small growth.
- **Query injection via the team field.** The value is interpolated into the
  GitHub search query string. Validation (`^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`)
  must happen **server-side** (client validation is UX only). Without it a user
  could inject extra qualifiers or break the query.
- **`SelectionMode` for `team-reviews`** (`teamReviewsSelection`, keyed
  `team-reviews` in `collectionSelections`) calls `sel.exit()` inside
  `renderCollectionTable`. Re-rendering after a filter change must continue to
  exit selection mode cleanly — verify a filter change while in selection mode
  doesn't leave a stale action bar. The existing render path already calls
  `exit()`, so this should hold, but test it.

## Tests
- **Integration** (`tests/integration/github-collections.test.js`):
  - Default (no `team`) team-reviews refresh still issues the existing query
    (regression).
  - `?team=org/team` issues `team-review-requested:org/team` and **omits** the
    `-user-review-requested` exclusion.
  - Invalid `team` (e.g. `foo`, `a/b/c`, `org/team;extra`) → `400`, no GitHub
    call.
  - Filtered refresh caches under the namespaced key and GET with the same
    `?team=` returns those rows without clobbering the all-teams cache.
- **Frontend / E2E:** since this modifies `public/js/index.js` and
  `public/index.html`, run E2E via a Task tool per project policy. Add/extend a
  case that enters a team, verifies the request carries `?team=`, and that
  invalid input shows the hint and fires no request.

## Follow-ups / Docs
- **Changeset:** `minor` (new user-facing capability on an existing tab).
- **README:** the home-page tabs aren't currently documented in `README.md`
  (grep found nothing), so likely no README change needed — verify at
  implementation time.
- **Optional future enhancement:** when a `read:org`-scoped token is present,
  add a `GET /api/github/teams` endpoint (`octokit.rest.teams.listForAuthenticatedUser`)
  to offer autocomplete/suggestions for the team field. Not required for this
  change.
