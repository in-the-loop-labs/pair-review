// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { createPierreEnv } = require('../utils/fake-code-view');

// bridge.syncScrollExtent() pushes ALREADY-MEASURED item heights into the DOM
// scroll extent.
//
// The vendor re-measures a mounted item whose content grows (its ResizeObserver
// parents every rendered item, so item.height and its own scrollHeight are
// current), but only a RENDER pass calls syncContainerHeight() — the resize
// handler reconciles and repositions without it. Until something else renders,
// the container element stays SHORT by exactly the growth (measured: 1216px of
// extent against the vendor's own 1430px after a file-comment form opened), so
// the user cannot scroll into the gap and Save sits out of reach.
//
// The fix is a QUEUED render — render(false) — which the vendor coalesces to one
// pass per frame. That argument is the whole perf story: no version bump, no
// annotation re-render, no layout-cache reset, so a textarea autogrowing on every
// keystroke costs one layout flush per frame instead of a republish per keystroke.

let active;

afterEach(() => {
  if (active) { active.env.cleanup(); active = null; }
});

function setup({ render = true } = {}) {
  const env = createPierreEnv({ worker: false });
  const bridge = new env.PierreBridge({});
  const root = env.document.createElement('div');
  bridge.renderAll(root, [
    { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' },
  ]);
  const codeView = env.codeViews[0];
  active = { env, bridge, codeView, root };
  // `render` lives on FakeCodeView.prototype, so shadow it with an own property —
  // `delete` on the instance would silently leave the prototype method in place.
  if (!render) codeView.render = undefined;
  return active;
}

describe('PierreBridge.syncScrollExtent', () => {
  it('requests a QUEUED render and reports that it did', () => {
    const { bridge, codeView } = setup();

    expect(bridge.syncScrollExtent()).toBe(true);

    // The argument is the contract: false = queued/coalesced, not immediate.
    expect(codeView.calls.render).toEqual([false]);
  });

  it('publishes NOTHING — no version bump, no updateItem, no setItems', () => {
    // This is why it replaced a republish: a resize storm must not re-render
    // annotations or reset any item's layout cache.
    const { bridge, codeView } = setup();
    const versionBefore = bridge.files.get('a.js').version;
    const publishes = codeView.calls.updateItem.length;
    const setItems = codeView.calls.setItems.length;

    bridge.syncScrollExtent();

    expect(bridge.files.get('a.js').version).toBe(versionBefore);
    expect(codeView.calls.updateItem.length).toBe(publishes);
    expect(codeView.calls.setItems.length).toBe(setItems);
  });

  it('requests one render per call (coalescing is the vendor\'s job, not the bridge\'s)', () => {
    const { bridge, codeView } = setup();

    bridge.syncScrollExtent();
    bridge.syncScrollExtent();
    bridge.syncScrollExtent();

    expect(codeView.calls.render).toEqual([false, false, false]);
  });

  it('returns false and renders nothing when the bridge is disabled', () => {
    const { bridge, codeView } = setup();
    bridge._disabled = true;

    expect(bridge.syncScrollExtent()).toBe(false);

    expect(codeView.calls.render).toEqual([]);
  });

  it('returns false before any CodeView is set up', () => {
    const env = createPierreEnv({ worker: false });
    active = { env };
    const bridge = new env.PierreBridge({}); // no renderAll yet

    expect(bridge.syncScrollExtent()).toBe(false);
  });

  it('returns false (no throw) when the CodeView exposes no render method', () => {
    // Guards against a vendor-shape mismatch: an older bundle without render()
    // must degrade to "no extent sync", never a TypeError inside a resize
    // callback that fires on every keystroke.
    const { bridge } = setup({ render: false });

    expect(bridge.syncScrollExtent()).toBe(false);
  });

  it('works for a virtualized-out view (extent is per-view, not per-item)', () => {
    // No item is mounted here; the extent still needs flushing, so this must not
    // acquire an is-mounted precondition.
    const { bridge, codeView } = setup();
    expect(codeView.isMounted('a.js')).toBe(false);

    expect(bridge.syncScrollExtent()).toBe(true);
    expect(codeView.calls.render).toEqual([false]);
  });
});
