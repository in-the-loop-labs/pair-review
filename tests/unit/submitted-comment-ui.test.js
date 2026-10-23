// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

window.reviewModal = {}; // The tests create modal instances explicitly.
const { PRManager } = require('../../public/js/pr.js');
const { ReviewModal } = require('../../public/js/components/ReviewModal.js');
const { CommentManager } = require('../../public/js/modules/comment-manager.js');
const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');
const PierreBridge = require('../../public/js/modules/pierre-bridge.js');
const { AIPanel } = require('../../public/js/components/AIPanel.js');
const { getPostedCommentIcon, shouldHidePostedComment } = require('../../public/js/utils/posted-comment.js');

let comments, fetchMock;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = `
    <button id="review-button"><span class="review-button-text"></span></button>
    <button id="clear-comments-btn"></button>
    <div id="diff"><table><tbody><tr data-line="10"></tr><tr data-line="11"></tr></tbody></table></div>
    <div class="file-comments-zone"><div class="file-comments-container"></div></div>`;
  window.aiPanel = { setComments: vi.fn(), updateFindingStatus: vi.fn() };
  window.toast = { showSuccess: vi.fn(), showWarning: vi.fn(), showError: vi.fn() };
  window.CommentManager = CommentManager;
  window.getPostedCommentIcon = getPostedCommentIcon;
  window.shouldHidePostedComment = shouldHidePostedComment;
  window.escapeHtmlAttribute = text => ReviewModal.escapeHtml(text);
  comments = [
    { id: 1, status: 'active', file: 'src/a.js', line_start: 10, body: 'New line' },
    { id: 2, status: 'submitted', file: 'src/a.js', line_start: 11, body: 'Old line' },
    { id: 3, status: 'active', is_file_level: 1, file: 'src/b.js', body: 'New file' },
    { id: 4, status: 'submitted', is_file_level: 1, file: 'src/b.js', body: 'Old file' },
    { id: 5, status: 'draft', is_file_level: 1, file: 'src/b.js', body: 'Saved draft' },
  ];
  fetchMock = vi.fn(async (url, options) => {
    if (url === '/api/pr/acme/widget/7/submit-review' && options?.method === 'POST') {
      const status = JSON.parse(options.body).event === 'DRAFT' ? 'draft' : 'submitted';
      comments = comments.map(c => c.status === 'active' ? { ...c, status } : c);
      return { ok: true, json: async () => ({ message: 'Posted' }) };
    }
    if (url === '/api/reviews/42/comments' || url === '/api/reviews/42/comments?includeDismissed=true') {
      return { ok: true, json: async () => ({ comments }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeManager() {
  const manager = Object.create(PRManager.prototype);
  manager.currentPR = { id: 42, owner: 'acme', repo: 'widget', number: 7 };
  manager.ensureLinesVisible = vi.fn();
  manager.findFileElement = () => document.querySelector('#diff');
  manager.getLineNumber = row => Number(row.dataset.line);
  manager.commentManager = new CommentManager(manager);
  manager.commentManager.isLineInDiffHunk = () => true;
  manager.fileCommentManager = new FileCommentManager(manager);
  manager.fileCommentManager.findZoneForFile = () => document.querySelector('.file-comments-zone');
  manager.splitButton = { updateCommentCount: vi.fn() };
  manager.updatePendingDraftIndicator = vi.fn();
  window.prManager = manager;
  return manager;
}

function makeModal() {
  const modal = Object.create(ReviewModal.prototype);
  modal.createModal();
  modal.setupEventListeners();
  modal.setSubmittingState = vi.fn();
  modal.restoreAssistedByToggle = vi.fn();
  modal.updateAISummaryLink = vi.fn();
  modal.applyHostName = vi.fn();
  modal.applySubmitButtonIcon = vi.fn();
  window.prManager.reviewModal = modal;
  return modal;
}

function selectEvent(modal, event) {
  modal.modal.querySelector(`input[value="${event}"]`).checked = true;
  modal.updateTextareaState();
}

describe('posted comment UI', () => {
  it('shows posted line/file comments with icons by default, counting only active data', async () => {
    const manager = makeManager();
    await manager.loadUserComments();
    expect(document.querySelectorAll('.user-comment-row')).toHaveLength(2);
    expect(document.querySelectorAll('.file-comment-card')).toHaveLength(3);
    expect(document.querySelectorAll('.posted-comment-icon[title="Posted comment"]')).toHaveLength(3);
    expect(document.querySelector('.review-button-text').textContent).toBe('2 comments');
    expect(manager.splitButton.updateCommentCount).toHaveBeenLastCalledWith(2);
    expect(window.aiPanel.setComments.mock.lastCall[0]).toHaveLength(5);
    const panel = Object.create(AIPanel.prototype);
    expect(panel.renderCommentItem(comments[1], 0)).toContain('title="Posted comment"');
    expect(panel.renderCommentItem(comments[0], 0)).not.toContain('posted-comment-icon');

    const modal = makeModal();
    modal.show();
    expect(modal.modal.querySelector('.review-comment-count').textContent).toContain('2 comments will be submitted');
    expect(modal.modal.querySelectorAll('.comment-history')).toHaveLength(0);
    // Unrenderable active comments still belong to the pending review.
    manager.addUserComment({ id: 6, file: 'not-in-diff.js', body: 'Not rendered' });
    manager.updateCommentCount();
    expect(document.querySelector('.review-button-text').textContent).toBe('3 comments');
    expect(modal.modal.querySelector('.review-comment-count').textContent).toContain('3 comments will be submitted');
  });

  it('applies the preference immediately, survives cancellation/reload, and never hides saved drafts', async () => {
    const manager = makeManager();
    await manager.loadUserComments();
    const modal = makeModal();
    modal.show();
    const checkbox = modal.modal.querySelector('#hide-posted-comments');
    expect(checkbox.checked).toBe(false);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelectorAll('.file-comment-card:not(.posted-comment-hidden)')).toHaveLength(2);
    modal.handleCloseClick();
    expect(localStorage.getItem('pair-review-hide-posted-comments')).toBe('true');
    expect(document.querySelectorAll('.user-comment-row:not(.posted-comment-hidden)')).toHaveLength(1);
    expect(document.querySelectorAll('.file-comment-card:not(.posted-comment-hidden)')).toHaveLength(2);
    expect(window.aiPanel.setComments.mock.lastCall[0].map(c => c.id)).toEqual([1, 3, 5]);
    expect(fetchMock.mock.calls.every(([, options]) => !options)).toBe(true);

    const reloaded = makeManager();
    await reloaded.loadUserComments();
    const reopened = makeModal();
    reopened.show();
    expect(reopened.modal.querySelector('#hide-posted-comments').checked).toBe(true);
    expect(document.querySelector('.review-button-text').textContent).toBe('2 comments');
    selectEvent(reopened, 'DRAFT');
    expect(reopened.modal.querySelector('.hide-posted-comments-option').hidden).toBe(true);
    selectEvent(reopened, 'COMMENT');
    expect(reopened.modal.querySelector('.hide-posted-comments-option').hidden).toBe(false);
    reopened.modal.querySelector('#hide-posted-comments').checked = false;
    await reopened.handleHidePostedToggle();
    reopened.handleCloseClick();
    expect(document.querySelectorAll('.posted-comment-icon')).toHaveLength(3);
    expect(localStorage.getItem('pair-review-hide-posted-comments')).toBe('false');
  });

  it('keeps the latest preference when toggled while comments are loading', async () => {
    const manager = makeManager();
    await manager.loadUserComments();
    let release;
    manager.ensureLinesVisible.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const loading = manager.loadUserComments();
    await vi.waitFor(() => expect(manager.ensureLinesVisible).toHaveBeenCalledTimes(2));
    const modal = makeModal();
    modal.show();
    const checkbox = modal.modal.querySelector('#hide-posted-comments');
    for (const checked of [true, false, true]) {
      checkbox.checked = checked;
      modal.handleHidePostedToggle();
    }
    release();
    await loading;
    expect(document.querySelectorAll('.user-comment-row')).toHaveLength(2);
    expect(document.querySelectorAll('.user-comment-row:not(.posted-comment-hidden)')).toHaveLength(1);
    expect(document.querySelectorAll('.file-comment-card:not(.posted-comment-hidden)')).toHaveLength(2);
    expect(localStorage.getItem('pair-review-hide-posted-comments')).toBe('true');
  });

  it('does not discard unsaved active or draft edits when toggled and cancelled', async () => {
    const manager = makeManager();
    await manager.loadUserComments();
    await manager.editUserComment(1);
    const textarea = document.querySelector('#edit-comment-1');
    textarea.value = 'Unsaved active edit';
    const zone = document.querySelector('.file-comments-zone');
    manager.fileCommentManager.editFileComment(zone, comments[4]);
    const draftTextarea = zone.querySelector('[data-comment-id="5"] textarea');
    draftTextarea.value = 'Unsaved draft edit';
    const modal = makeModal();
    modal.show();
    const checkbox = modal.modal.querySelector('#hide-posted-comments');
    checkbox.checked = true;
    modal.handleHidePostedToggle();
    checkbox.checked = false;
    modal.handleHidePostedToggle();
    modal.handleCloseClick();
    expect(document.querySelector('#edit-comment-1')).toBe(textarea);
    expect(textarea.value).toBe('Unsaved active edit');
    expect(zone.querySelector('[data-comment-id="5"] textarea')).toBe(draftTextarea);
    expect(draftTextarea.value).toBe('Unsaved draft edit');
    expect(manager.ensureLinesVisible).toHaveBeenCalledTimes(1);
  });

  it('passes posted comments to Pierre annotations unless submitted comments are hidden', async () => {
    const manager = makeManager();
    const bridge = Object.create(PierreBridge.prototype);
    const annotations = document.createElement('div');
    document.body.appendChild(annotations);
    manager.pierreBridge = {
      files: new Map([['src/a.js', {}]]),
      removeAnnotationsByType: () => annotations.replaceChildren(),
      addAnnotations: (_file, items) => items.forEach(item => annotations.appendChild(bridge._renderCommentAnnotation(item.data, item.id))),
    };
    await manager.loadUserComments();
    expect(annotations.querySelectorAll('.user-comment-row')).toHaveLength(2);
    expect(annotations.querySelectorAll('.posted-comment-icon')).toHaveLength(1);
    localStorage.setItem('pair-review-hide-posted-comments', 'true');
    manager.applyPostedCommentVisibility();
    expect(annotations.querySelectorAll('.user-comment-row:not(.posted-comment-hidden)')).toHaveLength(1);
    expect(annotations.querySelectorAll('.user-comment-row:not(.posted-comment-hidden) .posted-comment-icon')).toHaveLength(0);
    // Pierre recreates annotation containers when suggestions or forms change.
    annotations.replaceChildren(bridge._renderCommentAnnotation(comments[1], 'comment-2'));
    expect(annotations.querySelector('.user-comment-row').classList.contains('posted-comment-hidden')).toBe(true);
  });

  it.each(['COMMENT', 'DRAFT'])('refreshes pending counts after %s submission and reload', async event => {
    const manager = makeManager();
    await manager.loadUserComments();
    const modal = makeModal();
    modal.show();
    selectEvent(modal, event);
    await modal.submitReview();
    expect(fetchMock).toHaveBeenCalledWith('/api/pr/acme/widget/7/submit-review', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ event, body: '' }),
    }));
    expect(document.querySelector('.review-button-text').textContent).toBe('0 comments');
    expect(document.querySelectorAll('.posted-comment-icon')).toHaveLength(5);
    modal.show();
    expect(modal.modal.querySelector('.review-comment-count').style.display).toBe('none');
    const reloaded = makeManager();
    await reloaded.loadUserComments();
    expect(reloaded.getPendingCommentCount()).toBe(0);
    expect(document.querySelectorAll('.posted-comment-icon')).toHaveLength(5);
  });

  it('uses active data for the large-review warning and request-changes validation', async () => {
    const manager = makeManager();
    manager.userComments = [...Array.from({ length: 51 }, (_, id) => ({ id, status: 'active' })), ...comments];
    const modal = makeModal();
    modal.show();
    expect(modal.modal.querySelector('#large-review-warning').style.display).toBe('block');
    manager.userComments = [...comments, ...Array.from({ length: 60 }, (_, id) => ({ id: id + 10, status: 'submitted' }))];
    modal.updateCommentCount();
    expect(modal.modal.querySelector('#large-review-warning').style.display).toBe('none');
    expect(modal.modal.querySelector('.review-comment-count').textContent).toContain('2 comments will be submitted');
    manager.userComments = manager.userComments.filter(c => c.status !== 'active');
    modal.updateCommentCount();
    expect(modal.modal.querySelector('#large-review-warning').style.display).toBe('none');
    selectEvent(modal, 'REQUEST_CHANGES');
    await modal.submitReview();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(modal.modal.querySelector('#review-error-message').textContent).toContain('Please add comments');
  });

  it('keeps hidden submitted comments out after submission and reload without hiding drafts', async () => {
    localStorage.setItem('pair-review-hide-posted-comments', 'true');
    const manager = makeManager();
    await manager.loadUserComments();
    await makeModal().submitReview();
    expect(manager.getPendingCommentCount()).toBe(0);
    expect(window.aiPanel.setComments.mock.lastCall[0].map(c => c.id)).toEqual([5]);
    expect(document.querySelectorAll('.user-comment-row:not(.posted-comment-hidden)')).toHaveLength(0);
    expect(document.querySelectorAll('.file-comment-card:not(.posted-comment-hidden)')).toHaveLength(1);
    await makeManager().loadUserComments();
    expect(document.querySelectorAll('.file-comment-card:not(.posted-comment-hidden)')).toHaveLength(1);
  });

  it('updates the pending data on line/file creation, adoption, edit and dismissal', async () => {
    const manager = makeManager();
    await manager.loadUserComments();
    const row = document.createElement('tr');
    row.innerHTML = '<td><textarea data-file="src/a.js" data-line="10">Created line</textarea></td>';
    document.querySelector('#diff tbody').appendChild(row);
    manager.commentManager.currentCommentForm = row;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ commentId: 6 }) });
    await manager.commentManager.saveUserComment(row.querySelector('textarea'), row);
    expect(manager.getPendingCommentCount()).toBe(3);
    const zone = document.querySelector('.file-comments-zone');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ commentId: 7 }) });
    await manager.fileCommentManager.saveFileComment(zone, 'src/b.js', 'Created file');
    expect(manager.getPendingCommentCount()).toBe(4);
    const body = zone.querySelector('[data-comment-id="7"] .user-comment-body');
    fetchMock.mockResolvedValueOnce({ ok: true });
    await manager.fileCommentManager.saveEditedComment(zone, 7, 'Edited file', body);
    manager.applyPostedCommentVisibility();
    expect(manager.userComments.find(c => c.id === 7).body).toBe('Edited file');
    expect(zone.querySelector('[data-comment-id="7"] .user-comment-body').textContent).toBe('Edited file');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await manager.fileCommentManager.deleteFileComment(zone, 7);
    expect(manager.getPendingCommentCount()).toBe(3);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await manager.deleteUserComment(6);
    expect(manager.getPendingCommentCount()).toBe(2);
    manager._notifyAdoption(9, { id: 8, parent_id: 9, body: 'Adopted' });
    expect(manager.getPendingCommentCount()).toBe(3);
  });

  it('does not resurrect dismissed panel comments when the preference changes', async () => {
    const manager = makeManager();
    await manager.loadUserComments();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await manager.deleteUserComment(1);
    manager.applyPostedCommentVisibility();
    expect(window.aiPanel.setComments.mock.lastCall[0].map(c => c.id)).not.toContain(1);
    window.aiPanel.showDismissedComments = true;
    manager.applyPostedCommentVisibility();
    expect(window.aiPanel.setComments.mock.lastCall[0].find(c => c.id === 1).status).toBe('inactive');
  });

  it('does not render inactive comments or count them as pending', async () => {
    comments = [{ id: 8, status: 'inactive', file: 'src/a.js', line_start: 10, body: 'Dismissed' }];
    const manager = makeManager();
    await manager.loadUserComments(true);
    expect(document.querySelectorAll('.user-comment-row, .file-comment-card')).toHaveLength(0);
    expect(manager.getPendingCommentCount()).toBe(0);
  });

  it.each(['http', 'network'])('does not report a failed submit when the post-submit refresh fails (%s)', async failure => {
    const manager = makeManager();
    await manager.loadUserComments();
    const originalFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((url, options) => {
      if (!options) {
        if (failure === 'network') return Promise.reject(new Error('offline'));
        return Promise.resolve({ ok: false });
      }
      return originalFetch(url, options);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const modal = makeModal();
    await modal.submitReview();
    expect(window.toast.showSuccess).toHaveBeenCalled();
    expect(window.toast.showWarning).toHaveBeenCalledWith(expect.stringContaining('Review posted'));
    expect(modal.modal.querySelector('#review-error-message').textContent).toBe('');
    expect(manager.updatePendingDraftIndicator).toHaveBeenCalledWith(null);
  });
});
