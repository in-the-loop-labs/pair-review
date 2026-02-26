# Plan: Monorepo `checkout_script` Support

## Context

In monorepos with sparse checkout, pair-review's built-in algorithm to expand sparse-checkout patterns is naive. It extracts immediate parent directories from changed files and deduplicates by removing children whose parents are also in the set. This can over-include directories — e.g., if a PR touches `areas/tsconfig.json` (parent: `areas/`) plus files deeper in `areas/apps/a/`, everything collapses to `areas/` and the entire subtree gets checked out.

The monorepo's own tooling (Turborepo, Nx, pnpm, Bazel, etc.) already knows the project structure. A new `checkout_script` config option lets users hand off sparse-checkout setup to their own script, which receives PR context as environment variables.

## Design

**Config** (`~/.pair-review/config.json`):
```json
{
  "monorepos": {
    "owner/repo": {
      "path": "~/path/to/monorepo",
      "checkout_script": "./scripts/pr-checkout.sh"
    }
  }
}
```

**Flow when `checkout_script` IS configured** (PR mode only):
1. `git worktree add --no-checkout <path> <base-branch>` — from main git root, NO sparse-checkout inheritance
2. Fetch PR head ref into worktree
3. Execute `checkout_script` with CWD=worktree and env vars: `BASE_BRANCH`, `HEAD_BRANCH`, `BASE_SHA`, `HEAD_SHA`, `PR_NUMBER`, `WORKTREE_PATH`
4. `git checkout` PR head — files populate per whatever sparse-checkout the script configured
5. Skip built-in `ensurePRDirectoriesInSparseCheckout` entirely
6. Generate diff as normal

**Flow without `checkout_script`**: unchanged.

## Changes

### 1. `src/config.js` — Add accessor function

Add `getMonorepoCheckoutScript(config, repository)` next to existing `getMonorepoPath` (line 311). Same pattern: read from `config.monorepos?.[repository]?.checkout_script`, return string or null. Add to `module.exports` (line 349).

### 2. `src/git/worktree.js` — Script execution + worktree creation changes

**Add `executeCheckoutScript` method** to `GitWorktreeManager`:
- Signature: `async executeCheckoutScript(script, worktreePath, env, timeout = 60000)`
- Uses `child_process.spawn` with `shell: true` (so `$VAR` references work), CWD=worktreePath, merged env vars
- Timeout via `setTimeout` + `SIGTERM` (pattern from `src/ai/claude-cli.js:63-68`)
- Collects stdout/stderr; rejects with descriptive error including both on failure
- Handles ENOENT (command not found) specially

**Modify `createWorktreeForPR`** (line 142):
- Add `options.checkoutScript` to destructuring (line 143)
- Branch the worktree creation block (lines 246-264):
  - **With `checkoutScript`**: `git.raw(['worktree', 'add', '--no-checkout', worktreePath, ...])` from `git` (main root), NOT `worktreeAddGit`
  - **Without**: existing behavior unchanged
- After PR head fetch (line 281) and before checkout (line 285), if `checkoutScript` is set, call `this.executeCheckoutScript(checkoutScript, worktreePath, { BASE_BRANCH, HEAD_BRANCH, BASE_SHA, HEAD_SHA, PR_NUMBER, WORKTREE_PATH })`

### 3. `src/setup/pr-setup.js` — Wire it through

**Import**: Add `getMonorepoCheckoutScript` to the destructured import from `../config` (line 19).

**`findRepositoryPath`** (line 210):
- After the Tier -1 block (line 268), resolve `checkoutScript` via `getMonorepoCheckoutScript(config, repository)`
- If `checkoutScript` is set, null out `worktreeSourcePath` (no inheritance — the script handles everything)
- Add `checkoutScript` to return value (line 338): `{ repositoryPath, knownPath, worktreeSourcePath, checkoutScript }`
- Update JSDoc return type (line 205)

**`setupPRReview`** (line 358):
- Destructure `checkoutScript` from `findRepositoryPath` result (line 384)
- Pass `checkoutScript` to `createWorktreeForPR` options (line 402)
- Guard the sparse step (lines 407-434): if `checkoutScript`, skip with a log message; otherwise existing logic

### 4. `config.example.json` — Document the option

Add a `monorepos` section after `providers` (line 192):
```json
"monorepos": {
  "_comment": "Monorepo sparse-checkout configuration. 'checkout_script' runs in the worktree with env vars: BASE_BRANCH, HEAD_BRANCH, BASE_SHA, HEAD_SHA, PR_NUMBER, WORKTREE_PATH.",
  "owner/repo": {
    "path": "~/path/to/monorepo",
    "checkout_script": "./scripts/pr-checkout.sh"
  }
}
```

### 5. `tests/unit/worktree-sparse-checkout.test.js` — Unit tests for `executeCheckoutScript`

New `describe('executeCheckoutScript')` block:
- Executes script with correct env vars and CWD (verify by writing env to file)
- Rejects on non-zero exit code with stdout/stderr in error message
- Rejects on timeout
- Rejects on ENOENT (command not found)
- Resolves on success

### 6. `tests/integration/pr-setup.test.js` — Integration tests for `findRepositoryPath`

Add tests within the existing monorepo configuration describe block:
- Returns `checkoutScript` when configured, with `worktreeSourcePath` nullified
- Returns null `checkoutScript` when not configured (existing behavior preserved)
- `worktreeSourcePath` stays null even when monorepo path differs from resolved root

### 7. Changeset

Create `.changeset/<name>.md` with `minor` bump for new feature.

## Verification

1. Run unit tests: `npm test -- tests/unit/worktree-sparse-checkout.test.js`
2. Run integration tests: `npm test -- tests/integration/pr-setup.test.js`
3. Run full test suite: `npm test`
