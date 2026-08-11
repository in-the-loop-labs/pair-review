// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const { createPierreEnv } = require('../utils/fake-code-view');

// bridge.whenAnnotationsSlotted(fileName, {maxFrames=6}) is the deterministic
// replacement for fixed-duration waits: annotation publishing is async
// (updateItem schedules a rAF-batched CodeView render; the vendor slots
// annotations during that render, then fires onPostRender in the SAME pass).
// The bridge resolves the returned Promise on that onPostRender signal, with a
// bounded per-frame fallback so it never hangs:
//   { mounted:true,  slotted:true }
//   { mounted:false, slotted:false, reason:'not-mounted'|'unknown-file'|'destroyed' }
//
// These tests drive the FakeCodeView's async-slot simulation:
//   - addAnnotation -> updateItem marks a PENDING render (no sync callbacks).
//   - codeView.flushRender() performs the deferred render (renderAnnotation then
//     onPostRender 'update', same-pass order) — the bridge's slot signal.
//   - getRenderedItems() reports only MOUNTED items, so _isItemRendered can tell
//     a slotting item from one virtualized out.
// Frames are ticked by hand (no real rAF) per tests/CONVENTIONS.md.

let active;

// Defense against cross-file timer contamination: vi.useFakeTimers() (which a
// leaky sibling file may have left active in this fork) also MOCKS
// requestAnimationFrame, which would hijack the manual frame source these tests
// install and hang the fallback. Force real timers before every test so our
// hand-ticked rAF and real-microtask awaits are deterministic.
beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  if (active) {
    active.env.cleanup();
    active = null;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * renderAll one diff item, optionally mount it, then swap in a manual,
 * deterministic requestAnimationFrame so ONLY whenAnnotationsSlotted's fallback
 * frames tick here (mount-time split-layout rAF already ran under the sync rAF).
 */
function setup({ mount = false } = {}) {
  const env = createPierreEnv({ worker: false });
  const bridge = new env.PierreBridge({});
  const root = env.document.createElement('div');
  bridge.renderAll(root, [
    { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' },
  ]);
  const codeView = env.codeViews[0];

  let host = null;
  if (mount) {
    host = env.document.createElement('div');
    env.document.body.appendChild(host);
    host.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100 });
    codeView.mountItem('a.js', { element: host });
  }

  const rafQueue = [];
  global.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
  global.cancelAnimationFrame = () => {};
  const tick = () => { rafQueue.splice(0).forEach((cb) => cb()); };

  active = { env, bridge, codeView, host, tick };
  return active;
}

describe('PierreBridge.whenAnnotationsSlotted', () => {
  it('stays pending until the render is flushed, then resolves slotted', async () => {
    const { env, bridge, codeView } = setup({ mount: true });
    const renderSpy = vi.fn(() => env.document.createElement('div'));
    bridge.registerAnnotationRenderer('mark', renderSpy);

    // addAnnotation -> updateItem: marks a pending render, fires NO callbacks.
    bridge.addAnnotation('a.js', { lineNumber: 1, side: 'RIGHT', type: 'mark', id: 'm1', data: {} });

    const p = bridge.whenAnnotationsSlotted('a.js', { maxFrames: 3 });
    let result = null;
    p.then((r) => { result = r; });

    // No frame ticked and no flush yet → still pending.
    await Promise.resolve();
    expect(result).toBeNull();
    expect(renderSpy).not.toHaveBeenCalled();

    // The deferred render lands: annotations slotted, then onPostRender fires.
    codeView.flushRender('a.js');
    await p;

    expect(result).toEqual({ mounted: true, slotted: true });
    // Same-pass order: the annotation was rendered as part of the slotting pass.
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves not-mounted only after the full frame budget for a virtualized-out item', async () => {
    // An unrendered item is given the whole budget to mount (supports
    // "scrollTo then await" with a larger maxFrames); only if it never mounts
    // within the budget does it resolve not-mounted.
    const { bridge, tick } = setup({ mount: false });
    const p = bridge.whenAnnotationsSlotted('a.js', { maxFrames: 3 });
    let result = null;
    p.then((r) => { result = r; });

    tick(); tick();                 // frames 1, 2 — still within budget
    await Promise.resolve();
    expect(result).toBeNull();

    tick();                         // frame 3 — budget exhausted, never mounted
    await p;
    expect(result).toEqual({ mounted: false, slotted: false, reason: 'not-mounted' });
  });

  it('resolves unknown-file immediately when the file has no item', async () => {
    const { bridge } = setup();
    const r = await bridge.whenAnnotationsSlotted('missing.js');
    expect(r).toEqual({ mounted: false, slotted: false, reason: 'unknown-file' });
  });

  it('resolves unknown-file when the bridge has no CodeView yet', async () => {
    const env = createPierreEnv({ worker: false });
    active = { env };
    const fresh = new env.PierreBridge({});
    const r = await fresh.whenAnnotationsSlotted('a.js');
    expect(r).toEqual({ mounted: false, slotted: false, reason: 'unknown-file' });
  });

  it('resolves destroyed when destroyAll runs while a waiter is pending', async () => {
    const { bridge } = setup({ mount: true });
    const p = bridge.whenAnnotationsSlotted('a.js', { maxFrames: 3 });
    // Neither flush nor frame tick: tear down while awaiting.
    bridge.destroyAll();
    const r = await p;
    // Same shape destroyFile forces (pierre-bridge-annotation-data.test.js):
    // the two teardown paths resolve waiters identically, element key included.
    expect(r).toEqual({ element: null, mounted: false, slotted: false, reason: 'destroyed' });
  });

  it('resolves EVERY pending waiter on one file as destroyed, not every other one', async () => {
    // Regression: teardown used to resolve waiters while iterating the LIVE
    // waiter array — each finish() splices itself out, so iteration skipped
    // every second waiter. The skipped ones then settled frames later with the
    // wrong reason (or, with no frames ticked, never at all). Three waiters on
    // one file, no flush and NO frame ticks: only the snapshot-then-clear
    // teardown can settle all three.
    const { bridge } = setup({ mount: true });
    const pending = [
      bridge.whenAnnotationsSlotted('a.js', { maxFrames: 3 }),
      bridge.whenAnnotationsSlotted('a.js', { maxFrames: 3 }),
      bridge.whenAnnotationsSlotted('a.js', { maxFrames: 3 }),
    ];
    expect(bridge._slotWaiters.get('a.js')).toHaveLength(3);

    bridge.destroyAll();

    const results = await Promise.all(pending);
    for (const r of results) {
      expect(r).toEqual({ element: null, mounted: false, slotted: false, reason: 'destroyed' });
    }
    expect(bridge._slotWaiters.has('a.js')).toBe(false);
  });

  it('resolves a mixed set of per-file and per-annotation waiters as destroyed', async () => {
    // The two waiter kinds share `_slotWaiters`, so the same array-mutation
    // hazard applies to a mixed list.
    const { bridge } = setup({ mount: true });
    bridge.registerAnnotationRenderer('mark', () => null);
    bridge.addAnnotation('a.js', { lineNumber: 5, side: 'RIGHT', type: 'mark', id: 'ann-1', data: {} });

    const perFile = bridge.whenAnnotationsSlotted('a.js', { maxFrames: 3 });
    const perAnn = bridge.whenAnnotationSlotted('a.js', 'ann-1', { maxFrames: 3 });
    const perFile2 = bridge.whenAnnotationsSlotted('a.js', { maxFrames: 3 });
    expect(bridge._slotWaiters.get('a.js')).toHaveLength(3);

    bridge.destroyAll();

    // One shape for both kinds, and the same one destroyFile forces.
    const expected = { element: null, mounted: false, slotted: false, reason: 'destroyed' };
    expect(await perFile).toEqual(expected);
    expect(await perFile2).toEqual(expected);
    expect(await perAnn).toEqual(expected);
  });

  it('resolves slotted on the first frame for a mounted, steady-state item', async () => {
    // A rendered item already has its annotations slotted (renderAnnotations ran
    // when it mounted), so the fallback resolves it slotted on the very first
    // frame check — no need to wait out the budget.
    const { bridge, tick } = setup({ mount: true });
    const p = bridge.whenAnnotationsSlotted('a.js', { maxFrames: 3 });

    tick();                         // first frame: item is in the render window
    const r = await p;
    expect(r).toEqual({ mounted: true, slotted: true });
  });

  it('defaults the frame budget to 6 for the not-mounted fallback', async () => {
    // The budget gates the UNMOUNTED path (how long to wait for a mount). A
    // never-mounting item resolves not-mounted only after the default 6 frames.
    const { bridge, tick } = setup({ mount: false });
    const p = bridge.whenAnnotationsSlotted('a.js'); // no maxFrames → 6
    let result = null;
    p.then((r) => { result = r; });

    for (let i = 0; i < 5; i++) tick();
    await Promise.resolve();
    expect(result).toBeNull();      // not yet — 5 < 6

    tick();                         // 6th frame hits the default budget
    await p;
    expect(result).toEqual({ mounted: false, slotted: false, reason: 'not-mounted' });
  });

  it('mount wins for a waiter registered pre-mount (onPostRender is the primary signal)', async () => {
    // A waiter registered before the item mounts: when the item mounts (its
    // render was pending), onPostRender resolves it slotted BEFORE the fallback
    // ever gets to report not-mounted. Lock that contract outcome.
    const { env, bridge, codeView } = setup({ mount: false });
    const p = bridge.whenAnnotationsSlotted('a.js', { maxFrames: 3 });

    const host = env.document.createElement('div');
    env.document.body.appendChild(host);
    codeView.mountItem('a.js', { element: host }); // primary signal fires here

    const r = await p;
    expect(r).toEqual({ mounted: true, slotted: true });
  });
});

// Both waiter kinds run on ONE piece of machinery (_awaitSlot): registration,
// the settle-once guard, de-registration from `_slotWaiters`, and the bounded
// rAF poll. These pin the bookkeeping that used to be duplicated — a leaked
// waiter would be resolved with the WRONG result by the next render pass or
// teardown, so "settled ⇒ de-registered" is the invariant that matters.
describe('PierreBridge slot-waiter bookkeeping (shared machinery)', () => {
  it('de-registers a per-file waiter that settles via the frame probe', async () => {
    const { bridge, tick } = setup({ mount: true });
    const p = bridge.whenAnnotationsSlotted('a.js', { maxFrames: 3 });
    expect(bridge._slotWaiters.get('a.js')).toHaveLength(1);

    tick();
    await p;
    expect(bridge._slotWaiters.has('a.js')).toBe(false);
  });

  it('de-registers a per-file waiter that settles at budget exhaustion', async () => {
    const { bridge, tick } = setup({ mount: false });
    const p = bridge.whenAnnotationsSlotted('a.js', { maxFrames: 2 });
    expect(bridge._slotWaiters.get('a.js')).toHaveLength(1);

    tick(); tick();
    expect(await p).toEqual({ mounted: false, slotted: false, reason: 'not-mounted' });
    expect(bridge._slotWaiters.has('a.js')).toBe(false);
  });

  it('drops only the settled waiter, leaving a concurrent one registered', async () => {
    const { bridge, codeView, tick } = setup({ mount: false });
    const first = bridge.whenAnnotationsSlotted('a.js', { maxFrames: 2 });
    const second = bridge.whenAnnotationsSlotted('a.js', { maxFrames: 50 });
    expect(bridge._slotWaiters.get('a.js')).toHaveLength(2);

    tick(); tick();                 // first exhausts its budget; second lives on
    expect(await first).toEqual({ mounted: false, slotted: false, reason: 'not-mounted' });
    expect(bridge._slotWaiters.get('a.js')).toHaveLength(1);

    // The survivor still resolves off the primary signal, not a stale entry.
    const host = active.env.document.createElement('div');
    active.env.document.body.appendChild(host);
    codeView.mountItem('a.js', { element: host });
    expect(await second).toEqual({ mounted: true, slotted: true });
    expect(bridge._slotWaiters.has('a.js')).toBe(false);
  });
});

// Per-annotation variant: whenAnnotationSlotted(fileName, annotationId, {maxFrames})
// resolves { element, mounted, slotted, reason? } for consumers that read a
// SPECIFIC row back (tour stops, external threads). The bridge locates the row
// via host.querySelector('[data-pr-annotation-id="<id>"]'); the fake projects
// each rendered annotation node (which the bridge stamps with that attribute)
// into the mounted host, and a per-mount slotFilter models the item's internal
// render window (annotations whose line is scrolled out are not slotted).
describe('PierreBridge.whenAnnotationSlotted (per-annotation)', () => {
  function singularSetup() {
    const env = createPierreEnv({ worker: false });
    const bridge = new env.PierreBridge({});
    const root = env.document.createElement('div');
    bridge.renderAll(root, [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ]);
    const codeView = env.codeViews[0];
    // A renderer that returns a real element, so the bridge stamps
    // data-pr-annotation-id on it and the fake slots it into the host.
    bridge.registerAnnotationRenderer('mark', (_data, annId) => {
      const el = env.document.createElement('div');
      el.className = 'mark-annotation';
      el.textContent = annId;
      return el;
    });
    const rafQueue = [];
    global.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
    global.cancelAnimationFrame = () => {};
    const tick = () => { rafQueue.splice(0).forEach((cb) => cb()); };
    active = { env, bridge, codeView, tick };
    return active;
  }

  function connectedHost(env) {
    const h = env.document.createElement('div');
    env.document.body.appendChild(h);
    return h;
  }

  function addMark(bridge, id, line) {
    bridge.addAnnotation('a.js', { lineNumber: line, side: 'RIGHT', type: 'mark', id, data: {} });
  }

  it('resolves the slotted element (stamped with data-pr-annotation-id) after flush', async () => {
    const { env, bridge, codeView } = singularSetup();
    const host = connectedHost(env);
    codeView.mountItem('a.js', { element: host });
    addMark(bridge, 'ann-1', 5); // pending render, not slotted yet

    const p = bridge.whenAnnotationSlotted('a.js', 'ann-1', { maxFrames: 3 });
    let result = null;
    p.then((r) => { result = r; });
    await Promise.resolve();
    expect(result).toBeNull(); // pending until the deferred render lands

    codeView.flushRender('a.js');
    const r = await p;
    expect(r.mounted).toBe(true);
    expect(r.slotted).toBe(true);
    expect(r.element).toBeTruthy();
    expect(r.element.dataset.prAnnotationId).toBe('ann-1');
    expect(r.element.classList.contains('mark-annotation')).toBe(true);
  });

  it('resolves line-not-rendered when the item is mounted but the line is outside its window', async () => {
    const { env, bridge, codeView, tick } = singularSetup();
    const host = connectedHost(env);
    addMark(bridge, 'off-1', 999);
    // Mount with a slot window that excludes off-1 (its line is scrolled out).
    codeView.mountItem('a.js', { element: host, slotFilter: (a) => a.metadata.id !== 'off-1' });

    const p = bridge.whenAnnotationSlotted('a.js', 'off-1', { maxFrames: 3 });
    let result = null;
    p.then((r) => { result = r; });

    tick(); tick();               // frames 1, 2 — still searching within budget
    await Promise.resolve();
    expect(result).toBeNull();

    tick();                       // frame 3 — budget: mounted, element absent
    await p;
    expect(result).toEqual({ element: null, mounted: true, slotted: false, reason: 'line-not-rendered' });
  });

  it('resolves unknown-annotation for an id not present on the file', async () => {
    const { bridge } = singularSetup();
    const r = await bridge.whenAnnotationSlotted('a.js', 'nope');
    expect(r).toEqual({ element: null, mounted: false, slotted: false, reason: 'unknown-annotation' });
  });

  it('resolves unknown-file for a file with no item', async () => {
    const { bridge } = singularSetup();
    const r = await bridge.whenAnnotationSlotted('missing.js', 'ann-1');
    expect(r).toEqual({ element: null, mounted: false, slotted: false, reason: 'unknown-file' });
  });

  it('a large-budget waiter survives to a later mount and resolves the element', async () => {
    // The item is virtualized out when the caller asks; with a generous budget
    // the waiter survives frames until a scroll-driven mount slots the row.
    const { env, bridge, codeView, tick } = singularSetup();
    addMark(bridge, 'late-1', 5); // annotation exists; item NOT mounted

    const p = bridge.whenAnnotationSlotted('a.js', 'late-1', { maxFrames: 20 });
    let result = null;
    p.then((r) => { result = r; });

    tick(); tick(); tick();       // frames pass, item still unmounted → keep waiting
    await Promise.resolve();
    expect(result).toBeNull();

    const host = connectedHost(env);
    codeView.mountItem('a.js', { element: host }); // mounts + slots late-1, fires onPostRender

    const r = await p;
    expect(r.mounted).toBe(true);
    expect(r.slotted).toBe(true);
    expect(r.element.dataset.prAnnotationId).toBe('late-1');
  });

  // TDZ regression: finish() references `waiter` (arr.indexOf(waiter)), and the
  // steady-state fast path (tryElement() succeeding synchronously) calls finish
  // BEFORE anything else. `waiter` must be declared before that probe. It only
  // throws when _slotWaiters already holds a pending entry for the file (the
  // `if (arr)` guard is what reaches indexOf) — i.e. a CONCURRENT waiter for the
  // same file. Against the buggy ordering this rejects with
  // "Cannot access 'waiter' before initialization".
  it('does not TDZ on the steady-state fast path when a concurrent waiter exists', async () => {
    const env = createPierreEnv({ worker: false });
    active = { env };
    const bridge = new env.PierreBridge({});
    const root = env.document.createElement('div');
    bridge.renderAll(root, [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ]);
    const codeView = env.codeViews[0];
    bridge.registerAnnotationRenderer('mark', () => env.document.createElement('div'));
    const host = env.document.createElement('div');
    env.document.body.appendChild(host);
    codeView.mountItem('a.js', { element: host });

    // Manual rAF up front so the concurrent m2 waiter (below) stays pending
    // instead of resolving through a synchronous fallback frame.
    const rq = [];
    global.requestAnimationFrame = (cb) => { rq.push(cb); return rq.length; };
    global.cancelAnimationFrame = () => {};

    // m1: added and explicitly flushed → slotted (so the singular call hits the
    // synchronous steady-state fast path).
    bridge.addAnnotation('a.js', { lineNumber: 1, side: 'RIGHT', type: 'mark', id: 'm1', data: {} });
    codeView.flushRender('a.js');
    const m1El = bridge._findSlottedAnnotationElement(bridge.files.get('a.js'), 'm1');
    expect(m1El).toBeTruthy();

    // m2: added but NOT flushed, then a per-annotation waiter left pending on the
    // SAME file — this is the concurrent _slotWaiters entry finish() must survive.
    bridge.addAnnotation('a.js', { lineNumber: 2, side: 'RIGHT', type: 'mark', id: 'm2', data: {} });
    const pending = bridge.whenAnnotationSlotted('a.js', 'm2', { maxFrames: 20 });
    pending.catch(() => {});
    expect(bridge._slotWaiters.get('a.js')).toHaveLength(1);

    // Steady-state fast-path resolve WITH the concurrent waiter present — the
    // regression: must NOT throw, and returns the slotted element.
    const r = await bridge.whenAnnotationSlotted('a.js', 'm1', { maxFrames: 3 });
    expect(r).toEqual({ element: m1El, mounted: true, slotted: true });

    host.remove();
  });

  it('does not TDZ when the concurrent waiter on the file is a PER-FILE one', async () => {
    // Same hazard, other waiter kind: both kinds share `_slotWaiters`, so a
    // pending per-file waiter is equally enough to make finish() reach
    // arr.indexOf(waiter) on the synchronous fast path.
    const { env, bridge, codeView } = singularSetup();
    const host = connectedHost(env);
    codeView.mountItem('a.js', { element: host });
    addMark(bridge, 'm1', 1);
    codeView.flushRender('a.js');

    const perFile = bridge.whenAnnotationsSlotted('a.js', { maxFrames: 50 });
    perFile.catch(() => {});
    expect(bridge._slotWaiters.get('a.js')).toHaveLength(1);

    const r = await bridge.whenAnnotationSlotted('a.js', 'm1', { maxFrames: 3 });
    expect(r.slotted).toBe(true);
    expect(r.element.dataset.prAnnotationId).toBe('m1');
    // The fast path must not have disturbed the concurrent registration.
    expect(bridge._slotWaiters.get('a.js')).toHaveLength(1);
  });
});
