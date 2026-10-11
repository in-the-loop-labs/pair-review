// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The browser reads paths straight out of the diff text, so it must key files
// exactly like the server. Both load the same module
// (public/js/utils/git-paths.js); these tests drive the browser consumers
// with the shared fixtures and compare against the server's parse.
const GitPaths = require('../../public/js/utils/git-paths.js');
const { parseUnifiedDiffPatches } = require('../../src/utils/diff-file-list');
const {
  DIFF_HEADER_CASES,
  QUOTEPATH_FALSE_DIFF,
  QUOTEPATH_TRUE_DIFF,
  B_SLASH_RENAME_DIFF
} = require('../utils/git-path-fixtures');

describe('PRManager.parseUnifiedDiff', () => {
  // PRManager is browser code; load it in a vm sandbox (see
  // pr-manager-diff-view.test.js) with the real GitPaths module installed the
  // way pr.html / local.html install it.
  function loadPRManager() {
    const code = fs.readFileSync(path.join(__dirname, '../../public/js/pr.js'), 'utf8');
    const sandbox = {
      document: { addEventListener() {} },
      console,
      localStorage: { getItem() { return null; }, setItem() {} },
      fetch: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
      navigator: { clipboard: {} },
      setTimeout,
      clearTimeout,
      URLSearchParams,
      GitPaths,
      module: { exports: {} }
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.window = sandbox;
    vm.runInContext(code, vm.createContext(sandbox), { filename: 'pr.js' });
    return sandbox.module.exports.PRManager;
  }

  it.each([
    ['core.quotePath=false', QUOTEPATH_FALSE_DIFF],
    ['core.quotePath=true (cached)', QUOTEPATH_TRUE_DIFF],
    ['renames out of " b/" paths', B_SLASH_RENAME_DIFF]
  ])('keys patches by the decoded new path, matching the server (%s)', (_label, diff) => {
    const PRManager = loadPRManager();
    const patches = PRManager.prototype.parseUnifiedDiff.call({}, diff);
    const serverPatches = parseUnifiedDiffPatches(diff);

    expect([...patches.keys()]).toEqual([...serverPatches.keys()]);
    for (const [file, patch] of serverPatches) {
      expect(patches.get(file)).toBe(patch);
    }
  });

  it('keys quote, rename and " b/" names by their real spelling', () => {
    const PRManager = loadPRManager();
    const patches = PRManager.prototype.parseUnifiedDiff.call({}, QUOTEPATH_FALSE_DIFF);

    expect(patches.has('quo"te.js')).toBe(true);
    expect(patches.has('x b/y.js')).toBe(true);
    expect(patches.has('a => b.md')).toBe(true);
    expect(patches.has('totally/different.txt')).toBe(true);
    expect(patches.get('quo"te.js')).toMatch(/^diff --git "a\/quo\\"te\.js"/);
  });

  it('keys a rename out of a path containing " b/" by its rename to path', () => {
    const PRManager = loadPRManager();
    const patches = PRManager.prototype.parseUnifiedDiff.call({}, B_SLASH_RENAME_DIFF);
    expect([...patches.keys()]).toEqual(['r b/s.js', 'z.js']);
  });

  it('keys every fixture header by its decoded new path', () => {
    const PRManager = loadPRManager();
    for (const [header, , newPath] of DIFF_HEADER_CASES) {
      const patches = PRManager.prototype.parseUnifiedDiff.call({}, `${header}\n@@ -1 +1 @@\n-a\n+b\n`);
      expect([...patches.keys()]).toEqual([newPath]);
    }
  });

  it('returns an empty map for an empty diff', () => {
    const PRManager = loadPRManager();
    expect(PRManager.prototype.parseUnifiedDiff.call({}, '').size).toBe(0);
  });
});

describe('PierreBridge.parsePatch', () => {
  const BRIDGE_PATH = '../../public/js/modules/pierre-bridge.js';
  let parsePatchFiles;

  beforeAll(async () => {
    // The real @pierre/diffs parser (the vendor bundle is built from it).
    ({ parsePatchFiles } = await import('../../node_modules/@pierre/diffs/dist/utils/parsePatchFiles.js'));
  });

  function loadBridge({ withGitPaths = true } = {}) {
    delete require.cache[require.resolve(BRIDGE_PATH)];
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    global.document = dom.window.document;
    global.window = {
      PierreDiffs: { parsePatchFiles, getSingularPatch: () => null },
      ...(withGitPaths ? { GitPaths } : {}),
      matchMedia: () => ({ matches: false })
    };
    global.requestAnimationFrame = () => {};
    const PierreBridge = require(BRIDGE_PATH);
    return new PierreBridge({});
  }

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.requestAnimationFrame;
  });

  it('reports the decoded name for a header git quoted', () => {
    const bridge = loadBridge();
    const patch = parseUnifiedDiffPatches(QUOTEPATH_FALSE_DIFF).get('quo"te.js');

    const metadata = bridge.parsePatch(patch);
    expect(metadata.name).toBe('quo"te.js');
    expect(metadata.prevName).toBeUndefined();
    expect(metadata.hunks).toHaveLength(1);
  });

  it('reports the whole name for a path containing " b/"', () => {
    const bridge = loadBridge();
    const patch = parseUnifiedDiffPatches(QUOTEPATH_FALSE_DIFF).get('x b/y.js');
    expect(bridge.parsePatch(patch).name).toBe('x b/y.js');
  });

  it('reports decoded new and old names for a rename cached with octal escapes', () => {
    const bridge = loadBridge();
    const patch = parseUnifiedDiffPatches(QUOTEPATH_TRUE_DIFF).get('ñew dir/moved é.js');

    const metadata = bridge.parsePatch(patch);
    expect(metadata.name).toBe('ñew dir/moved é.js');
    expect(metadata.prevName).toBe('lib/moved.js');
  });

  it('reports the rename lines\' names for a rename out of a path containing " b/"', () => {
    const bridge = loadBridge();
    const patch = parseUnifiedDiffPatches(B_SLASH_RENAME_DIFF).get('z.js');

    const metadata = bridge.parsePatch(patch);
    expect(metadata.name).toBe('z.js');
    expect(metadata.prevName).toBe('x b/y.js');
    expect(metadata.hunks).toHaveLength(1);
  });

  it('leaves bare hunk content to the caller-supplied name', () => {
    const bridge = loadBridge();
    const metadata = bridge.parsePatch('@@ -1 +1 @@\n-a\n+b\n');
    expect(metadata.name).toBe('file');
    expect(metadata.hunks).toHaveLength(1);
  });

  it('falls back to Pierre\'s own names when GitPaths is not loaded', () => {
    const bridge = loadBridge({ withGitPaths: false });
    const patch = parseUnifiedDiffPatches(QUOTEPATH_FALSE_DIFF).get('café.js');
    expect(bridge.parsePatch(patch).name).toBe('café.js');
  });
});
