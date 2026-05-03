// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
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
  HunkSummaryRepository: require('../database').HunkSummaryRepository,
  TourRepository: require('../database').TourRepository,
  createProvider: require('./provider').createProvider,
  resolveNonExecutableProviderId: require('./provider').resolveNonExecutableProviderId,
  getTourProvider: require('../config').getTourProvider,
  getTourModel: require('../config').getTourModel,
  buildTourPrompt: require('./prompts/tour').buildTourPrompt,
  extractJSON: require('../utils/json-extractor').extractJSON,
  broadcastReviewEvent: require('../events/review-events').broadcastReviewEvent,
  parseUnifiedDiffHunks: require('../utils/diff-hunks').parseUnifiedDiffHunks,
  hashDiff: (diffText) => crypto.createHash('sha256').update(diffText).digest('hex').slice(0, 16),
  fs,
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
 * Read a file inside the worktree and return its line count.
 * Uses realpath() to block path traversal. Returns null if the file is
 * outside the worktree or cannot be read.
 * @param {string} worktreePath
 * @param {string} filePath - repo-relative
 * @param {Object} fsModule - fs.promises-compatible module
 * @returns {Promise<number|null>}
 */
async function getFileLineCount(worktreePath, filePath, fsModule) {
  if (!worktreePath || !filePath) return null;
  try {
    const abs = path.resolve(worktreePath, filePath);
    const realFile = await fsModule.realpath(abs);
    const realRoot = await fsModule.realpath(worktreePath);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
      return null;
    }
    const content = await fsModule.readFile(realFile, 'utf8');
    if (content.length === 0) return 0;
    return content.split('\n').length;
  } catch {
    return null;
  }
}

/**
 * Validate and normalize a single tour stop. Returns the cleaned stop or null.
 * @param {unknown} stop
 * @param {Object} ctx - { hunksByFile, changedLines, worktreePath, fs, lineCounts }
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

  const isContext = stop.is_context === true;

  if (!isContext) {
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
  } else {
    normSide = 'RIGHT';
    let lineCount;
    if (ctx.lineCounts.has(filePath)) {
      lineCount = ctx.lineCounts.get(filePath);
    } else {
      lineCount = await getFileLineCount(ctx.worktreePath, filePath, ctx.fs);
      ctx.lineCounts.set(filePath, lineCount);
    }
    if (lineCount === null) {
      logger.warn(`${TOUR_LOG_PREFIX} dropping context stop for inaccessible file: ${filePath}`);
      return null;
    }
    if (le > lineCount) {
      logger.warn(
        `${TOUR_LOG_PREFIX} dropping context stop ${filePath}:${ls}-${le} — exceeds file length ${lineCount}`
      );
      return null;
    }
  }

  const out = {
    file_path: filePath,
    side: normSide,
    line_start: ls,
    line_end: le,
    title: title.slice(0, TOUR_TITLE_MAX),
    description: description.slice(0, TOUR_DESCRIPTION_MAX)
  };
  if (isContext) out.is_context = true;
  return out;
}

/**
 * Group non-trivial summary rows by file path for the tour prompt hints.
 * Order is the first-seen file order in the input rows.
 * @param {Array<Object>} rows
 * @returns {Array<{filePath: string, summaries: Array<{summary: string}>}>}
 */
function groupSummariesByFile(rows) {
  const order = [];
  const byFile = new Map();
  for (const row of rows || []) {
    if (!row || !row.file_path || !row.summary_text) continue;
    if (!byFile.has(row.file_path)) {
      byFile.set(row.file_path, []);
      order.push(row.file_path);
    }
    byFile.get(row.file_path).push({ summary: row.summary_text });
  }
  return order.map((filePath) => ({ filePath, summaries: byFile.get(filePath) }));
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
  _deps
}) {
  const deps = { ...defaults, ..._deps };

  if (!diffText || !diffText.trim()) {
    logger.info(`${TOUR_LOG_PREFIX} review ${reviewId}: no diff text; skipping`);
    return { generated: false, stops: 0, reason: 'no_diff' };
  }

  const hunksByFile = deps.parseUnifiedDiffHunks(diffText);
  if (!hunksByFile || hunksByFile.size === 0) {
    logger.info(`${TOUR_LOG_PREFIX} review ${reviewId}: diff parsed to zero files; skipping`);
    return { generated: false, stops: 0, reason: 'empty_diff' };
  }

  const diffHash = deps.hashDiff(diffText);

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

  let summariesByFile = [];
  try {
    const summaryRepo = new deps.HunkSummaryRepository(db);
    const rows = await summaryRepo.getByReview(reviewId);
    summariesByFile = groupSummariesByFile(rows);
  } catch (err) {
    logger.debug(
      `${TOUR_LOG_PREFIX} review ${reviewId}: summaries unavailable (${err.message}); proceeding without hints`
    );
  }

  const ctx = reviewContext || {};
  const prompt = deps.buildTourPrompt({
    prTitle: ctx.prTitle,
    prDescription: ctx.prDescription,
    summariesByFile,
    scriptCommand: buildScriptCommand(worktreePath),
    changedFiles: Array.from(hunksByFile.keys()),
    worktreePath
  });

  let result;
  try {
    result = await provider.execute(prompt, { cwd: worktreePath, logPrefix: TOUR_LOG_PREFIX });
  } catch (execErr) {
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
    worktreePath,
    fs: deps.fs,
    lineCounts: new Map()
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

  // Successful persist: if the map still holds OUR hash, clean it up. Leave
  // it alone if a newer kickoff has already replaced it.
  if (latestRequestedDiffHash.get(reviewId) === diffHash) {
    latestRequestedDiffHash.delete(reviewId);
  }

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
 * @param {Object} params
 * @param {Object} params.db
 * @param {Object} params.config
 * @param {number} params.reviewId
 * @param {string} params.diffText
 * @param {string} params.worktreePath
 * @param {Object} [params.reviewContext]
 * @param {Object} [params._deps]
 * @returns {Promise<Object>|null}
 */
function kickOffTourJob({
  db,
  config,
  reviewId,
  diffText,
  worktreePath,
  reviewContext,
  _deps
}) {
  if (!config || !config.summaries_enabled) return null;
  if (!config.tours_enabled) return null;

  const missing = [];
  if (!reviewId) missing.push('reviewId');
  if (!diffText) missing.push('diffText');
  if (!worktreePath) missing.push('worktreePath');
  if (missing.length > 0) {
    logger.debug(`kickOffTourJob skipped: missing ${missing.join(', ')}`);
    return null;
  }

  const deps = { ...defaults, ...(_deps || {}) };
  const queue = deps.backgroundQueue || require('./background-queue').backgroundQueue;

  // Stamp the latest requested diff hash BEFORE enqueueing so that an
  // in-flight job (potentially started by a previous kickoff with an older
  // diff) can observe it and decide to skip persistence.
  const diffHash = deps.hashDiff(diffText);
  latestRequestedDiffHash.set(reviewId, diffHash);

  const worker = deps.generateTourForReview || generateTourForReview;
  return queue.enqueue(reviewId, 'tour', () =>
    worker({
      db,
      config,
      reviewId,
      diffText,
      worktreePath,
      reviewContext,
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
  groupSummariesByFile,
  validateStop,
  getFileLineCount,
  latestRequestedDiffHash,
  resetLatestRequestedDiffHash: () => latestRequestedDiffHash.clear()
};
