// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { createPierreEnv } = require('../utils/fake-code-view');

// renderAll is the single render entry that replaced the per-file
// renderFile / renderBinaryFile + deferred/lazy placeholder machinery. Under
// CodeView every changed file becomes an item IMMEDIATELY (the virtualizer
// mounts/unmounts them by scroll position); there is no "Load diff"
// placeholder and no IntersectionObserver deferral. This pins that behavior
// plus binary/collapsed/forcePlainText item shape, teardown, and scrolling.

describe('PierreBridge.renderAll', () => {
  let env;
  let bridge;
  let root;

  beforeEach(() => {
    env = createPierreEnv({ worker: false, parsePatch: (p) => ({ name: 'f', hunks: [{ additionStart: 1, additionCount: 1, deletionStart: 1, deletionCount: 1 }], _p: p }) });
    bridge = new env.PierreBridge({});
    root = env.document.createElement('div');
  });

  afterEach(() => {
    env.cleanup();
  });

  it('creates one CodeView item per entry immediately (no deferral)', () => {
    bridge.renderAll(root, [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      { id: 'b.js', type: 'diff', fileName: 'b.js', patch: '@@ -1 +1 @@\n-c\n+d\n' },
      { id: 'c.js', type: 'diff', fileName: 'c.js', patch: '@@ -1 +1 @@\n-e\n+f\n' },
    ]);
    const codeView = env.codeViews[0];
    // All three items exist up front, in order.
    expect(codeView.itemIds()).toEqual(['a.js', 'b.js', 'c.js']);
    expect(bridge.files.size).toBe(3);
    // setItems seeded them in a single call.
    expect(codeView.calls.setItems).toHaveLength(1);
    expect(codeView.calls.setItems[0]).toHaveLength(3);
  });

  it('marks the CodeView root and binds it as the scroll container', () => {
    bridge.renderAll(root, [{ id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' }]);
    expect(root.classList.contains('pierre-codeview-root')).toBe(true);
    expect(env.codeViews[0].root).toBe(root);
  });

  it('honors an initial collapsed flag on the item', () => {
    bridge.renderAll(root, [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n', collapsed: true },
    ]);
    expect(env.codeViews[0].getItem('a.js').collapsed).toBe(true);
  });

  it('renders a binary entry as a header-only (zero-hunk) diff item', () => {
    bridge.renderAll(root, [
      { id: 'img.png', type: 'binary', fileName: 'img.png', binaryMessage: 'Binary file not shown' },
    ]);
    const fileState = bridge.files.get('img.png');
    expect(fileState.itemType).toBe('binary');
    expect(fileState.metadata.hunks).toEqual([]);
    // Published as a diff item (header-only) so the shared header path renders it.
    const item = env.codeViews[0].getItem('img.png');
    expect(item.type).toBe('diff');
    expect(item.fileDiff.hunks).toEqual([]);
  });

  it('stamps metadata.lang = text when forcePlainText is set (highlight budget)', () => {
    bridge.renderAll(root, [
      { id: 'big.min.js', type: 'diff', fileName: 'big.min.js', patch: '@@ -1 +1 @@\n-a\n+b\n', forcePlainText: true },
    ]);
    expect(bridge.files.get('big.min.js').metadata.lang).toBe('text');
  });

  it('threads the renderHeader factory through to CodeView.renderCustomHeader', () => {
    const headerEl = env.document.createElement('div');
    headerEl.className = 'my-header';
    const renderHeader = (fileName) => {
      const el = headerEl.cloneNode(true);
      el.dataset.for = fileName;
      return el;
    };
    bridge.renderAll(root, [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ], { renderHeader });

    const result = env.codeViews[0].renderHeaderFor('a.js');
    expect(result.classList.contains('my-header')).toBe(true);
    expect(result.dataset.for).toBe('a.js');
  });

  it('resets annotation state on re-render (destroyAll semantics before rebuild)', () => {
    bridge.renderAll(root, [{ id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' }]);
    bridge.addAnnotation('a.js', { lineNumber: 1, side: 'RIGHT', type: 'comment', id: 'c1', data: {} });
    expect(bridge.files.get('a.js').annotations).toHaveLength(1);

    // A fresh renderAll rebuilds from scratch — annotations are reset (callers
    // re-add them after), mirroring the legacy destroyAll-then-render flow.
    bridge.renderAll(root, [{ id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' }]);
    expect(bridge.files.get('a.js').annotations).toHaveLength(0);
  });
});

describe('PierreBridge patch that fails to parse', () => {
  let env;

  afterEach(() => {
    env.cleanup();
  });

  it('falls back to a header-only item instead of publishing a null fileDiff', () => {
    env = createPierreEnv({ worker: false, parsePatch: () => null });
    const bridge = new env.PierreBridge({});
    const root = env.document.createElement('div');
    bridge.renderAll(root, [
      { id: 'weird.js', type: 'diff', fileName: 'weird.js', patch: 'not a real patch' },
    ]);
    const item = env.codeViews[0].getItem('weird.js');
    expect(item.fileDiff).toBeTruthy();
    expect(item.fileDiff.hunks).toEqual([]);
    expect(item.fileDiff.name).toBe('weird.js');
  });
});

describe('PierreBridge teardown + scrolling', () => {
  let env;
  let bridge;
  let codeView;

  beforeEach(() => {
    env = createPierreEnv({ worker: false });
    bridge = new env.PierreBridge({});
    const root = env.document.createElement('div');
    bridge.renderAll(root, [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      { id: 'b.js', type: 'diff', fileName: 'b.js', patch: '@@ -1 +1 @@\n-c\n+d\n' },
    ]);
    codeView = env.codeViews[0];
  });

  afterEach(() => {
    env.cleanup();
  });

  it('destroyAll empties the CodeView and clears file state but keeps the instance', () => {
    bridge.destroyAll();
    expect(bridge.files.size).toBe(0);
    expect(codeView.itemIds()).toEqual([]);
    expect(codeView.cleanedUp).toBe(false); // instance + root binding preserved
  });

  it('destroyFile removes a single item, re-seeding the rest', () => {
    bridge.destroyFile('a.js');
    expect(bridge.files.has('a.js')).toBe(false);
    expect(codeView.itemIds()).toEqual(['b.js']);
  });

  it('scrollToFile issues an item scroll target', () => {
    expect(bridge.scrollToFile('b.js', { align: 'start' })).toBe(true);
    expect(codeView.calls.scrollTo.at(-1)).toMatchObject({ type: 'item', id: 'b.js', align: 'start' });
  });

  it('scrollToFile is a no-op for an unknown file', () => {
    const before = codeView.calls.scrollTo.length;
    expect(bridge.scrollToFile('missing.js')).toBe(false);
    expect(codeView.calls.scrollTo.length).toBe(before);
  });

  it('scrollToLine issues a line scroll target mapping side to the vendor value', () => {
    bridge.scrollToLine('a.js', 4, 'LEFT');
    expect(codeView.calls.scrollTo.at(-1)).toMatchObject({
      type: 'line', id: 'a.js', lineNumber: 4, side: 'deletions',
    });
  });
});

// The vendor invokes onPostRender(fileContainer, instance, phase, context) —
// phase ('mount'|'update'|'unmount') is arg 3 and the item context is arg 4
// (CodeView appends it last). The bridge captures per-file element/instance/
// shadow refs on mount and DROPS them on unmount so isPointerOverFile /
// isLineVisible / scroll-flashing never act on a recycled host. A production
// bug read context from arg 3 (the phase string), so refs were never captured;
// this suite locks the exact arg positions on BOTH the bridge and the fake —
// it fails against the old bridge bug AND against a fake that appends context
// at the wrong position.
describe('PierreBridge onPostRender mount/unmount ref lifecycle', () => {
  let env;
  let bridge;
  let codeView;
  let host;

  beforeEach(() => {
    env = createPierreEnv({ worker: false });
    bridge = new env.PierreBridge({});
    const root = env.document.createElement('div');
    bridge.renderAll(root, [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ]);
    codeView = env.codeViews[0];
    // A real, connected host so isPointerOverFile's isConnected + rect checks work.
    host = env.document.createElement('div');
    env.document.body.appendChild(host);
    host.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100 });
  });

  afterEach(() => {
    host.remove();
    env.cleanup();
  });

  it('captures element/instance/shadow refs and stamps the host on mount', () => {
    const shadow = env.document.createElement('div');
    const instance = { tag: 'inst-a' };

    codeView.mountItem('a.js', { element: host, instance, shadowRoot: shadow });

    const fileState = bridge.files.get('a.js');
    expect(host.dataset.fileName).toBe('a.js');      // arg 4 context reached the handler
    expect(host.classList.contains('d2h-file-wrapper')).toBe(true);
    expect(fileState._element).toBe(host);
    expect(fileState._shadowRoot).toBe(shadow);
    expect(fileState._instance).toBe(instance);
  });

  it('reports isPointerOverFile true while mounted and the pointer is inside', () => {
    codeView.mountItem('a.js', { element: host, instance: {} });
    bridge._lastPointerPosition = { clientX: 50, clientY: 50 };
    expect(bridge.isPointerOverFile('a.js')).toBe(true);
  });

  it('drops all refs on unmount so stale/recycled DOM is never acted on', () => {
    codeView.mountItem('a.js', { element: host, instance: { tag: 'inst-a' }, shadowRoot: env.document.createElement('div') });
    bridge._lastPointerPosition = { clientX: 50, clientY: 50 };
    expect(bridge.isPointerOverFile('a.js')).toBe(true);

    codeView.unmountItem('a.js', { element: host });

    const fileState = bridge.files.get('a.js');
    expect(fileState._element).toBeNull();
    expect(fileState._shadowRoot).toBeNull();
    expect(fileState._instance).toBeNull();
    expect(fileState.container).toBeNull();
    // With refs cleared the pointer can no longer resolve to this file.
    expect(bridge.isPointerOverFile('a.js')).toBe(false);
  });

  it('treats the update phase like mount (re-captures refs, not a teardown)', () => {
    codeView.mountItem('a.js', { element: host, instance: { tag: 'first' } });
    const nextHost = env.document.createElement('div');
    env.document.body.appendChild(nextHost);
    try {
      codeView.mountItem('a.js', { element: nextHost, instance: { tag: 'second' }, phase: 'update' });
      const fileState = bridge.files.get('a.js');
      expect(fileState._element).toBe(nextHost);
      expect(fileState._instance).toMatchObject({ tag: 'second' });
      expect(nextHost.dataset.fileName).toBe('a.js');
    } finally {
      nextHost.remove();
    }
  });
});

// The fake coalesces a frame's updateItems into ONE auto-scheduled flush. Under
// createPierreEnv's SYNCHRONOUS requestAnimationFrame the scheduled callback
// runs during scheduling, so _scheduledFlush must NOT be left wedged truthy by
// the returned-id assignment — otherwise every updateItem after the first would
// silently never render (its pending flush suppressed). This is a fake-fidelity
// regression: without the sentinel guard in _scheduleFlush the second annotation
// below never appears.
describe('FakeCodeView auto-flush under synchronous rAF', () => {
  let env;
  let bridge;
  let codeView;
  let host;

  beforeEach(() => {
    env = createPierreEnv({ worker: false }); // synchronous rAF
    bridge = new env.PierreBridge({});
    const root = env.document.createElement('div');
    bridge.renderAll(root, [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ]);
    codeView = env.codeViews[0];
    bridge.registerAnnotationRenderer('mark', (data) => {
      const el = env.document.createElement('div');
      el.textContent = data.body;
      return el;
    });
    host = env.document.createElement('div');
    env.document.body.appendChild(host);
    codeView.mountItem('a.js', { element: host });
  });

  afterEach(() => {
    host.remove();
    env.cleanup();
  });

  it('renders every one of a sequence of updates, not just the first', () => {
    bridge.addAnnotation('a.js', { lineNumber: 1, side: 'RIGHT', type: 'mark', id: 'm1', data: { body: 'one' } });
    bridge.addAnnotation('a.js', { lineNumber: 2, side: 'RIGHT', type: 'mark', id: 'm2', data: { body: 'two' } });
    bridge.addAnnotation('a.js', { lineNumber: 3, side: 'RIGHT', type: 'mark', id: 'm3', data: { body: 'three' } });

    expect(host.querySelector('[data-pr-annotation-id="m1"]').textContent).toBe('one');
    expect(host.querySelector('[data-pr-annotation-id="m2"]').textContent).toBe('two');
    expect(host.querySelector('[data-pr-annotation-id="m3"]').textContent).toBe('three');
    // The scheduled-flush flag is not wedged — it reset after each sync flush.
    expect(codeView._scheduledFlush).toBeNull();
  });

  it('reflects the latest data after successive non-annotation publishes (collapse)', () => {
    bridge.addAnnotation('a.js', { lineNumber: 1, side: 'RIGHT', type: 'mark', id: 'm1', data: { body: 'one' } });
    // A later publish of a different kind (collapse) must also render, not be
    // suppressed by a wedged flag.
    bridge.setCollapsed('a.js', true);
    expect(codeView.getItem('a.js').collapsed).toBe(true);
    expect(codeView._scheduledFlush).toBeNull();
  });
});

// Worker-pool failure recreates the CodeView main-thread-only. Every fileState
// must drop ALL FOUR mount refs (_element/container/_shadowRoot/_instance),
// symmetric with the onPostRender unmount path — consumers read
// fileState.container and treat non-null as "mounted", so a leftover detached
// container makes an off-screen file look mounted after the recreate.
describe('PierreBridge._recreateCodeViewMainThread ref hygiene', () => {
  it('nulls all four mount refs after recreate and re-seeds the item', () => {
    const env = createPierreEnv({ worker: false });
    const bridge = new env.PierreBridge({});
    const root = env.document.createElement('div');
    bridge.renderAll(root, [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ]);
    const codeView = env.codeViews[0];
    const shadow = env.document.createElement('div');
    const shadowHost = env.document.createElement('div');
    env.document.body.appendChild(shadowHost);
    codeView.mountItem('a.js', { element: shadowHost, instance: { tag: 'inst' }, shadowRoot: shadow });

    const fs = bridge.files.get('a.js');
    expect(fs._element).toBe(shadowHost);
    expect(fs.container).toBe(shadowHost);
    expect(fs._shadowRoot).toBe(shadow);
    expect(fs._instance).toBeTruthy();

    bridge._recreateCodeViewMainThread();

    expect(fs._element).toBeNull();
    expect(fs.container).toBeNull();   // the fix — was left stale before
    expect(fs._shadowRoot).toBeNull();
    expect(fs._instance).toBeNull();
    // A fresh main-thread CodeView carries the same item.
    expect(env.codeViews).toHaveLength(2);
    expect(env.codeViews[1].itemIds()).toEqual(['a.js']);

    shadowHost.remove();
    env.cleanup();
  });

  it('clears the instance→id map so dead instances do not accumulate per recreate', () => {
    // Recreating bypasses the per-item unmount callbacks that normally drop
    // instance→id entries, and every instance the dead CodeView made is
    // unreachable — without the clear the map grows by one entry per file on
    // every worker failure, and a recycled instance identity could resolve to
    // the wrong file.
    const env = createPierreEnv({ worker: false });
    const bridge = new env.PierreBridge({});
    const root = env.document.createElement('div');
    bridge.renderAll(root, [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      { id: 'b.js', type: 'diff', fileName: 'b.js', patch: '@@ -1 +1 @@\n-c\n+d\n' },
    ]);
    const codeView = env.codeViews[0];
    const hostA = env.document.createElement('div');
    const hostB = env.document.createElement('div');
    env.document.body.appendChild(hostA);
    env.document.body.appendChild(hostB);
    const instA = { tag: 'inst-a' };
    const instB = { tag: 'inst-b' };
    codeView.mountItem('a.js', { element: hostA, instance: instA });
    codeView.mountItem('b.js', { element: hostB, instance: instB });
    expect(bridge._instanceToId.size).toBe(2);
    const versionsBefore = {
      a: bridge.files.get('a.js').version,
      b: bridge.files.get('b.js').version,
    };

    bridge._recreateCodeViewMainThread();

    expect(bridge._instanceToId.size).toBe(0);
    expect(bridge._instanceToId.has(instA)).toBe(false);
    expect(bridge._instanceToId.has(instB)).toBe(false);

    // Both items are re-published on the fresh CodeView with bumped versions
    // (the version gate would otherwise drop the reconcile).
    expect(env.codeViews[1].itemIds()).toEqual(['a.js', 'b.js']);
    expect(env.codeViews[1].getItem('a.js').version).toBe(versionsBefore.a + 1);
    expect(env.codeViews[1].getItem('b.js').version).toBe(versionsBefore.b + 1);

    // Re-mounting on the fresh CodeView repopulates it — cleared, not disabled.
    env.codeViews[1].mountItem('a.js', { element: hostA, instance: { tag: 'inst-a2' } });
    expect(bridge._instanceToId.size).toBe(1);

    hostA.remove();
    hostB.remove();
    env.cleanup();
  });
});

// An external innerHTML wipe of #diff-container (refreshPR's legacy spinner, an
// error state) detaches the CodeView's managed container while root === root. A
// bare "same root → reuse" early-return would then keep updating the orphaned,
// off-screen container forever (the visible root stays frozen). _ensureCodeView
// detects the detach via container.parentNode (NOT isConnected — unit roots are
// document-detached) and does a full re-setup.
describe('PierreBridge._ensureCodeView container-detach re-setup', () => {
  const entry = { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' };

  it('reuses the CodeView on the same root with the container intact (no churn)', () => {
    const env = createPierreEnv({ worker: false });
    try {
      const bridge = new env.PierreBridge({});
      const root = env.document.createElement('div');
      bridge.renderAll(root, [entry]);
      const cv = env.codeViews[0];
      expect(cv.container.parentNode).toBe(root);

      bridge.renderAll(root, [entry]); // same root, container intact

      expect(env.codeViews).toHaveLength(1); // no new CodeView
      expect(bridge.codeView).toBe(cv);
      expect(cv.cleanedUp).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('re-sets up when the managed container was externally detached', () => {
    const env = createPierreEnv({ worker: false });
    try {
      const bridge = new env.PierreBridge({});
      const root = env.document.createElement('div');
      bridge.renderAll(root, [entry]);
      const cv1 = env.codeViews[0];
      expect(cv1.container.parentNode).toBe(root);

      root.innerHTML = ''; // external wipe detaches the managed container
      expect(cv1.container.parentNode).not.toBe(root);

      bridge.renderAll(root, [entry]); // same root, container detached → full re-setup

      expect(env.codeViews).toHaveLength(2);            // fresh CodeView
      expect(bridge.codeView).toBe(env.codeViews[1]);
      expect(cv1.cleanedUp).toBe(true);                 // old one torn down
      expect(env.codeViews[1].container.parentNode).toBe(root); // reconnected
    } finally {
      env.cleanup();
    }
  });

  it('re-sets up on a genuine root change', () => {
    const env = createPierreEnv({ worker: false });
    try {
      const bridge = new env.PierreBridge({});
      const root1 = env.document.createElement('div');
      const root2 = env.document.createElement('div');
      bridge.renderAll(root1, [entry]);
      bridge.renderAll(root2, [entry]);
      expect(env.codeViews).toHaveLength(2);
      expect(bridge.root).toBe(root2);
      expect(env.codeViews[0].cleanedUp).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});
