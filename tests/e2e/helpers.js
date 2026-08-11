// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared E2E Test Helpers
 *
 * Common utility functions used across E2E test spec files.
 * Centralizing these helpers ensures consistent behavior and easier maintenance.
 */

const { expect } = require('@playwright/test');

/**
 * Wait for the @pierre/diffs CodeView to finish rendering the diff list.
 *
 * Under the single-CodeView render path there are no per-file `.pierre-diff-body`
 * cards: `#diff-container` becomes the virtualized scroll root
 * (`.pierre-codeview-root`) and CodeView mounts one pooled `<diffs-container>`
 * host per on-screen file. This resolves once the root is the CodeView root and
 * at least one mounted host has rendered a code line inside its shadow DOM.
 *
 * NOTE: only files near the viewport mount. To assert on a file that may be
 * scrolled out of view, use {@link scrollFileIntoView} first — the virtualizer
 * will not have mounted it, and its host/shadow rows will not exist yet.
 *
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @param {number} [timeout=10000] - Maximum wait time in milliseconds
 */
async function waitForDiffToRender(page, timeout = 10000) {
  await page.waitForSelector('#diff-container.pierre-codeview-root', { timeout });
  await page.waitForFunction(() => {
    const hosts = document.querySelectorAll('diffs-container');
    for (const host of hosts) {
      if (host.shadowRoot && host.shadowRoot.querySelector('[data-line]')) return true;
    }
    return false;
  }, null, { timeout });
}

/**
 * Scroll a changed file into the virtualized viewport so its CodeView item
 * mounts, then wait for its stamped host + at least one rendered code line.
 *
 * WHY this exists: CodeView virtualizes the whole file list and mounts only the
 * items near the scroll position, recycling the pooled `<diffs-container>` hosts
 * as items enter/leave view. A file that is off-screen has no host and no shadow
 * rows, so any per-file selector (`.d2h-file-wrapper[data-file-name=...]`, gutter
 * buttons, annotations) resolves to nothing until the file is scrolled in. This
 * drives the bridge's `scrollToFile` (instant, not smooth, for determinism) and
 * waits for the host to mount and paint.
 *
 * The bridge stamps each mounted host with `data-file-name` + `.d2h-file-wrapper`
 * (context-file hosts additionally get `.context-file`); this resolves the diff
 * host for `fileName` and excludes any same-path context host (fix #540).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} fileName - e.g. 'src/utils.js'
 * @param {Object} [opts]
 * @param {number} [opts.timeout=10000]
 * @returns {import('@playwright/test').Locator} the file's host wrapper locator
 */
async function scrollFileIntoView(page, fileName, { timeout = 10000 } = {}) {
  await page.evaluate((fn) => {
    const bridge = window.prManager && window.prManager.pierreBridge;
    if (bridge && bridge.scrollToFile) {
      bridge.scrollToFile(fn, { behavior: 'auto', align: 'start' });
    }
  }, fileName);
  await page.waitForFunction((fn) => {
    const host = document.querySelector(
      `diffs-container[data-file-name="${fn}"]:not(.context-file)`
    );
    return !!(host && host.shadowRoot && host.shadowRoot.querySelector('[data-line]'));
  }, fileName, { timeout });
  return page.locator(`.d2h-file-wrapper[data-file-name="${fileName}"]:not(.context-file)`);
}

/**
 * Scroll a file OUT of the virtualization window so its CodeView item unmounts
 * (host removed from the DOM), then wait for the host to disappear. The
 * counterpart to {@link scrollFileIntoView} — used to exercise remount
 * data-integrity: mutate a file's annotations, evict it, scroll it back, and
 * assert the item rebuilds from data (no resurrection / stale text).
 *
 * NOTE: eviction only happens when the diff is tall enough that the target
 * genuinely leaves the render window — the seeded 2-file diff both fit on
 * screen and never unmount, so callers must first make one file large (see
 * lazy-diff's mockLargeMainDiff) so its sibling evicts when scrolled away.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} fileName
 * @param {Object} [opts]
 * @param {number} [opts.timeout=10000]
 */
async function scrollFileOutOfView(page, fileName, { timeout = 10000 } = {}) {
  // RE-DRIVE the scroll on every poll instead of scrolling once and then only
  // watching: a one-shot scrollTop loses races (an in-flight smooth nav settle
  // from a preceding jump-to-comment, or a re-render, can restore the old
  // position) and the wait then burns its whole budget watching a file that is
  // back on screen. Each frame re-measures and re-applies the target, so the
  // eviction is driven until it actually happens.
  await page.waitForFunction((fn) => {
    const root = document.getElementById('diff-container');
    if (!root) return true;
    // Same `:not(.context-file)` qualifier as scrollFileIntoView (#540): a
    // context host can share this path, and measuring ITS geometry would pick the
    // wrong scroll direction and leave the diff host mounted.
    const host = document.querySelector(
      `diffs-container[data-file-name="${fn}"]:not(.context-file)`
    );
    if (!host) return true; // unmounted — evicted
    // Scroll to whichever END of the content is farthest from the file, so the
    // virtualizer evicts it. Decide in CONTENT coordinates (the item's absolute
    // top vs the content midpoint), not from where the host currently sits in the
    // viewport: content coords don't change as we scroll, so the chosen direction
    // is the same on every poll. (Viewport-relative geometry flips as the page
    // moves, and for the LAST file it picks "scroll to the bottom" — which keeps
    // that file on screen forever.)
    const itemTop = window.prManager?.pierreBridge?.codeView?.getTopForItem?.(fn);
    const contentTop = Number.isFinite(itemTop)
      ? itemTop
      : root.scrollTop + (host.getBoundingClientRect().top - root.getBoundingClientRect().top);
    root.scrollTop = contentTop > root.scrollHeight / 2 ? 0 : root.scrollHeight;
    return false;
  }, fileName, { timeout });
}

/**
 * Wait until the CodeView has finished slotting a file's annotations into the
 * light DOM. Under CodeView, `bridge.addAnnotation(...)` publishes the item and
 * the vendor slots the `[data-annotation-slot]` wrappers on a LATER animation
 * frame — so reading the annotation DOM synchronously after an add (or after a
 * save/edit/delete round-trip) races the render. This bridges to the bridge's
 * deterministic `whenAnnotationsSlotted(file)` affordance so tests can await the
 * slot instead of polling the DOM (which under parallel-load CPU contention can
 * observe an intermediate, mid-rerender state).
 *
 * Resolves once the file's annotations are slotted, or reports the file is not
 * currently mounted (virtualized out) — it never hangs. Returns the bridge
 * result `{ mounted, slotted, reason? }`.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} fileName - diff-item id; use `context:<path>` for context files
 * @param {Object} [opts]
 * @param {number} [opts.maxFrames] - frame budget for a not-yet-mounted item
 * @returns {Promise<{mounted: boolean, slotted: boolean, reason?: string}>}
 */
async function waitForAnnotationsSlotted(page, fileName, { maxFrames } = {}) {
  return page.evaluate(async ({ fn, frames }) => {
    const bridge = window.prManager && window.prManager.pierreBridge;
    if (!bridge || typeof bridge.whenAnnotationsSlotted !== 'function') {
      return { mounted: false, slotted: false, reason: 'no-bridge' };
    }
    return bridge.whenAnnotationsSlotted(fn, frames != null ? { maxFrames: frames } : {});
  }, { fn: fileName, frames: maxFrames ?? null });
}

/**
 * `page.waitForResponse` that cannot take the whole worker down.
 *
 * The wait has to be REGISTERED before the action that triggers the response, so
 * there is always a window between registration and the `await`. If any step in
 * that window fails — a click that times out, a failed assertion, or the test
 * deadline — the still-pending promise rejects with nothing attached to it. That
 * is an unhandled rejection, and it does not just fail the test: it kills the
 * Playwright worker process (`worker process exited unexpectedly (code=1)`), so
 * every remaining test in the file is reported failed at 0ms and the run's
 * failure set reshuffles depending on which worker died. Observed on
 * codeview-behaviors' file-comment flow.
 *
 * Attaching a no-op catch marks the rejection handled. Awaiting the SAME promise
 * afterwards still observes it, so a genuinely missing response still fails the
 * test at the await site — nothing is swallowed.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string|Function} urlOrPredicate - as passed to page.waitForResponse
 * @param {Object} [options] - as passed to page.waitForResponse
 * @returns {Promise<import('@playwright/test').Response>}
 */
function expectResponse(page, urlOrPredicate, options) {
  const promise = page.waitForResponse(urlOrPredicate, options);
  promise.catch(() => {});
  return promise;
}

/**
 * `page.waitForRequest` with the same worker-killing rejection guarded as in
 * {@link expectResponse} — identical registration-then-await shape.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string|Function} urlOrPredicate
 * @param {Object} [options]
 * @returns {Promise<import('@playwright/test').Request>}
 */
function expectRequest(page, urlOrPredicate, options) {
  const promise = page.waitForRequest(urlOrPredicate, options);
  promise.catch(() => {});
  return promise;
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
 * Re-hover `cell` until `button` reports a non-zero bounding box.
 *
 * The vendor's gutter-utility reveals the +/chat gutter buttons only while
 * their row is hovered and sizes the container on the next frame; an async
 * re-render (the ~1s content upgrade, Local mode's post-load diff refresh) can
 * rebuild the row out from under a ONE-SHOT hover so the button never becomes
 * visible for a plain `toBeVisible` that follows. Re-driving the hover on each
 * poll re-establishes the reveal — every poll is a genuine hover, nothing is
 * forced.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} opts
 * @param {import('@playwright/test').Locator} opts.cell - the line-number cell
 *   (or row) to hover
 * @param {import('@playwright/test').Locator} opts.button - the gutter button
 *   (or container) that must become sized
 * @param {number} [opts.timeout=5000]
 */
async function hoverUntilGutterVisible(page, { cell, button, timeout = 5000 }) {
  await expect.poll(async () => {
    await cell.hover();
    const box = await button.boundingBox().catch(() => null);
    return !!(box && box.width > 0 && box.height > 0);
  }, { timeout }).toBe(true);
}

/**
 * Open a comment form on a specific diff line by hovering to reveal the
 * gutter comment button, then clicking it. Waits for the form to appear.
 *
 * By default the line is addressed globally by index (`nth`) across all mounted
 * hosts — fine for a single-file diff. Pass `{ host, line }` to scope to one
 * file's mounted `diffs-container` and a specific line NUMBER, needed when other
 * files are also mounted (e.g. the eviction diff, where main.js columns precede
 * the target's).
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [lineIndex=0]
 * @param {Object} [opts]
 * @param {import('@playwright/test').Locator} [opts.host] - the target file's
 *   `diffs-container` locator; scopes the cell + button lookups to it
 * @param {number} [opts.line] - line NUMBER to hover within `host` (default 1)
 */
async function openCommentFormOnLine(page, lineIndex = 0, { host, line = 1 } = {}) {
  const lineNumberCell = host
    ? host.locator(`[data-column-number="${line}"]`).last()
    : page.locator('[data-column-number]').nth(lineIndex);
  const addCommentBtn = (host || page).locator('.pierre-comment-btn').first();
  const form = page.locator('.user-comment-form');

  // The vendor gutter-utility reveals the +/chat buttons only while the row is
  // hovered and sizes the container on the next frame; under parallel-load
  // contention that reveal can drop between the hover and the click (the button
  // re-hides mid-interaction). Retry the WHOLE hover→reveal→click as one bounded
  // loop: each attempt re-establishes the hover and does a genuine,
  // actionability-checked click (no force/dispatch bypass — that would mask the
  // real user-facing jank). Re-hovering when the button drops is exactly what a
  // user does; the bound means a button that genuinely never reveals still fails
  // loudly rather than hanging.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await hoverUntilGutterVisible(page, {
        cell: lineNumberCell,
        button: addCommentBtn,
        timeout: 5000,
      });
      await addCommentBtn.click({ timeout: 3000 });
      await form.waitFor({ state: 'visible', timeout: 3000 });
      return;
    } catch (err) {
      lastErr = err;
      // Park the pointer off the diff so the next attempt's hover fires a fresh
      // pointer-enter that re-triggers the vendor reveal.
      await page.mouse.move(4, 4).catch(() => {});
    }
  }
  throw lastErr;
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
    // Under CodeView the mounted host IS the stamped `.d2h-file-wrapper`
    // (`diffs-container[data-file-name]`) — there is no separate wrapper element
    // to descend from. Scope to that host directly, or to every mounted host.
    const hosts = file
      ? [document.querySelector(`diffs-container[data-file-name="${file}"]`)].filter(Boolean)
      : document.querySelectorAll('diffs-container');
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

  // The vendor's gutter-utility positions the single per-file gutter container
  // (a light-DOM child of the host) at the hovered line, in the hovered column.
  // A CSS selector can't scope by split column, so gate on the button being
  // horizontally on the REQUESTED side of the split `<pre>` (additions = RIGHT,
  // deletions = LEFT) before clicking, so a button still positioned over the
  // OTHER column from a prior hover can't be the one we act on. The columns
  // themselves are `display:contents` (zero-size rects), hence the pre midpoint.
  // The host IS the `.d2h-file-wrapper` (`diffs-container`), so read its shadow
  // and light-DOM children directly.
  await page.waitForFunction(({ file, wantLeft }) => {
    const host = document.querySelector(`diffs-container[data-file-name="${file}"]`);
    const btn = host && host.querySelector('.pierre-comment-btn');
    if (!btn) return false;
    const r = btn.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const pre = host.shadowRoot?.querySelector('pre[data-diff-type="split"]');
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

/**
 * Retire every user comment on a review for test isolation. DELETE is a soft
 * delete (`CommentRepository.deleteComment` sets status='inactive'), which is
 * enough: the comments GET filters inactive rows out unless asked for them, so a
 * later test's page load never sees these.
 *
 * Best-effort by design (errors are swallowed): this mostly runs in afterEach,
 * where a page left mid-navigation by a failing test must not turn one failure
 * into two.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [reviewId] - Review to clean. Defaults to the page's active
 *   review (`window.prManager.currentPR.id`).
 */
async function cleanupComments(page, reviewId) {
  await page.evaluate(async (rid) => {
    try {
      const id = rid ?? window.prManager?.currentPR?.id;
      if (!id) return;
      const data = await (await fetch(`/api/reviews/${id}/comments?includeDismissed=true`)).json();
      for (const c of (data.comments || [])) {
        await fetch(`/api/reviews/${id}/comments/${c.id}`, { method: 'DELETE' });
      }
    } catch { /* best-effort */ }
  }, reviewId ?? null);
}

/**
 * Clean up all user comments AND leaked AI-suggestion rows on review 1 (call
 * via API to ensure a clean, ISOLATED state). The per-worker test DB is shared
 * across every spec that runs in that worker, so a sibling spec's analysis run
 * leaves source='ai' rows on review 1 that a later page load would render as
 * extra annotations — under the branch's async rendering that adds re-render
 * churn (main renders synchronously and is unaffected). Clearing them is test
 * isolation, not churn-tolerance.
 *
 * @param {import('@playwright/test').Page} page
 */
async function cleanupAllComments(page) {
  await page.evaluate(async () => {
    // Retire each user comment. DELETE is a soft delete (CommentRepository.
    // deleteComment sets status='inactive'), which is enough for isolation: the
    // comments GET filters inactive rows out unless asked for them.
    const commentsResponse = await fetch('/api/reviews/1/comments?includeDismissed=true');
    const data = await commentsResponse.json();
    for (const comment of (data.comments || [])) {
      await fetch(`/api/reviews/1/comments/${comment.id}`, { method: 'DELETE' });
    }
    // Drop any AI suggestions + analysis runs a sibling spec seeded on this review.
    await fetch('/api/reviews/1/ai-suggestions', { method: 'DELETE' }).catch(() => {});
  });
}

/**
 * A diff whose FIRST file is huge (20,100 added lines) so later files
 * virtualize OUT of the CodeView render window at load — the precondition for
 * eviction/remount tests. Each later file carries a few additions (new lines
 * 2-4) so a line comment has somewhere to anchor.
 *
 * @param {string[]} [files] - the first entry becomes the huge file
 * @returns {string} unified diff text
 */
function evictionDiff(files = ['src/main.js', 'src/utils.js']) {
  const big = [];
  for (let i = 0; i < 20100; i++) big.push('+// big line ' + i);
  let d =
    `diff --git a/${files[0]} b/${files[0]}\n--- a/${files[0]}\n+++ b/${files[0]}\n@@ -1,1 +1,20100 @@\n` +
    big.join('\n') + '\n';
  for (let f = 1; f < files.length; f++) {
    d +=
      `diff --git a/${files[f]} b/${files[f]}\n--- a/${files[f]}\n+++ b/${files[f]}\n@@ -1,2 +1,5 @@\n` +
      ' line a\n+added 1\n+added 2\n+added 3\n line b\n';
  }
  return d;
}

module.exports = {
  waitForDiffToRender,
  scrollFileIntoView,
  scrollFileOutOfView,
  waitForAnnotationsSlotted,
  expectResponse,
  expectRequest,
  hoverDiffLine,
  hoverUntilGutterVisible,
  openCommentFormOnLine,
  dragResizeHandle,
  waitForDiffType,
  setDiffView,
  hoverSplitDiffLine,
  openSplitCommentForm,
  expectAnnotationInSplitColumn,
  dismissProgressModalIfVisible,
  seedAISuggestions,
  cleanupComments,
  cleanupAllComments,
  evictionDiff
};
