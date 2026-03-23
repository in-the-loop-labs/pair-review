// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  buildReviewStartedPayload,
  buildReviewLoadedPayload,
  buildAnalysisStartedPayload,
  buildAnalysisCompletedPayload,
  buildChatStartedPayload,
  buildChatResumedPayload,
  buildChatHookContext,
  getCachedUser,
  fireReviewStartedHook,
  _resetUserCache,
} = require('../../src/hooks/payloads');

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

describe('hook payloads', () => {
  beforeEach(() => {
    _resetUserCache();
    vi.clearAllMocks();
  });

  // ── buildReviewStartedPayload / buildReviewLoadedPayload ──────

  describe('buildReviewStartedPayload', () => {
    it('PR mode: includes pr field, no local field, event is review.started', () => {
      const payload = buildReviewStartedPayload({
        reviewId: 42,
        mode: 'pr',
        prContext: { owner: 'acme', repo: 'widgets', number: 7, baseSha: 'aaa', headSha: 'bbb' },
      });

      expect(payload.event).toBe('review.started');
      expect(payload.pr).toEqual({ owner: 'acme', repo: 'widgets', number: 7, baseSha: 'aaa', headSha: 'bbb' });
      expect(payload).not.toHaveProperty('local');
    });

    it('Local mode: includes local field with headSha, no pr field', () => {
      const payload = buildReviewStartedPayload({
        reviewId: 99,
        mode: 'local',
        localContext: { path: '/tmp/repo', branch: 'main', headSha: 'abc123' },
      });

      expect(payload.local).toEqual({ path: '/tmp/repo', branch: 'main', headSha: 'abc123' });
      expect(payload).not.toHaveProperty('pr');
    });

    it('with user: includes user object', () => {
      const payload = buildReviewStartedPayload({
        reviewId: 1,
        mode: 'pr',
        prContext: { owner: 'o', repo: 'r', number: 1 },
        user: { login: 'octocat' },
      });

      expect(payload.user).toEqual({ login: 'octocat' });
    });

    it('without user (null): user field NOT present in payload', () => {
      const payload = buildReviewStartedPayload({
        reviewId: 1,
        mode: 'pr',
        prContext: { owner: 'o', repo: 'r', number: 1 },
        user: null,
      });

      expect(payload).not.toHaveProperty('user');
    });

    it('includes timestamp in ISO 8601 format', () => {
      const payload = buildReviewStartedPayload({
        reviewId: 1,
        mode: 'pr',
        prContext: { owner: 'o', repo: 'r', number: 1 },
      });

      expect(payload.timestamp).toMatch(ISO_8601_RE);
    });

    it('includes reviewId', () => {
      const payload = buildReviewStartedPayload({
        reviewId: 77,
        mode: 'local',
        localContext: { path: '/x' },
      });

      expect(payload.reviewId).toBe(77);
    });
  });

  describe('buildReviewLoadedPayload', () => {
    it('sets event to review.loaded', () => {
      const payload = buildReviewLoadedPayload({
        reviewId: 5,
        mode: 'pr',
        prContext: { owner: 'a', repo: 'b', number: 3 },
      });

      expect(payload.event).toBe('review.loaded');
    });
  });

  // ── buildAnalysisStartedPayload ───────────────────────────────

  describe('buildAnalysisStartedPayload', () => {
    it('includes provider, model, and pr context', () => {
      const payload = buildAnalysisStartedPayload({
        reviewId: 10,
        analysisId: 'abc-123',
        provider: 'claude',
        model: 'opus',
        mode: 'pr',
        prContext: { number: 7, owner: 'o', repo: 'r', baseSha: 'a', headSha: 'b' },
        user: { login: 'dev' },
      });

      expect(payload.event).toBe('analysis.started');
      expect(payload.timestamp).toMatch(ISO_8601_RE);
      expect(payload.reviewId).toBe(10);
      expect(payload.analysisId).toBe('abc-123');
      expect(payload.provider).toBe('claude');
      expect(payload.model).toBe('opus');
      expect(payload.mode).toBe('pr');
      expect(payload.pr).toEqual({ number: 7, owner: 'o', repo: 'r', baseSha: 'a', headSha: 'b' });
      expect(payload.user).toEqual({ login: 'dev' });
      expect(payload).not.toHaveProperty('tier');
      expect(payload).not.toHaveProperty('levelsConfig');
    });

    it('includes local context when mode is local', () => {
      const payload = buildAnalysisStartedPayload({
        reviewId: 10,
        analysisId: 'abc-123',
        provider: 'claude',
        model: 'opus',
        mode: 'local',
        localContext: { path: '/repo', branch: 'feat', headSha: 'sha1' },
      });

      expect(payload.mode).toBe('local');
      expect(payload.local).toEqual({ path: '/repo', branch: 'feat', headSha: 'sha1' });
      expect(payload).not.toHaveProperty('pr');
    });
  });

  // ── buildAnalysisCompletedPayload ─────────────────────────────

  describe('buildAnalysisCompletedPayload', () => {
    it('includes status, totalSuggestions, and context', () => {
      const payload = buildAnalysisCompletedPayload({
        reviewId: 20,
        analysisId: 'run-456',
        provider: 'gemini',
        model: 'pro',
        status: 'success',
        totalSuggestions: 12,
        mode: 'pr',
        prContext: { number: 5, owner: 'o', repo: 'r' },
        user: { login: 'dev' },
      });

      expect(payload.event).toBe('analysis.completed');
      expect(payload.timestamp).toMatch(ISO_8601_RE);
      expect(payload.reviewId).toBe(20);
      expect(payload.analysisId).toBe('run-456');
      expect(payload.provider).toBe('gemini');
      expect(payload.model).toBe('pro');
      expect(payload.status).toBe('success');
      expect(payload.totalSuggestions).toBe(12);
      expect(payload.mode).toBe('pr');
      expect(payload.pr).toEqual({ number: 5, owner: 'o', repo: 'r' });
      expect(payload).not.toHaveProperty('tier');
      expect(payload).not.toHaveProperty('durationMs');
      expect(payload).not.toHaveProperty('filesAnalyzed');
      expect(payload).not.toHaveProperty('suggestions');
    });

    it('status can be failed or cancelled', () => {
      const failed = buildAnalysisCompletedPayload({
        reviewId: 1, analysisId: 'x', provider: 'p', model: 'm',
        status: 'failed', totalSuggestions: 0, mode: 'pr',
      });
      expect(failed.status).toBe('failed');

      const cancelled = buildAnalysisCompletedPayload({
        reviewId: 1, analysisId: 'x', provider: 'p', model: 'm',
        status: 'cancelled', totalSuggestions: 0, mode: 'pr',
      });
      expect(cancelled.status).toBe('cancelled');
    });

    it('missing totalSuggestions defaults to 0', () => {
      const payload = buildAnalysisCompletedPayload({
        reviewId: 1, analysisId: 'x', provider: 'p', model: 'm',
        status: 'success', mode: 'pr',
      });

      expect(payload.totalSuggestions).toBe(0);
    });
  });

  // ── version field ──────────────────────────────────────────────

  describe('version field', () => {
    it('all payload types include a version string matching package.json', () => {
      const { version: pkgVersion } = require('../../package.json');

      const reviewStarted = buildReviewStartedPayload({
        reviewId: 1, mode: 'pr', prContext: { owner: 'o', repo: 'r', number: 1 },
      });
      const reviewLoaded = buildReviewLoadedPayload({
        reviewId: 1, mode: 'pr', prContext: { owner: 'o', repo: 'r', number: 1 },
      });
      const analysisStarted = buildAnalysisStartedPayload({
        reviewId: 1, analysisId: 'a', provider: 'p', model: 'm', mode: 'pr',
      });
      const analysisCompleted = buildAnalysisCompletedPayload({
        reviewId: 1, analysisId: 'a', provider: 'p', model: 'm',
        status: 'success', totalSuggestions: 0, mode: 'pr',
      });
      const chatStarted = buildChatStartedPayload({
        reviewId: 1, sessionId: 1, provider: 'p', model: 'm', mode: 'pr',
      });
      const chatResumed = buildChatResumedPayload({
        reviewId: 1, sessionId: 1, provider: 'p', model: 'm', mode: 'pr',
      });

      for (const payload of [reviewStarted, reviewLoaded, analysisStarted, analysisCompleted, chatStarted, chatResumed]) {
        expect(typeof payload.version).toBe('string');
        expect(payload.version).toBe(pkgVersion);
      }
    });
  });

  // ── buildChatStartedPayload / buildChatResumedPayload ─────────

  describe('buildChatStartedPayload', () => {
    it('sets event to chat.started and includes sessionId, provider, model', () => {
      const payload = buildChatStartedPayload({
        reviewId: 10, sessionId: 5, provider: 'claude', model: 'opus',
        mode: 'pr', prContext: { owner: 'acme', repo: 'app', number: 42 },
      });

      expect(payload.event).toBe('chat.started');
      expect(payload.sessionId).toBe(5);
      expect(payload.provider).toBe('claude');
      expect(payload.model).toBe('opus');
      expect(payload.reviewId).toBe(10);
    });

    it('includes timestamp in ISO 8601 format and version', () => {
      const { version: pkgVersion } = require('../../package.json');
      const payload = buildChatStartedPayload({
        reviewId: 1, sessionId: 1, provider: 'p', model: 'm', mode: 'pr',
      });

      expect(payload.timestamp).toMatch(ISO_8601_RE);
      expect(payload.version).toBe(pkgVersion);
    });

    it('PR mode: includes pr field, no local field', () => {
      const payload = buildChatStartedPayload({
        reviewId: 1, sessionId: 1, provider: 'p', model: 'm',
        mode: 'pr', prContext: { owner: 'o', repo: 'r', number: 7 },
      });

      expect(payload.mode).toBe('pr');
      expect(payload.pr).toEqual({ owner: 'o', repo: 'r', number: 7 });
      expect(payload).not.toHaveProperty('local');
    });

    it('Local mode: includes local field, no pr field', () => {
      const payload = buildChatStartedPayload({
        reviewId: 1, sessionId: 1, provider: 'p', model: 'm',
        mode: 'local', localContext: { path: '/repo', branch: 'main', headSha: 'abc' },
      });

      expect(payload.mode).toBe('local');
      expect(payload.local).toEqual({ path: '/repo', branch: 'main', headSha: 'abc' });
      expect(payload).not.toHaveProperty('pr');
    });

    it('with user: includes user object', () => {
      const payload = buildChatStartedPayload({
        reviewId: 1, sessionId: 1, provider: 'p', model: 'm',
        mode: 'pr', user: { login: 'octocat' },
      });

      expect(payload.user).toEqual({ login: 'octocat' });
    });

    it('without user: user field NOT present', () => {
      const payload = buildChatStartedPayload({
        reviewId: 1, sessionId: 1, provider: 'p', model: 'm',
        mode: 'pr', user: null,
      });

      expect(payload).not.toHaveProperty('user');
    });

    it('missing provider/model defaults to null', () => {
      const payload = buildChatStartedPayload({
        reviewId: 1, sessionId: 1, mode: 'pr',
      });

      expect(payload.provider).toBeNull();
      expect(payload.model).toBeNull();
    });
  });

  describe('buildChatResumedPayload', () => {
    it('sets event to chat.resumed', () => {
      const payload = buildChatResumedPayload({
        reviewId: 1, sessionId: 3, provider: 'gemini', model: 'pro',
        mode: 'local', localContext: { path: '/code' },
      });

      expect(payload.event).toBe('chat.resumed');
      expect(payload.sessionId).toBe(3);
      expect(payload.provider).toBe('gemini');
    });
  });

  // ── buildChatHookContext ─────────────────────────────────────

  describe('buildChatHookContext', () => {
    it('local review: returns mode local with localContext', () => {
      const review = {
        review_type: 'local',
        local_path: '/tmp/repo',
        local_head_branch: 'feat-x',
        local_head_sha: 'abc123',
      };
      const result = buildChatHookContext(review);
      expect(result).toEqual({
        mode: 'local',
        localContext: { path: '/tmp/repo', branch: 'feat-x', headSha: 'abc123' },
      });
    });

    it('PR review: returns mode pr with prContext split from repository', () => {
      const review = {
        review_type: 'pr',
        repository: 'acme/widgets',
        pr_number: 42,
      };
      const result = buildChatHookContext(review);
      expect(result).toEqual({
        mode: 'pr',
        prContext: { number: 42, owner: 'acme', repo: 'widgets' },
      });
    });

    it('missing repository: owner and repo are null', () => {
      const review = { review_type: 'pr', pr_number: 5 };
      const result = buildChatHookContext(review);
      expect(result.prContext.owner).toBeNull();
      expect(result.prContext.repo).toBeNull();
    });

    it('repository without slash: owner set, repo is null', () => {
      const review = { review_type: 'pr', repository: 'monorepo', pr_number: 1 };
      const result = buildChatHookContext(review);
      expect(result.prContext.owner).toBe('monorepo');
      expect(result.prContext.repo).toBeNull();
    });

    it('local review with missing fields: values default to null', () => {
      const review = { review_type: 'local' };
      const result = buildChatHookContext(review);
      expect(result.localContext).toEqual({ path: null, branch: null, headSha: null });
    });
  });

  // ── getCachedUser ─────────────────────────────────────────────

  describe('getCachedUser', () => {
    function createMockGitHubClient(user) {
      return vi.fn().mockImplementation(function () {
        this.getAuthenticatedUser = vi.fn().mockResolvedValue(user);
      });
    }

    function makeDeps({ token, MockClient, mockLogger } = {}) {
      return {
        getGitHubToken: vi.fn().mockReturnValue(token ?? ''),
        GitHubClient: MockClient ?? createMockGitHubClient({ login: 'default' }),
        ...(mockLogger ? { logger: mockLogger } : {}),
      };
    }

    it('calls GitHubClient on first call, returns { login }', async () => {
      const MockClient = createMockGitHubClient({ login: 'octocat' });
      const deps = makeDeps({ token: 'ghp_token123', MockClient });

      const result = await getCachedUser({ github_token: 'ghp_token123' }, deps);

      expect(MockClient).toHaveBeenCalledWith('ghp_token123');
      expect(result).toEqual({ login: 'octocat' });
    });

    it('returns cached result on second call (GitHubClient not called again)', async () => {
      const MockClient = createMockGitHubClient({ login: 'octocat' });
      const deps = makeDeps({ token: 'ghp_token123', MockClient });

      await getCachedUser({}, deps);
      const second = await getCachedUser({}, deps);

      expect(MockClient).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ login: 'octocat' });
    });

    it('no token returns null, no GitHubClient instantiated', async () => {
      const MockClient = createMockGitHubClient({ login: 'nope' });
      const deps = makeDeps({ token: '', MockClient });

      const result = await getCachedUser({}, deps);

      expect(MockClient).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('GitHubClient error returns null and logs warning', async () => {
      const MockClient = vi.fn().mockImplementation(function () {
        this.getAuthenticatedUser = vi.fn().mockRejectedValue(new Error('network down'));
      });
      const mockLogger = { warn: vi.fn() };
      const deps = makeDeps({ token: 'ghp_token123', MockClient, mockLogger });

      const result = await getCachedUser({}, deps);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('network down')
      );
    });

    it('_resetUserCache clears the cache', async () => {
      const MockClient = createMockGitHubClient({ login: 'octocat' });
      const deps = makeDeps({ token: 'ghp_token123', MockClient });

      await getCachedUser({}, deps);
      _resetUserCache();
      await getCachedUser({}, deps);

      expect(MockClient).toHaveBeenCalledTimes(2);
    });
  });

  // ── fireReviewStartedHook ─────────────────────────────────────

  describe('fireReviewStartedHook', () => {
    const basePrData = {
      author: 'octocat',
      base_branch: 'main',
      head_branch: 'feat-x',
      base_sha: 'aaa111',
      head_sha: 'bbb222',
    };

    function createMockFireHooksDeps({ user = { login: 'octocat' }, token = 'ghp_tok' } = {}) {
      const MockClient = vi.fn().mockImplementation(function () {
        this.getAuthenticatedUser = vi.fn().mockResolvedValue(user);
      });
      // Pre-populate getCachedUser so it resolves via our mock
      _resetUserCache();
      return {
        fireHooks: vi.fn(),
        // getCachedUser uses its own _deps param, so we seed the cache first
        _mockClient: MockClient,
        _token: token,
      };
    }

    it('calls fireHooks with review.started event and correct payload shape', async () => {
      const fireDeps = createMockFireHooksDeps();
      // Seed the user cache so fireReviewStartedHook's getCachedUser resolves
      const MockClient = vi.fn().mockImplementation(function () {
        this.getAuthenticatedUser = vi.fn().mockResolvedValue({ login: 'octocat' });
      });
      await getCachedUser({}, {
        getGitHubToken: vi.fn().mockReturnValue('ghp_tok'),
        GitHubClient: MockClient,
      });

      const hookConfig = { hooks: { 'review.started': { test: { command: 'echo' } } } };
      await fireReviewStartedHook({
        reviewId: 42,
        prNumber: 7,
        owner: 'acme',
        repo: 'widgets',
        prData: basePrData,
        config: hookConfig,
      }, { fireHooks: fireDeps.fireHooks });

      expect(fireDeps.fireHooks).toHaveBeenCalledTimes(1);
      const [eventName, payload, config] = fireDeps.fireHooks.mock.calls[0];
      expect(eventName).toBe('review.started');
      expect(config).toEqual(hookConfig);
      expect(payload.event).toBe('review.started');
      expect(payload.reviewId).toBe(42);
      expect(payload.mode).toBe('pr');
      expect(payload.pr).toEqual({
        number: 7, owner: 'acme', repo: 'widgets',
        author: 'octocat', baseBranch: 'main', headBranch: 'feat-x',
        baseSha: 'aaa111', headSha: 'bbb222',
      });
      expect(payload.user).toEqual({ login: 'octocat' });
    });

    it('builds prContext with null SHAs when prData omits them', async () => {
      _resetUserCache();
      const MockClient = vi.fn().mockImplementation(function () {
        this.getAuthenticatedUser = vi.fn().mockResolvedValue({ login: 'dev' });
      });
      await getCachedUser({}, {
        getGitHubToken: vi.fn().mockReturnValue('ghp_tok'),
        GitHubClient: MockClient,
      });

      const mockFireHooks = vi.fn();
      await fireReviewStartedHook({
        reviewId: 10,
        prNumber: 3,
        owner: 'o',
        repo: 'r',
        prData: { author: 'a', base_branch: 'main', head_branch: 'fix' },
        config: { hooks: { 'review.started': { test: { command: 'echo' } } } },
      }, { fireHooks: mockFireHooks });

      const payload = mockFireHooks.mock.calls[0][1];
      expect(payload.pr.baseSha).toBeNull();
      expect(payload.pr.headSha).toBeNull();
    });

    it('resolves user via getCachedUser', async () => {
      _resetUserCache();
      const MockClient = vi.fn().mockImplementation(function () {
        this.getAuthenticatedUser = vi.fn().mockResolvedValue({ login: 'testuser' });
      });
      await getCachedUser({}, {
        getGitHubToken: vi.fn().mockReturnValue('ghp_tok'),
        GitHubClient: MockClient,
      });

      const mockFireHooks = vi.fn();
      await fireReviewStartedHook({
        reviewId: 1,
        prNumber: 1,
        owner: 'o',
        repo: 'r',
        prData: basePrData,
        config: { hooks: { 'review.started': { test: { command: 'echo' } } } },
      }, { fireHooks: mockFireHooks });

      const payload = mockFireHooks.mock.calls[0][1];
      expect(payload.user).toEqual({ login: 'testuser' });
    });
  });
});
