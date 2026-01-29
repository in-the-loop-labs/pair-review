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

describe('SuggestionManager.collapseAISuggestion()', () => {
  // Mock global fetch for API calls
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    global.fetch = mockFetch;
  });

  it('should correctly collapse the second suggestion when two suggestions are on the same line (regression test for pair_review-149d)', async () => {
    // This test verifies the fix for the bug where adopting/dismissing the second
    // suggestion on the same line would incorrectly collapse the first suggestion.
    // The bug was caused by using suggestionRow.querySelector('.ai-suggestion') which
    // always returned the first suggestion div, rather than using the suggestionId
    // to find the correct one.
    const suggestionManager = createTestSuggestionManager();

    // Mock successful API response
    mockFetch.mockResolvedValueOnce({ ok: true });

    // Create two mock suggestion divs that share the same parent row
    // Note: In the real DOM, these would have data-suggestion-id attributes
    const mockCollapsedText1 = { textContent: '' };
    const mockButton1 = {
      title: '',
      querySelector: vi.fn().mockReturnValue({ textContent: '' })
    };
    const mockSuggestionDiv1 = {
      classList: {
        add: vi.fn()
      },
      querySelector: vi.fn((selector) => {
        if (selector === '.collapsed-text') return mockCollapsedText1;
        if (selector === '.btn-restore') return mockButton1;
        return null;
      })
    };

    const mockCollapsedText2 = { textContent: '' };
    const mockButton2 = {
      title: '',
      querySelector: vi.fn().mockReturnValue({ textContent: '' })
    };
    const mockSuggestionDiv2 = {
      dataset: {},
      classList: {
        add: vi.fn()
      },
      querySelector: vi.fn((selector) => {
        if (selector === '.collapsed-text') return mockCollapsedText2;
        if (selector === '.btn-restore') return mockButton2;
        return null;
      })
    };

    // Both suggestions share the same row
    // The row's querySelector should return the CORRECT suggestion div based on the selector
    const mockRow = {
      dataset: {},
      querySelector: vi.fn((selector) => {
        // This is the fix: the selector should be [data-suggestion-id="X"] not '.ai-suggestion'
        if (selector === '[data-suggestion-id="1"]') return mockSuggestionDiv1;
        if (selector === '[data-suggestion-id="2"]') return mockSuggestionDiv2;
        // Before the fix, '.ai-suggestion' would always return the first one
        if (selector === '.ai-suggestion') return mockSuggestionDiv1;
        return null;
      })
    };

    // Collapse the SECOND suggestion (ID: 2)
    await suggestionManager.collapseAISuggestion('2', mockRow, 'Suggestion adopted', 'adopted');

    // Verify the API was called with the correct suggestion ID
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/ai-suggestion/2/status',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ status: 'adopted' })
      })
    );

    // The row's querySelector should have been called with the ID-based selector
    expect(mockRow.querySelector).toHaveBeenCalledWith('[data-suggestion-id="2"]');

    // The SECOND suggestion's classList.add should be called, NOT the first
    expect(mockSuggestionDiv2.classList.add).toHaveBeenCalledWith('collapsed');
    expect(mockSuggestionDiv1.classList.add).not.toHaveBeenCalled();

    // The collapsed text within the SECOND suggestion should be updated, NOT the first
    expect(mockCollapsedText2.textContent).toBe('Suggestion adopted');
    expect(mockCollapsedText1.textContent).toBe(''); // Should remain unchanged

    // The individual suggestion div should be marked as hidden for adoption (not the row)
    expect(mockSuggestionDiv2.dataset.hiddenForAdoption).toBe('true');
  });

  it('should collapse the suggestion when API call succeeds', async () => {
    const suggestionManager = createTestSuggestionManager();

    mockFetch.mockResolvedValueOnce({ ok: true });

    const mockCollapsedText = { textContent: '' };
    const mockButton = {
      title: '',
      querySelector: vi.fn().mockReturnValue({ textContent: '' })
    };
    const mockSuggestionDiv = {
      dataset: {},
      classList: { add: vi.fn() },
      querySelector: vi.fn((selector) => {
        if (selector === '.collapsed-text') return mockCollapsedText;
        if (selector === '.btn-restore') return mockButton;
        return null;
      })
    };

    const mockRow = {
      dataset: {},
      querySelector: vi.fn().mockReturnValue(mockSuggestionDiv)
    };

    await suggestionManager.collapseAISuggestion('123', mockRow, 'Test collapse', 'dismissed');

    expect(mockSuggestionDiv.classList.add).toHaveBeenCalledWith('collapsed');
    expect(mockCollapsedText.textContent).toBe('Test collapse');
    expect(mockButton.title).toBe('Show suggestion');
  });

  it('should throw error when API call fails', async () => {
    const suggestionManager = createTestSuggestionManager();

    mockFetch.mockResolvedValueOnce({ ok: false });

    const mockRow = { dataset: {} };

    await expect(
      suggestionManager.collapseAISuggestion('123', mockRow, 'Test', 'dismissed')
    ).rejects.toThrow('Failed to update suggestion status');
  });

  it('should handle null suggestionRow gracefully', async () => {
    const suggestionManager = createTestSuggestionManager();

    mockFetch.mockResolvedValueOnce({ ok: true });

    // Should not throw when suggestionRow is null
    await expect(
      suggestionManager.collapseAISuggestion('123', null, 'Test', 'dismissed')
    ).resolves.not.toThrow();
  });
});
