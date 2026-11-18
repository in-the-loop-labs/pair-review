// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * PRManager.ensureContextFile and lines a context file already shows.
 *
 * A context file that is an item of the virtualized viewer shows more than
 * its stored ranges: the lines the reader revealed with the separators'
 * controls, and gaps of five lines or fewer, which the viewer draws. A
 * request for such a line needs no new range. A line inside a stored range
 * goes through the range logic as before (covered, or extended to the
 * window around the line).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { makePageManager } = require('../utils/page-manager.js');

const FILE = 'lib/context.js';
const row = (id, line_start, line_end) => ({ id, file: FILE, line_start, line_end, label: null });

let manager;
let requests;

function setUp({ kind = 'context', visible = () => false, rows = [row(1, 100, 120)] } = {}) {
  requests = [];
  global.fetch = vi.fn(async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, status: options.method === 'POST' ? 201 : 200, json: async () => ({}) };
  });
  const files = new Map(kind ? [[FILE, { kind }]] : []);
  manager = makePageManager({
    contextFiles: rows,
    diffFiles: [{ file: 'src/in-the-diff.js' }],
    pierreBridge: { files, isLineVisible: vi.fn((file, line) => visible(line)) },
    loadContextFiles: vi.fn(async () => {}),
  });
}

afterEach(() => {
  delete global.fetch;
  vi.restoreAllMocks();
});

describe('ensureContextFile: a line a context item shows without a stored range', () => {
  beforeEach(() => setUp({ visible: (line) => line >= 121 && line <= 140 }));

  it('a line the reader revealed by hand: the file is answered, nothing is asked of the server', async () => {
    const result = await manager.ensureContextFile(FILE, 130);
    expect(result).toEqual({ type: 'context', contextFile: manager.contextFiles[0] });
    expect(requests).toEqual([]);
    expect(manager.loadContextFiles).not.toHaveBeenCalled();
    expect(manager.pierreBridge.isLineVisible).toHaveBeenCalledWith(FILE, 130, 'RIGHT');
  });

  it('a range: every line of it must be shown', async () => {
    expect(await manager.ensureContextFile(FILE, 125, 135)).toEqual({ type: 'context', contextFile: manager.contextFiles[0] });
    expect(requests).toEqual([]);
    // Its end is hidden: a range is added.
    await manager.ensureContextFile(FILE, 135, 160);
    expect(requests.map((r) => [r.method, r.body])).toEqual([['POST', { file: FILE, line_start: 135, line_end: 160 }]]);
  });

  it('a range whose two ends are shown and whose middle is hidden gets its range', async () => {
    // Two separate expansions: 121-125 and 136-140, with 126-135 hidden.
    setUp({ visible: (line) => (line >= 121 && line <= 125) || (line >= 136 && line <= 140) });
    await manager.ensureContextFile(FILE, 123, 138);
    expect(requests.map((r) => [r.method, r.body])).toEqual([['POST', { file: FILE, line_start: 123, line_end: 138 }]]);
    expect(manager.loadContextFiles).toHaveBeenCalledTimes(1);
    // The question stopped at the first hidden line.
    expect(manager.pierreBridge.isLineVisible.mock.calls.map((call) => call[1])).toEqual([123, 124, 125, 126]);
  });

  it('a range that is shown line for line is answered without a request, each line asked once', async () => {
    await manager.ensureContextFile(FILE, 122, 126);
    expect(requests).toEqual([]);
    expect(manager.pierreBridge.isLineVisible.mock.calls.map((call) => call[1])).toEqual([122, 123, 124, 125, 126]);
  });

  it('a line that is not shown gets its range, as before', async () => {
    await manager.ensureContextFile(FILE, 300);
    expect(requests.map((r) => [r.method, r.body])).toEqual([['POST', { file: FILE, line_start: 290, line_end: 310 }]]);
    expect(manager.loadContextFiles).toHaveBeenCalledTimes(1);
  });
});

describe('ensureContextFile: what the check leaves alone', () => {
  it('a line inside a stored range goes through the range logic: the row is extended to the window around the line', async () => {
    setUp({ visible: () => true });
    await manager.ensureContextFile(FILE, 118);
    // 108-128 is not covered by 100-120: the row is extended, shown or not.
    expect(requests.map((r) => [r.method, r.url, r.body])).toEqual([
      ['PATCH', '/api/reviews/1/context-files/1', { line_start: 100, line_end: 128 }],
    ]);
  });

  it('a context file the viewer has no item for (its contents did not load) is not asked about', async () => {
    setUp({ kind: null, visible: () => true });
    await manager.ensureContextFile(FILE, 130);
    expect(manager.pierreBridge.isLineVisible).not.toHaveBeenCalled();
    expect(requests.map((r) => r.method)).toEqual(['PATCH']);
  });

  it('a path that is a changed file answers "diff" before anything else', async () => {
    setUp({ visible: () => true });
    expect(await manager.ensureContextFile('src/in-the-diff.js', 5)).toEqual({ type: 'diff' });
    expect(requests).toEqual([]);
  });

  it('a file that is not in the pane yet is added whatever the bridge would say', async () => {
    setUp({ rows: [], visible: () => true });
    await manager.ensureContextFile(FILE, 130);
    expect(requests.map((r) => r.method)).toEqual(['POST']);
  });

  it('no line: the file is answered when it has a range, without a visibility question', async () => {
    setUp({ visible: () => true });
    expect(await manager.ensureContextFile(FILE)).toEqual({ type: 'context', contextFile: manager.contextFiles[0] });
    expect(manager.pierreBridge.isLineVisible).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});
