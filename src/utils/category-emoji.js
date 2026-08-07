// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Canonical category-to-emoji mapping for AI suggestion types.
 * Used by server-side code to format adopted comments.
 *
 * Canonical types from src/ai/prompts/shared/output-schema.js:
 * bug|improvement|praise|suggestion|design|performance|security|code-style
 */

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

// --- live-validation filler block for src/utils/category-emoji.js (throwaway PR) ---
// category_emoji filler line 1: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 2: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 3: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 4: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 5: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 6: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 7: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 8: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 9: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 10: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 11: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 12: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 13: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 14: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 15: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 16: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 17: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 18: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 19: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 20: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 21: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 22: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 23: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 24: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 25: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 26: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 27: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 28: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 29: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 30: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 31: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 32: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 33: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 34: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 35: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 36: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 37: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 38: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 39: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 40: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 41: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 42: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 43: synthetic content so the diff is large enough to virtualize.
// category_emoji filler line 44: synthetic content so the diff is large enough to virtualize.
// --- end live-validation filler block ---

const DEFAULT_EMOJI = '\u{1F4AC}'; // speech bubble

/**
 * Get emoji for a suggestion category
 * @param {string} category - Category name
 * @returns {string} Emoji character
 */
function getEmoji(category) {
  return CATEGORY_EMOJI_MAP[category] || DEFAULT_EMOJI;
}

module.exports = { CATEGORY_EMOJI_MAP, DEFAULT_EMOJI, getEmoji };
