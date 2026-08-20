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

/**
 * In-memory Storage stand-in. This is a Node-environment test file (no jsdom,
 * no window), so `tests/setup/web-storage-polyfill.js` deliberately skips it
 * and the file owns `global.localStorage` itself.
 */
function makeLocalStorage() {
  const store = new Map();
  return {
    _store: store,
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(String(k)); },
    clear: () => store.clear(),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();

  global.fetch = mockFetch;
  global.localStorage = makeLocalStorage();
  // handleWhitespaceToggle restores scroll position through this.
  global.requestAnimationFrame = vi.fn((cb) => { cb(); return 1; });

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

describe('LocalManager._applyRefreshedDiff adopts the refreshed HEAD', () => {
  /**
   * `currentPR.head_sha` is set once at page load and read as "the commit this
   * diff IS" — `PRManager._externalAnchorContext` compares it against the
   * associated PR's head_sha to decide whether GitHub's line numbers may be
   * trusted, and forwards it as the manager's per-comment gate. A refresh that
   * moves HEAD but leaves it stale is how a mismatch starts looking like a
   * match.
   */
  let lm, pm;

  beforeEach(() => {
    lm = createTestLocalManager();
    pm = createTestPRManager();
    global.window.prManager = pm;
    lm.localData = { id: 42, localHeadSha: 'old-sha', shaAbbrevLength: 7 };
    lm.loadLocalDiff = vi.fn().mockResolvedValue(undefined);
    lm._renderExternalComments = vi.fn().mockResolvedValue(undefined);
    // Forced PR-metadata re-reads have their own coverage in
    // tests/unit/local-pr-pill.test.js; stub them out so these cases stay
    // about the HEAD adoption.
    lm._refreshPRMetadata = vi.fn().mockResolvedValue(false);
  });

  it('writes the new HEAD onto both currentPR.head_sha and localData.localHeadSha', async () => {
    pm.currentPR.head_sha = 'old-sha';

    await lm._applyRefreshedDiff(pm, { headShaChanged: true, previousHeadSha: 'old-sha', currentHeadSha: 'new-sha' });

    expect(pm.currentPR.head_sha).toBe('new-sha');
    expect(lm.localData.localHeadSha).toBe('new-sha');
  });

  it('leaves both untouched when the response carries no currentHeadSha', async () => {
    pm.currentPR.head_sha = 'old-sha';

    await lm._applyRefreshedDiff(pm, { stats: {} });

    expect(pm.currentPR.head_sha).toBe('old-sha');
    expect(lm.localData.localHeadSha).toBe('old-sha');
  });

  it('re-renders the header so the toolbar SHA matches the adopted HEAD', async () => {
    // updateLocalHeader is the ONLY writer of #pr-commit-sha / dataset.fullSha.
    // Before this it ran at initial load and on scope change only, so a
    // refresh that moved HEAD left the displayed SHA behind — and once
    // currentPR.head_sha started being adopted, the two diverged outright.
    pm.currentPR.head_sha = 'old-sha';
    lm.updateLocalHeader = vi.fn();

    await lm._applyRefreshedDiff(pm, { currentHeadSha: 'new-sha' });

    expect(lm.updateLocalHeader).toHaveBeenCalledWith(lm.localData);
    expect(lm.updateLocalHeader.mock.calls[0][0].localHeadSha).toBe('new-sha');
    // Before the rebuild, so the header never paints against a wiped diff.
    expect(lm.updateLocalHeader.mock.invocationCallOrder[0])
      .toBeLessThan(lm.loadLocalDiff.mock.invocationCallOrder[0]);
  });

  it('adopts the SHA BEFORE re-rendering external comments', async () => {
    // Ordering matters: the external re-render reads currentPR.head_sha to
    // build the anchor context, so a late assignment would render one pass
    // against the stale commit.
    pm.currentPR.head_sha = 'old-sha';
    let shaAtRender = null;
    lm._renderExternalComments = vi.fn(async () => { shaAtRender = pm.currentPR.head_sha; });

    await lm._applyRefreshedDiff(pm, { currentHeadSha: 'new-sha' });

    expect(lm._renderExternalComments).toHaveBeenCalledWith({ sync: true });
    expect(shaAtRender).toBe('new-sha');
  });
});

/**
 * Build a LocalManager + PRManager pair with the local-mode patches applied,
 * so a real diff-rebuild path can be driven end to end.
 *
 * `patchPRManager` REPLACES `loadAISuggestions` with the local-mode version,
 * so the overlay spies have to be installed AFTER patching, not before.
 */
function createPatchedPair() {
  const lm = createTestLocalManager();
  const pm = createTestPRManager();
  pm.currentPR = {
    id: 42, owner: 'local', repo: 'my-repo', number: 42, reviewType: 'local',
    localPath: '/repo/path', head_sha: 'sha-1', base_branch: 'main', head_branch: 'feature',
  };
  global.window.prManager = pm;

  lm.localData = { id: 42, localHeadSha: 'sha-1', shaAbbrevLength: 7, baseBranch: 'main' };
  lm.loadLocalDiff = vi.fn().mockResolvedValue(undefined);
  lm._renderExternalComments = vi.fn().mockResolvedValue(undefined);
  lm._refreshPRMetadata = vi.fn().mockResolvedValue(false);
  lm.patchPRManager();

  pm.loadUserComments = vi.fn().mockResolvedValue(undefined);
  pm.loadAISuggestions = vi.fn().mockResolvedValue(undefined);
  pm.selectedRunId = 'run-9';
  return { lm, pm };
}

/**
 * Assert every overlay layer came back exactly once, after the diff DOM was
 * rebuilt: user comments, AI suggestions AND the associated PR's rows.
 */
function expectOverlaysRestored(lm, pm, { sync = false } = {}) {
  expect(lm.loadLocalDiff).toHaveBeenCalledTimes(1);

  expect(pm.loadUserComments).toHaveBeenCalledTimes(1);
  expect(pm.loadUserComments).toHaveBeenCalledWith(false);

  expect(pm.loadAISuggestions).toHaveBeenCalledTimes(1);
  expect(pm.loadAISuggestions).toHaveBeenCalledWith(null, 'run-9');

  expect(lm._renderExternalComments).toHaveBeenCalledTimes(1);
  expect(lm._renderExternalComments).toHaveBeenCalledWith({ sync });

  const diffOrder = lm.loadLocalDiff.mock.invocationCallOrder[0];
  expect(pm.loadUserComments.mock.invocationCallOrder[0]).toBeGreaterThan(diffOrder);
  expect(pm.loadAISuggestions.mock.invocationCallOrder[0]).toBeGreaterThan(diffOrder);
  expect(lm._renderExternalComments.mock.invocationCallOrder[0]).toBeGreaterThan(diffOrder);
}

/** Minimal stand-in element that tracks attributes. */
function makeAttrEl() {
  return {
    _attrs: new Set(),
    setAttribute(name) { this._attrs.add(name); },
    removeAttribute(name) { this._attrs.delete(name); },
    hasAttribute(name) { return this._attrs.has(name); },
  };
}

/** DOM the base-branch selector needs, with the change listener capturable. */
function makeBaseSelectorDom() {
  const listeners = {};
  const sel = Object.assign(makeAttrEl(), {
    value: '',
    innerHTML: '',
    options: [],
    appendChild(option) { this.options.push(option); },
    addEventListener(type, handler) { listeners[type] = handler; },
    dispatch(type) { return listeners[type] ? listeners[type]() : undefined; },
    hasListener(type) { return Boolean(listeners[type]); },
  });
  const wrap = makeAttrEl();
  const staticBase = makeAttrEl();
  global.document.getElementById = vi.fn((id) => {
    if (id === 'base-branch-select') return sel;
    if (id === 'base-branch-selector-wrap') return wrap;
    if (id === 'toolbar-base-branch-static') return staticBase;
    return null;
  });
  global.document.createElement = vi.fn(() => ({ value: '', textContent: '', selected: false }));
  return { sel, wrap, staticBase };
}

describe('LocalManager._rerenderLocalOverlays', () => {
  /**
   * `PRManager.renderDiff` calls `pierreBridge.destroyAll()` and empties
   * #diff-container, restoring nothing. Every rebuild path therefore owes the
   * user all three overlay layers back. This is the local-mode counterpart to
   * `PRManager._rerenderAllOverlays` and exists for the same reason: the
   * sequence had been hand-copied at four call sites and drifted.
   */
  let lm, pm;

  beforeEach(() => {
    ({ lm, pm } = createPatchedPair());
  });

  it('restores user comments, AI suggestions and external comments in order', async () => {
    const order = [];
    pm.loadUserComments = vi.fn(async () => { order.push('comments'); });
    pm.loadAISuggestions = vi.fn(async () => { order.push('suggestions'); });
    lm._renderExternalComments = vi.fn(async () => { order.push('external'); });

    await lm._rerenderLocalOverlays();

    expect(order).toEqual(['comments', 'suggestions', 'external']);
  });

  it('passes the AI panel dismissed filter through to loadUserComments', async () => {
    global.window.aiPanel.showDismissedComments = true;

    await lm._rerenderLocalOverlays();

    expect(pm.loadUserComments).toHaveBeenCalledWith(true);
    global.window.aiPanel.showDismissedComments = false;
  });

  it('forwards sync:true to the external leg, and defaults to a GET-only re-anchor', async () => {
    await lm._rerenderLocalOverlays({ sync: true });
    expect(lm._renderExternalComments).toHaveBeenLastCalledWith({ sync: true });

    await lm._rerenderLocalOverlays();
    expect(lm._renderExternalComments).toHaveBeenLastCalledWith({ sync: false });
  });
});

describe('every local diff-rebuild path restores all three overlays', () => {
  /**
   * PR mode already guards this (see tests/unit/pr-external-comments-wiring.js:
   * "refreshPR previously rebuilt the diff DOM ... but forgot to re-run
   * external comments"). Local mode reintroduced the same sequence at four
   * sites with no equivalent guard, and the base-branch site was independently
   * defective — it re-rendered ONLY the external rows, so switching the base
   * branch on a stacked review dropped the user's draft comments and every AI
   * suggestion row from the diff.
   */
  it('whitespace toggle', async () => {
    const { lm, pm } = createPatchedPair();

    await pm.handleWhitespaceToggle(true);

    expect(pm.hideWhitespace).toBe(true);
    expectOverlaysRestored(lm, pm);
  });

  it('base branch selector change', async () => {
    const { lm, pm } = createPatchedPair();
    const { sel } = makeBaseSelectorDom();
    pm.currentPR.stack_data = [
      { branch: 'main' },
      { branch: 'mid', prNumber: 3 },
      { branch: 'feature' },
    ];

    pm.renderBaseBranchSelector(pm.currentPR);
    expect(sel.hasListener('change')).toBe(true);

    sel.value = 'mid';
    await sel.dispatch('change');

    expect(pm.currentBaseOverride).toBe('mid');
    expectOverlaysRestored(lm, pm);
  });

  it('refresh (with the external sync)', async () => {
    const { lm, pm } = createPatchedPair();

    await lm._applyRefreshedDiff(pm, { stats: {} });

    expectOverlaysRestored(lm, pm, { sync: true });
  });

  it('scope change', async () => {
    const { lm, pm } = createPatchedPair();

    await lm._applyScopeResult('branch', 'untracked', { baseBranch: 'main' });

    expectOverlaysRestored(lm, pm);
  });
});

describe('LEFT-side anchor inputs are mirrored onto currentPR', () => {
  /**
   * LEFT-side external comments carry line numbers from the PR's BASE commit;
   * the local diff's left column is the local merge base / base override /
   * scope. `PRManager._externalAnchorContext` answers "may those be equated?"
   * from currentPR.localBaseSha + currentPR.scopeIncludesBranch, so both must
   * be refreshed wherever they can change, BEFORE the re-anchor runs.
   */
  it('refresh mirrors mergeBaseSha and scopeIncludesBranch before the re-anchor', async () => {
    const { lm, pm } = createPatchedPair();
    let seen = null;
    lm._renderExternalComments = vi.fn(async () => {
      seen = { base: pm.currentPR.localBaseSha, branch: pm.currentPR.scopeIncludesBranch };
    });

    await lm._applyRefreshedDiff(pm, { mergeBaseSha: 'merge-base-1', scopeIncludesBranch: true });

    expect(pm.currentPR.localBaseSha).toBe('merge-base-1');
    expect(pm.currentPR.scopeIncludesBranch).toBe(true);
    expect(seen).toEqual({ base: 'merge-base-1', branch: true });
  });

  it('scope change mirrors them before the re-anchor, since scope flips LEFT trust', async () => {
    const { lm, pm } = createPatchedPair();
    pm.currentPR.localBaseSha = 'stale-base';
    pm.currentPR.scopeIncludesBranch = true;
    let seen = null;
    lm._renderExternalComments = vi.fn(async () => {
      seen = { base: pm.currentPR.localBaseSha, branch: pm.currentPR.scopeIncludesBranch };
    });

    await lm._applyScopeResult('unstaged', 'untracked', { scopeIncludesBranch: false, mergeBaseSha: null });

    expect(seen).toEqual({ base: null, branch: false });
  });

  it('normalises absent fields to null rather than leaving stale values', async () => {
    const { lm, pm } = createPatchedPair();
    pm.currentPR.localBaseSha = 'stale-base';
    pm.currentPR.scopeIncludesBranch = true;

    // A payload from a backend that does not send them at all (PR mode shape).
    await lm._applyRefreshedDiff(pm, { stats: {} });

    expect(pm.currentPR.localBaseSha).toBeNull();
    expect(pm.currentPR.scopeIncludesBranch).toBeNull();
  });

  describe('the base-branch selector', () => {
    /**
     * The override rebuilds the diff against an ANCESTOR branch, and
     * `GET /api/local/:id/diff?base=` returns no merge base for it. Leaving
     * the load-time merge base in place kept `_externalAnchorContext`
     * answering `trustLeftAnchors: true` while the left column was a
     * different coordinate system, so every LEFT-side (removed-line) PR
     * comment anchored confidently onto a line number computed against the
     * other base — the "line found, wrong content" case that gate exists to
     * prevent. Unknown is the only honest answer here.
     *
     * These cases assert through the REAL `PRManager._externalAnchorContext`,
     * the consumer that actually decides, rather than the mirrored field alone.
     */
    function stackedPair() {
      const { lm, pm } = createPatchedPair();
      pm.currentPR.stack_data = [
        { branch: 'main' },
        { branch: 'mid', prNumber: 3 },
        { branch: 'feature' },
      ];
      // A trusted LEFT-anchor starting position: heads match, bases match,
      // branch is in scope.
      pm.currentPR.associatedPR = {
        prNumber: 7, head_sha: 'sha-1', base_sha: 'merge-base-1',
      };
      pm.currentPR.localBaseSha = 'merge-base-1';
      pm.currentPR.scopeIncludesBranch = true;
      lm.localData.mergeBaseSha = 'merge-base-1';
      lm.localData.scopeIncludesBranch = true;
      return { lm, pm };
    }

    it('degrades LEFT trust when an ancestor base is selected', async () => {
      const { lm, pm } = stackedPair();
      const { sel } = makeBaseSelectorDom();
      expect(pm._externalAnchorContext().trustLeftAnchors).toBe(true);

      pm.renderBaseBranchSelector(pm.currentPR);
      sel.value = 'mid';
      await sel.dispatch('change');

      expect(pm.currentBaseOverride).toBe('mid');
      expect(pm.currentPR.localBaseSha).toBeNull();
      const ctx = pm._externalAnchorContext();
      expect(ctx.trustLeftAnchors).toBe(false);
      // RIGHT-side trust is untouched: local HEAD and the PR head still agree.
      expect(ctx.trustPreciseAnchors).toBe(true);
    });

    it('leaves scopeIncludesBranch alone — the scope did not change', async () => {
      const { lm, pm } = stackedPair();
      const { sel } = makeBaseSelectorDom();

      pm.renderBaseBranchSelector(pm.currentPR);
      sel.value = 'mid';
      await sel.dispatch('change');

      expect(pm.currentPR.scopeIncludesBranch).toBe(true);
      expect(lm.localData.scopeIncludesBranch).toBe(true);
    });

    it('clears the merge base BEFORE the overlays re-anchor', async () => {
      // Ordering is the whole point: the re-anchor reads the anchor context,
      // so a late clear would still render one pass under the old policy.
      const { lm, pm } = stackedPair();
      const { sel } = makeBaseSelectorDom();
      let trustedAtRender = null;
      lm._renderExternalComments = vi.fn(async () => {
        trustedAtRender = pm._externalAnchorContext().trustLeftAnchors;
      });

      pm.renderBaseBranchSelector(pm.currentPR);
      sel.value = 'mid';
      await sel.dispatch('change');

      expect(trustedAtRender).toBe(false);
    });

    it('restores the known merge base when the default base is selected again', async () => {
      // `localData.mergeBaseSha` is deliberately left intact by the override
      // path precisely so this restore has a value to read.
      const { lm, pm } = stackedPair();
      const { sel } = makeBaseSelectorDom();
      pm.renderBaseBranchSelector(pm.currentPR);

      sel.value = 'mid';
      await sel.dispatch('change');
      expect(pm.currentPR.localBaseSha).toBeNull();

      sel.value = 'main'; // currentPR.base_branch — clears the override
      await sel.dispatch('change');

      expect(pm.currentBaseOverride).toBeNull();
      expect(pm.currentPR.localBaseSha).toBe('merge-base-1');
      expect(pm._externalAnchorContext().trustLeftAnchors).toBe(true);
      expect(lm.localData.mergeBaseSha).toBe('merge-base-1');
    });

    it('stays degraded on restore when no merge base was ever reported', async () => {
      // Documented fallback: without a value to restore we say unknown rather
      // than guess. The next refresh or scope change re-supplies it.
      const { lm, pm } = stackedPair();
      delete lm.localData.mergeBaseSha;
      const { sel } = makeBaseSelectorDom();
      pm.renderBaseBranchSelector(pm.currentPR);

      sel.value = 'main';
      await sel.dispatch('change');

      expect(pm.currentPR.localBaseSha).toBeNull();
      expect(pm._externalAnchorContext().trustLeftAnchors).toBe(false);
    });
  });
});

describe('local viewed state survives a refresh that moves HEAD', () => {
  /**
   * The viewed-state localStorage key used to end in `head_sha`. A key MISS
   * does not leave the in-memory set alone — `loadViewedState` hard-resets
   * `viewedFiles` to empty — so committing and refreshing silently wiped every
   * checkmark, sidebar indicator and viewed-driven collapse, including on the
   * "Continue This Session — keep comments and suggestions" branch and on the
   * silent staleness refresh that runs on page load with zero interaction.
   *
   * These cases deliberately run the REAL `loadLocalDiff`, because that is
   * where `loadViewedState` is called from; stubbing it is exactly what let
   * the regression through.
   */
  const DIFF = [
    'diff --git a/src/a.js b/src/a.js',
    'index 1111111..2222222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');

  function createRealDiffPair() {
    const { lm, pm } = createPatchedPair();
    delete lm.loadLocalDiff; // fall back to the prototype implementation
    pm.generatedFiles = new Map();
    pm.updateFileList = vi.fn();
    pm.renderDiff = vi.fn();
    pm._upgradeFilesWithContents = vi.fn();
    mockFetch.mockImplementation((url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(String(url).includes('/diff') ? { diff: DIFF, stats: {} } : {}),
    }));
    return { lm, pm };
  }

  const legacyKey = (headSha) =>
    `pair-review-local-viewed:${btoa(unescape(encodeURIComponent('/repo/path')))}:${headSha}`;
  const sessionKey = `pair-review-local-viewed:${btoa(unescape(encodeURIComponent('/repo/path')))}:review-42`;

  it('keeps the marks when the refresh adopts a new HEAD', async () => {
    const { lm, pm } = createRealDiffPair();
    pm.viewedFiles = new Set(['src/a.js']);
    pm.saveViewedState();

    await lm._applyRefreshedDiff(
      pm,
      { headShaChanged: true, previousHeadSha: 'sha-1', currentHeadSha: 'sha-2' },
      { userInitiated: true }
    );

    // renderDiff proves the real loadLocalDiff ran — and with it the
    // `await manager.loadViewedState()` that used to reset the set.
    expect(pm.renderDiff).toHaveBeenCalledTimes(1);
    expect(pm.currentPR.head_sha).toBe('sha-2');
    expect(Array.from(pm.viewedFiles)).toEqual(['src/a.js']);
  });

  it('stores under a session-scoped key, not a commit-scoped one', () => {
    const { pm } = createPatchedPair();
    pm.viewedFiles = new Set(['src/a.js']);

    pm.saveViewedState();

    expect(global.localStorage.getItem(sessionKey)).toBe(JSON.stringify(['src/a.js']));
    expect(global.localStorage.getItem(legacyKey('sha-1'))).toBeNull();
  });

  it('reads through to a legacy commit-scoped value for the current HEAD', async () => {
    // Anyone mid-session across the upgrade keeps their marks without a
    // migration step; the next save writes the session key.
    global.localStorage.setItem(legacyKey('sha-1'), JSON.stringify(['src/a.js', 'src/b.js']));
    const { pm } = createPatchedPair();

    await pm.loadViewedState();

    expect(Array.from(pm.viewedFiles)).toEqual(['src/a.js', 'src/b.js']);

    pm.saveViewedState();
    expect(global.localStorage.getItem(sessionKey)).toBe(JSON.stringify(['src/a.js', 'src/b.js']));
  });

  it('prefers the session key over a stale legacy value', async () => {
    global.localStorage.setItem(legacyKey('sha-1'), JSON.stringify(['legacy.js']));
    global.localStorage.setItem(sessionKey, JSON.stringify(['current.js']));
    const { pm } = createPatchedPair();

    await pm.loadViewedState();

    expect(Array.from(pm.viewedFiles)).toEqual(['current.js']);
  });

  it('does nothing without a localPath to scope the key to', async () => {
    const { pm } = createPatchedPair();
    pm.currentPR.localPath = null;
    pm.viewedFiles = new Set(['keep.js']);

    pm.saveViewedState();
    await pm.loadViewedState();

    expect(global.localStorage._store.size).toBe(0);
    expect(Array.from(pm.viewedFiles)).toEqual(['keep.js']);
  });
});
