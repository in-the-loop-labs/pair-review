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
- `muse-provider.js` - Meta Muse Code CLI (`muse`) models

Each provider file has a `*_MODELS` array at the top defining models with:
- `id`: The CLI model identifier (passed to `--model` flag)
- `name`: Display name in the UI
- `tier`: One of `fast`, `balanced`, `thorough` (or `free`, `premium`)
- `tagline`, `description`, `badge`, `badgeClass`: UI metadata
- `default: true`: Marks the default model for the provider

## Step-by-Step Process

### 1. Check CLI Overrides

Read `~/.pair-review/config.json` to see if any provider commands are overridden.
Look at `providers.<id>.command` for each provider.

### 2. Check CLI Availability

For each provider, run:
```
<cli> --version
```
Using the command from config if overridden. Skip providers whose CLI is not installed.

### 3. List Available Models

Each CLI has different model listing commands:
- **Antigravity**: `agy models` — lists the available Antigravity models (e.g. `gemini-3.1-pro-low`, `gemini-3.1-pro-high`, `gemini-3.5-flash-low`, `gemini-3.5-flash-high`)
- **Codex**: No `--list-models` flag. Check docs at developers.openai.com/codex/models/ or use web search
- **Copilot**: No native list command. Use `copilot -p 'list available models'` (non-interactive) or check docs.github.com/en/copilot/reference/ai-models/supported-models
- **Cursor Agent**: `agent --list-models` — works great, comprehensive output
- **OpenCode**: `opencode models` — lists all models in `provider/model-id` format (shows bundled + provider models)
- **Claude**: `claude --help` or check docs at code.claude.com/docs/en/cli-reference
- **Pi**: `pi --list-models` — shows comprehensive table with provider, model, context, max-out, thinking, images columns.
- **Muse**: No `models list` subcommand — and no models subcommand at all. Do not run
  `muse models`: with no matching subcommand, muse treats `models` as a prompt and tries to
  launch the interactive TUI. Read the locally cached catalog instead, which is the
  authoritative source (the CLI fetches it from Meta's provider API and writes it after
  login, so it only exists once `muse login` has run):
  ```
  cat ~/.local/share/muse/model-catalog/*.json
  ```
  Each file is JSON with a `rows` array; the fields that matter are `model_id` (the value for
  `--model`), `display_label`, `is_default`, `context_limit`, and `cost`. Only the underlying
  CLI model ids appear here — as of 2026-08-07 just `muse-spark-1.2` and
  `muse-spark-1.2-contributor` — not pair-review's reasoning-effort variants (see the note
  below).

  To confirm a specific id is still valid, pass it with the prompt as a **positional
  argument**; an unknown id fails fast with exit 1 and ``model `X` is not in the catalog``:
  ```
  muse exec --model <ID> "hi"
  ```
  Do **not** probe with `--prompt-file /dev/null`. Muse validates the prompt file before the
  model, so that form always dies on `--prompt-file /dev/null is not a regular file` and tells
  you nothing about the id — a bogus id and a valid one produce the identical error.

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
- Latest benchmark results (SWE-bench Verified, etc.)
- Model release announcements
- Pricing changes

### 5. Update the Provider Files

For each provider, update:
1. The `*_MODELS` array with new/changed model definitions
2. The constructor default parameter (should match the model with `default: true`)
3. The `getDefaultModel()` static method return value
4. The JSDoc comments describing the models
5. Keep the tier structure: fast, balanced (default), thorough

### 6. Verify Changes

After updating, run the test suite to ensure no regressions:
```
npm test
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

## Notes

- OpenCode has no built-in models. Its models are configured entirely via
  `~/.pair-review/config.json` under `providers.opencode.models`
- Pi also relies on config for models. Its built-in "models" are actually analysis
  modes (default, multi-model, review-roulette) rather than specific models
- Copilot CLI may have limited model availability depending on subscription tier
- Some CLIs may need authentication before they can list models or respond to queries
- Run `agy models` to see which Antigravity models are currently available; the list can change as new models roll out
- Muse's built-in model ids are **not** raw CLI model ids. Each one pairs an underlying CLI
  model (`muse-spark-1.2` or `muse-spark-1.2-contributor`) with a `--reasoning-effort` level
  (`none|minimal|low|medium|high|xhigh|ultra`), so several app-level ids map onto the same CLI
  model. When updating, check whether the underlying model list changed *and* whether the effort
  levels still make sense for each tier
- The `muse-spark-1.2-contributor` model is much cheaper because Meta may use its content for
  product improvement. **Keep the default on a non-contributor model** so opting into data
  sharing stays an explicit user choice; do not promote a `-contributor` id to default.
  Note that the cached catalog marks `muse-spark-1.2-contributor` with `is_default: true` —
  that is muse's own default, and pair-review overrides it on purpose. Do not copy the
  catalog's `is_default` across when refreshing the model list
