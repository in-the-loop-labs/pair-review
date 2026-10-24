// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let PRManager, ReviewModal, fetchMock, comments;

beforeEach(() => {
  document.body.innerHTML = '<button id="review-button"><span class="review-button-text"></span></button><button id="clear-comments-btn"></button><div id="diff"><table><tbody><tr></tr></tbody></table></div>';
  window.reviewModal = {}; // Avoid automatic initialization when loading the scripts.
  window.aiPanel = { setComments: vi.fn() };
  comments = [
    { id: 1, status: 'active', file: 'src/a.js', line_start: 10, body: 'New line' },
    { id: 2, status: 'submitted', file: 'src/a.js', line_start: 11, body: '<old line>' },
    { id: 3, status: 'active', is_file_level: 1, file: 'src/b.js', body: 'New file' },
    { id: 4, status: 'submitted', is_file_level: 1, file: 'src/b.js', body: 'Old file' },
  ];
  fetchMock = vi.fn(async (url, options) => {
    if (url === '/api/pr/acme/widget/7/submit-review' && options?.method === 'POST') {
      const status = JSON.parse(options.body).event === 'DRAFT' ? 'draft' : 'submitted';
      comments = comments.map(c => c.status === 'active' ? { ...c, status } : c);
      return { ok: true, json: async () => ({ message: 'Submitted' }) };
    }
    if (url === '/api/reviews/42/comments' || url === '/api/reviews/42/comments?includeDismissed=true') {
      return { ok: true, json: async () => ({ comments }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const sandbox = {
    window, document, console, fetch: fetchMock, setTimeout, clearTimeout,
    localStorage, URLSearchParams, module: { exports: {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js/pr.js'), 'utf8'), vm.createContext(sandbox));
  PRManager = sandbox.module.exports.PRManager;
  sandbox.module = { exports: {} };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js/components/ReviewModal.js'), 'utf8'), vm.createContext(sandbox));
  ReviewModal = sandbox.module.exports.ReviewModal;
});

function makeManager() {
  const manager = Object.create(PRManager.prototype);
  manager.currentPR = { id: 42, owner: 'acme', repo: 'widget', number: 7 };
  manager.ensureLinesVisible = vi.fn();
  manager.findFileElement = () => document.querySelector('#diff');
  manager.getLineNumber = () => 10;
  manager.displayUserComment = (comment) => {
    const row = document.createElement('div');
    row.className = 'user-comment-row';
    row.textContent = comment.body;
    document.querySelector('#diff').appendChild(row);
  };
  manager.fileCommentManager = {
    loadFileComments(fileComments) {
      document.querySelectorAll('.file-comment-card').forEach(card => card.remove());
      for (const comment of fileComments) {
        const card = document.createElement('div');
        card.className = 'file-comment-card user-comment';
        card.textContent = comment.body;
        document.querySelector('#diff').appendChild(card);
      }
    },
  };
  manager.splitButton = { updateCommentCount: vi.fn() };
  manager.updatePendingDraftIndicator = vi.fn();
  window.prManager = manager;
  return manager;
}

function makeModal() {
  const modal = Object.create(ReviewModal.prototype);
  modal.createModal();
  modal.setSubmittingState = vi.fn();
  modal.hide = vi.fn();
  modal.updateTextareaState = vi.fn();
  modal.restoreAssistedByToggle = vi.fn();
  modal.updateAISummaryLink = vi.fn();
  modal.applyHostName = vi.fn();
  modal.applySubmitButtonIcon = vi.fn();
  return modal;
}

describe('submitted comment UI', () => {
  it('hides empty history and excludes dismissed comments', async () => {
    comments = [{ id: 8, status: 'inactive', file: 'src/a.js', line_start: 10, body: 'Dismissed' }];
    const manager = makeManager();
    await manager.loadUserComments(true);
    const modal = makeModal();
    modal.show();
    expect(document.querySelectorAll('.user-comment-row, .file-comment-card')).toHaveLength(0);
    expect(modal.modal.querySelector('.previously-submitted').hidden).toBe(true);
    expect(modal.modal.querySelector('.previously-submitted-count').textContent).toBe('0');
    expect(modal.modal.querySelector('.saved-as-draft').hidden).toBe(true);
  });

  it('counts only pending diff comments and shows submitted line and file history collapsed', async () => {
    const manager = makeManager();
    await manager.loadUserComments();
    expect(document.querySelectorAll('.user-comment-row')).toHaveLength(1);
    expect(document.querySelectorAll('.file-comment-card')).toHaveLength(1);
    expect(document.querySelector('.review-button-text').textContent).toBe('2 comments');
    expect(manager.splitButton.updateCommentCount).toHaveBeenCalledWith(2);
    expect(window.aiPanel.setComments.mock.lastCall[0].map(c => c.id)).toEqual([1, 3]);

    const modal = makeModal();
    modal.show();
    const history = modal.modal.querySelector('.previously-submitted');
    expect(history.hidden).toBe(false);
    expect(history.open).toBe(false);
    expect(history.querySelector('summary').textContent).toContain('Previously submitted (2)');
    expect(modal.modal.querySelector('.saved-as-draft').hidden).toBe(true);
    expect(history.querySelectorAll('li')).toHaveLength(0);
    history.open = true;
    history.dispatchEvent(new Event('toggle'));
    expect([...history.querySelectorAll('li')].map(li => li.textContent)).toEqual([
      'src/a.js:11: <old line>', 'src/b.js: Old file',
    ]);
    expect(history.querySelector('li').innerHTML).toContain('&lt;old line&gt;');
  });

  it('separates posted drafts from pending comments after submission and reload', async () => {
    const manager = makeManager();
    await manager.loadUserComments();
    const modal = makeModal();
    modal.modal.querySelector('input[value="DRAFT"]').checked = true;
    modal.modal.querySelector('input[value="COMMENT"]').checked = false;
    await modal.submitReview();
    expect(fetchMock).toHaveBeenCalledWith('/api/pr/acme/widget/7/submit-review', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ event: 'DRAFT', body: '' }),
    }));
    expect(document.querySelectorAll('.user-comment-row, .file-comment-card')).toHaveLength(0);
    expect(document.querySelector('.review-button-text').textContent).toBe('0 comments');
    expect(window.aiPanel.setComments.mock.lastCall[0]).toHaveLength(0);
    modal.show();
    expect(modal.modal.querySelector('.saved-as-draft .comment-history-count').textContent).toBe('2');
    expect(modal.modal.querySelector('.previously-submitted-count').textContent).toBe('2');

    const reloaded = makeManager();
    await reloaded.loadUserComments();
    const reopened = makeModal();
    reopened.show();
    const draftHistory = reopened.modal.querySelector('.saved-as-draft');
    expect(draftHistory.hidden).toBe(false);
    expect(draftHistory.open).toBe(false);
    expect(draftHistory.querySelector('summary').textContent).toContain('Saved as draft (2)');
    expect(reopened.modal.querySelector('.previously-submitted-count').textContent).toBe('2');
    draftHistory.open = true;
    draftHistory.dispatchEvent(new Event('toggle'));
    expect([...draftHistory.querySelectorAll('li')].map(li => li.textContent)).toEqual([
      'src/a.js:10: New line', 'src/b.js: New file',
    ]);

    comments.push({ id: 5, status: 'active', file: 'src/a.js', line_start: 10, body: 'Next round' });
    await reloaded.loadUserComments();
    expect(document.querySelector('.review-button-text').textContent).toBe('1 comment');
    expect(draftHistory.querySelectorAll('li')).toHaveLength(2);
  });

  it('updates open history when the post-submit reload finishes', async () => {
    const manager = makeManager();
    await manager.loadUserComments();
    const originalFetch = fetchMock.getMockImplementation();
    let releaseReload;
    const reload = new Promise(resolve => { releaseReload = resolve; });
    fetchMock.mockImplementation(async (url, options) => {
      if (url === '/api/reviews/42/comments') await reload;
      return originalFetch(url, options);
    });

    const modal = makeModal();
    const submission = modal.submitReview();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/reviews/42/comments'));
    modal.show();
    const history = modal.modal.querySelector('.previously-submitted');
    expect(history.querySelector('.previously-submitted-count').textContent).toBe('2');
    history.open = true;
    history.dispatchEvent(new Event('toggle'));
    releaseReload();
    await submission;
    expect(history.querySelector('.previously-submitted-count').textContent).toBe('4');
    expect(history.querySelectorAll('.previously-submitted-list li')).toHaveLength(4);
  });

  it('refreshes counts on submission and retains earlier rounds after reload', async () => {
    const manager = makeManager();
    await manager.loadUserComments();
    const modal = makeModal();
    await modal.submitReview();
    expect(fetchMock).toHaveBeenCalledWith('/api/pr/acme/widget/7/submit-review', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ event: 'COMMENT', body: '' }),
    }));
    expect(fetchMock).toHaveBeenCalledWith('/api/reviews/42/comments');
    expect(document.querySelectorAll('.user-comment-row, .file-comment-card')).toHaveLength(0);
    expect(document.querySelector('.review-button-text').textContent).toBe('0 comments');
    expect(manager.splitButton.updateCommentCount).toHaveBeenLastCalledWith(0);
    expect(window.aiPanel.setComments.mock.lastCall[0]).toHaveLength(0);
    modal.show();
    const submittedHistory = modal.modal.querySelector('.previously-submitted');
    expect(submittedHistory.querySelector('.previously-submitted-count').textContent).toBe('4');
    submittedHistory.open = true;
    submittedHistory.dispatchEvent(new Event('toggle'));
    expect([...submittedHistory.querySelectorAll('li')].map(li => li.textContent)).toEqual([
      'src/a.js:10: New line', 'src/a.js:11: <old line>', 'src/b.js: New file', 'src/b.js: Old file',
    ]);

    comments.push({ id: 5, status: 'active', file: 'src/a.js', line_start: 10, body: 'Next round' });
    const reloaded = makeManager();
    await reloaded.loadUserComments();
    expect(document.querySelector('.review-button-text').textContent).toBe('1 comment');
    expect(window.aiPanel.setComments.mock.lastCall[0].map(c => c.id)).toEqual([5]);
    const reopenedModal = makeModal();
    reopenedModal.show();
    const history = reopenedModal.modal.querySelector('.previously-submitted');
    expect(history.open).toBe(false);
    expect(history.querySelector('.previously-submitted-count').textContent).toBe('4');
    history.open = true;
    history.dispatchEvent(new Event('toggle'));
    expect(history.querySelectorAll('li')).toHaveLength(4);
  });
});
