// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';

// analyzer.js destructures createProvider from src/ai/index at load time, so
// the spy must be installed before the Analyzer is required.
const aiIndex = require('../../src/ai/index');
const createProvider = vi.spyOn(aiIndex, 'createProvider');

const Analyzer = require('../../src/ai/analyzer');

/**
 * Regression tests: a per-reviewer run inside a multi-voice reviewer-centric
 * council used to make an AI consolidation call even when only one level
 * produced results. With a single input there is nothing to merge across
 * levels, so that call is now skipped. Standalone runs still consolidate,
 * because orchestration is their final stage (adversarial verification, dedup).
 */

const prMetadata = { pr_number: 42, reviewType: 'pr', title: 'Test PR' };
const changedFiles = ['src/a.js', 'src/b.js'];

const l1Suggestion = { file: 'src/a.js', line_start: 1, line_end: 1, type: 'bug', title: 'L1 bug', description: 'd', confidence: 0.9 };
const l3Suggestion = { file: 'src/b.js', line_start: 2, line_end: 2, type: 'design', title: 'L3 design', description: 'd', confidence: 0.8 };
const curatedSuggestion = { file: 'src/a.js', line_start: 1, line_end: 1, type: 'bug', title: 'Curated', description: 'd', confidence: 0.9 };

function createWiredAnalyzer() {
  const analyzer = new Analyzer({}, 'sonnet', 'claude');
  analyzer.loadGeneratedFilePatterns = vi.fn().mockResolvedValue([]);
  analyzer.storeSuggestions = vi.fn().mockResolvedValue(undefined);
  analyzer.validateAndFinalizeSuggestions = vi.fn().mockImplementation((s) => s || []);
  analyzer.analyzeLevel1Isolated = vi.fn().mockResolvedValue({ suggestions: [l1Suggestion], summary: 'L1 summary' });
  analyzer.analyzeLevel2Isolated = vi.fn().mockResolvedValue({ suggestions: [], summary: 'L2 summary' });
  analyzer.analyzeLevel3Isolated = vi.fn().mockResolvedValue({ suggestions: [l3Suggestion], summary: 'L3 summary' });
  return analyzer;
}

function mockConsolidationProvider() {
  const execute = vi.fn().mockResolvedValue({ suggestions: [curatedSuggestion], summary: 'curated' });
  createProvider.mockReturnValue({ execute });
  return execute;
}

const perVoiceOptions = (overrides = {}) => ({
  runId: 'run-1',
  skipRunCreation: true,
  timeout: 1000,
  skipAdversarialVerification: true,
  ...overrides
});

function run(analyzer, options, progressCallback = null) {
  return analyzer.analyzeAllLevels(1, '/nonexistent-worktree', prMetadata, progressCallback, null, changedFiles, options);
}

describe('analyzeAllLevels single-level consolidation skip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips per-reviewer consolidation when only Level 3 is enabled', async () => {
    const analyzer = createWiredAnalyzer();
    const execute = mockConsolidationProvider();
    const progressCallback = vi.fn();

    const result = await run(analyzer, perVoiceOptions({ enabledLevels: { 1: false, 2: false, 3: true } }), progressCallback);

    expect(execute).not.toHaveBeenCalled();
    expect(result.suggestions).toEqual([l3Suggestion]);
    expect(result.summary).toBe('L3 summary');
    expect(result.levelOutcomes).toEqual({
      level1: 'skipped',
      level2: 'skipped',
      level3: 'success',
      consolidation: 'skipped'
    });
    expect(result.orchestrationFailed).toBeUndefined();
    // Final suggestions are still stored as ai_level = NULL
    expect(analyzer.storeSuggestions).toHaveBeenCalledWith(1, 'run-1', [l3Suggestion], null, changedFiles);
    expect(progressCallback).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'orchestration', status: 'skipped' })
    );
    expect(progressCallback).not.toHaveBeenCalledWith(
      expect.objectContaining({ level: 'orchestration', status: 'running' })
    );
  });

  it('skips when several levels are enabled but only one succeeds', async () => {
    const analyzer = createWiredAnalyzer();
    analyzer.analyzeLevel1Isolated = vi.fn().mockRejectedValue(new Error('L1 blew up'));
    const execute = mockConsolidationProvider();

    const result = await run(analyzer, perVoiceOptions({ enabledLevels: { 1: true, 2: false, 3: true } }));

    expect(execute).not.toHaveBeenCalled();
    expect(result.suggestions).toEqual([l3Suggestion]);
    expect(result.levelOutcomes.level1).toBe('failed');
    expect(result.levelOutcomes.consolidation).toBe('skipped');
  });

  it('skips when the single level returns zero suggestions', async () => {
    const analyzer = createWiredAnalyzer();
    analyzer.analyzeLevel3Isolated = vi.fn().mockResolvedValue({ suggestions: [] });
    const execute = mockConsolidationProvider();

    const result = await run(analyzer, perVoiceOptions({ enabledLevels: { 1: false, 2: false, 3: true } }));

    expect(execute).not.toHaveBeenCalled();
    expect(result.suggestions).toEqual([]);
    // Falls back to a generated summary when the level supplied none
    expect(result.summary).toBe('Analysis complete: 0 suggestions');
    expect(result.levelOutcomes.consolidation).toBe('skipped');
  });

  it('still consolidates when more than one level succeeds', async () => {
    const analyzer = createWiredAnalyzer();
    const execute = mockConsolidationProvider();

    const result = await run(analyzer, perVoiceOptions({ enabledLevels: { 1: true, 2: false, 3: true } }));

    expect(execute).toHaveBeenCalledOnce();
    expect(result.suggestions).toEqual([expect.objectContaining({ title: 'Curated' })]);
    expect(result.levelOutcomes.consolidation).toBe('success');
  });

  it('still consolidates a standalone single-level run (orchestration is the final stage)', async () => {
    const analyzer = createWiredAnalyzer();
    const execute = mockConsolidationProvider();

    const result = await run(analyzer, {
      runId: 'run-1',
      skipRunCreation: true,
      timeout: 1000,
      enabledLevels: { 1: false, 2: false, 3: true }
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result.levelOutcomes.consolidation).toBe('success');
  });

  it('still consolidates a per-reviewer single-level run when exclude-previous dedup is on', async () => {
    const analyzer = createWiredAnalyzer();
    const execute = mockConsolidationProvider();

    const result = await run(analyzer, perVoiceOptions({
      enabledLevels: { 1: false, 2: false, 3: true },
      excludePrevious: { github: false, feedback: true }
    }));

    expect(execute).toHaveBeenCalledOnce();
    expect(result.levelOutcomes.consolidation).toBe('success');
  });
});

describe('_getSingleInputLevelForSkip', () => {
  const analyzer = new Analyzer({}, 'sonnet', 'claude');
  const results = (l1, l2, l3) => ({
    level1: { status: l1 },
    level2: { status: l2 },
    level3: { status: l3 }
  });

  it('returns the single successful level for a per-reviewer run', () => {
    expect(analyzer._getSingleInputLevelForSkip(results('skipped', 'failed', 'success'), { skipAdversarialVerification: true }))
      .toBe('level3');
    expect(analyzer._getSingleInputLevelForSkip(results('success', 'skipped', 'skipped'), { skipAdversarialVerification: true }))
      .toBe('level1');
  });

  it('returns null when more than one level succeeded', () => {
    expect(analyzer._getSingleInputLevelForSkip(results('success', 'skipped', 'success'), { skipAdversarialVerification: true }))
      .toBeNull();
  });

  it('returns null when no level succeeded', () => {
    expect(analyzer._getSingleInputLevelForSkip(results('failed', 'skipped', 'failed'), { skipAdversarialVerification: true }))
      .toBeNull();
  });

  it('returns null outside a multi-voice reviewer run', () => {
    expect(analyzer._getSingleInputLevelForSkip(results('skipped', 'skipped', 'success'), {})).toBeNull();
    expect(analyzer._getSingleInputLevelForSkip(results('skipped', 'skipped', 'success'))).toBeNull();
  });

  it('returns null when exclude-previous dedup is enabled', () => {
    const levelResults = results('skipped', 'skipped', 'success');
    expect(analyzer._getSingleInputLevelForSkip(levelResults, { skipAdversarialVerification: true, excludePrevious: { github: true } }))
      .toBeNull();
    expect(analyzer._getSingleInputLevelForSkip(levelResults, { skipAdversarialVerification: true, excludePrevious: { feedback: true } }))
      .toBeNull();
  });

  it('ignores an exclude-previous object with both flags off', () => {
    expect(analyzer._getSingleInputLevelForSkip(
      results('skipped', 'skipped', 'success'),
      { skipAdversarialVerification: true, excludePrevious: { github: false, feedback: false } }
    )).toBe('level3');
  });

  it('tolerates missing level entries', () => {
    expect(analyzer._getSingleInputLevelForSkip({ level3: { status: 'success' } }, { skipAdversarialVerification: true }))
      .toBe('level3');
  });
});
