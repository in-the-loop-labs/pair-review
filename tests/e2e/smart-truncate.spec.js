// Real-layout checks for SmartTruncate (logic is unit-tested).

import { test, expect } from './fixtures.js';
import { waitForDiffToRender, seedAISuggestions } from './helpers.js';

const FILE = 'src/utils.js';
const headerSelector = `.d2h-file-wrapper[data-file-name="${FILE}"] .d2h-file-header`;
const fileNameSelector = `${headerSelector} .d2h-file-name`;
const tooltipSelector = '.smart-truncate-tooltip';

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

  await page.locator(fileNameSelector).first().hover();
  const tooltip = page.locator(tooltipSelector);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(FILE);

  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
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

  test('PR mode: long paths front-truncate and show a full-path tooltip', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await expectFrontTruncatedHeader(page);
  });

  test('Local mode: long paths front-truncate and show a full-path tooltip', async ({ page }) => {
    await page.goto('/local/2');
    await waitForDiffToRender(page);
    await expectFrontTruncatedHeader(page);
  });

  test('no tooltip when the path fits', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    const fileName = page.locator(fileNameSelector).first();
    expect(await fileName.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);

    // Deterministic: no waiting out the hover delay to prove a negative
    expect(await fileName.evaluate((el) => window.smartTruncate.show(el))).toBe(false);
    await expect(page.locator(tooltipSelector)).toBeHidden();
  });

  test('AI suggestion titles back-truncate and show a full-title tooltip', async ({ page }) => {
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
    const tooltip = page.locator(tooltipSelector);
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(fullTitle);
  });
});
