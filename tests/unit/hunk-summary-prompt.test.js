// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
const { buildHunkSummaryPrompt } = require('../../src/ai/prompts/hunk-summary.js');

describe('buildHunkSummaryPrompt', () => {
  const sampleHunk = {
    header: '@@ -10,5 +10,7 @@ function foo()',
    lines: [
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      ' return a + b;'
    ]
  };

  describe('required inputs', () => {
    it('throws TypeError when filePath is missing', () => {
      expect(() => buildHunkSummaryPrompt({ hunks: [sampleHunk] })).toThrow(TypeError);
      expect(() => buildHunkSummaryPrompt({ hunks: [sampleHunk] })).toThrow(/filePath/);
    });

    it('throws TypeError when filePath is empty string', () => {
      expect(() => buildHunkSummaryPrompt({ filePath: '', hunks: [sampleHunk] })).toThrow(TypeError);
    });

    it('throws TypeError when filePath is whitespace-only', () => {
      expect(() => buildHunkSummaryPrompt({ filePath: '   ', hunks: [sampleHunk] })).toThrow(
        TypeError
      );
    });

    it('throws TypeError when hunks is missing', () => {
      expect(() => buildHunkSummaryPrompt({ filePath: 'src/foo.ts' })).toThrow(TypeError);
      expect(() => buildHunkSummaryPrompt({ filePath: 'src/foo.ts' })).toThrow(/hunks/);
    });

    it('throws TypeError when hunks is null', () => {
      expect(() => buildHunkSummaryPrompt({ filePath: 'src/foo.ts', hunks: null })).toThrow(
        TypeError
      );
    });

    it('throws TypeError when no arguments provided', () => {
      expect(() => buildHunkSummaryPrompt()).toThrow(TypeError);
    });
  });

  describe('minimal valid call', () => {
    const result = buildHunkSummaryPrompt({
      filePath: 'src/foo.ts',
      hunks: [sampleHunk]
    });

    it('contains the file path label', () => {
      expect(result).toContain('File: src/foo.ts');
    });

    it('contains the numbered hunk header', () => {
      expect(result).toContain('[1] @@ -10,5 +10,7 @@ function foo()');
    });

    it('contains each diff body line verbatim', () => {
      for (const line of sampleHunk.lines) {
        expect(result).toContain(line);
      }
    });

    it('contains the JSON schema example', () => {
      expect(result).toContain('"summaries"');
      expect(result).toContain('"index"');
      expect(result).toContain('"summary"');
    });

    it('includes the new Style block', () => {
      expect(result).toContain('1–3 sentences');
      expect(result).toContain('~200 characters');
      expect(result).toContain('hard ceiling 400');
      expect(result).toContain('Lead with a verb');
    });

    it('does not include the retired 140-char or single-sentence rules', () => {
      expect(result).not.toContain('140');
      expect(result).not.toContain('Single sentence');
      expect(result).not.toContain('present-tense imperative');
    });

    it('includes the null-summary opt-out clause', () => {
      expect(result).toContain('summary: null');
      expect(result).toContain('Default is to summarize');
    });

    it('JSON example shows null as a valid summary value', () => {
      expect(result).toContain('"summary": null');
    });

    it('includes the safety language about not modifying files', () => {
      expect(result).toContain('Do NOT modify files');
    });

    it('uses the softer "primary source" framing in the preamble', () => {
      expect(result).toContain('Treat the diff text provided below as the primary source.');
      expect(result).not.toContain('Use only the diff text provided');
    });

    it('includes the safety language about not running write commands', () => {
      expect(result).toContain('Do NOT run write commands');
    });

    it('omits Author\'s stated intent block when no PR fields supplied', () => {
      expect(result).not.toContain("Author's stated intent");
    });

    it('omits the author-claims skepticism block when no PR fields supplied', () => {
      expect(result).not.toContain('is a HINT');
      expect(result).not.toContain('diff is ground truth');
    });

    it('omits Changed files block when no list supplied', () => {
      expect(result).not.toContain('Changed files in this review');
    });

    it('omits the FS-access invitation block when cwd is not provided', () => {
      expect(result).not.toContain('read-only access to the current working directory');
      expect(result).not.toContain('Budget per file');
    });
  });

  describe('multi-hunk numbering', () => {
    it('numbers each hunk sequentially with its header', () => {
      const hunks = [
        { header: '@@ -1,3 +1,3 @@ first', lines: [' a', '-b', '+B'] },
        { header: '@@ -10,2 +10,2 @@ second', lines: [' c', '+d'] },
        { header: '@@ -20,1 +20,1 @@ third', lines: ['-e', '+E'] }
      ];
      const result = buildHunkSummaryPrompt({ filePath: 'src/multi.ts', hunks });
      expect(result).toContain('[1] @@ -1,3 +1,3 @@ first');
      expect(result).toContain('[2] @@ -10,2 +10,2 @@ second');
      expect(result).toContain('[3] @@ -20,1 +20,1 @@ third');
    });
  });

  describe('PR context inclusion', () => {
    it('includes title and description when both provided', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        prTitle: 'Fix the bar',
        prDescription: 'This patch addresses the bar regression.'
      });
      expect(result).toContain("Author's stated intent (hint only — verify against the diff):");
      expect(result).toContain('Title: Fix the bar');
      expect(result).toContain('Description: This patch addresses the bar regression.');
    });

    it('includes only title when description missing', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        prTitle: 'Solo title'
      });
      expect(result).toContain("Author's stated intent (hint only — verify against the diff):");
      expect(result).toContain('Title: Solo title');
      expect(result).not.toContain('Description:');
    });

    it('includes only description when title missing', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        prDescription: 'Solo desc'
      });
      expect(result).toContain("Author's stated intent (hint only — verify against the diff):");
      expect(result).toContain('Description: Solo desc');
      expect(result).not.toContain('Title:');
    });

    it('omits Author\'s stated intent block when title and description are missing', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk]
      });
      expect(result).not.toContain("Author's stated intent");
    });

    it('treats whitespace-only PR title as empty', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        prTitle: '   \n\t  '
      });
      expect(result).not.toContain("Author's stated intent");
    });

    it('treats whitespace-only description as empty', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        prDescription: '   '
      });
      expect(result).not.toContain("Author's stated intent");
    });

    it('does not use the legacy "Review context:" label', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        prTitle: 'Fix the bar',
        prDescription: 'desc'
      });
      expect(result).not.toContain('Review context:');
    });
  });

  describe('author-claims skepticism block', () => {
    it('includes the skepticism block when title is provided', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        prTitle: 'Fix bar'
      });
      expect(result).toContain('is a HINT');
      expect(result).toContain('diff is ground truth');
      expect(result).toContain('Do NOT repeat or paraphrase the description');
      expect(result).toContain('If the diff and the description disagree');
    });

    it('includes the skepticism block when description is provided', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        prDescription: 'A description.'
      });
      expect(result).toContain('is a HINT');
      expect(result).toContain('diff is ground truth');
      expect(result).toContain('Do NOT repeat or paraphrase the description');
      expect(result).toContain('If the diff and the description disagree');
    });

    it('includes the skepticism block when both title and description are provided', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        prTitle: 'Fix bar',
        prDescription: 'A description.'
      });
      expect(result).toContain('is a HINT');
      expect(result).toContain('diff is ground truth');
      expect(result).toContain('Do NOT repeat or paraphrase the description');
      expect(result).toContain('If the diff and the description disagree');
    });

    it('omits the skepticism block when neither title nor description is provided', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk]
      });
      expect(result).not.toContain('is a HINT');
      expect(result).not.toContain('diff is ground truth');
    });

    it('omits the skepticism block when both title and description are whitespace-only', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        prTitle: '  ',
        prDescription: '   '
      });
      expect(result).not.toContain('is a HINT');
      expect(result).not.toContain('diff is ground truth');
    });
  });

  describe('FS-access invitation block', () => {
    it('includes the FS-access block when cwd is provided', () => {
      const cwd = '/tmp/foo';
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        cwd
      });
      expect(result).toContain('read-only access to the current working directory');
      expect(result).toContain('Budget per file: at most ~5 file reads');
      expect(result).toContain('describes what the DIFF changes, not what the');
      expect(result).toContain('surrounding code does');
      // The cwd path itself must NEVER be embedded — leaks usernames/customer
      // names/project names into the prompt.
      expect(result).not.toContain(cwd);
    });

    it('does not embed the literal cwd path in the prompt (privacy)', () => {
      const cwd = '/Users/me/projects/widget';
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        cwd
      });
      expect(result).toContain('read-only access to the current working directory');
      expect(result).not.toContain(cwd);
      expect(result).not.toContain('/Users/me');
      expect(result).not.toContain('<CWD>');
    });

    it('renders the FS-access block identically regardless of cwd value', () => {
      const a = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        cwd: '/tmp/foo'
      });
      const b = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        cwd: '/Users/someone-else/secret-customer/project'
      });
      expect(a).toBe(b);
    });

    it('includes the speculation guardrail final paragraph', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        cwd: '/tmp/foo'
      });
      expect(result).toContain('Context informs phrasing; it does not become');
      expect(result).toContain('the subject');
    });

    it('includes the redundant "Do not modify any file" instruction', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        cwd: '/tmp/foo'
      });
      expect(result).toContain('Do not modify any file.');
    });

    it('omits the FS-access block when cwd is undefined', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk]
      });
      expect(result).not.toContain('read-only access to the current working directory');
      expect(result).not.toContain('Budget per file');
    });

    it('omits the FS-access block when cwd is an empty string', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        cwd: ''
      });
      expect(result).not.toContain('read-only access to the current working directory');
      expect(result).not.toContain('Budget per file');
    });

    it('omits the FS-access block when cwd is whitespace-only', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        cwd: '   \t  '
      });
      expect(result).not.toContain('read-only access to the current working directory');
      expect(result).not.toContain('Budget per file');
    });

    it('omits the FS-access block when cwd is not a string', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        cwd: 12345
      });
      expect(result).not.toContain('read-only access to the current working directory');
      expect(result).not.toContain('Budget per file');
    });
  });

  describe('changed files list', () => {
    it('includes paths under a Changed files block when list is small', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        changedFiles: ['a.js', 'b.js']
      });
      expect(result).toContain('Changed files in this review:');
      expect(result).toContain('- a.js');
      expect(result).toContain('- b.js');
    });

    it('omits the block when changedFiles is an empty array', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        changedFiles: []
      });
      expect(result).not.toContain('Changed files in this review');
    });

    it('omits individual paths when list exceeds 100 entries', () => {
      const big = Array.from({ length: 150 }, (_, i) => `path/file-${i}.js`);
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        changedFiles: big
      });
      expect(result).toContain('150 total (list omitted for length)');
      expect(result).not.toContain('- path/file-0.js');
      expect(result).not.toContain('- path/file-149.js');
    });

    it('still lists paths when list is exactly 100 entries (boundary)', () => {
      const exact = Array.from({ length: 100 }, (_, i) => `f${i}.js`);
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        changedFiles: exact
      });
      expect(result).toContain('Changed files in this review:');
      expect(result).toContain('- f0.js');
      expect(result).toContain('- f99.js');
      expect(result).not.toContain('total (list omitted');
    });
  });

  describe('empty hunks array', () => {
    it('does not throw', () => {
      expect(() =>
        buildHunkSummaryPrompt({ filePath: 'src/foo.ts', hunks: [] })
      ).not.toThrow();
    });

    it('instructs the model to return an empty summaries array', () => {
      const result = buildHunkSummaryPrompt({ filePath: 'src/foo.ts', hunks: [] });
      expect(result).toContain('"summaries": []');
    });

    it('still includes the file path', () => {
      const result = buildHunkSummaryPrompt({ filePath: 'src/foo.ts', hunks: [] });
      expect(result).toContain('File: src/foo.ts');
    });
  });

  describe('hunk lines preserved verbatim', () => {
    it('preserves a body line beginning with ++ (no regex stripping)', () => {
      const hunk = {
        header: '@@ -1,2 +1,3 @@',
        lines: [' int x = 0;', '+++counter', ' return x;']
      };
      const result = buildHunkSummaryPrompt({
        filePath: 'src/weird.c',
        hunks: [hunk]
      });
      expect(result).toContain('+++counter');
    });

    it('preserves lines containing JSON-like punctuation', () => {
      const hunk = {
        header: '@@ -1,1 +1,1 @@',
        lines: ['+const x = { "a": 1 };']
      };
      const result = buildHunkSummaryPrompt({
        filePath: 'src/json.ts',
        hunks: [hunk]
      });
      expect(result).toContain('+const x = { "a": 1 };');
    });
  });
});
