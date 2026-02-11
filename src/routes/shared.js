// SPDX-License-Identifier: GPL-3.0-or-later
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

// Store mapping of local review key to analysis ID for tracking
const localReviewToAnalysisId = new Map();

// Store active review setup operations (concurrency guard)
// Maps setupKey (e.g., "pr:owner/repo/123" or "local:/path") -> { setupId, promise }
const activeSetups = new Map();

// Store SSE clients for setup progress updates
// Maps setupId -> Set of response objects
const setupProgressClients = new Map();

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
 * Generate a consistent key for local review mapping
 * @param {number} reviewId - Local review ID
 * @returns {string} Review key
 */
function getLocalReviewKey(reviewId) {
  return `local/${reviewId}`;
}

/**
 * Get the model to use for AI analysis
 * Priority: CLI flag (PAIR_REVIEW_MODEL env var) > config.default_model > 'opus' default
 * @param {Object} req - Express request object
 * @returns {string} Model name to use
 */
function getModel(req) {
  // CLI flag takes priority (passed via environment variable)
  if (process.env.PAIR_REVIEW_MODEL) {
    return process.env.PAIR_REVIEW_MODEL;
  }

  // Config file setting (default_model preferred, model for backwards compatibility)
  const config = req.app.get('config');
  if (config) {
    if (config.default_model) {
      return config.default_model;
    }
    // Backwards compatibility with old config key
    if (config.model) {
      return config.model;
    }
  }

  // Default fallback
  return 'opus';
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
    logger.success(`Consolidation successful: ${totalSuggestions} curated suggestions from all levels`);
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

/**
 * Broadcast setup progress to all connected SSE clients for a given setupId
 * @param {string} setupId - Setup operation ID
 * @param {Object} data - Progress data to broadcast
 */
function broadcastSetupProgress(setupId, data) {
  const clients = setupProgressClients.get(setupId);
  if (clients && clients.size > 0) {
    const message = `data: ${JSON.stringify(data)}\n\n`;

    clients.forEach(client => {
      try {
        client.write(message);
      } catch (error) {
        clients.delete(client);
      }
    });

    if (clients.size === 0) {
      setupProgressClients.delete(setupId);
    }
  }
}

/**
 * Create a progress callback for analysis that handles both regular status
 * updates and throttled stream events with smart filtering.
 *
 * Encapsulates the per-level throttle map (300ms), assistant_text preference
 * (tool_use shown only after 2s gap), and stale-streamEvent clearing logic.
 *
 * @param {string} analysisId - Analysis ID for looking up status in activeAnalyses
 * @returns {Function} progressCallback(progressUpdate)
 */
function createProgressCallback(analysisId) {
  const streamThrottleMap = new Map();
  const STREAM_THROTTLE_MS = 300;
  const lastAssistantTextMap = new Map();
  const TOOL_USE_FALLBACK_MS = 2000;

  return (progressUpdate) => {
    const currentStatus = activeAnalyses.get(analysisId);
    if (!currentStatus) return;

    const level = progressUpdate.level;
    // Map consolidation-L* and orchestration to level 4 (consolidation phase)
    const consolidationMatch = typeof level === 'string' && level.match(/^consolidation-L(\d+)$/);
    const levelKey = level === 'orchestration' ? 4
      : consolidationMatch ? 4
      : level;

    // Stream event: store latest and throttle broadcasts
    if (progressUpdate.streamEvent && levelKey) {
      if (!currentStatus.levels[levelKey]) return;

      const now = Date.now();
      const evt = progressUpdate.streamEvent;

      // Smart filtering: prefer assistant_text, show tool_use only after 2s gap
      if (evt.type === 'assistant_text') {
        lastAssistantTextMap.set(levelKey, now);
      } else if (evt.type === 'tool_use') {
        const lastAssistant = lastAssistantTextMap.get(levelKey) || 0;
        if (now - lastAssistant < TOOL_USE_FALLBACK_MS) {
          return;
        }
      }

      currentStatus.levels[levelKey].streamEvent = evt;
      // Propagate voiceId so council progress modal can identify active voice
      if (progressUpdate.voiceId) {
        currentStatus.levels[levelKey].voiceId = progressUpdate.voiceId;
      }
      // Propagate consolidation step so frontend can identify active consolidation child
      if (consolidationMatch) {
        currentStatus.levels[levelKey].consolidationStep = `L${consolidationMatch[1]}`;
      } else if (level === 'orchestration') {
        currentStatus.levels[levelKey].consolidationStep = 'orchestration';
      }
      activeAnalyses.set(analysisId, currentStatus);

      // Throttle: only broadcast if enough time has elapsed
      const lastBroadcast = streamThrottleMap.get(levelKey) || 0;
      if (now - lastBroadcast >= STREAM_THROTTLE_MS) {
        streamThrottleMap.set(levelKey, now);
        broadcastProgress(analysisId, currentStatus);
      }
      return;
    }

    // Regular status update (not a stream event)
    // Update the specific level's status, clearing any stale streamEvent
    if (level && level >= 1 && level <= 3) {
      if (progressUpdate.voiceId) {
        // Per-voice update (council mode): track in voices map so concurrent
        // completions on the same level don't clobber each other
        if (!currentStatus.levels[level].voices) {
          currentStatus.levels[level].voices = {};
        }
        currentStatus.levels[level].voices[progressUpdate.voiceId] = {
          status: progressUpdate.status || 'running',
          progress: progressUpdate.progress || 'In progress...'
        };
        // Also set the top-level voiceId for backward compat with frontend routing
        currentStatus.levels[level].voiceId = progressUpdate.voiceId;
        currentStatus.levels[level].status = progressUpdate.status || 'running';
        currentStatus.levels[level].progress = progressUpdate.progress || 'In progress...';
        currentStatus.levels[level].streamEvent = undefined;
      } else {
        // Non-voice update (single-model mode)
        currentStatus.levels[level] = {
          status: progressUpdate.status || 'running',
          progress: progressUpdate.progress || 'In progress...',
          streamEvent: undefined,
          voiceId: undefined
        };
      }
    }

    // Handle orchestration and consolidation as level 4
    if (level === 'orchestration' || consolidationMatch) {
      const step = consolidationMatch ? `L${consolidationMatch[1]}` : 'orchestration';
      // Preserve existing consolidation steps when updating level 4
      const existing = currentStatus.levels[4] || {};
      const steps = { ...(existing.steps || {}) };
      steps[step] = {
        status: progressUpdate.status || 'running',
        progress: progressUpdate.progress || (consolidationMatch ? 'Consolidating...' : 'Finalizing results...')
      };
      // Derive the top-level consolidation status from the aggregate of step statuses
      // so that a single step completing doesn't mark the whole phase as completed
      const stepStatuses = Object.values(steps).map(s => s.status);
      const derivedStatus = stepStatuses.every(s => s === 'completed') ? 'completed'
        : stepStatuses.some(s => s === 'failed') ? 'failed'
        : stepStatuses.some(s => s === 'running') ? 'running'
        : progressUpdate.status || 'running';
      currentStatus.levels[4] = {
        status: derivedStatus,
        progress: progressUpdate.progress || (consolidationMatch ? 'Consolidating...' : 'Finalizing results...'),
        streamEvent: undefined,
        consolidationStep: step,
        steps
      };
    }

    // Update overall progress message if provided
    if (progressUpdate.progress && !level) {
      currentStatus.progress = progressUpdate.progress;
    }

    activeAnalyses.set(analysisId, currentStatus);
    broadcastProgress(analysisId, currentStatus);
  };
}

/**
 * Parse enabledLevels from a request body into a normalized { 1: bool, 2: bool, 3: bool } object.
 *
 * Accepts three formats:
 *   - Array: e.g. [1, 3]  -> { 1: true, 2: false, 3: true }
 *   - Object: e.g. { 1: true, 2: false, 3: true } -> filtered to known keys only
 *   - Null/undefined: falls back to skipLevel3 flag -> { 1: true, 2: true, 3: !skipLevel3 }
 *
 * @param {Array|Object|null} requestEnabledLevels - Raw enabledLevels from request body
 * @param {boolean} [skipLevel3=false] - Fallback flag when enabledLevels is not provided
 * @returns {Object} Normalized levels config { 1: boolean, 2: boolean, 3: boolean }
 */
function parseEnabledLevels(requestEnabledLevels, skipLevel3 = false) {
  const levelsConfig = {};
  if (Array.isArray(requestEnabledLevels)) {
    for (const key of [1, 2, 3]) {
      levelsConfig[key] = requestEnabledLevels.includes(key);
    }
  } else if (requestEnabledLevels && typeof requestEnabledLevels === 'object') {
    for (const key of [1, 2, 3]) {
      levelsConfig[key] = !!requestEnabledLevels[key];
    }
  } else {
    levelsConfig[1] = true;
    levelsConfig[2] = true;
    levelsConfig[3] = !skipLevel3;
  }
  return levelsConfig;
}

module.exports = {
  CancellationError,
  activeAnalyses,
  prToAnalysisId,
  localReviewToAnalysisId,
  progressClients,
  localReviewDiffs,
  activeProcesses,
  activeSetups,
  setupProgressClients,
  getPRKey,
  getLocalReviewKey,
  getModel,
  determineCompletionInfo,
  broadcastProgress,
  broadcastSetupProgress,
  registerProcess,
  killProcesses,
  isAnalysisCancelled,
  createProgressCallback,
  parseEnabledLevels
};
