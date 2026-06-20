// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const { v4: uuidv4 } = require('uuid');
const { AnalysisRunRepository, CouncilRepository } = require('../database');
const logger = require('../utils/logger');

/**
 * Run a council analysis without any server infrastructure.
 *
 * This is the server-free twin of `launchCouncilAnalysis` in
 * `src/routes/analyses.js`. It exists for the CLI headless path, where the
 * SSE broadcast helpers (`broadcastProgress`/`broadcastReviewEvent`), the
 * `activeAnalyses` map, the worktree pool lifecycle, and the hook firing of
 * the route are all absent. It reuses the SAME analyzer methods
 * (`runReviewerCentricCouncil` / `runCouncilAnalysis`) and the SAME
 * run-record semantics as the route.
 *
 * IMPORTANT: The two functions MUST stay in parity for run-record fields and
 * completion semantics. Specifically:
 *   - The parent `analysis_runs` row is PRE-CREATED here with
 *     `model = council.id` and `runId` is passed into the analyzer. This is
 *     what attributes the run to the council. The analyzer methods do not
 *     create the parent row when a `runId` is supplied.
 *   - The analyzer methods do NOT mark the parent run completed/failed; this
 *     helper does it (mirroring the route's `.then()` / `.catch()`).
 * Any change to run-record fields or completion handling must be applied to
 * BOTH this function and `launchCouncilAnalysis`.
 *
 * @param {Object} db - Database instance
 * @param {Object} params - Analysis parameters
 * @param {Object} params.analyzer - Analyzer instance exposing
 *   `runReviewerCentricCouncil` and `runCouncilAnalysis`
 * @param {number} params.reviewId - Review ID (PR or local)
 * @param {Object} params.council - Full council row (must have `.id`)
 * @param {string} params.configType - 'council' (voice-centric) or 'advanced'
 * @param {Object} params.councilConfig - The council's parsed config object
 * @param {string} params.worktreePath - Path to the checked-out worktree
 * @param {Object} [params.prMetadata] - PR metadata (head_sha used for the run row)
 * @param {Object} params.instructions - { globalInstructions, repoInstructions, requestInstructions }
 *   (requestInstructions may be null)
 * @param {Object} [params.githubClient] - GitHub client passed through to the analyzer
 * @returns {Promise<Object>} The analyzer result ({ suggestions, summary, levelOutcomes, ... })
 */
async function runHeadlessCouncilAnalysis(db, params) {
  const {
    analyzer,
    reviewId,
    council,
    configType,
    councilConfig,
    worktreePath,
    prMetadata,
    instructions,
    githubClient,
  } = params;

  const runId = uuidv4();

  // Compute levelsConfig the same way launchCouncilAnalysis (analyses.js:533-541) does.
  let levelsConfig = null;
  if (configType === 'council') {
    levelsConfig = councilConfig.levels || null;
  } else if (councilConfig.levels) {
    levelsConfig = {};
    for (const [key, val] of Object.entries(councilConfig.levels)) {
      levelsConfig[key] = val?.enabled !== false;
    }
  }

  const runRepo = new AnalysisRunRepository(db);
  await runRepo.create({
    id: runId,
    reviewId,
    provider: 'council',
    model: council.id,
    tier: null,
    globalInstructions: instructions.globalInstructions || null,
    repoInstructions: instructions.repoInstructions || null,
    requestInstructions: instructions.requestInstructions || null,
    headSha: prMetadata?.head_sha || null,
    configType,
    levelsConfig
  });

  new CouncilRepository(db).touchLastUsedAt(council.id).catch(err => {
    logger.warn(`Failed to update council last_used_at: ${err.message}`);
  });

  const reviewContext = {
    reviewId,
    worktreePath,
    prMetadata,
    changedFiles: null,
    instructions
  };

  try {
    const result = configType === 'council'
      ? await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, { runId, progressCallback: null, githubClient })
      : await analyzer.runCouncilAnalysis(reviewContext, councilConfig, { runId, progressCallback: null, githubClient });

    await runRepo.update(runId, {
      status: 'completed',
      summary: result.summary,
      totalSuggestions: result.suggestions.length,
      ...(result.levelOutcomes ? { levelOutcomes: result.levelOutcomes } : {})
    }).catch(err => {
      logger.warn(`Failed to update analysis_run: ${err.message}`);
    });

    return result;
  } catch (error) {
    await runRepo.update(runId, { status: 'failed' }).catch(() => {});
    throw error;
  }
}

module.exports = { runHeadlessCouncilAnalysis };
