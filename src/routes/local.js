// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Local Review Routes
 *
 * Handles all local review-related endpoints:
 * - Get local review metadata
 * - Get local diff
 * - Trigger AI analysis (Level 1, 2, 3)
 * - Get AI suggestions
 * - User comment CRUD operations
 *
 * Note: No submit-review endpoint - GitHub submission is disabled in local mode.
 */

const express = require('express');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { query, queryOne, run, ReviewRepository, RepoSettingsRepository, AnalysisRunRepository, CouncilRepository } = require('../database');
const Analyzer = require('../ai/analyzer');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { broadcastReviewEvent } = require('../events/review-events');
const { fireHooks, hasHooks } = require('../hooks/hook-runner');
const { buildReviewStartedPayload, buildReviewLoadedPayload, buildAnalysisStartedPayload, buildAnalysisCompletedPayload, getCachedUser } = require('../hooks/payloads');
const { mergeInstructions } = require('../utils/instructions');
const { getGitHubToken, resolveLoadSkills, buildCouncilProviderOverrides, getSummaryEnabled, getTourEnabled } = require('../config');
const { backgroundQueue } = require('../ai/background-queue');
const localReview = require('../local-review');
const { generateScopedDiff, computeScopedDigest, getBranchCommitCount, getFirstCommitSubject, detectAndBuildBranchInfo, findMergeBase, getCurrentBranch, getRepositoryName } = localReview;
const { STOPS, isValidScope, normalizeScope, reviewScope, includesBranch, DEFAULT_SCOPE, EMPTY_SCOPE_MESSAGE } = require('../local-scope');
const { getGeneratedFilePatterns } = require('../git/gitattributes');
const { getShaAbbrevLength } = require('../git/sha-abbrev');
const { validateCouncilConfig, normalizeCouncilConfig } = require('./councils');
const { resolveReviewConfig } = require('../review-config');
const { TIERS, TIER_ALIASES, VALID_TIERS, resolveTier } = require('../ai/prompts/config');
const { getProviderClass, createProvider } = require('../ai/provider');
const { getDefaultBranch, tryGraphiteState } = require('../git/base-branch');
const { CommentRepository } = require('../database');
const { runExecutableAnalysis, getChangedFiles } = require('./executable-analysis');
const { rejectUrlLikeLocalReviewPath } = require('../utils/local-path-input');
const reviewsRouter = require('./reviews');
const summaryGenerator = require('../ai/summary-generator');
const tourGenerator = require('../ai/tour-generator');
const { parseUnifiedDiffPatches } = require('../utils/diff-file-list');
const { parseHunks } = require('../utils/diff-hunks');
const { hashHunk } = require('../ai/hunk-hashing');
const {
  activeAnalyses,
  localReviewDiffs,
  reviewToAnalysisId,
  resolveProviderModel,
  determineCompletionInfo,
  broadcastProgress,
  CancellationError,
  createProgressCallback,
  parseEnabledLevels,
  registerProcess: registerProcessForCancellation
} = require('./shared');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers – type-safe wrappers around localReviewDiffs Map
// JavaScript Maps use strict equality for keys.  reviewId values arrive from
// req.params as strings, but every other code path stores them as integers.
// These helpers coerce once so callers never hit a string/int mismatch.
// ---------------------------------------------------------------------------
function toIntKey(reviewId) {
  const key = typeof reviewId === 'number' ? reviewId : parseInt(reviewId, 10);
  if (isNaN(key)) throw new Error(`Invalid reviewId for diff cache: ${reviewId}`);
  return key;
}
function getLocalReviewDiff(reviewId) {
  return localReviewDiffs.get(toIntKey(reviewId));
}
function setLocalReviewDiff(reviewId, value) {
  localReviewDiffs.set(toIntKey(reviewId), value);
}
function deleteLocalReviewDiff(reviewId) {
  localReviewDiffs.delete(toIntKey(reviewId));
}

/**
 * Guard: reject the request if the review's scope resolves to zero changed files.
 * Returns true if the guard fired (response already sent), false otherwise.
 */
async function rejectIfEmptyScope(res, review, localPath) {
  const { start: scopeStart, end: scopeEnd } = reviewScope(review);
  const scopeContext = {
    scopeStart,
    scopeEnd,
    baseBranch: review.local_base_branch || null,
  };
  const changedFiles = await getChangedFiles(localPath, scopeContext);
  if (changedFiles.length === 0) {
    res.status(409).json({ error: EMPTY_SCOPE_MESSAGE });
    return true;
  }
  return false;
}

/**
 * Check whether branch scope should be selectable in the scope range selector.
 * Returns true when the current branch is a non-default, non-detached branch,
 * or when the scope already includes branch.
 *
 * @param {string} branchName - Current branch name
 * @param {string} scopeStart - Current scope start stop
 * @param {string} localPath - Absolute path to the repository (used to detect the actual default branch)
 */
function isBranchAvailable(branchName, scopeStart, localPath) {
  if (includesBranch(scopeStart)) return true;
  if (!branchName || branchName === 'HEAD' || branchName === 'unknown') return false;

  // Detect the default branch using only local refs (no network).
  const defaultBranch = getDefaultBranch(localPath);
  if (defaultBranch) {
    return branchName !== defaultBranch;
  }
  return branchName !== 'main' && branchName !== 'master';
}

/**
 * Delete a local review session and its in-memory diff cache.
 * Shared by both single-delete and bulk-delete routes.
 *
 * @param {ReviewRepository} reviewRepo - Repository instance
 * @param {number} id - Review ID
 * @returns {boolean} true if deleted, false if not found
 */
async function deleteLocalReviewFull(reviewRepo, id) {
  const deleted = await reviewRepo.deleteLocalSession(id);
  if (deleted) {
    deleteLocalReviewDiff(id);
  }
  return deleted;
}

/**
 * Open native OS directory picker dialog and return the selected path.
 * Uses osascript on macOS, zenity/kdialog on Linux, PowerShell on Windows.
 * Must be registered BEFORE /:reviewId param routes.
 */
router.post('/api/local/browse', async (req, res) => {
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    let selectedPath = null;
    const platform = process.platform;

    if (platform === 'darwin') {
      // macOS: use osascript to open native folder picker
      const { stdout } = await execFileAsync('osascript', [
        '-e', 'set selectedFolder to POSIX path of (choose folder with prompt "Select a directory to review")',
      ], { timeout: 120000 });
      selectedPath = stdout.trim();
      // osascript appends trailing slash; remove it for consistency
      if (selectedPath.endsWith('/') && selectedPath.length > 1) {
        selectedPath = selectedPath.slice(0, -1);
      }
    } else if (platform === 'win32') {
      // Windows: use PowerShell folder browser dialog
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = "Select a directory to review"
        $dialog.ShowNewFolderButton = $false
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
          Write-Output $dialog.SelectedPath
        }
      `;
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', psScript], { timeout: 120000 });
      selectedPath = stdout.trim();
    } else {
      // Linux: try zenity first, then kdialog
      try {
        const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory', '--title=Select a directory to review'], { timeout: 120000 });
        selectedPath = stdout.trim();
      } catch (zenityError) {
        if (zenityError.code === 1) {
          // Exit code 1 means user cancelled the dialog
          return res.json({ success: true, path: null, cancelled: true });
        }
        // Only fall through to kdialog if zenity is not installed (code 127 or ENOENT)
        if (zenityError.code !== 127 && zenityError.code !== 'ENOENT') {
          return res.status(500).json({
            error: 'Directory picker failed: ' + (zenityError.message || 'Unknown error')
          });
        }
        try {
          const { stdout } = await execFileAsync('kdialog', ['--getexistingdirectory', '.', '--title', 'Select a directory to review'], { timeout: 120000 });
          selectedPath = stdout.trim();
        } catch (kdialogError) {
          if (kdialogError.code === 1) {
            return res.json({ success: true, path: null, cancelled: true });
          }
          return res.status(501).json({
            error: 'No supported file dialog found. Install zenity or kdialog, or enter the path manually.'
          });
        }
      }
    }

    if (!selectedPath) {
      // User cancelled the dialog
      return res.json({ success: true, path: null, cancelled: true });
    }

    res.json({ success: true, path: selectedPath, cancelled: false });

  } catch (error) {
    // User cancellation on macOS throws error code -128
    if (error.code === 1 || (error.message && error.message.includes('-128'))) {
      return res.json({ success: true, path: null, cancelled: true });
    }
    // Handle timeout (process killed)
    if (error.killed) {
      return res.status(504).json({
        error: 'Directory picker timed out'
      });
    }
    logger.error(`Error opening directory picker: ${error.message}`);
    res.status(500).json({
      error: 'Failed to open directory picker'
    });
  }
});

/**
 * List local review sessions with pagination
 * Must be registered BEFORE /:reviewId param routes
 */
router.get('/api/local/sessions', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
    const before = req.query.before || undefined;

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const { sessions, hasMore } = await reviewRepo.listLocalSessions({ limit, before });

    // Compute SHA abbreviation length per unique repo path
    const abbrevCache = new Map();
    const enrichedSessions = sessions.map(session => {
      if (!session.local_path) return session;
      if (!abbrevCache.has(session.local_path)) {
        abbrevCache.set(session.local_path, getShaAbbrevLength(session.local_path));
      }
      return { ...session, sha_abbrev_length: abbrevCache.get(session.local_path) };
    });

    res.json({
      success: true,
      sessions: enrichedSessions,
      hasMore
    });

  } catch (error) {
    logger.error(`Error listing local sessions: ${error.message}`);
    res.status(500).json({
      error: 'Failed to list local sessions'
    });
  }
});

/**
 * Bulk delete local review sessions.
 * Accepts { ids: number[] } in request body. Max 50 IDs per request.
 * Must be registered BEFORE /:reviewId param routes.
 * Only deletes DB records — does NOT remove files on disk.
 */
router.post('/api/local/sessions/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Request body must contain a non-empty "ids" array'
      });
    }

    if (ids.length > 50) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 50 IDs per request'
      });
    }

    const parsedIds = ids.map(id => parseInt(id, 10));
    if (parsedIds.some(id => isNaN(id) || id <= 0)) {
      return res.status(400).json({
        success: false,
        error: 'All IDs must be positive integers'
      });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    let deleted = 0;
    const errors = [];

    for (const id of parsedIds) {
      try {
        const result = await deleteLocalReviewFull(reviewRepo, id);
        if (result) {
          deleted++;
        } else {
          errors.push({ id, error: `Local review #${id} not found` });
        }
      } catch (err) {
        errors.push({ id, error: err.message });
      }
    }

    if (deleted > 0) logger.success(`Bulk deleted ${deleted} local review session(s)`);

    res.json({
      success: deleted > 0 || errors.length === 0,
      deleted,
      failed: errors.length,
      errors
    });

  } catch (error) {
    logger.error(`Error in bulk delete local sessions: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Failed to process bulk delete'
    });
  }
});

/**
 * Delete a local review session
 * Must be registered BEFORE /:reviewId param routes
 * Only deletes DB records — does NOT remove files on disk.
 */
router.delete('/api/local/sessions/:reviewId', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const deleted = await deleteLocalReviewFull(reviewRepo, reviewId);

    if (!deleted) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    logger.success(`Deleted local review session #${reviewId}`);

    res.json({
      success: true,
      reviewId
    });

  } catch (error) {
    logger.error(`Error deleting local session: ${error.message}`);
    res.status(500).json({
      error: 'Failed to delete local session'
    });
  }
});

/**
 * Start a new local review from the web UI
 * Must be registered BEFORE /:reviewId param routes
 */
router.post('/api/local/start', async (req, res) => {
  try {
    const { path: inputPath } = req.body || {};

    if (!inputPath || typeof inputPath !== 'string' || !inputPath.trim()) {
      return res.status(400).json({
        error: 'Missing required field: path'
      });
    }

    try {
      rejectUrlLikeLocalReviewPath(inputPath);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // Required inline (not reusing top-level import) so that vi.spyOn()
    // replacements on the module exports are visible at call time in integration tests.
    const { findGitRoot, getHeadSha, getRepositoryName, getCurrentBranch } = require('../local-review');

    // Resolve the path
    const resolvedPath = path.resolve(inputPath.trim());

    // Validate path exists
    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isDirectory()) {
        return res.status(400).json({
          error: 'Path is not a directory'
        });
      }
    } catch (err) {
      return res.status(400).json({
        error: 'Path does not exist'
      });
    }

    // Find git root
    let repoPath;
    try {
      repoPath = await findGitRoot(resolvedPath);
    } catch (err) {
      return res.status(400).json({
        error: 'Not a git repository'
      });
    }

    // Gather git info
    const headSha = await getHeadSha(repoPath);
    const repository = await getRepositoryName(repoPath);
    const branch = await getCurrentBranch(repoPath);

    // Create or resume session
    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);

    let sessionId;
    // Try exact match (path + sha + branch)
    let existing = await reviewRepo.getLocalReview(repoPath, headSha, branch);

    // Adopt legacy sessions that predate branch tracking
    if (!existing) {
      const legacy = await reviewRepo.getLocalReviewByPathAndSha(repoPath, headSha);
      if (legacy && legacy.local_head_branch === null) {
        existing = legacy;
      }
    }

    // Check for branch-scope session (persists across HEAD changes)
    if (!existing) {
      const branchSession = await reviewRepo.getLocalBranchScopeReview(repoPath, branch);
      if (branchSession) existing = branchSession;
    }

    if (existing) {
      sessionId = existing.id;
      if (existing.local_head_sha !== headSha) {
        await reviewRepo.updateLocalHeadSha(sessionId, headSha);
      }
      if (existing.local_head_branch === null) {
        await reviewRepo.updateReview(sessionId, { local_head_branch: branch });
      }
    } else {
      sessionId = await reviewRepo.upsertLocalReview({
        localPath: repoPath,
        localHeadSha: headSha,
        repository,
        scopeStart: DEFAULT_SCOPE.start,
        scopeEnd: DEFAULT_SCOPE.end,
        localHeadBranch: branch
      });
    }

    // Fire review hook (non-blocking)
    const config = req.app.get('config') || {};
    // Generate diff using default scope
    logger.log('API', `Starting local review for ${repoPath}`, 'cyan');
    const { start: scopeStart, end: scopeEnd } = existing ? reviewScope(existing) : DEFAULT_SCOPE;

    // Fire review hook (non-blocking, after scope is resolved)
    const hookEvent = existing ? 'review.loaded' : 'review.started';
    if (hasHooks(hookEvent, config)) {
      getCachedUser(config).then(user => {
        const builder = existing ? buildReviewLoadedPayload : buildReviewStartedPayload;
        const si = STOPS.indexOf(scopeStart);
        const ei = STOPS.indexOf(scopeEnd);
        const scope = STOPS.slice(si, ei + 1);
        const payload = builder({ reviewId: sessionId, mode: 'local', localContext: { path: repoPath, branch, headSha, scope }, user });
        fireHooks(hookEvent, payload, config);
      }).catch(err => { logger.warn(`Review hook failed: ${err.message}`); });
    }
    const baseBranch = existing?.local_base_branch || null;
    const { diff, stats } = await generateScopedDiff(repoPath, scopeStart, scopeEnd, baseBranch);

    // Compute digest for staleness detection
    const digest = await computeScopedDigest(repoPath, scopeStart, scopeEnd);

    // Branch detection: when no uncommitted changes, check if branch has commits ahead
    const { resolveHostBinding: _resolveHostBindingForBranch } = require('../config');
    const branchBinding = repository ? _resolveHostBindingForBranch(repository, config) : null;
    const branchInfo = await detectAndBuildBranchInfo(repoPath, branch, {
      repository,
      diff,
      githubToken: branchBinding?.token || getGitHubToken(config),
      hostBinding: branchBinding,
      enableGraphite: config.enable_graphite === true
    });

    // Persist to in-memory Map
    setLocalReviewDiff(sessionId, { diff, stats, digest, branchInfo });

    // Persist to database
    await reviewRepo.saveLocalDiff(sessionId, { diff, stats, digest });

    logger.success(`Local review session #${sessionId} started for ${repository} (branch: ${branch})`);

    res.json({
      success: true,
      reviewUrl: `/local/${sessionId}`,
      sessionId,
      repository,
      branch,
      branchInfo,
      stats: {
        trackedChanges: stats.trackedChanges || 0,
        untrackedFiles: stats.untrackedFiles || 0,
        stagedChanges: stats.stagedChanges || 0,
        unstagedChanges: stats.unstagedChanges || 0
      }
    });

    (async () => {
      await summaryGenerator.kickOffSummaryJob({
        db,
        config,
        reviewId: sessionId,
        diffText: diff,
        worktreePath: repoPath,
        reviewContext: { prTitle: branch },
        trigger: 'auto'
      });
    })().catch((err) => logger.warn(`Hunk summary job failed for review ${sessionId}: ${err.message}`));

    (async () => {
      await tourGenerator.kickOffTourJob({
        db,
        config,
        reviewId: sessionId,
        diffText: diff,
        worktreePath: repoPath,
        reviewContext: { prTitle: branch },
        trigger: 'auto'
      });
    })().catch((err) => logger.warn(`Tour job failed for review ${sessionId}: ${err.message}`));

  } catch (error) {
    logger.error(`Error starting local review: ${error.message}`);
    res.status(500).json({
      error: 'Failed to start local review'
    });
  }
});

/**
 * Get local review metadata
 */
router.get('/api/local/:reviewId', async (req, res) => {
  const tEndpoint = Date.now();
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    // If the stored repository name doesn't look like owner/repo format,
    // try to get a fresh one from git remote for display purposes only.
    // Note: GET requests are read-only - no database writes here.
    // Repository name updates happen during session creation or refresh.
    let repositoryName = review.repository;
    let branchName = 'unknown';
    if (review.local_path) {
      try {
        const { getRepositoryName, getCurrentBranch } = require('../local-review');

        // Always fetch current branch from the working directory
        branchName = await getCurrentBranch(review.local_path);

        if (repositoryName && !repositoryName.includes('/')) {
          const freshRepoName = await getRepositoryName(review.local_path);
          if (freshRepoName && freshRepoName.includes('/')) {
            repositoryName = freshRepoName;
            // Just use the fresh name for this response - don't write to DB in GET
            logger.log('API', `Using fresh repository name from git remote: ${freshRepoName}`, 'cyan');
          }
        }
      } catch (repoError) {
        // Keep the original name if we can't get a better one
        logger.warn(`Could not refresh repository/branch info: ${repoError.message}`);
      }
    }

    // Fall back to env var if local_path is not available (e.g. CLI-started sessions)
    if (branchName === 'unknown') {
      branchName = process.env.PAIR_REVIEW_BRANCH || 'unknown';
      if (branchName !== 'unknown') {
        logger.log('API', `Using PAIR_REVIEW_BRANCH env var for branch: ${branchName}`, 'cyan');
      }
    }

    // Build scope info for the response.
    // normalizeScope clamps any legacy invalid scopes (e.g. branch-only,
    // staged-only) to always include 'unstaged', since AI models read files
    // from the working tree and the diff must match what they see.
    const { start: scopeStart, end: scopeEnd } = reviewScope(review);
    const baseBranch = review.local_base_branch || null;

    // When scope does NOT include branch, check for branch detection info
    // Frontend uses this to suggest expanding scope to include branch.
    // Only use already-cached results here — never block the response on
    // GitHub API calls.  Background detection (after res.json) will populate
    // the cache for subsequent requests.
    let branchInfo = null;
    const cachedDiff = getLocalReviewDiff(reviewId);
    if (!includesBranch(scopeStart) && cachedDiff?.branchInfo) {
      branchInfo = cachedDiff.branchInfo;
    }

    // Check repo settings for auto_branch_review preference
    let autoBranchReview = 0;
    if (branchInfo && repositoryName && repositoryName.includes('/')) {
      try {
        const repoSettingsRepo = new RepoSettingsRepository(db);
        const repoSettings = await repoSettingsRepo.getRepoSettings(repositoryName);
        if (repoSettings) {
          autoBranchReview = repoSettings.auto_branch_review || 0;
        }
      } catch {
        // Non-fatal
      }
    }

    // If auto_branch_review is -1 (never), suppress branchInfo
    if (autoBranchReview === -1) {
      branchInfo = null;
    }

    // Determine if Branch stop should be selectable in the scope range selector.
    // This is independent of branchInfo (which guards on no uncommitted changes).
    // Branch is available when: not detached HEAD, not on default branch.
    const branchAvailable = Boolean(branchInfo) || isBranchAvailable(branchName, scopeStart, review.local_path);

    // Compute SHA abbreviation length from the repo's git config
    const shaAbbrevLength = getShaAbbrevLength(review.local_path);

    // Detect Graphite stack if enabled
    let stackData = null;
    const localConfig = req.app.get('config') || {};
    if (localConfig.enable_graphite === true && review.local_path && branchName && branchName !== 'unknown' && branchName !== 'HEAD') {
      try {
        const graphiteResult = tryGraphiteState(review.local_path, branchName, { execSync });
        if (graphiteResult?.stack) {
          // Enrich with PR numbers from pr_metadata DB
          const allPRs = repositoryName
            ? await query(db, 'SELECT pr_number, head_branch FROM pr_metadata WHERE repository = ? COLLATE NOCASE', [repositoryName])
            : [];
          const prMap = new Map(allPRs.filter(p => p.head_branch).map(p => [p.head_branch, p.pr_number]));
          stackData = graphiteResult.stack.map(entry => {
            const prNumber = prMap.get(entry.branch);
            return prNumber != null ? { ...entry, prNumber } : entry;
          });
        }
      } catch {
        // Non-fatal — stack detection is an enhancement
      }
    }

    const metadataElapsed = Date.now() - tEndpoint;
    if (metadataElapsed > 200) {
      logger.debug(`[perf] metadata#${reviewId} took ${metadataElapsed}ms (threshold: 200ms)`);
    }

    res.json({
      id: review.id,
      localPath: review.local_path,
      localHeadSha: review.local_head_sha,
      repository: repositoryName,
      branch: branchName,
      reviewType: 'local',
      status: review.status,
      name: review.name || null,
      localMode: review.local_mode || 'uncommitted',
      scopeStart,
      scopeEnd,
      baseBranch,
      branchInfo,
      branchAvailable,
      stackData,
      shaAbbrevLength,
      createdAt: review.created_at,
      updatedAt: review.updated_at
    });

    // Background: pre-cache base branch detection so set-scope is fast later
    if (!includesBranch(scopeStart) && !review.local_base_branch
        && branchName && branchName !== 'HEAD' && branchName !== 'unknown'
        && repositoryName && repositoryName.includes('/')) {
      const bgConfig = req.app.get('config') || {};
      const { resolveHostBinding: _resolveHostBinding } = require('../config');
      const bgBinding = _resolveHostBinding(repositoryName, bgConfig);
      const bgToken = bgBinding.token;
      const bgT0 = Date.now();
      const { detectBaseBranch } = require('../git/base-branch');
      detectBaseBranch(review.local_path, branchName, {
        repository: repositoryName,
        enableGraphite: bgConfig.enable_graphite === true,
        _deps: bgToken ? {
          getGitHubToken: () => bgToken,
          getHostBinding: () => bgBinding
        } : undefined
      }).then(detection => {
        if (detection && detection.baseBranch) {
          return reviewRepo.updateReview(reviewId, { local_base_branch: detection.baseBranch });
        }
      }).then(() => {
        logger.debug(`[perf] metadata#${reviewId} background-detectBaseBranch: ${Date.now() - bgT0}ms`);
      }).catch(err => {
        logger.warn(`Background base branch detection failed: ${err.message}`);
      });
    }

    // Fire review.loaded hook (session already exists to be fetched by ID)
    const hookConfig = req.app.get('config') || {};
    if (hasHooks('review.loaded', hookConfig)) {
      getCachedUser(hookConfig).then(user => {
        const { start: hookScopeStart, end: hookScopeEnd } = reviewScope(review);
        const si = STOPS.indexOf(hookScopeStart);
        const ei = STOPS.indexOf(hookScopeEnd);
        const scope = STOPS.slice(si, ei + 1);
        const payload = buildReviewLoadedPayload({
          reviewId: review.id, mode: 'local',
          localContext: { path: review.local_path, branch: branchName, headSha: review.local_head_sha, scope },
          user,
        });
        fireHooks('review.loaded', payload, hookConfig);
      }).catch(err => { logger.warn(`Review hook failed: ${err.message}`); });
    }

    // Background: re-trigger hunk summary + tour generation on review load.
    // Self-invoked so any rejection here cannot reach the outer try/catch
    // and call res.status(500) on an already-flushed response.
    (async () => {
      let bgDiffText = getLocalReviewDiff(reviewId)?.diff;
      if (!bgDiffText) {
        const persistedDiff = await reviewRepo.getLocalDiff(reviewId);
        bgDiffText = persistedDiff?.diff;
      }
      if (!bgDiffText) {
        logger.debug(`Skipping background AI kickoff for review ${reviewId}: no diff available`);
        return;
      }
      const reviewContext = { prTitle: review.name || branchName };
      const results = await Promise.allSettled([
        summaryGenerator.kickOffSummaryJob({
          db,
          config: localConfig,
          reviewId,
          diffText: bgDiffText,
          worktreePath: review.local_path,
          reviewContext,
          trigger: 'auto'
        }),
        tourGenerator.kickOffTourJob({
          db,
          config: localConfig,
          reviewId,
          diffText: bgDiffText,
          worktreePath: review.local_path,
          reviewContext,
          trigger: 'auto'
        })
      ]);
      const labels = ['Hunk summary', 'Tour'];
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          logger.warn(`${labels[i]} kickoff failed for review ${reviewId}: ${r.reason?.message || r.reason}`);
        }
      });
    })().catch((err) => logger.warn(`Background AI kickoff failed for review ${reviewId}: ${err.message}`));

  } catch (error) {
    logger.error('Error fetching local review:', error.stack || error.message);
    res.status(500).json({
      error: 'Failed to fetch local review'
    });
  }
});

/**
 * Update local review session name
 */
router.patch('/api/local/:reviewId/name', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    // Allow null to clear the name, otherwise trim and cap at 200 chars
    let { name } = req.body;
    if (name !== null && name !== undefined) {
      name = String(name).trim().slice(0, 200) || null;
    }

    await reviewRepo.updateReview(reviewId, { name });

    res.json({
      success: true,
      name
    });

  } catch (error) {
    logger.error(`Error updating local review name: ${error.message}`);
    res.status(500).json({
      error: 'Failed to update review name'
    });
  }
});

/**
 * Get local diff
 */
router.get('/api/local/:reviewId/diff', async (req, res) => {
  const tEndpoint = Date.now();
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    // Verify the review exists
    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    // When ?w=1 or ?base=<branch>, regenerate the diff (transient view, not cached)
    const hideWhitespace = req.query.w === '1';
    const baseBranchOverride = req.query.base;
    const { start: scopeStart, end: scopeEnd } = reviewScope(review);
    const baseBranch = baseBranchOverride || review.local_base_branch;
    let diffData;

    if ((hideWhitespace || baseBranchOverride) && review.local_path) {
      try {
        // Call via the module namespace so tests can stub `generateScopedDiff`
        // with `vi.spyOn(localReview, 'generateScopedDiff')`. The destructured
        // top-level binding is captured at require time and would not honor a
        // spy.
        const wsResult = await localReview.generateScopedDiff(review.local_path, scopeStart, scopeEnd, baseBranch, { hideWhitespace });
        diffData = { diff: wsResult.diff, stats: wsResult.stats };
      } catch (wsError) {
        logger.warn(`Could not generate diff for review #${reviewId}: ${wsError.message}`);
        // Fall through to cached diff below
      }
    }

    // Get diff from module-level storage, falling back to database
    if (!diffData) {
      diffData = getLocalReviewDiff(reviewId);
    }

    if (!diffData) {
      // Try loading from database
      const persistedDiff = await reviewRepo.getLocalDiff(reviewId);
      if (persistedDiff) {
        diffData = persistedDiff;
        // Cache-warm the in-memory Map
        setLocalReviewDiff(reviewId, diffData);
        logger.log('API', `Loaded persisted diff from DB for review #${reviewId}`, 'cyan');
      } else {
        diffData = { diff: '', stats: {} };
      }
    }

    const { diff: diffContent, stats } = diffData;

    // Detect generated files via .gitattributes
    let generatedFiles = [];
    if (diffContent && review.local_path) {
      try {
        const gitattributes = await getGeneratedFilePatterns(review.local_path);
        if (gitattributes.getPatterns().length > 0) {
          // Extract file paths from the diff header lines (--- a/path and +++ b/path)
          const filePathRegex = /^diff --git a\/.+? b\/(.+)$/gm;
          let match;
          while ((match = filePathRegex.exec(diffContent)) !== null) {
            const filePath = match[1];
            if (gitattributes.isGenerated(filePath)) {
              generatedFiles.push(filePath);
            }
          }
        }
      } catch (error) {
        logger.warn(`Could not load .gitattributes: ${error.message}`);
      }
    }

    // Compute per-file hunk hashes for the hunk-summary feature.
    //
    // The frontend stamps these hashes onto rendered hunks BY INDEX
    // (`hunkHashes[blockIndex]`), so the array MUST be aligned to the
    // diff that was actually returned to the client. Two cases:
    //
    //   1. `?w=1`: `git diff -w` only DROPS whitespace-only hunks; it
    //      never rewrites kept hunks. The frontend renderPatch length
    //      guard catches the drop case (mismatch between canonical hash
    //      count and rendered block count) and bails. So for kept hunks
    //      the canonical hash still identifies the right rendered hunk
    //      AND matches the persisted summary key — fall back to the
    //      canonical diff here for hash computation.
    //
    //   2. `?base=<branch>`: regen produces a DIFFERENT diff against a
    //      different base. Hunk counts may match by coincidence, but the
    //      content can differ. Hashing the canonical diff would mount a
    //      summary onto an override hunk whose code it doesn't describe
    //      — silent and wrong. Hash the override diff instead so:
    //        - identical-content hunks (hash equals canonical) still
    //          match a persisted summary and mount correctly;
    //        - divergent-content hunks miss (hash mismatch) and stay
    //          unmounted — visibly missing rather than silently wrong.
    let canonicalDiff = diffContent;
    if (hideWhitespace && !baseBranchOverride) {
      const cached = getLocalReviewDiff(reviewId);
      if (cached?.diff) {
        canonicalDiff = cached.diff;
      } else {
        const persisted = await reviewRepo.getLocalDiff(reviewId);
        if (persisted?.diff) canonicalDiff = persisted.diff;
      }
    }
    const hunkHashesByFile = {};
    if (canonicalDiff) {
      const filePatchMap = parseUnifiedDiffPatches(canonicalDiff);
      for (const [filePath, filePatch] of filePatchMap.entries()) {
        const hunks = parseHunks(filePatch);
        if (hunks.length > 0) {
          hunkHashesByFile[filePath] = hunks.map((h) =>
            hashHunk(filePath, `${h.header}\n${h.lines.join('\n')}`)
          );
        }
      }
    }

    const diffElapsed = Date.now() - tEndpoint;
    if (diffElapsed > 200) {
      logger.debug(`[perf] diff#${reviewId} took ${diffElapsed}ms (threshold: 200ms)`);
    }
    res.json({
      diff: diffContent || '',
      generated_files: generatedFiles,
      hunk_hashes_by_file: hunkHashesByFile,
      stats: {
        trackedChanges: stats?.trackedChanges || 0,
        untrackedFiles: stats?.untrackedFiles || 0,
        stagedChanges: stats?.stagedChanges || 0,
        unstagedChanges: stats?.unstagedChanges || 0
      }
    });

  } catch (error) {
    logger.error('Error fetching local diff:', error);
    res.status(500).json({
      error: 'Failed to fetch local diff'
    });
  }
});

/**
 * Check if local review diff is stale (working directory has changed since diff was captured)
 * Uses a digest of the diff content for accurate change detection
 */
router.get('/api/local/:reviewId/check-stale', async (req, res) => {
  const tEndpoint = Date.now();
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.json({
        isStale: null,
        error: 'Local review not found'
      });
    }

    const localPath = review.local_path;
    if (!localPath) {
      return res.json({
        isStale: null,
        error: 'Local review missing path'
      });
    }

    const { start: scopeStart, end: scopeEnd } = reviewScope(review);

    // Always check HEAD SHA for supplementary fields
    let headShaChanged = false;
    let previousHeadSha = review.local_head_sha || null;
    let currentHeadSha = null;

    try {
      const { getHeadSha } = require('../local-review');
      currentHeadSha = await getHeadSha(localPath);
      headShaChanged = !!(previousHeadSha && currentHeadSha && currentHeadSha !== previousHeadSha);
    } catch (error) {
      // If branch is in scope, HEAD SHA failure is fatal (existing behavior)
      if (includesBranch(scopeStart)) {
        return res.json({
          isStale: true,
          headShaChanged,
          previousHeadSha,
          currentHeadSha: null,
          error: `Could not check HEAD SHA: ${error.message}`
        });
      }
      // Otherwise, just continue with digest check
    }

    // When branch is in scope and HEAD changed, early return (existing behavior)
    if (includesBranch(scopeStart) && headShaChanged) {
      const staleEarlyElapsed = Date.now() - tEndpoint;
      if (staleEarlyElapsed > 200) {
        logger.debug(`[perf] check-stale#${reviewId} took ${staleEarlyElapsed}ms (threshold: 200ms)`);
      }
      return res.json({
        isStale: true,
        headShaChanged,
        previousHeadSha,
        currentHeadSha
      });
    }

    // Get stored diff data (in-memory first, then fall back to DB)
    let storedDiffData = getLocalReviewDiff(reviewId);
    if (!storedDiffData) {
      const persistedDiff = await reviewRepo.getLocalDiff(reviewId);
      if (persistedDiff) {
        storedDiffData = persistedDiff;
        // Cache-warm the in-memory Map
        setLocalReviewDiff(reviewId, storedDiffData);
        logger.log('API', `Loaded persisted diff from DB for staleness check on review #${reviewId}`, 'cyan');
      } else {
        return res.json({
          isStale: null,
          headShaChanged,
          previousHeadSha,
          currentHeadSha,
          error: 'No stored diff data found'
        });
      }
    }

    // Check if baseline digest exists (must be computed at diff-capture time)
    if (!storedDiffData.digest) {
      // No baseline digest - session may predate staleness detection feature
      // Assume stale to be safe and prompt user to refresh
      return res.json({
        isStale: true,
        headShaChanged,
        previousHeadSha,
        currentHeadSha,
        error: 'No baseline digest - please refresh to enable staleness detection'
      });
    }

    // Compute current digest to compare against baseline
    const currentDigest = await computeScopedDigest(localPath, scopeStart, scopeEnd);

    // If current digest computation failed, assume stale to be safe
    if (!currentDigest) {
      return res.json({
        isStale: true,
        headShaChanged,
        previousHeadSha,
        currentHeadSha,
        error: 'Could not compute current digest - refresh recommended'
      });
    }

    const isStale = storedDiffData.digest !== currentDigest;

    const staleElapsed = Date.now() - tEndpoint;
    if (staleElapsed > 200) {
      logger.debug(`[perf] check-stale#${reviewId} took ${staleElapsed}ms (threshold: 200ms)`);
    }
    res.json({
      isStale,
      storedDigest: storedDiffData.digest,
      currentDigest,
      headShaChanged,
      previousHeadSha,
      currentHeadSha
    });

  } catch (error) {
    logger.warn(`Error checking local review staleness: ${error.message}`);
    res.json({
      isStale: null,
      headShaChanged: false,
      previousHeadSha: null,
      currentHeadSha: null,
      error: error.message
    });
  }
});

/**
 * Handle analysis for executable providers (external CLI tools).
 * Spawns the external CLI, maps its output to suggestions, and stores results.
 */
async function handleExecutableAnalysis(req, res, {
  reviewId, review, localPath, repository, selectedProvider, selectedModel,
  repoInstructions, requestInstructions, combinedInstructions, runId, analysisId, reviewRepo,
  providerOverrides
}) {
  return runExecutableAnalysis(req, res, {
    reviewId,
    review,
    selectedProvider,
    selectedModel,
    repoInstructions,
    requestInstructions,
    runId,
    analysisId,
    repository,
    reviewType: review.review_type || 'local',
    headSha: review.local_head_sha,
    providerOverrides
  }, {
    activeAnalyses,
    reviewToAnalysisId,
    broadcastProgress,
    broadcastReviewEvent,
    registerProcessForCancellation
  }, {
    logLabel: `Review #${reviewId}`,
    buildContext: (r, { selectedModel: model, requestInstructions: customInstructions }) => {
      const { start: scopeStart, end: scopeEnd } = reviewScope(r);
      return {
        title: null,
        description: null,
        cwd: localPath,
        model,
        baseSha: null,
        headSha: r.local_head_sha || null,
        baseBranch: r.local_base_branch || null,
        headBranch: r.local_head_branch || null,
        scopeStart,
        scopeEnd,
        customInstructions: customInstructions || null
      };
    },
    buildHookPayload: () => ({
      mode: review.review_type || 'local',
      localContext: { path: localPath, branch: review.local_head_branch, headSha: review.local_head_sha }
    }),
    onSuccess: async (_db, _runId, { summary }) => {
      if (summary) {
        try {
          await reviewRepo.updateSummary(reviewId, summary);
        } catch (e) {
          logger.warn(`Failed to save summary: ${e.message}`);
        }
      }
    }
  });
}

/**
 * Launch a local-mode council analysis.
 *
 * Shared by the explicit council endpoint (`POST .../analyses/council`) and the
 * plain-analyze default path (`POST .../analyses`) when a repo's
 * `default_council_id` resolves to a council and the request made no explicit
 * single-model pick. Both entry points build the same modeContext and call
 * `analysesRouter.launchCouncilAnalysis`, so council dispatch is not duplicated.
 *
 * The caller is responsible for resolving + validating `councilConfig`/`configType`
 * and for the empty-scope guard (`rejectIfEmptyScope`) before invoking this.
 *
 * @returns {{ analysisId: string, runId: string }}
 */
async function launchLocalCouncilAnalysis(req, {
  reviewId, review, localPath, councilConfig, councilId, configType,
  requestInstructions, excludePrevious
}) {
  const db = req.app.get('db');

  const { start: councilScopeStart, end: councilScopeEnd } = reviewScope(review);
  const councilHasBranch = includesBranch(councilScopeStart);

  // Compute merge-base when branch is in scope
  let analysisBaseSha = review.local_head_sha;
  if (councilHasBranch && review.local_base_branch) {
    try {
      analysisBaseSha = await findMergeBase(localPath, review.local_base_branch);
    } catch {
      // Fall back to HEAD
    }
  }

  const prMetadata = {
    reviewType: 'local',
    repository: review.repository,
    title: null,
    description: null,
    base_sha: analysisBaseSha,
    head_sha: review.local_head_sha,
    base_branch: review.local_base_branch || null,
    head_branch: review.local_head_branch || null,
    scopeStart: councilScopeStart,
    scopeEnd: councilScopeEnd,
  };

  // Use the scope-aware helper so the file list matches the generated diff
  // (covers branch, staged, unstaged, and untracked stops as appropriate).
  const changedFiles = await getChangedFiles(localPath, {
    scopeStart: councilScopeStart,
    scopeEnd: councilScopeEnd,
    baseBranch: review.local_base_branch || null,
  });

  // Generate and cache diff. Hoist the result out of the try so we can also
  // persist it to `local_diffs` below (after reviewRepo is constructed) — the
  // council path previously cached the diff in-memory only, which left the
  // manual tour/summary buttons reporting a false "no-diff" after a restart.
  let councilDiff = null;
  let councilStats = null;
  let councilDigest = null;
  try {
    const diffResult = await generateScopedDiff(localPath, councilScopeStart, councilScopeEnd, review.local_base_branch);
    councilDigest = await computeScopedDigest(localPath, councilScopeStart, councilScopeEnd);
    councilDiff = diffResult.diff;
    councilStats = diffResult.stats;
    setLocalReviewDiff(reviewId, { diff: councilDiff, stats: councilStats, digest: councilDigest });
  } catch (diffError) {
    logger.warn(`Could not generate diff for local council review ${reviewId}: ${diffError.message}`);
  }

  // Resolve instructions
  const repoSettingsRepo = new RepoSettingsRepository(db);
  const reviewRepo = new ReviewRepository(db);

  // Durably persist the diff so it survives a restart and the manual
  // tour/summary buttons can find it (parity with the analysis-push path).
  if (councilDiff) {
    try {
      await reviewRepo.saveLocalDiff(reviewId, { diff: councilDiff, stats: councilStats, digest: councilDigest });
    } catch (saveError) {
      logger.warn(`Could not persist diff for local council review ${reviewId}: ${saveError.message}`);
    }
  }
  const repoSettings = await repoSettingsRepo.getRepoSettings(review.repository);
  const repoInstructions = repoSettings?.default_instructions || null;

  if (requestInstructions) {
    await reviewRepo.updateReview(reviewId, {
      customInstructions: requestInstructions
    });
  }

  // Import launchCouncilAnalysis from analyses.js
  const analysesRouter = require('./analyses');
  const localCouncilConfig = req.app.get('config') || {};

  const { providerOverrides: councilProviderOverrides, providerOverridesMap: councilProviderOverridesMap } =
    buildCouncilProviderOverrides(localCouncilConfig, review.repository, repoSettings);

  // Local mode has no associated GitHub PR, so we do not pass a githubClient.
  // The analyzer drops the GitHub dedup section when no client is supplied.
  return analysesRouter.launchCouncilAnalysis(
    db,
    {
      reviewId,
      worktreePath: localPath,
      prMetadata,
      changedFiles,
      repository: review.repository,
      headSha: review.local_head_sha,
      logLabel: `local review #${reviewId}`,
      initialStatusExtra: { reviewId, reviewType: 'local' },
      config: localCouncilConfig,
      excludePrevious,
      serverPort: req.socket.localPort,
      providerOverrides: councilProviderOverrides,
      providerOverridesMap: councilProviderOverridesMap,
      hookContext: {
        mode: 'local',
        localContext: { path: localPath, branch: review.local_head_branch, headSha: review.local_head_sha },
      },
      runUpdateExtra: { filesAnalyzed: changedFiles ? changedFiles.length : 0 }
    },
    councilConfig,
    councilId,
    { globalInstructions: localCouncilConfig.globalInstructions || null, repoInstructions, requestInstructions },
    configType
  );
}

/**
 * Start Level 1 AI analysis for local review
 */
router.post('/api/local/:reviewId/analyses', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    // Extract optional provider, model, tier, customInstructions and skipLevel3 from request body
    const { provider: requestProvider, model: requestModel, tier: requestTier, customInstructions: rawInstructions, skipLevel3: requestSkipLevel3, enabledLevels: requestEnabledLevels, excludePrevious } = req.body || {};

    // Trim and validate custom instructions
    const MAX_INSTRUCTIONS_LENGTH = 5000;
    let requestInstructions = rawInstructions?.trim() || null;
    if (requestInstructions && requestInstructions.length > MAX_INSTRUCTIONS_LENGTH) {
      return res.status(400).json({
        error: `Custom instructions exceed maximum length of ${MAX_INSTRUCTIONS_LENGTH} characters`
      });
    }

    // Validate tier
    if (requestTier && !VALID_TIERS.includes(requestTier)) {
      return res.status(400).json({
        error: `Invalid tier: "${requestTier}". Valid tiers: ${VALID_TIERS.join(', ')}`
      });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    const localPath = review.local_path;
    const repository = review.repository;

    // Guard: reject if scope resolves to zero changed files
    if (await rejectIfEmptyScope(res, review, localPath)) return;

    // Fetch repo settings for default instructions
    const repoSettingsRepo = new RepoSettingsRepository(db);
    const repoSettings = repository ? await repoSettingsRepo.getRepoSettings(repository) : null;

    const appConfig = req.app.get('config') || {};

    // Repo default-council parity: when the request makes NO explicit single-model
    // pick (no provider/model in the body), honor the repo's saved
    // default_council_id by dispatching to the same council path the explicit
    // council endpoint uses. An explicit provider/model in the request always
    // wins and falls through to the single-provider path unchanged below.
    // For repos with no default_council_id the resolver returns type:'single' and
    // we fall through, so single-provider behavior is byte-identical to before.
    // (A CLI --provider override arrives here as a populated requestProvider —
    // the frontend forces the single-provider path when an override is active —
    // so this council branch is correctly skipped for delegated overrides.)
    if (!requestProvider && !requestModel) {
      const reviewConfig = await resolveReviewConfig(
        db,
        repository,
        { provider: requestProvider, model: requestModel },
        appConfig
      );
      if (reviewConfig.type === 'council') {
        logger.log('API', `Honoring repo default council for ${repository}: ${reviewConfig.council.name}`, 'cyan');
        const { analysisId: councilAnalysisId, runId: councilRunId } = await launchLocalCouncilAnalysis(req, {
          reviewId, review, localPath,
          councilConfig: reviewConfig.councilConfig,
          councilId: reviewConfig.council.id,
          configType: reviewConfig.configType,
          requestInstructions,
          excludePrevious
        });
        return res.json({
          analysisId: councilAnalysisId,
          runId: councilRunId,
          status: 'started',
          message: 'Council analysis started in background',
          isCouncil: true
        });
      }
    }

    // Resolve provider/model: request body > env/CLI > repo settings > config/legacy > default.
    // Shared with the PR route (src/routes/pr.js) so both paths resolve identically.
    const { provider: selectedProvider, model: selectedModel } = resolveProviderModel(req, {
      requestProvider,
      requestModel,
      repoSettings
    });

    // Get repo instructions from settings
    const repoInstructions = repoSettings?.default_instructions || null;
    // Get global instructions from config (loaded at startup from ~/.pair-review/global-instructions.md)
    const globalInstructions = appConfig.globalInstructions || null;
    // Merge for logging purposes (analyzer will also merge internally)
    const combinedInstructions = mergeInstructions({ globalInstructions, repoInstructions, requestInstructions });

    // Save custom instructions to the review record
    // Only update when requestInstructions has a value - updateReview would accept
    // null/undefined but we only want to persist actual user-provided instructions
    if (requestInstructions) {
      await reviewRepo.updateReview(reviewId, {
        customInstructions: requestInstructions
      });
    }

    // Create unified run/analysis ID
    const runId = uuidv4();
    const analysisId = runId;

    // Resolve load_skills across all config tiers
    const providerLoadSkills = appConfig.providers?.[selectedProvider]?.load_skills;
    const loadSkills = resolveLoadSkills(appConfig, repository, repoSettings, providerLoadSkills);
    const providerOverrides = { load_skills: loadSkills };

    // Check if selected provider is an executable provider (external tool)
    const ProviderClass = getProviderClass(selectedProvider);
    if (ProviderClass?.isExecutable) {
      return handleExecutableAnalysis(req, res, {
        reviewId,
        review,
        localPath,
        repository,
        selectedProvider,
        selectedModel,
        repoInstructions,
        requestInstructions,
        combinedInstructions,
        runId,
        analysisId,
        reviewRepo,
        providerOverrides
      });
    }

    // Extract scope early — needed for both analysis run creation and diff generation
    const { start: scopeStart, end: scopeEnd } = reviewScope(review);

    // Create DB analysis_runs record immediately so it's queryable for polling
    const analysisRunRepo = new AnalysisRunRepository(db);
    const levelsConfig = parseEnabledLevels(requestEnabledLevels, requestSkipLevel3);
    const tier = requestTier ? resolveTier(requestTier) : 'balanced';
    try {
      await analysisRunRepo.create({
        id: runId,
        reviewId,
        provider: selectedProvider,
        model: selectedModel,
        tier,
        globalInstructions,
        repoInstructions,
        requestInstructions,
        headSha: review.local_head_sha || null,
        configType: 'single',
        levelsConfig,
        scopeStart,
        scopeEnd
      });
    } catch (error) {
      logger.error('Failed to create analysis run record:', error);
      return res.status(500).json({ error: 'Failed to initialize analysis tracking' });
    }

    // Store analysis status with separate tracking for each level
    const initialStatus = {
      id: analysisId,
      runId,
      reviewId,
      repository: repository,
      reviewType: 'local',
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: 'Starting analysis...',
      levels: {
        1: levelsConfig[1] ? { status: 'running', progress: 'Starting...' } : { status: 'skipped', progress: 'Skipped' },
        2: levelsConfig[2] ? { status: 'running', progress: 'Starting...' } : { status: 'skipped', progress: 'Skipped' },
        3: levelsConfig[3] ? { status: 'running', progress: 'Starting...' } : { status: 'skipped', progress: 'Skipped' },
        4: { status: 'pending', progress: 'Pending' }
      },
      filesAnalyzed: 0,
      filesRemaining: 0
    };
    activeAnalyses.set(analysisId, initialStatus);

    // Store review to analysis ID mapping (unified map)
    reviewToAnalysisId.set(reviewId, analysisId);

    // Broadcast initial status
    broadcastProgress(analysisId, initialStatus);
    broadcastReviewEvent(reviewId, { type: 'review:analysis_started', analysisId });
    const analysisHookConfig = req.app.get('config') || {};
    if (hasHooks('analysis.started', analysisHookConfig)) {
      getCachedUser(analysisHookConfig).then(user => {
        fireHooks('analysis.started', buildAnalysisStartedPayload({
          reviewId, analysisId, provider: selectedProvider, model: selectedModel,
          mode: 'local',
          localContext: { path: localPath, branch: review.local_head_branch, headSha: review.local_head_sha },
          user,
        }), analysisHookConfig);
      }).catch(() => {});
    }

    // Create analyzer instance with provider and model
    const analyzer = new Analyzer(db, selectedModel, selectedProvider, providerOverrides);

    // Build local review metadata for the analyzer
    // The analyzer uses base_sha and head_sha for git diff commands
    // When branch is in scope, base_sha is the merge-base; otherwise, HEAD
    const hasBranch = includesBranch(scopeStart);
    let analysisBaseSha = review.local_head_sha;
    if (hasBranch && review.local_base_branch) {
      try {
        analysisBaseSha = await findMergeBase(localPath, review.local_base_branch);
      } catch {
        // Fall back to HEAD
      }
    }
    const localMetadata = {
      id: reviewId,
      repository: review.repository,
      title: hasBranch
        ? `Branch changes: ${review.local_base_branch}..HEAD`
        : `Local changes in ${repository}`,
      description: hasBranch
        ? `Reviewing committed changes on branch against ${review.local_base_branch}`
        : `Reviewing uncommitted changes in ${localPath}`,
      base_sha: analysisBaseSha,
      head_sha: review.local_head_sha,
      reviewType: 'local'
    };

    // Get changed files for local mode path validation.
    // Use the scope-aware helper so the file list matches the generated diff
    // (covers branch, staged, unstaged, and untracked stops as appropriate).
    const changedFiles = await getChangedFiles(localPath, {
      scopeStart,
      scopeEnd,
      baseBranch: review.local_base_branch || null,
    });

    // Log analysis start
    logger.section(`Local AI Analysis Request - Review #${reviewId}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');
    logger.log('API', `Local path: ${localPath}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');
    logger.log('API', `Provider: ${selectedProvider}`, 'cyan');
    logger.log('API', `Model: ${selectedModel}`, 'cyan');
    logger.log('API', `Tier: ${tier}`, 'cyan');
    logger.log('API', `Changed files: ${changedFiles.length}`, 'cyan');
    if (combinedInstructions) {
      logger.log('API', `Custom instructions: ${combinedInstructions.length} chars`, 'cyan');
    }

    const progressCallback = createProgressCallback(analysisId);

    // Start analysis asynchronously (skipRunCreation since we created the record above; also passes changedFiles for local mode path validation, tier for prompt selection, and skipLevel3 flag).
    // Local mode has no associated GitHub PR, so githubClient is intentionally omitted —
    // the analyzer drops the GitHub dedup section when no client is supplied.
    analyzer.analyzeLevel1(reviewId, localPath, localMetadata, progressCallback, { globalInstructions, repoInstructions, requestInstructions }, changedFiles, { analysisId, runId, skipRunCreation: true, tier, skipLevel3: requestSkipLevel3, enabledLevels: levelsConfig, excludePrevious, serverPort: req.socket.localPort })
      .then(async result => {
        logger.section('Local Analysis Results');
        logger.success(`Analysis complete for local review #${reviewId}`);
        logger.success(`Found ${result.suggestions.length} suggestions`);

        // Save summary to review record (reuse reviewRepo from handler start)
        if (result.summary) {
          try {
            await reviewRepo.updateSummary(reviewId, result.summary);
            logger.info(`Saved analysis summary to review record`);
            logger.section('Analysis Summary');
            logger.info(result.summary);
          } catch (summaryError) {
            logger.warn(`Failed to save analysis summary: ${summaryError.message}`);
          }
        }

        // Determine completion status
        const completionInfo = determineCompletionInfo(result);

        const currentStatus = activeAnalyses.get(analysisId);
        if (!currentStatus) {
          logger.warn('Analysis already completed or removed:', analysisId);
          return;
        }

        // Check if analysis was cancelled while running
        if (currentStatus.status === 'cancelled') {
          logger.info(`Analysis ${analysisId} was cancelled, skipping completion update`);
          return;
        }

        // Mark all completed levels as completed
        for (let i = 1; i <= completionInfo.completedLevel; i++) {
          currentStatus.levels[i] = {
            status: 'completed',
            progress: `Level ${i} complete`
          };
        }

        // Mark orchestration (level 4) as completed
        currentStatus.levels[4] = {
          status: 'completed',
          progress: 'Results finalized'
        };

        const completedStatus = {
          ...currentStatus,
          status: 'completed',
          level: completionInfo.completedLevel,
          completedLevel: completionInfo.completedLevel,
          completedAt: new Date().toISOString(),
          result,
          progress: completionInfo.progressMessage,
          suggestionsCount: completionInfo.totalSuggestions,
          filesAnalyzed: currentStatus?.filesAnalyzed || 0,
          filesRemaining: 0
        };
        activeAnalyses.set(analysisId, completedStatus);

        // Broadcast completion status
        broadcastProgress(analysisId, completedStatus);
        broadcastReviewEvent(reviewId, { type: 'review:analysis_completed' });

        // Fire analysis.completed hook
        const hookConfig = req.app.get('config') || {};
        if (hasHooks('analysis.completed', hookConfig)) {
          getCachedUser(hookConfig).then(user => {
            fireHooks('analysis.completed', buildAnalysisCompletedPayload({
              reviewId, analysisId, provider: selectedProvider, model: selectedModel,
              status: 'success',
              totalSuggestions: completionInfo.totalSuggestions,
              mode: 'local',
              localContext: { path: localPath, branch: review.local_head_branch, headSha: review.local_head_sha },
              user,
            }), hookConfig);
          }).catch(() => {});
        }
      })
      .catch(error => {
        const currentStatus = activeAnalyses.get(analysisId);
        if (!currentStatus) {
          logger.warn('Analysis status not found during error handling:', analysisId);
          return;
        }

        // Handle cancellation gracefully - don't log as error
        if (error.isCancellation) {
          logger.info(`Local analysis cancelled for review #${reviewId}`);
          // Status is already set to 'cancelled' by the cancel endpoint
          const cancelConfig = req.app.get('config') || {};
          if (hasHooks('analysis.completed', cancelConfig)) {
            getCachedUser(cancelConfig).then(user => {
              fireHooks('analysis.completed', buildAnalysisCompletedPayload({
                reviewId, analysisId, provider: selectedProvider, model: selectedModel,
                status: 'cancelled', totalSuggestions: 0,
                mode: 'local',
                localContext: { path: localPath, branch: review.local_head_branch, headSha: review.local_head_sha },
                user,
              }), cancelConfig);
            }).catch(() => {});
          }
          return;
        }

        logger.error(`Local analysis failed for review #${reviewId}: ${error.message}`);

        // Mark all levels as failed
        for (let i = 1; i <= 4; i++) {
          currentStatus.levels[i] = {
            status: 'failed',
            progress: 'Failed'
          };
        }

        const failedStatus = {
          ...currentStatus,
          status: 'failed',
          level: 1,
          completedAt: new Date().toISOString(),
          error: error.message,
          progress: 'Analysis failed'
        };
        activeAnalyses.set(analysisId, failedStatus);

        // Broadcast failure status
        broadcastProgress(analysisId, failedStatus);

        const failConfig = req.app.get('config') || {};
        if (hasHooks('analysis.completed', failConfig)) {
          getCachedUser(failConfig).then(user => {
            fireHooks('analysis.completed', buildAnalysisCompletedPayload({
              reviewId, analysisId, provider: selectedProvider, model: selectedModel,
              status: 'failed', totalSuggestions: 0,
              mode: 'local',
              localContext: { path: localPath, branch: review.local_head_branch, headSha: review.local_head_sha },
              user,
            }), failConfig);
          }).catch(() => {});
        }
      })
      .finally(() => {
        // Clean up review to analysis ID mapping (unified map)
        reviewToAnalysisId.delete(reviewId);
      });

    // Return analysis ID immediately (runId added for unified ID)
    res.json({
      analysisId,
      runId,
      status: 'started',
      message: 'AI analysis started in background'
    });

  } catch (error) {
    logger.error('Error starting local AI analysis:', error);
    res.status(500).json({
      error: 'Failed to start AI analysis'
    });
  }
});


/**
 * Refresh the diff for a local review
 * Regenerates the diff from the current state of the working directory
 * Returns sessionChanged flag if HEAD has changed since the session was created
 */
router.post('/api/local/:reviewId/refresh', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    const localPath = review.local_path;
    const originalHeadSha = review.local_head_sha;

    if (!localPath) {
      return res.status(400).json({
        error: 'Local review is missing path information'
      });
    }

    logger.log('API', `Refreshing diff for local review #${reviewId}`, 'cyan');
    logger.log('API', `Local path: ${localPath}`, 'magenta');

    // Check if HEAD has changed
    const { getHeadSha } = require('../local-review');
    const { start: scopeStart, end: scopeEnd } = reviewScope(review);
    const hasBranch = includesBranch(scopeStart);
    let currentHeadSha;
    let headShaChanged = false;

    try {
      currentHeadSha = await getHeadSha(localPath);

      if (originalHeadSha && currentHeadSha !== originalHeadSha) {
        headShaChanged = true;
        const abbrevLen = getShaAbbrevLength(localPath);
        logger.log('API', `HEAD changed: ${originalHeadSha.substring(0, abbrevLen)} -> ${currentHeadSha.substring(0, abbrevLen)}`, 'yellow');

        if (hasBranch) {
          // Branch scope: session persists across HEAD changes — just update the SHA
          await reviewRepo.updateLocalHeadSha(reviewId, currentHeadSha);
          logger.log('API', `Updated HEAD SHA on branch-scope session ${reviewId}`, 'cyan');
        }
        // Non-branch scope: defer decision to frontend via resolve-head-change endpoint
      }
    } catch (headError) {
      logger.warn(`Could not check HEAD SHA: ${headError.message}`);
    }

    // Recompute branchAvailable so the frontend can update the scope selector
    // (e.g. after a commit creates the first branch-ahead commit).
    // Lazy require to ensure testability via vi.spyOn on the module exports.
    let branchName;
    try { branchName = await require('../local-review').getCurrentBranch(localPath); } catch (_) { branchName = review.local_head_branch || null; }
    const branchAvailable = isBranchAvailable(branchName, scopeStart, localPath);

    // Non-branch HEAD change: skip diff computation entirely — the old diff is
    // preserved until the user decides (via resolve-head-change) what to do.
    // The resolve-head-change endpoint will recompute the diff for whichever
    // action the user picks (update or new-session).
    if (headShaChanged && !hasBranch) {
      return res.json({
        success: true,
        message: 'HEAD changed — awaiting user decision',
        headShaChanged,
        branchAvailable,
        previousHeadSha: originalHeadSha,
        currentHeadSha: currentHeadSha || null,
        stats: {}
      });
    }

    const scopedResult = await generateScopedDiff(localPath, scopeStart, scopeEnd, review.local_base_branch);
    const diff = scopedResult.diff;
    const stats = scopedResult.stats;
    const digest = await computeScopedDigest(localPath, scopeStart, scopeEnd);

    setLocalReviewDiff(reviewId, { diff, stats, digest });
    try {
      await reviewRepo.saveLocalDiff(reviewId, { diff, stats, digest });
    } catch (persistError) {
      logger.warn(`Could not persist diff to database: ${persistError.message}`);
    }

    logger.success(`Diff refreshed (scope ${scopeStart}–${scopeEnd}): ${stats.trackedChanges || 0} file(s)`);

    res.json({
      success: true,
      message: 'Diff refreshed successfully',
      headShaChanged,
      branchAvailable,
      previousHeadSha: originalHeadSha,
      currentHeadSha: currentHeadSha || null,
      stats: {
        trackedChanges: stats.trackedChanges || 0,
        untrackedFiles: stats.untrackedFiles || 0,
        stagedChanges: stats.stagedChanges || 0,
        unstagedChanges: stats.unstagedChanges || 0
      }
    });

    // Re-kick the summary and tour jobs against the fresh diff. Each kickoff
    // is dedup'd by digest (summaries) or hash (tour); a no-op when the
    // canonical diff is unchanged (e.g. user clicked refresh but nothing
    // upstream changed). When the digest IS new, the kickoffs auto-cancel
    // the stale in-flight job before enqueueing the fresh one — see
    // kickOffSummaryJob / kickOffTourJob.
    const config = req.app.get('config') || {};
    const reviewContext = { prTitle: branchName || review.local_head_branch || undefined };
    (async () => {
      await summaryGenerator.kickOffSummaryJob({
        db, config, reviewId, diffText: diff, worktreePath: localPath, reviewContext, trigger: 'auto'
      });
    })().catch((err) => logger.warn(`Hunk summary job failed for review ${reviewId}: ${err.message}`));
    (async () => {
      await tourGenerator.kickOffTourJob({
        db, config, reviewId, diffText: diff, worktreePath: localPath, reviewContext, trigger: 'auto'
      });
    })().catch((err) => logger.warn(`Tour job failed for review ${reviewId}: ${err.message}`));

  } catch (error) {
    logger.error('Error refreshing local diff:', error);
    res.status(500).json({
      error: 'Failed to refresh diff: ' + error.message
    });
  }
});

/**
 * Resolve a HEAD SHA change on a non-branch-scoped review.
 * Called by the frontend after the user chooses how to handle a detected HEAD change.
 *
 * action: 'update'      — keep the current session, update its SHA, recompute diff
 * action: 'new-session'  — create a fresh session for the new HEAD, return its ID
 */
router.post('/api/local/:reviewId/resolve-head-change', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }

    const { action, newHeadSha } = req.body || {};
    if (!action || !['update', 'new-session'].includes(action)) {
      return res.status(400).json({ error: 'action must be "update" or "new-session"' });
    }
    if (!newHeadSha || typeof newHeadSha !== 'string') {
      return res.status(400).json({ error: 'newHeadSha is required' });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);
    if (!review) {
      return res.status(404).json({ error: `Local review #${reviewId} not found` });
    }

    const localPath = review.local_path;
    if (!localPath) {
      return res.status(400).json({ error: 'Local review is missing path information' });
    }

    const { start: scopeStart, end: scopeEnd } = reviewScope(review);

    if (action === 'update') {
      // Read live branch — may differ from stored value after a checkout.
      // Lazy require to ensure testability via vi.spyOn on the module exports.
      let headBranch;
      try { headBranch = await require('../local-review').getCurrentBranch(localPath); } catch (_) { headBranch = review.local_head_branch || null; }

      // Check for UNIQUE conflict before any mutation.
      // Use the live branch + new SHA so the conflict check targets the
      // final identity tuple (localPath, newHeadSha, headBranch).
      const conflict = await reviewRepo.getLocalReview(localPath, newHeadSha, headBranch);
      if (conflict && conflict.id !== reviewId) {
        logger.log('API', `UNIQUE conflict: session #${conflict.id} already exists for this HEAD`, 'yellow');
        return res.json({ success: true, action: 'redirect', sessionId: conflict.id });
      }

      // Persist SHA and branch together in a single write so SQLite only
      // ever sees the final identity tuple — no transient intermediate state.
      await reviewRepo.updateReview(reviewId, { local_head_sha: newHeadSha, local_head_branch: headBranch, local_base_branch: null });
      logger.log('API', `Updated HEAD SHA and branch on session ${reviewId} (cleared cached base branch)`, 'cyan');

      // Recompute and persist diff
      const scopedResult = await generateScopedDiff(localPath, scopeStart, scopeEnd, review.local_base_branch);
      const digest = await computeScopedDigest(localPath, scopeStart, scopeEnd);
      setLocalReviewDiff(reviewId, { diff: scopedResult.diff, stats: scopedResult.stats, digest });
      try {
        await reviewRepo.saveLocalDiff(reviewId, { diff: scopedResult.diff, stats: scopedResult.stats, digest });
      } catch (persistError) {
        logger.warn(`Could not persist diff to database: ${persistError.message}`);
      }

      // Recompute branchAvailable — the commit may have created the first
      // branch-ahead commit, making the Branch scope stop selectable.
      const branchAvailable = isBranchAvailable(headBranch, scopeStart, localPath);

      res.json({ success: true, action: 'updated', branchAvailable });

      // Re-kick the summary and tour jobs against the freshly-recomputed diff.
      // The frontend's _resolveHeadChange path applies the refreshed diff in
      // place via GET /diff (which is read-only and does NOT enqueue), so
      // without an explicit kickoff here the in-flight stale job from the
      // previous HEAD would keep burning tokens against a now-stale diff.
      // Each kickoff is dedup'd by digest/hash; a no-op when the recomputed
      // diff matches. When the digest IS new, the kickoffs auto-cancel the
      // stale in-flight job before enqueueing the fresh one.
      const config = req.app.get('config') || {};
      const reviewContext = { prTitle: headBranch || review.local_head_branch || undefined };
      (async () => {
        await summaryGenerator.kickOffSummaryJob({
          db, config, reviewId, diffText: scopedResult.diff, worktreePath: localPath, reviewContext, trigger: 'auto'
        });
      })().catch((err) => logger.warn(`Hunk summary job failed for review ${reviewId}: ${err.message}`));
      (async () => {
        await tourGenerator.kickOffTourJob({
          db, config, reviewId, diffText: scopedResult.diff, worktreePath: localPath, reviewContext, trigger: 'auto'
        });
      })().catch((err) => logger.warn(`Tour job failed for review ${reviewId}: ${err.message}`));
      return;
    }

    // action === 'new-session'
    let branch;
    try { branch = await getCurrentBranch(localPath); } catch (_) { /* non-fatal */ }
    const repository = await getRepositoryName(localPath);

    // Check for an existing session at the new HEAD
    const existing = await reviewRepo.findLocalReview(localPath, newHeadSha, branch);
    if (existing) {
      logger.log('API', `Existing session found for new HEAD: ${existing.id}`, 'cyan');
      return res.json({ success: true, action: 'new-session', newSessionId: existing.id });
    }

    const newSessionId = await reviewRepo.upsertLocalReview({
      localPath,
      localHeadSha: newHeadSha,
      repository,
      scopeStart,
      scopeEnd,
      localHeadBranch: branch
    });
    logger.log('API', `Created new session for new HEAD: ${newSessionId}`, 'cyan');

    // Compute and persist diff so the new session is immediately usable
    const newScopeResult = await generateScopedDiff(localPath, scopeStart, scopeEnd, review.local_base_branch);
    const newDigest = await computeScopedDigest(localPath, scopeStart, scopeEnd);
    setLocalReviewDiff(newSessionId, { diff: newScopeResult.diff, stats: newScopeResult.stats, digest: newDigest });
    try {
      await reviewRepo.saveLocalDiff(newSessionId, { diff: newScopeResult.diff, stats: newScopeResult.stats, digest: newDigest });
    } catch (persistError) {
      logger.warn(`Could not persist diff for new session: ${persistError.message}`);
    }

    return res.json({ success: true, action: 'new-session', newSessionId });

  } catch (error) {
    logger.error('Error resolving head change:', error);
    res.status(500).json({ error: 'Failed to resolve head change: ' + error.message });
  }
});

/**
 * Set the scope range for a local review.
 * Validates scope, detects baseBranch if needed, regenerates diff.
 */
router.post('/api/local/:reviewId/set-scope', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }

    const { scopeStart, scopeEnd, baseBranch: requestBaseBranch } = req.body || {};

    if (!scopeStart || !scopeEnd) {
      return res.status(400).json({ error: 'scopeStart and scopeEnd are required' });
    }

    if (!isValidScope(scopeStart, scopeEnd)) {
      return res.status(400).json({ error: `Invalid scope range: ${scopeStart}–${scopeEnd}` });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({ error: `Local review #${reviewId} not found` });
    }

    const localPath = review.local_path;
    if (!localPath) {
      return res.status(400).json({ error: 'Local review is missing path information' });
    }

    // When branch is in scope, resolve baseBranch and current branch
    let baseBranch = requestBaseBranch || null;
    let currentBranch = null;
    if (includesBranch(scopeStart)) {
      currentBranch = await require('../local-review').getCurrentBranch(localPath);
      if (!baseBranch) {
        // Use cached base branch from background detection if available
        if (review.local_base_branch && review.local_head_branch === currentBranch) {
          baseBranch = review.local_base_branch;
          logger.debug(`[perf] set-scope#${reviewId} using cached base branch: ${baseBranch}`);
        } else {
          const { detectBaseBranch } = require('../git/base-branch');
          const config = req.app.get('config') || {};
          const { resolveHostBinding: _resolveHostBinding } = require('../config');
          const localBinding = _resolveHostBinding(review.repository, config);
          const token = localBinding.token;
          const detection = await detectBaseBranch(localPath, currentBranch, {
            repository: review.repository,
            enableGraphite: config.enable_graphite === true,
            _deps: token ? {
              getGitHubToken: () => token,
              getHostBinding: () => localBinding
            } : undefined
          });
          if (!detection) {
            return res.status(400).json({ error: 'Could not detect base branch' });
          }
          baseBranch = detection.baseBranch;
        }
      }

      // Validate branch name to prevent shell injection
      if (!/^[\w.\-/]+$/.test(baseBranch)) {
        return res.status(400).json({ error: 'Invalid branch name' });
      }
    }

    logger.log('API', `Setting scope on review #${reviewId}: ${scopeStart}–${scopeEnd}${baseBranch ? ` (base: ${baseBranch})` : ''}`, 'cyan');

    // Generate diff for the new scope
    const { diff, stats, mergeBaseSha } = await generateScopedDiff(localPath, scopeStart, scopeEnd, baseBranch);

    // Get the HEAD SHA for staleness tracking
    const { getHeadSha } = require('../local-review');
    const headSha = await getHeadSha(localPath);

    // Update the review record with new scope (headBranch stored on branch scope, cleared otherwise)
    await reviewRepo.updateLocalScope(reviewId, scopeStart, scopeEnd, baseBranch, currentBranch);
    await reviewRepo.updateLocalHeadSha(reviewId, headSha);

    // Auto-name review from first commit subject when branch is newly in scope
    const { start: oldScopeStart } = reviewScope(review);
    if (!review.name && includesBranch(scopeStart) && !includesBranch(oldScopeStart) && baseBranch) {
      const firstSubject = await getFirstCommitSubject(localPath, baseBranch);
      if (firstSubject) {
        await reviewRepo.updateReview(reviewId, { name: firstSubject.slice(0, 200) });
      }
    }

    // Compute digest
    const digest = await computeScopedDigest(localPath, scopeStart, scopeEnd);

    // Store diff in cache and DB
    setLocalReviewDiff(reviewId, { diff, stats, digest });
    await reviewRepo.saveLocalDiff(reviewId, { diff, stats, digest });

    logger.success(`Review #${reviewId} scope set to ${scopeStart}–${scopeEnd}: ${stats.trackedChanges || 0} file(s) changed`);

    res.json({
      success: true,
      scopeStart,
      scopeEnd,
      localMode: includesBranch(scopeStart) ? 'branch' : 'uncommitted',
      baseBranch,
      mergeBaseSha,
      stats: {
        trackedChanges: stats.trackedChanges || 0,
        untrackedFiles: stats.untrackedFiles || 0,
        stagedChanges: stats.stagedChanges || 0,
        unstagedChanges: stats.unstagedChanges || 0
      }
    });

    // Re-kick the summary and tour jobs against the freshly-scoped diff.
    // Each kickoff is dedup'd by diff digest/hash; when the scope change
    // actually produces a different diff, the kickoffs auto-cancel the
    // stale in-flight job before enqueueing the fresh one.
    const config = req.app.get('config') || {};
    const reviewContext = { prTitle: currentBranch || review.local_head_branch || undefined };
    (async () => {
      await summaryGenerator.kickOffSummaryJob({
        db, config, reviewId, diffText: diff, worktreePath: localPath, reviewContext, trigger: 'auto'
      });
    })().catch((err) => logger.warn(`Hunk summary job failed for review ${reviewId}: ${err.message}`));
    (async () => {
      await tourGenerator.kickOffTourJob({
        db, config, reviewId, diffText: diff, worktreePath: localPath, reviewContext, trigger: 'auto'
      });
    })().catch((err) => logger.warn(`Tour job failed for review ${reviewId}: ${err.message}`));

  } catch (error) {
    logger.error(`Error setting scope: ${error.message}`);
    res.status(500).json({ error: 'Failed to set scope: ' + error.message });
  }
});

/**
 * Save "don't ask again" preference for branch review
 */
router.post('/api/local/:reviewId/branch-review-preference', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }

    const { preference } = req.body || {};
    if (![0, 1, -1].includes(preference)) {
      return res.status(400).json({ error: 'Invalid preference value. Must be 0, 1, or -1.' });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({ error: `Local review #${reviewId} not found` });
    }

    const repository = review.repository;
    if (!repository || !repository.includes('/')) {
      return res.status(400).json({ error: 'Cannot save preference: no repository identified' });
    }

    const repoSettingsRepo = new RepoSettingsRepository(db);
    const existing = await repoSettingsRepo.getRepoSettings(repository);

    if (existing) {
      await run(db, `
        UPDATE repo_settings SET auto_branch_review = ?, updated_at = ? WHERE repository = ? COLLATE NOCASE
      `, [preference, new Date().toISOString(), repository]);
    } else {
      await run(db, `
        INSERT INTO repo_settings (repository, auto_branch_review, created_at, updated_at) VALUES (?, ?, ?, ?)
      `, [repository, preference, new Date().toISOString(), new Date().toISOString()]);
    }

    res.json({ success: true, preference });

  } catch (error) {
    logger.error(`Error saving branch review preference: ${error.message}`);
    res.status(500).json({ error: 'Failed to save preference' });
  }
});

/**
 * Get review settings for a local review
 * Returns the custom_instructions from the review record
 */
router.get('/api/local/:reviewId/review-settings', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.json({
        custom_instructions: null,
        last_council_id: null
      });
    }

    // Find the last council used for this review
    let last_council_id = null;
    const lastCouncilRun = await queryOne(db, `
      SELECT model FROM analysis_runs
      WHERE review_id = ? AND provider = 'council' AND model != 'inline-config'
      ORDER BY started_at DESC LIMIT 1
    `, [review.id]);
    if (lastCouncilRun) {
      last_council_id = lastCouncilRun.model;
    }

    res.json({
      custom_instructions: review.custom_instructions || null,
      last_council_id
    });

  } catch (error) {
    logger.error('Error fetching local review settings:', error);
    res.status(500).json({
      error: 'Failed to fetch review settings'
    });
  }
});

/**
 * Save review settings for a local review
 * Saves the custom_instructions to the review record
 */
router.post('/api/local/:reviewId/review-settings', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const { custom_instructions } = req.body;

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    // Update the review with custom instructions
    await reviewRepo.updateReview(reviewId, {
      customInstructions: custom_instructions || null
    });

    res.json({
      success: true,
      custom_instructions: custom_instructions || null
    });

  } catch (error) {
    logger.error('Error saving local review settings:', error);
    res.status(500).json({
      error: 'Failed to save review settings'
    });
  }
});

/**
 * Trigger council analysis for a local review
 */
router.post('/api/local/:reviewId/analyses/council', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId, 10);
    const { councilId, councilConfig: inlineConfig, customInstructions: rawInstructions, configType: requestConfigType, excludePrevious } = req.body || {};

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }

    if (!councilId && !inlineConfig) {
      return res.status(400).json({ error: 'Either councilId or councilConfig is required' });
    }

    const db = req.app.get('db');

    // Get review record
    const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ? AND review_type = ?', [reviewId, 'local']);
    if (!review) {
      return res.status(404).json({ error: 'Local review not found' });
    }

    // Resolve council config and determine config type
    let councilConfig;
    let configType;
    if (councilId) {
      const councilRepo = new CouncilRepository(db);
      const council = await councilRepo.getById(councilId);
      if (!council) {
        return res.status(404).json({ error: 'Council not found' });
      }
      councilConfig = council.config;
      configType = requestConfigType || council.type || 'advanced';
    } else {
      councilConfig = inlineConfig;
      configType = requestConfigType || 'advanced';
    }

    councilConfig = normalizeCouncilConfig(councilConfig, configType);

    const configError = validateCouncilConfig(councilConfig, configType);
    if (configError) {
      return res.status(400).json({ error: `Invalid council config: ${configError}` });
    }

    const localPath = review.local_path;

    // Guard: reject if scope resolves to zero changed files
    if (await rejectIfEmptyScope(res, review, localPath)) return;

    const { analysisId, runId } = await launchLocalCouncilAnalysis(req, {
      reviewId, review, localPath, councilConfig, councilId, configType,
      requestInstructions: rawInstructions?.trim() || null,
      excludePrevious
    });

    res.json({
      analysisId,
      runId,
      status: 'started',
      message: 'Council analysis started in background',
      isCouncil: true
    });
  } catch (error) {
    logger.error('Error starting local council analysis:', error);
    res.status(500).json({ error: 'Failed to start council analysis' });
  }
});

/**
 * POST /api/local/:reviewId/jobs/:jobKey/start
 *
 * Manually trigger a summary or tour generation job for this local review.
 * Used by the frontend when `auto_generate` is off and the user clicks the
 * toolbar button.
 *
 * Mirrors the server-side kickoff that runs on local review load, but passes
 * `trigger: 'manual'` so it bypasses the `auto_generate` gate (the `enabled`
 * gate still applies — disabled features return 409).
 *
 * Request:
 *   - `jobKey` path param: `summary` or `tour`
 *
 * Responses:
 *   - 200 `{ started: true,  alreadyRunning: false }` — enqueued
 *   - 200 `{ started: false, alreadyRunning: true  }` — feature on but a job
 *                                                       is already in flight
 *                                                       (idempotent no-op)
 *   - 200 `{ started: false, reason: 'no-diff' }`   — diff is empty
 *   - 400 `{ error: 'Invalid jobKey' }`             — unknown jobKey
 *   - 404 `{ error: '...' }`                        — review not found
 *   - 409 `{ error: '... disabled' }`               — feature disabled in config
 */
const LOCAL_MANUAL_START_JOB_KEYS = new Set(['summary', 'tour']);

router.post('/api/local/:reviewId/jobs/:jobKey/start', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId, 10);
    if (!Number.isInteger(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }
    const { jobKey } = req.params;
    if (!LOCAL_MANUAL_START_JOB_KEYS.has(jobKey)) {
      return res.status(400).json({ error: `Invalid jobKey "${jobKey}" (expected "summary" or "tour")` });
    }

    const db = req.app.get('db');
    const config = req.app.get('config') || {};

    if (jobKey === 'summary' && !getSummaryEnabled(config)) {
      return res.status(409).json({ error: 'Summaries feature is disabled in config' });
    }
    if (jobKey === 'tour' && !getTourEnabled(config)) {
      return res.status(409).json({ error: 'Tours feature is disabled in config' });
    }

    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);
    if (!review) {
      return res.status(404).json({ error: `Local review #${reviewId} not found` });
    }

    const worktreePath = review.local_path || null;

    // Resolve the diff through the same chain the rest of this file uses, rather
    // than a DB-only read. Reviews created via the analysis-push, council, or MCP
    // paths may have a diff only in the in-memory cache (or nowhere yet), so a
    // DB-only read would falsely report "no-diff" for a review that clearly has
    // changes. Order: (1) in-memory cache, (2) persisted `local_diffs` row,
    // (3) regenerate from the live working tree (scope-aware) and persist.
    let diffText = getLocalReviewDiff(reviewId)?.diff || '';

    if (!diffText) {
      const persistedDiff = await reviewRepo.getLocalDiff(reviewId);
      diffText = persistedDiff?.diff || '';
    }

    if (!diffText && worktreePath) {
      // Regenerate from the current working tree and persist (in-memory + DB) so
      // the next read is fast and durable, and so pre-Fix-B reviews self-heal.
      // Mirrors the council diff block above: on error, log and leave it empty.
      try {
        const { start: scopeStart, end: scopeEnd } = reviewScope(review);
        const hasBranch = includesBranch(scopeStart);

        // Snapshot guard: mirror the HEAD invariant enforced by the refresh-diff
        // handler (see ~line 1702). For a non-branch review, the persisted diff is
        // pinned to `local_head_sha`. If HEAD has since moved, regenerating here
        // would silently re-snapshot the CURRENT worktree onto a row that still
        // claims the OLDER SHA — a data-consistency hole. So we only regenerate
        // when HEAD still matches; otherwise we leave diffText empty and let the
        // `{ started: false, reason: 'no-diff' }` response funnel the user through
        // the established refresh-diff / resolve-head-change flow. Branch-scoped
        // reviews persist across HEAD changes, so they always regenerate.
        let headPinned = true;
        if (!hasBranch && review.local_head_sha) {
          // Lazy require keeps getHeadSha stubbable via vi.spyOn in tests.
          const { getHeadSha } = require('../local-review');
          const currentHeadSha = await getHeadSha(worktreePath);
          if (currentHeadSha !== review.local_head_sha) {
            headPinned = false;
            logger.warn(`Skipping self-heal diff regen for local review ${reviewId} (${jobKey}): HEAD moved on non-branch review (recorded ${review.local_head_sha}, current ${currentHeadSha}) — funneling through resolve-head-change`);
          }
        }

        if (headPinned) {
          const diffResult = await generateScopedDiff(worktreePath, scopeStart, scopeEnd, review.local_base_branch);
          diffText = diffResult.diff || '';
          if (diffText) {
            const digest = await computeScopedDigest(worktreePath, scopeStart, scopeEnd);
            setLocalReviewDiff(reviewId, { diff: diffText, stats: diffResult.stats, digest });
            await reviewRepo.saveLocalDiff(reviewId, { diff: diffText, stats: diffResult.stats, digest });
          }
        }
      } catch (regenError) {
        // A getHeadSha throw (e.g. missing worktree) lands here: leave diffText
        // empty so the no-diff response fires, matching prior behavior.
        logger.warn(`Could not regenerate diff for local review ${reviewId} manual ${jobKey} start: ${regenError.message}`);
      }
    }

    if (!diffText || !worktreePath) {
      return res.json({ started: false, reason: 'no-diff' });
    }

    const activeJobType = typeof backgroundQueue.findActiveJobType === 'function'
      ? backgroundQueue.findActiveJobType(reviewId, jobKey === 'summary' ? 'summaries' : 'tour')
      : null;
    if (activeJobType) {
      return res.json({ started: false, alreadyRunning: true });
    }

    const reviewContext = {
      prTitle: review.name || review.local_head_branch || undefined
    };

    if (jobKey === 'summary') {
      Promise.resolve(summaryGenerator.kickOffSummaryJob({
        db, config, reviewId, diffText, worktreePath, reviewContext, trigger: 'manual'
      })).catch((err) => logger.warn(`Manual hunk summary kickoff failed for review ${reviewId}: ${err.message}`));
    } else {
      Promise.resolve(tourGenerator.kickOffTourJob({
        db, config, reviewId, diffText, worktreePath, reviewContext, trigger: 'manual'
      })).catch((err) => logger.warn(`Manual tour kickoff failed for review ${reviewId}: ${err.message}`));
    }

    return res.json({ started: true, alreadyRunning: false });
  } catch (error) {
    logger.error(`Error starting manual job for local review: ${error.message}`);
    res.status(500).json({ error: 'Failed to start job: ' + error.message });
  }
});

/**
 * POST /api/local/:reviewId/jobs/:jobKey/cancel
 *
 * Local-mode wrapper around the shared cancel handler in reviews.js.
 * The unified `/api/reviews/:reviewId/jobs/:jobKey/cancel` already works
 * for local reviews (both modes share the `reviews` table), but exposing
 * it under both prefixes lets the frontend pick whichever helper matches
 * its current mode without a special case. See `handleJobCancel` in
 * `src/routes/reviews.js` for the canonical implementation.
 */
router.post('/api/local/:reviewId/jobs/:jobKey/cancel', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId, 10);
    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }
    const db = req.app.get('db');
    // Same shape that validateReviewId attaches — we re-derive here because
    // local routes don't pass through that middleware by convention.
    const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [reviewId]);
    if (!review) {
      return res.status(404).json({ error: `Review #${reviewId} not found` });
    }
    req.reviewId = reviewId;
    req.review = review;
    // await (not return) so any rejection from the delegated handler is
    // caught by the outer try/catch — Express 4 does not forward rejected
    // promises from async route handlers.
    await reviewsRouter.handleJobCancel(req, res);
  } catch (error) {
    logger.error(`Error cancelling background job for local review: ${error.message}`);
    res.status(500).json({ error: 'Failed to cancel background job' });
  }
});

module.exports = router;
