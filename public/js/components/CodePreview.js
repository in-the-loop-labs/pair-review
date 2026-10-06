// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/** Temporary read-only code view. The original diff DOM stays mounted. */
class CodePreview {
  constructor(manager) {
    this.manager = manager;
    this.generation = 0;
    this.panel = null;
    this._onKeydown = event => {
      if (event.key !== 'Escape' || !this.panel?.contains(event.target) || window.confirmDialog?.isVisible) return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    };
  }

  async open(file, lineStart = null, lineEnd = null, trigger = null) {
    const diff = document.getElementById('diff-container');
    const reviewId = this.manager.currentPR?.id;
    if (!diff || !reviewId) return;
    if (!this.panel) {
      this.diff = diff;
      this.scrollContainer = diff.closest('.diff-view') || diff.parentElement;
      this.savedScrollTop = this.scrollContainer.scrollTop;
      this.savedScrollLeft = this.scrollContainer.scrollLeft;
      this.trigger = trigger;
      this.panel = document.createElement('section');
      this.panel.className = 'code-preview';
      this.panel.setAttribute('aria-label', 'Code preview');
      this.panel.innerHTML = `
        <div class="code-preview__toolbar">
          <button type="button" class="btn btn-sm btn-secondary" data-preview-back>← Back to review</button>
          <span class="code-preview__badge">Outside changes · Read only</span>
          <button type="button" class="btn btn-sm btn-secondary" data-preview-keep disabled>Keep in review</button>
        </div>
        <div class="code-preview__header"><strong data-preview-file></strong><span data-preview-source></span></div>
        <div class="code-preview__status" role="status" aria-live="polite"></div>
        <div class="code-preview__actions"></div>
        <div class="code-preview__code"></div>`;
      diff.after(this.panel);
      this.scrollContainer.classList.add('code-preview-open');
      this.scrollContainer.scrollTop = 0;
      this.panel.querySelector('[data-preview-back]').addEventListener('click', () => this.close());
      this.panel.querySelector('[data-preview-keep]').addEventListener('click', () => this.keep());
      // Capture Escape before ChatPanel's document handler can close chat.
      document.addEventListener('keydown', this._onKeydown, true);
      this.panel.querySelector('[data-preview-back]').focus({ preventScroll: true });
    }
    const generation = ++this.generation;
    this.reviewId = reviewId;
    this.file = file;
    this.lineStart = Number.isSafeInteger(lineStart) && lineStart > 0 ? lineStart : null;
    this.lineEnd = Number.isSafeInteger(lineEnd) && lineEnd >= this.lineStart ? lineEnd : this.lineStart;
    this.data = null;
    this._showStatus('Loading file…');
    this.panel.querySelector('[data-preview-file]').textContent = file;
    this.panel.querySelector('[data-preview-source]').textContent = '';
    this.panel.querySelector('.code-preview__code').replaceChildren();
    this.panel.querySelector('.code-preview__actions').replaceChildren();
    this.panel.querySelector('[data-preview-keep]').disabled = true;
    this.panel.querySelector('[data-preview-keep]').textContent = 'Keep in review';
    try {
      const response = await fetch(`/api/reviews/${reviewId}/code-preview/${encodeURIComponent(file)}`);
      const data = await response.json();
      if (!this._isCurrent(generation, reviewId)) return;
      if (!response.ok) throw new Error(data.error || 'Could not load this file.');
      this.data = data;
      this.file = data.fileName;
      if (this.manager.diffFiles?.some(entry => entry.file === data.fileName)) {
        // The API can resolve an absolute or ./ alias to a changed file.
        // Send it to the existing diff instead of offering to keep it.
        await this._returnToDiff(data.fileName, this.lineStart, this.lineEnd);
        return;
      }
      this.panel.querySelector('[data-preview-file]').textContent = data.fileName;
      this.panel.querySelector('[data-preview-source]').textContent =
        `${data.source}${data.revision ? ' · ' + data.revision.slice(0, 8) : ''}`;
      this.panel.querySelector('[data-preview-keep]').disabled = this.lineStart > data.totalLines;
      const start = Math.min(this.lineStart || 1, data.totalLines);
      const end = Math.min(this.lineEnd || start, data.totalLines);
      this.visibleStart = Math.max(1, start - 10);
      this.visibleEnd = Math.min(data.totalLines, Math.max(end + 10, this.visibleStart + 39));
      // A very large cited range remains expandable without mounting thousands of rows.
      this.visibleEnd = Math.min(this.visibleEnd, this.visibleStart + 499);
      this._renderLines();
      this._showStatus(this.lineStart > data.totalLines ? `Line ${this.lineStart} is outside this file (${data.totalLines} lines).` : '');
    } catch (error) {
      if (!this._isCurrent(generation, reviewId)) return;
      this._showStatus(error.message);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-sm btn-secondary';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => this.open(file, lineStart, lineEnd));
      this.panel.querySelector('.code-preview__actions').appendChild(retry);
    }
  }

  _isCurrent(generation, reviewId) {
    return this.panel && this.generation === generation && this.manager.currentPR?.id === reviewId;
  }

  _showStatus(message) {
    this.panel.querySelector('.code-preview__status').textContent = message;
  }

  async _returnToDiff(file, lineStart, lineEnd) {
    const reviewId = this.reviewId;
    this.close();
    const generation = this.generation;
    await this.manager.scrollToFile?.(file);
    if (this.panel || this.generation !== generation || this.manager.currentPR?.id !== reviewId) return;
    if (lineStart) await window.chatPanel?._scrollToLine?.(file, lineStart, lineEnd);
  }

  _renderLines() {
    const code = this.panel.querySelector('.code-preview__code');
    code.replaceChildren();
    const addExpand = (label, expand) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm btn-secondary code-preview__expand';
      button.textContent = label;
      button.addEventListener('click', () => { expand(); this._renderLines(); });
      code.appendChild(button);
    };
    if (this.visibleStart > 1) addExpand('Show earlier lines', () => { this.visibleStart = Math.max(1, this.visibleStart - 50); });
    const table = document.createElement('table');
    table.className = 'code-preview__table';
    table.setAttribute('aria-label', this.file);
    const tbody = document.createElement('tbody');
    for (let line = this.visibleStart; line <= this.visibleEnd; line++) {
      const row = document.createElement('tr');
      row.dataset.previewLine = line;
      if (this.lineStart && line >= this.lineStart && line <= this.lineEnd) row.className = 'code-preview__highlight';
      const number = document.createElement('td');
      number.className = 'code-preview__line-number';
      number.textContent = line;
      const content = document.createElement('td');
      const text = document.createElement('code');
      text.textContent = this.data.lines[line - 1];
      content.appendChild(text);
      row.append(number, content);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    code.appendChild(table);
    if (this.visibleEnd < this.data.totalLines) addExpand('Show later lines', () => { this.visibleEnd = Math.min(this.data.totalLines, this.visibleEnd + 50); });
  }

  async keep() {
    if (!this.data || this.lineStart > this.data.totalLines || this.keepingGeneration === this.generation) return;
    const generation = this.generation;
    const reviewId = this.reviewId;
    const button = this.panel.querySelector('[data-preview-keep]');
    this.keepingGeneration = generation;
    button.disabled = true;
    const start = Math.min(this.lineStart || this.visibleStart, this.data.totalLines);
    const end = Math.min(this.lineEnd || this.visibleEnd, start + 499, this.data.totalLines);
    try {
      const result = await this.manager.ensureContextFile(this.file, start, end);
      if (!this._isCurrent(generation, reviewId)) return;
      if (!result) throw new Error('Could not keep this file in the review.');
      if (result.type === 'diff') {
        await this._returnToDiff(this.file, this.lineStart, this.lineEnd);
        return;
      }
      button.textContent = 'Kept in review';
      this._showStatus('Context file saved.');
    } catch (error) {
      if (!this._isCurrent(generation, reviewId)) return;
      button.disabled = false;
      this._showStatus(error.message);
    } finally {
      if (this.keepingGeneration === generation) this.keepingGeneration = null;
    }
  }

  close() {
    if (!this.panel) return;
    ++this.generation;
    this.panel.remove();
    this.panel = null;
    this.data = null;
    this.scrollContainer.classList.remove('code-preview-open');
    this.scrollContainer.scrollTop = this.savedScrollTop;
    this.scrollContainer.scrollLeft = this.savedScrollLeft;
    document.removeEventListener('keydown', this._onKeydown, true);
    if (this.trigger?.isConnected) this.trigger.focus({ preventScroll: true });
    this.trigger = null;
  }
}

if (typeof window !== 'undefined') window.CodePreview = CodePreview;
if (typeof module !== 'undefined') module.exports = CodePreview;
