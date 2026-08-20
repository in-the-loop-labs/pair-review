// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the prompt optimization system
 */

import { describe, it, expect, vi } from 'vitest';
import { getPromptBuilder, isPromptAvailable, interpolate, stripSectionTags } from '../../src/ai/prompts/index.js';
import { resolveTier, TIERS, PROMPT_TYPES } from '../../src/ai/prompts/config.js';

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

    it('should throw for unknown tiers', () => {
      expect(() => resolveTier('unknown')).toThrow(/Unknown tier/);
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

    it('should return a builder for Level 1 Balanced', () => {
      const builder = getPromptBuilder('level1', 'balanced');
      expect(builder).not.toBeNull();
      expect(builder.promptType).toBe('level1');
      expect(builder.tier).toBe('balanced');
    });

    it('should return a builder for Level 1 Fast', () => {
      const builder = getPromptBuilder('level1', 'fast');
      expect(builder).not.toBeNull();
      expect(builder.promptType).toBe('level1');
      expect(builder.tier).toBe('fast');
    });

    it('should resolve free alias to fast tier', () => {
      const builder = getPromptBuilder('level1', 'free');
      expect(builder).not.toBeNull();
      expect(builder.tier).toBe('fast');
    });

    it('should return a builder for Level 1 Thorough', () => {
      const builder = getPromptBuilder('level1', 'thorough');
      expect(builder).not.toBeNull();
      expect(builder.promptType).toBe('level1');
      expect(builder.tier).toBe('thorough');
    });

    it('should resolve premium alias to thorough tier', () => {
      const builder = getPromptBuilder('level1', 'premium');
      expect(builder).not.toBeNull();
      expect(builder.tier).toBe('thorough');
    });

    it('should return a builder for Level 2 Fast', () => {
      const builder = getPromptBuilder('level2', 'fast');
      expect(builder).not.toBeNull();
      expect(builder.promptType).toBe('level2');
      expect(builder.tier).toBe('fast');
    });

    it('should resolve free alias to fast tier for Level 2', () => {
      const builder = getPromptBuilder('level2', 'free');
      expect(builder).not.toBeNull();
      expect(builder.tier).toBe('fast');
    });

    it('should return a builder for Level 3 Balanced', () => {
      const builder = getPromptBuilder('level3', 'balanced');
      expect(builder).not.toBeNull();
      expect(builder.promptType).toBe('level3');
      expect(builder.tier).toBe('balanced');
    });

    it('should resolve standard alias to balanced tier for Level 3', () => {
      const builder = getPromptBuilder('level3', 'standard');
      expect(builder).not.toBeNull();
      expect(builder.tier).toBe('balanced');
    });

    it('should return a builder for Level 3 Fast', () => {
      const builder = getPromptBuilder('level3', 'fast');
      expect(builder).not.toBeNull();
      expect(builder.promptType).toBe('level3');
      expect(builder.tier).toBe('fast');
    });

    it('should resolve free alias to fast tier for Level 3', () => {
      const builder = getPromptBuilder('level3', 'free');
      expect(builder).not.toBeNull();
      expect(builder.tier).toBe('fast');
    });

    it('should return a builder for Level 3 Thorough', () => {
      const builder = getPromptBuilder('level3', 'thorough');
      expect(builder).not.toBeNull();
      expect(builder.promptType).toBe('level3');
      expect(builder.tier).toBe('thorough');
    });

    it('should resolve premium alias to thorough tier for Level 3', () => {
      const builder = getPromptBuilder('level3', 'premium');
      expect(builder).not.toBeNull();
      expect(builder.tier).toBe('thorough');
    });

    it('should return a builder for Orchestration Balanced', () => {
      const builder = getPromptBuilder('orchestration', 'balanced');
      expect(builder).not.toBeNull();
      expect(builder.promptType).toBe('orchestration');
      expect(builder.tier).toBe('balanced');
    });

    it('should resolve standard alias to balanced tier for Orchestration', () => {
      const builder = getPromptBuilder('orchestration', 'standard');
      expect(builder).not.toBeNull();
      expect(builder.tier).toBe('balanced');
    });

    it('should return a builder for Orchestration Fast', () => {
      const builder = getPromptBuilder('orchestration', 'fast');
      expect(builder).not.toBeNull();
      expect(builder.promptType).toBe('orchestration');
      expect(builder.tier).toBe('fast');
    });

    it('should resolve free alias to fast tier for Orchestration', () => {
      const builder = getPromptBuilder('orchestration', 'free');
      expect(builder).not.toBeNull();
      expect(builder.tier).toBe('fast');
    });

    it('should return a builder for Orchestration Thorough', () => {
      const builder = getPromptBuilder('orchestration', 'thorough');
      expect(builder).not.toBeNull();
      expect(builder.promptType).toBe('orchestration');
      expect(builder.tier).toBe('thorough');
    });

    it('should resolve premium alias to thorough tier for Orchestration', () => {
      const builder = getPromptBuilder('orchestration', 'premium');
      expect(builder).not.toBeNull();
      expect(builder.tier).toBe('thorough');
    });

    it('should throw for invalid prompt types', () => {
      expect(() => getPromptBuilder('invalid', 'balanced')).toThrow('Invalid prompt type');
    });

    it('should throw for invalid tiers', () => {
      expect(() => getPromptBuilder('level2', 'invalid')).toThrow(/Unknown tier/);
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
      expect(isPromptAvailable('level1', 'fast')).toBe(true);
      expect(isPromptAvailable('level1', 'free')).toBe(true);  // Alias for fast
      expect(isPromptAvailable('level1', 'balanced')).toBe(true);
      expect(isPromptAvailable('level1', 'standard')).toBe(true);  // Alias
      expect(isPromptAvailable('level1', 'thorough')).toBe(true);
      expect(isPromptAvailable('level1', 'premium')).toBe(true);  // Alias for thorough
      expect(isPromptAvailable('level2', 'balanced')).toBe(true);
      expect(isPromptAvailable('level2', 'standard')).toBe(true);  // Alias
    });

    it('should return a builder for Level 2 Thorough', () => {
      const builder = getPromptBuilder('level2', 'thorough');
      expect(builder).not.toBeNull();
      expect(builder.promptType).toBe('level2');
      expect(builder.tier).toBe('thorough');
    });

    it('should resolve premium alias to thorough tier for Level 2', () => {
      const builder = getPromptBuilder('level2', 'premium');
      expect(builder).not.toBeNull();
      expect(builder.tier).toBe('thorough');
    });

    it('should return true for Level 3 Balanced', () => {
      expect(isPromptAvailable('level3', 'balanced')).toBe(true);
      expect(isPromptAvailable('level3', 'standard')).toBe(true);  // Alias for balanced
    });

    it('should return true for Level 3 Fast', () => {
      expect(isPromptAvailable('level3', 'fast')).toBe(true);
      expect(isPromptAvailable('level3', 'free')).toBe(true);  // Alias for fast
    });

    it('should return true for Level 3 Thorough', () => {
      expect(isPromptAvailable('level3', 'thorough')).toBe(true);
      expect(isPromptAvailable('level3', 'premium')).toBe(true);  // Alias for thorough
    });

    it('should return true for Level 2 Fast', () => {
      expect(isPromptAvailable('level2', 'fast')).toBe(true);
      expect(isPromptAvailable('level2', 'free')).toBe(true);  // Alias for fast
    });

    it('should return true for Level 2 Thorough', () => {
      expect(isPromptAvailable('level2', 'thorough')).toBe(true);
      expect(isPromptAvailable('level2', 'premium')).toBe(true);  // Alias for thorough
    });

    it('should return true for Orchestration Balanced', () => {
      expect(isPromptAvailable('orchestration', 'balanced')).toBe(true);
      expect(isPromptAvailable('orchestration', 'standard')).toBe(true);  // Alias for balanced
    });

    it('should return true for Orchestration Fast', () => {
      expect(isPromptAvailable('orchestration', 'fast')).toBe(true);
      expect(isPromptAvailable('orchestration', 'free')).toBe(true);  // Alias for fast
    });

    it('should return true for Orchestration Thorough', () => {
      expect(isPromptAvailable('orchestration', 'thorough')).toBe(true);
      expect(isPromptAvailable('orchestration', 'premium')).toBe(true);  // Alias for thorough
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

describe('Baseline Level 1 Balanced', () => {
  it('should have all required sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/balanced.js');

    expect(baseline.taggedPrompt).toBeDefined();
    expect(baseline.sections).toBeDefined();
    expect(baseline.defaultOrder).toBeDefined();

    // Check required sections exist
    const requiredSections = ['role', 'pr-context', 'valid-files', 'output-schema', 'guidelines'];
    for (const name of requiredSections) {
      expect(baseline.defaultOrder).toContain(name);
    }
  });

  it('should have valid locked sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/balanced.js');
    const parsed = baseline.parseSections();

    // Check that locked sections exist and are marked correctly
    const lockedSections = parsed.filter(s => s.locked);
    const lockedNames = lockedSections.map(s => s.name);

    expect(lockedNames).toContain('pr-context');
    expect(lockedNames).toContain('valid-files');
    expect(lockedNames).toContain('output-schema');
  });

  it('should parse sections correctly', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/balanced.js');
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

  it('should NOT have fileLevelSuggestions in output schema', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/balanced.js');
    expect(baseline.taggedPrompt).not.toContain('fileLevelSuggestions');
  });

  it('should have Level 1 specific sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/balanced.js');

    // Level 1 specific sections
    expect(baseline.defaultOrder).toContain('speed-expectations');
    expect(baseline.defaultOrder).toContain('initial-setup');
    expect(baseline.defaultOrder).toContain('category-definitions');

    // Should NOT have Level 2+ sections
    expect(baseline.defaultOrder).not.toContain('analysis-process');
    expect(baseline.defaultOrder).not.toContain('file-level-guidance');
  });
});

describe('Baseline Level 1 Fast', () => {
  it('should have all required sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/fast.js');

    expect(baseline.taggedPrompt).toBeDefined();
    expect(baseline.sections).toBeDefined();
    expect(baseline.defaultOrder).toBeDefined();

    // Check required sections exist
    const requiredSections = ['role', 'pr-context', 'valid-files', 'output-schema', 'guidelines'];
    for (const name of requiredSections) {
      expect(baseline.defaultOrder).toContain(name);
    }
  });

  it('should have valid locked sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/fast.js');
    const parsed = baseline.parseSections();

    // Check that locked sections exist and are marked correctly
    const lockedSections = parsed.filter(s => s.locked);
    const lockedNames = lockedSections.map(s => s.name);

    expect(lockedNames).toContain('pr-context');
    expect(lockedNames).toContain('valid-files');
    expect(lockedNames).toContain('output-schema');
  });

  it('should parse sections correctly', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/fast.js');
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

  it('should NOT have fileLevelSuggestions in output schema', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/fast.js');
    expect(baseline.taggedPrompt).not.toContain('fileLevelSuggestions');
  });

  it('should be shorter than balanced variant', async () => {
    const fast = await import('../../src/ai/prompts/baseline/level1/fast.js');
    const balanced = await import('../../src/ai/prompts/baseline/level1/balanced.js');

    // Fast should have fewer characters
    expect(fast.taggedPrompt.length).toBeLessThan(balanced.taggedPrompt.length);
  });

  it('should NOT have speed-expectations or category-definitions sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/fast.js');

    // These sections were removed for the fast tier
    expect(baseline.defaultOrder).not.toContain('speed-expectations');
    expect(baseline.defaultOrder).not.toContain('category-definitions');
  });

  it('should have tier attributes on sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/fast.js');
    const parsed = baseline.parseSections();

    // At least some sections should have tier attributes
    const sectionsWithTier = parsed.filter(s => s.tier);
    expect(sectionsWithTier.length).toBeGreaterThan(0);

    // Sections with tier should include 'fast'
    for (const section of sectionsWithTier) {
      expect(section.tier).toContain('fast');
    }
  });

  it('should build correctly with context', () => {
    const builder = getPromptBuilder('level1', 'fast');
    const context = {
      reviewIntro: 'You are reviewing PR #456',
      prContext: '## PR Context\nTitle: Fast Test PR',
      customInstructions: '',
      lineNumberGuidance: '## Line Numbers\nUse annotated diff',
      generatedFiles: '',
      validFiles: '- src/fast.js'
    };

    const prompt = builder.build(context);

    expect(prompt).toContain('You are reviewing PR #456');
    expect(prompt).toContain('## PR Context');
    expect(prompt).toContain('- src/fast.js');
    expect(prompt).toContain('Quick Diff Analysis');
    // Should not contain XML section tags
    expect(prompt).not.toMatch(/<section[^>]*>/);
    expect(prompt).not.toContain('</section>');
  });
});

describe('Baseline Level 1 Thorough', () => {
  it('should have all required sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/thorough.js');

    expect(baseline.taggedPrompt).toBeDefined();
    expect(baseline.sections).toBeDefined();
    expect(baseline.defaultOrder).toBeDefined();

    // Check required sections exist
    const requiredSections = ['role', 'pr-context', 'valid-files', 'output-schema', 'guidelines'];
    for (const name of requiredSections) {
      expect(baseline.defaultOrder).toContain(name);
    }
  });

  it('should have valid locked sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/thorough.js');
    const parsed = baseline.parseSections();

    // Check that locked sections exist and are marked correctly
    const lockedSections = parsed.filter(s => s.locked);
    const lockedNames = lockedSections.map(s => s.name);

    expect(lockedNames).toContain('pr-context');
    expect(lockedNames).toContain('valid-files');
    expect(lockedNames).toContain('output-schema');
  });

  it('should parse sections correctly', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/thorough.js');
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

  it('should NOT have fileLevelSuggestions in output schema', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/thorough.js');
    expect(baseline.taggedPrompt).not.toContain('fileLevelSuggestions');
  });

  it('should be longer than balanced variant', async () => {
    const thorough = await import('../../src/ai/prompts/baseline/level1/thorough.js');
    const balanced = await import('../../src/ai/prompts/baseline/level1/balanced.js');

    // Thorough should have more characters (more comprehensive)
    expect(thorough.taggedPrompt.length).toBeGreaterThan(balanced.taggedPrompt.length);
  });

  it('should have thorough-specific sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/thorough.js');

    // These sections are specific to the thorough tier
    expect(baseline.defaultOrder).toContain('mission');
    expect(baseline.defaultOrder).toContain('verification-standard');
    expect(baseline.defaultOrder).toContain('do-not-report');
    expect(baseline.defaultOrder).toContain('confidence-guidance');
    // Removed for the frontier-model redesign: no category tutoring or
    // reasoning-encouragement boilerplate
    expect(baseline.defaultOrder).not.toContain('category-definitions');
    expect(baseline.defaultOrder).not.toContain('reasoning-encouragement');
  });

  it('should have tier attributes on sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/thorough.js');
    const parsed = baseline.parseSections();

    // At least some sections should have tier attributes
    const sectionsWithTier = parsed.filter(s => s.tier);
    expect(sectionsWithTier.length).toBeGreaterThan(0);

    // Sections with tier should include 'thorough'
    for (const section of sectionsWithTier) {
      expect(section.tier).toContain('thorough');
    }
  });

  it('should have focused confidence guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/thorough.js');

    // Should have confidence calibration that separates confidence from severity
    expect(baseline.taggedPrompt).toContain('High (0.8-1.0)');
    expect(baseline.taggedPrompt).toContain('Medium (0.5-0.79)');
    expect(baseline.taggedPrompt).toContain('Low (0.3-0.49)');
    expect(baseline.taggedPrompt).toContain('Very low (<0.3)');
    // Key conceptual distinction
    expect(baseline.taggedPrompt).toContain('Confidence is about certainty, not severity');
  });

  it('should have prioritized focus areas', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/thorough.js');

    // Prioritized hunting list: security first, then correctness, praise capped
    expect(baseline.taggedPrompt).toContain('## What to Hunt For');
    expect(baseline.taggedPrompt).toContain('**Security**');
    expect(baseline.taggedPrompt).toContain('**Correctness**');
    expect(baseline.taggedPrompt).toContain('**Over-engineering**');
    expect(baseline.taggedPrompt).toContain('**Praise**');
    expect(baseline.taggedPrompt.indexOf('**Security**'))
      .toBeLessThan(baseline.taggedPrompt.indexOf('**Correctness**'));
  });

  it('should have a verification standard requiring failure scenarios and refutation', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/thorough.js');

    expect(baseline.taggedPrompt).toContain('## Verification Standard');
    expect(baseline.taggedPrompt).toContain('State the failure concretely');
    expect(baseline.taggedPrompt).toContain('Try to refute it');
    // Security findings are framed as exploits, with the fix in the suggestion
    expect(baseline.taggedPrompt).toContain('Security findings are attack scenarios');
    expect(baseline.taggedPrompt).toContain('report it as hardening at reduced confidence');
    // Simplicity findings need a concrete simpler alternative, or they're style
    expect(baseline.taggedPrompt).toContain('Simplicity findings must show the simpler version');
    // Refutation asymmetry: drops require positive refutation evidence;
    // unverifiable-but-concrete findings surface as low-confidence questions
    // (eval 2026-08-15: suppression-by-doubt removes genuine defects, not
    // incorrect ones — borderline findings go up for downstream adjudication)
    expect(baseline.taggedPrompt).toContain('Discard only what you actually refuted');
    expect(baseline.taggedPrompt).toContain('neither confirm nor refute');
  });

  it('should have a do-not-report list', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/thorough.js');

    expect(baseline.taggedPrompt).toContain('## Do Not Report');
    expect(baseline.taggedPrompt).toContain('Pre-existing issues');
    expect(baseline.taggedPrompt).toContain('linter');
    // Carve-out: unverifiable high-impact hazards survive as questions instead
    // of being silently dropped (widened beyond races/ordering/lifecycle)
    expect(baseline.taggedPrompt).toContain('Exception: a high-impact hazard you cannot statically verify');
    expect(baseline.taggedPrompt).toContain('environment- or configuration-dependent behavior');
    // Scoped as "don't hunt for test gaps", not a ban on the severity category
    // (severity-classification lists test coverage as medium)
    expect(baseline.taggedPrompt).toContain('do not go looking for missing tests here');
    expect(baseline.taggedPrompt).not.toContain('Missing tests — Level 3 evaluates test coverage');
    // The 0.3 floor stays (matches the pipeline filter), but the futility
    // framing that taught self-censorship must not return
    expect(baseline.taggedPrompt).not.toContain('the pipeline discards them anyway');
  });

  it('should have a depth-first mission without checklist padding', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/thorough.js');

    expect(baseline.taggedPrompt).toContain('## Mission');
    expect(baseline.taggedPrompt).toContain('depth-first');
    expect(baseline.taggedPrompt).toContain('Do not manufacture findings');
  });

  it('should have consistent scope guidance (no contradictions)', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level1/thorough.js');

    // The scope section resolves the old contradiction: verification reads
    // are allowed, but findings must be about the change itself
    expect(baseline.taggedPrompt).toContain('## Scope');
    expect(baseline.taggedPrompt).toContain('verification is never scope creep');
    // The old contradictory instructions must be gone
    expect(baseline.taggedPrompt).not.toContain('Do not analyze file context or surrounding unchanged code');
    expect(baseline.taggedPrompt).not.toContain('Do not review unchanged code or missing tests');
  });

  it('should build correctly with context', () => {
    const builder = getPromptBuilder('level1', 'thorough');
    const context = {
      reviewIntro: 'You are reviewing PR #789',
      prContext: '## PR Context\nTitle: Thorough Test PR',
      customInstructions: '',
      lineNumberGuidance: '## Line Numbers\nUse annotated diff',
      generatedFiles: '',
      validFiles: '- src/thorough.js'
    };

    const prompt = builder.build(context);

    expect(prompt).toContain('You are reviewing PR #789');
    expect(prompt).toContain('## PR Context');
    expect(prompt).toContain('- src/thorough.js');
    expect(prompt).toContain('Deep Diff Analysis');
    // Should not contain XML section tags
    expect(prompt).not.toMatch(/<section[^>]*>/);
    expect(prompt).not.toContain('</section>');
  });

  it('should resolve premium alias to thorough tier', () => {
    const builder = getPromptBuilder('level1', 'premium');
    expect(builder).not.toBeNull();
    expect(builder.tier).toBe('thorough');
  });
});

describe('Baseline Level 2 Fast', () => {
  it('should have all required sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/fast.js');

    expect(baseline.taggedPrompt).toBeDefined();
    expect(baseline.sections).toBeDefined();
    expect(baseline.defaultOrder).toBeDefined();

    // Check required sections exist
    const requiredSections = ['role', 'pr-context', 'valid-files', 'output-schema', 'guidelines'];
    for (const name of requiredSections) {
      expect(baseline.defaultOrder).toContain(name);
    }
  });

  it('should have valid locked sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/fast.js');
    const parsed = baseline.parseSections();

    // Check that locked sections exist and are marked correctly
    const lockedSections = parsed.filter(s => s.locked);
    const lockedNames = lockedSections.map(s => s.name);

    expect(lockedNames).toContain('pr-context');
    expect(lockedNames).toContain('valid-files');
    expect(lockedNames).toContain('output-schema');
  });

  it('should parse sections correctly', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/fast.js');
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

  it('should have fileLevelSuggestions in output schema (Level 2 feature)', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/fast.js');
    expect(baseline.taggedPrompt).toContain('fileLevelSuggestions');
  });

  it('should be shorter than balanced variant', async () => {
    const fast = await import('../../src/ai/prompts/baseline/level2/fast.js');
    const balanced = await import('../../src/ai/prompts/baseline/level2/balanced.js');

    // Fast should have fewer characters
    expect(fast.taggedPrompt.length).toBeLessThan(balanced.taggedPrompt.length);
  });

  it('should NOT have file-level-guidance section', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/fast.js');

    // This section was removed for the fast tier (tier="balanced,thorough")
    expect(baseline.defaultOrder).not.toContain('file-level-guidance');
  });

  it('should have tier attributes on sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/fast.js');
    const parsed = baseline.parseSections();

    // At least some sections should have tier attributes
    const sectionsWithTier = parsed.filter(s => s.tier);
    expect(sectionsWithTier.length).toBeGreaterThan(0);

    // Sections with tier should include 'fast'
    for (const section of sectionsWithTier) {
      expect(section.tier).toContain('fast');
    }
  });

  it('should build correctly with context', () => {
    const builder = getPromptBuilder('level2', 'fast');
    const context = {
      reviewIntro: 'You are reviewing PR #456',
      prContext: '## PR Context\nTitle: Fast Level 2 Test PR',
      customInstructions: '',
      lineNumberGuidance: '## Line Numbers\nUse annotated diff',
      generatedFiles: '',
      validFiles: '- src/fast.js'
    };

    const prompt = builder.build(context);

    expect(prompt).toContain('You are reviewing PR #456');
    expect(prompt).toContain('## PR Context');
    expect(prompt).toContain('- src/fast.js');
    expect(prompt).toContain('Quick File Context Analysis');
    // Should not contain XML section tags
    expect(prompt).not.toMatch(/<section[^>]*>/);
    expect(prompt).not.toContain('</section>');
  });

  it('should have Level 2 specific sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/fast.js');

    // Level 2 specific sections
    expect(baseline.defaultOrder).toContain('analysis-process');

    // Should NOT have Level 1 specific sections
    expect(baseline.defaultOrder).not.toContain('speed-expectations');
    expect(baseline.defaultOrder).not.toContain('initial-setup');
    expect(baseline.defaultOrder).not.toContain('category-definitions');
  });
});

describe('Baseline Level 2 Balanced', () => {
  it('should have all required sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/balanced.js');

    expect(baseline.taggedPrompt).toBeDefined();
    expect(baseline.sections).toBeDefined();
    expect(baseline.defaultOrder).toBeDefined();

    // Check required sections exist
    const requiredSections = ['role', 'pr-context', 'valid-files', 'output-schema', 'guidelines'];
    for (const name of requiredSections) {
      expect(baseline.defaultOrder).toContain(name);
    }
  });

  it('should have valid locked sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/balanced.js');
    const parsed = baseline.parseSections();

    // Check that locked sections exist and are marked correctly
    const lockedSections = parsed.filter(s => s.locked);
    const lockedNames = lockedSections.map(s => s.name);

    expect(lockedNames).toContain('pr-context');
    expect(lockedNames).toContain('valid-files');
    expect(lockedNames).toContain('output-schema');
  });

  it('should parse sections correctly', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/balanced.js');
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

describe('Baseline Level 2 Thorough', () => {
  it('should have all required sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/thorough.js');

    expect(baseline.taggedPrompt).toBeDefined();
    expect(baseline.sections).toBeDefined();
    expect(baseline.defaultOrder).toBeDefined();

    // Check required sections exist
    const requiredSections = ['role', 'pr-context', 'valid-files', 'output-schema', 'guidelines'];
    for (const name of requiredSections) {
      expect(baseline.defaultOrder).toContain(name);
    }
  });

  it('should have valid locked sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/thorough.js');
    const parsed = baseline.parseSections();

    // Check that locked sections exist and are marked correctly
    const lockedSections = parsed.filter(s => s.locked);
    const lockedNames = lockedSections.map(s => s.name);

    expect(lockedNames).toContain('pr-context');
    expect(lockedNames).toContain('valid-files');
    expect(lockedNames).toContain('output-schema');
  });

  it('should parse sections correctly', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/thorough.js');
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

  it('should have fileLevelSuggestions in output schema (Level 2 feature)', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/thorough.js');
    expect(baseline.taggedPrompt).toContain('fileLevelSuggestions');
  });

  it('should be longer than balanced variant', async () => {
    const thorough = await import('../../src/ai/prompts/baseline/level2/thorough.js');
    const balanced = await import('../../src/ai/prompts/baseline/level2/balanced.js');

    // Thorough should have more characters (more comprehensive)
    expect(thorough.taggedPrompt.length).toBeGreaterThan(balanced.taggedPrompt.length);
  });

  it('should have thorough-specific sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/thorough.js');

    // These sections are specific to the thorough tier
    expect(baseline.defaultOrder).toContain('reasoning-framework');
    expect(baseline.defaultOrder).toContain('conventions-as-evidence');
    expect(baseline.defaultOrder).toContain('verification-standard');
    expect(baseline.defaultOrder).toContain('do-not-report');
    expect(baseline.defaultOrder).toContain('confidence-guidance');
    expect(baseline.defaultOrder).toContain('file-level-guidance');
    // Removed for the frontier-model redesign
    expect(baseline.defaultOrder).not.toContain('category-definitions');
    expect(baseline.defaultOrder).not.toContain('reasoning-encouragement');
  });

  it('should have tier attributes on sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/thorough.js');
    const parsed = baseline.parseSections();

    // At least some sections should have tier attributes
    const sectionsWithTier = parsed.filter(s => s.tier);
    expect(sectionsWithTier.length).toBeGreaterThan(0);

    // Sections with tier should include 'thorough'
    for (const section of sectionsWithTier) {
      expect(section.tier).toContain('thorough');
    }
  });

  it('should have focused confidence guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/thorough.js');

    // Should have confidence calibration that separates confidence from severity
    expect(baseline.taggedPrompt).toContain('High (0.8-1.0)');
    expect(baseline.taggedPrompt).toContain('Medium (0.5-0.79)');
    expect(baseline.taggedPrompt).toContain('Low (0.3-0.49)');
    expect(baseline.taggedPrompt).toContain('Very low (<0.3)');
    // Key conceptual distinction
    expect(baseline.taggedPrompt).toContain('Confidence is about certainty, not severity');
  });

  it('should have prioritized focus areas with file context emphasis', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/thorough.js');

    // Prioritized hunting list: security first, then contract violations, praise capped
    expect(baseline.taggedPrompt).toContain('## What to Hunt For');
    expect(baseline.taggedPrompt).toContain('**Security regressions**');
    expect(baseline.taggedPrompt).toContain('**Contract violations**');
    expect(baseline.taggedPrompt).toContain('**Integration defects**');
    expect(baseline.taggedPrompt).toContain('**Consistency**');
    expect(baseline.taggedPrompt).toContain('**Praise**');
    expect(baseline.taggedPrompt.indexOf('**Security regressions**'))
      .toBeLessThan(baseline.taggedPrompt.indexOf('**Contract violations**'));
  });

  it('should have reasoning framework', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/thorough.js');

    // Multi-phase reasoning framework for sophisticated analysis
    expect(baseline.taggedPrompt).toContain('Reasoning Framework');
    expect(baseline.taggedPrompt).toContain('Phase 1');
    expect(baseline.taggedPrompt).toContain('Phase 2');
    expect(baseline.taggedPrompt).toContain('Phase 3');
    expect(baseline.taggedPrompt).toContain('Output Calibration');
  });

  it('should treat file conventions as evidence, not authority', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/thorough.js');

    expect(baseline.taggedPrompt).toContain('Conventions Are Evidence, Not Law');
    expect(baseline.taggedPrompt).toContain('deviation is an improvement');
    expect(baseline.taggedPrompt).toContain('conformance to a bad pattern');
    // The old authority framing must be gone
    expect(baseline.taggedPrompt).not.toContain('conventions as authoritative');
  });

  it('should have verification standard and do-not-report list', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/thorough.js');

    expect(baseline.taggedPrompt).toContain('## Verification Standard');
    expect(baseline.taggedPrompt).toContain('cite the specific lines that establish the pattern');
    expect(baseline.taggedPrompt).toContain('Security findings are attack scenarios');
    expect(baseline.taggedPrompt).toContain('Simplicity findings must show the simpler version');
    // Refutation asymmetry: only refuted findings are discarded; unverifiable
    // concrete scenarios surface as low-confidence questions
    expect(baseline.taggedPrompt).toContain('neither confirm nor refute');
    expect(baseline.taggedPrompt).toContain('## Do Not Report');
    expect(baseline.taggedPrompt).toContain("Diff-only findings (Level 1's job)");
    expect(baseline.taggedPrompt).not.toContain('the pipeline discards them anyway');
  });

  it('should have file-level guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/thorough.js');

    // Opus-optimized: Streamlined file-level vs line-level guidance
    expect(baseline.taggedPrompt).toContain('File-Level vs Line-Level Suggestions');
    expect(baseline.taggedPrompt).toContain('fileLevelSuggestions');
  });

  it('should have Level 2 specific sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/thorough.js');

    // Level 2 specific sections
    expect(baseline.defaultOrder).toContain('analysis-process');
    expect(baseline.defaultOrder).toContain('file-level-guidance');

    // Should NOT have Level 1 specific sections
    expect(baseline.defaultOrder).not.toContain('speed-expectations');
    expect(baseline.defaultOrder).not.toContain('initial-setup');
  });

  it('should build correctly with context', () => {
    const builder = getPromptBuilder('level2', 'thorough');
    const context = {
      reviewIntro: 'You are reviewing PR #999',
      prContext: '## PR Context\nTitle: Thorough Level 2 Test PR',
      customInstructions: '',
      lineNumberGuidance: '## Line Numbers\nUse annotated diff',
      generatedFiles: '',
      validFiles: '- src/thorough.js'
    };

    const prompt = builder.build(context);

    expect(prompt).toContain('You are reviewing PR #999');
    expect(prompt).toContain('## PR Context');
    expect(prompt).toContain('- src/thorough.js');
    expect(prompt).toContain('Deep File Context Analysis');
    // Should not contain XML section tags
    expect(prompt).not.toMatch(/<section[^>]*>/);
    expect(prompt).not.toContain('</section>');
  });

  it('should resolve premium alias to thorough tier', () => {
    const builder = getPromptBuilder('level2', 'premium');
    expect(builder).not.toBeNull();
    expect(builder.tier).toBe('thorough');
  });

  it('should NOT have category definitions tutoring', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level2/thorough.js');

    // Frontier-model redesign: no category taxonomy tutoring
    expect(baseline.taggedPrompt).not.toContain('Category Definitions');
    // But findings must still explain why file context was needed
    expect(baseline.taggedPrompt).toContain('file context');
  });
});

describe('Baseline Level 3 Fast', () => {
  it('should have all required sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/fast.js');

    expect(baseline.taggedPrompt).toBeDefined();
    expect(baseline.sections).toBeDefined();
    expect(baseline.defaultOrder).toBeDefined();

    // Check required sections exist
    const requiredSections = ['role', 'pr-context', 'output-schema', 'guidelines', 'purpose', 'analysis-process', 'focus-areas'];
    for (const name of requiredSections) {
      expect(baseline.defaultOrder).toContain(name);
    }
  });

  it('should have valid locked sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/fast.js');
    const parsed = baseline.parseSections();

    // Check that locked sections exist and are marked correctly
    const lockedSections = parsed.filter(s => s.locked);
    const lockedNames = lockedSections.map(s => s.name);

    expect(lockedNames).toContain('pr-context');
    expect(lockedNames).toContain('changed-files');
    expect(lockedNames).toContain('output-schema');
  });

  it('should parse sections correctly', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/fast.js');
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

  it('should have fileLevelSuggestions in output schema (Level 3 feature)', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/fast.js');
    expect(baseline.taggedPrompt).toContain('fileLevelSuggestions');
  });

  it('should be shorter than balanced variant', async () => {
    const fast = await import('../../src/ai/prompts/baseline/level3/fast.js');
    const balanced = await import('../../src/ai/prompts/baseline/level3/balanced.js');

    // Fast should have fewer characters
    expect(fast.taggedPrompt.length).toBeLessThan(balanced.taggedPrompt.length);
  });

  it('should NOT have file-level-guidance section', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/fast.js');

    // This section was removed for the fast tier (tier="balanced,thorough")
    expect(baseline.defaultOrder).not.toContain('file-level-guidance');
  });

  it('should have tier attributes on sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/fast.js');
    const parsed = baseline.parseSections();

    // At least some sections should have tier attributes
    const sectionsWithTier = parsed.filter(s => s.tier);
    expect(sectionsWithTier.length).toBeGreaterThan(0);

    // Sections with tier should include 'fast'
    for (const section of sectionsWithTier) {
      expect(section.tier).toContain('fast');
    }
  });

  it('should build correctly with context', () => {
    const builder = getPromptBuilder('level3', 'fast');
    const context = {
      reviewIntro: 'You are reviewing PR #333',
      prContext: '## PR Context\nTitle: Fast Level 3 Test PR',
      customInstructions: '',
      lineNumberGuidance: '## Line Numbers\nUse annotated diff',
      generatedFiles: '',
      changedFiles: '## Changed Files\n- src/api.js\n- src/utils.js',
      testingGuidance: 'Missing test coverage'
    };

    const prompt = builder.build(context);

    expect(prompt).toContain('You are reviewing PR #333');
    expect(prompt).toContain('## PR Context');
    expect(prompt).toContain('Quick Codebase Impact Analysis');
    expect(prompt).toContain('## Changed Files');
    expect(prompt).toContain('- src/api.js');
    expect(prompt).toContain('Missing test coverage');
    // Should not contain XML section tags
    expect(prompt).not.toMatch(/<section[^>]*>/);
    expect(prompt).not.toContain('</section>');
  });

  it('should have Level 3 specific sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/fast.js');

    // Level 3 specific sections
    expect(baseline.defaultOrder).toContain('purpose');
    expect(baseline.defaultOrder).toContain('analysis-process');
    expect(baseline.defaultOrder).toContain('changed-files');

    // Should NOT have Level 1 specific sections
    expect(baseline.defaultOrder).not.toContain('speed-expectations');
    expect(baseline.defaultOrder).not.toContain('initial-setup');
    expect(baseline.defaultOrder).not.toContain('category-definitions');
    expect(baseline.defaultOrder).not.toContain('valid-files');
  });

  it('should have codebase-focused content', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/fast.js');

    // Level 3 is about codebase context
    expect(baseline.taggedPrompt).toContain('codebase');
    expect(baseline.taggedPrompt).toContain('broader codebase');
    expect(baseline.taggedPrompt).toContain('established patterns');
  });

  it('should have simplified focus areas', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/fast.js');

    // Should include essential codebase-level focus areas
    expect(baseline.taggedPrompt).toContain('Architectural inconsistencies');
    expect(baseline.taggedPrompt).toContain('Cross-file dependency');
    expect(baseline.taggedPrompt).toContain('Breaking changes');
    expect(baseline.taggedPrompt).toContain('API contract');
  });

  it('should have Level 3 output schema', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/fast.js');

    // Should have level 3 in output schema
    expect(baseline.taggedPrompt).toContain('"level": 3');
    expect(baseline.taggedPrompt).toContain('codebase context was needed');
  });

  it('should resolve free alias to fast tier', () => {
    const builder = getPromptBuilder('level3', 'free');
    expect(builder).not.toBeNull();
    expect(builder.tier).toBe('fast');
  });

  it('should have simplified available commands', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/fast.js');

    // Level 3 fast should mention commands but be shorter
    expect(baseline.taggedPrompt).toContain('find, grep');
    expect(baseline.taggedPrompt).toContain('cat -n');
    expect(baseline.taggedPrompt).toContain('ls, tree');
    expect(baseline.taggedPrompt).toContain('READ-ONLY');
  });
});

describe('Baseline Level 3 Balanced', () => {
  it('should have all required sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/balanced.js');

    expect(baseline.taggedPrompt).toBeDefined();
    expect(baseline.sections).toBeDefined();
    expect(baseline.defaultOrder).toBeDefined();

    // Check required sections exist
    const requiredSections = ['role', 'pr-context', 'output-schema', 'guidelines', 'purpose', 'analysis-process', 'focus-areas'];
    for (const name of requiredSections) {
      expect(baseline.defaultOrder).toContain(name);
    }
  });

  it('should have valid locked sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/balanced.js');
    const parsed = baseline.parseSections();

    // Check that locked sections exist and are marked correctly
    const lockedSections = parsed.filter(s => s.locked);
    const lockedNames = lockedSections.map(s => s.name);

    expect(lockedNames).toContain('pr-context');
    expect(lockedNames).toContain('changed-files');
    expect(lockedNames).toContain('output-schema');
  });

  it('should parse sections correctly', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/balanced.js');
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

  it('should have fileLevelSuggestions in output schema (Level 3 feature)', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/balanced.js');
    expect(baseline.taggedPrompt).toContain('fileLevelSuggestions');
  });

  it('should have Level 3 specific sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/balanced.js');

    // Level 3 specific sections
    expect(baseline.defaultOrder).toContain('purpose');
    expect(baseline.defaultOrder).toContain('analysis-process');
    expect(baseline.defaultOrder).toContain('changed-files');
    expect(baseline.defaultOrder).toContain('file-level-guidance');

    // Should NOT have Level 1 specific sections
    expect(baseline.defaultOrder).not.toContain('speed-expectations');
    expect(baseline.defaultOrder).not.toContain('initial-setup');
    expect(baseline.defaultOrder).not.toContain('category-definitions');
  });

  it('should have codebase-focused content', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/balanced.js');

    // Level 3 is about codebase context
    expect(baseline.taggedPrompt).toContain('Codebase');
    expect(baseline.taggedPrompt).toContain('broader codebase');
    expect(baseline.taggedPrompt).toContain('architectural patterns');
    expect(baseline.taggedPrompt).toContain('Cross-file dependencies');
  });

  it('should have focus areas for codebase analysis', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/balanced.js');

    // Should include codebase-level focus areas
    expect(baseline.taggedPrompt).toContain('Existing architecture');
    expect(baseline.taggedPrompt).toContain('Established patterns');
    expect(baseline.taggedPrompt).toContain('API contracts');
    expect(baseline.taggedPrompt).toContain('Breaking changes');
    expect(baseline.taggedPrompt).toContain('Backward compatibility');
    expect(baseline.taggedPrompt).toContain('System scalability');
  });

  it('should have Level 3 output schema', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/balanced.js');

    // Should have level 3 in output schema
    expect(baseline.taggedPrompt).toContain('"level": 3');
    expect(baseline.taggedPrompt).toContain('codebase context was needed');
  });

  it('should have codebase-specific file-level suggestions guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/balanced.js');

    // File-level suggestions should mention codebase-level concerns
    expect(baseline.taggedPrompt).toContain('Architectural concerns');
    expect(baseline.taggedPrompt).toContain('Integration issues');
    expect(baseline.taggedPrompt).toContain('design pattern inconsistencies');
  });

  it('should build correctly with context', () => {
    const builder = getPromptBuilder('level3', 'balanced');
    const context = {
      reviewIntro: 'You are reviewing PR #777',
      prContext: '## PR Context\nTitle: Level 3 Test PR',
      customInstructions: '',
      lineNumberGuidance: '## Line Numbers\nUse annotated diff',
      generatedFiles: '',
      changedFiles: '## Changed Files\n- src/api.js\n- src/utils.js',
      testingGuidance: 'Testing: Check for missing test coverage'
    };

    const prompt = builder.build(context);

    expect(prompt).toContain('You are reviewing PR #777');
    expect(prompt).toContain('## PR Context');
    expect(prompt).toContain('Level 3 Test PR');
    expect(prompt).toContain('Analyze Change Impact on Codebase');
    expect(prompt).toContain('## Changed Files');
    expect(prompt).toContain('- src/api.js');
    expect(prompt).toContain('Testing: Check for missing test coverage');
    // Should not contain XML section tags
    expect(prompt).not.toMatch(/<section[^>]*>/);
    expect(prompt).not.toContain('</section>');
  });

  it('should resolve standard alias to balanced tier', () => {
    const builder = getPromptBuilder('level3', 'standard');
    expect(builder).not.toBeNull();
    expect(builder.tier).toBe('balanced');
  });

  it('should have file-level-guidance as optional section', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/balanced.js');
    const parsed = baseline.parseSections();

    // Check file-level-guidance exists and is optional
    // Note: tier attributes were removed from balanced prompts as they served no functional purpose
    const fileLevelGuidance = parsed.find(s => s.name === 'file-level-guidance');
    expect(fileLevelGuidance).toBeDefined();
    expect(fileLevelGuidance.optional).toBe(true);
  });

  it('should have available commands for codebase exploration', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/balanced.js');

    // Level 3 should mention codebase exploration commands
    expect(baseline.taggedPrompt).toContain('find . -name');
    expect(baseline.taggedPrompt).toContain('grep -r');
    expect(baseline.taggedPrompt).toContain('ls, tree commands');
    expect(baseline.taggedPrompt).toContain('explore');
    expect(baseline.taggedPrompt).toContain('READ-ONLY');
  });
});

describe('Baseline Level 3 Thorough', () => {
  it('should have all required sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');

    expect(baseline.taggedPrompt).toBeDefined();
    expect(baseline.sections).toBeDefined();
    expect(baseline.defaultOrder).toBeDefined();

    // Check required sections exist
    const requiredSections = ['role', 'pr-context', 'output-schema', 'guidelines', 'purpose', 'analysis-process', 'focus-areas'];
    for (const name of requiredSections) {
      expect(baseline.defaultOrder).toContain(name);
    }
  });

  it('should have valid locked sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');
    const parsed = baseline.parseSections();

    // Check that locked sections exist and are marked correctly
    const lockedSections = parsed.filter(s => s.locked);
    const lockedNames = lockedSections.map(s => s.name);

    expect(lockedNames).toContain('pr-context');
    expect(lockedNames).toContain('changed-files');
    expect(lockedNames).toContain('output-schema');
  });

  it('should parse sections correctly', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');
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

  it('should have fileLevelSuggestions in output schema (Level 3 feature)', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');
    expect(baseline.taggedPrompt).toContain('fileLevelSuggestions');
  });

  it('should be longer than balanced variant', async () => {
    const thorough = await import('../../src/ai/prompts/baseline/level3/thorough.js');
    const balanced = await import('../../src/ai/prompts/baseline/level3/balanced.js');

    // Thorough should have more characters (more comprehensive)
    expect(thorough.taggedPrompt.length).toBeGreaterThan(balanced.taggedPrompt.length);
  });

  it('should have thorough-specific sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');

    // These sections are specific to the thorough tier
    expect(baseline.defaultOrder).toContain('verification-standard');
    expect(baseline.defaultOrder).toContain('do-not-report');
    expect(baseline.defaultOrder).toContain('confidence-guidance');
    expect(baseline.defaultOrder).toContain('file-level-guidance');
    // Removed for the frontier-model redesign
    expect(baseline.defaultOrder).not.toContain('category-definitions');
    expect(baseline.defaultOrder).not.toContain('reasoning-encouragement');
  });

  it('should have tier attributes on sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');
    const parsed = baseline.parseSections();

    // At least some sections should have tier attributes
    const sectionsWithTier = parsed.filter(s => s.tier);
    expect(sectionsWithTier.length).toBeGreaterThan(0);

    // Sections with tier should include 'thorough'
    for (const section of sectionsWithTier) {
      expect(section.tier).toContain('thorough');
    }
  });

  it('should have focused confidence guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');

    // Should have confidence calibration that separates confidence from severity
    expect(baseline.taggedPrompt).toContain('High (0.8-1.0)');
    expect(baseline.taggedPrompt).toContain('Medium (0.5-0.79)');
    expect(baseline.taggedPrompt).toContain('Low (0.3-0.49)');
    expect(baseline.taggedPrompt).toContain('Very low (<0.3)');
    // Key conceptual distinction - confidence is about epistemic certainty, not severity
    expect(baseline.taggedPrompt).toContain('Confidence != severity');
  });

  it('should have prioritized focus areas with codebase context emphasis', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');

    // Prioritized hunting list: security first, then breaking changes, praise capped
    expect(baseline.taggedPrompt).toContain('## What to Hunt For');
    expect(baseline.taggedPrompt).toContain('**Security boundaries**');
    expect(baseline.taggedPrompt).toContain('**Breaking changes**');
    expect(baseline.taggedPrompt).toContain('**Pattern conformance**');
    expect(baseline.taggedPrompt).toContain('**Missing accompanying changes**');
    expect(baseline.taggedPrompt).toContain('**System-level risk**');
    expect(baseline.taggedPrompt).toContain('**Praise**');
    expect(baseline.taggedPrompt.indexOf('**Security boundaries**'))
      .toBeLessThan(baseline.taggedPrompt.indexOf('**Breaking changes**'));
  });

  it('should have evidence-grounded verification standard', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');

    expect(baseline.taggedPrompt).toContain('## Verification Standard');
    expect(baseline.taggedPrompt).toContain('Cited patterns must exist');
    expect(baseline.taggedPrompt).toContain('Breaking-change claims must name the victim');
    expect(baseline.taggedPrompt).toContain('Refute before reporting');
    expect(baseline.taggedPrompt).toContain('Security findings are attack scenarios');
    expect(baseline.taggedPrompt).toContain('Simplicity findings must show the simpler version');
    // Refutation asymmetry: only refuted findings are discarded; unverifiable
    // concrete findings surface as low-confidence questions
    expect(baseline.taggedPrompt).toContain('Discard only what you actually refuted');
    expect(baseline.taggedPrompt).toContain('neither confirm nor refute');
    expect(baseline.taggedPrompt).not.toContain('the pipeline discards them anyway');
  });

  it('should have detailed file-level guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');

    expect(baseline.taggedPrompt).toContain('File-Level Suggestions');
    expect(baseline.taggedPrompt).toContain('When to use file-level suggestions');
    expect(baseline.taggedPrompt).toContain('Examples of good file-level suggestions');
  });

  it('should have Level 3 specific sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');

    // Level 3 specific sections
    expect(baseline.defaultOrder).toContain('purpose');
    expect(baseline.defaultOrder).toContain('analysis-process');
    expect(baseline.defaultOrder).toContain('changed-files');
    expect(baseline.defaultOrder).toContain('file-level-guidance');

    // Should NOT have Level 1 specific sections
    expect(baseline.defaultOrder).not.toContain('speed-expectations');
    expect(baseline.defaultOrder).not.toContain('initial-setup');
    expect(baseline.defaultOrder).not.toContain('valid-files');
  });

  it('should build correctly with context', () => {
    const builder = getPromptBuilder('level3', 'thorough');
    const context = {
      reviewIntro: 'You are reviewing PR #888',
      prContext: '## PR Context\nTitle: Thorough Level 3 Test PR',
      customInstructions: '',
      lineNumberGuidance: '## Line Numbers\nUse annotated diff',
      generatedFiles: '',
      changedFiles: '## Changed Files\n- src/api.js\n- src/utils.js',
      testingGuidance: 'Testing: Check for missing test coverage'
    };

    const prompt = builder.build(context);

    expect(prompt).toContain('You are reviewing PR #888');
    expect(prompt).toContain('## PR Context');
    expect(prompt).toContain('Thorough Level 3 Test PR');
    expect(prompt).toContain('Deep Codebase Impact Analysis');
    expect(prompt).toContain('## Changed Files');
    expect(prompt).toContain('- src/api.js');
    expect(prompt).toContain('Testing: Check for missing test coverage');
    // Should not contain XML section tags
    expect(prompt).not.toMatch(/<section[^>]*>/);
    expect(prompt).not.toContain('</section>');
  });

  it('should resolve premium alias to thorough tier', () => {
    const builder = getPromptBuilder('level3', 'premium');
    expect(builder).not.toBeNull();
    expect(builder.tier).toBe('thorough');
  });

  it('should NOT have category definitions tutoring', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');

    // Frontier-model redesign: no category taxonomy tutoring
    expect(baseline.taggedPrompt).not.toContain('Category Definitions');
    // But findings must still explain why codebase context was needed
    expect(baseline.taggedPrompt).toContain('codebase context');
  });

  it('should have codebase-focused purpose section', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');

    // Level 3 is about codebase context
    expect(baseline.taggedPrompt).toContain('broader codebase');
    expect(baseline.taggedPrompt).toContain('established architecture');
    expect(baseline.taggedPrompt).toContain('Key questions to answer');
  });

  it('should have detailed analysis process', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');

    // Should have numbered steps in analysis process
    expect(baseline.taggedPrompt).toContain('Map the change scope');
    expect(baseline.taggedPrompt).toContain('Trace dependencies');
    expect(baseline.taggedPrompt).toContain('Find the precedents');
    expect(baseline.taggedPrompt).toContain('Assess system impact');
    expect(baseline.taggedPrompt).toContain('Check completeness');
  });

  it('should have available commands for codebase exploration', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');

    // Level 3 should mention codebase exploration commands
    expect(baseline.taggedPrompt).toContain('find . -name');
    expect(baseline.taggedPrompt).toContain('grep -r');
    expect(baseline.taggedPrompt).toContain('ls, tree commands');
    expect(baseline.taggedPrompt).toContain('READ-ONLY');
    // Thorough should mention delegation harness-neutrally — never a
    // harness-specific tool name like Claude's "Tasks"
    expect(baseline.taggedPrompt).toContain('subagent or task-delegation tool');
    expect(baseline.taggedPrompt).not.toContain('parallel read-only Tasks');
  });

  it('should have scope guidance distinguishing Level 3 from Level 1/2', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');

    // The scope test now lives in the do-not-report section
    expect(baseline.taggedPrompt).toContain('Did I need to look at other files to find this?');
    expect(baseline.taggedPrompt).toContain('Levels 1 and 2 own those');
  });

  it('should have Level 3 output schema', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/level3/thorough.js');

    // Should have level 3 in output schema
    expect(baseline.taggedPrompt).toContain('"level": 3');
    expect(baseline.taggedPrompt).toContain('codebase context was needed');
  });
});

describe('Baseline Orchestration Balanced', () => {
  it('should have all required sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');

    expect(baseline.taggedPrompt).toBeDefined();
    expect(baseline.sections).toBeDefined();
    expect(baseline.defaultOrder).toBeDefined();

    // Check required sections exist
    const requiredSections = ['role', 'task-header', 'input-suggestions', 'output-schema', 'guidelines'];
    for (const name of requiredSections) {
      expect(baseline.defaultOrder).toContain(name);
    }
  });

  it('should have valid locked sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');
    const parsed = baseline.parseSections();

    // Check that locked sections exist and are marked correctly
    const lockedSections = parsed.filter(s => s.locked);
    const lockedNames = lockedSections.map(s => s.name);

    expect(lockedNames).toContain('critical-output');
    expect(lockedNames).toContain('input-suggestions');
    expect(lockedNames).toContain('output-schema');
  });

  it('should parse sections correctly', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');
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

  it('should have fileLevelSuggestions in output schema', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');
    expect(baseline.taggedPrompt).toContain('fileLevelSuggestions');
  });

  it('should have orchestrated level in output schema', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');
    expect(baseline.taggedPrompt).toContain('"level": "orchestrated"');
  });

  it('should have placeholders for multi-level suggestions', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');

    expect(baseline.taggedPrompt).toContain('{{level1Suggestions}}');
    expect(baseline.taggedPrompt).toContain('{{level2Suggestions}}');
    expect(baseline.taggedPrompt).toContain('{{level3Suggestions}}');
  });

  it('should have orchestration-specific sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');

    // Orchestration specific sections
    expect(baseline.defaultOrder).toContain('intelligent-merging');
    expect(baseline.defaultOrder).toContain('priority-curation');
    expect(baseline.defaultOrder).toContain('balanced-output');
    expect(baseline.defaultOrder).toContain('human-centric-framing');
    expect(baseline.defaultOrder).toContain('file-level-guidance');

    // Should NOT have Level 1/2/3 specific sections
    expect(baseline.defaultOrder).not.toContain('speed-expectations');
    expect(baseline.defaultOrder).not.toContain('initial-setup');
    expect(baseline.defaultOrder).not.toContain('analysis-process');
    expect(baseline.defaultOrder).not.toContain('valid-files');
  });

  it('should have human-centric framing guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');

    expect(baseline.taggedPrompt).toContain('Human-Centric Framing');
    expect(baseline.taggedPrompt).toContain('considerations and guidance');
    expect(baseline.taggedPrompt).toContain('pair programming partner');
    expect(baseline.taggedPrompt).toContain('reviewer autonomy');
  });

  it('should have priority-based curation guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');

    expect(baseline.taggedPrompt).toContain('Priority-Based Curation');
    expect(baseline.taggedPrompt).toContain('Security vulnerabilities');
    expect(baseline.taggedPrompt).toContain('Bugs and errors');
    expect(baseline.taggedPrompt).toContain('Architecture concerns');
    expect(baseline.taggedPrompt).toContain('Performance optimizations');
    expect(baseline.taggedPrompt).toContain('Code style');
  });

  it('should have intelligent merging guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');

    expect(baseline.taggedPrompt).toContain('Intelligent Merging');
    expect(baseline.taggedPrompt).toContain('Combine related suggestions');
    expect(baseline.taggedPrompt).toContain('Merge overlapping concerns');
    expect(baseline.taggedPrompt).toContain('Preserve unique insights');
    expect(baseline.taggedPrompt).toContain('Do NOT mention which level');
  });

  it('should require structured markdown summaries', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');

    expect(baseline.defaultOrder).toContain('summary-synthesis');
    expect(baseline.taggedPrompt).toContain('Summary Structure');
    expect(baseline.taggedPrompt).toContain('not be one big paragraph');
    expect(baseline.taggedPrompt).toContain('1-2 sentences describing the overall assessment');
    expect(baseline.taggedPrompt).toContain('markdown bullet list');
    expect(baseline.taggedPrompt).toContain('After the bullets');
    expect(baseline.taggedPrompt).toContain('Formatted markdown summary following the Summary Structure guidance above.');
  });

  it('should have quality over quantity emphasis', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');

    expect(baseline.taggedPrompt).toContain('Quality over quantity');
    expect(baseline.taggedPrompt).toContain('Limit praise suggestions');
    expect(baseline.taggedPrompt).toContain('Avoid suggestion overload');
  });

  it('should have tier attributes on file-level-guidance section', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');
    const parsed = baseline.parseSections();

    // Check file-level-guidance has tier attribute
    const fileLevelGuidance = parsed.find(s => s.name === 'file-level-guidance');
    expect(fileLevelGuidance).toBeDefined();
    expect(fileLevelGuidance.tier).toContain('balanced');
    expect(fileLevelGuidance.tier).toContain('thorough');
  });

  it('should build correctly with context', () => {
    const builder = getPromptBuilder('orchestration', 'balanced');
    const context = {
      reviewIntro: 'You are orchestrating AI-powered code review suggestions for PR #999',
      lineNumberGuidance: '## Line Numbers\nUse annotated diff',
      customInstructions: '',
      level1Suggestions: '- bug: Null check missing (src/api.js:42) - Missing null check...',
      level2Suggestions: '- improvement: Consider extracting helper (src/api.js:45) - This function...',
      level3Suggestions: '- design: Consider API consistency (src/api.js:40) - This endpoint...',
      fileLineCounts: ''
    };

    const prompt = builder.build(context);

    expect(prompt).toContain('You are orchestrating AI-powered code review');
    expect(prompt).toContain('# AI Suggestion Orchestration Task');
    expect(prompt).toContain('Level 1 - Diff Analysis');
    expect(prompt).toContain('Level 2 - File Context');
    expect(prompt).toContain('Level 3 - Codebase Context');
    expect(prompt).toContain('bug: Null check missing');
    expect(prompt).toContain('improvement: Consider extracting helper');
    expect(prompt).toContain('design: Consider API consistency');
    // Should not contain XML section tags
    expect(prompt).not.toMatch(/<section[^>]*>/);
    expect(prompt).not.toContain('</section>');
  });

  it('should resolve standard alias to balanced tier', () => {
    const builder = getPromptBuilder('orchestration', 'standard');
    expect(builder).not.toBeNull();
    expect(builder.tier).toBe('balanced');
  });

  it('should have diff instructions for line number reference', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');

    expect(baseline.taggedPrompt).toContain('old_or_new');
    expect(baseline.taggedPrompt).toContain('Preserve the old_or_new value');
    expect(baseline.taggedPrompt).toContain('DELETED lines');
  });

  it('should have file-level suggestions guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');

    expect(baseline.taggedPrompt).toContain('[FILE-LEVEL]');
    expect(baseline.taggedPrompt).toContain('fileLevelSuggestions');
    expect(baseline.taggedPrompt).toContain('architecture concerns');
    expect(baseline.taggedPrompt).toContain('missing tests');
  });

  it('should have guidelines for modified files only', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');

    expect(baseline.taggedPrompt).toContain('Only include modified files');
    expect(baseline.taggedPrompt).toContain('Discard any suggestions for files not modified');
  });
});

describe('Baseline Orchestration Fast', () => {
  it('should have all required sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');

    expect(baseline.taggedPrompt).toBeDefined();
    expect(baseline.sections).toBeDefined();
    expect(baseline.defaultOrder).toBeDefined();

    // Check required sections exist
    const requiredSections = ['role', 'task-header', 'input-suggestions', 'output-schema', 'guidelines'];
    for (const name of requiredSections) {
      expect(baseline.defaultOrder).toContain(name);
    }
  });

  it('should have valid locked sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');
    const parsed = baseline.parseSections();

    // Check that locked sections exist and are marked correctly
    const lockedSections = parsed.filter(s => s.locked);
    const lockedNames = lockedSections.map(s => s.name);

    expect(lockedNames).toContain('critical-output');
    expect(lockedNames).toContain('input-suggestions');
    expect(lockedNames).toContain('output-schema');
  });

  it('should parse sections correctly', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');
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

  it('should have fileLevelSuggestions in output schema', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');
    expect(baseline.taggedPrompt).toContain('fileLevelSuggestions');
  });

  it('should have orchestrated level in output schema', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');
    expect(baseline.taggedPrompt).toContain('"level": "orchestrated"');
  });

  it('should be shorter than balanced variant', async () => {
    const fast = await import('../../src/ai/prompts/baseline/orchestration/fast.js');
    const balanced = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');

    // Fast should have fewer characters
    expect(fast.taggedPrompt.length).toBeLessThan(balanced.taggedPrompt.length);
  });

  it('should NOT have file-level-guidance section', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');

    // This section was removed for the fast tier (tier="balanced,thorough")
    expect(baseline.defaultOrder).not.toContain('file-level-guidance');
  });

  it('should have tier attributes on sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');
    const parsed = baseline.parseSections();

    // At least some sections should have tier attributes
    const sectionsWithTier = parsed.filter(s => s.tier);
    expect(sectionsWithTier.length).toBeGreaterThan(0);

    // Sections with tier should include 'fast'
    for (const section of sectionsWithTier) {
      expect(section.tier).toContain('fast');
    }
  });

  it('should have placeholders for multi-level suggestions', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');

    expect(baseline.taggedPrompt).toContain('{{level1Suggestions}}');
    expect(baseline.taggedPrompt).toContain('{{level2Suggestions}}');
    expect(baseline.taggedPrompt).toContain('{{level3Suggestions}}');
  });

  it('should have orchestration-specific sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');

    // Orchestration specific sections
    expect(baseline.defaultOrder).toContain('intelligent-merging');
    expect(baseline.defaultOrder).toContain('priority-curation');
    expect(baseline.defaultOrder).toContain('balanced-output');
    expect(baseline.defaultOrder).toContain('human-centric-framing');

    // Should NOT have file-level-guidance (removed for fast tier)
    expect(baseline.defaultOrder).not.toContain('file-level-guidance');

    // Should NOT have Level 1/2/3 specific sections
    expect(baseline.defaultOrder).not.toContain('speed-expectations');
    expect(baseline.defaultOrder).not.toContain('initial-setup');
    expect(baseline.defaultOrder).not.toContain('analysis-process');
    expect(baseline.defaultOrder).not.toContain('valid-files');
  });

  it('should have simplified merging guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');

    expect(baseline.taggedPrompt).toContain('Combine related suggestions');
    expect(baseline.taggedPrompt).toContain('Merge overlaps');
    expect(baseline.taggedPrompt).toContain('Preserve unique insights');
    expect(baseline.taggedPrompt).toContain('Never mention levels');
  });

  it('should have simplified priority order', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');

    expect(baseline.taggedPrompt).toContain('### Priority');
    expect(baseline.taggedPrompt).toContain('Security > Bugs > Architecture > Performance > Style');
  });

  it('should have simplified human-centric framing', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');

    expect(baseline.taggedPrompt).toContain('guidance not mandates');
    expect(baseline.taggedPrompt).toContain('Consider...');
  });

  it('should require structured markdown summaries', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');

    expect(baseline.defaultOrder).toContain('summary-synthesis');
    expect(baseline.taggedPrompt).toContain('### Summary');
    expect(baseline.taggedPrompt).toContain('not one big paragraph');
    expect(baseline.taggedPrompt).toContain('1-2 sentences describing the overall assessment');
    expect(baseline.taggedPrompt).toContain('markdown bullet list');
    expect(baseline.taggedPrompt).toContain('After the bullets');
    expect(baseline.taggedPrompt).toContain('Formatted markdown summary following the Summary guidance above.');
  });

  it('should build correctly with context', () => {
    const builder = getPromptBuilder('orchestration', 'fast');
    const context = {
      reviewIntro: 'You are orchestrating AI-powered code review suggestions for PR #111',
      lineNumberGuidance: '## Line Numbers\nUse annotated diff',
      customInstructions: '',
      level1Suggestions: '- bug: Null check missing (src/api.js:42)',
      level2Suggestions: '- improvement: Consider extracting helper (src/api.js:45)',
      level3Suggestions: '- design: Consider API consistency (src/api.js:40)',
      fileLineCounts: ''
    };

    const prompt = builder.build(context);

    expect(prompt).toContain('You are orchestrating AI-powered code review');
    expect(prompt).toContain('# Suggestion Orchestration');
    expect(prompt).toContain('Level 1 - Diff Analysis');
    expect(prompt).toContain('Level 2 - File Context');
    expect(prompt).toContain('Level 3 - Codebase Context');
    expect(prompt).toContain('bug: Null check missing');
    expect(prompt).toContain('improvement: Consider extracting helper');
    expect(prompt).toContain('design: Consider API consistency');
    // Should not contain XML section tags
    expect(prompt).not.toMatch(/<section[^>]*>/);
    expect(prompt).not.toContain('</section>');
  });

  it('should resolve free alias to fast tier', () => {
    const builder = getPromptBuilder('orchestration', 'free');
    expect(builder).not.toBeNull();
    expect(builder.tier).toBe('fast');
  });

  it('should have simplified guidelines', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');

    expect(baseline.taggedPrompt).toContain('Quality over quantity');
    expect(baseline.taggedPrompt).toContain('Only modified files');
  });

  it('should have diff instructions for line number reference', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/fast.js');

    expect(baseline.taggedPrompt).toContain('old_or_new');
    expect(baseline.taggedPrompt).toContain('Preserve from input');
    expect(baseline.taggedPrompt).toContain('deleted');
  });
});

describe('Baseline Orchestration Thorough', () => {
  it('should have all required sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    expect(baseline.taggedPrompt).toBeDefined();
    expect(baseline.sections).toBeDefined();
    expect(baseline.defaultOrder).toBeDefined();

    // Check required sections exist
    const requiredSections = ['role', 'task-header', 'input-suggestions', 'output-schema', 'guidelines'];
    for (const name of requiredSections) {
      expect(baseline.defaultOrder).toContain(name);
    }
  });

  it('should have valid locked sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');
    const parsed = baseline.parseSections();

    // Check that locked sections exist and are marked correctly
    const lockedSections = parsed.filter(s => s.locked);
    const lockedNames = lockedSections.map(s => s.name);

    expect(lockedNames).toContain('critical-output');
    expect(lockedNames).toContain('input-suggestions');
    expect(lockedNames).toContain('output-schema');
  });

  it('should parse sections correctly', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');
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

  it('should have fileLevelSuggestions in output schema', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');
    expect(baseline.taggedPrompt).toContain('fileLevelSuggestions');
  });

  it('should have orchestrated level in output schema', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');
    expect(baseline.taggedPrompt).toContain('"level": "orchestrated"');
  });

  it('should be longer than balanced variant', async () => {
    const thorough = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');
    const balanced = await import('../../src/ai/prompts/baseline/orchestration/balanced.js');

    // Thorough should have more characters (more comprehensive)
    expect(thorough.taggedPrompt.length).toBeGreaterThan(balanced.taggedPrompt.length);
  });

  it('should have thorough-specific sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    // These sections are specific to the thorough tier
    expect(baseline.defaultOrder).toContain('confidence-guidance');
    expect(baseline.defaultOrder).toContain('file-level-guidance');
    // Removed for the frontier-model redesign
    expect(baseline.defaultOrder).not.toContain('reasoning-encouragement');
  });

  it('should have tier attributes on sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');
    const parsed = baseline.parseSections();

    // At least some sections should have tier attributes
    const sectionsWithTier = parsed.filter(s => s.tier);
    expect(sectionsWithTier.length).toBeGreaterThan(0);

    // Sections with tier should include 'thorough'
    for (const section of sectionsWithTier) {
      expect(section.tier).toContain('thorough');
    }
  });

  it('should have focused confidence guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    // Should have confidence calibration focused on curation value
    expect(baseline.taggedPrompt).toContain('High (0.8-1.0)');
    expect(baseline.taggedPrompt).toContain('Medium (0.5-0.79)');
    expect(baseline.taggedPrompt).toContain('Low (0.3-0.49)');
    expect(baseline.taggedPrompt).toContain('Very low (<0.3)');
  });

  it('should frame curation as depth over volume', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    expect(baseline.taggedPrompt).toContain("curate, don't concatenate");
  });

  it('should carry adversarial verification as a flow-conditional placeholder', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    // Adversarial verification runs exactly once per flow, at the final
    // merge stage. Orchestration is that stage for standalone single-reviewer
    // runs and the level-centric council's Pass 2 — but a voice's internal
    // cross-level merge inside a multi-voice reviewer-centric council must
    // NOT verify (cross-voice consolidation is that flow's final stage), so
    // the section is placeholder-fed, not static
    expect(baseline.defaultOrder).toContain('adversarial-verification');
    const verifyIdx = baseline.defaultOrder.indexOf('adversarial-verification');
    expect(baseline.defaultOrder[verifyIdx - 1]).toBe('input-suggestions');
    expect(baseline.defaultOrder[verifyIdx + 1]).toBe('intelligent-merging');

    const section = baseline.sections.find(s => s.name === 'adversarial-verification');
    expect(section).toBeDefined();
    expect(section.optional).toBe(true);

    const parsed = baseline.parseSections().find(s => s.name === 'adversarial-verification');
    expect(parsed.content).toBe('{{adversarialVerification}}');
  });

  it('should have placeholders for multi-level suggestions', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    expect(baseline.taggedPrompt).toContain('{{level1Suggestions}}');
    expect(baseline.taggedPrompt).toContain('{{level2Suggestions}}');
    expect(baseline.taggedPrompt).toContain('{{level3Suggestions}}');
  });

  it('should have orchestration-specific sections', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    // Orchestration specific sections
    expect(baseline.defaultOrder).toContain('intelligent-merging');
    expect(baseline.defaultOrder).toContain('priority-curation');
    expect(baseline.defaultOrder).toContain('balanced-output');
    expect(baseline.defaultOrder).toContain('human-centric-framing');
    expect(baseline.defaultOrder).toContain('file-level-guidance');

    // Should NOT have Level 1/2/3 specific sections
    expect(baseline.defaultOrder).not.toContain('speed-expectations');
    expect(baseline.defaultOrder).not.toContain('initial-setup');
    expect(baseline.defaultOrder).not.toContain('analysis-process');
    expect(baseline.defaultOrder).not.toContain('valid-files');
  });

  it('should have comprehensive intelligent merging guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    expect(baseline.taggedPrompt).toContain('When to Merge');
    expect(baseline.taggedPrompt).toContain('When NOT to Merge');
    expect(baseline.taggedPrompt).toContain('Merging Best Practices');
    expect(baseline.taggedPrompt).toContain('combining suggestions across levels');
    expect(baseline.taggedPrompt).toContain('Do NOT mention which level');
    // Conflict resolution guidance
    expect(baseline.taggedPrompt).toContain('Handling Level Contradictions');
    expect(baseline.taggedPrompt).toContain('Cross-level agreement');
    // Evidence-based confidence adjustment, not score arithmetic
    expect(baseline.taggedPrompt).toContain('Adjusting Confidence When Merging');
    expect(baseline.taggedPrompt).toContain('never by mechanical score arithmetic');
    expect(baseline.taggedPrompt).not.toContain('boost confidence by 0.1');
    expect(baseline.taggedPrompt).not.toContain('lower confidence minus 0.1');
    // Exploit framing from the levels must survive merging
    expect(baseline.taggedPrompt).toContain('failure and attack scenarios');
    expect(baseline.taggedPrompt).toContain('do not summarize an exploit description back into a code observation');
  });

  it('should have detailed priority-based curation', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    expect(baseline.taggedPrompt).toContain('Critical Priority');
    expect(baseline.taggedPrompt).toContain('High Priority');
    expect(baseline.taggedPrompt).toContain('Medium Priority');
    expect(baseline.taggedPrompt).toContain('Lower Priority');
    expect(baseline.taggedPrompt).toContain('Sub-tier Reasoning Within Priority Levels');
    expect(baseline.taggedPrompt).toContain('Contextual Priority Adjustment');
    expect(baseline.taggedPrompt).toContain('Security vulnerabilities');
    expect(baseline.taggedPrompt).toContain('Bugs and errors');
    expect(baseline.taggedPrompt).toContain('Architecture concerns');
  });

  it('should have comprehensive human-centric framing', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    expect(baseline.taggedPrompt).toContain('Human-Centric Framing');
    expect(baseline.taggedPrompt).toContain('observations, not demands');
    expect(baseline.taggedPrompt).toContain('pair programming partner');
    expect(baseline.taggedPrompt).toContain('makes the final decisions');
  });

  it('should have unified confidence semantics for orchestration', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    expect(baseline.taggedPrompt).toContain('High (0.8-1.0)');
    expect(baseline.taggedPrompt).toContain('Medium (0.5-0.79)');
    expect(baseline.taggedPrompt).toContain('Low (0.3-0.49)');
    expect(baseline.taggedPrompt).toContain('Very low (<0.3)');
    // Confidence keeps one meaning across the whole pipeline; inclusion is a
    // separate editorial judgment
    expect(baseline.taggedPrompt).toContain('one meaning across the pipeline');
    expect(baseline.taggedPrompt).toContain('probability that the finding is real');
    expect(baseline.taggedPrompt).not.toContain('certainty of value');
  });

  it('should have detailed file-level guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    expect(baseline.taggedPrompt).toContain('File-Level Suggestions');
    expect(baseline.taggedPrompt).toContain('[FILE-LEVEL]');
    expect(baseline.taggedPrompt).toContain('fileLevelSuggestions');
    expect(baseline.taggedPrompt).toContain('NO line number');
  });

  it('should have summary synthesis guidance', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    expect(baseline.taggedPrompt).toContain('Summary Synthesis Guidance');
    expect(baseline.taggedPrompt).toContain('Summary Anti-patterns to Avoid');
    expect(baseline.taggedPrompt).toContain('not be one big paragraph');
    expect(baseline.taggedPrompt).toContain('1-2 sentences of overall assessment');
    expect(baseline.taggedPrompt).toContain('markdown bullet list');
    expect(baseline.taggedPrompt).toContain('forest, not just the trees');
    expect(baseline.taggedPrompt).toContain('single unbroken paragraph with no bullets');
    expect(baseline.defaultOrder).toContain('summary-synthesis');
    expect(baseline.taggedPrompt).toContain('Formatted markdown summary following the Summary Synthesis Guidance above.');
  });

  it('should have synthesis strategy in guidelines', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    expect(baseline.taggedPrompt).toContain('Synthesis Strategy');
    expect(baseline.taggedPrompt).toContain('identifying themes');
    expect(baseline.taggedPrompt).toContain('coherent story');
  });

  it('should preserve the pair-partner philosophy in framing', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    // Philosophy now lives in the human-centric framing section
    expect(baseline.taggedPrompt).toContain('pair programming partner');
    expect(baseline.taggedPrompt).toContain('not an enforcer');
  });

  it('should build correctly with context', () => {
    const builder = getPromptBuilder('orchestration', 'thorough');
    const context = {
      reviewIntro: 'You are orchestrating AI-powered code review suggestions for PR #222',
      lineNumberGuidance: '## Line Numbers\nUse annotated diff',
      customInstructions: '',
      level1Suggestions: '- bug: Null check missing (src/api.js:42) - Missing null check...',
      level2Suggestions: '- improvement: Consider extracting helper (src/api.js:45) - This function...',
      level3Suggestions: '- design: Consider API consistency (src/api.js:40) - This endpoint...',
      fileLineCounts: ''
    };

    const prompt = builder.build(context);

    expect(prompt).toContain('You are orchestrating AI-powered code review');
    expect(prompt).toContain('# Deep AI Suggestion Orchestration Task');
    expect(prompt).toContain('Level 1 - Diff Analysis');
    expect(prompt).toContain('Level 2 - File Context');
    expect(prompt).toContain('Level 3 - Codebase Context');
    expect(prompt).toContain('bug: Null check missing');
    expect(prompt).toContain('improvement: Consider extracting helper');
    expect(prompt).toContain('design: Consider API consistency');
    // Should not contain XML section tags
    expect(prompt).not.toMatch(/<section[^>]*>/);
    expect(prompt).not.toContain('</section>');
  });

  it('should resolve premium alias to thorough tier', () => {
    const builder = getPromptBuilder('orchestration', 'premium');
    expect(builder).not.toBeNull();
    expect(builder.tier).toBe('thorough');
  });

  it('should have diff instructions for line number reference', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    expect(baseline.taggedPrompt).toContain('old_or_new');
    expect(baseline.taggedPrompt).toContain('preserve the old_or_new value');
    expect(baseline.taggedPrompt).toContain('DELETED lines');
  });

  it('should scale output to the PR instead of a fixed count target', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    expect(baseline.taggedPrompt).toContain('Quality over quantity');
    expect(baseline.taggedPrompt).toContain('Limit praise suggestions');
    expect(baseline.taggedPrompt).toContain('Scale Output to the PR');
    expect(baseline.taggedPrompt).toContain('Every suggestion must earn its place');
    // Fixed count anchors cause padding on small PRs and truncation on big ones
    expect(baseline.taggedPrompt).not.toContain('8-15 total suggestions');
    // Category balancing is gone: report what is actually there
    expect(baseline.taggedPrompt).not.toContain('Balance between different categories');
  });

  it('should have role description with orchestration context', async () => {
    const baseline = await import('../../src/ai/prompts/baseline/orchestration/thorough.js');

    expect(baseline.taggedPrompt).toContain('orchestration layer');
    expect(baseline.taggedPrompt).toContain('Level 1');
    expect(baseline.taggedPrompt).toContain('Level 2');
    expect(baseline.taggedPrompt).toContain('Level 3');
    expect(baseline.taggedPrompt).toContain('synthesizing insights');
  });
});

describe('Thorough tier reply-shape guard', () => {
  // opus-5 narrates its agentic process ahead of the JSON (multi-step in
  // longer runs), which breaks extraction (eval 2026-08-18: every extraction
  // failure in both arms was opus-5, at level analyses and at the merge
  // stages). Every thorough template must close with a plain reply-shape
  // guard. The guard must NOT quote an example of the forbidden preamble:
  // an earlier version did, and the next eval's one consolidation failure
  // emitted the quoted sentence near-verbatim (priming) — describe the ban,
  // never demonstrate it.
  const THOROUGH_TEMPLATES = [
    'baseline/level1/thorough.js',
    'baseline/level2/thorough.js',
    'baseline/level3/thorough.js',
    'baseline/orchestration/thorough.js',
    'baseline/consolidation/thorough.js'
  ];

  for (const rel of THOROUGH_TEMPLATES) {
    it(`${rel} closes with the JSON-only, no-preamble guard`, async () => {
      const template = await import(`../../src/ai/prompts/${rel}`);

      expect(template.taggedPrompt).toContain('no sentence announcing what you will do');
      expect(template.taggedPrompt).toContain('The first character of your reply is `{`');
      // Priming guard: no quoted narration examples anywhere in the template
      expect(template.taggedPrompt).not.toContain("I'll start by examining");
      expect(template.taggedPrompt).not.toContain("I'll verify the key findings");
    });
  }
});
