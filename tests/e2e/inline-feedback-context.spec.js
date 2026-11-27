// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';
import { waitForDiffToRender, expandReviewPanel } from './helpers.js';
import {
  inlineComment, inlineSuggestion, ensureContentUpgrade, expandHunkBy, hunkContaining,
  isLineVisible, redisplayBaseDiff, holdWorkerResults
} from './diff-dom.js';

const FILE = 'src/main.js';
const MODES = [
  { name: 'PR', path: '/pr/test-owner/test-repo/1', diff: '**/api/pr/*/*/*/diff' },
  { name: 'Local', path: '/local/2', diff: '**/api/local/2/diff' }
];

function feedback(id, line, source = 'user', end = line) {
  return {
    id, source, file: FILE, line_start: line, line_end: end, side: 'RIGHT',
    body: `Feedback ${id}`, status: 'active', is_file_level: 0,
    ...(source === 'ai' ? { type: 'bug', title: `Suggestion ${id}`, ai_level: null } : {})
  };
}

async function setup(page, mode, state) {
  const oldLines = Array.from({ length: 200 }, (_, index) => `// line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[99] = '// changed line 100';
  const diff = [
    `diff --git a/${FILE} b/${FILE}`, `--- a/${FILE}`, `+++ b/${FILE}`,
    '@@ -97,7 +97,7 @@',
    ...oldLines.slice(96, 99).map(line => ` ${line}`),
    `-${oldLines[99]}`, `+${newLines[99]}`,
    ...oldLines.slice(100, 103).map(line => ` ${line}`), ''
  ].join('\n');

  await page.route(mode.diff, route => route.fulfill({ json: {
    diff, changed_files: [{ file: FILE, additions: 1, deletions: 1 }],
    stats: { files_changed: 1, additions: 1, deletions: 1 }
  } }));
  await page.route('**/api/reviews/*/file-contents/**', route => route.fulfill({ json: {
    fileName: FILE, oldContents: oldLines.join('\n'), newContents: newLines.join('\n')
  } }));
  await page.route(/\/api\/reviews\/\d+\/comments(\?|$)/,
    route => route.fulfill({ json: { comments: state.comments } }));
  await page.route(/\/api\/reviews\/\d+\/suggestions(\?|$)/,
    route => route.fulfill({ json: { suggestions: state.suggestions } }));
  // An empty analysis history prevents the page from starting its own
  // suggestion load, so the explicit refresh below is the only writer.
  await page.route('**/api/analyses/runs*',
    route => route.fulfill({ json: { runs: [] } }));
  await page.route('**/api/local/2/check-stale',
    route => route.fulfill({ json: { isStale: false } }));
  await page.goto(mode.path);
  await waitForDiffToRender(page);
  // The history manager is created after the panel and initial comments load.
  await page.waitForFunction(() => !!window.prManager?.analysisHistoryManager);
  await page.evaluate(() => window.prManager.loadAISuggestions());
}

for (const mode of MODES) {
  test.describe(`Inline feedback context (${mode.name})`, () => {
    test('off-hunk comments remain visible when suggestions are refreshed', async ({ page }) => {
      const state = { comments: [feedback(9101, 20)], suggestions: [] };
      await setup(page, mode, state);
      await expect(inlineComment(page, 9101)).toBeVisible();

      state.suggestions = [feedback(9201, 180, 'ai')];
      await page.evaluate(() => window.prManager.loadAISuggestions());
      await expect(inlineSuggestion(page, 9201)).toBeVisible();
      await expect(inlineComment(page, 9101)).toBeVisible();

      // A second refresh must preserve the same two anchors without duplicates.
      await page.evaluate(() => window.prManager.loadAISuggestions());
      await expect(inlineSuggestion(page, 9201)).toHaveCount(1);
      await expect(inlineComment(page, 9101)).toBeVisible();
    });

    test('comments on manually expanded lines survive another off-hunk anchor', async ({ page }) => {
      const state = { comments: [], suggestions: [] };
      await setup(page, mode, state);
      // A manual expansion, as the expand control above the hunk makes it:
      // reveal the 85 lines above line 97 down to line 12.
      await ensureContentUpgrade(page, FILE);
      await expandHunkBy(page, FILE, { hunkIndex: 0, direction: 'up', lines: 85 });
      await expect.poll(() => isLineVisible(page, FILE, 85)).toBe(true);

      state.comments = [feedback(9102, 85), feedback(9103, 180)];
      await page.evaluate(() => window.prManager.loadUserComments());
      await expect(inlineComment(page, 9102)).toBeVisible();
      await expect(inlineComment(page, 9103)).toBeVisible();
    });

    test('expanding a preceding gap does not hide a suggestion after the hunk', async ({ page }) => {
      const state = { comments: [], suggestions: [] };
      await setup(page, mode, state);
      await ensureContentUpgrade(page, FILE);
      const hunk = await hunkContaining(page, FILE, 100);
      // The "down" direction reveals the END of the preceding gap. It must
      // not make lines following this hunk count as already visible.
      await expandHunkBy(page, FILE, { hunkIndex: hunk.index, direction: 'down', lines: 5 });
      const target = hunk.additionStart + hunk.additionCount + 1;

      state.suggestions = [feedback(9203, target, 'ai')];
      await page.evaluate(() => window.prManager.loadAISuggestions());
      await expect(inlineSuggestion(page, 9203)).toBeVisible();
      await expandReviewPanel(page);
      await page.locator('.ai-panel .finding-item[data-id="9203"]').click();
      await expect(inlineSuggestion(page, 9203)).toBeInViewport();
    });

    test('suggestions spanning a visible hunk and hidden endpoint render and navigate', async ({ page }) => {
      const state = { comments: [], suggestions: [feedback(9202, 100, 'ai', 150)] };
      await setup(page, mode, state);
      const suggestion = inlineSuggestion(page, 9202);
      await expect(suggestion).toBeVisible();
      await expect.poll(() => isLineVisible(page, FILE, 150)).toBe(true);

      // Put the base diff back on screen while the annotation and the record
      // of revealed ranges stay. Navigation must check the rows actually
      // rendered.
      await redisplayBaseDiff(page, FILE);
      await expect.poll(() => isLineVisible(page, FILE, 150)).toBe(false);
      await expect(suggestion).toBeHidden();

      // Collapse the file through the UI, then navigate to its range from
      // the sidebar to reveal the card again.
      const fileWrapper = page.locator(`.d2h-file-wrapper[data-file-name="${FILE}"]`);
      await fileWrapper.locator('.d2h-file-header').click();
      await expect(fileWrapper).toHaveClass(/collapsed/);
      await expect(suggestion).toBeHidden();
      // Use the actual sidebar click path to reveal the collapsed target again.
      await expandReviewPanel(page);

      // The invariant: navigation does not report completion (the scroll
      // helper returning) while the card it navigates to is still not
      // displayed. Revealing the range needs the diff worker when the result
      // is not already cached, so worker results are held back to open that
      // window, and a per-frame watcher records any frame in which the scroll
      // had completed while the card had no box.
      //
      // The card can also be displayed without any held result being
      // delivered (measured: 13 of 119 executions at four workers). Then there
      // is no window to observe; the watcher still must not record a
      // violation. An earlier form of this test asserted that the card stays
      // hidden for as long as the worker is held, which is not something the
      // application promises, and failed whenever that happened (about 2% of
      // executions at one worker).
      const hold = await holdWorkerResults(page);
      await page.evaluate((cardSelector) => {
        const scroll = window.ScrollUtils.scrollIntoViewStable;
        const cardDisplayed = () => {
          const card = document.querySelector(cardSelector);
          if (!card) return false;
          const r = card.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const gate = window.inlineNavigationGate = {
          started: false,
          completed: false,
          violation: false,
          stopped: false,
          cardDisplayed,
          restore() {
            gate.stopped = true;
            window.ScrollUtils.scrollIntoViewStable = scroll;
          }
        };
        window.ScrollUtils.scrollIntoViewStable = async (...args) => {
          gate.started = true;
          try {
            return await scroll(...args);
          } finally {
            gate.completed = true;
          }
        };
        const watch = () => {
          if (gate.stopped) return;
          if (gate.completed && !cardDisplayed()) gate.violation = true;
          requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
      }, `#diff-container .ai-suggestion[data-suggestion-id="9202"]`);
      try {
        await page.locator('.ai-panel .finding-item[data-id="9202"]').click();
        await expect(fileWrapper).not.toHaveClass(/collapsed/);

        // Wait until either the card is displayed, or the
        // worker has answered into the hold AND the scroll helper has started,
        // then let the helper's three-frame stability window pass several
        // times over. Frames, not a duration.
        const heldWithCardHidden = await page.evaluate(async () => {
          const gate = window.inlineNavigationGate;
          const workerArrived = window.__diffWorkerHold.arrived.then(() => 'worker');
          const displayed = new Promise((resolve) => {
            const check = () => (gate.cardDisplayed() ? resolve('displayed') : requestAnimationFrame(check));
            check();
          });
          if (await Promise.race([workerArrived, displayed]) === 'displayed') return false;
          await new Promise((resolve) => {
            const check = () => ((gate.started || gate.cardDisplayed()) ? resolve() : requestAnimationFrame(check));
            check();
          });
          for (let frame = 0; frame < 8; frame++) {
            await new Promise(requestAnimationFrame);
          }
          return !gate.cardDisplayed();
        });
        if (heldWithCardHidden) {
          // The window is open: the card is not displayed, so navigation must
          // still be in flight.
          expect(await page.evaluate(() => window.inlineNavigationGate.completed)).toBe(false);
        }
        await hold.release();
        await expect(suggestion).toBeInViewport();
        await expect.poll(() => page.evaluate(() => window.inlineNavigationGate.completed)).toBe(true);
        expect(await page.evaluate(() => window.inlineNavigationGate.violation)).toBe(false);
      } finally {
        await hold.release();
        await page.evaluate(() => {
          if (!window.inlineNavigationGate) return;
          window.inlineNavigationGate.restore();
          delete window.inlineNavigationGate;
        });
      }
    });
  });
}
