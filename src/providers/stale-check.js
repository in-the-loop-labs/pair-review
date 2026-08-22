// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Stale Check Provider
 *
 * The shared half of the two `check-stale` endpoints:
 *   - `GET /api/pr/:owner/:repo/:number/check-stale`   (src/routes/pr.js)
 *   - `GET /api/local/:reviewId/check-stale`           (src/routes/local.js)
 *
 * Both need the same three things: a read-only look at a PR's head commit on
 * GitHub, one error vocabulary for when that look fails, and one way to turn a
 * set of staleness flags into the `reasons[]` array the frontend renders. The
 * mode-specific halves (a working-tree digest in local mode, the `pr_metadata`
 * cache in PR mode) stay in their routes.
 *
 * Follows the `defaults + _deps` DI pattern from `src/protocol-handler.js`.
 * Never re-resolves config internally — callers pass a resolved credential
 * (a host binding or a bare token) down.
 *
 * THIS PROVIDER NEVER WRITES TO `pr_metadata`
 * -------------------------------------------
 * `fetchPRMetadata` in src/providers/pr-context.js looks like the natural
 * reuse here — it already fetches a PR and handles host bindings — but it is
 * cache-first and WRITES THROUGH on a miss or a forced refresh. PR mode's
 * stale check compares the head_sha CACHED in `pr_metadata` against the one
 * GitHub reports right now; if the check itself updated that cache, the second
 * call would always find them equal and report "not stale" forever. The same
 * applies to local mode's `prAdvanced` flag, which is that same
 * cached-vs-remote comparison.
 *
 * So the fetch below goes straight to `GitHubClient` and touches no
 * repository. A staleness check is an observation, not a refresh; the refresh
 * has its own explicit path (`fetchPRMetadata({ forceRefresh: true })`, driven
 * by the `?refresh=1` pr-metadata endpoint). Do not "optimise" this into a
 * cache write.
 */

const { GitHubClient } = require('../github/client');
const logger = require('../utils/logger');

/**
 * Server-side deadline for the PR head fetch.
 *
 * The frontend aborts both check-stale requests after `STALE_TIMEOUT = 2000ms`
 * (public/js/pr.js). Local mode's check used to be pure local git work and
 * always beat that; adding an unbounded GitHub round-trip would mean a slow or
 * unreachable GitHub takes the WORKING-DIRECTORY staleness answer down with
 * it — a regression in local mode's core feature to serve an advisory extra.
 *
 * 1200ms leaves comfortable headroom under the client's 2000ms for the local
 * git work that runs concurrently plus response serialisation. Overridable per
 * call (`timeoutMs`) and via `_deps.prHeadTimeoutMs` for tests.
 */
const PR_HEAD_CHECK_TIMEOUT_MS = 1200;

const PR_HEAD_TIMEOUT_ERROR = 'PR head check timed out';

const defaults = {
  GitHubClient,
  logger,
  prHeadTimeoutMs: PR_HEAD_CHECK_TIMEOUT_MS,
};

/**
 * Every staleness reason the two routes can report, with its default message.
 *
 * Messages carry NO commit SHAs. The frontend abbreviates SHAs with the repo's
 * own `core.abbrev` length (see `_checkStalenessOnLoad` in public/js/pr.js),
 * so a SHA baked in here would either duplicate that formatting or contradict
 * it. The route ships the raw SHAs as separate fields; the message says only
 * WHAT changed.
 *
 * Declaration order is the wire order — see `buildStaleReasons`.
 */
const STALE_REASONS = Object.freeze({
  'working-tree-changed': 'Working directory has changed since the diff was captured.',
  'local-head-moved': 'Local HEAD has moved since the diff was captured.',
  'no-baseline-digest': 'No baseline digest — refresh to enable staleness detection.',
  'digest-unavailable': 'Could not compute the current digest — refresh recommended.',
  'head-sha-unavailable': 'Could not read the local HEAD commit.',
  'pr-head-moved': 'The pull request has new commits.',
  'local-head-differs-from-pr': 'Your local HEAD differs from the pull request head commit.',
  'pr-closed': 'The pull request has been closed.',
  'pr-merged': 'The pull request has been merged.',
});

/**
 * Turn a flag bag into the ordered `reasons[]` array both routes ship.
 *
 * Ordering is the declaration order of `STALE_REASONS`, NOT the key order of
 * `flags` — the frontend renders this list verbatim, so two requests with the
 * same set of true flags must produce the same list. Unknown keys are ignored
 * (a caller flagging a code this provider does not know is a caller bug, not a
 * reason to invent a message for it).
 *
 * @param {Object<string, boolean>} [flags]
 * @returns {Array<{code: string, message: string}>} always an array
 */
function buildStaleReasons(flags) {
  if (!flags || typeof flags !== 'object') return [];
  const reasons = [];
  for (const [code, message] of Object.entries(STALE_REASONS)) {
    if (flags[code]) reasons.push({ code, message });
  }
  return reasons;
}

/**
 * Map a GitHub failure onto the user-facing string both routes report.
 *
 * Started as the mapping that lived in `routes/pr.js`'s check-stale catch
 * block, so the two routes cannot drift into two error vocabularies.
 *
 * MATCH THE SHAPES `GitHubClient` ACTUALLY THROWS
 * -----------------------------------------------
 * The only producer feeding this function is `GitHubClient.fetchPullRequest`,
 * and every failure it raises goes through `handleApiError`, which NORMALISES
 * before rethrowing: ENOTFOUND/ECONNREFUSED become `GitHubApiError(..., 503)`
 * and rate limits become `GitHubApiError(..., 429)`. `GitHubApiError` carries
 * `name`, `message` and `status` only — it never copies `.code`. So the two
 * commonest transient failures used to fall through to `error.message` and
 * ship raw internals ("getaddrinfo ENOTFOUND api.github.com…", or a "Retrying
 * in 3600 seconds…" line that lies, because nothing on this fail-open path
 * retries). The status checks below are the ones that actually fire; the
 * `.code` checks stay as a secondary guard for callers passing a raw socket
 * error. Wording mirrors src/routes/worktrees.js so the whole app says the
 * same thing about the same failure.
 *
 * ALWAYS RETURNS A STRING. `error.message` is `undefined` for anything thrown
 * that is not Error-like, and `JSON.stringify` drops undefined-valued keys —
 * which silently deleted the `error` key from PR mode's fail-open response
 * (src/routes/pr.js).
 *
 * @param {Error|Object|null} error
 * @returns {string} never undefined
 */
function describeGitHubError(error) {
  if (!error) return 'Unknown GitHub error';
  if (error.status === 404) return 'PR not found on GitHub';
  if (error.status === 401 || error.status === 403) return 'GitHub authentication issue';
  if (error.status === 429) return 'GitHub API rate limit exceeded. Please try again later.';
  if (error.status === 503) return 'Could not connect to GitHub';
  if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
    return 'Could not connect to GitHub';
  }
  return (error.message && String(error.message)) || 'Unknown GitHub error';
}

/**
 * Drop the token-refresh capability from a credential, preserving token, host
 * and feature fields.
 *
 * `GitHubClient` retries a 401 by calling `binding.refresh()` — and for a
 * `token_command` binding that closure invalidates the cached token and
 * re-runs the command through `execSync`, blocking the event loop for up to
 * five seconds. Both check-stale routes are ADVISORY and fail open under a
 * client that abandons the response at `STALE_TIMEOUT = 2000ms`, so that block
 * cannot help them: it can only take down the answer they exist to give (in
 * local mode, the working-tree verdict computed on the same request).
 *
 * Resolving the credential `cachedTokensOnly` is not enough on its own — that
 * governs whether a command runs to PRODUCE the binding, while `refresh` is a
 * closure carried ON a cached binding that deliberately does not inherit the
 * flag (src/config.js: "the refresh closure exists to RE-RUN the command").
 * A warm cache holding an expired token therefore still shells out, on exactly
 * the path that must not.
 *
 * Without the closure a 401 falls through `describeGitHubError` as
 * "GitHub authentication issue", which is the correct advisory answer.
 *
 * @param {Object|string|null} credential - Host binding or bare token.
 * @returns {Object|string|null} The same value when there is nothing to strip;
 *   otherwise a shallow copy with `refresh: null`.
 */
function withoutTokenRefresh(credential) {
  if (!credential || typeof credential !== 'object') return credential;
  if (typeof credential.refresh !== 'function') return credential;
  return { ...credential, refresh: null };
}

/**
 * Read a PR's current head commit from GitHub. READ-ONLY — see the module
 * docblock: nothing here touches `pr_metadata`.
 *
 * Never throws: every failure comes back as `{ ok: false, error }` so callers
 * on fail-open paths (both check-stale routes are fail-open) need no try/catch
 * and no `.catch()` of their own.
 *
 * @param {Object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.prNumber
 * @param {Object|string} params.credential - Resolved host binding, or a bare
 *   github.com token. Resolve it with `resolveFetchCredential`
 *   (src/providers/pr-context.js) — never `binding.token || globalToken`.
 *   Its `refresh` closure is stripped here; see `withoutTokenRefresh`.
 * @param {AbortSignal} [params.signal] - Cancels the in-flight HTTP request.
 *   `checkPRHeadState` passes one so its deadline actually CANCELS the fetch
 *   rather than merely walking away from it.
 * @param {Object} [_deps]
 * @returns {Promise<{ok: true, headSha: string|null, baseSha: string|null, state: string|null, merged: boolean}
 *   | {ok: false, error: string}>}
 */
async function fetchRemotePRHead({ owner, repo, prNumber, credential, signal } = {}, _deps) {
  const deps = { ...defaults, ..._deps };

  if (!owner || !repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    return { ok: false, error: 'Invalid pull request target' };
  }
  if (!credential) return { ok: false, error: 'GitHub token not configured' };

  try {
    const client = new deps.GitHubClient(withoutTokenRefresh(credential));
    const prData = await client.fetchPullRequest(owner, repo, prNumber, { signal });
    if (!prData) return { ok: false, error: 'PR not found on GitHub' };
    return {
      ok: true,
      headSha: prData.head_sha || null,
      baseSha: prData.base_sha || null,
      state: prData.state || null,
      merged: Boolean(prData.merged),
    };
  } catch (error) {
    return { ok: false, error: describeGitHubError(error) };
  }
}

/**
 * `fetchRemotePRHead` under a deadline, shaped into the `prHead` block the
 * local route ships.
 *
 * The caller owns the fields it alone knows — `prNumber`, `repository`, and
 * the LOCAL head (`localHeadSha` / `drifted`), which in local mode is only
 * resolved after this call has already been kicked off.
 *
 * Never throws.
 *
 * @param {Object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.prNumber
 * @param {string|null} [params.knownHeadSha] - The head_sha already on record
 *   for this PR (the `pr_metadata` cache). `prAdvanced` is remote-vs-this.
 * @param {Object|string} params.credential
 * @param {number} [params.timeoutMs] - Defaults to `PR_HEAD_CHECK_TIMEOUT_MS`.
 * @param {Object} [_deps]
 * @returns {Promise<{checked: true, remoteHeadSha: string|null, cachedHeadSha: string|null,
 *   prAdvanced: boolean, prState: string|null, merged: boolean, error: string|null}>}
 */
async function checkPRHeadState({ owner, repo, prNumber, knownHeadSha = null, credential, timeoutMs } = {}, _deps) {
  const deps = { ...defaults, ..._deps };
  // Both overrides are checked for finiteness, not merely for presence. An
  // explicit `_deps: { prHeadTimeoutMs: undefined }` overwrites the default via
  // the spread, and `setTimeout(fn, undefined)` is a ZERO-ms deadline — the
  // check would give up before the fetch ever started, silently reporting "PR
  // head check timed out" on every call. Fall all the way back to the constant.
  const deadlineMs = Number.isFinite(timeoutMs)
    ? timeoutMs
    : (Number.isFinite(deps.prHeadTimeoutMs) ? deps.prHeadTimeoutMs : PR_HEAD_CHECK_TIMEOUT_MS);

  let timer = null;
  let result;
  // The deadline must CANCEL, not just stop waiting. `Promise.race` alone
  // leaves the losing HTTP request — plus any auth or rate-limit retry Octokit
  // performs internally — in flight with its result thrown away; the timer is
  // `unref`'d but the socket is not. This check now fires on every local page
  // load AND after every refresh, so against a hung GitHub the abandoned
  // requests would accumulate per check rather than per page view.
  const controller = new AbortController();
  try {
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: PR_HEAD_TIMEOUT_ERROR }), deadlineMs);
      // Never hold the process open for an advisory check.
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    result = await Promise.race([
      fetchRemotePRHead({ owner, repo, prNumber, credential, signal: controller.signal }, _deps),
      deadline,
    ]);
  } catch (error) {
    // `fetchRemotePRHead` does not throw; this is belt-and-braces so a
    // surprise here can never reject on a caller's early-return path.
    result = { ok: false, error: describeGitHubError(error) };
  } finally {
    if (timer) clearTimeout(timer);
    // No-op when the fetch already answered; the abandoned request is only
    // ever the losing one.
    controller.abort();
  }

  if (!result.ok) {
    deps.logger.debug(
      `PR head check failed for #${prNumber} ${owner}/${repo}: ${result.error}`
    );
  }

  const remoteHeadSha = result.ok ? (result.headSha || null) : null;
  const cachedHeadSha = knownHeadSha || null;

  return {
    checked: true,
    remoteHeadSha,
    cachedHeadSha,
    // Both operands must be known — an unknown SHA is not evidence of movement.
    prAdvanced: Boolean(remoteHeadSha && cachedHeadSha && remoteHeadSha !== cachedHeadSha),
    prState: result.ok ? (result.state || null) : null,
    merged: result.ok ? Boolean(result.merged) : false,
    error: result.ok ? null : (result.error || 'PR head check failed'),
  };
}

module.exports = {
  STALE_REASONS,
  PR_HEAD_CHECK_TIMEOUT_MS,
  PR_HEAD_TIMEOUT_ERROR,
  buildStaleReasons,
  describeGitHubError,
  withoutTokenRefresh,
  fetchRemotePRHead,
  checkPRHeadState,
};
