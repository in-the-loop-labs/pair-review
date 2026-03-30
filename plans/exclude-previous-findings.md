# Exclude Previous Findings from Analysis

## Context

When running multiple analysis iterations on the same PR or local changes, results frequently duplicate issues already identified in:
- GitHub PR inline review comments
- Existing pair-review AI suggestions from prior runs
- User comments in pair-review (often adopted from AI suggestions)

This plan adds a configurable deduplication feature that lets the orchestration/consolidation agent itself fetch previous findings and exclude matches — no new pipeline step. The agent already merges and deduplicates suggestions; this extends that responsibility to include previously-known issues.

## Approach

The orchestration/consolidation prompt gains a conditional section with instructions to fetch previous findings (via `gh` and `curl`) and exclude matches. The agent does the fetch, comparison, and filtering as part of its existing consolidation work. If the agent has zero suggestions after merging, it skips the fetch entirely.

Provider tool permissions are updated to allow `gh` and `curl` alongside the existing read-only tools.

**Out of scope**: code-critic:analyze skill integration (future follow-up).

## Hazards

- Three orchestration/consolidation prompt sites: `buildOrchestrationPrompt()`, `_crossVoiceConsolidate()`, `_intraLevelConsolidate()`. All three must receive the dedup context when enabled.
- The consolidation prompt templates exist in 3 tiers × 2 types (orchestration + consolidation) = 6 files. All need the new optional section.
- `gh` requires auth (`GH_TOKEN` env or `gh auth`). Providers that restrict env vars (Codex) need `GH_TOKEN` added to their allowlist.
- Providers without fine-grained tool control (Cursor Agent, OpenCode) already allow arbitrary shell — no change needed, but dedup quality depends on the model following prompt instructions.
- Executable providers are non-agentic (one-shot external tool) — dedup is not applicable there. Skip silently.
- The `GET /api/reviews/:reviewId/suggestions` endpoint only returns the latest run. We need all runs for dedup — requires a new query param or endpoint.

## Implementation

### 1. UI: Collapsible "Exclude Previous Findings" section

**File**: `public/js/components/AnalysisConfigModal.js`

Add a collapsible `<details>` section between "Analysis Levels" (line ~276) and "Focus Presets" (line ~278):

```html
<details class="config-section exclude-previous-section">
  <summary class="section-title">
    Exclude Previous Findings
    <span class="section-hint">(optional)</span>
  </summary>
  <div class="exclude-previous-options">
    <label class="remember-toggle">
      <input type="checkbox" id="exclude-github-comments" />
      <span class="toggle-switch"></span>
      <span class="toggle-label">GitHub PR review comments</span>
    </label>
    <p class="option-hint">Skip issues already noted in inline PR review comments</p>
    <label class="remember-toggle">
      <input type="checkbox" id="exclude-pr-feedback" />
      <span class="toggle-switch"></span>
      <span class="toggle-label">Existing pair-review feedback</span>
    </label>
    <p class="option-hint">Skip issues from previous AI suggestions and reviewer comments</p>
  </div>
</details>
```

- GitHub checkbox **disabled** when no PR is associated or no GitHub token configured.
- Both default **unchecked**.
- **Global** localStorage key: `pair-review-exclude-previous` → `{ github: bool, feedback: bool }`.
- Restore on modal open, save on submit.

**File**: `public/css/analysis-config.css` — Styles for the `<details>` collapse and hint text.

### 2. Frontend: Pass options through to API

**Files**: `public/js/pr.js`, `public/js/local.js`, `public/js/components/AnalysisConfigModal.js`

- `handleSubmit()` adds `excludePrevious: { github, feedback }` to the config object.
- `startAnalysis()` / `startLocalAnalysis()` include `excludePrevious` in the POST body.
- Both single-model and council submit paths include the field.

### 3. API: Accept and forward options

**Files**: `src/routes/pr.js`, `src/routes/local.js`, `src/routes/analyses.js`

- Extract `excludePrevious` from request body in all 4 analysis endpoints (single + council × PR + local).
- Thread through to `analyzer.analyzeAllLevels()` via `options.excludePrevious`.
- Thread through to `launchCouncilAnalysis()` → `runReviewerCentricCouncil()` / `runCouncilAnalysis()` via options.
- Also pass `reviewId` and `serverPort` (from config) so the prompt can construct curl URLs.

**File**: `src/routes/mcp.js` — Add `excludePrevious` parameter to `start_analysis` tool schema.

### 4. REST API: Add `allRuns` query param to suggestions endpoint

**File**: `src/routes/reviews.js`

Extend `GET /api/reviews/:reviewId/suggestions`:
- Add `?allRuns=true` query param that removes the "latest run only" filter.
- Add `?includeDismissed=true` query param to include all statuses.
- When both are set, returns all AI suggestions across all runs and statuses — exactly what the dedup agent needs.

The existing `GET /api/reviews/:reviewId/comments?includeDismissed=true` already returns all user comments. No changes needed there.

### 5. Provider tool permissions: Add `gh` and `curl`

| Provider | File | Change |
|----------|------|--------|
| **Claude** | `src/ai/claude-provider.js:157-174` | Add `'Bash(gh *)'`, `'Bash(curl *)'` to `allowedTools` array |
| **Gemini** | `src/ai/gemini-provider.js:122-148` | Add `'run_shell_command(gh)'`, `'run_shell_command(curl)'` to `readOnlyTools` array |
| **Codex** | `src/ai/codex-provider.js:126` | Add `GH_TOKEN` to `shell_environment_policy.include_only` |
| **Copilot** | `src/ai/copilot-provider.js:148-170` | Add `'--allow-tool', 'shell(gh)'`, `'--allow-tool', 'shell(curl)'` |
| **Pi** | `src/ai/pi-provider.js` | No change — `bash` tool already allows arbitrary shell |
| **Cursor Agent** | `src/ai/cursor-agent-provider.js` | No change — no fine-grained tool control |
| **OpenCode** | `src/ai/opencode-provider.js` | No change — no fine-grained tool control |
| **Executable** | `src/ai/executable-provider.js` | N/A — non-agentic, dedup not applicable |

### 6. Orchestration/consolidation prompts: Add dedup section

**New placeholder**: `{{dedupInstructions}}`

**New optional section** in all 6 prompt template files:

**Orchestration templates** (3 tiers):
- `src/ai/prompts/baseline/orchestration/fast.js`
- `src/ai/prompts/baseline/orchestration/balanced.js`
- `src/ai/prompts/baseline/orchestration/thorough.js`

**Consolidation templates** (3 tiers):
- `src/ai/prompts/baseline/consolidation/fast.js`
- `src/ai/prompts/baseline/consolidation/balanced.js`
- `src/ai/prompts/baseline/consolidation/thorough.js`

Section placement: after `custom-instructions`, before `input-suggestions`. The section is optional — when empty, it collapses away.

```
<section name="dedup-instructions" optional="true">
{{dedupInstructions}}
</section>
```

**Prompt content** (populated conditionally by analyzer.js):

```markdown
## Exclude Previously Identified Issues

After consolidating suggestions, check your results against previously identified issues
and remove any that are duplicates or substantially similar. If you have zero suggestions
after consolidation, skip this step entirely.

{if github}
### GitHub PR Review Comments
Fetch inline review comments:
```
gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate
```
Each comment has `path` (file), `line`/`original_line` (line number), and `body` (content).
Exclude any of your suggestions that address the same concern at the same location.
{/if}

{if feedback}
### Existing Pair-Review Feedback
Fetch previous AI suggestions:
```
curl -s http://localhost:{port}/api/reviews/{reviewId}/suggestions?allRuns=true&includeDismissed=true&levels=final
```
Fetch previous user comments:
```
curl -s http://localhost:{port}/api/reviews/{reviewId}/comments?includeDismissed=true
```
Exclude any of your suggestions that address the same concern as these previous findings.
{/if}

Report how many suggestions were excluded in your summary.
```

### 7. Analyzer: Build dedup context and pass to prompts

**File**: `src/ai/analyzer.js`

Add helper method `buildDedupInstructions(excludePrevious, context)`:
- `context` includes: `{ owner, repo, pullNumber, reviewId, serverPort }`
- Returns the formatted dedup instructions string (or empty string if disabled)
- Conditionally includes GitHub and/or pair-review sections based on `excludePrevious` flags

**Integration at 3 prompt-building sites**:

1. `buildOrchestrationPrompt()` (line ~2689): Add `dedupInstructions` to the context object passed to `promptBuilder.build()`.

2. `_crossVoiceConsolidate()` (line ~3819): Add `dedupInstructions` to the context for the consolidation prompt.

3. `_intraLevelConsolidate()` (line ~3649): This is intra-level, NOT the top-level consolidation. **Do not add dedup here** — dedup only applies at the final consolidation step.

Wait — for the level-centric council path (`runCouncilAnalysis`), the flow is:
- Intra-level consolidation (pass 1) → cross-level orchestration (pass 2)
- Pass 2 uses `orchestrateWithAI()` → `buildOrchestrationPrompt()`

So the dedup instructions in `buildOrchestrationPrompt()` cover both the single-model path AND the level-centric council's final step. The reviewer-centric council uses `_crossVoiceConsolidate()`. So the two sites are:

1. `buildOrchestrationPrompt()` — covers single-model + level-centric council final step
2. `_crossVoiceConsolidate()` — covers reviewer-centric council final step

**Threading context**: The `excludePrevious` options and `reviewId`/`serverPort` need to reach these two sites. Pass via options through the existing call chain:
- `analyzeAllLevels(options)` → `orchestrateWithAI(options)` → `buildOrchestrationPrompt(options)`
- `runReviewerCentricCouncil(options)` → `_crossVoiceConsolidate(options)`
- `runCouncilAnalysis(options)` → `orchestrateWithAI(options)` → `buildOrchestrationPrompt(options)`

### 8. Skill prompt regeneration

After modifying prompt templates, run:
```
node scripts/generate-skill-prompts.js
```
to regenerate `plugin-code-critic/skills/analyze/references/orchestration-*.md`.

### 9. Tests

- **Unit tests** for `buildDedupInstructions()`: verify correct output for each combination of flags, verify empty string when disabled.
- **Unit tests** for prompt templates: verify the `dedup-instructions` section appears when populated and collapses when empty.
- **Unit tests** for `GET /api/reviews/:reviewId/suggestions?allRuns=true&includeDismissed=true`: verify returns all runs.
- **Integration tests**: verify `excludePrevious` flows from API request through to the orchestration prompt.
- **E2E tests**: verify checkboxes appear, persist in global localStorage, and the API receives flags.

## Files Modified

| File | Change |
|------|--------|
| `public/js/components/AnalysisConfigModal.js` | Collapsible section, checkboxes, global localStorage |
| `public/css/analysis-config.css` | Styles for collapsed section |
| `public/js/pr.js` | Pass `excludePrevious` in POST body |
| `public/js/local.js` | Pass `excludePrevious` in POST body |
| `src/routes/pr.js` | Extract and forward `excludePrevious` |
| `src/routes/local.js` | Extract and forward `excludePrevious` |
| `src/routes/analyses.js` | Forward `excludePrevious` in `launchCouncilAnalysis()` |
| `src/routes/mcp.js` | Add `excludePrevious` to `start_analysis` schema |
| `src/routes/reviews.js` | Add `allRuns` + `includeDismissed` params to suggestions endpoint |
| `src/ai/claude-provider.js` | Add `gh`, `curl` to allowed tools |
| `src/ai/gemini-provider.js` | Add `gh`, `curl` to allowed tools |
| `src/ai/codex-provider.js` | Add `GH_TOKEN` to env allowlist |
| `src/ai/copilot-provider.js` | Add `gh`, `curl` to allowed tools |
| `src/ai/analyzer.js` | `buildDedupInstructions()`, thread through to prompts |
| `src/ai/prompts/baseline/orchestration/{fast,balanced,thorough}.js` | Add `dedup-instructions` section |
| `src/ai/prompts/baseline/consolidation/{fast,balanced,thorough}.js` | Add `dedup-instructions` section |
| `plugin-code-critic/skills/analyze/references/orchestration-*.md` | Regenerated |
| Tests (unit + integration + E2E) | Coverage for new functionality |

## Verification

1. **Manual test — single model**:
   - Open a PR with existing GitHub review comments in pair-review
   - Check both "Exclude Previous Findings" boxes, run analysis
   - Verify the orchestration agent fetches previous findings (visible in logs)
   - Verify results exclude issues already noted in GitHub comments

2. **Manual test — council**:
   - Same PR, run council analysis with dedup enabled
   - Verify the consolidation agent (not individual reviewers) does the dedup

3. **Manual test — no suggestions**:
   - Run analysis on a trivial PR that produces zero suggestions
   - Verify the agent skips the fetch step (no `gh`/`curl` calls in logs)

4. **Automated tests**:
   - `npm test` — all unit + integration tests pass
   - `npm run test:e2e` — E2E tests pass

5. **localStorage persistence**:
   - Check boxes, close and reopen modal — state persists
   - Switch to a different repo — same state (global, not per-repo)
