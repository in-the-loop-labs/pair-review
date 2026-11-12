---
"@in-the-loop-labs/pair-review": minor
---

Add Claude Fable 5.2, Sonnet 5.5, and Haiku 5.5 models

- Fable 5.2 (`fable-5.2-xhigh`, `fable-5.2-high`) joins the thorough tier. The bare
  `fable` alias now resolves to Fable 5.2 High (was Fable 5.1 XHigh), so any config,
  council, `--model`, or saved default that names `fable` moves to the new generation
  at High effort. To keep the previous behavior, name `fable-5.1-xhigh` explicitly, or
  `fable-5.2-xhigh` for the new generation at XHigh.
- The bare `opus` alias now resolves to Opus 5.5 High (was Opus 5.5 XHigh), the same
  effort as the default. Configs and councils that name `opus` now run at High effort;
  name `opus-5.5-xhigh` explicitly to keep XHigh. Fable 5.2 costs less
  than Fable 5.1 ($8/$40 vs $10/$50 per million tokens) but twice Opus 5.5, so the
  default stays `opus-5.5-high`.
- Sonnet 5.5 (`sonnet-5.5-xhigh`, `sonnet-5.5-high`) leads the balanced tier, at the
  same price as Sonnet 5. Sonnet 5 stays available by its explicit ids.
- Haiku 5.5 (`haiku-5.5-medium`) leads the fast tier, so JSON extraction and hunk
  summaries now run on Haiku 5.5 unless `summaries.model` names another model. It is
  about a tenth of Haiku 4.5's per-token price for prompts up to 100K tokens. `haiku` stays
  pinned to Haiku 4.5.

Requires a Claude Code CLI that recognizes the new model IDs (v2.1.321 or later for
Fable 5.2). Use a per-model `cli_model` override if you need a different ID.
