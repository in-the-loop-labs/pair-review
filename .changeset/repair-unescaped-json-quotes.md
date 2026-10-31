---
"@in-the-loop-labs/pair-review": patch
---

Recover AI responses whose JSON contains an unescaped `"` inside a string value (e.g. a description that quotes a word without escaping it). Previously one such quote made every JSON extraction strategy fail, so a whole consolidation response could be discarded; extraction now escapes the offending quotes at the offsets the JSON parser reports and retries.
