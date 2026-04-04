// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * Notification sound preferences backed by localStorage.
 * Sound playback is delegated to the server (POST /api/play-sound) so that it
 * works reliably even when the browser was opened programmatically without a
 * user gesture (which would block Web Audio API).
 */
class NotificationSounds {
  /**
   * Returns the localStorage key for a given event type.
   * @param {string} eventType - 'analysis' or 'setup'
   * @returns {string}
   */
  _storageKey(eventType) {
    return 'pair-review-notify-' + eventType;
  }

  /**
   * Check whether notifications are enabled for the given event type.
   * Returns false if the key is missing (default off).
   * @param {string} eventType - 'analysis' or 'setup'
   * @returns {boolean}
   */
  isEnabled(eventType) {
    const val = localStorage.getItem(this._storageKey(eventType));
    return val === 'true';
  }

  /**
   * Set whether notifications are enabled for the given event type.
   * @param {string} eventType - 'analysis' or 'setup'
   * @param {boolean} enabled
   */
  setEnabled(eventType, enabled) {
    localStorage.setItem(this._storageKey(eventType), enabled ? 'true' : 'false');
  }

  /**
   * Play a chime if notifications are enabled for the given event type.
   * @param {string} eventType - 'analysis' or 'setup'
   */
  playIfEnabled(eventType) {
    if (this.isEnabled(eventType)) {
      this.playChime();
    }
  }

  /**
   * Ask the server to play a system notification sound.
   * Fire-and-forget — errors are silently ignored.
   */
  playChime() {
    fetch('/api/play-sound', { method: 'POST' }).catch(() => {});
  }
}

window.notificationSounds = new NotificationSounds();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NotificationSounds };
}
