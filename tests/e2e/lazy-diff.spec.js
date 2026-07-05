// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Lazy / budgeted diff rendering (@pierre/diffs)
 *
 * On this branch normal files render through @pierre/diffs into a shadow-DOM
 * `<diffs-container>` inside `.pierre-diff-body` — there is no legacy
 * `<tbody><tr>` machinery. The large-PR perf story moved with it, so these
 * tests assert the Pierre equivalents of the old lazy-`<tbody>` behavior:
 *
 *   - COLLAPSED files still render into `.pierre-diff-body`, but the Pierre
 *     instance is created `collapsed` (see renderFileDiff's Pierre branch +
 *     pierreBridge.setCollapsed) so its shadow DOM holds ZERO `[data-line]`
 *     rows until the file is expanded. Collapsed == nothing highlighted, the
 *     direct analogue of the old "empty <tbody> until expanded".
 *   - EXTREMELY LARGE diffs are DEFERRED by `_getPierreRenderDecision`
 *     (deferDiff): the body is replaced by a "Load diff" placeholder and is
 *     only rendered when the user clicks it or a code path force-materializes
 *     it via `_materializeDeferredDiff`.
 *   - Overlays (comments/suggestions/chat citations) force-materialize a
 *     deferred body before anchoring — `ensureLinesVisible` calls
 *     `_materializeDeferredDiff` — so an overlay on a not-yet-rendered file
 *     still lands on the right line. This replaces the legacy
 *     ensureFileBodyRendered force-render.
 *   - The whitespace toggle rebuilds the whole diff and re-anchors overlays,
 *     with exactly one wrapper per file (no duplicates).
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
 *   - The DEFERRED-diff tests mock GET /api/pr/.../diff to return a synthetic
 *     >20000-line patch for main.js (over PIERRE_AUTO_RENDER_MAX_PATCH_LINES)
 *     while keeping utils.js small, so utils.js still renders (the page has
 *     content) and main.js defers.
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
 * Count the rendered code-line rows in a Pierre file's shadow DOM. This is the
 * @pierre/diffs analogue of counting `<tbody> tr` rows in the legacy renderer:
 * a collapsed / not-yet-rendered file has zero, a rendered one has many.
 * @param {import('@playwright/test').Page} page
 * @param {string} fileName
 */
async function pierreShadowLineCount(page, fileName) {
  return page.evaluate((file) => {
    const wrapper = document.querySelector(`.d2h-file-wrapper[data-file-name="${file}"]`);
    const host = wrapper && wrapper.querySelector('diffs-container');
    if (!host || !host.shadowRoot) return 0;
    return host.shadowRoot.querySelectorAll('[data-line]').length;
  }, fileName);
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
 * Mock GET /api/pr/.../diff so that main.js carries a synthetic patch large
 * enough (> PIERRE_AUTO_RENDER_MAX_PATCH_LINES = 20000 lines) to be DEFERRED,
 * while utils.js stays tiny and renders normally. The frontend derives per-file
 * patches from `data.diff`, so the deferral is driven purely by patch size.
 * @param {import('@playwright/test').Page} page
 */
async function mockLargeMainDiff(page) {
  const bigLines = [];
  for (let i = 0; i < 20100; i++) bigLines.push('+// big line ' + i);
  const diff =
    'diff --git a/src/main.js b/src/main.js\n' +
    '--- a/src/main.js\n' +
    '+++ b/src/main.js\n' +
    '@@ -1,1 +1,20100 @@\n' +
    bigLines.join('\n') + '\n' +
    'diff --git a/src/utils.js b/src/utils.js\n' +
    '--- a/src/utils.js\n' +
    '+++ b/src/utils.js\n' +
    '@@ -1,2 +1,3 @@\n' +
    ' line a\n' +
    '+added line\n' +
    ' line b';
  await page.route('**/api/pr/*/*/*/diff', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        diff,
        changed_files: [
          { file: 'src/main.js', additions: 20100, deletions: 0 },
          { file: 'src/utils.js', additions: 1, deletions: 0 }
        ]
      })
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

test.describe('Lazy / budgeted diff rendering (PR mode)', () => {
  // ── Scenario 1: collapsed Pierre file renders no shadow lines until expanded
  test('collapsed pierre file renders no diff lines until expanded', async ({ page }) => {
    await mockViewedFiles(page, [COLLAPSED_FILE]);
    // No user comments or AI suggestions — otherwise loadUserComments() /
    // displayAISuggestions() could reach into the collapsed file, defeating the
    // "stays empty" assertion. (The per-worker DB is shared across tests; an
    // earlier analysis run could otherwise leak suggestions.)
    await mockUserComments(page, []);
    await mockSuggestions(page, []);

    await page.goto(PR_PATH);
    // The expanded file (utils.js) renders via @pierre/diffs; wait on its
    // shadow lines as the deterministic "page is ready" signal.
    await page.waitForSelector(`.d2h-file-wrapper[data-file-name="${COLLAPSED_FILE}"]`);
    await expect.poll(() => pierreShadowLineCount(page, EXPANDED_FILE)).toBeGreaterThan(0);

    const collapsedWrapper = page.locator(
      `.d2h-file-wrapper[data-file-name="${COLLAPSED_FILE}"]`
    );
    // The file starts collapsed (viewed) ...
    await expect(collapsedWrapper).toHaveClass(/collapsed/);
    // ... it registered a lazy Pierre body placeholder ...
    await expect(collapsedWrapper.locator('.pierre-diff-body')).toHaveCount(1);
    // ... but nothing rendered into it: no diffs-container, no bridge
    // instance, zero shadow code-line rows. Collapsed files skip render
    // entirely until expanded.
    await expect(
      collapsedWrapper.locator('.pierre-diff-body diffs-container')
    ).toHaveCount(0);
    expect(await page.evaluate(
      (f) => window.prManager.pierreBridge.files.has(f),
      COLLAPSED_FILE
    )).toBe(false);
    expect(await pierreShadowLineCount(page, COLLAPSED_FILE)).toBe(0);

    // Expand the collapsed file by clicking its header.
    await collapsedWrapper.locator('.d2h-file-header').click();

    // Now the body renders: shadow lines appear and the file is no longer
    // collapsed (both class and Pierre instance state).
    await expect(collapsedWrapper).not.toHaveClass(/collapsed/);
    await expect.poll(() => pierreShadowLineCount(page, COLLAPSED_FILE)).toBeGreaterThan(0);
    expect(await page.evaluate(
      (f) => window.prManager.pierreBridge.files.get(f)?.collapsed === true,
      COLLAPSED_FILE
    )).toBe(false);
  });

  // ── Scenario 2: extremely large diff defers to a "Load diff" placeholder ──
  test('extremely large diff defers to a Load-diff placeholder and materializes on click', async ({ page }) => {
    await mockLargeMainDiff(page);
    // Keep overlays out so nothing auto-materializes the deferred body — we want
    // to observe the placeholder and drive the manual "Load diff" click.
    await mockUserComments(page, []);
    await mockSuggestions(page, []);

    await page.goto(PR_PATH);
    // utils.js is tiny and renders normally.
    await waitForDiffToRender(page);

    const bigWrapper = page.locator(
      `.d2h-file-wrapper[data-file-name="${COLLAPSED_FILE}"]`
    );
    // The oversized diff was deferred: a placeholder with a Load-diff button,
    // and NO rendered Pierre body yet.
    const placeholder = bigWrapper.locator('.large-diff-placeholder');
    await expect(placeholder).toBeVisible();
    const loadButton = placeholder.locator('button', { hasText: 'Load diff' });
    await expect(loadButton).toBeVisible();
    await expect(bigWrapper.locator('.pierre-diff-body')).toHaveCount(0);

    // Clicking "Load diff" materializes the deferred body.
    await loadButton.click();
    await expect(placeholder).toHaveCount(0);
    await expect(bigWrapper.locator('.pierre-diff-body diffs-container')).toHaveCount(1);
    await expect.poll(() => pierreShadowLineCount(page, COLLAPSED_FILE)).toBeGreaterThan(0);
  });

  // ── Scenario 3: overlay on a deferred diff force-materializes + anchors ────
  test('user comment on a deferred large diff force-materializes the body and anchors', async ({ page }) => {
    await mockLargeMainDiff(page);
    // Anchor the comment on NEW line 12 of the synthetic main.js patch.
    const COMMENT_LINE = 12;
    await mockUserComments(page, [
      userComment({
        id: 9001,
        file: COLLAPSED_FILE,
        line: COMMENT_LINE,
        side: 'RIGHT',
        body: 'Deferred-diff anchoring test comment.'
      })
    ]);
    // No AI suggestions: the ONLY thing that should force-materialize the
    // deferred body here is the user-comment anchoring path (loadUserComments →
    // ensureLinesVisible → _materializeDeferredDiff).
    await mockSuggestions(page, []);

    await page.goto(PR_PATH);
    await waitForDiffToRender(page);

    const bigWrapper = page.locator(
      `.d2h-file-wrapper[data-file-name="${COLLAPSED_FILE}"]`
    );

    // loadUserComments() → ensureLinesVisible() → _materializeDeferredDiff()
    // force-renders the deferred body so the comment can anchor. The placeholder
    // is replaced by a rendered Pierre body even though we never clicked it.
    await expect(bigWrapper.locator('.large-diff-placeholder')).toHaveCount(0);
    await expect(bigWrapper.locator('.pierre-diff-body diffs-container')).toHaveCount(1);

    // The comment annotation slotted into this file's body, anchored to the
    // correct line (the slotted `.user-comment-row` carries data-line-start).
    const commentRow = bigWrapper.locator('.user-comment-row');
    await expect(commentRow).toHaveCount(1);
    await expect(commentRow).toHaveAttribute('data-line-start', String(COMMENT_LINE));
  });

  // ── Scenario 4: whitespace toggle re-renders cleanly + re-anchors ─────────
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

    // The comment anchored on the initial render (slotted into the Pierre body).
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

    // After the re-render the diff is still usable: shadow lines are present and
    // there is exactly ONE wrapper per file (no duplicate/leftover wrappers).
    await waitForDiffToRender(page);
    await expect(
      page.locator(`.d2h-file-wrapper[data-file-name="${EXPANDED_FILE}"]`)
    ).toHaveCount(1);
    await expect(
      page.locator(`.d2h-file-wrapper[data-file-name="${COLLAPSED_FILE}"]`)
    ).toHaveCount(1);
    await expect.poll(() => pierreShadowLineCount(page, EXPANDED_FILE)).toBeGreaterThan(0);

    // The seeded comment re-anchored on the rebuilt DOM (exactly one row).
    await expect(
      page.locator(`.d2h-file-wrapper[data-file-name="${EXPANDED_FILE}"] .user-comment-row`)
    ).toHaveCount(1);
  });
});
