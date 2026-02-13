// SPDX-License-Identifier: GPL-3.0-or-later
const express = require('express');
const path = require('path');
const { loadConfig, getGitHubToken, resolveDbName, warnIfDevModeWithoutDbName } = require('./config');
const { initializeDatabase, getDatabaseStatus, queryOne, run } = require('./database');
const { normalizeRepository } = require('./utils/paths');
const { applyConfigOverrides, checkAllProviders } = require('./ai');
const logger = require('./utils/logger');

let db = null;
let server = null;
let chatSessionManager = null;

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
 */
async function startServer(sharedDb = null) {
  try {
    // Load configuration
    const { config } = await loadConfig();

    // Apply provider configuration overrides (custom models, commands, etc.)
    applyConfigOverrides(config);

    // Warn if dev mode is on without a custom database name
    warnIfDevModeWithoutDbName(config);

    // Get GitHub token (env var takes precedence over config)
    const githubToken = getGitHubToken(config);

    // Warn if no GitHub token is configured
    if (!githubToken) {
      console.warn('Warning: No GitHub token configured. Set GITHUB_TOKEN environment variable or add github_token to ~/.pair-review/config.json');
    }
    
    // Use shared database or initialize new one
    if (sharedDb) {
      console.log('Using shared database instance...');
      db = sharedDb;
    } else {
      console.log('Connecting to database...');
      db = await initializeDatabase(resolveDbName(config));
    }
    
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
          const worktree = await queryOne(db, 'SELECT id FROM worktrees WHERE pr_number = ? AND repository = ? COLLATE NOCASE', [prNumber, repository]);
          if (worktree) {
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

    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
    
    // Store database instance, GitHub token, and config for routes
    app.set('db', db);
    app.set('githubToken', githubToken);
    app.set('config', config);

    // API routes - split into focused modules
    // Order matters: more specific routes must be mounted before general ones
    // to ensure proper route matching
    const analysisRoutes = require('./routes/analysis');
    const worktreesRoutes = require('./routes/worktrees');
    const commentsRoutes = require('./routes/comments');
    const configRoutes = require('./routes/config');
    const prRoutes = require('./routes/pr');
    const localRoutes = require('./routes/local');
    const setupRoutes = require('./routes/setup');
    const mcpRoutes = require('./routes/mcp');
    const councilRoutes = require('./routes/councils');
    const chatRoutes = require('./routes/chat');

    // Initialize chat session manager
    const ChatSessionManager = require('./chat/session-manager');
    chatSessionManager = new ChatSessionManager(db);
    app.chatSessionManager = chatSessionManager;

    // Mount specific routes first to ensure they match before general PR routes
    app.use('/', chatRoutes);
    app.use('/', analysisRoutes);
    app.use('/', councilRoutes);
    app.use('/', commentsRoutes);
    app.use('/', configRoutes);
    app.use('/', worktreesRoutes);
    app.use('/', localRoutes);
    app.use('/', setupRoutes);
    app.use('/', mcpRoutes);
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
    const port = await findAvailablePort(app, config.port);

    server = app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);

      // Check provider availability in background after server is listening
      // Use the configured default provider as priority (if set)
      const defaultProvider = config.default_provider || 'claude';
      checkAllProviders(defaultProvider).catch(err => {
        console.warn('Background provider availability check failed:', err.message);
      });
    });

    server.on('error', (error) => {
      console.error('Server error:', error);
      process.exit(1);
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

module.exports = { startServer };