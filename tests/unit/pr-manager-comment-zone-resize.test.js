// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * PRManager._observeFileCommentZoneSize — one shared ResizeObserver over the
 * cached file-comments zones that flushes the CodeView scroll extent whenever a
 * zone changes height.
 *
 * The vendor re-measures the item itself, but pushes the new height into the
 * scrollable container only during a render pass, so after a form opens the DOM
 * extent stays short by the form's height (measured: 1216px against the vendor's
 * own 1430px) and Save is unreachable on a last file whose body already fills the
 * viewport. Observing the zone element covers every mutation path at once (form
 * open/cancel, card insert/delete, adopt-suggestion form, minimizer expand)
 * without any of them needing to know about the bridge.
 *
 * The callback ignores its entries entirely: the extent is a per-VIEW property, so
 * there is no item-id resolution and no first-fire skip here. A fake
 * ResizeObserver is injected and fired by hand — jsdom has no layout, and per
 * tests/CONVENTIONS.md nothing waits on a real async signal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnected = 0;
    FakeResizeObserver.instances.push(this);
  }

  observe(target) { this.observed.push(target); }
  unobserve(target) { this.observed = this.observed.filter((t) => t !== target); }
  disconnect() { this.disconnected += 1; this.observed = []; }

  /** Fire one callback batch carrying an entry per target (the browser's shape). */
  fire(...targets) {
    this.callback(targets.map((target) => ({ target })), this);
  }

  static instances = [];
}

function makeManager({ usesCodeView = true } = {}) {
  const m = Object.create(PRManager.prototype);
  m.pierreBridge = {
    files: new Map([['a.js', {}]]),
    syncScrollExtent: vi.fn(() => true),
    _disabled: !usesCodeView,
  };
  m.fileCommentManager = {
    createFileCommentsZone: (fileName) => {
      const zone = document.createElement('div');
      zone.className = 'file-comments-zone';
      zone.dataset.fileName = fileName;
      document.body.appendChild(zone);
      return zone;
    },
  };
  return m;
}

function makeZone(fileName) {
  const zone = document.createElement('div');
  zone.className = 'file-comments-zone';
  if (fileName !== undefined) zone.dataset.fileName = fileName;
  document.body.appendChild(zone);
  return zone;
}

let originalRO;

beforeEach(() => {
  document.body.innerHTML = '';
  FakeResizeObserver.instances = [];
  originalRO = global.ResizeObserver;
  global.ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  document.body.innerHTML = '';
  if (originalRO === undefined) delete global.ResizeObserver;
  else global.ResizeObserver = originalRO;
  vi.restoreAllMocks();
});

describe('PRManager._observeFileCommentZoneSize — guards', () => {
  it('no-ops when the environment has no ResizeObserver', () => {
    delete global.ResizeObserver;
    const m = makeManager();

    expect(() => m._observeFileCommentZoneSize(makeZone('a.js'))).not.toThrow();

    expect(m._fileCommentZoneObserver).toBeUndefined();
  });

  it('no-ops on the legacy (non-CodeView) renderer', () => {
    const m = makeManager({ usesCodeView: false });

    m._observeFileCommentZoneSize(makeZone('a.js'));

    expect(FakeResizeObserver.instances).toHaveLength(0);
    expect(m._fileCommentZoneObserver).toBeUndefined();
  });

  it('no-ops for a missing zone', () => {
    const m = makeManager();

    m._observeFileCommentZoneSize(null);
    m._observeFileCommentZoneSize(undefined);

    expect(FakeResizeObserver.instances).toHaveLength(0);
  });
});

describe('PRManager._observeFileCommentZoneSize — observation', () => {
  it('creates ONE observer shared by every zone', () => {
    const m = makeManager();

    m._observeFileCommentZoneSize(makeZone('a.js'));
    m._observeFileCommentZoneSize(makeZone('b.js'));
    m._observeFileCommentZoneSize(makeZone('c.js'));

    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0].observed).toHaveLength(3);
  });

  it('observes a cached zone exactly once across virtualization remounts', () => {
    // _getOrCreateFileCommentsZone caches per file and the zone is re-slotted on
    // every remount; observing again per remount would multiply the callbacks.
    const m = makeManager();

    const first = m._getOrCreateFileCommentsZone('a.js');
    const second = m._getOrCreateFileCommentsZone('a.js');
    const third = m._getOrCreateFileCommentsZone('a.js');

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0].observed).toEqual([first]);
  });
});

describe('PRManager._observeFileCommentZoneSize — callback', () => {
  it('flushes the scroll extent on the FIRST fire and every one after', () => {
    // No first-fire skip in this design: the observe-time callback is a real
    // opportunity to sync, and syncing is cheap (a queued render, no publish).
    const m = makeManager();
    const zone = makeZone('a.js');
    m._observeFileCommentZoneSize(zone);
    const ro = FakeResizeObserver.instances[0];

    ro.fire(zone);
    expect(m.pierreBridge.syncScrollExtent).toHaveBeenCalledTimes(1);

    ro.fire(zone);
    ro.fire(zone);
    expect(m.pierreBridge.syncScrollExtent).toHaveBeenCalledTimes(3);
  });

  it('flushes ONCE per callback batch, not once per entry', () => {
    // The extent is a per-view property, so a batch naming three zones needs one
    // flush — this is the coalescing that makes a resize storm affordable.
    const m = makeManager();
    const zoneA = makeZone('a.js');
    const zoneB = makeZone('b.js');
    const zoneC = makeZone('c.js');
    for (const z of [zoneA, zoneB, zoneC]) m._observeFileCommentZoneSize(z);
    const ro = FakeResizeObserver.instances[0];

    ro.fire(zoneA, zoneB, zoneC);

    expect(m.pierreBridge.syncScrollExtent).toHaveBeenCalledTimes(1);
  });

  it('takes no arguments from the entries (no per-item resolution)', () => {
    const m = makeManager();
    const zone = makeZone('a.js');
    m._observeFileCommentZoneSize(zone);
    const ro = FakeResizeObserver.instances[0];

    ro.fire(zone);

    expect(m.pierreBridge.syncScrollExtent).toHaveBeenCalledWith();
  });

  it('flushes for a zone with no data-file-name and for a path with no item', () => {
    // Nothing about the callback depends on resolving the zone to an item, so
    // neither case can suppress the flush.
    const m = makeManager();
    const anonymous = makeZone(undefined);
    const orphan = makeZone('not-in-the-diff.js');
    m._observeFileCommentZoneSize(anonymous);
    m._observeFileCommentZoneSize(orphan);
    const ro = FakeResizeObserver.instances[0];

    ro.fire(anonymous);
    ro.fire(orphan);

    expect(m.pierreBridge.syncScrollExtent).toHaveBeenCalledTimes(2);
  });

  it('survives the bridge disappearing between the resize and the callback', () => {
    const m = makeManager();
    const zone = makeZone('a.js');
    m._observeFileCommentZoneSize(zone);
    const ro = FakeResizeObserver.instances[0];

    const bridge = m.pierreBridge;
    m.pierreBridge = null; // teardown raced the resize

    expect(() => ro.fire(zone)).not.toThrow();
    expect(bridge.syncScrollExtent).not.toHaveBeenCalled();
  });
});

describe('PRManager.renderDiff — zone observer teardown', () => {
  /**
   * renderDiff on the CodeView path with the heavy render stubbed (same shape as
   * pr-manager-render-diff-guard.test.js), so the zone-cache reset can be
   * asserted without running a real render.
   */
  function renderableManager() {
    document.body.innerHTML = '<div id="diff-container"></div>';
    const m = Object.create(PRManager.prototype);
    m.generatedFiles = new Map();
    m.pierreBridge = {
      destroyAll: vi.fn(),
      renderAll: vi.fn(),
      files: new Map([['a.js', {}]]),
      syncScrollExtent: vi.fn(() => true),
      _disabled: false,
    };
    m.fileCommentManager = {
      createFileCommentsZone: (fileName) => {
        const zone = document.createElement('div');
        zone.className = 'file-comments-zone';
        zone.dataset.fileName = fileName;
        return zone;
      },
    };
    m._fileContentsAbort = { abort: vi.fn() };
    m._teardownFileBodyObserver = vi.fn();
    m._createPierreRenderBudget = vi.fn(() => ({}));
    m._renderDiffWithCodeView = vi.fn();
    m.loadContextFiles = vi.fn();
    return m;
  }

  const FILES = [{ file: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' }];

  it('disconnects the observer before replacing the zone cache', () => {
    const m = renderableManager();
    const zone = m._getOrCreateFileCommentsZone('a.js');
    const ro = FakeResizeObserver.instances[0];
    expect(m._fileCommentZones.get('a.js')).toBe(zone);

    m.renderDiff({ changed_files: FILES });

    expect(ro.disconnected).toBe(1);
    // No observation survives that could name the now-detached zone.
    expect(ro.observed).toEqual([]);
    expect(m._fileCommentZones.size).toBe(0);
  });

  it('re-observes freshly created zones after the re-render', () => {
    const m = renderableManager();
    const before = m._getOrCreateFileCommentsZone('a.js');
    m.renderDiff({ changed_files: FILES });

    const after = m._getOrCreateFileCommentsZone('a.js');

    expect(after).not.toBe(before);                        // cache was replaced
    expect(FakeResizeObserver.instances).toHaveLength(1);   // observer reused
    expect(FakeResizeObserver.instances[0].observed).toEqual([after]);

    FakeResizeObserver.instances[0].fire(after);
    expect(m.pierreBridge.syncScrollExtent).toHaveBeenCalledTimes(1);
  });

});
