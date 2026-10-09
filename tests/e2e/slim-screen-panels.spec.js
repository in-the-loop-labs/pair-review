// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: slim-screen overlay drawers, docking, drag-resize and tour stacking (PR + Local mode).
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender, dragResizeHandle } from './helpers.js';

const MODES = [
  { name: 'PR Mode', url: '/pr/test-owner/test-repo/1', prKey: 'test-owner/test-repo#1' },
  { name: 'Local Mode', url: '/local/2', prKey: 'local/local#2' },
];

// Below the 900px (panel group) and 1200px (file navigator) breakpoints
const SLIM = { width: 850, height: 800 };
// Between the breakpoints: right panels docked, file navigator in a drawer
const MEDIUM = { width: 1100, height: 800 };
const WIDE = { width: 1280, height: 800 };

function enableChat(page) {
  return page.evaluate(() => {
    document.documentElement.setAttribute('data-chat', 'available');
    window.dispatchEvent(new CustomEvent('chat-state-changed', { detail: { state: 'available' } }));
  });
}

function box(locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
  });
}

/** True when the element is the topmost hit target at its own center. */
function isTopmostAtCenter(locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  });
}

/** Poll an element's rendered width (panels animate their width open/closed). */
function pollWidth(locator) {
  return expect.poll(() => box(locator).then((b) => b.width));
}

function hasOverlayClass(page) {
  return page.locator('#right-panel-group').evaluate((el) => el.classList.contains('right-panel-group--overlay'));
}

/** Turn guided tours on and serve a fixed tour (mirrors tour.spec.js mocks). */
async function mockTour(page) {
  await page.route('**/api/config', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      theme: 'light',
      comment_button_action: 'submit',
      is_running_via_npx: false,
      enable_chat: true,
      chat_provider: 'pi',
      chat_providers: [],
      pi_available: false,
      summaries: { enabled: true },
      tours: { enabled: true },
    }),
  }));
  await page.route('**/api/reviews/*/tour', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      tour: {
        stops: [
          { file_path: 'src/utils.js', side: 'RIGHT', line_start: 4, line_end: 4, title: 'Stop A', description: 'First stop.' },
          { file_path: 'src/main.js', side: 'RIGHT', line_start: 12, line_end: 12, title: 'Stop B', description: 'Second stop.' },
        ],
        diff_hash: 'mock-hash',
        stale: false,
        provider: 'mock',
        model: 'mock',
        created_at: new Date().toISOString(),
      },
      generating: false,
    }),
  }));
  await page.route('**/api/reviews/*/hunk-summaries', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ summaries: [], generating: false }),
  }));
}

function rootVar(page, name) {
  return page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
}

for (const mode of MODES) {
  test.describe(`Slim-screen panels - ${mode.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(mode.url);
      await page.evaluate((prKey) => {
        localStorage.removeItem('panel-group-layout');
        localStorage.removeItem(`panel-group-chat-visible_${prKey}`);
        localStorage.removeItem('chat-panel-width');
        localStorage.removeItem('panel-group-last-h');
        localStorage.removeItem('panel-group-last-v');
        localStorage.removeItem(`pair-review-panel-collapsed_${prKey}`);
        localStorage.removeItem('file-sidebar-collapsed');
        localStorage.removeItem('sidebar-width');
      }, mode.prKey);
    });

    test.describe('Review/Chat drawer below 900px', () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize(SLIM);
        await page.reload();
        await waitForDiffToRender(page);
      });

      test('review toggle opens the Review panel as an overlay without shrinking the diff', async ({ page }) => {
        const aiPanel = page.locator('#ai-panel');
        const diffView = page.locator('.diff-view');
        const toolbar = page.locator('.diff-toolbar');
        const widthBefore = (await box(diffView)).width;

        await page.locator('#ai-panel-toggle').click();

        await expect(aiPanel).not.toHaveClass(/collapsed/);
        await pollWidth(aiPanel).toBeGreaterThan(200);
        const panel = await box(aiPanel);
        expect(panel.right).toBeLessThanOrEqual(SLIM.width + 1);
        // Anchored below the toolbar so the toolbar toggles stay reachable
        expect(panel.top).toBeGreaterThanOrEqual((await box(toolbar)).bottom - 1);
        // Floats over the diff rather than displacing it
        expect((await box(diffView)).width).toBe(widthBefore);
        expect(await isTopmostAtCenter(page.locator('.ai-panel-header'))).toBe(true);
        // Inline-comment width calcs must not reserve space for the drawer
        expect(await rootVar(page, '--right-panel-group-width')).toBe('0px');
      });

      test('review toggle stays usable while open and closes the drawer', async ({ page }) => {
        const toggle = page.locator('#ai-panel-toggle');
        const aiPanel = page.locator('#ai-panel');

        await toggle.click();
        await expect(aiPanel).not.toHaveClass(/collapsed/);
        await pollWidth(aiPanel).toBeGreaterThan(200);
        await expect(toggle).toBeVisible();
        expect(await isTopmostAtCenter(toggle)).toBe(true);

        await toggle.click();
        await expect(aiPanel).toHaveClass(/collapsed/);
        await pollWidth(page.locator('#right-panel-group')).toBe(0);
      });

      test('review panel close button closes the drawer', async ({ page }) => {
        const aiPanel = page.locator('#ai-panel');
        await page.locator('#ai-panel-toggle').click();
        await pollWidth(aiPanel).toBeGreaterThan(200);

        await page.locator('#ai-panel-close').click();
        await expect(aiPanel).toHaveClass(/collapsed/);
        await pollWidth(page.locator('#right-panel-group')).toBe(0);
      });

      test('chat toggle opens the Chat panel as an overlay', async ({ page }) => {
        await enableChat(page);
        const chatPanel = page.locator('.chat-panel');
        const chatBtn = page.locator('#chat-toggle-btn');

        await chatBtn.click();

        await expect(chatPanel).toBeVisible();
        await pollWidth(chatPanel).toBeGreaterThan(200);
        const panel = await box(chatPanel);
        expect(panel.right).toBeLessThanOrEqual(SLIM.width + 1);
        expect(await isTopmostAtCenter(page.locator('.chat-panel__header'))).toBe(true);

        // The toggle stays reachable (not under the drawer) and closes it again
        await expect(chatBtn).toHaveClass(/active/);
        expect(await isTopmostAtCenter(chatBtn)).toBe(true);
        await chatBtn.click();
        await expect(chatPanel).not.toBeVisible();
      });

      test('Review and Chat side by side fit inside the viewport', async ({ page }) => {
        await enableChat(page);
        await page.setViewportSize({ width: 600, height: 800 });
        await page.locator('#ai-panel-toggle').click();
        await page.locator('#chat-toggle-btn').click();

        const aiPanel = page.locator('#ai-panel');
        const chatPanel = page.locator('.chat-panel');
        await expect(chatPanel).toBeVisible();
        await pollWidth(aiPanel).toBeGreaterThan(100);
        await pollWidth(chatPanel).toBeGreaterThan(100);

        const ai = await box(aiPanel);
        const chat = await box(chatPanel);
        expect(ai.left).toBeGreaterThanOrEqual(-1);
        expect(chat.right).toBeLessThanOrEqual(601);
      });
    });

    test.describe('Review and Chat together on ultra-slim screens', () => {
      test('stack instead of squeezing side by side, and the layout picker matches', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 800 });
        await page.reload();
        await waitForDiffToRender(page);
        await enableChat(page);
        await page.locator('#ai-panel-toggle').click();
        await page.locator('#chat-toggle-btn').click();

        const group = page.locator('#right-panel-group');
        const aiPanel = page.locator('#ai-panel');
        const chatPanel = page.locator('.chat-panel');
        await expect(group).toHaveClass(/layout-v-review-chat/);
        await pollWidth(aiPanel).toBeGreaterThan(300);
        await pollWidth(chatPanel).toBeGreaterThan(300);
        expect((await box(chatPanel)).top).toBeGreaterThanOrEqual((await box(aiPanel)).bottom - 1);

        // No Review control spills past the panel (the segment row scrolls inside its own clip)
        const spilled = await aiPanel.evaluate((panel) => {
          const p = panel.getBoundingClientRect();
          return [...panel.querySelectorAll('button, .findings-header-actions')]
            .filter((el) => !el.closest('.segment-control-scroll, .resize-handle'))
            .filter((el) => {
              const b = el.getBoundingClientRect();
              return b.width > 0 && (b.right > p.right + 1 || b.left < p.left - 1);
            })
            .map((el) => el.className || el.tagName);
        });
        expect(spilled).toEqual([]);
        // The user's saved layout is not overwritten
        expect(await page.evaluate(() => localStorage.getItem('panel-group-layout'))).toBeNull();

        // The layout picker only offers the stacked layouts, marking the one shown
        const layoutBtn = page.locator('#panel-layout-toggle');
        const popover = page.locator('#layout-popover');
        const thumb = (layout) => popover.locator(`.layout-popover__thumb[data-layout="${layout}"]`);
        await layoutBtn.click();
        await expect(popover).toHaveClass(/layout-popover--visible/);
        await expect(thumb('h-review-chat')).toBeHidden();
        await expect(thumb('h-chat-review')).toBeHidden();
        await expect(thumb('v-review-chat')).toBeVisible();
        await expect(thumb('v-review-chat')).toHaveClass(/layout-popover__thumb--active/);
        await expect(thumb('v-chat-review')).toBeVisible();
        await layoutBtn.click();
        await expect(popover).not.toHaveClass(/layout-popover--visible/);

        // Side by side again once there is room, with every option back
        await page.setViewportSize(SLIM);
        await expect(group).toHaveClass(/layout-h-review-chat/);
        await expect.poll(async () => (await box(chatPanel)).left - (await box(aiPanel)).right).toBeGreaterThanOrEqual(-1);
        await layoutBtn.click();
        await expect(thumb('h-review-chat')).toBeVisible();
        await expect(thumb('h-review-chat')).toHaveClass(/layout-popover__thumb--active/);
        await expect(thumb('h-chat-review')).toBeVisible();
      });
    });

    test.describe('File navigator drawer below 1200px', () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize(MEDIUM);
        await page.reload();
        await waitForDiffToRender(page);
      });

      test('sidebar is hidden by default and the toolbar toggle opens/closes a drawer', async ({ page }) => {
        const sidebar = page.locator('#files-sidebar');
        const toggle = page.locator('#sidebar-toggle-collapsed');
        const toolbar = page.locator('.diff-toolbar');

        await expect(sidebar).not.toBeVisible();
        await expect(toggle).toBeVisible();
        expect(await rootVar(page, '--sidebar-width')).toBe('0px');

        await toggle.click();
        await expect(sidebar).toBeVisible();
        await expect(sidebar).toHaveClass(/sidebar--overlay-open/);
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const drawer = await box(sidebar);
        expect(drawer.left).toBeGreaterThanOrEqual(-1);
        expect(drawer.width).toBeGreaterThan(200);
        expect(drawer.top).toBeGreaterThanOrEqual((await box(toolbar)).bottom - 1);
        expect(await isTopmostAtCenter(page.locator('#files-sidebar .sidebar-header'))).toBe(true);

        // Toolbar toggle closes it again
        await toggle.click();
        await expect(sidebar).not.toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');

        // The drawer is transient: it must not touch the docked collapsed state
        expect(await page.evaluate(() => localStorage.getItem('file-sidebar-collapsed'))).toBeNull();
      });

      test('sidebar close button closes the drawer', async ({ page }) => {
        const sidebar = page.locator('#files-sidebar');
        await page.locator('#sidebar-toggle-collapsed').click();
        await expect(sidebar).toBeVisible();

        await page.locator('#sidebar-collapse-btn').click();
        await expect(sidebar).not.toBeVisible();
        await expect(sidebar).not.toHaveClass(/collapsed/);
        expect(await page.evaluate(() => localStorage.getItem('file-sidebar-collapsed'))).toBeNull();
      });

      test('picking a file closes the drawer', async ({ page }) => {
        const sidebar = page.locator('#files-sidebar');
        await page.locator('#sidebar-toggle-collapsed').click();
        await expect(sidebar).toBeVisible();

        await sidebar.locator('.file-item').first().click();
        await expect(sidebar).not.toBeVisible();
      });

      test('drawer opens even when the docked sidebar was collapsed on a wide screen', async ({ page }) => {
        await page.evaluate(() => localStorage.setItem('file-sidebar-collapsed', 'true'));
        await page.reload();
        await waitForDiffToRender(page);

        const sidebar = page.locator('#files-sidebar');
        await page.locator('#sidebar-toggle-collapsed').click();
        await expect(sidebar).toBeVisible();
        expect((await box(sidebar)).width).toBeGreaterThan(200);
      });

      test('p n keyboard shortcut toggles the drawer', async ({ page }) => {
        const sidebar = page.locator('#files-sidebar');
        // Make sure focus is on the page, not an input
        await page.locator('.diff-toolbar').click({ position: { x: 300, y: 5 } });

        await page.keyboard.press('p');
        await page.keyboard.press('n');
        await expect(sidebar).toBeVisible();

        await page.keyboard.press('p');
        await page.keyboard.press('n');
        await expect(sidebar).not.toBeVisible();
      });

      test('widening past the breakpoint drops the drawer and re-docks the sidebar', async ({ page }) => {
        const sidebar = page.locator('#files-sidebar');
        await page.locator('#sidebar-toggle-collapsed').click();
        await expect(sidebar).toHaveClass(/sidebar--overlay-open/);

        await page.setViewportSize(WIDE);
        await expect(sidebar).not.toHaveClass(/sidebar--overlay-open/);
        await expect(sidebar).toBeVisible();
        // Docked again: the diff starts to the right of the sidebar
        const sb = await box(sidebar);
        expect((await box(page.locator('.diff-view'))).left).toBeGreaterThanOrEqual(sb.right - 1);

        // Narrowing again does not resurrect the drawer
        await page.setViewportSize(MEDIUM);
        await expect(sidebar).not.toBeVisible();
      });

      test('Review panel stays docked beside the diff between 900px and 1200px', async ({ page }) => {
        const aiPanel = page.locator('#ai-panel');
        await page.locator('#ai-panel-toggle').click();
        await pollWidth(aiPanel).toBeGreaterThan(200);

        await expect.poll(async () => {
          const diff = await box(page.locator('.diff-view'));
          return Math.abs(diff.right - (await box(aiPanel)).left);
        }).toBeLessThanOrEqual(1);
      });
    });

    test.describe('Drag-resizing a drawer', () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 600, height: 800 });
        await page.reload();
        await waitForDiffToRender(page);
      });

      test('dragging the Review drawer edge left widens it', async ({ page }) => {
        const aiPanel = page.locator('#ai-panel');
        await page.locator('#ai-panel-toggle').click();
        await pollWidth(aiPanel).toBeGreaterThan(300);
        const before = (await box(aiPanel)).width;

        await dragResizeHandle(page, page.locator('#ai-panel > .resize-handle[data-panel="ai-panel"]'), -80);

        // Used to clamp to 600 - 260 - 100 = 240px and SHRINK the panel
        await pollWidth(aiPanel).toBeGreaterThan(before + 40);
      });

      test('dragging the Chat drawer edge left widens it', async ({ page }) => {
        await enableChat(page);
        const chatPanel = page.locator('.chat-panel');
        await page.locator('#chat-toggle-btn').click();
        await pollWidth(chatPanel).toBeGreaterThan(300);
        const before = (await box(chatPanel)).width;

        await dragResizeHandle(page, page.locator('.chat-panel__resize-handle'), -60);

        await pollWidth(chatPanel).toBeGreaterThan(before + 30);
      });
    });

    test.describe('Docking above 900px depends on the room left for the diff', () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 950, height: 800 });
        await page.reload();
        await waitForDiffToRender(page);
        await enableChat(page);
      });

      test('Review + Chat side by side float instead of squeezing the diff', async ({ page }) => {
        await page.locator('#ai-panel-toggle').click();
        await page.locator('#chat-toggle-btn').click();
        await pollWidth(page.locator('.chat-panel')).toBeGreaterThan(300);

        expect(await hasOverlayClass(page)).toBe(true);
        // The diff keeps the full width underneath the drawer
        expect((await box(page.locator('.diff-view'))).width).toBeGreaterThan(940);
        expect(await rootVar(page, '--right-panel-group-width')).toBe('0px');
        // ...and the toggles stay reachable to close the drawer
        expect(await isTopmostAtCenter(page.locator('#ai-panel-toggle'))).toBe(true);
        expect(await isTopmostAtCenter(page.locator('#chat-toggle-btn'))).toBe(true);
      });

      test('the Review panel alone still docks', async ({ page }) => {
        const aiPanel = page.locator('#ai-panel');
        await page.locator('#ai-panel-toggle').click();
        await pollWidth(aiPanel).toBeGreaterThan(200);

        expect(await hasOverlayClass(page)).toBe(false);
        // Docked: the diff ends where the panel begins (poll — width animates)
        await expect.poll(async () => {
          const diff = await box(page.locator('.diff-view'));
          return Math.abs(diff.right - (await box(aiPanel)).left);
        }).toBeLessThanOrEqual(1);
      });

      test('crossing 900px with both panels open does not squeeze the diff', async ({ page }) => {
        await page.setViewportSize(SLIM);
        await page.locator('#ai-panel-toggle').click();
        await page.locator('#chat-toggle-btn').click();
        await pollWidth(page.locator('.chat-panel')).toBeGreaterThan(300);

        // Just above the old cliff, docking would leave the diff ~181px
        await page.setViewportSize({ width: 901, height: 800 });
        await expect.poll(() => hasOverlayClass(page)).toBe(true);
        await expect.poll(() => box(page.locator('.diff-view')).then((b) => b.width)).toBeGreaterThan(890);
      });

      test('the panels re-dock once there is room again', async ({ page }) => {
        await page.locator('#ai-panel-toggle').click();
        await page.locator('#chat-toggle-btn').click();
        await expect.poll(() => hasOverlayClass(page)).toBe(true);

        await page.setViewportSize({ width: 1500, height: 800 });
        await expect.poll(() => hasOverlayClass(page)).toBe(false);
        await expect.poll(async () => {
          const group = await box(page.locator('#right-panel-group'));
          const diff = await box(page.locator('.diff-view'));
          return Math.abs(diff.right - group.left);
        }).toBeLessThanOrEqual(1);
        expect(await rootVar(page, '--right-panel-group-width')).not.toBe('0px');
      });
    });

    test.describe('Drawers under a wrapping tour bar', () => {
      test('toolbar and drawers stack flush below a tour bar taller than nominal', async ({ page }) => {
        await mockTour(page);
        await page.setViewportSize(SLIM);
        await page.reload();
        await waitForDiffToRender(page);
        await page.locator('#tour-toggle-btn').click();
        const tourBar = page.locator('.tour-bar');
        await expect(tourBar).toBeVisible();

        // Narrow enough that the bar's contents wrap past the nominal 56px
        await page.setViewportSize({ width: 375, height: 800 });
        await expect.poll(() => box(tourBar).then((b) => b.bottom - b.top)).toBeGreaterThan(56);

        await page.locator('#sidebar-toggle-collapsed').click();
        const sidebar = page.locator('#files-sidebar');
        await expect(sidebar).toBeVisible();
        await page.locator('#ai-panel-toggle').click();
        await pollWidth(page.locator('#ai-panel')).toBeGreaterThan(100);

        const toolbar = page.locator('.diff-toolbar');
        const assertStacked = async () => {
          const bar = await box(tourBar);
          const tb = await box(toolbar);
          expect(tb.top).toBeGreaterThanOrEqual(bar.bottom - 1);
          expect((await box(sidebar)).top).toBeGreaterThanOrEqual(tb.bottom - 1);
          expect((await box(page.locator('#ai-panel'))).top).toBeGreaterThanOrEqual(tb.bottom - 1);
        };
        await assertStacked();

        // Same once the diff scrolls and the bar + toolbar pin (sticky)
        await page.locator('.main-layout .diff-view').evaluate((el) => { el.scrollTop = 400; });
        await expect.poll(() => page.locator('.main-layout .diff-view').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        await assertStacked();
      });
    });

    test.describe('Wide screens are unchanged', () => {
      test('sidebar collapse/expand still docks and persists', async ({ page }) => {
        await page.setViewportSize(WIDE);
        await page.reload();
        await waitForDiffToRender(page);

        const sidebar = page.locator('#files-sidebar');
        await expect(sidebar).toBeVisible();

        await page.locator('#sidebar-collapse-btn').click();
        await expect(sidebar).toHaveClass(/collapsed/);
        await expect.poll(() => page.evaluate(() => localStorage.getItem('file-sidebar-collapsed'))).toBe('true');

        await page.locator('#sidebar-toggle-collapsed').click();
        await expect(sidebar).not.toHaveClass(/collapsed/);
        await expect(sidebar).not.toHaveClass(/sidebar--overlay-open/);
        await expect.poll(() => page.evaluate(() => localStorage.getItem('file-sidebar-collapsed'))).toBe('false');
      });

      test('navigator + Review + Chat stay docked at 1280px', async ({ page }) => {
        await page.setViewportSize(WIDE);
        await page.reload();
        await waitForDiffToRender(page);
        await enableChat(page);

        await page.locator('#ai-panel-toggle').click();
        await page.locator('#chat-toggle-btn').click();
        await pollWidth(page.locator('.chat-panel')).toBeGreaterThan(300);

        expect(await hasOverlayClass(page)).toBe(false);
        await expect.poll(async () => {
          const sidebar = await box(page.locator('#files-sidebar'));
          const diff = await box(page.locator('.diff-view'));
          const group = await box(page.locator('#right-panel-group'));
          return Math.max(Math.abs(diff.left - sidebar.right), Math.abs(diff.right - group.left));
        }).toBeLessThanOrEqual(1);
      });
    });
  });
}
