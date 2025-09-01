/**
 * Review Submission Modal Component
 * Allows users to submit their review with comments to GitHub
 */
class ReviewModal {
  constructor() {
    this.modal = null;
    this.isVisible = false;
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
      <div class="modal-backdrop" onclick="reviewModal.hide()"></div>
      <div class="modal-container review-modal-container">
        <div class="modal-header">
          <h3>Submit Review</h3>
          <button class="modal-close-btn" onclick="reviewModal.hide()" title="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
            </svg>
          </button>
        </div>
        
        <div class="modal-body review-modal-body">
          <div class="review-form">
            <div class="review-summary-section">
              <label for="review-body-modal" class="review-label">Review Summary</label>
              <textarea 
                class="review-body-textarea" 
                id="review-body-modal" 
                placeholder="Leave a comment about this pull request..."
                rows="6"
              ></textarea>
            </div>
            
            <div class="review-type-section">
              <label class="review-label">Review Type</label>
              <div class="review-type-options">
                <label class="review-type-option">
                  <input type="radio" name="review-event" value="COMMENT" checked>
                  <span class="review-type-label">Comment</span>
                  <span class="review-type-desc">Submit general feedback without explicit approval.</span>
                </label>
                
                <label class="review-type-option">
                  <input type="radio" name="review-event" value="APPROVE">
                  <span class="review-type-label">Approve</span>
                  <span class="review-type-desc">Submit feedback and approve merging these changes.</span>
                </label>
                
                <label class="review-type-option">
                  <input type="radio" name="review-event" value="REQUEST_CHANGES">
                  <span class="review-type-label">Request changes</span>
                  <span class="review-type-desc">Submit feedback suggesting changes.</span>
                </label>
              </div>
            </div>
            
            <div class="review-comment-summary">
              <div class="review-comment-count"></div>
            </div>
          </div>
        </div>
        
        <div class="modal-footer review-modal-footer">
          <button class="btn btn-secondary" onclick="reviewModal.hide()">Cancel</button>
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
   */
  setupEventListeners() {
    // Handle backdrop clicks
    const backdrop = this.modal.querySelector('.modal-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', () => this.hide());
    }
    
    // Handle escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isVisible) {
        this.hide();
      }
    });
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
    
    // Show modal
    this.modal.style.display = 'flex';
    this.isVisible = true;
    
    // Focus on textarea
    setTimeout(() => {
      if (textarea) {
        textarea.focus();
      }
    }, 100);
  }

  /**
   * Hide the modal
   */
  hide() {
    if (!this.modal) return;
    
    this.modal.style.display = 'none';
    this.isVisible = false;
  }

  /**
   * Update comment count display in modal
   */
  updateCommentCount() {
    const userComments = document.querySelectorAll('.user-comment-row').length;
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
  }

  /**
   * Submit the review
   */
  async submitReview() {
    const reviewBody = this.modal.querySelector('#review-body-modal').value.trim();
    const selectedOption = this.modal.querySelector('input[name="review-event"]:checked');
    const reviewEvent = selectedOption ? selectedOption.value : 'COMMENT';
    const submitBtn = this.modal.querySelector('#submit-review-btn-modal');
    
    // Validate
    if (reviewEvent === 'REQUEST_CHANGES' && !reviewBody && document.querySelectorAll('.user-comment-row').length === 0) {
      alert('Please add comments or a review summary when requesting changes.');
      return;
    }
    
    // Show loading state
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Submitting...';
    submitBtn.disabled = true;
    
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
        throw new Error(errorData.error || 'Failed to submit review');
      }
      
      const result = await response.json();
      
      // Show success message
      alert(`Review submitted successfully! ${result.message}`);
      
      // Hide modal
      this.hide();
      
      // Reset form
      this.modal.querySelector('#review-body-modal').value = '';
      const commentRadio = this.modal.querySelector('input[value="COMMENT"]');
      if (commentRadio) {
        commentRadio.checked = true;
      }
      
    } catch (error) {
      console.error('Error submitting review:', error);
      alert(`Failed to submit review: ${error.message}`);
      
    } finally {
      // Restore button
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
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