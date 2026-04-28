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

    it('mentions the 140-character rule', () => {
      expect(result).toContain('140');
    });

    it('includes the safety language about not modifying files', () => {
      expect(result).toContain('Do NOT modify files');
    });

    it('includes the safety language about not running write commands', () => {
      expect(result).toContain('Do NOT run write commands');
    });

    it('omits Review context block when no PR fields supplied', () => {
      expect(result).not.toContain('Review context:');
    });

    it('omits Changed files block when no list supplied', () => {
      expect(result).not.toContain('Changed files in this review');
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
      expect(result).toContain('Review context:');
      expect(result).toContain('Title: Fix the bar');
      expect(result).toContain('Description: This patch addresses the bar regression.');
    });

    it('includes only title when description missing', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        prTitle: 'Solo title'
      });
      expect(result).toContain('Review context:');
      expect(result).toContain('Title: Solo title');
      expect(result).not.toContain('Description:');
    });

    it('includes only description when title missing', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        prDescription: 'Solo desc'
      });
      expect(result).toContain('Review context:');
      expect(result).toContain('Description: Solo desc');
      expect(result).not.toContain('Title:');
    });

    it('omits Review context block when title and description are missing', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk]
      });
      expect(result).not.toContain('Review context:');
    });

    it('treats whitespace-only PR title as empty', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        prTitle: '   \n\t  '
      });
      expect(result).not.toContain('Review context:');
    });

    it('treats whitespace-only description as empty', () => {
      const result = buildHunkSummaryPrompt({
        filePath: 'src/foo.ts',
        hunks: [sampleHunk],
        prDescription: '   '
      });
      expect(result).not.toContain('Review context:');
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
