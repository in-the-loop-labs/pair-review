// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Lazy Diff Rendering
 *
 * Verifies the lazy diff-rendering behavior introduced in public/js/pr.js +
 * public/js/modules/suggestion-manager.js:
 *
 *   - renderFileDiff() builds the file wrapper + header + an EMPTY <tbody>.
 *     Diff rows are NOT rendered up front; each file body is observed by an
 *     IntersectionObserver and rendered only when it nears the viewport, when
 *     the file is expanded, or when a code path force-renders it via
 *     prManager.ensureFileBodyRendered(file).
 *   - COLLAPSED files have `.d2h-file-body { display:none }`, so they never
 *     intersect the observer and stay unrendered (empty <tbody>) until
 *     expanded. This is the key large-PR perf win.
 *   - Comment/suggestion anchoring (ensureLinesVisible / displayAISuggestions)
 *     and expand/collapse/scroll paths force-render a file's body before
 *     anchoring, so overlays on an unrendered file still land on the right row.
 *
 * Harness notes (see tests/e2e/test-server.js):
 *   - The seeded PR is #1 in 'test-owner/test-repo', review id = 1. Its diff
 *     contains two files, sorted alphabetically: 'src/main.js' (first) and
 *     'src/utils.js' (second). Both are expanded by default and render on load.
 *   - We make 'src/main.js' start COLLAPSED by mocking the viewed-state
 *     endpoint (GET /api/pr/:owner/:repo/:number/files/viewed) per-test via
 *     page.route(). A viewed file starts collapsed (renderFileDiff: isViewed →
 *     isCollapsed). This is fully isolated — no shared-fixture changes — and
 *     keeps 'src/utils.js' expanded so waitForDiffToRender() still resolves.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

const PR_PATH = '/pr/test-owner/test-repo/1';
// Sorted-first file in the seeded diff; we force it to start collapsed.
const COLLAPSED_FILE = 'src/main.js';
// Sorted-second file; stays expanded so the page has rendered content on load.
const EXPANDED_FILE = 'src/utils.js';

/**
 * Mock the PR-mode viewed-state endpoint so the given files start collapsed.
 * loadViewedState() fetches this on every diff load (initial + whitespace
 * re-render), and a viewed file renders collapsed.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} files
 */
async function mockViewedFiles(page, files) {
  await page.route('**/api/pr/*/*/*/files/viewed', async (route) => {
    if (route.request().method() !== 'GET') {
      // Let POSTs (save viewed state) hit the real handler.
      return route.fallback();
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ files })
    });
  });
}

/**
 * Count the rendered diff-line rows inside a file's <tbody>.
 * @param {import('@playwright/test').Page} page
 * @param {string} fileName
 */
async function tbodyRowCount(page, fileName) {
  return page.locator(`.d2h-file-wrapper[data-file-name="${fileName}"] tbody tr`).count();
}

/**
 * Mock GET /api/reviews/:id/comments so loadUserComments() sees exactly the
 * given user comments — and nothing else.
 *
 * Mocking (rather than seeding the worker DB) keeps each test hermetic: the
 * per-worker SQLite DB is SHARED across the tests that run in that worker, so
 * a seeded comment would leak into a later test and silently force-render a
 * file that the later test expects to stay collapsed/unrendered.
 *
 * Each comment needs at least: file, line_start, side, body, status='active'.
 * loadUserComments() reads `data.comments`.
 * @param {import('@playwright/test').Page} page
 * @param {Array<object>} comments
 */
async function mockUserComments(page, comments) {
  await page.route('**/api/reviews/*/comments', async (route) => {
    if (route.request().method() !== 'GET') {
      // Let POSTs (create comment) hit the real handler.
      return route.fallback();
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, comments })
    });
  });
}

/**
 * Mock GET /api/reviews/:id/suggestions (the suggestion LIST) to return the
 * given AI suggestions — and nothing else.
 *
 * Same isolation rationale as mockUserComments: the per-worker DB is shared
 * across tests, and any earlier test that ran analysis seeds AI suggestions
 * for this review into that DB. On page load loadAISuggestions() fetches the
 * list and displayAISuggestions() force-renders every file a suggestion
 * targets — which would silently render a file this test expects to stay
 * collapsed/unrendered. Returning [] makes the test hermetic.
 *
 * Scoped with a regex so it matches ONLY the list endpoint
 * (`/api/reviews/<id>/suggestions` with optional query) and never the
 * sibling `/suggestions/check` or `/suggestions/:id/status` routes.
 * @param {import('@playwright/test').Page} page
 * @param {Array<object>} suggestions
 */
async function mockSuggestions(page, suggestions) {
  await page.route(/\/api\/reviews\/\d+\/suggestions(\?|$)/, async (route) => {
    if (route.request().method() !== 'GET') {
      return route.fallback();
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ suggestions })
    });
  });
}

/**
 * Build a minimal active user-comment object for mockUserComments().
 */
function userComment({ id, file, line, side = 'RIGHT', body }) {
  return {
    id,
    source: 'user',
    file,
    line_start: line,
    line_end: line,
    side,
    body,
    status: 'active',
    is_file_level: 0
  };
}

test.describe('Lazy diff rendering (PR mode)', () => {
  // ── Scenario 1: collapsed file body is empty until expanded ───────────────
  test('collapsed file has an empty tbody until expanded', async ({ page }) => {
    await mockViewedFiles(page, [COLLAPSED_FILE]);
    // No user comments or AI suggestions — otherwise loadUserComments() /
    // displayAISuggestions() would force-render the collapsed file to anchor
    // them, defeating the "stays empty" assertion. (The per-worker DB is shared
    // across tests; an earlier analysis run could otherwise leak suggestions.)
    await mockUserComments(page, []);
    await mockSuggestions(page, []);

    await page.goto(PR_PATH);
    // Wait for the file wrappers to exist, then for the EXPANDED file's body to
    // render. We can't use waitForDiffToRender() (it waits for a *visible*
    // .d2h-code-line-ctn): the expanded utils.js body renders via the
    // IntersectionObserver, which can lag under parallel load, while the only
    // forced renders so far are collapsed (display:none) bodies. Polling the
    // expanded file's own row count is the deterministic signal.
    await page.waitForSelector(`.d2h-file-wrapper[data-file-name="${COLLAPSED_FILE}"]`);
    await expect.poll(() => tbodyRowCount(page, EXPANDED_FILE)).toBeGreaterThan(0);

    const collapsedWrapper = page.locator(
      `.d2h-file-wrapper[data-file-name="${COLLAPSED_FILE}"]`
    );
    // The file starts collapsed (viewed) ...
    await expect(collapsedWrapper).toHaveClass(/collapsed/);
    // ... and its body was never rendered: zero diff-line rows.
    expect(await tbodyRowCount(page, COLLAPSED_FILE)).toBe(0);

    // Expand the collapsed file by clicking its header.
    await collapsedWrapper.locator('.d2h-file-header').click();

    // Now the body renders: rows appear and the file is no longer collapsed.
    await expect(collapsedWrapper).not.toHaveClass(/collapsed/);
    await expect.poll(() => tbodyRowCount(page, COLLAPSED_FILE)).toBeGreaterThan(0);
    await expect(
      collapsedWrapper.locator('.d2h-code-line-ctn').first()
    ).toBeVisible();
  });

  // ── Scenario 2: comment on a collapsed/unrendered file still anchors ──────
  test('user comment on a collapsed file force-renders the body and anchors', async ({ page }) => {
    // Anchor the comment on an added line of main.js (NEW line 12 =
    // "// New feature: logging" — see the mock diff hunk @@ -10,6 +10,10 @@).
    const COMMENT_LINE = 12;
    await mockUserComments(page, [
      userComment({
        id: 9001,
        file: COLLAPSED_FILE,
        line: COMMENT_LINE,
        side: 'RIGHT',
        body: 'Lazy-render anchoring test comment.'
      })
    ]);
    // No AI suggestions: the ONLY thing that should force-render the collapsed
    // file here is the user-comment anchoring path (loadUserComments), so we
    // isolate it from any analysis suggestions leaked by an earlier test.
    await mockSuggestions(page, []);

    await mockViewedFiles(page, [COLLAPSED_FILE]);

    await page.goto(PR_PATH);
    // Don't use waitForDiffToRender() here: it waits for a VISIBLE
    // .d2h-code-line-ctn, and the only forced render is the collapsed
    // (display:none) main.js. Wait on the file wrappers instead, then poll the
    // collapsed body's row count below.
    await page.waitForSelector(`.d2h-file-wrapper[data-file-name="${COLLAPSED_FILE}"]`);

    const collapsedWrapper = page.locator(
      `.d2h-file-wrapper[data-file-name="${COLLAPSED_FILE}"]`
    );

    // loadUserComments() → ensureLinesVisible() → ensureFileBodyRendered()
    // force-renders the (still-collapsed) body so the comment can anchor.
    // The body's rows now exist even though it never intersected the observer.
    await expect.poll(() => tbodyRowCount(page, COLLAPSED_FILE)).toBeGreaterThan(0);

    // The comment row was anchored inside this file's body.
    const commentRow = collapsedWrapper.locator('.user-comment-row');
    await expect(commentRow).toHaveCount(1);

    // It anchored to the correct line: the comment row immediately follows the
    // diff line whose NEW line number is COMMENT_LINE.
    const anchoredLine = await collapsedWrapper.evaluate((wrapper) => {
      const row = wrapper.querySelector('.user-comment-row');
      if (!row) return null;
      const prev = row.previousElementSibling;
      if (!prev) return null;
      // d2h renders the NEW line number in the second line-number cell.
      const cell = prev.querySelector('.line-num2');
      return cell ? cell.textContent.trim() : null;
    });
    expect(anchoredLine).toBe(String(COMMENT_LINE));
  });

  // ── Scenario 3: whitespace toggle re-renders cleanly ──────────────────────
  test('whitespace toggle re-renders without duplicate file wrappers and re-anchors comments', async ({ page }) => {
    // Mock a comment on the EXPANDED file so we can confirm it re-anchors after
    // the diff DOM is rebuilt by the whitespace toggle. loadUserComments() runs
    // again after handleWhitespaceToggle() rebuilds the diff, so the same
    // mocked response re-anchors the comment on the fresh DOM.
    const COMMENT_LINE = 3; // NEW line 3 of utils.js (an added line)
    await mockUserComments(page, [
      userComment({
        id: 9002,
        file: EXPANDED_FILE,
        line: COMMENT_LINE,
        side: 'RIGHT',
        body: 'Whitespace re-anchor test comment.'
      })
    ]);
    // Keep AI suggestions out of the picture so the only overlay we assert on
    // is the seeded user comment (isolation from cross-test analysis leakage).
    await mockSuggestions(page, []);

    await page.goto(PR_PATH);
    await waitForDiffToRender(page);

    // The comment anchored on the initial render.
    const expandedWrapper = page.locator(
      `.d2h-file-wrapper[data-file-name="${EXPANDED_FILE}"]`
    );
    await expect(expandedWrapper.locator('.user-comment-row')).toHaveCount(1);

    // Open the diff-options gear and toggle "Hide whitespace changes".
    // handleWhitespaceToggle() re-fetches the diff (?w=1) and fully rebuilds
    // the diff DOM, then re-anchors all overlays.
    await page.locator('#diff-options-btn').click();
    const popover = page.locator('.diff-options-popover');
    await expect(popover).toBeVisible();
    const wsCheckbox = popover
      .locator('label', { hasText: 'Hide whitespace changes' })
      .locator('input[type="checkbox"]');
    await wsCheckbox.check();

    // After the re-render the diff is still usable: rows are present and there
    // is exactly ONE wrapper per file (no duplicate/leftover wrappers).
    await waitForDiffToRender(page);
    await expect(
      page.locator(`.d2h-file-wrapper[data-file-name="${EXPANDED_FILE}"]`)
    ).toHaveCount(1);
    await expect(
      page.locator(`.d2h-file-wrapper[data-file-name="${COLLAPSED_FILE}"]`)
    ).toHaveCount(1);
    await expect.poll(() => tbodyRowCount(page, EXPANDED_FILE)).toBeGreaterThan(0);

    // The seeded comment re-anchored on the rebuilt DOM (exactly one row).
    await expect(
      page.locator(`.d2h-file-wrapper[data-file-name="${EXPANDED_FILE}"] .user-comment-row`)
    ).toHaveCount(1);
  });

  // ── Scenario 4: offscreen expanded file renders on scroll ─────────────────
  // SKIPPED (best-effort): The seeded diff has only two small files. In the
  // 1280x720 test viewport, neither expanded file's body starts beyond the
  // ~800px IntersectionObserver rootMargin, so there is no reliable way to
  // observe a "render on scroll" transition without inflating the shared
  // fixture diff (which other specs assert on). The on-demand force-render
  // path is covered by scenarios 1-3; the observer wiring itself is covered by
  // unit tests on _createFileBodyObserver / _renderFileBodyNow.
  test.skip('offscreen expanded file renders on scroll (needs a tall fixture diff)', async () => {});

  // ── Scenario 5: hunk-summary anchoring ────────────────────────────────────
  // NOT duplicated here (best-effort): hunk-summary anchoring on lazily
  // rendered bodies is already exercised end-to-end by
  // tests/e2e/hunk-summaries.spec.js (which reads data-hunk-start anchors and
  // delivers summaries via the WS-style event after the diff renders). Those
  // tests pass with lazy rendering in place, confirming _registerHunkAnchorsForFile
  // runs as each file body renders. Re-implementing it here would only
  // duplicate that coverage.
});
