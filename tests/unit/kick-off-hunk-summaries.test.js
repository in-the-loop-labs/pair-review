// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for PRManager._kickOffHunkSummaries() — the wiring that turns
 * per-hunk records into anchored `data-hunk-start` rows. Server-supplied
 * canonical hashes are mandatory (the WebCrypto fallback was removed in
 * favor of always trusting the backend); records missing a `contentHash`
 * must be logged-and-skipped rather than silently re-hashed.
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
  prManager.summariesHiddenFiles = new Set();
  // Stub the network bits and methods we don't exercise.
  prManager._getAppConfig = vi.fn().mockResolvedValue({ summaries: { enabled: true } });
  prManager._syncSummaryToolbarButton = vi.fn();
  prManager._restoreSummariesHiddenFiles = vi.fn();
  prManager._refreshFileSummaryToggle = vi.fn();
  prManager.hunkSummaryRenderer = null;
  // Suppress the network fetch that step 5 of _kickOffHunkSummaries makes.
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ summaries: [], generating: false })
  });
  return prManager;
}

describe('PRManager._kickOffHunkSummaries', () => {
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

  it('wires anchor rows for records with a server-supplied contentHash', async () => {
    const prManager = createTestPRManager();
    const anchor = buildAnchorRow();
    prManager._pendingHunkRecords = [
      {
        file: 'a.js',
        header: '@@ -1,2 +1,3 @@',
        anchorRow: anchor,
        contentHash: 'deadbeef'
      }
    ];

    await prManager._kickOffHunkSummaries();

    expect(anchor.dataset.hunkStart).toBe('deadbeef');
    expect(prManager._summaryAnchorsByHash.get('deadbeef')).toBe(anchor);
    expect(prManager._summaryHashesByFile.get('a.js')?.has('deadbeef')).toBe(true);
  });

  it('logs and skips records with no contentHash (no client-side fallback hashing)', async () => {
    const prManager = createTestPRManager();
    const anchor = buildAnchorRow();
    prManager._pendingHunkRecords = [
      {
        file: 'b.js',
        header: '@@ -1,2 +1,3 @@',
        anchorRow: anchor,
        contentHash: null
      }
    ];

    await prManager._kickOffHunkSummaries();

    expect(anchor.dataset.hunkStart).toBeUndefined();
    expect(prManager._summaryAnchorsByHash.size).toBe(0);
    expect(prManager._summaryHashesByFile.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no server contentHash')
    );
  });

  it('bails out cleanly when summaries.enabled is false', async () => {
    const prManager = createTestPRManager();
    prManager._getAppConfig = vi.fn().mockResolvedValue({ summaries: { enabled: false } });
    const anchor = buildAnchorRow();
    prManager._pendingHunkRecords = [
      {
        file: 'c.js',
        header: '@@ -1,2 +1,3 @@',
        anchorRow: anchor,
        contentHash: 'cafebabe'
      }
    ];

    await prManager._kickOffHunkSummaries();

    expect(anchor.dataset.hunkStart).toBeUndefined();
    expect(prManager._summaryAnchorsByHash.size).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
