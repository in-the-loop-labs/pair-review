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
            ${window.Icons.icon('close')}
          </button>
        </div>

        <div class="modal-body preview-modal-body">
          <div class="preview-content-wrapper">
            <pre class="preview-text" id="preview-text"></pre>
          </div>
        </div>

        <div class="modal-footer preview-modal-footer">
          <button class="btn btn-danger" id="clear-all-comments-btn" onclick="previewModal.clearAllComments()" title="Delete all user comments">
            <span style="margin-right: 6px; display: inline-flex;">${window.Icons.icon('trash', 16)}</span>
            Clear All
          </button>
          <div style="flex: 1;"></div>
          <button class="btn btn-secondary" onclick="previewModal.hide()">Close</button>
          <button class="btn btn-secondary" id="copy-preview-btn" onclick="previewModal.copyToClipboard()">
            <span style="margin-right: 6px; display: inline-flex;">${window.Icons.icon('copy', 16)}</span>
            Copy as Markdown
          </button>
          <button class="btn btn-primary" id="submit-review-btn" onclick="previewModal.submitReview()">
            <span style="margin-right: 6px; display: inline-flex;">${window.Icons.icon('commentFilled', 16)}</span>
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

      // Use unified review comments API (works for both PR and local mode)
      const reviewId = pr.id;
      let response;
      response = await fetch(`/api/reviews/${reviewId}/comments`);

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
        <span style="margin-right: 6px; display: inline-flex;">${window.Icons.icon('check', 16)}</span>
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
        <span style="margin-right: 6px; display: inline-flex;">${window.Icons.icon('close', 16)}</span>
        Failed to copy
      `;

      setTimeout(() => {
        copyBtn.innerHTML = originalText;
      }, 2000);
    }
  }
}

// Export class to window for static method access
if (typeof window !== 'undefined') {
  window.PreviewModal = PreviewModal;
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
