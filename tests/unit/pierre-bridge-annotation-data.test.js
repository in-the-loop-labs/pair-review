// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const { createPierreEnv } = require('../utils/fake-code-view');

// Task #14 edit/delete sync at the bridge layer:
//   - updateAnnotationData mutates the stored annotation's data IN PLACE (so an
//     edit survives a remount) WITHOUT publishing a new render — the mounted
//     card was already updated in the DOM by the caller.
//   - destroyFile / removeContextFileItem hygiene: resolve pending slot waiters
//     as 'destroyed' (never hang) and drop the instance->id mapping so a
//     removed file/context item leaks nothing.

let active;

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => {
  if (active) { active.env.cleanup(); active = null; }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  const env = createPierreEnv({ worker: false });
  const bridge = new env.PierreBridge({});
  const root = env.document.createElement('div');
  bridge.renderAll(root, [
    { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' },
  ]);
  const codeView = env.codeViews[0];
  active = { env, bridge, codeView };
  return active;
}

describe('PierreBridge.updateAnnotationData', () => {
  it('merges the patch into the annotation data in place and returns true', () => {
    const { bridge } = setup();
    bridge.addAnnotation('a.js', {
      lineNumber: 1, side: 'RIGHT', type: 'comment', id: 'comment-1',
      data: { id: 1, body: 'old' },
    });

    const ok = bridge.updateAnnotationData('a.js', 'comment-1', { body: 'new' });

    expect(ok).toBe(true);
    const ann = bridge.getAnnotations('a.js', 'comment').find(a => a.metadata.id === 'comment-1');
    expect(ann.metadata.data.body).toBe('new');
    expect(ann.metadata.data.id).toBe(1); // other fields preserved (shallow merge)
  });

  it('does NOT publish a render (mutates in place)', () => {
    const { bridge, codeView } = setup();
    bridge.addAnnotation('a.js', {
      lineNumber: 1, side: 'RIGHT', type: 'comment', id: 'comment-1', data: { body: 'old' },
    });
    const publishesBefore = codeView.calls.updateItem.length;

    bridge.updateAnnotationData('a.js', 'comment-1', { body: 'new' });

    expect(codeView.calls.updateItem.length).toBe(publishesBefore);
  });

  it('returns false for an unknown file or annotation without throwing', () => {
    const { bridge } = setup();
    bridge.addAnnotation('a.js', {
      lineNumber: 1, side: 'RIGHT', type: 'comment', id: 'comment-1', data: { body: 'old' },
    });

    expect(bridge.updateAnnotationData('missing.js', 'comment-1', { body: 'x' })).toBe(false);
    expect(bridge.updateAnnotationData('a.js', 'nope', { body: 'x' })).toBe(false);
    // Original untouched.
    const ann = bridge.getAnnotations('a.js', 'comment').find(a => a.metadata.id === 'comment-1');
    expect(ann.metadata.data.body).toBe('old');
  });

  // THE durability tripwire (Task #14): updateAnnotationData is no-publish, so it
  // works ONLY because the annotation entries in fileState.annotations are the
  // SAME references CodeView holds in its item record — an in-place edit shows up
  // on the next REMOUNT (which re-renders from the shared annotation data). This
  // drives the edit through the fake's real unmount→remount→renderAnnotation path
  // (reading the live data, not a value stashed in the test), so it fails if the
  // fake ever deep-clones item.annotations on updateItem/setItems and diverges
  // from the vendor's version-gated, reference-sharing reconcile.
  it('an in-place edit survives an unmount/remount (shared annotation refs)', () => {
    const { env, bridge, codeView } = setup();
    // Renderer emits the CURRENT data.body as text so the remount read is observable.
    bridge.registerAnnotationRenderer('mark', (data) => {
      const el = env.document.createElement('div');
      el.className = 'mark';
      el.textContent = data.body;
      return el;
    });

    const host = env.document.createElement('div');
    env.document.body.appendChild(host);
    codeView.mountItem('a.js', { element: host });
    // addAnnotation publishes + (under the sync rAF) the mounted render slots it.
    bridge.addAnnotation('a.js', {
      lineNumber: 1, side: 'RIGHT', type: 'mark', id: 'comment-1', data: { id: 1, body: 'old' },
    });
    expect(host.querySelector('[data-pr-annotation-id="comment-1"]').textContent).toBe('old');

    // Edit in place — no republish.
    const publishesBefore = codeView.calls.updateItem.length;
    expect(bridge.updateAnnotationData('a.js', 'comment-1', { body: 'new' })).toBe(true);
    expect(codeView.calls.updateItem.length).toBe(publishesBefore);

    // Item scrolls out then back: the remount re-renders from the shared
    // annotation data, so the edited body is what appears — not the old one.
    codeView.unmountItem('a.js', { element: host });
    const host2 = env.document.createElement('div');
    env.document.body.appendChild(host2);
    codeView.mountItem('a.js', { element: host2 });

    expect(host2.querySelector('[data-pr-annotation-id="comment-1"]').textContent).toBe('new');
  });
});

describe('PierreBridge.destroyFile / removeContextFileItem hygiene', () => {
  function connectedHost(env) {
    const h = env.document.createElement('div');
    env.document.body.appendChild(h);
    return h;
  }

  it('resolves a pending slot waiter as destroyed and clears the waiter entry', async () => {
    const { env, bridge, codeView } = setup();
    codeView.mountItem('a.js', { element: connectedHost(env) });

    // Manual rAF so the fallback never fires before destroyFile does.
    const rq = [];
    global.requestAnimationFrame = (cb) => { rq.push(cb); return rq.length; };
    global.cancelAnimationFrame = () => {};

    const p = bridge.whenAnnotationsSlotted('a.js', { maxFrames: 6 });
    bridge.destroyFile('a.js');

    const r = await p;
    expect(r).toMatchObject({ mounted: false, slotted: false, reason: 'destroyed' });
    expect(bridge._slotWaiters.has('a.js')).toBe(false);
    expect(bridge.files.has('a.js')).toBe(false);
  });

  it('resolves a pending per-annotation waiter as destroyed too', async () => {
    const { bridge } = setup();
    // Annotation exists (not unknown) but the item is virtualized out, so the
    // per-annotation waiter is genuinely pending when destroyFile fires.
    bridge.addAnnotation('a.js', {
      lineNumber: 1, side: 'RIGHT', type: 'comment', id: 'comment-1', data: { body: 'x' },
    });

    const rq = [];
    global.requestAnimationFrame = (cb) => { rq.push(cb); return rq.length; };
    global.cancelAnimationFrame = () => {};

    const p = bridge.whenAnnotationSlotted('a.js', 'comment-1', { maxFrames: 6 });
    bridge.destroyFile('a.js');

    const r = await p;
    // The forced result flows through the waiter — not the bounded fallback.
    expect(r).toEqual({ element: null, mounted: false, slotted: false, reason: 'destroyed' });
    expect(bridge._slotWaiters.has('a.js')).toBe(false);
  });

  it('drops the instance->id mapping for a destroyed file', () => {
    const { env, bridge, codeView } = setup();
    const inst = { tag: 'inst-a' };
    codeView.mountItem('a.js', { element: connectedHost(env), instance: inst });
    expect(bridge._instanceToId.get(inst)).toBe('a.js');

    bridge.destroyFile('a.js');

    expect(bridge._instanceToId.has(inst)).toBe(false);
    expect(bridge.files.has('a.js')).toBe(false);
  });

  it('removeContextFileItem routes through destroyFile(context:path) with the same cleanup', () => {
    const { env, bridge, codeView } = setup();
    bridge.addContextFile('ctx.js', 'FULL CONTENTS'); // id 'context:ctx.js'
    const inst = { tag: 'inst-ctx' };
    codeView.mountItem('context:ctx.js', { element: connectedHost(env), instance: inst });
    expect(bridge._instanceToId.get(inst)).toBe('context:ctx.js');
    expect(bridge.hasContextFile('ctx.js')).toBe(true);

    bridge.removeContextFileItem('ctx.js');

    expect(bridge.hasContextFile('ctx.js')).toBe(false);
    expect(bridge.files.has('context:ctx.js')).toBe(false);
    expect(bridge._instanceToId.has(inst)).toBe(false);
  });

  it('is a no-op for an unknown file', () => {
    const { bridge } = setup();
    expect(() => bridge.destroyFile('missing.js')).not.toThrow();
  });
});
