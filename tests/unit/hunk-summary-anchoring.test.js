// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for hunk-summary anchoring:
 *   - _registerPierreHunkAnchorsForFile() turns a file's hunks into anchor
 *     positions keyed by the server's content hashes, scoped by file, and
 *     mounts any summary that arrived before the anchor existed.
 *   - _fetchHunkSummaryMap() loads the server summary map (config-gated) and
 *     queues summaries of hunks that have no anchor yet.
 *
 * Server-supplied canonical hashes are mandatory (the WebCrypto fallback was
 * removed in favor of always trusting the backend); a file whose hashes do
 * not match its hunks registers nothing rather than being re-hashed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');
const { HunkParser } = require('../../public/js/modules/hunk-parser.js');

function createTestPRManager() {
  const prManager = Object.create(PRManager.prototype);
  prManager.currentPR = { id: 999 };
  prManager._renderGen = 1;
  prManager._summaryAnchorsByHash = new Map();
  prManager._summaryHashesByFile = new Map();
  prManager._pendingSummariesByHash = new Map();
  prManager._summariesHidden = false;
  prManager._summariesGenerated = false;
  prManager.summariesHiddenFiles = new Set();
  // Stub the network bits and methods we don't exercise.
  prManager._getAppConfig = vi.fn().mockResolvedValue({ summaries: { enabled: true } });
  prManager._syncSummaryToolbarButton = vi.fn();
  prManager._restoreSummariesHiddenFiles = vi.fn();
  prManager._refreshFileSummaryToggle = vi.fn();
  prManager.hunkSummaryRenderer = null;
  // Suppress the network fetch that step 3 of _fetchHunkSummaryMap makes.
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ summaries: [], generating: false })
  });
  return prManager;
}

describe('PRManager._fetchHunkSummaryMap', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it('bails out cleanly when summaries.enabled is false', async () => {
    const prManager = createTestPRManager();
    prManager._getAppConfig = vi.fn().mockResolvedValue({ summaries: { enabled: false } });

    await prManager._fetchHunkSummaryMap();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('queues fetched summaries of hunks that have no anchor yet', async () => {
    const prManager = createTestPRManager();
    prManager.hunkSummaryRenderer = { renderPierre: vi.fn() };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        summaries: [{ content_hash: 'h1', summary_text: 'x', file_path: 'a.js' }],
        generating: false
      })
    });

    await prManager._fetchHunkSummaryMap();

    // No anchor exists yet → summary is deferred, scoped to its file, not lost.
    expect(prManager._pendingSummariesByHash.get('a.js')?.has('h1')).toBe(true);
    expect(prManager.hunkSummaryRenderer.renderPierre).not.toHaveBeenCalled();
    expect(prManager._summariesAvailable).toBe(true);
  });
});

// A realistic multi-hunk patch covering all three anchor cases:
//   hunk 1 (context-first)  → RIGHT at NEW start 1
//   hunk 2 (pure deletion)  → LEFT  at OLD start 10
//   hunk 3 (addition-first) → RIGHT at NEW start 18
const MULTI_HUNK_PATCH = [
  '@@ -1,3 +1,4 @@',
  ' context line 1',
  '+added line',
  ' context line 2',
  ' context line 3',
  '@@ -10,3 +11,0 @@',
  '-removed a',
  '-removed b',
  '-removed c',
  '@@ -20,2 +18,3 @@',
  '+brand new first',
  ' ctx',
  ' ctx2'
].join('\n');

describe('PRManager._computePierreHunkAnchors', () => {
  beforeEach(() => {
    window.HunkParser = HunkParser;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps each hunk to its first rendered line, picking side by line kind', () => {
    const prManager = Object.create(PRManager.prototype);
    const anchors = prManager._computePierreHunkAnchors(
      MULTI_HUNK_PATCH,
      ['h1', 'h2', 'h3']
    );

    expect(anchors.get('h1')).toEqual({ lineNumber: 1, side: 'RIGHT' });   // context-first
    expect(anchors.get('h2')).toEqual({ lineNumber: 10, side: 'LEFT' });   // pure deletion
    expect(anchors.get('h3')).toEqual({ lineNumber: 18, side: 'RIGHT' });  // addition-first
  });

  it('fails closed (empty map) on hash/hunk count mismatch', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prManager = Object.create(PRManager.prototype);
    // 2 hashes vs 3 rendered hunks → misalignment; drop rather than misanchor.
    const anchors = prManager._computePierreHunkAnchors(MULTI_HUNK_PATCH, ['h1', 'h2']);

    expect(anchors.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('length mismatch'));
  });

  it('returns an empty map when hashes are missing or empty', () => {
    const prManager = Object.create(PRManager.prototype);
    expect(prManager._computePierreHunkAnchors(MULTI_HUNK_PATCH, null).size).toBe(0);
    expect(prManager._computePierreHunkAnchors(MULTI_HUNK_PATCH, []).size).toBe(0);
    expect(prManager._computePierreHunkAnchors('', ['h1']).size).toBe(0);
  });
});

describe('PRManager._registerPierreHunkAnchorsForFile', () => {
  function createPierrePRManager(fileNames = ['a.js']) {
    const prManager = Object.create(PRManager.prototype);
    prManager._summaryAnchorsByHash = new Map();
    prManager._summaryHashesByFile = new Map();
    prManager._pendingSummariesByHash = new Map();
    prManager._summariesGenerated = false;
    prManager._summariesAvailable = false;
    prManager._syncSummaryToolbarButton = vi.fn();
    prManager._refreshFileSummaryToggle = vi.fn();
    prManager.pierreBridge = { files: new Map(fileNames.map(f => [f, {}])) };
    return prManager;
  }

  beforeEach(() => {
    window.HunkParser = HunkParser;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers position anchors scoped by file', () => {
    const prManager = createPierrePRManager();
    prManager.hunkSummaryRenderer = { renderPierre: vi.fn() };

    prManager._registerPierreHunkAnchorsForFile({
      file: 'a.js',
      patch: MULTI_HUNK_PATCH,
      hunk_hashes: ['h1', 'h2', 'h3']
    });

    const anchors = prManager._summaryAnchorsByHash.get('a.js');
    expect(anchors.get('h1')).toEqual({ fileName: 'a.js', lineNumber: 1, side: 'RIGHT' });
    expect(anchors.get('h2')).toEqual({ fileName: 'a.js', lineNumber: 10, side: 'LEFT' });
    expect(prManager._summaryHashesByFile.get('a.js')).toEqual(new Set(['h1', 'h2', 'h3']));
  });

  it('mounts a summary queued before the anchor existed', () => {
    const prManager = createPierrePRManager();
    prManager.hunkSummaryRenderer = { renderPierre: vi.fn().mockReturnValue('hunk-summary-h2') };
    const summary = { content_hash: 'h2', summary_text: 'Removes dead code.' };
    prManager._queuePendingSummary('a.js', summary);

    prManager._registerPierreHunkAnchorsForFile({
      file: 'a.js',
      patch: MULTI_HUNK_PATCH,
      hunk_hashes: ['h1', 'h2', 'h3']
    });

    expect(prManager.hunkSummaryRenderer.renderPierre).toHaveBeenCalledWith(
      'a.js',
      { fileName: 'a.js', lineNumber: 10, side: 'LEFT' },
      summary
    );
    expect(prManager._pendingSummariesByHash.has('a.js')).toBe(false);
    expect(prManager._summariesGenerated).toBe(true);
    expect(prManager._summariesAvailable).toBe(true);
    expect(prManager._refreshFileSummaryToggle).toHaveBeenCalledWith('a.js');
  });

  it('does not let one file consume another file\'s queued summary on a hash collision', () => {
    const prManager = createPierrePRManager(['a.js', 'b.js']);
    const renderPierre = vi.fn().mockReturnValue('hunk-summary-h1');
    prManager.hunkSummaryRenderer = { renderPierre };
    // Two files share their hunks' content hashes (copy-pasted boilerplate,
    // a tiny rename). Only b.js's summary is queued.
    const summaryForB = { content_hash: 'h1', summary_text: 'B summary' };
    prManager._queuePendingSummary('b.js', summaryForB);

    // a.js registers an anchor with the SAME hash. It must NOT mount b.js's
    // queued summary.
    prManager._registerPierreHunkAnchorsForFile({ file: 'a.js', patch: MULTI_HUNK_PATCH, hunk_hashes: ['h1', 'h2', 'h3'] });
    expect(renderPierre).not.toHaveBeenCalled();
    expect(prManager._pendingSummariesByHash.get('b.js')?.has('h1')).toBe(true);

    // b.js's own anchor drains its own queued summary.
    prManager._registerPierreHunkAnchorsForFile({ file: 'b.js', patch: MULTI_HUNK_PATCH, hunk_hashes: ['h1', 'h2', 'h3'] });
    expect(renderPierre).toHaveBeenCalledTimes(1);
    expect(renderPierre).toHaveBeenCalledWith('b.js', { fileName: 'b.js', lineNumber: 1, side: 'RIGHT' }, summaryForB);
  });

  it('mounts a summary against its OWN file\'s anchor on a hash collision, whichever file registered last', () => {
    const prManager = createPierrePRManager(['a.js', 'b.js']);
    const renderPierre = vi.fn().mockReturnValue('hunk-summary-h2');
    prManager.hunkSummaryRenderer = { renderPierre };
    // Both files have their anchors, under the same hashes: a map keyed by
    // hash alone would let b.js's registration overwrite a.js's anchor.
    prManager._registerPierreHunkAnchorsForFile({ file: 'a.js', patch: MULTI_HUNK_PATCH, hunk_hashes: ['h1', 'h2', 'h3'] });
    prManager._registerPierreHunkAnchorsForFile({ file: 'b.js', patch: MULTI_HUNK_PATCH, hunk_hashes: ['h1', 'h2', 'h3'] });
    // Neither registration mounts anything (nothing was queued).
    expect(renderPierre).not.toHaveBeenCalled();

    const summary = { content_hash: 'h2', summary_text: 'A' };
    expect(prManager._renderOneSummary(summary, 'a.js')).toBe('hunk-summary-h2');
    expect(renderPierre).toHaveBeenCalledTimes(1);
    expect(renderPierre).toHaveBeenCalledWith('a.js', { fileName: 'a.js', lineNumber: 10, side: 'LEFT' }, summary);
  });

  it('is a no-op for a missing file, a file without a patch and a patch without a hunk', () => {
    const prManager = createPierrePRManager();
    prManager.hunkSummaryRenderer = { renderPierre: vi.fn() };
    expect(() => prManager._registerPierreHunkAnchorsForFile(undefined)).not.toThrow();
    expect(() => prManager._registerPierreHunkAnchorsForFile({ file: 'a.js', patch: '' })).not.toThrow();
    expect(() => prManager._registerPierreHunkAnchorsForFile({ file: 'a.js', patch: 'old mode 100644\nnew mode 100755\n', hunk_hashes: [] })).not.toThrow();
    expect(prManager._summaryAnchorsByHash.size).toBe(0);
  });

  it('is a no-op for a file the bridge has no record of', () => {
    const prManager = createPierrePRManager([]); // bridge has no files
    prManager.hunkSummaryRenderer = { renderPierre: vi.fn() };

    prManager._registerPierreHunkAnchorsForFile({
      file: 'a.js',
      patch: MULTI_HUNK_PATCH,
      hunk_hashes: ['h1', 'h2', 'h3']
    });

    expect(prManager._summaryAnchorsByHash.size).toBe(0);
    expect(prManager.hunkSummaryRenderer.renderPierre).not.toHaveBeenCalled();
  });

  it('drops hashes (registers nothing) on hash/hunk count mismatch', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prManager = createPierrePRManager();
    prManager.hunkSummaryRenderer = { renderPierre: vi.fn() };

    prManager._registerPierreHunkAnchorsForFile({
      file: 'a.js',
      patch: MULTI_HUNK_PATCH,
      hunk_hashes: ['h1', 'h2'] // mismatch
    });

    expect(prManager._summaryAnchorsByHash.size).toBe(0);
    expect(prManager._summaryHashesByFile.size).toBe(0);
  });
});

describe('PRManager._renderOneSummary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('mounts through the bridge at the anchor\'s position', () => {
    const prManager = Object.create(PRManager.prototype);
    prManager._summaryAnchorsByHash = new Map([
      ['a.js', new Map([['h', { fileName: 'a.js', lineNumber: 7, side: 'RIGHT' }]])]
    ]);
    prManager._pendingSummariesByHash = new Map();
    prManager.pierreBridge = { files: new Map([['a.js', {}]]) };
    const renderPierre = vi.fn().mockReturnValue('hunk-summary-h');
    prManager.hunkSummaryRenderer = { renderPierre };

    const result = prManager._renderOneSummary({ content_hash: 'h', summary_text: 'x' }, 'a.js');

    expect(result).toBe('hunk-summary-h');
    expect(renderPierre).toHaveBeenCalledWith(
      'a.js',
      { fileName: 'a.js', lineNumber: 7, side: 'RIGHT' },
      { content_hash: 'h', summary_text: 'x' }
    );
  });

  it('requeues when the file has left the pane since its anchor was registered', () => {
    const prManager = Object.create(PRManager.prototype);
    prManager._summaryAnchorsByHash = new Map([
      ['a.js', new Map([['h', { fileName: 'a.js', lineNumber: 7, side: 'RIGHT' }]])]
    ]);
    prManager._pendingSummariesByHash = new Map();
    prManager.pierreBridge = { files: new Map() }; // file gone
    prManager.hunkSummaryRenderer = { renderPierre: vi.fn() };

    const result = prManager._renderOneSummary({ content_hash: 'h', summary_text: 'x' }, 'a.js');

    expect(result).toBeNull();
    expect(prManager.hunkSummaryRenderer.renderPierre).not.toHaveBeenCalled();
    expect(prManager._pendingSummariesByHash.get('a.js')?.has('h')).toBe(true);
  });
});
