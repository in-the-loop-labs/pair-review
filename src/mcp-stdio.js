// SPDX-License-Identifier: GPL-3.0-or-later
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
 */
function redirectConsoleToStderr() {
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  logger.setOutputStream(process.stderr);
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

  const db = await initializeDatabase(resolveDbName(config));
  const port = await startServer(db);

  const mcpServer = createMCPServer(db, { port, config });
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error(`[MCP] Web UI: http://localhost:${port}`);
  console.error('[MCP] stdio transport connected');
}

module.exports = { redirectConsoleToStderr, startMCPStdio };
