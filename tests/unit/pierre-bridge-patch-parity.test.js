// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

const BRIDGE_PATH = '../../public/js/modules/pierre-bridge.js';

// Regression coverage for the patch-parity bug behind the CI E2E failures:
// the initial render parses the PATCH (with git's context lines), but
// upgradeFileContents re-diffs the full file contents, which can produce
// NARROWER hunks. The upgrade render then silently un-rendered lines that
// annotations were anchored to, leaving them as unslotted (invisible)
// light-DOM orphans. The bridge must capture the patch-rendered spans as
// patchParityRanges and merge them into every subsequent render — including
// after clearContextRanges, which only clears DYNAMIC expansion ranges.

function makeWindow() {
  return {
    PierreDiffs: undefined,
    matchMedia: () => ({ matches: false }),
    PierreContext: {
      mergeOverlapping: (ranges) => ranges,
      // Test double: tag the metadata with the ranges it was merged with so
      // assertions can inspect exactly what got rendered.
      mergeContextRanges: (base, ranges) => ({ ...base, mergedRanges: ranges }),
      subtractRanges: (existing, toRemove) =>
        existing.filter(r => !toRemove.some(t => t.startLine === r.startLine && t.endLine === r.endLine)),
    },
  };
}

describe('PierreBridge patch parity across content upgrades', () => {
  let PierreBridge;
  let bridge;
  let instance;
  let fileState;

  // Patch-parsed hunks: context included, lines 12-25 rendered.
  const PATCH_HUNKS = [{ additionStart: 12, additionCount: 14, deletionStart: 12, deletionCount: 10 }];
  // Full-contents re-diff: narrower, lines 17-25 only.
  const UPGRADED_HUNKS = [{ additionStart: 17, additionCount: 9, deletionStart: 17, deletionCount: 5 }];

  beforeEach(() => {
    delete require.cache[require.resolve(BRIDGE_PATH)];
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    global.document = dom.window.document;
    global.window = makeWindow();
    PierreBridge = require(BRIDGE_PATH);
    bridge = new PierreBridge({});

    instance = {
      fileDiff: { hunks: PATCH_HUNKS },
      renderCalls: [],
      render(payload) {
        this.renderCalls.push(payload);
        // Mirrors the vendor: render() replaces fileDiff synchronously.
        if (payload.fileDiff) this.fileDiff = payload.fileDiff;
        else this.fileDiff = { hunks: UPGRADED_HUNKS };
        return true;
      },
      hunksRenderer: { expandedHunks: new Map(), getExpandedHunk: () => undefined },
    };
    fileState = {
      instance,
      fileName: 'a.js',
      container: global.document.createElement('div'),
      annotations: [],
      formElements: new Map(),
      oldFile: null,
      newFile: null,
      baseMetadata: null,
      contextRanges: [],
      patchParityRanges: null,
      collapsed: false,
    };
    bridge.files.set('a.js', fileState);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  function upgrade() {
    return bridge.upgradeFileContents(
      'a.js',
      { name: 'a.js', contents: 'old' },
      { name: 'a.js', contents: 'new' }
    );
  }

  it('captures the patch-rendered spans as patchParityRanges at upgrade', () => {
    upgrade();
    expect(fileState.patchParityRanges).toEqual([{ startLine: 12, endLine: 25 }]);
    expect(fileState.baseMetadata.hunks).toBe(UPGRADED_HUNKS);
  });

  it('re-renders with parity ranges merged so no patch line disappears', () => {
    upgrade();
    const last = instance.renderCalls.at(-1);
    expect(last.fileDiff.mergedRanges).toEqual([{ startLine: 12, endLine: 25 }]);
    // The logical visibility check must agree: line 14 stays visible.
    // (fileDiff after the merge render carries the merged metadata.)
    instance.fileDiff = { hunks: [{ additionStart: 12, additionCount: 14, deletionStart: 12, deletionCount: 10 }] };
    expect(bridge.isLineVisible('a.js', 14, 'RIGHT')).toBe(true);
  });

  it('clearContextRanges keeps parity ranges — clears only dynamic ranges', () => {
    upgrade();
    bridge.addContextRanges('a.js', [{ startLine: 40, endLine: 50 }]);
    bridge.clearContextRanges('a.js');
    expect(fileState.contextRanges).toEqual([]);
    const last = instance.renderCalls.at(-1);
    expect(last.fileDiff.mergedRanges).toEqual([{ startLine: 12, endLine: 25 }]);
  });

  it('removeContextRanges falls back to parity-merged render, not raw base', () => {
    upgrade();
    bridge.addContextRanges('a.js', [{ startLine: 40, endLine: 50 }]);
    bridge.removeContextRanges('a.js', [{ startLine: 40, endLine: 50 }]);
    const last = instance.renderCalls.at(-1);
    expect(last.fileDiff.mergedRanges).toEqual([{ startLine: 12, endLine: 25 }]);
  });

  it('renders raw base after clear when there are no parity ranges', () => {
    fileState.baseMetadata = { hunks: UPGRADED_HUNKS };
    bridge.addContextRanges('a.js', [{ startLine: 40, endLine: 50 }]);
    bridge.clearContextRanges('a.js');
    const last = instance.renderCalls.at(-1);
    expect(last.fileDiff).toEqual({ hunks: UPGRADED_HUNKS });
    expect(last.fileDiff.mergedRanges).toBeUndefined();
  });

  it('does not recapture parity on subsequent upgrades', () => {
    upgrade();
    const captured = fileState.patchParityRanges;
    // Second upgrade sees the (wider, merged) rendered state — must not widen
    // parity beyond the original patch.
    instance.fileDiff = { hunks: [{ additionStart: 1, additionCount: 100, deletionStart: 1, deletionCount: 100 }] };
    upgrade();
    expect(fileState.patchParityRanges).toBe(captured);
  });

  it('skips deletion-only hunks when capturing parity (no NEW-file lines)', () => {
    instance.fileDiff = {
      hunks: [
        { additionStart: 5, additionCount: 0, deletionStart: 5, deletionCount: 3 },
        { additionStart: 30, additionCount: 4, deletionStart: 34, deletionCount: 2 },
      ],
    };
    upgrade();
    expect(fileState.patchParityRanges).toEqual([{ startLine: 30, endLine: 33 }]);
  });
});
