# Plan: Hide HTML comments and render GitHub-style inline HTML in markdown

## Context

Pair-review's rendered comments currently show raw HTML comments (`<!-- thread-id:a1b2c3 -->`,
`<!-- line:35 -->`, etc.) as visible text, and inline HTML tags such as `<sub>` appear as
literal escaped text instead of rendering. Both symptoms have the same root cause: the single shared
markdown renderer is configured with `html: false`, which disables **all** HTML handling in
markdown-it. With that flag off, HTML comments and tags are neither stripped nor interpreted — they
are escaped and shown verbatim.

Desired outcome (matching GitHub behaviour):
1. HTML comments are **hidden** in the rendered view (still visible when editing the raw text, which
   is unaffected because the editor shows source, not rendered output).
2. A safe subset of inline HTML — `<sub>`, `<sup>`, `<kbd>`, etc. — renders as real elements.

## Approach

Enable `html: true` in markdown-it and pass the rendered output through **DOMPurify** with an
explicit GitHub-like allowlist. DOMPurify removes comment nodes and dangerous tags/attributes by
default, so this satisfies both requirements with one well-tested sanitizer rather than a fragile
hand-rolled regex. Delivery via CDN, matching the sibling markdown-it libraries.

**Safety invariant:** never emit `html: true` output unsanitized. If `window.DOMPurify` is
unavailable (e.g. offline), fall back to the current `html: false` behaviour (comments visible, tags
escaped) — degraded but safe. This mirrors the existing guard that only defines `renderMarkdown`
when `window.markdownit` is present.

## Files to change

### 1. `public/js/utils/markdown.js` (core)
Refactor for testability (per repo convention: export the real implementation, do not duplicate in
tests) while preserving the browser-only IIFE path:
- Extract pure, Node-exportable helpers:
  - `configureMarkdownIt(markdownit, { emoji })` → returns a configured md instance with
    `html: true` (plus existing `breaks`, `linkify`, `typographer`, emoji plugin, and the
    `link_open` target/rel rule).
  - `sanitizeHtml(purify, html)` → runs DOMPurify with the allowlist below.
  - `createRenderMarkdown({ md, purify })` → returns the `renderMarkdown(text)` function
    (try/catch → `escapeHtml` fallback, unchanged contract).
- Browser IIFE: only enable `html: true` + sanitization when **both** `window.markdownit` and
  `window.DOMPurify` exist; otherwise build the renderer with `html: false` and no sanitizer (safe
  fallback). Keep `window.renderMarkdown`, `window.markdownRenderer`, `window.escapeHtmlAttribute`.
- `module.exports` (Node): `escapeHtmlAttribute` (existing) plus `configureMarkdownIt`,
  `sanitizeHtml`, `createRenderMarkdown` for unit testing.

**DOMPurify allowlist (GitHub-like set):**
- `ALLOWED_TAGS`: standard markdown output (`p, a, code, pre, blockquote, ul, ol, li, h1–h6, em,
  strong, hr, table, thead, tbody, tr, th, td, img, span, br`) **plus** `sub, sup, kbd, ins, del,
  mark, details, summary, abbr`.
- `ALLOWED_ATTR`: `href, title, target, rel, src, alt, align, class, start, colspan, rowspan`.
- Add an `afterSanitizeAttributes` hook to force `target="_blank"` + `rel="noopener noreferrer"` on
  anchors, so link security survives sanitization regardless of DOMPurify defaults.
- Comments: removed by DOMPurify default (do not set `ALLOW_COMMENTS`).

### 2. `public/pr.html` and `public/local.html`
Add a DOMPurify CDN `<script>` (pinned, e.g. `dompurify@3.x`) immediately **before**
`/js/utils/markdown.js` (after the markdown-it scripts) in both files, so `window.DOMPurify` exists
when markdown.js runs.

### 3. `package.json`
Add `dompurify` as a **devDependency**, pinned to the same major as the CDN script, for unit tests.
(`jsdom` and `markdown-it` are already present.)

### 4. `tests/unit/markdown.test.js` (new)
Import the real module; wire real `markdown-it` + DOMPurify created over jsdom
(`createDOMPurify(new JSDOM('').window)`). Cases:
- HTML comment (own-line block **and** inline) → not present in output / not visible.
- `<sub>x</sub>`, `<sup>2</sup>`, `<kbd>Ctrl</kbd>` → real elements.
- XSS regression: `<script>`, `<img onerror=…>`, `javascript:` href → stripped/neutralised.
- Anchors get `target="_blank" rel="noopener noreferrer"`.
- Fallback: `createRenderMarkdown` built without a purify → behaves as `html: false` (tags escaped),
  and empty/null input returns `''`.
- `escapeHtmlAttribute` still exported and unchanged.

### 5. E2E (via Task tool, per repo rule for frontend changes)
Add/extend a Playwright spec asserting a rendered comment whose body contains an HTML comment marker
+ `<sub>` shows the subscript and hides the comment. Because both modes share
`window.renderMarkdown`, one mode exercises the shared path; note parity in the spec.

### 6. `.changeset/*.md`
`minor` for `@in-the-loop-labs/pair-review`: "Render GitHub-style inline HTML (sub/sup/kbd, …) and
hide HTML comments in rendered markdown comments."

### 7. README
Check for a section documenting markdown/comment support; add a one-line note only if such a section
exists. Likely skip.

## Hazards

- **Blast radius:** `renderMarkdown` is the single renderer behind ~15 call sites across PR **and**
  Local mode (`pr.js`, `ChatPanel.js`, `AISummaryModal.js`, `file-comment-manager.js`,
  `comment-manager.js`, `external-comment-manager.js`, `suggestion-manager.js`, `pierre-bridge.js`,
  `suggestion-ui.js`, `AISummaryModal.js`). Enabling `html: true` changes rendering for **every**
  markdown surface, not just comments — verify code blocks, tables, emoji, and autolinks still
  render. Covered by unit tests + E2E.
- **XSS:** `html: true` without sanitization is an injection hole; comment bodies include
  AI-generated and GitHub-sourced (untrusted) content. Mitigated by the explicit allowlist, the safe
  `html: false` fallback when DOMPurify is absent, and XSS regression tests.
- **Module load path:** markdown.js runs a browser-only IIFE at load keyed on `window.markdownit`.
  The refactor must keep that path intact while adding Node exports, and must not emit `html: true`
  output when DOMPurify is missing.
- **Raw editing unaffected:** comment editors show source text (not rendered), so "visible when
  editing raw text" is satisfied without extra work.

## Verification

1. `pnpm test` — new `tests/unit/markdown.test.js` plus existing suite green.
2. `pnpm run test:e2e` (via Task tool) — the new/extended spec passes headless.
3. Manual: run the app, open a comment containing `<!-- marker -->` and `H<sub>2</sub>O`; confirm the
   marker is hidden in the rendered view, `H₂O` renders as subscript, and the raw marker reappears
   when the comment is put into edit mode.
