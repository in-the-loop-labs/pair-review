// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared comment formatter for adopted AI suggestions.
 * Provides configurable formatting with preset templates.
 */

const { getEmoji } = require('./category-emoji');

/**
 * Preset format templates for adopted comments.
 * Template placeholders: {emoji}, {category}, {title}, {description}, {suggestion}
 * Conditional sections: {?field}...{/field} — content is kept when field is truthy, stripped when falsy.
 */
const PRESETS = {
  legacy: '{emoji} **{category}**: {description}{?suggestion}\n\n**Suggestion:** {suggestion}{/suggestion}',
  minimal: '[{category}] {description}{?suggestion}\n\n{suggestion}{/suggestion}',
  plain: '{description}{?suggestion}\n\n{suggestion}{/suggestion}',
  'emoji-only': '{emoji} {description}{?suggestion}\n\n{suggestion}{/suggestion}',
  maximal: '{emoji} **{category}**{?title}: {title}{/title}\n\n{description}{?suggestion}\n\n**Suggestion:** {suggestion}{/suggestion}'
};

/**
 * Resolve a config value into a format configuration object.
 * @param {string|Object|undefined} config - Preset name string, custom config object, or undefined
 * @returns {{ template: string, emojiOverrides: Object, categoryOverrides: Object }}
 */
function resolveFormat(config) {
  if (!config || typeof config === 'string') {
    const presetName = config || 'legacy';
    const template = PRESETS[presetName] || PRESETS.legacy;
    return { template, emojiOverrides: {}, categoryOverrides: {} };
  }

  // Custom object config
  return {
    template: config.template || PRESETS.legacy,
    emojiOverrides: config.emojiOverrides || {},
    categoryOverrides: config.categoryOverrides || {}
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
 * Process conditional sections in a template.
 * Syntax: {?fieldName}content{/fieldName}
 * When the field value is truthy, the delimiters are stripped and content is kept.
 * When the field value is falsy/empty/undefined, the entire block is removed.
 *
 * @param {string} template - Template with conditional sections
 * @param {Object} values - Map of field names to their values
 * @returns {string} Template with conditional sections resolved
 */
function processConditionalSections(template, values) {
  return template.replace(/\{\?(\w+)\}([\s\S]*?)\{\/\1\}/g, (match, fieldName, content) => {
    const value = values[fieldName];
    if (value !== undefined && value !== null && value !== '') {
      return content;
    }
    return '';
  });
}

/**
 * Format an adopted comment using the given format configuration.
 * Handles legacy data where suggestion_text was concatenated into body.
 *
 * @param {{ body: string, suggestionText?: string, category?: string, title?: string }} fields
 * @param {{ template: string, emojiOverrides: Object, categoryOverrides: Object }} formatConfig
 * @returns {string} Formatted comment text
 */
function formatAdoptedComment(fields, formatConfig) {
  const { body, title } = fields;
  let { category, suggestionText } = fields;

  if (!category) {
    return body || '';
  }

  category = category.toLowerCase();

  // Legacy handling: if no separate suggestionText, try to split from body
  let description = body || '';
  if (!suggestionText && description.includes('\n\n**Suggestion:** ')) {
    const splitIndex = description.indexOf('\n\n**Suggestion:** ');
    suggestionText = description.slice(splitIndex + '\n\n**Suggestion:** '.length);
    description = description.slice(0, splitIndex);
  }

  const config = formatConfig || resolveFormat();

  // Resolve emoji from original category BEFORE applying overrides,
  // so overridden categories keep the original category's emoji
  const emoji = config.emojiOverrides?.[category] || getEmoji(category);

  // Apply category overrides (e.g., "bug" -> "defect")
  if (config.categoryOverrides && config.categoryOverrides[category]) {
    category = config.categoryOverrides[category];
  }
  const capitalizedCategory = capitalizeCategory(category);

  // Process conditional sections first, then replace individual placeholders
  const fieldValues = {
    suggestion: suggestionText || '',
    title: title || '',
    emoji,
    category: capitalizedCategory,
    description
  };

  let result = processConditionalSections(config.template, fieldValues);

  // Replace placeholders
  result = result.replace(/\{emoji\}/g, emoji);
  result = result.replace(/\{category\}/g, capitalizedCategory);
  result = result.replace(/\{title\}/g, title || '');
  result = result.replace(/\{description\}/g, description);
  result = result.replace(/\{suggestion\}/g, suggestionText || '');

  // Ensure code fences start on their own line
  result = result.replace(/([^\n])(```)/g, '$1\n$2');

  return result.trimEnd();
}

module.exports = { PRESETS, resolveFormat, formatAdoptedComment, capitalizeCategory, processConditionalSections };
