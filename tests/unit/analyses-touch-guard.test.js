// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the file-council MRU guard in `launchCouncilAnalysis`
 * (src/routes/analyses.js).
 *
 * File councils live in `~/.pair-review/councils/*.json` and have no `councils`
 * row, so bumping `last_used_at` for a `file:` id would be a write against a
 * non-existent record. The launcher must skip the fire-and-forget
 * `CouncilRepository.touchLastUsedAt` for those ids while still bumping DB
 * councils. (`runHeadlessCouncilAnalysis` carries the same guard — see
 * tests/unit/headless-council.test.js.)
 *
 * The launcher is exercised for real against an in-memory database; only the
 * analyzer's council entry point is stubbed so no AI is spawned.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema.js';

const analysesRouter = require('../../src/routes/analyses.js');
const Analyzer = require('../../src/ai/analyzer.js');
const { CouncilRepository, queryOne } = require('../../src/database.js');

const advancedConfig = {
  levels: {
    '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }] },
    '2': { enabled: false, voices: [] },
    '3': { enabled: false, voices: [] }
  }
};

// No file-overlay priming here on purpose: the launcher is handed a config and
// an id, and only ever inspects the id STRING — it never resolves the council.

describe('launchCouncilAnalysis last_used_at guard', () => {
  let db;
  let reviewId;
  let touchSpy;

  /** Minimal modeContext: the launcher only needs these to record the run. */
  function modeContext() {
    return {
      reviewId,
      worktreePath: '/worktree/test',
      prMetadata: { head_sha: 'abc123' },
      changedFiles: ['src/example.js'],
      repository: 'test/repo',
      headSha: 'abc123',
      logLabel: 'test/repo#1',
      config: {}
    };
  }

  const instructions = {
    globalInstructions: null,
    repoInstructions: null,
    requestInstructions: null
  };

  /** Wait for the launcher's fire-and-forget completion chain to settle. */
  async function waitForRunStatus(runId, status) {
    await vi.waitFor(async () => {
      const row = await queryOne(db, 'SELECT status FROM analysis_runs WHERE id = ?', [runId]);
      expect(row?.status).toBe(status);
    });
  }

  beforeEach(async () => {
    db = await createTestDatabase();
    reviewId = seedTestReview(db, { prNumber: 1, repository: 'test/repo' });
    touchSpy = vi.spyOn(CouncilRepository.prototype, 'touchLastUsedAt').mockResolvedValue(true);
    vi.spyOn(Analyzer.prototype, 'runCouncilAnalysis').mockResolvedValue({
      suggestions: [],
      summary: null
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (db) closeTestDatabase(db);
  });

  it('does not touch last_used_at for a file council', async () => {
    const { runId } = await analysesRouter.launchCouncilAnalysis(
      db, modeContext(), advancedConfig, 'file:dream-team', instructions, 'advanced'
    );

    expect(touchSpy).not.toHaveBeenCalled();

    // The run is still recorded, with the `file:` id stored verbatim in `model`
    // (that is what keeps council history and "last used with" working).
    const row = await queryOne(db, 'SELECT provider, model FROM analysis_runs WHERE id = ?', [runId]);
    expect(row.provider).toBe('council');
    expect(row.model).toBe('file:dream-team');

    await waitForRunStatus(runId, 'completed');
    expect(touchSpy).not.toHaveBeenCalled();
  });

  it('touches last_used_at for a DB council', async () => {
    const councilId = 'db-council-1';
    await new CouncilRepository(db).create({
      id: councilId, name: 'Saved Council', config: advancedConfig, type: 'advanced'
    });

    const { runId } = await analysesRouter.launchCouncilAnalysis(
      db, modeContext(), advancedConfig, councilId, instructions, 'advanced'
    );

    expect(touchSpy).toHaveBeenCalledTimes(1);
    expect(touchSpy).toHaveBeenCalledWith(councilId);

    await waitForRunStatus(runId, 'completed');
  });

  it('does not touch last_used_at for an inline (unsaved) council config', async () => {
    const { runId } = await analysesRouter.launchCouncilAnalysis(
      db, modeContext(), advancedConfig, null, instructions, 'advanced'
    );

    expect(touchSpy).not.toHaveBeenCalled();

    const row = await queryOne(db, 'SELECT model FROM analysis_runs WHERE id = ?', [runId]);
    expect(row.model).toBe('inline-config');

    await waitForRunStatus(runId, 'completed');
  });
});
