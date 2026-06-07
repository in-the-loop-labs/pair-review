---
"@in-the-loop-labs/pair-review": minor
---

Render diff file bodies lazily so very large PRs (hundreds of files, many of them large/generated translation files) stay responsive. Previously every changed file's diff lines were built into the DOM and syntax-highlighted on load — even for files collapsed behind a generated/viewed header — which froze the browser on big diffs.

Now each file renders its header eagerly but builds its `<tbody>` of diff lines on demand: when the body scrolls near the viewport (IntersectionObserver), when the file is expanded, or when a comment, AI suggestion, gap expansion, or navigation needs to anchor into it (via a new `ensureFileBodyRendered` primitive). Collapsed bodies are never rendered until expanded. Hunk-summary anchoring became incremental to match (anchors are wired as each file body renders). Works in both PR and Local modes.

Note: because off-screen and collapsed file bodies are no longer in the DOM, the browser's native Find (Ctrl/Cmd+F) will not match text in files you haven't scrolled to or expanded.
