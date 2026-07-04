// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

const BRIDGE_PATH = '../../public/js/modules/pierre-bridge.js';

// Regression coverage for the composite data-line-index bug: the @pierre/diffs
// bundle stamps rendered lines with data-line-index="<unifiedIndex>,<splitIndex>"
// (e.g. "4,3"), but isLineVisible/scrollToLine used to query the bare unified
// index ("4"), so every visible line was reported hidden — which broke tour
// stop mounting, hidden-suggestion detection, and scroll-to-line everywhere.

describe('PierreBridge._queryLineElement()', () => {
  let PierreBridge;
  let dom;

  beforeEach(() => {
    delete require.cache[require.resolve(BRIDGE_PATH)];
    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    global.document = dom.window.document;
    global.window = { PierreDiffs: undefined };
    PierreBridge = require(BRIDGE_PATH);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  function makeInstance(lineIndexAttr) {
    const pre = dom.window.document.createElement('pre');
    const code = dom.window.document.createElement('code');
    code.setAttribute('data-unified', '');
    const line = dom.window.document.createElement('div');
    line.setAttribute('data-line', '');
    line.setAttribute('data-line-index', lineIndexAttr);
    code.appendChild(line);
    pre.appendChild(code);
    return { pre, codeUnified: code, lineEl: line };
  }

  it('finds a line stamped with a composite "unified,split" index', () => {
    const { lineEl, ...instance } = makeInstance('4,3');
    expect(PierreBridge._queryLineElement(instance, [4, 3])).toBe(lineEl);
  });

  it('falls back to the bare unified index for older bundle formats', () => {
    const { lineEl, ...instance } = makeInstance('4');
    expect(PierreBridge._queryLineElement(instance, [4, 3])).toBe(lineEl);
  });

  it('returns null when the line is not rendered (collapsed gap)', () => {
    const { ...instance } = makeInstance('7,2');
    expect(PierreBridge._queryLineElement(instance, [4, 3])).toBe(null);
  });

  it('returns null for missing indices or instance internals', () => {
    const { ...instance } = makeInstance('4,3');
    expect(PierreBridge._queryLineElement(instance, undefined)).toBe(null);
    expect(PierreBridge._queryLineElement(instance, [null, null])).toBe(null);
    expect(PierreBridge._queryLineElement({ pre: null }, [4, 3])).toBe(null);
  });

  it('scopes the query to the instance codeUnified element', () => {
    const { lineEl, ...instance } = makeInstance('4,3');
    // A ghost line with the same index in another element must not match.
    const ghostPre = dom.window.document.createElement('pre');
    const ghost = dom.window.document.createElement('div');
    ghost.setAttribute('data-line', '');
    ghost.setAttribute('data-line-index', '4,3');
    ghostPre.appendChild(ghost);
    expect(PierreBridge._queryLineElement(instance, [4, 3])).toBe(lineEl);
  });
});

// Regression: a file rendered while collapsed has zero shadow-DOM lines. If
// setCollapsed only flips the instance option, expanding a start-collapsed
// (viewed) file shows an empty diff — rerender() must run on the
// collapsed → expanded transition to materialize the lines.
describe('PierreBridge.setCollapsed()', () => {
  let PierreBridge;

  beforeEach(() => {
    delete require.cache[require.resolve(BRIDGE_PATH)];
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    global.document = dom.window.document;
    global.window = {
      PierreDiffs: undefined,
      matchMedia: () => ({ matches: false }),
    };
    PierreBridge = require(BRIDGE_PATH);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  function makeBridgeWithFile(collapsed) {
    const bridge = new PierreBridge({});
    const instance = {
      setOptions: (opts) => { instance.lastOptions = opts; },
      rerenderCount: 0,
      rerender: () => { instance.rerenderCount++; },
    };
    bridge.files.set('a.js', { instance, collapsed });
    return { bridge, instance };
  }

  it('rerenders when transitioning collapsed → expanded', () => {
    const { bridge, instance } = makeBridgeWithFile(true);
    bridge.setCollapsed('a.js', false);
    expect(instance.lastOptions).toEqual({ collapsed: false });
    expect(instance.rerenderCount).toBe(1);
    expect(bridge.files.get('a.js').collapsed).toBe(false);
  });

  it('does not rerender when collapsing an expanded file', () => {
    const { bridge, instance } = makeBridgeWithFile(false);
    bridge.setCollapsed('a.js', true);
    expect(instance.lastOptions).toEqual({ collapsed: true });
    expect(instance.rerenderCount).toBe(0);
  });

  it('does not rerender when state is unchanged', () => {
    const { bridge, instance } = makeBridgeWithFile(false);
    bridge.setCollapsed('a.js', false);
    expect(instance.rerenderCount).toBe(0);
  });

  it('is a no-op for unknown files', () => {
    const { bridge } = makeBridgeWithFile(true);
    expect(() => bridge.setCollapsed('missing.js', false)).not.toThrow();
  });
});
