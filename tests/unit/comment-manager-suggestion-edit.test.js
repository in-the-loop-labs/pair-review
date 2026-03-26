// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for CommentManager.displaySuggestionEditForm()
 *
 * Tests the edit form that appears when a user chooses to edit an AI
 * suggestion before adopting it. The form should display the suggestion
 * body in a textarea and call onSave/onCancel callbacks without making
 * any API calls.
 *
 * Regression test: displaySuggestionEditForm must NOT call fetch.
 * Editing a suggestion should only invoke the onSave callback with
 * the edited text — the caller is responsible for persisting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Setup global.window before importing production code that assigns to it
window.escapeHtmlAttribute = (s) => s;
window.emojiPicker = undefined;

// Import the actual CommentManager class from production code
const { CommentManager } = require('../../public/js/modules/comment-manager.js');

/**
 * Create a minimal CommentManager instance for testing
 */
function createTestCommentManager() {
  const commentManager = Object.create(CommentManager.prototype);
  commentManager.prManager = null;
  commentManager.currentCommentForm = null;
  commentManager.autoResizeTextarea = vi.fn();
  commentManager.updateSuggestionButtonState = vi.fn();
  commentManager.insertSuggestionBlock = vi.fn();
  return commentManager;
}

/**
 * Create a minimal suggestion object
 */
function createSuggestion(overrides = {}) {
  return {
    id: 'sug-1',
    body: 'const x = 1;',
    type: 'issue',
    title: 'Use const instead of let',
    file: 'src/app.js',
    lineNumber: 42,
    diffPosition: 10,
    side: 'RIGHT',
    ...overrides,
  };
}

/**
 * Build a minimal DOM table with a tbody and a target row.
 * Returns { table, tbody, targetRow }.
 */
function createTableDOM() {
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  const targetRow = document.createElement('tr');
  targetRow.className = 'target-row';
  tbody.appendChild(targetRow);
  table.appendChild(tbody);
  document.body.appendChild(table);
  return { table, tbody, targetRow };
}

describe('CommentManager.displaySuggestionEditForm', () => {
  let commentManager;
  let table;
  let tbody;
  let targetRow;

  beforeEach(() => {
    commentManager = createTestCommentManager();
    ({ table, tbody, targetRow } = createTableDOM());
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('creates form row after targetRow with correct classes', () => {
    const suggestion = createSuggestion();

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, vi.fn(), vi.fn()
    );

    expect(formRow.tagName).toBe('TR');
    expect(formRow.classList.contains('user-comment-row')).toBe(true);
    expect(formRow.classList.contains('suggestion-edit-pending')).toBe(true);
    // Inserted after targetRow
    expect(targetRow.nextSibling).toBe(formRow);
    expect(formRow.parentNode).toBe(tbody);
  });

  it('pre-fills textarea with suggestion body', () => {
    const suggestion = createSuggestion({ body: 'function hello() {}' });

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, vi.fn(), vi.fn()
    );

    const textarea = formRow.querySelector('.comment-edit-textarea');
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe('function hello() {}');
  });

  it('onSave callback receives edited text when Adopt is clicked', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const suggestion = createSuggestion({ body: 'original text' });

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, onSave, vi.fn()
    );

    const textarea = formRow.querySelector('.comment-edit-textarea');
    textarea.value = 'edited text';

    const saveBtn = formRow.querySelector('.save-edit-btn');
    saveBtn.click();
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());

    expect(onSave).toHaveBeenCalledWith('edited text');
  });

  it('onCancel callback fires when Cancel is clicked', () => {
    const onCancel = vi.fn();
    const suggestion = createSuggestion();

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, vi.fn(), onCancel
    );

    const cancelBtn = formRow.querySelector('.cancel-edit-btn');
    cancelBtn.click();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('form row is removed from DOM on save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const suggestion = createSuggestion();

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, onSave, vi.fn()
    );

    expect(formRow.parentNode).toBe(tbody);

    const saveBtn = formRow.querySelector('.save-edit-btn');
    saveBtn.click();
    await vi.waitFor(() => expect(formRow.parentNode).toBeNull());
  });

  it('form row is removed from DOM on cancel', () => {
    const suggestion = createSuggestion();

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, vi.fn(), vi.fn()
    );

    expect(formRow.parentNode).toBe(tbody);

    const cancelBtn = formRow.querySelector('.cancel-edit-btn');
    cancelBtn.click();

    expect(formRow.parentNode).toBeNull();
  });

  it('does NOT call fetch (regression: edit must not immediately adopt)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const onSave = vi.fn().mockResolvedValue(undefined);
    const suggestion = createSuggestion();

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, onSave, vi.fn()
    );

    // Click save — should only call onSave, never fetch
    const saveBtn = formRow.querySelector('.save-edit-btn');
    saveBtn.click();
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows suggestion title and type badge correctly', () => {
    const suggestion = createSuggestion({
      type: 'praise',
      title: 'Great error handling',
    });

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, vi.fn(), vi.fn()
    );

    // Title is rendered
    const titleEl = formRow.querySelector('.adopted-title');
    expect(titleEl).not.toBeNull();
    expect(titleEl.textContent).toBe('Great error handling');

    // Praise badge is rendered
    const praiseBadge = formRow.querySelector('.adopted-praise-badge');
    expect(praiseBadge).not.toBeNull();
    expect(praiseBadge.textContent).toContain('Nice Work');
  });

  it('does not show praise badge for non-praise types', () => {
    const suggestion = createSuggestion({ type: 'issue' });

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, vi.fn(), vi.fn()
    );

    const praiseBadge = formRow.querySelector('.adopted-praise-badge');
    expect(praiseBadge).toBeNull();
  });

  it('form row stays in DOM and save button re-enables on save failure', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('network error'));
    const suggestion = createSuggestion();

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, onSave, vi.fn()
    );

    const saveBtn = formRow.querySelector('.save-edit-btn');
    saveBtn.click();
    await vi.waitFor(() => expect(saveBtn.disabled).toBe(false));

    // Form should stay in DOM for retry
    expect(formRow.parentNode).toBe(tbody);
  });

  it('removes previous pending form when opening a new one', () => {
    const suggestion1 = createSuggestion({ id: 'sug-1' });
    const suggestion2 = createSuggestion({ id: 'sug-2' });

    const formRow1 = commentManager.displaySuggestionEditForm(
      suggestion1, targetRow, vi.fn(), vi.fn()
    );
    expect(formRow1.parentNode).toBe(tbody);

    const formRow2 = commentManager.displaySuggestionEditForm(
      suggestion2, targetRow, vi.fn(), vi.fn()
    );

    // First form should have been removed
    expect(formRow1.parentNode).toBeNull();
    expect(formRow2.parentNode).toBe(tbody);
  });

  it('does not call onSave when textarea is empty or whitespace', () => {
    const onSave = vi.fn();
    const suggestion = createSuggestion();

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, onSave, vi.fn()
    );

    const textarea = formRow.querySelector('.comment-edit-textarea');
    textarea.value = '   ';

    const saveBtn = formRow.querySelector('.save-edit-btn');
    saveBtn.click();

    expect(onSave).not.toHaveBeenCalled();
    // Form should stay in DOM
    expect(formRow.parentNode).toBe(tbody);
  });

  it('save button is labeled "Save"', () => {
    const suggestion = createSuggestion();

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, vi.fn(), vi.fn()
    );

    const saveBtn = formRow.querySelector('.save-edit-btn');
    expect(saveBtn.textContent).toBe('Save');
  });

  it('shows "Lines X-Y" for multi-line suggestions', () => {
    const suggestion = createSuggestion({ lineNumber: 10, lineEnd: 15 });

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, vi.fn(), vi.fn()
    );

    const lineInfo = formRow.querySelector('.user-comment-line-info');
    expect(lineInfo).not.toBeNull();
    expect(lineInfo.textContent).toBe('Lines 10-15');
  });

  it('shows "Line X" when lineEnd equals lineNumber', () => {
    const suggestion = createSuggestion({ lineNumber: 42, lineEnd: 42 });

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, vi.fn(), vi.fn()
    );

    const lineInfo = formRow.querySelector('.user-comment-line-info');
    expect(lineInfo).not.toBeNull();
    expect(lineInfo.textContent).toBe('Line 42');
  });

  it('shows "Line X" when lineEnd is null', () => {
    const suggestion = createSuggestion({ lineNumber: 7, lineEnd: null });

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, vi.fn(), vi.fn()
    );

    const lineInfo = formRow.querySelector('.user-comment-line-info');
    expect(lineInfo).not.toBeNull();
    expect(lineInfo.textContent).toBe('Line 7');
  });

  it('sets data-line-end to lineEnd for multi-line suggestions', () => {
    const suggestion = createSuggestion({ lineNumber: 10, lineEnd: 20 });

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, vi.fn(), vi.fn()
    );

    const textarea = formRow.querySelector('.comment-edit-textarea');
    expect(textarea.dataset.lineEnd).toBe('20');
  });

  it('sets data-line-end to lineNumber when lineEnd is missing', () => {
    const suggestion = createSuggestion({ lineNumber: 10 });
    delete suggestion.lineEnd;

    const formRow = commentManager.displaySuggestionEditForm(
      suggestion, targetRow, vi.fn(), vi.fn()
    );

    const textarea = formRow.querySelector('.comment-edit-textarea');
    expect(textarea.dataset.lineEnd).toBe('10');
  });
});
