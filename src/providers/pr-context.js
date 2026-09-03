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
 * Never re-resolves config internally — callers pass resolved values down
 * (the host-binding helpers below take an already-loaded `config` object).
 *
 * HOST RESOLUTION LIVES HERE ON PURPOSE
 * -------------------------------------
 * `resolveRepositoryBinding` (the WRITE side) sits beside `fetchPRMetadata`
 * (the READ side) because they must never disagree — see that function for
 * the invariant and what breaks without it.
 *
 * The placement is forced: it cannot live in `src/routes/local.js` (which
 * `local-review.js` cannot require back without a cycle) nor in
 * `src/utils/host-resolution.js`, since a util requiring a provider would
 * invert the layering. So it lives with its READ-side twin, one layer above
 * the primitives it composes.
 */

const { ReviewRepository, PRMetadataRepository } = require('../database');
const { GitHubClient } = require('../github/client');
// Namespace import (not destructured) so `resolveHostBinding` is resolved off
// the module object at CALL time. Tests wrap `config.resolveHostBinding` to
// observe what a route actually bound (tests/unit/wiring/local-host-binding.test.js),
// and a destructured binding captured at load would bypass the wrapper.
const configModule = require('../config');
const hostResolution = require('../utils/host-resolution');
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
 * Resolve the host binding for a `repos[...]` binding KEY, never throwing.
 *
 * Standing invariant: if a repo has an alt host configured, EVERY GitHub call
 * for that repo must go through the resolved binding, never the bare global
 * token — `GitHubClient` normalises a bare token into a github.com binding,
 * which silently targets the wrong host with the wrong credential. The binding
 * also carries repo-scoped `token` / `token_command` credentials that
 * `app.get('githubToken')` (the GLOBAL token, set in src/server.js) does not.
 *
 * Called with no `hostOption`, `resolveHostBinding` only applies the ambiguity
 * rule and cannot throw — but local mode resolves bindings on a background
 * path where a config-shape surprise must not take down the request, so the
 * failure is logged and downgraded to "no binding" (bare-token fallback).
 * With a `hostOption` it CAN throw (an exclusive alt-host repo asked for
 * `{ host: null }`, or a host that no longer matches the configured
 * `api_host`); the never-throws contract covers that case too, which is what
 * makes it safe to hand it a host derived from the checkout's git remote.
 *
 * Takes a binding KEY (user-chosen; need not look like owner/repo). Callers
 * holding a repository IDENTITY must go through `resolveRepositoryBinding`,
 * which performs the identity → key translation first.
 *
 * @param {string} bindingRepository - `repos[...]` config-lookup key
 * @param {Object} config - Application config
 * @param {{host: string|null}} [hostOption] - Explicit host selection, in the
 *   `resolveHostBinding` options shape. Omit to apply the ambiguity rule.
 * @returns {Object|null} binding, or null when resolution threw
 */
function tryResolveHostBinding(bindingRepository, config, hostOption, { cachedTokensOnly = false } = {}) {
  // Shape-preserving: with neither a host override nor cache-only resolution
  // this stays the two-argument call, which is what the ambiguity rule in
  // `resolveHostBinding` keys on (and what the dual-host tests assert).
  const options = { ...(hostOption || {}) };
  if (cachedTokensOnly) options.cachedTokensOnly = true;
  try {
    return (hostOption || cachedTokensOnly)
      ? configModule.resolveHostBinding(bindingRepository, config || {}, options)
      : configModule.resolveHostBinding(bindingRepository, config || {});
  } catch (err) {
    logger.warn(`Host binding resolution failed for ${bindingRepository}: ${err.message}`);
    return null;
  }
}

/**
 * Per-process memo of a checkout's `remote.origin.url` hostname.
 *
 * `getRemoteHostname` shells out to `git config --get remote.origin.url`, and
 * the dual-host resolution below runs on the hot path of
 * `GET /api/local/:reviewId` (and again on `/pr-metadata`), so an unmemoized
 * read is one subprocess per request per review.
 *
 * Keyed on the checkout PATH, with no invalidation: a local review is bound to
 * one checkout, and a remote URL changing mid-process is not a supported
 * scenario. `null` results are memoized too (a repo with no remote must not be
 * re-probed every load), so the lookup uses `has()` — `undefined` is the "not
 * yet looked up" sentinel.
 */
let remoteHostnameCache = new Map();

function _clearRemoteHostnameCache() {
  remoteHostnameCache = new Map();
}

function getMemoizedRemoteHostname(localPath) {
  if (!localPath) return null;
  if (remoteHostnameCache.has(localPath)) return remoteHostnameCache.get(localPath);
  let hostname = null;
  try {
    hostname = hostResolution.getRemoteHostname(localPath);
  } catch (err) {
    // getRemoteHostname already swallows git failures; this is belt-and-braces
    // so a surprise here can never take down a request.
    logger.debug(`Remote hostname lookup failed for ${localPath}: ${err.message}`);
    hostname = null;
  }
  remoteHostnameCache.set(localPath, hostname);
  return hostname;
}

/**
 * Resolve a DUAL repo's real host from the local checkout's git remote — the
 * one place the answer sits on disk. See `resolveRepositoryBinding` for why
 * this evidence path runs before the ambiguity-rule guess.
 *
 * @param {string} bindingRepository - `repos[...]` config-lookup KEY, not an
 *   `owner/repo` identity
 * @returns {Object|null} a concrete binding, or null when the remote is
 *   missing, unparseable, or matches neither host ("still ambiguous")
 */
function resolveDualHostFromRemote(bindingRepository, config, localPath, { cachedTokensOnly = false } = {}) {
  if (!localPath) return null;
  const remoteHostname = getMemoizedRemoteHostname(localPath);
  if (!remoteHostname) return null;
  const apiHost = hostResolution.getConfiguredApiHost(config, bindingRepository);
  const hostOption = hostResolution.remoteHostnameToHostOption(remoteHostname, apiHost);
  if (!hostOption) return null;
  return tryResolveHostBinding(bindingRepository, config, hostOption, { cachedTokensOnly });
}

/**
 * Short-lived negative memo for host-binding resolution.
 *
 * `resolveAssociationBinding` runs on the hot path of `GET /api/local/:reviewId`
 * and it runs BEFORE `res.json` — `hasGitHubToken` ships in that payload, so the
 * binding genuinely cannot be deferred below the response. `resolveHostBinding`
 * may shell out (`repos[...].token_command`, `config.github_token_command`).
 *
 * config.js memoizes only SUCCESSFUL command output: `_cachedRepoTokens.set` is
 * reached after the empty-output and throw checks, so `_runTokenCommand` returns
 * `''` UNCACHED on failure (src/config.js:489-501). A broken or expired command
 * — `gh auth token` with gh logged out is the common one — therefore re-runs
 * `execSync` with a 5s timeout on EVERY request and blocks the response for up
 * to five seconds each time.
 *
 * Caching that failure inside `_runTokenCommand` would be the general fix, but
 * it is a shared function with several callers outside this module; bounding the
 * exposure here is the surgical version. Only token-less resolutions are
 * memoized — a successful command is already cached in config.js for the life
 * of the process, and re-memoizing it here would shadow `binding.refresh()`.
 *
 * TTL is deliberately short (30s): long enough that a page load's burst (the
 * main GET, the /pr-metadata follow-up, and the frontend's retry budget)
 * collapses to a single shell-out, short enough that a user who repairs their
 * credential mid-session gets a live retry on their next reload rather than
 * being told "no GitHub" for minutes.
 *
 * Keyed by config object (WeakMap) then binding key, so a token-less result for
 * one config can never answer for another — production has exactly one config
 * object (loaded once at startup, no hot reload), and tests that mount a fresh
 * config are isolated for free.
 */
const HOST_BINDING_FAILURE_TTL_MS = 30 * 1000;
let hostBindingFailureCache = new WeakMap();

function _clearHostBindingFailureCache() {
  hostBindingFailureCache = new WeakMap();
}

/**
 * Resolve the host binding for a repository IDENTITY (`<owner>/<repo>` as
 * GitHub/the git remote reports it), NOT a config key.
 *
 * THE ONE RESOLVER FOR BOTH SIDES
 * -------------------------------
 * Detection (the WRITE side: `POST /api/local/start`, the CLI's
 * `setupLocalReviewSession`, and `runPRAssociationDetection` — all of which
 * persist `associated_pr_number` onto a review row) and metadata-fetch (the
 * READ side: `fetchPRMetadata` below) MUST resolve the host through this
 * function, so a PR can never be discovered on one host and then read from the
 * other. The association row is host-blind — it stores only a number and an
 * `owner/repo` — so if the two sides disagree the read side fetches an
 * unrelated same-numbered PR, stamps `pr_metadata.host` with it, and the
 * external-comments sync anchors a stranger's comments to the reviewer's code.
 * When the host cannot be determined, BOTH sides stay ambiguous and the read
 * side refuses (see `fetchPRMetadata`); do not relax that refusal to
 * compensate for a write site that guessed.
 *
 * `config.repos[...]` keys are not always the raw owner/repo: a monorepo-style
 * entry serves many captured owner/repo via `url_pattern`, and only
 * `resolveBindingRepositoryFromPR` probes for that (`resolveHostBinding` does
 * not). Skipping the translation makes `getRepoConfig` miss the entry, so the
 * binding silently degrades to github.com with the global token — the exact
 * failure the binding exists to prevent. Same order as every other repo-scoped
 * resolution in the codebase (src/server.js, src/setup/pr-setup.js,
 * src/routes/config.js, src/routes/stack-analysis.js,
 * src/external/github-adapter.js): identity → binding key → binding.
 *
 * Despite its name, `resolveBindingRepositoryFromPR` needs only the owner/repo
 * pair, so it is equally correct for a local review's own repository identity
 * (derived from the git remote) as for an associated PR's — both are the same
 * `<owner>/<repo>` shape it matches `repos[...]` keys and `url_pattern`
 * captures against.
 *
 * DUAL-HOST REPOS: RESOLVED FROM THE GIT REMOTE, NOT GUESSED
 * ----------------------------------------------------------
 * The two-argument form of `resolveHostBinding` applies the ambiguity rule, so
 * a DUAL repo (`api_host` + `exclusive: false`) yields the github.com flavour
 * — a GUESS, because a dual repo's PRs may live on either host.
 *
 * Local mode does not have to accept that guess. The review IS a checkout, and
 * `remote.origin.url` names the host its branch belongs to, so when a
 * `localPath` is supplied the dual case is resolved concretely FIRST (see
 * `resolveDualHostFromRemote`) and the ambiguity-rule resolve only runs when
 * the remote cannot answer. That order is also what keeps the cost down: the
 * ambiguity-rule resolve can `execSync` the user's `github_token_command`
 * (5s), and running it just to discard the result would put that on every
 * page load — unrecorded by the failure memo below, since the binding it
 * returned does have a token.
 *
 * A remote-derived host is evidence, so that binding is returned WITHOUT the
 * `hostAmbiguous` marker — which is what lets every downstream consumer
 * resolve correctly: the metadata fetch and the `pr_metadata` host stamp
 * consume it via `fetchPRMetadata` below, and the external-comments sync
 * (`executeSync` in src/routes/external-comments.js) calls this resolver
 * directly whenever `pr_metadata` holds no stored host for the PR — so a
 * cold cache binds the host the checkout's remote names instead of the
 * ambiguity-rule guess (and refuses outright on `hostAmbiguous`).
 *
 * Only when the remote is missing, unparseable, or matches NEITHER host does
 * the guess stand, and then the binding is stamped `hostAmbiguous: true` so
 * consumers can refuse to PERSIST it; see `fetchPRMetadata`, which will not
 * create a pr_metadata row from it. Without that, a background cache warm the
 * user never asked for would pin the (repo, PR) pair to github.com forever:
 * NULL in `pr_metadata.host` is indistinguishable from "unknown" on a fresh
 * INSERT, so PR-mode setup reads the row back as authoritative and skips the
 * alt-host probe (`storedHostToOption` → `{ host: null }` → `hostKnown = true`).
 *
 * `hostAmbiguous` is added HERE — it is NOT part of the `resolveHostBinding`
 * contract (which returns `{ apiHost, host, token, features, source, refresh }`
 * and never this field). It is set on a shallow COPY so the field can never
 * leak back into config.js's own bookkeeping. Consumers must treat its absence
 * as "not known to be a guess", not as "verified".
 *
 * Residual gap, unchanged and bounded: with no usable `localPath`/remote,
 * detection still runs on the guessed flavour, so a mirrored branch name can
 * associate the wrong host's PR — one review row's `associated_pr_number`, not
 * the shared metadata cache.
 *
 * @param {string|null|undefined} repository - owner/repo identity
 * @param {Object} config - Application config
 * @param {{now?: number, localPath?: string|null, cachedTokensOnly?: boolean, host?: string|null}|number} [options] - Options.
 *   `localPath` is the review's checkout, used to resolve a dual repo's host
 *   from its git remote. `host` is an api_host the caller already KNOWS (read
 *   off a `pr_metadata.host` stamp — `null` means github.com): it replaces the
 *   dual-host guess entirely, so the answer is never `hostAmbiguous`. Omit it
 *   (`undefined`) to keep the guessing behaviour. `now` is an injectable clock for the negative memo
 *   (tests only; never wait a TTL out in real time — tests/CONVENTIONS.md).
 *   `cachedTokensOnly` forbids shelling out for a `token_command` (see
 *   `resolveHostBinding`), for advisory request paths on a client deadline;
 *   its token-less answers are deliberately NOT memoized below, since a
 *   command that never ran is no evidence about the credential.
 *   A bare NUMBER is accepted as a legacy positional `now`, which is how the
 *   router-exposed helper is already called from
 *   tests/unit/wiring/local-host-binding.test.js.
 * @returns {Object|null} binding (possibly `hostAmbiguous`), or null when
 *   unresolvable
 */
function normalizeBindingOptions(options) {
  if (typeof options === 'number') {
    return { now: options, localPath: null, cachedTokensOnly: false, host: undefined };
  }
  const { now = Date.now(), localPath = null, cachedTokensOnly = false, host = undefined } = options || {};
  return { now, localPath, cachedTokensOnly: Boolean(cachedTokensOnly), host };
}

function resolveRepositoryBinding(repository, config, options = {}) {
  if (!repository) return null;
  const parts = splitRepository(repository);
  if (!parts) return null;
  const { now, localPath, cachedTokensOnly, host } = normalizeBindingOptions(options);
  const safeConfig = config || {};
  const bindingRepository = configModule.resolveBindingRepositoryFromPR(parts.owner, parts.repo, safeConfig);

  // Negative memo — see HOST_BINDING_FAILURE_TTL_MS. `resolveBindingRepositoryFromPR`
  // above is a pure config lookup; only the resolution below can shell out.
  //
  // `localPath` is part of the key because it can change the ANSWER (a dual
  // repo resolves to whichever host its checkout's remote names), so two local
  // reviews of the same repo in different checkouts must not answer for each
  // other. The NUL separator keeps a path containing the key from colliding.
  // `host` joins the key for the same reason `localPath` does: it changes the
  // ANSWER. A caller that KNOWS the host (a stored `pr_metadata.host` stamp)
  // must not read — or write — the memo the ambiguous guess left behind.
  const hostKey = host === undefined ? '' : String(host);
  const cacheKey = `${String(bindingRepository ?? '')}\u0000${localPath || ''}\u0000${hostKey}`;
  let perConfig = hostBindingFailureCache.get(safeConfig);
  const cached = perConfig && perConfig.get(cacheKey);
  if (cached) {
    if (now - cached.at <= HOST_BINDING_FAILURE_TTL_MS) return cached.binding;
    perConfig.delete(cacheKey);
  }

  // Evidence first, guess second — and `isDualHostRepo` is a pure config
  // lookup, so asking it first costs nothing while the resolve it guards can
  // shell out. Mark the guess BEFORE memoizing so both the fresh and the
  // memoized answer carry it (and the memo's object identity is stable for
  // callers).
  let binding;
  if (host !== undefined) {
    // The host is KNOWN — the caller read it off the `pr_metadata` stamp, the
    // authoritative record of which system a PR was actually fetched from.
    // There is nothing to guess at, so this never carries `hostAmbiguous`,
    // and a dual-host repo whose checkout names neither host still binds
    // correctly. Same tier-1 rule `executeSync` applies in
    // src/routes/external-comments.js.
    binding = tryResolveHostBinding(bindingRepository, safeConfig, { host }, { cachedTokensOnly });
  } else if (hostResolution.isDualHostRepo(safeConfig, bindingRepository)) {
    binding = resolveDualHostFromRemote(bindingRepository, safeConfig, localPath, { cachedTokensOnly });
    if (!binding) {
      const guess = tryResolveHostBinding(bindingRepository, safeConfig, undefined, { cachedTokensOnly });
      binding = guess ? { ...guess, hostAmbiguous: true } : null;
    }
  } else {
    binding = tryResolveHostBinding(bindingRepository, safeConfig, undefined, { cachedTokensOnly });
  }

  // A cache-only resolution that came back token-less proves NOTHING about the
  // credential — the command was never run. Memoizing that would poison the
  // next real resolution (the page-load GET, /pr-metadata) for the whole TTL
  // and report "no GitHub" for a token that resolves fine.
  if (binding && !binding.token && !cachedTokensOnly) {
    if (!perConfig) {
      perConfig = new Map();
      hostBindingFailureCache.set(safeConfig, perConfig);
    }
    perConfig.set(cacheKey, { at: now, binding });
  }
  return binding;
}

/**
 * `resolveRepositoryBinding` for an associated PR. The association carries a
 * PR identity (`<owner>/<repo>`), which is exactly the identity shape the
 * repository resolver translates.
 *
 * @param {{prNumber: number, repository: string}|null} association
 * @param {Object} config - Application config
 * @param {{now?: number, localPath?: string|null, cachedTokensOnly?: boolean, host?: string|null}|number} [options] - See
 *   `resolveRepositoryBinding`. Pass the REVIEW's `local_path` here: the
 *   association's PR lives on whichever host that checkout points at — or
 *   `host`, when the PR's stamped host is already known.
 * @returns {Object|null} binding, or null when unresolvable
 */
function resolveAssociationBinding(association, config, options = {}) {
  if (!association || !association.repository) return null;
  return resolveRepositoryBinding(association.repository, config, options);
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
 * Does an association identify a PR the external-comments sync would actually
 * accept as a target?
 *
 * The SAME standard `buildCommentTarget` + `executeSync` apply in
 * src/routes/external-comments.js, restated over an association object. A
 * truthiness test is NOT equivalent: a string `"123"` (hand-written or
 * backfilled) is truthy but not an integer, so it would advertise a control
 * whose only action 400s. `splitRepository` and the sync's two-element
 * `split('/')` agree on every accept/reject decision.
 *
 * @param {{prNumber: *, repository: *}|null|undefined} association
 * @returns {boolean}
 */
function isUsablePRTarget(association) {
  if (!association) return false;
  if (!Number.isInteger(association.prNumber)) return false;
  return Boolean(splitRepository(association.repository));
}

/**
 * Build the capabilities object surfaced to the frontend on
 * `GET /api/local/:reviewId`. Pure function over already-resolved inputs.
 *
 * The shape splits two concerns:
 *
 *   Prerequisite state — flips true when conditions are met:
 *     - hasAssociatedPR: a USABLE PR association is persisted on this review.
 *       "Usable" is defined by the association's consumer, not here — see
 *       `isUsablePRTarget`; a looser test advertises controls that only 400.
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
 *     - canViewPRComments: Phase 2 — true when hasAssociatedPR AND hasToken.
 *       Deliberately NOT gated on `prMetadataAvailable`: comments and metadata
 *       are independent fetches, and withholding the comments because the
 *       metadata cache is cold would hide a working feature — without the PR's
 *       head_sha the frontend's anchor check just degrades to file level.
 *     - canCheckStaleVsPR: Phase 3 — true when hasAssociatedPR AND hasToken.
 *       Same reasoning as `canViewPRComments`: deliberately NOT gated on
 *       `prMetadataAvailable`. The check performs a LIVE read-only fetch of
 *       the PR's head commit (see src/providers/stale-check.js), so it needs
 *       no warm cache — a cold cache only means the `prAdvanced` comparison
 *       (remote vs cached head) has nothing to compare against, while the
 *       drift comparison (local HEAD vs remote head) still answers.
 *     - canSyncDrafts: Phase 4 — true when hasAssociatedPR AND hasToken AND
 *       `hostResolved`. Deliberately NOT gated on `prMetadataAvailable` (same
 *       reasoning as the two above: the `pr_metadata` cache is not an input to
 *       "do I have a pending review", and gating on it would hide the control
 *       on exactly the cold-cache first load where a draft started in the
 *       GitHub UI is most likely to be waiting) — but it IS gated on the host,
 *       because `POST /api/local/:reviewId/sync-drafts` refuses an unresolved
 *       dual-host binding with 409 before it contacts GitHub. `hasGitHubToken`
 *       keeps its documented exception (a credential genuinely exists); an
 *       ACTION contract may not, or it advertises a button whose every click
 *       is a deterministic error.
 *     - canSubmitToGitHub: Phase 5 — true when hasAssociatedPR AND hasToken
 *       AND `hostResolved`, exactly like `canSyncDrafts` and for the same
 *       reason: `POST /api/local/:reviewId/submit-review` refuses an
 *       unresolved dual-host binding with 409 before it contacts GitHub, and
 *       an ACTION contract may not advertise a control whose every click is a
 *       deterministic error. Also NOT gated on `prMetadataAvailable`: the
 *       endpoint reads the PR LIVE (it must, to refuse a drifted or closed
 *       PR — see `checkSubmitPreconditions`), so a cold cache is no reason to
 *       hide the one control that would warm it.
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
 * @param {boolean} [params.hostResolved=true] - The host the association's PR
 *   lives on is KNOWN, rather than a dual-host guess. Compute it with
 *   `resolveAssociationHost` in src/routes/local.js, which applies the same
 *   two tiers the endpoints do. Defaults true so a caller with no dual-host
 *   question (and every existing test) is unaffected.
 * @returns {Object} capabilities object
 */
function buildCapabilities({ association, hasToken, prMetadataAvailable, hostResolved = true } = {}) {
  const hasAssociatedPR = isUsablePRTarget(association);
  return {
    // Prerequisite state
    hasAssociatedPR,
    hasGitHubToken: Boolean(hasToken),
    // Action contracts — each phase flips its own when the implementation
    // lands. Frontend `hasCapability(name)` consumers see false until the
    // action is real.
    canShowPRMetadata: Boolean(hasAssociatedPR && prMetadataAvailable),
    canViewPRComments: Boolean(hasAssociatedPR && hasToken),
    canCheckStaleVsPR: Boolean(hasAssociatedPR && hasToken),
    canSyncDrafts: Boolean(hasAssociatedPR && hasToken && hostResolved),
    canSubmitToGitHub: Boolean(hasAssociatedPR && hasToken && hostResolved),
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
 * `base_sha` rides along with `head_sha` because the frontend's anchor gates
 * need both — head for added lines, base for removed ones (see
 * `_externalAnchorContext` in public/js/pr.js). `PRMetadataRepository.getByPR`
 * already merges it out of `pr_data`, so this is pure forwarding.
 *
 * @param {Object} row - Row from PRMetadataRepository.getByPR
 * @returns {{title: string|null, author: string|null, url: string|null, state: string|null, merged: boolean, head_sha: string|null, base_sha: string|null}}
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
    base_sha: row.base_sha ?? parsed.base_sha ?? null,
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
 * ambiguous binding short-circuits on a cache miss: no GitHub call, no row,
 * pill hidden. A cache HIT is unaffected — an existing row was stamped by
 * whoever genuinely resolved the host.
 *
 * In LOCAL mode this gate is now rarely reached — `resolveRepositoryBinding`
 * above resolves a dual repo from the checkout's remote first — but it stays,
 * because "the caller could not resolve it" is still a reachable state and
 * `hostAmbiguous` is a marker any caller may set.
 *
 * EXPLICIT REFRESH, NOT A TTL
 * ---------------------------
 * The row has no expiry, and that is deliberate: a TTL has no correct value
 * here. Short means a GitHub round-trip on every local page load for a value
 * that changes rarely; long means a stale `head_sha` keeps the frontend's
 * anchor-trust check failing closed — every thread pushed into the file zone
 * carrying a note that says the comments "were written against a different
 * commit" — for the whole window, including after the PR has caught up.
 *
 * The staleness has a KNOWN TRIGGER instead: the local HEAD moving (commit,
 * rebase, amend) is already detected, and the user pressing Refresh is an
 * explicit ask. `forceRefresh` is that path.
 *
 * A forced refresh relaxes NONE of the refusals below; it only changes what
 * they RETURN — the row already cached, since flipping `canShowPRMetadata`
 * off over a transient failure is worse than serving slightly stale metadata.
 *
 * The converse staleness — someone else pushing while local HEAD stays put —
 * needs no backstop here: the comment sync delivers each comment's own
 * `commit_sha` fresh, and the frontend's per-comment gate catches it without
 * consulting this row.
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
 * @param {boolean} [params.forceRefresh=false] - Skip the cache-first
 *   short-circuit and re-fetch + upsert. For the known staleness triggers
 *   (local HEAD moved, user pressed refresh) — never on the page-load path.
 * @param {Object} params.db
 * @param {Object} [params._deps]
 * @returns {Promise<Object|null>} normalized metadata or null
 */
async function fetchPRMetadata({ prNumber, repository, githubToken, hostBinding, forceRefresh = false, db, _deps } = {}) {
  if (!db || !prNumber || !repository) return null;
  const deps = { ...defaults, ..._deps };
  const parts = splitRepository(repository);
  if (!parts) return null;

  const repo = new deps.PRMetadataRepository(db);
  const cached = await repo.getByPR(prNumber, repository);
  if (cached && !forceRefresh) return normalizePRMetadata(cached);

  // What every refusal below falls back to. Non-null ONLY on a forced
  // refresh (the unforced path already returned above on a hit), so this
  // changes nothing for the page-load callers.
  const cachedFallback = cached ? normalizePRMetadata(cached) : null;

  // Cold cache + a guessed host → refuse. Writing the row is the harm (see
  // "GUESSED HOSTS ARE NEVER PERSISTED"), and fetching without writing would
  // both show possibly-wrong metadata and re-hit GitHub on every page load.
  // A forced refresh does NOT relax this — the whole point of the gate is
  // that the host was never resolved, and being asked twice does not resolve
  // it. The existing row (if any) is returned unchanged.
  if (hostBinding && hostBinding.hostAmbiguous) {
    deps.logger.debug?.(
      `fetchPRMetadata skipped for #${prNumber} ${repository}: host is ambiguous ` +
      '(dual github.com + alt-host repo, host not resolved) — refusing to cache a guessed host'
    );
    return cachedFallback;
  }

  // One rule, three call sites — see `resolveFetchCredential` for why an
  // alt-host binding with an empty token fails CLOSED instead of borrowing
  // the bare github.com token.
  const credential = resolveFetchCredential(hostBinding, githubToken);
  if (!credential) return cachedFallback;

  try {
    const client = new deps.GitHubClient(credential);
    const prData = await client.fetchPullRequest(parts.owner, parts.repo, prNumber);
    if (!prData) return cachedFallback;
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
    return cachedFallback;
  }
}

module.exports = {
  getAssociatedPR,
  getPRContext,
  buildCapabilities,
  isUsablePRTarget,
  splitRepository,
  getCachedPRMetadata,
  fetchPRMetadata,
  resolveFetchCredential,
  resolveRepositoryBinding,
  resolveAssociationBinding,
  // Module-level memo state, for tests only (re-exposed on the local router as
  // `_hostBindingCache` / `_remoteHostnameCache`). Seeding the remote memo is
  // how a test exercises dual-host resolution without shelling out to git.
  _hostBindingInternals: {
    clearHostBindingFailureCache: _clearHostBindingFailureCache,
    hostBindingFailureTtlMs: HOST_BINDING_FAILURE_TTL_MS,
    clearRemoteHostnameCache: _clearRemoteHostnameCache,
    setRemoteHostname: (localPath, hostname) => { remoteHostnameCache.set(localPath, hostname); },
    getRemoteHostname: (localPath) => remoteHostnameCache.get(localPath),
  },
};
