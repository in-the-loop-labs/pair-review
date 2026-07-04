// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared E2E Test Helpers
 *
 * Common utility functions used across E2E test spec files.
 * Centralizing these helpers ensures consistent behavior and easier maintenance.
 */

/**
 * Wait for the @pierre/diffs view to finish rendering a file.
 * Resolves once at least one file wrapper is present and at least one
 * code line has been rendered inside a diffs-container shadow DOM.
 *
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @param {number} [timeout=10000] - Maximum wait time in milliseconds
 */
async function waitForDiffToRender(page, timeout = 10000) {
  await page.waitForSelector('[data-file-name]', { timeout });
  await page.waitForSelector('.pierre-diff-body diffs-container', { timeout });
  await page.waitForFunction(() => {
    const hosts = document.querySelectorAll('diffs-container');
    for (const host of hosts) {
      if (host.shadowRoot && host.shadowRoot.querySelector('[data-line]')) return true;
    }
    return false;
  }, null, { timeout });
}

/**
 * Hover the Nth line-number cell in the diff to reveal the gutter buttons.
 * @param {import('@playwright/test').Page} page
 * @param {number} [lineIndex=0]
 */
async function hoverDiffLine(page, lineIndex = 0) {
  const lineNumberCell = page.locator('[data-column-number]').nth(lineIndex);
  await lineNumberCell.hover();
  return lineNumberCell;
}

/**
 * Open a comment form on a specific diff line by hovering to reveal the
 * gutter comment button, then clicking it. Waits for the form to appear.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [lineIndex=0]
 */
async function openCommentFormOnLine(page, lineIndex = 0) {
  await hoverDiffLine(page, lineIndex);
  const addCommentBtn = page.locator('.pierre-comment-btn').first();
  await addCommentBtn.waitFor({ state: 'visible', timeout: 5000 });
  await addCommentBtn.click();
  await page.waitForSelector('.user-comment-form', { timeout: 5000 });
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
  hoverDiffLine,
  openCommentFormOnLine,
  dragResizeHandle
};
