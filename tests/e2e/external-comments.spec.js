// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: External (GitHub) PR Review Comments
 *
 * Exercises the end-to-end behavior of fetching, displaying, and chatting
 * about GitHub PR review comments rendered as blue `.external-comment-row`
 * cards in the diff view.
 *
 * Plan: plans/fetch-external-review-comments.md
 *
 * --- MOCKING STRATEGY ---------------------------------------------------
 * The shared test server (tests/e2e/test-server.js) does NOT wire the
 * external-comments routes. Rather than modifying that shared file, every
 * test in this spec intercepts the two endpoints at the network layer via
 * `page.route()`:
 *
 *   1. POST /api/reviews/:reviewId/external-comments/sync?source=github
 *      -> responds with a canned { count, lostAnchors, syncedAt } body and
 *         optionally bumps a per-test counter so we can assert sync fires.
 *
 *   2. GET  /api/reviews/:reviewId/external-comments?source=github
 *      -> responds with a thread-grouped payload that matches the shape
 *         the ExternalCommentRepository.listThreadsByReview() would emit
 *         in production.
 *
 * The shape (root comment + replies, with all column fields exposed) is
 * documented in plans/fetch-external-review-comments.md § 8 and
 * src/database.js (ExternalCommentRepository).
 *
 * This network-level approach lets the test pin every field that drives
 * the frontend (file, line_end, side, is_outdated, original_line_*,
 * source, author, body, external_url) without coupling to GitHub's
 * Octokit, the github-adapter mapping layer, or DB migrations.
 *
 * NOTE on PAIR_REVIEW_NO_OPEN: the worker server is spawned by Playwright
 * fixtures (tests/e2e/fixtures.js) which already runs headless and does
 * not call the `open` package. No env var setup is needed in this spec.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

// ---------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------

/**
 * Thread fixture: a root comment + one reply on src/utils.js line 3.
 * Mirrors the shape produced by ExternalCommentRepository.listThreadsByReview
 * for a GitHub PR review thread that has a single follow-up reply.
 */
const HAPPY_THREAD = {
  id: 101,
  source: 'github',
  external_id: '900001',
  in_reply_to_id: null,
  parent_id: null,
  external_url: 'https://github.com/test-owner/test-repo/pull/1#discussion_r900001',
  author: 'reviewer-alice',
  author_url: 'https://github.com/reviewer-alice',
  file: 'src/utils.js',
  side: 'RIGHT',
  line_start: 3,
  line_end: 3,
  diff_position: 4,
  commit_sha: 'def456head',
  is_outdated: 0,
  original_line_start: 3,
  original_line_end: 3,
  original_commit_sha: 'def456head',
  body: 'Should this be a `const`? Reassignment seems unlikely here.',
  external_created_at: '2025-10-01T12:00:00Z',
  synced_at: '2025-10-01T12:05:00Z',
  replies: [
    {
      id: 102,
      source: 'github',
      external_id: '900002',
      in_reply_to_id: '900001',
      parent_id: 101,
      external_url: 'https://github.com/test-owner/test-repo/pull/1#discussion_r900002',
      author: 'reviewer-bob',
      author_url: 'https://github.com/reviewer-bob',
      file: 'src/utils.js',
      side: 'RIGHT',
      line_start: 3,
      line_end: 3,
      diff_position: 4,
      commit_sha: 'def456head',
      is_outdated: 0,
      original_line_start: 3,
      original_line_end: 3,
      original_commit_sha: 'def456head',
      body: 'Good catch — let me make that change.',
      external_created_at: '2025-10-01T13:00:00Z',
      synced_at: '2025-10-01T13:05:00Z',
    },
  ],
};

/**
 * Outdated thread fixture: GitHub returned `position: null`, so the mapper
 * stored line_end = null and the renderer must fall back to original_line_end.
 * Anchored to src/main.js line 12 (original) — that line is in the new diff.
 */
const OUTDATED_THREAD = {
  id: 201,
  source: 'github',
  external_id: '900101',
  in_reply_to_id: null,
  parent_id: null,
  external_url: 'https://github.com/test-owner/test-repo/pull/1#discussion_r900101',
  author: 'reviewer-stale',
  author_url: null,
  file: 'src/main.js',
  side: 'RIGHT',
  line_start: null,
  line_end: null,
  diff_position: null,
  commit_sha: null,
  is_outdated: 1,
  original_line_start: 12,
  original_line_end: 12,
  original_commit_sha: 'olderbasesha',
  body: 'This block used to do something different.',
  external_created_at: '2025-09-01T08:00:00Z',
  synced_at: '2025-10-01T13:05:00Z',
  replies: [],
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Install network-level mocks for the two external-comment endpoints.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} opts
 * @param {Array<Object>} opts.threads - Threads returned by GET
 * @param {Function} [opts.onSync] - Optional callback fired on each POST sync.
 *                                   Receives the route's request object.
 */
async function installExternalCommentMocks(page, { threads, onSync } = {}) {
  const threadsList = Array.isArray(threads) ? threads : [];

  // NB: route handlers are processed last-registered-first in Playwright, so
  // we install the broader GET catcher FIRST and the narrower sync catcher
  // LAST. That way the sync handler "wins" for POSTs to /sync while the
  // catcher serves the GET threads list.
  await page.route('**/api/reviews/*/external-comments**', async (route) => {
    const req = route.request();
    // Defensive: pass through anything that isn't a GET for the threads list.
    // The sync handler installed below will normally intercept POSTs first.
    if (req.method() !== 'GET') {
      return route.continue();
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ threads: threadsList }),
    });
  });

  await page.route('**/api/reviews/*/external-comments/sync**', async (route) => {
    if (typeof onSync === 'function') {
      try { onSync(route.request()); } catch { /* keep mock alive */ }
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: threadsList.reduce((n, t) => n + 1 + (Array.isArray(t.replies) ? t.replies.length : 0), 0),
        lostAnchors: 0,
        syncedAt: new Date().toISOString(),
      }),
    });
  });
}

/**
 * Wait until the external-comment manager has finished its initial
 * fetch-and-render cycle. The manager calls `loadAndRender()` from
 * `_loadExternalComments` in pr.js after the diff is rendered; the row
 * appears in the DOM only after that resolves.
 */
async function waitForExternalRowsRendered(page) {
  await page.waitForFunction(() => {
    return !!document.querySelector('.external-comment-row, .external-comment');
  }, { timeout: 10000 });
}

/**
 * Enable chat in the test environment. Mirrors the helper in chat-lines.spec.js.
 * Without this, the chat panel is gated off by `[data-chat="disabled"]` CSS
 * (no Pi binary in E2E), so `chatPanel.open()` adds the `--open` class but
 * the container stays display:none.
 */
async function enableChat(page) {
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-chat', 'available');
    window.dispatchEvent(new CustomEvent('chat-state-changed', { detail: { state: 'available' } }));
  });
}

// ---------------------------------------------------------------------
// 1. Happy path render
// ---------------------------------------------------------------------

test.describe('External comments: happy path render', () => {
  test('renders a thread row with root + reply, GitHub source classes, and visible bodies', async ({ page }) => {
    await installExternalCommentMocks(page, { threads: [HAPPY_THREAD] });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await waitForExternalRowsRendered(page);

    // Exactly one external-comment-row for this thread
    const rows = page.locator('.external-comment-row');
    await expect(rows).toHaveCount(1);

    // Two .external-comment elements inside (root + reply)
    const row = rows.first();
    const comments = row.locator('.external-comment');
    await expect(comments).toHaveCount(2);

    // Root has source-github but NOT is-reply
    const root = comments.nth(0);
    await expect(root).toHaveClass(/source-github/);
    await expect(root).not.toHaveClass(/is-reply/);

    // Reply has both source-github AND is-reply
    const reply = comments.nth(1);
    await expect(reply).toHaveClass(/source-github/);
    await expect(reply).toHaveClass(/is-reply/);

    // Visible blue accent contract: we test the class hook the CSS variables
    // are bound to. Pixel-level color contracts shift; class contracts do
    // not (per CLAUDE.md test guidance).
    await expect(root).toHaveClass(/external-comment/);
    await expect(root).toHaveClass(/source-github/);

    // Both bodies render their text content. Markdown rendering may strip
    // backticks (they become <code> tags), so we assert on the surrounding
    // prose that is preserved verbatim.
    await expect(row).toContainText('Should this be a');
    await expect(row).toContainText('Reassignment seems unlikely');
    await expect(row).toContainText('Good catch');
  });
});

// ---------------------------------------------------------------------
// 2. Outdated badge
// ---------------------------------------------------------------------

test.describe('External comments: outdated rendering', () => {
  test('falls back to original_line_end and shows the outdated badge', async ({ page }) => {
    await installExternalCommentMocks(page, { threads: [OUTDATED_THREAD] });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await waitForExternalRowsRendered(page);

    // The row should exist (anchored to original_line_end = 12)
    const rows = page.locator('.external-comment-row');
    await expect(rows).toHaveCount(1);

    // is-outdated class is applied to the comment element
    const outdatedComment = rows.first().locator('.external-comment.is-outdated');
    await expect(outdatedComment).toHaveCount(1);

    // Outdated badge present
    const badge = rows.first().locator('.external-comment-outdated-badge');
    await expect(badge).toBeVisible();

    // Anchored to original_line_end (12) — verify the row appears within the
    // src/main.js file wrapper rather than utils.js. The d2h diff renderer
    // sets `data-file-name` on multiple elements (wrapper + each tr); pin
    // the assertion to the `.d2h-file-wrapper` to avoid a strict-mode hit.
    const mainFileSection = page.locator('.d2h-file-wrapper[data-file-name="src/main.js"]');
    const externalRowInMain = mainFileSection.locator('.external-comment-row');
    await expect(externalRowInMain).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------
// 3. Chat about a single external comment
// ---------------------------------------------------------------------

test.describe('External comments: chat about a single comment', () => {
  test('opens the chat panel with an external-comment context card', async ({ page }) => {
    await installExternalCommentMocks(page, { threads: [HAPPY_THREAD] });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await enableChat(page);
    await waitForExternalRowsRendered(page);

    // Click the per-comment chat-about button on a reply. (The root's
    // button opens a thread chat; only replies open a single-comment chat.)
    const chatBtn = page.locator(
      '.external-comment-row .external-comment.is-reply .btn-chat-comment.external-comment-chat-btn'
    ).first();
    await expect(chatBtn).toBeVisible();
    await chatBtn.click();

    // Chat panel becomes visible
    const chatPanel = page.locator('.chat-panel');
    await expect(chatPanel).toBeVisible({ timeout: 5000 });

    // The compact context card carries the external-comment classes.
    // ChatPanel._addCommentContextCard builds: chat-panel__context-card +
    // external-comment-context + source-github when ctx.source === 'external'.
    const contextCard = page.locator(
      '.chat-panel__context-card.external-comment-context.source-github'
    );
    await expect(contextCard).toBeVisible();

    // Author and a fragment of the reply body should be visible in the card
    await expect(contextCard).toContainText('reviewer-bob');
    await expect(contextCard).toContainText('Good catch');

    // Do NOT send a message — that would require running an AI provider.
  });
});

// ---------------------------------------------------------------------
// 4. Chat about a whole thread
// ---------------------------------------------------------------------

test.describe('External comments: chat about thread', () => {
  test('opens the chat panel with a thread context card containing both comments', async ({ page }) => {
    await installExternalCommentMocks(page, { threads: [HAPPY_THREAD] });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await enableChat(page);
    await waitForExternalRowsRendered(page);

    // The thread root's chat button opens a chat about the whole thread.
    // (`.first()` skips reply buttons.)
    const threadBtn = page.locator(
      '.external-comment-row .external-comment:not(.is-reply) .btn-chat-comment.external-comment-chat-btn'
    ).first();
    await expect(threadBtn).toBeVisible();
    await threadBtn.click();

    const chatPanel = page.locator('.chat-panel');
    await expect(chatPanel).toBeVisible({ timeout: 5000 });

    // Compact thread context card carries the source-specific theming class.
    const threadCard = page.locator(
      '.chat-panel__context-card.external-comment-context.source-github'
    );
    await expect(threadCard).toBeVisible();

    // The visible row shows the "GITHUB THREAD" label and the comment count.
    await expect(threadCard).toContainText('GITHUB THREAD');
    await expect(threadCard).toContainText(/\d+ comment/);

    // Full content lives in the title tooltip (single line + hover, per UX).
    const tooltip = await threadCard.getAttribute('title');
    expect(tooltip).toContain('reviewer-alice');
    expect(tooltip).toContain('reviewer-bob');
    expect(tooltip).toContain('Should this be');
    expect(tooltip).toContain('Good catch');
  });
});

// ---------------------------------------------------------------------
// 5. Refresh button
// ---------------------------------------------------------------------

test.describe('External comments: manual refresh', () => {
  test('refresh button briefly disables, fires a new sync, and does not duplicate rows', async ({ page }) => {
    let syncCallCount = 0;
    await installExternalCommentMocks(page, {
      threads: [HAPPY_THREAD],
      onSync: () => { syncCallCount++; },
    });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await waitForExternalRowsRendered(page);

    // Wait for the initial page-load sync to settle. The refresh button
    // lives in the AI panel header; expand the panel so the button is in a
    // visible region for click + interaction.
    await page.evaluate(() => window.aiPanel?.expand());
    await page.waitForFunction(() => {
      // The pr.js code clears the is-refreshing class in the finally block
      const btn = document.getElementById('refresh-external-comments-btn-panel');
      return btn && !btn.classList.contains('is-refreshing') && !btn.disabled;
    }, { timeout: 10000 });

    const initialRowCount = await page.locator('.external-comment-row').count();
    expect(initialRowCount).toBe(1);

    const initialSyncCount = syncCallCount;
    expect(initialSyncCount).toBeGreaterThanOrEqual(1);

    // Click the refresh button. Use a request-wait to confirm the new sync
    // POST is fired by the click itself.
    const syncReq = page.waitForRequest(
      (req) => /\/api\/reviews\/[^/]+\/external-comments\/sync/.test(req.url())
               && req.method() === 'POST',
      { timeout: 5000 }
    );

    const refreshBtn = page.locator('#refresh-external-comments-btn-panel');
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();

    await syncReq;
    expect(syncCallCount).toBeGreaterThan(initialSyncCount);

    // Refresh should clear the is-refreshing state once done
    await page.waitForFunction(() => {
      const btn = document.getElementById('refresh-external-comments-btn-panel');
      return btn && !btn.classList.contains('is-refreshing') && !btn.disabled;
    }, { timeout: 10000 });

    // Same dataset returned — exactly one row, no duplicates
    await expect(page.locator('.external-comment-row')).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------
// 6. Coexistence with user comments + AI suggestions on the same diff line
// ---------------------------------------------------------------------

test.describe('External comments: coexistence with user + AI rows', () => {
  test('AI / user / external rows all render on the same line in the right order', async ({ page }) => {
    await installExternalCommentMocks(page, { threads: [HAPPY_THREAD] });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed an AI suggestion on src/utils.js line 3 by hitting the mock
    // analyses endpoint, which inserts mockAISuggestions into the DB. The
    // existing seed includes suggestion id 1001 anchored to utils.js line 3.
    await page.evaluate(async () => {
      const res = await fetch('/api/pr/test-owner/test-repo/1/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return res.ok;
    });

    // Seed a user comment on src/utils.js line 3 via the normal comments API.
    // Reading the current pr-manager's review id keeps us in sync with whatever
    // the test server assigned (id=1 in the standard seed).
    await page.evaluate(async () => {
      const reviewId = window.prManager?.currentPR?.id || 1;
      await fetch(`/api/reviews/${reviewId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: 'src/utils.js',
          line_start: 3,
          line_end: 3,
          side: 'RIGHT',
          body: 'User note on line 3.',
        }),
      });
    });

    // Reload to force all three managers (AI suggestions, user comments,
    // external comments) to render together.
    await page.reload();
    await waitForDiffToRender(page);
    await waitForExternalRowsRendered(page);

    // Wait for user-comment rows too (loadUserComments fires async).
    await page.waitForSelector('.user-comment-row', { timeout: 10000 });

    // All three row types should be present. On the @pierre/diffs branch AI
    // suggestions slot as a light-DOM `.ai-suggestion` card (the legacy
    // `.ai-suggestion-row` <tr> wrapper is gone — PierreBridge extracts and
    // slots the inner `.ai-suggestion` div), while user comments and external
    // threads keep their `.user-comment-row` / `.external-comment-row` wrappers.
    expect(await page.locator('.ai-suggestion').count()).toBeGreaterThan(0);
    expect(await page.locator('.user-comment-row').count()).toBeGreaterThan(0);
    expect(await page.locator('.external-comment-row').count()).toBe(1);

    // Scope to the utils.js file wrapper and verify ordering on line 3:
    //   AI suggestion  ->  user comment  ->  external comment
    // (CLAUDE.md hazard rule: AI -> user -> external.)
    // On the @pierre/diffs branch all three overlays render as light-DOM
    // annotations slotted below the anchor line (not `<tr>` rows), and
    // PierreBridge's typeOrder sorts them suggestion -> comment -> external.
    // The three managers (suggestions, comments, external) load and render
    // independently and asynchronously, and each addAnnotation/clear triggers a
    // FileDiff rerender that transiently rebuilds the slotted set — so a
    // one-shot scan can catch an intermediate state where one overlay is
    // momentarily absent. Poll the scan until the contract holds; once all
    // three managers have settled the ordering is stable.
    const utilsFile = page.locator('.d2h-file-wrapper[data-file-name="src/utils.js"]');

    const scanOrder = () => utilsFile.evaluate((root) => {
      // Walk every overlay in document order; record its type.
      const rows = Array.from(root.querySelectorAll(
        '.ai-suggestion, .user-comment-row, .external-comment-row'
      ));
      return rows.map((el) => {
        if (el.classList.contains('ai-suggestion')) return 'ai';
        if (el.classList.contains('user-comment-row')) return 'user';
        return 'external';
      });
    });

    // Poll until AI + user rows both precede the (single) external row.
    await expect.poll(async () => {
      const order = await scanOrder();
      const extIdx = order.indexOf('external');
      if (extIdx < 0) return 'no-external';
      const preceding = order.slice(0, extIdx);
      if (preceding.includes('external')) return 'external-before-external';
      return preceding.includes('ai') && preceding.includes('user') ? 'ok' : 'not-settled';
    }, { timeout: 10000 }).toBe('ok');

    // Final stable snapshot for the remaining structural assertions.
    const orderedClasses = await scanOrder();
    const externalIdx = orderedClasses.indexOf('external');
    const precedingTypes = orderedClasses.slice(0, externalIdx);
    // External sits below both AI and user overlays, and no external row
    // precedes it (there is only one).
    expect(precedingTypes).toContain('ai');
    expect(precedingTypes).toContain('user');
    expect(precedingTypes.includes('external')).toBe(false);

    // External rendering did NOT remove the other rows — confirm the user + AI
    // overlays still sit in this same file section.
    expect(await utilsFile.locator('.ai-suggestion').count()).toBeGreaterThan(0);
    expect(await utilsFile.locator('.user-comment-row').count()).toBeGreaterThan(0);
  });
});

// Local-mode coverage lives in tests/unit/pr-external-comments-wiring.test.js:
// "local mode short-circuits: no fetch, no syncAndRender, no reviewId mutation".
// That unit test sets `window.PAIR_REVIEW_LOCAL_MODE = true`, calls
// `_loadExternalComments` directly, and asserts no fetch, no syncAndRender, no
// loadAndRender, and no reviewId mutation. The earlier E2E variants of this
// test were either trivial (loading /local/:id never instantiated the
// external-comment manager, so the guard wasn't actually exercised) or
// broken (loading /pr/... with LOCAL_MODE injected made PRManager skip
// init() entirely, so waitForDiffToRender timed out and the guard still
// wasn't reached). The unit-level coverage is strictly stronger; no E2E
// equivalent here.

// ---------------------------------------------------------------------
// 7. External segment in the Review (AI) panel
//
// Asserts the fourth segment exists, populates with one row per thread,
// shows the correct count, and routes clicks back to the inline external
// row in the diff. Mocking is the same as the rest of this spec.
// ---------------------------------------------------------------------

test.describe('External segment in Review panel', () => {
  test('renders the External segment button with a per-thread count', async ({ page }) => {
    await installExternalCommentMocks(page, { threads: [HAPPY_THREAD] });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await waitForExternalRowsRendered(page);

    // Expand the panel so segment buttons are interactable; the default
    // for a new review is collapsed.
    await page.evaluate(() => window.aiPanel?.expand());

    const externalBtn = page.locator('.segment-btn[data-segment="external"]');
    await expect(externalBtn).toBeVisible();

    // Count badge should be (1) — one thread, regardless of reply count.
    const count = externalBtn.locator('.segment-count');
    await expect(count).toHaveText('(1)');
  });

  test('clicking the External segment activates it and shows one list item per thread', async ({ page }) => {
    // Two threads on different lines so we can verify "one item per thread"
    const secondThread = {
      ...HAPPY_THREAD,
      id: 102,
      external_id: '900003',
      external_url: 'https://github.com/test-owner/test-repo/pull/1#discussion_r900003',
      file: 'src/main.js',
      line_start: 12,
      line_end: 12,
      original_line_start: 12,
      original_line_end: 12,
      body: 'A second thread on main.js',
      replies: [],
    };
    await installExternalCommentMocks(page, { threads: [HAPPY_THREAD, secondThread] });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await waitForExternalRowsRendered(page);

    await page.evaluate(() => window.aiPanel?.expand());

    const externalBtn = page.locator('.segment-btn[data-segment="external"]');
    await externalBtn.click();
    await expect(externalBtn).toHaveClass(/active/);

    const items = page.locator('.ai-panel__list-item--external');
    await expect(items).toHaveCount(2);

    // Each item has the source-github class (blue accent contract)
    for (let i = 0; i < 2; i++) {
      await expect(items.nth(i)).toHaveClass(/source-github/);
    }

    // Locate items by thread id rather than position — the panel sorts by
    // file order which depends on the diff fixture and is not the spec's
    // contract here.
    const happyItem = items.locator('[data-thread-id="101"]').or(
      page.locator('.ai-panel__list-item--external[data-thread-id="101"]')
    ).first();
    // Total comments badge: root + replies. The happy thread has 1 root +
    // 1 reply = 2. Always present (replaces the prior author dot).
    const totalBadge = happyItem.locator('.external-list-count');
    await expect(totalBadge).toBeVisible();
    await expect(totalBadge).toHaveText('2');

    // The second thread (no replies) shows "1" — the root comment itself.
    const secondItem = page.locator('.ai-panel__list-item--external[data-thread-id="102"]');
    await expect(secondItem.locator('.external-list-count')).toHaveText('1');
  });

  test('clicking a list item scrolls the inline external-comment-row into view and flashes it', async ({ page }) => {
    await installExternalCommentMocks(page, { threads: [HAPPY_THREAD] });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await waitForExternalRowsRendered(page);

    await page.evaluate(() => window.aiPanel?.expand());

    // Activate the External segment first
    const externalBtn = page.locator('.segment-btn[data-segment="external"]');
    await externalBtn.click();

    const listItem = page.locator('.ai-panel__list-item--external').first();
    await expect(listItem).toBeVisible();
    await listItem.click();

    // The matching inline row picks up the .external-comment-row--focused
    // class. The class is removed after ~2 seconds, so assert quickly.
    const focusedRow = page.locator('.external-comment-row--focused');
    await expect(focusedRow).toHaveCount(1, { timeout: 1500 });
  });

  test('refreshing external comments updates the External segment count', async ({ page }) => {
    // First load: one thread. After clicking refresh we'll swap in a fixture
    // with two threads to verify the count updates.
    let threads = [HAPPY_THREAD];
    await page.route('**/api/reviews/*/external-comments?**', async (route) => {
      if (route.request().method() !== 'GET') {
        return route.continue();
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ threads }),
      });
    });
    await page.route('**/api/reviews/*/external-comments/sync**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: threads.length, lostAnchors: 0, syncedAt: new Date().toISOString() }),
      });
    });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await waitForExternalRowsRendered(page);

    await page.evaluate(() => window.aiPanel?.expand());

    const externalCount = page.locator('.segment-btn[data-segment="external"] .segment-count');
    await expect(externalCount).toHaveText('(1)');

    // Swap fixture and trigger a refresh
    threads = [
      HAPPY_THREAD,
      {
        ...HAPPY_THREAD,
        id: 999,
        external_id: '900099',
        file: 'src/main.js',
        line_start: 12,
        line_end: 12,
        original_line_start: 12,
        original_line_end: 12,
        body: 'New thread after refresh',
        replies: [],
      },
    ];
    await page.locator('#refresh-external-comments-btn-panel').click();

    // Wait for the panel to reflect the new count
    await expect(externalCount).toHaveText('(2)', { timeout: 5000 });
  });
});

// ---------------------------------------------------------------------
// 8. Local-mode: External segment button is hidden
//
// Local reviews never have an external source — the button should be
// absent from the visible UI. Asserted at the visibility layer (not just
// the `[hidden]` attribute) so the assertion stays accurate if a future
// rule swaps the gate to display:none.
// ---------------------------------------------------------------------

test.describe('Local mode: External segment hidden', () => {
  test('External segment button is not visible on /local pages', async ({ page }) => {
    await page.goto('/local/2');
    await waitForDiffToRender(page);
    await page.evaluate(() => window.aiPanel?.expand());

    const externalBtn = page.locator('.segment-btn[data-segment="external"]');
    // Either absent from the DOM or hidden via [hidden]/display:none.
    await expect(externalBtn).toBeHidden();

    // The other three segments must still be visible — no collateral
    // damage from the gating logic.
    await expect(page.locator('.segment-btn[data-segment="ai"]')).toBeVisible();
    await expect(page.locator('.segment-btn[data-segment="comments"]')).toBeVisible();
    await expect(page.locator('.segment-btn[data-segment="all"]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------
// 9. Segment overflow scroll chevrons
//
// When the AI panel is narrow enough that the four segment buttons
// can't fit, chevrons appear on the left/right and scroll the row
// horizontally. We narrow the panel via JS rather than the viewport so
// the test is robust against future layout changes outside the panel.
// ---------------------------------------------------------------------

test.describe('Review panel segment overflow scroll', () => {
  // Helper: shrink the AI panel container so the four segment buttons
  // overflow their scroll container, forcing the chevrons to appear.
  async function shrinkPanel(page) {
    await page.evaluate(() => {
      // Drop the CSS variable that drives panel width; also force inline
      // width on the panel root in case the variable is consumed elsewhere.
      document.documentElement.style.setProperty('--ai-panel-width', '120px');
      const panel = document.getElementById('ai-panel');
      if (panel) panel.style.width = '120px';
      window.aiPanel?.updateSegmentScrollChevrons?.();
    });
  }

  test('shows a right chevron when segment buttons overflow the panel width', async ({ page }) => {
    await installExternalCommentMocks(page, { threads: [HAPPY_THREAD] });
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await waitForExternalRowsRendered(page);
    await page.evaluate(() => window.aiPanel?.expand());

    // Narrow the panel so the inner segment row has to overflow its
    // scroll container. The chevrons sit outside the scroll container
    // so they still consume some space — 120px guarantees overflow.
    await shrinkPanel(page);

    const rightChevron = page.locator('#segment-scroll-right');
    await expect(rightChevron).toBeVisible({ timeout: 2000 });

    // Left chevron starts hidden because we're at scrollLeft = 0
    const leftChevron = page.locator('#segment-scroll-left');
    await expect(leftChevron).toBeHidden();
  });

  test('clicking the right chevron increases scrollLeft of the segment row', async ({ page }) => {
    await installExternalCommentMocks(page, { threads: [HAPPY_THREAD] });
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await waitForExternalRowsRendered(page);
    await page.evaluate(() => window.aiPanel?.expand());

    await shrinkPanel(page);

    const initialScroll = await page.evaluate(() =>
      document.getElementById('segment-control-scroll').scrollLeft
    );
    expect(initialScroll).toBe(0);

    await page.locator('#segment-scroll-right').click();

    // Smooth scroll completes asynchronously — poll briefly.
    await page.waitForFunction(
      () => document.getElementById('segment-control-scroll').scrollLeft > 0,
      { timeout: 2000 }
    );

    const newScroll = await page.evaluate(() =>
      document.getElementById('segment-control-scroll').scrollLeft
    );
    expect(newScroll).toBeGreaterThan(0);
  });

  test('chevrons are hidden when segment buttons fit', async ({ page }) => {
    await installExternalCommentMocks(page, { threads: [HAPPY_THREAD] });
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await waitForExternalRowsRendered(page);
    await page.evaluate(() => window.aiPanel?.expand());

    // Widen the panel container generously so the four short labels are
    // guaranteed to fit. The default panel width depends on the saved
    // resizer preference, which is not the contract being tested here.
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--ai-panel-width', '600px');
      const panel = document.getElementById('ai-panel');
      if (panel) panel.style.width = '600px';
      window.aiPanel?.updateSegmentScrollChevrons?.();
    });

    await expect(page.locator('#segment-scroll-left')).toBeHidden();
    await expect(page.locator('#segment-scroll-right')).toBeHidden();
  });
});
