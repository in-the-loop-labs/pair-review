// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Keyboard Shortcuts Manager
 * Provides chord detection (key sequences like 'c c' or 'c x') and a help overlay
 */
class KeyboardShortcuts {
  /**
   * @param {Object} options - Configuration options
   * @param {Function} options.onCopyComments - Callback for 'c c' (copy comments)
   * @param {Function} options.onClearComments - Callback for 'c x' (clear comments)
   */
  constructor(options = {}) {
    this.options = options;
    this.shortcuts = new Map();
    this.pendingKeys = [];
    this.chordTimeout = null;
    this.chordTimeoutMs = 500;
    this.helpOverlay = null;
    this.isHelpVisible = false;

    this.registerDefaultShortcuts();
    this.createHelpOverlay();
    this.setupEventListeners();
  }

  /**
   * Register the default shortcuts
   */
  registerDefaultShortcuts() {
    // Help overlay
    this.registerShortcut(['?'], 'Show keyboard shortcuts', () => {
      this.showHelp();
    });

    // Comment actions (chords)
    this.registerShortcut(['c', 'c'], 'Copy comments to clipboard', () => {
      if (this.options.onCopyComments) {
        this.options.onCopyComments();
      }
    });

    this.registerShortcut(['c', 'x'], 'Clear all comments', () => {
      if (this.options.onClearComments) {
        this.options.onClearComments();
      }
    });

    // Suggestion navigation
    this.registerShortcut(['j'], 'Next suggestion', () => {
      if (this.options.onNextSuggestion) {
        this.options.onNextSuggestion();
      }
    });

    this.registerShortcut(['k'], 'Previous suggestion', () => {
      if (this.options.onPrevSuggestion) {
        this.options.onPrevSuggestion();
      }
    });
  }

  /**
   * Register a keyboard shortcut
   * @param {string[]} keys - Array of keys in sequence (e.g., ['c', 'c'] or ['?'])
   * @param {string} description - Human-readable description for help overlay
   * @param {Function} callback - Function to execute when shortcut is triggered
   */
  registerShortcut(keys, description, callback) {
    if (!Array.isArray(keys) || keys.length === 0) {
      console.warn('KeyboardShortcuts: keys must be a non-empty array');
      return;
    }

    const keyString = keys.join(' ');
    this.shortcuts.set(keyString, {
      keys,
      description,
      callback
    });
  }

  /**
   * Unregister a keyboard shortcut
   * @param {string[]} keys - Array of keys in sequence
   */
  unregisterShortcut(keys) {
    const keyString = keys.join(' ');
    this.shortcuts.delete(keyString);
  }

  /**
   * Create the help overlay DOM structure
   */
  createHelpOverlay() {
    // Remove existing overlay if present
    const existing = document.getElementById('keyboard-shortcuts-help');
    if (existing) {
      existing.remove();
    }

    const overlay = document.createElement('div');
    overlay.id = 'keyboard-shortcuts-help';
    overlay.className = 'keyboard-shortcuts-overlay';
    overlay.style.display = 'none';

    overlay.innerHTML = `
      <div class="keyboard-shortcuts-backdrop" data-action="close"></div>
      <div class="keyboard-shortcuts-panel">
        <div class="keyboard-shortcuts-header">
          <h2>Keyboard Shortcuts</h2>
          <button class="keyboard-shortcuts-close" data-action="close" title="Close (Escape)">
            ${window.Icons.icon('close')}
          </button>
        </div>
        <div class="keyboard-shortcuts-body">
          <div class="keyboard-shortcuts-list">
            ${this.renderShortcutsList()}
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    this.helpOverlay = overlay;

    // Bind click handlers
    overlay.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'close') {
        this.hideHelp();
      }
    });
  }

  /**
   * Render the shortcuts list HTML
   * @returns {string} HTML string for shortcuts list
   */
  renderShortcutsList() {
    const groups = {
      navigation: { title: 'Navigation', shortcuts: [] },
      comments: { title: 'Comments', shortcuts: [] },
      panels: { title: 'Panels', shortcuts: [] },
      general: { title: 'General', shortcuts: [] }
    };

    // Categorize shortcuts
    for (const [keyString, shortcut] of this.shortcuts) {
      const { keys, description } = shortcut;
      const item = { keys, description };

      if (keys.includes('j') || keys.includes('k')) {
        groups.navigation.shortcuts.push(item);
      } else if (keys[0] === 'c') {
        groups.comments.shortcuts.push(item);
      } else if (keys[0] === 'p') {
        groups.panels.shortcuts.push(item);
      } else {
        groups.general.shortcuts.push(item);
      }
    }

    let html = '';

    for (const [groupKey, group] of Object.entries(groups)) {
      if (group.shortcuts.length === 0) continue;

      html += `
        <div class="keyboard-shortcuts-group">
          <h3 class="keyboard-shortcuts-group-title">${group.title}</h3>
          <div class="keyboard-shortcuts-items">
            ${group.shortcuts.map(shortcut => this.renderShortcutItem(shortcut)).join('')}
          </div>
        </div>
      `;
    }

    return html;
  }

  /**
   * Render a single shortcut item
   * @param {Object} shortcut - Shortcut object with keys and description
   * @returns {string} HTML string for shortcut item
   */
  renderShortcutItem(shortcut) {
    const keysHtml = shortcut.keys
      .map(key => `<kbd class="keyboard-shortcut-key">${this.escapeHtml(this.formatKey(key))}</kbd>`)
      .join('<span class="keyboard-shortcut-then">then</span>');

    return `
      <div class="keyboard-shortcut-item">
        <span class="keyboard-shortcut-keys">${keysHtml}</span>
        <span class="keyboard-shortcut-description">${this.escapeHtml(shortcut.description)}</span>
      </div>
    `;
  }

  /**
   * Format a key for display
   * @param {string} key - The key to format
   * @returns {string} Formatted key string
   */
  formatKey(key) {
    const keyMap = {
      '?': '?',
      'Escape': 'Esc',
      'ArrowUp': '\u2191',
      'ArrowDown': '\u2193',
      'ArrowLeft': '\u2190',
      'ArrowRight': '\u2192',
      'Enter': '\u21B5',
      ' ': 'Space'
    };
    return keyMap[key] || key.toUpperCase();
  }

  /**
   * Setup keyboard event listeners
   */
  setupEventListeners() {
    this.boundKeyHandler = (e) => this.handleKeyDown(e);
    document.addEventListener('keydown', this.boundKeyHandler);
  }

  /**
   * Handle keydown events
   * @param {KeyboardEvent} e - The keyboard event
   */
  handleKeyDown(e) {
    // Close help overlay on Escape
    if (e.key === 'Escape' && this.isHelpVisible) {
      e.preventDefault();
      this.hideHelp();
      return;
    }

    // Ignore shortcuts when in input fields
    if (this.isInInputField(e.target)) {
      this.resetChord();
      return;
    }

    // Ignore shortcuts when a modal is open (except our help overlay)
    if (this.isModalOpen()) {
      this.resetChord();
      return;
    }

    // Ignore shortcuts with modifier keys (except Shift for special chars like ?)
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }

    // Get the key, accounting for Shift
    const key = e.key;

    // Clear timeout and add key to pending sequence
    this.clearChordTimeout();
    this.pendingKeys.push(key);

    // Try to match shortcuts
    const matched = this.tryMatchShortcut();

    if (matched) {
      e.preventDefault();
      this.resetChord();
    } else if (this.hasPotentialMatch()) {
      // There's a potential match, wait for more keys
      e.preventDefault();
      this.startChordTimeout();
    } else {
      // No match possible, reset
      this.resetChord();
    }
  }

  /**
   * Check if the event target is an input field
   * @param {HTMLElement} target - The event target
   * @returns {boolean} True if target is an input field
   */
  isInInputField(target) {
    if (!target) return false;

    const tagName = target.tagName.toUpperCase();
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
      return true;
    }

    // Check for contenteditable
    if (target.isContentEditable || target.contentEditable === 'true') {
      return true;
    }

    return false;
  }

  /**
   * Check if a modal is currently open (excluding our help overlay)
   * @returns {boolean} True if a modal is open
   */
  isModalOpen() {
    // Check for common modal patterns in the codebase
    const modalSelectors = [
      '.modal-overlay:not(#keyboard-shortcuts-help)',
      '.review-modal-overlay',
      '.preview-modal-overlay',
      '.confirm-dialog-overlay',
      '.analysis-config-overlay',
      '.ai-summary-modal-overlay',
      '[role="dialog"]:not(#keyboard-shortcuts-help)'
    ];

    for (const selector of modalSelectors) {
      const modal = document.querySelector(selector);
      if (modal && this.isElementVisible(modal)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if an element is visible
   * @param {HTMLElement} element - The element to check
   * @returns {boolean} True if element is visible
   */
  isElementVisible(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }

    return true;
  }

  /**
   * Try to match the current key sequence against registered shortcuts
   * @returns {boolean} True if a shortcut was matched and executed
   */
  tryMatchShortcut() {
    const keyString = this.pendingKeys.join(' ');

    const shortcut = this.shortcuts.get(keyString);
    if (shortcut) {
      shortcut.callback();
      return true;
    }

    return false;
  }

  /**
   * Check if there's a potential match with more keys
   * @returns {boolean} True if a shortcut could match with more keys
   */
  hasPotentialMatch() {
    const prefix = this.pendingKeys.join(' ');

    for (const keyString of this.shortcuts.keys()) {
      if (keyString.startsWith(prefix + ' ')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Start the chord timeout
   */
  startChordTimeout() {
    this.chordTimeout = setTimeout(() => {
      this.resetChord();
    }, this.chordTimeoutMs);
  }

  /**
   * Clear the chord timeout
   */
  clearChordTimeout() {
    if (this.chordTimeout) {
      clearTimeout(this.chordTimeout);
      this.chordTimeout = null;
    }
  }

  /**
   * Reset the chord state
   */
  resetChord() {
    this.clearChordTimeout();
    this.pendingKeys = [];
  }

  /**
   * Show the help overlay
   */
  showHelp() {
    if (!this.helpOverlay || this.isHelpVisible) return;

    // Update the shortcuts list in case new shortcuts were registered
    const listContainer = this.helpOverlay.querySelector('.keyboard-shortcuts-list');
    if (listContainer) {
      listContainer.innerHTML = this.renderShortcutsList();
    }

    this.helpOverlay.style.display = 'flex';
    this.isHelpVisible = true;

    // Add animation class
    requestAnimationFrame(() => {
      this.helpOverlay.classList.add('keyboard-shortcuts-visible');
    });
  }

  /**
   * Hide the help overlay
   */
  hideHelp() {
    if (!this.helpOverlay || !this.isHelpVisible) return;

    this.helpOverlay.classList.remove('keyboard-shortcuts-visible');

    // Wait for animation to complete
    setTimeout(() => {
      this.helpOverlay.style.display = 'none';
      this.isHelpVisible = false;
    }, 150);
  }

  /**
   * Toggle the help overlay
   */
  toggleHelp() {
    if (this.isHelpVisible) {
      this.hideHelp();
    } else {
      this.showHelp();
    }
  }

  /**
   * Escape HTML special characters
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Destroy the keyboard shortcuts manager
   * Removes event listeners and DOM elements
   */
  destroy() {
    this.resetChord();

    // Remove the keydown event listener to prevent memory leaks
    if (this.boundKeyHandler) {
      document.removeEventListener('keydown', this.boundKeyHandler);
      this.boundKeyHandler = null;
    }

    if (this.helpOverlay) {
      this.helpOverlay.remove();
      this.helpOverlay = null;
    }

    this.shortcuts.clear();
  }
}

// Inject styles for the help overlay
(function injectKeyboardShortcutsStyles() {
  if (document.getElementById('keyboard-shortcuts-styles')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'keyboard-shortcuts-styles';
  style.textContent = `
    /* Keyboard Shortcuts Help Overlay */
    .keyboard-shortcuts-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 150ms ease-out;
    }

    .keyboard-shortcuts-overlay.keyboard-shortcuts-visible {
      opacity: 1;
    }

    .keyboard-shortcuts-backdrop {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      cursor: pointer;
    }

    .keyboard-shortcuts-panel {
      position: relative;
      width: 90%;
      max-width: 500px;
      max-height: 80vh;
      background: var(--color-bg-primary, #ffffff);
      border-radius: 12px;
      box-shadow: 0 16px 32px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transform: scale(0.95) translateY(10px);
      transition: transform 150ms ease-out;
    }

    .keyboard-shortcuts-overlay.keyboard-shortcuts-visible .keyboard-shortcuts-panel {
      transform: scale(1) translateY(0);
    }

    .keyboard-shortcuts-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--color-border-muted, #d0d7de);
    }

    .keyboard-shortcuts-header h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--color-fg-default, #1f2328);
    }

    .keyboard-shortcuts-close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      padding: 0;
      background: transparent;
      border: none;
      border-radius: 6px;
      color: var(--color-fg-muted, #656d76);
      cursor: pointer;
      transition: background-color 150ms ease, color 150ms ease;
    }

    .keyboard-shortcuts-close:hover {
      background: var(--color-bg-subtle, #f6f8fa);
      color: var(--color-fg-default, #1f2328);
    }

    .keyboard-shortcuts-body {
      padding: 16px 20px;
      overflow-y: auto;
    }

    .keyboard-shortcuts-list {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .keyboard-shortcuts-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .keyboard-shortcuts-group-title {
      margin: 0;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--color-fg-muted, #656d76);
    }

    .keyboard-shortcuts-items {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .keyboard-shortcut-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: var(--color-bg-subtle, #f6f8fa);
      border-radius: 6px;
    }

    .keyboard-shortcut-keys {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .keyboard-shortcut-key {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      height: 24px;
      padding: 0 8px;
      background: var(--color-bg-primary, #ffffff);
      border: 1px solid var(--color-border-default, #d0d7de);
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      font-weight: 500;
      color: var(--color-fg-default, #1f2328);
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.05);
    }

    .keyboard-shortcut-then {
      font-size: 11px;
      color: var(--color-fg-muted, #656d76);
      font-style: italic;
    }

    .keyboard-shortcut-description {
      font-size: 13px;
      color: var(--color-fg-default, #1f2328);
    }

    /* Dark theme support */
    [data-theme="dark"] .keyboard-shortcuts-backdrop {
      background: rgba(0, 0, 0, 0.7);
    }

    [data-theme="dark"] .keyboard-shortcuts-panel {
      background: #0d1117;
      box-shadow: 0 16px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.1);
    }

    [data-theme="dark"] .keyboard-shortcuts-header {
      border-bottom-color: #30363d;
    }

    [data-theme="dark"] .keyboard-shortcuts-header h2 {
      color: #e6edf3;
    }

    [data-theme="dark"] .keyboard-shortcuts-close {
      color: #8b949e;
    }

    [data-theme="dark"] .keyboard-shortcuts-close:hover {
      background: #21262d;
      color: #e6edf3;
    }

    [data-theme="dark"] .keyboard-shortcuts-group-title {
      color: #8b949e;
    }

    [data-theme="dark"] .keyboard-shortcut-item {
      background: #161b22;
    }

    [data-theme="dark"] .keyboard-shortcut-key {
      background: #0d1117;
      border-color: #30363d;
      color: #e6edf3;
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.3);
    }

    [data-theme="dark"] .keyboard-shortcut-then {
      color: #8b949e;
    }

    [data-theme="dark"] .keyboard-shortcut-description {
      color: #e6edf3;
    }
  `;

  document.head.appendChild(style);
})();

// Export for use
window.KeyboardShortcuts = KeyboardShortcuts;
