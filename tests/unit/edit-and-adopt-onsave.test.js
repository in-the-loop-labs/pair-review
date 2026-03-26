// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the onSave callback wired inside PRManager.editAndAdoptSuggestion().
 *
 * editAndAdoptSuggestion calls commentManager.displaySuggestionEditForm with an
 * onSave callback that POSTs to /api/reviews/:id/suggestions/:sid/edit, then
 * collapses the suggestion card, builds a comment object, displays it, and
 * notifies the AI panel. These tests capture the onSave callback and invoke it
 * directly to verify each step.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import the actual PRManager class from production code
const { PRManager } = require('../../public/js/pr.js');

// Mock global fetch
const mockFetch = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();

  global.fetch = mockFetch;

  global.window = {
    aiPanel: {
      addComment: vi.fn(),
      updateFindingStatus: vi.fn(),
    },
  };

  global.document = {
    querySelector: vi.fn(),
    querySelectorAll: vi.fn(() => []),
    getElementById: vi.fn(() => null),
  };

  global.alert = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Create a minimal PRManager wired for editAndAdoptSuggestion tests.
 * Every dependency is stubbed; only the onSave callback logic is real.
 */
function createTestPRManager() {
  const prManager = Object.create(PRManager.prototype);

  prManager.currentPR = {
    id: 'review-42',
    owner: 'test-owner',
    repo: 'test-repo',
    number: 7,
  };

  prManager.suggestionNavigator = {
    suggestions: [],
    updateSuggestions: vi.fn(),
  };

  prManager.commentMinimizer = {
    refreshIndicators: vi.fn(),
  };

  prManager.updateCommentCount = vi.fn();

  // extractSuggestionData returns the text/type/title for the suggestion
  prManager.extractSuggestionData = vi.fn(() => ({
    suggestionText: 'raw text',
    formattedBody: '<p>formatted</p>',
    suggestionType: 'issue',
    suggestionTitle: 'Fix the thing',
  }));

  // getFileAndLineInfo returns positional info. isFileLevel=false for line-level.
  const mockSuggestionRow = {};
  prManager.getFileAndLineInfo = vi.fn(() => ({
    suggestionRow: mockSuggestionRow,
    lineNumber: '15',
    fileName: 'src/app.js',
    diffPosition: '3',
    side: 'RIGHT',
    isFileLevel: false,
  }));

  // commentManager.displaySuggestionEditForm captures callbacks
  prManager.commentManager = {
    displaySuggestionEditForm: vi.fn(),
  };

  prManager.collapseSuggestionForAdoption = vi.fn();
  prManager.displayUserComment = vi.fn();

  return prManager;
}

/**
 * Call editAndAdoptSuggestion and capture the onSave callback that gets
 * passed to commentManager.displaySuggestionEditForm.
 * Returns { prManager, onSave, onCancel, suggestionRow }.
 */
async function setupAndCapture(suggestionId = 'sug-99') {
  // Set up DOM element that editAndAdoptSuggestion expects to find
  const mockSuggestionDiv = { dataset: { suggestionId } };
  global.document.querySelector = vi.fn(() => mockSuggestionDiv);

  const prManager = createTestPRManager();
  const suggestionRow = prManager.getFileAndLineInfo().suggestionRow;

  await prManager.editAndAdoptSuggestion(suggestionId);

  const callArgs = prManager.commentManager.displaySuggestionEditForm.mock.calls[0];
  const onSave = callArgs[2];
  const onCancel = callArgs[3];

  return { prManager, onSave, onCancel, suggestionRow };
}

describe('editAndAdoptSuggestion onSave callback', () => {
  it('calls fetch with the correct URL, method, and body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ userCommentId: 'uc-1', formattedBody: '<p>edited</p>' }),
    });

    const { onSave } = await setupAndCapture('sug-99');
    await onSave('my edited text');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/reviews/review-42/suggestions/sug-99/edit');
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({
      action: 'adopt_edited',
      editedText: 'my edited text',
    });
  });

  it('calls collapseSuggestionForAdoption, displayUserComment, and _notifyAdoption on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ userCommentId: 'uc-5', formattedBody: '<b>result</b>' }),
    });

    const { prManager, onSave, suggestionRow } = await setupAndCapture('sug-77');
    await onSave('edited');

    // collapseSuggestionForAdoption called with correct args
    expect(prManager.collapseSuggestionForAdoption).toHaveBeenCalledWith(suggestionRow, 'sug-77');

    // displayUserComment called with the built comment and the suggestion row
    expect(prManager.displayUserComment).toHaveBeenCalledTimes(1);
    const [comment, row] = prManager.displayUserComment.mock.calls[0];
    expect(row).toBe(suggestionRow);
    expect(comment.id).toBe('uc-5');
    expect(comment.parent_id).toBe('sug-77');

    // _notifyAdoption side effects: aiPanel updated, navigator updated
    expect(window.aiPanel.addComment).toHaveBeenCalledWith(comment);
    expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledWith('sug-77', 'adopted');
    expect(prManager.updateCommentCount).toHaveBeenCalled();
  });

  it('builds the comment object with correct fields from context and API response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ userCommentId: 'uc-10', formattedBody: '<p>final</p>' }),
    });

    const { prManager, onSave } = await setupAndCapture('sug-42');
    await onSave('whatever');

    const comment = prManager.displayUserComment.mock.calls[0][0];
    expect(comment).toEqual(expect.objectContaining({
      id: 'uc-10',
      file: 'src/app.js',
      line_start: 15,
      body: '<p>final</p>',
      type: 'issue',
      title: 'Fix the thing',
      parent_id: 'sug-42',
      diff_position: 3,
      side: 'RIGHT',
    }));
    // created_at should be an ISO timestamp string
    expect(comment.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('throws when fetch returns a non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });

    const { prManager, onSave } = await setupAndCapture('sug-err');

    await expect(onSave('text')).rejects.toThrow('Failed to adopt suggestion with edits');

    // Should NOT have called downstream methods
    expect(prManager.collapseSuggestionForAdoption).not.toHaveBeenCalled();
    expect(prManager.displayUserComment).not.toHaveBeenCalled();

    // Should have alerted the user
    expect(global.alert).toHaveBeenCalledWith(
      expect.stringContaining('Failed to save suggestion')
    );
  });

  it('throws when fetch rejects with a network error', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const { prManager, onSave } = await setupAndCapture('sug-net');

    await expect(onSave('text')).rejects.toThrow('Failed to fetch');

    expect(prManager.collapseSuggestionForAdoption).not.toHaveBeenCalled();
    expect(prManager.displayUserComment).not.toHaveBeenCalled();

    expect(global.alert).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch')
    );
  });

  it('falls back to raw suggestionText when formattedBody is empty string', async () => {
    const mockSuggestionDiv = { dataset: { suggestionId: 'sug-fallback' } };
    global.document.querySelector = vi.fn(() => mockSuggestionDiv);

    const prManager = createTestPRManager();
    prManager.extractSuggestionData = vi.fn(() => ({
      suggestionText: 'raw text',
      formattedBody: '',
      suggestionType: 'issue',
      suggestionTitle: 'Title',
    }));

    await prManager.editAndAdoptSuggestion('sug-fallback');

    const callArgs = prManager.commentManager.displaySuggestionEditForm.mock.calls[0];
    const suggestion = callArgs[0];
    expect(suggestion.body).toBe('raw text');
  });
});
