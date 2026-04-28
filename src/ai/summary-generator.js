// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const crypto = require('crypto');
const logger = require('../utils/logger');

const defaults = {
  parseUnifiedDiffHunks: require('../utils/diff-hunks').parseUnifiedDiffHunks,
  hashHunk: require('./hunk-hashing').hashHunk,
  isTrivialHunk: require('./hunk-hashing').isTrivialHunk,
  HunkSummaryRepository: require('../database').HunkSummaryRepository,
  createProvider: require('./provider').createProvider,
  resolveNonExecutableProviderId: require('./provider').resolveNonExecutableProviderId,
  getBackgroundProvider: require('../config').getBackgroundProvider,
  getBackgroundModel: require('../config').getBackgroundModel,
  buildHunkSummaryPrompt: require('./prompts/hunk-summary').buildHunkSummaryPrompt,
  extractJSON: require('../utils/json-extractor').extractJSON,
  getGeneratedFilePatterns: require('../git/gitattributes').getGeneratedFilePatterns,
  broadcastReviewEvent: require('../events/review-events').broadcastReviewEvent,
  hashDiff: (diffText) => crypto.createHash('sha256').update(diffText).digest('hex').slice(0, 16),
  backgroundQueue: null
};

const MAX_SUMMARY_LENGTH = 140;

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
    return { filesProcessed: 0, hunksPersisted: 0 };
  }

  let isGeneratedFile = () => false;
  try {
    const parser = await deps.getGeneratedFilePatterns(worktreePath);
    isGeneratedFile = (filePath) => parser.isGenerated(filePath);
  } catch (err) {
    logger.warn(`Failed to load .gitattributes for review ${reviewId}: ${err.message}`);
  }

  const preferredProviderId = deps.getBackgroundProvider(config);
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
    resolvedModel = deps.getBackgroundModel(config, ProviderClass);
    provider = deps.createProvider(providerId, resolvedModel);
  } catch (err) {
    logger.info(
      `Hunk summaries skipped for review ${reviewId}: background provider unavailable (${err.message})`
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
          changedFiles: effectiveContext.changedFiles
        });

        let result;
        try {
          result = await provider.execute(prompt, { cwd: worktreePath });
        } catch (execErr) {
          // (Intentional: see retry-on-reload note below — no sentinel row.)
          logger.error(`Hunk summary provider error for ${filePath}: ${execErr.message}`);
          await broadcastFile(deps, repo, reviewId, filePath);
          filesProcessed++;
          continue;
        }

        let data;
        if (result && Array.isArray(result.summaries)) {
          data = { summaries: result.summaries };
        } else if (result && result.data && (result.parsed || result.success)) {
          data = result.data;
        } else {
          const raw = (result && result.raw) || '';
          const extracted = deps.extractJSON(raw, 'hunk-summary');
          if (!extracted || !extracted.success) {
            // (Intentional: see retry-on-reload note below — no sentinel row.)
            const errMsg = extracted && extracted.error ? extracted.error : 'unknown error';
            logger.warn(`Hunk summary JSON parse failed for ${filePath}: ${errMsg}`);
            await broadcastFile(deps, repo, reviewId, filePath);
            filesProcessed++;
            continue;
          }
          data = extracted.data;
        }

        if (!data || !Array.isArray(data.summaries)) {
          // (Intentional: see retry-on-reload note below — no sentinel row.)
          logger.warn(`Hunk summary response missing summaries[] for ${filePath}`);
          await broadcastFile(deps, repo, reviewId, filePath);
          filesProcessed++;
          continue;
        }

        // Failed/malformed hunks are intentionally NOT persisted. getByHashes sees them
        // as missing on the next reload and the provider is retried. This favors recovery
        // from transient LLM failures over locking persistent failures into a sentinel row.
        // If reload-bombing of persistently-flaky hunks becomes a real cost, add an
        // `attempts` counter or a time-gated retry rather than an always-sentinel row.
        const llmRows = [];
        for (const item of data.summaries) {
          if (!item || typeof item.index !== 'number') continue;
          const idx = item.index - 1;
          if (idx < 0 || idx >= missing.length) continue;
          if (typeof item.summary !== 'string' || item.summary.length === 0) continue;
          const summaryText = item.summary.length > MAX_SUMMARY_LENGTH
            ? item.summary.slice(0, MAX_SUMMARY_LENGTH)
            : item.summary;
          llmRows.push({
            review_id: reviewId,
            file_path: filePath,
            content_hash: missing[idx].contentHash,
            summary_text: summaryText,
            trivial_reason: null,
            provider: providerId,
            model: resolvedModel
          });
        }

        if (llmRows.length > 0) {
          await repo.upsertMany(llmRows);
          hunksPersisted += llmRows.length;
        }
      }

      await broadcastFile(deps, repo, reviewId, filePath);
      filesProcessed++;
    } catch (fileErr) {
      logger.error(`Hunk summary processing failed for ${filePath}: ${fileErr.message}`);
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
    logger.warn(`Hunk summary broadcast failed for ${filePath}: ${err.message}`);
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
  return queue.enqueue(reviewId, `summaries:${digest}`, () =>
    generateSummariesForReview({
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

module.exports = { generateSummariesForReview, kickOffSummaryJob };
