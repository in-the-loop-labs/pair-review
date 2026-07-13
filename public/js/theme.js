// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared theme helper.
 *
 * The app supports three theme *preferences*:
 *   - 'light'  — always light
 *   - 'dark'   — always dark
 *   - 'system' — follow the OS setting, live (via prefers-color-scheme)
 *
 * A preference is persisted in localStorage under 'theme'. It is *resolved*
 * to a concrete 'light' | 'dark' before being written to the
 * `data-theme` attribute on <html>, because every theme CSS rule keys off
 * `[data-theme="dark"]`. The literal value 'system' is NEVER placed on the
 * element — only its resolved value.
 *
 * This module exposes pure helpers (resolveTheme, nextPreference, iconSvg,
 * labelFor) for unit testing, plus browser-facing helpers that touch the DOM.
 * Loading the module has no side effects; a page must call
 * `PairReviewTheme.setup()` (or the lower-level helpers) explicitly.
 */
(function (factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.PairReviewTheme = api;
  }
})(function () {
  'use strict';

  const STORAGE_KEY = 'theme';
  // A first-time visitor (no stored preference) follows the OS light/dark
  // setting. Once they click the toggle, their explicit choice is persisted and
  // wins. Keep in sync with DEFAULT_PREFERENCE in js/theme-bootstrap.js.
  const DEFAULT_PREFERENCE = 'system';
  /** Cycle order used by the toggle button. */
  const PREFERENCES = ['light', 'dark', 'system'];
  const SYSTEM_QUERY = '(prefers-color-scheme: dark)';

  // ─── Pure helpers (safe to call without a DOM) ──────────────────────────────

  /**
   * Resolve a preference to a concrete theme.
   * @param {string} preference - 'light' | 'dark' | 'system'
   * @param {boolean} systemIsDark - whether the OS currently prefers dark
   * @returns {'light'|'dark'}
   */
  function resolveTheme(preference, systemIsDark) {
    if (preference === 'system') {
      return systemIsDark ? 'dark' : 'light';
    }
    return preference === 'dark' ? 'dark' : 'light';
  }

  /**
   * Next preference in the toggle cycle: light → dark → system → light.
   * Unknown values fall back to the start of the cycle.
   * @param {string} preference
   * @returns {'light'|'dark'|'system'}
   */
  function nextPreference(preference) {
    const idx = PREFERENCES.indexOf(preference);
    return PREFERENCES[(idx + 1) % PREFERENCES.length];
  }

  /** Capitalized human name for a preference. */
  function describe(preference) {
    if (preference === 'dark') return 'Dark';
    if (preference === 'system') return 'System';
    return 'Light';
  }

  /**
   * Accessible label / tooltip text describing the current preference and
   * what a click will switch to.
   */
  function labelFor(preference) {
    // Unknown/corrupt input renders as light here (a safe visual fallback,
    // matching iconSvg); the *actual* default preference is DEFAULT_PREFERENCE,
    // applied in getPreference() before any value reaches this function.
    const pref = PREFERENCES.indexOf(preference) === -1 ? 'light' : preference;
    return `Theme: ${describe(pref)} (click for ${describe(nextPreference(pref))})`;
  }

  /**
   * SVG markup for the button icon representing a preference.
   * Sun = light, moon = dark, monitor = system.
   */
  function iconSvg(preference) {
    if (preference === 'dark') {
      return '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Z"/></svg>';
    }
    if (preference === 'system') {
      return '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.75 2A1.75 1.75 0 0 0 0 3.75v7c0 .966.784 1.75 1.75 1.75H6v1H4.75a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5H10v-1h4.25A1.75 1.75 0 0 0 16 10.75v-7A1.75 1.75 0 0 0 14.25 2H1.75Zm0 1.5h12.5a.25.25 0 0 1 .25.25v7a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25v-7a.25.25 0 0 1 .25-.25Z"/></svg>';
    }
    return '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-1.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Zm0-10.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0Zm0 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.75.75 0 0 1-1.06 1.06l-1.06-1.06a.75.75 0 0 1 0-1.06Zm9.193 9.193a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM16 8a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm10.657-5.657a.75.75 0 0 1 0 1.061l-1.061 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 0 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0Z"/></svg>';
  }

  // ─── Browser helpers (require a DOM) ─────────────────────────────────────────

  /** Whether the OS currently prefers a dark color scheme. */
  function systemIsDark() {
    return !!(typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia(SYSTEM_QUERY).matches);
  }

  /** Read the stored preference, falling back to the default. */
  function getPreference() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return PREFERENCES.indexOf(stored) === -1 ? DEFAULT_PREFERENCE : stored;
    } catch (_e) {
      return DEFAULT_PREFERENCE;
    }
  }

  /** Persist a preference. */
  function setPreference(preference) {
    try {
      window.localStorage.setItem(STORAGE_KEY, preference);
    } catch (_e) {
      /* localStorage unavailable — preference is still applied for this page */
    }
  }

  /** Resolve the stored (or given) preference to a concrete theme. */
  function resolvePreference(preference) {
    return resolveTheme(preference || getPreference(), systemIsDark());
  }

  /**
   * Write the resolved theme to <html data-theme>. Returns the resolved theme.
   * Does not persist — call setPreference separately.
   */
  function applyResolved(preference) {
    const resolved = resolvePreference(preference);
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', resolved);
    }
    return resolved;
  }

  /** Update a toggle button's icon, title, and aria-label for a preference. */
  function updateButton(button, preference) {
    if (!button) return;
    button.innerHTML = iconSvg(preference);
    button.title = labelFor(preference);
    button.setAttribute('aria-label', labelFor(preference));
  }

  /**
   * Wire up the theme system for a page.
   *
   * - Applies the stored preference to <html> and the toggle button.
   * - Cycles light → dark → system → light on click.
   * - Re-applies live when the OS scheme changes AND the preference is
   *   'system' (so 'light'/'dark' users are never overridden).
   * - Calls onChange(resolvedTheme, preference) after every apply (initial
   *   load, toggle, and OS change) so callers can sync dependent state
   *   (e.g. the diff renderer).
   *
   * @param {object} [opts]
   * @param {string} [opts.buttonId='theme-toggle'] - id of the toggle button
   * @param {(resolved: 'light'|'dark', preference: string) => void} [opts.onChange]
   * @returns {() => void} dispose function (removes the OS-change listener)
   */
  function setup(opts) {
    const options = opts || {};
    const buttonId = options.buttonId || 'theme-toggle';
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;

    const button = typeof document !== 'undefined' ? document.getElementById(buttonId) : null;

    // Track the active preference in memory so the toggle cycle never depends
    // on a successful localStorage write to advance. If persistence silently
    // fails, the button still cycles light → dark → system correctly (the
    // choice just won't survive a reload) instead of sticking at light↔dark.
    let currentPreference = getPreference();

    function applyAndNotify(preference) {
      currentPreference = preference;
      const resolved = applyResolved(preference);
      updateButton(button, preference);
      if (onChange) onChange(resolved, preference);
      return resolved;
    }

    // Initial paint (inline bootstrap already set data-theme; this syncs the
    // button + notifies dependents).
    applyAndNotify(currentPreference);

    if (button) {
      button.addEventListener('click', function () {
        const next = nextPreference(currentPreference);
        setPreference(next);
        applyAndNotify(next);
      });
    }

    // Live OS-change listener — only takes effect while preference is 'system'.
    let mql = null;
    let handler = null;
    if (typeof window !== 'undefined' && window.matchMedia) {
      mql = window.matchMedia(SYSTEM_QUERY);
      handler = function () {
        if (currentPreference === 'system') {
          applyAndNotify('system');
        }
      };
      if (mql.addEventListener) {
        mql.addEventListener('change', handler);
      } else if (mql.addListener) {
        mql.addListener(handler); // Safari < 14 fallback
      }
    }

    return function dispose() {
      if (mql && handler) {
        if (mql.removeEventListener) mql.removeEventListener('change', handler);
        else if (mql.removeListener) mql.removeListener(handler);
      }
    };
  }

  return {
    STORAGE_KEY,
    DEFAULT_PREFERENCE,
    PREFERENCES,
    // pure
    resolveTheme,
    nextPreference,
    describe,
    labelFor,
    iconSvg,
    // browser
    systemIsDark,
    getPreference,
    setPreference,
    resolvePreference,
    applyResolved,
    updateButton,
    setup,
  };
});
