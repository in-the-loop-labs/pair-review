---
"@in-the-loop-labs/pair-review": patch
---

Syntax-highlight ERB, Scala and Dockerfile lines in context files and legacy diff rendering by loading their Highlight.js grammars, and drop the `.sass` and `.vim` mappings that never highlighted. Lines in a language whose grammar isn't loaded now fall back to plain text without a console warning per line.
