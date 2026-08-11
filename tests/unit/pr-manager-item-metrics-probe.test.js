// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * PRManager._syncCodeViewItemMetrics — the DOM probe that feeds the CodeView's
 * itemMetrics (line height, file-header height, hunk-separator height).
 *
 * Regression focus: the probe must walk EVERY mounted <diffs-container>, not
 * just the first. A binary or header-only first file has no shadow line rows at
 * all, so sampling only that host re-measures the same row-less shadow root on
 * every retry, burns the 8-attempt budget, and leaves lineHeight at the vendor
 * default (~20 vs the real ~17.4) for the WHOLE view — the wandering-gap /
 * off-by-a-file navigation jank this method exists to prevent.
 *
 * jsdom has no layout, so each measured element gets an explicit
 * getBoundingClientRect; that is the only thing being faked here — the probe
 * logic under test is the real production method.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

function makeManager({ setItemMetrics = vi.fn(), disabled = false } = {}) {
  const m = Object.create(PRManager.prototype);
  m.pierreBridge = { setItemMetrics, _disabled: disabled };
  return m;
}

function sized(el, height) {
  el.getBoundingClientRect = () => ({ height, width: 100, top: 0, left: 0, right: 100, bottom: height });
  return el;
}

/**
 * Append a <diffs-container> to #diff-container.
 * @param {Object} parts - heights for the optional pieces; omit for "absent"
 *   (headerHeight → light-DOM .d2h-file-header, lineHeight → a shadow
 *   [data-line-index] row, separatorHeight → a shadow [data-separator-wrapper]).
 */
function addHost({ headerHeight, lineHeight, separatorHeight, shadow = true } = {}) {
  const host = document.createElement('diffs-container');
  document.getElementById('diff-container').appendChild(host);

  if (headerHeight !== undefined) {
    const header = document.createElement('div');
    header.className = 'd2h-file-header';
    host.appendChild(sized(header, headerHeight));
  }

  if (shadow) {
    // The vendor's rows live in the host's shadow root. jsdom cannot attachShadow
    // to an arbitrary tag in every version, so expose an equivalent detached
    // subtree through the same property the probe reads.
    const root = document.createElement('div');
    if (lineHeight !== undefined) {
      const line = document.createElement('div');
      line.setAttribute('data-line-index', '0');
      root.appendChild(sized(line, lineHeight));
    }
    if (separatorHeight !== undefined) {
      const sep = document.createElement('div');
      sep.setAttribute('data-separator-wrapper', '');
      root.appendChild(sized(sep, separatorHeight));
    }
    Object.defineProperty(host, 'shadowRoot', { value: root, configurable: true });
  }
  return host;
}

let rafCalls;

beforeEach(() => {
  document.body.innerHTML = '<div id="diff-container"></div>';
  rafCalls = [];
  // Keep retries inspectable instead of letting them run: the probe reschedules
  // itself until both core metrics are measured.
  global.requestAnimationFrame = vi.fn((cb) => { rafCalls.push(cb); return rafCalls.length; });
  global.cancelAnimationFrame = vi.fn();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('PRManager._syncCodeViewItemMetrics — host probing', () => {
  it('skips a row-less first host and measures the line height from the next one', () => {
    // First file is header-only (binary / zero-hunk): header present, NO rows.
    addHost({ headerHeight: 53 });
    // Second file has real rows — the only place lineHeight can come from.
    addHost({ headerHeight: 99, lineHeight: 17.4, separatorHeight: 31 });

    const setItemMetrics = vi.fn();
    makeManager({ setItemMetrics })._syncCodeViewItemMetrics();

    expect(setItemMetrics).toHaveBeenCalledTimes(1);
    const metrics = setItemMetrics.mock.calls[0][0];
    expect(metrics.lineHeight).toBe(17.4);
    // Each metric is taken from the first host that HAS it, independently.
    expect(metrics.diffHeaderHeight).toBe(53);
    expect(metrics.hunkSeparatorHeight).toBe(31);
    // Both core metrics resolved → no retry burned.
    expect(global.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('walks past several row-less hosts to reach the first host with rows', () => {
    addHost({});                       // no header, no rows
    addHost({ shadow: false });        // not even a shadow root yet
    addHost({ headerHeight: 44 });     // header only
    addHost({ lineHeight: 18 });       // finally, rows

    const setItemMetrics = vi.fn();
    makeManager({ setItemMetrics })._syncCodeViewItemMetrics();

    expect(setItemMetrics.mock.calls[0][0]).toMatchObject({ diffHeaderHeight: 44, lineHeight: 18 });
  });

  it('stops at the first host carrying both core metrics (does not read later hosts)', () => {
    addHost({ headerHeight: 53, lineHeight: 17.4 });
    // A later host with different numbers must not overwrite the measurement.
    const later = addHost({ headerHeight: 80, lineHeight: 25, separatorHeight: 60 });
    const spy = vi.spyOn(later, 'querySelector');

    const setItemMetrics = vi.fn();
    makeManager({ setItemMetrics })._syncCodeViewItemMetrics();

    expect(setItemMetrics.mock.calls[0][0]).toMatchObject({ diffHeaderHeight: 53, lineHeight: 17.4 });
    expect(setItemMetrics.mock.calls[0][0].hunkSeparatorHeight).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores zero-height measurements (element present but not laid out yet)', () => {
    addHost({ headerHeight: 0, lineHeight: 0 });
    addHost({ headerHeight: 53, lineHeight: 17.4 });

    const setItemMetrics = vi.fn();
    makeManager({ setItemMetrics })._syncCodeViewItemMetrics();

    expect(setItemMetrics.mock.calls[0][0]).toMatchObject({ diffHeaderHeight: 53, lineHeight: 17.4 });
  });

  it('retries on the next frame with an incremented attempt while a core metric is missing', () => {
    addHost({ headerHeight: 53 }); // rows have not mounted yet

    const setItemMetrics = vi.fn();
    const m = makeManager({ setItemMetrics });
    m._syncCodeViewItemMetrics();

    // What it could measure is still applied immediately.
    expect(setItemMetrics.mock.calls[0][0]).toEqual({ diffHeaderHeight: 53 });
    expect(rafCalls).toHaveLength(1);

    // The retry re-probes; once rows exist it completes and stops rescheduling.
    addHost({ lineHeight: 17.4 });
    rafCalls.pop()();
    expect(setItemMetrics).toHaveBeenCalledTimes(2);
    expect(setItemMetrics.mock.calls[1][0]).toMatchObject({ lineHeight: 17.4 });
    expect(rafCalls).toHaveLength(0);
  });

  it('gives up after the attempt budget instead of rescheduling forever', () => {
    addHost({ headerHeight: 53 });
    const m = makeManager();

    m._syncCodeViewItemMetrics(7);   // last attempt that may reschedule
    expect(rafCalls).toHaveLength(1);
    rafCalls.length = 0;

    m._syncCodeViewItemMetrics(8);   // budget exhausted
    expect(rafCalls).toHaveLength(0);
  });

  it('falls back to the --diff-file-header-height CSS var when no host has a header yet', () => {
    document.documentElement.style.setProperty('--diff-file-header-height', '44px');
    try {
      addHost({ lineHeight: 17.4 }); // rows but no header mounted

      const setItemMetrics = vi.fn();
      makeManager({ setItemMetrics })._syncCodeViewItemMetrics();

      expect(setItemMetrics.mock.calls[0][0]).toMatchObject({
        diffHeaderHeight: 44,
        lineHeight: 17.4,
      });
      // Both metrics resolved (one measured, one from the var) → no retry.
      expect(global.requestAnimationFrame).not.toHaveBeenCalled();
    } finally {
      document.documentElement.style.removeProperty('--diff-file-header-height');
    }
  });

  it('prefers a measured header over the CSS var (the var can lag the DOM)', () => {
    document.documentElement.style.setProperty('--diff-file-header-height', '44px');
    try {
      addHost({ headerHeight: 53, lineHeight: 17.4 });

      const setItemMetrics = vi.fn();
      makeManager({ setItemMetrics })._syncCodeViewItemMetrics();

      expect(setItemMetrics.mock.calls[0][0].diffHeaderHeight).toBe(53);
    } finally {
      document.documentElement.style.removeProperty('--diff-file-header-height');
    }
  });

  it('applies nothing and does not throw when no host is mounted', () => {
    const setItemMetrics = vi.fn();
    makeManager({ setItemMetrics })._syncCodeViewItemMetrics();
    expect(setItemMetrics).not.toHaveBeenCalled();
  });

  it('is a no-op when the CodeView path is disabled or setItemMetrics is missing', () => {
    addHost({ headerHeight: 53, lineHeight: 17.4 });

    const disabledSet = vi.fn();
    makeManager({ setItemMetrics: disabledSet, disabled: true })._syncCodeViewItemMetrics();
    expect(disabledSet).not.toHaveBeenCalled();

    const m = Object.create(PRManager.prototype);
    m.pierreBridge = { _disabled: false }; // legacy bridge without the method
    expect(() => m._syncCodeViewItemMetrics()).not.toThrow();
  });
});
