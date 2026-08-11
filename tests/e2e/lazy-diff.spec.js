// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: CodeView diff rendering — virtualization, collapse, plain-text budget
 *
 * The diff list renders through a single @pierre/diffs `CodeView` that owns
 * `#diff-container` (`.pierre-codeview-root`) and virtualizes the whole
 * changed-file set: one pooled shadow-DOM `<diffs-container>` host is mounted
 * per ON-SCREEN file and recycled as items scroll in and out. There is no
 * per-file `.pierre-diff-body` card, no deferred "Load diff" placeholder, and
 * no `_materializeDeferredDiff` machinery — those were removed with the
 * per-`FileDiff` renderer. This spec covers the CodeView-era equivalents:
 *
 *   - COLLAPSED files (viewed / generated / user-collapsed) mount their header
 *     but render ZERO `[data-line]` rows until expanded — the direct analogue
 *     of the old "empty body until expanded". Collapse state lives on the item
 *     (`pierreBridge.files.get(f).collapsed`), not a `display:none` DOM hack.
 *   - EXTREMELY LARGE diffs are NOT deferred: CodeView virtualizes within the
 *     file so the item renders immediately, and the per-render highlight budget
 *     forces PLAIN TEXT (`forcePlainText` on the item, `metadata.lang='text'`)
 *     to protect the tokenizer. No placeholder, no click-to-load.
 *   - OFF-SCREEN files are virtualized out (no host) until scrolled into view;
 *     `scrollToFile` (via the bridge) mounts them on demand.
 *   - Overlays (comments/suggestions) live on the item's annotation data, so an
 *     overlay on a virtualized-out file still anchors on the correct line once
 *     the file is scrolled in — the CodeView equivalent of the old
 *     force-materialize-before-anchor path.
 *   - The whitespace toggle rebuilds the whole diff and re-anchors overlays,
 *     with exactly one mounted host per (on-screen) file.
 *
 * Harness notes (see tests/e2e/test-server.js):
 *   - The seeded PR is #1 in 'test-owner/test-repo', review id = 1. Its diff
 *     contains two files, sorted alphabetically: 'src/main.js' (first) and
 *     'src/utils.js' (second). Both are expanded by default and render on load.
 *   - 'src/main.js' is made to start COLLAPSED by mocking the viewed-state
 *     endpoint (GET /api/pr/:owner/:repo/:number/files/viewed) per-test via
 *     page.route(). A viewed file starts collapsed. This is fully isolated —
 *     no shared-fixture changes — and keeps 'src/utils.js' expanded so
 *     waitForDiffToRender() still resolves.
 *   - The PLAIN-TEXT / virtualization tests mock GET /api/pr/.../diff to return
 *     a synthetic >20000-line patch for main.js (over
 *     PIERRE_AUTO_RENDER_MAX_PATCH_LINES) while keeping utils.js small.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender, scrollFileIntoView } from './helpers.js';

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
 * Count the rendered code-line rows in a file's CodeView shadow DOM. Under the
 * single-CodeView path the mounted host IS the stamped `.d2h-file-wrapper`
 * (`data-file-name`), so this reads its shadow directly. A collapsed or
 * not-yet-mounted (virtualized-out) file has zero; a rendered one has many.
 * @param {import('@playwright/test').Page} page
 * @param {string} fileName
 */
async function pierreShadowLineCount(page, fileName) {
  return page.evaluate((file) => {
    const host = document.querySelector(
      `diffs-container[data-file-name="${file}"]:not(.context-file)`
    );
    if (!host || !host.shadowRoot) return 0;
    return host.shadowRoot.querySelectorAll('[data-line]').length;
  }, fileName);
}

/**
 * Read a file's item state from the bridge (collapse flag, plain-text flag,
 * whether it is registered at all). The item exists for every changed file up
 * front (renderAll) regardless of virtualization.
 * @param {import('@playwright/test').Page} page
 * @param {string} fileName
 */
async function itemState(page, fileName) {
  return page.evaluate((file) => {
    const fs = window.prManager?.pierreBridge?.files?.get(file);
    if (!fs) return { present: false };
    return { present: true, collapsed: !!fs.collapsed, forcePlainText: !!fs.forcePlainText };
  }, fileName);
}

/**
 * Mock GET /api/reviews/:id/comments so loadUserComments() sees exactly the
 * given user comments — and nothing else.
 *
 * Mocking (rather than seeding the worker DB) keeps each test hermetic: the
 * per-worker SQLite DB is SHARED across the tests that run in that worker, so
 * a seeded comment would leak into a later test and silently render/anchor into
 * a file that a later test expects to stay collapsed/unrendered.
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
 * given AI suggestions — and nothing else. Same isolation rationale as
 * mockUserComments: an earlier test's analysis run seeds AI suggestions into
 * the shared per-worker DB, and displayAISuggestions() would anchor them.
 *
 * Scoped with a regex so it matches ONLY the list endpoint
 * (`/api/reviews/<id>/suggestions` with optional query) and never the sibling
 * `/suggestions/check` or `/suggestions/:id/status` routes.
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
 * enough (> PIERRE_AUTO_RENDER_MAX_PATCH_LINES = 20000 lines) to trip the
 * per-render highlight budget and render as PLAIN TEXT, while utils.js stays
 * tiny and renders normally. The frontend derives per-file patches from
 * `data.diff`, so the decision is driven purely by patch size.
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

test.describe('CodeView diff rendering (PR mode)', () => {
  // ── Scenario 1: collapsed file mounts a header but renders no shadow lines ──
  test('collapsed file renders no diff lines until expanded', async ({ page }) => {
    await mockViewedFiles(page, [COLLAPSED_FILE]);
    // No user comments or AI suggestions — otherwise loadUserComments() /
    // displayAISuggestions() could add annotations to the collapsed file. (The
    // per-worker DB is shared across tests; an earlier analysis run could
    // otherwise leak suggestions.)
    await mockUserComments(page, []);
    await mockSuggestions(page, []);

    await page.goto(PR_PATH);
    // The expanded file (utils.js) renders via CodeView; wait on its shadow
    // lines as the deterministic "page is ready" signal.
    await waitForDiffToRender(page);
    await expect.poll(() => pierreShadowLineCount(page, EXPANDED_FILE)).toBeGreaterThan(0);

    // The collapsed file's host is mounted and stamped, but its item is
    // collapsed so it holds ZERO shadow code-line rows.
    const collapsedHost = page.locator(
      `diffs-container[data-file-name="${COLLAPSED_FILE}"]`
    );
    await expect(collapsedHost).toHaveCount(1);
    expect(await itemState(page, COLLAPSED_FILE)).toMatchObject({ present: true, collapsed: true });
    expect(await pierreShadowLineCount(page, COLLAPSED_FILE)).toBe(0);
    // The header reflects the collapsed state (toggle offers "Expand file").
    await expect(
      collapsedHost.locator('.file-collapse-toggle')
    ).toHaveAttribute('title', 'Expand file');

    // Expand the collapsed file by clicking its header collapse toggle.
    await collapsedHost.locator('.file-collapse-toggle').click();

    // Now the body renders: shadow lines appear and the item is no longer
    // collapsed.
    await expect.poll(() => pierreShadowLineCount(page, COLLAPSED_FILE)).toBeGreaterThan(0);
    expect(await itemState(page, COLLAPSED_FILE)).toMatchObject({ collapsed: false });
  });

  // ── Scenario 2: extremely large diff renders immediately as plain text ─────
  test('extremely large diff renders immediately as plain text with no placeholder', async ({ page }) => {
    await mockLargeMainDiff(page);
    await mockUserComments(page, []);
    await mockSuggestions(page, []);

    await page.goto(PR_PATH);
    // utils.js (tiny) — or main.js at the top — renders normally; the page is
    // ready once any host has painted its shadow lines.
    await waitForDiffToRender(page);

    // There is NO deferral placeholder anywhere: the deferred-diff subsystem
    // was removed with the per-FileDiff renderer.
    await expect(page.locator('.large-diff-placeholder')).toHaveCount(0);

    // The oversized file is registered up front and flagged plain-text so the
    // tokenizer is never handed 20k highlighted lines.
    expect(await itemState(page, COLLAPSED_FILE)).toMatchObject({
      present: true,
      forcePlainText: true
    });

    // Scrolling the big file into view mounts it and it renders real code rows
    // (CodeView virtualizes WITHIN the file, so the row count is windowed, not
    // all 20100 — we only assert it rendered something).
    await scrollFileIntoView(page, COLLAPSED_FILE);
    await expect.poll(() => pierreShadowLineCount(page, COLLAPSED_FILE)).toBeGreaterThan(0);
  });

  // ── Scenario 3: off-screen file virtualizes out and mounts on scroll ───────
  test('an off-screen file is virtualized out and mounts when scrolled into view', async ({ page }) => {
    // The huge main.js pushes utils.js far below the viewport, so utils.js is
    // virtualized out at load. mock empty overlays so nothing forces it in.
    await mockLargeMainDiff(page);
    await mockUserComments(page, []);
    await mockSuggestions(page, []);

    await page.goto(PR_PATH);
    await waitForDiffToRender(page);

    // utils.js is registered as an item but not mounted (no host, no shadow
    // rows) while it is scrolled out of view.
    expect(await itemState(page, EXPANDED_FILE)).toMatchObject({ present: true });
    await expect(
      page.locator(`diffs-container[data-file-name="${EXPANDED_FILE}"]`)
    ).toHaveCount(0);

    // Scrolling it into view mounts it on demand (scrollToFile → virtualizer).
    await scrollFileIntoView(page, EXPANDED_FILE);
    await expect(
      page.locator(`diffs-container[data-file-name="${EXPANDED_FILE}"]`)
    ).toHaveCount(1);
    await expect.poll(() => pierreShadowLineCount(page, EXPANDED_FILE)).toBeGreaterThan(0);
  });

  // ── Scenario 4: overlay on a virtualized-out file anchors on mount ─────────
  test('a comment on a virtualized-out file anchors on the correct line when scrolled in', async ({ page }) => {
    await mockLargeMainDiff(page);
    // Anchor a comment on utils.js (which is virtualized out at load). The
    // annotation lives on the item data, so it must render on the correct line
    // once the file is scrolled into view — no force-materialize needed.
    const COMMENT_LINE = 3; // NEW line 3 of utils.js (an added line)
    await mockUserComments(page, [
      userComment({
        id: 9001,
        file: EXPANDED_FILE,
        line: COMMENT_LINE,
        side: 'RIGHT',
        body: 'Virtualized-out anchoring test comment.'
      })
    ]);
    await mockSuggestions(page, []);

    await page.goto(PR_PATH);
    await waitForDiffToRender(page);

    // Scroll the (previously off-screen) file into view; its host mounts and the
    // comment annotation renders anchored to the right line.
    await scrollFileIntoView(page, EXPANDED_FILE);
    const commentRow = page.locator(
      `diffs-container[data-file-name="${EXPANDED_FILE}"] .user-comment-row`
    );
    await expect(commentRow).toHaveCount(1);
    await expect(commentRow).toHaveAttribute('data-line-start', String(COMMENT_LINE));
  });

  // ── Scenario 5: whitespace toggle re-renders cleanly + re-anchors ─────────
  test('whitespace toggle re-renders with one host per file and re-anchors comments', async ({ page }) => {
    // Mock a comment on the EXPANDED file so we can confirm it re-anchors after
    // the diff is rebuilt by the whitespace toggle. loadUserComments() runs
    // again after handleWhitespaceToggle() rebuilds the diff, so the same
    // mocked response re-anchors the comment on the fresh items.
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
    await mockSuggestions(page, []);

    await page.goto(PR_PATH);
    await waitForDiffToRender(page);

    // The comment anchored on the initial render.
    await expect(
      page.locator(`diffs-container[data-file-name="${EXPANDED_FILE}"] .user-comment-row`)
    ).toHaveCount(1);

    // Open the diff-options gear and toggle "Hide whitespace changes".
    // handleWhitespaceToggle() re-fetches the diff (?w=1) and rebuilds the diff,
    // then re-anchors all overlays.
    await page.locator('#diff-options-btn').click();
    const popover = page.locator('.diff-options-popover');
    await expect(popover).toBeVisible();
    const wsCheckbox = popover
      .locator('label', { hasText: 'Hide whitespace changes' })
      .locator('input[type="checkbox"]');
    await wsCheckbox.check();

    // After the re-render the diff is still usable: exactly ONE mounted host for
    // the expanded file (pooled hosts are recycled — never duplicated per file),
    // with rendered shadow lines and the re-anchored comment.
    await waitForDiffToRender(page);
    await expect(
      page.locator(`diffs-container[data-file-name="${EXPANDED_FILE}"]`)
    ).toHaveCount(1);
    await expect.poll(() => pierreShadowLineCount(page, EXPANDED_FILE)).toBeGreaterThan(0);
    await expect(
      page.locator(`diffs-container[data-file-name="${EXPANDED_FILE}"] .user-comment-row`)
    ).toHaveCount(1);
  });
});
