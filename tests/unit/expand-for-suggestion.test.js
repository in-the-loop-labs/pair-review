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

describe('EOF_SENTINEL handling', () => {
  // EOF_SENTINEL is -1, used for end-of-file gaps with unknown size
  const EOF_SENTINEL = -1;

  it('should parse EOF_SENTINEL (-1) as gapEnd', () => {
    // When a gap extends to end of file, gapEnd is EOF_SENTINEL
    const gapRow = createMockGapRow(45, EOF_SENTINEL, 47);
    const coords = getGapCoordinates(gapRow.expandControls);

    expect(coords.gapStart).toBe(45);
    expect(coords.gapEnd).toBe(EOF_SENTINEL);
    expect(coords.gapStartNew).toBe(47);
    // gapEndNew = gapEnd + offset = -1 + 2 = 1 (this is wrong, but expected before resolution)
    expect(coords.gapEndNew).toBe(1);
  });

  it('should produce negative gapSize when gapEnd is EOF_SENTINEL (bug demonstration)', () => {
    // This test documents the bug behavior before fix in expandForSuggestion
    // gapSize = gapEnd - gapStart + 1 = -1 - 45 + 1 = -45
    const gapRow = createMockGapRow(45, EOF_SENTINEL);
    const coords = getGapCoordinates(gapRow.expandControls);

    const gapSize = coords.gapEnd - coords.gapStart + 1;
    expect(gapSize).toBe(-45); // This is the bug - should be resolved first
  });

  it('should find gap containing lines when gapEnd is EOF_SENTINEL', () => {
    // Gap from line 45 to EOF (represented as -1)
    // With startLineNew=47, the NEW range would be 47 to -1+2=1 which is invalid
    // However, rangesOverlap should handle this by checking if suggestion is >= gapStart
    const gapRow = createMockGapRow(45, EOF_SENTINEL, 47);
    const gapRows = [gapRow];

    // Suggestion on line 50 - should match via OLD coords fallback
    // since NEW range (47 to 1) doesn't make sense
    const result = findMatchingGap(gapRows, 50, 50);

    // Line 50 is >= 45 (gapStart) and the gap extends to EOF
    // However, rangesOverlap(50, 50, 45, -1) returns false because 50 > -1
    // This means the gap won't match until EOF_SENTINEL is resolved
    expect(result).toBeNull(); // Current behavior - needs resolution first
  });

  it('should correctly match lines in EOF gap after resolution', () => {
    // After EOF_SENTINEL is resolved to actual file length (e.g., 100),
    // the gap coordinates become valid
    const actualFileLength = 100;
    const gapRow = createMockGapRow(45, actualFileLength, 47);
    const gapRows = [gapRow];

    // Suggestion on line 50 - inside the resolved gap (45-100 OLD, 47-102 NEW)
    const result = findMatchingGap(gapRows, 50, 50);

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
    expect(result.coords.gapEnd).toBe(100);
  });

  it('should handle suggestion at end of file after EOF_SENTINEL resolution', () => {
    // File has 100 lines, gap is from 45 to EOF (resolved to 100)
    const actualFileLength = 100;
    const gapRow = createMockGapRow(45, actualFileLength, 47);
    const gapRows = [gapRow];

    // Suggestion on line 102 (NEW coords) - at the very end of the file
    // NEW range is 47-102, so line 102 should match
    const result = findMatchingGap(gapRows, 102, 102);

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should convert coordinates correctly for EOF gap after resolution', () => {
    // After resolution: OLD range 45-100, NEW range 47-102
    const actualFileLength = 100;
    const gapRow = createMockGapRow(45, actualFileLength, 47);

    // Suggestion at NEW line 100, should convert to OLD line 98
    const converted = convertNewToOldCoords(gapRow.expandControls, 100, 100);

    expect(converted.offset).toBe(2);
    expect(converted.targetLineStart).toBe(98);
    expect(converted.targetLineEnd).toBe(98);
  });
});

describe('findMatchingGap - side parameter', () => {
  it('should match only NEW coordinates when side is RIGHT', () => {
    // Gap has OLD range 45-48, NEW range 47-50 (offset of 2)
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 50 is in NEW range (47-50) but NOT in OLD range (45-48)
    // With side='RIGHT', should match via NEW coords
    const result = findMatchingGap(gapRows, 50, 50, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should NOT fall back to OLD coordinates when side is RIGHT', () => {
    // Gap has OLD range 45-48, NEW range 47-50 (offset of 2)
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 45 is in OLD range (45-48) but NOT in NEW range (47-50)
    // With side='RIGHT', should NOT match because we only check NEW
    const result = findMatchingGap(gapRows, 45, 45, 'RIGHT');

    expect(result).toBeNull();
  });

  it('should match only OLD coordinates when side is LEFT', () => {
    // Gap has OLD range 45-48, NEW range 47-50 (offset of 2)
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 45-46 is in OLD range (45-48) but NOT in NEW range (47-50)
    // With side='LEFT', should match via OLD coords
    const result = findMatchingGap(gapRows, 45, 46, 'LEFT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(false);
  });

  it('should NOT fall back to NEW coordinates when side is LEFT', () => {
    // Gap has OLD range 45-48, NEW range 47-50 (offset of 2)
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 50 is in NEW range (47-50) but NOT in OLD range (45-48)
    // With side='LEFT', should NOT match because we only check OLD
    const result = findMatchingGap(gapRows, 50, 50, 'LEFT');

    expect(result).toBeNull();
  });

  it('should use legacy behavior when side is null', () => {
    // Gap has OLD range 45-48, NEW range 47-50 (offset of 2)
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 45 is in OLD range only - legacy behavior checks NEW first, then OLD
    const result = findMatchingGap(gapRows, 45, 45, null);

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(false); // Matched via OLD fallback
  });

  it('should use legacy behavior when side is undefined', () => {
    // Gap has OLD range 45-48, NEW range 47-50 (offset of 2)
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 50 is in NEW range - legacy behavior checks NEW first
    const result = findMatchingGap(gapRows, 50, 50);

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true); // Matched via NEW (checked first)
  });

  it('asymmetric case: RIGHT side suggestion finds gap via NEW coords only', () => {
    // This is the bug scenario: a gap where OLD and NEW ranges are different,
    // and a RIGHT side suggestion targets a line in the NEW range
    //
    // Gap: OLD 100-110, NEW 120-130 (offset of 20 due to added lines)
    const gapRow = createMockGapRow(100, 110, 120);
    const gapRows = [gapRow];

    // AI suggestion targets NEW line 125 (e.g., a comment on added code)
    // This line does NOT exist in OLD range (100-110)
    // Without side parameter or with wrong coordinate matching, this would fail
    const result = findMatchingGap(gapRows, 125, 125, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
    expect(result.coords.gapStartNew).toBe(120);
    expect(result.coords.gapEndNew).toBe(130);
  });

  it('asymmetric case: LEFT side suggestion finds gap via OLD coords only', () => {
    // A LEFT side suggestion (deleted line) uses OLD coordinates
    //
    // Gap: OLD 100-110, NEW 120-130 (offset of 20)
    const gapRow = createMockGapRow(100, 110, 120);
    const gapRows = [gapRow];

    // AI suggestion targets OLD line 105 (e.g., a comment on deleted code)
    // This line does NOT exist in NEW range (120-130)
    const result = findMatchingGap(gapRows, 105, 105, 'LEFT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(false);
    expect(result.coords.gapStart).toBe(100);
    expect(result.coords.gapEnd).toBe(110);
  });

  it('should handle multiple gaps with side=RIGHT', () => {
    // Gap1: OLD 10-20, NEW 10-20 (no offset)
    // Gap2: OLD 100-110, NEW 120-130 (offset 20)
    const gap1 = createMockGapRow(10, 20);
    const gap2 = createMockGapRow(100, 110, 120);
    const gapRows = [gap1, gap2];

    // RIGHT side suggestion on NEW line 125 should match gap2
    const result = findMatchingGap(gapRows, 125, 125, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.coords.gapStart).toBe(100);
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should handle multiple gaps with side=LEFT', () => {
    // Gap1: OLD 10-20, NEW 10-20 (no offset)
    // Gap2: OLD 100-110, NEW 120-130 (offset 20)
    const gap1 = createMockGapRow(10, 20);
    const gap2 = createMockGapRow(100, 110, 120);
    const gapRows = [gap1, gap2];

    // LEFT side suggestion on OLD line 105 should match gap2
    const result = findMatchingGap(gapRows, 105, 105, 'LEFT');

    expect(result).not.toBeNull();
    expect(result.coords.gapStart).toBe(100);
    expect(result.matchedInNewCoords).toBe(false);
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
