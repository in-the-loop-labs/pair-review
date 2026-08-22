// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Phase 4 of plans/bridge-local-and-pr-modes.md — pulling a draft review
 * started in the GitHub UI into a local session.
 *
 * jsdom rather than the hand-rolled DOM used by local-pr-pill.test.js, because
 * two of the behaviours here are only observable against a real DOM: the
 * button's visibility is an inline `display` toggle (the `hidden` attribute is
 * inert against `.btn`'s author-origin `display`), and
 * `updatePendingDraftIndicator` inserts a real element next to `#pr-commit`.
 */

const { LocalManager } = require('../../public/js/local.js');
const { PRManager } = require('../../public/js/pr.js');

const PENDING_DRAFT = {
  id: 3,
  github_review_id: '987654',
  github_node_id: 'PRR_localnode',
  github_url: 'https://github.com/owner/repo/pull/77#pullrequestreview-987654',
  comments_count: 2,
  created_at: '2026-01-01T00:00:00Z'
};

let mockFetch;
let externalUrlValue;
let repoLinksCalls;

function buildDom() {
  document.body.innerHTML = `
    <div class="toolbar-meta" id="toolbar-meta">
      <span class="toolbar-commit" id="pr-commit"><span id="pr-commit-sha">HEAD</span></span>
      <button class="btn btn-sm btn-icon" id="local-sync-drafts-btn" style="display: none;"></button>
    </div>
  `;
}

/** A LocalManager with only the state the draft-sync paths touch. */
function createManager(capabilities = {}) {
  const lm = Object.create(LocalManager.prototype);
  lm.reviewId = 42;
  lm.localData = null;
  lm._draftSyncPromise = null;
  lm._draftSyncAutoDone = false;
  lm.capabilities = {
    hasAssociatedPR: false,
    hasGitHubToken: false,
    canShowPRMetadata: false,
    canViewPRComments: false,
    canCheckStaleVsPR: false,
    canSyncDrafts: false,
    canSubmitToGitHub: false,
    ...capabilities
  };
  return lm;
}

/** A PRManager stand-in carrying the real indicator renderer. */
function createPRManager() {
  const manager = Object.create(PRManager.prototype);
  manager.currentPR = { id: 42, reviewType: 'local' };
  manager.capabilities = {};
  return manager;
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  buildDom();
  mockFetch = vi.fn();
  global.fetch = mockFetch;
  window.fetch = mockFetch;
  window.prManager = createPRManager();
  window.toast = {
    showSuccess: vi.fn(),
    showInfo: vi.fn(),
    showError: vi.fn(),
    showWarning: vi.fn()
  };
  // Shaped like the real public/js/repo-links.js: `draftUrl` is the shared
  // resolver both modes go through, and it prefers the configured template.
  // `externalUrlValue` is what a test wants that template to substitute to.
  externalUrlValue = null;
  repoLinksCalls = [];
  window.RepoLinks = {
    hostName: () => 'GitHub',
    externalUrl: () => externalUrlValue,
    draftUrl: (draft) => externalUrlValue || (draft && draft.github_url) || null,
    fetchAndApplyRepoLinks: vi.fn(async (owner, repo, context) => {
      repoLinksCalls.push({ owner, repo, context });
    })
  };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.prManager;
  delete window.toast;
  delete window.RepoLinks;
});

describe('LocalManager._updateDraftSyncAffordance', () => {
  it('leaves the button hidden when canSyncDrafts is false', () => {
    const lm = createManager();
    lm._updateDraftSyncAffordance();
    expect(document.getElementById('local-sync-drafts-btn').style.display).toBe('none');
  });

  it('shows the button when canSyncDrafts is true', () => {
    const lm = createManager({ canSyncDrafts: true });
    lm._updateDraftSyncAffordance();
    const btn = document.getElementById('local-sync-drafts-btn');
    expect(btn.style.display).toBe('');
    // Visibility must be a computed-style fact, not an attribute one: `hidden`
    // is inert against `.btn`'s author-origin `display`.
    expect(btn.hasAttribute('hidden')).toBe(false);
  });

  it('retracts the button when the capability goes away again', () => {
    // An association can be cleared (force-push to unrelated history). The
    // affordance must follow it down, not latch on the first true.
    const lm = createManager({ canSyncDrafts: true });
    lm._updateDraftSyncAffordance();
    lm.capabilities.canSyncDrafts = false;
    lm._updateDraftSyncAffordance();
    expect(document.getElementById('local-sync-drafts-btn').style.display).toBe('none');
  });

  it('clears the stale draft indicator when the capability goes away', async () => {
    // Retracting the button alone left a live "Draft on GitHub" link pointing
    // at a draft on a PR this session is no longer associated with — and the
    // one affordance that could have refreshed it was the button just hidden.
    // `_syncGitHubDrafts` bails on the lost capability, so nothing else can
    // ever deliver the clearing call.
    const lm = createManager({ canSyncDrafts: true });
    mockFetch.mockResolvedValue(jsonResponse({ pendingDraft: PENDING_DRAFT, allGithubReviews: [] }));
    await lm._syncGitHubDrafts();
    expect(document.getElementById('pending-draft-indicator')).not.toBeNull();

    lm.capabilities.canSyncDrafts = false;
    lm._updateDraftSyncAffordance();

    expect(document.getElementById('local-sync-drafts-btn').style.display).toBe('none');
    expect(document.getElementById('pending-draft-indicator')).toBeNull();
    expect(window.prManager.currentPR.pendingDraft).toBeNull();
  });

  it('attaches the click listener exactly once across repeated renders', async () => {
    const lm = createManager({ canSyncDrafts: true });
    mockFetch.mockResolvedValue(jsonResponse({ pendingDraft: null, allGithubReviews: [] }));

    lm._updateDraftSyncAffordance();
    lm._updateDraftSyncAffordance();
    lm._updateDraftSyncAffordance();

    document.getElementById('local-sync-drafts-btn').click();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });
});

describe('LocalManager._syncGitHubDrafts', () => {
  it('does nothing without the capability', async () => {
    const lm = createManager();
    await expect(lm._syncGitHubDrafts()).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs to the local endpoint and renders the pending draft indicator', async () => {
    const lm = createManager({ canSyncDrafts: true });
    mockFetch.mockResolvedValue(jsonResponse({ pendingDraft: PENDING_DRAFT, allGithubReviews: [] }));

    const result = await lm._syncGitHubDrafts();

    expect(mockFetch).toHaveBeenCalledWith('/api/local/42/sync-drafts', expect.objectContaining({ method: 'POST' }));
    expect(result).toEqual(PENDING_DRAFT);
    expect(window.prManager.currentPR.pendingDraft).toEqual(PENDING_DRAFT);

    const indicator = document.getElementById('pending-draft-indicator');
    expect(indicator).not.toBeNull();
    expect(indicator.textContent).toContain('2 comments');
  });

  it('resolves the indicator URL through the shared host-correct resolver', async () => {
    // An alternate host can report `github_url` as a wrong-host github.com
    // URL, so the configured template wins when it resolves — the same
    // precedence PR mode has always had. Local mode reaches it by feeding
    // RepoLinks the ASSOCIATED PR's number (see `_applyRepoLinks`).
    externalUrlValue = 'https://ghe.example/owner/repo/pull/77';
    const lm = createManager({ canSyncDrafts: true });
    mockFetch.mockResolvedValue(jsonResponse({ pendingDraft: PENDING_DRAFT, allGithubReviews: [] }));

    await lm._syncGitHubDrafts();

    expect(document.getElementById('pending-draft-indicator').getAttribute('href'))
      .toBe('https://ghe.example/owner/repo/pull/77');
  });

  it('falls back to the draft URL when no template resolves', async () => {
    const lm = createManager({ canSyncDrafts: true });
    mockFetch.mockResolvedValue(jsonResponse({ pendingDraft: PENDING_DRAFT, allGithubReviews: [] }));

    await lm._syncGitHubDrafts();

    expect(document.getElementById('pending-draft-indicator').getAttribute('href'))
      .toBe(PENDING_DRAFT.github_url);
  });

  it('waits for a late links refresh before rendering the indicator', async () => {
    // The association can resolve after the page load, and the links fetch it
    // triggers is asynchronous. Rendering before it lands would pin the
    // indicator to `github_url` for the rest of the session.
    const lm = createManager({ canSyncDrafts: true });
    let releaseLinks;
    lm._repoLinksPromise = new Promise((resolve) => {
      releaseLinks = () => { externalUrlValue = 'https://ghe.example/owner/repo/pull/77'; resolve(); };
    });
    mockFetch.mockResolvedValue(jsonResponse({ pendingDraft: PENDING_DRAFT, allGithubReviews: [] }));

    const sync = lm._syncGitHubDrafts();
    releaseLinks();
    await sync;

    expect(document.getElementById('pending-draft-indicator').getAttribute('href'))
      .toBe('https://ghe.example/owner/repo/pull/77');
  });

  it('clears the indicator when GitHub has no draft', async () => {
    const lm = createManager({ canSyncDrafts: true });
    mockFetch.mockResolvedValue(jsonResponse({ pendingDraft: PENDING_DRAFT, allGithubReviews: [] }));
    await lm._syncGitHubDrafts();
    expect(document.getElementById('pending-draft-indicator')).not.toBeNull();

    lm._draftSyncPromise = null;
    mockFetch.mockResolvedValue(jsonResponse({ pendingDraft: null, allGithubReviews: [] }));
    await lm._syncGitHubDrafts();

    expect(document.getElementById('pending-draft-indicator')).toBeNull();
    expect(window.prManager.currentPR.pendingDraft).toBeNull();
  });

  it('keeps the indicator when the server could not reach GitHub', async () => {
    // `pendingDraft: null` answers two questions. Clearing a live draft link
    // because GitHub was unreachable — and telling the user they have no draft
    // — is strictly worse than saying nothing.
    const lm = createManager({ canSyncDrafts: true });
    mockFetch.mockResolvedValue(jsonResponse({
      pendingDraft: PENDING_DRAFT, allGithubReviews: [], syncSucceeded: true
    }));
    await lm._syncGitHubDrafts();

    mockFetch.mockResolvedValue(jsonResponse({
      pendingDraft: null, allGithubReviews: [], syncSucceeded: false
    }));
    const result = await lm._syncGitHubDrafts({ manual: true });

    expect(result).toEqual(PENDING_DRAFT);
    expect(window.prManager.currentPR.pendingDraft).toEqual(PENDING_DRAFT);
    expect(document.getElementById('pending-draft-indicator')).not.toBeNull();
    expect(window.toast.showWarning).toHaveBeenCalledWith(expect.stringContaining('Could not reach GitHub'));
    expect(window.toast.showInfo).not.toHaveBeenCalled();
  });

  it('stays silent about an unreachable GitHub on the automatic sync', async () => {
    const lm = createManager({ canSyncDrafts: true });
    mockFetch.mockResolvedValue(jsonResponse({
      pendingDraft: null, allGithubReviews: [], syncSucceeded: false
    }));

    await lm._maybeAutoSyncGitHubDrafts();

    expect(window.toast.showWarning).not.toHaveBeenCalled();
  });

  it('still clears the indicator when GitHub authoritatively reports no draft', async () => {
    // The other side of the coin: a successful "no draft" MUST clear.
    const lm = createManager({ canSyncDrafts: true });
    mockFetch.mockResolvedValue(jsonResponse({
      pendingDraft: PENDING_DRAFT, allGithubReviews: [], syncSucceeded: true
    }));
    await lm._syncGitHubDrafts();

    mockFetch.mockResolvedValue(jsonResponse({
      pendingDraft: null, allGithubReviews: [], syncSucceeded: true
    }));
    await lm._syncGitHubDrafts();

    expect(document.getElementById('pending-draft-indicator')).toBeNull();
    expect(window.prManager.currentPR.pendingDraft).toBeNull();
  });

  it('joins an in-flight sync instead of opening a second one', async () => {
    // The button and the automatic load-time sync can fire milliseconds
    // apart; two concurrent POSTs race the mirror reconciliation and the
    // loser can create a SECOND pending row for one GitHub draft.
    const lm = createManager({ canSyncDrafts: true });
    let release;
    mockFetch.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve(jsonResponse({ pendingDraft: PENDING_DRAFT, allGithubReviews: [] }));
    }));

    const first = lm._syncGitHubDrafts();
    const second = lm._syncGitHubDrafts();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(PENDING_DRAFT);
    expect(b).toEqual(PENDING_DRAFT);
  });

  it('releases the in-flight join after a failure so a retry can run', async () => {
    const lm = createManager({ canSyncDrafts: true });
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
    await lm._syncGitHubDrafts({ manual: true });

    mockFetch.mockResolvedValueOnce(jsonResponse({ pendingDraft: PENDING_DRAFT, allGithubReviews: [] }));
    const retry = await lm._syncGitHubDrafts({ manual: true });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(retry).toEqual(PENDING_DRAFT);
  });

  it('reports a manual failure with the server message and does not throw', async () => {
    const lm = createManager({ canSyncDrafts: true });
    mockFetch.mockResolvedValue(jsonResponse(
      { error: 'This local review has no associated pull request' },
      { ok: false, status: 403 }
    ));

    await expect(lm._syncGitHubDrafts({ manual: true })).resolves.toBeNull();
    expect(window.toast.showError).toHaveBeenCalledWith(
      expect.stringContaining('no associated pull request')
    );
  });

  it('stays silent on an automatic failure', async () => {
    const lm = createManager({ canSyncDrafts: true });
    mockFetch.mockRejectedValue(new Error('offline'));

    await expect(lm._syncGitHubDrafts()).resolves.toBeNull();
    expect(window.toast.showError).not.toHaveBeenCalled();
    expect(window.toast.showSuccess).not.toHaveBeenCalled();
  });

  it('re-syncs external comments only on a manual sync', async () => {
    // A draft SUBMITTED upstream stops being pending and its comments become
    // visible to the ordinary comment sync — the two answers belong to the
    // same click. The automatic call skips it; loadLocalReview already syncs.
    const lm = createManager({ canSyncDrafts: true });
    const rerender = vi.spyOn(LocalManager.prototype, '_renderExternalComments')
      .mockResolvedValue(undefined);
    mockFetch.mockResolvedValue(jsonResponse({ pendingDraft: null, allGithubReviews: [] }));

    await lm._syncGitHubDrafts();
    expect(rerender).not.toHaveBeenCalled();

    await lm._syncGitHubDrafts({ manual: true });
    expect(rerender).toHaveBeenCalledWith({ sync: true });
  });

  it('re-enables the button after the request settles, success or failure', async () => {
    const lm = createManager({ canSyncDrafts: true });
    const btn = document.getElementById('local-sync-drafts-btn');
    mockFetch.mockRejectedValue(new Error('offline'));

    await lm._syncGitHubDrafts({ manual: true });

    expect(btn.disabled).toBe(false);
  });
});

describe('LocalManager._maybeAutoSyncGitHubDrafts', () => {
  it('runs at most once per page load', async () => {
    const lm = createManager({ canSyncDrafts: true });
    mockFetch.mockResolvedValue(jsonResponse({ pendingDraft: null, allGithubReviews: [] }));

    await lm._maybeAutoSyncGitHubDrafts();
    await lm._maybeAutoSyncGitHubDrafts();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('spends no budget while the capability is still false', async () => {
    // The tail call in loadLocalReview runs before a late association can
    // resolve; the late flip in _refreshPRMetadata is what actually syncs.
    const lm = createManager();

    await lm._maybeAutoSyncGitHubDrafts();
    expect(mockFetch).not.toHaveBeenCalled();

    lm.capabilities.canSyncDrafts = true;
    mockFetch.mockResolvedValue(jsonResponse({ pendingDraft: PENDING_DRAFT, allGithubReviews: [] }));
    await lm._maybeAutoSyncGitHubDrafts();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('PRManager.updatePendingDraftIndicator', () => {
  it('prefers the configured template URL (host-correct) over github_url', () => {
    externalUrlValue = 'https://ghe.example/owner/repo/pull/77';
    const manager = createPRManager();
    manager.updatePendingDraftIndicator(PENDING_DRAFT);
    expect(document.getElementById('pending-draft-indicator').getAttribute('href'))
      .toBe('https://ghe.example/owner/repo/pull/77');
  });

  it('falls back to the draft URL when the template does not resolve', () => {
    const manager = createPRManager();
    manager.updatePendingDraftIndicator(PENDING_DRAFT);
    expect(document.getElementById('pending-draft-indicator').getAttribute('href'))
      .toBe(PENDING_DRAFT.github_url);
  });

  it('removes the indicator for a null draft', () => {
    const manager = createPRManager();
    manager.updatePendingDraftIndicator(PENDING_DRAFT);
    manager.updatePendingDraftIndicator(null);
    expect(document.getElementById('pending-draft-indicator')).toBeNull();
  });
});

describe('LocalManager._applyRepoLinks', () => {
  it('resolves links against the ASSOCIATED PR, number included', () => {
    // Three things need `{number}`: the server's per-PR host resolution for a
    // dual-host repo, a `url_template` that names it, and `RepoLinks.draftUrl`
    // — the shared resolver the draft indicator reads.
    const lm = createManager({ canSyncDrafts: true });

    lm._applyRepoLinks({
      repository: 'owner/checkout-repo',
      branch: 'feature',
      baseBranch: 'main',
      localHeadSha: 'abc123',
      associatedPR: { prNumber: 77, repository: 'upstream/repo' }
    });

    expect(repoLinksCalls).toHaveLength(1);
    // The association wins over the checkout: a fork puts the PR elsewhere.
    expect(repoLinksCalls[0].owner).toBe('upstream');
    expect(repoLinksCalls[0].repo).toBe('repo');
    expect(repoLinksCalls[0].context).toMatchObject({
      owner: 'upstream', repo: 'repo', number: 77, branch: 'feature', head_sha: 'abc123'
    });
  });

  it('omits the number when there is no usable association', () => {
    const lm = createManager();

    lm._applyRepoLinks({ repository: 'owner/repo', branch: 'feature', associatedPR: null });

    expect(repoLinksCalls[0].context.number).toBeUndefined();
  });

  it('does not re-fetch when nothing about the association moved', () => {
    const lm = createManager();
    const payload = { repository: 'owner/repo', associatedPR: { prNumber: 77, repository: 'owner/repo' } };

    lm._applyRepoLinks(payload);
    lm._applyRepoLinks(payload);

    expect(repoLinksCalls).toHaveLength(1);
  });

  it('re-fetches when a late association arrives', async () => {
    const lm = createManager();

    lm._applyRepoLinks({ repository: 'owner/repo', associatedPR: null });
    await lm._applyRepoLinks({ repository: 'owner/repo', associatedPR: { prNumber: 77, repository: 'owner/repo' } });

    expect(repoLinksCalls).toHaveLength(2);
    expect(repoLinksCalls[1].context.number).toBe(77);
  });

  it('does nothing for a local session with no owner/repo identity', () => {
    const lm = createManager();
    expect(lm._applyRepoLinks({ repository: 'not-a-repo' })).toBeNull();
    expect(repoLinksCalls).toHaveLength(0);
  });
});

describe('a late canSyncDrafts flip is the dirty-tree path', () => {
  /**
   * On a dirty tree the PR association is written by a backfill that runs
   * AFTER the page-load GET responded, so `loadLocalReview`'s tail call
   * legitimately does nothing — `_refreshPRMetadata` is the ONLY thing that
   * ever syncs the draft for that session. Asserted through the real method
   * rather than by calling `_maybeAutoSyncGitHubDrafts` directly, because the
   * regression to catch is that call being deleted or folded into the wrong
   * guard.
   */
  const CAPS = (over = {}) => ({
    hasAssociatedPR: true,
    hasGitHubToken: true,
    canShowPRMetadata: true,
    canViewPRComments: false,
    canCheckStaleVsPR: false,
    canSyncDrafts: false,
    canSubmitToGitHub: false,
    ...over
  });

  function metadataManager(capabilities = {}) {
    const lm = createManager(capabilities);
    lm.localData = { id: 42, repository: 'owner/repo', associatedPR: null };
    lm._prMetadataGeneration = 0;
    vi.spyOn(LocalManager.prototype, '_renderExternalComments').mockResolvedValue(undefined);
    vi.spyOn(LocalManager.prototype, '_recheckPRHeadState').mockResolvedValue(undefined);
    return lm;
  }

  it('syncs when the response flips canSyncDrafts false -> true', async () => {
    const lm = metadataManager({ hasAssociatedPR: false, hasGitHubToken: true });
    const autoSync = vi.spyOn(LocalManager.prototype, '_maybeAutoSyncGitHubDrafts').mockResolvedValue(undefined);
    mockFetch.mockResolvedValue(jsonResponse({
      capabilities: CAPS({ canSyncDrafts: true }),
      associatedPR: { prNumber: 77, repository: 'owner/repo' }
    }));

    await lm._refreshPRMetadata();

    expect(autoSync).toHaveBeenCalledTimes(1);
    // The links context is re-resolved against the PR that just appeared.
    expect(repoLinksCalls.at(-1).context.number).toBe(77);
  });

  it('does not re-sync when the capability was already on', async () => {
    const lm = metadataManager({ hasAssociatedPR: true, hasGitHubToken: true, canSyncDrafts: true });
    const autoSync = vi.spyOn(LocalManager.prototype, '_maybeAutoSyncGitHubDrafts').mockResolvedValue(undefined);
    mockFetch.mockResolvedValue(jsonResponse({
      capabilities: CAPS({ canSyncDrafts: true }),
      associatedPR: { prNumber: 77, repository: 'owner/repo' }
    }));

    await lm._refreshPRMetadata();

    expect(autoSync).not.toHaveBeenCalled();
  });

  it('retracts the button AND the indicator when the capability flips true -> false', async () => {
    // The mirror case, and the reason the affordance call is unconditional
    // rather than folded under the gained-capability guard: an association
    // cleared by a force-push to unrelated history has to retract too.
    const lm = metadataManager({ hasAssociatedPR: true, hasGitHubToken: true, canSyncDrafts: true });
    mockFetch.mockResolvedValue(jsonResponse({ pendingDraft: PENDING_DRAFT, allGithubReviews: [] }));
    lm._updateDraftSyncAffordance();
    await lm._syncGitHubDrafts();
    expect(document.getElementById('pending-draft-indicator')).not.toBeNull();

    const autoSync = vi.spyOn(LocalManager.prototype, '_maybeAutoSyncGitHubDrafts').mockResolvedValue(undefined);
    mockFetch.mockResolvedValue(jsonResponse({
      capabilities: CAPS({ hasAssociatedPR: false, canShowPRMetadata: false, canSyncDrafts: false }),
      associatedPR: null
    }));

    await lm._refreshPRMetadata();

    expect(document.getElementById('local-sync-drafts-btn').style.display).toBe('none');
    expect(document.getElementById('pending-draft-indicator')).toBeNull();
    expect(window.prManager.currentPR.pendingDraft).toBeNull();
    expect(autoSync).not.toHaveBeenCalled();
  });
});
