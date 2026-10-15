// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for PRManager._trackTourBarHeight() and its teardown in _exitTour().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

const VAR = '--tour-bar-rendered-height';
let observers;
let savedResizeObserver;

function mountBar(height) {
  const bar = document.createElement('div');
  bar.className = 'tour-bar';
  document.body.appendChild(bar);
  // jsdom has no layout, so stub the measured height.
  Object.defineProperty(bar, 'offsetHeight', { configurable: true, value: height });
  return bar;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty(VAR);
  observers = [];
  savedResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(el) { this.targets.push(el); }
    disconnect() { this.disconnected = true; }
  };
});

afterEach(() => {
  globalThis.ResizeObserver = savedResizeObserver;
  document.documentElement.style.removeProperty(VAR);
});

describe('PRManager._trackTourBarHeight', () => {
  it('publishes the mounted bar height', () => {
    mountBar(61);
    const pm = Object.create(PRManager.prototype);
    pm._trackTourBarHeight();
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('61px');
  });

  it('re-publishes when the bar resizes (e.g. its contents wrap)', () => {
    const bar = mountBar(56);
    const pm = Object.create(PRManager.prototype);
    pm._trackTourBarHeight();
    expect(observers).toHaveLength(1);
    expect(observers[0].targets).toEqual([bar]);

    Object.defineProperty(bar, 'offsetHeight', { configurable: true, value: 88 });
    observers[0].cb([]);
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('88px');
  });

  it('leaves the variable unset (CSS fallback) when the bar has no height', () => {
    mountBar(0);
    const pm = Object.create(PRManager.prototype);
    pm._trackTourBarHeight();
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('');
  });

  it('does nothing when no bar is mounted', () => {
    const pm = Object.create(PRManager.prototype);
    pm._trackTourBarHeight();
    expect(observers).toHaveLength(0);
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('');
  });

  it('replaces the previous observer when the bar is re-mounted', () => {
    const pm = Object.create(PRManager.prototype);
    mountBar(56);
    pm._trackTourBarHeight();
    document.body.innerHTML = '';
    const second = mountBar(70);
    pm._trackTourBarHeight();

    expect(observers).toHaveLength(2);
    expect(observers[0].disconnected).toBe(true);
    expect(observers[1].targets).toEqual([second]);
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('70px');
  });

  it('still measures once without ResizeObserver support', () => {
    globalThis.ResizeObserver = undefined;
    mountBar(64);
    const pm = Object.create(PRManager.prototype);
    pm._trackTourBarHeight();
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('64px');
  });
});

describe('PRManager._exitTour tour-bar tracking teardown', () => {
  it('stops observing the removed bar', () => {
    mountBar(61);
    const pm = Object.create(PRManager.prototype);
    pm._tourGen = 0;
    pm._tourRenderer = null;
    pm._tourBar = { unmount: vi.fn() };
    pm._unregisterTourKeyboardHandlers = vi.fn();
    pm._syncTourToolbarButton = vi.fn();
    pm._trackTourBarHeight();

    pm._exitTour();

    expect(pm._tourBar.unmount).toHaveBeenCalled();
    expect(observers[0].disconnected).toBe(true);
    expect(pm._tourBarResizeObserver).toBeNull();
  });
});
