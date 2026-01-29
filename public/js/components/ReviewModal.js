// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Review Submission Modal Component
 * Allows users to submit their review with comments to GitHub
 */
class ReviewModal {
  constructor() {
    this.modal = null;
    this.isVisible = false;
    this.isSubmitting = false;
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
                  You have a pending draft review on GitHub with <strong id="pending-draft-count">0</strong> comments.
                  Submitting here will add to or complete this review.
                  <a href="#" id="pending-draft-link" target="_blank" rel="noopener noreferrer">Manage on GitHub</a>.
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
                    <span class="review-type-desc">Save your review as a draft on GitHub to finish later.</span>
                  </div>
                </label>
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
          <button class="btn btn-primary" id="submit-review-btn-modal" onclick="reviewModal.submitReview()">
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

    // Handle escape key - uses window.reviewModal to get the current instance
    document.addEventListener('keydown', (e) => {
      const instance = window.reviewModal;
      if (e.key === 'Escape' && instance?.isVisible && !instance?.isSubmitting) {
        instance.hide();
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

    if (!textarea || !selectedOption) return;

    const isDraft = selectedOption.value === 'DRAFT';

    textarea.disabled = isDraft;

    if (isDraft) {
      textarea.title = 'Review summary is not included with draft reviews';
      textarea.classList.add('disabled-textarea');
    } else {
      textarea.title = '';
      textarea.classList.remove('disabled-textarea');
    }
  }

  /**
   * Show the modal
   */
  show() {
    if (!this.modal) return;
    
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
        countElement.textContent = pendingDraft.comments_count || 0;
      }

      // Update the link - hide if no github_url
      const linkElement = notice.querySelector('#pending-draft-link');
      if (linkElement) {
        if (pendingDraft.github_url) {
          linkElement.href = pendingDraft.github_url;
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
    const lineComments = document.querySelectorAll('.user-comment-row').length;
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
    }
  }

  /**
   * Submit the review
   */
  async submitReview() {
    if (this.isSubmitting) return;
    
    const reviewBody = this.modal.querySelector('#review-body-modal').value.trim();
    const selectedOption = this.modal.querySelector('input[name="review-event"]:checked');
    const reviewEvent = selectedOption ? selectedOption.value : 'COMMENT';
    // Count BOTH line-level (.user-comment-row) and file-level (.file-comment-card.user-comment) comments
    // This must match the counting logic in updateCommentCount() for consistency
    const lineComments = document.querySelectorAll('.user-comment-row').length;
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
      
      const response = await fetch(`/api/pr/${pr.owner}/${pr.repo}/${pr.number}/submit-review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          event: reviewEvent,
          body: reviewBody
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Failed to ${isDraft ? 'submit draft' : 'submit'} review`);
      }
      
      const result = await response.json();
      
      // Show appropriate success message
      if (window.toast) {
        const reviewUrl = result.reviewUrl || result.github_url;
        if (isDraft) {
          window.toast.showSuccess(
            'Draft review submitted to GitHub successfully!',
            {
              duration: 5000
            }
          );
        } else {
          window.toast.showSuccess(
            'Review submitted successfully!',
            {
              link: reviewUrl,
              linkText: 'View on GitHub',
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

        // Update the pending draft indicator immediately
        // Count comments that were just submitted
        const submittedCount = commentCount;
        const pendingDraft = {
          github_url: result.github_url,
          comments_count: submittedCount
        };

        // Update currentPR and refresh the indicator
        if (window.prManager?.currentPR) {
          window.prManager.currentPR.pendingDraft = pendingDraft;
          window.prManager.updatePendingDraftIndicator(pendingDraft);
        }

        // After 2 seconds, open GitHub PR page for drafts
        setTimeout(() => {
          const githubUrl = result.github_url || `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
          window.open(githubUrl, '_blank');
        }, 2000);
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

    // Get AI summary from the AI panel
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