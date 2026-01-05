/**
 * Playwright Global Teardown
 *
 * Shuts down the test server after all tests complete.
 */

async function globalTeardown() {
  console.log('Shutting down E2E test server...');
  // The server will be cleaned up automatically when the process exits
  // This is intentional - keeping it simple
}

module.exports = globalTeardown;
