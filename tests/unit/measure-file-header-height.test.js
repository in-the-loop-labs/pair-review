// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for PRManager._measureFileHeaderHeight().
 *
 * Navigation lands targets at the top of the diff panel (block:'start') and
 * relies on a scroll-margin-top of `--toolbar-height + --diff-file-header-height`
 * (pr.css) to clear the sticky toolbar and sticky file header. This method
 * keeps `--diff-file-header-height` in sync with the rendered header so the
 * offset is correct; if no header exists yet, the CSS fallback applies.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty('--diff-file-header-height');
});

afterEach(() => {
  document.documentElement.style.removeProperty('--diff-file-header-height');
});

describe('PRManager._measureFileHeaderHeight', () => {
  it('publishes the rendered header height into --diff-file-header-height', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    const header = document.createElement('div');
    header.className = 'd2h-file-header';
    wrapper.appendChild(header);
    document.body.appendChild(wrapper);
    // jsdom has no layout, so stub the measured height.
    Object.defineProperty(header, 'offsetHeight', { configurable: true, value: 41 });

    const pm = Object.create(PRManager.prototype);
    pm._measureFileHeaderHeight();

    expect(document.documentElement.style.getPropertyValue('--diff-file-header-height')).toBe('41px');
  });

  it('leaves the variable unset when no header is present (CSS fallback applies)', () => {
    const pm = Object.create(PRManager.prototype);
    pm._measureFileHeaderHeight();

    expect(document.documentElement.style.getPropertyValue('--diff-file-header-height')).toBe('');
  });

  it('does not set the variable for a zero-height header', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    const header = document.createElement('div');
    header.className = 'd2h-file-header';
    wrapper.appendChild(header);
    document.body.appendChild(wrapper);
    Object.defineProperty(header, 'offsetHeight', { configurable: true, value: 0 });

    const pm = Object.create(PRManager.prototype);
    pm._measureFileHeaderHeight();

    expect(document.documentElement.style.getPropertyValue('--diff-file-header-height')).toBe('');
  });
});
