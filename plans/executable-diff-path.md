# Executable Provider: `--diff-path` Integration

## Context

The executable provider currently passes `--base <branch>` so the external tool generates its own diff. This creates a mismatch — pair-review has a well-defined review scope (especially in local mode with branch/staged/unstaged/untracked), but the external tool computes its own diff independently. By generating the diff ourselves and passing it via `--diff-path <temp-file>`, we ensure the external tool reviews exactly what pair-review is showing.

Additionally, we add `--title`/`--description` to the user's local config so PR metadata flows to the external tool when available.

## Changes

### 1. Config: `.pair-review/config.local.json`

Update `context_args` — replace `base_branch`→`--base` with `diff_path`→`--diff-path`, add `title`→`--title` and `description`→`--description`:

```json
"context_args": {
  "model": "--model",
  "output_dir": "--output-dir",
  "diff_path": "--diff-path",
  "title": "--title",
  "description": "--description"
}
```

Title/description already exist in the executable context from `buildContext` callbacks (PR mode sets from metadata, local mode sets `null`). `_buildArgs` skips `null` values, so local mode omits these flags automatically.

### 2. Add `diffArgs` property: `src/ai/executable-provider.js`

In `ExecProvider` constructor (~line 131), add:
```js
this.diffArgs = config.diff_args || [];
```

This stores per-provider extra git diff flags (e.g. `["--unified=10", "-w"]`) for the diff generation step.

### 3. Add scope fields to local `buildContext`: `src/routes/local.js`

In `handleExecutableAnalysis`'s `buildContext` callback (line 1003), add:
```js
scopeStart: r.local_scope_start || DEFAULT_SCOPE.start,
scopeEnd: r.local_scope_end || DEFAULT_SCOPE.end,
```

These are consumed internally by diff generation — they're not in `context_args` so `_buildArgs` ignores them.

### 4. Parameterize `generateScopedDiff`: `src/local-review.js`

Add `options.contextLines` (default `25`, backward-compatible) and `options.extraArgs` (default `[]`). Replace the 6 hardcoded `--unified=25` strings with the configurable value. Do NOT apply `extraArgs` to `generateUntrackedDiffs` calls (`--no-index` invocations are structurally different).

### 5. Diff generation + wiring: `src/routes/executable-analysis.js`

Add `generateDiffForExecutable(cwd, context, diffArgs, outputPath)`:
- **PR mode** (has `baseSha` + `headSha`): `git diff ${GIT_DIFF_FLAGS} ${diffArgs} baseSha...headSha`
- **Local mode** (has `scopeStart` + `scopeEnd`): call `generateScopedDiff(cwd, scopeStart, scopeEnd, baseBranch, { contextLines: 3, extraArgs: diffArgs })`
- Writes diff to `outputPath`

In `runExecutableAnalysis`, after `buildContext` and before `provider.execute()`:
```js
const diffPath = path.join(tmpDir, 'review.diff');
await generateDiffForExecutable(cwd, executableContext, provider.diffArgs || [], diffPath);
executableContext.diffPath = diffPath;
```

Graceful degradation: if diff generation fails, log a warning and continue without `--diff-path`. Temp file lives in `tmpDir` — cleaned up by existing `finally` block.

New imports: `generateScopedDiff` from `../local-review` (no circular dependency — verified).

### 6. Update example config: `config.example.json`

Add `diff_path` to `context_args` and add `diff_args` field:
```json
"context_args": {
  "title": "--title",
  "description": "--description",
  "output_dir": "--output-dir",
  "diff_path": "--diff-path",
  "head_sha": "--sha",
  "model": "--model",
  "head_branch": "--branch"
},
"diff_args": []
```

### 7. Tests

- **`executable-provider.test.js`**: `diffArgs` stored from config, defaults to `[]`
- **`executable-analysis` tests**: `generateDiffForExecutable` — PR mode calls git diff with correct args; local mode calls `generateScopedDiff` with `contextLines: 3`; writes to output path; `diffArgs` appended to commands
- **`local-review.test.js`**: `contextLines` option changes `--unified` flag; `extraArgs` appended; defaults preserve existing `--unified=25` behavior

## Hazards

- **`generateScopedDiff` callers**: ~7 callers in `local.js` + 2 in `local-review.js`. The defaults (`contextLines: 25`, `extraArgs: []`) preserve existing behavior exactly.
- **`generateScopedDiff` uses `execSync`**: Acceptable since the async IIFE has already sent the HTTP response.
- **`baseBranch` remains in context** for local mode (needed by `generateScopedDiff` to compute merge-base) — just no longer in `context_args`.
- **PR mode has no scope fields**: `baseSha && headSha` check takes precedence in `generateDiffForExecutable`.

## Verification

1. Run unit tests: `npm test`
2. Manual: start a local review, trigger executable analysis → verify `--diff-path` appears in the spawned command args and the temp file contains the scoped diff
3. Manual: start a PR review, trigger executable analysis → verify `--diff-path` with base...head diff, `--title`, `--description` in args
4. Run E2E tests: `npm run test:e2e`
