// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E: Minimize Comments mode under the @pierre/diffs renderer.
 *
 * Regression coverage for the minimize feature after the @pierre/diffs
 * migration. Diff lines are shadow-DOM elements and annotation cards live in
 * the light DOM inside vendor `[data-annotation-slot]` wrappers. The minimizer
 * must, when enabled:
 *   - hide inline user-comment AND AI-suggestion cards (the suggestion case
 *     regressed — bare `.ai-suggestion` had no `-row` wrapper so the old hide
 *     rules and the old line scan both missed it),
 *   - collapse the annotation row to ZERO height and float a single indicator
 *     pill over the anchor code line (so it doesn't read as a collapsed
 *     comment breaking up the diff),
 *   - reveal that line's cards again when the indicator is clicked,
 * and remove every indicator when disabled. The one-sided (entirely-added)
 * split case is exercised too — its column carries paint-free containment and
 * its annotation cell is fullwidth-stretched, both of which the overlay must
 * survive.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender, seedAISuggestions, openCommentFormOnLine, waitForDiffType } from './helpers.js';

// A line-level annotation card slotted below a diff line (excludes
// file-comments-zone cards, which are not inside a slot wrapper).
const SLOTTED_SUGGESTION = '#diff-container [data-annotation-slot] > .ai-suggestion';
const SLOTTED_COMMENT = '#diff-container [data-annotation-slot] > .user-comment-row';
const LINE_INDICATOR = '#diff-container [data-annotation-slot] .comment-indicator';

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

test.describe('Minimize comments (pierre renderer)', () => {
  test.afterEach(async ({ page }) => {
    // The worker DB is shared across spec files (fullyParallel: false), so both
    // user comments AND seeded AI suggestions must be swept — GET /comments does
    // not return source='ai' rows, so they need the dedicated delete route.
    await page.evaluate(async () => {
      const resp = await fetch('/api/reviews/1/comments?includeDismissed=true');
      const data = await resp.json();
      for (const c of (data.comments || [])) {
        await fetch(`/api/reviews/1/comments/${c.id}`, { method: 'DELETE' });
      }
      // fetch only rejects on network errors, so assert resp.ok ourselves.
      const aiResp = await fetch('/api/reviews/1/ai-suggestions', { method: 'DELETE' });
      if (!aiResp.ok) throw new Error(`AI cleanup failed: ${aiResp.status}`);
    });
  });

  test('hides suggestion + comment cards behind line indicators and toggles them back', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // A real AI suggestion rendered inline in the diff.
    await seedAISuggestions(page);
    const suggestion = page.locator(SLOTTED_SUGGESTION).first();
    await expect(suggestion).toBeVisible();

    // A real user comment rendered inline in the diff.
    await openCommentFormOnLine(page, 0);
    const textarea = page.locator('.user-comment-form textarea');
    await textarea.fill('Minimize me');
    await page.locator('.save-comment-btn').click();
    await expect(page.locator('.user-comment-form')).toBeHidden({ timeout: 5000 });
    const comment = page.locator(SLOTTED_COMMENT).first();
    await expect(comment).toBeVisible();

    // --- Enable minimize ---
    await setMinimize(page, true);

    // Both card types are now hidden (the suggestion is the regression case).
    await expect(suggestion).toBeHidden();
    await expect(comment).toBeHidden();

    // At least one line indicator is visible.
    const indicators = page.locator(LINE_INDICATOR);
    await expect(indicators.first()).toBeVisible();
    const indicatorCount = await indicators.count();
    expect(indicatorCount).toBeGreaterThan(0);

    // The collapsed annotation row must add ZERO height — the pill is an
    // absolutely-positioned overlay, so the wrapper contributes no layout box.
    // This is the crux of the "don't break up the diff" fix.
    const wrapperHeight = await page
      .locator('#diff-container [data-annotation-slot]:has(> .comment-indicator)')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(wrapperHeight).toBe(0);

    // The wrapper is the scroll anchor for AI-panel navigation
    // (CommentMinimizer.findDiffRowFor returns it). It must carry a non-zero
    // scroll-margin-top so scrollIntoView lands it below the sticky toolbar
    // instead of flush under it.
    const scrollMargin = await page
      .locator('#diff-container [data-annotation-slot]:has(> .comment-indicator)')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).scrollMarginTop));
    expect(scrollMargin).toBeGreaterThan(0);

    // --- Click the indicator on the suggestion's line: its card reappears ---
    const suggestionIndicator = page
      .locator('#diff-container [data-annotation-slot]:has(> .ai-suggestion) .comment-indicator')
      .first();
    await expect(suggestionIndicator).toBeVisible();
    await suggestionIndicator.click();
    await expect(suggestion).toBeVisible();

    // --- Disable minimize: indicators gone, cards visible again ---
    await setMinimize(page, false);
    await expect(page.locator(LINE_INDICATOR)).toHaveCount(0);
    await expect(suggestion).toBeVisible();
    await expect(comment).toBeVisible();
  });

  test('AI-panel navigation lands a minimized suggestion below the sticky toolbar', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await seedAISuggestions(page);

    await setMinimize(page, true);

    // Open the AI panel and navigate to the first finding — this drives
    // expandForElement + scroll-to-wrapper, the path that regressed under the
    // sticky toolbar without scroll-margin on the wrapper.
    await page.evaluate(() => window.aiPanel?.expand());
    await page.waitForSelector('.finding-item', { timeout: 5000 });
    await page.locator('.finding-item').first().click();

    // The navigated card is expanded and visible; its top must sit at/below the
    // sticky toolbar's bottom (not hidden underneath it). Poll while the smooth
    // scroll settles.
    const expandedCard = page
      .locator('#diff-container [data-annotation-slot] > .ai-suggestion.comment-expanded')
      .first();
    await expect(expandedCard).toBeVisible();
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const toolbar = document.querySelector('.diff-toolbar');
          const card = document.querySelector(
            '#diff-container [data-annotation-slot] > .ai-suggestion.comment-expanded'
          );
          if (!toolbar || !card) return -1;
          const toolbarBottom = toolbar.getBoundingClientRect().bottom;
          const cardTop = card.getBoundingClientRect().top;
          // Positive margin = card is fully below the sticky toolbar.
          return Math.round(cardTop - toolbarBottom);
        });
      }, { timeout: 5000 })
      .toBeGreaterThanOrEqual(0);
  });

  // An entirely-added file renders as a one-sided `data-diff-type="single"` pre
  // in split view. Its code column carries `contain: layout style` and its
  // annotation cell is fullwidth-stretched — the overlay pill must still float
  // over the anchor line at zero row height and stay clickable there.
  test('overlays the indicator on a one-sided (entirely-added) file in split view', async ({ page }) => {
    const ADDED_FILE = 'src/added.js';
    const REF_FILE = 'src/utils.js';
    const ONE_SIDED_DIFF = [
      // Two-sided reference so split layout has a host that settles.
      'diff --git a/src/utils.js b/src/utils.js',
      '--- a/src/utils.js',
      '+++ b/src/utils.js',
      '@@ -1,3 +1,3 @@',
      ' // Utility functions',
      '-const old = 1;',
      '+const updated = 2;',
      ' module.exports = {};',
      // Entirely-added file → one-sided "single" pre in split.
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
      ''
    ].join('\n');
    const CHANGED_FILES = [
      { file: 'src/utils.js', additions: 1, deletions: 1 },
      { file: 'src/added.js', additions: 4, deletions: 0 }
    ];

    await page.route('**/api/pr/*/*/*/diff', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ diff: ONE_SIDED_DIFF, changed_files: CHANGED_FILES })
      })
    );
    // Keep the pure-add render one-sided (see split-view.spec.js rationale).
    await page.route('**/api/reviews/*/file-contents/**', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tooLarge: true }) })
    );

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed a comment on the added file (RIGHT/additions side, line 2).
    await page.evaluate(async () => {
      await fetch('/api/reviews/1/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'src/added.js', line_start: 2, line_end: 2, side: 'RIGHT', body: 'one-sided overlay' })
      });
    });
    await page.reload();
    await waitForDiffToRender(page);

    const addedWrapper = `.d2h-file-wrapper[data-file-name="${ADDED_FILE}"]`;
    const comment = page.locator(`${addedWrapper} [data-annotation-slot] > .user-comment-row`).first();
    await expect(comment).toBeVisible();

    // Switch to split (gate on the two-sided reference file flipping).
    await page.locator('#diff-options-btn').click();
    await page.locator('.diff-view-option[data-diff-view="split"]').click();
    await page.keyboard.press('Escape');
    await waitForDiffType(page, 'split', 5000, { fileName: REF_FILE });

    await setMinimize(page, true);

    // Card hidden, indicator floats over the line at zero row height.
    await expect(comment).toBeHidden();
    const indicator = page.locator(`${addedWrapper} [data-annotation-slot] .comment-indicator`).first();
    await expect(indicator).toBeVisible();
    const wrapperHeight = await page
      .locator(`${addedWrapper} [data-annotation-slot]:has(> .comment-indicator)`)
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(wrapperHeight).toBe(0);

    // The overlaid pill is clickable where it visually sits → card reappears.
    await indicator.click();
    await expect(comment).toBeVisible();
  });
});
