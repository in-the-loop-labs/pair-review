/**
 * Toast Notification Component
 * Shows temporary success/error messages at the top of the page
 */
class Toast {
  constructor() {
    this.toastContainer = null;
    this.activeToasts = [];
    this.createContainer();
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
   * Show a toast element
   * @param {HTMLElement} toast - The toast element
   * @param {number} duration - Duration in ms
   */
  showToast(toast, duration) {
    // Add to container
    this.toastContainer.appendChild(toast);
    this.activeToasts.push(toast);

    // Trigger entrance animation
    setTimeout(() => {
      toast.classList.add('toast-show');
    }, 10);

    // Auto dismiss after duration
    setTimeout(() => {
      this.dismissToast(toast);
    }, duration);
  }

  /**
   * Dismiss a specific toast
   * @param {HTMLElement} toast - The toast element to dismiss
   */
  dismissToast(toast) {
    if (!toast || !toast.parentNode) return;

    // Add fade-out class
    toast.classList.add('toast-fade-out');

    // Remove after fade animation (300ms)
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
      
      // Remove from active toasts array
      const index = this.activeToasts.indexOf(toast);
      if (index > -1) {
        this.activeToasts.splice(index, 1);
      }
    }, 300);
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