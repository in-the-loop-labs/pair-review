// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: user-visible CodeView behaviors from the review-feedback batch
 * (Tasks #16/#17). Each locks in a fix for a behavior that the migration
 * regressed and that the existing specs didn't cover.
 *
 * Deterministic throughout (mount/evict + slot waits, no fixed sleeps). PR and
 * Local mode where the behavior applies.
 */

import { test, expect } from './fixtures.js';
import {
  waitForDiffToRender,
  scrollFileIntoView,
  scrollFileOutOfView,
  waitForAnnotationsSlotted,
  openCommentFormOnLine,
  expectResponse,
  cleanupComments,
  evictionDiff,
} from './helpers.js';

const MODES = [
  { name: 'PR mode', path: '/pr/test-owner/test-repo/1', diffRoute: '**/api/pr/*/*/*/diff' },
  { name: 'Local mode', path: '/local/2', diffRoute: '**/api/local/*/diff*' },
];

// ── Shared diff builders ────────────────────────────────────────────────────
// The 20,100-line evictionDiff fixture lives in helpers.js (shared with
// comment-remount.spec.js).

async function mockPrDiff(page, diff, changedFiles) {
  await page.route('**/api/pr/*/*/*/diff', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ diff, changed_files: changedFiles }),
    })
  );
}

/**
 * Create a FILE-level comment on `fileName` (its host must be mounted). Returns
 * the created comment id.
 */
async function createFileComment(page, fileName, text) {
  const host = page.locator(`diffs-container[data-file-name="${fileName}"]`);
  await host.locator('.file-header-comment-btn').first().click();
  const form = page.locator('.file-comment-form').first();
  await expect(form).toBeVisible({ timeout: 5000 });
  await form.locator('.file-comment-textarea').fill(text);
  const respPromise = expectResponse(page,
    (r) => r.url().includes('/comments') && r.request().method() === 'POST'
  );
  // Save with Ctrl+Enter (the form's own shortcut) instead of clicking Save.
  //
  // MEASURED on this tree, 20k-line fixture, target file LAST, root already at
  // max scroll when the form opens: the form adds 205px and the CodeView scroll
  // extent does not grow at all (scrollHeight 349793, constant over 60 frames),
  // so Save's bottom lands at 823px in a 720px viewport with scrollTop already
  // pinned at max — and scrollIntoView, scrollIntoViewIfNeeded and an explicit
  // scrollTop = scrollHeight all leave it there. That is why Playwright's
  // scroll-to-click spins on "element is outside of the viewport" until the test
  // times out.
  //
  // The extent does not grow on a SHORT diff either (1216 → 1216 once the idle
  // content upgrade has landed); Save is reachable there only because the short
  // content leaves slack inside the viewport. An earlier "+218px" reading was
  // content-upgrade churn measured before `baseMetadata` was set, not the layout
  // absorbing the form. Keyboard save is genuine user input; the button-click
  // path is covered by file-comments.spec.js:272.
  await form.locator('.file-comment-textarea').press('Control+Enter');
  const resp = await respPromise;
  const { commentId } = await resp.json();
  await page.locator(`[data-comment-id="${commentId}"]`).first().waitFor({ state: 'visible', timeout: 5000 });
  await waitForAnnotationsSlotted(page, fileName);
  return commentId;
}

const EVICT_FILES = ['src/main.js', 'src/utils.js'];
const TARGET = 'src/utils.js';

async function gotoEvictionDiff(page) {
  await mockPrDiff(page, evictionDiff(EVICT_FILES), [
    { file: 'src/main.js', additions: 20100, deletions: 0 },
    { file: 'src/utils.js', additions: 3, deletions: 0 },
  ]);
  await page.goto('/pr/test-owner/test-repo/1');
  // Generous budget: the 20k-line eviction fixture takes real time to parse and
  // first-paint, and the helper's 10s default is not enough at full workers.
  await waitForDiffToRender(page, 25000);
}

// ────────────────────────────────────────────────────────────────────────────
// #16 (3): a file's comment header icon stays FILLED after the file is
// virtualized out and back.
// ────────────────────────────────────────────────────────────────────────────

test.describe('File-comment header icon persistence across remount (CodeView)', () => {
  test.afterEach(async ({ page }) => { await cleanupComments(page); });

  test('the filled comment icon survives scrolling the file out and back', async ({ page }) => {
    test.slow(); // heavy 20k-line eviction diff — give timeout headroom under sequential load
    await gotoEvictionDiff(page);
    await cleanupComments(page);
    await scrollFileIntoView(page, TARGET);

    await createFileComment(page, TARGET, 'File comment for icon persistence');
    // Icon is FILLED (has-comments) on the file header.
    const iconBtn = page.locator(`diffs-container[data-file-name="${TARGET}"] .file-header-comment-btn`);
    await expect(iconBtn).toHaveClass(/has-comments/, { timeout: 5000 });

    // Evict + remount — the header rebuilds from data and must stay filled.
    await scrollFileOutOfView(page, TARGET);
    await scrollFileIntoView(page, TARGET);
    await waitForAnnotationsSlotted(page, TARGET);
    await expect(
      page.locator(`diffs-container[data-file-name="${TARGET}"] .file-header-comment-btn`)
    ).toHaveClass(/has-comments/, { timeout: 5000 });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #16 (4): file-level comments on a file that is virtualized-out AT PAGE LOAD
// still hydrate — scroll it in and the cards are present.
// ────────────────────────────────────────────────────────────────────────────

test.describe('File-comment hydration for a virtualized-out file (CodeView)', () => {
  test.afterEach(async ({ page }) => { await cleanupComments(page); });

  test('a file-level comment hydrates when its off-screen file is scrolled in', async ({ page }) => {
    // Heavy: renders the 20k-line eviction fixture TWICE (goto + reload) plus a
    // UI comment creation — needs timeout headroom at full workers.
    test.slow();
    // REGRESSION (#19 F1, fixed by core-impl): on a fresh load `loadFileComments`
    // runs while utils.js is virtualized out. It used to resolve the zone via DOM
    // query + `_fileCommentZones.get` (a GET, not getOrCreate), find neither, and
    // drop the card — nothing re-hydrated when the file later mounted, so the zone
    // rendered EMPTY. Now it getOrCreates the cached zone so the card replays when
    // the file mounts on scroll-in. This test fails if that hydration regresses.

    // Seed a comment on utils.js, then reload so utils.js starts virtualized out.
    await gotoEvictionDiff(page);
    await cleanupComments(page);
    await scrollFileIntoView(page, TARGET);
    await createFileComment(page, TARGET, 'Hydrate me on scroll-in');

    await page.reload();
    await waitForDiffToRender(page, 25000);

    // utils.js is virtualized out at load — no host, no card yet.
    await expect(page.locator(`diffs-container[data-file-name="${TARGET}"]`)).toHaveCount(0);
    // Scroll it in → the file-comment card hydrates.
    await scrollFileIntoView(page, TARGET);
    await waitForAnnotationsSlotted(page, TARGET);
    await expect(
      page.locator(`diffs-container[data-file-name="${TARGET}"] .file-comment-card`)
    ).toHaveCount(1, { timeout: 5000 });
    await expect(
      page.locator(`diffs-container[data-file-name="${TARGET}"] .file-comment-card .file-comment-body, diffs-container[data-file-name="${TARGET}"] .file-comment-card`)
    ).toContainText('Hydrate me on scroll-in');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #17 (6): clicking an AI-panel entry for a target on a VIRTUALIZED-OUT file
// materializes the file and scrolls to it.
// ────────────────────────────────────────────────────────────────────────────

/** An external (GitHub) review thread on utils.js line 3. */
const EXTERNAL_THREAD = {
  id: 101, source: 'github', external_id: '900001', in_reply_to_id: null, parent_id: null,
  external_url: 'https://github.com/test-owner/test-repo/pull/1#discussion_r900001',
  author: 'reviewer-alice', author_url: 'https://github.com/reviewer-alice',
  file: 'src/utils.js', side: 'RIGHT', line_start: 3, line_end: 3, diff_position: 4,
  commit_sha: 'def456head', is_outdated: 0, original_line_start: 3, original_line_end: 3,
  original_commit_sha: 'def456head', body: 'Should this be a const?',
  external_created_at: '2025-10-01T12:00:00Z', synced_at: '2025-10-01T12:05:00Z', replies: [],
};

async function installExternalThreadMock(page, threads) {
  await page.route('**/api/reviews/*/external-comments**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ threads }) });
  });
  await page.route('**/api/reviews/*/external-comments/sync**', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: threads.length, lostAnchors: 0, syncedAt: new Date().toISOString() }),
    });
  });
}

test.describe('AI-panel navigation to a virtualized-out EXTERNAL thread (CodeView)', () => {
  test('clicking an external-thread entry materializes its off-screen file and reveals the thread', async ({ page }) => {
    test.slow(); // heavy 20k-line eviction fixture — timeout headroom at full workers
    await installExternalThreadMock(page, [EXTERNAL_THREAD]);
    await gotoEvictionDiff(page);

    // Open the panel + External segment; the thread appears as a finding-item.
    await page.evaluate(() => window.aiPanel?.expand());
    await page.locator('.segment-btn').filter({ hasText: 'External' }).click();
    const finding = page.locator(`.finding-item[data-item-type="external"][data-file="${TARGET}"]`);
    await expect(finding).toHaveCount(1, { timeout: 5000 });

    // utils.js is virtualized out below the huge main.js.
    await expect(page.locator(`diffs-container[data-file-name="${TARGET}"]`)).toHaveCount(0);

    // Click the panel entry — it materializes the file and reveals the thread.
    await finding.click();
    await expect(page.locator(`diffs-container[data-file-name="${TARGET}"]`)).toHaveCount(1, { timeout: 10000 });
    await expect(
      page.locator(`diffs-container[data-file-name="${TARGET}"] .external-comment-row`)
    ).toBeVisible({ timeout: 10000 });
  });
});

test.describe('AI-panel navigation to a virtualized-out target (CodeView)', () => {
  test.afterEach(async ({ page }) => { await cleanupComments(page); });

  test('clicking a user-comment entry materializes its off-screen file and reveals the comment', async ({ page }) => {
    // Heavy: renders the 20k-line eviction fixture TWICE (goto + reload) plus a
    // UI comment creation — needs timeout headroom at full workers.
    test.slow();
    // REGRESSION (#19 F2, fixed by consumers): clicking the AI-panel finding-item
    // for a USER COMMENT on a virtualized-out file used to report the row "live"
    // prematurely — an unscoped `[data-comment-id]` query matched the panel's own
    // quick-action button, so the nav short-circuited without materializing the
    // file. The query is now scoped to `#diff-container`, so the click actually
    // materializes + scrolls to the comment. This test fails if that regresses.

    await gotoEvictionDiff(page);
    await cleanupComments(page);
    await scrollFileIntoView(page, TARGET);

    // Create a user (line) comment on utils.js line 3. Host-scoped form-open
    // through the sanctioned bounded re-hover-and-real-click helper — the raw
    // hover+click races the gutter-reveal under 8-worker saturation (a genuine,
    // documented class), and main.js is also mounted so the lookup must scope to
    // the target host.
    const host = page.locator(`diffs-container[data-file-name="${TARGET}"]`);
    await openCommentFormOnLine(page, 0, { host, line: 3 });
    await page.locator('.user-comment-form textarea').fill('AI-panel nav target comment');
    await page.locator('.save-comment-btn').click();
    await expect(host.locator('.user-comment-row').first()).toBeVisible({ timeout: 5000 });

    // Reload so utils.js starts virtualized OUT (below the huge main.js), the
    // real "nav to an off-screen target" scenario. This mirrors the external-
    // thread positive test and the F1 hydration test — a deterministic load-time
    // eviction instead of a scroll-out that the panel-open 2-file layout can keep
    // inside the render window.
    await page.reload();
    await waitForDiffToRender(page, 25000);
    await expect(page.locator(`diffs-container[data-file-name="${TARGET}"]`)).toHaveCount(0);

    // Open the AI panel, switch to the User segment; the comment appears as a
    // finding-item (built from loadUserComments data, independent of mount).
    await page.evaluate(() => window.aiPanel?.expand());
    await page.locator('.segment-btn').filter({ hasText: 'User' }).click();
    const finding = page.locator(
      `.finding-item[data-item-type="comment"][data-file="${TARGET}"]`
    );
    await expect(finding).toHaveCount(1, { timeout: 5000 });

    // Click the panel entry — it must materialize the file and reveal the comment.
    await finding.click();
    await expect(page.locator(`diffs-container[data-file-name="${TARGET}"]`)).toHaveCount(1, { timeout: 10000 });
    await expect(
      page.locator(`diffs-container[data-file-name="${TARGET}"] .user-comment-row`)
    ).toBeVisible({ timeout: 10000 });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #16 (2): a file-level comment on a DELETED file anchors to the deletions
// (LEFT) side (PR mode — GitHub reports deleted files as status 'removed' with
// no `deleted file mode` header, so the side must come from the status).
// ────────────────────────────────────────────────────────────────────────────

test.describe('File-comment anchoring on a deleted file (CodeView, PR mode)', () => {
  test.afterEach(async ({ page }) => { await cleanupComments(page); });

  test('the file-comments zone (and a comment) anchor to the deletions side', async ({ page }) => {
    const diff =
      'diff --git a/src/deleted.js b/src/deleted.js\n--- a/src/deleted.js\n+++ b/src/deleted.js\n' +
      '@@ -1,3 +0,0 @@\n-line 1\n-line 2\n-line 3\n';
    await mockPrDiff(page, diff, [
      { file: 'src/deleted.js', status: 'removed', additions: 0, deletions: 3 },
    ]);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // The lineNumber:0 file-comments zone slots on the deletions side. POLL for
    // it: the zone is published by the (async) file-comment hydration and the
    // vendor stamps the wrapper's `slot` on a LATER animation frame than the
    // `[data-line]` rows waitForDiffToRender gates on, so a synchronous read can
    // see no zone / no wrapper / no attribute and fail on a bare null mismatch.
    await expect.poll(async () => page.evaluate(() => {
      const zone = document.querySelector('.file-comments-zone[data-file-name="src/deleted.js"]');
      const wrapper = zone && zone.closest('[data-annotation-slot]');
      return (wrapper && wrapper.getAttribute('slot')) || null;
    }), { timeout: 10000 }).toBe('annotation-deletions-0');

    // A file comment created on it renders inside that deletions-side zone.
    const commentId = await createFileComment(page, 'src/deleted.js', 'Comment on a deleted file');
    const card = page.locator(`[data-comment-id="${commentId}"]`);
    await expect(card).toBeVisible();
    // The card lives inside the file-comments zone, whose annotation wrapper is
    // slotted on the deletions side. Polled for the same reason: the save
    // round-trip republishes the item, so the wrapper can be mid-reslot.
    await expect.poll(async () => page.evaluate((id) => {
      const el = document.querySelector(`[data-comment-id="${id}"]`);
      const wrapper = el && el.closest('[data-annotation-slot]');
      return (wrapper && wrapper.getAttribute('slot')) || null;
    }, commentId), { timeout: 10000 }).toBe('annotation-deletions-0');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #16 (5): sidebar/chat jump to a context file works when the context item
// starts virtualized OUT — including lineStart targeting.
// ────────────────────────────────────────────────────────────────────────────

for (const mode of MODES) {
  test.describe(`Context-file navigation for a virtualized-out item (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      const diff = evictionDiff(EVICT_FILES);
      if (mode.name === 'PR mode') {
        await mockPrDiff(page, diff, [
          { file: 'src/main.js', additions: 20100, deletions: 0 },
          { file: 'src/utils.js', additions: 3, deletions: 0 },
        ]);
      } else {
        await page.route(mode.diffRoute, (route) =>
          route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ diff, stats: { files_changed: 2, additions: 20103, deletions: 0 } }),
          })
        );
      }
      await page.goto(mode.path);
      await waitForDiffToRender(page, 25000);
    });

    test('scrollToContextFile mounts an off-screen context item and lands on lineStart', async ({ page }) => {
      test.slow(); // heavy 20k-line eviction fixture — timeout headroom at full workers
      // Append a context file after the huge diff so it starts virtualized out
      // (the same `context:<path>` item the sidebar/chat nav resolves).
      const added = await page.evaluate(() => {
        const bridge = window.prManager.pierreBridge;
        const contents = Array.from({ length: 30 }, (_, i) => `// ctx line ${i + 1}`).join('\n');
        bridge.addContextFile('src/ctx.js', contents);
        return {
          itemId: window.prManager._pierreItemIdForPath('src/ctx.js'),
          mounted: !!document.querySelector('diffs-container[data-file-name="src/ctx.js"]'),
        };
      });
      expect(added.itemId).toBe('context:src/ctx.js');
      // Starts virtualized OUT (below the 20k-line main.js).
      await expect(page.locator('diffs-container[data-file-name="src/ctx.js"]')).toHaveCount(0);

      // The sidebar/chat nav entrypoint — jump to the context file at a line.
      await page.evaluate(() => window.prManager.scrollToContextFile('src/ctx.js', 5, null));

      // It mounts as a context item and scrolls into view.
      const host = page.locator('diffs-container[data-file-name="src/ctx.js"].context-file');
      await expect(host).toHaveCount(1, { timeout: 10000 });
      await expect
        .poll(async () => host.evaluate((h) => {
          const c = document.getElementById('diff-container').getBoundingClientRect();
          const r = h.getBoundingClientRect();
          return r.top < c.bottom && r.bottom > c.top; // intersects viewport
        }), { timeout: 5000 })
        .toBe(true);
      // lineStart target (line 5) is rendered in the mounted context body.
      await expect(host.locator('[data-line="5"]').first()).toBeVisible({ timeout: 5000 });
    });
  });
}

// ────────────────────────────────────────────────────────────────────────────
// #16 (1): empty review shows "No files changed", and it clears when a
// re-render brings files in.
// ────────────────────────────────────────────────────────────────────────────

test.describe('Empty review placeholder (CodeView)', () => {
  test('shows "No files changed" for an empty diff', async ({ page }) => {
    await mockPrDiff(page, '', []);
    await page.goto('/pr/test-owner/test-repo/1');
    await page.waitForSelector('#diff-container.pierre-codeview-root', { timeout: 15000 });

    const placeholder = page.locator('#diff-container > .no-diff');
    await expect(placeholder).toBeVisible({ timeout: 10000 });
    await expect(placeholder).toHaveText('No files changed');
  });

  test('does NOT show the placeholder when files are present', async ({ page }) => {
    test.slow(); // heavy 20k-line eviction fixture — timeout headroom at full workers
    await mockPrDiff(page, evictionDiff(), [
      { file: 'src/main.js', additions: 20100, deletions: 0 },
      { file: 'src/utils.js', additions: 3, deletions: 0 },
    ]);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await expect(page.locator('#diff-container > .no-diff')).toHaveCount(0);
  });
});
// ────────────────────────────────────────────────────────────────────────────
// Annotation growth must extend the CodeView scroll extent.
//
// MECHANISM (core-impl, Task #6): CodeView's resize path reconciles ITEM heights
// but never calls the vendor's `syncContainerHeight()` — only a render pass syncs
// the DOM extent. So a zone that grows after render (a file-comment form opening,
// a comment textarea autogrowing) made the item taller while `scrollHeight` stayed
// put, and the extra content had no scroll range to reach it. The fix queues a
// render per zone resize through one shared ResizeObserver.
//
// WHY THE EXTENT AND NOT JUST THE BUTTON: button visibility only regresses where
// the overflow happens to exceed the leftover viewport slack — it passed on a short
// diff throughout the whole broken period. The extent delta fails on the old code
// in ANY geometry, so that is the primary assertion here; reachable-and-clickable
// is kept as the user-visible consequence.
//
// MEASURED post-fix: extent 1216 → 1446 (short diff) and 350054 → 350285 (tall),
// both matching a 230px zone delta. Pre-fix both were 0.
// ────────────────────────────────────────────────────────────────────────────

const CONTRACT_LAST_FILE = 'src/tail.js';

/** A diff whose LAST file is the comment target, with `headLines` above it. */
function tailDiff(headLines) {
  let d = `diff --git a/src/head.js b/src/head.js\n--- a/src/head.js\n+++ b/src/head.js\n@@ -1,1 +1,${headLines} @@\n`;
  for (let i = 1; i <= headLines; i++) d += `+// head line ${i}\n`;
  d +=
    `diff --git a/${CONTRACT_LAST_FILE} b/${CONTRACT_LAST_FILE}\n` +
    `--- a/${CONTRACT_LAST_FILE}\n+++ b/${CONTRACT_LAST_FILE}\n@@ -1,2 +1,5 @@\n` +
    ' line a\n+added 1\n+added 2\n+added 3\n line b\n';
  return d;
}

const CONTRACT_MODES = [
  {
    name: 'PR mode',
    path: '/pr/test-owner/test-repo/1',
    async mock(page, headLines) {
      await mockPrDiff(page, tailDiff(headLines), [
        { file: 'src/head.js', additions: headLines, deletions: 0 },
        { file: CONTRACT_LAST_FILE, additions: 3, deletions: 0 },
      ]);
    },
  },
  {
    name: 'Local mode',
    path: '/local/2',
    async mock(page, headLines) {
      await page.route('**/api/local/*/diff*', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            diff: tailDiff(headLines),
            stats: { files_changed: 2, additions: headLines + 3, deletions: 0 },
          }),
        })
      );
    },
  },
];

/**
 * Two geometries. The SHORT one is where the bug was invisible to a
 * button-visibility check (slack absorbed the overflow); the TALL one is the
 * reported failure, where the target sits past the viewport with the root pinned
 * at max scroll. `upgradeFiles` lists the files whose idle content upgrade must
 * land before measuring — the 20k-line head file is too large to be eligible, so
 * it never upgrades and must not be waited on.
 */
const CONTRACT_GEOMETRIES = [
  {
    label: 'short diff',
    headLines: 300,
    upgradeFiles: ['src/head.js', CONTRACT_LAST_FILE],
    modes: CONTRACT_MODES,
  },
  {
    // Tall is about geometry, not mode: the shared code path is already covered in
    // Local by the short case, and a 20k-line Local fixture only buys runtime.
    label: 'tall virtualized diff',
    headLines: 20100,
    upgradeFiles: [CONTRACT_LAST_FILE],
    modes: [CONTRACT_MODES[0]],
    slow: true,
  },
];

/** Resolve once the CodeView scroll extent holds still for several frames. */
function settledExtent(page) {
  return page.evaluate(async () => {
    const root = document.getElementById('diff-container');
    let prev = root.scrollHeight;
    let stable = 0;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 8)));
      if (root.scrollHeight === prev) {
        if (++stable >= 6) return prev;
      } else {
        stable = 0;
        prev = root.scrollHeight;
      }
    }
    throw new Error(`scroll extent never settled (last ${prev})`);
  });
}

/**
 * Scroll until `selector` is inside the CodeView viewport, nudging by its own
 * overshoot so it converges from either direction, and report the geometry.
 *
 * NOT "scroll to max": the file-comments zone renders at the TOP of a file's body,
 * so on a body taller than the viewport scrolling to the bottom pushes the form off
 * the TOP instead (measured: Save at y=-309).
 */
function scrollIntoViewport(page, selector) {
  return page.evaluate(async (sel) => {
    const root = document.getElementById('diff-container');
    const MARGIN = 8;
    let last = null;
    for (let i = 0; i < 120; i++) {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        const view = root.getBoundingClientRect();
        last = {
          reachable: r.top >= view.top && r.bottom <= view.bottom,
          elBottom: Math.round(r.bottom),
          viewBottom: Math.round(view.bottom),
          scrollTop: Math.round(root.scrollTop),
          maxScrollTop: Math.round(root.scrollHeight - root.clientHeight),
        };
        if (last.reachable) return last;
        const below = r.bottom - (view.bottom - MARGIN);
        const above = (view.top + MARGIN) - r.top;
        if (below > 0) root.scrollTop += below;
        else if (above > 0) root.scrollTop -= above;
      }
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 16)));
    }
    return last || { reachable: false, reason: `no element for ${sel}` };
  }, selector);
}

/**
 * Land on the contract fixture with a verified-empty review, the content upgrade
 * done and the extent settled, scrolled to the tail file at max scroll.
 * @returns {Promise<number>} the settled extent
 */
async function arriveAtTailFile(page, mode, geometry) {
  await mode.mock(page, geometry.headLines);
  await page.goto(mode.path);
  await waitForDiffToRender(page, 25000);

  // Start from a verified-empty review: this measures vertical room, so ANY
  // leftover annotation row on the target file changes the answer, and the
  // per-worker DB is shared (a sibling spec's analysis leaves source='ai' rows on
  // review 1 — that failed here in PR mode only, under parallel load).
  await cleanupComments(page);
  await page.evaluate(async () => {
    const id = window.prManager?.currentPR?.id;
    if (id) await fetch(`/api/reviews/${id}/ai-suggestions`, { method: 'DELETE' }).catch(() => {});
  });
  await page.reload();
  await waitForDiffToRender(page, 25000);

  // The idle content upgrade re-renders items with full file contents, moving the
  // extent by thousands of px (the E2E file-contents mock answers for any path, so
  // a 300-line file SHRINKS to 40). Measuring across it reports churn as signal —
  // this is how a phantom "+218px absorption" appears. Wait it out first.
  await expect
    .poll(async () => page.evaluate((files) => {
      const bridge = window.prManager.pierreBridge;
      return files.every((f) => !!bridge.files.get(f)?.baseMetadata);
    }, geometry.upgradeFiles), { timeout: 20000 })
    .toBe(true);

  await scrollFileIntoView(page, CONTRACT_LAST_FILE);
  await page.evaluate(() => {
    const root = document.getElementById('diff-container');
    root.scrollTop = root.scrollHeight;
  });
  return settledExtent(page);
}

for (const geometry of CONTRACT_GEOMETRIES) {
  for (const mode of geometry.modes) {
    test.describe(`Zone growth extends the scroll extent — ${geometry.label} (${mode.name})`, () => {
      test.afterEach(async ({ page }) => { await cleanupComments(page); });

      test('opening a file-comment form on the last file grows the extent and keeps Save reachable', async ({ page }) => {
        if (geometry.slow) test.slow();
        const before = await arriveAtTailFile(page, mode, geometry);

        const zone = page.locator(`.file-comments-zone[data-file-name="${CONTRACT_LAST_FILE}"]`);
        const zoneBefore = await zone.evaluate((el) => Math.round(el.getBoundingClientRect().height));

        const host = page.locator(`diffs-container[data-file-name="${CONTRACT_LAST_FILE}"]`);
        await host.locator('.file-header-comment-btn').first().click();
        const form = page.locator('.file-comment-form').first();
        await expect(form).toBeVisible({ timeout: 5000 });
        // Type so the form is at full height and Save is enabled.
        await form.locator('.file-comment-textarea').fill('extent contract');

        const zoneAfter = await zone.evaluate((el) => Math.round(el.getBoundingClientRect().height));
        const zoneDelta = zoneAfter - zoneBefore;

        // The zone really did grow (guards the assertion below from being vacuous).
        expect(zoneDelta, `zone grew ${zoneDelta}px when the form opened`).toBeGreaterThan(100);

        // PRIMARY: the DOM extent grows to match the zone delta. Polled rather
        // than sampled once — the queued render lands a variable number of frames
        // after the resize, and a single settled reading can catch a plateau on a
        // loaded machine. Pre-fix the growth stays 0 in EVERY geometry, so this
        // still fails the whole 10s on old code (verified by neutering the fix).
        let growth = null;
        await expect
          .poll(async () => {
            const now = await page.evaluate(
              () => document.getElementById('diff-container').scrollHeight
            );
            growth = now - before;
            return growth;
          }, { timeout: 10000 })
          .toBeGreaterThanOrEqual(zoneDelta - 8);
        // And it did not over-grow (a double-count would also be a regression).
        expect(
          growth,
          `extent grew ${growth}px for a ${zoneDelta}px zone delta (before ${before})`
        ).toBeLessThanOrEqual(zoneDelta + 8);

        // Consequence: Save can be scrolled to, and genuinely clicked (no force,
        // no dispatch — actionability IS the assertion), and the save round-trips.
        const reach = await scrollIntoViewport(page, '.file-comment-form .submit-btn');
        expect(reach.reachable, `Save never scrolled into view: ${JSON.stringify(reach)}`).toBe(true);

        const respPromise = expectResponse(page,
          (r) => r.url().includes('/comments') && r.request().method() === 'POST'
        );
        await form.locator('.submit-btn').click({ timeout: 5000 });
        const resp = await respPromise;
        const { commentId } = await resp.json();
        await expect(page.locator(`[data-comment-id="${commentId}"]`).first()).toBeVisible({ timeout: 5000 });
      });
    });
  }
}

// A LINE comment form on the same last file: its textarea autogrows as you type,
// the other way a zone grows after render.
//
// WHAT THIS GUARDS: the CARET-SCROLL ASSUMPTION, not the zone observer. Line forms
// deliberately have no observer (pr.js `_observeFileCommentZoneSize`, and
// core-impl A/B'd then reverted adding one): autogrow moves the caret, the browser
// scrolls the container to keep it visible, the scroll renders, and the render
// syncs the container height. Confirmed independently here — with
// `syncScrollExtent` neutered this test still passes, on both the short and the
// tall geometry, while all three file-comment cases above fail. So this test is
// not evidence about the observer; it fails if the caret-scroll path ever stops
// being sufficient, which is the whole reason the observer was declined.
//
// KNOWN GAP, deliberately not covered: a line-form height change that does NOT
// move the caret (an error banner appearing, a preview toggle) grows the form
// without triggering a scroll, so it lands back in the extent gap that the zone
// observer exists to close. There is no such affordance to drive today; whoever
// adds one should extend the observer to line forms and reuse the extent-delta
// assertion from the file-comment cases above rather than this reachability one.
//
// Short geometry + PR mode: the gutter hover this needs is the least reliable
// interaction in the suite, and the tall geometry adds nothing (measured).
test.describe('Line-comment textarea autogrow keeps Save reachable (PR mode)', () => {
  test.afterEach(async ({ page }) => { await cleanupComments(page); });

  test('typing a long body grows the extent so Save stays reachable', async ({ page }) => {
    const geometry = CONTRACT_GEOMETRIES[0];
    await arriveAtTailFile(page, CONTRACT_MODES[0], geometry);

    const host = page.locator(`diffs-container[data-file-name="${CONTRACT_LAST_FILE}"]`);
    await openCommentFormOnLine(page, 0, { host, line: 2 });
    const textarea = page.locator('.user-comment-form textarea').first();
    const textareaBefore = await textarea.evaluate((el) => Math.round(el.getBoundingClientRect().height));

    await textarea.fill(
      Array.from({ length: 40 }, (_, i) => `long comment line ${i + 1} with enough text to wrap`).join('\n')
    );

    // The textarea autogrows with the content...
    await expect
      .poll(async () => textarea.evaluate((el) => Math.round(el.getBoundingClientRect().height)), { timeout: 10000 })
      .toBeGreaterThan(textareaBefore + 100);

    // ...and Save is still reachable and clickable, and the long body round-trips.
    //
    // NOT asserted: that the scroll extent grew. Measured — the caret-scroll
    // self-heal only fires when the autogrow pushes the caret OUT of view; when the
    // caret stays visible the browser never scrolls, so nothing renders and the
    // extent holds (observed 1431 → 1431 for a full 10s under load). Which of the
    // two happens depends on where the form sits, so extent growth is not an
    // invariant here — reachability is, because a scroll in either direction
    // renders and syncs. The extent-delta invariant is asserted where it does
    // hold, in the zone-observer cases above.
    const reach = await scrollIntoViewport(page, '.user-comment-form .save-comment-btn');
    expect(reach.reachable, `Save never scrolled into view: ${JSON.stringify(reach)}`).toBe(true);

    const respPromise = expectResponse(page,
      (r) => r.url().includes('/comments') && r.request().method() === 'POST'
    );
    await page.locator('.user-comment-form .save-comment-btn').click({ timeout: 5000 });
    const resp = await respPromise;
    const { commentId } = await resp.json();
    await expect(page.locator(`[data-comment-id="${commentId}"]`).first()).toBeVisible({ timeout: 10000 });
  });
});
