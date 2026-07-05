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
 * Canonical PR-mode predicate: `isPRMode(review)`. Use it from EVERY route
 * in this file — sync and fetch must agree on what counts as a PR review,
 * otherwise the two endpoints diverge on local-mode handling.
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
const logger = require('../utils/logger');

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
  getAdapter
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
 * Canonical PR-mode predicate. Both routes in this file (sync + fetch) must
 * use this same check so the two endpoints agree on what a "PR review" is.
 *
 * A row is PR-mode iff:
 *   - it has a numeric `pr_number`
 *   - it has a non-empty `repository`
 *   - its `review_type` is not 'local' (default is 'pr')
 *   - it has no `local_path` (which would identify a local-mode review)
 */
function isPRMode(review) {
  if (!review) return false;
  if (review.review_type && review.review_type !== 'pr') return false;
  if (review.local_path) return false;
  if (!Number.isInteger(review.pr_number)) return false;
  if (!review.repository) return false;
  return true;
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
 * @param {Object} [params._deps] - Test overrides for { GitHubClient, getGitHubToken, getAdapter, resolveHostBinding, resolveBindingRepositoryFromPR }
 * @returns {Promise<{count: number, lostAnchors: number, syncedAt: string}>}
 */
async function executeSync({ db, config, review, source, _deps }) {
  const deps = { ...defaults, ..._deps };

  // Look up adapter — throws on unknown sources, caught by the route.
  const adapter = deps.getAdapter(source);

  // Parse owner/repo BEFORE resolving credentials: the repository drives
  // binding-aware credential resolution (per-repo api_host/token for
  // alt-host repos), so it must be validated first.
  const [owner, repo] = String(review.repository).split('/');
  if (!owner || !repo) {
    throw new BadRequestError(
      `Invalid review.repository "${review.repository}"; expected "owner/repo"`
    );
  }

  // Look up the PR's stored host so a DUAL repo's alt-hosted PR binds to the
  // alt host (and its line-based anchoring path) rather than api.github.com.
  // Pass the raw stored value through to the adapter, which applies the
  // legacy-NULL convention against its resolved binding key. `undefined`
  // (no row / unknown) preserves the two-arg ambiguity behaviour.
  let storedHost;
  if (Number.isInteger(review.pr_number)) {
    const prMetadataRepo = new PRMetadataRepository(db);
    storedHost = await prMetadataRepo.getPRHost(review.repository, review.pr_number);
  }

  // Delegate credential resolution to the adapter so the route stays
  // source-agnostic and each adapter can name its own env var in errors.
  // Thread `review.repository` through so the adapter resolves the
  // repo-scoped host binding (alt-host api_host + repo token) instead of
  // always targeting api.github.com with the top-level github.com token.
  // The adapter throws (e.g. GitHubApiError 401) when credentials are
  // missing — the route's catch maps it to a 401 response.
  // `isAltHost` reflects whether the resolved binding targets an alternate
  // Git host. Alt-hosts don't implement GitHub's deprecated `position`
  // field, so it drives line-based anchoring in `mapComment` below.
  const { client, isAltHost } = adapter.resolveCredentials(config || {}, review.repository, _deps, { storedHost });

  const apiRows = await adapter.fetchComments({
    client,
    owner,
    repo,
    pull_number: review.pr_number
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

  if (!isPRMode(review)) {
    return res.status(400).json({ error: 'External comment sync requires a PR mode review' });
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
 * Local-mode reviews always return { threads: [] } — external comments
 * are a PR-mode concept, but the endpoint is safe to call from local pages.
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

    // Non-PR reviews (local-mode, malformed rows) never have external
    // comments. Return an empty thread list so the frontend can call this
    // endpoint unconditionally. We use the canonical `isPRMode` predicate
    // here so sync and fetch stay in lockstep on what counts as PR mode.
    if (!isPRMode(review)) {
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
// Exported for tests only — production code should not reach into this map.
module.exports._inFlight = inFlight;
