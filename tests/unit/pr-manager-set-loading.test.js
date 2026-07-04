/*
 * Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
 */
/** @vitest-environment jsdom */

/**
 * Regression tests for PRManager.setLoading.
 *
 * The container state flag must be `is-loading`, NOT `loading` — `.loading`
 * is the visual placeholder class in pr.css (48px padding + centered text).
 * Because the diff renders inside #pr-container while the PR is still
 * loading (renderDiff awaits mid-flight), reusing the placeholder class made
 * the whole diff paint centered and padded, then snap left when loading
 * finished.
 */

import { describe, it, expect, beforeEach } from 'vitest';
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

describe('PRManager.setLoading', () => {
  let PRManager, sandbox, mgr, container;

  beforeEach(() => {
    ({ PRManager, sandbox } = load());
    mgr = Object.create(PRManager.prototype);
    container = document.createElement('div');
    container.id = 'pr-container';
    sandbox.document = {
      getElementById: (id) => (id === 'pr-container' ? container : null),
      addEventListener() {},
    };
  });

  it('adds is-loading while loading and tracks state', () => {
    mgr.setLoading(true);
    expect(mgr.loadingState).toBe(true);
    expect(container.classList.contains('is-loading')).toBe(true);
  });

  it('removes is-loading when loading finishes', () => {
    mgr.setLoading(true);
    mgr.setLoading(false);
    expect(mgr.loadingState).toBe(false);
    expect(container.classList.contains('is-loading')).toBe(false);
  });

  it('never applies the visual placeholder class `loading` to the container', () => {
    mgr.setLoading(true);
    expect(container.classList.contains('loading')).toBe(false);
    mgr.setLoading(false);
    expect(container.classList.contains('loading')).toBe(false);
  });

  it('is a no-op without a #pr-container element', () => {
    sandbox.document = { getElementById: () => null, addEventListener() {} };
    expect(() => mgr.setLoading(true)).not.toThrow();
    expect(mgr.loadingState).toBe(true);
  });
});
