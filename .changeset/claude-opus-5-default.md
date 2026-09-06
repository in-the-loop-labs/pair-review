---
"@in-the-loop-labs/pair-review": patch
---

Claude: make `opus-5-high` (Claude Opus 5, high effort) the provider's
default model, replacing `opus-4.8-xhigh`. Opus 5 is priced the same as Opus
4.8, so the default picks up the newer generation at no extra cost; `opus-5-xhigh`
and Fable 5.1 stay explicit thorough-tier picks. `opus-5-high` now carries the
"Recommended" badge and `opus-4.8-xhigh` reads as previous generation.

All Opus 4.8 entries (`opus-4.8-xhigh`, `opus-4.8-high`) remain available and
the bare `opus` alias still resolves to `opus-4.8-xhigh`, so existing configs,
saved councils, and `--model opus` invocations are unchanged. Only the
no-model-specified path and the picker's preselected entry move to Opus 5.
