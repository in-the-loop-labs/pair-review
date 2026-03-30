// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Tests for dedup-instructions prompt section in orchestration and consolidation prompts.
 *
 * Verifies that the {{dedupInstructions}} placeholder collapses cleanly when
 * empty and renders inline content when populated.
 */
import { describe, it, expect } from 'vitest';

const { getPromptBuilder } = require('../../src/ai/prompts/index');

/**
 * Minimal context values required by each prompt type so that .build()
 * does not leave raw {{...}} placeholders in the output.
 */
const ORCHESTRATION_CONTEXT = {
  reviewIntro: 'You are an expert code reviewer.',
  lineNumberGuidance: '(line guidance)',
  customInstructions: '',
  level1Count: '0',
  level2Count: '0',
  level3Count: '0',
  level1Suggestions: '[]',
  level2Suggestions: '[]',
  level3Suggestions: '[]',
  prContext: '',
};

const CONSOLIDATION_CONTEXT = {
  reviewIntro: 'You are an expert code reviewer.',
  lineNumberGuidance: '(line guidance)',
  customInstructions: '',
  reviewerSuggestions: '(none)',
  suggestionCount: '0',
  reviewerCount: '0',
  prContext: '',
};

describe('dedup-instructions prompt section', () => {
  describe('orchestration prompt', () => {
    for (const tier of ['fast', 'balanced', 'thorough']) {
      it(`collapses when dedupInstructions is empty (${tier})`, () => {
        const builder = getPromptBuilder('orchestration', tier);
        const output = builder.build({
          ...ORCHESTRATION_CONTEXT,
          dedupInstructions: '',
        });

        // Should not contain the dedup header or any leftover placeholder
        expect(output).not.toContain('Exclude Previously Identified Issues');
        expect(output).not.toContain('{{dedupInstructions}}');
      });

      it(`renders dedup content when dedupInstructions is provided (${tier})`, () => {
        const builder = getPromptBuilder('orchestration', tier);
        const dedupText = '## Exclude Previously Identified Issues\n\nSome instructions here.';
        const output = builder.build({
          ...ORCHESTRATION_CONTEXT,
          dedupInstructions: dedupText,
        });

        expect(output).toContain('Exclude Previously Identified Issues');
        expect(output).toContain('Some instructions here.');
        expect(output).not.toContain('{{dedupInstructions}}');
      });
    }
  });

  describe('consolidation prompt', () => {
    for (const tier of ['fast', 'balanced', 'thorough']) {
      it(`collapses when dedupInstructions is empty (${tier})`, () => {
        const builder = getPromptBuilder('consolidation', tier);
        const output = builder.build({
          ...CONSOLIDATION_CONTEXT,
          dedupInstructions: '',
        });

        expect(output).not.toContain('Exclude Previously Identified Issues');
        expect(output).not.toContain('{{dedupInstructions}}');
      });

      it(`renders dedup content when dedupInstructions is provided (${tier})`, () => {
        const builder = getPromptBuilder('consolidation', tier);
        const dedupText = '## Exclude Previously Identified Issues\n\n### GitHub PR Review Comments\nfetch them.';
        const output = builder.build({
          ...CONSOLIDATION_CONTEXT,
          dedupInstructions: dedupText,
        });

        expect(output).toContain('Exclude Previously Identified Issues');
        expect(output).toContain('GitHub PR Review Comments');
        expect(output).not.toContain('{{dedupInstructions}}');
      });
    }
  });

  describe('analysis-level prompts do not have dedupInstructions', () => {
    // Level 1/2/3 prompts should not contain the dedup placeholder — dedup
    // is only relevant for orchestration and consolidation.
    for (const type of ['level1', 'level2', 'level3']) {
      it(`${type} template does not use {{dedupInstructions}} placeholder`, () => {
        const builder = getPromptBuilder(type, 'balanced');
        const tagged = builder.getTaggedTemplate();
        expect(tagged).not.toContain('{{dedupInstructions}}');
      });
    }
  });
});
