// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { Octokit } = require('@octokit/rest');
const logger = require('../utils/logger');
const { DEFAULT_SHA_ABBREV_LENGTH } = require('../git/sha-abbrev');
const { GitHubApiError, isComplexityError } = require('./errors');
const pendingReviewOps = require('./operations/pending-review');
const reviewLifecycleOps = require('./operations/review-lifecycle');
const pendingReviewCommentsOps = require('./operations/pending-review-comments');

// Defaults used when `GitHubClient` is constructed from a bare token
// string (i.e. without a resolved binding). These mirror the
// config-resolved defaults for github.com: every area listed in
// `GRAPHQL_DEFAULT_AREAS` in `src/config.js` defaults to "graphql".
// If you add a new area to `FEATURE_AREAS` in `src/config.js`, mirror it
// here with the appropriate default.
const DEFAULT_FEATURES = Object.freeze({
  pending_review_check: 'graphql',
  stack_walker: 'graphql',
  review_lifecycle: 'graphql',
  pending_review_comments: 'graphql'
});

/**
 * Build the `Authorization` header value for a token, mirroring
 * `@octokit/auth-token`'s scheme selection: JWTs (three dot-delimited
 * segments) use the `bearer` scheme; everything else (classic/fine-grained
 * PATs, installation tokens, alt-host token-command output) uses `token`.
 *
 * We stamp this header ourselves via an Octokit `before` hook instead of
 * passing `auth` to the constructor, so a token refreshed mid-flight reaches
 * every request without rebuilding the client. Replicating the prefix logic
 * here keeps behaviour identical to the previous `auth: token` path.
 *
 * @param {string} token
 * @returns {string}
 */
function withAuthorizationPrefix(token) {
  return token.split('.').length === 3 ? `bearer ${token}` : `token ${token}`;
}

/**
 * Normalise the constructor argument into a binding object. Accepts the
 * legacy "bare token string" shape and the new
 * `{ token, apiHost, features }` shape so existing callers and tests do
 * not need to be updated.
 *
 * The optional `refresh` capability from an object binding is preserved so
 * the client can re-run a token command and retry on a 401 (see
 * `resolveHostBinding` in `src/config.js`). The legacy bare-token path keeps
 * `refresh: null`, so a github.com PAT client behaves exactly as before
 * (no hook-driven retry).
 *
 * @param {string|Object} arg - Token string or binding object
 * @returns {{ token: string, apiHost: string|null, features: Object, refresh: (function(): (string|Promise<string>))|null }}
 */
function normaliseBinding(arg) {
  if (typeof arg === 'string') {
    return {
      token: arg,
      apiHost: null,
      features: { ...DEFAULT_FEATURES },
      refresh: null
    };
  }
  if (arg && typeof arg === 'object') {
    const token = typeof arg.token === 'string' ? arg.token : '';
    const apiHost = (typeof arg.apiHost === 'string' && arg.apiHost) ? arg.apiHost : null;
    const features = (arg.features && typeof arg.features === 'object')
      ? { ...DEFAULT_FEATURES, ...arg.features }
      : { ...DEFAULT_FEATURES };
    const refresh = typeof arg.refresh === 'function' ? arg.refresh : null;
    return { token, apiHost, features, refresh };
  }
  return { token: '', apiHost: null, features: { ...DEFAULT_FEATURES }, refresh: null };
}

/**
 * GitHub API client wrapper with error handling and rate limiting.
 *
 * Constructor accepts either a bare token string (legacy) or a binding
 * object `{ token, apiHost, features }` returned by
 * `resolveHostBinding()`. When a binding is provided, `apiHost` is passed
 * to Octokit as `baseUrl` (defaults to `api.github.com` when null) and
 * `features` controls per-area dispatch into the operations layer.
 *
 * The public method signatures remain identical to the pre-refactor
 * shape — all GraphQL operations are now thin delegations to the
 * per-area dispatchers in `src/github/operations/`.
 */
class GitHubClient {
  constructor(tokenOrBinding) {
    const binding = normaliseBinding(tokenOrBinding);
    if (!binding.token) {
      throw new Error('GitHub token is required');
    }

    this.binding = binding;
    this.features = binding.features;
    this.apiHost = binding.apiHost;
    this.token = binding.token;
    // Capability to obtain a fresh token (e.g. re-run a token_command).
    // Only present for refreshable bindings; null for bare-token / literal
    // / env sources, which therefore get NO 401 refresh-and-retry behaviour.
    this.refresh = binding.refresh;

    // In-flight token refresh, shared across all concurrent/in-flight
    // requests so a burst of 401s triggers exactly one `refresh()`. Reset to
    // null once that refresh settles. See `_buildOctokit`.
    this._refreshing = null;

    this.octokit = this._buildOctokit();
  }

  /**
   * Build the single, long-lived Octokit instance and register its request
   * hooks. There is exactly ONE instance for the lifetime of the client — a
   * mid-flight token refresh updates `this.token` in place rather than
   * swapping the instance, so in-flight work (e.g. later pages of an
   * `octokit.paginate` loop, concurrent requests) observes the new token
   * instead of staying bound to a stale instance.
   *
   * Two hooks are registered, and ORDER MATTERS — `before` is registered
   * first so it sits innermost and re-runs when the `wrap` hook re-issues a
   * request:
   *
   *  1. `before('request')` stamps the CURRENT `this.token` onto the
   *     `Authorization` header of every outgoing request at dispatch time
   *     (REST via `octokit.rest.*`/`octokit.paginate` AND GraphQL via
   *     `octokit.graphql` — both flow through this pipeline). We do this
   *     instead of passing `auth` to the constructor precisely so the token
   *     is read late, per-request.
   *  2. `wrap('request')` implements refresh-on-401: on a 401, if a `refresh`
   *     capability exists and the request has not already been retried, it
   *     obtains a fresh token (coalescing concurrent refreshes onto one shared
   *     promise) and re-issues the request exactly once.
   *
   * @returns {Octokit}
   */
  _buildOctokit() {
    const octokit = new Octokit({
      baseUrl: this.apiHost || undefined,
      userAgent: 'pair-review v1.0.0'
    });

    // (1) Stamp the live token onto every request. Reads `this.token` at
    // dispatch time, so requests issued after a refresh — including
    // pagination follow-ups and the retry below — always carry the latest
    // token. Registered BEFORE the wrap hook so it re-runs on the retry.
    octokit.hook.before('request', (options) => {
      options.headers = {
        ...options.headers,
        authorization: withAuthorizationPrefix(this.token)
      };
    });

    // (2) Refresh-on-401, with concurrency-safe coalescing.
    octokit.hook.wrap('request', async (request, options) => {
      try {
        return await request(options);
      } catch (error) {
        // Only token-expiry (401) is recoverable by re-running the token
        // command. 403 (rate-limit/permissions), 404, 422, and 5xx are NOT
        // auth-expiry and must not trigger a refresh.
        if (error.status !== 401) {
          throw error;
        }
        // No refresh capability (bare-token / literal / env source), or this
        // request was already retried once → propagate without looping.
        if (typeof this.refresh !== 'function' || options.request?._pairReviewRetried) {
          throw error;
        }

        // Coalesce concurrent/in-flight 401s onto a SINGLE refresh. Without
        // this, every straggler bound to the now-stale token (the next page
        // of a `paginate` loop, sibling concurrent requests) would call
        // `refresh()` independently. The first 401 to arrive starts the
        // refresh; the rest await the same promise. The promise resolves to
        // whether the token actually changed — an empty/unchanged result (or
        // a thrown refresh) means retrying cannot help, so we re-throw the
        // original 401 rather than burn a pointless attempt.
        if (!this._refreshing) {
          const previousToken = this.token;
          this._refreshing = (async () => {
            try {
              const fresh = await this.refresh();
              if (fresh && fresh !== this.token) {
                this.token = fresh;
              }
            } catch (refreshError) {
              logger.warn(`Token refresh after 401 failed: ${refreshError.message}`);
            } finally {
              this._refreshing = null;
            }
            return this.token !== previousToken;
          })();
        }

        const tokenChanged = await this._refreshing;
        if (!tokenChanged) {
          throw error;
        }

        const host = this.apiHost || 'api.github.com';
        logger.info(`401 from ${host}; refreshed token and retrying request once`);

        // Re-issue once through the full pipeline. Mark `_pairReviewRetried`
        // so a still-failing fresh token throws instead of looping. Strip the
        // stale `authorization` header and the inherited `hook` binding so the
        // `before` hook re-stamps the fresh token cleanly on the retry.
        const { hook: _staleHook, ...staleRequest } = options.request || {};
        const { authorization: _staleAuth, ...staleHeaders } = options.headers || {};
        return await this.octokit.request({
          ...options,
          headers: staleHeaders,
          request: { ...staleRequest, _pairReviewRetried: true }
        });
      }
    });

    return octokit;
  }

  /**
   * Fetch pull request data from GitHub API
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pullNumber - Pull request number
   * @returns {Promise<Object>} Pull request data
   */
  async fetchPullRequest(owner, repo, pullNumber) {
    try {
      console.log(`Fetching pull request #${pullNumber} from ${owner}/${repo}`);

      const { data } = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber
      });

      return {
        number: data.number,
        node_id: data.node_id,  // GraphQL node ID for PR (e.g., "PR_kwDOM...")
        title: data.title,
        body: data.body || '',
        author: data.user.login,
        state: data.state,
        merged: data.merged || false,
        base_branch: data.base.ref,
        head_branch: data.head.ref,
        base_sha: data.base.sha,
        head_sha: data.head.sha,
        created_at: data.created_at,
        updated_at: data.updated_at,
        additions: data.additions,
        deletions: data.deletions,
        changed_files: data.changed_files,
        mergeable: data.mergeable,
        mergeable_state: data.mergeable_state,
        html_url: data.html_url,
        repository: {
          full_name: data.base.repo.full_name,
          clone_url: data.base.repo.clone_url,
          ssh_url: data.base.repo.ssh_url,
          default_branch: data.base.repo.default_branch
        }
      };
    } catch (error) {
      await this.handleApiError(error, owner, repo, pullNumber);
    }
  }

  /**
   * Fetch the list of files changed in a pull request.
   *
   * Uses the GitHub REST API `pulls.listFiles` endpoint, which returns an
   * array of file objects (with `filename`, `status`, `additions`, etc.).
   * This is distinct from the `changed_files` integer returned by
   * `pulls.get`, which is only a count.
   *
   * Paginates automatically to handle PRs with more than 100 changed files.
   *
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pullNumber - Pull request number
   * @returns {Promise<Array<{filename: string, status: string, additions: number, deletions: number, changes: number}>>}
   */
  async fetchPullRequestFiles(owner, repo, pullNumber) {
    try {
      const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100
      });
      return files.map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes
      }));
    } catch (error) {
      await this.handleApiError(error, owner, repo, pullNumber);
    }
  }

  /**
   * Fetch all inline (line-anchored) review comments on a pull request.
   *
   * Uses the GitHub REST API `pulls.listReviewComments` endpoint and paginates
   * automatically via `octokit.paginate` to handle PRs with more than 100
   * comments. Returns the raw API objects unchanged — mapping to local rows
   * happens in the adapter / route layer (keeps this client thin and testable).
   *
   * Note: this endpoint returns inline review comments only. Issue-level (PR
   * conversation tab) comments come from a different endpoint and are not
   * included here.
   *
   * @param {Object} params
   * @param {string} params.owner - Repository owner
   * @param {string} params.repo - Repository name
   * @param {number} params.pull_number - Pull request number
   * @returns {Promise<Array<Object>>} Raw review-comment objects with fields
   *   such as `id`, `pull_request_review_id`, `in_reply_to_id`, `body`,
   *   `user`, `path`, `commit_id`, `original_commit_id`, `position`,
   *   `original_position`, `line`, `start_line`, `original_line`,
   *   `original_start_line`, `side`, `start_side`, `html_url`, `created_at`,
   *   `updated_at`.
   * @throws {GitHubApiError} 404 when the PR is not found, 429 on rate limit,
   *   503 on network failure, or a wrapped error for other API failures.
   */
  async listReviewComments({ owner, repo, pull_number }) {
    try {
      const comments = await this.octokit.paginate(
        this.octokit.rest.pulls.listReviewComments,
        {
          owner,
          repo,
          pull_number,
          per_page: 100
        }
      );
      return comments;
    } catch (error) {
      await this.handleApiError(error, owner, repo, pull_number);
    }
  }

  /**
   * Validate GitHub token by making a test API call
   * @returns {Promise<boolean>} Whether the token is valid
   */
  async validateToken() {
    try {
      await this.octokit.rest.users.getAuthenticated();
      return true;
    } catch (error) {
      if (error.status === 401) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Check if a repository exists and is accessible
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {Promise<boolean>} Whether the repository exists and is accessible
   */
  async repositoryExists(owner, repo) {
    try {
      await this.octokit.rest.repos.get({ owner, repo });
      return true;
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        throw new GitHubApiError('GitHub authentication failed. Check your token permissions.', error.status);
      }
      if (error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Handle GitHub API errors with appropriate error messages and rate limiting
   * @param {Error} error - The API error
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pullNumber - Pull request number
   * @throws {Error} Reformatted error with user-friendly message
   */
  async handleApiError(error, owner, repo, pullNumber) {
    if (process.env.VERBOSE || logger.isDebugEnabled()) {
      console.error('GitHub API error:', error);
    }

    // Handle rate limiting with exponential backoff (primary rate limit:
    // `x-ratelimit-remaining: 0`).
    if (error.status === 403 && error.response?.headers?.['x-ratelimit-remaining'] === '0') {
      const resetTime = parseInt(error.response.headers['x-ratelimit-reset']) * 1000;
      const waitTime = Math.max(resetTime - Date.now(), 1000);

      console.log(`Rate limit exceeded. Retrying in ${Math.ceil(waitTime / 1000)} seconds...`);

      throw new GitHubApiError(`GitHub API rate limit exceeded. Retrying in ${Math.ceil(waitTime / 1000)} seconds...`, 429);
    }

    // Secondary rate limits ("abuse detection") return 403 WITHOUT the
    // standard rate-limit headers. They're signaled either by a `retry-after`
    // header or by message text mentioning "secondary rate limit", "abuse",
    // or "rate limit". Without this branch they'd fall through to the
    // permission-failure path and the user would be told their token is
    // missing scopes — misleading.
    if (error.status === 403) {
      const retryAfterHeader = error.response?.headers?.['retry-after'];
      const messageText = String(error.message || '');
      const looksLikeRateLimit =
        retryAfterHeader != null ||
        /secondary rate limit/i.test(messageText) ||
        /abuse/i.test(messageText) ||
        /rate limit/i.test(messageText);

      if (looksLikeRateLimit) {
        const retryAfterSec = retryAfterHeader != null ? parseInt(retryAfterHeader, 10) : null;
        const suffix = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? ` Retry after ${retryAfterSec} seconds.`
          : '';
        throw new GitHubApiError(`GitHub API rate limit exceeded (secondary rate limit).${suffix}`, 429);
      }

      // Genuine permission / scope failure. Without this branch the error
      // would fall through to the generic plain-`Error` path and route
      // handlers would map it to a 500 instead of a 403, hiding the real
      // cause from the reviewer.
      throw new GitHubApiError(
        `Insufficient permissions for ${owner}/${repo}. Your GitHub token may be missing required scopes.`,
        403
      );
    }

    // Handle authentication errors
    if (error.status === 401) {
      throw new GitHubApiError('GitHub authentication failed. Check your token in ~/.pair-review/config.json', 401);
    }

    if (error.status === 404) {
      throw new GitHubApiError(`Pull request #${pullNumber} not found in repository ${owner}/${repo}`, 404);
    }

    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new GitHubApiError(`Network error: ${error.message}. Please check your internet connection.`, 503);
    }

    throw new Error(`GitHub API error: ${error.message}`);
  }


  /**
   * Submit a review to GitHub with inline comments
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pullNumber - Pull request number
   * @param {string} event - Review event (APPROVE, REQUEST_CHANGES, COMMENT, or DRAFT)
   * @param {string} body - Overall review body/summary
   * @param {Array} comments - Array of inline comments with path, line, body
   * @param {string} diffContent - The PR diff for position calculation
   * @returns {Promise<Object>} Review submission result with GitHub URL
   */
  async createReview(owner, repo, pullNumber, event, body, comments = [], diffContent = '') {
    try {
      const reviewType = event === 'DRAFT' ? 'draft review' : 'review';
      console.log(`Creating ${reviewType} for PR #${pullNumber} in ${owner}/${repo}`);

      const validEvents = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT', 'DRAFT'];
      if (!validEvents.includes(event)) {
        throw new Error(`Invalid review event: ${event}. Must be one of: ${validEvents.join(', ')}`);
      }

      const formattedComments = [];

      const binaryExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
                               '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so',
                               '.dylib', '.bin', '.dat', '.db', '.sqlite'];

      for (const comment of comments) {
        if (!comment.path || !comment.body) {
          throw new Error('Each comment must have a path and body');
        }

        const isBinary = binaryExtensions.some(ext => comment.path.toLowerCase().endsWith(ext));
        if (isBinary) {
          console.warn(`Skipping comment on binary file: ${comment.path} (GitHub doesn't support comments on binary files)`);
          continue;
        }

        const side = comment.side || 'RIGHT';
        const commitId = comment.commit_id;

        if (!commitId) {
          console.error(`Missing commit_id for comment on ${comment.path}:${comment.line} - comment will likely fail`);
        }

        const isRange = comment.start_line && comment.start_line !== comment.line;
        if (isRange) {
          console.log(`Formatting range comment for ${comment.path}:${comment.start_line}-${comment.line} (side: ${side})`);
        } else {
          console.log(`Formatting comment for ${comment.path}:${comment.line} (side: ${side})`);
        }

        const formatted = {
          path: comment.path,
          line: comment.line,
          side: side,
          body: comment.body
        };

        if (isRange) {
          formatted.start_line = comment.start_line;
          formatted.start_side = comment.start_side || side;
        }

        formattedComments.push(formatted);
      }

      console.log(`Formatted ${formattedComments.length} comments for ${reviewType}`);

      if (comments.length > 0 && formattedComments.length === 0) {
        console.warn('All comments were on binary files and were skipped');
        if (!body || body.trim() === '') {
          const errorMessage = event === 'DRAFT' ?
            'Cannot create draft review: all comments are on binary files (GitHub does not support comments on binary files) and no review summary was provided' :
            'Cannot submit review: all comments are on binary files (GitHub does not support comments on binary files) and no review summary was provided';
          throw new Error(errorMessage);
        }
      }

      const commitId = comments.length > 0 ? comments[0].commit_id : null;
      if (commitId) {
        console.log(`Using commit_id for review: ${commitId.substring(0, DEFAULT_SHA_ABBREV_LENGTH)}`);
      } else {
        console.warn('No commit_id available - review may fail for lines outside diff');
      }

      const payload = {
        owner,
        repo,
        pull_number: pullNumber,
        body: body || '',
        comments: formattedComments
      };

      if (commitId) {
        payload.commit_id = commitId;
      }

      if (event !== 'DRAFT') {
        payload.event = event;
      }

      console.log(`Submitting review to GitHub with payload:`, JSON.stringify({
        ...payload,
        comments: payload.comments.length + ' comments'
      }, null, 2));

      const { data } = await this.octokit.rest.pulls.createReview(payload);

      const successMessage = event === 'DRAFT' ?
        `Draft review created successfully: ${data.html_url} (Review ID: ${data.id})` :
        `Review submitted successfully: ${data.html_url}`;
      console.log(successMessage);

      return {
        id: data.id,
        html_url: data.html_url,
        state: data.state,
        submitted_at: data.submitted_at,
        comments_count: formattedComments.length
      };

    } catch (error) {
      await this.handleReviewError(error, owner, repo, pullNumber);
    }
  }

  /**
   * Add comments to a pending review in batches.
   *
   * Thin delegation to the `pending_review_comments` operation dispatcher
   * — see `src/github/operations/pending-review-comments.js`. Returns
   * the same shape as before: `{ successCount, failed, failedDetails }`.
   *
   * `prContext` ({ owner, repo, prNumber }) is required for the `"host"`
   * dispatch path, which uses a path-shaped REST endpoint. It is ignored
   * on the `"graphql"` path. Callers that may run against alt-hosts must
   * pass it; callers known to only run against github.com may omit it.
   *
   * @param {string} prNodeId - GraphQL node ID for the PR
   * @param {string} reviewId - Review identifier (GraphQL node ID on the
   *   graphql path; host REST id on the host path)
   * @param {Array} comments
   * @param {number} [batchSize=10]
   * @param {Object} [prContext] - `{ owner, repo, prNumber }`. Required
   *   when `features.pending_review_comments === "host"`.
   * @returns {Promise<{successCount: number, failed: boolean, failedDetails: string[]}>}
   */
  async addCommentsInBatches(prNodeId, reviewId, comments, batchSize = 10, prContext = null) {
    return pendingReviewCommentsOps.addCommentsInBatches(
      this.octokit,
      this.features,
      prNodeId,
      reviewId,
      comments,
      batchSize,
      prContext
    );
  }

  /**
   * Get the pending (draft) review for the authenticated user on a PR.
   *
   * Thin delegation to the `pending_review_check` dispatcher.
   */
  async getPendingReviewForUser(owner, repo, prNumber) {
    return pendingReviewOps.getPendingReviewForUser(
      this.octokit,
      this.features,
      owner,
      repo,
      prNumber
    );
  }

  /**
   * Get a review by its GraphQL node ID.
   *
   * Thin delegation to the `pending_review_check` dispatcher. When the
   * dispatcher is in REST mode, `prContext` is REQUIRED — the REST
   * endpoint identifies a review by (owner, repo, pull_number,
   * review_id) rather than by node id. The GraphQL path ignores it.
   *
   * @param {string} nodeId - GraphQL node id
   * @param {Object} [prContext] - `{ owner, repo, prNumber, reviewId? }`
   */
  async getReviewById(nodeId, prContext) {
    return pendingReviewOps.getReviewById(this.octokit, this.features, nodeId, prContext);
  }

  /**
   * Delete a pending review (used for cleanup on failure).
   *
   * Thin delegation to the `review_lifecycle` dispatcher.
   *
   * @param {string} reviewId - GraphQL node ID for the review
   * @param {Object} [prContext] - `{ owner, repo, prNumber, reviewId? }`, required for REST mode
   * @returns {Promise<boolean>}
   */
  async deletePendingReview(reviewId, prContext) {
    return reviewLifecycleOps.deletePullRequestReview(
      this.octokit,
      this.features,
      reviewId,
      prContext
    );
  }

  /**
   * Submit a review using GraphQL API
   * This supports both line-level comments (within diff hunks) and file-level comments
   * (for expanded context lines outside diff hunks).
   *
   * Orchestration is unchanged from the pre-refactor implementation; the
   * three GraphQL primitives (create pending review, add comments,
   * submit) are now dispatched through `review_lifecycle` and
   * `pending_review_comments` operations.
   *
   * @param {string} prNodeId - GraphQL node ID for the PR
   * @param {string} event - APPROVE, REQUEST_CHANGES, COMMENT
   * @param {string} body
   * @param {Array} comments
   * @param {string|null} [existingReviewId=null]
   * @param {Object|null} [prContext=null] - `{ owner, repo, prNumber }`,
   *   required when `features.pending_review_comments === "host"`.
   * @returns {Promise<Object>}
   */
  async createReviewGraphQL(prNodeId, event, body, comments = [], existingReviewId = null, prContext = null) {
    // Transport label for user-facing log/error strings. This method name
    // is historical (callers depend on it), but the actual transport may be
    // the alt-host REST/extension path rather than GraphQL. Keep the
    // messages accurate to what really ran.
    const transport = this.apiHost ? 'alt-host' : 'GraphQL';
    try {
      console.log(`Creating review (${transport}) for PR ${prNodeId} with ${comments.length} comments`);

      const validEvents = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];
      if (!validEvents.includes(event)) {
        throw new Error(`Invalid review event: ${event}. Must be one of: ${validEvents.join(', ')}`);
      }

      // When running on the REST review-lifecycle path, callers can
      // pass only a numeric review id via `prContext.reviewId` (no node
      // id is available without an extra round-trip). Treat that as an
      // existing-review signal so we don't accidentally create a second
      // pending review on top of the user's existing draft.
      const existingRestReviewId = this.features.review_lifecycle === 'rest' ? prContext?.reviewId : null;
      const effectiveExistingReviewId = existingReviewId ?? existingRestReviewId;
      const usedExistingReview = effectiveExistingReviewId !== undefined && effectiveExistingReviewId !== null;

      let reviewId;
      let reviewDatabaseId = null;
      if (usedExistingReview) {
        console.log(`Step 1: Using existing pending review: ${effectiveExistingReviewId}`);
        reviewId = effectiveExistingReviewId;
        // Caller is expected to pass the numeric id on `prContext.reviewId`
        // (e.g. `existingDraft.databaseId`). Capture it so we can propagate
        // it explicitly to subsequent calls in this orchestration.
        if (prContext && (typeof prContext.reviewId === 'number' || typeof prContext.reviewId === 'string')) {
          const numeric = Number(prContext.reviewId);
          if (Number.isFinite(numeric)) reviewDatabaseId = numeric;
        }
      } else {
        console.log('Step 1: Creating pending review...');
        const created = await reviewLifecycleOps.addPullRequestReview(
          this.octokit,
          this.features,
          prNodeId,
          prContext
        );
        reviewId = created.id;
        reviewDatabaseId = (typeof created.databaseId === 'number') ? created.databaseId : null;
        console.log(`Created pending review: ${reviewId}${reviewDatabaseId !== null ? ` (databaseId=${reviewDatabaseId})` : ''}`);
      }

      // Build a downstream prContext that carries the numeric review id
      // so REST/host paths (which need a numeric REST id) can resolve it
      // without needing the caller to remember to pass it.
      const downstreamPrContext = prContext
        ? { ...prContext, reviewId: reviewDatabaseId !== null ? reviewDatabaseId : prContext.reviewId }
        : (reviewDatabaseId !== null ? { reviewId: reviewDatabaseId } : null);

      let successfulComments = 0;
      if (comments.length > 0) {
        console.log(`Step 2: Adding ${comments.length} comments in batches...`);
        let batchResult;
        try {
          batchResult = await this.addCommentsInBatches(prNodeId, reviewId, comments, 10, downstreamPrContext);
        } catch (commentError) {
          // The comment-batch path threw before returning a result shape.
          // This happens on the host pending-review-comments path (which
          // throws on request failure) and on unsupported-mode rejection
          // in the dispatcher. The original code only cleaned up when
          // `batchResult.failed` was returned, leaving a pending review
          // behind on these throws when we created it ourselves.
          console.error(`CRITICAL: comment batch threw before completion: ${commentError.message}`);
          if (!usedExistingReview) {
            const cleaned = await this.deletePendingReview(reviewId, downstreamPrContext);
            if (!cleaned) {
              console.warn('Warning: Failed to clean up pending review - manual cleanup may be required');
            }
          } else {
            console.warn('Skipping cleanup of pre-existing pending review - comments may be partially added');
          }
          const wrapped = new Error(
            `Failed to add comments to GitHub: comment batch threw before completion: ${commentError.message}`
          );
          wrapped.cause = commentError;
          if (commentError.stack) wrapped.stack = commentError.stack;
          throw wrapped;
        }
        successfulComments = batchResult.successCount;

        if (batchResult.failed) {
          const failedCount = comments.length - successfulComments;
          const details = batchResult.failedDetails || [];
          console.error(`CRITICAL: ${failedCount} of ${comments.length} comments failed to add to GitHub`);
          if (!usedExistingReview) {
            const cleaned = await this.deletePendingReview(reviewId, downstreamPrContext);
            if (!cleaned) {
              console.warn('Warning: Failed to clean up pending review - manual cleanup may be required');
            }
          } else {
            console.warn('Skipping cleanup of pre-existing pending review - comments may be partially added');
          }
          const detailSuffix = details.length > 0 ? ` Failures:\n${details.join('\n')}` : '';
          throw new Error(`Failed to add ${failedCount} of ${comments.length} comments to GitHub.${detailSuffix}`);
        }
      }

      console.log(`Step 3: Submitting review with event ${event}...`);
      const result = await reviewLifecycleOps.submitPullRequestReview(
        this.octokit,
        this.features,
        reviewId,
        event,
        body,
        downstreamPrContext
      );

      console.log(`Review submitted successfully: ${result.url}`);

      return {
        id: result.id,
        databaseId: result.databaseId,
        html_url: result.url,
        state: result.state,
        comments_count: successfulComments
      };

    } catch (error) {
      console.error(`Review error (${transport}):`, error);

      // The `error.errors` branch is a GraphQL-shaped error envelope. It is
      // harmless on the REST/host path (which won't populate it); we still
      // label the message with the actual transport for accuracy.
      if (error.errors) {
        const messages = error.errors.map(e => e.message).join(', ');
        throw new Error(`GitHub ${transport} error: ${messages}`);
      }

      throw new Error(`Failed to submit review (${transport}): ${error.message}`);
    }
  }

  /**
   * Create a draft (pending) review using GraphQL API
   * This creates a review and adds comments but does NOT submit it.
   * The review remains as PENDING on GitHub for later submission.
   *
   * @param {string} prNodeId
   * @param {string} body
   * @param {Array} comments
   * @param {string|null} [existingReviewId=null]
   * @param {Object|null} [prContext=null] - `{ owner, repo, prNumber }`,
   *   required when `features.pending_review_comments === "host"`.
   * @returns {Promise<Object>}
   */
  async createDraftReviewGraphQL(prNodeId, body, comments = [], existingReviewId = null, prContext = null) {
    // Transport label for user-facing log/error strings. The method name is
    // historical; the real transport may be the alt-host REST/extension
    // path rather than GraphQL. See createReviewGraphQL for the rationale.
    const transport = this.apiHost ? 'alt-host' : 'GraphQL';
    try {
      console.log(`Creating draft review (${transport}) for PR ${prNodeId} with ${comments.length} comments`);

      // See createReviewGraphQL for the rationale: on the REST
      // review-lifecycle path the caller may have only a numeric review
      // id and no node id, so treat `prContext.reviewId` as an
      // existing-review signal in that mode.
      const existingRestReviewId = this.features.review_lifecycle === 'rest' ? prContext?.reviewId : null;
      const effectiveExistingReviewId = existingReviewId ?? existingRestReviewId;
      const usedExistingReview = effectiveExistingReviewId !== undefined && effectiveExistingReviewId !== null;

      let reviewId;
      let reviewDatabaseId = null;
      let reviewUrl;
      // Note: the body parameter is not updated for existing pending reviews because
      // GitHub only uses the body at submission time (via submitPullRequestReview),
      // not during the pending/draft phase.
      if (usedExistingReview) {
        console.log(`Step 1: Using existing pending review: ${effectiveExistingReviewId}`);
        reviewId = effectiveExistingReviewId;
        // URL and databaseId not available from existing review ID alone.
        // Caller is expected to pass the numeric id on `prContext.reviewId`
        // (e.g. `existingDraft.databaseId`). Capture it for propagation.
        if (prContext && (typeof prContext.reviewId === 'number' || typeof prContext.reviewId === 'string')) {
          const numeric = Number(prContext.reviewId);
          if (Number.isFinite(numeric)) reviewDatabaseId = numeric;
        }
        reviewUrl = null;
      } else {
        console.log('Step 1: Creating pending review...');
        const created = await reviewLifecycleOps.addPullRequestReviewWithBody(
          this.octokit,
          this.features,
          prNodeId,
          body,
          prContext
        );
        reviewId = created.id;
        reviewDatabaseId = (typeof created.databaseId === 'number') ? created.databaseId : null;
        reviewUrl = created.url;
        console.log(`Created pending review: ${reviewId}${reviewDatabaseId !== null ? ` (databaseId=${reviewDatabaseId})` : ''}`);
      }

      // Build a downstream prContext carrying the numeric review id so
      // REST/host paths can address the review without re-resolving it.
      const downstreamPrContext = prContext
        ? { ...prContext, reviewId: reviewDatabaseId !== null ? reviewDatabaseId : prContext.reviewId }
        : (reviewDatabaseId !== null ? { reviewId: reviewDatabaseId } : null);

      let successfulComments = 0;
      if (comments.length > 0) {
        console.log(`Step 2: Adding ${comments.length} comments in batches...`);
        let batchResult;
        try {
          batchResult = await this.addCommentsInBatches(prNodeId, reviewId, comments, 10, downstreamPrContext);
        } catch (commentError) {
          // The comment-batch path threw before returning a result shape.
          // This happens on the host pending-review-comments path (which
          // throws on request failure) and on unsupported-mode rejection
          // in the dispatcher. The original code only cleaned up when
          // `batchResult.failed` was returned, leaving a pending review
          // behind on these throws when we created it ourselves.
          console.error(`CRITICAL: comment batch threw before completion: ${commentError.message}`);
          if (!usedExistingReview) {
            const cleaned = await this.deletePendingReview(reviewId, downstreamPrContext);
            if (!cleaned) {
              console.warn('Warning: Failed to clean up pending review - manual cleanup may be required');
            }
          } else {
            console.warn('Skipping cleanup of pre-existing pending review - comments may be partially added');
          }
          const wrapped = new Error(
            `Failed to add comments to draft review: comment batch threw before completion: ${commentError.message}`
          );
          wrapped.cause = commentError;
          if (commentError.stack) wrapped.stack = commentError.stack;
          throw wrapped;
        }
        successfulComments = batchResult.successCount;

        if (batchResult.failed) {
          const failedCount = comments.length - successfulComments;
          const details = batchResult.failedDetails || [];
          const detailSuffix = details.length > 0 ? ` Failures:\n${details.join('\n')}` : '';
          console.error(`CRITICAL: ${failedCount} of ${comments.length} comments failed to add to draft review`);
          if (!usedExistingReview) {
            const cleaned = await this.deletePendingReview(reviewId, downstreamPrContext);
            if (!cleaned) {
              console.warn('Warning: Failed to clean up pending review - manual cleanup may be required');
            }
            throw new Error(
              `Failed to add ${failedCount} of ${comments.length} comments to draft review. ` +
              `The draft review has been deleted.${detailSuffix}`
            );
          } else {
            console.warn('Skipping cleanup of pre-existing pending review - comments may be partially added');
            throw new Error(`Failed to add ${failedCount} of ${comments.length} comments to existing draft review. ${successfulComments} comments were added to the GitHub draft.${detailSuffix}`);
          }
        }
      }

      // Note: We do NOT submit the review - it stays as PENDING (draft)
      console.log(`Draft review created successfully (pending): ${reviewUrl || reviewId}`);

      return {
        id: reviewId,
        databaseId: reviewDatabaseId,
        html_url: reviewUrl,
        state: 'PENDING',
        comments_count: successfulComments
      };

    } catch (error) {
      console.error(`Draft review error (${transport}):`, error);

      // The `error.errors` branch is a GraphQL-shaped error envelope,
      // harmless on the REST/host path. Label with the actual transport.
      if (error.errors) {
        const messages = error.errors.map(e => e.message).join(', ');
        throw new Error(`GitHub ${transport} error: ${messages}`);
      }

      throw new Error(`Failed to create draft review (${transport}): ${error.message}`);
    }
  }

  /**
   * Calculate diff position for a given file path and line number
   * Position is counted from the first @@ hunk header, where position 1 = first line after @@
   * @param {string} diffContent - The unified diff content
   * @param {string} filePath - File path to find in diff
   * @param {number} lineNumber - Line number in the new file
   * @returns {number} Diff position or -1 if not found
   */
  calculateDiffPosition(diffContent, filePath, lineNumber) {
    if (!diffContent || !filePath || lineNumber === undefined) {
      console.warn('calculateDiffPosition: Missing required parameters', {
        filePath,
        lineNumber,
        hasDiffContent: !!diffContent
      });
      return -1;
    }

    const lines = diffContent.split('\n');
    let inFile = false;
    let currentFile = '';
    let position = 0;
    let newLineNumber = 0;
    let foundHunk = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('diff --git')) {
        const match = line.match(/diff --git a\/(.+) b\/(.+)/);
        if (match) {
          currentFile = match[2];
          inFile = currentFile === filePath;
          position = 0;
          newLineNumber = 0;
          foundHunk = false;
        }
        continue;
      }

      if (!inFile) continue;

      if (line.startsWith('@@')) {
        const match = line.match(/@@ -\d+,?\d* \+(\d+),?\d* @@/);
        if (match) {
          newLineNumber = parseInt(match[1]) - 1;

          if (!foundHunk) {
            position = 0;
            foundHunk = true;
          } else {
            position++;
          }
        }
        continue;
      }

      if (!foundHunk) continue;

      const isDiffContentLine = line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || (line === '' && foundHunk);

      if (!isDiffContentLine) continue;

      position++;

      if (line.startsWith('+')) {
        newLineNumber++;
        if (newLineNumber === lineNumber) {
          return position;
        }
      } else if (line.startsWith(' ') || (line === '' && foundHunk)) {
        newLineNumber++;
        if (newLineNumber === lineNumber) {
          return position;
        }
      }
    }

    console.warn('calculateDiffPosition: Position not found', {
      filePath,
      lineNumber,
      inFile,
      foundHunk,
      finalNewLineNumber: newLineNumber
    });
    return -1;
  }

  /**
   * Handle errors specific to review submission
   * @param {Error} error - The API error
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pullNumber - Pull request number
   * @throws {Error} Reformatted error with user-friendly message
   */
  async handleReviewError(error, owner, repo, pullNumber) {
    console.error('GitHub review submission error:', error);

    if (error.status === 401) {
      throw new GitHubApiError('GitHub authentication failed. Your token may be invalid or expired. Check ~/.pair-review/config.json', 401);
    }

    if (error.status === 403) {
      throw new GitHubApiError(`Insufficient permissions to review PR #${pullNumber} in ${owner}/${repo}. Your GitHub token may need additional scopes.`, 403);
    }

    if (error.status === 404) {
      throw new GitHubApiError(`Pull request #${pullNumber} not found in repository ${owner}/${repo}`, 404);
    }

    if (error.status === 422) {
      console.error('GitHub 422 validation error response:', JSON.stringify(error.response?.data, null, 2));
      const message = error.response?.data?.message || 'Validation error';
      const errors = error.response?.data?.errors;

      if (errors && Array.isArray(errors)) {
        const errorMessages = errors.map(e => e.message || e.code || e);
        const errorDetails = errorMessages.join(', ');

        if (errorMessages.some(msg => msg.includes('pending review'))) {
          throw new Error(`You already have a pending (draft) review on this PR. Please submit or dismiss it on GitHub before creating a new draft review.`);
        }

        throw new Error(`GitHub API validation error: ${message}. Details: ${errorDetails}`);
      }
      throw new Error(`GitHub API validation error: ${message}`);
    }

    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new GitHubApiError(`Network error during review submission: ${error.message}. Please check your internet connection.`, 503);
    }

    if (error.status === 403 && error.response?.headers?.['x-ratelimit-remaining'] === '0') {
      const resetTime = parseInt(error.response.headers['x-ratelimit-reset']) * 1000;
      const waitTime = Math.max(resetTime - Date.now(), 1000);
      throw new Error(`GitHub API rate limit exceeded. Review submission failed. Please wait ${Math.ceil(waitTime / 1000)} seconds and try again.`);
    }

    throw new Error(`Failed to submit review: ${error.message}`);
  }

  /**
   * Search GitHub pull requests using the search API.
   * @param {string} searchQuery - Search query string (e.g., "is:pr is:open user-review-requested:USERNAME")
   * @returns {Promise<Array<{owner: string, repo: string, number: number, title: string, author: string, updated_at: string, html_url: string, state: string}>>}
   */
  async searchPullRequests(searchQuery) {
    const items = await this.octokit.paginate(
      this.octokit.rest.search.issuesAndPullRequests,
      { q: searchQuery, per_page: 100 }
    );

    return items.map(item => {
      const parts = item.repository_url.split('/');
      const repo = parts.pop();
      const owner = parts.pop();

      return {
        owner,
        repo,
        number: item.number,
        title: item.title,
        author: item.user?.login || null,
        updated_at: item.updated_at,
        html_url: item.html_url,
        state: item.state
      };
    });
  }

  /**
   * List open pull requests for a single repository via the REST API.
   *
   * Used by the dashboard collections sweep against alt-hosts, which speak a
   * REST subset and generally have no Search API. The returned rows carry the
   * classification fields (`author`, `requested_reviewers`, `requested_teams`)
   * so the caller can bucket each PR into a collection locally, plus the same
   * display fields `searchPullRequests` returns so both paths cache uniformly.
   *
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {Promise<Array<{owner: string, repo: string, number: number, title: string, author: string|null, updated_at: string, html_url: string, state: string, requested_reviewers: string[], requested_teams: string[]}>>}
   */
  async listOpenPullRequests(owner, repo) {
    const pulls = await this.octokit.paginate(
      this.octokit.rest.pulls.list,
      { owner, repo, state: 'open', per_page: 100 }
    );

    return pulls.map(pr => ({
      owner,
      repo,
      number: pr.number,
      title: pr.title,
      author: pr.user?.login || null,
      updated_at: pr.updated_at,
      html_url: pr.html_url,
      state: pr.state,
      requested_reviewers: Array.isArray(pr.requested_reviewers)
        ? pr.requested_reviewers.map(r => r && r.login).filter(Boolean)
        : [],
      requested_teams: Array.isArray(pr.requested_teams)
        ? pr.requested_teams.map(t => t && t.slug).filter(Boolean)
        : []
    }));
  }

  /**
   * Get the authenticated user's information.
   * @returns {Promise<{login: string, name: string, avatar_url: string}>}
   */
  async getAuthenticatedUser() {
    const { data } = await this.octokit.rest.users.getAuthenticated();
    return {
      login: data.login,
      name: data.name,
      avatar_url: data.avatar_url
    };
  }

  /**
   * Retry API calls with exponential backoff
   * @param {Function} apiCall - The API call function
   * @param {number} maxRetries - Maximum number of retries
   * @param {number} baseDelay - Base delay in milliseconds
   * @returns {Promise<any>} API call result
   */
  async retryWithBackoff(apiCall, maxRetries = 3, baseDelay = 1000) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await apiCall();
      } catch (error) {
        lastError = error;

        if (error.status === 401 || error.status === 404) {
          throw error;
        }

        if (error.status === 403 || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
          if (attempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, attempt);
            console.log(`Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }

        throw error;
      }
    }

    throw lastError;
  }

  /**
   * Find an open PR for the given branch name.
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} branch - Head branch name (without owner: prefix)
   * @returns {Promise<{baseBranch: string, prNumber: number}|null>} Base branch info or null
   */
  async findPRByBranch(owner, repo, branch) {
    try {
      const { data: pulls } = await this.octokit.rest.pulls.list({
        owner,
        repo,
        head: `${owner}:${branch}`,
        state: 'open',
        per_page: 1
      });

      if (pulls.length > 0) {
        return {
          baseBranch: pulls[0].base.ref,
          prNumber: pulls[0].number
        };
      }
      return null;
    } catch (error) {
      logger.warn(`Could not look up PR for branch ${branch}: ${error.message}`);
      return null;
    }
  }
}

module.exports = {
  GitHubClient,
  GitHubApiError,
  isComplexityError,
  // Exported so tests can assert that the bare-token defaults stay in
  // sync with the canonical `GRAPHQL_DEFAULT_AREAS` set in `src/config.js`.
  DEFAULT_FEATURES,
  // Exported for unit tests asserting binding normalisation (e.g. that the
  // `refresh` capability is preserved for object bindings and null for the
  // legacy bare-token path).
  normaliseBinding
};
