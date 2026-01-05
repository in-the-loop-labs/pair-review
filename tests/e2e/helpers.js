/**
 * Shared E2E Test Helpers
 *
 * Common utility functions used across E2E test spec files.
 * Centralizing these helpers ensures consistent behavior and easier maintenance.
 */

/**
 * Wait for the diff view to fully render.
 * Waits for file sections and diff lines to be present in the DOM.
 *
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @param {number} [timeout=10000] - Maximum wait time in milliseconds
 */
async function waitForDiffToRender(page, timeout = 10000) {
  // Wait for diff container to have content (file sections)
  await page.waitForSelector('[data-file-name]', { timeout });
  // Wait for at least one diff line to render
  await page.waitForSelector('.d2h-code-line-ctn', { timeout });
}

module.exports = {
  waitForDiffToRender
};
