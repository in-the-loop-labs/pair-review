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

/**
 * Wait until at least one @pierre/diffs `<pre>` in the document reports the
 * given layout via its `data-diff-type` attribute.
 *
 * The vendor stamps the shadow `<pre>` with `data-diff-type="single"` for the
 * unified (single-column) layout and `data-diff-type="split"` for the
 * side-by-side layout. These are the authoritative vendor attribute values —
 * there is no `"unified"` value.
 *
 * @param {import('@playwright/test').Page} page
 * @param {('single'|'split')} diffType - Vendor value: 'single' = unified.
 * @param {number} [timeout=5000]
 */
async function waitForDiffType(page, diffType, timeout = 5000) {
  await page.waitForFunction((type) => {
    const hosts = document.querySelectorAll('diffs-container');
    for (const host of hosts) {
      if (host.shadowRoot && host.shadowRoot.querySelector(`pre[data-diff-type="${type}"]`)) {
        return true;
      }
    }
    return false;
  }, diffType, { timeout });
}

/**
 * Switch the diff layout via the gear (#diff-options-btn) → "Diff view"
 * segmented control, then wait for the new layout to take effect. The popover
 * is dismissed afterward (Escape) so it cannot intercept later interactions.
 *
 * @param {import('@playwright/test').Page} page
 * @param {('unified'|'split')} mode
 */
async function setDiffView(page, mode) {
  const gearBtn = page.locator('#diff-options-btn');
  await gearBtn.click();
  const option = page.locator(`.diff-view-option[data-diff-view="${mode}"]`);
  await option.waitFor({ state: 'visible', timeout: 5000 });
  await option.click();
  // Close the popover so it can't sit over the toolbar/diff and swallow clicks.
  await page.keyboard.press('Escape');
  await waitForDiffType(page, mode === 'split' ? 'split' : 'single');
}

/**
 * Hover a specific line's number cell in split (side-by-side) layout.
 *
 * Split renders two independent code columns — `code[data-deletions]` (left /
 * old) and `code[data-additions]` (right / new) — and each visual row has a
 * `[data-column-number]` cell in BOTH columns, so the unified `nth(lineIndex)`
 * approach in {@link hoverDiffLine} does not address a specific side. This
 * helper scopes to the requested column so the gutter buttons reveal on the
 * intended side.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} opts
 * @param {string} opts.fileName - e.g. 'src/utils.js'
 * @param {number} opts.line - The line number as shown in that column's gutter
 * @param {('additions'|'deletions'|'RIGHT'|'LEFT')} [opts.side='additions']
 * @returns {import('@playwright/test').Locator} the hovered line-number cell
 */
async function hoverSplitDiffLine(page, { fileName, line, side = 'additions' }) {
  const isDeletions = side === 'deletions' || side === 'LEFT';
  const column = isDeletions ? 'code[data-deletions]' : 'code[data-additions]';
  const cell = page
    .locator(`.d2h-file-wrapper[data-file-name="${fileName}"] ${column} [data-column-number="${line}"]`)
    .first();
  await cell.hover();
  return cell;
}

/**
 * Open a comment form on a specific line + side in split layout: hover the
 * column's line-number cell to reveal the gutter comment button, click it, and
 * wait for the form. Mirrors {@link openCommentFormOnLine} but is split/side
 * aware.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} opts - Same shape as {@link hoverSplitDiffLine}
 */
async function openSplitCommentForm(page, { fileName, line, side = 'additions' }) {
  await hoverSplitDiffLine(page, { fileName, line, side });
  const addCommentBtn = page
    .locator(`.d2h-file-wrapper[data-file-name="${fileName}"] .pierre-comment-btn`)
    .first();
  await addCommentBtn.waitFor({ state: 'visible', timeout: 5000 });
  await addCommentBtn.click();
  await page.waitForSelector('.user-comment-form', { timeout: 5000 });
}

/**
 * Wait until the annotation (comment / suggestion / summary) whose text
 * contains `text` is physically slotted into the given split column.
 *
 * Annotations live in the light DOM inside a `[data-annotation-slot]` wrapper
 * that carries a `slot="annotation-<side>-<line>"` attribute; the vendor's
 * matching `<slot>` element lives inside the corresponding `code[data-<side>]`
 * column in the shadow DOM. Reading `wrapper.assignedSlot` and walking up to the
 * column proves the annotation renders in the correct column — the per-column
 * (half-width) split behaviour — rather than merely being present in the page.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} opts
 * @param {string} opts.text - Substring identifying the annotation
 * @param {('additions'|'deletions')} opts.column
 * @param {number} [opts.timeout=5000]
 */
async function expectAnnotationInSplitColumn(page, { text, column, timeout = 5000 }) {
  await page.waitForFunction(({ text: needle, column: col }) => {
    const rows = document.querySelectorAll(
      '.user-comment-row, .ai-suggestion-row, .ai-suggestion, .hunk-summary-row'
    );
    const row = [...rows].find((r) => (r.textContent || '').includes(needle));
    if (!row) return false;
    const wrapper = row.closest('[data-annotation-slot]') || row.parentElement;
    const slot = wrapper && wrapper.assignedSlot;
    if (!slot) return false;
    return !!slot.closest(`code[data-${col}]`);
  }, { text, column }, { timeout });
}

module.exports = {
  waitForDiffToRender,
  hoverDiffLine,
  openCommentFormOnLine,
  dragResizeHandle,
  waitForDiffType,
  setDiffView,
  hoverSplitDiffLine,
  openSplitCommentForm,
  expectAnnotationInSplitColumn
};
