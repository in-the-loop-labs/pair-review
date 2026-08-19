// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for AnalysisConfigModal's three tab panels: the ids it names them
 * with, and the character-count recount it owes the panel it reveals.
 *
 * PANEL IDS. The modal spells `tab-panel-council` / `tab-panel-advanced` as
 * literals at eight sites — it creates them in `_injectTabLayout`, looks them
 * up to `inject()` each tab, toggles their `display` in `_switchTab`, and
 * resets them in `hide()`. The canonical id lives on the tab's
 * `COUNCIL_CRUD_SPEC.panelId`, and the modal does NOT read it from there on
 * purpose: it constructs its tabs guarded (`typeof VoiceCentricConfigTab !==
 * 'undefined'`), so it tolerates the tab classes being absent, and a bare
 * `VoiceCentricConfigTab.COUNCIL_CRUD_SPEC` read would throw in exactly that
 * case — the same hazard that keeps CouncilManager on its own literal. So the
 * copies are pinned here instead, the way council-manager.test.js pins its one.
 * Divergence is otherwise SILENT: `querySelector` answers a miss with null and
 * every site guards with `if (!panel)`, so a rename that updates the spec and
 * the markup but misses one of the modal's copies is a no-op, not an error.
 *
 * CHARACTER COUNT.
 *
 * The modal has ONE Analyze button and THREE textareas that can disable it.
 * `AnalysisConfigModal.updateCharacterCount` owns `#custom-instructions`;
 * `CouncilCrud.updateCharCount` (reached through `_updateCharCount` on the
 * voice tab and `_updateCouncilCharCount` on the advanced tab) owns the two
 * council textareas and looks the button up on `tab.modal` — NOT on its own
 * panel — precisely so a council tab can gate it too.
 *
 * Switching tabs therefore changes which textarea the button's state is
 * supposed to reflect, and `_switchTab` copies instruction text BETWEEN
 * textareas by plain assignment, which fires no `input` event. Nothing else
 * recomputes. That half of the suite drives `_switchTab` and asserts on the
 * shared button, because the defect was a MISSING CALL — the counters
 * themselves were always correct when asked.
 *
 * Throughout, the real modal is mounted (real tab classes, real `show()`), not
 * stubbed. A hand-built fixture would pin nothing here: both subjects are about
 * whether the modal's own construction and lookups agree with each other and
 * with the tabs, which is precisely what a fixture would paper over.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Each of these installs its browser global as a side effect of loading —
// exactly what the app's script tags do. `markdown.js` provides
// `escapeHtmlAttribute` (provider buttons) and `tier-icons.js` `getTierIcon`
// (model cards); without them `_initializeContent` rejects and nothing mounts.
require('../../public/js/components/TimeoutSelect.js');
global.TimeoutSelect = window.TimeoutSelect;
require('../../public/js/components/CouncilDropdown.js');
require('../../public/js/components/CouncilCard.js');
require('../../public/js/utils/markdown.js');
require('../../public/js/utils/tier-icons.js');
require('../../public/js/utils/provider-map.js');
require('../../public/js/utils/provider-model.js');
// The tabs come from the helper, which installs `window.CouncilCrud` for them
// first — see its header.
const { VoiceCentricConfigTab, AdvancedConfigTab } = require('../utils/config-tab-modules.js');
// The modal's constructor tests these as BARE identifiers (`typeof
// VoiceCentricConfigTab !== 'undefined'`), so they have to resolve on the
// global scope chain, not merely on `window`. Without them `this.councilTab`
// and `this.advancedTab` stay null and every recount below silently no-ops.
global.VoiceCentricConfigTab = VoiceCentricConfigTab;
global.AdvancedConfigTab = AdvancedConfigTab;
const { AnalysisConfigModal } = require('../../public/js/components/AnalysisConfigModal.js');

const PROVIDERS = [
  {
    id: 'claude',
    name: 'Claude',
    defaultModel: 'sonnet',
    defaultTimeout: 600000,
    models: [{ id: 'sonnet', name: 'Sonnet', tier: 'balanced', default: true }]
  }
];

/** Comfortably past the 5,000-char limit all three counters enforce. */
const OVER_LIMIT = 'x'.repeat(6000);

const OVER_LIMIT_TITLE = 'Custom instructions exceed 5,000 character limit';
const NORMAL_TITLE = 'Start Analysis (Cmd/Ctrl+Enter)';

const IDS = {
  single: '#custom-instructions',
  council: VoiceCentricConfigTab.COUNCIL_CRUD_SPEC.instructionsId,
  advanced: AdvancedConfigTab.COUNCIL_CRUD_SPEC.instructionsId
};

/** Type into a textarea the way a user does — value plus the `input` event. */
function type(textarea, value) {
  textarea.value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Mount a real modal through `show()`.
 *
 * `show()` resolves only on submit/cancel, so it is deliberately not awaited;
 * the mount happens in the background `_initializeContent`, and the injected
 * panels are the signal it finished.
 */
async function mountModal() {
  global.fetch = vi.fn(async (url) => {
    if (url === '/api/providers') {
      return { ok: true, status: 200, json: async () => ({ providers: PROVIDERS }) };
    }
    if (String(url).startsWith('/api/councils')) {
      return { ok: true, status: 200, json: async () => ({ councils: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const modal = new AnalysisConfigModal();
  modal.show({});
  await vi.waitFor(() => {
    expect(modal.modal.querySelector(IDS.council)).toBeTruthy();
    expect(modal.modal.querySelector(IDS.advanced)).toBeTruthy();
    expect(modal.modal.querySelector('[data-action="submit"]')).toBeTruthy();
  });
  return modal;
}

function teardownModal() {
  document.body.innerHTML = '';
  delete global.fetch;
  vi.restoreAllMocks();
}

// The two tabs, each paired with the spec that owns its canonical panel id.
const PANEL_TABS = [
  { label: 'Standard (voice-centric)', TabClass: VoiceCentricConfigTab, tabProp: 'councilTab', tabId: 'council' },
  { label: 'Advanced (level-centric)', TabClass: AdvancedConfigTab, tabProp: 'advancedTab', tabId: 'advanced' }
];

describe('AnalysisConfigModal tab panel ids (the modal\'s literals vs COUNCIL_CRUD_SPEC)', () => {
  let modal;

  beforeEach(async () => { modal = await mountModal(); });
  afterEach(teardownModal);

  for (const { label, TabClass, tabProp, tabId } of PANEL_TABS) {
    const specPanelId = TabClass.COUNCIL_CRUD_SPEC.panelId;
    // The spec stores a SELECTOR ('#tab-panel-council'); the modal assigns a
    // bare id. One `.slice(1)` is the whole difference, and doing it here keeps
    // the literal out of the assertions below.
    const bareId = specPanelId.slice(1);

    describe(label, () => {
      it('creates the panel under the id the tab looks itself up by', () => {
        // `_injectTabLayout` builds all three panels; this is the site that
        // names them (AnalysisConfigModal.js `councilPanel.id = ...`).
        const panels = modal.modal.querySelectorAll(`[id="${bareId}"]`);
        expect(panels).toHaveLength(1);
        expect(panels[0].id).toBe(bareId);
        expect(panels[0].classList.contains('tab-panel')).toBe(true);
      });

      it('injects the tab into that exact panel', () => {
        // Pins the SECOND pair of literals — the lookups `_initializeContent`
        // uses to hand each tab its panel. If that copy missed a rename,
        // `inject(null)` returns early and the panel stays empty, which no
        // error would report.
        const tab = modal[tabProp];
        const panel = modal.modal.querySelector(specPanelId);

        expect(tab._injected).toBe(true);
        expect(panel).toBeTruthy();
        // The tab's own content, found through the tab's own spec lookup, is
        // inside the node the modal built.
        expect(tab._panel()).toBe(panel);
        expect(panel.querySelector(TabClass.COUNCIL_CRUD_SPEC.instructionsId)).toBeTruthy();
        expect(panel.querySelector(TabClass.COUNCIL_CRUD_SPEC.selectorId)).toBeTruthy();
      });

      it('shows and hides that exact panel on a tab switch', () => {
        // Pins the THIRD pair — `_switchTab`'s own copies of the ids. A missed
        // rename there leaves the panel permanently `display: none` while the
        // tab button reads active.
        modal._switchTab(tabId);
        expect(modal.modal.querySelector(specPanelId).style.display).toBe('');

        const other = PANEL_TABS.find(t => t.tabId !== tabId);
        expect(modal.modal.querySelector(other.TabClass.COUNCIL_CRUD_SPEC.panelId).style.display)
          .toBe('none');

        modal._switchTab('single');
        expect(modal.modal.querySelector(specPanelId).style.display).toBe('none');
      });

      it('resets that exact panel on hide', () => {
        // Pins the FOURTH pair — `hide()`'s copies, applied from a 200ms
        // timeout, so a reopen lands on Single with the council panels down.
        modal._switchTab(tabId);
        expect(modal.modal.querySelector(specPanelId).style.display).toBe('');

        // A production delay we control, so it is ELAPSED, not waited out
        // (tests/CONVENTIONS.md). The timeout callback is entirely synchronous
        // — DOM writes and field resets, no awaits — so advancing the clock
        // runs it to completion in-line. The `finally` is mandatory: a failing
        // assertion inside would otherwise leak fake timers into the sibling
        // PANEL_TABS iteration and every test after it.
        try {
          vi.useFakeTimers();
          modal.hide();
          vi.advanceTimersByTime(200);
        } finally {
          vi.useRealTimers();
        }

        expect(modal.modal.querySelector(specPanelId).style.display).toBe('none');
        expect(modal.modal.querySelector('#tab-panel-single').style.display).toBe('');
      });
    });
  }

  it('gives the three panels three distinct ids', () => {
    // A rename that collides two of them would satisfy every per-tab check
    // above while leaving one tab injecting into the other's panel.
    const ids = [
      VoiceCentricConfigTab.COUNCIL_CRUD_SPEC.panelId,
      AdvancedConfigTab.COUNCIL_CRUD_SPEC.panelId,
      '#tab-panel-single'
    ];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(modal.modal.querySelectorAll(id)).toHaveLength(1);
    }
  });
});

describe('AnalysisConfigModal._switchTab (character-count recount)', () => {
  let modal;

  beforeEach(async () => { modal = await mountModal(); });
  afterEach(teardownModal);

  const submitBtn = () => modal.modal.querySelector('[data-action="submit"]');
  const textarea = (which) => modal.modal.querySelector(IDS[which]);

  it('both council tabs are wired to the modal and its single Analyze button', () => {
    // The premise of everything below: one button, three textareas, and both
    // council tabs really instantiated.
    expect(modal.councilTab).toBeInstanceOf(VoiceCentricConfigTab);
    expect(modal.advancedTab).toBeInstanceOf(AdvancedConfigTab);
    expect(modal.modal.querySelectorAll('[data-action="submit"]')).toHaveLength(1);
    expect(modal.councilTab.modal).toBe(modal.modal);
    expect(modal.advancedTab.modal).toBe(modal.modal);
  });

  // REGRESSION: paste 6,000 characters into the Standard council tab and switch
  // to Advanced. The switch assigns `advTextarea.value = singleTextarea.value`
  // — an EMPTY string here, and assigned, so no `input` fires. Before the
  // recount the user faced a short, valid textarea and a disabled Analyze
  // button whose tooltip cited a limit nothing on screen exceeded; the only way
  // out was to switch back and edit the now-hidden textarea.
  it('re-enables Analyze when leaving an over-limit Standard tab for Advanced', () => {
    modal._switchTab('council');
    type(textarea('council'), OVER_LIMIT);

    expect(submitBtn().disabled).toBe(true);
    expect(submitBtn().title).toBe(OVER_LIMIT_TITLE);

    modal._switchTab('advanced');

    // The panel now on screen holds nothing, so nothing on screen is over the
    // limit — and the button has to say so.
    expect(textarea('advanced').value).toBe('');
    expect(submitBtn().disabled).toBe(false);
    expect(submitBtn().title).toBe(NORMAL_TITLE);
  });

  // The mirror of the above: the Advanced tab is the one holding the offending
  // text when the user leaves it.
  it('re-enables Analyze when leaving an over-limit Advanced tab for Standard', () => {
    modal._switchTab('advanced');
    type(textarea('advanced'), OVER_LIMIT);

    expect(submitBtn().disabled).toBe(true);

    modal._switchTab('council');

    expect(textarea('council').value).toBe('');
    expect(submitBtn().disabled).toBe(false);
    expect(submitBtn().title).toBe(NORMAL_TITLE);
  });

  // The dangerous direction: the switch COPIES over-limit text onto the panel
  // it reveals. Without the recount the user is shown 6,000 characters under a
  // live Analyze button — and submitting sends instructions the backend refuses.
  it('disables Analyze when the switch copies over-limit text onto the revealed tab', () => {
    // Typed in Single, so the limit is enforced there first.
    type(textarea('single'), OVER_LIMIT);
    expect(submitBtn().disabled).toBe(true);

    // Standard receives the copy and agrees it is over the limit.
    modal._switchTab('council');
    expect(textarea('council').value).toHaveLength(OVER_LIMIT.length);
    expect(submitBtn().disabled).toBe(true);

    // Clearing the VISIBLE textarea frees the button — but `#custom-instructions`
    // still holds the 6,000 characters, and it is what the next switch copies.
    type(textarea('council'), '');
    expect(submitBtn().disabled).toBe(false);

    modal._switchTab('advanced');

    expect(textarea('advanced').value).toHaveLength(OVER_LIMIT.length);
    expect(submitBtn().disabled).toBe(true);
    expect(submitBtn().title).toBe(OVER_LIMIT_TITLE);
  });

  it('repaints the revealed panel\'s own counter and textarea styling, not just the button', () => {
    const spec = AdvancedConfigTab.COUNCIL_CRUD_SPEC;
    type(textarea('single'), OVER_LIMIT);
    modal._switchTab('council');
    type(textarea('council'), '');

    modal._switchTab('advanced');

    const panel = modal.modal.querySelector(spec.panelId);
    expect(panel.querySelector(spec.charCountId).textContent).toBe((6000).toLocaleString());
    expect(panel.querySelector(spec.charCountContainerId).classList.contains('char-count-error')).toBe(true);
    expect(textarea('advanced').classList.contains('textarea-error')).toBe(true);
  });

  // Belt and braces for the third branch. With the two council recounts in
  // place a stale-disabled button cannot survive into a Single switch, so the
  // state is seeded through the council tab's own counter — the thing that
  // legitimately disables the shared button while its panel is hidden. The
  // assertion is still on `_switchTab`: the Single branch recounts OUTSIDE the
  // `source` guard, because the stale case is exactly the one where `source` is
  // empty and nothing was copied.
  it('recounts on the way back to Single even when there is nothing to copy', () => {
    modal._switchTab('council');
    modal.councilTab._updateCharCount(OVER_LIMIT.length);
    expect(submitBtn().disabled).toBe(true);

    modal._switchTab('single');

    expect(textarea('council').value).toBe('');
    expect(textarea('advanced').value).toBe('');
    expect(textarea('single').value).toBe('');
    expect(submitBtn().disabled).toBe(false);
    expect(submitBtn().title).toBe(NORMAL_TITLE);
  });

  it('leaves an over-limit Single tab disabled when it is the tab being revealed', () => {
    modal._switchTab('council');
    type(textarea('council'), OVER_LIMIT);

    // Single takes the copy (`source` is non-empty), so the recount must NOT
    // undo the disable the copied text earns.
    modal._switchTab('single');

    expect(textarea('single').value).toHaveLength(OVER_LIMIT.length);
    expect(submitBtn().disabled).toBe(true);
    expect(submitBtn().title).toBe(OVER_LIMIT_TITLE);
  });
});
