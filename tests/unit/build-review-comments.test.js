// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * buildReviewComments: the one mapping from stored comment rows to the GitHub
 * review comments both submit paths send (web submit route and headless
 * --ai-draft / --ai-review).
 */
import { describe, it, expect } from 'vitest';

const { buildReviewComments } = require('../../src/utils/diff-annotator');
const {
  QUOTEPATH_FALSE_DIFF,
  QUOTEPATH_TRUE_DIFF,
  B_SLASH_RENAME_DIFF
} = require('../utils/git-path-fixtures');

// file.js: lines 1-2 (both sides) are context, old line 3 deleted, new
// line 3 added, line 4 / old 4 context. Lines beyond 4 are outside the hunk.
const DIFF = [
  'diff --git a/file.js b/file.js',
  '--- a/file.js',
  '+++ b/file.js',
  '@@ -1,4 +1,4 @@',
  ' one',
  ' two',
  '-three',
  '+THREE',
  ' four',
  ''
].join('\n');

// two.js: two hunks. Hunk 1 covers lines 1-3 and hunk 2 lines 20-22, on
// both sides. Lines 4-19 sit between the hunks, outside the diff.
const TWO_HUNK_DIFF = [
  'diff --git a/two.js b/two.js',
  '--- a/two.js',
  '+++ b/two.js',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '@@ -20,3 +20,3 @@',
  ' twenty',
  '-twentyone',
  '+TWENTYONE',
  ' twentytwo',
  ''
].join('\n');

const row = (overrides = {}) => ({
  file: 'file.js', line_start: 3, line_end: 3, side: 'RIGHT', body: 'Body.', is_file_level: 0, ...overrides
});

describe('buildReviewComments', () => {
  it('maps an in-hunk line to a line comment on its side', () => {
    expect(buildReviewComments([row(), row({ side: 'LEFT' })], DIFF)).toEqual([
      { path: 'file.js', line: 3, body: 'Body.', side: 'RIGHT', isFileLevel: false },
      { path: 'file.js', line: 3, body: 'Body.', side: 'LEFT', isFileLevel: false }
    ]);
  });

  it('defaults a missing side to RIGHT', () => {
    expect(buildReviewComments([row({ side: null })], DIFF)[0].side).toBe('RIGHT');
  });

  it('treats a missing line_end, or one equal to line_start, as a single line', () => {
    const comments = buildReviewComments([row({ line_end: null }), row()], DIFF);
    expect(comments.map(c => c.start_line)).toEqual([undefined, undefined]);
    expect(comments.map(c => c.line)).toEqual([3, 3]);
  });

  it('maps an in-hunk range to line_end with start_line and start_side', () => {
    expect(buildReviewComments([row({ line_start: 1, line_end: 4 })], DIFF)).toEqual([
      { path: 'file.js', line: 4, start_line: 1, start_side: 'RIGHT', body: 'Body.', side: 'RIGHT', isFileLevel: false }
    ]);
  });

  it('sends a LEFT-side range with start_side LEFT', () => {
    // Old lines 2-4 are all in the hunk on LEFT (old line 3 is the deletion).
    expect(buildReviewComments([row({ side: 'LEFT', line_start: 2, line_end: 4 })], DIFF)).toEqual([
      { path: 'file.js', line: 4, start_line: 2, start_side: 'LEFT', body: 'Body.', side: 'LEFT', isFileLevel: false }
    ]);
  });

  it('orders a backwards range inside one hunk and keeps it inline', () => {
    expect(buildReviewComments([row({ line_start: 4, line_end: 1 })], DIFF)).toEqual([
      { path: 'file.js', line: 4, start_line: 1, start_side: 'RIGHT', body: 'Body.', side: 'RIGHT', isFileLevel: false }
    ]);
  });

  it('sends a range whose ends are in different hunks as a single line on line_start', () => {
    expect(buildReviewComments([row({ file: 'two.js', line_start: 2, line_end: 21 })], TWO_HUNK_DIFF)).toEqual([
      { path: 'two.js', line: 2, body: 'Body.', side: 'RIGHT', isFileLevel: false }
    ]);
  });

  it('anchors a backwards cross-hunk range on its original line_start', () => {
    expect(buildReviewComments([
      row({ file: 'two.js', line_start: 21, line_end: 2 }),
      row({ file: 'two.js', side: 'LEFT', line_start: 21, line_end: 2 })
    ], TWO_HUNK_DIFF)).toEqual([
      { path: 'two.js', line: 21, body: 'Body.', side: 'RIGHT', isFileLevel: false },
      { path: 'two.js', line: 21, body: 'Body.', side: 'LEFT', isFileLevel: false }
    ]);
  });

  it('keeps a range inside the second hunk inline', () => {
    expect(buildReviewComments([row({ file: 'two.js', line_start: 20, line_end: 22 })], TWO_HUNK_DIFF)).toEqual([
      { path: 'two.js', line: 22, start_line: 20, start_side: 'RIGHT', body: 'Body.', side: 'RIGHT', isFileLevel: false }
    ]);
  });

  it('sends a range whose line_start is outside the diff as file-level, even when its end is inside', () => {
    expect(buildReviewComments([
      row({ file: 'two.js', line_start: 10, line_end: 21 }),
      // Backwards: ordered to 21-25, but the finding anchors on 25
      row({ file: 'two.js', line_start: 25, line_end: 21 })
    ], TWO_HUNK_DIFF)).toEqual([
      { path: 'two.js', body: '(Ref Lines 10-21) Body.', isFileLevel: true },
      { path: 'two.js', body: '(Ref Lines 21-25) Body.', isFileLevel: true }
    ]);
  });

  it('maps an explicit file-level row to a file-level comment', () => {
    expect(buildReviewComments([row({ is_file_level: 1, line_start: null, line_end: null })], DIFF)).toEqual([
      { path: 'file.js', body: 'Body.', isFileLevel: true }
    ]);
  });

  it('maps a line outside every hunk to a file-level comment with a line reference', () => {
    expect(buildReviewComments([row({ line_start: 20, line_end: 20 })], DIFF)).toEqual([
      { path: 'file.js', body: '(Ref Line 20) Body.', isFileLevel: true }
    ]);
  });

  it('maps a range with one end outside the hunk by where line_start falls', () => {
    // 2-9: line_start 2 is in the hunk, so a single-line comment on 2.
    // 9-2: ordered to 2-9, but line_start 9 is outside, so file-level.
    expect(buildReviewComments([row({ line_start: 2, line_end: 9 }), row({ line_start: 9, line_end: 2 })], DIFF)).toEqual([
      { path: 'file.js', line: 2, body: 'Body.', side: 'RIGHT', isFileLevel: false },
      { path: 'file.js', body: '(Ref Lines 2-9) Body.', isFileLevel: true }
    ]);
  });

  it('maps a range with both ends outside every hunk to a file-level comment', () => {
    expect(buildReviewComments([row({ line_start: 6, line_end: 9 })], DIFF)).toEqual([
      { path: 'file.js', body: '(Ref Lines 6-9) Body.', isFileLevel: true }
    ]);
  });

  it('checks the hunk on the comment side', () => {
    // New line 3 exists only on RIGHT; old line 3 exists only on LEFT. Line 5
    // is outside the hunk on both sides.
    const comments = buildReviewComments([row({ side: 'LEFT', line_start: 5, line_end: 5 })], DIFF);
    expect(comments).toEqual([{ path: 'file.js', body: '(Ref Line 5) Body.', isFileLevel: true }]);
  });

  it('applies formatBody before the line reference prefix', () => {
    const formatBody = r => `**${r.type}**: ${r.body}`;
    const comments = buildReviewComments([
      row({ type: 'bug' }),
      row({ type: 'bug', line_start: 20, line_end: 20 }),
      row({ type: 'bug', is_file_level: 1 })
    ], DIFF, { formatBody });

    expect(comments.map(c => c.body)).toEqual([
      '**bug**: Body.',
      '(Ref Line 20) **bug**: Body.',
      '**bug**: Body.'
    ]);
  });

  it('treats every line as outside the diff when the diff is empty', () => {
    expect(buildReviewComments([row()], '')).toEqual([
      { path: 'file.js', body: '(Ref Line 3) Body.', isFileLevel: true }
    ]);
  });

  it('returns an empty list for no rows', () => {
    expect(buildReviewComments([], DIFF)).toEqual([]);
    expect(buildReviewComments(null, DIFF)).toEqual([]);
  });
});

// Comment rows carry the real (decoded) file name, the spelling changed_files
// and the diff view use. The hunk lookup must key the diff by that same
// spelling, or an inline comment is downgraded to a file-level one.
describe('buildReviewComments on paths git quotes or spells specially', () => {
  it('keeps a comment on a non-ASCII file inline', () => {
    expect(buildReviewComments([row({ file: 'café.js', line_start: 2, line_end: 2 })], QUOTEPATH_FALSE_DIFF)).toEqual([
      { path: 'café.js', line: 2, body: 'Body.', side: 'RIGHT', isFileLevel: false }
    ]);
  });

  it('keeps a range on a file whose name contains a double quote inline', () => {
    // git prints this header C-quoted even with core.quotePath=false
    expect(buildReviewComments([row({ file: 'quo"te.js', line_start: 1, line_end: 2 })], QUOTEPATH_FALSE_DIFF)).toEqual([
      { path: 'quo"te.js', line: 2, start_line: 1, start_side: 'RIGHT', body: 'Body.', side: 'RIGHT', isFileLevel: false }
    ]);
  });

  it('keeps comments on names containing " b/" or " => " inline', () => {
    expect(buildReviewComments([
      row({ file: 'x b/y.js', line_start: 2, line_end: 2 }),
      row({ file: 'a => b.md', line_start: 2, line_end: 2 })
    ], QUOTEPATH_FALSE_DIFF)).toEqual([
      { path: 'x b/y.js', line: 2, body: 'Body.', side: 'RIGHT', isFileLevel: false },
      { path: 'a => b.md', line: 2, body: 'Body.', side: 'RIGHT', isFileLevel: false }
    ]);
  });

  it('keys a deleted line of a file renamed into a non-ASCII path by the new path', () => {
    expect(buildReviewComments([
      row({ file: 'ñew dir/moved é.js', side: 'LEFT', line_start: 2, line_end: 2 }),
      row({ file: 'lib/moved.js', side: 'LEFT', line_start: 2, line_end: 2 })
    ], QUOTEPATH_FALSE_DIFF)).toEqual([
      { path: 'ñew dir/moved é.js', line: 2, body: 'Body.', side: 'LEFT', isFileLevel: false },
      { path: 'lib/moved.js', body: '(Ref Line 2) Body.', isFileLevel: true }
    ]);
  });

  it('decodes the octal-escaped headers of a diff cached by an older version', () => {
    expect(buildReviewComments([
      row({ file: 'src/café.js', line_start: 2, line_end: 2 }),
      row({ file: 'ñew dir/moved é.js', side: 'LEFT', line_start: 2, line_end: 2 })
    ], QUOTEPATH_TRUE_DIFF)).toEqual([
      { path: 'src/café.js', line: 2, body: 'Body.', side: 'RIGHT', isFileLevel: false },
      { path: 'ñew dir/moved é.js', line: 2, body: 'Body.', side: 'LEFT', isFileLevel: false }
    ]);
  });

  it('keys a rename out of a path containing " b/" by its real new name', () => {
    // The header `diff --git a/x b/y.js b/z.js` splits ambiguously; the hunk
    // must still belong to z.js, not to a fragment of the header.
    expect(buildReviewComments([
      row({ file: 'z.js', line_start: 2, line_end: 5 }),
      row({ file: 'y.js b/z.js', line_start: 5, line_end: 5 })
    ], B_SLASH_RENAME_DIFF)).toEqual([
      { path: 'z.js', line: 5, start_line: 2, start_side: 'RIGHT', body: 'Body.', side: 'RIGHT', isFileLevel: false },
      { path: 'y.js b/z.js', body: '(Ref Line 5) Body.', isFileLevel: true }
    ]);
  });

  it('still counts header-lookalike content in a file next to quoted ones', () => {
    // schema.sql deletes `-- note` (`--- note`) and adds `++ note` (`+++ note`)
    expect(buildReviewComments([
      row({ file: 'schema.sql', line_start: 3, line_end: 3 }),
      row({ file: 'schema.sql', side: 'LEFT', line_start: 2, line_end: 3 })
    ], QUOTEPATH_FALSE_DIFF)).toEqual([
      { path: 'schema.sql', line: 3, body: 'Body.', side: 'RIGHT', isFileLevel: false },
      { path: 'schema.sql', line: 3, start_line: 2, start_side: 'LEFT', body: 'Body.', side: 'LEFT', isFileLevel: false }
    ]);
  });
});
