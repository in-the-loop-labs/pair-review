// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * E2E Tests: Council Save Button
 *
 * Regression test for bug where clicking the footer save button on an existing
 * council would prompt for a name instead of saving directly. The cause was
 * both VoiceCentricConfigTab and AdvancedConfigTab registering handlers on
 * the same footer save button — the inactive tab's handler had no
 * selectedCouncilId and fell through to _saveCouncilAs().
 */

import { test, expect } from '@playwright/test';
import { waitForDiffToRender } from './helpers.js';

// Helper: seed a council via API and return its id
async function seedCouncil(page, { name, type, config }) {
  return page.evaluate(async ({ name, type, config }) => {
    const res = await fetch('/api/councils', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, config })
    });
    if (!res.ok) throw new Error(`Seed council failed: ${res.status}`);
    const data = await res.json();
    return data.council.id;
  }, { name, type, config });
}

// Helper: delete all councils via API (cleanup)
async function cleanupCouncils(page) {
  await page.evaluate(async () => {
    const res = await fetch('/api/councils');
    if (!res.ok) return;
    const { councils } = await res.json();
    for (const c of councils) {
      await fetch(`/api/councils/${c.id}`, { method: 'DELETE' });
    }
  });
}

// Helper: open the analysis config modal and switch to a tab
async function openConfigModalTab(page, tabId) {
  const analyzeBtn = page.locator('#analyze-btn, button:has-text("Analyze")').first();
  await analyzeBtn.click();
  const configModal = page.locator('#analysis-config-modal');
  await configModal.waitFor({ state: 'visible', timeout: 5000 });
  await page.locator(`.analysis-tab[data-tab="${tabId}"]`).click();
  // Wait for the tab panel to be visible
  await page.locator(`#tab-panel-${tabId}`).waitFor({ state: 'visible', timeout: 3000 });
}

// Valid voice-centric council config
const voiceCouncilConfig = {
  voices: [
    { provider: 'claude', model: 'sonnet', role: 'Reviewer' }
  ],
  levels: { 1: true, 2: true, 3: false }
};

// Valid advanced (level-centric) council config
const advancedCouncilConfig = {
  levels: {
    1: { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] },
    2: { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] },
    3: { enabled: false, voices: [] }
  }
};

test.describe('Council Save Button', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupCouncils(page);
  });

  test('saving an existing voice-centric council should NOT prompt for a name', async ({ page }) => {
    // Seed a council
    const councilId = await seedCouncil(page, {
      name: 'Test Voice Council',
      type: 'council',
      config: voiceCouncilConfig
    });

    // Open modal and switch to Council tab
    await openConfigModalTab(page, 'council');

    // Select the seeded council from the dropdown
    await page.locator('#vc-council-selector').selectOption(councilId);

    // Change a reviewer dropdown to trigger dirty state.
    // Note: #vc-custom-instructions has data-no-dirty (it's per-review, not part of
    // the saved council config), so we must use a select to reliably mark dirty.
    const tierSelect = page.locator('#tab-panel-council .voice-tier').first();
    await tierSelect.selectOption('thorough');

    // Wait for footer save to appear
    const footerSave = page.locator('#council-footer-save-btn');
    await footerSave.waitFor({ state: 'visible', timeout: 3000 });

    // Set up response listener for PUT (update existing) BEFORE clicking
    const putPromise = page.waitForResponse(
      response => response.url().includes(`/api/councils/${councilId}`) && response.request().method() === 'PUT',
      { timeout: 5000 }
    );

    // Click the footer save button
    await footerSave.click();

    // Verify PUT was called (meaning it saved the existing council)
    const putResponse = await putPromise;
    expect(putResponse.ok()).toBeTruthy();

    // Verify the TextInputDialog did NOT appear
    const nameDialog = page.locator('#text-input-dialog');
    await expect(nameDialog).toBeHidden();
  });

  test('saving an existing advanced council should NOT prompt for a name', async ({ page }) => {
    // Seed an advanced council
    const councilId = await seedCouncil(page, {
      name: 'Test Advanced Council',
      type: 'advanced',
      config: advancedCouncilConfig
    });

    // Open modal and switch to Advanced tab
    await openConfigModalTab(page, 'advanced');

    // Select the seeded council from the dropdown
    await page.locator('#council-selector').selectOption(councilId);

    // Change a voice dropdown to trigger dirty state.
    // Note: #council-custom-instructions has data-no-dirty (per-review, not council config).
    const tierSelect = page.locator('#tab-panel-advanced .voice-tier').first();
    await tierSelect.selectOption('thorough');

    // Wait for footer save to appear
    const footerSave = page.locator('#council-footer-save-btn');
    await footerSave.waitFor({ state: 'visible', timeout: 3000 });

    // Set up response listener for PUT
    const putPromise = page.waitForResponse(
      response => response.url().includes(`/api/councils/${councilId}`) && response.request().method() === 'PUT',
      { timeout: 5000 }
    );

    // Click the footer save button
    await footerSave.click();

    // Verify PUT was called
    const putResponse = await putPromise;
    expect(putResponse.ok()).toBeTruthy();

    // Verify the TextInputDialog did NOT appear
    const nameDialog = page.locator('#text-input-dialog');
    await expect(nameDialog).toBeHidden();
  });

  test('saving a new council (no selection) should prompt for a name', async ({ page }) => {
    // Open modal and switch to Council tab — starts with "New Council" selected
    await openConfigModalTab(page, 'council');

    // Change a reviewer dropdown (voice-tier) to trigger dirty state.
    // The custom instructions textarea has data-no-dirty, so we must use a select.
    const tierSelect = page.locator('#tab-panel-council .voice-tier').first();
    await tierSelect.selectOption('thorough');

    // The footer save should appear
    const footerSave = page.locator('#council-footer-save-btn');
    await footerSave.waitFor({ state: 'visible', timeout: 3000 });

    // Click the footer save button
    await footerSave.click();

    // Verify the TextInputDialog DID appear (should prompt for name on new council)
    const nameDialog = page.locator('#text-input-dialog');
    await expect(nameDialog).toBeVisible({ timeout: 3000 });

    // Cancel the dialog using the Cancel button specifically
    await page.locator('#text-input-dialog button.btn-secondary').click();
    await expect(nameDialog).toBeHidden();
  });

  test('save button should have blue styling class', async ({ page }) => {
    // Seed a council so we can select it and trigger dirty state reliably
    const councilId = await seedCouncil(page, {
      name: 'Style Test Council',
      type: 'council',
      config: voiceCouncilConfig
    });

    // Open modal and switch to Council tab
    await openConfigModalTab(page, 'council');

    // Select the council and change a dropdown to trigger dirty state
    await page.locator('#vc-council-selector').selectOption(councilId);
    const tierSelect = page.locator('#tab-panel-council .voice-tier').first();
    await tierSelect.selectOption('thorough');

    // Footer save should appear
    const footerSave = page.locator('#council-footer-save-btn');
    await footerSave.waitFor({ state: 'visible', timeout: 3000 });

    // Verify it has the blue save button class
    await expect(footerSave).toHaveClass(/btn-save-council/);

    // Also verify the in-tab save button has the class
    const inTabSave = page.locator('#vc-council-save-btn');
    await expect(inTabSave).toHaveClass(/btn-save-council/);
  });
});
