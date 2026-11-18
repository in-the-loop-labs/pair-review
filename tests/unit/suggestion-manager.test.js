// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
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
  suggestionManager.prManager = {
    currentPR: { id: 'test-review-1' }
  };
  return suggestionManager;
}

/**
 * A suggestion card as its builder leaves it: the suggestion's place is
 * stored on the card (data-file-name, data-line-number, ...).
 */
function createSuggestionCard(dataset = {}) {
  return { dataset: { fileName: '', lineNumber: '', side: '', diffPosition: '', isFileLevel: 'false', ...dataset } };
}

describe('SuggestionManager.getFileAndLineInfo()', () => {
  // The answer comes from what the card stores, never from where the card
  // is: a card of the virtualized viewer need not be in the document.
  describe('Line-level suggestions', () => {
    it('returns the stored file, line, side and diff position', () => {
      const suggestionManager = createTestSuggestionManager();
      const result = suggestionManager.getFileAndLineInfo(createSuggestionCard({
        fileName: 'src/components/Button.js', lineNumber: '42', side: 'RIGHT', diffPosition: '15',
      }));

      expect(result).toEqual({
        fileName: 'src/components/Button.js',
        lineNumber: 42, // parsed as an integer
        lineEnd: null,
        side: 'RIGHT',
        diffPosition: '15',
        isFileLevel: false,
      });
    });

    it('parses lineNumber and lineEnd as integers for type consistency', () => {
      const suggestionManager = createTestSuggestionManager();
      const result = suggestionManager.getFileAndLineInfo(createSuggestionCard({
        fileName: 'a.js', lineNumber: '007', lineEnd: '12', side: 'LEFT',
      }));
      expect(result.lineNumber).toBe(7);
      expect(result.lineEnd).toBe(12);
      expect(typeof result.lineNumber).toBe('number');
      expect(result.side).toBe('LEFT');
    });

    it('defaults side to RIGHT when not stored', () => {
      const suggestionManager = createTestSuggestionManager();
      const result = suggestionManager.getFileAndLineInfo(createSuggestionCard({ fileName: 'a.js', lineNumber: '3' }));
      expect(result.side).toBe('RIGHT');
    });

    it('returns a null diffPosition when not stored', () => {
      const suggestionManager = createTestSuggestionManager();
      const result = suggestionManager.getFileAndLineInfo(createSuggestionCard({ fileName: 'a.js', lineNumber: '3', side: 'RIGHT' }));
      expect(result.diffPosition).toBeNull();
    });

    it('never asks the card where it is in the document', () => {
      const suggestionManager = createTestSuggestionManager();
      const card = createSuggestionCard({ fileName: 'a.js', lineNumber: '3' });
      card.closest = vi.fn();
      card.querySelector = vi.fn();
      suggestionManager.getFileAndLineInfo(card);
      expect(card.closest).not.toHaveBeenCalled();
      expect(card.querySelector).not.toHaveBeenCalled();
    });
  });

  describe('File-level suggestions', () => {
    it('returns isFileLevel: true with null line/position values', () => {
      const suggestionManager = createTestSuggestionManager();
      const result = suggestionManager.getFileAndLineInfo(createSuggestionCard({
        fileName: 'src/utils/helpers.js', isFileLevel: 'true',
      }));

      expect(result).toEqual({
        fileName: 'src/utils/helpers.js', lineNumber: null, diffPosition: null, side: null, isFileLevel: true,
      });
    });

    it('handles a file name containing colons', () => {
      const suggestionManager = createTestSuggestionManager();
      const result = suggestionManager.getFileAndLineInfo(createSuggestionCard({
        fileName: 'C:/Users/dev/project/file.js', isFileLevel: 'true',
      }));
      expect(result.isFileLevel).toBe(true);
      expect(result.fileName).toBe('C:/Users/dev/project/file.js');
    });

    it('the file-level check comes before the line: a stray line number does not make it a line suggestion', () => {
      const suggestionManager = createTestSuggestionManager();
      const result = suggestionManager.getFileAndLineInfo(createSuggestionCard({
        fileName: 'edge-case.js', lineNumber: '9', isFileLevel: 'true',
      }));
      expect(result.isFileLevel).toBe(true);
      expect(result.lineNumber).toBeNull();
    });
  });

  describe('A card that does not say where its suggestion is', () => {
    it('throws when the line number is not stored', () => {
      const suggestionManager = createTestSuggestionManager();
      expect(() => suggestionManager.getFileAndLineInfo(createSuggestionCard({ fileName: 'no-line.js' })))
        .toThrow('Could not determine file and line information');
    });

    it('throws when the file name is not stored', () => {
      const suggestionManager = createTestSuggestionManager();
      expect(() => suggestionManager.getFileAndLineInfo(createSuggestionCard({ lineNumber: '300', side: 'RIGHT' })))
        .toThrow('Could not determine file and line information');
      // Also for a card marked file-level: there is no file to file it under.
      expect(() => suggestionManager.getFileAndLineInfo(createSuggestionCard({ isFileLevel: 'true' })))
        .toThrow('Could not determine file and line information');
    });
  });
});

describe('SuggestionManager._isFileLevel()', () => {
  // Regression: the `is_file_level` flag arrives as boolean `true` from the
  // analyses merge path (src/routes/analyses.js) and integer `1` from the
  // SQLite-backed paths (src/routes/pr.js, src/routes/chat.js). Both shapes
  // must be treated as file-level so that file-level suggestions are excluded
  // from the `lineTargets` list fed to ensureLinesVisible in displayAISuggestions.
  const suggestionManager = createTestSuggestionManager();

  it('treats integer 1 as file-level', () => {
    expect(suggestionManager._isFileLevel({ is_file_level: 1 })).toBe(true);
  });

  it('treats boolean true as file-level (analyses merge path)', () => {
    expect(suggestionManager._isFileLevel({ is_file_level: true })).toBe(true);
  });

  it('treats integer 0 as line-level', () => {
    expect(suggestionManager._isFileLevel({ is_file_level: 0 })).toBe(false);
  });

  it('treats boolean false as line-level', () => {
    expect(suggestionManager._isFileLevel({ is_file_level: false })).toBe(false);
  });

  it('treats a missing flag as line-level', () => {
    expect(suggestionManager._isFileLevel({})).toBe(false);
  });

  it('excludes a boolean-true file-level suggestion from lineTargets even with a stray line number', () => {
    // A file-level suggestion from the analyses path carrying a stray line_start
    // must NOT be routed to ensureLinesVisible. The lineTargets filter excludes
    // any suggestion where _isFileLevel() is true, so verify that predicate here.
    const analysesFileLevel = { file: 'src/utils/helpers.js', is_file_level: true, line_start: 42 };
    expect(suggestionManager._isFileLevel(analysesFileLevel)).toBe(true);
  });
});

describe('SuggestionManager chat button event delegation', () => {
  let suggestionManager;
  let clickHandlers;
  let mockChatPanel;

  beforeEach(() => {
    clickHandlers = [];
    // Capture all click handlers registered via document.addEventListener
    global.document = {
      addEventListener: vi.fn((event, handler) => {
        if (event === 'click') clickHandlers.push(handler);
      }),
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
      createElement: vi.fn(() => ({
        className: '', innerHTML: '', textContent: '',
        appendChild: vi.fn(), remove: vi.fn(),
        querySelector: vi.fn(() => null),
      })),
    };

    mockChatPanel = {
      open: vi.fn(),
    };
    global.window.chatPanel = mockChatPanel;

    suggestionManager = new SuggestionManager({
      currentPR: { id: 'review-1' },
      escapeHtml: (s) => s,
    });
  });

  afterEach(() => {
    global.window.chatPanel = undefined;
    global.document = undefined;
  });

  /**
   * Build a mock DOM tree simulating a click on the Chat button
   * within a line-level AI suggestion (not in a file-comments-zone).
   */
  function buildLineLevelChatClick() {
    // The chat button element
    const chatBtn = {
      dataset: {
        suggestionId: '42',
        file: 'src/utils.js',
        title: 'Consider null check',
      },
      closest: vi.fn((selector) => {
        if (selector === '.ai-action-chat') return chatBtn;
        if (selector === '.file-comments-zone') return null; // NOT in file-comments-zone
        if (selector === '.ai-suggestion') return suggestionDiv;
        return null;
      }),
    };

    // The parent .ai-suggestion div
    const suggestionDiv = {
      dataset: {
        originalBody: JSON.stringify('Add a null check before accessing .length'),
        lineNumber: '15',
      },
      querySelector: vi.fn((selector) => {
        if (selector === '.ai-suggestion-badge, .praise-badge') {
          return { dataset: { type: 'bug' }, classList: { contains: () => false } };
        }
        if (selector === '.ai-title') {
          return { textContent: 'Consider null check' };
        }
        return null;
      }),
    };

    return { chatBtn, suggestionDiv };
  }

  it('should call chatPanel.open with suggestionContext when chat button is clicked on a line-level suggestion', () => {
    const { chatBtn } = buildLineLevelChatClick();

    // Build a mock event where e.target.closest('.ai-action-chat') returns chatBtn
    const mockEvent = {
      target: {
        closest: vi.fn((selector) => {
          if (selector === '.ai-action-chat') return chatBtn;
          if (selector === '.btn-reasoning-toggle') return null;
          if (selector === '.reasoning-popover') return null;
          return null;
        }),
      },
      stopPropagation: vi.fn(),
      preventDefault: vi.fn(),
    };

    // The first click handler registered should be the chat button handler
    expect(clickHandlers.length).toBeGreaterThanOrEqual(1);
    const chatHandler = clickHandlers[0];
    chatHandler(mockEvent);

    expect(mockEvent.stopPropagation).toHaveBeenCalled();
    expect(mockChatPanel.open).toHaveBeenCalledTimes(1);

    const openArgs = mockChatPanel.open.mock.calls[0][0];
    expect(openArgs.reviewId).toBe('review-1');
    expect(openArgs.suggestionId).toBe('42');
    expect(openArgs.suggestionContext).toBeDefined();
    expect(openArgs.suggestionContext.title).toBe('Consider null check');
    expect(openArgs.suggestionContext.body).toBe('Add a null check before accessing .length');
    expect(openArgs.suggestionContext.type).toBe('bug');
    expect(openArgs.suggestionContext.file).toBe('src/utils.js');
    expect(openArgs.suggestionContext.line_start).toBe(15);
  });

  it('should NOT handle click if button is inside .file-comments-zone (handled by FileCommentManager)', () => {
    const { chatBtn } = buildLineLevelChatClick();
    // Override closest to return a zone for .file-comments-zone
    chatBtn.closest = vi.fn((selector) => {
      if (selector === '.ai-action-chat') return chatBtn;
      if (selector === '.file-comments-zone') return {}; // IS in file-comments-zone
      return null;
    });

    const mockEvent = {
      target: {
        closest: vi.fn((selector) => {
          if (selector === '.ai-action-chat') return chatBtn;
          return null;
        }),
      },
      stopPropagation: vi.fn(),
      preventDefault: vi.fn(),
    };

    const chatHandler = clickHandlers[0];
    chatHandler(mockEvent);

    expect(mockChatPanel.open).not.toHaveBeenCalled();
  });

  it('should NOT handle click if chatPanel is not available', () => {
    global.window.chatPanel = undefined;

    const { chatBtn } = buildLineLevelChatClick();
    const mockEvent = {
      target: {
        closest: vi.fn((selector) => {
          if (selector === '.ai-action-chat') return chatBtn;
          return null;
        }),
      },
      stopPropagation: vi.fn(),
    };

    const chatHandler = clickHandlers[0];
    chatHandler(mockEvent);

    // Should not throw, just silently do nothing
    expect(mockEvent.stopPropagation).not.toHaveBeenCalled();
  });

  it('should ignore chat buttons not inside an .ai-suggestion', () => {
    // Chat button with no parent .ai-suggestion (e.g. gutter chat button, comment form button)
    const chatBtn = {
      dataset: {},
      closest: vi.fn((selector) => {
        if (selector === '.ai-action-chat') return chatBtn;
        if (selector === '.file-comments-zone') return null;
        if (selector === '.ai-suggestion') return null; // No parent suggestion div
        return null;
      }),
    };

    const mockEvent = {
      target: {
        closest: vi.fn((selector) => {
          if (selector === '.ai-action-chat') return chatBtn;
          return null;
        }),
      },
      stopPropagation: vi.fn(),
    };

    const chatHandler = clickHandlers[0];
    chatHandler(mockEvent);

    // Should bail out — these clicks are handled by other managers
    expect(mockChatPanel.open).not.toHaveBeenCalled();
    expect(mockEvent.stopPropagation).not.toHaveBeenCalled();
  });
});
