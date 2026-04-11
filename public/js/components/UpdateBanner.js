// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * UpdateBanner Component
 * Shows a persistent, dismissible corner-card notification when a newer
 * version of pair-review is available. Single delivery path: on construction,
 * fetch /api/config and show the banner if a pending_update exists.
 */

const DISMISS_KEY = 'update-banner-dismissed';

class UpdateBanner {
  constructor() {
    this._banner = null;
    this._dismissBtn = null;
    this._version = null;

    // Single path: fetch current config at construction; show banner if a
    // pending update exists. No event listener, no WebSocket coupling.
    // `fetch()` returns a Promise; `.then()` chains async steps; the final
    // `.catch()` swallows network errors because the banner is non-critical.
    fetch('/api/config')
      .then(r => (r.ok ? r.json() : null))
      .then(config => {
        if (config && config.pending_update) this.show(config.pending_update);
      })
      .catch(() => { /* non-critical */ });
  }

  /**
   * Show the update banner for the given version.
   * No-op if already showing or dismissed for this version.
   * @param {string} version
   */
  show(version) {
    if (!version) return;

    // Already dismissed for this version in this session
    if (sessionStorage.getItem(DISMISS_KEY) === version) return;

    // Already showing this version
    if (this._banner && this._version === version) return;

    // Remove any existing banner (e.g., for an older version)
    this._remove();

    this._version = version;

    // Theme-aware colors come from CSS custom properties (set in styles.css
    // under :root and [data-theme="dark"]). The inline `var(..., fallback)`
    // form keeps the banner readable even if the stylesheet hasn't loaded
    // yet. No MutationObserver needed — CSS handles the theme switch.
    const banner = document.createElement('div');
    banner.setAttribute('data-update-banner', '');
    Object.assign(banner.style, {
      position: 'fixed',
      top: '16px',
      left: '16px',
      zIndex: '1000',
      maxWidth: '360px',
      background: 'var(--color-info-bg, #eff6ff)',
      border: '1px solid var(--color-info-border, #bfdbfe)',
      borderLeft: '4px solid var(--color-info-accent, #3b82f6)',
      borderRadius: '8px',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
      padding: '12px 14px',
      fontSize: '13px',
      lineHeight: '1.4',
      color: 'var(--color-info-text, #1e3a8a)',
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px'
    });

    // Two-line layout: headline + restart instruction on its own line.
    const text = document.createElement('div');
    text.style.flex = '1';

    const headline = document.createElement('div');
    headline.textContent = `pair-review v${version} is available.`;

    const instruction = document.createElement('div');
    instruction.textContent = 'Restart the server to update.';
    instruction.style.marginTop = '2px';

    text.appendChild(headline);
    text.appendChild(instruction);

    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = '\u00d7';
    dismissBtn.setAttribute('aria-label', 'Dismiss');
    Object.assign(dismissBtn.style, {
      background: 'none',
      border: 'none',
      color: 'var(--color-info-text-muted, #3b5998)',
      cursor: 'pointer',
      fontSize: '18px',
      padding: '0',
      lineHeight: '1',
      flexShrink: '0',
      opacity: '0.8'
    });
    dismissBtn.addEventListener('click', () => this.dismiss());

    banner.appendChild(text);
    banner.appendChild(dismissBtn);
    document.body.appendChild(banner);
    this._banner = banner;
    this._dismissBtn = dismissBtn;
  }

  /** Dismiss the banner and remember the choice for this session. */
  dismiss() {
    if (this._version) {
      sessionStorage.setItem(DISMISS_KEY, this._version);
    }
    this._remove();
  }

  /** @private */
  _remove() {
    if (this._banner && this._banner.parentNode) {
      this._banner.parentNode.removeChild(this._banner);
    }
    this._banner = null;
    this._dismissBtn = null;
  }
}

// Singleton init (browser only)
if (typeof window !== 'undefined' && !window.updateBanner) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.updateBanner = new UpdateBanner();
    });
  } else {
    window.updateBanner = new UpdateBanner();
  }
}

// CommonJS export for unit tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { UpdateBanner };
}
