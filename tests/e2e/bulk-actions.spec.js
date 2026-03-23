// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Bulk Actions / Selection Mode
 *
 * Tests the selection mode UI on the index page:
 * - Entering/exiting selection mode via Select toggle button
 * - Checkbox injection and row selection
 * - Select All functionality
 * - Bulk action bar with count display
 * - Bulk delete with confirmation flow (PR and Local tabs)
 * - Escape key exits selection mode
 * - Tab switch exits selection mode
 */

import { test, expect } from './fixtures.js';

/**
 * Seed additional PR reviews into the test database so the PR table has
 * multiple rows for bulk selection tests.
 *
 * The default test data from test-server.js inserts 1 pr_metadata row
 * (pr_number=1, repo='test-owner/test-repo'). We add 2 more here.
 */
function seedExtraPRReviews(db) {
  const now = new Date().toISOString();
  const prData2 = JSON.stringify({
    state: 'open',
    diff: '',
    changed_files: [],
    additions: 5,
    deletions: 2,
    html_url: 'https://github.com/test-owner/test-repo/pull/2',
    base_sha: 'aaa111',
    head_sha: 'bbb222',
    node_id: 'PR_test_node_2'
  });
  const prData3 = JSON.stringify({
    state: 'open',
    diff: '',
    changed_files: [],
    additions: 10,
    deletions: 3,
    html_url: 'https://github.com/test-owner/test-repo/pull/3',
    base_sha: 'ccc333',
    head_sha: 'ddd444',
    node_id: 'PR_test_node_3'
  });

  db.prepare(`
    INSERT OR IGNORE INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data, last_accessed_at)
    VALUES (2, 'test-owner/test-repo', 'Second test PR', 'Description 2', 'user2', 'main', 'feature-2', ?, ?)
  `).run(prData2, now);

  db.prepare(`
    INSERT OR IGNORE INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data, last_accessed_at)
    VALUES (3, 'test-owner/test-repo', 'Third test PR', 'Description 3', 'user3', 'main', 'feature-3', ?, ?)
  `).run(prData3, now);
}

/**
 * Seed additional local review sessions so the Local tab has multiple rows.
 *
 * The default test data inserts 1 local review (review_type='local', id=2).
 * We add 2 more here.
 */
function seedExtraLocalSessions(db) {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO reviews (repository, status, review_type, local_path, local_head_sha, created_at, updated_at)
    VALUES ('test-repo-extra-1', 'draft', 'local', '/tmp/test-local-extra-1', 'sha_extra_1', ?, ?)
  `).run(now, now);

  db.prepare(`
    INSERT INTO reviews (repository, status, review_type, local_path, local_head_sha, created_at, updated_at)
    VALUES ('test-repo-extra-2', 'draft', 'local', '/tmp/test-local-extra-2', 'sha_extra_2', ?, ?)
  `).run(now, now);
}

/**
 * Wait for the PR tab's table to render with at least `minRows` data rows.
 */
async function waitForPRTable(page, minRows = 1) {
  await page.waitForSelector('#recent-reviews-tbody', { timeout: 10000 });
  await page.waitForFunction(
    (min) => {
      const tbody = document.getElementById('recent-reviews-tbody');
      return tbody && tbody.querySelectorAll('tr[data-review-id]').length >= min;
    },
    minRows,
    { timeout: 10000 }
  );
}

/**
 * Wait for the Local tab's table to render with at least `minRows` data rows.
 */
async function waitForLocalTable(page, minRows = 1) {
  await page.waitForSelector('#local-reviews-tbody', { timeout: 10000 });
  await page.waitForFunction(
    (min) => {
      const tbody = document.getElementById('local-reviews-tbody');
      return tbody && tbody.querySelectorAll('tr[data-session-id]').length >= min;
    },
    minRows,
    { timeout: 10000 }
  );
}

// ─── PR Tab: Selection Mode ──────────────────────────────────────────────────

test.describe('Bulk Actions - PR Tab', () => {
  test.beforeEach(async ({ page, testServer }) => {
    seedExtraPRReviews(testServer.db);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await waitForPRTable(page, 3);
  });

  test('Select button appears on PR tab', async ({ page }) => {
    const selectBtn = page.locator('.btn-select-toggle[data-selection-tab="pr-tab"]');
    await expect(selectBtn).toBeVisible();
    await expect(selectBtn).toHaveText('Select');
  });

  test('clicking Select enters selection mode with checkboxes', async ({ page }) => {
    const selectBtn = page.locator('.btn-select-toggle[data-selection-tab="pr-tab"]');
    await selectBtn.click();

    // Button text should change to Cancel
    await expect(selectBtn).toBeHidden();

    // Checkboxes should appear on rows
    const checkboxes = page.locator('#recent-reviews-tbody .col-select input[type="checkbox"]');
    const count = await checkboxes.count();
    expect(count).toBeGreaterThanOrEqual(3);

    // Select-all checkbox should appear in thead
    const selectAll = page.locator('#recent-reviews-container .select-all-checkbox');
    await expect(selectAll).toBeVisible();
  });

  test('clicking Cancel exits selection mode', async ({ page }) => {
    const selectBtn = page.locator('.btn-select-toggle[data-selection-tab="pr-tab"]');

    // Enter selection mode
    await selectBtn.click();
    await expect(selectBtn).toBeHidden();

    // Exit selection mode via inline Cancel button
    const cancelBtn = page.locator('#pr-tab .bulk-inline-actions > .btn-bulk-cancel');
    await cancelBtn.click();
    await expect(selectBtn).toHaveText('Select');
    await expect(selectBtn).toBeVisible();

    // Checkboxes should be gone
    const checkboxes = page.locator('#recent-reviews-tbody .col-select');
    await expect(checkboxes).toHaveCount(0);
  });

  test('selecting items enables action buttons', async ({ page }) => {
    const selectBtn = page.locator('.btn-select-toggle[data-selection-tab="pr-tab"]');
    await selectBtn.click();

    // Delete button starts disabled
    const deleteBtn = page.locator('#pr-tab .bulk-action-buttons .btn-bulk-delete');
    await expect(deleteBtn).toBeDisabled();

    // Click the first row's checkbox
    const firstCheckbox = page.locator('#recent-reviews-tbody .col-select input[type="checkbox"]').first();
    await firstCheckbox.check();

    // Delete button should now be enabled
    await expect(deleteBtn).toBeEnabled();

    // Row should have bulk-selected class
    const selectedRows = page.locator('#recent-reviews-tbody tr.bulk-selected');
    await expect(selectedRows).toHaveCount(1);
  });

  test('Select All checkbox selects all rows', async ({ page }) => {
    const selectBtn = page.locator('.btn-select-toggle[data-selection-tab="pr-tab"]');
    await selectBtn.click();

    // Count total rows
    const totalRows = await page.locator('#recent-reviews-tbody tr[data-review-id]').count();
    expect(totalRows).toBeGreaterThanOrEqual(3);

    // Click select-all
    const selectAll = page.locator('#recent-reviews-container .select-all-checkbox');
    await selectAll.check();

    // All rows should be selected
    const selectedRows = page.locator('#recent-reviews-tbody tr.bulk-selected');
    await expect(selectedRows).toHaveCount(totalRows);

    // Delete button should be enabled
    const deleteBtn = page.locator('#pr-tab .bulk-action-buttons .btn-bulk-delete');
    await expect(deleteBtn).toBeEnabled();
  });

  test('unchecking a row after Select All updates select-all state', async ({ page }) => {
    const selectBtn = page.locator('.btn-select-toggle[data-selection-tab="pr-tab"]');
    await selectBtn.click();

    // Select all
    const selectAll = page.locator('#recent-reviews-container .select-all-checkbox');
    await selectAll.check();

    // Uncheck the first row
    const firstCheckbox = page.locator('#recent-reviews-tbody .col-select input[type="checkbox"]').first();
    await firstCheckbox.uncheck();

    // Select-all should be unchecked (indeterminate)
    await expect(selectAll).not.toBeChecked();
  });

  test('bulk delete with confirmation deletes selected items', async ({ page }) => {
    const selectBtn = page.locator('.btn-select-toggle[data-selection-tab="pr-tab"]');
    await selectBtn.click();

    // Count rows before delete
    const rowsBefore = await page.locator('#recent-reviews-tbody tr[data-review-id]').count();
    expect(rowsBefore).toBeGreaterThanOrEqual(3);

    // Select 2 rows
    const checkboxes = page.locator('#recent-reviews-tbody .col-select input[type="checkbox"]');
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();

    // Click Delete button in action bar
    const deleteBtn = page.locator('#pr-tab .bulk-action-buttons .btn-bulk-delete');
    await deleteBtn.click();

    // Action bar should enter confirming state
    const actionBar = page.locator('#pr-tab .bulk-inline-actions.confirming');
    await expect(actionBar).toBeVisible();

    // Confirmation message should mention count
    const countEl = page.locator('#pr-tab .bulk-action-count');
    await expect(countEl).toContainText('Delete 2 review');

    // Click Confirm
    const confirmBtn = page.locator('#pr-tab .bulk-confirm-buttons .btn-bulk-delete');
    await confirmBtn.click();

    // Wait for table to reload with fewer rows
    const expectedMax = rowsBefore - 2;
    await page.waitForFunction(
      (max) => {
        const tbody = document.getElementById('recent-reviews-tbody');
        return tbody && tbody.querySelectorAll('tr[data-review-id]').length <= max;
      },
      expectedMax,
      { timeout: 10000 }
    );

    // Should have exactly rowsBefore - 2 rows
    const rowsAfter = await page.locator('#recent-reviews-tbody tr[data-review-id]').count();
    expect(rowsAfter).toBe(rowsBefore - 2);
  });

  test('bulk delete cancel returns to selection state', async ({ page }) => {
    const selectBtn = page.locator('.btn-select-toggle[data-selection-tab="pr-tab"]');
    await selectBtn.click();

    // Select a row
    const firstCheckbox = page.locator('#recent-reviews-tbody .col-select input[type="checkbox"]').first();
    await firstCheckbox.check();

    // Click Delete
    const deleteBtn = page.locator('#pr-tab .bulk-action-buttons .btn-bulk-delete');
    await deleteBtn.click();

    // Confirming state should be active
    const actionBar = page.locator('#pr-tab .bulk-inline-actions.confirming');
    await expect(actionBar).toBeVisible();

    // Click Cancel in confirm mode
    const cancelConfirmBtn = page.locator('#pr-tab .bulk-confirm-buttons .btn-bulk-cancel');
    await cancelConfirmBtn.click();

    // Should exit confirming state but remain in selection mode
    await expect(page.locator('#pr-tab .bulk-inline-actions.confirming')).not.toBeVisible();

    // Selection mode should still be active (checkboxes still present)
    const checkboxes = page.locator('#recent-reviews-tbody .col-select input[type="checkbox"]');
    const count = await checkboxes.count();
    expect(count).toBeGreaterThan(0);
  });
});

// ─── Local Tab: Selection Mode ───────────────────────────────────────────────

test.describe('Bulk Actions - Local Tab', () => {
  test.beforeEach(async ({ page, testServer }) => {
    seedExtraLocalSessions(testServer.db);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Switch to Local tab
    await page.click('#unified-tab-bar [data-tab="local-tab"]');
    await waitForLocalTable(page, 3);
  });

  test('Select button appears on Local tab', async ({ page }) => {
    const selectBtn = page.locator('.btn-select-toggle[data-selection-tab="local-tab"]');
    await expect(selectBtn).toBeVisible();
    await expect(selectBtn).toHaveText('Select');
  });

  test('selection mode works on Local tab', async ({ page }) => {
    const selectBtn = page.locator('.btn-select-toggle[data-selection-tab="local-tab"]');
    await selectBtn.click();

    // Button text changes
    await expect(selectBtn).toBeHidden();

    // Checkboxes appear
    const checkboxes = page.locator('#local-reviews-tbody .col-select input[type="checkbox"]');
    const count = await checkboxes.count();
    expect(count).toBeGreaterThanOrEqual(3);

    // Delete button starts disabled
    const deleteBtn = page.locator('#local-tab .bulk-action-buttons .btn-bulk-delete');
    await expect(deleteBtn).toBeDisabled();

    // Select a row
    await checkboxes.first().check();

    // Delete button should now be enabled
    await expect(deleteBtn).toBeEnabled();
  });

  test('bulk delete works on Local tab', async ({ page }) => {
    const selectBtn = page.locator('.btn-select-toggle[data-selection-tab="local-tab"]');
    await selectBtn.click();

    // Count rows before delete
    const rowsBefore = await page.locator('#local-reviews-tbody tr[data-session-id]').count();
    expect(rowsBefore).toBeGreaterThanOrEqual(3);

    // Select 2 rows
    const checkboxes = page.locator('#local-reviews-tbody .col-select input[type="checkbox"]');
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();

    // Click Delete
    const deleteBtn = page.locator('#local-tab .bulk-action-buttons .btn-bulk-delete');
    await deleteBtn.click();

    // Confirm
    const confirmBtn = page.locator('#local-tab .bulk-confirm-buttons .btn-bulk-delete');
    await confirmBtn.click();

    // Wait for table to reload with fewer rows
    const expectedMax = rowsBefore - 2;
    await page.waitForFunction(
      (max) => {
        const tbody = document.getElementById('local-reviews-tbody');
        return tbody && tbody.querySelectorAll('tr[data-session-id]').length <= max;
      },
      expectedMax,
      { timeout: 10000 }
    );

    // Should have exactly rowsBefore - 2 rows
    const rowsAfter = await page.locator('#local-reviews-tbody tr[data-session-id]').count();
    expect(rowsAfter).toBe(rowsBefore - 2);
  });
});

// ─── Cross-Tab Behaviors ─────────────────────────────────────────────────────

test.describe('Bulk Actions - Cross-Tab Behaviors', () => {
  test.beforeEach(async ({ page, testServer }) => {
    seedExtraPRReviews(testServer.db);
    seedExtraLocalSessions(testServer.db);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await waitForPRTable(page, 3);
  });

  test('Escape key exits selection mode', async ({ page }) => {
    const selectBtn = page.locator('.btn-select-toggle[data-selection-tab="pr-tab"]');
    await selectBtn.click();

    // Verify selection mode is active
    await expect(selectBtn).toBeHidden();
    const checkboxes = page.locator('#recent-reviews-tbody .col-select input[type="checkbox"]');
    const count = await checkboxes.count();
    expect(count).toBeGreaterThan(0);

    // Press Escape
    await page.keyboard.press('Escape');

    // Selection mode should be exited
    await expect(selectBtn).toHaveText('Select');
    await expect(page.locator('#recent-reviews-tbody .col-select')).toHaveCount(0);
  });

  test('tab switch exits selection mode', async ({ page }) => {
    // Enter selection mode on PR tab
    const prSelectBtn = page.locator('.btn-select-toggle[data-selection-tab="pr-tab"]');
    await prSelectBtn.click();
    await expect(prSelectBtn).toBeHidden();

    // Switch to Local tab
    await page.click('#unified-tab-bar [data-tab="local-tab"]');
    await waitForLocalTable(page, 3);

    // PR tab selection mode should be exited
    await expect(prSelectBtn).toHaveText('Select');

    // Switch back to PR tab to verify checkboxes are gone
    await page.click('#unified-tab-bar [data-tab="pr-tab"]');
    await expect(page.locator('#recent-reviews-tbody .col-select')).toHaveCount(0);
  });

  test('deselecting all items disables action buttons', async ({ page }) => {
    const selectBtn = page.locator('.btn-select-toggle[data-selection-tab="pr-tab"]');
    await selectBtn.click();

    // Select a row
    const firstCheckbox = page.locator('#recent-reviews-tbody .col-select input[type="checkbox"]').first();
    await firstCheckbox.check();

    // Delete button should be enabled
    const deleteBtn = page.locator('#pr-tab .bulk-action-buttons .btn-bulk-delete');
    await expect(deleteBtn).toBeEnabled();

    // Deselect the row
    await firstCheckbox.uncheck();

    // Delete button should be disabled
    await expect(deleteBtn).toBeDisabled();
  });

  test('clicking row in selection mode toggles checkbox (collection tab pattern)', async ({ page }) => {
    // This test verifies the PR tab checkbox toggle via direct checkbox click
    const selectBtn = page.locator('.btn-select-toggle[data-selection-tab="pr-tab"]');
    await selectBtn.click();

    // Click a checkbox to select
    const firstCheckbox = page.locator('#recent-reviews-tbody .col-select input[type="checkbox"]').first();
    await firstCheckbox.check();
    await expect(firstCheckbox).toBeChecked();

    // Verify row is marked selected
    const firstRow = page.locator('#recent-reviews-tbody tr[data-review-id]').first();
    await expect(firstRow).toHaveClass(/bulk-selected/);

    // Uncheck
    await firstCheckbox.uncheck();
    await expect(firstRow).not.toHaveClass(/bulk-selected/);
  });
});
