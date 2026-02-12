// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for runReviewerCentricCouncil in analyzer.js
 *
 * Verifies:
 * - Single-voice path: analyzeAllLevels runs directly on parent run (no child run)
 * - Below-threshold path (suggestions < COUNCIL_CONSOLIDATION_THRESHOLD)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/ai/index', () => ({
  createProvider: vi.fn()
}));

vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({ getPatterns: () => [] })
}));

vi.mock('../../src/utils/line-validation', () => ({
  buildFileLineCountMap: vi.fn().mockResolvedValue(new Map()),
  validateSuggestionLineNumbers: vi.fn().mockReturnValue({
    valid: [],
    converted: [],
    dropped: []
  })
}));

const mockRunRepoCreate = vi.fn().mockResolvedValue({});
const mockRunRepoUpdate = vi.fn().mockResolvedValue({});
vi.mock('../../src/database', () => ({
  AnalysisRunRepository: vi.fn().mockImplementation(() => ({
    create: mockRunRepoCreate,
    update: mockRunRepoUpdate
  })),
  run: vi.fn().mockResolvedValue({}),
  get: vi.fn().mockResolvedValue(null),
  all: vi.fn().mockResolvedValue([])
}));

vi.mock('../../src/routes/shared', () => ({
  registerProcess: vi.fn(),
  isAnalysisCancelled: vi.fn().mockReturnValue(false),
  CancellationError: class CancellationError extends Error {
    constructor(msg) { super(msg); this.isCancellation = true; }
  }
}));

vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('mock-uuid-child')
}));

const Analyzer = require('../../src/ai/analyzer');
const { AnalysisRunRepository } = require('../../src/database');
const { CancellationError } = require('../../src/routes/shared');

/**
 * Helper: build a minimal reviewContext and councilConfig for tests
 */
function buildTestContext(overrides = {}) {
  return {
    reviewContext: {
      reviewId: 1,
      worktreePath: '/tmp/test-worktree',
      prMetadata: { head_sha: 'abc123' },
      changedFiles: ['src/foo.js', 'src/bar.js'],
      instructions: { repoInstructions: null, requestInstructions: null }
    },
    councilConfig: {
      voices: [
        { provider: 'claude', model: 'sonnet', tier: 'balanced' },
        ...(overrides.extraVoices || [])
      ],
      levels: { '1': true, '2': true, '3': false },
      consolidation: { provider: 'claude', model: 'opus', tier: 'balanced' }
    },
    options: {
      analysisId: 'test-analysis-id',
      runId: 'parent-run-id',
      progressCallback: null
    },
    ...overrides
  };
}

/**
 * Build mock suggestions for testing
 */
function buildMockSuggestions(count) {
  return Array.from({ length: count }, (_, i) => ({
    file: 'src/foo.js',
    title: `Suggestion ${i + 1}`,
    description: `Description ${i + 1}`,
    type: 'improvement',
    line_start: i + 1,
    line_end: i + 1
  }));
}

describe('runReviewerCentricCouncil', () => {
  let analyzer;

  beforeEach(() => {
    vi.clearAllMocks();

    analyzer = new Analyzer({}, 'sonnet', 'claude');

    // Mock internal methods that we don't want to actually execute
    analyzer.loadGeneratedFilePatterns = vi.fn().mockResolvedValue({ getPatterns: () => [] });
    analyzer.getChangedFilesList = vi.fn().mockResolvedValue(['src/foo.js', 'src/bar.js']);
    analyzer.storeSuggestions = vi.fn().mockResolvedValue(undefined);
    analyzer.validateSuggestionFilePaths = vi.fn().mockImplementation((suggestions) => suggestions || []);

    // Mock validateAndFinalizeSuggestions to return suggestions as-is by default
    analyzer.validateAndFinalizeSuggestions = vi.fn().mockImplementation((suggestions) => suggestions || []);
  });

  describe('single-voice early return path', () => {
    it('should run analyzeAllLevels directly on parent run with no child run', async () => {
      const progressCallback = vi.fn();
      const { reviewContext, councilConfig, options } = buildTestContext({
        options: {
          analysisId: 'test-analysis-id',
          runId: 'parent-run-id',
          progressCallback
        }
      });
      const mockSuggestions = buildMockSuggestions(3);

      const analyzeAllLevelsSpy = vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockResolvedValue({
        suggestions: mockSuggestions,
        summary: 'Test summary'
      });

      const result = await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options);

      // analyzeAllLevels should be called with parent run ID and skipRunCreation
      expect(analyzeAllLevelsSpy).toHaveBeenCalledWith(
        reviewContext.reviewId,
        reviewContext.worktreePath,
        reviewContext.prMetadata,
        expect.any(Function),
        expect.objectContaining({ repoInstructions: null }),
        reviewContext.changedFiles,
        expect.objectContaining({
          runId: 'parent-run-id',
          skipRunCreation: true,
          reviewerNum: 1
        })
      );

      // The callback passed to analyzeAllLevels should be the wrapped version (not the raw one)
      const passedCallback = analyzeAllLevelsSpy.mock.calls[0][3];
      expect(passedCallback).not.toBe(progressCallback);

      // No child run should be created — only the parent run creation (or none if runId provided)
      // Since options.runId is set, no create calls at all
      expect(mockRunRepoCreate).not.toHaveBeenCalled();

      // storeSuggestions and validateAndFinalizeSuggestions should NOT be called
      // by runReviewerCentricCouncil — analyzeAllLevels handles it internally
      expect(analyzer.storeSuggestions).not.toHaveBeenCalled();
      expect(analyzer.validateAndFinalizeSuggestions).not.toHaveBeenCalled();

      // Verify result structure
      expect(result.runId).toBe('parent-run-id');
      expect(result.suggestions).toEqual(mockSuggestions);
      expect(result.summary).toBe('Test summary');
    });

    it('should pass voice-specific options to analyzeAllLevels', async () => {
      const { reviewContext, options } = buildTestContext();
      const councilConfig = {
        voices: [
          { provider: 'gemini', model: 'pro', tier: 'thorough', timeout: 300000, customInstructions: 'Be strict' }
        ],
        levels: { '1': true, '2': true, '3': false },
        consolidation: { provider: 'claude', model: 'opus', tier: 'balanced' }
      };
      const mockSuggestions = buildMockSuggestions(2);

      const analyzeAllLevelsSpy = vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockResolvedValue({
        suggestions: mockSuggestions,
        summary: 'Strict review'
      });

      await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options);

      // Should use voice's tier, timeout, and custom instructions
      expect(analyzeAllLevelsSpy).toHaveBeenCalledOnce();
      const [, , , , passedInstructions, , passedOptions] = analyzeAllLevelsSpy.mock.calls[0];
      expect(passedInstructions.requestInstructions).toBe('Be strict');
      expect(passedOptions.tier).toBe('thorough');
      expect(passedOptions.timeout).toBe(300000);
    });

    it('should wrap progressCallback with voiceCentric metadata', async () => {
      const { reviewContext, councilConfig } = buildTestContext();
      const mockSuggestions = buildMockSuggestions(2);
      const progressCallback = vi.fn();

      const analyzeAllLevelsSpy = vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockResolvedValue({
        suggestions: mockSuggestions,
        summary: 'Test summary'
      });

      await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, {
        analysisId: 'test-analysis-id',
        runId: 'parent-run-id',
        progressCallback
      });

      // Should send voice-init progress update with voice metadata
      expect(progressCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          voiceCentric: true,
          level: 'voice-init',
          status: 'running',
          voices: expect.objectContaining({
            'claude-sonnet': expect.objectContaining({
              status: 'pending',
              provider: 'claude',
              model: 'sonnet'
            })
          })
        })
      );

      // The callback passed to analyzeAllLevels should be the wrapped version (not raw)
      const passedCallback = analyzeAllLevelsSpy.mock.calls[0][3];
      expect(passedCallback).not.toBe(progressCallback);

      // Simulate analyzeAllLevels calling the wrapped callback
      passedCallback({ level: 1, status: 'completed', progress: 'Done' });

      // The raw progressCallback should receive the update with voiceCentric metadata injected
      expect(progressCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 1,
          status: 'completed',
          progress: 'Done',
          voiceCentric: true,
          voiceId: 'claude-sonnet'
        })
      );
    });

    it('should re-throw CancellationError without updating run status (analyzeAllLevels handles it)', async () => {
      const { reviewContext, councilConfig, options } = buildTestContext();
      const cancellationError = new CancellationError('Analysis was cancelled');

      vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockRejectedValue(cancellationError);

      await expect(
        analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options)
      ).rejects.toThrow(cancellationError);

      // runReviewerCentricCouncil should NOT update the run status itself;
      // analyzeAllLevels is responsible for that (and it's mocked here)
      expect(mockRunRepoUpdate).not.toHaveBeenCalled();
    });

    it('should re-throw generic error without updating run status (analyzeAllLevels handles it)', async () => {
      const { reviewContext, councilConfig, options } = buildTestContext();
      const genericError = new Error('Something went wrong');

      vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockRejectedValue(genericError);

      await expect(
        analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options)
      ).rejects.toThrow(genericError);

      // runReviewerCentricCouncil should NOT update the run status itself;
      // analyzeAllLevels is responsible for that (and it's mocked here)
      expect(mockRunRepoUpdate).not.toHaveBeenCalled();
    });
  });

  describe('below-threshold path (< COUNCIL_CONSOLIDATION_THRESHOLD)', () => {
    it('should call storeSuggestions with parent run ID when suggestions are below threshold', async () => {
      // Use two voices so we don't hit the single-voice path,
      // but keep total suggestions below 8 (the threshold)
      const { reviewContext, councilConfig, options } = buildTestContext({
        extraVoices: [{ provider: 'gemini', model: 'pro', tier: 'balanced' }]
      });

      const voice1Suggestions = buildMockSuggestions(3);
      const voice2Suggestions = buildMockSuggestions(2);

      // Each voice's analyzeAllLevels returns a few suggestions
      let callCount = 0;
      vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          return { suggestions: voice1Suggestions, summary: 'Voice 1 summary' };
        }
        return { suggestions: voice2Suggestions, summary: 'Voice 2 summary' };
      });

      const allSuggestions = [...voice1Suggestions, ...voice2Suggestions];
      analyzer.validateAndFinalizeSuggestions = vi.fn().mockReturnValue(allSuggestions);

      const result = await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options);

      // 5 total suggestions < 8 threshold, so should skip consolidation
      // and store directly under parent run ID
      expect(analyzer.storeSuggestions).toHaveBeenCalledWith(
        reviewContext.reviewId,
        'parent-run-id',
        allSuggestions,
        null,
        expect.any(Array)
      );

      // Verify validateAndFinalizeSuggestions was called
      expect(analyzer.validateAndFinalizeSuggestions).toHaveBeenCalled();

      expect(result.runId).toBe('parent-run-id');
      expect(result.suggestions).toEqual(allSuggestions);
    });

    it('should store validated suggestions (not raw) for below-threshold path', async () => {
      const { reviewContext, councilConfig, options } = buildTestContext({
        extraVoices: [{ provider: 'gemini', model: 'pro', tier: 'balanced' }]
      });

      const voice1Suggestions = buildMockSuggestions(2);
      const voice2Suggestions = buildMockSuggestions(2);

      let callCount = 0;
      vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          return { suggestions: voice1Suggestions, summary: 'V1' };
        }
        return { suggestions: voice2Suggestions, summary: 'V2' };
      });

      // Simulate validation filtering out one suggestion
      const filteredSuggestions = [...voice1Suggestions, voice2Suggestions[0]];
      analyzer.validateAndFinalizeSuggestions = vi.fn().mockReturnValue(filteredSuggestions);

      const result = await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options);

      // storeSuggestions should receive the validated (filtered) list
      expect(analyzer.storeSuggestions).toHaveBeenCalledWith(
        reviewContext.reviewId,
        'parent-run-id',
        filteredSuggestions,
        null,
        expect.any(Array)
      );

      expect(result.suggestions).toEqual(filteredSuggestions);
    });

    it('should return validated suggestions with correct count after filtering', async () => {
      const { reviewContext, councilConfig, options } = buildTestContext({
        extraVoices: [{ provider: 'gemini', model: 'pro', tier: 'balanced' }]
      });

      const voice1Suggestions = buildMockSuggestions(3);
      const voice2Suggestions = buildMockSuggestions(2);

      let callCount = 0;
      vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          return { suggestions: voice1Suggestions, summary: 'V1' };
        }
        return { suggestions: voice2Suggestions, summary: 'V2' };
      });

      // Simulate validation removing 3 of 5 suggestions
      const filteredSuggestions = [voice1Suggestions[0], voice2Suggestions[0]];
      analyzer.validateAndFinalizeSuggestions = vi.fn().mockReturnValue(filteredSuggestions);

      const result = await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options);

      // Return value should reflect validated count (2), not raw count (5)
      expect(result.suggestions).toEqual(filteredSuggestions);
      expect(result.suggestions).toHaveLength(2);
      expect(result.summary).toContain(`${filteredSuggestions.length}`);

      // storeSuggestions should receive the validated list
      expect(analyzer.storeSuggestions).toHaveBeenCalledWith(
        reviewContext.reviewId,
        'parent-run-id',
        filteredSuggestions,
        null,
        expect.any(Array)
      );
    });
  });
});
