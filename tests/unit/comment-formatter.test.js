// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { PRESETS, resolveFormat, formatAdoptedComment, capitalizeCategory, processConditionalSections } from '../../src/utils/comment-formatter.js';

describe('comment-formatter', () => {
  describe('resolveFormat', () => {
    it('returns legacy preset for undefined config', () => {
      const result = resolveFormat(undefined);
      expect(result.template).toBe(PRESETS.legacy);
      expect(result.emojiOverrides).toEqual({});
      expect(result.categoryOverrides).toEqual({});
    });

    it('returns legacy preset for null config', () => {
      const result = resolveFormat(null);
      expect(result.template).toBe(PRESETS.legacy);
    });

    it('returns named preset', () => {
      const result = resolveFormat('minimal');
      expect(result.template).toBe(PRESETS.minimal);
    });

    it('returns legacy for unknown preset name', () => {
      const result = resolveFormat('nonexistent');
      expect(result.template).toBe(PRESETS.legacy);
    });

    it('accepts custom object config', () => {
      const config = {
        template: '{description} ({category})',
        emojiOverrides: { bug: '🔴' }
      };
      const result = resolveFormat(config);
      expect(result.template).toBe('{description} ({category})');
      expect(result.emojiOverrides).toEqual({ bug: '🔴' });
    });

    it('does not include showEmoji property', () => {
      const result = resolveFormat(undefined);
      expect(result).not.toHaveProperty('showEmoji');
    });

    it('does not include showEmoji in custom config', () => {
      const result = resolveFormat({ template: '{description}' });
      expect(result).not.toHaveProperty('showEmoji');
    });

    it('includes categoryOverrides from custom config', () => {
      const config = {
        template: '{description}',
        categoryOverrides: { bug: 'defect', performance: 'perf' }
      };
      const result = resolveFormat(config);
      expect(result.categoryOverrides).toEqual({ bug: 'defect', performance: 'perf' });
    });

    it('defaults categoryOverrides to empty object when not provided', () => {
      const config = { template: '{description}' };
      const result = resolveFormat(config);
      expect(result.categoryOverrides).toEqual({});
    });
  });

  describe('PRESETS', () => {
    it('has legacy preset with conditional suggestion', () => {
      expect(PRESETS.legacy).toBeDefined();
      expect(PRESETS.legacy).toContain('{emoji}');
      expect(PRESETS.legacy).toContain('{category}');
      expect(PRESETS.legacy).toContain('{?suggestion}');
      expect(PRESETS.legacy).toContain('{/suggestion}');
    });

    it('has maximal preset with conditional title and suggestion', () => {
      expect(PRESETS.maximal).toBeDefined();
      expect(PRESETS.maximal).toContain('{?title}');
      expect(PRESETS.maximal).toContain('{/title}');
      expect(PRESETS.maximal).toContain('{?suggestion}');
      expect(PRESETS.maximal).toContain('{/suggestion}');
      expect(PRESETS.maximal).toContain('{emoji}');
      expect(PRESETS.maximal).toContain('{category}');
      expect(PRESETS.maximal).toContain('{description}');
    });

    it('does not have a default key', () => {
      expect(PRESETS).not.toHaveProperty('default');
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

  describe('processConditionalSections', () => {
    it('keeps content when field is truthy', () => {
      const result = processConditionalSections(
        'before{?name} hello {name}{/name} after',
        { name: 'world' }
      );
      expect(result).toBe('before hello {name} after');
    });

    it('strips block when field is empty string', () => {
      const result = processConditionalSections(
        'before{?name} hello {name}{/name} after',
        { name: '' }
      );
      expect(result).toBe('before after');
    });

    it('strips block when field is null', () => {
      const result = processConditionalSections(
        'before{?name} hello{/name} after',
        { name: null }
      );
      expect(result).toBe('before after');
    });

    it('strips block when field is undefined', () => {
      const result = processConditionalSections(
        'before{?name} hello{/name} after',
        {}
      );
      expect(result).toBe('before after');
    });

    it('handles multiple conditional sections', () => {
      const result = processConditionalSections(
        '{?a}A{/a}{?b}B{/b}',
        { a: 'yes', b: '' }
      );
      expect(result).toBe('A');
    });

    it('handles multiple conditional sections with different fields', () => {
      const result = processConditionalSections(
        '{?title}: {title}{/title} - {?suggestion}({suggestion}){/suggestion}',
        { title: 'Hello', suggestion: '' }
      );
      expect(result).toBe(': {title} - ');
    });

    it('handles multiline content in conditional blocks', () => {
      const result = processConditionalSections(
        'start{?suggestion}\n\n**Suggestion:** {suggestion}{/suggestion}',
        { suggestion: 'fix it' }
      );
      expect(result).toBe('start\n\n**Suggestion:** {suggestion}');
    });

    it('removes multiline content when field is falsy', () => {
      const result = processConditionalSections(
        'start{?suggestion}\n\n**Suggestion:** {suggestion}{/suggestion}',
        { suggestion: '' }
      );
      expect(result).toBe('start');
    });
  });

  describe('formatAdoptedComment', () => {
    it('formats with legacy preset (current behavior)', () => {
      const config = resolveFormat('legacy');
      const result = formatAdoptedComment({
        body: 'There is a null check missing',
        suggestionText: 'Add a null check before accessing the property',
        category: 'bug'
      }, config);
      expect(result).toBe('🐛 **Bug**: There is a null check missing\n\n**Suggestion:** Add a null check before accessing the property');
    });

    it('formats with maximal preset including title', () => {
      const config = resolveFormat('maximal');
      const result = formatAdoptedComment({
        body: 'There is a null check missing',
        suggestionText: 'Add a null check before accessing the property',
        category: 'bug',
        title: 'Null Safety Issue'
      }, config);
      expect(result).toBe('🐛 **Bug**: Null Safety Issue\n\nThere is a null check missing\n\n**Suggestion:** Add a null check before accessing the property');
    });

    it('formats with maximal preset without title (strips title block)', () => {
      const config = resolveFormat('maximal');
      const result = formatAdoptedComment({
        body: 'Missing null check',
        suggestionText: 'Add null check',
        category: 'bug'
      }, config);
      // With conditional syntax, the ": {title}" block is stripped when title is missing
      expect(result).toBe('🐛 **Bug**\n\nMissing null check\n\n**Suggestion:** Add null check');
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
      const config = resolveFormat('legacy');
      const result = formatAdoptedComment({
        body: 'Some comment',
        category: null
      }, config);
      expect(result).toBe('Some comment');
    });

    it('omits suggestion block when no suggestion text', () => {
      const config = resolveFormat('legacy');
      const result = formatAdoptedComment({
        body: 'Great use of the builder pattern',
        category: 'praise'
      }, config);
      expect(result).toBe('⭐ **Praise**: Great use of the builder pattern');
    });

    it('handles legacy body with embedded suggestion (no separate suggestionText)', () => {
      const config = resolveFormat('legacy');
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
      const config = resolveFormat('legacy');
      const result = formatAdoptedComment({
        body: '',
        category: 'bug'
      }, config);
      expect(result).toBe('🐛 **Bug**:');
    });

    it('handles code-style category capitalization', () => {
      const config = resolveFormat('legacy');
      const result = formatAdoptedComment({
        body: 'Use const instead of let',
        category: 'code-style'
      }, config);
      expect(result).toBe('🎨 **Code Style**: Use const instead of let');
    });

    describe('categoryOverrides', () => {
      it('renames category when override matches', () => {
        const config = resolveFormat({
          template: '{emoji} **{category}**: {description}',
          categoryOverrides: { bug: 'defect' }
        });
        const result = formatAdoptedComment({
          body: 'Missing null check',
          category: 'bug'
        }, config);
        expect(result).toContain('**Defect**');
        expect(result).not.toContain('**Bug**');
        // Emoji should come from the original category, not the override
        expect(result).toContain('\u{1F41B}');
      });

      it('is case-insensitive on category key lookup', () => {
        const config = resolveFormat({
          template: '**{category}**: {description}',
          categoryOverrides: { performance: 'perf' }
        });
        const result = formatAdoptedComment({
          body: 'Slow query',
          category: 'Performance'
        }, config);
        expect(result).toContain('**Perf**');
      });

      it('passes through category unchanged when no override matches', () => {
        const config = resolveFormat({
          template: '**{category}**: {description}',
          categoryOverrides: { bug: 'defect' }
        });
        const result = formatAdoptedComment({
          body: 'Good work',
          category: 'praise'
        }, config);
        expect(result).toContain('**Praise**');
      });

      it('works with empty categoryOverrides', () => {
        const config = resolveFormat({
          template: '**{category}**: {description}',
          categoryOverrides: {}
        });
        const result = formatAdoptedComment({
          body: 'Fix the bug',
          category: 'bug'
        }, config);
        expect(result).toContain('**Bug**');
      });
    });

    describe('code fence fixup', () => {
      it('ensures code fences start on their own line after suggestion replacement', () => {
        const config = resolveFormat('legacy');
        const result = formatAdoptedComment({
          body: 'Use a guard clause',
          suggestionText: 'Add this:```js\nif (!x) return;\n```',
          category: 'bug'
        }, config);
        expect(result).toContain('Add this:\n```js');
        expect(result).not.toContain('Add this:```js');
      });

      it('leaves code fences that already start on their own line', () => {
        const config = resolveFormat('legacy');
        const result = formatAdoptedComment({
          body: 'Use a guard clause',
          suggestionText: 'Add this:\n```js\nif (!x) return;\n```',
          category: 'bug'
        }, config);
        expect(result).toContain('Add this:\n```js');
      });

      it('fixes multiple code fences in suggestion text', () => {
        const config = resolveFormat('legacy');
        const result = formatAdoptedComment({
          body: 'Before and after',
          suggestionText: 'Before:```js\nold();\n```After:```js\nnew();\n```',
          category: 'improvement'
        }, config);
        expect(result).toContain('Before:\n```js');
        expect(result).toContain('After:\n```js');
      });
    });
  });
});
