// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * PierreAnnotations - what pair-review draws under a line of a diff: comment
 * cards, suggestion cards, comment forms, and the cards feature modules
 * register (tour stops, hunk summaries, external threads, the file-comment
 * zone, notices).
 *
 * PierreBridge calls the builders and uses AnnotationElements, the registry
 * and element cache.
 *
 * Nothing here reads `window.prManager`. The collaborators a builder needs
 * come in as `env`: an object, or a function that returns one and is called
 * each time something is needed (at build time, and again at click time for
 * things that may not exist yet when the card is built):
 *
 *   escapeHtml(text)                     PRManager.escapeHtml
 *   PostedComment                        public/js/utils/posted-comment.js
 *   getPostedCommentIcon(comment, opts)  the posted-comment badge markup
 *   renderMarkdown(text)                 Markdown to HTML
 *   escapeHtmlAttribute(text)            attribute-safe text
 *   suggestionManager                    SuggestionManager (createSuggestionRow,
 *                                        syncSuggestionElement)
 *   chatPanel, emojiPicker               the page's chat panel and emoji picker
 *   isContextFile(path)                  whether a file of the pane is a context
 *                                        file (a comment on one says how it is posted)
 *
 * Wrapped in a function: this file is a classic script, and top-level
 * `const` names are shared by every script on the page.
 */
(function () {
  const identity = (s) => s;

  /** @private */
  function resolveEnv(env) {
    const resolved = typeof env === 'function' ? env() : env;
    return resolved || {};
  }

  // ─── Order on one line ───────────────────────────────────────────────

  // At the same line, suggestions appear before comments. This matches the
  // order of the review: the suggestion first, then
  // the comment adopted from it below it. Hunk summaries and tour stops
  // describe the surrounding code, so they stack above suggestion/comment
  // feedback anchored to the same line. External (host-synced) threads stack
  // below user comments on the same line (AI, then user, then external).
  // The file-comment zone and a notice are file-level (line 0) and come
  // first, in that order.
  const TYPE_ORDER = {
    'file-comments': -4,
    'notice': -3,
    'hunk-summary': -2,
    'tour-stop': -1,
    'suggestion': 0,
    'comment-form': 1,
    'comment': 2,
    'external-comment': 3,
  };

  /**
   * A new array with the annotations in display order: by line, then side,
   * then type. Stable, so annotations that compare equal keep the order they
   * were added in. The input is not changed.
   * @param {Array<{side: string, lineNumber: number, metadata: {type: string}}>} annotations
   * @returns {Array}
   */
  function sortAnnotations(annotations) {
    return [...(annotations || [])].sort((a, b) => {
      if (a.lineNumber !== b.lineNumber) return a.lineNumber - b.lineNumber;
      if (a.side !== b.side) return a.side < b.side ? -1 : 1;
      return (TYPE_ORDER[a.metadata.type] ?? 1) - (TYPE_ORDER[b.metadata.type] ?? 1);
    });
  }

  // ─── Comment card ────────────────────────────────────────────────────

  /**
   * Render a user comment card in the page's comment markup (the one
   * definition of a line comment's card; pr.css styles it and the page's
   * delegated handlers act on it). The element lives in the light DOM
   * (slotted).
   * @param {Object} comment
   * @param {string} id - annotation id
   * @param {Object|Function} env - collaborators (see the file header)
   * @returns {HTMLElement}
   */
  function renderComment(comment, id, env) {
    const {
      escapeHtml = identity, PostedComment, getPostedCommentIcon, renderMarkdown, escapeHtmlAttribute, isContextFile,
    } = resolveEnv(env);

    const lineInfo = comment.line_end && comment.line_end !== comment.line_start
      ? `Lines ${comment.line_start}-${comment.line_end}`
      : `Line ${comment.line_start}`;

    // A comment on a line of a file outside the diff cannot be posted to
    // GitHub on its line: it is submitted as a file-level comment. The card
    // says so, as the card of a context file always has.
    const expandedContextIndicator = typeof isContextFile === 'function' && isContextFile(comment.file)
      ? `<span class="expanded-context-indicator" title="This expanded context comment will be posted to GitHub as a file-level comment">
           <svg viewBox="0 0 16 16" width="14" height="14">
             <path fill-rule="evenodd" d="M3.75 1.5a.25.25 0 00-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0112.25 15h-8.5A1.75 1.75 0 012 13.25V1.75z"></path>
           </svg>
         </span>`
      : '';

    // Build metadata display for adopted comments (praise badge + title)
    let metadataHTML = '';
    if (comment.parent_id && comment.type && comment.type !== 'comment') {
      const badgeHTML = comment.type === 'praise'
        ? `<span class="adopted-praise-badge" title="Nice Work"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>Nice Work</span>`
        : '';
      metadataHTML = `
        ${badgeHTML}
        ${comment.title ? `<span class="adopted-title">${escapeHtml(comment.title)}</span>` : ''}
      `;
    }

    // Icon based on origin (AI-adopted vs user-originated)
    const commentIcon = comment.parent_id
      ? `<svg class="octicon octicon-comment-ai" viewBox="0 0 16 16" width="16" height="16">
           <path d="M7.75 1a.75.75 0 0 1 0 1.5h-5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2c.199 0 .39.079.53.22.141.14.22.331.22.53v2.19l2.72-2.72a.747.747 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-2a.75.75 0 0 1 1.5 0v2c0 .464-.184.909-.513 1.237A1.746 1.746 0 0 1 13.25 12H9.06l-2.573 2.573A1.457 1.457 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5C1 1.784 1.784 1 2.75 1h5Zm4.519-.837a.248.248 0 0 1 .466 0l.238.648a3.726 3.726 0 0 0 2.218 2.219l.649.238a.249.249 0 0 1 0 .467l-.649.238a3.725 3.725 0 0 0-2.218 2.218l-.238.649a.248.248 0 0 1-.466 0l-.239-.649a3.725 3.725 0 0 0-2.218-2.218l-.649-.238a.249.249 0 0 1 0-.467l.649-.238A3.726 3.726 0 0 0 12.03.811l.239-.648Z"/>
         </svg>`
      : `<svg class="octicon octicon-person" viewBox="0 0 16 16" width="16" height="16">
           <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
         </svg>`;

    const baseClasses = ['user-comment'];
    if (comment.parent_id) {
      baseClasses.push('adopted-comment', 'comment-ai-origin');
    } else {
      baseClasses.push('comment-user-origin');
    }

    const container = document.createElement('div');
    container.className = 'user-comment-row';
    container.dataset.commentId = comment.id;
    PostedComment?.stampCommentStatus(container, comment);
    container.dataset.file = comment.file;
    container.dataset.lineStart = comment.line_start;
    container.dataset.lineEnd = comment.line_end || comment.line_start;
    if (comment.side) container.dataset.side = comment.side;

    container.innerHTML = `
      <div class="${baseClasses.join(' ')}">
        <div class="user-comment-header">
          <div class="user-comment-header-left">
            <span class="comment-origin-icon">${commentIcon}</span>
            <span class="user-comment-line-info">${lineInfo}</span>
            ${getPostedCommentIcon?.(comment, { link: true }) || ''}
            ${expandedContextIndicator}
            ${metadataHTML}
          </div>
          <div class="user-comment-actions">
            <button class="btn-chat-comment" title="Chat about comment"
                    data-chat-comment-id="${comment.id}"
                    data-chat-file="${escapeHtml(comment.file || '')}"
                    data-chat-line-start="${comment.line_start ?? ''}"
                    data-chat-line-end="${comment.line_end || comment.line_start || ''}"
                    data-chat-parent-id="${comment.parent_id || ''}">
              <svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>
            </button>
            <button class="btn-edit-comment" onclick="prManager.editUserComment(${comment.id})" title="Edit comment">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"></path>
              </svg>
            </button>
            <button class="btn-delete-comment" onclick="prManager.deleteUserComment(${comment.id})" title="Dismiss comment">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19c.9 0 1.652-.681 1.741-1.576l.66-6.6a.75.75 0 00-1.492-.149l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"></path>
              </svg>
            </button>
          </div>
        </div>
        <div class="user-comment-body" data-original-markdown="${escapeHtmlAttribute ? escapeHtmlAttribute(comment.body) : ''}">${renderMarkdown ? renderMarkdown(comment.body || '') : escapeHtml(comment.body || '')}</div>
        ${PostedComment?.getEditedSincePostedHtml(comment) || ''}
      </div>
    `;

    return container;
  }

  // ─── Suggestion card ─────────────────────────────────────────────────

  /**
   * Render an AI suggestion card in the page's suggestion markup. Delegates to
   * SuggestionManager.createSuggestionRow() for zero duplication, then
   * extracts the inner .ai-suggestion div. The element lives in the light DOM
   * (slotted) so all existing CSS applies.
   * @param {Object} suggestion
   * @param {string} id - annotation id
   * @param {Object|Function} env - collaborators; `suggestionManager` is used
   * @returns {HTMLElement}
   */
  function renderSuggestion(suggestion, id, env) {
    const { suggestionManager } = resolveEnv(env);
    if (suggestionManager) {
      const targetInfo = {
        fileName: suggestion.file || '',
        lineNumber: suggestion.line_start || suggestion.line_end || '',
        side: suggestion.side || 'RIGHT',
        diffPosition: suggestion.diff_position || '',
        isFileLevel: !suggestion.line_start && !suggestion.line_end,
      };

      const row = suggestionManager.createSuggestionRow([suggestion], targetInfo);
      const suggestionDiv = row.querySelector('.ai-suggestion');
      if (suggestionDiv) {
        return suggestionDiv;
      }
    }

    // Fallback: minimal rendering if SuggestionManager unavailable
    return renderSuggestionFallback(suggestion, id, env);
  }

  /**
   * Fallback suggestion rendering when SuggestionManager is unavailable.
   * @param {Object} suggestion
   * @param {string} id - annotation id
   * @param {Object|Function} env - collaborators
   * @returns {HTMLElement}
   */
  function renderSuggestionFallback(suggestion, id, env) {
    const { escapeHtml = identity, renderMarkdown } = resolveEnv(env);
    const container = document.createElement('div');
    container.className = `ai-suggestion ai-type-${suggestion.type || 'info'}`;
    container.dataset.suggestionId = suggestion.id || '';

    const displayBody = suggestion.formattedBody || suggestion.body || '';
    const bodyHTML = renderMarkdown ? renderMarkdown(displayBody) : escapeHtml(displayBody);

    container.innerHTML = `
      <div class="ai-suggestion-header">
        <div class="ai-suggestion-header-left">
          <span class="ai-suggestion-category">${escapeHtml(suggestion.type || '')}</span>
          <span class="ai-title smart-truncate">${escapeHtml(suggestion.title || '')}</span>
        </div>
      </div>
      <div class="ai-suggestion-body">${bodyHTML}</div>
      <div class="ai-suggestion-actions">
        <button class="ai-action ai-action-adopt" onclick="prManager.adoptSuggestion(${suggestion.id})">Adopt</button>
        <button class="ai-action ai-action-dismiss" onclick="prManager.dismissSuggestion(${suggestion.id})">Dismiss</button>
      </div>
    `;
    return container;
  }

  // ─── Comment form ────────────────────────────────────────────────────

  /**
   * Suggestion toolbar icon SVG (GitHub Primer file-diff-16 octicon).
   * Matches CommentManager.SUGGESTION_ICON_SVG.
   */
  const SUGGESTION_ICON_SVG = `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M1 1.75C1 .784 1.784 0 2.75 0h7.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073ZM8 3.25a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5h-1.5v1.5a.75.75 0 0 1-1.5 0V7h-1.5a.75.75 0 0 1 0-1.5h1.5V4A.75.75 0 0 1 8 3.25Zm-3 8a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Z"></path></svg>`;

  /** Chat icon SVG for the comment form (the comment form's chat icon). */
  const CHAT_FORM_SVG = `<svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>`;

  /**
   * Render a comment form. Reuses the existing form element for `id` if
   * `formElements` holds one, to preserve what the user typed. Elements live
   * in the light DOM (slotted) and use the page's comment form classes so page
   * CSS applies.
   * @param {Object} data - { lineStart, lineEnd, side, diffPosition,
   *   headerTitle, showSuggestionBtn, initialValue, outsideDiff } (`outsideDiff`:
   *   the line is in a file outside the diff; the form warns that the comment
   *   may not be submitted to GitHub on its line)
   * @param {string} id - annotation id
   * @param {Map<string, HTMLElement>} formElements - the file's open forms
   * @param {string} fileName
   * @param {Object} handlers - read at event time: onCommentFormSubmit(file,
   *   id, data, text), onCommentFormCancel(file, id, data),
   *   onSuggestionInsert(textarea, button)
   * @param {Object|Function} env - collaborators; `chatPanel` and
   *   `emojiPicker` are used
   * @returns {HTMLElement}
   */
  function renderForm(data, id, formElements, fileName, handlers, env) {
    handlers = handlers || {};
    // Reuse existing form element to preserve textarea content
    if (formElements.has(id)) {
      return formElements.get(id);
    }

    const container = document.createElement('div');
    container.className = 'pierre-annotation user-comment-form';
    container.dataset.annotationId = id;

    // Header
    const header = document.createElement('div');
    header.className = 'comment-form-header';
    const icon = document.createElement('span');
    icon.className = 'comment-icon';
    icon.textContent = '\uD83D\uDCAC'; // 💬
    header.appendChild(icon);
    const title = document.createElement('span');
    title.className = 'comment-title';
    title.textContent = data.headerTitle || 'Add comment';
    header.appendChild(title);
    if (data.lineStart && data.lineEnd && data.lineEnd !== data.lineStart) {
      const rangeLabel = document.createElement('span');
      rangeLabel.className = 'line-range-indicator';
      rangeLabel.textContent = `Lines ${data.lineStart}-${data.lineEnd}`;
      header.appendChild(rangeLabel);
    }
    container.appendChild(header);

    // A line outside the diff (a context file's line): the form says what
    // happens to the comment on submission, as the form of such a line
    // always has.
    if (data.outsideDiff) {
      const warning = document.createElement('div');
      warning.className = 'expanded-context-warning';
      warning.textContent = 'Warning: Expanded context line - may not submit to GitHub';
      container.appendChild(warning);
    }

    // Suggestion toolbar — suggestionBtn is declared in the outer scope so
    // the textarea input listener below can re-evaluate its disabled state.
    let suggestionBtn = null;
    if (data.showSuggestionBtn) {
      const toolbar = document.createElement('div');
      toolbar.className = 'comment-form-toolbar';
      suggestionBtn = document.createElement('button');
      suggestionBtn.type = 'button';
      suggestionBtn.className = 'btn btn-sm suggestion-btn';
      suggestionBtn.title = 'Insert a suggestion';
      suggestionBtn.innerHTML = SUGGESTION_ICON_SVG;
      suggestionBtn.addEventListener('click', () => {
        if (!suggestionBtn.disabled && handlers.onSuggestionInsert) {
          handlers.onSuggestionInsert(textarea, suggestionBtn);
        }
      });
      toolbar.appendChild(suggestionBtn);
      container.appendChild(toolbar);
    }

    // Textarea
    const textarea = document.createElement('textarea');
    textarea.className = 'comment-textarea';
    textarea.placeholder = 'Leave a comment... (Cmd/Ctrl+Enter to save)';
    textarea.dataset.line = data.lineStart || '';
    textarea.dataset.lineEnd = data.lineEnd || data.lineStart || '';
    textarea.dataset.file = fileName;
    textarea.dataset.diffPosition = data.diffPosition || '';
    textarea.dataset.side = data.side || 'RIGHT';
    if (data.initialValue) {
      textarea.value = data.initialValue;
    }
    container.appendChild(textarea);

    // Actions, in this order: Save, Chat, Cancel
    const actions = document.createElement('div');
    actions.className = 'comment-form-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-sm btn-primary save-comment-btn';
    saveBtn.textContent = 'Save';
    // Sync disabled state with initial textarea content — when `initialValue`
    // is set programmatically above, the `input` event does not fire, so we
    // must compute this here rather than relying on the listener.
    saveBtn.disabled = !textarea.value.trim();
    // Guard against duplicate submits from rapid clicks or repeated
    // Cmd+Enter. Parity with CommentManager.saveComment which notes:
    // "Prevent duplicate saves from rapid clicks or Cmd+Enter".
    saveBtn.addEventListener('click', async () => {
      if (saveBtn.dataset.saving === 'true') return;
      if (!handlers.onCommentFormSubmit) return;
      saveBtn.dataset.saving = 'true';
      saveBtn.disabled = true;
      try {
        await handlers.onCommentFormSubmit(fileName, id, data, textarea.value);
      } finally {
        // Reset whether or not the button is in the document. A form whose
        // file the viewer has unmounted (the reader scrolled it away) is
        // kept by the bridge and comes back when the file is mounted again,
        // so a failed save must leave it usable. After a successful save
        // the form has been removed and nothing reads the button again.
        saveBtn.dataset.saving = 'false';
        saveBtn.disabled = !textarea.value.trim();
      }
    });
    actions.appendChild(saveBtn);

    const chatBtn = document.createElement('button');
    chatBtn.className = 'ai-action ai-action-chat btn-chat-from-comment';
    chatBtn.title = 'Chat about these lines';
    chatBtn.innerHTML = CHAT_FORM_SVG + ' Chat';
    chatBtn.addEventListener('click', () => {
      const chatPanel = resolveEnv(env).chatPanel;
      if (!chatPanel) return;
      if (handlers.onCommentFormCancel) {
        handlers.onCommentFormCancel(fileName, id, data);
      }
      chatPanel.open({
        commentContext: {
          type: 'line',
          body: textarea.value.trim() || null,
          file: fileName || '',
          line_start: parseInt(textarea.dataset.line) || null,
          line_end: parseInt(textarea.dataset.lineEnd) || parseInt(textarea.dataset.line) || null,
          side: textarea.dataset.side || 'RIGHT',
          source: 'user'
        }
      });
    });
    actions.appendChild(chatBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-sm btn-secondary cancel-comment-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      if (handlers.onCommentFormCancel) {
        handlers.onCommentFormCancel(fileName, id, data);
      }
    });
    actions.appendChild(cancelBtn);

    container.appendChild(actions);

    // Enable/disable save button and re-evaluate suggestion button on input.
    // Mirrors CommentManager.updateSuggestionButtonState so that manually
    // deleting a ```suggestion block re-enables the toolbar button.
    const hasSuggestionBlock = (text) => /^\s*(`{3,})suggestion\s*$/m.test(text);
    textarea.addEventListener('input', () => {
      saveBtn.disabled = !textarea.value.trim();
      if (suggestionBtn) {
        const hasSuggestion = hasSuggestionBlock(textarea.value);
        suggestionBtn.disabled = hasSuggestion;
        suggestionBtn.title = hasSuggestion
          ? 'Only one suggestion per comment'
          : 'Insert a suggestion';
      }
      // Auto-resize
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    });

    // Keyboard shortcuts (Cmd/Ctrl+Enter, Escape) are handled by the
    // delegated listener in PRManager.setupCommentFormDelegation() which
    // matches .comment-textarea — no inline handler needed here.

    // Cache form element for reuse
    formElements.set(id, container);

    // Focus textarea and attach emoji picker after it's in the DOM.
    // Emoji autocomplete (typing `:`) works in these forms as in every
    // other comment field of the page.
    requestAnimationFrame(() => {
      textarea.focus();
      const emojiPicker = resolveEnv(env).emojiPicker;
      if (emojiPicker) emojiPicker.attach(textarea);
      // Initial auto-resize for pre-filled content (input event doesn't
      // fire for programmatic .value assignment).
      if (data.initialValue) {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
        // Sync suggestion button disabled state with pre-filled content —
        // the input event listener doesn't fire for programmatic .value.
        if (suggestionBtn) {
          const has = hasSuggestionBlock(textarea.value);
          suggestionBtn.disabled = has;
          if (has) suggestionBtn.title = 'Only one suggestion per comment';
        }
      }
    });

    return container;
  }

  // ─── Split layout: full-width cards ──────────────────────────────────

  /**
   * Split view: stretch annotation cards across both columns.
   *
   * The vendor renders each annotation into ONE side's column plus an empty
   * paired cell in the other column on the same shared grid row (split+wrap
   * is a single four-track grid with display:contents columns), so a lone
   * card only gets half the width. This pass:
   *   1. Measures the middle (additions) gutter track — it is min-content
   *      sized, so pure CSS cannot know its width — and publishes it on the
   *      <pre> as --pr-split-gutter-width for ANNOTATION_CSS calc()s.
   *   2. Marks cards whose opposite cell is empty with
   *      .pr-annotation-fullwidth. When BOTH sides of a row hold cards
   *      (LEFT + RIGHT annotation on the same row pair), neither is marked
   *      and they stay half-width side by side.
   *
   * Entirely added/removed files get the same treatment: the vendor emits a
   * lone code column stamped data-diff-type="single", which ANNOTATION_CSS
   * boxes into one half of the split grid. Its own gutter is the measured
   * track there, and every slotted card is lone by construction, so the same
   * marking pass stretches them across both halves.
   *
   * Vendor renders wipe shadow-DOM classes and inline vars, so a bridge calls
   * this after every pass that can rebuild the shadow DOM. In unified mode it
   * does nothing (every pre is "single" there too — one unified column — so
   * the bridge's own diffStyle is the gate, not the attribute).
   *
   * @param {ShadowRoot|null} shadowRoot - the shadow root of one file's host
   * @param {'unified'|'split'} diffStyle - the bridge's current layout
   */
  function applySplitAnnotationLayout(shadowRoot, diffStyle) {
    if (diffStyle !== 'split' || !shadowRoot) return;
    const pre = shadowRoot.querySelector(
      'pre[data-diff-type="split"], pre[data-diff-type="single"]'
    );
    if (!pre) return;

    // Two-sided pre: measure the MIDDLE (additions) gutter track — it sits
    // against the seam. One-sided pre: only one gutter exists; measure it.
    const gutter = pre.getAttribute('data-diff-type') === 'split'
      ? pre.querySelector('[data-additions] [data-gutter]')
      : pre.querySelector('[data-gutter]');
    const gutterWidth = gutter?.getBoundingClientRect?.().width || 0;
    if (gutterWidth > 0) {
      pre.style.setProperty('--pr-split-gutter-width', `${gutterWidth}px`);
    }

    // Paired cells share the same "hunkIndex,lineIndex" attribute value.
    const byRow = new Map();
    for (const cell of pre.querySelectorAll('[data-line-annotation]')) {
      const key = cell.getAttribute('data-line-annotation');
      if (!byRow.has(key)) byRow.set(key, []);
      byRow.get(key).push(cell);
    }
    for (const cells of byRow.values()) {
      const withContent = cells.filter((cell) => cell.querySelector('slot'));
      for (const cell of cells) {
        cell.classList.toggle(
          'pr-annotation-fullwidth',
          withContent.length === 1 && cell === withContent[0]
        );
      }
    }
  }

  // ─── Registry and element cache (CodeView bridge) ────────────────────

  /**
   * Builds, caches and syncs the element of every annotation.
   *
   * The viewer asks for an annotation's element again on every remount of
   * its file and on every change of the file's diff, not only when the
   * annotation changed. A card is therefore built ONCE per annotation and
   * handed back from the cache afterwards: callers hold on to cards (a
   * scroll-to-finding in flight), and cards keep state in their DOM (an open
   * edit form, a suggestion the reader chose to show again).
   *
   * Two rules, which the flows that mutate cards rely on:
   *
   *  - draw(annotation, ...) is what the viewer's render callback calls. It
   *    builds the card if there is none and then SYNCS it: brings what can
   *    change in the data while the card was not on screen in line with the
   *    data (posted status and visibility, the edited-since-posted note, an
   *    update in flight, a suggestion's status; a registered `sync` for
   *    other types). Every sync is idempotent.
   *  - lookup(annotation, { create }) never changes a card that exists. With
   *    `create` it builds a card that does not exist yet (through draw, so it
   *    is synced once, as a new card must be) and the viewer later receives
   *    that same element. The adopt, dismiss, restore, delete and edit flows
   *    look a card up, update it themselves, and sometimes leave it
   *    deliberately different from what the data alone says.
   */
  class AnnotationElements {
    /**
     * @param {Object} options
     * @param {Object|Function} options.env - collaborators (file header)
     * @param {Object} options.handlers - comment form handlers, read at event time
     */
    constructor({ env, handlers } = {}) {
      this.env = env;
      this.handlers = handlers || {};
      // Built elements, keyed by the annotation's metadata object. An
      // annotation's metadata object is replaced whenever it is re-added, so
      // the same metadata at the same line and side means the same card.
      this._elements = new WeakMap();
      this._renderers = new Map();
      this._syncers = new Map();
    }

    /**
     * Register a renderer for an annotation type other than comment,
     * suggestion and comment-form.
     * @param {string} type
     * @param {Function} renderFn - (data, id, fileName) => Element|null
     * @param {Object} [options]
     * @param {Function} [options.sync] - (element, data, id, fileName) => void,
     *   run on every draw; must be idempotent
     */
    register(type, renderFn, { sync } = {}) {
      this._renderers.set(type, renderFn);
      if (typeof sync === 'function') this._syncers.set(type, sync);
      else this._syncers.delete(type);
    }

    /**
     * The element for an annotation as the viewer draws it: built if needed,
     * then synced.
     * @param {Object} annotation - { side, lineNumber, metadata: { type, data, id } }
     * @param {string} fileName
     * @param {Map<string, HTMLElement>} formElements - the file's open forms
     * @returns {HTMLElement|undefined}
     */
    draw(annotation, fileName, formElements) {
      const { metadata, lineNumber, side } = annotation;
      // Forms are cached per file by id (formElements) and have nothing to sync.
      if (metadata.type === 'comment-form') {
        return renderForm(metadata.data, metadata.id, formElements, fileName, this.handlers, this.env);
      }
      const cached = this._elements.get(metadata);
      if (cached && cached.lineNumber === lineNumber && cached.side === side) {
        this._sync(annotation, cached.element, fileName);
        return cached.element;
      }
      const element = this._build(annotation, fileName);
      if (element) {
        this._elements.set(metadata, { element, lineNumber, side });
        this._sync(annotation, element, fileName);
      }
      return element;
    }

    /**
     * The element of an annotation without drawing it. A card that exists is
     * handed back exactly as it is.
     * @param {Object} annotation
     * @param {string} fileName
     * @param {Map<string, HTMLElement>} formElements
     * @param {Object} [options]
     * @param {boolean} [options.create=false] - build the element if there is none
     * @returns {HTMLElement|null}
     */
    lookup(annotation, fileName, formElements, { create = false } = {}) {
      const { metadata, lineNumber, side } = annotation;
      if (metadata.type === 'comment-form') {
        const form = formElements?.get(metadata.id);
        if (form || !create) return form || null;
      } else {
        const cached = this._elements.get(metadata);
        if (cached && cached.lineNumber === lineNumber && cached.side === side) {
          return cached.element || null;
        }
        if (!create) return null;
      }
      return this.draw(annotation, fileName, formElements) || null;
    }

    /** @private */
    _build(annotation, fileName) {
      const { type, data, id } = annotation.metadata;
      if (type === 'comment') return renderComment(data, id, this.env);
      if (type === 'suggestion') return renderSuggestion(data, id, this.env);
      const renderer = this._renderers.get(type);
      if (!renderer) return undefined;
      try {
        return renderer(data, id, fileName) || undefined;
      } catch (err) {
        console.error(`[PierreAnnotations] renderer for "${type}" failed:`, err);
        return undefined;
      }
    }

    /** @private */
    _sync(annotation, element, fileName) {
      if (!element) return;
      const { type, data, id } = annotation.metadata;
      try {
        if (type === 'comment') {
          resolveEnv(this.env).PostedComment?.syncCommentElement?.(element, data);
        } else if (type === 'suggestion') {
          resolveEnv(this.env).suggestionManager?.syncSuggestionElement?.(element, data);
        } else {
          this._syncers.get(type)?.(element, data, id, fileName);
        }
      } catch (err) {
        console.error(`[PierreAnnotations] sync of "${type}" annotation failed:`, err);
      }
    }
  }

  const PierreAnnotations = {
    TYPE_ORDER,
    sortAnnotations,
    renderComment,
    renderSuggestion,
    renderSuggestionFallback,
    renderForm,
    applySplitAnnotationLayout,
    AnnotationElements,
    SUGGESTION_ICON_SVG,
    CHAT_FORM_SVG,
  };

  if (typeof window !== 'undefined') window.PierreAnnotations = PierreAnnotations;
  if (typeof module !== 'undefined') module.exports = PierreAnnotations;
})();
