/*
 * Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
 */
/** @vitest-environment jsdom */

/**
 * Regression test for the stack-nav quick-switcher rendering real links.
 *
 * The header PR-stack switcher used to render each PR title as a <div> with a
 * JS click handler that set window.location.href. That made right-click "open
 * in new tab" and cmd/ctrl/middle-click impossible. The items are now real
 * <a href> anchors so the browser handles open-in-new-tab natively; the click
 * handler only closes the menu (and avoids double-navigating on modified
 * clicks). The current PR renders as an anchor with no href.
 *
 * PRManager is loaded into a vm sandbox (the established pattern in
 * pr-manager-manual-start.test.js / pr-pending-draft-host-name.test.js) wired
 * to the real jsdom document so _renderStackNavDropdown builds a live DOM.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

describe('PRManager stack-nav switcher — real anchor links', () => {
  let PRManager;

  const pr = {
    owner: 'acme',
    repo: 'widget',
    number: 7,
    stack_data: [
      { branch: 'main', isTrunk: true },
      { branch: 'feat-base', isTrunk: false, prNumber: 6, title: 'Base PR' },
      { branch: 'feat-top', isTrunk: false, prNumber: 7, title: 'Top PR' },
    ],
  };

  beforeEach(() => {
    document.body.innerHTML =
      '<div class="pr-title-wrapper"><h1 id="pr-title-text">Top PR</h1></div>';
    PRManager = loadPRManager();
  });

  function makeManager() {
    return Object.create(PRManager.prototype);
  }

  it('renders each non-current PR as an <a> with the correct href', () => {
    const mgr = makeManager();
    mgr._renderStackNavDropdown(pr);

    const items = document.querySelectorAll('.stack-nav-item');
    expect(items.length).toBe(2);

    for (const item of items) {
      expect(item.tagName).toBe('A');
    }

    // #6 is the other (non-current) PR — it must be a real navigable link.
    const other = document.querySelector('.stack-nav-item[data-pr="6"]');
    expect(other.getAttribute('href')).toBe('/pr/acme/widget/6');
  });

  it('renders the current PR as an anchor with no href', () => {
    const mgr = makeManager();
    mgr._renderStackNavDropdown(pr);

    const current = document.querySelector('.stack-nav-item.current');
    expect(current).not.toBeNull();
    expect(current.dataset.pr).toBe('7');
    expect(current.hasAttribute('href')).toBe(false);
  });

  it('encodes owner/repo into the href', () => {
    const mgr = makeManager();
    mgr._renderStackNavDropdown({ ...pr, owner: 'a c/me', repo: 'wid get' });

    const other = document.querySelector('.stack-nav-item[data-pr="6"]');
    expect(other.getAttribute('href')).toBe(
      `/pr/${encodeURIComponent('a c/me')}/${encodeURIComponent('wid get')}/6`
    );
  });

  it('does not navigate the current tab on a plain left-click (href does)', () => {
    const mgr = makeManager();
    mgr._renderStackNavDropdown(pr);

    const dropdown = document.querySelector('.stack-nav-dropdown');
    const trigger = document.querySelector('.stack-nav-trigger');
    dropdown.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');

    const other = document.querySelector('.stack-nav-item[data-pr="6"]');
    // jsdom does not follow anchor navigation; assert the handler leaves
    // navigation to the browser (no manual location assignment) and closes
    // the menu. preventDefault must NOT be called for a real link.
    const evt = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    const prevented = !other.dispatchEvent(evt);

    expect(prevented).toBe(false); // handler let the link proceed
    expect(dropdown.classList.contains('open')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes the menu on a modified (cmd) click without preventing the new tab', () => {
    const mgr = makeManager();
    mgr._renderStackNavDropdown(pr);

    const dropdown = document.querySelector('.stack-nav-dropdown');
    const trigger = document.querySelector('.stack-nav-trigger');
    dropdown.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');

    const other = document.querySelector('.stack-nav-item[data-pr="6"]');
    const evt = new window.MouseEvent('click', {
      bubbles: true, cancelable: true, button: 0, metaKey: true,
    });
    const prevented = !other.dispatchEvent(evt);

    expect(prevented).toBe(false); // did not preventDefault — new tab opens
    expect(dropdown.classList.contains('open')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
