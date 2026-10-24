// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema';

const { ContextFileRepository } = require('../../src/database');
const { seedContextFilesForSuggestions, ensureContextFile } = require('../../src/utils/auto-context');
const ws = require('../../src/ws');

describe('seedContextFilesForSuggestions', () => {
  let db, reviewId, broadcast;

  beforeEach(() => {
    db = createTestDatabase();
    reviewId = seedTestReview(db);
    broadcast = vi.spyOn(ws, 'broadcast').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeTestDatabase(db);
  });

  const rows = () => db.prepare('SELECT file, line_start, line_end, label FROM context_files ORDER BY id').all();

  it('opens one panel per unchanged file around its earliest line finding', async () => {
    const created = await seedContextFilesForSuggestions(db, reviewId, [
      { file: 'a.js', line_start: 300, line_end: 302 },
      { file: 'a.js', line_start: null, line_end: null },
      { file: 'a.js', line_start: 40, line_end: 41 },
      { file: 'b.js', line_start: null, line_end: null },
      { file: 'changed.js', line_start: 5, line_end: 5 }
    ], { diffFiles: ['changed.js'], sourceClientId: 'tab-1' });

    expect(created).toBe(2);
    expect(rows()).toEqual([
      { file: 'a.js', line_start: 30, line_end: 51, label: 'Auto-added for suggestion' },
      { file: 'b.js', line_start: 1, line_end: 50, label: 'Auto-added for suggestion' }
    ]);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(`review:${reviewId}`, {
      type: 'review:context_files_changed', reviewId, sourceClientId: 'tab-1'
    });
  });

  it('skips dismissed findings and files that already have a panel', async () => {
    db.prepare('INSERT INTO context_files (review_id, file, line_start, line_end) VALUES (?, ?, ?, ?)')
      .run(reviewId, 'a.js', 1, 10);
    const created = await seedContextFilesForSuggestions(db, reviewId, [
      { file: 'a.js', line_start: 300, line_end: 300 },
      { file: 'b.js', line_start: 5, line_end: 5, status: 'dismissed' }
    ], { diffFiles: ['changed.js'] });

    expect(created).toBe(0);
    expect(rows()).toEqual([{ file: 'a.js', line_start: 1, line_end: 10, label: null }]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does nothing when the diff membership is unknown', async () => {
    expect(await seedContextFilesForSuggestions(db, reviewId, [{ file: 'a.js', line_start: 1 }], { diffFiles: [] })).toBe(0);
    expect(rows()).toEqual([]);
  });

  it('looks up the review diff when no diff files are given', async () => {
    db.prepare('INSERT INTO pr_metadata (pr_number, repository, pr_data) VALUES (?, ?, ?)')
      .run(1, 'test/repo', JSON.stringify({ changed_files: [{ file: 'changed.js' }] }));
    const created = await seedContextFilesForSuggestions(db, reviewId, [
      { file: 'changed.js', line_start: 1 }, { file: 'other.js', line_start: 1 }
    ]);
    expect(created).toBe(1);
    expect(rows().map(r => r.file)).toEqual(['other.js']);
  });

  it('returns 0 for an unknown review', async () => {
    expect(await seedContextFilesForSuggestions(db, 9999, [{ file: 'a.js' }], { diffFiles: ['x.js'] })).toBe(0);
  });
});

describe('ensureContextFile onePerFile', () => {
  let db, reviewId;

  beforeEach(() => {
    db = createTestDatabase();
    reviewId = seedTestReview(db);
  });

  afterEach(() => closeTestDatabase(db));

  it('creates an entry only when the file has none', async () => {
    const review = { id: reviewId };
    const first = await ensureContextFile(db, review, { file: 'a.js', line_start: 50, line_end: 50, diffFiles: ['x.js'], onePerFile: true });
    const second = await ensureContextFile(db, review, { file: 'a.js', line_start: 400, line_end: 400, diffFiles: ['x.js'], onePerFile: true });
    expect(first).toMatchObject({ created: true, expanded: false });
    expect(second).toEqual({ created: false, expanded: false });
    expect(db.prepare('SELECT line_start, line_end FROM context_files').all()).toEqual([{ line_start: 40, line_end: 60 }]);
  });

  it('is a no-op for a file in the diff, matched after normalization', async () => {
    const result = await ensureContextFile(db, { id: reviewId }, { file: './x.js', line_start: 1, diffFiles: ['x.js'], onePerFile: true });
    expect(result).toEqual({ created: false, expanded: false });
  });
});

describe('ContextFileRepository.addIfFileMissing', () => {
  let db, reviewId, repo;

  beforeEach(() => {
    db = createTestDatabase();
    reviewId = seedTestReview(db);
    repo = new ContextFileRepository(db);
  });

  afterEach(() => closeTestDatabase(db));

  it('inserts once per review and file', async () => {
    const inserted = await repo.addIfFileMissing(reviewId, 'a.js', 1, 20, 'label');
    expect(inserted).toEqual({ id: expect.any(Number) });
    expect(await repo.addIfFileMissing(reviewId, 'a.js', 30, 40, 'label')).toBeNull();
    expect(await repo.addIfFileMissing(reviewId, 'b.js', 30, 40)).toEqual({ id: expect.any(Number) });
    expect(db.prepare('SELECT file, line_start, line_end, label FROM context_files ORDER BY id').all()).toEqual([
      { file: 'a.js', line_start: 1, line_end: 20, label: 'label' },
      { file: 'b.js', line_start: 30, line_end: 40, label: null }
    ]);
  });
});
