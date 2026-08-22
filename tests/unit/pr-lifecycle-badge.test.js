// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * PR mode: the LIFECYCLE badge slot (MERGED / CLOSED / none).
 *
 * The header renders a badge GROUP with independent slots. Lifecycle is the
 * one that answers "is this pull request still open?", and a page can sit open
 * across a merge, a close and a reopen — so every path holding a fresh
 * `state` / `merged` pair has to reconcile it, in BOTH directions.
 *
 * `refreshPR` used to clear only the freshness slot and say nothing about this
 * one, so a reopened PR kept showing CLOSED and a PR merged mid-session showed
 * nothing at all until a full page reload.
 */

global.STALE_TIMEOUT = 2000;

const { PRManager } = require('../../public/js/pr.js');

const mockFetch = vi.fn();

/**
 * Minimal stand-in for one badge element: the four things `_showStaleBadge`
 * and `_hideStaleBadge` actually touch.
 */
function makeBadge() {
  const classes = new Set();
  const textEl = { textContent: '' };
  return {
    _classes: classes,
    _text: textEl,
    classList: {
      add: (c) => classes.add(c),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
    },
    querySelector: (sel) => (sel === '.stale-badge-text' ? textEl : null),
    style: { display: 'none' },
    title: '',
  };
}

let badges;

beforeEach(() => {
  vi.resetAllMocks();

  global.fetch = mockFetch;
  badges = {
    'stale-badge': makeBadge(),
    'pr-state-badge': makeBadge(),
    'pr-drift-badge': makeBadge(),
  };

  global.window = {
    aiPanel: { showDismissedComments: false, setFileOrder: vi.fn(), setComments: vi.fn(), setAnalysisState: vi.fn(), setSummaryData: vi.fn() },
    FileOrderUtils: { sortFilesByPath: vi.fn((f) => f), createFileOrderMap: vi.fn(() => new Map()) },
    scrollTo: vi.fn(),
  };

  global.document = {
    getElementById: vi.fn((id) => badges[id] || null),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
  };

  global.alert = vi.fn();
  global.AbortController = AbortController;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The lifecycle slot as the user sees it: its label, or null when hidden. */
function lifecycleLabel() {
  const badge = badges['pr-state-badge'];
  return badge.style.display === 'none' ? null : badge._text.textContent;
}

function createTestPRManager() {
  const pm = Object.create(PRManager.prototype);
  pm.currentPR = { id: 1, owner: 'owner', repo: 'repo', number: 42 };
  pm.expandedFolders = new Set();
  pm.generatedFiles = new Map();
  pm.canonicalFileOrder = new Map();
  pm.loadUserComments = vi.fn().mockResolvedValue(undefined);
  pm.loadAISuggestions = vi.fn().mockResolvedValue(undefined);
  pm.loadAndDisplayFiles = vi.fn().mockResolvedValue(undefined);
  pm.renderPRHeader = vi.fn();
  pm._syncWorktreeDropdown = vi.fn();
  pm.showError = vi.fn();
  return pm;
}

/** Drive `refreshPR` against one canned refresh payload. */
async function refreshWith(pm, data) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: vi.fn().mockResolvedValue({ success: true, data: { ...pm.currentPR, ...data } }),
  });
  vi.spyOn(global, 'setTimeout').mockImplementation((cb) => cb());
  await pm.refreshPR();
}

describe('PRManager._applyPRLifecycleBadge', () => {
  it('shows MERGED for a merged PR, even though GitHub also calls it closed', () => {
    const pm = createTestPRManager();

    pm._applyPRLifecycleBadge({ state: 'closed', merged: true }, 'because reasons');

    expect(lifecycleLabel()).toBe('MERGED');
    expect(badges['pr-state-badge'].title).toBe('because reasons');
  });

  it('shows CLOSED for a closed-unmerged PR', () => {
    const pm = createTestPRManager();

    pm._applyPRLifecycleBadge({ state: 'closed', merged: false });

    expect(lifecycleLabel()).toBe('CLOSED');
  });

  it('clears the slot for an open PR, so a reopen can retract the badge', () => {
    const pm = createTestPRManager();
    pm._applyPRLifecycleBadge({ state: 'closed', merged: false });

    pm._applyPRLifecycleBadge({ state: 'open', merged: false });

    expect(lifecycleLabel()).toBeNull();
  });

  it('treats an absent state as open rather than guessing', () => {
    const pm = createTestPRManager();
    pm._applyPRLifecycleBadge({ state: 'closed', merged: false });

    pm._applyPRLifecycleBadge({});

    expect(lifecycleLabel()).toBeNull();
  });

  it('never touches the freshness or drift slots', () => {
    const pm = createTestPRManager();
    pm._showStaleBadge('stale');
    pm._showStaleBadge('pr-drift');

    pm._applyPRLifecycleBadge({ state: 'closed', merged: true });

    expect(badges['stale-badge'].style.display).toBe('');
    expect(badges['pr-drift-badge'].style.display).toBe('');
  });
});

describe('PRManager.refreshPR — lifecycle reconciliation', () => {
  it('retracts CLOSED when the refreshed PR is open again', async () => {
    const pm = createTestPRManager();
    // Page load found the PR closed.
    pm._applyPRLifecycleBadge({ state: 'closed', merged: false });
    expect(lifecycleLabel()).toBe('CLOSED');

    await refreshWith(pm, { state: 'open', merged: false });

    expect(lifecycleLabel()).toBeNull();
  });

  it('shows CLOSED when the PR was closed during the session', async () => {
    const pm = createTestPRManager();

    await refreshWith(pm, { state: 'closed', merged: false });

    expect(lifecycleLabel()).toBe('CLOSED');
  });

  it('shows MERGED when the PR was merged during the session', async () => {
    const pm = createTestPRManager();

    await refreshWith(pm, { state: 'closed', merged: true });

    expect(lifecycleLabel()).toBe('MERGED');
  });

  it('still clears the freshness slot, and still leaves drift alone', async () => {
    const pm = createTestPRManager();
    pm._showStaleBadge('stale');
    pm._showStaleBadge('pr-drift');

    await refreshWith(pm, { state: 'open', merged: false });

    expect(badges['stale-badge'].style.display).toBe('none');
    // A refresh re-read the PR; it did not move the local checkout.
    expect(badges['pr-drift-badge'].style.display).toBe('');
  });

  it('leaves every badge alone when the refresh request fails', async () => {
    const pm = createTestPRManager();
    pm._applyPRLifecycleBadge({ state: 'closed', merged: true });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: 'nope' }),
    });

    await pm.refreshPR();

    expect(lifecycleLabel()).toBe('MERGED');
  });
});

describe('PRManager._checkStalenessOnLoad — lifecycle slot', () => {
  /** Canned check-stale response for the on-load path. */
  function stalenessResponse(body) {
    mockFetch.mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(body) });
  }

  it('shows MERGED and leaves the freshness answer to run its own course', async () => {
    const pm = createTestPRManager();
    pm._hasActiveSessionData = vi.fn().mockResolvedValue(true);
    stalenessResponse({ isStale: true, prState: 'closed', merged: true, reasons: [] });

    await pm._checkStalenessOnLoad('owner', 'repo', 42);

    expect(lifecycleLabel()).toBe('MERGED');
    expect(badges['stale-badge'].style.display).toBe('');
  });

  it('leaves the lifecycle slot clear for an open PR', async () => {
    const pm = createTestPRManager();
    pm._hasActiveSessionData = vi.fn().mockResolvedValue(true);
    stalenessResponse({ isStale: false, prState: 'open', merged: false, reasons: [] });

    await pm._checkStalenessOnLoad('owner', 'repo', 42);

    expect(lifecycleLabel()).toBeNull();
  });
});
