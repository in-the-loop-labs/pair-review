// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for the external review-comment lifecycle wiring on PRManager.
 *
 * Covers:
 *   - _syncExternalComments: POSTs the sync endpoint and parses the response.
 *   - _loadExternalComments: sets reviewId on the singleton, syncs, and
 *     calls loadAndRender regardless of sync success.
 *   - Capability short-circuit: `canViewPRComments: false` means no sync and
 *     no loadAndRender — and, crucially, `window.PAIR_REVIEW_LOCAL_MODE` no
 *     longer decides anything (the mode-sniff was replaced by the capability
 *     in Phase 2 of plans/bridge-local-and-pr-modes.md).
 *   - _externalAnchorContext / _prepareExternalCommentManager: how much the
 *     rendered diff can be trusted to match the commit the comments were
 *     anchored against, and how that reaches ExternalCommentManager.
 *   - _updateExternalCommentsAffordances: refresh button + AI-panel External
 *     segment visibility derived from capability × feature toggle.
 *   - Refresh button: clicking #refresh-external-comments-btn-panel invokes
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
    // Real manager surface since Phase 2 — every render entry point pushes
    // the anchor-trust context through here before rendering.
    setAnchorContext: vi.fn(),
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

/**
 * The capability surface a real PR-mode `PRManager` advertises — see the
 * `this.capabilities = {...}` block in the constructor (public/js/pr.js).
 * PR mode hard-codes every action flag true because those endpoints already
 * ship there; local mode receives them from GET /api/local/:reviewId.
 *
 * These tests build managers with `Object.create(PRManager.prototype)`, which
 * skips the constructor entirely, so the fixture has to seed this itself.
 * Without it `hasCapability('canViewPRComments')` reads `undefined` and every
 * capability-gated path short-circuits — the tests would then pass by
 * asserting on a manager that can do nothing.
 */
const PR_MODE_CAPABILITIES = Object.freeze({
  hasAssociatedPR: true,
  hasGitHubToken: true,
  canShowPRMetadata: true,
  canViewPRComments: true,
  canCheckStaleVsPR: true,
  canSyncDrafts: true,
  canSubmitToGitHub: true,
});

/**
 * @param {Object} [options]
 * @param {Object} [options.capabilities] - Per-test overrides merged over the
 *   PR-mode defaults (e.g. `{ canViewPRComments: false }` to model a local
 *   review with no associated PR).
 * @param {Object|null} [options.currentPR] - Override the loaded PR.
 */
function createTestPRManager({ capabilities, currentPR } = {}) {
  const prManager = Object.create(PRManager.prototype);
  prManager.capabilities = { ...PR_MODE_CAPABILITIES, ...capabilities };
  prManager.currentPR = currentPR !== undefined ? currentPR : {
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

  it('canViewPRComments=false short-circuits: no fetch, no syncAndRender, no reviewId mutation', async () => {
    // The gate is the capability, not the mode. A local review with no
    // associated PR (or no usable credential) reports this false and the
    // whole subsystem must stay inert.
    const prManager = createTestPRManager({ capabilities: { canViewPRComments: false } });

    await prManager._loadExternalComments();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(externalCommentManagerStub.syncAndRender).not.toHaveBeenCalled();
    expect(externalCommentManagerStub.loadAndRender).not.toHaveBeenCalled();
    expect(externalCommentManagerStub.reviewId).toBeUndefined();
  });

  it('local mode with canViewPRComments=true PROCEEDS — the mode-sniff is gone', async () => {
    // Counterpart to the test above, and the actual proof of Phase 2: this
    // method used to open with `if (window.PAIR_REVIEW_LOCAL_MODE) return;`.
    // A local review whose branch has an associated PR now syncs and renders
    // exactly like PR mode.
    window.PAIR_REVIEW_LOCAL_MODE = true;
    const prManager = createTestPRManager({ capabilities: { canViewPRComments: true } });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ count: 2, lostAnchors: 0, syncedAt: 'now' }),
    });

    await prManager._loadExternalComments();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(externalCommentManagerStub.syncAndRender).toHaveBeenCalledTimes(1);
    expect(externalCommentManagerStub.reviewId).toBe(7);
  });

  it('external_comments feature toggle off: no fetch, no syncAndRender, no reviewId mutation', async () => {
    // Mirror the production wiring: runtime-config.js sets this object
    // synchronously before pr.js loads. When the flag is false, every
    // entry point into the external-comments subsystem must no-op.
    window.PAIR_REVIEW_RUNTIME_CONFIG = { external_comments_enabled: false };
    const prManager = createTestPRManager();

    await prManager._loadExternalComments();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(externalCommentManagerStub.syncAndRender).not.toHaveBeenCalled();
    expect(externalCommentManagerStub.loadAndRender).not.toHaveBeenCalled();
    expect(externalCommentManagerStub.reviewId).toBeUndefined();
  });

  it('external_comments enabled (default): proceeds normally when flag is true', async () => {
    window.PAIR_REVIEW_RUNTIME_CONFIG = { external_comments_enabled: true };
    const prManager = createTestPRManager();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ count: 0, lostAnchors: 0, syncedAt: 'now' }),
    });

    await prManager._loadExternalComments();

    expect(externalCommentManagerStub.syncAndRender).toHaveBeenCalledTimes(1);
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
   * for #refresh-external-comments-btn-panel. Per CLAUDE.md we test the real
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

  it('does nothing when external_comments feature toggle is off', async () => {
    // Defensive guard: even if a stale caller (or test) invokes the handler
    // with the feature disabled, it must not touch the button state or call
    // through to _loadExternalComments.
    window.PAIR_REVIEW_RUNTIME_CONFIG = { external_comments_enabled: false };
    const prManager = makePRManager();

    await prManager._handleExternalCommentsRefreshClick({ button: refreshButton });

    expect(prManager._loadExternalComments).not.toHaveBeenCalled();
    expect(refreshButton.disabled).toBe(false);
    expect(refreshButton.classList.contains('is-refreshing')).toBe(false);
  });

  it('does nothing when canViewPRComments is false', async () => {
    // The handler must agree with the affordance policy in
    // _updateExternalCommentsAffordances (capability AND feature toggle).
    // It previously guarded on the toggle alone, so a button that escaped
    // its `hidden` attribute could drive the subsystem for a review with no
    // PR target.
    const prManager = createTestPRManager({ capabilities: { canViewPRComments: false } });
    prManager._loadExternalComments = vi.fn().mockResolvedValue(undefined);

    await prManager._handleExternalCommentsRefreshClick({ button: refreshButton });

    expect(prManager._loadExternalComments).not.toHaveBeenCalled();
    expect(refreshButton.disabled).toBe(false);
    expect(refreshButton.classList.contains('is-refreshing')).toBe(false);
  });

});

describe('Refresh button pre-refresh hook (_onBeforeExternalCommentsRefresh)', () => {
  // The seam for the stale-PR-head fix. `trustPreciseAnchors` compares local
  // HEAD against a PR head from the TTL-less pr_metadata cache, so after a
  // push every thread renders degraded until something forces a re-read.
  // Local mode installs a forced PR-metadata refresh here; PR mode leaves
  // the hook null (no mode-sniffing — injection only).

  function makePRManager() {
    const prManager = createTestPRManager();
    prManager._loadExternalComments = vi.fn().mockResolvedValue(undefined);
    refreshButton._attrs = {};
    refreshButton.setAttribute = vi.fn(function (k, v) { this._attrs[k] = String(v); });
    refreshButton.removeAttribute = vi.fn(function (k) { delete this._attrs[k]; });
    refreshButton.getAttribute = vi.fn(function (k) { return this._attrs[k] || null; });
    return prManager;
  }

  it('awaits an installed hook BEFORE _loadExternalComments', async () => {
    const order = [];
    const prManager = makePRManager();
    let releaseHook;
    prManager._onBeforeExternalCommentsRefresh = vi.fn(() => new Promise((resolve) => {
      order.push('hook:start');
      releaseHook = () => { order.push('hook:end'); resolve(); };
    }));
    prManager._loadExternalComments = vi.fn(async () => { order.push('load'); });

    const inflight = prManager._handleExternalCommentsRefreshClick({ button: refreshButton });
    // The hook is genuinely awaited: the sync has not started yet.
    expect(order).toEqual(['hook:start']);
    expect(prManager._loadExternalComments).not.toHaveBeenCalled();

    releaseHook();
    await inflight;

    expect(order).toEqual(['hook:start', 'hook:end', 'load']);
    expect(prManager._onBeforeExternalCommentsRefresh).toHaveBeenCalledTimes(1);
  });

  it('a rejecting hook does NOT prevent the refresh', async () => {
    // A stale head only degrades placement; skipping the sync would lose
    // the new comments entirely. Failing open is the right trade.
    const prManager = makePRManager();
    prManager._onBeforeExternalCommentsRefresh = vi.fn().mockRejectedValue(new Error('metadata refresh boom'));

    await prManager._handleExternalCommentsRefreshClick({ button: refreshButton });

    expect(prManager._loadExternalComments).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalled();
    // Button state is still restored.
    expect(refreshButton.disabled).toBe(false);
    expect(refreshButton.getAttribute('aria-busy')).toBeNull();
  });

  it('an explicitly null hook (constructor default) is a no-op', async () => {
    const prManager = makePRManager();
    prManager._onBeforeExternalCommentsRefresh = null;

    await prManager._handleExternalCommentsRefreshClick({ button: refreshButton });

    expect(prManager._loadExternalComments).toHaveBeenCalledTimes(1);
  });

  it('with NO hook installed the sync starts on the same tick as before', async () => {
    // PR-mode parity guard. `await undefined` costs a microtask, so an
    // unconditional `await hook?.()` would push _loadExternalComments one
    // tick later than every pre-hook release. The production guard is
    // `typeof === 'function'` for exactly this reason; this test fails if
    // someone "simplifies" it back to an unconditional await.
    const prManager = makePRManager();

    prManager._handleExternalCommentsRefreshClick({ button: refreshButton });

    expect(prManager._loadExternalComments).toHaveBeenCalledTimes(1);
  });

  it('is not run when the capability gate rejects the click', async () => {
    const prManager = createTestPRManager({ capabilities: { canViewPRComments: false } });
    prManager._loadExternalComments = vi.fn().mockResolvedValue(undefined);
    prManager._onBeforeExternalCommentsRefresh = vi.fn().mockResolvedValue(undefined);

    await prManager._handleExternalCommentsRefreshClick({ button: refreshButton });

    expect(prManager._onBeforeExternalCommentsRefresh).not.toHaveBeenCalled();
    expect(prManager._loadExternalComments).not.toHaveBeenCalled();
  });
});

describe('PRManager._externalCommentsEnabled', () => {
  it('returns true when runtime config is absent', () => {
    delete window.PAIR_REVIEW_RUNTIME_CONFIG;
    const prManager = createTestPRManager();
    expect(prManager._externalCommentsEnabled()).toBe(true);
  });

  it('returns true when runtime config flag is true', () => {
    window.PAIR_REVIEW_RUNTIME_CONFIG = { external_comments_enabled: true };
    const prManager = createTestPRManager();
    expect(prManager._externalCommentsEnabled()).toBe(true);
  });

  it('returns false when runtime config flag is explicitly false', () => {
    window.PAIR_REVIEW_RUNTIME_CONFIG = { external_comments_enabled: false };
    const prManager = createTestPRManager();
    expect(prManager._externalCommentsEnabled()).toBe(false);
  });
});

describe('PRManager._externalAnchorContext', () => {
  // Anchor trust (plans/bridge-local-and-pr-modes.md decision 8): a comment's
  // (file, line, side) was resolved against the PR head commit. Trust those
  // numbers only when the diff on screen IS that commit.

  it('pure PR mode (no association): trusts precise anchors, names the PR, disarms gate 2', () => {
    const prManager = createTestPRManager();

    // `commitSha: null` is load-bearing: it disarms the manager's SECOND,
    // per-comment gate, so PR-mode rendering is byte-for-byte unchanged.
    // `trustLeftAnchors: true` is the parity half of the same promise: in PR
    // mode the left column IS the PR base, so LEFT threads keep placing
    // precisely exactly as they always have.
    expect(prManager._externalAnchorContext()).toEqual({
      trustPreciseAnchors: true,
      trustLeftAnchors: true,
      prNumber: 42,
      commitSha: null,
    });
  });

  it('no PR loaded at all: still trusted, with a null PR number', () => {
    const prManager = createTestPRManager({ currentPR: null });

    expect(prManager._externalAnchorContext()).toEqual({
      trustPreciseAnchors: true,
      trustLeftAnchors: true,
      prNumber: null,
      commitSha: null,
    });
  });

  it('association with matching head_sha: trusted, PR number from the association', () => {
    // Local HEAD == PR head means the rendered diff and the comment anchors
    // describe the same commit, so line numbers agree by construction.
    const prManager = createTestPRManager({
      currentPR: {
        id: 7,
        number: null,
        head_sha: 'abc123',
        associatedPR: { prNumber: 99, repository: 'owner/repo', head_sha: 'abc123' },
      },
    });

    // Gate 2 is armed with the commit this diff IS, so a comment written
    // against a commit the PR has since moved to is still caught per-thread.
    // Heads agreeing says nothing about the BASE, so LEFT stays untrusted.
    expect(prManager._externalAnchorContext()).toEqual({
      trustPreciseAnchors: true,
      trustLeftAnchors: false,
      prNumber: 99,
      commitSha: 'abc123',
    });
  });

  it('association with a different head_sha: NOT trusted', () => {
    const prManager = createTestPRManager({
      currentPR: {
        id: 7,
        head_sha: 'local-sha',
        associatedPR: { prNumber: 99, head_sha: 'pr-sha' },
      },
    });

    expect(prManager._externalAnchorContext()).toEqual({
      trustPreciseAnchors: false,
      trustLeftAnchors: false,
      prNumber: 99,
      commitSha: 'local-sha',
    });
  });

  // The `localHead && prHead &&` guards, not the `===`. With only ONE sha
  // missing the comparison is already false, so those guards are only load
  // bearing when BOTH are absent — `null === null` would otherwise report a
  // match and trust line numbers resolved against a commit we never saw.
  // Degrading is the honest answer; guessing they line up is the failure mode
  // this exists to stop.
  it('NEITHER head sha known (cold metadata cache, no local HEAD): NOT trusted', () => {
    const prManager = createTestPRManager({
      currentPR: { id: 7, head_sha: null, associatedPR: { prNumber: 99 } },
    });

    expect(prManager._externalAnchorContext()).toEqual({
      trustPreciseAnchors: false,
      trustLeftAnchors: false,
      prNumber: 99,
      commitSha: null,
    });
  });

  it('association without a PR number yields prNumber null (generic provenance wording)', () => {
    const prManager = createTestPRManager({
      currentPR: { id: 7, head_sha: 'abc', associatedPR: { head_sha: 'abc' } },
    });

    expect(prManager._externalAnchorContext()).toEqual({
      trustPreciseAnchors: true,
      trustLeftAnchors: false,
      prNumber: null,
      commitSha: 'abc',
    });
  });
});

describe('PRManager._externalAnchorContext LEFT-side (base) trust', () => {
  // A diff has TWO coordinate systems. `trustPreciseAnchors` compares heads,
  // which vouches only for RIGHT-side line numbers. LEFT-side comments (on
  // lines the PR removed) are numbered against the PR's BASE commit, while
  // the rendered left column is the local merge-base / --base override /
  // whatever the selected scope produces. `trustLeftAnchors` is the separate,
  // strictly narrower flag ExternalCommentManager reads for those threads.

  /**
   * @param {Object} [over] - Fields to override on the base fixture, which
   *   is the fully-trusted case: heads match, scope includes the branch, and
   *   both base shas agree.
   */
  function contextFor(over = {}) {
    const prManager = createTestPRManager({
      currentPR: {
        id: 7,
        head_sha: 'head-1',
        localBaseSha: 'base-1',
        scopeIncludesBranch: true,
        associatedPR: { prNumber: 99, head_sha: 'head-1', base_sha: 'base-1' },
        ...over,
      },
    });
    return prManager._externalAnchorContext();
  }

  it('scope includes branch AND bases match: LEFT anchors trusted', () => {
    const ctx = contextFor();
    expect(ctx.trustLeftAnchors).toBe(true);
    expect(ctx.trustPreciseAnchors).toBe(true);
  });

  it('scope does NOT include the branch: NOT trusted even though the bases match', () => {
    // The default local scope (unstaged..untracked) renders HEAD/index on
    // the left, which is not the merge-base at all — so a coincidental sha
    // match must not buy LEFT trust. This is the case the scope check exists
    // for; without it every default local session mis-anchors LEFT threads.
    const ctx = contextFor({ scopeIncludesBranch: false });
    expect(ctx.trustLeftAnchors).toBe(false);
    // Head trust is unaffected by the scope of the left side.
    expect(ctx.trustPreciseAnchors).toBe(true);
  });

  it('scopeIncludesBranch must be strictly true, not merely truthy', () => {
    const ctx = contextFor({ scopeIncludesBranch: 'yes' });
    expect(ctx.trustLeftAnchors).toBe(false);
    expect(ctx.trustPreciseAnchors).toBe(true);
  });

  it('bases differ: NOT trusted', () => {
    const ctx = contextFor({ localBaseSha: 'base-local' });
    expect(ctx.trustLeftAnchors).toBe(false);
    expect(ctx.trustPreciseAnchors).toBe(true);
  });

  // As with the head shas, one missing base already fails the `===`. The
  // `localBaseSha && prBaseSha &&` guards only earn their keep when NEITHER
  // is known — `null === null` would otherwise vouch for a left column
  // computed in a coordinate system we cannot see.
  it('NEITHER base sha known (no local merge-base, older association payload): NOT trusted', () => {
    const ctx = contextFor({
      localBaseSha: null,
      associatedPR: { prNumber: 99, head_sha: 'head-1' },
    });
    expect(ctx.trustLeftAnchors).toBe(false);
    expect(ctx.trustPreciseAnchors).toBe(true);
  });

  it('heads differ: LEFT trust cannot exceed head trust', () => {
    // trustLeftAnchors is strictly narrower — it is gated on
    // trustPreciseAnchors, so a moved local HEAD degrades both sides.
    const ctx = contextFor({ head_sha: 'head-moved' });
    expect(ctx.trustPreciseAnchors).toBe(false);
    expect(ctx.trustLeftAnchors).toBe(false);
  });

});

describe('PRManager._prepareExternalCommentManager', () => {
  it('pins the reviewId and forwards the anchor context', () => {
    const prManager = createTestPRManager();

    const manager = prManager._prepareExternalCommentManager();

    expect(manager).toBe(externalCommentManagerStub);
    expect(externalCommentManagerStub.reviewId).toBe(7);
    expect(externalCommentManagerStub.setAnchorContext).toHaveBeenCalledTimes(1);
    expect(externalCommentManagerStub.setAnchorContext).toHaveBeenCalledWith({
      trustPreciseAnchors: true,
      trustLeftAnchors: true,
      prNumber: 42,
      commitSha: null,
    });
  });

  it('leaves reviewId untouched when no PR is loaded', () => {
    const prManager = createTestPRManager({ currentPR: null });

    prManager._prepareExternalCommentManager();

    expect(externalCommentManagerStub.reviewId).toBeUndefined();
  });
});

describe('PRManager._updateExternalCommentsAffordances', () => {
  /** Attribute-tracking stand-in for #refresh-external-comments-btn-panel. */
  function makeToggleButton({ hidden = true } = {}) {
    const attrs = new Set(hidden ? ['hidden'] : []);
    return {
      setAttribute: vi.fn((name) => attrs.add(name)),
      removeAttribute: vi.fn((name) => attrs.delete(name)),
      hasAttribute: (name) => attrs.has(name),
    };
  }

  function installButton(btn) {
    global.document.getElementById = vi.fn((id) =>
      (id === 'refresh-external-comments-btn-panel' ? btn : null));
  }

  it('capability true: reveals the refresh button and the External segment', () => {
    const btn = makeToggleButton({ hidden: true });
    installButton(btn);
    const setExternalSegmentVisible = vi.fn();
    window.aiPanel = { setExternalSegmentVisible };
    const prManager = createTestPRManager();

    prManager._updateExternalCommentsAffordances();

    expect(btn.hasAttribute('hidden')).toBe(false);
    expect(setExternalSegmentVisible).toHaveBeenCalledWith(true);
  });

  it('capability false: hides both affordances', () => {
    const btn = makeToggleButton({ hidden: false });
    installButton(btn);
    const setExternalSegmentVisible = vi.fn();
    window.aiPanel = { setExternalSegmentVisible };
    const prManager = createTestPRManager({ capabilities: { canViewPRComments: false } });

    prManager._updateExternalCommentsAffordances();

    expect(btn.hasAttribute('hidden')).toBe(true);
    expect(setExternalSegmentVisible).toHaveBeenCalledWith(false);
  });

  it('feature toggle off beats a true capability (global kill switch)', () => {
    window.PAIR_REVIEW_RUNTIME_CONFIG = { external_comments_enabled: false };
    const btn = makeToggleButton({ hidden: false });
    installButton(btn);
    const setExternalSegmentVisible = vi.fn();
    window.aiPanel = { setExternalSegmentVisible };
    const prManager = createTestPRManager();

    prManager._updateExternalCommentsAffordances();

    expect(btn.hasAttribute('hidden')).toBe(true);
    expect(setExternalSegmentVisible).toHaveBeenCalledWith(false);
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
