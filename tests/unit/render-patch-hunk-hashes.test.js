// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for the renderPatch hunk-hash length-mismatch guard.
 *
 * Background: the backend computes per-hunk hashes from the canonical
 * (non-whitespace-filtered) diff, but renderPatch may be rendering a
 * `?w=1` filtered diff where `git diff -w` has dropped whitespace-only
 * hunks. If the canonical hash array is longer than the rendered block
 * count, stamping by index would write the wrong canonical hash onto
 * every block after the first dropped hunk, anchoring summaries to the
 * wrong rendered hunk. The guard fails closed: drop the hashes, warn
 * once, and let `_kickOffHunkSummaries` log-and-skip the records (so
 * summaries simply won't anchor).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');
const { HunkParser } = require('../../public/js/modules/hunk-parser.js');

function createTestPRManager() {
  const prManager = Object.create(PRManager.prototype);
  prManager._pendingHunkRecords = [];
  prManager._warnedHunkHashLengthMismatch = false;
  // renderDiffLine is the only PRManager method renderPatch calls per code line
  // (besides parseBlockLines which is on the prototype). Stub it to attach a
  // simple <tr> so anchorRow capture works.
  prManager.renderDiffLine = vi.fn((container, lineData) => {
    const row = document.createElement('tr');
    row.dataset.lineNumber = String(lineData.newNumber ?? lineData.oldNumber ?? '');
    container.appendChild(row);
    return row;
  });
  // Stub expandGapContext so any auto-expand callbacks scheduled by gap
  // creation don't blow up (renderPatch wires it via arrow fn anyway).
  prManager.expandGapContext = vi.fn();
  return prManager;
}

function buildTbody() {
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  document.body.appendChild(table);
  return tbody;
}

describe('PRManager.renderPatch hunk-hash length-mismatch guard', () => {
  let warnSpy;

  beforeEach(() => {
    document.body.innerHTML = '';
    // Use the real HunkParser/DiffRenderer modules so we exercise the
    // actual block-parsing path renderPatch depends on.
    window.HunkParser = HunkParser;
    const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');
    window.DiffRenderer = DiffRenderer;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Ensure setTimeout-driven auto-expand is a no-op (small gaps trigger
    // expandGapContext via setTimeout in renderPatch).
    vi.spyOn(global, 'setTimeout').mockImplementation(() => 0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns once and drops hashes when hunkHashes length does not match block count', () => {
    const prManager = createTestPRManager();
    const tbody = buildTbody();

    // 3-block patch, all in one file. Each hunk has at least one context
    // line so renderPatch records an anchor row.
    const patch = [
      '@@ -1,2 +1,3 @@',
      ' ctx-a',
      '+added-a',
      ' ctx-b',
      '@@ -10,2 +11,3 @@',
      ' ctx-c',
      '+added-c',
      ' ctx-d',
      '@@ -20,2 +21,3 @@',
      ' ctx-e',
      '+added-e',
      ' ctx-f'
    ].join('\n');

    // Sanity: confirm the parser returns 3 blocks, so the test really
    // exercises a 2-vs-3 mismatch.
    expect(HunkParser.parseDiffIntoBlocks(patch)).toHaveLength(3);

    // 2-element hash array → mismatch with 3 rendered blocks.
    const hashes = ['hash-zero', 'hash-one'];

    prManager.renderPatch(tbody, patch, 'mismatch.js', hashes);

    // 1. warn called exactly once with the guard message.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('hunk_hashes length mismatch');
    expect(warnSpy.mock.calls[0][0]).toContain('mismatch.js');

    // 2. _warnedHunkHashLengthMismatch flips to true so subsequent
    //    mismatches don't re-warn.
    expect(prManager._warnedHunkHashLengthMismatch).toBe(true);

    // 3. Pending hunk records were pushed (one per block), but every
    //    contentHash is null because the guard dropped the array. This
    //    is the direct assertion: renderPatch only PUSHES records — the
    //    actual `data-hunk-start` stamping happens in _kickOffHunkSummaries
    //    where null contentHash is logged-and-skipped.
    expect(prManager._pendingHunkRecords).toHaveLength(3);
    for (const rec of prManager._pendingHunkRecords) {
      expect(rec.contentHash).toBeNull();
      expect(rec.file).toBe('mismatch.js');
      expect(rec.anchorRow).toBeTruthy();
    }
  });

  it('does not warn again on a subsequent mismatch (one-shot guard)', () => {
    const prManager = createTestPRManager();
    const tbody1 = buildTbody();
    const tbody2 = buildTbody();

    const patch = [
      '@@ -1,2 +1,3 @@',
      ' ctx-a',
      '+added-a',
      ' ctx-b',
      '@@ -10,2 +11,3 @@',
      ' ctx-c',
      '+added-c',
      ' ctx-d'
    ].join('\n');

    // First mismatch warns.
    prManager.renderPatch(tbody1, patch, 'first.js', ['only-one']);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Second mismatch (different file, same render session) does NOT
    // re-warn — the flag suppresses repeats.
    prManager.renderPatch(tbody2, patch, 'second.js', ['only-one']);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Both files' records still have null contentHash.
    const secondFileRecs = prManager._pendingHunkRecords.filter((r) => r.file === 'second.js');
    expect(secondFileRecs.length).toBeGreaterThan(0);
    for (const rec of secondFileRecs) {
      expect(rec.contentHash).toBeNull();
    }
  });

  it('passes hashes through when the lengths match', () => {
    const prManager = createTestPRManager();
    const tbody = buildTbody();

    const patch = [
      '@@ -1,2 +1,3 @@',
      ' ctx-a',
      '+added-a',
      ' ctx-b',
      '@@ -10,2 +11,3 @@',
      ' ctx-c',
      '+added-c',
      ' ctx-d'
    ].join('\n');

    expect(HunkParser.parseDiffIntoBlocks(patch)).toHaveLength(2);

    const hashes = ['hash-zero', 'hash-one'];

    prManager.renderPatch(tbody, patch, 'aligned.js', hashes);

    // No mismatch → no warn, no flag flip.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(prManager._warnedHunkHashLengthMismatch).toBeFalsy();

    // Records carry the server-supplied hash for each block, in order.
    const recs = prManager._pendingHunkRecords.filter((r) => r.file === 'aligned.js');
    expect(recs).toHaveLength(2);
    expect(recs[0].contentHash).toBe('hash-zero');
    expect(recs[1].contentHash).toBe('hash-one');
  });
});
