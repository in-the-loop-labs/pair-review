// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before importing the Analyzer
vi.mock('../../src/ai/index', () => ({
  createProvider: vi.fn()
}));

vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({ getPatterns: () => [] })
}));

vi.mock('../../src/utils/line-validation', () => ({
  buildFileLineCountMap: vi.fn().mockResolvedValue(new Map()),
  validateSuggestionLineNumbers: vi.fn(suggestions => suggestions)
}));

vi.mock('../../src/routes/shared', () => ({
  registerProcess: vi.fn(),
  isAnalysisCancelled: vi.fn().mockReturnValue(false),
  CancellationError: class CancellationError extends Error {
    constructor(msg) { super(msg); this.isCancellation = true; }
  }
}));

import Analyzer from '../../src/ai/analyzer.js';

/**
 * Tests for council analysis summary propagation through bypass paths.
 *
 * Regression: When a council voice returned 0 suggestions but a valid summary,
 * the summary was lost because consolidation/orchestration was skipped and neither
 * bypass path propagated the voice's summary.
 */
describe('Council analysis summary propagation', () => {
  let analyzer;
  let storedSuggestions;

  const validFiles = ['src/foo.js', 'src/bar.js'];

  const councilConfig = {
    levels: {
      '2': {
        enabled: true,
        voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }]
      }
    }
  };

  const reviewContext = {
    reviewId: 1,
    worktreePath: '/tmp/test-worktree',
    prMetadata: { title: 'Test PR', description: 'Test', base_branch: 'main' },
    changedFiles: validFiles,
    instructions: null
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storedSuggestions = [];

    analyzer = new Analyzer({}, 'council', 'council');

    // Stub methods that touch filesystem/database
    vi.spyOn(analyzer, 'loadGeneratedFilePatterns').mockResolvedValue([]);
    vi.spyOn(analyzer, 'getChangedFilesList').mockResolvedValue(validFiles);
    vi.spyOn(analyzer, 'storeSuggestions').mockImplementation(async (reviewId, runId, suggestions) => {
      storedSuggestions.push(...suggestions);
    });
  });

  describe('single-voice bypass path', () => {
    it('should propagate voice summary when voice returns suggestions', async () => {
      vi.spyOn(analyzer, '_executeCouncilVoice').mockResolvedValue({
        suggestions: [
          { file: 'src/foo.js', line_start: 10, line_end: 10, type: 'bug', title: 'Test bug', confidence: 0.9 }
        ],
        summary: 'Found a potential null pointer issue in the error handling path'
      });

      const result = await analyzer.runCouncilAnalysis(reviewContext, councilConfig, { runId: 'test-run' });

      expect(result.summary).toBe('Found a potential null pointer issue in the error handling path');
    });

    it('should propagate voice summary when voice returns 0 suggestions but a summary', async () => {
      vi.spyOn(analyzer, '_executeCouncilVoice').mockResolvedValue({
        suggestions: [],
        summary: 'Code changes look good overall. No issues found.'
      });

      const result = await analyzer.runCouncilAnalysis(reviewContext, councilConfig, { runId: 'test-run' });

      expect(result.summary).toBe('Code changes look good overall. No issues found.');
      expect(result.suggestions).toEqual([]);
    });

    it('should use generic fallback when voice returns no summary', async () => {
      vi.spyOn(analyzer, '_executeCouncilVoice').mockResolvedValue({
        suggestions: [
          { file: 'src/foo.js', line_start: 5, line_end: 5, type: 'improvement', title: 'Style fix', confidence: 0.7 }
        ],
        summary: null
      });

      const result = await analyzer.runCouncilAnalysis(reviewContext, councilConfig, { runId: 'test-run' });

      // With no voice summary, should fall back to generic
      expect(result.summary).toContain('Council analysis complete');
      expect(result.summary).toContain('single reviewer');
    });
  });

  describe('runCouncilAnalysis always consolidates multi-voice results (source verification)', () => {
    it('should NOT contain COUNCIL_CONSOLIDATION_THRESHOLD check', () => {
      // The threshold guard was removed so consolidation always runs for multi-voice councils.
      // This verifies the code change at the source level.
      const src = Analyzer.prototype.runCouncilAnalysis.toString();
      expect(src).not.toContain('COUNCIL_CONSOLIDATION_THRESHOLD');
    });

    it('should still contain single-voice shortcut', () => {
      const src = Analyzer.prototype.runCouncilAnalysis.toString();
      expect(src).toContain('voiceSuccessCount === 1');
    });
  });

  describe('voice summary is generated even for successful voices with empty suggestions', () => {
    it('should count a voice with 0 suggestions as successful for single-voice check', async () => {
      // A voice that returned an empty array (not a failure) should still be counted
      vi.spyOn(analyzer, '_executeCouncilVoice').mockResolvedValue({
        suggestions: [],
        summary: 'The changes are clean and well-structured. No issues to report.'
      });

      const result = await analyzer.runCouncilAnalysis(reviewContext, councilConfig, { runId: 'test-run' });

      // Should take single-voice path (not throw "All council voices failed")
      expect(result.runId).toBe('test-run');
      expect(result.summary).toBe('The changes are clean and well-structured. No issues to report.');
      expect(result.suggestions).toEqual([]);
    });

    it('should use the voice summary prefixed with "Voice" fallback when voice has no explicit summary', async () => {
      // _executeCouncilVoice generates a fallback summary like "Voice L2-claude-sonnet: 0 suggestions"
      // but that's a voice-level fallback. When no explicit summary is returned, the voice result
      // will have the auto-generated one.
      vi.spyOn(analyzer, '_executeCouncilVoice').mockResolvedValue({
        suggestions: [],
        summary: 'Voice L2-claude-sonnet: 0 suggestions'
      });

      const result = await analyzer.runCouncilAnalysis(reviewContext, councilConfig, { runId: 'test-run' });

      // The auto-generated voice summary is still better than nothing
      expect(result.summary).toBe('Voice L2-claude-sonnet: 0 suggestions');
    });
  });
});
