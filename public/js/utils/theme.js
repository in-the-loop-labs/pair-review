// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared theme utilities.
 *
 * Pure helpers and icon rendering used across all pages.
 * Exposed on window.__pairReview following the established pattern
 * (see window.__pairReview.toGraphiteUrl).
 */
(function () {
  'use strict';

  /**
   * Resolve a stored theme preference to an actual theme value.
   * @param {string|null|undefined} preference - 'light', 'dark', 'system', or null/undefined
   * @param {boolean} prefersDark - whether the OS prefers dark mode
   * @returns {'light'|'dark'} the resolved theme
   */
  function resolveTheme(preference, prefersDark) {
    if (preference === 'light') return 'light';
    if (preference === 'dark') return 'dark';
    // 'system' or null/undefined → follow OS preference
    return prefersDark ? 'dark' : 'light';
  }

  /**
   * Get the next theme preference in the cycle.
   * @param {string} current - 'light', 'dark', or 'system'
   * @returns {'light'|'dark'|'system'}
   */
  function nextTheme(current) {
    if (current === 'light') return 'dark';
    if (current === 'dark') return 'system';
    return 'light'; // 'system' or unknown wraps to light
  }

  /**
   * Read the OS dark-mode preference safely.
   * @returns {boolean}
   */
  function prefersDark() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /**
   * Render the appropriate icon into a theme toggle button.
   * @param {HTMLElement} btn - the button element
   * @param {string} [preference] - 'light', 'dark', or 'system' (reads from localStorage if omitted)
   */
  function updateThemeIcon(btn, preference) {
    if (!btn) return;
    var pref = preference;
    if (pref === undefined || pref === null) {
      pref = (typeof localStorage !== 'undefined' ? localStorage.getItem('theme') : null) || 'system';
    }
    if (pref === 'system') {
      btn.innerHTML = '<svg class="theme-icon-system" viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 14.25 12H9.5v1.5h1.75a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5H6.5V12H1.75A1.75 1.75 0 0 1 0 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>';
      btn.title = 'Theme: System (follows OS)';
    } else if (pref === 'dark') {
      btn.innerHTML = '<svg class="theme-icon-dark" viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Z"/></svg>';
      btn.title = 'Switch to system mode';
    } else {
      btn.innerHTML = '<svg class="theme-icon-light" viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-1.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Zm0-10.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0Zm0 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.75.75 0 0 1-1.06 1.06l-1.06-1.06a.75.75 0 0 1 0-1.06Zm9.193 9.193a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM16 8a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm10.657-5.657a.75.75 0 0 1 0 1.061l-1.061 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 0 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0Z"/></svg>';
      btn.title = 'Switch to dark mode';
    }
  }

  // ---- Expose on window.__pairReview ----

  window.__pairReview = window.__pairReview || {};
  window.__pairReview.resolveTheme = resolveTheme;
  window.__pairReview.nextTheme = nextTheme;
  window.__pairReview.prefersDark = prefersDark;
  window.__pairReview.updateThemeIcon = updateThemeIcon;

  // Export for unit tests.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { resolveTheme, nextTheme, prefersDark, updateThemeIcon };
  }
})();
