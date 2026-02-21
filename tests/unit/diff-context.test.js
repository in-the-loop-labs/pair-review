// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('DiffContext', () => {
  let DiffContext;

  beforeAll(() => {
    const code = fs.readFileSync(
      path.join(__dirname, '../../public/js/modules/diff-context.js'),
      'utf-8'
    );
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    DiffContext = sandbox.window.DiffContext;
  });

  // ---------------------------------------------------------------------------
  // Sample patch used across most tests
  // ---------------------------------------------------------------------------
  // Hunk 1: old 10,7 => new 10,8  → new-side lines 10..17
  // Hunk 2: old 30,4 => new 31,6  → new-side lines 31..36
  const SAMPLE_PATCH = [
    '@@ -10,7 +10,8 @@ function greet(name) {',
    '   const greeting = \'hello\';',
    '-  console.log(greeting);',
    '+  console.log(greeting, name);',
    '+  return greeting;',
    '   // end',
    ' }',
    ' ',
    '@@ -30,4 +31,6 @@ function farewell() {',
    '   const msg = \'bye\';',
    '+  console.log(msg);',
    '+  return msg;',
    ' }',
  ].join('\n');

  // ---------------------------------------------------------------------------
  // extractHunkForLines
  // ---------------------------------------------------------------------------
  describe('extractHunkForLines', () => {
    it('returns matching hunk for a line within the first hunk', () => {
      const result = DiffContext.extractHunkForLines(SAMPLE_PATCH, 11, 11);
      expect(result).not.toBeNull();
      expect(result).toContain('@@ -10,7 +10,8 @@');
      expect(result).toContain('console.log(greeting, name)');
      // Should NOT contain the second hunk
      expect(result).not.toContain('farewell');
    });

    it('returns matching hunk for a line within the second hunk', () => {
      const result = DiffContext.extractHunkForLines(SAMPLE_PATCH, 33, 33);
      expect(result).not.toBeNull();
      expect(result).toContain('@@ -30,4 +31,6 @@');
      expect(result).toContain('console.log(msg)');
      // Should NOT contain the first hunk
      expect(result).not.toContain('greet');
    });

    it('returns null when line is not in any hunk', () => {
      // Line 20 falls in the gap between hunk 1 (10-17) and hunk 2 (31-36)
      const result = DiffContext.extractHunkForLines(SAMPLE_PATCH, 20, 20);
      expect(result).toBeNull();
    });

    it('returns null for null patchText', () => {
      expect(DiffContext.extractHunkForLines(null, 10, 10)).toBeNull();
    });

    it('returns null for undefined patchText', () => {
      expect(DiffContext.extractHunkForLines(undefined, 10, 10)).toBeNull();
    });

    it('returns null for empty string patchText', () => {
      expect(DiffContext.extractHunkForLines('', 10, 10)).toBeNull();
    });

    it('returns multiple hunks when range spans both', () => {
      const result = DiffContext.extractHunkForLines(SAMPLE_PATCH, 10, 35);
      expect(result).not.toBeNull();
      // Should contain both hunk headers
      expect(result).toContain('@@ -10,7 +10,8 @@');
      expect(result).toContain('@@ -30,4 +31,6 @@');
      // Content from both hunks
      expect(result).toContain('greeting');
      expect(result).toContain('msg');
    });

    it('matches old line numbers when side is LEFT', () => {
      // First hunk old range: 10..16 (oldStart=10, oldCount=7)
      // Line 11 on the old side should match the first hunk
      const result = DiffContext.extractHunkForLines(SAMPLE_PATCH, 11, 11, 'LEFT');
      expect(result).not.toBeNull();
      expect(result).toContain('@@ -10,7 +10,8 @@');
    });

    it('truncates large hunks around referenced lines', () => {
      // Build a hunk with >100 content lines so truncation kicks in
      const contentLines = [];
      for (let i = 0; i < 150; i++) {
        contentLines.push(` line number ${i}`);
      }
      // newStart=1, newCount=150 → new-side lines 1..150
      const largePatch = `@@ -1,150 +1,150 @@ function big() {\n${contentLines.join('\n')}`;
      // Reference line 75 (somewhere in the middle)
      const result = DiffContext.extractHunkForLines(largePatch, 75, 75);
      expect(result).not.toBeNull();
      expect(result).toContain('// ... (truncated)');
      // The result should be shorter than the full patch
      const resultLineCount = result.split('\n').length;
      const fullLineCount = largePatch.split('\n').length;
      expect(resultLineCount).toBeLessThan(fullLineCount);
    });

    it('handles hunk with count=1 (missing comma group)', () => {
      // @@ -5 +5 @@ means oldStart=5 oldCount=1, newStart=5 newCount=1
      const patch = '@@ -5 +5 @@\n-old line\n+new line';
      const result = DiffContext.extractHunkForLines(patch, 5, 5);
      expect(result).not.toBeNull();
      expect(result).toContain('@@ -5 +5 @@');
      expect(result).toContain('new line');
    });
  });

  // ---------------------------------------------------------------------------
  // extractHunkRangesForFile
  // ---------------------------------------------------------------------------
  describe('extractHunkRangesForFile', () => {
    it('returns ranges for all hunks', () => {
      const ranges = DiffContext.extractHunkRangesForFile(SAMPLE_PATCH);
      expect(ranges).toEqual([
        { start: 10, end: 17 },
        { start: 31, end: 36 },
      ]);
    });

    it('returns empty array for null input', () => {
      expect(DiffContext.extractHunkRangesForFile(null)).toEqual([]);
    });

    it('returns empty array for patch with no hunk headers', () => {
      const noHunks = 'just some random text\nno hunk headers here';
      expect(DiffContext.extractHunkRangesForFile(noHunks)).toEqual([]);
    });

    it('handles hunk with default count of 1', () => {
      const patch = '@@ -5 +5 @@\n-old\n+new';
      const ranges = DiffContext.extractHunkRangesForFile(patch);
      expect(ranges).toEqual([{ start: 5, end: 5 }]);
    });
  });
});
