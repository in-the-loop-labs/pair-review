// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Review Submission Modal Component
 * Allows users to submit their review with comments to GitHub
 */

const ASSISTED_BY_STORAGE_KEY = 'pair-review-assisted-by';
const DEFAULT_ASSISTED_BY_URL = 'https://github.com/in-the-loop-labs/pair-review';

class ReviewModal {
  constructor() {
    this.modal = null;
    this.isVisible = false;
    this.isSubmitting = false;
    this.assistedByUrl = DEFAULT_ASSISTED_BY_URL;
    // A `pr_merged` / `pr_closed` refusal pinned for this modal session — see
    // `currentLifecycle`. Cleared on every `show()`.
    this._lifecycleRefusal = null;
    fetch('/api/config')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.assisted_by_url) {
          this.assistedByUrl = data.assisted_by_url;
        }
      })
      .catch(() => {});  // Use default on failure
    this.createModal();
    this.setupEventListeners();
  }

  /**
   * Create the modal DOM structure
   */
  createModal() {
    // Remove existing modal if it exists
    const existing = document.getElementById('review-modal');
    if (existing) {
      existing.remove();
    }

    // Create modal container
    const modalContainer = document.createElement('div');
    modalContainer.id = 'review-modal';
    modalContainer.className = 'modal-overlay review-modal-overlay';
    modalContainer.style.display = 'none';
    
    modalContainer.innerHTML = `
      <div class="modal-backdrop" onclick="reviewModal.handleBackdropClick()"></div>
      <div class="modal-container review-modal-container">
        <div class="modal-header">
          <h3>Submit Review</h3>
          <button class="modal-close-btn" onclick="reviewModal.handleCloseClick()" title="Close" id="close-review-btn">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
            </svg>
          </button>
        </div>
        
        <div class="modal-body review-modal-body">
          <div class="review-form">
            <!-- Pending draft notice -->
            <div class="pending-draft-notice" id="pending-draft-notice" style="display: none;">
              <div class="pending-draft-notice-icon">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Z"/>
                </svg>
              </div>
              <div class="pending-draft-notice-content">
                <span class="pending-draft-notice-text">
                  You have a pending draft review on <span class="rm-host-name">GitHub</span> with <strong id="pending-draft-count">0</strong> comments.
                  Submitting here will add to or complete this review.
                  <a href="#" id="pending-draft-link" target="_blank" rel="noopener noreferrer">Manage on <span class="rm-host-name">GitHub</span></a>.
                </span>
              </div>
            </div>

            <div class="review-summary-section">
              <div class="review-label-row">
                <label for="review-body-modal" class="review-label">Review Summary</label>
                <a href="#" class="copy-ai-summary-link" id="copy-ai-summary-link" style="display: none;">Copy AI summary</a>
              </div>
              <textarea
                class="review-body-textarea"
                id="review-body-modal"
                placeholder="Leave a comment about this pull request..."
                rows="2"
              ></textarea>
              <label class="remember-toggle assisted-by-toggle" id="assisted-by-toggle">
                <input type="checkbox" id="assisted-by-checkbox" />
                <span class="toggle-switch"></span>
                <span class="toggle-label">Append pair-review footer</span>
              </label>
            </div>
            
            <div class="review-type-section">
              <label class="review-label">Review Type</label>
              <div class="review-type-options">
                <label class="review-type-option">
                  <input type="radio" name="review-event" value="COMMENT" checked>
                  <div class="review-type-content">
                    <span class="review-type-label">Comment</span>
                    <span class="review-type-desc">Submit general feedback without explicit approval.</span>
                  </div>
                </label>

                <label class="review-type-option">
                  <input type="radio" name="review-event" value="APPROVE">
                  <div class="review-type-content">
                    <span class="review-type-label">Approve</span>
                    <span class="review-type-desc">Submit feedback and approve merging these changes.</span>
                  </div>
                </label>

                <label class="review-type-option">
                  <input type="radio" name="review-event" value="REQUEST_CHANGES">
                  <div class="review-type-content">
                    <span class="review-type-label">Request changes</span>
                    <span class="review-type-desc">Submit feedback suggesting changes.</span>
                  </div>
                </label>

                <label class="review-type-option">
                  <input type="radio" name="review-event" value="DRAFT">
                  <div class="review-type-content">
                    <span class="review-type-label">Save as Draft</span>
                    <span class="review-type-desc">Save your review as a draft on <span class="rm-host-name">GitHub</span> to finish later.</span>
                  </div>
                </label>
              </div>

              <!--
                Why a review type may be unavailable. Reuses the warning-dialog
                shell (the same one as the large-review warning) rather than a
                bespoke style, and is shown ONLY when something is actually
                disabled — an open PR must not carry a permanent explanation of
                a restriction that is not in force.
              -->
              <div class="warning-dialog" id="review-lifecycle-warning" style="display: none;">
                <div class="warning-dialog-title">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>
                  </svg>
                  <span id="review-lifecycle-warning-title">Pull request closed</span>
                </div>
                <div class="warning-dialog-content" id="review-lifecycle-warning-text"></div>
              </div>
            </div>

            <div class="review-comment-summary">
              <div class="review-comment-count"></div>
            </div>
            
            <!-- Warning dialog for large reviews -->
            <div class="warning-dialog" id="large-review-warning" style="display: none;">
              <div class="warning-dialog-title">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>
                </svg>
                Large Review Warning
              </div>
              <div class="warning-dialog-content">
                This review contains more than 50 comments. Large reviews may take longer to submit and could be harder for reviewers to process. Consider breaking down your feedback into smaller, more focused reviews.
              </div>
            </div>
            
            <!-- Error display -->
            <div class="modal-error-message" id="review-error-message" style="display: none;"></div>
          </div>
        </div>
        
        <div class="modal-footer review-modal-footer">
          <button class="btn btn-secondary" onclick="reviewModal.handleCloseClick()" id="cancel-review-btn">Cancel</button>
          <button class="btn btn-primary" id="submit-review-btn-modal" onclick="reviewModal.submitReview()" title="Submit review (Cmd/Ctrl+Enter)">
            Submit review
          </button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modalContainer);
    this.modal = modalContainer;
    
    // Store reference globally for onclick handlers
    window.reviewModal = this;
  }

  /**
   * Setup event listeners
   * Uses static class-level handlers to prevent duplicate listeners when multiple instances are created
   */
  setupEventListeners() {
    // Skip if listeners are already registered (class-level flag)
    if (ReviewModal._listenersRegistered) {
      return;
    }
    ReviewModal._listenersRegistered = true;

    // Handle keyboard shortcuts - uses window.reviewModal to get the current instance
    document.addEventListener('keydown', (e) => {
      const instance = window.reviewModal;
      if (!instance?.isVisible) return;

      if (e.key === 'Escape' && !instance.isSubmitting) {
        instance.hide();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !instance.isSubmitting) {
        e.preventDefault();
        instance.submitReview();
      }
    });

    // Handle copy AI summary link (delegated since modal is recreated)
    document.addEventListener('click', (e) => {
      if (e.target.closest('#copy-ai-summary-link')) {
        e.preventDefault();
        window.reviewModal?.appendAISummary();
      }
    });

    // Handle review type selection change (delegated since modal is recreated)
    document.addEventListener('change', (e) => {
      if (e.target.matches('input[name="review-event"]')) {
        window.reviewModal?.updateTextareaState();
      }
      if (e.target.matches('#assisted-by-checkbox')) {
        window.reviewModal?.handleAssistedByToggle();
      }
    });
  }

  /**
   * Update textarea disabled state based on selected review type
   * Disables the textarea when Draft is selected since GitHub doesn't include
   * the review body for draft reviews
   */
  updateTextareaState() {
    const textarea = this.modal?.querySelector('#review-body-modal');
    const selectedOption = this.modal?.querySelector('input[name="review-event"]:checked');
    const toggle = this.modal?.querySelector('#assisted-by-toggle');

    if (!textarea || !selectedOption) return;

    const isDraft = selectedOption.value === 'DRAFT';

    textarea.disabled = isDraft;

    if (isDraft) {
      textarea.title = 'Review summary is not included with draft reviews';
      textarea.classList.add('disabled-textarea');
      if (toggle) {
        toggle.classList.add('disabled');
      }
    } else {
      textarea.title = '';
      textarea.classList.remove('disabled-textarea');
      if (toggle) {
        toggle.classList.remove('disabled');
      }
    }
  }

  /**
   * The review events a settled (merged or closed) pull request still accepts.
   *
   * Mirrors the backend precondition in src/providers/review-submit.js: a
   * merged or closed PR takes a COMMENT review — the discussion outlives the
   * merge — but refuses APPROVE, REQUEST_CHANGES and DRAFT with 410. Kept as a
   * named constant so the two halves of the same rule are greppable from each
   * other.
   */
  static SETTLED_PR_EVENTS = ['COMMENT'];

  /** Every event the modal offers, in the order the radios are rendered. */
  static ALL_EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES', 'DRAFT'];

  /**
   * Classify a PR lifecycle into the restriction it imposes, or null when it
   * imposes none.
   *
   * `merged` is checked FIRST — the other order labels every merged PR closed,
   * because GitHub reports a merge as `state: 'closed'` plus `merged: true`.
   * Same ordering rule as `_applyPRLifecycleBadge` in public/js/pr.js, and for
   * the same reason.
   *
   * An unknown/missing `state` reads as OPEN. Guessing "settled" from missing
   * data would silently strip Approve from a healthy PR whose metadata simply
   * had not arrived — a far worse failure than letting the backend refuse.
   *
   * @param {{state: string|null|undefined, merged: boolean|null|undefined}|null} lifecycle
   * @returns {{kind: 'merged'|'closed', title: string, message: string}|null}
   */
  static lifecycleRestriction(lifecycle) {
    if (!lifecycle) return null;
    const merged = lifecycle.merged === true;
    const closed = !merged
      && typeof lifecycle.state === 'string'
      && lifecycle.state.toLowerCase() !== 'open';

    if (!merged && !closed) return null;

    const host = ReviewModal.hostName();
    const what = merged ? 'has been merged' : 'is closed';
    return {
      kind: merged ? 'merged' : 'closed',
      title: merged ? 'Pull request merged' : 'Pull request closed',
      message: `This pull request ${what} on ${host}, so it can no longer be approved, `
        + 'have changes requested, or hold a new draft review. '
        + 'A comment review can still be submitted.'
    };
  }

  /**
   * The review events that may be submitted against a given PR lifecycle.
   *
   * @param {{state: string|null|undefined, merged: boolean|null|undefined}|null} lifecycle
   * @returns {string[]}
   */
  static allowedEvents(lifecycle) {
    return ReviewModal.lifecycleRestriction(lifecycle)
      ? [...ReviewModal.SETTLED_PR_EVENTS]
      : [...ReviewModal.ALL_EVENTS];
  }

  /**
   * The lifecycle this modal is currently reasoning about.
   *
   * A refusal the backend just returned WINS over the manager's copy. That copy
   * is what produced the options the user submitted, so by definition it was
   * stale; re-reading it after a `pr_merged` / `pr_closed` refusal would put
   * the same wrong options straight back — including when the corrective
   * refresh itself fails, which is precisely when the guard matters.
   *
   * Scoped to one modal session: `show()` clears it, so a PR that is reopened
   * gets its full option set back on the next open.
   *
   * @returns {{state: string|null, merged: boolean}|null}
   */
  currentLifecycle() {
    if (this._lifecycleRefusal) return this._lifecycleRefusal;
    // Ask the active manager — never `window.PAIR_REVIEW_LOCAL_MODE`. In local
    // mode this resolves the ASSOCIATED PR's lifecycle; in PR mode, the PR's
    // own. See `PRManager.getPRLifecycle`.
    return window.prManager?.getPRLifecycle?.() || null;
  }

  /**
   * Enable/disable the review-type radios from the target PR's lifecycle.
   *
   * Disabled-with-an-explanation rather than removed, matching the idiom the
   * modal already uses for the Draft textarea (`updateTextareaState` disables
   * it and says why in a `title`) — a control that vanishes reads as a bug,
   * while a greyed-out one with a reason reads as an answer. The reason also
   * appears as a visible `.warning-dialog`, because a `title` alone is
   * invisible to anyone not hovering.
   *
   * Re-entrant and idempotent: called from `show()`, from
   * `PRManager.updateSubmitAffordance` while the modal is already open, and
   * after a lifecycle refusal.
   */
  applyAllowedEvents() {
    if (!this.modal) return;

    const lifecycle = this.currentLifecycle();
    const restriction = ReviewModal.lifecycleRestriction(lifecycle);
    const allowed = ReviewModal.allowedEvents(lifecycle);

    let reselect = false;
    this.modal.querySelectorAll('input[name="review-event"]').forEach((input) => {
      const ok = allowed.includes(input.value);
      input.disabled = !ok;

      const option = input.closest('.review-type-option');
      if (option) {
        option.classList.toggle('disabled', !ok);
        if (!ok && restriction) {
          option.title = restriction.message;
        } else {
          option.removeAttribute('title');
        }
      }

      // The selection can go stale under the user: the modal may have been
      // opened against an open PR that merged while it sat there. Uncheck
      // first, choose afterwards — a radio group with the checked member
      // disabled still submits that value.
      if (!ok && input.checked) {
        input.checked = false;
        reselect = true;
      }
    });

    if (reselect) {
      const fallback = this.modal.querySelector('input[name="review-event"]:not(:disabled)');
      if (fallback) fallback.checked = true;
    }

    const warning = this.modal.querySelector('#review-lifecycle-warning');
    if (warning) {
      const titleEl = warning.querySelector('#review-lifecycle-warning-title');
      const textEl = warning.querySelector('#review-lifecycle-warning-text');
      if (restriction) {
        if (titleEl) titleEl.textContent = restriction.title;
        if (textEl) textEl.textContent = restriction.message;
      }
      warning.style.display = restriction ? 'block' : 'none';
    }

    // The selection may have moved off DRAFT, which owns the textarea's
    // disabled state. Never let the two disagree.
    this.updateTextareaState();
  }

  /**
   * Show the modal
   */
  show() {
    if (!this.modal) return;

    // A new open is a fresh reading of the world: drop any refusal the LAST
    // submission attempt pinned, so a reopened PR regains its full option set.
    this._lifecycleRefusal = null;

    // Update comment count
    this.updateCommentCount();
    
    // Reset form
    const textarea = this.modal.querySelector('#review-body-modal');
    if (textarea) {
      textarea.value = '';
    }
    
    const radioButtons = this.modal.querySelectorAll('input[name="review-event"]');
    radioButtons.forEach(radio => {
      if (radio.value === 'COMMENT') {
        radio.checked = true;
      }
    });

    // Update textarea state (ensures it's enabled since COMMENT is selected by default)
    this.updateTextareaState();

    // Then narrow the offer to what the target PR can actually accept. Must
    // run AFTER the reset above, which unconditionally re-enables nothing but
    // does re-check COMMENT — the one event a settled PR still takes.
    this.applyAllowedEvents();

    // Restore assisted-by toggle from localStorage
    this.restoreAssistedByToggle();

    // Clear any errors or warnings
    this.hideError();
    this.updateLargeReviewWarning(0);
    
    // Show modal
    this.modal.style.display = 'flex';
    this.isVisible = true;
    
    // Focus on textarea
    setTimeout(() => {
      if (textarea) {
        textarea.focus();
      }
    }, 100);

    // Update AI summary link visibility
    this.updateAISummaryLink();

    // Apply the configured remote-host display name + icon (resolves
    // asynchronously after the modal HTML was built).
    this.applyHostName();
    this.applySubmitButtonIcon();

    // Update pending draft notice
    this.updatePendingDraftNotice();
  }

  /**
   * Update pending draft notice visibility and content
   * Shows a notice if there's a pending draft review on GitHub
   */
  updatePendingDraftNotice() {
    const notice = this.modal?.querySelector('#pending-draft-notice');
    if (!notice) return;

    // Get pending draft from the current PR data
    const pendingDraft = window.prManager?.currentPR?.pendingDraft;

    // Update the DRAFT radio option label based on pending draft existence
    const draftRadioLabel = this.modal?.querySelector('input[name="review-event"][value="DRAFT"]')
      ?.closest('.review-type-option')
      ?.querySelector('.review-type-label');

    if (pendingDraft) {
      // Update the comment count
      const countElement = notice.querySelector('#pending-draft-count');
      if (countElement) {
        countElement.textContent = String(pendingDraft.comments_count || 0);
      }

      // Update the link through `RepoLinks.draftUrl` — the same resolver the
      // toolbar indicator uses, so the notice and the indicator can never
      // point at different places. It prefers the URL built from the repo's
      // configured url_template (host-correct) over the server-reported
      // github_url, which some alt-hosts return as a wrong-host
      // github.com/issues URL.
      const linkElement = notice.querySelector('#pending-draft-link');
      if (linkElement) {
        const manageUrl = (typeof window !== 'undefined' && window.RepoLinks
          && typeof window.RepoLinks.draftUrl === 'function')
          ? window.RepoLinks.draftUrl(pendingDraft)
          : pendingDraft.github_url;
        if (manageUrl) {
          linkElement.href = manageUrl;
          linkElement.style.display = 'inline';
        } else {
          linkElement.style.display = 'none';
        }
      }

      notice.style.display = 'flex';

      // Change draft label to indicate adding to existing draft
      if (draftRadioLabel) {
        draftRadioLabel.textContent = 'Add to Draft';
      }
    } else {
      notice.style.display = 'none';

      // Restore original draft label
      if (draftRadioLabel) {
        draftRadioLabel.textContent = 'Save as Draft';
      }
    }
  }

  /**
   * Handle backdrop click - only close if not submitting
   */
  handleBackdropClick() {
    if (!this.isSubmitting) {
      this.hide();
    }
  }

  /**
   * Handle close button click - only close if not submitting
   */
  handleCloseClick() {
    if (!this.isSubmitting) {
      this.hide();
    }
  }

  /**
   * Hide the modal
   */
  hide() {
    if (!this.modal || this.isSubmitting) return;
    
    this.modal.style.display = 'none';
    this.isVisible = false;
  }

  /**
   * Update comment count display in modal
   */
  updateCommentCount() {
    // Count both line-level comments (.user-comment-row) and file-level comments (.file-comment-card.user-comment)
    const lineComments = document.querySelectorAll('.user-comment-row:not(.suggestion-edit-pending)').length;
    const fileComments = document.querySelectorAll('.file-comment-card.user-comment').length;
    const userComments = lineComments + fileComments;
    const countElement = this.modal.querySelector('.review-comment-count');
    
    if (countElement) {
      if (userComments > 0) {
        countElement.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="comment-icon">
            <path d="M2.678 11.894a1 1 0 0 1 .287.801 10.97 10.97 0 0 1-.398 2c1.395-.323 2.247-.697 2.634-.893a1 1 0 0 1 .71-.074A8.06 8.06 0 0 0 8 14c3.996 0 7-2.807 7-6 0-3.192-3.004-6-7-6S1 4.808 1 8c0 1.468.617 2.83 1.678 3.894z"/>
          </svg>
          <strong>${userComments}</strong> ${userComments === 1 ? 'comment' : 'comments'} will be submitted with this review
        `;
        countElement.style.display = 'flex';
      } else {
        countElement.style.display = 'none';
      }
    }
    
    // Update large review warning
    this.updateLargeReviewWarning(userComments);
  }

  /**
   * Show error message in modal
   */
  showError(message) {
    const errorElement = this.modal.querySelector('#review-error-message');
    if (errorElement) {
      errorElement.textContent = message;
      errorElement.style.display = 'block';
    }
  }

  /**
   * Hide error message
   */
  hideError() {
    const errorElement = this.modal.querySelector('#review-error-message');
    if (errorElement) {
      errorElement.style.display = 'none';
    }
  }

  /**
   * Show/hide large review warning
   */
  updateLargeReviewWarning(commentCount) {
    const warningElement = this.modal.querySelector('#large-review-warning');
    if (warningElement) {
      warningElement.style.display = commentCount > 50 ? 'block' : 'none';
    }
  }

  /**
   * Set modal submitting state
   */
  setSubmittingState(isSubmitting, reviewEvent = null) {
    this.isSubmitting = isSubmitting;
    
    // Update UI elements
    const submitBtn = this.modal.querySelector('#submit-review-btn-modal');
    const cancelBtn = this.modal.querySelector('#cancel-review-btn');
    const closeBtn = this.modal.querySelector('#close-review-btn');
    
    if (isSubmitting) {
      // Show loading state based on review type
      const isDraft = reviewEvent === 'DRAFT';
      submitBtn.innerHTML = `
        <div class="loading-spinner-small"></div>
        ${isDraft ? 'Submitting Draft...' : 'Submitting review...'}
      `;
      submitBtn.disabled = true;
      cancelBtn.style.display = 'none';
      closeBtn.style.display = 'none';
    } else {
      // Restore normal state
      submitBtn.innerHTML = 'Submit review';
      submitBtn.disabled = false;
      cancelBtn.style.display = 'inline-block';
      closeBtn.style.display = 'inline-block';
      // innerHTML reset drops any host icon — re-apply it.
      this.applySubmitButtonIcon();
    }
  }

  /**
   * Submit the review
   */
  async submitReview() {
    if (this.isSubmitting) return;
    
    const reviewBody = this.modal.querySelector('#review-body-modal').value.trim();
    const assistedByCheckbox = this.modal.querySelector('#assisted-by-checkbox');
    const finalBody = assistedByCheckbox?.checked
      ? reviewBody + this.getAssistedByFooter()
      : reviewBody;
    const selectedOption = this.modal.querySelector('input[name="review-event"]:checked');
    const reviewEvent = selectedOption ? selectedOption.value : 'COMMENT';
    // Count BOTH line-level (.user-comment-row) and file-level (.file-comment-card.user-comment) comments
    // This must match the counting logic in updateCommentCount() for consistency
    const lineComments = document.querySelectorAll('.user-comment-row:not(.suggestion-edit-pending)').length;
    const fileComments = document.querySelectorAll('.file-comment-card.user-comment').length;
    const commentCount = lineComments + fileComments;
    
    // Hide any previous errors
    this.hideError();
    
    // Validate
    if (reviewEvent === 'REQUEST_CHANGES' && !reviewBody && commentCount === 0) {
      this.showError('Please add comments or a review summary when requesting changes.');
      return;
    }
    
    // Show large review warning if needed but still allow submission
    this.updateLargeReviewWarning(commentCount);
    
    // Set submitting state
    this.setSubmittingState(true, reviewEvent);
    
    // Prevent navigation during submission for drafts
    const isDraft = reviewEvent === 'DRAFT';
    let handleBeforeUnload;
    if (isDraft) {
      handleBeforeUnload = (e) => {
        e.preventDefault();
        e.returnValue = 'Review submission in progress. Are you sure you want to leave?';
        return e.returnValue;
      };
      window.addEventListener('beforeunload', handleBeforeUnload);
    }
    
    try {
      // Get current PR from prManager
      const pr = window.prManager?.currentPR;
      if (!pr) {
        throw new Error('No PR loaded');
      }

      // The manager owns the endpoint — local mode addresses its review by
      // session id, PR mode by owner/repo/number, and this modal is shared.
      // Never mode-sniff here; see `PRManager.getSubmitReviewEndpoint`.
      const endpoint = window.prManager?.getSubmitReviewEndpoint?.()
        || `/api/pr/${pr.owner}/${pr.repo}/${pr.number}/submit-review`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          event: reviewEvent,
          body: finalBody
        })
      });
      
      if (!response.ok) {
        // Status-derived message FIRST, parse second. This endpoint does real
        // network work against a code host, so a non-JSON error body is
        // plausible — an Express HTML 500 page, a proxy 502 — and a bare
        // `await response.json()` rejects with a SyntaxError that the outer
        // catch renders verbatim: the user was shown `Unexpected token '<'`
        // instead of anything actionable. Same shape as the sibling local-mode
        // POST in `_syncGitHubDrafts` (public/js/local.js); the two paths had
        // diverged.
        let message = `Failed to ${isDraft ? 'submit draft' : 'submit'} review (${response.status})`;
        let code = null;
        try {
          const errorData = await response.json();
          if (errorData) {
            if (errorData.error) message = errorData.error;
            if (errorData.code) code = errorData.code;
          }
        } catch {
          // Non-JSON error body — keep the status-derived message.
        }
        const err = new Error(message);
        // The submit endpoint's stable refusal code (`head_drift`,
        // `pr_merged`, `comments_outside_pr`, ...). Carried on the error so the
        // catch below can tell a LIFECYCLE refusal — which invalidates the
        // options we are still showing — apart from every other 4xx, which
        // does not. Without this the shared modal could only show the text.
        err.code = code;
        throw err;
      }

      const result = await response.json();
      
      // Show appropriate success message
      if (window.toast) {
        const reviewUrl = result.reviewUrl || result.github_url;
        if (isDraft) {
          window.toast.showSuccess(
            `Draft review submitted to ${ReviewModal.escapeHtml(ReviewModal.hostName())} successfully!`,
            {
              duration: 5000
            }
          );
        } else {
          window.toast.showSuccess(
            'Review submitted successfully!',
            {
              link: reviewUrl,
              linkText: `View on ${ReviewModal.escapeHtml(ReviewModal.hostName())}`,
              duration: 5000
            }
          );
        }
      }
      
      // Clear submitting state before hiding modal
      this.setSubmittingState(false);
      
      // Hide modal
      this.hide();
      
      // Reset form
      this.modal.querySelector('#review-body-modal').value = '';
      const commentRadio = this.modal.querySelector('input[value="COMMENT"]');
      if (commentRadio) {
        commentRadio.checked = true;
      }
      this.hideError();
      this.updateLargeReviewWarning(0);
      
      // Remove beforeunload handler if it was added
      if (isDraft && handleBeforeUnload) {
        window.removeEventListener('beforeunload', handleBeforeUnload);
      }

      // Update the pending draft indicator and modal state
      if (window.prManager?.currentPR) {
        if (isDraft) {
          // Draft submission: update pending draft with new info from server
          const pendingDraft = {
            github_url: result.github_url,
            comments_count: result.comments_submitted ?? commentCount
          };
          window.prManager.currentPR.pendingDraft = pendingDraft;
          window.prManager.updatePendingDraftIndicator(pendingDraft);
        } else {
          // Non-draft submission (COMMENT/APPROVE/REQUEST_CHANGES): draft was consumed
          window.prManager.currentPR.pendingDraft = null;
          window.prManager.updatePendingDraftIndicator(null);
        }
      }

      if (isDraft) {
        // After 2 seconds, open the PR page for drafts. Use the PR's canonical
        // html_url (correct host + `/pull/`) rather than the review's html_url,
        // which some alt-hosts return as a github.com `/issues/<n>` URL. Never
        // assume github.com — see resolveDraftPrUrl.
        const prUrl = ReviewModal.resolveDraftPrUrl(pr, result);
        if (prUrl) {
          setTimeout(() => {
            window.open(prUrl, '_blank');
          }, 2000);
        }
      }
      
    } catch (error) {
      console.error(`Error ${isDraft ? 'submitting draft' : 'submitting'} review:`, error);
      this.showError(error.message);
      // Restore normal state on error
      this.setSubmittingState(false);
      // Remove beforeunload handler on error
      if (isDraft && handleBeforeUnload) {
        window.removeEventListener('beforeunload', handleBeforeUnload);
      }

      // A lifecycle refusal is a STATE RACE, not a user error: the PR settled
      // between the metadata we built these options from and the submit. The
      // modal stays open (the message is in it), so leaving the stale options
      // behind would invite the identical failed submit again.
      if (error.code === 'pr_merged' || error.code === 'pr_closed') {
        void this.handleLifecycleRefusal(error.code);
      }
    }
  }

  /**
   * Reconcile after the backend refused on PR lifecycle.
   *
   * Two steps, in this order and both needed:
   *   1. Pin the refusal locally and re-apply the options. Synchronous, so the
   *      modal is correct the moment the error text appears — and correct even
   *      if step 2 fails.
   *   2. Ask the manager to re-read the lifecycle from the server, which also
   *      repaints the header badge and the toolbar. `refreshPRLifecycle` calls
   *      back into `updateSubmitAffordance`, which re-applies these options
   *      again; that is idempotent.
   *
   * @param {'pr_merged'|'pr_closed'} code
   * @returns {Promise<void>} never rejects
   */
  async handleLifecycleRefusal(code) {
    // GitHub reports a merge as `state: 'closed'` plus `merged: true`; the
    // code is the only thing that separates the two, so it is translated back
    // into the same two-field shape every other lifecycle reader consumes.
    this._lifecycleRefusal = code === 'pr_merged'
      ? { state: 'closed', merged: true }
      : { state: 'closed', merged: false };
    this.applyAllowedEvents();

    try {
      await window.prManager?.refreshPRLifecycle?.();
    } catch (refreshError) {
      // Best-effort: the options are already correct from the pin above.
      console.warn('PR lifecycle refresh after refusal failed:', refreshError);
    }
  }

  /**
   * Update AI summary link visibility
   * Shows the link only when an AI summary is available
   */
  updateAISummaryLink() {
    const link = this.modal?.querySelector('#copy-ai-summary-link');
    if (!link) return;

    // Check if AI summary is available via the AI panel
    const summary = window.aiPanel?.getSummary?.();
    link.style.display = summary ? 'inline' : 'none';
  }

  /**
   * Append AI summary to the review textarea
   */
  appendAISummary() {
    const textarea = this.modal?.querySelector('#review-body-modal');
    if (!textarea) return;

    const summary = window.aiPanel?.getSummary?.();
    if (!summary) {
      if (window.toast) {
        window.toast.showWarning('No AI summary available');
      }
      return;
    }

    // Append to existing text (with newline if there's existing content)
    const currentValue = textarea.value.trim();
    if (currentValue) {
      textarea.value = currentValue + '\n\n' + summary;
    } else {
      textarea.value = summary;
    }

    // Show success feedback
    if (window.toast) {
      window.toast.showSuccess('AI summary added to review');
    }
  }

  /**
   * Get the "assisted by" footer string
   */
  getAssistedByFooter() {
    const url = this.assistedByUrl || DEFAULT_ASSISTED_BY_URL;
    return `\n\n---\n_Review assisted by [pair-review](${url})_`;
  }

  /**
   * Restore the assisted-by toggle state from localStorage
   */
  restoreAssistedByToggle() {
    const checkbox = this.modal?.querySelector('#assisted-by-checkbox');
    if (!checkbox) return;

    const stored = localStorage.getItem(ASSISTED_BY_STORAGE_KEY);
    checkbox.checked = stored !== 'false';
  }

  /**
   * Handle the assisted-by checkbox toggle
   */
  handleAssistedByToggle() {
    const checkbox = this.modal?.querySelector('#assisted-by-checkbox');
    if (!checkbox) return;

    localStorage.setItem(ASSISTED_BY_STORAGE_KEY, String(checkbox.checked));
  }

  /**
   * Display name of the remote code host, for user-facing text in place of
   * the literal "GitHub". Reads the configured `links.external.name` via
   * `window.RepoLinks.hostName()`, falling back to "GitHub".
   *
   * @returns {string}
   */
  static hostName() {
    if (typeof window !== 'undefined' && window.RepoLinks
        && typeof window.RepoLinks.hostName === 'function') {
      return window.RepoLinks.hostName();
    }
    return 'GitHub';
  }

  /**
   * Escape a string for safe interpolation into HTML. Used for the host
   * name (user-supplied config) before it goes into the success toast,
   * which renders its message/linkText via innerHTML.
   *
   * @param {string} text
   * @returns {string}
   */
  static escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Resolve the URL to open in a new tab after a draft submit.
   *
   * Precedence:
   *   1. The URL built from the repo's configured `links.external.url_template`
   *      (`window.RepoLinks.externalUrl()`) — authoritative and host-correct.
   *   2. The PR's canonical `html_url` (the host's own PR page), or the
   *      associated PR's `url` when the session carries one instead.
   *   3. The server-reported `github_url` as a last resort.
   *
   * Some alt-hosts return the pending-review `html_url` as a
   * `github.com/.../issues/<n>` URL, which lands on the wrong host and page.
   * We must never assume github.com, so there is no hardcoded fallback host:
   * if none of the above yields a URL we open nothing.
   *
   * Phase 5 made this reachable from LOCAL mode, where tier 2 was structurally
   * unreachable: the synthetic `currentPR` had no `html_url` at all, so an
   * alt-host draft submit fell through to exactly the wrong-host URL tier 2
   * exists to avoid, and tier 1 does not cover it (`externalUrl()` is null
   * unless a `url_template` is configured, which a GHE repo set up with only
   * `api_host` + a token does not have). The PRIMARY fix is in
   * public/js/local.js, which now populates `html_url` from
   * `associatedPR.url` — the host-correct value the PR pill already links to.
   * The `associatedPR.url` arm below is belt-and-braces for any other producer
   * of a `currentPR` that carries the association but not the flattened field.
   *
   * @param {{html_url?: string, associatedPR?: {url?: string}}|null|undefined} pr
   *   current PR (from prManager)
   * @param {{github_url?: string}|null|undefined} result - submit-review response
   * @returns {string|null} URL to open, or null if none is available
   */
  static resolveDraftPrUrl(pr, result) {
    if (typeof window !== 'undefined' && window.RepoLinks
        && typeof window.RepoLinks.externalUrl === 'function') {
      const templated = window.RepoLinks.externalUrl();
      if (templated) return templated;
    }
    if (pr) {
      const canonical = pr.html_url || pr.associatedPR?.url;
      if (canonical) return canonical;
    }
    if (result && result.github_url) return result.github_url;
    return null;
  }

  /**
   * Update host-name-dependent static text in the modal (the pending-draft
   * notice and the "Save as Draft" description) to the configured host name.
   * Called from `show()` because the name resolves asynchronously after the
   * modal HTML is built. No-op when the modal isn't present.
   */
  applyHostName() {
    if (!this.modal) return;
    const name = ReviewModal.hostName();
    const spans = this.modal.querySelectorAll('.rm-host-name');
    spans.forEach((el) => { el.textContent = name; });
  }

  /**
   * Prepend the configured external-host icon to the submit button, when an
   * icon is configured for the repo. The icon is parsed via
   * `window.RepoLinks.parseSvgIcon` (DOMParser + attribute stripping) and
   * inserted as a DOM node — never via innerHTML. Idempotent: any previously
   * inserted icon is removed first. No-op for plain github.com repos.
   */
  applySubmitButtonIcon() {
    const submitBtn = this.modal?.querySelector('#submit-review-btn-modal');
    if (!submitBtn) return;

    const existing = submitBtn.querySelector?.('.submit-host-icon');
    if (existing) existing.remove();

    if (typeof window === 'undefined' || !window.RepoLinks
        || typeof window.RepoLinks.externalIcon !== 'function'
        || typeof window.RepoLinks.parseSvgIcon !== 'function') {
      return;
    }
    const iconStr = window.RepoLinks.externalIcon();
    if (!iconStr) return;
    const svg = window.RepoLinks.parseSvgIcon(iconStr);
    if (!svg) return;

    svg.classList.add('submit-host-icon');
    if (!svg.getAttribute('width')) svg.setAttribute('width', '16');
    if (!svg.getAttribute('height')) svg.setAttribute('height', '16');
    submitBtn.insertBefore(svg, submitBtn.firstChild);
  }

}

// Initialize when DOM is ready if not already initialized
if (typeof window !== 'undefined' && !window.reviewModal) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.reviewModal = new ReviewModal();
    });
  } else {
    window.reviewModal = new ReviewModal();
  }
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ReviewModal };
}