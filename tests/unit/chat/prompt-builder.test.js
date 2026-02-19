// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';

const { buildChatPrompt, buildInitialContext, formatAnalysisRunContext } = require('../../../src/chat/prompt-builder');

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

  describe('with analysisRun metadata', () => {
    const sampleRun = {
      id: 'run-abc-123',
      provider: 'council',
      model: 'claude-sonnet-4',
      status: 'completed',
      started_at: '2026-02-18T10:00:00Z',
      completed_at: '2026-02-18T10:05:00Z',
      config_type: 'advanced',
      parent_run_id: null,
      head_sha: 'abc1234',
      total_suggestions: 5,
      files_analyzed: 3,
      levels_config: '{"1":true,"2":true,"3":false}',
      summary: 'Found 5 issues: 2 bugs, 2 improvements, 1 praise.'
    };

    const sampleSuggestions = [
      {
        id: 1, file: 'a.js', line_start: 1, type: 'bug',
        title: 'Bug A', body: 'Body A', reasoning: null,
        status: 'active', ai_confidence: 0.5, is_file_level: 0
      }
    ];

    it('should include run metadata section when analysisRun is provided', () => {
      const context = buildInitialContext({
        suggestions: sampleSuggestions,
        analysisRun: sampleRun
      });

      expect(context).toContain('## Analysis Run Metadata');
      expect(context).toContain('run-abc-123');
      expect(context).toContain('council');
      expect(context).toContain('claude-sonnet-4');
      expect(context).toContain('completed');
      expect(context).toContain('2026-02-18T10:00:00Z');
      expect(context).toContain('advanced');
      expect(context).toContain('abc1234');
    });

    it('should include analysis summary in context', () => {
      const context = buildInitialContext({
        suggestions: sampleSuggestions,
        analysisRun: sampleRun
      });

      expect(context).toContain('### Analysis Summary');
      expect(context).toContain('Found 5 issues: 2 bugs, 2 improvements, 1 praise.');
    });

    it('should include levels_config as parsed JSON', () => {
      const context = buildInitialContext({
        suggestions: sampleSuggestions,
        analysisRun: sampleRun
      });

      expect(context).toContain('**Levels config**');
      expect(context).toContain('"1":true');
    });

    it('should include parent_run_id when present (council info)', () => {
      const runWithParent = { ...sampleRun, parent_run_id: 'parent-run-xyz' };
      const context = buildInitialContext({
        suggestions: sampleSuggestions,
        analysisRun: runWithParent
      });

      expect(context).toContain('**Parent run (council)**');
      expect(context).toContain('parent-run-xyz');
    });

    it('should not include parent_run_id line when null', () => {
      const context = buildInitialContext({
        suggestions: sampleSuggestions,
        analysisRun: { ...sampleRun, parent_run_id: null }
      });

      expect(context).not.toContain('Parent run (council)');
    });

    it('should not include summary section when summary is null', () => {
      const context = buildInitialContext({
        suggestions: sampleSuggestions,
        analysisRun: { ...sampleRun, summary: null }
      });

      expect(context).toContain('## Analysis Run Metadata');
      expect(context).not.toContain('### Analysis Summary');
    });

    it('should handle levels_config that is already an object', () => {
      const context = buildInitialContext({
        suggestions: sampleSuggestions,
        analysisRun: { ...sampleRun, levels_config: { '1': true, '2': false } }
      });

      expect(context).toContain('**Levels config**');
      expect(context).toContain('"1":true');
    });

    it('should skip levels_config when null', () => {
      const context = buildInitialContext({
        suggestions: sampleSuggestions,
        analysisRun: { ...sampleRun, levels_config: null }
      });

      expect(context).not.toContain('Levels config');
    });

    it('should handle malformed levels_config JSON gracefully', () => {
      const context = buildInitialContext({
        suggestions: sampleSuggestions,
        analysisRun: { ...sampleRun, levels_config: 'not valid json' }
      });

      // Should not throw and should not include Levels config line
      expect(context).toContain('## Analysis Run Metadata');
      expect(context).not.toContain('Levels config');
    });

    it('should place run metadata before suggestions in the output', () => {
      const context = buildInitialContext({
        suggestions: sampleSuggestions,
        analysisRun: sampleRun
      });

      const metaIndex = context.indexOf('## Analysis Run Metadata');
      const suggestionsIndex = context.indexOf('AI suggestion');
      expect(metaIndex).toBeLessThan(suggestionsIndex);
    });

    it('should include total_suggestions and files_analyzed counts', () => {
      const context = buildInitialContext({
        suggestions: sampleSuggestions,
        analysisRun: sampleRun
      });

      expect(context).toContain('**Total suggestions**: 5');
      expect(context).toContain('**Files analyzed**: 3');
    });

    it('should not include analysisRun section when analysisRun is null', () => {
      const context = buildInitialContext({
        suggestions: sampleSuggestions,
        analysisRun: null
      });

      expect(context).not.toContain('## Analysis Run Metadata');
      expect(context).toContain('1 AI suggestion');
    });

    it('should return only run metadata when suggestions are empty', () => {
      const context = buildInitialContext({
        suggestions: [],
        analysisRun: sampleRun
      });

      expect(context).toContain('## Analysis Run Metadata');
      expect(context).not.toContain('AI suggestion');
    });

    it('should include run metadata with minimal fields (only id and status)', () => {
      const minimalRun = { id: 'run-min', status: 'running' };
      const context = buildInitialContext({
        suggestions: sampleSuggestions,
        analysisRun: minimalRun
      });

      expect(context).toContain('run-min');
      expect(context).toContain('running');
      expect(context).not.toContain('Provider');
      expect(context).not.toContain('Model');
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

describe('formatAnalysisRunContext', () => {
  it('should format all fields of a complete run', () => {
    const result = formatAnalysisRunContext({
      id: 'run-1',
      provider: 'council',
      model: 'opus',
      status: 'completed',
      started_at: '2026-01-01',
      completed_at: '2026-01-02',
      config_type: 'advanced',
      parent_run_id: 'parent-1',
      head_sha: 'deadbeef',
      total_suggestions: 10,
      files_analyzed: 5,
      levels_config: '{"1":true}',
      summary: 'All good.'
    });

    expect(result).toContain('## Analysis Run Metadata');
    expect(result).toContain('run-1');
    expect(result).toContain('council');
    expect(result).toContain('opus');
    expect(result).toContain('completed');
    expect(result).toContain('2026-01-01');
    expect(result).toContain('2026-01-02');
    expect(result).toContain('advanced');
    expect(result).toContain('parent-1');
    expect(result).toContain('deadbeef');
    expect(result).toContain('10');
    expect(result).toContain('5');
    expect(result).toContain('### Analysis Summary');
    expect(result).toContain('All good.');
  });

  it('should omit optional fields when null/undefined', () => {
    const result = formatAnalysisRunContext({
      id: 'run-2',
      status: 'running'
    });

    expect(result).toContain('run-2');
    expect(result).toContain('running');
    expect(result).not.toContain('Provider');
    expect(result).not.toContain('Model');
    expect(result).not.toContain('Summary');
  });

  it('should include repo_instructions when present', () => {
    const result = formatAnalysisRunContext({
      id: 'run-3',
      status: 'completed',
      repo_instructions: 'Focus on security issues and SQL injection.'
    });

    expect(result).toContain('### Repository Instructions');
    expect(result).toContain('Focus on security issues and SQL injection.');
  });

  it('should not include repo_instructions section when null', () => {
    const result = formatAnalysisRunContext({
      id: 'run-4',
      status: 'completed',
      repo_instructions: null
    });

    expect(result).not.toContain('Repository Instructions');
  });

  it('should not include repo_instructions section when empty string', () => {
    const result = formatAnalysisRunContext({
      id: 'run-5',
      status: 'completed',
      repo_instructions: ''
    });

    expect(result).not.toContain('Repository Instructions');
  });

  it('should include request_instructions when present', () => {
    const result = formatAnalysisRunContext({
      id: 'run-6',
      status: 'completed',
      request_instructions: 'Pay special attention to error handling.'
    });

    expect(result).toContain('### Custom Instructions (this run)');
    expect(result).toContain('Pay special attention to error handling.');
  });

  it('should not include request_instructions section when null', () => {
    const result = formatAnalysisRunContext({
      id: 'run-7',
      status: 'completed',
      request_instructions: null
    });

    expect(result).not.toContain('Custom Instructions');
  });

  it('should not include request_instructions section when empty string', () => {
    const result = formatAnalysisRunContext({
      id: 'run-8',
      status: 'completed',
      request_instructions: ''
    });

    expect(result).not.toContain('Custom Instructions');
  });

  it('should include both repo_instructions and request_instructions when present', () => {
    const result = formatAnalysisRunContext({
      id: 'run-9',
      status: 'completed',
      summary: 'Found issues.',
      repo_instructions: 'Repo-level guidance here.',
      request_instructions: 'Request-level guidance here.'
    });

    expect(result).toContain('### Analysis Summary');
    expect(result).toContain('### Repository Instructions');
    expect(result).toContain('Repo-level guidance here.');
    expect(result).toContain('### Custom Instructions (this run)');
    expect(result).toContain('Request-level guidance here.');

    // Verify order: summary before repo_instructions before request_instructions
    const summaryIdx = result.indexOf('### Analysis Summary');
    const repoIdx = result.indexOf('### Repository Instructions');
    const requestIdx = result.indexOf('### Custom Instructions (this run)');
    expect(summaryIdx).toBeLessThan(repoIdx);
    expect(repoIdx).toBeLessThan(requestIdx);
  });
});
