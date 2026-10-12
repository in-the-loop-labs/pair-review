// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Headless (--ai-draft / --ai-review) review comments: the stored AI findings
 * loaded by loadHeadlessSuggestions, mapped by the shared buildReviewComments
 * (the web submit route's mapping) with a headless-style body formatter.
 * The database is the real test schema (tests/utils/schema.js).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema.js';

const { loadHeadlessSuggestions } = require('../../src/main');
const { buildReviewComments } = require('../../src/utils/diff-annotator');
const logger = require('../../src/utils/logger');
const { QUOTEPATH_FALSE_DIFF } = require('../utils/git-path-fixtures');

// a.js: old line 2 is deleted and new line 2 is added, inside one hunk.
const DIFF = [
  'diff --git a/a.js b/a.js',
  '--- a/a.js',
  '+++ b/a.js',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  ''
].join('\n');

let db;
let reviewId;

beforeEach(() => {
  db = createTestDatabase();
  reviewId = seedTestReview(db);
});

afterEach(() => {
  closeTestDatabase(db);
  vi.restoreAllMocks();
});

function insertComment(fields) {
  const row = {
    review_id: reviewId,
    source: 'ai',
    ai_level: null,
    is_raw: 0,
    status: 'active',
    file: 'a.js',
    line_start: 2,
    line_end: 2,
    side: 'RIGHT',
    type: 'bug',
    title: 'Title',
    body: 'Check this.',
    is_file_level: 0,
    ...fields
  };
  const columns = Object.keys(row);
  const result = db.prepare(
    `INSERT INTO comments (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  ).run(...columns.map(column => row[column]));
  return Number(result.lastInsertRowid);
}

async function headlessComments(diff = DIFF) {
  const suggestions = await loadHeadlessSuggestions(db, reviewId);
  return buildReviewComments(suggestions, diff, {
    formatBody: suggestion => `[${suggestion.type}] ${suggestion.body}`
  });
}

describe('loadHeadlessSuggestions', () => {
  it('submits a LEFT-side finding on a deleted line with side LEFT', async () => {
    insertComment({ side: 'LEFT', line_start: 2, line_end: 2 });

    expect(await headlessComments()).toEqual([{
      path: 'a.js', line: 2, body: '[bug] Check this.', side: 'LEFT', isFileLevel: false
    }]);
  });

  it('loads the fields the shared mapping needs', async () => {
    const id = insertComment({ side: 'LEFT', line_start: 1, line_end: 3 });

    const [suggestion] = await loadHeadlessSuggestions(db, reviewId);

    expect(suggestion).toMatchObject({
      id, file: 'a.js', line_start: 1, line_end: 3, side: 'LEFT', type: 'bug', body: 'Check this.', is_file_level: 0
    });
  });

  it("loads only the review's active, final, non-raw AI findings, ordered by file and line", async () => {
    const keepB = insertComment({ file: 'b.js', line_start: 1, line_end: 1 });
    const keepA2 = insertComment({ line_start: 2 });
    const keepA1 = insertComment({ line_start: 1, line_end: 1, is_raw: null });
    insertComment({ ai_level: 1 });
    insertComment({ is_raw: 1 });
    insertComment({ status: 'dismissed' });
    insertComment({ source: 'user' });
    insertComment({ review_id: seedTestReview(db, { prNumber: 2 }) });

    const suggestions = await loadHeadlessSuggestions(db, reviewId);

    expect(suggestions.map(s => s.id)).toEqual([keepA1, keepA2, keepB]);
  });

  it('keeps a file-level finding and submits it as a file-level comment', async () => {
    insertComment({ is_file_level: 1, line_start: null, line_end: null });

    expect(await headlessComments()).toEqual([{
      path: 'a.js', body: '[bug] Check this.', isFileLevel: true
    }]);
  });

  it('submits a range inside the hunk with start_line', async () => {
    insertComment({ line_start: 1, line_end: 3 });

    expect(await headlessComments()).toEqual([{
      path: 'a.js', line: 3, start_line: 1, start_side: 'RIGHT', body: '[bug] Check this.', side: 'RIGHT', isFileLevel: false
    }]);
  });

  it('submits a line outside every hunk as a file-level comment with a line reference', async () => {
    insertComment({ line_start: 40, line_end: 40 });

    expect(await headlessComments()).toEqual([{
      path: 'a.js', body: '(Ref Line 40) [bug] Check this.', isFileLevel: true
    }]);
  });

  it('skips and reports findings without a path or a positive line', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    insertComment({ line_start: null });
    insertComment({ line_start: 0 });
    insertComment({ file: '' });
    insertComment({ file: '   ' });
    insertComment({ file: null });

    expect(await loadHeadlessSuggestions(db, reviewId)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing valid line or path information'));
  });

  it('submits findings on non-ASCII and quoted file names inline', async () => {
    // The stored file is the real name; the diff spells `quo"te.js` C-quoted.
    insertComment({ file: 'café.js', line_start: 2, line_end: 2 });
    insertComment({ file: 'quo"te.js', line_start: 1, line_end: 2 });

    expect(await headlessComments(QUOTEPATH_FALSE_DIFF)).toEqual([
      { path: 'café.js', line: 2, body: '[bug] Check this.', side: 'RIGHT', isFileLevel: false },
      { path: 'quo"te.js', line: 2, start_line: 1, start_side: 'RIGHT', body: '[bug] Check this.', side: 'RIGHT', isFileLevel: false }
    ]);
  });

  it('returns an empty list when the review has no findings', async () => {
    expect(await loadHeadlessSuggestions(db, reviewId)).toEqual([]);
  });
});
