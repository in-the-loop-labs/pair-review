---
"@in-the-loop-labs/pair-review": minor
---

Add a headless, analysis-only review mode for scripts and AI coding agents. `--headless` runs an AI analysis (single provider or council), stores the results in the local database as usual, reports them, and exits — without starting the server, opening a browser, or posting to GitHub. It implies analysis (no `--ai` needed) and works with a `<PR-number-or-URL>` or with `--local`. A successful analysis exits `0` regardless of how many findings it surfaces; non-zero is reserved for operational errors.

`--json` (only valid with `--headless`) emits the completed run plus its consolidated final suggestions as a single JSON document on a clean stdout, with all logs redirected to stderr, so agents can parse it directly. `--instructions "<text>"` adds per-run custom instructions for the analysis; `--instructions-file <path>` reads them from a file instead (5000-character cap, mutually exclusive with `--instructions`). Instructions apply to every mode that runs analysis — the headless and submit modes consume them directly, and the interactive `--ai`/`--council` modes carry them into the browser-triggered analysis. Passing `--instructions` without an analysis mode is now rejected with a clear error instead of being silently dropped.

Also wires the repository's configured default review config into resolution: when neither `--council` nor `--model` is given, pair-review now uses `repo_settings.default_council_id` (a saved council) if set, otherwise the repo's `default_provider`/`default_model`, otherwise the global config default. This applies to `--headless` and to the web UI's default **Analyze** action, so an interactive analysis with no explicit pick honors a repo's default council too.
