// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const BRIDGE_PATH = '../../public/js/modules/pierre-bridge.js';
const HUNK_PARSER_PATH = '../../public/js/modules/hunk-parser.js';

// Coverage for eliminating the double patch parse: renderFile parses the patch
// once (parsePatchFiles → Pierre metadata) and computeDiffPositions derives the
// diffPosition map from that metadata's ordered hunkContent instead of parsing
// the same patch a SECOND time with HunkParser. The derivation must be byte-for
// -byte identical to the raw-patch walk, and must fall back to raw parsing when
// metadata lacks hunkContent.

// One representative mixed hunk (context + change + context) and its metadata.
const PATCH = '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n';
const METADATA = {
  name: 'a.js',
  hunks: [{
    deletionStart: 1,
    additionStart: 1,
    hunkContent: [
      { type: 'context', lines: 1 },
      { type: 'change', deletions: 1, additions: 1 },
      { type: 'context', lines: 1 },
    ],
  }],
};
// diffPosition counter: header=1, ' a'=2, '-b'=3, '+B'=4, ' c'=5.
const EXPECTED = new Map([
  ['RIGHT:1', 2], ['LEFT:1', 2],
  ['LEFT:2', 3],
  ['RIGHT:2', 4],
  ['RIGHT:3', 5], ['LEFT:3', 5],
]);

function mapsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

describe('PierreBridge.computeDiffPositions metadata derivation', () => {
  let PierreBridge;
  let dom;
  let bridge;

  beforeEach(() => {
    delete require.cache[require.resolve(BRIDGE_PATH)];
    delete require.cache[require.resolve(HUNK_PARSER_PATH)];
    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    global.document = dom.window.document;
    global.window = {
      PierreDiffs: undefined,
      matchMedia: () => ({ matches: false }),
    };
    global.requestAnimationFrame = () => {};
    PierreBridge = require(BRIDGE_PATH);
    require(HUNK_PARSER_PATH); // assigns global.window.HunkParser
    bridge = new PierreBridge({});
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.requestAnimationFrame;
    vi.restoreAllMocks();
  });

  it('derives positions from metadata hunkContent without parsing the patch', () => {
    const spy = vi.spyOn(global.window.HunkParser, 'parseDiffIntoBlocks');
    const result = bridge.computeDiffPositions(PATCH, METADATA);

    expect(mapsEqual(result, EXPECTED)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('metadata-derived positions equal the raw-patch positions', () => {
    const fromPatch = bridge.computeDiffPositions(PATCH);
    const fromMeta = bridge.computeDiffPositions(PATCH, METADATA);
    expect(mapsEqual(fromMeta, fromPatch)).toBe(true);
  });

  it('agrees with the raw-patch walk across mixed / add-only / del-only hunks', () => {
    const cases = [
      {
        patch: '@@ -1,2 +1,3 @@\n x\n+n1\n+n2\n',
        meta: { hunks: [{ deletionStart: 1, additionStart: 1, hunkContent: [
          { type: 'context', lines: 1 },
          { type: 'change', deletions: 0, additions: 2 },
        ] }] },
      },
      {
        patch: '@@ -1,3 +1,1 @@\n x\n-d1\n-d2\n',
        meta: { hunks: [{ deletionStart: 1, additionStart: 1, hunkContent: [
          { type: 'context', lines: 1 },
          { type: 'change', deletions: 2, additions: 0 },
        ] }] },
      },
      {
        patch: '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,2 +10,3 @@\n y\n+NEW\n z\n',
        meta: { hunks: [
          { deletionStart: 1, additionStart: 1, hunkContent: [
            { type: 'context', lines: 1 },
            { type: 'change', deletions: 1, additions: 1 },
            { type: 'context', lines: 1 },
          ] },
          { deletionStart: 10, additionStart: 10, hunkContent: [
            { type: 'context', lines: 1 },
            { type: 'change', deletions: 0, additions: 1 },
            { type: 'context', lines: 1 },
          ] },
        ] },
      },
    ];
    for (const { patch, meta } of cases) {
      expect(mapsEqual(
        bridge.computeDiffPositions(patch, meta),
        bridge.computeDiffPositions(patch),
      )).toBe(true);
    }
  });

  it('falls back to raw-patch parsing when metadata lacks hunkContent', () => {
    const spy = vi.spyOn(global.window.HunkParser, 'parseDiffIntoBlocks');
    const noContent = { hunks: [{ deletionStart: 1, additionStart: 1 }] };
    const result = bridge.computeDiffPositions(PATCH, noContent);

    expect(mapsEqual(result, EXPECTED)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('falls back for an unrecognized hunkContent segment type', () => {
    const spy = vi.spyOn(global.window.HunkParser, 'parseDiffIntoBlocks');
    const weird = { hunks: [{ deletionStart: 1, additionStart: 1, hunkContent: [
      { type: 'mystery' },
    ] }] };
    bridge.computeDiffPositions(PATCH, weird);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('still works as a single-arg call (no metadata) — regression', () => {
    const result = bridge.computeDiffPositions(PATCH);
    expect(mapsEqual(result, EXPECTED)).toBe(true);
    expect(bridge.computeDiffPositions('').size).toBe(0);
  });
});

describe('PierreBridge.renderFile parses the patch only once', () => {
  let PierreBridge;
  let dom;
  let parsePatchFiles;
  let FakeFileDiff;

  beforeEach(() => {
    delete require.cache[require.resolve(BRIDGE_PATH)];
    delete require.cache[require.resolve(HUNK_PARSER_PATH)];
    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    global.document = dom.window.document;
    global.requestAnimationFrame = () => {};

    parsePatchFiles = vi.fn(() => [{ files: [structuredClone(METADATA)] }]);
    FakeFileDiff = class {
      constructor() { this.fileDiff = { hunks: METADATA.hunks }; }
      render() { return true; }
    };
    global.window = {
      matchMedia: () => ({ matches: false }),
      PierreDiffs: {
        parsePatchFiles,
        getSingularPatch: () => null,
        FileDiff: FakeFileDiff,
        // No WorkerPoolManager → bridge runs worker-free.
      },
    };
    PierreBridge = require(BRIDGE_PATH);
    require(HUNK_PARSER_PATH);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.requestAnimationFrame;
    vi.restoreAllMocks();
  });

  it('parses via parsePatchFiles once and never via HunkParser', () => {
    const bridge = new PierreBridge({});
    const hunkSpy = vi.spyOn(global.window.HunkParser, 'parseDiffIntoBlocks');
    const container = global.document.createElement('div');

    const fileState = bridge.renderFile('a.js', container, PATCH);

    expect(fileState).toBeTruthy();
    expect(parsePatchFiles).toHaveBeenCalledTimes(1);
    // The second parse (HunkParser) is eliminated — positions come from metadata.
    expect(hunkSpy).not.toHaveBeenCalled();
    // diffPositions still computed correctly.
    expect(fileState.diffPositions.get('RIGHT:2')).toBe(4);
    expect(fileState.diffPositions.get('LEFT:3')).toBe(5);
  });
});
