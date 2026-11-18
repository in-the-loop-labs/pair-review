/*
 * Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for PRManager.handleDiffViewChange (Unified / Split toggle).
 *
 * The handler must NOT re-fetch the diff — it delegates to
 * pierreBridge.setDiffStyle, which preserves annotations and keeps the first
 * visible line where it is (tests/contract/bridge/view.spec.js), and it
 * writes no scroll position of its own. This handler is shared by PR mode
 * and local mode.
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

    // window (== sandbox): the handler must leave its scroll APIs alone.
    sandbox.scrollY = 250;
    sandbox.scrollTo = vi.fn();
    sandbox.requestAnimationFrame = vi.fn();
  });

  it('delegates to pierreBridge.setDiffStyle with the requested mode', () => {
    mgr.pierreBridge = { setDiffStyle: vi.fn() };

    mgr.handleDiffViewChange('split');

    expect(mgr.pierreBridge.setDiffStyle).toHaveBeenCalledTimes(1);
    expect(mgr.pierreBridge.setDiffStyle).toHaveBeenCalledWith('split');
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
    mgr.pierreBridge = { setDiffStyle: vi.fn(() => true) };

    expect(mgr.handleDiffViewChange('split')).toBe(true);
  });

  it('returns false when the viewer refuses the style, and writes no scroll position either way', () => {
    const container = { scrollTop: 420 };
    sandbox.document.querySelector = vi.fn((sel) => (sel === '.diff-view' ? container : null));
    mgr.pierreBridge = { setDiffStyle: vi.fn((style) => style === 'split') };

    expect(mgr.handleDiffViewChange('sideways')).toBe(false);
    expect(mgr.handleDiffViewChange('split')).toBe(true);
    expect(container.scrollTop).toBe(420);
    expect(sandbox.scrollTo).not.toHaveBeenCalled();
    expect(sandbox.requestAnimationFrame).not.toHaveBeenCalled();
  });
});
