// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Tests for AI-suggestion dismissal-reason rendering.
 *
 * A dismissed AI suggestion may carry a `status_reason` (set by the loop/chat
 * agent when it dismisses a finding). It surfaces in three places:
 *   1. The expanded reply-styled note under the suggestion body
 *      (buildDismissalNoteHtml, rendered by both suggestion managers).
 *   2. The reasoning popover, appended as a "Dismissal" section beneath the
 *      reasoning bullets (buildReasoningPopoverContentHtml). The brain button
 *      that opens the popover renders whenever there is reasoning OR a reason,
 *      carrying the reason in an encoded data-dismissal-reason attribute.
 *   3. The AI panel finding item (AIPanel.renderFindingItem).
 *
 * The collapsed suggestion bar itself no longer shows the reason inline; the
 * dismissed/adopted state is signalled by a tooltip on the collapsed-content
 * container (setCollapsedStateTooltip). The shared builders live in
 * public/js/utils/suggestion-ui.js so the render paths stay in sync. When
 * status_reason is null the note and popover section must be omitted, and
 * reason text must be HTML-escaped / kept inert.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// markdown.js exports window.escapeHtmlAttribute (attribute-safe escaping used
// by AIPanel's title tooltip). Load it so the finding-item template can escape
// the reason for attribute context.
require('../../public/js/utils/markdown.js');
// Load the shared helpers first so window.SuggestionUI is populated before the
// card templates (which reference it at render time) run.
const SuggestionUI = require('../../public/js/utils/suggestion-ui.js');
const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');
const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');
const { AIPanel } = require('../../public/js/components/AIPanel.js');

describe('SuggestionUI dismissal-reason builders', () => {
  describe('buildDismissalNoteHtml', () => {
    it('returns a labeled note block when a reason is present', () => {
      const html = SuggestionUI.buildDismissalNoteHtml('Already handled upstream');
      expect(html).toContain('ai-dismissal-note');
      expect(html).toContain('ai-dismissal-note-label');
      expect(html).toContain(SuggestionUI.DISMISSAL_NOTE_LABEL);
      expect(html).toContain('Already handled upstream');
    });

    it('returns an empty string when the reason is null, undefined, or empty', () => {
      expect(SuggestionUI.buildDismissalNoteHtml(null)).toBe('');
      expect(SuggestionUI.buildDismissalNoteHtml(undefined)).toBe('');
      expect(SuggestionUI.buildDismissalNoteHtml('')).toBe('');
    });

    it('escapes HTML in the reason to prevent injection', () => {
      const html = SuggestionUI.buildDismissalNoteHtml('<img src=x onerror=alert(1)>');
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img');
    });
  });

  describe('buildReasoningPopoverContentHtml', () => {
    it('renders reasoning bullets and appends the Dismissal section when both are present', () => {
      const html = SuggestionUI.buildReasoningPopoverContentHtml(
        ['step one', 'step two'],
        'Out of scope'
      );
      expect(html).toContain('reasoning-popover-dismissal');
      expect(html).toContain(SuggestionUI.POPOVER_DISMISSAL_HEADING);
      expect(html).toContain('Out of scope');
      expect(html).toContain('step one');
      expect(html).toContain('step two');
    });

    it('renders only the Dismissal section when there is no reasoning', () => {
      const html = SuggestionUI.buildReasoningPopoverContentHtml(null, 'Reason only');
      expect(html).toContain('reasoning-popover-dismissal');
      expect(html).toContain('Reason only');
      // No reasoning bullet list is emitted.
      expect(html).not.toContain('<ul>');
      expect(html).not.toContain('<li>');
    });

    it('renders only reasoning when there is no dismissal reason', () => {
      const html = SuggestionUI.buildReasoningPopoverContentHtml(['only step'], '');
      expect(html).toContain('only step');
      expect(html).not.toContain('reasoning-popover-dismissal');
    });

    it('returns an empty string when neither reasoning nor reason is present', () => {
      expect(SuggestionUI.buildReasoningPopoverContentHtml(null, '')).toBe('');
      expect(SuggestionUI.buildReasoningPopoverContentHtml([], null)).toBe('');
    });

    it('keeps an XSS payload in the reason inert', () => {
      const html = SuggestionUI.buildReasoningPopoverContentHtml(
        null,
        '<img src=x onerror=alert(1)>'
      );
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img');
    });
  });

  describe('setCollapsedStateTooltip', () => {
    function makeCard() {
      const card = document.createElement('div');
      card.className = 'ai-suggestion collapsed';
      const collapsed = document.createElement('div');
      collapsed.className = 'ai-suggestion-collapsed-content';
      card.appendChild(collapsed);
      return { card, collapsed };
    }

    it('sets the tooltip on the collapsed-content container', () => {
      const { card, collapsed } = makeCard();
      SuggestionUI.setCollapsedStateTooltip(card, 'Dismissed');
      expect(collapsed.getAttribute('title')).toBe('Dismissed');
    });

    it('clears the tooltip when given a falsy label', () => {
      const { card, collapsed } = makeCard();
      collapsed.title = 'Adopted';
      SuggestionUI.setCollapsedStateTooltip(card, '');
      expect(collapsed.hasAttribute('title')).toBe(false);
    });

    it('is a no-op when the card or collapsed-content is missing', () => {
      expect(() => SuggestionUI.setCollapsedStateTooltip(null, 'Dismissed')).not.toThrow();
      const bare = document.createElement('div');
      expect(() => SuggestionUI.setCollapsedStateTooltip(bare, 'Dismissed')).not.toThrow();
    });
  });
});

describe('SuggestionUI.clearDismissalReasonUI', () => {
  // Build a realistic dismissed line-level card via the production template so
  // the helper is exercised against the exact markup it must clean up.
  function makeCard(suggestion) {
    const mgr = Object.create(SuggestionManager.prototype);
    mgr.prManager = { escapeHtml: (s) => String(s), userComments: [] };
    const row = mgr.createSuggestionRow([suggestion]);
    return row.querySelector('.ai-suggestion');
  }

  it('removes the reply-styled note and the reason-only brain button on restore', () => {
    const card = makeCard({
      id: 1,
      type: 'bug',
      title: 'Null deref',
      body: 'Body text',
      status: 'dismissed',
      status_reason: 'Guarded elsewhere'
      // no reasoning array -> brain button exists ONLY because of the reason
    });
    // Sanity: the dismissed markup is present before cleanup.
    expect(card.querySelector('.ai-dismissal-note')).not.toBeNull();
    expect(card.querySelector('.btn-reasoning-toggle')).not.toBeNull();

    SuggestionUI.clearDismissalReasonUI(card);

    // Note gone, and the reason-only brain buttons removed entirely.
    expect(card.querySelector('.ai-dismissal-note')).toBeNull();
    expect(card.querySelector('.btn-reasoning-toggle')).toBeNull();
    // No stale reason attr survives on any residual toggle.
    expect(card.querySelector('[data-dismissal-reason]')).toBeNull();
  });

  it('keeps a brain button that also carries reasoning but strips its dismissal reason', () => {
    const card = makeCard({
      id: 2,
      type: 'bug',
      title: 'Null deref',
      body: 'Body text',
      status: 'dismissed',
      status_reason: 'Guarded elsewhere',
      reasoning: ['step one', 'step two']
    });
    SuggestionUI.clearDismissalReasonUI(card);

    // The reasoning brain buttons survive (they still have reasoning steps)...
    const buttons = card.querySelectorAll('.btn-reasoning-toggle');
    expect(buttons.length).toBeGreaterThan(0);
    buttons.forEach(btn => {
      // ...but no longer advertise a dismissal reason.
      expect(btn.hasAttribute('data-dismissal-reason')).toBe(false);
      // The reasoning payload is untouched.
      expect(btn.dataset.reasoning).not.toBe('');
    });
    // And the expanded note is gone.
    expect(card.querySelector('.ai-dismissal-note')).toBeNull();
  });

  it('is a no-op on a null card or a card with no dismissal markup', () => {
    expect(() => SuggestionUI.clearDismissalReasonUI(null)).not.toThrow();
    const bare = document.createElement('div');
    expect(() => SuggestionUI.clearDismissalReasonUI(bare)).not.toThrow();
  });
});

describe('SuggestionManager.createSuggestionRow dismissal reason', () => {
  function makeManager() {
    const mgr = Object.create(SuggestionManager.prototype);
    mgr.prManager = { escapeHtml: (s) => String(s), userComments: [] };
    return mgr;
  }

  it('renders the reply-styled note for a dismissed suggestion but no inline collapsed reason', () => {
    const mgr = makeManager();
    const row = mgr.createSuggestionRow([{
      id: 1,
      type: 'bug',
      title: 'Null deref',
      body: 'Body text',
      status: 'dismissed',
      status_reason: 'Guarded elsewhere'
    }]);
    const html = row.innerHTML;
    expect(html).toContain('ai-dismissal-note');
    expect(html).toContain('Guarded elsewhere');
    // The collapsed bar no longer shows the reason inline.
    expect(html).not.toContain('collapsed-dismissal-reason');
    // The dismissed state is signalled via the collapsed-content tooltip.
    const collapsed = row.querySelector('.ai-suggestion-collapsed-content');
    expect(collapsed.getAttribute('title')).toBe('Dismissed');
    // The old inline state text is gone.
    expect(html).not.toContain('Hidden AI suggestion');
  });

  it('shows the reasoning brain button (carrying the reason) for a reason-only dismissal', () => {
    const mgr = makeManager();
    const row = mgr.createSuggestionRow([{
      id: 2,
      type: 'bug',
      title: 'Null deref',
      body: 'Body text',
      status: 'dismissed',
      status_reason: 'Guarded elsewhere'
      // no reasoning array
    }]);
    // Two templates render the button (expanded + collapsed); grab any.
    const btn = row.querySelector('.btn-reasoning-toggle');
    expect(btn).not.toBeNull();
    // The reason rides in the encoded data attribute, decodable back to source.
    expect(decodeURIComponent(btn.dataset.dismissalReason)).toBe('Guarded elsewhere');
    // No reasoning steps, so data-reasoning is empty.
    expect(btn.dataset.reasoning).toBe('');
  });

  it('renders no reasoning button when there is neither reasoning nor a reason', () => {
    const mgr = makeManager();
    const row = mgr.createSuggestionRow([{
      id: 3,
      type: 'bug',
      title: 'Active finding',
      body: 'Body',
      status: 'pending',
      status_reason: null
    }]);
    const html = row.innerHTML;
    expect(html).not.toContain('ai-dismissal-note');
    expect(html).not.toContain('collapsed-dismissal-reason');
    expect(row.querySelector('.btn-reasoning-toggle')).toBeNull();
  });

  it('escapes HTML in the rendered reason note (no live element injected)', () => {
    const mgr = makeManager();
    const row = mgr.createSuggestionRow([{
      id: 4,
      type: 'bug',
      title: 'X',
      body: 'B',
      status: 'dismissed',
      status_reason: '<script>bad()</script>'
    }]);
    // The reason must not create a real <script> element — it stays inert text.
    expect(row.querySelector('script')).toBeNull();
    const noteBody = row.querySelector('.ai-dismissal-note-body');
    expect(noteBody).not.toBeNull();
    expect(noteBody.textContent).toBe('<script>bad()</script>');
  });

  it('keeps a quote-breakout reason inert in the data-dismissal-reason attribute', () => {
    const mgr = makeManager();
    const payload = 'a" onmouseover="alert(1)';
    const row = mgr.createSuggestionRow([{
      id: 5,
      type: 'bug',
      title: 'X',
      body: 'B',
      status: 'dismissed',
      status_reason: payload
    }]);
    const btn = row.querySelector('.btn-reasoning-toggle');
    expect(btn).not.toBeNull();
    // encodeURIComponent escaped the quote, so jsdom parsed a single clean
    // attribute that round-trips back to the exact payload — no breakout,
    // no injected onmouseover handler.
    expect(decodeURIComponent(btn.dataset.dismissalReason)).toBe(payload);
    expect(btn.getAttribute('onmouseover')).toBeNull();
  });
});

describe('FileCommentManager.displayAISuggestion dismissal reason', () => {
  function makeZone() {
    const zone = document.createElement('div');
    zone.className = 'file-comments-zone';
    const container = document.createElement('div');
    container.className = 'file-comments-container';
    zone.appendChild(container);
    return zone;
  }

  function makeManager() {
    const mgr = Object.create(FileCommentManager.prototype);
    mgr.prManager = { userComments: [] };
    return mgr;
  }

  it('renders the note and the reason-carrying brain button, but no inline collapsed reason', () => {
    const mgr = makeManager();
    const zone = makeZone();
    mgr.displayAISuggestion(zone, {
      id: 10,
      type: 'bug',
      title: 'File issue',
      body: 'Body',
      status: 'dismissed',
      status_reason: 'Intentional pattern'
    });
    const container = zone.querySelector('.file-comments-container');
    const html = container.innerHTML;
    expect(html).toContain('ai-dismissal-note');
    expect(html).toContain('Intentional pattern');
    expect(html).not.toContain('collapsed-dismissal-reason');
    // Old inline state text is gone; state lives in the collapsed-content tooltip.
    expect(html).not.toContain('Hidden AI suggestion');
    const collapsed = container.querySelector('.ai-suggestion-collapsed-content');
    expect(collapsed.getAttribute('title')).toBe('Dismissed');
    // Brain button renders (reason-only) with the encoded reason.
    const btn = container.querySelector('.btn-reasoning-toggle');
    expect(btn).not.toBeNull();
    expect(decodeURIComponent(btn.dataset.dismissalReason)).toBe('Intentional pattern');
  });

  it('omits the note and the brain button when there is no reason', () => {
    const mgr = makeManager();
    const zone = makeZone();
    mgr.displayAISuggestion(zone, {
      id: 11,
      type: 'bug',
      title: 'File issue',
      body: 'Body',
      status: 'pending',
      status_reason: null
    });
    const container = zone.querySelector('.file-comments-container');
    const html = container.innerHTML;
    expect(html).not.toContain('ai-dismissal-note');
    expect(html).not.toContain('collapsed-dismissal-reason');
    expect(container.querySelector('.btn-reasoning-toggle')).toBeNull();
  });
});

describe('AIPanel.renderFindingItem dismissal reason', () => {
  function makePanel() {
    return Object.create(AIPanel.prototype);
  }

  it('adds a muted reason line and includes the reason in the item tooltip', () => {
    const panel = makePanel();
    const html = panel.renderFindingItem({
      id: 20,
      type: 'bug',
      title: 'Dismissed finding',
      file: 'src/app.js',
      line_start: 42,
      status: 'dismissed',
      status_reason: 'Handled by caller'
    }, 0);
    expect(html).toContain('finding-dismissal-reason');
    expect(html).toContain('Handled by caller');
    // Full reason appears in the item tooltip alongside the location.
    expect(html).toContain('title="app.js:42 — Handled by caller"');
  });

  it('does not render a reason line for a dismissed finding without a reason', () => {
    const panel = makePanel();
    const html = panel.renderFindingItem({
      id: 21,
      type: 'bug',
      title: 'Dismissed, no reason',
      file: 'src/app.js',
      line_start: 42,
      status: 'dismissed',
      status_reason: null
    }, 0);
    expect(html).not.toContain('finding-dismissal-reason');
  });

  it('does not render a reason line for an active finding even if status_reason is set', () => {
    const panel = makePanel();
    const html = panel.renderFindingItem({
      id: 22,
      type: 'bug',
      title: 'Active finding',
      file: 'src/app.js',
      line_start: 42,
      status: 'pending',
      status_reason: 'stray reason'
    }, 0);
    expect(html).not.toContain('finding-dismissal-reason');
    expect(html).not.toContain('stray reason');
  });

  it('escapes HTML in the reason line and tooltip', () => {
    const panel = makePanel();
    const html = panel.renderFindingItem({
      id: 23,
      type: 'bug',
      title: 'X',
      file: 'a.js',
      line_start: 1,
      status: 'dismissed',
      status_reason: '<b>x</b>'
    }, 0);
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('escapes double quotes in the title tooltip so the reason cannot break out of the attribute', () => {
    const panel = makePanel();
    const html = panel.renderFindingItem({
      id: 24,
      type: 'bug',
      title: 'X',
      file: 'a.js',
      line_start: 1,
      status: 'dismissed',
      status_reason: '" onmouseover="alert(1)'
    }, 0);
    // A raw double quote in the reason must be entity-escaped in the title
    // attribute; otherwise it would close the attribute and inject a handler.
    expect(html).not.toContain('title="a.js:1 — " onmouseover=');
    expect(html).toContain('&quot; onmouseover=&quot;alert(1)');
  });
});

describe('AIPanel.updateFindingStatus dismissal reason cleanup', () => {
  // Render a dismissed finding into a findingsList, then flip status and assert
  // the in-place DOM update strips the stale reason line and resets the tooltip.
  function makePanelWith(finding) {
    const panel = Object.create(AIPanel.prototype);
    panel.findings = [finding];
    const list = document.createElement('div');
    list.innerHTML = panel.renderFindingItem(finding, 0);
    panel.findingsList = list;
    return panel;
  }

  const dismissedFinding = {
    id: 30,
    type: 'bug',
    title: 'Dismissed finding',
    file: 'src/app.js',
    line_start: 42,
    status: 'dismissed',
    status_reason: 'Handled by caller'
  };

  it('removes the reason line and resets the tooltip when restored to active', () => {
    const panel = makePanelWith({ ...dismissedFinding });
    const findingEl = panel.findingsList.querySelector('[data-id="30"]');
    // Sanity: the dismissed state carries the reason line and reason tooltip.
    expect(findingEl.querySelector('.finding-dismissal-reason')).not.toBeNull();
    expect(findingEl.getAttribute('title')).toBe('app.js:42 — Handled by caller');

    panel.updateFindingStatus(30, 'active');

    expect(findingEl.querySelector('.finding-dismissal-reason')).toBeNull();
    // Tooltip resets to the plain location (matches renderFindingItem for active).
    expect(findingEl.getAttribute('title')).toBe('app.js:42');
    expect(findingEl.classList.contains('finding-active')).toBe(true);
  });

  it('also clears the reason line when the finding is adopted', () => {
    const panel = makePanelWith({ ...dismissedFinding });
    const findingEl = panel.findingsList.querySelector('[data-id="30"]');

    panel.updateFindingStatus(30, 'adopted');

    expect(findingEl.querySelector('.finding-dismissal-reason')).toBeNull();
    expect(findingEl.getAttribute('title')).toBe('app.js:42');
    expect(findingEl.classList.contains('finding-adopted')).toBe(true);
  });

  it('leaves the reason line in place while the finding stays dismissed', () => {
    const panel = makePanelWith({ ...dismissedFinding });
    const findingEl = panel.findingsList.querySelector('[data-id="30"]');

    panel.updateFindingStatus(30, 'dismissed');

    expect(findingEl.querySelector('.finding-dismissal-reason')).not.toBeNull();
    expect(findingEl.getAttribute('title')).toBe('app.js:42 — Handled by caller');
  });
});
