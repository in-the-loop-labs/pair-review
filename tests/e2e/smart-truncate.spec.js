// Copyright 2026 The pair-review Authors | SPDX-License-Identifier: Apache-2.0
// Real-layout checks for SmartTruncate (logic is unit-tested). Native
// tooltips aren't visible to Playwright, so the `title` attribute is asserted.

import { test, expect } from './fixtures.js';
import { waitForDiffToRender, seedAISuggestions } from './helpers.js';

const FILE = 'src/utils.js';
const headerSelector = `.d2h-file-wrapper[data-file-name="${FILE}"] .d2h-file-header`;
const fileNameSelector = `${headerSelector} .d2h-file-name`;

async function constrainFileName(page, px) {
  await page.locator(fileNameSelector).first().evaluate((el, width) => {
    el.style.flex = `0 0 ${width}px`;
    el.style.maxWidth = `${width}px`;
  }, px);
}

// Front truncation: text overflows on the left, its right edge stays visible
async function measureStartTruncation(page) {
  return page.locator(fileNameSelector).first().evaluate((el) => {
    const inner = el.querySelector('.smart-truncate__text');
    const outer = el.getBoundingClientRect();
    const text = inner.getBoundingClientRect();
    return {
      truncated: el.scrollWidth > el.clientWidth,
      overflowLeft: outer.left - text.left,
      rightGap: Math.abs(outer.right - text.right),
    };
  });
}

async function expectFrontTruncatedHeader(page) {
  await constrainFileName(page, 40);

  const geometry = await measureStartTruncation(page);
  expect(geometry.truncated).toBe(true);
  expect(geometry.overflowLeft).toBeGreaterThan(0);
  expect(geometry.rightGap).toBeLessThan(1);

  const fileName = page.locator(fileNameSelector).first();
  await fileName.hover();
  await expect(fileName).toHaveAttribute('title', FILE);
}

test.describe('Smart truncation', () => {
  test('file header stays a single line when the pane is narrow', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    const header = page.locator(headerSelector).first();
    const fileName = page.locator(fileNameSelector).first();
    const wideHeight = (await header.boundingBox()).height;
    const lineHeight = (await fileName.boundingBox()).height;

    await header.evaluate((el) => { el.style.width = '240px'; });

    expect((await header.boundingBox()).height).toBeCloseTo(wideHeight, 0);
    expect((await fileName.boundingBox()).height).toBeCloseTo(lineHeight, 0);
    expect(await fileName.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('nowrap');
  });

  test('PR mode: long paths front-truncate and get a full-path title', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await expectFrontTruncatedHeader(page);
  });

  test('Local mode: long paths front-truncate and get a full-path title', async ({ page }) => {
    await page.goto('/local/2');
    await waitForDiffToRender(page);
    await expectFrontTruncatedHeader(page);
  });

  test('no title when the path fits', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    const fileName = page.locator(fileNameSelector).first();
    expect(await fileName.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);

    await fileName.hover();
    // The listener runs synchronously on mouseover, so this isn't racy
    expect(await fileName.evaluate((el) => el.hasAttribute('title'))).toBe(false);
  });

  test('AI suggestion titles back-truncate and expose the full title on hover', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await seedAISuggestions(page);

    const title = page.locator('.ai-suggestion:not(.collapsed) .ai-title.smart-truncate').first();
    await expect(title).toBeVisible();
    const fullTitle = (await title.textContent()).trim();
    expect(fullTitle.length).toBeGreaterThan(4);

    await title.evaluate((el) => {
      el.style.flex = '0 0 30px';
      el.style.maxWidth = '30px';
    });
    expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await title.evaluate((el) => getComputedStyle(el).direction)).toBe('ltr');

    await title.hover();
    await expect(title).toHaveAttribute('title', fullTitle);
  });

  test('badges keep their size while the suggestion title truncates', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await seedAISuggestions(page);
    await expect(page.locator('.ai-suggestion:not(.collapsed) .praise-badge').first()).toBeVisible();

    const headers = await page.evaluate(() => {
      const rects = (els) => els.map((el) => el.getBoundingClientRect());
      return [...document.querySelectorAll('.ai-suggestion:not(.collapsed) .ai-suggestion-header-left')]
        .map((left) => {
          const title = left.querySelector('.ai-title');
          const badges = [...left.children].filter((el) => el !== title);
          const before = rects(badges);
          // Leave the title 40px, far less than its natural width
          const gap = parseFloat(getComputedStyle(left).columnGap) || 0;
          const badgeWidth = before.reduce((sum, r) => sum + r.width + gap, 0);
          left.style.flex = 'none';
          left.style.width = `${badgeWidth + 40}px`;
          const after = rects(badges);
          return {
            hasPraise: !!left.querySelector('.praise-badge'),
            titleTruncated: title.scrollWidth > title.clientWidth,
            maxWidthLoss: Math.max(...before.map((r, i) => r.width - after[i].width)),
            maxHeightGain: Math.max(...before.map((r, i) => after[i].height - r.height)),
          };
        });
    });

    expect(headers.some((h) => h.hasPraise)).toBe(true);
    for (const h of headers) {
      expect(h.titleTruncated).toBe(true);
      expect(h.maxWidthLoss).toBeLessThan(1);
      expect(h.maxHeightGain).toBeLessThan(1); // no badge wrapped onto a second line
    }
  });
});
