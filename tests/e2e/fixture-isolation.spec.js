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
import { filesInPane, layoutValidatorState, ENGINE } from './diff-dom.js';

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
  const wanted = process.env.PR_VENDOR_BUNDLE === 'dev' && ENGINE === 'codeview';

  for (const mode of MODES) {
    test(`is on when the run asks for it, and off otherwise (${mode.name})`, async ({ page }) => {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      expect(await layoutValidatorState(page)).toEqual({ developmentBundle: wanted, validator: wanted });
    });
  }
});
