// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Split Button Component
 * A button with a main action area and a dropdown menu for additional actions
 */
class SplitButton {
  // localStorage key for persisting default action preference
  static STORAGE_KEY = 'pair-review-split-button-default-action';

  constructor(options = {}) {
    this.container = null;
    this.dropdown = null;
    this.isOpen = false;
    this.commentCount = 0;
    // Hide submit unless the active manager advertises canSubmitToGitHub.
    // This replaces the previous `window.PAIR_REVIEW_LOCAL_MODE` mode-sniff
    // so local mode with an associated PR (Phase 5) can flip the flag on
    // without SplitButton needing to know which manager owns the page.
    //
    // Guarded: when PRManager isn't ready yet (early construction), we
    // fall back to `options.hideSubmit` and the legacy flag so existing
    // behavior is preserved. `_canSubmitToGitHub` collapses that into a
    // single source the rest of the file consults.
    const managerSaysCanSubmit = typeof window !== 'undefined'
      && window.prManager
      && typeof window.prManager.hasCapability === 'function'
      ? window.prManager.hasCapability('canSubmitToGitHub')
      : null;
    const legacyLocalMode = window.PAIR_REVIEW_LOCAL_MODE === true;
    const canSubmit = managerSaysCanSubmit !== null
      ? managerSaysCanSubmit
      : !legacyLocalMode;
    // Kept separate from `hideSubmit` so `setCanSubmit` can re-derive the
    // latter without ever un-hiding a button the CALLER asked to hide. The
    // capability is a fact about the review; this is the caller's veto, and a
    // late capability flip must not overrule it.
    this.forcedHideSubmit = options.hideSubmit === true;
    this.hideSubmit = !canSubmit || this.forcedHideSubmit;
    // Set only while the menu is open and a flip arrived — see `setCanSubmit`.
    this._pendingHideSubmit = null;

    // Determine default action: when submit is hidden, fall back to
    // preview. Otherwise honor saved preference or caller default.
    if (this.hideSubmit) {
      this.defaultAction = 'preview';
    } else {
      const savedAction = this.loadSavedAction();
      this.defaultAction = savedAction || options.defaultAction || 'submit';
    }
    this.onSubmit = options.onSubmit || (() => {});
    this.onPreview = options.onPreview || (() => {});
    this.onClear = options.onClear || (() => {});
    this.onShare = options.onShare || (() => {});
    this.onSetDefault = options.onSetDefault || (() => {});
    this.shareUrl = options.shareUrl || null;
    // Custom icon SVG, label, and description for share menu item
    this.shareIcon = options.shareIcon || null;
    this.shareLabel = options.shareLabel || 'Share';
    this.shareDescription = options.shareDescription || null;

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

    // Use event delegation for menu items - attach handler to dropdown container
    // This prevents issues when updateDropdownMenu() replaces innerHTML while dropdown is open
    this.dropdown.addEventListener('click', this.handleMenuItemClick);

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
    const isPreviewDefault = this.defaultAction === 'preview';

    // Build menu items - conditionally include Submit Review
    let menuItems = '';

    if (!this.hideSubmit) {
      menuItems += `
      <button class="split-button-menu-item" data-action="submit" role="menuitem">
        <span class="menu-item-check">${isSubmitDefault ? '&#10003;' : ''}</span>
        <span class="menu-item-text">Submit Review</span>
      </button>`;
    }

    menuItems += `
      <button class="split-button-menu-item" data-action="preview" role="menuitem">
        <span class="menu-item-check">${isPreviewDefault ? '&#10003;' : ''}</span>
        <span class="menu-item-text">Preview</span>
      </button>`;

    if (this.shareUrl) {
      // Icon renders on the right side of the label (unlike checkmarks which are on the left)
      const iconHtml = this.shareIcon
        ? `<span class="menu-item-icon">${this.shareIcon}</span>`
        : '';
      // Add title attribute for tooltip if description is provided
      const titleAttr = this.shareDescription
        ? ` title="${this.escapeHtml(this.shareDescription)}"`
        : '';
      menuItems += `
      <div class="split-button-menu-separator"></div>
      <button class="split-button-menu-item" data-action="share" role="menuitem"${titleAttr}>
        <span class="menu-item-check"></span>
        <span class="menu-item-text">${this.escapeHtml(this.shareLabel)}</span>
        ${iconHtml}
      </button>`;
    }

    menuItems += `
      <div class="split-button-menu-separator"></div>
      <button class="split-button-menu-item split-button-menu-item-danger" data-action="clear" role="menuitem" ${this.commentCount === 0 ? 'disabled' : ''}>
        <span class="menu-item-check"></span>
        <span class="menu-item-text">Clear All</span>
      </button>
    `;

    this.dropdown.innerHTML = menuItems;
    // Event delegation is used - handler attached to dropdown container in render()
  }

  /**
   * Release a capability answer parked by `setCanSubmit` BEFORE this click acts
   * on it, and report whether the action the user aimed at survived the flush.
   *
   * The deferral exists so an open menu never repaints under the pointer, and
   * `closeDropdown` was its only release point — but both dispatchers ran their
   * action FIRST and closed SECOND, so throughout that window `hideSubmit` was
   * still the answer the flip had already revoked. A `submit` click landing
   * there wrote `submit` to localStorage at the exact moment the capability was
   * gone (leaking a preference to every other review) and opened ReviewModal for
   * a session the backend would refuse.
   *
   * Flushing FIRST rather than special-casing `submit` at the call site is the
   * general fix: any future action a parked answer could revoke is re-validated
   * against the settled state below instead of against a stale field.
   *
   * Safe to call from inside a click handler — it cannot re-enter or tear down
   * the element whose handler is running:
   *   - `closeDropdown` dispatches no events; it flips flags, hides the
   *     dropdown, removes a document listener and calls `_applyHideSubmit`.
   *   - `_applyHideSubmit` refills `this.dropdown.innerHTML` and one text span.
   *     The dropdown NODE survives (menu items are delegated to it, see
   *     `render`), so the in-flight listener is still attached and the caller
   *     has already read everything it needs off the clicked row.
   *   - `_applyHideSubmit` clears `_pendingHideSubmit` before applying and is
   *     idempotent, so the trailing `closeDropdown()` re-applies nothing.
   *
   * @param {string} action - the action this click is about to run.
   * @returns {boolean} false when the click must be swallowed.
   */
  _settleBeforeAction(action) {
    if (this._pendingHideSubmit !== null) {
      this.closeDropdown();
    }

    // Re-validated against the SETTLED state, which also covers a stale menu
    // row that somehow outlived a hide.
    if (action === 'submit' && this.hideSubmit) {
      // Idempotent, and the swallowing branch is the one that skips the
      // dispatcher's own trailing close — a menu left open over a row that no
      // longer exists would invite the same click again.
      this.closeDropdown();
      this._notifySubmitUnavailable();
      return false;
    }
    return true;
  }

  /**
   * Tell the user why their click did nothing. A control that silently ignores
   * a click reads as broken; the capability really did disappear out from under
   * them (an association cleared by a force-push, most often), and the menu row
   * they aimed at is already gone by the time this runs.
   *
   * Deliberately host- and mode-neutral wording: SplitButton is shared, and
   * asking the manager which mode it is would be the mode-sniff this component
   * was cleaned of.
   */
  _notifySubmitUnavailable() {
    if (typeof window === 'undefined') return;
    if (typeof window.toast?.showWarning === 'function') {
      window.toast.showWarning('Submit is no longer available for this review.');
    }
  }

  /**
   * Handle click on the main button area
   */
  handleMainClick() {
    // The main button stays clickable while the dropdown is open (the outside
    // click handler ignores anything inside the container), so this path needs
    // the same flush the menu rows get — otherwise a Submit-labelled main
    // button fires the action a parked answer already revoked.
    const aimedAt = this.defaultAction;
    if (!this._settleBeforeAction(aimedAt)) return;

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
   * Handle click on a menu item (via event delegation from dropdown container)
   * @param {Event} event - Click event
   */
  handleMenuItemClick(event) {
    // Find the menu item button from the click target (event delegation)
    const button = event.target.closest('.split-button-menu-item');
    if (!button || button.disabled) return;

    const action = button.dataset.action;

    // Flush before dispatching — see `_settleBeforeAction`. The old ordering
    // (act, then close) ran the action against the capability answer the flush
    // was holding, which is precisely the answer that revoked it.
    if (!this._settleBeforeAction(action)) return;

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
      case 'share':
        this.onShare();
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

    // Flush a capability flip that arrived while the menu was open — deferred
    // by `setCanSubmit` so the rows never moved under the pointer. This is the
    // ONLY place the deferral is released, so every close path (menu item,
    // outside click, toggle) has to funnel through here — they all do.
    if (this._pendingHideSubmit !== null) {
      this._applyHideSubmit(this._pendingHideSubmit);
    }
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

    // In local mode (hideSubmit), don't allow setting submit as default
    if (this.hideSubmit && action === 'submit') {
      action = 'preview';
    }

    this.defaultAction = action;
    this.updateDropdownMenu();
    this.updateButtonText();
    this.onSetDefault(action);

    // Persist to localStorage (only in PR mode where submit is available)
    if (!this.hideSubmit) {
      this.saveAction(action);
    }
  }

  /**
   * Mutate the Submit affordance in place after the capability that gates it
   * changed — the counterpart to reading it in the constructor.
   *
   * Why a mutator and not another `initSplitButton()`: the zero-argument
   * constructor path cannot carry state across a rebuild. `canSubmitToGitHub`
   * flips mid-session in local mode (the PR association resolves after the
   * page-load GET), and a rebuild re-ran `loadSavedAction()`, which promoted a
   * user with a stale saved `submit` preference — or none at all — from Preview
   * to Submit under their cursor, mid-click. It also destroyed an open dropdown
   * out from under the pointer.
   *
   * Two invariants, both about not surprising the user:
   *
   *   GAINING submit NEVER promotes it to the main action. The visible action
   *   is whatever it already was; the new capability only makes the menu item
   *   appear. Only a deliberate menu choice moves the primary action
   *   (`setDefaultAction`, which is also what persists the preference).
   *
   *   LOSING submit MUST demote it, because the action is no longer reachable
   *   — a Submit main button left behind POSTs a review to a PR this session
   *   is no longer tied to. That demotion is deliberately not persisted:
   *   `setDefaultAction` would overwrite a genuine `submit` preference that
   *   belongs to other reviews.
   *
   * @param {boolean} canSubmit - the manager's current `canSubmitToGitHub`
   */
  setCanSubmit(canSubmit) {
    const hideSubmit = !canSubmit || this.forcedHideSubmit;

    // While the menu is OPEN, replacing its items moves every row under the
    // pointer — the click that lands is not the one the user aimed at. Park
    // the answer and apply it on close; `closeDropdown` flushes it.
    //
    // Parking is NOT a licence for the next click to act on the OLD answer:
    // both dispatchers flush through `_settleBeforeAction` before they act, so
    // the window between parking and closing can no longer submit a review —
    // or persist a `submit` preference — that this flip just revoked.
    if (this.isOpen) {
      this._pendingHideSubmit = hideSubmit;
      return;
    }
    this._applyHideSubmit(hideSubmit);
  }

  /**
   * Apply a resolved `hideSubmit` answer to the rendered button. Idempotent —
   * an unchanged answer touches nothing, which is what lets every caller
   * invoke `setCanSubmit` unconditionally instead of tracking transitions.
   *
   * @param {boolean} hideSubmit
   */
  _applyHideSubmit(hideSubmit) {
    this._pendingHideSubmit = null;
    if (hideSubmit === this.hideSubmit) return;

    this.hideSubmit = hideSubmit;

    // Demote only. See `setCanSubmit` for why gaining the capability leaves
    // the visible action exactly where the user last left it.
    if (hideSubmit && this.defaultAction === 'submit') {
      this.defaultAction = 'preview';
    }

    this.updateDropdownMenu();
    this.updateButtonText();
  }

  /**
   * Load saved action preference from localStorage
   * @returns {string|null} Saved action or null if not found
   */
  loadSavedAction() {
    try {
      const saved = localStorage.getItem(SplitButton.STORAGE_KEY);
      if (saved === 'submit' || saved === 'preview') {
        return saved;
      }
    } catch {
      // localStorage may be unavailable (private browsing, etc.)
    }
    return null;
  }

  /**
   * Save action preference to localStorage
   * @param {string} action - 'submit' or 'preview'
   */
  saveAction(action) {
    try {
      localStorage.setItem(SplitButton.STORAGE_KEY, action);
    } catch {
      // localStorage may be unavailable (private browsing, etc.)
    }
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
   * Update the share configuration (URL, icon, label, description)
   * @param {Object|null} config - Share config with url, icon, label, description properties or null to hide
   */
  setShareConfig(config) {
    if (config && config.url) {
      this.shareUrl = config.url;
      this.shareIcon = config.icon || null;
      this.shareLabel = config.label || 'Share';
      this.shareDescription = config.description || null;
    } else {
      this.shareUrl = null;
      this.shareIcon = null;
      this.shareLabel = 'Share';
      this.shareDescription = null;
    }
    this.updateDropdownMenu();
  }

  /**
   * Escape HTML special characters to prevent XSS
   * @param {string} str - String to escape
   * @returns {string} Escaped string
   */
  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML.replace(/"/g, '&quot;');
  }

  /**
   * Destroy the component and clean up event listeners
   */
  destroy() {
    document.removeEventListener('click', this.handleOutsideClick);

    // Remove delegated event listener from dropdown
    if (this.dropdown) {
      this.dropdown.removeEventListener('click', this.handleMenuItemClick);
    }

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

// Export for Node.js/test environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SplitButton };
}
