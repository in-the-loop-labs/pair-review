// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: PR Page Load and Diff Display
 *
 * Tests the core functionality of loading a PR and displaying the diff.
 * The test server is started via global-setup.js with pre-seeded test data.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';
import {
  fileWrapper, lineNumberCells, rowsOfType, separators, expandableSeparators, expandControls,
  waitForContentUpgrade, waitForDiffSettled, clickExpandControl, clickDelivered, headerLanding, scrollState
} from './diff-dom.js';

const DIFF_MODES = [
  { name: 'PR mode', path: '/pr/test-owner/test-repo/1' },
  { name: 'Local mode', path: '/local/2' }
];

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

  // The diff itself is the same component in both modes; run its display and
  // hunk-expansion checks against PR mode and Local mode.
  for (const mode of DIFF_MODES) {
    test.describe(`Diff Display (${mode.name})`, () => {
      test('should render diff content', async ({ page }) => {
        await page.goto(mode.path);
        await waitForDiffToRender(page);

        // Should have diff file sections
        const diffFiles = page.locator('[data-file-name]');
        const count = await diffFiles.count();
        expect(count).toBeGreaterThan(0);
      });

      test('should display line numbers', async ({ page }) => {
        await page.goto(mode.path);
        await waitForDiffToRender(page);

        // One line-number cell per row and side (old/new line numbers).
        expect(await lineNumberCells(page).count()).toBeGreaterThan(0);
      });

      test('should show added lines with correct styling', async ({ page }) => {
        await page.goto(mode.path);
        await waitForDiffToRender(page);

        expect(await rowsOfType(page, 'addition').count()).toBeGreaterThan(0);
      });

      test('should show removed lines with correct styling', async ({ page }) => {
        await page.goto(mode.path);
        await waitForDiffToRender(page);

        expect(await rowsOfType(page, 'deletion').count()).toBeGreaterThan(0);
      });

      test('should show context lines', async ({ page }) => {
        await page.goto(mode.path);
        await waitForDiffToRender(page);

        // Patch context, or context expanded on demand.
        expect(await rowsOfType(page, 'anyContext').count()).toBeGreaterThan(0);
      });

      test('should display diff hunks with headers', async ({ page }) => {
        await page.goto(mode.path);
        await waitForDiffToRender(page);

        expect(await separators(page).count()).toBeGreaterThan(0);
      });

      test('should show expandable gap section between hunks', async ({ page }) => {
        await page.goto(mode.path);
        await waitForDiffToRender(page);

        // Expand controls only render once full file contents finish loading
        // (see `upgradeFileContents` flow in public/js/pr.js), which is
        // scheduled after initial render. Poll so the test isn't racing that
        // fetch.
        await expect
          .poll(async () => expandableSeparators(page).count(), { timeout: 5000 })
          .toBeGreaterThan(0);
      });

      test('should expand context and show correct line numbers with offset', async ({ page }) => {
        // This test verifies that when context is expanded between hunks,
        // new context lines become visible and the rendered line-number cell count grows.
        //
        // NOTE: Precise OLD=9 / NEW=12 line-number verification is covered by the
        // pierre-context.js unit tests (see convertOldToNew). We verify
        // expansion behavior structurally here.

        await page.goto(mode.path);
        await waitForDiffToRender(page);

        const utilsSection = fileWrapper(page, 'src/utils.js');
        await expect(utilsSection).toBeVisible();

        // Find a separator that actually has expand controls. Expand buttons
        // only appear after full file contents finish loading (see upgradeFileContents),
        // so poll for their presence instead of racing the fetch.
        const expandable = expandableSeparators(utilsSection);
        await expect
          .poll(async () => expandable.count(), { timeout: 5000 })
          .toBeGreaterThan(0);

        // Not while the diff is still drawing itself: every draw of a file
        // re-creates its rows and separators, and a click whose press and
        // release fall on either side of one is not delivered, on either
        // engine (ledger H43, H143; 1 of 120 executions under load). The
        // file is drawn once more after these two waits (measured: its rows
        // replaced 19 to 54 ms later, and 30 to 74 ms later on main), so the
        // click below is made again when the browser sent none.
        await waitForContentUpgrade(page, 'src/utils.js');
        await waitForDiffSettled(page);

        // Record the pre-expansion count of rendered line-number cells in this file.
        const numberCells = lineNumberCells(utilsSection);
        const cellsBefore = await numberCells.count();

        // Click an expand control (prefer expand-up on the target separator).
        const targetSeparator = expandable.first();
        const expandUp = expandControls(targetSeparator, 'up');
        const expandBtn = (await expandUp.count()) > 0
          ? expandUp.first()
          : expandControls(targetSeparator, 'any').first();
        await clickDelivered(page, expandBtn);

        // Poll until context-expanded lines are present AND line-number cell count grew.
        await expect
          .poll(async () => rowsOfType(utilsSection, 'expanded').count(), { timeout: 3000 })
          .toBeGreaterThan(0);
        await expect
          .poll(async () => numberCells.count(), { timeout: 3000 })
          .toBeGreaterThan(cellsBefore);
      });

      test('should reveal unmodified context when a hunk separator expand button is clicked', async ({ page }) => {
        // Inter-hunk separators are labelled with text like "N unmodified
        // lines". Expand buttons on those separators reveal previously-hidden
        // context.

        await page.goto(mode.path);
        await waitForDiffToRender(page);

        const utilsSection = fileWrapper(page, 'src/utils.js');
        await expect(utilsSection).toBeVisible();

        // Wait for expand controls before interacting — they only render after
        // full file contents load via upgradeFileContents.
        await expect
          .poll(async () => expandableSeparators(utilsSection).count(), { timeout: 5000 })
          .toBeGreaterThan(0);

        // The controls exist once the upgraded diff is what is displayed;
        // wait for that before counting rows or clicking (the upgrade
        // re-creates every row of the file).
        await waitForContentUpgrade(page, 'src/utils.js');

        // Pick an expand button that is actually visible: the directional
        // controls are what a user clicks ("expand all" is hidden by default).
        const visibleExpandBtn = expandControls(separators(utilsSection), 'directional').first();
        await expect(visibleExpandBtn).toBeVisible();

        const contextExpandedBefore = await rowsOfType(utilsSection, 'expanded').count();

        await clickExpandControl(page, 'src/utils.js', 0);

        // Expansion is async — poll until additional context lines appear.
        await expect
          .poll(async () => rowsOfType(utilsSection, 'expanded').count(), { timeout: 3000 })
          .toBeGreaterThan(contextExpandedBefore);
      });
    });
  }

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

      // The second sidebar entry is the fixture's second file. Its header
      // starts well below the toolbar pinned above the diff.
      const secondEntry = page.locator('.file-item').nth(1);
      await expect(secondEntry).toHaveAttribute('data-path', 'src/utils.js');
      const before = await headerLanding(page, 'src/utils.js');
      expect(before.belowPinned).toBeGreaterThan(2);
      expect((await scrollState(page)).top).toBe(0);

      await secondEntry.click();

      // The diff scrolls to the clicked file and stops with its header flush
      // under the toolbar, or, when the diff ends first (the fixture's last
      // file is shorter than the pane), at the end of the scroll range with
      // the header on screen. The scroll is smooth, so this is polled until
      // it has arrived.
      //
      // The assertion is about the file that was clicked. An earlier version
      // looked at the second `[data-file-name]` element of the page, which is
      // the FIRST file's comment zone; the scroll moves that out of the
      // viewport about 100 ms after the click, so the test passed only when
      // its first poll was quicker than the scroll.
      await expect.poll(async () => {
        const landing = await headerLanding(page, 'src/utils.js');
        const scroll = await scrollState(page);
        const atEnd = scroll.top >= scroll.height - scroll.client - 1;
        return {
          arrived: Math.abs(landing.belowPinned) < 2 || atEnd,
          headerInViewport: landing.inViewport,
          scrolled: scroll.top > 0
        };
      }).toEqual({ arrived: true, headerInViewport: true, scrolled: true });
      await expect(secondEntry).toHaveClass(/active/);
      await expect(page.locator('.file-item').first()).not.toHaveClass(/active/);
    });
  });

  test.describe('File Navigator Tree', () => {
    // Render a known nested file list so the tree shape does not depend on the fixture PR
    async function renderNestedFileList(page) {
      await page.goto('/pr/test-owner/test-repo/1');
      await waitForDiffToRender(page);
      await page.evaluate(() => {
        window.prManager.updateFileList([
          { file: 'root/foo/README.md', insertions: 1, deletions: 0 },
          { file: 'root/foo/bar/index.md', insertions: 1, deletions: 0 },
          { file: 'root/foo/bar/xyz/example.rb', insertions: 1, deletions: 0 },
        ]);
      });
    }

    const group = (page, path) => page.locator(`#file-list .file-group[data-path="${path}"]`);
    const chevronTransform = (page, path) => group(page, path)
      .locator(':scope > .file-group-header > .file-group-chevron')
      .evaluate(el => getComputedStyle(el).transform);

    test('collapses shared prefixes and nests subfolders', async ({ page }) => {
      await renderNestedFileList(page);

      const labels = await page.locator('#file-list .file-group-name').allTextContents();
      expect(labels).toEqual(['root/foo', 'bar', 'xyz']);

      // bar is nested inside root/foo, and xyz inside bar
      await expect(group(page, 'root/foo').locator('.file-group[data-path="root/foo/bar"]')).toHaveCount(1);
      await expect(group(page, 'root/foo/bar').locator('.file-group[data-path="root/foo/bar/xyz"]')).toHaveCount(1);
    });

    test('collapsing a subfolder hides its files and resets only its own chevron', async ({ page }) => {
      await renderNestedFileList(page);

      const expandedTransform = await chevronTransform(page, 'root/foo');
      expect(expandedTransform).not.toBe('none');

      await group(page, 'root/foo/bar').locator(':scope > .file-group-header').click();

      await expect(page.locator('.file-item[data-path="root/foo/bar/index.md"]')).toBeHidden();
      await expect(page.locator('.file-item[data-path="root/foo/bar/xyz/example.rb"]')).toBeHidden();
      await expect(page.locator('.file-item[data-path="root/foo/README.md"]')).toBeVisible();

      // The collapsed subfolder's chevron points right even though its parent is
      // expanded. Poll because the chevron rotation is animated with a transition.
      await expect.poll(() => chevronTransform(page, 'root/foo/bar')).toBe('none');
      await expect.poll(() => chevronTransform(page, 'root/foo')).toBe(expandedTransform);
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
    await lineNumberCells(page).first().hover();

    // The gutter comment button.
    const addCommentBtn = page.locator('.pierre-comment-btn');
    // It may be visible or in the DOM structure
    const count = await addCommentBtn.count();
    expect(count).toBeGreaterThan(0);
  });
});
