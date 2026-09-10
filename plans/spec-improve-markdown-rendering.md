---
title: 'Improve rendered Markdown rhythm and code highlighting'
type: 'feature'
created: '2026-09-09'
status: 'done'
baseline_commit: '8994a1b643cc3fde2e3bb620af95cacce5d36fb9'
context:
  - '/Users/janessa.garrow/Dev/pair-review/CLAUDE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Rendered Markdown in the review UI has uneven browser-default spacing, so headings, paragraphs, lists, quotes, tables, and code blocks do not read as one polished document. Fenced code retains its language label but is not syntax-highlighted.

**Approach:** Establish a deliberate GitHub-like vertical rhythm for the Rendered document view and connect the existing highlight.js runtime to the shared, sanitized markdown-it renderer. Keep highlighting optional and safely degrade to escaped, unhighlighted code when highlight.js or a requested language is unavailable.

## Boundaries & Constraints

**Always:** Preserve DOMPurify sanitization and the narrow class allowlist; support light/dark themes and both PR and Local pages; keep long code blocks horizontally scrollable; preserve block and granular comment affordances; use the existing highlight.js dependency/runtime rather than adding another highlighter.

**Ask First:** Any proposal to change Markdown parsing semantics, permit arbitrary classes/styles, add a dependency, or redesign comment-card typography beyond the Rendered document surface.

**Never:** Highlight by inserting unsanitized HTML after DOMPurify; remove the Diff/Rendered behavior or source-line anchors; auto-detect an unlabeled fence as a possibly incorrect language; hand-roll syntax tokenization; alter server/API/database behavior.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Supported fence | A fenced block with a known language such as `js` | highlight.js emits sanitized token spans and the existing theme colors render them | N/A |
| Unknown fence | A fence names an unsupported language | Code remains escaped, readable, and labeled without throwing | Fall back to markdown-it’s normal fence rendering |
| Runtime unavailable | highlight.js is absent or fails for one block | All Markdown still renders safely; code is unhighlighted | Catch the highlighting failure and use normal escaped output |
| Hostile classes | Raw repository HTML includes layout/app classes | DOMPurify strips them; only language hints and scoped highlight.js token classes survive | Reject all unrelated classes |

</frozen-after-approval>

## Code Map

- `public/js/utils/markdown.js` -- shared markdown-it configuration, DOMPurify allowlist, and browser globals used by rendered documents, comments, summaries, and chat.
- `public/css/pr.css` -- Rendered document layout plus code-block, comment, and chat presentation shared by PR and Local pages.
- `public/css/styles.css` -- existing highlight.js light/dark token theme overrides.
- `public/pr.html`, `public/local.html` -- both already load highlight.js before the shared Markdown utility.
- `tests/unit/markdown.test.js` -- direct tests of production rendering and sanitizer behavior.
- `tests/e2e/markdown-rendering.spec.js` -- real-browser coverage for the shared renderer.
- `.changeset/rendered-markdown-view.md` -- unreleased feature changeset for this branch.

## Tasks & Acceptance

**Execution:**
- [x] `public/js/utils/markdown.js` -- enable highlighting only when DOMPurify is the final renderer boundary; validate highlighter results; cap synchronous highlighting for large fences; safely support punctuation-bearing language aliases; and retain only language hints plus highlight.js token/modifier classes required by the theme (never arbitrary or unused root classes).
- [x] `public/css/pr.css` -- replace browser-default Rendered-document margins with consistent spacing that survives hidden blank-line gap nodes; refine heading hierarchy, paragraphs, lists, quotes, rules, tables, images, inline code, prose overflow, and fenced-code horizontal scrolling without obscuring comment controls.
- [x] `public/css/styles.css` -- define explicit highlight.js palettes under both application `data-theme` values so manual theme selection does not inherit the operating-system palette.
- [x] `tests/unit/markdown.test.js` -- cover supported highlighting, compound scopes, punctuation-bearing aliases, hostile classes/markup, oversized fences, malformed/missing/failing highlighters, escaped fallback code, and no-DOMPurify behavior.
- [x] `tests/e2e/test-server.js`, `tests/e2e/rendered-markdown-mode.spec.js` -- exercise a long supported fence in the actual Rendered document for both PR and Local modes; verify token colors change with the application theme even when it opposes OS preference, hidden-gap spacing works, long code scrolls without widening the document, and code-block comment controls remain reachable.
- [x] `.changeset/rendered-markdown-view.md` -- mention the polished spacing and fenced-code highlighting in the existing unreleased Rendered Markdown feature note.

**Acceptance Criteria:**
- Given a Markdown document containing headings, prose, lists, a quote, a table, and code, when Rendered mode is opened, then elements have consistent separation and no first/last-child excess spacing.
- Given a long fenced code line, when it is rendered, then it scrolls horizontally instead of forcing the review layout wider or wrapping token content.
- Given the same review in PR mode and Local mode, when a known-language fence is rendered in light or dark application theme (including when it opposes OS preference), then syntax tokens are distinguishable, theme-specific, and readable.
- Given normal blank-line-separated Markdown, when hidden separator gap nodes are interleaved between block wrappers, then paragraph and heading spacing remains consistent.
- Given existing block/list/table/code comment targets, when spacing styles apply, then their hover, focus, badge, and click affordances remain reachable and unobscured.

## Spec Change Log

- **Review loop 2:** Review found that the first design lost highlight.js compound scope modifiers, could highlight without DOMPurify, tied light syntax colors to OS preference, used adjacency selectors broken by hidden separator nodes, and tested comments rather than the Rendered document. Tasks now require sanitizer-gated highlighting, validated/capped highlighter output, a minimal explicit modifier allowlist, explicit application-theme palettes, gap-tolerant rhythm selectors, and PR/Local Rendered-document E2E coverage. **Known-bad avoided:** unsanitized third-party markup, silently degraded token colors, inconsistent ordinary Markdown spacing, and false-positive theme/integration tests. **KEEP:** reuse highlight.js and markdown-it; unsupported/unlabeled/failing fences safely fall back; preserve horizontal scrolling, DOMPurify class scoping, GitHub-like styling, and all comment affordances.

## Design Notes

Highlight before sanitization through markdown-it’s documented `highlight` callback, but only configure that callback when DOMPurify is available. DOMPurify remains the final trust boundary: punctuation-safe `language-*` hints stay limited to code/pre nodes; spans may retain `hljs-*` plus only the explicit highlight.js modifiers used by the bundled theme (`class_`, `function_`, `inherited__`, `language_`) and only when an `hljs-*` scope is present. The unused root `hljs` class is not permitted. Unknown, unlabeled, oversized, malformed, or failed highlights return markdown-it to escaped plain code.

The Rendered document is composed of separate top-level block wrappers with hidden `.rendered-markdown-gap` separator nodes between ordinary blank-line-separated blocks. Rhythm selectors must therefore be scoped general-sibling rules rather than adjacent-sibling rules. Inner elements reset browser-default outer margins, and the existing `.rendered-markdown-heading-block` marker provides stronger section spacing without affecting comment-card Markdown.

Theme token colors are selected by application `data-theme`, not only by `prefers-color-scheme`; both palettes override the CDN theme when user preference and OS preference disagree.

## Verification

**Commands:**
- `npm test -- tests/unit/markdown.test.js tests/unit/rendered-document-view.test.js` -- expected: renderer security/highlighting and document-view tests pass.
- `npm run test:e2e -- tests/e2e/rendered-markdown-mode.spec.js` -- expected: PR/Local Rendered-document flows, theme palettes, spacing, overflow, and comment affordances pass headlessly.
- `git diff --check` -- expected: no whitespace errors.

## Suggested Review Order

**Safe highlighting pipeline**

- Start with the bounded, sanitizer-coupled markdown-it configuration.
  [`markdown.js:89`](../public/js/utils/markdown.js#L89)

- Review fence validation, failure fallback, and output amplification limits.
  [`markdown.js:139`](../public/js/utils/markdown.js#L139)

- Verify explicit token classes preserve compound scopes without admitting arbitrary classes.
  [`markdown.js:226`](../public/js/utils/markdown.js#L226)

- Confirm browser initialization couples highlighting to the final DOMPurify boundary.
  [`markdown.js:287`](../public/js/utils/markdown.js#L287)

**Rendered document presentation**

- Hidden separator nodes no longer interrupt top-level document rhythm.
  [`pr.css:14052`](../public/css/pr.css#L14052)

- Bounded content, explicit margins, and nested overflow preserve comment controls.
  [`pr.css:14064`](../public/css/pr.css#L14064)

- Application-selected palettes override conflicting operating-system preferences.
  [`styles.css:382`](../public/css/styles.css#L382)

**Behavioral proof**

- The fixture combines code, quotes, unbroken prose, and a genuinely wide table.
  [`test-server.js:872`](../tests/e2e/test-server.js#L872)

- PR and Local flows verify rhythm, exact palettes, scrolling, and comment controls.
  [`rendered-markdown-mode.spec.js:231`](../tests/e2e/rendered-markdown-mode.spec.js#L231)

- Unit coverage exercises compound scopes and punctuation-bearing language aliases.
  [`markdown.test.js:178`](../tests/unit/markdown.test.js#L178)

- Security regression proves exported configuration cannot highlight without a purifier.
  [`markdown.test.js:309`](../tests/unit/markdown.test.js#L309)

**Release note**

- The existing feature changeset describes the polished and safely degraded experience.
  [`rendered-markdown-view.md:23`](../.changeset/rendered-markdown-view.md#L23)
