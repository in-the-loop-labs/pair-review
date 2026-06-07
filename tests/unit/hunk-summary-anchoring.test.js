// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for the lazy-render hunk-summary anchoring split:
 *   - _registerHunkAnchorsForFile() turns a file's per-hunk records into
 *     anchored `data-hunk-start` rows as that file's body renders, and mounts
 *     any summary that arrived before the anchor existed.
 *   - _fetchHunkSummaryMap() loads the server summary map (config-gated) and
 *     queues summaries for files that haven't rendered yet.
 *
 * Server-supplied canonical hashes are mandatory (the WebCrypto fallback was
 * removed in favor of always trusting the backend); records missing a
 * `contentHash` must be logged-and-skipped rather than silently re-hashed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

function buildAnchorRow() {
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  const tr = document.createElement('tr');
  tbody.appendChild(tr);
  table.appendChild(tbody);
  document.body.appendChild(table);
  return tr;
}

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

describe('PRManager._registerHunkAnchorsForFile', () => {
  let warnSpy;

  beforeEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it('wires anchor rows for records with a server-supplied contentHash', () => {
    const prManager = createTestPRManager();
    const anchor = buildAnchorRow();

    prManager._registerHunkAnchorsForFile([
      { file: 'a.js', header: '@@ -1,2 +1,3 @@', anchorRow: anchor, contentHash: 'deadbeef' }
    ]);

    expect(anchor.dataset.hunkStart).toBe('deadbeef');
    // Anchors are file-scoped: Map<filePath, Map<hash, anchorRow>>.
    expect(prManager._summaryAnchorsByHash.get('a.js')?.get('deadbeef')).toBe(anchor);
    expect(prManager._summaryHashesByFile.get('a.js')?.has('deadbeef')).toBe(true);
  });

  it('logs and skips records with no contentHash (no client-side fallback hashing)', () => {
    const prManager = createTestPRManager();
    const anchor = buildAnchorRow();

    prManager._registerHunkAnchorsForFile([
      { file: 'b.js', header: '@@ -1,2 +1,3 @@', anchorRow: anchor, contentHash: null }
    ]);

    expect(anchor.dataset.hunkStart).toBeUndefined();
    expect(prManager._summaryAnchorsByHash.size).toBe(0);
    expect(prManager._summaryHashesByFile.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no server contentHash')
    );
  });

  it('mounts a summary that arrived (queued) before its anchor was rendered', () => {
    const prManager = createTestPRManager();
    const summary = { content_hash: 'deadbeef', summary_text: 'does a thing' };
    // Simulate a WS/fetch summary that landed (scoped to its file) before this
    // file rendered.
    prManager._queuePendingSummary('a.js', summary);
    const renderInline = vi.fn().mockReturnValue(document.createElement('tr'));
    prManager.hunkSummaryRenderer = { renderInline };

    const anchor = buildAnchorRow();
    prManager._registerHunkAnchorsForFile([
      { file: 'a.js', header: '@@ -1,2 +1,3 @@', anchorRow: anchor, contentHash: 'deadbeef' }
    ]);

    expect(renderInline).toHaveBeenCalledWith(anchor, summary);
    // The file's pending bucket is drained (and removed once empty).
    expect(prManager._pendingSummariesByHash.has('a.js')).toBe(false);
    expect(prManager._summariesGenerated).toBe(true);
    expect(prManager._summariesAvailable).toBe(true);
    expect(prManager._refreshFileSummaryToggle).toHaveBeenCalledWith('a.js');
  });

  it('does not let one file consume another file\'s queued summary on a hash collision', () => {
    const prManager = createTestPRManager();
    const renderInline = vi.fn().mockReturnValue(document.createElement('tr'));
    prManager.hunkSummaryRenderer = { renderInline };
    // Two files share content_hash 'shared' (copy-pasted boilerplate / tiny
    // rename). Only b.js's summary is queued.
    const summaryForB = { content_hash: 'shared', summary_text: 'B summary' };
    prManager._queuePendingSummary('b.js', summaryForB);

    // a.js renders first and registers an anchor with the SAME hash. It must
    // NOT mount b.js's queued summary.
    const anchorA = buildAnchorRow();
    prManager._registerHunkAnchorsForFile([
      { file: 'a.js', header: '@@ -1 +1 @@', anchorRow: anchorA, contentHash: 'shared' }
    ]);
    expect(renderInline).not.toHaveBeenCalled();
    expect(prManager._pendingSummariesByHash.get('b.js')?.has('shared')).toBe(true);

    // When b.js renders, its own anchor drains its own queued summary.
    const anchorB = buildAnchorRow();
    prManager._registerHunkAnchorsForFile([
      { file: 'b.js', header: '@@ -1 +1 @@', anchorRow: anchorB, contentHash: 'shared' }
    ]);
    expect(renderInline).toHaveBeenCalledWith(anchorB, summaryForB);
  });

  it('mounts an already-rendered summary against its OWN file\'s anchor on a hash collision', () => {
    const prManager = createTestPRManager();
    // Mimic the real renderer: insert the summary row immediately above the
    // anchor and return it, so we can assert which anchor it mounted against.
    const renderInline = vi.fn((anchorRow, summary) => {
      const row = document.createElement('tr');
      row.className = 'hunk-summary-row';
      row.textContent = summary.summary_text;
      anchorRow.parentNode.insertBefore(row, anchorRow);
      return row;
    });
    prManager.hunkSummaryRenderer = { renderInline };

    // a.js and b.js both carry the SAME content hash and BOTH bodies have
    // already rendered (both anchors registered). This is the already-rendered
    // path the queued-before-render collision test above does not cover: the
    // pre-fix global map let b.js's set() overwrite a.js's anchor for 'shared'.
    const anchorA = buildAnchorRow();
    const anchorB = buildAnchorRow();
    prManager._registerHunkAnchorsForFile([
      { file: 'a.js', header: '@@ -1 +1 @@', anchorRow: anchorA, contentHash: 'shared' }
    ]);
    prManager._registerHunkAnchorsForFile([
      { file: 'b.js', header: '@@ -1 +1 @@', anchorRow: anchorB, contentHash: 'shared' }
    ]);
    // Neither registration mounts anything (nothing was queued).
    expect(renderInline).not.toHaveBeenCalled();

    // Apply a summary for a.js. It must resolve a.js's anchor, NOT the
    // later-registered b.js anchor.
    const row = prManager._renderOneSummary({ content_hash: 'shared', summary_text: 'A' }, 'a.js');

    expect(row).toBeTruthy();
    expect(renderInline).toHaveBeenCalledTimes(1);
    expect(renderInline.mock.calls[0][0]).toBe(anchorA);
    // The mounted row sits immediately above a.js's anchor, not b.js's.
    expect(anchorA.previousElementSibling).toBe(row);
    expect(anchorB.previousElementSibling).not.toBe(row);
  });

  it('is a no-op for empty/missing record lists', () => {
    const prManager = createTestPRManager();
    expect(() => prManager._registerHunkAnchorsForFile([])).not.toThrow();
    expect(() => prManager._registerHunkAnchorsForFile(undefined)).not.toThrow();
    expect(prManager._summaryAnchorsByHash.size).toBe(0);
  });
});

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

  it('queues fetched summaries for files whose body has not rendered yet', async () => {
    const prManager = createTestPRManager();
    prManager.hunkSummaryRenderer = { renderInline: vi.fn() };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        summaries: [{ content_hash: 'h1', summary_text: 'x', file_path: 'a.js' }],
        generating: false
      })
    });

    await prManager._fetchHunkSummaryMap();

    // No anchor exists yet (lazy body unrendered) → summary is deferred,
    // scoped to its file, not lost.
    expect(prManager._pendingSummariesByHash.get('a.js')?.has('h1')).toBe(true);
    expect(prManager.hunkSummaryRenderer.renderInline).not.toHaveBeenCalled();
    expect(prManager._summariesAvailable).toBe(true);
  });
});
