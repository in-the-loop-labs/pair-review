// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Toast Notification Component
 * Shows temporary success/error/warning/info messages at the top of the page.
 * Each toast closes on its timer, or at once when the user clicks its close button.
 */
class Toast {
  // Length of the fade-out animation before the toast node is removed
  static FADE_MS = 300;

  constructor() {
    this.toastContainer = null;
    this.activeToasts = [];
    this.createContainer();

    // Convenience aliases — matches the conventional toast API (toast.error(), toast.success(), etc.)
    this.error = this.showError.bind(this);
    this.success = this.showSuccess.bind(this);
    this.warning = this.showWarning.bind(this);
    this.info = this.showInfo.bind(this);
  }

  /**
   * Create the toast container
   */
  createContainer() {
    // Remove existing container if it exists
    const existing = document.getElementById('toast-container');
    if (existing) {
      existing.remove();
    }

    const container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
    this.toastContainer = container;
  }

  /**
   * Show a success toast
   * @param {string} message - The message to display
   * @param {Object} options - Options object
   * @param {string} options.link - Optional link URL
   * @param {string} options.linkText - Optional link text
   * @param {number} options.duration - Duration in ms (default: 5000)
   */
  showSuccess(message, options = {}) {
    const { link, linkText = 'View on GitHub', duration = 5000 } = options;
    
    const toast = document.createElement('div');
    toast.className = 'toast toast-success';
    
    let content = `
      <div class="toast-content">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="toast-icon">
          <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path>
        </svg>
        <span class="toast-message">${message}</span>
    `;
    
    if (link) {
      content += `<a href="${link}" target="_blank" class="toast-link">${linkText}</a>`;
    }
    
    content += `</div>`;
    
    toast.innerHTML = content;
    this.showToast(toast, duration);
  }

  /**
   * Show an error toast
   * @param {string} message - The message to display
   * @param {number} duration - Duration in ms (default: 5000)
   */
  showError(message, duration = 5000) {
    const toast = document.createElement('div');
    toast.className = 'toast toast-error';

    toast.innerHTML = `
      <div class="toast-content">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="toast-icon">
          <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.326-2.74a.75.75 0 0 1 1.06-.08L8 6.94l1.114-1.76a.75.75 0 1 1 1.272.8L9.114 7.5l1.272 1.46a.75.75 0 1 1-1.272.8L8 8.06 6.886 9.76a.75.75 0 1 1-1.272-.8L6.886 7.5 5.614 6.04a.75.75 0 0 1 .08-1.06Z"></path>
        </svg>
        <span class="toast-message">${message}</span>
      </div>
    `;

    this.showToast(toast, duration);
  }

  /**
   * Show a warning toast
   * @param {string} message - The message to display
   * @param {number} duration - Duration in ms (default: 5000)
   */
  showWarning(message, duration = 5000) {
    const toast = document.createElement('div');
    toast.className = 'toast toast-warning';

    toast.innerHTML = `
      <div class="toast-content">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="toast-icon">
          <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path>
        </svg>
        <span class="toast-message">${message}</span>
      </div>
    `;

    this.showToast(toast, duration);
  }

  /**
   * Show an info toast
   * @param {string} message - The message to display
   * @param {number} duration - Duration in ms (default: 5000)
   */
  showInfo(message, duration = 5000) {
    const toast = document.createElement('div');
    toast.className = 'toast toast-info';

    toast.innerHTML = `
      <div class="toast-content">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="toast-icon">
          <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path>
        </svg>
        <span class="toast-message">${message}</span>
      </div>
    `;

    this.showToast(toast, duration);
  }

  /**
   * Show a toast element
   * @param {HTMLElement} toast - The toast element
   * @param {number} duration - Duration in ms
   */
  showToast(toast, duration) {
    this.addCloseButton(toast);

    // Add to container
    this.toastContainer.appendChild(toast);
    this.activeToasts.push(toast);

    // Trigger entrance animation
    setTimeout(() => {
      toast.classList.add('toast-show');
    }, 10);

    // Auto dismiss after duration
    toast._dismissTimer = setTimeout(() => {
      this.dismissToast(toast);
    }, duration);
  }

  /**
   * Append a close button to the toast's content row
   * @param {HTMLElement} toast - The toast element
   */
  addCloseButton(toast) {
    const content = toast.querySelector('.toast-content');
    if (!content || content.querySelector('.toast-close')) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-close';
    button.setAttribute('aria-label', 'Dismiss notification');
    button.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"></path>
      </svg>
    `;
    button.addEventListener('click', () => this.dismissToast(toast));
    content.appendChild(button);
  }

  /**
   * Dismiss a specific toast
   * @param {HTMLElement} toast - The toast element to dismiss
   */
  dismissToast(toast) {
    if (!toast || !toast.parentNode) return;
    if (toast.classList.contains('toast-fade-out')) return;

    clearTimeout(toast._dismissTimer);

    // Add fade-out class
    toast.classList.add('toast-fade-out');

    // Remove after fade animation
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
      
      // Remove from active toasts array
      const index = this.activeToasts.indexOf(toast);
      if (index > -1) {
        this.activeToasts.splice(index, 1);
      }
    }, Toast.FADE_MS);
  }

  /**
   * Clear all active toasts
   */
  clearAll() {
    this.activeToasts.forEach(toast => this.dismissToast(toast));
  }
}

// Create global toast instance
if (typeof window !== 'undefined' && !window.toast) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.toast = new Toast();
    });
  } else {
    window.toast = new Toast();
  }
}

// Export for CommonJS testing environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Toast };
}