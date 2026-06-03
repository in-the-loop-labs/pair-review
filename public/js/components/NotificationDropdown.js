// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * NotificationDropdown - Bell-icon popover for browser notification preferences.
 *
 * Uses the standard Web Notifications API. Permission is requested only from an
 * explicit user action.
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
    this._browserCheckboxes = {};
    this._permissionStatusEl = null;
    this._permissionButtonEl = null;
    this._visible = false;
    this._outsideClickHandler = null;
    this._escapeHandler = null;

    this._renderPopover();
    this._syncButtonActive();
    this._syncPermissionState();

    this._btnClickHandler = (e) => {
      e.stopPropagation();
      if (this._visible) this._hide();
      else this._show();
    };
    this._btn.addEventListener('click', this._btnClickHandler);
  }

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

  _renderPopover() {
    const popover = document.createElement('div');
    popover.className = 'notification-popover';
    popover.style.opacity = '0';
    popover.style.transform = 'translateY(-4px)';
    popover.style.pointerEvents = 'none';
    popover.style.position = 'fixed';
    popover.style.zIndex = '1100';
    popover.style.transition = 'opacity 0.15s ease, transform 0.15s ease';

    this._events.forEach((eventType) => {
      popover.appendChild(this._createEventToggle(eventType));
    });

    if (this._events.length > 0) popover.appendChild(this._createDivider());

    const permissionRow = document.createElement('div');
    permissionRow.style.padding = '8px 12px';
    permissionRow.style.display = 'flex';
    permissionRow.style.flexDirection = 'column';
    permissionRow.style.gap = '6px';

    this._permissionStatusEl = document.createElement('div');
    this._permissionStatusEl.style.fontSize = '0.75rem';
    this._permissionStatusEl.style.color = 'var(--color-text-secondary, #57606a)';

    this._permissionButtonEl = document.createElement('button');
    this._permissionButtonEl.type = 'button';
    this._permissionButtonEl.className = 'btn btn-secondary btn-small';
    this._permissionButtonEl.textContent = 'Enable browser notifications';
    this._permissionButtonEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (window.notificationSounds) await window.notificationSounds.requestBrowserPermission();
      this._syncPermissionState();
    });

    permissionRow.appendChild(this._permissionStatusEl);
    permissionRow.appendChild(this._permissionButtonEl);
    popover.appendChild(permissionRow);

    popover.appendChild(this._createDivider());

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '12px';
    actions.style.padding = '8px 12px';
    actions.appendChild(this._createActionLink('Test browser notification', async () => {
      if (!window.notificationSounds) return;
      if (window.notificationSounds.getBrowserPermission() === 'default') {
        await window.notificationSounds.requestBrowserPermission();
        this._syncPermissionState();
      }
      await window.notificationSounds.showBrowserNotification('analysis', {
        title: 'Pair Review',
        body: 'Browser notifications are working.',
        dedupeKey: 'pair-review-test-notification-' + Date.now(),
        showWhenVisible: true,
        ignorePreference: true
      });
    }));
    popover.appendChild(actions);

    document.body.appendChild(popover);
    this._popoverEl = popover;
  }

  _createEventToggle(eventType) {
    const label = this._createCheckboxLabel(
      EVENT_LABELS[eventType] || eventType,
      window.notificationSounds ? window.notificationSounds.isBrowserEnabled(eventType) : false
    );
    const checkbox = label.querySelector('input');
    this._browserCheckboxes[eventType] = checkbox;
    checkbox.addEventListener('change', async () => {
      if (!window.notificationSounds) return;
      if (checkbox.checked) {
        const permission = window.notificationSounds.getBrowserPermission();
        if (permission === 'default') {
          const result = await window.notificationSounds.requestBrowserPermission();
          if (result !== 'granted') checkbox.checked = false;
        } else if (permission !== 'granted') {
          checkbox.checked = false;
        }
      }
      window.notificationSounds.setBrowserEnabled(eventType, checkbox.checked);
      this._syncPermissionState();
      this._syncButtonActive();
    });
    return label;
  }

  _createDivider() {
    const divider = document.createElement('div');
    divider.style.height = '1px';
    divider.style.background = 'var(--color-border-primary, #d0d7de)';
    divider.style.margin = '0';
    return divider;
  }

  _createActionLink(text, onClick) {
    const link = document.createElement('div');
    link.textContent = text;
    link.style.fontSize = '0.8125rem';
    link.style.color = 'var(--color-accent-primary)';
    link.style.cursor = 'pointer';
    link.style.textDecoration = 'none';
    link.style.userSelect = 'none';

    link.addEventListener('mouseenter', () => { link.style.textDecoration = 'underline'; });
    link.addEventListener('mouseleave', () => { link.style.textDecoration = 'none'; });
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });

    return link;
  }

  _createCheckboxLabel(text, checked) {
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '8px';
    label.style.cursor = 'pointer';
    label.style.fontSize = '0.8125rem';
    label.style.whiteSpace = 'nowrap';
    label.style.padding = '8px 12px';
    label.style.color = 'var(--color-text-primary, #24292f)';
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

  _show() {
    if (!this._popoverEl || !this._btn) return;

    this._syncPermissionState();

    const rect = this._btn.getBoundingClientRect();
    this._popoverEl.style.top = `${rect.bottom + 4}px`;
    this._popoverEl.style.left = `${rect.left + rect.width / 2}px`;
    this._popoverEl.style.transform = 'translateX(-50%) translateY(-4px)';

    this._popoverEl.style.opacity = '1';
    this._popoverEl.style.pointerEvents = 'auto';
    this._visible = true;

    requestAnimationFrame(() => {
      if (this._popoverEl) this._popoverEl.style.transform = 'translateX(-50%) translateY(0)';
    });

    this._outsideClickHandler = (e) => {
      if (!this._popoverEl.contains(e.target) && !this._btn.contains(e.target)) this._hide();
    };
    document.addEventListener('click', this._outsideClickHandler, true);

    this._escapeHandler = (e) => {
      if (e.key === 'Escape') this._hide();
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

  _syncPermissionState() {
    if (!this._permissionStatusEl || !this._permissionButtonEl) return;
    const permission = window.notificationSounds
      ? window.notificationSounds.getBrowserPermission()
      : 'unsupported';

    if (permission === 'unsupported') {
      this._permissionStatusEl.textContent = 'Browser notifications are not supported in this browser.';
      this._permissionButtonEl.style.display = 'none';
    } else if (permission === 'granted') {
      this._permissionStatusEl.textContent = 'Browser notifications are enabled for this site.';
      this._permissionButtonEl.style.display = 'none';
    } else if (permission === 'denied') {
      this._permissionStatusEl.textContent = 'Browser notifications are blocked. Enable them in browser settings.';
      this._permissionButtonEl.style.display = 'none';
    } else {
      this._permissionStatusEl.textContent = 'Browser notification permission has not been requested.';
      this._permissionButtonEl.style.display = '';
    }
  }

  _syncButtonActive() {
    if (!this._btn) return;
    const anyEnabled = this._events.some((eventType) => {
      return window.notificationSounds
        ? window.notificationSounds.hasAnyEnabled(eventType)
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
