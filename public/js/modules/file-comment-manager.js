// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * FileCommentManager - File-level comment UI handling
 * Handles file-level comments zone rendering, forms, and interactions.
 */

class FileCommentManager {
  constructor(prManagerRef) {
    // Reference to parent PRManager for API calls and state access
    this.prManager = prManagerRef;
    // Track file-level comments by file path
    this.fileComments = new Map();

    // Event delegation for "Ask about this" chat button on file-level suggestions
    document.addEventListener('click', (e) => {
      const chatBtn = e.target.closest('.file-comments-zone .ai-action-chat');
      if (chatBtn && window.chatPanel) {
        e.stopPropagation();
        const suggestionCard = chatBtn.closest('.ai-suggestion');
        const bodyText = suggestionCard?.dataset?.originalBody
          ? JSON.parse(suggestionCard.dataset.originalBody) : '';
        window.chatPanel.open({
          reviewId: this.prManager?.currentPR?.id,
          suggestionId: chatBtn.dataset.suggestionId,
          suggestionContext: {
            title: chatBtn.dataset.title || '',
            body: bodyText,
            type: suggestionCard?.querySelector('.ai-suggestion-badge')?.dataset?.type || '',
            file: chatBtn.dataset.file || '',
            line_start: null,
            line_end: null,
            side: suggestionCard?.dataset?.side || 'RIGHT',
            reasoning: null
          }
        });
      }
    });

    // Event delegation for "Ask about this" chat button on file-level user comments
    document.addEventListener('click', (e) => {
      const chatBtn = e.target.closest('.file-comments-zone .btn-chat-comment');
      if (chatBtn && window.chatPanel) {
        e.stopPropagation();
        const commentCard = chatBtn.closest('.file-comment-card');
        const bodyEl = commentCard?.querySelector('.user-comment-body');
        const originalMarkdown = bodyEl?.dataset?.originalMarkdown || bodyEl?.textContent || '';
        window.chatPanel.open({
          reviewId: this.prManager?.currentPR?.id,
          commentContext: {
            commentId: chatBtn.dataset.chatCommentId,
            body: originalMarkdown,
            file: chatBtn.dataset.chatFile || '',
            line_start: null,
            line_end: null,
            parentId: chatBtn.dataset.chatParentId || null,
            source: 'user',
            isFileLevel: true
          }
        });
      }
    });
  }

  /**
   * Get emoji for suggestion category
   * @param {string} category - Category name
   * @returns {string} Emoji character
   */
  getCategoryEmoji(category) {
    return window.CategoryEmoji?.getEmoji(category) || '\u{1F4AC}';
  }

  /**
   * Format adopted comment text with emoji and category prefix
   * @param {string} text - Comment text
   * @param {string} category - Category name
   * @returns {string} Formatted text
   */
  formatAdoptedComment(text, category) {
    if (!category) {
      return text;
    }
    const emoji = this.getCategoryEmoji(category);
    // Properly capitalize hyphenated categories (e.g., "code-style" -> "Code Style")
    const capitalizedCategory = category
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    return `${emoji} **${capitalizedCategory}**: ${text}`;
  }

  /**
   * Get the appropriate API endpoint and request body for file-level comments
   * @private
   * @param {string} operation - Operation type: 'create', 'update', 'delete'
   * @param {Object} options - Options object with commentId, file, body, etc.
   * @returns {Object} Object with endpoint and requestBody
   */
  _getFileCommentEndpoint(operation, options = {}) {
    const reviewId = this.prManager?.currentPR?.id;
    const headSha = this.prManager?.currentPR?.head_sha;

    let endpoint;
    let requestBody = null;

    switch (operation) {
      case 'create':
        endpoint = `/api/reviews/${reviewId}/comments`;

        requestBody = {
          file: options.file,
          body: options.body,
          commit_sha: headSha,
          parent_id: options.parent_id,
          type: options.type,
          title: options.title
        };
        break;

      case 'update':
        endpoint = `/api/reviews/${reviewId}/comments/${options.commentId}`;

        requestBody = { body: options.body };
        break;

      case 'delete':
        endpoint = `/api/reviews/${reviewId}/comments/${options.commentId}`;

        // No body needed for DELETE
        break;

      default:
        throw new Error(`Unknown operation: ${operation}`);
    }

    return { endpoint, requestBody };
  }

  /**
   * Create the file comments zone element for a file
   * File comments are always visible (no collapsible behavior).
   * The comment icon button in the file header directly adds a new comment.
   * @param {string} fileName - The file path
   * @returns {HTMLElement} The file comments zone element
   */
  createFileCommentsZone(fileName) {
    const zone = document.createElement('div');
    zone.className = 'file-comments-zone';
    zone.dataset.fileName = fileName;

    // Comments container (no header with toggle/add buttons - always visible)
    const container = document.createElement('div');
    container.className = 'file-comments-container';

    zone.appendChild(container);

    return zone;
  }


  /**
   * Show the comment form for a file
   * @param {HTMLElement} zone - The file comments zone
   * @param {string} fileName - The file path
   */
  showCommentForm(zone, fileName) {
    const container = zone.querySelector('.file-comments-container');

    // Close any existing form in this zone
    const existingForm = container.querySelector('.file-comment-form');
    if (existingForm) {
      existingForm.remove();
    }

    // Create form
    const form = document.createElement('div');
    form.className = 'file-comment-form';
    form.innerHTML = `
      <div class="file-comment-form-header">
        ${window.Icons.icon('comment', 14, 14)}
        <label>Add file-level comment</label>
      </div>
      <textarea
        class="file-comment-textarea"
        placeholder="Write a comment about this file... (Ctrl+Enter to save)"
        data-file="${window.escapeHtmlAttribute(fileName)}"
      ></textarea>
      <div class="file-comment-form-footer">
        <button class="file-comment-form-btn submit submit-btn" disabled>Save</button>
        <button class="ai-action ai-action-chat btn-chat-from-comment" title="Chat about this file">
          ${window.Icons.icon('discussion')}
          Chat
        </button>
        <button class="file-comment-form-btn cancel cancel-btn">Cancel</button>
      </div>
    `;

    container.appendChild(form);

    // Get elements
    const textarea = form.querySelector('.file-comment-textarea');
    const submitBtn = form.querySelector('.submit-btn');
    const cancelBtn = form.querySelector('.cancel-btn');

    // Focus textarea
    textarea.focus();

    // Attach emoji picker for autocomplete
    if (window.emojiPicker) {
      window.emojiPicker.attach(textarea);
    }

    // Focus/blur for styling
    textarea.addEventListener('focus', () => form.classList.add('focused'));
    textarea.addEventListener('blur', () => form.classList.remove('focused'));

    // Enable/disable submit based on content
    textarea.addEventListener('input', () => {
      submitBtn.disabled = !textarea.value.trim();
    });

    // Keyboard shortcuts
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideCommentForm(zone);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && textarea.value.trim()) {
        this.saveFileComment(zone, fileName, textarea.value.trim());
      }
    });

    // Cancel button
    cancelBtn.addEventListener('click', () => this.hideCommentForm(zone));

    // Submit button
    submitBtn.addEventListener('click', () => {
      if (textarea.value.trim()) {
        this.saveFileComment(zone, fileName, textarea.value.trim());
      }
    });

    // Chat button handler - opens chat panel with file-level context
    const chatFromCommentBtn = form.querySelector('.btn-chat-from-comment');
    if (chatFromCommentBtn) {
      chatFromCommentBtn.addEventListener('click', () => {
        if (!window.chatPanel) return;
        const unsavedText = textarea.value.trim();
        this.hideCommentForm(zone);
        window.chatPanel.open({
          commentContext: {
            type: 'line',
            body: unsavedText || null,
            file: fileName || '',
            line_start: null,
            line_end: null,
            source: 'user',
            isFileLevel: true
          }
        });
      });
    }

  }

  /**
   * Hide the comment form
   * @param {HTMLElement} zone - The file comments zone
   */
  hideCommentForm(zone) {
    const container = zone.querySelector('.file-comments-container');
    const form = container.querySelector('.file-comment-form');

    if (form) {
      form.remove();
    }
  }

  /**
   * Save a file-level comment
   * @param {HTMLElement} zone - The file comments zone
   * @param {string} fileName - The file path
   * @param {string} body - The comment body
   */
  async saveFileComment(zone, fileName, body) {
    // Prevent duplicate saves from rapid clicks or Cmd+Enter
    const container = zone.querySelector('.file-comments-container');
    const submitBtn = container?.querySelector('.file-comment-form .submit-btn');
    if (submitBtn?.dataset.saving === 'true') {
      return;
    }
    if (submitBtn) submitBtn.dataset.saving = 'true';
    if (submitBtn) submitBtn.disabled = true;

    try {
      const { endpoint, requestBody } = this._getFileCommentEndpoint('create', {
        file: fileName,
        body: body
      });

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        throw new Error('Failed to save file-level comment');
      }

      const result = await response.json();

      // Build comment object
      const commentData = {
        id: result.commentId,
        file: fileName,
        body: body,
        source: 'user',
        is_file_level: 1,
        created_at: new Date().toISOString()
      };

      // Display the new comment
      this.displayUserComment(zone, commentData);

      // Hide the form
      this.hideCommentForm(zone);

      // Update count badge
      this.updateCommentCount(zone);

      // Notify AI Panel if available
      if (window.aiPanel?.addComment) {
        window.aiPanel.addComment(commentData);
      }

      // Update parent comment count
      if (this.prManager?.updateCommentCount) {
        this.prManager.updateCommentCount();
      }

    } catch (error) {
      console.error('Error saving file-level comment:', error);
      if (window.toast) {
        window.toast.showError('Failed to save file-level comment');
      }
      // Re-enable save button on failure so the user can retry
      if (submitBtn) {
        submitBtn.dataset.saving = 'false';
        submitBtn.disabled = false;
      }
    }
  }

  /**
   * Display a user file-level comment
   * Note: Dismissed comments are never rendered in the diff view per design decision.
   * They only appear in the AI/Review Panel. This method only receives active comments.
   * @param {HTMLElement} zone - The file comments zone
   * @param {Object} comment - The comment data
   */
  displayUserComment(zone, comment) {
    const container = zone.querySelector('.file-comments-container');

    const card = document.createElement('div');
    // Match line-level: add adopted-comment and comment-ai-origin classes when AI-originated
    const isAIOrigin = !!comment.parent_id;
    card.className = `file-comment-card user-comment ${isAIOrigin ? 'adopted-comment comment-ai-origin' : 'comment-user-origin'}`;
    card.dataset.commentId = comment.id;

    const renderedBody = window.renderMarkdown
      ? window.renderMarkdown(comment.body)
      : this.escapeHtml(comment.body);

    // Choose icon based on comment origin (AI-adopted vs user-originated) - matches line-level
    const commentIcon = isAIOrigin
      ? window.Icons.icon('commentAi', { width: 16, height: 16, className: 'octicon octicon-comment-ai' })
      : window.Icons.icon('person', { width: 16, height: 16, className: 'octicon octicon-person' });

    // Praise badge for "Nice Work" comments - matches line-level
    const praiseBadge = comment.type === 'praise'
      ? `<span class="adopted-praise-badge" title="Nice Work">${window.Icons.icon('star', 12, 12)}Nice Work</span>`
      : '';

    // Title for AI-adopted comments - matches line-level
    const titleHtml = comment.title
      ? `<span class="adopted-title">${this.escapeHtml(comment.title)}</span>`
      : '';

    // Use same structure as line-level user comments
    card.innerHTML = `
      <div class="user-comment-header">
        <span class="comment-origin-icon">
          ${commentIcon}
        </span>
        <span class="file-comment-badge" title="Comment applies to the entire file">File comment</span>
        ${praiseBadge}
        ${titleHtml}
        <div class="user-comment-actions">
          <button class="btn-chat-comment" title="Chat about comment" data-chat-comment-id="${comment.id}" data-chat-file="${this.escapeHtml(comment.file || '')}" data-chat-parent-id="${comment.parent_id || ''}">
            ${window.Icons.icon('discussion')}
          </button>
          <button class="btn-edit-comment" title="Edit comment">
            ${window.Icons.icon('pencil', { width: 16, height: 16, className: 'octicon' })}
          </button>
          <button class="btn-delete-comment" title="Dismiss comment">
            ${window.Icons.icon('trash', { width: 16, height: 16, className: 'octicon' })}
          </button>
        </div>
      </div>
      <div class="user-comment-body" data-original-markdown="${window.escapeHtmlAttribute(comment.body)}">${renderedBody}</div>
    `;

    // Wire up edit/delete buttons
    const editBtn = card.querySelector('.btn-edit-comment');
    const deleteBtn = card.querySelector('.btn-delete-comment');

    editBtn.addEventListener('click', () => this.editFileComment(zone, comment));
    deleteBtn.addEventListener('click', () => this.deleteFileComment(zone, comment.id));

    // Insert before form if present, otherwise append
    const form = container.querySelector('.file-comment-form');
    if (form) {
      container.insertBefore(card, form);
    } else {
      container.appendChild(card);
    }
  }

  /**
   * Display an AI file-level suggestion
   * @param {HTMLElement} zone - The file comments zone
   * @param {Object} suggestion - The suggestion data
   */
  displayAISuggestion(zone, suggestion) {
    const container = zone.querySelector('.file-comments-container');

    // Use the same structure as line-level AI suggestions for consistency
    const card = document.createElement('div');
    // Include ai-type-${type} class for proper category styling (especially praise badge)
    card.className = `file-comment-card ai-suggestion ai-type-${suggestion.type || 'suggestion'}`;
    card.dataset.suggestionId = suggestion.id;
    // Store original markdown body for adopt functionality via extractSuggestionData
    // Use JSON.stringify to preserve newlines and special characters (matches line-level suggestions)
    card.dataset.originalBody = JSON.stringify(suggestion.body || '');

    // Store target info on the card for reliable retrieval in getFileAndLineInfo
    // File-level suggestions don't have line numbers, just the file name
    card.dataset.fileName = suggestion.file || '';
    card.dataset.lineNumber = '';
    card.dataset.side = '';
    card.dataset.diffPosition = '';
    card.dataset.isFileLevel = 'true';

    // Check if this suggestion was adopted by looking at status or user comments with matching parent_id
    // This mirrors the behavior in suggestion-manager.js for line-level suggestions
    const userComments = this.prManager?.userComments || [];
    const suggestionIdNum = parseInt(suggestion.id);
    const wasAdopted = userComments.some(comment =>
      comment.parent_id && (comment.parent_id === suggestion.id || comment.parent_id === suggestionIdNum)
    );

    // Determine if suggestion should be collapsed based on status or adoption
    const isAdopted = wasAdopted || suggestion.status === 'adopted';
    const isDismissed = suggestion.status === 'dismissed';

    // Apply collapsed class if the suggestion is dismissed or was adopted
    if (isAdopted || isDismissed) {
      card.classList.add('collapsed');
    }

    // Get category label for display (same as line-level)
    const categoryLabel = suggestion.type || suggestion.category || '';

    const renderedBody = window.renderMarkdown
      ? window.renderMarkdown(suggestion.body)
      : this.escapeHtml(suggestion.body);

    // Use exact same HTML structure as line-level suggestions (suggestion-manager.js)
    card.innerHTML = `
      <div class="ai-suggestion-header">
        <div class="ai-suggestion-header-left">
          ${suggestion.type === 'praise'
            ? `<span class="praise-badge" title="Nice Work">${window.Icons.icon('star', 12, 12)}Nice Work</span>`
            : `<span class="ai-suggestion-badge" data-type="${suggestion.type}" title="AI Suggestion">${window.Icons.icon('sparkles', 12, 12)}AI Suggestion</span>`}
          <span class="file-comment-badge" title="Comment applies to the entire file">File comment</span>
          ${categoryLabel ? `<span class="ai-suggestion-category">${this.escapeHtml(categoryLabel)}</span>` : ''}
          <span class="ai-title">${this.escapeHtml(suggestion.title || '')}</span>
        </div>
        <div class="ai-suggestion-header-right">
          ${suggestion.reasoning && suggestion.reasoning.length > 0 ? `
          <button class="btn-reasoning-toggle" title="View reasoning" data-suggestion-id="${suggestion.id}" data-reasoning="${encodeURIComponent(JSON.stringify(suggestion.reasoning))}">
            ${window.Icons.icon('brain', 14, 14)}
          </button>
          ` : ''}
        </div>
      </div>
      <div class="ai-suggestion-collapsed-content">
        ${suggestion.type === 'praise'
          ? `<span class="praise-badge" title="Nice Work">${window.Icons.icon('star', 12, 12)}Nice Work</span>`
          : `<span class="ai-suggestion-badge collapsed" data-type="${suggestion.type}" title="AI Suggestion">${window.Icons.icon('sparkles', 10, 10)}AI Suggestion</span>`}
        <span class="collapsed-text">${isAdopted ? 'Suggestion adopted' : 'Hidden AI suggestion'}</span>
        <span class="collapsed-title">${this.escapeHtml(suggestion.title || '')}</span>
        <div class="ai-suggestion-header-right">
          ${suggestion.reasoning && suggestion.reasoning.length > 0 ? `
          <button class="btn-reasoning-toggle collapsed-reasoning" title="View reasoning" data-suggestion-id="${suggestion.id}" data-reasoning="${encodeURIComponent(JSON.stringify(suggestion.reasoning))}">
            ${window.Icons.icon('brain', 12, 12)}
          </button>
          ` : ''}
          <button class="btn-restore" title="Show suggestion">
            ${window.Icons.icon('eyeInner', { width: 16, height: 16, className: 'octicon octicon-eye' })}
            <span class="btn-text">Show</span>
          </button>
        </div>
      </div>
      <div class="ai-suggestion-body">
        ${renderedBody}
      </div>
      <div class="ai-suggestion-actions">
        <button class="ai-action ai-action-adopt">
          ${window.Icons.icon('check')}
          Adopt
        </button>
        <button class="ai-action ai-action-edit">
          ${window.Icons.icon('pencil', { width: 16, height: 16, className: 'octicon' })}
          Edit
        </button>
        <button class="ai-action ai-action-chat" title="Chat about suggestion" data-suggestion-id="${suggestion.id}" data-file="${this.escapeHtml(suggestion.file || '')}" data-title="${this.escapeHtml(suggestion.title || '')}">
          ${window.Icons.icon('discussion')}
          Chat
        </button>
        <button class="ai-action ai-action-dismiss">
          ${window.Icons.icon('close')}
          Dismiss
        </button>
      </div>
    `;

    // Wire up action buttons (using same class names as line-level)
    const adoptBtn = card.querySelector('.ai-action-adopt');
    const dismissBtn = card.querySelector('.ai-action-dismiss');
    const editBtn = card.querySelector('.ai-action-edit');
    const restoreBtn = card.querySelector('.btn-restore');

    adoptBtn.addEventListener('click', () => this.adoptAISuggestion(zone, suggestion));
    dismissBtn.addEventListener('click', () => this.dismissAISuggestion(zone, suggestion.id));
    editBtn.addEventListener('click', () => this.editAndAdoptAISuggestion(zone, suggestion));
    restoreBtn.addEventListener('click', async () => await this.restoreAISuggestion(zone, suggestion.id));

    // Insert at the beginning (AI suggestions shown first)
    const firstUserComment = container.querySelector('.file-comment-card:not(.ai-suggestion)');
    if (firstUserComment) {
      container.insertBefore(card, firstUserComment);
    } else {
      const form = container.querySelector('.file-comment-form');
      if (form) {
        container.insertBefore(card, form);
      } else {
        container.appendChild(card);
      }
    }
  }

  /**
   * Adopt an AI suggestion as a user comment
   * @param {HTMLElement} zone - The file comments zone
   * @param {Object} suggestion - The suggestion data
   */
  async adoptAISuggestion(zone, suggestion) {
    try {
      // Use the atomic /adopt endpoint which creates the user comment, sets parent_id
      // linkage, and updates suggestion status to 'adopted' in a single request
      const reviewId = this.prManager?.currentPR?.id;
      const adoptEndpoint = `/api/reviews/${reviewId}/suggestions/${suggestion.id}/adopt`;

      const adoptResponse = await fetch(adoptEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!adoptResponse.ok) throw new Error('Failed to adopt suggestion');

      const adoptResult = await adoptResponse.json();

      // Collapse the AI suggestion card instead of removing it
      const suggestionCard = zone.querySelector(`[data-suggestion-id="${suggestion.id}"]`);
      if (suggestionCard) {
        suggestionCard.classList.add('collapsed');
        // Update collapsed text to show "Suggestion adopted"
        const collapsedText = suggestionCard.querySelector('.collapsed-text');
        if (collapsedText) {
          collapsedText.textContent = 'Suggestion adopted';
        }
      }

      // Format the comment body with category prefix for display (matches server-side formatting)
      const formattedBody = this.formatAdoptedComment(suggestion.body, suggestion.type);

      // Display as user comment with formatted body
      const commentData = {
        id: adoptResult.userCommentId,
        file: suggestion.file,
        body: formattedBody,
        source: 'user',
        parent_id: suggestion.id,
        type: suggestion.type,
        title: suggestion.title,
        is_file_level: 1,
        created_at: new Date().toISOString()
      };

      this.displayUserComment(zone, commentData);
      this.updateCommentCount(zone);

      // Update parent comment count for Preview button
      if (this.prManager?.updateCommentCount) {
        this.prManager.updateCommentCount();
      }

      // Add comment to AI Panel's comment list for navigation and display
      if (window.aiPanel?.addComment) {
        window.aiPanel.addComment(commentData);
      }

      // Update finding status in AI Panel (mark suggestion as adopted)
      if (window.aiPanel?.updateFindingStatus) {
        window.aiPanel.updateFindingStatus(suggestion.id, 'adopted');
      }

    } catch (error) {
      console.error('Error adopting suggestion:', error);
      if (window.toast) {
        window.toast.showError('Failed to adopt suggestion');
      }
    }
  }

  /**
   * Dismiss an AI suggestion
   * @param {HTMLElement} zone - The file comments zone
   * @param {number} suggestionId - The suggestion ID
   */
  async dismissAISuggestion(zone, suggestionId) {
    try {
      // Update the AI suggestion status to dismissed (mode-aware endpoint)
      const endpoint = this._getSuggestionStatusEndpoint(suggestionId);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'dismissed' })
      });

      if (!response.ok) throw new Error('Failed to dismiss suggestion');

      // Collapse the card instead of removing it
      const card = zone.querySelector(`[data-suggestion-id="${suggestionId}"]`);
      if (card) {
        card.classList.add('collapsed');
        // Update collapsed text to show "Hidden AI suggestion"
        const collapsedText = card.querySelector('.collapsed-text');
        if (collapsedText) {
          collapsedText.textContent = 'Hidden AI suggestion';
        }
      }

      this.updateCommentCount(zone);

      // Update finding status in AI Panel (mark suggestion as dismissed)
      if (window.aiPanel?.updateFindingStatus) {
        window.aiPanel.updateFindingStatus(suggestionId, 'dismissed');
      }

    } catch (error) {
      console.error('Error dismissing suggestion:', error);
      if (window.toast) {
        window.toast.showError('Failed to dismiss suggestion');
      }
    }
  }

  /**
   * Restore (show) a collapsed AI suggestion
   * @param {HTMLElement} zone - The file comments zone
   * @param {number} suggestionId - The suggestion ID
   */
  async restoreAISuggestion(zone, suggestionId) {
    try {
      // Use shared helper for mode-aware endpoint
      const endpoint = this._getSuggestionStatusEndpoint(suggestionId);

      // Call API to update suggestion status to active
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' })
      });

      if (!response.ok) throw new Error('Failed to restore suggestion');

      // Update the UI - remove collapsed state
      const card = zone.querySelector(`[data-suggestion-id="${suggestionId}"]`);
      if (card) {
        card.classList.remove('collapsed');
      }

      // Update finding status in AI Panel (mark suggestion as active)
      if (window.aiPanel?.updateFindingStatus) {
        window.aiPanel.updateFindingStatus(suggestionId, 'active');
      }

      // Update comment count (for consistency with dismissAISuggestion)
      this.updateCommentCount(zone);

    } catch (error) {
      console.error('Error restoring suggestion:', error);
      if (window.toast) {
        window.toast.showError('Failed to restore suggestion');
      }
    }
  }

  /**
   * Edit and adopt an AI suggestion
   * @param {HTMLElement} zone - The file comments zone
   * @param {Object} suggestion - The suggestion data
   */
  editAndAdoptAISuggestion(zone, suggestion) {
    const container = zone.querySelector('.file-comments-container');

    // Close any existing form
    const existingForm = container.querySelector('.file-comment-form');
    if (existingForm) {
      existingForm.remove();
    }

    // Create form with pre-filled content
    const form = document.createElement('div');
    form.className = 'file-comment-form focused';
    form.dataset.suggestionId = suggestion.id;
    form.innerHTML = `
      <div class="file-comment-form-header">
        ${window.Icons.icon('comment', 14, 14)}
        <label>Edit AI suggestion</label>
      </div>
      <textarea
        class="file-comment-textarea"
        placeholder="Edit the suggestion..."
        data-file="${window.escapeHtmlAttribute(suggestion.file)}"
      >${this.escapeHtml(suggestion.body)}</textarea>
      <div class="file-comment-form-footer">
        <button class="file-comment-form-btn submit submit-btn">Adopt</button>
        <button class="file-comment-form-btn cancel cancel-btn">Cancel</button>
      </div>
    `;

    // Insert form after the suggestion card
    const suggestionCard = zone.querySelector(`[data-suggestion-id="${suggestion.id}"]`);
    if (suggestionCard) {
      suggestionCard.after(form);
    } else {
      container.appendChild(form);
    }

    const textarea = form.querySelector('.file-comment-textarea');
    const submitBtn = form.querySelector('.submit-btn');
    const cancelBtn = form.querySelector('.cancel-btn');

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    // Attach emoji picker for autocomplete
    if (window.emojiPicker) {
      window.emojiPicker.attach(textarea);
    }

    textarea.addEventListener('focus', () => form.classList.add('focused'));
    textarea.addEventListener('blur', () => form.classList.remove('focused'));

    textarea.addEventListener('input', () => {
      submitBtn.disabled = !textarea.value.trim();
    });

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        form.remove();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && textarea.value.trim()) {
        this.adoptWithEdit(zone, suggestion, textarea.value.trim());
        form.remove();
      }
    });

    cancelBtn.addEventListener('click', () => form.remove());

    submitBtn.addEventListener('click', () => {
      if (textarea.value.trim()) {
        this.adoptWithEdit(zone, suggestion, textarea.value.trim());
        form.remove();
      }
    });
  }

  /**
   * Adopt an AI suggestion with edited body
   * @param {HTMLElement} zone - The file comments zone
   * @param {Object} suggestion - The original suggestion
   * @param {string} editedBody - The edited comment body
   */
  async adoptWithEdit(zone, suggestion, editedBody) {
    try {
      // Format the edited body with category prefix (matches line-level behavior)
      const formattedBody = this.formatAdoptedComment(editedBody, suggestion.type);

      // Use the /edit endpoint which atomically creates a user comment with the edited
      // body and sets the suggestion status to 'adopted' with parent_id linkage
      const reviewId = this.prManager?.currentPR?.id;
      const editEndpoint = `/api/reviews/${reviewId}/suggestions/${suggestion.id}/edit`;

      const editResponse = await fetch(editEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'adopt_edited',
          editedText: formattedBody
        })
      });

      if (!editResponse.ok) throw new Error('Failed to adopt suggestion with edits');

      const editResult = await editResponse.json();

      // Collapse the AI suggestion card instead of removing it
      const suggestionCard = zone.querySelector(`[data-suggestion-id="${suggestion.id}"]`);
      if (suggestionCard) {
        suggestionCard.classList.add('collapsed');
        // Update collapsed text to show "Suggestion adopted"
        const collapsedText = suggestionCard.querySelector('.collapsed-text');
        if (collapsedText) {
          collapsedText.textContent = 'Suggestion adopted';
        }
      }

      // Display as user comment with formatted body
      const commentData = {
        id: editResult.userCommentId,
        file: suggestion.file,
        body: formattedBody,
        source: 'user',
        parent_id: suggestion.id,
        type: suggestion.type,
        title: suggestion.title,
        is_file_level: 1,
        created_at: new Date().toISOString()
      };

      this.displayUserComment(zone, commentData);
      this.updateCommentCount(zone);

      // Update parent comment count for Preview button
      if (this.prManager?.updateCommentCount) {
        this.prManager.updateCommentCount();
      }

      // Add comment to AI Panel's comment list for navigation and display
      if (window.aiPanel?.addComment) {
        window.aiPanel.addComment(commentData);
      }

      // Update finding status in AI Panel (mark suggestion as adopted)
      if (window.aiPanel?.updateFindingStatus) {
        window.aiPanel.updateFindingStatus(suggestion.id, 'adopted');
      }

    } catch (error) {
      console.error('Error adopting suggestion with edit:', error);
      if (window.toast) {
        window.toast.showError('Failed to adopt suggestion');
      }
    }
  }

  /**
   * Edit a user file-level comment
   * @param {HTMLElement} zone - The file comments zone
   * @param {Object} comment - The comment data
   */
  editFileComment(zone, comment) {
    const card = zone.querySelector(`[data-comment-id="${comment.id}"]`);
    if (!card) return;

    const bodyEl = card.querySelector('.user-comment-body');
    const originalMarkdown = bodyEl.dataset.originalMarkdown || comment.body;

    // Replace body with edit form (matching line-level comment edit form styling)
    bodyEl.innerHTML = `
      <textarea class="file-comment-textarea" style="min-height: 80px;">${this.escapeHtml(originalMarkdown)}</textarea>
      <div class="comment-edit-actions">
        <button class="btn btn-sm btn-primary save-edit-btn">Save</button>
        <button class="btn btn-sm btn-secondary cancel-edit-btn">Cancel</button>
      </div>
    `;

    const textarea = bodyEl.querySelector('.file-comment-textarea');
    const saveBtn = bodyEl.querySelector('.save-edit-btn');
    const cancelBtn = bodyEl.querySelector('.cancel-edit-btn');

    card.classList.add('editing-mode');

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    // Attach emoji picker for autocomplete
    if (window.emojiPicker) {
      window.emojiPicker.attach(textarea);
    }

    const restoreView = () => {
      card.classList.remove('editing-mode');
      const renderedBody = window.renderMarkdown
        ? window.renderMarkdown(originalMarkdown)
        : this.escapeHtml(originalMarkdown);
      bodyEl.innerHTML = renderedBody;
      bodyEl.dataset.originalMarkdown = originalMarkdown;
    };

    cancelBtn.addEventListener('click', restoreView);

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        restoreView();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && textarea.value.trim()) {
        this.saveEditedComment(zone, comment.id, textarea.value.trim(), bodyEl);
      }
    });

    saveBtn.addEventListener('click', () => {
      if (textarea.value.trim()) {
        this.saveEditedComment(zone, comment.id, textarea.value.trim(), bodyEl);
      }
    });
  }

  /**
   * Save an edited comment
   * @param {HTMLElement} zone - The file comments zone
   * @param {number} commentId - The comment ID
   * @param {string} newBody - The new comment body
   * @param {HTMLElement} bodyEl - The body element to update
   */
  async saveEditedComment(zone, commentId, newBody, bodyEl) {
    // Prevent duplicate saves from rapid clicks or Cmd+Enter
    const editForm = bodyEl?.closest('.file-comment-card')?.querySelector('.file-comment-edit-form');
    const saveBtn = editForm?.querySelector('.submit-btn');
    if (saveBtn?.dataset.saving === 'true') {
      return;
    }
    if (saveBtn) saveBtn.dataset.saving = 'true';
    if (saveBtn) saveBtn.disabled = true;

    try {
      const { endpoint, requestBody } = this._getFileCommentEndpoint('update', {
        commentId: commentId,
        body: newBody
      });

      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) throw new Error('Failed to update comment');

      // Update the display
      const card = bodyEl?.closest('.file-comment-card');
      if (card) card.classList.remove('editing-mode');
      const renderedBody = window.renderMarkdown
        ? window.renderMarkdown(newBody)
        : this.escapeHtml(newBody);
      bodyEl.innerHTML = renderedBody;
      bodyEl.dataset.originalMarkdown = newBody;

    } catch (error) {
      console.error('Error updating comment:', error);
      if (window.toast) {
        window.toast.showError('Failed to update comment');
      }
      // Re-enable save button on failure so the user can retry
      if (saveBtn) {
        saveBtn.dataset.saving = 'false';
        saveBtn.disabled = false;
      }
    }
  }

  /**
   * Delete a user file-level comment
   * @param {HTMLElement} zone - The file comments zone
   * @param {number} commentId - The comment ID
   */
  async deleteFileComment(zone, commentId) {
    try {
      const { endpoint } = this._getFileCommentEndpoint('delete', {
        commentId: commentId
      });

      const response = await fetch(endpoint, {
        method: 'DELETE'
      });

      if (!response.ok) throw new Error('Failed to delete comment');

      const apiResult = await response.json();

      // Remove the card
      const card = zone.querySelector(`[data-comment-id="${commentId}"]`);
      if (card) {
        card.remove();
      }

      this.updateCommentCount(zone);

      // Update parent comment count
      if (this.prManager?.updateCommentCount) {
        this.prManager.updateCommentCount();
      }

      // Notify AI Panel about the deleted comment
      if (window.aiPanel?.removeComment) {
        window.aiPanel.removeComment(commentId);
      }

      // If a parent suggestion existed, the suggestion card is still collapsed/dismissed in the diff view.
      // Update AIPanel to show the suggestion as 'dismissed' (matching its visual state).
      // User can click "Show" to restore it to active state if they want to re-adopt.
      if (apiResult.dismissedSuggestionId && window.aiPanel?.updateFindingStatus) {
        window.aiPanel.updateFindingStatus(apiResult.dismissedSuggestionId, 'dismissed');
      }

    } catch (error) {
      console.error('Error deleting comment:', error);
      if (window.toast) {
        window.toast.showError('Failed to delete comment');
      }
    }
  }

  /**
   * Get the appropriate API endpoint for updating AI suggestion status
   * Handles both local and PR modes.
   * @private
   * @param {number|string} suggestionId - The suggestion ID
   * @returns {string} The API endpoint URL
   */
  _getSuggestionStatusEndpoint(suggestionId) {
    const reviewId = this.prManager?.currentPR?.id;

    return `/api/reviews/${reviewId}/suggestions/${suggestionId}/status`;
  }

  /**
   * Update the zone state based on comment count
   * @param {HTMLElement} zone - The file comments zone
   */
  updateCommentCount(zone) {
    const container = zone.querySelector('.file-comments-container');

    const userComments = container.querySelectorAll('.file-comment-card:not(.ai-suggestion)').length;
    const aiSuggestions = container.querySelectorAll('.file-comment-card.ai-suggestion').length;
    const total = userComments + aiSuggestions;

    // Update header button icon state (outline vs filled)
    this.updateHeaderButtonState(zone, total);
  }

  /**
   * Update the header button icon state based on comment count.
   *
   * Note: The `zone.headerButton` property is injected externally by pr.js
   * during file header rendering. This coupling allows the file-comment-manager
   * to update the header's comment icon state (outline vs filled) without
   * needing direct access to the header DOM structure.
   *
   * @param {HTMLElement} zone - The file comments zone element
   * @param {number} count - Total comment count (user + AI suggestions)
   */
  updateHeaderButtonState(zone, count) {
    const headerBtn = zone.headerButton;
    if (!headerBtn) return;

    const outlineIcon = headerBtn.querySelector('.comment-icon-outline');
    const filledIcon = headerBtn.querySelector('.comment-icon-filled');

    if (count > 0) {
      // Has comments - show filled icon
      if (outlineIcon) outlineIcon.style.display = 'none';
      if (filledIcon) filledIcon.style.display = '';
      headerBtn.classList.add('has-comments');
      headerBtn.title = `${count} file comment${count > 1 ? 's' : ''} - click to add more`;
    } else {
      // No comments - show outline icon
      if (outlineIcon) outlineIcon.style.display = '';
      if (filledIcon) filledIcon.style.display = 'none';
      headerBtn.classList.remove('has-comments');
      headerBtn.title = 'Add file comment';
    }
  }

  /**
   * Load and display file-level comments for all files
   * @param {Array} comments - Array of file-level comments
   * @param {Array} suggestions - Array of file-level AI suggestions
   */
  loadFileComments(comments, suggestions) {
    // Group by file
    const commentsByFile = new Map();
    const suggestionsByFile = new Map();

    if (comments) {
      for (const comment of comments) {
        if (comment.is_file_level === 1) {
          if (!commentsByFile.has(comment.file)) {
            commentsByFile.set(comment.file, []);
          }
          commentsByFile.get(comment.file).push(comment);
        }
      }
    }

    if (suggestions) {
      for (const suggestion of suggestions) {
        if (suggestion.is_file_level === 1) {
          if (!suggestionsByFile.has(suggestion.file)) {
            suggestionsByFile.set(suggestion.file, []);
          }
          suggestionsByFile.get(suggestion.file).push(suggestion);
        }
      }
    }

    // Find all file comment zones and populate them
    const zones = document.querySelectorAll('.file-comments-zone');
    for (const zone of zones) {
      const fileName = zone.dataset.fileName;
      const container = zone.querySelector('.file-comments-container');

      // Selectively clear existing cards based on what we're about to reload
      // This prevents user comments from being cleared when only reloading AI suggestions
      if (container) {
        // Only clear AI suggestions if we have suggestions to display
        // (prevents stale suggestions from persisting when reloading or changing levels)
        if (suggestions && suggestions.length > 0) {
          const existingAISuggestions = container.querySelectorAll('.file-comment-card.ai-suggestion');
          for (const card of existingAISuggestions) {
            card.remove();
          }
        }

        // Only clear user comments if we have comments to display
        if (comments && comments.length > 0) {
          const existingUserComments = container.querySelectorAll('.file-comment-card.user-comment');
          for (const card of existingUserComments) {
            card.remove();
          }
        }
      }

      const fileComments = commentsByFile.get(fileName) || [];
      const fileSuggestions = suggestionsByFile.get(fileName) || [];

      // Display AI suggestions first
      for (const suggestion of fileSuggestions) {
        this.displayAISuggestion(zone, suggestion);
      }

      // Then user comments
      for (const comment of fileComments) {
        this.displayUserComment(zone, comment);
      }

      // Update count
      this.updateCommentCount(zone);
    }
  }

  /**
   * Find the file comments zone for a given file
   * @param {string} fileName - The file path
   * @returns {HTMLElement|null} The zone element or null
   */
  findZoneForFile(fileName) {
    return document.querySelector(`.file-comments-zone[data-file-name="${fileName}"]`);
  }

  /**
   * Escape HTML characters
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Format timestamp for display
   * @param {string} timestamp - ISO timestamp
   * @returns {string} Formatted timestamp
   */
  formatTimestamp(timestamp) {
    if (!timestamp) return 'Just now';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    return date.toLocaleDateString();
  }

  /**
   * Check if a suggestion block already exists in the textarea
   * @param {string} text - The textarea content
   * @returns {boolean} True if a suggestion block exists
   */
  hasSuggestionBlock(text) {
    // Match both ``` and ```` suggestion blocks, allowing leading whitespace
    return /^\s*(`{3,})suggestion\s*$/m.test(text);
  }

  /**
   * Update the suggestion button state based on textarea content
   * Disables the button if a suggestion block already exists
   * @param {HTMLTextAreaElement} textarea - The textarea to check
   * @param {HTMLButtonElement} button - The suggestion button
   */
  updateSuggestionButtonState(textarea, button) {
    if (!button) return;
    const hasSuggestion = this.hasSuggestionBlock(textarea.value);
    button.disabled = hasSuggestion;
    button.title = hasSuggestion ? 'Only one suggestion per comment' : 'Insert a suggestion';
  }

  /**
   * Insert a suggestion block into the textarea at cursor position
   * For file-level comments, inserts an empty suggestion block
   * @param {HTMLTextAreaElement} textarea - The textarea to insert into
   * @param {HTMLButtonElement} [button] - Optional suggestion button to disable after insert
   */
  insertSuggestionBlock(textarea, button) {
    // Check if suggestion already exists
    if (this.hasSuggestionBlock(textarea.value)) {
      return;
    }

    // For file-level comments, insert empty suggestion block
    const backticks = '```';
    const suggestionBlock = `${backticks}suggestion\n\n${backticks}`;

    // Get current cursor position
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;

    // Insert at cursor position (or replace selection)
    const before = text.substring(0, start);
    const after = text.substring(end);

    // Add newlines if needed for clean formatting
    const needsNewlineBefore = before.length > 0 && !before.endsWith('\n');
    const needsNewlineAfter = after.length > 0 && !after.startsWith('\n');

    const prefix = needsNewlineBefore ? '\n' : '';
    const suffix = needsNewlineAfter ? '\n' : '';

    textarea.value = before + prefix + suggestionBlock + suffix + after;

    // Position cursor inside the suggestion block
    const newCursorPos = start + prefix.length + backticks.length + 'suggestion\n'.length;
    textarea.setSelectionRange(newCursorPos, newCursorPos);
    textarea.focus();

    // Trigger input event for auto-resize and state updates
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    // Disable the suggestion button
    if (button) {
      button.disabled = true;
      button.title = 'Only one suggestion per comment';
    }
  }
}

// Make FileCommentManager available globally
window.FileCommentManager = FileCommentManager;

// Export for CommonJS testing environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FileCommentManager };
}
