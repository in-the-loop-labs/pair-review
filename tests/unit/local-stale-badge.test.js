// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for local mode staleness-on-load badge behaviour.
 *
 * LocalManager._checkLocalStalenessOnLoad fires on page load and either:
 *   - shows a STALE badge when the session has active data, or
 *   - silently refreshes when the session has no user work.
 *
 * triggerAIAnalysis reuses the on-load staleness promise when still pending.
 */

// We need STALE_TIMEOUT to be defined before importing LocalManager
global.STALE_TIMEOUT = 2000;

// Provide a minimal PRManager class so LocalManager can reference it
const { PRManager } = require('../../public/js/pr.js');

const mockFetch = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();

  global.fetch = mockFetch;

  global.window = {
    prManager: null, // set per-test
    location: { pathname: '/local/42' },
    PAIR_REVIEW_LOCAL_MODE: true,
    scrollTo: vi.fn(),
    aiPanel: { showDismissedComments: false, setFileOrder: vi.fn(), setComments: vi.fn(), setAnalysisState: vi.fn(), setSummaryData: vi.fn() },
    FileOrderUtils: { sortFilesByPath: vi.fn((f) => f), createFileOrderMap: vi.fn(() => new Map()) },
    toast: { showSuccess: vi.fn(), showWarning: vi.fn(), showError: vi.fn(), showInfo: vi.fn() },
    confirmDialog: null
  };

  global.document = {
    getElementById: vi.fn(() => null),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn()
  };

  global.alert = vi.fn();
  global.AbortController = AbortController;
  global.performance = { now: () => Date.now() };

  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Import LocalManager after globals are set up
const { LocalManager } = require('../../public/js/local.js');

/**
 * Create a minimal LocalManager for testing without triggering the full init().
 */
function createTestLocalManager() {
  const lm = Object.create(LocalManager.prototype);
  lm.reviewId = 42;
  lm.localData = null;
  lm.isInitialized = false;
  return lm;
}

/**
 * Create a minimal PRManager mock with the methods LocalManager depends on.
 */
function createTestPRManager() {
  const pm = Object.create(PRManager.prototype);
  pm.currentPR = { id: 42, owner: 'local', repo: 'my-repo', number: 42, reviewType: 'local' };
  pm._stalenessPromise = null;
  pm._showStaleBadge = vi.fn();
  pm._hideStaleBadge = vi.fn();
  pm._hasActiveSessionData = vi.fn().mockResolvedValue(false);
  pm.loadUserComments = vi.fn().mockResolvedValue(undefined);
  pm.loadAISuggestions = vi.fn().mockResolvedValue(undefined);
  pm.showError = vi.fn();
  return pm;
}

describe('LocalManager._checkLocalStalenessOnLoad', () => {
  it('shows STALE badge when stale and session has data', async () => {
    const lm = createTestLocalManager();
    const pm = createTestPRManager();
    pm._hasActiveSessionData.mockResolvedValue(true);
    global.window.prManager = pm;

    // Mock _fetchLocalStaleness to return stale
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({ isStale: true });

    const result = await lm._checkLocalStalenessOnLoad();

    expect(result).toEqual({ isStale: true });
    expect(pm._showStaleBadge).toHaveBeenCalledWith('stale', 'Working directory has changed');
    expect(pm._hasActiveSessionData).toHaveBeenCalled();
  });

  it('silently refreshes when stale and no session data', async () => {
    const lm = createTestLocalManager();
    const pm = createTestPRManager();
    pm._hasActiveSessionData.mockResolvedValue(false);
    global.window.prManager = pm;

    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({ isStale: true });
    lm.refreshDiff = vi.fn().mockResolvedValue(undefined);

    const result = await lm._checkLocalStalenessOnLoad();

    expect(result).toEqual({ isStale: true });
    expect(lm.refreshDiff).toHaveBeenCalled();
    expect(pm._showStaleBadge).not.toHaveBeenCalled();
  });

  it('does nothing when not stale', async () => {
    const lm = createTestLocalManager();
    const pm = createTestPRManager();
    global.window.prManager = pm;

    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({ isStale: false });
    lm.refreshDiff = vi.fn();

    const result = await lm._checkLocalStalenessOnLoad();

    expect(result).toEqual({ isStale: false });
    expect(pm._showStaleBadge).not.toHaveBeenCalled();
    expect(lm.refreshDiff).not.toHaveBeenCalled();
    expect(pm._hasActiveSessionData).not.toHaveBeenCalled();
  });

  it('returns null silently on fetch failure', async () => {
    const lm = createTestLocalManager();
    const pm = createTestPRManager();
    global.window.prManager = pm;

    lm._fetchLocalStaleness = vi.fn().mockResolvedValue(null);

    const result = await lm._checkLocalStalenessOnLoad();

    expect(result).toBeNull();
    expect(pm._showStaleBadge).not.toHaveBeenCalled();
  });

  it('returns null silently on thrown error', async () => {
    const lm = createTestLocalManager();
    const pm = createTestPRManager();
    global.window.prManager = pm;

    lm._fetchLocalStaleness = vi.fn().mockRejectedValue(new Error('network'));

    const result = await lm._checkLocalStalenessOnLoad();

    expect(result).toBeNull();
    expect(pm._showStaleBadge).not.toHaveBeenCalled();
  });
});

describe('LocalManager._fetchLocalStaleness', () => {
  it('fetches from GET /api/local/:reviewId/check-stale', async () => {
    const lm = createTestLocalManager();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ isStale: false })
    });

    const result = await lm._fetchLocalStaleness();

    expect(result).toEqual({ isStale: false });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/local/42/check-stale',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    // Should NOT use POST — the endpoint is GET
    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.method).toBeUndefined();
  });

  it('returns null on non-ok response', async () => {
    const lm = createTestLocalManager();
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const result = await lm._fetchLocalStaleness();
    expect(result).toBeNull();
  });

  it('returns null on fetch error', async () => {
    const lm = createTestLocalManager();
    mockFetch.mockRejectedValue(new Error('network error'));

    const result = await lm._fetchLocalStaleness();
    expect(result).toBeNull();
  });
});

describe('staleness promise reuse in triggerAIAnalysis', () => {
  /**
   * Helper: set up a LocalManager + PRManager pair with patchPRManager applied,
   * mocking enough of the environment so triggerAIAnalysis reaches the
   * consume-or-fetch branching logic (lines 259-262 in local.js) and then
   * bails out cleanly via analysisConfigModal.show() returning null.
   */
  function setupTriggerEnv() {
    const lm = createTestLocalManager();
    const pm = createTestPRManager();
    pm.isAnalyzing = false;
    pm.getAnalyzeButton = vi.fn(() => null);
    pm.fetchRepoSettings = vi.fn().mockResolvedValue(null);
    pm.fetchLastReviewSettings = vi.fn().mockResolvedValue({ custom_instructions: '', last_council_id: null });
    pm.analysisConfigModal = { show: vi.fn().mockResolvedValue(null), onTabChange: null };
    pm.collapsedFiles = new Set();
    pm.viewedFiles = new Set();
    pm.resetButton = vi.fn();
    global.window.prManager = pm;
    global.localStorage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };

    // Patch triggerAIAnalysis onto pm via the real patchPRManager
    lm.patchPRManager();

    return { lm, pm };
  }

  it('consumes _stalenessPromise when available instead of fetching fresh', async () => {
    const { lm, pm } = setupTriggerEnv();

    // Pre-set a resolved staleness promise on the manager
    const stalenessResult = { isStale: false };
    pm._stalenessPromise = Promise.resolve(stalenessResult);

    // Spy on _fetchLocalStaleness to verify it is NOT called
    const fetchSpy = vi.spyOn(lm, '_fetchLocalStaleness');

    await pm.triggerAIAnalysis();

    // The reuse path was taken — _fetchLocalStaleness should NOT have been called
    expect(fetchSpy).not.toHaveBeenCalled();
    // The promise should be consumed (set to null)
    expect(pm._stalenessPromise).toBeNull();
  });

  it('calls _fetchLocalStaleness when no pre-set promise exists', async () => {
    const { lm, pm } = setupTriggerEnv();

    // No pre-set promise
    pm._stalenessPromise = null;

    // Spy on _fetchLocalStaleness to verify it IS called
    const fetchSpy = vi.spyOn(lm, '_fetchLocalStaleness').mockResolvedValue({ isStale: false });

    await pm.triggerAIAnalysis();

    // The fresh-fetch path was taken
    expect(fetchSpy).toHaveBeenCalledOnce();
    // _stalenessPromise is still null (was consumed/never set)
    expect(pm._stalenessPromise).toBeNull();
  });
});

describe('refreshDiff hides stale badge', () => {
  it('calls _hideStaleBadge and clears _stalenessPromise on success', async () => {
    const lm = createTestLocalManager();
    const pm = createTestPRManager();
    pm._stalenessPromise = Promise.resolve({ isStale: true });
    global.window.prManager = pm;

    // Mock the refresh API
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stats: {}, sessionChanged: false })
    });

    // Mock loadLocalDiff (called by refreshDiff)
    lm.loadLocalDiff = vi.fn().mockResolvedValue(undefined);

    // Set up required DOM element for button check
    const mockBtn = { disabled: false, classList: { add: vi.fn(), remove: vi.fn() } };
    global.document.getElementById = vi.fn((id) => {
      if (id === 'local-refresh-btn') return mockBtn;
      return null;
    });

    await lm.refreshDiff();

    expect(pm._hideStaleBadge).toHaveBeenCalled();
    expect(pm._stalenessPromise).toBeNull();
  });
});
