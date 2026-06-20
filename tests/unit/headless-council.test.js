// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for runHeadlessCouncilAnalysis (src/councils/headless-council.js)
 *
 * The headless helper is the server-free twin of launchCouncilAnalysis in
 * src/routes/analyses.js. These tests use a real in-memory database (the same
 * createTestDatabase helper the rest of the suite uses) and the real
 * AnalysisRunRepository / CouncilRepository, but a FAKE analyzer stub so no
 * real AI is invoked. They verify run-record creation, dispatch by configType,
 * completion/failure semantics, and the last_used_at touch.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase, seedTestReview } from '../utils/schema.js';

const { runHeadlessCouncilAnalysis } = require('../../src/councils/headless-council.js');
const { CouncilRepository, queryOne } = require('../../src/database.js');

/**
 * Build a fake analyzer that records the args it was called with and returns a
 * canned result. Only one of the two methods should be invoked per run; both
 * are stubbed so we can assert the correct one fired.
 */
function createFakeAnalyzer({ throwOn } = {}) {
  const calls = { runReviewerCentricCouncil: [], runCouncilAnalysis: [] };

  const makeMethod = (name) => async (reviewContext, councilConfig, options) => {
    calls[name].push({ reviewContext, councilConfig, options });
    if (throwOn === name) {
      throw new Error('analyzer boom');
    }
    return {
      runId: options.runId,
      suggestions: [{}, {}],
      summary: 'ok',
      levelOutcomes: { '1': 'done' }
    };
  };

  return {
    calls,
    runReviewerCentricCouncil: makeMethod('runReviewerCentricCouncil'),
    runCouncilAnalysis: makeMethod('runCouncilAnalysis')
  };
}

const sampleConfig = {
  levels: {
    '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }] },
    '2': { enabled: false, voices: [] },
    '3': { enabled: false, voices: [] }
  }
};

describe('runHeadlessCouncilAnalysis', () => {
  let db;
  let councilRepo;
  let reviewId;

  async function seedCouncil({ id, type }) {
    return councilRepo.create({ id, name: `Council ${id}`, config: sampleConfig, type });
  }

  beforeEach(async () => {
    db = await createTestDatabase();
    councilRepo = new CouncilRepository(db);
    reviewId = seedTestReview(db, { prNumber: 42, repository: 'test/repo' });
  });

  it('configType "council" dispatches to runReviewerCentricCouncil and records a completed run', async () => {
    const council = await seedCouncil({ id: 'council-vc', type: 'council' });
    const analyzer = createFakeAnalyzer();

    const result = await runHeadlessCouncilAnalysis(db, {
      analyzer,
      reviewId,
      council,
      configType: 'council',
      councilConfig: sampleConfig,
      worktreePath: '/tmp/worktree',
      prMetadata: { head_sha: 'abc123' },
      instructions: { globalInstructions: 'g', repoInstructions: 'r', requestInstructions: null },
      githubClient: null
    });

    // Voice-centric path used, advanced path untouched.
    expect(analyzer.calls.runReviewerCentricCouncil).toHaveLength(1);
    expect(analyzer.calls.runCouncilAnalysis).toHaveLength(0);

    // The analyzer received options.runId.
    const passedRunId = analyzer.calls.runReviewerCentricCouncil[0].options.runId;
    expect(typeof passedRunId).toBe('string');
    expect(passedRunId.length).toBeGreaterThan(0);
    // The result echoes the runId the helper generated.
    expect(result.runId).toBe(passedRunId);

    // An analysis_runs row exists, attributed to the council, with that exact runId.
    const run = await queryOne(
      db,
      'SELECT id, provider, model, status, summary, total_suggestions FROM analysis_runs WHERE id = ?',
      [passedRunId]
    );
    expect(run).toBeTruthy();
    expect(run.provider).toBe('council');
    expect(run.model).toBe(council.id);

    // After completion the run is marked completed with summary + suggestion count.
    expect(run.status).toBe('completed');
    expect(run.summary).toBe('ok');
    expect(run.total_suggestions).toBe(2);
  });

  it('configType "advanced" dispatches to runCouncilAnalysis', async () => {
    const council = await seedCouncil({ id: 'council-adv', type: 'advanced' });
    const analyzer = createFakeAnalyzer();

    await runHeadlessCouncilAnalysis(db, {
      analyzer,
      reviewId,
      council,
      configType: 'advanced',
      councilConfig: sampleConfig,
      worktreePath: '/tmp/worktree',
      prMetadata: { head_sha: 'def456' },
      instructions: { globalInstructions: null, repoInstructions: null, requestInstructions: null },
      githubClient: null
    });

    expect(analyzer.calls.runCouncilAnalysis).toHaveLength(1);
    expect(analyzer.calls.runReviewerCentricCouncil).toHaveLength(0);

    const passedRunId = analyzer.calls.runCouncilAnalysis[0].options.runId;
    const run = await queryOne(db, 'SELECT model, status FROM analysis_runs WHERE id = ?', [passedRunId]);
    expect(run.model).toBe(council.id);
    expect(run.status).toBe('completed');
  });

  it('rethrows analyzer errors and marks the run failed', async () => {
    const council = await seedCouncil({ id: 'council-fail', type: 'council' });
    const analyzer = createFakeAnalyzer({ throwOn: 'runReviewerCentricCouncil' });

    await expect(
      runHeadlessCouncilAnalysis(db, {
        analyzer,
        reviewId,
        council,
        configType: 'council',
        councilConfig: sampleConfig,
        worktreePath: '/tmp/worktree',
        prMetadata: { head_sha: 'sha' },
        instructions: { globalInstructions: null, repoInstructions: null, requestInstructions: null },
        githubClient: null
      })
    ).rejects.toThrow('analyzer boom');

    // Exactly one run row exists, and it is marked failed.
    const run = await queryOne(
      db,
      'SELECT status FROM analysis_runs WHERE review_id = ? AND model = ?',
      [reviewId, council.id]
    );
    expect(run).toBeTruthy();
    expect(run.status).toBe('failed');
  });

  it('touches the council last_used_at after a run', async () => {
    const council = await seedCouncil({ id: 'council-touch', type: 'council' });
    const before = await councilRepo.getById(council.id);
    expect(before.last_used_at).toBeNull();

    const analyzer = createFakeAnalyzer();
    await runHeadlessCouncilAnalysis(db, {
      analyzer,
      reviewId,
      council,
      configType: 'council',
      councilConfig: sampleConfig,
      worktreePath: '/tmp/worktree',
      prMetadata: { head_sha: 'sha' },
      instructions: { globalInstructions: null, repoInstructions: null, requestInstructions: null },
      githubClient: null
    });

    const after = await councilRepo.getById(council.id);
    expect(after.last_used_at).toBeTruthy();
  });
});
