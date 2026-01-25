// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * EmojiPicker - GitHub-style emoji autocomplete popup for textareas
 * Shows emoji suggestions when user types ":" and filters as they type.
 * Supports keyboard navigation and click selection.
 *
 * Emoji data is lazily extracted from the markdown-it-emoji bundle at runtime.
 */
class EmojiPicker {
  /**
   * URL of the markdown-it-emoji bundle (already loaded by the page)
   */
  static EMOJI_BUNDLE_URL = 'https://cdn.jsdelivr.net/npm/markdown-it-emoji@2.0.2/dist/markdown-it-emoji.min.js';

  /**
   * Cached emoji list (populated on first use)
   * @type {Array<[string, string]>|null}
   */
  static _emojiListCache = null;

  /**
   * Promise for in-progress extraction (prevents duplicate requests)
   * @type {Promise|null}
   */
  static _extractionPromise = null;

  /**
   * Extract emoji data from the markdown-it-emoji bundle
   * @returns {Promise<Array<[string, string]>>} Array of [shortcode, emoji] pairs
   */
  static async extractEmojiFromBundle() {
    const response = await fetch(EmojiPicker.EMOJI_BUNDLE_URL);
    const data = await response.text();

    const pairs = data.match(/[a-z0-9_+-]+:"\\u[^"]+"/g);
    if (!pairs) return [];

    return pairs.map(p => {
      const [name, unicode] = p.split(':"');
      const emoji = JSON.parse('"' + unicode);
      return [name, emoji];
    });
  }

  /**
   * Ensure emoji list is loaded (lazy loading with caching)
   * @returns {Promise<Array<[string, string]>>} The emoji list
   */
  static async ensureEmojiLoaded() {
    // Return cached list if available
    if (EmojiPicker._emojiListCache !== null) {
      return EmojiPicker._emojiListCache;
    }

    // If extraction is already in progress, wait for it
    if (EmojiPicker._extractionPromise !== null) {
      return EmojiPicker._extractionPromise;
    }

    // Start extraction
    EmojiPicker._extractionPromise = EmojiPicker.extractEmojiFromBundle()
      .then(list => {
        EmojiPicker._emojiListCache = list;
        EmojiPicker._extractionPromise = null;
        return list;
      })
      .catch(err => {
        console.error('Failed to extract emoji from bundle:', err);
        EmojiPicker._extractionPromise = null;
        EmojiPicker._emojiListCache = [];
        return [];
      });

    return EmojiPicker._extractionPromise;
  }

  /**
   * Synchronous getter for emoji list (returns cached or empty)
   * Use ensureEmojiLoaded() for async access with loading
   */
  static get EMOJI_LIST() {
    return EmojiPicker._emojiListCache || [];
  }

  /**
   * Create an EmojiPicker instance
   * @param {Object} options - Configuration options
   * @param {number} options.maxResults - Maximum results to show (default: 8)
   */
  constructor(options = {}) {
    this.maxResults = options.maxResults || 8;
    this.popup = null;
    this.activeTextarea = null;
    this.selectedIndex = 0;
    this.matches = [];
    this.triggerStart = -1; // Position where ":" was typed
    this.boundHandleKeydown = this.handleKeydown.bind(this);
    this.boundHandleClick = this.handleDocumentClick.bind(this);
    this.attachedTextareas = new Map(); // Map<textarea, {input, keydown, blur}>
  }

  /**
   * Attach emoji picker to a textarea element
   * @param {HTMLTextAreaElement} textarea - The textarea to attach to
   */
  attach(textarea) {
    if (!textarea || textarea._emojiPickerAttached) return;

    textarea._emojiPickerAttached = true;

    const handlers = {
      input: (e) => this.handleInput(e),
      keydown: (e) => this.handleTextareaKeydown(e),
      blur: (e) => {
        // Capture textarea reference to avoid race condition
        const ta = e.target;
        // Delay hiding to allow click on popup
        setTimeout(() => { if (this.activeTextarea === ta) this.hidePopup(); }, 150);
      }
    };

    textarea.addEventListener('input', handlers.input);
    textarea.addEventListener('keydown', handlers.keydown);
    textarea.addEventListener('blur', handlers.blur);

    this.attachedTextareas.set(textarea, handlers);
  }

  /**
   * Handle input events on textareas
   * @param {Event} e - Input event
   */
  handleInput(e) {
    const textarea = e.target;
    const value = textarea.value;
    const cursorPos = textarea.selectionStart;

    // First, check if cursor is immediately after a complete shortcode like :smile:
    // This handles the case where user just typed the closing colon
    const textBeforeCursor = value.substring(0, cursorPos);
    const completeShortcodeMatch = textBeforeCursor.match(/:([a-zA-Z0-9_+-]+):$/);
    if (completeShortcodeMatch) {
      // User just completed a shortcode, hide popup and don't trigger new one
      this.hidePopup();
      return;
    }

    // Find the last ":" before cursor that could be a trigger (at start or after whitespace)
    let colonPos = -1;
    for (let i = cursorPos - 1; i >= 0; i--) {
      const char = value[i];
      if (char === ':') {
        // Valid trigger position: at start of string or after whitespace
        if (i === 0 || /\s/.test(value[i - 1])) {
          colonPos = i;
          break;
        }
        // Not a valid trigger position, keep looking
        continue;
      }
      // Stop searching if we hit whitespace or newline
      if (/\s/.test(char)) {
        break;
      }
    }

    if (colonPos === -1) {
      this.hidePopup();
      return;
    }

    // Get the search text after the colon
    const searchText = value.substring(colonPos + 1, cursorPos);

    // Check if user has typed a complete shortcode (ends with colon, like :smile:)
    if (searchText.endsWith(':')) {
      this.hidePopup();
      return;
    }

    // Don't show popup for empty search if colon was just typed
    // But allow filtering with partial text
    if (searchText.length === 0 && this.triggerStart !== colonPos) {
      this.triggerStart = colonPos;
      this.showPopup(textarea, '');
    } else if (searchText.length > 0) {
      this.triggerStart = colonPos;
      this.showPopup(textarea, searchText);
    } else if (this.triggerStart === colonPos) {
      // Colon just typed, show all popular emoji
      this.showPopup(textarea, '');
    } else {
      this.hidePopup();
    }
  }

  /**
   * Handle keydown events on attached textareas
   * @param {KeyboardEvent} e - Keyboard event
   */
  handleTextareaKeydown(e) {
    if (!this.popup || this.popup.style.display === 'none') return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectNext();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.selectPrevious();
        break;
      case 'Enter':
      case 'Tab':
        if (this.matches.length > 0) {
          e.preventDefault();
          this.insertSelected();
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.hidePopup();
        break;
    }
  }

  /**
   * Filter emoji list by search term
   * @param {string} search - Search term
   * @returns {Array} Filtered emoji list
   */
  filterEmoji(search) {
    const emojiList = EmojiPicker.EMOJI_LIST;

    if (!search) {
      // Return popular emoji when no search
      return emojiList.slice(0, this.maxResults);
    }

    const lower = search.toLowerCase();
    const results = [];

    for (const [shortcode, emoji] of emojiList) {
      if (shortcode.toLowerCase().startsWith(lower)) {
        results.push([shortcode, emoji]);
      }
      if (results.length >= this.maxResults) break;
    }

    // If not enough exact prefix matches, try contains
    if (results.length < this.maxResults) {
      for (const [shortcode, emoji] of emojiList) {
        if (!shortcode.toLowerCase().startsWith(lower) &&
            shortcode.toLowerCase().includes(lower)) {
          results.push([shortcode, emoji]);
        }
        if (results.length >= this.maxResults) break;
      }
    }

    return results;
  }

  /**
   * Show the emoji picker popup
   * @param {HTMLTextAreaElement} textarea - The active textarea
   * @param {string} search - Current search term
   */
  async showPopup(textarea, search) {
    // Ensure emoji are loaded before showing popup
    await EmojiPicker.ensureEmojiLoaded();

    this.activeTextarea = textarea;
    this.matches = this.filterEmoji(search);

    if (this.matches.length === 0) {
      this.hidePopup();
      return;
    }

    this.selectedIndex = 0;

    // Create popup if it doesn't exist
    if (!this.popup) {
      this.createPopup();
    }

    // Populate the popup
    this.renderMatches();

    // Position the popup near the cursor
    this.positionPopup(textarea);

    // Show popup
    this.popup.style.display = 'block';

    // Add document click listener
    document.addEventListener('click', this.boundHandleClick);
  }

  /**
   * Create the popup element
   */
  createPopup() {
    this.popup = document.createElement('div');
    this.popup.className = 'emoji-picker-popup';
    this.popup.style.display = 'none';
    document.body.appendChild(this.popup);
  }

  /**
   * Render the matches in the popup
   */
  renderMatches() {
    this.popup.innerHTML = '';

    this.matches.forEach(([shortcode, emoji], index) => {
      const item = document.createElement('div');
      item.className = 'emoji-picker-item';
      if (index === this.selectedIndex) {
        item.classList.add('selected');
      }

      item.innerHTML = `
        <span class="emoji-picker-emoji">${emoji}</span>
        <span class="emoji-picker-shortcode">:${shortcode}:</span>
      `;

      item.addEventListener('mouseenter', () => {
        this.selectedIndex = index;
        this.updateSelection();
      });

      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.insertEmoji(shortcode, emoji);
      });

      this.popup.appendChild(item);
    });
  }

  /**
   * Update the visual selection
   */
  updateSelection() {
    const items = this.popup.querySelectorAll('.emoji-picker-item');
    items.forEach((item, index) => {
      item.classList.toggle('selected', index === this.selectedIndex);
    });

    // Ensure selected item is visible
    const selectedItem = items[this.selectedIndex];
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Select the next item
   */
  selectNext() {
    if (this.selectedIndex < this.matches.length - 1) {
      this.selectedIndex++;
      this.updateSelection();
    }
  }

  /**
   * Select the previous item
   */
  selectPrevious() {
    if (this.selectedIndex > 0) {
      this.selectedIndex--;
      this.updateSelection();
    }
  }

  /**
   * Insert the currently selected emoji
   */
  insertSelected() {
    if (this.matches.length > 0 && this.selectedIndex >= 0) {
      const [shortcode, emoji] = this.matches[this.selectedIndex];
      this.insertEmoji(shortcode, emoji);
    }
  }

  /**
   * Insert an emoji into the textarea
   * @param {string} shortcode - The emoji shortcode
   * @param {string} emoji - The unicode emoji
   */
  insertEmoji(shortcode, emoji) {
    if (!this.activeTextarea) return;

    const textarea = this.activeTextarea;
    const value = textarea.value;
    const cursorPos = textarea.selectionStart;

    // Use the stored trigger position for reliable replacement
    const colonPos = this.triggerStart;

    if (colonPos === -1) {
      this.hidePopup();
      return;
    }

    // Replace :search with the emoji
    const before = value.substring(0, colonPos);
    const after = value.substring(cursorPos);
    const newValue = before + emoji + after;

    textarea.value = newValue;

    // Position cursor after the emoji
    const newCursorPos = colonPos + emoji.length;
    textarea.setSelectionRange(newCursorPos, newCursorPos);

    // Trigger input event for auto-resize and other listeners
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    // Hide popup
    this.hidePopup();

    // Focus textarea
    textarea.focus();
  }

  /**
   * Position the popup near the cursor in the textarea
   * @param {HTMLTextAreaElement} textarea - The textarea
   */
  positionPopup(textarea) {
    // Get textarea position
    const rect = textarea.getBoundingClientRect();

    // Create a temporary element to measure cursor position
    const mirror = document.createElement('div');
    const computed = window.getComputedStyle(textarea);

    // Copy textarea styles to mirror
    const stylesToCopy = [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
      'textTransform', 'wordSpacing', 'textIndent', 'whiteSpace', 'wordWrap',
      'lineHeight', 'padding', 'paddingLeft', 'paddingRight', 'paddingTop',
      'paddingBottom', 'border', 'borderWidth', 'boxSizing'
    ];

    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflow = 'hidden';
    mirror.style.width = computed.width;

    stylesToCopy.forEach(style => {
      mirror.style[style] = computed[style];
    });

    document.body.appendChild(mirror);

    // Get text up to cursor
    const textBeforeCursor = textarea.value.substring(0, this.triggerStart);
    mirror.textContent = textBeforeCursor;

    // Add a span for the colon position
    const span = document.createElement('span');
    span.textContent = ':';
    mirror.appendChild(span);

    // Get position of the span
    const spanRect = span.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();

    // Calculate cursor position relative to textarea
    const cursorLeft = spanRect.left - mirrorRect.left;
    const cursorTop = spanRect.top - mirrorRect.top;

    // Clean up mirror
    document.body.removeChild(mirror);

    // Position popup
    const popupTop = rect.top + cursorTop + parseInt(computed.lineHeight) + window.scrollY;
    const popupLeft = rect.left + cursorLeft + window.scrollX;

    // Adjust if popup would go off screen
    const popupWidth = 280; // Approximate width
    const popupHeight = 300; // Approximate max height
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let finalLeft = popupLeft;
    let finalTop = popupTop;

    // Check right edge
    if (finalLeft + popupWidth > viewportWidth - 10) {
      finalLeft = viewportWidth - popupWidth - 10;
    }

    // Check left edge
    if (finalLeft < 10) {
      finalLeft = 10;
    }

    // Check bottom edge - if popup would go below viewport, show above cursor
    if (finalTop + popupHeight > viewportHeight + window.scrollY - 10) {
      finalTop = rect.top + cursorTop - popupHeight + window.scrollY;
    }

    this.popup.style.top = `${finalTop}px`;
    this.popup.style.left = `${finalLeft}px`;
  }

  /**
   * Hide the popup
   */
  hidePopup() {
    if (this.popup) {
      this.popup.style.display = 'none';
    }
    this.triggerStart = -1;
    document.removeEventListener('click', this.boundHandleClick);
  }

  /**
   * Handle document click to close popup
   * @param {Event} e - Click event
   */
  handleDocumentClick(e) {
    if (this.popup && !this.popup.contains(e.target) && e.target !== this.activeTextarea) {
      this.hidePopup();
    }
  }

  /**
   * Handle keydown events (for document-level handling if needed)
   * @param {KeyboardEvent} e - Keyboard event
   */
  handleKeydown(e) {
    // This method is bound but used via textarea-specific handler
  }

  /**
   * Destroy the emoji picker, removing popup and cleaning up all event listeners
   */
  destroy() {
    // Hide and remove popup from DOM
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }

    // Remove document click listener
    document.removeEventListener('click', this.boundHandleClick);

    // Detach from all attached textareas
    for (const [textarea, handlers] of this.attachedTextareas) {
      textarea.removeEventListener('input', handlers.input);
      textarea.removeEventListener('keydown', handlers.keydown);
      textarea.removeEventListener('blur', handlers.blur);
      delete textarea._emojiPickerAttached;
    }
    this.attachedTextareas.clear();

    // Reset state
    this.activeTextarea = null;
    this.triggerStart = -1;
    this.matches = [];
    this.selectedIndex = 0;
  }
}

// Create global emoji picker instance
if (typeof window !== 'undefined' && !window.emojiPicker) {
  window.emojiPicker = new EmojiPicker();
}

// Make EmojiPicker available globally
window.EmojiPicker = EmojiPicker;
