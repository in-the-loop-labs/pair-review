// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for CommentManager.getCodeFromLines() and insertSuggestionBlock()
 *
 * getCodeFromLines hands the question to the diff viewer's bridge, which
 * reads the lines from the file's parsed diff, one side only. (Regression
 * pair_review-4gbg: a suggestion on a modified line must hold the text of
 * the requested side, typically RIGHT/NEW, not of both the OLD and the NEW
 * version. The bridge's own side handling is tested in
 * tests/unit/pierre-bridge.test.js, "scroll targets, selection, code text".)
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
  return commentManager;
}

describe('CommentManager.getCodeFromLines', () => {
  let commentManager;

  beforeEach(() => {
    commentManager = createTestCommentManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function withBridge(files, getCodeFromLines) {
    const bridge = { files: new Map(files.map((name) => [name, {}])), getCodeFromLines: vi.fn(getCodeFromLines) };
    commentManager.prManager = { pierreBridge: bridge };
    return bridge;
  }

  it('returns what the bridge reads from the file, and passes the range and the side on', () => {
    const bridge = withBridge(['src/a.js'], () => 'const a = 1;\nconst b = 2;');
    expect(commentManager.getCodeFromLines('src/a.js', 10, 11, 'LEFT')).toBe('const a = 1;\nconst b = 2;');
    expect(bridge.getCodeFromLines).toHaveBeenCalledWith('src/a.js', 10, 11, 'LEFT');
  });

  it('passes a missing side on as it is: the bridge decides the side', () => {
    const bridge = withBridge(['src/a.js'], () => 'x');
    commentManager.getCodeFromLines('src/a.js', 3, 3);
    expect(bridge.getCodeFromLines).toHaveBeenCalledWith('src/a.js', 3, 3, undefined);
  });

  it('returns null when the bridge has no text for the whole range (the caller then refuses)', () => {
    withBridge(['src/a.js'], () => null);
    expect(commentManager.getCodeFromLines('src/a.js', 400, 401, 'RIGHT')).toBeNull();
  });

  it('returns the text of an empty line as an empty string, not as no text', () => {
    withBridge(['src/a.js'], () => '');
    expect(commentManager.getCodeFromLines('src/a.js', 5, 5, 'RIGHT')).toBe('');
  });

  it('returns null for a file the bridge does not hold, without asking it', () => {
    const bridge = withBridge(['src/a.js'], () => 'x');
    expect(commentManager.getCodeFromLines('src/other.js', 1, 1, 'RIGHT')).toBeNull();
    expect(bridge.getCodeFromLines).not.toHaveBeenCalled();
  });

  it('returns null without a page manager or a bridge, and never asks the document', () => {
    const query = vi.fn(() => []);
    const previous = global.document;
    global.document = { querySelectorAll: query, querySelector: query };
    try {
      expect(commentManager.getCodeFromLines('src/a.js', 1, 1, 'RIGHT')).toBeNull();
      commentManager.prManager = {};
      expect(commentManager.getCodeFromLines('src/a.js', 1, 1, 'RIGHT')).toBeNull();
      expect(query).not.toHaveBeenCalled();
    } finally {
      global.document = previous;
    }
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
