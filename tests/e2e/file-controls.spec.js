// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: per-file controls (N3 of plans/codeview-virtualized-diff.md)
 *
 * Characterization of main in both modes: collapse and expand, the Viewed
 * checkbox and its persistence, the sidebar (click to scroll, the active
 * entry, no scroll-spy) and the header chat button.
 */

import { test, expect } from './fixtures.js';
import { MODES, waitForDiffToRender, enableChat, mockViewedStateApi } from './helpers.js';
import { allCorpora, routeDiff } from './fixtures/diffs.js';
import {
  fileWrapper, rowCount, waitForFileRendered, waitForContentUpgrade, headerLanding, scrollDiffToEdge,
  scrollState, assertNoOrphanHosts
} from './diff-dom.js';

const { many: MANY } = allCorpora();
const UTILS = 'src/utils.js';
const MAIN = 'src/main.js';
const sidebarItem = (page, file) => page.locator(`.file-item[data-path="${file}"]`);

for (const mode of MODES) {
  test.describe(`File controls (${mode.name})`, () => {
    let viewedApi;

    test.beforeEach(async ({ page }) => {
      viewedApi = await mockViewedStateApi(page);
    });

    async function open(page) {
      await page.goto(mode.path);
      await waitForDiffToRender(page);
      await waitForContentUpgrade(page, UTILS);
      await waitForContentUpgrade(page, MAIN);
    }

    test('the chevron collapses a file to its header and expands it again, leaving other files alone', async ({ page }) => {
      await open(page);
      const wrapper = fileWrapper(page, UTILS);
      const rowsBefore = await rowCount(page, UTILS);
      const otherRows = await rowCount(page, MAIN);
      expect(rowsBefore).toBeGreaterThan(0);

      await wrapper.locator('.file-collapse-toggle').click();
      await expect(wrapper).toHaveClass(/collapsed/);
      await expect(wrapper.locator('.file-collapse-toggle')).toHaveAttribute('title', 'Expand file');
      await expect.poll(() => rowCount(page, UTILS)).toBe(0);
      await expect(wrapper.locator('.d2h-file-header')).toBeVisible();
      await expect(fileWrapper(page, MAIN)).not.toHaveClass(/collapsed/);
      expect(await rowCount(page, MAIN)).toBe(otherRows);

      await wrapper.locator('.file-collapse-toggle').click();
      await expect(wrapper).not.toHaveClass(/collapsed/);
      await expect(wrapper.locator('.file-collapse-toggle')).toHaveAttribute('title', 'Collapse file');
      await expect.poll(() => rowCount(page, UTILS)).toBe(rowsBefore);
      await assertNoOrphanHosts(page);
    });

    test('clicking the header itself toggles the file too', async ({ page }) => {
      await open(page);
      const wrapper = fileWrapper(page, MAIN);
      await wrapper.locator('.d2h-file-name').click();
      await expect(wrapper).toHaveClass(/collapsed/);
      await expect.poll(() => rowCount(page, MAIN)).toBe(0);
      await wrapper.locator('.d2h-file-name').click();
      await expect(wrapper).not.toHaveClass(/collapsed/);
      await waitForFileRendered(page, MAIN);
    });

    test('Viewed collapses the file, marks it in the sidebar, and survives a reload', async ({ page }) => {
      await open(page);
      const wrapper = fileWrapper(page, UTILS);
      await wrapper.locator('.file-viewed-checkbox').check();
      await expect(wrapper).toHaveClass(/collapsed/);
      await expect.poll(() => rowCount(page, UTILS)).toBe(0);
      await expect(sidebarItem(page, UTILS)).toHaveClass(/viewed/);
      await expect(sidebarItem(page, MAIN)).not.toHaveClass(/viewed/);
      // PR mode saves through the API (wait for the save, or the reload
      // aborts it); Local mode writes localStorage.
      if (!mode.local) await expect.poll(() => viewedApi.files).toEqual([UTILS]);

      await page.reload();
      await waitForDiffToRender(page);
      const reloaded = fileWrapper(page, UTILS);
      await expect(reloaded).toHaveClass(/collapsed/);
      await expect(reloaded.locator('.file-viewed-checkbox')).toBeChecked();
      await expect(sidebarItem(page, UTILS)).toHaveClass(/viewed/);
      expect(await rowCount(page, UTILS)).toBe(0);
      await expect(fileWrapper(page, MAIN)).not.toHaveClass(/collapsed/);

      // Un-viewing expands it and shows its rows.
      await reloaded.locator('.file-viewed-checkbox').uncheck();
      await expect(reloaded).not.toHaveClass(/collapsed/);
      await waitForFileRendered(page, UTILS);
      await expect(sidebarItem(page, UTILS)).not.toHaveClass(/viewed/);
      if (!mode.local) await expect.poll(() => viewedApi.files).toEqual([]);
    });

    test('a viewed file can be expanded to read without un-viewing it', async ({ page }) => {
      await open(page);
      const wrapper = fileWrapper(page, UTILS);
      await wrapper.locator('.file-viewed-checkbox').check();
      await expect(wrapper).toHaveClass(/collapsed/);
      await wrapper.locator('.file-collapse-toggle').click();
      await expect(wrapper).not.toHaveClass(/collapsed/);
      await waitForFileRendered(page, UTILS);
      await expect(wrapper.locator('.file-viewed-checkbox')).toBeChecked();
    });

    test('the header chat button opens the chat panel', async ({ page }) => {
      await open(page);
      await enableChat(page);
      const button = fileWrapper(page, UTILS).locator('.file-header-chat-btn');
      await expect(button).toBeVisible();
      await button.click();
      await expect(page.locator('.chat-panel')).toBeVisible();
      // Opening chat does not collapse or re-render the file away.
      await expect(fileWrapper(page, UTILS)).not.toHaveClass(/collapsed/);
      expect(await rowCount(page, UTILS)).toBeGreaterThan(0);
    });
  });

  test.describe(`Sidebar navigation (${mode.name})`, () => {
    const { first, middle, last } = MANY.roles;

    test.beforeEach(async ({ page }) => {
      await mockViewedStateApi(page);
      await routeDiff(page, MANY);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    test('a click scrolls the file to the top of the diff and marks its entry active', async ({ page }) => {
      await sidebarItem(page, middle).click();
      await expect.poll(async () => Math.abs((await headerLanding(page, middle))?.belowPinned ?? 999)).toBeLessThan(2);
      await expect(sidebarItem(page, middle)).toHaveClass(/active/);
      await expect(page.locator('.file-item.active')).toHaveCount(1);
      await waitForFileRendered(page, middle);

      // Another click moves both.
      await sidebarItem(page, first).click();
      await expect.poll(async () => Math.abs((await headerLanding(page, first))?.belowPinned ?? 999)).toBeLessThan(2);
      await expect(sidebarItem(page, first)).toHaveClass(/active/);
      await expect(sidebarItem(page, middle)).not.toHaveClass(/active/);
    });

    test('the last file is reachable: its entry scrolls it into view and renders it', async ({ page }) => {
      await sidebarItem(page, last).click();
      await waitForFileRendered(page, last);
      await expect.poll(async () => (await headerLanding(page, last))?.inViewport).toBe(true);
      await expect(sidebarItem(page, last)).toHaveClass(/active/);
    });

    test('there is no scroll-spy: scrolling the diff does not move the active entry', async ({ page }) => {
      await sidebarItem(page, middle).click();
      await expect(sidebarItem(page, middle)).toHaveClass(/active/);
      await expect.poll(async () => Math.abs((await headerLanding(page, middle))?.belowPinned ?? 999)).toBeLessThan(2);

      await scrollDiffToEdge(page, 'top');
      await expect.poll(async () => (await scrollState(page)).top).toBe(0);
      await expect.poll(async () => (await headerLanding(page, first))?.inViewport).toBe(true);
      // Two frames for anything that would react to the scroll.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await expect(sidebarItem(page, middle)).toHaveClass(/active/);
      await expect(sidebarItem(page, first)).not.toHaveClass(/active/);
    });
  });
}
