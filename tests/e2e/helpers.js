// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared E2E Test Helpers
 *
 * Common utility functions used across E2E test spec files.
 * Centralizing these helpers ensures consistent behavior and easier maintenance.
 */

const { expect } = require('@playwright/test');
const diffDom = require('./diff-dom');

// Everything that touches the rendered diff's DOM lives in diff-dom.js (the
// only E2E file that knows vendor DOM). The names below are re-exported from
// here because most specs import them from this module.
const {
  waitForDiffToRender,
  hoverDiffLine,
  waitForDiffType,
  lineNumberCell,
  fileWrapper,
  fileLayout,
  expectAnnotationInColumn,
} = diffDom;

/**
 * Open a comment form on a specific diff line by hovering to reveal the
 * gutter comment button, then clicking it. Waits for the form to appear.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [lineIndex=0]
 */
async function openCommentFormOnLine(page, lineIndex = 0) {
  await diffDom.waitForDiffSettled(page);
  await diffDom.openLineCommentForm(page, { lineIndex });
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

/** Enable/disable "Minimize comments" via the diff-options gear dropdown. */
async function setMinimize(page, enabled) {
  await page.locator('#diff-options-btn').click();
  const checkbox = page.locator('label:has-text("Minimize comments") input[type="checkbox"]');
  await expect(checkbox).toBeVisible();
  if (enabled) {
    await checkbox.check();
  } else {
    await checkbox.uncheck();
  }
  // Close the popover so it can't intercept later clicks.
  await page.keyboard.press('Escape');
  const container = page.locator('#diff-container');
  if (enabled) {
    await expect(container).toHaveClass(/comments-minimized/, { timeout: 3000 });
  } else {
    await expect(container).not.toHaveClass(/comments-minimized/, { timeout: 3000 });
  }
}

/**
 * Hover a specific line's number cell in split (side-by-side) layout.
 *
 * Split renders two code columns (old on the left, new on the right) and each
 * visual row has a line-number cell in both, so the unified `nth(lineIndex)`
 * approach in `hoverDiffLine` does not address a specific side. This scopes
 * to the requested column so the gutter buttons reveal on the intended side.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} opts
 * @param {string} opts.fileName - e.g. 'src/utils.js'
 * @param {number} opts.line - The line number as shown in that column's gutter
 * @param {('additions'|'deletions'|'RIGHT'|'LEFT')} [opts.side='additions']
 * @returns {import('@playwright/test').Locator} the hovered line-number cell
 */
async function hoverSplitDiffLine(page, { fileName, line, side = 'additions' }) {
  await diffDom.waitForDiffSettled(page);
  const cell = lineNumberCell(fileWrapper(page, fileName), line, { side }).first();
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

  // There is one gutter-button container per file, and it is positioned over
  // the hovered line, so a selector cannot say which column it is over. Gate
  // on the button being horizontally on the REQUESTED side of the file's
  // midline (additions = right, deletions = left) before clicking, so a button
  // still positioned over the other column from a prior hover is not the one
  // acted on.
  const button = fileWrapper(page, fileName).locator('.pierre-comment-btn').first();
  await expect.poll(async () => {
    const layout = await fileLayout(page, fileName);
    const box = await button.boundingBox();
    if (!layout || layout.diffType !== 'split' || !box || box.width <= 0 || box.height <= 0) return 'not ready';
    const center = box.x + box.width / 2;
    return (isDeletions ? center < layout.pre.mid : center > layout.pre.mid) ? 'on requested side' : 'on other side';
  }, { timeout: 5000 }).toBe('on requested side');

  await button.waitFor({ state: 'visible', timeout: 5000 });
  await button.click();
  await page.waitForSelector('.user-comment-form', { timeout: 5000 });
}

/**
 * Wait until the annotation (comment / suggestion / summary) whose text
 * contains `text` is rendered in the given split column, i.e. physically in
 * that half of the two-column layout and not merely present in the page.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} opts
 * @param {string} opts.text - Substring identifying the annotation
 * @param {('additions'|'deletions')} opts.column
 * @param {number} [opts.timeout=5000]
 */
async function expectAnnotationInSplitColumn(page, { text, column, timeout = 5000 }) {
  await expectAnnotationInColumn(page, { text, column, timeout });
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
 * The two fixture reviews, one per mode. Specs that run in both modes loop
 * over this.
 */
const MODES = [
  { name: 'PR mode', path: '/pr/test-owner/test-repo/1', reviewId: 1, local: false },
  { name: 'Local mode', path: '/local/2', reviewId: 2, local: true }
];

/** The endpoint each mode's Analyze button posts to (both mocked by tests/e2e/test-server.js). */
function analysesUrl(reviewId) {
  return reviewId === 1 ? '/api/pr/test-owner/test-repo/1/analyses' : `/api/local/${reviewId}/analyses`;
}

/**
 * Chat is off in the E2E configuration; turn it on the way the application
 * does when a provider is available.
 */
async function enableChat(page) {
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-chat', 'available');
    window.dispatchEvent(new CustomEvent('chat-state-changed', { detail: { state: 'available' } }));
  });
}

/**
 * Keep PR mode's viewed state out of the shared database: a stateful stand-in
 * for its two routes. (Local mode keeps viewed state in localStorage, which is
 * per test already.)
 * @returns {Promise<{files: string[]}>} the live state
 */
async function mockViewedStateApi(page) {
  const state = { files: [] };
  await page.route('**/api/pr/*/*/*/files/viewed', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { files: state.files } });
    const files = route.request().postDataJSON().files || [];
    // The state a test polls for changes only once the page has its answer:
    // a test that reloads on seeing the new state must not abort the save.
    // `fulfill` resolves when the browser has taken the response, which is
    // before the page's `fetch` has it: wait for the load to finish in the
    // page (measured: without this the reload aborted the save in 1 of 60
    // executions, on either engine).
    await route.fulfill({ json: { success: true } });
    const response = await route.request().response().catch(() => null);
    if (response) await response.finished().catch(() => {});
    state.files = files;
  });
  return state;
}

/**
 * A stateful stand-in for the context-files API (list, add, extend, remove).
 * The real POST route refuses a file that does not exist in the review's
 * working directory, and the fixture reviews have none (ledger H46).
 * @param {Object} [options]
 * @param {string[]} [options.diffFiles] - paths in the diff: the route refuses those, as the real one does
 * @param {Array} [options.initialRows] - rows already stored
 * @returns {{rows: Array, requests: Array<{method: string, url: string, body: any}>, add: Function}}
 */
async function mockContextFilesApi(page, { diffFiles = [], initialRows = [] } = {}) {
  const state = { rows: [], requests: [], nextId: 501 };
  state.add = (row) => {
    const full = { id: state.nextId++, label: null, ...row };
    state.rows.push(full);
    return full;
  };
  for (const row of initialRows) state.add(row);

  await page.route(/\/api\/reviews\/\d+\/context-files(\/\d+)?(\?.*)?$/, async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const idMatch = url.pathname.match(/\/context-files\/(\d+)$/);
    const reviewId = Number(url.pathname.match(/\/reviews\/(\d+)\//)[1]);
    let body = null;
    try { body = request.postDataJSON(); } catch { body = null; }
    state.requests.push({ method, url: url.pathname, body });

    if (method === 'GET') {
      return route.fulfill({ json: { success: true, contextFiles: state.rows.filter((r) => r.review_id === reviewId) } });
    }
    if (method === 'POST') {
      // Mirrors the route's guard: a file in the diff is never a context file.
      if (diffFiles.includes(body.file)) {
        return route.fulfill({ status: 400, json: { error: `Cannot add context file: '${body.file}' is already part of the diff` } });
      }
      const row = state.add({ review_id: reviewId, file: body.file, line_start: body.line_start, line_end: body.line_end, label: body.label || null });
      return route.fulfill({ status: 201, json: { success: true, contextFile: row } });
    }
    const row = idMatch && state.rows.find((r) => r.id === Number(idMatch[1]));
    if (!row) return route.fulfill({ status: 404, json: { error: 'Context file not found' } });
    if (method === 'PATCH') {
      if (body.line_start != null) row.line_start = body.line_start;
      if (body.line_end != null) row.line_end = body.line_end;
      return route.fulfill({ json: { success: true } });
    }
    if (method === 'DELETE') {
      state.rows.splice(state.rows.indexOf(row), 1);
      return route.fulfill({ json: { success: true, message: 'Context file removed' } });
    }
    return route.fallback();
  });
  return state;
}

/**
 * Turn optional features on for the page: the answer of `GET /api/config`
 * with the given keys replaced (`{ summaries: { enabled: true } }`,
 * `{ tours: { enabled: true } }`). Everything else is the test server's own
 * answer. Call before `page.goto`.
 */
async function mockAppConfig(page, overrides) {
  await page.route('**/api/config', async (route) => {
    // `route.fetch()` is a request from the test process, on a kept-alive
    // connection the test server may have closed meanwhile (`read
    // ECONNRESET`), and it is cut off when the page goes away mid-request.
    // A rejection that leaves this handler is an unhandled rejection in the
    // worker: it fails whichever test is running and restarts the worker.
    // So: one more attempt on a fresh connection, then the request fails for
    // the page as it would have without the mock. Nothing is thrown.
    let response = null;
    for (let attempt = 0; attempt < 2 && !response; attempt++) {
      try {
        response = await route.fetch();
      } catch {
        response = null;
      }
    }
    try {
      if (!response) {
        await route.abort('failed');
        return;
      }
      const config = await response.json();
      await route.fulfill({ response, json: { ...config, ...overrides } });
    } catch {
      // The page or its context closed while the answer was on its way.
    }
  });
}

/**
 * A stand-in for the review's hunk-summaries endpoint. `state.summaries` is
 * what the next GET answers (`[{ file_path, content_hash, summary_text }]`);
 * a test changes it and the page sees the change on its next load.
 * @returns {Promise<{summaries: Array, requests: number}>}
 */
async function mockHunkSummaries(page, summaries = []) {
  const state = { summaries, requests: 0 };
  await page.route(/\/api\/reviews\/\d+\/hunk-summaries(\?.*)?$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    state.requests++;
    return route.fulfill({ json: { summaries: state.summaries, generating: false } });
  });
  return state;
}

/**
 * Resolves once the page listens for the server's pushes (`review:*` events).
 * The page registers those listeners at the end of its load sequence, after
 * the diff has rendered and after the suggestions and the running-analysis
 * check have been fetched (`PRManager._initReviewEventListeners`), so
 * `waitForDiffToRender` returns before they exist. A test that stands in for
 * a push by dispatching the event itself must wait for this first, or the
 * event goes to nobody.
 */
async function whenReviewEventsBound(page) {
  await page.waitForFunction(() => window.prManager?._reviewEventsBound === true);
}

/**
 * What the server's push does in the page when summaries for one file have
 * been generated (E2E has no WebSocket; the client dispatches this DOM event
 * for the message), followed by the "job finished" push that ends the
 * toolbar button's generating state.
 */
async function pushHunkSummaries(page, reviewId, filePath, summaries) {
  await whenReviewEventsBound(page);
  await page.evaluate(({ rid, file, list }) => {
    document.dispatchEvent(new CustomEvent('review:hunk_summaries_ready', {
      detail: { reviewId: rid, filePath: file, summaries: list }
    }));
    document.dispatchEvent(new CustomEvent('review:background_job_finished', {
      detail: { reviewId: rid, jobType: 'summaries', hasActiveForType: false }
    }));
  }, { rid: reviewId, file: filePath, list: summaries });
}

/**
 * A stand-in for the review's tour endpoint, answering a ready tour with the
 * given stops (`[{ file_path, side, line_start, line_end, title, description }]`).
 * Needs `mockAppConfig(page, { tours: { enabled: true } })` for the toolbar
 * button to exist.
 */
async function mockTour(page, stops) {
  await page.route(/\/api\/reviews\/\d+\/tour(\?.*)?$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: {
      tour: { stops, diff_hash: 'e2e', stale: false, provider: 'mock', model: 'mock', created_at: '2026-01-01T00:00:00.000Z' },
      generating: false
    } });
  });
}

/**
 * A stand-in for the external (GitHub) review-comment endpoints of PR mode:
 * the thread list and the sync. `state.threads` is what the next GET answers;
 * `state.syncs` counts sync requests. The test server does not mount these
 * routes (tests/e2e/external-comments.spec.js explains the shapes).
 *
 * `state.holdLists()` holds every thread list requested from then on until
 * the function it returns is called: a test decides what state the diff is
 * in when the threads arrive.
 * @returns {Promise<{threads: Array, syncs: number, lists: number, holdLists: Function}>}
 */
async function mockExternalComments(page, threads = []) {
  const state = { threads, syncs: 0, lists: 0, listGate: null };
  state.holdLists = () => {
    let release;
    state.listGate = new Promise((resolve) => { release = resolve; });
    return () => { state.listGate = null; release(); };
  };
  await page.route(/\/api\/reviews\/\d+\/external-comments(\/sync)?(\?.*)?$/, (route) => {
    const request = route.request();
    const isSync = /\/external-comments\/sync/.test(new URL(request.url()).pathname);
    if (isSync && request.method() === 'POST') {
      state.syncs++;
      const count = state.threads.reduce((n, t) => n + 1 + (t.replies || []).length, 0);
      return route.fulfill({ json: { count, lostAnchors: 0, syncedAt: '2026-01-01T00:00:00.000Z' } });
    }
    if (!isSync && request.method() === 'GET') {
      state.lists++;
      const threads = state.threads;
      return Promise.resolve(state.listGate).then(() => route.fulfill({ json: { threads } }));
    }
    return route.fallback();
  });
  return state;
}

/**
 * Hold every file-contents response until `release()`: each file stays as
 * rendered from its patch, and no content upgrade lands.
 *
 * Route handlers run newest first, and this one passes the request on with
 * `route.fallback()`. Register it AFTER `routeDiff` when the spec serves a
 * corpus, so the held request then reaches the corpus's contents.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{release: () => void}>}
 */
async function holdFileContents(page) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(/\/api\/reviews\/\d+\/file-contents\//, async (route) => {
    await held;
    return route.fallback();
  });
  return { release };
}

/**
 * One external thread as `ExternalCommentRepository.listThreadsByReview`
 * returns it: a root comment on a line of a file, with optional replies.
 */
function externalThread({ id, file, line, side = 'RIGHT', body, author = 'reviewer-alice', replies = [] }) {
  const comment = (commentId, text, who, parent) => ({
    id: commentId,
    source: 'github',
    external_id: String(900000 + commentId),
    in_reply_to_id: parent ? String(900000 + parent) : null,
    parent_id: parent || null,
    external_url: `https://github.com/test-owner/test-repo/pull/1#discussion_r${900000 + commentId}`,
    author: who,
    author_url: `https://github.com/${who}`,
    file,
    side,
    line_start: line,
    line_end: line,
    diff_position: 1,
    commit_sha: 'def456head',
    is_outdated: 0,
    original_line_start: line,
    original_line_end: line,
    original_commit_sha: 'def456head',
    body: text,
    external_created_at: '2025-10-01T12:00:00Z',
    synced_at: '2025-10-01T12:05:00Z'
  });
  return {
    ...comment(id, body, author, null),
    replies: replies.map((reply, index) => comment(id + 1 + index, reply.body, reply.author || 'reviewer-bob', id))
  };
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
 * @param {number} [opts.reviewId=1] - The fixture review to seed: 1 is the PR
 *   mode review, 2 the Local mode review. The page must be showing it.
 */
async function seedAISuggestions(page, {
  statusTimeout = 30000,
  suggestionSelector = '.ai-suggestion, [data-suggestion-id]',
  dismissProgressModal = true,
  reviewId = 1
} = {}) {
  // Make a direct POST request to trigger analysis and verify success
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!response.ok) {
      throw new Error(`Analysis API failed: ${response.status}`);
    }
    return response.json();
  }, analysesUrl(reviewId));

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
 * Seed AI suggestions the scenario describes itself, as real rows on the
 * review (tests/e2e/test-server.js `POST /test/seed-suggestions`), and have
 * the page load them. Use it for a suggestion on a corpus file, a hidden line
 * or a file-level finding; {@link seedAISuggestions} seeds the fixed mock set.
 * Tear down with {@link cleanupAllComments}.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} reviewId
 * @param {Array<{file: string, line_start?: number, line_end?: number, side?: string, type?: string, title?: string, body?: string, status?: string, is_file_level?: boolean}>} suggestions
 * @param {Object} [options]
 * @param {boolean} [options.load=true] - reload suggestions into the page now
 * @returns {Promise<number[]>} the ids, in the order given
 */
async function seedSuggestions(page, reviewId, suggestions, { load = true } = {}) {
  const ids = await page.evaluate(async ({ rid, list }) => {
    const response = await fetch('/test/seed-suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewId: rid, suggestions: list })
    });
    if (!response.ok) throw new Error(`Seeding suggestions failed: ${response.status} ${await response.text()}`);
    return (await response.json()).ids;
  }, { rid: reviewId, list: suggestions });
  if (load) {
    await page.waitForFunction(() => !!window.prManager?.analysisHistoryManager);
    await page.evaluate(() => window.prManager.loadAISuggestions());
  }
  return ids;
}

/**
 * Save a user comment through the comments API (the same endpoint in both
 * modes) without touching the UI. The page shows it after its next comment
 * load (`reloadComments`, or a reload).
 * @returns {Promise<number>} the comment id
 */
async function seedComment(page, reviewId, { file, line, lineEnd = line, side = 'RIGHT', body, fileLevel = false }) {
  return page.evaluate(async (c) => {
    const payload = c.fileLevel
      ? { file: c.file, body: c.body, is_file_level: true }
      : { file: c.file, line_start: c.line, line_end: c.lineEnd, side: c.side, body: c.body };
    const response = await fetch(`/api/reviews/${c.reviewId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Seeding a comment failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    return data.commentId ?? data.id ?? data.comment?.id;
  }, { reviewId, file, line, lineEnd, side, body, fileLevel });
}

/** Have the page load the review's user comments again, as it does after any change, and wait for it. */
async function reloadComments(page) {
  await page.evaluate(() => window.prManager.loadUserComments());
}

/**
 * `page.waitForResponse` that cannot take the whole worker down.
 *
 * `waitForResponse` is registered BEFORE the action that triggers it, so there
 * is always a window between creating the promise and awaiting it. If anything
 * in that window fails (a click that times out, an assertion, the test
 * deadline), the still-pending promise rejects with nobody awaiting it. An
 * unhandled rejection does not merely fail the test: Playwright reports
 * `worker process exited unexpectedly (code=1)`, every remaining test in the
 * file fails at 0 ms, and the run's failure set reshuffles by which worker
 * died. Observed on main at comment-crud.spec.js "Comment Persistence".
 *
 * Attaching a no-op catch marks the rejection handled. Awaiting the SAME
 * promise afterwards still observes it, so a genuinely missing response still
 * fails the test at the await site. Nothing is swallowed.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string|RegExp|Function} urlOrPredicate - as passed to page.waitForResponse
 * @param {Object} [options] - as passed to page.waitForResponse
 * @returns {Promise<import('@playwright/test').Response>}
 */
function expectResponse(page, urlOrPredicate, options) {
  const promise = page.waitForResponse(urlOrPredicate, options);
  promise.catch(() => {});
  return promise;
}

/**
 * `page.waitForRequest` with the same guard as {@link expectResponse}: it has
 * the identical register-then-await shape.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string|RegExp|Function} urlOrPredicate
 * @param {Object} [options]
 * @returns {Promise<import('@playwright/test').Request>}
 */
function expectRequest(page, urlOrPredicate, options) {
  const promise = page.waitForRequest(urlOrPredicate, options);
  promise.catch(() => {});
  return promise;
}

/**
 * Retire every user comment on one review through the API.
 *
 * The per-worker test database is shared by every spec file that worker runs,
 * so a comment left behind by one test is rendered by the next page load of
 * any later test. DELETE is a soft delete (status becomes 'inactive'), which is
 * enough: the comments GET leaves inactive rows out unless asked for them.
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
  const cleaned = await page.evaluate(async (rid) => {
    try {
      const id = rid ?? window.prManager?.currentPR?.id;
      if (!id) return null;
      const data = await (await fetch(`/api/reviews/${id}/comments?includeDismissed=true`)).json();
      for (const c of (data.comments || [])) {
        await fetch(`/api/reviews/${id}/comments/${c.id}`, { method: 'DELETE' });
      }
      return id;
    } catch { return null; /* best-effort */ }
  }, reviewId ?? null);
  if (cleaned != null) {
    try {
      await cleanupContextFiles(page, cleaned);
    } catch { /* best-effort */ }
  }
}

/**
 * Remove every context file of one review from the database.
 *
 * Saving a comment on a file the server does not find in the review's stored
 * diff makes the server add that file as a context file
 * (`ensureContextFileForComment`). A test that routes its own diff and
 * comments on one of its files therefore leaves a context-file row behind,
 * and every later page load of that review in the worker shows an extra file
 * in the pane and the sidebar.
 *
 * Goes through `page.request`, not the page: a spec may have routed the
 * context-files API (`mockContextFilesApi`), and a fetch from the page would
 * reach that stand-in and not the server.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} reviewId
 */
async function cleanupContextFiles(page, reviewId) {
  const response = await page.request.delete(`/api/reviews/${reviewId}/context-files`);
  if (!response.ok()) {
    throw new Error(`Context-file cleanup failed for review ${reviewId}: ${response.status()} ${await response.text()}`);
  }
}

/**
 * Delete every AI suggestion row and analysis run of one review, through the
 * E2E-only route in tests/e2e/test-server.js. The comment DELETE routes only
 * touch user comments; a describe block that seeds suggestions uses this to
 * tear down symmetrically.
 *
 * Strict: `fetch` resolves on any HTTP status, so the status is checked here.
 * A cleanup that fails silently leaves rows behind for every later test of
 * the worker, and the test that then fails is not the one that leaked.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [reviewId=1] - 1 is the PR mode fixture review
 */
async function cleanupAISuggestions(page, reviewId = 1) {
  await page.evaluate(async (rid) => {
    const response = await fetch(`/api/reviews/${rid}/ai-suggestions`, { method: 'DELETE' });
    if (!response.ok) {
      throw new Error(`AI suggestion cleanup failed for review ${rid}: ${response.status} ${await response.text()}`);
    }
  }, reviewId);
}

/**
 * Retire every user comment, drop every AI suggestion and remove every
 * context file of one review. A sibling spec's analysis run leaves
 * source='ai' rows on the review, and a comment on a file outside the stored
 * diff leaves a context file ({@link cleanupContextFiles}); a later page load
 * renders them. Clearing all three gives a test a known-empty review.
 *
 * Strict, unlike {@link cleanupComments}: every request's status is checked.
 * Use it where the test depends on the review being empty (a beforeEach, or
 * an afterEach on a page the test left in a usable state).
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [reviewId=1] - 1 is the PR mode fixture review
 */
async function cleanupAllComments(page, reviewId = 1) {
  await page.evaluate(async (rid) => {
    const listResponse = await fetch(`/api/reviews/${rid}/comments?includeDismissed=true`);
    if (!listResponse.ok) {
      throw new Error(`Comment cleanup could not list review ${rid}: ${listResponse.status}`);
    }
    const data = await listResponse.json();
    for (const comment of (data.comments || [])) {
      const response = await fetch(`/api/reviews/${rid}/comments/${comment.id}`, { method: 'DELETE' });
      // 404: another cleanup (or the test itself) already removed the row.
      if (!response.ok && response.status !== 404) {
        throw new Error(`Comment cleanup failed for comment ${comment.id}: ${response.status}`);
      }
    }
  }, reviewId);
  await cleanupAISuggestions(page, reviewId);
  await cleanupContextFiles(page, reviewId);
}

module.exports = {
  MODES,
  analysesUrl,
  enableChat,
  mockViewedStateApi,
  mockContextFilesApi,
  mockAppConfig,
  mockHunkSummaries,
  whenReviewEventsBound,
  pushHunkSummaries,
  mockTour,
  mockExternalComments,
  externalThread,
  holdFileContents,
  waitForDiffToRender,
  hoverDiffLine,
  openCommentFormOnLine,
  dragResizeHandle,
  waitForDiffType,
  setDiffView,
  setMinimize,
  hoverSplitDiffLine,
  openSplitCommentForm,
  expectAnnotationInSplitColumn,
  dismissProgressModalIfVisible,
  seedAISuggestions,
  seedSuggestions,
  seedComment,
  reloadComments,
  expectResponse,
  expectRequest,
  cleanupComments,
  cleanupAISuggestions,
  cleanupContextFiles,
  cleanupAllComments
};
