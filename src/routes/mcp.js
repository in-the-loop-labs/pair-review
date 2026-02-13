// SPDX-License-Identifier: GPL-3.0-or-later
const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const { ReviewRepository, CommentRepository, AnalysisRunRepository, RepoSettingsRepository, PRMetadataRepository, query } = require('../database');
const { renderPromptForSkill } = require('../ai/prompts/render-for-skill');
const Analyzer = require('../ai/analyzer');
const { GitWorktreeManager } = require('../git/worktree');
const path = require('path');
const { normalizeRepository } = require('../utils/paths');
const logger = require('../utils/logger');
const {
  activeAnalyses,
  prToAnalysisId,
  localReviewToAnalysisId,
  getLocalReviewKey,
  determineCompletionInfo,
  broadcastProgress,
  createProgressCallback
} = require('./shared');

const router = express.Router();

/**
 * Handle successful completion of an analysis run.
 * Shared between local and PR modes — mode-specific persistence is injected via savePersistence.
 *
 * @param {string} analysisId - The analysis/run tracking ID
 * @param {string} runId - The DB analysis_runs record ID
 * @param {Object} result - The analysis result from Analyzer
 * @param {Function} savePersistence - Async callback for mode-specific DB operations (summary, metadata, etc.). Receives (result) => Promise<void>
 */
async function handleAnalysisCompletion(analysisId, runId, result, savePersistence) {
  // Run mode-specific persistence first (summary, PR metadata, etc.)
  await savePersistence(result);

  const completionInfo = determineCompletionInfo(result);
  const currentStatus = activeAnalyses.get(analysisId);
  if (!currentStatus) return;

  for (let i = 1; i <= completionInfo.completedLevel; i++) {
    if (currentStatus.levels[i]?.status !== 'skipped') {
      currentStatus.levels[i] = { status: 'completed', progress: `Level ${i} complete` };
    }
  }
  currentStatus.levels[4] = { status: 'completed', progress: 'Results finalized' };

  const completedStatus = {
    ...currentStatus,
    status: 'completed',
    level: completionInfo.completedLevel,
    completedLevel: completionInfo.completedLevel,
    completedAt: new Date().toISOString(),
    runId,
    progress: completionInfo.progressMessage,
    suggestionsCount: completionInfo.totalSuggestions,
    filesAnalyzed: currentStatus.filesAnalyzed || 0,
    filesRemaining: 0
  };
  activeAnalyses.set(analysisId, completedStatus);
  broadcastProgress(analysisId, completedStatus);

  // Auto-cleanup after 30 minutes
  setTimeout(() => activeAnalyses.delete(analysisId), 30 * 60 * 1000);
}

/**
 * Handle analysis failure. Preserves skipped/completed level statuses and marks remaining as failed.
 *
 * @param {string} analysisId - The analysis/run tracking ID
 * @param {Error} error - The error that caused the failure
 * @param {string} logContext - Human-readable context for logging (e.g., "local review #1" or "PR #42")
 */
function handleAnalysisFailure(analysisId, error, logContext) {
  const currentStatus = activeAnalyses.get(analysisId);
  if (!currentStatus) return;
  if (error.isCancellation) return;

  logger.error(`MCP analysis failed for ${logContext}: ${error.message}`);
  for (let i = 1; i <= 4; i++) {
    const levelStatus = currentStatus.levels[i]?.status;
    if (levelStatus !== 'skipped' && levelStatus !== 'completed') {
      currentStatus.levels[i] = { status: 'failed', progress: 'Failed' };
    }
  }
  const failedStatus = {
    ...currentStatus,
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: error.message,
    progress: 'Analysis failed'
  };
  activeAnalyses.set(analysisId, failedStatus);
  broadcastProgress(analysisId, failedStatus);

  // Auto-cleanup after 30 minutes
  setTimeout(() => activeAnalyses.delete(analysisId), 30 * 60 * 1000);
}

/**
 * Resolve a review from the database using either local (path + headSha) or PR (repo + prNumber) params.
 *
 * @param {Object} args - Tool arguments
 * @param {Object} db - Database instance
 * @returns {Promise<{review: Object|null, error: string|null}>}
 */
async function resolveReview(args, db) {
  const reviewRepo = new ReviewRepository(db);

  if (args.path && args.headSha) {
    const review = await reviewRepo.getLocalReview(args.path, args.headSha);
    if (!review) {
      return { review: null, error: `No local review found for path "${args.path}" with HEAD SHA "${args.headSha}"` };
    }
    return { review, error: null };
  }

  if (args.repo && args.prNumber) {
    const review = await reviewRepo.getReviewByPR(args.prNumber, args.repo);
    if (!review) {
      return { review: null, error: `No review found for PR #${args.prNumber} in ${args.repo}` };
    }
    return { review, error: null };
  }

  return {
    review: null,
    error: 'You must provide either (path + headSha) for local reviews or (repo + prNumber) for GitHub PR reviews'
  };
}

// Shared input schema for review lookup
const reviewLookupSchema = {
  path: z.string().optional().describe('Local path (for local reviews)'),
  headSha: z.string().optional().describe('HEAD SHA (for local reviews)'),
  repo: z.string().optional().describe('"owner/repo" (for PR reviews)'),
  prNumber: z.number().optional().describe('PR number (for PR reviews)'),
};

/**
 * Create and configure an MCP server with tools bound to the given database.
 *
 * @param {Object} db - Database instance
 * @param {Object} [options] - Optional configuration
 * @param {number} [options.port] - When provided, enables the get_server_info tool with this port
 * @param {Object} [options.config] - App config (for model/provider resolution in start_analysis)
 * @returns {McpServer}
 */
function createMCPServer(db, options = {}) {
  const packageJson = require('../../package.json');

  const server = new McpServer({
    name: 'pair-review',
    version: packageJson.version,
  }, {
    capabilities: { tools: {} }
  });

  // --- Tool: get_server_info (when port is provided) ---
  if (options.port) {
    server.tool(
      'get_server_info',
      'Get pair-review server info including the web UI URL. ' +
      'Call this FIRST to discover the running server URL before any other action. ' +
      'To open a GitHub PR for review: `open {url}/pr/{owner}/{repo}/{number}`. ' +
      'To open a local directory for review: `open {url}/local?path={absolute_directory_path}` (URL-encode the path). ' +
      'If the review does not yet exist, the setup flow will automatically create it.',
      {},
      async () => {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              url: `http://localhost:${options.port}`,
              port: options.port,
              version: packageJson.version,
            }, null, 2)
          }]
        };
      }
    );
  }

  // --- Tool: get_analysis_prompt (stateless — no DB dependency) ---
  server.tool(
    'get_analysis_prompt',
    'Get the rendered analysis prompt for a review level and tier. ' +
    'Returns prompt text to use as instructions for an analysis agent. ' +
    'Tiers: "fast" for quick/surface review (best for Haiku-class models), ' +
    '"balanced" for standard review (Sonnet-class, recommended default), ' +
    '"thorough" for deep analysis (Opus-class or reasoning models). ' +
    'Supports optional custom instructions to inject repo/user-specific guidance.',
    {
      promptType: z.enum(['level1', 'level2', 'level3', 'orchestration'])
        .describe('Analysis level'),
      tier: z.enum(['fast', 'balanced', 'thorough']).default('balanced')
        .describe('Prompt tier — fast (surface), balanced (standard), or thorough (deep)'),
      customInstructions: z.string().max(5000).optional()
        .describe('Optional repo or user-specific review instructions to include'),
    },
    async (args) => {
      try {
        const rendered = renderPromptForSkill(args.promptType, args.tier, {
          customInstructions: args.customInstructions,
        });
        return { content: [{ type: 'text', text: rendered }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // --- Tool: get_user_comments ---
  server.tool(
    'get_user_comments',
    'Get human-curated review comments for a code review. ' +
    'These are comments the user authored or adopted from AI suggestions — use them as actionable feedback to fix and iterate on code. ' +
    'Returns comments grouped by file. Provide (path + headSha) for local reviews or (repo + prNumber) for PR reviews.',
    {
      ...reviewLookupSchema,
      file: z.string().optional().describe('Filter results to a single file path'),
    },
    async (args) => {
      const { review, error } = await resolveReview(args, db);
      if (error) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
      }

      const commentRepo = new CommentRepository(db);
      let comments = await commentRepo.getUserComments(review.id, { includeDismissed: false });

      if (args.file) {
        comments = comments.filter(c => c.file === args.file);
      }

      // Group by file for readability
      const grouped = {};
      for (const c of comments) {
        const file = c.file || '(file-level)';
        if (!grouped[file]) grouped[file] = [];
        grouped[file].push({
          file: c.file,
          line_start: c.line_start,
          line_end: c.line_end,
          side: c.side,
          body: c.body,
          type: c.type,
          title: c.title,
          status: c.status,
          created_at: c.created_at,
        });
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ review_id: review.id, comments: grouped }, null, 2)
        }]
      };
    }
  );

  // --- Tool: get_ai_analysis_runs ---
  server.tool(
    'get_ai_analysis_runs',
    'List AI analysis runs for a code review, ordered by most recent first. ' +
    'Use this to discover available runs before requesting AI suggestions from a specific one. ' +
    'Use limit=1 to poll for the latest run\'s status after starting an analysis. ' +
    'Provide (path + headSha) for local reviews or (repo + prNumber) for PR reviews.',
    {
      ...reviewLookupSchema,
      limit: z.number().int().positive().optional()
        .describe('Maximum number of runs to return (most recent first). Use limit=1 to poll for the latest run.'),
      includeChildRuns: z.boolean().optional()
        .describe('Include child reviewer runs from council analyses. Defaults to false (only top-level runs).'),
    },
    async (args) => {
      const { review, error } = await resolveReview(args, db);
      if (error) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
      }

      const runRepo = new AnalysisRunRepository(db);
      let runs = await runRepo.getByReviewId(review.id, { limit: args.limit });

      // By default, exclude child runs (they're an internal implementation detail)
      if (!args.includeChildRuns) {
        runs = runs.filter(r => !r.parent_run_id);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            review_id: review.id,
            count: runs.length,
            runs: runs.map(r => ({
              id: r.id,
              provider: r.provider,
              model: r.model,
              status: r.status,
              summary: r.summary,
              head_sha: r.head_sha,
              total_suggestions: r.total_suggestions,
              files_analyzed: r.files_analyzed,
              started_at: r.started_at,
              completed_at: r.completed_at,
            }))
          }, null, 2)
        }]
      };
    }
  );

  // --- Tool: get_ai_suggestions ---
  server.tool(
    'get_ai_suggestions',
    'Get AI-generated review suggestions for a code review, enabling a critic loop where an AI reviewer flags issues for the coding agent to address. ' +
    'Returns suggestions from the latest analysis run by default, or from a specific run via runId. ' +
    'Provide (path + headSha) for local reviews, (repo + prNumber) for PR reviews, or just runId if already known.',
    {
      ...reviewLookupSchema,
      file: z.string().optional().describe('Filter results to a single file path'),
      status: z.enum(['active', 'adopted', 'dismissed']).optional()
        .describe('Filter by suggestion status. Defaults to active and adopted (dismissed excluded).'),
      runId: z.string().optional()
        .describe('Analysis run ID to fetch suggestions from. Use get_ai_analysis_runs to list available runs. Defaults to the latest run.'),
    },
    async (args) => {
      let reviewId = null;
      let runId = args.runId || null;
      let runSummary = null;

      const runRepo = new AnalysisRunRepository(db);

      if (!args.runId) {
        // No runId provided — resolve the review, then find its latest analysis run
        const { review, error } = await resolveReview(args, db);
        if (error) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
        }
        reviewId = review.id;

        const latestRun = await runRepo.getLatestByReviewId(reviewId);
        if (latestRun) {
          runId = latestRun.id;
          runSummary = latestRun.summary;
        }
      } else {
        // runId is globally unique — look up the review_id from the analysis run
        const analysisRun = await runRepo.getById(args.runId);
        if (analysisRun) {
          reviewId = analysisRun.review_id;
          runSummary = analysisRun.summary;
        }
      }

      // No run found — return early with empty results
      if (!runId) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              review_id: reviewId,
              run_id: null,
              summary: null,
              count: 0,
              suggestions: [],
            }, null, 2)
          }]
        };
      }

      // Build parameterized WHERE conditions
      const params = [runId];
      const conditions = ["ai_run_id = ?", "source = 'ai'", 'ai_level IS NULL', '(is_raw = 0 OR is_raw IS NULL)'];

      if (args.status) {
        conditions.push('status = ?');
        params.push(args.status);
      } else {
        // Exclude dismissed by default — dismissed suggestions were explicitly
        // rejected by the reviewer and would be noise for an iterating agent.
        conditions.push("status IN ('active', 'adopted')");
      }

      if (args.file) {
        conditions.push('file = ?');
        params.push(args.file);
      }

      const filtered = await query(db, `
        SELECT
          id, ai_run_id, ai_level, ai_confidence,
          file, line_start, line_end, type, title, body,
          reasoning, status, is_file_level, created_at
        FROM comments
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY file, line_start
      `, params);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            review_id: reviewId,
            run_id: runId,
            summary: runSummary,
            count: filtered.length,
            suggestions: filtered.map(s => ({
              file: s.file,
              line_start: s.line_start,
              line_end: s.line_end,
              title: s.title,
              body: s.body,
              type: s.type,
              ai_confidence: s.ai_confidence,
              status: s.status,
              reasoning: s.reasoning ? JSON.parse(s.reasoning) : null,
            }))
          }, null, 2)
        }]
      };
    }
  );

  // --- Tool: start_analysis ---
  server.tool(
    'start_analysis',
    'Start an AI analysis within pair-review for local or PR changes. ' +
    'Returns immediately with tracking IDs so the caller can poll for completion. ' +
    'For local mode, provide (path + headSha). For PR mode, provide (repo + prNumber). ' +
    'Use get_ai_analysis_runs with limit=1 to poll for completion, then get_ai_suggestions to fetch results.',
    {
      ...reviewLookupSchema,
      customInstructions: z.string().max(5000).optional()
        .describe('Optional repo or user-specific review instructions'),
      skipLevel3: z.boolean().default(false)
        .describe('Whether to skip Level 3 (codebase context) analysis'),
      tier: z.enum(['fast', 'balanced', 'thorough']).default('balanced')
        .describe('Analysis tier: fast (surface), balanced (standard), or thorough (deep)'),
    },
    async (args) => {
      // Track analysisId and key for cleanup in catch block (must be outside try scope)
      let analysisId = null;
      let trackingKey = null;
      let trackingMap = null;

      try {
        const reviewRepo = new ReviewRepository(db);
        const repoSettingsRepo = new RepoSettingsRepository(db);
        const config = options.config || {};

        // Validate: catch partial inputs with specific error messages
        if (args.path && !args.headSha) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'Local mode requires both "path" and "headSha". Missing: headSha' })
            }]
          };
        }
        if (!args.path && args.headSha) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'Local mode requires both "path" and "headSha". Missing: path' })
            }]
          };
        }
        if (args.repo && !args.prNumber) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'PR mode requires both "repo" and "prNumber". Missing: prNumber' })
            }]
          };
        }
        if (!args.repo && args.prNumber) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'PR mode requires both "repo" and "prNumber". Missing: repo' })
            }]
          };
        }

        // Determine mode: local or PR
        if (args.path && args.headSha) {
          // --- LOCAL MODE ---
          const localPath = args.path;
          const localHeadSha = args.headSha;

          // Look up or create local review record
          // Try to get repository name from existing review, else use directory basename
          let repository;
          const existingReview = await reviewRepo.getLocalReview(localPath, localHeadSha);
          if (existingReview) {
            repository = existingReview.repository;
          } else {
            repository = path.basename(localPath);
          }

          const reviewId = await reviewRepo.upsertLocalReview({
            localPath,
            localHeadSha,
            repository
          });

          // Concurrent analysis guard: check if one is already running
          const reviewKey = getLocalReviewKey(reviewId);
          const existingAnalysisId = localReviewToAnalysisId.get(reviewKey);
          if (existingAnalysisId && activeAnalyses.get(existingAnalysisId)?.status === 'running') {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  analysisId: existingAnalysisId,
                  reviewId,
                  status: 'already_running',
                  message: 'An analysis is already running for this review'
                }, null, 2)
              }]
            };
          }

          const review = await reviewRepo.getLocalReviewById(reviewId);

          // Resolve provider and model
          const repoSettings = repository ? await repoSettingsRepo.getRepoSettings(repository) : null;
          const provider = process.env.PAIR_REVIEW_PROVIDER || repoSettings?.default_provider || config.default_provider || config.provider || 'claude';
          const model = process.env.PAIR_REVIEW_MODEL || repoSettings?.default_model || config.default_model || config.model || 'opus';

          // Create unified run/analysis ID and DB record immediately
          const runId = uuidv4();
          analysisId = runId;
          trackingKey = reviewKey;
          trackingMap = localReviewToAnalysisId;

          const requestInstructions = args.customInstructions?.trim() || null;
          const repoInstructions = repoSettings?.default_instructions || null;

          // Set up initial status in activeAnalyses
          const initialStatus = {
            id: analysisId,
            reviewId,
            repository: review.repository,
            reviewType: 'local',
            status: 'running',
            startedAt: new Date().toISOString(),
            progress: 'Starting analysis...',
            levels: {
              1: { status: 'running', progress: 'Starting...' },
              2: { status: 'running', progress: 'Starting...' },
              3: args.skipLevel3 ? { status: 'skipped', progress: 'Skipped' } : { status: 'running', progress: 'Starting...' },
              4: { status: 'pending', progress: 'Pending' }
            },
            filesAnalyzed: 0,
            filesRemaining: 0
          };
          activeAnalyses.set(analysisId, initialStatus);

          // Store local review to analysis ID mapping
          localReviewToAnalysisId.set(reviewKey, analysisId);

          broadcastProgress(analysisId, initialStatus);

          // Create analyzer and launch asynchronously
          const analyzer = new Analyzer(db, model, provider);
          const localMetadata = {
            id: reviewId,
            repository: review.repository,
            title: `Local changes in ${review.repository}`,
            description: `Reviewing uncommitted changes in ${localPath}`,
            base_sha: localHeadSha,
            head_sha: localHeadSha,
            reviewType: 'local'
          };

          // Get changed files for local mode
          const changedFiles = await analyzer.getLocalChangedFiles(localPath);

          // Persist custom instructions for local mode
          if (requestInstructions) {
            await reviewRepo.updateReview(reviewId, { customInstructions: requestInstructions });
          }

          const progressCallback = createProgressCallback(analysisId);
          const tier = args.tier;

          logger.log('MCP', `Starting local analysis: review #${reviewId}, runId=${runId}`, 'magenta');

          // Create DB analysis_runs record just before launching so it's queryable for polling
          // (placed here to avoid orphaned 'running' records if earlier operations fail)
          const analysisRunRepo = new AnalysisRunRepository(db);
          await analysisRunRepo.create({
            id: runId,
            reviewId,
            provider,
            model,
            repoInstructions,
            requestInstructions,
            headSha: localHeadSha
          });

          // Launch analysis asynchronously (skipRunCreation since we created the record above)
          analyzer.analyzeLevel1(reviewId, localPath, localMetadata, progressCallback, { repoInstructions, requestInstructions }, changedFiles, { analysisId, runId, skipRunCreation: true, tier, skipLevel3: args.skipLevel3 })
            .then(result => handleAnalysisCompletion(analysisId, runId, result, async (r) => {
              if (r.summary) {
                try { await reviewRepo.updateSummary(reviewId, r.summary); } catch (_) { /* ignore */ }
              }
            }))
            .catch(error => handleAnalysisFailure(analysisId, error, `local review #${reviewId}`))
            .finally(() => {
              localReviewToAnalysisId.delete(reviewKey);
            });

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                analysisId,
                runId,
                reviewId,
                status: 'started',
                message: 'AI analysis started in background'
              }, null, 2)
            }]
          };

        } else if (args.repo && args.prNumber) {
          // --- PR MODE ---
          const repoParts = args.repo.split('/');
          if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'repo must be in "owner/repo" format' }) }] };
          }
          const [owner, repo] = repoParts;
          const prNumber = args.prNumber;
          const repository = normalizeRepository(owner, repo);

          // Concurrent analysis guard: check if one is already running
          // Use normalized repository to ensure case-insensitive matching
          const prKey = `${repository}/${prNumber}`;
          const existingAnalysisId = prToAnalysisId.get(prKey);
          if (existingAnalysisId && activeAnalyses.get(existingAnalysisId)?.status === 'running') {
            // Look up the review to return its ID
            const existingReview = await reviewRepo.getReviewByPR(prNumber, repository);
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  analysisId: existingAnalysisId,
                  reviewId: existingReview?.id || null,
                  status: 'already_running',
                  message: 'An analysis is already running for this PR'
                }, null, 2)
              }]
            };
          }

          // Check for PR metadata
          const prMetadataRepo = new PRMetadataRepository(db);
          const prMetadata = await prMetadataRepo.getByPR(prNumber, repository);
          if (!prMetadata) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `Pull request #${prNumber} not found. Please load the PR in pair-review first.` }) }] };
          }

          // Check worktree exists
          const worktreeManager = new GitWorktreeManager(db);
          if (!await worktreeManager.worktreeExists({ owner, repo, number: prNumber })) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'Worktree not found for this PR. Please reload the PR in pair-review.' }) }] };
          }
          const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

          // Get or create review record
          const review = await reviewRepo.getOrCreate({ prNumber, repository });

          // Resolve provider and model
          const repoSettings = await repoSettingsRepo.getRepoSettings(repository);
          const provider = process.env.PAIR_REVIEW_PROVIDER || repoSettings?.default_provider || config.default_provider || config.provider || 'claude';
          const model = process.env.PAIR_REVIEW_MODEL || repoSettings?.default_model || config.default_model || config.model || 'opus';

          // Create unified run/analysis ID and DB record immediately
          const runId = uuidv4();
          analysisId = runId;
          trackingKey = prKey;
          trackingMap = prToAnalysisId;

          // Save custom instructions if provided
          const requestInstructions = args.customInstructions?.trim() || null;
          if (requestInstructions) {
            await reviewRepo.upsertCustomInstructions(prNumber, repository, requestInstructions);
          }

          const repoInstructions = repoSettings?.default_instructions || null;

          const initialStatus = {
            id: analysisId,
            prNumber,
            repository,
            reviewType: 'pr',
            status: 'running',
            startedAt: new Date().toISOString(),
            progress: 'Starting analysis...',
            levels: {
              1: { status: 'running', progress: 'Starting...' },
              2: { status: 'running', progress: 'Starting...' },
              3: args.skipLevel3 ? { status: 'skipped', progress: 'Skipped' } : { status: 'running', progress: 'Starting...' },
              4: { status: 'pending', progress: 'Pending' }
            },
            filesAnalyzed: 0,
            filesRemaining: 0
          };
          activeAnalyses.set(analysisId, initialStatus);

          prToAnalysisId.set(prKey, analysisId);

          broadcastProgress(analysisId, initialStatus);

          const analyzer = new Analyzer(db, model, provider);
          const progressCallback = createProgressCallback(analysisId);
          const tier = args.tier;

          logger.log('MCP', `Starting PR analysis: PR #${prNumber} in ${repository}, runId=${runId}`, 'magenta');

          // Create DB analysis_runs record just before launching so it's queryable for polling
          // (placed here to avoid orphaned 'running' records if earlier operations fail)
          const analysisRunRepo = new AnalysisRunRepository(db);
          await analysisRunRepo.create({
            id: runId,
            reviewId: review.id,
            provider,
            model,
            repoInstructions,
            requestInstructions,
            headSha: prMetadata.head_sha || null
          });

          // Launch analysis asynchronously (skipRunCreation since we created the record above)
          analyzer.analyzeLevel1(review.id, worktreePath, prMetadata, progressCallback, { repoInstructions, requestInstructions }, null, { analysisId, runId, skipRunCreation: true, tier, skipLevel3: args.skipLevel3 })
            .then(result => handleAnalysisCompletion(analysisId, runId, result, async (r) => {
              try { await prMetadataRepo.updateLastAiRunId(prMetadata.id, r.runId); } catch (_) { /* ignore */ }
              if (r.summary) {
                try { await reviewRepo.upsertSummary(prNumber, repository, r.summary); } catch (_) { /* ignore */ }
              }
            }))
            .catch(error => handleAnalysisFailure(analysisId, error, `PR #${prNumber}`))
            .finally(() => {
              prToAnalysisId.delete(prKey);
            });

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                analysisId,
                runId,
                reviewId: review.id,
                status: 'started',
                message: 'AI analysis started in background'
              }, null, 2)
            }]
          };

        } else {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'You must provide either (path + headSha) for local reviews or (repo + prNumber) for PR reviews'
              })
            }]
          };
        }
      } catch (error) {
        // Clean up stale tracking state if we set it before the error
        if (analysisId) {
          activeAnalyses.delete(analysisId);
          // Mark any pre-created DB record as failed to avoid orphaned 'running' records
          try {
            logger.warn(`Marking pre-created analysis_runs record as failed: analysisId=${analysisId}, runId=${analysisId}`);
            const analysisRunRepo = new AnalysisRunRepository(db);
            await analysisRunRepo.update(analysisId, { status: 'failed' });
          } catch (_) { /* record may not exist yet */ }
        }
        if (trackingKey && trackingMap) {
          trackingMap.delete(trackingKey);
        }

        logger.error(`MCP start_analysis error: ${error.message}`);
        return {
          isError: true,
          content: [{
            type: 'text',
            text: JSON.stringify({ error: `Failed to start analysis: ${error.message}` })
          }]
        };
      }
    }
  );

  return server;
}

// Stateless mode: both McpServer and transport are created per request.
// McpServer.connect() permanently binds the server to one transport,
// and there is no public disconnect API, so reuse is not possible.
// req.body is passed as pre-parsed body since Express json middleware already consumed the stream.
router.post('/mcp', async (req, res) => {
  try {
    const db = req.app.get('db');
    const config = req.app.get('config') || {};
    const server = createMCPServer(db, { config });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error('MCP request error:', error);
    if (!res.headersSent) {
      const requestId = (req.body && req.body.id !== undefined) ? req.body.id : null;
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: requestId });
    }
  }
});

// GET /mcp — not supported in stateless mode
router.get('/mcp', (req, res) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Server-sent events not supported in stateless mode' }, id: null });
});

// DELETE /mcp — not supported in stateless mode
router.delete('/mcp', (req, res) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Session termination not supported in stateless mode' }, id: null });
});

module.exports = router;
module.exports.createMCPServer = createMCPServer;
module.exports.resolveReview = resolveReview;
