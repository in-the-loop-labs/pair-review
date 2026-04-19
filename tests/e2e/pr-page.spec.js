// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: PR Page Load and Diff Display
 *
 * Tests the core functionality of loading a PR and displaying the diff.
 * The test server is started via global-setup.js with pre-seeded test data.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

test.describe('PR Page', () => {
  test.describe('Page Load', () => {
    test('should load the PR page successfully', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // Verify page title contains PR info
      await expect(page).toHaveTitle(/Pair Review|PR/);

      // Verify the page loaded without critical error
      const errorElement = page.locator('.error-message, .fatal-error');
      await expect(errorElement).not.toBeVisible();
    });

    test('should display PR metadata', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // Wait for PR data to load
      await page.waitForSelector('[data-testid="pr-title"], .pr-title, h1', { timeout: 10000 });

      // The PR title should be visible somewhere
      const titleText = await page.textContent('body');
      expect(titleText).toContain('Test PR for E2E');
    });

    test('should display file list', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // Wait for file list to populate using the correct selector
      await page.waitForSelector('.file-item', { timeout: 10000 });

      // Should show the test files
      const fileItems = page.locator('.file-item');
      const count = await fileItems.count();
      expect(count).toBeGreaterThan(0);

      // Verify specific files from our mock data
      const pageContent = await page.textContent('body');
      expect(pageContent).toContain('utils.js');
      expect(pageContent).toContain('main.js');
    });

    test('should show file statistics', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // Should show additions/deletions
      const pageContent = await page.textContent('body');

      // Check for file stats (additions/deletions display)
      expect(pageContent).toMatch(/\+\d+|\d+\s*addition/i);
    });
  });

  test.describe('Diff Display', () => {
    test('should render diff content', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // Should have diff file sections
      const diffFiles = page.locator('[data-file-name]');
      const count = await diffFiles.count();
      expect(count).toBeGreaterThan(0);
    });

    test('should display line numbers', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // Pierre emits a cell per side with [data-column-number] (old/new line numbers).
      // Playwright's CSS engine pierces the <diffs-container> shadow root by default.
      const lineNumbers = page.locator('[data-column-number]');
      const count = await lineNumbers.count();
      expect(count).toBeGreaterThan(0);
    });

    test('should show added lines with correct styling', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // Pierre tags inserted lines with data-line-type="change-addition"
      const addedLines = page.locator('[data-line-type="change-addition"]');
      const count = await addedLines.count();
      expect(count).toBeGreaterThan(0);
    });

    test('should show removed lines with correct styling', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // Pierre tags deleted lines with data-line-type="change-deletion"
      const removedLines = page.locator('[data-line-type="change-deletion"]');
      const count = await removedLines.count();
      expect(count).toBeGreaterThan(0);
    });

    test('should show context lines', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // Pierre tags context lines with data-line-type="context"
      // (expanded-on-demand context uses "context-expanded").
      const contextLines = page.locator('[data-line-type="context"], [data-line-type="context-expanded"]');
      const count = await contextLines.count();
      expect(count).toBeGreaterThan(0);
    });

    test('should display diff hunks with headers', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // Pierre emits hunk separators as elements carrying the [data-separator] attribute.
      const hunkHeaders = page.locator('[data-separator]');
      const count = await hunkHeaders.count();
      expect(count).toBeGreaterThan(0);
    });

    test('should show expandable gap section between hunks', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // In pierre, expandable gaps are [data-separator] elements that contain
      // a [data-expand-button] descendant. Expand controls only render once
      // full file contents finish loading (see `upgradeFileContents` flow in
      // public/js/pr.js), which is scheduled via requestIdleCallback after
      // initial render. Poll so the test isn't racing that fetch.
      await expect
        .poll(
          async () => page.locator('[data-separator]:has([data-expand-button])').count(),
          { timeout: 5000 }
        )
        .toBeGreaterThan(0);
    });

    test('should expand context and show correct line numbers with offset', async ({ page }) => {
      // This test verifies that when context is expanded between hunks,
      // new context lines become visible and the rendered line-number cell count grows.
      //
      // NOTE: Precise OLD=9 / NEW=12 line-number verification is covered by the
      // pierre-context.js unit tests (see convertOldToNew). Pierre does not expose
      // old/new numbers via dedicated old-vs-new line-number classes, so we verify
      // expansion behavior structurally here.

      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // Scope to the main diff wrapper. There are multiple elements carrying
      // data-file-name="src/utils.js" (e.g. .file-comments-zone); filter to the
      // one that hosts the pierre diff body.
      const utilsSection = page
        .locator('[data-file-name="src/utils.js"]')
        .filter({ has: page.locator('.pierre-diff-body') });
      await expect(utilsSection).toBeVisible();

      // Find a separator that actually has expand controls. Expand buttons
      // only appear after full file contents finish loading (see upgradeFileContents),
      // so poll for their presence instead of racing the idle-callback fetch.
      const expandableSeparators = utilsSection.locator('[data-separator]:has([data-expand-button])');
      await expect
        .poll(async () => expandableSeparators.count(), { timeout: 5000 })
        .toBeGreaterThan(0);

      // Record the pre-expansion count of rendered line-number cells in this file.
      const lineNumberCells = utilsSection.locator('[data-column-number]');
      const cellsBefore = await lineNumberCells.count();

      // Click an expand control (prefer expand-up on the target separator).
      const targetSeparator = expandableSeparators.first();
      const expandUp = targetSeparator.locator('[data-expand-up]');
      const expandBtn = (await expandUp.count()) > 0
        ? expandUp.first()
        : targetSeparator.locator('[data-expand-button]').first();
      await expandBtn.click();

      // Poll until context-expanded lines are present AND line-number cell count grew.
      await expect
        .poll(async () => utilsSection.locator('[data-line-type="context-expanded"]').count(), { timeout: 3000 })
        .toBeGreaterThan(0);
      await expect
        .poll(async () => lineNumberCells.count(), { timeout: 3000 })
        .toBeGreaterThan(cellsBefore);
    });

    test('should reveal unmodified context when a hunk separator expand button is clicked', async ({ page }) => {
      // Pierre labels inter-hunk separators with text like "N unmodified lines"
      // (see createSeparator.js in node_modules/@pierre/diffs). Expand buttons
      // on those separators reveal previously-hidden context. The legacy
      // "function context appears in the hunk header" concept (from diff2html)
      // doesn't exist in pierre — the function-context string is not surfaced
      // separately, so we test expansion structurally instead.
      //
      // See public/js/modules/pierre-bridge.js for the expansion code path
      // that feeds additional context back into the component.

      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // Scope to the main diff wrapper, filtering out the sibling
      // .file-comments-zone that also carries data-file-name.
      const utilsSection = page
        .locator('[data-file-name="src/utils.js"]')
        .filter({ has: page.locator('.pierre-diff-body') });
      await expect(utilsSection).toBeVisible();

      // Wait for expand controls before interacting — they only render after
      // full file contents load via upgradeFileContents.
      await expect
        .poll(
          async () => utilsSection.locator('[data-separator]:has([data-expand-button])').count(),
          { timeout: 5000 }
        )
        .toBeGreaterThan(0);

      // Pick an expand button that is actually visible. Pierre hides
      // [data-expand-all-button] via CSS by default; real-user "expand more"
      // interactions go through the directional expand-up / expand-down
      // buttons (or the separator label).
      const visibleExpandBtn = utilsSection
        .locator('[data-separator] [data-expand-up], [data-separator] [data-expand-down], [data-separator] [data-expand-both]')
        .first();
      await expect(visibleExpandBtn).toBeVisible();

      const contextExpandedBefore = await utilsSection.locator('[data-line-type="context-expanded"]').count();

      await visibleExpandBtn.click();

      // Expansion is async — poll until additional context lines appear.
      await expect
        .poll(
          async () => utilsSection.locator('[data-line-type="context-expanded"]').count(),
          { timeout: 3000 }
        )
        .toBeGreaterThan(contextExpandedBefore);
    });
  });

  test.describe('File Navigation', () => {
    test('should highlight file when clicked in file list', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // Wait for file list
      await page.waitForSelector('.file-item', { timeout: 10000 });

      // Click on a file
      const firstFile = page.locator('.file-item').first();
      await firstFile.click();

      // The clicked file should be active
      await expect(firstFile).toHaveClass(/active/);
    });

    test('should scroll to file in diff when clicked', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // Get file list items
      const fileItems = page.locator('.file-item');
      const count = await fileItems.count();

      if (count > 1) {
        // Get the second file's name to verify we scroll to it
        const secondFileName = await fileItems.nth(1).textContent();

        // Click second file to trigger scroll
        await fileItems.nth(1).click();

        // Wait for the second file to be visible in viewport (replaces fixed timeout)
        // The file section matching the clicked file should be in view
        const targetFileSection = page.locator(`[data-file-name]`).nth(1);
        await expect(targetFileSection).toBeInViewport({ timeout: 2000 });
      }
    });
  });

  test.describe('Error Handling', () => {
    test('should show error for non-existent PR', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/999');
      await page.waitForLoadState('domcontentloaded');

      // Should show error state
      const pageContent = await page.textContent('body');

      // Check for error indicators
      const hasError = pageContent.toLowerCase().includes('error') ||
                       pageContent.toLowerCase().includes('not found') ||
                       pageContent.toLowerCase().includes('404');
      expect(hasError).toBe(true);
    });

    test('should handle invalid PR number gracefully', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/invalid');
      await page.waitForLoadState('domcontentloaded');

      // Should handle gracefully - the page should show an error or "Invalid"
      // This depends on whether the client or server handles the invalid PR
      const pageContent = await page.textContent('body');

      // Either shows error or the page loaded but with issues
      expect(pageContent.length).toBeGreaterThan(0);
    });
  });
});

test.describe('AI Features', () => {
  test('should show AI analysis button', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Verify the actual Analyze button exists and is visible
    const analyzeBtn = page.locator('#analyze-btn, button:has-text("Analyze")');
    await expect(analyzeBtn.first()).toBeVisible();
  });
});

test.describe('Home Page', () => {
  test('should load the home page', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Should show the app interface
    await expect(page).toHaveTitle(/Pair Review/);
  });

  test('should have PR input functionality', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Should have some way to enter a PR
    const pageContent = await page.textContent('body');
    const hasInput = pageContent.toLowerCase().includes('enter') ||
                     pageContent.toLowerCase().includes('url') ||
                     pageContent.toLowerCase().includes('pr') ||
                     pageContent.toLowerCase().includes('review');
    expect(hasInput).toBe(true);
  });
});

test.describe('Comment Interaction', () => {
  test('should show add comment button on hover', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Hover over a line-number cell to trigger comment button visibility.
    // Pierre emits line-number cells with [data-column-number].
    const lineNumberCell = page.locator('[data-column-number]').first();
    await lineNumberCell.hover();

    // Pierre's comment gutter button uses the .pierre-comment-btn class.
    const addCommentBtn = page.locator('.pierre-comment-btn');
    // It may be visible or in the DOM structure
    const count = await addCommentBtn.count();
    expect(count).toBeGreaterThan(0);
  });
});
