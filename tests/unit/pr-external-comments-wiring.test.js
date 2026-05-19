// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for the external review-comment lifecycle wiring on PRManager.
 *
 * Covers:
 *   - _syncExternalComments: POSTs the sync endpoint and parses the response.
 *   - _loadExternalComments: sets reviewId on the singleton, syncs, and
 *     calls loadAndRender regardless of sync success.
 *   - Local-mode short-circuit: no sync, no loadAndRender.
 *   - Refresh button: clicking #refresh-external-comments-btn invokes
 *     _loadExternalComments and toggles disabled state.
 */

const { PRManager } = require('../../public/js/pr.js');

const mockFetch = vi.fn();

let externalCommentManagerStub;
let refreshButton;

beforeEach(() => {
  vi.resetAllMocks();

  global.fetch = mockFetch;

  // Stub stays close to the real manager shape. `_loadExternalComments`
  // now routes through `syncAndRender`; the stub implements it by
  // invoking the injected syncFn (so the existing fetch-based tests for
  // `_syncExternalComments` still exercise the POST) and resolving with
  // the canonical `{ errors, syncResult, syncError }` shape. GET-only
  // callers still hit `loadAndRender`.
  externalCommentManagerStub = {
    reviewId: undefined,
    sources: ['github'],
    loadAndRender: vi.fn().mockResolvedValue({ errors: [] }),
    syncAndRender: vi.fn(async ({ syncFn } = {}) => {
      let syncResult = null;
      let syncError = null;
      if (typeof syncFn === 'function') {
        try {
          syncResult = await syncFn();
        } catch (err) {
          syncError = err;
        }
      }
      return { errors: [], syncResult, syncError };
    }),
    clear: vi.fn(),
  };

  refreshButton = {
    disabled: false,
    _listeners: {},
    classList: {
      _set: new Set(),
      add(cls) { this._set.add(cls); },
      remove(cls) { this._set.delete(cls); },
      contains(cls) { return this._set.has(cls); },
    },
    addEventListener: vi.fn(function (event, handler) {
      this._listeners[event] = handler;
    }),
    click() {
      const handler = this._listeners.click;
      if (handler) return handler();
    },
  };

  global.window = {
    externalCommentManager: externalCommentManagerStub,
    PAIR_REVIEW_LOCAL_MODE: false,
  };

  global.document = {
    getElementById: vi.fn(() => null),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
  };

  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete global.window;
  delete global.document;
  delete global.fetch;
});

function createTestPRManager() {
  const prManager = Object.create(PRManager.prototype);
  prManager.currentPR = {
    owner: 'octo',
    repo: 'pair-review',
    number: 42,
    id: 7,
  };
  return prManager;
}

describe('PRManager._syncExternalComments', () => {
  it('POSTs the sync endpoint and returns the parsed body', async () => {
    const prManager = createTestPRManager();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ count: 3, lostAnchors: 0, syncedAt: '2026-05-17T12:00:00Z' }),
    });

    const result = await prManager._syncExternalComments();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/reviews/7/external-comments/sync?source=github');
    expect(opts).toEqual({ method: 'POST' });
    expect(result).toEqual({ count: 3, lostAnchors: 0, syncedAt: '2026-05-17T12:00:00Z' });
  });

  it('throws on non-OK responses, surfacing the server error message', async () => {
    const prManager = createTestPRManager();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: vi.fn().mockResolvedValue({ error: 'GitHub unreachable' }),
    });

    await expect(prManager._syncExternalComments()).rejects.toMatchObject({
      message: 'GitHub unreachable',
      status: 502,
    });
  });

  it('throws with a default message when error body is not JSON', async () => {
    const prManager = createTestPRManager();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: vi.fn().mockRejectedValue(new Error('parse')),
    });

    await expect(prManager._syncExternalComments()).rejects.toMatchObject({
      message: 'Sync failed with status 500',
      status: 500,
    });
  });
});

describe('PRManager._loadExternalComments', () => {
  it('happy path: sets reviewId, syncs through manager.syncAndRender', async () => {
    const prManager = createTestPRManager();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ count: 1, lostAnchors: 0, syncedAt: 'now' }),
    });

    await prManager._loadExternalComments();

    expect(externalCommentManagerStub.reviewId).toBe(7);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // _loadExternalComments now goes through the manager's canonical
    // sync+load entry point. The stub forwards the injected syncFn so the
    // POST still fires via the fetch mock above.
    expect(externalCommentManagerStub.syncAndRender).toHaveBeenCalledTimes(1);
    expect(externalCommentManagerStub.loadAndRender).not.toHaveBeenCalled();
  });

  it('sync failure: syncAndRender resolves with syncError; render still happens via the manager', async () => {
    const prManager = createTestPRManager();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: vi.fn().mockResolvedValue({ error: 'upstream' }),
    });

    await prManager._loadExternalComments();

    // syncAndRender is the single entry point; it owns the in-flight guard
    // for the full sync+load sequence.
    expect(externalCommentManagerStub.syncAndRender).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalled();
  });

  it('local mode short-circuits: no fetch, no syncAndRender, no reviewId mutation', async () => {
    window.PAIR_REVIEW_LOCAL_MODE = true;
    const prManager = createTestPRManager();

    await prManager._loadExternalComments();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(externalCommentManagerStub.syncAndRender).not.toHaveBeenCalled();
    expect(externalCommentManagerStub.loadAndRender).not.toHaveBeenCalled();
    expect(externalCommentManagerStub.reviewId).toBeUndefined();
  });

  it('short-circuits when externalCommentManager singleton is not present', async () => {
    window.externalCommentManager = null;
    const prManager = createTestPRManager();

    await prManager._loadExternalComments();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('short-circuits when no PR is loaded', async () => {
    const prManager = createTestPRManager();
    prManager.currentPR = null;

    await prManager._loadExternalComments();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(externalCommentManagerStub.syncAndRender).not.toHaveBeenCalled();
  });

  it('swallows syncAndRender errors so a failure cannot bubble out of page-load', async () => {
    const prManager = createTestPRManager();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ count: 0, lostAnchors: 0, syncedAt: 'now' }),
    });
    externalCommentManagerStub.syncAndRender.mockRejectedValueOnce(new Error('render boom'));

    await expect(prManager._loadExternalComments()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it('surfaces lostAnchors > 0 via _showExternalLostAnchorsToast(n)', async () => {
    // Regression: the sync result body was previously discarded, so the
    // reviewer had no signal when comments lost their anchors upstream.
    const prManager = createTestPRManager();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ count: 5, lostAnchors: 3, syncedAt: 'now' }),
    });
    const toastSpy = vi.spyOn(prManager, '_showExternalLostAnchorsToast').mockImplementation(() => {});

    await prManager._loadExternalComments();

    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith(3);
  });

  for (const status of [401, 403, 429, 502]) {
    it(`sync failure status ${status}: calls _showExternalSyncErrorToast with the error and marks refresh-error state`, async () => {
      // Regression: round-2 added status-aware toasting via the
      // _showExternalSyncErrorToast/_markExternalRefreshErrorState helpers,
      // but the only "sync failure" test asserted nothing beyond
      // loadAndRender + console.warn. Pin the actual helper wiring.
      const prManager = createTestPRManager();
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status,
        json: vi.fn().mockResolvedValue({ error: `boom ${status}` }),
      });
      const toastSpy = vi.spyOn(prManager, '_showExternalSyncErrorToast').mockImplementation(() => {});
      const markSpy = vi.spyOn(prManager, '_markExternalRefreshErrorState').mockImplementation(() => {});

      await prManager._loadExternalComments();

      expect(toastSpy).toHaveBeenCalledTimes(1);
      const err = toastSpy.mock.calls[0][0];
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBe(status);
      expect(markSpy).toHaveBeenCalledTimes(1);
    });
  }

  it('does NOT call _showExternalLostAnchorsToast when lostAnchors=0', async () => {
    const prManager = createTestPRManager();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ count: 5, lostAnchors: 0, syncedAt: 'now' }),
    });
    const toastSpy = vi.spyOn(prManager, '_showExternalLostAnchorsToast').mockImplementation(() => {});

    await prManager._loadExternalComments();

    expect(toastSpy).not.toHaveBeenCalled();
  });
});

describe('Refresh external-comments button wiring', () => {
  /**
   * Exercise the production click handler attached in setupEventListeners()
   * for #refresh-external-comments-btn. Per CLAUDE.md we test the real
   * method (`_handleExternalCommentsRefreshClick`) rather than duplicating
   * its behavior in the test file.
   */
  function makePRManager() {
    const prManager = createTestPRManager();
    prManager._loadExternalComments = vi.fn().mockResolvedValue(undefined);
    // Mimic real attribute handling on the test stub.
    refreshButton._attrs = {};
    refreshButton.setAttribute = vi.fn(function (k, v) { this._attrs[k] = String(v); });
    refreshButton.removeAttribute = vi.fn(function (k) { delete this._attrs[k]; });
    refreshButton.getAttribute = vi.fn(function (k) { return this._attrs[k] || null; });
    return prManager;
  }

  it('click triggers _loadExternalComments exactly once', async () => {
    const prManager = makePRManager();
    await prManager._handleExternalCommentsRefreshClick({ button: refreshButton });
    expect(prManager._loadExternalComments).toHaveBeenCalledTimes(1);
  });

  it('button is re-enabled and aria-busy cleared after the call completes', async () => {
    const prManager = makePRManager();
    await prManager._handleExternalCommentsRefreshClick({ button: refreshButton });
    expect(refreshButton.disabled).toBe(false);
    expect(refreshButton.classList.contains('is-refreshing')).toBe(false);
    expect(refreshButton.getAttribute('aria-busy')).toBeNull();
    expect(prManager._loadExternalComments).toHaveBeenCalled();
  });

  it('button is re-enabled even when _loadExternalComments rejects', async () => {
    const prManager = makePRManager();
    prManager._loadExternalComments.mockRejectedValueOnce(new Error('boom'));

    await expect(
      prManager._handleExternalCommentsRefreshClick({ button: refreshButton })
    ).rejects.toThrow('boom');

    expect(refreshButton.disabled).toBe(false);
    expect(refreshButton.classList.contains('is-refreshing')).toBe(false);
    expect(refreshButton.getAttribute('aria-busy')).toBeNull();
  });

  it('double-click while in-flight does not stack calls', async () => {
    const prManager = makePRManager();
    let resolveLoad;
    prManager._loadExternalComments.mockImplementationOnce(
      () => new Promise((r) => { resolveLoad = r; })
    );

    const first = prManager._handleExternalCommentsRefreshClick({ button: refreshButton });
    // While the first is in-flight the button is disabled — second short-circuits.
    const second = prManager._handleExternalCommentsRefreshClick({ button: refreshButton });

    resolveLoad();
    await Promise.all([first, second]);

    expect(prManager._loadExternalComments).toHaveBeenCalledTimes(1);
  });

  it('sets aria-busy=true while the call is in flight', async () => {
    const prManager = makePRManager();
    let resolveLoad;
    prManager._loadExternalComments.mockImplementationOnce(
      () => new Promise((r) => { resolveLoad = r; })
    );

    const inflight = prManager._handleExternalCommentsRefreshClick({ button: refreshButton });
    expect(refreshButton.getAttribute('aria-busy')).toBe('true');
    resolveLoad();
    await inflight;
    expect(refreshButton.getAttribute('aria-busy')).toBeNull();
  });
});

describe('PRManager.handleWhitespaceToggle re-renders external comments', () => {
  it('routes through _rerenderAllOverlays so external rows survive the DOM rebuild', async () => {
    // Regression: handleWhitespaceToggle rebuilds the diff DOM (which drops
    // every .external-comment-row) but originally only re-anchored user
    // comments + AI suggestions. External rows silently disappeared until a
    // full PR refresh. Now whitespace toggle and post-analysis refresh both
    // route through _rerenderAllOverlays, which calls externalCommentManager.
    const prManager = createTestPRManager();
    prManager.loadUserComments = vi.fn().mockResolvedValue(undefined);
    prManager.loadAISuggestions = vi.fn().mockResolvedValue(undefined);
    prManager.loadAndDisplayFiles = vi.fn().mockResolvedValue(undefined);
    prManager.selectedRunId = 'run-7';

    global.window.scrollY = 0;
    global.window.scrollTo = vi.fn();
    global.window.requestAnimationFrame = (cb) => cb();
    global.requestAnimationFrame = (cb) => cb();

    await prManager.handleWhitespaceToggle(true);

    expect(prManager.hideWhitespace).toBe(true);
    expect(prManager.loadAndDisplayFiles).toHaveBeenCalledTimes(1);
    expect(prManager.loadUserComments).toHaveBeenCalledTimes(1);
    expect(prManager.loadAISuggestions).toHaveBeenCalledWith(null, 'run-7');
    expect(externalCommentManagerStub.loadAndRender).toHaveBeenCalledTimes(1);
    expect(externalCommentManagerStub.reviewId).toBe(7);
  });

  it('short-circuits when no PR is loaded', async () => {
    const prManager = createTestPRManager();
    prManager.currentPR = null;
    prManager.loadAndDisplayFiles = vi.fn();

    await prManager.handleWhitespaceToggle(true);

    expect(prManager.loadAndDisplayFiles).not.toHaveBeenCalled();
    expect(externalCommentManagerStub.loadAndRender).not.toHaveBeenCalled();
  });
});

describe('PRManager._reloadAfterAnalysis re-renders external comments', () => {
  it('post-analysis auto-refresh routes through _rerenderAllOverlays', async () => {
    // Regression: _reloadAfterAnalysis (fired by review:analysis_completed
    // and the visibilitychange dirty-analysis branch) previously reloaded
    // only AI + user comments. After this fix it goes through the shared
    // helper so external rows stay in sync.
    const prManager = createTestPRManager();
    prManager.loadUserComments = vi.fn().mockResolvedValue(undefined);
    prManager.loadAISuggestions = vi.fn().mockResolvedValue(undefined);

    await prManager._reloadAfterAnalysis();

    expect(prManager.loadUserComments).toHaveBeenCalledTimes(1);
    expect(prManager.loadAISuggestions).toHaveBeenCalledTimes(1);
    expect(externalCommentManagerStub.loadAndRender).toHaveBeenCalledTimes(1);
  });
});

describe('PRManager._rerenderAllOverlays', () => {
  it('re-renders user comments, AI suggestions, AND external comments via GET-only path by default', async () => {
    // Regression: refreshPR previously rebuilt the diff DOM and re-ran AI
    // suggestions + user comments, but forgot to re-run external comments,
    // so refreshing the PR silently dropped every blue external-comment row.
    // Without `syncExternal: true` the helper takes the GET-only path so
    // analysis rebuilds and whitespace toggles don't pay for a sync POST.
    const prManager = createTestPRManager();
    prManager.loadUserComments = vi.fn().mockResolvedValue(undefined);
    prManager.loadAISuggestions = vi.fn().mockResolvedValue(undefined);

    await prManager._rerenderAllOverlays({ analysisRunId: 'run-1' });

    expect(prManager.loadUserComments).toHaveBeenCalledTimes(1);
    expect(prManager.loadAISuggestions).toHaveBeenCalledWith(null, 'run-1');
    expect(externalCommentManagerStub.loadAndRender).toHaveBeenCalledTimes(1);
    // GET-only path: no sync POST.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(externalCommentManagerStub.syncAndRender).not.toHaveBeenCalled();
    // External-comment manager must have its reviewId pinned before rendering.
    expect(externalCommentManagerStub.reviewId).toBe(7);
  });

  it('fires the sync POST when called with syncExternal: true', async () => {
    // Regression for refreshPR: when refresh fetches a fresh diff the commit
    // SHA may have changed, so cached anchors and outdated flags must be
    // re-evaluated against the new HEAD. `syncExternal: true` routes the
    // external-comment path through `_loadExternalComments` (full sync+load)
    // instead of `loadAndRender` (GET-only).
    const prManager = createTestPRManager();
    prManager.loadUserComments = vi.fn().mockResolvedValue(undefined);
    prManager.loadAISuggestions = vi.fn().mockResolvedValue(undefined);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ count: 0, lostAnchors: 0, deleted: 0, syncedAt: 'now' }),
    });

    await prManager._rerenderAllOverlays({ analysisRunId: 'run-2', syncExternal: true });

    // The sync POST fired exactly once and a render still happened — both
    // via the manager's syncAndRender (which the stub forwards to syncFn).
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(externalCommentManagerStub.syncAndRender).toHaveBeenCalledTimes(1);
    expect(externalCommentManagerStub.loadAndRender).not.toHaveBeenCalled();
  });

  it('_reloadAfterAnalysis (post-analysis path) stays on the GET-only flavor', async () => {
    // Regression: _reloadAfterAnalysis must not double the sync POST. The
    // post-analysis path re-anchors against the existing diff DOM; no
    // upstream snapshot has changed.
    const prManager = createTestPRManager();
    prManager.loadUserComments = vi.fn().mockResolvedValue(undefined);
    prManager.loadAISuggestions = vi.fn().mockResolvedValue(undefined);

    await prManager._reloadAfterAnalysis();

    expect(externalCommentManagerStub.loadAndRender).toHaveBeenCalledTimes(1);
    expect(externalCommentManagerStub.syncAndRender).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not throw when external-comment manager is missing', async () => {
    window.externalCommentManager = null;
    const prManager = createTestPRManager();
    prManager.loadUserComments = vi.fn().mockResolvedValue(undefined);
    prManager.loadAISuggestions = vi.fn().mockResolvedValue(undefined);

    await expect(prManager._rerenderAllOverlays({})).resolves.toBeUndefined();
    expect(prManager.loadUserComments).toHaveBeenCalledTimes(1);
    expect(prManager.loadAISuggestions).toHaveBeenCalled();
  });
});
