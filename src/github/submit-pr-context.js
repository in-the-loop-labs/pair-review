// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const logger = require('../utils/logger');

/**
 * Build the `prContext` handed to `createReviewGraphQL` /
 * `createDraftReviewGraphQL` when a review is submitted to GitHub or an
 * alt-host.
 *
 * Shared by both submit entry points so they cannot drift apart:
 *   - the web submit route (`POST /api/pr/:owner/:repo/:number/submit-review`
 *     in src/routes/pr.js)
 *   - headless `--ai-draft` / `--ai-review` (`performHeadlessReview` in
 *     src/main.js)
 *
 * `headSha` (the PR head SHA) is required by the host pending-review-comments
 * path: GitHub-compatible alt-hosts validate each inline comment like
 * `pulls.createReviewComment`, which rejects a missing `commit_id` with a 422.
 * The GraphQL path on github.com ignores it (the pending review pins the
 * commit implicitly), so threading it through is harmless there.
 *
 * `prData.head_sha` (the parsed `pr_metadata.pr_data` JSON) is the canonical
 * source; `prMetadata.head_sha` is a fallback for records that expose it at
 * the top level (as `PRMetadataRepository.getByPR` does). When neither is
 * present the context carries `headSha: null` and a warning is logged so the
 * resulting 422 is diagnosable.
 *
 * @param {Object} params
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {number} params.prNumber - Pull request number
 * @param {Object|null} [params.existingDraft] - The user's pending review, if
 *   any; its numeric `databaseId` becomes `reviewId` for REST/host paths
 * @param {Object|null} [params.prData] - Parsed `pr_data` JSON
 * @param {Object|null} [params.prMetadata] - The `pr_metadata` record
 * @returns {{ owner: string, repo: string, prNumber: number, reviewId: (number|undefined), headSha: (string|null) }}
 */
function buildSubmitPrContext({ owner, repo, prNumber, existingDraft = null, prData = null, prMetadata = null }) {
  const headSha = prData?.head_sha || prMetadata?.head_sha || null;
  if (!headSha) {
    logger.warn(
      `Submit review for ${owner}/${repo}#${prNumber}: PR head SHA is missing ` +
      `(prData.head_sha and prMetadata.head_sha both absent). Host inline-comment ` +
      `posting will likely fail with a 422 missing commit_id error.`
    );
  }

  return {
    owner,
    repo,
    prNumber,
    reviewId: existingDraft?.databaseId,
    headSha
  };
}

module.exports = { buildSubmitPrContext };
