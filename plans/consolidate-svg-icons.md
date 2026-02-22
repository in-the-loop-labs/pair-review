# Plan: Consolidate Duplicated SVG Icons into Shared Module

## Context

Inline SVG strings are duplicated extensively across the frontend — the discussion/chat icon alone appears ~20 times in 8 files. This creates maintenance burden and inconsistency. We'll create a shared `public/js/utils/icons.js` module following the existing IIFE + `window.*` global pattern used by `category-emoji.js`.

## Module API Design

```js
// public/js/utils/icons.js
(function() {
  const ICON_DEFS = {
    discussion: { viewBox: '0 0 16 16', paths: '<path d="M1.75 1h8.5c..."/>' },
    close:      { viewBox: '0 0 16 16', paths: '<path d="M3.72 3.72..."/>' },
    // Icons with non-standard viewBox:
    brain:      { viewBox: '0 0 24 24', paths: '<path d="M21.33 12.91..."/>' },
    // Icons needing stroke instead of fill:
    logo:       { viewBox: '0 0 24 24', attrs: 'fill="none" stroke="currentColor" ...', paths: '...' },
    sparkle:    { viewBox: '0 0 24 24', attrs: 'fill="none" stroke="currentColor" ...', paths: '...' },
    // ...
  };

  // icon(name, width?, height?) or icon(name, { width, height, className })
  // height defaults to width; both default to 16
  function icon(name, widthOrOpts, height) { ... }

  window.Icons = { icon, DEFS: ICON_DEFS };
  if (typeof module !== 'undefined' && module.exports) { module.exports = { icon, DEFS: ICON_DEFS }; }
})();
```

The helper uses `def.attrs || 'fill="currentColor"'` to handle stroke-based icons (logo, sparkle).

## Icon Registry (~28 entries)

| Name | viewBox | Notes |
|------|---------|-------|
| `discussion` | 16 | Comment-discussion two-bubble |
| `close` | 16 | X/dismiss |
| `check` | 16 | Checkmark/adopt |
| `pencil` | 16 | Edit pencil |
| `star` | 16 | Star-fill (praise) |
| `sparkles` | 16 | Three-star copilot sparkles |
| `commentAi` | 16 | Comment bubble + sparkle |
| `person` | 16 | Person silhouette |
| `eye` | 16 | Eye open |
| `eyeClosed` | 16 | Eye closed |
| `brain` | **24** | Reasoning brain (MDI) |
| `trash` | 16 | Delete/trash |
| `chevronRight` | 16 | Standard right chevron |
| `chevronRightSmall` | **12** | Smaller file-tree chevron (different path) |
| `chevronDown` | 16 | Down chevron |
| `chevronUp` | 16 | Up chevron |
| `comment` | 16 | Single bubble outline |
| `commentFilled` | 16 | Single bubble filled |
| `copy` | 16 | Clipboard/copy |
| `info` | 16 | Info circle |
| `logo` | **24** | Infinity loop (stroke-based) |
| `sun` | 16 | Light theme |
| `moon` | 16 | Dark theme |
| `sparkle` | **24** | Single Heroicons sparkle (stroke-based) |
| `sparkleSmall` | 16 | Single small sparkle |
| `speechBubbleSolid` | 16 | Solid speech bubble |
| `clock` | 16 | Clock icon |
| `file` | 16 | File/file-diff icon |

`speechBubble` aliases to `comment` (identical paths).

## Implementation Phases

### Phase 1: Create `public/js/utils/icons.js`
- New file with IIFE, full icon registry, `icon()` helper
- SPDX license header, `window.Icons` export, `module.exports` for tests

### Phase 2: Load script in HTML (`pr.html`, `local.html`)
- Add `<script src="/js/utils/icons.js"></script>` after `time.js` in both files
- HTML-template SVGs (logo, sun, moon in `<header>`) stay as-is (JS not loaded yet)

### Phase 3: Migrate consumer files (highest duplication first)
Each migration: replace inline SVGs with `window.Icons.icon(name, w, h)`, remove stale static constants.

1. **`public/js/components/AIPanel.js`** — Remove `static ICONS`, update ~15 inline SVGs
2. **`public/js/modules/diff-renderer.js`** — Remove 4 static icon constants
3. **`public/js/components/AdvancedConfigTab.js`** — Remove 4 static SVG constants
4. **`public/js/components/VoiceCentricConfigTab.js`** — Remove 4 static SVG constants (exact duplicates of #3)
5. **`public/js/components/ChatPanel.js`** — Remove `DISMISS_ICON`, update ~12 inline SVGs
6. **`public/js/modules/analysis-history.js`** — Update discussion, sparkle, chevron, copy icons
7. **`public/js/modules/suggestion-manager.js`** — Update star, sparkles, discussion, eye, check, pencil, X
8. **`public/js/modules/comment-manager.js`** — Remove `SUGGESTION_ICON_SVG`, update ~8 inline SVGs
9. **`public/js/modules/file-comment-manager.js`** — Update ~10 inline SVGs including brain icons
10. **`public/js/components/PanelGroup.js`** — Remove `POPOVER_ICONS`
11. **`public/js/pr.js`** — Remove `LOGO_ICON`, update comment/discussion/sun/moon/chevron icons
12. **Remaining single-X-icon files** — AnalysisConfigModal, KeyboardShortcuts, StatusIndicator, ConfirmDialog, TextInputDialog, ReviewModal, PreviewModal, AISummaryModal, CouncilProgressModal, repo-settings.js, SuggestionNavigator.js

### Phase 4: Tests
- Create `tests/unit/icons.test.js` — verify helper returns correct dimensions, viewBox, className, stroke/fill modes, unknown icon returns `''`

## Verification
1. `npm test` — unit tests pass including new icons.test.js
2. `npm run test:e2e` — existing E2E suite catches any broken click targets
3. Manual smoke: open pr.html and local.html, verify all icons render across toolbar, diff, panels, modals

## Files to Modify
- **New**: `public/js/utils/icons.js`, `tests/unit/icons.test.js`
- **HTML**: `public/pr.html`, `public/local.html`
- **Components**: AIPanel.js, ChatPanel.js, PanelGroup.js, AdvancedConfigTab.js, VoiceCentricConfigTab.js, AnalysisConfigModal.js, KeyboardShortcuts.js, StatusIndicator.js, ConfirmDialog.js, TextInputDialog.js, ReviewModal.js, PreviewModal.js, AISummaryModal.js, CouncilProgressModal.js, SuggestionNavigator.js
- **Modules**: diff-renderer.js, suggestion-manager.js, comment-manager.js, file-comment-manager.js, analysis-history.js
- **Core**: pr.js, repo-settings.js
