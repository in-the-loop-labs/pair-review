// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const { createPierreEnv } = require('../utils/fake-code-view');

// addAnnotationsAndAwait(fileName, annotations, {maxFrames}) is the perf-correct
// batch primitive: ONE addAnnotations (single publish/render) + ONE
// whenAnnotationsSlotted await, then it resolves each annotation's slotted
// element from that single pass into a Map<id, {element, mounted, slotted,
// reason?}>. It replaces the ~6x-slower per-annotation addAnnotation +
// whenAnnotationSlotted loop (N renders + N frame-waits).
//
// These tests drive it against the REAL bridge + FakeCodeView, whose
// updateItem now schedules ONE coalesced rAF-batched render (drained on a hand
// ticked frame) that slots the batch and fires onPostRender — mirroring the
// vendor. Frames are ticked by hand (no real rAF) per tests/CONVENTIONS.md.

let active;

beforeEach(() => {
  // Guard against a sibling file leaking vi.useFakeTimers() (which mocks rAF);
  // our manual frame source + real-microtask awaits must stay deterministic.
  vi.useRealTimers();
});

afterEach(() => {
  if (active) { active.env.cleanup(); active = null; }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup({ mount = false, slotFilter } = {}) {
  const env = createPierreEnv({ worker: false });
  const bridge = new env.PierreBridge({});
  const root = env.document.createElement('div');
  bridge.renderAll(root, [
    { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' },
  ]);
  const codeView = env.codeViews[0];
  bridge.registerAnnotationRenderer('mark', (_data, annId) => {
    const el = env.document.createElement('div');
    el.className = 'mark-annotation';
    el.textContent = annId;
    return el;
  });

  if (mount) {
    const host = env.document.createElement('div');
    env.document.body.appendChild(host);
    codeView.mountItem('a.js', { element: host, slotFilter });
  }

  // Swap to a deterministic hand-ticked rAF AFTER mount (mount's split-layout
  // rAF already ran under the sync rAF). Both the coalesced auto-flush and
  // whenAnnotationsSlotted's fallback tick through this.
  const rafQueue = [];
  global.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
  global.cancelAnimationFrame = () => {};
  const tick = () => { rafQueue.splice(0).forEach((cb) => cb()); };

  active = { env, bridge, codeView, tick };
  return active;
}

function marks(...ids) {
  return ids.map((id, i) => ({ lineNumber: i + 1, side: 'RIGHT', type: 'mark', id, data: {} }));
}

describe('PierreBridge.addAnnotationsAndAwait', () => {
  it('publishes the whole batch in ONE render and resolves every slotted element', async () => {
    const { bridge, codeView, tick } = setup({ mount: true });
    const anns = marks('b1', 'b2', 'b3', 'b4', 'b5');
    const updateBefore = codeView.calls.updateItem.length;

    const p = bridge.addAnnotationsAndAwait('a.js', anns, { maxFrames: 3 });
    tick(); // the single coalesced render slots the batch + fires onPostRender
    const map = await p;

    // ONE publish for all five (not five) — the perf contract.
    expect(codeView.calls.updateItem.length).toBe(updateBefore + 1);
    expect(map.size).toBe(5);
    for (const id of ['b1', 'b2', 'b3', 'b4', 'b5']) {
      const r = map.get(id);
      expect(r.mounted).toBe(true);
      expect(r.slotted).toBe(true);
      expect(r.element.dataset.prAnnotationId).toBe(id);
      expect(r.element.classList.contains('mark-annotation')).toBe(true);
    }
  });

  it('returns N not-mounted results for a virtualized-out item', async () => {
    const { bridge, tick } = setup({ mount: false });
    const anns = marks('n1', 'n2', 'n3');

    const p = bridge.addAnnotationsAndAwait('a.js', anns, { maxFrames: 3 });
    tick(); tick(); tick(); // never mounts → budget exhausts → not-mounted
    const map = await p;

    expect(map.size).toBe(3);
    for (const id of ['n1', 'n2', 'n3']) {
      expect(map.get(id)).toEqual({ element: null, mounted: false, slotted: false, reason: 'not-mounted' });
    }
  });

  it('reports line-not-rendered for batch members outside the render window', async () => {
    const { bridge, tick } = setup({ mount: true, slotFilter: (a) => a.metadata.id !== 'off' });
    const anns = marks('on', 'off');

    const p = bridge.addAnnotationsAndAwait('a.js', anns, { maxFrames: 3 });
    tick();
    const map = await p;

    expect(map.get('on').slotted).toBe(true);
    expect(map.get('on').element.dataset.prAnnotationId).toBe('on');
    expect(map.get('off')).toEqual({ element: null, mounted: true, slotted: false, reason: 'line-not-rendered' });
  });

  it('returns unknown-file for every id when the file has no item', async () => {
    const { bridge } = setup();
    const map = await bridge.addAnnotationsAndAwait('missing.js', marks('x', 'y'));
    expect(map.size).toBe(2);
    for (const id of ['x', 'y']) {
      expect(map.get(id)).toEqual({ element: null, mounted: false, slotted: false, reason: 'unknown-file' });
    }
  });

  it('resolves an empty Map for an empty batch (never hangs)', async () => {
    const { bridge } = setup({ mount: true });
    const map = await bridge.addAnnotationsAndAwait('a.js', []);
    expect(map.size).toBe(0);
  });

  it('resolves slotted elements when a virtualized-out item mounts part-way through the frame budget', async () => {
    // The "scrollTo then await with a larger maxFrames" path: the batch is
    // published while the item is virtualized OUT, the item mounts on a later
    // frame (as a scroll-driven mount would), and the waiter survives to
    // resolve real slotted elements instead of 'not-mounted'.
    const { env, bridge, codeView, tick } = setup({ mount: false });
    const p = bridge.addAnnotationsAndAwait('a.js', marks('z1', 'z2'), { maxFrames: 6 });

    tick(); // frame 1: still virtualized out, budget not exhausted
    const host = env.document.createElement('div');
    env.document.body.appendChild(host);
    codeView.mountItem('a.js', { element: host }); // mount pass slots the batch

    const map = await p;
    for (const id of ['z1', 'z2']) {
      expect(map.get(id).mounted).toBe(true);
      expect(map.get(id).slotted).toBe(true);
      expect(map.get(id).element.dataset.prAnnotationId).toBe(id);
    }
  });
});
