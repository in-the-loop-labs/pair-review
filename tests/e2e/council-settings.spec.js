// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Councils section on the global settings page
 *
 * `/settings` now hosts a full council CRUD surface (CouncilManager) inline,
 * which means the settings page loads the analysis config tabs, the shared
 * dialogs, the council document/export/CRUD helpers and their stylesheets for
 * the first time. Two independently written pieces meet here (the component and
 * the host page), so this spec exercises the real page rather than the unit
 * seams:
 *
 *   1. The section renders, and its nav item sits before Chat Snippets with
 *      Repositories still terminal (the scrollspy's bottom guard depends on it).
 *   2. Every script/stylesheet the new section needs actually resolves, and the
 *      globals they publish are all defined — a 404 or a missing global would
 *      silently hide the section behind the `typeof CouncilManager` guard, and a
 *      spec that only asserted "the list is empty" would still pass.
 *   3. Create / Edit / Duplicate / Delete round-trips through the hosted tab,
 *      driven through the MANAGER'S FOOTER — the hosted tab renders no write
 *      buttons of its own (`hosted: true`), so the footer is the only surface
 *      that can PUT or POST from this page.
 *   4. File councils (the read-only `~/.pair-review/councils/` overlay) render a
 *      File badge with Duplicate + Export but no Edit and no Delete.
 *   5. Leaving the editor dirty asks before discarding.
 *   6. The page header keeps its own sizing now that analysis-config.css is
 *      loaded here (regression pin for the 3a scoping fix).
 *
 * Every test attaches page-error / console-error / failed-request collectors, so
 * a silent JS exception on the settings page fails the test that provoked it.
 *
 * Councils live in the per-worker E2E DB, shared with other specs on the same
 * worker (`testServer` is worker-scoped and `fullyParallel` is false), so the
 * cleanup below is SYMMETRIC: every test starts AND ends with an empty council
 * table. Clearing only on the way in protects this spec from its predecessors
 * while leaving a dozen rows behind for everything that runs after it — the
 * invariant council-file-overlay.spec.js and council-save-button.spec.js both
 * maintain. File councils are left alone; the API refuses to delete them.
 */

import fs from 'fs/promises';
import path from 'path';
import { test, expect } from './fixtures.js';

// ─── File-council fixture (own filename so it can never collide with
// council-file-overlay.spec.js if both land on the same worker) ──────────────
const FILE_COUNCIL_NAME = 'E2E Settings File Council';
const FILE_COUNCIL_FILENAME = 'e2e-settings-file-council.council.json';
const FILE_COUNCIL_DOCUMENT = {
  pair_review_council: 1,
  name: FILE_COUNCIL_NAME,
  type: 'council',
  description: 'Read-only council loaded from a file',
  config: {
    voices: [{ provider: 'claude', model: 'sonnet-4.6', role: 'Reviewer' }],
    levels: { 1: true, 2: true, 3: false }
  }
};

const voiceCouncilConfig = {
  voices: [{ provider: 'claude', model: 'sonnet-4.6', role: 'Reviewer' }],
  levels: { 1: true, 2: true, 3: false }
};

const advancedCouncilConfig = {
  levels: {
    1: { enabled: true, voices: [{ provider: 'claude', model: 'sonnet-4.6' }] },
    2: { enabled: false, voices: [] },
    3: { enabled: false, voices: [] }
  }
};

/**
 * Collect anything that would make the page silently broken: uncaught
 * exceptions, console errors, and any request the page made that failed.
 * Returned arrays are live — assert on them after the interaction.
 */
function watchForPageProblems(page) {
  const problems = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  page.on('pageerror', (error) => {
    problems.pageErrors.push(error && error.stack ? error.stack : String(error));
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.consoleErrors.push(msg.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      problems.failedRequests.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    problems.failedRequests.push(`FAILED ${request.method()} ${request.url()}`);
  });
  return problems;
}

/** Nothing blew up: no uncaught error, no console error, no failed request. */
function expectNoPageProblems(problems) {
  expect(problems.pageErrors).toEqual([]);
  expect(problems.consoleErrors).toEqual([]);
  expect(problems.failedRequests).toEqual([]);
}

/**
 * Delete every DB council. `file:` ids are read-only and are skipped.
 *
 * ONE TRANSPORT for every fixture call in this spec: `page.request`, never
 * `page.evaluate(fetch)`. It is the only one that works from the hook that
 * needs it — `beforeEach`/`afterEach` run with the page on `about:blank`
 * (before the first `goto`, and after a test that failed before navigating),
 * where a relative `fetch` inside the page has no origin to resolve against.
 * The trade-off is that fixture traffic is invisible to `watchForPageProblems`,
 * which is deliberate: a 4xx from teardown is a fixture bug, not the page
 * misbehaving, and it should not land in an unrelated test's error budget.
 * Both calls below assert their own status instead.
 */
async function clearDbCouncils(page) {
  const res = await page.request.get('/api/councils');
  if (!res.ok()) return;
  const { councils } = await res.json();
  for (const council of councils || []) {
    if (String(council.id).startsWith('file:')) continue;
    const deleted = await page.request.delete(`/api/councils/${council.id}`);
    expect(deleted.ok(), `cleanup failed for council ${council.id}`).toBeTruthy();
  }
}

/** Create a council through the API and return its id. */
async function seedCouncil(page, body) {
  const res = await page.request.post('/api/councils', { data: body });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).council.id;
}

/** Open /settings and wait for the council list to finish its first paint. */
async function openSettingsCouncils(page) {
  await page.goto('/settings');
  await expect(page.locator('#councils-section')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#councils-manager .council-manager__list-wrap')).toBeVisible({ timeout: 10000 });
}

/**
 * The row wrapper for a council, addressed by its EXACT visible name — a
 * substring match would make "X" also match its own "X (copy)".
 */
function councilRow(page, name) {
  const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return page.locator('.council-manager__row-wrap').filter({
    has: page.locator('.council-manager__name').filter({ hasText: exact })
  });
}

// Symmetric, file-level, and therefore stated ONCE. `page` is test-scoped, so
// the trailing half has to be afterEach — an afterAll would run with a page
// that no longer exists.
test.beforeEach(async ({ page }) => {
  await clearDbCouncils(page);
});

test.afterEach(async ({ page }) => {
  await clearDbCouncils(page);
});

test.describe('Settings councils - section wiring', () => {
  test('renders the Councils section and navigates before Chat Snippets', async ({ page }) => {
    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    // Section is really there (not hidden by the load-failure guard).
    const section = page.locator('#councils-section');
    await expect(section).toBeVisible();
    await expect(section.locator('.section-header h2')).toHaveText('Councils');
    await expect(section).not.toHaveCSS('display', 'none');

    // Empty state + the Add affordance both come from CouncilManager.
    await expect(page.locator('.council-manager__empty')).toHaveText('No councils yet.');
    await expect(page.locator('.council-manager__add-btn')).toBeVisible();

    // Nav order: … → Councils → Chat Snippets → Repositories (terminal).
    const navList = page.locator('#settings-nav-list');
    await expect(navList.locator('.settings-nav-item').first()).toBeVisible({ timeout: 10000 });
    const targets = await navList.locator('.settings-nav-item').evaluateAll(
      els => els.map(el => el.dataset.target)
    );
    expect(targets).toContain('councils-section');
    expect(targets.indexOf('councils-section')).toBeLessThan(targets.indexOf('snippets-section'));
    expect(targets[targets.length - 1]).toBe('repos-section');
    await expect(
      navList.locator('.settings-nav-item[data-target="councils-section"]')
    ).toHaveText(/Councils/);

    expectNoPageProblems(problems);
  });

  test('every script and stylesheet the section needs loads and publishes its global', async ({ page }) => {
    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    // A 404 on any of these would leave the section hidden (CouncilManager
    // guard) or blow up mid-flow (the tabs call these unguarded).
    const globals = await page.evaluate(() => ({
      CouncilManager: typeof window.CouncilManager,
      VoiceCentricConfigTab: typeof window.VoiceCentricConfigTab,
      AdvancedConfigTab: typeof window.AdvancedConfigTab,
      TimeoutSelect: typeof window.TimeoutSelect,
      CouncilDropdown: typeof window.CouncilDropdown,
      CouncilCard: typeof window.CouncilCard,
      CouncilDocument: typeof window.CouncilDocument,
      CouncilExport: typeof window.CouncilExport,
      CouncilCrud: typeof window.CouncilCrud,
      ProviderMap: typeof window.ProviderMap,
      toast: typeof window.toast,
      confirmDialog: typeof window.confirmDialog,
      textInputDialog: typeof window.textInputDialog,
      // AnalysisConfigModal must NOT be on this page — the tab element ids are
      // page-global and only one owner per page is allowed.
      AnalysisConfigModal: typeof window.AnalysisConfigModal
    }));

    expect(globals).toEqual({
      CouncilManager: 'function',
      VoiceCentricConfigTab: 'function',
      AdvancedConfigTab: 'function',
      TimeoutSelect: 'function',
      CouncilDropdown: 'function',
      CouncilCard: 'function',
      CouncilDocument: 'object',
      CouncilExport: 'object',
      CouncilCrud: 'object',
      ProviderMap: 'object',
      toast: 'object',
      confirmDialog: 'object',
      textInputDialog: 'object',
      AnalysisConfigModal: 'undefined'
    });

    // Every stylesheet the page links resolved (a 404 would have been recorded
    // above, but assert the CSSOM sees rules for the new ones too).
    const sheetRuleCounts = await page.evaluate(() => {
      const wanted = ['council-manager.css', 'analysis-config.css', 'confirm-dialog.css'];
      const out = {};
      for (const name of wanted) {
        const sheet = Array.from(document.styleSheets).find(s => (s.href || '').includes(name));
        out[name] = sheet ? sheet.cssRules.length : -1;
      }
      return out;
    });
    for (const [name, count] of Object.entries(sheetRuleCounts)) {
      expect(count, `${name} should be loaded with rules`).toBeGreaterThan(0);
    }

    expectNoPageProblems(problems);
  });

  test('the page header keeps its own sizing with analysis-config.css loaded', async ({ page }) => {
    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    // Regression pin for the 3a scoping fix: analysis-config.css used to define
    // unscoped .header-icon (40px) / .header-subtitle (12px) rules that shrank
    // the settings page header once that stylesheet was linked here.
    const icon = page.locator('.page-header .header-icon');
    await expect(icon).toHaveCSS('width', '56px');
    await expect(icon).toHaveCSS('height', '56px');
    await expect(page.locator('.page-header .header-subtitle')).toHaveCSS('font-size', '14px');

    expectNoPageProblems(problems);
  });
});

test.describe('Settings councils - create', () => {
  test('Add → Council mounts the voice-centric tab and saves a new council', async ({ page }) => {
    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    await page.locator('.council-manager__add-btn').click();

    // Step 1: the type chooser.
    await expect(page.locator('.council-manager__chooser')).toBeVisible();
    await page.locator('.council-manager__chooser-council').click();

    // Step 2: the hosted VoiceCentricConfigTab, in its own panel.
    const panel = page.locator('#tab-panel-council');
    await expect(panel).toBeVisible();
    await expect(page.locator('#tab-panel-advanced')).toHaveCount(0);
    // The tab's own council <select> still renders — it is where the pending
    // default council id gets applied, so an Edit depends on it …
    await expect(panel.locator('.council-selector-row #vc-council-selector')).toBeVisible();
    // … but NOT its Save / Save As / Export / Delete buttons: a hosted tab
    // leaves every write to the manager's footer, so there is exactly one write
    // surface on this page.
    await expect(panel.locator('#vc-council-save-btn')).toHaveCount(0);
    await expect(panel.locator('#vc-council-save-as-btn')).toHaveCount(0);
    await expect(panel.locator('#vc-council-export-btn')).toHaveCount(0);
    await expect(panel.locator('#vc-council-delete-btn')).toHaveCount(0);
    // The per-review "This Review" block goes with them: there is no review to
    // attach instructions to on a global settings page.
    await expect(panel.locator('#vc-custom-instructions')).toHaveCount(0);
    await expect(panel.locator('#vc-repo-instructions-banner')).toHaveCount(0);

    // Providers loaded into the reviewer row (setProviders ran before reset).
    const providerSelect = panel.locator('#vc-reviewer-list .voice-provider').first();
    await expect.poll(() => providerSelect.locator('option').count()).toBeGreaterThan(0);
    const modelSelect = panel.locator('#vc-reviewer-list .voice-model').first();
    await expect.poll(() => modelSelect.locator('option').count()).toBeGreaterThan(0);

    // The tier control works.
    const tier = panel.locator('#vc-reviewer-list .voice-tier').first();
    await tier.selectOption('thorough');
    await expect(tier).toHaveValue('thorough');

    // The TimeoutSelect components mounted and are interactive. They start
    // collapsed behind the per-reviewer clock icon, exactly as in the modal.
    const timeout = panel.locator('#vc-reviewer-list .timeout-select').first();
    await expect(timeout).toBeHidden();
    await panel.locator('#vc-reviewer-list .toggle-timeout-icon').first().click();
    await expect(timeout).toBeVisible();
    await timeout.locator('.timeout-select-trigger').click();
    await expect(timeout).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await expect(timeout).not.toHaveClass(/open/);

    // CouncilManager's own footer Save: no council selected yet, so the shared
    // CRUD falls through to Save As and prompts for a name.
    const postPromise = page.waitForResponse(
      r => r.url().endsWith('/api/councils') && r.request().method() === 'POST'
    );
    await page.locator('.council-manager__save-btn').click();

    const nameInput = page.locator('#text-input-dialog-input');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('E2E Created Council');
    await page.locator('#text-input-dialog-btn').click();
    const postRes = await postPromise;
    // Surface the API's rejection reason instead of a bare status mismatch.
    const postBody = await postRes.text();
    expect(postRes.status(), postBody).toBe(201);

    // REGRESSION: the reviewer row must survive the round-trip. The tabs' own
    // fallback model id is an alias that is not an <option> value, so before
    // CouncilManager seeded a real default pair the model <select> selected
    // nothing, `_readConfigFromUI` dropped the only reviewer, and the API
    // rejected `voices: []` with 400 — every new council failed to save.
    const created = JSON.parse(postBody).council;
    expect(created.config.voices).toHaveLength(1);
    expect(created.config.voices[0].provider).toBeTruthy();
    expect(created.config.voices[0].model).toBeTruthy();
    expect(created.config.voices[0].tier).toBe('thorough');

    // Back in list mode with the new council present and badged Standard.
    const row = councilRow(page, 'E2E Created Council');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.council-type-badge.badge-standard')).toHaveText('Standard');
    await expect(page.locator('#tab-panel-council')).toHaveCount(0);

    // onChange refreshed the "Default for Analysis" picker without a reload.
    const councilRowSetting = page.locator('.setting-row[data-key="default_council_id"]');
    await councilRowSetting.locator('.custom-dropdown-trigger').click();
    await expect(
      councilRowSetting.locator('.custom-dropdown-option', { hasText: 'E2E Created Council' })
    ).toHaveCount(1);

    expectNoPageProblems(problems);
  });

  test('cancelling the name prompt keeps the editor open and creates nothing', async ({ page }) => {
    // REGRESSION GUARD, documented in `_saveFromEditor`: success used to be
    // inferred from `tab.isDirty` going false, and a brand-new editor is
    // ALREADY clean — so Add council → Save → cancel read as "saved", exited to
    // the list and fired onChange for a council that was never created. Only
    // council-crud's explicit boolean may unlock the exit.
    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    let posted = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/councils') && request.method() === 'POST') posted += 1;
    });

    await page.locator('.council-manager__add-btn').click();
    await page.locator('.council-manager__chooser-council').click();
    await expect(page.locator('#tab-panel-council #vc-council-selector')).toBeVisible();

    await page.locator('.council-manager__save-btn').click();
    const dialog = page.locator('#text-input-dialog-input');
    await expect(dialog).toBeVisible();
    await page.locator('#text-input-dialog .modal-footer [data-action="cancel"]').click();
    await expect(dialog).toBeHidden();

    // Still in the editor, with nothing written and nothing in the list.
    await expect(page.locator('#tab-panel-council')).toBeVisible();
    await expect(page.locator('.council-manager__list-wrap')).toHaveCount(0);
    // The footer is usable again — a refused save must not wedge it.
    await expect(page.locator('.council-manager__save-btn')).toBeEnabled();
    expect(posted).toBe(0);

    await page.locator('.council-manager__back-btn').click();
    await expect(page.locator('.council-manager__empty')).toBeVisible();

    expectNoPageProblems(problems);
  });

  test('the footer Save is disabled until the hosted tab has finished loading', async ({ page }) => {
    // THE RACE THIS BRANCH FIXES. `setDefaultCouncilId` only records a PENDING
    // id; `selectedCouncilId` is not assigned until `_renderCouncilSelector`
    // runs at the END of `loadCouncils`. A Save inside that window failed
    // council-crud's selection test and POSTed a NEW council out of default
    // config while the header read "Edit council".
    const id = await seedCouncil(page, {
      name: 'E2E Slow Load Council',
      type: 'council',
      config: voiceCouncilConfig
    });

    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    // Hold the tab's council fetch open. The manager's own first load already
    // happened above, so this delay lands on the editor mount.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/councils', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await held;
      await route.continue();
    });

    await councilRow(page, 'E2E Slow Load Council').locator('.council-manager__edit-btn').click();

    const saveBtn = page.locator('.council-manager__save-btn');
    await expect(page.locator('#tab-panel-council')).toBeVisible();
    await expect(saveBtn).toBeDisabled();
    // Back stays available — there is nothing dirty to lose yet.
    await expect(page.locator('.council-manager__back-btn')).toBeEnabled();

    // Disabled is the visible half. Force the attribute off and click anyway:
    // the handler must still be INERT, because the tab it would save is not
    // published until the mount resolves. If it were live, this click would
    // fall through to Save As and open the name prompt.
    let posted = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/councils') && request.method() === 'POST') posted += 1;
    });
    await saveBtn.evaluate(el => { el.disabled = false; });
    await saveBtn.click();
    await expect(page.locator('#text-input-dialog-input')).toBeHidden();
    expect(posted).toBe(0);
    await expect(page.locator('.council-manager__editor-header')).toHaveText('Edit council');

    release();
    await expect(page.locator('#tab-panel-council #vc-council-selector')).toHaveValue(id);
    await expect(saveBtn).toBeEnabled();
    await page.unroute('**/api/councils');

    expectNoPageProblems(problems);
  });

  test('Add → Advanced mounts the level-centric tab', async ({ page }) => {
    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    await page.locator('.council-manager__add-btn').click();
    await page.locator('.council-manager__chooser-advanced').click();

    const panel = page.locator('#tab-panel-advanced');
    await expect(panel).toBeVisible();
    await expect(page.locator('#tab-panel-council')).toHaveCount(0);
    await expect(panel.locator('.council-selector-row #council-selector')).toBeVisible();

    expectNoPageProblems(problems);
  });
});

test.describe('Settings councils - edit', () => {
  test('editing a voice-centric council opens the Council tab pre-selected', async ({ page }) => {
    const id = await seedCouncil(page, {
      name: 'E2E Standard Council',
      type: 'council',
      config: voiceCouncilConfig
    });

    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    const row = councilRow(page, 'E2E Standard Council');
    await expect(row.locator('.council-type-badge.badge-standard')).toHaveText('Standard');
    await row.locator('.council-manager__edit-btn').click();

    const selector = page.locator('#tab-panel-council #vc-council-selector');
    await expect(selector).toBeVisible();
    await expect(selector).toHaveValue(id);
    // The footer Save is live once the mount resolved — that (not any button
    // inside the panel) is what performs the in-place PUT.
    await expect(page.locator('.council-manager__save-btn')).toBeEnabled();

    expectNoPageProblems(problems);
  });

  test('the footer Save updates the council in place and returns to the list', async ({ page }) => {
    // The edit → dirty → footer Save → PUT → auto-exit flow was uncovered: the
    // only click on `.council-manager__save-btn` in this spec was the CREATE
    // path with no council selected, which deliberately forks to Save As. The
    // PUT the spec did observe came from the tab's in-panel button, which does
    // not run `_saveFromEditor`, does not exit and does not fire onChange —
    // and no longer exists when hosted.
    const id = await seedCouncil(page, {
      name: 'E2E Inplace Save',
      type: 'council',
      config: voiceCouncilConfig
    });

    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);
    await councilRow(page, 'E2E Inplace Save').locator('.council-manager__edit-btn').click();

    const panel = page.locator('#tab-panel-council');
    await expect(panel.locator('#vc-council-selector')).toHaveValue(id);
    // Barrier on the state that actually decides PUT vs Save As. The <select>'s
    // value and `tab.selectedCouncilId` are assigned together in
    // `_renderCouncilSelector` (the only other way the value becomes `id` is a
    // restore of a value that already was `id`), so the assertion above already
    // implies this one — it is stated anyway because a name prompt on in-place
    // Save is the F2 signature, and this makes a recurrence name its own cause
    // instead of surfacing as a surprising dialog five lines later.
    await expect.poll(() => page.evaluate(
      () => window.settingsPage?._councilManager?._tab?.selectedCouncilId ?? null
    )).toBe(id);

    // Dirty the editor through a real control.
    await panel.locator('#vc-reviewer-list .voice-tier').first().selectOption('thorough');

    const putPromise = page.waitForResponse(
      r => r.url().includes(`/api/councils/${id}`) && r.request().method() === 'PUT'
    );
    await page.locator('.council-manager__save-btn').click();
    const putRes = await putPromise;
    expect(putRes.status(), await putRes.text()).toBe(200);

    // An in-place save NEVER prompts for a name — that is the Save As fork, and
    // taking it here would create a duplicate council instead of updating one.
    // (The dialog's DOM is built at page load and merely hidden, so this is a
    // visibility assertion, not a count one.)
    await expect(page.locator('#text-input-dialog-input')).toBeHidden();
    // The save exits to the list, with the row still there (and still one row).
    await expect(page.locator('#tab-panel-council')).toHaveCount(0);
    await expect(page.locator('.council-manager__list-wrap')).toBeVisible();
    await expect(councilRow(page, 'E2E Inplace Save')).toHaveCount(1);
    await expect(page.locator('.council-manager__row-wrap')).toHaveCount(1);

    // The write really landed: the tier survived the round trip.
    const stored = await page.request.get(`/api/councils`);
    const { councils } = await stored.json();
    expect(councils.find(c => c.id === id).config.voices[0].tier).toBe('thorough');

    // onChange fired, so the Default-for-Analysis picker refreshed in place.
    const councilRowSetting = page.locator('.setting-row[data-key="default_council_id"]');
    await councilRowSetting.locator('.custom-dropdown-trigger').click();
    await expect(
      councilRowSetting.locator('.custom-dropdown-option', { hasText: 'E2E Inplace Save' })
    ).toHaveCount(1);

    expectNoPageProblems(problems);
  });

  test('editing a legacy untyped council opens the Advanced tab pre-selected', async ({ page }) => {
    // No `type` — legacy rows are level-centric and belong to the Advanced tab.
    const id = await seedCouncil(page, {
      name: 'E2E Legacy Council',
      config: advancedCouncilConfig
    });

    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    const row = councilRow(page, 'E2E Legacy Council');
    // A legacy row badges as what it actually is — and as what Edit opens.
    await expect(row.locator('.council-type-badge.badge-advanced')).toHaveText('Advanced');
    await row.locator('.council-manager__edit-btn').click();

    const selector = page.locator('#tab-panel-advanced #council-selector');
    await expect(selector).toBeVisible();
    await expect(selector).toHaveValue(id);
    await expect(page.locator('#tab-panel-council')).toHaveCount(0);

    expectNoPageProblems(problems);
  });

  test('Edit on a council deleted elsewhere refuses instead of forking a new one', async ({ page }) => {
    // Reachable any time a second browser tab (or another process) removes the
    // council between this page's list paint and the editor's own load. The GET
    // succeeds, so nothing reports a failure — but the tab cannot select the
    // council, and an editor left up in that state labels itself "Edit council"
    // over a null selection: the next Save prompts for a name and POSTs a NEW
    // council. That name prompt is the F2 signature, and this is the door the
    // publish-late fix alone does not close.
    const id = await seedCouncil(page, {
      name: 'E2E Vanishing Council',
      type: 'council',
      config: voiceCouncilConfig
    });

    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);
    const row = councilRow(page, 'E2E Vanishing Council');
    await expect(row).toHaveCount(1);

    // Gone from under the rendered row.
    const deleted = await page.request.delete(`/api/councils/${id}`);
    expect(deleted.ok()).toBeTruthy();

    let posted = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/councils') && request.method() === 'POST') posted += 1;
    });

    await row.locator('.council-manager__edit-btn').click();

    // Back on the list, with the reason stated.
    await expect(page.locator('.council-manager__list-wrap')).toBeVisible();
    await expect(page.locator('#tab-panel-council')).toHaveCount(0);
    await expect(page.locator('.council-manager__error'))
      .toHaveText('That council is no longer available.');
    // No half-open editor means no way to reach the name prompt at all.
    await expect(page.locator('#text-input-dialog-input')).toBeHidden();
    expect(posted).toBe(0);

    // The page's own toast reported it (this one is raised by production, so it
    // carries the default lifetime — assert its text, not its geometry).
    await expect(page.locator('#toast-container .toast.toast-error'))
      .toHaveText('Failed to open the council editor');

    expectNoPageProblems(problems);
  });

  test('the hosted panel offers no write buttons of its own, on either tab', async ({ page }) => {
    // The tab used to render its own Save / Save As / Export / Delete row here,
    // giving the page TWO write surfaces — and the manager could only infer the
    // panel's writes from a {id, name, updated_at} fingerprint of the list,
    // which SQLite's one-second `updated_at` hid same-second edits from. One
    // surface, one explicit signal: the inference is gone, so the row must be
    // too, on BOTH tabs.
    const vcId = await seedCouncil(page, { name: 'E2E Panel VC', type: 'council', config: voiceCouncilConfig });
    const advId = await seedCouncil(page, { name: 'E2E Panel Adv', config: advancedCouncilConfig });

    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    await councilRow(page, 'E2E Panel VC').locator('.council-manager__edit-btn').click();
    const vcPanel = page.locator('#tab-panel-council');
    // WAIT FOR THE SELECTED VALUE, not merely for the <select> to exist. The
    // element is there from `inject()`, but `_renderCouncilSelector` runs at the
    // END of the tab's load and finishes with `_applyConfigToUI(council.config)`
    // + `_markClean()` — so an edit made before that repaint is silently
    // reverted AND un-dirtied, and the Back below then finds a clean editor and
    // leaves without the discard prompt this test asserts.
    await expect(vcPanel.locator('#vc-council-selector')).toHaveValue(vcId);
    for (const id of ['#vc-council-save-btn', '#vc-council-save-as-btn',
      '#vc-council-export-btn', '#vc-council-delete-btn']) {
      await expect(vcPanel.locator(id)).toHaveCount(0);
    }
    // Everything the editor is FOR still works: the reviewer controls.
    await vcPanel.locator('#vc-reviewer-list .voice-tier').first().selectOption('thorough');
    await expect(vcPanel.locator('#vc-reviewer-list .voice-tier').first()).toHaveValue('thorough');

    await page.locator('.council-manager__back-btn').click();
    const dialog = page.locator('#confirm-dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('#confirm-dialog-btn').click();
    await expect(page.locator('.council-manager__list-wrap')).toBeVisible();

    await councilRow(page, 'E2E Panel Adv').locator('.council-manager__edit-btn').click();
    const advPanel = page.locator('#tab-panel-advanced');
    await expect(advPanel.locator('#council-selector')).toHaveValue(advId);
    for (const id of ['#council-save-btn', '#council-save-as-btn',
      '#council-export-btn', '#council-delete-btn']) {
      await expect(advPanel.locator(id)).toHaveCount(0);
    }

    expectNoPageProblems(problems);
  });

  test('Back with unsaved changes asks before discarding', async ({ page }) => {
    const id = await seedCouncil(page, {
      name: 'E2E Dirty Council',
      type: 'council',
      config: voiceCouncilConfig
    });

    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);
    await councilRow(page, 'E2E Dirty Council').locator('.council-manager__edit-btn').click();
    // The selected VALUE, not mere visibility: the mount's final
    // `_applyConfigToUI` + `_markClean` would otherwise wipe the reviewer added
    // below, along with the dirty flag this test depends on.
    await expect(page.locator('#tab-panel-council #vc-council-selector')).toHaveValue(id);

    // Adding a reviewer marks the tab dirty.
    await page.locator('#vc-add-reviewer-btn').click();
    await expect(page.locator('#vc-reviewer-list .vc-reviewer')).toHaveCount(2);

    // Cancel keeps the editor (and the edit) alive.
    await page.locator('.council-manager__back-btn').click();
    const dialog = page.locator('#confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#confirm-dialog-message')).toHaveText('Discard unsaved changes?');
    await dialog.locator('.modal-footer [data-action="cancel"]').click();
    await expect(page.locator('#tab-panel-council')).toBeVisible();
    await expect(page.locator('#vc-reviewer-list .vc-reviewer')).toHaveCount(2);

    // Confirm discards and returns to the list.
    await page.locator('.council-manager__back-btn').click();
    await expect(dialog).toBeVisible();
    await dialog.locator('#confirm-dialog-btn').click();
    await expect(page.locator('#tab-panel-council')).toHaveCount(0);
    await expect(councilRow(page, 'E2E Dirty Council')).toHaveCount(1);

    expectNoPageProblems(problems);
  });

  test('re-entering the editor never leaves two tab panels on the page', async ({ page }) => {
    // The config tabs query hardcoded, page-global ids. Every editor open builds
    // a fresh tab instance, so a leaked panel would give those ids two owners.
    const vcId = await seedCouncil(page, { name: 'E2E Reentry VC', type: 'council', config: voiceCouncilConfig });
    const advId = await seedCouncil(page, { name: 'E2E Reentry Adv', config: advancedCouncilConfig });

    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    for (const [name, panelId, selectorId, id] of [
      ['E2E Reentry VC', '#tab-panel-council', '#vc-council-selector', vcId],
      ['E2E Reentry Adv', '#tab-panel-advanced', '#council-selector', advId],
      ['E2E Reentry VC', '#tab-panel-council', '#vc-council-selector', vcId]
    ]) {
      await councilRow(page, name).locator('.council-manager__edit-btn').click();
      await expect(page.locator(panelId)).toHaveCount(1);
      // Each pass leaves through Back, so wait for the mount to finish before
      // leaving: otherwise the loop races an in-flight mount against the next
      // open, and only the manager's editor-epoch guard keeps the panels
      // straight — which is a fix to exercise deliberately, not by accident.
      await expect(page.locator(selectorId)).toHaveValue(id);
      await expect(page.locator('#tab-panel-council')).toHaveCount(panelId === '#tab-panel-council' ? 1 : 0);
      await expect(page.locator('#tab-panel-advanced')).toHaveCount(panelId === '#tab-panel-advanced' ? 1 : 0);
      await page.locator('.council-manager__back-btn').click();
      await expect(page.locator('.council-manager__list-wrap')).toBeVisible();
    }

    expectNoPageProblems(problems);
  });

  test('Back from a clean editor returns to the list without a prompt', async ({ page }) => {
    const id = await seedCouncil(page, {
      name: 'E2E Clean Council',
      type: 'council',
      config: voiceCouncilConfig
    });

    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);
    await councilRow(page, 'E2E Clean Council').locator('.council-manager__edit-btn').click();
    // A fully mounted editor, so "clean" means the tab really settled clean
    // rather than not having loaded yet.
    await expect(page.locator('#tab-panel-council #vc-council-selector')).toHaveValue(id);

    await page.locator('.council-manager__back-btn').click();
    await expect(page.locator('#tab-panel-council')).toHaveCount(0);
    await expect(page.locator('#confirm-dialog')).toBeHidden();
    await expect(councilRow(page, 'E2E Clean Council')).toHaveCount(1);

    expectNoPageProblems(problems);
  });
});

test.describe('Settings councils - duplicate and delete', () => {
  test('Duplicate prefills "<name> (copy)" and creates a second council', async ({ page }) => {
    await seedCouncil(page, {
      name: 'E2E Dup Source',
      type: 'council',
      config: voiceCouncilConfig
    });

    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    const postPromise = page.waitForResponse(
      r => r.url().endsWith('/api/councils') && r.request().method() === 'POST'
    );
    await councilRow(page, 'E2E Dup Source').locator('.council-manager__duplicate-btn').click();

    const nameInput = page.locator('#text-input-dialog-input');
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue('E2E Dup Source (copy)');
    await page.locator('#text-input-dialog-btn').click();
    expect((await postPromise).status()).toBe(201);

    await expect(councilRow(page, 'E2E Dup Source (copy)')).toHaveCount(1);
    await expect(councilRow(page, 'E2E Dup Source')).toHaveCount(1);

    expectNoPageProblems(problems);
  });

  test('Delete asks with the styled confirm dialog; cancel keeps the row', async ({ page }) => {
    await seedCouncil(page, {
      name: 'E2E Delete Me',
      type: 'council',
      config: voiceCouncilConfig
    });

    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    const row = councilRow(page, 'E2E Delete Me');
    await row.locator('.council-manager__delete-btn').click();

    // The STYLED dialog, not the native confirm (settings.html now loads
    // ConfirmDialog.js + confirm-dialog.css).
    const dialog = page.locator('#confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#confirm-dialog-title')).toHaveText('Delete Council');
    await expect(dialog.locator('#confirm-dialog-message')).toHaveText(
      'Are you sure you want to delete "E2E Delete Me"?'
    );

    // Cancel is a no-op.
    await dialog.locator('.modal-footer [data-action="cancel"]').click();
    await expect(dialog).toBeHidden();
    await expect(row).toHaveCount(1);

    // Confirm removes the row.
    const deletePromise = page.waitForResponse(
      r => r.url().includes('/api/councils/') && r.request().method() === 'DELETE'
    );
    await row.locator('.council-manager__delete-btn').click();
    await expect(dialog).toBeVisible();
    await dialog.locator('#confirm-dialog-btn').click();
    expect((await deletePromise).ok()).toBeTruthy();

    await expect(councilRow(page, 'E2E Delete Me')).toHaveCount(0);
    await expect(page.locator('.council-manager__empty')).toBeVisible();

    expectNoPageProblems(problems);
  });

  test('a row expands into a CouncilCard preview', async ({ page }) => {
    await seedCouncil(page, {
      name: 'E2E Preview Council',
      type: 'council',
      config: voiceCouncilConfig
    });

    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    const row = councilRow(page, 'E2E Preview Council');
    await expect(row.locator('.council-manager__preview')).toHaveCount(0);
    await row.locator('.council-manager__row-main').click();

    const card = row.locator('.council-manager__preview .council-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.council-card-reviewer')).toHaveCount(1);

    // Toggles back closed.
    await row.locator('.council-manager__row-main').click();
    await expect(row.locator('.council-manager__preview')).toHaveCount(0);

    expectNoPageProblems(problems);
  });
});

test.describe('Settings councils - toasts stay on screen', () => {
  // REGRESSION (integration review, defect 1): /settings renders TWO toast
  // implementations into one #toast-container — the shared Toast component
  // (window.toast, which CouncilManager and the hosted tabs message through)
  // and SettingsPage#showToast. Both stamp the bare `.toast` class, and
  // settings.css loads after pr.css, so its unqualified
  // `.toast { transform: translateX(120%) }` beat pr.css's `.toast-show` on
  // source order. Every CouncilManager message rendered at opacity 1, parked
  // off the right edge of the viewport: "A council with that name already
  // exists.", "Council duplicated/deleted/exported", every "Failed to …".
  //
  // Playwright's toBeVisible() passes for an off-viewport element, so these
  // assert the BOX and the computed opacity, not visibility.
  /**
   * Where the toast actually is, read in ONE page.evaluate against the DOM node.
   *
   * Deliberately not `locator.boundingBox()`: that auto-waits for an attached,
   * visible element, and both toast implementations remove themselves on a
   * timer (4s here, 5s for window.toast). Once the element vanishes mid-assert
   * the boundingBox promise simply never settles — `expect.poll`'s own budget
   * cannot interrupt a pending call — and the test hangs to the 30s test
   * timeout, reported as a generic timeout with no hint of the cause. Reading
   * the node directly turns a vanished toast into `{ removed: true }`: an
   * instant, readable diff.
   *
   * Asserts "on screen", not a specific axis — the container is top-centre and
   * the entry animation's axis is settings.css's business, not this spec's.
   */
  async function toastGeometry(page, selector) {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { removed: true };
      const box = el.getBoundingClientRect();
      return {
        insideLeft: box.left >= 0,
        insideRight: Math.round(box.right) <= window.innerWidth,
        insideTop: box.top >= 0,
        insideBottom: Math.round(box.bottom) <= window.innerHeight,
        hasSize: box.width > 0 && box.height > 0
      };
    }, selector);
  }

  const ON_SCREEN = {
    insideLeft: true, insideRight: true, insideTop: true, insideBottom: true, hasSize: true
  };

  test('a window.toast message renders inside the viewport, not off the right edge', async ({ page }) => {
    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    // A minute-long toast: the element cannot expire out from under the poll,
    // so the only thing this can fail on is the geometry it is testing.
    await page.evaluate(() => window.toast.showWarning('A council with that name already exists.', 60000));

    const selector = '#toast-container .toast.toast-warning';
    const toast = page.locator(selector);
    await expect(toast).toHaveText('A council with that name already exists.');
    await expect(toast).toHaveCSS('opacity', '1');
    await expect.poll(() => toastGeometry(page, selector), { timeout: 3000 }).toEqual(ON_SCREEN);

    expectNoPageProblems(problems);
  });

  test("the settings page's own toast also renders inside the viewport", async ({ page }) => {
    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    await page.evaluate(() => window.settingsPage.showToast('success', 'Theme saved'));

    const selector = '#toast-container .toast.settings-toast';
    const toast = page.locator(selector);
    await expect(toast).toContainText('Theme saved');
    // pr.css zeroes `.toast` opacity and reveals with `toast-show`, which this
    // implementation never adds — the scoped `.toast.settings-toast.show` rule
    // has to restore it.
    await expect(toast).toHaveCSS('opacity', '1');
    await expect.poll(() => toastGeometry(page, selector), { timeout: 3000 }).toEqual(ON_SCREEN);
    // Its dismiss button is reachable (the shared container is pointer-events:none).
    // Bounded to 1s so only the CLICK can satisfy this: showToast's own
    // setTimeout removes the node after 4s + a 300ms fade, so the default 10s
    // expect timeout passed whether or not the close handler did anything —
    // including in the exact regression this test exists to guard, the
    // container's `pointer-events: none` swallowing the target.
    await toast.locator('[data-role="toast-close"]').click();
    await expect(toast).toHaveCount(0, { timeout: 1000 });

    expectNoPageProblems(problems);
  });

  test('a duplicate-name collision surfaces its warning to the user', async ({ page }) => {
    // The end-to-end consequence: CouncilManager re-opens the name prompt on a
    // collision, and the only explanation is a window.toast warning.
    await seedCouncil(page, {
      name: 'E2E Toast Source',
      type: 'council',
      config: voiceCouncilConfig
    });

    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    await councilRow(page, 'E2E Toast Source').locator('.council-manager__duplicate-btn').click();
    const nameInput = page.locator('#text-input-dialog-input');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('e2e toast source'); // same name, different case
    await page.locator('#text-input-dialog-btn').click();

    // Production raises this one, so it carries the default 5s lifetime — the
    // geometry read above returns { removed: true } rather than hanging if the
    // poll ever loses that race.
    const selector = '#toast-container .toast.toast-warning';
    const toast = page.locator(selector);
    await expect(toast).toHaveText('A council with that name already exists.');
    await expect.poll(() => toastGeometry(page, selector), { timeout: 3000 }).toEqual(ON_SCREEN);
    // The prompt is re-offered with what the user typed, still on screen.
    await expect(nameInput).toHaveValue('e2e toast source');

    expectNoPageProblems(problems);
  });
});

test.describe('Settings councils - file overlay', () => {
  test.beforeAll(async ({ testServer }) => {
    await fs.writeFile(
      path.join(testServer.councilsDir, FILE_COUNCIL_FILENAME),
      JSON.stringify(FILE_COUNCIL_DOCUMENT, null, 2),
      'utf8'
    );
    const res = await fetch(`http://localhost:${testServer.port}/__test/reload-file-councils`, {
      method: 'POST'
    });
    expect(res.ok).toBeTruthy();
  });

  test.afterAll(async ({ testServer }) => {
    await fs.rm(path.join(testServer.councilsDir, FILE_COUNCIL_FILENAME), { force: true });
    const res = await fetch(`http://localhost:${testServer.port}/__test/reload-file-councils`, {
      method: 'POST'
    });
    expect(res.ok).toBeTruthy();
  });

  test('a file council shows the File badge with no Edit and no Delete', async ({ page }) => {
    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    const row = councilRow(page, FILE_COUNCIL_NAME);
    await expect(row).toHaveCount(1);
    await expect(row.locator('.council-type-badge.badge-file')).toHaveText('File');
    await expect(row.locator('.council-type-badge.badge-file')).toHaveAttribute(
      'title',
      new RegExp(FILE_COUNCIL_FILENAME.replace('.', '\\.'))
    );
    await expect(row.locator('.council-manager__description')).toHaveText(
      'Read-only council loaded from a file'
    );

    // The API refuses PUT/DELETE on file ids, so those buttons are never drawn.
    await expect(row.locator('.council-manager__edit-btn')).toHaveCount(0);
    await expect(row.locator('.council-manager__delete-btn')).toHaveCount(0);
    // Forking and exporting stay available.
    await expect(row.locator('.council-manager__duplicate-btn')).toBeVisible();
    await expect(row.locator('.council-manager__export-btn')).toBeVisible();

    expectNoPageProblems(problems);
  });

  test('Export downloads a council document for a file council', async ({ page }) => {
    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    const downloadPromise = page.waitForEvent('download');
    await councilRow(page, FILE_COUNCIL_NAME).locator('.council-manager__export-btn').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.council\.json$/);

    expectNoPageProblems(problems);
  });

  test('Duplicate forks a file council into a writable DB council', async ({ page }) => {
    const problems = watchForPageProblems(page);
    await openSettingsCouncils(page);

    const postPromise = page.waitForResponse(
      r => r.url().endsWith('/api/councils') && r.request().method() === 'POST'
    );
    await councilRow(page, FILE_COUNCIL_NAME).locator('.council-manager__duplicate-btn').click();

    const nameInput = page.locator('#text-input-dialog-input');
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue(`${FILE_COUNCIL_NAME} (copy)`);
    await page.locator('#text-input-dialog-btn').click();
    const postRes = await postPromise;
    expect(postRes.status()).toBe(201);
    expect((await postRes.json()).council.id.startsWith('file:')).toBe(false);

    // The copy is a normal DB council: it gets Edit and Delete.
    const copy = councilRow(page, `${FILE_COUNCIL_NAME} (copy)`);
    await expect(copy).toHaveCount(1);
    await expect(copy.locator('.council-manager__edit-btn')).toBeVisible();
    await expect(copy.locator('.council-manager__delete-btn')).toBeVisible();
    // The original is untouched and still read-only.
    await expect(councilRow(page, FILE_COUNCIL_NAME).locator('.council-manager__edit-btn')).toHaveCount(0);

    expectNoPageProblems(problems);
  });
});
