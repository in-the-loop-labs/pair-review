// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Tier icon utility for model selection UI
 * Returns emoji icons for different model tiers that work well in both light and dark themes
 */

(function() {
  /**
   * Get the icon (emoji) for a given model tier
   * @param {string} tier - The model tier ('fast', 'balanced', 'thorough', 'premium')
   * @returns {string} The emoji icon for the tier
   */
  function getTierIcon(tier) {
    switch (tier) {
      case 'fast': return '\u26A1';        // Lightning bolt
      case 'free': return '\u26A1';        // Lightning bolt (alias for fast)
      case 'balanced': return '\u2696\uFE0F'; // Balance scale
      case 'thorough': return '\uD83C\uDFAF'; // Direct hit (target)
      case 'premium': return '\uD83D\uDC8E';  // Gem stone
      default: return '\u25CF';             // Black circle
    }
  }

  // Export to global scope
  window.getTierIcon = getTierIcon;
})();
