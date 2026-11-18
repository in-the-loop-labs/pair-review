// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * CommentManager - Helpers of the comment forms.
 * The forms and cards themselves are annotations of the diff viewer
 * (pierre-annotations.js); this module holds what they share with the
 * edit form of a card (PRManager.editUserComment): the suggestion block,
 * the textarea's auto-resize, and the "Ask about this" button of a card.
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
    // The viewer's bridge reads the lines from the file's parsed diff, one
    // side only (a modified line has an OLD and a NEW version).
    const bridge = this.prManager?.pierreBridge;
    if (!bridge || !bridge.files.has(fileName)) return '';
    const code = bridge.getCodeFromLines(fileName, startLine, endLine, side);
    return code !== null ? code : '';
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

  /** SVG icons for comment origin display */
  static AI_ICON_SVG = `<svg class="octicon octicon-comment-ai" viewBox="0 0 16 16" width="16" height="16">
    <path d="M7.75 1a.75.75 0 0 1 0 1.5h-5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2c.199 0 .39.079.53.22.141.14.22.331.22.53v2.19l2.72-2.72a.747.747 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-2a.75.75 0 0 1 1.5 0v2c0 .464-.184.909-.513 1.237A1.746 1.746 0 0 1 13.25 12H9.06l-2.573 2.573A1.457 1.457 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5C1 1.784 1.784 1 2.75 1h5Zm4.519-.837a.248.248 0 0 1 .466 0l.238.648a3.726 3.726 0 0 0 2.218 2.219l.649.238a.249.249 0 0 1 0 .467l-.649.238a3.725 3.725 0 0 0-2.218 2.218l-.238.649a.248.248 0 0 1-.466 0l-.239-.649a3.725 3.725 0 0 0-2.218-2.218l-.649-.238a.249.249 0 0 1 0-.467l.649-.238A3.726 3.726 0 0 0 12.03.811l.239-.648Z"/>
  </svg>`;

  static PERSON_ICON_SVG = `<svg class="octicon octicon-person" viewBox="0 0 16 16" width="16" height="16">
    <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
  </svg>`;
}

// Make CommentManager available globally
window.CommentManager = CommentManager;

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CommentManager };
}
