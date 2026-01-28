// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for CommentManager.getCodeFromLines()
 *
 * Tests the extraction of code content from diff rows, particularly
 * the side filtering that prevents including both OLD and NEW versions
 * of modified lines when inserting suggestions.
 *
 * Regression test for pair_review-4gbg: When inserting suggestions on modified
 * lines (deletion + addition pair), the suggestion should only include text
 * from the requested side (typically RIGHT/NEW), not both OLD and NEW.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Setup global.window before importing production code that assigns to it
global.window = global.window || {};

// Import the actual CommentManager class from production code
const { CommentManager } = require('../../public/js/modules/comment-manager.js');

/**
 * Create a minimal CommentManager instance for testing
 */
function createTestCommentManager() {
  const commentManager = Object.create(CommentManager.prototype);
  commentManager.prManager = null;
  commentManager.currentCommentForm = null;
  return commentManager;
}

/**
 * Create mock row elements that simulate diff table rows
 */
function createMockRow(lineNumber, fileName, side, content) {
  return {
    dataset: {
      lineNumber: String(lineNumber),
      fileName,
      side
    },
    querySelector: vi.fn((selector) => {
      if (selector === '.d2h-code-line-ctn') {
        return { textContent: content };
      }
      return null;
    })
  };
}

/**
 * Create a mock file wrapper that returns the given rows
 */
function createMockWrapper(fileName, rows) {
  return {
    dataset: { fileName },
    querySelectorAll: vi.fn((selector) => {
      if (selector === 'tr[data-line-number]') {
        return rows;
      }
      return [];
    })
  };
}

describe('CommentManager.getCodeFromLines', () => {
  let commentManager;
  let originalQuerySelectorAll;

  beforeEach(() => {
    commentManager = createTestCommentManager();
    originalQuerySelectorAll = global.document?.querySelectorAll;
  });

  afterEach(() => {
    if (originalQuerySelectorAll) {
      global.document.querySelectorAll = originalQuerySelectorAll;
    }
    vi.restoreAllMocks();
  });

  /**
   * Helper to setup document mock with file wrappers
   */
  function setupDocumentMock(wrappers) {
    global.document = {
      querySelectorAll: vi.fn((selector) => {
        if (selector === '.d2h-file-wrapper') {
          return wrappers;
        }
        return [];
      })
    };
  }

  describe('side filtering', () => {
    it('should return only RIGHT side content when side="RIGHT"', () => {
      // Setup: A modified line appears as both a deletion (LEFT) and addition (RIGHT)
      // with the same line number
      const rows = [
        createMockRow(10, 'test.js', 'LEFT', 'const oldValue = 1;'),
        createMockRow(10, 'test.js', 'RIGHT', 'const newValue = 2;')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 10, 10, 'RIGHT');

      expect(result).toBe('const newValue = 2;');
    });

    it('should return only LEFT side content when side="LEFT"', () => {
      const rows = [
        createMockRow(10, 'test.js', 'LEFT', 'const oldValue = 1;'),
        createMockRow(10, 'test.js', 'RIGHT', 'const newValue = 2;')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 10, 10, 'LEFT');

      expect(result).toBe('const oldValue = 1;');
    });

    it('should return BOTH sides when side is undefined (documents bug behavior)', () => {
      // This test documents the behavior when side is undefined.
      // When side is not provided, BOTH lines are included (which was the bug).
      // The fix ensures side is always propagated so this case shouldn't occur in practice.
      const rows = [
        createMockRow(10, 'test.js', 'LEFT', 'const oldValue = 1;'),
        createMockRow(10, 'test.js', 'RIGHT', 'const newValue = 2;')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 10, 10, undefined);

      // When side is undefined, both lines are returned (joined with newline)
      // This is the BUG CASE that the fix prevents by always propagating side
      expect(result).toBe('const oldValue = 1;\nconst newValue = 2;');
    });

    it('should handle multi-line ranges with side filtering', () => {
      const rows = [
        createMockRow(10, 'test.js', 'LEFT', 'old line 10'),
        createMockRow(10, 'test.js', 'RIGHT', 'new line 10'),
        createMockRow(11, 'test.js', 'LEFT', 'old line 11'),
        createMockRow(11, 'test.js', 'RIGHT', 'new line 11'),
        createMockRow(12, 'test.js', 'RIGHT', 'added line 12')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 10, 12, 'RIGHT');

      expect(result).toBe('new line 10\nnew line 11\nadded line 12');
    });

    it('should filter LEFT side for deleted-only lines in range', () => {
      const rows = [
        createMockRow(10, 'test.js', 'LEFT', 'deleted line 10'),
        createMockRow(11, 'test.js', 'LEFT', 'deleted line 11')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 10, 11, 'LEFT');

      expect(result).toBe('deleted line 10\ndeleted line 11');
    });
  });

  describe('basic functionality', () => {
    it('should return empty string when file wrapper not found', () => {
      const rows = [createMockRow(10, 'other.js', 'RIGHT', 'some code')];
      const wrapper = createMockWrapper('other.js', rows);
      setupDocumentMock([wrapper]);

      // Suppress console.warn for this test
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = commentManager.getCodeFromLines('test.js', 10, 10, 'RIGHT');

      expect(result).toBe('');
      expect(warnSpy).toHaveBeenCalledWith('[Suggestion] Could not find file wrapper for test.js');
    });

    it('should return empty string when no rows in range', () => {
      const rows = [
        createMockRow(5, 'test.js', 'RIGHT', 'line 5'),
        createMockRow(20, 'test.js', 'RIGHT', 'line 20')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 10, 15, 'RIGHT');

      expect(result).toBe('');
    });

    it('should return single line content', () => {
      const rows = [createMockRow(10, 'test.js', 'RIGHT', '  const x = 1;')];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 10, 10, 'RIGHT');

      expect(result).toBe('  const x = 1;');
    });

    it('should preserve whitespace in code content', () => {
      const rows = [
        createMockRow(10, 'test.js', 'RIGHT', '    if (true) {'),
        createMockRow(11, 'test.js', 'RIGHT', '        doSomething();'),
        createMockRow(12, 'test.js', 'RIGHT', '    }')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 10, 12, 'RIGHT');

      expect(result).toBe('    if (true) {\n        doSomething();\n    }');
    });
  });

  describe('edge cases', () => {
    it('should handle rows from different files', () => {
      // File wrapper for test.js only matches test.js rows
      const rows = [
        createMockRow(10, 'test.js', 'RIGHT', 'test.js content'),
        createMockRow(10, 'other.js', 'RIGHT', 'other.js content')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 10, 10, 'RIGHT');

      // Only returns content where row.dataset.fileName matches
      expect(result).toBe('test.js content');
    });

    it('should handle empty side (context lines)', () => {
      // Context lines may have empty side
      const rows = [
        createMockRow(9, 'test.js', '', 'context line'),
        createMockRow(10, 'test.js', 'RIGHT', 'added line')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      // When requesting RIGHT, empty-side rows don't match
      const result = commentManager.getCodeFromLines('test.js', 9, 10, 'RIGHT');

      expect(result).toBe('added line');
    });

    it('should include all lines when side is null', () => {
      const rows = [
        createMockRow(10, 'test.js', 'LEFT', 'left'),
        createMockRow(10, 'test.js', 'RIGHT', 'right')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 10, 10, null);

      // null is falsy so !side is true, includes all
      expect(result).toBe('left\nright');
    });
  });
});
