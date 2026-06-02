// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Storage Cleanup Module
 * Cleans up legacy localStorage keys from older versions of the app.
 * This prevents stale/orphaned data from causing confusion across sessions.
 *
 * Used by both PR mode (pr.js) and Local mode (local.js) on startup.
 */

/**
 * Remove legacy localStorage keys that are no longer used.
 * This runs on every page load to clean up stale data.
 */
function cleanupLegacyLocalStorage() {
  const legacyKeys = [
    'pair-review-session-state',  // Old session state format
    'reviewPanelSegment',         // Unscoped version (now uses reviewPanelSegment_${key})
    'pair-review-preferences',    // Old preferences format
    'pairReviewSidebarCollapsed', // Duplicate of file-sidebar-collapsed
    'pairReviewTheme',            // Duplicate of theme
    'settingsReferrer',           // Unscoped version (now uses settingsReferrer:${repo})
  ];

  // Legacy key prefixes (one entry per review id) that we need to sweep
  const legacyPrefixes = [
    'pair-review:dismissed-summaries:'  // Replaced by per-file toggle in v3.4
  ];

  // Remove known legacy keys
  legacyKeys.forEach(key => {
    if (localStorage.getItem(key) !== null) {
      localStorage.removeItem(key);
      console.log(`[cleanup] Removed legacy localStorage key: ${key}`);
    }
  });

  // Sweep prefixed keys. localStorage.length and key(i) iteration in
  // reverse order so removals don't shift indexes we still need to read.
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (legacyPrefixes.some(prefix => key.startsWith(prefix))) {
      localStorage.removeItem(key);
      console.log(`[cleanup] Removed legacy localStorage key: ${key}`);
    }
  }
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.cleanupLegacyLocalStorage = cleanupLegacyLocalStorage;
}
