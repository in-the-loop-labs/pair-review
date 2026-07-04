// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for runHeadlessAnalysis() in src/main.js (DB-backed, NO CLI
 * spawn). These exercise the shared single-vs-council analysis dispatch that
 * both `performHeadlessReview` (GitHub-submit modes) and the analysis-only
 * headless handler call, and verify the persisted analysis_runs row plus the
 * JSON document produced by buildHeadlessJson.
 *
 * Determinism: `vi.mock` does NOT intercept require() inside the CommonJS
 * production modules (documented project gotcha). So instead of mocking the
 * Analyzer module, we spy on the REAL prototype methods:
 *   - SINGLE path → spy on Analyzer.prototype.analyzeAllLevels. The spy mirrors
 *     exactly what the real analyzer persists (creates the analysis_runs row
 *     for the passed runId, with provider/model/request_instructions from the
 *     instructions object, then inserts a couple of consolidated final
 *     comments) so buildHeadlessJson observes real DB state. No CLI is spawned.
 *   - COUNCIL path → runHeadlessAnalysis builds a 'council' Analyzer and calls
 *     runHeadlessCouncilAnalysis, which PRE-CREATES the parent analysis_runs row
 *     (provider='council', model=council.id, config_type) before invoking the
 *     analyzer's council method. We spy on those council methods
 *     (runReviewerCentricCouncil / runCouncilAnalysis) to return a deterministic
 *     result without running the heavy orchestration.
 *
 * The instruction-propagation assertion (request_instructions lands in
 * analysis_runs) is checked for BOTH paths — this is the key cross-path hazard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema.js';

const Analyzer = require('../../src/ai/analyzer');
const { CommentRepository, AnalysisRunRepository } = require('../../src/database.js');
const { runHeadlessAnalysis, recordEmptyScopeRun, buildHeadlessJson } = require('../../src/main.js');

const REPOSITORY = 'owner/repo';

/**
 * Build a fake analyzeAllLevels implementation that mirrors the real analyzer's
 * persistence: create the analysis_runs row for options.runId (with provider /
 * model / request_instructions from `this` + the instructions object) and insert
 * deterministic consolidated final comments. Records the call so the test can
 * assert what it received.
 */
function makeFakeAnalyzeAllLevels(calls) {
  return async function (prId, worktreePath, prMetadata, progressCallback, instructions, changedFiles, options = {}) {
    calls.push({
      reviewId: prId,
      worktreePath,
      prMetadata,
      instructions,
      changedFiles,
      options,
      provider: this.provider,
      model: this.model,
      providerOverrides: this.providerOverrides
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

    const commentRepo = new CommentRepository(this.db);
    await commentRepo.bulkInsertAISuggestions(prId, runId, [
      {
        file: 'src/index.js', line: 10, type: 'bug',
        title: 'Null check missing', description: 'Could throw.', confidence: 0.9
      },
      {
        file: 'src/utils.js', line: 42, type: 'improvement',
        title: 'Simplify', description: 'Cleaner this way.', confidence: 0.7
      }
    ]);

    await runRepo.update(runId, { totalSuggestions: 2, filesAnalyzed: 2, summary: 'Found 2 things.' });

    return { runId, suggestions: [{}, {}], summary: 'Found 2 things.' };
  };
}

/**
 * Build a fake analyzeAllLevels that mirrors the real analyzer on an EMPTY diff:
 * it creates a COMPLETED analysis_runs row with zero suggestions and does NOT
 * throw. This models the empty-changed-file-set case (the plan's "exit 0 with
 * empty suggestions" intent) so we can assert runHeadlessAnalysis resolves
 * cleanly and buildHeadlessJson reports an empty suggestion set.
 */
function makeEmptyDiffAnalyzeAllLevels() {
  return async function (prId, worktreePath, prMetadata, progressCallback, instructions, changedFiles, options = {}) {
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
    // No suggestions for an empty diff.
    await runRepo.update(runId, { totalSuggestions: 0, filesAnalyzed: 0, summary: 'No changes to review.' });
    return { runId, suggestions: [], summary: 'No changes to review.' };
  };
}

describe('runHeadlessAnalysis (DB-backed)', () => {
  let db;
  let reviewId;

  beforeEach(async () => {
    db = createTestDatabase();
    reviewId = seedTestReview(db, { prNumber: 7, repository: REPOSITORY });
    // A repo_settings row so any internal resolveLoadSkills lookups are happy.
    await db.prepare(
      `INSERT INTO repo_settings (repository, default_provider, default_model) VALUES (?, NULL, NULL)`
    ).run(REPOSITORY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeTestDatabase(db);
  });

  // ===================== SINGLE PATH =====================
  describe('single path', () => {
    let analyzeSpy;
    let calls;

    beforeEach(() => {
      calls = [];
      analyzeSpy = vi
        .spyOn(Analyzer.prototype, 'analyzeAllLevels')
        .mockImplementation(makeFakeAnalyzeAllLevels(calls));
    });

    it('constructs the Analyzer with the resolved provider/model, threads instructions + options, and persists suggestions', async () => {
      const instructions = {
        globalInstructions: 'global note',
        repoInstructions: 'repo note',
        requestInstructions: 'be terse'
      };
      const githubClient = { _marker: 'gh-client' };
      const repoSettings = await db.prepare('SELECT * FROM repo_settings WHERE repository = ?').get(REPOSITORY);

      const { runId, result } = await runHeadlessAnalysis(db, {}, {
        reviewId,
        worktreePath: '/tmp/worktree',
        prMetadata: { head_sha: 'abc123' },
        changedFiles: null,
        repository: REPOSITORY,
        repoSettings,
        instructions,
        reviewConfig: { type: 'single', provider: 'claude', model: 'opus' },
        providerOverrides: { load_skills: false },
        githubClient
      });

      // Returns the run id.
      expect(runId).toBeTruthy();
      expect(result).toBeTruthy();

      // analyzeAllLevels invoked exactly once.
      expect(analyzeSpy).toHaveBeenCalledTimes(1);
      const call = calls[0];

      // Analyzer was constructed with the reviewConfig provider/model.
      expect(call.provider).toBe('claude');
      expect(call.model).toBe('opus');
      expect(call.providerOverrides).toEqual({ load_skills: false });

      // The SAME instructions object was threaded through.
      expect(call.instructions).toEqual(instructions);
      // options carries { githubClient, runId }.
      expect(call.options.runId).toBe(runId);
      expect(call.options.githubClient).toBe(githubClient);
      // Positional args match the documented signature.
      expect(call.reviewId).toBe(reviewId);
      expect(call.worktreePath).toBe('/tmp/worktree');
      expect(call.prMetadata).toEqual({ head_sha: 'abc123' });
      expect(call.changedFiles).toBeNull();

      // buildHeadlessJson reflects the persisted run + suggestions.
      const doc = await buildHeadlessJson(db, runId, 'pr');
      expect(doc.mode).toBe('pr');
      expect(doc.count).toBe(2);
      expect(doc.run.provider).toBe('claude');
      expect(doc.run.model).toBe('opus');
      expect(doc.run.config_type).toBe('single');
      expect(doc.run.status).toBe('completed');
      expect(doc.suggestions.map(s => s.file).sort()).toEqual(['src/index.js', 'src/utils.js']);
    });

    it('persists request_instructions on the analysis_runs row (instruction hazard, single path)', async () => {
      const { runId } = await runHeadlessAnalysis(db, {}, {
        reviewId,
        worktreePath: '/tmp/worktree',
        prMetadata: { head_sha: 'abc123' },
        changedFiles: null,
        repository: REPOSITORY,
        repoSettings: null,
        instructions: {
          globalInstructions: null,
          repoInstructions: null,
          requestInstructions: 'focus on auth bugs'
        },
        reviewConfig: { type: 'single', provider: 'antigravity', model: 'gemini-3.1-pro-low' },
        providerOverrides: {},
        githubClient: undefined
      });

      const row = await db.prepare(
        'SELECT provider, model, request_instructions FROM analysis_runs WHERE id = ?'
      ).get(runId);
      expect(row.provider).toBe('antigravity');
      expect(row.model).toBe('gemini-3.1-pro-low');
      expect(row.request_instructions).toBe('focus on auth bugs');
    });

    it('resolves with a runId and an empty suggestion set for an empty diff (does not throw)', async () => {
      // Mirror the real analyzer on an empty changed-file set: a completed run
      // with zero suggestions, NO throw. Re-point the prototype spy at the
      // empty-diff fake (replaces the 2-suggestion fake from beforeEach).
      analyzeSpy.mockImplementation(makeEmptyDiffAnalyzeAllLevels());

      const promise = runHeadlessAnalysis(db, {}, {
        reviewId,
        worktreePath: '/tmp/worktree',
        prMetadata: { head_sha: 'abc123' },
        // Empty changed-file set.
        changedFiles: [],
        repository: REPOSITORY,
        repoSettings: null,
        instructions: {
          globalInstructions: null,
          repoInstructions: null,
          requestInstructions: null
        },
        reviewConfig: { type: 'single', provider: 'claude', model: 'opus' },
        providerOverrides: {},
        githubClient: undefined
      });

      // Resolves (no throw) and returns a run id.
      await expect(promise).resolves.toBeTruthy();
      const { runId } = await promise;
      expect(runId).toBeTruthy();

      // The run completed and the JSON document is an empty-but-valid result:
      // count 0, empty suggestions array, completed status.
      const doc = await buildHeadlessJson(db, runId, 'local');
      expect(doc.mode).toBe('local');
      expect(doc.run.status).toBe('completed');
      expect(doc.count).toBe(0);
      expect(doc.suggestions).toEqual([]);
    });
  });

  // ===================== EMPTY-SCOPE SHORT-CIRCUIT =====================
  describe('recordEmptyScopeRun (empty local scope)', () => {
    it('persists a completed, zero-suggestion single run WITHOUT invoking the analyzer', async () => {
      const analyzeSpy = vi.spyOn(Analyzer.prototype, 'analyzeAllLevels');

      const runId = await recordEmptyScopeRun(db, {
        reviewId,
        reviewConfig: { type: 'single', provider: 'claude', model: 'opus' },
        instructions: { globalInstructions: null, repoInstructions: null, requestInstructions: 'be terse' },
        headSha: 'emptyhead'
      });

      // The analyzer must never run for a guaranteed-empty scope.
      expect(analyzeSpy).not.toHaveBeenCalled();

      const row = await db.prepare(
        'SELECT provider, model, config_type, status, total_suggestions, request_instructions, head_sha FROM analysis_runs WHERE id = ?'
      ).get(runId);
      expect(row.status).toBe('completed');
      expect(row.provider).toBe('claude');
      expect(row.model).toBe('opus');
      expect(row.config_type).toBe('single');
      expect(row.total_suggestions).toBe(0);
      expect(row.request_instructions).toBe('be terse');
      expect(row.head_sha).toBe('emptyhead');

      // buildHeadlessJson yields the standard empty envelope (exit-0 semantics).
      const doc = await buildHeadlessJson(db, runId, 'local');
      expect(doc.mode).toBe('local');
      expect(doc.run.status).toBe('completed');
      expect(doc.count).toBe(0);
      expect(doc.suggestions).toEqual([]);
    });

    it('attributes the empty run to the council when reviewConfig is a council', async () => {
      const council = { id: 'council-empty', name: 'Empty', type: 'council' };
      const runId = await recordEmptyScopeRun(db, {
        reviewId,
        reviewConfig: { type: 'council', council, configType: 'advanced', councilConfig: {} },
        instructions: { globalInstructions: null, repoInstructions: null, requestInstructions: null },
        headSha: null
      });

      const row = await db.prepare(
        'SELECT provider, model, config_type, status, total_suggestions FROM analysis_runs WHERE id = ?'
      ).get(runId);
      expect(row.provider).toBe('council');
      expect(row.model).toBe('council-empty');
      expect(row.config_type).toBe('advanced');
      expect(row.status).toBe('completed');
      expect(row.total_suggestions).toBe(0);
    });
  });

  // ===================== COUNCIL PATH =====================
  describe('council path', () => {
    const advancedConfig = {
      levels: {
        '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }] },
        '2': { enabled: false, voices: [] },
        '3': { enabled: false, voices: [] }
      }
    };
    const voiceConfig = {
      voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }],
      levels: { '1': true, '2': false, '3': false }
    };

    it('dispatches to runReviewerCentricCouncil for a voice-centric council and records council attribution + instructions', async () => {
      const council = { id: 'council-uuid-1', name: 'Voices', type: 'council' };
      let receivedContext;
      let receivedOptions;
      const councilSpy = vi
        .spyOn(Analyzer.prototype, 'runReviewerCentricCouncil')
        .mockImplementation(async function (reviewContext, councilConfig, options) {
          receivedContext = reviewContext;
          receivedOptions = options;
          return { suggestions: [], summary: 'council summary', levelOutcomes: { 1: { status: 'ok' } } };
        });
      // The level-centric method must NOT be used for a 'council' configType.
      const otherSpy = vi.spyOn(Analyzer.prototype, 'runCouncilAnalysis').mockResolvedValue({ suggestions: [] });

      const instructions = {
        globalInstructions: null,
        repoInstructions: null,
        requestInstructions: 'council-level instructions'
      };

      const { runId } = await runHeadlessAnalysis(db, {}, {
        reviewId,
        worktreePath: '/tmp/worktree',
        prMetadata: { head_sha: 'cabba9e' },
        changedFiles: null,
        repository: REPOSITORY,
        repoSettings: null,
        instructions,
        reviewConfig: {
          type: 'council',
          council,
          configType: 'council',
          councilConfig: voiceConfig
        },
        providerOverrides: {},
        githubClient: undefined
      });

      // The voice-centric method ran; the level-centric one did not.
      expect(councilSpy).toHaveBeenCalledTimes(1);
      expect(otherSpy).not.toHaveBeenCalled();

      // The shared instructions object reached the analyzer call.
      expect(receivedContext.instructions).toEqual(instructions);
      expect(receivedOptions.runId).toBe(runId);

      // The parent run row is attributed to the council and carries instructions.
      const row = await db.prepare(
        'SELECT provider, model, config_type, status, request_instructions, head_sha FROM analysis_runs WHERE id = ?'
      ).get(runId);
      expect(row.provider).toBe('council');
      expect(row.model).toBe(council.id);
      expect(row.config_type).toBe('council');
      expect(row.status).toBe('completed');
      expect(row.request_instructions).toBe('council-level instructions');
      expect(row.head_sha).toBe('cabba9e');

      // buildHeadlessJson surfaces the council run; its non-null levelOutcomes are parsed.
      const doc = await buildHeadlessJson(db, runId, 'local');
      expect(doc.run.config_type).toBe('council');
      expect(doc.run.model).toBe(council.id);
      expect(doc.run.level_outcomes).toEqual({ 1: { status: 'ok' } });
      expect(doc.count).toBe(0);
    });

    it('forwards a scope-aware changedFiles list into the council reviewContext (local mode)', async () => {
      const council = { id: 'council-uuid-cf', name: 'Scoped', type: 'council' };
      let receivedContext;
      vi.spyOn(Analyzer.prototype, 'runReviewerCentricCouncil')
        .mockImplementation(async function (reviewContext) {
          receivedContext = reviewContext;
          return { suggestions: [], summary: 'scoped summary' };
        });

      const changedFiles = ['src/a.js', 'src/b.js'];

      await runHeadlessAnalysis(db, {}, {
        reviewId,
        worktreePath: '/tmp/worktree',
        prMetadata: { head_sha: 'sc0ped' },
        changedFiles,
        repository: REPOSITORY,
        repoSettings: null,
        instructions: { globalInstructions: null, repoInstructions: null, requestInstructions: null },
        reviewConfig: { type: 'council', council, configType: 'council', councilConfig: voiceConfig },
        providerOverrides: {},
        githubClient: undefined
      });

      // The precomputed local scope reaches the council analyzer instead of the
      // hard-coded null that previously forced Git-based rediscovery.
      expect(receivedContext.changedFiles).toEqual(changedFiles);
    });

    it('passes changedFiles through as null in PR mode', async () => {
      const council = { id: 'council-uuid-pr', name: 'PRish', type: 'council' };
      let receivedContext;
      vi.spyOn(Analyzer.prototype, 'runReviewerCentricCouncil')
        .mockImplementation(async function (reviewContext) {
          receivedContext = reviewContext;
          return { suggestions: [], summary: 'pr summary' };
        });

      await runHeadlessAnalysis(db, {}, {
        reviewId,
        worktreePath: '/tmp/worktree',
        prMetadata: { head_sha: 'prsha' },
        changedFiles: null,
        repository: REPOSITORY,
        repoSettings: null,
        instructions: { globalInstructions: null, repoInstructions: null, requestInstructions: null },
        reviewConfig: { type: 'council', council, configType: 'council', councilConfig: voiceConfig },
        providerOverrides: {},
        githubClient: undefined
      });

      expect(receivedContext.changedFiles).toBeNull();
    });

    it('dispatches to runCouncilAnalysis for an advanced (level-centric) council', async () => {
      const council = { id: 'council-uuid-2', name: 'Advanced', type: 'advanced' };
      let receivedContext;
      const councilSpy = vi
        .spyOn(Analyzer.prototype, 'runCouncilAnalysis')
        .mockImplementation(async function (reviewContext) {
          receivedContext = reviewContext;
          return { suggestions: [], summary: 'advanced summary' };
        });
      const otherSpy = vi.spyOn(Analyzer.prototype, 'runReviewerCentricCouncil').mockResolvedValue({ suggestions: [] });

      const instructions = {
        globalInstructions: null,
        repoInstructions: null,
        requestInstructions: 'advanced instructions'
      };

      const { runId } = await runHeadlessAnalysis(db, {}, {
        reviewId,
        worktreePath: '/tmp/worktree',
        prMetadata: { head_sha: 'deadbeef' },
        changedFiles: null,
        repository: REPOSITORY,
        repoSettings: null,
        instructions,
        reviewConfig: {
          type: 'council',
          council,
          configType: 'advanced',
          councilConfig: advancedConfig
        },
        providerOverrides: {},
        githubClient: undefined
      });

      expect(councilSpy).toHaveBeenCalledTimes(1);
      expect(otherSpy).not.toHaveBeenCalled();
      expect(receivedContext.instructions).toEqual(instructions);

      const row = await db.prepare(
        'SELECT provider, model, config_type, request_instructions FROM analysis_runs WHERE id = ?'
      ).get(runId);
      expect(row.provider).toBe('council');
      expect(row.model).toBe(council.id);
      expect(row.config_type).toBe('advanced');
      // Instruction hazard: request_instructions persists on the council path too.
      expect(row.request_instructions).toBe('advanced instructions');
    });

    it('marks the parent run failed and rethrows when the council analyzer throws', async () => {
      const council = { id: 'council-uuid-3', name: 'Boom', type: 'council' };
      vi.spyOn(Analyzer.prototype, 'runReviewerCentricCouncil')
        .mockRejectedValue(new Error('analyzer exploded'));

      await expect(
        runHeadlessAnalysis(db, {}, {
          reviewId,
          worktreePath: '/tmp/worktree',
          prMetadata: { head_sha: 'x' },
          changedFiles: null,
          repository: REPOSITORY,
          repoSettings: null,
          instructions: { globalInstructions: null, repoInstructions: null, requestInstructions: null },
          reviewConfig: { type: 'council', council, configType: 'council', councilConfig: voiceConfig },
          providerOverrides: {},
          githubClient: undefined
        })
      ).rejects.toThrow('analyzer exploded');

      // The pre-created parent row was marked failed.
      const row = await db.prepare(
        'SELECT status FROM analysis_runs WHERE model = ?'
      ).get(council.id);
      expect(row.status).toBe('failed');
    });
  });
});
