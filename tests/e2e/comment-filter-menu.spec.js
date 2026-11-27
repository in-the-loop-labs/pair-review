// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: comment panel filter menu (issue #610)
 *
 * The funnel at the right of the segment row opens labeled "Show dismissed"
 * and "Show posted" options; a notice at the end of the user comment list
 * counts the comments they hide and can turn them on. The same menu sorts and
 * filters AI suggestions by severity (panel only; the diff keeps every suggestion).
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender, expandReviewPanel } from './helpers.js';

const COMMENTS_URL = /\/api\/reviews\/\d+\/comments(\?|$)/;

/**
 * Serve the given user comments for the review (GETs only). Mocked rather than
 * seeded because the per-worker DB is shared across tests, and a posted
 * comment can only be made by submitting a review to GitHub.
 */
async function mockUserComments(page, comments) {
  await page.route(COMMENTS_URL, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, comments })
    });
  });
}

function fileComment(id, status, body) {
  return { id, status: status === 'submitted' ? 'active' : status,
    publication: status === 'submitted' ? { state: 'posted' } : null,
    body, file: 'src/utils.js', is_file_level: 1, line_start: null, side: 'RIGHT', type: 'comment' };
}

async function openUserSegment(page) {
  await expandReviewPanel(page);
  const userSegment = page.locator('.segment-btn[data-segment="comments"]');
  await userSegment.click();
  await expect(userSegment).toHaveClass(/active/);
}

const SUGGESTIONS_URL = /\/api\/reviews\/\d+\/suggestions(\?|$)/;

function aiSuggestion(id, severity, file, line, title) {
  return { id, source: 'ai', ai_run_id: 'severity-run', ai_level: null, file,
    line_start: line, line_end: line, type: severity ? 'bug' : 'praise', title,
    body: `${title} body`, status: 'active', ...(severity ? { severity } : {}),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}

// 9301 minor and 9302 critical share a file, so file order is [9301, 9302] while
// severity order is [9302, 9301, 9303] whatever order the files are in.
const SEVERITY_SUGGESTIONS = [
  aiSuggestion(9301, 'minor', 'src/utils.js', 3, 'Minor thing'),
  aiSuggestion(9302, 'critical', 'src/utils.js', 5, 'Critical thing'),
  aiSuggestion(9303, null, 'src/main.js', 12, 'Nice naming')
];

/** Serve AI suggestions for the review (GETs only; /suggestions/check is untouched). */
async function mockSuggestions(page, suggestions) {
  await page.route(SUGGESTIONS_URL, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, suggestions })
    });
  });
}

const aiItem = (page, id) => page.locator(`#findings-list .finding-item[data-id="${id}"]`);
const severityNotice = (page) => page.locator('.hidden-severity-notice');
const aiItemIds = (page) => page.locator('#findings-list .finding-item')
  .evaluateAll(els => els.map(el => Number(el.dataset.id)));

/**
 * Open the Review panel and load the mocked suggestions into it. The page only
 * fetches suggestions on load when an analysis run exists, and the test DB has
 * none, so ask for them the way a finished analysis does (see seedAISuggestions).
 */
async function openAIPanel(page) {
  await page.evaluate(async () => {
    window.aiPanel?.expand();
    await window.prManager?.loadAISuggestions();
  });
  await expect(aiItem(page, 9302)).toBeVisible();
}

const panelItem = (page, id) => page.locator(`.finding-item.finding-comment[data-id="${id}"]`);
const notice = (page) => page.locator('.hidden-comments-notice');

test.describe('Comment filter menu (PR mode)', () => {
  test('notice counts dismissed comments; Show and the menu toggle them', async ({ page }) => {
    await mockUserComments(page, [
      fileComment(9001, 'active', 'Still pending'),
      fileComment(9002, 'inactive', 'Dismissed earlier')
    ]);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openUserSegment(page);

    const funnel = page.locator('.comment-filter-btn');
    await expect(funnel).toBeVisible();
    await expect(funnel).not.toHaveClass(/has-active-filter/);
    await expect(panelItem(page, 9001)).toBeVisible();
    await expect(panelItem(page, 9002)).toHaveCount(0);
    await expect(notice(page)).toHaveText(/1 dismissed hidden\s*—\s*Show/);

    // Show turns on "Show dismissed"
    await notice(page).getByRole('button', { name: 'Show hidden user comments' }).click();
    await expect(panelItem(page, 9002)).toBeVisible();
    await expect(panelItem(page, 9002)).toHaveClass(/comment-item-dismissed/);
    await expect(notice(page)).toHaveCount(0);
    await expect(funnel).toHaveClass(/has-active-filter/);

    // The menu turns it off again
    await funnel.click();
    await expect(funnel).toHaveAttribute('aria-expanded', 'true');
    const showDismissed = page.getByRole('checkbox', { name: 'Show dismissed' });
    await expect(showDismissed).toBeChecked();
    await showDismissed.uncheck();
    await expect(panelItem(page, 9002)).toHaveCount(0);
    await expect(notice(page)).toBeVisible();
    await expect(funnel).not.toHaveClass(/has-active-filter/);

    // Escape closes the menu and returns focus to the funnel
    await page.keyboard.press('Escape');
    await expect(page.locator('.comment-filter-menu')).toBeHidden();
    await expect(funnel).toHaveAttribute('aria-expanded', 'false');
    await expect(funnel).toBeFocused();
  });

  test('Show dismissed reveals a dismissed posted comment without also enabling Show posted', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('pair-review-hide-posted-comments', 'true'));
    await mockUserComments(page, [{ ...fileComment(9051, 'inactive', 'Dismissed after posting'), publication: { state: 'posted' } }]);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openUserSegment(page);
    await expect(notice(page)).toHaveText(/1 dismissed hidden/);
    await expect(notice(page)).not.toContainText('posted hidden');
    await page.locator('.comment-filter-btn').click();
    await page.getByRole('checkbox', { name: 'Show dismissed' }).check();
    await expect(page.getByRole('checkbox', { name: 'Show posted' })).not.toBeChecked();
    await expect(panelItem(page, 9051)).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
  });

  test('"Show posted" overrides the hide-after-posting preference for this review only', async ({ page }) => {
    await page.addInitScript(() => {
      // Only on the first load: the test checks what the page writes
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('pair-review-hide-posted-comments', 'true');
        sessionStorage.setItem('seeded', '1');
      }
    });
    await mockUserComments(page, [
      fileComment(9101, 'active', 'Pending'),
      fileComment(9102, 'submitted', 'Posted already')
    ]);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openUserSegment(page);

    await expect(panelItem(page, 9102)).toHaveCount(0);
    await expect(notice(page)).toHaveText(/1 posted hidden/);

    await page.locator('.comment-filter-btn').click();
    const showPosted = page.getByRole('checkbox', { name: 'Show posted' });
    await expect(showPosted).not.toBeChecked();
    await showPosted.check();
    await expect(panelItem(page, 9102)).toBeVisible();
    await expect(page.locator('.file-comment-card[data-comment-id="9102"]')).toBeVisible();
    await expect(notice(page)).toHaveCount(0);

    const storage = await page.evaluate(() => ({
      global: localStorage.getItem('pair-review-hide-posted-comments'),
      review: Object.keys(localStorage).filter(k => k.startsWith('pair-review-show-posted_'))
        .map(k => localStorage.getItem(k))
    }));
    expect(storage).toEqual({ global: 'true', review: ['true'] });

    // The override survives a reload
    await page.reload();
    await waitForDiffToRender(page);
    await openUserSegment(page);
    await expect(panelItem(page, 9102)).toBeVisible();
  });

  test('outside click closes the menu', async ({ page }) => {
    await mockUserComments(page, []);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openUserSegment(page);

    await page.locator('.comment-filter-btn').click();
    await expect(page.locator('.comment-filter-menu')).toBeVisible();
    await page.locator('#findings-list').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.comment-filter-menu')).toBeHidden();
  });

  test('severity filter hides AI suggestions in the panel only; the notice and Show all restore them', async ({ page }) => {
    await mockSuggestions(page, SEVERITY_SUGGESTIONS);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openAIPanel(page);
    await expect(page.locator('.ai-suggestion[data-suggestion-id="9301"]')).toBeVisible();

    const funnel = page.locator('.comment-filter-btn');
    await funnel.click();
    await page.getByRole('checkbox', { name: 'Minor' }).uncheck();

    // Gone from the panel, with a notice and the funnel dot...
    await expect(aiItem(page, 9301)).toHaveCount(0);
    await expect(aiItem(page, 9302)).toBeVisible();
    await expect(severityNotice(page)).toHaveText(/1 AI suggestion hidden from this list\s*—\s*Show all/);
    await expect(funnel).toHaveClass(/has-active-filter/);
    // ...but the diff still shows it inline
    await expect(page.locator('.ai-suggestion[data-suggestion-id="9301"]')).toBeVisible();

    // The open menu covers the notice, so close it first
    await page.keyboard.press('Escape');
    await expect(page.locator('.comment-filter-menu')).toBeHidden();
    await severityNotice(page).getByRole('button', { name: /Show AI suggestions of every severity/ }).click();
    await expect(aiItem(page, 9301)).toBeVisible();
    await expect(severityNotice(page)).toHaveCount(0);
    await expect(funnel).not.toHaveClass(/has-active-filter/);
    await funnel.click();
    await expect(page.getByRole('checkbox', { name: 'Minor' })).toBeChecked();
  });

  test('sorting by severity reorders the panel, and the sort and hidden levels survive a reload', async ({ page }) => {
    await mockSuggestions(page, SEVERITY_SUGGESTIONS);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openAIPanel(page);

    const fileOrder = await aiItemIds(page);
    expect(fileOrder.indexOf(9301)).toBeLessThan(fileOrder.indexOf(9302));

    await page.locator('.comment-filter-btn').click();
    await page.getByRole('radio', { name: 'Severity' }).check();
    await expect.poll(() => aiItemIds(page)).toEqual([9302, 9301, 9303]);
    await page.getByRole('checkbox', { name: 'No severity' }).uncheck();
    await expect.poll(() => aiItemIds(page)).toEqual([9302, 9301]);

    const storage = await page.evaluate(() => ({
      sort: localStorage.getItem('pair-review-severity-sort'),
      hidden: Object.keys(localStorage).filter(k => k.startsWith('pair-review-severity-hidden_'))
        .map(k => JSON.parse(localStorage.getItem(k)))
    }));
    expect(storage).toEqual({ sort: 'severity', hidden: [['none']] });

    await page.reload();
    await waitForDiffToRender(page);
    await openAIPanel(page);
    await expect.poll(() => aiItemIds(page)).toEqual([9302, 9301]);
    await expect(severityNotice(page)).toHaveText(/1 AI suggestion hidden from this list/);
    await page.locator('.comment-filter-btn').click();
    await expect(page.getByRole('radio', { name: 'Severity' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'No severity' })).not.toBeChecked();
    // Keyboard focus enters the menu on the checked radio
    await expect(page.getByRole('radio', { name: 'Severity' })).toBeFocused();
  });

  test('the sort carries over to another review; the hidden levels do not', async ({ page }) => {
    await mockSuggestions(page, SEVERITY_SUGGESTIONS);
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openAIPanel(page);
    await page.locator('.comment-filter-btn').click();
    await page.getByRole('radio', { name: 'Severity' }).check();
    await page.getByRole('checkbox', { name: 'Minor' }).uncheck();
    await expect(aiItem(page, 9301)).toHaveCount(0);

    const other = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('pair-review-severity-hidden_'));
      return { key, value: localStorage.getItem(key), sort: localStorage.getItem('pair-review-severity-sort') };
    });
    expect(other.sort).toBe('severity');
    // A different review's key is separate: the sort applies, the hidden levels don't
    expect(other.key).toMatch(/^pair-review-severity-hidden_.+#1$/);
    await page.evaluate(() => window.aiPanel.setPR('test-owner', 'test-repo', 2));
    await expect(aiItem(page, 9301)).toBeVisible();
    await expect.poll(() => aiItemIds(page)).toEqual([9302, 9301, 9303]);
  });

  test('a tall menu scrolls inside the window instead of running past it', async ({ page }) => {
    await mockSuggestions(page, SEVERITY_SUGGESTIONS);
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openAIPanel(page);

    await page.locator('.comment-filter-btn').click();
    const menu = page.locator('.comment-filter-menu');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(420);
    const overflow = await menu.evaluate(el => ({ scroll: el.scrollHeight, client: el.clientHeight, y: getComputedStyle(el).overflowY }));
    expect(overflow.y).toBe('auto');
    expect(overflow.scroll).toBeGreaterThan(overflow.client);

    // The last option is reachable by scrolling the menu
    const showDismissed = page.getByRole('checkbox', { name: 'Show dismissed' });
    await showDismissed.scrollIntoViewIfNeeded();
    await showDismissed.check();
    await expect(showDismissed).toBeChecked();
  });
});

test.describe('Comment filter menu (Local mode)', () => {
  test('has "Show dismissed" but no "Show posted"', async ({ page }) => {
    await page.goto('/local/2');
    await waitForDiffToRender(page);
    await expandReviewPanel(page);

    await page.locator('.comment-filter-btn').click();
    await expect(page.getByRole('checkbox', { name: 'Show dismissed' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Show posted' })).toHaveCount(0);
  });

  test('sorts and filters AI suggestions by severity in the panel', async ({ page }) => {
    await mockSuggestions(page, SEVERITY_SUGGESTIONS);
    await page.goto('/local/2');
    await waitForDiffToRender(page);
    await openAIPanel(page);

    const funnel = page.locator('.comment-filter-btn');
    await funnel.click();
    await page.getByRole('radio', { name: 'Severity' }).check();
    await expect.poll(() => aiItemIds(page)).toEqual([9302, 9301, 9303]);

    await page.getByRole('checkbox', { name: 'Minor' }).uncheck();
    await expect.poll(() => aiItemIds(page)).toEqual([9302, 9303]);
    await expect(severityNotice(page)).toHaveText(/1 AI suggestion hidden from this list/);
    await expect(funnel).toHaveClass(/has-active-filter/);

    await page.reload();
    await waitForDiffToRender(page);
    await openAIPanel(page);
    await expect.poll(() => aiItemIds(page)).toEqual([9302, 9303]);

    await severityNotice(page).getByRole('button', { name: /Show AI suggestions of every severity/ }).click();
    await expect.poll(() => aiItemIds(page)).toEqual([9302, 9301, 9303]);
  });
});
