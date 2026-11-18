// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: what one test draws on a fixture review does not reach the next
 *
 * Every spec file a worker runs shares that worker's database, and which
 * files share a worker differs from run to run. The fixture in fixtures.js
 * (`fixtureReviewsLeftClean`) therefore empties the two fixture reviews after
 * every test. These tests prove that mechanism, in both modes, including the
 * part that is easy to lose: the server adds a context file for a comment
 * AFTER it has answered the save, and the reset waits for that work
 * (`whenBackgroundWorkDone` in test-server.js), which only works while the
 * save still goes through the test server's wrapper.
 *
 * The tests of a describe run in order in one worker (the suite is not
 * `fullyParallel`), so the second finds what the first left.
 */

import { test, expect } from './fixtures.js';
import { MODES, waitForDiffToRender, seedComment, seedSuggestions } from './helpers.js';
import { filesInPane, layoutValidator, layoutValidatorState, waitForDiffSettled } from './diff-dom.js';
import { allCorpora, routeDiff } from './fixtures/diffs.js';

/** Rows of one review in the worker's database, counted the way the reset checks them. */
function rowsOf(testServer, reviewId) {
  return testServer.db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM comments WHERE review_id = @id AND source = 'user' AND status = 'active') AS comments,
      (SELECT COUNT(*) FROM comments WHERE review_id = @id AND source = 'ai') AS suggestions,
      (SELECT COUNT(*) FROM context_files WHERE review_id = @id) AS contextFiles
  `).get({ id: reviewId });
}

for (const mode of MODES) {
  test.describe(`Fixture reviews are left clean (${mode.name})`, () => {
    // A file the review's diff does not have, so the server adds it as a
    // context file once the comment is saved.
    const OUTSIDE = 'src/outside-the-diff.js';

    test('a test leaves a comment, a suggestion and a context file behind', async ({ page, testServer }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);

      const startedBefore = testServer.backgroundWorkStarted();
      await seedComment(page, mode.reviewId, { file: OUTSIDE, line: 3, body: 'Left behind on purpose' });
      // The save has been answered; the context file is written after the
      // answer. The server's wrapper saw that work start (if this count does
      // not move, the reset is waiting for nothing)...
      expect(testServer.backgroundWorkStarted()).toBe(startedBefore + 1);
      // ...and this is the wait the reset relies on.
      await testServer.whenBackgroundWorkDone();
      expect(rowsOf(testServer, mode.reviewId)).toEqual({ comments: 1, suggestions: 0, contextFiles: 1 });

      await seedSuggestions(page, mode.reviewId, [
        { file: 'src/utils.js', line_start: 3, title: 'Left behind on purpose', body: 'Left behind on purpose' }
      ]);
      expect(rowsOf(testServer, mode.reviewId)).toEqual({ comments: 1, suggestions: 1, contextFiles: 1 });
      // No cleanup here: that is the point.
    });

    test('the next test finds the review as seeded', async ({ page, testServer }) => {
      expect(rowsOf(testServer, mode.reviewId)).toEqual({ comments: 0, suggestions: 0, contextFiles: 0 });

      await page.goto(mode.path);
      await waitForDiffToRender(page);
      // What a reader sees: the two files of the fixture, no card, no finding.
      expect((await filesInPane(page)).map((f) => f.file)).toEqual(['src/main.js', 'src/utils.js']);
      await expect(page.locator('.file-item')).toHaveCount(2);
      await page.evaluate(() => Promise.all([window.prManager.loadUserComments(), window.prManager.loadAISuggestions()]));
      await expect(page.locator('.user-comment-row')).toHaveCount(0);
      await expect(page.locator('.ai-suggestion')).toHaveCount(0);
      await expect(page.locator('.finding-item')).toHaveCount(0);
    });
  });
}

// A run with PR_VENDOR_BUNDLE=dev is meant to assert the viewer's layout in
// every test, through the console guard. That only holds if the page really
// loaded the development bundle and the viewer really got its validator: a
// run in which neither happened would be green and prove nothing.
test.describe('The layout validator of a development-bundle run', () => {
  const wanted = process.env.PR_VENDOR_BUNDLE === 'dev';

  for (const mode of MODES) {
    test(`is on when the run asks for it, and off otherwise (${mode.name})`, async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      expect(await layoutValidatorState(page)).toEqual({ developmentBundle: wanted, validator: wanted });
    });

    // The one report the fixture does not fail a test on (vendor fact F27;
    // tests/e2e/diff-dom-codeview.js, installInPage). The report itself is
    // pinned on the real viewer by the contract suite (vendor/layout.spec.js,
    // bridge/view.spec.js); here it is the fixture's rule that is tested, so
    // the viewer's message is logged by the test.
    test.describe(`what the fixture does with a report of the viewer (${mode.name})`, () => {
      test.skip(!wanted, 'the layout validator exists only in a development-bundle run on the virtualized viewer');

      const report = (page, message) => page.evaluate(async (message) => {
        console.error(message, { delta: 90 });
        const sameTask = { ...window.__layoutValidator };
        for (let frames = 0; frames < 4; frames++) await new Promise((resolve) => requestAnimationFrame(resolve));
        return { sameTask, later: { ...window.__layoutValidator } };
      }, message);

      test('a sticky-height report is held and counted as followed when the layout agrees in the frames after it', async ({ page }) => {
        await page.goto(mode.path);
        await waitForDiffToRender(page);
        await waitForDiffSettled(page);
        expect(await page.evaluate(() => ({ ...window.__layoutValidator }))).toEqual({ reports: 0, followed: 0 });
        const state = await report(page, 'CodeView: sticky container height does not match computed layout');
        // Not decided in the task of the report ...
        expect(state.sameTask).toEqual({ reports: 0, followed: 0 });
        // ... and the pane is exact two frames later: nothing reaches the console guard.
        expect(state.later).toEqual({ reports: 0, followed: 1 });
      });

      test.describe('a sticky-height report with the pane at rest and the layout still off', () => {
        test.use({ expectedConsoleErrors: [/\[console\.error\] CodeView: sticky container height does not match computed layout \(then: 50 items /] });

        test('reaches the console guard two frames later, with what the pane was doing', async ({ page }) => {
          await page.goto(mode.path);
          await waitForDiffToRender(page);
          await waitForDiffSettled(page);
          // The viewer's own number for the drawn files reads 50 px short
          // for as long as the test looks, whatever the viewer writes to it
          // meanwhile, and nothing moves: the comparison the fixture repeats
          // stays unequal.
          const state = await layoutValidator.reportWithTheLayoutOff(page, 50);
          // Not decided in the task of the report, nor one frame later ...
          expect(state.sameTask).toEqual({ reports: 0, followed: 0 });
          expect(state.oneFrame).toEqual({ reports: 0, followed: 0 });
          // ... and after two frames at rest it is a mismatch. (The viewer
          // reports the same number itself if it renders meanwhile.)
          expect(state.later.followed).toBe(0);
          expect(state.later.reports).toBeGreaterThanOrEqual(1);
        });
      });

      test('a frame in which the pane\'s box changed does not count: a report made while the review panel opens over a long file is followed', async ({ page }) => {
        // The review panel's width animates for 0.2 s; the pane gets
        // narrower in every frame of it and the lines of the drawn files
        // wrap again. A render forced in such a frame reports heights the
        // viewer follows later in the same frame. Two frames after the
        // first report the pane is still moving and the layout is off by
        // another amount: that is not a mismatch.
        const { eviction } = allCorpora();
        await routeDiff(page, eviction);
        await page.goto(mode.path);
        await waitForDiffToRender(page);
        await waitForDiffSettled(page);
        const state = await layoutValidator.openReviewPanelUnderForcedRenders(page);
        // The pane's width did change over several frames, the viewer did report, and every report was followed.
        expect(state.widths).toBeGreaterThan(3);
        expect(state.after.followed).toBeGreaterThan(state.before.followed);
        expect(state.after.reports).toBe(state.before.reports);
      });

      test('a frame in which a drawn file\'s height changed does not count either: a report followed by such a change before its second frame is not decided there', async ({ page }) => {
        // What a test does that undoes a change right away: the edit form
        // of a file comment opens (the file grows 99.5 px), a render is
        // forced in that task, and the edit is cancelled between the two
        // frames that follow. The viewer follows the growth in the first
        // frame and the shrinking in the second, each before it is painted,
        // so the comparison is unequal at the callbacks of both and equal
        // from the third. Counted from the report, that was a mismatch
        // "still there two frames later" (ledger H141, measured). Here the
        // same shape with the fixture's rule alone under test: the layout
        // reads 50 px short for two frames, and a form opens between them.
        await page.goto(mode.path);
        await waitForDiffToRender(page);
        await waitForDiffSettled(page);
        const state = await layoutValidator.reportThenChangeHeightBetweenFrames(page, 50);
        // The drawn files did grow between the two frames.
        expect(state.grew).toBeGreaterThan(50);
        // Not decided one frame after the report, nor at the second: its box had changed ...
        expect(state.oneFrame).toEqual(state.before);
        expect(state.twoFrames).toEqual(state.before);
        // ... and followed once the layout agreed: nothing reaches the console guard.
        expect(state.later.followed).toBeGreaterThan(state.before.followed);
        expect(state.later.reports).toBe(state.before.reports);
      });

      test.describe('any other report', () => {
        test.use({ expectedConsoleErrors: [/\[console\.error\] CodeView: reconciled item height does not match DOM height/] });

        test('is counted at once and reaches the console guard, which fails a test that does not expect it', async ({ page }) => {
          await page.goto(mode.path);
          await waitForDiffToRender(page);
          await waitForDiffSettled(page);
          const state = await report(page, 'CodeView: reconciled item height does not match DOM height');
          expect(state.sameTask).toEqual({ reports: 1, followed: 0 });
          expect(state.later).toEqual({ reports: 1, followed: 0 });
        });
      });
    });
  }
});

for (const mode of MODES) {
  test.describe(`A page reloaded while its first request is in flight (${mode.name})`, () => {
    // A spec that opens a review and reloads it at once (panel-resize.spec.js
    // does, to apply a cleared localStorage) cuts the first page's own load
    // short. The page's top-level loader logs the rejection of the request it
    // was waiting for, as the loaders it calls do for theirs; the console
    // guard must take that for what it is. Before `Error loading PR` and
    // `Error loading local review` were on its list this failed a test about
    // once in a few hundred runs, whenever the reload came before the first
    // answer (ledger H148).
    test('the interruption the top-level loader logs does not fail a test', async ({ page }) => {
      const first = mode.local ? /\/api\/local\/2$/ : /\/api\/pr\/test-owner\/test-repo\/1$/;
      let requested;
      const firstRequested = new Promise((resolve) => { requested = resolve; });
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      let holding = true;
      await page.route(first, async (route) => {
        if (!holding) return route.continue();
        holding = false;
        requested();
        await held;
        // The page that asked has been reloaded: there is nothing to answer.
        return route.abort().catch(() => {});
      });
      const logged = [];
      page.on('console', (message) => { if (message.type() === 'error') logged.push(message.text()); });

      await page.goto(mode.path, { waitUntil: 'commit' });
      await firstRequested;
      await page.reload();
      release();
      await waitForDiffToRender(page);
      const line = mode.local ? /^Error loading local review: TypeError: Failed to fetch/ : /^Error loading PR: TypeError: Failed to fetch/;
      await expect.poll(() => logged.some((text) => line.test(text))).toBe(true);
    });
  });
}

