// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const Database = require('better-sqlite3');
const { createTestDatabase, seedTestReview } = require('../utils/schema');
const { CommentRepository, CommentPostingRepository, GitHubReviewRepository, MIGRATIONS } = require('../../src/database');
const { updatePostedComment, matchesPosting, listSubmissions } = require('../../src/github/update-posted-comment');

describe('posted comment updates never recreate', () => {
  let db, reviewId, commentId, review, client, postings;
  beforeEach(async () => {
    db = createTestDatabase();
    reviewId = seedTestReview(db);
    review = await new GitHubReviewRepository(db).create(reviewId, { state: 'submitted', github_review_id: '42', github_node_id: 'R', github_url: 'https://example.test/r' });
    commentId = await new CommentRepository(db).createLineComment({ review_id: reviewId, file: 'a.js', line_start: 8, body: 'edited' });
    postings = new CommentPostingRepository(db);
    await postings.insertMany([{ comment_id: commentId, github_review_row_id: review.id, comment_body: 'before', body: 'before', file: 'a.js', line_start: 8, line_end: 8, side: 'RIGHT', github_comment_id: '123', github_comment_node_id: 'C' }]);
    client = { features: { review_comment_edit: 'graphql' }, getAuthenticatedUser: vi.fn(async () => ({ login: 'me' })),
      listCommentsForReview: vi.fn(async () => []), listReviewComments: vi.fn(async () => []), updateReviewComment: vi.fn(async () => ({})),
      addCommentsInBatches: vi.fn(() => { throw new Error('must never create'); }), createReviewGraphQL: vi.fn(() => { throw new Error('must never create'); }) };
  });
  afterEach(() => { db.close(); });
  const candidate = (extra = {}) => ({ id: 123, node_id: 'C', body: 'before', path: 'a.js', user: { login: 'me' }, line: 8, start_line: null, original_line: 8, original_start_line: null, side: 'RIGHT', start_side: null, ...extra });
  function update(afterCommit) { return updatePostedComment(db, { commentId, githubClient: client, owner: 'o', repo: 'r', pull_number: 1 }, afterCommit); }
  function assertNoCreate() { expect(client.addCommentsInBatches).not.toHaveBeenCalled(); expect(client.createReviewGraphQL).not.toHaveBeenCalled(); }

  it('updates the same identity, stores an edit snapshot and broadcasts only after commit', async () => {
    expect((await new CommentRepository(db).getComment(commentId)).publication.changed).toBe(true);
    client.updateReviewComment.mockImplementation(async () => { expect(db.inTransaction).toBe(false); });
    const broadcast = vi.fn(() => { expect(db.inTransaction).toBe(false); expect(db.prepare("SELECT kind FROM comment_postings ORDER BY id DESC LIMIT 1").get().kind).toBe('update'); });
    const result = await update(broadcast);
    expect(result.publication.changed).toBe(false);
    expect(client.updateReviewComment).toHaveBeenCalledWith(expect.objectContaining({ github_comment_node_id: 'C' }), 'edited');
    expect((await postings.listByComment(commentId))[1]).toMatchObject({ kind: 'update', comment_body: 'edited', body: 'edited', github_comment_id: '123', github_review_row_id: review.id });
    expect(broadcast).toHaveBeenCalledWith(reviewId);
    assertNoCreate();
  });

  it('passes a known numeric-only id to the adapter and records its resolved node id', async () => {
    db.prepare('UPDATE comment_postings SET github_comment_node_id = NULL').run();
    client.updateReviewComment.mockResolvedValue({ github_comment_id: '123', github_comment_node_id: 'RESOLVED' });
    await update();
    expect(client.listCommentsForReview).not.toHaveBeenCalled();
    expect((await postings.listByComment(commentId)).every(p => p.github_comment_node_id === 'RESOLVED')).toBe(true);
    assertNoCreate();
  });

  it('edits pending-draft comments in place as well', async () => {
    db.prepare("UPDATE github_reviews SET state = 'pending'").run();
    expect((await update()).publication).toMatchObject({ state: 'draft', changed: false });
    assertNoCreate();
  });

  it('keeps an inline edit plain even when its line is no longer in the current diff', async () => {
    await update();
    expect(client.updateReviewComment.mock.calls[0][1]).toBe('edited');
    expect((await postings.listByComment(commentId))[1]).toMatchObject({ body: 'edited', is_file_level: 0, line_start: 8, line_end: 8 });
  });

  it.each([[8, 8, '(Ref Line 8) edited'], [8, 10, '(Ref Lines 8-10) edited']])('keeps file-fallback line references %s-%s even if a new diff could anchor them inline', async (start, end, expected) => {
    db.prepare('UPDATE comments SET line_start = ?, line_end = ? WHERE id = ?').run(start, end, commentId);
    db.prepare('UPDATE comment_postings SET is_file_level = 1, line_start = NULL, line_end = NULL').run();
    await update();
    expect(client.updateReviewComment.mock.calls[0][1]).toBe(expected);
    expect((await postings.listByComment(commentId))[1]).toMatchObject({ body: expected, is_file_level: 1, line_start: null, line_end: null });
  });

  it('keeps explicit file comments unprefixed', async () => {
    db.prepare('UPDATE comments SET is_file_level = 1 WHERE id = ?').run(commentId);
    db.prepare('UPDATE comment_postings SET is_file_level = 1, line_start = NULL, line_end = NULL').run();
    await update();
    expect(client.updateReviewComment.mock.calls[0][1]).toBe('edited');
  });

  it('recovers exactly one strict match from the correct review, repairs all postings, then updates', async () => {
    db.prepare('UPDATE comment_postings SET github_comment_node_id = NULL, github_comment_id = NULL').run();
    client.listCommentsForReview.mockResolvedValue([candidate({ line: 18 }), candidate({ in_reply_to_id: 99 })]);
    await update();
    expect(client.listCommentsForReview).toHaveBeenCalledWith(expect.objectContaining({ github_review_id: '42', github_node_id: 'R' }));
    expect(client.listReviewComments).not.toHaveBeenCalled();
    expect((await postings.listByComment(commentId)).every(p => p.github_comment_id === '123' && p.github_comment_node_id === 'C')).toBe(true);
    assertNoCreate();
  });

  it('recovers unpublished comments from their pending review, not the PR-wide list', async () => {
    db.prepare("UPDATE github_reviews SET state = 'pending'").run();
    db.prepare('UPDATE comment_postings SET github_comment_node_id = NULL, github_comment_id = NULL').run();
    client.listCommentsForReview.mockResolvedValue([candidate()]);
    await update();
    expect(client.listReviewComments).not.toHaveBeenCalled();
    assertNoCreate();
  });

  it('leaves a repaired identity intact after a failed update without recreating', async () => {
    db.prepare('UPDATE comment_postings SET github_comment_node_id = NULL, github_comment_id = NULL').run();
    client.listCommentsForReview.mockResolvedValue([candidate()]);
    client.updateReviewComment.mockRejectedValue(Object.assign(new Error('denied'), { status: 403 }));
    await expect(update()).rejects.toMatchObject({ status: 403 });
    expect((await postings.listByComment(commentId))[0].github_comment_node_id).toBe('C');
    expect((await new CommentRepository(db).getComment(commentId)).publication.changed).toBe(true);
    assertNoCreate();
  });

  it('abstains rather than searching a PR-wide list for an untrusted pending review', async () => {
    db.prepare("UPDATE github_reviews SET state = 'pending'").run();
    db.prepare('UPDATE comment_postings SET github_comment_node_id = NULL, github_comment_id = NULL, backfilled = 1').run();
    await expect(update()).rejects.toMatchObject({ code: 'unresolved_identity' });
    expect(client.listReviewComments).not.toHaveBeenCalled();
    expect(client.updateReviewComment).not.toHaveBeenCalled();
    assertNoCreate();
  });

  it.each(['rest', 'host'])('recovers a missing numeric id for %s updates', async (mode) => {
    client.features.review_comment_edit = mode;
    db.prepare('UPDATE comment_postings SET github_comment_node_id = NULL, github_comment_id = NULL').run();
    client.listCommentsForReview.mockResolvedValue([candidate()]);
    await update();
    expect(client.updateReviewComment).toHaveBeenCalledWith(expect.objectContaining({ github_comment_id: '123' }), 'edited');
    assertNoCreate();
  });

  it('falls back to PR-wide comments only for an untrusted legacy review link', async () => {
    db.prepare('UPDATE comment_postings SET github_comment_node_id = NULL, github_comment_id = NULL, backfilled = 1').run();
    client.listReviewComments.mockResolvedValue([candidate()]);
    await update();
    expect(client.listReviewComments).toHaveBeenCalled();
    expect(client.listCommentsForReview).not.toHaveBeenCalled();
  });

  it.each([[], [candidate(), candidate()], [candidate({ body: 'before\r\n' })], [candidate({ body: 'before ' })], [candidate({ body: '```suggestion\nbefore\n```' })], [candidate({ user: { login: 'other' } })]].map(candidates => ({ candidates })))('abstains on zero, ambiguous or inexact matches: %j', async ({ candidates }) => {
    db.prepare('UPDATE comment_postings SET github_comment_node_id = NULL, github_comment_id = NULL').run();
    client.listCommentsForReview.mockResolvedValue(candidates);
    await expect(update()).rejects.toMatchObject({ status: 409, review_url: 'https://example.test/r' });
    expect(client.updateReviewComment).not.toHaveBeenCalled();
    expect(await postings.listByComment(commentId)).toHaveLength(1);
    expect((await new CommentRepository(db).getComment(commentId)).publication.changed).toBe(true);
    assertNoCreate();
  });

  it.each([404, 403, 422])('keeps edited comments non-pending on update rejection %s', async (status) => {
    client.updateReviewComment.mockRejectedValue(Object.assign(new Error('host rejected edit'), { status }));
    const broadcast = vi.fn();
    await expect(update(broadcast)).rejects.toMatchObject({ status });
    expect(broadcast).not.toHaveBeenCalled();
    expect(await postings.listByComment(commentId)).toHaveLength(1);
    expect(db.prepare(`SELECT id FROM comments c WHERE ${CommentRepository.pendingCommentSql()}`).all()).toEqual([]);
    expect((await new CommentRepository(db).getComment(commentId)).publication.changed).toBe(true);
    assertNoCreate();
  });

  it('groups duplicate legacy submissions and includes edits and current dismissed lifecycle', async () => {
    const duplicate = await new GitHubReviewRepository(db).create(reviewId, { state: 'submitted', github_node_id: 'R', github_review_id: '42' });
    await update();
    db.prepare("UPDATE comments SET status = 'inactive' WHERE id = ?").run(commentId);
    const result = await listSubmissions(db, reviewId);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(duplicate.id);
    expect(result[0].postings.map(p => p.kind)).toEqual(['post', 'update']);
    expect(result[0].postings.every(p => p.comment_status === 'inactive')).toBe(true);
  });
});

describe('strict sent anchor identity', () => {
  const posting = { file: 'a.js', body: 'exact\r\n ', line_start: 8, line_end: 10, side: 'LEFT' };
  const comment = { path: 'a.js', body: 'exact\r\n ', user: { login: 'ME' }, line: 10, start_line: 8, original_line: 10, original_start_line: 8, side: 'LEFT', start_side: 'LEFT' };
  it('matches exact range, original outdated anchors, and explicit file subjects', () => {
    expect(matchesPosting(comment, posting, 'me')).toBe(true);
    expect(matchesPosting({ ...comment, line: 40, start_line: 38 }, posting, 'me')).toBe(true);
    expect(matchesPosting({ ...comment, line: null, start_line: null, original_line: 10, original_start_line: 8 }, posting, 'me')).toBe(true);
    expect(matchesPosting({ ...comment, subject_type: 'file' }, { ...posting, is_file_level: 1 }, 'me')).toBe(true);
    expect(matchesPosting({ ...comment, line: null, subject_type: undefined }, { ...posting, is_file_level: 1 }, 'me')).toBe(false);
  });
  it.each([{ side: 'RIGHT' }, { start_side: 'RIGHT' }, { original_start_line: null }, { original_line: 9 }, { in_reply_to_id: 123 }, { path: 'b.js' }, { body: 'exact\n ' }])('rejects a changed identity %j', (change) => {
    expect(matchesPosting({ ...comment, ...change }, posting, 'me')).toBe(false);
  });
});

it('v57 → v58 adds kind without rewriting or losing history; migration is repeatable', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE comment_postings (id INTEGER PRIMARY KEY, body TEXT NOT NULL); INSERT INTO comment_postings VALUES (1, \'original\')');
    MIGRATIONS[58](db);
    MIGRATIONS[58](db);
    expect(db.prepare('SELECT * FROM comment_postings').all()).toEqual([{ id: 1, body: 'original', kind: 'post' }]);
    expect(() => db.prepare("INSERT INTO comment_postings (body, kind) VALUES ('bad', 'repost')").run()).toThrow();
  } finally { db.close(); }
});
