# @pierre/diffs Migration

## Status: Diffs rendering in browser. Performance and interaction testing in progress.

## Overview

Migrated pair-review's diff rendering from a custom table-based approach (diff2html CDN + highlight.js CDN) to [@pierre/diffs](https://diffs.com/docs) — a diff rendering library built on Shiki. The migration is additive: legacy rendering is fully preserved as a fallback.

## Architecture

### Rendering Pipeline (before)

```
GitHub API → patch string
  → HunkParser.parseDiffIntoBlocks()     # parse unified diff
  → DiffRenderer.renderDiffLine()         # create <tr> with highlight.js
  → HunkParser.createGapSection()         # expandable gaps between hunks
  → DOM: <table class="d2h-diff-table">   # flat table, no isolation
```

### Rendering Pipeline (after)

```
GitHub API → patch string
  → PierreBridge.parsePatch()             # wraps PierreDiffs.parsePatchFiles()
  → PierreBridge.renderFile()             # creates FileDiff instance
  → @pierre/diffs FileDiff.render()       # renders into Shadow DOM with Shiki
  → PierreBridge.addAnnotation()          # comments/suggestions via renderAnnotation
  → DOM: <div class="pierre-diff-body">   # Shadow DOM isolation
           └── <diffs-container>          # @pierre/diffs custom element
```

### File Layout

```
scripts/
  build-pierre-diffs.mjs    # esbuild: bundles @pierre/diffs → browser IIFE
  pierre-diffs-entry.mjs    # re-exports only the APIs pair-review needs

public/js/vendor/
  pierre-diffs.js            # generated bundle (~9.4MB, gitignored)
  pierre-diffs.js.map        # sourcemap (gitignored)

public/js/modules/
  pierre-bridge.js           # adapter between @pierre/diffs and pair-review
```

### PierreBridge Responsibilities

| Concern | How it works |
|---------|-------------|
| **Rendering** | One `FileDiff` instance per file, stored in `this.files` Map |
| **Patch parsing** | `parsePatchFiles()` with git diff header wrapper → `FileDiffMetadata` |
| **Annotations** | Comments, suggestions, forms rendered via `renderAnnotation` callback |
| **Form reuse** | Form elements cached in a Map by ID — returned on re-render to preserve textarea content |
| **diffPosition** | Computed from patch at render time, stored per-file. Looked up when creating comments for GitHub API submission |
| **Theme** | `setThemeType()` on each FileDiff instance; CSS variables inherit into Shadow DOM |
| **Expansion** | Delegated to @pierre/diffs' built-in `expandHunk()` via `onHunkExpand` callback |
| **Disabled mode** | If `window.PierreDiffs` is missing, sets `_disabled = true` and all calls return early |

### DOM Structure (per file)

```html
<div class="d2h-file-wrapper" data-file-name="src/foo.js">    <!-- KEPT: pair-review's wrapper -->
  <div class="d2h-file-header">...</div>                      <!-- KEPT: custom file header -->
  <div class="file-comments-zone">...</div>                   <!-- KEPT: file-level comments -->
  <div class="pierre-diff-body">                               <!-- NEW: @pierre/diffs container -->
    <diffs-container>                                          <!-- @pierre/diffs custom element -->
      #shadow-root (open)                                      <!-- Shadow DOM boundary -->
        <pre data-diffs-container>                             <!-- diff content + Shiki tokens -->
          <code data-unified="true">...</code>
        </pre>
        <!-- annotations rendered here via renderAnnotation -->
    </diffs-container>
  </div>
</div>
```

### Code Path Branching

Every method that touches diff rendering now has two paths:

```javascript
if (this.pierreBridge && !this.pierreBridge._disabled && this.pierreBridge.files.has(fileName)) {
  // @pierre/diffs path: use annotations, PierreBridge API
} else {
  // Legacy path: table DOM manipulation, highlight.js
}
```

This pattern appears in: `renderFileDiff`, `showCommentForm`, `loadUserComments`, `displayAISuggestions`, `expandForSuggestion`, `ensureLinesVisible`, `toggleFileCollapse`, `toggleFileViewed`, `toggleTheme`.

### Annotation Types

| Type | Metadata | When created |
|------|----------|-------------|
| `comment` | `{ id, body, status, side, line_start, line_end, ... }` | `loadUserComments()` |
| `suggestion` | `{ id, type, tier, title, body, status, ... }` | `displayAISuggestions()` |
| `comment-form` | `{ lineStart, lineEnd, fileName, diffPosition, side }` | `showCommentForm()` via gutter click |

Annotations are rendered by the `renderAnnotation` callback inside Shadow DOM. CSS for annotations is injected via `unsafeCSS` (defined as `PierreBridge.ANNOTATION_CSS`).

## Key Design Decisions

1. **Additive, not replacing** — Legacy code paths preserved. Context file rendering still uses old table approach. If the bundle fails to load, the app degrades to legacy rendering with a console warning.

2. **Custom file headers kept** — `disableFileHeader: true` on FileDiff. Pair-review's file headers (collapse, viewed checkbox, generated badge, stats, chat button) are complex and live outside Shadow DOM.

3. **Annotations for everything** — Comments, suggestions, and forms all use @pierre/diffs' annotation system. This avoids having to manually insert DOM into the Shadow DOM. Form elements are cached in a Map to preserve textarea content across annotation re-renders.

4. **diffPosition computed separately** — @pierre/diffs doesn't know about GitHub's diffPosition concept. PierreBridge parses the patch independently to build a `(side:lineNumber) → diffPosition` mapping.

5. **local.js unchanged** — Local mode patches PRManager at the API layer (swapping endpoints), not at the rendering layer. All rendering flows through pr.js which has the PierreBridge branching.

## Known Unknowns (needs browser testing)

### Gap expansion with partial patches
@pierre/diffs receives `FileDiffMetadata` with `isPartial: true` from patch parsing. The library shows collapsed regions between hunks. When user clicks expand, `expandHunk()` fires. **Unknown**: does it have enough data in the partial metadata to show expanded lines? If not, we need a fetch-and-rerender flow:

1. `onHunkExpand` callback fires
2. Fetch full file content from `/api/reviews/{id}/files/{fileName}`
3. Re-render with `parseDiffFromFile(oldFile, newFile)` which produces full metadata
4. Call `expandHunk()` on the re-rendered instance

This flow is **not yet implemented**. If expansion silently fails, this is the fix.

### Shadow DOM event handling
Playwright pierces Shadow DOM for selectors, but pair-review's own JavaScript (comment minimizer, keyboard shortcuts, etc.) may not. Any code using `document.querySelector()` to find elements inside the diff won't work — it must go through PierreBridge or access the shadow root.

### Annotation re-rendering
When `setLineAnnotations()` is called, @pierre/diffs re-renders all annotations for that file. If a comment form has unsaved text, the form element is returned from cache (preserving content). **Unknown**: does @pierre/diffs actually reuse the returned DOM element, or does it clone/replace it? If it replaces, textarea content is lost.

### CSS variable inheritance into Shadow DOM
Annotation CSS uses `var(--color-accent, #0969da)` with hardcoded fallbacks. CSS custom properties inherit into Shadow DOM from the host page. Theme toggle updates `[data-theme]` on the document and calls `pierreBridge.setTheme()`. **Unknown**: do the CSS variable changes propagate immediately, or is there a flash of wrong-themed annotations?

## Hazards

- `PierreBridge._renderAnnotation()` is called by @pierre/diffs internally. If it throws, the entire FileDiff render may fail silently.
- Context files still use old rendering. Suggestions targeting context file lines go through the legacy DOM path. If context files and diff files have overlapping line ranges, suggestion anchoring could get confused.
- The `postinstall` script runs `node scripts/build-pierre-diffs.mjs`. If esbuild isn't installed (e.g., `--production` install), it will fail. The script has try/catch and exits with code 1 on failure.

## Bugs Found & Fixed During Browser Testing

### 1. Mutual exclusion: `onGutterUtilityClick` vs `renderGutterUtility`
@pierre/diffs enforces one gutter API at a time. We were passing both. Error: `Cannot use both 'onGutterUtilityClick' and render utility callbacks`. Fix: removed `renderGutterUtility`, kept `onGutterUtilityClick` (uses built-in "+" button).

### 2. `fileContainer` vs `containerWrapper` parameter
Passing our wrapper `<div>` as `fileContainer` made @pierre/diffs treat it AS the `<diffs-container>` element — no Shadow DOM, no styles. Fix: use `containerWrapper` so @pierre/diffs creates its own `<diffs-container>` custom element inside our div.

### 3. Double-wrapping patch headers → zero hunks
`parseUnifiedDiff()` stores the full `diff --git a/... b/...` text as the per-file patch. `parsePatch()` then wrapped it AGAIN with another `diff --git` header, producing invalid input that parsed to zero hunks. Fix: check if patch already starts with `diff --git` before wrapping.

### 4. Async highlighter loading → first render returns false
Shiki highlighter loads asynchronously on first use. `FileDiff.render()` returns `false` (no content) while loading. The async callback triggers `rerender()` which succeeds. This causes a visible delay before diffs appear. Not a bug per se — inherent to @pierre/diffs' async architecture.

### 5. `setLineAnnotations()` does not trigger re-render
`setLineAnnotations()` only stores data internally — it does NOT call `renderAnnotations()`. The `_updateAnnotations()` method in PierreBridge was calling `setLineAnnotations()` alone, so annotations never appeared. Fix: call `instance.rerender()` after `setLineAnnotations()`. This triggers the `renderAnnotation` callback, which creates DOM elements that get slotted into the `<diffs-container>` light DOM via `<slot name="annotation-{side}-{lineNumber}">` elements.

### 6. Annotation CSS in shadow DOM does not reach slotted elements
The `ANNOTATION_CSS` was injected into shadow DOM via `unsafeCSS`. But annotations are slotted elements — they live in the light DOM, not the shadow DOM. Shadow DOM styles only reach slotted elements via `::slotted()`, which only selects the direct slotted element (not descendants). Fix: moved all annotation CSS (`.pierre-annotation`, `.pierre-comment`, `.pierre-suggestion`, etc.) to `public/css/pr.css` so page-level styles apply to the light DOM elements.

## Gap Expansion for Partial Patches

Hunk separators show "X unmodified lines" text (`hunkSeparators: 'line-info'`), but expansion is not available because patches are parsed as `isPartial: true`. The library explicitly disables `expandHunk()` for partial metadata since it lacks full file content.

**To enable expansion**, the following flow is needed:
1. Enable `expandUnchanged: true` option on FileDiff
2. Handle `onHunkExpand` callback
3. Fetch full old + new file content from backend API
4. Re-render with `parseDiffFromFile(oldFile, newFile)` to produce non-partial metadata
5. Call `expandHunk(hunkIndex, direction, lineCount)` on the re-rendered instance

This requires backend support to serve full file content (both old and new versions).

## Bundle Details

- **Source**: `@pierre/diffs` (v1.0.11) + all Shiki language grammars + themes
- **Output**: `public/js/vendor/pierre-diffs.js` (9.4MB minified, 13.1MB sourcemap)
- **Format**: IIFE, assigns to `window.PierreDiffs`
- **Gitignored**: Yes. Rebuilt on `npm install` via postinstall hook.
- **Included in npm package**: Yes — `"files"` array includes `"public/"` but the bundle is gitignored. Needs to be built before publish, or the postinstall hook handles it for consumers.

### Potential size optimization
Most of the 9.4MB is Shiki language grammars. If we only bundled languages pair-review users actually encounter (JS, TS, Python, Go, Rust, Ruby, Java, CSS, HTML, JSON, YAML, Markdown, Shell), the bundle could be significantly smaller. This requires configuring Shiki's language loading in the entry point.

## Testing Status

- **5145 unit/integration tests**: All pass. No test changes needed (our changes are additive).
- **32 E2E tests**: All pass. `waitForDiffToRender` updated to support both rendering paths. **Note**: E2E gap expansion tests still assert on old CSS classes (`.context-expand-row`). These likely exercise the legacy path. New E2E tests for @pierre/diffs-specific behavior should be added after browser verification.
- **Browser testing**: In progress. Annotations (comments + AI suggestions) render correctly with proper styling. Gap expansion not yet functional (needs fetch-and-rerender flow). Comment form, theme toggle, and file collapse still need verification.
