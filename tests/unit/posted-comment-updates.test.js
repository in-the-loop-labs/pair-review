// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Edited posted comments (issue #609, PR 2): the "Edited since posted" note
 * and "Update on GitHub" action in all three diff renderers, the submit
 * dialog's "Also update N edited comments", and the review history modal.
 * Updating never creates a second copy of a comment on the host.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const markdownit = require('markdown-it');
const createDOMPurify = require('dompurify');
const { configureMarkdownIt, createRenderMarkdown } = require('../../public/js/utils/markdown.js');
const PostedComment = require('../../public/js/utils/posted-comment.js');
const { CommentManager } = require('../../public/js/modules/comment-manager.js');
const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');
const PierreBridge = require('../../public/js/modules/pierre-bridge.js');
const { ReviewModal } = require('../../public/js/components/ReviewModal.js');
const ReviewHistoryModal = require('../../public/js/components/ReviewHistoryModal.js');
const { SplitButton } = require('../../public/js/components/SplitButton.js');
const { PRManager } = require('../../public/js/pr.js');

const edited = (overrides = {}) => ({
  id: 7, status: 'active', file: 'src/a.js', line_start: 3, line_end: 3, side: 'RIGHT', body: 'New text',
  publication: { state: 'posted', changed: true, comment_url: 'https://github.com/o/r/pull/1#discussion_r1' },
  ...overrides
});
const unchanged = (overrides = {}) => edited({ publication: { state: 'posted', changed: false }, ...overrides });
const jsonResponse = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

beforeEach(() => {
  document.body.innerHTML = '';
  window.PostedComment = PostedComment;
  window.getPostedCommentIcon = PostedComment.getPostedCommentIcon;
  window.escapeHtmlAttribute = s => PostedComment.escapeHtml(s);
  delete window.PAIR_REVIEW_LOCAL_MODE;
  delete window.RepoLinks;
  PostedComment.setUpdateError(7, null);
});

afterEach(() => {
  delete window.prManager;
  delete window.toast;
  delete window.aiPanel;
  vi.restoreAllMocks();
});

describe('edited-since-posted helpers', () => {
  it('offers an update only for active, posted or drafted comments edited since posted, in PR mode', () => {
    expect(PostedComment.canUpdateOnHost(edited())).toBe(true);
    expect(PostedComment.canUpdateOnHost(edited({ publication: { state: 'draft', changed: true } }))).toBe(true);
    expect(PostedComment.canUpdateOnHost(unchanged())).toBe(false);
    expect(PostedComment.canUpdateOnHost(edited({ status: 'inactive' }))).toBe(false);
    expect(PostedComment.canUpdateOnHost({ id: 1, status: 'active', publication: null })).toBe(false);
    window.PAIR_REVIEW_LOCAL_MODE = true;
    expect(PostedComment.canUpdateOnHost(edited())).toBe(false);
    expect(PostedComment.getEditedSincePostedHtml(edited())).toBe('');
  });

  it('counts only updatable comments, never pending ones', () => {
    const comments = [edited(), edited({ id: 8 }), unchanged({ id: 9 }), { id: 10, status: 'active', publication: null }];
    expect(PostedComment.getUpdatableComments(comments).map(c => c.id)).toEqual([7, 8]);
    expect(PostedComment.getUpdatableComments(undefined)).toEqual([]);
  });

  it('renders the note with the host name and a stored error with a safe review link', () => {
    window.RepoLinks = { hostName: () => 'Forge' };
    let html = PostedComment.getEditedSincePostedHtml(edited());
    expect(html).toContain('Edited since posted');
    expect(html).toContain('Update on Forge');
    expect(html).toMatch(/posted-comment-update-error" role="alert" hidden/);
    PostedComment.setUpdateError(7, { message: "Couldn't find <this>", review_url: 'https://forge.test/r/1' });
    html = PostedComment.getEditedSincePostedHtml(edited());
    expect(html).toContain('Couldn&#39;t find &lt;this&gt;');
    expect(html).toContain('href="https://forge.test/r/1"');
    PostedComment.setUpdateError(7, { message: 'x', review_url: 'javascript:alert(1)' });
    expect(PostedComment.getEditedSincePostedHtml(edited())).not.toContain('javascript:');
  });

  it('syncs the note in place after the body and toggles busy state', () => {
    const row = document.createElement('tr');
    row.className = 'user-comment-row';
    row.dataset.commentId = '7';
    row.innerHTML = '<td><div class="user-comment"><div class="user-comment-body">b</div></div></td>';
    document.body.appendChild(document.createElement('table')).appendChild(row);
    PostedComment.syncEditedSincePosted(row, edited());
    expect(row.querySelector('.user-comment-body').nextElementSibling.className).toBe('posted-comment-edited');
    PostedComment.setUpdateBusy(7, true);
    const button = row.querySelector('.btn-update-on-host');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toBe('Updating…');
    PostedComment.setUpdateBusy(7, false);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Update on GitHub');
    PostedComment.syncEditedSincePosted(row, unchanged());
    expect(row.querySelector('.posted-comment-edited')).toBeNull();
  });

  it('requests the in-place update and reports server and network failures', async () => {
    const ok = vi.fn().mockResolvedValue(jsonResponse(200, { comment: unchanged() }));
    expect(await PostedComment.requestHostUpdate(5, 7, ok)).toEqual({ ok: true, comment: unchanged() });
    expect(ok).toHaveBeenCalledWith('/api/reviews/5/comments/7/update-on-github', expect.objectContaining({ method: 'POST' }));
    const notFound = vi.fn().mockResolvedValue(jsonResponse(404, { error: 'Deleted on GitHub', code: 'not_found_on_github' }));
    expect(await PostedComment.requestHostUpdate(5, 7, notFound)).toEqual({ ok: false,
      error: { message: 'Deleted on GitHub', code: 'not_found_on_github', review_url: null } });
    const offline = vi.fn().mockRejectedValue(new Error('offline'));
    const result = await PostedComment.requestHostUpdate(5, 7, offline);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('network');
  });

  it('labels submissions and postings for the history', () => {
    expect(PostedComment.submissionEventChip({ state: 'submitted', event: 'APPROVE' }).label).toBe('Approved');
    expect(PostedComment.submissionEventChip({ state: 'submitted', event: 'REQUEST_CHANGES' }).label).toBe('Changes requested');
    expect(PostedComment.submissionEventChip({ state: 'submitted', event: 'COMMENT' }).label).toBe('Commented');
    expect(PostedComment.submissionEventChip({ state: 'pending' }).label).toBe('Pending draft');
    expect(PostedComment.submissionEventChip({ state: 'dismissed', event: 'COMMENT' }).label).toBe('Dismissed');
    expect(PostedComment.submissionEventChip({ state: 'submitted', event: null }).label).toBe('Submitted');
    expect(PostedComment.postingLocation({ line_start: 3, line_end: 5 })).toBe('Lines 3-5');
    expect(PostedComment.postingLocation({ line_start: 3, line_end: 3 })).toBe('Line 3');
    expect(PostedComment.postingLocation({ is_file_level: 1, line_start: null })).toBe('File comment');
    expect(PostedComment.isEditPosting({ kind: 'update' })).toBe(true);
    expect(PostedComment.isEditPosting({ kind: 'post' })).toBe(false);
  });
});

describe('diff renderers show the update action only for edited posted comments', () => {
  function renderLine(comment) {
    const manager = Object.create(CommentManager.prototype);
    manager.prManager = null;
    manager.isLineInDiffHunk = () => true;
    const table = document.createElement('table');
    const target = table.insertRow();
    document.body.appendChild(table);
    manager.displayUserComment(comment, target);
    return table.querySelector('.user-comment-row');
  }
  function renderFile(comment) {
    const manager = Object.create(FileCommentManager.prototype);
    manager.prManager = null;
    window.CommentManager = CommentManager;
    const zone = document.createElement('div');
    zone.innerHTML = '<div class="file-comments-container"></div>';
    document.body.appendChild(zone);
    manager.displayUserComment(zone, { ...comment, is_file_level: 1 });
    return zone.querySelector('.file-comment-card');
  }
  function renderPierre(comment) {
    return Object.create(PierreBridge.prototype)._renderCommentAnnotation(comment, 'c-7');
  }

  it.each([['line', renderLine], ['file', renderFile], ['pierre', renderPierre]])('%s renderer', (_name, render) => {
    const element = render(edited());
    const note = element.querySelector('.posted-comment-edited');
    expect(note.textContent).toContain('Edited since posted');
    expect(note.querySelector('.btn-update-on-host').dataset.updateCommentId).toBe('7');
    expect(note.previousElementSibling.classList.contains('user-comment-body')).toBe(true);
    expect(render(unchanged()).querySelector('.posted-comment-edited')).toBeNull();
    expect(render({ ...edited(), publication: null }).querySelector('.posted-comment-edited')).toBeNull();
    window.PAIR_REVIEW_LOCAL_MODE = true;
    expect(render(edited()).querySelector('.posted-comment-edited')).toBeNull();
  });
});

describe('PRManager.updatePostedCommentOnHost', () => {
  function setup(fetchImpl) {
    const manager = Object.create(PRManager.prototype);
    manager.currentPR = { id: 5 };
    manager.userComments = [edited()];
    const row = document.createElement('div');
    row.className = 'user-comment-row';
    row.dataset.commentId = '7';
    row.innerHTML = `<div class="user-comment"><div class="user-comment-body">New text</div>${PostedComment.getEditedSincePostedHtml(edited())}</div>`;
    document.body.appendChild(row);
    global.fetch = vi.fn(fetchImpl);
    return { manager, row };
  }

  it('applies the server copy on success: the note disappears and the cache clears changed', async () => {
    const { manager, row } = setup(async () => jsonResponse(200, { comment: unchanged() }));
    const pending = manager.updatePostedCommentOnHost('7');
    expect(row.querySelector('.btn-update-on-host').disabled).toBe(true);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(row.querySelector('.posted-comment-edited')).toBeNull();
    expect(manager.userComments[0].publication.changed).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the comment edited and shows the server message on failure', async () => {
    const { manager, row } = setup(async () => jsonResponse(404, { error: 'This comment was deleted on GitHub.', code: 'not_found_on_github' }));
    const result = await manager.updatePostedCommentOnHost(7);
    expect(result.ok).toBe(false);
    const error = row.querySelector('.posted-comment-update-error');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('This comment was deleted on GitHub.');
    expect(row.querySelector('.btn-update-on-host').disabled).toBe(false);
    expect(PostedComment.isPendingComment(manager.userComments[0])).toBe(false);
    expect(manager.userComments[0].publication.changed).toBe(true);
  });

  it('coalesces double clicks into one request', async () => {
    const { manager } = setup(async () => jsonResponse(200, { comment: unchanged() }));
    await Promise.all([manager.updatePostedCommentOnHost(7), manager.updatePostedCommentOnHost(7)]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('submit dialog: Also update N edited comments', () => {
  function setup({ comments, updateResults = {} }) {
    window.toast = { showSuccess: vi.fn(), showWarning: vi.fn(), showError: vi.fn() };
    const calls = [];
    global.fetch = vi.fn(async (url) => {
      calls.push(url);
      if (url === '/api/config') return jsonResponse(200, {});
      if (url.endsWith('/submit-review')) return jsonResponse(200, { github_url: 'https://github.com/o/r/pull/1#r' });
      return jsonResponse(404, {});
    });
    const updates = [];
    window.prManager = {
      currentPR: { owner: 'o', repo: 'r', number: 1, id: 5 },
      userComments: comments,
      getPendingCommentCount: () => comments.filter(PostedComment.isPendingComment).length,
      getSubmittableCommentCount: () => comments.filter(PostedComment.isPendingComment).length,
      updatePostedCommentOnHost: vi.fn(async (id) => {
        updates.push({ id, afterSubmit: calls.some(u => u.endsWith('/submit-review')) });
        return updateResults[id] || { ok: true, comment: unchanged({ id }) };
      }),
      loadUserComments: vi.fn(async () => true),
      updatePendingDraftIndicator: vi.fn()
    };
    const modal = new ReviewModal();
    modal.show();
    return { modal, updates, calls };
  }

  it('shows the count, checked by default, and keeps it out of "will be submitted"', () => {
    const { modal } = setup({ comments: [edited(), edited({ id: 8 }), unchanged({ id: 9 }), { id: 10, status: 'active', publication: null }] });
    const option = modal.modal.querySelector('.update-edited-comments-option');
    expect(option.hidden).toBe(false);
    expect(option.textContent).toContain('Also update 2 edited comments on GitHub');
    expect(modal.modal.querySelector('#update-edited-comments').checked).toBe(true);
    expect(modal.modal.querySelector('.review-comment-count').textContent).toMatch(/1\s+comment will be submitted/);
  });

  it('is hidden when no posted comment was edited', () => {
    const { modal } = setup({ comments: [unchanged()] });
    expect(modal.modal.querySelector('.update-edited-comments-option').hidden).toBe(true);
  });

  it('updates each edited comment in turn after the submit succeeds and reports failures', async () => {
    const { modal, updates } = setup({ comments: [edited(), edited({ id: 8 })],
      updateResults: { 8: { ok: false, error: { message: 'Not allowed to edit this comment.', code: 'forbidden' } } } });
    await modal.submitReview();
    expect(updates).toEqual([{ id: 7, afterSubmit: true }, { id: 8, afterSubmit: true }]);
    expect(window.toast.showWarning).toHaveBeenCalledWith(expect.stringContaining('1 edited comment could not be updated on GitHub: Not allowed to edit this comment.'), 8000);
    expect(window.toast.showSuccess).toHaveBeenCalled();
  });

  it('skips the updates when unchecked', async () => {
    const { modal } = setup({ comments: [edited()] });
    modal.modal.querySelector('#update-edited-comments').checked = false;
    await modal.submitReview();
    expect(window.prManager.updatePostedCommentOnHost).not.toHaveBeenCalled();
  });

  it('does not update when the submit fails', async () => {
    const { modal } = setup({ comments: [edited()] });
    global.fetch = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    await modal.submitReview();
    expect(window.prManager.updatePostedCommentOnHost).not.toHaveBeenCalled();
    expect(modal.modal.querySelector('#review-error-message').textContent).toBe('boom');
  });
});

describe('review history modal', () => {
  const submissions = [
    { id: 2, state: 'submitted', event: 'APPROVE', submitted_at: '2026-10-30 12:00:00', body: 'Looks **good**',
      github_url: 'https://github.com/o/r/pull/1#pullrequestreview-2', postings: [
        { comment_id: 7, kind: 'post', body: 'Old text', file: 'src/a.js', line_start: 3, line_end: 3, side: 'RIGHT',
          github_comment_url: 'https://github.com/o/r/pull/1#discussion_r1', posted_at: '2026-10-30 12:00:00', comment_status: 'active' },
        { comment_id: 7, kind: 'update', backfilled: 1, body: 'New text', file: 'src/a.js', line_start: 3, line_end: 3, side: 'RIGHT',
          github_comment_url: 'https://github.com/o/r/pull/1#discussion_r1', posted_at: '2026-10-31 09:00:00', comment_status: 'active' },
        { comment_id: 9, kind: 'post', backfilled: 1, body: 'Gone', file: 'src/b.js', is_file_level: 1, line_start: null, comment_status: 'inactive' }
      ] },
    { id: 1, state: 'pending', event: null, created_at: '2026-10-29 08:00:00', body: '', github_url: 'javascript:alert(1)', postings: [] }
  ];

  it('renders chips, timestamps, bodies, links and edits', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { submissions }));
    const modal = new ReviewHistoryModal({ fetchImpl });
    await modal.show(5);
    expect(fetchImpl).toHaveBeenCalledWith('/api/reviews/5/submissions');
    const items = modal.modal.querySelectorAll('.review-history-submission');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('.review-history-chip').textContent).toBe('Approved');
    expect(items[0].querySelector('time').getAttribute('datetime')).toBe('2026-10-30T12:00:00.000Z');
    expect(items[0].querySelector('.review-history-summary-preview').textContent).toContain('Looks');
    expect(items[0].querySelector('.review-history-counts').textContent).toBe('2 comments · 1 edit');
    expect(modal.modal.querySelectorAll('.review-history-comment')).toHaveLength(0);
    expect(items[1].querySelector('.review-history-chip').textContent).toBe('Pending draft');
    expect(items[1].querySelector('a')).toBeNull();
    expect(items[1].textContent).toContain('0 comments · 0 edits');
    expect(items[0].querySelector('.review-history-link').getAttribute('href')).toBe('https://github.com/o/r/pull/1#pullrequestreview-2');
    items[0].querySelector('button').click();
    expect(modal.modal.querySelector('.review-history-summary').textContent).toContain('Looks');
    const comments = modal.modal.querySelectorAll('.review-history-comment');
    expect(comments[0].querySelector('.review-history-chip-edited')).toBeNull();
    expect(comments[1].querySelector('.review-history-chip-edited').textContent).toBe('edited');
    expect(comments[1].textContent).toContain('New text');
    expect(comments[1].textContent).not.toContain('approximate');
    expect(comments[2].textContent).toContain('File comment');
    expect(comments[2].textContent).toContain('approximate');
    expect(comments[2].querySelector('.review-history-chip-dismissed')).not.toBeNull();
    expect(comments[2].hasAttribute('data-jump-comment-id')).toBe(false);
    modal.showList();
    modal.modal.querySelector('[data-submission-index="1"]').click();
    expect(modal.body.textContent).toContain('No comments');
  });

  it('renders a standalone posted comment with the shared sanitized markdown and card styles', () => {
    const previous = window.renderMarkdown;
    try {
      window.renderMarkdown = createRenderMarkdown({
        md: configureMarkdownIt(markdownit),
        purify: createDOMPurify(window)
      });
      const modal = new ReviewHistoryModal();
      const body = 'Try **this**\n\n```suggestion\nconst value = "<safe>";\n```\n\n<script>alert(1)</script>';
      const item = document.createElement('ul');
      item.innerHTML = modal.renderPostedComment({ body, file: '<unsafe>.js', comment_id: 7 });
      const rendered = item.querySelector('.review-history-comment-body.user-comment-body');
      expect(rendered.innerHTML).toBe(window.renderMarkdown(body));
      expect(rendered.querySelector('pre code.language-suggestion').textContent).toBe('const value = "<safe>";\n');
      expect(rendered.querySelector('strong').textContent).toBe('this');
      expect(item.querySelector('script')).toBeNull();
      expect(item.querySelector('.review-history-comment-file').textContent).toBe('<unsafe>.js');
      item.innerHTML = modal.renderPostedComment({});
      expect(item.querySelector('.user-comment-body').innerHTML).toBe('');
      delete window.renderMarkdown;
      item.innerHTML = modal.renderPostedComment({ body: '<img src=x onerror=alert(1)>' });
      expect(item.querySelector('.user-comment-body').textContent).toBe('<img src=x onerror=alert(1)>');
      expect(item.querySelector('img')).toBeNull();
    } finally {
      if (previous) window.renderMarkdown = previous;
      else delete window.renderMarkdown;
    }
  });

  it('jumps to a comment through the comment panel and closes', async () => {
    window.aiPanel = { scrollToComment: vi.fn() };
    const modal = new ReviewHistoryModal({ fetchImpl: async () => jsonResponse(200, { submissions }) });
    await modal.show(5);
    modal.modal.querySelector('[data-submission-index="0"]').click();
    modal.modal.querySelectorAll('.review-history-comment')[1].querySelector('.review-history-comment-body').click();
    expect(window.aiPanel.scrollToComment).toHaveBeenCalledWith('7', 'src/a.js', '3', 'RIGHT');
    expect(modal.isVisible).toBe(false);
  });

  it('counts postings, not updates, as comments and extracts only the first summary line', () => {
    expect(ReviewHistoryModal.postingCounts()).toEqual({ comments: 0, edits: 0 });
    expect(ReviewHistoryModal.postingCounts(null)).toEqual({ comments: 0, edits: 0 });
    expect(ReviewHistoryModal.postingCounts([{ kind: 'update' }, {}, { kind: 'post' }])).toEqual({ comments: 2, edits: 1 });
    expect(ReviewHistoryModal.summaryLine(null)).toBe('');
    expect(ReviewHistoryModal.summaryLine('  First line\r\nSecond line')).toBe('First line');
    expect(ReviewHistoryModal.summaryLine('## Summary')).toBe('Summary');
    expect(ReviewHistoryModal.summaryLine('- **LGTM**')).toBe('LGTM');
    expect(ReviewHistoryModal.summaryLine('1. _Review_ `code`')).toBe('Review code');
    expect(ReviewHistoryModal.summaryLine('check_some_file.js')).toBe('check_some_file.js');
  });

  it('focuses rows and Back, returns to the originating row, and resets on reopen', async () => {
    const modal = new ReviewHistoryModal({ fetchImpl: async () => jsonResponse(200, { submissions }) });
    await modal.show(5);
    expect(document.activeElement.dataset.submissionIndex).toBe('0');
    modal.modal.querySelector('[data-submission-index="1"]').click();
    expect(document.activeElement.hasAttribute('data-history-back')).toBe(true);
    document.activeElement.click();
    expect(document.activeElement.dataset.submissionIndex).toBe('1');
    document.activeElement.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal.selectedIndex).toBeNull();
    expect(modal.isVisible).toBe(true);
    expect(document.activeElement.dataset.submissionIndex).toBe('1');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal.isVisible).toBe(false);
    await modal.show(5);
    expect(modal.selectedIndex).toBeNull();
    modal.modal.querySelector('[data-submission-index="0"]').click();
    modal.modal.querySelector('.modal-close-btn').click();
    expect(modal.isVisible).toBe(false);
  });

  it('does not apply stale responses or steal focus after closing', async () => {
    const toggle = document.createElement('button');
    toggle.id = 'split-button-dropdown-toggle';
    document.body.appendChild(toggle);
    toggle.focus();
    let resolve;
    const fetchImpl = vi.fn(() => new Promise(r => { resolve = r; }));
    const modal = new ReviewHistoryModal({ fetchImpl });
    const loading = modal.show(5);
    modal.hide();
    expect(document.activeElement).toBe(toggle);
    resolve(jsonResponse(200, { submissions }));
    await loading;
    expect(modal.body.querySelector('.review-history-row')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it('captures Escape before background listeners but yields to a nested confirm dialog', async () => {
    const background = vi.fn();
    document.addEventListener('keydown', background);
    const modal = new ReviewHistoryModal({ fetchImpl: async () => jsonResponse(200, { submissions }) });
    try {
      await modal.show(5);
      modal.showSubmission(0);
      window.confirmDialog = { isVisible: true };
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(modal.selectedIndex).toBe(0);
      expect(background).toHaveBeenCalledTimes(1);
      window.confirmDialog.isVisible = false;
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(modal.selectedIndex).toBeNull();
      expect(background).toHaveBeenCalledTimes(1);
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(modal.isVisible).toBe(false);
      expect(background).toHaveBeenCalledTimes(1);
    } finally {
      modal.hide();
      delete window.confirmDialog;
      document.removeEventListener('keydown', background);
    }
  });

  it('shows an empty state and server errors', async () => {
    let modal = new ReviewHistoryModal({ fetchImpl: async () => jsonResponse(200, { submissions: [] }) });
    await modal.show(5);
    expect(modal.modal.textContent).toContain('Nothing from this review has been posted to GitHub yet.');
    modal = new ReviewHistoryModal({ fetchImpl: async () => jsonResponse(400, { error: 'Review history is only available in PR mode' }) });
    await modal.show(5);
    expect(modal.modal.querySelector('.review-history-error').textContent).toBe('Review history is only available in PR mode');
  });
});

describe('split button review history entry', () => {
  it('appears in PR mode and is absent in local mode', () => {
    const onHistory = vi.fn();
    let button = new SplitButton({ onHistory });
    document.body.appendChild(button.render());
    const item = button.dropdown.querySelector('[data-action="history"]');
    expect(item.textContent).toContain('Review history');
    item.click();
    expect(onHistory).toHaveBeenCalled();
    button.destroy?.();
    window.PAIR_REVIEW_LOCAL_MODE = true;
    button = new SplitButton({ onHistory });
    button.render();
    expect(button.dropdown.querySelector('[data-action="history"]')).toBeNull();
  });
});
