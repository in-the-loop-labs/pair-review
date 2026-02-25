# Plan: "Assisted by pair-review" Footer Toggle in Submit Review Dialog

## Context

Users submitting GitHub reviews via pair-review may want to credit the tool. This adds a checkbox to the Submit Review dialog that appends an attribution footer to the review body. The footer is visible in the textarea so the user sees exactly what will be submitted. Toggle state persists via localStorage. The footer link URL is configurable via `config.json` so organizations can point it at internal docs or a custom page.

PR mode only — Local mode has no GitHub submission.

## Footer Text

```markdown
---
_Review assisted by [pair-review](https://github.com/in-the-loop-labs/pair-review)_
```

The URL (`https://github.com/in-the-loop-labs/pair-review`) is the default but is configurable via `assisted_by_url` in `~/.pair-review/config.json`.

## Changes

### 1. `src/config.js` — Add default config key

Add `assisted_by_url` to `DEFAULT_CONFIG` (line 12-27):

```js
assisted_by_url: "https://github.com/in-the-loop-labs/pair-review",
```

### 2. `src/routes/config.js` — Expose to frontend

Add to the `GET /api/config` response (line 36-44):

```js
assisted_by_url: config.assisted_by_url || DEFAULT_CONFIG.assisted_by_url,
```

### 3. `public/js/components/ReviewModal.js` — Core feature

**Add constants** (top of file):

```js
const ASSISTED_BY_STORAGE_KEY = 'pair-review-assisted-by';
const DEFAULT_ASSISTED_BY_URL = 'https://github.com/in-the-loop-labs/pair-review';
```

The footer text is built dynamically using the configured URL (fetched from `/api/config`). A helper method builds the footer string.

**Add HTML** — checkbox between `</textarea>` (line 71) and `</div>` closing `review-summary-section` (line 72):

```html
<label class="assisted-by-toggle" id="assisted-by-toggle">
  <input type="checkbox" id="assisted-by-checkbox" />
  <span class="assisted-by-label">Review assisted by pair-review</span>
</label>
```

**New methods on `ReviewModal`:**

| Method | Purpose |
|---|---|
| `getAssistedByFooter()` | Build footer string using configured URL (cached from `/api/config`) |
| `restoreAssistedByToggle()` | Read localStorage, set checkbox state, append footer if ON |
| `appendAssistedByFooter()` | Append footer to textarea if not already present at end |
| `removeAssistedByFooter()` | Remove footer from textarea end if exact match found |
| `handleAssistedByToggle()` | On checkbox change: save to localStorage, append/remove footer |

**Modify existing methods:**

- **`constructor()`** — fetch `/api/config` to get `assisted_by_url`, cache it as `this.assistedByUrl`
- **`show()`** — call `this.restoreAssistedByToggle()` after textarea is cleared (after line 225)
- **`setupEventListeners()`** — add `#assisted-by-checkbox` handler in the existing delegated `change` listener (line 182-186)
- **`appendAISummary()`** — if footer is present, insert AI summary *before* the footer rather than after
- **`updateTextareaState()`** — visually disable the toggle when Draft is selected

**No changes to `submitReview()`** — the footer is already in `textarea.value`.

### 4. `public/css/pr.css` — Styling

Add ~30 lines after the `.review-body-textarea` styles (around line 4847):

- `.assisted-by-toggle` — flex row, 12px text, secondary color, pointer cursor
- `.assisted-by-toggle:hover` — text color emphasis
- `.assisted-by-toggle.disabled` — reduced opacity, no pointer events (Draft mode)
- `.assisted-by-toggle input[type="checkbox"]` — 14px, accent-color
- Dark theme variants via `[data-theme="dark"]` selectors

### 5. `tests/unit/review-modal.test.js` — Unit tests

New `describe('Assisted-by Footer Toggle')` block:

1. Restores checkbox ON from localStorage → footer appended
2. Restores checkbox OFF → no footer
3. No localStorage key → defaults to unchecked
4. Toggle ON → saves `'true'`, appends footer
5. Toggle OFF → saves `'false'`, removes footer
6. `appendAssistedByFooter` doesn't duplicate
7. `removeAssistedByFooter` is no-op when footer absent
8. `appendAISummary` inserts before footer when present
9. Uses configured URL from `/api/config`

### 6. `tests/unit/config.test.js` — Config test

Add test verifying `assisted_by_url` default value in config.

### 7. E2E tests — `tests/e2e/review-submission.spec.js`

1. Toggle visible in modal
2. Toggle ON appends footer to textarea
3. Toggle OFF removes footer
4. Footer included in submitted review body (intercept API call)

### 8. Changeset

`.changeset/*.md` — package `@in-the-loop-labs/pair-review`, bump `minor` (new user-facing feature).

## Verification

1. `npm test` — unit tests pass
2. `npm run test:e2e` — E2E tests pass
3. Manual: open Submit Review dialog, toggle checkbox on/off, verify textarea updates, close/reopen to verify persistence, submit and verify footer in request payload
4. Set `assisted_by_url` in `~/.pair-review/config.json` to a custom URL, verify the footer uses it
