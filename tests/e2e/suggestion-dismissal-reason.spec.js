// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E: AI-suggestion dismissal-reason rendering.
 *
 * When the loop/chat agent dismisses an AI suggestion it records a
 * `status_reason`. The UI surfaces that reason as:
 *   - the expanded reply-styled note under the suggestion body (hidden while
 *     the card is collapsed)
 *   - a "Dismissal" section inside the reasoning popover (opened via the brain
 *     button on the collapsed card)
 *   - a muted second line on the finding item in the AI panel (+ tooltip)
 * The collapsed bar itself only carries a "Dismissed"/"Adopted" state tooltip.
 *
 * The reason is seeded directly via a test-only endpoint (global-setup.js)
 * because there is no UI affordance that produces a reason — human dismissals
 * are reason-less by design.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender, seedAISuggestions } from './helpers.js';

const REASON = 'Dismissed by the agent: guarded by an upstream null check.';
const TITLE = 'Seeded dismissed finding';

test.describe('AI suggestion dismissal reason', () => {
  test('renders the reason on the diff card and the AI panel finding', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Seed the active suggestions (creates the analysis run this dismissed
    // finding attaches to).
    await seedAISuggestions(page);

    // Seed a dismissed suggestion carrying a status_reason, then reload
    // suggestions so it flows through the normal fetch -> render path.
    const seed = await page.evaluate(async ({ reason, title }) => {
      const resp = await fetch('/test/seed-dismissed-suggestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status_reason: reason, title, file: 'src/utils.js', line_start: 3 })
      });
      if (!resp.ok) throw new Error(`seed failed: ${resp.status}`);
      const body = await resp.json();
      if (window.prManager?.loadAISuggestions) {
        await window.prManager.loadAISuggestions();
      }
      return body;
    }, { reason: REASON, title: TITLE });

    expect(seed.id).toBeTruthy();

    // --- Diff card: the collapsed bar no longer shows the reason inline ---
    const collapsedCard = page.locator('.ai-suggestion.collapsed', { hasText: TITLE }).first();
    await expect(collapsedCard).toBeVisible();
    await expect(collapsedCard.locator('.collapsed-dismissal-reason')).toHaveCount(0);
    // The dismissed state is signalled by a tooltip on the collapsed-content.
    await expect(collapsedCard.locator('.ai-suggestion-collapsed-content'))
      .toHaveAttribute('title', 'Dismissed');

    // --- Reasoning popover: the brain button reveals the Dismissal section ---
    const brainBtn = collapsedCard.locator('.btn-reasoning-toggle.collapsed-reasoning');
    await expect(brainBtn).toBeVisible();
    await brainBtn.click();
    const popover = page.locator('.reasoning-popover');
    await expect(popover).toBeVisible();
    await expect(popover.locator('.reasoning-popover-dismissal-heading')).toHaveText('Dismissal');
    await expect(popover.locator('.reasoning-popover-dismissal')).toContainText(REASON);

    // The expanded reply-styled note is present in the DOM (hidden while the
    // card is collapsed) and carries the full reason text.
    const note = page.locator('.ai-suggestion .ai-dismissal-note').first();
    await expect(note).toHaveCount(1);
    await expect(note.locator('.ai-dismissal-note-body')).toHaveText(REASON);
    await expect(note.locator('.ai-dismissal-note-label')).toBeAttached();

    // --- AI panel: dismissed finding shows the muted reason line + tooltip ---
    await page.evaluate(() => window.aiPanel?.expand());
    await page.waitForSelector('.finding-item', { timeout: 5000 });

    const dismissedFinding = page.locator('.finding-item.finding-dismissed', { hasText: TITLE }).first();
    await expect(dismissedFinding).toBeVisible();

    const reasonLine = dismissedFinding.locator('.finding-dismissal-reason');
    await expect(reasonLine).toBeVisible();
    await expect(reasonLine).toHaveText(REASON);

    // Full reason is in the finding-item tooltip alongside the location.
    const tooltip = await dismissedFinding.getAttribute('title');
    expect(tooltip).toContain(REASON);

    // --- Restore clears the baked-in reason UI on the originating tab ---
    // Same-tab suggestion broadcasts are suppressed, so no refetch rescues these
    // cards; the restore paths must strip the stale reason markup in place.
    await page.evaluate(async (id) => {
      await window.prManager.restoreSuggestion(id);
    }, seed.id);

    const restoredCard = page.locator(`.ai-suggestion[data-suggestion-id="${seed.id}"]`).first();
    await expect(restoredCard).not.toHaveClass(/\bcollapsed\b/);
    // The reply-styled note is gone and the reason-only brain button is removed.
    await expect(restoredCard.locator('.ai-dismissal-note')).toHaveCount(0);
    await expect(restoredCard.locator('.btn-reasoning-toggle')).toHaveCount(0);

    // The AI panel finding drops its reason line and resets its tooltip.
    const restoredFinding = page.locator(`.finding-item[data-id="${seed.id}"]`).first();
    await expect(restoredFinding.locator('.finding-dismissal-reason')).toHaveCount(0);
    const restoredTooltip = await restoredFinding.getAttribute('title');
    expect(restoredTooltip || '').not.toContain(REASON);
  });
});
