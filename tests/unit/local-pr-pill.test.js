// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for the associated-PR header pill in local mode.
 *
 * Covers two behaviours that shipped broken in Phase 1:
 *   - a merged PR must render merged styling AND a merged tooltip (GitHub
 *     reports merged PRs as state 'closed' plus a separate `merged` boolean);
 *   - a cold metadata cache must trigger exactly one blocking /pr-metadata
 *     call, because nothing else re-renders this header in-session.
 *
 * Note the DOM here is hand-rolled rather than jsdom so the tests can assert
 * on attribute state directly. Whether `hidden` actually HIDES is a
 * computed-style question that only the E2E suite can answer — see
 * tests/e2e/local-pr-pill.spec.js.
 */

global.STALE_TIMEOUT = 2000;

const mockFetch = vi.fn();

/** Minimal stand-in for one element, tracking attributes and classes. */
function makeEl(id) {
  return {
    id,
    textContent: '',
    href: '',
    title: '',
    _attrs: new Set(),
    classList: {
      _set: new Set(),
      add(...names) { names.forEach(n => this._set.add(n)); },
      remove(...names) { names.forEach(n => this._set.delete(n)); },
      contains(n) { return this._set.has(n); },
    },
    setAttribute(name) { this._attrs.add(name); },
    removeAttribute(name) { this._attrs.delete(name); },
    hasAttribute(name) { return this._attrs.has(name); },
  };
}

let els;

beforeEach(() => {
  vi.resetAllMocks();
  global.fetch = mockFetch;

  els = {
    'local-pr-info': makeEl('local-pr-info'),
    'local-pr-link': makeEl('local-pr-link'),
    'local-pr-number': makeEl('local-pr-number'),
    'local-pr-title': makeEl('local-pr-title'),
    'local-pr-author': makeEl('local-pr-author'),
  };
  // Matches the static markup: the container starts hidden.
  els['local-pr-info'].setAttribute('hidden');

  global.window = {
    prManager: null,
    location: { pathname: '/local/42' },
    PAIR_REVIEW_LOCAL_MODE: true,
  };
  global.document = {
    getElementById: vi.fn((id) => els[id] || null),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
  };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const { LocalManager } = require('../../public/js/local.js');

function createManager(capabilities = {}) {
  const lm = Object.create(LocalManager.prototype);
  lm.reviewId = 42;
  lm.localData = null;
  lm._prMetadataWarmAttempted = false;
  lm._prMetadataWarmAttempts = 0;
  lm.capabilities = {
    hasAssociatedPR: false,
    hasGitHubToken: false,
    canShowPRMetadata: false,
    canViewPRComments: false,
    canCheckStaleVsPR: false,
    canSyncDrafts: false,
    canSubmitToGitHub: false,
    ...capabilities,
  };
  return lm;
}

const OPEN_PR = {
  prNumber: 7,
  repository: 'owner/repo',
  title: 'Add the thing',
  author: 'octocat',
  url: 'https://github.com/owner/repo/pull/7',
  state: 'open',
  merged: false,
  head_sha: 'abc123',
};

describe('LocalManager.renderAssociatedPRPill', () => {
  it('renders number, title, author and link when metadata is available', () => {
    const lm = createManager({ hasAssociatedPR: true, hasGitHubToken: true, canShowPRMetadata: true });

    lm.renderAssociatedPRPill({ associatedPR: OPEN_PR });

    expect(els['local-pr-info'].hasAttribute('hidden')).toBe(false);
    expect(els['local-pr-number'].textContent).toBe('#7');
    expect(els['local-pr-title'].textContent).toBe('Add the thing');
    expect(els['local-pr-author'].textContent).toBe('by octocat');
    expect(els['local-pr-link'].href).toBe('https://github.com/owner/repo/pull/7');
    expect(els['local-pr-link'].classList.contains('state-open')).toBe(true);
  });

  it('stays hidden when there is no association at all', () => {
    const lm = createManager();

    lm.renderAssociatedPRPill({ associatedPR: null });

    expect(els['local-pr-info'].hasAttribute('hidden')).toBe(true);
    // Nothing to warm up — no association means no endpoint call.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('stays hidden when the capability is off even though associatedPR is populated', () => {
    const lm = createManager({ hasAssociatedPR: true, canShowPRMetadata: false });

    lm.renderAssociatedPRPill({ associatedPR: { prNumber: 7, repository: 'owner/repo' } });

    expect(els['local-pr-info'].hasAttribute('hidden')).toBe(true);
  });

  it('falls back to a constructed GitHub URL when the cached url is missing', () => {
    const lm = createManager({ hasAssociatedPR: true, hasGitHubToken: true, canShowPRMetadata: true });

    lm.renderAssociatedPRPill({ associatedPR: { ...OPEN_PR, url: null } });

    expect(els['local-pr-link'].href).toBe('https://github.com/owner/repo/pull/7');
  });

  describe('merged PRs', () => {
    // Regression: `merged` used to be dropped, so a merged PR arrived as
    // state 'closed' and rendered with red closed styling and a '(closed)'
    // tooltip — .state-merged was unreachable dead CSS.
    const MERGED_PR = { ...OPEN_PR, state: 'closed', merged: true };

    it('applies state-merged rather than state-closed', () => {
      const lm = createManager({ hasAssociatedPR: true, hasGitHubToken: true, canShowPRMetadata: true });

      lm.renderAssociatedPRPill({ associatedPR: MERGED_PR });

      expect(els['local-pr-link'].classList.contains('state-merged')).toBe(true);
      expect(els['local-pr-link'].classList.contains('state-closed')).toBe(false);
    });

    it('labels the tooltip merged too, so styling and text agree', () => {
      const lm = createManager({ hasAssociatedPR: true, hasGitHubToken: true, canShowPRMetadata: true });

      lm.renderAssociatedPRPill({ associatedPR: MERGED_PR });

      expect(els['local-pr-link'].title).toContain('(merged)');
      expect(els['local-pr-link'].title).not.toContain('(closed)');
    });

    it('still renders state-closed for a genuinely closed PR', () => {
      const lm = createManager({ hasAssociatedPR: true, hasGitHubToken: true, canShowPRMetadata: true });

      lm.renderAssociatedPRPill({ associatedPR: { ...OPEN_PR, state: 'closed', merged: false } });

      expect(els['local-pr-link'].classList.contains('state-closed')).toBe(true);
      expect(els['local-pr-link'].title).toContain('(closed)');
    });

    it('clears a stale state class when re-rendered', () => {
      const lm = createManager({ hasAssociatedPR: true, hasGitHubToken: true, canShowPRMetadata: true });

      lm.renderAssociatedPRPill({ associatedPR: OPEN_PR });
      lm.renderAssociatedPRPill({ associatedPR: MERGED_PR });

      expect(els['local-pr-link'].classList.contains('state-open')).toBe(false);
      expect(els['local-pr-link'].classList.contains('state-merged')).toBe(true);
    });
  });
});

describe('LocalManager cold-cache PR metadata warm-up', () => {
  /** The cold-cache shape: association + token known, metadata not yet cached. */
  function coldManager() {
    const lm = createManager({ hasAssociatedPR: true, hasGitHubToken: true, canShowPRMetadata: false });
    lm.localData = { id: 42, branch: 'feature', associatedPR: { prNumber: 7, repository: 'owner/repo' } };
    return lm;
  }

  function respondWith(body) {
    mockFetch.mockResolvedValue({ ok: true, json: async () => body });
  }

  const WARM_RESPONSE = {
    capabilities: {
      hasAssociatedPR: true,
      hasGitHubToken: true,
      canShowPRMetadata: true,
      canViewPRComments: false,
      canCheckStaleVsPR: false,
      canSyncDrafts: false,
      canSubmitToGitHub: false,
    },
    associatedPR: OPEN_PR,
  };

  it('calls the blocking endpoint and renders the pill without a page reload', async () => {
    const lm = coldManager();
    respondWith(WARM_RESPONSE);

    lm.renderAssociatedPRPill(lm.localData);
    await vi.waitFor(() => expect(els['local-pr-info'].hasAttribute('hidden')).toBe(false));

    expect(mockFetch).toHaveBeenCalledWith('/api/local/42/pr-metadata');
    expect(els['local-pr-number'].textContent).toBe('#7');
  });

  /**
   * Renders repeatedly, settling each warm attempt before the next render.
   * `_prMetadataWarmAttempted` is the in-flight latch: it is held for the
   * duration of an attempt and released again only when the attempt failed, so
   * "back to false" is a deterministic completion signal — no sleeps.
   */
  async function renderUntilQuiet(lm, renders) {
    for (let i = 0; i < renders; i++) {
      lm.renderAssociatedPRPill(lm.localData);
      await vi.waitFor(() => expect(lm._prMetadataWarmAttempted).toBe(false));
    }
  }

  it('retries a failed warm on a later render instead of giving up for the session', async () => {
    // Regression: the latch was set before the await and never reset, so one
    // failed warm (network blip, or the loser of a concurrent-write race
    // answering canShowPRMetadata:false) hid the pill for the whole page
    // session — exactly what this endpoint exists to prevent.
    const lm = coldManager();
    mockFetch.mockRejectedValueOnce(new Error('offline'));

    lm.renderAssociatedPRPill(lm.localData);
    await vi.waitFor(() => expect(lm._prMetadataWarmAttempted).toBe(false));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(els['local-pr-info'].hasAttribute('hidden')).toBe(true);

    respondWith(WARM_RESPONSE);
    lm.renderAssociatedPRPill(lm.localData);

    await vi.waitFor(() => expect(els['local-pr-info'].hasAttribute('hidden')).toBe(false));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(els['local-pr-number'].textContent).toBe('#7');
  });

  it('retries a 200 that still reports no metadata (the race loser)', async () => {
    const lm = coldManager();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        capabilities: { ...WARM_RESPONSE.capabilities, canShowPRMetadata: false },
        associatedPR: { prNumber: 7, repository: 'owner/repo' },
      }),
    });

    lm.renderAssociatedPRPill(lm.localData);
    await vi.waitFor(() => expect(lm._prMetadataWarmAttempted).toBe(false));
    expect(els['local-pr-info'].hasAttribute('hidden')).toBe(true);

    respondWith(WARM_RESPONSE);
    lm.renderAssociatedPRPill(lm.localData);

    await vi.waitFor(() => expect(els['local-pr-info'].hasAttribute('hidden')).toBe(false));
  });

  it('does not spin: a permanently failing PR is capped for the page session', async () => {
    // The retry must not become a loop. renderAssociatedPRPill calls back into
    // the warm-up whenever the pill stays hidden, so an unbounded reset would
    // hammer the endpoint (and GitHub behind it) on a dead PR.
    const lm = coldManager();
    respondWith({
      capabilities: { ...WARM_RESPONSE.capabilities, canShowPRMetadata: false },
      associatedPR: { prNumber: 7, repository: 'owner/repo' },
    });

    await renderUntilQuiet(lm, 10);

    expect(mockFetch).toHaveBeenCalledTimes(LocalManager.MAX_PR_METADATA_WARM_ATTEMPTS);
    expect(els['local-pr-info'].hasAttribute('hidden')).toBe(true);
  });

  it('does not re-fetch after a successful warm', async () => {
    const lm = coldManager();
    respondWith(WARM_RESPONSE);

    lm.renderAssociatedPRPill(lm.localData);
    await vi.waitFor(() => expect(els['local-pr-info'].hasAttribute('hidden')).toBe(false));

    lm.renderAssociatedPRPill(lm.localData);
    lm.renderAssociatedPRPill(lm.localData);
    await new Promise(setImmediate);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not fire when there is no association', async () => {
    const lm = createManager({ hasAssociatedPR: false, hasGitHubToken: true });
    lm.localData = { id: 42, associatedPR: null };

    lm.renderAssociatedPRPill(lm.localData);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not fire when no GitHub token is available', async () => {
    const lm = createManager({ hasAssociatedPR: true, hasGitHubToken: false });
    lm.localData = { id: 42, associatedPR: { prNumber: 7, repository: 'owner/repo' } };

    lm.renderAssociatedPRPill(lm.localData);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not fire when metadata is already available', async () => {
    const lm = createManager({ hasAssociatedPR: true, hasGitHubToken: true, canShowPRMetadata: true });
    lm.localData = { id: 42, associatedPR: OPEN_PR };

    lm.renderAssociatedPRPill(lm.localData);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('merges into localData instead of overwriting it', async () => {
    // Hazard: _applyScopeResult mutates this.localData in place, so a scope
    // change landing while this request is in flight would be silently
    // reverted by a wholesale assignment.
    const lm = coldManager();
    let resolveFetch;
    mockFetch.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));

    lm.renderAssociatedPRPill(lm.localData);

    // Scope change completes mid-flight.
    lm.localData.scopeStart = 'branch';
    lm.localData.scopeEnd = 'untracked';
    lm.localData.baseBranch = 'develop';

    resolveFetch({ ok: true, json: async () => WARM_RESPONSE });
    await vi.waitFor(() => expect(lm.capabilities.canShowPRMetadata).toBe(true));

    expect(lm.localData.scopeStart).toBe('branch');
    expect(lm.localData.scopeEnd).toBe('untracked');
    expect(lm.localData.baseBranch).toBe('develop');
    expect(lm.localData.branch).toBe('feature');
    expect(lm.localData.associatedPR.title).toBe('Add the thing');
  });

  it('pushes the refreshed capabilities onto PRManager', async () => {
    const lm = coldManager();
    const pm = { capabilities: { ...lm.capabilities } };
    global.window.prManager = pm;
    respondWith(WARM_RESPONSE);

    lm.renderAssociatedPRPill(lm.localData);
    await vi.waitFor(() => expect(pm.capabilities.canShowPRMetadata).toBe(true));
  });

  it('leaves the pill hidden when the endpoint fails', async () => {
    const lm = coldManager();
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    lm.renderAssociatedPRPill(lm.localData);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    expect(els['local-pr-info'].hasAttribute('hidden')).toBe(true);
    expect(lm.capabilities.canShowPRMetadata).toBe(false);
  });

  it('swallows a network rejection without throwing', async () => {
    const lm = coldManager();
    mockFetch.mockRejectedValue(new Error('offline'));

    expect(() => lm.renderAssociatedPRPill(lm.localData)).not.toThrow();
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(els['local-pr-info'].hasAttribute('hidden')).toBe(true);
  });
});
