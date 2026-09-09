// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * CommentManager - Comment UI handling
 * Handles comment forms, editing, saving, deletion, and display.
 */

/**
 * The shared saved-comment presentation contract (see
 * `public/js/modules/user-comment-view.js`). Resolved lazily so this file
 * works both as a classic browser script (where user-comment-view.js is
 * loaded first and installs `window.UserCommentView`) and under CommonJS in
 * unit tests.
 *
 * Declared as a file-unique `const`, NOT a plain `function`: a top-level
 * `function` declaration in a classic script becomes a property of `window`,
 * so a second module declaring the same helper name would silently shadow
 * this one (load order decides which definition every caller here gets).
 * The name is namespaced to this file for the same reason — pierre-bridge.js
 * needs the identical lookup and must not collide with it.
 *
 * FAIL CLOSED IN THE BROWSER: `require` does not exist there, so a missing
 * `<script src="/js/modules/user-comment-view.js">` used to surface as
 * `ReferenceError: require is not defined` from deep inside comment
 * rendering. Throw a message that names the actual problem instead.
 * @returns {object}
 */
const _commentManagerUserCommentView = () => {
  if (typeof window !== 'undefined' && window.UserCommentView) return window.UserCommentView;
  // CommonJS (unit tests / any non-browser consumer).
  if (typeof module !== 'undefined' && typeof require === 'function') {
    // eslint-disable-next-line no-undef, global-require
    return require('./user-comment-view.js');
  }
  throw new Error(
    '[CommentManager] UserCommentView is unavailable: load '
    + 'public/js/modules/user-comment-view.js before comment-manager.js'
  );
};

class CommentManager {
  /**
   * Shared SVG icon for the suggestion button.
   * Uses the GitHub Primer file-diff-16 octicon.
   */
  static SUGGESTION_ICON_SVG = `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
    <path d="M1 1.75C1 .784 1.784 0 2.75 0h7.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073ZM8 3.25a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5h-1.5v1.5a.75.75 0 0 1-1.5 0V7h-1.5a.75.75 0 0 1 0-1.5h1.5V4A.75.75 0 0 1 8 3.25Zm-3 8a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Z"></path>
  </svg>`;

  /**
   * The saved-comment shells whose `.btn-chat-comment` this manager's
   * delegated handler owns. `.user-comment-row` is the Diff surface (both
   * engines); `.rendered-markdown-comment-card` is the Rendered Markdown
   * placement adapter, which carries the same canonical `.user-comment`
   * fragment but no Diff row. Deliberately explicit — see the constructor.
   */
  static CHAT_SCOPE_SELECTORS = ['.user-comment-row', '.rendered-markdown-comment-card'];

  constructor(prManagerRef) {
    // Reference to parent PRManager for API calls and state access
    this.prManager = prManagerRef;
    // Current comment form element
    this.currentCommentForm = null;

    // Event delegation for "Ask about this" chat button on user comments.
    //
    // Scoped to the two SAVED-comment shells that carry the canonical
    // `.user-comment` fragment: the Diff row (legacy `<tr>` or the
    // light-DOM div PierreBridge slots into @pierre/diffs) and the Rendered
    // Markdown placement card. Both are listed explicitly rather than
    // matching a bare `.btn-chat-comment`, because FileCommentManager runs
    // its own delegated handler for `.file-comments-zone .btn-chat-comment`
    // and ExternalCommentManager wires its buttons directly — a broader
    // selector here would open the chat panel twice for one click.
    // The two scopes are mutually exclusive containers (a Rendered card is
    // never inside a `.user-comment-row`, and vice versa), so exactly one
    // matches per click.
    document.addEventListener('click', (e) => {
      // One `<scope> .btn-chat-comment` clause per scope, built by mapping
      // the scopes rather than by joining them with a separator that has to
      // repeat the descendant suffix — with a join the LAST scope's suffix is
      // written separately from the others', so adding a third scope, or
      // changing the button class, silently leaves one clause behind.
      const chatBtn = e.target.closest(
        CommentManager.CHAT_SCOPE_SELECTORS.map((scope) => `${scope} .btn-chat-comment`).join(', ')
      );
      if (chatBtn && window.chatPanel) {
        e.stopPropagation();
        const commentRow = chatBtn.closest(CommentManager.CHAT_SCOPE_SELECTORS.join(', '));
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
          <button class="ai-action ai-action-chat btn-chat-from-comment" title="Chat about these lines">
            <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>
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
    // Try PierreBridge first (for @pierre/diffs rendered files)
    const bridge = this.prManager?.pierreBridge;
    if (bridge && bridge.files.has(fileName)) {
      const code = bridge.getCodeFromLines(fileName, startLine, endLine, side);
      if (code !== null) return code;
    }

    // Legacy path: DOM query for diff2html table rows
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

      // Record the comment in PRManager's authoritative `userComments` and
      // refresh any live Rendered-Markdown view of this file. Uses the
      // existing `this.prManager` delegate seam (the same one the
      // updateCommentCount / lineTracker calls below already go through) —
      // persistence stays here, PRManager only consumes the result, so
      // there is exactly one create request and one source of truth.
      // Optional-chained because several unit tests construct a
      // CommentManager with a partial prManager stub.
      this.prManager?.registerCreatedUserComment?.(commentData);

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

      // Refresh minimize-mode indicators so the new comment is reflected
      if (window.prManager?.commentMinimizer) {
        window.prManager.commentMinimizer.refreshIndicators();
        // Auto-expand so the new comment stays visible in minimize mode
        const newRow = document.querySelector(`.user-comment-row[data-comment-id="${commentData.id}"]`);
        if (newRow) {
          window.prManager.commentMinimizer.expandForElement(newRow);
        }
      }

      window.chatPanel?.queueUserActionHint(`[User Action: created comment ${result.commentId}]`);

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

    // Canonical presentation: the shared `.user-comment` fragment every
    // surface emits (see modules/user-comment-view.js). This surface keeps
    // the Diff action mode, whose edit/dismiss handlers resolve the comment
    // through the `.user-comment-row` created above.
    const commentHTML = _commentManagerUserCommentView().buildCommentHtml(comment, {
      actionMode: 'diff',
      isExpandedContext,
      escapeHtml: this.prManager?.escapeHtml?.bind(this.prManager),
      escapeHtmlAttribute: window.escapeHtmlAttribute,
      renderMarkdown: window.renderMarkdown
    });

    td.innerHTML = commentHTML;
    commentRow.appendChild(td);

    // Insert comment after the target row
    targetRow.parentNode.insertBefore(commentRow, targetRow.nextSibling);
  }

  /**
   * SVG icons for comment origin display.
   *
   * Getters (not static fields) so they resolve through the shared
   * `UserCommentView.ICONS` at ACCESS time rather than at class-definition
   * time — this file is a classic script and must not depend on
   * user-comment-view.js having executed first. Kept on CommentManager
   * because FileCommentManager and RenderedDocumentView already read them
   * from here; there is still exactly one definition of each glyph.
   */
  static get AI_ICON_SVG() {
    return _commentManagerUserCommentView().ICONS.ai;
  }

  static get PERSON_ICON_SVG() {
    return _commentManagerUserCommentView().ICONS.person;
  }

  /**
   * Shared builder for comment/suggestion edit form rows.
   * Builds the DOM, inserts after targetRow, wires common event handling
   * (autoResize, emoji, suggestion button), and returns { formRow, textarea, saveBtn, cancelBtn }.
   * Callers wire their own save/cancel logic on the returned elements.
   * NOTE: similar edit form in pr.js editUserComment — keep in sync
   * @private
   */
  _buildEditFormRow(targetRow, {
    rowClassName, rowDataset, iconHtml, originClass, lineInfo,
    type, title, body, bodyHtml, textareaId, placeholder,
    dataAttrs, saveLabel
  }) {
    const formRow = document.createElement('tr');
    formRow.className = rowClassName;
    Object.assign(formRow.dataset, rowDataset);

    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'user-comment-cell';

    const escapeHtml = this.prManager?.escapeHtml?.bind(this.prManager) || ((s) => s);

    const html = `
      <div class="user-comment editing-mode ${originClass}">
        <div class="user-comment-header">
          <div class="user-comment-header-left">
            <span class="comment-origin-icon">
              ${iconHtml}
            </span>
            <span class="user-comment-line-info">${lineInfo}</span>
            ${type === 'praise' ? `<span class="adopted-praise-badge" title="Nice Work">${_commentManagerUserCommentView().ICONS.praise}Nice Work</span>` : ''}
            ${title ? `<span class="adopted-title">${escapeHtml(title)}</span>` : ''}
          </div>
        </div>
        ${bodyHtml || ''}
        <div class="user-comment-edit-form">
          <div class="comment-form-toolbar">
            <button type="button" class="btn btn-sm suggestion-btn" title="Insert a suggestion (Ctrl+G)">
              ${CommentManager.SUGGESTION_ICON_SVG}
            </button>
          </div>
          <textarea
            ${textareaId ? `id="${textareaId}"` : ''}
            class="comment-edit-textarea"
            placeholder="${placeholder}"
            data-file="${window.escapeHtmlAttribute ? window.escapeHtmlAttribute(dataAttrs.file) : dataAttrs.file}"
            data-line="${dataAttrs.line}"
            data-line-end="${dataAttrs.lineEnd}"
            data-side="${dataAttrs.side}"
          >${escapeHtml(body)}</textarea>
          <div class="comment-edit-actions">
            <button class="btn btn-sm btn-primary save-edit-btn">${saveLabel}</button>
            <button class="btn btn-sm btn-secondary cancel-edit-btn">Cancel</button>
          </div>
        </div>
      </div>
    `;

    td.innerHTML = html;
    formRow.appendChild(td);

    if (targetRow.nextSibling) {
      targetRow.parentNode.insertBefore(formRow, targetRow.nextSibling);
    } else {
      targetRow.parentNode.appendChild(formRow);
    }

    const textarea = textareaId
      ? document.getElementById(textareaId)
      : formRow.querySelector('.comment-edit-textarea');
    const suggestionBtn = formRow.querySelector('.suggestion-btn');
    const saveBtn = formRow.querySelector('.save-edit-btn');
    const cancelBtn = formRow.querySelector('.cancel-edit-btn');

    if (textarea) {
      this.autoResizeTextarea(textarea);
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);

      if (window.emojiPicker) {
        window.emojiPicker.attach(textarea);
      }

      this.updateSuggestionButtonState(textarea, suggestionBtn);

      suggestionBtn.addEventListener('click', () => {
        if (!suggestionBtn.disabled) {
          this.insertSuggestionBlock(textarea, suggestionBtn);
        }
      });

      textarea.addEventListener('input', () => {
        this.autoResizeTextarea(textarea);
        this.updateSuggestionButtonState(textarea, suggestionBtn);
      });

      // Keyboard shortcuts (Escape, Cmd/Ctrl+Enter) are handled by delegated
      // event listener in setupCommentFormDelegation() to avoid memory leaks
    }

    return { formRow, textarea, saveBtn, cancelBtn };
  }

  /**
   * Display a user comment in edit mode (for adopted suggestions)
   * @param {Object} comment - Comment data
   * @param {HTMLElement} targetRow - Row to insert after
   */
  displayUserCommentInEditMode(comment, targetRow) {
    const lineInfo = comment.line_end && comment.line_end !== comment.line_start
      ? `Lines ${comment.line_start}-${comment.line_end}`
      : `Line ${comment.line_start}`;

    const escapeHtml = this.prManager?.escapeHtml?.bind(this.prManager) || ((s) => s);
    const bodyHtml = `<div class="user-comment-body" style="display: none;" data-original-markdown="${window.escapeHtmlAttribute(comment.body)}">${window.renderMarkdown ? window.renderMarkdown(comment.body) : escapeHtml(comment.body)}</div>`;

    const rowDataset = { commentId: comment.id, file: comment.file, lineStart: comment.line_start, lineEnd: comment.line_end || comment.line_start };
    if (comment.side) rowDataset.side = comment.side;

    const { saveBtn, cancelBtn } = this._buildEditFormRow(targetRow, {
      rowClassName: 'user-comment-row',
      rowDataset,
      iconHtml: comment.parent_id ? CommentManager.AI_ICON_SVG : CommentManager.PERSON_ICON_SVG,
      originClass: comment.parent_id ? 'adopted-comment comment-ai-origin' : 'comment-user-origin',
      lineInfo,
      type: comment.type,
      title: comment.title,
      body: comment.body,
      bodyHtml,
      textareaId: `edit-comment-${comment.id}`,
      placeholder: 'Enter your comment...',
      dataAttrs: {
        file: comment.file,
        line: comment.line_start,
        lineEnd: comment.line_end || comment.line_start,
        side: comment.side || 'RIGHT'
      },
      saveLabel: 'Save'
    });

    saveBtn.addEventListener('click', () => this.prManager?.saveEditedUserComment(comment.id));
    cancelBtn.addEventListener('click', () => this.prManager?.cancelEditUserComment(comment.id));
  }

  /**
   * Display an edit form for an AI suggestion that has NOT yet been adopted.
   * Nothing is saved until the user clicks Save/Adopt.
   * @param {Object} suggestion - { id, body, type, title, file, lineNumber, diffPosition, side }
   * @param {HTMLElement} targetRow - The suggestion row to insert the form after
   * @param {Function} onSave - Called with (editedText) when user clicks Save
   * @param {Function} onCancel - Called when user clicks Cancel
   */
  displaySuggestionEditForm(suggestion, targetRow, onSave, onCancel) {
    // Remove any existing pending edit form (prevents stale multi-form state)
    const existing = document.querySelector('.suggestion-edit-pending');
    if (existing) existing.remove();

    const { formRow, saveBtn, cancelBtn } = this._buildEditFormRow(targetRow, {
      rowClassName: 'user-comment-row suggestion-edit-pending',
      rowDataset: { suggestionId: suggestion.id },
      iconHtml: CommentManager.AI_ICON_SVG,
      originClass: 'adopted-comment comment-ai-origin',
      lineInfo: suggestion.lineEnd && suggestion.lineEnd !== suggestion.lineNumber
        ? `Lines ${suggestion.lineNumber}-${suggestion.lineEnd}`
        : `Line ${suggestion.lineNumber}`,
      type: suggestion.type,
      title: suggestion.title,
      body: suggestion.body,
      placeholder: 'Edit the suggestion...',
      dataAttrs: {
        file: suggestion.file,
        line: suggestion.lineNumber,
        lineEnd: suggestion.lineEnd || suggestion.lineNumber,
        side: suggestion.side || 'RIGHT'
      },
      saveLabel: 'Save'
    });

    saveBtn.addEventListener('click', async () => {
      const textarea = formRow.querySelector('.comment-edit-textarea');
      const text = textarea?.value.trim();
      if (text) {
        saveBtn.disabled = true;
        try {
          await onSave(text);
          formRow.remove();
        } catch (err) {
          saveBtn.disabled = false;
        }
      }
    });

    cancelBtn.addEventListener('click', () => {
      formRow.remove();
      onCancel();
    });

    return formRow;
  }
}

// Make CommentManager available globally
window.CommentManager = CommentManager;

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CommentManager };
}
