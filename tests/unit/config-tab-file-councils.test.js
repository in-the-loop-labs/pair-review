// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for read-only file-council handling on both council config tabs.
 *
 * Councils loaded from the file overlay (`~/.pair-review/councils/*.json`) are
 * served by the API with `source: 'file'` and cannot be written back — PUT and
 * DELETE on a `file:` id are refused with 403. The two tabs therefore have to
 * refuse those writes BEFORE the request:
 *
 *   1. `_renderCouncilSelector` labels a file council "<name> (file)" so the
 *      read-only row is identifiable in the native <select>,
 *   2. `_updateSaveButtonStates` disables Save and Delete while leaving Save As
 *      (a POST of a copy) on its validity check alone,
 *   3. `_saveCouncil` falls through to `_saveCouncilAs()` instead of PUTting —
 *      the same fork-a-copy branch the "no selection" case takes, and
 *   4. `autoSaveIfDirty` forks a timestamped DB copy when an edited file
 *      council is analyzed.
 *
 * The refusal is keyed on the *id* (`file:` prefix), not on a joined `source`
 * field, so it survives an empty or stale `this.councils` — several cases below
 * pin exactly that.
 *
 * Both tabs implement this independently, so every case runs against both.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Installs `window.CouncilCrud`, which the tabs' CRUD methods delegate to.
require('../../public/js/utils/council-crud.js');
const { VoiceCentricConfigTab } = require('../../public/js/components/VoiceCentricConfigTab.js');
const { AdvancedConfigTab } = require('../../public/js/components/AdvancedConfigTab.js');

const DB_COUNCIL = { id: 'c1', name: 'Db Council', type: 'council', source: 'db', config: {} };
const FILE_COUNCIL = {
  id: 'file:dream-team',
  name: 'File Council',
  type: 'council',
  source: 'file',
  readOnly: true,
  filePath: '/home/dev/.pair-review/councils/dream-team.council.json',
  config: {}
};

const TABS = [
  {
    label: 'VoiceCentricConfigTab',
    TabClass: VoiceCentricConfigTab,
    panelId: 'tab-panel-council',
    selectorId: 'vc-council-selector',
    ids: {
      save: 'vc-council-save-btn',
      saveAs: 'vc-council-save-as-btn',
      export: 'vc-council-export-btn',
      delete: 'vc-council-delete-btn'
    },
    validConfig: { levels: { 1: true, 2: false, 3: false } },
    // Voice-centric validity also depends on the reviewer count.
    extraCtx: { _getReviewerCount: () => 2 }
  },
  {
    label: 'AdvancedConfigTab',
    TabClass: AdvancedConfigTab,
    panelId: 'tab-panel-advanced',
    selectorId: 'council-selector',
    ids: {
      save: 'council-save-btn',
      saveAs: 'council-save-as-btn',
      export: 'council-export-btn',
      delete: 'council-delete-btn'
    },
    validConfig: { levels: { 1: { enabled: true }, 2: { enabled: false } } },
    extraCtx: {}
  }
];

/**
 * Build the minimal real DOM the tabs query: a modal containing the tab's own
 * panel, its council <select>, and the four action buttons. Real elements (not
 * stand-ins) so `_renderCouncilSelector`'s `document.createElement('option')`
 * and the buttons' `disabled` property behave as they do in the browser.
 */
function mountTab({ panelId, selectorId, ids }) {
  document.body.innerHTML = `
    <div id="modal">
      <div id="${panelId}">
        <select id="${selectorId}"></select>
        <button id="${ids.save}"></button>
        <button id="${ids.saveAs}"></button>
        <button id="${ids.export}"></button>
        <button id="${ids.delete}"></button>
      </div>
    </div>
  `;
  return document.getElementById('modal');
}

/** A tab-like context wired to the REAL prototype helpers under test. */
function makeCtx(spec, overrides = {}) {
  const { TabClass, validConfig, extraCtx } = spec;
  return {
    modal: mountTab(spec),
    councils: [DB_COUNCIL, FILE_COUNCIL],
    selectedCouncilId: null,
    _isDirty: false,
    _readConfigFromUI: vi.fn(() => validConfig),
    _validateConfig: TabClass.prototype._validateConfig,
    _updateDirtyHint: TabClass.prototype._updateDirtyHint,
    _isFileCouncil: TabClass.prototype._isFileCouncil,
    _formatTimestamp: TabClass.prototype._formatTimestamp,
    ...extraCtx,
    ...overrides
  };
}

const btn = (ctx, id) => ctx.modal.querySelector(`#${id}`);

/** A promise plus its resolver, for pinning ordering without sleeping. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Assert that `pending` has NOT settled while the forked save is still gated.
 *
 * The observation has to be on `pending` itself. Checking a flag the fork sets
 * proves nothing: read synchronously it is false under every implementation,
 * and read after `await pending` it is true even when `pending` was never
 * connected to the fork, because the fork's continuation is already queued
 * ahead of the test's own resumption.
 *
 * Draining to a macrotask boundary lets a promise that resolves after any
 * number of internal awaits — the delegation adds a few — settle first, so a
 * floated `this._saveCouncilAs()` is caught rather than merely out-raced.
 */
async function expectPendingWhileGated(pending) {
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise(setImmediate);
  expect(settled).toBe(false);
}

beforeEach(() => {
  window.toast = { showWarning: vi.fn(), showError: vi.fn(), showSuccess: vi.fn() };
});

afterEach(() => {
  delete window.toast;
  delete window.textInputDialog;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

for (const spec of TABS) {
  const { label, TabClass, selectorId, ids } = spec;

  describe(`${label}._isFileCouncil`, () => {
    it('is true only for an id in the `file:` namespace', () => {
      const isFile = (id) => TabClass.prototype._isFileCouncil.call({}, id);
      expect(isFile(FILE_COUNCIL.id)).toBe(true);
      expect(isFile('file:x')).toBe(true);
      // A DB council id is a UUID and never carries the prefix.
      expect(isFile(DB_COUNCIL.id)).toBe(false);
      expect(isFile('0d1b6a4e-2f3c-4b8a-9f10-6d2c5a7e91b3')).toBe(false);
      expect(isFile(undefined)).toBe(false);
      expect(isFile(null)).toBe(false);
      expect(isFile('')).toBe(false);
      // Non-strings (e.g. a council object passed by mistake) must not throw.
      expect(isFile(FILE_COUNCIL)).toBe(false);
      expect(isFile(42)).toBe(false);
    });
  });

  describe(`${label}._renderCouncilSelector (file suffix)`, () => {
    it('suffixes only the file council option with " (file)"', () => {
      const ctx = makeCtx(spec);

      TabClass.prototype._renderCouncilSelector.call(ctx);

      const options = [...ctx.modal.querySelectorAll(`#${selectorId} option`)];
      // "+ New Council" placeholder first, then the councils in list order.
      expect(options.map(o => o.textContent)).toEqual([
        '+ New Council',
        'Db Council',
        'File Council (file)'
      ]);
      // The value stays the raw id — only the label is decorated.
      expect(options[2].value).toBe(FILE_COUNCIL.id);
    });
  });

  describe(`${label}._updateSaveButtonStates (file council selected)`, () => {
    it('disables Save and Delete for a file council even when dirty and valid', () => {
      const ctx = makeCtx(spec, { selectedCouncilId: FILE_COUNCIL.id, _isDirty: true });

      TabClass.prototype._updateSaveButtonStates.call(ctx);

      expect(btn(ctx, ids.save).disabled).toBe(true);
      expect(btn(ctx, ids.delete).disabled).toBe(true);
      // Save As / Export are gated on validity only — forking a copy is allowed.
      expect(btn(ctx, ids.saveAs).disabled).toBe(false);
      expect(btn(ctx, ids.export).disabled).toBe(false);
    });

    it('still disables Save and Delete when the council list is empty', () => {
      // loadCouncils() swallows fetch failures by setting `councils = []`. The
      // id-based predicate has to hold anyway, or a stale list re-enables a
      // write the API will refuse.
      const ctx = makeCtx(spec, {
        councils: [],
        selectedCouncilId: FILE_COUNCIL.id,
        _isDirty: true
      });

      TabClass.prototype._updateSaveButtonStates.call(ctx);

      expect(btn(ctx, ids.save).disabled).toBe(true);
      expect(btn(ctx, ids.delete).disabled).toBe(true);
      expect(btn(ctx, ids.saveAs).disabled).toBe(false);
    });

    it('enables Save and Delete for a dirty db council', () => {
      const ctx = makeCtx(spec, { selectedCouncilId: DB_COUNCIL.id, _isDirty: true });

      TabClass.prototype._updateSaveButtonStates.call(ctx);

      expect(btn(ctx, ids.save).disabled).toBe(false);
      expect(btn(ctx, ids.delete).disabled).toBe(false);
      expect(btn(ctx, ids.saveAs).disabled).toBe(false);
    });

    it('keeps Delete enabled for a clean db council but Save disabled', () => {
      const ctx = makeCtx(spec, { selectedCouncilId: DB_COUNCIL.id, _isDirty: false });

      TabClass.prototype._updateSaveButtonStates.call(ctx);

      expect(btn(ctx, ids.save).disabled).toBe(true);
      expect(btn(ctx, ids.delete).disabled).toBe(false);
    });
  });

  describe(`${label}._saveCouncil (file council selected)`, () => {
    it('forks a copy via _saveCouncilAs instead of updating in place', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const ctx = makeCtx(spec, {
        selectedCouncilId: FILE_COUNCIL.id,
        _saveCouncilAs: vi.fn(),
        _putCouncil: vi.fn()
      });

      await TabClass.prototype._saveCouncil.call(ctx);

      expect(ctx._saveCouncilAs).toHaveBeenCalledTimes(1);
      expect(ctx._putCouncil).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('forks a copy even when the council list is empty', async () => {
      const ctx = makeCtx(spec, {
        councils: [],
        selectedCouncilId: FILE_COUNCIL.id,
        _saveCouncilAs: vi.fn(),
        _putCouncil: vi.fn()
      });

      await TabClass.prototype._saveCouncil.call(ctx);

      expect(ctx._saveCouncilAs).toHaveBeenCalledTimes(1);
      expect(ctx._putCouncil).not.toHaveBeenCalled();
    });

    it('does not resolve before the forked save settles', async () => {
      // The file branch has to `return this._saveCouncilAs()`; a bare call
      // leaves a floating promise and the caller races the POST.
      const gate = deferred();
      let saveAsSettled = false;
      const ctx = makeCtx(spec, {
        selectedCouncilId: FILE_COUNCIL.id,
        _saveCouncilAs: vi.fn(async () => {
          await gate.promise;
          saveAsSettled = true;
        }),
        _putCouncil: vi.fn()
      });

      const pending = TabClass.prototype._saveCouncil.call(ctx);
      await expectPendingWhileGated(pending);

      gate.resolve();
      await pending;

      expect(saveAsSettled).toBe(true);
    });

    it('does not resolve before the forked save settles when nothing is selected', async () => {
      const gate = deferred();
      let saveAsSettled = false;
      const ctx = makeCtx(spec, {
        selectedCouncilId: null,
        _saveCouncilAs: vi.fn(async () => {
          await gate.promise;
          saveAsSettled = true;
        }),
        _putCouncil: vi.fn()
      });

      const pending = TabClass.prototype._saveCouncil.call(ctx);
      await expectPendingWhileGated(pending);

      gate.resolve();
      await pending;

      expect(saveAsSettled).toBe(true);
    });

    it('updates in place when the selected council is a db council', async () => {
      const ctx = makeCtx(spec, {
        selectedCouncilId: DB_COUNCIL.id,
        _saveCouncilAs: vi.fn(),
        _putCouncil: vi.fn()
      });

      await TabClass.prototype._saveCouncil.call(ctx);

      expect(ctx._putCouncil).toHaveBeenCalledWith(DB_COUNCIL.id, spec.validConfig);
      expect(ctx._saveCouncilAs).not.toHaveBeenCalled();
    });

    it('still prompts for a name when nothing is selected', async () => {
      const ctx = makeCtx(spec, {
        selectedCouncilId: null,
        _saveCouncilAs: vi.fn(),
        _putCouncil: vi.fn()
      });

      await TabClass.prototype._saveCouncil.call(ctx);

      expect(ctx._saveCouncilAs).toHaveBeenCalledTimes(1);
      expect(ctx._putCouncil).not.toHaveBeenCalled();
    });
  });

  describe(`${label}._saveCouncilAs (file council selected)`, () => {
    /** Stub the text-input dialog so it accepts whatever name it is offered. */
    function stubDialog() {
      const shown = [];
      window.textInputDialog = {
        show: vi.fn(async (options) => {
          shown.push(options);
          return options.value;
        })
      };
      return shown;
    }

    it('offers "<name> (copy)" so the first prompt clears the duplicate scan', async () => {
      const shown = stubDialog();
      const ctx = makeCtx(spec, {
        selectedCouncilId: FILE_COUNCIL.id,
        _postCouncil: vi.fn(async () => {})
      });

      await TabClass.prototype._saveCouncilAs.call(ctx);

      // One prompt only: offering the file council's own name would collide
      // with itself and bounce the user back through the loop.
      expect(shown).toHaveLength(1);
      expect(shown[0].value).toBe('File Council (copy)');
      expect(ctx._postCouncil).toHaveBeenCalledTimes(1);
      expect(ctx._postCouncil).toHaveBeenCalledWith('File Council (copy)', spec.validConfig);
      expect(window.toast.showWarning).not.toHaveBeenCalled();
    });

    it('offers a db council its own name (Save As doubles as rename-to-copy)', async () => {
      const shown = stubDialog();
      const ctx = makeCtx(spec, {
        selectedCouncilId: DB_COUNCIL.id,
        _postCouncil: vi.fn(async () => {})
      });

      // Accept the second offer so the (correct) duplicate bounce terminates.
      window.textInputDialog.show = vi.fn(async (options) => {
        shown.push(options);
        return shown.length === 1 ? options.value : 'Db Council v2';
      });

      await TabClass.prototype._saveCouncilAs.call(ctx);

      expect(shown[0].value).toBe('Db Council');
      // The duplicate scan is untouched: its own name is still rejected.
      expect(window.toast.showWarning).toHaveBeenCalledWith('A council with that name already exists.');
      expect(ctx._postCouncil).toHaveBeenCalledWith('Db Council v2', spec.validConfig);
    });

    it('re-offers the name the user typed after a duplicate bounce', async () => {
      const shown = [];
      window.textInputDialog = {
        show: vi.fn(async (options) => {
          shown.push(options.value);
          // First prompt: user overrides the default with a colliding name.
          // Second prompt: the bounce re-offers what they typed; they amend it.
          return shown.length === 1 ? 'Db Council' : 'Db Council Fork';
        })
      };
      const ctx = makeCtx(spec, {
        selectedCouncilId: FILE_COUNCIL.id,
        _postCouncil: vi.fn(async () => {})
      });

      await TabClass.prototype._saveCouncilAs.call(ctx);

      // The retry pre-fills the rejected name, not the "(copy)" default —
      // otherwise the user loses their edit on every bounce.
      expect(shown).toEqual(['File Council (copy)', 'Db Council']);
      expect(ctx._postCouncil).toHaveBeenCalledWith('Db Council Fork', spec.validConfig);
    });
  });

  describe(`${label}.autoSaveIfDirty (file council selected)`, () => {
    it('forks a timestamped copy for a dirty file council instead of PUTting', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const ctx = makeCtx(spec, {
        selectedCouncilId: FILE_COUNCIL.id,
        _isDirty: true,
        _postCouncil: vi.fn(async () => {})
      });

      await TabClass.prototype.autoSaveIfDirty.call(ctx);

      expect(ctx._postCouncil).toHaveBeenCalledTimes(1);
      const [name, config] = ctx._postCouncil.mock.calls[0];
      expect(name).toMatch(/^File Council \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(config).toEqual(spec.validConfig);
      // No PUT: the only write is the POST above, which is stubbed out.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(window.toast.showWarning).not.toHaveBeenCalled();
    });

    it('does nothing for a clean file council and keeps its file: attribution', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const ctx = makeCtx(spec, {
        selectedCouncilId: FILE_COUNCIL.id,
        _isDirty: false,
        _postCouncil: vi.fn(async () => {})
      });

      await TabClass.prototype.autoSaveIfDirty.call(ctx);

      expect(ctx._postCouncil).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ctx.selectedCouncilId).toBe(FILE_COUNCIL.id);
    });
  });
}
