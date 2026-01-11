// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * AI Summary Modal Component
 * Displays the AI-generated analysis summary with stats and copy functionality
 */
class AISummaryModal {
  constructor() {
    this.modal = null;
    this.isVisible = false;
    this.summary = null;
    this.stats = { issues: 0, suggestions: 0, praise: 0 };
    this.handleKeydown = null; // Store reference for cleanup
    this.createModal();
    this.setupEventListeners();
  }

  /**
   * Create the modal DOM structure
   */
  createModal() {
    // Remove existing modal and clean up old instance if it exists
    const existingModal = document.getElementById('ai-summary-modal');
    if (existingModal) {
      // Clean up old instance's event listeners if it exists
      if (window.aiSummaryModal && window.aiSummaryModal !== this) {
        window.aiSummaryModal.destroy();
      }
      existingModal.remove();
    }

    // Create modal container
    const modalContainer = document.createElement('div');
    modalContainer.id = 'ai-summary-modal';
    modalContainer.className = 'modal-overlay ai-summary-modal-overlay';
    modalContainer.style.display = 'none';

    modalContainer.innerHTML = `
      <div class="modal-backdrop" data-action="close"></div>
      <div class="modal-container ai-summary-modal-container">
        <div class="modal-header">
          <h3>AI Analysis Summary</h3>
          <button class="modal-close-btn" data-action="close" title="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
            </svg>
          </button>
        </div>

        <div class="modal-body ai-summary-modal-body">
          <!-- Stats bar -->
          <div class="ai-summary-stats">
            <div class="ai-summary-stat ai-summary-stat-issues">
              <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575L6.457 1.047Z"/>
              </svg>
              <span class="ai-summary-stat-count" id="ai-summary-issues-count">0</span>
              <span class="ai-summary-stat-label">issues</span>
            </div>
            <div class="ai-summary-stat ai-summary-stat-suggestions">
              <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                <path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z"/>
              </svg>
              <span class="ai-summary-stat-count" id="ai-summary-suggestions-count">0</span>
              <span class="ai-summary-stat-label">suggestions</span>
            </div>
            <div class="ai-summary-stat ai-summary-stat-praise">
              <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/>
              </svg>
              <span class="ai-summary-stat-count" id="ai-summary-praise-count">0</span>
              <span class="ai-summary-stat-label">praise</span>
            </div>
          </div>

          <!-- Summary text -->
          <div class="ai-summary-content" id="ai-summary-content">
            <p class="ai-summary-empty">No AI summary available. Run an analysis to generate a summary.</p>
          </div>
        </div>

        <div class="modal-footer ai-summary-modal-footer">
          <button class="btn btn-secondary" data-action="close">Close</button>
          <button class="btn btn-primary" id="ai-summary-copy-btn" title="Copy summary to clipboard">
            <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
              <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path>
              <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path>
            </svg>
            Copy Summary
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modalContainer);
    this.modal = modalContainer;

    // Store reference globally for access
    window.aiSummaryModal = this;
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Handle close actions via event delegation
    this.modal.addEventListener('click', (e) => {
      // Check for explicit close action
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'close') {
        this.hide();
        return;
      }

      // Also close when clicking directly on the overlay (outside the modal container)
      // This handles clicks on the overlay background that miss the backdrop element
      if (e.target === this.modal) {
        this.hide();
      }
    });

    // Handle escape key - store reference for cleanup
    this.handleKeydown = (e) => {
      if (e.key === 'Escape' && this.isVisible) {
        this.hide();
      }
    };
    document.addEventListener('keydown', this.handleKeydown);

    // Handle copy button
    const copyBtn = this.modal.querySelector('#ai-summary-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => this.copySummary());
    }
  }

  /**
   * Update the modal with new data
   * @param {Object} data - Summary data { summary, stats }
   */
  setData(data) {
    this.summary = data?.summary || null;
    this.stats = data?.stats || { issues: 0, suggestions: 0, praise: 0 };
    this.updateDisplay();
  }

  /**
   * Update the modal display with current data
   */
  updateDisplay() {
    // Update stats
    const issuesEl = this.modal.querySelector('#ai-summary-issues-count');
    const suggestionsEl = this.modal.querySelector('#ai-summary-suggestions-count');
    const praiseEl = this.modal.querySelector('#ai-summary-praise-count');

    if (issuesEl) issuesEl.textContent = this.stats.issues || 0;
    if (suggestionsEl) suggestionsEl.textContent = this.stats.suggestions || 0;
    if (praiseEl) praiseEl.textContent = this.stats.praise || 0;

    // Update summary content
    const contentEl = this.modal.querySelector('#ai-summary-content');
    const copyBtn = this.modal.querySelector('#ai-summary-copy-btn');

    if (contentEl) {
      if (this.summary) {
        // Render markdown if available, otherwise plain text
        if (window.renderMarkdown) {
          contentEl.innerHTML = window.renderMarkdown(this.summary);
        } else {
          contentEl.innerHTML = `<p>${this.escapeHtml(this.summary)}</p>`;
        }
      } else {
        contentEl.innerHTML = '<p class="ai-summary-empty">No AI summary available. Run an analysis to generate a summary.</p>';
      }
    }

    // Disable copy button if no summary
    if (copyBtn) {
      copyBtn.disabled = !this.summary;
    }
  }

  /**
   * Show the modal
   */
  show() {
    if (!this.modal) return;

    this.updateDisplay();
    this.modal.style.display = 'flex';
    this.isVisible = true;
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
   * Copy summary to clipboard
   */
  async copySummary() {
    if (!this.summary) return;

    try {
      await navigator.clipboard.writeText(this.summary);

      // Show success feedback
      if (window.toast) {
        window.toast.showSuccess('Summary copied to clipboard');
      }
    } catch (error) {
      console.error('Failed to copy summary:', error);
      if (window.toast) {
        window.toast.showError('Failed to copy summary');
      }
    }
  }

  /**
   * Get the current summary text
   * @returns {string|null} The summary text or null
   */
  getSummary() {
    return this.summary;
  }

  /**
   * Escape HTML to prevent XSS
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Clean up event listeners and DOM elements
   * Call this before removing/replacing the modal to prevent memory leaks
   */
  destroy() {
    // Remove keydown listener
    if (this.handleKeydown) {
      document.removeEventListener('keydown', this.handleKeydown);
      this.handleKeydown = null;
    }

    // Remove modal from DOM
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }

    // Clear global reference if it points to this instance
    if (window.aiSummaryModal === this) {
      window.aiSummaryModal = null;
    }

    this.isVisible = false;
  }
}

// Initialize when DOM is ready if not already initialized
if (typeof window !== 'undefined' && !window.aiSummaryModal) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.aiSummaryModal = new AISummaryModal();
    });
  } else {
    window.aiSummaryModal = new AISummaryModal();
  }
}
