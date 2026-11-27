// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: context files (N5 of plans/codeview-virtualized-diff.md)
 *
 * A context file is a file outside the diff that is shown in the diff pane as
 * one or more line ranges: added by a chat link, a tour stop (for as long as
 * the tour lasts), or the server when a comment is saved on a file that is
 * not in the diff.
 *
 * This is a characterization of what main does today, in both modes, written
 * before the diff engine changes. Where context files render after the
 * migration was an open decision (D2), so nothing here names how a context
 * file is drawn: every read and click goes through tests/e2e/diff-dom.js
 * (`contextFileState`, `contextLine`, `expandContextGap`, ...). What the two
 * engines do differently is asked there too: the label of a hidden gap
 * (`contextGapLabel`), what a gap of five lines or fewer shows
 * (`expectedContextRanges`), and whether a file is in the pane
 * (`expectContextFile`: a virtualized viewer has no element for a file far
 * from the viewport). The position of a context file among the changed files
 * is `expectedPaneOrder`.
 *
 * Harness:
 *  - The context-files API is mocked with a small stateful route (list, add,
 *    extend, remove). The real POST route refuses a file that does not exist
 *    in the review's working directory, and the fixture reviews have none
 *    (PR mode points at an empty directory, Local mode at a missing one). The
 *    routes themselves are covered by integration tests; what is under test
 *    here is the frontend.
 *  - File contents come from the test server: `corpus-evict/context-long.js`
 *    is a registered 240-line file, any other path has 30 generic lines.
 *  - The server pushes `review:context_files_changed` over a WebSocket, which
 *    E2E does not have; the test dispatches the same DOM event the WebSocket
 *    client would.
 */

import { test, expect } from './fixtures.js';
import {
  waitForDiffToRender, cleanupAllComments, enableChat, mockViewedStateApi, mockContextFilesApi,
  mockAppConfig, mockHunkSummaries, mockTour, whenReviewEventsBound, setDiffView, seedComment, reloadComments
} from './helpers.js';
import {
  contextFile, expectContextFile, expectNoContextFile, contextFileState, contextLine, contextLineText,
  watchScrollRequests, scrollRequests, watchContextLines, contextLinesWatched, waitForDiffSettled,
  contextGapLabel, expectedContextRanges,
  expandContextGap, expandContextGapFully,
  openContextLineCommentForm, contextLineChatButton, expectedPaneOrder, filesInPane,
  fileWrapper, headerPosition, headerLanding, scrollState, waitForContentUpgrade, assertNoOrphanHosts, contextFileLayout,
  waitForDiffType, scrollFileIntoView, openLineCommentForm, setViewedBox
} from './diff-dom.js';

const MODES = [
  { name: 'PR mode', path: '/pr/test-owner/test-repo/1', reviewId: 1 },
  { name: 'Local mode', path: '/local/2', reviewId: 2 }
];

// The fixture diff, in the order the pane shows it.
const DIFF_FILES = ['src/main.js', 'src/utils.js'];

// Context files. Paths are chosen for where they sort among the diff files.
const LONG = 'corpus-evict/context-long.js'; // 240 lines; sorts before src/
const MIDDLE = 'src/notes.js';               // 30 lines; between main.js and utils.js
const LAST = 'zz/last.js';                   // 30 lines; after everything
const GONE = 'missing/gone.js';             // cannot be read (the test answers 404); sorts before src/
const LONG_LINES = 240;
const SHORT_LINES = 30;

/** Add a context range the way chat links and tour stops do. */
async function addContextRange(page, file, lineStart, lineEnd) {
  return page.evaluate(
    ({ f, s, e }) => window.prManager.ensureContextFile(f, s, e),
    { f: file, s: lineStart ?? null, e: lineEnd ?? null }
  );
}

/** What the server's push does in the page when the context files of this review changed. */
async function pushContextFilesChanged(page, reviewId) {
  await whenReviewEventsBound(page);
  await page.evaluate((rid) => {
    document.dispatchEvent(new CustomEvent('review:context_files_changed', { detail: { reviewId: rid } }));
  }, reviewId);
}

/** Sidebar entries, top to bottom: path and whether it is a context entry. */
async function sidebarEntries(page) {
  return page.locator('.file-item[data-path]').evaluateAll((items) => items.map((item) => ({
    file: item.dataset.path,
    kind: item.classList.contains('context-file-item') ? 'context' : 'diff',
    badge: (item.querySelector('.context-badge') || {}).textContent || null
  })));
}

const paneOrder = async (page) => (await filesInPane(page)).map(({ file, kind }) => ({ file, kind }));

for (const mode of MODES) {
  test.describe(`Context files (${mode.name})`, () => {
    let api;
    let viewedApi;

    test.beforeEach(async ({ page }) => {
      api = await mockContextFilesApi(page, { diffFiles: DIFF_FILES });
      viewedApi = await mockViewedStateApi(page);
      await page.route('**/api/local/2/check-stale', (route) => route.fulfill({ json: { isStale: false } }));
    });

    test.afterEach(async ({ page }) => {
      await cleanupAllComments(page, mode.reviewId);
    });

    async function open(page) {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForContentUpgrade(page, 'src/utils.js');
      await waitForContentUpgrade(page, 'src/main.js');
    }

    test('a range is rendered with its header, badge, lines and the gaps around it', async ({ page }) => {
      await open(page);
      const result = await addContextRange(page, LONG, 100, 120);
      expect(result.type).toBe('context');

      await expectContextFile(page, LONG);
      const state = await contextFileState(page, LONG);
      expect(state.header).toEqual({
        name: expect.stringContaining('context-long.js'),
        badge: 'CONTEXT',
        viewed: false,
        hasCommentButton: true,
        hasChatButton: true,
        hasDismissButton: true
      });
      expect(state.collapsed).toBe(false);
      expect(state.ranges).toEqual([{ start: 100, end: 120 }]);
      // Hidden lines above and below, each with one control in its direction.
      expect(state.gaps).toEqual([
        { kind: 'gap', hidden: 99, label: contextGapLabel(99), directions: ['up'] },
        { kind: 'gap', hidden: LONG_LINES - 120, label: contextGapLabel(LONG_LINES - 120), directions: ['down'] }
      ]);
      // The lines are the file's real lines.
      const text = await contextLineText(page, LONG, 100);
      expect(text.trim().length).toBeGreaterThan(0);
      // The request the frontend made.
      expect(api.requests.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([
        { file: LONG, line_start: 100, line_end: 120 }
      ]);
    });

    test('default ranges: no line gives 1-100, a single line gives a 21-line window around it', async ({ page }) => {
      await open(page);
      await addContextRange(page, LONG);
      expect((await contextFileState(page, LONG)).ranges).toEqual([{ start: 1, end: 100 }]);

      await addContextRange(page, MIDDLE, 15);
      // 15 - 10 = 5 .. 25. Four lines are hidden before it and five after:
      // what the pane shows there is the engine's small-gap rule.
      expect((await contextFileState(page, MIDDLE)).ranges)
        .toEqual(expectedContextRanges([{ start: 5, end: 25 }], SHORT_LINES));
    });

    test('a range that runs past the end of the file is shifted up to keep its size', async ({ page }) => {
      await open(page);
      // 30-line file, 21 lines asked for from line 25: shown as 10-30.
      await addContextRange(page, MIDDLE, 25, 45);
      const state = await contextFileState(page, MIDDLE);
      expect(state.ranges).toEqual([{ start: 10, end: SHORT_LINES }]);
      expect(state.gaps.map((g) => g.hidden)).toEqual([9]);
    });

    test('position among the changed files, and sidebar order', async ({ page }) => {
      await open(page);
      await addContextRange(page, MIDDLE, 5, 10);
      await addContextRange(page, LAST, 5, 10);
      await addContextRange(page, LONG, 5, 10);
      await expectContextFile(page, LONG);

      // In the pane.
      expect(await paneOrder(page)).toEqual(expectedPaneOrder(DIFF_FILES, [MIDDLE, LAST, LONG]));
      // Whatever the placement, context files are in path order among
      // themselves and the changed files keep their order.
      const pane = await paneOrder(page);
      expect(pane.filter((e) => e.kind === 'context').map((e) => e.file)).toEqual([LONG, MIDDLE, LAST]);
      expect(pane.filter((e) => e.kind === 'diff').map((e) => e.file)).toEqual(DIFF_FILES);

      // In the sidebar: always by path, context entries badged.
      expect(await sidebarEntries(page)).toEqual([
        { file: LONG, kind: 'context', badge: 'CONTEXT' },
        { file: 'src/main.js', kind: 'diff', badge: null },
        { file: MIDDLE, kind: 'context', badge: 'CONTEXT' },
        { file: 'src/utils.js', kind: 'diff', badge: null },
        { file: LAST, kind: 'context', badge: 'CONTEXT' }
      ]);
      await assertNoOrphanHosts(page);
    });

    test('context files stored for the review are rendered on load, in the same places', async ({ page }) => {
      api.add({ review_id: mode.reviewId, file: MIDDLE, line_start: 5, line_end: 10 });
      api.add({ review_id: mode.reviewId, file: LAST, line_start: 1, line_end: 8 });
      await open(page);

      await expectContextFile(page, MIDDLE);
      await expectContextFile(page, LAST);
      expect(await paneOrder(page)).toEqual(expectedPaneOrder(DIFF_FILES, [MIDDLE, LAST]));
      expect((await contextFileState(page, LAST)).ranges).toEqual([{ start: 1, end: 8 }]);
      // A range starting at line 1 has no gap above it.
      expect((await contextFileState(page, LAST)).gaps.map((g) => g.directions)).toEqual([['down']]);
    });

    test('two ranges of one file share a wrapper, in line order, with a separator', async ({ page }) => {
      await open(page);
      await addContextRange(page, LONG, 150, 160);
      await addContextRange(page, LONG, 20, 30);

      await expectContextFile(page, LONG);
      const state = await contextFileState(page, LONG);
      expect(state.ranges).toEqual([{ start: 20, end: 30 }, { start: 150, end: 160 }]);
      expect(state.separators).toBe(1);
      // One sidebar entry per range, both for the same file.
      const entries = (await sidebarEntries(page)).filter((e) => e.file === LONG);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries.every((e) => e.kind === 'context')).toBe(true);
    });

    test('an overlapping request extends the stored range instead of adding one', async ({ page }) => {
      await open(page);
      await addContextRange(page, LONG, 100, 120);
      const result = await addContextRange(page, LONG, 115, 140);
      expect(result).toMatchObject({ type: 'context', expanded: true });

      expect((await contextFileState(page, LONG)).ranges).toEqual([{ start: 100, end: 140 }]);
      expect(api.rows.filter((r) => r.file === LONG)).toHaveLength(1);
      expect(api.requests.filter((r) => r.method === 'PATCH').map((r) => r.body)).toEqual([
        { line_start: 100, line_end: 140 }
      ]);
      await expectContextFile(page, LONG);
    });

    test('a request inside a stored range adds nothing', async ({ page }) => {
      await open(page);
      await addContextRange(page, LONG, 100, 140);
      const before = api.requests.length;
      const result = await addContextRange(page, LONG, 110, 120);
      expect(result.type).toBe('context');
      expect(api.requests.slice(before).filter((r) => r.method !== 'GET')).toEqual([]);
      expect((await contextFileState(page, LONG)).ranges).toEqual([{ start: 100, end: 140 }]);
    });

    test('expanding the gap below and the gap above reveals 20 more lines each', async ({ page }) => {
      await open(page);
      await addContextRange(page, LONG, 100, 120);

      await expandContextGap(page, LONG, 1, 'down');
      await expect.poll(async () => (await contextFileState(page, LONG)).ranges).toEqual([{ start: 100, end: 140 }]);
      expect((await contextFileState(page, LONG)).gaps.map((g) => g.hidden)).toEqual([99, LONG_LINES - 140]);

      await expandContextGap(page, LONG, 0, 'up');
      await expect.poll(async () => (await contextFileState(page, LONG)).ranges).toEqual([{ start: 80, end: 140 }]);
      expect((await contextFileState(page, LONG)).gaps.map((g) => g.hidden)).toEqual([79, LONG_LINES - 140]);
    });

    test('expanding a gap fully removes it', async ({ page }) => {
      await open(page);
      await addContextRange(page, MIDDLE, 10, 20);
      expect((await contextFileState(page, MIDDLE)).gaps.map((g) => g.hidden)).toEqual([9, 10]);

      await expandContextGapFully(page, MIDDLE, 0);
      await expect.poll(async () => (await contextFileState(page, MIDDLE)).ranges).toEqual([{ start: 1, end: 20 }]);
      await expandContextGapFully(page, MIDDLE, 0);
      await expect.poll(async () => (await contextFileState(page, MIDDLE)).ranges).toEqual([{ start: 1, end: SHORT_LINES }]);
      expect((await contextFileState(page, MIDDLE)).gaps).toEqual([]);
    });

    test('a range added to a file after the reader expanded a gap in it: the expanded lines stay on screen throughout', async ({ page }) => {
      await open(page);
      await addContextRange(page, LONG, 100, 120);
      await expandContextGap(page, LONG, 1, 'down');
      await expect.poll(async () => (await contextFileState(page, LONG)).ranges).toEqual([{ start: 100, end: 140 }]);
      await expect(contextLine(page, LONG, 130)).toBeVisible();
      await waitForDiffSettled(page);

      // What a chat link or a tour stop elsewhere in the file does: one more
      // range of it. Every frame until the file shows it, the lines the
      // reader expanded by hand have their rows.
      await watchContextLines(page, LONG, [121, 130, 140]);
      const result = await addContextRange(page, LONG, 200, 210);
      expect(result.type).toBe('context');
      await expect.poll(async () => (await contextFileState(page, LONG)).ranges).toEqual([{ start: 100, end: 140 }, { start: 200, end: 210 }]);
      await expect(contextLine(page, LONG, 205)).toBeVisible();
      await waitForDiffSettled(page);
      const watched = await contextLinesWatched(page);
      expect(watched.frames).toBeGreaterThan(0);
      expect(watched.framesWithout).toEqual([]);

      // The file shows what it showed, and the new range: nothing else, and nothing twice.
      await expect(contextLine(page, LONG, 130)).toBeVisible();
      const state = await contextFileState(page, LONG);
      expect(state.ranges).toEqual([{ start: 100, end: 140 }, { start: 200, end: 210 }]);
      expect(state.separators).toBe(1);
      await assertNoOrphanHosts(page);
    });

    test('a comment on a context line is saved against that file and line and survives a reload', async ({ page }) => {
      await open(page);
      await addContextRange(page, MIDDLE, 5, 15);

      await openContextLineCommentForm(page, MIDDLE, 8);
      const body = `Context line comment ${Date.now()}`;
      await contextFile(page, MIDDLE).locator('.user-comment-form textarea').fill(body);
      await contextFile(page, MIDDLE).locator('.save-comment-btn').click();

      const card = contextFile(page, MIDDLE).locator('.user-comment-body', { hasText: body });
      await expect(card).toBeVisible();
      // It sits directly under line 8.
      const sequence = (await contextFileState(page, MIDDLE)).sequence;
      const lineIndex = sequence.findIndex((x) => x.kind === 'line' && x.line === 8);
      expect(sequence[lineIndex + 1].kind).toBe('card');

      const saved = await page.evaluate(async ({ rid, text }) => {
        const data = await (await fetch(`/api/reviews/${rid}/comments`)).json();
        return (data.comments || []).find((c) => c.body === text) || null;
      }, { rid: mode.reviewId, text: body });
      expect(saved).toMatchObject({ file: MIDDLE, line_start: 8, line_end: 8, side: 'RIGHT' });

      // The comment is counted like any other.
      await page.reload();
      await waitForDiffToRender(page);
      await expect(contextFile(page, MIDDLE).locator('.user-comment-body', { hasText: body })).toBeVisible();
      const after = (await contextFileState(page, MIDDLE)).sequence;
      const index = after.findIndex((x) => x.kind === 'line' && x.line === 8);
      expect(after[index + 1].kind).toBe('card');
    });

    test('the suggestion button on a context line fills the block with that line: in a stored range, in a gap small enough to be shown in full, and on a line the reader expanded', async ({ page }) => {
      await open(page);
      // 4-14 is stored. Lines 1-3 are a gap of three, which the file shows too.
      await addContextRange(page, MIDDLE, 4, 14);
      await expect.poll(async () => (await contextFileState(page, MIDDLE)).ranges)
        .toEqual(expectedContextRanges([{ start: 4, end: 14 }], SHORT_LINES));

      const blockOn = async (line) => {
        await waitForDiffSettled(page);
        const text = await contextLineText(page, MIDDLE, line);
        expect(text.trim()).not.toBe('');
        await openContextLineCommentForm(page, MIDDLE, line);
        const textarea = contextFile(page, MIDDLE).locator('.user-comment-form textarea');
        await expect(textarea).toBeVisible();
        // The form is the form of the line asked for.
        expect(await textarea.evaluate((el) => Number(el.dataset.line))).toBe(line);
        await contextFile(page, MIDDLE).locator('.user-comment-form .suggestion-btn').click();
        const value = await textarea.inputValue();
        await contextFile(page, MIDDLE).locator('.user-comment-form .cancel-comment-btn').click();
        await expect(page.locator('.user-comment-form')).toHaveCount(0);
        return { value, expected: `\`\`\`suggestion\n${text}\n\`\`\`` };
      };

      // A line of the stored range.
      let block = await blockOn(8);
      expect(block.value).toBe(block.expected);
      // A line of the small gap before it: in no stored range, on screen.
      block = await blockOn(2);
      expect(block.value).toBe(block.expected);
      // A line the reader expanded by hand (the gap after the range, 15-30, has 16 lines: one control shows it).
      await expandContextGapFully(page, MIDDLE, 0);
      await expect.poll(async () => (await contextFileState(page, MIDDLE)).ranges).toEqual([{ start: 1, end: SHORT_LINES }]);
      block = await blockOn(22);
      expect(block.value).toBe(block.expected);
    });

    test('a comment on a context line: the button, the form and the card say that it may not be posted on its line; in a changed file none of them does', async ({ page }) => {
      await open(page);
      await addContextRange(page, MIDDLE, 5, 15);
      await openContextLineCommentForm(page, MIDDLE, 8);
      // The button that opened the form.
      await expect(contextFile(page, MIDDLE).locator('.pierre-comment-btn').first())
        .toHaveAttribute('title', 'Add comment (expanded context - may not submit to GitHub)');
      // The form.
      const warning = contextFile(page, MIDDLE).locator('.user-comment-form .expanded-context-warning');
      await expect(warning).toBeVisible();
      await expect(warning).toHaveText('Warning: Expanded context line - may not submit to GitHub');
      expect(await warning.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('solid');
      const body = `Context indicator ${Date.now()}`;
      await contextFile(page, MIDDLE).locator('.user-comment-form textarea').fill(body);
      await contextFile(page, MIDDLE).locator('.save-comment-btn').click();
      const card = contextFile(page, MIDDLE).locator('.user-comment-row', { hasText: body });
      await expect(card).toBeVisible();
      const indicator = card.locator('.expanded-context-indicator');
      await expect(indicator).toBeVisible();
      await expect(indicator).toHaveAttribute('title', 'This expanded context comment will be posted to GitHub as a file-level comment');
      // Drawn, with a size and a colour of its own (the rule is in pr.css).
      const box = await indicator.boundingBox();
      expect(box.width).toBeGreaterThan(10);
      expect(await indicator.evaluate((el) => getComputedStyle(el).cursor)).toBe('help');

      // After a reload it is there again.
      await page.reload();
      await waitForDiffToRender(page);
      await expect(contextFile(page, MIDDLE).locator('.user-comment-row', { hasText: body }).locator('.expanded-context-indicator')).toBeVisible();

      // A comment on a line of a changed file has none, as on main.
      await seedComment(page, mode.reviewId, { file: 'src/utils.js', line: 5, body: 'In the diff' });
      await reloadComments(page);
      await scrollFileIntoView(page, 'src/utils.js');
      const inDiff = fileWrapper(page, 'src/utils.js').locator('.user-comment-row', { hasText: 'In the diff' });
      await expect(inDiff).toBeVisible();
      await expect(inDiff.locator('.expanded-context-indicator')).toHaveCount(0);
      await openLineCommentForm(page, { file: 'src/utils.js', line: 6 });
      await expect(fileWrapper(page, 'src/utils.js').locator('.user-comment-form')).toBeVisible();
      await expect(fileWrapper(page, 'src/utils.js').locator('.user-comment-form .expanded-context-warning')).toHaveCount(0);
      await expect(fileWrapper(page, 'src/utils.js').locator('.pierre-comment-btn').first()).toHaveAttribute('title', 'Add comment');
    });

    test('a comment whose line is outside the displayed range is still shown in the file', async ({ page }) => {
      // The server adds a context range when a comment is saved on a file
      // outside the diff. Model its result: a stored comment on line 22 and a
      // stored range that covers it, arriving by push while the page is open.
      await open(page);
      const body = `Auto-context comment ${Date.now()}`;
      await page.evaluate(async ({ rid, file, text }) => {
        const response = await fetch(`/api/reviews/${rid}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file, line_start: 22, line_end: 22, side: 'RIGHT', body: text })
        });
        if (!response.ok) throw new Error(`seeding the comment failed: ${response.status}`);
      }, { rid: mode.reviewId, file: MIDDLE, text: body });
      await expectNoContextFile(page, MIDDLE);

      api.add({ review_id: mode.reviewId, file: MIDDLE, line_start: 12, line_end: 30 });
      await pushContextFilesChanged(page, mode.reviewId);

      await expectContextFile(page, MIDDLE);
      await expect(contextFile(page, MIDDLE).locator('.user-comment-body', { hasText: body })).toBeVisible();
      const sequence = (await contextFileState(page, MIDDLE)).sequence;
      const lineIndex = sequence.findIndex((x) => x.kind === 'line' && x.line === 22);
      expect(sequence[lineIndex + 1].kind).toBe('card');
      expect(await paneOrder(page)).toEqual(expectedPaneOrder(DIFF_FILES, [MIDDLE]));
    });

    test('a file-level comment can be added from the context file header', async ({ page }) => {
      await open(page);
      await addContextRange(page, MIDDLE, 5, 15);
      const wrapper = contextFile(page, MIDDLE);

      await wrapper.locator('.file-header-comment-btn').click();
      const form = wrapper.locator('.file-comments-zone textarea');
      await expect(form).toBeVisible();
      const body = `Context file-level comment ${Date.now()}`;
      await form.fill(body);
      await wrapper.locator('.file-comments-zone .file-comment-form .submit-btn').click();
      await expect(wrapper.locator('.file-comments-zone', { hasText: body })).toBeVisible();
    });

    test('a context file whose path ends like a changed file\'s has its own comment zone: the header button opens a form in it', async ({ page }) => {
      // 'vendor/src/utils.js' ends in '/src/utils.js', a file of the diff. A
      // path lookup that accepts either form of a path must not hand the
      // context file the changed file's zone.
      const TWIN = 'vendor/src/utils.js';
      await open(page);
      await addContextRange(page, TWIN, 5, 15);
      await expectContextFile(page, TWIN);
      // It sorts after every changed file: bring it into the viewer's window.
      await scrollFileIntoView(page, TWIN);
      const wrapper = contextFile(page, TWIN);
      await expect(wrapper).toBeVisible();
      await waitForDiffSettled(page);
      // The scroll is animated, and scrollFileIntoView returns as soon as the
      // file shows. A click on a control that is still moving does not just
      // wait: from its second attempt on it scrolls the control somewhere
      // else itself (scrollIntoView with block 'end', then 'center', then
      // 'start'), here from the end of the pane to 364 px above it, and
      // presses at once. In the one frame after such a jump the files below a
      // file that is being drawn again are 39 to 45 px above their places; a
      // press in that frame is released over the pane, and no control gets
      // the click (10 of 3,798 runs, both modes). The file is the last and
      // short, so its scroll ends at the end of the pane: the click waits
      // for the pane to be there, and is then made once, on a control at rest.
      await expect.poll(async () => {
        const pane = await scrollState(page);
        return pane.height - pane.client - pane.top;
      }).toBeLessThan(1);

      await wrapper.locator('.file-header-comment-btn').click();
      const form = wrapper.locator('.file-comments-zone textarea');
      await expect(form).toBeVisible();
      await expect(fileWrapper(page, 'src/utils.js').locator('.file-comments-zone textarea')).toHaveCount(0);
      const body = `Twin context file-level comment ${Date.now()}`;
      await form.fill(body);
      await wrapper.locator('.file-comments-zone .file-comment-form .submit-btn').click();
      await expect(wrapper.locator('.file-comments-zone', { hasText: body })).toBeVisible();
      await expect(fileWrapper(page, 'src/utils.js').locator('.file-comments-zone', { hasText: body })).toHaveCount(0);
      const saved = await page.evaluate(async ({ rid, text }) => {
        const data = await (await fetch(`/api/reviews/${rid}/comments`)).json();
        return (data.comments || []).find((c) => c.body === text) || null;
      }, { rid: mode.reviewId, text: body });
      expect(saved).toMatchObject({ file: TWIN });
      // The page holds one zone for the file, however often it is asked.
      const zones = await page.evaluate((file) => {
        const seen = [];
        window.prManager.forEachFileCommentsZone((zone, name) => { if (name === file) seen.push(zone); });
        return { count: seen.length, same: window.prManager._ensureFileCommentsZone(file, { context: true }) === seen[0] };
      }, TWIN);
      expect(zones).toEqual({ count: 1, same: true });
    });

    test('the gutter chat control on a context line opens the chat panel', async ({ page }) => {
      await open(page);
      await enableChat(page);
      await addContextRange(page, MIDDLE, 5, 15);
      const row = contextLine(page, MIDDLE, 9);
      const chat = contextLineChatButton(page, MIDDLE, 9);
      // The gutter's controls are on the hovered line only and are hidden
      // while the pane moves. A click that finds the control still being
      // placed scrolls it into view again, which takes the line from under
      // the pointer: the gesture is made again from the hover, as
      // openContextLineCommentForm does for the comment control.
      await expect(async () => {
        await page.mouse.move(0, 0);
        await row.hover({ timeout: 2000 });
        await expect(chat).toBeVisible({ timeout: 2000 });
        await chat.click({ timeout: 2000 });
      }).toPass({ timeout: 20000 });
      await expect(page.locator('.chat-panel')).toBeVisible();
    });

    test('the header chat button opens the chat panel for that file', async ({ page }) => {
      await open(page);
      await enableChat(page);
      await addContextRange(page, MIDDLE, 5, 15);
      await contextFile(page, MIDDLE).locator('.file-header-chat-btn').click();
      await expect(page.locator('.chat-panel')).toBeVisible();
    });

    test('collapsing a context file hides its lines and leaves the changed files alone', async ({ page }) => {
      await open(page);
      await addContextRange(page, MIDDLE, 5, 15);
      const wrapper = contextFile(page, MIDDLE);

      await wrapper.locator('.d2h-file-header .d2h-file-name').click();
      await expect(wrapper).toHaveClass(/collapsed/);
      await expect(contextLine(page, MIDDLE, 8)).toBeHidden();
      await expect(fileWrapper(page, 'src/main.js')).not.toHaveClass(/collapsed/);
      await expect(fileWrapper(page, 'src/utils.js')).not.toHaveClass(/collapsed/);

      await wrapper.locator('.file-collapse-toggle').click();
      await expect(wrapper).not.toHaveClass(/collapsed/);
      await expect(contextLine(page, MIDDLE, 8)).toBeVisible();
    });

    test('marking a context file viewed collapses it, and it comes back viewed after a reload', async ({ page }) => {
      await open(page);
      await addContextRange(page, MIDDLE, 5, 15);
      const wrapper = contextFile(page, MIDDLE);

      await setViewedBox(wrapper);
      await expect(wrapper).toHaveClass(/collapsed/);
      // The sidebar shows the context entry as viewed, not a changed file.
      await expect(page.locator(`.file-item.context-file-item[data-path="${MIDDLE}"]`)).toHaveClass(/viewed/);
      await expect(page.locator('.file-item[data-path="src/main.js"]')).not.toHaveClass(/viewed/);
      // The state is stored under a key of its own, never the bare path a
      // changed file would use. PR mode saves through the API (wait for the
      // save, or the reload aborts it); Local mode writes localStorage.
      if (mode.reviewId === 1) {
        await expect.poll(() => viewedApi.files).toEqual([`context:${MIDDLE}`]);
      }

      await page.reload();
      await waitForDiffToRender(page);
      const reloaded = contextFile(page, MIDDLE);
      await expectContextFile(page, MIDDLE);
      await expect(reloaded).toHaveClass(/collapsed/);
      await expect(reloaded.locator('.file-viewed-checkbox')).toBeChecked();
      await expect(fileWrapper(page, 'src/main.js')).not.toHaveClass(/collapsed/);

      // Un-viewing expands it again. (Wait for PR mode's save: the page
      // closing under it at the end of the test is a failed fetch.)
      await setViewedBox(reloaded, false);
      await expect(reloaded).not.toHaveClass(/collapsed/);
      if (mode.reviewId === 1) {
        await expect.poll(() => viewedApi.files).toEqual([]);
      }
    });

    test('dismissing a context file removes every range of it, from the pane and the sidebar', async ({ page }) => {
      await open(page);
      await addContextRange(page, LONG, 20, 30);
      await addContextRange(page, LONG, 150, 160);
      await addContextRange(page, MIDDLE, 5, 15);

      await contextFile(page, LONG).locator('.context-file-dismiss').click();
      await expectNoContextFile(page, LONG);
      await expect(page.locator(`.file-item[data-path="${LONG}"]`)).toHaveCount(0);
      expect(api.rows.map((r) => r.file)).toEqual([MIDDLE]);
      expect(api.requests.filter((r) => r.method === 'DELETE')).toHaveLength(2);
      // The other context file and the changed files are untouched.
      await expectContextFile(page, MIDDLE);
      expect(await paneOrder(page)).toEqual(expectedPaneOrder(DIFF_FILES, [MIDDLE]));
    });

    test('a range removed elsewhere disappears on the next push', async ({ page }) => {
      await open(page);
      await addContextRange(page, MIDDLE, 5, 15);
      await addContextRange(page, LAST, 5, 15);
      await expectContextFile(page, LAST);

      api.rows.splice(api.rows.findIndex((r) => r.file === LAST), 1);
      await pushContextFilesChanged(page, mode.reviewId);
      await expectNoContextFile(page, LAST);
      await expectContextFile(page, MIDDLE);
      await expect(page.locator(`.file-item[data-path="${LAST}"]`)).toHaveCount(0);
    });

    test('the diff wins: a stored range for a file that is in the diff is not shown', async ({ page }) => {
      api.add({ review_id: mode.reviewId, file: 'src/utils.js', line_start: 1, line_end: 10 });
      api.add({ review_id: mode.reviewId, file: MIDDLE, line_start: 5, line_end: 10 });
      await open(page);

      await expectContextFile(page, MIDDLE);
      await expectNoContextFile(page, 'src/utils.js');
      await expect(fileWrapper(page, 'src/utils.js')).toHaveCount(1);
      expect((await sidebarEntries(page)).filter((e) => e.file === 'src/utils.js')).toEqual([
        { file: 'src/utils.js', kind: 'diff', badge: null }
      ]);
      // Asking for it reports that the file is in the diff, and adds nothing.
      const before = api.requests.length;
      expect(await addContextRange(page, 'src/utils.js', 1, 10)).toEqual({ type: 'diff' });
      expect(api.requests.slice(before)).toEqual([]);
    });

    test('clicking a context entry in the sidebar brings its header to the top of the diff', async ({ page }) => {
      await open(page);
      await addContextRange(page, LAST, 1, 30);
      await addContextRange(page, MIDDLE, 1, 30);
      await expectContextFile(page, LAST);

      await page.locator(`.file-item.context-file-item[data-path="${LAST}"]`).first().click();

      // Smooth scroll: poll for the settled landing. The header ends directly
      // under what is pinned above the diff (the toolbar), where a changed
      // file's header is pinned, or the diff is at its end.
      await expect.poll(async () => {
        // Null while the file has no header in the DOM (not scrolled to yet).
        if ((await headerPosition(page, LAST)) == null) return false;
        const landing = await headerLanding(page, LAST);
        const scroll = await scrollState(page);
        const atEnd = scroll.top + scroll.client >= scroll.height - 2;
        return atEnd || Math.abs(landing.belowPinned) <= 2;
      }, { timeout: 8000 }).toBe(true);
      await expect(contextFile(page, LAST).locator('.d2h-file-header')).toBeInViewport();
    });

    test('adding a context file above the one being read does not move it', async ({ page }) => {
      await open(page);
      await addContextRange(page, LAST, 1, 30);
      await page.locator(`.file-item.context-file-item[data-path="${LAST}"]`).first().click();
      await expect(contextLine(page, LAST, 12)).toBeInViewport();
      // Settle: the same position on two consecutive reads.
      let settled = null;
      await expect.poll(async () => {
        const box = await contextLine(page, LAST, 12).boundingBox();
        const same = settled != null && box != null && Math.abs(box.y - settled) < 0.5;
        settled = box ? box.y : null;
        return same;
      }, { timeout: 8000 }).toBe(true);
      const before = (await contextLine(page, LAST, 12).boundingBox()).y;

      // LONG and MIDDLE both sort above LAST.
      await addContextRange(page, LONG, 1, 100);
      await addContextRange(page, MIDDLE, 1, 30);
      await expectContextFile(page, LONG);
      await expectContextFile(page, MIDDLE);

      await expect.poll(async () => {
        const box = await contextLine(page, LAST, 12).boundingBox();
        return box ? Math.abs(box.y - before) : -1;
      }, { timeout: 5000 }).toBeLessThanOrEqual(1);
    });

    test('an AI suggestion on a context line is shown in the context file', async ({ page }) => {
      api.add({ review_id: mode.reviewId, file: MIDDLE, line_start: 5, line_end: 15 });
      await page.route(/\/api\/reviews\/\d+\/suggestions(\?|$)/, (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        return route.fulfill({ json: { suggestions: [{
          id: 9601, source: 'ai', file: MIDDLE, line_start: 9, line_end: 9, side: 'RIGHT',
          body: 'Suggestion on a context line', status: 'active', is_file_level: 0,
          type: 'bug', title: 'Context suggestion', ai_level: null
        }] } });
      });
      await page.route('**/api/analyses/runs*', (route) => route.fulfill({ json: { runs: [] } }));
      await open(page);
      await expectContextFile(page, MIDDLE);
      await page.waitForFunction(() => !!window.prManager?.analysisHistoryManager);
      await page.evaluate(() => window.prManager.loadAISuggestions());

      const card = contextFile(page, MIDDLE).locator('.ai-suggestion[data-suggestion-id="9601"]');
      await expect(card).toBeVisible();
      const sequence = (await contextFileState(page, MIDDLE)).sequence;
      const lineIndex = sequence.findIndex((x) => x.kind === 'line' && x.line === 9);
      expect(sequence[lineIndex + 1]).toMatchObject({ kind: 'card', suggestionId: '9601' });
    });

    test('in split layout a context file is still one column, as wide as the file', async ({ page }) => {
      await open(page);
      await addContextRange(page, MIDDLE, 5, 15);
      await expectContextFile(page, MIDDLE);
      const unified = await contextFileLayout(page, MIDDLE);
      expect(unified.columns).toBe(1);
      expect(Math.abs(unified.codeWidth - unified.fileWidth)).toBeLessThanOrEqual(1);

      await setDiffView(page, 'split');
      // A changed file with both sides is two columns now; the context file is not.
      await scrollFileIntoView(page, 'src/utils.js');
      await waitForDiffType(page, 'split', 5000, { fileName: 'src/utils.js' });
      await expect.poll(async () => (await contextFileLayout(page, MIDDLE))?.columns).toBe(1);
      const split = await contextFileLayout(page, MIDDLE);
      expect(Math.abs(split.codeWidth - split.fileWidth)).toBeLessThanOrEqual(1);
      expect(Math.abs(split.fileWidth - unified.fileWidth)).toBeLessThanOrEqual(1);
      // Its lines are the same lines.
      expect((await contextFileState(page, MIDDLE)).ranges)
        .toEqual(expectedContextRanges([{ start: 5, end: 15 }], SHORT_LINES));
    });

    test('a comment stored on the old side of a line is shown under that line of the context file', async ({ page }) => {
      // A comment made on a deleted line while the file was in the diff keeps
      // side LEFT when the file later leaves the diff and is shown as context.
      // A context file has one column of lines, numbered as the file is now.
      api.add({ review_id: mode.reviewId, file: MIDDLE, line_start: 5, line_end: 15 });
      await open(page);
      await expectContextFile(page, MIDDLE);
      const body = `Old-side comment ${Date.now()}`;
      await page.evaluate(async ({ rid, file, text }) => {
        const response = await fetch(`/api/reviews/${rid}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file, line_start: 9, line_end: 9, side: 'LEFT', body: text })
        });
        if (!response.ok) throw new Error(`seeding the comment failed: ${response.status}`);
        await window.prManager.loadUserComments();
      }, { rid: mode.reviewId, file: MIDDLE, text: body });

      await expect(contextFile(page, MIDDLE).locator('.user-comment-body', { hasText: body })).toBeVisible();
      const sequence = (await contextFileState(page, MIDDLE)).sequence;
      const lineIndex = sequence.findIndex((x) => x.kind === 'line' && x.line === 9);
      expect(sequence[lineIndex + 1].kind).toBe('card');
      const saved = await page.evaluate(async ({ rid, text }) => {
        const data = await (await fetch(`/api/reviews/${rid}/comments`)).json();
        return (data.comments || []).find((c) => c.body === text) || null;
      }, { rid: mode.reviewId, text: body });
      expect(saved).toMatchObject({ file: MIDDLE, line_start: 9, side: 'LEFT' });
    });

    test.describe('a stored range of a file that cannot be read', () => {
      // The application reports the read it could not make, and the browser
      // the 404 it got for it.
      test.use({ expectedConsoleErrors: [
        /\[console\.error\] (Failed to fetch file content|Failed to load resource: the server responded with a status of 404 .*\/file-content\/missing%2Fgone\.js)/
      ] });

      test('has a sidebar entry and nothing in the pane', async ({ page }) => {
        await page.route(/\/api\/reviews\/\d+\/file-content\/missing%2Fgone\.js/, (route) => route.fulfill({
          status: 404, json: { error: 'File not found' }
        }));
        api.add({ review_id: mode.reviewId, file: GONE, line_start: 1, line_end: 20 });
        api.add({ review_id: mode.reviewId, file: MIDDLE, line_start: 5, line_end: 15 });
        await open(page);

        // The file that can be read is there; the other one is not drawn.
        await expectContextFile(page, MIDDLE);
        await expectNoContextFile(page, GONE);
        expect(await paneOrder(page)).toEqual(expectedPaneOrder(DIFF_FILES, [MIDDLE]));
        // The sidebar lists both: the row is the review's.
        expect((await sidebarEntries(page)).filter((e) => e.kind === 'context')).toEqual([
          { file: GONE, kind: 'context', badge: 'CONTEXT' },
          { file: MIDDLE, kind: 'context', badge: 'CONTEXT' }
        ]);

        // Its entry has nothing to go to: the pane stays where it is.
        // "Nothing happens" is not waited for. The same click is then made
        // on the entry of the file that is there; the page handles the two
        // in their order, so when it has asked for that file to be scrolled
        // to, a request for the other one would be on record before it.
        const before = await scrollState(page);
        await watchScrollRequests(page);
        await page.locator(`.file-item.context-file-item[data-path="${GONE}"]`).first().click();
        expect((await scrollState(page)).top).toBe(before.top);
        await page.locator(`.file-item.context-file-item[data-path="${MIDDLE}"]`).first().click();
        await expect.poll(() => scrollRequests(page)).not.toEqual([]);
        expect([...new Set(await scrollRequests(page))]).toEqual([MIDDLE]);
        await expectNoContextFile(page, GONE);
      });
    });

    // -----------------------------------------------------------------------
    // Created by a tour stop
    // -----------------------------------------------------------------------

    const TOUR_STOPS = [
      { file_path: 'src/utils.js', side: 'RIGHT', line_start: 4, line_end: 4, title: 'In the diff', description: 'A stop on a changed file.' },
      { file_path: LONG, side: 'RIGHT', line_start: 100, line_end: 104, title: 'Outside the diff', description: 'A stop on a file the diff does not touch.' }
    ];
    const tourStop = (page, index) => page.locator(`.tour-annotation-row[data-stop-index="${index}"]`);

    async function openWithTour(page) {
      await mockAppConfig(page, { tours: { enabled: true } });
      await mockHunkSummaries(page, []);
      await mockTour(page, TOUR_STOPS);
      await open(page);
      await page.locator('#tour-toggle-btn').click();
      await expect(page.locator('.tour-bar .tour-bar__progress')).toHaveText('Stop 1 of 2');
      // The first stop is drawn in its file, and the tour has brought it
      // into view (with a context file above it, the stop's file can be
      // outside what a virtualized viewer had drawn).
      await expect(tourStop(page, 0)).toBeVisible();
    }
    const added = () => api.requests.filter((r) => r.method === 'POST').map((r) => r.body);
    const removed = () => api.requests.filter((r) => r.method === 'DELETE').map((r) => r.url);

    test('a tour stop outside the diff adds its file as a context file, and leaving the tour removes it', async ({ page }) => {
      await openWithTour(page);
      // Nothing is added until the stop is reached.
      expect(added()).toEqual([]);
      await expectNoContextFile(page, LONG);

      await page.locator('.tour-bar .tour-bar__next').click();
      await expect(page.locator('.tour-bar .tour-bar__progress')).toHaveText('Stop 2 of 2');

      // The file is there as a context file showing the stop's lines, where a context file goes.
      await expectContextFile(page, LONG);
      expect(added()).toEqual([expect.objectContaining({ file: LONG, line_start: 100, line_end: 104 })]);
      const state = await contextFileState(page, LONG);
      expect(state.header.badge).toBe('CONTEXT');
      expect(state.ranges).toEqual([{ start: 100, end: 104 }]);
      expect(await paneOrder(page)).toEqual(expectedPaneOrder(DIFF_FILES, [LONG]));
      expect((await sidebarEntries(page)).filter((e) => e.kind === 'context')).toEqual([{ file: LONG, kind: 'context', badge: 'CONTEXT' }]);

      // The stop is drawn in it, under its last line, and is in view.
      await expect(contextFile(page, LONG).locator('.tour-annotation-row')).toHaveCount(1);
      await expect(tourStop(page, 1)).toBeInViewport();
      await expect(tourStop(page, 1).locator('.tour-annotation-title')).toHaveText('Outside the diff');
      await expect(contextLine(page, LONG, 104)).toBeVisible();

      // Leaving the tour removes the stop, and the file the tour added: pane, sidebar and store.
      await page.keyboard.press('Escape');
      await expect(page.locator('.tour-bar')).toHaveCount(0);
      await expect(page.locator('.tour-annotation-row')).toHaveCount(0);
      await expectNoContextFile(page, LONG);
      await expect.poll(() => api.rows).toEqual([]);
      expect(removed()).toHaveLength(1);
      expect(await paneOrder(page)).toEqual(expectedPaneOrder(DIFF_FILES, []));
      expect((await sidebarEntries(page)).map((e) => e.file)).toEqual(DIFF_FILES);
      await assertNoOrphanHosts(page);
    });

    test('a push that arrives while the tour is adding a stop\'s file does not make the tour skip the stop or keep the file', async ({ page }) => {
      await openWithTour(page);
      // The requests for the review's context files are held from here on,
      // and let through one at a time, in the order this test chooses.
      const held = [];
      await page.route(/\/api\/reviews\/\d+\/context-files$/, (route) => {
        if (route.request().method() !== 'GET' || held.done) return route.fallback();
        return new Promise((release) => held.push({ request: route.request(), release: () => { release(); return route.fallback(); } }));
      });

      // The tour reaches the stop outside the diff: it adds the file and loads the context files ...
      await page.locator('.tour-bar .tour-bar__next').click();
      await expect.poll(() => held.length).toBe(1);
      expect(added()).toEqual([expect.objectContaining({ file: LONG, line_start: 100, line_end: 104 })]);
      // ... and before that load has its answer, a push starts a second one
      // (another client changed the review's context files, or the server
      // answered a comment on a file outside the diff).
      await pushContextFilesChanged(page, mode.reviewId);
      await expect.poll(() => held.length).toBe(2);

      // The tour's load is answered first, while the push's is still in flight.
      const first = held[0];
      const answered = page.waitForResponse((response) => response.request() === first.request);
      await first.release();
      await (await answered).finished();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      held.done = true;
      await held[1].release();

      // The stop is reached, not skipped, and drawn in the file the tour
      // added once. (Where the pane ends up is the scenario above's; here
      // the file is brought into view by the test.)
      await expect(page.locator('.tour-bar .tour-bar__progress')).toHaveText('Stop 2 of 2');
      await expectContextFile(page, LONG);
      expect(added()).toHaveLength(1);
      await scrollFileIntoView(page, LONG);
      await expect(contextFile(page, LONG).locator('.tour-annotation-row')).toHaveCount(1);
      await expect(tourStop(page, 1).locator('.tour-annotation-title')).toHaveText('Outside the diff');

      // Leaving the tour removes the file the tour added from the store ...
      await page.keyboard.press('Escape');
      await expect(page.locator('.tour-bar')).toHaveCount(0);
      await expect(page.locator('.tour-annotation-row')).toHaveCount(0);
      await expect.poll(() => api.rows).toEqual([]);
      expect(removed()).toHaveLength(1);
      // ... and from the pane and the sidebar.
      await expectNoContextFile(page, LONG);
      expect(await paneOrder(page)).toEqual(expectedPaneOrder(DIFF_FILES, []));
      expect((await sidebarEntries(page)).map((e) => e.file)).toEqual(DIFF_FILES);
      await assertNoOrphanHosts(page);
    });

    test('a context file that was there before the tour is used by the stop and stays when the tour ends', async ({ page }) => {
      api.add({ review_id: mode.reviewId, file: LONG, line_start: 90, line_end: 130 });
      await openWithTour(page);
      await expectContextFile(page, LONG);

      await page.locator('.tour-bar .tour-bar__next').click();
      await expect(page.locator('.tour-bar .tour-bar__progress')).toHaveText('Stop 2 of 2');
      // The tour brings the stop into view itself, wherever its file is.
      await expect(contextFile(page, LONG).locator('.tour-annotation-row')).toHaveCount(1);
      await expect(tourStop(page, 1)).toBeInViewport();
      // The stored range already covers the stop: nothing is added or changed.
      expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([]);

      await page.keyboard.press('Escape');
      await expect(page.locator('.tour-bar')).toHaveCount(0);
      await expect(page.locator('.tour-annotation-row')).toHaveCount(0);
      // The reader's own context file is not the tour's to remove.
      await expectContextFile(page, LONG);
      expect((await contextFileState(page, LONG)).ranges).toEqual([{ start: 90, end: 130 }]);
      expect(removed()).toEqual([]);
      expect(api.rows).toHaveLength(1);
    });
  });
}
