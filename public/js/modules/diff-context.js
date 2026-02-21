// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * DiffContext - Extract diff hunks for chat context enrichment.
 * Provides utilities to pull relevant unified diff sections for
 * a given line range, so the chat agent receives code context
 * alongside suggestion/comment metadata.
 */
(function () {
  'use strict';

  const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const MAX_HUNK_LINES = 100;
  const CONTEXT_PADDING = 20;

  /**
   * Extract unified diff hunks overlapping the given line range.
   * @param {string} patchText - Raw unified diff for one file (hunk headers + content lines)
   * @param {number} lineStart - Start line number (1-based, new-side unless side='LEFT')
   * @param {number} lineEnd - End line number (1-based, inclusive)
   * @param {string} [side] - 'LEFT' to match old-side line numbers, otherwise new-side
   * @returns {string|null} Matching hunks as unified diff text, or null
   */
  function extractHunkForLines(patchText, lineStart, lineEnd, side) {
    if (!patchText) return null;

    const lines = patchText.split('\n');
    const hunks = [];

    // Collect hunks: each hunk is { header, headerLine, contentLines }
    let currentHunk = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('@@')) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }
        currentHunk = { headerLine: line, contentLines: [] };
      } else if (currentHunk) {
        currentHunk.contentLines.push(line);
      }
    }
    if (currentHunk) {
      hunks.push(currentHunk);
    }

    const matchingParts = [];

    for (const hunk of hunks) {
      const match = HUNK_HEADER_RE.exec(hunk.headerLine);
      if (!match) continue;

      const oldStart = parseInt(match[1], 10);
      const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
      const newStart = parseInt(match[3], 10);
      const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;

      let hunkStart, hunkEnd;
      if (side === 'LEFT') {
        hunkStart = oldStart;
        hunkEnd = oldStart + oldCount - 1;
      } else {
        hunkStart = newStart;
        hunkEnd = newStart + newCount - 1;
      }

      // Check overlap: [lineStart, lineEnd] vs [hunkStart, hunkEnd]
      if (lineStart > hunkEnd || lineEnd < hunkStart) {
        continue;
      }

      let contentLines = hunk.contentLines;

      // Truncate if content exceeds MAX_HUNK_LINES
      if (contentLines.length > MAX_HUNK_LINES) {
        contentLines = truncateHunkContent(
          contentLines,
          lineStart,
          lineEnd,
          side,
          side === 'LEFT' ? oldStart : newStart
        );
      }

      matchingParts.push(hunk.headerLine + '\n' + contentLines.join('\n'));
    }

    if (matchingParts.length === 0) return null;
    return matchingParts.join('\n');
  }

  /**
   * Truncate hunk content lines around the referenced line range.
   * @param {string[]} contentLines - Content lines of the hunk (after @@ header)
   * @param {number} lineStart - Start of the referenced range
   * @param {number} lineEnd - End of the referenced range
   * @param {string} side - 'LEFT' or other
   * @param {number} startCounter - Starting line number for the relevant side
   * @returns {string[]} Truncated content lines with markers
   */
  function truncateHunkContent(contentLines, lineStart, lineEnd, side, startCounter) {
    // Find content-line indices that fall within [lineStart, lineEnd]
    let firstIndex = -1;
    let lastIndex = -1;
    let counter = startCounter;

    for (let i = 0; i < contentLines.length; i++) {
      const line = contentLines[i];
      const prefix = line.charAt(0);

      let countsForSide;
      if (side === 'LEFT') {
        // Old-side: '-' and ' ' (context) increment, '+' does not
        countsForSide = prefix === '-' || prefix === ' ';
      } else {
        // New-side: '+' and ' ' (context) increment, '-' does not
        countsForSide = prefix === '+' || prefix === ' ';
      }

      if (countsForSide) {
        if (counter >= lineStart && counter <= lineEnd) {
          if (firstIndex === -1) firstIndex = i;
          lastIndex = i;
        }
        counter++;
      }
    }

    // If we didn't find any matching lines, keep the whole thing
    // (the hunk overlaps by header range but maybe content is all removals/additions on the other side)
    if (firstIndex === -1) {
      firstIndex = 0;
      lastIndex = contentLines.length - 1;
    }

    const keepStart = Math.max(0, firstIndex - CONTEXT_PADDING);
    const keepEnd = Math.min(contentLines.length - 1, lastIndex + CONTEXT_PADDING);

    const result = [];
    if (keepStart > 0) {
      result.push('// ... (truncated)');
    }
    for (let i = keepStart; i <= keepEnd; i++) {
      result.push(contentLines[i]);
    }
    if (keepEnd < contentLines.length - 1) {
      result.push('// ... (truncated)');
    }

    return result;
  }

  /**
   * Get the line ranges covered by all hunks in a patch.
   * @param {string} patchText - Raw unified diff for one file
   * @returns {Array<{start: number, end: number}>} New-side ranges for each hunk
   */
  function extractHunkRangesForFile(patchText) {
    if (!patchText) return [];

    const lines = patchText.split('\n');
    const ranges = [];

    for (let i = 0; i < lines.length; i++) {
      const match = HUNK_HEADER_RE.exec(lines[i]);
      if (!match) continue;

      const newStart = parseInt(match[3], 10);
      const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;
      ranges.push({ start: newStart, end: newStart + newCount - 1 });
    }

    return ranges;
  }

  window.DiffContext = { extractHunkForLines, extractHunkRangesForFile };
})();
