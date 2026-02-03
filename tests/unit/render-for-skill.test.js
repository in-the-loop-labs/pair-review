// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';

const { renderPromptForSkill } = require('../../src/ai/prompts/render-for-skill');

const PROMPT_TYPES = ['level1', 'level2', 'level3', 'orchestration'];
const TIERS = ['fast', 'balanced', 'thorough'];

describe('renderPromptForSkill', () => {
  describe('renders all 12 combinations without error', () => {
    for (const type of PROMPT_TYPES) {
      for (const tier of TIERS) {
        it(`${type} / ${tier}`, () => {
          const result = renderPromptForSkill(type, tier);
          expect(typeof result).toBe('string');
          expect(result.length).toBeGreaterThan(100);
        });
      }
    }
  });

  describe('output has no XML section tags', () => {
    for (const type of PROMPT_TYPES) {
      for (const tier of TIERS) {
        it(`${type} / ${tier}`, () => {
          const result = renderPromptForSkill(type, tier);
          expect(result).not.toMatch(/<section[\s>]/);
          expect(result).not.toMatch(/<\/section>/);
        });
      }
    }
  });

  describe('output has no raw {{...}} placeholders', () => {
    for (const type of PROMPT_TYPES) {
      for (const tier of TIERS) {
        it(`${type} / ${tier}`, () => {
          const result = renderPromptForSkill(type, tier);
          expect(result).not.toMatch(/\{\{\w+\}\}/);
        });
      }
    }
  });

  it('level3 output contains testing guidance text', () => {
    const result = renderPromptForSkill('level3', 'balanced');
    expect(result).toContain('tests');
  });

  it('orchestration output contains orchestration input schema docs', () => {
    const result = renderPromptForSkill('orchestration', 'balanced');
    // ORCHESTRATION_INPUT_SCHEMA_DOCS is baked in at require-time via template literal
    expect(result).toContain('Each level provides suggestions as a JSON array');
  });

  it('custom instructions render into the output when provided', () => {
    const result = renderPromptForSkill('level1', 'balanced', {
      customInstructions: 'Always check for SQL injection vulnerabilities',
    });
    expect(result).toContain('Always check for SQL injection vulnerabilities');
    expect(result).toContain('Custom Review Instructions');
  });

  it('custom instructions collapse cleanly when empty', () => {
    const withEmpty = renderPromptForSkill('level1', 'balanced', {
      customInstructions: '',
    });
    const withOmitted = renderPromptForSkill('level1', 'balanced');
    // Both should produce the same output (empty custom instructions collapse)
    expect(withEmpty).toBe(withOmitted);
    expect(withEmpty).not.toContain('Custom Review Instructions');
  });

  it('custom instructions collapse cleanly when omitted', () => {
    const result = renderPromptForSkill('level1', 'balanced');
    expect(result).not.toContain('Custom Review Instructions');
  });

  it('orchestration uses curation-focused line number guidance', () => {
    const result = renderPromptForSkill('orchestration', 'balanced');
    expect(result).toContain('curation and synthesis, not line number verification');
    expect(result).toContain('Preserve line numbers as-is');
    expect(result).not.toContain('## Line Number Precision');
  });

  it('analysis levels use active diff-analysis line number guidance', () => {
    for (const type of ['level1', 'level2', 'level3']) {
      const result = renderPromptForSkill(type, 'balanced');
      expect(result).toContain('## Viewing Code Changes');
      expect(result).toContain('## Line Number Precision');
      expect(result).not.toContain('curation and synthesis');
    }
  });

  it('throws on invalid promptType', () => {
    expect(() => renderPromptForSkill('invalid', 'balanced')).toThrow();
  });

  it('throws on unknown tier', () => {
    expect(() => renderPromptForSkill('level1', 'nonexistent')).toThrow();
  });
});
