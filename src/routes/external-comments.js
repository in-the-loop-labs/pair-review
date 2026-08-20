// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * External Comment Routes
 *
 * Endpoints for syncing and reading review comments from external systems
 * (currently GitHub PR review comments; designed for GitLab/Linear/etc.).
 * External comments are stored as a read-only mirror in the
 * `external_comments` table — see ExternalCommentRepository.
 *
 * This file is shared between two implementation agents:
 *   --- SYNC ROUTES --- : POST /api/reviews/:reviewId/external-comments/sync
 *   --- FETCH ROUTES --- : GET /api/reviews/:reviewId/external-comments
 *
 * Canonical target resolver: `resolveCommentTarget(review)`. Use it from
 * EVERY route in this file — sync and fetch must agree on which PR (if any)
 * a review's comments belong to, otherwise the two endpoints diverge and we
 * write mirror rows that are never read back.
 *
 * These endpoints are review-scoped, not PR-route-scoped: a local review
 * whose branch has an associated GitHub PR resolves to that PR and gets the
 * same read-only mirror. See plans/bridge-local-and-pr-modes.md, Phase 2.
 */

const express = require('express');
const {
  ExternalCommentRepository,
  ReviewRepository,
  PRMetadataRepository,
  withTransaction
} = require('../database');
const { getAdapter } = require('../external');
const { GitHubApiError } = require('../github/client');
// THE shared repository-binding resolver (identity → binding key → binding,
// dual-host repos resolved from the checkout's git remote). Detection and
// metadata fetches already resolve through it; the sync's cold-cache path
// below must too, or the three sides disagree on which host a PR lives on.
const { resolveRepositoryBinding } = require('../providers/pr-context');
const logger = require('../utils/logger');
const { resolveBindingRepositoryFromPR } = require('../config');
const { resolveRecordedHost } = require('../utils/host-resolution');

const router = express.Router();

// --- SYNC ROUTES ---

/**
 * Default dependencies for the sync flow. Tests override these via the
 * `externalCommentsDeps` Express app setting (or by passing `_deps` to
 * `executeSync` directly). Credential resolution is delegated to the
 * adapter via `adapter.resolveCredentials(config, repository)` — keeps the
 * route source-agnostic, lets each adapter name its own env var in errors,
 * and threads the repo through so per-repo alt-host bindings apply.
 */
const defaults = {
  getAdapter,
  resolveRepositoryBinding
};

/**
 * In-flight sync registry keyed by `${reviewId}:${source}`.
 *
 * Page-load auto-sync and the manual "refresh external comments" button
 * can race. When a sync is already running for a (reviewId, source) pair,
 * a second caller awaits the same promise instead of making a duplicate
 * GitHub round-trip. This also avoids two parent-resolution passes briefly
 * interleaving (the hazard called out in the plan).
 *
 * Entries are removed in a `finally` so failures do not permanently block
 * retries.
 *
 * @type {Map<string, Promise<{count: number, lostAnchors: number, syncedAt: string}>>}
 */
const inFlight = new Map();

/**
 * Global write-phase serializer. The per-key `inFlight` map only dedupes
 * matching (reviewId, source) pairs — two syncs for DIFFERENT reviews can
 * still race their write phases on the same better-sqlite3 connection,
 * which cannot nest BEGIN…COMMIT (throws "cannot start a transaction
 * within a transaction"). We do all network I/O and mapping outside the
 * transaction (cheap to interleave), then chain transactional writes
 * through this single promise so only one BEGIN…COMMIT runs at a time.
 *
 * Per-db serialization would be cleaner if the route handled multiple DBs,
 * but pair-review uses one SQLite file per process; a module-level chain
 * is sufficient and avoids a per-db WeakMap dance.
 */
let writeChain = Promise.resolve();

/**
 * Typed 400 error. Mirrors the GitHubApiError shape (name/message/status)
 * so the route's catch ladder can fan-out by `instanceof` rather than
 * string-sniff. Used for client-correctable problems (malformed inputs)
 * that previously bubbled out as plain Error → 500.
 */
class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequestError';
    this.status = 400;
  }
}

/**
 * Typed 409 error. Extends BadRequestError so the route's existing
 * `instanceof BadRequestError` catch handles it — the response status comes
 * from `error.status`, not the class, so this maps to 409 with no ladder
 * change. Used for state-conflict refusals the client cannot fix by changing
 * the request (e.g. a dual-host repository whose PR host cannot be
 * determined), as opposed to malformed inputs (400).
 */
class ConflictError extends BadRequestError {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
  }
}

/**
 * Build a comment target from a (prNumber, repository) pair, or null when the
 * pair cannot identify a PR at all.
 *
 * `owner`/`repo` are BEST EFFORT: a malformed repository still yields a
 * target (with null owner/repo) so `executeSync` can raise its specific
 * "Invalid review.repository" 400 rather than collapsing into the generic
 * "no PR target" 400. The two-element split is deliberate — `a/b/c` resolves
 * to owner `a`, repo `b`, exactly as the original destructure did.
 *
 * @private
 */
function buildCommentTarget(prNumber, repository) {
  if (!Number.isInteger(prNumber)) return null;
  if (!repository || typeof repository !== 'string') return null;
  const parts = repository.split('/');
  return {
    owner: parts[0] || null,
    repo: parts[1] || null,
    prNumber,
    repository
  };
}

/**
 * Canonical comment-target resolver. Both routes in this file (sync + fetch)
 * must use this so the two endpoints agree on which PR a review's external
 * comments belong to.
 *
 * Two shapes resolve:
 *
 *   1. LOCAL row carrying a persisted association (migration 56's
 *      `associated_pr_*`) → the associated PR. Local rows never use the PR
 *      natural key; that key stays exclusive to review_type='pr' so
 *      `getReviewByPR` can never surface a local row.
 *   2. PR-mode row → its own natural key. Unchanged from the earlier
 *      `isPRMode` truth table.
 *
 * Anything else resolves to null, INCLUDING a local review with no
 * association. Callers keep their existing — and deliberately DIFFERENT —
 * null contracts: sync 400s, fetch returns `{ threads: [] }` so the frontend
 * can call it unconditionally in either mode.
 *
 * @param {Object|null} review - Row from `ReviewRepository.getReview`
 * @returns {{owner: string|null, repo: string|null, prNumber: number, repository: string}|null}
 */
function resolveCommentTarget(review) {
  if (!review) return null;

  if (review.review_type === 'local' && review.local_path) {
    return buildCommentTarget(review.associated_pr_number, review.associated_pr_repository);
  }

  if (review.review_type && review.review_type !== 'pr') return null;
  if (review.local_path) return null;
  return buildCommentTarget(review.pr_number, review.repository);
}

/**
 * Run a full sync for one (reviewId, source) pair. Idempotent. Throws
 * domain errors (Error / GitHubApiError) — the route handler catches them
 * and maps them to HTTP responses.
 *
 * @param {Object} params
 * @param {Object} params.db - Database handle
 * @param {Object} params.config - Server config (for token lookup)
 * @param {Object} params.review - Validated review row
 * @param {string} params.source - Adapter source name (e.g. 'github')
 * @param {Object} [params._deps] - Test overrides for { GitHubClient, getGitHubToken, getAdapter, resolveRepositoryBinding, resolveHostBinding, resolveBindingRepositoryFromPR }
 * @returns {Promise<{count: number, lostAnchors: number, syncedAt: string}>}
 */
async function executeSync({ db, config, review, source, _deps }) {
  const deps = { ...defaults, ..._deps };

  // Look up adapter — throws on unknown sources, caught by the route.
  const adapter = deps.getAdapter(source);

  // ONE resolver, three read sites below. A local review carries its PR
  // identity in different columns than a PR-mode row, so a read site that
  // skipped `target` would silently sync `undefined/undefined`.
  const target = resolveCommentTarget(review);
  if (!target) {
    throw new BadRequestError(
      'External comment sync requires a PR mode review or a local review with an associated pull request'
    );
  }

  // Parse owner/repo BEFORE resolving credentials: the repository drives
  // binding-aware credential resolution (per-repo api_host/token for
  // alt-host repos), so it must be validated first.
  const { owner, repo } = target;
  if (!owner || !repo) {
    throw new BadRequestError(
      `Invalid review.repository "${target.repository}"; expected "owner/repo"`
    );
  }

  // Two-tier host resolution so a DUAL repo's alt-hosted PR binds to the alt
  // host (and its line-based anchoring path) rather than api.github.com:
  //
  //   Tier 1 — the RECORDED host: the stored `pr_metadata.host` stamp read
  //   together with the recorded `html_url`, resolved by the shared
  //   `resolveRecordedHost`. The lookup distinguishes "no row" (`undefined`)
  //   from "row with NULL host", and `resolveRecordedHost` then settles what a
  //   NULL means — a non-github `html_url` proves a pre-stamping row belongs to
  //   the configured `api_host`, so it is NOT silently read as github.com. The
  //   result is passed to the adapter, which applies the legacy-NULL convention
  //   against the binding key it resolves. Keeping this fast path first also
  //   keeps the resolver's potential `token_command` shell-out off the
  //   PR-mode hot path: a warm cache never invokes the resolver at all.
  //
  //   Tier 2 — cold cache (`undefined`): resolve through the SHARED
  //   `resolveRepositoryBinding` — the same resolver PR detection and
  //   metadata fetches use — threading the review's checkout path so a dual
  //   repo resolves to whichever host its git remote names. Without this the
  //   adapter fell back to the two-arg ambiguity rule, guessing github.com
  //   and syncing a same-numbered stranger PR's comments into the review
  //   (or 401ing with alt-host-only credentials). And the cache could stay
  //   cold FOREVER: `fetchPRMetadata` refuses to stamp a `pr_metadata` row
  //   from an ambiguous binding, so an ambiguous checkout re-guessed on
  //   every sync. An ambiguous binding is therefore a hard refusal here,
  //   BEFORE any network access.
  //
  // Keyed on the TARGET, not the review row: a local review's `pr_number` is
  // NULL, so reading the row directly here would skip the lookup entirely and
  // silently degrade dual-host disambiguation for associated PRs.
  const prMetadataRepo = new PRMetadataRepository(db);
  let storedHost;
  const recorded = await prMetadataRepo.getPRHostWithRecordedUrl(target.repository, target.prNumber);
  if (recorded !== undefined) {
    storedHost = resolveRecordedHost(
      config || {},
      resolveBindingRepositoryFromPR(owner, repo, config || {}),
      recorded.host,
      recorded.recordedUrl
    );
  }
  if (storedHost === undefined) {
    const binding = deps.resolveRepositoryBinding(target.repository, config || {}, {
      localPath: review.local_path || null
    });
    if (binding && binding.hostAmbiguous) {
      throw new ConflictError(
        `Cannot determine which host PR #${target.prNumber} of dual-host repository ` +
        `"${target.repository}" lives on; refusing to sync external comments against a guessed host`
      );
    }
    if (binding) {
      // `binding.host` is the resolved api_host URL, or null meaning
      // github.com — exactly the storedHost contract the adapter expects.
      storedHost = binding.host;
    }
    // A null binding is only reachable for config-shape surprises on a
    // NON-dual repository (`owner`/`repo` were validated above, and the
    // two-arg `resolveHostBinding` form cannot throw). Fall through with
    // `undefined` — the previous ambiguity-rule behaviour — rather than
    // refusing, so plain repositories are not regressed.
  }

  // Delegate credential resolution to the adapter so the route stays
  // source-agnostic and each adapter can name its own env var in errors.
  // Thread `target.repository` through so the adapter resolves the
  // repo-scoped host binding (alt-host api_host + repo token) instead of
  // always targeting api.github.com with the top-level github.com token.
  // The adapter throws (e.g. GitHubApiError 401) when credentials are
  // missing — the route's catch maps it to a 401 response.
  // `isAltHost` reflects whether the resolved binding targets an alternate
  // Git host. Alt-hosts don't implement GitHub's deprecated `position`
  // field, so it drives line-based anchoring in `mapComment` below.
  const { client, isAltHost } = adapter.resolveCredentials(config || {}, target.repository, _deps, { storedHost });

  const apiRows = await adapter.fetchComments({
    client,
    owner,
    repo,
    pull_number: target.prNumber
  });

  // Map raw API rows and filter out "lost anchors" (BOTH current AND original
  // position fields null — unrenderable). Counting them lets the UI tell the
  // user why their visible count differs from GitHub's reported total.
  // Track external_ids seen this sync so we can prune rows that upstream
  // has removed (or that we no longer render because they lost anchors)
  // inside the same transaction as the upserts.
  let lostAnchors = 0;
  const mappedRows = [];
  const seenExternalIds = new Set();
  for (const apiRow of apiRows || []) {
    let mapped;
    try {
      mapped = adapter.mapComment(apiRow, { isAltHost });
    } catch (mapError) {
      // A malformed row from the source shouldn't kill the whole sync — log
      // it and keep going. The adapter only throws for genuinely malformed
      // rows (e.g. missing required `path`).
      logger.warn(`External comment adapter ${source} could not map row: ${mapError.message}`);
      continue;
    }

    // File-level comments legitimately have NO line anchor (both current and
    // original line fields null) — they render in the per-file comments zone,
    // not on a diff line. Only treat a NON-file-level row with both anchors
    // null as a lost anchor.
    if (!mapped.is_file_level && mapped.line_end == null && mapped.original_line_end == null) {
      lostAnchors++;
      continue;
    }
    mappedRows.push(mapped);
    seenExternalIds.add(String(mapped.external_id));
  }

  const repository = new ExternalCommentRepository(db);
  const syncedAt = new Date().toISOString();

  // Write phase: upsert all rows, conditionally prune rows missing from
  // this snapshot, then resolve parents. Wrapped in a single transaction
  // so concurrent readers never see a partial mirror.
  //
  // Empty-snapshot prune is intentionally skipped (`seenExternalIds.size`
  // gate below). A transient empty response from upstream (e.g. GitHub
  // briefly returning [] while a PR is being reorganized) used to wipe the
  // entire local mirror for (review_id, source). Skipping the prune turns
  // that transient into a no-op; the non-empty case still prunes rows that
  // upstream removed.
  //
  // We serialize the transactional write phase through a module-level
  // promise chain because better-sqlite3 cannot nest BEGIN…COMMIT — two
  // concurrent syncs for DIFFERENT reviews would otherwise collide here.
  let deletedCount = 0;
  const performWrites = async () => {
    await withTransaction(db, async () => {
      for (const mapped of mappedRows) {
        await repository.upsert(review.id, source, mapped);
      }
      if (seenExternalIds.size > 0) {
        deletedCount = await repository.deleteMissing(review.id, source, seenExternalIds);
      }
      await repository.resolveParents(review.id, source);
    });
  };

  // Chain the current write phase onto whatever's already pending. The
  // chain swallows errors at the join point so a failed sync doesn't
  // permanently break the next caller's link in the chain — the *current*
  // caller still observes its own failure via the `await` below.
  const previous = writeChain;
  const myWrite = previous.then(performWrites, performWrites);
  writeChain = myWrite.catch(() => {});
  await myWrite;

  return {
    count: mappedRows.length,
    lostAnchors,
    deleted: deletedCount,
    syncedAt
  };
}

/**
 * Middleware: validate `:reviewId`, attach `req.review`.
 *
 * Mirrors the pattern in `routes/reviews.js` but lives here to keep the
 * sync route self-contained. The fetch route below intentionally uses a
 * different (older) shape because it predates this middleware.
 */
async function validateReviewId(req, res, next) {
  try {
    const reviewId = parseInt(req.params.reviewId, 10);
    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getReview(reviewId);

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    req.review = review;
    req.reviewId = reviewId;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/reviews/:reviewId/external-comments/sync?source=github
 *
 * Fetches inline review comments from the external source and upserts them
 * into the local mirror. Idempotent. Returns
 * `{ count, lostAnchors, syncedAt }`. See module header for the
 * concurrent-sync guard contract.
 */
router.post('/api/reviews/:reviewId/external-comments/sync', validateReviewId, async (req, res) => {
  const source = (req.query.source || 'github').toString();
  const review = req.review;

  // Sync 400s where fetch returns an empty list; that asymmetry is deliberate
  // (see `resolveCommentTarget`).
  if (!resolveCommentTarget(review)) {
    return res.status(400).json({
      error: 'External comment sync requires a PR mode review or a local review with an associated pull request'
    });
  }

  const db = req.app.get('db');
  const config = req.app.get('config') || {};
  const key = `${review.id}:${source}`;

  // Tests inject dependency overrides via the app setting
  // `externalCommentsDeps`. In production this is undefined and the module
  // defaults win.
  const _deps = req.app.get('externalCommentsDeps') || undefined;

  try {
    let promise = inFlight.get(key);
    if (!promise) {
      promise = executeSync({ db, config, review, source, _deps })
        .finally(() => {
          // Remove the slot only after the promise settles — concurrent
          // callers awaiting this entry must see the same outcome.
          inFlight.delete(key);
        });
      inFlight.set(key, promise);
    }

    const result = await promise;
    res.json(result);
  } catch (error) {
    // Unknown source — the adapter dispatcher throws a plain Error.
    if (error && typeof error.message === 'string' && error.message.startsWith('Unknown external comment source:')) {
      logger.warn(`External comments sync rejected: ${error.message}`);
      return res.status(400).json({ error: error.message });
    }

    // Client-correctable problem (e.g. malformed review.repository).
    // BadRequestError carries status=400 explicitly so we don't fall
    // through to the catch-all 500.
    if (error instanceof BadRequestError) {
      logger.warn(`External comments sync rejected: ${error.message}`);
      return res.status(error.status).json({ error: error.message });
    }

    if (error instanceof GitHubApiError) {
      logger.error(`External comments sync GitHub error (${error.status}): ${error.message}`);

      // Single mapping path: trust GitHubApiError.message, which
      // `handleApiError` already populates with the retry-after seconds on
      // 429s and the auth/rate context on other failures. The previously
      // separate 429 branch read `error.retryAfter`, which GitHubApiError
      // doesn't carry — dead code that masked the real message.
      if (error.status >= 400 && error.status < 600) {
        return res.status(error.status).json({ error: error.message });
      }

      return res.status(500).json({ error: error.message });
    }

    logger.error('External comments sync failed:', error);
    res.status(500).json({ error: error.message || 'Failed to sync external comments' });
  }
});

// --- FETCH ROUTES ---

/**
 * GET /api/reviews/:reviewId/external-comments?source=github
 *
 * Returns external comments persisted for a review, grouped into threads.
 * Each thread is a root comment object with all original row fields plus a
 * `replies` array of the same shape.
 *
 * Query params:
 *   - source: (optional) filter to one external source (e.g. 'github').
 *             If omitted, returns rows from all known sources.
 *             If provided but unknown, responds 400.
 *
 * Responses:
 *   - 200: { threads: Array<Thread> }
 *   - 400: unknown source
 *   - 404: review not found
 *   - 500: unexpected
 *
 * Reviews with no resolvable PR target always return { threads: [] } — a
 * local review with no associated PR has nothing to mirror, but the endpoint
 * stays safe to call unconditionally from local pages.
 */
router.get('/api/reviews/:reviewId/external-comments', validateReviewId, async (req, res) => {
  try {
    const reviewId = req.reviewId;
    const review = req.review;

    const source = req.query.source;

    // If a source filter is provided, validate it against the adapter registry
    // before touching the DB. Catches typos early with a meaningful message.
    if (source !== undefined && source !== null && source !== '') {
      try {
        getAdapter(source);
      } catch (err) {
        return res.status(400).json({ error: `Unknown external comment source: ${source}` });
      }
    }

    // No resolvable PR target (a local review with no association, malformed
    // rows) — empty thread list, so the frontend can call this endpoint
    // unconditionally. Canonical resolver, so sync and fetch stay in lockstep.
    if (!resolveCommentTarget(review)) {
      return res.json({ threads: [] });
    }

    const db = req.app.get('db');
    const repo = new ExternalCommentRepository(db);
    const listOptions = {};
    if (source) {
      listOptions.source = source;
    }

    const threads = await repo.listThreadsByReview(reviewId, listOptions);

    res.json({ threads });
  } catch (error) {
    logger.error('Error fetching external comments:', error);
    res.status(500).json({ error: 'Failed to fetch external comments' });
  }
});

module.exports = router;
module.exports.executeSync = executeSync;
// The canonical target resolver. Exported so tests can pin the truth table
// directly; production code inside this file is its only other consumer.
module.exports.resolveCommentTarget = resolveCommentTarget;
// Exported for tests only — production code should not reach into this map.
module.exports._inFlight = inFlight;
