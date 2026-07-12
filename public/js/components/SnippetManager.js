// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * SnippetManager — shared editor for chat prompt snippets.
 *
 * One class, two entry points:
 *   - Inline mount: `new SnippetManager(container, { onChange })` renders a
 *     list of snippets with Edit/Delete controls plus an add/edit form. Used by
 *     the global settings page's "Chat Snippets" section.
 *   - Modal: `SnippetManager.openModal({ onClose })` wraps an instance in a
 *     modal shell (reachable from the chat input's snippet-picker gear).
 *
 * All data flows through the /api/snippets endpoints. The list is re-fetched
 * after every successful mutation so it stays in MRU order, and `onChange()`
 * fires after each success so callers (e.g. an open chat dropdown) can refresh.
 *
 * Snippet bodies are untrusted text and are always rendered via textContent /
 * DOM construction — never string-interpolated into innerHTML.
 */

/* global window, document, fetch, module */

class SnippetManager {
  /**
   * @param {HTMLElement} container - Mount point; its contents are managed here.
   * @param {Object} [options]
   * @param {Function} [options.onChange] - Called after any successful mutation.
   */
  constructor(container, { onChange } = {}) {
    this.container = container;
    this.onChange = typeof onChange === 'function' ? onChange : null;

    // View state: 'list' | 'add' | 'edit'.
    this._mode = 'list';
    // Id of the snippet being edited (only meaningful in 'edit' mode).
    this._editingId = null;
    // Latest snippet list from the API.
    this._snippets = [];
    // Guards against overlapping saves/deletes.
    this._busy = false;
    // In-progress form text preserved across a failed-save re-render (null when
    // no draft is pending). See _save / _buildForm.
    this._formDraft = null;
    // Last error message to surface in the banner (null when clear).
    this._error = null;

    // Document-level listeners we attach (currently none for the inline view,
    // but tracked so destroy() can always tear them down safely).
    this._docListeners = [];

    if (this.container) {
      this._renderLoading();
      this._fetchAndRender();
    }
  }

  // ─── Data ──────────────────────────────────────────────────────────────────

  async _fetchAndRender() {
    try {
      const response = await fetch('/api/snippets');
      if (!response.ok) throw new Error(`Failed to load snippets (${response.status})`);
      const data = await response.json();
      this._snippets = Array.isArray(data.snippets) ? data.snippets : [];
      this._error = null;
    } catch (error) {
      this._snippets = [];
      this._error = error && error.message ? error.message : 'Failed to load snippets';
    }
    this._render();
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  _renderLoading() {
    if (!this.container) return;
    this.container.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'snippet-manager__loading';
    loading.textContent = 'Loading snippets…';
    this.container.appendChild(loading);
  }

  _render() {
    if (!this.container) return;
    this.container.innerHTML = '';

    const root = document.createElement('div');
    root.className = 'snippet-manager';

    if (this._error) {
      const err = document.createElement('div');
      err.className = 'snippet-manager__error';
      err.textContent = this._error;
      root.appendChild(err);
    }

    if (this._mode === 'add' || this._mode === 'edit') {
      root.appendChild(this._buildForm());
    } else {
      root.appendChild(this._buildList());
    }

    this.container.appendChild(root);
  }

  _buildList() {
    const wrap = document.createElement('div');
    wrap.className = 'snippet-manager__list-wrap';

    if (this._snippets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'snippet-manager__empty';
      empty.textContent = 'No snippets yet.';
      wrap.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'snippet-manager__list';
      for (const snippet of this._snippets) {
        list.appendChild(this._buildRow(snippet));
      }
      wrap.appendChild(list);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'snippet-manager__add-btn';
    addBtn.textContent = 'Add snippet';
    addBtn.addEventListener('click', () => this._showAddForm());
    wrap.appendChild(addBtn);

    return wrap;
  }

  /**
   * One snippet row: a DIV holding a single-line truncated preview and sibling
   * Edit/Delete buttons. Rows are DIVs (not buttons) so the action buttons are
   * never nested inside an interactive element (see public/js/CONVENTIONS.md).
   */
  _buildRow(snippet) {
    const row = document.createElement('div');
    row.className = 'snippet-manager__row';
    row.dataset.id = String(snippet.id);

    const preview = document.createElement('span');
    preview.className = 'snippet-manager__preview';
    // textContent + CSS ellipsis (white-space:nowrap) collapses any newlines to
    // a single line and escapes the body.
    preview.textContent = snippet.body || '';
    preview.title = snippet.body || '';
    row.appendChild(preview);

    const actions = document.createElement('div');
    actions.className = 'snippet-manager__row-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'snippet-manager__row-btn snippet-manager__edit-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => this._showEditForm(snippet.id));
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'snippet-manager__row-btn snippet-manager__delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => this._delete(snippet.id));
    actions.appendChild(deleteBtn);

    row.appendChild(actions);
    return row;
  }

  _buildForm() {
    const isEdit = this._mode === 'edit';
    const editing = isEdit ? this._snippets.find(s => s.id === this._editingId) : null;

    const form = document.createElement('form');
    form.className = 'snippet-manager__form';

    const label = document.createElement('label');
    label.className = 'snippet-manager__form-label';
    label.textContent = isEdit ? 'Edit snippet' : 'New snippet';
    form.appendChild(label);

    const textarea = document.createElement('textarea');
    textarea.className = 'snippet-manager__textarea';
    textarea.rows = 5;
    textarea.placeholder = 'Enter a reusable prompt snippet…';
    // Prefer a preserved draft (from a failed save) over the stored body so the
    // user's in-progress text survives an error re-render.
    textarea.value = this._formDraft != null
      ? this._formDraft
      : (editing ? (editing.body || '') : '');
    form.appendChild(textarea);
    this._formTextarea = textarea;

    const actions = document.createElement('div');
    actions.className = 'snippet-manager__form-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'snippet-manager__save-btn';
    saveBtn.textContent = 'Save';
    actions.appendChild(saveBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'snippet-manager__cancel-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this._cancelForm());
    actions.appendChild(cancelBtn);

    form.appendChild(actions);

    const syncDisabled = () => {
      saveBtn.disabled = textarea.value.trim() === '' || this._busy;
    };
    textarea.addEventListener('input', syncDisabled);
    syncDisabled();

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this._save(textarea.value);
    });

    // Focus the textarea so typing can begin immediately.
    setTimeout(() => { try { textarea.focus(); } catch (_) { /* jsdom */ } }, 0);

    return form;
  }

  // ─── View transitions ──────────────────────────────────────────────────────

  _showAddForm() {
    this._mode = 'add';
    this._editingId = null;
    this._formDraft = null; // fresh form
    this._error = null; // don't carry a stale banner across the transition
    this._render();
  }

  _showEditForm(id) {
    this._mode = 'edit';
    this._editingId = id;
    this._formDraft = null; // fresh form
    this._error = null;
    this._render();
  }

  _cancelForm() {
    this._mode = 'list';
    this._editingId = null;
    this._formDraft = null; // discard the in-progress draft
    this._error = null;
    this._render();
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  async _save(rawBody) {
    // Persist the body verbatim — leading/trailing whitespace and newlines are
    // user content (the snippet is inserted into chat unmodified later). Only
    // the empty-guard uses a trimmed copy; the backend rejects all-whitespace.
    const body = rawBody == null ? '' : String(rawBody);
    if (body.trim() === '' || this._busy) return;
    this._busy = true;

    const isEdit = this._mode === 'edit';
    const id = this._editingId;

    try {
      const response = isEdit
        ? await fetch(`/api/snippets/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body })
          })
        : await fetch('/api/snippets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body })
          });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to save snippet (${response.status})`);
      }

      this._busy = false;
      this._mode = 'list';
      this._editingId = null;
      this._formDraft = null; // committed — discard the in-progress draft
      this._error = null;
      this._notifyChanged();
      await this._fetchAndRender();
    } catch (error) {
      this._busy = false;
      // Preserve the user's in-progress text across the error re-render so a
      // failed save doesn't wipe what they typed. _buildForm prefers the draft.
      this._formDraft = body;
      this._error = error && error.message ? error.message : 'Failed to save snippet';
      this._render();
    }
  }

  /**
   * Confirm a destructive delete. Prefers the repo's styled confirmDialog
   * (available in the chat modal context, where it stacks above via a higher
   * z-index); falls back to native confirm on pages that don't load it (e.g.
   * the settings page). Returns true when the user confirms.
   */
  async _confirmDelete() {
    const message = 'Delete this snippet? This cannot be undone.';
    if (typeof window !== 'undefined' && window.confirmDialog && typeof window.confirmDialog.show === 'function') {
      const choice = await window.confirmDialog.show({
        title: 'Delete snippet',
        message,
        confirmText: 'Delete',
        confirmClass: 'btn-danger'
      });
      return choice === 'confirm';
    }
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      return window.confirm(message);
    }
    return true;
  }

  async _delete(id) {
    if (this._busy) return;
    if (!(await this._confirmDelete())) return;
    this._busy = true;

    try {
      const response = await fetch(`/api/snippets/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to delete snippet (${response.status})`);
      }
      this._busy = false;
      this._notifyChanged();
      await this._fetchAndRender();
    } catch (error) {
      this._busy = false;
      this._error = error && error.message ? error.message : 'Failed to delete snippet';
      this._render();
    }
  }

  _notifyChanged() {
    if (this.onChange) {
      try { this.onChange(); } catch (_) { /* callback errors must not break the UI */ }
    }
  }

  // ─── Teardown ──────────────────────────────────────────────────────────────

  destroy() {
    for (const { target, type, handler } of this._docListeners) {
      target.removeEventListener(type, handler);
    }
    this._docListeners = [];
    this._formTextarea = null;
    if (this.container) {
      this.container.innerHTML = '';
    }
  }

  // ─── Modal entry point ─────────────────────────────────────────────────────

  /**
   * Open the snippet manager in a modal. Mirrors the modal shell structure of
   * ReviewModal (`.modal-overlay` / `.modal-backdrop` / `.modal-container`) but
   * wires teardown with addEventListener (no inline onclick globals).
   *
   * @param {Object} [options]
   * @param {Function} [options.onClose] - Called with `(changed: boolean)` when
   *   the modal is dismissed; `changed` is true if any mutation succeeded.
   * @returns {SnippetManager} the mounted instance.
   */
  static openModal({ onClose } = {}) {
    let changed = false;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay snippet-manager-modal';

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const containerEl = document.createElement('div');
    containerEl.className = 'modal-container snippet-manager-modal__container';

    const header = document.createElement('div');
    header.className = 'modal-header snippet-manager-modal__header';

    const heading = document.createElement('h3');
    heading.textContent = 'Manage snippets';
    header.appendChild(heading);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'modal-close-btn snippet-manager-modal__close';
    closeBtn.title = 'Close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>';
    header.appendChild(closeBtn);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'modal-body snippet-manager-modal__body';

    containerEl.appendChild(header);
    containerEl.appendChild(bodyEl);
    overlay.appendChild(backdrop);
    overlay.appendChild(containerEl);
    document.body.appendChild(overlay);

    const instance = new SnippetManager(bodyEl, { onChange: () => { changed = true; } });

    let torndown = false;
    const teardown = () => {
      if (torndown) return;
      torndown = true;
      // Must pass the SAME capture flag as addEventListener or the listener leaks.
      document.removeEventListener('keydown', onKey, true);
      instance.destroy();
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (typeof onClose === 'function') onClose(changed);
    };

    // Capture phase + stopPropagation so Escape closes only this modal and does
    // not bubble to ChatPanel's own keydown handler (which would also close the
    // chat panel behind the modal).
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // A nested confirm dialog (the delete confirmation) stacks above this
      // modal and handles Escape from its own bubble-phase listener. Because we
      // run in the capture phase, we'd otherwise swallow the event and tear down
      // the whole modal, orphaning the confirm dialog. Yield to it. (Repo
      // pattern: TextInputDialog.js.)
      if (window.confirmDialog && window.confirmDialog.isVisible) return;
      e.stopPropagation();
      teardown();
    };

    backdrop.addEventListener('click', teardown);
    closeBtn.addEventListener('click', teardown);
    document.addEventListener('keydown', onKey, true);

    return instance;
  }
}

// Make SnippetManager available globally.
if (typeof window !== 'undefined') {
  window.SnippetManager = SnippetManager;
}

// Export for CommonJS testing environments.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SnippetManager };
}
