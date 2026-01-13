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
function createMockGapRow(startLine, endLine, startLineNew = null, endLineNew = null) {
  const dataset = {
    startLine: String(startLine),
    endLine: String(endLine)
  };
  if (startLineNew !== null) {
    dataset.startLineNew = String(startLineNew);
  }
  if (endLineNew !== null) {
    dataset.endLineNew = String(endLineNew);
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

describe('findMatchingGap - NEW coordinates (side=RIGHT)', () => {
  it('should match via NEW coordinates when side is RIGHT', () => {
    // Gap has OLD range 45-48, NEW range 47-50 (offset of 2)
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 50 is outside OLD range (45-48) but inside NEW range (47-50)
    // Should match via NEW coords with side='RIGHT'
    const result = findMatchingGap(gapRows, 50, 50, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
    expect(result.coords.gapStartNew).toBe(47);
    expect(result.coords.gapEndNew).toBe(50);
  });

  it('should match NEW coords when line is in both ranges with side=RIGHT', () => {
    // When a line is in both ranges, side='RIGHT' uses NEW
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 47 is in OLD range (45-48) AND NEW range (47-50)
    // Should match via NEW with side='RIGHT'
    const result = findMatchingGap(gapRows, 47, 47, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should match OLD coords when side is LEFT', () => {
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 45-46 is in OLD range (45-48) but NOT in NEW range (47-50)
    // With side='LEFT', should match via OLD coords
    const result = findMatchingGap(gapRows, 45, 46, 'LEFT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(false);
  });
});

describe('findMatchingGap - OLD coordinates (side=LEFT)', () => {
  it('should match suggestion line within OLD range with side=LEFT', () => {
    // Gap covers OLD lines 45-48 (no NEW offset specified)
    const gapRow = createMockGapRow(45, 48);
    const gapRows = [gapRow];

    // Suggestion targets line 46 (within OLD range 45-48)
    // With side='LEFT', should match via OLD coords
    const result = findMatchingGap(gapRows, 46, 46, 'LEFT');

    expect(result).not.toBeNull();
    expect(result.controls.dataset.startLine).toBe('45');
    expect(result.controls.dataset.endLine).toBe('48');
  });

  it('should match suggestion line within range with side=RIGHT when no offset', () => {
    // Gap covers OLD lines 45-48 (no NEW offset specified, so NEW equals OLD)
    const gapRow = createMockGapRow(45, 48);
    const gapRows = [gapRow];

    // Suggestion targets line 46 (within both OLD and NEW range 45-48)
    // With side='RIGHT', should match via NEW coords (same as OLD with no offset)
    const result = findMatchingGap(gapRows, 46, 46, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should match suggestion spanning multiple lines within OLD range with side=LEFT', () => {
    const gapRow = createMockGapRow(45, 48);
    const gapRows = [gapRow];

    // Suggestion targets lines 46-47 (within OLD range 45-48)
    const result = findMatchingGap(gapRows, 46, 47, 'LEFT');

    expect(result).not.toBeNull();
  });

  it('should match when suggestion overlaps gap boundary with side=LEFT', () => {
    const gapRow = createMockGapRow(45, 48);
    const gapRows = [gapRow];

    // Suggestion starts at line 44, ends at 46 (overlaps gap start)
    const result = findMatchingGap(gapRows, 44, 46, 'LEFT');

    expect(result).not.toBeNull();
  });
});

describe('findMatchingGap - NEW coordinates regression tests', () => {
  it('should match suggestion line within NEW range but outside OLD range with side=RIGHT', () => {
    // Gap has OLD range 45-48, NEW range 47-50 (offset of 2)
    // This happens when lines were added before the gap
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Suggestion targets NEW line 50
    // Line 50 is NOT within OLD range (45-48) but IS within NEW range (47-50)
    const result = findMatchingGap(gapRows, 50, 50, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should match suggestion line 49 within NEW range 47-50 but outside OLD range 45-48 with side=RIGHT', () => {
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 49 is outside OLD range (45-48) but inside NEW range (47-50)
    const result = findMatchingGap(gapRows, 49, 49, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should handle negative offset when lines were deleted with side=RIGHT', () => {
    // Gap has OLD range 45-48, NEW range 43-46 (offset of -2)
    // This happens when lines were deleted before the gap
    const gapRow = createMockGapRow(45, 48, 43);
    const gapRows = [gapRow];

    // Suggestion on NEW line 44 (within NEW range 43-46)
    // Line 44 is NOT in OLD range (45-48), so it matches via NEW coords
    const result = findMatchingGap(gapRows, 44, 44, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should handle suggestion on NEW line outside OLD range with negative offset and side=RIGHT', () => {
    // Gap has OLD range 45-48, NEW range 43-46 (offset of -2)
    const gapRow = createMockGapRow(45, 48, 43);
    const gapRows = [gapRow];

    // Suggestion on NEW line 43 (within NEW range 43-46 but outside OLD range 45-48)
    const result = findMatchingGap(gapRows, 43, 43, 'RIGHT');

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
  it('should return null when suggestion line is outside NEW range with side=RIGHT', () => {
    // Gap covers OLD lines 45-48, NEW lines 47-50
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Suggestion targets line 100 - outside both ranges
    const result = findMatchingGap(gapRows, 100, 100, 'RIGHT');

    expect(result).toBeNull();
  });

  it('should return null when suggestion is before gap NEW range with side=RIGHT', () => {
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Suggestion targets line 10 - before gap
    const result = findMatchingGap(gapRows, 10, 10, 'RIGHT');

    expect(result).toBeNull();
  });

  it('should return null when gap has no controls', () => {
    const gapRow = { expandControls: null };
    const gapRows = [gapRow];

    const result = findMatchingGap(gapRows, 46, 46, 'RIGHT');

    expect(result).toBeNull();
  });

  it('should return null for empty gap list', () => {
    const result = findMatchingGap([], 46, 46, 'RIGHT');

    expect(result).toBeNull();
  });
});

describe('findMatchingGap - multiple gaps', () => {
  it('should select correct gap when multiple gaps exist with side=RIGHT', () => {
    // First gap: OLD 10-20, NEW 10-20 (no offset)
    const gap1 = createMockGapRow(10, 20);
    // Second gap: OLD 45-48, NEW 47-50 (offset 2)
    const gap2 = createMockGapRow(45, 48, 47);
    // Third gap: OLD 100-110, NEW 105-115 (offset 5)
    const gap3 = createMockGapRow(100, 110, 105);

    const gapRows = [gap1, gap2, gap3];

    // Suggestion on NEW line 50 should match gap2
    const result = findMatchingGap(gapRows, 50, 50, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.controls.dataset.startLine).toBe('45');
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should match first gap when suggestion is in NEW range with side=RIGHT', () => {
    const gap1 = createMockGapRow(10, 20);
    const gap2 = createMockGapRow(45, 48, 47);

    const gapRows = [gap1, gap2];

    // Suggestion on line 15 should match gap1 via NEW (same as OLD with no offset)
    const result = findMatchingGap(gapRows, 15, 15, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.controls.dataset.startLine).toBe('10');
  });

  it('should stop at first matching gap with side=RIGHT', () => {
    // Both gaps could match via NEW coordinate systems
    // gap1: OLD 45-50, NEW 45-50 (no offset)
    // gap2: OLD 60-70, NEW 45-55 (gap2's NEW overlaps gap1's range)
    const gap1 = createMockGapRow(45, 50);
    const gap2 = createMockGapRow(60, 70, 45);

    const gapRows = [gap1, gap2];

    // Suggestion on line 48 - matches gap1 via NEW (same as OLD)
    const result = findMatchingGap(gapRows, 48, 48, 'RIGHT');

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

  it('should find gap containing lines when gapEnd is EOF_SENTINEL with side=RIGHT', () => {
    // Gap from line 45 to EOF (represented as -1)
    // With startLineNew=47, the NEW range would be 47 to -1+2=1 which is invalid
    // However, rangesOverlap should handle this by checking if suggestion is >= gapStart
    const gapRow = createMockGapRow(45, EOF_SENTINEL, 47);
    const gapRows = [gapRow];

    // Suggestion on line 50 - should not match because NEW range (47 to 1) doesn't make sense
    // Line 50 is >= 45 (gapStart) and the gap extends to EOF
    // However, rangesOverlap(50, 50, 47, 1) returns false because 50 > 1
    // This means the gap won't match until EOF_SENTINEL is resolved
    const result = findMatchingGap(gapRows, 50, 50, 'RIGHT');

    expect(result).toBeNull(); // Current behavior - needs resolution first
  });

  it('should correctly match lines in EOF gap after resolution with side=RIGHT', () => {
    // After EOF_SENTINEL is resolved to actual file length (e.g., 100),
    // the gap coordinates become valid
    const actualFileLength = 100;
    const gapRow = createMockGapRow(45, actualFileLength, 47);
    const gapRows = [gapRow];

    // Suggestion on line 50 - inside the resolved gap (45-100 OLD, 47-102 NEW)
    const result = findMatchingGap(gapRows, 50, 50, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
    expect(result.coords.gapEnd).toBe(100);
  });

  it('should handle suggestion at end of file after EOF_SENTINEL resolution with side=RIGHT', () => {
    // File has 100 lines, gap is from 45 to EOF (resolved to 100)
    const actualFileLength = 100;
    const gapRow = createMockGapRow(45, actualFileLength, 47);
    const gapRows = [gapRow];

    // Suggestion on line 102 (NEW coords) - at the very end of the file
    // NEW range is 47-102, so line 102 should match
    const result = findMatchingGap(gapRows, 102, 102, 'RIGHT');

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

  it('should return null when side is not provided (requires explicit side)', () => {
    // Gap has OLD range 45-48, NEW range 47-50 (offset of 2)
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 45 is in OLD range only - without explicit side, no match occurs
    const result = findMatchingGap(gapRows, 45, 45);

    // With required side parameter, undefined side means no coordinate system is checked
    expect(result).toBeNull();
  });

  it('should return null when side is null (requires explicit side)', () => {
    // Gap has OLD range 45-48, NEW range 47-50 (offset of 2)
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Line 50 is in NEW range - but null is not a valid side value
    const result = findMatchingGap(gapRows, 50, 50, null);

    // With required side parameter, null side means no coordinate system is checked
    expect(result).toBeNull();
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
  it('should handle missing startLineNew with side=RIGHT (NEW equals OLD)', () => {
    // Gap without startLineNew - should treat NEW same as OLD
    const gapRow = createMockGapRow(45, 48);
    const gapRows = [gapRow];

    // Line 46 is in both OLD (45-48) and NEW (45-48, same as OLD) range
    const result = findMatchingGap(gapRows, 46, 46, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should handle zero offset (OLD and NEW are same) with side=RIGHT', () => {
    const gapRow = createMockGapRow(45, 48, 45);
    const gapRows = [gapRow];

    const result = findMatchingGap(gapRows, 46, 46, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should handle single-line gap with side=RIGHT', () => {
    // Gap covers only line 50
    const gapRow = createMockGapRow(50, 50, 52);
    const gapRows = [gapRow];

    // Suggestion on NEW line 52 (OLD line 50)
    const result = findMatchingGap(gapRows, 52, 52, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should handle suggestion exactly at gap boundary', () => {
    const gapRow = createMockGapRow(45, 48, 47);
    const gapRows = [gapRow];

    // Suggestion at exact NEW boundary (line 47) with side=RIGHT
    const resultNewStart = findMatchingGap(gapRows, 47, 47, 'RIGHT');
    expect(resultNewStart).not.toBeNull();
    expect(resultNewStart.matchedInNewCoords).toBe(true);

    // Suggestion at line 45 - in OLD range (45-48) but NOT in NEW range (47-50)
    // With side=LEFT, should match
    const resultOldOnly = findMatchingGap(gapRows, 45, 45, 'LEFT');
    expect(resultOldOnly).not.toBeNull();
    expect(resultOldOnly.matchedInNewCoords).toBe(false);
  });
});

describe('Start-of-file gap offset handling', () => {
  // These tests verify the fix for the start-of-file gap offset bug.
  // When the first hunk has different starting line numbers for OLD and NEW
  // (e.g., @@ -10,5 +12,7 @@), the gap before the first hunk needs to correctly
  // specify endLineNew so that findMatchingGap can match suggestions in the NEW range.
  //
  // For start-of-file gaps, both OLD and NEW start at line 1, but may end at different
  // lines. This is a non-uniform offset case that requires explicit endLineNew.

  it('should handle start-of-file gap with zero offset (OLD=5, NEW=5)', () => {
    // First hunk is @@ -5,3 +5,3 @@ (both start at line 5)
    // Gap covers lines 1-4 in both OLD and NEW
    // Both startLineNew and endLineNew equal OLD values (no offset)
    const gapRow = createMockGapRow(1, 4, 1, 4);
    const coords = getGapCoordinates(gapRow.expandControls);

    expect(coords.gapStart).toBe(1);
    expect(coords.gapEnd).toBe(4);
    expect(coords.gapStartNew).toBe(1);
    expect(coords.gapEndNew).toBe(4);
    expect(coords.offset).toBe(0);
  });

  it('should handle start-of-file gap with positive offset (OLD=10, NEW=12)', () => {
    // First hunk is @@ -10,5 +12,7 @@ (NEW starts 2 lines later)
    // OLD gap covers lines 1-9, NEW gap covers lines 1-11
    // Both start at 1, but end at different lines (non-uniform offset)
    const gapRow = createMockGapRow(1, 9, 1, 11);
    const coords = getGapCoordinates(gapRow.expandControls);

    expect(coords.gapStart).toBe(1);
    expect(coords.gapEnd).toBe(9);
    expect(coords.gapStartNew).toBe(1);
    expect(coords.gapEndNew).toBe(11);  // Explicitly specified
    expect(coords.offset).toBe(0);       // Start offset is 0 (both start at 1)
  });

  it('should handle start-of-file gap with negative offset (OLD=12, NEW=10)', () => {
    // First hunk is @@ -12,5 +10,3 @@ (NEW starts 2 lines earlier)
    // OLD gap covers lines 1-11, NEW gap covers lines 1-9
    // Both start at 1, but end at different lines
    const gapRow = createMockGapRow(1, 11, 1, 9);
    const coords = getGapCoordinates(gapRow.expandControls);

    expect(coords.gapStart).toBe(1);
    expect(coords.gapEnd).toBe(11);
    expect(coords.gapStartNew).toBe(1);
    expect(coords.gapEndNew).toBe(9);   // Explicitly specified
    expect(coords.offset).toBe(0);       // Start offset is 0 (both start at 1)
  });

  it('should match suggestion in NEW range with positive offset and side=RIGHT', () => {
    // First hunk is @@ -10,5 +12,7 @@
    // OLD gap: 1-9, NEW gap: 1-11
    const gapRow = createMockGapRow(1, 9, 1, 11);
    const gapRows = [gapRow];

    // Suggestion on NEW line 10 (within NEW range 1-11, but outside OLD range 1-9)
    const result = findMatchingGap(gapRows, 10, 10, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
    expect(result.coords.gapEndNew).toBe(11);
  });

  it('should match suggestion in NEW range with negative offset and side=RIGHT', () => {
    // First hunk is @@ -12,5 +10,3 @@
    // OLD gap: 1-11, NEW gap: 1-9
    const gapRow = createMockGapRow(1, 11, 1, 9);
    const gapRows = [gapRow];

    // Suggestion on NEW line 8 (within NEW range 1-9, and also within OLD range 1-11)
    const result = findMatchingGap(gapRows, 8, 8, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
    expect(result.coords.gapEndNew).toBe(9);
  });

  it('should NOT match suggestion outside NEW range with negative offset and side=RIGHT', () => {
    // First hunk is @@ -12,5 +10,3 @@
    // OLD gap: 1-11, NEW gap: 1-9
    const gapRow = createMockGapRow(1, 11, 1, 9);
    const gapRows = [gapRow];

    // Suggestion on line 10 (inside OLD range 1-11, but OUTSIDE NEW range 1-9)
    // With side='RIGHT', this should NOT match
    const result = findMatchingGap(gapRows, 10, 10, 'RIGHT');

    expect(result).toBeNull();
  });

  it('should match suggestion via OLD coords when side=LEFT', () => {
    // First hunk is @@ -12,5 +10,3 @@
    // OLD gap: 1-11, NEW gap: 1-9
    const gapRow = createMockGapRow(1, 11, 1, 9);
    const gapRows = [gapRow];

    // Suggestion on line 10 (inside OLD range 1-11, but outside NEW range 1-9)
    // With side='LEFT', should match via OLD coords
    const result = findMatchingGap(gapRows, 10, 10, 'LEFT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(false);  // Matched via OLD coords
  });

  it('should convert NEW coords to OLD for start-of-file gap with positive offset', () => {
    // First hunk is @@ -10,5 +12,7 @@
    // OLD gap: 1-9, NEW gap: 1-11
    // Note: offset is 0 since both start at 1, so conversion is identity
    const gapRow = createMockGapRow(1, 9, 1, 11);
    const controls = gapRow.expandControls;

    // Suggestion on NEW line 8, converts to OLD line 8 (offset is 0)
    const converted = convertNewToOldCoords(controls, 8, 8);

    expect(converted.offset).toBe(0);
    expect(converted.targetLineStart).toBe(8);  // 8 - 0 = 8
    expect(converted.targetLineEnd).toBe(8);
  });

  it('should convert NEW coords to OLD for start-of-file gap with negative offset', () => {
    // First hunk is @@ -12,5 +10,3 @@
    // OLD gap: 1-11, NEW gap: 1-9
    // Note: offset is 0 since both start at 1, so conversion is identity
    const gapRow = createMockGapRow(1, 11, 1, 9);
    const controls = gapRow.expandControls;

    // Suggestion on NEW line 8, converts to OLD line 8 (offset is 0)
    const converted = convertNewToOldCoords(controls, 8, 8);

    expect(converted.offset).toBe(0);
    expect(converted.targetLineStart).toBe(8);  // 8 - 0 = 8
    expect(converted.targetLineEnd).toBe(8);
  });

  it('should handle suggestion spanning lines 1-5 in start-of-file gap with side=RIGHT', () => {
    // First hunk is @@ -10,5 +12,7 @@
    // OLD gap: 1-9, NEW gap: 1-11
    const gapRow = createMockGapRow(1, 9, 1, 11);
    const gapRows = [gapRow];

    // Multi-line suggestion on NEW lines 1-5
    const result = findMatchingGap(gapRows, 1, 5, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should handle suggestion at the very start of file (line 1) with side=RIGHT', () => {
    // First hunk is @@ -5,3 +7,5 @@
    // OLD gap: 1-4, NEW gap: 1-6
    const gapRow = createMockGapRow(1, 4, 1, 6);
    const gapRows = [gapRow];

    // Suggestion on NEW line 1
    const result = findMatchingGap(gapRows, 1, 1, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
  });

  it('should handle suggestion at end of NEW gap range with side=RIGHT', () => {
    // First hunk is @@ -5,3 +7,5 @@
    // OLD gap: 1-4, NEW gap: 1-6
    const gapRow = createMockGapRow(1, 4, 1, 6);
    const gapRows = [gapRow];

    // Suggestion on NEW line 6 (boundary of NEW range)
    const result = findMatchingGap(gapRows, 6, 6, 'RIGHT');

    expect(result).not.toBeNull();
    expect(result.matchedInNewCoords).toBe(true);
    expect(result.coords.gapEndNew).toBe(6);
  });

  it('should NOT match suggestion just outside NEW gap range', () => {
    // First hunk is @@ -5,3 +7,5 @@
    // OLD gap: 1-4, NEW gap: 1-6
    const gapRow = createMockGapRow(1, 4, 1, 6);
    const gapRows = [gapRow];

    // Suggestion on NEW line 7 (just outside NEW range, at hunk start)
    const result = findMatchingGap(gapRows, 7, 7, 'RIGHT');

    expect(result).toBeNull();
  });

  it('should use explicit endLineNew over computed value', () => {
    // Test that endLineNew takes precedence over offset-based computation
    // If startLineNew = 47 and endLine = 48, computed gapEndNew would be 50
    // But if endLineNew = 55 is specified, that should be used instead
    const gapRow = createMockGapRow(45, 48, 47, 55);
    const coords = getGapCoordinates(gapRow.expandControls);

    expect(coords.gapStart).toBe(45);
    expect(coords.gapEnd).toBe(48);
    expect(coords.gapStartNew).toBe(47);
    expect(coords.gapEndNew).toBe(55);  // Explicit value, not 50 (computed)
    expect(coords.offset).toBe(2);       // Still computed from startLineNew
  });

  it('should fall back to computed gapEndNew when endLineNew not specified', () => {
    // Without endLineNew, should compute from offset
    const gapRow = createMockGapRow(45, 48, 47);  // No endLineNew
    const coords = getGapCoordinates(gapRow.expandControls);

    expect(coords.gapStart).toBe(45);
    expect(coords.gapEnd).toBe(48);
    expect(coords.gapStartNew).toBe(47);
    expect(coords.gapEndNew).toBe(50);  // Computed: 48 + (47 - 45) = 50
    expect(coords.offset).toBe(2);
  });
});
