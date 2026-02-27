// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared comment formatter for adopted AI suggestions.
 * Browser-compatible IIFE version.
 */

(function() {
  const PRESETS = {
    default: '{emoji} **{category}**: {description}\n\n**Suggestion:** {suggestion}',
    minimal: '[{category}] {description}\n\n{suggestion}',
    plain: '{description}\n\n{suggestion}',
    'emoji-only': '{emoji} {description}\n\n{suggestion}'
  };

  function resolveFormat(config) {
    if (!config || typeof config === 'string') {
      const presetName = config || 'default';
      const template = PRESETS[presetName] || PRESETS.default;
      return { template, showEmoji: true, emojiOverrides: {} };
    }

    return {
      template: config.template || PRESETS.default,
      showEmoji: config.showEmoji !== false,
      emojiOverrides: config.emojiOverrides || {}
    };
  }

  function capitalizeCategory(category) {
    return category
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  function formatAdoptedComment(fields, formatConfig) {
    const { body, category, title } = fields;
    let { suggestionText } = fields;

    if (!category) {
      return body || '';
    }

    let description = body || '';
    if (!suggestionText && description.includes('\n\n**Suggestion:** ')) {
      const splitIndex = description.indexOf('\n\n**Suggestion:** ');
      suggestionText = description.slice(splitIndex + '\n\n**Suggestion:** '.length);
      description = description.slice(0, splitIndex);
    }

    const config = formatConfig || resolveFormat();
    const getEmoji = window.CategoryEmoji?.getEmoji || (() => '\u{1F4AC}');
    const emoji = config.emojiOverrides?.[category] || getEmoji(category);
    const capitalizedCategory = capitalizeCategory(category);

    let result = config.template;

    result = result.replace(/\{emoji\}/g, emoji);
    result = result.replace(/\{category\}/g, capitalizedCategory);
    result = result.replace(/\{title\}/g, title || '');
    result = result.replace(/\{description\}/g, description);

    if (suggestionText) {
      result = result.replace(/\{suggestion\}/g, suggestionText);
    } else {
      result = result.split('\n').filter(line => !line.includes('{suggestion}')).join('\n');
    }

    return result.trimEnd();
  }

  window.CommentFormatter = { PRESETS, resolveFormat, formatAdoptedComment, capitalizeCategory };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = window.CommentFormatter;
}
