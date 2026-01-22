// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';

/**
 * Unit tests for HunkParser - Hunk header parsing and gap context expansion
 * Focuses on static properties and pure logic functions
 * DOM-creating functions are tested via E2E tests
 */

// Import the actual HunkParser module from production code
const { HunkParser } = require('../../public/js/modules/hunk-parser.js');

describe('HunkParser', () => {
  describe('static constants', () => {
    it('should have EOF_SENTINEL defined as -1', () => {
      expect(HunkParser.EOF_SENTINEL).toBe(-1);
    });

    it('should have DEFAULT_EXPAND_LINES defined as 20', () => {
      expect(HunkParser.DEFAULT_EXPAND_LINES).toBe(20);
    });

    it('should have SMALL_GAP_THRESHOLD defined as 10', () => {
      expect(HunkParser.SMALL_GAP_THRESHOLD).toBe(10);
    });

    it('should have AUTO_EXPAND_THRESHOLD defined as 6', () => {
      expect(HunkParser.AUTO_EXPAND_THRESHOLD).toBe(6);
    });

    it('should have SVG icon strings defined', () => {
      expect(typeof HunkParser.FOLD_UP_ICON).toBe('string');
      expect(typeof HunkParser.FOLD_DOWN_ICON).toBe('string');
      expect(typeof HunkParser.UNFOLD_ICON).toBe('string');
    });
  });

  describe('extractFunctionContext', () => {
    it('should extract function name from hunk header', () => {
      expect(HunkParser.extractFunctionContext('@@ -10,5 +10,7 @@ function myFunction()'))
        .toBe('function myFunction()');
    });

    it('should handle hunk header without function context', () => {
      expect(HunkParser.extractFunctionContext('@@ -10,5 +10,7 @@'))
        .toBeNull();
    });

    it('should handle null input', () => {
      expect(HunkParser.extractFunctionContext(null))
        .toBeNull();
    });

    it('should trim whitespace from function context', () => {
      expect(HunkParser.extractFunctionContext('@@ -10,5 +10,7 @@   function foo()  '))
        .toBe('function foo()');
    });

    it('should handle function context with @ symbol in name', () => {
      expect(HunkParser.extractFunctionContext('@@ -10,5 +10,7 @@ @decorator'))
        .toBe('@decorator');
    });
  });

  describe('getBlockCoordinateBounds', () => {
    it('should find first valid old and new coordinates', () => {
      const block = {
        lines: [
          { oldNumber: 10, newNumber: 15 },
          { oldNumber: 11, newNumber: 16 }
        ]
      };
      expect(HunkParser.getBlockCoordinateBounds(block, 'first'))
        .toEqual({ old: 10, new: 15 });
    });

    it('should find last valid old and new coordinates', () => {
      const block = {
        lines: [
          { oldNumber: 10, newNumber: 15 },
          { oldNumber: 11, newNumber: 16 }
        ]
      };
      expect(HunkParser.getBlockCoordinateBounds(block, 'last'))
        .toEqual({ old: 11, new: 16 });
    });

    it('should handle deletion-only lines (no newNumber)', () => {
      const block = {
        lines: [
          { oldNumber: 10 },  // deletion
          { oldNumber: 11, newNumber: 15 }
        ]
      };
      expect(HunkParser.getBlockCoordinateBounds(block, 'first'))
        .toEqual({ old: 10, new: 15 });
    });

    it('should handle insertion-only lines (no oldNumber)', () => {
      const block = {
        lines: [
          { newNumber: 15 },  // insertion
          { oldNumber: 10, newNumber: 16 }
        ]
      };
      expect(HunkParser.getBlockCoordinateBounds(block, 'first'))
        .toEqual({ old: 10, new: 15 });
    });

    it('should return nulls for empty block', () => {
      const block = { lines: [] };
      expect(HunkParser.getBlockCoordinateBounds(block, 'first'))
        .toEqual({ old: null, new: null });
    });
  });

  describe('shouldAutoExpand', () => {
    it('should return true for gaps smaller than AUTO_EXPAND_THRESHOLD', () => {
      expect(HunkParser.shouldAutoExpand(5)).toBe(true);
      expect(HunkParser.shouldAutoExpand(1)).toBe(true);
    });

    it('should return false for gaps equal to AUTO_EXPAND_THRESHOLD', () => {
      expect(HunkParser.shouldAutoExpand(6)).toBe(false);
    });

    it('should return false for gaps larger than AUTO_EXPAND_THRESHOLD', () => {
      expect(HunkParser.shouldAutoExpand(10)).toBe(false);
      expect(HunkParser.shouldAutoExpand(100)).toBe(false);
    });

    it('should return true for EOF_SENTINEL (since -1 < 6)', () => {
      // EOF_SENTINEL is -1, which is less than AUTO_EXPAND_THRESHOLD (6)
      // This means shouldAutoExpand would return true, but in practice
      // this is handled by the validation logic before this check is made
      expect(HunkParser.shouldAutoExpand(HunkParser.EOF_SENTINEL)).toBe(true);
    });
  });

  describe('EOF_SENTINEL usage patterns', () => {
    it('should be a negative number to avoid collision with valid line numbers', () => {
      expect(HunkParser.EOF_SENTINEL).toBeLessThan(0);
    });

    it('should be distinguishable from valid gap sizes', () => {
      // Valid gap sizes are positive integers
      expect(HunkParser.EOF_SENTINEL).not.toBeGreaterThan(0);
    });

    it('should be usable with strict equality check', () => {
      const endLine = HunkParser.EOF_SENTINEL;
      expect(endLine === HunkParser.EOF_SENTINEL).toBe(true);
      expect(endLine === -1).toBe(true);  // Implementation detail
    });
  });
});
