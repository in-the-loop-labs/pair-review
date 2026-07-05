/*
 * Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for PRManager.handleDiffViewChange (Unified / Split toggle).
 *
 * The handler must NOT re-fetch the diff — it delegates to
 * pierreBridge.setDiffStyle (which preserves annotations) and restores the
 * scroll position. This handler is shared by PR mode and local mode.
 *
 * PRManager is a browser-only file with no exports, so we load it in a vm
 * sandbox (mirroring pr-manager-set-loading.test.js). Functions compiled in
 * the vm close over the sandbox's globals, so window/scrollTo/rAF must be
 * provided on the sandbox, not on any jsdom global.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const code = fs.readFileSync(
    path.join(__dirname, '../../public/js/pr.js'),
    'utf8'
  );
  const moduleExports = {};
  const sandbox = {
    window: {},
    document: { addEventListener() {} },
    console,
    localStorage: { getItem() { return null; }, setItem() {} },
    fetch: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
    navigator: { clipboard: {} },
    setTimeout,
    clearTimeout,
    URLSearchParams,
    module: { exports: moduleExports },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { filename: 'pr.js' });
  const PRManager = sandbox.module.exports.PRManager;
  return { PRManager, sandbox };
}

describe('PRManager.handleDiffViewChange', () => {
  let PRManager, sandbox, mgr;

  beforeEach(() => {
    ({ PRManager, sandbox } = load());
    mgr = Object.create(PRManager.prototype);

    // window (== sandbox) provides scroll APIs the handler closes over.
    sandbox.scrollY = 250;
    sandbox.scrollTo = vi.fn();
    // Run the rAF callback synchronously so scroll restore is observable.
    sandbox.requestAnimationFrame = (cb) => cb();
  });

  it('delegates to pierreBridge.setDiffStyle with the requested mode', () => {
    mgr.pierreBridge = { setDiffStyle: vi.fn() };

    mgr.handleDiffViewChange('split');

    expect(mgr.pierreBridge.setDiffStyle).toHaveBeenCalledTimes(1);
    expect(mgr.pierreBridge.setDiffStyle).toHaveBeenCalledWith('split');
  });

  it('restores the window scroll position when no .diff-view container exists', () => {
    // Default sandbox document has no querySelector, so the handler falls back
    // to the window scroll position.
    mgr.pierreBridge = { setDiffStyle: vi.fn() };

    mgr.handleDiffViewChange('split');

    expect(sandbox.scrollTo).toHaveBeenCalledWith(0, 250);
  });

  it('captures and restores the .diff-view container scrollTop (not the window)', () => {
    // The diff pane scrolls inside `.diff-view`, so window.scrollY is ~0 and
    // the handler must save/restore the container's scrollTop instead. Simulate
    // the layout swap resetting scrollTop to 0 and assert it is restored.
    const container = { scrollTop: 420 };
    mgr.pierreBridge = { setDiffStyle: vi.fn(() => { container.scrollTop = 0; }) };
    sandbox.document.querySelector = vi.fn((sel) => (sel === '.diff-view' ? container : null));

    mgr.handleDiffViewChange('split');

    expect(container.scrollTop).toBe(420);
    expect(sandbox.scrollTo).not.toHaveBeenCalled();
  });

  it('does NOT re-fetch the diff (no loadAndDisplayFiles / _rerenderAllOverlays)', () => {
    mgr.pierreBridge = { setDiffStyle: vi.fn() };
    mgr.loadAndDisplayFiles = vi.fn();
    mgr._rerenderAllOverlays = vi.fn();

    mgr.handleDiffViewChange('unified');

    expect(mgr.loadAndDisplayFiles).not.toHaveBeenCalled();
    expect(mgr._rerenderAllOverlays).not.toHaveBeenCalled();
  });

  it('is a safe no-op when pierreBridge is absent', () => {
    mgr.pierreBridge = null;

    expect(() => mgr.handleDiffViewChange('split')).not.toThrow();
    expect(sandbox.scrollTo).not.toHaveBeenCalled();
  });

  it('returns false without a bridge so the dropdown rolls back its selection', () => {
    mgr.pierreBridge = null;

    expect(mgr.handleDiffViewChange('split')).toBe(false);
  });

  it('returns true after a successful apply so the dropdown persists the selection', () => {
    mgr.pierreBridge = { setDiffStyle: vi.fn() };

    expect(mgr.handleDiffViewChange('split')).toBe(true);
  });
});
