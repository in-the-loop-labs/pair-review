// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for PRManager.ensureLinesVisible()
 *
 * Tests the method that ensures specific lines are visible in the diff view
 * by expanding hidden hunks when necessary. It checks the DOM for existing
 * line rows and calls expandForSuggestion() only when lines are not already
 * rendered.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import the actual PRManager class from production code
const { PRManager } = require('../../public/js/pr.js');

beforeEach(() => {
  vi.resetAllMocks();

  global.fetch = vi.fn();

  global.window = {
    aiPanel: null,
    DiffRenderer: {
      findFileElement: vi.fn(() => null)
    },
    scrollTo: vi.fn()
  };

  global.document = {
    getElementById: vi.fn(() => null),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => [])
  };

  global.alert = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Create a minimal PRManager instance with mocked dependencies for testing
 * ensureLinesVisible().
 */
function createTestPRManager() {
  const prManager = Object.create(PRManager.prototype);

  prManager.currentPR = {
    owner: 'test-owner',
    repo: 'test-repo',
    number: 42,
    id: 1
  };

  // Mock findFileElement - delegates to window.DiffRenderer.findFileElement
  prManager.findFileElement = vi.fn();

  // Mock getLineNumber - delegates to lineTracker
  prManager.getLineNumber = vi.fn();

  // Mock expandForSuggestion
  prManager.expandForSuggestion = vi.fn().mockResolvedValue(undefined);

  return prManager;
}

/**
 * Create a mock file element with querySelectorAll that returns the given rows.
 */
function createMockFileElement(rows) {
  return {
    querySelectorAll: vi.fn(() => rows)
  };
}

/**
 * Create a mock table row. getLineNumber will be configured on the prManager
 * to return the appropriate line number for each row.
 */
function createMockRow(id) {
  return { _testId: id };
}

describe('PRManager.ensureLinesVisible()', () => {
  describe('empty input', () => {
    it('should be a no-op for an empty items array', async () => {
      const prManager = createTestPRManager();

      await prManager.ensureLinesVisible([]);

      expect(prManager.findFileElement).not.toHaveBeenCalled();
      expect(prManager.expandForSuggestion).not.toHaveBeenCalled();
    });
  });

  describe('file not found in DOM', () => {
    it('should skip items whose file element is not in the DOM', async () => {
      const prManager = createTestPRManager();
      prManager.findFileElement.mockReturnValue(null);

      await prManager.ensureLinesVisible([
        { file: 'nonexistent.js', line_start: 10, line_end: 15, side: 'RIGHT' }
      ]);

      expect(prManager.findFileElement).toHaveBeenCalledWith('nonexistent.js');
      expect(prManager.expandForSuggestion).not.toHaveBeenCalled();
    });
  });

  describe('lines already visible', () => {
    it('should not call expandForSuggestion when line_start is already in the DOM', async () => {
      const prManager = createTestPRManager();
      const row10 = createMockRow('row-10');
      const fileEl = createMockFileElement([row10]);

      prManager.findFileElement.mockReturnValue(fileEl);
      prManager.getLineNumber.mockImplementation((row, side) => {
        if (row === row10 && side === 'RIGHT') return 10;
        return null;
      });

      await prManager.ensureLinesVisible([
        { file: 'visible.js', line_start: 10, line_end: 10, side: 'RIGHT' }
      ]);

      expect(prManager.expandForSuggestion).not.toHaveBeenCalled();
    });

    it('should not call expandForSuggestion when any line in the range is visible', async () => {
      const prManager = createTestPRManager();
      const row12 = createMockRow('row-12');
      const fileEl = createMockFileElement([row12]);

      prManager.findFileElement.mockReturnValue(fileEl);
      prManager.getLineNumber.mockImplementation((row, side) => {
        if (row === row12 && side === 'RIGHT') return 12;
        return null;
      });

      // Range 10-15: line 12 is visible even though 10, 11, 13, 14, 15 are not
      await prManager.ensureLinesVisible([
        { file: 'partial.js', line_start: 10, line_end: 15, side: 'RIGHT' }
      ]);

      expect(prManager.expandForSuggestion).not.toHaveBeenCalled();
    });
  });

  describe('lines not visible - triggers expansion', () => {
    it('should call expandForSuggestion when no lines in the range are visible', async () => {
      const prManager = createTestPRManager();
      const row5 = createMockRow('row-5');
      const fileEl = createMockFileElement([row5]);

      prManager.findFileElement.mockReturnValue(fileEl);
      // Row 5 has line number 5, but we're looking for lines 10-15
      prManager.getLineNumber.mockReturnValue(null);

      await prManager.ensureLinesVisible([
        { file: 'hidden.js', line_start: 10, line_end: 15, side: 'RIGHT' }
      ]);

      expect(prManager.expandForSuggestion).toHaveBeenCalledTimes(1);
      expect(prManager.expandForSuggestion).toHaveBeenCalledWith('hidden.js', 10, 15, 'RIGHT');
    });

    it('should default side to RIGHT when not specified', async () => {
      const prManager = createTestPRManager();
      const fileEl = createMockFileElement([]);

      prManager.findFileElement.mockReturnValue(fileEl);

      await prManager.ensureLinesVisible([
        { file: 'test.js', line_start: 5, line_end: 5 }
      ]);

      // side is undefined, so (undefined || 'right').toUpperCase() = 'RIGHT'
      expect(prManager.expandForSuggestion).toHaveBeenCalledWith('test.js', 5, 5, 'RIGHT');
    });

    it('should uppercase the side parameter', async () => {
      const prManager = createTestPRManager();
      const fileEl = createMockFileElement([]);

      prManager.findFileElement.mockReturnValue(fileEl);

      await prManager.ensureLinesVisible([
        { file: 'test.js', line_start: 5, line_end: 5, side: 'left' }
      ]);

      expect(prManager.expandForSuggestion).toHaveBeenCalledWith('test.js', 5, 5, 'LEFT');
    });
  });

  describe('line_end fallback', () => {
    it('should treat missing line_end as equal to line_start', async () => {
      const prManager = createTestPRManager();
      const fileEl = createMockFileElement([]);

      prManager.findFileElement.mockReturnValue(fileEl);

      await prManager.ensureLinesVisible([
        { file: 'test.js', line_start: 7, side: 'RIGHT' }
      ]);

      // line_end is undefined, so (line_end || line_start) = 7
      expect(prManager.expandForSuggestion).toHaveBeenCalledWith('test.js', 7, 7, 'RIGHT');
    });
  });

  describe('multiple items', () => {
    it('should process each item independently', async () => {
      const prManager = createTestPRManager();

      // First file: line visible
      const row10 = createMockRow('row-10');
      const fileElA = createMockFileElement([row10]);

      // Second file: line not visible
      const fileElB = createMockFileElement([]);

      prManager.findFileElement.mockImplementation((file) => {
        if (file === 'a.js') return fileElA;
        if (file === 'b.js') return fileElB;
        return null;
      });
      prManager.getLineNumber.mockImplementation((row, side) => {
        if (row === row10 && side === 'RIGHT') return 10;
        return null;
      });

      await prManager.ensureLinesVisible([
        { file: 'a.js', line_start: 10, line_end: 10, side: 'RIGHT' },
        { file: 'b.js', line_start: 20, line_end: 25, side: 'RIGHT' }
      ]);

      // Only the second item should trigger expansion
      expect(prManager.expandForSuggestion).toHaveBeenCalledTimes(1);
      expect(prManager.expandForSuggestion).toHaveBeenCalledWith('b.js', 20, 25, 'RIGHT');
    });

    it('should expand multiple items when none are visible', async () => {
      const prManager = createTestPRManager();
      const fileEl = createMockFileElement([]);

      prManager.findFileElement.mockReturnValue(fileEl);

      await prManager.ensureLinesVisible([
        { file: 'x.js', line_start: 1, line_end: 5, side: 'RIGHT' },
        { file: 'y.js', line_start: 10, line_end: 15, side: 'LEFT' }
      ]);

      expect(prManager.expandForSuggestion).toHaveBeenCalledTimes(2);
      expect(prManager.expandForSuggestion).toHaveBeenCalledWith('x.js', 1, 5, 'RIGHT');
      expect(prManager.expandForSuggestion).toHaveBeenCalledWith('y.js', 10, 15, 'LEFT');
    });

    it('should skip items with missing file element and continue to next', async () => {
      const prManager = createTestPRManager();
      const fileElC = createMockFileElement([]);

      prManager.findFileElement.mockImplementation((file) => {
        if (file === 'missing.js') return null;
        if (file === 'exists.js') return fileElC;
        return null;
      });

      await prManager.ensureLinesVisible([
        { file: 'missing.js', line_start: 1, line_end: 5, side: 'RIGHT' },
        { file: 'exists.js', line_start: 10, line_end: 15, side: 'RIGHT' }
      ]);

      // Only the second item should trigger expansion (first file not found)
      expect(prManager.expandForSuggestion).toHaveBeenCalledTimes(1);
      expect(prManager.expandForSuggestion).toHaveBeenCalledWith('exists.js', 10, 15, 'RIGHT');
    });
  });

  describe('LEFT side coordinate system', () => {
    it('should check LEFT side line numbers when side is LEFT', async () => {
      const prManager = createTestPRManager();
      const row = createMockRow('row-left');
      const fileEl = createMockFileElement([row]);

      prManager.findFileElement.mockReturnValue(fileEl);
      prManager.getLineNumber.mockImplementation((r, side) => {
        if (r === row && side === 'LEFT') return 20;
        return null;
      });

      await prManager.ensureLinesVisible([
        { file: 'test.js', line_start: 20, line_end: 20, side: 'left' }
      ]);

      // Line 20 is visible on the LEFT side, so no expansion needed
      expect(prManager.expandForSuggestion).not.toHaveBeenCalled();
    });
  });
});
