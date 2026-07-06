// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Regression test for handleHeadlessAnalysis() in src/main.js (LOCAL branch).
 *
 * THE BUG THIS GUARDS
 * -------------------
 * `pair-review --local --headless --provider codex` silently ignored the
 * `--provider` flag. In the local branch of handleHeadlessAnalysis, the review
 * config was resolved with:
 *
 *     resolveReviewConfig(db, repository, { council: flags.council, model: flags.model }, config)
 *
 * i.e. `flags.provider` was omitted from the `explicit` picks. resolveReviewConfig
 * (src/review-config.js) only takes the "explicit single-model pick" branch when
 * `explicitProvider || explicitModel` is truthy; with provider dropped and no
 * `--model`, it fell through to the repo/config/hardcoded default and resolved
 * `provider: 'claude'`. The user's `--provider codex` was silently discarded.
 *
 * The fix threads `provider: flags.provider` into the explicit picks. This test
 * drives the REAL local flow (setupLocalReviewSession against a throwaway git
 * repo with an uncommitted change — no git/local-review mocking) and asserts the
 * Analyzer is constructed/invoked with `provider === 'codex'`, NOT the default
 * 'claude'. Without the fix the analyzer's `this.provider` is 'claude' and the
 * core assertion fails.
 *
 * DETERMINISM
 * -----------
 * See tests/CONVENTIONS.md. Unique temp git repo via mkdtempSync (cleaned up in
 * afterEach); no real network (the repo has an uncommitted change, so
 * detectAndBuildBranchInfo short-circuits before any GitHub lookup, and the
 * headless path never spawns a provider CLI because analyzeAllLevels is spied);
 * no fixed sleeps. PAIR_REVIEW_PROVIDER / PAIR_REVIEW_MODEL are cleared for the
 * duration of the test so the without-fix fallthrough deterministically lands on
 * the config default ('claude') rather than an ambient env override — otherwise a
 * stray `PAIR_REVIEW_PROVIDER=codex` in the runner env would mask the regression.
 *
 * The council methods are spied and asserted NOT-called: this proves the
 * single-provider path was exercised (not a council), so `this.provider` is a
 * meaningful signal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import nodeFs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const Analyzer = require('../../src/ai/analyzer');
const { AnalysisRunRepository } = require('../../src/database.js');
const { handleHeadlessAnalysis } = require('../../src/main.js');

/**
 * Create a throwaway git repo with an unstaged change. The local headless flow
 * runs the REAL setupLocalReviewSession / generateScopedDiff / getChangedFiles
 * against this path (no mocking), so it must point at a repo with a genuine
 * change within the default 'unstaged'→'untracked' scope. The uncommitted change
 * also makes detectAndBuildBranchInfo short-circuit (diff present → returns null)
 * so no network/GitHub lookup occurs. Caller cleans up.
 */
function createTempRepoWithChanges() {
  const tempRepo = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-headless-local-provider-'));
  execSync('git init -b main', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: tempRepo, stdio: 'pipe' });
  const repoFile = path.join(tempRepo, 'file.js');
  nodeFs.writeFileSync(repoFile, 'line 1\nline 2\nline 3\n');
  execSync('git add file.js', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: tempRepo, stdio: 'pipe' });
  // Leave an unstaged modification.
  nodeFs.writeFileSync(repoFile, 'line 1 changed\nline 2\nline 3\nline 4 added\n');
  return tempRepo;
}

/**
 * Build a fake analyzeAllLevels that mirrors what the real analyzer persists:
 * create the analysis_runs row for options.runId (so the downstream
 * emitHeadlessResult → buildHeadlessJson doesn't blow up) and capture
 * this.provider / this.model into `calls` for the regression assertion. No CLI
 * is spawned.
 */
function makeFakeAnalyzeAllLevels(calls) {
  return async function (prId, worktreePath, prMetadata, progressCallback, instructions, changedFiles, options = {}) {
    calls.push({
      reviewId: prId,
      worktreePath,
      changedFiles,
      options,
      provider: this.provider,
      model: this.model
    });

    const runId = options.runId;
    const runRepo = new AnalysisRunRepository(this.db);
    await runRepo.create({
      id: runId,
      reviewId: prId,
      provider: this.provider,
      model: this.model,
      tier: 'balanced',
      globalInstructions: instructions?.globalInstructions || null,
      repoInstructions: instructions?.repoInstructions || null,
      requestInstructions: instructions?.requestInstructions || null,
      headSha: prMetadata?.head_sha || null,
      status: 'completed'
    });
    await runRepo.update(runId, { totalSuggestions: 0, filesAnalyzed: 1, summary: 'ok' });

    return { runId, suggestions: [], summary: 'ok' };
  };
}

describe('handleHeadlessAnalysis (local mode, --provider)', () => {
  let db;
  let tempRepo;
  let calls;
  let analyzeSpy;
  let councilVoiceSpy;
  let councilLevelSpy;
  let stdoutSpy;
  let savedProvider;
  let savedModel;

  beforeEach(() => {
    db = createTestDatabase();
    tempRepo = createTempRepoWithChanges();
    calls = [];

    // Clear one-shot env overrides so the without-fix fallthrough lands on the
    // config default ('claude'), not an ambient PAIR_REVIEW_PROVIDER value.
    savedProvider = process.env.PAIR_REVIEW_PROVIDER;
    savedModel = process.env.PAIR_REVIEW_MODEL;
    delete process.env.PAIR_REVIEW_PROVIDER;
    delete process.env.PAIR_REVIEW_MODEL;

    // Spy on the REAL prototype (vi.mock does not intercept CommonJS require()
    // in this project). Records this.provider and persists the run row.
    analyzeSpy = vi
      .spyOn(Analyzer.prototype, 'analyzeAllLevels')
      .mockImplementation(makeFakeAnalyzeAllLevels(calls));

    // The single-provider path must NOT dispatch to a council.
    councilVoiceSpy = vi.spyOn(Analyzer.prototype, 'runReviewerCentricCouncil').mockResolvedValue({ suggestions: [] });
    councilLevelSpy = vi.spyOn(Analyzer.prototype, 'runCouncilAnalysis').mockResolvedValue({ suggestions: [] });

    // json:true makes emitHeadlessResult write to stdout — silence it.
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeTestDatabase(db);
    nodeFs.rmSync(tempRepo, { recursive: true, force: true });
    if (savedProvider === undefined) delete process.env.PAIR_REVIEW_PROVIDER;
    else process.env.PAIR_REVIEW_PROVIDER = savedProvider;
    if (savedModel === undefined) delete process.env.PAIR_REVIEW_MODEL;
    else process.env.PAIR_REVIEW_MODEL = savedModel;
  });

  it('honors --provider in local headless mode (constructs the Analyzer with the requested provider, not the default)', async () => {
    await handleHeadlessAnalysis(
      [],                       // prArgs (empty for local)
      {},                       // config (empty → default provider would be 'claude')
      db,
      { local: true, localPath: tempRepo, provider: 'codex', json: true },  // flags
      null                      // poolLifecycle (local mode does not use it)
    );

    // The single-provider analyzer ran exactly once...
    expect(analyzeSpy).toHaveBeenCalledTimes(1);
    // ...and NO council path was taken (proves this.provider is meaningful).
    expect(councilVoiceSpy).not.toHaveBeenCalled();
    expect(councilLevelSpy).not.toHaveBeenCalled();

    const call = calls[0];

    // THE REGRESSION GUARD: without the fix, flags.provider is dropped and
    // resolveReviewConfig falls through to the config default 'claude'.
    expect(call.provider).toBe('codex');

    // Sanity: the real local flow actually reached the analyzer with the temp
    // repo's changed file (no git/local-review mocking).
    expect(call.worktreePath).toBe(tempRepo);
    expect(call.changedFiles).toContain('file.js');

    // And the run row persisted with the requested provider.
    const row = await db.prepare('SELECT provider FROM analysis_runs WHERE id = ?').get(call.options.runId);
    expect(row.provider).toBe('codex');
  });
});
