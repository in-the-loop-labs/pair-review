// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Synchronous theme bootstrap — the single source of truth for the pre-paint
 * theme decision, shared by every page.
 *
 * Loaded as the FIRST <script> in each page <head> (render-blocking, no
 * `defer`/`async`) so the correct `data-theme` is set before first paint,
 * preventing a flash of the wrong theme (FOUC).
 *
 * It is deliberately tiny, dependency-free, and duplicated-logic-free: the six
 * pages previously each inlined their own copy of this resolution. The
 * richer runtime behavior (toggle cycling, live OS-change tracking, button
 * icon) lives in js/theme.js, loaded later at the end of <body>.
 *
 * DEFAULT_PREFERENCE below is the single place that decides what a first-time
 * visitor (no stored preference) sees; keep it in sync with
 * PairReviewTheme.DEFAULT_PREFERENCE in js/theme.js.
 */
(function () {
  'use strict';

  var DEFAULT_PREFERENCE = 'system';

  var pref;
  try {
    pref = localStorage.getItem('theme');
  } catch (e) {
    // localStorage can throw in privacy modes — fall back to the default.
    pref = null;
  }
  if (pref !== 'light' && pref !== 'dark' && pref !== 'system') {
    pref = DEFAULT_PREFERENCE;
  }

  var systemDark = !!(window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches);
  var resolved = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;

  document.documentElement.setAttribute('data-theme', resolved);
})();
