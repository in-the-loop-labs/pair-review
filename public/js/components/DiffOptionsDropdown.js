// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * DiffOptionsDropdown - Gear-icon popover for diff display options.
 *
 * Anchors a small dropdown below the gear button (#diff-options-btn) with
 * checkbox toggles that control diff rendering.  Currently supports a single
 * option: "Hide whitespace changes".
 *
 * Follows the same popover pattern used by PanelGroup._showPopover() /
 * _hidePopover() (fixed positioning via getBoundingClientRect, click-outside
 * and Escape to dismiss, opacity+transform animation).
 *
 * Usage:
 *   const dropdown = new DiffOptionsDropdown(
 *     document.getElementById('diff-options-btn'),
 *     { onToggleWhitespace: (hidden) => { … } }
 *   );
 */

const STORAGE_KEY = 'pair-review-hide-whitespace';

class DiffOptionsDropdown {
  /**
   * @param {HTMLElement} buttonElement - The gear icon button already in the DOM
   * @param {Object}      callbacks
   * @param {function(boolean):void} callbacks.onToggleWhitespace
   */
  constructor(buttonElement, { onToggleWhitespace }) {
    this._btn = buttonElement;
    this._onToggleWhitespace = onToggleWhitespace;

    this._popoverEl = null;
    this._checkbox = null;
    this._visible = false;
    this._outsideClickHandler = null;
    this._escapeHandler = null;

    // Read persisted state
    this._hideWhitespace = localStorage.getItem(STORAGE_KEY) === 'true';

    this._renderPopover();
    this._syncButtonActive();

    // Toggle popover on button click
    this._btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._visible) {
        this._hide();
      } else {
        this._show();
      }
    });

    // Fire initial callback so the consumer can apply the persisted state
    if (this._hideWhitespace) {
      this._onToggleWhitespace(true);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** @returns {boolean} Whether whitespace changes are currently hidden */
  get hideWhitespace() {
    return this._hideWhitespace;
  }

  /** Programmatically set the whitespace toggle (updates UI + storage). */
  set hideWhitespace(value) {
    const bool = Boolean(value);
    if (bool === this._hideWhitespace) return;
    this._hideWhitespace = bool;
    if (this._checkbox) this._checkbox.checked = bool;
    this._persist();
    this._syncButtonActive();
    this._onToggleWhitespace(bool);
  }

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  _renderPopover() {
    const popover = document.createElement('div');
    popover.className = 'diff-options-popover';
    // Start hidden (opacity 0, shifted up)
    popover.style.opacity = '0';
    popover.style.transform = 'translateY(-4px)';
    popover.style.pointerEvents = 'none';
    popover.style.position = 'fixed';
    popover.style.zIndex = '1100';
    popover.style.transition = 'opacity 0.15s ease, transform 0.15s ease';

    // Label wrapping checkbox for a nice click target
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '8px';
    label.style.cursor = 'pointer';
    label.style.fontSize = '0.8125rem';
    label.style.whiteSpace = 'nowrap';
    label.style.padding = '8px 12px';
    label.style.userSelect = 'none';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this._hideWhitespace;
    checkbox.style.margin = '0';
    checkbox.style.cursor = 'pointer';

    const text = document.createTextNode('Hide whitespace changes');

    label.appendChild(checkbox);
    label.appendChild(text);
    popover.appendChild(label);

    document.body.appendChild(popover);

    this._popoverEl = popover;
    this._checkbox = checkbox;

    // Respond to checkbox changes
    checkbox.addEventListener('change', () => {
      this._hideWhitespace = checkbox.checked;
      this._persist();
      this._syncButtonActive();
      this._onToggleWhitespace(this._hideWhitespace);
    });
  }

  // ---------------------------------------------------------------------------
  // Show / Hide (mirrors PanelGroup pattern)
  // ---------------------------------------------------------------------------

  _show() {
    if (!this._popoverEl || !this._btn) return;

    // Position below the button
    const rect = this._btn.getBoundingClientRect();
    this._popoverEl.style.top = `${rect.bottom + 4}px`;
    this._popoverEl.style.left = `${rect.left + rect.width / 2}px`;
    this._popoverEl.style.transform = 'translateX(-50%) translateY(-4px)';

    // Make visible
    this._popoverEl.style.opacity = '1';
    this._popoverEl.style.pointerEvents = 'auto';
    this._visible = true;

    // Animate into final position
    requestAnimationFrame(() => {
      if (this._popoverEl) {
        this._popoverEl.style.transform = 'translateX(-50%) translateY(0)';
      }
    });

    // Click-outside-to-close
    this._outsideClickHandler = (e) => {
      if (!this._popoverEl.contains(e.target) && !this._btn.contains(e.target)) {
        this._hide();
      }
    };
    document.addEventListener('click', this._outsideClickHandler, true);

    // Escape to dismiss
    this._escapeHandler = (e) => {
      if (e.key === 'Escape') {
        this._hide();
      }
    };
    document.addEventListener('keydown', this._escapeHandler, true);
  }

  _hide() {
    if (!this._popoverEl) return;

    this._popoverEl.style.opacity = '0';
    this._popoverEl.style.transform = 'translateX(-50%) translateY(-4px)';
    this._popoverEl.style.pointerEvents = 'none';
    this._visible = false;

    if (this._outsideClickHandler) {
      document.removeEventListener('click', this._outsideClickHandler, true);
      this._outsideClickHandler = null;
    }
    if (this._escapeHandler) {
      document.removeEventListener('keydown', this._escapeHandler, true);
      this._escapeHandler = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _persist() {
    localStorage.setItem(STORAGE_KEY, String(this._hideWhitespace));
  }

  /** Add/remove `.active` on the gear button as a visual cue that filtering is on. */
  _syncButtonActive() {
    if (!this._btn) return;
    this._btn.classList.toggle('active', this._hideWhitespace);
  }
}

window.DiffOptionsDropdown = DiffOptionsDropdown;
