// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the browser half of the council document module:
 * exportCouncilToFile's download + reported clipboard outcome, and the
 * `window.CouncilDocument` registration block
 * (public/js/utils/council-document.js). jsdom has no Blob URL support, so
 * URL.createObjectURL/revokeObjectURL are stubbed and asserted directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CouncilDocumentModule = require('../../public/js/utils/council-document.js');
const { exportCouncilToFile } = CouncilDocumentModule;

const councilConfig = {
  voices: [{ provider: 'claude', model: 'opus' }],
  levels: { 1: true, 2: false, 3: false }
};

describe('window.CouncilDocument registration', () => {
  // The tabs only ever see the browser global; every test above/below this one
  // exercises the CommonJS export. Nothing else pins the two together, so a
  // dropped key or a casing slip in the registration block would ship green.
  it('exposes exactly the CommonJS export surface', () => {
    expect(window.CouncilDocument).toBeDefined();
    expect(Object.keys(window.CouncilDocument).sort())
      .toEqual(Object.keys(CouncilDocumentModule).sort());
  });

  it('exposes the same function identities as the CommonJS export', () => {
    for (const key of Object.keys(CouncilDocumentModule)) {
      expect(window.CouncilDocument[key]).toBe(CouncilDocumentModule[key]);
    }
  });

  it('carries the entry points the config tabs depend on', () => {
    expect(typeof window.CouncilDocument.exportCouncilToFile).toBe('function');
    expect(typeof window.CouncilDocument.parseCouncilDocument).toBe('function');
    expect(typeof window.CouncilDocument.buildCouncilDocument).toBe('function');
  });
});

describe('exportCouncilToFile', () => {
  let createObjectURL;
  let revokeObjectURL;
  let clicked;

  beforeEach(() => {
    vi.useFakeTimers();
    clicked = [];
    createObjectURL = vi.fn(() => 'blob:council-url');
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    // jsdom anchors do not navigate; record the click and its element instead.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      clicked.push({
        element: this,
        download: this.download,
        href: this.getAttribute('href'),
        attached: document.body.contains(this)
      });
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete URL.createObjectURL;
    // NOT deleted: the one real-timer test below leaves production's deferred
    // `setTimeout(() => URL.revokeObjectURL(url), 0)` in flight. jsdom has no
    // native implementation, so deleting this would let a late callback throw
    // "URL.revokeObjectURL is not a function" from a timer, surfacing as an
    // uncaught error attributed to whichever test happens to be running. A
    // no-op cannot trip; the next beforeEach reinstalls the spy.
    URL.revokeObjectURL = () => {};
    delete navigator.clipboard;
  });

  it('downloads the document under a slugged .council.json filename', () => {
    exportCouncilToFile({ name: 'Dream Team', type: 'council', config: councilConfig });

    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('dream-team.council.json');
    expect(clicked[0].href).toBe('blob:council-url');
    expect(clicked[0].attached).toBe(true);
  });

  it('creates the blob from the pretty-printed document JSON', async () => {
    const { doc } = exportCouncilToFile({
      name: 'Dream Team',
      type: 'council',
      config: councilConfig,
      description: 'Notes'
    });

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe(JSON.stringify(doc, null, 2));
    expect(doc).toEqual({
      pair_review_council: 1,
      name: 'Dream Team',
      type: 'council',
      description: 'Notes',
      config: councilConfig
    });
  });

  it('removes the temporary anchor and revokes the object URL', () => {
    exportCouncilToFile({ name: 'Dream Team', type: 'council', config: councilConfig });

    expect(document.body.contains(clicked[0].element)).toBe(false);
    // Revoke is deferred one macrotask so the download is not cancelled.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:council-url');
  });

  describe('clipboard outcome', () => {
    it('copies the same JSON and reports copied: true', async () => {
      const { doc, copied } = exportCouncilToFile({
        name: 'Dream Team',
        type: 'council',
        config: councilConfig
      });

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(JSON.stringify(doc, null, 2));
      await expect(copied).resolves.toBe(true);
    });

    it('reports copied: false when the clipboard write rejects, and still exports', async () => {
      navigator.clipboard.writeText = vi.fn(() => Promise.reject(new Error('denied')));

      const { copied } = exportCouncilToFile({ name: 'Dream Team', type: 'council', config: councilConfig });

      await expect(copied).resolves.toBe(false);
      expect(clicked).toHaveLength(1);
    });

    it('reports copied: false when the clipboard write throws synchronously', async () => {
      navigator.clipboard.writeText = vi.fn(() => { throw new Error('blocked'); });

      const { copied } = exportCouncilToFile({ name: 'Dream Team', type: 'council', config: councilConfig });

      await expect(copied).resolves.toBe(false);
      expect(clicked).toHaveLength(1);
    });

    it('reports copied: false when the clipboard API is unavailable', async () => {
      delete navigator.clipboard;

      const { copied } = exportCouncilToFile({ name: 'Dream Team', type: 'council', config: councilConfig });

      await expect(copied).resolves.toBe(false);
      expect(clicked).toHaveLength(1);
    });

    it('reports copied: false when writeText is missing from the clipboard object', async () => {
      Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });

      const { copied } = exportCouncilToFile({ name: 'Dream Team', type: 'council', config: councilConfig });

      await expect(copied).resolves.toBe(false);
    });

    it('produces no unhandled rejection when the copied promise is ignored', async () => {
      // Real timers: unhandled rejections are reported on later event-loop
      // turns, which fake timers would never deliver.
      vi.useRealTimers();
      navigator.clipboard.writeText = vi.fn(() => Promise.reject(new Error('denied')));

      const rejections = [];
      const onUnhandled = (reason) => rejections.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        // Deliberately discard the return value, as a caller that only wants
        // the download would.
        exportCouncilToFile({ name: 'Dream Team', type: 'council', config: councilConfig });
        // Drain microtasks, then let the event loop turn over twice so Node has
        // had every chance to report an unhandled rejection.
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }

      expect(rejections).toEqual([]);
    });
  });

  it('falls back to the "council" stem for an unsluggable name', () => {
    exportCouncilToFile({ name: '審査会', type: 'advanced', config: { levels: {} } });
    expect(clicked[0].download).toBe('council.council.json');
  });

  it('throws (and downloads nothing) when the document is invalid', () => {
    expect(() => exportCouncilToFile({ name: '', type: 'council', config: councilConfig }))
      .toThrow(/name is required/i);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(0);
  });
});
