// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * Browser notification preferences backed by localStorage.
 *
 * Uses the standard Web Notifications API — no backend helper, native bridge,
 * or server-side sound command. Browser/OS notification settings decide whether
 * a delivered notification makes a sound.
 */
class NotificationSounds {
  constructor() {
    this._recentNotifications = new Map();
    this._dedupeWindowMs = 10000;
    this._serviceWorkerRegistrationPromise = null;
  }

  /**
   * Browser notification preference key.
   * @param {string} eventType - 'analysis' or 'setup'
   * @returns {string}
   */
  _browserStorageKey(eventType) {
    return 'pair-review-browser-notify-' + eventType;
  }

  /**
   * Backwards-compatible aliases now refer to browser notifications.
   * @param {string} eventType - 'analysis' or 'setup'
   * @returns {boolean}
   */
  isEnabled(eventType) {
    return this.isBrowserEnabled(eventType);
  }

  /**
   * Backwards-compatible aliases now refer to browser notifications.
   * @param {string} eventType - 'analysis' or 'setup'
   * @param {boolean} enabled
   */
  setEnabled(eventType, enabled) {
    this.setBrowserEnabled(eventType, enabled);
  }

  /**
   * Check whether browser notifications are enabled for the given event type.
   * The stored preference is separate from browser permission.
   * @param {string} eventType - 'analysis' or 'setup'
   * @returns {boolean}
   */
  isBrowserEnabled(eventType) {
    const val = localStorage.getItem(this._browserStorageKey(eventType));
    return val === 'true';
  }

  /**
   * Set whether browser notifications are enabled for the given event type.
   * @param {string} eventType - 'analysis' or 'setup'
   * @param {boolean} enabled
   */
  setBrowserEnabled(eventType, enabled) {
    localStorage.setItem(this._browserStorageKey(eventType), enabled ? 'true' : 'false');
  }

  /**
   * @returns {boolean} true when the current browser exposes Notification.
   */
  isBrowserNotificationSupported() {
    return typeof window !== 'undefined' && 'Notification' in window;
  }

  /**
   * @returns {'unsupported'|'default'|'denied'|'granted'} Notification permission state.
   */
  getBrowserPermission() {
    if (!this.isBrowserNotificationSupported()) return 'unsupported';
    return window.Notification.permission || 'default';
  }

  /**
   * Request browser notification permission.
   * @returns {Promise<'unsupported'|'default'|'denied'|'granted'>}
   */
  async requestBrowserPermission() {
    if (!this.isBrowserNotificationSupported()) return 'unsupported';
    if (window.Notification.permission === 'granted' || window.Notification.permission === 'denied') {
      return window.Notification.permission;
    }
    try {
      const result = await window.Notification.requestPermission();
      return result || window.Notification.permission || 'default';
    } catch {
      return window.Notification.permission || 'default';
    }
  }

  /**
   * True if browser notifications are enabled for an event.
   * @param {string} eventType - 'analysis' or 'setup'
   * @returns {boolean}
   */
  hasAnyEnabled(eventType) {
    return this.isBrowserEnabled(eventType);
  }

  /**
   * Legacy method name retained for existing call sites. Shows a browser
   * notification if enabled.
   * @param {string} eventType - 'analysis' or 'setup'
   * @param {Object} [options]
   */
  playIfEnabled(eventType, options = {}) {
    this.notifyIfEnabled(eventType, options);
  }

  /**
   * Show an enabled browser notification for an event.
   * @param {string} eventType - 'analysis' or 'setup'
   * @param {Object} [options]
   * @param {string} [options.title]
   * @param {string} [options.body]
   * @param {string} [options.url]
   * @param {string} [options.dedupeKey]
   * @param {boolean} [options.showWhenVisible=false]
   * @returns {Promise<boolean>} true if a browser notification was created
   */
  async notifyIfEnabled(eventType, options = {}) {
    if (options.dedupeKey && this._isDuplicate(options.dedupeKey)) return false;
    return this.showBrowserNotification(eventType, options);
  }

  /**
   * Register and return the notification service worker when available.
   * @returns {Promise<ServiceWorkerRegistration|null>}
   */
  async getServiceWorkerRegistration() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
    if (!this._serviceWorkerRegistrationPromise) {
      this._serviceWorkerRegistrationPromise = navigator.serviceWorker
        .register('/notification-service-worker.js')
        .then(() => navigator.serviceWorker.ready)
        .catch(() => {
          this._serviceWorkerRegistrationPromise = null;
          return null;
        });
    }
    return this._serviceWorkerRegistrationPromise;
  }

  /**
   * Show a browser notification if enabled and permitted.
   * By default, only shows while the document is hidden to avoid foreground noise.
   * @param {string} eventType - 'analysis' or 'setup'
   * @param {Object} [options]
   * @param {boolean} [options.ignorePreference=false] - For explicit test notifications
   * @returns {Promise<boolean>} true if a browser notification was created
   */
  async showBrowserNotification(eventType, options = {}) {
    if (!options.ignorePreference && !this.isBrowserEnabled(eventType)) return false;
    const permission = this.getBrowserPermission();
    if (permission !== 'granted') return false;
    if (!options.showWhenVisible && typeof document !== 'undefined' && !document.hidden) return false;

    const title = options.title || 'Pair Review';
    const body = options.body || (eventType === 'setup' ? 'Review setup complete' : 'Analysis complete');
    const url = options.url || (typeof window !== 'undefined' ? window.location.href : undefined);
    const notificationOptions = {
      body,
      tag: options.dedupeKey || 'pair-review-' + eventType,
      icon: '/favicon.png',
      data: { url }
    };

    try {
      const registration = await this.getServiceWorkerRegistration();
      if (registration?.showNotification) {
        await registration.showNotification(title, notificationOptions);
        return true;
      }

      const notification = new window.Notification(title, notificationOptions);
      notification.onclick = () => {
        try {
          window.focus();
          if (url) window.location.href = url;
          notification.close();
        } catch {
          // Ignore focus/navigation failures. Notification already delivered.
        }
      };
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deprecated. Browser notifications do not provide a page-controlled sound.
   * Kept as a no-op so older code paths do not crash.
   */
  playChime() {}

  _isDuplicate(key) {
    const now = Date.now();
    for (const [existingKey, timestamp] of this._recentNotifications.entries()) {
      if (now - timestamp > this._dedupeWindowMs) {
        this._recentNotifications.delete(existingKey);
      }
    }
    if (this._recentNotifications.has(key)) return true;
    this._recentNotifications.set(key, now);
    return false;
  }
}

window.notificationSounds = new NotificationSounds();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NotificationSounds };
}
