// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema';

const Analyzer = require('../../src/ai/analyzer');
const ws = require('../../src/ws');
const logger = require('../../src/utils/logger');
const { QUOTEPATH_TRUE_DIFF } = require('../utils/git-path-fixtures');

const finding = (overrides = {}) => ({
  file: 'unchanged.js', line_start: 30, line_end: 35, old_or_new: 'OLD',
  type: 'bug', title: 'Cross-file problem', description: 'The caller breaks this behavior.',
  confidence: 0.9, level: 3, voice_id: 'reviewer-1', is_raw: 1, ...overrides
});

describe.each(['pr', 'local'])('Analyzer findings on unchanged files (%s mode)', mode => {
  let db, root, repoRoot, reviewId, analyzer, broadcast;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-unchanged-'));
    repoRoot = path.join(root, 'repo');
    fs.mkdirSync(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'unchanged.js'), 'code\n'.repeat(800));
    fs.writeFileSync(path.join(repoRoot, 'other.js'), 'code\n'.repeat(20));
    fs.writeFileSync(path.join(root, 'outside.js'), 'outside\n');
    fs.symlinkSync(path.join(root, 'outside.js'), path.join(repoRoot, 'escape.js'));
    db = createTestDatabase();
    if (mode === 'pr') {
      reviewId = seedTestReview(db);
    } else {
      reviewId = Number(db.prepare(`INSERT INTO reviews (review_type, local_path, local_head_sha, status, repository)
        VALUES ('local', ?, 'head', 'draft', 'test/repo')`).run(repoRoot).lastInsertRowid);
    }
    db.prepare('INSERT INTO analysis_runs (id, review_id) VALUES (?, ?)').run('run', reviewId);
    db.prepare('INSERT INTO analysis_runs (id, review_id, parent_run_id) VALUES (?, ?, ?)').run('child', reviewId, 'run');
    analyzer = new Analyzer(db, 'sonnet', 'claude');
    broadcast = vi.spyOn(ws, 'broadcast').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeTestDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const contextFiles = () => db.prepare('SELECT file, line_start, line_end, label FROM context_files ORDER BY id').all();
  const comments = () => db.prepare('SELECT * FROM comments ORDER BY id').all();

  it('stores final unchanged-file findings on RIGHT and opens one panel per file', async () => {
    const suggestions = [
      finding({ line_start: 700, line_end: 705 }), finding(),
      finding({ file: 'other.js', line_start: 5, line_end: 5 }),
      finding({ file: 'missing.js' }), finding({ file: 'escape.js' }),
      finding({ file: '../outside.js' }), finding({ file: path.join(root, 'outside.js') })
    ];

    await analyzer.storeSuggestions(reviewId, 'run', suggestions, null, ['changed.js'], repoRoot);

    expect(comments().map(c => [c.file, c.side, c.line_start])).toEqual([
      ['unchanged.js', 'RIGHT', 700], ['unchanged.js', 'RIGHT', 30], ['other.js', 'RIGHT', 5]
    ]);
    // Centered on the earliest finding in each file
    expect(contextFiles()).toEqual([
      { file: 'unchanged.js', line_start: 20, line_end: 45, label: 'Auto-added for suggestion' },
      { file: 'other.js', line_start: 1, line_end: 15, label: 'Auto-added for suggestion' }
    ]);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(`review:${reviewId}`, {
      type: 'review:context_files_changed', reviewId
    });

    // Storing again never adds more panels for the same files
    await analyzer.storeSuggestions(reviewId, 'run', suggestions, null, ['changed.js'], repoRoot);
    expect(contextFiles()).toHaveLength(2);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('leaves a file that already has a context entry alone', async () => {
    db.prepare('INSERT INTO context_files (review_id, file, line_start, line_end, label) VALUES (?, ?, ?, ?, ?)')
      .run(reviewId, 'unchanged.js', 400, 420, 'Pinned');
    await analyzer.storeSuggestions(reviewId, 'run', [finding()], null, ['changed.js'], repoRoot);
    expect(contextFiles()).toEqual([{ file: 'unchanged.js', line_start: 400, line_end: 420, label: 'Pinned' }]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('opens no panel for intermediate levels, raw council findings or council voices', async () => {
    for (const level of [1, 2, 3]) {
      await analyzer.storeSuggestions(reviewId, 'run', [finding()], level, ['changed.js'], repoRoot);
    }
    await analyzer._storeCouncilSuggestions(reviewId, 'run', [finding()], ['changed.js'], repoRoot);
    await analyzer.storeSuggestions(reviewId, 'child', [finding()], null, ['changed.js'], repoRoot);

    expect(comments()).toHaveLength(5);
    expect(comments()[3]).toMatchObject({ file: 'unchanged.js', side: 'RIGHT', voice_id: 'reviewer-1', is_raw: 1 });
    expect(contextFiles()).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('drops unchanged-file findings when no checkout is given', async () => {
    await analyzer.storeSuggestions(reviewId, 'run', [finding(), finding({ file: 'changed.js' })], null, ['changed.js']);
    expect(comments().map(c => [c.file, c.side])).toEqual([['changed.js', 'LEFT']]);
    expect(contextFiles()).toEqual([]);
  });

  it('keeps findings on changed files with their side and opens no panel for them', async () => {
    await analyzer.storeSuggestions(reviewId, 'run', [finding({ file: './changed.js' })], null, ['changed.js'], repoRoot);
    expect(comments()).toMatchObject([{ file: 'changed.js', side: 'LEFT' }]);
    expect(contextFiles()).toEqual([]);
  });

  it('opens no panel for dismissed findings', async () => {
    await analyzer.storeSuggestions(reviewId, 'run', [finding({ status: 'dismissed' })], null, ['changed.js'], repoRoot);
    expect(contextFiles()).toEqual([]);
  });

  it('validates unchanged-file findings through the upstream and finalization checks', async () => {
    const input = [finding(), finding({ file: 'missing.js' })];
    const early = analyzer.validateSuggestionFilePaths(input, ['changed.js'], repoRoot);
    const finalized = await analyzer.validateAndFinalizeSuggestions(early, new Map(), ['changed.js'], repoRoot);
    expect(finalized).toEqual([finding({ old_or_new: 'NEW' })]);
    expect(input[0].old_or_new).toBe('OLD');
  });

  it('converts an out-of-range unchanged-file line to file level and opens the default window', async () => {
    const invalid = finding({ line_start: 900, line_end: 910 });
    const finalized = await analyzer.validateAndFinalizeSuggestions([invalid], new Map(), ['changed.js'], repoRoot);
    expect(finalized).toEqual([{ ...invalid, old_or_new: 'NEW', line_start: null, line_end: null, is_file_level: true }]);

    await analyzer.storeSuggestions(reviewId, 'run', finalized, null, ['changed.js'], repoRoot);
    expect(comments()).toMatchObject([{ file: 'unchanged.js', line_start: null, is_file_level: 1 }]);
    expect(contextFiles()).toMatchObject([{ file: 'unchanged.js', line_start: 1, line_end: 50 }]);
  });
});

// A PR whose changed_files was cached in git's old quoted spelling. The file
// exists in the checkout too, so a membership miss would store the finding as
// an unchanged-file finding (forced to RIGHT, with a context panel).
describe('Analyzer findings on a non-ASCII changed file', () => {
  let db, repoRoot, reviewId, analyzer;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-non-ascii-'));
    fs.mkdirSync(path.join(repoRoot, 'src'));
    fs.writeFileSync(path.join(repoRoot, 'src', 'café.js'), 'keep\nnew\n');
    db = createTestDatabase();
    reviewId = seedTestReview(db);
    db.prepare('INSERT INTO pr_metadata (pr_number, repository, pr_data) VALUES (1, ?, ?)').run('test/repo', JSON.stringify({
      changed_files: [{ file: String.raw`"src/caf\303\251.js"` }],
      diff: QUOTEPATH_TRUE_DIFF
    }));
    db.prepare('INSERT INTO analysis_runs (id, review_id) VALUES (?, ?)').run('run', reviewId);
    analyzer = new Analyzer(db, 'sonnet', 'claude');
    vi.spyOn(ws, 'broadcast').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeTestDatabase(db);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('reads the decoded changed files from PR metadata', async () => {
    expect(await analyzer.getValidFilePaths(reviewId)).toEqual(['src/café.js', 'ñew dir/moved é.js']);
  });

  it('keeps the finding as a changed-file finding when stored without a changed-file list', async () => {
    await analyzer.storeSuggestions(reviewId, 'run', [finding({ file: 'src/café.js', line_start: 2, line_end: 2 })], null, null, repoRoot);

    expect(db.prepare('SELECT file, side FROM comments').all()).toEqual([{ file: 'src/café.js', side: 'LEFT' }]);
    expect(db.prepare('SELECT * FROM context_files').all()).toEqual([]);
  });

  it('keeps its side through validation against the decoded list', async () => {
    const validFiles = await analyzer.getValidFilePaths(reviewId);
    const input = [finding({ file: 'src/café.js', line_start: 2, line_end: 2 })];
    const finalized = await analyzer.validateAndFinalizeSuggestions(input, new Map(), validFiles, repoRoot);
    expect(finalized).toEqual(input);
  });
});
