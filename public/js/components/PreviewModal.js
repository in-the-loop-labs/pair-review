// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Preview Comments Modal Component
 * Shows a text preview of user comments for copying to AI agents
 */
class PreviewModal {
  constructor() {
    this.modal = null;
    this.isVisible = false;
    this.options = {};
    this.createModal();
    this.setupEventListeners();
  }

  /**
   * Create the modal DOM structure
   */
  createModal() {
    // Remove existing modal if it exists
    const existing = document.getElementById('preview-modal');
    if (existing) {
      existing.remove();
    }

    // Create modal container
    const modalContainer = document.createElement('div');
    modalContainer.id = 'preview-modal';
    modalContainer.className = 'modal-overlay preview-modal-overlay';
    modalContainer.style.display = 'none';

    modalContainer.innerHTML = `
      <div class="modal-backdrop" onclick="previewModal.handleBackdropClick()"></div>
      <div class="modal-container preview-modal-container">
        <div class="modal-header">
          <h3>Preview Comments</h3>
          <button class="modal-close-btn" onclick="previewModal.hide()" title="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
            </svg>
          </button>
        </div>

        <div class="modal-body preview-modal-body">
          <div class="preview-content-wrapper">
            <pre class="preview-text" id="preview-text"></pre>
          </div>
        </div>

        <div class="modal-footer preview-modal-footer">
          <button class="btn btn-danger" id="clear-all-comments-btn" onclick="previewModal.clearAllComments()" title="Delete all user comments">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 6px;">
              <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/>
            </svg>
            Clear All
          </button>
          <div style="flex: 1;"></div>
          <button class="btn btn-secondary" onclick="previewModal.hide()">Close</button>
          <button class="btn btn-secondary" id="copy-preview-btn" onclick="previewModal.copyToClipboard()">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 6px;">
              <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/>
              <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
            </svg>
            Copy as Markdown
          </button>
          <button class="btn btn-primary" id="submit-review-btn" onclick="previewModal.submitReview()">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 6px;">
              <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5Z"/>
            </svg>
            Submit Review
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modalContainer);
    this.modal = modalContainer;

    // Store reference globally for onclick handlers
    window.previewModal = this;
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Handle escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isVisible) {
        this.hide();
      }
    });
  }

  /**
   * Show the modal and load comments
   * @param {Object} options - Display options
   * @param {boolean} options.hideSubmit - Hide the Submit Review button (deprecated, use window.PAIR_REVIEW_LOCAL_MODE)
   * @param {boolean} options.hideClearAll - Hide the Clear All button
   */
  async show(options = {}) {
    if (!this.modal) return;

    this.options = options;

    // Show/hide buttons based on options and local mode
    const submitBtn = this.modal.querySelector('#submit-review-btn');
    const clearBtn = this.modal.querySelector('#clear-all-comments-btn');

    // Hide Submit Review in local mode or if explicitly requested
    const isLocalMode = window.PAIR_REVIEW_LOCAL_MODE === true;
    if (submitBtn) {
      submitBtn.style.display = (isLocalMode || options.hideSubmit) ? 'none' : '';
    }
    if (clearBtn) {
      clearBtn.style.display = options.hideClearAll ? 'none' : '';
    }

    // Show modal
    this.modal.style.display = 'flex';
    this.isVisible = true;

    // Load and display comments
    await this.loadComments();
  }

  /**
   * Handle backdrop click
   */
  handleBackdropClick() {
    this.hide();
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
   * Load user comments from the API
   */
  async loadComments() {
    const previewTextElement = this.modal.querySelector('#preview-text');

    try {
      // Get current PR from prManager
      const pr = window.prManager?.currentPR;
      if (!pr) {
        previewTextElement.textContent = 'No PR loaded';
        return;
      }

      // Determine the correct API endpoint based on mode
      let response;
      if (window.PAIR_REVIEW_LOCAL_MODE && window.localManager?.reviewId) {
        // Local mode - use local API endpoint
        response = await fetch(`/api/local/${window.localManager.reviewId}/user-comments`);
      } else {
        // PR mode - use PR API endpoint
        response = await fetch(`/api/pr/${pr.owner}/${pr.repo}/${pr.number}/user-comments`);
      }

      if (!response.ok) {
        throw new Error('Failed to load comments');
      }

      const data = await response.json();
      const comments = data.comments || [];

      // Store comments for copy functionality
      this.currentComments = comments;

      // Format comments for preview
      const formattedText = PreviewModal.formatComments(comments);
      previewTextElement.textContent = formattedText;

    } catch (error) {
      console.error('Error loading comments:', error);
      previewTextElement.textContent = 'Error loading comments: ' + error.message;
    }
  }

  /**
   * Format comments grouped by file (static for testability)
   */
  static formatComments(comments) {
    if (!comments || comments.length === 0) {
      return 'No comments to preview.';
    }

    // Group comments by file, separating file-level and line-level
    const commentsByFile = {};
    comments.forEach(comment => {
      if (!commentsByFile[comment.file]) {
        commentsByFile[comment.file] = {
          fileComments: [],
          lineComments: []
        };
      }
      // Check if this is a file-level comment
      if (comment.is_file_level === 1) {
        commentsByFile[comment.file].fileComments.push(comment);
      } else {
        commentsByFile[comment.file].lineComments.push(comment);
      }
    });

    // Sort files alphabetically
    const sortedFiles = Object.keys(commentsByFile).sort();

    // Build formatted text
    let text = '';

    sortedFiles.forEach((file, fileIndex) => {
      const { fileComments, lineComments } = commentsByFile[file];

      // Add file header
      if (fileIndex > 0) {
        text += '\n';
      }
      text += `## ${file}\n`;

      // Add file-level comments - each gets its own header
      if (fileComments.length > 0) {
        fileComments.forEach((comment, index) => {
          text += `\n### File Comment ${index + 1}:\n`;
          text += `${comment.body}\n`;
        });
      }

      // Add line-level comments - each gets its own header
      if (lineComments.length > 0) {
        // Sort line comments by line number
        lineComments.sort((a, b) => (a.line_start || 0) - (b.line_start || 0));

        lineComments.forEach(comment => {
          // Format line number(s) for header
          let lineInfo;
          if (comment.line_end && comment.line_end !== comment.line_start) {
            lineInfo = `lines ${comment.line_start}-${comment.line_end}`;
          } else {
            lineInfo = `line ${comment.line_start}`;
          }
          text += `\n### Line Comment (${lineInfo}):\n`;
          text += `${comment.body}\n`;
        });
      }
    });

    return text;
  }

  /**
   * Submit review - opens the review modal
   */
  submitReview() {
    this.hide();
    if (window.prManager && typeof window.prManager.openReviewModal === 'function') {
      window.prManager.openReviewModal();
    }
  }

  /**
   * Clear all user comments
   */
  async clearAllComments() {
    // Check that prManager is available before hiding modal
    if (!window.prManager || typeof window.prManager.clearAllUserComments !== 'function') {
      console.error('prManager.clearAllUserComments not available');
      alert('Unable to clear comments. Please refresh the page.');
      return;
    }

    // Hide the modal first so the confirmation dialog is visible
    this.hide();

    // Delegate to prManager to handle the actual deletion
    await window.prManager.clearAllUserComments();
  }

  /**
   * Copy preview text to clipboard (as Markdown)
   */
  async copyToClipboard() {
    const previewTextElement = this.modal.querySelector('#preview-text');
    const copyBtn = this.modal.querySelector('#copy-preview-btn');
    const originalText = copyBtn.innerHTML;

    try {
      const text = previewTextElement.textContent;
      await navigator.clipboard.writeText(text);

      // Show success feedback
      copyBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 6px;">
          <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
        </svg>
        Copied!
      `;
      copyBtn.disabled = true;

      // Reset button after 2 seconds
      setTimeout(() => {
        copyBtn.innerHTML = originalText;
        copyBtn.disabled = false;
      }, 2000);

    } catch (error) {
      console.error('Failed to copy to clipboard:', error);

      // Show error feedback
      copyBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 6px;">
          <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/>
        </svg>
        Failed to copy
      `;

      setTimeout(() => {
        copyBtn.innerHTML = originalText;
      }, 2000);
    }
  }
}

// Initialize when DOM is ready if not already initialized
if (typeof window !== 'undefined' && !window.previewModal) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.previewModal = new PreviewModal();
    });
  } else {
    window.previewModal = new PreviewModal();
  }
}

// Export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PreviewModal };
}
