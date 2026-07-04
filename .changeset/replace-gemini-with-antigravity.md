---
"@in-the-loop-labs/pair-review": major
---

Remove Gemini provider support; add Antigravity (`agy`) provider.

The Gemini analysis provider has been removed and replaced by **Antigravity**, the official successor to the Gemini CLI. Antigravity runs as a real agentic reviewer in non-interactive print mode (reading files and running read-only git/shell commands) and is exposed as the `antigravity` provider, backed by the `agy` CLI binary.

- Install the Antigravity CLI with `curl -fsSL https://antigravity.google/cli/install.sh | bash` (macOS/Linux; it is not an npm package). See https://antigravity.google/docs.
- The custom-command env var is now `PAIR_REVIEW_ANTIGRAVITY_CMD` (replaces `PAIR_REVIEW_GEMINI_CMD`).
- Built-in models: `gemini-3.5-flash-low`, `gemini-3.5-flash-high`, `gemini-3.1-pro-low` (default), `gemini-3.1-pro-high`. Run `agy models` to list what's available.

**Breaking change.** If your config set `default_provider: 'gemini'` (or otherwise selected the `gemini` provider), switch it to `antigravity` — the `gemini` provider no longer exists. Antigravity has **no ACP mode**, so the `gemini-acp` chat provider has been removed with **no replacement**: Antigravity is an analysis-only provider. Remove any `gemini-acp` entry from your `chat_providers` config and pick a different chat provider (`pi`, `claude`, `codex`, `copilot-acp`, `opencode-acp`, or `cursor-acp`).
