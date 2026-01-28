// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * CommentManager - Comment UI handling
 * Handles comment forms, editing, saving, deletion, and display.
 */

class CommentManager {
  /**
   * Shared SVG icon for the suggestion button.
   * Uses the GitHub Primer file-diff-16 octicon.
   */
  static SUGGESTION_ICON_SVG = `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
    <path d="M1 1.75C1 .784 1.784 0 2.75 0h7.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073ZM8 3.25a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5h-1.5v1.5a.75.75 0 0 1-1.5 0V7h-1.5a.75.75 0 0 1 0-1.5h1.5V4A.75.75 0 0 1 8 3.25Zm-3 8a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Z"></path>
  </svg>`;

  constructor(prManagerRef) {
    // Reference to parent PRManager for API calls and state access
    this.prManager = prManagerRef;
    // Current comment form element
    this.currentCommentForm = null;
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
            ${CommentManager.SUGGESTION_ICON_SVG}
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

    for (const row of rows) {
      const lineNum = parseInt(row.dataset.lineNumber, 10);
      // Filter by line number, file name, and side (if provided)
      // Side filtering prevents including both deleted and added versions of modified lines
      const matchesSide = !side || row.dataset.side === side;
      if (lineNum >= startLine && lineNum <= endLine && row.dataset.fileName === fileName && matchesSide) {
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

    try {
      const reviewId = this.prManager?.currentPR?.id;
      const headSha = this.prManager?.currentPR?.head_sha;

      const response = await fetch('/api/user-comment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          review_id: reviewId,
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
    const isExpandedContext = comment.diff_position === null || comment.diff_position === undefined;
    const expandedContextIndicator = isExpandedContext
      ? `<span class="expanded-context-indicator" title="This expanded context comment will be posted to GitHub as a file-level comment">
           <svg viewBox="0 0 16 16" width="14" height="14">
             <path fill-rule="evenodd" d="M3.75 1.5a.25.25 0 00-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0112.25 15h-8.5A1.75 1.75 0 012 13.25V1.75z"></path>
           </svg>
         </span>`
      : '';

    // Build metadata display for adopted comments
    // Only show "Nice Work" badge for praise - skip "AI Suggestion" badge since collapsed original is visible above
    let metadataHTML = '';
    if (comment.parent_id && comment.type && comment.type !== 'comment') {
      const escapeHtml = this.prManager?.escapeHtml?.bind(this.prManager) || ((s) => s);
      const badgeHTML = comment.type === 'praise'
        ? `<span class="adopted-praise-badge" title="Nice Work"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>Nice Work</span>`
        : '';
      metadataHTML = `
        ${badgeHTML}
        ${comment.title ? `<span class="adopted-title">${escapeHtml(comment.title)}</span>` : ''}
      `;
    }

    const escapeHtml = this.prManager?.escapeHtml?.bind(this.prManager) || ((s) => s);

    // Choose icon based on comment origin (AI-adopted vs user-originated)
    const commentIcon = comment.parent_id
      ? `<svg class="octicon octicon-comment-ai" viewBox="0 0 16 16" width="16" height="16">
           <path d="M7.75 1a.75.75 0 0 1 0 1.5h-5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2c.199 0 .39.079.53.22.141.14.22.331.22.53v2.19l2.72-2.72a.747.747 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-2a.75.75 0 0 1 1.5 0v2c0 .464-.184.909-.513 1.237A1.746 1.746 0 0 1 13.25 12H9.06l-2.573 2.573A1.457 1.457 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5C1 1.784 1.784 1 2.75 1h5Zm4.519-.837a.248.248 0 0 1 .466 0l.238.648a3.726 3.726 0 0 0 2.218 2.219l.649.238a.249.249 0 0 1 0 .467l-.649.238a3.725 3.725 0 0 0-2.218 2.218l-.238.649a.248.248 0 0 1-.466 0l-.239-.649a3.725 3.725 0 0 0-2.218-2.218l-.649-.238a.249.249 0 0 1 0-.467l.649-.238A3.726 3.726 0 0 0 12.03.811l.239-.648Z"/>
         </svg>`
      : `<svg class="octicon octicon-person" viewBox="0 0 16 16" width="16" height="16">
           <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
         </svg>`;

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
          <span class="user-comment-timestamp">${new Date(comment.created_at).toLocaleString()}</span>
          <div class="user-comment-actions">
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
      ? `<svg class="octicon octicon-comment-ai" viewBox="0 0 16 16" width="16" height="16">
           <path d="M7.75 1a.75.75 0 0 1 0 1.5h-5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2c.199 0 .39.079.53.22.141.14.22.331.22.53v2.19l2.72-2.72a.747.747 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-2a.75.75 0 0 1 1.5 0v2c0 .464-.184.909-.513 1.237A1.746 1.746 0 0 1 13.25 12H9.06l-2.573 2.573A1.457 1.457 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5C1 1.784 1.784 1 2.75 1h5Zm4.519-.837a.248.248 0 0 1 .466 0l.238.648a3.726 3.726 0 0 0 2.218 2.219l.649.238a.249.249 0 0 1 0 .467l-.649.238a3.725 3.725 0 0 0-2.218 2.218l-.238.649a.248.248 0 0 1-.466 0l-.239-.649a3.725 3.725 0 0 0-2.218-2.218l-.649-.238a.249.249 0 0 1 0-.467l.649-.238A3.726 3.726 0 0 0 12.03.811l.239-.648Z"/>
         </svg>`
      : `<svg class="octicon octicon-person" viewBox="0 0 16 16" width="16" height="16">
           <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
         </svg>`;

    const commentHTML = `
      <div class="user-comment editing-mode ${comment.parent_id ? 'adopted-comment comment-ai-origin' : 'comment-user-origin'}">
        <div class="user-comment-header">
          <span class="comment-origin-icon">
            ${commentIcon}
          </span>
          <span class="user-comment-line-info">${lineInfo}</span>
          ${comment.type === 'praise' ? `<span class="adopted-praise-badge" title="Nice Work"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>Nice Work</span>` : ''}
          ${comment.title ? `<span class="adopted-title">${escapeHtml(comment.title)}</span>` : ''}
          <span class="user-comment-timestamp">Editing comment...</span>
          <div class="user-comment-actions">
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
        <!-- Hidden body div for saving - pre-populate with markdown rendered content and store original -->
        <div class="user-comment-body" style="display: none;" data-original-markdown="${window.escapeHtmlAttribute(comment.body)}">${window.renderMarkdown ? window.renderMarkdown(comment.body) : escapeHtml(comment.body)}</div>
        <div class="user-comment-edit-form">
          <div class="comment-form-toolbar">
            <button type="button" class="btn btn-sm suggestion-btn" title="Insert a suggestion (Ctrl+G)">
              ${CommentManager.SUGGESTION_ICON_SVG}
            </button>
          </div>
          <textarea
            id="edit-comment-${comment.id}"
            class="comment-edit-textarea"
            placeholder="Enter your comment..."
            data-file="${comment.file}"
            data-line="${comment.line_start}"
            data-line-end="${comment.line_end || comment.line_start}"
            ${comment.side ? `data-side="${comment.side}"` : ''}
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
