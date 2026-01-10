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

  // Remove known legacy keys
  legacyKeys.forEach(key => {
    if (localStorage.getItem(key) !== null) {
      localStorage.removeItem(key);
      console.log(`[cleanup] Removed legacy localStorage key: ${key}`);
    }
  });
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.cleanupLegacyLocalStorage = cleanupLegacyLocalStorage;
}
