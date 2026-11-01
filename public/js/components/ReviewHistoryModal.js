// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Review History Modal
 *
 * Lists this review's submissions to the code host, newest first. Opening a
 * submission shows its full summary and the comments it carried as sent;
 * Back returns to the list. In-place edits of a posted comment appear under
 * the submission that first posted it, marked "edited".
 * Clicking a comment jumps to it in the diff. PR mode only.
 */
class ReviewHistoryModal {
  constructor({ fetchImpl } = {}) {
    this.modal = null;
    this.isVisible = false;
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this._loadGen = 0;
    this.submissions = [];
    this.selectedIndex = null;
    this.handleKeydown = this.handleKeydown.bind(this);
    this.createModal();
  }

  createModal() {
    document.getElementById('review-history-modal')?.remove();
    const container = document.createElement('div');
    container.id = 'review-history-modal';
    container.className = 'modal-overlay review-history-modal-overlay';
    container.style.display = 'none';
    container.setAttribute('role', 'dialog');
    container.setAttribute('aria-modal', 'true');
    container.setAttribute('aria-labelledby', 'review-history-title');
    container.innerHTML = `
      <div class="modal-backdrop" data-history-close></div>
      <div class="modal-container review-history-modal-container">
        <div class="modal-header">
          <button class="review-history-back" type="button" data-history-back hidden>← Back</button>
          <h3 id="review-history-title">Review history</h3>
          <button class="modal-close-btn" type="button" data-history-close title="Close" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
            </svg>
          </button>
        </div>
        <div class="modal-body review-history-body"></div>
      </div>
    `;
    container.addEventListener('click', (e) => {
      if (e.target.closest('[data-history-close]')) {
        this.hide();
        return;
      }
      if (e.target.closest('[data-history-back]')) {
        this.showList();
        return;
      }
      const row = e.target.closest('[data-submission-index]');
      if (row) {
        this.showSubmission(Number(row.dataset.submissionIndex));
        return;
      }
      const item = e.target.closest('.review-history-comment[data-jump-comment-id]');
      // Links inside a comment open the host, not the diff
      if (item && !e.target.closest('a')) this.jumpToComment(item);
    });
    container.addEventListener('keydown', (e) => {
      const item = e.target.closest?.('.review-history-comment[data-jump-comment-id]');
      if (item && (e.key === 'Enter' || e.key === ' ') && e.target === item) {
        e.preventDefault();
        this.jumpToComment(item);
      }
    });
    document.body.appendChild(container);
    this.modal = container;
    this.body = container.querySelector('.review-history-body');
  }

  handleKeydown(e) {
    if (!this.isVisible) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (this.selectedIndex !== null) this.showList();
      else this.hide();
    } else if (e.key === 'Tab') {
      const controls = [...this.modal.querySelectorAll('button:not([hidden]), a[href], [tabindex="0"]')];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }

  /**
   * Show the modal and load the review's submissions.
   * @param {number|string} reviewId
   */
  async show(reviewId) {
    if (!this.modal) this.createModal();
    if (!this.isVisible) this.opener = document.activeElement;
    this.selectedIndex = null;
    this.modal.querySelector('[data-history-back]').hidden = true;
    this.modal.querySelector('#review-history-title').textContent = 'Review history';
    this.modal.style.display = 'flex';
    this.isVisible = true;
    document.addEventListener('keydown', this.handleKeydown);
    this.modal.querySelector('.modal-close-btn').focus();
    await this.load(reviewId);
  }

  hide() {
    if (!this.modal) return;
    this.modal.style.display = 'none';
    this.isVisible = false;
    ++this._loadGen;
    document.removeEventListener('keydown', this.handleKeydown);
    this.opener?.focus();
  }

  async load(reviewId) {
    const gen = ++this._loadGen;
    this.body.innerHTML = '<div class="review-history-loading">Loading review history...</div>';
    try {
      const response = await this.fetchImpl(`/api/reviews/${reviewId}/submissions`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to load review history');
      if (gen !== this._loadGen) return;
      this.render(data.submissions || []);
    } catch (error) {
      if (gen !== this._loadGen) return;
      this.body.innerHTML = `<div class="review-history-error" role="alert">${ReviewHistoryModal.escapeHtml(error.message)}</div>`;
    }
  }

  /**
   * Render the submissions (newest first, as the server orders them).
   * @param {Array<Object>} submissions
   */
  render(submissions) {
    this.submissions = submissions;
    this.showList(0);
  }

  showList(focusIndex = this.selectedIndex ?? 0) {
    this.selectedIndex = null;
    this.modal.querySelector('[data-history-back]').hidden = true;
    this.modal.querySelector('#review-history-title').textContent = 'Review history';
    if (!this.submissions.length) {
      this.body.innerHTML = `<div class="review-history-empty">Nothing from this review has been posted to ${ReviewHistoryModal.escapeHtml(ReviewHistoryModal.hostName())} yet.</div>`;
      return;
    }
    this.body.innerHTML = `<ol class="review-history-list">${this.submissions.map((s, i) => this.renderSubmissionRow(s, i)).join('')}</ol>`;
    this.body.querySelector(`[data-submission-index="${focusIndex}"]`)?.focus();
  }

  showSubmission(index) {
    const submission = this.submissions[index];
    if (!submission) return;
    this.selectedIndex = index;
    const back = this.modal.querySelector('[data-history-back]');
    back.hidden = false;
    this.modal.querySelector('#review-history-title').textContent = 'Review submission';
    this.body.innerHTML = this.renderSubmission(submission);
    this.body.scrollTop = 0;
    back.focus();
  }

  renderSubmissionRow(submission, index) {
    const PC = window.PostedComment;
    const esc = ReviewHistoryModal.escapeHtml;
    const chip = PC.submissionEventChip(submission);
    const when = ReviewHistoryModal.formatTimestamp(PC.submissionTimestamp(submission));
    const url = PC.safeUrl(submission.github_url);
    const summary = ReviewHistoryModal.summaryLine(submission.body);
    const counts = ReviewHistoryModal.postingCounts(submission.postings);
    // The link is a sibling of the full-width row button, never nested in it.
    return `<li class="review-history-submission review-history-row" data-submission-state="${esc(submission.state || '')}">
      <button type="button" class="review-history-row-button" data-submission-index="${index}">
        <span class="review-history-submission-header">
          <span class="review-history-chip review-history-chip-${esc(chip.tone)}">${esc(chip.label)}</span>
          ${when ? `<time class="review-history-time" datetime="${esc(when.iso)}">${esc(when.text)}</time>` : ''}
        </span>
        <span class="review-history-counts">${counts.comments} ${counts.comments === 1 ? 'comment' : 'comments'} · ${counts.edits} ${counts.edits === 1 ? 'edit' : 'edits'}</span>
        ${summary ? `<span class="review-history-summary-preview">${esc(summary)}</span>` : ''}
      </button>
      ${url ? `<a class="review-history-link" href="${esc(url)}" target="_blank" rel="noopener">View on ${esc(ReviewHistoryModal.hostName())}</a>` : ''}
    </li>`;
  }

  renderSubmission(submission) {
    const PC = window.PostedComment;
    const esc = ReviewHistoryModal.escapeHtml;
    const chip = PC.submissionEventChip(submission);
    const when = ReviewHistoryModal.formatTimestamp(PC.submissionTimestamp(submission));
    const url = PC.safeUrl(submission.github_url);
    const body = submission.body
      ? `<div class="review-history-summary">${ReviewHistoryModal.renderMarkdown(submission.body)}</div>` : '';
    const postings = submission.postings || [];
    const comments = postings.length
      ? `<ul class="review-history-comments">${postings.map(p => this.renderPostedComment(p)).join('')}</ul>`
      : '<div class="review-history-no-comments">No comments</div>';
    return `<section class="review-history-submission" data-submission-state="${esc(submission.state || '')}">
      <div class="review-history-submission-header">
        <span class="review-history-chip review-history-chip-${esc(chip.tone)}">${esc(chip.label)}</span>
        ${when ? `<time class="review-history-time" datetime="${esc(when.iso)}">${esc(when.text)}</time>` : ''}
        ${url ? `<a class="review-history-link" href="${esc(url)}" target="_blank" rel="noopener">View on ${esc(ReviewHistoryModal.hostName())}</a>` : ''}
      </div>
      ${body}
      ${comments}
    </section>`;
  }

  /** Render one posted snapshot, shared by every history presentation. */
  renderPostedComment(posting) {
    const PC = window.PostedComment;
    const esc = ReviewHistoryModal.escapeHtml;
    const edited = PC.isEditPosting(posting);
    const dismissed = (posting.comment_status || posting.status) === 'inactive';
    const url = PC.safeUrl(posting.github_comment_url);
    const when = ReviewHistoryModal.formatTimestamp(posting.posted_at);
    // Dismissed comments are not rendered in the diff, so there is nothing to jump to
    const jump = !dismissed && posting.comment_id != null;
    const jumpAttrs = jump
      ? ` data-jump-comment-id="${esc(posting.comment_id)}" data-file="${esc(posting.file || '')}" data-line="${esc(posting.line_start ?? '')}" data-side="${esc(posting.side || '')}" tabindex="0" role="button" title="Show in diff"`
      : '';
    return `<li class="review-history-comment${edited ? ' review-history-comment-edited' : ''}" data-posting-kind="${esc(posting.kind || 'post')}"${jumpAttrs}>
      <div class="review-history-comment-header">
        <span class="review-history-comment-file">${esc(posting.file || '')}</span>
        <span class="review-history-comment-line">${esc(PC.postingLocation(posting))}</span>
        ${edited ? '<span class="review-history-chip review-history-chip-edited">edited</span>' : ''}
        ${posting.backfilled && !edited ? '<span class="review-history-chip" title="Legacy snapshot and review association may be approximate">approximate</span>' : ''}
        ${dismissed ? '<span class="review-history-chip review-history-chip-dismissed">dismissed</span>' : ''}
        ${when ? `<time class="review-history-time" datetime="${esc(when.iso)}">${esc(when.text)}</time>` : ''}
        ${url ? `<a class="review-history-link" href="${esc(url)}" target="_blank" rel="noopener">View</a>` : ''}
      </div>
      <div class="review-history-comment-body user-comment-body">${ReviewHistoryModal.renderMarkdown(posting.body || '')}</div>
    </li>`;
  }

  /** Close the modal and scroll to the comment, as the comment panel does. */
  jumpToComment(item) {
    const { jumpCommentId, file, line, side } = item.dataset;
    this.hide();
    window.aiPanel?.scrollToComment?.(jumpCommentId, file || undefined, line || undefined, side || undefined);
  }

  static summaryLine(body) {
    return String(body ?? '').trim().split(/\r?\n/, 1)[0];
  }

  static postingCounts(postings) {
    const counts = { comments: 0, edits: 0 };
    for (const posting of postings || []) {
      if (posting.kind === 'update') counts.edits++;
      else counts.comments++;
    }
    return counts;
  }

  static formatTimestamp(timestamp) {
    if (!timestamp) return null;
    // SQLite timestamps carry no zone but are UTC (see utils/time.js)
    const date = (typeof window !== 'undefined' && window.parseTimestamp)
      ? window.parseTimestamp(timestamp)
      : new Date(/Z$|[+-]\d{2}:\d{2}$/.test(timestamp) ? timestamp : `${timestamp.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return null;
    return { iso: date.toISOString(), text: date.toLocaleString() };
  }

  static renderMarkdown(text) {
    return window.renderMarkdown ? window.renderMarkdown(text) : ReviewHistoryModal.escapeHtml(text);
  }

  static hostName() {
    return window.PostedComment?.hostName() || 'GitHub';
  }

  static escapeHtml(value) {
    return String(value ?? '').replace(/[&"<>']/g, ch => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;', "'": '&#39;' }[ch]));
  }
}

if (typeof window !== 'undefined') window.ReviewHistoryModal = ReviewHistoryModal;
if (typeof module !== 'undefined' && module.exports) module.exports = ReviewHistoryModal;
