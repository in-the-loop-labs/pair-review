// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * E2E Tests: Auto-Analyze Query Parameter
 *
 * Tests that navigating to a PR page with ?analyze=true
 * automatically triggers AI analysis without user interaction.
 */

import { test, expect } from '@playwright/test';
import { waitForDiffToRender } from './helpers.js';

test.describe('Auto-Analyze Query Parameter', () => {
  test('should auto-trigger analysis when ?analyze=true is present', async ({ page }) => {
    // Intercept the analyze POST request to verify it fires
    const analyzeRequest = page.waitForRequest(
      request => request.url().includes('/api/pr/test-owner/test-repo/1/analyses') &&
                 request.method() === 'POST',
      { timeout: 10000 }
    );

    await page.goto('/pr/test-owner/test-repo/1?analyze=true');
    await waitForDiffToRender(page);

    // Verify the analysis POST was triggered automatically
    const request = await analyzeRequest;
    expect(request.method()).toBe('POST');
  });

  test('should strip ?analyze=true from URL after successful analysis', async ({ page }) => {
    // Mock the analysis-status endpoint to return "not running" so that
    // checkRunningAnalysis (called during loadPR) does not set isAnalyzing=true,
    // which would prevent the auto-analyze flow from executing.
    // This is necessary because a prior test may have left the mock server's
    // analysisRunning flag in a stale state.
    await page.route('**/api/reviews/*/analyses/status', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ running: false, analysisId: null, status: null })
      });
    });

    // Intercept the analyze POST to confirm it fires
    const analyzeRequest = page.waitForRequest(
      request => request.url().includes('/api/pr/test-owner/test-repo/1/analyses') &&
                 request.method() === 'POST',
      { timeout: 10000 }
    );

    await page.goto('/pr/test-owner/test-repo/1?analyze=true');
    await waitForDiffToRender(page);

    // Verify the analysis POST was triggered
    await analyzeRequest;

    // Wait for replaceState to strip the analyze param from the URL.
    // The production code calls history.replaceState after startAnalysis resolves.
    await page.waitForFunction(() => {
      return !window.location.search.includes('analyze=true');
    }, { timeout: 5000 });

    // Verify the URL no longer contains the analyze parameter
    const url = new URL(page.url());
    expect(url.searchParams.has('analyze')).toBe(false);
    // Path should be preserved
    expect(url.pathname).toBe('/pr/test-owner/test-repo/1');
  });

  test('should not auto-trigger analysis without query param', async ({ page }) => {
    let analyzeRequested = false;

    page.on('request', request => {
      if (request.url().includes('/analyses') && request.method() === 'POST') {
        analyzeRequested = true;
      }
    });

    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Give a moment for any async triggers
    await page.waitForTimeout(1000);

    expect(analyzeRequested).toBe(false);
  });

  test('should not auto-trigger analysis when analyze param is not "true"', async ({ page }) => {
    let analyzeRequested = false;

    page.on('request', request => {
      if (request.url().includes('/analyses') && request.method() === 'POST') {
        analyzeRequested = true;
      }
    });

    await page.goto('/pr/test-owner/test-repo/1?analyze=false');
    await waitForDiffToRender(page);

    await page.waitForTimeout(1000);

    expect(analyzeRequested).toBe(false);
  });
});
