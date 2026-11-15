// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

// The module assigns to window.PierreContext; provide the global so require() works.
global.window = global.window || {};
const { mergeContextRanges, mergeOverlapping, subtractRanges, convertOldToNew, rangesFromExpansionMap } =
  require('../../public/js/modules/pierre-context.js');

/**
 * Create a test baseMetadata simulating a file with:
 * - 100 lines in the new file, 95 lines in the old file (net +5 lines)
 * - Hunk 1: lines 10-20 in new file (addition side), with 3 actual additions, 0 deletions
 *   additionStart: 10, additionCount: 11, additionLines: 3, deletionLines: 0
 *   deletionStart: 10, deletionCount: 8
 * - Hunk 2: lines 50-60 in new file, with 2 additions, 0 deletions
 *   additionStart: 50, additionCount: 11, additionLines: 2, deletionLines: 0
 *   deletionStart: 47, deletionCount: 9
 * Cumulative offset after hunk 1: 3-0 = 3
 * Cumulative offset after hunk 2: 3 + (2-0) = 5
 * So for line 80 in new file (after both hunks): oldLine = 80 - 5 = 75
 */
function createTestMetadata() {
  return {
    name: 'test-file.js',
    type: 'modified',
    cacheKey: 'test-123',
    isPartial: false,
    additionLines: new Array(100).fill('line'),  // 100 lines in new file
    deletionLines: new Array(95).fill('line'),   // 95 lines in old file
    splitLineCount: 100,
    unifiedLineCount: 100,
    hunks: [
      {
        additionStart: 10,
        additionCount: 11,
        additionLines: 3,
        additionLineIndex: 9,
        deletionStart: 10,
        deletionCount: 8,
        deletionLines: 0,
        deletionLineIndex: 9,
        collapsedBefore: 9,
        hunkContent: [
          { type: 'context', lines: 3, additionLineIndex: 9, deletionLineIndex: 9 },
          { type: 'addition', lines: 3, additionLineIndex: 12 },
          { type: 'context', lines: 5, additionLineIndex: 15, deletionLineIndex: 12 },
        ],
        hunkSpecs: '@@ -10,8 +10,11 @@',
        hunkContext: '',
        splitLineStart: 0,
        splitLineCount: 11,
        unifiedLineStart: 0,
        unifiedLineCount: 11,
        noEOFCRAdditions: false,
        noEOFCRDeletions: false,
      },
      {
        additionStart: 50,
        additionCount: 11,
        additionLines: 2,
        additionLineIndex: 49,
        deletionStart: 47,
        deletionCount: 9,
        deletionLines: 0,
        deletionLineIndex: 46,
        collapsedBefore: 29,
        hunkContent: [
          { type: 'context', lines: 4, additionLineIndex: 49, deletionLineIndex: 46 },
          { type: 'addition', lines: 2, additionLineIndex: 53 },
          { type: 'context', lines: 5, additionLineIndex: 55, deletionLineIndex: 50 },
        ],
        hunkSpecs: '@@ -47,9 +50,11 @@',
        hunkContext: '',
        splitLineStart: 40,
        splitLineCount: 11,
        unifiedLineStart: 40,
        unifiedLineCount: 11,
        noEOFCRAdditions: false,
        noEOFCRDeletions: false,
      },
    ],
  };
}

// ─── mergeOverlapping ─────────────────────────────────────────────────

describe('mergeOverlapping', () => {
  it('returns empty array for empty input', () => {
    expect(mergeOverlapping([])).toEqual([]);
  });

  it('returns empty array for null input', () => {
    expect(mergeOverlapping(null)).toEqual([]);
  });

  it('returns single range as-is', () => {
    expect(mergeOverlapping([{ startLine: 3, endLine: 7 }]))
      .toEqual([{ startLine: 3, endLine: 7 }]);
  });

  it('keeps non-overlapping ranges separate and sorted', () => {
    const result = mergeOverlapping([
      { startLine: 20, endLine: 25 },
      { startLine: 1, endLine: 5 },
    ]);
    expect(result).toEqual([
      { startLine: 1, endLine: 5 },
      { startLine: 20, endLine: 25 },
    ]);
  });

  it('merges overlapping ranges', () => {
    const result = mergeOverlapping([
      { startLine: 1, endLine: 5 },
      { startLine: 3, endLine: 8 },
    ]);
    expect(result).toEqual([{ startLine: 1, endLine: 8 }]);
  });

  it('merges adjacent ranges (endLine + 1 === startLine)', () => {
    const result = mergeOverlapping([
      { startLine: 1, endLine: 5 },
      { startLine: 6, endLine: 10 },
    ]);
    expect(result).toEqual([{ startLine: 1, endLine: 10 }]);
  });

  it('handles multiple ranges with mixed overlap', () => {
    const result = mergeOverlapping([
      { startLine: 1, endLine: 5 },
      { startLine: 3, endLine: 8 },
      { startLine: 20, endLine: 25 },
      { startLine: 22, endLine: 30 },
      { startLine: 50, endLine: 55 },
    ]);
    expect(result).toEqual([
      { startLine: 1, endLine: 8 },
      { startLine: 20, endLine: 30 },
      { startLine: 50, endLine: 55 },
    ]);
  });

  it('filters out invalid ranges where startLine > endLine', () => {
    const result = mergeOverlapping([
      { startLine: 10, endLine: 5 },   // invalid
      { startLine: 1, endLine: 3 },    // valid
    ]);
    expect(result).toEqual([{ startLine: 1, endLine: 3 }]);
  });

  it('returns empty array when all ranges are invalid', () => {
    const result = mergeOverlapping([
      { startLine: 10, endLine: 5 },
      { startLine: 20, endLine: 1 },
    ]);
    expect(result).toEqual([]);
  });

  it('sorts unsorted input correctly before merging', () => {
    const result = mergeOverlapping([
      { startLine: 30, endLine: 35 },
      { startLine: 10, endLine: 15 },
      { startLine: 12, endLine: 20 },
    ]);
    expect(result).toEqual([
      { startLine: 10, endLine: 20 },
      { startLine: 30, endLine: 35 },
    ]);
  });
});

// ─── subtractRanges ───────────────────────────────────────────────────

describe('subtractRanges', () => {
  it('returns empty array for empty existing', () => {
    expect(subtractRanges([], [{ startLine: 1, endLine: 5 }])).toEqual([]);
  });

  it('returns empty array for null existing', () => {
    expect(subtractRanges(null, [{ startLine: 1, endLine: 5 }])).toEqual([]);
  });

  it('returns copy of existing when toRemove is empty', () => {
    const existing = [{ startLine: 1, endLine: 10 }];
    const result = subtractRanges(existing, []);
    expect(result).toEqual([{ startLine: 1, endLine: 10 }]);
    // Must be a copy, not the same object
    expect(result[0]).not.toBe(existing[0]);
  });

  it('returns copy of existing when toRemove is null', () => {
    const result = subtractRanges([{ startLine: 1, endLine: 10 }], null);
    expect(result).toEqual([{ startLine: 1, endLine: 10 }]);
  });

  it('removes range completely when cut covers it entirely', () => {
    const result = subtractRanges(
      [{ startLine: 3, endLine: 7 }],
      [{ startLine: 1, endLine: 10 }],
    );
    expect(result).toEqual([]);
  });

  it('trims from start (partial overlap at beginning)', () => {
    const result = subtractRanges(
      [{ startLine: 1, endLine: 10 }],
      [{ startLine: 1, endLine: 5 }],
    );
    expect(result).toEqual([{ startLine: 6, endLine: 10 }]);
  });

  it('trims from end (partial overlap at end)', () => {
    const result = subtractRanges(
      [{ startLine: 1, endLine: 10 }],
      [{ startLine: 8, endLine: 15 }],
    );
    expect(result).toEqual([{ startLine: 1, endLine: 7 }]);
  });

  it('splits range when cut is in the middle', () => {
    const result = subtractRanges(
      [{ startLine: 1, endLine: 10 }],
      [{ startLine: 4, endLine: 6 }],
    );
    expect(result).toEqual([
      { startLine: 1, endLine: 3 },
      { startLine: 7, endLine: 10 },
    ]);
  });

  it('returns existing unchanged when no overlap', () => {
    const result = subtractRanges(
      [{ startLine: 1, endLine: 5 }],
      [{ startLine: 10, endLine: 15 }],
    );
    expect(result).toEqual([{ startLine: 1, endLine: 5 }]);
  });

  it('handles multiple cuts on same range', () => {
    const result = subtractRanges(
      [{ startLine: 1, endLine: 20 }],
      [
        { startLine: 3, endLine: 5 },
        { startLine: 10, endLine: 12 },
      ],
    );
    expect(result).toEqual([
      { startLine: 1, endLine: 2 },
      { startLine: 6, endLine: 9 },
      { startLine: 13, endLine: 20 },
    ]);
  });
});

// ─── mergeContextRanges ───────────────────────────────────────────────

describe('mergeContextRanges', () => {
  it('returns baseMetadata unchanged when ranges is null', () => {
    const meta = createTestMetadata();
    const result = mergeContextRanges(meta, null);
    expect(result).toBe(meta);
  });

  it('returns baseMetadata unchanged when ranges is empty', () => {
    const meta = createTestMetadata();
    const result = mergeContextRanges(meta, []);
    expect(result).toBe(meta);
  });

  it('returns baseMetadata when baseMetadata is null', () => {
    expect(mergeContextRanges(null, [{ startLine: 1, endLine: 5 }])).toBe(null);
  });

  it('returns baseMetadata when baseMetadata has no hunks', () => {
    const meta = { name: 'x' };
    expect(mergeContextRanges(meta, [{ startLine: 1, endLine: 5 }])).toBe(meta);
  });

  // ── Gap before first hunk ──────────────────────────────────────────

  it('inserts context hunk in gap before first hunk (lines 3-7)', () => {
    const meta = createTestMetadata();
    const result = mergeContextRanges(meta, [{ startLine: 3, endLine: 7 }]);

    // 3 hunks total: context at 3, original hunk 1 at 10, original hunk 2 at 50
    expect(result.hunks).toHaveLength(3);

    const ctxHunk = result.hunks[0];
    expect(ctxHunk.additionStart).toBe(3);
    expect(ctxHunk.additionCount).toBe(5); // lines 3..7
    expect(ctxHunk.deletionStart).toBe(3); // offset 0 before first hunk
    expect(ctxHunk.deletionCount).toBe(5);
    expect(ctxHunk.additionLines).toBe(0); // context-only
    expect(ctxHunk.deletionLines).toBe(0);
    expect(ctxHunk.collapsedBefore).toBe(2); // lines 1-2 still collapsed

    // Original first hunk collapsedBefore should decrease
    // gap between context hunk end (3+5=8) and hunk 1 start (10) = 10-8 = 2
    expect(result.hunks[1].collapsedBefore).toBe(2);
    expect(result.hunks[1].additionStart).toBe(10);
  });

  // ── Gap between two hunks ─────────────────────────────────────────

  it('inserts context hunk between two existing hunks (lines 30-35)', () => {
    const meta = createTestMetadata();
    const result = mergeContextRanges(meta, [{ startLine: 30, endLine: 35 }]);

    // 3 hunks: hunk 1 at 10, context at 30, hunk 2 at 50
    expect(result.hunks).toHaveLength(3);

    const ctxHunk = result.hunks[1];
    expect(ctxHunk.additionStart).toBe(30);
    expect(ctxHunk.additionCount).toBe(6); // lines 30..35
    // Offset after hunk 1 = 3, so oldStart = 30 - 3 = 27
    expect(ctxHunk.deletionStart).toBe(27);
    expect(ctxHunk.deletionCount).toBe(6);

    // collapsedBefore: gap from hunk 1 end (10+11=21) to context start (30) = 30-21 = 9
    expect(ctxHunk.collapsedBefore).toBe(9);

    // hunk 2 collapsedBefore: gap from context end (30+6=36) to hunk 2 start (50) = 50-36 = 14
    expect(result.hunks[2].collapsedBefore).toBe(14);
  });

  // ── Gap after last hunk ───────────────────────────────────────────

  it('inserts context hunk after last existing hunk (lines 75-80)', () => {
    const meta = createTestMetadata();
    const result = mergeContextRanges(meta, [{ startLine: 75, endLine: 80 }]);

    // 3 hunks: hunk 1 at 10, hunk 2 at 50, context at 75
    expect(result.hunks).toHaveLength(3);

    const ctxHunk = result.hunks[2];
    expect(ctxHunk.additionStart).toBe(75);
    expect(ctxHunk.additionCount).toBe(6); // lines 75..80
    // Offset after both hunks = 5, so oldStart = 75 - 5 = 70
    expect(ctxHunk.deletionStart).toBe(70);
    expect(ctxHunk.deletionCount).toBe(6);

    // collapsedBefore: gap from hunk 2 end (50+11=61) to context start (75) = 75-61 = 14
    expect(ctxHunk.collapsedBefore).toBe(14);
  });

  // ── Overlap clipping ──────────────────────────────────────────────

  it('clips range that overlaps an existing hunk (lines 15-25)', () => {
    const meta = createTestMetadata();
    // Hunk 1 spans 10-20, so only 21-25 should remain after clipping
    const result = mergeContextRanges(meta, [{ startLine: 15, endLine: 25 }]);

    expect(result.hunks).toHaveLength(3);

    const ctxHunk = result.hunks[1];
    expect(ctxHunk.additionStart).toBe(21);
    expect(ctxHunk.additionCount).toBe(5); // lines 21..25
    // Offset after hunk 1 = 3, so oldStart = 21 - 3 = 18
    expect(ctxHunk.deletionStart).toBe(18);
    expect(ctxHunk.deletionCount).toBe(5);
  });

  // ── Entirely inside existing hunk ─────────────────────────────────

  it('returns baseMetadata unchanged when range is entirely inside a hunk (lines 12-18)', () => {
    const meta = createTestMetadata();
    const result = mergeContextRanges(meta, [{ startLine: 12, endLine: 18 }]);

    // Range 12-18 is within hunk 1 (10-20), subtraction removes it entirely
    expect(result).toBe(meta);
  });

  // ── Multiple non-contiguous ranges ────────────────────────────────

  it('inserts multiple context hunks for non-contiguous ranges', () => {
    const meta = createTestMetadata();
    const result = mergeContextRanges(meta, [
      { startLine: 3, endLine: 5 },
      { startLine: 30, endLine: 32 },
    ]);

    // 4 hunks: context at 3, hunk 1 at 10, context at 30, hunk 2 at 50
    expect(result.hunks).toHaveLength(4);

    // First context hunk
    expect(result.hunks[0].additionStart).toBe(3);
    expect(result.hunks[0].additionCount).toBe(3);
    expect(result.hunks[0].deletionStart).toBe(3); // offset 0
    expect(result.hunks[0].collapsedBefore).toBe(2); // lines 1-2

    // Original hunk 1 (shifted collapsedBefore)
    expect(result.hunks[1].additionStart).toBe(10);
    // gap from context end (3+3=6) to hunk 1 start (10) = 4
    expect(result.hunks[1].collapsedBefore).toBe(4);

    // Second context hunk
    expect(result.hunks[2].additionStart).toBe(30);
    expect(result.hunks[2].additionCount).toBe(3);
    expect(result.hunks[2].deletionStart).toBe(27); // offset 3

    // Original hunk 2
    expect(result.hunks[3].additionStart).toBe(50);
  });

  // ── EOF clamping ──────────────────────────────────────────────────

  it('clamps range beyond EOF to file length', () => {
    const meta = createTestMetadata();
    // File has 100 lines, range 95-110 should clamp to 95-100
    const result = mergeContextRanges(meta, [{ startLine: 95, endLine: 110 }]);

    expect(result.hunks).toHaveLength(3);

    const ctxHunk = result.hunks[2];
    expect(ctxHunk.additionStart).toBe(95);
    expect(ctxHunk.additionCount).toBe(6); // lines 95..100 (clamped)
    // Offset after both hunks = 5, so oldStart = 95 - 5 = 90
    expect(ctxHunk.deletionStart).toBe(90);
    expect(ctxHunk.deletionCount).toBe(6);
  });

  // ── Range spanning across a hunk boundary ─────────────────────────

  it('handles range spanning across a hunk boundary (lines 18-55)', () => {
    const meta = createTestMetadata();
    // Hunk 1 spans 10-20, hunk 2 spans 50-60
    // After subtracting [10,20] and [50,60]: range 18-55 becomes [21,49]
    // All within the gap between hunks, so single context hunk
    const result = mergeContextRanges(meta, [{ startLine: 18, endLine: 55 }]);

    expect(result.hunks).toHaveLength(3);

    const ctxHunk = result.hunks[1];
    expect(ctxHunk.additionStart).toBe(21);
    expect(ctxHunk.additionCount).toBe(29); // lines 21..49
    // Offset after hunk 1 = 3, so oldStart = 21 - 3 = 18
    expect(ctxHunk.deletionStart).toBe(18);
    expect(ctxHunk.deletionCount).toBe(29);
  });

  // ── collapsedBefore recomputation ─────────────────────────────────

  it('recomputes collapsedBefore correctly when context hunk is inserted before first hunk', () => {
    const meta = createTestMetadata();
    const originalCollapsed = meta.hunks[0].collapsedBefore; // 9
    expect(originalCollapsed).toBe(9);

    const result = mergeContextRanges(meta, [{ startLine: 5, endLine: 8 }]);

    // Context hunk at 5: collapsedBefore = 5 - 1 = 4
    expect(result.hunks[0].collapsedBefore).toBe(4);
    // Hunk 1 at 10: gap from context end (5+4=9) to 10 = 1
    expect(result.hunks[1].collapsedBefore).toBe(1);
    // Sum of collapsed before hunk 1 = 4 + 4(context lines) + 1 = 9 (same total gap)
  });

  // ── splitLineStart / unifiedLineStart accumulation ────────────────

  it('accumulates splitLineStart and unifiedLineStart correctly', () => {
    const meta = createTestMetadata();
    const result = mergeContextRanges(meta, [{ startLine: 30, endLine: 35 }]);

    // A hunk's start is the row index of its first line in the full layout:
    // everything above it, including the lines hidden right above it.
    // Hunk 0 (original hunk 1 at 10): 9 hidden lines above it.
    expect(result.hunks[0].splitLineStart).toBe(9);
    expect(result.hunks[0].unifiedLineStart).toBe(9);

    // Hunk 0 ends at row 9 + 11 = 20; 9 lines (21-29) are hidden before the
    // context hunk at 30.
    expect(result.hunks[1].splitLineStart).toBe(29);
    expect(result.hunks[1].unifiedLineStart).toBe(29);

    // The context hunk ends at row 29 + 6 = 35; 14 lines (36-49) are hidden
    // before the original hunk 2 at 50.
    expect(result.hunks[2].splitLineStart).toBe(49);
    expect(result.hunks[2].unifiedLineStart).toBe(49);
  });

  // ── Preserves baseMetadata fields ─────────────────────────────────

  it('preserves name, type, cacheKey, isPartial, additionLines, deletionLines', () => {
    const meta = createTestMetadata();
    const result = mergeContextRanges(meta, [{ startLine: 30, endLine: 35 }]);

    expect(result.name).toBe('test-file.js');
    expect(result.type).toBe('modified');
    expect(result.cacheKey).toBe('test-123');
    expect(result.isPartial).toBe(false);
    expect(result.additionLines).toBe(meta.additionLines);
    expect(result.deletionLines).toBe(meta.deletionLines);
  });

  // ── Does not mutate baseMetadata top-level or hunks array ──────────

  it('does not mutate baseMetadata top-level fields or hunks array length', () => {
    const meta = createTestMetadata();
    const originalHunksLength = meta.hunks.length;
    const originalSplitLineCount = meta.splitLineCount;
    const originalUnifiedLineCount = meta.unifiedLineCount;

    mergeContextRanges(meta, [{ startLine: 30, endLine: 35 }]);

    // Top-level fields untouched (spread creates new object)
    expect(meta.hunks).toHaveLength(originalHunksLength);
    expect(meta.splitLineCount).toBe(originalSplitLineCount);
    expect(meta.unifiedLineCount).toBe(originalUnifiedLineCount);
  });

  it('does not mutate original hunk objects (hunks are shallow-cloned)', () => {
    const meta = createTestMetadata();
    const hunk1Ref = meta.hunks[1];
    const originalCollapsedBefore = hunk1Ref.collapsedBefore; // 29

    mergeContextRanges(meta, [{ startLine: 30, endLine: 35 }]);

    // After the fix, existing hunk objects are shallow-cloned in step 5.
    // The original hunk reference should be untouched.
    expect(hunk1Ref.collapsedBefore).toBe(originalCollapsedBefore);
    expect(hunk1Ref.collapsedBefore).toBe(29);
  });

  // ── File with no hunks ────────────────────────────────────────────

  it('handles file with no hunks (pure context addition)', () => {
    const meta = {
      name: 'empty-diff.js',
      type: 'modified',
      cacheKey: 'empty-1',
      isPartial: false,
      additionLines: new Array(50).fill('line'),
      deletionLines: new Array(50).fill('line'),
      splitLineCount: 0,
      unifiedLineCount: 0,
      hunks: [],
    };

    const result = mergeContextRanges(meta, [{ startLine: 10, endLine: 20 }]);

    expect(result.hunks).toHaveLength(1);

    const ctxHunk = result.hunks[0];
    expect(ctxHunk.additionStart).toBe(10);
    expect(ctxHunk.additionCount).toBe(11); // lines 10..20
    // No hunks processed, offset = 0, so oldStart = 10
    expect(ctxHunk.deletionStart).toBe(10);
    expect(ctxHunk.deletionCount).toBe(11);
    expect(ctxHunk.collapsedBefore).toBe(9); // lines 1-9
  });

  // ── Adjacent context ranges merge ─────────────────────────────────

  it('merges adjacent context ranges into a single hunk', () => {
    const meta = createTestMetadata();
    // After mergeOverlapping, [30,32] + [33,35] => [30,35]
    const result = mergeContextRanges(meta, [
      { startLine: 30, endLine: 32 },
      { startLine: 33, endLine: 35 },
    ]);

    // 3 hunks: hunk 1 at 10, context at 30, hunk 2 at 50
    expect(result.hunks).toHaveLength(3);

    const ctxHunk = result.hunks[1];
    expect(ctxHunk.additionStart).toBe(30);
    expect(ctxHunk.additionCount).toBe(6); // merged: lines 30..35
    expect(ctxHunk.deletionStart).toBe(27); // offset 3
  });

  // ── splitLineCount / unifiedLineCount totals ──────────────────────

  it('recomputes splitLineCount and unifiedLineCount on the result', () => {
    const meta = createTestMetadata();
    const result = mergeContextRanges(meta, [{ startLine: 30, endLine: 35 }]);

    // The result should have updated totals reflecting the extra context hunk
    expect(typeof result.splitLineCount).toBe('number');
    expect(typeof result.unifiedLineCount).toBe('number');
    // splitLineCount should be >= the original since we added context
    expect(result.splitLineCount).toBeGreaterThanOrEqual(meta.splitLineCount);
  });

  // ── Context hunk hunkContent structure ────────────────────────────

  it('builds correct hunkContent for context hunks', () => {
    const meta = createTestMetadata();
    const result = mergeContextRanges(meta, [{ startLine: 30, endLine: 35 }]);

    const ctxHunk = result.hunks[1];
    expect(ctxHunk.hunkContent).toHaveLength(1);
    expect(ctxHunk.hunkContent[0].type).toBe('context');
    expect(ctxHunk.hunkContent[0].lines).toBe(6);
    expect(ctxHunk.hunkContent[0].additionLineIndex).toBe(29); // 30 - 1
    expect(ctxHunk.hunkContent[0].deletionLineIndex).toBe(26); // 27 - 1
  });

  // ── Context hunk hunkSpecs format ─────────────────────────────────

  it('formats hunkSpecs correctly for context hunks', () => {
    const meta = createTestMetadata();
    const result = mergeContextRanges(meta, [{ startLine: 75, endLine: 80 }]);

    const ctxHunk = result.hunks[2];
    // oldStart = 70, rangeLen = 6, newStart = 75
    expect(ctxHunk.hunkSpecs).toBe('@@ -70,6 +75,6 @@');
  });

  // ── Range starting at line 1 ──────────────────────────────────────

  it('handles range starting at line 1 (before all hunks)', () => {
    const meta = createTestMetadata();
    const result = mergeContextRanges(meta, [{ startLine: 1, endLine: 3 }]);

    expect(result.hunks).toHaveLength(3);

    const ctxHunk = result.hunks[0];
    expect(ctxHunk.additionStart).toBe(1);
    expect(ctxHunk.additionCount).toBe(3);
    expect(ctxHunk.deletionStart).toBe(1);
    expect(ctxHunk.collapsedBefore).toBe(0); // nothing before line 1
  });

  // ── Range covering entire gap ─────────────────────────────────────

  it('handles range covering the entire gap between two hunks', () => {
    const meta = createTestMetadata();
    // Gap between hunk 1 (ends at 20) and hunk 2 (starts at 50) is lines 21-49
    const result = mergeContextRanges(meta, [{ startLine: 21, endLine: 49 }]);

    expect(result.hunks).toHaveLength(3);

    const ctxHunk = result.hunks[1];
    expect(ctxHunk.additionStart).toBe(21);
    expect(ctxHunk.additionCount).toBe(29); // 49 - 21 + 1
    expect(ctxHunk.deletionStart).toBe(18); // 21 - 3
    expect(ctxHunk.collapsedBefore).toBe(0); // immediately follows hunk 1

    // Hunk 2 collapsedBefore: gap from context end (21+29=50) to hunk 2 start (50) = 0
    expect(result.hunks[2].collapsedBefore).toBe(0);
  });

  // ── Range entirely beyond EOF is filtered out ─────────────────────

  it('returns baseMetadata unchanged when range is entirely beyond EOF', () => {
    const meta = createTestMetadata();
    const result = mergeContextRanges(meta, [{ startLine: 101, endLine: 110 }]);

    // 100-line file, range starts at 101 => clamped then filtered
    expect(result).toBe(meta);
  });
});

// ─── mergeContextRanges with deletion-heavy hunks ────────────────────

function createDeletionHeavyMetadata() {
  // File with a hunk that removes 5 lines and adds 1.
  // Net offset after hunk: 1 - 5 = -4
  // New file: 20 lines. Old file: 24 lines.
  // Hunk at additionStart:10, additionCount:5 covers new lines 10-14
  // Hunk at deletionStart:10, deletionCount:9 covers old lines 10-18
  return {
    name: 'deletion-heavy.js',
    type: 'modified',
    cacheKey: 'del-123',
    isPartial: false,
    additionLines: new Array(20).fill('line'),
    deletionLines: new Array(24).fill('line'),
    splitLineCount: 20,
    unifiedLineCount: 20,
    hunks: [{
      additionStart: 10,
      additionCount: 5,
      additionLines: 1,
      additionLineIndex: 9,
      deletionStart: 10,
      deletionCount: 9,
      deletionLines: 5,
      deletionLineIndex: 9,
      collapsedBefore: 9,
      hunkContent: [
        { type: 'context', lines: 2, additionLineIndex: 9, deletionLineIndex: 9 },
        { type: 'deletion', lines: 5, deletionLineIndex: 11 },
        { type: 'addition', lines: 1, additionLineIndex: 11 },
        { type: 'context', lines: 2, additionLineIndex: 12, deletionLineIndex: 16 },
      ],
      hunkSpecs: '@@ -10,9 +10,5 @@',
      hunkContext: '',
      splitLineStart: 0,
      splitLineCount: 5,
      unifiedLineStart: 0,
      unifiedLineCount: 5,
      noEOFCRAdditions: false,
      noEOFCRDeletions: false,
    }],
  };
}

describe('mergeContextRanges with deletion-heavy hunks', () => {
  it('context range after deletion-heavy hunk uses negative offset', () => {
    const meta = createDeletionHeavyMetadata();
    // Range [18, 20] in new file. Offset after hunk = 1-5 = -4.
    // oldStart = 18 - (-4) = 22.
    const result = mergeContextRanges(meta, [{ startLine: 18, endLine: 20 }]);

    expect(result.hunks).toHaveLength(2);

    const ctxHunk = result.hunks[1];
    expect(ctxHunk.deletionStart).toBe(22);
    expect(ctxHunk.additionStart).toBe(18);
  });

  it('context range before deletion-heavy hunk uses offset 0', () => {
    const meta = createDeletionHeavyMetadata();
    // Range [3, 7] before the hunk. Offset before first hunk = 0.
    // oldStart = 3.
    const result = mergeContextRanges(meta, [{ startLine: 3, endLine: 7 }]);

    expect(result.hunks).toHaveLength(2);

    const ctxHunk = result.hunks[0];
    expect(ctxHunk.deletionStart).toBe(3);
    expect(ctxHunk.additionStart).toBe(3);
  });

  it('context range in gap before hunk has correct collapsedBefore', () => {
    const meta = createDeletionHeavyMetadata();
    // Range [3, 7]. Context hunk covers lines 3-7, so lines 1-2 are still hidden.
    const result = mergeContextRanges(meta, [{ startLine: 3, endLine: 7 }]);

    // Context hunk: collapsedBefore = 3 - 1 = 2
    expect(result.hunks[0].collapsedBefore).toBe(2);
    // Original hunk: gap from context end (3+5=8) to hunk start (10) = 2
    expect(result.hunks[1].collapsedBefore).toBe(2);
  });
});

// ─── convertOldToNew ─────────────────────────────────────────────────

describe('convertOldToNew', () => {
  it('returns identity when no hunks', () => {
    expect(convertOldToNew({ hunks: [] }, 5, 10))
      .toEqual({ startLine: 5, endLine: 10 });
  });

  it('returns identity when baseMetadata has no hunks property', () => {
    expect(convertOldToNew({}, 5, 10))
      .toEqual({ startLine: 5, endLine: 10 });
  });

  it('converts with positive offset (more additions than deletions)', () => {
    const meta = createTestMetadata();
    // After hunk 1 (additionLines:3, deletionLines:0), offset = 3.
    // Old line 25 (after hunk 1 deletion side ends at 17) falls in gap before hunk 2.
    // offsetForOldLine(25): 25 >= deletionStart(10), 25 < deletionStart(47) → offsets[0] = 3.
    // newLine = 25 + 3 = 28.
    expect(convertOldToNew(meta, 25, 30))
      .toEqual({ startLine: 28, endLine: 33 });
  });

  it('converts with negative offset (more deletions than additions)', () => {
    const meta = createDeletionHeavyMetadata();
    // After hunk (additionLines:1, deletionLines:5), offset = -4.
    // Old line 20 (after hunk deletion side ends at 18) → offset = offsets[0] = -4.
    // newLine = 20 + (-4) = 16.
    expect(convertOldToNew(meta, 20, 22))
      .toEqual({ startLine: 16, endLine: 18 });
  });

  it('uses offset 0 before first hunk', () => {
    const meta = createTestMetadata();
    // Old line 5 before first hunk (deletionStart:10) → offset 0.
    expect(convertOldToNew(meta, 5, 8))
      .toEqual({ startLine: 5, endLine: 8 });
  });

  it('uses cumulative offset after all hunks', () => {
    const meta = createTestMetadata();
    // After both hunks, total offset = 3 + 2 = 5.
    // Old line 60 (after hunk 2 deletion side ends at 55) → offset = 5.
    // newLine = 60 + 5 = 65.
    expect(convertOldToNew(meta, 60, 65))
      .toEqual({ startLine: 65, endLine: 70 });
  });

  it('round-trips with mergeContextRanges offset', () => {
    const meta = createDeletionHeavyMetadata();
    // Convert old line 20 to new: 20 + (-4) = 16.
    const converted = convertOldToNew(meta, 20, 20);
    expect(converted).toEqual({ startLine: 16, endLine: 16 });

    // Now verify mergeContextRanges maps new line 16 back to deletionStart 20.
    const result = mergeContextRanges(meta, [{ startLine: 16, endLine: 16 }]);
    const ctxHunk = result.hunks.find(h => h.additionStart === 16);
    expect(ctxHunk).toBeDefined();
    expect(ctxHunk.deletionStart).toBe(20);
  });
});

// ─── Line starts in the viewer's convention ─────────────────────────────
//
// The virtualized viewer lays rows out from each hunk's splitLineStart and
// unifiedLineStart. Its own producers write "everything above this hunk,
// including the lines hidden right above it". The inputs below are produced
// by the installed package's own parsers, so the shapes are real; what is
// asserted is what mergeContextRanges writes.

describe('mergeContextRanges writes line starts the way the viewer lays rows out', () => {
  let vendor;
  beforeAll(async () => {
    vendor = await import('@pierre/diffs');
  });

  const lines = (n, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`);
  const OLD = lines(400);
  const NEW = (() => {
    const out = OLD.slice();
    out[119] = 'changed 120';
    out.splice(249, 0, 'inserted after 249');
    return out;
  })();
  const text = (arr) => `${arr.join('\n')}\n`;
  const PATCH = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -117,7 +117,7 @@',
    ...OLD.slice(116, 119).map((l) => ` ${l}`),
    `-${OLD[119]}`,
    '+changed 120',
    ...OLD.slice(120, 123).map((l) => ` ${l}`),
    '@@ -247,6 +247,7 @@',
    ...OLD.slice(246, 249).map((l) => ` ${l}`),
    '+inserted after 249',
    ...OLD.slice(249, 252).map((l) => ` ${l}`),
    '',
  ].join('\n');

  /** Every hunk's starts equal the running total above it plus its own hidden lines. */
  function expectVendorLineStarts(metadata) {
    let split = 0;
    let unified = 0;
    expect(metadata.hunks.length).toBeGreaterThan(0);
    for (const hunk of metadata.hunks) {
      expect(hunk.splitLineStart).toBe(split + hunk.collapsedBefore);
      expect(hunk.unifiedLineStart).toBe(unified + hunk.collapsedBefore);
      split += hunk.collapsedBefore + hunk.splitLineCount;
      unified += hunk.collapsedBefore + hunk.unifiedLineCount;
    }
  }

  function partialDiff() {
    return vendor.parsePatchFiles(PATCH)[0].files[0];
  }
  function hydratedDiff() {
    return vendor.hydratePartialDiff('clone', partialDiff(), {
      oldFile: { name: 'src/a.js', contents: text(OLD) },
      newFile: { name: 'src/a.js', contents: text(NEW) },
    });
  }
  function zeroHunkBase() {
    const file = { name: 'src/ctx.js', contents: text(lines(400)) };
    return vendor.parseDiffFromFile(file, file);
  }

  it('the inputs are what the test says they are', () => {
    expect(partialDiff().isPartial).toBe(true);
    expect(partialDiff().hunks).toHaveLength(2);
    expect(hydratedDiff().isPartial).toBe(false);
    expect(hydratedDiff().additionLines).toHaveLength(401);
    expect(zeroHunkBase().hunks).toHaveLength(0);
    expect(zeroHunkBase().additionLines).toHaveLength(400);
    // The package's own output satisfies the formula this suite holds
    // mergeContextRanges to.
    expectVendorLineStarts(partialDiff());
    expectVendorLineStarts(hydratedDiff());
  });

  const CASES = [
    ['one range', [{ startLine: 30, endLine: 40 }]],
    ['two ranges', [{ startLine: 30, endLine: 40 }, { startLine: 300, endLine: 310 }]],
    ['a range touching a hunk', [{ startLine: 100, endLine: 116 }]],
    ['a range between the hunks and one after the last', [{ startLine: 180, endLine: 190 }, { startLine: 390, endLine: 400 }]],
  ];

  for (const [name, ranges] of CASES) {
    it(`a diff parsed from a patch alone holds no line outside its hunks, so it comes back as it was: ${name}`, () => {
      // A partial diff's additionLines are the patch's lines only. Production
      // merges ranges into a diff with full contents (below), never into this.
      const base = partialDiff();
      const merged = mergeContextRanges(base, ranges);
      expect(merged).toBe(base);
      expectVendorLineStarts(merged);
    });

    it(`a diff with full contents, ${name}`, () => {
      const base = hydratedDiff();
      const merged = mergeContextRanges(base, ranges);
      expect(merged.hunks.length).toBeGreaterThan(base.hunks.length);
      expectVendorLineStarts(merged);
    });

    it(`a file without changes, ${name}`, () => {
      const merged = mergeContextRanges(zeroHunkBase(), ranges);
      expect(merged.hunks.length).toBeGreaterThan(0);
      expectVendorLineStarts(merged);
    });
  }

  it('ranges 100-120 and 300-310 of a file without changes start at rows 99 and 299', () => {
    const merged = mergeContextRanges(zeroHunkBase(), [{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 310 }]);
    expect(merged.hunks.map((h) => [h.collapsedBefore, h.unifiedLineStart, h.splitLineStart])).toEqual([
      [99, 99, 99],
      [179, 299, 299],
    ]);
    expect(merged.unifiedLineCount).toBe(400);
    expect(merged.splitLineCount).toBe(400);
  });

  it('leaves the base metadata it was given as it was', () => {
    const base = hydratedDiff();
    const before = base.hunks.map((h) => [h.collapsedBefore, h.unifiedLineStart, h.splitLineStart]);
    mergeContextRanges(base, [{ startLine: 30, endLine: 40 }]);
    expect(base.hunks.map((h) => [h.collapsedBefore, h.unifiedLineStart, h.splitLineStart])).toEqual(before);
  });
});

// ─── rangesFromExpansionMap ─────────────────────────────────────────────

describe('rangesFromExpansionMap', () => {
  /** 400-line file with hunks at 100-120 and 300-310 (no changes: context hunks). */
  function twoHunkMetadata() {
    const base = {
      name: 'ctx.js', type: 'change', isPartial: false, hunks: [],
      additionLines: new Array(400).fill('x'), deletionLines: new Array(400).fill('x'),
      splitLineCount: 0, unifiedLineCount: 0,
    };
    return mergeContextRanges(base, [{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 310 }]);
  }

  it('answers nothing without a map, for partial metadata, and for missing metadata', () => {
    expect(rangesFromExpansionMap(twoHunkMetadata(), null)).toEqual([]);
    expect(rangesFromExpansionMap(twoHunkMetadata(), new Map())).toEqual([]);
    expect(rangesFromExpansionMap({ ...twoHunkMetadata(), isPartial: true }, new Map([[0, { fromStart: 5, fromEnd: 5 }]]))).toEqual([]);
    expect(rangesFromExpansionMap(null, new Map([[0, { fromStart: 5, fromEnd: 5 }]]))).toEqual([]);
    expect(rangesFromExpansionMap(undefined, undefined)).toEqual([]);
  });

  it('a file without hunks has no gap to report', () => {
    const meta = { isPartial: false, hunks: [], additionLines: new Array(30).fill('x'), deletionLines: new Array(30).fill('x') };
    expect(rangesFromExpansionMap(meta, new Map([[0, { fromStart: Infinity, fromEnd: 0 }]]))).toEqual([]);
  });

  it('reads partial regions at the start and the end of the gap before a hunk', () => {
    const map = new Map([[1, { fromStart: 20, fromEnd: 40 }]]);
    // Gap 1 is lines 121-299.
    expect(rangesFromExpansionMap(twoHunkMetadata(), map)).toEqual([
      { startLine: 121, endLine: 140 },
      { startLine: 260, endLine: 299 },
    ]);
  });

  it('the gap before the first hunk and the gap after the last', () => {
    const map = new Map([
      [0, { fromStart: 0, fromEnd: 20 }],
      [2, { fromStart: 20, fromEnd: 0 }],
    ]);
    expect(rangesFromExpansionMap(twoHunkMetadata(), map)).toEqual([
      { startLine: 80, endLine: 99 },
      { startLine: 311, endLine: 330 },
    ]);
  });

  it('Infinity is the whole gap, from either end', () => {
    expect(rangesFromExpansionMap(twoHunkMetadata(), new Map([[1, { fromStart: Infinity, fromEnd: 0 }]])))
      .toEqual([{ startLine: 121, endLine: 299 }]);
    expect(rangesFromExpansionMap(twoHunkMetadata(), new Map([[1, { fromStart: 0, fromEnd: Infinity }]])))
      .toEqual([{ startLine: 121, endLine: 299 }]);
    expect(rangesFromExpansionMap(twoHunkMetadata(), new Map([[0, { fromStart: Infinity, fromEnd: Infinity }]])))
      .toEqual([{ startLine: 1, endLine: 99 }]);
    expect(rangesFromExpansionMap(twoHunkMetadata(), new Map([[2, { fromStart: Infinity, fromEnd: 0 }]])))
      .toEqual([{ startLine: 311, endLine: 400 }]);
  });

  it('clamps counts to the gap and joins two regions that meet', () => {
    // Gap 0 is lines 1-99.
    expect(rangesFromExpansionMap(twoHunkMetadata(), new Map([[0, { fromStart: 60, fromEnd: 60 }]])))
      .toEqual([{ startLine: 1, endLine: 99 }]);
    expect(rangesFromExpansionMap(twoHunkMetadata(), new Map([[0, { fromStart: 500, fromEnd: 0 }]])))
      .toEqual([{ startLine: 1, endLine: 99 }]);
    expect(rangesFromExpansionMap(twoHunkMetadata(), new Map([[0, { fromStart: 49, fromEnd: 49 }]])))
      .toEqual([{ startLine: 1, endLine: 49 }, { startLine: 51, endLine: 99 }]);
  });

  it('the gap after the last hunk only grows from its start', () => {
    expect(rangesFromExpansionMap(twoHunkMetadata(), new Map([[2, { fromStart: 0, fromEnd: 30 }]]))).toEqual([]);
  });

  it('ignores counts that are not positive numbers', () => {
    const map = new Map([[1, { fromStart: -3, fromEnd: NaN }], [0, { fromStart: '20', fromEnd: undefined }]]);
    expect(rangesFromExpansionMap(twoHunkMetadata(), map)).toEqual([]);
  });

  it('a gap of five lines or fewer is on screen without an entry; six lines are not', () => {
    const base = {
      isPartial: false, hunks: [],
      additionLines: new Array(40).fill('x'), deletionLines: new Array(40).fill('x'),
    };
    // Gaps: 1-5 (5 lines), 11-16 (6 lines), 21-25 (5 lines), 31-40 (10 lines).
    const meta = mergeContextRanges(base, [
      { startLine: 6, endLine: 10 }, { startLine: 17, endLine: 20 }, { startLine: 26, endLine: 30 },
    ]);
    expect(rangesFromExpansionMap(meta, new Map())).toEqual([
      { startLine: 1, endLine: 5 },
      { startLine: 21, endLine: 25 },
    ]);
    expect(rangesFromExpansionMap(meta, new Map(), { threshold: 6 })).toEqual([
      { startLine: 1, endLine: 5 },
      { startLine: 11, endLine: 16 },
      { startLine: 21, endLine: 25 },
    ]);
  });

  it('accepts a plain object keyed by gap index', () => {
    expect(rangesFromExpansionMap(twoHunkMetadata(), { 1: { fromStart: 3, fromEnd: 0 } }))
      .toEqual([{ startLine: 121, endLine: 123 }]);
  });

  it('answers in deletion-side coordinates when asked', () => {
    const meta = createTestMetadata();
    // Hunk 2: additionStart 50, deletionStart 47, collapsedBefore as parsed.
    meta.hunks[0].collapsedBefore = 9;
    meta.hunks[1].collapsedBefore = 29;
    const map = new Map([[1, { fromStart: 0, fromEnd: 10 }]]);
    expect(rangesFromExpansionMap(meta, map)).toEqual([{ startLine: 40, endLine: 49 }]);
    expect(rangesFromExpansionMap(meta, map, { side: 'deletions' })).toEqual([{ startLine: 37, endLine: 46 }]);
  });

  it('does not change the metadata or the map', () => {
    const meta = twoHunkMetadata();
    const snapshot = JSON.stringify(meta.hunks);
    const map = new Map([[1, { fromStart: 20, fromEnd: Infinity }]]);
    rangesFromExpansionMap(meta, map);
    expect(JSON.stringify(meta.hunks)).toBe(snapshot);
    expect(map.get(1)).toEqual({ fromStart: 20, fromEnd: Infinity });
  });
});
