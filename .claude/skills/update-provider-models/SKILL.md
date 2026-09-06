# Update Provider Models

Update the built-in model configurations for pair-review's AI providers. This skill
guides you through checking each provider's CLI for available models, gathering
recommendations, and updating the source code.

## When to Use

Run this skill periodically (e.g., monthly) or when new model releases are announced
for any of the supported AI providers. Skip providers that were recently updated.

## Providers to Update

The providers are defined in `src/ai/` with these files:
- `antigravity-provider.js` - Antigravity CLI (`agy`) models
- `codex-provider.js` - OpenAI Codex CLI models
- `copilot-provider.js` - GitHub Copilot CLI models
- `cursor-agent-provider.js` - Cursor Agent CLI models
- `opencode-provider.js` - OpenCode CLI (no built-in models, config-only)
- `claude-provider.js` - Anthropic Claude CLI models
- `pi-provider.js` - Pi coding agent models
- `omp-provider.js` - OMP / Oh My Pi CLI (`omp`, a Pi fork; only a `default` mode built in, real models are config-only)
- `muse-provider.js` - Meta Muse Code CLI (`muse`) models

Each provider file has a `*_MODELS` array at the top defining models with:
- `id`: The CLI model identifier (passed to `--model` flag)
- `name`: Display name in the UI
- `tier`: One of `fast`, `balanced`, `thorough` (or `free`, `premium`)
- `tagline`, `description`, `badge`, `badgeClass`: UI metadata
- `default: true`: Marks the default model for the provider
- `aliases`: Optional extra ids that resolve to this entry (used to keep saved
  councils/configs working when an id is renamed)

## Ground Rules for Probing

- **Never trust a CLI's own model listing over a live probe.** Installed binaries lag
  the backend: on 2026-09-06 `agy models` (agy 1.0.16) did not list Gemini 3.8 Flash,
  and Muse's cached catalog did not list Spark 1.3, yet both ids ran fine. Conversely,
  ids a provider file still carries may be dead (gpt-5.4, gemini-3.5-flash). Probe every
  id you keep AND every id you add.
- **macOS has no `timeout`.** Wrap probes with perl instead:
  ```
  perl -e 'alarm 120; exec @ARGV' <cli> <args...>
  ```
- Run probes from the scratchpad directory (some CLIs treat cwd as a workspace) and
  run slow batches with `run_in_background`.
- Do not print `~/.pair-review/config.json` wholesale — it holds tokens. Grep only the
  `command` lines you need.

## Step-by-Step Process

### 1. Check CLI Overrides

Look at `providers.<id>.command` in `~/.pair-review/config.json` for each provider
(grep for `"command"`; do not dump the file).

### 2. Check CLI Availability

For each provider, run:
```
<cli> --version
```
Using the command from config if overridden. Skip providers whose CLI is not installed.
If a CLI is missing or clearly stale, tell the user which one and let them install or
update it rather than self-updating (`agy update`, `codex update`, muse's launcher
script auto-updates hourly).

### 3. List Available Models

Each CLI has different model listing commands:
- **Antigravity**: `agy models` lists what the *installed binary* knows (e.g.
  `Gemini 3.8 Flash (High)`, `Gemini 3.1 Pro (Low)`), which can be behind the backend.
  `agy changelog` shows the newest released CLI versions, so compare it against
  `agy --version` to spot a stale install. Probe an id directly:
  ```
  agy -p 'Reply with your exact model name and nothing else' --model <id> --dangerously-skip-permissions --print-timeout 2m
  ```
  A valid id answers with the model name and exits 0. An unknown id exits 1 and prints
  the available-model listing (agy no longer falls back to its default silently). The
  provider's clean ids (`gemini-3.8-flash-low`) work as `--model` values too.
- **Codex**: No `--list-models` flag, but the CLI caches the backend catalog at
  `~/.codex/models_cache.json` (`models[]` with `slug`, `display_name`, `description`,
  `visibility` (`list`/`hide`), `supported_reasoning_levels[].effort`,
  `default_reasoning_level`, `context_window`; top-level `fetched_at`, `client_version`).
  That file is the best local source of new slugs. Confirm with a probe:
  ```
  codex exec -m <slug> -c model_reasoning_effort=low --skip-git-repo-check 'Reply with the single word OK'
  ```
  A retired slug fails with a 400 `The '<slug>' model is not supported when using Codex
  with a ChatGPT account`; a valid one prints OK. Pricing is not in the cache — use web
  search (learn.chatgpt.com/docs/models, learn.chatgpt.com/docs/changelog).
- **Copilot**: No native list command. Use `copilot -p 'list available models'` (non-interactive) or check docs.github.com/en/copilot/reference/ai-models/supported-models
- **Cursor Agent**: `agent --list-models` — works great, comprehensive output
- **OpenCode**: `opencode models` — lists all models in `provider/model-id` format (shows bundled + provider models)
- **Claude**: `claude --help` or check docs at code.claude.com/docs/en/cli-reference
- **Pi**: `pi --list-models` — shows comprehensive table with provider, model, context, max-out, thinking, images columns.
- **OMP**: `omp models` (or `omp models --json`) — lists the catalog grouped by provider with context, max-out, thinking, images columns. `omp models find <substring>` searches; `omp models refresh` forces a fresh catalog fetch.
- **Muse**: No `models list` subcommand — and no models subcommand at all. Do not run
  `muse models`: with no matching subcommand, muse treats `models` as a prompt and tries to
  launch the interactive TUI. The locally cached catalog is a starting point but is
  **not authoritative** — it is only refreshed by the launcher on login and can lag a
  release by weeks (it still listed only 1.2 after 1.3 shipped):
  ```
  cat ~/.local/share/muse/model-catalog/*.json
  ```
  Each file is JSON with a `rows` array; the fields that matter are `model_id` (the value for
  `--model`), `display_label`, `is_default`, `context_limit`, and `cost`. Only the underlying
  CLI model ids appear here (`muse-spark-1.3`, `muse-spark-1.3-contributor`, older
  `muse-spark-1.2*`) — not pair-review's reasoning-effort variants (see the note below).

  To confirm a specific id is valid, pass it with the prompt as a **positional
  argument** and an explicit, supported effort. An unknown id fails fast with exit 1 and
  ``model `X` does not exist or you lack access``:
  ```
  muse exec --model <ID> --reasoning-effort low "Reply with the single word OK"
  ```
  Do **not** pass `--reasoning-effort none` — the meta provider rejects it with exit 2
  and a usage dump, which looks like a bad model id but is not. Do **not** probe with
  `--prompt-file /dev/null` either: muse validates the prompt file before the model, so
  that form always dies on `--prompt-file /dev/null is not a regular file` and tells you
  nothing about the id.

  Also probe the effort levels you intend to ship. On 2026-09-06 `max` ran normally,
  while `ultra` printed `reasoning effort ultra is not available (gate
  ultra_reasoning_effort is closed); using xhigh` and silently ran at xhigh — an
  `-ultra` built-in would be a disguised `-xhigh`.

### 4. Get Model Recommendations for Code Review

For CLIs that are authenticated, ask them directly:
```
<cli> -p 'Given these available models: [list], recommend the best for each code review tier:
1. FAST: Quick surface-level review (cheap, fast)
2. BALANCED: Standard PR review (quality/cost ratio)
3. THOROUGH: Deep architectural review (most capable)
Recommend 1 model per tier and explain WHY for code review specifically.'
```

Also use web search to check:
- Latest benchmark results (DeepSWE v1.1 and Terminal-Bench are what vendors now publish; SWE-bench Verified is rarely reported)
- Model release announcements
- Pricing changes and retirement dates (Codex's changelog lists retirements per sign-in type)

### 5. Update the Provider Files

For each provider, update:
1. The `*_MODELS` array with new/changed model definitions
2. The constructor default parameter (should match the model with `default: true`)
3. The `getDefaultModel()` static method return value
4. The JSDoc comments describing the models
5. Keep the tier structure: fast, balanced (default), thorough — every tier must keep at
   least one live entry after removals
6. Retired ids: remove the entry and list it in the JSDoc "Deprecated" line. Add an
   `aliases` entry pointing at a successor only when the successor is the same model
   line at the same price and effort (e.g. `gemini-3.5-flash-low` → `gemini-3.8-flash-low`,
   `muse-spark-1.2-high` → `muse-spark-1.3-high`); never alias a dead id onto a
   different model family, an explicit unknown-model error is better than a silent swap.
   For a same-line point release the provider decides: Claude (and other high-attention
   providers) keeps the previous generation as explicit entries, because users hold
   strong opinions between point releases and a saved council must keep the generation
   it was written against; lightly used providers such as Muse may replace the entries
   and alias the old ids onto the new generation in place
7. Sweep every other place that lists built-in ids: `config.example.json` `_comment`
   strings, the README provider tables, `src/main.js` `--model` help text, and the unit
   tests (`tests/unit/<provider>-provider.test.js`, `llm-extraction.test.js`,
   `shared.test.js`, `provider-model.test.js`, `stack-analysis-provider-model.test.js`)
8. Add a changeset under `.changeset/` per provider touched, bump level `patch` — adding, retiring, or re-tiering built-in models has always shipped as a patch (Opus 5, GPT-5.6, Fable 5.1 all did); reserve `minor` for a new provider

### 6. Verify Changes

After updating, run the test suite to ensure no regressions:
```
pnpm test
```

Leave changes uncommitted for the user to review.

## Model Tier Guidelines

- **fast**: Cheapest/fastest option. Good enough for lint-level issues, typos, obvious bugs.
  Examples: haiku, flash, mini variants
- **balanced**: Best quality-to-cost ratio. Default for most reviews. Should handle
  standard PR review well.
  Examples: sonnet, pro, standard codex variants
- **thorough**: Most capable regardless of cost. For deep architectural analysis,
  security review, complex multi-file changes.
  Examples: opus, pro-preview, codex-high/max variants

A new flagship does not automatically become the default. If it costs several times
the current default (GPT-6 Astra at $10/$50 vs Sol), add it to thorough and keep the
default where it is.

## Notes

- OpenCode has no built-in models. Its models are configured entirely via
  `~/.pair-review/config.json` under `providers.opencode.models`
- Pi also relies on config for models. Its built-in "models" are actually analysis
  modes (default, multi-model, review-roulette) rather than specific models
- Copilot CLI may have limited model availability depending on subscription tier
- Some CLIs may need authentication before they can list models or respond to queries
- Antigravity only ships Gemini models in the built-in picker; agy also exposes Claude
  and GPT-OSS models, reachable via config override only. The Pro line is still 3.1 Pro
  (no newer Pro exists on agy as of 2026-09-06)
- Codex retires models per sign-in type: a slug can be dead for ChatGPT accounts while
  still documented for API keys. Probe with the account the user actually uses
- Muse's built-in model ids are **not** raw CLI model ids. Each one pairs an underlying CLI
  model (`muse-spark-1.3` or `muse-spark-1.3-contributor`) with a `--reasoning-effort` level
  (`minimal|low|medium|high|xhigh|max|ultra`; `none` is rejected by the meta provider and
  `ultra` is gated, see step 3), so several app-level ids map onto the same CLI
  model. When updating, check whether the underlying model list changed *and* whether the effort
  levels still make sense for each tier
- The `muse-spark-*-contributor` models are much cheaper because Meta may use their content for
  product improvement. **Keep the default on a non-contributor model** so opting into data
  sharing stays an explicit user choice; do not promote a `-contributor` id to default.
  Note that the cached catalog marks the `-contributor` model with `is_default: true` —
  that is muse's own default, and pair-review overrides it on purpose. Do not copy the
  catalog's `is_default` across when refreshing the model list
