// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Canonical category-to-emoji mapping for AI suggestion types.
 * Used by SuggestionManager and FileCommentManager to format adopted comments.
 *
 * Canonical types from src/ai/prompts/shared/output-schema.js:
 * bug|improvement|praise|suggestion|design|performance|security|code-style
 */

(function() {
  const CATEGORY_EMOJI_MAP = {
    'bug': '\u{1F41B}',           // bug
    'improvement': '\u{1F4A1}',   // lightbulb
    'praise': '\u{2B50}',         // star
    'suggestion': '\u{1F4AC}',    // speech bubble
    'design': '\u{1F4D0}',        // triangular ruler
    'performance': '\u{26A1}',    // high voltage
    'security': '\u{1F512}',      // lock
    'code-style': '\u{1F3A8}',    // artist palette
    'style': '\u{1F3A8}'          // artist palette (alias for code-style)
  };

  const DEFAULT_EMOJI = '\u{1F4AC}'; // speech bubble

  /**
   * Get emoji for a suggestion category
   * @param {string} category - Category name
   * @returns {string} Emoji character
   */
  function getEmoji(category) {
    return CATEGORY_EMOJI_MAP[category] || DEFAULT_EMOJI;
  }

  // Export to global scope
  window.CategoryEmoji = {
    MAP: CATEGORY_EMOJI_MAP,
    DEFAULT: DEFAULT_EMOJI,
    getEmoji
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CATEGORY_EMOJI_MAP: window.CategoryEmoji.MAP, DEFAULT_EMOJI: window.CategoryEmoji.DEFAULT, getEmoji: window.CategoryEmoji.getEmoji };
}
