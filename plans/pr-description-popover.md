# PR Description Info Popover

## Context
Reviewers currently have to leave pair-review and visit GitHub to read the PR description. Adding a small (i) icon next to the PR title that opens a popover with the rendered markdown description keeps reviewers in-flow.

## Implementation

### 1. HTML — Add info icon button next to PR title (`public/pr.html:94-96`)

Wrap the title and a new info button in a flex container inside `.header-center`:

```html
<div class="header-center">
  <div class="pr-title-wrapper">
    <h1 class="pr-title" id="pr-title-text">Loading...</h1>
    <button class="btn btn-icon pr-description-toggle" id="pr-description-toggle" title="View PR description" style="display: none;">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
        <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>
      </svg>
    </button>
  </div>
</div>
```

The button starts hidden and is shown by JS once PR data loads (so it doesn't flash before the description is available).

### 2. CSS — Style the wrapper and popover (`public/css/pr.css`)

- `.pr-title-wrapper` — flexbox row, center-aligned, gap, with `position: relative` for popover anchoring.
- `.pr-description-toggle` — small icon button, muted color, hover/active states.
- `.pr-description-popover` — reuse the same visual pattern as `.reasoning-popover` (absolute positioned, themed background, border, shadow, scrollable, arrow indicator). Width wider (~500px) since descriptions tend to be longer. Max-height ~60vh for long descriptions.
- Markdown content styling reuses existing `.reasoning-popover-content` rules (already handle `p`, `ul`, `ol`, `code`, `pre`).
- Support both light and dark themes via existing CSS custom properties.

### 3. JS — Toggle popover with rendered markdown (`public/js/pr.js`)

In `renderPRHeader(pr)` (around line 754, after setting the title):

- Show/hide the info button based on whether `pr.body` is truthy.
- Store `pr.body` on the button element for access by the click handler.

Add a click handler (set up once, not per-render) that:

1. Toggles the popover open/closed.
2. Creates popover DOM with header ("PR Description"), close button, and content area.
3. Renders `pr.body` via `window.renderMarkdown(body)`.
4. Positions it below the button.
5. Closes on: close button click, click outside, Escape key.

Also update Local mode (`public/js/local.js`) if it sets title similarly — but local mode likely won't have a description, so the button stays hidden (no `body` field).

### 4. Changeset

Create `.changeset/*.md` with `patch` bump describing the new feature.

## Files to modify
- `public/pr.html` — add button markup
- `public/css/pr.css` — add wrapper and popover styles
- `public/js/pr.js` — show button, wire up click handler, render markdown popover

## Verification
1. Run `npm test` for unit tests
2. Run `npm run test:e2e` to verify no regressions
3. Manual: open a PR in pair-review, verify (i) icon appears, click opens popover with rendered markdown, click outside/close/Escape dismisses, works in both light and dark themes, hidden when PR has no description
