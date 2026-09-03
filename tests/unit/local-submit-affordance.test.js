// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Phase 5 of plans/bridge-local-and-pr-modes.md — the FRONTEND half of
 * submitting a local review to its associated GitHub PR.
 *
 * Four seams, and each one is a place the shared components could have been
 * taught to mode-sniff instead:
 *   - the endpoint `ReviewModal` POSTs to comes from the active manager
 *     (`getSubmitReviewEndpoint`);
 *   - `SplitButton` and `PreviewModal` gate Submit on `canSubmitToGitHub`,
 *     not on `window.PAIR_REVIEW_LOCAL_MODE`;
 *   - `SplitButton` reads that flag ONCE (in its constructor), so a late
 *     association is applied by `PRManager.updateSubmitAffordance` — a mutator
 *     that preserves the visible action and defers while the menu is open,
 *     NOT a rebuild;
 *   - which review events may be submitted comes from the target PR's
 *     lifecycle (`getPRLifecycle`), which resolves to the ASSOCIATED PR in
 *     local mode and to the PR itself in PR mode, from one implementation.
 */

// `PRManager._fetchStaleness` reads this global for its abort budget. The
// production page defines it in a <script> tag; without it the fetch throws a
// ReferenceError that the method swallows, and any test driving the real
// `refreshPRLifecycle` would pass vacuously.
global.STALE_TIMEOUT = 2000;

const { LocalManager } = require('../../public/js/local.js');
const { PRManager } = require('../../public/js/pr.js');
require('../../public/js/components/SplitButton.js');
require('../../public/js/components/PreviewModal.js');

let mockFetch;

function buildDom() {
  document.body.innerHTML = `
    <div class="toolbar-meta" id="toolbar-meta">
      <span class="toolbar-commit" id="pr-commit"><span id="pr-commit-sha">HEAD</span></span>
      <button class="btn btn-sm btn-icon" id="local-sync-drafts-btn" style="display: none;"></button>
      <span id="stale-badge" style="display: none;"><span class="stale-badge-text"></span></span>
      <span id="pr-state-badge" style="display: none;"><span class="stale-badge-text"></span></span>
      <span id="pr-drift-badge" style="display: none;"><span class="stale-badge-text"></span></span>
    </div>
    <div id="split-button-placeholder"></div>
  `;
}

/** The lifecycle slot as the user sees it: its label, or null when hidden. */
function lifecycleLabel() {
  const badge = document.getElementById('pr-state-badge');
  return badge.style.display === 'none'
    ? null
    : badge.querySelector('.stale-badge-text').textContent;
}

const ALL_FALSE = {
  hasAssociatedPR: false,
  hasGitHubToken: false,
  canShowPRMetadata: false,
  canViewPRComments: false,
  canCheckStaleVsPR: false,
  canSyncDrafts: false,
  canSubmitToGitHub: false
};

function createManager(capabilities = {}) {
  const lm = Object.create(LocalManager.prototype);
  lm.reviewId = 42;
  lm.localData = null;
  lm._draftSyncPromise = null;
  lm._draftSyncAutoDone = false;
  lm.capabilities = { ...ALL_FALSE, ...capabilities };
  return lm;
}

function createPRManager(capabilities = {}) {
  const manager = Object.create(PRManager.prototype);
  manager.currentPR = { id: 42, owner: 'octo', repo: 'widget', number: 7, reviewType: 'local' };
  manager.capabilities = { ...ALL_FALSE, ...capabilities };
  return manager;
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  buildDom();
  localStorage.clear();
  mockFetch = vi.fn();
  global.fetch = mockFetch;
  window.fetch = mockFetch;
  window.prManager = createPRManager();
  window.toast = { showSuccess: vi.fn(), showInfo: vi.fn(), showError: vi.fn(), showWarning: vi.fn() };
  window.RepoLinks = {
    hostName: () => 'GitHub',
    externalUrl: () => null,
    draftUrl: (draft) => (draft && draft.github_url) || null,
    fetchAndApplyRepoLinks: vi.fn(async () => {})
  };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.prManager;
  delete window.toast;
  delete window.RepoLinks;
  delete window.PAIR_REVIEW_LOCAL_MODE;
});

describe('getSubmitReviewEndpoint', () => {
  it('addresses the PR by owner/repo/number in PR mode', () => {
    const manager = createPRManager();
    expect(manager.getSubmitReviewEndpoint()).toBe('/api/pr/octo/widget/7/submit-review');
  });

  it('answers null before a PR is loaded', () => {
    const manager = createPRManager();
    manager.currentPR = null;
    expect(manager.getSubmitReviewEndpoint()).toBeNull();
  });

  it('is patched to the local session endpoint in local mode', () => {
    // The local review is addressed by its own id; the backend resolves the
    // association from the row. `currentPR.owner` is the literal string
    // 'local' in this mode, so the PR-shaped URL would 404.
    const lm = createManager();
    const manager = createPRManager();
    window.prManager = manager;
    lm.patchPRManager();

    expect(manager.getSubmitReviewEndpoint()).toBe('/api/local/42/submit-review');
  });
});

describe('SplitButton submit visibility', () => {
  it('hides Submit when the manager says the review cannot be submitted', () => {
    window.prManager = createPRManager({ canSubmitToGitHub: false });
    const button = new window.SplitButton({});
    expect(button.hideSubmit).toBe(true);
    expect(button.defaultAction).toBe('preview');
  });

  it('shows Submit for a local review whose PR association can take it', () => {
    window.prManager = createPRManager({
      hasAssociatedPR: true,
      hasGitHubToken: true,
      canSubmitToGitHub: true
    });
    const button = new window.SplitButton({});
    expect(button.hideSubmit).toBe(false);
  });

  it('ignores the legacy local-mode flag when the manager can answer', () => {
    // The flag is still set on every local page; the capability is what
    // decides now, or a local review with an associated PR would lose Submit.
    window.PAIR_REVIEW_LOCAL_MODE = true;
    window.prManager = createPRManager({ canSubmitToGitHub: true });
    const button = new window.SplitButton({});
    expect(button.hideSubmit).toBe(false);
  });
});

describe('PreviewModal submit visibility', () => {
  function showPreview() {
    const modal = new window.PreviewModal();
    modal.loadComments = vi.fn(async () => {});
    return modal;
  }

  it('shows Submit when the manager advertises the capability', async () => {
    window.prManager = createPRManager({ canSubmitToGitHub: true });
    const modal = showPreview();
    await modal.show();
    expect(modal.modal.querySelector('#submit-review-btn').style.display).toBe('');
  });

  it('hides Submit when it does not', async () => {
    window.prManager = createPRManager({ canSubmitToGitHub: false });
    const modal = showPreview();
    await modal.show();
    expect(modal.modal.querySelector('#submit-review-btn').style.display).toBe('none');
  });

  it('re-reads the capability on every show, never latching the first answer', async () => {
    window.prManager = createPRManager({ canSubmitToGitHub: false });
    const modal = showPreview();
    await modal.show();
    window.prManager.capabilities.canSubmitToGitHub = true;
    await modal.show();
    expect(modal.modal.querySelector('#submit-review-btn').style.display).toBe('');
  });

  it('still honours an explicit hideSubmit option', async () => {
    window.prManager = createPRManager({ canSubmitToGitHub: true });
    const modal = showPreview();
    await modal.show({ hideSubmit: true });
    expect(modal.modal.querySelector('#submit-review-btn').style.display).toBe('none');
  });
});

const CAPS = (over = {}) => ({ ...ALL_FALSE, hasAssociatedPR: true, hasGitHubToken: true, ...over });

/**
 * A LocalManager wired for `_refreshPRMetadata`, with every fire-and-forget
 * tail stubbed so only the apply block under test runs.
 */
function metadataManager(capabilities = {}) {
  const lm = createManager(capabilities);
  lm.localData = { id: 42, repository: 'owner/repo', associatedPR: null };
  lm._prMetadataGeneration = 0;
  vi.spyOn(LocalManager.prototype, '_renderExternalComments').mockResolvedValue(undefined);
  vi.spyOn(LocalManager.prototype, '_recheckPRHeadState').mockResolvedValue(undefined);
  vi.spyOn(LocalManager.prototype, '_maybeAutoSyncGitHubDrafts').mockResolvedValue(undefined);
  return lm;
}

/** Text of every action in the rendered dropdown, in order. */
function menuActions(splitButton) {
  return Array.from(splitButton.dropdown.querySelectorAll('.split-button-menu-item'))
    .map((item) => item.dataset.action);
}

describe('LocalManager._refreshPRMetadata — the Submit affordance on a late flip', () => {
  /**
   * Mounts the PRODUCTION SplitButton through the production
   * `initSplitButton`. A stub would prove nothing here: the whole point of
   * `updateSubmitAffordance` is what the real component does with its
   * `defaultAction`, its rendered menu and its open dropdown.
   */
  function mountSplitButton() {
    window.prManager.initSplitButton();
    return window.prManager.splitButton;
  }

  it('reveals Submit on a false -> true flip WITHOUT promoting it to the main action', async () => {
    // The bug this replaces: the rebuild re-ran `loadSavedAction()`, so a
    // saved (or defaulted) `submit` preference changed the primary action from
    // Preview to Submit as association metadata arrived — under the cursor.
    localStorage.setItem(window.SplitButton.STORAGE_KEY, 'submit');
    const lm = metadataManager({ hasAssociatedPR: false });
    const splitButton = mountSplitButton();
    expect(splitButton.hideSubmit).toBe(true);
    expect(menuActions(splitButton)).toEqual(['preview', 'clear']);

    mockFetch.mockResolvedValue(jsonResponse({
      capabilities: CAPS({ canSubmitToGitHub: true }),
      associatedPR: { prNumber: 77, repository: 'owner/repo' }
    }));
    await lm._refreshPRMetadata();

    // Same instance — mutated, not rebuilt.
    expect(window.prManager.splitButton).toBe(splitButton);
    expect(splitButton.hideSubmit).toBe(false);
    expect(menuActions(splitButton)).toEqual(['submit', 'preview', 'clear']);
    expect(splitButton.defaultAction).toBe('preview');
    expect(splitButton.container.querySelector('#split-button-text').textContent).toBe('Preview');
  });

  it('retracts Submit and demotes the main action when the capability is LOST', async () => {
    // A force-push to unrelated history clears the association. A Submit
    // control left behind would POST to a PR this session is no longer tied to.
    const lm = metadataManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    window.prManager.capabilities.canSubmitToGitHub = true;
    const splitButton = mountSplitButton();
    splitButton.setDefaultAction('submit');
    expect(menuActions(splitButton)).toEqual(['submit', 'preview', 'clear']);

    mockFetch.mockResolvedValue(jsonResponse({
      capabilities: { ...ALL_FALSE },
      associatedPR: null
    }));
    await lm._refreshPRMetadata();

    expect(splitButton.hideSubmit).toBe(true);
    expect(menuActions(splitButton)).toEqual(['preview', 'clear']);
    expect(splitButton.defaultAction).toBe('preview');
    expect(splitButton.container.querySelector('#split-button-text').textContent).toBe('Preview');
    // The demotion is NOT persisted: a genuine `submit` preference belongs to
    // every other review this browser opens.
    expect(localStorage.getItem(window.SplitButton.STORAGE_KEY)).toBe('submit');
  });

  it('leaves the rendered menu untouched when the answer did not change', async () => {
    const lm = metadataManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    window.prManager.capabilities.canSubmitToGitHub = true;
    const splitButton = mountSplitButton();
    const before = splitButton.dropdown.innerHTML;

    mockFetch.mockResolvedValue(jsonResponse({
      capabilities: CAPS({ canSubmitToGitHub: true, canShowPRMetadata: true }),
      associatedPR: { prNumber: 77, repository: 'owner/repo' }
    }));
    await lm._refreshPRMetadata();

    expect(window.prManager.splitButton).toBe(splitButton);
    expect(splitButton.dropdown.innerHTML).toBe(before);
  });

  it('defers the change while the dropdown is open, then applies it on close', async () => {
    // Replacing menu items under an open menu moves every row under the
    // pointer — the click that lands is not the one the user aimed at.
    const lm = metadataManager({ hasAssociatedPR: false });
    const splitButton = mountSplitButton();
    splitButton.openDropdown();

    mockFetch.mockResolvedValue(jsonResponse({
      capabilities: CAPS({ canSubmitToGitHub: true }),
      associatedPR: { prNumber: 77, repository: 'owner/repo' }
    }));
    await lm._refreshPRMetadata();

    expect(splitButton.isOpen).toBe(true);
    expect(menuActions(splitButton)).toEqual(['preview', 'clear']);
    expect(splitButton.hideSubmit).toBe(true);

    splitButton.closeDropdown();

    expect(menuActions(splitButton)).toEqual(['submit', 'preview', 'clear']);
    expect(splitButton.hideSubmit).toBe(false);
  });

  it('never un-hides a Submit the caller explicitly vetoed', async () => {
    // `options.hideSubmit` is the caller's veto, not a capability answer, and a
    // late flip must not overrule it.
    const lm = metadataManager({ hasAssociatedPR: false });
    window.prManager.splitButton = new window.SplitButton({ hideSubmit: true });
    document.getElementById('split-button-placeholder')
      .appendChild(window.prManager.splitButton.render());

    mockFetch.mockResolvedValue(jsonResponse({
      capabilities: CAPS({ canSubmitToGitHub: true }),
      associatedPR: { prNumber: 77, repository: 'owner/repo' }
    }));
    await lm._refreshPRMetadata();

    expect(window.prManager.splitButton.hideSubmit).toBe(true);
    expect(menuActions(window.prManager.splitButton)).toEqual(['preview', 'clear']);
  });

  it('refreshes an OPEN preview modal instead of leaving it on the answer it opened with', async () => {
    const lm = metadataManager({ hasAssociatedPR: false });
    mountSplitButton();
    const previewModal = new window.PreviewModal();
    previewModal.loadComments = vi.fn(async () => {});
    await previewModal.show();
    expect(previewModal.modal.querySelector('#submit-review-btn').style.display).toBe('none');

    mockFetch.mockResolvedValue(jsonResponse({
      capabilities: CAPS({ canSubmitToGitHub: true }),
      associatedPR: { prNumber: 77, repository: 'owner/repo' }
    }));
    await lm._refreshPRMetadata();

    expect(previewModal.modal.querySelector('#submit-review-btn').style.display).toBe('');
  });

  it('flattens associatedPR.url onto currentPR.html_url', async () => {
    // Tier 2 of `ReviewModal.resolveDraftPrUrl` reads `pr.html_url`. Without
    // this the key stays null after a late association and an alt-host draft
    // submit falls through to the wrong-host `/issues/<n>` URL.
    const lm = metadataManager({ hasAssociatedPR: false });
    mockFetch.mockResolvedValue(jsonResponse({
      capabilities: CAPS({ canSubmitToGitHub: true }),
      associatedPR: {
        prNumber: 77,
        repository: 'owner/repo',
        url: 'https://ghe.example.com/owner/repo/pull/77'
      }
    }));

    await lm._refreshPRMetadata();

    expect(window.prManager.currentPR.html_url).toBe('https://ghe.example.com/owner/repo/pull/77');
  });
});

describe('ReviewModal POSTs to the endpoint the manager names', () => {
  /**
   * Required lazily: the module instantiates a ReviewModal on load, and that
   * constructor fetches `/api/config`. Requiring it at import time would run
   * before `global.fetch` exists.
   */
  function loadReviewModal() {
    mockFetch.mockResolvedValue(jsonResponse({}));
    return require('../../public/js/components/ReviewModal.js').ReviewModal;
  }

  async function submitWith(manager, { event = 'COMMENT' } = {}) {
    const ReviewModal = loadReviewModal();
    window.prManager = manager;
    const modal = new ReviewModal();
    modal.modal.querySelector('#review-body-modal').value = 'looks good';
    const radio = modal.modal.querySelector(`input[value="${event}"]`);
    if (radio) radio.checked = true;
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      github_url: 'https://github.com/owner/repo/pull/77#pullrequestreview-1',
      comments_submitted: 0,
      event
    }));

    await modal.submitReview();
    return modal;
  }

  it('uses the local session endpoint in local mode', async () => {
    const lm = createManager({ hasAssociatedPR: true, hasGitHubToken: true, canSubmitToGitHub: true });
    const manager = createPRManager({ hasAssociatedPR: true, hasGitHubToken: true, canSubmitToGitHub: true });
    window.prManager = manager;
    lm.patchPRManager();

    await submitWith(manager);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('/api/local/42/submit-review');
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({ event: 'COMMENT' });
  });

  it('uses the PR endpoint when the manager is unpatched', async () => {
    await submitWith(createPRManager({ canSubmitToGitHub: true }));
    expect(mockFetch.mock.calls[0][0]).toBe('/api/pr/octo/widget/7/submit-review');
  });

  it('surfaces a refusal from the endpoint in the modal instead of throwing', async () => {
    // The drift refusal (409) is the one a user will actually hit; its message
    // tells them to push or pull, so it has to reach the modal verbatim.
    const ReviewModal = loadReviewModal();
    window.prManager = createPRManager({ canSubmitToGitHub: true });
    const modal = new ReviewModal();
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(jsonResponse(
      { error: 'Your local HEAD (aaaaaaa) is not the head commit', code: 'head_drift' },
      { ok: false, status: 409 }
    ));

    await modal.submitReview();

    const error = modal.modal.querySelector('#review-error-message');
    expect(error.textContent).toContain('is not the head commit');
    expect(error.style.display).toBe('block');
    expect(modal.isSubmitting).toBe(false);
  });
});

/**
 * Lazily required for the same reason as above: the module instantiates a
 * ReviewModal on load and that constructor fetches `/api/config`.
 */
function requireReviewModal() {
  mockFetch.mockResolvedValue(jsonResponse({}));
  return require('../../public/js/components/ReviewModal.js').ReviewModal;
}

describe('ReviewModal error handling on a non-JSON refusal body', () => {
  it('shows a status-derived message instead of a SyntaxError', async () => {
    // The submit endpoint does real network work against a code host, so an
    // Express HTML 500 page or a proxy 502 is plausible. A bare
    // `response.json()` rejected with a SyntaxError that was rendered verbatim:
    // the user saw `Unexpected token '<'` instead of anything actionable.
    const ReviewModal = requireReviewModal();
    window.prManager = createPRManager({ canSubmitToGitHub: true });
    const modal = new ReviewModal();
    mockFetch.mockClear();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError("Unexpected token '<'"); }
    });

    await modal.submitReview();

    const error = modal.modal.querySelector('#review-error-message');
    expect(error.textContent).toBe('Failed to submit review (502)');
    expect(error.textContent).not.toContain('Unexpected token');
    expect(error.style.display).toBe('block');
    expect(modal.isSubmitting).toBe(false);
  });

  it('keeps the draft wording on a non-JSON body when submitting a draft', async () => {
    const ReviewModal = requireReviewModal();
    window.prManager = createPRManager({ canSubmitToGitHub: true });
    const modal = new ReviewModal();
    modal.modal.querySelector('input[value="DRAFT"]').checked = true;
    modal.modal.querySelector('input[value="COMMENT"]').checked = false;
    mockFetch.mockClear();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new SyntaxError('<html>'); }
    });

    await modal.submitReview();

    expect(modal.modal.querySelector('#review-error-message').textContent)
      .toBe('Failed to submit draft review (500)');
  });
});

describe('ReviewModal allowed events derive from PR lifecycle', () => {
  const OPEN = { state: 'open', merged: false };
  const MERGED = { state: 'closed', merged: true };
  const CLOSED = { state: 'closed', merged: false };

  /** The disabled state of every review-type radio, keyed by event. */
  function radioState(modal) {
    const out = {};
    modal.modal.querySelectorAll('input[name="review-event"]').forEach((input) => {
      out[input.value] = { disabled: input.disabled, checked: input.checked };
    });
    return out;
  }

  describe('allowedEvents (pure)', () => {
    it('offers every event on an open pull request', () => {
      const ReviewModal = requireReviewModal();
      expect(ReviewModal.allowedEvents(OPEN))
        .toEqual(['COMMENT', 'APPROVE', 'REQUEST_CHANGES', 'DRAFT']);
    });

    it('offers only COMMENT once the pull request is merged', () => {
      const ReviewModal = requireReviewModal();
      expect(ReviewModal.allowedEvents(MERGED)).toEqual(['COMMENT']);
    });

    it('offers only COMMENT once the pull request is closed', () => {
      const ReviewModal = requireReviewModal();
      expect(ReviewModal.allowedEvents(CLOSED)).toEqual(['COMMENT']);
    });

    it('reads an unknown lifecycle as OPEN rather than guessing it settled', () => {
      // Missing metadata must not strip Approve from a healthy PR. The backend
      // refuses if we are wrong; guessing the other way is unrecoverable in UI.
      const ReviewModal = requireReviewModal();
      expect(ReviewModal.allowedEvents(null)).toHaveLength(4);
      expect(ReviewModal.allowedEvents({ state: null, merged: false })).toHaveLength(4);
    });

    it('labels a merged PR merged, not closed', () => {
      // GitHub reports a merge as state 'closed' PLUS merged true, so the
      // merged check has to come first or every merged PR reads as closed.
      const ReviewModal = requireReviewModal();
      expect(ReviewModal.lifecycleRestriction(MERGED).kind).toBe('merged');
      expect(ReviewModal.lifecycleRestriction(CLOSED).kind).toBe('closed');
      expect(ReviewModal.lifecycleRestriction(OPEN)).toBeNull();
    });
  });

  it('disables Approve / Request changes / Draft when a LOCAL review targets a merged PR', () => {
    const ReviewModal = requireReviewModal();
    const manager = createPRManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    manager.currentPR.associatedPR = { prNumber: 77, state: 'closed', merged: true };
    window.prManager = manager;

    const modal = new ReviewModal();
    modal.show();

    const state = radioState(modal);
    expect(state.COMMENT).toEqual({ disabled: false, checked: true });
    expect(state.APPROVE.disabled).toBe(true);
    expect(state.REQUEST_CHANGES.disabled).toBe(true);
    expect(state.DRAFT.disabled).toBe(true);

    // Disabled WITH an explanation, never silently missing.
    const warning = modal.modal.querySelector('#review-lifecycle-warning');
    expect(warning.style.display).toBe('block');
    expect(warning.querySelector('#review-lifecycle-warning-title').textContent)
      .toBe('Pull request merged');
    expect(modal.modal.querySelector('input[value="APPROVE"]').closest('.review-type-option').title)
      .toContain('has been merged');
  });

  it('applies the same restriction in PR mode, where the lifecycle is on currentPR', () => {
    // Parity: PR mode's modal had the identical problem, and there is one
    // implementation for both — `PRManager.getPRLifecycle`.
    const ReviewModal = requireReviewModal();
    const manager = createPRManager({ canSubmitToGitHub: true });
    manager.currentPR.state = 'closed';
    manager.currentPR.merged = false;
    window.prManager = manager;

    const modal = new ReviewModal();
    modal.show();

    // The WHOLE offer, not just Approve: a closed pull request takes a Comment
    // review and nothing else. Save as Draft goes too — GitHub will not hold a
    // pending review on a settled PR.
    const state = radioState(modal);
    expect(state.COMMENT).toEqual({ disabled: false, checked: true });
    expect(state.APPROVE.disabled).toBe(true);
    expect(state.REQUEST_CHANGES.disabled).toBe(true);
    expect(state.DRAFT.disabled).toBe(true);
    expect(modal.modal.querySelector('#review-lifecycle-warning-title').textContent)
      .toBe('Pull request closed');
    expect(modal.modal.querySelector('input[value="DRAFT"]').closest('.review-type-option').title)
      .toContain('is closed');
  });

  it('offers Comment only when a PR-mode review targets a MERGED pull request', () => {
    // GitHub reports a merge as `state: 'closed'` PLUS `merged: true`, and the
    // wording differs — a merged PR must not be described as closed. PR mode
    // gets the merged branch of the same rule local mode gets.
    const ReviewModal = requireReviewModal();
    const manager = createPRManager({ canSubmitToGitHub: true });
    manager.currentPR.state = 'closed';
    manager.currentPR.merged = true;
    window.prManager = manager;

    const modal = new ReviewModal();
    modal.show();

    const state = radioState(modal);
    expect(state.COMMENT).toEqual({ disabled: false, checked: true });
    expect(state.APPROVE.disabled).toBe(true);
    expect(state.REQUEST_CHANGES.disabled).toBe(true);
    expect(state.DRAFT.disabled).toBe(true);

    const warning = modal.modal.querySelector('#review-lifecycle-warning');
    expect(warning.style.display).toBe('block');
    expect(warning.querySelector('#review-lifecycle-warning-title').textContent)
      .toBe('Pull request merged');
    expect(modal.modal.querySelector('input[value="APPROVE"]').closest('.review-type-option').title)
      .toContain('has been merged');
  });

  it('leaves every option available on an open pull request', () => {
    const ReviewModal = requireReviewModal();
    const manager = createPRManager({ canSubmitToGitHub: true });
    manager.currentPR.state = 'open';
    manager.currentPR.merged = false;
    window.prManager = manager;

    const modal = new ReviewModal();
    modal.show();

    const state = radioState(modal);
    expect(Object.values(state).every((s) => s.disabled === false)).toBe(true);
    expect(modal.modal.querySelector('#review-lifecycle-warning').style.display).toBe('none');
  });

  it('updates an ALREADY-OPEN modal when the submit is refused as a lifecycle race', async () => {
    // The PR merged between the metadata these options were built from and the
    // submit. Leaving the stale options behind invites the identical failure.
    const ReviewModal = requireReviewModal();
    const manager = createPRManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    manager.currentPR.associatedPR = { prNumber: 77, state: 'open', merged: false };
    window.prManager = manager;

    const modal = new ReviewModal();
    modal.show();
    modal.modal.querySelector('input[value="APPROVE"]').checked = true;
    modal.modal.querySelector('input[value="COMMENT"]').checked = false;
    expect(radioState(modal).APPROVE.disabled).toBe(false);

    // The manager's own refresh answers with the now-merged PR.
    const refresh = vi.fn(async () => {
      manager.currentPR.associatedPR.merged = true;
      manager.updateSubmitAffordance();
    });
    manager.refreshPRLifecycle = refresh;

    mockFetch.mockClear();
    mockFetch.mockResolvedValue(jsonResponse(
      { error: 'Pull request #77 has been merged, so it can no longer be approved.', code: 'pr_merged' },
      { ok: false, status: 410 }
    ));

    await modal.submitReview();
    // The corrective refresh is fire-and-forget from the catch block.
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    expect(modal.isVisible).toBe(true);
    expect(modal.modal.querySelector('#review-error-message').textContent)
      .toContain('has been merged');
    const state = radioState(modal);
    expect(state.APPROVE.disabled).toBe(true);
    expect(state.DRAFT.disabled).toBe(true);
    // The selection moved off the now-forbidden event rather than staying on a
    // disabled radio, which still submits its value.
    expect(state.COMMENT).toEqual({ disabled: false, checked: true });
    expect(modal.modal.querySelector('#review-lifecycle-warning').style.display).toBe('block');
  });

  it('still narrows the options when the corrective refresh itself fails', async () => {
    // The refusal is proof enough. Re-reading a lifecycle we already know to be
    // stale — or failing to read it at all — must not restore the bad options.
    const ReviewModal = requireReviewModal();
    const manager = createPRManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    manager.currentPR.associatedPR = { prNumber: 77, state: 'open', merged: false };
    manager.refreshPRLifecycle = vi.fn(async () => { throw new Error('offline'); });
    window.prManager = manager;

    const modal = new ReviewModal();
    modal.show();
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(jsonResponse(
      { error: 'Pull request #77 is closed.', code: 'pr_closed' },
      { ok: false, status: 410 }
    ));

    await modal.submitReview();
    await vi.waitFor(() => expect(radioState(modal).APPROVE.disabled).toBe(true));

    expect(radioState(modal).COMMENT.disabled).toBe(false);
  });

  it('drops the pinned refusal on the next open, so a reopened PR recovers', () => {
    const ReviewModal = requireReviewModal();
    const manager = createPRManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    manager.currentPR.associatedPR = { prNumber: 77, state: 'open', merged: false };
    window.prManager = manager;

    const modal = new ReviewModal();
    modal._lifecycleRefusal = { state: 'closed', merged: false };
    modal.applyAllowedEvents();
    expect(radioState(modal).APPROVE.disabled).toBe(true);

    modal.show();

    expect(modal._lifecycleRefusal).toBeNull();
    expect(radioState(modal).APPROVE.disabled).toBe(false);
  });

  /**
   * PR MODE, END TO END, THROUGH THE REAL `PRManager.refreshPRLifecycle`.
   *
   * The local-mode race above stubs the manager's refresh. Here nothing is
   * stubbed but the network: the 410 comes back from the submit POST, the
   * modal's own catch reconciles, and the manager's production refresh re-reads
   * `check-stale` and repaints. PR mode is the mode the release notes call
   * "unchanged", so its version of this path is the one most likely to be
   * "fixed" back by someone who did not know it was deliberate.
   */
  it('reconciles a PR that settles while the modal is open, and still sends the comments as a Comment review', async () => {
    const ReviewModal = requireReviewModal();
    const manager = createPRManager({ canSubmitToGitHub: true });
    manager.currentPR.state = 'open';
    manager.currentPR.merged = false;
    window.prManager = manager;

    const modal = new ReviewModal();
    modal.show();
    modal.modal.querySelector('input[value="COMMENT"]').checked = false;
    modal.modal.querySelector('input[value="APPROVE"]').checked = true;
    expect(radioState(modal).APPROVE.disabled).toBe(false);

    const posted = [];
    mockFetch.mockClear();
    mockFetch.mockImplementation(async (url, options) => {
      const target = String(url);
      if (target.includes('/check-stale')) {
        // The authoritative answer: it merged under us.
        return jsonResponse({ isStale: true, prState: 'closed', merged: true, reasons: [] });
      }
      if (target.includes('/submit-review')) {
        posted.push(JSON.parse(options.body));
        if (posted.length === 1) {
          return jsonResponse(
            {
              error: 'Pull request #7 has been merged, so it can no longer be approved.',
              code: 'pr_merged'
            },
            { ok: false, status: 410 }
          );
        }
        return jsonResponse({
          success: true,
          github_url: 'https://github.com/octo/widget/pull/7#pullrequestreview-1',
          comments_submitted: 1
        });
      }
      return jsonResponse({});
    });

    await modal.submitReview();

    expect(posted[0].event).toBe('APPROVE');
    expect(modal.isVisible).toBe(true);
    // Reconciled in place: the options narrowed, the badge went up, and the
    // manager's copy of the lifecycle was corrected — all from the refusal plus
    // the production refresh, with no page reload.
    await vi.waitFor(() => expect(lifecycleLabel()).toBe('MERGED'));
    expect(manager.currentPR).toMatchObject({ state: 'closed', merged: true });
    const settled = radioState(modal);
    expect(settled.APPROVE.disabled).toBe(true);
    expect(settled.REQUEST_CHANGES.disabled).toBe(true);
    expect(settled.DRAFT.disabled).toBe(true);
    // The selection moved off the forbidden event by itself — a checked-but-
    // disabled radio still submits its value.
    expect(settled.COMMENT).toEqual({ disabled: false, checked: true });

    // The user presses Submit again WITHOUT reopening the modal: same comments,
    // same body, now a Comment review. Nothing was lost to the refusal.
    await modal.submitReview();

    expect(posted).toHaveLength(2);
    expect(posted[1].event).toBe('COMMENT');
    expect(modal.isVisible).toBe(false);
    expect(window.toast.showSuccess).toHaveBeenCalled();
  });

  it('does not widen a merged PR-mode review back to Approve when the re-read fails open', async () => {
    // `check-stale` fails open with `{isStale: null, error}` and no lifecycle
    // fields at all. That answer is evidence about nothing: it must not retract
    // the MERGED badge, must not un-merge `currentPR`, and must not hand
    // Approve back to a review GitHub would refuse.
    const ReviewModal = requireReviewModal();
    const manager = createPRManager({ canSubmitToGitHub: true });
    window.prManager = manager;
    manager._applyPRLifecycleBadge({ state: 'closed', merged: true });

    const modal = new ReviewModal();
    modal.show();
    expect(lifecycleLabel()).toBe('MERGED');
    expect(radioState(modal).APPROVE.disabled).toBe(true);

    mockFetch.mockClear();
    mockFetch.mockResolvedValue(jsonResponse({
      isStale: null, error: 'GitHub API request failed', reasons: []
    }));

    await manager.refreshPRLifecycle();

    expect(mockFetch).toHaveBeenCalled();
    expect(lifecycleLabel()).toBe('MERGED');
    expect(manager.getPRLifecycle()).toEqual({ state: 'closed', merged: true });
    expect(radioState(modal).APPROVE.disabled).toBe(true);
    expect(radioState(modal).COMMENT.disabled).toBe(false);
  });
});

describe('resolveDraftPrUrl reaches the host-correct PR page from local mode', () => {
  it('opens the association URL, not the wrong-host issue URL the server returned', async () => {
    // A GHE repo configured with only `api_host` + a token has no
    // `links.external.url_template`, so tier 1 is null. Tier 2 used to be
    // structurally unreachable in local mode — nothing wrote `html_url` — and
    // the draft submit fell through to `result.github_url`, which alt hosts
    // return as a github.com `/issues/<n>` URL.
    const ReviewModal = requireReviewModal();
    const lm = createManager({ hasAssociatedPR: true, hasGitHubToken: true, canSubmitToGitHub: true });
    const manager = createPRManager({ hasAssociatedPR: true, hasGitHubToken: true, canSubmitToGitHub: true });
    manager.currentPR.associatedPR = {
      prNumber: 77,
      repository: 'owner/repo',
      url: 'https://ghe.example.com/owner/repo/pull/77',
      state: 'open',
      merged: false
    };
    manager.currentPR.html_url = manager.currentPR.associatedPR.url;
    manager.updatePendingDraftIndicator = vi.fn();
    window.prManager = manager;
    lm.patchPRManager();

    const opened = vi.fn();
    window.open = opened;

    const modal = new ReviewModal();
    modal.show();
    modal.modal.querySelector('input[value="COMMENT"]').checked = false;
    modal.modal.querySelector('input[value="DRAFT"]').checked = true;
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      github_url: 'https://github.com/owner/repo/issues/77',
      comments_submitted: 0,
      event: 'DRAFT'
    }));

    try {
      vi.useFakeTimers();
      await modal.submitReview();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    expect(opened).toHaveBeenCalledWith('https://ghe.example.com/owner/repo/pull/77', '_blank');
  });

  it('falls back to associatedPR.url when only the association is present', () => {
    // Belt-and-braces arm: any producer of a currentPR that carries the
    // association but not the flattened key still resolves host-correctly.
    const ReviewModal = requireReviewModal();
    const url = ReviewModal.resolveDraftPrUrl(
      { associatedPR: { url: 'https://ghe.example.com/owner/repo/pull/77' } },
      { github_url: 'https://github.com/owner/repo/issues/77' }
    );
    expect(url).toBe('https://ghe.example.com/owner/repo/pull/77');
  });
});

describe('local-mode lifecycle write-back keeps the badge and the modal on one fact', () => {
  it('writes the staleness check answer into associatedPR and re-applies open modals', () => {
    // `check-stale` is the freshest lifecycle answer local mode gets — fresher
    // than the `pr_metadata` row `associatedPR` was built from. It used to
    // raise the MERGED badge and tell nobody else, so the review modal kept
    // offering Approve on a merged PR.
    const ReviewModal = requireReviewModal();
    const lm = createManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    const manager = createPRManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    manager.currentPR.associatedPR = { prNumber: 77, state: 'open', merged: false };
    window.prManager = manager;
    lm.localData = { id: 42, shaAbbrevLength: 7 };
    lm._prHeadCheckGeneration = 0;

    const modal = new ReviewModal();
    modal.show();
    expect(modal.modal.querySelector('input[value="APPROVE"]').disabled).toBe(false);

    lm._applyPRHeadStaleState(
      { prHead: { prNumber: 77, merged: true, prState: 'closed', drifted: false }, reasons: [] },
      7,
      {}
    );

    expect(manager.currentPR.associatedPR).toMatchObject({ state: 'closed', merged: true });
    expect(modal.modal.querySelector('input[value="APPROVE"]').disabled).toBe(true);
    expect(modal.modal.querySelector('input[value="COMMENT"]').disabled).toBe(false);
  });

  it('never lets an unreported state clobber a known one', () => {
    const lm = createManager({ hasAssociatedPR: true });
    const manager = createPRManager({ hasAssociatedPR: true });
    manager.currentPR.associatedPR = { prNumber: 77, state: 'closed', merged: false };
    window.prManager = manager;
    lm.localData = { id: 42, shaAbbrevLength: 7 };
    lm._prHeadCheckGeneration = 0;

    lm._applyPRHeadStaleState(
      { prHead: { prNumber: 77, merged: false, prState: null, drifted: false }, reasons: [] },
      7,
      {}
    );

    expect(manager.currentPR.associatedPR.state).toBe('closed');
  });
});

describe('SplitButton — a click that lands while a capability flip is parked', () => {
  /**
   * The PRODUCTION component through the production `initSplitButton`, for the
   * same reason the block above uses it: the bug lives in the ordering of the
   * real dispatcher, its real deferral and its real localStorage write.
   */
  function mount() {
    window.prManager.initSplitButton();
    window.prManager.openReviewModal = vi.fn();
    window.prManager.openPreviewModal = vi.fn();
    return window.prManager.splitButton;
  }

  /** A real bubbling click on one rendered menu row. */
  function clickMenuItem(splitButton, action) {
    splitButton.dropdown.querySelector(`[data-action="${action}"]`).click();
  }

  it('swallows a Submit Review click when the association was cleared mid-menu', async () => {
    // The exact scenario: local review, dropdown open, `_refreshPRMetadata`
    // lands an association-cleared payload (force-push to unrelated history),
    // user clicks Submit Review. The action ran BEFORE the deferred answer was
    // flushed, so it persisted a `submit` preference the capability had just
    // revoked and opened ReviewModal for a session the backend refuses.
    localStorage.setItem(window.SplitButton.STORAGE_KEY, 'preview');
    const lm = metadataManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    window.prManager.capabilities.canSubmitToGitHub = true;
    const splitButton = mount();
    expect(splitButton.hideSubmit).toBe(false);

    splitButton.openDropdown();
    mockFetch.mockResolvedValue(jsonResponse({
      capabilities: { ...ALL_FALSE },
      associatedPR: null
    }));
    await lm._refreshPRMetadata();
    // Parked, not applied: the rows must not move under the pointer.
    expect(splitButton._pendingHideSubmit).toBe(true);
    expect(menuActions(splitButton)).toEqual(['submit', 'preview', 'clear']);

    clickMenuItem(splitButton, 'submit');

    // 1. The modal never opens for a session that can no longer submit.
    expect(window.prManager.openReviewModal).not.toHaveBeenCalled();
    // 2. The preference of every OTHER review this browser opens is untouched.
    expect(localStorage.getItem(window.SplitButton.STORAGE_KEY)).toBe('preview');
    // 3. The button settles on the flushed answer rather than staying a lie.
    expect(splitButton.isOpen).toBe(false);
    expect(splitButton._pendingHideSubmit).toBeNull();
    expect(splitButton.hideSubmit).toBe(true);
    expect(splitButton.defaultAction).toBe('preview');
    expect(menuActions(splitButton)).toEqual(['preview', 'clear']);
    // 4. A swallowed click says so — a control that just does nothing reads as
    //    broken.
    expect(window.toast.showWarning).toHaveBeenCalledWith(
      'Submit is no longer available for this review.'
    );
  });

  it('swallows a MAIN-button Submit click parked the same way', async () => {
    // The main button stays clickable while the dropdown is open — the outside
    // click handler ignores anything inside the container — so it needs the
    // same flush, or it fires the action the menu row can no longer.
    localStorage.setItem(window.SplitButton.STORAGE_KEY, 'submit');
    const lm = metadataManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    window.prManager.capabilities.canSubmitToGitHub = true;
    const splitButton = mount();
    expect(splitButton.defaultAction).toBe('submit');

    splitButton.openDropdown();
    mockFetch.mockResolvedValue(jsonResponse({
      capabilities: { ...ALL_FALSE },
      associatedPR: null
    }));
    await lm._refreshPRMetadata();

    splitButton.container.querySelector('#split-button-main').click();

    expect(window.prManager.openReviewModal).not.toHaveBeenCalled();
    expect(window.prManager.openPreviewModal).not.toHaveBeenCalled();
    expect(splitButton.hideSubmit).toBe(true);
    expect(splitButton.defaultAction).toBe('preview');
    expect(splitButton.container.querySelector('#split-button-text').textContent).toBe('Preview');
    // The demotion is still not persisted.
    expect(localStorage.getItem(window.SplitButton.STORAGE_KEY)).toBe('submit');
    expect(window.toast.showWarning).toHaveBeenCalledTimes(1);
  });

  it('flushes a parked GAIN before the action instead of swallowing it', async () => {
    // The flush is general — it releases whatever is parked — but only an
    // action the answer actually REVOKED is swallowed. Gaining Submit revokes
    // nothing, so a Preview click still runs, against the settled state.
    const lm = metadataManager({ hasAssociatedPR: false });
    const splitButton = mount();
    expect(splitButton.hideSubmit).toBe(true);

    splitButton.openDropdown();
    mockFetch.mockResolvedValue(jsonResponse({
      capabilities: CAPS({ canSubmitToGitHub: true }),
      associatedPR: { prNumber: 77, repository: 'owner/repo' }
    }));
    await lm._refreshPRMetadata();
    expect(splitButton._pendingHideSubmit).toBe(false);

    clickMenuItem(splitButton, 'preview');

    expect(window.prManager.openPreviewModal).toHaveBeenCalledTimes(1);
    expect(window.toast.showWarning).not.toHaveBeenCalled();
    expect(splitButton.hideSubmit).toBe(false);
    expect(menuActions(splitButton)).toEqual(['submit', 'preview', 'clear']);
    expect(splitButton.isOpen).toBe(false);
  });

  it('still submits — and still persists the preference — with nothing parked', () => {
    // The guard must not cost the ordinary path anything.
    localStorage.setItem(window.SplitButton.STORAGE_KEY, 'preview');
    window.prManager = createPRManager({ canSubmitToGitHub: true });
    const splitButton = mount();
    expect(splitButton.defaultAction).toBe('preview');

    splitButton.openDropdown();
    clickMenuItem(splitButton, 'submit');

    expect(window.prManager.openReviewModal).toHaveBeenCalledTimes(1);
    expect(splitButton.defaultAction).toBe('submit');
    expect(localStorage.getItem(window.SplitButton.STORAGE_KEY)).toBe('submit');
    expect(window.toast.showWarning).not.toHaveBeenCalled();
    expect(splitButton.isOpen).toBe(false);
  });
});

describe('an unknown lifecycle answer never downgrades a known one', () => {
  /**
   * Both modes, one rule, one implementation
   * (`PRManager._applyPRLifecycleBadge`): a payload that reports no lifecycle
   * is evidence about nothing. Reading it as an open PR retracted the MERGED
   * badge AND widened the review modal's events back to Approve — options the
   * backend refuses with 410.
   */
  it('keeps the badge, the write-back and the narrowed events in PR mode', () => {
    const ReviewModal = requireReviewModal();
    const manager = createPRManager({ canSubmitToGitHub: true });
    window.prManager = manager;

    manager._applyPRLifecycleBadge({ state: 'closed', merged: true });
    const modal = new ReviewModal();
    modal.show();
    expect(lifecycleLabel()).toBe('MERGED');
    expect(modal.modal.querySelector('input[value="APPROVE"]').disabled).toBe(true);

    // What a fail-open `check-stale` reduces to once `lifecycleFromStaleness`
    // has refused it — and what a good-but-partial answer looks like.
    manager._applyPRLifecycleBadge({});

    expect(lifecycleLabel()).toBe('MERGED');
    expect(manager.currentPR.merged).toBe(true);
    expect(modal.modal.querySelector('input[value="APPROVE"]').disabled).toBe(true);
    expect(modal.modal.querySelector('input[value="COMMENT"]').disabled).toBe(false);
  });

  it('keeps them in LOCAL mode too, where the fact lives on associatedPR', () => {
    const ReviewModal = requireReviewModal();
    const lm = createManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    const manager = createPRManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    manager.currentPR.associatedPR = { prNumber: 77, state: 'open', merged: false };
    window.prManager = manager;
    lm.localData = { id: 42, shaAbbrevLength: 7 };
    lm._prHeadCheckGeneration = 0;

    const modal = new ReviewModal();
    modal.show();

    // A good answer establishes MERGED.
    lm._applyPRHeadStaleState(
      { prHead: { prNumber: 77, merged: true, prState: 'closed', drifted: false }, reasons: [] },
      7,
      {}
    );
    expect(lifecycleLabel()).toBe('MERGED');
    expect(modal.modal.querySelector('input[value="APPROVE"]').disabled).toBe(true);

    // The next check fails open: `prHead.error`, no lifecycle fields.
    lm._applyPRHeadStaleState(
      {
        prHead: {
          prNumber: 77, error: 'GitHub request failed', prState: null, drifted: null
        },
        reasons: []
      },
      7,
      {}
    );

    expect(lifecycleLabel()).toBe('MERGED');
    expect(manager.currentPR.associatedPR.merged).toBe(true);
    expect(modal.modal.querySelector('input[value="APPROVE"]').disabled).toBe(true);
  });

  it('ignores a good answer that reports neither field, without an error flag', () => {
    // `merged` used to be coerced (`prHead.merged === true`), so an omitted
    // field silently un-merged the association even on a non-error response.
    const ReviewModal = requireReviewModal();
    const lm = createManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    const manager = createPRManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    manager.currentPR.associatedPR = { prNumber: 77, state: 'closed', merged: true };
    window.prManager = manager;
    lm.localData = { id: 42, shaAbbrevLength: 7 };
    lm._prHeadCheckGeneration = 0;

    const modal = new ReviewModal();
    modal.show();
    expect(modal.modal.querySelector('input[value="APPROVE"]').disabled).toBe(true);

    lm._applyPRHeadStaleState(
      { prHead: { prNumber: 77, drifted: false }, reasons: [] },
      7,
      {}
    );

    expect(manager.currentPR.associatedPR).toMatchObject({ state: 'closed', merged: true });
    expect(modal.modal.querySelector('input[value="APPROVE"]').disabled).toBe(true);
  });

  it('still retracts everything on an explicit OPEN answer', () => {
    // Self-healing in the other direction is the whole reason the slot is
    // cleared at all — a reopened PR must get its options back.
    const ReviewModal = requireReviewModal();
    const lm = createManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    const manager = createPRManager({ hasAssociatedPR: true, canSubmitToGitHub: true });
    manager.currentPR.associatedPR = { prNumber: 77, state: 'closed', merged: false };
    window.prManager = manager;
    lm.localData = { id: 42, shaAbbrevLength: 7 };
    lm._prHeadCheckGeneration = 0;

    const modal = new ReviewModal();
    modal.show();
    expect(modal.modal.querySelector('input[value="APPROVE"]').disabled).toBe(true);

    lm._applyPRHeadStaleState(
      {
        prHead: { prNumber: 77, prState: 'open', merged: false, drifted: false },
        reasons: []
      },
      7,
      {}
    );

    expect(lifecycleLabel()).toBeNull();
    expect(manager.currentPR.associatedPR).toMatchObject({ state: 'open', merged: false });
    expect(modal.modal.querySelector('input[value="APPROVE"]').disabled).toBe(false);
  });
});
