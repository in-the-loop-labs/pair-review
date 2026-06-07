/*
 * Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
 */
/** @vitest-environment jsdom */

/**
 * Regression test for the pending-draft toolbar indicator host name.
 *
 * Bug: renderPRHeader() fires fetchAndApplyRepoLinks() asynchronously and then
 * synchronously renders the pending-draft indicator. Because the repo links
 * (which carry the configured host name, e.g. "Meteorite") had not resolved
 * yet, the indicator baked in the "GitHub" fallback returned by
 * window.RepoLinks.hostName() and was never refreshed — so alt-host users saw
 * "Draft on GitHub" / "View your pending draft review on GitHub" forever.
 *
 * Fix: re-render the indicator once fetchAndApplyRepoLinks resolves.
 *
 * The class is loaded into a vm sandbox (the established pattern in
 * pr-manager-manual-start.test.js) but wired to the real jsdom document/window
 * so renderPRHeader can build and re-build a live DOM indicator.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadPRManager() {
  const code = fs.readFileSync(
    path.join(__dirname, '../../public/js/pr.js'),
    'utf8'
  );
  const sandbox = {
    window: global.window,
    document: global.document,
    navigator: global.navigator,
    console,
    localStorage: { getItem() { return null; }, setItem() {} },
    fetch: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
    setTimeout,
    clearTimeout,
    URLSearchParams,
    module: { exports: {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { filename: 'pr.js' });
  return sandbox.module.exports.PRManager;
}

describe('PRManager pending-draft indicator — configurable host name', () => {
  let PRManager;

  const pr = {
    owner: 'acme',
    repo: 'widget',
    number: 7,
    head_branch: 'feat',
    base_branch: 'main',
    head_sha: 'abc123',
    pendingDraft: {
      comments_count: 2,
      github_url: 'https://github.com/acme/widget/pull/7',
    },
  };

  beforeEach(() => {
    document.body.innerHTML = '<div id="toolbar-meta"></div>';
    PRManager = loadPRManager();
  });

  afterEach(() => {
    delete global.window.RepoLinks;
    delete global.window.__pairReview;
  });

  function makeManager() {
    const mgr = Object.create(PRManager.prototype);
    // Stub the unrelated renderers renderPRHeader also invokes so we exercise
    // only the pending-draft path.
    mgr._renderStackNavDropdown = vi.fn();
    mgr._renderAnalyzeSplitButton = vi.fn();
    return mgr;
  }

  it('re-renders with the resolved host name after repo links load', async () => {
    // hostName()/externalUrl() flip from the "GitHub" fallback to the
    // configured host only once fetchAndApplyRepoLinks resolves — mirroring
    // the real async fetch in window.RepoLinks.
    let resolved = false;
    let resolveFetch;
    const fetchPromise = new Promise((res) => { resolveFetch = res; });
    const templateUrl = 'https://staging-2.gitstream.shopify.io/acme/widget/pull/7';
    global.window.RepoLinks = {
      fetchAndApplyRepoLinks: vi.fn(() => fetchPromise),
      hostName: () => (resolved ? 'Meteorite' : 'GitHub'),
      externalUrl: () => (resolved ? templateUrl : null),
    };

    makeManager().renderPRHeader(pr);

    // Synchronous first render: links not resolved yet → fallback text.
    const before = document.getElementById('pending-draft-indicator');
    expect(before).not.toBeNull();
    expect(before.textContent).toContain('Draft on GitHub');

    // Links resolve → the .then() re-render must rebuild the indicator with
    // the configured host name and the template-built URL.
    resolved = true;
    resolveFetch();
    await fetchPromise;
    await Promise.resolve(); // flush the .then() microtask

    const after = document.getElementById('pending-draft-indicator');
    expect(after.textContent).toContain('Draft on Meteorite');
    expect(after.textContent).not.toContain('GitHub');
    expect(after.title).toBe('View your pending draft review on Meteorite');
    expect(after.getAttribute('href')).toBe(templateUrl);
    // Idempotent: re-render replaces the indicator, never duplicates it.
    expect(document.querySelectorAll('#pending-draft-indicator').length).toBe(1);
  });

  it('keeps the "GitHub" fallback when no host name is configured', async () => {
    const fetchPromise = Promise.resolve();
    global.window.RepoLinks = {
      fetchAndApplyRepoLinks: vi.fn(() => fetchPromise),
      hostName: () => 'GitHub',
      externalUrl: () => null,
    };

    makeManager().renderPRHeader(pr);
    await fetchPromise;
    await Promise.resolve();

    const indicator = document.getElementById('pending-draft-indicator');
    expect(indicator.textContent).toContain('Draft on GitHub');
    expect(indicator.title).toBe('View your pending draft review on GitHub');
    // No template URL → falls back to the server-reported github_url.
    expect(indicator.getAttribute('href')).toBe('https://github.com/acme/widget/pull/7');
  });
});
