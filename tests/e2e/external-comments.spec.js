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

    // Click the per-comment chat-about button on the root.
    // (The reply also has one; we click the first which is the root.)
    const chatBtn = page.locator(
      '.external-comment-row .external-comment .btn-chat-comment.external-comment-chat-btn'
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

    // Author and a fragment of the body should be visible in the card
    await expect(contextCard).toContainText('reviewer-alice');
    await expect(contextCard).toContainText('Should this be');

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

    // Click the thread-level chat-about button
    const threadBtn = page.locator(
      '.external-comment-row .external-comment-thread-actions .btn-chat-thread'
    );
    await expect(threadBtn).toBeVisible();
    await threadBtn.click();

    const chatPanel = page.locator('.chat-panel');
    await expect(chatPanel).toBeVisible({ timeout: 5000 });

    // Thread context card has the thread modifier class
    const threadCard = page.locator(
      '.chat-panel__context-card.chat-panel__context-card--thread.external-comment-context'
    );
    await expect(threadCard).toBeVisible();

    // Both authors and both body fragments should be visible inside
    await expect(threadCard).toContainText('reviewer-alice');
    await expect(threadCard).toContainText('reviewer-bob');
    await expect(threadCard).toContainText('Should this be');
    await expect(threadCard).toContainText('Good catch');
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

    // Wait for the initial page-load sync to settle
    await page.waitForFunction(() => {
      // The pr.js code clears the is-refreshing class in the finally block
      const btn = document.getElementById('refresh-external-comments-btn');
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

    const refreshBtn = page.locator('#refresh-external-comments-btn');
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();

    await syncReq;
    expect(syncCallCount).toBeGreaterThan(initialSyncCount);

    // Refresh should clear the is-refreshing state once done
    await page.waitForFunction(() => {
      const btn = document.getElementById('refresh-external-comments-btn');
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

    // All three row types should be present
    expect(await page.locator('.ai-suggestion-row').count()).toBeGreaterThan(0);
    expect(await page.locator('.user-comment-row').count()).toBeGreaterThan(0);
    expect(await page.locator('.external-comment-row').count()).toBe(1);

    // Scope to the utils.js file wrapper and verify ordering on line 3:
    //   AI suggestion row  ->  user comment row  ->  external comment row
    // (CLAUDE.md hazard rule: AI -> user -> external.)
    // The d2h diff renderer uses `[data-file-name]` on multiple elements
    // (wrapper, comments-zone, every `<tr>`); the `.d2h-file-wrapper` is the
    // outer container that owns the actual diff table.
    const utilsFile = page.locator('.d2h-file-wrapper[data-file-name="src/utils.js"]');

    const orderedClasses = await utilsFile.evaluate((root) => {
      // Walk every tr in document order; record any of the three row types
      // we find. Filter the result down to the three types and check that
      // their relative order matches the contract.
      const rows = Array.from(root.querySelectorAll('tr'));
      return rows
        .filter((tr) =>
          tr.classList.contains('ai-suggestion-row') ||
          tr.classList.contains('user-comment-row') ||
          tr.classList.contains('external-comment-row')
        )
        .map((tr) => {
          if (tr.classList.contains('ai-suggestion-row')) return 'ai';
          if (tr.classList.contains('user-comment-row')) return 'user';
          return 'external';
        });
    });

    // The external row should appear after BOTH any preceding AI row and any
    // preceding user-comment row that targets the same line.
    const externalIdx = orderedClasses.indexOf('external');
    expect(externalIdx).toBeGreaterThan(-1);

    // Slice up to the external row — every AI/user row that comes before it
    // must be ai or user, never external (we've already checked there's only
    // one external row).
    const precedingTypes = orderedClasses.slice(0, externalIdx);
    expect(precedingTypes).toContain('ai');
    expect(precedingTypes).toContain('user');

    // Last preceding row of either type should not be 'external' (sanity).
    expect(precedingTypes.includes('external')).toBe(false);

    // External rendering did NOT remove the other rows — counts already
    // asserted above. Belt-and-suspenders: confirm the user + AI rows still
    // sit in this same file section.
    expect(await utilsFile.locator('.ai-suggestion-row').count()).toBeGreaterThan(0);
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
