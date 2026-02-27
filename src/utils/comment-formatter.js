// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared comment formatter for adopted AI suggestions.
 * Provides configurable formatting with preset templates.
 */

const { getEmoji } = require('./category-emoji');

/**
 * Preset format templates for adopted comments.
 * Template placeholders: {emoji}, {category}, {title}, {description}, {suggestion}
 */
const PRESETS = {
  default: '{emoji} **{category}**: {description}\n\n**Suggestion:** {suggestion}',
  minimal: '[{category}] {description}\n\n{suggestion}',
  plain: '{description}\n\n{suggestion}',
  'emoji-only': '{emoji} {description}\n\n{suggestion}'
};

/**
 * Resolve a config value into a format configuration object.
 * @param {string|Object|undefined} config - Preset name string, custom config object, or undefined
 * @returns {{ template: string, showEmoji: boolean, emojiOverrides: Object }}
 */
function resolveFormat(config) {
  if (!config || typeof config === 'string') {
    const presetName = config || 'default';
    const template = PRESETS[presetName] || PRESETS.default;
    return { template, showEmoji: true, emojiOverrides: {} };
  }

  // Custom object config
  return {
    template: config.template || PRESETS.default,
    showEmoji: config.showEmoji !== false,
    emojiOverrides: config.emojiOverrides || {}
  };
}

/**
 * Capitalize a hyphenated category name.
 * e.g., 'code-style' -> 'Code Style', 'bug' -> 'Bug'
 * @param {string} category
 * @returns {string}
 */
function capitalizeCategory(category) {
  return category
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Format an adopted comment using the given format configuration.
 * Handles legacy data where suggestion_text was concatenated into body.
 *
 * @param {{ body: string, suggestionText?: string, category?: string, title?: string }} fields
 * @param {{ template: string, showEmoji: boolean, emojiOverrides: Object }} formatConfig
 * @returns {string} Formatted comment text
 */
function formatAdoptedComment(fields, formatConfig) {
  const { body, category, title } = fields;
  let { suggestionText } = fields;

  if (!category) {
    return body || '';
  }

  // Legacy handling: if no separate suggestionText, try to split from body
  let description = body || '';
  if (!suggestionText && description.includes('\n\n**Suggestion:** ')) {
    const splitIndex = description.indexOf('\n\n**Suggestion:** ');
    suggestionText = description.slice(splitIndex + '\n\n**Suggestion:** '.length);
    description = description.slice(0, splitIndex);
  }

  const config = formatConfig || resolveFormat();
  const emoji = config.emojiOverrides?.[category] || getEmoji(category);
  const capitalizedCategory = capitalizeCategory(category);

  let result = config.template;

  // Replace placeholders
  result = result.replace(/\{emoji\}/g, emoji);
  result = result.replace(/\{category\}/g, capitalizedCategory);
  result = result.replace(/\{title\}/g, title || '');
  result = result.replace(/\{description\}/g, description);

  // Handle {suggestion} - if no suggestion text, remove lines containing it
  if (suggestionText) {
    result = result.replace(/\{suggestion\}/g, suggestionText);
  } else {
    // Remove lines that contain the {suggestion} placeholder
    result = result.split('\n').filter(line => !line.includes('{suggestion}')).join('\n');
  }

  return result.trimEnd();
}

module.exports = { PRESETS, resolveFormat, formatAdoptedComment, capitalizeCategory };
