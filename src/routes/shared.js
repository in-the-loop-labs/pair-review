/**
 * Shared utilities for route handlers
 *
 * This module contains state and utility functions shared across
 * multiple route modules.
 */

const logger = require('../utils/logger');

/**
 * Custom error class for analysis cancellation
 * Used to distinguish user-initiated cancellation from actual errors
 */
class CancellationError extends Error {
  constructor(message = 'Analysis cancelled by user') {
    super(message);
    this.name = 'CancellationError';
    this.isCancellation = true;
  }
}

// Store active analysis runs in memory for status tracking
const activeAnalyses = new Map();

// Store mapping of PR (owner/repo/number) to analysis ID for tracking
const prToAnalysisId = new Map();

// Store SSE clients for real-time progress updates
const progressClients = new Map();

// Store local review diff data keyed by reviewId
// Using a Map avoids process.env size limits and security concerns
const localReviewDiffs = new Map();

// Store active child processes for each analysis (for cancellation support)
// Maps analysisId -> Set of ChildProcess objects
const activeProcesses = new Map();

/**
 * Generate a consistent PR key for mapping
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} prNumber - Pull request number
 * @returns {string} PR key in format "owner/repo/number"
 */
function getPRKey(owner, repo, prNumber) {
  return `${owner}/${repo}/${prNumber}`;
}

/**
 * Get the model to use for AI analysis
 * Priority: CLI flag (PAIR_REVIEW_MODEL env var) > config.model > 'sonnet' default
 * @param {Object} req - Express request object
 * @returns {string} Model name to use
 */
function getModel(req) {
  // CLI flag takes priority (passed via environment variable)
  if (process.env.PAIR_REVIEW_MODEL) {
    return process.env.PAIR_REVIEW_MODEL;
  }

  // Config file setting
  const config = req.app.get('config');
  if (config && config.model) {
    return config.model;
  }

  // Default fallback
  return 'sonnet';
}

/**
 * Determine completion level and suggestion counts from analysis result
 * @param {Object} result - Analysis result object
 * @returns {Object} Completion information with level, counts, and progress message
 */
function determineCompletionInfo(result) {
  // Determine completed levels
  const completedLevel = result.level2Result?.level3Result ? 3 : (result.level2Result ? 2 : 1);

  // Check for orchestrated suggestions first, then fall back to individual levels
  let totalSuggestions = 0;
  let progressMessage = '';

  if (result.level2Result?.orchestratedSuggestions?.length > 0) {
    // We have orchestrated suggestions - use those as the final count
    totalSuggestions = result.level2Result.orchestratedSuggestions.length;
    progressMessage = `Analysis complete: ${totalSuggestions} orchestrated suggestions stored`;
    logger.success(`Orchestration successful: ${totalSuggestions} curated suggestions from all levels`);
  } else {
    // Fall back to individual level counts
    const level1Count = result.suggestions.length;
    const level2Count = result.level2Result?.suggestions?.length || 0;
    const level3Count = result.level2Result?.level3Result?.suggestions?.length || 0;
    totalSuggestions = level1Count + level2Count + level3Count;

    const levelDetails = [];
    if (level1Count > 0) levelDetails.push(`[Level 1] ${level1Count}`);
    if (level2Count > 0) levelDetails.push(`[Level 2] ${level2Count}`);
    if (level3Count > 0) levelDetails.push(`[Level 3] ${level3Count}`);

    progressMessage = `Analysis complete: ${totalSuggestions} suggestions found (${levelDetails.join(', ')})`;
  }

  return {
    completedLevel,
    totalSuggestions,
    progressMessage
  };
}

/**
 * Broadcast progress update to all connected SSE clients
 * @param {string} analysisId - Analysis ID
 * @param {Object} progressData - Progress data to broadcast
 */
function broadcastProgress(analysisId, progressData) {
  const clients = progressClients.get(analysisId);
  if (clients && clients.size > 0) {
    const message = `data: ${JSON.stringify({
      type: 'progress',
      ...progressData
    })}\n\n`;

    // Send to all connected clients
    clients.forEach(client => {
      try {
        client.write(message);
      } catch (error) {
        // Remove dead clients
        clients.delete(client);
      }
    });

    // Clean up if no clients left
    if (clients.size === 0) {
      progressClients.delete(analysisId);
    }
  }
}

/**
 * Register a child process for an analysis (for cancellation tracking)
 * @param {string} analysisId - Analysis ID
 * @param {ChildProcess} childProcess - The spawned child process
 */
function registerProcess(analysisId, childProcess) {
  if (!activeProcesses.has(analysisId)) {
    activeProcesses.set(analysisId, new Set());
  }
  activeProcesses.get(analysisId).add(childProcess);

  // Auto-remove when process exits
  childProcess.on('close', () => {
    const processes = activeProcesses.get(analysisId);
    if (processes) {
      processes.delete(childProcess);
      if (processes.size === 0) {
        activeProcesses.delete(analysisId);
      }
    }
  });
}

/**
 * Kill all processes for an analysis
 * @param {string} analysisId - Analysis ID
 * @returns {number} Number of processes killed
 */
function killProcesses(analysisId) {
  const processes = activeProcesses.get(analysisId);
  if (!processes || processes.size === 0) {
    return 0;
  }

  let killed = 0;
  for (const proc of processes) {
    try {
      // Send SIGTERM to gracefully terminate the process
      proc.kill('SIGTERM');
      killed++;
    } catch (err) {
      // Process may have already exited
      logger.warn(`Failed to kill process: ${err.message}`);
    }
  }

  // Clear the set
  activeProcesses.delete(analysisId);
  return killed;
}

/**
 * Check if an analysis has been cancelled
 * @param {string} analysisId - Analysis ID
 * @returns {boolean} True if cancelled
 */
function isAnalysisCancelled(analysisId) {
  const analysis = activeAnalyses.get(analysisId);
  return analysis?.status === 'cancelled';
}

module.exports = {
  CancellationError,
  activeAnalyses,
  prToAnalysisId,
  progressClients,
  localReviewDiffs,
  activeProcesses,
  getPRKey,
  getModel,
  determineCompletionInfo,
  broadcastProgress,
  registerProcess,
  killProcesses,
  isAnalysisCancelled
};
