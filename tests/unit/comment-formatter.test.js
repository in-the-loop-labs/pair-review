// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { PRESETS, resolveFormat, formatAdoptedComment, capitalizeCategory } from '../../src/utils/comment-formatter.js';

describe('comment-formatter', () => {
  describe('resolveFormat', () => {
    it('returns default preset for undefined config', () => {
      const result = resolveFormat(undefined);
      expect(result.template).toBe(PRESETS.default);
      expect(result.showEmoji).toBe(true);
      expect(result.emojiOverrides).toEqual({});
    });

    it('returns default preset for null config', () => {
      const result = resolveFormat(null);
      expect(result.template).toBe(PRESETS.default);
    });

    it('returns named preset', () => {
      const result = resolveFormat('minimal');
      expect(result.template).toBe(PRESETS.minimal);
    });

    it('returns default for unknown preset name', () => {
      const result = resolveFormat('nonexistent');
      expect(result.template).toBe(PRESETS.default);
    });

    it('accepts custom object config', () => {
      const config = {
        template: '{description} ({category})',
        showEmoji: false,
        emojiOverrides: { bug: '🔴' }
      };
      const result = resolveFormat(config);
      expect(result.template).toBe('{description} ({category})');
      expect(result.showEmoji).toBe(false);
      expect(result.emojiOverrides).toEqual({ bug: '🔴' });
    });

    it('defaults showEmoji to true in custom config', () => {
      const result = resolveFormat({ template: '{description}' });
      expect(result.showEmoji).toBe(true);
    });
  });

  describe('capitalizeCategory', () => {
    it('capitalizes simple category', () => {
      expect(capitalizeCategory('bug')).toBe('Bug');
    });

    it('capitalizes hyphenated category', () => {
      expect(capitalizeCategory('code-style')).toBe('Code Style');
    });
  });

  describe('formatAdoptedComment', () => {
    it('formats with default preset (current behavior)', () => {
      const config = resolveFormat('default');
      const result = formatAdoptedComment({
        body: 'There is a null check missing',
        suggestionText: 'Add a null check before accessing the property',
        category: 'bug'
      }, config);
      expect(result).toBe('🐛 **Bug**: There is a null check missing\n\n**Suggestion:** Add a null check before accessing the property');
    });

    it('formats with minimal preset', () => {
      const config = resolveFormat('minimal');
      const result = formatAdoptedComment({
        body: 'Missing null check',
        suggestionText: 'Add null check',
        category: 'bug'
      }, config);
      expect(result).toBe('[Bug] Missing null check\n\nAdd null check');
    });

    it('formats with plain preset', () => {
      const config = resolveFormat('plain');
      const result = formatAdoptedComment({
        body: 'Missing null check',
        suggestionText: 'Add null check',
        category: 'bug'
      }, config);
      expect(result).toBe('Missing null check\n\nAdd null check');
    });

    it('formats with emoji-only preset', () => {
      const config = resolveFormat('emoji-only');
      const result = formatAdoptedComment({
        body: 'Missing null check',
        suggestionText: 'Add null check',
        category: 'bug'
      }, config);
      expect(result).toBe('🐛 Missing null check\n\nAdd null check');
    });

    it('returns body as-is when no category', () => {
      const config = resolveFormat('default');
      const result = formatAdoptedComment({
        body: 'Some comment',
        category: null
      }, config);
      expect(result).toBe('Some comment');
    });

    it('omits suggestion line when no suggestion text', () => {
      const config = resolveFormat('default');
      const result = formatAdoptedComment({
        body: 'Great use of the builder pattern',
        category: 'praise'
      }, config);
      expect(result).toBe('⭐ **Praise**: Great use of the builder pattern');
    });

    it('handles legacy body with embedded suggestion (no separate suggestionText)', () => {
      const config = resolveFormat('default');
      const result = formatAdoptedComment({
        body: 'Missing null check\n\n**Suggestion:** Add a guard clause',
        category: 'bug'
      }, config);
      expect(result).toBe('🐛 **Bug**: Missing null check\n\n**Suggestion:** Add a guard clause');
    });

    it('handles legacy body with minimal preset', () => {
      const config = resolveFormat('minimal');
      const result = formatAdoptedComment({
        body: 'Missing null check\n\n**Suggestion:** Add a guard clause',
        category: 'bug'
      }, config);
      expect(result).toBe('[Bug] Missing null check\n\nAdd a guard clause');
    });

    it('applies emoji overrides', () => {
      const config = resolveFormat({
        template: '{emoji} {description}',
        emojiOverrides: { bug: '🔴' }
      });
      const result = formatAdoptedComment({
        body: 'Missing null check',
        category: 'bug'
      }, config);
      expect(result).toBe('🔴 Missing null check');
    });

    it('uses title placeholder', () => {
      const config = resolveFormat({
        template: '**{title}**: {description}'
      });
      const result = formatAdoptedComment({
        body: 'Missing null check',
        category: 'bug',
        title: 'Null Safety'
      }, config);
      expect(result).toBe('**Null Safety**: Missing null check');
    });

    it('handles empty body', () => {
      const config = resolveFormat('default');
      const result = formatAdoptedComment({
        body: '',
        category: 'bug'
      }, config);
      expect(result).toBe('🐛 **Bug**:');
    });

    it('handles code-style category capitalization', () => {
      const config = resolveFormat('default');
      const result = formatAdoptedComment({
        body: 'Use const instead of let',
        category: 'code-style'
      }, config);
      expect(result).toBe('🎨 **Code Style**: Use const instead of let');
    });
  });
});
