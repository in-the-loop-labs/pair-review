// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * CommentManager - Comment UI handling
 * Handles comment forms, editing, saving, deletion, and display.
 */

class CommentManager {
  constructor(prManagerRef) {
    // Reference to parent PRManager for API calls and state access
    this.prManager = prManagerRef;
    // Current comment form element
    this.currentCommentForm = null;

    // Event delegation for "Ask about this" chat button on user comments
    document.addEventListener('click', (e) => {
      const chatBtn = e.target.closest('.user-comment-row .btn-chat-comment');
      if (chatBtn && window.chatPanel) {
        e.stopPropagation();
        const commentRow = chatBtn.closest('.user-comment-row');
        const bodyEl = commentRow?.querySelector('.user-comment-body');
        const originalMarkdown = bodyEl?.dataset?.originalMarkdown || bodyEl?.textContent || '';
        window.chatPanel.open({
          reviewId: this.prManager?.currentPR?.id,
          commentContext: {
            commentId: chatBtn.dataset.chatCommentId,
            body: originalMarkdown,
            file: chatBtn.dataset.chatFile || '',
            line_start: chatBtn.dataset.chatLineStart ? parseInt(chatBtn.dataset.chatLineStart) : null,
            line_end: chatBtn.dataset.chatLineEnd ? parseInt(chatBtn.dataset.chatLineEnd) : null,
            parentId: chatBtn.dataset.chatParentId || null,
            source: 'user'
          }
        });
      }
    });
  }

  /**
   * Check whether a line falls within a diff hunk for the given file.
   * Uses the parsed hunk blocks from HunkParser rather than relying on
   * diff_position, which may be absent for comments created by the chat agent.
   *
   * @param {string} fileName - The file path
   * @param {number} lineNum - The line number to check
   * @param {string} [side='RIGHT'] - 'LEFT' for old/deleted lines, 'RIGHT' for new/added/context
   * @returns {boolean} true if the line is inside a diff hunk
   */
  isLineInDiffHunk(fileName, lineNum, side = 'RIGHT') {
    const patch = this.prManager?.filePatches?.get(fileName);
    if (!patch || !window.HunkParser) return false;

    const blocks = window.HunkParser.parseDiffIntoBlocks(patch);
    for (const block of blocks) {
      let oldLine = block.oldStart;
      let newLine = block.newStart;

      for (const line of block.lines) {
        if (line.startsWith('\\ No newline')) continue;
        if (line.startsWith('+')) {
          if (side === 'RIGHT' && newLine === lineNum) return true;
          newLine++;
        } else if (line.startsWith('-')) {
          if (side === 'LEFT' && oldLine === lineNum) return true;
          oldLine++;
        } else {
          // Context line — present on both sides
          if (side === 'LEFT' && oldLine === lineNum) return true;
          if (side === 'RIGHT' && newLine === lineNum) return true;
          oldLine++;
          newLine++;
        }
      }
    }
    return false;
  }

  /**
   * Show comment form inline
   * @param {HTMLElement} targetRow - The row to insert the comment form after
   * @param {number} lineNumber - The starting line number for the comment
   * @param {string} fileName - The file name
   * @param {number} diffPosition - The diff position for GitHub API
   * @param {number} [endLineNumber] - Optional ending line number for multi-line comments
   * @param {string} [side='RIGHT'] - The side of the diff ('LEFT' for deleted lines, 'RIGHT' for added/context)
   */
  showCommentForm(targetRow, lineNumber, fileName, diffPosition, endLineNumber, side = 'RIGHT') {
    // Close any existing comment forms
    this.hideCommentForm();

    // Highlight the line(s) being commented on (if not already highlighted)
    const lineTracker = this.prManager?.lineTracker;
    if (lineTracker && (!lineTracker.rangeSelectionStart || !lineTracker.rangeSelectionEnd)) {
      // No existing selection, so create one for this comment
      const actualEndLine = endLineNumber || lineNumber;
      const minLine = Math.min(lineNumber, actualEndLine);
      const maxLine = Math.max(lineNumber, actualEndLine);

      // Set selection state (including side for GitHub API)
      lineTracker.rangeSelectionStart = {
        row: targetRow,
        lineNumber: minLine,
        fileName: fileName,
        side: side
      };
      lineTracker.rangeSelectionEnd = {
        row: targetRow,
        lineNumber: maxLine,
        fileName: fileName,
        side: side
      };

      // Highlight the line(s) (pass side to avoid highlighting both deleted and added lines with same line number)
      lineTracker.highlightLineRange(targetRow, targetRow, fileName, minLine, maxLine, side);
    }

    // Create comment form row
    const formRow = document.createElement('tr');
    formRow.className = 'comment-form-row';

    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'comment-form-cell';

    // Determine if this is a range comment
    const isRange = endLineNumber && endLineNumber !== lineNumber;
    const lineRangeText = isRange ? `Lines ${lineNumber}-${endLineNumber}` : `Line ${lineNumber}`;

    // Check if this line has a diff position (needed for GitHub submission)
    const hasDiffPosition = diffPosition !== undefined && diffPosition !== null && diffPosition !== '';
    const expandedContextWarning = hasDiffPosition ? '' :
      `<div class="expanded-context-warning">Warning: Expanded context line - may not submit to GitHub</div>`;

    const formHTML = `
      <div class="user-comment-form">
        <div class="comment-form-header">
          <span class="comment-icon">💬</span>
          <span class="comment-title">Add comment</span>
          ${isRange ? `<span class="line-range-indicator">${lineRangeText}</span>` : ''}
        </div>
        ${expandedContextWarning}
        <div class="comment-form-toolbar">
          <button type="button" class="btn btn-sm suggestion-btn" title="Insert a suggestion">
            ${window.Icons.icon('file', { width: 16, height: 16, className: 'octicon' })}
          </button>
        </div>
        <textarea
          class="comment-textarea"
          placeholder="Leave a comment... (Cmd/Ctrl+Enter to save)"
          data-line="${lineNumber}"
          data-line-end="${endLineNumber || lineNumber}"
          data-file="${fileName}"
          data-diff-position="${diffPosition || ''}"
          data-side="${side}"
        ></textarea>
        <div class="comment-form-actions">
          <button class="btn btn-sm btn-primary save-comment-btn" disabled>Save</button>
          <button class="ai-action ai-action-chat btn-chat-from-comment" title="Chat about these lines">
            ${window.Icons.icon('discussion')}
            Chat
          </button>
          <button class="btn btn-sm btn-secondary cancel-comment-btn">Cancel</button>
        </div>
      </div>
    `;

    td.innerHTML = formHTML;
    formRow.appendChild(td);

    // Insert form after the target row
    targetRow.parentNode.insertBefore(formRow, targetRow.nextSibling);

    // Focus on textarea
    const textarea = td.querySelector('.comment-textarea');
    textarea.focus();

    // Attach emoji picker for autocomplete
    if (window.emojiPicker) {
      window.emojiPicker.attach(textarea);
    }

    // Add event listeners
    const saveBtn = td.querySelector('.save-comment-btn');
    const cancelBtn = td.querySelector('.cancel-comment-btn');
    const suggestionBtn = td.querySelector('.suggestion-btn');

    saveBtn.addEventListener('click', () => this.saveUserComment(textarea, formRow));
    cancelBtn.addEventListener('click', () => {
      this.hideCommentForm();
      if (lineTracker) lineTracker.clearRangeSelection();
    });

    // Suggestion button handler
    suggestionBtn.addEventListener('click', () => {
      if (!suggestionBtn.disabled) {
        this.insertSuggestionBlock(textarea, suggestionBtn);
      }
    });

    // Chat button handler - opens chat panel with line context card
    const chatFromCommentBtn = td.querySelector('.btn-chat-from-comment');
    if (chatFromCommentBtn) {
      chatFromCommentBtn.addEventListener('click', () => {
        if (!window.chatPanel) return;
        const unsavedText = textarea.value.trim();
        const file = textarea.dataset.file;
        const lineStart = textarea.dataset.line ? parseInt(textarea.dataset.line) : null;
        const lineEnd = textarea.dataset.lineEnd ? parseInt(textarea.dataset.lineEnd) : lineStart;

        this.hideCommentForm();
        if (lineTracker) lineTracker.clearRangeSelection();
        window.chatPanel.open({
          commentContext: {
            type: 'line',
            body: unsavedText || null,
            file: file || '',
            line_start: lineStart,
            line_end: lineEnd,
            source: 'user'
          }
        });
      });
    }

    // Initialize textarea height and suggestion button state
    this.autoResizeTextarea(textarea);
    this.updateSuggestionButtonState(textarea, suggestionBtn);

    // Auto-resize textarea, update suggestion button and save button state on input
    textarea.addEventListener('input', () => {
      this.autoResizeTextarea(textarea);
      this.updateSuggestionButtonState(textarea, suggestionBtn);
      // Enable/disable save button based on content
      saveBtn.disabled = !textarea.value.trim();
    });

    // Keyboard shortcuts (Escape, Cmd/Ctrl+Enter) are handled by delegated
    // event listener in setupCommentFormDelegation() to avoid memory leaks

    // Store reference for cleanup
    this.currentCommentForm = formRow;
  }

  /**
   * Hide any open comment form
   */
  hideCommentForm() {
    if (this.currentCommentForm) {
      this.currentCommentForm.remove();
      this.currentCommentForm = null;
    }
    // Note: Don't clear range selection here - let the caller decide
  }

  /**
   * Auto-resize textarea to fit content
   * @param {HTMLTextAreaElement} textarea - The textarea to resize
   * @param {number} minRows - Minimum number of rows (default 4)
   */
  autoResizeTextarea(textarea, minRows = 4) {
    // Reset height to auto to get accurate scrollHeight
    textarea.style.height = 'auto';

    // Get line height from computed styles
    const computedStyle = window.getComputedStyle(textarea);
    const lineHeight = parseFloat(computedStyle.lineHeight) || 20;
    const paddingTop = parseFloat(computedStyle.paddingTop) || 0;
    const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0;
    const borderTop = parseFloat(computedStyle.borderTopWidth) || 0;
    const borderBottom = parseFloat(computedStyle.borderBottomWidth) || 0;

    // Calculate minimum height based on minRows
    const minHeight = (lineHeight * minRows) + paddingTop + paddingBottom + borderTop + borderBottom;

    // Set height to max of scrollHeight or minHeight
    const newHeight = Math.max(textarea.scrollHeight, minHeight);
    textarea.style.height = `${newHeight}px`;
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
   * Get code content from diff lines in a range
   * @param {string} fileName - The file name
   * @param {number} startLine - Start line number
   * @param {number} endLine - End line number
   * @param {string} [side] - The side of the diff ('LEFT' or 'RIGHT') to filter by
   * @returns {string} The code content from the lines
   */
  getCodeFromLines(fileName, startLine, endLine, side) {
    // Find the file wrapper
    const fileWrappers = document.querySelectorAll('.d2h-file-wrapper');
    let targetWrapper = null;

    for (const wrapper of fileWrappers) {
      if (wrapper.dataset.fileName === fileName) {
        targetWrapper = wrapper;
        break;
      }
    }

    if (!targetWrapper) {
      console.warn(`[Suggestion] Could not find file wrapper for ${fileName}`);
      return '';
    }

    // Find all rows in the line range
    const rows = targetWrapper.querySelectorAll('tr[data-line-number]');
    const codeLines = [];

    // Always filter by side to prevent including both OLD and NEW versions of modified lines.
    // Default to 'RIGHT' because suggestions target the NEW version of code.
    // This is the definitive fix: even if callers fail to propagate side, we never return both versions.
    const effectiveSide = side || 'RIGHT';

    for (const row of rows) {
      const lineNum = parseInt(row.dataset.lineNumber, 10);
      if (lineNum >= startLine && lineNum <= endLine && row.dataset.fileName === fileName && row.dataset.side === effectiveSide) {
        // Get the code content cell
        const codeCell = row.querySelector('.d2h-code-line-ctn');
        if (codeCell) {
          // Get text content, preserving whitespace but removing any HTML
          codeLines.push(codeCell.textContent);
        }
      }
    }

    return codeLines.join('\n');
  }

  /**
   * Insert a suggestion block into the textarea at cursor position
   * Pre-fills with code from the selected lines
   * @param {HTMLTextAreaElement} textarea - The textarea to insert into
   * @param {HTMLButtonElement} [button] - Optional suggestion button to disable after insert
   */
  insertSuggestionBlock(textarea, button) {
    // Check if suggestion already exists
    if (this.hasSuggestionBlock(textarea.value)) {
      return;
    }

    const fileName = textarea.dataset.file;
    const startLine = parseInt(textarea.dataset.line, 10);
    const endLine = parseInt(textarea.dataset.lineEnd, 10) || startLine;
    const side = textarea.dataset.side;
    if (!side) {
      console.warn('[Suggestion] textarea missing data-side attribute, defaulting to RIGHT');
    }

    // Get the code from the selected lines (pass side to avoid including both deleted and added lines)
    const code = this.getCodeFromLines(fileName, startLine, endLine, side);

    // Build the suggestion block
    // Use 4 backticks if the code contains triple backticks
    const backticks = code.includes('```') ? '````' : '```';
    const suggestionBlock = `${backticks}suggestion\n${code}\n${backticks}`;

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

    // Position cursor inside the suggestion block (at the start of the code)
    const newCursorPos = start + prefix.length + backticks.length + 'suggestion\n'.length;
    textarea.setSelectionRange(newCursorPos, newCursorPos + code.length);
    textarea.focus();

    // Trigger auto-resize
    this.autoResizeTextarea(textarea);

    // Disable the suggestion button
    if (button) {
      this.updateSuggestionButtonState(textarea, button);
    }
  }

  /**
   * Save user comment
   * @param {HTMLTextAreaElement} textarea - The textarea element
   * @param {HTMLElement} formRow - The form row element
   */
  async saveUserComment(textarea, formRow) {
    const fileName = textarea.dataset.file;
    const lineNumber = parseInt(textarea.dataset.line);
    // Validate endLineNumber, fallback to lineNumber if invalid
    const parsedEndLine = parseInt(textarea.dataset.lineEnd);
    const endLineNumber = !isNaN(parsedEndLine) ? parsedEndLine : lineNumber;
    const diffPosition = textarea.dataset.diffPosition ? parseInt(textarea.dataset.diffPosition) : null;
    // Get the side for GitHub API (LEFT for deleted lines, RIGHT for added/context)
    const side = textarea.dataset.side || 'RIGHT';
    const content = textarea.value.trim();

    // Guard clause - button should be disabled when empty, but check anyway
    if (!content) {
      return;
    }

    // Prevent duplicate saves from rapid clicks or Cmd+Enter
    const saveBtn = formRow?.querySelector('.save-comment-btn');
    if (saveBtn?.dataset.saving === 'true') {
      return;
    }
    if (saveBtn) saveBtn.dataset.saving = 'true';
    if (saveBtn) saveBtn.disabled = true;

    try {
      const reviewId = this.prManager?.currentPR?.id;
      const headSha = this.prManager?.currentPR?.head_sha;

      const response = await fetch(`/api/reviews/${reviewId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: fileName,
          line_start: lineNumber,
          line_end: endLineNumber,
          diff_position: diffPosition,
          side: side,
          commit_sha: headSha,  // Anchor comment to PR head commit
          body: content
        })
      });

      if (!response.ok) {
        throw new Error('Failed to save comment');
      }

      const result = await response.json();

      // Build comment object
      const commentData = {
        id: result.commentId,
        file: fileName,
        line_start: lineNumber,
        line_end: endLineNumber,
        diff_position: diffPosition,  // Include for expanded context warning logic
        side: side,  // Include side for suggestion code extraction
        body: content,
        created_at: new Date().toISOString()
      };

      // Create comment display row
      this.displayUserComment(commentData, formRow.previousElementSibling);

      // Notify AI Panel about the new comment
      if (window.aiPanel?.addComment) {
        window.aiPanel.addComment(commentData);
      }

      // Hide form and clear selection
      this.hideCommentForm();
      if (this.prManager?.lineTracker) {
        this.prManager.lineTracker.clearRangeSelection();
      }

      // Update comment count
      if (this.prManager?.updateCommentCount) {
        this.prManager.updateCommentCount();
      }

    } catch (error) {
      console.error('Error saving comment:', error);
      alert('Failed to save comment');
      // Re-enable save button on failure so the user can retry
      if (saveBtn) {
        saveBtn.dataset.saving = 'false';
        saveBtn.disabled = false;
      }
    }
  }

  /**
   * Display a user comment inline
   * Note: Dismissed comments are never rendered in the diff view per design decision.
   * They only appear in the AI/Review Panel. This method only receives active comments.
   * @param {Object} comment - Comment data
   * @param {HTMLElement} targetRow - Row to insert after
   */
  displayUserComment(comment, targetRow) {
    const commentRow = document.createElement('tr');
    commentRow.className = 'user-comment-row';
    commentRow.dataset.commentId = comment.id;
    // Store file/line/side data for editing
    commentRow.dataset.file = comment.file;
    commentRow.dataset.lineStart = comment.line_start;
    commentRow.dataset.lineEnd = comment.line_end || comment.line_start;
    if (comment.side) {
      commentRow.dataset.side = comment.side;
    }

    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'user-comment-cell';

    // Format line info
    const lineInfo = comment.line_end && comment.line_end !== comment.line_start
      ? `Lines ${comment.line_start}-${comment.line_end}`
      : `Line ${comment.line_start}`;

    // WORKAROUND: Comments on expanded context lines (outside diff hunks) will be
    // submitted as file-level comments since GitHub's API doesn't support line-level
    // comments on these lines. Show an indicator to inform the user.
    // Check actual diff hunk membership rather than diff_position, which may be
    // absent for comments created by the chat agent even when they target hunk lines.
    const commentSide = comment.side || 'RIGHT';
    const isRange = comment.line_end && comment.line_end !== comment.line_start;
    const isExpandedContext = isRange
      ? !this.isLineInDiffHunk(comment.file, comment.line_start, commentSide) || !this.isLineInDiffHunk(comment.file, comment.line_end, commentSide)
      : !this.isLineInDiffHunk(comment.file, comment.line_start, commentSide);
    const expandedContextIndicator = isExpandedContext
      ? `<span class="expanded-context-indicator" title="This expanded context comment will be posted to GitHub as a file-level comment">
           ${window.Icons.icon('filePlain', 14, 14)}
         </span>`
      : '';

    // Build metadata display for adopted comments
    // Only show "Nice Work" badge for praise - skip "AI Suggestion" badge since collapsed original is visible above
    let metadataHTML = '';
    if (comment.parent_id && comment.type && comment.type !== 'comment') {
      const escapeHtml = this.prManager?.escapeHtml?.bind(this.prManager) || ((s) => s);
      const badgeHTML = comment.type === 'praise'
        ? `<span class="adopted-praise-badge" title="Nice Work">${window.Icons.icon('star', 12, 12)}Nice Work</span>`
        : '';
      metadataHTML = `
        ${badgeHTML}
        ${comment.title ? `<span class="adopted-title">${escapeHtml(comment.title)}</span>` : ''}
      `;
    }

    const escapeHtml = this.prManager?.escapeHtml?.bind(this.prManager) || ((s) => s);

    // Choose icon based on comment origin (AI-adopted vs user-originated)
    const commentIcon = comment.parent_id
      ? window.Icons.icon('commentAi', { width: 16, height: 16, className: 'octicon octicon-comment-ai' })
      : window.Icons.icon('person', { width: 16, height: 16, className: 'octicon octicon-person' });

    // Build class list for comment styling
    const baseClasses = ['user-comment'];
    if (comment.parent_id) {
      baseClasses.push('adopted-comment', 'comment-ai-origin');
    } else {
      baseClasses.push('comment-user-origin');
    }
    const commentClasses = baseClasses.join(' ');

    const commentHTML = `
      <div class="${commentClasses}">
        <div class="user-comment-header">
          <span class="comment-origin-icon">
            ${commentIcon}
          </span>
          <span class="user-comment-line-info">${lineInfo}</span>
          ${expandedContextIndicator}
          ${metadataHTML}
          <div class="user-comment-actions">
            <button class="btn-chat-comment" title="Chat about comment" data-chat-comment-id="${comment.id}" data-chat-file="${escapeHtml(comment.file || '')}" data-chat-line-start="${comment.line_start ?? ''}" data-chat-line-end="${comment.line_end || comment.line_start || ''}" data-chat-parent-id="${comment.parent_id || ''}">
              ${window.Icons.icon('discussion')}
            </button>
            <button class="btn-edit-comment" onclick="prManager.editUserComment(${comment.id})" title="Edit comment">
              ${window.Icons.icon('pencil', { width: 16, height: 16, className: 'octicon' })}
            </button>
            <button class="btn-delete-comment" onclick="prManager.deleteUserComment(${comment.id})" title="Dismiss comment">
              ${window.Icons.icon('trash', { width: 16, height: 16, className: 'octicon' })}
            </button>
          </div>
        </div>
        <div class="user-comment-body" data-original-markdown="${window.escapeHtmlAttribute(comment.body)}">${window.renderMarkdown ? window.renderMarkdown(comment.body) : escapeHtml(comment.body)}</div>
      </div>
    `;

    td.innerHTML = commentHTML;
    commentRow.appendChild(td);

    // Insert comment after the target row
    targetRow.parentNode.insertBefore(commentRow, targetRow.nextSibling);
  }

  /**
   * Display a user comment in edit mode (for adopted suggestions)
   * @param {Object} comment - Comment data
   * @param {HTMLElement} targetRow - Row to insert after
   */
  displayUserCommentInEditMode(comment, targetRow) {
    const commentRow = document.createElement('tr');
    commentRow.className = 'user-comment-row';
    commentRow.dataset.commentId = comment.id;
    // Store file/line/side data for editing
    commentRow.dataset.file = comment.file;
    commentRow.dataset.lineStart = comment.line_start;
    commentRow.dataset.lineEnd = comment.line_end || comment.line_start;
    if (comment.side) {
      commentRow.dataset.side = comment.side;
    }

    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'user-comment-cell';

    const lineInfo = comment.line_end && comment.line_end !== comment.line_start
      ? `Lines ${comment.line_start}-${comment.line_end}`
      : `Line ${comment.line_start}`;

    const escapeHtml = this.prManager?.escapeHtml?.bind(this.prManager) || ((s) => s);

    // Choose icon based on comment origin (AI-adopted vs user-originated)
    const commentIcon = comment.parent_id
      ? window.Icons.icon('commentAi', { width: 16, height: 16, className: 'octicon octicon-comment-ai' })
      : window.Icons.icon('person', { width: 16, height: 16, className: 'octicon octicon-person' });

    const commentHTML = `
      <div class="user-comment editing-mode ${comment.parent_id ? 'adopted-comment comment-ai-origin' : 'comment-user-origin'}">
        <div class="user-comment-header">
          <span class="comment-origin-icon">
            ${commentIcon}
          </span>
          <span class="user-comment-line-info">${lineInfo}</span>
          ${comment.type === 'praise' ? `<span class="adopted-praise-badge" title="Nice Work">${window.Icons.icon('star', 12, 12)}Nice Work</span>` : ''}
          ${comment.title ? `<span class="adopted-title">${escapeHtml(comment.title)}</span>` : ''}
        </div>
        <!-- Hidden body div for saving - pre-populate with markdown rendered content and store original -->
        <div class="user-comment-body" style="display: none;" data-original-markdown="${window.escapeHtmlAttribute(comment.body)}">${window.renderMarkdown ? window.renderMarkdown(comment.body) : escapeHtml(comment.body)}</div>
        <div class="user-comment-edit-form">
          <div class="comment-form-toolbar">
            <button type="button" class="btn btn-sm suggestion-btn" title="Insert a suggestion (Ctrl+G)">
              ${window.Icons.icon('file', { width: 16, height: 16, className: 'octicon' })}
            </button>
          </div>
          <textarea
            id="edit-comment-${comment.id}"
            class="comment-edit-textarea"
            placeholder="Enter your comment..."
            data-file="${comment.file}"
            data-line="${comment.line_start}"
            data-line-end="${comment.line_end || comment.line_start}"
            data-side="${comment.side || 'RIGHT'}"
          >${escapeHtml(comment.body)}</textarea>
          <div class="comment-edit-actions">
            <button class="btn btn-sm btn-primary save-edit-btn">
              Save
            </button>
            <button class="btn btn-sm btn-secondary cancel-edit-btn">
              Cancel
            </button>
          </div>
        </div>
      </div>
    `;

    td.innerHTML = commentHTML;
    commentRow.appendChild(td);

    // Insert comment immediately after the target row (suggestion row)
    if (targetRow.nextSibling) {
      targetRow.parentNode.insertBefore(commentRow, targetRow.nextSibling);
    } else {
      targetRow.parentNode.appendChild(commentRow);
    }

    // Get references
    const editForm = td.querySelector('.user-comment-edit-form');
    const textarea = document.getElementById(`edit-comment-${comment.id}`);
    const suggestionBtn = editForm.querySelector('.suggestion-btn');
    const saveBtn = editForm.querySelector('.save-edit-btn');
    const cancelBtn = editForm.querySelector('.cancel-edit-btn');

    if (textarea) {
      // Auto-resize to fit content
      this.autoResizeTextarea(textarea);

      textarea.focus();
      // Position cursor at end of text instead of selecting all
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);

      // Attach emoji picker for autocomplete
      if (window.emojiPicker) {
        window.emojiPicker.attach(textarea);
      }

      // Update suggestion button state based on content
      this.updateSuggestionButtonState(textarea, suggestionBtn);

      // Suggestion button handler
      suggestionBtn.addEventListener('click', () => {
        if (!suggestionBtn.disabled) {
          this.insertSuggestionBlock(textarea, suggestionBtn);
        }
      });

      // Save/cancel handlers - use prManager methods for consistency
      saveBtn.addEventListener('click', () => this.prManager?.saveEditedUserComment(comment.id));
      cancelBtn.addEventListener('click', () => this.prManager?.cancelEditUserComment(comment.id));

      // Auto-resize on input and update suggestion button state
      textarea.addEventListener('input', () => {
        this.autoResizeTextarea(textarea);
        this.updateSuggestionButtonState(textarea, suggestionBtn);
      });

      // Keyboard shortcuts (Escape, Cmd/Ctrl+Enter) are handled by delegated
      // event listener in setupCommentFormDelegation() to avoid memory leaks
    }
  }
}

// Make CommentManager available globally
window.CommentManager = CommentManager;

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CommentManager };
}
