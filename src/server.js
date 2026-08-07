// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const express = require('express');
const path = require('path');
const { loadConfig, getGitHubToken, resolveDbName, warnIfDevModeWithoutDbName, getRepoConfig, resolveBindingRepositoryFromPR, isExclusiveAltHost } = require('./config');
const { initializeDatabase, getDatabaseStatus, queryOne, run, PRMetadataRepository } = require('./database');
const { normalizeRepository } = require('./utils/paths');
const { GlobalSettingsService } = require('./settings/global-settings-service');
const { applyConfigOverrides, checkAllProviders } = require('./ai');
const { checkAllChatProviders } = require('./chat/chat-providers');
const logger = require('./utils/logger');
const { attachWebSocket, closeAll: closeAllWS } = require('./ws');
const { WorktreePoolLifecycle } = require('./git/worktree-pool-lifecycle');
const { resolveDbPath, computeDbId } = require('./utils/db-identity');

let db = null;
let server = null;
let chatSessionManager = null;

/**
 * Assemble the GET /health response body. Kept as a standalone factory so the
 * exact payload the delegation handshake depends on can be unit-tested without
 * booting the whole server. `dbId` is computed once at startup and threaded in
 * (the resolved DB path cannot change without a restart).
 *
 * @param {string} dbId - computeDbId(resolveDbPath(config)) digest
 * @returns {{status: string, service: string, version: string, dbId: string, timestamp: string}}
 */
function buildHealthPayload(dbId) {
  return {
    status: 'ok',
    service: 'pair-review',
    version: require('../package.json').version,
    dbId,
    timestamp: new Date().toISOString()
  };
}

/**
 * Apply env var overrides to config after loadConfig().
 * Currently handles PAIR_REVIEW_SINGLE_PORT — a bridge for callers that
 * need to force multi-port mode (e.g. mcp-stdio.js). Matches the
 * PAIR_REVIEW_YOLO bridge pattern.
 */
function applyEnvOverrides(config) {
  if (process.env.PAIR_REVIEW_SINGLE_PORT === 'false') {
    config.single_port = false;
  }
  return config;
}

/**
 * Apply an explicit `?host` correction from the /pr fast path.
 *
 * Dashboard clicks and pasted URLs can carry `?host` to say which system a PR
 * lives on. When the PR already has metadata + a worktree, the route serves
 * pr.html directly (no setup), so this is the only place that consumes the
 * hint on the fast path. It is a LABEL correction only — the no-collision
 * assumption means a same-numbered PR is the same logical PR, so no re-fetch.
 *
 * Sentinel mapping mirrors setup.html: `'github'` → null (github.com), any
 * other non-empty string → an alt `api_host` URL, absent/empty → no-op. The
 * target is validated against config so a stale link can't stamp a host the
 * repo isn't configured for (which `resolveHostBinding` would later reject);
 * on any mismatch we warn and ignore rather than break the page load.
 *
 * @param {Object} db - Database handle
 * @param {Object} config - Loaded config
 * @param {string} owner - URL owner segment
 * @param {string} repo - URL repo segment
 * @param {string} repository - Normalized `owner/repo` used as the pr_metadata key
 * @param {number} prNumber - PR number
 * @param {*} rawHost - `req.query.host` (already URL-decoded by Express)
 * @returns {Promise<void>}
 */
async function applyHostQueryCorrection(db, config, owner, repo, repository, prNumber, rawHost) {
  if (rawHost === undefined || rawHost === null || rawHost === '') return;
  if (typeof rawHost !== 'string') return;

  const targetHost = rawHost === 'github' ? null : rawHost;

  // Resolve the repo's config entry (handles monorepo-style keys matched via
  // url_pattern) to learn its configured api_host.
  const bindingRepo = resolveBindingRepositoryFromPR(owner, repo, config);
  const repoConfig = getRepoConfig(config, bindingRepo);
  const configuredApiHost = (repoConfig && typeof repoConfig.api_host === 'string' && repoConfig.api_host)
    ? repoConfig.api_host
    : null;

  if (targetHost !== null) {
    // A string host must match this repo's configured api_host exactly.
    if (targetHost !== configuredApiHost) {
      logger.warn(`Ignoring ?host correction for ${repository} #${prNumber}: "${targetHost}" does not match configured api_host (${configuredApiHost || 'none'})`);
      return;
    }
  } else if (isExclusiveAltHost(repoConfig)) {
    // The github sentinel is meaningless for an exclusive alt-host repo (it has
    // no github.com presence); stamping null would break binding resolution.
    logger.warn(`Ignoring ?host=github correction for ${repository} #${prNumber}: repo is an exclusive alt-host repo with no github.com presence`);
    return;
  }

  const prMetadataRepo = new PRMetadataRepository(db);
  const stored = await prMetadataRepo.getPRHost(repository, prNumber);
  // Fast path only runs when a row exists, so `stored` is null or a string.
  // Skip the write when it already matches (avoids a needless updated_at bump).
  if (stored === targetHost) return;

  const changed = await prMetadataRepo.updatePRHost(repository, prNumber, targetHost);
  if (changed) {
    logger.info(`Corrected stored host for ${repository} #${prNumber} to ${targetHost === null ? 'github.com' : targetHost} via ?host`);
  }
}

/**
 * Request logging middleware (disabled for cleaner output)
 */
function requestLogger(req, res, next) {
  // Disabled: Too noisy for normal operation
  // Uncomment the lines below if you need to debug HTTP requests
  // const timestamp = new Date().toISOString();
  // res.on('finish', () => {
  //   console.log(`${req.method} ${req.path} - ${res.statusCode} - [${timestamp}]`);
  // });
  
  next();
}

/**
 * Find an available port starting from the configured port
 * @param {express.Application} app - Express app instance
 * @param {number} startPort - Starting port number
 * @param {number} maxAttempts - Maximum number of ports to try
 * @returns {Promise<number>} - Available port number
 */
function findAvailablePort(app, startPort, maxAttempts = 20) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    let currentPort = startPort;
    
    function tryPort() {
      const testServer = app.listen(currentPort, (error) => {
        if (error) {
          testServer.close();
          console.log(`Port ${currentPort} is already in use`);
          attempts++;
          
          if (attempts >= maxAttempts) {
            reject(new Error(`Could not find available port after ${maxAttempts} attempts starting from ${startPort}`));
            return;
          }
          
          currentPort++;
          tryPort();
        } else {
          testServer.close(() => {
            resolve(currentPort);
          });
        }
      });
      
      testServer.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          testServer.close();
          console.log(`Port ${currentPort} is already in use`);
          attempts++;
          
          if (attempts >= maxAttempts) {
            reject(new Error(`Could not find available port after ${maxAttempts} attempts starting from ${startPort}`));
            return;
          }
          
          currentPort++;
          tryPort();
        } else {
          reject(error);
        }
      });
    }
    
    tryPort();
  });
}

/**
 * Start the Express server
 * @param {sqlite3.Database} [sharedDb] - Optional shared database instance
 * @param {import('./git/worktree-pool-lifecycle').WorktreePoolLifecycle} [sharedPoolLifecycle] - Optional shared pool lifecycle instance
 * @param {Object} [options] - Startup options
 * @param {{ provider?: string, model?: string }} [options.cliOverrides] - Per-run
 *   provider/model overrides from the `--provider`/`--model` CLI flags. Threaded
 *   in explicitly (there is no env-var side channel) and exposed via
 *   `app.get('cliOverrides')` so the web analyze routes can rank them above repo
 *   settings without a process-global. Empty object when no flags were given.
 */
async function startServer(sharedDb = null, sharedPoolLifecycle = null, options = {}) {
  const cliOverrides = options.cliOverrides || {};
  try {
    // Load configuration
    const { config, layers } = await loadConfig();
    applyEnvOverrides(config);

    // Get GitHub token (env var takes precedence over config)
    const githubToken = getGitHubToken(config);

    // Warn if no GitHub token is configured
    if (!githubToken) {
      console.warn('Warning: No GitHub token configured. Set GITHUB_TOKEN environment variable or add github_token to ~/.pair-review/config.json');
    }

    // Use shared database or initialize new one. The DB must be open before the
    // global-settings overlay below, which reads the in-app overrides table.
    if (sharedDb) {
      console.log('Using shared database instance...');
      db = sharedDb;
    } else {
      console.log('Connecting to database...');
      db = await initializeDatabase(resolveDbName(config));
    }

    // Build the global-settings service and overlay in-app DB overrides onto the
    // loaded file config. This MUST run BEFORE any consumer that latches a config
    // value, or an in-app override never takes effect even after a restart
    // (contradicting the restartRequired badge): applyConfigOverrides() below
    // snapshots config.yolo into the provider-runtime `yoloMode`,
    // warnIfDevModeWithoutDbName() reads dev_mode, and the `devMode` const further
    // down is captured by the static-file setHeaders closure.
    //
    // `baseConfig` is captured pre-overlay (the service clones it) so future
    // PUT/DELETE recompute from the file layers, not from an already-overlaid
    // object. We mutate `config` in place with Object.assign so downstream
    // closures (pool lifecycle, chat manager, /pr host correction) share the same
    // effective object every per-request `req.app.get('config')` reader sees.
    // Write endpoints later replace app.get('config') with a fresh effective
    // object; only editable settings change, so the closures (which read only
    // read-only settings) stay correct.
    const globalSettings = new GlobalSettingsService({ db, baseConfig: config, layers });
    Object.assign(config, globalSettings.buildEffectiveConfig());

    // Apply provider configuration overrides (custom models, commands, etc.)
    applyConfigOverrides(config);

    // Warn if dev mode is on without a custom database name
    warnIfDevModeWithoutDbName(config);

    // Log database status
    try {
      const dbStatus = await getDatabaseStatus(db);
      if (dbStatus.total_records > 0) {
        console.log(`Database contains ${dbStatus.total_records} total records:`);
        Object.entries(dbStatus.tables).forEach(([table, count]) => {
          if (count > 0) console.log(`  - ${table}: ${count} records`);
        });
      } else {
        console.log('Database is empty (no stored PRs)');
      }
    } catch (error) {
      console.log('Could not check database status:', error.message);
    }

    // Clean up stale analysis runs that have been "running" for over 30 minutes.
    // We use a time threshold rather than blanket cleanup because multiple server
    // processes (e.g. Express + MCP) may share the same database, and a naive
    // UPDATE would kill legitimately running analyses owned by another process.
    // TODO: A more robust approach would be to record the owning PID in
    // analysis_runs and only clean up records whose process is no longer alive.
    // This would require a schema migration and updating the PID throughout the
    // analysis lifecycle (since analysis spawns child processes).
    try {
      const result = await run(db, "UPDATE analysis_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE status = 'running' AND started_at < datetime('now', '-30 minutes')");
      if (result.changes > 0) {
        logger.info(`Cleaned up ${result.changes} stale analysis run(s) (running > 30 minutes)`);
      }
    } catch (error) {
      logger.warn(`Failed to clean up orphaned analysis runs: ${error.message}`);
    }

    // Check if public directory exists
    const publicDir = path.join(__dirname, '..', 'public');
    try {
      await require('fs').promises.access(publicDir);
    } catch (error) {
      console.error('Public directory not found');
      process.exit(1);
    }
    
    // Create Express app
    const app = express();
    
    // Middleware
    app.use(requestLogger);
    app.use(express.json());

    // CORS middleware for share endpoints
    // Allows configured external origins to fetch share data
    const shareAllowedOrigins = config.share?.allowed_origins || [];
    if (shareAllowedOrigins.length > 0) {
      app.use('/api/pr/:owner/:repo/:number/share', (req, res, next) => {
        const origin = req.headers.origin;
        if (origin && shareAllowedOrigins.includes(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.setHeader('Vary', 'Origin');
        }
        if (req.method === 'OPTIONS') {
          return res.sendStatus(204);
        }
        next();
      });
    }
    
    // Static files with cache control headers
    // In dev_mode, all caching is disabled to avoid stale resources during development
    const devMode = config.dev_mode === true;
    if (devMode) {
      console.log('Dev mode enabled: static file caching disabled');
    }
    app.use(express.static(path.join(__dirname, '..', 'public'), {
      setHeaders: (res, filePath) => {
        if (devMode) {
          // No caching in dev mode
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        } else if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=3600');
        }
      }
    }));
    
    // Routes
    app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    });
    
    // Bulk-open — opens multiple local URLs in the OS browser via the `open` package.
    // Bypasses popup blockers since the server shells out directly.
    const openUrl = (...args) => process.env.PAIR_REVIEW_NO_OPEN ? Promise.resolve() : import('open').then(({ default: open }) => open(...args));
    app.post('/api/bulk-open', async (req, res) => {
      try {
        const { urls } = req.body || {};
        if (!Array.isArray(urls) || urls.length === 0) {
          return res.status(400).json({ error: 'urls array required' });
        }
        if (urls.length > 20) {
          return res.status(400).json({ error: 'Maximum 20 URLs per request' });
        }
        // Only allow local paths starting with / (prevent open-redirect)
        const validUrls = urls.filter(u => typeof u === 'string' && u.startsWith('/'));
        if (validUrls.length === 0) {
          return res.status(400).json({ error: 'All URLs must be local paths starting with /' });
        }
        const port = req.socket.localPort;
        for (const url of validUrls) {
          await openUrl(`http://localhost:${port}${url}`);
        }
        res.json({ success: true, opened: validUrls.length });
      } catch (error) {
        logger.error('Bulk open failed:', error);
        res.status(500).json({ error: 'Failed to open URLs' });
      }
    });

    // PR display route - serves pr.html if review data exists, setup.html otherwise
    app.get('/pr/:owner/:repo/:number', async (req, res) => {
      const { owner, repo, number } = req.params;
      const prNumber = parseInt(number, 10);
      if (isNaN(prNumber)) {
        return res.sendFile(path.join(__dirname, '..', 'public', 'pr.html'));
      }
      const repository = normalizeRepository(owner, repo);
      try {
        const existing = await queryOne(db, 'SELECT id FROM pr_metadata WHERE pr_number = ? AND repository = ? COLLATE NOCASE', [prNumber, repository]);
        if (existing) {
          // PR metadata exists, but verify the worktree is still present.
          // When a user deletes a worktree, metadata is preserved but the
          // worktree record is removed. Without this check the route serves
          // pr.html for a missing worktree, causing 404s on file fetches.
          const worktree = await queryOne(db, `
            SELECT w.id FROM worktrees w
            LEFT JOIN worktree_pool wp ON w.id = wp.id
            WHERE w.pr_number = ? AND w.repository = ? COLLATE NOCASE
              AND (wp.id IS NULL OR wp.status = 'in_use')
          `, [prNumber, repository]);
          if (worktree) {
            // Update last_accessed_at so the recent reviews list reflects actual access
            run(db, 'UPDATE pr_metadata SET last_accessed_at = ? WHERE id = ?', [new Date().toISOString(), existing.id]).catch(err => logger.warn(`Failed to update last_accessed_at: ${err.message}`));
            // Persist an explicit ?host correction BEFORE serving so pr.html's
            // first data fetch resolves the binding against the corrected host.
            // Never let a bad hint break the page — the helper swallows and warns.
            try {
              await applyHostQueryCorrection(db, config, owner, repo, repository, prNumber, req.query.host);
            } catch (err) {
              logger.warn(`Failed to apply ?host correction for ${repository} #${prNumber}: ${err.message}`);
            }
            res.sendFile(path.join(__dirname, '..', 'public', 'pr.html'));
          } else {
            logger.info(`PR metadata exists but no worktree for ${repository} #${prNumber}, serving setup page`);
            res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
          }
        } else {
          res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
        }
      } catch (error) {
        logger.error('Failed to query pr_metadata for PR route, falling back to pr.html:', error.message);
        res.sendFile(path.join(__dirname, '..', 'public', 'pr.html'));
      }
    });

    // Global settings route - serves settings.html. MUST be registered before
    // the two-segment `/settings/:owner/:repo` repo-settings route so the bare
    // `/settings` path is not swallowed by param matching.
    app.get('/settings', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'public', 'settings.html'));
    });

    // Repository settings route - serves repo-settings.html
    app.get('/settings/:owner/:repo', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'public', 'repo-settings.html'));
    });

    // Local review setup route - serves setup.html for new local reviews via query param
    app.get('/local', (req, res) => {
      if (!req.query.path) {
        return res.redirect('/');
      }
      res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
    });

    // Local review route - serves local.html for local review mode
    app.get('/local/:reviewId', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'public', 'local.html'));
    });

    // Database identity digest for the headless delegation handshake. Computed
    // once at startup (the resolved DB path cannot change without a restart) so
    // the /health route stays allocation-free per request. The delegating CLI
    // compares this against its own computeDbId(resolveDbPath(config)) and only
    // delegates when they match — see src/utils/db-identity.js.
    const dbId = computeDbId(resolveDbPath(config));

    // Health check endpoint (also used by single-port detection)
    app.get('/health', (req, res) => {
      res.json(buildHealthPayload(dbId));
    });
    
    // Store database instance, GitHub token, and config for routes
    // (`globalSettings` was built and overlaid onto `config` above, right after
    // DB init, so latching consumers see the effective values.)
    app.set('db', db);
    app.set('githubToken', githubToken);
    app.set('config', config);
    app.set('globalSettings', globalSettings);
    // Per-run --provider/--model overrides, threaded explicitly from the CLI
    // entry points (main.js / local-review.js). Read per request by the analyze
    // routes; ranks above repo settings but below an explicit request body.
    app.set('cliOverrides', cliOverrides);

    // Create or reuse the worktree pool lifecycle instance.
    // When called from main.js, the shared instance (already rehydrated) is
    // passed in.  When running standalone, create and rehydrate a fresh one.
    let poolLifecycle = sharedPoolLifecycle;
    if (!poolLifecycle) {
      poolLifecycle = new WorktreePoolLifecycle(db, config);
      await poolLifecycle.resetAndRehydrate();
    }
    app.set('poolLifecycle', poolLifecycle);

    // API routes - split into focused modules
    // Order matters: more specific routes must be mounted before general ones
    // to ensure proper route matching
    const analysisRoutes = require('./routes/analyses');
    const worktreesRoutes = require('./routes/worktrees');
    const reviewsRoutes = require('./routes/reviews');
    const configRoutes = require('./routes/config');
    const prRoutes = require('./routes/pr');
    const localRoutes = require('./routes/local');
    const setupRoutes = require('./routes/setup');
    const mcpRoutes = require('./routes/mcp');
    const councilRoutes = require('./routes/councils');
    const chatRoutes = require('./routes/chat');
    const contextFilesRoutes = require('./routes/context-files');
    const githubCollectionsRoutes = require('./routes/github-collections');
    const bulkAnalysisConfigsRoutes = require('./routes/bulk-analysis-configs');
    const stackAnalysisRoutes = require('./routes/stack-analysis');
    const externalCommentsRoutes = require('./routes/external-comments');
    const settingsRoutes = require('./routes/settings');
    const snippetsRoutes = require('./routes/snippets');
    const { createSoundRouter } = require('./routes/sound');

    // Initialize chat session manager
    const ChatSessionManager = require('./chat/session-manager');
    chatSessionManager = new ChatSessionManager(db, config.chat_providers || {});
    app.chatSessionManager = chatSessionManager;

    // Mount specific routes first to ensure they match before general PR routes
    app.use('/', chatRoutes);
    app.use('/', analysisRoutes);
    app.use('/', councilRoutes);
    app.use('/', reviewsRoutes);
    app.use('/', contextFilesRoutes);
    app.use('/', configRoutes);
    app.use('/', worktreesRoutes);
    app.use('/', localRoutes);
    app.use('/', setupRoutes);
    app.use('/', mcpRoutes);
    app.use('/', githubCollectionsRoutes);
    app.use('/', bulkAnalysisConfigsRoutes);
    app.use('/', stackAnalysisRoutes);
    app.use('/', settingsRoutes);
    app.use('/', snippetsRoutes);
    // External-comments routes (GitHub PR review-comment sync + fetch) are
    // gated by the `external_comments` config flag. When disabled, the
    // router is not mounted so any GET/POST against `/api/reviews/*/
    // external-comments*` returns 404 — matching the frontend's intent that
    // the feature simply doesn't exist for that user.
    if (config.external_comments !== false) {
      app.use('/', externalCommentsRoutes);
    }
    app.use('/', createSoundRouter());
    app.use('/', prRoutes);
    
    // Error handling middleware
    app.use((error, req, res, next) => {
      console.error('Server error:', error);
      res.status(500).json({ error: 'Internal server error' });
    });
    
    // 404 handler
    app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
    
    // Find available port and start server
    const port = config.single_port !== false
      ? config.port  // single-port mode: use exact port, fail if unavailable
      : await findAvailablePort(app, config.port);

    // Check provider availability before accepting requests so /api/config
    // returns accurate pi_available on the very first request (avoids race
    // condition where the frontend fetches config before the cache is populated)
    const defaultProvider = config.default_provider || 'claude';
    try {
      // Sequential: checkAllProviders must finish first because it populates
      // the AI provider availability cache that checkAllChatProviders reads
      // (e.g. the pi chat provider calls getCachedAvailability('pi')).
      await checkAllProviders(defaultProvider);
      await checkAllChatProviders();
    } catch (err) {
      console.warn('Provider availability check failed:', err.message);
    }

    await new Promise((resolve, reject) => {
      server = app.listen(port, () => {
        console.log(`Server running on http://localhost:${port}`);
        attachWebSocket(server, db, poolLifecycle);
        resolve();
      });

      // .once instead of .on: this handler detaches after firing exactly once,
      // so the post-startup handler below doesn't double-handle EADDRINUSE/EACCES
      // during the initial bind.
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && config.single_port !== false) {
          reject(new Error(
            `Port ${port} is already in use. A pair-review server may already be running, ` +
            `or another service is using this port. ` +
            `Set "single_port": false in ~/.pair-review/config.json to use automatic port selection.`
          ));
        } else {
          reject(error);
        }
      });
    });

    // Post-startup error handler. Express middleware handles request-level errors,
    // so this only fires for lower-level issues like accept-loop failures (EMFILE,
    // ENFILE from file descriptor exhaustion). Log but do NOT process.exit — the
    // old code did that and it was too aggressive for transient errors.
    server.on('error', (error) => {
      console.error('Server error after startup:', error);
    });

    // Return the actual port the server started on
    return port;

  } catch (error) {
    console.error('Failed to start server:', error.message);
    
    // Check for specific error conditions
    if (error.message.includes('public') || error.code === 'ENOENT') {
      console.error('Public directory not found');
      process.exit(1);
    }
    
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal) {
  console.log('\nServer shutting down...');

  // Close all active chat sessions
  if (chatSessionManager) {
    try {
      await chatSessionManager.closeAll();
    } catch (error) {
      console.error('Error closing chat sessions:', error.message);
    }
  }

  closeAllWS();

  if (server) {
    server.close(() => {
      if (db) {
        db.close((error) => {
          if (error) {
            console.error('Error closing database:', error.message);
          }
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });
    
    // Force exit after 5 seconds if graceful shutdown fails
    setTimeout(() => {
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 5000);
  } else {
    process.exit(0);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the server if this file is run directly
if (require.main === module) {
  startServer();
}

module.exports = { startServer, applyEnvOverrides, applyHostQueryCorrection, buildHealthPayload };
// ---- live-validation filler block (throwaway PR, do not merge) ----
// live-validation filler line 1
// live-validation filler line 2
// live-validation filler line 3
// live-validation filler line 4
// live-validation filler line 5
// live-validation filler line 6
// live-validation filler line 7
// live-validation filler line 8
// live-validation filler line 9
// live-validation filler line 10
// live-validation filler line 11
// live-validation filler line 12
// live-validation filler line 13
// live-validation filler line 14
// live-validation filler line 15
// live-validation filler line 16
// live-validation filler line 17
// live-validation filler line 18
// live-validation filler line 19
// live-validation filler line 20
// live-validation filler line 21
// live-validation filler line 22
// live-validation filler line 23
// live-validation filler line 24
// live-validation filler line 25
// live-validation filler line 26
// live-validation filler line 27
// live-validation filler line 28
// live-validation filler line 29
// live-validation filler line 30
// live-validation filler line 31
// live-validation filler line 32
// live-validation filler line 33
// live-validation filler line 34
// live-validation filler line 35
// live-validation filler line 36
// live-validation filler line 37
// live-validation filler line 38
// live-validation filler line 39
// live-validation filler line 40
// live-validation filler line 41
// live-validation filler line 42
// live-validation filler line 43
// live-validation filler line 44
// live-validation filler line 45
// live-validation filler line 46
// live-validation filler line 47
// live-validation filler line 48
// live-validation filler line 49
// live-validation filler line 50
// live-validation filler line 51
// live-validation filler line 52
// live-validation filler line 53
// live-validation filler line 54
// live-validation filler line 55
// live-validation filler line 56
// live-validation filler line 57
// live-validation filler line 58
// live-validation filler line 59
// live-validation filler line 60
// live-validation filler line 61
// live-validation filler line 62
// live-validation filler line 63
// live-validation filler line 64
// live-validation filler line 65
// live-validation filler line 66
// live-validation filler line 67
// live-validation filler line 68
// live-validation filler line 69
// live-validation filler line 70
// live-validation filler line 71
// live-validation filler line 72
// live-validation filler line 73
// live-validation filler line 74
// live-validation filler line 75
// live-validation filler line 76
// live-validation filler line 77
// live-validation filler line 78
// live-validation filler line 79
// live-validation filler line 80
// live-validation filler line 81
// live-validation filler line 82
// live-validation filler line 83
// live-validation filler line 84
// live-validation filler line 85
// live-validation filler line 86
// live-validation filler line 87
// live-validation filler line 88
// live-validation filler line 89
// live-validation filler line 90
// live-validation filler line 91
// live-validation filler line 92
// live-validation filler line 93
// live-validation filler line 94
// live-validation filler line 95
// live-validation filler line 96
// live-validation filler line 97
// live-validation filler line 98
// live-validation filler line 99
// live-validation filler line 100
// live-validation filler line 101
// live-validation filler line 102
// live-validation filler line 103
// live-validation filler line 104
// live-validation filler line 105
// live-validation filler line 106
// live-validation filler line 107
// live-validation filler line 108
// live-validation filler line 109
// live-validation filler line 110
// live-validation filler line 111
// live-validation filler line 112
// live-validation filler line 113
// live-validation filler line 114
// live-validation filler line 115
// live-validation filler line 116
// live-validation filler line 117
// live-validation filler line 118
// live-validation filler line 119
// live-validation filler line 120
// live-validation filler line 121
// live-validation filler line 122
// live-validation filler line 123
// live-validation filler line 124
// live-validation filler line 125
// live-validation filler line 126
// live-validation filler line 127
// live-validation filler line 128
// live-validation filler line 129
// live-validation filler line 130
// live-validation filler line 131
// live-validation filler line 132
// live-validation filler line 133
// live-validation filler line 134
// live-validation filler line 135
// live-validation filler line 136
// live-validation filler line 137
// live-validation filler line 138
// live-validation filler line 139
// live-validation filler line 140
// live-validation filler line 141
// live-validation filler line 142
// live-validation filler line 143
// live-validation filler line 144
// live-validation filler line 145
// live-validation filler line 146
// live-validation filler line 147
// live-validation filler line 148
// live-validation filler line 149
// live-validation filler line 150
// live-validation filler line 151
// live-validation filler line 152
// live-validation filler line 153
// live-validation filler line 154
// live-validation filler line 155
// live-validation filler line 156
// live-validation filler line 157
// live-validation filler line 158
// live-validation filler line 159
// live-validation filler line 160
// live-validation filler line 161
// live-validation filler line 162
// live-validation filler line 163
// live-validation filler line 164
// live-validation filler line 165
// live-validation filler line 166
// live-validation filler line 167
// live-validation filler line 168
// live-validation filler line 169
// live-validation filler line 170
// live-validation filler line 171
// live-validation filler line 172
// live-validation filler line 173
// live-validation filler line 174
// live-validation filler line 175
// live-validation filler line 176
// live-validation filler line 177
// live-validation filler line 178
// live-validation filler line 179
// live-validation filler line 180
// live-validation filler line 181
// live-validation filler line 182
// live-validation filler line 183
// live-validation filler line 184
// live-validation filler line 185
// live-validation filler line 186
// live-validation filler line 187
// live-validation filler line 188
// live-validation filler line 189
// live-validation filler line 190
// live-validation filler line 191
// live-validation filler line 192
// live-validation filler line 193
// live-validation filler line 194
// live-validation filler line 195
// live-validation filler line 196
// live-validation filler line 197
// live-validation filler line 198
// live-validation filler line 199
// live-validation filler line 200
// live-validation filler line 201
// live-validation filler line 202
// live-validation filler line 203
// live-validation filler line 204
// live-validation filler line 205
// live-validation filler line 206
// live-validation filler line 207
// live-validation filler line 208
// live-validation filler line 209
// live-validation filler line 210
// live-validation filler line 211
// live-validation filler line 212
// live-validation filler line 213
// live-validation filler line 214
// live-validation filler line 215
// live-validation filler line 216
// live-validation filler line 217
// live-validation filler line 218
// live-validation filler line 219
// live-validation filler line 220
// live-validation filler line 221
// live-validation filler line 222
// live-validation filler line 223
// live-validation filler line 224
// live-validation filler line 225
// live-validation filler line 226
// live-validation filler line 227
// live-validation filler line 228
// live-validation filler line 229
// live-validation filler line 230
// live-validation filler line 231
// live-validation filler line 232
// live-validation filler line 233
// live-validation filler line 234
// live-validation filler line 235
// live-validation filler line 236
// live-validation filler line 237
// live-validation filler line 238
// live-validation filler line 239
// live-validation filler line 240
// live-validation filler line 241
// live-validation filler line 242
// live-validation filler line 243
// live-validation filler line 244
// live-validation filler line 245
// live-validation filler line 246
// live-validation filler line 247
// live-validation filler line 248
// live-validation filler line 249
// live-validation filler line 250
// live-validation filler line 251
// live-validation filler line 252
// live-validation filler line 253
// live-validation filler line 254
// live-validation filler line 255
// live-validation filler line 256
// live-validation filler line 257
// live-validation filler line 258
// live-validation filler line 259
// live-validation filler line 260
// live-validation filler line 261
// live-validation filler line 262
// live-validation filler line 263
// live-validation filler line 264
// live-validation filler line 265
// live-validation filler line 266
// live-validation filler line 267
// live-validation filler line 268
// live-validation filler line 269
// live-validation filler line 270
// live-validation filler line 271
// live-validation filler line 272
// live-validation filler line 273
// live-validation filler line 274
// live-validation filler line 275
// live-validation filler line 276
// live-validation filler line 277
// live-validation filler line 278
// live-validation filler line 279
// live-validation filler line 280
// live-validation filler line 281
// live-validation filler line 282
// live-validation filler line 283
// live-validation filler line 284
// live-validation filler line 285
// live-validation filler line 286
// live-validation filler line 287
// live-validation filler line 288
// live-validation filler line 289
// live-validation filler line 290
// live-validation filler line 291
// live-validation filler line 292
// live-validation filler line 293
// live-validation filler line 294
// live-validation filler line 295
// live-validation filler line 296
// live-validation filler line 297
// live-validation filler line 298
// live-validation filler line 299
// live-validation filler line 300
