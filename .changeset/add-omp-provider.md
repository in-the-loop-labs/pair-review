---
"@in-the-loop-labs/pair-review": minor
---

Add OMP (Oh My Pi) as an AI analysis provider. OMP is a fork of the Pi coding agent driven headlessly via `omp -p --mode json`. The built-in `default` mode uses your configured OMP default model, and specific models can be added via `providers.omp.models` (model ids are passed to `omp --model` verbatim, supporting fuzzy matches and `provider/model` strings). OMP's advisor runtime is disabled during reviews by default via a bundled config overlay; set `"advisor": true` in `providers.omp` to opt in. The CLI command can be overridden with `providers.omp.command` or `PAIR_REVIEW_OMP_CMD`.
