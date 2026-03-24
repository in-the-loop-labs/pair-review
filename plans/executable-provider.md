# Plan: Executable Provider for pair-review

## Context

External code review tools produce high-quality results with their own analysis pipelines. pair-review has a great UI for exploring review results. We want to display external tool results in pair-review by running any CLI-based review tool as a black-box provider.

This is Step 1 of a larger integration. MVP scope: single-provider local analysis only (no council integration). All tool-specific knowledge lives in configuration, not code.

## Changes Summary

All changes are in the **pair-review** repo (`~/src/github.com/in-the-loop-labs/pair-review`).

| Change | Files |
|--------|-------|
| New executable provider class | `src/ai/executable-provider.js` (new) |
| Provider registration | `src/ai/provider.js`, `src/ai/index.js` |
| Analysis route for executable providers | `src/routes/local.js` |
| Reject executable providers for PR mode | `src/routes/pr.js` |
| Mapping prompt | `src/ai/prompts/executable-mapping.js` (new) |
| DB migration: add severity column | `src/database.js` |
| UI: severity badges + hide levels for no-level providers | `public/js/modules/suggestion-manager.js`, `public/js/components/AnalysisConfigModal.js`, `public/css/` |
| Config example | `config.example.json` |
| Tests | `tests/unit/executable-provider.test.js` (new) |

---

## 1. Config Format

```json
{
  "providers": {
    "my-review-tool": {
      "type": "executable",
      "command": "my-review-tool",
      "args": ["analyze"],
      "name": "My Review Tool",
      "local_only": true,
      "supports_levels": false,
      "context_args": {
        "title": "--title",
        "description": "--description",
        "output_dir": "--output-dir"
      },
      "output_glob": "**/results.json",
      "mapping_instructions": "This tool outputs JSON with a 'comments' array and a 'summary' string. Each comment has: type (bug/security/performance), severity (critical/medium/minor), title, description, suggestion, file_path, line_start, line_end. Map file_path to file. Map description to description. Map suggestion to suggestion. The tool's severity field maps directly. Map confidence based on severity: critical=0.95, medium=0.75, minor=0.4.",
      "env": {},
      "installInstructions": "Requires my-review-tool to be installed and on PATH",
      "models": [
        { "id": "default", "name": "Default", "tier": "thorough", "default": true }
      ]
    }
  }
}
```

Key config fields:
- **`context_args`** — maps context keys to CLI flags. Provider assembles args from review metadata.
- **`output_glob`** — glob pattern to find the result file in the output directory.
- **`mapping_instructions`** — appended to generic mapping prompt. This is where tool-specific field mapping knowledge lives.

---

## 2. New File: `src/ai/executable-provider.js`

Follow the ACP PR #334 factory pattern: `createExecutableProviderClass(id, config)` returns a dynamic `AIProvider` subclass.

### `ExecutableProvider` class

```
constructor(model, configOverrides)
  - Stores: command, args, contextArgs, outputGlob, mappingInstructions, localOnly, supportsLevels
  - Command precedence: PAIR_REVIEW_{ID}_CMD env var > config.command > id
  - Shell mode if command contains spaces

async execute(prompt, options)
  - prompt is unused (tool has its own prompts)
  - options.executableContext: { title, description, outputDir, cwd }
  1. Build CLI args: config.args + context_args mapped from executableContext
  2. Spawn process with spawn(), register for cancellation
  3. Emit streaming event: "Running external tool..."
  4. Wait for process completion (with timeout)
  5. Find result file via output_glob in outputDir
  6. Read raw JSON
  7. Call mapOutputToSchema(rawJson)
  8. Return { suggestions, summary, parsed: true }

async mapOutputToSchema(rawOutput)
  1. Build mapping prompt: generic template + mapping_instructions + rawOutput
  2. Get user's default provider via getDefaultProvider()
  3. Spawn that provider's CLI with the mapping prompt (reuse extractJSONWithLLM pattern)
  4. Parse the LLM response with extractJSON()
  5. Return mapped suggestions

async testAvailability()
  - Run `which {command}` or `{command} --help` with 10s timeout
  - Return boolean

static getProviderName/Id/Models/DefaultModel/InstallInstructions
  - Return values from factory closure (same pattern as ACP)

static isExecutable = true
static localOnly = config.local_only
static supportsLevels = config.supports_levels
```

### Argument Assembly

Given `context_args: { "title": "--title", "output_dir": "--output-dir" }` and context `{ title: "Fix auth", outputDir: "/tmp/xxx" }`:

Result: `my-review-tool analyze --title "Fix auth" --output-dir /tmp/xxx`

Keys in `context_args` map to keys in `executableContext`. Only args with non-null context values are included.

---

## 3. Provider Registration

### `src/ai/provider.js` — `applyConfigOverrides()`

Add executable provider detection alongside the existing config override loop:

```javascript
if (providerConfig.type === 'executable') {
  if (!providerConfig.command) {
    logger.warn(`Executable provider "${providerId}" missing required "command" field`);
    continue;
  }
  const ExecClass = getCreateExecutableProviderClass()(providerId, providerConfig);
  registerProvider(providerId, ExecClass);
  providerConfigOverrides.set(providerId, { ...providerConfig, models: ExecClass.getModels() });
  continue;
}
```

Use lazy-require to avoid circular dependency (same pattern as ACP).

### `src/ai/provider.js` — `getAllProvidersInfo()`

Add `localOnly` and `supportsLevels` to the provider info response:

```javascript
localOnly: ProviderClass.localOnly || false,
supportsLevels: ProviderClass.supportsLevels !== false,
```

### `src/ai/index.js`

Add `require('./executable-provider')` and export `createExecutableProviderClass`.

---

## 4. Analysis Route: Local Mode

### `src/routes/local.js`

In the analysis trigger endpoint, detect executable providers and branch:

```javascript
const ProviderClass = getProviderClass(selectedProvider);
if (ProviderClass?.isExecutable) {
  return handleExecutableAnalysis(req, res, { reviewId, review, provider: selectedProvider, ... });
}
// ... existing 3-level flow
```

### `handleExecutableAnalysis()` flow:

1. Create analysis run record (`status: 'running'`, `levels_config: null`)
2. Create temp output directory
3. Build `executableContext` from review metadata:
   - `title`: from review's PR title or local branch name
   - `description`: from review's PR body or commit messages
   - `outputDir`: temp directory
   - `cwd`: review's worktree/local path
4. Create provider instance, call `execute(null, { executableContext, cwd, timeout, analysisId, ... })`
5. Store mapped suggestions via `bulkInsertAISuggestions(reviewId, runId, suggestions, null)`
6. Update run to `completed` with summary and suggestion count
7. Broadcast completion via WebSocket
8. Clean up temp directory in `finally` block

### `src/routes/pr.js`

Reject executable providers that are `local_only`:

```javascript
if (ProviderClass?.isExecutable && ProviderClass.localOnly) {
  return res.status(400).json({ error: `Provider "${selectedProvider}" only available for local reviews` });
}
```

---

## 5. Mapping Prompt

### New file: `src/ai/prompts/executable-mapping.js`

```
You are mapping the output of an external code review tool to a standardized JSON format.

Map the tool's output to this exact JSON schema:
{
  "suggestions": [{
    "file": "path/to/file",
    "line_start": 42,
    "line_end": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|security|performance|...",
    "severity": "critical|medium|minor",
    "title": "Brief title",
    "description": "Detailed explanation",
    "suggestion": "Fix guidance (omit for praise)",
    "confidence": 0.85,
    "is_file_level": false
  }],
  "summary": "Overall assessment"
}

Rules:
- Map each review finding to one suggestion object
- Use "NEW" for old_or_new (external tools review the new version)
- Preserve severity if the tool provides it
- Set is_file_level: true and line_start/line_end to null for findings without line numbers
- Output ONLY valid JSON, no markdown or explanation

{mapping_instructions}

--- RAW TOOL OUTPUT ---
{raw_output}
```

The `{mapping_instructions}` placeholder is replaced with the config-provided instructions, which contain tool-specific field mapping knowledge.

---

## 6. Database Migration

### `src/database.js`

**Increment version:** 33 → 34

**Migration 34:**
```javascript
addColumnIfNotExists('comments', 'severity', 'TEXT');
```

**Update schema DDL:** Add `severity TEXT` to comments table definition.

**Update `bulkInsertAISuggestions()`:** Add `severity` to INSERT columns, extract `suggestion.severity ?? null`.

**Update `getCommentsByReviewId()` and suggestion query:** Include `severity` in SELECT.

---

## 7. UI Changes

### `public/js/components/AnalysisConfigModal.js`

When selected provider has `supportsLevels === false`:
- Hide the level toggle checkboxes
- Show a note: "This provider runs its own analysis pipeline"

When provider list is loaded, store `localOnly` and `supportsLevels` per provider. Filter providers based on review mode (hide `localOnly` providers in PR mode).

### `public/js/modules/suggestion-manager.js`

Add severity badge next to the existing type badge:

```html
<span class="severity-badge severity-${severity}">${severity}</span>
```

Only render when `severity` is non-null.

### CSS

```css
.severity-badge { font-size: 11px; padding: 1px 6px; border-radius: 3px; }
.severity-critical { background: #fde8e8; color: #d32f2f; }
.severity-medium { background: #fff3e0; color: #ef6c00; }
.severity-minor { background: #e8f5e9; color: #2e7d32; }
```

---

## 8. Test Strategy

### New: `tests/unit/executable-provider.test.js`
- Factory creates valid subclass with correct static methods and metadata
- `testAvailability()` returns true/false
- `execute()` spawns CLI with correct args assembled from context_args
- `execute()` finds result file via output_glob
- `mapOutputToSchema()` builds correct prompt with mapping_instructions
- Error handling: CLI failure, missing result file, mapping failure, timeout
- `local_only` and `supports_levels` flags propagate correctly

### Modified: existing provider config tests
- `applyConfigOverrides()` registers executable providers from config
- `getAllProvidersInfo()` includes `localOnly` and `supportsLevels`

### Database
- Migration 34 adds severity column
- `bulkInsertAISuggestions()` persists severity
- Null severity handled gracefully

---

## 9. Verification

1. **Unit tests:** `npm test -- tests/unit/executable-provider.test.js`
2. **DB migration:** Start pair-review, verify `severity` column exists in comments table
3. **Provider registration:** Configure a mock executable provider in config.json, verify it appears in `GET /api/providers` with `localOnly` and `supportsLevels` flags
4. **End-to-end local:** Configure an executable provider, open a local review, select it as provider, run analysis, verify suggestions appear with severity badges
5. **UI:** Verify level toggles are hidden for executable providers, severity badges render correctly
6. **Existing tests:** Full suite passes (`npm test`)

---

## 10. What's Deferred (Phase 2)

- **Council integration:** Executable providers as a voice alongside native pair-review analysis with consolidation
- **PR mode:** Supporting executable providers that work on GitHub PRs (not just local)
- **Native severity in prompts:** Adding severity to pair-review's own level 1/2/3 prompts
- **Streaming progress from CLI:** Parsing the external tool's stdout for real-time progress
