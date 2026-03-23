// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Generic Confirmation Dialog Component
 * Displays a confirmation dialog with customizable message and actions
 */
class ConfirmDialog {
  constructor() {
    this.modal = null;
    this.isVisible = false;
    this.onConfirm = null;
    this.onSecondary = null;
    this.onCancel = null;
    this.escapeHandler = null;
    this.createModal();
    this.setupEventListeners();
  }

  /**
   * Create the modal DOM structure
   */
  createModal() {
    // Remove existing modal if it exists
    const existing = document.getElementById('confirm-dialog');
    if (existing) {
      existing.remove();
    }

    // Create modal container
    const modalContainer = document.createElement('div');
    modalContainer.id = 'confirm-dialog';
    modalContainer.className = 'modal-overlay confirm-dialog-overlay';
    modalContainer.style.display = 'none';

    modalContainer.innerHTML = `
      <div class="modal-backdrop" data-action="cancel"></div>
      <div class="modal-container confirm-dialog-container" style="width: 400px; height: auto;">
        <div class="modal-header">
          <h3 id="confirm-dialog-title">Confirm Action</h3>
          <button class="modal-close-btn" data-action="cancel" title="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <p id="confirm-dialog-message"></p>
        </div>

        <div class="modal-footer">
          <button class="btn btn-secondary" data-action="cancel">Cancel</button>
          <button class="btn btn-secondary" id="confirm-dialog-secondary-btn" data-action="secondary" style="display: none;">
            Secondary
          </button>
          <button class="btn btn-danger" id="confirm-dialog-btn" data-action="confirm">
            Confirm
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modalContainer);
    this.modal = modalContainer;
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Use event delegation for click events
    this.modal.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'confirm') {
        this.handleConfirm();
      } else if (action === 'secondary') {
        this.handleSecondary();
      } else if (action === 'cancel') {
        this.handleCancel();
      }
    });

    // Handle keyboard shortcuts with a stored reference for cleanup
    this.keyHandler = (e) => {
      if (!this.isVisible) return;

      if (e.key === 'Escape') {
        this.handleCancel();
      } else if (e.key === 'Enter') {
        // Only trigger if confirm button exists and is enabled, and not in a textarea
        const confirmBtn = this.dialogElement?.querySelector('.confirm-btn') ||
                           this.modal?.querySelector('#confirm-dialog-btn');
        if (confirmBtn && !confirmBtn.disabled && window.getComputedStyle(confirmBtn).display !== 'none') {
          // Don't intercept Enter in textareas or input fields
          if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
          e.preventDefault();
          this.handleConfirm();
        }
      }
    };
    document.addEventListener('keydown', this.keyHandler);

    // Keep escapeHandler reference for backward compatibility
    this.escapeHandler = this.keyHandler;
  }

  /**
   * Show the confirmation dialog
   * @param {Object} options - Configuration options
   * @param {string} options.title - Dialog title
   * @param {string} options.message - Dialog message
   * @param {string} options.confirmText - Confirm button text (default: "Confirm")
   * @param {string} options.confirmClass - Confirm button class (default: "btn-danger")
   * @param {string} options.secondaryText - Secondary button text (optional - if provided, shows 3rd button)
   * @param {string} options.secondaryClass - Secondary button class (default: "btn-secondary")
   * @param {Function} options.onConfirm - Callback when confirmed
   * @param {Function} options.onSecondary - Callback when secondary clicked (optional)
   * @param {Function} options.onCancel - Callback when cancelled (optional)
   * @returns {Promise<string>} Promise that resolves to 'confirm', 'secondary', or 'cancel'
   */
  show(options = {}) {
    if (!this.modal) return Promise.resolve('cancel');

    return new Promise((resolve) => {
      // Set title
      const titleElement = this.modal.querySelector('#confirm-dialog-title');
      if (titleElement) {
        titleElement.textContent = options.title || 'Confirm Action';
      }

      // Set message
      const messageElement = this.modal.querySelector('#confirm-dialog-message');
      if (messageElement) {
        messageElement.textContent = options.message || 'Are you sure?';
      }

      // Helper: set button label + optional description subtitle
      const setBtnContent = (btn, label, description) => {
        if (!btn) return;
        if (description) {
          btn.innerHTML = `<span class="btn-label">${label}</span><span class="btn-desc">${description}</span>`;
        } else {
          btn.textContent = label;
        }
      };

      // Set confirm button text and style
      const confirmBtn = this.modal.querySelector('#confirm-dialog-btn');
      if (confirmBtn) {
        setBtnContent(confirmBtn, options.confirmText || 'Confirm', options.confirmDesc);
        // Remove previous style classes and add new one
        confirmBtn.classList.remove('btn-primary', 'btn-secondary', 'btn-danger', 'btn-warning');
        const confirmClass = options.confirmClass || 'btn-danger';
        confirmBtn.classList.add(confirmClass);
      }

      // Set secondary button (optional 3rd button)
      const secondaryBtn = this.modal.querySelector('#confirm-dialog-secondary-btn');
      const container = this.modal.querySelector('.confirm-dialog-container');
      if (secondaryBtn) {
        if (options.secondaryText) {
          setBtnContent(secondaryBtn, options.secondaryText, options.secondaryDesc);
          secondaryBtn.style.display = '';
          // Remove previous style classes and add new one
          secondaryBtn.classList.remove('btn-primary', 'btn-secondary', 'btn-danger', 'btn-warning');
          const secondaryClass = options.secondaryClass || 'btn-secondary';
          secondaryBtn.classList.add(secondaryClass);
          if (container) container.classList.add('has-secondary');
        } else {
          secondaryBtn.style.display = 'none';
          if (container) container.classList.remove('has-secondary');
        }
      }

      // Set cancel button text (optional)
      const cancelBtn = this.modal.querySelector('.modal-footer [data-action="cancel"]');
      if (cancelBtn) {
        setBtnContent(cancelBtn, options.cancelText || 'Cancel', options.cancelDesc);
      }

      // Store callbacks with promise resolution
      this.onConfirm = () => {
        if (options.onConfirm) {
          options.onConfirm();
        }
        resolve('confirm');
      };

      this.onSecondary = () => {
        if (options.onSecondary) {
          options.onSecondary();
        }
        resolve('secondary');
      };

      this.onCancel = () => {
        if (options.onCancel) {
          options.onCancel();
        }
        resolve('cancel');
      };

      // Show modal
      this.modal.style.display = 'flex';
      this.isVisible = true;
    });
  }

  /**
   * Handle confirm action
   */
  handleConfirm() {
    if (this.onConfirm) {
      this.onConfirm();
    }
    this.hide();
  }

  /**
   * Handle secondary action
   */
  handleSecondary() {
    if (this.onSecondary) {
      this.onSecondary();
    }
    this.hide();
  }

  /**
   * Handle cancel action
   */
  handleCancel() {
    if (this.onCancel) {
      this.onCancel();
    }
    this.hide();
  }

  /**
   * Hide the modal
   */
  hide() {
    if (!this.modal) return;

    this.modal.style.display = 'none';
    this.isVisible = false;
    this.onConfirm = null;
    this.onSecondary = null;
    this.onCancel = null;
  }
}

// Initialize global instance
if (typeof window !== 'undefined' && !window.confirmDialog) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.confirmDialog = new ConfirmDialog();
    });
  } else {
    window.confirmDialog = new ConfirmDialog();
  }
}
