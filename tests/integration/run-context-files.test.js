// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const { run, query, CommentRepository } = require('../../src/database');
const ws = require('../../src/ws');
const reviewsRoutes = require('../../src/routes/reviews');

const DIFF = 'diff --git a/changed.js b/changed.js\n--- a/changed.js\n+++ b/changed.js\n@@ -1 +1 @@\n-before\n+after\n';

describe.each(['pr', 'local'])('POST /api/reviews/:reviewId/analysis-runs/:runId/context-files (%s)', mode => {
  let db, server, reviewId, broadcastSpy;

  beforeEach(async () => {
    db = createTestDatabase();
    if (mode === 'pr') {
      await run(db, 'INSERT INTO pr_metadata (pr_number, repository, pr_data) VALUES (?, ?, ?)',
        [1, 'owner/repo', JSON.stringify({ diff: DIFF, changed_files: [{ file: 'changed.js' }] })]);
      reviewId = (await run(db, `INSERT INTO reviews (pr_number, repository, review_type, status)
        VALUES (1, 'owner/repo', 'pr', 'draft')`)).lastID;
    } else {
      reviewId = (await run(db, `INSERT INTO reviews (repository, review_type, local_path, local_head_sha, status)
        VALUES ('owner/repo', 'local', '/nonexistent/repo', 'head', 'draft')`)).lastID;
      await run(db, 'INSERT INTO local_diffs (review_id, diff_text) VALUES (?, ?)', [reviewId, DIFF]);
    }
    await run(db, 'INSERT INTO analysis_runs (id, review_id, status) VALUES (?, ?, ?)', ['parent', reviewId, 'completed']);
    await run(db, 'INSERT INTO analysis_runs (id, review_id, status, parent_run_id) VALUES (?, ?, ?, ?)',
      ['voice', reviewId, 'completed', 'parent']);
    const repo = new CommentRepository(db);
    await repo.bulkInsertAISuggestions(reviewId, 'voice', [
      { file: 'helper.js', line_start: 40, line_end: 41, old_or_new: 'NEW', type: 'bug', title: 'Later', description: 'd' },
      { file: 'helper.js', line_start: 12, line_end: 12, old_or_new: 'NEW', type: 'bug', title: 'First', description: 'd' },
      { file: 'changed.js', line_start: 1, line_end: 1, old_or_new: 'NEW', type: 'bug', title: 'In diff', description: 'd' },
      { file: 'dismissed.js', line_start: 5, line_end: 5, old_or_new: 'NEW', type: 'bug', title: 'Dismissed', description: 'd' }
    ]);
    // Intermediate-level finding: not a final finding of the run
    await repo.bulkInsertAISuggestions(reviewId, 'voice', [
      { file: 'level.js', line_start: 5, line_end: 5, old_or_new: 'NEW', type: 'bug', title: 'Level 3', description: 'd' }
    ], 3);
    await run(db, "UPDATE comments SET status = 'dismissed' WHERE file = 'dismissed.js'");

    broadcastSpy = vi.spyOn(ws, 'broadcast').mockImplementation(() => {});
    const app = express();
    app.use(express.json());
    app.set('db', db);
    app.use(reviewsRoutes);
    server = await listenOnLoopback(app);
  });

  afterEach(async () => {
    await closeServer(server);
    broadcastSpy.mockRestore();
    closeTestDatabase(db);
  });

  const post = runId => request(server)
    .post(`/api/reviews/${reviewId}/analysis-runs/${runId}/context-files`)
    .set('X-Client-Id', 'tab-1');

  it('opens one panel per unchanged file of the voice and is idempotent', async () => {
    const first = await post('voice');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ success: true, created: 1 });
    expect(await query(db, 'SELECT file, line_start, line_end, label FROM context_files')).toEqual([
      { file: 'helper.js', line_start: 2, line_end: 22, label: 'Auto-added for suggestion' }
    ]);
    expect(broadcastSpy).toHaveBeenCalledExactlyOnceWith(`review:${reviewId}`, {
      type: 'review:context_files_changed', reviewId, sourceClientId: 'tab-1'
    });

    const second = await post('voice');
    expect(second.body).toEqual({ success: true, created: 0 });
    expect(await query(db, 'SELECT * FROM context_files')).toHaveLength(1);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for a run of another review or an unknown run', async () => {
    const other = (await run(db, `INSERT INTO reviews (repository, review_type, local_path, status)
      VALUES ('o/r', 'local', '/elsewhere', 'draft')`)).lastID;
    await run(db, 'INSERT INTO analysis_runs (id, review_id, status) VALUES (?, ?, ?)', ['foreign', other, 'completed']);
    expect((await post('foreign')).status).toBe(404);
    expect((await post('missing')).status).toBe(404);
    expect(await query(db, 'SELECT * FROM context_files')).toEqual([]);
  });

  it('leaves GET /suggestions read-only', async () => {
    const response = await request(server).get(`/api/reviews/${reviewId}/suggestions?runId=voice`);
    expect(response.status).toBe(200);
    expect(response.body.suggestions.length).toBeGreaterThan(0);
    expect(await query(db, 'SELECT * FROM context_files')).toEqual([]);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });
});
