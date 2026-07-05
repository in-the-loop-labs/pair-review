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
 * Wait until EVERY rendered @pierre/diffs `<pre>` reports the given layout via
 * its `data-diff-type` attribute (or, when `fileName` is supplied, only the
 * host inside that file wrapper).
 *
 * The vendor stamps the shadow `<pre>` with `data-diff-type="single"` for the
 * unified (single-column) layout and `data-diff-type="split"` for the
 * side-by-side layout. These are the authoritative vendor attribute values —
 * there is no `"unified"` value.
 *
 * WHY "every host": multi-file pages mount one `diffs-container` per file and
 * they rerender independently on a layout toggle. Resolving as soon as ONE host
 * reports the new layout races the others, so `setDiffView()`'s completion gate
 * can fire while a second file is still mid-rerender. Requiring all hosts (and
 * that each has actually rendered its `<pre>`) makes the gate reliable.
 *
 * @param {import('@playwright/test').Page} page
 * @param {('single'|'split')} diffType - Vendor value: 'single' = unified.
 * @param {number} [timeout=5000]
 * @param {Object} [opts]
 * @param {string} [opts.fileName] - Scope the wait to a single file wrapper.
 */
async function waitForDiffType(page, diffType, timeout = 5000, { fileName } = {}) {
  await page.waitForFunction(({ type, file }) => {
    const scope = file
      ? document.querySelector(`.d2h-file-wrapper[data-file-name="${file}"]`)
      : document;
    if (!scope) return false;
    const hosts = scope.querySelectorAll('diffs-container');
    if (hosts.length === 0) return false;
    for (const host of hosts) {
      const pre = host.shadowRoot && host.shadowRoot.querySelector('pre[data-diff-type]');
      // Host has not rendered its <pre> yet, or still reports the old layout.
      if (!pre || pre.getAttribute('data-diff-type') !== type) return false;
    }
    return true;
  }, { type: diffType, file: fileName || null }, { timeout });
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
  const isDeletions = side === 'deletions' || side === 'LEFT';
  await hoverSplitDiffLine(page, { fileName, line, side });

  // In split, PierreBridge's fallback positioner pins the single per-file gutter
  // container over the hovered line with position:fixed (viewport coordinates),
  // moving it out of the vendor slot — so it is neither a DOM descendant of the
  // shadow `code[data-<side>]` column (a CSS selector can't scope by column)
  // nor slot-assigned (`assignedSlot` is null). Instead, gate on the button
  // being horizontally on the REQUESTED side of the split `<pre>` (additions =
  // RIGHT, deletions = LEFT) before clicking, so a button still positioned over
  // the OTHER column from a prior hover can't be the one we act on. The columns
  // themselves are `display:contents` (zero-size rects), hence the pre midpoint.
  await page.waitForFunction(({ file, wantLeft }) => {
    const wrapper = document.querySelector(`.d2h-file-wrapper[data-file-name="${file}"]`);
    const btn = wrapper && wrapper.querySelector('.pierre-comment-btn');
    if (!btn) return false;
    const r = btn.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const pre = wrapper.querySelector('diffs-container')?.shadowRoot
      ?.querySelector('pre[data-diff-type="split"]');
    if (!pre) return false;
    const pr = pre.getBoundingClientRect();
    const mid = pr.left + pr.width / 2;
    const center = r.left + r.width / 2;
    return wantLeft ? center < mid : center > mid;
  }, { file: fileName, wantLeft: isDeletions }, { timeout: 5000 });

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

/**
 * Dismiss the council progress modal if it is currently blocking interactions.
 * This can happen when a previous test triggered an analysis that is still
 * running (or completed but the modal wasn't closed), causing the page to
 * auto-show it — or when {@link seedAISuggestions}'s POST re-shows it.
 *
 * Prefers the "Run in Background" button (hides without cancelling); falls back
 * to hiding via JS if the button isn't present, then waits for the hidden state.
 *
 * @param {import('@playwright/test').Page} page
 */
async function dismissProgressModalIfVisible(page) {
  const progressModal = page.locator('#council-progress-modal');
  const isVisible = await progressModal.isVisible();
  if (isVisible) {
    // Click the "Run in Background" button to hide the modal without cancelling
    const bgBtn = progressModal.locator('.council-bg-btn, button:has-text("Background")').first();
    const bgBtnVisible = await bgBtn.isVisible().catch(() => false);
    if (bgBtnVisible) {
      await bgBtn.click();
    } else {
      // Fallback: directly hide via JS
      await page.evaluate(() => {
        const modal = document.getElementById('council-progress-modal');
        if (modal) modal.style.display = 'none';
      });
    }
    await progressModal.waitFor({ state: 'hidden', timeout: 3000 });
  }
}

/**
 * Pre-seed AI suggestions by POSTing to the PR analyses endpoint (which the E2E
 * harness mocks to insert deterministic suggestions into the DB), waiting for
 * the run to finish, reloading suggestions into the DOM, and waiting for them to
 * render. All five original inline copies targeted the same hardcoded PR
 * endpoint (test-owner/test-repo/1); their divergences are exposed as options.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} [opts]
 * @param {number} [opts.statusTimeout=30000] - Deadline for the analysis-status
 *   poll. NOTE: four of the five original copies wrote this timeout as
 *   `waitForFunction(fn, { timeout })`, where Playwright treats the object as the
 *   function *arg*, not options — so they actually polled with the default 30s.
 *   30000 preserves that dominant effective behavior. Only the split-view copy
 *   placed options correctly (5s); it becomes more generous here, which only
 *   affects the failure path (success resolves as soon as the run completes).
 * @param {string} [opts.suggestionSelector='.ai-suggestion, [data-suggestion-id]']
 *   - Selector awaited to confirm suggestions rendered.
 * @param {boolean} [opts.dismissProgressModal=true] - Dismiss the council
 *   progress modal the POST re-shows so it can't intercept later clicks. The
 *   ai-summary-modal spec opts out (its original copy never dismissed).
 */
async function seedAISuggestions(page, {
  statusTimeout = 30000,
  suggestionSelector = '.ai-suggestion, [data-suggestion-id]',
  dismissProgressModal = true
} = {}) {
  // Make a direct POST request to trigger analysis and verify success
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/pr/test-owner/test-repo/1/analyses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!response.ok) {
      throw new Error(`Analysis API failed: ${response.status}`);
    }
    return response.json();
  });

  if (!result.analysisId) {
    throw new Error('Analysis failed to start: no analysisId returned');
  }

  // Wait for analysis to complete by polling the status endpoint
  await page.waitForFunction(
    async () => {
      const reviewId = window.prManager?.currentPR?.id;
      if (!reviewId) return false;
      const response = await fetch(`/api/reviews/${reviewId}/analyses/status`);
      const status = await response.json();
      return !status.running;
    },
    null,
    { timeout: statusTimeout }
  );

  // Reload suggestions and wait for them to appear in the DOM
  await page.evaluate(async () => {
    if (window.prManager?.loadAISuggestions) {
      await window.prManager.loadAISuggestions();
    }
  });

  // Wait for at least one AI suggestion to render
  await page.waitForSelector(suggestionSelector, { timeout: 5000 });

  // Dismiss the progress modal if it appeared (the POST triggers the modal via
  // the running-analysis check on the frontend, and it can linger long enough to
  // intercept pointer events on suggestion action buttons).
  if (dismissProgressModal) {
    await dismissProgressModalIfVisible(page);
  }
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
  expectAnnotationInSplitColumn,
  dismissProgressModalIfVisible,
  seedAISuggestions
};
