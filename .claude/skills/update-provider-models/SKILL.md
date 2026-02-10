# Update Provider Models

Update the built-in model configurations for pair-review's AI providers. This skill
guides you through checking each provider's CLI for available models, gathering
recommendations, and updating the source code.

## When to Use

Run this skill periodically (e.g., monthly) or when new model releases are announced
for any of the supported AI providers. Skip providers that were recently updated.

## Providers to Update

The providers are defined in `src/ai/` with these files:
- `gemini-provider.js` - Google Gemini CLI models
- `codex-provider.js` - OpenAI Codex CLI models
- `copilot-provider.js` - GitHub Copilot CLI models
- `cursor-agent-provider.js` - Cursor Agent CLI models
- `opencode-provider.js` - OpenCode CLI (no built-in models, config-only)
- `claude-provider.js` - Anthropic Claude CLI models
- `pi-provider.js` - Pi coding agent models

Each provider file has a `*_MODELS` array at the top defining models with:
- `id`: The CLI model identifier (passed to `--model` flag)
- `name`: Display name in the UI
- `tier`: One of `fast`, `balanced`, `thorough` (or `free`, `premium`)
- `tagline`, `description`, `badge`, `badgeClass`: UI metadata
- `default: true`: Marks the default model for the provider

## Step-by-Step Process

### 1. Check CLI Overrides

Read `~/.pair-review/config.json` to see if any provider commands are overridden.
Look at `providers.<id>.command` for each provider. Common pattern: `devx <cli> --`.

### 2. Check CLI Availability

For each provider, run:
```
<cli> --version
```
Using the command from config if overridden. Skip providers whose CLI is not installed.

### 3. List Available Models

Each CLI has different model listing commands:
- **Gemini**: No list command; use web search or ask Gemini in text mode: `gemini -m gemini-2.5-flash -o text 'What models are available?'`
- **Codex**: Check docs at developers.openai.com/codex/models/ or use web search
- **Copilot**: Run `/model` in interactive mode, or check github.com/github/copilot-cli/releases
- **Cursor Agent**: `agent --list-models` or `agent models`
- **OpenCode**: `opencode models` (only shows bundled free models; provider models come from config)
- **Claude**: `claude --help` or check docs at code.claude.com/docs/en/cli-reference
- **Pi**: `pi --list-models`

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
- Check the Gemini CLI `/settings` for preview features that unlock newer models
