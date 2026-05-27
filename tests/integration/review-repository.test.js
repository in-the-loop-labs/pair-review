// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { ReviewRepository } = require('../../src/database');
const { createTestDatabase, closeTestDatabase } = require('../utils/schema');

/**
 * Integration coverage for ReviewRepository.associatePR.
 *
 * Phase 0 of the local/PR bridge writes PR associations onto local review
 * rows. Earlier coverage stubbed associatePR with vi.fn() — the SQL guards
 * (race condition, integer validation, review_type filter, COLLATE NOCASE
 * on getReviewByPR) were never exercised. This file uses a real SQLite
 * in-memory database so those guards are tested end-to-end.
 *
 * Also covers the cross-mode regression test from issue #1: a local review
 * with an associated PR and a separate PR-mode review for the same PR
 * must NOT collide on getReviewByPR(prNumber, repository).
 */
describe('ReviewRepository.associatePR (integration)', () => {
  let db;
  let repo;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new ReviewRepository(db);
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  function insertLocalReview() {
    const result = db.prepare(`
      INSERT INTO reviews (repository, status, review_type, local_path, local_head_sha)
      VALUES ('placeholder', 'draft', 'local', '/tmp/some-path', 'sha123')
    `).run();
    return Number(result.lastInsertRowid);
  }

  function insertPRReview(prNumber = 7, repository = 'owner/repo') {
    const result = db.prepare(`
      INSERT INTO reviews (pr_number, repository, status, review_type)
      VALUES (?, ?, 'draft', 'pr')
    `).run(prNumber, repository);
    return Number(result.lastInsertRowid);
  }

  function readRow(id) {
    return db.prepare(`
      SELECT associated_pr_number, associated_pr_repository, pr_number, repository
      FROM reviews WHERE id = ?
    `).get(id);
  }

  it('writes prNumber + repository to associated_pr_* columns (not pr_number)', async () => {
    const id = insertLocalReview();
    const ok = await repo.associatePR(id, { prNumber: 42, repository: 'owner/repo' });

    expect(ok).toBe(true);
    const row = readRow(id);
    expect(row.associated_pr_number).toBe(42);
    expect(row.associated_pr_repository).toBe('owner/repo');
    // Critically: pr_number remains NULL so the PR natural key stays clean.
    expect(row.pr_number).toBeNull();
  });

  it('race guard: second call returns false and does NOT overwrite first association', async () => {
    const id = insertLocalReview();

    const first = await repo.associatePR(id, { prNumber: 9, repository: 'a/b' });
    const second = await repo.associatePR(id, { prNumber: 99, repository: 'x/y' });

    expect(first).toBe(true);
    expect(second).toBe(false);
    const row = readRow(id);
    expect(row.associated_pr_number).toBe(9);
    expect(row.associated_pr_repository).toBe('a/b');
  });

  it('rejects non-integer prNumber inputs without mutation', async () => {
    const id = insertLocalReview();
    const beforeRow = readRow(id);

    expect(await repo.associatePR(id, { prNumber: '5', repository: 'a/b' })).toBe(false);
    expect(await repo.associatePR(id, { prNumber: 1.5, repository: 'a/b' })).toBe(false);
    expect(await repo.associatePR(id, { prNumber: NaN, repository: 'a/b' })).toBe(false);
    expect(await repo.associatePR(id, { prNumber: -1, repository: 'a/b' })).toBe(false);
    expect(await repo.associatePR(id, { prNumber: 0, repository: 'a/b' })).toBe(false);
    expect(await repo.associatePR(id, { prNumber: null, repository: 'a/b' })).toBe(false);

    const afterRow = readRow(id);
    expect(afterRow.associated_pr_number).toBe(beforeRow.associated_pr_number);
    expect(afterRow.associated_pr_number).toBeNull();
  });

  it('rejects empty / non-string repository inputs without mutation', async () => {
    const id = insertLocalReview();

    expect(await repo.associatePR(id, { prNumber: 1, repository: '' })).toBe(false);
    expect(await repo.associatePR(id, { prNumber: 1, repository: null })).toBe(false);
    expect(await repo.associatePR(id, { prNumber: 1, repository: 42 })).toBe(false);

    expect(readRow(id).associated_pr_number).toBeNull();
  });

  it('does NOT update PR-mode rows (review_type filter)', async () => {
    const prId = insertPRReview(7, 'owner/repo');
    const ok = await repo.associatePR(prId, { prNumber: 8, repository: 'owner/repo' });

    expect(ok).toBe(false);
    const row = readRow(prId);
    expect(row.associated_pr_number).toBeNull();
    expect(row.associated_pr_repository).toBeNull();
    // PR-mode row's natural-key columns stay untouched too.
    expect(row.pr_number).toBe(7);
    expect(row.repository).toBe('owner/repo');
  });
});

describe('getReviewByPR cross-mode isolation', () => {
  let db;
  let repo;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new ReviewRepository(db);
  });

  afterEach(() => closeTestDatabase(db));

  it('returns the PR-mode row, never a local row that points at the same PR', async () => {
    // Seed a local review associated with PR 42 in owner/repo.
    const localResult = db.prepare(`
      INSERT INTO reviews
        (repository, status, review_type, local_path, local_head_sha,
         associated_pr_number, associated_pr_repository)
      VALUES ('placeholder', 'draft', 'local', '/tmp/local', 'sha-local', 42, 'owner/repo')
    `).run();
    const localId = Number(localResult.lastInsertRowid);

    // Separately seed a real PR-mode review for the same PR.
    const prResult = db.prepare(`
      INSERT INTO reviews (pr_number, repository, status, review_type)
      VALUES (42, 'owner/repo', 'draft', 'pr')
    `).run();
    const prId = Number(prResult.lastInsertRowid);

    const found = await repo.getReviewByPR(42, 'owner/repo');
    expect(found).not.toBeNull();
    expect(found.id).toBe(prId);
    expect(found.id).not.toBe(localId);
  });

  it('returns null when only a local review references the PR (no PR-mode row exists)', async () => {
    db.prepare(`
      INSERT INTO reviews
        (repository, status, review_type, local_path, local_head_sha,
         associated_pr_number, associated_pr_repository)
      VALUES ('placeholder', 'draft', 'local', '/tmp/local', 'sha-local', 42, 'owner/repo')
    `).run();

    const found = await repo.getReviewByPR(42, 'owner/repo');
    expect(found).toBeNull();
  });
});
