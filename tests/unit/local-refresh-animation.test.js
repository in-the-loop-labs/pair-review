// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for local mode refresh button animation.
 *
 * When refreshDiff is called, the refresh button should:
 *   - Add the 'refreshing' class on start (which swaps in the spinner icon)
 *   - Remove the 'refreshing' class on completion (success or error)
 */

global.STALE_TIMEOUT = 2000;

const { PRManager } = require('../../public/js/pr.js');

const mockFetch = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();

  global.fetch = mockFetch;

  global.window = {
    prManager: null,
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

const { LocalManager } = require('../../public/js/local.js');

function createTestLocalManager() {
  const lm = Object.create(LocalManager.prototype);
  lm.reviewId = 42;
  lm.localData = null;
  lm.isInitialized = false;
  return lm;
}

function createTestPRManager() {
  const pm = Object.create(PRManager.prototype);
  pm.currentPR = { id: 42, owner: 'local', repo: 'my-repo', number: 42, reviewType: 'local' };
  pm.renderDiff = vi.fn();
  pm._hideStaleBadge = vi.fn();
  pm._stalenessPromise = null;
  pm.loadUserComments = vi.fn().mockResolvedValue(undefined);
  pm.loadAISuggestions = vi.fn().mockResolvedValue(undefined);
  return pm;
}

function createMockRefreshBtn() {
  const classes = new Set();
  return {
    disabled: false,
    classList: {
      add: vi.fn((cls) => classes.add(cls)),
      remove: vi.fn((cls) => classes.delete(cls)),
      contains: (cls) => classes.has(cls),
      _classes: classes
    }
  };
}

describe('local refresh button animation', () => {
  let lm, pm, mockBtn;

  beforeEach(() => {
    lm = createTestLocalManager();
    pm = createTestPRManager();
    mockBtn = createMockRefreshBtn();

    global.window.prManager = pm;
    global.document.getElementById = vi.fn((id) => {
      if (id === 'local-refresh-btn') return mockBtn;
      return null;
    });
  });

  it('adds refreshing class before the fetch begins', async () => {
    // Capture the button's class state at the moment fetch is called
    let hadRefreshingDuringFetch = false;
    mockFetch.mockImplementation(() => {
      hadRefreshingDuringFetch = mockBtn.classList._classes.has('refreshing');
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ stats: {}, sessionChanged: false })
      });
    });
    lm.loadLocalDiff = vi.fn().mockResolvedValue(undefined);

    await lm.refreshDiff();

    expect(hadRefreshingDuringFetch).toBe(true);
  });

  it('removes refreshing class after successful refresh', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stats: {}, sessionChanged: false })
    });
    lm.loadLocalDiff = vi.fn().mockResolvedValue(undefined);

    await lm.refreshDiff();

    expect(mockBtn.classList.remove).toHaveBeenCalledWith('refreshing');
    expect(mockBtn.classList._classes.has('refreshing')).toBe(false);
  });

  it('removes refreshing class after failed refresh', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Server error' })
    });

    await lm.refreshDiff();

    expect(mockBtn.classList.add).toHaveBeenCalledWith('refreshing');
    expect(mockBtn.classList.remove).toHaveBeenCalledWith('refreshing');
    expect(mockBtn.classList._classes.has('refreshing')).toBe(false);
  });

  it('does not use btn-loading class', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stats: {}, sessionChanged: false })
    });
    lm.loadLocalDiff = vi.fn().mockResolvedValue(undefined);

    await lm.refreshDiff();

    expect(mockBtn.classList.add).not.toHaveBeenCalledWith('btn-loading');
    expect(mockBtn.classList.remove).not.toHaveBeenCalledWith('btn-loading');
  });
});
