# Notification Sounds

## Context

Users want audible feedback when long-running operations complete (AI analysis, PR/local review setup). Since the user may be in another app or tab while waiting, in-app audio via the Web Audio API is the most reliable channel -- no permissions required, not blocked by OS DND modes, works in background tabs. Configuration stored in localStorage, toggleable from a header dropdown without restart.

## Scope

- **Two events**: analysis complete, setup complete
- **One synthesized chime** via Web Audio API (no sound files to ship)
- **Header dropdown** with per-event toggles, persisted in localStorage
- **Both pages**: pr.html, local.html, setup.html

## Implementation

### 1. `public/js/utils/notification-sounds.js` — NotificationSounds class

Singleton managing Web Audio API playback and localStorage preferences.

```
localStorage keys:
  pair-review-notify-analysis  →  'true' | 'false' (default: 'true')
  pair-review-notify-setup     →  'true' | 'false' (default: 'true')
```

Public API:
- `playIfEnabled(eventType)` — checks localStorage, plays chime if enabled
- `isEnabled(eventType)` → boolean
- `setEnabled(eventType, boolean)` — writes localStorage
- `playChime()` — synthesizes a short two-tone chime using Web Audio API (OscillatorNode → GainNode with quick exponential ramp-down, ~300ms total)

The chime: two sine-wave notes in quick succession (e.g., 587Hz then 784Hz, ~150ms each) with a smooth gain fadeout. Pleasant, unobtrusive, distinct.

Global instance: `window.notificationSounds = new NotificationSounds()`

### 2. `public/js/components/NotificationDropdown.js` — Header UI

Follows the DiffOptionsDropdown popover pattern (fixed positioning, click-outside dismiss, Escape to close, opacity+transform animation).

- Bell icon button added to `.header-icon-group` in both `pr.html` and `local.html`
- Dropdown contains two checkbox toggles:
  - "Analysis complete" (reads/writes `pair-review-notify-analysis`)
  - "Setup complete" (reads/writes `pair-review-notify-setup`)
- "Test sound" link at bottom to preview the chime
- Button gets `.active` class when any notification is enabled (visual indicator)
- Constructed in `pr.js` init (and re-constructed by `local.js` since it destroys/rebuilds the header icon group — verify this)

### 3. Hook into analysis completion

**File**: `public/js/components/StatusIndicator.js`, method `showComplete()` (~line 112)

Add one line at the top of `showComplete()`:
```js
if (window.notificationSounds) window.notificationSounds.playIfEnabled('analysis');
```

### 4. Hook into setup completion

**File**: `public/setup.html`, inline `<script>`, inside the `case 'complete'` handler (~line 809)

Add before the redirect timeout:
```js
if (window.notificationSounds) window.notificationSounds.playIfEnabled('setup');
```

Also add a `<script src="/js/utils/notification-sounds.js"></script>` to setup.html (the dropdown is not needed on the setup page — just the sound).

### 5. Wire up script loading

**pr.html** and **local.html**: Add script tags for both new files before the existing component scripts:
```html
<script src="/js/utils/notification-sounds.js"></script>
<script src="/js/components/NotificationDropdown.js"></script>
```

**pr.html** and **local.html**: Add bell button to `.header-icon-group` (before `#theme-toggle`):
```html
<button class="btn btn-icon" id="notification-toggle" title="Notification sounds">
  <svg><!-- bell icon --></svg>
</button>
```

### 6. Initialize dropdown in pr.js

In the PR page initialization, after other header setup:
```js
const notifBtn = document.getElementById('notification-toggle');
if (notifBtn) {
  window.notificationDropdown = new NotificationDropdown(notifBtn);
}
```

Check if `local.js` destroys/rebuilds header elements — if so, add parallel initialization there.

### 7. CSS

Add minimal styles to `pr.css`:
- `.notification-popover` — reuse diff-options-popover sizing/shadow pattern
- Checkbox label styles can reuse the same inline approach as DiffOptionsDropdown
- `.active` state for the bell button (consistent with gear icon pattern)
- The "Test sound" link styling

## Files to create
- `public/js/utils/notification-sounds.js`
- `public/js/components/NotificationDropdown.js`

## Files to modify
- `public/pr.html` — add script tags + bell button in header
- `public/local.html` — add script tags + bell button in header
- `public/setup.html` — add notification-sounds.js script tag
- `public/js/components/StatusIndicator.js` — one-line sound hook in `showComplete()`
- `public/js/pr.js` — initialize NotificationDropdown
- `public/js/local.js` — initialize NotificationDropdown (if header is rebuilt)
- `public/css/pr.css` — popover styles

## Verification

1. `npm test` — ensure no regressions
2. Manual: open a PR review, click bell icon, verify dropdown toggles work
3. Manual: trigger analysis, hear chime on completion
4. Manual: open setup page for a new PR, hear chime when setup completes before redirect
5. Manual: disable a toggle, verify no sound for that event
6. Manual: verify localStorage persists across page reloads
7. `npm run test:e2e` — E2E tests pass (frontend changes)

## Hazards

- `local.js` destroys and rebuilds parts of the header UI — verify the bell button survives or is re-created
- `StatusIndicator.showComplete()` is called from multiple paths (WebSocket event, direct call) — the sound hook must be idempotent (Web Audio API handles this naturally)
- Setup page has its own inline script, not the component system — keep the integration minimal (just the sound utility, no dropdown)
- The Web Audio API `AudioContext` may need a user gesture to unlock — pair-review requires clicks to do anything, so this is satisfied by the time analysis completes
