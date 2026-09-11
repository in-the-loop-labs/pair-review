// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

test('shows incomplete coverage without putting warnings in review comments', async ({ page }) => {
  await page.route('**/api/analyses/partial-run/status', route => route.fulfill({ json: {
    id: 'partial-run', status: 'completed', noLevels: true, suggestionsCount: 0,
    levels: { exec: { status: 'completed' } },
    warnings: ['Incident-memory verification did not complete.'],
  } }));
  await page.goto('/pr/test-owner/test-repo/1');
  await waitForDiffToRender(page);
  await page.evaluate(() => window.councilProgressModal.show('partial-run', null, null, { noLevels: true }));
  await expect(page.locator('.council-run-warnings')).toBeVisible();
  await expect(page.locator('.council-run-warnings')).toContainText('Incident-memory verification did not complete.');
  await expect(page.locator('.council-bg-btn')).toHaveText('Complete with limited coverage');
  await page.locator('.council-cancel-btn').click();
  await page.evaluate(() => window.reviewModal.show());
  await expect(page.locator('#review-body-modal')).not.toHaveValue(/Incident-memory/);
});

test('renders persisted coverage warnings safely in analysis history', async ({ page }) => {
  await page.goto('/pr/test-owner/test-repo/1');
  await waitForDiffToRender(page);
  await page.evaluate(() => {
    const manager = window.prManager.analysisHistoryManager;
    const preview = document.createElement('div');
    preview.id = 'persisted-coverage-preview';
    document.body.appendChild(preview);
    manager.previewPanel = preview;
    manager.runs = [{ id: 'partial', status: 'completed', model: 'default', provider: 'external',
      total_suggestions: 0, level_outcomes: { exec: 'partial', warnings: ['Check failed: <img src=x onerror=alert(1)>'] } }];
    manager.updatePreviewPanel('partial');
  });
  const preview = page.locator('#persisted-coverage-preview');
  await expect(preview).toContainText('Complete with limited coverage');
  await expect(preview).toContainText('Check failed: <img');
  await expect(preview.locator('img')).toHaveCount(0);
});
