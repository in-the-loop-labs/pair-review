// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Rendered Markdown view
 *
 * Covers the user-facing flow for the first-class Rendered/Diff Markdown
 * view: per-file toggle, Outline sidebar navigation, block-level
 * commenting (both in-diff and honest-fallback/out-of-diff targets),
 * relative-link navigation to another changed Markdown file, and the
 * Diff-mode fallback remaining fully intact. Runs against BOTH PR mode
 * (test-owner/test-repo #1) and Local mode (/local/2), which share the
 * same seeded diff (see global-setup.js) — non-markdown files (src/*.js)
 * are asserted to have no Rendered/Diff toggle, guarding against
 * regression of the existing Diff-only behavior.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

async function toggleRendered(page, filePath) {
  const fileWrapper = page.locator(`.d2h-file-wrapper[data-file-name="${filePath}"]`);
  await fileWrapper.locator('.file-header-view-toggle-btn:has-text("Rendered")').click();
  await expect(fileWrapper).toHaveClass(/rendered-mode-active/);
  return fileWrapper;
}

/**
 * Resolve the numeric review id for either mode from its metadata endpoint,
 * so a test can hit the shared `/api/reviews/:id/comments` route directly.
 */
async function getReviewId(page, reviewApiBase) {
  return page.evaluate(async (base) => {
    const meta = await (await fetch(base)).json();
    return meta.data?.id ?? meta.metadata?.id ?? meta.review?.id ?? meta.id;
  }, reviewApiBase);
}

/**
 * The comment count a nested target's badge is currently showing, as a
 * number (0 when the badge is hidden). Tests assert badge counts RELATIVE to
 * this baseline: the seeded review lives in a per-worker in-memory database
 * that persists across every test in the worker, so an absolute `'1'` would
 * be order-dependent and would break outright under `--repeat-each`.
 */
function badgeCount(targetLocator) {
  return targetLocator.evaluate((el) => {
    const badge = el.querySelector('.rendered-markdown-target-badge');
    return badge && !badge.hidden ? Number(badge.textContent) || 0 : 0;
  });
}

/**
 * Delete the comments a test created, through the same API the UI uses, so
 * the shared per-worker review is left exactly as the test found it. Called
 * from a `finally` so it also runs when an assertion above it failed.
 */
async function deleteComments(page, reviewId, commentIds) {
  const ids = commentIds.filter((id) => id != null);
  if (ids.length === 0) return;
  await page.evaluate(async ({ id, targets }) => {
    for (const commentId of targets) {
      await fetch(`/api/reviews/${id}/comments/${commentId}`, { method: 'DELETE' });
    }
  }, { id: reviewId, targets: ids });
}

for (const { label, url, reviewApiBase } of [
  { label: 'PR mode', url: '/pr/test-owner/test-repo/1', reviewApiBase: '/api/pr/test-owner/test-repo/1' },
  { label: 'Local mode', url: '/local/2', reviewApiBase: '/api/local/2' }
]) {
  test.describe(`Rendered Markdown view — ${label}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(url);
      await waitForDiffToRender(page);
    });

    test('shows a Diff/Rendered toggle only on markdown files, not on ordinary source files', async ({ page }) => {
      await expect(page.locator('.d2h-file-wrapper[data-file-name="docs/guide.md"] .file-header-view-toggle')).toBeVisible();
      await expect(page.locator('.d2h-file-wrapper[data-file-name="src/utils.js"] .file-header-view-toggle')).toHaveCount(0);
    });

    test('toggling to Rendered shows headings/paragraphs and toggling back restores the original diff', async ({ page }) => {
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');

      await expect(fileWrapper.locator('.rendered-markdown-block h1')).toHaveText('Guide');
      await expect(fileWrapper.locator('.rendered-markdown-block h2')).toHaveText(['Usage', 'Notes']);
      await expect(
        fileWrapper.locator('.rendered-markdown-block-content', { hasText: 'This paragraph explains usage and was newly added by this PR.' })
      ).toBeVisible();

      // Diff mode is the always-available fallback: the removed line must
      // still be there, untouched, once we switch back.
      await fileWrapper.locator('.file-header-view-toggle-btn:has-text("Diff")').click();
      await expect(fileWrapper).not.toHaveClass(/rendered-mode-active/);
      const shadowText = await fileWrapper.evaluate((el) => {
        const host = el.querySelector('diffs-container');
        return host?.shadowRoot?.textContent || '';
      });
      expect(shadowText).toContain('This paragraph explains usage.');
    });

    test('Outline sidebar lists headings for the Rendered document, supports click-to-scroll, and shows an empty state otherwise', async ({ page }) => {
      await expect(page.locator('#outline-list')).toBeHidden();
      await expect(page.locator('#sidebar-tab-outline')).toBeVisible();
      await page.locator('#sidebar-tab-outline').click();
      await expect(page.locator('#outline-list')).toBeVisible();
      await expect(page.locator('#outline-list .outline-empty-state')).toBeVisible();

      await toggleRendered(page, 'docs/guide.md');
      const items = page.locator('#outline-list .outline-item');
      await expect(items).toHaveText(['Guide', 'Usage', 'Notes']);

      await items.filter({ hasText: 'Usage' }).click();
      await expect(items.filter({ hasText: 'Usage' })).toHaveAttribute('aria-current', 'true');

      const headingInView = await page.evaluate(() => {
        const heading = document.getElementById('md-heading-docs-guide-md--usage');
        const rect = heading.getBoundingClientRect();
        return rect.top >= 0 && rect.top <= window.innerHeight;
      });
      expect(headingInView).toBe(true);
    });

    test('adds an in-diff block comment (gets a diffPosition) and an out-of-diff block comment (honest fallback, no diffPosition), both persisting across reload', async ({ page }) => {
      const reviewId = await getReviewId(page, reviewApiBase);
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');
      // Baseline card count for the reload assertion below: the seeded
      // review is shared per worker and this test may be repeated.
      const cardsBefore = await fileWrapper.locator('.rendered-markdown-comment-card').count();

      // In-diff: the "Usage" paragraph is inside the seeded hunk.
      const usageBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'This paragraph explains usage and was newly added' });
      await usageBlock.hover();
      await usageBlock.locator('.rendered-markdown-add-comment-btn').click();
      await usageBlock.locator('.rendered-markdown-comment-textarea').fill('Great addition!');
      const inDiffResponse = page.waitForResponse(
        (r) => r.url().includes('/comments') && r.request().method() === 'POST'
      );
      await usageBlock.locator('.rendered-markdown-comment-btn.submit').click();
      const inDiffResult = await (await inDiffResponse).json();
      await expect(usageBlock.locator('.rendered-markdown-comment-card')).toContainText('Great addition!');

      // Out-of-diff (honest fallback): the "Notes" paragraph is far outside
      // every hunk. The context note must be shown, and the comment must
      // still save successfully without a diffPosition.
      const notesBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'unchanged context and sits far' });
      await notesBlock.hover();
      await notesBlock.locator('.rendered-markdown-add-comment-btn').click();
      await expect(notesBlock.locator('.rendered-markdown-context-note')).toBeVisible();
      await notesBlock.locator('.rendered-markdown-comment-textarea').fill('Just a note.');
      const outOfDiffResponse = page.waitForResponse(
        (r) => r.url().includes('/comments') && r.request().method() === 'POST'
      );
      await notesBlock.locator('.rendered-markdown-comment-btn.submit').click();
      const outOfDiffResult = await (await outOfDiffResponse).json();
      await expect(notesBlock.locator('.rendered-markdown-comment-card')).toContainText('Just a note.');

      // Verify the stored records directly: in-diff got a diffPosition,
      // the honest fallback did not — and neither was mis-attached to an
      // unrelated file/line.
      const comments = await page.evaluate(async (base) => {
        const metaResp = await fetch(base);
        const meta = await metaResp.json();
        const reviewId = meta.data?.id ?? meta.metadata?.id ?? meta.review?.id ?? meta.id;
        const res = await fetch(`/api/reviews/${reviewId}/comments`);
        return (await res.json()).comments;
      }, reviewApiBase);

      const inDiffComment = comments.find((c) => c.id === inDiffResult.commentId);
      const outOfDiffComment = comments.find((c) => c.id === outOfDiffResult.commentId);
      expect(inDiffComment).toMatchObject({ file: 'docs/guide.md', line_start: 7, line_end: 7 });
      expect(inDiffComment.diff_position).toBeTruthy();
      expect(outOfDiffComment).toMatchObject({ file: 'docs/guide.md', line_start: 11, line_end: 11 });
      expect(outOfDiffComment.diff_position == null).toBe(true);

      // Reload and confirm both comments re-appear in the Rendered view —
      // exactly two MORE cards than were there before this test ran.
      await page.reload();
      await waitForDiffToRender(page);
      const reloadedWrapper = await toggleRendered(page, 'docs/guide.md');
      await expect(reloadedWrapper.locator('.rendered-markdown-comment-card')).toHaveCount(cardsBefore + 2);
      await expect(reloadedWrapper).toContainText('Great addition!');
      await expect(reloadedWrapper).toContainText('Just a note.');

      // Self-cleaning, so the shared per-worker review is left as found.
      await deleteComments(page, reviewId, [inDiffResult.commentId, outOfDiffResult.commentId]);
    });

    test('an out-of-diff Rendered comment also reaches the Diff surface and is counted for submission', async ({ page }) => {
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');

      // Counts are asserted RELATIVE to the starting state: the seeded
      // review is shared across the tests in this file, so an absolute
      // count would be order-dependent.
      const countBefore = await page.evaluate(() => window.CommentCount.countDraftComments(document).total);

      // The last paragraph of the fixture sits far below the file's only
      // (single-line) hunk, so the diff engine has it collapsed — its diff
      // row does not exist yet. Assert that up front, so this test can only
      // pass by actually revealing it.
      const farBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'far-away paragraph is nowhere near' });
      const farLine = parseInt(await farBlock.getAttribute('data-start-line'), 10);
      expect(await page.evaluate(
        (line) => window.prManager.pierreBridge
          ? window.prManager.pierreBridge.isLineVisible('docs/guide.md', line, 'RIGHT')
          : !!document.querySelector(`.d2h-file-wrapper[data-file-name="docs/guide.md"] tr[data-new-line-number="${line}"]`),
        farLine
      )).toBe(false);

      await farBlock.hover();
      await farBlock.locator('.rendered-markdown-add-comment-btn').click();
      await farBlock.locator('.rendered-markdown-comment-textarea').fill('Out-of-diff feedback.');
      const response = page.waitForResponse(
        (r) => r.url().includes('/comments') && r.request().method() === 'POST'
      );
      await farBlock.locator('.rendered-markdown-comment-btn.submit').click();
      const { commentId } = await (await response).json();

      // The regression: the comment must be REACHABLE on the Diff surface
      // too. Its line was collapsed a moment ago, so this only holds if the
      // enclosing gap / context range was revealed before syncing.
      await expect(page.locator(`.user-comment-row[data-comment-id="${commentId}"]`)).toHaveCount(1);

      // Counted exactly ONCE more than before, even though the comment now
      // has a card on two surfaces. `CommentCount` is the shared counter
      // PRManager.updateCommentCount/submitReview and both ReviewModal call
      // sites delegate to, so asserting it here covers the toolbar count,
      // "N comments will be submitted" and the Request-changes validation
      // at their single source of truth.
      await expect(page.locator('#split-button-text')).toContainText(`(${countBefore + 1})`);
      await expect(page.locator('#split-button-main')).toHaveClass(/has-comments/);
      expect(await page.evaluate(() => window.CommentCount.countDraftComments(document).total))
        .toBe(countBefore + 1);

      // And it is actually visible once the reviewer toggles back to Diff.
      await fileWrapper.locator('.file-header-view-toggle-btn:has-text("Diff")').click();
      await expect(fileWrapper).not.toHaveClass(/rendered-mode-active/);
      await expect(fileWrapper.locator(`.user-comment-row[data-comment-id="${commentId}"]`)).toBeVisible();

      // Deleting it from the Rendered card removes it from BOTH surfaces
      // and the count returns to where it started — no stale +1 left behind
      // by counting before the card was actually removed.
      await fileWrapper.locator('.file-header-view-toggle-btn:has-text("Rendered")').click();
      await expect(fileWrapper).toHaveClass(/rendered-mode-active/);
      await fileWrapper
        .locator(`.rendered-markdown-comment-card[data-comment-id="${commentId}"] .rendered-markdown-comment-delete`)
        .click();
      await expect(page.locator(`.rendered-markdown-comment-card[data-comment-id="${commentId}"]`)).toHaveCount(0);
      await expect(page.locator(`.user-comment-row[data-comment-id="${commentId}"]`)).toHaveCount(0);
      expect(await page.evaluate(() => window.CommentCount.countDraftComments(document).total))
        .toBe(countBefore);
    });

    test('an existing comment on a blank separator line is shown at its true position with its real line number', async ({ page }) => {
      // guide.md new content line 8 is the blank line between the "Usage"
      // paragraph (line 7) and the "## Notes" heading (line 9) — trivially
      // easy to land on from the Diff view, and rendered by no block.
      const reviewId = await getReviewId(page, reviewApiBase);
      const created = await page.evaluate(async (id) => {
        const res = await fetch(`/api/reviews/${id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: 'docs/guide.md',
            line_start: 8,
            line_end: 8,
            side: 'RIGHT',
            diff_position: null,
            body: 'Comment on a blank separator line.'
          })
        });
        return res.json();
      }, reviewId);

      try {
        await page.reload();
        await waitForDiffToRender(page);
        const fileWrapper = await toggleRendered(page, 'docs/guide.md');

        const card = fileWrapper.locator(`.rendered-markdown-comment-card[data-comment-id="${created.commentId}"]`);
        await expect(card).toBeVisible();
        await expect(card).toContainText('Comment on a blank separator line.');
        // Honest repository line metadata...
        await expect(card.locator('.rendered-markdown-comment-lines')).toHaveText('Line 8');
        // ...in its own gap container at the true source position...
        await expect(fileWrapper.locator('.rendered-markdown-gap[data-start-line="8"]')).toBeVisible();
        // ...and NOT silently reattached to a neighbouring heading/paragraph.
        expect(await card.evaluate((el) => !!el.closest('.rendered-markdown-block'))).toBe(false);
        // Exactly one card for this comment across the whole page, so the
        // blank-line comment is not also duplicated onto a block.
        await expect(page.locator(`.rendered-markdown-comment-card[data-comment-id="${created.commentId}"]`))
          .toHaveCount(1);
      } finally {
        // API-created and never deleted through the UI, so this test owns
        // its cleanup: the seeded review lives in a per-worker database
        // shared with every other spec, and a leftover comment would shift
        // any sibling's baseline. Same `finally` contract as the
        // UI-driven tests above.
        await deleteComments(page, reviewId, [created.commentId]);
      }
    });

    test('gap containers are shown only when they actually hold a comment', async ({ page }) => {
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');
      // The rendered document is built asynchronously (file-contents fetch);
      // the orphan zone is created unconditionally by render(), so its
      // presence is the deterministic "document is built" signal. (Counting
      // it, rather than asserting visibility, because it is hidden while
      // empty — which is exactly what this test verifies.)
      await expect(fileWrapper.locator('.rendered-markdown-orphan-comments')).toHaveCount(1);
      // Property-based (and therefore order-independent): every gap /
      // orphan container is hidden exactly when it holds no comment card,
      // so an ordinary document is visually unchanged by the feature.
      const containers = await fileWrapper.evaluate((el) =>
        Array.from(el.querySelectorAll('.rendered-markdown-gap, .rendered-markdown-orphan-comments'))
          .map((c) => ({
            cls: c.className,
            hidden: c.hidden,
            cards: c.querySelectorAll('.rendered-markdown-comment-card').length
          }))
      );
      expect(containers.length).toBeGreaterThan(0);
      for (const c of containers) {
        expect(c.hidden, `${c.cls} with ${c.cards} card(s)`).toBe(c.cards === 0);
      }
    });

    /**
     * Hierarchical comment targets. The fixture's tail (see test-server.js)
     * is a two-level list followed by a two-column table whose body cells
     * share ONE source line — the case line numbers alone cannot express.
     */
    test('exposes container, list-item, nested-item, row and cell targets with accessible names', async ({ page }) => {
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');

      // Prefix-matched on purpose: the seeded review is shared across the
      // tests in this file, and a target that already carries a comment
      // appends its count to the button's accessible name.
      const ariaLabels = (locator) =>
        locator.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label').replace(/ \(\d+ comments?\)$/, '')));

      const listBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'Alpha item' });
      // The whole-list target is still there, alongside the per-item ones.
      await expect(listBlock.locator('.rendered-markdown-block-btn'))
        .toHaveAttribute('aria-label', /Add comment on the whole list/);
      expect(await ariaLabels(
        listBlock.locator('li > .rendered-markdown-target-affordance > .rendered-markdown-target-btn')
      )).toEqual([
        'Add comment on Nested list item, line 66',
        'Add comment on List item, lines 65–66',
        'Add comment on List item, line 67'
      ]);

      const tableBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'Column A' });
      await expect(tableBlock.locator('.rendered-markdown-block-btn'))
        .toHaveAttribute('aria-label', /Add comment on the whole table/);
      expect(await ariaLabels(tableBlock.locator('.rendered-markdown-row-gutter .rendered-markdown-target-btn')))
        .toEqual([
          'Add comment on Table row, line 69',
          'Add comment on Table row, line 71'
        ]);
      expect(await ariaLabels(tableBlock.locator('tbody td.rendered-markdown-target .rendered-markdown-target-btn')))
        .toEqual([
          'Add comment on Table cell, line 71, column 1',
          'Add comment on Table cell, line 71, column 2'
        ]);

      // Structural validity: nothing invalid was injected under the table,
      // its rows, or the lists.
      const structuralViolations = await tableBlock.evaluate((el) => {
        const bad = [];
        el.querySelectorAll('table').forEach((t) => {
          Array.from(t.children).forEach((c) => {
            if (!['THEAD', 'TBODY', 'TFOOT', 'CAPTION', 'COLGROUP'].includes(c.tagName)) bad.push(`table>${c.tagName}`);
          });
        });
        el.querySelectorAll('tr').forEach((r) => {
          Array.from(r.children).forEach((c) => {
            if (!['TH', 'TD'].includes(c.tagName)) bad.push(`tr>${c.tagName}`);
          });
        });
        el.querySelectorAll('ul,ol').forEach((l) => {
          Array.from(l.children).forEach((c) => {
            if (c.tagName !== 'LI') bad.push(`list>${c.tagName}`);
          });
        });
        return bad;
      });
      expect(structuralViolations).toEqual([]);

      // The row gutter is UI chrome, not a data column: it must be marked
      // presentational (otherwise every row announces one more column than
      // the header has), while its button stays a focusable, named button.
      const gutterA11y = await tableBlock.evaluate((el) =>
        Array.from(el.querySelectorAll('td.rendered-markdown-row-gutter')).map((td) => ({
          role: td.getAttribute('role'),
          ariaHidden: td.closest('[aria-hidden="true"]') !== null,
          btnTag: td.querySelector('.rendered-markdown-target-btn')?.tagName,
          btnTabIndex: td.querySelector('.rendered-markdown-target-btn')?.getAttribute('tabindex'),
          btnLabel: td.querySelector('.rendered-markdown-target-btn')?.getAttribute('aria-label')
        }))
      );
      expect(gutterA11y.length).toBe(2);
      for (const g of gutterA11y) {
        expect(g.role).toBe('presentation');
        expect(g.ariaHidden).toBe(false);
        expect(g.btnTag).toBe('BUTTON');
        expect(g.btnTabIndex).toBeNull();
        expect(g.btnLabel).toMatch(/^Add comment on Table row, line \d+/);
      }
      // Keyboard-focusable in the real browser, not just in principle.
      const firstGutterBtn = tableBlock.locator('.rendered-markdown-row-gutter .rendered-markdown-target-btn').first();
      await firstGutterBtn.focus();
      await expect(firstGutterBtn).toBeFocused();

      // Hovering a nested item reveals exactly one affordance — the
      // innermost target's — not the parent item's and not the list's.
      await fileWrapper.locator('li li', { hasText: 'Nested alpha item' }).hover();
      await expect(fileWrapper.locator('.is-target-active')).toHaveCount(1);
      await expect(fileWrapper.locator('.is-target-active')).toContainText('Nested alpha item');
    });

    test('two comments on two cells of one source line each return to their own cell after reload', async ({ page }) => {
      const reviewId = await getReviewId(page, reviewApiBase);
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');
      const tableBlock = fileWrapper.locator('.rendered-markdown-block', { hasText: 'Column A' });
      const cells = tableBlock.locator('tbody td.rendered-markdown-target');

      // Baselines, because the seeded review is shared per worker and this
      // test may itself be repeated (`--repeat-each`).
      const badgesBefore = [await badgeCount(cells.nth(0)), await badgeCount(cells.nth(1))];

      const commentIds = [];
      try {
        for (const [index, text] of [[0, 'About cell a1.'], [1, 'About cell b1.']]) {
          const cell = cells.nth(index);
          await cell.hover();
          await cell.locator('.rendered-markdown-target-btn').click();
          await expect(tableBlock.locator('.rendered-markdown-comment-form .rendered-markdown-comment-target'))
            .toHaveText(`Commenting on Table cell, line 71, column ${index + 1}`);
          await tableBlock.locator('.rendered-markdown-comment-textarea').fill(text);
          const response = page.waitForResponse(
            (r) => r.url().includes('/comments') && r.request().method() === 'POST'
          );
          await tableBlock.locator('.rendered-markdown-comment-btn.submit').click();
          commentIds.push((await (await response).json()).commentId);
        }

        // Both stored comments carry the SAME honest line-based GitHub
        // coordinates (the row's source line); only the local descriptor
        // tells the two cells apart.
        const stored = await page.evaluate(
          async (id) => (await (await fetch(`/api/reviews/${id}/comments`)).json()).comments,
          reviewId
        );
        const [first, second] = commentIds.map((id) => stored.find((c) => c.id === id));
        expect(first).toMatchObject({ file: 'docs/guide.md', line_start: 71, line_end: 71, side: 'RIGHT' });
        expect(second).toMatchObject({ file: 'docs/guide.md', line_start: 71, line_end: 71, side: 'RIGHT' });
        expect(JSON.parse(first.rendered_anchor)).toEqual({ v: 1, kind: 'table-cell', startLine: 71, endLine: 71, ordinal: 0 });
        expect(JSON.parse(second.rendered_anchor)).toEqual({ v: 1, kind: 'table-cell', startLine: 71, endLine: 71, ordinal: 1 });

        await page.reload();
        await waitForDiffToRender(page);
        const reloaded = await toggleRendered(page, 'docs/guide.md');
        const reloadedTable = reloaded.locator('.rendered-markdown-block', { hasText: 'Column A' });
        const reloadedCells = reloadedTable.locator('tbody td.rendered-markdown-target');

        // Each cell gained EXACTLY ONE comment of its own — relative to the
        // baseline above, so pre-existing state cannot change the meaning.
        await expect(reloadedCells.nth(0).locator('.rendered-markdown-target-badge'))
          .toHaveText(String(badgesBefore[0] + 1));
        await expect(reloadedCells.nth(1).locator('.rendered-markdown-target-badge'))
          .toHaveText(String(badgesBefore[1] + 1));
        // ...and each card names the cell it belongs to, with no stale
        // marker. Scoped by comment id, so only this test's cards matter.
        await expect(
          reloadedTable.locator(`.rendered-markdown-comment-card[data-comment-id="${commentIds[0]}"] .rendered-markdown-comment-target`)
        ).toHaveText('Table cell, line 71, column 1');
        await expect(
          reloadedTable.locator(`.rendered-markdown-comment-card[data-comment-id="${commentIds[1]}"] .rendered-markdown-comment-target`)
        ).toHaveText('Table cell, line 71, column 2');
        await expect(reloaded.locator('.rendered-markdown-comment-target.is-stale')).toHaveCount(0);
      } finally {
        // Self-cleaning: leave the shared per-worker review as we found it,
        // on the failure path too.
        await deleteComments(page, reviewId, commentIds);
      }
    });

    test('a nested list-item comment is created, counted once, editable and deletable across surfaces', async ({ page }) => {
      const reviewId = await getReviewId(page, reviewApiBase);
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');
      const countBefore = await page.evaluate(() => window.CommentCount.countDraftComments(document).total);

      const nestedItem = fileWrapper.locator('li li', { hasText: 'Nested alpha item' });
      const badgeBefore = await badgeCount(nestedItem);
      let commentId = null;
      try {
        await nestedItem.hover();
        await nestedItem.locator('.rendered-markdown-target-btn').click();
        await fileWrapper.locator('.rendered-markdown-comment-textarea').fill('Nested item feedback.');
        const response = page.waitForResponse(
          (r) => r.url().includes('/comments') && r.request().method() === 'POST'
        );
        await fileWrapper.locator('.rendered-markdown-comment-btn.submit').click();
        ({ commentId } = await (await response).json());

        const card = fileWrapper.locator(`.rendered-markdown-comment-card[data-comment-id="${commentId}"]`);
        await expect(card.locator('.rendered-markdown-comment-target')).toHaveText('Nested list item, line 66');
        // Relative to the baseline: the badge gained exactly this comment.
        await expect(nestedItem.locator('.rendered-markdown-target-badge'))
          .toHaveText(String(badgeBefore + 1));

        // Counted exactly once even though the comment also reaches the Diff
        // surface (its out-of-hunk target is revealed before syncing).
        await expect(page.locator(`.user-comment-row[data-comment-id="${commentId}"]`)).toHaveCount(1);
        expect(await page.evaluate(() => window.CommentCount.countDraftComments(document).total))
          .toBe(countBefore + 1);

        // Edit in place from the nested card, then delete: both surfaces and
        // the badge must follow.
        await card.locator('.rendered-markdown-comment-edit').click();
        await card.locator('.rendered-markdown-comment-body textarea').fill('Edited nested feedback.');
        await card.locator('.rendered-markdown-comment-body .submit').click();
        await expect(card.locator('.rendered-markdown-comment-body')).toContainText('Edited nested feedback.');
        await expect(page.locator(`.user-comment-row[data-comment-id="${commentId}"]`))
          .toContainText('Edited nested feedback.');

        await card.locator('.rendered-markdown-comment-delete').click();
        await expect(page.locator(`.rendered-markdown-comment-card[data-comment-id="${commentId}"]`)).toHaveCount(0);
        await expect(page.locator(`.user-comment-row[data-comment-id="${commentId}"]`)).toHaveCount(0);
        commentId = null; // deleted through the UI; nothing left to clean up
        // Back to the baseline — hidden only when it started at zero.
        if (badgeBefore === 0) {
          await expect(nestedItem.locator('.rendered-markdown-target-badge')).toBeHidden();
        } else {
          await expect(nestedItem.locator('.rendered-markdown-target-badge')).toHaveText(String(badgeBefore));
        }
        expect(await page.evaluate(() => window.CommentCount.countDraftComments(document).total))
          .toBe(countBefore);
      } finally {
        // Only reached if an assertion failed before the UI delete above.
        await deleteComments(page, reviewId, [commentId]);
      }
    });

    test('a comment with no nested descriptor stays on its top-level block, never on a cell', async ({ page }) => {
      const reviewId = await getReviewId(page, reviewApiBase);
      const created = await page.evaluate(async (id) => {
        const res = await fetch(`/api/reviews/${id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: 'docs/guide.md',
            line_start: 71,
            line_end: 71,
            side: 'RIGHT',
            body: 'Legacy comment on the table row line.'
          })
        });
        return res.json();
      }, reviewId);

      try {
        await page.reload();
        await waitForDiffToRender(page);
        const fileWrapper = await toggleRendered(page, 'docs/guide.md');

        const card = fileWrapper.locator(`.rendered-markdown-comment-card[data-comment-id="${created.commentId}"]`);
        await expect(card).toBeVisible();
        // Shown on the table BLOCK, with no target claim of any kind.
        await expect(card.locator('.rendered-markdown-comment-target')).toHaveCount(0);
        expect(await card.evaluate((el) => el.closest('.rendered-markdown-block')?.dataset.startLine)).toBe('69');

        // No nested target gained a comment because of it. Asserted as a
        // PROPERTY rather than an absolute count, because the seeded review is
        // shared across the tests in this file: every visible badge must be
        // backed by exactly that many target-anchored cards, and this
        // descriptor-less comment is not one of them.
        const badgesMatchCards = await fileWrapper.evaluate((el) => {
          const cardsByKey = new Map();
          el.querySelectorAll('.rendered-markdown-comment-card[data-rendered-target-key]').forEach((c) => {
            const key = c.dataset.renderedTargetKey;
            cardsByKey.set(key, (cardsByKey.get(key) || 0) + 1);
          });
          const badgeTotal = Array.from(el.querySelectorAll('.rendered-markdown-target-badge'))
            .filter((b) => !b.hidden)
            .reduce((sum, b) => sum + Number(b.textContent), 0);
          const cardTotal = Array.from(cardsByKey.values()).reduce((a, b) => a + b, 0);
          return { badgeTotal, cardTotal };
        });
        expect(badgesMatchCards.badgeTotal).toBe(badgesMatchCards.cardTotal);
      } finally {
        // API-created and never deleted through the UI — see the identical
        // cleanup on the blank-separator-line test above. Leaving this
        // legacy row-line comment behind would add a permanent card (and a
        // baseline shift) to the shared per-worker review.
        await deleteComments(page, reviewId, [created.commentId]);
      }
    });

    test('a relative link to another changed markdown file navigates there in Rendered mode; the external link stays a normal link', async ({ page }) => {
      const fileWrapper = await toggleRendered(page, 'docs/guide.md');

      const externalLink = fileWrapper.locator('a:has-text("GitHub")');
      await expect(externalLink).toHaveAttribute('href', 'https://github.com');
      await expect(externalLink).not.toHaveClass(/rendered-markdown-internal-link/);

      const setupLink = fileWrapper.locator('a:has-text("Setup")');
      await expect(setupLink).toHaveClass(/rendered-markdown-internal-link/);
      await setupLink.click();

      const setupWrapper = page.locator('.d2h-file-wrapper[data-file-name="docs/setup.md"]');
      await expect(setupWrapper).toHaveClass(/rendered-mode-active/);
      await expect(
        setupWrapper.locator('.rendered-markdown-block-content', { hasText: 'Follow these steps to set up the project.' })
      ).toBeVisible();
    });
  });
}
