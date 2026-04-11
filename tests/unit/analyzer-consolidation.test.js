// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/ai/index', () => ({
  createProvider: vi.fn()
}));

vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({ getPatterns: () => [] })
}));

const Analyzer = require('../../src/ai/analyzer');

/**
 * Tests for consolidation prompt construction in the Analyzer.
 *
 * Because the Analyzer's CJS module graph is difficult to mock in vitest's
 * forks pool (createProvider, child_process, etc.), we use two complementary
 * testing strategies:
 *
 * 1. Source verification: Read analyzer.js source and verify the prompt
 *    construction patterns via regex (same approach as the timeout threading tests).
 *
 * 2. Direct method tests: Test the helper methods (buildOrchestrationLineNumberGuidance,
 *    buildCustomInstructionsSection) that feed into the consolidation prompts.
 */

const fs = require('fs');
const path = require('path');
const analyzerSource = fs.readFileSync(
  path.join(__dirname, '../../src/ai/analyzer.js'),
  'utf-8'
);

describe('_intraLevelConsolidate prompt construction (source verification)', () => {
  /**
   * Extract the body of _intraLevelConsolidate for focused assertions.
   */
  const methodMatch = analyzerSource.match(
    /async _intraLevelConsolidate\(level, voiceGroups, prMetadata, customInstructions, worktreePath, orchConfig\)\s*\{([\s\S]*?)\n  \}/
  );
  const methodBody = methodMatch ? methodMatch[1] : '';

  it('should extract the method body successfully', () => {
    expect(methodBody.length).toBeGreaterThan(100);
  });

  it('should call getPromptBuilder with "consolidation" and tier from orchConfig', () => {
    // Verify it calls getPromptBuilder('consolidation', tier || 'balanced', provider)
    expect(methodBody).toMatch(/getPromptBuilder\(\s*'consolidation'\s*,\s*tier\s*\|\|\s*'balanced'\s*,\s*provider\s*\)/);
  });

  it('should destructure tier from orchConfig', () => {
    expect(methodBody).toMatch(/const\s*\{[^}]*tier[^}]*\}\s*=\s*orchConfig/);
  });

  it('should destructure reviewerCount from orchConfig', () => {
    expect(methodBody).toMatch(/const\s*\{[^}]*reviewerCount[^}]*\}\s*=\s*orchConfig/);
  });

  it('should pass customInstructions to build context via buildCustomInstructionsSection', () => {
    // Verify the ternary pattern: customInstructions ? this.buildCustomInstructionsSection(...) : ''
    expect(methodBody).toContain('customInstructions: customInstructions ? this.buildCustomInstructionsSection(customInstructions)');
  });

  it('should pass lineNumberGuidance to build context via buildOrchestrationLineNumberGuidance', () => {
    expect(methodBody).toContain('lineNumberGuidance: this.buildOrchestrationLineNumberGuidance(worktreePath)');
  });

  it('should pass reviewerCount from orchConfig (numeric), not a hardcoded string', () => {
    // Should use the destructured reviewerCount variable, with fallback to 'multiple'
    expect(methodBody).toMatch(/reviewerCount:\s*reviewerCount\s*\|\|\s*'multiple'/);
  });

  it('should reference prMetadata.pr_number (not prMetadata.number) in review description', () => {
    expect(methodBody).toContain('prMetadata.pr_number');
    expect(methodBody).not.toMatch(/prMetadata\.number(?!_)/); // .number not followed by _
  });

  it('should format per-reviewer groups with Review Focus when customInstructions present', () => {
    expect(methodBody).toContain('**Review Focus:**');
    expect(methodBody).toContain('g.customInstructions');
  });

  it('should include Summary section when voice group has a summary', () => {
    expect(methodBody).toContain('**Summary:**');
    expect(methodBody).toContain('g.summary');
  });

  it('should compute suggestionCount from voiceGroups', () => {
    expect(methodBody).toMatch(/voiceGroups\.reduce\(\s*\(sum,\s*g\)\s*=>\s*sum\s*\+\s*g\.suggestions\.length/);
  });

  it('should join per-reviewer sections with separator', () => {
    expect(methodBody).toContain("'\\n\\n---\\n\\n'");
  });
});

describe('_crossVoiceConsolidate prompt construction (source verification)', () => {
  /**
   * Extract the body of _crossVoiceConsolidate for focused assertions.
   */
  const methodMatch = analyzerSource.match(
    /async _crossVoiceConsolidate\(voiceReviews, prMetadata, customInstructions, worktreePath, config\)\s*\{([\s\S]*?)\n  \}/
  );
  const methodBody = methodMatch ? methodMatch[1] : '';

  it('should extract the method body successfully', () => {
    expect(methodBody.length).toBeGreaterThan(100);
  });

  it('should call getPromptBuilder with "consolidation" and tier from config', () => {
    expect(methodBody).toMatch(/getPromptBuilder\(\s*'consolidation'\s*,\s*tier\s*\|\|\s*'balanced'\s*,\s*provider\s*\)/);
  });

  it('should destructure tier from config', () => {
    expect(methodBody).toMatch(/const\s*\{[^}]*tier[^}]*\}\s*=\s*config/);
  });

  it('should pass customInstructions to build context via buildCustomInstructionsSection', () => {
    expect(methodBody).toContain('customInstructions: customInstructions ? this.buildCustomInstructionsSection(customInstructions)');
  });

  it('should pass lineNumberGuidance to build context via buildOrchestrationLineNumberGuidance', () => {
    expect(methodBody).toContain('lineNumberGuidance: this.buildOrchestrationLineNumberGuidance(worktreePath)');
  });

  it('should pass voiceReviews.length as reviewerCount (numeric)', () => {
    // The cross-voice method uses voiceReviews.length directly
    expect(methodBody).toMatch(/reviewerCount:\s*voiceReviews\.length/);
  });

  it('should reference prMetadata.pr_number (not prMetadata.number) in review description', () => {
    expect(methodBody).toContain('prMetadata.pr_number');
    expect(methodBody).not.toMatch(/prMetadata\.number(?!_)/);
  });

  it('should compute suggestionCount as sum of all voice review suggestion counts', () => {
    expect(methodBody).toMatch(/suggestionCount:\s*voiceReviews\.reduce\(\s*\(sum,\s*v\)\s*=>\s*sum\s*\+\s*v\.suggestionCount/);
  });

  it('should include Review Focus block when customInstructions present', () => {
    expect(methodBody).toContain('**Review Focus:**');
    expect(methodBody).toContain('v.customInstructions');
  });

  it('should join voice descriptions with separator', () => {
    expect(methodBody).toContain("'\\n\\n---\\n\\n'");
  });
});

describe('Per-reviewer context threading (source verification)', () => {
  it('voiceReviews assembly should include customInstructions field', () => {
    // In runReviewerCentricCouncil, voiceReviews map should include customInstructions
    const voiceReviewsMatch = analyzerSource.match(
      /const voiceReviews = successfulVoices\.map\(v => \(\{([\s\S]*?)\}\)\);/
    );
    expect(voiceReviewsMatch).not.toBeNull();
    expect(voiceReviewsMatch[1]).toContain('customInstructions: v.customInstructions');
  });

  it('voice promise returns should include customInstructions in runReviewerCentricCouncil', () => {
    // Both executable and native provider returns should have customInstructions
    const executableReturn = analyzerSource.match(/return \{ voiceKey, reviewerLabel, childRunId, result: validatedResult.*isExecutable: true.*\}/);
    expect(executableReturn).not.toBeNull();
    expect(executableReturn[0]).toContain('customInstructions: voice.customInstructions');

    const nativeReturn = analyzerSource.match(/return \{ voiceKey, reviewerLabel, childRunId, result, provider:.*isExecutable: false.*\}/);
    expect(nativeReturn).not.toBeNull();
    expect(nativeReturn[0]).toContain('customInstructions: voice.customInstructions');
  });

  it('voiceTasks in runCouncilAnalysis should include voiceCustomInstructions', () => {
    // voiceTasks.push should have voiceCustomInstructions separate from customInstructions
    const voiceTasksMatch = analyzerSource.match(
      /voiceTasks\.push\(\{([\s\S]*?)\}\);/
    );
    expect(voiceTasksMatch).not.toBeNull();
    expect(voiceTasksMatch[1]).toContain('voiceCustomInstructions: voice.customInstructions');
  });

  it('_intraLevelConsolidate call site should build voiceGroups from successfulVoicesForLevel', () => {
    // The call site should build voiceGroups before calling _intraLevelConsolidate
    expect(analyzerSource).toContain('const voiceGroups = successfulVoicesForLevel.map');
    expect(analyzerSource).toContain('customInstructions: task.voiceCustomInstructions');
  });

  it('_intraLevelConsolidate call site should include summary in voiceGroups', () => {
    expect(analyzerSource).toContain('summary: voiceResults[idx].value.summary');
  });
});

describe('runReviewerCentricCouncil below-threshold skip removal (source verification)', () => {
  /**
   * Extract the body of runReviewerCentricCouncil for focused assertions.
   */
  const methodMatch = analyzerSource.match(
    /async runReviewerCentricCouncil\([^)]*\)\s*\{([\s\S]*?)\n  async runCouncilAnalysis/
  );
  const methodBody = methodMatch ? methodMatch[1] : '';

  it('should extract the method body successfully', () => {
    expect(methodBody.length).toBeGreaterThan(100);
  });

  it('should NOT contain COUNCIL_CONSOLIDATION_THRESHOLD check', () => {
    expect(methodBody).not.toContain('COUNCIL_CONSOLIDATION_THRESHOLD');
  });

  it('should still contain single-voice shortcut', () => {
    expect(methodBody).toContain('successfulVoices.length === 1');
  });

  it('should NOT collect voiceSummaries array', () => {
    expect(methodBody).not.toContain('voiceSummaries');
  });

  it('should always proceed to cross-reviewer consolidation for multiple voices', () => {
    expect(methodBody).toContain('Starting cross-reviewer consolidation');
  });
});

describe('runCouncilAnalysis below-threshold skip removal (source verification)', () => {
  const methodMatch = analyzerSource.match(
    /async runCouncilAnalysis\([^)]*\)\s*\{([\s\S]*?)\n  async /
  );
  const methodBody = methodMatch ? methodMatch[1] : '';

  it('should extract the method body successfully', () => {
    expect(methodBody.length).toBeGreaterThan(100);
  });

  it('should NOT contain COUNCIL_CONSOLIDATION_THRESHOLD check', () => {
    expect(methodBody).not.toContain('COUNCIL_CONSOLIDATION_THRESHOLD');
  });

  it('should still contain single-voice shortcut', () => {
    expect(methodBody).toContain('voiceSuccessCount === 1');
  });

  it('should always proceed to consolidation for multi-voice results', () => {
    expect(methodBody).toContain('Cross-level consolidation');
  });
});

describe('_crossVoiceConsolidate summary extraction (source verification)', () => {
  const methodMatch = analyzerSource.match(
    /async _crossVoiceConsolidate\(voiceReviews, prMetadata, customInstructions, worktreePath, config\)\s*\{([\s\S]*?)\n  \}/
  );
  const methodBody = methodMatch ? methodMatch[1] : '';

  it('should extract the method body successfully', () => {
    expect(methodBody.length).toBeGreaterThan(100);
  });

  it('should extract summary from response.raw via extractJSON', () => {
    expect(methodBody).toContain('response.raw');
    expect(methodBody).toContain('extractJSON');
  });

  it('should check response.summary first', () => {
    expect(methodBody).toContain('response.summary');
  });

  it('should use let for summary variable (not const with fallback)', () => {
    expect(methodBody).toMatch(/let summary/);
  });

  it('should fall back to individual reviewer summaries instead of generic consolidation text', () => {
    expect(methodBody).toContain('reviewerSummaries');
    expect(methodBody).not.toContain('Consolidated ${voiceReviews.length}');
  });
});

describe('Consolidation prompt templates (direct tests)', () => {
  it('thorough consolidation template should contain reviewer-context-guidance section', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    expect(thorough.taggedPrompt).toContain('name="reviewer-context-guidance"');
    expect(thorough.taggedPrompt).toContain('Reviewer Context Awareness');
    expect(thorough.defaultOrder).toContain('reviewer-context-guidance');
    const sectionIdx = thorough.defaultOrder.indexOf('reviewer-context-guidance');
    expect(thorough.defaultOrder[sectionIdx + 1]).toBe('input-suggestions');
  });

  it('balanced consolidation template should contain reviewer-context-guidance section', () => {
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    expect(balanced.taggedPrompt).toContain('name="reviewer-context-guidance"');
    expect(balanced.taggedPrompt).toContain('Reviewer Context Awareness');
    expect(balanced.defaultOrder).toContain('reviewer-context-guidance');
    const sectionIdx = balanced.defaultOrder.indexOf('reviewer-context-guidance');
    expect(balanced.defaultOrder[sectionIdx + 1]).toBe('input-suggestions');
  });

  it('fast consolidation template should contain reviewer-context-guidance section', () => {
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');
    expect(fast.taggedPrompt).toContain('name="reviewer-context-guidance"');
    expect(fast.taggedPrompt).toContain('Reviewer Context');
    expect(fast.defaultOrder).toContain('reviewer-context-guidance');
    const sectionIdx = fast.defaultOrder.indexOf('reviewer-context-guidance');
    expect(fast.defaultOrder[sectionIdx + 1]).toBe('input-suggestions');
  });

  it('all tiers should have reviewer-context-guidance in sections metadata', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [thorough, balanced, fast]) {
      const section = template.sections.find(s => s.name === 'reviewer-context-guidance');
      expect(section).toBeDefined();
      expect(section.required).toBe(true);
    }
  });

  it('all tiers should have balanced-output and summary-synthesis sections', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [thorough, balanced, fast]) {
      expect(template.taggedPrompt).toContain('name="balanced-output"');
      expect(template.taggedPrompt).toContain('name="summary-synthesis"');
      expect(template.defaultOrder).toContain('balanced-output');
      expect(template.defaultOrder).toContain('summary-synthesis');

      const balancedSection = template.sections.find(s => s.name === 'balanced-output');
      expect(balancedSection).toBeDefined();
      expect(balancedSection.required).toBe(true);

      const synthSection = template.sections.find(s => s.name === 'summary-synthesis');
      expect(synthSection).toBeDefined();
      expect(synthSection.required).toBe(true);
    }
  });

  it('priority-curation should NOT exist in any tier', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [thorough, balanced, fast]) {
      expect(template.taggedPrompt).not.toContain('name="priority-curation"');
      expect(template.defaultOrder).not.toContain('priority-curation');
      expect(template.sections.find(s => s.name === 'priority-curation')).toBeUndefined();
    }
  });

  it('balanced-output should appear before summary-synthesis in defaultOrder', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [thorough, balanced, fast]) {
      const balancedIdx = template.defaultOrder.indexOf('balanced-output');
      const synthIdx = template.defaultOrder.indexOf('summary-synthesis');
      expect(balancedIdx).toBeLessThan(synthIdx);
    }
  });

  it('summary guidance should require structured markdown summaries', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [thorough, balanced, fast]) {
      const parsed = template.parseSections();
      const outputSchema = parsed.find(s => s.name === 'output-schema');
      const synthSection = parsed.find(s => s.name === 'summary-synthesis');

      expect(outputSchema).toBeDefined();
      expect(synthSection).toBeDefined();

      expect(outputSchema.content).toContain('Formatted markdown summary');
      expect(outputSchema.content).toMatch(/guidance above\./i);
      expect(outputSchema.content).not.toContain('1-2 sentences of overall assessment');
      expect(outputSchema.content).not.toContain('bullet list of specific points');
      expect(outputSchema.content).not.toContain('single reviewer');
      expect(outputSchema.content).not.toContain('Single cohesive paragraph');

      expect(synthSection.content).toMatch(/not(?: be)? one big paragraph/);
      expect(synthSection.content).toContain('1-2 sentences');
      expect(synthSection.content).toContain('bullet list');
      expect(synthSection.content).toContain('After the bullets');
    }
  });

  it('balanced-output should use deduplication framing, not count reduction', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [thorough, balanced, fast]) {
      expect(template.taggedPrompt).toContain('Deduplicate');
      expect(template.taggedPrompt).not.toContain('Your output should contain *fewer* suggestions');
    }
  });

  it('parseSections should return balanced-output and summary-synthesis as required sections', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [thorough, balanced, fast]) {
      const parsed = template.parseSections();

      const balancedSection = parsed.find(s => s.name === 'balanced-output');
      expect(balancedSection).toBeDefined();
      expect(balancedSection.required).toBe(true);
      expect(balancedSection.content.length).toBeGreaterThan(10);

      const synthSection = parsed.find(s => s.name === 'summary-synthesis');
      expect(synthSection).toBeDefined();
      expect(synthSection.required).toBe(true);
      expect(synthSection.content.length).toBeGreaterThan(10);
    }
  });
});

describe('Consolidation helper methods (direct tests)', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new Analyzer({}, 'sonnet', 'claude');
  });

  describe('buildCustomInstructionsSection', () => {
    it('should return formatted section when customInstructions is provided', () => {
      const result = analyzer.buildCustomInstructionsSection('Focus on security issues');
      expect(result).toContain('Focus on security issues');
      expect(result).toContain('Additional Review Instructions');
    });

    it('should return empty string when customInstructions is null', () => {
      const result = analyzer.buildCustomInstructionsSection(null);
      expect(result).toBe('');
    });

    it('should return empty string when customInstructions is empty', () => {
      const result = analyzer.buildCustomInstructionsSection('');
      expect(result).toBe('');
    });

    it('should return empty string when customInstructions is whitespace only', () => {
      const result = analyzer.buildCustomInstructionsSection('   ');
      expect(result).toBe('');
    });
  });

  describe('buildOrchestrationLineNumberGuidance', () => {
    it('should return guidance containing Line Number Handling header', () => {
      const result = analyzer.buildOrchestrationLineNumberGuidance('/tmp/worktree');
      expect(result).toContain('## Line Number Handling');
    });

    it('should include worktree path in guidance when provided', () => {
      const result = analyzer.buildOrchestrationLineNumberGuidance('/tmp/worktree');
      expect(result).toContain('--cwd "/tmp/worktree"');
    });

    it('should omit --cwd when worktree path is null', () => {
      const result = analyzer.buildOrchestrationLineNumberGuidance(null);
      expect(result).not.toContain('--cwd');
    });
  });

  describe('buildPRContextSection for consolidation', () => {
    it('should use pr_number field in PR context', () => {
      const result = analyzer.buildPRContextSection(
        { pr_number: 42, title: 'Test PR', description: 'Test', repository: 'owner/repo' },
        'note'
      );
      expect(result).toContain('42');
    });

    it('should use "local" context for local review type', () => {
      const result = analyzer.buildPRContextSection(
        { pr_number: 99, title: 'Local', description: 'Test', reviewType: 'local' },
        'note'
      );
      expect(result).toContain('Review Context');
      expect(result).not.toContain('Pull Request Context');
    });
  });
});
