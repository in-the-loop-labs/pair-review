// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for CommentManager.getCodeFromLines() and insertSuggestionBlock()
 *
 * Tests the extraction of code content from diff rows, particularly
 * the side filtering that prevents including both OLD and NEW versions
 * of modified lines when inserting suggestions.
 *
 * Regression test for pair_review-4gbg: When inserting suggestions on modified
 * lines (deletion + addition pair), the suggestion should only include text
 * from the requested side (typically RIGHT/NEW), not both OLD and NEW.
 *
 * The definitive fix: getCodeFromLines always filters by side, defaulting to
 * 'RIGHT' when side is not provided. This prevents the bug regardless of
 * whether callers correctly propagate the side parameter.
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

  describe('side filtering - explicit side', () => {
    it('should return only RIGHT side content when side="RIGHT"', () => {
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

  describe('side defaulting - the definitive fix', () => {
    // These tests verify the core fix: when side is not provided (undefined/null/empty),
    // getCodeFromLines defaults to 'RIGHT' instead of including both sides.
    // This prevents the bug where suggestions on modified lines include both old and new content.

    it('should default to RIGHT when side is undefined (prevents both-sides bug)', () => {
      const rows = [
        createMockRow(10, 'test.js', 'LEFT', 'const oldValue = 1;'),
        createMockRow(10, 'test.js', 'RIGHT', 'const newValue = 2;')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 10, 10, undefined);

      // Previously this returned BOTH lines (the bug). Now defaults to RIGHT only.
      expect(result).toBe('const newValue = 2;');
    });

    it('should default to RIGHT when side is null (prevents both-sides bug)', () => {
      const rows = [
        createMockRow(10, 'test.js', 'LEFT', 'old code'),
        createMockRow(10, 'test.js', 'RIGHT', 'new code')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 10, 10, null);

      // Previously this returned BOTH lines (the bug). Now defaults to RIGHT only.
      expect(result).toBe('new code');
    });

    it('should default to RIGHT when side is empty string (prevents both-sides bug)', () => {
      const rows = [
        createMockRow(10, 'test.js', 'LEFT', 'removed line'),
        createMockRow(10, 'test.js', 'RIGHT', 'added line')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 10, 10, '');

      // Empty string is falsy, so defaults to RIGHT
      expect(result).toBe('added line');
    });

    it('should default to RIGHT for multi-line range when side is not provided', () => {
      const rows = [
        createMockRow(5, 'test.js', 'LEFT', 'old A'),
        createMockRow(5, 'test.js', 'RIGHT', 'new A'),
        createMockRow(6, 'test.js', 'LEFT', 'old B'),
        createMockRow(6, 'test.js', 'RIGHT', 'new B'),
        createMockRow(7, 'test.js', 'RIGHT', 'context line')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 5, 7);

      expect(result).toBe('new A\nnew B\ncontext line');
    });
  });

  describe('basic functionality', () => {
    it('should return empty string when file wrapper not found', () => {
      const rows = [createMockRow(10, 'other.js', 'RIGHT', 'some code')];
      const wrapper = createMockWrapper('other.js', rows);
      setupDocumentMock([wrapper]);

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
      const rows = [
        createMockRow(10, 'test.js', 'RIGHT', 'test.js content'),
        createMockRow(10, 'other.js', 'RIGHT', 'other.js content')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 10, 10, 'RIGHT');

      expect(result).toBe('test.js content');
    });

    it('should handle context lines (RIGHT side) correctly', () => {
      // Context lines always have side='RIGHT' in the diff renderer
      const rows = [
        createMockRow(9, 'test.js', 'RIGHT', 'context before'),
        createMockRow(10, 'test.js', 'RIGHT', 'modified line'),
        createMockRow(11, 'test.js', 'RIGHT', 'context after')
      ];
      const wrapper = createMockWrapper('test.js', rows);
      setupDocumentMock([wrapper]);

      const result = commentManager.getCodeFromLines('test.js', 9, 11, 'RIGHT');

      expect(result).toBe('context before\nmodified line\ncontext after');
    });
  });
});

describe('CommentManager.insertSuggestionBlock', () => {
  let commentManager;

  beforeEach(() => {
    commentManager = createTestCommentManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Create a mock textarea element
   */
  function createMockTextarea(attrs = {}) {
    const textarea = {
      dataset: {
        file: attrs.file || 'test.js',
        line: String(attrs.line || 10),
        lineEnd: String(attrs.lineEnd || attrs.line || 10),
        side: attrs.side
      },
      value: attrs.value || '',
      selectionStart: attrs.selectionStart || 0,
      selectionEnd: attrs.selectionEnd || 0,
      setSelectionRange: vi.fn(),
      focus: vi.fn(),
      style: {}
    };
    return textarea;
  }

  it('should read side from textarea dataset and pass to getCodeFromLines', () => {
    const textarea = createMockTextarea({ side: 'RIGHT', line: 10 });
    const getCodeSpy = vi.spyOn(commentManager, 'getCodeFromLines').mockReturnValue('new code');
    vi.spyOn(commentManager, 'hasSuggestionBlock').mockReturnValue(false);
    vi.spyOn(commentManager, 'autoResizeTextarea').mockImplementation(() => {});
    vi.spyOn(commentManager, 'updateSuggestionButtonState').mockImplementation(() => {});

    commentManager.insertSuggestionBlock(textarea, null);

    expect(getCodeSpy).toHaveBeenCalledWith('test.js', 10, 10, 'RIGHT');
  });

  it('should read LEFT side from textarea dataset for delete lines', () => {
    const textarea = createMockTextarea({ side: 'LEFT', line: 10 });
    const getCodeSpy = vi.spyOn(commentManager, 'getCodeFromLines').mockReturnValue('old code');
    vi.spyOn(commentManager, 'hasSuggestionBlock').mockReturnValue(false);
    vi.spyOn(commentManager, 'autoResizeTextarea').mockImplementation(() => {});
    vi.spyOn(commentManager, 'updateSuggestionButtonState').mockImplementation(() => {});

    commentManager.insertSuggestionBlock(textarea, null);

    expect(getCodeSpy).toHaveBeenCalledWith('test.js', 10, 10, 'LEFT');
  });

  it('should warn and pass undefined when side is missing from textarea', () => {
    const textarea = createMockTextarea({ line: 10 });
    // Explicitly remove side to simulate missing attribute
    delete textarea.dataset.side;

    const getCodeSpy = vi.spyOn(commentManager, 'getCodeFromLines').mockReturnValue('code');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(commentManager, 'hasSuggestionBlock').mockReturnValue(false);
    vi.spyOn(commentManager, 'autoResizeTextarea').mockImplementation(() => {});
    vi.spyOn(commentManager, 'updateSuggestionButtonState').mockImplementation(() => {});

    commentManager.insertSuggestionBlock(textarea, null);

    expect(warnSpy).toHaveBeenCalledWith('[Suggestion] textarea missing data-side attribute, defaulting to RIGHT');
    // side is undefined — defaulting to RIGHT is tested separately in 'side defaulting' tests
    expect(getCodeSpy).toHaveBeenCalledWith('test.js', 10, 10, undefined);
  });

  it('should not insert suggestion when one already exists', () => {
    const textarea = createMockTextarea({ side: 'RIGHT', value: '```suggestion\ncode\n```' });
    vi.spyOn(commentManager, 'hasSuggestionBlock').mockReturnValue(true);
    const getCodeSpy = vi.spyOn(commentManager, 'getCodeFromLines');

    commentManager.insertSuggestionBlock(textarea, null);

    expect(getCodeSpy).not.toHaveBeenCalled();
  });

  it('should insert suggestion block with code from getCodeFromLines', () => {
    const textarea = createMockTextarea({ side: 'RIGHT', line: 10 });
    vi.spyOn(commentManager, 'getCodeFromLines').mockReturnValue('  const x = 1;');
    vi.spyOn(commentManager, 'hasSuggestionBlock').mockReturnValue(false);
    vi.spyOn(commentManager, 'autoResizeTextarea').mockImplementation(() => {});
    vi.spyOn(commentManager, 'updateSuggestionButtonState').mockImplementation(() => {});

    commentManager.insertSuggestionBlock(textarea, null);

    expect(textarea.value).toBe('```suggestion\n  const x = 1;\n```');
  });
});
