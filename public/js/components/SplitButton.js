/**
 * Split Button Component
 * A button with a main action area and a dropdown menu for additional actions
 */
class SplitButton {
  constructor(options = {}) {
    this.container = null;
    this.dropdown = null;
    this.isOpen = false;
    this.commentCount = 0;
    this.defaultAction = options.defaultAction || 'submit'; // 'submit' or 'preview'
    this.onSubmit = options.onSubmit || (() => {});
    this.onPreview = options.onPreview || (() => {});
    this.onClear = options.onClear || (() => {});
    this.onSetDefault = options.onSetDefault || (() => {});

    // Bind methods
    this.handleMainClick = this.handleMainClick.bind(this);
    this.handleDropdownClick = this.handleDropdownClick.bind(this);
    this.handleOutsideClick = this.handleOutsideClick.bind(this);
    this.handleMenuItemClick = this.handleMenuItemClick.bind(this);
  }

  /**
   * Create and return the split button element
   * @returns {HTMLElement} The split button container element
   */
  render() {
    // Create container
    this.container = document.createElement('div');
    this.container.className = 'split-button-container';
    this.container.id = 'comment-split-button';

    // Create main button
    const mainButton = document.createElement('button');
    mainButton.className = 'split-button-main';
    mainButton.id = 'split-button-main';
    mainButton.type = 'button';
    mainButton.addEventListener('click', this.handleMainClick);

    // Create button text span
    const buttonText = document.createElement('span');
    buttonText.className = 'split-button-text';
    buttonText.id = 'split-button-text';
    buttonText.textContent = this.getButtonText();
    mainButton.appendChild(buttonText);

    // Create dropdown toggle button
    const dropdownToggle = document.createElement('button');
    dropdownToggle.className = 'split-button-dropdown-toggle';
    dropdownToggle.id = 'split-button-dropdown-toggle';
    dropdownToggle.type = 'button';
    dropdownToggle.setAttribute('aria-label', 'Open comment actions menu');
    dropdownToggle.setAttribute('aria-haspopup', 'true');
    dropdownToggle.setAttribute('aria-expanded', 'false');
    dropdownToggle.addEventListener('click', this.handleDropdownClick);

    // Add dropdown arrow icon
    dropdownToggle.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"/>
      </svg>
    `;

    // Create dropdown menu
    this.dropdown = document.createElement('div');
    this.dropdown.className = 'split-button-dropdown';
    this.dropdown.id = 'split-button-dropdown';
    this.dropdown.setAttribute('role', 'menu');
    this.dropdown.style.display = 'none';

    this.updateDropdownMenu();

    // Assemble the split button
    this.container.appendChild(mainButton);
    this.container.appendChild(dropdownToggle);
    this.container.appendChild(this.dropdown);

    return this.container;
  }

  /**
   * Update the dropdown menu items based on current state
   */
  updateDropdownMenu() {
    if (!this.dropdown) return;

    const isSubmitDefault = this.defaultAction === 'submit';

    this.dropdown.innerHTML = `
      <button class="split-button-menu-item" data-action="submit" role="menuitem">
        <span class="menu-item-check">${isSubmitDefault ? '&#10003;' : ''}</span>
        <span class="menu-item-text">Submit Review</span>
      </button>
      <button class="split-button-menu-item" data-action="preview" role="menuitem">
        <span class="menu-item-check">${!isSubmitDefault ? '&#10003;' : ''}</span>
        <span class="menu-item-text">Preview</span>
      </button>
      <div class="split-button-menu-separator"></div>
      <button class="split-button-menu-item split-button-menu-item-danger" data-action="clear" role="menuitem" ${this.commentCount === 0 ? 'disabled' : ''}>
        <span class="menu-item-check"></span>
        <span class="menu-item-text">Clear All</span>
      </button>
    `;

    // Add click handlers to menu items
    this.dropdown.querySelectorAll('.split-button-menu-item').forEach(item => {
      item.addEventListener('click', this.handleMenuItemClick);
    });
  }

  /**
   * Handle click on the main button area
   */
  handleMainClick() {
    if (this.defaultAction === 'submit') {
      this.onSubmit();
    } else {
      this.onPreview();
    }
  }

  /**
   * Handle click on the dropdown toggle
   * @param {Event} event - Click event
   */
  handleDropdownClick(event) {
    event.stopPropagation();
    this.toggleDropdown();
  }

  /**
   * Handle click on a menu item
   * @param {Event} event - Click event
   */
  handleMenuItemClick(event) {
    const button = event.currentTarget;
    if (button.disabled) return;

    const action = button.dataset.action;

    switch (action) {
      case 'submit':
        if (this.defaultAction !== 'submit') {
          this.setDefaultAction('submit');
        }
        this.onSubmit();
        break;
      case 'preview':
        if (this.defaultAction !== 'preview') {
          this.setDefaultAction('preview');
        }
        this.onPreview();
        break;
      case 'clear':
        this.onClear();
        break;
    }

    this.closeDropdown();
  }

  /**
   * Toggle dropdown open/close state
   */
  toggleDropdown() {
    if (this.isOpen) {
      this.closeDropdown();
    } else {
      this.openDropdown();
    }
  }

  /**
   * Open the dropdown menu
   */
  openDropdown() {
    if (!this.dropdown) return;

    this.isOpen = true;
    this.dropdown.style.display = 'block';

    const toggleButton = this.container?.querySelector('#split-button-dropdown-toggle');
    if (toggleButton) {
      toggleButton.setAttribute('aria-expanded', 'true');
    }

    this.container?.classList.add('split-button-open');

    // Add outside click listener
    setTimeout(() => {
      document.addEventListener('click', this.handleOutsideClick);
    }, 0);
  }

  /**
   * Close the dropdown menu
   */
  closeDropdown() {
    if (!this.dropdown) return;

    this.isOpen = false;
    this.dropdown.style.display = 'none';

    const toggleButton = this.container?.querySelector('#split-button-dropdown-toggle');
    if (toggleButton) {
      toggleButton.setAttribute('aria-expanded', 'false');
    }

    this.container?.classList.remove('split-button-open');

    // Remove outside click listener
    document.removeEventListener('click', this.handleOutsideClick);
  }

  /**
   * Handle clicks outside the dropdown to close it
   * @param {Event} event - Click event
   */
  handleOutsideClick(event) {
    if (this.container && !this.container.contains(event.target)) {
      this.closeDropdown();
    }
  }

  /**
   * Set the default action for the main button
   * @param {string} action - 'submit' or 'preview'
   */
  setDefaultAction(action) {
    if (action !== 'submit' && action !== 'preview') return;

    this.defaultAction = action;
    this.updateDropdownMenu();
    this.updateButtonText();
    this.onSetDefault(action);
  }

  /**
   * Get the button text based on default action and comment count
   * @returns {string} Button text
   */
  getButtonText() {
    const actionText = this.defaultAction === 'submit' ? 'Submit Review' : 'Preview';
    if (this.commentCount > 0) {
      return `${actionText} (${this.commentCount})`;
    }
    return actionText;
  }

  /**
   * Update the button text display
   */
  updateButtonText() {
    const textSpan = this.container?.querySelector('#split-button-text');
    if (textSpan) {
      textSpan.textContent = this.getButtonText();
    }
  }

  /**
   * Update the comment count display
   * @param {number} count - Number of comments
   */
  updateCommentCount(count) {
    this.commentCount = count;
    this.updateButtonText();

    // Update button styling based on count
    const mainButton = this.container?.querySelector('#split-button-main');
    const dropdownToggle = this.container?.querySelector('#split-button-dropdown-toggle');

    if (mainButton) {
      if (count > 0) {
        mainButton.classList.add('has-comments');
      } else {
        mainButton.classList.remove('has-comments');
      }
    }

    if (dropdownToggle) {
      if (count > 0) {
        dropdownToggle.classList.add('has-comments');
      } else {
        dropdownToggle.classList.remove('has-comments');
      }
    }

    // Update the Clear All menu item disabled state
    this.updateDropdownMenu();
  }

  /**
   * Get the current comment count
   * @returns {number} Current comment count
   */
  getCommentCount() {
    return this.commentCount;
  }

  /**
   * Destroy the component and clean up event listeners
   */
  destroy() {
    document.removeEventListener('click', this.handleOutsideClick);

    if (this.container) {
      this.container.remove();
      this.container = null;
    }

    this.dropdown = null;
  }
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.SplitButton = SplitButton;
}
