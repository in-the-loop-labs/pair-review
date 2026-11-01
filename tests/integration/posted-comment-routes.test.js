// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
const express = require('express');
const { createTestDatabase, seedTestReview } = require('../utils/schema');
const { listenOnLoopback, closeServer } = require('../utils/loopback-server');
const { CommentRepository, CommentPostingRepository, GitHubReviewRepository } = require('../../src/database');
const { GitHubClient } = require('../../src/github/client');
const { GitWorktreeManager } = require('../../src/git/worktree');
const routes = require('../../src/routes/pr');
const originalUpdate = GitHubClient.prototype.updateReviewComment;

describe('publication action routes', () => {
  let db, server, reviewId, commentId, edit;
  beforeEach(async () => {
    db = createTestDatabase();
    reviewId = seedTestReview(db);
    const review = await new GitHubReviewRepository(db).create(reviewId, { state: 'submitted', github_review_id: '42' });
    commentId = await new CommentRepository(db).createLineComment({ review_id: reviewId, file: 'a.js', line_start: 1, body: 'edited' });
    await new CommentPostingRepository(db).insertMany([{ comment_id: commentId, github_review_row_id: review.id, comment_body: 'before', body: 'before', file: 'a.js', line_start: 1, line_end: 1, github_comment_node_id: 'C' }]);
    vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue('/unused/mock-worktree');
    vi.spyOn(GitWorktreeManager.prototype, 'generateUnifiedDiff').mockResolvedValue('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n');
    // Assigned rather than vi.mock: production imports real CommonJS methods.
    edit = vi.fn(async () => ({}));
    GitHubClient.prototype.updateReviewComment = edit;
    const app = express(); app.use(express.json()); app.set('db', db); app.set('githubToken', 'fake-token'); app.use(routes);
    server = await listenOnLoopback(app);
  });
  afterEach(async () => { await closeServer(server); db.close(); vi.restoreAllMocks(); if (originalUpdate) GitHubClient.prototype.updateReviewComment = originalUpdate;
    else delete GitHubClient.prototype.updateReviewComment; });
  function endpoint(id = reviewId) { return `/api/reviews/${id}/comments/${commentId}/update-on-github`; }

  it('returns changed=false on successful edit and exposes history with post/update snapshots', async () => {
    const response = await request(server).post(endpoint()).send({});
    expect(response.status).toBe(200);
    expect(response.body.comment.publication.changed).toBe(false);
    const history = await request(server).get(`/api/reviews/${reviewId}/submissions`);
    expect(history.status).toBe(200);
    expect(history.body.submissions[0].postings.map(p => p.kind)).toEqual(['post', 'update']);
  });
  it.each([[404, 'not_found_on_github'], [403, 'forbidden'], [422, 'forbidden']])('reports host failure %s without recreating', async (status, code) => {
    edit.mockRejectedValue(Object.assign(new Error('Host refused edit'), { status }));
    const response = await request(server).post(endpoint()).send({});
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ code });
    expect(response.body.error).toContain('Nothing was posted.');
    expect(db.prepare('SELECT COUNT(*) n FROM comment_postings').get().n).toBe(1);
  });
  it.each([null, 404, 403, 422])('submitting a review never sends an edited posted comment, even after failed edit %s', async (failure) => {
    if (failure) {
      edit.mockRejectedValue(Object.assign(new Error('Host refused edit'), { status: failure }));
      await request(server).post(endpoint()).send({});
    }
    db.prepare('INSERT INTO pr_metadata (pr_number, repository, pr_data) VALUES (1, ?, ?)').run('test/repo', JSON.stringify({ node_id: 'PR' }));
    vi.spyOn(GitHubClient.prototype, 'getPendingReviewForUser').mockResolvedValue(null);
    const submit = vi.spyOn(GitHubClient.prototype, 'createReviewGraphQL').mockResolvedValue({ id: 'R2', databaseId: 43, comments_count: 0, postedComments: [] });
    const response = await request(server).post('/api/pr/test/repo/1/submit-review').send({ event: 'COMMENT', body: 'review summary' });
    expect(response.status).toBe(200);
    expect(submit.mock.calls[0][3]).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) n FROM comment_postings').get().n).toBe(1);
    expect((await new CommentRepository(db).getComment(commentId)).publication.changed).toBe(true);
  });

  it('validates review ownership before any host operation', async () => {
    expect((await request(server).post(endpoint(reviewId + 1)).send({})).status).toBe(404);
    expect(edit).not.toHaveBeenCalled();
  });
  it('has no publication/history in local mode', async () => {
    db.prepare("UPDATE reviews SET review_type = 'local', pr_number = NULL WHERE id = ?").run(reviewId);
    expect((await request(server).post(endpoint()).send({})).status).toBe(400);
    expect((await request(server).get(`/api/reviews/${reviewId}/submissions`)).status).toBe(400);
    expect(edit).not.toHaveBeenCalled();
  });
});
