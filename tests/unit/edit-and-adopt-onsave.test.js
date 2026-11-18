// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the edit-then-adopt flow of PRManager.editAndAdoptSuggestion().
 *
 * editAndAdoptSuggestion opens a comment form under the suggestion's line (a
 * `comment-form` annotation of the viewer, pre-filled with the suggestion)
 * whose submit POSTs to /api/reviews/:id/suggestions/:sid/edit, then
 * collapses the suggestion card, builds a comment object, draws it, and
 * notifies the AI panel. These tests open the form and submit it the way
 * the form does (PRManager._handleCommentFormSubmit) to verify each step.
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
 * The collaborators are stubbed; the flow itself is the production one.
 */
function createTestPRManager(suggestionId = 'sug-99') {
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

  // The suggestion's card, as the page's card resolver hands it over.
  const suggestionCard = { dataset: { suggestionId } };
  prManager.findSuggestionCard = vi.fn(() => suggestionCard);

  // extractSuggestionData returns the text/type/title for the suggestion
  prManager.extractSuggestionData = vi.fn(() => ({
    suggestionText: 'raw text',
    formattedBody: '<p>formatted</p>',
    suggestionType: 'issue',
    suggestionTitle: 'Fix the thing',
  }));

  // getFileAndLineInfo returns positional info. isFileLevel=false for line-level.
  prManager.getFileAndLineInfo = vi.fn(() => ({
    lineNumber: '15',
    fileName: 'src/app.js',
    diffPosition: '3',
    side: 'RIGHT',
    isFileLevel: false,
  }));

  // The viewer's bridge: the form and the adopted comment are its annotations.
  prManager.pierreBridge = {
    files: new Map([['src/app.js', {}]]),
    addAnnotation: vi.fn(),
    removeAnnotation: vi.fn(),
  };

  prManager.collapseSuggestionForAdoption = vi.fn();
  prManager._renderAdoptedUserComment = vi.fn(async () => {});

  return prManager;
}

/**
 * Call editAndAdoptSuggestion and capture the form it opens.
 * Returns { prManager, form, onSave }: `form` is the comment-form annotation,
 * and `onSave(text)` submits it as the form's Save button does.
 */
async function setupAndCapture(suggestionId = 'sug-99') {
  const prManager = createTestPRManager(suggestionId);

  await prManager.editAndAdoptSuggestion(suggestionId);

  const [fileName, form] = prManager.pierreBridge.addAnnotation.mock.calls[0];
  const onSave = (text) => prManager._handleCommentFormSubmit(fileName, form.id, form.data, text);

  return { prManager, form, onSave };
}

describe('editAndAdoptSuggestion: the edit form and its submit', () => {
  it('opens a comment form under the suggestion\'s line, pre-filled with the suggestion', async () => {
    const { prManager, form } = await setupAndCapture('sug-99');

    expect(prManager.findSuggestionCard).toHaveBeenCalledWith('sug-99');
    expect(prManager.pierreBridge.addAnnotation).toHaveBeenCalledTimes(1);
    expect(prManager.pierreBridge.addAnnotation.mock.calls[0][0]).toBe('src/app.js');
    expect(form).toMatchObject({ lineNumber: '15', side: 'RIGHT', type: 'comment-form', id: 'edit-suggestion-sug-99' });
    expect(form.data).toMatchObject({
      headerTitle: 'Edit suggestion', lineStart: '15', lineEnd: '15', fileName: 'src/app.js',
      diffPosition: '3', side: 'RIGHT', showSuggestionBtn: true, initialValue: '<p>formatted</p>',
    });
    // Nothing is adopted until the form is submitted.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(prManager.collapseSuggestionForAdoption).not.toHaveBeenCalled();
  });

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

  it('collapses the suggestion, replaces the form by the adopted comment and notifies on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ userCommentId: 'uc-5', formattedBody: '<b>result</b>' }),
    });

    const { prManager, onSave } = await setupAndCapture('sug-77');
    await onSave('edited');

    // The suggestion's card is collapsed, by id.
    expect(prManager.collapseSuggestionForAdoption).toHaveBeenCalledWith('sug-77');

    // The form goes and the built comment is drawn in its place.
    expect(prManager.pierreBridge.removeAnnotation).toHaveBeenCalledWith('src/app.js', 'edit-suggestion-sug-77');
    expect(prManager._renderAdoptedUserComment).toHaveBeenCalledTimes(1);
    const [comment] = prManager._renderAdoptedUserComment.mock.calls[0];
    expect(comment.id).toBe('uc-5');
    expect(comment.parent_id).toBe('sug-77');

    // _notifyAdoption side effects: aiPanel updated, navigator updated
    expect(window.aiPanel.addComment).toHaveBeenCalledWith({ ...comment, status: 'active' });
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

    const comment = prManager._renderAdoptedUserComment.mock.calls[0][0];
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

  it('reports a non-ok response to the reader and adopts nothing', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });

    const { prManager, onSave } = await setupAndCapture('sug-err');
    await onSave('text');

    // Should NOT have called downstream methods; the form stays open.
    expect(prManager.collapseSuggestionForAdoption).not.toHaveBeenCalled();
    expect(prManager._renderAdoptedUserComment).not.toHaveBeenCalled();
    expect(prManager.pierreBridge.removeAnnotation).not.toHaveBeenCalled();

    // Should have alerted the user
    expect(global.alert).toHaveBeenCalledWith(
      expect.stringContaining('Failed to adopt suggestion with edits')
    );
  });

  it('reports a network error to the reader and adopts nothing', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const { prManager, onSave } = await setupAndCapture('sug-net');
    await onSave('text');

    expect(prManager.collapseSuggestionForAdoption).not.toHaveBeenCalled();
    expect(prManager._renderAdoptedUserComment).not.toHaveBeenCalled();
    expect(prManager.pierreBridge.removeAnnotation).not.toHaveBeenCalled();

    expect(global.alert).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch')
    );
  });

  it('an empty submission does nothing', async () => {
    const { prManager, onSave } = await setupAndCapture('sug-empty');
    await onSave('   ');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(prManager.collapseSuggestionForAdoption).not.toHaveBeenCalled();
  });

  it('falls back to raw suggestionText when formattedBody is empty string', async () => {
    const prManager = createTestPRManager('sug-fallback');
    prManager.extractSuggestionData = vi.fn(() => ({
      suggestionText: 'raw text',
      formattedBody: '',
      suggestionType: 'issue',
      suggestionTitle: 'Title',
    }));

    await prManager.editAndAdoptSuggestion('sug-fallback');

    const [, form] = prManager.pierreBridge.addAnnotation.mock.calls[0];
    expect(form.data.initialValue).toBe('raw text');
  });

  it('a suggestion on a file that is not in the pane opens nothing', async () => {
    const prManager = createTestPRManager('sug-away');
    prManager.pierreBridge.files.clear();
    await prManager.editAndAdoptSuggestion('sug-away');
    expect(prManager.pierreBridge.addAnnotation).not.toHaveBeenCalled();
    expect(global.alert).not.toHaveBeenCalled();
  });
});
