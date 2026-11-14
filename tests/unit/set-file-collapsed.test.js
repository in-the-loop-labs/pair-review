// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * PRManager.setFileCollapsed is the single writer of a changed file's
 * collapsed state, and isFileCollapsed the single reader. The header
 * chevron, the Viewed checkbox, the review panel, the suggestion navigator
 * and the tour all go through them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { makePageManager } = require('../utils/page-manager.js');

function addWrapper(fileName, { collapsed = false } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = `d2h-file-wrapper${collapsed ? ' collapsed' : ''}`;
  wrapper.dataset.fileName = fileName;
  wrapper.innerHTML = '<div class="d2h-file-header"></div>';
  document.body.appendChild(wrapper);
  return wrapper;
}

function makeManager(overrides = {}) {
  const bridge = { files: new Map([['a.js', {}]]), setCollapsed: vi.fn() };
  return makePageManager({
    pierreBridge: bridge,
    changedFilesByPath: new Map([['a.js', {}], ['unmounted.js', {}]]),
    findFileElement: (file) => document.querySelector(`.d2h-file-wrapper[data-file-name="${file}"]`),
    ensureFileBodyRendered: vi.fn(async () => null),
    ...overrides,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.DiffRenderer = { updateFileHeaderState: vi.fn() };
});

afterEach(() => {
  delete window.DiffRenderer;
  vi.restoreAllMocks();
});

describe('PRManager.isFileCollapsed', () => {
  it('answers from the file\'s wrapper, whatever made the file collapsed', () => {
    const manager = makeManager();
    const wrapper = addWrapper('a.js', { collapsed: true });
    // A generated or viewed file is collapsed without being in collapsedFiles.
    expect(manager.collapsedFiles.has('a.js')).toBe(false);
    expect(manager.isFileCollapsed('a.js')).toBe(true);
    wrapper.classList.remove('collapsed');
    expect(manager.isFileCollapsed('a.js')).toBe(false);
  });

  it('answers from data for a file of the diff that has no wrapper', () => {
    const manager = makeManager();
    expect(manager.isFileCollapsed('unmounted.js')).toBe(false);
    manager.collapsedFiles.add('unmounted.js');
    expect(manager.isFileCollapsed('unmounted.js')).toBe(true);
  });

  it('is null for a path that is not a file of the diff, and for no path', () => {
    const manager = makeManager();
    expect(manager.isFileCollapsed('nowhere.js')).toBeNull();
    expect(manager.isFileCollapsed('')).toBeNull();
    expect(manager.isFileCollapsed(undefined)).toBeNull();
    expect(makePageManager({ changedFilesByPath: undefined }).isFileCollapsed('a.js')).toBeNull();
  });
});

describe('PRManager.setFileCollapsed', () => {
  it('collapses: state, wrapper class, header and engine, without rendering the body', async () => {
    const manager = makeManager();
    const wrapper = addWrapper('a.js');

    await expect(manager.setFileCollapsed('a.js', true)).resolves.toBe(true);

    expect(manager.collapsedFiles.has('a.js')).toBe(true);
    expect(wrapper.classList.contains('collapsed')).toBe(true);
    expect(window.DiffRenderer.updateFileHeaderState).toHaveBeenCalledWith(wrapper.querySelector('.d2h-file-header'), false);
    expect(manager.pierreBridge.setCollapsed).toHaveBeenCalledWith('a.js', true);
    expect(manager.ensureFileBodyRendered).not.toHaveBeenCalled();
  });

  it('expands: renders the body first, then reveals it', async () => {
    const order = [];
    const manager = makeManager({
      ensureFileBodyRendered: vi.fn(async () => { order.push('render'); }),
    });
    manager.pierreBridge.setCollapsed.mockImplementation(() => order.push('engine'));
    manager.collapsedFiles.add('a.js');
    const wrapper = addWrapper('a.js', { collapsed: true });

    await expect(manager.setFileCollapsed('a.js', false)).resolves.toBe(true);

    expect(order).toEqual(['render', 'engine']);
    expect(manager.collapsedFiles.has('a.js')).toBe(false);
    expect(wrapper.classList.contains('collapsed')).toBe(false);
    expect(window.DiffRenderer.updateFileHeaderState).toHaveBeenCalledWith(wrapper.querySelector('.d2h-file-header'), true);
    expect(manager.pierreBridge.setCollapsed).toHaveBeenCalledWith('a.js', false);
  });

  it('is idempotent: setting the state a file already has leaves it there', async () => {
    const manager = makeManager();
    const wrapper = addWrapper('a.js', { collapsed: true });
    await manager.setFileCollapsed('a.js', true);
    await manager.setFileCollapsed('a.js', true);
    expect(wrapper.classList.contains('collapsed')).toBe(true);
    expect(manager.collapsedFiles.has('a.js')).toBe(true);
  });

  it('writes the state of a file of the diff that has no wrapper, and leaves the engine alone', async () => {
    const manager = makeManager();
    await expect(manager.setFileCollapsed('unmounted.js', true)).resolves.toBe(true);
    expect(manager.collapsedFiles.has('unmounted.js')).toBe(true);
    expect(manager.isFileCollapsed('unmounted.js')).toBe(true);
    expect(manager.pierreBridge.setCollapsed).not.toHaveBeenCalled();
  });

  it('refuses a path that is not a file of the diff', async () => {
    const manager = makeManager();
    await expect(manager.setFileCollapsed('nowhere.js', true)).resolves.toBe(false);
    await expect(manager.setFileCollapsed(undefined, true)).resolves.toBe(false);
    expect(manager.collapsedFiles.size).toBe(0);
  });

  it('a later request for the same file supersedes one that is waiting for the body to render', async () => {
    let release;
    const manager = makeManager({
      ensureFileBodyRendered: vi.fn(() => new Promise((resolve) => { release = resolve; })),
    });
    const wrapper = addWrapper('a.js', { collapsed: true });

    const expanding = manager.setFileCollapsed('a.js', false);
    // While the body renders, the reader marks the file viewed: collapse.
    await expect(manager.setFileCollapsed('a.js', true)).resolves.toBe(true);
    release();

    await expect(expanding).resolves.toBe(false);
    expect(wrapper.classList.contains('collapsed')).toBe(true);
    expect(manager.collapsedFiles.has('a.js')).toBe(true);
    expect(manager.pierreBridge.setCollapsed.mock.calls).toEqual([['a.js', true]]);
  });

  it('acts on the wrapper that is there after the body rendered, not one it saw before', async () => {
    let release;
    const manager = makeManager({
      ensureFileBodyRendered: vi.fn(() => new Promise((resolve) => { release = resolve; })),
    });
    const before = addWrapper('a.js', { collapsed: true });

    const expanding = manager.setFileCollapsed('a.js', false);
    // The diff is re-rendered meanwhile: a new wrapper replaces the old one.
    before.remove();
    const after = addWrapper('a.js', { collapsed: true });
    release();
    await expanding;

    expect(after.classList.contains('collapsed')).toBe(false);
    expect(before.classList.contains('collapsed')).toBe(true);
  });

  it('propagates a failing body render and leaves the file collapsed', async () => {
    const manager = makeManager({
      ensureFileBodyRendered: vi.fn(async () => { throw new Error('render failed'); }),
    });
    const wrapper = addWrapper('a.js', { collapsed: true });
    manager.collapsedFiles.add('a.js');

    await expect(manager.setFileCollapsed('a.js', false)).rejects.toThrow('render failed');
    expect(wrapper.classList.contains('collapsed')).toBe(true);
    expect(manager.collapsedFiles.has('a.js')).toBe(true);
  });
});

describe('a path that is not in the diff\'s own form', () => {
  // Navigation hands over the path a finding, a thread or a tour stop
  // carries. The server keeps a suggestion's path as the model wrote it, so
  // './src/a.js' reaches the page for the changed file 'src/a.js'. These
  // tests use the real file-element lookup, which accepts such forms.
  const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');

  function makeVariantManager(overrides = {}) {
    const bridge = { files: new Map([['src/a.js', {}]]), setCollapsed: vi.fn() };
    return makePageManager({
      pierreBridge: bridge,
      changedFilesByPath: new Map([['src/a.js', {}], ['src/unmounted.js', {}]]),
      findFileElement: (file) => DiffRenderer.findFileElement(file),
      ensureFileBodyRendered: vi.fn(async () => null),
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.spyOn(DiffRenderer, 'updateFileHeaderState').mockImplementation(() => {});
    window.DiffRenderer = DiffRenderer;
  });

  it.each([
    ['./src/a.js'],
    ['/src/a.js'],
    ['src/{b.js => a.js}'],
  ])('isFileCollapsed answers for %s as for the canonical path', (variant) => {
    const manager = makeVariantManager();
    const wrapper = addWrapper('src/a.js', { collapsed: true });
    expect(manager.isFileCollapsed(variant)).toBe(true);
    wrapper.classList.remove('collapsed');
    expect(manager.isFileCollapsed(variant)).toBe(false);
  });

  it.each([
    ['./src/a.js'],
    ['/src/a.js'],
    ['src/{b.js => a.js}'],
  ])('expanding through %s clears the state, the wrapper and the engine under the canonical path', async (variant) => {
    const manager = makeVariantManager();
    const wrapper = addWrapper('src/a.js', { collapsed: true });
    manager.collapsedFiles.add('src/a.js');

    await expect(manager.setFileCollapsed(variant, false)).resolves.toBe(true);

    expect(wrapper.classList.contains('collapsed')).toBe(false);
    expect([...manager.collapsedFiles]).toEqual([]);
    expect(manager.ensureFileBodyRendered).toHaveBeenCalledWith('src/a.js');
    expect(manager.pierreBridge.setCollapsed.mock.calls).toEqual([['src/a.js', false]]);
    expect(DiffRenderer.updateFileHeaderState).toHaveBeenCalledWith(wrapper.querySelector('.d2h-file-header'), true);
    // The next header click collapses it: one click, not two.
    await manager.toggleFileCollapse('src/a.js');
    expect(wrapper.classList.contains('collapsed')).toBe(true);
    expect(manager.pierreBridge.setCollapsed).toHaveBeenLastCalledWith('src/a.js', true);
  });

  it('collapsing through a variant writes the canonical path, never the variant', async () => {
    const manager = makeVariantManager();
    const wrapper = addWrapper('src/a.js');

    await expect(manager.setFileCollapsed('./src/a.js', true)).resolves.toBe(true);

    expect(wrapper.classList.contains('collapsed')).toBe(true);
    expect([...manager.collapsedFiles]).toEqual(['src/a.js']);
    expect(manager.pierreBridge.setCollapsed.mock.calls).toEqual([['src/a.js', true]]);
  });

  it('requests made under two forms of one path supersede each other', async () => {
    let release;
    const manager = makeVariantManager({
      ensureFileBodyRendered: vi.fn(() => new Promise((resolve) => { release = resolve; })),
    });
    const wrapper = addWrapper('src/a.js', { collapsed: true });
    manager.collapsedFiles.add('src/a.js');

    const expanding = manager.setFileCollapsed('./src/a.js', false);
    await expect(manager.setFileCollapsed('src/a.js', true)).resolves.toBe(true);
    release();

    await expect(expanding).resolves.toBe(false);
    expect(wrapper.classList.contains('collapsed')).toBe(true);
    expect(manager.collapsedFiles.has('src/a.js')).toBe(true);
    expect(manager.pierreBridge.setCollapsed.mock.calls).toEqual([['src/a.js', true]]);
  });

  it('resolves a variant of a file that has no wrapper from the list of changed files', async () => {
    const manager = makeVariantManager();
    expect(manager.isFileCollapsed('./src/unmounted.js')).toBe(false);
    await expect(manager.setFileCollapsed('./src/unmounted.js', true)).resolves.toBe(true);
    expect([...manager.collapsedFiles]).toEqual(['src/unmounted.js']);
    expect(manager.isFileCollapsed('/src/unmounted.js')).toBe(true);
    expect(manager.pierreBridge.setCollapsed).not.toHaveBeenCalled();
  });

  it('a variant of no file of the diff is refused', async () => {
    const manager = makeVariantManager();
    addWrapper('src/a.js', { collapsed: true });
    expect(manager.isFileCollapsed('./src/other.js')).toBeNull();
    await expect(manager.setFileCollapsed('./src/other.js', false)).resolves.toBe(false);
    expect(manager.pierreBridge.setCollapsed).not.toHaveBeenCalled();
  });

  it('_canonicalFilePath: the exact path, the wrapper\'s name, the changed-file list, else null', () => {
    const manager = makeVariantManager();
    expect(manager._canonicalFilePath('src/a.js')).toBe('src/a.js');
    expect(manager._canonicalFilePath('./src/unmounted.js')).toBe('src/unmounted.js');
    const context = addWrapper('lib/context-only.js');
    context.classList.add('context-file');
    expect(manager._canonicalFilePath('./lib/context-only.js')).toBe('lib/context-only.js');
    expect(manager._canonicalFilePath('./nowhere.js')).toBeNull();
    expect(manager._canonicalFilePath('')).toBeNull();
    expect(manager._canonicalFilePath(null)).toBeNull();
    expect(manager._canonicalFilePath(42)).toBeNull();
    expect(makePageManager({ changedFilesByPath: undefined })._canonicalFilePath('./a.js')).toBeNull();
  });
});

describe('the toggles go through setFileCollapsed', () => {
  it('toggleFileCollapse flips the state and does nothing for a path outside the diff', async () => {
    const manager = makeManager();
    const set = vi.spyOn(manager, 'setFileCollapsed');
    addWrapper('a.js');

    await manager.toggleFileCollapse('a.js');
    expect(set).toHaveBeenLastCalledWith('a.js', true);
    await manager.toggleFileCollapse('a.js');
    expect(set).toHaveBeenLastCalledWith('a.js', false);

    await manager.toggleFileCollapse('nowhere.js');
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('toggleFileViewed collapses on check, expands on uncheck, and skips a file already in that state', async () => {
    const manager = makeManager({
      updateFileItemViewedState: vi.fn(),
      saveViewedState: vi.fn(),
    });
    const set = vi.spyOn(manager, 'setFileCollapsed');
    const wrapper = addWrapper('a.js');

    await manager.toggleFileViewed('a.js', true);
    expect(manager.viewedFiles.has('a.js')).toBe(true);
    expect(wrapper.classList.contains('collapsed')).toBe(true);
    expect(set).toHaveBeenLastCalledWith('a.js', true);

    // Already collapsed: checking again writes nothing.
    await manager.toggleFileViewed('a.js', true);
    expect(set).toHaveBeenCalledTimes(1);

    await manager.toggleFileViewed('a.js', false);
    expect(manager.viewedFiles.has('a.js')).toBe(false);
    expect(wrapper.classList.contains('collapsed')).toBe(false);
    expect(set).toHaveBeenLastCalledWith('a.js', false);
    expect(manager.updateFileItemViewedState).toHaveBeenLastCalledWith('a.js', false);
    expect(manager.saveViewedState).toHaveBeenCalledTimes(3);
  });
});
