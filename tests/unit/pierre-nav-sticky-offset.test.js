// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for the shared CodeView whole-item scroll helper
 * (PRManager._scrollToPierreItemWithStickyOffset) and the item-id-aware landing
 * gap probe it drives (_pierreNavGap).
 *
 * The vendor compensates line/range scrolls but NOT item scrolls, so every
 * whole-item jump has to subtract the preceding item's pinned sticky header and
 * then correct the residual landing gap. scrollToFile (diff files) did this;
 * scrollToContextFile did not, and context files render as `context:<path>`
 * items in the SAME CodeView under the same sticky headers — so their headers
 * landed partially hidden. Both callers now share this helper.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

function makeManager(bridge) {
  const m = Object.create(PRManager.prototype);
  m.pierreBridge = bridge;
  return m;
}

function makeBridge(files = []) {
  return { files: new Map(files), scrollToFile: vi.fn(), codeView: null };
}

// jsdom gives every element a zero rect; stub the tops the probe subtracts.
function stubTop(el, top) {
  el.getBoundingClientRect = () => ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0 });
}

function mountHost(container, fileName, { context = false, headerTop = 0 } = {}) {
  const host = document.createElement('diffs-container');
  host.className = context ? 'd2h-file-wrapper context-file' : 'd2h-file-wrapper';
  host.dataset.fileName = fileName;
  const header = document.createElement('div');
  header.className = 'd2h-file-header';
  stubTop(header, headerTop);
  host.appendChild(header);
  container.appendChild(host);
  return host;
}

let container;

beforeEach(() => {
  // jsdom ships no CSS.escape; the selector builder in _pierreNavGap uses it.
  vi.stubGlobal('CSS', { escape: (value) => String(value).replace(/([.:])/g, '\\$1') });
  document.body.innerHTML = '';
  container = document.createElement('div');
  container.id = 'diff-container';
  stubTop(container, 100);
  document.body.appendChild(container);
});

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty('--diff-file-header-height');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PRManager._pierreNavGap', () => {
  it('measures the mounted header against the scroll container top', () => {
    mountHost(container, 'a.js', { headerTop: 142 });
    const m = makeManager(makeBridge([['a.js', { fileName: 'a.js', itemType: 'diff' }]]));

    expect(m._pierreNavGap('a.js')).toBe(42);
  });

  it('returns null while the target item is virtualized out', () => {
    const m = makeManager(makeBridge([['a.js', { fileName: 'a.js', itemType: 'diff' }]]));

    expect(m._pierreNavGap('a.js')).toBeNull();
  });

  // Both items stamp the same data-file-name (the plain path), so the item id
  // alone must pick the right host or a context jump measures the diff file.
  it('picks the context host for a context item when both items exist', () => {
    mountHost(container, 'a.js', { headerTop: 150 });
    mountHost(container, 'a.js', { context: true, headerTop: 300 });
    const m = makeManager(makeBridge([
      ['a.js', { fileName: 'a.js', itemType: 'diff' }],
      ['context:a.js', { fileName: 'a.js', itemType: 'context' }],
    ]));

    expect(m._pierreNavGap('context:a.js')).toBe(200);
    expect(m._pierreNavGap('a.js')).toBe(50);
  });
});

describe('PRManager._scrollToPierreItemWithStickyOffset', () => {
  function managerWithGaps(bridge, gaps) {
    const m = makeManager(bridge);
    const queue = [...gaps];
    m._awaitPierreNavGap = vi.fn(async () => (queue.length ? queue.shift() : null));
    return m;
  }

  it('scrolls with the measured header height and stops when the landing is flush', async () => {
    document.documentElement.style.setProperty('--diff-file-header-height', '48px');
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '48px' }));
    const bridge = makeBridge();
    const m = managerWithGaps(bridge, [1]); // within LANDING_TOLERANCE

    await m._scrollToPierreItemWithStickyOffset('a.js');

    expect(bridge.scrollToFile).toHaveBeenCalledTimes(1);
    expect(bridge.scrollToFile).toHaveBeenCalledWith(
      'a.js', { align: 'start', behavior: 'smooth', stickyOffset: 48 }
    );
  });

  it('nudges the offset by the residual gap until the item lands flush', async () => {
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '48px' }));
    const bridge = makeBridge();
    const m = managerWithGaps(bridge, [12, 0]);

    await m._scrollToPierreItemWithStickyOffset('context:a.js');

    expect(bridge.scrollToFile).toHaveBeenCalledTimes(2);
    // The correction is instant (no second glide) and applies to the SAME item.
    expect(bridge.scrollToFile).toHaveBeenLastCalledWith(
      'context:a.js', { align: 'start', behavior: 'auto', stickyOffset: 60 }
    );
  });

  it('bounds the correction loop when the gap never settles', async () => {
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '48px' }));
    const bridge = makeBridge();
    const m = managerWithGaps(bridge, [10, 10, 10, 10, 10, 10]);

    await m._scrollToPierreItemWithStickyOffset('a.js');

    expect(bridge.scrollToFile).toHaveBeenCalledTimes(4); // initial + 3 corrections
  });

  it('falls back to the vendor sticky offset when the header height is unmeasured', async () => {
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    const bridge = makeBridge();
    bridge.codeView = { getStickyHeaderOffset: () => 33 };
    const m = managerWithGaps(bridge, [0]);

    await m._scrollToPierreItemWithStickyOffset('a.js');

    expect(bridge.scrollToFile).toHaveBeenCalledWith(
      'a.js', { align: 'start', behavior: 'smooth', stickyOffset: 33 }
    );
  });

  it('uses no offset when neither source knows the header height', async () => {
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    const bridge = makeBridge();
    const m = managerWithGaps(bridge, [null]); // target never mounts

    await m._scrollToPierreItemWithStickyOffset('a.js');

    expect(bridge.scrollToFile).toHaveBeenCalledTimes(1);
    expect(bridge.scrollToFile).toHaveBeenCalledWith(
      'a.js', { align: 'start', behavior: 'smooth', stickyOffset: 0 }
    );
  });
});
