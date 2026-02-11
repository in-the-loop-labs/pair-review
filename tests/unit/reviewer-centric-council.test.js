// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for runReviewerCentricCouncil in analyzer.js
 *
 * Verifies that storeSuggestions is called for the parent run ID on:
 * - Single-voice early return path (no consolidation needed)
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

vi.mock('../../src/database', () => ({
  AnalysisRunRepository: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({})
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
    it('should call storeSuggestions with parent run ID when only one voice succeeds', async () => {
      const { reviewContext, councilConfig, options } = buildTestContext();
      const mockSuggestions = buildMockSuggestions(3);

      // Mock analyzeAllLevels on child Analyzer instances created inside the method
      vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockResolvedValue({
        suggestions: mockSuggestions,
        summary: 'Test summary'
      });

      const result = await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options);

      // Verify storeSuggestions was called with parent run ID
      expect(analyzer.storeSuggestions).toHaveBeenCalledWith(
        reviewContext.reviewId,
        'parent-run-id',
        mockSuggestions,
        null,
        expect.any(Array)
      );

      // Verify validateAndFinalizeSuggestions was called
      expect(analyzer.validateAndFinalizeSuggestions).toHaveBeenCalledWith(
        mockSuggestions,
        expect.anything(), // fileLineCountMap
        expect.any(Array)  // validFiles
      );

      // Verify result structure
      expect(result.runId).toBe('parent-run-id');
      expect(result.suggestions).toEqual(mockSuggestions);
      expect(result.summary).toBe('Test summary');
    });

    it('should store validated suggestions (not raw) for single-voice path', async () => {
      const { reviewContext, councilConfig, options } = buildTestContext();
      const rawSuggestions = buildMockSuggestions(3);
      const validatedSuggestions = [rawSuggestions[0], rawSuggestions[2]]; // simulate filtering

      vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockResolvedValue({
        suggestions: rawSuggestions,
        summary: 'Test summary'
      });

      // validateAndFinalizeSuggestions removes one suggestion
      analyzer.validateAndFinalizeSuggestions = vi.fn().mockReturnValue(validatedSuggestions);

      const result = await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options);

      // storeSuggestions should receive the validated (filtered) list
      expect(analyzer.storeSuggestions).toHaveBeenCalledWith(
        reviewContext.reviewId,
        'parent-run-id',
        validatedSuggestions,
        null,
        expect.any(Array)
      );

      // Return value should also use validated suggestions
      expect(result.suggestions).toEqual(validatedSuggestions);
      // When the voice has a summary, it's used as-is
      expect(result.summary).toBe('Test summary');
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
