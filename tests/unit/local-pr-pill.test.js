// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for the local-mode surfaces of an associated GitHub PR: the
 * header pill (Phase 1) and the external-comment re-render path (Phase 2).
 *
 * Covers two behaviours that shipped broken in Phase 1:
 *   - a merged PR must render merged styling AND a merged tooltip (GitHub
 *     reports merged PRs as state 'closed' plus a separate `merged` boolean);
 *   - a cold metadata cache must trigger exactly one blocking /pr-metadata
 *     call, because nothing else re-renders this header in-session.
 *
 * Plus `_renderExternalComments`, the local-mode counterpart to PRManager's
 * `_rerenderAllOverlays` external leg: every diff rebuild has to re-anchor
 * the associated PR's comment rows, and every call re-reads the capability
 * rather than latching it (flags can arrive after the first paint).
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
// Real PRManager prototype: patchPRManager rebinds methods off the instance
// (loadAISuggestions), so the patch target has to be the genuine article.
const { PRManager } = require('../../public/js/pr.js');

function createManager(capabilities = {}) {
  const lm = Object.create(LocalManager.prototype);
  lm.reviewId = 42;
  lm.localData = null;
  lm._prMetadataWarmHolder = null;
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
   * `_prMetadataWarmHolder` is the in-flight hold: it is held for the duration
   * of an attempt and released again whenever the pill still cannot render, so
   * "back to null" is a deterministic completion signal — no sleeps.
   */
  async function renderUntilQuiet(lm, renders) {
    for (let i = 0; i < renders; i++) {
      lm.renderAssociatedPRPill(lm.localData);
      await vi.waitFor(() => expect(lm._prMetadataWarmHolder).toBeNull());
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
    await vi.waitFor(() => expect(lm._prMetadataWarmHolder).toBeNull());
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
    await vi.waitFor(() => expect(lm._prMetadataWarmHolder).toBeNull());
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

  it('FIRES when the association is not known yet — that is the deadlock breaker', async () => {
    // Was: "does not fire when there is no association". That guard was the
    // bug. On a modal local session (uncommitted changes on a PR branch) the
    // backend resolves the association in a background backfill that lands
    // AFTER the GET replied, so the client renders with hasAssociatedPR:false
    // — and the one call that could have corrected it was gated on that very
    // flag. Self-sustaining: the feature stayed invisible until a manual page
    // reload, and Refresh could not recover it either. The endpoint now runs
    // detection server-side when the row has none, so this call is what breaks
    // the deadlock.
    const lm = createManager({ hasAssociatedPR: false, hasGitHubToken: true });
    lm.localData = { id: 42, associatedPR: null };
    respondWith({
      capabilities: { ...WARM_RESPONSE.capabilities },
      associatedPR: OPEN_PR,
    });

    lm.renderAssociatedPRPill(lm.localData);

    await vi.waitFor(() => expect(els['local-pr-info'].hasAttribute('hidden')).toBe(false));
    expect(mockFetch).toHaveBeenCalledWith('/api/local/42/pr-metadata');
    expect(lm.capabilities.hasAssociatedPR).toBe(true);
  });

  it('keeps its retry budget when comments became viewable but metadata did NOT', async () => {
    // Regression, and the inverse of what this case used to assert. The warm-up
    // hold briefly keyed on "did anything move forward", which included
    // `canViewPRComments` — but that flag is just `hasAssociatedPR &&
    // hasGitHubToken` and says nothing about whether GitHub answered. A
    // transient 5xx that left prMetadata null therefore reported success: the
    // hold was never released, the remaining attempts never fired, and the pill
    // stayed hidden for the whole page session even after GitHub recovered.
    const lm = createManager({ hasAssociatedPR: true, hasGitHubToken: true });
    lm.localData = { id: 42, associatedPR: { prNumber: 7, repository: 'owner/repo' } };
    respondWith({
      capabilities: {
        ...WARM_RESPONSE.capabilities,
        canShowPRMetadata: false,   // GitHub 5xx'd — no metadata
        canViewPRComments: true,    // association + token, independent of that
      },
      associatedPR: null,
    });

    lm.renderAssociatedPRPill(lm.localData);
    await vi.waitFor(() => expect(lm.capabilities.canViewPRComments).toBe(true));

    // Hold released: the pill still cannot render, so a later trigger may retry.
    await vi.waitFor(() => expect(lm._prMetadataWarmHolder).toBeNull());

    // ...and the budget is genuinely still consumable: GitHub recovers and the
    // very next render brings the pill up, with no page reload.
    respondWith(WARM_RESPONSE);
    lm.renderAssociatedPRPill(lm.localData);

    await vi.waitFor(() => expect(els['local-pr-info'].hasAttribute('hidden')).toBe(false));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(els['local-pr-number'].textContent).toBe('#7');
  });

  it('still caps the budget when only the association resolves, so it cannot spin', async () => {
    // The flip side of the case above: releasing the hold on every
    // metadata-less response must not become an unbounded retry loop, because
    // renderAssociatedPRPill calls back in whenever the pill stays hidden.
    const lm = createManager({ hasAssociatedPR: false, hasGitHubToken: true });
    lm.localData = { id: 42, associatedPR: null };
    respondWith({
      capabilities: {
        ...WARM_RESPONSE.capabilities,
        canShowPRMetadata: false,
        canViewPRComments: true,
      },
      associatedPR: null,
    });

    await renderUntilQuiet(lm, 10);

    // Count the METADATA calls only. A response that newly resolves the
    // association also fires exactly one `prHeadOnly` check-stale — the
    // recovery path for a late association — which is not a warm-up attempt
    // and must not consume the budget it is unrelated to.
    const urls = mockFetch.mock.calls.map(([url]) => String(url));
    expect(urls.filter((u) => u.includes('/pr-metadata')))
      .toHaveLength(LocalManager.MAX_PR_METADATA_WARM_ATTEMPTS);
    expect(urls.filter((u) => u.includes('check-stale'))).toHaveLength(1);
    expect(els['local-pr-info'].hasAttribute('hidden')).toBe(true);
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

  /**
   * A PRManager stand-in with the full surface the apply block touches. The
   * bare `{ capabilities }` fixture above skips the association mirror (no
   * currentPR), no-ops the affordance call (optional chaining) and bails out
   * of the external re-render (no hasCapability) — so it can only ever assert
   * on the capability copy.
   */
  function installFullPRManager() {
    const pm = {
      capabilities: {},
      currentPR: { id: 42, head_sha: 'local', associatedPR: null },
      hasCapability: vi.fn((name) => Boolean(pm.capabilities && pm.capabilities[name])),
      _externalCommentsEnabled: vi.fn(() => true),
      _prepareExternalCommentManager: vi.fn(),
      _updateExternalCommentsAffordances: vi.fn(),
      _loadExternalComments: vi.fn().mockResolvedValue(undefined),
    };
    global.window.prManager = pm;
    const ecm = { loadAndRender: vi.fn().mockResolvedValue({ errors: [] }) };
    global.window.externalCommentManager = ecm;
    return { pm, ecm };
  }

  it('mirrors the PR head onto currentPR, updates affordances and re-anchors the rows', async () => {
    // This is the ONLY path that changes the anchor-trust answer mid-session:
    // it brings the PR's head_sha back, and `_externalAnchorContext` keeps
    // every thread at file level while that is unknown. Deleting the mirror or
    // the re-render leaves the suite fully green and the feature silently
    // degraded — hence the explicit assertions on both.
    //
    // `canViewPRComments` was ALREADY on here, so the re-render is the GET-only
    // re-anchor: the mirror is current and no sync POST is owed. (The
    // capability-flip case is the next describe block.)
    const lm = coldManager();
    lm.capabilities.canViewPRComments = true;
    const { pm, ecm } = installFullPRManager();
    respondWith({
      capabilities: { ...WARM_RESPONSE.capabilities, canViewPRComments: true },
      associatedPR: { ...OPEN_PR, head_sha: 'local' },
    });

    lm.renderAssociatedPRPill(lm.localData);
    await vi.waitFor(() => expect(ecm.loadAndRender).toHaveBeenCalledTimes(1));

    expect(pm.currentPR.associatedPR.head_sha).toBe('local');
    expect(pm._updateExternalCommentsAffordances).toHaveBeenCalledTimes(1);
    expect(pm._loadExternalComments).not.toHaveBeenCalled();
  });

  describe('a late capability flip must SYNC, not just re-render', () => {
    /**
     * The flagship scenario, traced end to end: local review, dirty tree,
     * branch has a PR, first ever page load. `GET /api/local/:id` answers
     * `hasAssociatedPR: false` because the association is written by a
     * background backfill that runs AFTER `res.json`. The hidden pill fires
     * this warm-up, whose response flips the capabilities on — but
     * `loadLocalReview`'s tail, the only other thing that syncs, already ran
     * and bailed on the false capability. A GET-only follow-up render then
     * reads the `external_comments` mirror table, which on a first-ever load
     * has NEVER been populated, and paints an empty External segment. Nothing
     * anywhere else syncs after a late flip, so the user sat in front of an
     * empty tab until a manual Refresh or a page reload.
     */
    it('syncs when the response flips canViewPRComments false -> true', async () => {
      const lm = createManager({ hasAssociatedPR: false, hasGitHubToken: true });
      lm.localData = { id: 42, associatedPR: null };
      const { pm, ecm } = installFullPRManager();
      respondWith({
        capabilities: { ...WARM_RESPONSE.capabilities, canViewPRComments: true },
        associatedPR: { ...OPEN_PR, head_sha: 'local' },
      });

      lm.renderAssociatedPRPill(lm.localData);

      // The sync path, not the GET path: `_loadExternalComments` is the
      // canonical sync+render entry point (it owns the POST).
      await vi.waitFor(() => expect(pm._loadExternalComments).toHaveBeenCalledTimes(1));
      expect(ecm.loadAndRender).not.toHaveBeenCalled();
    });

    // The "flag was already on" case — where an unconditional sync would fire
    // a redundant POST on every metadata refresh of a live review — is pinned
    // by 'mirrors the PR head onto currentPR...' above, which asserts the
    // GET-only re-anchor and `_loadExternalComments` never being called.

    it('does not sync when the flag stays off', async () => {
      const lm = coldManager();
      const { pm, ecm } = installFullPRManager();
      respondWith({
        capabilities: { ...WARM_RESPONSE.capabilities, canViewPRComments: false },
        associatedPR: OPEN_PR,
      });

      lm.renderAssociatedPRPill(lm.localData);
      await vi.waitFor(() => expect(pm._updateExternalCommentsAffordances).toHaveBeenCalled());
      await new Promise(setImmediate);

      expect(pm._loadExternalComments).not.toHaveBeenCalled();
      expect(ecm.loadAndRender).not.toHaveBeenCalled();
    });

    it('the sync is fire-and-forget: a slow one cannot delay the metadata read', async () => {
      // The metadata read must settle (pill rendered, capabilities applied)
      // while the sync is still in flight.
      const lm = createManager({ hasAssociatedPR: false, hasGitHubToken: true });
      lm.localData = { id: 42, associatedPR: null };
      const { pm } = installFullPRManager();
      let releaseSync;
      pm._loadExternalComments.mockImplementation(
        () => new Promise((resolve) => { releaseSync = resolve; })
      );
      respondWith({
        capabilities: { ...WARM_RESPONSE.capabilities, canViewPRComments: true },
        associatedPR: OPEN_PR,
      });

      const outcome = await lm._refreshPRMetadata();

      expect(outcome).toEqual({ metadataReady: true, progressed: true });
      expect(els['local-pr-info'].hasAttribute('hidden')).toBe(false);
      expect(pm._loadExternalComments).toHaveBeenCalledTimes(1);
      releaseSync();
    });

  });

  describe('_refreshPRMetadata outcome shape', () => {
    it('reports metadataReady separately from progressed', async () => {
      // The two questions the callers ask are independent: the pill's retry
      // hold keys on metadata readiness ALONE, while "did anything move" is
      // what tells the rest of the UI a late flip happened.
      const lm = createManager({ hasAssociatedPR: false, hasGitHubToken: true });
      lm.localData = { id: 42, associatedPR: null };
      respondWith({
        capabilities: {
          ...WARM_RESPONSE.capabilities,
          canShowPRMetadata: false,
          canViewPRComments: true,
        },
        associatedPR: null,
      });

      await expect(lm._refreshPRMetadata()).resolves.toEqual({
        metadataReady: false,
        progressed: true,
      });
    });

    it('reports neither for a 200 that changed nothing', async () => {
      const lm = createManager({ hasAssociatedPR: true, hasGitHubToken: true });
      lm.localData = { id: 42, associatedPR: OPEN_PR };
      respondWith({
        capabilities: {
          ...WARM_RESPONSE.capabilities,
          canShowPRMetadata: false,
          canViewPRComments: false,
        },
        associatedPR: null,
      });

      await expect(lm._refreshPRMetadata()).resolves.toEqual({
        metadataReady: false,
        progressed: false,
      });
    });

    it('reports neither when the request fails, whether by status or by rejection', async () => {
      const lm = coldManager();

      mockFetch.mockResolvedValue({ ok: false, status: 500 });
      await expect(lm._refreshPRMetadata()).resolves.toEqual({
        metadataReady: false,
        progressed: false,
      });

      mockFetch.mockRejectedValue(new Error('offline'));
      await expect(lm._refreshPRMetadata()).resolves.toEqual({
        metadataReady: false,
        progressed: false,
      });
    });
  });

  it('does not clobber a known association when the response carries none', async () => {
    // A null association means "could not resolve one", not "there is none".
    const lm = coldManager();
    const { pm } = installFullPRManager();
    pm.currentPR.associatedPR = { prNumber: 7, head_sha: 'kept' };
    lm.localData.associatedPR = { prNumber: 7, head_sha: 'kept' };
    respondWith({
      capabilities: { ...WARM_RESPONSE.capabilities, canShowPRMetadata: false },
      associatedPR: null,
    });

    lm.renderAssociatedPRPill(lm.localData);
    await vi.waitFor(() => expect(lm._prMetadataWarmHolder).toBeNull());

    expect(pm.currentPR.associatedPR.head_sha).toBe('kept');
    expect(lm.localData.associatedPR.head_sha).toBe('kept');
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

describe('LocalManager._renderExternalComments', () => {
  /**
   * The method reads everything off `window.prManager` (LocalManager copies
   * its capabilities onto that shared instance), so the fixture is a stand-in
   * PRManager plus the external-comment singleton.
   *
   * @param {Object} [options]
   * @param {boolean} [options.canViewPRComments]
   * @param {boolean} [options.externalCommentsEnabled] - the global kill switch
   */
  function installPRManager({ canViewPRComments = true, externalCommentsEnabled = true } = {}) {
    const pm = {
      hasCapability: vi.fn((name) => (name === 'canViewPRComments' ? canViewPRComments : false)),
      _externalCommentsEnabled: vi.fn(() => externalCommentsEnabled),
      _loadExternalComments: vi.fn().mockResolvedValue(undefined),
      _prepareExternalCommentManager: vi.fn(),
    };
    global.window.prManager = pm;
    return pm;
  }

  function installSingleton() {
    const ecm = { loadAndRender: vi.fn().mockResolvedValue({ errors: [] }) };
    global.window.externalCommentManager = ecm;
    return ecm;
  }

  it('sync: true routes through the canonical sync+render entry point', async () => {
    // `_loadExternalComments` owns the in-flight guard, the anchor context and
    // the sync-error toasts — the initial load and explicit refresh want all
    // three.
    const lm = createManager({ hasAssociatedPR: true, canViewPRComments: true });
    const pm = installPRManager();
    const ecm = installSingleton();

    await lm._renderExternalComments({ sync: true });

    expect(pm._loadExternalComments).toHaveBeenCalledTimes(1);
    expect(ecm.loadAndRender).not.toHaveBeenCalled();
  });

  it('default (no sync) re-anchors via prepare + loadAndRender, with no sync POST', async () => {
    // Diff rebuilds (scope change, whitespace toggle, base switch) only moved
    // the anchors; the local mirror is already current.
    const lm = createManager({ hasAssociatedPR: true, canViewPRComments: true });
    const pm = installPRManager();
    const ecm = installSingleton();

    await lm._renderExternalComments();

    expect(pm._prepareExternalCommentManager).toHaveBeenCalledTimes(1);
    expect(ecm.loadAndRender).toHaveBeenCalledTimes(1);
    expect(pm._loadExternalComments).not.toHaveBeenCalled();
  });

  it('bails when the external-comment singleton was never loaded', async () => {
    // Not a defensive nicety: local.html only ships
    // modules/external-comment-manager.js when the feature is on, so an
    // absent singleton is a real page state, reachable with the capability
    // true. Without the guard this throws on every diff rebuild.
    const lm = createManager({ hasAssociatedPR: true, canViewPRComments: true });
    const pm = installPRManager();
    delete global.window.externalCommentManager;

    await expect(lm._renderExternalComments({ sync: true })).resolves.toBeUndefined();
    expect(pm._loadExternalComments).not.toHaveBeenCalled();
  });

  it('bails when canViewPRComments is false', async () => {
    const lm = createManager();
    const pm = installPRManager({ canViewPRComments: false });
    const ecm = installSingleton();

    await lm._renderExternalComments({ sync: true });

    expect(pm._loadExternalComments).not.toHaveBeenCalled();
    expect(pm._prepareExternalCommentManager).not.toHaveBeenCalled();
    expect(ecm.loadAndRender).not.toHaveBeenCalled();
  });

  it('bails when the external_comments kill switch is off', async () => {
    const lm = createManager({ canViewPRComments: true });
    const pm = installPRManager({ externalCommentsEnabled: false });
    const ecm = installSingleton();

    await lm._renderExternalComments();

    expect(pm._prepareExternalCommentManager).not.toHaveBeenCalled();
    expect(ecm.loadAndRender).not.toHaveBeenCalled();
  });

  it('swallows a failing render: warns, never rejects', async () => {
    // Called from five diff-rebuild paths; a rejection there would abort the
    // rest of the rebuild (user comments, AI suggestions).
    const lm = createManager({ canViewPRComments: true });
    installPRManager();
    const ecm = installSingleton();
    ecm.loadAndRender.mockRejectedValueOnce(new Error('render boom'));

    await expect(lm._renderExternalComments()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

});

describe('LocalManager.patchPRManager capability floor', () => {
  /**
   * PRManager's constructor defaults every action flag TRUE — correct for PR
   * mode, where all those endpoints ship. On a local page that default is
   * wrong, and `loadLocalReview` only overwrites it once its fetch SUCCEEDS.
   * Patch time is the moment this page stops being a PR page, so the all-false
   * floor lands there instead.
   */
  function makePatchTarget() {
    const pm = Object.create(PRManager.prototype);
    pm.currentPR = null;
    // What the real constructor would have left behind.
    pm.capabilities = {
      hasAssociatedPR: true,
      hasGitHubToken: true,
      canShowPRMetadata: true,
      canViewPRComments: true,
      canCheckStaleVsPR: true,
      canSyncDrafts: true,
      canSubmitToGitHub: true,
    };
    global.window.prManager = pm;
    return pm;
  }

  it('replaces PRManager PR-mode defaults with the local all-false floor', () => {
    const lm = createManager();
    const pm = makePatchTarget();

    lm.patchPRManager();

    expect(pm.capabilities).toEqual({
      hasAssociatedPR: false,
      hasGitHubToken: false,
      canShowPRMetadata: false,
      canViewPRComments: false,
      canCheckStaleVsPR: false,
      canSyncDrafts: false,
      canSubmitToGitHub: false,
    });
    expect(pm.hasCapability('canSubmitToGitHub')).toBe(false);
    expect(pm.hasCapability('canViewPRComments')).toBe(false);
  });

  it('copies the floor, so a later PRManager mutation cannot leak back', () => {
    // `manager.capabilities = { ...this.capabilities }` — a shared reference
    // would let anything that writes a flag on the PRManager silently rewrite
    // LocalManager's own state, and the two would never disagree loudly.
    const lm = createManager();
    const pm = makePatchTarget();

    lm.patchPRManager();
    pm.capabilities.canSubmitToGitHub = true;

    expect(lm.capabilities.canSubmitToGitHub).toBe(false);
    expect(lm.hasCapability('canSubmitToGitHub')).toBe(false);
  });

  it('re-reads the capability on every call instead of latching it', () => {
    // Design requirement from plans/bridge-local-and-pr-modes.md: PR detection
    // is async, so capability flags legitimately arrive LATE. Callers must
    // re-render on the new answer, never cache the first one.
    const lm = createManager();

    expect(lm.hasCapability('canViewPRComments')).toBe(false);
    lm.capabilities.canViewPRComments = true;
    expect(lm.hasCapability('canViewPRComments')).toBe(true);
  });

  it('wires the External-segment pre-refresh hook to a forced metadata read', async () => {
    // PRManager awaits this before syncing external comments. Without it the
    // refresh button re-syncs the comments but still compares them against a
    // PR head from a cache that never expires.
    const lm = createManager();
    const pm = makePatchTarget();
    lm._refreshPRMetadata = vi.fn().mockResolvedValue(true);

    lm.patchPRManager();
    await pm._onBeforeExternalCommentsRefresh();

    expect(lm._refreshPRMetadata).toHaveBeenCalledWith({ force: true });
  });
});

describe('LocalManager forced PR-metadata re-reads', () => {
  /**
   * `trustPreciseAnchors` compares the local HEAD against a PR head held in a
   * TTL-less cache. Both sides move independently:
   *   - commit locally and refresh → local HEAD advances, cached PR head does
   *     not, every thread drops to the file zone carrying a "different commit"
   *     note that is false the moment the PR catches up;
   *   - push → the PR head advances while local HEAD sits still, so a
   *     HEAD-change trigger alone would never fire.
   * Hence two triggers, and `?refresh=1` to skip the cache.
   */
  const PUSHED_PR = { ...OPEN_PR, head_sha: 'pushed' };

  function fixture() {
    const lm = createManager({
      hasAssociatedPR: true, hasGitHubToken: true,
      canShowPRMetadata: true, canViewPRComments: true,
    });
    lm.localData = { id: 42, localHeadSha: 'sha-1', shaAbbrevLength: 7, associatedPR: OPEN_PR };
    lm.loadLocalDiff = vi.fn().mockResolvedValue(undefined);
    lm._rerenderLocalOverlays = vi.fn().mockResolvedValue(undefined);
    lm.updateLocalHeader = vi.fn();

    const pm = {
      capabilities: { ...lm.capabilities },
      currentPR: { id: 42, head_sha: 'sha-1', base_branch: 'main', associatedPR: OPEN_PR },
      // External rendering is out of scope here; keep it inert.
      hasCapability: vi.fn(() => false),
      _hideStaleBadge: vi.fn(),
      _stalenessPromise: null,
    };
    global.window.prManager = pm;

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        capabilities: {
          hasAssociatedPR: true, hasGitHubToken: true, canShowPRMetadata: true,
          canViewPRComments: true, canCheckStaleVsPR: false, canSyncDrafts: false,
          canSubmitToGitHub: false,
        },
        associatedPR: PUSHED_PR,
      }),
    });
    return { lm, pm };
  }

  const metadataCalls = () =>
    mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/pr-metadata'));

  it('forces a re-read when the refresh moved local HEAD (the pull case)', async () => {
    const { lm, pm } = fixture();

    await lm._applyRefreshedDiff(pm, { currentHeadSha: 'sha-2' }, { userInitiated: false });

    expect(metadataCalls()).toEqual(['/api/local/42/pr-metadata?refresh=1']);
    expect(pm.currentPR.associatedPR.head_sha).toBe('pushed');
  });

  it('forces a re-read on a user-initiated refresh even when HEAD did not move (the push case)', async () => {
    const { lm, pm } = fixture();

    await lm._applyRefreshedDiff(pm, { currentHeadSha: 'sha-1' }, { userInitiated: true });

    expect(metadataCalls()).toEqual(['/api/local/42/pr-metadata?refresh=1']);
  });

  it('does NOT re-read on a silent refresh with an unchanged HEAD', async () => {
    const { lm, pm } = fixture();

    await lm._applyRefreshedDiff(pm, { currentHeadSha: 'sha-1' }, { userInitiated: false });

    expect(metadataCalls()).toEqual([]);
  });

  it('lands the new PR head BEFORE the overlays are re-anchored', async () => {
    const { lm, pm } = fixture();
    let headAtRerender = null;
    lm._rerenderLocalOverlays = vi.fn(async () => {
      headAtRerender = pm.currentPR.associatedPR.head_sha;
    });

    await lm._applyRefreshedDiff(pm, { currentHeadSha: 'sha-2' }, { userInitiated: true });

    expect(headAtRerender).toBe('pushed');
  });

  it('the unforced warm-up path never asks for ?refresh=1', async () => {
    const lm = createManager({ hasAssociatedPR: true, hasGitHubToken: true, canShowPRMetadata: false });
    lm.localData = { id: 42, associatedPR: null };
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await lm._maybeWarmPRMetadata();

    expect(metadataCalls()).toEqual(['/api/local/42/pr-metadata']);
  });

  describe('the forced read and the header re-render share one hold', () => {
    /**
     * `_applyRefreshedDiff` re-renders the header right after the forced read,
     * and `updateLocalHeader` -> `renderAssociatedPRPill` calls back into the
     * warm-up whenever the pill is still hidden. Releasing the hold before
     * that re-render fired a SECOND, unforced /pr-metadata request on the very
     * next statement and burned one of the three per-page-load attempts.
     *
     * These cases run the REAL `updateLocalHeader` — stubbing it is exactly
     * what hid the double request.
     */
    function coldRefreshFixture() {
      const lm = createManager({
        hasAssociatedPR: true, hasGitHubToken: true, canShowPRMetadata: false,
      });
      lm.localData = { id: 42, localHeadSha: 'sha-1', shaAbbrevLength: 7, associatedPR: null };
      lm.loadLocalDiff = vi.fn().mockResolvedValue(undefined);
      lm._rerenderLocalOverlays = vi.fn().mockResolvedValue(undefined);

      const pm = {
        capabilities: { ...lm.capabilities },
        currentPR: { id: 42, head_sha: 'sha-1', base_branch: 'main', associatedPR: null },
        hasCapability: vi.fn(() => false),
        _hideStaleBadge: vi.fn(),
        _stalenessPromise: null,
      };
      global.window.prManager = pm;
      return { lm, pm };
    }

    /** A 200 that leaves the pill un-renderable, so the warm-up would retry. */
    function respondColdForever() {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          capabilities: {
            hasAssociatedPR: true, hasGitHubToken: true, canShowPRMetadata: false,
            canViewPRComments: false, canCheckStaleVsPR: false, canSyncDrafts: false,
            canSubmitToGitHub: false,
          },
          associatedPR: null,
        }),
      });
    }

    it('one Refresh produces exactly one /pr-metadata request, not two', async () => {
      const { lm, pm } = coldRefreshFixture();
      respondColdForever();

      await lm._applyRefreshedDiff(pm, { currentHeadSha: 'sha-1' }, { userInitiated: true });

      expect(metadataCalls()).toEqual(['/api/local/42/pr-metadata?refresh=1']);
      // ...and the budget the warm-up owns is untouched by the forced read.
      expect(lm._prMetadataWarmAttempts).toBe(0);
    });

    it('does not stomp a warm-up that is still in flight from page load', async () => {
      // The on-load staleness path can enter _applyRefreshedDiff while the
      // initial render's warm-up is still awaiting its response. A boolean
      // release would clear THAT path's hold, letting the header re-render
      // start yet another fetch.
      const { lm, pm } = coldRefreshFixture();
      let releaseWarm;
      mockFetch.mockImplementation((url) => {
        if (String(url).includes('refresh=1')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              capabilities: { ...lm.capabilities },
              associatedPR: null,
            }),
          });
        }
        // `_applyRefreshedDiff` also re-checks PR-head state after hiding the
        // stale badge (PR drift survives a refresh that cannot fix it). Answer
        // it explicitly: falling through would overwrite `releaseWarm` with
        // THIS request's resolver, and the parked warm-up below could then
        // never be released.
        if (String(url).includes('check-stale')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ isStale: false, reasons: [], prHead: null }),
          });
        }
        // The page-load warm-up: still in flight for the whole test.
        return new Promise((resolve) => { releaseWarm = resolve; });
      });

      // Page-load warm-up starts and parks on its response.
      const warming = lm._maybeWarmPRMetadata();
      const holderDuringWarm = lm._prMetadataWarmHolder;
      expect(holderDuringWarm).not.toBeNull();

      await lm._applyRefreshedDiff(pm, { currentHeadSha: 'sha-2' }, { userInitiated: true });

      // The in-flight warm-up still owns the hold, so the header re-render
      // inside _applyRefreshedDiff started nothing new.
      expect(lm._prMetadataWarmHolder).toBe(holderDuringWarm);
      expect(metadataCalls()).toEqual([
        '/api/local/42/pr-metadata',
        '/api/local/42/pr-metadata?refresh=1',
      ]);

      releaseWarm({ ok: false, status: 500 });
      await warming;
      // The warm-up releases its OWN hold when it finishes, as always.
      expect(lm._prMetadataWarmHolder).toBeNull();
    });
  });
});
