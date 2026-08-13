// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: File-council overlay (read-only councils from disk)
 *
 * Councils defined as council-document files in `~/.pair-review/councils/` are
 * served alongside DB councils but owned by the file: the API stamps them
 * `source: 'file'` and refuses PUT/DELETE, and the config tabs mark them
 * "(file)" and disable Save/Delete while leaving Save As (fork a copy) alive.
 *
 * The overlay is loaded once per process, so this spec drives the test server's
 * `/__test/reload-file-councils` hook: write a real .council.json into the
 * worker's own councils dir, reload it through the REAL loader, and — in
 * afterAll, which runs even on failure — remove it and reload again so later
 * specs on this worker see an empty overlay.
 */

import fs from 'fs/promises';
import path from 'path';
import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

const COUNCIL_NAME = 'E2E File Council';
// `<stem>.council.json` on disk becomes the id `file:<stem>`.
const COUNCIL_FILENAME = 'e2e-file-council.council.json';
const COUNCIL_ID = 'file:e2e-file-council';

const COUNCIL_DOCUMENT = {
  pair_review_council: 1,
  name: COUNCIL_NAME,
  type: 'council',
  description: 'Read-only council loaded from a file',
  config: {
    voices: [{ provider: 'claude', model: 'sonnet-4.6', role: 'Reviewer' }],
    levels: { 1: true, 2: true, 3: false }
  }
};

// Re-read the worker's councils dir through the real loader.
async function reloadFileCouncils(testServer) {
  const res = await fetch(`http://localhost:${testServer.port}/__test/reload-file-councils`, {
    method: 'POST'
  });
  expect(res.ok).toBeTruthy();
}

// Open the analysis config modal on the Council tab.
async function openCouncilTab(page) {
  const analyzeBtn = page.locator('#analyze-btn, button:has-text("Analyze")').first();
  await analyzeBtn.click();
  await page.locator('#analysis-config-modal').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.analysis-tab[data-tab="council"]').click();
  await page.locator('#tab-panel-council').waitFor({ state: 'visible', timeout: 3000 });
}

test.describe('Council file overlay', () => {
  test.beforeAll(async ({ testServer }) => {
    await fs.writeFile(
      path.join(testServer.councilsDir, COUNCIL_FILENAME),
      JSON.stringify(COUNCIL_DOCUMENT, null, 2),
      'utf8'
    );
    await reloadFileCouncils(testServer);
  });

  test.afterAll(async ({ testServer }) => {
    await fs.rm(path.join(testServer.councilsDir, COUNCIL_FILENAME), { force: true });
    await reloadFileCouncils(testServer);
  });

  test('GET /api/councils lists the file council with source: file', async ({ page }) => {
    const res = await page.request.get('/api/councils');
    expect(res.ok()).toBeTruthy();
    const { councils } = await res.json();

    const fileCouncil = councils.find(c => c.id === COUNCIL_ID);
    expect(fileCouncil).toBeTruthy();
    expect(fileCouncil.name).toBe(COUNCIL_NAME);
    expect(fileCouncil.source).toBe('file');
    expect(fileCouncil.readOnly).toBe(true);
    expect(fileCouncil.filePath).toContain(COUNCIL_FILENAME);
  });

  test('the council tab labels it "(file)" and refuses in-place edits', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openCouncilTab(page);

    // The read-only origin is visible in the selector itself.
    const fileOption = page.locator(`#vc-council-selector option[value="${COUNCIL_ID}"]`);
    await expect(fileOption).toHaveText(`${COUNCIL_NAME} (file)`);

    await page.locator('#vc-council-selector').selectOption(COUNCIL_ID);

    // Save/Delete would need a PUT/DELETE the API refuses — disabled up front.
    await expect(page.locator('#vc-council-save-btn')).toBeDisabled();
    await expect(page.locator('#vc-council-delete-btn')).toBeDisabled();
    // Save As POSTs a copy, so it stays available (the config is valid).
    await expect(page.locator('#vc-council-save-as-btn')).toBeEnabled();
  });

  test('Save As forks the file council into a writable db copy', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await openCouncilTab(page);

    await page.locator('#vc-council-selector').selectOption(COUNCIL_ID);
    await page.locator('#vc-council-save-as-btn').click();

    // The dialog must arrive pre-filled with a name that clears the duplicate
    // scan — offering the file council's own name would bounce the user
    // straight back and the fork could never complete.
    const nameInput = page.locator('#text-input-dialog-input');
    await expect(nameInput).toBeVisible({ timeout: 3000 });
    await expect(nameInput).toHaveValue(`${COUNCIL_NAME} (copy)`);

    const postPromise = page.waitForResponse(
      r => r.url().endsWith('/api/councils') && r.request().method() === 'POST'
    );
    await page.locator('#text-input-dialog-btn').click();
    const postRes = await postPromise;
    expect(postRes.status()).toBe(201);
    const createdId = (await postRes.json()).council.id;

    try {
      // The copy is a real db council: new id, outside the `file:` namespace.
      expect(createdId.startsWith('file:')).toBe(false);
      const copyOption = page.locator(`#vc-council-selector option[value="${createdId}"]`);
      await expect(copyOption).toHaveText(`${COUNCIL_NAME} (copy)`);
      // The file council is untouched and still read-only.
      await expect(
        page.locator(`#vc-council-selector option[value="${COUNCIL_ID}"]`)
      ).toHaveText(`${COUNCIL_NAME} (file)`);
    } finally {
      // Leave no db row behind for the other specs sharing this worker.
      await page.request.delete(`/api/councils/${createdId}`);
    }
  });

  test('PUT and DELETE on a file council id are rejected with 403', async ({ page }) => {
    const putRes = await page.request.put(`/api/councils/${COUNCIL_ID}`, {
      data: { name: 'Renamed By Test' }
    });
    expect(putRes.status()).toBe(403);
    expect((await putRes.json()).error).toBe(
      'This council is defined in a file and cannot be updated through the API. ' +
      'Change the file on disk instead.'
    );

    const deleteRes = await page.request.delete(`/api/councils/${COUNCIL_ID}`);
    expect(deleteRes.status()).toBe(403);
    expect((await deleteRes.json()).error).toBe(
      'This council is defined in a file and cannot be deleted through the API. ' +
      'Change the file on disk instead.'
    );

    // The refusal is not a soft delete — the council is still served.
    const listRes = await page.request.get('/api/councils');
    const { councils } = await listRes.json();
    expect(councils.some(c => c.id === COUNCIL_ID && c.name === COUNCIL_NAME)).toBe(true);
  });
});
