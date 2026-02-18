// SPDX-License-Identifier: GPL-3.0-or-later
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

/**
 * Drag a resize handle by a given horizontal delta.
 *
 * WHY dispatchEvent is needed: The AI panel resize handle is positioned at
 * left:-3px with width:6px, so its center overlaps with AI panel children
 * (e.g. .findings-summary) that sit in a separate stacking context.
 * Playwright's CDP mouse dispatch performs hit-testing and may deliver
 * mousedown to those children instead of the handle element. Dispatching
 * the mousedown event directly on the handle via JavaScript bypasses CDP
 * hit-testing entirely, ensuring the drag always starts on the correct
 * element. Subsequent mouse.move() calls are fine because the document-level
 * mousemove listener drives the resize once the drag has started.
 *
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @param {import('@playwright/test').Locator} handleLocator - Locator for the resize handle element
 * @param {number} deltaX - Horizontal pixels to drag (positive = right, negative = left)
 */
async function dragResizeHandle(page, handleLocator, deltaX) {
  const handleBox = await handleLocator.boundingBox();
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;

  // Dispatch mousedown directly on the handle to avoid CDP hit-testing issues
  await handleLocator.dispatchEvent('mousedown', {
    clientX: startX,
    clientY: startY,
    bubbles: true,
  });

  // Move in small increments so mousemove events fire reliably
  const steps = Math.max(Math.abs(Math.round(deltaX / 5)), 1);
  const stepSize = deltaX / steps;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + (i * stepSize), startY);
  }

  await page.mouse.up();
}

module.exports = {
  waitForDiffToRender,
  dragResizeHandle
};
