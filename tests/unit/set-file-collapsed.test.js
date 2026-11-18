// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * PRManager.setFileCollapsed is the single writer of a file's collapsed
 * state, and isFileCollapsed the single reader. The header chevron, the
 * Viewed checkbox, the review panel, the suggestion navigator and the tour
 * all go through them.
 *
 * The state is data (`_fileCollapsed`, seeded when a file is rendered): a
 * file is collapsed because it is generated, viewed or was collapsed by the
 * reader, and it need not have an element. setFileCollapsed writes the data,
 * the file's cached header and the viewer's item; the `collapsed` class of
 * the file's element is stamped by the viewer's bridge from the item and is
 * never read or written by the page.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { makePageManager } = require('../utils/page-manager.js');

function addWrapper(fileName, { collapsed = false } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = `d2h-file-wrapper${collapsed ? ' collapsed' : ''}`;
  wrapper.dataset.fileName = fileName;
  document.body.appendChild(wrapper);
  return wrapper;
}

/** A file as a render leaves it: its collapsed state in the manager's data, its cached header, and (on screen) its element. */
function addRenderedFile(manager, fileName, { collapsed = false } = {}) {
  manager._fileCollapsed.set(fileName, collapsed);
  const header = document.createElement('div');
  header.className = 'd2h-file-header';
  manager._fileHeaders.set(fileName, header);
  const wrapper = addWrapper(fileName, { collapsed });
  wrapper.header = header;
  return wrapper;
}

function makeManager(overrides = {}) {
  const bridge = { files: new Map([['a.js', {}]]), setCollapsed: vi.fn() };
  return makePageManager({
    pierreBridge: bridge,
    changedFilesByPath: new Map([['a.js', {}], ['unmounted.js', {}]]),
    findFileElement: (file) => document.querySelector(`.d2h-file-wrapper[data-file-name="${file}"]`),
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
  it('answers from data, whatever made the file collapsed', async () => {
    const manager = makeManager();
    // A generated or viewed file is rendered collapsed without being in collapsedFiles.
    addRenderedFile(manager, 'a.js', { collapsed: true });
    expect(manager.collapsedFiles.has('a.js')).toBe(false);
    expect(manager.isFileCollapsed('a.js')).toBe(true);
    // The reader expands it: the answer changes although no set says so.
    await manager.setFileCollapsed('a.js', false);
    expect(manager.collapsedFiles.has('a.js')).toBe(false);
    expect(manager.isFileCollapsed('a.js')).toBe(false);
    expect(manager.pierreBridge.setCollapsed).toHaveBeenLastCalledWith('a.js', false);
  });

  it('never reads an element: a class on the wrapper does not answer', () => {
    const manager = makeManager();
    const wrapper = addRenderedFile(manager, 'a.js', { collapsed: false });
    wrapper.classList.add('collapsed');
    expect(manager.isFileCollapsed('a.js')).toBe(false);
    manager._fileCollapsed.set('a.js', true);
    wrapper.classList.remove('collapsed');
    expect(manager.isFileCollapsed('a.js')).toBe(true);
  });

  it('answers for a file of the diff that has no wrapper, and such a file can be collapsed', async () => {
    const manager = makeManager();
    expect(manager.isFileCollapsed('unmounted.js')).toBe(false);
    await expect(manager.setFileCollapsed('unmounted.js', true)).resolves.toBe(true);
    expect(manager.isFileCollapsed('unmounted.js')).toBe(true);
    expect(manager.collapsedFiles.has('unmounted.js')).toBe(true);
  });

  it('keys a context file by its own state key, never by the bare path', async () => {
    const manager = makeManager({ contextFiles: [{ id: 1, file: 'ctx.js', line_start: 1, line_end: 5 }] });
    manager._fileCollapsed.set('context:ctx.js', false);
    expect(manager.fileKind('ctx.js')).toBe('context');
    expect(manager.isFileCollapsed('ctx.js')).toBe(false);
    await expect(manager.setFileCollapsed('ctx.js', true)).resolves.toBe(true);
    expect(manager.isFileCollapsed('ctx.js')).toBe(true);
    expect([...manager.collapsedFiles]).toEqual(['context:ctx.js']);
    expect(manager._fileCollapsed.has('ctx.js')).toBe(false);
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
  it('collapses: state, header and the viewer\'s item; the element\'s class is the viewer\'s to write', async () => {
    const manager = makeManager();
    const wrapper = addRenderedFile(manager, 'a.js');

    await expect(manager.setFileCollapsed('a.js', true)).resolves.toBe(true);

    expect(manager.collapsedFiles.has('a.js')).toBe(true);
    expect(manager.isFileCollapsed('a.js')).toBe(true);
    expect(window.DiffRenderer.updateFileHeaderState).toHaveBeenCalledWith(wrapper.header, false);
    expect(manager.pierreBridge.setCollapsed.mock.calls).toEqual([['a.js', true]]);
    expect(wrapper.classList.contains('collapsed')).toBe(false);
  });

  it('expands: state, header and the viewer\'s item', async () => {
    const manager = makeManager();
    manager.collapsedFiles.add('a.js');
    const wrapper = addRenderedFile(manager, 'a.js', { collapsed: true });

    await expect(manager.setFileCollapsed('a.js', false)).resolves.toBe(true);

    expect(manager.collapsedFiles.has('a.js')).toBe(false);
    expect(manager.isFileCollapsed('a.js')).toBe(false);
    expect(window.DiffRenderer.updateFileHeaderState).toHaveBeenCalledWith(wrapper.header, true);
    expect(manager.pierreBridge.setCollapsed.mock.calls).toEqual([['a.js', false]]);
  });

  it('writes everything before it returns: the state is there without awaiting the call', () => {
    const manager = makeManager();
    addRenderedFile(manager, 'a.js', { collapsed: true });
    manager.collapsedFiles.add('a.js');

    const expanding = manager.setFileCollapsed('a.js', false);
    // A second request in the same task (the reader marks the file viewed) is the last word.
    const collapsing = manager.setFileCollapsed('a.js', true);

    expect(manager.isFileCollapsed('a.js')).toBe(true);
    expect(manager.pierreBridge.setCollapsed.mock.calls).toEqual([['a.js', false], ['a.js', true]]);
    return Promise.all([expanding, collapsing]).then((results) => {
      expect(results).toEqual([true, true]);
      expect(manager.isFileCollapsed('a.js')).toBe(true);
      expect(manager.collapsedFiles.has('a.js')).toBe(true);
    });
  });

  it('is idempotent: setting the state a file already has leaves it there', async () => {
    const manager = makeManager();
    addRenderedFile(manager, 'a.js', { collapsed: true });
    await manager.setFileCollapsed('a.js', true);
    await manager.setFileCollapsed('a.js', true);
    expect(manager.isFileCollapsed('a.js')).toBe(true);
    expect(manager.collapsedFiles.has('a.js')).toBe(true);
  });

  it('a file with no header yet (never drawn) is written in data and in the viewer\'s item', async () => {
    const manager = makeManager();
    await expect(manager.setFileCollapsed('a.js', true)).resolves.toBe(true);
    expect(manager.isFileCollapsed('a.js')).toBe(true);
    expect(window.DiffRenderer.updateFileHeaderState).not.toHaveBeenCalled();
    expect(manager.pierreBridge.setCollapsed.mock.calls).toEqual([['a.js', true]]);
  });

  it('writes the state of a file of the diff the viewer has no record of, and leaves the viewer alone', async () => {
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
    addRenderedFile(manager, 'src/a.js', { collapsed: true });
    expect(manager.isFileCollapsed(variant)).toBe(true);
    manager._fileCollapsed.set('src/a.js', false);
    expect(manager.isFileCollapsed(variant)).toBe(false);
  });

  it.each([
    ['./src/a.js'],
    ['/src/a.js'],
    ['src/{b.js => a.js}'],
  ])('expanding through %s clears the state, the header and the viewer\'s item under the canonical path', async (variant) => {
    const manager = makeVariantManager();
    const wrapper = addRenderedFile(manager, 'src/a.js', { collapsed: true });
    manager.collapsedFiles.add('src/a.js');

    await expect(manager.setFileCollapsed(variant, false)).resolves.toBe(true);

    expect([...manager.collapsedFiles]).toEqual([]);
    expect(manager.isFileCollapsed('src/a.js')).toBe(false);
    expect(manager.pierreBridge.setCollapsed.mock.calls).toEqual([['src/a.js', false]]);
    expect(DiffRenderer.updateFileHeaderState).toHaveBeenCalledWith(wrapper.header, true);
    // The next header click collapses it: one click, not two.
    await manager.toggleFileCollapse('src/a.js');
    expect(manager.isFileCollapsed(variant)).toBe(true);
    expect(manager.pierreBridge.setCollapsed).toHaveBeenLastCalledWith('src/a.js', true);
  });

  it('collapsing through a variant writes the canonical path, never the variant', async () => {
    const manager = makeVariantManager();
    addRenderedFile(manager, 'src/a.js');

    await expect(manager.setFileCollapsed('./src/a.js', true)).resolves.toBe(true);

    expect([...manager.collapsedFiles]).toEqual(['src/a.js']);
    expect([...manager._fileCollapsed.keys()]).toEqual(expect.arrayContaining(['src/a.js']));
    expect(manager._fileCollapsed.has('./src/a.js')).toBe(false);
    expect(manager.pierreBridge.setCollapsed.mock.calls).toEqual([['src/a.js', true]]);
  });

  it('requests made under two forms of one path address one state: the last one stands', async () => {
    const manager = makeVariantManager();
    addRenderedFile(manager, 'src/a.js', { collapsed: true });
    manager.collapsedFiles.add('src/a.js');

    const expanding = manager.setFileCollapsed('./src/a.js', false);
    const collapsing = manager.setFileCollapsed('src/a.js', true);

    await expect(expanding).resolves.toBe(true);
    await expect(collapsing).resolves.toBe(true);
    expect(manager.isFileCollapsed('/src/a.js')).toBe(true);
    expect([...manager.collapsedFiles]).toEqual(['src/a.js']);
    expect(manager.pierreBridge.setCollapsed.mock.calls).toEqual([['src/a.js', false], ['src/a.js', true]]);
  });

  it('resolves a variant of a file that has no element from the list of changed files', async () => {
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
    addRenderedFile(manager, 'a.js');

    await manager.toggleFileViewed('a.js', true);
    expect(manager.viewedFiles.has('a.js')).toBe(true);
    expect(manager.isFileCollapsed('a.js')).toBe(true);
    expect(set).toHaveBeenLastCalledWith('a.js', true);

    // Already collapsed: checking again writes nothing.
    await manager.toggleFileViewed('a.js', true);
    expect(set).toHaveBeenCalledTimes(1);

    await manager.toggleFileViewed('a.js', false);
    expect(manager.viewedFiles.has('a.js')).toBe(false);
    expect(manager.isFileCollapsed('a.js')).toBe(false);
    expect(set).toHaveBeenLastCalledWith('a.js', false);
    expect(manager.updateFileItemViewedState).toHaveBeenLastCalledWith('a.js', false);
    expect(manager.saveViewedState).toHaveBeenCalledTimes(3);
  });
});
