// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

const {
  getAssociatedPR,
  getPRContext,
  buildCapabilities,
  splitRepository
} = require('../../src/providers/pr-context');

describe('splitRepository', () => {
  it('returns null for falsy or non-string inputs', () => {
    expect(splitRepository(null)).toBeNull();
    expect(splitRepository(undefined)).toBeNull();
    expect(splitRepository('')).toBeNull();
    expect(splitRepository(42)).toBeNull();
    expect(splitRepository({})).toBeNull();
  });

  it('returns null when input has no slash', () => {
    expect(splitRepository('justname')).toBeNull();
  });

  it('returns null on a leading slash (empty owner)', () => {
    expect(splitRepository('/repo')).toBeNull();
  });

  it('returns null on a trailing slash (empty repo)', () => {
    expect(splitRepository('owner/')).toBeNull();
  });

  it('splits a clean owner/repo', () => {
    expect(splitRepository('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('keeps the trailing segments on multi-slash input (pins indexOf behavior)', () => {
    // Documents current behavior: indexOf('/') gives owner='a', repo='b/c'.
    // If we ever change this to lastIndexOf, this test fires the alarm.
    expect(splitRepository('a/b/c')).toEqual({ owner: 'a', repo: 'b/c' });
  });
});

describe('buildCapabilities', () => {
  it('keeps every action flag false in Phase 0 regardless of inputs', () => {
    const cases = [
      { association: null, hasToken: false },
      { association: null, hasToken: true },
      { association: { prNumber: 1, repository: 'a/b' }, hasToken: false },
      { association: { prNumber: 1, repository: 'a/b' }, hasToken: true },
    ];

    for (const params of cases) {
      const caps = buildCapabilities(params);
      expect(caps.canShowPRMetadata).toBe(false);
      expect(caps.canViewPRComments).toBe(false);
      expect(caps.canCheckStaleVsPR).toBe(false);
      expect(caps.canSyncDrafts).toBe(false);
      expect(caps.canSubmitToGitHub).toBe(false);
    }
  });

  it('flips hasAssociatedPR only when both prNumber and repository present', () => {
    expect(buildCapabilities({ association: null, hasToken: true }).hasAssociatedPR).toBe(false);
    expect(buildCapabilities({ association: { prNumber: null, repository: 'a/b' }, hasToken: true }).hasAssociatedPR).toBe(false);
    expect(buildCapabilities({ association: { prNumber: 1, repository: '' }, hasToken: true }).hasAssociatedPR).toBe(false);
    expect(buildCapabilities({ association: { prNumber: 1, repository: 'a/b' }, hasToken: true }).hasAssociatedPR).toBe(true);
  });

  it('flips hasGitHubToken from hasToken boolean', () => {
    expect(buildCapabilities({ association: null, hasToken: false }).hasGitHubToken).toBe(false);
    expect(buildCapabilities({ association: null, hasToken: true }).hasGitHubToken).toBe(true);
    // Truthy non-boolean inputs are coerced to true.
    expect(buildCapabilities({ association: null, hasToken: 'ghp_xxx' }).hasGitHubToken).toBe(true);
  });
});

describe('getAssociatedPR', () => {
  function makeRepoStub(review) {
    return class FakeRepo {
      constructor(_db) {}
      async getLocalReviewById(_id) { return review; }
    };
  }

  it('throws when db is not provided', async () => {
    await expect(getAssociatedPR(1)).rejects.toThrow(/requires db/);
  });

  it('returns null when the review does not exist', async () => {
    const FakeRepo = makeRepoStub(null);
    const result = await getAssociatedPR(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(result).toBeNull();
  });

  it('returns null when association columns are NULL', async () => {
    const FakeRepo = makeRepoStub({
      id: 1,
      associated_pr_number: null,
      associated_pr_repository: null
    });
    const result = await getAssociatedPR(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(result).toBeNull();
  });

  it('returns the persisted association from associated_pr_* columns', async () => {
    const FakeRepo = makeRepoStub({
      id: 1,
      associated_pr_number: 42,
      associated_pr_repository: 'owner/repo'
    });
    const result = await getAssociatedPR(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(result).toEqual({ prNumber: 42, repository: 'owner/repo' });
  });

  it('does NOT fall back to pr_number / repository (those columns are exclusive to PR rows)', async () => {
    // Even if the local row has pr_number/repository set (legacy phase-0 data
    // before migration #47 cleaned it up), getAssociatedPR must read only
    // from the dedicated columns.
    const FakeRepo = makeRepoStub({
      id: 1,
      pr_number: 99,
      repository: 'owner/repo',
      associated_pr_number: null,
      associated_pr_repository: null
    });
    const result = await getAssociatedPR(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(result).toBeNull();
  });
});

describe('getPRContext', () => {
  function makeRepoStub(review) {
    return class FakeRepo {
      constructor(_db) {}
      async getLocalReviewById(_id) { return review; }
    };
  }

  it('returns owner+repo split alongside prNumber+repository', async () => {
    const FakeRepo = makeRepoStub({
      associated_pr_number: 7,
      associated_pr_repository: 'octocat/hello-world'
    });
    const ctx = await getPRContext(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(ctx).toEqual({
      prNumber: 7,
      repository: 'octocat/hello-world',
      owner: 'octocat',
      repo: 'hello-world'
    });
  });

  it('returns null when association is missing', async () => {
    const FakeRepo = makeRepoStub({ associated_pr_number: null, associated_pr_repository: null });
    const ctx = await getPRContext(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(ctx).toBeNull();
  });

  it('returns null when associated_pr_repository is malformed (no slash)', async () => {
    const FakeRepo = makeRepoStub({
      associated_pr_number: 7,
      associated_pr_repository: 'badrepo'
    });
    const ctx = await getPRContext(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(ctx).toBeNull();
  });

  it('returns null when associated_pr_repository is empty', async () => {
    const FakeRepo = makeRepoStub({
      associated_pr_number: 7,
      associated_pr_repository: ''
    });
    const ctx = await getPRContext(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(ctx).toBeNull();
  });
});
