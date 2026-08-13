// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the shared council CRUD helper and the two tabs' wiring to it.
 *
 * The whole Save / Save As / Delete flow lives in
 * public/js/utils/council-crud.js; each tab supplies only a `COUNCIL_CRUD_SPEC`
 * ({ type, selectorId }). That spec is the one thing a shared helper can get
 * wrong silently — a swapped type literal writes a council of the wrong kind,
 * and a swapped selector id leaves the OTHER tab's <select> stale after a save.
 * Both are pinned here through the tab methods, over a real DOM containing both
 * tabs' selectors so a cross-wire is visible.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CouncilCrudModule = require('../../public/js/utils/council-crud.js');
const { VoiceCentricConfigTab } = require('../../public/js/components/VoiceCentricConfigTab.js');
const { AdvancedConfigTab } = require('../../public/js/components/AdvancedConfigTab.js');

const TABS = [
  {
    label: 'VoiceCentricConfigTab',
    TabClass: VoiceCentricConfigTab,
    expectedType: 'council',
    selectorId: 'vc-council-selector',
    otherSelectorId: 'council-selector'
  },
  {
    label: 'AdvancedConfigTab',
    TabClass: AdvancedConfigTab,
    expectedType: 'advanced',
    selectorId: 'council-selector',
    otherSelectorId: 'vc-council-selector'
  }
];

const CONFIG = { levels: { 1: true } };

/** Both tabs' selectors, so writing through the wrong one is observable. */
function mountBothSelectors() {
  document.body.innerHTML = `
    <div id="modal">
      <select id="vc-council-selector" class="new-council-selected">
        <option value=""></option>
        <option value="c1"></option>
        <option value="c2"></option>
      </select>
      <select id="council-selector" class="new-council-selected">
        <option value=""></option>
        <option value="c1"></option>
        <option value="c2"></option>
      </select>
    </div>
  `;
  return document.getElementById('modal');
}

function makeCtx(overrides = {}) {
  return {
    modal: mountBothSelectors(),
    councils: [{ id: 'c1', name: 'Db Council' }],
    selectedCouncilId: 'c1',
    _markClean: vi.fn(),
    loadCouncils: vi.fn(async () => {}),
    _applyConfigToUI: vi.fn(),
    _defaultConfig: vi.fn(() => CONFIG),
    _updateSaveButtonStates: vi.fn(),
    ...overrides
  };
}

const okResponse = (body = {}) => ({ ok: true, status: 200, json: async () => body });

const select = (ctx, id) => ctx.modal.querySelector(`#${id}`);

beforeEach(() => {
  window.toast = { showWarning: vi.fn(), showError: vi.fn(), showSuccess: vi.fn() };
});

afterEach(() => {
  delete window.toast;
  delete window.confirmDialog;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('window.CouncilCrud registration', () => {
  it('exposes the same functions on window as it exports', () => {
    expect(window.CouncilCrud).toBeDefined();
    expect(Object.keys(window.CouncilCrud).sort()).toEqual(Object.keys(CouncilCrudModule).sort());
    for (const key of Object.keys(CouncilCrudModule)) {
      expect(window.CouncilCrud[key]).toBe(CouncilCrudModule[key]);
    }
  });
});

for (const spec of TABS) {
  const { label, TabClass, expectedType, selectorId, otherSelectorId } = spec;

  describe(`${label} council CRUD wiring`, () => {
    it('PUTs its own type literal and refreshes only its own selector', async () => {
      const fetchSpy = vi.fn(async () => okResponse());
      vi.stubGlobal('fetch', fetchSpy);
      const ctx = makeCtx();

      await TabClass.prototype._putCouncil.call(ctx, 'c1', CONFIG);

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe('/api/councils/c1');
      expect(options.method).toBe('PUT');
      expect(JSON.parse(options.body)).toEqual({ config: CONFIG, type: expectedType });
      expect(ctx._markClean).toHaveBeenCalledTimes(1);
      expect(ctx.loadCouncils).toHaveBeenCalledTimes(1);
      expect(select(ctx, selectorId).value).toBe('c1');
      expect(select(ctx, selectorId).classList.contains('new-council-selected')).toBe(false);
      // The other tab's selector is untouched — no cross-wired spec.
      expect(select(ctx, otherSelectorId).classList.contains('new-council-selected')).toBe(true);
    });

    it('POSTs its own type literal and selects the created council', async () => {
      const fetchSpy = vi.fn(async () => okResponse({ council: { id: 'c2' } }));
      vi.stubGlobal('fetch', fetchSpy);
      const ctx = makeCtx({ selectedCouncilId: null });

      await TabClass.prototype._postCouncil.call(ctx, 'New Council', CONFIG);

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe('/api/councils');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({ name: 'New Council', config: CONFIG, type: expectedType });
      expect(ctx.selectedCouncilId).toBe('c2');
      expect(select(ctx, selectorId).value).toBe('c2');
      expect(select(ctx, otherSelectorId).value).toBe('');
    });

    it('throws on a failed PUT so the caller can report it', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })));
      const ctx = makeCtx();

      await expect(TabClass.prototype._putCouncil.call(ctx, 'c1', CONFIG))
        .rejects.toThrow('PUT /api/councils/c1 failed: 403');
      expect(ctx._markClean).not.toHaveBeenCalled();
    });

    it('throws on a failed POST so the caller can report it', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
      const ctx = makeCtx();

      await expect(TabClass.prototype._postCouncil.call(ctx, 'New Council', CONFIG))
        .rejects.toThrow('POST /api/councils failed: 500');
    });

    it('deletes after confirmation and resets its own selector to "+ New Council"', async () => {
      const fetchSpy = vi.fn(async () => okResponse());
      vi.stubGlobal('fetch', fetchSpy);
      window.confirmDialog = { show: vi.fn(async () => 'confirm') };
      const ctx = makeCtx();
      select(ctx, selectorId).value = 'c1';
      select(ctx, selectorId).classList.remove('new-council-selected');

      await TabClass.prototype._deleteCouncil.call(ctx);

      expect(window.confirmDialog.show).toHaveBeenCalledTimes(1);
      expect(window.confirmDialog.show.mock.calls[0][0].message).toContain('Db Council');
      expect(fetchSpy).toHaveBeenCalledWith('/api/councils/c1', { method: 'DELETE' });
      expect(ctx.selectedCouncilId).toBe(null);
      expect(ctx._applyConfigToUI).toHaveBeenCalledWith(CONFIG);
      expect(ctx._updateSaveButtonStates).toHaveBeenCalledTimes(1);
      expect(select(ctx, selectorId).value).toBe('');
      expect(select(ctx, selectorId).classList.contains('new-council-selected')).toBe(true);
      expect(window.toast.showSuccess).toHaveBeenCalledWith('Council deleted');
    });

    it('does not delete when the confirmation is dismissed', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      window.confirmDialog = { show: vi.fn(async () => 'cancel') };
      const ctx = makeCtx();

      await TabClass.prototype._deleteCouncil.call(ctx);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ctx.selectedCouncilId).toBe('c1');
    });

    it('reports a failed delete instead of resetting the tab', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })));
      window.confirmDialog = { show: vi.fn(async () => 'confirm') };
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ctx = makeCtx();

      try {
        await TabClass.prototype._deleteCouncil.call(ctx);
      } finally {
        consoleSpy.mockRestore();
      }

      expect(window.toast.showError).toHaveBeenCalledWith('Failed to delete council');
      expect(ctx.selectedCouncilId).toBe('c1');
      expect(ctx._applyConfigToUI).not.toHaveBeenCalled();
    });

    it('does nothing when no council is selected', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      window.confirmDialog = { show: vi.fn() };
      const ctx = makeCtx({ selectedCouncilId: null });

      await TabClass.prototype._deleteCouncil.call(ctx);

      expect(window.confirmDialog.show).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reports a failed save instead of throwing at the click handler', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ctx = makeCtx({
        _readConfigFromUI: vi.fn(() => CONFIG),
        _validateConfig: vi.fn(() => ({ valid: true })),
        _isFileCouncil: vi.fn(() => false),
        _putCouncil: vi.fn(async () => { throw new Error('boom'); })
      });

      try {
        await expect(TabClass.prototype._saveCouncil.call(ctx)).resolves.toBeUndefined();
      } finally {
        consoleSpy.mockRestore();
      }

      expect(window.toast.showError).toHaveBeenCalledWith('Failed to save council');
    });

    it('warns and writes nothing when the live config does not validate', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const ctx = makeCtx({
        _readConfigFromUI: vi.fn(() => CONFIG),
        _validateConfig: vi.fn(() => ({ valid: false })),
        _isFileCouncil: vi.fn(() => false),
        _putCouncil: vi.fn(),
        _saveCouncilAs: vi.fn()
      });

      await TabClass.prototype._saveCouncil.call(ctx);

      expect(window.toast.showWarning)
        .toHaveBeenCalledWith('At least one review level must be enabled.');
      expect(ctx._putCouncil).not.toHaveBeenCalled();
      expect(ctx._saveCouncilAs).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
}
