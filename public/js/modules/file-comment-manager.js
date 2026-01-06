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
    // Update header button state after toggling
    const container = zone.querySelector('.file-comments-container');
    const userComments = container.querySelectorAll('.file-comment-card:not(.ai-suggestion)').length;
    const aiSuggestions = container.querySelectorAll('.file-comment-card.ai-suggestion').length;
    this.updateHeaderButtonState(zone, userComments + aiSuggestions);
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
        placeholder="Write a comment about this file... (Ctrl+Enter to save)"
        data-file="${this.escapeHtml(fileName)}"
      ></textarea>
      <div class="file-comment-form-footer">
        <button class="file-comment-form-btn submit submit-btn" disabled>Save</button>
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
    // Match line-level: add adopted-comment and comment-ai-origin classes when AI-originated
    const isAIOrigin = !!comment.parent_id;
    card.className = `file-comment-card user-comment ${isAIOrigin ? 'adopted-comment comment-ai-origin' : 'comment-user-origin'}`;
    card.dataset.commentId = comment.id;

    const renderedBody = window.renderMarkdown
      ? window.renderMarkdown(comment.body)
      : this.escapeHtml(comment.body);

    // Choose icon based on comment origin (AI-adopted vs user-originated) - matches line-level
    const commentIcon = isAIOrigin
      ? `<svg class="octicon octicon-comment-ai" viewBox="0 0 16 16" width="16" height="16">
           <path d="M7.75 1a.75.75 0 0 1 0 1.5h-5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2c.199 0 .39.079.53.22.141.14.22.331.22.53v2.19l2.72-2.72a.747.747 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-2a.75.75 0 0 1 1.5 0v2c0 .464-.184.909-.513 1.237A1.746 1.746 0 0 1 13.25 12H9.06l-2.573 2.573A1.457 1.457 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5C1 1.784 1.784 1 2.75 1h5Zm4.519-.837a.248.248 0 0 1 .466 0l.238.648a3.726 3.726 0 0 0 2.218 2.219l.649.238a.249.249 0 0 1 0 .467l-.649.238a3.725 3.725 0 0 0-2.218 2.218l-.238.649a.248.248 0 0 1-.466 0l-.239-.649a3.725 3.725 0 0 0-2.218-2.218l-.649-.238a.249.249 0 0 1 0-.467l.649-.238A3.726 3.726 0 0 0 12.03.811l.239-.648Z"/>
         </svg>`
      : `<svg class="octicon octicon-person" viewBox="0 0 16 16" width="16" height="16">
           <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
         </svg>`;

    // Praise badge for "Nice Work" comments - matches line-level
    const praiseBadge = comment.type === 'praise'
      ? `<span class="adopted-praise-badge" title="Nice Work"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>Nice Work</span>`
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
        <span class="user-comment-line-info">File</span>
        ${praiseBadge}
        ${titleHtml}
        <span class="user-comment-timestamp">${this.formatTimestamp(comment.created_at)}</span>
        <div class="user-comment-actions">
          <button class="btn-edit-comment" title="Edit comment">
            <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
              <path fill-rule="evenodd" d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"></path>
            </svg>
          </button>
          <button class="btn-delete-comment" title="Delete comment">
            <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
              <path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19c.9 0 1.652-.681 1.741-1.576l.66-6.6a.75.75 0 00-1.492-.149l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"></path>
            </svg>
          </button>
        </div>
      </div>
      <div class="user-comment-body" data-original-markdown="${this.escapeHtml(comment.body)}">${renderedBody}</div>
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

    // Hide empty state
    const emptyState = container.querySelector('.file-comments-empty');
    if (emptyState) {
      emptyState.style.display = 'none';
    }

    // Use the same structure as line-level AI suggestions for consistency
    const card = document.createElement('div');
    // Include ai-type-${type} class for proper category styling (especially praise badge)
    card.className = `file-comment-card ai-suggestion ai-type-${suggestion.type || 'suggestion'}`;
    card.dataset.suggestionId = suggestion.id;

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
            ? `<span class="praise-badge" title="Nice Work"><svg viewBox="0 0 16 16"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>Nice Work</span>`
            : `<span class="ai-suggestion-badge" data-type="${suggestion.type}" title="AI Suggestion"><svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M9.6 2.279a.426.426 0 0 1 .8 0l.407 1.112a6.386 6.386 0 0 0 3.802 3.802l1.112.407a.426.426 0 0 1 0 .8l-1.112.407a6.386 6.386 0 0 0-3.802 3.802l-.407 1.112a.426.426 0 0 1-.8 0l-.407-1.112a6.386 6.386 0 0 0-3.802-3.802L4.279 8.4a.426.426 0 0 1 0-.8l1.112-.407a6.386 6.386 0 0 0 3.802-3.802L9.6 2.279Zm-4.267 8.837a.178.178 0 0 1 .334 0l.169.464a2.662 2.662 0 0 0 1.584 1.584l.464.169a.178.178 0 0 1 0 .334l-.464.169a2.662 2.662 0 0 0-1.584 1.584l-.169.464a.178.178 0 0 1-.334 0l-.169-.464a2.662 2.662 0 0 0-1.584-1.584l-.464-.169a.178.178 0 0 1 0-.334l.464-.169a2.662 2.662 0 0 0 1.584-1.584l.169-.464ZM2.8.14a.213.213 0 0 1 .4 0l.203.556a3.2 3.2 0 0 0 1.901 1.901l.556.203a.213.213 0 0 1 0 .4l-.556.203a3.2 3.2 0 0 0-1.901 1.901L3.2 5.86a.213.213 0 0 1-.4 0l-.203-.556A3.2 3.2 0 0 0 .696 3.403L.14 3.2a.213.213 0 0 1 0-.4l.556-.203A3.2 3.2 0 0 0 2.597.696L2.8.14Z"/></svg>AI Suggestion</span>`}
          ${categoryLabel ? `<span class="ai-suggestion-category">${this.escapeHtml(categoryLabel)}</span>` : ''}
          <span class="ai-title">${this.escapeHtml(suggestion.title || '')}</span>
        </div>
      </div>
      <div class="ai-suggestion-collapsed-content">
        ${suggestion.type === 'praise'
          ? `<span class="praise-badge" title="Nice Work"><svg viewBox="0 0 16 16"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>Nice Work</span>`
          : `<span class="ai-suggestion-badge collapsed" data-type="${suggestion.type}" title="AI Suggestion"><svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10"><path d="M9.6 2.279a.426.426 0 0 1 .8 0l.407 1.112a6.386 6.386 0 0 0 3.802 3.802l1.112.407a.426.426 0 0 1 0 .8l-1.112.407a6.386 6.386 0 0 0-3.802 3.802l-.407 1.112a.426.426 0 0 1-.8 0l-.407-1.112a6.386 6.386 0 0 0-3.802-3.802L4.279 8.4a.426.426 0 0 1 0-.8l1.112-.407a6.386 6.386 0 0 0 3.802-3.802L9.6 2.279Zm-4.267 8.837a.178.178 0 0 1 .334 0l.169.464a2.662 2.662 0 0 0 1.584 1.584l.464.169a.178.178 0 0 1 0 .334l-.464.169a2.662 2.662 0 0 0-1.584 1.584l-.169.464a.178.178 0 0 1-.334 0l-.169-.464a2.662 2.662 0 0 0-1.584-1.584l-.464-.169a.178.178 0 0 1 0-.334l.464-.169a2.662 2.662 0 0 0 1.584-1.584l.169-.464ZM2.8.14a.213.213 0 0 1 .4 0l.203.556a3.2 3.2 0 0 0 1.901 1.901l.556.203a.213.213 0 0 1 0 .4l-.556.203a3.2 3.2 0 0 0-1.901 1.901L3.2 5.86a.213.213 0 0 1-.4 0l-.203-.556A3.2 3.2 0 0 0 .696 3.403L.14 3.2a.213.213 0 0 1 0-.4l.556-.203A3.2 3.2 0 0 0 2.597.696L2.8.14Z"/></svg>AI Suggestion</span>`}
        <span class="collapsed-text">${isAdopted ? 'Suggestion adopted' : 'Hidden AI suggestion'}</span>
        <span class="collapsed-title">${this.escapeHtml(suggestion.title || '')}</span>
        <button class="btn-restore" title="Show suggestion">
          <svg class="octicon octicon-eye" viewBox="0 0 16 16" width="16" height="16">
            <path fill-rule="evenodd" d="M1.679 7.932c.412-.621 1.242-1.75 2.366-2.717C5.175 4.242 6.527 3.5 8 3.5c1.473 0 2.824.742 3.955 1.715 1.124.967 1.954 2.096 2.366 2.717a.119.119 0 010 .136c-.412.621-1.242 1.75-2.366 2.717C10.825 11.758 9.473 12.5 8 12.5c-1.473 0-2.824-.742-3.955-1.715C2.92 9.818 2.09 8.69 1.679 8.068a.119.119 0 010-.136zM8 2c-1.981 0-3.67.992-4.933 2.078C1.797 5.169.88 6.423.43 7.1a1.619 1.619 0 000 1.798c.45.678 1.367 1.932 2.637 3.024C4.329 13.008 6.019 14 8 14c1.981 0 3.67-.992 4.933-2.078 1.27-1.091 2.187-2.345 2.637-3.023a1.619 1.619 0 000-1.798c-.45-.678-1.367-1.932-2.637-3.023C11.671 2.992 9.981 2 8 2zm0 8a2 2 0 100-4 2 2 0 000 4z"></path>
          </svg>
          <span class="btn-text">Show</span>
        </button>
      </div>
      <div class="ai-suggestion-body">
        ${renderedBody}
      </div>
      <div class="ai-suggestion-actions">
        <button class="ai-action ai-action-adopt">
          <svg viewBox="0 0 16 16" width="16" height="16"><path fill-rule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"></path></svg>
          Adopt
        </button>
        <button class="ai-action ai-action-edit">
          <svg viewBox="0 0 16 16" width="16" height="16"><path fill-rule="evenodd" d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"></path></svg>
          Edit
        </button>
        <button class="ai-action ai-action-dismiss">
          <svg viewBox="0 0 16 16" width="16" height="16"><path fill-rule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"></path></svg>
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
    restoreBtn.addEventListener('click', () => this.restoreAISuggestion(zone, suggestion.id));

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
      alert('Failed to dismiss suggestion');
    }
  }

  /**
   * Restore (show) a collapsed AI suggestion
   * @param {HTMLElement} zone - The file comments zone
   * @param {number} suggestionId - The suggestion ID
   */
  restoreAISuggestion(zone, suggestionId) {
    const card = zone.querySelector(`[data-suggestion-id="${suggestionId}"]`);
    if (card) {
      card.classList.remove('collapsed');
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

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const restoreView = () => {
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
      bodyEl.innerHTML = renderedBody;
      bodyEl.dataset.originalMarkdown = newBody;

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
    if (!window.confirmDialog) {
      alert('Confirmation dialog unavailable. Please refresh the page.');
      return;
    }

    const result = await window.confirmDialog.show({
      title: 'Delete Comment?',
      message: 'Are you sure you want to delete this comment? This action cannot be undone.',
      confirmText: 'Delete',
      confirmClass: 'btn-danger'
    });

    if (result !== 'confirm') return;

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

    // If there are comments, expand the zone
    if (total > 0 && zone.classList.contains('collapsed')) {
      this.expandZone(zone);
    }
  }

  /**
   * Update the header button icon state based on comment count
   * @param {HTMLElement} zone - The file comments zone
   * @param {number} count - Total comment count
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
      headerBtn.title = `View ${count} comment${count > 1 ? 's' : ''}`;
    } else {
      // No comments - show outline icon
      if (outlineIcon) outlineIcon.style.display = '';
      if (filledIcon) filledIcon.style.display = 'none';
      headerBtn.classList.remove('has-comments');
      headerBtn.title = 'Add file comment';
    }

    // Update expanded state
    const isExpanded = !zone.classList.contains('collapsed');
    headerBtn.classList.toggle('expanded', isExpanded);
    if (isExpanded) {
      headerBtn.title = count > 0 ? 'Hide comments' : 'Hide comment panel';
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

        // Update empty state based on remaining/new content
        const emptyState = container.querySelector('.file-comments-empty');
        const remainingCards = container.querySelectorAll('.file-comment-card').length;
        if (emptyState) {
          emptyState.style.display = remainingCards > 0 ? 'none' : 'block';
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
