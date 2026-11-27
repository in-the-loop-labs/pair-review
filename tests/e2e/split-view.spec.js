// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Split (side-by-side) Diff View
 *
 * Covers the diff-layout toggle built on top of @pierre/diffs:
 *   - Default layout is unified; the gear → "Diff view" segmented control
 *     switches to split: one code column per file ("single") becomes two
 *     ("split").  How a layout is detected is diff-dom.js's business.
 *   - The choice persists to localStorage (`pair-review-diff-view`) and
 *     survives reload; toggling back to unified works.
 *   - Annotations (user comments, AI suggestions) survive the toggle and, in
 *     split, render in the column matching their side (additions = RIGHT,
 *     deletions = LEFT) — this is @pierre/diffs' per-column design.
 *   - Comments can be created in split mode from either column.
 *
 * Every test runs in BOTH PR mode and Local mode (CLAUDE.md parity
 * requirement), except AI-suggestion rendering, which is PR-mode only
 * because the E2E harness only mocks the PR analyses endpoint to seed
 * suggestions into the DB (see NOTE in the AI describe block).
 *
 * The per-worker test server (tests/e2e/test-server.js) seeds the same mock
 * two-file diff for review 1 (PR) and review 2 (Local).
 */

import { test, expect } from './fixtures.js';
import {
  waitForDiffToRender, waitForDiffType, setDiffView, openSplitCommentForm, expectAnnotationInSplitColumn, seedAISuggestions, cleanupAISuggestions, cleanupComments, cleanupAllComments,
  openDiffOptions
} from './helpers.js';
import { anyFileInSplitLayout, fileLayout, annotationCell, paintProbe } from './diff-dom.js';
import { customCorpus, routeDiff } from './fixtures/diffs.js';

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

for (const mode of MODES) {
  test.describe(`Split diff view (${mode.name})`, () => {
    test.afterEach(async ({ page }) => {
      await cleanupComments(page, mode.reviewId);
    });

    test('defaults to unified and toggles to split via the gear dropdown', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      // Default: unified (one code column per file).
      await waitForDiffType(page, 'single');
      expect(await anyFileInSplitLayout(page)).toBe(false);

      // Toggle to split.
      await setDiffView(page, 'split');

      // Both split columns are present for the file.
      const columns = await fileLayout(page, FILE);
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
 * + measured --pr-split-gutter-width).
 */
for (const mode of MODES) {
test.describe(`Split diff view — full-width annotation cards (${mode.name})`, () => {
  const PR_PATH = mode.path;

  test.afterEach(async ({ page }) => {
    await cleanupComments(page, mode.reviewId);
  });

  /**
   * The cell hosting the card containing `text`, plus the geometry needed to
   * prove it spans both columns. Null until the card is slotted in split.
   */
  async function cardMetrics(page, text) {
    const cell = await annotationCell(page, FILE, text);
    if (!cell || cell.diffType !== 'split') return null;
    const layout = await fileLayout(page, FILE);
    return { ...cell, contentTrackWidth: layout?.additionsContent?.width || 0 };
  }

  for (const [column, line, side] of [['additions', 3, 'RIGHT'], ['deletions', 3, 'LEFT']]) {
    test(`stretches a lone ${column}-side card across both columns`, async ({ page }) => {
      await page.goto(PR_PATH);
      await waitForDiffToRender(page);

      const body = `Full width ${column} ${Date.now()}`;
      await seedComment(page, mode.reviewId, { line, side, body });
      await page.reload();
      await waitForDiffToRender(page);
      await expect(page.locator('.user-comment-body', { hasText: body })).toBeVisible();

      await setDiffView(page, 'split');
      await expectAnnotationInSplitColumn(page, { text: body, column });

      // The stretch class is applied on a rAF after render — poll for it.
      await expect.poll(async () => (await cardMetrics(page, body))?.hasFullwidthClass, {
        timeout: 5000
      }).toBe(true);

      // Spans well past its own column (~2× a content track). The class is
      // stamped first and the stretch laid out after it, and the content
      // upgrade re-creates the rows: wait for the settled width.
      await expect.poll(async () => {
        const current = await cardMetrics(page, body);
        return current && current.contentTrackWidth > 0 ? current.cellWidth / current.contentTrackWidth : 0;
      }, { timeout: 5000 }).toBeGreaterThan(1.8);

      const metrics = await cardMetrics(page, body);
      // The measured middle-gutter width was published for the calc().
      expect(metrics.gutterVar).toMatch(/^\d+(\.\d+)?px$/);
      // ... yet stays inside the pre.
      expect(metrics.cellWidth).toBeLessThanOrEqual(metrics.preWidth);
    });
  }
});
}

/**
 * Readable prose measure on wide displays: annotation CARDS span the full
 * diff width (unified and split full-width layouts), but the prose blocks
 * inside them are capped at --annotation-prose-max (~80ch) so comment text
 * doesn't become one enormous line on wide monitors.
 */
for (const mode of MODES) {
test.describe(`Annotation prose measure on wide displays (${mode.name})`, () => {
  const PR_PATH = mode.path;

  test.afterEach(async ({ page }) => {
    await cleanupComments(page, mode.reviewId);
  });

  test('caps comment prose width while the card spans the row (unified and split)', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.goto(PR_PATH);
    await waitForDiffToRender(page);

    const longBody = 'Wide display readability check. ' +
      'This sentence repeats to guarantee the rendered markdown is long enough to hit the measure cap. '.repeat(4);
    await seedComment(page, mode.reviewId, { line: 3, side: 'RIGHT', body: longBody });
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
}

/**
 * One-sided files (entirely added / entirely removed) in split view.
 *
 * A whole-file add or whole-file delete renders as a single code column even
 * in split layout (its layout stays "single"; two-sided files become
 * "split"). PierreBridge.ANNOTATION_CSS boxes that lone column
 * into one half of a 1fr/1fr grid — additions (a new file) in the RIGHT half,
 * deletions (a deleted file) in the LEFT half — and _applySplitAnnotationLayout
 * stretches lone annotation cards across both halves via .pr-annotation-fullwidth.
 *
 * The default seeded diff has no whole-file add/delete, so these tests route a
 * diff with `src/added.js` (all additions) and `src/removed.js` (all
 * deletions) alongside a two-sided `src/utils.js` reference, with the
 * contents that belong to it.
 */
for (const mode of MODES) {
test.describe(`Split diff view — one-sided files (${mode.name})`, () => {
  const PR_PATH = mode.path;
  const ADDED_FILE = 'src/added.js';
  const REMOVED_FILE = 'src/removed.js';
  // Two-sided file used only as the "split layout applied" gate (one-sided
  // files stay in "single" layout in split, so setDiffView()'s all-files
  // wait can never settle with them present).
  const REF_FILE = 'src/utils.js';
  const TOL = 2; // px tolerance for sub-pixel box edges

  // Two tests below save a comment on src/added.js. The server does not find
  // that file in the review's stored diff (the diff is routed), so it also
  // adds the file as a context file. Left behind, the comments and the
  // context file show up on every later page load of this review in the
  // worker: a third file in the pane and a third sidebar entry.
  test.afterEach(async ({ page }) => {
    await cleanupAllComments(page, mode.reviewId);
  });

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

  // The contents these patches were taken from. With truthful contents the
  // content upgrade keeps an added file all-additions and a removed file
  // all-deletions, so the one-sided render under test is also what the file
  // looks like after the upgrade.
  const ONE_SIDED = customCorpus({
    name: 'one-sided',
    diff: ONE_SIDED_DIFF,
    files: {
      'src/utils.js': {
        old: '// Utility functions\nconst old = 1;\nmodule.exports = {};\n',
        new: '// Utility functions\nconst updated = 2;\nmodule.exports = {};\n'
      },
      'src/added.js': { old: null, new: '// Brand new module\nfunction created() {\n  return 42;\n}\n' },
      'src/removed.js': { old: '// Old obsolete module\nfunction gone() {\n  return 0;\n}\n', new: null }
    }
  });

  async function mockOneSidedDiff(page) {
    await routeDiff(page, ONE_SIDED);
  }

  /**
   * Toggle to split WITHOUT setDiffView()'s all-hosts gate (which never settles
   * while one-sided "single" pres are on the page). Gate on the two-sided
   * reference file flipping to the split layout instead — setDiffStyle()
   * re-renders every file synchronously, so once REF_FILE reports split the
   * one-sided files have re-rendered too.
   */
  async function switchToSplit(page) {
    await openDiffOptions(page);
    const option = page.locator('.diff-view-option[data-diff-view="split"]');
    await option.waitFor({ state: 'visible', timeout: 5000 });
    await option.click();
    await page.keyboard.press('Escape');
    await waitForDiffType(page, 'split', 5000, { fileName: REF_FILE });
  }

  /** Bounding boxes of a one-sided file's diff, code columns, and gutters. */
  async function oneSidedGeometry(page, file) {
    const layout = await fileLayout(page, file);
    return layout && layout.diffType === 'single' ? layout : null;
  }

  /** Full-width-card metrics for a lone card inside a one-sided file. */
  async function singleCardMetrics(page, file, text) {
    const cell = await annotationCell(page, file, text);
    return cell && cell.diffType === 'single' ? cell : null;
  }

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
    await seedComment(page, mode.reviewId, { file: ADDED_FILE, line: 2, side: 'RIGHT', body });
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

    // Card spans (approximately) the full pre width. The class is stamped
    // first and the stretch is laid out after it (and rows are re-created by
    // the content upgrade), so wait for the settled width; never read once.
    await expect.poll(async () => {
      const metrics = await singleCardMetrics(page, ADDED_FILE, body);
      return metrics ? metrics.cellWidth / metrics.preWidth : 0;
    }, { timeout: 5000 }).toBeGreaterThan(0.9);

    const m = await singleCardMetrics(page, ADDED_FILE, body);
    // The measured gutter width was published for the stretch calc().
    expect(m.gutterVar).toMatch(/^\d+(\.\d+)?px$/);
    // ... and never overflows it.
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
    // safe here. The file must render one full-width unified
    // column with no half-width split leak.
    await setDiffView(page, 'unified');

    await expect.poll(async () => {
      const layout = await fileLayout(page, ADDED_FILE);
      if (!layout || layout.diffType !== 'single' || !layout.unified) return null;
      return {
        ratio: layout.pre.width ? layout.unified.width / layout.pre.width : 0,
        // No side-specific columns → no half-width grid boxing leaked in.
        hasSideColumns: layout.hasAdditions || layout.hasDeletions
      };
    }, { timeout: 5000 }).toEqual({ ratio: expect.any(Number), hasSideColumns: false });

    const unifiedLayout = await fileLayout(page, ADDED_FILE);
    expect(unifiedLayout.unified.width / unifiedLayout.pre.width).toBeGreaterThan(0.9);
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
    await seedComment(page, mode.reviewId, { file: ADDED_FILE, line: 2, side: 'RIGHT', body });
    await page.reload();
    await waitForDiffToRender(page);
    await expect(page.locator('.user-comment-body', { hasText: body })).toBeVisible();

    await switchToSplit(page);
    await expectAnnotationInSplitColumn(page, { text: body, column: 'additions' });
    // The stretch class lands on a rAF after render — gate on it before probing.
    await expect.poll(async () => (await singleCardMetrics(page, ADDED_FILE, body))?.hasFullwidthClass, {
      timeout: 5000
    }).toBe(true);

    // Hit-test at the card's header-left and body text. Both sit in the LEFT
    // portion of the stretched card — the region paint containment clipped —
    // so a resolve to an element inside .user-comment proves paint.
    const paint = {
      header: await paintProbe(page, ADDED_FILE, '.user-comment-header-left', '.user-comment'),
      body: await paintProbe(page, ADDED_FILE, '.user-comment-body', '.user-comment')
    };

    // Both the header text and the body must actually paint (be hit-testable),
    // even though they lie in the stretched card's left half, outside the code
    // column's own box. Under the paint-containment bug these points resolve to
    // an element outside .user-comment (the clipped-away region), failing here.
    expect(paint.header.inside).toBe(true);
    expect(paint.body.inside).toBe(true);
  });
});
}

/**
 * AI suggestions in split, in both modes. tests/e2e/test-server.js mocks each
 * mode's analyses endpoint to insert the same mock suggestions for the review.
 */
for (const mode of MODES) {
  test.describe(`Split diff view — AI suggestions (${mode.name})`, () => {
    // Symmetric teardown: this block seeds AI rows into the review. Without
    // cleanup they leak into later tests that revisit it.
    test.afterEach(async ({ page }) => {
      await cleanupAISuggestions(page, mode.reviewId);
    });

    test('renders an AI suggestion in the additions column in split', async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      // Original inline copy waited on '.ai-suggestion' only; keep that selector.
      await seedAISuggestions(page, { suggestionSelector: '.ai-suggestion', reviewId: mode.reviewId });

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
}
