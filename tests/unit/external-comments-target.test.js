// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `resolveCommentTarget` — the canonical comment-target
 * resolver in `src/routes/external-comments.js`.
 *
 * Both endpoints in that file (sync + fetch) route through this one function
 * on purpose: two predicates would let sync write mirror rows that fetch
 * never reads back. So the truth table is pinned here directly rather than
 * only through the two integration suites.
 *
 * It replaced the old `isPRMode` predicate. The PR-mode half of the table
 * below is that predicate's behaviour verbatim — any drift there is a
 * regression for existing PR reviews, not a Phase 2 design choice.
 */
import { describe, it, expect } from 'vitest';

const { resolveCommentTarget } = require('../../src/routes/external-comments');

/**
 * A PR-mode review row as `ReviewRepository.getReview` returns it (only the
 * fields the resolver reads).
 */
function prReview(overrides = {}) {
  return {
    id: 1,
    review_type: 'pr',
    local_path: null,
    pr_number: 42,
    repository: 'owner/repo',
    associated_pr_number: null,
    associated_pr_repository: null,
    ...overrides
  };
}

/**
 * A local review row. `pr_number` / `repository` deliberately carry DIFFERENT
 * values from the association columns in most tests below — migration 56
 * keeps the PR natural key exclusive to review_type='pr' rows, and the
 * resolver must honour that separation.
 */
function localReview(overrides = {}) {
  return {
    id: 2,
    review_type: 'local',
    local_path: '/repo/checkout',
    pr_number: null,
    repository: 'placeholder',
    associated_pr_number: null,
    associated_pr_repository: null,
    ...overrides
  };
}

describe('resolveCommentTarget', () => {
  describe('PR-mode rows', () => {
    it('resolves a well-formed PR review to its own natural key', () => {
      expect(resolveCommentTarget(prReview())).toEqual({
        owner: 'owner',
        repo: 'repo',
        prNumber: 42,
        repository: 'owner/repo'
      });
    });

    it('resolves when review_type is undefined (legacy rows predate the column)', () => {
      const review = prReview();
      delete review.review_type;
      expect(resolveCommentTarget(review)).toEqual({
        owner: 'owner',
        repo: 'repo',
        prNumber: 42,
        repository: 'owner/repo'
      });
    });

    it('returns null when pr_number is missing', () => {
      expect(resolveCommentTarget(prReview({ pr_number: null }))).toBeNull();
      const noKey = prReview();
      delete noKey.pr_number;
      expect(resolveCommentTarget(noKey)).toBeNull();
    });

    it('returns null for a NON-INTEGER pr_number — the string "42" must not resolve', () => {
      // Number.isInteger('42') is false. A stringified id would sail into
      // `pull_number` and GitHub would 404 with no useful message.
      expect(resolveCommentTarget(prReview({ pr_number: '42' }))).toBeNull();
      expect(resolveCommentTarget(prReview({ pr_number: 42.5 }))).toBeNull();
      expect(resolveCommentTarget(prReview({ pr_number: NaN }))).toBeNull();
    });

    it('returns null when repository is missing or empty', () => {
      expect(resolveCommentTarget(prReview({ repository: null }))).toBeNull();
      expect(resolveCommentTarget(prReview({ repository: '' }))).toBeNull();
      const noRepo = prReview();
      delete noRepo.repository;
      expect(resolveCommentTarget(noRepo)).toBeNull();
    });

    it('returns null when repository is not a string', () => {
      expect(resolveCommentTarget(prReview({ repository: 42 }))).toBeNull();
      expect(resolveCommentTarget(prReview({ repository: { full_name: 'owner/repo' } }))).toBeNull();
    });

    it('returns null for a row with local_path set even when review_type is "pr"', () => {
      // Mixed row: the PR branch bails on any local_path, so this never
      // silently syncs a checkout-backed row through the PR natural key.
      expect(resolveCommentTarget(prReview({ local_path: '/repo/checkout' }))).toBeNull();
    });

    it('returns null for an unrecognised review_type', () => {
      expect(resolveCommentTarget(prReview({ review_type: 'branch' }))).toBeNull();
    });
  });

  describe('local rows with an associated PR', () => {
    it('targets the ASSOCIATED PR, not the row pr_number/repository', () => {
      // The row carries deliberately different values in the natural-key
      // columns. If the resolver ever reads those for a local row, this fails
      // — that separation is what keeps `getReviewByPR` from surfacing local
      // rows (migration 56).
      const review = localReview({
        pr_number: 999,
        repository: 'decoy/decoy',
        associated_pr_number: 7,
        associated_pr_repository: 'assoc-owner/assoc-repo'
      });

      expect(resolveCommentTarget(review)).toEqual({
        owner: 'assoc-owner',
        repo: 'assoc-repo',
        prNumber: 7,
        repository: 'assoc-owner/assoc-repo'
      });
    });

    it('returns null when no association is persisted', () => {
      expect(resolveCommentTarget(localReview())).toBeNull();
    });

    it('returns null when only associated_pr_number is set', () => {
      expect(resolveCommentTarget(localReview({ associated_pr_number: 7 }))).toBeNull();
    });

    it('returns null when only associated_pr_repository is set', () => {
      expect(resolveCommentTarget(localReview({ associated_pr_repository: 'assoc-owner/assoc-repo' }))).toBeNull();
    });

    it('returns null when review_type is "local" but local_path is absent', () => {
      // Falls through to the PR branch, which rejects review_type !== 'pr'.
      // A local row with no checkout has nothing to render comments against.
      expect(resolveCommentTarget(localReview({
        local_path: null,
        associated_pr_number: 7,
        associated_pr_repository: 'assoc-owner/assoc-repo'
      }))).toBeNull();
    });
  });

  describe('missing input', () => {
    it('returns null for null/undefined reviews', () => {
      expect(resolveCommentTarget(null)).toBeNull();
      expect(resolveCommentTarget(undefined)).toBeNull();
    });
  });

  describe('owner/repo splitting (best effort)', () => {
    it('splits a clean owner/repo', () => {
      expect(resolveCommentTarget(prReview({ repository: 'octo/cat' })))
        .toMatchObject({ owner: 'octo', repo: 'cat' });
    });

    it('takes the FIRST two segments of a multi-slash repository', () => {
      // Pins the two-element destructure the resolver inherited from the
      // pre-Phase-2 code: 'a/b/c' → owner 'a', repo 'b'. NOTE this differs
      // from `splitRepository` in providers/pr-context.js (indexOf-based →
      // repo 'b/c'); they are separate rules and neither may drift silently.
      expect(resolveCommentTarget(prReview({ repository: 'a/b/c' })))
        .toEqual({ owner: 'a', repo: 'b', prNumber: 42, repository: 'a/b/c' });
    });

    it('still returns a NON-NULL target for a repository with no slash', () => {
      // Best effort on purpose: a non-null target lets `executeSync` raise its
      // specific "Invalid review.repository" 400 instead of collapsing into
      // the generic "no PR target" message.
      const target = resolveCommentTarget(prReview({ repository: 'norepo' }));
      expect(target).not.toBeNull();
      expect(target.owner).toBe('norepo');
      expect(target.repo).toBeNull();
      expect(target.repository).toBe('norepo');
    });

    it('nulls the empty half of a leading- or trailing-slash repository', () => {
      expect(resolveCommentTarget(prReview({ repository: '/repo' })))
        .toMatchObject({ owner: null, repo: 'repo' });
      expect(resolveCommentTarget(prReview({ repository: 'owner/' })))
        .toMatchObject({ owner: 'owner', repo: null });
    });

  });
});
