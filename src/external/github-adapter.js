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
const {
  getGitHubToken,
  resolveHostBinding,
  resolveBindingRepositoryFromPR
} = require('../config');

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
 * Binding-aware: when `repository` (`owner/repo`) is supplied, credential
 * resolution mirrors `resolveBindingForRequest` in `src/routes/pr.js` —
 * the repo is resolved to its binding key via `resolveBindingRepositoryFromPR`
 * and then to a host binding via `resolveHostBinding`, so per-repo
 * `api_host` / `token` / `token_command` / `features` apply. The
 * `GitHubClient` is constructed from the FULL binding (not a bare token),
 * so an alt-host repo routes Octokit's `baseUrl` to its `api_host` instead
 * of always hitting `api.github.com`.
 *
 * When `repository` is absent/empty the no-repo fallback is preserved
 * exactly: `getGitHubToken(config)` (top-level/env token) + a bare-token
 * `GitHubClient` (→ `api.github.com`). This keeps any caller without repo
 * context working unchanged.
 *
 * The returned shape also carries `isAltHost` so the route can drive
 * host-aware comment mapping. On the repo path it reflects the resolved
 * binding (`Boolean(binding.apiHost)`); on the no-repo fallback it is always
 * `false` (api.github.com). Alt-hosts don't implement GitHub's deprecated
 * diff-relative `position` field, so `mapComment` must anchor by `line`
 * instead — see its docstring.
 *
 * @param {Object} config - Server config (see `loadConfig()`)
 * @param {string} [repository] - "owner/repo" identifier for binding-aware resolution
 * @param {Object} [_deps] - Test overrides for
 *   { GitHubClient, getGitHubToken, resolveHostBinding, resolveBindingRepositoryFromPR }
 * @returns {{ client: Object, isAltHost: boolean }}
 * @throws {GitHubApiError} with status 401 when no token is configured
 */
function resolveCredentials(config, repository, _deps) {
  const deps = {
    GitHubClient,
    getGitHubToken,
    resolveHostBinding,
    resolveBindingRepositoryFromPR,
    ..._deps
  };
  const safeConfig = config || {};

  if (repository) {
    // Binding-aware path. Mirrors resolveBindingForRequest in routes/pr.js:
    // resolve the PR identity to a binding key, then to a host binding.
    const [owner, repo] = String(repository).split('/');
    const bindingRepository = deps.resolveBindingRepositoryFromPR(owner, repo, safeConfig);
    const binding = deps.resolveHostBinding(bindingRepository, safeConfig);
    if (!binding || !binding.token) {
      throw new GitHubApiError(
        `GitHub token not configured for ${repository}. Set ${credentialEnvVar}, add github_token to ~/.pair-review/config.json, or configure repos["${bindingRepository}"].token / token_command (required for alt-host repos)`,
        401
      );
    }
    // An api_host on the binding means this repo lives on an alternate Git
    // host. Surface that so the route can switch mapComment to line-based
    // anchoring (alt-hosts return position:null with a valid `line`).
    return { client: new deps.GitHubClient(binding), isAltHost: Boolean(binding.apiHost) };
  }

  // No-repo fallback — preserved exactly as before so callers without repo
  // context (top-level/env token → api.github.com) continue to work.
  const token = deps.getGitHubToken(safeConfig);
  if (!token) {
    throw new GitHubApiError(
      `GitHub token not configured. Set ${credentialEnvVar} or add github_token to ~/.pair-review/config.json`,
      401
    );
  }
  // The no-repo fallback always targets api.github.com, so it is never an
  // alt-host — keep the github.com position-based mapping.
  return { client: new deps.GitHubClient(token), isAltHost: false };
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
 * File-level comments (`subject_type === 'file'`): GitHub's REST "list review
 * comments" returns comments attached to a whole file (not a line) with
 * `subject_type: 'file'` but STILL anchored at `line: 1, position: 1`. Taking
 * those coordinates at face value renders them as ordinary line-1 annotations
 * (the bug this handles). So when `subject_type === 'file'` we flag the row
 * `is_file_level = 1` and null EVERY line anchor (`line_start`, `line_end`,
 * `diff_position`, `original_line_start`, `original_line_end`) — a file-level
 * comment has no line to anchor to. `is_outdated` stays 0: with no line anchor
 * there is nothing to outdate, and this deliberately bypasses the position/line
 * `is_outdated` derivation below (whose null-position branch would otherwise
 * mark it outdated). The frontend renders `is_file_level` rows in the per-file
 * comments zone above the diff. Alt hosts may omit `subject_type` entirely —
 * then `isFileLevel` is false and behaviour is unchanged (acceptable; those
 * hosts don't distinguish file-level comments in this response shape).
 *
 * Host-aware anchoring (the `options.isAltHost` switch), applied only to
 * NON-file-level rows:
 *   - **github.com (default, `isAltHost` falsy)**: `position` is the signal
 *     for "outdated". A null `position` means the comment no longer maps to
 *     the current diff, so the current-anchor fields are nulled and
 *     `original_*` becomes the only authoritative anchor. This path is
 *     byte-identical to the long-standing behaviour and must not change.
 *   - **alt-host (`isAltHost === true`)**: alternate Git hosts do NOT
 *     implement GitHub's DEPRECATED diff-relative `position` field — they
 *     return `position: null` even for perfectly current comments while
 *     supplying a valid modern `line`. Keying "outdated" off `position`
 *     there would discard a good `line` and mis-flag live comments as lost
 *     anchors. So we anchor uniformly by `line`: a current comment has a
 *     non-null `line` (`is_outdated = 0`); a genuinely outdated one has
 *     `line == null` (`is_outdated = 1`, anchored via `original_*`). This
 *     works whether or not the host also happens to return `position`.
 *
 * Edge cases handled here (per the phase spec):
 *   - `apiRow.user` is null (deleted account): `author` and `author_url`
 *     both become null. No throw.
 *   - both current AND original anchors null (force-push lost anchor):
 *     still produces a row — the sync route decides whether to count or
 *     skip. We do NOT throw here.
 *   - `apiRow.path` missing: throws — `file` is NOT NULL in the schema
 *     and a missing path means upstream gave us something malformed.
 *     Failing early in the mapper is far easier to debug than a SQL
 *     constraint violation deep in an upsert loop.
 *
 * @param {Object} apiRow
 * @param {Object} [options]
 * @param {boolean} [options.isAltHost=false] - When true, use line-based
 *   anchoring (alt-host); when false/omitted, github.com position-based.
 * @returns {Object} A row matching the `external_comments` column names
 */
function mapComment(apiRow, options = {}) {
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
  const isAltHost = options.isAltHost === true;
  // A file-level comment (GitHub sets subject_type='file') has no line anchor,
  // even though GitHub still reports line:1/position:1. Alt hosts may omit
  // subject_type — then this is false and the row is treated line-anchored,
  // exactly as before.
  const isFileLevel = apiRow.subject_type === 'file';

  let line_start;
  let line_end;
  let diff_position;
  let is_outdated;
  // Preferred original anchor; nulled for file-level rows (no line at all).
  let original_line_start = apiRow.original_start_line ?? apiRow.original_line ?? null;
  let original_line_end = apiRow.original_line ?? null;

  if (isFileLevel) {
    // No line anchor of any kind: strip current AND original coordinates so
    // the frontend routes the row to the per-file comments zone instead of a
    // diff line. is_outdated stays 0 — there is no line to have gone stale.
    line_start = null;
    line_end = null;
    diff_position = null;
    is_outdated = 0;
    original_line_start = null;
    original_line_end = null;
  } else if (isAltHost) {
    // Alt-host: `line` is the authoritative signal. `position` is unreliable
    // (alt-hosts leave it null even for current comments), so we never null
    // out a good `line` based on it. `diff_position` is carried through —
    // legitimately null on most alt-hosts; the frontend renders by
    // line_start/line_end/side, not by diff_position.
    const lineIsNull = apiRow.line == null;
    line_start = lineIsNull ? null : apiRow.start_line ?? apiRow.line ?? null;
    line_end = lineIsNull ? null : apiRow.line ?? null;
    diff_position = apiRow.position ?? null;
    is_outdated = lineIsNull ? 1 : 0;
  } else {
    // github.com (unchanged): when position is null the comment is outdated.
    // GitHub still populates `line` in many of these responses, but the line
    // number does NOT correspond to a position in the current diff — using
    // it would create two conflicting truths (line_end set AND is_outdated=1)
    // and would make the lost-anchor filter under-count. Force the
    // current-anchor fields to null so `original_*` is the only
    // authoritative anchor.
    const positionIsNull = apiRow.position == null;
    line_start = positionIsNull ? null : apiRow.start_line ?? apiRow.line ?? null;
    line_end = positionIsNull ? null : apiRow.line ?? null;
    diff_position = positionIsNull ? null : apiRow.position ?? null;
    is_outdated = positionIsNull ? 1 : 0;
  }

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
    is_outdated,
    is_file_level: isFileLevel ? 1 : 0,
    original_line_start,
    original_line_end,
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
