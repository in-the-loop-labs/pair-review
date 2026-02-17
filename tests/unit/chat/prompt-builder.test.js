// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';

const { buildChatPrompt, buildInitialContext } = require('../../../src/chat/prompt-builder');

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

  describe('reviewId in prompt', () => {
    it('should include reviewId in prompt when review has an id', () => {
      const prompt = buildChatPrompt({
        review: { id: 42, repository: 'owner/repo', pr_number: 1 }
      });

      expect(prompt).toContain('The review ID for this session is: 42');
      expect(prompt).toContain('/api/reviews/42/comments');
    });

    it('should not include reviewId section when review has no id', () => {
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 1 }
      });

      expect(prompt).not.toContain('The review ID for this session is');
    });

    it('should not include reviewId section when review is null', () => {
      const prompt = buildChatPrompt({ review: null });

      expect(prompt).not.toContain('The review ID for this session is');
    });
  });

  describe('port not in system prompt', () => {
    it('should not include a localhost URL with port in the system prompt', () => {
      const prompt = buildChatPrompt({
        review: { id: 1, repository: 'owner/repo', pr_number: 1 }
      });

      expect(prompt).not.toMatch(/http:\/\/localhost:\d+/);
      expect(prompt).toContain('server port is provided once at the start of each session');
    });
  });

  describe('general prompt structure', () => {
    it('should always include role and instructions', () => {
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 1 }
      });

      expect(prompt).toContain('code review assistant');
      expect(prompt).toContain('Do not modify any files');
      expect(prompt).toContain('Be concise and helpful');
      expect(prompt).toContain('markdown formatting');
    });

    it('should not include suggestion or diff content (lean prompt)', () => {
      const prompt = buildChatPrompt({
        review: { repository: 'owner/repo', pr_number: 1 }
      });

      expect(prompt).not.toContain('specific suggestion');
      expect(prompt).not.toContain('Relevant diff');
      expect(prompt).not.toContain('AI analysis has been run');
    });

    it('should include API capability section', () => {
      const prompt = buildChatPrompt({
        review: { id: 5, repository: 'owner/repo', pr_number: 1 }
      });

      expect(prompt).toContain('pair-review API');
      expect(prompt).toContain('pair-review-api skill');
    });
  });
});

describe('buildInitialContext', () => {
  describe('with suggestions', () => {
    it('should format suggestions as JSON block', () => {
      const suggestions = [
        {
          id: 1,
          file: 'src/index.js',
          line_start: 10,
          line_end: 15,
          type: 'bug',
          title: 'Potential null pointer',
          body: 'The variable may be null here',
          reasoning: '["Step 1", "Step 2"]',
          status: 'active',
          ai_confidence: 0.9,
          is_file_level: 0
        },
        {
          id: 2,
          file: 'src/utils.js',
          line_start: 5,
          line_end: 5,
          type: 'improvement',
          title: 'Use const',
          body: 'This variable is never reassigned',
          reasoning: null,
          status: 'active',
          ai_confidence: 0.7,
          is_file_level: 0
        }
      ];

      const context = buildInitialContext({ suggestions });

      expect(context).toContain('2 AI suggestions');
      expect(context).toContain('```json');
      expect(context).toContain('Potential null pointer');
      expect(context).toContain('Use const');
      expect(context).toContain('src/index.js');
      expect(context).toContain('src/utils.js');
    });

    it('should parse reasoning from JSON string', () => {
      const suggestions = [
        {
          id: 1,
          file: 'test.js',
          line_start: 1,
          type: 'bug',
          title: 'Test',
          body: 'Test body',
          reasoning: '["Step A", "Step B"]',
          status: 'active',
          ai_confidence: 0.8,
          is_file_level: 0
        }
      ];

      const context = buildInitialContext({ suggestions });
      // The JSON string should have been parsed into an array
      expect(context).toContain('"Step A"');
      expect(context).toContain('"Step B"');
    });

    it('should handle reasoning that is already an array', () => {
      const suggestions = [
        {
          id: 1,
          file: 'test.js',
          line_start: 1,
          type: 'bug',
          title: 'Test',
          body: 'Test body',
          reasoning: ['Step A', 'Step B'],
          status: 'active',
          ai_confidence: 0.8,
          is_file_level: 0
        }
      ];

      const context = buildInitialContext({ suggestions });
      expect(context).toContain('"Step A"');
    });

    it('should handle malformed reasoning JSON gracefully', () => {
      const context = buildInitialContext({
        suggestions: [{
          id: 1, file: 'test.js', line_start: 1, line_end: 5,
          type: 'bug', title: 'Bad reasoning', body: 'test',
          reasoning: 'not valid json',
          status: 'active', ai_confidence: 0.9, is_file_level: false
        }]
      });
      expect(context).toContain('"reasoning": null');
    });

    it('should handle truncated reasoning JSON gracefully', () => {
      const context = buildInitialContext({
        suggestions: [{
          id: 1, file: 'test.js', line_start: 1, line_end: 5,
          type: 'bug', title: 'Truncated', body: 'test',
          reasoning: '["Step 1"',
          status: 'active', ai_confidence: 0.9, is_file_level: false
        }]
      });
      expect(context).toContain('"reasoning": null');
    });

    it('should handle null reasoning', () => {
      const suggestions = [
        {
          id: 1,
          file: 'test.js',
          line_start: 1,
          type: 'bug',
          title: 'Test',
          body: 'Test body',
          reasoning: null,
          status: 'active',
          ai_confidence: 0.8,
          is_file_level: 0
        }
      ];

      const context = buildInitialContext({ suggestions });
      expect(context).toContain('"reasoning": null');
    });
  });

  describe('with focused suggestion', () => {
    it('should include focused suggestion section', () => {
      const focusedSuggestion = {
        id: 5,
        file: 'src/main.js',
        line_start: 20,
        line_end: 25,
        type: 'issue',
        title: 'Memory leak',
        body: 'This event listener is never removed',
        reasoning: null,
        status: 'active',
        ai_confidence: 0.95,
        is_file_level: 0
      };

      const context = buildInitialContext({ suggestions: [], focusedSuggestion });

      expect(context).toContain('asking about this specific suggestion');
      expect(context).toContain('Memory leak');
      expect(context).toContain('src/main.js');
    });

    it('should include both suggestions and focused suggestion', () => {
      const suggestions = [
        {
          id: 1, file: 'a.js', line_start: 1, type: 'bug',
          title: 'Bug A', body: 'Body A', reasoning: null,
          status: 'active', ai_confidence: 0.5, is_file_level: 0
        }
      ];
      const focusedSuggestion = {
        id: 1, file: 'a.js', line_start: 1, type: 'bug',
        title: 'Bug A', body: 'Body A', reasoning: null,
        status: 'active', ai_confidence: 0.5, is_file_level: 0
      };

      const context = buildInitialContext({ suggestions, focusedSuggestion });

      expect(context).toContain('1 AI suggestion');
      expect(context).toContain('Here is 1 AI suggestion');
      expect(context).toContain('asking about this specific suggestion');
    });
  });

  describe('port not included (injected at session start by chat route)', () => {
    it('should not include server URL even when suggestions are present', () => {
      const context = buildInitialContext({
        suggestions: [{
          id: 1, file: 'a.js', line_start: 1, type: 'bug',
          title: 'Bug', body: 'Body', reasoning: null,
          status: 'active', ai_confidence: 0.5, is_file_level: 0
        }]
      });

      expect(context).not.toContain('localhost');
    });
  });

  describe('edge cases', () => {
    it('should return null when no suggestions and no focused suggestion', () => {
      const context = buildInitialContext({ suggestions: [] });
      expect(context).toBeNull();
    });

    it('should return null when suggestions is null', () => {
      const context = buildInitialContext({ suggestions: null });
      expect(context).toBeNull();
    });

    it('should return null when suggestions is undefined', () => {
      const context = buildInitialContext({});
      expect(context).toBeNull();
    });
  });
});
