// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Auto-Analyze Query Parameter
 *
 * Tests that navigating to a PR page with ?analyze=true
 * automatically refreshes PR data and triggers AI analysis without user interaction.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

test.describe('Auto-Analyze Query Parameter', () => {
  test('should skip refresh and auto-trigger analysis when ?analyze=true is present after fresh load', async ({ page }) => {
    // Track whether refresh was called (it should NOT be on first load since data is fresh)
    let refreshCalled = false;
    page.on('request', request => {
      if (request.url().includes('/api/pr/test-owner/test-repo/1/refresh') &&
          request.method() === 'POST') {
        refreshCalled = true;
      }
    });

    // Intercept the analyze POST request to verify it fires
    const analyzeRequest = page.waitForRequest(
      request => request.url().includes('/api/pr/test-owner/test-repo/1/analyses') &&
                 request.method() === 'POST',
      { timeout: 10000 }
    );

    await page.goto('/pr/test-owner/test-repo/1?analyze=true');
    await waitForDiffToRender(page);

    // Verify the analysis POST was triggered
    const analyze = await analyzeRequest;
    expect(analyze.method()).toBe('POST');

    // Refresh should NOT be called because loadPR just loaded fresh data
    expect(refreshCalled).toBe(false);
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

    // Intercept the analyze POST to confirm it fires (after the refresh)
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

    // Wait for all network activity to settle before asserting the negative
    await page.waitForLoadState('networkidle');

    expect(analyzeRequested).toBe(false);
  });

  test('should use stored bulk analysis config when analysisConfigId is present', async ({ page }) => {
    await page.route('**/api/reviews/*/analyses/status', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ running: false, analysisId: null, status: null })
      });
    });

    await page.route('**/api/bulk-analysis-configs/test-config', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          analysisConfig: {
            provider: 'gemini',
            model: 'gemini-2.5-pro',
            tier: 'thorough',
            customInstructions: 'Review all selected PRs for migration risk.',
            enabledLevels: [1, 2],
            skipLevel3: true,
            excludePrevious: { github: true, feedback: true }
          }
        })
      });
    });

    const analyzeRequest = page.waitForRequest(
      request => request.url().includes('/api/pr/test-owner/test-repo/1/analyses') &&
                 request.method() === 'POST',
      { timeout: 10000 }
    );

    await page.goto('/pr/test-owner/test-repo/1?analyze=true&analysisConfigId=test-config');
    await waitForDiffToRender(page);

    const request = await analyzeRequest;
    expect(request.postDataJSON()).toMatchObject({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      tier: 'thorough',
      customInstructions: 'Review all selected PRs for migration risk.',
      enabledLevels: [1, 2],
      skipLevel3: true,
      excludePrevious: { github: true, feedback: true }
    });

    await page.waitForFunction(() => {
      const params = new URLSearchParams(window.location.search);
      return !params.has('analyze') && !params.has('analysisConfigId');
    }, { timeout: 5000 });
  });

  test('should not fall back to defaults when requested bulk config is missing', async ({ page }) => {
    await page.route('**/api/reviews/*/analyses/status', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ running: false, analysisId: null, status: null })
      });
    });

    await page.route('**/api/bulk-analysis-configs/missing-config', route => {
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Bulk analysis config not found' })
      });
    });

    let analyzeRequested = false;
    page.on('request', request => {
      if (request.url().includes('/api/pr/test-owner/test-repo/1/analyses') && request.method() === 'POST') {
        analyzeRequested = true;
      }
    });

    await page.goto('/pr/test-owner/test-repo/1?analyze=true&analysisConfigId=missing-config');

    await expect(page.locator('.error-message')).toContainText('Could not load selected bulk analysis settings');
    expect(analyzeRequested).toBe(false);

    const url = new URL(page.url());
    expect(url.searchParams.get('analyze')).toBe('true');
    expect(url.searchParams.get('analysisConfigId')).toBe('missing-config');
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

    await page.waitForLoadState('networkidle');

    expect(analyzeRequested).toBe(false);
  });
});

test.describe('Auto-Analyze Query Parameter - Local Mode', () => {
  test('should auto-trigger analysis when ?analyze=true is present in local mode', async ({ page }) => {
    // Mock the local analysis endpoint so it returns immediately
    await page.route('**/api/local/2/analyses', route => {
      if (route.request().method() === 'POST') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            analysisId: 'test-local-analysis',
            status: 'started',
            message: 'AI analysis started in background'
          })
        });
      } else {
        route.continue();
      }
    });

    // Intercept the analyze POST request to verify it fires
    const analyzeRequest = page.waitForRequest(
      request => request.url().includes('/api/local/2/analyses') &&
                 request.method() === 'POST',
      { timeout: 10000 }
    );

    await page.goto('/local/2?analyze=true');
    await waitForDiffToRender(page);

    // Verify the analysis POST was triggered
    const analyze = await analyzeRequest;
    expect(analyze.method()).toBe('POST');
  });

  test('should not auto-trigger analysis in local mode without query param', async ({ page }) => {
    let analyzeRequested = false;

    page.on('request', request => {
      if (request.url().includes('/api/local/2/analyses') && request.method() === 'POST') {
        analyzeRequested = true;
      }
    });

    await page.goto('/local/2');
    await waitForDiffToRender(page);

    await page.waitForLoadState('networkidle');

    expect(analyzeRequested).toBe(false);
  });
});
