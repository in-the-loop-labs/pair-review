// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

const { buildDiffLineSet, buildReviewComments } = require('../../src/utils/diff-annotator');

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

  describe('hunk bodies that look like file headers', () => {
    // Captured verbatim from real `git diff` output over a two-file change.
    // notes.md deletes the line `-- deleted marker` (emitted as `--- deleted
    // marker`), adds `++ added marker` (emitted as `+++ added marker`) and adds
    // an unindented `++i;` (emitted as `+++i;`).
    //
    // Before the `!inHunk` guard, `parseFileHeader` claimed all three:
    //   - `--- deleted marker` overwrote oldPath with "deleted marker"
    //   - `+++ added marker` overwrote newPath with "added marker", so every
    //     later line in the section was keyed under that fragment of source
    //   - `+++i;` matched no regex but was still swallowed, so `newLineNum`
    //     never advanced and every later RIGHT anchor in the file was off by
    //     one: a comment on real line 5 read as outside the diff, a comment on
    //     line 4 read as INSIDE it and would have posted against the wrong line
    const bodyLooksLikeHeaderDiff = [
      'diff --git a/counter.c b/counter.c',
      'index 62712c21d6cb3ba0374f8ad58af432e315f70038..698cbc1dc48558b5c86a520dac3409f4e07a3568 100644',
      '--- a/counter.c',
      '+++ b/counter.c',
      '@@ -1,3 +1,4 @@',
      ' int x;',
      ' int y;',
      ' int z;',
      '+int w;',
      'diff --git a/notes.md b/notes.md',
      'index c332251ce08631f085ed4b4552e8b906ccff3fb1..ab9c79d312d0e50e0e15be7e62344cbf4112def1 100644',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,4 +1,5 @@',
      ' line one',
      '--- deleted marker',
      '+++ added marker',
      ' line three',
      '+++i;',
      ' line four',
      ''
    ].join('\n');

    it('keeps LEFT/RIGHT numbering unshifted across the disguised lines', () => {
      const { isLineInDiff } = buildDiffLineSet(bodyLooksLikeHeaderDiff);
      // RIGHT: 1 line one, 2 ++ added marker, 3 line three, 4 ++i;, 5 line four
      expect(isLineInDiff('notes.md', 1, 'RIGHT')).toBe(true);
      expect(isLineInDiff('notes.md', 2, 'RIGHT')).toBe(true);
      expect(isLineInDiff('notes.md', 3, 'RIGHT')).toBe(true);
      expect(isLineInDiff('notes.md', 4, 'RIGHT')).toBe(true);
      expect(isLineInDiff('notes.md', 5, 'RIGHT')).toBe(true);
      expect(isLineInDiff('notes.md', 6, 'RIGHT')).toBe(false);
      // LEFT: 1 line one, 2 -- deleted marker, 3 line three, 4 line four
      expect(isLineInDiff('notes.md', 2, 'LEFT')).toBe(true);
      expect(isLineInDiff('notes.md', 4, 'LEFT')).toBe(true);
      expect(isLineInDiff('notes.md', 5, 'LEFT')).toBe(false);
    });

    it('does not attribute the disguised lines to a bogus path', () => {
      const { isLineInDiff } = buildDiffLineSet(bodyLooksLikeHeaderDiff);
      expect(isLineInDiff('added marker', 3, 'RIGHT')).toBe(false);
      expect(isLineInDiff('deleted marker', 3, 'LEFT')).toBe(false);
    });

    it('advances RIGHT numbering past an unindented `++i;`', () => {
      // The quiet variant: `+++i;` matches no header regex, so the path
      // survives — but the line was still swallowed and everything after it
      // shifted by one. Isolated here so the regression is unmissable.
      const diff = [
        'diff --git a/counter.c b/counter.c',
        '--- a/counter.c',
        '+++ b/counter.c',
        '@@ -1,2 +1,3 @@',
        ' int i = 0;',
        '+++i;',
        ' return i;',
        ''
      ].join('\n');
      const { isLineInDiff } = buildDiffLineSet(diff);
      expect(isLineInDiff('counter.c', 2, 'RIGHT')).toBe(true); // the ++i; line
      expect(isLineInDiff('counter.c', 3, 'RIGHT')).toBe(true); // return i;
      expect(isLineInDiff('counter.c', 3, 'LEFT')).toBe(false); // only 2 old lines
      expect(isLineInDiff('counter.c', 4, 'RIGHT')).toBe(false);
    });

    it('keeps the file path after a removed SQL `-- comment` line', () => {
      // A deleted `-- comment` is emitted as `--- comment`, which the header
      // parser used to read as the old path "comment".
      const diff = [
        'diff --git a/q.sql b/q.sql',
        '--- a/q.sql',
        '+++ b/q.sql',
        '@@ -1,3 +1,2 @@',
        ' SELECT 1;',
        '--- comment',
        ' SELECT 2;',
        ''
      ].join('\n');
      const { isLineInDiff } = buildDiffLineSet(diff);
      expect(isLineInDiff('q.sql', 2, 'LEFT')).toBe(true);  // -- comment
      expect(isLineInDiff('q.sql', 3, 'LEFT')).toBe(true);  // SELECT 2;
      expect(isLineInDiff('q.sql', 2, 'RIGHT')).toBe(true); // SELECT 2;
      expect(isLineInDiff('q.sql', 3, 'RIGHT')).toBe(false);
      expect(isLineInDiff('comment', 2, 'LEFT')).toBe(false);
    });

    it('still reads real headers after the previous file\'s hunk', () => {
      // The guard must not overshoot: outside a hunk these prefixes ARE
      // headers, and the next file section starts on `diff --git` even though
      // the previous file's hunk was still open.
      const { isLineInDiff } = buildDiffLineSet(bodyLooksLikeHeaderDiff);
      expect(isLineInDiff('counter.c', 4, 'RIGHT')).toBe(true);
      // counter.c's numbering must not bleed into notes.md's section.
      expect(isLineInDiff('counter.c', 5, 'RIGHT')).toBe(false);
      expect(isLineInDiff('notes.md', 0, 'RIGHT')).toBe(false);
    });

    it('does not mistake a mid-hunk `--- ` / `+++ ` pair for a file section', () => {
      // The disguised pair is followed by a genuine second hunk of the SAME
      // file, so it reads like a `---`/`+++`/`@@` file header. It arrives
      // inside the first hunk, so it is content.
      const diff = [
        'diff --git a/queries.sql b/queries.sql',
        '--- a/queries.sql',
        '+++ b/queries.sql',
        '@@ -1,2 +1,2 @@',
        ' SELECT 1;',
        '--- deleted marker',
        '+++ added marker',
        '@@ -20,2 +20,2 @@',
        ' SELECT 2;',
        '-old',
        '+new',
        ''
      ].join('\n');
      const { isLineInDiff } = buildDiffLineSet(diff);
      expect(isLineInDiff('queries.sql', 2, 'RIGHT')).toBe(true);  // ++ added marker
      expect(isLineInDiff('queries.sql', 2, 'LEFT')).toBe(true);   // -- deleted marker
      expect(isLineInDiff('queries.sql', 21, 'RIGHT')).toBe(true); // second hunk
      expect(isLineInDiff('added marker', 21, 'RIGHT')).toBe(false);
    });

    it('reads a `--unified=0` delete/add pair before the next hunk as content', () => {
      const diff = [
        'diff --git a/q.sql b/q.sql',
        '--- a/q.sql',
        '+++ b/q.sql',
        '@@ -3 +3 @@',
        '--- old comment',
        '+++ new comment',
        '@@ -10 +10 @@',
        '-a',
        '+b',
        ''
      ].join('\n');
      const { isLineInDiff } = buildDiffLineSet(diff);
      expect(isLineInDiff('q.sql', 3, 'LEFT')).toBe(true);
      expect(isLineInDiff('q.sql', 3, 'RIGHT')).toBe(true);
      expect(isLineInDiff('q.sql', 10, 'RIGHT')).toBe(true);
      expect(isLineInDiff('new comment', 10, 'RIGHT')).toBe(false);
    });

    it('reads a hunk whose `@@` context contains a carriage return', () => {
      // Without dotAll the header was rejected and its lines were registered
      // as a continuation of the previous hunk (lines 3-5), not 20-21.
      const diff = [
        'diff --git a/f.js b/f.js',
        '--- a/f.js',
        '+++ b/f.js',
        '@@ -1,2 +1,2 @@',
        ' a',
        '-b',
        '+B',
        '@@ -20,2 +20,2 @@ function foo() {\r  // x',
        ' c',
        '-d',
        '+D',
        ''
      ].join('\n');
      const { isLineInDiff } = buildDiffLineSet(diff);
      expect(isLineInDiff('f.js', 20, 'RIGHT')).toBe(true);
      expect(isLineInDiff('f.js', 21, 'RIGHT')).toBe(true);
      expect(isLineInDiff('f.js', 21, 'LEFT')).toBe(true);
      expect(isLineInDiff('f.js', 3, 'RIGHT')).toBe(false);
    });

    it('skips `\\ No newline at end of file` without advancing either side', () => {
      const diff = [
        'diff --git a/q.sql b/q.sql',
        '--- a/q.sql',
        '+++ b/q.sql',
        '@@ -1,2 +1,3 @@',
        ' SELECT 1;',
        '--- trailing comment',
        '\\ No newline at end of file',
        '+++x',
        '+-- new trailing comment',
        '\\ No newline at end of file',
        'diff --git a/next.js b/next.js',
        '--- a/next.js',
        '+++ b/next.js',
        '@@ -5,1 +5,2 @@',
        ' a',
        '+b',
        ''
      ].join('\n');
      const { isLineInDiff } = buildDiffLineSet(diff);
      expect(isLineInDiff('q.sql', 2, 'LEFT')).toBe(true);  // -- trailing comment
      expect(isLineInDiff('q.sql', 3, 'LEFT')).toBe(false);
      expect(isLineInDiff('q.sql', 2, 'RIGHT')).toBe(true); // ++x
      expect(isLineInDiff('q.sql', 3, 'RIGHT')).toBe(true); // -- new trailing comment
      expect(isLineInDiff('q.sql', 4, 'RIGHT')).toBe(false);
      // The following file header is still recognized.
      expect(isLineInDiff('next.js', 6, 'RIGHT')).toBe(true);
      expect(isLineInDiff('q.sql', 6, 'RIGHT')).toBe(false);
    });

    it('treats omitted hunk counts as 1 and honours zero counts', () => {
      const diff = [
        'diff --git a/one.sql b/one.sql',
        '--- a/one.sql',
        '+++ b/one.sql',
        '@@ -3 +3 @@',
        '--- was a comment',
        '+++y',
        'diff --git a/added.sql b/added.sql',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/added.sql',
        '@@ -0,0 +1,2 @@',
        '+-- header comment',
        '+++z',
        'diff --git a/gone.sql b/gone.sql',
        'deleted file mode 100644',
        '--- a/gone.sql',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '--- only comment',
        '-SELECT 1;',
        ''
      ].join('\n');
      const { isLineInDiff } = buildDiffLineSet(diff);
      expect(isLineInDiff('one.sql', 3, 'LEFT')).toBe(true);
      expect(isLineInDiff('one.sql', 3, 'RIGHT')).toBe(true);
      expect(isLineInDiff('one.sql', 4, 'RIGHT')).toBe(false);
      expect(isLineInDiff('added.sql', 1, 'RIGHT')).toBe(true);
      expect(isLineInDiff('added.sql', 2, 'RIGHT')).toBe(true);
      expect(isLineInDiff('gone.sql', 1, 'LEFT')).toBe(true);
      expect(isLineInDiff('gone.sql', 2, 'LEFT')).toBe(true);
      expect(isLineInDiff('only comment', 1, 'LEFT')).toBe(false);
    });

    it('handles hunkless binary, rename-only and mode-only sections between hunks', () => {
      const diff = [
        'diff --git a/first.sql b/first.sql',
        '--- a/first.sql',
        '+++ b/first.sql',
        '@@ -1,2 +1,2 @@',
        '--- old',
        '+++new',
        ' tail',
        'diff --git a/bin.dat b/bin.dat',
        'index cf0a824..dc6a6b2 100644',
        'Binary files a/bin.dat and b/bin.dat differ',
        'diff --git a/oldname.txt b/newname.txt',
        'similarity index 100%',
        'rename from oldname.txt',
        'rename to newname.txt',
        'diff --git a/script.sh b/script.sh',
        'old mode 100644',
        'new mode 100755',
        'diff --git a/last.js b/last.js',
        'index 83db48f..8792505 100644',
        '--- a/last.js',
        '+++ b/last.js',
        '@@ -7,2 +7,2 @@',
        ' keep',
        '-a',
        '+b',
        ''
      ].join('\n');
      const { isLineInDiff } = buildDiffLineSet(diff);
      expect(isLineInDiff('first.sql', 1, 'RIGHT')).toBe(true);
      expect(isLineInDiff('first.sql', 2, 'RIGHT')).toBe(true);
      expect(isLineInDiff('first.sql', 3, 'RIGHT')).toBe(false);
      expect(isLineInDiff('bin.dat', 1, 'RIGHT')).toBe(false);
      expect(isLineInDiff('newname.txt', 1, 'RIGHT')).toBe(false);
      expect(isLineInDiff('script.sh', 1, 'RIGHT')).toBe(false);
      expect(isLineInDiff('last.js', 8, 'RIGHT')).toBe(true);
      expect(isLineInDiff('last.js', 8, 'LEFT')).toBe(true);
    });
  });

  describe('header-lookalike lines with hunk tracking', () => {
    // schema.sql hunk 1 removes the SQL comment `-- old comment` (emitted as
    // `--- old comment`) and adds `++x` (emitted as `+++x`). A second hunk in
    // the same file and a hunk in a second file follow. Reading either line as
    // a file header would skip it, so `id int` and `);` would land one line
    // early on each side and line 4 would fall outside the first hunk.
    const diff = [
      'diff --git a/schema.sql b/schema.sql',
      '--- a/schema.sql',
      '+++ b/schema.sql',
      '@@ -1,4 +1,4 @@',
      ' create table t (',
      '--- old comment',
      '+++x',
      '   id int',
      ' );',
      '@@ -10,3 +10,3 @@',
      ' select 1;',
      '-select 2;',
      '+select 3;',
      ' select 4;',
      'diff --git a/b.js b/b.js',
      '--- a/b.js',
      '+++ b/b.js',
      '@@ -1,2 +1,2 @@',
      '-one',
      '+ONE',
      ' two',
      ''
    ].join('\n');

    it('keeps line numbers, hunk indexes and inline ranges right past the lookalike lines', () => {
      const { isLineInDiff, hunkOf } = buildDiffLineSet(diff);

      // Line numbers after the lookalike lines: RIGHT 1 create, 2 ++x,
      // 3 id int, 4 ); and LEFT 1 create, 2 -- old comment, 3 id int, 4 );
      for (const line of [1, 2, 3, 4]) {
        expect(isLineInDiff('schema.sql', line, 'RIGHT')).toBe(true);
        expect(isLineInDiff('schema.sql', line, 'LEFT')).toBe(true);
      }
      expect(isLineInDiff('schema.sql', 5, 'RIGHT')).toBe(false);
      expect(isLineInDiff('schema.sql', 5, 'LEFT')).toBe(false);
      expect(isLineInDiff('old comment', 2, 'LEFT')).toBe(false);

      // Hunks are indexed in diff order. Every line of the first hunk,
      // including the ones after the lookalike lines, is in hunk 0.
      for (const line of [1, 2, 3, 4]) {
        expect(hunkOf('schema.sql', line, 'RIGHT')).toBe(0);
        expect(hunkOf('schema.sql', line, 'LEFT')).toBe(0);
      }
      expect(hunkOf('schema.sql', 5, 'RIGHT')).toBeNull();
      expect(hunkOf('schema.sql', 10, 'RIGHT')).toBe(1);
      expect(hunkOf('schema.sql', 12, 'LEFT')).toBe(1);
      expect(hunkOf('b.js', 1, 'RIGHT')).toBe(2);

      const comments = buildReviewComments([
        // Spans the added `++x` line on the new side
        { file: 'schema.sql', line_start: 1, line_end: 4, side: 'RIGHT', body: 'new side' },
        // Spans the removed `-- old comment` line on the old side, written backwards
        { file: 'schema.sql', line_start: 4, line_end: 1, side: 'LEFT', body: 'old side' },
        // Crosses into the second hunk, so it anchors on line_start alone
        { file: 'schema.sql', line_start: 3, line_end: 10, side: 'RIGHT', body: 'cross hunk' }
      ], diff);

      expect(comments).toEqual([
        { path: 'schema.sql', line: 4, start_line: 1, side: 'RIGHT', start_side: 'RIGHT', body: 'new side', isFileLevel: false },
        { path: 'schema.sql', line: 4, start_line: 1, side: 'LEFT', start_side: 'LEFT', body: 'old side', isFileLevel: false },
        { path: 'schema.sql', line: 3, side: 'RIGHT', body: 'cross hunk', isFileLevel: false }
      ]);
    });
  });
});
