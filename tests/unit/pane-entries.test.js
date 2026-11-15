// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * The one ordered list of everything the diff pane shows on the virtualized
 * viewer (PRManager._buildPaneEntries), and the resolvers it rests on:
 * fileKind, _fileStateKey, _effectiveContextRange, countTextLines.
 *
 * All of it is data: no element, no bridge. What the viewer does with the
 * entries is tests/contract/bridge.
 */

import { describe, it, expect } from 'vitest';

const { makePageManager, PRManager } = require('../utils/page-manager.js');

const text = (count) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
const patchOf = (name) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n`;
const changed = (...names) => new Map(names.map((name) => [name, { file: name, patch: patchOf(name), status: 'modified' }]));
const row = (id, file, line_start, line_end, extra = {}) => ({ id, file, line_start, line_end, label: null, ...extra });

function makeManager(overrides = {}) {
  return makePageManager({
    _diffEngine: 'codeview',
    pierreBridge: { files: new Map() },
    generatedFiles: new Map(),
    ...overrides,
  });
}

function withContents(manager, contents) {
  let seq = 0;
  for (const [path, value] of Object.entries(contents)) manager._contextContents.set(path, { text: value, seq: ++seq });
  return manager;
}

describe('PRManager.countTextLines', () => {
  it('counts as an editor does: a final newline ends the last line', () => {
    expect(PRManager.countTextLines('one\ntwo\nthree\n')).toBe(3);
    expect(PRManager.countTextLines('one\ntwo\nthree')).toBe(3);
    expect(PRManager.countTextLines('one')).toBe(1);
    expect(PRManager.countTextLines('\n')).toBe(1);
    expect(PRManager.countTextLines('one\n\n')).toBe(2);
  });

  it('is 0 for empty contents and for what is not a text', () => {
    expect(PRManager.countTextLines('')).toBe(0);
    expect(PRManager.countTextLines(null)).toBe(0);
    expect(PRManager.countTextLines(undefined)).toBe(0);
  });
});

describe('PRManager._effectiveContextRange', () => {
  const range = (line_start, line_end, total) => makeManager()._effectiveContextRange({ line_start, line_end }, total);

  it('is the stored range when the file has those lines', () => {
    expect(range(100, 120, 240)).toEqual({ startLine: 100, endLine: 120 });
    expect(range(1, 30, 30)).toEqual({ startLine: 1, endLine: 30 });
  });

  it('moves a range that runs past the end of the file up, keeping its size', () => {
    // 21 lines asked for from line 25 of a 30-line file: 10-30.
    expect(range(25, 45, 30)).toEqual({ startLine: 10, endLine: 30 });
    // Starting past the end entirely.
    expect(range(40, 49, 30)).toEqual({ startLine: 21, endLine: 30 });
  });

  it('stops at line 1 when the file is shorter than the range', () => {
    expect(range(5, 104, 30)).toEqual({ startLine: 1, endLine: 30 });
    expect(range(1, 100, 30)).toEqual({ startLine: 1, endLine: 30 });
  });

  it('is null for an empty file and for a row that is not a range', () => {
    expect(range(1, 100, 0)).toBeNull();
    expect(makeManager()._effectiveContextRange({ line_start: 'x', line_end: 3 }, 10)).toBeNull();
    expect(makeManager()._effectiveContextRange(null, 10)).toBeNull();
  });
});

describe('PRManager.fileKind and _fileStateKey', () => {
  it('a changed file is "diff" and keyed by its path, whatever else names it', () => {
    const manager = makeManager({
      changedFilesByPath: changed('src/a.js'),
      contextFiles: [row(1, 'src/a.js', 1, 10)],
    });
    manager._contextItemIds.add('src/a.js');
    expect(manager.fileKind('src/a.js')).toBe('diff');
    expect(manager._fileStateKey('src/a.js')).toBe('src/a.js');
  });

  it('a context file is "context" from its rows, from the pane\'s items, or from the bridge\'s record', () => {
    const fromRows = makeManager({ contextFiles: [row(1, 'ctx/a.js', 1, 10)] });
    expect(fromRows.fileKind('ctx/a.js')).toBe('context');
    expect(fromRows._fileStateKey('ctx/a.js')).toBe('context:ctx/a.js');

    const fromItems = makeManager();
    fromItems._contextItemIds.add('ctx/b.js');
    expect(fromItems.fileKind('ctx/b.js')).toBe('context');

    const fromRecord = makeManager({ pierreBridge: { files: new Map([['ctx/c.js', { kind: 'context' }]]) } });
    expect(fromRecord.fileKind('ctx/c.js')).toBe('context');
  });

  it('a path the pane does not have is null, and keyed as a plain path', () => {
    const manager = makeManager({ changedFilesByPath: changed('src/a.js') });
    expect(manager.fileKind('nowhere.js')).toBeNull();
    expect(manager.fileKind('')).toBeNull();
    expect(manager._fileStateKey('nowhere.js')).toBe('nowhere.js');
  });

  it('a record of the default engine (no kind) does not make a path a file of the pane', () => {
    const manager = makeManager({ pierreBridge: { files: new Map([['x.js', { instance: {} }]]) } });
    expect(manager.fileKind('x.js')).toBeNull();
  });
});

describe('PRManager._buildPaneEntries', () => {
  const ids = (entries) => entries.map((entry) => `${entry.kind}:${entry.id}`);

  it('lists the changed files in diff order and each context file before the first entry that sorts after it', () => {
    const manager = withContents(makeManager({
      // Diff order is not path order.
      changedFilesByPath: changed('src/main.js', 'src/utils.js', 'lib/z.js'),
      // Rows arrive in any order; several rows of one file are one entry.
      contextFiles: [
        row(3, 'zz/last.js', 1, 5), row(1, 'src/notes.js', 1, 5), row(2, 'corpus/long.js', 1, 5), row(4, 'src/notes.js', 20, 25),
      ],
    }), { 'zz/last.js': text(30), 'src/notes.js': text(30), 'corpus/long.js': text(30) });

    expect(ids(manager._buildPaneEntries())).toEqual([
      'context:corpus/long.js',
      'diff:src/main.js',
      'context:src/notes.js',
      'diff:src/utils.js',
      // 'lib/z.js' sorts before every context path that is left: nothing goes before it.
      'diff:lib/z.js',
      'context:zz/last.js',
    ]);
  });

  it('gives the same list whatever order the rows arrive in', () => {
    const rows = [row(1, 'b/two.js', 1, 5), row(2, 'a/one.js', 1, 5), row(3, 'c/three.js', 1, 5)];
    const contents = { 'a/one.js': text(9), 'b/two.js': text(9), 'c/three.js': text(9) };
    const build = (order) => ids(withContents(makeManager({
      changedFilesByPath: changed('b/changed.js'),
      contextFiles: order.map((i) => rows[i]),
    }), contents)._buildPaneEntries());
    expect(build([0, 1, 2])).toEqual(build([2, 1, 0]));
    expect(build([1, 2, 0])).toEqual(['context:a/one.js', 'diff:b/changed.js', 'context:b/two.js', 'context:c/three.js']);
  });

  it('the diff wins: a context row whose path is a changed file gets no entry, and stays stored', () => {
    const manager = withContents(makeManager({
      changedFilesByPath: changed('src/a.js'),
      contextFiles: [row(1, 'src/a.js', 1, 10), row(2, 'src/b.js', 1, 10)],
    }), { 'src/a.js': text(30), 'src/b.js': text(30) });
    expect(ids(manager._buildPaneEntries())).toEqual(['diff:src/a.js', 'context:src/b.js']);
    expect(manager.contextFiles).toHaveLength(2);
  });

  it('a context path whose contents the page does not hold gets no entry', () => {
    const manager = withContents(makeManager({
      changedFilesByPath: changed('src/a.js'),
      contextFiles: [row(1, 'gone.js', 1, 10), row(2, 'there.js', 1, 10)],
    }), { 'there.js': text(12) });
    expect(ids(manager._buildPaneEntries())).toEqual(['diff:src/a.js', 'context:there.js']);
  });

  it('a context entry carries its contents, their sequence number and its effective ranges', () => {
    const manager = makeManager({ contextFiles: [row(1, 'ctx.js', 25, 45), row(2, 'ctx.js', 2, 4)] });
    manager._contextContents.set('ctx.js', { text: `${text(30)}\n`, seq: 7 });
    expect(manager._buildPaneEntries()).toEqual([{
      id: 'ctx.js',
      kind: 'context',
      contents: `${text(30)}\n`,
      contentsSeq: 7,
      // 30 lines (the final newline starts no line): 25-45 becomes 10-30.
      ranges: [{ startLine: 10, endLine: 30 }, { startLine: 2, endLine: 4 }],
      collapsed: false,
    }]);
  });

  it('an empty context file has an entry without ranges (a header-only item)', () => {
    const manager = makeManager({ contextFiles: [row(1, 'empty.txt', 1, 100)] });
    manager._contextContents.set('empty.txt', { text: '', seq: 1 });
    expect(manager._buildPaneEntries()[0].ranges).toEqual([]);
  });

  describe('collapsed state', () => {
    it('seeds a changed file as collapsed when it is generated, viewed or was collapsed by the reader', () => {
      const files = changed('gen.js', 'viewed.js', 'folded.js', 'open.js');
      files.get('gen.js').generated = true;
      const manager = makeManager({
        changedFilesByPath: files,
        viewedFiles: new Set(['viewed.js']),
        collapsedFiles: new Set(['folded.js']),
      });
      manager._fileCollapsed.clear();
      const entries = manager._buildPaneEntries();
      expect(entries.map((entry) => [entry.id, entry.collapsed])).toEqual([
        ['gen.js', true], ['viewed.js', true], ['folded.js', true], ['open.js', false],
      ]);
      expect(manager.isFileCollapsed('gen.js')).toBe(true);
      expect(manager.isFileCollapsed('open.js')).toBe(false);
    });

    it('seeds once: a generated file the reader expanded stays expanded when the entries are built again', async () => {
      const files = changed('gen.js');
      files.get('gen.js').generated = true;
      const manager = makeManager({ changedFilesByPath: files, ensureFileBodyRendered: async () => null });
      manager._fileCollapsed.clear();
      expect(manager._buildPaneEntries()[0].collapsed).toBe(true);
      await manager.setFileCollapsed('gen.js', false);
      expect(manager._buildPaneEntries()[0].collapsed).toBe(false);
    });

    it('seeds a context file from its own keys, never from the changed-file key of the same path', () => {
      const manager = withContents(makeManager({
        contextFiles: [row(1, 'a.js', 1, 5), row(2, 'b.js', 1, 5), row(3, 'c.js', 1, 5)],
        viewedFiles: new Set(['context:a.js', 'c.js']),
        collapsedFiles: new Set(['context:b.js']),
      }), { 'a.js': text(9), 'b.js': text(9), 'c.js': text(9) });
      const entries = manager._buildPaneEntries();
      expect(entries.map((entry) => [entry.id, entry.collapsed])).toEqual([['a.js', true], ['b.js', true], ['c.js', false]]);
      expect([...manager._fileCollapsed.keys()]).toEqual(['context:a.js', 'context:b.js', 'context:c.js']);
    });
  });

  describe('a changed file\'s entry', () => {
    it('carries the patch, the status and the render decision', () => {
      const manager = makeManager({ changedFilesByPath: changed('src/a.js') });
      expect(manager._buildPaneEntries()).toEqual([{
        id: 'src/a.js', kind: 'diff', patch: patchOf('src/a.js'), status: 'modified',
        collapsed: false, forcePlainText: false, deferred: false,
      }]);
    });

    it('a binary file and a file without a patch are entries without lines, and without a notice', () => {
      const files = new Map([
        ['image.png', { file: 'image.png', binary: true, patch: 'Binary files differ' }],
        ['mode.sh', { file: 'mode.sh', patch: null }],
      ]);
      const entries = makeManager({ changedFilesByPath: files })._buildPaneEntries();
      expect(entries.map(({ id, patch, deferred, notice }) => ({ id, patch, deferred, notice }))).toEqual([
        { id: 'image.png', patch: null, deferred: false, notice: undefined },
        { id: 'mode.sh', patch: null, deferred: false, notice: undefined },
      ]);
    });

    it('a patch over the automatic limit is deferred, with the notice that offers to load it', () => {
      const big = `${patchOf('big.js')}${'+x\n'.repeat(PRManager.PIERRE_AUTO_RENDER_MAX_PATCH_LINES + 10)}`;
      const manager = makeManager({ changedFilesByPath: new Map([['big.js', { file: 'big.js', patch: big }]]) });
      const [entry] = manager._buildPaneEntries();
      expect(entry.deferred).toBe(true);
      expect(entry.notice).toEqual({ kind: 'large-diff', chars: big.length, lines: big.split('\n').length });
    });

    it('a patch over the per-file highlight limit is plain text; there is no budget across files', () => {
      const lines = PRManager.PIERRE_HIGHLIGHT_MAX_PATCH_LINES + 10;
      const large = `${patchOf('large.js')}${'+x\n'.repeat(lines)}`;
      const files = new Map([['large.js', { file: 'large.js', patch: large }]]);
      for (let i = 0; i < 40; i++) files.set(`f${i}.js`, { file: `f${i}.js`, patch: `${patchOf(`f${i}.js`)}${'+y\n'.repeat(Math.floor(lines / 2))}` });
      const entries = makeManager({ changedFilesByPath: files })._buildPaneEntries();
      expect(entries[0]).toMatchObject({ id: 'large.js', forcePlainText: true, deferred: false });
      // Forty files of half the per-file limit each: far more than the old
      // total budget, and every one of them is highlighted (decision D3).
      expect(entries.slice(1).every((entry) => entry.forcePlainText === false)).toBe(true);
    });
  });
});
