// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for SuggestionManager.getFileAndLineInfo()
 *
 * Tests the extraction of file and line information from AI suggestion elements,
 * including:
 * - Line-level suggestions with stored data attributes
 * - File-level suggestions (isFileLevel: true)
 * - Fallback DOM traversal for legacy suggestions
 *
 * IMPORTANT: These tests import the actual SuggestionManager class from production code
 * to ensure tests verify real behavior, not a reimplementation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Setup global.window before importing production code that assigns to it
global.window = global.window || {};

// Import the actual SuggestionManager class from production code
const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');

/**
 * Create a minimal SuggestionManager instance for testing.
 */
function createTestSuggestionManager() {
  const suggestionManager = Object.create(SuggestionManager.prototype);
  suggestionManager.prManager = null;
  return suggestionManager;
}

/**
 * Create a mock suggestion div element with data attributes
 */
function createMockSuggestionDiv(options = {}) {
  const {
    fileName = '',
    lineNumber = '',
    side = '',
    diffPosition = '',
    isFileLevel = 'false',
    parentRow = null,
    previousRow = null
  } = options;

  const dataset = {
    fileName,
    lineNumber,
    side,
    diffPosition,
    isFileLevel
  };

  // Create a mock element with closest() and dataset
  const mockDiv = {
    dataset,
    closest: vi.fn().mockReturnValue(parentRow)
  };

  return mockDiv;
}

/**
 * Create a mock table row with previousElementSibling chain
 */
function createMockRow(options = {}) {
  const {
    className = '',
    previousSibling = null,
    dataset = {},
    lineNum1 = null,
    lineNum2 = null
  } = options;

  const mockRow = {
    classList: {
      contains: vi.fn((cls) => className.split(' ').includes(cls))
    },
    previousElementSibling: previousSibling,
    dataset: { ...dataset },
    closest: vi.fn().mockReturnValue(null),
    querySelector: vi.fn((selector) => {
      if (selector === '.line-num1' && lineNum1 !== null) {
        return { textContent: String(lineNum1) };
      }
      if (selector === '.line-num2' && lineNum2 !== null) {
        return { textContent: String(lineNum2) };
      }
      return null;
    })
  };

  return mockRow;
}

describe('SuggestionManager.getFileAndLineInfo()', () => {
  describe('Line-level suggestions with stored data', () => {
    it('should return correct values from stored data attributes', () => {
      const suggestionManager = createTestSuggestionManager();

      // Create a diff row (the target) and suggestion row
      const targetRow = createMockRow({
        className: 'd2h-code-linenumber',
        dataset: { diffPosition: '15', side: 'RIGHT' }
      });

      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: targetRow
      });

      const suggestionDiv = createMockSuggestionDiv({
        fileName: 'src/components/Button.js',
        lineNumber: '42',
        side: 'RIGHT',
        diffPosition: '15',
        isFileLevel: 'false',
        parentRow: suggestionRow
      });

      const result = suggestionManager.getFileAndLineInfo(suggestionDiv);

      expect(result.fileName).toBe('src/components/Button.js');
      expect(result.lineNumber).toBe(42); // Should be parsed as integer
      expect(result.side).toBe('RIGHT');
      expect(result.diffPosition).toBe('15');
      expect(result.isFileLevel).toBe(false);
      expect(result.suggestionRow).toBe(suggestionRow);
      expect(result.targetRow).toBe(targetRow);
    });

    it('should parse lineNumber as integer for type consistency', () => {
      const suggestionManager = createTestSuggestionManager();

      const targetRow = createMockRow({ className: '' });
      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: targetRow
      });

      const suggestionDiv = createMockSuggestionDiv({
        fileName: 'test.js',
        lineNumber: '123',
        side: 'LEFT',
        diffPosition: '50',
        isFileLevel: 'false',
        parentRow: suggestionRow
      });

      const result = suggestionManager.getFileAndLineInfo(suggestionDiv);

      expect(typeof result.lineNumber).toBe('number');
      expect(result.lineNumber).toBe(123);
    });

    it('should default side to RIGHT when not specified in stored data', () => {
      const suggestionManager = createTestSuggestionManager();

      const targetRow = createMockRow({ className: '' });
      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: targetRow
      });

      const suggestionDiv = createMockSuggestionDiv({
        fileName: 'test.js',
        lineNumber: '10',
        side: '', // Empty side
        diffPosition: '5',
        isFileLevel: 'false',
        parentRow: suggestionRow
      });

      const result = suggestionManager.getFileAndLineInfo(suggestionDiv);

      expect(result.side).toBe('RIGHT');
    });

    it('should return null diffPosition when not stored', () => {
      const suggestionManager = createTestSuggestionManager();

      const targetRow = createMockRow({ className: '' });
      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: targetRow
      });

      const suggestionDiv = createMockSuggestionDiv({
        fileName: 'test.js',
        lineNumber: '10',
        side: 'RIGHT',
        diffPosition: '', // Empty diffPosition
        isFileLevel: 'false',
        parentRow: suggestionRow
      });

      const result = suggestionManager.getFileAndLineInfo(suggestionDiv);

      expect(result.diffPosition).toBeNull();
    });
  });

  describe('File-level suggestions', () => {
    it('should return isFileLevel: true with null line/position values', () => {
      const suggestionManager = createTestSuggestionManager();

      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row'
      });

      // File-level suggestions have empty lineNumber, side, diffPosition
      const suggestionDiv = createMockSuggestionDiv({
        fileName: 'src/utils/helpers.js',
        lineNumber: '',
        side: '',
        diffPosition: '',
        isFileLevel: 'true',
        parentRow: suggestionRow
      });

      const result = suggestionManager.getFileAndLineInfo(suggestionDiv);

      expect(result.isFileLevel).toBe(true);
      expect(result.fileName).toBe('src/utils/helpers.js');
      expect(result.lineNumber).toBeNull();
      expect(result.diffPosition).toBeNull();
      expect(result.side).toBeNull();
      expect(result.targetRow).toBeNull();
      expect(result.suggestionRow).toBe(suggestionRow);
    });

    it('should handle file-level suggestion even with fileName containing colons', () => {
      const suggestionManager = createTestSuggestionManager();

      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row'
      });

      // Windows-style path with drive letter
      const suggestionDiv = createMockSuggestionDiv({
        fileName: 'C:\\Users\\dev\\project\\file.js',
        lineNumber: '',
        side: '',
        diffPosition: '',
        isFileLevel: 'true',
        parentRow: suggestionRow
      });

      const result = suggestionManager.getFileAndLineInfo(suggestionDiv);

      expect(result.isFileLevel).toBe(true);
      expect(result.fileName).toBe('C:\\Users\\dev\\project\\file.js');
    });
  });

  describe('Fallback DOM traversal', () => {
    it('should skip ai-suggestion-row when traversing', () => {
      const suggestionManager = createTestSuggestionManager();

      // Create chain: targetRow -> anotherSuggestionRow -> suggestionRow
      const targetRow = createMockRow({
        className: '',
        dataset: { diffPosition: '20', side: 'RIGHT' },
        lineNum2: '50'
      });

      // Set up closest() to return a file wrapper
      targetRow.closest = vi.fn().mockReturnValue({
        dataset: { fileName: 'fallback-file.js' }
      });

      const anotherSuggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: targetRow
      });

      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: anotherSuggestionRow
      });

      // No stored data - forces fallback path
      const suggestionDiv = createMockSuggestionDiv({
        fileName: '',  // Empty triggers fallback
        lineNumber: '',
        side: '',
        diffPosition: '',
        isFileLevel: '',
        parentRow: suggestionRow
      });

      const result = suggestionManager.getFileAndLineInfo(suggestionDiv);

      expect(result.targetRow).toBe(targetRow);
      expect(result.fileName).toBe('fallback-file.js');
      expect(result.lineNumber).toBe(50);
    });

    it('should skip user-comment-row when traversing', () => {
      const suggestionManager = createTestSuggestionManager();

      const targetRow = createMockRow({
        className: '',
        dataset: { diffPosition: '25', side: 'LEFT' },
        lineNum1: '30'
      });

      targetRow.closest = vi.fn().mockReturnValue({
        dataset: { fileName: 'user-comment-file.js' }
      });

      const userCommentRow = createMockRow({
        className: 'user-comment-row',
        previousSibling: targetRow
      });

      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: userCommentRow
      });

      const suggestionDiv = createMockSuggestionDiv({
        fileName: '',
        parentRow: suggestionRow
      });

      const result = suggestionManager.getFileAndLineInfo(suggestionDiv);

      expect(result.targetRow).toBe(targetRow);
    });

    it('should skip context-expand-row when traversing', () => {
      const suggestionManager = createTestSuggestionManager();

      const targetRow = createMockRow({
        className: '',
        dataset: { diffPosition: '30', side: 'RIGHT' },
        lineNum2: '75'
      });

      targetRow.closest = vi.fn().mockReturnValue({
        dataset: { fileName: 'expand-file.js' }
      });

      const expandRow = createMockRow({
        className: 'context-expand-row',
        previousSibling: targetRow
      });

      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: expandRow
      });

      const suggestionDiv = createMockSuggestionDiv({
        fileName: '',
        parentRow: suggestionRow
      });

      const result = suggestionManager.getFileAndLineInfo(suggestionDiv);

      expect(result.targetRow).toBe(targetRow);
      expect(result.fileName).toBe('expand-file.js');
    });

    it('should throw error when no target row found', () => {
      const suggestionManager = createTestSuggestionManager();

      // Suggestion row with no previous sibling
      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: null
      });

      const suggestionDiv = createMockSuggestionDiv({
        fileName: '',
        parentRow: suggestionRow
      });

      expect(() => {
        suggestionManager.getFileAndLineInfo(suggestionDiv);
      }).toThrow('Could not find target line for comment');
    });

    it('should use line-num1 for LEFT side in fallback path', () => {
      const suggestionManager = createTestSuggestionManager();

      const targetRow = createMockRow({
        className: '',
        dataset: { diffPosition: '35', side: 'LEFT' },
        lineNum1: '100',
        lineNum2: '105'
      });

      targetRow.closest = vi.fn().mockReturnValue({
        dataset: { fileName: 'left-side.js' }
      });

      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: targetRow
      });

      const suggestionDiv = createMockSuggestionDiv({
        fileName: '',
        parentRow: suggestionRow
      });

      const result = suggestionManager.getFileAndLineInfo(suggestionDiv);

      // LEFT side should use line-num1
      expect(result.lineNumber).toBe(100);
      expect(result.side).toBe('LEFT');
    });

    it('should use line-num2 for RIGHT side in fallback path', () => {
      const suggestionManager = createTestSuggestionManager();

      const targetRow = createMockRow({
        className: '',
        dataset: { diffPosition: '40', side: 'RIGHT' },
        lineNum1: '100',
        lineNum2: '110'
      });

      targetRow.closest = vi.fn().mockReturnValue({
        dataset: { fileName: 'right-side.js' }
      });

      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: targetRow
      });

      const suggestionDiv = createMockSuggestionDiv({
        fileName: '',
        parentRow: suggestionRow
      });

      const result = suggestionManager.getFileAndLineInfo(suggestionDiv);

      // RIGHT side should use line-num2
      expect(result.lineNumber).toBe(110);
      expect(result.side).toBe('RIGHT');
    });

    it('should default to RIGHT side when side not in dataset', () => {
      const suggestionManager = createTestSuggestionManager();

      const targetRow = createMockRow({
        className: '',
        dataset: { diffPosition: '45' }, // No side specified
        lineNum2: '200'
      });

      targetRow.closest = vi.fn().mockReturnValue({
        dataset: { fileName: 'no-side.js' }
      });

      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: targetRow
      });

      const suggestionDiv = createMockSuggestionDiv({
        fileName: '',
        parentRow: suggestionRow
      });

      const result = suggestionManager.getFileAndLineInfo(suggestionDiv);

      expect(result.side).toBe('RIGHT');
      expect(result.lineNumber).toBe(200);
    });

    it('should throw error when lineNumber cannot be determined', () => {
      const suggestionManager = createTestSuggestionManager();

      const targetRow = createMockRow({
        className: '',
        dataset: { diffPosition: '50', side: 'RIGHT' },
        lineNum1: null,
        lineNum2: null // No line numbers
      });

      targetRow.closest = vi.fn().mockReturnValue({
        dataset: { fileName: 'no-line.js' }
      });

      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: targetRow
      });

      const suggestionDiv = createMockSuggestionDiv({
        fileName: '',
        parentRow: suggestionRow
      });

      expect(() => {
        suggestionManager.getFileAndLineInfo(suggestionDiv);
      }).toThrow('Could not determine file and line information');
    });

    it('should throw error when fileName cannot be determined', () => {
      const suggestionManager = createTestSuggestionManager();

      const targetRow = createMockRow({
        className: '',
        dataset: { diffPosition: '55', side: 'RIGHT' },
        lineNum2: '300'
      });

      // closest returns null or element without fileName
      targetRow.closest = vi.fn().mockReturnValue(null);

      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: targetRow
      });

      const suggestionDiv = createMockSuggestionDiv({
        fileName: '',
        parentRow: suggestionRow
      });

      expect(() => {
        suggestionManager.getFileAndLineInfo(suggestionDiv);
      }).toThrow('Could not determine file and line information');
    });
  });

  describe('Edge cases', () => {
    it('should handle stored fileName without lineNumber (file-level check comes first)', () => {
      const suggestionManager = createTestSuggestionManager();

      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row'
      });

      // Has fileName but no lineNumber and isFileLevel is true
      const suggestionDiv = createMockSuggestionDiv({
        fileName: 'edge-case.js',
        lineNumber: '',
        side: '',
        diffPosition: '',
        isFileLevel: 'true',
        parentRow: suggestionRow
      });

      const result = suggestionManager.getFileAndLineInfo(suggestionDiv);

      // Should be treated as file-level
      expect(result.isFileLevel).toBe(true);
      expect(result.lineNumber).toBeNull();
    });

    it('should handle multiple intermediate rows correctly', () => {
      const suggestionManager = createTestSuggestionManager();

      const targetRow = createMockRow({
        className: '',
        dataset: { diffPosition: '60', side: 'RIGHT' },
        lineNum2: '400'
      });

      targetRow.closest = vi.fn().mockReturnValue({
        dataset: { fileName: 'multiple-rows.js' }
      });

      const expandRow = createMockRow({
        className: 'context-expand-row',
        previousSibling: targetRow
      });

      const userCommentRow = createMockRow({
        className: 'user-comment-row',
        previousSibling: expandRow
      });

      const anotherSuggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: userCommentRow
      });

      const suggestionRow = createMockRow({
        className: 'ai-suggestion-row',
        previousSibling: anotherSuggestionRow
      });

      const suggestionDiv = createMockSuggestionDiv({
        fileName: '',
        parentRow: suggestionRow
      });

      const result = suggestionManager.getFileAndLineInfo(suggestionDiv);

      expect(result.targetRow).toBe(targetRow);
      expect(result.fileName).toBe('multiple-rows.js');
      expect(result.lineNumber).toBe(400);
    });
  });
});
