// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Status Indicator Component
 * Shows AI analysis status in the toolbar when running in background
 */
class StatusIndicator {
  constructor() {
    this.indicator = null;
    this.currentAnalysisId = null;
    this.animationDots = 0;
    this.dotsInterval = null;
    
    this.createIndicator();
  }

  /**
   * Create the status indicator DOM structure
   */
  createIndicator() {
    // Remove existing indicator if it exists
    const existing = document.getElementById('status-indicator');
    if (existing) {
      existing.remove();
    }

    // Create status indicator element
    const indicator = document.createElement('div');
    indicator.id = 'status-indicator';
    indicator.className = 'status-indicator';
    indicator.style.display = 'none';
    
    indicator.innerHTML = `
      <div class="status-content" onclick="statusIndicator.reopenModal()">
        <span class="status-icon">
          <svg class="spinner" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0a8 8 0 0 0-8 8h2a6 6 0 0 1 6-6V0z"/>
          </svg>
        </span>
        <span class="status-text">AI analyzing</span>
        <span class="status-dots">...</span>
      </div>
      <button class="status-close" onclick="statusIndicator.hide()" title="Dismiss">
        ${window.Icons.icon('close', 12, 12)}
      </button>
    `;

    // Insert indicator into the PR actions area
    const prActions = document.querySelector('.pr-actions');
    if (prActions) {
      // Insert before the first button (theme toggle)
      const firstButton = prActions.querySelector('button');
      if (firstButton) {
        prActions.insertBefore(indicator, firstButton);
      } else {
        prActions.appendChild(indicator);
      }
    } else {
      // Fallback: append to body
      document.body.appendChild(indicator);
    }

    this.indicator = indicator;
  }

  /**
   * Show the status indicator
   * @param {string} analysisId - Analysis ID being tracked
   * @param {string} text - Initial status text
   */
  show(analysisId, text = 'AI analyzing') {
    if (!this.indicator) {
      this.createIndicator();
    }

    this.currentAnalysisId = analysisId;
    this.indicator.style.display = 'flex';
    
    // Set initial state
    this.updateText(text);
    this.showSpinner();
    this.startDotsAnimation();
  }

  /**
   * Hide the status indicator
   */
  hide() {
    if (this.indicator) {
      this.indicator.style.display = 'none';
    }
    this.stopDotsAnimation();
    this.currentAnalysisId = null;
  }

  /**
   * Update status text
   * @param {string} text - New status text
   */
  updateText(text) {
    const statusText = this.indicator?.querySelector('.status-text');
    if (statusText) {
      statusText.textContent = text;
    }
  }

  /**
   * Show completion state
   * @param {string} message - Completion message
   */
  showComplete(message = 'Analysis complete') {
    this.updateText(message);
    this.showCheckmark();
    this.stopDotsAnimation();
    
    // CRITICAL FIX: Automatically reload AI suggestions when background analysis completes
    console.log('Background analysis completed, reloading AI suggestions...');
    if (window.prManager && typeof window.prManager.loadAISuggestions === 'function') {
      window.prManager.loadAISuggestions()
        .then(() => {
          console.log('AI suggestions reloaded successfully after background analysis');
          // Auto-hide after suggestions have loaded successfully (shorter delay)
          setTimeout(() => {
            this.hide();
          }, 3000);
        })
        .catch(error => {
          console.error('Error reloading AI suggestions after background analysis:', error);
          // Auto-hide with longer delay if loading failed
          setTimeout(() => {
            this.hide();
          }, 7000);
        });
    } else {
      console.warn('PRManager not available for automatic suggestion reload after background analysis');
      // Auto-hide after 5 seconds if no PR manager available
      setTimeout(() => {
        this.hide();
      }, 5000);
    }
  }

  /**
   * Show error state
   * @param {string} message - Error message
   */
  showError(message = 'Analysis failed') {
    this.updateText(message);
    this.showErrorIcon();
    this.stopDotsAnimation();
    
    // Auto-hide after 10 seconds
    setTimeout(() => {
      this.hide();
    }, 10000);
  }

  /**
   * Show spinner icon
   */
  showSpinner() {
    const statusIcon = this.indicator?.querySelector('.status-icon');
    if (statusIcon) {
      statusIcon.innerHTML = `
        <svg class="spinner" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0a8 8 0 0 0-8 8h2a6 6 0 0 1 6-6V0z"/>
        </svg>
      `;
      statusIcon.className = 'status-icon spinning';
    }
  }

  /**
   * Show checkmark icon
   */
  showCheckmark() {
    const statusIcon = this.indicator?.querySelector('.status-icon');
    if (statusIcon) {
      statusIcon.innerHTML = window.Icons.icon('check', { width: 14, height: 14, className: 'checkmark' });
      statusIcon.className = 'status-icon success';
    }
  }

  /**
   * Show error icon
   */
  showErrorIcon() {
    const statusIcon = this.indicator?.querySelector('.status-icon');
    if (statusIcon) {
      statusIcon.innerHTML = window.Icons.icon('errorCircle', { width: 14, height: 14, className: 'error-icon' });
      statusIcon.className = 'status-icon error';
    }
  }

  /**
   * Start animated dots
   */
  startDotsAnimation() {
    this.stopDotsAnimation(); // Clear any existing interval
    
    this.dotsInterval = setInterval(() => {
      const dotsElement = this.indicator?.querySelector('.status-dots');
      if (!dotsElement) return;
      
      this.animationDots = (this.animationDots + 1) % 4;
      dotsElement.textContent = '.'.repeat(this.animationDots);
    }, 500);
  }

  /**
   * Stop animated dots
   */
  stopDotsAnimation() {
    if (this.dotsInterval) {
      clearInterval(this.dotsInterval);
      this.dotsInterval = null;
    }
    
    const dotsElement = this.indicator?.querySelector('.status-dots');
    if (dotsElement) {
      dotsElement.textContent = '';
    }
  }

  /**
   * Reopen modal from status indicator
   */
  reopenModal() {
    if (this.currentAnalysisId && window.councilProgressModal) {
      window.councilProgressModal.reopenFromBackground();
    }
  }

  /**
   * Ensure indicator is properly positioned in header
   */
  repositionInHeader() {
    // This method can be called after the header is re-rendered
    // to ensure the indicator is in the correct position
    const prActions = document.querySelector('.pr-actions');
    const existingIndicator = document.getElementById('status-indicator');
    
    if (prActions && existingIndicator && !prActions.contains(existingIndicator)) {
      // Move the indicator to the correct position
      const firstButton = prActions.querySelector('button');
      if (firstButton) {
        prActions.insertBefore(existingIndicator, firstButton);
      } else {
        prActions.appendChild(existingIndicator);
      }
    }
  }
}

// Initialize global instance
window.statusIndicator = new StatusIndicator();