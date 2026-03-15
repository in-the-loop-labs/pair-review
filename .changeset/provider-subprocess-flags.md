---
"@in-the-loop-labs/pair-review": minor
---

Enable user skills and extensions in AI provider subprocesses

AI analysis and chat subprocesses no longer suppress the user's configured skills and extensions (`--no-skills`, `--no-extensions` removed from Pi provider, Pi chat bridge, and task extension). This lets the user's environment flow through to subprocesses by default. To opt out, add the corresponding flags to `extra_args` in provider/model config.

Also adds hook suppression (`disableAllHooks`) to the Claude analysis provider, preventing user hooks from firing during review analysis — consistent with the existing chat bridge behavior.
