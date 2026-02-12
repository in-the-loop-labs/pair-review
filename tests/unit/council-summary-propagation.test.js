// SPDX-License-Identifier: GPL-3.0-or-later
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

  describe('threshold bypass path (below COUNCIL_CONSOLIDATION_THRESHOLD)', () => {
    const multiVoiceConfig = {
      levels: {
        '1': {
          enabled: true,
          voices: [{ provider: 'claude', model: 'sonnet', tier: 'fast' }]
        },
        '2': {
          enabled: true,
          voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }]
        }
      }
    };

    it('should propagate voice summary when total suggestions are below threshold', async () => {
      const voiceCall = vi.fn();

      // First voice (L1): 2 suggestions with a summary
      // Second voice (L2): 1 suggestion with a summary
      // Total = 3 suggestions, below threshold of 8
      voiceCall.mockResolvedValueOnce({
        suggestions: [
          { file: 'src/foo.js', line_start: 1, line_end: 1, type: 'bug', title: 'Bug 1', confidence: 0.9 },
          { file: 'src/bar.js', line_start: 5, line_end: 5, type: 'bug', title: 'Bug 2', confidence: 0.8 }
        ],
        summary: 'Level 1 found two bugs in error handling'
      }).mockResolvedValueOnce({
        suggestions: [
          { file: 'src/foo.js', line_start: 20, line_end: 25, type: 'improvement', title: 'Refactor suggestion', confidence: 0.7 }
        ],
        summary: 'Level 2 identified a refactoring opportunity'
      });

      vi.spyOn(analyzer, '_executeCouncilVoice').mockImplementation(() => voiceCall());

      const result = await analyzer.runCouncilAnalysis(reviewContext, multiVoiceConfig, { runId: 'test-run' });

      // Should join both summaries since there are multiple voices
      expect(result.summary).toContain('Level 1 found two bugs in error handling');
      expect(result.summary).toContain('Level 2 identified a refactoring opportunity');
    });

    it('should propagate single voice summary when only one voice has a summary', async () => {
      const voiceCall = vi.fn();

      voiceCall.mockResolvedValueOnce({
        suggestions: [
          { file: 'src/foo.js', line_start: 1, line_end: 1, type: 'bug', title: 'Bug 1', confidence: 0.9 }
        ],
        summary: 'Found a critical issue'
      }).mockResolvedValueOnce({
        suggestions: [
          { file: 'src/bar.js', line_start: 5, line_end: 5, type: 'improvement', title: 'Style', confidence: 0.6 }
        ],
        summary: null
      });

      vi.spyOn(analyzer, '_executeCouncilVoice').mockImplementation(() => voiceCall());

      const result = await analyzer.runCouncilAnalysis(reviewContext, multiVoiceConfig, { runId: 'test-run' });

      expect(result.summary).toBe('Found a critical issue');
    });

    it('should propagate summary when all voices return 0 suggestions but have summaries', async () => {
      const voiceCall = vi.fn();

      voiceCall.mockResolvedValueOnce({
        suggestions: [],
        summary: 'Level 1: No issues found in changed lines'
      }).mockResolvedValueOnce({
        suggestions: [],
        summary: 'Level 2: File context looks consistent'
      });

      vi.spyOn(analyzer, '_executeCouncilVoice').mockImplementation(() => voiceCall());

      const result = await analyzer.runCouncilAnalysis(reviewContext, multiVoiceConfig, { runId: 'test-run' });

      // Both summaries should be joined
      expect(result.summary).toContain('Level 1: No issues found in changed lines');
      expect(result.summary).toContain('Level 2: File context looks consistent');
      expect(result.suggestions).toEqual([]);
    });

    it('should use generic fallback when no voice returns a summary', async () => {
      const voiceCall = vi.fn();

      voiceCall.mockResolvedValueOnce({
        suggestions: [
          { file: 'src/foo.js', line_start: 1, line_end: 1, type: 'bug', title: 'Bug', confidence: 0.9 }
        ],
        summary: null
      }).mockResolvedValueOnce({
        suggestions: [],
        summary: null
      });

      vi.spyOn(analyzer, '_executeCouncilVoice').mockImplementation(() => voiceCall());

      const result = await analyzer.runCouncilAnalysis(reviewContext, multiVoiceConfig, { runId: 'test-run' });

      expect(result.summary).toContain('Council analysis complete');
      expect(result.summary).toContain('consolidation skipped');
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
