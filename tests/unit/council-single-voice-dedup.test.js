// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Regression test for the single-voice fast path of runReviewerCentricCouncil.
 *
 * Bug history: when a council was configured with exactly one reviewer voice
 * the fast path forwarded `excludePrevious` and `serverPort` to the inner
 * `analyzeAllLevels` call, but omitted `githubClient`. Without the client the
 * dedup pre-fetch of existing PR review comments is skipped and the GitHub
 * dedup section becomes a silent no-op — matching the bug that the multi-voice
 * path already avoids by threading `githubClient` through `_crossVoiceConsolidate`.
 *
 * This test pins the single-voice fast path so it forwards `githubClient`
 * alongside the other dedup options.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

describe('runReviewerCentricCouncil — single-voice fast path forwards githubClient', () => {
  let analyzer;

  beforeEach(() => {
    vi.clearAllMocks();
    analyzer = new Analyzer({}, 'sonnet', 'claude');
    analyzer.loadGeneratedFilePatterns = vi.fn().mockResolvedValue({ getPatterns: () => [] });
    analyzer.getChangedFilesList = vi.fn().mockResolvedValue(['src/foo.js']);
    analyzer.storeSuggestions = vi.fn().mockResolvedValue(undefined);
    analyzer.validateAndFinalizeSuggestions = vi.fn().mockImplementation((s) => s || []);
  });

  it('passes githubClient through to analyzeAllLevels alongside excludePrevious/serverPort', async () => {
    const fakeGithubClient = {
      octokit: { rest: { pulls: { listReviewComments: vi.fn() } }, paginate: vi.fn().mockResolvedValue([]) }
    };

    const reviewContext = {
      reviewId: 1,
      worktreePath: '/tmp/test-worktree',
      prMetadata: { head_sha: 'abc123', owner: 'acme', repo: 'widget', pr_number: 42 },
      changedFiles: ['src/foo.js'],
      instructions: { repoInstructions: null, requestInstructions: null }
    };
    const councilConfig = {
      voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }],
      levels: { '1': true, '2': true, '3': false }
    };

    const analyzeAllLevelsSpy = vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockResolvedValue({
      suggestions: [],
      summary: 'done'
    });

    await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, {
      analysisId: 'an-id',
      runId: 'parent-run-id',
      excludePrevious: { github: true, feedback: false },
      serverPort: 7247,
      githubClient: fakeGithubClient
    });

    expect(analyzeAllLevelsSpy).toHaveBeenCalledTimes(1);
    const passedOptions = analyzeAllLevelsSpy.mock.calls[0][6];
    // Pin the wiring: the inner call must receive all three dedup-related options.
    expect(passedOptions).toHaveProperty('excludePrevious');
    expect(passedOptions.excludePrevious).toEqual({ github: true, feedback: false });
    expect(passedOptions).toHaveProperty('serverPort', 7247);
    expect(passedOptions).toHaveProperty('githubClient');
    expect(passedOptions.githubClient).toBe(fakeGithubClient);
  });
});
