// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase, seedTestReview } from '../utils/schema.js';

const database = require('../../src/database.js');
const { run, CommentRepository } = database;

const RUN_A = 'run-aaaa';
const RUN_B = 'run-bbbb';

/**
 * Insert an AI suggestion row with explicit control over the columns the
 * getFinalSuggestionsByRunId filter cares about.
 */
async function insertAiComment(db, overrides = {}) {
  const row = {
    review_id: 1,
    source: 'ai',
    ai_run_id: RUN_A,
    ai_level: null,
    ai_confidence: 0.9,
    file: 'src/a.js',
    line_start: 10,
    line_end: 12,
    type: 'bug',
    title: 'A title',
    body: 'A body',
    reasoning: null,
    status: 'active',
    is_file_level: 0,
    is_raw: 0,
    severity: 'high',
    ...overrides,
  };

  await run(db, `
    INSERT INTO comments (
      review_id, source, ai_run_id, ai_level, ai_confidence,
      file, line_start, line_end, type, title, body, reasoning,
      status, is_file_level, is_raw, severity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    row.review_id, row.source, row.ai_run_id, row.ai_level, row.ai_confidence,
    row.file, row.line_start, row.line_end, row.type, row.title, row.body, row.reasoning,
    row.status, row.is_file_level, row.is_raw, row.severity,
  ]);
}

describe('CommentRepository.getFinalSuggestionsByRunId', () => {
  let db;
  let commentRepo;

  beforeEach(async () => {
    db = await createTestDatabase();
    seedTestReview(db, { id: 1 });
    commentRepo = new CommentRepository(db);

    // Final consolidated suggestion for RUN_A (the one we expect back).
    await insertAiComment(db, {
      file: 'src/b.js', line_start: 5, title: 'Final B', ai_level: null, status: 'active',
    });
    // Another final consolidated suggestion for RUN_A, earlier file (ordering check).
    await insertAiComment(db, {
      file: 'src/a.js', line_start: 20, title: 'Final A', ai_level: null, status: 'active',
    });
    // Per-level (ai_level=1) row — must be excluded (not consolidated).
    await insertAiComment(db, {
      file: 'src/a.js', line_start: 1, title: 'Per-level', ai_level: 1, status: 'active',
    });
    // Raw row — must be excluded.
    await insertAiComment(db, {
      file: 'src/a.js', line_start: 2, title: 'Raw', ai_level: null, is_raw: 1, status: 'active',
    });
    // Dismissed final — excluded by default statuses.
    await insertAiComment(db, {
      file: 'src/a.js', line_start: 3, title: 'Dismissed', ai_level: null, status: 'dismissed',
    });
    // Adopted final — included by default statuses.
    await insertAiComment(db, {
      file: 'src/c.js', line_start: 7, title: 'Adopted', ai_level: null, status: 'adopted',
    });
    // Different run — must be excluded.
    await insertAiComment(db, {
      ai_run_id: RUN_B, file: 'src/a.js', line_start: 1, title: 'Other run', status: 'active',
    });
  });

  it('returns only the consolidated finals for the given run, ordered by file,line_start', async () => {
    const rows = await commentRepo.getFinalSuggestionsByRunId(RUN_A);

    // Default statuses = active + adopted; excludes per-level, raw, dismissed, other-run.
    expect(rows.map(r => r.title)).toEqual(['Final A', 'Final B', 'Adopted']);
    // All belong to RUN_A.
    expect(rows.every(r => r.ai_run_id === RUN_A)).toBe(true);
    // All are consolidated finals (ai_level NULL). The per-level/raw rows are
    // excluded by the filter (is_raw is a filter column, not a selected one).
    expect(rows.every(r => r.ai_level === null)).toBe(true);
  });

  it('returns the full rich column set', async () => {
    const rows = await commentRepo.getFinalSuggestionsByRunId(RUN_A);
    const expectedKeys = [
      'id', 'ai_run_id', 'ai_level', 'ai_confidence',
      'file', 'line_start', 'line_end', 'type', 'title', 'body',
      'reasoning', 'status', 'is_file_level', 'severity', 'created_at',
    ];
    expect(Object.keys(rows[0]).sort()).toEqual([...expectedKeys].sort());
  });

  it('respects an explicit single status filter', async () => {
    const adopted = await commentRepo.getFinalSuggestionsByRunId(RUN_A, { statuses: ['adopted'] });
    expect(adopted.map(r => r.title)).toEqual(['Adopted']);

    const dismissed = await commentRepo.getFinalSuggestionsByRunId(RUN_A, { statuses: ['dismissed'] });
    expect(dismissed.map(r => r.title)).toEqual(['Dismissed']);
  });

  it('respects a multi-status filter', async () => {
    const rows = await commentRepo.getFinalSuggestionsByRunId(RUN_A, {
      statuses: ['active', 'adopted', 'dismissed'],
    });
    expect(rows.map(r => r.title)).toEqual(['Dismissed', 'Final A', 'Final B', 'Adopted']);
  });

  it('respects the file filter', async () => {
    const rows = await commentRepo.getFinalSuggestionsByRunId(RUN_A, { file: 'src/a.js' });
    expect(rows.map(r => r.title)).toEqual(['Final A']);
  });

  it('returns an empty array for an unknown run', async () => {
    const rows = await commentRepo.getFinalSuggestionsByRunId('does-not-exist');
    expect(rows).toEqual([]);
  });
});
