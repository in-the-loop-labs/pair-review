// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Gap Coordinates - Coordinate system utilities for diff gap expansion
 *
 * This module provides shared logic for handling coordinate systems in unified diffs.
 * It is used by both pr.js (production) and tests to ensure consistent behavior.
 *
 * ============================================================================
 * COORDINATE SYSTEM DOCUMENTATION
 * ============================================================================
 *
 * Unified diffs track two coordinate systems:
 *
 * OLD Coordinates (left side):
 *   - Line numbers from the base/original file (before changes)
 *   - Stored in data-start-line and data-end-line attributes
 *   - Used internally by expandGapRange() for fetching file content
 *
 * NEW Coordinates (right side):
 *   - Line numbers from the modified file (after changes)
 *   - Stored in data-start-line-new attribute (when different from OLD)
 *   - AI suggestions typically target NEW coordinates since they comment on
 *     added/modified lines which exist in the NEW file
 *
 * When is the offset non-zero?
 *   - When lines are ADDED before the gap: NEW > OLD (positive offset)
 *   - When lines are DELETED before the gap: NEW < OLD (negative offset)
 *   - Example: If 5 lines were added before a gap at OLD line 100,
 *     the same content appears at NEW line 105 (offset = +5)
 *
 * Which functions use which coordinate system:
 *   - AI suggestions use NEW coordinates (they reference modified file line numbers)
 *   - expandGapRange() uses OLD coordinates (fetches from original file)
 *   - findMatchingGap() checks BOTH systems (NEW first, then OLD fallback)
 *   - convertNewToOldCoords() bridges the gap when needed
 * ============================================================================
 */

/**
 * Parse gap coordinates from a gap control element's dataset
 *
 * @param {Object} controls - Element with dataset containing startLine, endLine, startLineNew
 * @returns {Object} Gap coordinates with both OLD and NEW systems plus computed offset
 *   - gapStart: OLD coordinate start line
 *   - gapEnd: OLD coordinate end line
 *   - gapStartNew: NEW coordinate start line (equals gapStart if not specified)
 *   - gapEndNew: NEW coordinate end line (computed from gapEnd + offset)
 *   - offset: Difference between NEW and OLD coordinates (NEW - OLD)
 */
function getGapCoordinates(controls) {
  const gapStart = parseInt(controls.dataset.startLine);
  const gapEnd = parseInt(controls.dataset.endLine);

  if (isNaN(gapStart) || isNaN(gapEnd)) {
    return null;
  }

  const parsedGapStartNew = parseInt(controls.dataset.startLineNew);
  const gapStartNew = !isNaN(parsedGapStartNew) ? parsedGapStartNew : gapStart;
  const offset = gapStartNew - gapStart;
  const gapEndNew = gapEnd + offset;

  return {
    gapStart,
    gapEnd,
    gapStartNew,
    gapEndNew,
    offset
  };
}

/**
 * Check if a line range overlaps with a gap's coordinate range
 *
 * @param {number} lineStart - Start of the range to check
 * @param {number} lineEnd - End of the range to check
 * @param {number} rangeStart - Start of the gap range
 * @param {number} rangeEnd - End of the gap range
 * @returns {boolean} True if ranges overlap
 */
function rangesOverlap(lineStart, lineEnd, rangeStart, rangeEnd) {
  return lineStart <= rangeEnd && lineEnd >= rangeStart;
}

/**
 * Find a gap that contains the specified line range
 *
 * Checks NEW coordinates FIRST since AI suggestions typically target NEW line numbers
 * (added/modified lines). Falls back to OLD coordinates only if NEW doesn't match.
 * This prioritization is important because:
 *   1. AI analyzes the modified code and references line numbers it sees
 *   2. Those line numbers correspond to the NEW file (right side of diff)
 *   3. OLD coordinates are only relevant for context lines that existed before
 *
 * @param {Array} gapRows - Array of gap row elements with expandControls property
 * @param {number} lineStart - Start line of the range to find
 * @param {number} lineEnd - End line of the range to find
 * @returns {Object|null} Match result or null if no gap contains the range
 *   - row: The matching gap row element
 *   - controls: The expand controls element
 *   - coords: The parsed gap coordinates
 *   - matchedInNewCoords: true if matched via NEW coordinates
 */
function findMatchingGap(gapRows, lineStart, lineEnd) {
  for (const row of gapRows) {
    const controls = row.expandControls;
    if (!controls) continue;

    const coords = getGapCoordinates(controls);
    if (!coords) continue;

    // Check NEW coordinates FIRST since AI suggestions target NEW line numbers
    // (the modified file that the AI analyzed)
    if (rangesOverlap(lineStart, lineEnd, coords.gapStartNew, coords.gapEndNew)) {
      return { row, controls, coords, matchedInNewCoords: true };
    }

    // Fall back to OLD coordinates for context lines or when offset is zero
    if (rangesOverlap(lineStart, lineEnd, coords.gapStart, coords.gapEnd)) {
      return { row, controls, coords, matchedInNewCoords: false };
    }
  }
  return null;
}

/**
 * Convert NEW coordinates to OLD coordinates for a given gap
 *
 * This is needed because expandGapRange() uses OLD line numbers internally
 * to fetch content from the original file.
 *
 * @param {Object} controls - Element with dataset containing startLine, startLineNew
 * @param {number} lineStart - NEW coordinate start line
 * @param {number} lineEnd - NEW coordinate end line
 * @returns {Object} Converted coordinates
 *   - targetLineStart: OLD coordinate start line
 *   - targetLineEnd: OLD coordinate end line
 *   - offset: The offset that was applied (NEW - OLD)
 */
function convertNewToOldCoords(controls, lineStart, lineEnd) {
  const coords = getGapCoordinates(controls);
  return {
    targetLineStart: lineStart - coords.offset,
    targetLineEnd: lineEnd - coords.offset,
    offset: coords.offset
  };
}

// Debug logging helper - only logs when window.PAIR_REVIEW_DEBUG is true
function debugLog(category, message, ...args) {
  if (typeof window !== 'undefined' && window.PAIR_REVIEW_DEBUG) {
    console.log(`[${category}]`, message, ...args);
  }
}

// Export for browser usage (attach to window)
if (typeof window !== 'undefined') {
  window.GapCoordinates = {
    getGapCoordinates,
    rangesOverlap,
    findMatchingGap,
    convertNewToOldCoords,
    debugLog
  };
}

// Export for Node.js/test usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getGapCoordinates,
    rangesOverlap,
    findMatchingGap,
    convertNewToOldCoords,
    debugLog
  };
}
