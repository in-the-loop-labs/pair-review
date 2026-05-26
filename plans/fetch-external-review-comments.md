# Fetch External Review Comments (Read-Only)

## Goal

Display review comments from external systems inline in pair-review's diff
view, alongside existing AI suggestions (orange) and user comments (purple).
External comments get a **blue** theme. Read-only — no reply, no resolve, no
adopt. Threading preserved.

First (and only) external source in this plan: **GitHub** PR inline review
comments (`/pulls/{n}/comments`). The schema, API, and UI are designed so
that adding GitLab, Linear, or other sources later is a per-source adapter,
not a redesign.

Primary value: the reviewer sees what other humans already said, and can use
the existing **chat-about** flow to discuss any external thread or individual
comment with the AI.

Out of scope:
- Replies, resolves, mark-as-outdated actions
- Issue-level (PR conversation tab) comments — only line-anchored inline
  review comments
- Dedup of comments that originated from this pair-review session (deferred)
- Local mode (no external source exists)
- Non-GitHub adapters (designed-for, not built)

---

## Design Decisions

### 1. Separate `external_comments` table

External comments do **not** share the existing `comments` table. Three
reasons:

- **Lifecycle mismatch.** AI suggestions go `active → adopted/dismissed`.
  User comments go `draft → submitted`. External comments are immutable
  mirrors synced via upsert. Same `status` column, three different
  meanings — junk drawer.
- **Identity differs.** External authors are remote users; internal
  comments are authored by the local reviewer. Different semantics.
- **Upsert constraint.** External rows need `UNIQUE(review_id, source,
  external_id)` for idempotent sync. That constraint doesn't belong on
  internal comments.

Tradeoff: two tables, two query paths. Frontend reconciles into one
rendering pass. Worth it.

### 2. `external_comments` schema

New table, new migration in [src/database.js](src/database.js):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | Local id |
| `review_id` | INTEGER FK | → `reviews(id)` |
| `source` | TEXT | `'github'` for now; future `'gitlab'`, `'linear'` |
| `external_id` | TEXT | The source system's comment id (TEXT — GitHub uses ints, others use strings) |
| `in_reply_to_id` | TEXT | Raw external `in_reply_to_id` value; resolved to local `parent_id` during sync |
| `parent_id` | INTEGER | FK → `external_comments(id)`; null for thread root |
| `external_url` | TEXT | Permalink to the comment in the source system |
| `author` | TEXT | Username on the source system |
| `author_url` | TEXT | Profile link (optional) |
| `file` | TEXT | Path |
| `side` | TEXT | `'LEFT'` / `'RIGHT'` |
| `line_start`, `line_end` | INTEGER | Current line anchor (null if outdated) |
| `diff_position` | INTEGER | Source-system diff position (null if outdated) |
| `commit_sha` | TEXT | Source `commit_id` (current) |
| `is_outdated` | INTEGER (0/1) | True when `position` was null on fetch |
| `original_line_start`, `original_line_end` | INTEGER | Anchor at the time the comment was created |
| `original_commit_sha` | TEXT | `original_commit_id` |
| `body` | TEXT | Comment markdown |
| `external_created_at` | TEXT | ISO timestamp when created in source system |
| `synced_at` | TEXT | ISO timestamp of last sync |

**Indexes:**
- `UNIQUE(review_id, source, external_id)` — primary upsert key
- `INDEX(review_id, file, line_end)` — fast lookup for diff-row rendering
- `INDEX(review_id, source, in_reply_to_id)` — parent resolution

Per CLAUDE.md SQLite migration safety rules: idempotent (`CREATE TABLE
IF NOT EXISTS`), wrapped in a transaction, with index names matching
production exactly so the test schemas in
[tests/e2e/global-setup.js](tests/e2e/global-setup.js) and
[tests/integration/routes.test.js](tests/integration/routes.test.js) stay
in lockstep.

### 3. Outdated handling

- GitHub returns `position: null` on outdated comments → set
  `is_outdated = 1`, leave `line_*` / `diff_position` null, populate
  `original_*` fields.
- Renderer falls back to `original_line_*` when `line_*` is null.
- Display: faded styling + "outdated" badge in the comment header,
  expanded by default.
- If both current and original positions are null (rare, force-push
  edge case): skip and increment a `lostAnchors` count in the sync
  response so the user knows some weren't shown.

### 4. GitHubClient method

Add `listReviewComments({ owner, repo, pull_number })` to
[src/github/client.js](src/github/client.js). Wrap
`octokit.pulls.listReviewComments` with `octokit.paginate()`. Reuse the
existing error / rate-limit handling at lines 213-219. Return raw API
objects — mapping to `external_comments` rows happens in the route layer
(keeps the client thin and testable).

### 5. Source adapter shape

A thin mapper per source. For now, just GitHub:

```
src/external/
  github-adapter.js     // maps GitHub API row → external_comments row
  index.js              // dispatches by source name
```

`github-adapter.js` exports `mapComment(apiRow) → row` and
`fetch({ client, owner, repo, pull_number }) → apiRow[]`. New sources
land as sibling files implementing the same interface — no changes to
routes or storage.

### 6. Sync endpoint and trigger

**Endpoint:** `POST /api/reviews/:reviewId/external-comments/sync?source=github`

- Resolves the review's PR coords from DB.
- Dispatches to the adapter for `source`.
- Two-pass insert inside a transaction:
  1. Upsert all rows with `parent_id = NULL`, keyed on
     `(review_id, source, external_id)`.
  2. Resolve `parent_id` for any row with `in_reply_to_id != NULL` by
     looking up the local id of the parent (same review, same source,
     matching `external_id`).
- Returns `{ count, lostAnchors, syncedAt }`.

**Trigger:**
- Auto-fire on PR page load, non-blocking. Failure → small toast, page
  still renders.
- Manual "refresh external comments" button in the page header.

### 7. Fetch and storage repo

Add `ExternalCommentRepository` in [src/database.js](src/database.js):
- `upsert(row)` — handles the UNIQUE constraint
- `resolveParents(reviewId, source)` — second-pass parent resolution
- `listByReview(reviewId, { source? })` — returns rows ordered for
  rendering
- `listThreadsByReview(reviewId, { source? })` — groups by root
  (`parent_id IS NULL`) with replies attached

**The existing `comments` table is untouched.** `getUserComments` stays
as-is. No rename, no shared-function ripple.

### 8. Frontend fetch and render

**Endpoint:** `GET /api/reviews/:reviewId/external-comments?source=github`
returns the thread-grouped shape:

```
[
  { id, source: 'github', ...rootFields,
    replies: [{ id, ...replyFields }, ...] },
  ...
]
```

**Module:** new `public/js/modules/external-comment-manager.js`. Mirrors
the row-insertion logic in
[public/js/modules/comment-manager.js](public/js/modules/comment-manager.js)
but read-only — no draft/submit/edit/dismiss code paths.

- Inserts `.external-comment-row` rows after the appropriate diff line.
- Each row is a thread: root comment + indented replies in a single
  card. One level of indent; no infinite nesting (GitHub itself treats
  threads as flat-with-replies).
- Per-comment chat-about button on every comment.
- Per-thread chat-about button on the thread root.

### 9. Theming

Per-source CSS variables so future systems get their own colors without
class renames. In [public/css/pr.css](public/css/pr.css):

**Light:**
```css
--external-github-primary: #0969da;       /* GitHub brand blue */
--external-github-subtle:  rgba(9, 105, 218, 0.08);
--external-github-border:  rgba(9, 105, 218, 0.3);
```

**Dark:**
```css
--external-github-primary: #58a6ff;
--external-github-subtle:  rgba(88, 166, 255, 0.1);
--external-github-border:  rgba(88, 166, 255, 0.3);
```

Classes:
- `.external-comment-row` / `.external-comment-cell` / `.external-comment`
  — structural, source-agnostic
- `.external-comment.source-github` — pulls the GitHub variables
- `.external-comment.is-outdated` — muted variant
- `.external-comment.is-reply` — indent + lighter background

Future GitLab support = add `.source-gitlab` rule + three new variables.

### 10. Chat-about wiring

The chat panel currently accepts `suggestionContext`, `commentContext`,
`fileContext` ([public/js/components/ChatPanel.js:527-602](public/js/components/ChatPanel.js)).
Extend `commentContext` and add `threadContext`:

```js
// Per-comment
window.chatPanel.open({
  commentContext: {
    commentId: localDbId,         // external_comments.id
    body, file, line_start, line_end,
    parentId,
    source: 'external',            // distinguishes from internal user comments
    externalSource: 'github',      // drives theming + label
    author, externalUrl, isOutdated,
  },
});

// Per-thread (root + replies)
window.chatPanel.open({
  threadContext: {
    rootId, source: 'external', externalSource: 'github',
    comments: [{ author, body, isOutdated, ... }, ...],
    file, line_start, line_end,
  },
});
```

`ChatPanel._openInner` learns the `threadContext` branch and
`_sendCommentContextMessage` / a new `_sendThreadContextMessage` render
a blue-themed context card. Card style is driven by `externalSource` so
new sources get the right color automatically.

### 11. Local mode

External comments are PR-mode only. [src/routes/local.js](src/routes/local.js)
and [public/js/local.js](public/js/local.js) are untouched. Verify no
`.external-comment-row` elements render on `/local/:reviewId` paths.

---

## Implementation Steps

1. **DB migration** — create `external_comments` table + indexes,
   idempotent and transactional. Update both test schemas.

2. **GitHubClient method** — `listReviewComments` with pagination, unit
   tests including rate-limit and 404 paths.

3. **Adapter scaffolding** — `src/external/github-adapter.js` and
   `src/external/index.js` (dispatch by source name).

4. **Repository** — `ExternalCommentRepository` with upsert, parent
   resolution, list-by-review, list-threads. Integration tests for
   each.

5. **Sync route** — `POST /api/reviews/:reviewId/external-comments/sync`.
   Integration tests: fresh sync, re-sync idempotency, outdated handling,
   threaded comments with out-of-order arrival, lost-anchor counting,
   GitHub API error path, concurrent-sync guard.

6. **Fetch route** — `GET /api/reviews/:reviewId/external-comments`
   returning thread-grouped shape.

7. **Frontend module** — `external-comment-manager.js`. Render rows,
   thread grouping, per-source class application, chat-about handlers.

8. **CSS** — per-source variables (light + dark), structural classes,
   outdated + reply variants.

9. **ChatPanel integration** — `commentContext` learns `source:
   'external'` + `externalSource`; new `threadContext` branch; blue
   context card styling.

10. **PR page wiring** — auto-fire sync on load, refresh button, error
    toast.

11. **E2E test** — mock GitHub API, load PR, assert: blue-themed rows
    render at the right lines, thread structure correct, outdated
    badge appears where expected, chat-about opens with the right
    payload, refresh button re-syncs.

12. **Changeset** — `.changeset/*.md` with `minor` bump.

13. **README** — feature blurb under Features describing external
    review-comment display, current source list (GitHub), and the
    read-only scope.

---

## Hazards

- **Shared rendering surface.** Three independent renderers append rows
  after the same diff lines:
  `.ai-suggestion-row`, `.user-comment-row`, `.external-comment-row`.
  Decide ordering up front (suggest: AI → user → external, then by
  `created_at` within group) and ensure each renderer only touches its
  own row class on re-render. Cross-check
  [public/js/modules/comment-manager.js:535-633](public/js/modules/comment-manager.js)
  and the suggestion-manager append logic before wiring the new module.

- **Parent resolution requires two passes.** GitHub returns comments in
  API order, not parent-before-child. Sync inserts all rows with
  `parent_id = NULL` then resolves in a second pass. Wrap both in one
  transaction — partial state would orphan replies. Pre-flight check:
  `DROP TABLE IF EXISTS` on any temp tables used in the migration to
  stay idempotent per CLAUDE.md SQLite rules.

- **Concurrent sync.** Page-load sync + manual refresh can race. Row-
  level upsert via `UNIQUE(review_id, source, external_id)` is safe,
  but two interleaving parent-resolution passes could briefly leave a
  reply unparented. Guard with a per-`(review_id, source)` in-flight
  flag in the route; second caller waits or returns "already syncing".

- **Lost anchors.** When both `position` and `original_position` are
  null (force-push edge case), the comment has no place to render.
  Count and surface in the sync response. Do NOT silently drop —
  reviewer should know.

- **Author identity collision.** A user who replied to a GitHub thread
  via the web UI will appear in the external feed under their GitHub
  username, even if it's "them". Dedup of pair-review-originated
  comments is deferred — when that lands, this is where it'll hook in.
  Document the dedup gap in the README.

- **Test schemas must mirror production.** Per CLAUDE.md, update
  [tests/e2e/global-setup.js](tests/e2e/global-setup.js) and
  [tests/integration/routes.test.js](tests/integration/routes.test.js)
  with the new table AND its indexes. Index names must match exactly.

- **Browser-tab discipline.** Per CLAUDE.md, no new code path may call
  the `open` npm package outside the existing
  `PAIR_REVIEW_NO_OPEN`-gated paths. External-comment permalinks are
  plain `<a target="_blank">` — browser-handled, no Node involvement.
  E2E test runs must include `PAIR_REVIEW_NO_OPEN=1`.

- **No hot-reload.** Per CLAUDE.md, config is loaded once at startup —
  do not add cleanup logic for config reapply scenarios.

- **Three analyzer code paths.** This plan does not touch the analyzer,
  so the `analyzeAllLevels` / `runReviewerCentricCouncil` /
  `runCouncilAnalysis` parity rule is N/A. Worth noting in case a
  follow-up wants to feed external comments into AI analysis as
  context — that change would have to land in all three paths.

- **ESM-only dependencies.** No new deps proposed. If one becomes
  necessary (e.g., a richer markdown renderer for external bodies),
  check for `"type": "module"` in its package.json per the CLAUDE.md
  ESM rule and use the lazy-`import()` pattern from
  [src/chat/acp-bridge.js](src/chat/acp-bridge.js).
