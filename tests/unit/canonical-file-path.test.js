// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * PRManager._canonicalFilePath: the path the diff pane knows a file by, for
 * a path in another form (a finding's './src/a.js', a thread's '/src/a.js',
 * git rename syntax). It is the bridge's `resolvePath` hook and the first
 * step of isFileCollapsed, setFileCollapsed, scrollToFile,
 * scrollToContextFile and _revealLines. Under the virtualized viewer a file
 * that is scrolled away has no element, so the answer must come from data
 * and be the same wherever the reader is.
 *
 * The page manager and its bridge are production code wired by the page's
 * own _createBridge (tests/utils/page-bridge.js); `findFileElement` is the
 * page's own (DiffRenderer.findFileElement over the document), and a file
 * "is mounted" when its element is in the document, as the viewer leaves
 * it.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';

const { makePageWithBridge, restorePageBridges } = require('../utils/page-bridge.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});

afterEach(() => {
  restorePageBridges();
  document.body.innerHTML = '';
});

const patchOf = (name) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n`;

/** A page with these changed files and context files; nothing mounted. */
function page({ files = [], contextFiles = [] } = {}) {
  const built = makePageWithBridge(vendor, {
    files: files.map((name) => ({ name, patch: patchOf(name) })),
    contextFiles: contextFiles.map((name) => ({ name, contents: 'a\nb\nc\n' })),
  });
  // The page's own lookup of a file's element (makePageManager stubs it).
  delete built.manager.findFileElement;
  return built;
}

/** The element the viewer gives a mounted file (its host carries the file's path). */
function mount(name, { context = false } = {}) {
  const host = document.createElement('div');
  host.className = context ? 'd2h-file-wrapper context-file' : 'd2h-file-wrapper';
  host.dataset.fileName = name;
  document.body.appendChild(host);
  return host;
}

describe('_canonicalFilePath answers from data', () => {
  it('two files share a suffix and only the other one is mounted: a form of the first names the first', () => {
    const { manager } = page({ files: ['src/index.js', 'packages/x/src/index.js'] });
    mount('packages/x/src/index.js');

    expect(manager._canonicalFilePath('./src/index.js')).toBe('src/index.js');
    expect(manager._canonicalFilePath('/src/index.js')).toBe('src/index.js');
    expect(manager._canonicalFilePath('./packages/x/src/index.js')).toBe('packages/x/src/index.js');
  });

  it('...and so the collapse a finding asks for goes to the file it names', async () => {
    const { manager, bridge } = page({ files: ['src/index.js', 'packages/x/src/index.js'] });
    mount('packages/x/src/index.js');

    expect(await manager.setFileCollapsed('./src/index.js', true)).toBe(true);

    expect(manager.isFileCollapsed('src/index.js')).toBe(true);
    expect(manager.isFileCollapsed('packages/x/src/index.js')).toBe(false);
    expect(bridge.files.get('src/index.js').collapsed).toBe(true);
    expect(bridge.files.get('packages/x/src/index.js').collapsed).toBe(false);
  });

  it('an exact match after normalizing wins over a suffix match, in either list order', () => {
    const { manager } = page({ files: ['packages/x/src/index.js', 'src/index.js'] });
    expect(manager._canonicalFilePath('./src/index.js')).toBe('src/index.js');
    expect(manager._canonicalFilePath('src//index.js')).toBe('src/index.js');
  });

  it('a context file named in another form is found whether or not it is mounted', () => {
    const { manager } = page({ files: ['src/a.js'], contextFiles: ['lib/x.js'] });
    expect(manager._canonicalFilePath('./lib/x.js')).toBe('lib/x.js');
    expect(manager.isFileCollapsed('./lib/x.js')).toBe(false);

    mount('lib/x.js', { context: true });
    expect(manager._canonicalFilePath('./lib/x.js')).toBe('lib/x.js');
  });

  it('the bridge resolves a context file in a form its own fallback does not know, with the file unmounted', () => {
    const { bridge } = page({ files: ['src/a.js'], contextFiles: ['lib/x.js'] });
    expect(bridge.resolveFileId('/./lib/x.js')).toBe('lib/x.js');
    expect(bridge.resolveFileId('/./src/a.js')).toBe('src/a.js');
  });

  it('a longer path that ends with a file of the pane (a model\'s absolute path) names that file', () => {
    const { manager } = page({ files: ['src/a.js'], contextFiles: ['lib/x.js'] });
    expect(manager._canonicalFilePath('/home/me/repo/src/a.js')).toBe('src/a.js');
    expect(manager._canonicalFilePath('/home/me/repo/lib/x.js')).toBe('lib/x.js');
  });

  it('git rename syntax names the new path', () => {
    const { manager } = page({ files: ['src/new.js'] });
    expect(manager._canonicalFilePath('src/{old => new}.js')).toBe('src/new.js');
  });

  it('a path that is no file of the pane is null, mounted elements or not', () => {
    const { manager } = page({ files: ['src/a.js'] });
    mount('src/a.js');
    expect(manager._canonicalFilePath('src/b.js')).toBeNull();
    expect(manager._canonicalFilePath('')).toBeNull();
    expect(manager._canonicalFilePath(null)).toBeNull();
    expect(manager._canonicalFilePath(42)).toBeNull();
  });
});
