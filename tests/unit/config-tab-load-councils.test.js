// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for `loadCouncils()` on both council config tabs.
 *
 * Two things are pinned here, and neither had a single assertion before:
 *
 *   1. THE TYPE FILTER ASYMMETRY. Voice takes `c.type === 'council'`; Advanced
 *      takes `!c.type || c.type === 'advanced'`, i.e. it also claims LEGACY
 *      untyped rows, which predate the `type` column and are level-centric.
 *      That rule is quoted as load-bearing in CouncilCard.js, CouncilDropdown.js,
 *      CouncilManager.js and three test files — and was asserted in none of
 *      them. Tighten Advanced's filter to `c.type === 'advanced'` and legacy
 *      councils vanish from BOTH selectors while every badge/card test still
 *      passes. The expected ids live on the TABS entries below, beside the type
 *      literals they belong to.
 *
 *   2. THE RETURN CONTRACT. `loadCouncils()` resolves to a boolean — true iff
 *      the fetch succeeded and the selector was re-rendered — and NEVER
 *      rejects, because several callers fire and forget it
 *      (AnalysisConfigModal's tab switch, council-crud's post-write refresh).
 *      It also stashes the UNFILTERED list as `_allCouncils`, which is what the
 *      duplicate-name scan in Save As reads: a name collision across types
 *      breaks `--council <name>` for both councils (see council-crud.js).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { VoiceCentricConfigTab } = require('../../public/js/components/VoiceCentricConfigTab.js');
const { AdvancedConfigTab } = require('../../public/js/components/AdvancedConfigTab.js');

/** One council of each shape the API can return. */
const COUNCILS = [
  { id: 'voice-1', name: 'Standard One', type: 'council', config: {} },
  { id: 'adv-1', name: 'Advanced One', type: 'advanced', config: {} },
  { id: 'legacy-1', name: 'Legacy One', config: {} },
  { id: 'legacy-2', name: 'Legacy Two', type: null, config: {} }
];

const TABS = [
  {
    label: 'VoiceCentricConfigTab',
    TabClass: VoiceCentricConfigTab,
    // `c.type === 'council'` — legacy rows are level-centric and belong to the
    // other tab.
    expectedCouncilIds: ['voice-1']
  },
  {
    label: 'AdvancedConfigTab',
    TabClass: AdvancedConfigTab,
    // `!c.type || c.type === 'advanced'` — the ONLY tab that can render a
    // legacy untyped row.
    expectedCouncilIds: ['adv-1', 'legacy-1', 'legacy-2']
  }
];

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

function makeCtx(overrides = {}) {
  return {
    councils: [],
    _allCouncils: [],
    _councilsLoaded: false,
    _renderCouncilSelector: vi.fn(),
    ...overrides
  };
}

beforeEach(() => {
  window.toast = { showWarning: vi.fn(), showError: vi.fn(), showSuccess: vi.fn() };
});

afterEach(() => {
  delete window.toast;
  vi.unstubAllGlobals();
});

for (const spec of TABS) {
  const { label, TabClass, expectedCouncilIds } = spec;

  describe(`${label}.loadCouncils`, () => {
    it('shows exactly the council types this tab can render', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => okResponse({ councils: COUNCILS })));
      const ctx = makeCtx();

      await TabClass.prototype.loadCouncils.call(ctx);

      expect(ctx.councils.map(c => c.id)).toEqual(expectedCouncilIds);
    });

    it('stashes the UNFILTERED list as _allCouncils', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => okResponse({ councils: COUNCILS })));
      const ctx = makeCtx();

      await TabClass.prototype.loadCouncils.call(ctx);

      expect(ctx._allCouncils.map(c => c.id))
        .toEqual(['voice-1', 'adv-1', 'legacy-1', 'legacy-2']);
      // Every council in the type-filtered list is also in the unfiltered one.
      for (const council of ctx.councils) {
        expect(ctx._allCouncils).toContain(council);
      }
    });

    it('resolves true and renders the selector on success', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => okResponse({ councils: COUNCILS })));
      const ctx = makeCtx();

      await expect(TabClass.prototype.loadCouncils.call(ctx)).resolves.toBe(true);

      expect(ctx._renderCouncilSelector).toHaveBeenCalledTimes(1);
      expect(ctx._councilsLoaded).toBe(true);
      expect(window.toast.showError).not.toHaveBeenCalled();
    });

    it('resolves false and clears BOTH lists when the request fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
      const ctx = makeCtx({ councils: COUNCILS, _allCouncils: COUNCILS });

      try {
        await expect(TabClass.prototype.loadCouncils.call(ctx)).resolves.toBe(false);
      } finally {
        consoleSpy.mockRestore();
      }

      // A stale name scan is no more trustworthy than a stale selector.
      expect(ctx.councils).toEqual([]);
      expect(ctx._allCouncils).toEqual([]);
      expect(ctx._councilsLoaded).toBe(false);
      expect(ctx._renderCouncilSelector).not.toHaveBeenCalled();
      expect(window.toast.showError).toHaveBeenCalledWith('Failed to load saved councils');
    });

    it('resolves false rather than rejecting when fetch itself throws', async () => {
      // The fire-and-forget callers (AnalysisConfigModal's tab switch) would
      // otherwise raise an unhandled rejection.
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));

      try {
        await expect(TabClass.prototype.loadCouncils.call(makeCtx())).resolves.toBe(false);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('resolves false rather than rejecting when the selector render throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn(async () => okResponse({ councils: COUNCILS })));
      const ctx = makeCtx({
        _renderCouncilSelector: vi.fn(() => { throw new Error('no panel'); })
      });

      try {
        await expect(TabClass.prototype.loadCouncils.call(ctx)).resolves.toBe(false);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('tolerates a payload with no councils array', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => okResponse({})));
      const ctx = makeCtx();

      await expect(TabClass.prototype.loadCouncils.call(ctx)).resolves.toBe(true);

      expect(ctx.councils).toEqual([]);
      expect(ctx._allCouncils).toEqual([]);
    });

    it('does not throw when window.toast is absent', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      delete window.toast;
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));

      try {
        await expect(TabClass.prototype.loadCouncils.call(makeCtx())).resolves.toBe(false);
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });
}

describe('loadCouncils type-filter asymmetry', () => {
  it('routes every council shape to exactly one tab', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ councils: COUNCILS })));
    const voice = makeCtx();
    const advanced = makeCtx();

    await VoiceCentricConfigTab.prototype.loadCouncils.call(voice);
    await AdvancedConfigTab.prototype.loadCouncils.call(advanced);

    const voiceIds = voice.councils.map(c => c.id);
    const advancedIds = advanced.councils.map(c => c.id);

    // No overlap, and nothing stranded — a legacy row must reach the Advanced
    // tab or it is unreachable from the UI entirely.
    expect(voiceIds.filter(id => advancedIds.includes(id))).toEqual([]);
    expect([...voiceIds, ...advancedIds].sort())
      .toEqual(COUNCILS.map(c => c.id).sort());
  });
});
