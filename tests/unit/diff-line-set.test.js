// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

const { buildDiffLineSet } = require('../../src/utils/diff-annotator');

describe('buildDiffLineSet', () => {
  const simpleDiff = [
    'diff --git a/file.js b/file.js',
    '--- a/file.js',
    '+++ b/file.js',
    '@@ -1,3 +1,4 @@',
    '+// New line',
    ' line1',
    ' line2',
    ' line3'
  ].join('\n');

  it('should detect added lines on the RIGHT side', () => {
    const { isLineInDiff } = buildDiffLineSet(simpleDiff);
    // +// New line is RIGHT:1
    expect(isLineInDiff('file.js', 1, 'RIGHT')).toBe(true);
  });

  it('should detect context lines on both sides', () => {
    const { isLineInDiff } = buildDiffLineSet(simpleDiff);
    // Context lines: line1 = LEFT:1 RIGHT:2, line2 = LEFT:2 RIGHT:3, line3 = LEFT:3 RIGHT:4
    expect(isLineInDiff('file.js', 1, 'LEFT')).toBe(true);
    expect(isLineInDiff('file.js', 2, 'RIGHT')).toBe(true);
    expect(isLineInDiff('file.js', 2, 'LEFT')).toBe(true);
    expect(isLineInDiff('file.js', 3, 'RIGHT')).toBe(true);
    expect(isLineInDiff('file.js', 3, 'LEFT')).toBe(true);
    expect(isLineInDiff('file.js', 4, 'RIGHT')).toBe(true);
  });

  it('should reject lines outside diff hunks', () => {
    const { isLineInDiff } = buildDiffLineSet(simpleDiff);
    expect(isLineInDiff('file.js', 42, 'RIGHT')).toBe(false);
    expect(isLineInDiff('file.js', 100, 'LEFT')).toBe(false);
  });

  it('should reject unknown files', () => {
    const { isLineInDiff } = buildDiffLineSet(simpleDiff);
    expect(isLineInDiff('other.js', 1, 'RIGHT')).toBe(false);
  });

  it('should default side to RIGHT', () => {
    const { isLineInDiff } = buildDiffLineSet(simpleDiff);
    expect(isLineInDiff('file.js', 2)).toBe(true);
    expect(isLineInDiff('file.js', 42)).toBe(false);
  });

  it('should detect deleted lines on the LEFT side', () => {
    const diff = [
      'diff --git a/file.js b/file.js',
      '--- a/file.js',
      '+++ b/file.js',
      '@@ -1,4 +1,3 @@',
      '-// Removed line',
      ' line1',
      ' line2',
      ' line3'
    ].join('\n');

    const { isLineInDiff } = buildDiffLineSet(diff);
    // Deleted: LEFT:1
    expect(isLineInDiff('file.js', 1, 'LEFT')).toBe(true);
    // Deleted lines should NOT appear on RIGHT
    expect(isLineInDiff('file.js', 1, 'RIGHT')).toBe(true); // line1 context is RIGHT:1
  });

  it('should handle multiple files', () => {
    const diff = [
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1,2 +1,3 @@',
      '+new',
      ' existing1',
      ' existing2',
      'diff --git a/b.js b/b.js',
      '--- a/b.js',
      '+++ b/b.js',
      '@@ -5,2 +5,3 @@',
      ' ctx',
      '+added',
      ' ctx2'
    ].join('\n');

    const { isLineInDiff } = buildDiffLineSet(diff);
    expect(isLineInDiff('a.js', 1, 'RIGHT')).toBe(true);
    expect(isLineInDiff('b.js', 6, 'RIGHT')).toBe(true);
    expect(isLineInDiff('a.js', 6, 'RIGHT')).toBe(false);
    expect(isLineInDiff('b.js', 1, 'RIGHT')).toBe(false);
  });

  it('should handle multiple hunks in one file', () => {
    const diff = [
      'diff --git a/file.js b/file.js',
      '--- a/file.js',
      '+++ b/file.js',
      '@@ -1,3 +1,4 @@',
      '+first',
      ' a',
      ' b',
      ' c',
      '@@ -50,3 +51,4 @@',
      ' x',
      '+second',
      ' y',
      ' z'
    ].join('\n');

    const { isLineInDiff } = buildDiffLineSet(diff);
    // First hunk
    expect(isLineInDiff('file.js', 1, 'RIGHT')).toBe(true);
    // Second hunk: x=RIGHT:51, +second=RIGHT:52, y=RIGHT:53, z=RIGHT:54
    expect(isLineInDiff('file.js', 52, 'RIGHT')).toBe(true);
    // Gap between hunks
    expect(isLineInDiff('file.js', 20, 'RIGHT')).toBe(false);
  });

  it('should return false for everything given empty diff', () => {
    const { isLineInDiff } = buildDiffLineSet('');
    expect(isLineInDiff('file.js', 1, 'RIGHT')).toBe(false);
  });

  it('should return false for everything given null diff', () => {
    const { isLineInDiff } = buildDiffLineSet(null);
    expect(isLineInDiff('file.js', 1, 'RIGHT')).toBe(false);
  });

  it('should not add phantom entries when rawDiff ends with a trailing newline', () => {
    // Real `git diff` output ends with \n, which causes split('\n') to produce
    // a trailing empty string. Without trimming, the empty string matches the
    // context-line branch and registers a phantom line beyond the hunk boundary.
    const diff = [
      'diff --git a/file.js b/file.js',
      '--- a/file.js',
      '+++ b/file.js',
      '@@ -1,3 +1,4 @@',
      '+// New line',
      ' line1',
      ' line2',
      ' line3',
      '' // trailing empty string from split('\n') on newline-terminated diff
    ].join('\n');

    const { isLineInDiff } = buildDiffLineSet(diff);
    // Valid lines should still be detected
    expect(isLineInDiff('file.js', 1, 'RIGHT')).toBe(true);  // +// New line
    expect(isLineInDiff('file.js', 4, 'RIGHT')).toBe(true);  // line3 context
    // Line beyond the hunk must NOT be present (the phantom entry bug)
    expect(isLineInDiff('file.js', 5, 'RIGHT')).toBe(false);
    expect(isLineInDiff('file.js', 4, 'LEFT')).toBe(false);  // only 3 old lines
  });

  it('should handle renames correctly using new path', () => {
    const diff = [
      'diff --git a/old.js b/new.js',
      'similarity index 90%',
      'rename from old.js',
      'rename to new.js',
      '--- a/old.js',
      '+++ b/new.js',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-old',
      '+new',
      ' line3'
    ].join('\n');

    const { isLineInDiff } = buildDiffLineSet(diff);
    // newPath is "new.js"
    expect(isLineInDiff('new.js', 1, 'RIGHT')).toBe(true);
    expect(isLineInDiff('new.js', 2, 'RIGHT')).toBe(true);
    expect(isLineInDiff('new.js', 3, 'RIGHT')).toBe(true);
  });

  describe('hunkOf', () => {
    const twoFileDiff = [
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1,3 +1,4 @@',
      '+first',
      ' a',
      ' b',
      ' c',
      '@@ -50,3 +51,3 @@',
      ' x',
      '-old',
      '+new',
      ' z',
      'diff --git a/b.js b/b.js',
      '--- a/b.js',
      '+++ b/b.js',
      '@@ -1,2 +1,2 @@',
      '-one',
      '+ONE',
      ' two',
      ''
    ].join('\n');

    it('gives lines in the same hunk the same index, on each side', () => {
      const { hunkOf } = buildDiffLineSet(twoFileDiff);
      expect(hunkOf('a.js', 1, 'RIGHT')).toBe(hunkOf('a.js', 4, 'RIGHT'));
      expect(hunkOf('a.js', 1, 'LEFT')).toBe(hunkOf('a.js', 3, 'LEFT'));
      expect(hunkOf('a.js', 51, 'LEFT')).toBe(hunkOf('a.js', 52, 'LEFT'));
    });

    it('gives different hunks different indexes, across files too', () => {
      const { hunkOf } = buildDiffLineSet(twoFileDiff);
      const first = hunkOf('a.js', 1, 'RIGHT');
      const second = hunkOf('a.js', 52, 'RIGHT');
      const third = hunkOf('b.js', 1, 'RIGHT');
      expect(new Set([first, second, third]).size).toBe(3);
    });

    it('returns null for a line outside every hunk, a missing side, or an unknown file', () => {
      const { hunkOf } = buildDiffLineSet(twoFileDiff);
      expect(hunkOf('a.js', 20, 'RIGHT')).toBeNull();
      // Old line 53 is past the end of the second hunk's 3 old lines
      expect(hunkOf('a.js', 53, 'LEFT')).toBeNull();
      expect(hunkOf('c.js', 1, 'RIGHT')).toBeNull();
    });

    it('defaults side to RIGHT', () => {
      const { hunkOf } = buildDiffLineSet(twoFileDiff);
      expect(hunkOf('a.js', 52)).toBe(hunkOf('a.js', 52, 'RIGHT'));
      expect(hunkOf('a.js', 52)).not.toBeNull();
    });

    it('returns null for an empty or missing diff', () => {
      expect(buildDiffLineSet('').hunkOf('a.js', 1, 'RIGHT')).toBeNull();
      expect(buildDiffLineSet(null).hunkOf('a.js', 1, 'RIGHT')).toBeNull();
    });
  });
});
