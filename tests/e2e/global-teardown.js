// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Playwright Global Teardown
 *
 * Shuts down the test server after all tests complete.
 *
 * Design Decision: We rely on process exit for cleanup rather than explicit shutdown.
 *
 * Rationale:
 * - The test server runs in the same Node process as Playwright's global setup
 * - When Playwright completes (or is interrupted), the process exits
 * - Node.js automatically closes the Express server and in-memory SQLite database on exit
 * - This approach is simpler and more reliable than explicit cleanup:
 *   - No race conditions between server shutdown and test completion
 *   - No need to export/import server references across modules
 *   - Handles SIGINT/SIGTERM gracefully (process exit triggers cleanup)
 *
 * Trade-offs:
 * - If tests are restructured to run in separate processes, explicit cleanup would be needed
 * - Port may briefly remain in TIME_WAIT state after process exits (not an issue with fresh port)
 *
 * The global-setup.js stores process.env.E2E_SERVER_PID for debugging purposes.
 */

async function globalTeardown() {
  console.log('Shutting down E2E test server...');
  // Server and database are cleaned up automatically when the Node process exits.
  // This is intentional - explicit cleanup is unnecessary for single-process architecture.
}

module.exports = globalTeardown;
