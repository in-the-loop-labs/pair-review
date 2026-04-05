---
"@in-the-loop-labs/pair-review": patch
---

Fix Pi chat provider ignoring extra_args from config overrides

The `extra_args` field in Pi chat provider config (e.g., `["--no-extensions", "-e", "..."]`) was correctly merged into the provider definition but silently dropped when constructing PiBridge. Now passed through and appended in `_buildArgs()`.
