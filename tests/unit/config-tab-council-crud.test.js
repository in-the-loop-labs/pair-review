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

// Deliberately NOT tests/utils/config-tab-modules.js: the helper ASSIGNS
// `window.CouncilCrud` itself, which would make the registration assertion below
// compare an object to itself. This file has to observe the module's own
// self-install, so it loads it directly.
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
    // The unfiltered list the real tabs keep alongside `councils` — same row
    // plus one this tab filters out, so pruning that touches only the right
    // entries is observable.
    _allCouncils: [{ id: 'c1', name: 'Db Council' }, { id: 'c2', name: 'Other Council' }],
    selectedCouncilId: 'c1',
    _markClean: vi.fn(),
    // `true` is the real contract: the fetch succeeded AND the selector was
    // re-rendered. Callers branch on it.
    loadCouncils: vi.fn(async () => true),
    _renderCouncilSelector: vi.fn(),
    _applyConfigToUI: vi.fn(),
    _defaultConfig: vi.fn(() => CONFIG),
    _updateSaveButtonStates: vi.fn(),
    ...overrides
  };
}

const okResponse = (body = {}) => ({ ok: true, status: 200, json: async () => body });

/** A failure whose body carries the API's own `{ error }` diagnosis. */
const errorResponse = (status, body) => ({ ok: false, status, json: async () => body });

/** A failure whose body is not JSON at all (a proxy's HTML 502, say). */
const unparseableResponse = (status) => ({
  ok: false,
  status,
  json: async () => { throw new SyntaxError('Unexpected token <'); }
});

const select = (ctx, id) => ctx.modal.querySelector(`#${id}`);

beforeEach(() => {
  window.toast = { showWarning: vi.fn(), showError: vi.fn(), showSuccess: vi.fn() };
});

afterEach(() => {
  delete window.toast;
  delete window.confirmDialog;
  delete window.textInputDialog;
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
      // The real `loadCouncils` contract, faked: on success it repaints the
      // selector through the module's own renderer and resolves true. That
      // repaint — over the pruned list — is what takes the deleted `<option>`
      // off screen, so stubbing it out would pin nothing here.
      const ctx = makeCtx({
        _renderCouncilSelector: vi.fn(function () {
          CouncilCrudModule.renderCouncilSelector(this, TabClass.COUNCIL_CRUD_SPEC);
        })
      });
      ctx.loadCouncils = vi.fn(async () => { ctx._renderCouncilSelector(); return true; });
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
      // The successful reload already repainted; no second repaint on top of it.
      expect(ctx._renderCouncilSelector).toHaveBeenCalledTimes(1);
      expect(select(ctx, selectorId).querySelector('option[value="c1"]')).toBe(null);
      expect(window.toast.showSuccess).toHaveBeenCalledWith('Council deleted');
    });

    it('drops the deleted row locally when the follow-up reload fails', async () => {
      // The DELETE returned ok, so the row is gone server-side — but
      // `loadCouncils` deliberately KEEPS the previous lists when its GET
      // fails. Without a local prune the deleted council stays in both lists:
      // still selectable, and its name still reserved in `saveCouncilAs`'s
      // duplicate scan.
      vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
      window.confirmDialog = { show: vi.fn(async () => 'confirm') };
      const ctx = makeCtx({ loadCouncils: vi.fn(async () => false) });

      await expect(TabClass.prototype._deleteCouncil.call(ctx)).resolves.toBe(true);

      expect(ctx.councils).toEqual([]);
      expect(ctx._allCouncils).toEqual([{ id: 'c2', name: 'Other Council' }]);
      // The load-bearing half: pruning the arrays alone leaves the real
      // `<option>` nodes up, because NOTHING repaints the `<select>` on the
      // failed-reload path.
      expect(ctx._renderCouncilSelector).toHaveBeenCalledTimes(1);
      expect(ctx.selectedCouncilId).toBe(null);
      expect(window.toast.showSuccess).toHaveBeenCalledWith('Council deleted');
    });

    it('prunes without _allCouncils, which a tab may not have yet', async () => {
      // `saveCouncilAs` documents the absent case (a stubbed context, or a tab
      // whose first `loadCouncils` has not resolved) and falls back to
      // `tab.councils` — which the prune covers. Reaching for `.filter` on it
      // regardless would throw INSIDE the try, turning a successful delete into
      // "Failed to delete council".
      vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
      window.confirmDialog = { show: vi.fn(async () => 'confirm') };
      const ctx = makeCtx({ _allCouncils: undefined, loadCouncils: vi.fn(async () => false) });

      await expect(TabClass.prototype._deleteCouncil.call(ctx)).resolves.toBe(true);

      expect(ctx.councils).toEqual([]);
      expect(window.toast.showError).not.toHaveBeenCalled();
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

      // No JSON body on this response at all: the read is best-effort and the
      // status line stands in.
      expect(window.toast.showError)
        .toHaveBeenCalledWith('DELETE /api/councils/c1 failed: 403');
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
        // Resolves FALSE, not undefined — see the RETURN CONTRACT in
        // council-crud.js. CouncilManager's editor footer exits to the list on
        // this value, so a swallowed failure that reported "no result" was
        // indistinguishable from a successful save.
        await expect(TabClass.prototype._saveCouncil.call(ctx)).resolves.toBe(false);
      } finally {
        consoleSpy.mockRestore();
      }

      // The thrown message reaches the toast; 'Failed to save council' is only
      // the fallback for an error that carries none.
      expect(window.toast.showError).toHaveBeenCalledWith('boom');
    });

    it('falls back to the fixed message when the failure carries none', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ctx = makeCtx({
        _readConfigFromUI: vi.fn(() => CONFIG),
        _validateConfig: vi.fn(() => ({ valid: true })),
        _isFileCouncil: vi.fn(() => false),
        _putCouncil: vi.fn(async () => { throw new Error('   '); })
      });

      try {
        await expect(TabClass.prototype._saveCouncil.call(ctx)).resolves.toBe(false);
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

      const result = await TabClass.prototype._saveCouncil.call(ctx);

      expect(result).toBe(false);
      expect(window.toast.showWarning)
        .toHaveBeenCalledWith('At least one review level must be enabled.');
      expect(ctx._putCouncil).not.toHaveBeenCalled();
      expect(ctx._saveCouncilAs).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    // `_validateConfig` returns `{ valid, error }` and its `error` names the
    // actual problem ('Level 2 needs at least one reviewer…'). Toasting the
    // hardcoded level message instead sent the user looking at the wrong control.
    it.each([
      ['_saveCouncil', () => ({ _putCouncil: vi.fn(), _saveCouncilAs: vi.fn() })],
      ['_saveCouncilAs', () => ({ _postCouncil: vi.fn() })]
    ])('%s surfaces the validator\'s own message', async (method, extras) => {
      window.textInputDialog = { show: vi.fn() };
      const ctx = makeCtx({
        _readConfigFromUI: vi.fn(() => CONFIG),
        _validateConfig: vi.fn(() => ({ valid: false, error: 'Reviewer 2 has no model selected.' })),
        _isFileCouncil: vi.fn(() => false),
        ...extras()
      });

      await expect(TabClass.prototype[method].call(ctx)).resolves.toBe(false);

      expect(window.toast.showWarning)
        .toHaveBeenCalledWith('Reviewer 2 has no model selected.');
      expect(window.textInputDialog.show).not.toHaveBeenCalled();
    });

    // The whole point of the boolean: every consumer that must know whether a
    // write happened (today CouncilManager's editor footer) reads it, and the
    // refusal paths are exactly the ones that leave the tab clean.
    describe(`${label} council CRUD return contract`, () => {
      it('_saveCouncil resolves true after a successful PUT', async () => {
        const ctx = makeCtx({
          _readConfigFromUI: vi.fn(() => CONFIG),
          _validateConfig: vi.fn(() => ({ valid: true })),
          _isFileCouncil: vi.fn(() => false),
          _putCouncil: vi.fn(async () => true)
        });

        await expect(TabClass.prototype._saveCouncil.call(ctx)).resolves.toBe(true);
      });

      it('_saveCouncil forwards the fork result when nothing is selected', async () => {
        const ctx = makeCtx({
          selectedCouncilId: null,
          _readConfigFromUI: vi.fn(() => CONFIG),
          _validateConfig: vi.fn(() => ({ valid: true })),
          _isFileCouncil: vi.fn(() => false),
          _saveCouncilAs: vi.fn(async () => false)
        });

        // A cancelled Save As prompt is the trigger that made a brand-new,
        // never-edited council look saved.
        await expect(TabClass.prototype._saveCouncil.call(ctx)).resolves.toBe(false);

        ctx._saveCouncilAs = vi.fn(async () => true);
        await expect(TabClass.prototype._saveCouncil.call(ctx)).resolves.toBe(true);
      });

      it('_saveCouncilAs resolves false on a cancelled prompt and true after a POST', async () => {
        // A FACTORY, not a shared literal: spreading one object into two
        // contexts would hand both the same live `vi.fn()` instances, so the
        // second assertion would see the first's call history.
        const base = () => ({
          selectedCouncilId: null,
          councils: [],
          _readConfigFromUI: vi.fn(() => CONFIG),
          _validateConfig: vi.fn(() => ({ valid: true })),
          _isFileCouncil: vi.fn(() => false),
          _postCouncil: vi.fn(async () => true)
        });

        window.textInputDialog = { show: vi.fn(async () => null) };
        const cancelled = makeCtx(base());
        await expect(TabClass.prototype._saveCouncilAs.call(cancelled)).resolves.toBe(false);
        expect(cancelled._postCouncil).not.toHaveBeenCalled();

        window.textInputDialog = { show: vi.fn(async () => 'Fresh Council') };
        const saved = makeCtx(base());
        await expect(TabClass.prototype._saveCouncilAs.call(saved)).resolves.toBe(true);
        expect(saved._postCouncil).toHaveBeenCalledWith('Fresh Council', CONFIG);
      });

      // The file-council fork is the HIGHEST-risk instance of the boolean
      // contract: a file council is read-only, so Save ALWAYS forks, and
      // CouncilManager's footer exits to the list and fires onChange on a truthy
      // result. A cancelled fork prompt reported as success would look like a
      // save that never happened.
      it('_saveCouncil forwards the fork result for a FILE council', async () => {
        const forFork = (saveAsResult) => makeCtx({
          selectedCouncilId: 'file:dream-team',
          _readConfigFromUI: vi.fn(() => CONFIG),
          _validateConfig: vi.fn(() => ({ valid: true })),
          _isFileCouncil: vi.fn(() => true),
          _putCouncil: vi.fn(),
          _saveCouncilAs: vi.fn(async () => saveAsResult)
        });

        const cancelled = forFork(false);
        await expect(TabClass.prototype._saveCouncil.call(cancelled)).resolves.toBe(false);
        expect(cancelled._putCouncil).not.toHaveBeenCalled();

        const forked = forFork(true);
        await expect(TabClass.prototype._saveCouncil.call(forked)).resolves.toBe(true);
        expect(forked._putCouncil).not.toHaveBeenCalled();
      });

      it('_saveCouncil coerces a non-boolean fork result for a FILE council', async () => {
        // `Boolean(await ...)` also guards a dropped `await`: returning the
        // promise itself would be truthy no matter what it resolved to.
        const ctx = makeCtx({
          selectedCouncilId: 'file:dream-team',
          _readConfigFromUI: vi.fn(() => CONFIG),
          _validateConfig: vi.fn(() => ({ valid: true })),
          _isFileCouncil: vi.fn(() => true),
          _saveCouncilAs: vi.fn(async () => undefined)
        });

        await expect(TabClass.prototype._saveCouncil.call(ctx)).resolves.toBe(false);
      });

      it('_saveCouncilAs resolves false when the name dialog is unavailable', async () => {
        delete window.textInputDialog;
        const ctx = makeCtx({
          selectedCouncilId: null,
          councils: [],
          _readConfigFromUI: vi.fn(() => CONFIG),
          _validateConfig: vi.fn(() => ({ valid: true })),
          _isFileCouncil: vi.fn(() => false),
          _postCouncil: vi.fn()
        });

        await expect(TabClass.prototype._saveCouncilAs.call(ctx)).resolves.toBe(false);
        expect(ctx._postCouncil).not.toHaveBeenCalled();
      });

      it('_deleteCouncil resolves false when the confirm dialog is unavailable', async () => {
        delete window.confirmDialog;
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        await expect(TabClass.prototype._deleteCouncil.call(makeCtx())).resolves.toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it('_saveCouncilAs resolves false when the POST fails', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        window.textInputDialog = { show: vi.fn(async () => 'Fresh Council') };
        const ctx = makeCtx({
          selectedCouncilId: null,
          councils: [],
          _readConfigFromUI: vi.fn(() => CONFIG),
          _validateConfig: vi.fn(() => ({ valid: true })),
          _isFileCouncil: vi.fn(() => false),
          _postCouncil: vi.fn(async () => { throw new Error('boom'); })
        });

        try {
          await expect(TabClass.prototype._saveCouncilAs.call(ctx)).resolves.toBe(false);
        } finally {
          consoleSpy.mockRestore();
        }
        expect(window.toast.showError).toHaveBeenCalledWith('boom');
      });

      it('_putCouncil / _postCouncil resolve true on success', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => okResponse({ council: { id: 'c2' } })));
        const ctx = makeCtx();

        await expect(TabClass.prototype._putCouncil.call(ctx, 'c1', CONFIG)).resolves.toBe(true);
        await expect(TabClass.prototype._postCouncil.call(ctx, 'New Council', CONFIG)).resolves.toBe(true);
      });

      it('_deleteCouncil resolves false when the DELETE fails', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => errorResponse(403, { error: 'read-only' })));
        window.confirmDialog = { show: vi.fn(async () => 'confirm') };

        try {
          await expect(TabClass.prototype._deleteCouncil.call(makeCtx())).resolves.toBe(false);
        } finally {
          consoleSpy.mockRestore();
        }
      });

      it('_deleteCouncil reports whether the row was removed', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
        window.confirmDialog = { show: vi.fn(async () => 'confirm') };
        await expect(TabClass.prototype._deleteCouncil.call(makeCtx())).resolves.toBe(true);

        window.confirmDialog = { show: vi.fn(async () => 'cancel') };
        await expect(TabClass.prototype._deleteCouncil.call(makeCtx())).resolves.toBe(false);

        window.confirmDialog = { show: vi.fn(async () => 'confirm') };
        await expect(
          TabClass.prototype._deleteCouncil.call(makeCtx({ selectedCouncilId: null }))
        ).resolves.toBe(false);
      });
    });

    /**
     * The API answers a 400 with `{ error: '...' }` naming the actual problem.
     * Throwing on the status alone discarded all of it and the user got a fixed
     * 'Failed to save council' — which on /settings, where the council editor
     * is the primary authoring surface and no console is open, is the entire
     * feedback there is.
     */
    describe(`${label} council CRUD server error surfacing`, () => {
      it('_putCouncil rejects with the server message, not the status', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => errorResponse(400, {
          error: "Existing config is incompatible with type 'council': levels must be booleans"
        })));

        await expect(TabClass.prototype._putCouncil.call(makeCtx(), 'c1', CONFIG))
          .rejects.toThrow("Existing config is incompatible with type 'council': levels must be booleans");
      });

      it('_postCouncil rejects with the server message, not the status', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => errorResponse(400, {
          error: 'config.voices must be a non-empty array'
        })));

        await expect(TabClass.prototype._postCouncil.call(makeCtx(), 'New', CONFIG))
          .rejects.toThrow('config.voices must be a non-empty array');
      });

      it.each([
        ['a body that is not JSON', unparseableResponse(502), 'PUT /api/councils/c1 failed: 502'],
        ['a JSON body with no error key', errorResponse(500, { ok: false }), 'PUT /api/councils/c1 failed: 500'],
        ['a blank error string', errorResponse(500, { error: '  ' }), 'PUT /api/councils/c1 failed: 500'],
        ['no json method at all', { ok: false, status: 503 }, 'PUT /api/councils/c1 failed: 503']
      ])('_putCouncil falls back to the status line for %s', async (_label, response, expected) => {
        vi.stubGlobal('fetch', vi.fn(async () => response));

        await expect(TabClass.prototype._putCouncil.call(makeCtx(), 'c1', CONFIG))
          .rejects.toThrow(expected);
      });

      it('surfaces the server message through the Save toast', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => errorResponse(400, {
          error: 'levels.2.voices must be a non-empty array when enabled'
        })));
        const ctx = makeCtx({
          _readConfigFromUI: vi.fn(() => CONFIG),
          _validateConfig: vi.fn(() => ({ valid: true })),
          _isFileCouncil: vi.fn(() => false),
          _putCouncil: TabClass.prototype._putCouncil
        });

        try {
          await expect(TabClass.prototype._saveCouncil.call(ctx)).resolves.toBe(false);
        } finally {
          consoleSpy.mockRestore();
        }

        expect(window.toast.showError)
          .toHaveBeenCalledWith('levels.2.voices must be a non-empty array when enabled');
      });

      it('surfaces the server message through the Save As toast', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => errorResponse(400, {
          error: 'config.voices must be a non-empty array'
        })));
        window.textInputDialog = { show: vi.fn(async () => 'Fresh Council') };
        const ctx = makeCtx({
          selectedCouncilId: null,
          councils: [],
          _readConfigFromUI: vi.fn(() => CONFIG),
          _validateConfig: vi.fn(() => ({ valid: true })),
          _isFileCouncil: vi.fn(() => false),
          _postCouncil: TabClass.prototype._postCouncil
        });

        try {
          await expect(TabClass.prototype._saveCouncilAs.call(ctx)).resolves.toBe(false);
        } finally {
          consoleSpy.mockRestore();
        }

        expect(window.toast.showError)
          .toHaveBeenCalledWith('config.voices must be a non-empty array');
      });

      it('surfaces the server message through the Delete toast', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => errorResponse(403, {
          error: 'File councils are read-only'
        })));
        window.confirmDialog = { show: vi.fn(async () => 'confirm') };

        try {
          await expect(TabClass.prototype._deleteCouncil.call(makeCtx())).resolves.toBe(false);
        } finally {
          consoleSpy.mockRestore();
        }

        expect(window.toast.showError).toHaveBeenCalledWith('File councils are read-only');
      });
    });

    /**
     * The duplicate-name scan reads the WHOLE list, not this tab's
     * type-filtered one. `--council <name>` resolves by name at three tiers in
     * src/councils/resolve-council.js and every one of them throws on more than
     * one match, so a cross-type name collision permanently breaks the handle
     * for BOTH councils.
     */
    describe(`${label} Save As duplicate-name scan`, () => {
      const OTHER_TYPE = { id: 'other-1', name: 'Dream Team', type: 'somethingelse' };

      function scanCtx(overrides = {}) {
        return makeCtx({
          selectedCouncilId: null,
          councils: [],
          _readConfigFromUI: vi.fn(() => CONFIG),
          _validateConfig: vi.fn(() => ({ valid: true })),
          _isFileCouncil: vi.fn(() => false),
          _postCouncil: vi.fn(async () => true),
          ...overrides
        });
      }

      it('rejects a name held by a council of the OTHER type', async () => {
        const offered = [];
        window.textInputDialog = {
          show: vi.fn(async (options) => {
            offered.push(options.value);
            return offered.length === 1 ? 'Dream Team' : 'Dream Team II';
          })
        };
        // `councils` is empty — this tab cannot see the collision. Only
        // `_allCouncils` can.
        const ctx = scanCtx({ _allCouncils: [OTHER_TYPE] });

        await expect(TabClass.prototype._saveCouncilAs.call(ctx)).resolves.toBe(true);

        expect(window.toast.showWarning)
          .toHaveBeenCalledWith('A council with that name already exists.');
        expect(ctx._postCouncil).toHaveBeenCalledWith('Dream Team II', CONFIG);
      });

      it('accepts a free name without bouncing', async () => {
        window.textInputDialog = { show: vi.fn(async (o) => o.value || 'Fresh') };
        const ctx = scanCtx({ _allCouncils: [OTHER_TYPE] });

        await expect(TabClass.prototype._saveCouncilAs.call(ctx)).resolves.toBe(true);

        expect(window.toast.showWarning).not.toHaveBeenCalled();
        expect(window.textInputDialog.show).toHaveBeenCalledTimes(1);
      });

      it('falls back to the filtered list when the tab never loaded', async () => {
        // `_allCouncils` absent (a stubbed context, or a tab whose first
        // loadCouncils has not resolved): the scan is the strictly narrower one
        // it always was, never a crash.
        const offered = [];
        window.textInputDialog = {
          show: vi.fn(async (options) => {
            offered.push(options.value);
            return offered.length === 1 ? 'Db Council' : 'Db Council II';
          })
        };
        const ctx = scanCtx({ councils: [{ id: 'c1', name: 'Db Council' }] });
        delete ctx._allCouncils;

        await expect(TabClass.prototype._saveCouncilAs.call(ctx)).resolves.toBe(true);

        expect(window.toast.showWarning)
          .toHaveBeenCalledWith('A council with that name already exists.');
        expect(ctx._postCouncil).toHaveBeenCalledWith('Db Council II', CONFIG);
      });

      it('matches case-insensitively and tolerates a nameless row', async () => {
        const offered = [];
        window.textInputDialog = {
          show: vi.fn(async (options) => {
            offered.push(options.value);
            return offered.length === 1 ? 'dream team' : 'Something Else';
          })
        };
        const ctx = scanCtx({ _allCouncils: [{ id: 'x' }, OTHER_TYPE] });

        await expect(TabClass.prototype._saveCouncilAs.call(ctx)).resolves.toBe(true);

        expect(window.toast.showWarning)
          .toHaveBeenCalledWith('A council with that name already exists.');
        expect(ctx._postCouncil).toHaveBeenCalledWith('Something Else', CONFIG);
      });
    });
  });
}
