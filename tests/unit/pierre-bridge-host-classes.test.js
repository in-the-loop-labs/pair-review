// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'vitest';
const { createPierreEnv } = require('../utils/fake-code-view');

// The single CodeView POOLS/recycles <diffs-container> hosts across items as
// they scroll in and out. So the bridge cannot stash identity/domain classes on
// a host once — it must reconcile them on every mount and strip them on
// unmount, or a recycled host carries a previous item's classes to its next
// occupant. MANAGED_HOST_CLASSES is the exact set the bridge owns; everything
// else on the host is left untouched.
//
// onPostRender('mount'|'update') -> _applyHostClasses:
//   strip ALL managed classes, then add base 'd2h-file-wrapper' + context-file
//   (context items) + collapsed + caller hostClasses(fileName,itemType) domain
//   classes, and stamp data-file-name.
// onPostRender('unmount') -> _cleanHostClasses: strip managed classes + name.

const MANAGED = ['d2h-file-wrapper', 'context-file', 'collapsed', 'generated-file', 'summaries-hidden-file'];

let active;

afterEach(() => {
  if (active) { active.env.cleanup(); active = null; }
});

/**
 * renderAll with an optional hostClasses(fileName,itemType) callback (the
 * renderAll option the bridge captures as _hostClassesFor).
 */
function setup(entries, options = {}) {
  const env = createPierreEnv({ worker: false });
  const bridge = new env.PierreBridge({});
  const root = env.document.createElement('div');
  bridge.renderAll(root, entries, options);
  const codeView = env.codeViews[0];
  active = { env, bridge, codeView };
  return active;
}

function hostEl(env) {
  const el = env.document.createElement('div');
  env.document.body.appendChild(el);
  return el;
}

describe('PierreBridge managed host classes', () => {
  it('exposes the exact managed-class set', () => {
    const env = createPierreEnv({ worker: false });
    active = { env };
    expect(env.PierreBridge.MANAGED_HOST_CLASSES).toEqual(MANAGED);
  });

  it('applies base + collapsed + caller domain classes and stamps the name on mount', () => {
    const { env, codeView } = setup(
      [{ id: 'gen.js', type: 'diff', fileName: 'gen.js', patch: '@@ -1 +1 @@\n-a\n+b\n', collapsed: true }],
      { hostClasses: (name) => (name === 'gen.js' ? ['generated-file', 'summaries-hidden-file'] : []) }
    );
    const host = hostEl(env);

    codeView.mountItem('gen.js', { element: host });

    expect(host.classList.contains('d2h-file-wrapper')).toBe(true);   // base
    expect(host.classList.contains('collapsed')).toBe(true);          // fileState.collapsed
    expect(host.classList.contains('generated-file')).toBe(true);     // caller domain
    expect(host.classList.contains('summaries-hidden-file')).toBe(true);
    expect(host.classList.contains('context-file')).toBe(false);      // not a context item
    expect(host.dataset.fileName).toBe('gen.js');
  });

  it('gives context items context-file and never a diff item', () => {
    const { env, bridge, codeView } = setup(
      [{ id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' }]
    );
    bridge.addContextFile('a.js', 'FULL CONTENTS'); // id 'context:a.js', itemType 'context'

    const ctxHost = hostEl(env);
    codeView.mountItem('context:a.js', { element: ctxHost });
    expect(ctxHost.classList.contains('context-file')).toBe(true);
    expect(ctxHost.classList.contains('d2h-file-wrapper')).toBe(true);

    const diffHost = hostEl(env);
    codeView.mountItem('a.js', { element: diffHost });
    expect(diffHost.classList.contains('context-file')).toBe(false);
  });

  it('carries ZERO of a prior item classes when a host is pooled to another item', () => {
    // A context item mounts on a host (gets context-file), then the SAME host is
    // recycled for a diff item. _applyHostClasses strips all managed classes
    // first, so the diff never inherits context-file, and the name is restamped.
    const { env, bridge, codeView } = setup(
      [{ id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' }],
      { hostClasses: (name) => (name === 'a.js' ? ['generated-file'] : []) }
    );
    bridge.addContextFile('ctx.js', 'FULL CONTENTS');

    const host = hostEl(env);
    codeView.mountItem('context:ctx.js', { element: host });
    expect(host.classList.contains('context-file')).toBe(true);
    expect(host.dataset.fileName).toBe('ctx.js');

    // Pool: reuse the exact same host element for a different item.
    codeView.mountItem('a.js', { element: host });

    expect(host.classList.contains('context-file')).toBe(false);       // A's class gone
    expect(host.classList.contains('d2h-file-wrapper')).toBe(true);
    expect(host.classList.contains('generated-file')).toBe(true);      // B's domain class
    expect(host.dataset.fileName).toBe('a.js');                        // restamped
  });

  it('preserves non-managed classes already on a pooled host', () => {
    const { env, codeView } = setup(
      [{ id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' }]
    );
    const host = hostEl(env);
    host.classList.add('app-owned-class');

    codeView.mountItem('a.js', { element: host });

    expect(host.classList.contains('app-owned-class')).toBe(true); // untouched
    expect(host.classList.contains('d2h-file-wrapper')).toBe(true);
  });

  it('strips every managed class and the name on unmount (host recycle)', () => {
    const { env, codeView } = setup(
      [{ id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n', collapsed: true }],
      { hostClasses: () => ['generated-file', 'summaries-hidden-file'] }
    );
    const host = hostEl(env);
    host.classList.add('app-owned-class');
    codeView.mountItem('a.js', { element: host });
    expect(host.dataset.fileName).toBe('a.js');

    codeView.unmountItem('a.js', { element: host });

    for (const cls of MANAGED) expect(host.classList.contains(cls)).toBe(false);
    expect('fileName' in host.dataset).toBe(false);
    // Non-managed app classes survive the recycle.
    expect(host.classList.contains('app-owned-class')).toBe(true);
  });
});

describe('PierreBridge stable per-item instance identity', () => {
  it('reuses the same instance across mount -> unmount -> remount', () => {
    const { env, bridge, codeView } = setup(
      [{ id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' }]
    );
    const h1 = hostEl(env);
    codeView.mountItem('a.js', { element: h1 });
    const inst1 = bridge.getInstance('a.js');
    expect(inst1).toBeTruthy();

    codeView.unmountItem('a.js', { element: h1 });
    expect(bridge.getInstance('a.js')).toBeNull();

    const h2 = hostEl(env);
    codeView.mountItem('a.js', { element: h2 });
    expect(bridge.getInstance('a.js')).toBe(inst1); // stable identity
  });

  it('clears refs via the instance->id fallback when unmount context lacks the item', () => {
    // The vendor unmount can fire with only the recycled host + instance and no
    // item context; the bridge must still resolve the id from the instance map
    // and clear refs. This only works because the fake reuses the SAME instance.
    const { env, bridge, codeView } = setup(
      [{ id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' }]
    );
    const host = hostEl(env);
    const stable = { tag: 'stable-a' };
    codeView.mountItem('a.js', { element: host, instance: stable });
    expect(bridge.getInstance('a.js')).toBe(stable);

    // Directly mirror a context-less vendor unmount: (host, instance, 'unmount', {}).
    codeView.options.onPostRender(host, stable, 'unmount', {});

    expect(bridge.getInstance('a.js')).toBeNull();
    expect(host.classList.contains('d2h-file-wrapper')).toBe(false); // cleaned via fallback
    expect('fileName' in host.dataset).toBe(false);
  });
});
