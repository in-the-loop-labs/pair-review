// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * GitHub source adapter for external review comments.
 *
 * Two responsibilities:
 *   1. `fetchComments` — delegate to the GitHubClient method that paginates
 *      `pulls.listReviewComments`. Adapter does NOT construct its own client;
 *      the caller injects it (dependency injection per CLAUDE.md).
 *   2. `mapComment` — translate a raw GitHub REST API row into the column
 *      shape of the `external_comments` table (see `src/database.js`).
 *
 * The dispatcher in `src/external/index.js` stamps `source = 'github'` at
 * write time, so `mapComment` does not include a `source` field — keeps
 * adapters from needing to know their own name.
 *
 * `synced_at` and the resolved local `parent_id` are also set by the
 * route/repository layer, not here.
 */

const { GitHubClient, GitHubApiError } = require('../github/client');
const { getGitHubToken } = require('../config');

const name = 'github';

/**
 * Adapter-owned env var name. Surfaced in credential-missing errors so the
 * user is told which env var/config key to set for THIS source. Future
 * adapters (GitLab, Linear) name their own variable here and the route
 * needs no per-source branching.
 */
const credentialEnvVar = 'GITHUB_TOKEN';

/**
 * Resolve the credentials this adapter needs to call its source system.
 * Returns an opaque `{ client }` shape; the route hands `client` straight
 * back to `fetchComments` without knowing it's a `GitHubClient`. Throwing
 * `GitHubApiError(status: 401)` keeps the existing 401 mapping at the
 * route layer.
 *
 * @param {Object} config - Server config (see `loadConfig()`)
 * @param {Object} [_deps] - Test overrides for { GitHubClient, getGitHubToken }
 * @returns {{ client: Object }}
 * @throws {GitHubApiError} with status 401 when no token is configured
 */
function resolveCredentials(config, _deps) {
  const deps = {
    GitHubClient,
    getGitHubToken,
    ..._deps
  };
  const token = deps.getGitHubToken(config || {});
  if (!token) {
    throw new GitHubApiError(
      `GitHub token not configured. Set ${credentialEnvVar} or add github_token to ~/.pair-review/config.json`,
      401
    );
  }
  return { client: new deps.GitHubClient(token) };
}

/**
 * Fetch all inline review comments for a pull request from GitHub.
 *
 * @param {Object} params
 * @param {Object} params.client - GitHubClient instance (injected)
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.pull_number
 * @returns {Promise<Array<Object>>} Raw Octokit review-comment objects
 */
async function fetchComments({ client, owner, repo, pull_number }) {
  return client.listReviewComments({ owner, repo, pull_number });
}

/**
 * Map a raw GitHub review-comment API row to an `external_comments` row.
 *
 * Edge cases handled here (per the phase spec):
 *   - `apiRow.user` is null (deleted account): `author` and `author_url`
 *     both become null. No throw.
 *   - `apiRow.position` is null (outdated): `is_outdated = 1`, current
 *     line/position fields null. `original_*` may still be populated.
 *   - `apiRow.position` AND `apiRow.original_position` both null
 *     (force-push lost anchor): still produces a row — the sync route
 *     decides whether to count or skip. We do NOT throw here.
 *   - `apiRow.path` missing: throws — `file` is NOT NULL in the schema
 *     and a missing path means upstream gave us something malformed.
 *     Failing early in the mapper is far easier to debug than a SQL
 *     constraint violation deep in an upsert loop.
 *
 * @param {Object} apiRow
 * @returns {Object} A row matching the `external_comments` column names
 */
function mapComment(apiRow) {
  if (!apiRow || apiRow.path == null) {
    throw new Error('GitHub adapter: comment missing required field "path"');
  }
  // Validate id presence — `String(undefined)` returns the literal
  // 'undefined' which would upsert as a valid external_id and even
  // satisfy UNIQUE(review_id, source, external_id) by colliding on that
  // string. Fail early so the route's row-level catch logs the bad row
  // and moves on instead of corrupting the mirror.
  if (apiRow.id == null) {
    throw new Error('GitHub adapter: comment missing required field "id"');
  }

  const user = apiRow.user || null;
  const positionIsNull = apiRow.position == null;

  // When position is null the comment is outdated. GitHub still populates
  // `line` in many of these responses, but the line number does NOT
  // correspond to a position in the current diff — using it would create
  // two conflicting truths (line_end set AND is_outdated=1) and would
  // make the lost-anchor filter under-count. Force the current-anchor
  // fields to null so `original_*` is the only authoritative anchor.
  const line_start = positionIsNull
    ? null
    : apiRow.start_line ?? apiRow.line ?? null;
  const line_end = positionIsNull ? null : apiRow.line ?? null;
  const diff_position = positionIsNull ? null : apiRow.position ?? null;

  return {
    external_id: String(apiRow.id),
    in_reply_to_id:
      apiRow.in_reply_to_id != null ? String(apiRow.in_reply_to_id) : null,
    external_url: apiRow.html_url || null,
    author: user ? user.login ?? null : null,
    author_url: user ? user.html_url ?? null : null,
    file: apiRow.path,
    side: apiRow.side ?? null,
    line_start,
    line_end,
    diff_position,
    commit_sha: apiRow.commit_id ?? null,
    is_outdated: positionIsNull ? 1 : 0,
    original_line_start:
      apiRow.original_start_line ?? apiRow.original_line ?? null,
    original_line_end: apiRow.original_line ?? null,
    original_commit_sha: apiRow.original_commit_id ?? null,
    body: apiRow.body ?? '',
    external_created_at: apiRow.created_at ?? null,
  };
}

module.exports = {
  name,
  credentialEnvVar,
  resolveCredentials,
  fetchComments,
  mapComment,
};
