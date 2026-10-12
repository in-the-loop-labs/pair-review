// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * buildReviewComments: the one mapping from stored comment rows to the GitHub
 * review comments both submit paths send (web submit route and headless
 * --ai-draft / --ai-review).
 */
import { describe, it, expect } from 'vitest';

const { buildReviewComments } = require('../../src/utils/diff-annotator');

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

  it('maps an in-hunk range to line_end with start_line', () => {
    expect(buildReviewComments([row({ line_start: 1, line_end: 4 })], DIFF)).toEqual([
      { path: 'file.js', line: 4, start_line: 1, body: 'Body.', side: 'RIGHT', isFileLevel: false }
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

  it('maps a range with either end outside the hunk to a file-level comment', () => {
    expect(buildReviewComments([row({ line_start: 2, line_end: 9 }), row({ line_start: 9, line_end: 2 })], DIFF)).toEqual([
      { path: 'file.js', body: '(Ref Lines 2-9) Body.', isFileLevel: true },
      { path: 'file.js', body: '(Ref Lines 9-2) Body.', isFileLevel: true }
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
