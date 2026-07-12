// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Regression test for the empty-scope behavior FLIP in handleHeadlessAnalysis()
 * (src/main.js, LOCAL branch).
 *
 * THE BEHAVIOR THIS GUARDS
 * ------------------------
 * A headless `--local` run whose scope resolves to zero changed files used to
 * record a completed, zero-suggestion run and exit 0 (via the now-deleted
 * `recordEmptyScopeRun`). That silent success let `pair-loop` read exit 0 /
 * empty findings and declare convergence having reviewed nothing.
 *
 * The fix makes an empty scope FAIL, matching the web routes' 409
 * (rejectIfEmptyScope): handleHeadlessAnalysis now throws the shared
 * EMPTY_SCOPE_MESSAGE, which main()'s catch turns into `{ ok:false, error }` on
 * stdout + a non-zero exit — identical message and exit code to a delegated run
 * (whose 409 body is surfaced verbatim). The analyzer must never run.
 *
 * DETERMINISM
 * -----------
 * See tests/CONVENTIONS.md. Unique temp git repo via mkdtempSync (cleaned up in
 * afterEach); the repo has a clean working tree so the default
 * 'unstaged'→'untracked' scope is genuinely empty and setupLocalReviewSession's
 * scoped diff is ''. No network, no fixed sleeps, no provider CLI spawned (the
 * analyzer is spied and asserted NOT-called).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import nodeFs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const Analyzer = require('../../src/ai/analyzer');
const { handleHeadlessAnalysis } = require('../../src/main.js');
const { EMPTY_SCOPE_MESSAGE } = require('../../src/local-scope');

/**
 * Create a throwaway git repo with a CLEAN working tree (everything committed,
 * nothing unstaged/untracked). The default local scope 'unstaged'→'untracked'
 * therefore resolves to zero changed files. Caller cleans up.
 */
function createTempCleanRepo() {
  const tempRepo = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-headless-empty-scope-'));
  execSync('git init -b main', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: tempRepo, stdio: 'pipe' });
  nodeFs.writeFileSync(path.join(tempRepo, 'file.js'), 'line 1\nline 2\n');
  execSync('git add file.js', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: tempRepo, stdio: 'pipe' });
  // No further edits — working tree is clean, so the scope is empty.
  return tempRepo;
}

describe('handleHeadlessAnalysis (local mode, empty scope)', () => {
  let db;
  let tempRepo;
  let analyzeSpy;
  let councilVoiceSpy;
  let councilLevelSpy;

  beforeEach(() => {
    db = createTestDatabase();
    tempRepo = createTempCleanRepo();
    // Spy so we can assert the analyzer is NEVER invoked for an empty scope.
    analyzeSpy = vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockResolvedValue({ suggestions: [] });
    councilVoiceSpy = vi.spyOn(Analyzer.prototype, 'runReviewerCentricCouncil').mockResolvedValue({ suggestions: [] });
    councilLevelSpy = vi.spyOn(Analyzer.prototype, 'runCouncilAnalysis').mockResolvedValue({ suggestions: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeTestDatabase(db);
    nodeFs.rmSync(tempRepo, { recursive: true, force: true });
  });

  it('FAILS with the shared empty-scope message and never invokes the analyzer', async () => {
    await expect(handleHeadlessAnalysis(
      [],
      {},
      db,
      { local: true, localPath: tempRepo, json: true },
      null
    )).rejects.toThrow(EMPTY_SCOPE_MESSAGE);

    // The analyzer (single AND council paths) must never run for an empty scope.
    expect(analyzeSpy).not.toHaveBeenCalled();
    expect(councilVoiceSpy).not.toHaveBeenCalled();
    expect(councilLevelSpy).not.toHaveBeenCalled();

    // No run row was recorded — an empty scope is a failure, not a zero-run.
    const runCount = await db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get();
    expect(runCount.n).toBe(0);
  });
});
