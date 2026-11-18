// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: changes made while their file is far away (N11 of plans/codeview-virtualized-diff.md)
 *
 * Every scenario has the same shape: something about a file changes while
 * that file is scrolled several viewports away, and the reader then comes
 * back to it. On a virtualized viewer the file is not in the DOM while it is
 * away, so anything that was only written to its cards is lost and anything
 * that reads its cards sees nothing. On the current engine the file stays in
 * the DOM; these scenarios pass there and state what must keep holding.
 *
 * The corpus is three files: the target at the top, a 4,000-line file, and a
 * tail file at the bottom (about 70,000 px from the target).
 *
 * "While away" changes go through what the application itself calls: the
 * comments API followed by the comment reload every change triggers, the
 * functions behind the card buttons, the AI panel's quick actions, the
 * navigator keys, Clear All, the review and preview dialogs, the comment
 * filter, the review history, and the DOM events the page gets for a server
 * push (E2E has no WebSocket).
 *
 * The second half is everything else that is drawn on a far file: hunk
 * summaries, tour stops and, in PR mode, external review threads.
 */

import { test, expect } from './fixtures.js';
import {
  MODES, waitForDiffToRender, seedComment, seedSuggestions, reloadComments, cleanupAllComments, expectResponse,
  setMinimize, mockAppConfig, mockHunkSummaries, pushHunkSummaries, mockTour, mockExternalComments, externalThread
} from './helpers.js';
import { allCorpora, changedLines, customCorpus, hunkHashes, routeDiff } from './fixtures/diffs.js';
import {
  fileWrapper, inlineComment, inlineSuggestion, lineCards, fileSelector, inAnnotationGroup, scrollFileIntoView, scrollFileOutOfView,
  waitForFileRendered, waitForFileSettled, isLineVisible, revealOffHunkLine, lineNumberCell, assertNoOrphanHosts, expectLineCardsInPane,
  openLineCommentForm, hasRenderedBody, waitForDiffSettled, scrollDiffToEdge, scrollState
} from './diff-dom.js';

const { eviction: EVICTION, edge: EDGE } = allCorpora();
const { target: TARGET, tail: TAIL } = EVICTION.roles;
const TARGET_LINES = changedLines(EVICTION, TARGET);
const TAIL_LINES = changedLines(EVICTION, TAIL);
// Lines that are on screen without any expansion: added lines of two hunks.
const LINE_A = TARGET_LINES.additions[0];
const LINE_B = TARGET_LINES.additions[1];
const TAIL_LINE = TAIL_LINES.additions[0];
// The hash each hunk's summary is keyed by, per file, in hunk order.
const HASHES = hunkHashes(EVICTION.diff);
// A line hidden between the first two hunks of the target.
const HIDDEN_LINE = Math.floor((TARGET_LINES.hunks[0].newStart + TARGET_LINES.hunks[0].newCount + TARGET_LINES.hunks[1].newStart) / 2);

/**
 * A small changed file and an added file of 12,000 lines. The virtualized
 * viewer draws a file of 5,000 rows or more in windows of its rows (5,000
 * at the top of the file, at most two such blocks elsewhere; pinned on the
 * real viewer in tests/contract/bridge/annotations.spec.js). With the
 * reader at the top of the long file a card on line 11,000 belongs to a
 * file that is mounted and to a row that is not drawn; with the reader on
 * line 11,200 the same holds for the file's comment zone and for a card on
 * line 40. (The 4,000-line file of the eviction corpus is drawn whole.)
 */
const LONG = (() => {
  const small = 'aa/small.js';
  const long = 'long/added.js';
  const before = Array.from({ length: 40 }, (_, i) => `const v${i + 1} = ${i + 1};`);
  const after = before.slice();
  after[9] = 'const v10 = 100;';
  const context = (from, to) => before.slice(from, to).map((line) => ` ${line}`).join('\n');
  const smallHunk = `@@ -7,7 +7,7 @@\n${context(6, 9)}\n-${before[9]}\n+${after[9]}\n${context(10, 13)}\n`;
  const lines = Array.from({ length: 12000 }, (_, i) => `export const row${i + 1} = compute(${i + 1}); // line ${i + 1}`);
  const diff = `diff --git a/${small} b/${small}\nindex 1111111..2222222 100644\n--- a/${small}\n+++ b/${small}\n${smallHunk}`
    + `diff --git a/${long} b/${long}\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/${long}\n@@ -0,0 +1,${lines.length} @@\n`
    + `${lines.map((line) => `+${line}`).join('\n')}\n`;
  const corpus = customCorpus({ name: 'long-file-row-window', diff, files: {
    [small]: { old: `${before.join('\n')}\n`, new: `${after.join('\n')}\n` },
    [long]: { old: null, new: `${lines.join('\n')}\n` },
  } });
  return { corpus, small, long, nearLine: 10, topLine: 40, farLine: 11000, fartherLine: 11200 };
})();

/**
 * The same shape with an added file of 5,006 lines as the last file: six rows
 * more than one block of the rows the viewer draws (the bridge's
 * ROWS_PER_ITEM_WINDOW), ending the pane. The viewer alone never draws those
 * six rows (vendor fact F30, tests/contract/vendor/row-window.spec.js).
 */
const LONG_TAIL = (() => {
  const small = 'aa/small.js';
  const long = 'long/tail.js';
  const before = Array.from({ length: 40 }, (_, i) => `const v${i + 1} = ${i + 1};`);
  const after = before.slice();
  after[9] = 'const v10 = 100;';
  const context = (from, to) => before.slice(from, to).map((line) => ` ${line}`).join('\n');
  const smallHunk = `@@ -7,7 +7,7 @@\n${context(6, 9)}\n-${before[9]}\n+${after[9]}\n${context(10, 13)}\n`;
  const lines = Array.from({ length: 5006 }, (_, i) => `export const row${i + 1} = compute(${i + 1}); // line ${i + 1}`);
  const diff = `diff --git a/${small} b/${small}\nindex 1111111..2222222 100644\n--- a/${small}\n+++ b/${small}\n${smallHunk}`
    + `diff --git a/${long} b/${long}\nnew file mode 100644\nindex 0000000..4444444\n--- /dev/null\n+++ b/${long}\n@@ -0,0 +1,${lines.length} @@\n`
    + `${lines.map((line) => `+${line}`).join('\n')}\n`;
  const corpus = customCorpus({ name: 'long-file-short-tail', diff, files: {
    [small]: { old: `${before.join('\n')}\n`, new: `${after.join('\n')}\n` },
    [long]: { old: null, new: `${lines.join('\n')}\n` },
  } });
  return { corpus, small, long, lastLine: 5006, tailLine: 5004, blockEnd: 5000 };
})();

const api = (page, method, url, body) => page.evaluate(async (r) => {
  const response = await fetch(r.url, {
    method: r.method,
    headers: { 'Content-Type': 'application/json' },
    body: r.body === undefined ? undefined : JSON.stringify(r.body)
  });
  if (!response.ok) throw new Error(`${r.method} ${r.url}: ${response.status} ${await response.text()}`);
  return response.json();
}, { method, url, body });

const userSegment = (page) => page.locator('.segment-btn').filter({ hasText: 'User' });

/**
 * The number of pending user comments as the page reports it, from data, not
 * from the cards in the DOM: the count on the review panel's User segment and
 * the "has comments" state of the review button.
 */
async function expectPendingCount(page, count) {
  await expect(userSegment(page).locator('.segment-count')).toHaveText(new RegExp(`^\\(?${count}\\)?$`));
  const button = page.locator('#split-button-main');
  if (count > 0) await expect(button).toHaveClass(/has-comments/);
  else await expect(button).not.toHaveClass(/has-comments/);
}

for (const mode of MODES) {
  test.describe(`Changes while the file is far away (${mode.name})`, () => {
    const commentsUrl = `/api/reviews/${mode.reviewId}/comments`;

    test.beforeEach(async ({ page }) => {
      await routeDiff(page, EVICTION);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await cleanupAllComments(page, mode.reviewId);
      // The page loaded before the cleanup: drop what it drew of anything a
      // test that ran earlier in this worker left behind.
      await page.evaluate(() => Promise.all([window.prManager.loadUserComments(), window.prManager.loadAISuggestions()]));
      await page.evaluate(() => window.aiPanel?.expand());
      await waitForFileRendered(page, TARGET);
      await waitForFileSettled(page, TARGET);
    });

    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    /** Scroll until the target is several viewports away. */
    const leave = (page) => scrollFileOutOfView(page, TARGET);
    /** Come back to the target and wait until it shows its rows. */
    async function comeBack(page) {
      await scrollFileIntoView(page, TARGET);
      await waitForFileRendered(page, TARGET);
    }
    const targetComments = (page) => lineCards(page, '.user-comment-row', fileSelector(TARGET));

    test('comments saved while away are on their lines on return, and counted meanwhile', async ({ page }) => {
      await leave(page);
      const first = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_A, body: 'Saved while away, first' });
      const second = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_B, body: 'Saved while away, second' });
      await reloadComments(page);

      // Counted from data while the file is away.
      await expectPendingCount(page, 2);

      await comeBack(page);
      await expect(inlineComment(page, first)).toBeVisible();
      await expect(inlineComment(page, first)).toContainText('Saved while away, first');
      await expect(inlineComment(page, first)).toHaveAttribute('data-line-start', String(LINE_A));
      await expect(inlineComment(page, second)).toBeAttached();
      await expect(inlineComment(page, second)).toHaveAttribute('data-line-start', String(LINE_B));
      await expect(targetComments(page)).toHaveCount(2);
      await assertNoOrphanHosts(page);
    });

    test('an edit made while away is what the card says on return', async ({ page }) => {
      const id = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_A, body: 'Before the edit' });
      await reloadComments(page);
      await expect(inlineComment(page, id)).toContainText('Before the edit');

      await leave(page);
      await api(page, 'PUT', `${commentsUrl}/${id}`, { body: 'After the edit' });
      await reloadComments(page);

      await comeBack(page);
      await expect(inlineComment(page, id)).toContainText('After the edit');
      await expect(fileWrapper(page, TARGET)).not.toContainText('Before the edit');
      await expect(targetComments(page)).toHaveCount(1);
    });

    test('a comment deleted while away does not come back, and a restored one does', async ({ page }) => {
      const kept = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_A, body: 'Stays' });
      const gone = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_B, body: 'Deleted while away' });
      await reloadComments(page);
      await expect(inlineComment(page, kept)).toBeVisible();
      await expect(inlineComment(page, gone)).toBeAttached();

      await leave(page);
      // What the card's delete button calls.
      const deleted = expectResponse(page, (r) => r.url().includes(`/comments/${gone}`) && r.request().method() === 'DELETE');
      await page.evaluate((id) => window.prManager.deleteUserComment(id), gone);
      await deleted;
      await expectPendingCount(page, 1);

      await comeBack(page);
      await expect(inlineComment(page, kept)).toBeVisible();
      await expect(inlineComment(page, gone)).toHaveCount(0);
      await expect(targetComments(page)).toHaveCount(1);

      // Away again: restore it (what the review panel's restore button calls).
      await leave(page);
      const restored = expectResponse(page, (r) => r.url().includes(`/comments/${gone}/restore`));
      await page.evaluate((id) => window.prManager.restoreUserComment(id), gone);
      await restored;
      await expectPendingCount(page, 2);

      await comeBack(page);
      await expect(inlineComment(page, gone)).toBeAttached();
      await expect(inlineComment(page, gone)).toContainText('Deleted while away');
      await expect(targetComments(page)).toHaveCount(2);
    });

    test('Clear All while away clears the far file too', async ({ page }) => {
      const far = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_A, body: 'Far comment' });
      const farFileLevel = await seedComment(page, mode.reviewId, { file: TARGET, body: 'Far file-level comment', fileLevel: true });
      const near = await seedComment(page, mode.reviewId, { file: TAIL, line: TAIL_LINE, body: 'Near comment' });
      await reloadComments(page);
      await expect(inlineComment(page, far)).toBeVisible();
      await expect(fileWrapper(page, TARGET).locator('.file-comment-card')).toHaveCount(1);

      await leave(page);
      await expectPendingCount(page, 3);
      await page.locator('#split-button-dropdown-toggle').click();
      await page.locator('#split-button-dropdown [data-action="clear"]').click();
      const cleared = expectResponse(page, (r) => r.url().includes('/comments') && r.request().method() === 'DELETE');
      await page.locator('#confirm-dialog-btn').click();
      await cleared;
      await expectPendingCount(page, 0);
      await expect(inlineComment(page, near)).toHaveCount(0);

      await comeBack(page);
      await expect(inlineComment(page, far)).toHaveCount(0);
      await expect(targetComments(page)).toHaveCount(0);
      await expect(fileWrapper(page, TARGET).locator('.file-comment-card')).toHaveCount(0);
      await expect(fileWrapper(page, TARGET).locator('.file-header-comment-btn')).not.toHaveClass(/has-comments/);
      void farFileLevel;
    });

    test('a file-level comment saved while away is in the file\'s comment zone on return, and its header shows it', async ({ page }) => {
      await leave(page);
      await seedComment(page, mode.reviewId, { file: TARGET, body: 'File-level, saved while away', fileLevel: true });
      await reloadComments(page);

      await comeBack(page);
      const wrapper = fileWrapper(page, TARGET);
      await expect(wrapper.locator('.file-comment-card')).toHaveCount(1);
      await expect(wrapper.locator('.file-comment-card')).toContainText('File-level, saved while away');
      await expect(wrapper.locator('.file-header-comment-btn')).toHaveClass(/has-comments/);
      // Leaving and returning again changes nothing (no duplicate card).
      await leave(page);
      await comeBack(page);
      await expect(wrapper.locator('.file-comment-card')).toHaveCount(1);
      await expect(wrapper.locator('.file-header-comment-btn')).toHaveClass(/has-comments/);
    });

    test('adopting a suggestion from the review panel while away leaves an adopted comment on return', async ({ page }) => {
      const [id] = await seedSuggestions(page, mode.reviewId, [
        { file: TARGET, line_start: LINE_A, title: 'Adopt me from afar', body: 'Suggestion body to adopt' }
      ]);
      await expect(inlineSuggestion(page, id)).toBeVisible();
      await page.evaluate(() => window.aiPanel?.expand());
      await leave(page);

      const wrapper = page.locator(`.finding-item-wrapper:has(.finding-item[data-id="${id}"])`);
      await wrapper.hover();
      await wrapper.locator('.quick-action-adopt').click();
      await expect(page.locator(`.finding-item[data-id="${id}"]`)).toHaveClass(/finding-adopted/);
      await expectPendingCount(page, 1);
      await expect(page.locator('.toast-error')).toHaveCount(0);

      // The quick action may have brought the file back into view; either way, look at it.
      await comeBack(page);
      const adopted = fileWrapper(page, TARGET).locator('.user-comment-row', { hasText: 'Suggestion body to adopt' });
      await expect(adopted).toBeVisible();
      await expect(targetComments(page)).toHaveCount(1);
      const { comments } = await api(page, 'GET', commentsUrl);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ file: TARGET, line_start: LINE_A, parent_id: id });

      // Leave and return once more: still exactly one adopted comment.
      await leave(page);
      await comeBack(page);
      await expect(targetComments(page)).toHaveCount(1);
    });

    test('dismissing and restoring a suggestion from the review panel while away is what its card shows on return', async ({ page }) => {
      const [id] = await seedSuggestions(page, mode.reviewId, [
        { file: TARGET, line_start: LINE_A, title: 'Dismiss me from afar', body: 'Suggestion body to dismiss' }
      ]);
      const card = inlineSuggestion(page, id);
      await expect(card).toBeVisible();
      await expect(card).not.toHaveClass(/collapsed/);
      await page.evaluate(() => window.aiPanel?.expand());
      const wrapper = page.locator(`.finding-item-wrapper:has(.finding-item[data-id="${id}"])`);
      const item = page.locator(`.finding-item[data-id="${id}"]`);

      await leave(page);
      await wrapper.hover();
      await wrapper.locator('.quick-action-dismiss').click();
      await expect(item).toHaveClass(/finding-dismissed/);
      await comeBack(page);
      await expect(card).toBeAttached();
      await expect(card).toHaveClass(/collapsed/);

      await leave(page);
      await wrapper.hover();
      await wrapper.locator('.quick-action-restore').click();
      await expect(item).toHaveClass(/finding-active/);
      await comeBack(page);
      await expect(card).toBeVisible();
      await expect(card).not.toHaveClass(/collapsed/);
      await expect(card.locator('.ai-action-adopt')).toBeVisible();
      await expect(page.locator('.toast-error')).toHaveCount(0);
    });

    test('a click on a far comment in the review panel brings its card into view', async ({ page }) => {
      const id = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_B, body: 'Find me from the panel' });
      await reloadComments(page);
      await page.evaluate(() => window.aiPanel?.expand());
      await userSegment(page).click();
      const item = page.locator(`.finding-item.finding-comment[data-id="${id}"]`);
      await expect(item).toBeVisible();

      await leave(page);
      await item.click();
      await expect(inlineComment(page, id)).toBeInViewport();
      await expect(page.locator('.toast-error')).toHaveCount(0);
    });

    test('the navigator keys walk suggestions in files far apart, each card coming into view', async ({ page }) => {
      const [first, second] = await seedSuggestions(page, mode.reviewId, [
        { file: TARGET, line_start: LINE_A, title: 'First stop', body: 'First stop body' },
        { file: TAIL, line_start: TAIL_LINE, title: 'Second stop', body: 'Second stop body' }
      ]);
      await expect(inlineSuggestion(page, first)).toBeVisible();
      // Both stops are in the navigator's list (the second one's card is not
      // drawn yet: its file has never been near the viewport).
      await expect(page.locator(`.finding-item[data-id="${first}"]`)).toBeVisible();
      await expect(page.locator(`.finding-item[data-id="${second}"]`)).toBeVisible();
      // The keys are pressed from the diff side of the page, as a reader
      // would: a click on the toolbar pinned above the diff. Not a click on
      // a point of the diff container, which is tens of thousands of pixels
      // tall here: a click that has to be retried scrolls its target into
      // view first, and every alignment of that container puts the point off
      // screen or under the pinned toolbar.
      await page.locator('.diff-toolbar').click({ position: { x: 5, y: 5 } });

      await page.keyboard.press('j');
      await expect(inlineSuggestion(page, first)).toBeInViewport();
      await page.keyboard.press('j');
      await expect(inlineSuggestion(page, second)).toBeInViewport();
      await page.keyboard.press('k');
      await expect(inlineSuggestion(page, first)).toBeInViewport();
      // Never the "could not reveal" toast.
      await expect(page.locator('.toast-error, .toast-warning')).toHaveCount(0);
    });

    test('a comment on a hidden line saved while away is shown with its line revealed on return', async ({ page }) => {
      expect(await isLineVisible(page, TARGET, HIDDEN_LINE)).toBe(false);
      await leave(page);
      const id = await seedComment(page, mode.reviewId, { file: TARGET, line: HIDDEN_LINE, body: 'On a hidden line' });
      await reloadComments(page);

      await comeBack(page);
      await expect.poll(() => isLineVisible(page, TARGET, HIDDEN_LINE)).toBe(true);
      await expect(inlineComment(page, id)).toBeAttached();
      await inlineComment(page, id).scrollIntoViewIfNeeded();
      await expect(inlineComment(page, id)).toBeVisible();
      await expect(lineNumberCell(fileWrapper(page, TARGET), HIDDEN_LINE, { side: 'additions' }).first()).toBeAttached();
    });

    test('with comments minimized, a far file shows its line indicator on return and the card opens from it', async ({ page }) => {
      const id = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_A, body: 'Minimized and far away' });
      await reloadComments(page);
      await expect(inlineComment(page, id)).toBeVisible();
      await setMinimize(page, true);
      const indicator = page.locator(inAnnotationGroup('.comment-indicator', fileSelector(TARGET)));
      await expect(indicator).toHaveCount(1);
      await expect(inlineComment(page, id)).toBeHidden();

      await leave(page);
      await comeBack(page);
      await expect(indicator).toHaveCount(1);
      await expect(inlineComment(page, id)).toBeHidden();
      await indicator.click();
      await expect(inlineComment(page, id)).toBeVisible();
      await setMinimize(page, false);
    });

    test('deleting a comment and then revealing lines in the same file does not bring the comment back', async ({ page }) => {
      const gone = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_A, body: 'Deleted before a reveal' });
      await reloadComments(page);
      await expect(inlineComment(page, gone)).toBeVisible();

      const deleted = expectResponse(page, (r) => r.url().includes(`/comments/${gone}`) && r.request().method() === 'DELETE');
      await inlineComment(page, gone).locator('.btn-delete-comment').click();
      await deleted;
      await expect(inlineComment(page, gone)).toHaveCount(0);

      await expectPendingCount(page, 0);

      // Revealing hidden lines replaces the file's diff and re-creates every row and card of it.
      await revealOffHunkLine(page, TARGET, HIDDEN_LINE);
      await expect.poll(() => isLineVisible(page, TARGET, HIDDEN_LINE)).toBe(true);
      await expect(lineNumberCell(fileWrapper(page, TARGET), HIDDEN_LINE, { side: 'additions' }).first()).toBeAttached();

      await expect(inlineComment(page, gone)).toHaveCount(0);

      // Nor after going away and coming back.
      await leave(page);
      await comeBack(page);
      await expect(inlineComment(page, gone)).toHaveCount(0);
      await expect(targetComments(page)).toHaveCount(0);
    });

    test('an adopted suggestion shown again stays open when its adopting comment is deleted, also after its file is re-rendered', async ({ page }) => {
      const [id] = await seedSuggestions(page, mode.reviewId, [
        { file: TARGET, line_start: LINE_A, title: 'Adopt, show again, then delete', body: 'Suggestion body the reader keeps open' }
      ]);
      const card = inlineSuggestion(page, id);
      const restoreLabel = card.locator('.btn-restore .btn-text');
      await expect(card).toBeVisible();

      await card.locator('.ai-action-adopt').click();
      const adopted = fileWrapper(page, TARGET).locator('.user-comment-row', { hasText: 'Suggestion body the reader keeps open' });
      await expect(adopted).toBeVisible();
      await expect(card).toHaveClass(/collapsed/);
      await expect(restoreLabel).toHaveText('Show');
      await expectPendingCount(page, 1);

      // "Show": the reader opens the adopted suggestion again.
      await card.locator('.btn-restore').click();
      await expect(card).not.toHaveClass(/collapsed/);
      await expect(restoreLabel).toHaveText('Hide');
      await expect(card.locator('.ai-suggestion-body')).toBeVisible();

      // Deleting the adopting comment dismisses the suggestion in the data
      // and in the review panel. The card the reader opened is left open.
      const commentId = await adopted.getAttribute('data-comment-id');
      const deleted = expectResponse(page, (r) => r.url().includes(`/comments/${commentId}`) && r.request().method() === 'DELETE');
      await adopted.locator('.btn-delete-comment').click();
      await deleted;
      await expect(targetComments(page)).toHaveCount(0);
      await expectPendingCount(page, 0);
      await expect(page.locator(`.finding-item[data-id="${id}"]`)).toHaveClass(/finding-dismissed/);
      const expectLeftOpen = async () => {
        await expect(card).toHaveCount(1);
        await expect(card).not.toHaveClass(/collapsed/);
        await expect(restoreLabel).toHaveText('Hide');
        await expect(card.locator('.ai-suggestion-body')).toBeVisible();
        await expect(card).not.toHaveAttribute('data-hidden-for-adoption', /.*/);
      };
      await expectLeftOpen();

      // Revealing hidden lines replaces the file's diff and draws every card of it again.
      await revealOffHunkLine(page, TARGET, HIDDEN_LINE);
      await expect.poll(() => isLineVisible(page, TARGET, HIDDEN_LINE)).toBe(true);
      await expect(lineNumberCell(fileWrapper(page, TARGET), HIDDEN_LINE, { side: 'additions' }).first()).toBeAttached();
      await expectLeftOpen();
      await expect(targetComments(page)).toHaveCount(0);
      await expectLeftOpen();

      // Going away and coming back draws it once more.
      await leave(page);
      await comeBack(page);
      await expectLeftOpen();
      await expect(page.locator('.toast-error')).toHaveCount(0);
    });

    test('a comment saved while a comment reload is in flight is kept, and nothing is drawn twice', async ({ page }) => {
      const existing = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_A, body: 'There before the reload' });
      await reloadComments(page);
      await expect(inlineComment(page, existing)).toBeVisible();

      await openLineCommentForm(page, { file: TARGET, line: LINE_B });
      const form = page.locator('.user-comment-form');
      await form.locator('textarea').fill('Saved during the reload');

      // A reload (what a push from another tab starts) whose answer, taken
      // before the save, is delivered after it.
      let releaseReload;
      const reloadGate = new Promise((resolve) => { releaseReload = resolve; });
      let held = 0;
      await page.route(/\/api\/reviews\/\d+\/comments(\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET' || held > 0) return route.fallback();
        held++;
        const response = await route.fetch();
        await reloadGate;
        await route.fulfill({ response });
      });
      await page.evaluate(() => { window.__heldReload = window.prManager.loadUserComments(); });
      await expect.poll(() => held).toBe(1);

      const saved = expectResponse(page, (r) => /\/comments$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
      await form.locator('.save-comment-btn').click();
      const savedId = (await (await saved).json()).commentId;
      await expect(inlineComment(page, savedId)).toBeVisible();

      // The stale answer arrives now. It does not know the new comment.
      releaseReload();
      await page.evaluate(() => window.__heldReload);
      await expect(inlineComment(page, savedId)).toHaveCount(1);
      await expect(inlineComment(page, savedId)).toContainText('Saved during the reload');
      await expect(inlineComment(page, existing)).toHaveCount(1);
      await expect(targetComments(page)).toHaveCount(2);
      await expect(page.locator('.user-comment-form')).toHaveCount(0);
      await expectPendingCount(page, 2);

      // And after going away and coming back.
      await leave(page);
      await comeBack(page);
      await expect(targetComments(page)).toHaveCount(2);
      await expect(inlineComment(page, savedId)).toHaveAttribute('data-line-start', String(LINE_B));
    });

    if (!mode.local) {
      test('requesting changes from far away is refused with nothing to submit and accepted with a comment on the far file, which is posted on return', async ({ page }) => {
        await leave(page);
        const modal = page.locator('#review-modal');

        // Nothing to submit: the dialog says so and stays open.
        await page.locator('#split-button-main').click();
        await expect(modal).toBeVisible();
        await expect(modal.locator('.review-comment-count')).toBeHidden();
        await modal.locator('input[value="REQUEST_CHANGES"]').click();
        await modal.locator('#submit-review-btn-modal').click();
        await expect(modal.locator('#review-error-message')).toBeVisible();
        await expect(modal.locator('#review-error-message')).toContainText('Please add comments or a review summary');
        await modal.locator('#cancel-review-btn').click();
        await expect(modal).toBeHidden();

        // One comment on the far file, saved while away: counted from data.
        const id = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_A, body: 'Submitted from far away' });
        await reloadComments(page);
        await expectPendingCount(page, 1);
        await page.locator('#split-button-main').click();
        await expect(modal).toBeVisible();
        await expect(modal.locator('.review-comment-count')).toContainText('1 comment will be submitted with this review');
        await modal.locator('input[value="REQUEST_CHANGES"]').click();
        const submitted = expectResponse(page, (r) => r.url().includes('/submit-review') && r.request().method() === 'POST');
        await modal.locator('#submit-review-btn-modal').click();
        expect((await submitted).ok()).toBe(true);
        await expect(page.locator('.toast-success')).toContainText(/review submitted/i);
        await expect(modal).toBeHidden();
        // Posted, so no longer pending: nothing left to submit. The panel still lists it.
        await expect(page.locator('#split-button-main')).not.toHaveClass(/has-comments/);
        await expect(userSegment(page).locator('.segment-count')).toHaveText(/^\(?1\)?$/);

        // On return the card is there once and says it was posted.
        await comeBack(page);
        const card = inlineComment(page, id);
        await expect(card).toHaveCount(1);
        await expect(card).toBeVisible();
        await expect(card.locator('a.posted-comment-icon')).toHaveAttribute('title', 'Posted comment');
        await expect(targetComments(page)).toHaveCount(1);
      });

      test('hiding and showing posted comments while away is what the far file shows on return', async ({ page }) => {
        const id = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_A, body: 'Posted, then filtered' });
        const pending = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_B, body: 'Still pending' });
        // Post the first comment only: the second is saved after the review.
        await page.evaluate((cid) => window.prManager.deleteUserComment(cid), pending);
        const review = await page.request.post('/api/pr/test-owner/test-repo/1/submit-review', { data: { event: 'COMMENT', body: 'Review body' } });
        expect(review.ok()).toBe(true);
        await page.evaluate((cid) => window.prManager.restoreUserComment(cid), pending);
        await reloadComments(page);
        const card = inlineComment(page, id);
        await expect(card.locator('a.posted-comment-icon')).toBeVisible();
        await expect(inlineComment(page, pending)).toBeAttached();
        // One posted and one pending: the panel lists both, one is left to submit.
        await expect(userSegment(page).locator('.segment-count')).toHaveText(/^\(?2\)?$/);
        expect(await page.evaluate(() => window.prManager.getPendingCommentCount())).toBe(1);

        await userSegment(page).click();
        const filter = page.locator('.comment-filter-btn');
        const showPosted = page.getByRole('checkbox', { name: 'Show posted' });
        const panelItem = page.locator(`.finding-item.finding-comment[data-id="${id}"]`);
        await expect(panelItem).toBeVisible();

        // Away: stop showing posted comments.
        await leave(page);
        await filter.click();
        await expect(showPosted).toBeChecked();
        await showPosted.uncheck();
        await page.keyboard.press('Escape');
        await expect(panelItem).toHaveCount(0);
        // "1 posted hidden", or "1 posted · N dismissed hidden" when the review has dismissed comments.
        await expect(page.locator('.hidden-comments-notice')).toContainText(/\b1 posted\b/);
        await comeBack(page);
        await expect(card).toBeHidden();
        await expect(inlineComment(page, pending)).toBeAttached();
        await expect(inlineComment(page, pending)).toHaveCount(1);

        // Away again: show them.
        await leave(page);
        await filter.click();
        await showPosted.check();
        await page.keyboard.press('Escape');
        await expect(panelItem).toBeVisible();
        await comeBack(page);
        await expect(card).toHaveCount(1);
        await expect(card).toBeVisible();
        await expect(card.locator('a.posted-comment-icon')).toBeVisible();
        await expect(targetComments(page)).toHaveCount(2);
      });

      test('a posted comment edited while away shows the edit on return, reached from the review history', async ({ page }) => {
        const id = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_B, body: 'Find me from the history' });
        const review = await page.request.post('/api/pr/test-owner/test-repo/1/submit-review', { data: { event: 'COMMENT', body: 'A review for the history' } });
        expect(review.ok()).toBe(true);
        await reloadComments(page);
        await expect(inlineComment(page, id).locator('a.posted-comment-icon')).toBeAttached();
        await expect(inlineComment(page, id).locator('.posted-comment-edited')).toHaveCount(0);

        // Away: the posted comment is edited (what its card's editor saves).
        await leave(page);
        await api(page, 'PUT', `${commentsUrl}/${id}`, { body: 'Find me from the history, edited since' });
        await reloadComments(page);
        // An edited posted comment is not a new one to submit.
        await expect(page.locator('#split-button-main')).not.toHaveClass(/has-comments/);

        await page.locator('#split-button-dropdown-toggle').click();
        await page.getByRole('menuitem', { name: 'Review history' }).click();
        const history = page.locator('#review-history-modal');
        await expect(history).toBeVisible();
        await history.locator('.review-history-row', { hasText: 'A review for the history' }).first().locator('button').click();
        const entry = history.locator('.review-history-comment', { hasText: 'Find me from the history' });
        await expect(entry).toHaveCount(1);
        await entry.locator('.review-history-comment-body').click();
        await expect(history).toBeHidden();
        const card = inlineComment(page, id);
        await expect(card).toBeInViewport();
        await expect(page.locator('.toast-error')).toHaveCount(0);
        // The card, drawn while its file was away, shows the edit and that it differs from what was posted.
        await expect(card).toContainText('Find me from the history, edited since');
        await expect(card.locator('.posted-comment-edited')).toContainText('Edited since posted');
        await expect(targetComments(page)).toHaveCount(1);
      });
    } else {
      test('the preview opened from far away lists a comment on the far file', async ({ page }) => {
        await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_A, body: 'Previewed from far away' });
        await reloadComments(page);
        await leave(page);
        await expectPendingCount(page, 1);

        await page.locator('#split-button-main').click();
        const preview = page.locator('#preview-modal');
        await expect(preview).toBeVisible();
        await expect(preview.locator('#preview-text')).toContainText('Previewed from far away');
        await expect(preview.locator('#preview-text')).toContainText(TARGET);
      });

      test('showing dismissed comments while away changes the review panel and never the diff', async ({ page }) => {
        const kept = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_A, body: 'Kept' });
        const dismissed = await seedComment(page, mode.reviewId, { file: TARGET, line: LINE_B, body: 'Dismissed' });
        await reloadComments(page);
        await page.evaluate((cid) => window.prManager.deleteUserComment(cid), dismissed);
        await expect(inlineComment(page, dismissed)).toHaveCount(0);
        await userSegment(page).click();
        const panelItem = page.locator(`.finding-item.finding-comment[data-id="${dismissed}"]`);
        await expect(panelItem).toHaveCount(0);

        await leave(page);
        await page.locator('.comment-filter-btn').click();
        await page.getByRole('checkbox', { name: 'Show dismissed' }).check();
        await page.keyboard.press('Escape');
        await expect(panelItem).toBeVisible();
        await expect(panelItem).toHaveClass(/comment-item-dismissed/);
        // Still exactly one comment to submit. (The segment now also counts
        // every comment ever dismissed on this review, so it is not read here.)
        await expect(page.locator('#split-button-main')).toHaveClass(/has-comments/);
        expect(await page.evaluate(() => window.prManager.getPendingCommentCount())).toBe(1);

        // A dismissed comment is never drawn on the diff; the kept one is there once.
        await comeBack(page);
        await expect(inlineComment(page, kept)).toBeVisible();
        await expect(inlineComment(page, dismissed)).toHaveCount(0);
        await expect(targetComments(page)).toHaveCount(1);
      });
    }
  });

  test.describe(`Navigation to a card far down a file longer than the rows the viewer draws (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await routeDiff(page, LONG.corpus);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await cleanupAllComments(page, mode.reviewId);
      await page.evaluate(() => Promise.all([window.prManager.loadUserComments(), window.prManager.loadAISuggestions()]));
      await page.evaluate(() => window.aiPanel?.expand());
    });

    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    /** The reader at the top of the pane: the long file is the second file, its first rows on screen. */
    async function toTheTop(page) {
      await scrollDiffToEdge(page, 'top');
      await expect(fileWrapper(page, LONG.long)).toBeInViewport();
      await waitForDiffSettled(page);
    }

    test('a finding and a comment thousands of lines down are reached from the review panel and with the navigator keys', async ({ page }) => {
      const [near, far] = await seedSuggestions(page, mode.reviewId, [
        { file: LONG.small, line_start: LONG.nearLine, title: 'Near', body: 'Near body' },
        { file: LONG.long, line_start: LONG.farLine, title: 'Far', body: 'Far body' }
      ]);
      const comment = await seedComment(page, mode.reviewId, { file: LONG.long, line: LONG.fartherLine, body: 'Far down the long file' });
      await reloadComments(page);
      await expect(inlineSuggestion(page, near)).toBeVisible();

      // A click on the finding in the review panel.
      await toTheTop(page);
      await page.locator(`.finding-item[data-id="${far}"]`).click();
      await expect(inlineSuggestion(page, far)).toBeInViewport();

      // The navigator keys, pressed from the toolbar pinned above the diff.
      await toTheTop(page);
      await page.locator('.diff-toolbar').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('j');
      await expect(inlineSuggestion(page, near)).toBeInViewport();
      await page.keyboard.press('j');
      await expect(inlineSuggestion(page, far)).toBeInViewport();
      await page.keyboard.press('k');
      await expect(inlineSuggestion(page, near)).toBeInViewport();

      // A click on the comment in the review panel's User segment.
      await toTheTop(page);
      await userSegment(page).click();
      const item = page.locator(`.finding-item.finding-comment[data-id="${comment}"]`);
      await expect(item).toBeVisible();
      await item.click();
      await expect(inlineComment(page, comment)).toBeInViewport();

      await expect(page.locator('.toast-error, .toast-warning')).toHaveCount(0);
      await assertNoOrphanHosts(page);
    });

    test('from far down the long file, a file-level comment and a card near its top are reached from the review panel', async ({ page }) => {
      const far = await seedComment(page, mode.reviewId, { file: LONG.long, line: LONG.fartherLine, body: 'Far down the long file' });
      const top = await seedComment(page, mode.reviewId, { file: LONG.long, line: LONG.topLine, body: 'Near the top of the long file' });
      const fileLevel = await seedComment(page, mode.reviewId, { file: LONG.long, body: 'About the whole long file', fileLevel: true });
      await reloadComments(page);
      await userSegment(page).click();
      const item = (id) => page.locator(`.finding-item.finding-comment[data-id="${id}"]`);
      await expect(item(far)).toBeVisible();

      // Go far down first: the rows at the top of the file are not what the viewer draws there.
      await toTheTop(page);
      await item(far).click();
      await expect(inlineComment(page, far)).toBeInViewport();
      await waitForDiffSettled(page);

      await item(fileLevel).click();
      const zoneCard = fileWrapper(page, LONG.long).locator('.file-comment-card');
      await expect(zoneCard).toContainText('About the whole long file');
      await expect(zoneCard).toBeInViewport();

      await item(far).click();
      await expect(inlineComment(page, far)).toBeInViewport();
      await waitForDiffSettled(page);

      await item(top).click();
      await expect(inlineComment(page, top)).toBeInViewport();

      await expect(page.locator('.toast-error, .toast-warning')).toHaveCount(0);
      await assertNoOrphanHosts(page);
    });
  });

  test.describe(`The last rows of a file a few rows longer than one block of the viewer's rows, at the end of the pane (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await routeDiff(page, LONG_TAIL.corpus);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await cleanupAllComments(page, mode.reviewId);
      await page.evaluate(() => Promise.all([window.prManager.loadUserComments(), window.prManager.loadAISuggestions()]));
      await page.evaluate(() => window.aiPanel?.expand());
    });

    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    test('the file\'s last lines are drawn when the pane is at its end, and a comment on one of them is reached from the review panel', async ({ page }) => {
      const comment = await seedComment(page, mode.reviewId, { file: LONG_TAIL.long, line: LONG_TAIL.tailLine, body: 'On one of the last lines' });
      await reloadComments(page);
      const wrapper = fileWrapper(page, LONG_TAIL.long);

      // The reader scrolls to the end of the pane, and again when the pane
      // has grown under it (the comment's card has a height once the row
      // under it is drawn, a frame or more after the scroll that drew it):
      // the pane comes to rest at its end with the end of the file in it.
      await expect(async () => {
        await scrollDiffToEdge(page, 'bottom');
        await waitForDiffSettled(page);
        const state = await scrollState(page);
        expect(state.top + state.client).toBeGreaterThanOrEqual(state.height - 1);
        await expect(lineNumberCell(wrapper, LONG_TAIL.lastLine).first()).toBeInViewport({ timeout: 500 });
        await expect(lineNumberCell(wrapper, LONG_TAIL.blockEnd).first()).toBeInViewport({ timeout: 500 });
        await expect(inlineComment(page, comment)).toBeInViewport({ timeout: 500 });
      }).toPass();

      // From the top of the pane, a click on the comment in the review panel.
      await scrollDiffToEdge(page, 'top');
      await expect(fileWrapper(page, LONG_TAIL.small)).toBeInViewport();
      await waitForDiffSettled(page);
      await userSegment(page).click();
      const item = page.locator(`.finding-item.finding-comment[data-id="${comment}"]`);
      await expect(item).toBeVisible();
      await item.click();
      await expect(inlineComment(page, comment)).toBeInViewport();
      await expect(lineNumberCell(wrapper, LONG_TAIL.tailLine).first()).toBeInViewport();

      await expect(page.locator('.toast-error, .toast-warning')).toHaveCount(0);
      await assertNoOrphanHosts(page);
    });
  });

  test.describe(`File comment zones of one-sided files (${mode.name})`, () => {
    const R = EDGE.roles;

    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    test('a deleted file and an added file each show a file-level comment saved while they were out of view', async ({ page }) => {
      await routeDiff(page, EDGE);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await cleanupAllComments(page, mode.reviewId);
      // Both files are below the first screen of this corpus.
      await scrollFileIntoView(page, R.unicode);
      await seedComment(page, mode.reviewId, { file: R.deleted, body: 'About the deleted file', fileLevel: true });
      await seedComment(page, mode.reviewId, { file: R.added, body: 'About the added file', fileLevel: true });
      await reloadComments(page);

      for (const [file, text] of [[R.deleted, 'About the deleted file'], [R.added, 'About the added file']]) {
        await scrollFileIntoView(page, file);
        await waitForFileRendered(page, file);
        const card = fileWrapper(page, file).locator('.file-comment-card');
        await expect(card).toHaveCount(1);
        await expect(card).toBeVisible();
        await expect(card).toContainText(text);
        await expect(fileWrapper(page, file).locator('.file-header-comment-btn')).toHaveClass(/has-comments/);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Hunk summaries, tour stops and external threads on far files
// ---------------------------------------------------------------------------

for (const mode of MODES) {
  test.describe(`Drawn on a far file: hunk summaries (${mode.name})`, () => {
    const [targetFirst, targetSecond] = HASHES.get(TARGET);
    const [tailFirst] = HASHES.get(TAIL);
    const summary = (page, hash) => page.locator(`.hunk-summary-row[data-content-hash="${hash}"]`);

    test('a summary loaded for a file not reached yet is on its hunk when the file is reached; one pushed while away is there on return', async ({ page }) => {
      await mockAppConfig(page, { summaries: { enabled: true } });
      await mockHunkSummaries(page, [
        { file_path: TARGET, content_hash: targetFirst, summary_text: 'Target, first hunk.' },
        { file_path: TAIL, content_hash: tailFirst, summary_text: 'Tail, its hunk.' }
      ]);
      await routeDiff(page, EVICTION);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForFileRendered(page, TARGET);
      await waitForFileSettled(page, TARGET);
      await expect(page.locator('#summary-toggle-btn')).toBeVisible();

      await expect(summary(page, targetFirst)).toBeVisible();
      await expect(summary(page, targetFirst).locator('.hunk-summary-text')).toHaveText('Target, first hunk.');
      // The tail is about 70,000 px down and has shown nothing yet.
      expect(await hasRenderedBody(page, TAIL)).toBe(false);

      // Away from the target: a summary for another of its hunks is pushed.
      await scrollFileOutOfView(page, TARGET);
      await pushHunkSummaries(page, mode.reviewId, TARGET, [
        { content_hash: targetSecond, summary_text: 'Target, second hunk, pushed while away.' }
      ]);

      // The tail, reached for the first time, has its summary, once.
      await scrollFileIntoView(page, TAIL);
      await waitForFileRendered(page, TAIL);
      await expect(summary(page, tailFirst)).toHaveCount(1);
      await expect(summary(page, tailFirst)).toBeVisible();
      await expect(summary(page, tailFirst).locator('.hunk-summary-text')).toHaveText('Tail, its hunk.');
      await expect(lineCards(page, '.hunk-summary-row', fileSelector(TAIL))).toHaveCount(1);

      // Back at the target: both of its summaries, each once.
      await scrollFileIntoView(page, TARGET);
      await waitForFileRendered(page, TARGET);
      await expect(summary(page, targetFirst)).toHaveCount(1);
      await expect(summary(page, targetFirst)).toBeVisible();
      await expect(summary(page, targetSecond)).toHaveCount(1);
      await expect(summary(page, targetSecond).locator('.hunk-summary-text')).toHaveText('Target, second hunk, pushed while away.');
      await expect(lineCards(page, '.hunk-summary-row', fileSelector(TARGET))).toHaveCount(2);

      // Leaving and returning again adds nothing.
      await scrollFileOutOfView(page, TARGET);
      await scrollFileIntoView(page, TARGET);
      await waitForFileRendered(page, TARGET);
      await expect(lineCards(page, '.hunk-summary-row', fileSelector(TARGET))).toHaveCount(2);
      // Three in the whole pane (the tail's file may have no element now), each once.
      await expectLineCardsInPane(page, '.hunk-summary-row', 'hunk-summary', 3);
      await assertNoOrphanHosts(page);
    });
  });

  test.describe(`Drawn on a far file: tour stops (${mode.name})`, () => {
    const STOPS = [
      { file_path: TARGET, side: 'RIGHT', line_start: LINE_A, line_end: LINE_A, title: 'Stop one', description: 'On the target.' },
      { file_path: TAIL, side: 'RIGHT', line_start: TAIL_LINE, line_end: TAIL_LINE, title: 'Stop two', description: 'On the tail, far away.' },
      { file_path: TARGET, side: 'RIGHT', line_start: LINE_B, line_end: LINE_B, title: 'Stop three', description: 'Back on the target.' }
    ];
    const stop = (page, index) => page.locator(`.tour-annotation-row[data-stop-index="${index}"]`);

    test('each stop is shown on its line and brought into view, across files far apart; leaving the tour removes them', async ({ page }) => {
      await mockAppConfig(page, { tours: { enabled: true } });
      await mockHunkSummaries(page, []);
      await mockTour(page, STOPS);
      await routeDiff(page, EVICTION);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForFileRendered(page, TARGET);
      await waitForFileSettled(page, TARGET);

      await page.locator('#tour-toggle-btn').click();
      const bar = page.locator('.tour-bar');
      const progress = bar.locator('.tour-bar__progress');
      await expect(progress).toHaveText('Stop 1 of 3');
      await expect(stop(page, 0)).toBeInViewport();
      await expect(stop(page, 0).locator('.tour-annotation-title')).toHaveText('Stop one');
      await expect(fileWrapper(page, TARGET).locator('.tour-annotation-row')).toHaveCount(1);

      // The second stop is in a file that has never been near the viewport.
      await bar.locator('.tour-bar__next').click();
      await expect(progress).toHaveText('Stop 2 of 3');
      await expect(stop(page, 1)).toBeInViewport();
      await expect(stop(page, 1)).toHaveClass(/active-stop/);
      await expect(stop(page, 1).locator('.tour-annotation-title')).toHaveText('Stop two');
      await expect(fileWrapper(page, TAIL).locator('.tour-annotation-row')).toHaveCount(1);
      await expect(page.locator('.tour-annotation-row')).toHaveCount(1);

      // The third is back in the first file, now far above.
      await bar.locator('.tour-bar__next').click();
      await expect(progress).toHaveText('Stop 3 of 3');
      await expect(stop(page, 2)).toBeInViewport();
      await expect(stop(page, 2).locator('.tour-annotation-title')).toHaveText('Stop three');
      await expect(page.locator('.tour-annotation-row')).toHaveCount(1);

      // And back to the far one with the keyboard.
      await page.keyboard.press('ArrowLeft');
      await expect(progress).toHaveText('Stop 2 of 3');
      await expect(stop(page, 1)).toBeInViewport();

      // The tour never gave up on a stop.
      await expect(page.locator('.toast-error, .toast-warning')).toHaveCount(0);

      await page.keyboard.press('Escape');
      await expect(bar).toHaveCount(0);
      await expect(page.locator('body')).not.toHaveClass(/tour-active/);
      await expect(page.locator('.tour-annotation-row')).toHaveCount(0);
      // Nor is a stop left behind in the file that is away now.
      await scrollFileIntoView(page, TARGET);
      await waitForFileRendered(page, TARGET);
      await expect(fileWrapper(page, TARGET).locator('.tour-annotation-row')).toHaveCount(0);
      await assertNoOrphanHosts(page);
    });
  });
}

test.describe('Drawn on a far file: external threads (PR mode)', () => {
  const threadRow = (page, id) => page.locator(`.external-comment-row[data-thread-id="${id}"]`);
  const threadsOf = (page, file) => lineCards(page, '.external-comment-row', fileSelector(file));
  const externalSegment = (page) => page.locator('.segment-btn[data-segment="external"]');

  test('threads are on their lines in files far apart, a refresh while away duplicates nothing, and a panel click brings a far thread into view', async ({ page }) => {
    const external = await mockExternalComments(page, [
      externalThread({ id: 8101, file: TARGET, line: LINE_A, body: 'Thread on the target' }),
      externalThread({ id: 8201, file: TAIL, line: TAIL_LINE, body: 'Thread on the tail', replies: [{ body: 'Reply on the tail' }] })
    ]);
    await routeDiff(page, EVICTION);
    // The order of two answers is pinned, here and at the refresh below: the
    // thread list is answered once the diff has settled. Left to chance, a
    // list answered while a file's upgraded diff awaits display puts that
    // file's thread in its comment zone on main (ledger H60;
    // rerender-overlays.spec.js holds that window open and asserts it). On a
    // plain load of this page that happened in 3 of 120 runs at eight workers.
    const releaseFirstList = external.holdLists();
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await page.evaluate(() => window.aiPanel?.expand());
    try {
      await expect.poll(() => external.lists).toBe(1);
      await waitForFileRendered(page, TARGET);
      await waitForDiffSettled(page);
      await expect(page.locator('.external-comment-row')).toHaveCount(0);
    } finally {
      releaseFirstList();
    }

    await expect(threadRow(page, 8101)).toBeVisible();
    await expect(threadsOf(page, TARGET)).toHaveCount(1);
    await expect(externalSegment(page).locator('.segment-count')).toHaveText(/^\(?2\)?$/);

    // Away from the target: a third thread appears upstream, on the target, and the threads are refreshed.
    await scrollFileOutOfView(page, TARGET);
    external.threads = [...external.threads, externalThread({ id: 8301, file: TARGET, line: LINE_B, body: 'New thread on the target' })];
    const syncsBefore = external.syncs;
    const listsBefore = external.lists;
    const releaseRefreshedList = external.holdLists();
    try {
      await page.locator('#refresh-external-comments-btn-panel').click();
      await expect.poll(() => external.syncs).toBe(syncsBefore + 1);
      await expect.poll(() => external.lists).toBe(listsBefore + 1);
      await waitForDiffSettled(page);
    } finally {
      releaseRefreshedList();
    }
    await expect(externalSegment(page).locator('.segment-count')).toHaveText(/^\(?3\)?$/);
    await expect(page.locator('#refresh-external-comments-btn-panel')).toBeEnabled();

    // The tail has its thread, once, root and reply, on its line.
    await scrollFileIntoView(page, TAIL);
    await waitForFileRendered(page, TAIL);
    await expect(threadsOf(page, TAIL)).toHaveCount(1);
    await expect(threadRow(page, 8201)).toBeVisible();
    await expect(threadRow(page, 8201).locator('.external-comment')).toHaveCount(2);

    // From here, a click on the new thread in the review panel brings its row into view.
    await externalSegment(page).click();
    const item = page.locator('.ai-panel__list-item--external', { hasText: 'New thread on the target' });
    await expect(item).toHaveCount(1);
    await item.click();
    await expect(threadRow(page, 8301)).toBeInViewport();
    await expect(page.locator('.toast-error')).toHaveCount(0);

    // The target has its two threads, each once; three in all.
    await expect(threadsOf(page, TARGET)).toHaveCount(2);
    await expect(threadRow(page, 8101)).toHaveCount(1);
    await expect(threadRow(page, 8301)).toHaveCount(1);
    // (the tail's file may have no element now: a statement about the pane)
    await expectLineCardsInPane(page, '.external-comment-row', 'external-comment', 3);
    await assertNoOrphanHosts(page);
  });
});
