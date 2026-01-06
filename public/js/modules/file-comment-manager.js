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
    // Current open form
    this.currentForm = null;
  }

  /**
   * Create the file comments zone element for a file
   * @param {string} fileName - The file path
   * @returns {HTMLElement} The file comments zone element
   */
  createFileCommentsZone(fileName) {
    const zone = document.createElement('div');
    zone.className = 'file-comments-zone collapsed';
    zone.dataset.fileName = fileName;

    // Zone Header
    const header = document.createElement('div');
    header.className = 'file-comments-header';

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'file-comments-toggle';
    toggleBtn.innerHTML = `
      <span class="toggle-icon">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.78 6.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 7.28a.75.75 0 0 1 1.06-1.06L8 9.94l3.72-3.72a.75.75 0 0 1 1.06 0z"/>
        </svg>
      </span>
      File Comments
      <span class="comment-count-badge empty">0</span>
    `;
    toggleBtn.addEventListener('click', () => this.toggleZone(zone));

    // Add comment button
    const addBtn = document.createElement('button');
    addBtn.className = 'add-file-comment-btn';
    addBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0a.75.75 0 0 1 .75.75v6.5h6.5a.75.75 0 0 1 0 1.5h-6.5v6.5a.75.75 0 0 1-1.5 0v-6.5H.75a.75.75 0 0 1 0-1.5h6.5V.75A.75.75 0 0 1 8 0z"/>
      </svg>
      Add comment
    `;
    addBtn.addEventListener('click', () => this.showCommentForm(zone, fileName));

    header.appendChild(toggleBtn);
    header.appendChild(addBtn);

    // Comments container
    const container = document.createElement('div');
    container.className = 'file-comments-container';

    // Empty state
    const emptyState = document.createElement('div');
    emptyState.className = 'file-comments-empty';
    emptyState.textContent = 'No file-level comments yet. Click "Add comment" to start a discussion about this file.';
    container.appendChild(emptyState);

    zone.appendChild(header);
    zone.appendChild(container);

    return zone;
  }

  /**
   * Toggle the file comments zone visibility
   * @param {HTMLElement} zone - The zone element
   */
  toggleZone(zone) {
    zone.classList.toggle('collapsed');
  }

  /**
   * Expand the zone (show it)
   * @param {HTMLElement} zone - The zone element
   */
  expandZone(zone) {
    zone.classList.remove('collapsed');
  }

  /**
   * Show the comment form for a file
   * @param {HTMLElement} zone - The file comments zone
   * @param {string} fileName - The file path
   */
  showCommentForm(zone, fileName) {
    // Expand zone if collapsed
    this.expandZone(zone);

    const container = zone.querySelector('.file-comments-container');

    // Hide empty state if present
    const emptyState = container.querySelector('.file-comments-empty');
    if (emptyState) {
      emptyState.style.display = 'none';
    }

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
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5z"/>
        </svg>
        <label>Add file-level comment</label>
      </div>
      <textarea
        class="file-comment-textarea"
        placeholder="Write a comment about this file..."
        data-file="${this.escapeHtml(fileName)}"
      ></textarea>
      <div class="file-comment-form-footer">
        <button class="file-comment-form-btn cancel">Cancel</button>
        <button class="file-comment-form-btn submit" disabled>Add Comment</button>
      </div>
    `;

    container.appendChild(form);

    // Get elements
    const textarea = form.querySelector('.file-comment-textarea');
    const submitBtn = form.querySelector('.file-comment-form-btn.submit');
    const cancelBtn = form.querySelector('.file-comment-form-btn.cancel');

    // Focus textarea
    textarea.focus();

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

    this.currentForm = form;
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
      this.currentForm = null;
    }

    // Show empty state if no comments
    const hasComments = container.querySelectorAll('.file-comment-card').length > 0;
    const emptyState = container.querySelector('.file-comments-empty');
    if (emptyState && !hasComments) {
      emptyState.style.display = 'block';
    }
  }

  /**
   * Save a file-level comment
   * @param {HTMLElement} zone - The file comments zone
   * @param {string} fileName - The file path
   * @param {string} body - The comment body
   */
  async saveFileComment(zone, fileName, body) {
    try {
      const prId = this.prManager?.currentPR?.id;
      const headSha = this.prManager?.currentPR?.head_sha;

      const response = await fetch('/api/file-comment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          pr_id: prId,
          file: fileName,
          body: body,
          commit_sha: headSha
        })
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
      alert('Failed to save file-level comment');
    }
  }

  /**
   * Display a user file-level comment
   * @param {HTMLElement} zone - The file comments zone
   * @param {Object} comment - The comment data
   */
  displayUserComment(zone, comment) {
    const container = zone.querySelector('.file-comments-container');

    // Hide empty state
    const emptyState = container.querySelector('.file-comments-empty');
    if (emptyState) {
      emptyState.style.display = 'none';
    }

    const card = document.createElement('div');
    card.className = 'file-comment-card';
    card.dataset.commentId = comment.id;

    const renderedBody = window.renderMarkdown
      ? window.renderMarkdown(comment.body)
      : this.escapeHtml(comment.body);

    card.innerHTML = `
      <div class="file-comment-header">
        <span class="comment-source-badge user">User</span>
        <span class="comment-author">you</span>
        <div class="file-comment-user-actions">
          <button class="file-comment-user-btn edit" title="Edit">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm.176 4.823L9.75 4.81l-6.286 6.287a.25.25 0 0 0-.064.108l-.558 1.953 1.953-.558a.249.249 0 0 0 .108-.064l6.286-6.286z"/>
            </svg>
          </button>
          <button class="file-comment-user-btn delete" title="Delete">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.75 1.75 0 0 1 10.595 15H5.405a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15zM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25z"/>
            </svg>
          </button>
        </div>
        <span class="comment-timestamp">${this.formatTimestamp(comment.created_at)}</span>
      </div>
      <div class="file-comment-body">
        <div class="comment-text" data-original-markdown="${this.escapeHtml(comment.body)}">${renderedBody}</div>
      </div>
    `;

    // Wire up edit/delete buttons
    const editBtn = card.querySelector('.file-comment-user-btn.edit');
    const deleteBtn = card.querySelector('.file-comment-user-btn.delete');

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

    // Hide empty state
    const emptyState = container.querySelector('.file-comments-empty');
    if (emptyState) {
      emptyState.style.display = 'none';
    }

    const card = document.createElement('div');
    card.className = 'file-comment-card ai-suggestion';
    card.dataset.suggestionId = suggestion.id;

    const typeTag = suggestion.type
      ? `<span class="comment-type-tag ${suggestion.type}">${suggestion.type}</span>`
      : '';

    const levelInfo = suggestion.ai_level
      ? `Level ${suggestion.ai_level} · `
      : '';

    const titleHtml = suggestion.title
      ? `<div class="comment-title">${this.escapeHtml(suggestion.title)}</div>`
      : '';

    const renderedBody = window.renderMarkdown
      ? window.renderMarkdown(suggestion.body)
      : this.escapeHtml(suggestion.body);

    card.innerHTML = `
      <div class="file-comment-header">
        <span class="comment-source-badge ai">
          <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
            <path d="M7.75 1a.75.75 0 0 1 0 1.5h-5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2c.199 0 .39.079.53.22.141.14.22.331.22.53v2.19l2.72-2.72a.747.747 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-2a.75.75 0 0 1 1.5 0v2c0 .464-.184.909-.513 1.237A1.746 1.746 0 0 1 13.25 12H9.06l-2.573 2.573A1.457 1.457 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5C1 1.784 1.784 1 2.75 1h5Zm4.519-.837a.248.248 0 0 1 .466 0l.238.648a3.726 3.726 0 0 0 2.218 2.219l.649.238a.249.249 0 0 1 0 .467l-.649.238a3.725 3.725 0 0 0-2.218 2.218l-.238.649a.248.248 0 0 1-.466 0l-.239-.649a3.725 3.725 0 0 0-2.218-2.218l-.649-.238a.249.249 0 0 1 0-.467l.649-.238A3.726 3.726 0 0 0 12.03.811l.239-.648Z"/>
          </svg>
          AI
        </span>
        <span class="comment-author">Claude Analysis</span>
        ${typeTag}
        <span class="comment-timestamp">${levelInfo}Just now</span>
      </div>
      <div class="file-comment-body">
        ${titleHtml}
        <div class="comment-text">${renderedBody}</div>
      </div>
      <div class="file-comment-actions">
        <button class="file-comment-action-btn adopt">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/>
          </svg>
          Adopt
        </button>
        <button class="file-comment-action-btn dismiss">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/>
          </svg>
          Dismiss
        </button>
        <button class="file-comment-action-btn edit">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm.176 4.823L9.75 4.81l-6.286 6.287a.25.25 0 0 0-.064.108l-.558 1.953 1.953-.558a.249.249 0 0 0 .108-.064l6.286-6.286z"/>
          </svg>
          Edit & Adopt
        </button>
      </div>
    `;

    // Wire up action buttons
    const adoptBtn = card.querySelector('.file-comment-action-btn.adopt');
    const dismissBtn = card.querySelector('.file-comment-action-btn.dismiss');
    const editBtn = card.querySelector('.file-comment-action-btn.edit');

    adoptBtn.addEventListener('click', () => this.adoptAISuggestion(zone, suggestion));
    dismissBtn.addEventListener('click', () => this.dismissAISuggestion(zone, suggestion.id));
    editBtn.addEventListener('click', () => this.editAndAdoptAISuggestion(zone, suggestion));

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
      const prId = this.prManager?.currentPR?.id;
      const headSha = this.prManager?.currentPR?.head_sha;

      // Create a file-level user comment from the suggestion
      const createResponse = await fetch('/api/file-comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pr_id: prId,
          file: suggestion.file,
          body: suggestion.body,
          commit_sha: headSha
        })
      });

      if (!createResponse.ok) throw new Error('Failed to create user comment');

      const createResult = await createResponse.json();

      // Update the AI suggestion status to adopted
      const statusResponse = await fetch(`/api/ai-suggestion/${suggestion.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'adopted' })
      });

      if (!statusResponse.ok) throw new Error('Failed to update suggestion status');

      // Remove the AI suggestion card
      const suggestionCard = zone.querySelector(`[data-suggestion-id="${suggestion.id}"]`);
      if (suggestionCard) {
        suggestionCard.remove();
      }

      // Display as user comment
      const commentData = {
        id: createResult.commentId,
        file: suggestion.file,
        body: suggestion.body,
        source: 'user',
        parent_id: suggestion.id,
        type: suggestion.type,
        title: suggestion.title,
        is_file_level: 1,
        created_at: new Date().toISOString()
      };

      this.displayUserComment(zone, commentData);
      this.updateCommentCount(zone);

      // Notify AI Panel
      if (window.aiPanel?.updateSuggestionStatus) {
        window.aiPanel.updateSuggestionStatus(suggestion.id, 'adopted');
      }

    } catch (error) {
      console.error('Error adopting suggestion:', error);
      alert('Failed to adopt suggestion');
    }
  }

  /**
   * Dismiss an AI suggestion
   * @param {HTMLElement} zone - The file comments zone
   * @param {number} suggestionId - The suggestion ID
   */
  async dismissAISuggestion(zone, suggestionId) {
    try {
      // Update the AI suggestion status to dismissed
      const response = await fetch(`/api/ai-suggestion/${suggestionId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'dismissed' })
      });

      if (!response.ok) throw new Error('Failed to dismiss suggestion');

      // Remove the card
      const card = zone.querySelector(`[data-suggestion-id="${suggestionId}"]`);
      if (card) {
        card.remove();
      }

      this.updateCommentCount(zone);

      // Notify AI Panel
      if (window.aiPanel?.updateSuggestionStatus) {
        window.aiPanel.updateSuggestionStatus(suggestionId, 'dismissed');
      }

    } catch (error) {
      console.error('Error dismissing suggestion:', error);
      alert('Failed to dismiss suggestion');
    }
  }

  /**
   * Edit and adopt an AI suggestion
   * @param {HTMLElement} zone - The file comments zone
   * @param {Object} suggestion - The suggestion data
   */
  editAndAdoptAISuggestion(zone, suggestion) {
    // Show form pre-filled with suggestion body
    this.expandZone(zone);

    const container = zone.querySelector('.file-comments-container');

    // Hide empty state
    const emptyState = container.querySelector('.file-comments-empty');
    if (emptyState) {
      emptyState.style.display = 'none';
    }

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
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5z"/>
        </svg>
        <label>Edit AI suggestion</label>
      </div>
      <textarea
        class="file-comment-textarea"
        placeholder="Edit the suggestion..."
        data-file="${this.escapeHtml(suggestion.file)}"
      >${this.escapeHtml(suggestion.body)}</textarea>
      <div class="file-comment-form-footer">
        <button class="file-comment-form-btn cancel">Cancel</button>
        <button class="file-comment-form-btn submit">Adopt</button>
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
    const submitBtn = form.querySelector('.file-comment-form-btn.submit');
    const cancelBtn = form.querySelector('.file-comment-form-btn.cancel');

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

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
      const prId = this.prManager?.currentPR?.id;
      const headSha = this.prManager?.currentPR?.head_sha;

      // Create a file-level user comment with the edited body
      const createResponse = await fetch('/api/file-comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pr_id: prId,
          file: suggestion.file,
          body: editedBody,
          commit_sha: headSha
        })
      });

      if (!createResponse.ok) throw new Error('Failed to create user comment');

      const createResult = await createResponse.json();

      // Update the AI suggestion status to adopted
      const statusResponse = await fetch(`/api/ai-suggestion/${suggestion.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'adopted' })
      });

      if (!statusResponse.ok) throw new Error('Failed to update suggestion status');

      // Remove the AI suggestion card
      const suggestionCard = zone.querySelector(`[data-suggestion-id="${suggestion.id}"]`);
      if (suggestionCard) {
        suggestionCard.remove();
      }

      // Display as user comment
      const commentData = {
        id: createResult.commentId,
        file: suggestion.file,
        body: editedBody,
        source: 'user',
        parent_id: suggestion.id,
        type: suggestion.type,
        title: suggestion.title,
        is_file_level: 1,
        created_at: new Date().toISOString()
      };

      this.displayUserComment(zone, commentData);
      this.updateCommentCount(zone);

      // Notify AI Panel
      if (window.aiPanel?.updateSuggestionStatus) {
        window.aiPanel.updateSuggestionStatus(suggestion.id, 'adopted');
      }

    } catch (error) {
      console.error('Error adopting suggestion with edit:', error);
      alert('Failed to adopt suggestion');
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

    const bodyEl = card.querySelector('.file-comment-body');
    const originalMarkdown = bodyEl.querySelector('.comment-text').dataset.originalMarkdown || comment.body;

    // Replace body with edit form
    bodyEl.innerHTML = `
      <textarea class="file-comment-textarea" style="min-height: 80px;">${this.escapeHtml(originalMarkdown)}</textarea>
      <div class="file-comment-form-footer" style="padding: 8px 0 0 0; background: transparent; border: none;">
        <button class="file-comment-form-btn cancel">Cancel</button>
        <button class="file-comment-form-btn submit">Save</button>
      </div>
    `;

    const textarea = bodyEl.querySelector('.file-comment-textarea');
    const saveBtn = bodyEl.querySelector('.file-comment-form-btn.submit');
    const cancelBtn = bodyEl.querySelector('.file-comment-form-btn.cancel');

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const restoreView = () => {
      const renderedBody = window.renderMarkdown
        ? window.renderMarkdown(originalMarkdown)
        : this.escapeHtml(originalMarkdown);
      bodyEl.innerHTML = `<div class="comment-text" data-original-markdown="${this.escapeHtml(originalMarkdown)}">${renderedBody}</div>`;
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
    try {
      const response = await fetch(`/api/user-comment/${commentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: newBody })
      });

      if (!response.ok) throw new Error('Failed to update comment');

      // Update the display
      const renderedBody = window.renderMarkdown
        ? window.renderMarkdown(newBody)
        : this.escapeHtml(newBody);
      bodyEl.innerHTML = `<div class="comment-text" data-original-markdown="${this.escapeHtml(newBody)}">${renderedBody}</div>`;

    } catch (error) {
      console.error('Error updating comment:', error);
      alert('Failed to update comment');
    }
  }

  /**
   * Delete a user file-level comment
   * @param {HTMLElement} zone - The file comments zone
   * @param {number} commentId - The comment ID
   */
  async deleteFileComment(zone, commentId) {
    if (!confirm('Are you sure you want to delete this comment?')) return;

    try {
      const response = await fetch(`/api/user-comment/${commentId}`, {
        method: 'DELETE'
      });

      if (!response.ok) throw new Error('Failed to delete comment');

      // Remove the card
      const card = zone.querySelector(`[data-comment-id="${commentId}"]`);
      if (card) {
        card.remove();
      }

      this.updateCommentCount(zone);

      // Show empty state if no more comments
      const container = zone.querySelector('.file-comments-container');
      const hasComments = container.querySelectorAll('.file-comment-card').length > 0;
      if (!hasComments) {
        const emptyState = container.querySelector('.file-comments-empty');
        if (emptyState) {
          emptyState.style.display = 'block';
        }
      }

      // Update parent comment count
      if (this.prManager?.updateCommentCount) {
        this.prManager.updateCommentCount();
      }

    } catch (error) {
      console.error('Error deleting comment:', error);
      alert('Failed to delete comment');
    }
  }

  /**
   * Update the comment count badge for a zone
   * @param {HTMLElement} zone - The file comments zone
   */
  updateCommentCount(zone) {
    const container = zone.querySelector('.file-comments-container');
    const badge = zone.querySelector('.comment-count-badge');

    const userComments = container.querySelectorAll('.file-comment-card:not(.ai-suggestion)').length;
    const aiSuggestions = container.querySelectorAll('.file-comment-card.ai-suggestion').length;
    const total = userComments + aiSuggestions;

    badge.textContent = total.toString();

    // Update badge style
    badge.classList.remove('has-ai', 'empty');
    if (total === 0) {
      badge.classList.add('empty');
    } else if (aiSuggestions > 0) {
      badge.classList.add('has-ai');
    }

    // If there are comments, expand the zone
    if (total > 0 && zone.classList.contains('collapsed')) {
      this.expandZone(zone);
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
}

// Make FileCommentManager available globally
window.FileCommentManager = FileCommentManager;
