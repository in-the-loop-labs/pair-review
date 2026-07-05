// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const BRIDGE_PATH = '../../public/js/modules/pierre-bridge.js';

// Coverage for the batch annotation path (addAnnotations): applying K
// annotations to a file must trigger exactly ONE setLineAnnotations + rerender
// + split-layout sync, not K of them. Loop callers (loadUserComments,
// SuggestionManager) rely on this to avoid K full shadow-DOM rebuilds per file.

describe('PierreBridge batch annotations', () => {
  let PierreBridge;
  let dom;
  let bridge;
  let instance;
  let fileState;

  beforeEach(() => {
    delete require.cache[require.resolve(BRIDGE_PATH)];
    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    global.document = dom.window.document;
    global.window = {
      PierreDiffs: undefined,
      matchMedia: () => ({ matches: false }),
    };
    // Keep _syncSplitAnnotationLayout's rAF a no-op so no timers leak; we count
    // it separately via a spy below.
    global.requestAnimationFrame = () => {};
    PierreBridge = require(BRIDGE_PATH);
    bridge = new PierreBridge({});

    instance = {
      setLineAnnotations: vi.fn(),
      rerender: vi.fn(),
    };
    fileState = {
      instance,
      fileName: 'a.js',
      container: global.document.createElement('div'),
      annotations: [],
      formElements: new Map(),
    };
    bridge.files.set('a.js', fileState);
    // Spy on the split-layout sync so we can assert one call per batch.
    vi.spyOn(bridge, '_syncSplitAnnotationLayout');
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.requestAnimationFrame;
    vi.restoreAllMocks();
  });

  function makeAnnotations(n) {
    return Array.from({ length: n }, (_, i) => ({
      lineNumber: i + 1,
      side: 'RIGHT',
      type: 'comment',
      id: `comment-${i + 1}`,
      data: { id: i + 1 },
    }));
  }

  it('applies a batch of N annotations with exactly one rerender', () => {
    bridge.addAnnotations('a.js', makeAnnotations(5));

    expect(fileState.annotations).toHaveLength(5);
    expect(instance.setLineAnnotations).toHaveBeenCalledTimes(1);
    expect(instance.rerender).toHaveBeenCalledTimes(1);
    expect(bridge._syncSplitAnnotationLayout).toHaveBeenCalledTimes(1);
    // The single setLineAnnotations call carries all five annotations.
    expect(instance.setLineAnnotations.mock.calls[0][0]).toHaveLength(5);
  });

  it('applies the same shape/ids a per-item loop would produce', () => {
    bridge.addAnnotations('a.js', makeAnnotations(3));

    expect(fileState.annotations.map(a => a.metadata.id)).toEqual([
      'comment-1', 'comment-2', 'comment-3',
    ]);
    expect(fileState.annotations[0]).toMatchObject({
      side: 'additions',
      lineNumber: 1,
      metadata: { type: 'comment', id: 'comment-1' },
    });
  });

  it('single addAnnotation still triggers exactly one rerender', () => {
    bridge.addAnnotation('a.js', {
      lineNumber: 2, side: 'RIGHT', type: 'comment', id: 'c-1', data: {},
    });

    expect(fileState.annotations).toHaveLength(1);
    expect(instance.setLineAnnotations).toHaveBeenCalledTimes(1);
    expect(instance.rerender).toHaveBeenCalledTimes(1);
  });

  it('N single addAnnotation calls rerender N times (demonstrates the batch win)', () => {
    for (const ann of makeAnnotations(4)) bridge.addAnnotation('a.js', ann);
    expect(instance.rerender).toHaveBeenCalledTimes(4);
  });

  it('is a no-op (no crash, no rerender) for a missing / not-yet-rendered file', () => {
    expect(() => bridge.addAnnotations('missing.js', makeAnnotations(3))).not.toThrow();
    expect(instance.rerender).not.toHaveBeenCalled();
  });

  it('does not rerender for an empty or non-array batch', () => {
    bridge.addAnnotations('a.js', []);
    bridge.addAnnotations('a.js', undefined);
    expect(fileState.annotations).toHaveLength(0);
    expect(instance.rerender).not.toHaveBeenCalled();
  });

  it('generates fallback ids when a batch item omits one', () => {
    bridge.addAnnotations('a.js', [
      { lineNumber: 9, side: 'LEFT', type: 'suggestion', data: {} },
    ]);
    const { id, type } = fileState.annotations[0].metadata;
    expect(type).toBe('suggestion');
    expect(id).toMatch(/^suggestion-9-deletions-\d+$/);
  });
});
