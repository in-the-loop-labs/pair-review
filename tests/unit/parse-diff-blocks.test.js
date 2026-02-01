// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';

/**
 * Unit tests for HunkParser.parseDiffIntoBlocks
 * Regression tests for the duplicate-lines-in-new-files bug where a trailing
 * empty string from split('\n') was misclassified as a context line, causing
 * coordinate corruption and duplicate content display.
 */

const { HunkParser } = require('../../public/js/modules/hunk-parser.js');

describe('HunkParser.parseDiffIntoBlocks', () => {
  describe('new file (regression: duplicate lines bug)', () => {
    it('should parse new file hunk with no phantom context lines', () => {
      // This is the exact pattern that caused the bug: @@ -0,0 +1,N @@
      // with trailing newline producing an empty string from split('\n')
      const patch = '@@ -0,0 +1,3 @@\n+line1\n+line2\n+line3\n';
      const blocks = HunkParser.parseDiffIntoBlocks(patch);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].oldStart).toBe(0);
      expect(blocks[0].newStart).toBe(1);
      expect(blocks[0].lines).toEqual(['+line1', '+line2', '+line3']);
      // The trailing '' from split('\n') must NOT appear as a phantom context line
      expect(blocks[0].lines).not.toContain('');
    });

    it('should parse new file with diff --git headers', () => {
      const patch = [
        'diff --git a/new-file.js b/new-file.js',
        'new file mode 100644',
        'index 0000000..abc1234',
        '--- /dev/null',
        '+++ b/new-file.js',
        '@@ -0,0 +1,2 @@',
        '+const x = 1;',
        '+module.exports = x;',
        '' // trailing newline artifact
      ].join('\n');

      const blocks = HunkParser.parseDiffIntoBlocks(patch);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].oldStart).toBe(0);
      expect(blocks[0].newStart).toBe(1);
      expect(blocks[0].lines).toEqual(['+const x = 1;', '+module.exports = x;']);
    });

    it('should have all-addition lines for new files (no old numbers)', () => {
      const patch = '@@ -0,0 +1,3 @@\n+a\n+b\n+c\n';
      const blocks = HunkParser.parseDiffIntoBlocks(patch);

      // Every line should start with '+' — no context lines
      for (const line of blocks[0].lines) {
        expect(line.startsWith('+')).toBe(true);
      }
    });
  });

  describe('modified file', () => {
    it('should parse a simple modification', () => {
      const patch = '@@ -1,3 +1,3 @@\n context\n-old line\n+new line\n context2\n';
      const blocks = HunkParser.parseDiffIntoBlocks(patch);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].oldStart).toBe(1);
      expect(blocks[0].newStart).toBe(1);
      expect(blocks[0].lines).toEqual([' context', '-old line', '+new line', ' context2']);
    });

    it('should parse multiple hunks', () => {
      const patch = [
        '@@ -1,3 +1,3 @@',
        ' context',
        '-old1',
        '+new1',
        '@@ -10,3 +10,3 @@',
        ' context2',
        '-old2',
        '+new2',
        '' // trailing newline
      ].join('\n');

      const blocks = HunkParser.parseDiffIntoBlocks(patch);

      expect(blocks).toHaveLength(2);
      expect(blocks[0].oldStart).toBe(1);
      expect(blocks[0].newStart).toBe(1);
      expect(blocks[0].lines).toEqual([' context', '-old1', '+new1']);
      expect(blocks[1].oldStart).toBe(10);
      expect(blocks[1].newStart).toBe(10);
      expect(blocks[1].lines).toEqual([' context2', '-old2', '+new2']);
    });

    it('should strip trailing empty string from intermediate blocks too', () => {
      // Contrived: if a non-standard diff had an empty line before a hunk header
      // Intermediate blocks should also get trailing empty stripped
      const patch = '@@ -1,2 +1,2 @@\n-a\n+b\n@@ -10,1 +10,1 @@\n-c\n';
      const blocks = HunkParser.parseDiffIntoBlocks(patch);

      expect(blocks).toHaveLength(2);
      expect(blocks[0].lines).toEqual(['-a', '+b']);
      expect(blocks[1].lines).toEqual(['-c']);
    });
  });

  describe('deleted file', () => {
    it('should parse a deleted file', () => {
      const patch = '@@ -1,3 +0,0 @@\n-line1\n-line2\n-line3\n';
      const blocks = HunkParser.parseDiffIntoBlocks(patch);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].oldStart).toBe(1);
      expect(blocks[0].newStart).toBe(0);
      expect(blocks[0].lines).toEqual(['-line1', '-line2', '-line3']);
    });
  });

  describe('edge cases', () => {
    it('should return empty array for empty string', () => {
      const blocks = HunkParser.parseDiffIntoBlocks('');
      expect(blocks).toEqual([]);
    });

    it('should return empty array for diff with no hunks', () => {
      const patch = 'diff --git a/file b/file\nindex abc..def\n';
      const blocks = HunkParser.parseDiffIntoBlocks(patch);
      expect(blocks).toEqual([]);
    });

    it('should handle patch without trailing newline', () => {
      const patch = '@@ -0,0 +1,2 @@\n+line1\n+line2';
      const blocks = HunkParser.parseDiffIntoBlocks(patch);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].lines).toEqual(['+line1', '+line2']);
    });

    it('should preserve legitimate empty context lines in the middle of a block', () => {
      // A space-prefixed empty line (' ') is valid diff context
      const patch = '@@ -1,3 +1,3 @@\n+line1\n \n+line3\n';
      const blocks = HunkParser.parseDiffIntoBlocks(patch);

      expect(blocks).toHaveLength(1);
      // The ' ' (space) context line must be preserved
      expect(blocks[0].lines).toEqual(['+line1', ' ', '+line3']);
    });

    it('should handle hunk header with function context', () => {
      const patch = '@@ -10,5 +10,7 @@ function myFunc() {\n+line1\n';
      const blocks = HunkParser.parseDiffIntoBlocks(patch);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].header).toBe('@@ -10,5 +10,7 @@ function myFunc() {');
      expect(blocks[0].oldStart).toBe(10);
      expect(blocks[0].newStart).toBe(10);
    });
  });
});

describe('HunkParser._stripTrailingEmpty', () => {
  it('should remove trailing empty string', () => {
    const block = { lines: ['+a', '+b', ''] };
    HunkParser._stripTrailingEmpty(block);
    expect(block.lines).toEqual(['+a', '+b']);
  });

  it('should not remove non-empty trailing string', () => {
    const block = { lines: ['+a', '+b'] };
    HunkParser._stripTrailingEmpty(block);
    expect(block.lines).toEqual(['+a', '+b']);
  });

  it('should not remove trailing space (valid context line)', () => {
    const block = { lines: ['+a', ' '] };
    HunkParser._stripTrailingEmpty(block);
    expect(block.lines).toEqual(['+a', ' ']);
  });

  it('should handle empty lines array', () => {
    const block = { lines: [] };
    HunkParser._stripTrailingEmpty(block);
    expect(block.lines).toEqual([]);
  });
});
