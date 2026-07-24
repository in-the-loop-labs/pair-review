---
"@in-the-loop-labs/pair-review": patch
---

Add Opus 5 model variants to the Claude provider: `opus-5-xhigh` and `opus-5-high`
(both pinned to the `claude-opus-5` CLI model, thorough tier). Opus 5 is Anthropic's
newest Opus and is state of the art on coding evaluations.

The default model is unchanged (`opus-4.8-xhigh`, still aliased by `opus`) and no
existing models were removed — the Opus 4.8 entries simply no longer describe
themselves as the newest/latest Claude models.
