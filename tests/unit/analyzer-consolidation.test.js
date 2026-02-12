// SPDX-License-Identifier: GPL-3.0-or-later
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
    /async _intraLevelConsolidate\(level, suggestions, prMetadata, customInstructions, worktreePath, orchConfig\)\s*\{([\s\S]*?)\n  \}/
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
