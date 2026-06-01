// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const crypto = require('crypto');
const logger = require('../utils/logger');
const {
  TOUR_PERSIST_MIN_STOPS,
  TOUR_MAX_STOPS,
  TOUR_TITLE_MAX,
  TOUR_DESCRIPTION_MAX
} = require('./prompts/tour');

const TOUR_LOG_PREFIX = '[Tour]';
const SCRIPT_NAME = 'git-diff-lines';

/**
 * Tracks the most recently requested diff hash per review so that an in-flight
 * tour generation can detect it has been superseded by a newer kickoff and
 * skip persistence. Cleared when the latest hash successfully persists.
 *
 * Exported (module.exports) so tests can reset state between runs.
 */
const latestRequestedDiffHash = new Map();

const defaults = {
  TourRepository: require('../database').TourRepository,
  createProvider: require('./provider').createProvider,
  resolveNonExecutableProviderId: require('./provider').resolveNonExecutableProviderId,
  getTourProvider: require('../config').getTourProvider,
  getTourModel: require('../config').getTourModel,
  getTourEnabled: require('../config').getTourEnabled,
  getTourAutoGenerate: require('../config').getTourAutoGenerate,
  buildTourPrompt: require('./prompts/tour').buildTourPrompt,
  extractJSON: require('../utils/json-extractor').extractJSON,
  broadcastReviewEvent: require('../events/review-events').broadcastReviewEvent,
  parseUnifiedDiffHunks: require('../utils/diff-hunks').parseUnifiedDiffHunks,
  hashDiff: (diffText) => crypto.createHash('sha256').update(diffText).digest('hex').slice(0, 16),
  backgroundQueue: null,
  // Indirection so tests can swap the worker thunk and observe scheduling.
  generateTourForReview: null
};

/**
 * Build the bare-name annotated-diff command string passed to the prompt.
 * Bare command name (not absolute path) so provider tool allow-lists match.
 * See analyzer.js `_buildScriptCommand`.
 * @param {string|null} worktreePath
 * @returns {string}
 */
function buildScriptCommand(worktreePath) {
  if (!worktreePath) return SCRIPT_NAME;
  return `${SCRIPT_NAME} --cwd "${worktreePath}"`;
}

/**
 * Parse a unified-diff hunk header (`@@ -a,b +c,d @@`).
 * @param {string} header
 * @returns {{oldStart: number, oldLen: number, newStart: number, newLen: number}|null}
 */
function parseHunkHeader(header) {
  const m = header && header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return null;
  return {
    oldStart: parseInt(m[1], 10),
    oldLen: m[2] != null ? parseInt(m[2], 10) : 1,
    newStart: parseInt(m[3], 10),
    newLen: m[4] != null ? parseInt(m[4], 10) : 1
  };
}

/**
 * Build sets of changed line numbers per file per side from parsed hunks.
 * @param {Map<string, Array<{header: string, lines: string[]}>>} hunksByFile
 * @returns {{left: Map<string, Set<number>>, right: Map<string, Set<number>>}}
 */
function buildChangedLineIndex(hunksByFile) {
  const left = new Map();
  const right = new Map();
  for (const [filePath, hunks] of hunksByFile.entries()) {
    const leftSet = new Set();
    const rightSet = new Set();
    for (const hunk of hunks) {
      const head = parseHunkHeader(hunk.header);
      if (!head) continue;
      let oldLine = head.oldStart;
      let newLine = head.newStart;
      for (const raw of hunk.lines) {
        if (raw.startsWith('\\')) continue;
        const marker = raw[0];
        if (marker === '+') {
          rightSet.add(newLine);
          newLine++;
        } else if (marker === '-') {
          leftSet.add(oldLine);
          oldLine++;
        } else {
          oldLine++;
          newLine++;
        }
      }
    }
    left.set(filePath, leftSet);
    right.set(filePath, rightSet);
  }
  return { left, right };
}

function rangeIntersectsSet(start, end, set) {
  if (!set || set.size === 0) return false;
  for (let i = start; i <= end; i++) {
    if (set.has(i)) return true;
  }
  return false;
}

/**
 * Validate and normalize a single tour stop. Returns the cleaned stop or null.
 * @param {unknown} stop
 * @param {Object} ctx - { hunksByFile, changedLines, worktreePath }
 * @returns {Promise<Object|null>}
 */
async function validateStop(stop, ctx) {
  if (!stop || typeof stop !== 'object') return null;

  const filePath = typeof stop.file_path === 'string' ? stop.file_path : null;
  const title = typeof stop.title === 'string' ? stop.title.trim() : '';
  const description = typeof stop.description === 'string' ? stop.description.trim() : '';
  if (!filePath || !title || !description) return null;

  const ls = Number(stop.line_start);
  const le = Number(stop.line_end);
  if (!Number.isInteger(ls) || ls < 1) return null;
  if (!Number.isInteger(le) || le < ls) return null;

  let normSide = typeof stop.side === 'string' ? stop.side.trim().toUpperCase() : 'RIGHT';
  if (normSide !== 'LEFT' && normSide !== 'RIGHT') normSide = 'RIGHT';

  // Context stops reference lines outside the rendered diff. The frontend
  // renderer cannot anchor to rows that aren't in the DOM, so dropping them
  // here keeps tours pointed only at lines a user can actually navigate to.
  // Gap-expansion is a separate feature; see plans/semantic-hunk-summaries-and-tours.md.
  if (stop.is_context === true) {
    logger.info(
      `${TOUR_LOG_PREFIX} dropping context stop ${filePath}:${ls}-${le} — gap expansion not yet supported in renderer`
    );
    return null;
  }

  if (!ctx.hunksByFile.has(filePath)) {
    logger.warn(`${TOUR_LOG_PREFIX} dropping changed-file stop for file outside diff: ${filePath}`);
    return null;
  }
  const lineSet = (normSide === 'LEFT' ? ctx.changedLines.left : ctx.changedLines.right).get(filePath);
  if (!rangeIntersectsSet(ls, le, lineSet)) {
    logger.warn(
      `${TOUR_LOG_PREFIX} dropping changed-file stop ${filePath}:${ls}-${le} (${normSide}) — does not intersect changed lines`
    );
    return null;
  }

  return {
    file_path: filePath,
    side: normSide,
    line_start: ls,
    line_end: le,
    title: title.slice(0, TOUR_TITLE_MAX),
    description: description.slice(0, TOUR_DESCRIPTION_MAX)
  };
}

/**
 * Generate a guided tour for a review and persist + broadcast it.
 * @param {Object} params
 * @param {Object} params.db
 * @param {Object} params.config
 * @param {number} params.reviewId
 * @param {string} params.diffText - Full unified diff for the review snapshot.
 * @param {string} params.worktreePath
 * @param {Object} [params.reviewContext]
 * @param {string} [params.diffHash] - Precomputed hash of `diffText`. When
 *   provided (e.g. from `kickOffTourJob`), used directly instead of being
 *   recomputed via `deps.hashDiff`. This makes the producer/consumer
 *   relationship between the kickoff and worker explicit rather than
 *   relying on the implicit invariant that `hashDiff` is deterministic
 *   across calls.
 * @param {Object} [params._deps]
 * @returns {Promise<{generated: boolean, stops: number, reason?: string}>}
 */
async function generateTourForReview({
  db,
  config,
  reviewId,
  diffText,
  worktreePath,
  reviewContext,
  diffHash: providedDiffHash,
  abortSignal,
  _deps
}) {
  const deps = { ...defaults, ..._deps };

  // Helper: convert "aborted between awaits" into a rejected promise so we
  // never persist partial work after a user cancel. Throwing an AbortError
  // also tells the BackgroundQueue this completed via cancellation, which
  // it surfaces in the broadcast event.
  const throwIfAborted = () => {
    if (abortSignal && abortSignal.aborted) {
      const err = new Error(`${TOUR_LOG_PREFIX} review ${reviewId}: cancelled`);
      err.name = 'AbortError';
      err.isCancellation = true;
      throw err;
    }
  };

  if (!diffText || !diffText.trim()) {
    logger.info(`${TOUR_LOG_PREFIX} review ${reviewId}: no diff text; skipping`);
    return { generated: false, stops: 0, reason: 'no_diff' };
  }

  const hunksByFile = deps.parseUnifiedDiffHunks(diffText);
  if (!hunksByFile || hunksByFile.size === 0) {
    logger.info(`${TOUR_LOG_PREFIX} review ${reviewId}: diff parsed to zero files; skipping`);
    return { generated: false, stops: 0, reason: 'empty_diff' };
  }

  // Use the precomputed hash from the caller (kickOffTourJob) when
  // available — that's the value stamped on `latestRequestedDiffHash`, so
  // sharing it removes any "hashDiff must be deterministic" hidden
  // contract between the two functions. Fall back to recomputing for
  // direct callers (tests, ad-hoc invocations).
  const diffHash = (typeof providedDiffHash === 'string' && providedDiffHash)
    ? providedDiffHash
    : deps.hashDiff(diffText);

  const tourRepo = new deps.TourRepository(db);
  const existing = await tourRepo.get(reviewId);
  if (existing && existing.diff_hash === diffHash) {
    logger.debug(`${TOUR_LOG_PREFIX} review ${reviewId}: cached tour matches diff_hash; skipping`);
    deps.broadcastReviewEvent(reviewId, { type: 'review:tour_ready' });
    return { generated: false, stops: 0, reason: 'cached' };
  }

  // Skip the expensive provider call if a newer kickoff has already
  // superseded this one before we even started exploring.
  const latestBeforeProvider = latestRequestedDiffHash.get(reviewId);
  if (latestBeforeProvider !== undefined && latestBeforeProvider !== diffHash) {
    logger.debug(
      `${TOUR_LOG_PREFIX} review ${reviewId}: superseded before provider call (have ${latestBeforeProvider}, this ${diffHash}); skipping`
    );
    return { generated: false, stops: 0, superseded: true, reason: 'superseded' };
  }

  const preferredProviderId = deps.getTourProvider(config);
  const providerId = deps.resolveNonExecutableProviderId(preferredProviderId);
  if (!providerId) {
    logger.info(`${TOUR_LOG_PREFIX} review ${reviewId}: no agentic provider available; skipping`);
    return { generated: false, stops: 0, reason: 'no_provider' };
  }

  let provider;
  let resolvedModel;
  try {
    const initial = deps.createProvider(providerId);
    const ProviderClass = initial.constructor;
    resolvedModel = deps.getTourModel(config, ProviderClass);
    provider = deps.createProvider(providerId, resolvedModel);
  } catch (err) {
    logger.info(`${TOUR_LOG_PREFIX} review ${reviewId}: provider unavailable (${err.message}); skipping`);
    return { generated: false, stops: 0, reason: 'provider_error' };
  }

  const ctx = reviewContext || {};
  const prompt = deps.buildTourPrompt({
    prTitle: ctx.prTitle,
    prDescription: ctx.prDescription,
    scriptCommand: buildScriptCommand(worktreePath),
    changedFiles: Array.from(hunksByFile.keys()),
    worktreePath
  });

  throwIfAborted();
  let result;
  try {
    result = await provider.execute(prompt, {
      cwd: worktreePath,
      logPrefix: TOUR_LOG_PREFIX,
      abortSignal,
    });
  } catch (execErr) {
    if (execErr && (execErr.name === 'AbortError' || execErr.isCancellation)) {
      logger.info(`${TOUR_LOG_PREFIX} review ${reviewId}: cancelled during provider call`);
      throw execErr;
    }
    logger.error(`${TOUR_LOG_PREFIX} review ${reviewId}: provider error: ${execErr.message}`);
    return { generated: false, stops: 0, reason: 'provider_throw' };
  }

  let data;
  if (result && Array.isArray(result.stops)) {
    data = { stops: result.stops };
  } else if (result && result.data && (result.parsed || result.success)) {
    data = result.data;
  } else {
    const raw = (result && result.raw) || '';
    const extracted = deps.extractJSON(raw, 'tour', TOUR_LOG_PREFIX);
    if (!extracted || !extracted.success) {
      const errMsg = extracted && extracted.error ? extracted.error : 'unknown error';
      logger.warn(`${TOUR_LOG_PREFIX} review ${reviewId}: JSON parse failed: ${errMsg}`);
      return { generated: false, stops: 0, reason: 'malformed' };
    }
    data = extracted.data;
  }

  if (!data || !Array.isArray(data.stops)) {
    logger.warn(`${TOUR_LOG_PREFIX} review ${reviewId}: response missing stops[]`);
    return { generated: false, stops: 0, reason: 'malformed' };
  }

  const changedLines = buildChangedLineIndex(hunksByFile);
  const validationCtx = {
    hunksByFile,
    changedLines,
    worktreePath
  };

  const validated = [];
  for (const stop of data.stops) {
    if (validated.length >= TOUR_MAX_STOPS) break;
    const cleaned = await validateStop(stop, validationCtx);
    if (!cleaned) continue;

    // Drop stops that overlap an already-accepted stop on the same
    // (file_path, side). Two ranges [a,b] and [c,d] overlap iff a <= d && c <= b.
    const overlaps = validated.some((accepted) => (
      accepted.file_path === cleaned.file_path
      && accepted.side === cleaned.side
      && cleaned.line_start <= accepted.line_end
      && accepted.line_start <= cleaned.line_end
    ));
    if (overlaps) {
      logger.debug(
        `${TOUR_LOG_PREFIX} review ${reviewId}: dropping overlapping stop ${cleaned.file_path}:${cleaned.line_start}-${cleaned.line_end} (${cleaned.side})`
      );
      continue;
    }

    validated.push(cleaned);
  }

  if (validated.length < TOUR_PERSIST_MIN_STOPS) {
    logger.info(
      `${TOUR_LOG_PREFIX} review ${reviewId}: ${validated.length} valid stops after filtering; below persist threshold (${TOUR_PERSIST_MIN_STOPS}) — not tour-worthy`
    );
    return { generated: false, stops: 0, reason: 'not_tour_worthy' };
  }

  throwIfAborted();
  // Last-chance superseded check: another kickoff with a different diff
  // arrived while we were exploring/validating. Skip the write so we don't
  // overwrite a tour that's about to be regenerated for a newer diff.
  const latestBeforeUpsert = latestRequestedDiffHash.get(reviewId);
  if (latestBeforeUpsert !== undefined && latestBeforeUpsert !== diffHash) {
    logger.debug(
      `${TOUR_LOG_PREFIX} review ${reviewId}: superseded before upsert (have ${latestBeforeUpsert}, this ${diffHash}); skipping persist`
    );
    return { generated: false, stops: 0, superseded: true, reason: 'superseded' };
  }

  await tourRepo.upsert({
    review_id: reviewId,
    stops: JSON.stringify(validated),
    diff_hash: diffHash,
    provider: providerId,
    model: resolvedModel
  });

  // Intentionally do NOT clear `latestRequestedDiffHash` on success. A
  // predecessor worker whose cancel was lost (e.g., the provider's HTTP call
  // didn't honor AbortSignal) may still be poised to reach its pre-upsert
  // check. If we deleted our entry, that predecessor would see `undefined`,
  // pass its `latestBeforeUpsert !== undefined && ...` guard, and overwrite
  // our fresh row with a tour for the now-stale diff. Leaving the entry set
  // to our hash makes the predecessor's hash mismatch and skip. The map
  // grows by at most one entry per review until the next kickoff overwrites.
  deps.broadcastReviewEvent(reviewId, { type: 'review:tour_ready' });

  logger.info(
    `${TOUR_LOG_PREFIX} review ${reviewId}: persisted tour with ${validated.length} stops (diff_hash=${diffHash})`
  );
  return { generated: true, stops: validated.length };
}

/**
 * Gate the tour job and enqueue it on the background queue.
 *
 * Dedup via the queue's `(reviewId, 'tour')` key — concurrent kickoffs share
 * a single execution. Staleness is checked inside the generator itself via
 * `diff_hash` comparison.
 *
 * `trigger` controls how the enabled/auto_generate config interacts with
 * kickoff:
 *   - `'auto'`   (default): requires `tours.enabled && tours.auto_generate`
 *   - `'manual'`: only requires `tours.enabled` (user-initiated start)
 *
 * @param {Object} params
 * @param {Object} params.db
 * @param {Object} params.config
 * @param {number} params.reviewId
 * @param {string} params.diffText
 * @param {string} params.worktreePath
 * @param {Object} [params.reviewContext]
 * @param {'auto'|'manual'} [params.trigger='auto']
 * @param {Object} [params._deps]
 * @returns {Promise<Object>|null}
 */
async function kickOffTourJob({
  db,
  config,
  reviewId,
  diffText,
  worktreePath,
  reviewContext,
  trigger = 'auto',
  _deps
}) {
  const deps = { ...defaults, ...(_deps || {}) };

  if (!deps.getTourEnabled(config)) return null;

  if (!reviewId) {
    logger.debug('kickOffTourJob skipped: missing reviewId');
    return null;
  }

  const queue = deps.backgroundQueue || require('./background-queue').backgroundQueue;

  // Cancel any in-flight tour job whose diff hash no longer matches. This is
  // load-bearing for both cost (stops a stale provider call from burning
  // tokens) and correctness — the in-generator superseded check relies on
  // `latestRequestedDiffHash` reflecting the current desired snapshot. Calling
  // this even when the new diff is empty (a valid terminal snapshot after a
  // refresh or scope change) keeps the old worker from observing a stale,
  // matching hash and persisting a tour the user has moved past.
  const cancelActiveTourJob = () => {
    if (
      typeof queue.findActiveJobType === 'function' &&
      queue.findActiveJobType(reviewId, 'tour') &&
      typeof queue.cancel === 'function'
    ) {
      queue.cancel(reviewId, 'tour');
    }
  };

  if (!diffText || !worktreePath) {
    const missing = [];
    if (!diffText) missing.push('diffText');
    if (!worktreePath) missing.push('worktreePath');
    logger.debug(`kickOffTourJob skipped: missing ${missing.join(', ')}`);
    // Stamp a sentinel so any in-flight worker's pre-upsert check sees a
    // different value than its own hash and bails. The sentinel is intentionally
    // non-hashlike so a real diff can never collide with it.
    //
    // Run cleanup unconditionally (not gated on a prior in-process hash). The
    // map is in-memory: after a server restart it's empty, but a persisted
    // row from a pre-restart session can still exist. Without unconditional
    // cleanup, the first post-restart empty-diff transition would leave a
    // stale row that GET /api/reviews/:id/tour serves verbatim (no diff_hash
    // check), pointing the UI at stops no longer in the diff. `deleteByReview`
    // is idempotent; the `changes > 0` guard below suppresses the broadcast
    // on a fresh review that never had a tour.
    latestRequestedDiffHash.set(reviewId, '__empty__');
    cancelActiveTourJob();
    try {
      const repo = new deps.TourRepository(db);
      const result = await repo.deleteByReview(reviewId);
      if (result && result.changes > 0) {
        deps.broadcastReviewEvent(reviewId, { type: 'review:tour_ready' });
      }
    } catch (err) {
      logger.warn(
        `${TOUR_LOG_PREFIX} review ${reviewId}: failed to delete stale tour row on empty-diff cleanup: ${err.message}`
      );
    }
    return null;
  }

  // Stamp the latest requested diff hash BEFORE enqueueing so that an
  // in-flight job (potentially started by a previous kickoff with an older
  // diff) can observe it and decide to skip persistence.
  const diffHash = deps.hashDiff(diffText);
  const previousHash = latestRequestedDiffHash.get(reviewId);
  latestRequestedDiffHash.set(reviewId, diffHash);

  // Belt-and-suspenders: if a tour job is in flight with a different diff
  // hash, cancel it now. The worker's staleness check at persistence time
  // would discard its output anyway (the suspenders); cancelling stops the
  // upstream provider call from burning more tokens (the belt). The order
  // matters: the hash above is already stamped, so any not-yet-cancelled
  // worker observing the map sees the new hash and skips persistence.
  if (previousHash && previousHash !== diffHash) {
    cancelActiveTourJob();
  }

  // auto_generate gate, applied here — AFTER cancellation, the empty-diff
  // cleanup, and the latestRequestedDiffHash stamp above — so all of that
  // stale-state hygiene runs regardless of trigger. With `auto_generate`
  // off, an auto-triggered kickoff (e.g. a refresh/scope-change re-invoke
  // after a manual start) still cancels the in-flight job against the old
  // diff and stamps the new hash; it simply declines to enqueue a
  // replacement. Manual kickoffs always proceed.
  //
  // Before declining, reconcile the persisted row against the new diff. GET
  // /api/reviews/:id/tour serves the row verbatim (no diff_hash check) and
  // the frontend treats any non-empty stops as ready, so a stale row would
  // map the old tour onto the new diff AND block the manual-generate click
  // path (stops aren't empty). Compare against the PERSISTED diff_hash, not
  // `previousHash`: `latestRequestedDiffHash` is empty after a server
  // restart, so a previousHash-based guard would let a pre-restart stale
  // row slip through. Same shape as the empty-diff branch above.
  if (trigger !== 'manual' && !deps.getTourAutoGenerate(config)) {
    try {
      const repo = new deps.TourRepository(db);
      const row = await repo.get(reviewId);
      if (row && row.diff_hash !== diffHash) {
        const result = await repo.deleteByReview(reviewId);
        if (result && result.changes > 0) {
          deps.broadcastReviewEvent(reviewId, { type: 'review:tour_ready' });
        }
      }
    } catch (err) {
      logger.warn(
        `${TOUR_LOG_PREFIX} review ${reviewId}: failed to delete stale tour row on auto_generate=false gate: ${err.message}`
      );
    }
    return null;
  }

  const worker = deps.generateTourForReview || generateTourForReview;
  return queue.enqueue(reviewId, 'tour', (signal) =>
    worker({
      db,
      config,
      reviewId,
      diffText,
      worktreePath,
      reviewContext,
      // Thread the hash we already computed through to the worker rather
      // than relying on the (implicit) invariant that hashDiff produces
      // the same output for the same diffText in both call sites.
      diffHash,
      // The BackgroundQueue calls our thunk as `fn(signal)`; pass it on so
      // a user-initiated cancel reaches the upstream provider call.
      abortSignal: signal,
      _deps
    })
  );
}

module.exports = {
  generateTourForReview,
  kickOffTourJob,
  // Exported for tests
  parseHunkHeader,
  buildChangedLineIndex,
  buildScriptCommand,
  validateStop,
  latestRequestedDiffHash,
  resetLatestRequestedDiffHash: () => latestRequestedDiffHash.clear()
};
