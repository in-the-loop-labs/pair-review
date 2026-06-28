// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * MCP stdio transport orchestrator.
 *
 * Starts pair-review as a stdio MCP server for AI coding agents while also
 * launching the Express web server for the human reviewer. Both share the
 * same SQLite database.
 *
 * CRITICAL: stdout is reserved for MCP JSON-RPC messages.
 * All logging MUST go to stderr before any other code runs.
 */

const logger = require('./utils/logger');

/**
 * Redirect all console output and logger writes to stderr.
 * Must be called before any other module logs to stdout.
 *
 * Also sets `PAIR_REVIEW_QUIET_STDOUT=1` so that code which writes directly to
 * `process.stdout` (bypassing console/logger) can detect that stdout is reserved
 * and route its output to stderr instead. The only such path today is the child
 * stdout of a configured checkout script (`executeCheckoutScript`,
 * src/git/worktree.js). In both modes that call this function — MCP stdio (stdout
 * is JSON-RPC) and headless `--json` (stdout is the JSON document) — keeping that
 * child output off stdout is the correct, desired behavior.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.quiet=false] - When true (headless `--json` without
 *   `--debug`), *drop* progress narration entirely rather than relocating it to
 *   stderr. A coding agent's shell tool captures stderr into its context window,
 *   so relocated narration still costs tokens; quiet mode no-ops the ungated
 *   `console.log/info` narration and puts the logger into quiet mode
 *   (suppressing info/success/log/section). `console.warn`, `console.error`,
 *   `logger.warn`, and `logger.error` still emit to stderr — quiet drops only
 *   progress narration and never swallows warnings/errors.
 */
function redirectConsoleToStderr({ quiet = false } = {}) {
  if (quiet) {
    // Drop ungated narration; keep console.error real (→ stderr).
    const noop = () => {};
    console.log = noop;
    console.info = noop;
    // console.warn carries genuine diagnostics agents need (e.g. the
    // --council/--model advisory, worktree-migration warnings) — route it to
    // stderr rather than swallowing it. Quiet drops progress narration only.
    console.warn = console.error;
    // logger.warn writes to _stdout — point it at stderr so a warning during a
    // run never corrupts the JSON document on real stdout.
    logger.setOutputStream(process.stderr);
    logger.setQuietEnabled(true);
  } else {
    console.log = console.error;
    console.info = console.error;
    console.warn = console.error;
    logger.setOutputStream(process.stderr);
  }
  // Process-level signal for raw process.stdout.write paths (see JSDoc above).
  process.env.PAIR_REVIEW_QUIET_STDOUT = '1';
}

/**
 * Start the MCP stdio server alongside the Express web UI.
 */
async function startMCPStdio() {
  // FIRST — redirect before anything logs
  redirectConsoleToStderr();

  const { initializeDatabase } = require('./database');
  const { startServer } = require('./server');
  const { loadConfig, resolveDbName } = require('./config');
  const { createMCPServer } = require('./routes/mcp');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

  // Load config BEFORE database so we can resolve db_name
  let config = {};
  try {
    const loaded = await loadConfig();
    config = loaded.config || {};
  } catch (err) {
    console.error(`[MCP] Warning: failed to load config, using defaults: ${err.message}`);
  }

  // MCP mode needs its own Express server for stdio↔HTTP bridging and cannot
  // delegate to a running pair-review instance (the stdio transport owns this
  // process). Force auto-port selection to avoid EADDRINUSE when a regular
  // pair-review server is already running on config.port.
  // startServer (src/server.js) reads this env var and flips config.single_port.
  process.env.PAIR_REVIEW_SINGLE_PORT = 'false';

  const db = await initializeDatabase(resolveDbName(config));
  const port = await startServer(db);

  const mcpServer = createMCPServer(db, { port, config });
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error(`[MCP] Web UI: http://localhost:${port}`);
  console.error('[MCP] stdio transport connected');
}

module.exports = { redirectConsoleToStderr, startMCPStdio };
