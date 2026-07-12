/*
 * Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
 */
/** @vitest-environment jsdom */

/**
 * Tests for the analyze-button spinner lifecycle.
 *
 * pr.html and local.html both render `<span class="btn-text">Analyze</span>`
 * inside #analyze-btn, so setButtonAnalyzing must show the spinner from within
 * the .btn-text branch (the else branch never runs for the live button). The
 * restore paths (resetButton / setButtonComplete) must remove that spinner.
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

describe('PRManager analyze-button spinner lifecycle', () => {
  let PRManager, sandbox, mgr, btn;

  beforeEach(() => {
    ({ PRManager, sandbox } = load());
    // Use the real jsdom document so createElement/insertBefore/querySelector
    // all work, but override getElementById to return our fixtures.
    sandbox.document = document;
    document.body.innerHTML = '';
    btn = document.createElement('button');
    btn.id = 'analyze-btn';
    const label = document.createElement('span');
    label.className = 'btn-text';
    label.textContent = 'Analyze';
    btn.appendChild(label);
    document.body.appendChild(btn);
    mgr = Object.create(PRManager.prototype);
  });

  it('inserts a spinner before the label and switches text when analyzing', () => {
    mgr.setButtonAnalyzing('a1');

    const spinner = btn.querySelector('.btn-spinner');
    expect(spinner).not.toBeNull();
    // Spinner precedes the label.
    expect(btn.firstElementChild.className).toBe('btn-spinner');
    expect(btn.querySelector('.btn-text').textContent).toBe('Analyzing...');
    expect(btn.classList.contains('btn-analyzing')).toBe(true);
    expect(mgr.isAnalyzing).toBe(true);
    expect(mgr.currentAnalysisId).toBe('a1');
  });

  it('does not stack a second spinner on a repeated call', () => {
    mgr.setButtonAnalyzing('a1');
    mgr.setButtonAnalyzing('a2');
    expect(btn.querySelectorAll('.btn-spinner').length).toBe(1);
    expect(btn.querySelector('.btn-text').textContent).toBe('Analyzing...');
  });

  it('removes the spinner and restores the label on resetButton', () => {
    mgr.setButtonAnalyzing('a1');
    mgr.resetButton();

    expect(btn.querySelector('.btn-spinner')).toBeNull();
    expect(btn.querySelector('.btn-text').textContent).toBe('Analyze');
    expect(btn.classList.contains('btn-analyzing')).toBe(false);
    expect(mgr.isAnalyzing).toBe(false);
  });

  it('removes the spinner on setButtonComplete', () => {
    mgr.setButtonAnalyzing('a1');
    mgr.setButtonComplete();

    expect(btn.querySelector('.btn-spinner')).toBeNull();
    expect(btn.querySelector('.btn-text').textContent).toBe('Complete');
  });

  it('is a no-op without an analyze button', () => {
    document.body.innerHTML = '';
    expect(() => mgr.setButtonAnalyzing('a1')).not.toThrow();
  });
});
