// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Hook payload builders.
 *
 * Pure functions that assemble event-specific JSON payloads from
 * route-level data.  Keeps integration-point changes minimal.
 */

const { version } = require('../../package.json');
const logger = require('../utils/logger');
const { getGitHubToken } = require('../config');

const defaultDeps = {
  GitHubClient: null,   // lazy-loaded to avoid circular deps
  getGitHubToken,
  logger,
};

// Module-level user cache (one GitHub API call per server session)
let cachedUser = undefined; // undefined = not yet resolved, null = no token / failed

// ── Shared context builder ──────────────────────────────────────

function buildContextFields({ mode, prContext, localContext, user }) {
  const fields = { mode };
  if (user) fields.user = user;
  if (mode === 'pr' && prContext) {
    fields.pr = { ...prContext };
  } else if (mode === 'local' && localContext) {
    fields.local = { ...localContext };
  }
  return fields;
}

// ── Review payloads ─────────────────────────────────────────────

function buildReviewPayload(event, { reviewId, mode, prContext, localContext, user }) {
  return {
    event,
    timestamp: new Date().toISOString(),
    version,
    reviewId,
    ...buildContextFields({ mode, prContext, localContext, user }),
  };
}

function buildReviewStartedPayload(opts) {
  return buildReviewPayload('review.started', opts);
}

function buildReviewLoadedPayload(opts) {
  return buildReviewPayload('review.loaded', opts);
}

// ── Analysis payloads ───────────────────────────────────────────

function buildAnalysisStartedPayload({ reviewId, analysisId, provider, model, mode, prContext, localContext, user }) {
  return {
    event: 'analysis.started',
    timestamp: new Date().toISOString(),
    version,
    reviewId,
    analysisId,
    provider: provider ?? null,
    model: model ?? null,
    ...buildContextFields({ mode, prContext, localContext, user }),
  };
}

function buildAnalysisCompletedPayload({
  reviewId, analysisId, provider, model, status,
  totalSuggestions, mode, prContext, localContext, user,
}) {
  return {
    event: 'analysis.completed',
    timestamp: new Date().toISOString(),
    version,
    reviewId,
    analysisId,
    provider: provider ?? null,
    model: model ?? null,
    status,
    totalSuggestions: totalSuggestions ?? 0,
    ...buildContextFields({ mode, prContext, localContext, user }),
  };
}

// ── Chat payloads ───────────────────────────────────────────────

function buildChatPayload(event, { reviewId, sessionId, provider, model, mode, prContext, localContext, user }) {
  return {
    event,
    timestamp: new Date().toISOString(),
    version,
    reviewId,
    sessionId,
    provider: provider ?? null,
    model: model ?? null,
    ...buildContextFields({ mode, prContext, localContext, user }),
  };
}

function buildChatStartedPayload(opts) {
  return buildChatPayload('chat.started', opts);
}

function buildChatResumedPayload(opts) {
  return buildChatPayload('chat.resumed', opts);
}

/**
 * Derive hook context fields (mode, prContext/localContext) from a review record.
 * @param {Object} review - Review record from the database
 * @returns {{ mode: string, prContext?: Object, localContext?: Object }}
 */
function buildChatHookContext(review) {
  if (review.review_type === 'local') {
    return {
      mode: 'local',
      localContext: {
        path: review.local_path ?? null,
        branch: review.local_head_branch ?? null,
        headSha: review.local_head_sha ?? null,
      },
    };
  }
  const [owner, repo] = (review.repository || '').split('/');
  return {
    mode: 'pr',
    prContext: {
      number: review.pr_number ?? null,
      owner: owner || null,
      repo: repo || null,
    },
  };
}

// ── User identity ───────────────────────────────────────────────

/**
 * Resolve the current GitHub user, caching the result for the server session.
 * Returns `{ login }` or `null` if no token / lookup fails.
 */
async function getCachedUser(config, _deps) {
  if (cachedUser !== undefined) return cachedUser;

  const deps = { ...defaultDeps, ..._deps };

  const token = deps.getGitHubToken(config || {});
  if (!token) {
    cachedUser = null;
    return null;
  }

  try {
    // Lazy-load to avoid circular dependency at require time
    const GHClient = deps.GitHubClient || require('../github/client').GitHubClient;
    const client = new GHClient(token);
    const user = await client.getAuthenticatedUser();
    cachedUser = { login: user.login };
  } catch (err) {
    deps.logger.warn(`Failed to resolve GitHub user for hooks: ${err.message}`);
    cachedUser = null;
  }

  return cachedUser;
}

function _resetUserCache() {
  cachedUser = undefined;
}

// ── Convenience: fire review.started in one call ────────────────

const defaultFireDeps = {
  fireHooks: null, // lazy-loaded to avoid circular deps
};

/**
 * Build and fire a `review.started` hook for a PR review.
 *
 * Encapsulates the full sequence: build prContext, resolve the GitHub
 * user, assemble the payload, and fire. Callers should use `.catch()`.
 */
async function fireReviewStartedHook({ reviewId, prNumber, owner, repo, prData, config }, _deps) {
  const deps = { ...defaultFireDeps, ..._deps };
  const prContext = {
    number: prNumber, owner, repo,
    author: prData.author, baseBranch: prData.base_branch, headBranch: prData.head_branch,
    baseSha: prData.base_sha || null, headSha: prData.head_sha || null,
  };
  const user = await getCachedUser(config);
  const payload = buildReviewStartedPayload({ reviewId, mode: 'pr', prContext, user });
  const fire = deps.fireHooks || require('./hook-runner').fireHooks;
  fire('review.started', payload, config);
}

module.exports = {
  buildReviewStartedPayload,
  buildReviewLoadedPayload,
  buildAnalysisStartedPayload,
  buildAnalysisCompletedPayload,
  buildChatStartedPayload,
  buildChatResumedPayload,
  buildChatHookContext,
  getCachedUser,
  fireReviewStartedHook,
  _resetUserCache,
};
