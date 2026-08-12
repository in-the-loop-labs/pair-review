// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';

// analyzer.js destructures createProvider from src/ai/index at load time
// (line 2), so the binding is captured the first time the module is required.
// Install the spy on the module object BEFORE requiring the Analyzer so the
// destructured binding picks up the spy. (vi.mock would also work — see
// analyzer-consolidation.test.js — but a spy lets us swap the return value
// per test.)
const aiIndex = require('../../src/ai/index');
const createProvider = vi.spyOn(aiIndex, 'createProvider');

const Analyzer = require('../../src/ai/analyzer');

/**
 * Regression tests for issue #560: consolidation could silently drop every
 * suggestion when the model response failed JSON extraction, yet still report
 * `consolidation: 'success'`. These tests verify that a parse failure with
 * non-empty input takes the fallback path (raw suggestions preserved) and is
 * reported as a failure, while a legitimately empty, parseable response
 * (`suggestions: []`) still counts as success.
 */

const prMetadata = { pr_number: 42, reviewType: 'pr', title: 'Test PR' };

function mockProviderResponse(response) {
  createProvider.mockReturnValue({
    execute: vi.fn().mockResolvedValue(response)
  });
}

const inputSuggestions = {
  level1: [
    { file: 'src/a.js', line_start: 1, line_end: 1, type: 'bug', title: 'Bug A', description: 'desc A', confidence: 0.9 }
  ],
  level2: [
    { file: 'src/b.js', line_start: 2, line_end: 2, type: 'improvement', title: 'Imp B', description: 'desc B', confidence: 0.8 }
  ],
  level3: []
};

describe('parseResponseWithMeta', () => {
  let analyzer;

  beforeEach(() => {
    vi.clearAllMocks();
    analyzer = new Analyzer({}, 'sonnet', 'claude');
  });

  it('reports parseFailed: false for a response with a suggestions array', () => {
    const result = analyzer.parseResponseWithMeta({ suggestions: [] }, 'consolidation');
    expect(result.parseFailed).toBe(false);
    expect(result.suggestions).toEqual([]);
  });

  it('reports parseFailed: false for raw text containing extractable JSON', () => {
    const result = analyzer.parseResponseWithMeta(
      { raw: '{"suggestions": [], "summary": "clean"}' },
      'consolidation'
    );
    expect(result.parseFailed).toBe(false);
  });

  it('reports parseFailed: false for a response with only a fileLevelSuggestions array', () => {
    const result = analyzer.parseResponseWithMeta(
      {
        fileLevelSuggestions: [{ file: 'src/a.js', type: 'design', title: 'Split module', description: 'd', confidence: 0.9 }],
        summary: 'file-level only'
      },
      'consolidation'
    );
    expect(result.parseFailed).toBe(false);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].is_file_level).toBe(true);
  });

  it('reports parseFailed: false for a raw summary-only zero-finding response', () => {
    const result = analyzer.parseResponseWithMeta(
      { raw: '{"summary": "All findings duplicated existing comments"}' },
      'consolidation'
    );
    expect(result.parseFailed).toBe(false);
    expect(result.suggestions).toEqual([]);
  });

  it('reports parseFailed: false for an already-parsed summary-only zero-finding response', () => {
    const result = analyzer.parseResponseWithMeta(
      { summary: 'All findings duplicated existing comments' },
      'consolidation'
    );
    expect(result.parseFailed).toBe(false);
    expect(result.suggestions).toEqual([]);
  });

  it('prefers extractable suggestions in raw over a summary-only acceptance for a { summary, raw } response', () => {
    const result = analyzer.parseResponseWithMeta(
      {
        summary: 'top-level summary',
        raw: '{"suggestions": [{"file": "src/a.js", "line_start": 1, "line_end": 1, "type": "bug", "title": "From raw", "description": "d", "confidence": 0.9}]}'
      },
      'consolidation'
    );
    expect(result.parseFailed).toBe(false);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].title).toBe('From raw');
  });

  it('accepts summary-only for a { summary, raw } response when raw extraction fails', () => {
    const result = analyzer.parseResponseWithMeta(
      { summary: 'All findings duplicated existing comments', raw: 'not json at all' },
      'consolidation'
    );
    expect(result.parseFailed).toBe(false);
    expect(result.suggestions).toEqual([]);
  });

  it('reports parseFailed: true for extractable JSON with none of the schema keys', () => {
    const result = analyzer.parseResponseWithMeta({ raw: '{"foo": 1}' }, 'consolidation');
    expect(result.parseFailed).toBe(true);
    expect(result.suggestions).toEqual([]);
  });

  it('reports parseFailed: true for raw text with no extractable JSON', () => {
    const result = analyzer.parseResponseWithMeta({ raw: 'not json at all' }, 'consolidation');
    expect(result.parseFailed).toBe(true);
    expect(result.suggestions).toEqual([]);
  });

  it('reports parseFailed: true for a response with neither suggestions nor raw', () => {
    const result = analyzer.parseResponseWithMeta({}, 'consolidation');
    expect(result.parseFailed).toBe(true);
  });

  it('parseResponse still returns a bare suggestions array', () => {
    const suggestions = analyzer.parseResponse({ suggestions: [] }, 'consolidation');
    expect(suggestions).toEqual([]);
  });
});

describe('orchestrateWithAI parse-failure fallback (issue #560)', () => {
  let analyzer;

  beforeEach(() => {
    vi.clearAllMocks();
    analyzer = new Analyzer({}, 'sonnet', 'claude');
  });

  it('falls back to the raw union and flags consolidationFailed when the response is unparseable and input was non-empty', async () => {
    mockProviderResponse({ raw: 'The review looked at several files but the output is not JSON.' });

    const result = await analyzer.orchestrateWithAI(inputSuggestions, prMetadata, null, null, { timeout: 1000 });

    expect(result.consolidationFailed).toBe(true);
    // Both input suggestions must be preserved, not silently dropped
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions.map(s => s.title).sort()).toEqual(['Bug A', 'Imp B']);
    expect(result.summary).toContain('consolidation failed');
  });

  it('reports success for a parseable response that legitimately returns zero suggestions', async () => {
    mockProviderResponse({ suggestions: [], summary: 'All findings were duplicates of existing comments' });

    const result = await analyzer.orchestrateWithAI(inputSuggestions, prMetadata, null, null, { timeout: 1000 });

    expect(result.consolidationFailed).toBeUndefined();
    expect(result.suggestions).toEqual([]);
    expect(result.summary).toBe('All findings were duplicates of existing comments');
  });

  it('reports success for an already-parsed summary-only response with non-empty input', async () => {
    // Providers resolve parsed objects directly, so a zero-finding
    // consolidation legitimately arrives as `{ summary }` with no arrays
    mockProviderResponse({ summary: 'All findings duplicated existing comments' });

    const result = await analyzer.orchestrateWithAI(inputSuggestions, prMetadata, null, null, { timeout: 1000 });

    expect(result.consolidationFailed).toBeUndefined();
    expect(result.suggestions).toEqual([]);
    expect(result.summary).toBe('All findings duplicated existing comments');
  });

  it('does not flag failure for an unparseable response when there were no input suggestions', async () => {
    mockProviderResponse({ raw: 'nothing to consolidate' });

    const result = await analyzer.orchestrateWithAI(
      { level1: [], level2: [], level3: [] }, prMetadata, null, null, { timeout: 1000 }
    );

    expect(result.consolidationFailed).toBeUndefined();
    expect(result.suggestions).toEqual([]);
  });
});

describe('_crossVoiceConsolidate parse-failure handling (issue #560)', () => {
  let analyzer;

  const voiceReviews = [
    {
      voiceKey: 'voice-1',
      provider: 'claude',
      model: 'opus',
      suggestionCount: 7,
      suggestions: [{ file: 'src/a.js', line_start: 1, type: 'bug', title: 'V1', description: 'd' }],
      fileLevelSuggestions: [],
      summary: 'Voice 1 summary'
    },
    {
      voiceKey: 'voice-2',
      provider: 'codex',
      model: 'gpt',
      suggestionCount: 6,
      suggestions: [{ file: 'src/b.js', line_start: 2, type: 'bug', title: 'V2', description: 'd' }],
      fileLevelSuggestions: [],
      summary: 'Voice 2 summary'
    }
  ];

  const config = { provider: 'claude', model: 'opus', tier: 'balanced', timeout: 1000 };

  beforeEach(() => {
    vi.clearAllMocks();
    analyzer = new Analyzer({}, 'sonnet', 'claude');
  });

  it('throws when the consolidation response is unparseable and voices produced suggestions', async () => {
    mockProviderResponse({ raw: 'definitely not json' });

    await expect(
      analyzer._crossVoiceConsolidate(voiceReviews, prMetadata, null, null, config)
    ).rejects.toThrow(/could not be parsed/);
  });

  it('does not throw for a parseable response with zero suggestions', async () => {
    mockProviderResponse({ suggestions: [], summary: 'Nothing new to report' });

    const result = await analyzer._crossVoiceConsolidate(voiceReviews, prMetadata, null, null, config);
    expect(result.suggestions).toEqual([]);
    expect(result.summary).toBe('Nothing new to report');
  });

  it('does not throw for an unparseable response when voices produced no suggestions', async () => {
    mockProviderResponse({ raw: 'not json' });
    const emptyVoices = voiceReviews.map(v => ({ ...v, suggestionCount: 0, suggestions: [] }));

    const result = await analyzer._crossVoiceConsolidate(emptyVoices, prMetadata, null, null, config);
    expect(result.suggestions).toEqual([]);
  });
});

describe('_intraLevelConsolidate parse-failure handling (issue #560)', () => {
  let analyzer;

  const voiceGroups = [
    {
      voiceId: 'v1',
      provider: 'claude',
      model: 'opus',
      suggestions: [{ file: 'src/a.js', line_start: 1, type: 'bug', title: 'V1', description: 'd' }],
      summary: 's1'
    },
    {
      voiceId: 'v2',
      provider: 'codex',
      model: 'gpt',
      suggestions: [{ file: 'src/b.js', line_start: 2, type: 'bug', title: 'V2', description: 'd' }],
      summary: 's2'
    }
  ];

  const orchConfig = { provider: 'claude', model: 'opus', tier: 'balanced', timeout: 1000, reviewerCount: 2 };

  beforeEach(() => {
    vi.clearAllMocks();
    analyzer = new Analyzer({}, 'sonnet', 'claude');
  });

  it('throws when the consolidation response is unparseable and reviewers produced suggestions', async () => {
    mockProviderResponse({ raw: 'garbage output' });

    await expect(
      analyzer._intraLevelConsolidate(1, voiceGroups, prMetadata, null, null, orchConfig)
    ).rejects.toThrow(/could not be parsed/);
  });

  it('returns consolidated suggestions for a parseable response', async () => {
    mockProviderResponse({
      suggestions: [{ file: 'src/a.js', line_start: 1, line_end: 1, type: 'bug', title: 'Merged', description: 'd', confidence: 0.9 }]
    });

    const result = await analyzer._intraLevelConsolidate(1, voiceGroups, prMetadata, null, null, orchConfig);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Merged');
  });
});

// Wiring tests: verify that consolidation parse failures propagate through the
// full analysis flows into the persisted/returned levelOutcomes, not just the
// parse primitives. DB access is stubbed on the instance (analysis_run repo
// calls inside these flows are wrapped in try/catch, so a bare `{}` db is safe).
describe('analyzeAllLevels consolidation outcome mapping (issue #560)', () => {
  function createWiredAnalyzer() {
    const analyzer = new Analyzer({}, 'sonnet', 'claude');
    analyzer.loadGeneratedFilePatterns = vi.fn().mockResolvedValue([]);
    analyzer.getChangedFilesList = vi.fn().mockResolvedValue(['src/a.js', 'src/b.js']);
    analyzer.storeSuggestions = vi.fn().mockResolvedValue(undefined);
    analyzer.validateAndFinalizeSuggestions = vi.fn().mockImplementation((s) => s || []);
    // Levels succeed with suggestions; only the consolidation call reaches the provider
    analyzer.analyzeLevel1Isolated = vi.fn().mockResolvedValue({ suggestions: inputSuggestions.level1, summary: 'L1' });
    analyzer.analyzeLevel2Isolated = vi.fn().mockResolvedValue({ suggestions: inputSuggestions.level2, summary: 'L2' });
    analyzer.analyzeLevel3Isolated = vi.fn().mockResolvedValue({ suggestions: [], summary: 'L3' });
    return analyzer;
  }

  const runOptions = { runId: 'run-560', skipRunCreation: true, timeout: 1000 };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records levelOutcomes.consolidation = failed and orchestrationFailed when the consolidation response is unparseable', async () => {
    const analyzer = createWiredAnalyzer();
    mockProviderResponse({ raw: 'this is prose, not our JSON schema' });
    const progressCallback = vi.fn();

    const result = await analyzer.analyzeAllLevels(
      1, '/nonexistent-worktree', prMetadata, progressCallback, null, ['src/a.js', 'src/b.js'], runOptions
    );

    expect(result.levelOutcomes.consolidation).toBe('failed');
    expect(result.orchestrationFailed).toBe(true);
    // The raw union of level suggestions is preserved, not silently dropped
    expect(result.suggestions).toHaveLength(2);
    expect(progressCallback).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'orchestration', status: 'failed' })
    );
  });

  it('records levelOutcomes.consolidation = success for a parseable consolidation response', async () => {
    const analyzer = createWiredAnalyzer();
    mockProviderResponse({
      suggestions: [{ file: 'src/a.js', line_start: 1, line_end: 1, type: 'bug', title: 'Curated', description: 'd', confidence: 0.9 }],
      summary: 'curated'
    });

    const result = await analyzer.analyzeAllLevels(
      1, '/nonexistent-worktree', prMetadata, null, null, ['src/a.js', 'src/b.js'], runOptions
    );

    expect(result.levelOutcomes.consolidation).toBe('success');
    expect(result.orchestrationFailed).toBeUndefined();
    expect(result.suggestions).toHaveLength(1);
  });
});

describe('runCouncilAnalysis intra-level consolidation failure (issue #560)', () => {
  const voiceSuggestion = (title) => ({
    file: 'src/a.js', line_start: 1, line_end: 1, type: 'bug', title, description: 'd', confidence: 0.9
  });

  function createCouncilAnalyzer() {
    const analyzer = new Analyzer({}, 'sonnet', 'claude');
    analyzer.loadGeneratedFilePatterns = vi.fn().mockResolvedValue([]);
    analyzer.getChangedFilesList = vi.fn().mockResolvedValue(['src/a.js']);
    analyzer.storeSuggestions = vi.fn().mockResolvedValue(undefined);
    analyzer._storeCouncilSuggestions = vi.fn().mockResolvedValue(undefined);
    analyzer.validateAndFinalizeSuggestions = vi.fn().mockImplementation((s) => s || []);
    analyzer.buildLevel1Prompt = vi.fn().mockReturnValue('level 1 prompt');
    return analyzer;
  }

  const reviewContext = {
    reviewId: 1,
    worktreePath: '/nonexistent-worktree',
    prMetadata,
    changedFiles: ['src/a.js'],
    instructions: null
  };

  const councilConfig = {
    levels: {
      '1': {
        enabled: true,
        voices: [
          { provider: 'claude', model: 'opus' },
          { provider: 'codex', model: 'gpt' }
        ]
      },
      '2': { enabled: false, voices: [] },
      '3': { enabled: false, voices: [] }
    },
    consolidation: { provider: 'claude', model: 'opus', tier: 'balanced' }
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports consolidation failed when Pass 1 is unparseable even though Pass 2 succeeds', async () => {
    const analyzer = createCouncilAnalyzer();

    // Dispatch by the level passed to the provider: reviewer voices succeed,
    // intra-level (Pass 1) consolidation is unparseable, cross-level (Pass 2) succeeds
    createProvider.mockReturnValue({
      execute: vi.fn().mockImplementation((prompt, opts) => {
        if (opts.level === 1) {
          return Promise.resolve({ suggestions: [voiceSuggestion('Voice finding')], summary: 'voice summary' });
        }
        if (opts.level === 'consolidation-L1') {
          return Promise.resolve({ raw: 'garbage — not our JSON schema' });
        }
        return Promise.resolve({ suggestions: [voiceSuggestion('Merged finding')], summary: 'final summary' });
      })
    });

    const result = await analyzer.runCouncilAnalysis(reviewContext, councilConfig, { runId: 'council-run' });

    expect(result.levelOutcomes.consolidation).toBe('failed');
    expect(result.orchestrationFailed).toBe(true);
    // Pass 2 output is still used for the final set
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].title).toBe('Merged finding');
  });

  it('reports consolidation success when both passes parse', async () => {
    const analyzer = createCouncilAnalyzer();

    createProvider.mockReturnValue({
      execute: vi.fn().mockImplementation((prompt, opts) => {
        if (opts.level === 1) {
          return Promise.resolve({ suggestions: [voiceSuggestion('Voice finding')], summary: 'voice summary' });
        }
        return Promise.resolve({ suggestions: [voiceSuggestion('Merged finding')], summary: 'final summary' });
      })
    });

    const result = await analyzer.runCouncilAnalysis(reviewContext, councilConfig, { runId: 'council-run' });

    expect(result.levelOutcomes.consolidation).toBe('success');
    expect(result.orchestrationFailed).toBeUndefined();
  });
});
