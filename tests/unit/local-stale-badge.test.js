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

// The canonical reason messages the backend actually ships. Imported rather
// than retyped: a hand-written copy of a message string cannot catch a wording
// regression, it can only agree with itself.
const { STALE_REASONS } = require('../../src/providers/stale-check');

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

/**
 * Phase 3: the check-stale response also reports whether the associated
 * GitHub PR's head commit has moved (`prHead`) and why (`reasons`).
 *
 * isStale still means WORKING-TREE staleness only — PR drift must never leak
 * into it, or the silent-refresh branch would re-capture the diff forever.
 */
describe('LocalManager._checkLocalStalenessOnLoad — associated PR head', () => {
  /** Built from the real `STALE_REASONS` table — never a retyped message. */
  const reason = (code) => ({ code, message: STALE_REASONS[code] });
  const WORKING_TREE_REASON = reason('working-tree-changed');
  const DRIFT_REASON = reason('local-head-differs-from-pr');

  it('uses the real backend messages, not a local paraphrase', () => {
    // Guards the fixtures above: if a code is renamed out of STALE_REASONS,
    // `message` goes undefined and every `toContain(...)` below would pass
    // vacuously against an empty tooltip.
    expect(typeof WORKING_TREE_REASON.message).toBe('string');
    expect(WORKING_TREE_REASON.message.length).toBeGreaterThan(0);
    expect(typeof DRIFT_REASON.message).toBe('string');
    expect(DRIFT_REASON.message.length).toBeGreaterThan(0);
  });

  function makePRHead(overrides = {}) {
    return {
      checked: true,
      prNumber: 123,
      repository: 'owner/repo',
      localHeadSha: 'aaaaaaaaaaaa1111',
      remoteHeadSha: 'bbbbbbbbbbbb2222',
      cachedHeadSha: 'bbbbbbbbbbbb2222',
      drifted: false,
      prAdvanced: false,
      prState: 'open',
      merged: false,
      error: null,
      ...overrides
    };
  }

  /** LocalManager + PRManager pair with the PR-metadata refresh path stubbed. */
  function setup({ capabilities = { canCheckStaleVsPR: true } } = {}) {
    const lm = createTestLocalManager();
    const pm = createTestPRManager();
    lm.capabilities = capabilities;
    lm.refreshDiff = vi.fn().mockResolvedValue(undefined);
    lm._refreshPRMetadata = vi.fn().mockResolvedValue({ metadataReady: true, progressed: true });
    global.window.prManager = pm;
    global.window.chatPanel = { queueDiffStateNotification: vi.fn() };
    return { lm, pm };
  }

  it('shows no PR badge when prHead is null (no association / no credential)', async () => {
    const { lm, pm } = setup();
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      reasons: [],
      prHead: null
    });

    const result = await lm._checkLocalStalenessOnLoad();

    expect(result.prHead).toBeNull();
    expect(pm._showStaleBadge).not.toHaveBeenCalled();
    expect(lm.refreshDiff).not.toHaveBeenCalled();
    expect(lm._refreshPRMetadata).not.toHaveBeenCalled();
    expect(global.window.chatPanel.queueDiffStateNotification).not.toHaveBeenCalled();
  });

  it('shows STALE and PR DRIFT together — independent facts, independent slots', async () => {
    // These are two different questions with two different answers, and the
    // refresh button only answers one of them. A single badge element used to
    // force one to erase the other, and which one won depended on evaluation
    // order: the post-refresh path painted the informational PR DRIFT over the
    // actionable STALE.
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    pm._hasActiveSessionData.mockResolvedValue(true);
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: true,
      reasons: [WORKING_TREE_REASON, DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });

    await lm._checkLocalStalenessOnLoad();

    expect(pm._showStaleBadge).toHaveBeenCalledWith('stale', 'Working directory has changed');
    expect(pm._showStaleBadge).toHaveBeenCalledWith('pr-drift', expect.stringContaining('PR #123'));
  });

  it('shows STALE and MERGED together', async () => {
    const { lm, pm } = setup();
    pm._hasActiveSessionData.mockResolvedValue(true);
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: true,
      reasons: [WORKING_TREE_REASON, reason('pr-merged')],
      prHead: makePRHead({ merged: true, prState: 'closed' })
    });

    await lm._checkLocalStalenessOnLoad();

    expect(pm._showStaleBadge).toHaveBeenCalledWith('stale', 'Working directory has changed');
    expect(pm._showStaleBadge).toHaveBeenCalledWith(
      'merged', expect.stringContaining(STALE_REASONS['pr-merged'])
    );
  });

  it('tells the agent the working tree ALSO changed, rather than "could not be determined"', async () => {
    // The note used to be a two-way ternary on `isStale === false`, so a
    // genuine `true` was reported as unknown — the opposite of the backend's
    // answer, fed to the agent as fact.
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    pm._hasActiveSessionData.mockResolvedValue(true);
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: true,
      reasons: [WORKING_TREE_REASON, DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });

    await lm._checkLocalStalenessOnLoad();

    const queue = global.window.chatPanel.queueDiffStateNotification;
    const last = queue.mock.calls[queue.mock.calls.length - 1][0];
    expect(last).toContain('The working tree has also changed');
    expect(last).not.toContain('could not be determined');
    expect(last).not.toContain('The working tree is current');
    // ...and the earlier working-directory sentence is not simply lost: the
    // snapshot is single-valued, so the last message carries both facts.
    expect(last).toContain('PR #123');
  });

  it('shows the PR DRIFT badge with a reason-derived title when only the PR moved', async () => {
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      reasons: [DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });

    await lm._checkLocalStalenessOnLoad();

    expect(pm._showStaleBadge).toHaveBeenCalledTimes(1);
    const [type, title] = pm._showStaleBadge.mock.calls[0];
    expect(type).toBe('pr-drift');
    expect(title).toContain(DRIFT_REASON.message);
    expect(title).toContain('aaaaaaa');
    expect(title).toContain('bbbbbbb');
    expect(title).toContain('#123');
    // Abbreviated, not full SHAs
    expect(title).not.toContain('aaaaaaaaaaaa1111');
  });

  it('queues a chat notification naming the PR and both abbreviated SHAs on drift', async () => {
    const { lm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      reasons: [DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });

    await lm._checkLocalStalenessOnLoad();

    const queue = global.window.chatPanel.queueDiffStateNotification;
    expect(queue).toHaveBeenCalledTimes(1);
    const message = queue.mock.calls[0][0];
    expect(message).toContain('PR #123');
    expect(message).toContain('aaaaaaa');
    expect(message).toContain('bbbbbbb');
  });

  it('carries the HEAD-SHA-change sentence into the drift notification instead of losing it', async () => {
    // queueDiffStateNotification REPLACES the stored snapshot rather than
    // appending, so the drift call must restate the earlier fact.
    const { lm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      headShaChanged: true,
      previousHeadSha: 'cccccccccccc3333',
      currentHeadSha: 'aaaaaaaaaaaa1111',
      reasons: [DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });

    await lm._checkLocalStalenessOnLoad();

    const queue = global.window.chatPanel.queueDiffStateNotification;
    // First call: the existing HEAD-SHA notification. Second: drift, which
    // repeats it because it overwrites the snapshot.
    expect(queue).toHaveBeenCalledTimes(2);
    const last = queue.mock.calls[1][0];
    expect(last).toContain('HEAD SHA changed');
    expect(last).toContain('ccccccc');
    expect(last).toContain('PR #123');
  });

  it('does NOT trigger the silent refreshDiff path on PR drift', async () => {
    const { lm, pm } = setup();
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      reasons: [DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });

    await lm._checkLocalStalenessOnLoad();

    expect(lm.refreshDiff).not.toHaveBeenCalled();
    expect(pm._hasActiveSessionData).not.toHaveBeenCalled();
  });

  it('shows the MERGED badge when the associated PR is merged', async () => {
    const { lm, pm } = setup();
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      reasons: [reason('pr-merged')],
      prHead: makePRHead({ merged: true, prState: 'closed', drifted: true })
    });

    await lm._checkLocalStalenessOnLoad();

    // Asserted against the production table, not against the fixture string —
    // otherwise this only proves the test agrees with itself while the shipped
    // tooltip is free to change underneath it.
    expect(pm._showStaleBadge).toHaveBeenCalledWith('merged', STALE_REASONS['pr-merged']);
  });

  it('shows the CLOSED badge when the associated PR is closed but not merged', async () => {
    const { lm, pm } = setup();
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      reasons: [reason('pr-closed')],
      prHead: makePRHead({ prState: 'closed', merged: false })
    });

    await lm._checkLocalStalenessOnLoad();

    expect(pm._showStaleBadge).toHaveBeenCalledWith('closed', STALE_REASONS['pr-closed']);
  });

  it('shows nothing and notifies nothing when the PR-head fetch errored', async () => {
    const { lm, pm } = setup();
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      reasons: [],
      prHead: makePRHead({
        remoteHeadSha: null,
        drifted: true,
        prAdvanced: true,
        prState: null,
        error: 'GitHub request failed'
      })
    });

    const result = await lm._checkLocalStalenessOnLoad();

    expect(result).toBeTruthy();
    expect(pm._showStaleBadge).not.toHaveBeenCalled();
    expect(global.window.chatPanel.queueDiffStateNotification).not.toHaveBeenCalled();
    expect(lm._refreshPRMetadata).not.toHaveBeenCalled();
  });

  it('forces a PR-metadata refresh when prAdvanced is true', async () => {
    const { lm } = setup();
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      reasons: [reason('pr-head-moved')],
      prHead: makePRHead({ cachedHeadSha: 'oldoldoldold0000', prAdvanced: true })
    });

    await lm._checkLocalStalenessOnLoad();

    expect(lm._refreshPRMetadata).toHaveBeenCalledWith({ force: true });
  });

  it('acquires and releases the PR-metadata warm-up hold around the forced read', async () => {
    const { lm } = setup();
    let heldDuringFetch = null;
    lm._refreshPRMetadata = vi.fn().mockImplementation(async () => {
      heldDuringFetch = lm._prMetadataWarmHolder;
      return { metadataReady: true, progressed: true };
    });

    await lm._refreshPRMetadataIfPRAdvanced(makePRHead({ prAdvanced: true }));

    expect(heldDuringFetch).toBeTruthy();
    expect(lm._prMetadataWarmHolder).toBeNull();
  });

  it('still performs the forced read when another warm-up owns the hold, without clearing it', async () => {
    const { lm } = setup();
    const foreignHold = { held: true };
    lm._prMetadataWarmHolder = foreignHold;

    await lm._refreshPRMetadataIfPRAdvanced(makePRHead({ prAdvanced: true }));

    expect(lm._refreshPRMetadata).toHaveBeenCalledWith({ force: true });
    // Never steal or clear someone else's hold
    expect(lm._prMetadataWarmHolder).toBe(foreignHold);
  });

  it('does not refresh PR metadata when prAdvanced is false', async () => {
    const { lm } = setup();
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      reasons: [DRIFT_REASON],
      prHead: makePRHead({ drifted: true, prAdvanced: false })
    });

    await lm._checkLocalStalenessOnLoad();

    expect(lm._refreshPRMetadata).not.toHaveBeenCalled();
  });

  // ── The capability flag must never veto a fresher backend answer ─────
  //
  // `this.capabilities` is a PAGE-LOAD snapshot. On a dirty tree the
  // association is backfilled after the page-load GET responded, so
  // `canCheckStaleVsPR` is still false while check-stale has already resolved
  // the association and reported `prAdvanced: true`. `prAdvanced === true` can
  // only be produced by a backend that actually reached GitHub, which already
  // required the association and a usable credential.

  it('forces the PR-metadata refresh even when the canCheckStaleVsPR snapshot is stale', async () => {
    const { lm } = setup({ capabilities: { canCheckStaleVsPR: false, hasAssociatedPR: false } });
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      reasons: [],
      prHead: makePRHead({ cachedHeadSha: 'oldoldoldold0000', prAdvanced: true })
    });

    await lm._checkLocalStalenessOnLoad();

    // Skipping this left the TTL-less pr_metadata.head_sha behind, and that
    // value is one operand of the anchor-trust gate — external comments would
    // keep anchoring against a commit that is no longer the PR head.
    expect(lm._refreshPRMetadata).toHaveBeenCalledWith({ force: true });
  });

  it('calls _refreshPRMetadataIfPRAdvanced directly without consulting capabilities', async () => {
    const { lm } = setup({ capabilities: { canCheckStaleVsPR: false } });

    await lm._refreshPRMetadataIfPRAdvanced(makePRHead({ prAdvanced: true }));

    expect(lm._refreshPRMetadata).toHaveBeenCalledWith({ force: true });
  });

  it('shows the PR DRIFT badge even when the canCheckStaleVsPR snapshot is stale', async () => {
    // The badge has always been ungated (the backend answers `prHead: null`
    // when it did not look); this pins that deliberate asymmetry, which the
    // pre-existing capability test could not — it used `drifted: false`.
    const { lm, pm } = setup({ capabilities: { canCheckStaleVsPR: false } });
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      reasons: [DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });

    await lm._checkLocalStalenessOnLoad();

    expect(pm._showStaleBadge).toHaveBeenCalledWith('pr-drift', expect.stringContaining('PR #123'));
  });

  it('still refreshes PR metadata when the working tree is also stale', async () => {
    const { lm, pm } = setup();
    pm._hasActiveSessionData.mockResolvedValue(true);
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: true,
      reasons: [WORKING_TREE_REASON],
      prHead: makePRHead({ prAdvanced: true })
    });

    await lm._checkLocalStalenessOnLoad();

    expect(lm._refreshPRMetadata).toHaveBeenCalledWith({ force: true });
  });

  it('tolerates a missing/malformed reasons array', async () => {
    const { lm, pm } = setup();
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      prHead: makePRHead({ drifted: true })
    });

    await lm._checkLocalStalenessOnLoad();

    const [type, title] = pm._showStaleBadge.mock.calls[0];
    expect(type).toBe('pr-drift');
    expect(title).toContain('PR #123');
  });

  // ── isStale: null is "could not determine", not "current" ────────────
  //
  // The backend genuinely ships `isStale: null` WITH a populated prHead on the
  // 'No stored diff data found' path and on the handler's catch-all. The chat
  // notification goes into the agent's context as fact, so it may not upgrade
  // "do not know" into "the working tree is current".

  it('still shows the PR DRIFT badge when working-tree staleness is undetermined', async () => {
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: null,
      error: 'No stored diff data found',
      reasons: [DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });

    await lm._checkLocalStalenessOnLoad();

    expect(pm._showStaleBadge).toHaveBeenCalledWith('pr-drift', expect.stringContaining('PR #123'));
    // `isStale: null` must not fall into the silent-refresh branch either.
    expect(lm.refreshDiff).not.toHaveBeenCalled();
  });

  it('does not tell the agent the working tree is current when isStale is null', async () => {
    const { lm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: null,
      error: 'No stored diff data found',
      reasons: [DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });

    await lm._checkLocalStalenessOnLoad();

    const queue = global.window.chatPanel.queueDiffStateNotification;
    expect(queue).toHaveBeenCalledTimes(1);
    const message = queue.mock.calls[0][0];
    expect(message).toContain('PR #123');
    expect(message).not.toContain('The working tree is current');
    expect(message).toContain('could not be determined');
  });

  it('does claim the working tree is current when isStale is exactly false', async () => {
    const { lm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      reasons: [DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });

    await lm._checkLocalStalenessOnLoad();

    const message = global.window.chatPanel.queueDiffStateNotification.mock.calls[0][0];
    expect(message).toContain('The working tree is current');
  });

  // ── A refresh must not bury drift it cannot fix ──────────────────────

  /** Stub out everything `_applyRefreshedDiff` touches beyond the fixes. */
  function stubRefreshApply(lm) {
    lm._applyLeftAnchorInputs = vi.fn();
    lm.updateLocalHeader = vi.fn();
    lm.loadLocalDiff = vi.fn().mockResolvedValue(undefined);
    lm._rerenderLocalOverlays = vi.fn().mockResolvedValue(undefined);
  }

  it('clears only the STALE slot on refresh, and re-checks the PR head', async () => {
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    stubRefreshApply(lm);
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: null,
      prHeadOnly: true,
      reasons: [DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });
    // Spy that still calls through, so the fire-and-forget promise is awaitable.
    const recheck = vi.spyOn(lm, '_recheckPRHeadState');

    await lm._applyRefreshedDiff(pm, { currentHeadSha: 'aaaaaaaaaaaa1111' }, { userInitiated: true });
    expect(recheck).toHaveBeenCalledTimes(1);
    await recheck.mock.results[0].value;

    // A refresh fixes working-tree staleness and nothing else, so it may only
    // clear that slot — never the whole group.
    expect(pm._hideStaleBadge).toHaveBeenCalledWith('stale');
    for (const call of pm._hideStaleBadge.mock.calls) {
      expect(call[0]).toBeTruthy();
    }
    expect(pm._showStaleBadge).toHaveBeenCalledWith('pr-drift', expect.stringContaining('PR #123'));
  });

  it('asks for prHeadOnly on the post-refresh recheck — no second digest walk', async () => {
    const { lm, pm } = setup();
    stubRefreshApply(lm);
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: null, prHeadOnly: true, reasons: [], prHead: null
    });
    const recheck = vi.spyOn(lm, '_recheckPRHeadState');

    await lm._applyRefreshedDiff(pm, { currentHeadSha: 'aaaaaaaaaaaa1111' }, { userInitiated: true });
    await recheck.mock.results[0].value;

    expect(lm._fetchLocalStaleness).toHaveBeenCalledWith({ prHeadOnly: true });
  });

  it('keeps the "diff refreshed" sentence in the chat snapshot the recheck overwrites', async () => {
    // queueDiffStateNotification stores ONE snapshot per tab, so the drift
    // message that lands a round-trip after the refresh replaces it. Without
    // the preface the agent's only signal that the diff underneath it was
    // re-captured is destroyed.
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    stubRefreshApply(lm);
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: null,
      prHeadOnly: true,
      reasons: [DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });
    const recheck = vi.spyOn(lm, '_recheckPRHeadState');

    await lm._applyRefreshedDiff(
      pm,
      { currentHeadSha: 'aaaaaaaaaaaa1111', headShaChanged: true, previousHeadSha: 'cccccccccccc3333' },
      { userInitiated: true }
    );
    await recheck.mock.results[0].value;

    const queue = global.window.chatPanel.queueDiffStateNotification;
    const last = queue.mock.calls[queue.mock.calls.length - 1][0];
    expect(last).toContain('Local diff refreshed from working directory.');
    // The HEAD-change sentence rides in the same composed message — a second
    // queue call would simply have erased it.
    expect(last).toContain('HEAD SHA changed');
    expect(last).toContain('ccccccc');
    expect(last).toContain('PR #123');
    // `prHeadOnly` answers `isStale: null`, which here means "not asked" —
    // the diff was just re-captured, so do not report it as unknown.
    expect(last).not.toContain('could not be determined');
    expect(last).toContain('just re-captured');
  });

  it('never re-enters the refresh path from the post-refresh recheck', async () => {
    // _checkLocalStalenessOnLoad can call refreshDiff({silent:true}), which
    // re-enters _applyRefreshedDiff — so the recheck must not go through it.
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    stubRefreshApply(lm);
    lm._checkLocalStalenessOnLoad = vi.fn();
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: true,
      reasons: [WORKING_TREE_REASON, DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });
    const recheck = vi.spyOn(lm, '_recheckPRHeadState');

    await lm._applyRefreshedDiff(pm, { currentHeadSha: 'aaaaaaaaaaaa1111' }, { userInitiated: true });
    await recheck.mock.results[0].value;

    expect(lm.refreshDiff).not.toHaveBeenCalled();
    expect(lm._checkLocalStalenessOnLoad).not.toHaveBeenCalled();
    // A re-entry would have cleared the STALE slot a second time.
    expect(pm._hideStaleBadge.mock.calls.filter((c) => c[0] === 'stale')).toHaveLength(1);
  });

  it('leaves the badge hidden when the post-refresh recheck finds no drift', async () => {
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    stubRefreshApply(lm);
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: null,
      prHeadOnly: true,
      reasons: [],
      prHead: makePRHead({ drifted: false })
    });
    const recheck = vi.spyOn(lm, '_recheckPRHeadState');

    await lm._applyRefreshedDiff(pm, { currentHeadSha: 'aaaaaaaaaaaa1111' }, { userInitiated: true });
    await recheck.mock.results[0].value;

    expect(pm._showStaleBadge).not.toHaveBeenCalled();
    // ...and an answer of "the heads agree now" RETRACTS an older drift badge
    // rather than leaving it standing forever.
    expect(pm._hideStaleBadge).toHaveBeenCalledWith('drift');
  });

  // ── Ordering: the newest ANSWER must not lose to the newest RESPONSE ──

  it('drops a superseded staleness answer instead of repainting the badge', async () => {
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    const stale = { isStale: false, reasons: [DRIFT_REASON], prHead: makePRHead({ drifted: true }) };

    // Stamped as generation 1, then a newer check starts and finishes first.
    const generation = lm._nextPRHeadCheckGeneration();
    lm._nextPRHeadCheckGeneration();

    lm._applyPRHeadStaleState(stale, 7, { generation });

    expect(pm._showStaleBadge).not.toHaveBeenCalled();
    expect(pm._hideStaleBadge).not.toHaveBeenCalled();
    expect(global.window.chatPanel.queueDiffStateNotification).not.toHaveBeenCalled();
  });

  it('a slow older recheck cannot repaint what a newer one cleared', async () => {
    // The deferred-response shape: request A is issued first and answers LAST.
    // The refresh button re-enables before the recheck it fired has settled,
    // so a second refresh genuinely can start with the first still outstanding.
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    let releaseOlder;
    lm._fetchLocalStaleness = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseOlder = () => resolve({
          isStale: null, reasons: [DRIFT_REASON], prHead: makePRHead({ drifted: true })
        });
      }))
      .mockImplementationOnce(async () => ({
        isStale: null, reasons: [], prHead: makePRHead({ drifted: false })
      }));

    const older = lm._recheckPRHeadState();
    await lm._recheckPRHeadState();

    // The newer answer says the heads agree, and retracts the badge.
    expect(pm._hideStaleBadge).toHaveBeenCalledWith('drift');

    releaseOlder();
    await older;

    // ...and the older answer must not put PR DRIFT back up behind it.
    expect(pm._showStaleBadge).not.toHaveBeenCalled();
  });

  it('applies the answer that carries the current generation', async () => {
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    const generation = lm._nextPRHeadCheckGeneration();

    lm._applyPRHeadStaleState(
      { isStale: false, reasons: [DRIFT_REASON], prHead: makePRHead({ drifted: true }) },
      7,
      { generation }
    );

    expect(pm._showStaleBadge).toHaveBeenCalledWith('pr-drift', expect.stringContaining('PR #123'));
  });

  // ── The working-tree branch parks on awaits too ──────────────────────
  //
  // `_applyPRHeadStaleState` is stamped, but `_checkLocalStalenessOnLoad`
  // awaits twice more on its way to the STALE badge and the silent refresh.
  // An answer captured before a user refresh must not be spent after it.

  /**
   * Park a method on a promise this test releases by hand.
   *
   * `entered` resolves the moment the production code calls it, so the
   * interleaving is driven by the real event rather than by a duration.
   *
   * @param {*} value - what the parked call finally resolves to.
   */
  function park(value) {
    let release;
    let signalEntered;
    const entered = new Promise((resolve) => { signalEntered = resolve; });
    return {
      entered,
      impl: () => new Promise((resolve) => {
        release = () => resolve(value);
        signalEntered();
      }),
      release: () => release()
    };
  }

  it('does not repaint STALE when a refresh superseded the parked session-data query', async () => {
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn()
      // The on-load answer: the working tree moved and there is user work to
      // protect, so this check is headed straight for the STALE badge.
      .mockResolvedValueOnce({
        isStale: true,
        reasons: [WORKING_TREE_REASON],
        prHead: makePRHead({ prAdvanced: true })
      })
      // ...and the `prHeadOnly` answer the newer recheck reads.
      .mockResolvedValueOnce({
        isStale: null, reasons: [], prHead: makePRHead({ drifted: false })
      });

    const sessionData = park(true);
    pm._hasActiveSessionData.mockImplementation(sessionData.impl);

    const onLoad = lm._checkLocalStalenessOnLoad();
    await sessionData.entered;

    // The user hits Refresh while that query is outstanding. `refreshDiff`
    // stamps a newer WORKING-TREE generation before it POSTs (the recapture
    // rebaselines the digest this answer was compared against), and the recheck
    // it ends in stamps the PR-head one.
    lm._nextWorkingTreeCheckGeneration();
    await lm._recheckPRHeadState();

    sessionData.release();
    const result = await onLoad;

    expect(pm._showStaleBadge).not.toHaveBeenCalledWith('stale', expect.anything());
    expect(lm.refreshDiff).not.toHaveBeenCalled();
    expect(global.window.chatPanel.queueDiffStateNotification).not.toHaveBeenCalled();
    // ...and no second `?refresh=1` driven by a `prAdvanced` the refresh's own
    // forced read has already answered.
    expect(lm._refreshPRMetadata).not.toHaveBeenCalled();
    // The Analyze dialog awaits this promise and reads the value — guarding the
    // side effects must not change what it carries.
    expect(result).toMatchObject({ isStale: true });
  });

  it('does not start a silent refresh from a superseded staleness answer', async () => {
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn()
      .mockResolvedValueOnce({
        isStale: true,
        reasons: [WORKING_TREE_REASON],
        prHead: makePRHead({ prAdvanced: true })
      })
      .mockResolvedValueOnce({
        isStale: null, reasons: [], prHead: makePRHead({ drifted: false })
      });

    // No user work to protect — the auto-refresh branch.
    const sessionData = park(false);
    pm._hasActiveSessionData.mockImplementation(sessionData.impl);

    const onLoad = lm._checkLocalStalenessOnLoad();
    await sessionData.entered;
    // The user hits Refresh — see the test above for what that stamps.
    lm._nextWorkingTreeCheckGeneration();
    await lm._recheckPRHeadState();
    sessionData.release();
    await onLoad;

    // Re-capturing a diff the newer refresh just re-captured, on an `isStale`
    // read from before it.
    expect(lm.refreshDiff).not.toHaveBeenCalled();
    expect(lm._refreshPRMetadata).not.toHaveBeenCalled();
  });

  it('still delivers the answer when superseded before the badge is even decided', async () => {
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    pm._hasActiveSessionData.mockResolvedValue(true);

    const onLoadAnswer = {
      isStale: true,
      headShaChanged: true,
      previousHeadSha: 'cccccccccccc3333',
      currentHeadSha: 'aaaaaaaaaaaa1111',
      reasons: [WORKING_TREE_REASON],
      prHead: makePRHead({ prAdvanced: true })
    };
    const onLoadFetch = park(onLoadAnswer);
    lm._fetchLocalStaleness = vi.fn()
      .mockImplementationOnce(onLoadFetch.impl)
      .mockImplementationOnce(async () => ({
        isStale: null, reasons: [], prHead: makePRHead({ drifted: false })
      }));

    const onLoad = lm._checkLocalStalenessOnLoad();
    await onLoadFetch.entered;
    // The user hits Refresh — see the two tests above for what that stamps.
    lm._nextWorkingTreeCheckGeneration();
    await lm._recheckPRHeadState();
    onLoadFetch.release();
    const result = await onLoad;

    // Superseded at the very first await, so not even the HEAD-SHA snapshot the
    // agent would otherwise read as current.
    expect(global.window.chatPanel.queueDiffStateNotification).not.toHaveBeenCalled();
    expect(pm._hasActiveSessionData).not.toHaveBeenCalled();
    expect(pm._showStaleBadge).not.toHaveBeenCalledWith('stale', expect.anything());
    expect(lm._refreshPRMetadata).not.toHaveBeenCalled();
    // ...but `_stalenessPromise` still resolves to the answer itself.
    expect(result).toBe(onLoadAnswer);
  });

  it('shows STALE from the same parked fixture when nothing superseded it', async () => {
    // Control for the three above: the identical interleaving, minus the newer
    // generation, must still do all of it — otherwise those tests could pass by
    // the code simply doing nothing.
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: true,
      headShaChanged: true,
      previousHeadSha: 'cccccccccccc3333',
      currentHeadSha: 'aaaaaaaaaaaa1111',
      reasons: [WORKING_TREE_REASON],
      prHead: makePRHead({ prAdvanced: true })
    });
    const sessionData = park(true);
    pm._hasActiveSessionData.mockImplementation(sessionData.impl);

    const onLoad = lm._checkLocalStalenessOnLoad();
    await sessionData.entered;
    sessionData.release();
    await onLoad;

    expect(pm._showStaleBadge).toHaveBeenCalledWith('stale', 'Working directory has changed');
    expect(global.window.chatPanel.queueDiffStateNotification).toHaveBeenCalled();
    expect(lm._refreshPRMetadata).toHaveBeenCalledWith({ force: true });
  });

  it('starts the silent refresh from the same parked fixture when nothing superseded it', async () => {
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: true,
      reasons: [WORKING_TREE_REASON],
      prHead: makePRHead({ prAdvanced: true })
    });
    const sessionData = park(false);
    pm._hasActiveSessionData.mockImplementation(sessionData.impl);

    const onLoad = lm._checkLocalStalenessOnLoad();
    await sessionData.entered;
    sessionData.release();
    await onLoad;

    expect(lm.refreshDiff).toHaveBeenCalledWith({ silent: true });
  });

  it('keeps the prAdvanced convergence after its OWN silent refresh advanced the generation', async () => {
    // The refresh this check starts ends in `_recheckPRHeadState`, which stamps
    // a new generation — so a blanket "superseded?" guard on that await would be
    // a constant `true` and would kill the forced read on the one path that
    // still needs it: a silent refresh with local HEAD unchanged issues no
    // `?refresh=1` of its own, and the recheck it fires writes badges, not
    // metadata.
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    pm._hasActiveSessionData.mockResolvedValue(false);
    lm._fetchLocalStaleness = vi.fn()
      .mockResolvedValueOnce({
        isStale: true,
        reasons: [WORKING_TREE_REASON],
        prHead: makePRHead({ prAdvanced: true })
      })
      .mockResolvedValueOnce({
        isStale: null, reasons: [], prHead: makePRHead({ drifted: false })
      });
    // Stand in for the real refresh: HEAD unchanged and silent, so no forced
    // read — but the post-refresh recheck still bumps the counter.
    lm.refreshDiff = vi.fn().mockImplementation(async () => {
      await lm._recheckPRHeadState();
      return { forcedPRMetadataRead: false };
    });

    await lm._checkLocalStalenessOnLoad();

    expect(lm._refreshPRMetadata).toHaveBeenCalledWith({ force: true });
  });

  it('re-checks the PR head as soon as a late association resolves', async () => {
    // On a dirty tree the association is backfilled AFTER the page-load GET,
    // so the on-load check can answer `prHead: null` — and `_applyRefreshedDiff`
    // is the only other trigger. Without this the badge and the `prAdvanced`
    // convergence are dead for the whole session unless the user hits Refresh.
    const { lm, pm } = setup({ capabilities: { hasAssociatedPR: false, canViewPRComments: false } });
    // `setup` stubs the metadata read; this test exercises the real one.
    delete lm._refreshPRMetadata;
    pm._updateExternalCommentsAffordances = vi.fn();
    lm._renderExternalComments = vi.fn();
    lm.renderAssociatedPRPill = vi.fn();
    lm._recheckPRHeadState = vi.fn().mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        capabilities: { hasAssociatedPR: true, canShowPRMetadata: true, canViewPRComments: true },
        associatedPR: { prNumber: 123, repository: 'owner/repo', head_sha: 'bbbbbbbbbbbb2222' }
      })
    });

    await lm._refreshPRMetadata();

    expect(lm._recheckPRHeadState).toHaveBeenCalledTimes(1);
  });

  it('does not re-check the PR head when the association was already known', async () => {
    const { lm, pm } = setup({ capabilities: { hasAssociatedPR: true, canViewPRComments: true } });
    delete lm._refreshPRMetadata;
    pm._updateExternalCommentsAffordances = vi.fn();
    lm._renderExternalComments = vi.fn();
    lm.renderAssociatedPRPill = vi.fn();
    lm._recheckPRHeadState = vi.fn().mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        capabilities: { hasAssociatedPR: true, canShowPRMetadata: true, canViewPRComments: true },
        associatedPR: { prNumber: 123, repository: 'owner/repo' }
      })
    });

    await lm._refreshPRMetadata();

    expect(lm._recheckPRHeadState).not.toHaveBeenCalled();
  });

  it('drops a superseded PR-metadata response so it cannot revert head_sha', async () => {
    // A forced `?refresh=1` read may overlap an older unforced warm-up. If the
    // older one applies last, `associatedPR.head_sha` — one operand of the
    // anchor-trust gate — goes backwards.
    const { lm, pm } = setup({ capabilities: { hasAssociatedPR: true, canViewPRComments: true } });
    delete lm._refreshPRMetadata;
    pm._updateExternalCommentsAffordances = vi.fn();
    lm._renderExternalComments = vi.fn();
    lm.renderAssociatedPRPill = vi.fn();
    lm.localData = { id: 42, associatedPR: { prNumber: 123, head_sha: 'old' } };

    let releaseOld;
    mockFetch
      .mockImplementationOnce(() => new Promise((resolve) => { releaseOld = () => resolve({
        ok: true,
        json: async () => ({
          capabilities: { hasAssociatedPR: true, canShowPRMetadata: true },
          associatedPR: { prNumber: 123, head_sha: 'STALE_HEAD' }
        })
      }); }))
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({
          capabilities: { hasAssociatedPR: true, canShowPRMetadata: true },
          associatedPR: { prNumber: 123, head_sha: 'FRESH_HEAD' }
        })
      }));

    const older = lm._refreshPRMetadata();
    await lm._refreshPRMetadata({ force: true });
    expect(lm.localData.associatedPR.head_sha).toBe('FRESH_HEAD');

    releaseOld();
    await older;

    expect(lm.localData.associatedPR.head_sha).toBe('FRESH_HEAD');
  });

  it('swallows a failed recheck rather than surfacing a stale-badge error', async () => {
    const { lm, pm } = setup();
    stubRefreshApply(lm);
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue(null);
    const recheck = vi.spyOn(lm, '_recheckPRHeadState');

    await lm._applyRefreshedDiff(pm, { currentHeadSha: 'aaaaaaaaaaaa1111' }, { userInitiated: true });
    await expect(recheck.mock.results[0].value).resolves.toBeUndefined();
    expect(pm._showStaleBadge).not.toHaveBeenCalled();
  });

  // ── One forced PR-metadata read per silent auto-refresh, not two ─────

  it('skips the forced PR-metadata read the silent auto-refresh already made', async () => {
    const { lm, pm } = setup();
    pm._hasActiveSessionData.mockResolvedValue(false);
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: true,
      reasons: [WORKING_TREE_REASON],
      prHead: makePRHead({ prAdvanced: true })
    });
    lm.refreshDiff = vi.fn().mockResolvedValue({ forcedPRMetadataRead: true });

    await lm._checkLocalStalenessOnLoad();

    expect(lm.refreshDiff).toHaveBeenCalledWith({ silent: true });
    // The second `?refresh=1` would carry a prAdvanced computed BEFORE the
    // first one landed — always redundant.
    expect(lm._refreshPRMetadata).not.toHaveBeenCalled();
  });

  it('still makes the forced read when the silent refresh did not', async () => {
    const { lm, pm } = setup();
    pm._hasActiveSessionData.mockResolvedValue(false);
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: true,
      reasons: [WORKING_TREE_REASON],
      prHead: makePRHead({ prAdvanced: true })
    });
    // Local HEAD did not move and the refresh was silent, so _applyRefreshedDiff
    // skipped its forced read — nothing else will update the cached head_sha.
    lm.refreshDiff = vi.fn().mockResolvedValue({ forcedPRMetadataRead: false });

    await lm._checkLocalStalenessOnLoad();

    expect(lm._refreshPRMetadata).toHaveBeenCalledWith({ force: true });
  });

  it('still makes the forced read when the silent refresh bailed before applying', async () => {
    const { lm, pm } = setup();
    pm._hasActiveSessionData.mockResolvedValue(false);
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: true,
      reasons: [WORKING_TREE_REASON],
      prHead: makePRHead({ prAdvanced: true })
    });
    // refreshDiff resolves undefined when the button is missing/busy, the
    // HEAD-change dialog was cancelled, or the request threw.
    lm.refreshDiff = vi.fn().mockResolvedValue(undefined);

    await lm._checkLocalStalenessOnLoad();

    expect(lm._refreshPRMetadata).toHaveBeenCalledWith({ force: true });
  });

  it('reports whether _applyRefreshedDiff issued the forced read', async () => {
    const { lm, pm } = setup();
    stubRefreshApply(lm);
    lm._recheckPRHeadState = vi.fn().mockResolvedValue(undefined);

    // Silent + HEAD unchanged: no forced read.
    pm.currentPR.head_sha = 'aaaaaaaaaaaa1111';
    const quiet = await lm._applyRefreshedDiff(
      pm, { currentHeadSha: 'aaaaaaaaaaaa1111' }, { userInitiated: false }
    );
    expect(quiet).toEqual({ forcedPRMetadataRead: false });
    expect(lm._refreshPRMetadata).not.toHaveBeenCalled();

    // Silent + HEAD moved: forced read.
    const moved = await lm._applyRefreshedDiff(
      pm, { currentHeadSha: 'bbbbbbbbbbbb2222' }, { userInitiated: false }
    );
    expect(moved).toEqual({ forcedPRMetadataRead: true });
    expect(lm._refreshPRMetadata).toHaveBeenCalledWith({ force: true });
  });

  // ── Generations are per DOMAIN: PR-head answers and working-tree ─────
  //    answers supersede each other only within their own side.

  it('lets a PR-only recheck run without cancelling a pending working-tree answer', async () => {
    // `?prHeadOnly=1` never asks about the working tree and cannot recapture
    // it, so it has no standing to cancel the STALE badge. With one shared
    // counter it did — and every late-association recheck fires exactly here.
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn()
      .mockResolvedValueOnce({
        isStale: true,
        reasons: [WORKING_TREE_REASON],
        prHead: makePRHead({ prAdvanced: true })
      })
      .mockResolvedValueOnce({
        isStale: null, prHeadOnly: true, reasons: [], prHead: makePRHead({ drifted: false })
      });

    const sessionData = park(true);
    pm._hasActiveSessionData.mockImplementation(sessionData.impl);

    const onLoad = lm._checkLocalStalenessOnLoad();
    await sessionData.entered;
    // A late association resolves and re-asks about the PR head. No refresh:
    // the tree underneath this parked answer has not moved.
    await lm._recheckPRHeadState();
    sessionData.release();
    await onLoad;

    expect(pm._showStaleBadge).toHaveBeenCalledWith('stale', 'Working directory has changed');
    expect(global.window.chatPanel.queueDiffStateNotification).toHaveBeenCalled();
  });

  it('lets a PR-only recheck run without cancelling the silent refresh', async () => {
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn()
      .mockResolvedValueOnce({
        isStale: true,
        reasons: [WORKING_TREE_REASON],
        prHead: makePRHead({ prAdvanced: true })
      })
      .mockResolvedValueOnce({
        isStale: null, prHeadOnly: true, reasons: [], prHead: makePRHead({ drifted: false })
      });

    // No user work to protect: this session must still be brought forward.
    const sessionData = park(false);
    pm._hasActiveSessionData.mockImplementation(sessionData.impl);

    const onLoad = lm._checkLocalStalenessOnLoad();
    await sessionData.entered;
    await lm._recheckPRHeadState();
    sessionData.release();
    await onLoad;

    expect(lm.refreshDiff).toHaveBeenCalledWith({ silent: true });
  });

  it('keeps STALE and the silent refresh when the REAL late-association path re-checks', async () => {
    // End to end through the production trigger: `_refreshPRMetadata` resolves
    // an association the page-load GET could not see and fires
    // `_recheckPRHeadState` itself, while the on-load check is parked on its
    // session-data query. Nothing here may spend the working-tree answer.
    const { lm, pm } = setup({ capabilities: { hasAssociatedPR: false, canViewPRComments: false } });
    lm.localData = { shaAbbrevLength: 7 };
    delete lm._refreshPRMetadata; // exercise the real one
    pm._updateExternalCommentsAffordances = vi.fn();
    lm._renderExternalComments = vi.fn();
    lm.renderAssociatedPRPill = vi.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        capabilities: { hasAssociatedPR: true, canShowPRMetadata: true, canViewPRComments: true },
        associatedPR: { prNumber: 123, repository: 'owner/repo', head_sha: 'bbbbbbbbbbbb2222' }
      })
    });
    lm._fetchLocalStaleness = vi.fn()
      .mockResolvedValueOnce({
        isStale: true,
        reasons: [WORKING_TREE_REASON],
        prHead: makePRHead({ prAdvanced: false })
      })
      .mockResolvedValue({
        isStale: null, prHeadOnly: true, reasons: [], prHead: makePRHead({ drifted: false })
      });

    const sessionData = park(false);
    pm._hasActiveSessionData.mockImplementation(sessionData.impl);
    const recheck = vi.spyOn(lm, '_recheckPRHeadState');

    const onLoad = lm._checkLocalStalenessOnLoad();
    await sessionData.entered;

    await lm._refreshPRMetadata();
    expect(recheck).toHaveBeenCalledTimes(1);
    await recheck.mock.results[0].value;

    sessionData.release();
    await onLoad;

    // The empty session is still brought forward — nothing else ever would.
    expect(lm.refreshDiff).toHaveBeenCalledWith({ silent: true });
  });

  it('stamps the working-tree generation BEFORE the refresh POST', async () => {
    // A refresh does supersede a working-tree answer — and it has to stamp
    // before the round trip, or a parked check can start a second, concurrent
    // refresh of the diff this one is already recapturing.
    const { lm } = setup();
    delete lm.refreshDiff; // exercise the real one
    const btn = { disabled: false, classList: { add: vi.fn(), remove: vi.fn() } };
    global.document.getElementById = vi.fn((id) => (id === 'local-refresh-btn' ? btn : null));
    lm._applyRefreshedDiff = vi.fn().mockResolvedValue({ forcedPRMetadataRead: false });
    let generationAtPost = null;
    mockFetch.mockImplementation(async () => {
      generationAtPost = lm._workingTreeCheckGeneration;
      return { ok: true, json: async () => ({}) };
    });

    await lm.refreshDiff();

    expect(generationAtPost).toBe(1);
  });

  it('supersedes a parked working-tree answer once the recapture lands', async () => {
    // The other half of the split: `_applyRefreshedDiff` stamps too, so an
    // answer that arrived DURING the round trip is spent as well.
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    stubRefreshApply(lm);
    lm._recheckPRHeadState = vi.fn().mockResolvedValue(undefined);
    const before = lm._workingTreeCheckGeneration || 0;

    await lm._applyRefreshedDiff(pm, { currentHeadSha: 'aaaaaaaaaaaa1111' }, { userInitiated: false });

    expect(lm._workingTreeCheckGeneration).toBeGreaterThan(before);
  });

  // ── A PR-only recheck owes the prAdvanced convergence too ────────────

  it('drives the metadata convergence from the recheck, not just the badges', async () => {
    const { lm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: null,
      prHeadOnly: true,
      reasons: [reason('pr-head-moved')],
      prHead: makePRHead({ cachedHeadSha: 'oldoldoldold0000', prAdvanced: true })
    });

    await lm._recheckPRHeadState();

    // The TTL-less `pr_metadata.head_sha` is one operand of the anchor-trust
    // gate; badges alone leave it behind.
    expect(lm._refreshPRMetadata).toHaveBeenCalledWith({ force: true });
  });

  it('converges a late association backed by a warm-but-stale pr_metadata row', async () => {
    // The on-load check saw no association at all, so it never got to ask —
    // and the row the association resolves from can be arbitrarily old.
    const { lm, pm } = setup({ capabilities: { hasAssociatedPR: false, canViewPRComments: false } });
    lm.localData = { shaAbbrevLength: 7 };
    delete lm._refreshPRMetadata;
    pm._updateExternalCommentsAffordances = vi.fn();
    lm._renderExternalComments = vi.fn();
    lm.renderAssociatedPRPill = vi.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        capabilities: { hasAssociatedPR: true, canShowPRMetadata: true, canViewPRComments: true },
        associatedPR: { prNumber: 123, repository: 'owner/repo', head_sha: 'oldoldoldold0000' }
      })
    });
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: null,
      prHeadOnly: true,
      reasons: [reason('pr-head-moved')],
      prHead: makePRHead({ cachedHeadSha: 'oldoldoldold0000', prAdvanced: true })
    });
    const metadata = vi.spyOn(lm, '_refreshPRMetadata');
    const recheck = vi.spyOn(lm, '_recheckPRHeadState');

    await lm._refreshPRMetadata();
    await recheck.mock.results[0].value;

    // The cold read, then the forced re-read the recheck's `prAdvanced` earned.
    expect(metadata).toHaveBeenCalledWith({ force: true });
    // ...and it settles: the second read cannot re-announce a gained
    // association, so the recheck does not re-fire.
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  // ── "Not asked" is not "unknown" ─────────────────────────────────────

  it('composes the remembered working-tree fact into a late-association notification', async () => {
    // The full check established that the tree changed; the `prHeadOnly`
    // recheck that lands afterwards REPLACES the chat snapshot, so answering
    // its `isStale: null` as "could not be determined" destroys a known fact.
    const { lm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn()
      .mockResolvedValueOnce({
        isStale: true,
        reasons: [WORKING_TREE_REASON],
        prHead: null
      })
      .mockResolvedValueOnce({
        isStale: null,
        prHeadOnly: true,
        reasons: [DRIFT_REASON],
        prHead: makePRHead({ drifted: true })
      });

    await lm._checkLocalStalenessOnLoad();
    await lm._recheckPRHeadState();

    const queue = global.window.chatPanel.queueDiffStateNotification;
    const last = queue.mock.calls[queue.mock.calls.length - 1][0];
    expect(last).toContain('PR #123');
    expect(last).toContain('The working tree has also changed');
    expect(last).not.toContain('could not be determined');
  });

  it('omits the working-tree clause entirely when nothing has answered yet', async () => {
    // The other completion order: the recheck lands FIRST. "Not asked" is not
    // "unknown" — say nothing rather than something false.
    const { lm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: null,
      prHeadOnly: true,
      reasons: [DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });

    await lm._recheckPRHeadState();

    const queue = global.window.chatPanel.queueDiffStateNotification;
    const last = queue.mock.calls[queue.mock.calls.length - 1][0];
    expect(last).toContain('PR #123');
    expect(last).not.toContain('could not be determined');
    expect(last).not.toContain('working tree');
    expect(last).toContain('push or pull so the two agree.');
  });

  it('still reports "could not be determined" when a FULL check could not tell', async () => {
    // Control for the two above: `isStale: null` from a request that DID ask is
    // a genuine unknown and must keep saying so.
    const { lm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: null,
      error: 'No stored diff data found',
      reasons: [DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });

    await lm._checkLocalStalenessOnLoad();

    const queue = global.window.chatPanel.queueDiffStateNotification;
    const last = queue.mock.calls[queue.mock.calls.length - 1][0];
    expect(last).toContain('could not be determined');
  });

  it('remembers the re-capture, so a later recheck does not report it as unknown', async () => {
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    stubRefreshApply(lm);
    lm._recheckPRHeadState = vi.fn().mockResolvedValue(undefined);
    await lm._applyRefreshedDiff(pm, { currentHeadSha: 'aaaaaaaaaaaa1111' }, { userInitiated: false });

    // A late association resolves after the refresh and re-asks, with no
    // `workingTreeNote` of its own.
    delete lm._recheckPRHeadState;
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: null,
      prHeadOnly: true,
      reasons: [DRIFT_REASON],
      prHead: makePRHead({ drifted: true })
    });

    await lm._recheckPRHeadState();

    const queue = global.window.chatPanel.queueDiffStateNotification;
    const last = queue.mock.calls[queue.mock.calls.length - 1][0];
    expect(last).toContain('just re-captured');
    expect(last).not.toContain('could not be determined');
  });

  // ── `drifted` is tri-state: an unknown must not clear a known ─────────

  it('holds the PR DRIFT badge when drifted is null (one SHA unknown)', async () => {
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      reasons: [],
      prHead: makePRHead({ localHeadSha: null, drifted: null })
    });

    await lm._checkLocalStalenessOnLoad();

    // Neither painted nor retracted — the comparison was never made.
    expect(pm._showStaleBadge).not.toHaveBeenCalledWith('pr-drift', expect.anything());
    expect(pm._hideStaleBadge).not.toHaveBeenCalledWith('drift');
    // The lifecycle slot is a different question and still gets its answer.
    expect(pm._hideStaleBadge).toHaveBeenCalledWith('lifecycle');
  });

  it('retracts the PR DRIFT badge on an explicit false', async () => {
    // Control for the case above: a KNOWN "the heads agree now" still heals.
    const { lm, pm } = setup();
    lm.localData = { shaAbbrevLength: 7 };
    lm._fetchLocalStaleness = vi.fn().mockResolvedValue({
      isStale: false,
      reasons: [],
      prHead: makePRHead({ drifted: false })
    });

    await lm._checkLocalStalenessOnLoad();

    expect(pm._hideStaleBadge).toHaveBeenCalledWith('drift');
  });
});

describe('LocalManager.formatStaleReasons', () => {
  it('joins every reason message', () => {
    expect(LocalManager.formatStaleReasons([
      { code: 'working-tree-changed', message: 'Working directory has changed.' },
      { code: 'pr-head-moved', message: 'The PR head has moved.' }
    ])).toBe('Working directory has changed. The PR head has moved.');
  });

  it('returns an empty string for an empty or non-array input', () => {
    expect(LocalManager.formatStaleReasons([])).toBe('');
    expect(LocalManager.formatStaleReasons(undefined)).toBe('');
    expect(LocalManager.formatStaleReasons(null)).toBe('');
    expect(LocalManager.formatStaleReasons('nope')).toBe('');
  });

  it('skips entries without a usable message', () => {
    expect(LocalManager.formatStaleReasons([
      null,
      { code: 'x' },
      { code: 'y', message: '   ' },
      { code: 'z', message: ' Kept. ' }
    ])).toBe('Kept.');
  });
});

/**
 * The header badge GROUP. Three independent slots (freshness, PR lifecycle,
 * commit alignment), one element each — see STALE_BADGE_TYPES in
 * public/js/pr.js and the matching markup in public/local.html / public/pr.html.
 */
describe('PRManager badge group', () => {
  function createBadgeStub(text) {
    const classes = new Set();
    const textEl = { textContent: text };
    return {
      title: '',
      style: { display: 'none' },
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        contains: (n) => classes.has(n)
      },
      querySelector: () => textEl,
      _classes: classes,
      _textEl: textEl
    };
  }

  /** Mount all three slots, exactly as both pages ship them. */
  function mountGroup() {
    const badges = {
      'stale-badge': createBadgeStub('STALE'),
      'pr-state-badge': createBadgeStub(''),
      'pr-drift-badge': createBadgeStub('PR DRIFT')
    };
    global.document.getElementById = vi.fn((id) => badges[id] || null);
    return { badges, pm: Object.create(PRManager.prototype) };
  }

  const isVisible = (badge) => badge.style.display === '';

  it('renders PR DRIFT into its own element, with class and default tooltip', () => {
    const { badges, pm } = mountGroup();
    pm._showStaleBadge('pr-drift');

    const badge = badges['pr-drift-badge'];
    expect(badge._textEl.textContent).toBe('PR DRIFT');
    expect(badge._classes.has('pr-drift')).toBe(true);
    expect(badge.title).toBe('Your local HEAD is not the pull request head commit');
    expect(isVisible(badge)).toBe(true);
    // ...and does not touch the other slots.
    expect(isVisible(badges['stale-badge'])).toBe(false);
    expect(isVisible(badges['pr-state-badge'])).toBe(false);
  });

  it('uses a supplied title over the default', () => {
    const { badges, pm } = mountGroup();
    pm._showStaleBadge('pr-drift', 'Local HEAD abc1234, PR #7 head def5678.');
    expect(badges['pr-drift-badge'].title).toBe('Local HEAD abc1234, PR #7 head def5678.');
  });

  it('renders every applicable badge at once', () => {
    const { badges, pm } = mountGroup();
    pm._showStaleBadge('stale');
    pm._showStaleBadge('merged');
    pm._showStaleBadge('pr-drift');

    expect(isVisible(badges['stale-badge'])).toBe(true);
    expect(isVisible(badges['pr-state-badge'])).toBe(true);
    expect(isVisible(badges['pr-drift-badge'])).toBe(true);
    expect(badges['stale-badge']._textEl.textContent).toBe('STALE');
    expect(badges['pr-state-badge']._textEl.textContent).toBe('MERGED');
    expect(badges['pr-drift-badge']._textEl.textContent).toBe('PR DRIFT');
  });

  it('treats MERGED and CLOSED as the one exclusive pair — same slot', () => {
    const { badges, pm } = mountGroup();
    pm._showStaleBadge('merged');
    expect(badges['pr-state-badge']._classes.has('pr-merged')).toBe(true);

    pm._showStaleBadge('closed');
    expect(badges['pr-state-badge']._classes.has('pr-merged')).toBe(false);
    expect(badges['pr-state-badge']._classes.has('pr-closed')).toBe(true);
    expect(badges['pr-state-badge']._textEl.textContent).toBe('CLOSED');
  });

  it('keeps the existing default tooltips', () => {
    const { badges, pm } = mountGroup();
    pm._showStaleBadge('merged');
    expect(badges['pr-state-badge'].title).toBe('This PR has been merged');
    pm._showStaleBadge('closed');
    expect(badges['pr-state-badge'].title).toBe('This PR has been closed');
    pm._showStaleBadge('stale');
    expect(badges['stale-badge'].title).toBe('PR data is outdated');
  });

  it('hides one named slot and leaves the rest standing', () => {
    const { badges, pm } = mountGroup();
    pm._showStaleBadge('stale');
    pm._showStaleBadge('merged');
    pm._showStaleBadge('pr-drift');

    // What a refresh does: it fixed working-tree staleness and nothing else.
    pm._hideStaleBadge('stale');

    expect(isVisible(badges['stale-badge'])).toBe(false);
    expect(isVisible(badges['pr-state-badge'])).toBe(true);
    expect(isVisible(badges['pr-drift-badge'])).toBe(true);
  });

  it('accepts a badge TYPE as well as a slot name when hiding', () => {
    const { badges, pm } = mountGroup();
    pm._showStaleBadge('merged');
    pm._hideStaleBadge('merged');
    expect(isVisible(badges['pr-state-badge'])).toBe(false);

    pm._showStaleBadge('pr-drift');
    pm._hideStaleBadge('drift');
    expect(isVisible(badges['pr-drift-badge'])).toBe(false);
  });

  it('clears the whole group when called with no argument', () => {
    const { badges, pm } = mountGroup();
    pm._showStaleBadge('stale');
    pm._showStaleBadge('closed');
    pm._showStaleBadge('pr-drift');

    pm._hideStaleBadge();

    for (const badge of Object.values(badges)) {
      expect(isVisible(badge)).toBe(false);
    }
  });

  it('clears nothing — not everything — when handed an unknown slot name', () => {
    const { badges, pm } = mountGroup();
    pm._showStaleBadge('stale');
    pm._showStaleBadge('merged');

    pm._hideStaleBadge('staale');

    expect(isVisible(badges['stale-badge'])).toBe(true);
    expect(isVisible(badges['pr-state-badge'])).toBe(true);
  });

  it('is a no-op when a slot is missing from the page', () => {
    global.document.getElementById = vi.fn(() => null);
    const pm = Object.create(PRManager.prototype);
    expect(() => pm._showStaleBadge('pr-drift')).not.toThrow();
    expect(() => pm._hideStaleBadge()).not.toThrow();
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
