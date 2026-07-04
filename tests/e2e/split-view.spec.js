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
  expectAnnotationInSplitColumn
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

      // The persisted comment is anchored on the RIGHT side.
      const side = await page.evaluate(async (rid) => {
        const resp = await fetch(`/api/reviews/${rid}/comments`);
        const data = await resp.json();
        const c = (data.comments || []).find((x) => x.line_start === 4);
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

  async function seedAISuggestions(page) {
    const result = await page.evaluate(async () => {
      const resp = await fetch('/api/pr/test-owner/test-repo/1/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (!resp.ok) throw new Error(`Analysis API failed: ${resp.status}`);
      return resp.json();
    });
    if (!result.analysisId) throw new Error('Analysis failed to start');

    await page.waitForFunction(async () => {
      const reviewId = window.prManager?.currentPR?.id;
      if (!reviewId) return false;
      const resp = await fetch(`/api/reviews/${reviewId}/analyses/status`);
      return !(await resp.json()).running;
    }, null, { timeout: 5000 });

    await page.evaluate(async () => {
      if (window.prManager?.loadAISuggestions) await window.prManager.loadAISuggestions();
    });
    await page.waitForSelector('.ai-suggestion', { timeout: 5000 });

    // The POST re-shows the progress modal; hide it so it can't intercept clicks.
    await page.evaluate(() => {
      const modal = document.getElementById('council-progress-modal');
      if (modal) modal.style.display = 'none';
    });
  }

  test('renders an AI suggestion in the additions column in split', async ({ page }) => {
    await page.goto(PR_PATH);
    await waitForDiffToRender(page);
    await seedAISuggestions(page);

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
