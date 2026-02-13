// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';

const { buildChatPrompt } = require('../../../src/chat/prompt-builder');

describe('buildChatPrompt', () => {
  describe('review context', () => {
    it('should build prompt with PR review context (repository + pr_number)', () => {
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 42, review_type: 'pr' }
      });

      expect(prompt).toContain('owner/repo');
      expect(prompt).toContain('PR #42');
      expect(prompt).toContain('code review assistant');
    });

    it('should build prompt with local review context (local_path)', () => {
      const prompt = buildChatPrompt({
        review: { review_type: 'local', local_path: '/home/user/project', name: 'my-project' }
      });

      expect(prompt).toContain('local code review');
      expect(prompt).toContain('my-project');
    });

    it('should use local_path as fallback name for local review', () => {
      const prompt = buildChatPrompt({
        review: { review_type: 'local', local_path: '/home/user/project' }
      });

      expect(prompt).toContain('local code review');
      expect(prompt).toContain('/home/user/project');
    });

    it('should handle null review gracefully', () => {
      const prompt = buildChatPrompt({ review: null });

      expect(prompt).toContain('Review context: unknown.');
    });

    it('should handle review with no repository or pr_number', () => {
      const prompt = buildChatPrompt({ review: {} });

      expect(prompt).toContain('Review context: unknown.');
    });
  });

  describe('analysis run context', () => {
    it('should include analysis run summary when provided', () => {
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 1 },
        analysisRun: {
          provider: 'claude',
          model: 'sonnet',
          total_suggestions: 5,
          summary: 'Found 3 bugs and 2 improvements'
        }
      });

      expect(prompt).toContain('AI analysis has been run');
      expect(prompt).toContain('claude/sonnet');
      expect(prompt).toContain('Total suggestions: 5');
      expect(prompt).toContain('Found 3 bugs and 2 improvements');
    });

    it('should omit analysis section when not provided', () => {
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 1 }
      });

      expect(prompt).not.toContain('AI analysis has been run');
    });
  });

  describe('suggestion context', () => {
    it('should include suggestion context when provided', () => {
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 1 },
        suggestion: {
          title: 'Potential null pointer',
          body: 'The variable may be null here',
          reasoning: ['Step 1: checked types', 'Step 2: found issue'],
          type: 'bug',
          file: 'src/index.js',
          line_start: 10,
          line_end: 15
        }
      });

      expect(prompt).toContain('specific suggestion');
      expect(prompt).toContain('Title: Potential null pointer');
      expect(prompt).toContain('Type: bug');
      expect(prompt).toContain('File: src/index.js');
      expect(prompt).toContain('lines 10-15');
      expect(prompt).toContain('The variable may be null here');
      expect(prompt).toContain('1. Step 1: checked types');
      expect(prompt).toContain('2. Step 2: found issue');
    });

    it('should handle suggestion with single line', () => {
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 1 },
        suggestion: {
          title: 'Test',
          file: 'src/foo.js',
          line_start: 5
        }
      });

      expect(prompt).toContain('line 5)');
      expect(prompt).not.toContain('lines 5-');
    });

    it('should handle suggestion with same start and end line', () => {
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 1 },
        suggestion: {
          title: 'Test',
          file: 'src/foo.js',
          line_start: 5,
          line_end: 5
        }
      });

      expect(prompt).toContain('line 5)');
    });

    it('should omit suggestion section when not provided', () => {
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 1 }
      });

      expect(prompt).not.toContain('specific suggestion');
    });
  });

  describe('diff context', () => {
    it('should include diff when provided', () => {
      const diff = '@@ -1,3 +1,4 @@\n+new line\n old line';
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 1 },
        diff
      });

      expect(prompt).toContain('Relevant diff:');
      expect(prompt).toContain(diff);
    });

    it('should truncate long diff content (> 10000 chars)', () => {
      const longDiff = 'x'.repeat(15000);
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 1 },
        diff: longDiff
      });

      expect(prompt).toContain('characters omitted');
      // Should not contain the full diff
      expect(prompt).not.toContain(longDiff);
      // Should contain head and tail portions
      expect(prompt.length).toBeLessThan(longDiff.length);
    });

    it('should return empty string section for empty diff', () => {
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 1 },
        diff: ''
      });

      expect(prompt).not.toContain('Relevant diff:');
    });

    it('should return empty string section for null diff', () => {
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 1 },
        diff: null
      });

      expect(prompt).not.toContain('Relevant diff:');
    });
  });

  describe('general prompt structure', () => {
    it('should always include role and instructions', () => {
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 1 }
      });

      expect(prompt).toContain('code review assistant');
      expect(prompt).toContain('Be concise and helpful');
      expect(prompt).toContain('markdown formatting');
    });
  });
});
