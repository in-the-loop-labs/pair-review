// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * PR Context Provider
 *
 * Shared helpers that resolve a local review's associated GitHub PR (if any)
 * and expose a normalized context object to both `routes/local.js` and
 * future Phase 2-5 features. Both the local route and (eventually) the PR
 * route consume these helpers — keeps the bridge between modes in one place.
 *
 * Phase 0 scope: thin DB-only lookups. No GitHub API calls here yet; those
 * land in Phase 1 (`fetchPRMetadata`).
 *
 * Follows the `defaults + _deps` DI pattern from `src/protocol-handler.js`.
 * Never re-resolves config internally — callers pass resolved values down.
 */

const { ReviewRepository } = require('../database');
const logger = require('../utils/logger');

const defaults = {
  ReviewRepository,
  logger,
};

/**
 * Split an owner/repo string into its components.
 * @param {string|null|undefined} repository
 * @returns {{owner: string, repo: string}|null}
 */
function splitRepository(repository) {
  if (!repository || typeof repository !== 'string') return null;
  const idx = repository.indexOf('/');
  if (idx <= 0 || idx === repository.length - 1) return null;
  const owner = repository.slice(0, idx);
  const repo = repository.slice(idx + 1);
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Get the persisted PR association for a local review, if any.
 *
 * Reads from the dedicated `associated_pr_*` columns — NOT pr_number /
 * repository. The PR natural key (pr_number, repository) stays exclusive to
 * review_type='pr' rows so PR-mode lookups never surface a local row.
 *
 * @param {number} reviewId
 * @param {Object} [deps]
 * @param {Object} deps.db - SQLite database instance (REQUIRED)
 * @param {Object} [deps._deps] - Internal overrides for testing
 * @returns {Promise<{prNumber: number, repository: string}|null>}
 */
async function getAssociatedPR(reviewId, { db, _deps } = {}) {
  if (!db) throw new Error('getAssociatedPR requires db');
  const deps = { ...defaults, ..._deps };

  const reviewRepo = new deps.ReviewRepository(db);
  const review = await reviewRepo.getLocalReviewById(reviewId);
  if (!review) return null;
  if (!review.associated_pr_number || !review.associated_pr_repository) return null;
  return {
    prNumber: review.associated_pr_number,
    repository: review.associated_pr_repository,
  };
}

/**
 * Get a richer PR context object for a local review, with owner/repo split.
 * Returns null when no association is persisted.
 *
 * @param {number} reviewId
 * @param {Object} [deps]
 * @param {Object} deps.db - SQLite database instance (REQUIRED)
 * @param {Object} [deps._deps] - Internal overrides for testing
 * @returns {Promise<{prNumber: number, repository: string, owner: string, repo: string}|null>}
 */
async function getPRContext(reviewId, { db, _deps } = {}) {
  const association = await getAssociatedPR(reviewId, { db, _deps });
  if (!association) return null;
  const parts = splitRepository(association.repository);
  if (!parts) return null;
  return {
    prNumber: association.prNumber,
    repository: association.repository,
    owner: parts.owner,
    repo: parts.repo,
  };
}

/**
 * Build the capabilities object surfaced to the frontend on
 * `GET /api/local/:reviewId`. Pure function over already-resolved inputs.
 *
 * The shape splits two concerns:
 *
 *   Prerequisite state — flips true when conditions are met:
 *     - hasAssociatedPR: a PR association is persisted on this review
 *     - hasGitHubToken: a usable GitHub token is available to the server
 *
 *   Action contracts — false until the matching endpoint/UI ships. These
 *   advertise specific operations the frontend may invoke. Each one flips
 *   true ONLY in the phase that lands the implementation. Hard-coding
 *   `false` in Phase 0 keeps the contract honest: prerequisite state being
 *   true does not imply the action is available.
 *
 *     - canShowPRMetadata: false   // Phase 1 flips this true
 *     - canViewPRComments: false   // Phase 2 flips this true
 *     - canCheckStaleVsPR: false   // Phase 3 flips this true
 *     - canSyncDrafts:     false   // Phase 4 flips this true
 *     - canSubmitToGitHub: false   // Phase 5 flips this true
 *
 * Token is passed in (do not re-resolve config). Caller is responsible for
 * computing the boolean via `getGitHubToken(config)`.
 *
 * @param {Object} params
 * @param {Object|null} params.association - Result of getAssociatedPR
 * @param {boolean} params.hasToken - Whether a GitHub token is available
 * @returns {Object} capabilities object
 */
function buildCapabilities({ association, hasToken }) {
  const hasAssociatedPR = Boolean(association && association.prNumber && association.repository);
  return {
    // Prerequisite state
    hasAssociatedPR,
    hasGitHubToken: Boolean(hasToken),
    // Action contracts — Phase 0 hard-codes all false; each phase flips its
    // own when the implementation lands. Frontend `hasCapability(name)`
    // consumers see false until the action is real.
    canShowPRMetadata: false,   // Phase 1 flips true
    canViewPRComments: false,   // Phase 2 flips true
    canCheckStaleVsPR: false,   // Phase 3 flips true
    canSyncDrafts: false,       // Phase 4 flips true
    canSubmitToGitHub: false,   // Phase 5 flips true
  };
}

module.exports = {
  getAssociatedPR,
  getPRContext,
  buildCapabilities,
  splitRepository,
};
