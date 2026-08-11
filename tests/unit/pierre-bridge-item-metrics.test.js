// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { createPierreEnv } = require('../utils/fake-code-view');

// Task #15 (item-height fix): CodeView reserves item heights from itemMetrics
// (static line-height estimate + an UNMEASURED custom header), so wrong metrics
// make reserved heights disagree with rendered heights and the layout drifts as
// lines mount on scroll. pr.js measures the real rendered dimensions and pushes
// them via bridge.setItemMetrics(); this pins that merge/EPS/relayout contract.
// (The pr.js DOM-measurement path that computes the values is E2E-covered.)

let active;

afterEach(() => {
  if (active) { active.env.cleanup(); active = null; }
});

function rendered() {
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

describe('PierreBridge.setItemMetrics', () => {
  it('merges finite metrics, returns true, and relayouts via one setOptions', () => {
    const { bridge, codeView } = rendered();
    const before = codeView.calls.setOptions.length;

    expect(bridge.setItemMetrics({ diffHeaderHeight: 53, lineHeight: 17.39 })).toBe(true);

    expect(bridge._itemMetrics).toEqual({ diffHeaderHeight: 53, lineHeight: 17.39 });
    expect(codeView.calls.setOptions.length).toBe(before + 1);
    expect(codeView.calls.setOptions.at(-1).itemMetrics).toEqual({ diffHeaderHeight: 53, lineHeight: 17.39 });
  });

  it('is idempotent: identical metrics return false and do not relayout', () => {
    const { bridge, codeView } = rendered();
    bridge.setItemMetrics({ diffHeaderHeight: 53, lineHeight: 17.39 });
    const after = codeView.calls.setOptions.length;

    expect(bridge.setItemMetrics({ diffHeaderHeight: 53, lineHeight: 17.39 })).toBe(false);
    expect(codeView.calls.setOptions.length).toBe(after);
  });

  it('treats a sub-EPS (<0.5px) change as a no-op', () => {
    const { bridge, codeView } = rendered();
    bridge.setItemMetrics({ lineHeight: 17.39 });
    const after = codeView.calls.setOptions.length;

    expect(bridge.setItemMetrics({ lineHeight: 17.45 })).toBe(false); // Δ 0.06
    expect(bridge._itemMetrics).toEqual({ lineHeight: 17.39 });       // unchanged
    expect(codeView.calls.setOptions.length).toBe(after);
  });

  it('applies a >=EPS change and relayouts', () => {
    const { bridge, codeView } = rendered();
    bridge.setItemMetrics({ lineHeight: 17.39 });
    const after = codeView.calls.setOptions.length;

    expect(bridge.setItemMetrics({ lineHeight: 18.0 })).toBe(true);   // Δ 0.61
    expect(bridge._itemMetrics).toEqual({ lineHeight: 18.0 });
    expect(codeView.calls.setOptions.length).toBe(after + 1);
    expect(codeView.calls.setOptions.at(-1).itemMetrics).toEqual({ lineHeight: 18.0 });
  });

  it('merges partial updates across calls (keeps prior keys)', () => {
    const { bridge, codeView } = rendered();
    bridge.setItemMetrics({ diffHeaderHeight: 53 });
    expect(bridge.setItemMetrics({ lineHeight: 17.39 })).toBe(true);

    expect(bridge._itemMetrics).toEqual({ diffHeaderHeight: 53, lineHeight: 17.39 });
    expect(codeView.calls.setOptions.at(-1).itemMetrics).toEqual({ diffHeaderHeight: 53, lineHeight: 17.39 });
  });

  it('drops non-finite and non-positive values, applying only the valid keys', () => {
    const { bridge } = rendered();
    expect(bridge.setItemMetrics({ lineHeight: NaN, diffHeaderHeight: 0, hunkSeparatorHeight: 32 })).toBe(true);
    expect(bridge._itemMetrics).toEqual({ hunkSeparatorHeight: 32 });
  });

  it('ignores a non-object / null argument', () => {
    const { bridge, codeView } = rendered();
    const before = codeView.calls.setOptions.length;
    expect(bridge.setItemMetrics(null)).toBe(false);
    expect(bridge.setItemMetrics(undefined)).toBe(false);
    expect(bridge.setItemMetrics(42)).toBe(false);
    expect(bridge._itemMetrics).toBeNull();
    expect(codeView.calls.setOptions.length).toBe(before);
  });

  it('omits itemMetrics from CodeView options until set, then includes them', () => {
    const env = createPierreEnv({ worker: false });
    active = { env };
    const bridge = new env.PierreBridge({});

    expect(bridge._buildCodeViewOptions().itemMetrics).toBeUndefined();

    bridge.setItemMetrics({ lineHeight: 17.39 });
    expect(bridge._buildCodeViewOptions().itemMetrics).toEqual({ lineHeight: 17.39 });
  });

  it('updates metrics and returns true before any CodeView exists (no throw)', () => {
    const env = createPierreEnv({ worker: false });
    active = { env };
    const bridge = new env.PierreBridge({}); // no renderAll → this.codeView is null

    expect(() => bridge.setItemMetrics({ lineHeight: 17.39, diffHeaderHeight: 53 })).not.toThrow();
    expect(bridge.setItemMetrics({ spacing: 8 })).toBe(true);
    expect(bridge._itemMetrics).toEqual({ lineHeight: 17.39, diffHeaderHeight: 53, spacing: 8 });
  });
});
