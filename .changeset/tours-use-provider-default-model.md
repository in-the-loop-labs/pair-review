---
"@in-the-loop-labs/pair-review": patch
---

Guided tours now use the tour provider's default model instead of its fast-tier model

A tour is an agentic walk through the codebase, so the fast tier was a poor fit.
When neither `tours.model` nor `summaries.model` is set, tour generation now uses the
tour provider's built-in default model (for Claude, `opus-5.5-high` instead of
`haiku`). This applies to every provider with a built-in default: Claude, Codex,
Antigravity, Copilot, Cursor Agent, Muse, Pi, and OMP. For Pi and OMP this is their
`default` mode, which uses your Pi or OMP configuration, even when Pi or OMP is the
global `default_provider` and a different `default_model` is set. OpenCode has no
built-in default and still falls back to the global `default_model`.

The provider default is used even when the tour provider is the global
`default_provider`, so an existing config's saved `default_model` does not decide
the tour model. The lookup reads the provider's built-in model list, so
`providers.<id>.default_model` does not change it; set `tours.model` to pick a
specific model. For Claude, `opus-5.5-high` needs a Claude Code CLI that knows
`claude-opus-5-5` (2.1.280 or later); on an older CLI, tours fail until you update
the CLI or set `tours.model`. Hunk summaries are unchanged and still use the fast tier.

Tours are off by default. If you enabled them, `tours.auto_generate` is on by
default, so each review load now runs a tour on the default model, which costs
more and takes longer than the fast tier did.
