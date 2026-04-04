// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * NotificationDropdown - Bell-icon popover for notification sound preferences.
 *
 * Anchors a small dropdown below the bell button with checkbox toggles that
 * control which events trigger a notification chime.  Supports configurable
 * event types (e.g. 'analysis', 'setup') and a "Test sound" link.
 *
 * Follows the same popover pattern as DiffOptionsDropdown (fixed positioning
 * via getBoundingClientRect, click-outside and Escape to dismiss,
 * opacity+transform animation).
 *
 * Usage:
 *   const dropdown = new NotificationDropdown(
 *     document.getElementById('notification-btn'),
 *     { events: ['analysis', 'setup'] }
 *   );
 */

const EVENT_LABELS = {
  'analysis': 'Analysis complete',
  'setup': 'Setup complete'
};

class NotificationDropdown {
  /**
   * @param {HTMLElement} buttonElement - The bell icon button already in the DOM
   * @param {Object}      options
   * @param {string[]}    options.events - Event type strings to show toggles for
   */
  constructor(buttonElement, { events }) {
    this._btn = buttonElement;
    this._events = events || [];

    this._popoverEl = null;
    this._checkboxes = {};
    this._visible = false;
    this._outsideClickHandler = null;
    this._escapeHandler = null;

    this._renderPopover();
    this._syncButtonActive();

    // Toggle popover on button click
    this._btnClickHandler = (e) => {
      e.stopPropagation();
      if (this._visible) {
        this._hide();
      } else {
        this._show();
      }
    };
    this._btn.addEventListener('click', this._btnClickHandler);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Remove all DOM elements and event listeners. Safe to call multiple times. */
  destroy() {
    this._hide();
    if (this._popoverEl) {
      this._popoverEl.remove();
      this._popoverEl = null;
    }
    if (this._btn && this._btnClickHandler) {
      this._btn.removeEventListener('click', this._btnClickHandler);
      this._btnClickHandler = null;
    }
  }

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  _renderPopover() {
    const popover = document.createElement('div');
    popover.className = 'notification-popover';
    // Start hidden (opacity 0, shifted up)
    popover.style.opacity = '0';
    popover.style.transform = 'translateY(-4px)';
    popover.style.pointerEvents = 'none';
    popover.style.position = 'fixed';
    popover.style.zIndex = '1100';
    popover.style.transition = 'opacity 0.15s ease, transform 0.15s ease';

    // --- Event checkboxes ---
    this._events.forEach((eventType) => {
      const labelText = EVENT_LABELS[eventType] || eventType;
      const enabled = window.notificationSounds
        ? window.notificationSounds.isEnabled(eventType)
        : false;

      const label = this._createCheckboxLabel(labelText, enabled);
      const checkbox = label.querySelector('input');
      popover.appendChild(label);

      this._checkboxes[eventType] = checkbox;

      checkbox.addEventListener('change', () => {
        if (window.notificationSounds) {
          window.notificationSounds.setEnabled(eventType, checkbox.checked);
        }
        this._syncButtonActive();
      });
    });

    // --- Divider ---
    const divider = document.createElement('div');
    divider.style.height = '1px';
    divider.style.background = 'var(--color-border-primary, #d0d7de)';
    divider.style.margin = '0';
    popover.appendChild(divider);

    // --- Test sound link ---
    const testLink = document.createElement('div');
    testLink.textContent = 'Test sound';
    testLink.style.padding = '8px 12px';
    testLink.style.fontSize = '0.8125rem';
    testLink.style.color = 'var(--color-accent-primary)';
    testLink.style.cursor = 'pointer';
    testLink.style.textDecoration = 'none';
    testLink.style.userSelect = 'none';

    testLink.addEventListener('mouseenter', () => {
      testLink.style.textDecoration = 'underline';
    });
    testLink.addEventListener('mouseleave', () => {
      testLink.style.textDecoration = 'none';
    });
    testLink.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.notificationSounds) {
        window.notificationSounds.playChime();
      }
    });

    popover.appendChild(testLink);

    document.body.appendChild(popover);
    this._popoverEl = popover;
  }

  /**
   * Create a label element wrapping a checkbox.
   * @param {string} text - Label text
   * @param {boolean} checked - Initial checked state
   * @returns {HTMLLabelElement}
   */
  _createCheckboxLabel(text, checked) {
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
    checkbox.checked = checked;
    checkbox.style.margin = '0';
    checkbox.style.cursor = 'pointer';

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(text));
    return label;
  }

  // ---------------------------------------------------------------------------
  // Show / Hide (mirrors DiffOptionsDropdown pattern)
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

  /** Swap bell icon visibility when any notification is enabled. */
  _syncButtonActive() {
    if (!this._btn) return;
    const anyEnabled = this._events.some((eventType) => {
      return window.notificationSounds
        ? window.notificationSounds.isEnabled(eventType)
        : false;
    });
    const onIcon = this._btn.querySelector('.bell-icon-on');
    const offIcon = this._btn.querySelector('.bell-icon-off');
    if (onIcon) onIcon.style.display = anyEnabled ? '' : 'none';
    if (offIcon) offIcon.style.display = anyEnabled ? 'none' : '';
  }
}

window.NotificationDropdown = NotificationDropdown;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NotificationDropdown };
}
