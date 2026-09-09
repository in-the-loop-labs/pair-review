---
"@in-the-loop-labs/pair-review": minor
---

Add a model picker to the chat panel, fed by the same per-provider model catalog used for AI review analysis (`providers.<id>.models` and `disabled_models` apply; `default_model` is the analysis default and does not move the chat picker — set `chat_providers.<id>.model` for that). The model is chosen before the first message; picking a different model on a conversation that already has messages opens a new tab after a one-time "Start a new conversation?" dialog with a "Don't ask again" checkbox — pair-review does not switch models mid-conversation, by design.

The last model you pick for a chat provider is remembered in that browser (`localStorage`, one key per provider, not per review) and seeds the model of every new conversation on that provider — including the tab opened by a provider switch. Picking "Provider default" is remembered too (it clears the key). A remembered model that is no longer in the provider's catalog is discarded silently, and restored, resumed or server-resolved models never overwrite the preference — only an explicit pick does.

New `chat_providers.<id>.models_from` config key selects which review provider's catalog backs a chat provider's picker (built-in mapping: `copilot-acp`->`copilot`, `opencode-acp`->`opencode`, `cursor-acp`->`cursor-agent`, others use their own id; config-defined providers fall back to `type`).

`chat.started` and `chat.resumed` hook payloads gain a `cli_model` field (the exact model string handed to the CLI). Note: `model` in those payloads now carries the canonical catalog id rather than the raw selector whenever the selector matches a catalog entry — including when `chat_providers.<id>.model` names a model by alias. Hook scripts comparing against a raw CLI model string should switch to `cli_model`.

Model catalog entries gain `supports_chat` (default `true`). Pi's analysis-only `multi-model` and `review-roulette` pseudo-models set it to `false`, so they no longer appear in the chat picker or inject their review-skill arguments into a conversation. Catalog rows that mean "provider default" (no CLI model, flags, or env — Pi's and OMP's `default` entries) are also hidden from the chat picker, which already offers its own "Provider default" row.

Fixed: a partial `providers.<id>.models` override (e.g. renaming `opus-5-high`) no longer strips `cli_model`, `extra_args`, and `env` from a chat session — chat now resolves those fields against the built-in definition and the override separately, exactly as analysis does. `chat_providers.claude.args` / `extra_args` are now actually passed to the Claude chat CLI (they were silently dropped), appended after the generated flags as they are for `pi` and `omp`. The chat session create/resume responses and the session list now carry the canonical `model` id.
