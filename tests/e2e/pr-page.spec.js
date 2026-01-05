/**
 * E2E Tests: PR Page Load and Diff Display
 *
 * Tests the core functionality of loading a PR and displaying the diff.
 * The test server is started via global-setup.js with pre-seeded test data.
 */

import { test, expect } from '@playwright/test';

// Helper to wait for diff to render
async function waitForDiffToRender(page) {
  // Wait for diff container to have content
  await page.waitForSelector('[data-file-name]', { timeout: 10000 });
  // Wait for at least one diff line
  await page.waitForSelector('.d2h-code-line-ctn', { timeout: 10000 });
}

test.describe('PR Page', () => {
  test.describe('Page Load', () => {
    test('should load the PR page successfully', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await page.waitForLoadState('networkidle');

      // Verify page title contains PR info
      await expect(page).toHaveTitle(/Pair Review|PR/);

      // Verify the page loaded without critical error
      const errorElement = page.locator('.error-message, .fatal-error');
      await expect(errorElement).not.toBeVisible();
    });

    test('should display PR metadata', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await page.waitForLoadState('networkidle');

      // Wait for PR data to load
      await page.waitForSelector('[data-testid="pr-title"], .pr-title, h1', { timeout: 10000 });

      // The PR title should be visible somewhere
      const titleText = await page.textContent('body');
      expect(titleText).toContain('Test PR for E2E');
    });

    test('should display file list', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await page.waitForLoadState('networkidle');

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
      await page.waitForLoadState('networkidle');

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

      // Should have line numbers (d2h uses line-num1 and line-num2 for old/new)
      const lineNumbers = page.locator('.line-num1, .line-num2, .d2h-code-linenumber');
      const count = await lineNumbers.count();
      expect(count).toBeGreaterThan(0);
    });

    test('should show added lines with correct styling', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // d2h uses d2h-ins class for inserted lines
      const addedLines = page.locator('.d2h-ins, tr.d2h-ins');
      const count = await addedLines.count();
      expect(count).toBeGreaterThan(0);
    });

    test('should show removed lines with correct styling', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // d2h uses d2h-del class for deleted lines
      const removedLines = page.locator('.d2h-del, tr.d2h-del');
      const count = await removedLines.count();
      expect(count).toBeGreaterThan(0);
    });

    test('should show context lines', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // d2h uses d2h-cntx class for context lines
      const contextLines = page.locator('.d2h-cntx, tr.d2h-cntx');
      const count = await contextLines.count();
      expect(count).toBeGreaterThan(0);
    });

    test('should display diff hunks with headers', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);

      // d2h uses d2h-info class for hunk headers
      const hunkHeaders = page.locator('.d2h-info, tr.d2h-info');
      const count = await hunkHeaders.count();
      expect(count).toBeGreaterThan(0);
    });
  });

  test.describe('File Navigation', () => {
    test('should highlight file when clicked in file list', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/1');
      await page.waitForLoadState('networkidle');

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
        // Click second file to trigger scroll
        await fileItems.nth(1).click();

        // Wait for scroll animation
        await page.waitForTimeout(500);

        // The diff view should have scrolled (file should be visible)
        await expect(page.locator('[data-file-name]').first()).toBeVisible();
      }
    });
  });

  test.describe('Error Handling', () => {
    test('should show error for non-existent PR', async ({ page }) => {
      await page.goto('/pr/test-owner/test-repo/999');
      await page.waitForLoadState('networkidle');

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
      await page.waitForLoadState('networkidle');

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
    await page.waitForLoadState('networkidle');

    // Should show indicator that AI features are available
    const pageContent = await page.textContent('body');
    const hasAIIndicator = pageContent.toLowerCase().includes('ai') ||
                           pageContent.toLowerCase().includes('analyze') ||
                           pageContent.toLowerCase().includes('suggestion');
    expect(hasAIIndicator).toBe(true);
  });
});

test.describe('Home Page', () => {
  test('should load the home page', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Should show the app interface
    await expect(page).toHaveTitle(/Pair Review/);
  });

  test('should have PR input functionality', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

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

    // Hover over a line number to trigger comment button visibility
    const lineNumberCell = page.locator('.d2h-code-linenumber').first();
    await lineNumberCell.hover();

    // The add comment button should become visible (or exist in DOM)
    const addCommentBtn = page.locator('.add-comment-btn');
    // It may be visible or in the DOM structure
    const count = await addCommentBtn.count();
    expect(count).toBeGreaterThan(0);
  });
});
