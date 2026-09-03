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
 * - Submit the review to the associated GitHub PR (Phase 5)
 */

const express = require('express');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { query, queryOne, run, ReviewRepository, RepoSettingsRepository, AnalysisRunRepository, CouncilRepository, PRMetadataRepository } = require('../database');
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
const { generateScopedDiff, computeScopedDigest, getBranchCommitCount, getFirstCommitSubject, detectAndBuildBranchInfo, detectPRForBranch, findMergeBase, getCurrentBranch, getRepositoryName, getUntrackedFiles } = localReview;
// `resolveRepositoryBinding` / `resolveAssociationBinding` live beside
// `fetchPRMetadata` so the WRITE and READ sides share ONE host resolver — see
// the `resolveRepositoryBinding` docblock in src/providers/pr-context.js.
const {
  getAssociatedPR,
  buildCapabilities,
  getCachedPRMetadata,
  fetchPRMetadata,
  isUsablePRTarget,
  splitRepository,
  resolveFetchCredential,
  resolveRepositoryBinding,
  resolveAssociationBinding,
  _hostBindingInternals,
} = require('../providers/pr-context');
// Phase 3: the PR-head half of the staleness check, shared with routes/pr.js.
// READ-ONLY — never writes `pr_metadata`; see that module's docblock.
const { buildStaleReasons, checkPRHeadState } = require('../providers/stale-check');
// Phase 4: the pending-draft reconciliation shared with PR mode's
// `GET /api/pr/:owner/:repo/:number/github-drafts`.
const { syncPendingDraft, serializePendingDraft } = require('../providers/draft-sync');
// Phase 5: the review WRITE shared with PR mode's
// `POST /api/pr/:owner/:repo/:number/submit-review`. `checkSubmitPreconditions`
// is local-mode only — PR mode has no local HEAD to drift from.
const { submitReview, checkSubmitPreconditions, SubmitReviewError, SUBMIT_EVENTS } = require('../providers/review-submit');
// Phase 5: ONE definition of "the pull request's diff" for both modes — the
// line/file-level decision for every submitted comment is read from it.
const { GitWorktreeManager } = require('../git/worktree');
const { resolveBindingRepositoryForHost } = require('../utils/host-resolution');
const { resolveHostName } = require('../links/repo-links');
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
  finalizeConsolidationLevel,
  parseEnabledLevels,
  registerProcess: registerProcessForCancellation
} = require('./shared');

/**
 * Per-process negative cache for background PR-association detection.
 *
 * Keyed by `${repository}:${branch}`. When detectPRForBranch returns no
 * PR for a branch we record the timestamp here so subsequent GETs on the
 * same metadata endpoint don't re-hit GitHub for five minutes. The Map
 * stays small in practice because keys are repo+branch — the only way
 * to grow it is to view many different local reviews.
 *
 * Successful associations bypass this cache entirely: once a row has
 * associated_pr_number set, the background block doesn't fire at all.
 */
const PR_DETECTION_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const prDetectionNegativeCache = new Map();

function prDetectionCacheKey(repository, branch) {
  return `${repository}:${branch}`;
}

function isPRDetectionRecentlyNegative(repository, branch, now = Date.now()) {
  const key = prDetectionCacheKey(repository, branch);
  const ts = prDetectionNegativeCache.get(key);
  if (!ts) return false;
  if (now - ts > PR_DETECTION_NEGATIVE_CACHE_TTL_MS) {
    prDetectionNegativeCache.delete(key);
    return false;
  }
  return true;
}

function recordPRDetectionNegative(repository, branch, now = Date.now()) {
  prDetectionNegativeCache.set(prDetectionCacheKey(repository, branch), now);
}

// Exposed for tests; not part of the public route surface.
function _clearPRDetectionNegativeCache() {
  prDetectionNegativeCache.clear();
}

/**
 * Shared backoff for PR-metadata fetches.
 *
 * TWO endpoints fetch metadata for the same association: the background
 * write-through in `GET /api/local/:reviewId` and the blocking
 * `GET /api/local/:reviewId/pr-metadata`. `fetchPRMetadata` is cache-first,
 * but a FAILURE persists nothing and returns null — so without a shared guard
 * every call re-hits GitHub. That matters most in the case the backoff exists
 * for (revoked token, deleted PR, rate limit), where retrying makes it worse.
 * Both call sites therefore go through these helpers and share one entry.
 *
 * The key is namespaced `pr#<number>` so a branch literally named like a PR
 * number cannot collide with the branch-detection entries in the same Map.
 */
function prMetadataNegativeKey(association) {
  return `pr#${association.prNumber}`;
}

function isPRMetadataRecentlyNegative(association) {
  if (!association) return false;
  return isPRDetectionRecentlyNegative(association.repository, prMetadataNegativeKey(association));
}

function recordPRMetadataNegative(association) {
  if (!association) return;
  recordPRDetectionNegative(association.repository, prMetadataNegativeKey(association));
}


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
      rejectUrlLikeLocalReviewPath(inputPath, req.app.get('config'));
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

    // Branch detection: when no uncommitted changes, check if branch has commits ahead.
    // When a PR is discovered, detectAndBuildBranchInfo persists associated_pr_number +
    // associated_pr_repository to the reviews row via reviewRepo. Same call shape used
    // by the CLI entry path in handleLocalReview (src/local-review.js) — keep them in sync.
    //
    // A WRITE side: must resolve the host through `resolveRepositoryBinding`,
    // never a raw `resolveHostBinding` — see "THE ONE RESOLVER FOR BOTH SIDES"
    // on that function (src/providers/pr-context.js).
    const branchBinding = repository
      ? resolveRepositoryBinding(repository, config, { localPath: repoPath })
      : null;
    const branchInfo = await detectAndBuildBranchInfo(repoPath, branch, {
      repository,
      diff,
      githubToken: branchBinding?.token || getGitHubToken(config),
      hostBinding: branchBinding,
      enableGraphite: config.enable_graphite === true,
      reviewRepo,
      reviewId: sessionId
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
 * Resolve the repository identity + current branch for a local review.
 *
 * The stored `repository` is not always in `owner/repo` form (CLI sessions can
 * seed a bare directory name). Read-only: a GET never writes the refreshed
 * values back.
 *
 * Shared by `GET /api/local/:reviewId` and `/pr-metadata`: the env-var
 * fallback and the `includes('/')` guard are exactly the inputs
 * `canDetectPRAssociation` gates on, so the two endpoints must not be free to
 * disagree about them.
 *
 * Calls through the `localReview` module NAMESPACE so `vi.spyOn(localReview,
 * ...)` is observed — same reason as `generateScopedDiff` in the diff route.
 *
 * @param {Object} review - Row from `getLocalReviewById`
 * @returns {Promise<{repositoryName: string|null, branchName: string}>}
 */
async function resolveReviewRepoAndBranch(review) {
  let repositoryName = review.repository;
  let branchName = 'unknown';

  if (review.local_path) {
    try {
      // Always fetch current branch from the working directory
      branchName = await localReview.getCurrentBranch(review.local_path);

      if (repositoryName && !repositoryName.includes('/')) {
        const freshRepoName = await localReview.getRepositoryName(review.local_path);
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

  return { repositoryName, branchName };
}

/**
 * Is branch → PR association detection worth attempting for this review?
 *
 * Pure predicate over already-resolved inputs, deliberately cheap: it is
 * checked BEFORE any host-binding resolution because that step can shell out
 * to a `token_command` (execSync, 5s timeout), and an already-associated
 * review must never pay that cost.
 *
 * `force` (the explicit `?refresh=1`) bypasses ONLY the negative cache — never
 * the structural checks, which describe reviews with nothing to detect. Without
 * the bypass, one probe that lost to a rate limit parked a five-minute negative
 * that every later call honoured, the External refresh button included, leaving
 * the user no in-page way to recover.
 *
 * @param {{review: Object, repositoryName: ?string, branchName: string,
 *   force?: boolean}} params - `review` is a row from `getLocalReviewById`;
 *   `force` is the explicit user refresh.
 * @returns {boolean}
 */
function canDetectPRAssociation({ review, repositoryName, branchName, force = false }) {
  return Boolean(
    !review.associated_pr_number
    && review.local_path
    && branchName && branchName !== 'HEAD' && branchName !== 'unknown'
    && repositoryName && repositoryName.includes('/')
    && (force || !isPRDetectionRecentlyNegative(repositoryName, branchName))
  );
}

/**
 * In-flight PR-detection probes, keyed `${repository}\u0000${branch}`.
 *
 * A first page load runs detection TWICE for the same (repo, branch): the main
 * GET fires it and forgets it after `res.json`, and the client's follow-up
 * `/pr-metadata` awaits its own. Neither has recorded a negative yet when the
 * other starts, so both pass `canDetectPRAssociation` and both hit GitHub —
 * which is how a rate-limited probe ends up parking the negative that `force`
 * above exists to escape. A concurrent caller now JOINS the running probe. The
 * entry is deleted in a `finally` so a rejection cannot poison the key.
 *
 * Keyed on (repository, branch) only — matching the negative cache — so two
 * reviews of the same branch in DIFFERENT checkouts share one probe. The
 * joiner's own row is not written (the probe persists to the initiator's
 * reviewId), which is the safe direction: it can never inherit an association
 * resolved against another checkout's host. Its next load simply detects
 * again, since the map is empty by then.
 */
const inFlightPRDetections = new Map();


/**
 * Run branch → PR association detection for a local review. Never throws.
 *
 * ONE construction of the detection arguments, TWO callers with opposite
 * scheduling:
 *
 *   - `GET /api/local/:reviewId` fires it and forgets it, AFTER `res.json`,
 *     so the page-load path never waits on GitHub.
 *   - `GET /api/local/:reviewId/pr-metadata` AWAITS it — see that endpoint's
 *     header for the dirty-tree deadlock that makes it necessary.
 *
 * Guards live in `canDetectPRAssociation` (negative cache, `force`) and
 * `inFlightPRDetections` (probe de-duplication).
 *
 * A WRITE side: resolves through `resolveRepositoryBinding`, threading
 * `localPath` so a DUAL repo binds the host its checkout points at — see "THE
 * ONE RESOLVER FOR BOTH SIDES" on that function (providers/pr-context.js).
 *
 * Race guard: `associatePR()` (inside `detectPRForBranch`) updates only WHERE
 * `associated_pr_number IS NULL`, so a concurrent write is never clobbered,
 * and a row deleted meanwhile simply matches 0 rows.
 *
 * @param {Object} params - `review`, `reviewId`, `repositoryName`,
 *   `branchName`, `config` (already resolved), `reviewRepo`, and `force`
 *   (explicit user refresh). `resolvedToken` is the GLOBAL token from
 *   `req.app.get('githubToken')` — never re-resolve via `getGitHubToken` here.
 * @returns {Promise<Object|null>} detection result, or null
 */
async function runPRAssociationDetection({ review, reviewId, repositoryName, branchName, config, resolvedToken, reviewRepo, force = false }) {
  if (!canDetectPRAssociation({ review, repositoryName, branchName, force })) return null;

  // Join a probe already running for this (repo, branch) rather than opening a
  // second one — see `inFlightPRDetections`. A forced refresh joins too: the
  // in-flight probe IS a live answer, so re-asking GitHub would buy nothing.
  const inFlightKey = prDetectionCacheKey(repositoryName, branchName);
  const running = inFlightPRDetections.get(inFlightKey);
  if (running) return running;

  const probe = (async () => {
    // Resolved INSIDE the guard, never above it — see `canDetectPRAssociation`.
    const detectionBinding = resolveRepositoryBinding(repositoryName, config, { localPath: review.local_path });
    const detectionToken = detectionBinding?.token || resolvedToken;
    if (!detectionToken) return null;

    try {
      const detection = await detectPRForBranch(review.local_path, branchName, {
        repository: repositoryName,
        githubToken: detectionToken,
        hostBinding: detectionBinding,
        enableGraphite: config.enable_graphite === true,
        reviewRepo,
        reviewId
      });
      if (!detection || !detection.prNumber) {
        recordPRDetectionNegative(repositoryName, branchName);
      }
      return detection;
    } catch (err) {
      logger.warn(`PR association detection failed for review #${reviewId}: ${err.message}`);
      return null;
    }
  })();

  // Registered before the first await point of any joiner.
  inFlightPRDetections.set(inFlightKey, probe);
  try {
    return await probe;
  } finally {
    inFlightPRDetections.delete(inFlightKey);
  }
}

/**
 * Resolve the host binding a GitHub call for THIS review would use, and the
 * `hasGitHubToken` capability that goes with it. One rule, both endpoints
 * (`GET /api/local/:reviewId` and `/pr-metadata`), so the flag can never
 * disagree between them.
 *
 * With an association, the binding is the ASSOCIATION's repository — which may
 * differ from the review's own (a fork, a monorepo `url_pattern` entry).
 *
 * WITHOUT one, it is the review's OWN repository, not the bare global token.
 * `app.get('githubToken')` ignores `repos[...].token` / `token_command`
 * entirely, so a user whose only credential is repo-scoped was told
 * `hasGitHubToken: false` — and `_maybeWarmPRMetadata` returns early on that
 * flag, so it never called `/pr-metadata`, the one endpoint that can CREATE
 * the association on a dirty tree.
 *
 * `resolveFetchCredential` is the arbiter in both cases, never
 * `binding.token || globalToken` — see its docblock in pr-context.js.
 *
 * @param {Object} params - `association`, `repositoryName` (the review's own),
 *   `config` (already resolved), `localPath` (the review's checkout), and
 *   `resolvedToken` (the GLOBAL token from `app.get('githubToken')`).
 * @param {string|null} [params.host] - An api_host the caller already KNOWS
 *   (`null` = github.com), read off the `pr_metadata` stamp via
 *   `resolveAssociationHost`. Replaces the dual-host guess, so the binding
 *   comes back definite instead of `hostAmbiguous`.
 * @param {boolean} [params.cachedTokensOnly=false] - Never shell out for a
 *   `token_command`; answer from config.js's process-lifetime token cache or
 *   report no credential. For request paths that must stay inside a client
 *   timeout — `execSync` blocks the event loop for up to 5s and no
 *   `Promise.race` can preempt a synchronous block. The two endpoints that
 *   OWN the `hasGitHubToken` capability must NOT pass it: they are what warms
 *   the cache, and a cache-only miss there would report "no GitHub" for a
 *   credential that resolves fine.
 * @returns {{binding: Object|null, hasToken: boolean}}
 */
function resolveReviewCredential({
  association, repositoryName, config, localPath, resolvedToken, cachedTokensOnly = false, host = undefined
}) {
  const options = { localPath, cachedTokensOnly, host };
  const binding = association
    ? resolveAssociationBinding(association, config, options)
    : resolveRepositoryBinding(repositoryName, config, options);
  return { binding, hasToken: Boolean(resolveFetchCredential(binding, resolvedToken)) };
}

/**
 * Answer "which host does the association's PR live on, and do we KNOW?".
 *
 * Two tiers, the same pair `executeSync` uses in
 * src/routes/external-comments.js — asking the wrong host for "PR #N" answers
 * about a DIFFERENT pull request that merely shares a number, so a guess is a
 * hard refusal everywhere:
 *
 *   Tier 1 — the resolved binding. Anything that is not an explicit
 *   `hostAmbiguous` guess (including a null binding: a plain github.com repo
 *   with no `repos` entry) is definite, and costs no query.
 *
 *   Tier 2 — `pr_metadata.host`, the stamp written by whoever last fetched
 *   this PR. `getPRHost` distinguishes "no row" (`undefined`) from "row with
 *   NULL host" (an explicit github.com stamp), so ANY stored value settles the
 *   question. Routine once the same PR has been opened in PR mode.
 *
 * ONE definition because the capability the client reads (`canSyncDrafts`)
 * and the endpoint gate that can 409 must never disagree: a looser capability
 * advertises a button whose every click errors, and a looser gate contacts a
 * guessed host.
 *
 * @param {Object} params
 * @param {{prNumber: number, repository: string}|null} params.association
 * @param {Object|null} params.binding - Already-resolved host binding
 * @param {Object} params.db
 * @returns {Promise<{known: boolean, host: string|null|undefined}>} `host` is
 *   the stamped api_host when tier 2 answered (`null` = github.com), and
 *   `undefined` when the binding alone settled it — pass it straight back to
 *   `resolveReviewCredential`.
 */
async function resolveAssociationHost({ association, binding, db }) {
  if (!association) return { known: false, host: undefined };
  if (!binding || !binding.hostAmbiguous) return { known: true, host: undefined };

  try {
    const storedHost = await new PRMetadataRepository(db).getPRHost(
      association.repository, association.prNumber
    );
    if (storedHost === undefined) return { known: false, host: undefined };
    return { known: true, host: storedHost };
  } catch (err) {
    logger.warn(`Stored-host lookup failed for ${association.repository}#${association.prNumber}: ${err.message}`);
    return { known: false, host: undefined };
  }
}

/**
 * THE credential a GitHub call for this review's association is actually made
 * with — resolved AFTER the host question is settled, not before it.
 *
 * `resolveReviewCredential` and `resolveAssociationHost` were called in that
 * order at three sites, and each site then used the PRE-stamp binding: the
 * capability the client reads, the metadata fetch, and the draft sync could
 * all disagree about which host (and therefore which token) is in play. On a
 * dual-host repo that is not cosmetic:
 *
 *   - a global github.com token plus a token-less alt-host binding advertised
 *     a `canSyncDrafts` button whose every request 401s;
 *   - an alt-host repo token with no global token HID working functionality;
 *   - and a `pr_metadata` stamp naming a host that config no longer describes
 *     (renamed `api_host`, deleted `repos` entry) resolved to `null` through
 *     `tryResolveHostBinding`'s swallowing catch, which `resolveFetchCredential`
 *     then read as "no binding, use the global token" — i.e. api.github.com,
 *     for a PR the route had just proved lives somewhere else. A same-named
 *     github.com repo answers about a DIFFERENT PR #N, and the draft sync
 *     mutates local rows on the strength of it. Explicit-host resolution must
 *     FAIL CLOSED, exactly as the sibling PR and external-comment paths do.
 *
 * @param {Object} params - As `resolveReviewCredential`, plus `db` for the
 *   `pr_metadata` host stamp.
 * @returns {Promise<{binding: Object|null, hasToken: boolean, hostResolved: boolean, host: string|null|undefined, hostBindingFailed: boolean}>}
 *   `hostBindingFailed` is the fail-closed signal: a host we KNOW could not be
 *   bound to a configuration, so no GitHub call may be made for this review —
 *   `binding` is null and `hasToken` false to keep every capability honest.
 */
async function resolveAssociationCredential({
  association, repositoryName, config, localPath, resolvedToken, db, cachedTokensOnly = false
}) {
  const guess = resolveReviewCredential({
    association, repositoryName, config, localPath, resolvedToken, cachedTokensOnly
  });
  const { known, host } = await resolveAssociationHost({ association, binding: guess.binding, db });

  // `host === undefined` means the binding itself settled the question (tier
  // 1, or no association at all) — there is nothing to re-resolve against.
  if (host === undefined) {
    return { ...guess, hostResolved: known, host, hostBindingFailed: false };
  }

  const stamped = resolveReviewCredential({
    association, repositoryName, config, localPath, resolvedToken, cachedTokensOnly, host
  });
  if (!stamped.binding) {
    logger.warn(
      `Stored host "${host === null ? 'github.com' : host}" for `
      + `${association.repository}#${association.prNumber} no longer resolves against config; `
      + 'refusing to fall back to github.com'
    );
    return { binding: null, hasToken: false, hostResolved: known, host, hostBindingFailed: true };
  }
  return { ...stamped, hostResolved: known, host, hostBindingFailed: false };
}

/** Read the persisted PR association off a review row, or null. */
function associationFromReview(review) {
  if (!review || !review.associated_pr_number || !review.associated_pr_repository) return null;
  return {
    prNumber: review.associated_pr_number,
    repository: review.associated_pr_repository,
  };
}

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
    const { repositoryName, branchName } = await resolveReviewRepoAndBranch(review);

    // Build scope info for the response.
    // normalizeScope clamps any legacy invalid scopes (e.g. branch-only,
    // staged-only) to always include 'unstaged', since AI models read files
    // from the working tree and the diff must match what they see.
    const { start: scopeStart, end: scopeEnd } = reviewScope(review);
    const baseBranch = review.local_base_branch || null;
    const scopeIncludesBranch = includesBranch(scopeStart);

    // LEFT-side anchor inputs: `mergeBaseSha` (what our diff's left column IS)
    // and `scopeIncludesBranch`, both consumed by `_externalAnchorContext` in
    // public/js/pr.js. They are NOT redundant with each other, and
    // `mergeBaseSha` is null whenever the scope excludes the branch — see that
    // function for why an equal sha alone must not buy left-side trust.
    //
    // This handler generates no diff, so the value is read the cheap way —
    // one `git merge-base`, non-fatal, via the module namespace so tests can
    // stub it. `set-scope`/`refresh` get theirs from `generateScopedDiff`.
    let mergeBaseSha = null;
    if (scopeIncludesBranch && review.local_path && baseBranch) {
      try {
        mergeBaseSha = await localReview.findMergeBase(review.local_path, baseBranch);
      } catch (mergeBaseError) {
        logger.debug(`Could not resolve merge-base for review #${reviewId}: ${mergeBaseError.message}`);
        mergeBaseSha = null;
      }
    }

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

    // Capability flags surfaced to the frontend — the source of truth for
    // gating PR-only features in local mode. Frontend MUST NOT mode-sniff
    // via `window.location.pathname`; it reads `capabilities` only.
    //
    // Token comes from the resolved value the server set on app startup
    // (req.app.get('githubToken')). Never re-resolve via getGitHubToken()
    // here — that would re-run `gh auth token` on every metadata GET.
    const resolvedToken = req.app.get('githubToken') || '';
    const association = associationFromReview(review);

    // Repo-aware credential resolution. `app.get('githubToken')` is the GLOBAL
    // token — it ignores repos[...].token / token_command and knows nothing
    // about alt hosts. Resolve the binding for the association's repository
    // (which may differ from the review's own repository) and let it stand in
    // for the global token everywhere a GitHub call is made for that repo.
    //
    // This runs BEFORE res.json — `hasGitHubToken` ships in that payload — so
    // it is genuinely on the blocking path, and resolveHostBinding may shell
    // out to a token_command. config.js caches only SUCCESSFUL command output,
    // so a broken command would otherwise re-run `execSync` (5s timeout) on
    // every GET; the resolver's own token-less negative memo bounds that to
    // once per 30s, and its git-remote read is memoized per checkout path for
    // the life of the process. (The background base-branch block
    // further down resolves its own binding per request, but that block runs
    // AFTER res.json and blocks nothing.)
    //
    // Goes through resolveReviewCredential so the PR identity is translated
    // into a `repos[...]` key first — a raw owner/repo lookup misses
    // url_pattern-keyed entries. `localPath` is threaded through so a DUAL
    // repo binds the host its checkout names; see that helper's docblock.
    //
    // hasGitHubToken answers "is GitHub reachable for THIS review?" — it gates
    // the frontend's cold-cache warm-up call, so a repo-scoped or alt-host
    // credential has to count even when no global token is configured.
    // Otherwise exactly the alt-host users this binding fix targets would
    // never trigger the fetch that makes their pill appear.
    //
    // Resolved through `resolveAssociationCredential`, which settles the HOST
    // first and re-resolves the binding for it: the capability shipped below
    // and the background metadata fetch further down must both be the
    // credential a real call would use, not the pre-stamp guess.
    const {
      binding: associationBinding,
      hasToken,
      hostResolved,
      hostBindingFailed
    } = await resolveAssociationCredential({
      association,
      repositoryName,
      config: localConfig,
      localPath: review.local_path,
      resolvedToken,
      db
    });

    // Phase 1: read PR metadata from cache only. Never block this response on
    // a GitHub round-trip — it is the page-load path.
    //
    // A cache miss kicks off a background write-through (further down). There
    // is NO poll on this endpoint, so that write alone would leave the badge
    // invisible until a full page reload; the client closes the gap by calling
    // GET /api/local/:reviewId/pr-metadata, which does block.
    let prMetadata = null;
    if (association) {
      try {
        prMetadata = await getCachedPRMetadata({
          prNumber: association.prNumber,
          repository: association.repository,
          db
        });
      } catch (err) {
        logger.warn(`getCachedPRMetadata failed for review #${reviewId}: ${err.message}`);
      }
    }
    // `hostResolved` came back with the credential above: one indexed
    // `pr_metadata` read, and only when the binding was an ambiguous guess —
    // see `resolveAssociationHost`. `canSyncDrafts` gates on it because the
    // sync endpoint refuses a guessed host with 409.
    const capabilities = buildCapabilities({
      association,
      hasToken,
      prMetadataAvailable: Boolean(prMetadata),
      hostResolved
    });

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
      scopeIncludesBranch,
      baseBranch,
      mergeBaseSha,
      branchInfo,
      branchAvailable,
      stackData,
      shaAbbrevLength,
      capabilities,
      associatedPR: association
        ? {
            prNumber: association.prNumber,
            repository: association.repository,
            ...(prMetadata || {})
          }
        : null,
      createdAt: review.created_at,
      updatedAt: review.updated_at
    });

    // Phase 1: background metadata refresh on cache miss. We have an
    // association and a credential but no cached metadata — fetch once so the
    // next /api/local/:reviewId GET (or the /pr-metadata endpoint the header
    // calls) surfaces title/author/url to the UI. Errors are swallowed
    // (logged in the provider); fetchPRMetadata writes through to pr_metadata.
    //
    // Goes through the resolved binding, NOT the bare global token — see
    // resolveRepositoryBinding. Negative cache: a PR that keeps failing (token
    // revoked after the association was persisted, PR deleted, GitHub outage,
    // rate limit) would otherwise re-hit GitHub on every page load. The entry
    // is SHARED with the blocking /pr-metadata endpoint via
    // isPRMetadataRecentlyNegative — that path now does most of the fetching,
    // so guarding only here would leave the backoff unenforced. No clearing on
    // success is needed: once metadata is cached the `!prMetadata` guard
    // short-circuits before the negative check is consulted.
    // `hasToken` IS the association's credential here — the guard's own
    // `association &&` is what makes that equivalence hold.
    // `hostBindingFailed` is redundant with `hasToken` today (the resolver
    // zeroes both) and named anyway: this is the call that would otherwise be
    // made against api.github.com for a PR proven to live elsewhere.
    if (association && hasToken && !hostBindingFailed && !prMetadata
        && !isPRMetadataRecentlyNegative(association)) {
      (async () => {
        try {
          const fetched = await fetchPRMetadata({
            prNumber: association.prNumber,
            repository: association.repository,
            githubToken: resolvedToken,
            hostBinding: associationBinding,
            db
          });
          if (!fetched) {
            recordPRMetadataNegative(association);
          }
        } catch (err) {
          recordPRMetadataNegative(association);
          logger.warn(`Background PR metadata fetch failed for review #${reviewId}: ${err.message}`);
        }
      })();
    }

    // Soft migration: when this local review has no persisted PR association
    // but could plausibly have one (owner/repo set, branch known), kick off a
    // background detection. Uses `detectPRForBranch` directly — NOT
    // detectAndBuildBranchInfo — because PR association is independent of
    // working-tree state. The scope-suggestion guards on
    // detectAndBuildBranchInfo (which short-circuit on uncommitted changes
    // or untracked files) would suppress association for most real working
    // trees and silently keep capabilities hidden.
    //
    // Credentials come from the binding resolved for this repository, with the
    // server-resolved global token as the fallback — never re-resolve via
    // getGitHubToken. Passing `hostBinding` is what routes an alt-host repo at
    // its api_host: `tryGitHubPR` prefers the binding over the bare token
    // (src/git/base-branch.js:148-153), and a bare token is normalised into a
    // github.com binding. On a DUAL repo that matters for correctness, not just
    // reachability — branch names are mirrored across both hosts, so a
    // github.com lookup can find a DIFFERENT PR and persist it as the
    // association.
    //
    // Same identity → binding-key → binding order as the association above,
    // via the SHARED `resolveRepositoryBinding`: a raw `resolveHostBinding`
    // on the repository identity misses a `url_pattern`-keyed monorepo entry
    // and degrades to github.com with the global token, and this is the path
    // that WRITES a PR number permanently onto the review row.
    //
    // Negative cache: if a recent run for this (repo, branch) returned no PR,
    // skip until the TTL expires. Successful associations don't reach this
    // block at all (the `!review.associated_pr_number` guard short-circuits).
    //
    // Race guard: associatePR() updates only WHERE associated_pr_number IS
    // NULL, so a concurrent write won't be clobbered. If the row was deleted
    // between res.json and the background write, the UPDATE matches 0 rows.
    //
    // Fire-and-forget, NOT awaited: the response is already flushed. The
    // awaited twin — where a client that rendered with `hasAssociatedPR: false`
    // gets it back — is in `/pr-metadata`; see `runPRAssociationDetection`.
    runPRAssociationDetection({
      review,
      reviewId,
      repositoryName,
      branchName,
      config: req.app.get('config') || {},
      resolvedToken,
      reviewRepo
    }).catch(err => {
      logger.warn(`Background PR association detection failed for review #${reviewId}: ${err.message}`);
    });

    // Background: pre-cache base branch detection so set-scope is fast later
    if (!includesBranch(scopeStart) && !review.local_base_branch
        && branchName && branchName !== 'HEAD' && branchName !== 'unknown'
        && repositoryName && repositoryName.includes('/')) {
      const bgConfig = req.app.get('config') || {};
      // Shared resolver: base-branch detection reaches GitHub too
      // (`tryGitHubPR`), so it must bind the same host as the rest of the
      // review. May be null — the `_deps` block below is already token-gated.
      const bgBinding = resolveRepositoryBinding(repositoryName, bgConfig, { localPath: review.local_path });
      const bgToken = bgBinding?.token;
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
 * GET /api/local/:reviewId/pr-metadata[?refresh=1]
 *
 * The capability-recovery endpoint. Blocking counterpart to the cache-only
 * read in `GET /api/local/:reviewId`, which must never block on a GitHub
 * round-trip — it is the page-load path — so on a cold cache it returns
 * `canShowPRMetadata: false` and warms the cache in the background. Nothing
 * re-renders the header afterwards (there is no poll, and `refreshDiff` only
 * touches diff/stats), so without this endpoint the pill would not appear
 * until a full page reload.
 *
 * It recovers TWO kinds of not-yet-known:
 *
 * 1. ASSOCIATION (the dirty-tree case). Neither entry point populates
 *    `associated_pr_*` in the common case — `detectAndBuildBranchInfo` returns
 *    null the moment there is a diff, and the CLI's `detectPRForBranch`
 *    fallback only fires for a branch-inclusive scope, so the default
 *    `unstaged..untracked` scope on a dirty tree gets neither. The main GET's
 *    background backfill runs AFTER `res.json`, so the client has already
 *    rendered with `hasAssociatedPR: false`. Detection therefore runs HERE,
 *    awaited, and the row is re-read before capabilities are built.
 *    Deliberately NOT done in the main GET: that would put a GitHub round
 *    trip on the first render of every local review.
 *
 * 2. METADATA, including a STALE row. `pr_metadata` has no TTL (by design —
 *    see `fetchPRMetadata`), so after the local HEAD moves the cached PR head
 *    can be out of date and the frontend's anchor-trust check fails closed
 *    permanently. `?refresh=1` forces a re-fetch.
 *
 * `?refresh=1` bypasses BOTH negative backoffs (see `canDetectPRAssociation`),
 * but no refusal: the `hostAmbiguous` gate in `fetchPRMetadata` still stands.
 *
 * Returns the same `capabilities` + `associatedPR` shapes as the main GET so
 * the client can merge them into its existing state — including when the
 * fetch fails or is suppressed by the shared negative cache, in which case
 * `canShowPRMetadata` is simply false. Never 500s on an unreachable PR.
 */
router.get('/api/local/:reviewId/pr-metadata', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }

    const db = req.app.get('db');
    const config = req.app.get('config') || {};
    const reviewRepo = new ReviewRepository(db);
    let review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({ error: `Local review #${reviewId} not found` });
    }

    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const resolvedToken = req.app.get('githubToken') || '';
    let association = associationFromReview(review);

    // Recovery leg 1 — see the header. Awaited on purpose; the negative cache
    // inside bounds the cost, and `force` carries `?refresh=1` all the way
    // into detection rather than stopping at the metadata backoff below.
    let reviewRepositoryName = review.repository || null;
    if (!association) {
      const { repositoryName, branchName } = await resolveReviewRepoAndBranch(review);
      reviewRepositoryName = repositoryName;
      await runPRAssociationDetection({
        review,
        reviewId,
        repositoryName,
        branchName,
        config,
        resolvedToken,
        reviewRepo,
        force: forceRefresh
      });
      // Re-read rather than trusting the detection's return value: the write
      // is guarded (`WHERE associated_pr_number IS NULL`), so the row is the
      // only authority on what actually landed — and a concurrent backfill may
      // have won the race with a perfectly good association.
      const refreshed = await reviewRepo.getLocalReviewById(reviewId);
      if (refreshed) {
        review = refreshed;
        association = associationFromReview(review);
      }
    }

    // Resolved AFTER the recovery above: both are functions of the association
    // it may have just created. Same helper as the main GET, so the capability
    // cannot disagree between the two endpoints.
    const { binding, hasToken, hostResolved, hostBindingFailed } = await resolveAssociationCredential({
      association,
      repositoryName: reviewRepositoryName,
      config,
      localPath: review.local_path,
      resolvedToken,
      db
    });

    if (!association) {
      return res.json({
        capabilities: buildCapabilities({ association: null, hasToken, prMetadataAvailable: false }),
        associatedPR: null
      });
    }

    // Cache-first inside fetchPRMetadata: a warm row short-circuits before any
    // GitHub call, so a redundant client request is cheap. Failures resolve to
    // null (logged in the provider) rather than throwing — the pill simply
    // stays hidden.
    //
    // But a failure caches NOTHING, so cache-first does not bound a failing
    // PR: this endpoint is directly callable in a loop, and rate-limit
    // exhaustion is the case where retrying hurts most. Share the background
    // path's backoff — while it is hot, answer from the cache (which may have
    // been filled by some other path since) and never call GitHub. Still a
    // well-formed 200: the contract is "the pill simply stays hidden".
    //
    // An EXPLICIT refresh overrides both: the cached row is the suspect, so it
    // skips the cache-first short-circuit and bypasses the backoff.
    //
    // `hostBindingFailed` is the third way out: the PR's stored host no longer
    // resolves, so `binding` is null and fetching would target api.github.com
    // with the global token — a same-named github.com repo would cache a
    // DIFFERENT PR's title/author/url under this row. Answer from the cache.
    let prMetadata;
    if (hostBindingFailed || (!forceRefresh && isPRMetadataRecentlyNegative(association))) {
      prMetadata = await getCachedPRMetadata({
        prNumber: association.prNumber,
        repository: association.repository,
        db
      });
    } else {
      prMetadata = await fetchPRMetadata({
        prNumber: association.prNumber,
        repository: association.repository,
        githubToken: resolvedToken,
        hostBinding: binding,
        forceRefresh,
        db
      });
      if (!prMetadata) recordPRMetadataNegative(association);
    }

    // `hostResolved` came back with the credential above — the same two-tier
    // host answer as the page-load GET, so the capability cannot disagree
    // between the two endpoints that ship it.
    res.json({
      capabilities: buildCapabilities({
        association,
        hasToken,
        prMetadataAvailable: Boolean(prMetadata),
        hostResolved
      }),
      associatedPR: {
        prNumber: association.prNumber,
        repository: association.repository,
        ...(prMetadata || {})
      }
    });
  } catch (error) {
    logger.error('Error fetching local PR metadata:', error.stack || error.message);
    res.status(500).json({ error: 'Failed to fetch PR metadata' });
  }
});

/**
 * Phase 4 — pull the pending draft review the user started in the GitHub UI
 * into this local session's `github_reviews` mirror.
 *
 * POST, not GET: this endpoint WRITES (it reconciles mirror rows and can
 * transition an old pending row to submitted/dismissed) and it always hits
 * GitHub. PR mode's twin (`GET .../github-drafts`) is a GET for historical
 * reasons; both share `syncPendingDraft`, so their bodies cannot drift.
 *
 * Deliberately NOT called from `GET /api/local/:reviewId`. That handler is the
 * page-load path and must never block on a GitHub round-trip — the client
 * drives this one itself once `canSyncDrafts` says the backend can answer.
 *
 * Status ladder, in the order the checks run:
 *   400 malformed review id
 *   404 no such local review
 *   403 no usable PR association — `canSyncDrafts` requires one, so a 403 here
 *       means the association was cleared (or never resolved) since the page
 *       loaded
 *   409 dual-host repository whose PR host is genuinely UNKNOWN — neither the
 *       checkout's remote nor a stored `pr_metadata.host` stamp settles it.
 *       Same two-tier answer the external-comment sync uses (a stamped host
 *       short-circuits the ambiguity check), routed through
 *       `resolveAssociationHost` so the 409 and the `canSyncDrafts` capability
 *       that gates the client's button cannot disagree. Asking the wrong host
 *       for "my pending review on PR #N" would answer about a DIFFERENT PR
 *       that merely shares a number — and, the second 409, a stored host that
 *       config no longer describes (renamed `api_host`, deleted `repos`
 *       entry). Explicit-host resolution fails CLOSED: silently binding
 *       github.com there is the same wrong-PR bug with a stale stamp instead
 *       of a guess
 *   401 no credential for this repository
 *   200 `{ pendingDraft, allGithubReviews, syncSucceeded }` — a GitHub failure
 *       inside the provider still lands here, with the local mirror unchanged
 *       and `syncSucceeded: false` saying so. A DATABASE failure does not: it
 *       reaches the 500 below rather than being reported as a GitHub outage
 */
router.post('/api/local/:reviewId/sync-drafts', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }

    const db = req.app.get('db');
    const config = req.app.get('config') || {};
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({ error: `Local review #${reviewId} not found` });
    }

    const association = associationFromReview(review);
    // `isUsablePRTarget`, not a truthiness test — it is the same predicate
    // `buildCapabilities` uses for `hasAssociatedPR`, so the gate here and the
    // capability the client read cannot disagree.
    if (!isUsablePRTarget(association)) {
      return res.status(403).json({
        error: 'This local review has no associated pull request'
      });
    }
    const parts = splitRepository(association.repository);

    const resolvedToken = req.app.get('githubToken') || '';
    // Same resolver as every other GitHub call this review makes — see
    // "THE ONE RESOLVER FOR BOTH SIDES" in providers/pr-context.js. NOT
    // `cachedTokensOnly`: this is a user-initiated action with no client
    // deadline, so a `token_command` may legitimately be run.
    // Settles the host FIRST and re-resolves the binding for it, so the
    // credential below is the one a real call uses — the same resolver the two
    // capability endpoints go through, which is what keeps the button the
    // client rendered and the gate here from disagreeing.
    const { binding: hostBinding, hostResolved: hostKnown, host: storedHost, hostBindingFailed } =
      await resolveAssociationCredential({
        association,
        repositoryName: review.repository,
        config,
        localPath: review.local_path,
        resolvedToken,
        db
      });
    if (!hostKnown) {
      return res.status(409).json({
        error: `Cannot determine which host PR #${association.prNumber} of dual-host repository `
          + `"${association.repository}" lives on; refusing to sync drafts against a guessed host`
      });
    }
    if (hostBindingFailed) {
      // The stored host is KNOWN and no longer resolves against config — a
      // renamed `api_host`, a deleted `repos` entry. Falling back to the
      // global token would ask api.github.com about a PR proven to live
      // elsewhere, and a same-named github.com repo answers about a DIFFERENT
      // PR #N whose drafts would then be reconciled into these rows.
      return res.status(409).json({
        error: `The stored host for PR #${association.prNumber} of `
          + `"${association.repository}" (${storedHost === null ? 'github.com' : storedHost}) `
          + 'no longer matches your configuration; refusing to sync drafts against github.com'
      });
    }

    const credential = resolveFetchCredential(hostBinding, resolvedToken);
    if (!credential) {
      return res.status(401).json({
        error: `No GitHub credential configured for ${association.repository}`
      });
    }

    const { pendingDraft, allGithubReviews, syncSucceeded } = await syncPendingDraft({
      db,
      reviewId: review.id,
      owner: parts.owner,
      repo: parts.repo,
      prNumber: association.prNumber,
      credential
    });

    res.json({
      pendingDraft: serializePendingDraft(pendingDraft),
      allGithubReviews,
      // "GitHub says you have no draft" and "we could not ask GitHub" are both
      // `pendingDraft: null`. Only the first may clear a rendered indicator —
      // see `_syncGitHubDrafts` in public/js/local.js.
      syncSucceeded
    });
  } catch (error) {
    logger.error('Error syncing GitHub drafts for local review:', error.stack || error.message);
    res.status(500).json({ error: 'Failed to sync GitHub drafts' });
  }
});

/**
 * Phase 5 — submit this local review to the GitHub pull request its branch is
 * associated with.
 *
 * The one endpoint in local mode that WRITES to GitHub. The write itself is
 * `submitReview` in src/providers/review-submit.js, shared verbatim with
 * `POST /api/pr/:owner/:repo/:number/submit-review`; everything here is the
 * question PR mode never has to ask — may we write to this PR, from THIS
 * checkout, right now?
 *
 * FOUR THINGS THIS HANDLER OWNS
 * -----------------------------
 * 1. HOST + CREDENTIAL, through `resolveAssociationCredential` — the same
 *    resolver, in the same order, as the two capability endpoints and the
 *    draft sync. A guessed host is a hard refusal here as everywhere else: a
 *    same-numbered PR on the other host is a routine coincidence, and this
 *    endpoint POSTS.
 * 2. THE SNAPSHOT the comments were AUTHORED against, through
 *    `evaluateLocalSnapshotDrift` — the same comparison
 *    `GET /api/local/:reviewId/check-stale` reports, read STRICTLY: only a
 *    completed comparison that found no difference may proceed. Local, no
 *    network, and therefore run FIRST; see the ordering note at the call site.
 * 3. PRECONDITIONS, through `checkSubmitPreconditions` — a LIVE read of the
 *    PR. It fails CLOSED, unlike every other PR-side check in local mode:
 *    those inform, this one authorises a write.
 * 4. THE DIFF and which files carry uncommitted edits. Both feed the
 *    line-level vs file-level decision the provider makes per comment. When
 *    either is unavailable the diff is dropped entirely, which degrades every
 *    comment to file level — the same fallback PR mode has always used when it
 *    cannot generate a diff. LEFT-side comments degrade UNCONDITIONALLY in
 *    local mode; the reasoning is recorded at the `trustLeftAnchors: false`
 *    call site.
 *
 * Status ladder, in the order the checks run:
 *   400 malformed review id, or an event outside `SUBMIT_EVENTS`
 *   404 no such local review
 *   403 `no_association` — no usable PR association (`canSubmitToGitHub`
 *       requires one, so a 403 here means it was cleared since the page loaded)
 *   409 `host_ambiguous` — dual-host repository whose PR host is UNKNOWN;
 *       `host_binding_failed` — a stored host config no longer describes.
 *       Identical to the draft-sync gate, and for the same reason
 *   401 `no_credential` — nothing configured for this repository
 *   409 `local_diff_unverified` — the captured snapshot could not be COMPARED
 *       with the tree (no captured diff, no baseline digest, or the tree could
 *       not be walked). Carries `snapshotStatus` for diagnosis; the remedy is
 *       the same for all three, so they share one code
 *   409 `local_diff_stale` — the captured snapshot is not the snapshot on
 *       disk, so every stored line anchor describes a diff that no longer
 *       exists. Both of these are local-only and precede every GitHub call
 *   409 `local_head_unknown` — local HEAD is unreadable, so it cannot be
 *       checked against the PR head
 *   410 `pr_merged` / `pr_closed` — PER EVENT: a settled PR still accepts a
 *       `COMMENT` review, and refuses only APPROVE / REQUEST_CHANGES / DRAFT
 *   409 `head_drift` — local HEAD is not the PR's head commit (decision 1:
 *       hard refuse, no force override)
 *   404 `pr_not_found` — the PR no longer exists
 *   401 `auth_failed` / 403 `insufficient_permissions` / 429 `rate_limited` —
 *       classified by the precondition check, not collapsed into a 502
 *   502 `pr_state_unknown` — GitHub could not be read, so drift is unknown
 *   400 `missing_pr_node_id`, 409 `comments_outside_pr`, 409
 *       `partially_posted` — refusals the PROVIDER decides, thrown as
 *       `SubmitReviewError` and mapped verbatim by the catch below.
 *       `partially_posted` is the one that reports a review GitHub accepted
 *       whose local bookkeeping did not complete
 *   200 the provider's payload, byte-identical to PR mode's
 *
 * Every refusal body carries a `code` alongside `error` so the client can tell
 * a drift refusal (offer to refresh) from a lifecycle one (nothing to do).
 */
router.post('/api/local/:reviewId/submit-review', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }

    const { event, body } = req.body || {};
    if (!SUBMIT_EVENTS.includes(event)) {
      return res.status(400).json({
        error: 'Invalid review event. Must be APPROVE, REQUEST_CHANGES, COMMENT, or DRAFT'
      });
    }

    const db = req.app.get('db');
    const config = req.app.get('config') || {};
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({ error: `Local review #${reviewId} not found` });
    }

    const association = associationFromReview(review);
    // The same predicate `buildCapabilities` uses for `hasAssociatedPR`, so the
    // gate here and the capability that rendered the Submit control cannot
    // disagree.
    if (!isUsablePRTarget(association)) {
      return res.status(403).json({
        error: 'This local review has no associated pull request',
        code: 'no_association'
      });
    }
    const parts = splitRepository(association.repository);

    const resolvedToken = req.app.get('githubToken') || '';
    // Settles the HOST first, then resolves the binding for it — see
    // `resolveAssociationCredential`. NOT `cachedTokensOnly`: a user-initiated
    // write has no client deadline, so a `token_command` may legitimately run.
    const { binding: hostBinding, hostResolved: hostKnown, host: storedHost, hostBindingFailed } =
      await resolveAssociationCredential({
        association,
        repositoryName: review.repository,
        config,
        localPath: review.local_path,
        resolvedToken,
        db
      });
    if (!hostKnown) {
      return res.status(409).json({
        error: `Cannot determine which host PR #${association.prNumber} of dual-host repository `
          + `"${association.repository}" lives on; refusing to submit a review against a guessed host`,
        code: 'host_ambiguous'
      });
    }
    if (hostBindingFailed) {
      // A KNOWN host that no longer resolves against config (renamed
      // `api_host`, deleted `repos` entry). Falling back to the global token
      // would POST this review to a same-named github.com repository.
      return res.status(409).json({
        error: `The stored host for PR #${association.prNumber} of `
          + `"${association.repository}" (${storedHost === null ? 'github.com' : storedHost}) `
          + 'no longer matches your configuration; refusing to submit against github.com',
        code: 'host_binding_failed'
      });
    }

    const credential = resolveFetchCredential(hostBinding, resolvedToken);
    if (!credential) {
      return res.status(401).json({
        error: `No GitHub credential configured for ${association.repository}`,
        code: 'no_credential'
      });
    }

    // The commit this session is rendering. Read fresh, never from
    // `reviews.local_head_sha`: that column is the commit the diff was CAPTURED
    // at, and a commit made since is exactly the drift this check exists to
    // catch.
    let localHeadSha = null;
    if (review.local_path) {
      try {
        localHeadSha = await localReview.getHeadSha(review.local_path);
      } catch (headError) {
        logger.warn(`Could not read local HEAD for review #${reviewId}: ${headError.message}`);
      }
    }

    // ------------------------------------------------------------------
    // THE SNAPSHOT GATE — is the diff these comments were WRITTEN against
    // still the diff on disk?
    //
    // `checkSubmitPreconditions` below compares the LIVE local HEAD with the
    // PR head. That is a different question, and passing it is not evidence
    // for this one: a reviewer who comments, then commits and pushes, ends up
    // with local HEAD equal to the PR head again — the PR-side check sees a
    // perfectly aligned checkout while every stored `(file, line, side)` is a
    // coordinate in the pre-commit snapshot. A dirty-then-reverted tree is the
    // mirror image: HEAD never moved, and the content under the anchors did.
    //
    // So compare against what the session CAPTURED: `reviews.local_head_sha`
    // and the stored scoped-diff digest, through the same helper
    // `GET /api/local/:reviewId/check-stale` reports from.
    //
    // WHY THIS RUNS BEFORE `checkSubmitPreconditions`. It is pure local git
    // work — no network, no credential, nothing GitHub could say that changes
    // the verdict. A stale snapshot is unfixable by any remote answer, so
    // paying for a round trip (and a possible `token_command` shell-out) only
    // to refuse anyway is waste; refusing here also guarantees no request is
    // made on behalf of a session we are about to reject.
    //
    // WHY THIS IS A REFUSAL AND NOT A DEGRADATION. Everything else on this
    // path degrades a doubtful anchor to file level with a `(Ref Line N)`
    // prefix. That prefix is only meaningful because the number describes the
    // diff the reviewer was looking at — when the snapshot itself is stale,
    // the *text* lies too. There is nothing to degrade to.
    //
    // UNKNOWN IS NOT "NO". The helper's two flags are PROVEN differences: it
    // leaves BOTH false for `no-stored-diff`, `no-baseline-digest` and
    // `digest-unavailable`, which do not mean "nothing changed" — they mean the
    // captured snapshot could not be compared with the tree AT ALL. Gating on
    // the flags alone therefore treated "never compared" as "compared and
    // clean", and the `diffTrustworthy` path below then handed those comments
    // precise line anchors. The dirty-file check does not cover the hole:
    // `listFilesModifiedVsHead` compares the tree with HEAD, never with the
    // historical snapshot the comments were authored against, so a legacy
    // session (no baseline digest) whose dirty content was later reset presents
    // a clean tree and posts a numerically valid inline comment against
    // unrelated PR content. Even the file-level fallback is not safe here: the
    // `(Ref Line N)` prefix publishes a number whose applicability was never
    // established. So: proceed ONLY on `status === 'compared'` with both flags
    // false; every other status is a 409.
    //
    // `check-stale` may keep treating these as advisory — it only nags. This
    // endpoint POSTS, which is why the two callers of the same helper read its
    // result differently and neither may relax for the other's sake.
    // ------------------------------------------------------------------
    const snapshotDrift = await evaluateLocalSnapshotDrift({
      db, review, currentHeadSha: localHeadSha, reviewRepo
    });
    if (snapshotDrift.status !== 'compared') {
      // ONE code for all three unknown statuses, not three. The client's
      // reaction is identical in every case — refresh the diff, re-check the
      // retained comments, submit again — so distinct codes would only produce
      // three identical branches, and each new "we could not compare" state
      // added to the helper would silently become a code the frontend has never
      // heard of. The specific status travels as `snapshotStatus` for logs and
      // support, deliberately NOT as something the UI is expected to switch on.
      logger.warn(
        `Refusing to submit local review #${reviewId}: snapshot could not be verified `
        + `(status=${snapshotDrift.status})`
      );
      return res.status(409).json({
        error: 'The diff your comments were written against could not be checked against your '
          + 'working tree, so there is no evidence the stored line numbers still describe it. '
          + 'Refresh the diff — that captures a fresh snapshot and keeps your comments — then '
          + 're-check where they landed and submit again.',
        code: 'local_diff_unverified',
        snapshotStatus: snapshotDrift.status
      });
    }
    if (snapshotDrift.headMoved || snapshotDrift.digestMoved) {
      const what = snapshotDrift.headMoved
        ? (snapshotDrift.digestMoved
          ? 'the commit it was captured at has changed and the working tree has changed'
          : 'the commit it was captured at has changed')
        : 'the working tree has changed';
      logger.warn(
        `Refusing to submit local review #${reviewId}: snapshot drift `
        + `(headMoved=${snapshotDrift.headMoved}, digestMoved=${snapshotDrift.digestMoved})`
      );
      return res.status(409).json({
        error: `The diff your comments were written against is out of date — ${what} since it was `
          + 'captured, so the stored line numbers describe a snapshot that no longer exists. '
          + 'Refresh the diff and re-check where your comments landed, then submit again.',
        code: 'local_diff_stale'
      });
    }

    const preconditions = await checkSubmitPreconditions({
      owner: parts.owner,
      repo: parts.repo,
      prNumber: association.prNumber,
      credential,
      localHeadSha,
      // Lifecycle is per-event: a merged or closed PR still takes a COMMENT
      // review, and refuses only the approving events and a new draft. Without
      // this the check falls back to refusing all four.
      event
    });
    if (!preconditions.ok) {
      return res.status(preconditions.status).json({
        error: preconditions.error,
        code: preconditions.code
      });
    }
    const prData = preconditions.prData;

    // Which files may keep a line number. A file whose working tree differs
    // from HEAD renders lines that need not be the lines GitHub holds, so its
    // comments degrade to file level. If the question cannot be ANSWERED we
    // degrade everything, by dropping the diff — an empty set would read as
    // "the tree is clean", which is the claim that buys a line number.
    let filesWithLocalEdits = new Set();
    let diffTrustworthy = true;
    try {
      filesWithLocalEdits = await localReview.listFilesModifiedVsHead(review.local_path);
    } catch (dirtyError) {
      logger.warn(
        `Could not determine locally-edited files for review #${reviewId}: ${dirtyError.message}. `
        + 'Submitting every comment at file level.'
      );
      diffTrustworthy = false;
    }

    // The PR's own diff, generated from this checkout — the preconditions have
    // just proved local HEAD IS the PR head, so the two agree by construction
    // whenever the base commit is present locally. It is NOT the local
    // review's scoped diff: GitHub validates each inline comment against the
    // PULL REQUEST's diff, so a line inside a narrow local scope but outside
    // the PR would be posted at a position GitHub cannot render.
    let diffContent = '';
    if (diffTrustworthy) {
      try {
        const worktreeManager = new GitWorktreeManager(db);
        diffContent = await worktreeManager.generateUnifiedDiff(review.local_path, prData);
      } catch (diffError) {
        // Routinely the PR's base commit simply is not fetched locally. Not
        // fatal: every comment falls back to file level with its line spelled
        // out in the body.
        logger.warn(`Could not generate PR diff for review #${reviewId}: ${diffError.message}`);
      }
    }

    // Name the host this review is going TO — resolved from the association's
    // repository and the binding's host, never hardcoded to "GitHub".
    //
    // `resolveBindingRepositoryForHost`, not `resolveBindingRepositoryFromPR`:
    // for a github.com PR (host null) the plain resolver can hand back an
    // EXCLUSIVE alt-host entry that merely claims this owner/repo, and the
    // review would then be named after a system it was not submitted to. PR
    // mode's submit handler resolves it the same way — the two must agree, or
    // one shared provider ends up with two host vocabularies.
    const submitHost = (hostBinding && hostBinding.host) ? hostBinding.host : null;
    const hostName = resolveHostName(
      config,
      resolveBindingRepositoryForHost(parts.owner, parts.repo, config, submitHost),
      submitHost
    );

    const result = await submitReview({
      db,
      reviewId: review.id,
      owner: parts.owner,
      repo: parts.repo,
      prNumber: association.prNumber,
      event,
      body,
      credential,
      prNodeId: prData.node_id ?? null,
      headSha: prData.head_sha || null,
      diffContent,
      filesWithLocalEdits,
      // Local mode only: these comments were authored against the WORKING
      // TREE's diff, not the pull request's, so a file that exists in one and
      // not the other is routine here and an anomaly in PR mode.
      refuseCommentsOutsideDiff: true,
      // ----------------------------------------------------------------
      // EVERY LOCAL-MODE `side: 'LEFT'` COMMENT DEGRADES TO FILE LEVEL.
      //
      // Unconditional, and local mode only — PR mode's comments are authored on
      // the pull request's own diff, so the provider's default (`true`) keeps
      // that path posting precise LEFT anchors.
      //
      // A LEFT line number is a coordinate in the OLD-side file of whatever base
      // the reviewer was looking at WHEN THEY WROTE IT. This handler can only
      // see the review's CURRENT persisted base, and there are at least two
      // routine ways those differ: the comment may have been authored under a
      // transient in-UI base override, or BEFORE `set-scope` changed the stored
      // base. Neither transition touches the working tree, so the snapshot
      // digest cannot detect either one. A stale LEFT number does not fail
      // loudly — `buildDiffLineSet` records a LEFT entry for every deleted AND
      // context line, so it lands inside some hunk and posts silently against
      // content the reviewer never pointed at.
      //
      // WHY DEGRADE RATHER THAN CARRY PROVENANCE. The correct long-term fix is
      // to persist each LEFT comment's authored old-side base sha and keep
      // precision only while it equals the live PR base sha. That needs a
      // schema migration, and this branch already carries an UNRESOLVED
      // migration-number collision with another in-flight branch; adding one
      // now compounds it. Degrading is the conservative half of a rule the READ
      // side already applies (`_externalAnchorContext` and
      // `_applyBaseOverrideLeftAnchor` in public/js/pr.js), it costs only
      // precision and never correctness, and tightening it later — once the
      // provenance column exists — is a pure widening with no compatibility
      // break. The line itself is not lost: the provider prefixes the body with
      // `(Ref Line N)` / `(Ref Lines N-M)`.
      // ----------------------------------------------------------------
      trustLeftAnchors: false,
      hostName
    });

    res.json(result);

  } catch (error) {
    logger.error('Error submitting local review to GitHub:', error);

    // A refusal the provider decided carries its own status and message.
    if (error instanceof SubmitReviewError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }

    // Same vocabulary as PR mode's ladder — one feature, one set of answers.
    if (error.message.includes('GitHub authentication failed')) {
      return res.status(401).json({
        error: 'GitHub authentication failed. Please check your token in ~/.pair-review/config.json',
        code: 'auth_failed'
      });
    } else if (error.message.includes('Insufficient permissions')) {
      return res.status(403).json({
        error: 'Insufficient permissions to submit review. Your GitHub token may need additional scopes.',
        code: 'insufficient_permissions'
      });
    } else if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message, code: 'not_found' });
    } else if (error.message.includes('rate limit')) {
      return res.status(429).json({ error: error.message, code: 'rate_limited' });
    }
    return res.status(500).json({
      error: `Failed to submit review: ${error.message}`,
      code: 'submit_failed'
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
 * Kick off the REMOTE half of a local review's staleness check: what commit is
 * the associated PR's head right now?
 *
 * Returns null when no fetch was even ATTEMPTED — no association, no usable
 * credential, or an unresolved host (see below). That null is what the route
 * ships as `prHead: null`, which the frontend reads as "not applicable". A
 * fetch that was attempted and FAILED comes back as an object with
 * `checked: true` and a non-null `error`, so the two states stay
 * distinguishable.
 *
 * HOST-BINDING INVARIANT (Phase 2's hard-won lesson)
 * --------------------------------------------------
 * The credential is resolved through `resolveReviewCredential`, the same
 * helper `GET /api/local/:reviewId` and `/pr-metadata` use, so this check can
 * never bind a different host than the one the association was discovered on.
 * (`cachedTokensOnly` below changes only whether a token COMMAND may run, not
 * which host is bound, so the invariant is untouched by it.)
 * When that resolution comes back `hostAmbiguous` — a dual-host repo
 * (`api_host` + `exclusive: false`) whose real host the checkout's git remote
 * could not name — we DO NOT FETCH. Probing a guessed host returns a
 * same-numbered but unrelated PR, and reporting its head as "your PR has new
 * commits" is exactly the shipped-and-fixed Phase 2 bug in a new costume. See
 * `resolveRepositoryBinding` / `fetchPRMetadata` in providers/pr-context.js.
 *
 * NEVER WRITES `pr_metadata`. The cached head_sha is READ here (it is the
 * `prAdvanced` baseline); writing the fresh value back would destroy that
 * comparison on the next call. See src/providers/stale-check.js.
 *
 * NOTHING HERE MAY BLOCK THE EVENT LOOP
 * -------------------------------------
 * The GitHub round-trip is under `checkPRHeadState`'s 1200ms deadline, but a
 * deadline is a Promise and a Promise cannot preempt a SYNCHRONOUS block. The
 * credential resolution above it used to be exactly that: a
 * `github_token_command` that fails is uncached, so `execSync` re-ran it — up
 * to a 5 second timeout — on this request, while the browser abandons the
 * whole response at `STALE_TIMEOUT = 2000ms`. A broken `gh auth token` could
 * therefore discard the WORKING-TREE answer, which is this endpoint's core
 * feature, in service of an advisory extra.
 *
 * So this path resolves `cachedTokensOnly` (see `resolveReviewCredential`):
 * it uses a token another request already paid for, and otherwise reports no
 * credential and skips the PR-head add-on entirely. The page-load
 * `GET /api/local/:reviewId` is what warms that cache, and it runs before
 * this on every load, so the normal case is unaffected.
 *
 * `cachedTokensOnly` alone does NOT close that hole, because it governs only
 * whether a command runs to PRODUCE a binding. A binding already in the cache
 * still carries its `refresh` closure, and `GitHubClient` calls it after a
 * 401 — at which point the command runs anyway, `execSync` and all, on an
 * expired cached token. `fetchRemotePRHead` strips the closure for exactly
 * this reason (see `withoutTokenRefresh` in src/providers/stale-check.js), so
 * a 401 here fails open through the shared error vocabulary instead of
 * shelling out.
 *
 * One synchronous read remains and is deliberately kept: a DUAL-host repo
 * resolves its host from `git config --get remote.origin.url`. That is a local
 * file read bounded at 5s only for a checkout on a hung network mount, it is
 * memoized per checkout path (nulls included) so it happens at most once per
 * process, the page-load GET warms it, and skipping it would mean falling back
 * to the github.com GUESS — which the `hostAmbiguous` refusal above then
 * declines to act on anyway. Trading a memoized local read for a wrong host is
 * not a trade worth making.
 *
 * @param {Object} req - Express request (for `db`, `config`, `githubToken`)
 * @param {Object} review - Row from `getLocalReviewById`
 * @returns {Promise<Object|null>} the remote half of the `prHead` block
 */
async function startPRHeadCheck(req, review) {
  const association = associationFromReview(review);
  if (!isUsablePRTarget(association)) return null;
  const parts = splitRepository(association.repository);
  if (!parts) return null;

  const db = req.app.get('db');
  const config = req.app.get('config') || {};
  const resolvedToken = req.app.get('githubToken') || '';

  const { binding } = resolveReviewCredential({
    association,
    repositoryName: review.repository,
    config,
    localPath: review.local_path,
    resolvedToken,
    // Advisory path on a client deadline — never shell out. See the docblock.
    cachedTokensOnly: true
  });

  if (binding && binding.hostAmbiguous) {
    logger.debug(
      `PR head check skipped for review #${review.id}: host is ambiguous for ` +
      `${association.repository} — refusing to probe a guessed host`
    );
    return null;
  }

  const credential = resolveFetchCredential(binding, resolvedToken);
  if (!credential) return null;

  // Cache-only read — one indexed SELECT, no GitHub call. It is the baseline
  // for `prAdvanced` ("the PR moved since we last recorded it"), which is a
  // different question from `drifted` ("my checkout and the PR disagree").
  let cachedHeadSha = null;
  try {
    const cached = await getCachedPRMetadata({
      prNumber: association.prNumber,
      repository: association.repository,
      db
    });
    cachedHeadSha = cached?.head_sha || null;
  } catch (err) {
    logger.debug(`Cached PR metadata read failed for review #${review.id}: ${err.message}`);
  }

  const state = await checkPRHeadState({
    owner: parts.owner,
    repo: parts.repo,
    prNumber: association.prNumber,
    knownHeadSha: cachedHeadSha,
    credential
  });

  return {
    prNumber: association.prNumber,
    repository: association.repository,
    ...state
  };
}

/**
 * Has local `HEAD` moved away from the commit a diff was CAPTURED at?
 *
 * One line, but it has two callers with the same question and they must not
 * answer it differently: `GET /api/local/:reviewId/check-stale` (which reports
 * it as `headShaChanged` and the `local-head-moved` reason) and
 * `POST /api/local/:reviewId/submit-review` (which REFUSES on it). Both
 * operands must be known — an unreadable HEAD, or a session that never
 * recorded one, is not evidence of movement, and inventing movement out of a
 * null would block every submission from a legacy row.
 *
 * @param {string|null} capturedHeadSha - `reviews.local_head_sha`
 * @param {string|null} currentHeadSha - What `git rev-parse HEAD` says now
 * @returns {boolean}
 */
function localHeadMoved(capturedHeadSha, currentHeadSha) {
  return Boolean(capturedHeadSha && currentHeadSha && capturedHeadSha !== currentHeadSha);
}

/**
 * The LOCAL half of the staleness comparison — "is the snapshot this session's
 * comments were authored against still the snapshot on disk?" — in ONE place.
 *
 * TWO CALLERS, ONE COMPARISON
 * ---------------------------
 * 1. `GET /api/local/:reviewId/check-stale` — advisory. Turns the result into
 *    `isStale` / `reasons[]` for the badge, and the frontend may silently
 *    re-capture on it.
 * 2. `POST /api/local/:reviewId/submit-review` — authoritative. REFUSES
 *    (409 `local_diff_stale`) on a proven difference, because every stored
 *    comment's `(file, line, side)` is a coordinate in that snapshot — AND
 *    refuses (409 `local_diff_unverified`) on any status other than
 *    'compared', because a write may not treat "not compared" as "unchanged".
 *
 * It lives here, extracted from (1), rather than being written a second time
 * in (2): CLAUDE.md's rule about two code paths performing similar multi-step
 * sequences. The sequence is four steps deep (memory cache → DB fallback →
 * cache warm → recompute-and-compare) and every step has a way of answering
 * "I don't know" that must not be read as "nothing changed".
 *
 * THE FOUR OUTCOMES, and why they are a `status` rather than a boolean:
 *   'compared'           both digests known; `digestMoved` is the answer
 *   'no-stored-diff'     this session never persisted a diff — nothing to
 *                        compare against, NOT a clean tree
 *   'no-baseline-digest' a diff, but from before digests existed
 *   'digest-unavailable' the working tree could not be walked right now
 * `headMoved` is filled in on ALL FOUR: it needs no diff, and it is the drift
 * that matters most to the write path (commit-after-commenting re-aligns local
 * HEAD with the PR head, so the PR-side precondition sees nothing wrong).
 *
 * Never throws for a missing/unreadable checkout — `computeScopedDigest`
 * resolves null rather than rejecting, which is the 'digest-unavailable' case.
 *
 * @param {Object} params
 * @param {Object} params.db
 * @param {Object} params.review - A `reviews` row (needs `id`, `local_path`,
 *   `local_head_sha` and the scope columns).
 * @param {string|null} params.currentHeadSha - Already-read local HEAD. Passed
 *   in rather than read here because both callers need it before this point
 *   (one for its own early returns, one for the PR-side precondition).
 * @param {Object} [params.reviewRepo] - Reuse the caller's repository handle.
 * @returns {Promise<{capturedHeadSha: string|null, currentHeadSha: string|null,
 *   headMoved: boolean, storedDigest: string|null, currentDigest: string|null,
 *   digestMoved: boolean, status: string}>}
 */
async function evaluateLocalSnapshotDrift({ db, review, currentHeadSha, reviewRepo }) {
  const reviewId = review.id;
  const capturedHeadSha = review.local_head_sha || null;
  const base = {
    capturedHeadSha,
    currentHeadSha: currentHeadSha || null,
    headMoved: localHeadMoved(capturedHeadSha, currentHeadSha),
    storedDigest: null,
    currentDigest: null,
    // Only ever true on a PROVEN difference. Every unknown leaves it false and
    // says so through `status`; a caller that wants to refuse on unknowns must
    // read `status`, not flip the meaning of this flag.
    digestMoved: false
  };

  // In-memory first, then the DB, then cache-warm — the same order every other
  // reader of a captured diff uses.
  let storedDiffData = getLocalReviewDiff(reviewId);
  if (!storedDiffData) {
    const repo = reviewRepo || new ReviewRepository(db);
    const persistedDiff = await repo.getLocalDiff(reviewId);
    if (persistedDiff) {
      storedDiffData = persistedDiff;
      setLocalReviewDiff(reviewId, storedDiffData);
      logger.log('API', `Loaded persisted diff from DB for staleness check on review #${reviewId}`, 'cyan');
    }
  }
  if (!storedDiffData) return { ...base, status: 'no-stored-diff' };

  base.storedDigest = storedDiffData.digest || null;
  if (!storedDiffData.digest) return { ...base, status: 'no-baseline-digest' };

  const { start: scopeStart, end: scopeEnd } = reviewScope(review);
  // Module-namespace call so `vi.spyOn(localReview, 'computeScopedDigest')` is
  // observed; the destructured top-level binding is captured at require time
  // and would not honour a spy.
  const currentDigest = await localReview.computeScopedDigest(review.local_path, scopeStart, scopeEnd);
  if (!currentDigest) return { ...base, status: 'digest-unavailable' };

  base.currentDigest = currentDigest;
  base.digestMoved = storedDiffData.digest !== currentDigest;
  return { ...base, status: 'compared' };
}

/**
 * The `reasons[]` codes the LOCAL half of the check owns — the ones derived
 * from this repository's working tree and HEAD, as opposed to the PR-side codes
 * `respond` derives from the remote result.
 *
 * Listed explicitly rather than by exclusion so that adding a PR-side reason to
 * `STALE_REASONS` cannot accidentally enrol it here.
 */
const LOCAL_REASON_CODES = Object.freeze([
  'working-tree-changed',
  'local-head-moved',
  'no-baseline-digest',
  'digest-unavailable',
  'head-sha-unavailable'
]);

/**
 * Drop every local staleness flag, for the one path that ships a payload
 * asserting nothing about the working tree or local HEAD (the handler's catch).
 *
 * `reasons[]` travels in the same body as `isStale` / `headShaChanged` /
 * `currentHeadSha` and is rendered verbatim, so the two must never disagree.
 *
 * @param {Object<string, boolean>} flags - Mutated in place.
 */
function clearLocalReasonFlags(flags) {
  for (const code of LOCAL_REASON_CODES) {
    delete flags[code];
  }
}

/**
 * Check if local review diff is stale (working directory has changed since diff was captured)
 * Uses a digest of the diff content for accurate change detection
 *
 * `isStale` IS AND STAYS WORKING-TREE-ONLY
 * ---------------------------------------
 * `public/js/local.js` auto-refreshes silently (`refreshDiff({ silent: true })`)
 * whenever `isStale === true` and the session carries no user data. A refresh
 * re-captures the WORKING TREE; it can do nothing whatsoever about the PR
 * having advanced on GitHub. Folding PR drift into `isStale` would therefore
 * mean a silent re-capture on every page load, forever, that never clears the
 * condition that triggered it. PR-head information goes into the separate
 * `prHead` block and into `reasons[]` — it must never change `isStale`.
 *
 * `?prHeadOnly=1` — THE POST-REFRESH RE-ASK
 * -----------------------------------------
 * `_recheckPRHeadState` (public/js/local.js) fires after every refresh and
 * consumes `prHead` and nothing else. The refresh route it follows has just
 * regenerated the diff AND its digest, so re-running `computeScopedDigest`
 * here would repeat the whole working-tree walk — every tracked-file diff plus
 * the untracked scan — to produce an answer the caller discards. For a review
 * with no association it repeats it to produce `prHead: null`.
 *
 * In this mode the handler still reads local HEAD (one `git rev-parse`, and
 * `drifted` is meaningless without it) and then answers `isStale: null`,
 * `prHeadOnly: true` with the `prHead` block and the reasons the remote half
 * produced. `isStale: null` is the honest value: this response asserts nothing
 * about the working tree, and the frontend's three-way reading of it already
 * distinguishes "unknown" from "current" — see `_applyPRHeadStaleState`.
 */
router.get('/api/local/:reviewId/check-stale', async (req, res) => {
  const tEndpoint = Date.now();
  const prHeadOnly = req.query.prHeadOnly === '1' || req.query.prHeadOnly === 'true';

  // Declared before the first early return: `respond` closes over both, and a
  // `let` further down would be in the temporal dead zone on every path that
  // returns before reaching it.
  let currentHeadSha = null;
  let prHeadPromise = Promise.resolve(null);
  let responded = false;
  const reasonFlags = {};

  /**
   * The single exit for this handler. Every `res.json` site used to assemble
   * its own payload — seven of them, each of which would have to remember the
   * two new fields. Routing them all through here is what guarantees `prHead`
   * and `reasons` can never be forgotten on a path.
   *
   * `responded` guards the one new hazard the consolidation introduces: this
   * function awaits, so a throw from inside it lands in the handler's catch,
   * which responds again. First writer wins.
   */
  async function respond(payload, status = 200) {
    if (responded) return undefined;
    // Everything before the remote await is the LOCAL half's cost.
    const localElapsed = Date.now() - tEndpoint;
    let remote = null;
    try {
      remote = await prHeadPromise;
    } catch (err) {
      // prHeadPromise is `.catch()`-guarded where it is created; this is
      // belt-and-braces so the response can never be lost to a rejection.
      logger.debug(`PR head check settled with an error: ${err.message}`);
      remote = null;
    }

    let prHead = null;
    if (remote) {
      // TRI-STATE, deliberately. `drifted` compares two SHAs, and either can be
      // missing — a failed `git rev-parse` (or the catch path below, which
      // disowns `currentHeadSha`) leaves the local one null, a failed GitHub
      // fetch leaves the remote one null. `Boolean(a && b && a !== b)` collapses
      // BOTH unknowns into a confident `false`, and the frontend reads an
      // explicit false as "the heads agree now" and RETRACTS the PR DRIFT badge
      // — so a half-answered check erased a badge a fully-answered one put up.
      // `null` is the third answer: hold whatever is on screen.
      const drifted = (currentHeadSha && remote.remoteHeadSha)
        ? currentHeadSha !== remote.remoteHeadSha
        : null;
      prHead = {
        checked: true,
        prNumber: remote.prNumber,
        repository: remote.repository,
        localHeadSha: currentHeadSha || null,
        remoteHeadSha: remote.remoteHeadSha,
        cachedHeadSha: remote.cachedHeadSha,
        drifted,
        prAdvanced: remote.prAdvanced,
        prState: remote.prState,
        merged: remote.merged,
        error: remote.error
      };
      reasonFlags['pr-head-moved'] = prHead.prAdvanced;
      // Only an explicit `true` earns a reason — `null` means "not answered",
      // and `reasons[]` is rendered verbatim into the badge tooltip.
      reasonFlags['local-head-differs-from-pr'] = drifted === true;
      reasonFlags['pr-closed'] = prHead.prState === 'closed' && !prHead.merged;
      reasonFlags['pr-merged'] = prHead.merged;
    }

    const body = { ...payload, prHead, reasons: buildStaleReasons(reasonFlags) };
    responded = true;

    // Measured HERE, not at the call sites. Every `return await respond(...)`
    // waits on `prHeadPromise` above for up to PR_HEAD_CHECK_TIMEOUT_MS, so a
    // probe stopped before the call reported 30ms for a request the client
    // experienced as 1250ms — removing the only server-side latency signal on
    // the endpoint whose budget this feature has to live inside. Both halves
    // are logged because they fail in completely different ways.
    const totalElapsed = Date.now() - tEndpoint;
    if (totalElapsed > 200) {
      logger.debug(
        `[perf] check-stale#${req.params.reviewId} local=${localElapsed}ms ` +
        `total=${totalElapsed}ms (threshold: 200ms)`
      );
    }
    return status === 200 ? res.json(body) : res.status(status).json(body);
  }

  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return await respond({ error: 'Invalid review ID' }, 400);
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return await respond({
        isStale: null,
        error: 'Local review not found'
      });
    }

    const localPath = review.local_path;
    if (!localPath) {
      return await respond({
        isStale: null,
        error: 'Local review missing path'
      });
    }

    // Kick the remote check off HERE — before any git work — so the GitHub
    // round-trip overlaps with the local I/O instead of being serialised after
    // it. The `.catch()` is attached in the same expression: without it an
    // early return below would leave a rejected promise nobody awaits, which
    // is an unhandled rejection. `checkPRHeadState` bounds the wait well under
    // the client's 2000ms abort, so a slow GitHub can no longer eat the
    // working-directory answer.
    prHeadPromise = startPRHeadCheck(req, review).catch((err) => {
      logger.debug(`PR head check failed for review #${reviewId}: ${err.message}`);
      return null;
    });

    // Only the START stop is read here; the digest half of the comparison
    // resolves the full scope itself inside `evaluateLocalSnapshotDrift`.
    const { start: scopeStart } = reviewScope(review);

    // Always check HEAD SHA for supplementary fields
    let headShaChanged = false;
    let previousHeadSha = review.local_head_sha || null;

    try {
      currentHeadSha = await localReview.getHeadSha(localPath);
      headShaChanged = localHeadMoved(previousHeadSha, currentHeadSha);
    } catch (error) {
      // If branch is in scope, HEAD SHA failure is fatal (existing behavior).
      // Not in prHeadOnly mode: that response asserts nothing about the
      // working tree, so it must not claim `isStale: true` either. It simply
      // carries `localHeadSha: null`, and `drifted` answers `null` — unknown,
      // not "the heads agree" (see `respond`).
      if (!prHeadOnly && includesBranch(scopeStart)) {
        reasonFlags['head-sha-unavailable'] = true;
        return await respond({
          isStale: true,
          headShaChanged,
          previousHeadSha,
          currentHeadSha: null,
          error: `Could not check HEAD SHA: ${error.message}`
        });
      }
      // Otherwise, just continue with digest check
    }

    reasonFlags['local-head-moved'] = headShaChanged;

    // PR-head-only: everything below this line is working-tree work the caller
    // did not ask for. See the handler docblock.
    if (prHeadOnly) {
      return await respond({
        isStale: null,
        prHeadOnly: true,
        headShaChanged,
        previousHeadSha,
        currentHeadSha
      });
    }

    // When branch is in scope and HEAD changed, early return (existing behavior)
    if (includesBranch(scopeStart) && headShaChanged) {
      return await respond({
        isStale: true,
        headShaChanged,
        previousHeadSha,
        currentHeadSha
      });
    }

    // Stored digest vs. the working tree right now — the four-step sequence
    // (memory cache, DB fallback, cache warm, recompute) is shared verbatim
    // with the submit endpoint's refusal gate. See `evaluateLocalSnapshotDrift`.
    const drift = await evaluateLocalSnapshotDrift({ db, review, currentHeadSha, reviewRepo });

    if (drift.status === 'no-stored-diff') {
      return await respond({
        isStale: null,
        headShaChanged,
        previousHeadSha,
        currentHeadSha,
        error: 'No stored diff data found'
      });
    }

    if (drift.status === 'no-baseline-digest') {
      // No baseline digest - session may predate staleness detection feature
      // Assume stale to be safe and prompt user to refresh
      reasonFlags['no-baseline-digest'] = true;
      return await respond({
        isStale: true,
        headShaChanged,
        previousHeadSha,
        currentHeadSha,
        error: 'No baseline digest - please refresh to enable staleness detection'
      });
    }

    if (drift.status === 'digest-unavailable') {
      // Current digest computation failed - assume stale to be safe
      reasonFlags['digest-unavailable'] = true;
      return await respond({
        isStale: true,
        headShaChanged,
        previousHeadSha,
        currentHeadSha,
        error: 'Could not compute current digest - refresh recommended'
      });
    }

    // Working-tree comparison ONLY — see the handler docblock.
    const isStale = drift.digestMoved;
    reasonFlags['working-tree-changed'] = isStale;

    return await respond({
      isStale,
      storedDigest: drift.storedDigest,
      currentDigest: drift.currentDigest,
      headShaChanged,
      previousHeadSha,
      currentHeadSha
    });

  } catch (error) {
    logger.warn(`Error checking local review staleness: ${error.message}`);
    // The payload has always reported nulls here; keep `localHeadSha` in the
    // prHead block agreeing with `currentHeadSha` rather than reporting a
    // value the rest of the response disowns. `drifted` follows it to `null`
    // — this body knows no local HEAD, so it cannot answer the comparison.
    currentHeadSha = null;
    // ...and the same disowning must reach `reasons[]`, which ships in the very
    // same body. `local-head-moved` (and any other local flag) may already be
    // set from the work that then threw; leaving it set would ship
    // `headShaChanged: false, currentHeadSha: null` beside a reason reading
    // "Local HEAD has moved since the diff was captured." — which the frontend
    // renders verbatim into the badge tooltip. A payload that answers "I do not
    // know" must carry no local reason at all.
    //
    // Only the LOCAL flags are cleared. The PR-side flags are derived inside
    // `respond` from the remote result, which this failure did not touch.
    clearLocalReasonFlags(reasonFlags);
    return await respond({
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

        // Derive the terminal consolidation (level 4) state from the
        // authoritative result — the run finishing does not mean the
        // consolidation step succeeded, and some council paths never emit a
        // terminal orchestration progress event
        currentStatus.levels[4] = finalizeConsolidationLevel(result, currentStatus.levels?.[4]);

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
        // LEFT-side anchor inputs (see the main GET). `!hasBranch` by
        // construction here, so null/false rather than stale carried-over
        // values.
        scopeIncludesBranch: false,
        mergeBaseSha: null,
        stats: {}
      });
    }

    // Module-namespace call so `vi.spyOn(localReview, ...)` is observed — same
    // reason as the diff route above.
    const scopedResult = await localReview.generateScopedDiff(localPath, scopeStart, scopeEnd, review.local_base_branch);
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
      // LEFT-side anchor inputs (see the main GET), kept current so they do
      // not go stale after a commit/rebase moves the merge-base.
      scopeIncludesBranch: hasBranch,
      mergeBaseSha: scopedResult.mergeBaseSha ?? null,
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
          // Shared resolver, like every other GitHub-reaching lookup in local
          // mode — `review.repository` is an IDENTITY, not a config key.
          const localBinding = resolveRepositoryBinding(review.repository, config, { localPath });
          const token = localBinding?.token;
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
      // Reported alongside mergeBaseSha on every response that carries it.
      scopeIncludesBranch: includesBranch(scopeStart),
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

// Expose internals on the router for unit tests (negative-cache helpers).
// Router is a function so attaching properties is harmless at runtime; this
// keeps require('../src/routes/local') as the single import surface.
router._prDetectionCache = {
  isPRDetectionRecentlyNegative,
  recordPRDetectionNegative,
  clear: _clearPRDetectionNegativeCache,
  ttlMs: PR_DETECTION_NEGATIVE_CACHE_TTL_MS
};

// Same idea for the host-binding negative memo, which now lives in
// providers/pr-context. Re-exposed here unchanged so the existing test surface
// keeps working.
router._hostBindingCache = {
  resolveAssociationBinding,
  resolveRepositoryBinding,
  clear: _hostBindingInternals.clearHostBindingFailureCache,
  ttlMs: _hostBindingInternals.hostBindingFailureTtlMs
};

// The git-remote hostname memo. Exposed so tests can clear it between cases
// (it never expires) and seed it without shelling out to git.
router._remoteHostnameCache = {
  clear: _hostBindingInternals.clearRemoteHostnameCache,
  set: _hostBindingInternals.setRemoteHostname,
  get: _hostBindingInternals.getRemoteHostname,
};

// The in-flight PR-detection map. Exposed so a test can assert it drains, and
// so a leaked entry from one test cannot suppress detection in the next.
router._prDetectionInFlight = {
  clear: () => inFlightPRDetections.clear(),
  size: () => inFlightPRDetections.size,
};

module.exports = router;
