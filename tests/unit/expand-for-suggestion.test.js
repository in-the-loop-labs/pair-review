// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for PRManager.expandForSuggestion() coordinate system
 *
 * Tests the shared GapCoordinates module that handles AI suggestions using
 * NEW line coordinates when gap rows use OLD line coordinates.
 *
 * These tests import the same functions used by production code to ensure
 * test behavior matches actual application behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  getGapCoordinates,
  rangesOverlap,
  findMatchingGap,
  convertNewToOldCoords
} from '../../public/js/modules/gap-coordinates.js';

// Helper to create mock gap row with OLD and NEW coordinates
function createMockGapRow(startLine, endLine, startLineNew = null) {
  const dataset = {
    startLine: String(startLine),
    endLine: String(endLine)
  };
  if (startLineNew !== null) {
    dataset.startLineNew = String(startLineNew);
  }

  const controls = { dataset };

  return {
    expandControls: controls
  };
}

describe('getGapCoordinates', () => {
  it('should parse OLD and NEW coordinates from controls', () => {
    const gapRow = createMockGapRow(45, 48, 47);
    const coords = getGapCoordinates(gapRow.expandControls);

    expect(coords.gapStart).toBe(45);
    expect(coords.gapEnd).toBe(48);
    expect(coords.gapStartNew).toBe(47);
    expect(coords.gapEndNew).toBe(50); // 48 + (47 - 45) = 50
    expect(coords.offset).toBe(2);
  });

  it('should fall back to OLD when startLineNew is missing', () => {
    const gapRow = createMockGapRow(45, 48);
    const coords = getGapCoordinates(gapRow.expandControls);

    expect(coords.gapStartNew).toBe(45);
    expect(coords.gapEndNew).toBe(48);
    expect(coords.offset).toBe(0);
  });

  it('should handle negative offset when lines were deleted', () => {
    const gapRow = createMockGapRow(45, 48, 43);
    const coords = getGapCoordinates(gapRow.expandControls);

    expect(coords.offset).toBe(-2);
    expect(coords.gapEndNew).toBe(46); // 48 + (-2) = 46
  });
});

describe('rangesOverlap', () => {
  it('should return true when ranges overlap', () => {
    expect(rangesOverlap(46, 47, 45, 48)).toBe(true);
    expect(rangesOverlap(44, 46, 45, 48)).toBe(true); // partial overlap start
    expect(rangesOverlap(47, 50, 45, 48)).toBe(true); // partial overlap end
    expect(rangesOverlap(40, 55, 45, 48)).toBe(true); // contains
  });

  it('should return false when ranges do not overlap', () => {
    expect(rangesOverlap(10, 20, 45, 48)).toBe(false);
    expect(rangesOverlap(100, 110, 45, 48)).toBe(false);
  });

  it('should return true at exact boundaries', () => {
    expect(rangesOverlap(45, 45, 45, 48)).toBe(true);
    expect(rangesOverlap(48, 48, 45, 48)).toBe(true);
  });
});

describe('findMatchingGap - NEW coordinates priority', () => {
  it('should check NEW coordinates FIRST (critical: AI suggestions target NEW lines)', () => {
    // Gap has OLD range 45-48, NEW range 47-50 (offset of 2)
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 50 is outside OLD range (45-48) but inside NEW range (47-50)
    // Should match via NEW coords since that's checked first
    const result = findMatchingGap(gapRows, 50, 50);

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
    expect(result.coords.gapStartNew).toBe(47);
    expect(result.coords.gapEndNew).toBe(50);
  });

  it('should match NEW coords even when line is also in OLD range', () => {
    // When a line is in both ranges, NEW should take priority
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 47 is in OLD range (45-48) AND NEW range (47-50)
    // Should match via NEW because that's checked first
    const result = findMatchingGap(gapRows, 47, 47);

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should fall back to OLD coords when not in NEW range', () => {
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 45-46 is in OLD range (45-48) but NOT in NEW range (47-50)
    const result = findMatchingGap(gapRows, 45, 46);

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(false);
  });
});

describe('findMatchingGap - OLD coordinates fallback', () => {
  it('should match suggestion line within OLD range', () => {
    // Gap covers OLD lines 45-48 (no NEW offset specified)
    const gapRow = createMockGapRow(45, 48);
    const gapRows = [gapRow];

    // Suggestion targets line 46 (within OLD range 45-48)
    const result = findMatchingGap(gapRows, 46, 46);

    expect(result).not.toBeNull();
    // With no offset, OLD and NEW are the same, so it will match NEW first
    // But the key point is it matches
    expect(result.controls.dataset.startLine).toBe('45');
    expect(result.controls.dataset.endLine).toBe('48');
  });

  it('should match suggestion spanning multiple lines within OLD range', () => {
    const gapRow = createMockGapRow(45, 48);
    const gapRows = [gapRow];

    // Suggestion targets lines 46-47 (within OLD range 45-48)
    const result = findMatchingGap(gapRows, 46, 47);

    expect(result).not.toBeNull();
  });

  it('should match when suggestion overlaps gap boundary', () => {
    const gapRow = createMockGapRow(45, 48);
    const gapRows = [gapRow];

    // Suggestion starts at line 44, ends at 46 (overlaps gap start)
    const result = findMatchingGap(gapRows, 44, 46);

    expect(result).not.toBeNull();
  });
});

describe('findMatchingGap - NEW coordinates regression tests', () => {
  it('should match suggestion line within NEW range but outside OLD range', () => {
    // Gap has OLD range 45-48, NEW range 47-50 (offset of 2)
    // This happens when lines were added before the gap
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Suggestion targets NEW line 50
    // Line 50 is NOT within OLD range (45-48) but IS within NEW range (47-50)
    const result = findMatchingGap(gapRows, 50, 50);

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should match suggestion line 49 within NEW range 47-50 but outside OLD range 45-48', () => {
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 49 is outside OLD range (45-48) but inside NEW range (47-50)
    const result = findMatchingGap(gapRows, 49, 49);

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should handle negative offset when lines were deleted', () => {
    // Gap has OLD range 45-48, NEW range 43-46 (offset of -2)
    // This happens when lines were deleted before the gap
    const gapRow = createMockGapRow(45, 48, 43);
    const gapRows = [gapRow];

    // Suggestion on NEW line 44 (within NEW range 43-46)
    // Line 44 is NOT in OLD range (45-48), so it matches via NEW coords
    const result = findMatchingGap(gapRows, 44, 44);

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should handle suggestion on NEW line outside OLD range with negative offset', () => {
    // Gap has OLD range 45-48, NEW range 43-46 (offset of -2)
    const gapRow = createMockGapRow(45, 48, 43);
    const gapRows = [gapRow];

    // Suggestion on NEW line 43 (within NEW range 43-46 but outside OLD range 45-48)
    const result = findMatchingGap(gapRows, 43, 43);

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });
});

describe('convertNewToOldCoords', () => {
  it('should convert NEW coordinates to OLD coordinates for expansion', () => {
    const gapRow = createMockGapRow(45, 48, 47);
    const controls = gapRow.expandControls;

    // Suggestion on NEW line 50
    const converted = convertNewToOldCoords(controls, 50, 50);

    // With offset of 2 (47 - 45), line 50 becomes 48
    expect(converted.offset).toBe(2);
    expect(converted.targetLineStart).toBe(48);
    expect(converted.targetLineEnd).toBe(48);
  });

  it('should convert multi-line suggestion from NEW to OLD coordinates', () => {
    const gapRow = createMockGapRow(45, 48, 47);
    const controls = gapRow.expandControls;

    // Suggestion spanning NEW lines 49-50
    const converted = convertNewToOldCoords(controls, 49, 50);

    expect(converted.offset).toBe(2);
    expect(converted.targetLineStart).toBe(47);
    expect(converted.targetLineEnd).toBe(48);
  });

  it('should handle negative offset conversion', () => {
    const gapRow = createMockGapRow(45, 48, 43);
    const controls = gapRow.expandControls;

    // NEW line 44 with offset of -2 becomes OLD line 46
    const converted = convertNewToOldCoords(controls, 44, 44);

    expect(converted.offset).toBe(-2);
    expect(converted.targetLineStart).toBe(46);
    expect(converted.targetLineEnd).toBe(46);
  });
});

describe('findMatchingGap - no match scenarios', () => {
  it('should return null when suggestion line is outside both ranges', () => {
    // Gap covers OLD lines 45-48, NEW lines 47-50
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Suggestion targets line 100 - outside both ranges
    const result = findMatchingGap(gapRows, 100, 100);

    expect(result).toBeNull();
  });

  it('should return null when suggestion is before gap ranges', () => {
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Suggestion targets line 10 - before gap
    const result = findMatchingGap(gapRows, 10, 10);

    expect(result).toBeNull();
  });

  it('should return null when gap has no controls', () => {
    const gapRow = { expandControls: null };
    const gapRows = [gapRow];

    const result = findMatchingGap(gapRows, 46, 46);

    expect(result).toBeNull();
  });

  it('should return null for empty gap list', () => {
    const result = findMatchingGap([], 46, 46);

    expect(result).toBeNull();
  });
});

describe('findMatchingGap - multiple gaps', () => {
  it('should select correct gap when multiple gaps exist', () => {
    // First gap: OLD 10-20, NEW 10-20 (no offset)
    const gap1 = createMockGapRow(10, 20);
    // Second gap: OLD 45-48, NEW 47-50 (offset 2)
    const gap2 = createMockGapRow(45, 48, 47);
    // Third gap: OLD 100-110, NEW 105-115 (offset 5)
    const gap3 = createMockGapRow(100, 110, 105);

    const gapRows = [gap1, gap2, gap3];

    // Suggestion on NEW line 50 should match gap2
    const result = findMatchingGap(gapRows, 50, 50);

    expect(result).not.toBeNull();
    expect(result.controls.dataset.startLine).toBe('45');
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should match first gap when suggestion is in OLD range', () => {
    const gap1 = createMockGapRow(10, 20);
    const gap2 = createMockGapRow(45, 48, 47);

    const gapRows = [gap1, gap2];

    // Suggestion on line 15 should match gap1 via NEW (same as OLD with no offset)
    const result = findMatchingGap(gapRows, 15, 15);

    expect(result).not.toBeNull();
    expect(result.controls.dataset.startLine).toBe('10');
  });

  it('should stop at first matching gap (NEW first, then OLD)', () => {
    // Both gaps could match via different coordinate systems
    // gap1: OLD 45-50, NEW 45-50 (no offset)
    // gap2: OLD 60-70, NEW 45-55 (gap2's NEW overlaps gap1's range)
    const gap1 = createMockGapRow(45, 50);
    const gap2 = createMockGapRow(60, 70, 45);

    const gapRows = [gap1, gap2];

    // Suggestion on line 48 - matches gap1 via NEW (same as OLD)
    const result = findMatchingGap(gapRows, 48, 48);

    expect(result).not.toBeNull();
    expect(result.controls.dataset.startLine).toBe('45');
    expect(result.controls.dataset.endLine).toBe('50');
  });
});

describe('findMatchingGap - edge cases', () => {
  it('should handle missing startLineNew (fallback to OLD)', () => {
    // Gap without startLineNew - should treat NEW same as OLD
    const gapRow = createMockGapRow(45, 48);
    const gapRows = [gapRow];

    // Line 46 is in both OLD (45-48) and NEW (45-48, same as OLD) range
    const result = findMatchingGap(gapRows, 46, 46);

    expect(result).not.toBeNull();
    // With zero offset, the first check (NEW) will match
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should handle zero offset (OLD and NEW are same)', () => {
    const gapRow = createMockGapRow(45, 48, 45);
    const gapRows = [gapRow];

    const result = findMatchingGap(gapRows, 46, 46);

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true); // NEW is checked first
  });

  it('should handle single-line gap', () => {
    // Gap covers only line 50
    const gapRow = createMockGapRow(50, 50, 52);
    const gapRows = [gapRow];

    // Suggestion on NEW line 52 (OLD line 50)
    const result = findMatchingGap(gapRows, 52, 52);

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should handle suggestion exactly at gap boundary', () => {
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Suggestion at exact NEW boundary (line 47)
    const resultNewStart = findMatchingGap(gapRows, 47, 47);
    expect(resultNewStart).not.toBeNull();
    expect(resultNewStart.matchedInNewCoords).toBe(true);

    // Suggestion at line 45 - in OLD range (45-48) but NOT in NEW range (47-50)
    const resultOldOnly = findMatchingGap(gapRows, 45, 45);
    expect(resultOldOnly).not.toBeNull();
    expect(resultOldOnly.matchedInNewCoords).toBe(false);
  });
});
