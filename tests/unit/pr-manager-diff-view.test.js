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

  it('restores the scroll position after re-rendering', () => {
    mgr.pierreBridge = { setDiffStyle: vi.fn() };

    mgr.handleDiffViewChange('split');

    expect(sandbox.scrollTo).toHaveBeenCalledWith(0, 250);
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
});
