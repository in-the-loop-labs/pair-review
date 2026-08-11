// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the shared Export-button behavior used by both council config
 * tabs (public/js/utils/council-export.js).
 *
 * Runs in jsdom so the `window.CouncilExport` registration block — the seam the
 * tabs actually use — is exercised, and so collaborators can be swapped on the
 * real `window` the way the browser would see them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CouncilExportModule = require('../../public/js/utils/council-export.js');
const { exportCouncilFromTab } = CouncilExportModule;

const validConfig = { voices: [{ provider: 'claude', model: 'opus' }], levels: { 1: true } };

describe('window.CouncilExport registration', () => {
  // The tabs only ever reach this module through the browser global; the tests
  // below use the CommonJS export. Pin them together so a dropped key or a
  // casing slip in the registration block cannot ship green.
  it('exposes exactly the CommonJS export surface', () => {
    expect(window.CouncilExport).toBeDefined();
    expect(Object.keys(window.CouncilExport).sort())
      .toEqual(Object.keys(CouncilExportModule).sort());
  });

  it('exposes the same function identities as the CommonJS export', () => {
    for (const key of Object.keys(CouncilExportModule)) {
      expect(window.CouncilExport[key]).toBe(CouncilExportModule[key]);
    }
  });

  it('carries the entry point the config tabs call', () => {
    expect(typeof window.CouncilExport.exportCouncilFromTab).toBe('function');
  });
});

describe('exportCouncilFromTab', () => {
  let exportCouncilToFile;
  let toast;
  let consoleError;
  let doc;

  /** A stand-in for a config tab: only the four members the helper touches. */
  function makeTab(overrides = {}) {
    return {
      _readConfigFromUI: vi.fn(() => validConfig),
      _validateConfig: vi.fn(() => ({ valid: true, error: null })),
      councils: [{ id: 'c1', name: 'Dream Team' }],
      selectedCouncilId: 'c1',
      ...overrides
    };
  }

  beforeEach(() => {
    doc = { pair_review_council: 1, name: 'Dream Team', type: 'council', config: validConfig };
    exportCouncilToFile = vi.fn(() => ({ doc, copied: Promise.resolve(true) }));
    toast = { showSuccess: vi.fn(), showError: vi.fn(), showWarning: vi.fn() };
    window.CouncilDocument = { exportCouncilToFile };
    window.toast = toast;
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete window.CouncilDocument;
    delete window.toast;
    consoleError.mockRestore();
  });

  describe('the exported document', () => {
    it('exports the live UI config under the selected council name', async () => {
      const tab = makeTab();

      const result = await exportCouncilFromTab(tab, 'council');

      expect(tab._readConfigFromUI).toHaveBeenCalledTimes(1);
      expect(exportCouncilToFile).toHaveBeenCalledWith({
        name: 'Dream Team',
        type: 'council',
        config: validConfig
      });
      expect(result).toBe(doc);
    });

    it('passes the council type it was given through untouched', async () => {
      await exportCouncilFromTab(makeTab(), 'advanced');
      expect(exportCouncilToFile.mock.calls[0][0].type).toBe('advanced');
    });

    it.each([
      ['nothing is selected', { selectedCouncilId: null }],
      ['the selected id is not in the list', { selectedCouncilId: 'gone' }],
      ['the council list is empty', { councils: [], selectedCouncilId: 'c1' }],
      ['the council list is missing entirely', { councils: undefined, selectedCouncilId: 'c1' }]
    ])('falls back to "Untitled Council" when %s', async (_label, overrides) => {
      await exportCouncilFromTab(makeTab(overrides), 'council');
      expect(exportCouncilToFile.mock.calls[0][0].name).toBe('Untitled Council');
    });
  });

  describe('validity gate', () => {
    it('refuses to export an invalid config and surfaces the validator message', async () => {
      const tab = makeTab({
        _validateConfig: vi.fn(() => ({ valid: false, error: 'At least one review level must be enabled.' }))
      });

      const result = await exportCouncilFromTab(tab, 'council');

      expect(exportCouncilToFile).not.toHaveBeenCalled();
      expect(toast.showWarning).toHaveBeenCalledWith('At least one review level must be enabled.');
      expect(toast.showSuccess).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('validates the same config object it would have exported', async () => {
      const tab = makeTab({
        _validateConfig: vi.fn(() => ({ valid: false, error: 'nope' }))
      });

      await exportCouncilFromTab(tab, 'council');

      expect(tab._validateConfig).toHaveBeenCalledWith(validConfig);
    });

    it('falls back to a generic message when the validator supplies none', async () => {
      const tab = makeTab({ _validateConfig: vi.fn(() => ({ valid: false, error: null })) });

      await exportCouncilFromTab(tab, 'council');

      expect(toast.showWarning).toHaveBeenCalledWith('Council configuration is not valid.');
    });

    it('does not throw when the gate trips and no toast is available', async () => {
      delete window.toast;
      const tab = makeTab({ _validateConfig: vi.fn(() => ({ valid: false, error: 'nope' })) });

      await expect(exportCouncilFromTab(tab, 'council')).resolves.toBeNull();
      expect(exportCouncilToFile).not.toHaveBeenCalled();
    });
  });

  describe('clipboard-aware toast', () => {
    it('promises the clipboard only when the copy actually happened', async () => {
      await exportCouncilFromTab(makeTab(), 'council');
      expect(toast.showSuccess).toHaveBeenCalledWith('Council exported and copied to clipboard');
    });

    it('claims only the download when the copy did not happen', async () => {
      exportCouncilToFile.mockReturnValue({ doc, copied: Promise.resolve(false) });

      await exportCouncilFromTab(makeTab(), 'council');

      expect(toast.showSuccess).toHaveBeenCalledWith('Council exported');
    });

    it('waits for the clipboard outcome before toasting', async () => {
      let settle;
      exportCouncilToFile.mockReturnValue({
        doc,
        copied: new Promise(resolve => { settle = resolve; })
      });

      const pending = exportCouncilFromTab(makeTab(), 'council');
      // Drain the microtask queue: the toast must still be waiting.
      await Promise.resolve();
      expect(toast.showSuccess).not.toHaveBeenCalled();

      settle(true);
      await pending;
      expect(toast.showSuccess).toHaveBeenCalledWith('Council exported and copied to clipboard');
    });

    it('treats an absent clipboard outcome as "not copied"', async () => {
      exportCouncilToFile.mockReturnValue({ doc });

      await exportCouncilFromTab(makeTab(), 'council');

      expect(toast.showSuccess).toHaveBeenCalledWith('Council exported');
    });
  });

  describe('failure handling', () => {
    it('reports an error toast when the export throws', async () => {
      exportCouncilToFile.mockImplementation(() => { throw new Error('no can do'); });

      const result = await exportCouncilFromTab(makeTab(), 'council');

      expect(toast.showError).toHaveBeenCalledWith('Failed to export council');
      expect(toast.showSuccess).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('does not throw when no toast is available', async () => {
      delete window.toast;

      await expect(exportCouncilFromTab(makeTab(), 'council')).resolves.toBe(doc);
      expect(exportCouncilToFile).toHaveBeenCalledTimes(1);
    });

    it('resolves the CouncilDocument collaborator at call time', async () => {
      // Swapped after this module was loaded — load-time capture would miss it.
      const later = vi.fn(() => ({ doc, copied: Promise.resolve(false) }));
      window.CouncilDocument = { exportCouncilToFile: later };

      await exportCouncilFromTab(makeTab(), 'council');

      expect(later).toHaveBeenCalledTimes(1);
      expect(exportCouncilToFile).not.toHaveBeenCalled();
    });
  });
});
