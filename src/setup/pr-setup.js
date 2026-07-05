// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * PR Setup Orchestrator
 *
 * Consolidates PR setup logic (previously duplicated across main.js and
 * routes/worktrees.js) into a reusable module. Covers:
 *   - storePRData: transactional database storage for PR metadata + reviews
 *   - registerRepositoryLocation: persist known repo paths for future sessions
 *   - findRepositoryPath: tiered repository discovery (known path -> existing
 *     worktree -> cached clone -> fresh clone)
 *   - setupPRReview: full orchestrator that wires the above together
 */

const { run, queryOne, WorktreeRepository, RepoSettingsRepository, ReviewRepository, PRMetadataRepository } = require('../database');
const { GitWorktreeManager, MISSING_COMMIT_ERROR_CODE } = require('../git/worktree');
const { WorktreePoolLifecycle } = require('../git/worktree-pool-lifecycle');
const { GitHubClient } = require('../github/client');
const { normalizeRepository } = require('../utils/paths');
const { findMainGitRoot } = require('../local-review');
const { getConfigDir, getRepoPath, resolveRepoOptions, resolvePoolConfig, getRepoResetScript, resolveHostBinding, resolveBindingRepositoryFromPR, getRepoConfig, DEFAULT_CHECKOUT_TIMEOUT_MS } = require('../config');
const { storedHostToOption, isDualHostRepoConfig } = require('../utils/host-resolution');
const logger = require('../utils/logger');
const { fireReviewStartedHook } = require('../hooks/payloads');
const simpleGit = require('simple-git');
const fs = require('fs').promises;
const path = require('path');

/**
 * Store PR data in the database within a single transaction.
 *
 * Creates or updates pr_metadata and reviews rows, and optionally records the
 * worktree path via WorktreeRepository.
 *
 * @param {Object} db - Database instance
 * @param {Object} prInfo - PR information { owner, repo, number }
 * @param {Object} prData - PR data from GitHub API
 * @param {string} diff - Unified diff content
 * @param {Array} changedFiles - Changed files information
 * @param {string} worktreePath - Worktree (or checkout) path
 * @param {Object} [options] - Optional settings
 * @param {boolean} [options.skipWorktreeRecord] - Skip creating a worktree DB record
 * @param {string|null} [options.host] - Per-PR host binding to stamp. When
 *   omitted (`undefined`), the host column is left untouched on UPDATE and
 *   written as NULL on INSERT. `null` (github.com) or an api_host URL string is
 *   written on both the UPDATE and INSERT arms — this is the self-healing step
 *   that stamps the host actually used to fetch the PR.
 */
async function storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, options = {}) {
  const repository = normalizeRepository(prInfo.owner, prInfo.repo);
  // `undefined` means "caller doesn't know the host" — don't disturb any stored
  // value on UPDATE and default to NULL (github.com) on INSERT. `null` or a URL
  // string is an explicit host the caller wants persisted on both arms.
  const writeHost = options.host !== undefined;
  const hostValue = options.host;

  // Begin transaction for atomic database operations
  await run(db, 'BEGIN TRANSACTION');

  try {
    // Look up any existing row FIRST — before any mutation — so the cross-host
    // collision guard below can reject cleanly (no partial write to roll back).
    const existingPR = await queryOne(db, `
      SELECT id, host, pr_data FROM pr_metadata WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prInfo.number, repository]);

    // Cross-host collision guard.
    //
    // INVARIANT: a given (repository, pr_number) identifies exactly ONE pull
    // request across ALL hosts. This is the confirmed plan assumption
    // (plans/per-pr-host-resolution.md, "Assumption (confirmed)") — PR numbers do
    // NOT collide between github.com and an alt host for the same repo — and it
    // is why durable identity stays keyed UNIQUE(pr_number, repository) with no
    // host column and the /pr/:owner/:repo/:number URL scheme is unchanged.
    //
    // If that assumption is ever violated (two DIFFERENT PRs share a number on
    // two hosts), the UPDATE arm below would silently overwrite the first PR's
    // pr_data and re-point its reviews/worktrees at the second. Detect it: when
    // this fetch's host differs from the stored row's host, the API id must
    // match. Same id → same logical PR, the host difference is the intended
    // self-heal relabel → proceed. Different id → genuine cross-host duplicate →
    // refuse rather than corrupt the wrong PR. Unparseable stored id → proceed
    // but warn (can't prove either way; nothing to compare against).
    if (existingPR && writeHost && existingPR.host !== hostValue) {
      const incomingId = prData.id ?? prData.node_id ?? null;
      let storedId = null;
      try {
        const storedData = existingPR.pr_data ? JSON.parse(existingPR.pr_data) : null;
        if (storedData) storedId = storedData.id ?? storedData.node_id ?? null;
      } catch {
        storedId = null; // unparseable → treated as "unknown" below
      }
      const storedHostLabel = existingPR.host === null ? 'github.com' : existingPR.host;
      const incomingHostLabel = hostValue === null ? 'github.com' : hostValue;
      if (storedId === null) {
        logger.warn(
          `storePRData: stored pr_metadata for ${repository} #${prInfo.number} has no parseable API id; ` +
          `proceeding with host relabel (${storedHostLabel} -> ${incomingHostLabel})`
        );
      } else if (incomingId !== null && String(storedId) !== String(incomingId)) {
        throw new Error(
          `Cross-host PR conflict for ${repository} #${prInfo.number}: a DIFFERENT pull request with this ` +
          `number is already stored on ${storedHostLabel}, but this fetch came from ${incomingHostLabel}. ` +
          `pair-review assumes pull request numbers do not collide across hosts for a repository ` +
          `(see plans/per-pr-host-resolution.md); reviewing two different PRs that share number ` +
          `#${prInfo.number} on different hosts is not supported.`
        );
      }
    }

    // Store or update worktree record (skip when using --use-checkout,
    // since the path is the user's working directory, not a managed worktree)
    if (!options.skipWorktreeRecord) {
      const worktreeRepo = new WorktreeRepository(db);
      await worktreeRepo.getOrCreate({
        prNumber: prInfo.number,
        repository,
        branch: prData.head_branch,
        path: worktreePath
      });
    }

    // Prepare extended PR data (keep worktree_path for backward compat, but DB is source of truth)
    const extendedPRData = {
      ...prData,
      diff: diff,
      changed_files: changedFiles,
      worktree_path: worktreePath,
      fetched_at: new Date().toISOString()
    };

    const now = new Date().toISOString();

    if (existingPR) {
      // Update existing PR metadata (preserves ID). The host column is only
      // touched when the caller supplies one, so a plain re-fetch that doesn't
      // know the host leaves any previously stamped value intact.
      await run(db, `
        UPDATE pr_metadata
        SET title = ?, description = ?, author = ?,
            base_branch = ?, head_branch = ?, pr_data = ?${writeHost ? ', host = ?' : ''},
            updated_at = CURRENT_TIMESTAMP, last_accessed_at = ?
        WHERE id = ?
      `, [
        prData.title,
        prData.body,
        prData.author,
        prData.base_branch,
        prData.head_branch,
        JSON.stringify(extendedPRData),
        ...(writeHost ? [hostValue] : []),
        now,
        existingPR.id
      ]);
      logger.info(`Updated existing PR metadata (ID: ${existingPR.id})`);
    } else {
      // Insert new PR metadata. When no host is supplied the column is omitted
      // and defaults to NULL (github.com).
      const result = await run(db, `
        INSERT INTO pr_metadata
        (pr_number, repository, title, description, author, base_branch, head_branch, pr_data${writeHost ? ', host' : ''}, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?${writeHost ? ', ?' : ''}, ?)
      `, [
        prInfo.number,
        repository,
        prData.title,
        prData.body,
        prData.author,
        prData.base_branch,
        prData.head_branch,
        JSON.stringify(extendedPRData),
        ...(writeHost ? [hostValue] : []),
        now
      ]);
      logger.info(`Created new PR metadata (ID: ${result.lastID})`);
    }

    // Create or update review record
    // NOTE: Uses raw SQL instead of ReviewRepository to participate in the surrounding
    // transaction and to update only review_data without overwriting custom_instructions
    // or summary fields that may have been set by previous analysis runs.
    const existingReview = await queryOne(db, `
      SELECT id FROM reviews WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prInfo.number, repository]);

    let isNewReview;
    let reviewId;

    if (existingReview) {
      // Update existing review (preserves ID)
      await run(db, `
        UPDATE reviews
        SET review_data = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        JSON.stringify({
          worktree_path: worktreePath,
          created_at: new Date().toISOString()
        }),
        existingReview.id
      ]);
      isNewReview = false;
      reviewId = existingReview.id;
      logger.info(`Updated existing review (ID: ${existingReview.id})`);
    } else {
      // Insert new review
      const result = await run(db, `
        INSERT INTO reviews
        (pr_number, repository, status, review_data)
        VALUES (?, ?, 'draft', ?)
      `, [
        prInfo.number,
        repository,
        JSON.stringify({
          worktree_path: worktreePath,
          created_at: new Date().toISOString()
        })
      ]);
      isNewReview = true;
      reviewId = result.lastID;
      logger.info(`Created new review (ID: ${result.lastID})`);
    }

    // Commit transaction
    await run(db, 'COMMIT');
    logger.info(`Stored PR data for ${repository} #${prInfo.number}`);

    return { isNewReview, reviewId };

  } catch (error) {
    // Rollback transaction on error
    await run(db, 'ROLLBACK');
    logger.error('Error storing PR data:', error);
    throw new Error(`Failed to store PR data: ${error.message}`);
  }
}

/**
 * Resolve the per-PR host binding and fetch the PR, applying the host
 * precedence used by every PR-setup entry point (web setup route + CLI):
 *
 *   1. explicit `host` (URL paste / request body): `undefined` = unknown,
 *      `null` = github.com, `'<url>'` = an alt host. When defined,
 *      `resolveHostBinding` validates it and throws on a stale/mismatched host.
 *   2. stored `pr_metadata.host` (a row exists → `getPRHost !== undefined`).
 *   3. ambiguity rule. For a DUAL repo (`api_host` + `exclusive: false`) whose
 *      host is still unknown, PROBE: fetch from the alt host first and, ONLY on
 *      a 404, fall back to github.com. Any non-404 error (auth, network, 5xx)
 *      fails loudly WITHOUT falling back — a silent fallback could fetch a
 *      same-numbered PR from the wrong system and stamp the wrong host.
 *      Exclusive alt-host and plain github repos resolve to a single binding
 *      with no probe (byte-identical to pre-dual behaviour).
 *
 * The chosen binding carries a `host` echo field (null for github.com, the
 * api_host string for an alt host) that callers persist via `storePRData` — the
 * self-healing step that stamps the host actually used.
 *
 * @param {Object} params
 * @param {Object} params.db - Database instance (for the stored-host lookup)
 * @param {Object} params.config - Application config
 * @param {string} params.bindingRepository - `repos[...]` config-lookup key
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.prNumber
 * @param {string|null|undefined} params.host - explicit host override (see above)
 * @param {string} [params.githubToken] - fallback token when the chosen binding
 *   resolves none (legacy github.com behaviour)
 * @param {Object} [params.deps] - `{ GitHubClient }` override for tests
 * @returns {Promise<{ binding: Object, prData: Object, githubClient: Object }>}
 */
async function resolvePrHostBinding({ db, config, bindingRepository, owner, repo, prNumber, host, githubToken, deps = {} }) {
  const Client = deps.GitHubClient || GitHubClient;
  const repository = normalizeRepository(owner, repo);
  const repoConfig = getRepoConfig(config, bindingRepository);
  const configuredApiHost = (repoConfig && typeof repoConfig.api_host === 'string' && repoConfig.api_host)
    ? repoConfig.api_host
    : null;
  // A dual repo has an api_host but is not exclusive — its PRs may live on
  // github.com OR the alt host, so an unknown host must be probed.
  const isDual = isDualHostRepoConfig(repoConfig);

  // Build the argument for `new Client(...)` from a resolved binding. A binding
  // with a token is used as-is. A github-flavored binding (apiHost === null) with
  // no token may fall back to the caller's github.com token (legacy behaviour).
  // An ALT-flavored binding with no token must NOT fall back to `githubToken` —
  // that would point Octokit at api.github.com while the caller records the
  // result as the alt host (stamping a same-numbered github PR as alt). Guard on
  // host flavor, not token truthiness: surface a clear missing-credential error.
  const clientArgFor = (binding) => {
    if (binding.token) return binding;
    if (binding.apiHost === null) return githubToken;
    throw new Error(
      `No token configured for alt host ${binding.apiHost} (repo ${bindingRepository}). ` +
      `Configure repos["${bindingRepository}"].token or token_command.`
    );
  };

  // Apply host precedence to decide whether we know the host up front.
  let effectiveHost;
  let hostKnown = false;
  if (host !== undefined) {
    effectiveHost = host;
    hostKnown = true;
  } else {
    const prMetadataRepo = new PRMetadataRepository(db);
    const storedHost = await prMetadataRepo.getPRHost(repository, prNumber);
    // storedHostToOption applies the legacy-NULL convention: `undefined` means
    // "host unknown" (leave hostKnown false → ambiguity/probe path), while a
    // returned option object pins the host.
    const storedOption = storedHostToOption(config, bindingRepository, storedHost);
    if (storedOption !== undefined) {
      effectiveHost = storedOption.host;
      hostKnown = true;
    }
  }

  // Fixed-binding path: host is known, OR the repo can only live on one host
  // (plain github / exclusive alt) so the ambiguity rule is unambiguous.
  if (hostKnown || !isDual) {
    const binding = resolveHostBinding(bindingRepository, config, hostKnown ? { host: effectiveHost } : {});
    const client = new Client(clientArgFor(binding));
    const repoExists = await client.repositoryExists(owner, repo);
    if (!repoExists) {
      throw new Error(`Repository ${owner}/${repo} not found`);
    }
    const prData = await client.fetchPullRequest(owner, repo, prNumber);
    return { binding, prData, githubClient: client };
  }

  // Probe path: dual repo, host unknown. Try the alt host first. `clientArgFor`
  // errors clearly if the alt binding has no token rather than silently probing
  // github.com disguised as the alt host.
  const altBinding = resolveHostBinding(bindingRepository, config, { host: configuredApiHost });
  const altClient = new Client(clientArgFor(altBinding));
  try {
    const prData = await altClient.fetchPullRequest(owner, repo, prNumber);
    logger.info(`PR #${prNumber} (${repository}) resolved to alt host ${configuredApiHost}`);
    return { binding: altBinding, prData, githubClient: altClient };
  } catch (altErr) {
    if (altErr && altErr.status === 404) {
      logger.info(`PR #${prNumber} (${repository}) not found on alt host ${configuredApiHost}; falling back to github.com`);
      const githubBinding = resolveHostBinding(bindingRepository, config, { host: null });
      const githubClient = new Client(clientArgFor(githubBinding));
      const prData = await githubClient.fetchPullRequest(owner, repo, prNumber);
      return { binding: githubBinding, prData, githubClient };
    }
    // Auth/network/5xx on the alt host — do NOT fall back to github.com.
    throw new Error(
      `Failed to fetch PR #${prNumber} from alt host ${configuredApiHost}: ${altErr.message}`
    );
  }
}

/**
 * Register the known location of a GitHub repository in the database.
 * This allows the web UI to find the repo without cloning when reviewing PRs.
 *
 * @param {Object} db - Database instance
 * @param {string} currentDir - Current working directory (or any directory in the repo)
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<void>}
 */
async function registerRepositoryLocation(db, currentDir, owner, repo) {
  const repository = normalizeRepository(owner, repo);
  try {
    // Use findMainGitRoot to resolve worktrees to their parent repo
    // This ensures we always store the actual git root, not a worktree path
    const gitRoot = await findMainGitRoot(currentDir);
    const repoSettingsRepo = new RepoSettingsRepository(db);
    await repoSettingsRepo.setLocalPath(repository, gitRoot);
    console.log(`Registered repository location: ${gitRoot}`);
  } catch (error) {
    // Non-fatal: registration failure shouldn't block the review
    console.warn(`Could not register repository location: ${error.message}`);
  }
}

/**
 * Tiered repository discovery: find a usable local git repository for the
 * given owner/repo so that worktrees can be created from it.
 *
 * Tiers (in order of preference):
 *  -1. Explicit monorepo configuration (highest priority)
 *   0. Known local path from repo_settings (registered by CLI or previous web UI)
 *   1. Existing worktree for this repo (derive parent git root from it)
 *   2. Cached clone at <configDir>/repos/<owner>/<repo>
 *   3. Fresh clone to the cached location above
 *
 * @param {Object} params
 * @param {Object} params.db - Database instance
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {string} params.repository - Normalized "owner/repo" PR identity (used for DB lookups: worktrees, repo_settings)
 * @param {string} [params.bindingRepository] - `repos[...]` config-lookup key; defaults to `repository`. Differs for monorepo url_pattern configs.
 * @param {number} params.prNumber - PR number (used for worktree lookup)
 * @param {Object} [params.config] - Application config (used for monorepo path lookup)
 * @param {string} [params.cloneUrl] - Alt-host clone URL from `prData.repository.clone_url`; falls back to github.com when omitted.
 * @param {Function} [params.onProgress] - Optional progress callback
 * @returns {Promise<{ repositoryPath: string, knownPath: string|null, worktreeSourcePath: string|null, checkoutScript: string|null, checkoutTimeout: number, worktreeConfig: Object|null }>}
 *   - repositoryPath: the main git root (bare repo or .git parent)
 *   - knownPath: the known path from database (if any)
 *   - worktreeSourcePath: path to use as cwd for `git worktree add` (may be a worktree with sparse-checkout)
 *   - checkoutScript: path to the checkout script (if configured)
 *   - checkoutTimeout: timeout in ms for checkout script (default: 300000 = 5 minutes)
 *   - worktreeConfig: { worktreeBaseDir, nameTemplate } if configured, null otherwise
 */
async function findRepositoryPath({ db, owner, repo, repository, bindingRepository, prNumber, config, cloneUrl, onProgress }) {
  // `repository` is the PR identity (DB key). `bindingRepository` is the
  // `repos[...]` config-lookup key — they differ for monorepo url_pattern configs.
  const configKey = bindingRepository || repository;
  const worktreeManager = new GitWorktreeManager(db);
  const repoSettingsRepo = new RepoSettingsRepository(db);
  const worktreeRepo = new WorktreeRepository(db);
  const repoSettings = await repoSettingsRepo.getRepoSettings(repository);

  let repositoryPath = null;
  let worktreeSourcePath = null;  // Path to use as cwd for `git worktree add` (may differ from repositoryPath)

  // ------------------------------------------------------------------
  // Tier -1: Explicit monorepo configuration (highest priority)
  // ------------------------------------------------------------------
  const monorepoPath = config ? getRepoPath(config, configKey) : null;

  if (monorepoPath) {
    // The configured path might be a worktree or a regular/bare repo.
    // We need the main git root for creating new worktrees, but we also want to
    // preserve the original path if it's a worktree so sparse-checkout is inherited.
    // Wrap in try-catch since findMainGitRoot throws if path doesn't exist or isn't a git repo
    try {
      const resolvedPath = await findMainGitRoot(monorepoPath);
      logger.debug(`Monorepo path ${monorepoPath} resolved to ${resolvedPath}`);

      // Check if this is a valid git directory we can create worktrees from.
      // It could be:
      // 1. A regular repo (has .git directory)
      // 2. A bare repo (is itself a git directory with HEAD, objects, refs)
      // 3. A worktree (has .git file pointing to actual git dir)
      const gitDirPath = path.join(resolvedPath, '.git');
      const headPath = path.join(resolvedPath, 'HEAD');

      const hasGitDir = await worktreeManager.pathExists(gitDirPath);
      const hasHead = await worktreeManager.pathExists(headPath);

      if (hasGitDir || hasHead) {
        // Verify we can actually run git commands here
        try {
          const git = simpleGit(resolvedPath);
          await git.revparse(['HEAD']);
          repositoryPath = resolvedPath;

          // If the configured path differs from the resolved path, it's likely a worktree.
          // Use the original configured path as the source for worktree creation so
          // sparse-checkout configuration is inherited.
          if (monorepoPath !== resolvedPath) {
            worktreeSourcePath = monorepoPath;
            logger.info(`Using configured monorepo path at ${repositoryPath} (worktree source: ${worktreeSourcePath})`);
          } else {
            logger.info(`Using configured monorepo path at ${repositoryPath}`);
          }
        } catch (gitError) {
          logger.warn(`Configured monorepo path ${monorepoPath} resolved to ${resolvedPath} but git commands fail: ${gitError.message}`);
        }
      } else {
        logger.warn(`Configured monorepo path ${monorepoPath} resolved to ${resolvedPath} which has no .git directory or HEAD file`);
      }
    } catch (resolveError) {
      logger.warn(`Configured monorepo path ${monorepoPath} does not exist or is not a git repository: ${resolveError.message}`);
    }
  }

  // ------------------------------------------------------------------
  // Resolve monorepo worktree options (checkout_script, worktree_directory, worktree_name_template)
  // ------------------------------------------------------------------
  const resolved = config ? resolveRepoOptions(config, configKey, repoSettings) : { checkoutScript: null, checkoutTimeout: DEFAULT_CHECKOUT_TIMEOUT_MS, worktreeConfig: null };
  const { checkoutScript, checkoutTimeout, worktreeConfig } = resolved;

  // When a checkout script is configured, null out worktreeSourcePath —
  // the script handles all sparse-checkout setup, so we don't want to
  // inherit from an existing worktree.
  if (checkoutScript) {
    worktreeSourcePath = null;
  }

  // ------------------------------------------------------------------
  // Tier 0: Check known local path from repo_settings
  // ------------------------------------------------------------------
  const knownPath = repoSettings?.local_path || null;

  if (!repositoryPath && knownPath && await worktreeManager.pathExists(knownPath)) {
    try {
      const git = simpleGit(knownPath);
      // Use --git-dir instead of --is-inside-work-tree to support bare repos
      await git.revparse(['--git-dir']);
      repositoryPath = knownPath;
      logger.info(`Using known repository location at ${repositoryPath}`);
    } catch {
      // Path exists but isn't a valid git repo anymore, clear it
      logger.warn(`Known path ${knownPath} is no longer a valid git repo, clearing`);
      await repoSettingsRepo.setLocalPath(repository, null);
    }
  }

  // ------------------------------------------------------------------
  // Tier 1: Check existing worktree for this repo
  // ------------------------------------------------------------------
  if (!repositoryPath) {
    const existingWorktree = await worktreeRepo.findByPR(prNumber, repository);

    if (existingWorktree && await worktreeManager.pathExists(existingWorktree.path)) {
      try {
        const git = simpleGit(existingWorktree.path);
        repositoryPath = await git.revparse(['--show-toplevel']);
        repositoryPath = repositoryPath.trim();
        logger.info(`Using repository from existing worktree at ${repositoryPath}`);
      } catch {
        // If we can't get the git root, we'll need to clone
        repositoryPath = null;
      }
    }
  }

  // ------------------------------------------------------------------
  // Tier 2: Check cached clone at <configDir>/repos/<owner>/<repo>
  // ------------------------------------------------------------------
  if (!repositoryPath) {
    const cachedRepoPath = path.join(getConfigDir(), 'repos', owner, repo);

    if (await worktreeManager.pathExists(cachedRepoPath)) {
      repositoryPath = cachedRepoPath;
      logger.info(`Using cached repository at ${repositoryPath}`);
    } else {
      // ----------------------------------------------------------------
      // Tier 3: Clone fresh to cached location
      // ----------------------------------------------------------------
      if (onProgress) {
        onProgress({ step: 'repo', status: 'running', message: `Cloning repository ${repository}...` });
      }
      logger.info(`Cloning repository ${repository}...`);
      await fs.mkdir(path.dirname(cachedRepoPath), { recursive: true });

      const git = simpleGit();
      // Honor alt-host clone URL when callers thread it through; older
      // restore snapshots / pre-alt-host callers fall back to github.com.
      const resolvedCloneUrl = cloneUrl || `https://github.com/${owner}/${repo}.git`;
      await git.clone(resolvedCloneUrl, cachedRepoPath, ['--filter=blob:none', '--no-checkout']);
      repositoryPath = cachedRepoPath;
      if (onProgress) {
        onProgress({ step: 'repo', status: 'running', message: `Repository cloned to ${cachedRepoPath}` });
      }
      logger.info(`Cloned repository to ${repositoryPath}`);
    }
  }

  return { repositoryPath, knownPath, worktreeSourcePath, checkoutScript, checkoutTimeout, worktreeConfig };
}

/**
 * Detect git errors indicating a SHA doesn't exist in the local repository.
 * Used to trigger fallback from restore mode to fresh setup.
 */
function isShaNotFoundError(err) {
  let current = err;
  while (current) {
    if (current.code === MISSING_COMMIT_ERROR_CODE) {
      return true;
    }

    const msg = (current.message || '').toLowerCase();
    if (msg.includes('did not match any') ||
        msg.includes('not a valid object') ||
        msg.includes('reference is not a tree') ||
        msg.includes('bad object')) {
      return true;
    }

    current = current.cause;
  }

  return false;
}

/**
 * Full PR review setup orchestrator.
 *
 * Verifies repository access, fetches PR data, discovers (or clones) the
 * local repository, creates a worktree, generates a diff, and stores
 * everything in the database.
 *
 * @param {Object} params
 * @param {Object} params.db - Database instance
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {number} params.prNumber - Pull request number
 * @param {string} params.githubToken - GitHub PAT
 * @param {string} [params.bindingRepository] - `repos[...]` config-lookup key; resolved internally when omitted
 * @param {Object} [params.config] - Application config (for monorepo path lookup)
 * @param {import('../git/worktree-pool-lifecycle').WorktreePoolLifecycle} [params.poolLifecycle] - Shared pool lifecycle instance (avoids creating a fresh singleton)
 * @param {Object} [params.restoreMetadata] - Stored PR data for restore mode (skips GitHub fetch + diff)
 * @param {string|null} [params.host] - Explicit per-PR host override (URL paste /
 *   dashboard row): `null` = github.com, an api_host URL string = that alt host,
 *   omitted (`undefined`) = unknown (derive from stored host / probe).
 * @param {Function} [params.onProgress] - Optional progress callback
 * @returns {Promise<{ reviewUrl: string, title: string }>}
 */
async function setupPRReview({ db, owner, repo, prNumber, githubToken, bindingRepository: externalBindingRepository, config, host, onProgress, poolLifecycle: externalPoolLifecycle, restoreMetadata }) {
  const repository = normalizeRepository(owner, repo);
  const progress = onProgress || (() => {});

  // Resolve the config-lookup key. Use `resolveBindingRepositoryFromPR` so
  // monorepo-style configs (one `repos[...]` entry serving many captured
  // owner/repo) find the right binding. Fall back to the PR identity when no
  // config is available (legacy invocation path).
  const bindingRepository = externalBindingRepository
    || (config ? resolveBindingRepositoryFromPR(owner, repo, config) : repository);

  const isRestore = !!(restoreMetadata && restoreMetadata.head_sha);
  let prData;
  let githubClient = null;
  // Host actually used to fetch — persisted by storePRData (self-healing). Left
  // undefined for restore mode and the legacy (no-config) path so those flows
  // leave any previously-stamped host untouched.
  let stampHost;

  if (isRestore) {
    prData = restoreMetadata;
    progress({ step: 'verify', status: 'completed', message: 'Restoring previous review state.' });
    progress({ step: 'fetch', status: 'completed', message: 'Using stored PR data.' });
  } else {
    // ------------------------------------------------------------------
    // Step: verify + fetch - Resolve the per-PR host binding, verify access,
    // and fetch PR data. `resolvePrHostBinding` applies host precedence
    // (explicit host → stored host → ambiguity/probe) and, for a dual repo
    // whose host is unknown, probes the alt host first (404 → github.com).
    // ------------------------------------------------------------------
    progress({ step: 'verify', status: 'running', message: 'Verifying repository access...' });
    // Pair the 'fetch' step's completed event (below) with a running event and
    // restore the spinner message; resolvePrHostBinding does the actual fetch.
    progress({ step: 'fetch', status: 'running', message: 'Fetching pull request data from GitHub...' });
    if (config) {
      const resolved = await resolvePrHostBinding({
        db, config, bindingRepository, owner, repo, prNumber, host, githubToken
      });
      githubClient = resolved.githubClient;
      prData = resolved.prData;
      stampHost = resolved.binding.host;
    } else {
      // Legacy path: no config, so bind directly with the supplied token and
      // do not track a host.
      githubClient = new GitHubClient(githubToken);
      const repoExists = await githubClient.repositoryExists(owner, repo);
      if (!repoExists) {
        throw new Error(`Repository ${owner}/${repo} not found`);
      }
      prData = await githubClient.fetchPullRequest(owner, repo, prNumber);
    }
    progress({ step: 'verify', status: 'completed', message: 'Repository access verified.' });
    progress({ step: 'fetch', status: 'completed', message: 'Pull request data fetched.' });
  }

  // ------------------------------------------------------------------
  // Step: repo - Find (or clone) a local repository
  // ------------------------------------------------------------------
  progress({ step: 'repo', status: 'running', message: 'Locating repository...' });
  const { repositoryPath, knownPath, worktreeSourcePath, checkoutScript, checkoutTimeout, worktreeConfig } = await findRepositoryPath({
    db,
    owner,
    repo,
    repository,
    bindingRepository,
    prNumber,
    config,
    cloneUrl: prData?.repository?.clone_url,
    onProgress: progress
  });
  progress({ step: 'repo', status: 'completed', message: `Repository located at ${repositoryPath}` });

  // ------------------------------------------------------------------
  // Step: worktree - Create git worktree for the PR
  // ------------------------------------------------------------------
  const prInfo = { owner, repo, number: prNumber };
  const repoSettingsRepo = new RepoSettingsRepository(db);
  const repoSettings = await repoSettingsRepo.getRepoSettings(repository);
  // Pool/reset settings live under the config-lookup key (`bindingRepository`),
  // not the PR identity, so monorepo `repos[...]` entries are honored.
  const { poolSize } = resolvePoolConfig(config || {}, bindingRepository, repoSettings);
  const resetScript = config ? getRepoResetScript(config, bindingRepository) : null;

  let worktreePath;
  let worktreeManager;
  let poolWorktreeId = null;
  let poolLifecycle = null;

  // Wrap worktree acquisition and all subsequent steps in a try/catch so that:
  // 1. If any step between acquireForPR and setCurrentReviewId throws, the pool
  //    worktree is released back to the available state.
  // 2. In restore mode, SHA-not-found errors trigger a fallback to fresh setup.
  try {

  if (poolSize > 0) {
    // Pool mode: use WorktreePoolLifecycle
    progress({ step: 'worktree', status: 'running', message: 'Acquiring pool worktree...' });
    poolLifecycle = externalPoolLifecycle || new WorktreePoolLifecycle(db, config);
    const result = await poolLifecycle.acquireForPR(
      { owner, repo, prNumber, repository },
      prData,
      repositoryPath,
      { worktreeSourcePath, checkoutScript, checkoutTimeout, resetScript, worktreeConfig, poolSize }
    );
    worktreePath = result.worktreePath;
    poolWorktreeId = result.worktreeId;
    worktreeManager = new GitWorktreeManager(db, worktreeConfig || {});
    progress({ step: 'worktree', status: 'completed', message: 'Pool worktree acquired' });
  } else {
    // Non-pool mode: existing behavior
    progress({ step: 'worktree', status: 'running', message: 'Setting up git worktree...' });
    worktreeManager = new GitWorktreeManager(db, worktreeConfig || {});
    // Use worktreeSourcePath as cwd for git worktree add (if available) to inherit sparse-checkout
    ({ path: worktreePath } = await worktreeManager.createWorktreeForPR(prInfo, prData, repositoryPath, { worktreeSourcePath, checkoutScript, checkoutTimeout }));
    progress({ step: 'worktree', status: 'completed', message: `Worktree created at ${worktreePath}` });
  }

    if (isRestore) {
      // ── Restore mode: skip sparse, diff, storePRData ─────────────────
      // Metadata and diff are already stored from the previous session.
      // Just ensure the review record exists and wire up pool ownership.
      progress({ step: 'sparse', status: 'completed', message: 'Using stored checkout (restore mode).' });
      progress({ step: 'diff', status: 'completed', message: 'Using stored diff (restore mode).' });
      progress({ step: 'store', status: 'running', message: 'Restoring review state...' });

      // Ensure worktree record exists (pool path manages this via switchPR,
      // but non-pool path needs it)
      if (!poolWorktreeId) {
        const worktreeRepo = new WorktreeRepository(db);
        await worktreeRepo.getOrCreate({
          prNumber,
          repository,
          branch: prData.head_branch || prData.head?.ref || '',
          path: worktreePath
        });
      }

      // Ensure review record exists
      const reviewRepo = new ReviewRepository(db);
      const { review } = await reviewRepo.getOrCreate({ prNumber, repository });
      const reviewId = review.id;

      // Wire up pool ownership
      if (poolWorktreeId && poolLifecycle) {
        await poolLifecycle.setReviewOwner(poolWorktreeId, reviewId);
      }

      // Register repo path if not already known
      if (knownPath === null && repositoryPath) {
        const repoSettingsRepo = new RepoSettingsRepository(db);
        const currentPath = await repoSettingsRepo.getLocalPath(repository);
        if (path.resolve(currentPath || '') !== path.resolve(repositoryPath)) {
          await repoSettingsRepo.setLocalPath(repository, repositoryPath);
          logger.info(`Registered repository location: ${repositoryPath}`);
        }
      }

      progress({ step: 'store', status: 'completed', message: 'Restored to previous review state.' });
      const reviewUrl = `/pr/${owner}/${repo}/${prNumber}`;
      return { reviewUrl, title: prData.title };
    }

    // ── Fresh mode: existing sparse, diff, storePRData flow (unchanged) ──

  // ------------------------------------------------------------------
  // Step: sparse - Expand sparse-checkout before generating diff
  // ------------------------------------------------------------------
  // IMPORTANT: Sparse-checkout expansion MUST happen before diff generation.
  // In monorepo worktrees that inherit a sparse-checkout from the source
  // worktree, the checkout may not include all directories touched by the PR.
  // If we generate the diff first, files outside the sparse cone will be missing
  // from the worktree, producing an incomplete or empty diff. Expanding the
  // sparse-checkout ensures every PR-changed directory is present on disk so
  // that `git diff` can read the actual file contents.
  //
  // NOTE: prData.changed_files is an INTEGER (count) from the GitHub pulls.get
  // API, not an array. We must fetch the actual file list via pulls.listFiles.
  if (checkoutScript) {
    // checkout_script handles all sparse-checkout setup — skip built-in expansion
    logger.info('Skipping built-in sparse-checkout expansion (checkout_script configured)');
    progress({ step: 'sparse', status: 'completed', message: 'Sparse-checkout managed by checkout_script' });
  } else if (prData.changed_files > 0) {
    const isSparse = await worktreeManager.isSparseCheckoutEnabled(worktreePath);
    if (isSparse) {
      progress({ step: 'sparse', status: 'running', message: 'Expanding sparse-checkout for PR directories...' });
      try {
        const prFiles = await githubClient.fetchPullRequestFiles(owner, repo, prNumber);
        const addedDirs = await worktreeManager.ensurePRDirectoriesInSparseCheckout(worktreePath, prFiles);
        if (addedDirs.length > 0) {
          logger.info(`Expanded sparse-checkout for PR directories: ${addedDirs.join(', ')}`);
        }
        progress({ step: 'sparse', status: 'completed', message: addedDirs.length > 0 ? `Expanded: ${addedDirs.join(', ')}` : 'No expansion needed' });
      } catch (sparseError) {
        logger.warn(`Sparse-checkout expansion failed (non-fatal): ${sparseError.message}`);
        progress({ step: 'sparse', status: 'completed', message: `Sparse-checkout expansion skipped: ${sparseError.message}` });
      }
    }
  }

  // ------------------------------------------------------------------
  // Step: diff - Generate unified diff and changed file list
  // ------------------------------------------------------------------
  progress({ step: 'diff', status: 'running', message: 'Generating unified diff...' });
  const diff = await worktreeManager.generateUnifiedDiff(worktreePath, prData);
  const changedFiles = await worktreeManager.getChangedFiles(worktreePath, prData);
  progress({ step: 'diff', status: 'completed', message: 'Diff generated.' });

  // ------------------------------------------------------------------
  // Step: store - Persist PR data and register repository location
  // ------------------------------------------------------------------
  progress({ step: 'store', status: 'running', message: 'Storing pull request data...' });
  const { isNewReview, reviewId } = await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
    host: stampHost
  });

  // Persist review→worktree mapping in DB for pool usage tracking
  if (poolWorktreeId) {
    await poolLifecycle.setReviewOwner(poolWorktreeId, reviewId);
  }

  // Register the repository path for future sessions if it wasn't already known
  if (knownPath === null && repositoryPath) {
    const repoSettingsRepo = new RepoSettingsRepository(db);
    const currentPath = await repoSettingsRepo.getLocalPath(repository);
    if (path.resolve(currentPath || '') !== path.resolve(repositoryPath)) {
      await repoSettingsRepo.setLocalPath(repository, repositoryPath);
      logger.info(`Registered repository location: ${repositoryPath}`);
    }
  }
  progress({ step: 'store', status: 'completed', message: 'Pull request data stored.' });

  // Fire review.started hook for new reviews (non-blocking).
  // The GET route fires review.loaded on page load; firing review.started
  // here ensures the first-time event isn't lost because storePRData already
  // created the review record before the GET route's getOrCreate runs.
  if (isNewReview) {
    fireReviewStartedHook({ reviewId, prNumber, owner, repo, prData, config })
      .catch(err => { logger.warn(`Review hook failed: ${err.message}`); });
  }

  // ------------------------------------------------------------------
  // Return the review URL and title for the caller
  // ------------------------------------------------------------------
  const reviewUrl = `/pr/${owner}/${repo}/${prNumber}`;
  return { reviewUrl, title: prData.title };

  } catch (err) {
    // If restore mode failed because the stored SHA no longer exists,
    // fall back to a full fresh setup.
    if (isRestore && isShaNotFoundError(err)) {
      logger.warn(`Restore to stored SHA failed, falling back to fresh setup: ${err.message}`);
      // Retry without restoreMetadata. Forward the explicit `host` and
      // `bindingRepository` so the fresh fetch binds the SAME host the caller
      // requested — re-deriving them here could bind a different host (probe a
      // dual repo, or pick the wrong monorepo binding key).
      return setupPRReview({
        db, owner, repo, prNumber, githubToken,
        bindingRepository: externalBindingRepository,
        config, host, onProgress, poolLifecycle: externalPoolLifecycle
      });
    }

    // Release the pool worktree so it doesn't stay permanently in_use.
    // After acquireForPR marks the worktree in_use, if any subsequent step
    // (sparse-checkout, diff generation, storePRData) throws before
    // setCurrentReviewId maps the review to the worktree, the worktree would
    // be permanently leaked — no review owner means the idle grace period
    // mechanism can never fire to reclaim it.
    if (poolWorktreeId && poolLifecycle) {
      try {
        await poolLifecycle.releaseAfterHeadless(poolWorktreeId);
        logger.info(`Released pool worktree ${poolWorktreeId} after setup failure`);
      } catch (releaseErr) {
        logger.error(`Failed to release pool worktree ${poolWorktreeId} after setup failure: ${releaseErr.message}`);
      }
    }
    throw err;
  }
}

module.exports = { setupPRReview, storePRData, resolvePrHostBinding, registerRepositoryLocation, findRepositoryPath, isShaNotFoundError };
