// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Generic Text Input Dialog Component
 * Displays a modal dialog with a text input field and customizable actions.
 * Returns a Promise that resolves to the trimmed input string, or null if cancelled.
 */
class TextInputDialog {
  constructor() {
    this.modal = null;
    this.isVisible = false;
    this.resolvePromise = null;
    this.createModal();
    this.setupEventListeners();
  }

  /**
   * Create the modal DOM structure
   */
  createModal() {
    // Remove existing modal if it exists
    const existing = document.getElementById('text-input-dialog');
    if (existing) {
      existing.remove();
    }

    // Create modal container
    const modalContainer = document.createElement('div');
    modalContainer.id = 'text-input-dialog';
    modalContainer.className = 'modal-overlay';
    modalContainer.style.display = 'none';

    modalContainer.innerHTML = `
      <div class="modal-backdrop" data-action="cancel"></div>
      <div class="modal-container confirm-dialog-container" style="width: 400px; height: auto;">
        <div class="modal-header">
          <h3 id="text-input-dialog-title">Input</h3>
          <button class="modal-close-btn" data-action="cancel" title="Close">
            ${window.Icons.icon('close')}
          </button>
        </div>

        <div class="modal-body">
          <div class="text-input-dialog-field">
            <label for="text-input-dialog-input" id="text-input-dialog-label"></label>
            <input type="text" id="text-input-dialog-input" class="form-control" placeholder="" />
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn btn-secondary" data-action="cancel">Cancel</button>
          <button class="btn btn-primary" id="text-input-dialog-btn" data-action="confirm">
            Save
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
      } else if (action === 'cancel') {
        this.handleCancel();
      }
    });

    // Handle keyboard shortcuts
    this.keyHandler = (e) => {
      if (!this.isVisible) return;
      // Don't intercept keys when another dialog is on top
      if (window.confirmDialog?.isVisible) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        this.handleCancel();
      } else if (e.key === 'Enter') {
        const input = this.modal.querySelector('#text-input-dialog-input');
        if (input && input.value.trim()) {
          e.preventDefault();
          this.handleConfirm();
        }
      }
    };
    document.addEventListener('keydown', this.keyHandler);

    // Listen for input changes to enable/disable confirm button
    const input = this.modal.querySelector('#text-input-dialog-input');
    if (input) {
      input.addEventListener('input', () => {
        this._updateConfirmButton(input.value);
      });
    }
  }

  /**
   * Update the confirm button enabled/disabled state based on input value
   * @param {string} value - Current input value
   */
  _updateConfirmButton(value) {
    const confirmBtn = this.modal.querySelector('#text-input-dialog-btn');
    if (confirmBtn) {
      confirmBtn.disabled = !value.trim();
    }
  }

  /**
   * Show the text input dialog
   * @param {Object} options - Configuration options
   * @param {string} options.title - Dialog title (default: "Input")
   * @param {string} options.label - Label text above the input (default: "")
   * @param {string} options.placeholder - Input placeholder text (default: "")
   * @param {string} options.value - Initial input value (default: "")
   * @param {string} options.confirmText - Confirm button text (default: "Save")
   * @param {string} options.confirmClass - Confirm button CSS class (default: "btn-primary")
   * @returns {Promise<string|null>} Promise that resolves to trimmed input string, or null if cancelled
   */
  show(options = {}) {
    if (!this.modal) return Promise.resolve(null);

    return new Promise((resolve) => {
      // Cancel any previous caller's promise to prevent dangling awaits
      if (this.resolvePromise) {
        this.resolvePromise(null);
      }
      this.resolvePromise = resolve;

      // Set title
      const titleElement = this.modal.querySelector('#text-input-dialog-title');
      if (titleElement) {
        titleElement.textContent = options.title || 'Input';
      }

      // Set label
      const labelElement = this.modal.querySelector('#text-input-dialog-label');
      if (labelElement) {
        const labelText = options.label || '';
        labelElement.textContent = labelText;
        labelElement.style.display = labelText ? '' : 'none';
      }

      // Set input value and placeholder
      const input = this.modal.querySelector('#text-input-dialog-input');
      if (input) {
        input.value = options.value || '';
        input.placeholder = options.placeholder || '';
      }

      // Set confirm button text and style
      const confirmBtn = this.modal.querySelector('#text-input-dialog-btn');
      if (confirmBtn) {
        confirmBtn.textContent = options.confirmText || 'Save';
        // Remove previous style classes and add new one
        confirmBtn.classList.remove('btn-primary', 'btn-secondary', 'btn-danger', 'btn-warning');
        const confirmClass = options.confirmClass || 'btn-primary';
        confirmBtn.classList.add(confirmClass);
      }

      // Update confirm button state based on initial value
      this._updateConfirmButton(options.value || '');

      // Show modal
      this.modal.style.display = 'flex';
      this.isVisible = true;

      // Focus and select all text in input
      if (input) {
        requestAnimationFrame(() => {
          input.focus();
          input.select();
        });
      }
    });
  }

  /**
   * Handle confirm action
   */
  handleConfirm() {
    const input = this.modal.querySelector('#text-input-dialog-input');
    const value = input ? input.value.trim() : '';
    if (!value) return;

    if (this.resolvePromise) {
      this.resolvePromise(value);
    }
    this.hide();
  }

  /**
   * Handle cancel action
   */
  handleCancel() {
    if (this.resolvePromise) {
      this.resolvePromise(null);
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
    this.resolvePromise = null;
  }
}

// Initialize global instance
if (typeof window !== 'undefined' && !window.textInputDialog) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.textInputDialog = new TextInputDialog();
    });
  } else {
    window.textInputDialog = new TextInputDialog();
  }
}
