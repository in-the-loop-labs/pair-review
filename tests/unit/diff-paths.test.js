// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

const {
  unquoteGitPath,
  stripDiffPrefix,
  parseDiffGitPaths,
  parseDiffSidePath
} = require('../../src/utils/diff-paths');
const { buildDiffLineSet } = require('../../src/utils/diff-annotator');
const { parseUnifiedDiffPatches } = require('../../src/utils/diff-file-list');

// A literal TAB, spelled out so the fixtures below cannot be silently
// reformatted by an editor that trims trailing whitespace.
const TAB = '\t';

/**
 * Captured byte-for-byte from real `git diff` output. The repository was built
 * with `mkdtemp`, the files created with the exact names below, and the diff
 * taken with the flags `src/git/diff-flags.js` uses:
 *
 *   git diff --cached --unified=3 --no-color --no-ext-diff \
 *     --src-prefix=a/ --dst-prefix=b/ --no-relative --full-index -M
 *
 * Every quoting shape git can emit is represented, and the last entry is the
 * one nobody predicts: git quotes each SIDE independently, so a rename can
 * pair an unquoted old name with a quoted new one on the same header line.
 */
const REAL_GIT_EXOTIC_DIFF = [
  String.raw`diff --git "a/back\\slash.txt" "b/back\\slash.txt"`,
  'index de980441c3ab03a8c07dda1ad27b8a11f39deb1e..7be73ce3c1b1cdaea86e8168dfee8575175953bf 100644',
  String.raw`--- "a/back\\slash.txt"`,
  String.raw`+++ "b/back\\slash.txt"`,
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  String.raw`diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"`,
  'index de980441c3ab03a8c07dda1ad27b8a11f39deb1e..7be73ce3c1b1cdaea86e8168dfee8575175953bf 100644',
  String.raw`--- "a/caf\303\251.txt"`,
  String.raw`+++ "b/caf\303\251.txt"`,
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  'diff --git a/my file.txt b/my file.txt',
  'index de980441c3ab03a8c07dda1ad27b8a11f39deb1e..7be73ce3c1b1cdaea86e8168dfee8575175953bf 100644',
  // Git appends a bare TAB to a name containing a space, for patch(1).
  `--- a/my file.txt${TAB}`,
  `+++ b/my file.txt${TAB}`,
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  // Rename with an unquoted old side and a quoted new side, on one header.
  String.raw`diff --git a/old space.txt "b/n\303\274w space.txt"`,
  'similarity index 100%',
  'rename from old space.txt',
  String.raw`rename to "n\303\274w space.txt"`,
  String.raw`diff --git "a/quo\"te.txt" "b/quo\"te.txt"`,
  'index de980441c3ab03a8c07dda1ad27b8a11f39deb1e..7be73ce3c1b1cdaea86e8168dfee8575175953bf 100644',
  String.raw`--- "a/quo\"te.txt"`,
  String.raw`+++ "b/quo\"te.txt"`,
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  String.raw`diff --git "a/tab\tname.txt" "b/tab\tname.txt"`,
  'index de980441c3ab03a8c07dda1ad27b8a11f39deb1e..7be73ce3c1b1cdaea86e8168dfee8575175953bf 100644',
  String.raw`--- "a/tab\tname.txt"`,
  String.raw`+++ "b/tab\tname.txt"`,
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  ''
].join('\n');

// The real on-disk names the fixture above describes, in the order git emits
// them. These are what every layer of the app — UI, database, GitHub API —
// carries, so these are the only acceptable answers from either parser.
const REAL_PATHS = [
  'back\\slash.txt',
  'café.txt',
  'my file.txt',
  'nüw space.txt',
  'quo"te.txt',
  'tab\tname.txt'
];

describe('diff-paths', () => {
  describe('unquoteGitPath', () => {
    it('returns an unquoted token untouched', () => {
      expect(unquoteGitPath('src/foo.js')).toBe('src/foo.js');
      expect(unquoteGitPath('my file.txt')).toBe('my file.txt');
    });

    it('decodes octal escapes as UTF-8 BYTES, not characters', () => {
      // \303\251 is the two-byte UTF-8 encoding of "é". Decoding per-character
      // would yield "Ã©" — the classic mojibake this test exists to prevent.
      expect(unquoteGitPath(String.raw`"caf\303\251.txt"`)).toBe('café.txt');
      expect(unquoteGitPath(String.raw`"n\303\274w space.txt"`)).toBe('nüw space.txt');
    });

    it('decodes C escapes for tab, quote and backslash', () => {
      expect(unquoteGitPath(String.raw`"tab\tname.txt"`)).toBe('tab\tname.txt');
      expect(unquoteGitPath(String.raw`"quo\"te.txt"`)).toBe('quo"te.txt');
      expect(unquoteGitPath(String.raw`"back\\slash.txt"`)).toBe('back\\slash.txt');
      expect(unquoteGitPath(String.raw`"new\nline.txt"`)).toBe('new\nline.txt');
    });

    it('stops an octal escape at three digits', () => {
      // "\1011" is byte 0o101 ('A') followed by a literal '1', not 0o1011.
      expect(unquoteGitPath(String.raw`"\1011.txt"`)).toBe('A1.txt');
    });

    it('leaves an unknown escape as the escaped character', () => {
      expect(unquoteGitPath(String.raw`"we\ird.txt"`)).toBe('weird.txt');
    });

    it('returns empty string for non-string input', () => {
      expect(unquoteGitPath(null)).toBe('');
      expect(unquoteGitPath(undefined)).toBe('');
      expect(unquoteGitPath(42)).toBe('');
    });

    it('does not treat a lone leading quote as a quoted token', () => {
      expect(unquoteGitPath('"unterminated.txt')).toBe('"unterminated.txt');
    });
  });

  describe('stripDiffPrefix', () => {
    it('strips only the prefix belonging to the side', () => {
      expect(stripDiffPrefix('a/src/foo.js', 'a')).toBe('src/foo.js');
      expect(stripDiffPrefix('b/src/foo.js', 'b')).toBe('src/foo.js');
      expect(stripDiffPrefix('b/src/foo.js', 'a')).toBe('b/src/foo.js');
    });

    it('strips the prefix exactly once, so a real "b/" directory survives', () => {
      expect(stripDiffPrefix('a/b/thing.txt', 'a')).toBe('b/thing.txt');
    });
  });

  describe('parseDiffGitPaths', () => {
    it('parses a plain header', () => {
      expect(parseDiffGitPaths('diff --git a/src/foo.js b/src/foo.js'))
        .toEqual({ oldPath: 'src/foo.js', newPath: 'src/foo.js' });
    });

    it('parses a plain rename header', () => {
      expect(parseDiffGitPaths('diff --git a/old.js b/new.js'))
        .toEqual({ oldPath: 'old.js', newPath: 'new.js' });
    });

    it('splits an ambiguous space-containing header at the symmetric point', () => {
      expect(parseDiffGitPaths('diff --git a/my file.txt b/my file.txt'))
        .toEqual({ oldPath: 'my file.txt', newPath: 'my file.txt' });
    });

    it('prefers the split that yields identical names over the first one', () => {
      // A file genuinely named `x b/y.txt`: the FIRST " b/" is a red herring,
      // and only the "both names are the same" rule finds the real split.
      expect(parseDiffGitPaths('diff --git a/x b/y.txt b/x b/y.txt'))
        .toEqual({ oldPath: 'x b/y.txt', newPath: 'x b/y.txt' });
    });

    it('parses a header where BOTH sides are quoted', () => {
      expect(parseDiffGitPaths(String.raw`diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"`))
        .toEqual({ oldPath: 'café.txt', newPath: 'café.txt' });
    });

    it('parses a header where only the NEW side is quoted', () => {
      expect(parseDiffGitPaths(String.raw`diff --git a/old space.txt "b/n\303\274w space.txt"`))
        .toEqual({ oldPath: 'old space.txt', newPath: 'nüw space.txt' });
    });

    it('parses a header where only the OLD side is quoted', () => {
      expect(parseDiffGitPaths(String.raw`diff --git "a/caf\303\251.txt" b/plain.txt`))
        .toEqual({ oldPath: 'café.txt', newPath: 'plain.txt' });
    });

    it('returns null for anything that is not a parseable header', () => {
      expect(parseDiffGitPaths('index abc..def 100644')).toBeNull();
      expect(parseDiffGitPaths('diff --git')).toBeNull();
      expect(parseDiffGitPaths('diff --git a/only-one-side.js')).toBeNull();
      // --no-prefix output: no a//b/ prefixes to key off, so the caller falls
      // back to the ---/+++ headers rather than guessing.
      expect(parseDiffGitPaths('diff --git foo.js foo.js')).toBeNull();
      expect(parseDiffGitPaths(String.raw`diff --git "a/unterminated.txt`)).toBeNull();
      expect(parseDiffGitPaths(null)).toBeNull();
    });
  });

  describe('parseDiffSidePath', () => {
    it('parses plain old/new side headers', () => {
      expect(parseDiffSidePath('--- a/src/foo.js', 'a')).toBe('src/foo.js');
      expect(parseDiffSidePath('+++ b/src/foo.js', 'b')).toBe('src/foo.js');
    });

    it('drops the bare TAB git appends to a name containing a space', () => {
      expect(parseDiffSidePath(`--- a/my file.txt${TAB}`, 'a')).toBe('my file.txt');
      expect(parseDiffSidePath(`+++ b/my file.txt${TAB}`, 'b')).toBe('my file.txt');
    });

    it('drops a TAB + timestamp suffix from non-git diff producers', () => {
      expect(parseDiffSidePath(`--- a/foo.js${TAB}2026-08-23 10:11:12.000000000 +0000`, 'a'))
        .toBe('foo.js');
    });

    it('decodes a quoted name and ignores anything after the closing quote', () => {
      expect(parseDiffSidePath(String.raw`--- "a/caf\303\251.txt"`, 'a')).toBe('café.txt');
      expect(parseDiffSidePath(String.raw`+++ "b/tab\tname.txt"`, 'b')).toBe('tab\tname.txt');
      expect(parseDiffSidePath(`+++ "b/plain.txt"${TAB}2026-08-23`, 'b')).toBe('plain.txt');
    });

    it('returns null for /dev/null so an add/delete keeps the other side', () => {
      expect(parseDiffSidePath('--- /dev/null', 'a')).toBeNull();
      expect(parseDiffSidePath('+++ /dev/null', 'b')).toBeNull();
    });

    it('returns null for a marker with nothing after it', () => {
      expect(parseDiffSidePath('---', 'a')).toBeNull();
      expect(parseDiffSidePath('--- ', 'a')).toBeNull();
      expect(parseDiffSidePath('+++', 'b')).toBeNull();
    });

    it('strips the side prefix exactly once', () => {
      expect(parseDiffSidePath('--- a/b/thing.txt', 'a')).toBe('b/thing.txt');
    });
  });

  describe('every diff parser agrees byte for byte', () => {
    // The failure this guards is not cosmetic. `parseUnifiedDiffPatches` keys
    // the patch the UI renders; `buildDiffLineSet().hasFile` decides whether a
    // comment on that file is allowed at all. When they disagree by one byte,
    // local mode's `refuseCommentsOutsideDiff` 409s the WHOLE submission over
    // a file the user is looking at.
    it('parseUnifiedDiffPatches keys the real on-disk paths', () => {
      const keys = [...parseUnifiedDiffPatches(REAL_GIT_EXOTIC_DIFF).keys()];
      expect(keys).toEqual(REAL_PATHS);
    });

    it('hasFile answers true for exactly those same paths', () => {
      const { hasFile } = buildDiffLineSet(REAL_GIT_EXOTIC_DIFF);
      for (const filePath of REAL_PATHS) {
        expect(hasFile(filePath)).toBe(true);
      }
    });

    it('neither parser leaks a raw, undecoded representation', () => {
      const { hasFile } = buildDiffLineSet(REAL_GIT_EXOTIC_DIFF);
      const patchKeys = new Set(parseUnifiedDiffPatches(REAL_GIT_EXOTIC_DIFF).keys());
      const rawForms = [
        `my file.txt${TAB}`,                       // TAB terminator kept
        String.raw`"b/caf\303\251.txt"`,           // quotes + prefix kept
        String.raw`caf\303\251.txt`,               // octal escapes kept
        String.raw`"b/tab\tname.txt"`,
        String.raw`b/quo\"te.txt`
      ];
      for (const raw of rawForms) {
        expect(hasFile(raw)).toBe(false);
        expect(patchKeys.has(raw)).toBe(false);
      }
    });

    it('resolves hunk lines under the decoded path', () => {
      const { isLineInDiff } = buildDiffLineSet(REAL_GIT_EXOTIC_DIFF);
      // Each hunk is ` a` / `-b` / `+B` / ` c` starting at line 1.
      expect(isLineInDiff('café.txt', 2, 'RIGHT')).toBe(true);
      expect(isLineInDiff('café.txt', 2, 'LEFT')).toBe(true);
      expect(isLineInDiff('my file.txt', 3, 'RIGHT')).toBe(true);
      expect(isLineInDiff('quo"te.txt', 1, 'RIGHT')).toBe(true);
      expect(isLineInDiff('tab\tname.txt', 3, 'LEFT')).toBe(true);
      expect(isLineInDiff('back\\slash.txt', 4, 'RIGHT')).toBe(false);
    });

    it('keeps the 100%-similarity rename in hasFile under its new name only', () => {
      const { hasFile } = buildDiffLineSet(REAL_GIT_EXOTIC_DIFF);
      expect(hasFile('nüw space.txt')).toBe(true);
      expect(hasFile('old space.txt')).toBe(false);
    });

    it('ordinary ASCII paths are completely unaffected', () => {
      const plain = [
        'diff --git a/src/foo.js b/src/foo.js',
        'index abc1234..def5678 100644',
        '--- a/src/foo.js',
        '+++ b/src/foo.js',
        '@@ -1,2 +1,3 @@',
        ' one',
        '+two',
        ' three',
        ''
      ].join('\n');
      expect([...parseUnifiedDiffPatches(plain).keys()]).toEqual(['src/foo.js']);
      expect(buildDiffLineSet(plain).hasFile('src/foo.js')).toBe(true);
    });
  });
});
