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
          <span class="comment-icon">Comment</span>
          <span class="comment-title">Add comment</span>
          ${isRange ? `<span class="line-range-indicator">${lineRangeText}</span>` : ''}
        </div>
        ${expandedContextWarning}
        <div class="comment-form-toolbar">
          <button type="button" class="btn btn-sm suggestion-btn" title="Insert a suggestion">
            <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
              <path fill-rule="evenodd" d="M14.064 0a8.75 8.75 0 00-6.187 2.563l-.459.458c-.314.314-.616.641-.904.979H3.31a1.75 1.75 0 00-1.49.833L.11 7.607a.75.75 0 00.418 1.11l3.102.954c.037.051.079.1.124.145l2.429 2.428c.046.046.094.088.145.125l.954 3.102a.75.75 0 001.11.418l2.774-1.707a1.75 1.75 0 00.833-1.49V9.485c.338-.288.665-.59.979-.904l.458-.459A8.75 8.75 0 0016 1.936V1.75A1.75 1.75 0 0014.25 0h-.186zM10.5 10.625c-.088.06-.177.118-.266.175l-2.35 1.521.548 1.783 1.949-1.2a.25.25 0 00.119-.213v-2.066zM3.678 8.116L5.2 5.766c.058-.09.117-.178.176-.266H3.31a.25.25 0 00-.213.119l-1.2 1.95 1.782.547zm5.26-4.493A7.25 7.25 0 0114.063 1.5h.186a.25.25 0 01.25.25v.186a7.25 7.25 0 01-2.123 5.127l-.459.458a15.21 15.21 0 01-2.499 2.02l-2.317 1.5-2.143-2.143 1.5-2.317a15.25 15.25 0 012.02-2.5l.458-.458h.002zM12 5a1 1 0 11-2 0 1 1 0 012 0zm-8.44 9.56a1.5 1.5 0 10-2.12-2.12c-.734.73-1.047 2.332-1.15 3.003a.23.23 0 00.265.265c.671-.103 2.273-.416 3.005-1.148z"></path>
            </svg>
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
          <button class="btn btn-sm btn-primary save-comment-btn">Save</button>
          <button class="btn btn-sm btn-secondary cancel-comment-btn">Cancel</button>
          <span class="draft-indicator">Draft saved</span>
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

    // Auto-save on input, auto-resize textarea, and update suggestion button state
    textarea.addEventListener('input', () => {
      this.autoSaveComment(textarea);
      this.autoResizeTextarea(textarea);
      this.updateSuggestionButtonState(textarea, suggestionBtn);
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
   * Auto-save comment draft
   * @param {HTMLTextAreaElement} textarea - The textarea element
   */
  autoSaveComment(textarea) {
    const fileName = textarea.dataset.file;
    const lineNumber = textarea.dataset.line;
    const content = textarea.value.trim();

    if (!content) return;

    // Save to localStorage as draft
    const prNumber = this.prManager?.currentPR?.number;
    const draftKey = `draft_${prNumber}_${fileName}_${lineNumber}`;
    localStorage.setItem(draftKey, content);

    // Show draft indicator
    const indicator = textarea.closest('.user-comment-form, .user-comment')?.querySelector('.draft-indicator');
    if (indicator) {
      indicator.style.display = 'inline';
      setTimeout(() => {
        indicator.style.display = 'none';
      }, 2000);
    }
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
   * @returns {string} The code content from the lines
   */
  getCodeFromLines(fileName, startLine, endLine) {
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
      if (lineNum >= startLine && lineNum <= endLine && row.dataset.fileName === fileName) {
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

    // Get the code from the selected lines
    const code = this.getCodeFromLines(fileName, startLine, endLine);

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

    if (!content) {
      alert('Please enter a comment');
      return;
    }

    try {
      const prId = this.prManager?.currentPR?.id;
      const headSha = this.prManager?.currentPR?.head_sha;

      const response = await fetch('/api/user-comment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          pr_id: prId,
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

      // Clear draft
      const prNumber = this.prManager?.currentPR?.number;
      const draftKey = `draft_${prNumber}_${fileName}_${lineNumber}`;
      localStorage.removeItem(draftKey);

      // Create comment display row
      this.displayUserComment({
        id: result.commentId,
        file: fileName,
        line_start: lineNumber,
        line_end: endLineNumber,
        diff_position: diffPosition,  // Include for expanded context warning logic
        body: content,
        created_at: new Date().toISOString()
      }, formRow.previousElementSibling);

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
   * @param {Object} comment - Comment data
   * @param {HTMLElement} targetRow - Row to insert after
   */
  displayUserComment(comment, targetRow) {
    const commentRow = document.createElement('tr');
    commentRow.className = 'user-comment-row';
    commentRow.dataset.commentId = comment.id;
    // Store file/line data for editing
    commentRow.dataset.file = comment.file;
    commentRow.dataset.lineStart = comment.line_start;
    commentRow.dataset.lineEnd = comment.line_end || comment.line_start;

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
    const commentHTML = `
      <div class="user-comment ${comment.parent_id ? 'adopted-comment' : ''}">
        <div class="user-comment-header">
          <span class="comment-icon">
            <svg class="octicon octicon-comment" viewBox="0 0 16 16" width="16" height="16">
              <path fill-rule="evenodd" d="M2.75 2.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.75.75 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75zM1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.457 1.457 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z"></path>
            </svg>
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
            <button class="btn-delete-comment" onclick="prManager.deleteUserComment(${comment.id})" title="Delete comment">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19c.9 0 1.652-.681 1.741-1.576l.66-6.6a.75.75 0 00-1.492-.149l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"></path>
              </svg>
            </button>
          </div>
        </div>
        <div class="user-comment-body" data-original-markdown="${escapeHtml(comment.body)}">${window.renderMarkdown ? window.renderMarkdown(comment.body) : escapeHtml(comment.body)}</div>
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
    // Store file/line data for editing
    commentRow.dataset.file = comment.file;
    commentRow.dataset.lineStart = comment.line_start;
    commentRow.dataset.lineEnd = comment.line_end || comment.line_start;

    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'user-comment-cell';

    const lineInfo = comment.line_end && comment.line_end !== comment.line_start
      ? `Lines ${comment.line_start}-${comment.line_end}`
      : `Line ${comment.line_start}`;

    const escapeHtml = this.prManager?.escapeHtml?.bind(this.prManager) || ((s) => s);
    const commentHTML = `
      <div class="user-comment editing-mode ${comment.parent_id ? 'adopted-comment' : ''}">
        <div class="user-comment-header">
          <span class="comment-icon">
            <svg class="octicon octicon-comment" viewBox="0 0 16 16" width="16" height="16">
              <path fill-rule="evenodd" d="M2.75 2.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.75.75 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75zM1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.457 1.457 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z"></path>
            </svg>
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
            <button class="btn-delete-comment" onclick="prManager.deleteUserComment(${comment.id})" title="Delete comment">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19c.9 0 1.652-.681 1.741-1.576l.66-6.6a.75.75 0 00-1.492-.149l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"></path>
              </svg>
            </button>
          </div>
        </div>
        <!-- Hidden body div for saving - pre-populate with markdown rendered content and store original -->
        <div class="user-comment-body" style="display: none;" data-original-markdown="${escapeHtml(comment.body)}">${window.renderMarkdown ? window.renderMarkdown(comment.body) : escapeHtml(comment.body)}</div>
        <div class="user-comment-edit-form">
          <div class="comment-form-toolbar">
            <button type="button" class="btn btn-sm suggestion-btn" title="Insert a suggestion (Ctrl+G)">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M14.064 0a8.75 8.75 0 00-6.187 2.563l-.459.458c-.314.314-.616.641-.904.979H3.31a1.75 1.75 0 00-1.49.833L.11 7.607a.75.75 0 00.418 1.11l3.102.954c.037.051.079.1.124.145l2.429 2.428c.046.046.094.088.145.125l.954 3.102a.75.75 0 001.11.418l2.774-1.707a1.75 1.75 0 00.833-1.49V9.485c.338-.288.665-.59.979-.904l.458-.459A8.75 8.75 0 0016 1.936V1.75A1.75 1.75 0 0014.25 0h-.186zM10.5 10.625c-.088.06-.177.118-.266.175l-2.35 1.521.548 1.783 1.949-1.2a.25.25 0 00.119-.213v-2.066zM3.678 8.116L5.2 5.766c.058-.09.117-.178.176-.266H3.31a.25.25 0 00-.213.119l-1.2 1.95 1.782.547zm5.26-4.493A7.25 7.25 0 0114.063 1.5h.186a.25.25 0 01.25.25v.186a7.25 7.25 0 01-2.123 5.127l-.459.458a15.21 15.21 0 01-2.499 2.02l-2.317 1.5-2.143-2.143 1.5-2.317a15.25 15.25 0 012.02-2.5l.458-.458h.002zM12 5a1 1 0 11-2 0 1 1 0 012 0zm-8.44 9.56a1.5 1.5 0 10-2.12-2.12c-.734.73-1.047 2.332-1.15 3.003a.23.23 0 00.265.265c.671-.103 2.273-.416 3.005-1.148z"></path>
              </svg>
            </button>
          </div>
          <textarea
            id="edit-comment-${comment.id}"
            class="comment-edit-textarea"
            placeholder="Enter your comment..."
            data-file="${comment.file}"
            data-line="${comment.line_start}"
            data-line-end="${comment.line_end || comment.line_start}"
          >${escapeHtml(comment.body)}</textarea>
          <div class="comment-edit-actions">
            <button class="btn btn-sm btn-primary save-edit-btn">
              Save comment
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
