// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const crypto = require('crypto');
const path = require('path');
const logger = require('../utils/logger');

const defaults = {
  parseUnifiedDiffHunks: require('../utils/diff-hunks').parseUnifiedDiffHunks,
  hashHunk: require('./hunk-hashing').hashHunk,
  isTrivialHunk: require('./hunk-hashing').isTrivialHunk,
  HunkSummaryRepository: require('../database').HunkSummaryRepository,
  createProvider: require('./provider').createProvider,
  resolveNonExecutableProviderId: require('./provider').resolveNonExecutableProviderId,
  getSummaryProvider: require('../config').getSummaryProvider,
  getSummaryModel: require('../config').getSummaryModel,
  buildHunkSummaryPrompt: require('./prompts/hunk-summary').buildHunkSummaryPrompt,
  extractJSON: require('../utils/json-extractor').extractJSON,
  getGeneratedFilePatterns: require('../git/gitattributes').getGeneratedFilePatterns,
  broadcastReviewEvent: require('../events/review-events').broadcastReviewEvent,
  hashDiff: (diffText) => crypto.createHash('sha256').update(diffText).digest('hex').slice(0, 16),
  backgroundQueue: null,
  kickOffTourJob: require('./tour-generator').kickOffTourJob
};

/**
 * Count '+' lines in parsed hunks to gate summary/tour generation by added-line volume.
 * Hunk-header lines are not '+'-prefixed by `parseUnifiedDiffHunks`, so this is safe.
 * @param {Map<string, Array<{header: string, lines: string[]}>>} hunksByFile
 * @returns {number}
 */
function countAddedLines(hunksByFile) {
  let total = 0;
  for (const hunks of hunksByFile.values()) {
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) total++;
      }
    }
  }
  return total;
}

/**
 * Generate hunk summaries for a review's diff and persist + broadcast them.
 * @param {Object} params
 * @param {Object} params.db
 * @param {Object} params.config
 * @param {number} params.reviewId
 * @param {string} params.diffText
 * @param {string} params.worktreePath
 * @param {Object} [params.reviewContext]
 * @param {Object} [params._deps]
 * @returns {Promise<{filesProcessed: number, hunksPersisted: number}>}
 */
async function generateSummariesForReview({
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
    return { filesProcessed: 0, hunksPersisted: 0 };
  }

  const hunksByFile = deps.parseUnifiedDiffHunks(diffText);
  if (!hunksByFile || hunksByFile.size === 0) {
    return { filesProcessed: 0, hunksPersisted: 0 };
  }

  const maxFiles = (config && config.summaries_max_files != null)
    ? config.summaries_max_files
    : 50;
  if (hunksByFile.size > maxFiles) {
    logger.info(
      `Skipping hunk summaries for review ${reviewId}: ${hunksByFile.size} files exceeds summaries_max_files=${maxFiles}`
    );
    return { filesProcessed: 0, hunksPersisted: 0, oversized: true };
  }

  const maxLinesAdded = (config && config.summaries_max_lines_added != null)
    ? config.summaries_max_lines_added
    : 3000;
  const linesAdded = countAddedLines(hunksByFile);
  if (linesAdded > maxLinesAdded) {
    logger.info(
      `Skipping hunk summaries for review ${reviewId}: ${linesAdded} added lines exceeds summaries_max_lines_added=${maxLinesAdded}`
    );
    return { filesProcessed: 0, hunksPersisted: 0, oversized: true };
  }

  let isGeneratedFile = () => false;
  try {
    const parser = await deps.getGeneratedFilePatterns(worktreePath);
    isGeneratedFile = (filePath) => parser.isGenerated(filePath);
  } catch (err) {
    logger.warn(`Failed to load .gitattributes for review ${reviewId}: ${err.message}`);
  }

  const preferredProviderId = deps.getSummaryProvider(config);
  const providerId = deps.resolveNonExecutableProviderId(preferredProviderId);
  if (!providerId) {
    logger.info(
      `Hunk summaries skipped for review ${reviewId}: no non-executable provider available`
    );
    return { filesProcessed: 0, hunksPersisted: 0 };
  }

  let provider;
  let resolvedModel;
  try {
    const initialProvider = deps.createProvider(providerId);
    const ProviderClass = initialProvider.constructor;
    resolvedModel = deps.getSummaryModel(config, ProviderClass);
    provider = deps.createProvider(providerId, resolvedModel);
  } catch (err) {
    logger.info(
      `Hunk summaries skipped for review ${reviewId}: summary provider unavailable (${err.message})`
    );
    return { filesProcessed: 0, hunksPersisted: 0 };
  }

  const repo = new deps.HunkSummaryRepository(db);

  const effectiveContext = { ...(reviewContext || {}) };
  if (!effectiveContext.changedFiles) {
    effectiveContext.changedFiles = Array.from(hunksByFile.keys());
  }

  let filesProcessed = 0;
  let hunksPersisted = 0;

  for (const [filePath, hunks] of hunksByFile.entries()) {
    // Use the basename for log readability — full repo-relative paths can be
    // long enough to clutter each log line, and within a single review the
    // basename is almost always unique enough to identify the file.
    const summaryPrefix = `[Summary ${path.basename(filePath)}]`;
    try {
      const classified = hunks.map((hunk) => {
        const content = [hunk.header, ...hunk.lines].join('\n');
        const contentHash = deps.hashHunk(filePath, content);
        const triviality = deps.isTrivialHunk(hunk, filePath, { isGeneratedFile });
        return { hunk, contentHash, triviality };
      });

      const allHashes = classified.map((c) => c.contentHash);
      const existingRows = await repo.getByHashes(reviewId, allHashes);
      const existingHashes = new Set(existingRows.map((row) => row.content_hash));

      const trivialRowsToPersist = [];
      const missing = [];
      for (const item of classified) {
        if (existingHashes.has(item.contentHash)) continue;
        if (item.triviality.trivial) {
          trivialRowsToPersist.push({
            review_id: reviewId,
            file_path: filePath,
            content_hash: item.contentHash,
            summary_text: null,
            trivial_reason: item.triviality.reason,
            provider: null,
            model: null
          });
        } else {
          missing.push(item);
        }
      }

      if (trivialRowsToPersist.length > 0) {
        await repo.upsertMany(trivialRowsToPersist);
        hunksPersisted += trivialRowsToPersist.length;
      }

      if (missing.length > 0) {
        const prompt = deps.buildHunkSummaryPrompt({
          filePath,
          hunks: missing.map((m) => m.hunk),
          prTitle: effectiveContext.prTitle,
          prDescription: effectiveContext.prDescription,
          changedFiles: effectiveContext.changedFiles,
          cwd: worktreePath
        });

        let result;
        try {
          result = await provider.execute(prompt, {
            cwd: worktreePath,
            logPrefix: summaryPrefix
          });
        } catch (execErr) {
          // (Intentional: see retry-on-reload note below — no sentinel row.)
          logger.error(`${summaryPrefix} Hunk summary provider error for ${filePath}: ${execErr.message}`);
          await broadcastFile(deps, repo, reviewId, filePath);
          filesProcessed++;
          continue;
        }

        let data;
        let topLevelMalformed = false;
        if (result && Array.isArray(result.summaries)) {
          data = { summaries: result.summaries };
        } else if (result && result.data && (result.parsed || result.success)) {
          data = result.data;
        } else {
          const raw = (result && result.raw) || '';
          const extracted = deps.extractJSON(raw, 'hunk-summary', summaryPrefix);
          if (!extracted || !extracted.success) {
            const errMsg = extracted && extracted.error ? extracted.error : 'unknown error';
            logger.warn(`${summaryPrefix} Hunk summary JSON parse failed: ${errMsg}`);
            topLevelMalformed = true;
          } else {
            data = extracted.data;
          }
        }

        if (!topLevelMalformed && (!data || !Array.isArray(data.summaries))) {
          logger.warn(`${summaryPrefix} Hunk summary response missing summaries[]`);
          topLevelMalformed = true;
        }

        if (topLevelMalformed) {
          // Asymmetry vs per-slot malformed handling, intentional:
          //   - Envelope malformed (this branch): no sentinel persisted; the
          //     hunks are eligible for re-enqueue on the next reload, the same
          //     as a provider exception (see `execErr` catch above). Truncated
          //     streams, stray markdown fences, and "model rambled past the
          //     JSON" are transient failures and should not lock out hunks.
          //   - Per-slot malformed (below): the model returned a valid envelope
          //     but a specific entry was missing/wrong-type. That IS persisted
          //     as a `model_malformed` sentinel because the model spoke
          //     coherently for the file but not for that slot — re-enqueueing
          //     would just produce the same bad output.
          await broadcastFile(deps, repo, reviewId, filePath);
          filesProcessed++;
          continue;
        }

        // Per-hunk classification. For each slot in `missing`, choose the best
        // outcome from the model's entries:
        //   - valid (non-empty string)  > model_skipped (null) > model_malformed
        // Slots the model never returned for fall through to model_malformed.
        // No truncation: the prompt sets the length budget; we trust the model.
        const VALID = 0;
        const SKIPPED = 1;
        const MALFORMED = 2;
        const slotState = new Array(missing.length).fill(null);

        const setSlot = (idx, kind, summary) => {
          const current = slotState[idx];
          if (!current || kind < current.kind) {
            slotState[idx] = { kind, summary };
          }
        };

        for (const item of data.summaries) {
          if (!item || typeof item.index !== 'number') continue;
          const idx = item.index - 1;
          if (idx < 0 || idx >= missing.length) continue;

          if (typeof item.summary === 'string' && item.summary.length > 0) {
            setSlot(idx, VALID, item.summary);
          } else if (item.summary === null) {
            setSlot(idx, SKIPPED, null);
          } else {
            // undefined, empty string, wrong type
            setSlot(idx, MALFORMED, null);
          }
        }

        const rowsToPersist = [];
        for (let i = 0; i < missing.length; i++) {
          const state = slotState[i] || { kind: MALFORMED, summary: null };
          if (state.kind === VALID) {
            rowsToPersist.push({
              review_id: reviewId,
              file_path: filePath,
              content_hash: missing[i].contentHash,
              summary_text: state.summary,
              trivial_reason: null,
              provider: providerId,
              model: resolvedModel
            });
          } else {
            rowsToPersist.push({
              review_id: reviewId,
              file_path: filePath,
              content_hash: missing[i].contentHash,
              summary_text: null,
              trivial_reason: state.kind === SKIPPED ? 'model_skipped' : 'model_malformed',
              provider: providerId,
              model: resolvedModel
            });
          }
        }

        if (rowsToPersist.length > 0) {
          await repo.upsertMany(rowsToPersist);
          hunksPersisted += rowsToPersist.length;
        }
      }

      await broadcastFile(deps, repo, reviewId, filePath);
      filesProcessed++;
    } catch (fileErr) {
      logger.error(`${summaryPrefix} Hunk summary processing failed: ${fileErr.message}`);
      await broadcastFile(deps, repo, reviewId, filePath);
      filesProcessed++;
    }
  }

  return { filesProcessed, hunksPersisted };
}

/**
 * Fetch all summaries for a file and broadcast them on the review channel.
 * @param {Object} deps
 * @param {Object} repo
 * @param {number} reviewId
 * @param {string} filePath
 * @returns {Promise<void>}
 */
async function broadcastFile(deps, repo, reviewId, filePath) {
  try {
    const fileRowsRaw = await repo.getByReviewAndFile(reviewId, filePath);
    const fileRows = fileRowsRaw.map((r) => ({
      file_path: r.file_path,
      content_hash: r.content_hash,
      summary_text: r.summary_text,
      trivial_reason: r.trivial_reason
    }));
    deps.broadcastReviewEvent(reviewId, {
      type: 'review:hunk_summaries_ready',
      filePath,
      summaries: fileRows
    });
  } catch (err) {
    logger.warn(`[Summary ${path.basename(filePath)}] broadcast failed: ${err.message}`);
  }
}

/**
 * Gate the summary job and enqueue it on the background queue.
 * @param {Object} params
 * @param {Object} params.db
 * @param {Object} params.config
 * @param {number} params.reviewId
 * @param {string} params.diffText
 * @param {string} params.worktreePath
 * @param {Object} [params.reviewContext]
 * @param {Object} [params._deps]
 * @returns {Promise<{filesProcessed: number, hunksPersisted: number}>|null}
 */
function kickOffSummaryJob({
  db,
  config,
  reviewId,
  diffText,
  worktreePath,
  reviewContext,
  _deps
}) {
  if (!config || !config.summaries_enabled) {
    return null;
  }

  const missing = [];
  if (!reviewId) missing.push('reviewId');
  if (!diffText) missing.push('diffText');
  if (!worktreePath) missing.push('worktreePath');
  if (missing.length > 0) {
    logger.debug(`kickOffSummaryJob skipped: missing ${missing.join(', ')}`);
    return null;
  }

  const deps = { ...defaults, ...(_deps || {}) };
  const queue = deps.backgroundQueue || require('./background-queue').backgroundQueue;
  const digest = deps.hashDiff(diffText);
  return queue.enqueue(reviewId, `summaries:${digest}`, async () => {
    const result = await generateSummariesForReview({
      db,
      config,
      reviewId,
      diffText,
      worktreePath,
      reviewContext,
      _deps
    });
    // Cap-hit (`oversized`) gates BOTH summaries and tour — same threshold
    // protects both from runaway cost on huge diffs.
    if (result.oversized) {
      return result;
    }
    // Chain the tour job after summaries land. The tour kickoff itself
    // checks `tours_enabled`, dedups via `(reviewId, 'tour')`, and short-
    // circuits inside the generator when the persisted tour's diff_hash is
    // already current. Failures here must NOT poison the summary result.
    try {
      const tourPromise = deps.kickOffTourJob({
        db,
        config,
        reviewId,
        diffText,
        worktreePath,
        reviewContext,
        _deps
      });
      // Detach: the chained tour job runs to completion in the queue; we do
      // not await it here so summary callers don't block on tour generation.
      if (tourPromise && typeof tourPromise.catch === 'function') {
        tourPromise.catch((err) =>
          logger.warn(`Chained tour job failed for review ${reviewId}: ${err.message}`)
        );
      }
    } catch (err) {
      logger.warn(`Chained tour kickoff threw for review ${reviewId}: ${err.message}`);
    }
    return result;
  });
}

module.exports = { generateSummariesForReview, kickOffSummaryJob, countAddedLines };
