// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * PierreContext — merge context-only hunks into @pierre/diffs FileDiffMetadata.
 *
 * Used by PierreBridge to programmatically reveal arbitrary non-contiguous
 * line ranges in diff files (e.g., for AI suggestions targeting lines deep
 * inside collapsed gaps).
 *
 * All line coordinates are 1-indexed and refer to the NEW (addition) file side.
 */

// ─── Range Utilities ──────────────────────────────────────────────────

/**
 * Sort ranges by startLine and merge overlapping/adjacent ranges.
 * Adjacent means range1.endLine + 1 >= range2.startLine.
 * @param {Array<{startLine: number, endLine: number}>} ranges
 * @returns {Array<{startLine: number, endLine: number}>}
 */
function mergeOverlapping(ranges) {
  if (!ranges || ranges.length === 0) return [];

  const sorted = ranges
    .filter(r => r && r.startLine <= r.endLine)
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  if (sorted.length === 0) return [];

  const merged = [{ startLine: sorted[0].startLine, endLine: sorted[0].endLine }];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = sorted[i];

    // Adjacent or overlapping: prev.endLine + 1 >= cur.startLine
    if (prev.endLine + 1 >= cur.startLine) {
      prev.endLine = Math.max(prev.endLine, cur.endLine);
    } else {
      merged.push({ startLine: cur.startLine, endLine: cur.endLine });
    }
  }

  return merged;
}

/**
 * Remove toRemove ranges from existing ranges.
 * Both inputs are arrays of {startLine, endLine}.
 * Returns the remaining ranges after subtraction.
 * @param {Array<{startLine: number, endLine: number}>} existing
 * @param {Array<{startLine: number, endLine: number}>} toRemove
 * @returns {Array<{startLine: number, endLine: number}>}
 */
function subtractRanges(existing, toRemove) {
  if (!existing || existing.length === 0) return [];
  if (!toRemove || toRemove.length === 0) {
    return existing.map(r => ({ startLine: r.startLine, endLine: r.endLine }));
  }

  // Normalize both sides
  const normalizedExisting = mergeOverlapping(existing);
  const normalizedRemove = mergeOverlapping(toRemove);

  const result = [];

  for (const range of normalizedExisting) {
    let remaining = [{ startLine: range.startLine, endLine: range.endLine }];

    for (const cut of normalizedRemove) {
      const next = [];
      for (const r of remaining) {
        // No overlap — cut is entirely before or after this range
        if (cut.endLine < r.startLine || cut.startLine > r.endLine) {
          next.push(r);
          continue;
        }
        // Portion before the cut
        if (cut.startLine > r.startLine) {
          next.push({ startLine: r.startLine, endLine: cut.startLine - 1 });
        }
        // Portion after the cut
        if (cut.endLine < r.endLine) {
          next.push({ startLine: cut.endLine + 1, endLine: r.endLine });
        }
        // If cut completely covers r, nothing is pushed
      }
      remaining = next;
    }

    result.push(...remaining);
  }

  return result;
}

// ─── Core Algorithm ───────────────────────────────────────────────────

/**
 * Merge context-only hunks into existing FileDiffMetadata.
 *
 * @param {Object} baseMetadata - Original FileDiffMetadata (with real diff hunks).
 *   Has properties: hunks[], additionLines[], deletionLines[], isPartial, name,
 *   type, cacheKey, splitLineCount, unifiedLineCount.
 * @param {Array<{startLine: number, endLine: number}>} ranges
 *   Line ranges in NEW file coordinates (1-indexed).
 * @returns {Object} New FileDiffMetadata with original + context hunks merged.
 */
function mergeContextRanges(baseMetadata, ranges) {
  if (!ranges || ranges.length === 0) return baseMetadata;
  if (!baseMetadata || !baseMetadata.hunks) return baseMetadata;

  const totalNewLines = baseMetadata.additionLines
    ? baseMetadata.additionLines.length
    : 0;

  // ── Step 1: Normalize ranges ──────────────────────────────────────
  const normalized = mergeOverlapping(ranges);
  if (normalized.length === 0) return baseMetadata;

  // Clamp to file length
  const clamped = normalized
    .map(r => ({
      startLine: Math.max(1, r.startLine),
      endLine: totalNewLines > 0 ? Math.min(r.endLine, totalNewLines) : r.endLine,
    }))
    .filter(r => r.startLine <= r.endLine);

  if (clamped.length === 0) return baseMetadata;

  const existingHunks = baseMetadata.hunks;

  // ── Step 2: Compute old↔new offset map ────────────────────────────
  // The cumulative offset at each hunk boundary. For a new-file line N
  // in a gap between hunks: oldLine = N - cumulativeOffset.
  // Offset changes by (hunk.additionLines - hunk.deletionLines) for each
  // hunk — the count of actual +/- lines, not additionCount/deletionCount.
  //
  // offsets[i] = cumulative offset AFTER processing hunk i.
  // Before the first hunk, offset is 0.
  const offsets = [];
  let cumOffset = 0;
  for (let i = 0; i < existingHunks.length; i++) {
    cumOffset += existingHunks[i].additionLines - existingHunks[i].deletionLines;
    offsets.push(cumOffset);
  }

  /**
   * Get the cumulative offset for a new-file line in a gap.
   * gapIndex 0 = before first hunk, gapIndex i = after hunk i-1.
   */
  function offsetForGap(gapIndex) {
    if (gapIndex === 0) return 0;
    return offsets[gapIndex - 1];
  }

  // ── Step 3: Clip ranges against existing hunks ────────────────────
  // Build list of existing hunk spans in new-file coordinates.
  const existingSpans = existingHunks.map(h => ({
    startLine: h.additionStart,
    endLine: h.additionStart + h.additionCount - 1,
  }));

  // Subtract existing hunk spans from requested ranges
  const clipped = subtractRanges(clamped, existingSpans);
  if (clipped.length === 0) return baseMetadata;

  // Split clipped ranges that span across multiple gaps.
  // A range cannot cross an existing hunk — we must split it at hunk boundaries.
  const gapRanges = [];
  for (const range of clipped) {
    let current = { startLine: range.startLine, endLine: range.endLine };

    for (const span of existingSpans) {
      // If current range doesn't reach this span, done splitting
      if (current.startLine > current.endLine) break;
      if (current.endLine < span.startLine) break;

      // If range starts after this span, skip
      if (current.startLine > span.endLine) continue;

      // Range crosses this span — split into before-span portion
      // (The span itself was already subtracted, so if startLine < span.startLine
      //  there's a portion before the span. After the span, continue with remainder.)
      if (current.startLine < span.startLine) {
        gapRanges.push({
          startLine: current.startLine,
          endLine: span.startLine - 1,
        });
        current = { startLine: span.endLine + 1, endLine: current.endLine };
      } else {
        // startLine is within or after span (shouldn't happen after subtraction)
        current = { startLine: span.endLine + 1, endLine: current.endLine };
      }
    }

    if (current.startLine <= current.endLine) {
      gapRanges.push(current);
    }
  }

  if (gapRanges.length === 0) return baseMetadata;

  // ── Step 4: Build context-only hunks ──────────────────────────────

  /**
   * Determine which gap a new-file line falls in.
   * Returns the gap index: 0 = before first hunk, i = between hunk i-1 and hunk i.
   */
  function findGapIndex(newLine) {
    for (let i = 0; i < existingHunks.length; i++) {
      if (newLine < existingHunks[i].additionStart) return i;
    }
    return existingHunks.length; // after last hunk
  }

  const contextHunks = [];
  for (const range of gapRanges) {
    const newStart = range.startLine;
    const newEnd = range.endLine;
    const rangeLen = newEnd - newStart + 1;
    const gapIdx = findGapIndex(newStart);
    const gapOffset = offsetForGap(gapIdx);
    const oldStart = newStart - gapOffset;

    contextHunks.push({
      collapsedBefore: 0,  // recomputed in step 6
      deletionStart: oldStart,
      deletionCount: rangeLen,
      deletionLines: 0,    // context-only: no actual deletions
      deletionLineIndex: oldStart - 1,
      additionStart: newStart,
      additionCount: rangeLen,
      additionLines: 0,    // context-only: no actual additions
      additionLineIndex: newStart - 1,
      hunkContent: [{
        type: 'context',
        lines: rangeLen,
        deletionLineIndex: oldStart - 1,
        additionLineIndex: newStart - 1,
      }],
      hunkSpecs: `@@ -${oldStart},${rangeLen} +${newStart},${rangeLen} @@`,
      hunkContext: '',
      splitLineCount: rangeLen,
      splitLineStart: 0,   // recomputed in step 6
      unifiedLineCount: rangeLen,
      unifiedLineStart: 0, // recomputed in step 6
      noEOFCRAdditions: false,
      noEOFCRDeletions: false,
    });
  }

  // ── Step 5: Merge and sort all hunks by additionStart ─────────────
  // Shallow-clone each existing hunk so step 6 doesn't mutate baseMetadata
  // (baseMetadata is stored and reused for re-merging when ranges change).
  const allHunks = [
    ...existingHunks.map(h => ({ ...h })),
    ...contextHunks,
  ].sort((a, b) => a.additionStart - b.additionStart);

  // ── Step 6: Recompute derived fields ──────────────────────────────

  // collapsedBefore: gap between previous hunk's end and this hunk's start
  for (let i = 0; i < allHunks.length; i++) {
    if (i === 0) {
      allHunks[i].collapsedBefore = allHunks[i].additionStart - 1;
    } else {
      const prevEnd = allHunks[i - 1].additionStart + allHunks[i - 1].additionCount;
      allHunks[i].collapsedBefore = allHunks[i].additionStart - prevEnd;
    }
  }

  // Walk merged hunks accumulating splitLineStart / unifiedLineStart
  let cumulativeSplit = 0;
  let cumulativeUnified = 0;
  for (const hunk of allHunks) {
    hunk.splitLineStart = cumulativeSplit;
    hunk.unifiedLineStart = cumulativeUnified;
    cumulativeSplit += hunk.collapsedBefore + hunk.splitLineCount;
    cumulativeUnified += hunk.collapsedBefore + hunk.unifiedLineCount;
  }

  // Trailing collapsed lines after the last hunk
  let trailingCollapsed = 0;
  if (allHunks.length > 0) {
    const lastHunk = allHunks[allHunks.length - 1];
    const lastHunkEnd = lastHunk.additionStart + lastHunk.additionCount - 1;
    trailingCollapsed = Math.max(0, totalNewLines - lastHunkEnd);
  }

  const fileSplitLineCount = cumulativeSplit + trailingCollapsed;
  const fileUnifiedLineCount = cumulativeUnified + trailingCollapsed;

  // ── Step 7: Return new metadata object ────────────────────────────
  // Shallow copy preserving all original fields, replacing hunks and totals.
  return {
    ...baseMetadata,
    hunks: allHunks,
    splitLineCount: fileSplitLineCount,
    unifiedLineCount: fileUnifiedLineCount,
  };
}

/**
 * Convert OLD-file (deletion-side) line numbers to NEW-file coordinates.
 * Uses the same cumulative offset that mergeContextRanges builds internally.
 * @param {Object} baseMetadata - FileDiffMetadata with hunks
 * @param {number} oldStart - OLD-file line (1-indexed)
 * @param {number} oldEnd - OLD-file line (1-indexed)
 * @returns {{startLine: number, endLine: number}}
 */
function convertOldToNew(baseMetadata, oldStart, oldEnd) {
  if (!baseMetadata?.hunks?.length) {
    return { startLine: oldStart, endLine: oldEnd };
  }
  // Build same offset map as mergeContextRanges Step 2
  // offset = cumulative (additionLines - deletionLines)
  // For old-file line in a gap: newLine = oldLine + offset
  const hunks = baseMetadata.hunks;
  const offsets = [];
  let cum = 0;
  for (const h of hunks) {
    cum += h.additionLines - h.deletionLines;
    offsets.push(cum);
  }
  function offsetForOldLine(oldLine) {
    // Find which gap the old line falls in (using deletion-side starts)
    for (let i = 0; i < hunks.length; i++) {
      if (oldLine < hunks[i].deletionStart) return i === 0 ? 0 : offsets[i - 1];
    }
    return offsets[offsets.length - 1];
  }
  return {
    startLine: oldStart + offsetForOldLine(oldStart),
    endLine: oldEnd + offsetForOldLine(oldEnd),
  };
}

// ─── Exports ──────────────────────────────────────────────────────────

window.PierreContext = { mergeContextRanges, mergeOverlapping, subtractRanges, convertOldToNew };

// CommonJS export for tests
if (typeof module !== 'undefined') {
  module.exports = { mergeContextRanges, mergeOverlapping, subtractRanges, convertOldToNew };
}
