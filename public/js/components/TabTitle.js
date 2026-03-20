// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * TabTitle — manages the browser tab title with flash-on-completion support.
 *
 * Usage:
 *   window.tabTitle = new TabTitle();
 *   window.tabTitle.setBase('PR #123');        // → "pair-review - PR #123"
 *   window.tabTitle.flashComplete();           // flashes "✓ Review Complete" until tab gains focus
 *   window.tabTitle.flashFailed();             // flashes "✗ Review Failed" until tab gains focus
 */
class TabTitle {
  constructor() {
    this._base = '';
    this._flashInterval = null;
    this._flashTimeout = null;
    this._onVisibility = this._onVisibilityChange.bind(this);
  }

  /**
   * Set the base identifier shown in the tab title.
   * @param {string} identifier - e.g. "PR #123" or "feature/dark-mode"
   */
  setBase(identifier) {
    this._base = identifier;
    this._apply();
  }

  /** Flash "✓ Review Complete" until the tab gains focus. */
  flashComplete() {
    this._flash('✓ Review Complete');
  }

  /** Flash "✗ Review Failed" until the tab gains focus. */
  flashFailed() {
    this._flash('✗ Review Failed');
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  _format(suffix) {
    return suffix ? `pair-review - ${suffix}` : 'pair-review';
  }

  _apply() {
    document.title = this._format(this._base);
  }

  _flash(message) {
    this._stopFlash();

    // If the tab is already visible, just show the message briefly then revert.
    if (!document.hidden) {
      document.title = this._format(message);
      this._flashTimeout = setTimeout(() => this._apply(), 3000);
      return;
    }

    // Tab is hidden — alternate between message and base title.
    let showMessage = true;
    document.title = this._format(message);

    this._flashInterval = setInterval(() => {
      showMessage = !showMessage;
      document.title = showMessage
        ? this._format(message)
        : this._format(this._base);
    }, 1000);

    document.addEventListener('visibilitychange', this._onVisibility);
  }

  _onVisibilityChange() {
    if (!document.hidden) {
      this._stopFlash();
    }
  }

  _stopFlash() {
    if (this._flashTimeout) {
      clearTimeout(this._flashTimeout);
      this._flashTimeout = null;
    }
    if (this._flashInterval) {
      clearInterval(this._flashInterval);
      this._flashInterval = null;
    }
    document.removeEventListener('visibilitychange', this._onVisibility);
    this._apply();
  }
}

if (typeof module !== 'undefined') {
  module.exports = { TabTitle };
}
