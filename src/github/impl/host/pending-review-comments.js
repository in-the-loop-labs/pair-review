// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const logger = require('../../../utils/logger');

/**
 * Host-extension implementation of the `pending_review_comments` area.
 *
 * GitHub's REST API does not support adding inline comments to a *pending*
 * draft review (the `addPullRequestReviewThread` GraphQL mutation has no
 * REST equivalent). Alt-hosts that advertise a compatible extension expose
 * this via a single HTTP POST that accepts a batch of comments.
 *
 * Documented generic contract:
 *
 *   POST {api_host}/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments
 *
 *   Request body:
 *     {
 *       "comments": [
 *         { "path": "...", "body": "...", "side": "RIGHT",
 *           "line": 42, "start_line": 40, "start_side": "RIGHT",
 *           "subject_type": "line" | "file",
 *           "commit_id": "<PR head SHA>" },
 *         ...
 *       ]
 *     }
 *
 *   `commit_id` is the PR head SHA. It is required by GitHub-compatible
 *   hosts that validate each comment like `pulls.createReviewComment`
 *   (which rejects a missing `commit_id` with a 422). It is sourced from
 *   `prContext.headSha` and omitted entirely when that value is absent.
 *
 *   Response (HTTP 200, partial-success body):
 *     {
 *       "added": <number>,
 *       "failed": [ { "index": <number>, "error_message": "..." }, ... ]
 *     }
 *
 *   Authorization: standard `Authorization: Bearer <token>` (attached by
 *   Octokit from the binding token).
 *
 * The host returns HTTP 200 with a partial-success body even when some
 * comments fail. A non-empty `failed` array is treated as a partial
 * failure: the returned shape matches the GraphQL impl so the caller
 * cannot tell which transport ran.
 *
 * Endpoint override: hosts that diverge from the default may set
 * `features.pending_review_comments_endpoint` to a template string
 * containing `{owner}`, `{repo}`, `{pull_number}`, `{review_id}`
 * placeholders. The template must be a relative path (starting with
 * `/repos/` or similar) — absolute URLs are rejected at config validation.
 *
 * Note on `reviewId`: this argument is the *host's* review identifier
 * (e.g. a numeric REST id), not a GraphQL node id. The REST/host
 * `review_lifecycle` impl (Phase 4) returns this id when it creates the
 * pending review; the caller passes it through unchanged.
 *
 * Note on `batchSize`: the original parameter is kept in the signature
 * for API compatibility with the GraphQL impl, but the host endpoint
 * accepts arbitrary batch sizes in a single call. We send all comments
 * in one POST and let the server enforce its own limits. The argument
 * is otherwise ignored.
 */

const DEFAULT_ENDPOINT_TEMPLATE =
  '/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments';

const REQUIRED_PLACEHOLDERS = ['{owner}', '{repo}', '{pull_number}', '{review_id}'];

// Matches any of the four supported placeholder names. Used globally so
// that templates which repeat a placeholder (e.g. `{repo}` in both the
// path and a query string) get every occurrence substituted, not just
// the first. `validateRepoConfig()` only asserts each required
// placeholder appears *somewhere*, so a chained per-name single
// `String.replace` would leave later occurrences literal in the URL.
const PLACEHOLDER_RE = /\{(owner|repo|pull_number|review_id)\}/g;

/**
 * Substitute placeholders in an endpoint template. URL-encodes each value
 * so that an `owner` like `my org` or a repo containing a slash cannot
 * break the path. The four required placeholders are validated at startup
 * by `validateRepoConfig()`, so missing placeholders here would indicate
 * a bug rather than user error — we still throw a clear error so the
 * failure is loud rather than producing a malformed request path.
 *
 * All occurrences of each placeholder are replaced (global substitution),
 * mirroring the behaviour of `substituteUrlTemplate` in
 * `src/links/repo-links.js`.
 *
 * @param {string} template - Endpoint template with `{...}` placeholders
 * @param {Object} values - { owner, repo, pull_number, review_id }
 * @returns {string} Substituted endpoint path
 */
function substituteEndpoint(template, values) {
  return template.replace(PLACEHOLDER_RE, (_match, name) => {
    const value = values ? values[name] : undefined;
    if (value === undefined || value === null) {
      throw new Error(
        `Host pending_review_comments: endpoint template references {${name}} ` +
        'but no value was provided. This should have been caught by ' +
        'validateRepoConfig — please report this as a bug.'
      );
    }
    return encodeURIComponent(String(value));
  });
}

/**
 * Map an internal comment shape to the host-extension wire shape. The
 * internal shape matches what callers already pass to the GraphQL impl:
 * `{ path, line?, start_line?, side?, body, isFileLevel? }`.
 *
 * - File-level comments (no `line` or explicit `isFileLevel`) are sent
 *   with `subject_type: "file"`.
 * - Line comments default to `side: "RIGHT"` to match GraphQL behaviour.
 * - Range comments include `start_line` and `start_side` (defaulting
 *   `start_side` to the same side as the end line, matching GitHub's
 *   own REST conventions).
 * - `commitId` (the PR head SHA) is added as `commit_id` to every wire
 *   comment when supplied. GitHub-compatible hosts validate comments like
 *   `pulls.createReviewComment` and reject a missing `commit_id` with a
 *   422. When `commitId` is empty/undefined the field is omitted entirely
 *   (we never send `commit_id: undefined`).
 *
 * @param {Object} comment - Internal comment shape.
 * @param {string} [commitId] - PR head SHA. Added as `commit_id` when a
 *   non-empty string; omitted otherwise.
 */
function toWireComment(comment, commitId) {
  const hasCommitId = typeof commitId === 'string' && commitId.length > 0;
  const isFileLevel = comment.isFileLevel || !comment.line;
  if (isFileLevel) {
    const wire = {
      path: comment.path,
      body: comment.body,
      subject_type: 'file'
    };
    if (hasCommitId) wire.commit_id = commitId;
    return wire;
  }
  const side = comment.side || 'RIGHT';
  const wire = {
    path: comment.path,
    body: comment.body,
    side,
    line: comment.line,
    subject_type: 'line'
  };
  if (comment.start_line) {
    wire.start_line = comment.start_line;
    wire.start_side = comment.start_side || side;
  }
  if (hasCommitId) wire.commit_id = commitId;
  return wire;
}

/**
 * Add a list of comments to a pending review via the host extension.
 *
 * @param {Object} octokit - Octokit instance bound to the host's baseUrl.
 *   `octokit.request()` will attach `Authorization: Bearer <token>` from
 *   the binding token automatically.
 * @param {Object} features - Feature-flag object from the host binding.
 *   May include `pending_review_comments_endpoint` to override the
 *   default endpoint path.
 * @param {Object} prContext - `{ owner, repo, prNumber, headSha? }`.
 *   Required — the host endpoint is path-shaped, so the GraphQL node IDs
 *   are not sufficient on their own. `headSha` (the PR head SHA) is
 *   forwarded as each comment's `commit_id`, required by
 *   GitHub-compatible hosts; omitted when absent.
 * @param {string} reviewId - The *host's* review identifier (returned
 *   by the host's M2 `review_lifecycle` impl, not a GraphQL node id).
 * @param {Array} comments - Comments with `{ path, line?, start_line?,
 *   side?, body, isFileLevel? }`. Same shape the GraphQL impl accepts.
 * @param {number} [_batchSize] - Ignored; kept for signature parity.
 * @returns {Promise<{successCount: number, failed: boolean, failedDetails: string[]}>}
 */
async function addCommentsInBatches(octokit, features, prContext, reviewId, comments, _batchSize) {
  if (!comments || comments.length === 0) {
    return { successCount: 0, failed: false, failedDetails: [] };
  }

  if (!prContext || typeof prContext !== 'object') {
    throw new Error(
      'Host pending_review_comments: prContext is required ' +
      '({ owner, repo, prNumber }). The host endpoint is path-shaped, ' +
      'so GraphQL node IDs alone are not sufficient.'
    );
  }
  const { owner, repo, prNumber } = prContext;
  if (!owner || !repo || prNumber === undefined || prNumber === null) {
    throw new Error(
      'Host pending_review_comments: prContext must include owner, repo, and prNumber.'
    );
  }

  // Resolve the *numeric* review id. The host endpoint is REST-shaped:
  // it identifies a review by its numeric database id, not its GraphQL
  // node id. Prefer `prContext.reviewId` (set by the orchestration in
  // `client.js` from the `databaseId` returned by addPullRequestReview)
  // and fall back to the positional `reviewId` argument only when it is
  // itself numeric. If only a node id was supplied, fail fast with a
  // clear message so regressions surface immediately rather than as a
  // 404 from the host.
  let resolvedReviewId = null;
  if (prContext && (typeof prContext.reviewId === 'number' || typeof prContext.reviewId === 'string')) {
    const fromCtx = String(prContext.reviewId);
    if (/^\d+$/.test(fromCtx)) {
      resolvedReviewId = fromCtx;
    }
  }
  if (resolvedReviewId === null) {
    if (typeof reviewId === 'number') {
      resolvedReviewId = String(reviewId);
    } else if (typeof reviewId === 'string' && /^\d+$/.test(reviewId)) {
      resolvedReviewId = reviewId;
    } else if (!reviewId && reviewId !== 0) {
      throw new Error('Host pending_review_comments: reviewId is required.');
    } else {
      throw new Error(
        `Host extension addCommentsInBatches requires a numeric review id; received "${reviewId}". ` +
        'Set prContext.reviewId or ensure the upstream addPullRequestReview returned a numeric databaseId.'
      );
    }
  }

  const template = (features && features.pending_review_comments_endpoint) || DEFAULT_ENDPOINT_TEMPLATE;
  const endpoint = substituteEndpoint(template, {
    owner,
    repo,
    pull_number: prNumber,
    review_id: resolvedReviewId
  });

  // The PR head SHA is threaded through `prContext.headSha` from the
  // submit site (see src/routes/pr.js). GitHub-compatible hosts require
  // each comment to carry `commit_id`; when the SHA is absent we omit the
  // field and let the host surface its own validation error.
  const commitId = prContext.headSha;
  const wireComments = comments.map((c) => toWireComment(c, commitId));
  logger.info(
    `Posting ${wireComments.length} comment(s) to host endpoint ${endpoint}`
  );

  let response;
  try {
    response = await octokit.request(`POST ${endpoint}`, {
      headers: {
        'content-type': 'application/json',
        accept: 'application/json'
      },
      data: { comments: wireComments }
    });
  } catch (error) {
    const status = error && (error.status || error.statusCode);
    const message = (error && error.message) || 'Unknown error';
    logger.error(
      `Host pending_review_comments request failed (${status || 'no status'}): ${message}`
    );
    // Normalise host request failures to the same partial-failure shape
    // the GraphQL impl returns, so callers can branch uniformly on
    // `batchResult.failed` without needing a try/catch. The orchestration
    // in `src/github/client.js` remains defensive against throws as the
    // primary safety guarantee — this is a secondary tidy-up so the
    // failure surface matches across transports.
    const failedDetails = comments.map((c) => {
      const location = c.line ? `${c.path}:${c.line}` : `${c.path}:file-level`;
      return `${location} - ${status || 'network error'}: ${message}`;
    });
    return {
      successCount: 0,
      failed: true,
      failedDetails
    };
  }

  const body = response && response.data ? response.data : {};
  // Distinguish "host explicitly reported a count (including 0)" from
  // "host omitted the field". An explicit `added: 0` with no `failed[]`
  // must NOT be treated as "all succeeded" — it means the host accepted
  // none. Only fall back to `comments.length` when the field is absent.
  const hasExplicitAdded = typeof body.added === 'number';
  const added = hasExplicitAdded ? body.added : 0;
  const failedList = Array.isArray(body.failed) ? body.failed : [];

  const failedDetails = [];
  for (const entry of failedList) {
    const idx = typeof entry.index === 'number' ? entry.index : null;
    const errMsg = (entry && (entry.error_message || entry.message)) || 'Unknown error';
    const source = idx !== null && idx >= 0 && idx < comments.length ? comments[idx] : null;
    const location = source
      ? `${source.path}:${source.line || 'file-level'}`
      : idx !== null ? `comment[${idx}]` : 'comment[?]';
    failedDetails.push(`${location} - ${errMsg}`);
    logger.warn(`Host comment failed: ${location} - ${errMsg}`);
  }

  // Sanity check: if the host reported an explicit count, the accounted-
  // for items (added + failed) should equal the total submitted. If they
  // don't, the host response is internally inconsistent — log a warning
  // but still trust the explicit counts.
  if (hasExplicitAdded && added + failedList.length !== comments.length) {
    logger.warn(
      `Host pending_review_comments inconsistent counts: added=${added}, ` +
      `failed=${failedList.length}, submitted=${comments.length}`
    );
  }

  if (failedList.length > 0) {
    logger.error(
      `Host pending_review_comments partial failure: ${added} added, ${failedList.length} failed`
    );
    return {
      successCount: added,
      failed: true,
      failedDetails
    };
  }

  // No partial failures. Trust an explicit `added` value (including 0).
  // Only fall back to `comments.length` when the host omitted the field
  // entirely — some hosts that don't report counts rely on this.
  const successCount = hasExplicitAdded ? added : comments.length;
  logger.info(`Host pending_review_comments complete: ${successCount} comment(s) added`);
  return {
    successCount,
    failed: false,
    failedDetails: []
  };
}

module.exports = {
  addCommentsInBatches,
  DEFAULT_ENDPOINT_TEMPLATE,
  REQUIRED_PLACEHOLDERS,
  // Exported for direct unit testing.
  substituteEndpoint,
  toWireComment
};
