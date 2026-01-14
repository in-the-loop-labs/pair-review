// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests for the prompt optimization system
 */

import { describe, it, expect, vi } from 'vitest';
import { getPromptBuilder, isPromptAvailable, interpolate, stripSectionTags } from '../../src/ai/prompts/index.js';
import { resolveTier, getTierForModel, TIERS, PROMPT_TYPES } from '../../src/ai/prompts/config.js';

describe('Prompt System Configuration', () => {
  describe('resolveTier', () => {
    it('should resolve user-friendly tier aliases', () => {
      expect(resolveTier('free')).toBe('fast');
      expect(resolveTier('standard')).toBe('balanced');
      expect(resolveTier('premium')).toBe('thorough');
    });

    it('should pass through internal tier names', () => {
      expect(resolveTier('fast')).toBe('fast');
      expect(resolveTier('balanced')).toBe('balanced');
      expect(resolveTier('thorough')).toBe('thorough');
    });

    it('should handle unknown tiers by returning as-is', () => {
      expect(resolveTier('unknown')).toBe('unknown');
    });
  });

  describe('getTierForModel', () => {
    it('should return correct tier for Claude models', () => {
      expect(getTierForModel('claude', 'haiku')).toBe('fast');
      expect(getTierForModel('claude', 'sonnet')).toBe('balanced');
      expect(getTierForModel('claude', 'opus')).toBe('thorough');
    });

    it('should return correct tier for Gemini models', () => {
      expect(getTierForModel('gemini', 'gemini-2.0-flash')).toBe('fast');
      expect(getTierForModel('gemini', 'gemini-2.5-pro')).toBe('balanced');
    });

    it('should return null for unknown models', () => {
      // Explicit over implicit - we don't guess tiers for unknown models
      expect(getTierForModel('claude', 'unknown-model')).toBeNull();
      expect(getTierForModel('unknown-provider', 'any-model')).toBeNull();
    });
  });

  describe('constants', () => {
    it('should export valid TIERS', () => {
      expect(TIERS).toContain('fast');
      expect(TIERS).toContain('balanced');
      expect(TIERS).toContain('thorough');
    });

    it('should export valid PROMPT_TYPES', () => {
      expect(PROMPT_TYPES).toContain('level1');
      expect(PROMPT_TYPES).toContain('level2');
      expect(PROMPT_TYPES).toContain('level3');
      expect(PROMPT_TYPES).toContain('orchestration');
    });
  });
});

describe('Prompt Builder', () => {
  describe('getPromptBuilder', () => {
    it('should return a builder for Level 2 Balanced', () => {
      const builder = getPromptBuilder('level2', 'balanced');
      expect(builder).not.toBeNull();
      expect(builder.promptType).toBe('level2');
      expect(builder.tier).toBe('balanced');
      expect(builder.provider).toBe('claude');
    });

    it('should resolve tier aliases', () => {
      const builder = getPromptBuilder('level2', 'standard');
      expect(builder).not.toBeNull();
      expect(builder.tier).toBe('balanced');
    });

    it('should return null for non-migrated prompts', () => {
      expect(getPromptBuilder('level1', 'balanced')).toBeNull();
      expect(getPromptBuilder('level3', 'balanced')).toBeNull();
      expect(getPromptBuilder('orchestration', 'balanced')).toBeNull();
    });

    it('should throw for invalid prompt types', () => {
      expect(() => getPromptBuilder('invalid', 'balanced')).toThrow('Invalid prompt type');
    });

    it('should throw for invalid tiers', () => {
      expect(() => getPromptBuilder('level2', 'invalid')).toThrow('Invalid tier');
    });
  });

  describe('builder.build()', () => {
    it('should interpolate context values into the prompt', () => {
      const builder = getPromptBuilder('level2', 'balanced');
      const context = {
        reviewIntro: 'You are reviewing PR #123',
        prContext: '## PR Context\nTitle: Test PR',
        customInstructions: '',
        lineNumberGuidance: '## Line Numbers\nUse annotated diff',
        generatedFiles: '',
        validFiles: '- src/test.js\n- src/app.js'
      };

      const prompt = builder.build(context);

      expect(prompt).toContain('You are reviewing PR #123');
      expect(prompt).toContain('## PR Context');
      expect(prompt).toContain('Title: Test PR');
      expect(prompt).toContain('- src/test.js');
      expect(prompt).toContain('- src/app.js');
      // Should not contain XML section tags
      expect(prompt).not.toMatch(/<section[^>]*>/);
      expect(prompt).not.toContain('</section>');
    });

    it('should handle empty optional sections gracefully', () => {
      const builder = getPromptBuilder('level2', 'balanced');
      const context = {
        reviewIntro: 'Review intro',
        prContext: 'PR context',
        customInstructions: '',  // Empty optional section
        lineNumberGuidance: 'Line guidance',
        generatedFiles: '',  // Empty optional section
        validFiles: '- file.js'
      };

      const prompt = builder.build(context);
      // Should not have excessive blank lines
      expect(prompt).not.toMatch(/\n{4,}/);
    });
  });

  describe('builder.buildTagged()', () => {
    it('should preserve XML section tags', () => {
      const builder = getPromptBuilder('level2', 'balanced');
      const context = {
        reviewIntro: 'Test intro',
        prContext: 'Test context',
        customInstructions: '',
        lineNumberGuidance: 'Test guidance',
        generatedFiles: '',
        validFiles: '- file.js'
      };

      const tagged = builder.buildTagged(context);
      expect(tagged).toMatch(/<section name="role"[^>]*>/);
      expect(tagged).toContain('</section>');
    });
  });

  describe('builder.getSections()', () => {
    it('should return section metadata', () => {
      const builder = getPromptBuilder('level2', 'balanced');
      const sections = builder.getSections();

      expect(sections).toBeInstanceOf(Array);
      expect(sections.length).toBeGreaterThan(0);

      // Check for expected sections
      const sectionNames = sections.map(s => s.name);
      expect(sectionNames).toContain('role');
      expect(sectionNames).toContain('pr-context');
      expect(sectionNames).toContain('output-schema');
      expect(sectionNames).toContain('valid-files');
    });

    it('should have correct section attributes', () => {
      const builder = getPromptBuilder('level2', 'balanced');
      const sections = builder.getSections();

      // Check locked sections
      const outputSchema = sections.find(s => s.name === 'output-schema');
      expect(outputSchema.locked).toBe(true);

      const validFiles = sections.find(s => s.name === 'valid-files');
      expect(validFiles.locked).toBe(true);

      // Check required sections
      const role = sections.find(s => s.name === 'role');
      expect(role.required).toBe(true);

      // Check optional sections
      const customInstructions = sections.find(s => s.name === 'custom-instructions');
      expect(customInstructions.optional).toBe(true);
    });
  });
});

describe('Utility Functions', () => {
  describe('isPromptAvailable', () => {
    it('should return true for migrated prompts', () => {
      expect(isPromptAvailable('level2', 'balanced')).toBe(true);
      expect(isPromptAvailable('level2', 'standard')).toBe(true);  // Alias
    });

    it('should return false for non-migrated prompts', () => {
      expect(isPromptAvailable('level1', 'balanced')).toBe(false);
      expect(isPromptAvailable('level2', 'fast')).toBe(false);
      expect(isPromptAvailable('level2', 'thorough')).toBe(false);
    });
  });

  describe('interpolate', () => {
    it('should replace placeholders with context values', () => {
      const template = 'Hello {{name}}, you have {{count}} messages';
      const context = { name: 'Alice', count: 5 };
      expect(interpolate(template, context)).toBe('Hello Alice, you have 5 messages');
    });

    it('should leave unknown placeholders as-is', () => {
      const template = 'Hello {{name}}, value is {{unknown}}';
      const context = { name: 'Bob' };
      expect(interpolate(template, context)).toBe('Hello Bob, value is {{unknown}}');
    });

    it('should handle empty string values', () => {
      const template = 'Value: {{value}}';
      const context = { value: '' };
      expect(interpolate(template, context)).toBe('Value: ');
    });

    it('should handle null/undefined values as empty string', () => {
      const template = '{{a}} and {{b}}';
      const context = { a: null, b: undefined };
      expect(interpolate(template, context)).toBe(' and ');
    });
  });

  describe('stripSectionTags', () => {
    it('should remove XML section tags but keep content', () => {
      const tagged = `<section name="role" required="true">
You are a code reviewer.
</section>

<section name="output" locked="true">
Output JSON.
</section>`;

      const stripped = stripSectionTags(tagged);
      expect(stripped).toContain('You are a code reviewer.');
      expect(stripped).toContain('Output JSON.');
      expect(stripped).not.toContain('<section');
      expect(stripped).not.toContain('</section>');
    });
  });
});

describe('Baseline Level 2 Balanced', () => {
  it('should have all required sections', () => {
    const baseline = require('../../src/ai/prompts/baseline/level2/balanced.js');

    expect(baseline.taggedPrompt).toBeDefined();
    expect(baseline.sections).toBeDefined();
    expect(baseline.defaultOrder).toBeDefined();

    // Check required sections exist
    const requiredSections = ['role', 'pr-context', 'valid-files', 'output-schema', 'guidelines'];
    for (const name of requiredSections) {
      expect(baseline.defaultOrder).toContain(name);
    }
  });

  it('should have valid locked sections', () => {
    const baseline = require('../../src/ai/prompts/baseline/level2/balanced.js');
    const parsed = baseline.parseSections();

    // Check that locked sections exist and are marked correctly
    const lockedSections = parsed.filter(s => s.locked);
    const lockedNames = lockedSections.map(s => s.name);

    expect(lockedNames).toContain('pr-context');
    expect(lockedNames).toContain('valid-files');
    expect(lockedNames).toContain('output-schema');
  });

  it('should parse sections correctly', () => {
    const baseline = require('../../src/ai/prompts/baseline/level2/balanced.js');
    const parsed = baseline.parseSections();

    expect(parsed.length).toBeGreaterThan(0);

    // Each parsed section should have expected properties
    for (const section of parsed) {
      expect(section).toHaveProperty('name');
      expect(section).toHaveProperty('content');
      expect(section).toHaveProperty('locked');
      expect(section).toHaveProperty('required');
      expect(section).toHaveProperty('optional');
    }
  });
});
