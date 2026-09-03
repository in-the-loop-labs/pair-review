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

  describe('hasFile', () => {
    // Captured verbatim from a real repository with the exact command
    // `src/git/worktree.js#generateUnifiedDiff` runs:
    //   git diff <base>...<head> --unified=3 --no-color --no-ext-diff \
    //     --src-prefix=a/ --dst-prefix=b/ --no-relative --full-index
    // Every entry except normal.js closes WITHOUT a hunk body — which is
    // exactly the shape that used to make `hasFile` answer "no" for a path
    // the pull request plainly contains, and local mode's
    // `refuseCommentsOutsideDiff` then rejected the WHOLE submission
    // (409 comments_outside_pr), unrelated valid comments included.
    // Rename detection is ON: GIT_DIFF_FLAGS carries no --no-renames.
    const hunklessDiff = [
      'diff --git a/bin.dat b/bin.dat',
      'index cf0a8244db9565611804d88c4cc2aef31aa88c89..dc6a6b2bc4e7f37c94faa50ff6c21479dae6c5dc 100644',
      'Binary files a/bin.dat and b/bin.dat differ',
      'diff --git a/empty.txt b/empty.txt',
      'new file mode 100644',
      'index 0000000000000000000000000000000000000000..e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
      'diff --git a/oldname.txt b/newname.txt',
      'similarity index 100%',
      'rename from oldname.txt',
      'rename to newname.txt',
      'diff --git a/normal.js b/normal.js',
      'index 83db48f84ec878fbfb30b46d16630e944e34f205..8792505ed56d3abb5f0bfb5d0334c889352fe24a 100644',
      '--- a/normal.js',
      '+++ b/normal.js',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-line2',
      '+line2 changed',
      ' line3',
      'diff --git a/script.sh b/script.sh',
      'old mode 100644',
      'new mode 100755',
      ''
    ].join('\n');

    it('is true for a BINARY file entry, which carries no hunk at all', () => {
      const { hasFile, isLineInDiff } = buildDiffLineSet(hunklessDiff);
      expect(hasFile('bin.dat')).toBe(true);
      expect(isLineInDiff('bin.dat', 1, 'RIGHT')).toBe(false);
    });

    it('is true for a 100%-similarity RENAME, under the post-image path only', () => {
      const { hasFile, isLineInDiff } = buildDiffLineSet(hunklessDiff);
      // The post-image name is the one local mode renders and anchors to.
      expect(hasFile('newname.txt')).toBe(true);
      expect(hasFile('oldname.txt')).toBe(false);
      expect(isLineInDiff('newname.txt', 1, 'RIGHT')).toBe(false);
    });

    it('is true for a MODE-ONLY change', () => {
      const { hasFile, isLineInDiff } = buildDiffLineSet(hunklessDiff);
      expect(hasFile('script.sh')).toBe(true);
      expect(isLineInDiff('script.sh', 1, 'RIGHT')).toBe(false);
    });

    it('is true for a new EMPTY file', () => {
      const { hasFile, isLineInDiff } = buildDiffLineSet(hunklessDiff);
      expect(hasFile('empty.txt')).toBe(true);
      expect(isLineInDiff('empty.txt', 1, 'RIGHT')).toBe(false);
    });

    it('closes the LAST section even though no `diff --git` follows it', () => {
      // script.sh is the final entry; without an explicit close after the loop
      // it would be the one path a header-keyed `hasFile` still missed.
      const lastOnly = [
        'diff --git a/script.sh b/script.sh',
        'old mode 100644',
        'new mode 100755'
      ].join('\n');
      expect(buildDiffLineSet(lastOnly).hasFile('script.sh')).toBe(true);
    });

    it('still answers for an ordinary file with hunks, and its lines still resolve', () => {
      const { hasFile, isLineInDiff } = buildDiffLineSet(hunklessDiff);
      expect(hasFile('normal.js')).toBe(true);
      // The hunk-keyed answer is untouched by the header-keyed one.
      expect(isLineInDiff('normal.js', 2, 'RIGHT')).toBe(true);
      expect(isLineInDiff('normal.js', 2, 'LEFT')).toBe(true);
      expect(isLineInDiff('normal.js', 9, 'RIGHT')).toBe(false);
    });

    it('is false for a path the diff does not mention', () => {
      const { hasFile } = buildDiffLineSet(hunklessDiff);
      expect(hasFile('absent.js')).toBe(false);
    });

    it('is true for a DELETED file, under the path it had', () => {
      const diff = [
        'diff --git a/gone.js b/gone.js',
        'deleted file mode 100644',
        'index 83db48f..0000000',
        '--- a/gone.js',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-line1',
        '-line2'
      ].join('\n');
      const { hasFile } = buildDiffLineSet(diff);
      expect(hasFile('gone.js')).toBe(true);
    });

    it('is false for every path given an empty or null diff (unknown, not "no")', () => {
      // Callers must read this as UNKNOWN — `filesNotInDiff` refuses to
      // reject anything when the diff itself is empty.
      expect(buildDiffLineSet('').hasFile('file.js')).toBe(false);
      expect(buildDiffLineSet(null).hasFile('file.js')).toBe(false);
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
    //   - `+++ added marker` overwrote newPath with "added marker", and since
    //     `closeSection` samples the path at section END, that fragment of
    //     source code — not notes.md — was the path registered in `hasFile`
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

    it('registers the REAL path, not a fragment of the hunk body', () => {
      const { hasFile } = buildDiffLineSet(bodyLooksLikeHeaderDiff);
      expect(hasFile('notes.md')).toBe(true);
      expect(hasFile('counter.c')).toBe(true);
      // The false positives: paths that do not exist, which used to sail
      // through `filesNotInDiff` and be posted to GitHub.
      expect(hasFile('added marker')).toBe(false);
      expect(hasFile('deleted marker')).toBe(false);
    });

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
      const { isLineInDiff, hasFile } = buildDiffLineSet(diff);
      expect(hasFile('counter.c')).toBe(true);
      expect(isLineInDiff('counter.c', 2, 'RIGHT')).toBe(true); // the ++i; line
      expect(isLineInDiff('counter.c', 3, 'RIGHT')).toBe(true); // return i;
      expect(isLineInDiff('counter.c', 3, 'LEFT')).toBe(false); // only 2 old lines
      expect(isLineInDiff('counter.c', 4, 'RIGHT')).toBe(false);
    });

    it('still reads a real `index ` line as a header, not as content', () => {
      // The guard must not overshoot: outside a hunk these prefixes ARE
      // headers, and the next file section starts on `diff --git` even though
      // the previous file's hunk was still open.
      const { hasFile, isLineInDiff } = buildDiffLineSet(bodyLooksLikeHeaderDiff);
      expect(hasFile('counter.c')).toBe(true);
      expect(isLineInDiff('counter.c', 4, 'RIGHT')).toBe(true);
      // counter.c's numbering must not bleed into notes.md's section.
      expect(isLineInDiff('counter.c', 5, 'RIGHT')).toBe(false);
      expect(isLineInDiff('notes.md', 0, 'RIGHT')).toBe(false);
    });

    it('handles a bare unified diff with no `diff --git` line at all', () => {
      // `diff -u` output and concatenated patch fragments separate files with
      // the `---`/`+++`/`@@` triple alone, which arrives while the previous
      // file's hunk is still open. That is the one header the `!inHunk` guard
      // must still honour.
      const bare = [
        '--- a/first.js',
        '+++ b/first.js',
        '@@ -1,2 +1,2 @@',
        ' keep',
        '-old',
        '+new',
        '--- a/second.js',
        '+++ b/second.js',
        '@@ -10,2 +10,2 @@',
        ' keep2',
        '-old2',
        '+new2',
        ''
      ].join('\n');
      const { hasFile, isLineInDiff } = buildDiffLineSet(bare);
      expect(hasFile('first.js')).toBe(true);
      expect(hasFile('second.js')).toBe(true);
      expect(isLineInDiff('first.js', 2, 'RIGHT')).toBe(true);
      expect(isLineInDiff('second.js', 11, 'RIGHT')).toBe(true);
      // Second file's lines must NOT be attributed to the first.
      expect(isLineInDiff('first.js', 11, 'RIGHT')).toBe(false);
    });

    it('does not mistake a mid-hunk `--- ` / `+++ ` pair for a file section', () => {
      // The bare-section heuristic also requires a following `@@`. Here the
      // disguised pair sits before a genuine second hunk of the SAME file, and
      // the hunk's declared counts prove it is still content.
      const diff = [
        'diff --git a/queries.sql b/queries.sql',
        '--- a/queries.sql',
        '+++ b/queries.sql',
        '@@ -1,3 +1,3 @@',
        ' SELECT 1;',
        '--- deleted marker',
        '+++ added marker',
        '@@ -20,2 +20,2 @@',
        ' SELECT 2;',
        '-old',
        '+new',
        ''
      ].join('\n');
      const { hasFile, isLineInDiff } = buildDiffLineSet(diff);
      expect(hasFile('queries.sql')).toBe(true);
      expect(hasFile('added marker')).toBe(false);
      expect(isLineInDiff('queries.sql', 2, 'RIGHT')).toBe(true);  // ++ added marker
      expect(isLineInDiff('queries.sql', 2, 'LEFT')).toBe(true);   // -- deleted marker
      expect(isLineInDiff('queries.sql', 21, 'RIGHT')).toBe(true); // second hunk
    });
  });

  describe('paths git had to quote or pad', () => {
    // Captured byte-for-byte from real `git diff`; see
    // tests/unit/diff-paths.test.js for the full cross-parser fixture.
    it('answers under the real name for a path containing a space', () => {
      const diff = [
        'diff --git a/my file.txt b/my file.txt',
        'index de98044..7be73ce 100644',
        // Git appends a bare TAB when the name contains a space.
        '--- a/my file.txt\t',
        '+++ b/my file.txt\t',
        '@@ -1,3 +1,3 @@',
        ' a',
        '-b',
        '+B',
        ' c',
        ''
      ].join('\n');
      const { hasFile, isLineInDiff } = buildDiffLineSet(diff);
      expect(hasFile('my file.txt')).toBe(true);
      expect(hasFile('my file.txt\t')).toBe(false);
      expect(isLineInDiff('my file.txt', 2, 'RIGHT')).toBe(true);
    });

    it('answers under the real name for a C-quoted non-ASCII path', () => {
      const diff = [
        String.raw`diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"`,
        'index de98044..7be73ce 100644',
        String.raw`--- "a/caf\303\251.txt"`,
        String.raw`+++ "b/caf\303\251.txt"`,
        '@@ -1,3 +1,3 @@',
        ' a',
        '-b',
        '+B',
        ' c',
        ''
      ].join('\n');
      const { hasFile, isLineInDiff } = buildDiffLineSet(diff);
      expect(hasFile('café.txt')).toBe(true);
      expect(hasFile(String.raw`"b/caf\303\251.txt"`)).toBe(false);
      expect(isLineInDiff('café.txt', 2, 'RIGHT')).toBe(true);
    });

    it('prefers the `diff --git` paths over a secondary header', () => {
      // A rename names both sides on the header line; the `---`/`+++` pair can
      // only confirm it, never redefine it.
      const diff = [
        'diff --git a/old.js b/new.js',
        'similarity index 80%',
        'rename from old.js',
        'rename to new.js',
        '--- a/old.js',
        '+++ b/new.js',
        '@@ -1,2 +1,2 @@',
        ' keep',
        '-old',
        '+new',
        ''
      ].join('\n');
      const { hasFile } = buildDiffLineSet(diff);
      expect(hasFile('new.js')).toBe(true);
      expect(hasFile('old.js')).toBe(false);
    });

    it('falls back to the secondary headers when there is no `diff --git`', () => {
      const diff = [
        '--- a/only.js\t2026-08-23 10:11:12.000000000 +0000',
        '+++ b/only.js\t2026-08-23 10:11:13.000000000 +0000',
        '@@ -1,2 +1,2 @@',
        ' keep',
        '-old',
        '+new',
        ''
      ].join('\n');
      const { hasFile, isLineInDiff } = buildDiffLineSet(diff);
      expect(hasFile('only.js')).toBe(true);
      expect(isLineInDiff('only.js', 2, 'RIGHT')).toBe(true);
    });
  });
});
