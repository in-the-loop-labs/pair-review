# Review Panel: External Segment + Overflow Scroll

## Goal

Add a fourth segment, **External**, to the Review panel segment switcher so
the bar reads **AI | User | External | All**. The External segment lists one
entry per external (GitHub PR) comment thread; clicking an entry scrolls to
that thread inline, mirroring the existing AI/User behavior. Inline rows are
unaffected by which segment is selected — segments only switch the navigation
list.

Also: when the segment buttons don't all fit in the panel width, show `<` /
`>` chevrons on the left/right to scroll the segment row horizontally.

The External segment is **hidden in Local mode** (no external source exists
there, and the segment would always be empty).

## Decisions (confirmed with user)

- **One entry per thread**, anchored on the root. Reply count shown as a
  badge. Inline view already has per-comment granularity.
- **Segment selection does not hide inline rows.** Today AI/User segments
  don't hide anything in the diff — only the panel's nav list changes. New
  segment follows the same rule.
- **Blue theming.** External list items pick up the same `--ec-*` CSS
  variables used by inline external comments, with `.source-github` driving
  per-source colors.
- **Local mode**: hide the External segment button entirely.

---

## File Map (from exploration)

| Concern | File | Anchor |
|---|---|---|
| Panel component | `public/js/components/AIPanel.js` | `selectedSegment` 38, `getFilteredItems` 611, `renderFindings` 666, `onFindingClick` 932, `scrollToComment` 1061 |
| Segment HTML | `public/pr.html` | 1283-1288 |
| External manager (data source) | `public/js/modules/external-comment-manager.js` | `threadsBySource` 33, `loadAndRender` 85, `_buildThreadRow` 425 |
| Theming variables | `public/css/pr.css` | `:root --external-github-*` 709-724, dark overrides 815-824, `.external-comment.source-github` 4740 |
| Segment E2E patterns | `tests/e2e/ai-analysis.spec.js` | 304-416 |
| External E2E | `tests/e2e/external-comments.spec.js` | n/a (extend) |

---

## Implementation

### 1. HTML — segment button + scroll chevrons

[public/pr.html:1283-1288](public/pr.html:1283)

- Wrap the existing segment row in a container that allows horizontal overflow
  scrolling (`overflow-x: auto; scroll-behavior: smooth;`).
- Insert chevrons (`<button class="segment-scroll segment-scroll--left">`
  and `--right`) flanking the scrollable area. Default to hidden; reveal via
  JS when `scrollWidth > clientWidth`.
- Insert new `<button class="segment-btn" data-segment="external"
  data-target-type="external">External <span class="segment-count">0</span></button>`
  between `comments` and `all`.
- In Local mode the button is rendered with `[hidden]` (or omitted) via a
  body-class gate — see step 7.

### 2. AIPanel state + filtering

[public/js/components/AIPanel.js](public/js/components/AIPanel.js)

- Add `this.externalThreads = []` to the constructor (alongside `findings`,
  `comments`).
- New `setExternalThreads(threads)` method mirrors `setComments()`:
  - Replace state.
  - Recompute filtered list.
  - Re-render the visible list (`renderFindings()` is the entry point —
    rename internal helpers if needed, but keep public method name stable to
    avoid breaking callers).
  - Update the `External` count badge.
- Extend `getFilteredItems()`:
  - `'external'` branch returns `this.externalThreads.map(thread => ({
    ...thread, _itemType: 'external' }))`.
  - `'all'` branch concatenates external threads alongside findings + comments.
- Sort: `sortItemsByFileOrder()` currently keys on `file` / `line` /
  `line_start`. Verify external threads carry these on the root (they do —
  see `_buildThreadRow` line resolution). Add a defensive `?? 0` fallback in
  the comparator to keep it safe for any item missing keys.

### 3. List item rendering

- New `renderExternalThreadItem(thread)` modeled on `renderCommentItem()`.
- DOM:
  - `.ai-panel__list-item .ai-panel__list-item--external.source-${thread.source}`
  - Author (root.author), short body snippet (first 80 chars of root.body,
    plain text — strip markdown), `file:line` tag, reply count badge if
    `thread.replies.length > 0`, `is-outdated` class when root is outdated.
- `data-item-type="external"`, `data-thread-id=root.id`,
  `data-source=root.source`, `data-file`, `data-line` for the scroll handler.

### 4. Click → scroll-to-inline

[onFindingClick](public/js/components/AIPanel.js:932)

- Add `'external'` branch calling `scrollToExternalThread(threadId, source,
  file, line)`.
- New `scrollToExternalThread()` mirrors `scrollToComment()`:
  1. Expand the file's collapse state if needed.
  2. Find `.external-comment-row[data-thread-id="..."][data-source="..."]`.
     **Hazard:** confirm `_buildThreadRow` writes those data attributes — if
     not, add them (low-touch).
  3. `scrollIntoView({ behavior: 'smooth', block: 'center' })`.
  4. Add a transient `.external-comment-row--focused` class (2s timeout) for
     the visual flash. Style with `--ec-primary` outline.

### 5. External manager → panel handoff

[external-comment-manager.js](public/js/modules/external-comment-manager.js)

- After `loadAndRender()` finishes (success path) and after a manual refresh,
  call `window.aiPanel?.setExternalThreads(allThreadsFlattened)`.
  Flatten `threadsBySource` into a single array — the panel doesn't care
  about source grouping in the list.
- On manager init, if `window.aiPanel` is ready, push current threads
  immediately so a late-instantiated panel still receives them.

### 6. CSS — theming for the list items

[public/css/pr.css](public/css/pr.css)

- New section near the existing list-item rules:
  - `.ai-panel__list-item--external` — uses `--ec-*` for border-left, hover
    background, and reply-count badge tint.
  - `.ai-panel__list-item--external.source-github` — maps `--ec-primary` etc.
    to `--external-github-*`, matching the inline indirection pattern at line
    4740.
  - `.ai-panel__list-item--external.is-outdated` — faded + dashed border,
    matching inline `.external-comment.is-outdated`.
- Dark-mode overrides under `[data-theme="dark"]` mirroring the existing
  inline pattern at lines 815-824 / 4920-4934.

### 7. Local-mode gating

- `pr.js` (PR mode) renders normally; `local.js` runs in Local mode.
- Add a body-level marker the CSS / panel JS can key off:
  - In Local mode, when AIPanel initializes, hide the External segment
    button: `this.elements.segmentExternal?.setAttribute('hidden', '')`.
  - Drop the external segment from the `all` filter when running in Local
    mode (it'll be empty anyway, but keep it tidy).
- The simplest signal is `typeof window.localManager !== 'undefined'` (or
  whatever the existing Local-mode init module exposes — verify on read pass).

### 8. Segment overflow scroll buttons

- New module or section inside AIPanel: `setupSegmentOverflow()`.
- On panel init and on `ResizeObserver` (observe the segment-row container):
  - If `scrollWidth > clientWidth + 1`, show both chevrons (`.hidden` toggled
    based on `scrollLeft` to suppress the relevant one at each end).
  - Otherwise hide both.
- Click handlers on chevrons scroll the container by `~150px` (one segment
  width).
- On `scroll` event update chevron visibility (`scrollLeft === 0` hides
  left; `scrollLeft + clientWidth >= scrollWidth` hides right).
- CSS: chevrons sit `position: absolute` over the row edges with a small
  gradient mask so segments fading under them read cleanly.

### 9. Tests

- **Unit** (`tests/unit/`):
  - Extend or add a sibling to `ai-panel-collapse.test.js`:
    - `setExternalThreads()` stores state, updates filtered list when
      `selectedSegment === 'external'`.
    - `getFilteredItems()` returns external threads when segment is `'external'`,
      and includes them in `'all'`.
  - New: a small unit test for `sortItemsByFileOrder()` with mixed item types.
- **E2E** (`tests/e2e/external-comments.spec.js`):
  - Add a `describe('External segment in Review panel')` block:
    - With external threads mocked, panel shows an `External` segment with
      correct count.
    - Clicking the segment switches active state to External.
    - List shows one item per thread; each item has the blue source-github
      accent.
    - Clicking an item scrolls to and highlights the inline external row.
- **E2E** (Local mode):
  - In a Local-mode test (use the existing local mode harness if present),
    assert the External segment button is not visible.
- **E2E** (overflow scroll):
  - Resize viewport to a narrow width and assert chevrons appear; click
    right chevron and assert `scrollLeft` increases.

---

## Hazards

- **`getFilteredItems()` has multiple consumers**: count badges, "no items"
  empty-state copy, keyboard-navigation helpers (if any), All-segment
  aggregator. Trace every call and confirm each handles `external` items
  before declaring done.
- **Async external arrival**: panel may render before external sync finishes.
  `setExternalThreads()` must re-render without disturbing the currently
  focused segment or scroll position of the list.
- **`sortItemsByFileOrder()`**: assumes file/line keys; external thread roots
  carry these on the root comment. For outdated threads the live coordinates
  may be null — fall back to `original_line` to keep ordering stable. Add a
  `?? 0` guard so a missing key never crashes the comparator.
- **`comment-minimizer.js`**: it toggles inline rows. Confirm it ignores
  `.external-comment-row` so the External panel filter has no inline side
  effect (user explicitly does not want segment selection to hide rows).
- **localStorage `reviewPanelSegment_${PRKey}`**: legacy values like `'all'`
  must still be honored; an unknown stored value should fall back to `'ai'`.
- **Two render entry points**: external rows are created in
  `_buildThreadRow`; if a refresh happens, the row DOM is rebuilt and
  `.external-comment-row--focused` classes are lost. Acceptable — flash is
  transient. But confirm `data-thread-id` survives a rebuild.
- **PR mode vs Local mode parity (CLAUDE.md rule)**: changes must work in
  both. External segment is intentionally hidden in Local mode; verify the
  rest of the panel (and overflow scroll) still work there.
- **Re-anchoring on diff rebuild**: when `refreshPR` rebuilds the diff DOM,
  external rows are torn down and re-rendered. The panel item's
  `data-thread-id` lookup must keep working. Confirm
  `external-comment-manager._loadExternalComments()` re-fires after rebuild
  (it does — see PR comment in `pr.js:1088`).

---

## Out of Scope

- Per-source filtering inside External (only GitHub today; future).
- Inline filter for outdated external threads (separate concern).
- Bulk actions on external threads.
- Search/filter within the External list.
