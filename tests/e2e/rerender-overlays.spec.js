// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: whole-diff re-renders and what is drawn on the diff (N9 of plans/codeview-virtualized-diff.md)
 *
 * The whitespace toggle and a refresh (both modes), and in Local mode a scope
 * change, each fetch the diff again and rebuild the diff pane; comments,
 * file-level comments and suggestions are then put back. Characterization of
 * main: after each of them every file is there once, with its rows, and each
 * card is there once, on its line. The same for what else is drawn on the
 * diff: external review threads (PR mode) and hunk summaries, including a
 * file whose hunks no longer line up with the hashes its summaries are keyed
 * by. The Local base-branch change is the one re-render that does not put
 * cards back on main; it is characterized as it is.
 *
 * The diff endpoints are routed (the default fixture, with and without
 * `?w=1`): Local mode regenerates its diff with git on these paths and the
 * fixture review has no working directory. The Local refresh and scope
 * endpoints are answered here for the same reason; what is under test is what
 * the page does with a successful answer.
 */

import { test, expect } from './fixtures.js';
import {
  MODES, waitForDiffToRender, seedComment, seedSuggestions, reloadComments, cleanupAllComments, expectResponse,
  mockAppConfig, mockHunkSummaries, mockExternalComments, externalThread, holdFileContents
} from './helpers.js';
import { allCorpora, routeDiff, hunkHashes, prDiffResponse, localDiffResponse } from './fixtures/diffs.js';
import {
  fileWrapper, filesInPane, inlineComment, inlineSuggestion, lineCards, fileSelector, rowCount,
  waitForContentUpgrade, waitForDiffSettled, waitForHighlightedDisplay, upgradeAwaitingDisplay, holdWorkerResults, isLineVisible,
  assertNoOrphanHosts, BASE_CHANGE_KEEPS_CARDS, THREAD_ADDED_WHILE_DIFF_AWAITS_DISPLAY
} from './diff-dom.js';

const { default: DEFAULT } = allCorpora();
const UTILS = 'src/utils.js';
const MAIN = 'src/main.js';
// The hash each hunk's summary is keyed by, per file, in hunk order.
const HASHES = hunkHashes(DEFAULT.diff);
const WHITESPACE_HIDDEN = /\/diff\?.*w=1/;
const WHITESPACE_SHOWN = /\/diff(\?(?!.*w=1).*)?$/;

/** Flip the whitespace option and wait for the diff it fetches. */
async function toggleWhitespace(page, hide) {
  const fetched = expectResponse(page, (r) => (hide ? WHITESPACE_HIDDEN : WHITESPACE_SHOWN).test(r.url()));
  await setHideWhitespace(page, hide);
  await fetched;
  await waitForDiffToRender(page);
}

/** Set the "Hide whitespace changes" option through the diff-options popover. */
async function setHideWhitespace(page, hide) {
  await page.locator('#diff-options-btn').click();
  const checkbox = page.locator('.diff-options-popover')
    .locator('label', { hasText: 'Hide whitespace changes' })
    .locator('input[type="checkbox"]');
  await expect(checkbox).toBeVisible();
  if (hide) await checkbox.check();
  else await checkbox.uncheck();
  await page.keyboard.press('Escape');
}

for (const mode of MODES) {
  test.describe(`Re-rendering the whole diff (${mode.name})`, () => {
    let diffRequests;
    let ids;

    test.beforeEach(async ({ page }) => {
      diffRequests = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (/\/api\/(pr\/[^/]+\/[^/]+\/\d+|local\/\d+)\/diff$/.test(url.pathname)) {
          diffRequests.push(url.search);
        }
      });
      await routeDiff(page, DEFAULT);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await cleanupAllComments(page, mode.reviewId);
      // The page loaded before the cleanup: drop what it drew of anything a
      // test that ran earlier in this worker left behind.
      await page.evaluate(() => Promise.all([window.prManager.loadUserComments(), window.prManager.loadAISuggestions()]));
      await waitForContentUpgrade(page, UTILS);
      await waitForContentUpgrade(page, MAIN);

      // One of each kind of thing drawn on the diff.
      const line = await seedComment(page, mode.reviewId, { file: UTILS, line: 6, body: 'Line comment kept across re-renders' });
      const fileLevel = await seedComment(page, mode.reviewId, { file: MAIN, body: 'File comment kept across re-renders', fileLevel: true });
      await reloadComments(page);
      const [suggestion] = await seedSuggestions(page, mode.reviewId, [
        { file: UTILS, line_start: 4, title: 'Suggestion kept across re-renders', body: 'Suggestion body' }
      ]);
      ids = { line, fileLevel, suggestion };
      await expectEverythingOnce(page);
    });

    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    /** Both files once, with rows; each card once, in its file. */
    async function expectEverythingOnce(page) {
      await expect.poll(async () => (await filesInPane(page)).map((f) => f.file)).toEqual([MAIN, UTILS]);
      await expect.poll(() => rowCount(page, UTILS)).toBeGreaterThan(0);
      await expect.poll(() => rowCount(page, MAIN)).toBeGreaterThan(0);
      await expect(inlineComment(page, ids.line)).toHaveCount(1);
      await expect(inlineComment(page, ids.line)).toBeVisible();
      await expect(inlineComment(page, ids.line)).toHaveAttribute('data-line-start', '6');
      await expect(lineCards(page, '.user-comment-row', fileSelector(UTILS))).toHaveCount(1);
      await expect(inlineSuggestion(page, ids.suggestion)).toHaveCount(1);
      await expect(inlineSuggestion(page, ids.suggestion)).toBeVisible();
      await expect(fileWrapper(page, MAIN).locator('.file-comment-card')).toHaveCount(1);
      await expect(fileWrapper(page, MAIN).locator('.file-comment-card')).toContainText('File comment kept across re-renders');
      await expect(fileWrapper(page, UTILS).locator('.file-comment-card')).toHaveCount(0);
      await assertNoOrphanHosts(page);
    }

    test('hiding whitespace fetches the diff with ?w=1 and puts every card back; showing it again does the same', async ({ page }) => {
      const before = diffRequests.length;
      const hidden = expectResponse(page, (r) => /\/diff\?.*w=1/.test(r.url()));
      await setHideWhitespace(page, true);
      await hidden;
      await expectEverythingOnce(page);
      expect(diffRequests.slice(before).filter((query) => /w=1/.test(query))).toHaveLength(1);

      const shown = expectResponse(page, (r) => /\/diff(\?(?!.*w=1).*)?$/.test(r.url()));
      await setHideWhitespace(page, false);
      await shown;
      await expectEverythingOnce(page);
    });

    test('two whitespace toggles in quick succession leave every file and every card there once', async ({ page }) => {
      // What the popover's checkbox calls, twice, without waiting for the first to finish.
      await page.evaluate(() => {
        window.prManager.handleWhitespaceToggle(true);
        window.prManager.handleWhitespaceToggle(false);
      });
      await expect.poll(() => diffRequests.length).toBeGreaterThanOrEqual(3);
      await waitForDiffToRender(page);
      await expectEverythingOnce(page);
      // And it stays that way once the late responses have been dealt with.
      await waitForContentUpgrade(page, UTILS);
      await expectEverythingOnce(page);
      await expect(page.locator('.toast-error')).toHaveCount(0);
    });

    if (!mode.local) {
      test('a refresh of the pull request re-renders the diff and puts every card back', async ({ page }) => {
        // The refresh endpoint asks GitHub; answered here with the pull
        // request as the page already has it (nothing changed upstream).
        const pullRequest = await page.evaluate(() => window.prManager.currentPR);
        let refreshes = 0;
        await page.route('**/api/pr/test-owner/test-repo/1/refresh', (route) => {
          refreshes++;
          return route.fulfill({ json: { success: true, data: pullRequest } });
        });
        const before = diffRequests.length;
        await page.locator('#refresh-pr').click();
        await expect.poll(() => refreshes).toBe(1);
        await expect.poll(() => diffRequests.length).toBeGreaterThan(before);
        await expect(page.locator('#refresh-pr')).toBeEnabled();
        await waitForDiffToRender(page);
        await expectEverythingOnce(page);
        await expect(page.locator('.toast-error')).toHaveCount(0);
      });
    }

    if (mode.local) {
      test('a refresh from the working directory re-renders the diff and puts every card back', async ({ page }) => {
        let refreshes = 0;
        await page.route('**/api/local/2/refresh', (route) => {
          refreshes++;
          return route.fulfill({ json: { success: true, stats: {}, headShaChanged: false } });
        });
        const before = diffRequests.length;
        await page.locator('#local-refresh-btn').click();
        await expect.poll(() => refreshes).toBe(1);
        await expect.poll(() => diffRequests.length).toBeGreaterThan(before);
        await expect(page.locator('#local-refresh-btn')).toBeEnabled();
        await waitForDiffToRender(page);
        await expectEverythingOnce(page);
        await expect(page.locator('.toast-error')).toHaveCount(0);
      });

      test('a scope change re-renders the diff and puts every card back', async ({ page }) => {
        const scopeRequests = [];
        await page.route('**/api/local/2/set-scope', (route) => {
          scopeRequests.push(route.request().postDataJSON());
          return route.fulfill({ json: { success: true } });
        });
        const before = diffRequests.length;
        // What the scope selector of the diff-options popover calls.
        await page.evaluate(() => window.localManager._handleScopeChange('staged', 'untracked'));
        expect(scopeRequests).toEqual([{ scopeStart: 'staged', scopeEnd: 'untracked' }]);
        expect(diffRequests.length).toBeGreaterThan(before);
        await waitForDiffToRender(page);
        await expectEverythingOnce(page);
        await expect(page.locator('.toast-error')).toHaveCount(0);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// The Local base-branch change (ledger H1: the sixth re-render path)
// ---------------------------------------------------------------------------

test.describe('Re-rendering the whole diff: Local base-branch change', () => {
  const REVIEW = 2;

  test.afterEach(async ({ page }) => {
    await cleanupAllComments(page, REVIEW);
  });

  test('choosing another base fetches the diff against it and re-renders every file', async ({ page }) => {
    const diffQueries = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (/\/api\/local\/\d+\/diff$/.test(url.pathname)) diffQueries.push(url.search);
    });
    await routeDiff(page, DEFAULT);
    // The selector exists for a branch-scope review of a stacked branch (two
    // or more ancestors to choose from). The fixture review is neither, so
    // its metadata is answered as one; everything else is the server's.
    await page.route(/\/api\/local\/2$/, async (route) => {
      const response = await route.fetch();
      const review = await response.json();
      await route.fulfill({ response, json: {
        ...review,
        branch: 'feature-b',
        baseBranch: 'main',
        scopeStart: 'branch',
        branchAvailable: true,
        stackData: [{ branch: 'main' }, { branch: 'feature-a', prNumber: 7 }, { branch: 'feature-b' }]
      } });
    });
    await page.goto('/local/2');
    await waitForDiffToRender(page);
    await cleanupAllComments(page, REVIEW);
    await page.evaluate(() => Promise.all([window.prManager.loadUserComments(), window.prManager.loadAISuggestions()]));
    await waitForContentUpgrade(page, UTILS);
    await waitForContentUpgrade(page, MAIN);

    const line = await seedComment(page, REVIEW, { file: UTILS, line: 6, body: 'Line comment across a base change' });
    await seedComment(page, REVIEW, { file: MAIN, body: 'File comment across a base change', fileLevel: true });
    await reloadComments(page);
    const [suggestion] = await seedSuggestions(page, REVIEW, [
      { file: UTILS, line_start: 4, title: 'Suggestion across a base change', body: 'Suggestion body' }
    ]);
    const fileCard = fileWrapper(page, MAIN).locator('.file-comment-card');
    await expect(inlineComment(page, line)).toBeVisible();
    await expect(inlineSuggestion(page, suggestion)).toBeVisible();
    await expect(fileCard).toHaveCount(1);

    const selector = page.locator('#base-branch-select');
    await expect(selector).toBeVisible();
    await expect(selector.locator('option')).toHaveText(['main', 'feature-a (#7)']);
    await expect(selector).toHaveValue('main');

    const before = diffQueries.length;
    const fetched = expectResponse(page, (r) => /\/api\/local\/2\/diff\?.*base=feature-a/.test(r.url()));
    await selector.selectOption('feature-a');
    await fetched;
    expect(diffQueries.slice(before)).toEqual(['?base=feature-a']);

    // Every file is there once, with its rows, and nothing went wrong.
    await waitForDiffToRender(page);
    await expect.poll(async () => (await filesInPane(page)).map((f) => f.file)).toEqual([MAIN, UTILS]);
    await expect.poll(() => rowCount(page, UTILS)).toBeGreaterThan(0);
    await expect.poll(() => rowCount(page, MAIN)).toBeGreaterThan(0);
    await assertNoOrphanHosts(page);
    await expect(page.locator('.toast-error')).toHaveCount(0);
    // The counts come from data and never dropped.
    await expect(page.locator('.segment-btn[data-segment="comments"] .segment-count')).toHaveText(/^\(?2\)?$/);

    if (!BASE_CHANGE_KEEPS_CARDS) {
      // Characterization of main: this path renders the new diff and does not
      // put anything back on it. The cards return with the next reload.
      await waitForContentUpgrade(page, UTILS);
      await expect(inlineComment(page, line)).toHaveCount(0);
      await expect(inlineSuggestion(page, suggestion)).toHaveCount(0);
      await expect(fileCard).toHaveCount(0);
      await page.evaluate(() => Promise.all([window.prManager.loadUserComments(), window.prManager.loadAISuggestions()]));
    }
    await expect(inlineComment(page, line)).toHaveCount(1);
    await expect(inlineComment(page, line)).toBeVisible();
    await expect(inlineComment(page, line)).toHaveAttribute('data-line-start', '6');
    await expect(inlineSuggestion(page, suggestion)).toHaveCount(1);
    await expect(inlineSuggestion(page, suggestion)).toBeVisible();
    await expect(fileCard).toHaveCount(1);

    // Choosing the review's own base again drops the override.
    const back = expectResponse(page, (r) => /\/api\/local\/2\/diff(\?(?!.*base=).*)?$/.test(r.url()));
    await selector.selectOption('main');
    await back;
    await waitForDiffToRender(page);
    await expect.poll(async () => (await filesInPane(page)).map((f) => f.file)).toEqual([MAIN, UTILS]);
  });
});

// ---------------------------------------------------------------------------
// External review threads (PR mode only: Local mode has no external source)
// ---------------------------------------------------------------------------

test.describe('Re-rendering the whole diff: external threads (PR mode)', () => {
  test('a whitespace toggle puts each external thread back on its line, once, without syncing again; a refresh syncs once and does the same', async ({ page }) => {
    const external = await mockExternalComments(page, [
      externalThread({ id: 7101, file: UTILS, line: 3, body: 'External thread on utils', replies: [{ body: 'Reply on utils' }] }),
      externalThread({ id: 7201, file: MAIN, line: 12, body: 'External thread on main' })
    ]);
    await routeDiff(page, DEFAULT);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    const threads = page.locator('.external-comment-row');
    const utilsThreads = lineCards(page, '.external-comment-row', fileSelector(UTILS));
    const mainThreads = lineCards(page, '.external-comment-row', fileSelector(MAIN));
    async function expectThreadsOnce() {
      await expect(threads).toHaveCount(2);
      await expect(utilsThreads).toHaveCount(1);
      await expect(utilsThreads).toBeVisible();
      await expect(utilsThreads.locator('.external-comment')).toHaveCount(2);
      await expect(utilsThreads).toContainText('External thread on utils');
      await expect(utilsThreads).toContainText('Reply on utils');
      await expect(mainThreads).toHaveCount(1);
      await expect(mainThreads).toBeVisible();
      await expect(mainThreads).toContainText('External thread on main');
      await expect(page.locator('.segment-btn[data-segment="external"] .segment-count')).toHaveText(/^\(?2\)?$/);
    }
    await expectThreadsOnce();
    // The load-time sync has been made; the toggles below must not make another.
    await expect.poll(() => external.syncs).toBe(1);

    /**
     * One toggle, with its order pinned: the rebuilt diff is on screen and
     * settled, with no thread on it, before the thread list is answered.
     * (Left to chance, a list answered while a second re-render is rebuilding
     * the files can leave a thread at file level on main: ledger H60.)
     */
    async function toggleAndExpectThreads(hide) {
      const listsBefore = external.lists;
      const release = external.holdLists();
      try {
        await toggleWhitespace(page, hide);
        // The application has reached the thread reload of this re-render...
        await expect.poll(() => external.lists).toBe(listsBefore + 1);
        // ...on a diff that was rebuilt (the threads drawn before are gone).
        await expect(threads).toHaveCount(0);
        await waitForDiffSettled(page);
      } finally {
        release();
      }
      await expectThreadsOnce();
    }

    await toggleAndExpectThreads(true);
    await toggleAndExpectThreads(false);
    expect(external.syncs).toBe(1);

    // A refresh of the pull request is the re-render that does sync again
    // (the commit may have changed): once, and the threads are back as well.
    const pullRequest = await page.evaluate(() => window.prManager.currentPR);
    await page.route('**/api/pr/test-owner/test-repo/1/refresh', (route) => route.fulfill({ json: { success: true, data: pullRequest } }));
    const listsBefore = external.lists;
    const release = external.holdLists();
    let refreshed;
    try {
      refreshed = page.evaluate(() => window.prManager.refreshPR());
      refreshed.catch(() => {});
      await expect.poll(() => external.lists).toBe(listsBefore + 1);
      await expect(threads).toHaveCount(0);
      await waitForDiffSettled(page);
    } finally {
      release();
    }
    await refreshed;
    await expectThreadsOnce();
    expect(external.syncs).toBe(2);

    await assertNoOrphanHosts(page);
    await expect(page.locator('.toast-error')).toHaveCount(0);
  });

  /**
   * The order the scenarios above and offscreen-mutations.spec.js pin away,
   * held open and asserted: the thread list is answered while a file's
   * upgraded diff has been taken by the application and is not displayed yet.
   * One ordinary page load is enough to get there; the window is a worker
   * round trip wide (tens of milliseconds, more on a busy machine).
   *
   * Three things make it certain here. The file is at rest, highlighted,
   * from its patch (contents held). The comments are reloaded once after
   * that, as every comment save or delete does: on the current engine the
   * file's annotation list is then no longer the array the engine last drew
   * from, which is what decides whether a card added during the window is
   * drawn at all (ledger H60). And the worker's results are held, so the
   * window stays open until the test has looked.
   */
  test('a thread list answered while a file\'s upgraded diff awaits display', async ({ page }) => {
    const external = await mockExternalComments(page, [
      externalThread({ id: 7301, file: UTILS, line: 3, body: 'Thread answered during the upgrade' })
    ]);
    const releaseLists = external.holdLists();
    await routeDiff(page, DEFAULT);
    const contents = await holdFileContents(page);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await page.evaluate(() => window.aiPanel?.expand());
    await waitForHighlightedDisplay(page, UTILS);
    await expect.poll(() => external.lists).toBe(1);
    await reloadComments(page);

    const thread = page.locator('.external-comment-row[data-thread-id="7301"]');
    const onLine = lineCards(page, '.external-comment-row', fileSelector(UTILS));
    const segmentCount = page.locator('.segment-btn[data-segment="external"] .segment-count');
    await expect(thread).toHaveCount(0);

    const worker = await holdWorkerResults(page);
    try {
      contents.release();
      await expect.poll(() => upgradeAwaitingDisplay(page, UTILS)).toBe(true);
      releaseLists();
      // The review panel is told about the threads after they were rendered.
      await expect(segmentCount).toHaveText(/^\(?1\)?$/);
      // The window was still open when that happened.
      expect(await upgradeAwaitingDisplay(page, UTILS)).toBe(true);
    } finally {
      await worker.release();
    }
    await waitForContentUpgrade(page, UTILS);

    // Once, whichever way.
    await expect(thread).toHaveCount(1);
    await expect(thread).toContainText('Thread answered during the upgrade');
    if (THREAD_ADDED_WHILE_DIFF_AWAITS_DISPLAY === 'line') {
      await expect(onLine).toHaveCount(1);
      await expect(thread).not.toHaveClass(/external-comment-row--file-fallback/);
    } else {
      // Characterization of main: demoted to the file's comment zone, and
      // still there with the upgraded diff on screen and its line in view.
      await expect(thread).toHaveClass(/external-comment-row--file-fallback/);
      await expect(fileWrapper(page, UTILS).locator('.file-comments-zone .external-comment-row')).toHaveCount(1);
      await expect(onLine).toHaveCount(0);
      expect(await isLineVisible(page, UTILS, 3)).toBe(true);
      // The next thread reload (here the panel's refresh) puts it on its line.
      await page.locator('#refresh-external-comments-btn-panel').click();
      await expect(onLine).toHaveCount(1);
      await expect(thread).toHaveCount(1);
      await expect(thread).not.toHaveClass(/external-comment-row--file-fallback/);
    }
    await assertNoOrphanHosts(page);
    await expect(page.locator('.toast-error')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Hunk summaries
// ---------------------------------------------------------------------------

for (const mode of MODES) {
  test.describe(`Re-rendering the whole diff: hunk summaries (${mode.name})`, () => {
    const [utilsFirst, utilsSecond] = HASHES.get(UTILS);
    const [mainFirst] = HASHES.get(MAIN);
    const SUMMARIES = [
      { file_path: UTILS, content_hash: utilsFirst, summary_text: 'First hunk of utils, summarized.' },
      { file_path: UTILS, content_hash: utilsSecond, summary_text: 'Second hunk of utils, summarized.' },
      { file_path: MAIN, content_hash: mainFirst, summary_text: 'The hunk of main, summarized.' }
    ];
    const summary = (page, hash) => page.locator(`.hunk-summary-row[data-content-hash="${hash}"]`);
    const summariesOf = (page, file) => lineCards(page, '.hunk-summary-row', fileSelector(file));

    async function open(page) {
      await mockAppConfig(page, { summaries: { enabled: true } });
      await mockHunkSummaries(page, SUMMARIES);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await expect(page.locator('#summary-toggle-btn')).toBeVisible();
    }

    async function expectEverySummaryOnce(page) {
      for (const { content_hash: hash, summary_text: text } of SUMMARIES) {
        await expect(summary(page, hash)).toHaveCount(1);
        await expect(summary(page, hash)).toBeVisible();
        await expect(summary(page, hash).locator('.hunk-summary-text')).toHaveText(text);
      }
      await expect(summariesOf(page, UTILS)).toHaveCount(2);
      await expect(summariesOf(page, MAIN)).toHaveCount(1);
    }

    test('with whitespace hidden each summary is on its hunk once, and again when whitespace is shown', async ({ page }) => {
      expect(HASHES.get(UTILS)).toHaveLength(2);
      await routeDiff(page, DEFAULT);
      await open(page);
      await expectEverySummaryOnce(page);

      await toggleWhitespace(page, true);
      await expectEverySummaryOnce(page);
      await toggleWhitespace(page, false);
      await expectEverySummaryOnce(page);
      await assertNoOrphanHosts(page);
    });

    test('a file whose hunks no longer line up with its hashes shows no summary; the other files keep theirs', async ({ page }) => {
      await routeDiff(page, DEFAULT);
      // With whitespace hidden the server can find fewer hunks than it has
      // hashes for (a hunk that only changed whitespace disappears). Answer
      // that diff with one hash too few for utils; main is untouched.
      const drifted = (hashes) => hashes.slice(0, hashes.length - 1);
      const pr = prDiffResponse(DEFAULT);
      const prDrifted = {
        ...pr,
        changed_files: pr.changed_files.map((f) => (f.file === UTILS ? { ...f, hunk_hashes: drifted(f.hunk_hashes) } : f))
      };
      const local = localDiffResponse(DEFAULT);
      const localDrifted = {
        ...local,
        hunk_hashes_by_file: { ...local.hunk_hashes_by_file, [UTILS]: drifted(local.hunk_hashes_by_file[UTILS]) }
      };
      await page.route(/\/api\/pr\/[^/]+\/[^/]+\/\d+\/diff\?.*w=1/, (route) => route.fulfill({ json: prDrifted }));
      await page.route(/\/api\/local\/\d+\/diff\?.*w=1/, (route) => route.fulfill({ json: localDrifted }));
      await open(page);
      await expectEverySummaryOnce(page);

      await toggleWhitespace(page, true);
      // Fails closed: no summary of utils is shown anywhere, in particular not
      // on a hunk it does not describe. Main still has its own.
      await expect(summary(page, mainFirst)).toHaveCount(1);
      await expect(summary(page, mainFirst)).toBeVisible();
      await expect(summariesOf(page, MAIN)).toHaveCount(1);
      await expect(summariesOf(page, UTILS)).toHaveCount(0);
      await expect(page.locator('.hunk-summary-row')).toHaveCount(1);
      await expect.poll(() => rowCount(page, UTILS)).toBeGreaterThan(0);

      // With the hashes back in line, so are the summaries.
      await toggleWhitespace(page, false);
      await expectEverySummaryOnce(page);
      await expect(page.locator('.toast-error')).toHaveCount(0);
    });
  });
}
