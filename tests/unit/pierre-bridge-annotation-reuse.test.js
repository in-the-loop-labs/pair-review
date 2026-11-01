// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const BRIDGE_PATH = '../../public/js/modules/pierre-bridge.js';

// @pierre/diffs 1.6 calls renderAnnotation for every annotation whenever the
// fileDiff object changes (context ranges, gap expansion), not only when the
// annotation changed. The bridge must hand back the element it already built
// for an unchanged annotation, so elements callers hold (e.g. a sidebar
// scroll-to-finding in flight) stay connected across those re-renders.

describe('PierreBridge annotation element reuse', () => {
  let PierreBridge;
  let bridge;
  let custom;

  beforeEach(() => {
    delete require.cache[require.resolve(BRIDGE_PATH)];
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    global.document = dom.window.document;
    global.window = {
      PierreDiffs: undefined,
      matchMedia: vi.fn(() => ({ matches: false })),
    };
    PierreBridge = require(BRIDGE_PATH);
    bridge = new PierreBridge({});
    custom = vi.fn((data) => {
      const el = document.createElement('div');
      el.textContent = data.text;
      return el;
    });
    bridge.registerAnnotationRenderer('note', custom);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  function annotation(metadata, lineNumber = 10, side = 'additions') {
    return { lineNumber, side, metadata };
  }

  it('reuses the element when the same annotation is rendered again', () => {
    const metadata = { type: 'note', data: { text: 'a' }, id: 'n-1' };
    const first = bridge._renderAnnotation(annotation(metadata), 'a.js', new Map());
    const second = bridge._renderAnnotation(annotation(metadata), 'a.js', new Map());
    expect(second).toBe(first);
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the annotation metadata is replaced', () => {
    const first = bridge._renderAnnotation(
      annotation({ type: 'note', data: { text: 'a' }, id: 'n-1' }), 'a.js', new Map());
    const second = bridge._renderAnnotation(
      annotation({ type: 'note', data: { text: 'b' }, id: 'n-1' }), 'a.js', new Map());
    expect(second).not.toBe(first);
    expect(second.textContent).toBe('b');
  });

  it('rebuilds when the same metadata moves to another line or side', () => {
    const metadata = { type: 'note', data: { text: 'a' }, id: 'n-1' };
    const first = bridge._renderAnnotation(annotation(metadata, 10), 'a.js', new Map());
    const moved = bridge._renderAnnotation(annotation(metadata, 11), 'a.js', new Map());
    const flipped = bridge._renderAnnotation(annotation(metadata, 11, 'deletions'), 'a.js', new Map());
    expect(moved).not.toBe(first);
    expect(flipped).not.toBe(moved);
    expect(custom).toHaveBeenCalledTimes(3);
  });

  it('does not cache an annotation that rendered nothing', () => {
    custom.mockReturnValueOnce(null);
    const metadata = { type: 'note', data: { text: 'a' }, id: 'n-1' };
    expect(bridge._renderAnnotation(annotation(metadata), 'a.js', new Map())).toBeUndefined();
    expect(bridge._renderAnnotation(annotation(metadata), 'a.js', new Map()).textContent).toBe('a');
  });
});
