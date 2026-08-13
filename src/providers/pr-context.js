// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * PR Context Provider
 *
 * Shared helpers that resolve a local review's associated GitHub PR (if any)
 * and expose a normalized context object to both `routes/local.js` and
 * future Phase 2-5 features. Both the local route and (eventually) the PR
 * route consume these helpers — keeps the bridge between modes in one place.
 *
 * Phase 0 scope: thin DB-only lookups.
 * Phase 1 adds `fetchPRMetadata` (cached) and `getCachedPRMetadata` (DB-only).
 *
 * Follows the `defaults + _deps` DI pattern from `src/protocol-handler.js`.
 * Never re-resolves config internally — callers pass resolved values down.
 */

const { ReviewRepository, PRMetadataRepository } = require('../database');
const { GitHubClient } = require('../github/client');
const logger = require('../utils/logger');

const defaults = {
  ReviewRepository,
  PRMetadataRepository,
  GitHubClient,
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
 *     - hasGitHubToken: a credential exists that GitHub calls for THIS review
 *       would actually be made with. Not "the server has some token": for an
 *       associated PR it must agree with `resolveFetchCredential`, which fails
 *       closed for an alt-host binding carrying no token even when a global
 *       github.com token is configured. Callers compute it with that helper
 *       so the flag cannot drift from what `fetchPRMetadata` will do —
 *       Phases 2-5 (`canViewPRComments`, `canSubmitToGitHub`) gate on it.
 *       One narrow exception, deliberately not folded in: a DUAL repo
 *       (github.com + alt host) has a usable credential, so this stays true,
 *       but `fetchPRMetadata` still declines to fetch because the HOST is a
 *       guess (see its `hostAmbiguous` gate). "Credential exists" and "host
 *       known" are different questions; the cost is one cache-warm call that
 *       returns null and is then suppressed by the shared negative memo.
 *
 *   Action contracts — false until the matching endpoint/UI ships. These
 *   advertise specific operations the frontend may invoke. Each one flips
 *   true ONLY in the phase that lands the implementation. Hard-coding
 *   `false` in Phase 0 keeps the contract honest: prerequisite state being
 *   true does not imply the action is available.
 *
 *     - canShowPRMetadata: Phase 1 — true when prMetadataAvailable
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
 * @param {boolean} params.hasToken - Whether a usable credential exists for
 *   this review's repository. Compute it with `resolveFetchCredential`, not
 *   with a bare `binding?.token || globalToken` check.
 * @param {boolean} [params.prMetadataAvailable] - Cached PR metadata exists
 *   for the association. Drives `canShowPRMetadata`.
 * @returns {Object} capabilities object
 */
function buildCapabilities({ association, hasToken, prMetadataAvailable } = {}) {
  const hasAssociatedPR = Boolean(association && association.prNumber && association.repository);
  return {
    // Prerequisite state
    hasAssociatedPR,
    hasGitHubToken: Boolean(hasToken),
    // Action contracts — each phase flips its own when the implementation
    // lands. Frontend `hasCapability(name)` consumers see false until the
    // action is real.
    canShowPRMetadata: Boolean(hasAssociatedPR && prMetadataAvailable),
    canViewPRComments: false,   // Phase 2 flips true
    canCheckStaleVsPR: false,   // Phase 3 flips true
    canSyncDrafts: false,       // Phase 4 flips true
    canSubmitToGitHub: false,   // Phase 5 flips true
  };
}

/**
 * Resolve the credential a PR-metadata fetch for `repository` would actually
 * use — or null when there is none.
 *
 * Prefer the resolved binding; fall back to the bare token for legacy callers.
 * A binding with no token is unusable — fall back rather than letting the
 * `GitHubClient` constructor throw.
 *
 * ...but ONLY when the binding does not name an alt host. `resolveHostBinding`
 * deliberately refuses to hand github.com top-level credentials to an alt-host
 * binding (src/config.js: "github.com top-level credentials are not used for
 * alt-hosts"), so a binding of `{ host: 'https://ghe.../api/v3', token: '' }`
 * means "no usable credential for this host", NOT "no binding". Borrowing
 * `githubToken` there would send a github.com credential to a GHE repo — and
 * since `GitHubClient.normaliseBinding` maps a bare string to `apiHost: null`,
 * the request would go to api.github.com instead. A same-named github.com repo
 * (routine for mirrored/open-sourced GHE repos) would then cache a DIFFERENT
 * PR's title/author/url, stamped with the GHE host, in a row the cache-first
 * read in `fetchPRMetadata` never expires. Fail closed, like `tryGitHubPR`.
 *
 * Exported because this rule is ALSO the definition of the `hasGitHubToken`
 * capability: `src/routes/local.js` computes that boolean at two endpoints, and
 * a capability that says "reachable" where `fetchPRMetadata` returns null is a
 * lie the Phase 2-5 action flags would inherit. One rule, one implementation.
 *
 * @param {Object|null} [hostBinding] - Result of `resolveHostBinding`
 * @param {string} [githubToken] - Bare github.com token, for callers with no
 *   resolved binding
 * @returns {Object|string|null} the binding, the bare token, or null when no
 *   usable credential exists for this repository
 */
function resolveFetchCredential(hostBinding, githubToken) {
  if (hostBinding && hostBinding.token) return hostBinding;
  const bindsAltHost = Boolean(hostBinding && (hostBinding.host || hostBinding.apiHost));
  return bindsAltHost ? null : (githubToken || null);
}

/**
 * Normalize a pr_metadata row (with `pr_data` JSON merged via
 * `PRMetadataRepository.getByPR`) into the small surface the frontend
 * cares about for the header badge.
 *
 * `state` is passed through verbatim — GitHub only ever returns 'open' or
 * 'closed', and `merged` is a separate boolean. Deliberately NOT collapsed
 * into a derived `state: 'merged'` here: this payload is the Phase 2-5
 * surface, so a later staleness check reading `state` would get a value the
 * GitHub API never produces. Consumers derive the display state at the
 * render site (see `renderAssociatedPRPill` in public/js/local.js).
 *
 * @param {Object} row - Row from PRMetadataRepository.getByPR
 * @returns {{title: string|null, author: string|null, url: string|null, state: string|null, merged: boolean, head_sha: string|null}}
 */
function normalizePRMetadata(row) {
  if (!row) return null;
  const parsed = row.pr_data_parsed || {};
  return {
    title: row.title ?? null,
    author: row.author ?? null,
    url: parsed.html_url ?? null,
    state: parsed.state ?? null,
    merged: Boolean(parsed.merged),
    head_sha: row.head_sha ?? parsed.head_sha ?? null,
  };
}

/**
 * Read PR metadata from the `pr_metadata` cache only. Never hits GitHub.
 * Used by `GET /api/local/:reviewId` so the response is not blocked on a
 * remote round-trip — a cache miss kicks off a background refresh via
 * `fetchPRMetadata`, and the client picks the result up from the blocking
 * `GET /api/local/:reviewId/pr-metadata` endpoint (that route is not polled).
 *
 * @param {Object} params
 * @param {number} params.prNumber
 * @param {string} params.repository
 * @param {Object} params.db
 * @param {Object} [params._deps]
 * @returns {Promise<Object|null>} normalized metadata or null
 */
async function getCachedPRMetadata({ prNumber, repository, db, _deps } = {}) {
  if (!db || !prNumber || !repository) return null;
  const deps = { ...defaults, ..._deps };
  const repo = new deps.PRMetadataRepository(db);
  const row = await repo.getByPR(prNumber, repository);
  return normalizePRMetadata(row);
}

/**
 * Fetch (and cache) PR metadata. Cache-first: returns the cached row
 * unchanged on a hit; on a miss calls GitHub once and writes through.
 *
 * Host binding: when the caller resolved a binding for this repository, pass
 * it as `hostBinding` and it is handed to `GitHubClient` INSTEAD of the bare
 * token — the same `binding || token` shape `tryGitHubPR` uses at
 * src/git/base-branch.js:148-153. This is the seam that enforces the
 * invariant rather than relying on caller discipline: a bare token is
 * normalised by `GitHubClient` into a github.com binding, so an alt-host or
 * repo-scoped-credential repo would otherwise be queried against github.com
 * with the wrong credential. The binding's `host` is also stamped into the
 * cached row, so a later PR-mode session resolves the same host.
 *
 * GUESSED HOSTS ARE NEVER PERSISTED
 * ---------------------------------
 * A binding carrying `hostAmbiguous: true` came from the two-argument
 * ambiguity rule on a DUAL repo (`api_host` + `exclusive: false`) — the caller
 * did not resolve which host this PR actually lives on, it defaulted to the
 * github.com flavour. On a COLD cache this method would (a) query a host the
 * PR may not be on, where a same-numbered PR is routine, and (b) INSERT a
 * pr_metadata row stamping that guess.
 *
 * There is no way to insert an honest "unknown": omitting `host`, passing
 * `undefined`, and passing `null` all store SQL NULL, and
 * `storedHostToOption` maps NULL on a dual repo to `{ host: null }` — so
 * PR-mode setup (src/setup/pr-setup.js) reads the row back as
 * `hostKnown = true`, takes the fixed-binding branch, and never runs the
 * alt-host-first probe that exists precisely to answer this question. A
 * background cache warm the user never asked for would therefore pin the pair
 * to github.com permanently.
 *
 * The only honest encoding of "unknown" is the ABSENCE of a row, so an
 * ambiguous binding short-circuits to null on a cache miss: no GitHub call, no
 * row, pill hidden for that one config until git-remote-derived host
 * resolution lands. A cache HIT is unaffected — an existing row was stamped by
 * whoever genuinely resolved the host.
 *
 * Returns null without throwing when:
 *   - inputs are missing (no prNumber/repository/db)
 *   - repository is not in owner/repo form
 *   - the cache is cold and the binding's host is a guess (`hostAmbiguous`)
 *   - neither a binding token nor a bare token is available and the cache is cold
 *   - the binding names an alt host but carries no token (fails CLOSED — the
 *     bare github.com token is never borrowed for an alt host; see below)
 *   - the GitHub call fails (logged, swallowed — caller sees missing cache)
 *
 * @param {Object} params
 * @param {number} params.prNumber
 * @param {string} params.repository - owner/repo
 * @param {string} [params.githubToken] - Bare-token fallback for callers with
 *   no resolved binding. Prefer `hostBinding`.
 * @param {Object} [params.hostBinding] - Result of `resolveHostBinding` for
 *   `repository`. Takes precedence over `githubToken`. May additionally carry
 *   `hostAmbiguous: true` — a marker the CALLER adds (see
 *   `resolveRepositoryBinding` in src/routes/local.js), NOT a field
 *   `resolveHostBinding` produces. Absent means "not known to be a guess",
 *   never "verified".
 * @param {Object} params.db
 * @param {Object} [params._deps]
 * @returns {Promise<Object|null>} normalized metadata or null
 */
async function fetchPRMetadata({ prNumber, repository, githubToken, hostBinding, db, _deps } = {}) {
  if (!db || !prNumber || !repository) return null;
  const deps = { ...defaults, ..._deps };
  const parts = splitRepository(repository);
  if (!parts) return null;

  const repo = new deps.PRMetadataRepository(db);
  const cached = await repo.getByPR(prNumber, repository);
  if (cached) return normalizePRMetadata(cached);

  // Cold cache + a guessed host → refuse. Writing the row is the harm (see
  // "GUESSED HOSTS ARE NEVER PERSISTED"), and fetching without writing would
  // both show possibly-wrong metadata and re-hit GitHub on every page load.
  if (hostBinding && hostBinding.hostAmbiguous) {
    deps.logger.debug?.(
      `fetchPRMetadata skipped for #${prNumber} ${repository}: host is ambiguous ` +
      '(dual github.com + alt-host repo, host not resolved) — refusing to cache a guessed host'
    );
    return null;
  }

  // One rule, three call sites — see `resolveFetchCredential` for why an
  // alt-host binding with an empty token fails CLOSED instead of borrowing
  // the bare github.com token.
  const credential = resolveFetchCredential(hostBinding, githubToken);
  if (!credential) return null;

  try {
    const client = new deps.GitHubClient(credential);
    const prData = await client.fetchPullRequest(parts.owner, parts.repo, prNumber);
    if (!prData) return null;
    await repo.upsertPRMetadata({
      prNumber,
      repository,
      prData,
      // `resolveHostBinding` returns `host: apiHost` — the alt-host URL or
      // null for github.com. Guessed hosts never get here (gated above), so
      // this is a host the caller genuinely resolved. Without a binding at all
      // the credential is a bare github.com token, and NULL is the established
      // "github.com" encoding.
      host: (hostBinding && hostBinding.host) ? hostBinding.host : null
    });
    const fresh = await repo.getByPR(prNumber, repository);
    return normalizePRMetadata(fresh);
  } catch (err) {
    deps.logger.warn(`fetchPRMetadata failed for #${prNumber} ${repository}: ${err.message}`);
    return null;
  }
}

module.exports = {
  getAssociatedPR,
  getPRContext,
  buildCapabilities,
  splitRepository,
  getCachedPRMetadata,
  fetchPRMetadata,
  resolveFetchCredential,
};
