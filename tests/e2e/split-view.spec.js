// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Split (side-by-side) Diff View
 *
 * Covers the diff-layout toggle built on top of @pierre/diffs:
 *   - Default layout is unified; the gear → "Diff view" segmented control
 *     switches to split, and the vendor `<pre>` reports the layout via
 *     data-diff-type ("single" = unified, "split" = side-by-side).
 *   - The choice persists to localStorage (`pair-review-diff-view`) and
 *     survives reload; toggling back to unified works.
 *   - Annotations (user comments, AI suggestions) survive the toggle and, in
 *     split, render in the column matching their side (additions = RIGHT,
 *     deletions = LEFT) — this is @pierre/diffs' per-column design.
 *   - Comments can be created in split mode from either column.
 *
 * The core toggle/comment tests run in BOTH PR mode and Local mode
 * (CLAUDE.md parity requirement). AI-suggestion rendering is PR-mode only
 * because the E2E harness only mocks the PR analyses endpoint to seed
 * suggestions into the DB (see NOTE in the AI describe block).
 *
 * The per-worker test server (tests/e2e/test-server.js) seeds the same mock
 * two-file diff for review 1 (PR) and review 2 (Local).
 */

import { test, expect } from './fixtures.js';
import {
  waitForDiffToRender,
  waitForDiffType,
  setDiffView,
  openSplitCommentForm,
  expectAnnotationInSplitColumn,
  seedAISuggestions
} from './helpers.js';

const DIFF_VIEW_STORAGE_KEY = 'pair-review-diff-view';
const FILE = 'src/utils.js';

const MODES = [
  { name: 'PR mode', path: '/pr/test-owner/test-repo/1', reviewId: 1 },
  { name: 'Local mode', path: '/local/2', reviewId: 2 }
];

/**
 * Seed a user comment directly via the shared comment API (same endpoint for
 * PR and Local mode). Returns the created comment id.
 */
async function seedComment(page, reviewId, { file = FILE, line = 3, side = 'RIGHT', body }) {
  return page.evaluate(async ({ reviewId, file, line, side, body }) => {
    const resp = await fetch(`/api/reviews/${reviewId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, line_start: line, line_end: line, side, body })
    });
    const data = await resp.json();
    return data.commentId;
  }, { reviewId, file, line, side, body });
}

/** Delete every comment on a review so the shared worker DB stays clean. */
async function cleanupComments(page, reviewId) {
  await page.evaluate(async (rid) => {
    try {
      const resp = await fetch(`/api/reviews/${rid}/comments?includeDismissed=true`);
      const data = await resp.json();
      for (const c of (data.comments || [])) {
        await fetch(`/api/reviews/${rid}/comments/${c.id}`, { method: 'DELETE' });
      }
    } catch { /* best-effort */ }
  }, reviewId);
}

/**
 * Delete AI-seeded suggestions on a review so the shared worker DB stays clean.
 * The comment DELETE routes only touch user comments; AI rows (source='ai') need
 * the dedicated E2E cleanup hook served by tests/e2e/test-server.js.
 */
async function cleanupAISuggestions(page, reviewId) {
  await page.evaluate(async (rid) => {
    // fetch does NOT throw on 404 — only on network errors — so we must
    // inspect resp.ok ourselves, otherwise a missing route silently no-ops.
    const resp = await fetch(`/api/reviews/${rid}/ai-suggestions`, { method: 'DELETE' });
    if (!resp.ok) throw new Error(`AI cleanup failed: ${resp.status}`);
  }, reviewId);
}

for (const mode of MODES) {
  test.describe(`Split diff view (${mode.name})`, () => {
    test.afterEach(async ({ page }) => {
      await cleanupComments(page, mode.reviewId);
    });

    test('defaults to unified and toggles to split via the gear dropdown', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      // Default: the vendor stamps the unified layout as data-diff-type="single".
      await waitForDiffType(page, 'single');
      const hasSplitInitially = await page.evaluate(() => {
        return [...document.querySelectorAll('diffs-container')].some(
          (h) => h.shadowRoot && h.shadowRoot.querySelector('pre[data-diff-type="split"]')
        );
      });
      expect(hasSplitInitially).toBe(false);

      // Toggle to split.
      await setDiffView(page, 'split');

      // Both split columns are present for the file.
      const columns = await page.evaluate((file) => {
        const wrapper = document.querySelector(`.d2h-file-wrapper[data-file-name="${file}"]`);
        const sr = wrapper?.querySelector('diffs-container')?.shadowRoot;
        const pre = sr?.querySelector('pre');
        return {
          diffType: pre?.getAttribute('data-diff-type'),
          hasAdditions: !!pre?.querySelector('code[data-additions]'),
          hasDeletions: !!pre?.querySelector('code[data-deletions]')
        };
      }, FILE);
      expect(columns.diffType).toBe('split');
      expect(columns.hasAdditions).toBe(true);
      expect(columns.hasDeletions).toBe(true);

      // localStorage records the choice.
      const stored = await page.evaluate((k) => localStorage.getItem(k), DIFF_VIEW_STORAGE_KEY);
      expect(stored).toBe('split');
    });

    test('persists split across reload and can toggle back to unified', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      await setDiffView(page, 'split');
      await waitForDiffType(page, 'split');

      // Reload — the persisted choice should boot straight into split with no
      // further interaction.
      await page.reload();
      await waitForDiffToRender(page);
      await waitForDiffType(page, 'split');
      const storedAfterReload = await page.evaluate((k) => localStorage.getItem(k), DIFF_VIEW_STORAGE_KEY);
      expect(storedAfterReload).toBe('split');

      // Toggle back to unified.
      await setDiffView(page, 'unified');
      await waitForDiffType(page, 'single');
      const storedUnified = await page.evaluate((k) => localStorage.getItem(k), DIFF_VIEW_STORAGE_KEY);
      expect(storedUnified).toBe('unified');
    });

    test('a comment created in unified survives the toggle and lands in the additions column', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      const body = `Right-side survivor ${Date.now()}`;
      await seedComment(page, mode.reviewId, { line: 3, side: 'RIGHT', body });

      // Reload so the seeded comment is loaded and slotted in unified first.
      await page.reload();
      await waitForDiffToRender(page);
      await page.waitForSelector('.user-comment-row', { timeout: 10000 });
      await expect(page.locator('.user-comment-body', { hasText: body })).toBeVisible();

      // Switch to split — the comment must persist and render in the additions
      // (RIGHT) column.
      await setDiffView(page, 'split');
      await expect(page.locator('.user-comment-body', { hasText: body })).toBeVisible();
      await expectAnnotationInSplitColumn(page, { text: body, column: 'additions' });

      // Switch back to unified — still present.
      await setDiffView(page, 'unified');
      await expect(page.locator('.user-comment-body', { hasText: body })).toBeVisible();
    });

    test('creates a comment in split from the additions column', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await setDiffView(page, 'split');

      // New line 4 is a change-addition in the first hunk of utils.js.
      await openSplitCommentForm(page, { fileName: FILE, line: 4, side: 'additions' });

      const body = `Split additions comment ${Date.now()}`;
      const textarea = page.locator('.user-comment-form textarea');
      await textarea.fill(body);
      await page.locator('.save-comment-btn').click();

      await expect(page.locator('.user-comment-body', { hasText: body })).toBeVisible({ timeout: 5000 });
      await expectAnnotationInSplitColumn(page, { text: body, column: 'additions' });

      // The persisted comment is anchored on the RIGHT side. Match by the
      // unique body prefix (not line_start) so a leaked comment from a prior
      // spec in the same worker can't bind here.
      const side = await page.evaluate(async (rid) => {
        const resp = await fetch(`/api/reviews/${rid}/comments`);
        const data = await resp.json();
        const c = (data.comments || []).find((x) => x.body && x.body.startsWith('Split additions comment'));
        return c?.side;
      }, mode.reviewId);
      expect(side).toBe('RIGHT');
    });

    test('creates a comment in split from the deletions column', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await setDiffView(page, 'split');

      // Old line 3 ("  return null;") is a change-deletion in the first hunk.
      await openSplitCommentForm(page, { fileName: FILE, line: 3, side: 'deletions' });

      const body = `Split deletions comment ${Date.now()}`;
      const textarea = page.locator('.user-comment-form textarea');
      await textarea.fill(body);
      await page.locator('.save-comment-btn').click();

      await expect(page.locator('.user-comment-body', { hasText: body })).toBeVisible({ timeout: 5000 });
      await expectAnnotationInSplitColumn(page, { text: body, column: 'deletions' });

      const side = await page.evaluate(async (rid) => {
        const resp = await fetch(`/api/reviews/${rid}/comments`);
        const data = await resp.json();
        const c = (data.comments || []).find((x) => x.body && x.body.startsWith('Split deletions comment'));
        return c?.side;
      }, mode.reviewId);
      expect(side).toBe('LEFT');
    });
  });
}

/**
 * Full-width annotation cards in split. A lone card is stretched across both
 * columns by PierreBridge._syncSplitAnnotationLayout (.pr-annotation-fullwidth
 * + measured --pr-split-gutter-width). PR-mode only: the stretching runs in
 * the shared bridge render path, identical in Local mode (comment rendering
 * parity is already covered by the MODES loop above).
 */
test.describe('Split diff view — full-width annotation cards (PR mode)', () => {
  const PR_PATH = '/pr/test-owner/test-repo/1';

  test.afterEach(async ({ page }) => {
    await cleanupComments(page, 1);
  });

  /**
   * Resolve the shadow annotation cell hosting the light-DOM card containing
   * `text`, plus the geometry needed to prove it spans both columns.
   */
  async function cardMetrics(page, text) {
    return page.evaluate(({ file, text }) => {
      const wrapper = document.querySelector(`.d2h-file-wrapper[data-file-name="${file}"]`);
      const host = wrapper?.querySelector('diffs-container');
      const pre = host?.shadowRoot?.querySelector('pre[data-diff-type="split"]');
      if (!host || !pre) return null;
      const lightWrappers = [...host.querySelectorAll('[data-annotation-slot]')];
      const target = lightWrappers.find((w) => w.textContent.includes(text));
      const cell = target?.assignedSlot?.closest('[data-line-annotation]');
      if (!cell) return null;
      return {
        hasFullwidthClass: cell.classList.contains('pr-annotation-fullwidth'),
        cellWidth: cell.getBoundingClientRect().width,
        contentTrackWidth:
          pre.querySelector('code[data-additions] [data-content]')?.getBoundingClientRect().width || 0,
        preWidth: pre.getBoundingClientRect().width,
        gutterVar: pre.style.getPropertyValue('--pr-split-gutter-width')
      };
    }, { file: FILE, text });
  }

  for (const [column, line, side] of [['additions', 3, 'RIGHT'], ['deletions', 3, 'LEFT']]) {
    test(`stretches a lone ${column}-side card across both columns`, async ({ page }) => {
      await page.goto(PR_PATH);
      await waitForDiffToRender(page);

      const body = `Full width ${column} ${Date.now()}`;
      await seedComment(page, 1, { line, side, body });
      await page.reload();
      await waitForDiffToRender(page);
      await expect(page.locator('.user-comment-body', { hasText: body })).toBeVisible();

      await setDiffView(page, 'split');
      await expectAnnotationInSplitColumn(page, { text: body, column });

      // The stretch class is applied on a rAF after render — poll for it.
      await expect.poll(async () => (await cardMetrics(page, body))?.hasFullwidthClass, {
        timeout: 5000
      }).toBe(true);

      const metrics = await cardMetrics(page, body);
      // The measured middle-gutter width was published for the calc().
      expect(metrics.gutterVar).toMatch(/^\d+(\.\d+)?px$/);
      // Spans well past its own column (~2× a content track) yet stays
      // inside the pre.
      expect(metrics.cellWidth).toBeGreaterThan(metrics.contentTrackWidth * 1.8);
      expect(metrics.cellWidth).toBeLessThanOrEqual(metrics.preWidth);
    });
  }
});

/**
 * Readable prose measure on wide displays: annotation CARDS span the full
 * diff width (unified and split full-width layouts), but the prose blocks
 * inside them are capped at --annotation-prose-max (~80ch) so comment text
 * doesn't become one enormous line on wide monitors. PR-mode only: the CSS
 * is mode-independent (same classes in Local mode).
 */
test.describe('Annotation prose measure on wide displays (PR mode)', () => {
  const PR_PATH = '/pr/test-owner/test-repo/1';

  test.afterEach(async ({ page }) => {
    await cleanupComments(page, 1);
  });

  test('caps comment prose width while the card spans the row (unified and split)', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.goto(PR_PATH);
    await waitForDiffToRender(page);

    const longBody = 'Wide display readability check. ' +
      'This sentence repeats to guarantee the rendered markdown is long enough to hit the measure cap. '.repeat(4);
    await seedComment(page, 1, { line: 3, side: 'RIGHT', body: longBody });
    await page.reload();
    await waitForDiffToRender(page);

    // Comments are slotted into the shadow DOM in a separate async pass after
    // the diff renders, so measure() can read null if we don't wait for the
    // seeded comment to actually appear first (mirrors the split path below).
    await expect(page.locator('.user-comment-body', { hasText: longBody })).toBeVisible();

    const measure = () => page.evaluate(() => {
      const body = document.querySelector('.user-comment-body');
      const card = body?.closest('.user-comment');
      if (!body || !card) return null;
      return {
        bodyWidth: body.getBoundingClientRect().width,
        cardWidth: card.getBoundingClientRect().width
      };
    });

    // Unified: card rides the wide row, prose stays at a readable measure.
    const unified = await measure();
    expect(unified.cardWidth).toBeGreaterThan(1000);
    expect(unified.bodyWidth).toBeGreaterThan(300);
    expect(unified.bodyWidth).toBeLessThan(800);

    // Split (full-width card): same cap applies.
    await setDiffView(page, 'split');
    await expect(page.locator('.user-comment-body')).toBeVisible();
    const split = await measure();
    expect(split.bodyWidth).toBeGreaterThan(300);
    expect(split.bodyWidth).toBeLessThan(800);
  });
});

/**
 * One-sided files (entirely added / entirely removed) in split view.
 *
 * @pierre/diffs renders a whole-file add or whole-file delete as a single
 * `<code>` column inside `<pre data-diff-type="single">` (two-sided files get
 * `data-diff-type="split"`). PierreBridge.ANNOTATION_CSS boxes that lone column
 * into one half of a 1fr/1fr grid — additions (a new file) in the RIGHT half,
 * deletions (a deleted file) in the LEFT half — and _applySplitAnnotationLayout
 * stretches lone annotation cards across both halves via .pr-annotation-fullwidth.
 *
 * PR-mode only: this exercises the shared PierreBridge render path + injected
 * shadow CSS, which is byte-for-byte identical in Local mode (the bridge does
 * not know or care which route supplied the diff). The two-sided comment/toggle
 * behaviour that DOES differ per mode is already covered by the MODES loop above.
 *
 * The default seeded diff has no whole-file add/delete, so these tests install a
 * per-page route override adding `src/added.js` (all additions) and
 * `src/removed.js` (all deletions) alongside a two-sided `src/utils.js`
 * reference. file-contents upgrades are stubbed out so the pure add/delete
 * patches are never re-diffed into two-sided modifications.
 */
test.describe('Split diff view — one-sided files (PR mode)', () => {
  const PR_PATH = '/pr/test-owner/test-repo/1';
  const ADDED_FILE = 'src/added.js';
  const REMOVED_FILE = 'src/removed.js';
  // Two-sided file used only as the "split layout applied" gate (one-sided
  // files stay data-diff-type="single" in split, so setDiffView()'s all-hosts
  // wait can never settle with them present).
  const REF_FILE = 'src/utils.js';
  const TOL = 2; // px tolerance for sub-pixel box edges

  const ONE_SIDED_DIFF = [
    // Two-sided reference (has both - and + on one hunk → renders split).
    'diff --git a/src/utils.js b/src/utils.js',
    '--- a/src/utils.js',
    '+++ b/src/utils.js',
    '@@ -1,3 +1,3 @@',
    ' // Utility functions',
    '-const old = 1;',
    '+const updated = 2;',
    ' module.exports = {};',
    // Entirely-added file.
    'diff --git a/src/added.js b/src/added.js',
    'new file mode 100644',
    'index 0000000..abcdef1',
    '--- /dev/null',
    '+++ b/src/added.js',
    '@@ -0,0 +1,4 @@',
    '+// Brand new module',
    '+function created() {',
    '+  return 42;',
    '+}',
    // Entirely-removed file.
    'diff --git a/src/removed.js b/src/removed.js',
    'deleted file mode 100644',
    'index abcdef1..0000000',
    '--- a/src/removed.js',
    '+++ /dev/null',
    '@@ -1,4 +0,0 @@',
    '-// Old obsolete module',
    '-function gone() {',
    '-  return 0;',
    '-}',
    ''
  ].join('\n');

  const CHANGED_FILES = [
    { file: 'src/utils.js', additions: 1, deletions: 1 },
    { file: 'src/added.js', additions: 4, deletions: 0 },
    { file: 'src/removed.js', additions: 0, deletions: 4 }
  ];

  async function mockOneSidedDiff(page) {
    await page.route('**/api/pr/*/*/*/diff', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ diff: ONE_SIDED_DIFF, changed_files: CHANGED_FILES })
      })
    );
    // Suppress the full-contents Pierre upgrade for every file: the harness'
    // generic file-contents fallback returns a near-identical old/new pair,
    // which would re-diff a pure add/delete into a two-sided modification and
    // defeat the one-sided render under test. `tooLarge` short-circuits the
    // upgrade in pr.js, leaving the patch-only render intact.
    await page.route('**/api/reviews/*/file-contents/**', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tooLarge: true }) })
    );
  }

  /**
   * Toggle to split WITHOUT setDiffView()'s all-hosts gate (which never settles
   * while one-sided "single" pres are on the page). Gate on the two-sided
   * reference file flipping to the split layout instead — setDiffStyle()
   * re-renders every file synchronously, so once REF_FILE reports split the
   * one-sided files have re-rendered too.
   */
  async function switchToSplit(page) {
    await page.locator('#diff-options-btn').click();
    const option = page.locator('.diff-view-option[data-diff-view="split"]');
    await option.waitFor({ state: 'visible', timeout: 5000 });
    await option.click();
    await page.keyboard.press('Escape');
    await waitForDiffType(page, 'split', 5000, { fileName: REF_FILE });
  }

  /** Bounding boxes of a one-sided file's pre, code columns, and gutters. */
  async function oneSidedGeometry(page, file) {
    return page.evaluate((f) => {
      const pre = document
        .querySelector(`.d2h-file-wrapper[data-file-name="${f}"] diffs-container`)
        ?.shadowRoot?.querySelector('pre[data-diff-type="single"]');
      if (!pre) return null;
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      };
      const additions = pre.querySelector('code[data-additions]');
      const deletions = pre.querySelector('code[data-deletions]');
      const pr = pre.getBoundingClientRect();
      return {
        diffType: pre.getAttribute('data-diff-type'),
        pre: { left: pr.left, right: pr.right, width: pr.width, mid: pr.left + pr.width / 2 },
        additions: box(additions),
        deletions: box(deletions),
        addGutter: box(additions?.querySelector('[data-gutter]')),
        delGutter: box(deletions?.querySelector('[data-gutter]'))
      };
    }, file);
  }

  /** Full-width-card metrics for a lone card inside a one-sided (single) pre. */
  async function singleCardMetrics(page, file, text) {
    return page.evaluate(({ f, t }) => {
      const host = document.querySelector(`.d2h-file-wrapper[data-file-name="${f}"] diffs-container`);
      const pre = host?.shadowRoot?.querySelector('pre[data-diff-type="single"]');
      if (!host || !pre) return null;
      const wrapper = [...host.querySelectorAll('[data-annotation-slot]')]
        .find((w) => (w.textContent || '').includes(t));
      const cell = wrapper?.assignedSlot?.closest('[data-line-annotation]');
      if (!cell) return null;
      return {
        hasFullwidthClass: cell.classList.contains('pr-annotation-fullwidth'),
        cellWidth: cell.getBoundingClientRect().width,
        preWidth: pre.getBoundingClientRect().width,
        gutterVar: pre.style.getPropertyValue('--pr-split-gutter-width')
      };
    }, { f: file, t: text });
  }

  test.afterEach(async ({ page }) => {
    await cleanupComments(page, 1);
  });

  test('renders an entirely-added file in the RIGHT half in split', async ({ page }) => {
    await mockOneSidedDiff(page);
    await page.goto(PR_PATH);
    await waitForDiffToRender(page);
    await page.waitForSelector(`.d2h-file-wrapper[data-file-name="${ADDED_FILE}"]`);

    await switchToSplit(page);

    await expect.poll(async () => {
      const g = await oneSidedGeometry(page, ADDED_FILE);
      if (!g) return 'no-pre';
      if (g.diffType !== 'single') return `diffType=${g.diffType}`;
      if (!g.additions) return 'no-additions-column';
      const leftOk = g.additions.left >= g.pre.mid - TOL;
      const rightOk = g.additions.right <= g.pre.right + TOL;
      return leftOk && rightOk ? 'right-half' : 'wrong-place';
    }, { timeout: 5000 }).toBe('right-half');
  });

  test('renders an entirely-removed file in the LEFT half in split', async ({ page }) => {
    await mockOneSidedDiff(page);
    await page.goto(PR_PATH);
    await waitForDiffToRender(page);
    await page.waitForSelector(`.d2h-file-wrapper[data-file-name="${REMOVED_FILE}"]`);

    await switchToSplit(page);

    await expect.poll(async () => {
      const g = await oneSidedGeometry(page, REMOVED_FILE);
      if (!g) return 'no-pre';
      if (g.diffType !== 'single') return `diffType=${g.diffType}`;
      if (!g.deletions) return 'no-deletions-column';
      const leftOk = g.deletions.left >= g.pre.left - TOL;
      const rightOk = g.deletions.right <= g.pre.mid + TOL;
      return leftOk && rightOk ? 'left-half' : 'wrong-place';
    }, { timeout: 5000 }).toBe('left-half');
  });

  test('keeps one-sided line-number gutters inside their own half', async ({ page }) => {
    await mockOneSidedDiff(page);
    await page.goto(PR_PATH);
    await waitForDiffToRender(page);
    await page.waitForSelector(`.d2h-file-wrapper[data-file-name="${ADDED_FILE}"]`);
    await page.waitForSelector(`.d2h-file-wrapper[data-file-name="${REMOVED_FILE}"]`);

    await switchToSplit(page);

    // Added (right-half) file: its gutter must not cross into the left half.
    await expect.poll(async () => {
      const g = await oneSidedGeometry(page, ADDED_FILE);
      if (!g?.addGutter) return 'no-gutter';
      return g.addGutter.left >= g.pre.mid - TOL ? 'in-right-half' : 'crossed-midpoint';
    }, { timeout: 5000 }).toBe('in-right-half');

    // Removed (left-half) file: its gutter must not cross into the right half.
    await expect.poll(async () => {
      const g = await oneSidedGeometry(page, REMOVED_FILE);
      if (!g?.delGutter) return 'no-gutter';
      return g.delGutter.right <= g.pre.mid + TOL ? 'in-left-half' : 'crossed-midpoint';
    }, { timeout: 5000 }).toBe('in-left-half');
  });

  test('stretches a lone card across the full width of a one-sided file', async ({ page }) => {
    await mockOneSidedDiff(page);
    await page.goto(PR_PATH);
    await waitForDiffToRender(page);
    await page.waitForSelector(`.d2h-file-wrapper[data-file-name="${ADDED_FILE}"]`);

    const body = `One-sided full width ${Date.now()}`;
    // Line 2 of the added file is an addition (RIGHT side).
    await seedComment(page, 1, { file: ADDED_FILE, line: 2, side: 'RIGHT', body });
    await page.reload();
    await waitForDiffToRender(page);
    await expect(page.locator('.user-comment-body', { hasText: body })).toBeVisible();

    await switchToSplit(page);
    // The lone card slots into the added file's single additions column.
    await expectAnnotationInSplitColumn(page, { text: body, column: 'additions' });

    // .pr-annotation-fullwidth is applied on a rAF after render — poll for it.
    await expect.poll(async () => (await singleCardMetrics(page, ADDED_FILE, body))?.hasFullwidthClass, {
      timeout: 5000
    }).toBe(true);

    const m = await singleCardMetrics(page, ADDED_FILE, body);
    // The measured gutter width was published for the stretch calc().
    expect(m.gutterVar).toMatch(/^\d+(\.\d+)?px$/);
    // Card spans (approximately) the full pre width, never overflowing it.
    expect(m.cellWidth / m.preWidth).toBeGreaterThan(0.9);
    expect(m.cellWidth).toBeLessThanOrEqual(m.preWidth + TOL);
  });

  test('restores a one-sided file to full width when toggled back to unified', async ({ page }) => {
    await mockOneSidedDiff(page);
    await page.goto(PR_PATH);
    await waitForDiffToRender(page);
    await page.waitForSelector(`.d2h-file-wrapper[data-file-name="${ADDED_FILE}"]`);

    await switchToSplit(page);
    // Sanity: it is boxed into the right half while split.
    await expect.poll(async () => {
      const g = await oneSidedGeometry(page, ADDED_FILE);
      return g?.additions ? g.additions.left >= g.pre.mid - TOL : null;
    }, { timeout: 5000 }).toBe(true);

    // Back to unified — every host reports "single", so setDiffView's gate is
    // safe here. The file must render one full-width `code[data-unified]`
    // column with no half-width split leak.
    await setDiffView(page, 'unified');

    await expect.poll(async () => {
      return page.evaluate((f) => {
        const pre = document
          .querySelector(`.d2h-file-wrapper[data-file-name="${f}"] diffs-container`)
          ?.shadowRoot?.querySelector('pre[data-diff-type="single"]');
        if (!pre) return null;
        const code = pre.querySelector('code[data-unified]');
        if (!code) return null;
        const cr = code.getBoundingClientRect();
        const pr = pre.getBoundingClientRect();
        return {
          ratio: pr.width ? cr.width / pr.width : 0,
          // No side-specific columns → no half-width grid boxing leaked in.
          hasSideColumns: !!pre.querySelector('code[data-additions], code[data-deletions]')
        };
      }, ADDED_FILE);
    }, { timeout: 5000 }).toEqual({ ratio: expect.any(Number), hasSideColumns: false });

    const u = await page.evaluate((f) => {
      const pre = document
        .querySelector(`.d2h-file-wrapper[data-file-name="${f}"] diffs-container`)
        ?.shadowRoot?.querySelector('pre[data-diff-type="single"]');
      const code = pre?.querySelector('code[data-unified]');
      return { ratio: code.getBoundingClientRect().width / pre.getBoundingClientRect().width };
    }, ADDED_FILE);
    expect(u.ratio).toBeGreaterThan(0.9);
  });

  /**
   * PAINT-level regression for the "empty card" bug: a full-width-stretched
   * annotation card on a one-sided file must actually PAINT its header text and
   * body, not merely lay them out at the right coordinates.
   *
   * The boxing above makes the one-sided `code[data-<side>]` a real box, which
   * activates the vendor's `code { contain: content }` — and `contain: content`
   * implies `contain: PAINT`, which clips descendant paint to that box
   * regardless of `overflow`. A `.pr-annotation-fullwidth` card reaches LEFT out
   * of its box (margin-left: calc(-100% - 2g)), so paint containment hid its
   * header text + body while the right-aligned action buttons (inside the box)
   * still painted — the geometry stayed correct, so a getBoundingClientRect
   * assertion could not see it. ANNOTATION_CSS drops paint containment
   * (`contain: layout style`) on these columns; this test guards that.
   *
   * The probe is a shadow-piercing hit-test at the card's header + body text
   * coordinates: `elementFromPoint` (recursed through shadow roots) resolves to
   * the actual text element only when that region is painted/hit-testable. Under
   * paint containment the point lies outside the code column's box and resolves
   * elsewhere, so `insideComment` is false.
   */
  test('paints the header text and body of a stretched one-sided card (not just its box)', async ({ page }) => {
    await mockOneSidedDiff(page);
    await page.goto(PR_PATH);
    await waitForDiffToRender(page);
    await page.waitForSelector(`.d2h-file-wrapper[data-file-name="${ADDED_FILE}"]`);

    const body = `Paint check ${Date.now()} — this header and body must be visible.`;
    // Line 2 of the added file is an addition (RIGHT side).
    await seedComment(page, 1, { file: ADDED_FILE, line: 2, side: 'RIGHT', body });
    await page.reload();
    await waitForDiffToRender(page);
    await expect(page.locator('.user-comment-body', { hasText: body })).toBeVisible();

    await switchToSplit(page);
    await expectAnnotationInSplitColumn(page, { text: body, column: 'additions' });
    // The stretch class lands on a rAF after render — gate on it before probing.
    await expect.poll(async () => (await singleCardMetrics(page, ADDED_FILE, body))?.hasFullwidthClass, {
      timeout: 5000
    }).toBe(true);

    // Shadow-piercing hit-test at the card's header-left and body text. Both sit
    // in the LEFT portion of the stretched card — the region paint containment
    // clipped — so a resolve to an element inside .user-comment proves paint.
    const paint = await page.evaluate(async (file) => {
      // Ensure a paint has occurred after the fullwidth class was applied.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const pierce = (x, y) => {
        let el = document.elementFromPoint(x, y);
        while (el && el.shadowRoot) {
          const inner = el.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === el) break;
          el = inner;
        }
        return el;
      };
      const scope = document.querySelector(`.d2h-file-wrapper[data-file-name="${file}"]`);
      const headerLeft = scope.querySelector('.user-comment-header-left');
      const bodyEl = scope.querySelector('.user-comment-body');
      const probe = (el) => {
        const r = el.getBoundingClientRect();
        // A few px in from the element's left edge, at its vertical centre.
        const hit = pierce(r.left + 4, r.top + r.height / 2);
        return {
          insideComment: !!(hit && hit.closest && hit.closest('.user-comment')),
          left: Math.round(r.left)
        };
      };
      return {
        header: probe(headerLeft),
        body: probe(bodyEl)
      };
    }, ADDED_FILE);

    // Both the header text and the body must actually paint (be hit-testable),
    // even though they lie in the stretched card's left half, outside the code
    // column's own box. Under the paint-containment bug these points resolve to
    // an element outside .user-comment (the clipped-away region), failing here.
    expect(paint.header.insideComment).toBe(true);
    expect(paint.body.insideComment).toBe(true);
  });
});

/**
 * AI suggestions in split. PR-mode only: the harness mocks
 * POST /api/pr/:owner/:repo/:number/analyses to insert mock suggestions into
 * the DB. There is no equivalent mock for the Local analyses route (it would
 * invoke the real AI pipeline), so seeded suggestions cannot be produced in
 * Local mode within this harness. The rendering path being exercised (per-side
 * annotation slotting) is identical to the comment path already covered in both
 * modes, so this PR-only test is sufficient for split coverage.
 */
test.describe('Split diff view — AI suggestions (PR mode)', () => {
  const PR_PATH = '/pr/test-owner/test-repo/1';

  // Symmetric teardown: this block seeds AI rows into review 1 via the analyses
  // route. Without cleanup they leak into later tests that revisit review 1.
  test.afterEach(async ({ page }) => {
    await cleanupAISuggestions(page, 1);
  });

  test('renders an AI suggestion in the additions column in split', async ({ page }) => {
    await page.goto(PR_PATH);
    await waitForDiffToRender(page);
    // Original inline copy waited on '.ai-suggestion' only; keep that selector.
    await seedAISuggestions(page, { suggestionSelector: '.ai-suggestion' });

    // Mock suggestion 1001 ("Consider using const for immutable values") is a
    // final (ai_level null) suggestion on utils.js line 3 — a RIGHT-side line.
    const suggestionText = 'Consider using const for immutable values';
    await expect(page.locator('.ai-suggestion', { hasText: suggestionText }).first())
      .toBeVisible({ timeout: 5000 });

    await setDiffView(page, 'split');

    // Suggestion survives the toggle and renders in the additions column.
    await expect(page.locator('.ai-suggestion', { hasText: suggestionText }).first())
      .toBeVisible({ timeout: 5000 });
    await expectAnnotationInSplitColumn(page, { text: suggestionText, column: 'additions' });
  });
});
