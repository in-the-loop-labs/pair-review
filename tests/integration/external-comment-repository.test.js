// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema';

const { ExternalCommentRepository } = require('../../src/database');

/**
 * Build a mappedRow object with sensible defaults for tests.
 * Callers override only the fields they care about.
 */
function makeRow(overrides = {}) {
  return {
    external_id: '1',
    in_reply_to_id: null,
    external_url: 'https://github.com/owner/repo/pull/1#discussion_r1',
    author: 'octocat',
    author_url: 'https://github.com/octocat',
    file: 'src/app.js',
    side: 'RIGHT',
    line_start: 10,
    line_end: 10,
    diff_position: 5,
    commit_sha: 'abc1234',
    is_outdated: false,
    original_line_start: 10,
    original_line_end: 10,
    original_commit_sha: 'abc1234',
    body: 'Looks good!',
    external_created_at: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

describe('ExternalCommentRepository', () => {
  let db;
  let repo;
  let reviewId;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new ExternalCommentRepository(db);
    reviewId = seedTestReview(db);
  });

  afterEach(() => {
    if (db) {
      closeTestDatabase(db);
    }
  });

  // ----- upsert: insert path -----

  describe('upsert insert path', () => {
    it('inserts a new row and returns its local id with synced_at set and parent_id null', async () => {
      const before = new Date().toISOString();
      const id = await repo.upsert(reviewId, 'github', makeRow({
        external_id: '101',
        body: 'first comment'
      }));
      const after = new Date().toISOString();

      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);

      const row = db.prepare('SELECT * FROM external_comments WHERE id = ?').get(id);
      expect(row).toBeTruthy();
      expect(row.review_id).toBe(reviewId);
      expect(row.source).toBe('github');
      expect(row.external_id).toBe('101');
      expect(row.body).toBe('first comment');
      expect(row.parent_id).toBeNull();
      expect(row.author).toBe('octocat');
      expect(row.file).toBe('src/app.js');
      expect(row.line_start).toBe(10);
      expect(row.line_end).toBe(10);
      expect(row.is_outdated).toBe(0);
      // synced_at is an ISO timestamp within the test window
      expect(row.synced_at).toBeTruthy();
      expect(row.synced_at >= before).toBe(true);
      expect(row.synced_at <= after).toBe(true);
    });

    it('coerces external_id to a string (GitHub returns numeric ids)', async () => {
      // eslint-disable-next-line no-undef
      const id = await repo.upsert(reviewId, 'github', makeRow({ external_id: 12345 }));
      const row = db.prepare('SELECT external_id FROM external_comments WHERE id = ?').get(id);
      expect(row.external_id).toBe('12345');
    });

    it('marks outdated rows correctly and tolerates null current anchors', async () => {
      const id = await repo.upsert(reviewId, 'github', makeRow({
        external_id: '200',
        is_outdated: true,
        line_start: null,
        line_end: null,
        diff_position: null,
        original_line_start: 5,
        original_line_end: 5
      }));
      const row = db.prepare('SELECT * FROM external_comments WHERE id = ?').get(id);
      expect(row.is_outdated).toBe(1);
      expect(row.line_start).toBeNull();
      expect(row.line_end).toBeNull();
      expect(row.original_line_start).toBe(5);
    });

    it('persists is_file_level = 1 with all line anchors null for file-level rows', async () => {
      const id = await repo.upsert(reviewId, 'github', makeRow({
        external_id: '300',
        is_file_level: 1,
        line_start: null,
        line_end: null,
        diff_position: null,
        original_line_start: null,
        original_line_end: null
      }));
      const row = db.prepare('SELECT * FROM external_comments WHERE id = ?').get(id);
      expect(row.is_file_level).toBe(1);
      expect(row.line_start).toBeNull();
      expect(row.line_end).toBeNull();
      expect(row.diff_position).toBeNull();
      // A file-level comment is never outdated.
      expect(row.is_outdated).toBe(0);
    });

    it('defaults is_file_level to 0 when the adapter omits it', async () => {
      const id = await repo.upsert(reviewId, 'github', makeRow({ external_id: '301' }));
      const row = db.prepare('SELECT is_file_level FROM external_comments WHERE id = ?').get(id);
      expect(row.is_file_level).toBe(0);
    });
  });

  // ----- upsert: update path -----

  describe('upsert update path', () => {
    it('re-upserting the same (review_id, source, external_id) keeps the same id and updates fields', async () => {
      const id1 = await repo.upsert(reviewId, 'github', makeRow({
        external_id: '500',
        body: 'original body',
        is_outdated: false
      }));

      const id2 = await repo.upsert(reviewId, 'github', makeRow({
        external_id: '500',
        body: 'edited body',
        is_outdated: true,
        line_start: null,
        line_end: null
      }));

      expect(id2).toBe(id1);

      const row = db.prepare('SELECT * FROM external_comments WHERE id = ?').get(id1);
      expect(row.body).toBe('edited body');
      expect(row.is_outdated).toBe(1);
      expect(row.line_start).toBeNull();

      const total = db.prepare(
        'SELECT COUNT(*) AS c FROM external_comments WHERE review_id = ? AND source = ?'
      ).get(reviewId, 'github').c;
      expect(total).toBe(1);
    });

    it('repairs a mis-synced line-anchored row into a file-level row on refresh', async () => {
      // Regression: a file-level comment was previously stored as a line-1
      // annotation (is_file_level=0, line_start/line_end/diff_position=1). A
      // manual refresh must overwrite BOTH the flag AND the stale line fields
      // so the row moves to the zone — the ON CONFLICT UPDATE set includes
      // is_file_level and all line columns.
      const id1 = await repo.upsert(reviewId, 'github', makeRow({
        external_id: '700',
        is_file_level: 0,
        line_start: 1,
        line_end: 1,
        diff_position: 1,
        original_line_start: 1,
        original_line_end: 1
      }));

      const id2 = await repo.upsert(reviewId, 'github', makeRow({
        external_id: '700',
        is_file_level: 1,
        line_start: null,
        line_end: null,
        diff_position: null,
        original_line_start: null,
        original_line_end: null
      }));

      expect(id2).toBe(id1);
      const row = db.prepare('SELECT * FROM external_comments WHERE id = ?').get(id1);
      expect(row.is_file_level).toBe(1);
      expect(row.line_start).toBeNull();
      expect(row.line_end).toBeNull();
      expect(row.diff_position).toBeNull();
    });

    it('does not overwrite parent_id during update', async () => {
      // First insert a row
      const id = await repo.upsert(reviewId, 'github', makeRow({ external_id: '600' }));
      // Manually set parent_id to mimic resolveParents having run
      db.prepare('UPDATE external_comments SET parent_id = ? WHERE id = ?').run(id, id);

      // Re-upsert with different fields
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: '600',
        body: 'updated'
      }));

      const row = db.prepare('SELECT parent_id, body FROM external_comments WHERE id = ?').get(id);
      // parent_id should be preserved (not reset to null)
      expect(row.parent_id).toBe(id);
      expect(row.body).toBe('updated');
    });
  });

  // ----- resolveParents -----

  describe('resolveParents', () => {
    it('resolves parent_id for a reply pointing to a sibling and returns count 1', async () => {
      const rootId = await repo.upsert(reviewId, 'github', makeRow({
        external_id: '10',
        in_reply_to_id: null,
        external_created_at: '2026-01-01T00:00:00Z'
      }));
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: '11',
        in_reply_to_id: '10',
        external_created_at: '2026-01-02T00:00:00Z'
      }));

      const count = await repo.resolveParents(reviewId, 'github');
      expect(count).toBe(1);

      const reply = db.prepare(
        'SELECT parent_id FROM external_comments WHERE review_id = ? AND source = ? AND external_id = ?'
      ).get(reviewId, 'github', '11');
      expect(reply.parent_id).toBe(rootId);
    });

    it('is idempotent: running twice does not change anything beyond the first run', async () => {
      const rootId = await repo.upsert(reviewId, 'github', makeRow({ external_id: '20' }));
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: '21',
        in_reply_to_id: '20'
      }));

      const first = await repo.resolveParents(reviewId, 'github');
      const second = await repo.resolveParents(reviewId, 'github');

      expect(first).toBe(1);
      expect(second).toBe(1);

      const reply = db.prepare(
        'SELECT parent_id FROM external_comments WHERE review_id = ? AND source = ? AND external_id = ?'
      ).get(reviewId, 'github', '21');
      expect(reply.parent_id).toBe(rootId);
    });

    it('leaves parent_id NULL and returns 0 for orphan replies (no matching sibling)', async () => {
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: '30',
        in_reply_to_id: '999999' // no sibling has this external_id
      }));

      const count = await repo.resolveParents(reviewId, 'github');
      expect(count).toBe(0);

      const orphan = db.prepare(
        'SELECT parent_id FROM external_comments WHERE external_id = ?'
      ).get('30');
      expect(orphan.parent_id).toBeNull();
    });

    it('preserves a previously-resolved parent_id when the reply\'s in_reply_to_id no longer matches a sibling', async () => {
      // Regression: SQLite's correlated subquery returns NULL when no
      // sibling matches the in_reply_to_id. Without the EXISTS guard, the
      // UPDATE silently overwrites a previously-correct parent_id with
      // NULL. Scenario: two rows exist (parent + reply with linked
      // parent_id). The reply's in_reply_to_id then gets pointed at a
      // non-existent sibling (e.g. upstream re-keys the parent). Without
      // the guard the next resolveParents call would null out the linkage.
      const parentLocalId = await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'root-keep',
      }));
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'reply-keep',
        in_reply_to_id: 'root-keep',
        line_end: 11,
      }));

      // First resolveParents links the reply.
      await repo.resolveParents(reviewId, 'github');
      const linked = db.prepare(
        "SELECT parent_id FROM external_comments WHERE external_id = 'reply-keep'"
      ).get();
      expect(linked.parent_id).toBe(parentLocalId);

      // Now break the linkage: change the reply's in_reply_to_id to point
      // at an external_id that no longer matches any sibling in this
      // batch. The parent row still exists (its local id is still valid),
      // so parent_id stays referentially valid. The EXISTS guard prevents
      // resolveParents from overwriting it with NULL.
      db.prepare(
        "UPDATE external_comments SET in_reply_to_id = 'no-such-sibling' WHERE external_id = 'reply-keep'"
      ).run();

      const count = await repo.resolveParents(reviewId, 'github');
      // The reply still has a non-null parent_id (preserved by EXISTS guard).
      expect(count).toBe(1);

      const afterReply = db.prepare(
        "SELECT parent_id FROM external_comments WHERE external_id = 'reply-keep'"
      ).get();
      expect(afterReply.parent_id).toBe(parentLocalId);
    });

    it('does not cross review_ids or sources', async () => {
      const otherReviewId = seedTestReview(db, { prNumber: 2, repository: 'test/other' });

      // Root in reviewId/github
      await repo.upsert(reviewId, 'github', makeRow({ external_id: '40' }));
      // Reply lives in otherReviewId/github but points to external_id 40
      await repo.upsert(otherReviewId, 'github', makeRow({
        external_id: '41',
        in_reply_to_id: '40'
      }));
      // Reply lives in reviewId/gitlab but points to external_id 40
      await repo.upsert(reviewId, 'gitlab', makeRow({
        external_id: '42',
        in_reply_to_id: '40'
      }));

      // Resolve only for reviewId+github: neither cross-review nor cross-source reply should resolve
      const count = await repo.resolveParents(reviewId, 'github');
      expect(count).toBe(0);

      const crossReview = db.prepare(
        'SELECT parent_id FROM external_comments WHERE review_id = ? AND external_id = ?'
      ).get(otherReviewId, '41');
      expect(crossReview.parent_id).toBeNull();

      const crossSource = db.prepare(
        'SELECT parent_id FROM external_comments WHERE review_id = ? AND source = ? AND external_id = ?'
      ).get(reviewId, 'gitlab', '42');
      expect(crossSource.parent_id).toBeNull();
    });
  });

  // ----- listByReview -----

  describe('listByReview', () => {
    it('returns rows ordered by file, then COALESCE(line_end, original_line_end) NULLS LAST, then external_created_at', async () => {
      // file=b.js line=5 -> should come last (b.js sorts after a.js)
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'b-5',
        file: 'b.js',
        line_end: 5,
        external_created_at: '2026-01-01T00:00:00Z'
      }));
      // file=a.js line=20
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'a-20',
        file: 'a.js',
        line_end: 20,
        external_created_at: '2026-01-01T00:00:00Z'
      }));
      // file=a.js BOTH line_end AND original_line_end null (true lost
      // anchor) -> sinks to the bottom of its file group via NULLS LAST.
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'a-null',
        file: 'a.js',
        line_start: null,
        line_end: null,
        original_line_start: null,
        original_line_end: null,
        is_outdated: true,
        external_created_at: '2026-01-01T00:00:00Z'
      }));
      // file=a.js line=3 -> should be first
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'a-3',
        file: 'a.js',
        line_end: 3,
        external_created_at: '2026-01-01T00:00:00Z'
      }));
      // file=a.js line=3 (same line) but earlier created_at -> should beat a-3
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'a-3-early',
        file: 'a.js',
        line_end: 3,
        external_created_at: '2025-12-31T00:00:00Z'
      }));

      const rows = await repo.listByReview(reviewId);
      const ids = rows.map(r => r.external_id);
      expect(ids).toEqual(['a-3-early', 'a-3', 'a-20', 'a-null', 'b-5']);
    });

    it('sorts outdated rows by original_line_end via COALESCE, not at the bottom', async () => {
      // Regression: ORDER BY used `line_end` directly with "NULLs last",
      // so an outdated row with line_end=NULL but original_line_end=20
      // sank to the bottom of its file group regardless of which line it
      // was originally anchored to. COALESCE(line_end, original_line_end)
      // restores a sensible position for outdated discussions.
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'current-50',
        file: 'a.js',
        line_start: 50,
        line_end: 50,
        original_line_start: 50,
        original_line_end: 50,
      }));
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'outdated-20',
        file: 'a.js',
        line_start: null,
        line_end: null,
        is_outdated: true,
        original_line_start: 20,
        original_line_end: 20,
      }));

      const rows = await repo.listByReview(reviewId);
      // outdated-20 (effective anchor 20) sorts above current-50 (effective 50).
      expect(rows.map(r => r.external_id)).toEqual(['outdated-20', 'current-50']);
    });

    it('filters by source when source option is provided', async () => {
      await repo.upsert(reviewId, 'github', makeRow({ external_id: 'gh-1' }));
      await repo.upsert(reviewId, 'github', makeRow({ external_id: 'gh-2', line_end: 20 }));
      await repo.upsert(reviewId, 'gitlab', makeRow({ external_id: 'gl-1' }));

      const all = await repo.listByReview(reviewId);
      expect(all).toHaveLength(3);

      const githubOnly = await repo.listByReview(reviewId, { source: 'github' });
      expect(githubOnly).toHaveLength(2);
      expect(githubOnly.every(r => r.source === 'github')).toBe(true);

      const gitlabOnly = await repo.listByReview(reviewId, { source: 'gitlab' });
      expect(gitlabOnly).toHaveLength(1);
      expect(gitlabOnly[0].external_id).toBe('gl-1');
    });
  });

  // ----- listThreadsByReview -----

  describe('listThreadsByReview', () => {
    it('groups root + two replies into one thread, replies ordered by external_created_at', async () => {
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'root',
        in_reply_to_id: null,
        external_created_at: '2026-01-01T00:00:00Z'
      }));
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'reply-b',
        in_reply_to_id: 'root',
        external_created_at: '2026-01-03T00:00:00Z'
      }));
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'reply-a',
        in_reply_to_id: 'root',
        external_created_at: '2026-01-02T00:00:00Z'
      }));
      await repo.resolveParents(reviewId, 'github');

      const threads = await repo.listThreadsByReview(reviewId);
      expect(threads).toHaveLength(1);
      expect(threads[0].external_id).toBe('root');
      expect(threads[0].replies).toHaveLength(2);
      // Ordered by external_created_at ascending
      expect(threads[0].replies[0].external_id).toBe('reply-a');
      expect(threads[0].replies[1].external_id).toBe('reply-b');
    });

    it('returns standalone roots with replies: []', async () => {
      await repo.upsert(reviewId, 'github', makeRow({ external_id: 'solo' }));
      await repo.resolveParents(reviewId, 'github');

      const threads = await repo.listThreadsByReview(reviewId);
      expect(threads).toHaveLength(1);
      expect(threads[0].external_id).toBe('solo');
      expect(threads[0].replies).toEqual([]);
    });

    it('promotes orphan replies (parent_id pointing to a row not in result set) to standalone roots', async () => {
      // Simulate via the source filter: parent lives under source=gitlab but
      // the reply somehow points to it. resolveParents would not cross-source
      // resolve, but for the defensive-promotion test we directly set
      // parent_id to a row that won't appear in the filtered result set.
      const otherSourceId = await repo.upsert(reviewId, 'gitlab', makeRow({
        external_id: 'gl-root'
      }));
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'gh-reply',
        in_reply_to_id: 'gl-root'
      }));
      // Directly set parent_id to the gitlab row's local id. FK is satisfied
      // (the row exists), but it will not appear when we filter the listing
      // by source='github'.
      db.prepare(
        'UPDATE external_comments SET parent_id = ? WHERE external_id = ? AND source = ?'
      ).run(otherSourceId, 'gh-reply', 'github');

      // Filter by source=github so the parent is excluded → the reply should
      // be promoted to a standalone root.
      const threads = await repo.listThreadsByReview(reviewId, { source: 'github' });
      expect(threads).toHaveLength(1);
      expect(threads[0].external_id).toBe('gh-reply');
      expect(threads[0].replies).toEqual([]);
    });
  });

  // ----- countByReview -----

  describe('countByReview', () => {
    it('returns the total row count for review+source', async () => {
      await repo.upsert(reviewId, 'github', makeRow({ external_id: 'c1' }));
      await repo.upsert(reviewId, 'github', makeRow({ external_id: 'c2', line_end: 20 }));
      await repo.upsert(reviewId, 'gitlab', makeRow({ external_id: 'g1' }));

      expect(await repo.countByReview(reviewId, 'github')).toBe(2);
      expect(await repo.countByReview(reviewId, 'gitlab')).toBe(1);
      // No source filter → total across sources
      expect(await repo.countByReview(reviewId)).toBe(3);
    });

    it('returns 0 when no rows exist', async () => {
      expect(await repo.countByReview(reviewId, 'github')).toBe(0);
    });
  });

  // ----- Cascade delete -----

  describe('cascade on review delete', () => {
    it('removes external_comments rows when the parent review is deleted (FK ON DELETE CASCADE)', async () => {
      await repo.upsert(reviewId, 'github', makeRow({ external_id: 'd1' }));
      await repo.upsert(reviewId, 'github', makeRow({ external_id: 'd2', line_end: 22 }));

      const before = await repo.countByReview(reviewId, 'github');
      expect(before).toBe(2);

      db.prepare('DELETE FROM reviews WHERE id = ?').run(reviewId);

      const after = await repo.countByReview(reviewId, 'github');
      expect(after).toBe(0);

      const rawCount = db.prepare(
        'SELECT COUNT(*) AS c FROM external_comments WHERE review_id = ?'
      ).get(reviewId).c;
      expect(rawCount).toBe(0);
    });
  });

  // ----- Parent SET NULL on prune -----

  describe('deleteMissing preserves replies via ON DELETE SET NULL', () => {
    it('prunes a parent while keeping its reply, nulling parent_id; orphan-promotion surfaces the reply in listThreadsByReview', async () => {
      // Regression: parent_id used to CASCADE on delete, so when sync pruned a
      // parent comment that disappeared from the upstream snapshot it
      // silently destroyed every reply too — even replies that were still in
      // the snapshot. SET NULL preserves the reply; listThreadsByReview then
      // promotes it via orphan handling.
      const parentLocalId = await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'parent-1',
        body: 'parent comment'
      }));
      await repo.upsert(reviewId, 'github', makeRow({
        external_id: 'reply-1',
        in_reply_to_id: 'parent-1',
        body: 'reply still here',
        line_end: 11
      }));
      await repo.resolveParents(reviewId, 'github');

      // Sanity: reply.parent_id resolves to parent's local id before prune.
      const beforeReply = db.prepare(
        "SELECT * FROM external_comments WHERE external_id = 'reply-1'"
      ).get();
      expect(beforeReply.parent_id).toBe(parentLocalId);

      // Snapshot now contains only the reply — the parent is gone upstream.
      const deleted = await repo.deleteMissing(reviewId, 'github', ['reply-1']);
      expect(deleted).toBe(1);

      // Reply survives, parent_id nulled by SET NULL.
      const afterReply = db.prepare(
        "SELECT * FROM external_comments WHERE external_id = 'reply-1'"
      ).get();
      expect(afterReply).toBeTruthy();
      expect(afterReply.parent_id).toBeNull();
      expect(afterReply.body).toBe('reply still here');

      // Orphan-promotion: listThreadsByReview surfaces the reply as a thread root.
      const threads = await repo.listThreadsByReview(reviewId, { source: 'github' });
      expect(threads).toHaveLength(1);
      expect(threads[0].external_id).toBe('reply-1');
      expect(threads[0].replies).toEqual([]);
    });
  });
});
