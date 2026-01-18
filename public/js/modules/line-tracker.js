/**
 * LineTracker - Line number mapping, range selection, and highlighting
 * Handles line number extraction, range selection for multi-line comments,
 * and line highlighting for the diff view.
 */

class LineTracker {
  constructor() {
    // Line range selection state
    this.rangeSelectionStart = null;
    this.rangeSelectionEnd = null;
    this.isDraggingRange = false;
    this.dragStartLine = null;
    this.dragEndLine = null;
    this.potentialDragStart = null;
    // Global mouseup handler reference for cleanup
    this.handleGlobalMouseUp = null;
  }

  /**
   * Get the line number from a diff row
   * Handles both added/context lines (new line numbers) and deleted lines (old line numbers).
   *
   * When side is specified:
   * - 'LEFT': Returns the OLD line number (for deleted lines or context lines in OLD coordinate system)
   * - 'RIGHT': Returns the NEW line number (for added lines or context lines in NEW coordinate system)
   *
   * When side is not specified (default behavior):
   * - Returns dataset.lineNumber which is the primary line number for the row's type
   * - For deleted lines: returns oldNumber
   * - For added/context lines: returns newNumber
   *
   * Priority order:
   * 1. dataset.lineNumber (or oldLineNumber/newLineNumber based on side)
   * 2. .line-num2: new line numbers for added/context lines
   * 3. .line-num1: old line numbers for deleted lines
   * 4. Nested selectors as fallback
   * @param {Element} row - Table row element
   * @param {string} [side] - Optional side ('LEFT' or 'RIGHT') to get specific coordinate system
   * @returns {number|null} The line number or null if not found
   */
  getLineNumber(row, side) {
    // If a specific side is requested, use the appropriate line number
    if (side === 'LEFT') {
      // LEFT side: use old line number
      // Check data-old-line-number first (available on deleted lines and context lines)
      if (row.dataset?.oldLineNumber) {
        const oldNum = parseInt(row.dataset.oldLineNumber);
        if (!isNaN(oldNum)) return oldNum;
      }
      // Fallback to .line-num1 span
      const lineNum1 = row.querySelector('.line-num1')?.textContent?.trim();
      if (lineNum1) return parseInt(lineNum1);
      return null;
    }

    if (side === 'RIGHT') {
      // RIGHT side: use new line number
      // Check data-new-line-number first (available on added lines and context lines)
      if (row.dataset?.newLineNumber) {
        const newNum = parseInt(row.dataset.newLineNumber);
        if (!isNaN(newNum)) return newNum;
      }
      // Check data-line-number as fallback (for added/context lines, this is the new number)
      if (row.dataset?.lineNumber && row.dataset?.side === 'RIGHT') {
        const datasetNum = parseInt(row.dataset.lineNumber);
        if (!isNaN(datasetNum)) return datasetNum;
      }
      // Fallback to .line-num2 span
      const lineNum2 = row.querySelector('.line-num2')?.textContent?.trim();
      if (lineNum2) return parseInt(lineNum2);
      return null;
    }

    // Default behavior (no side specified): return the row's primary line number
    // Primary: use dataset.lineNumber if available (set during renderDiffLine)
    // This correctly handles both deleted lines (uses oldNumber) and added/context lines (uses newNumber)
    if (row.dataset?.lineNumber) {
      const datasetNum = parseInt(row.dataset.lineNumber);
      if (!isNaN(datasetNum)) return datasetNum;
    }

    // Fallback: check span elements
    // For added/context lines, check .line-num2 (new line number)
    let lineNum = row.querySelector('.line-num2')?.textContent?.trim();
    if (lineNum) return parseInt(lineNum);

    // For deleted lines, check .line-num1 (old line number)
    lineNum = row.querySelector('.line-num1')?.textContent?.trim();
    if (lineNum) return parseInt(lineNum);

    // Alternative: .line-num-new
    lineNum = row.querySelector('.line-num-new')?.textContent?.trim();
    if (lineNum) return parseInt(lineNum);

    // Nested: inside .d2h-code-linenumber container
    const lineNumCell = row.querySelector('.d2h-code-linenumber');
    if (lineNumCell) {
      const lineNum2 = lineNumCell.querySelector('.line-num2');
      if (lineNum2) {
        lineNum = lineNum2.textContent?.trim();
        if (lineNum) return parseInt(lineNum);
      }
    }

    return null;
  }

  /**
   * Build a set of visible line numbers for a file element
   * This is more efficient than checking each line individually when processing multiple suggestions
   * @param {Element} fileElement - The file wrapper element
   * @returns {Set<number>} Set of visible line numbers
   */
  buildVisibleLinesSet(fileElement) {
    const visibleLines = new Set();
    const lineRows = fileElement.querySelectorAll('tr');

    for (const row of lineRows) {
      const lineNum = this.getLineNumber(row);
      if (lineNum !== null) {
        visibleLines.add(lineNum);
      }
    }

    return visibleLines;
  }

  /**
   * Start line range selection
   * @param {HTMLElement} row - The starting row
   * @param {number} lineNumber - The line number
   * @param {string} fileName - The file name
   * @param {string} side - The side ('LEFT' or 'RIGHT')
   */
  startRangeSelection(row, lineNumber, fileName, side = 'RIGHT') {
    // Clear any existing selection
    this.clearRangeSelection();

    // Set start of range (including side for GitHub API)
    this.rangeSelectionStart = {
      row: row,
      lineNumber: lineNumber,
      fileName: fileName,
      side: side
    };

    // Add visual indicator
    row.classList.add('line-range-start');
  }

  /**
   * Complete line range selection
   * @param {HTMLElement} endRow - The ending row
   * @param {number} endLineNumber - The ending line number
   * @param {string} fileName - The file name
   * @param {Function} showCommentFormCallback - Callback to show comment form
   */
  completeRangeSelection(endRow, endLineNumber, fileName, showCommentFormCallback) {
    if (!this.rangeSelectionStart) return;

    // Ensure we're in the same file
    if (this.rangeSelectionStart.fileName !== fileName) {
      alert('Cannot select range across different files');
      this.clearRangeSelection();
      return;
    }

    const startLine = this.rangeSelectionStart.lineNumber;
    const endLine = endLineNumber;

    // Ensure start is before end
    const minLine = Math.min(startLine, endLine);
    const maxLine = Math.max(startLine, endLine);

    // Highlight all rows in range (pass side to avoid highlighting both deleted and added lines with same line number)
    const side = this.rangeSelectionStart.side;
    this.highlightLineRange(this.rangeSelectionStart.row, endRow, fileName, minLine, maxLine, side);

    // Store end of range
    this.rangeSelectionEnd = {
      row: endRow,
      lineNumber: endLineNumber,
      fileName: fileName
    };

    // Get diff position from the end row (GitHub uses position at end of range)
    const diffPosition = endRow.dataset.diffPosition;

    if (showCommentFormCallback) {
      showCommentFormCallback(endRow, minLine, fileName, diffPosition, maxLine, side || 'RIGHT');
    }
  }

  /**
   * Highlight all lines in a range
   * @param {HTMLElement} startRow - The starting row element
   * @param {HTMLElement} endRow - The ending row element
   * @param {string} fileName - The file name
   * @param {number} minLine - The minimum line number
   * @param {number} maxLine - The maximum line number
   * @param {string} side - The side of the diff ('LEFT' for deleted lines, 'RIGHT' for added/context)
   */
  highlightLineRange(startRow, endRow, fileName, minLine, maxLine, side) {
    // Find all rows in the file between minLine and maxLine
    const fileWrapper = startRow.closest('.d2h-file-wrapper');
    if (!fileWrapper) return;

    const allRows = fileWrapper.querySelectorAll('tr[data-line-number]');

    allRows.forEach(row => {
      const lineNum = parseInt(row.dataset.lineNumber);
      const rowSide = row.dataset.side || 'RIGHT';
      // Match by line number range, file name, and side
      // This prevents deleted lines (LEFT) from matching added/context lines (RIGHT) with same line number
      if (lineNum >= minLine && lineNum <= maxLine &&
          row.dataset.fileName === fileName &&
          rowSide === side) {
        row.classList.add('line-range-selected');
      }
    });
  }

  /**
   * Clear line range selection
   */
  clearRangeSelection() {
    // Remove all selection highlights
    document.querySelectorAll('.line-range-start, .line-range-selected').forEach(row => {
      row.classList.remove('line-range-start', 'line-range-selected');
    });

    // Clean up global listener if it exists
    if (this.handleGlobalMouseUp) {
      document.removeEventListener('mouseup', this.handleGlobalMouseUp);
      this.handleGlobalMouseUp = null;
    }

    // Clear state
    this.rangeSelectionStart = null;
    this.rangeSelectionEnd = null;
    this.isDraggingRange = false;
    this.dragStartLine = null;
    this.dragEndLine = null;
    this.potentialDragStart = null;
  }

  /**
   * Start drag selection
   * @param {HTMLElement} row - The starting row
   * @param {number} lineNumber - The line number
   * @param {string} fileName - The file name
   * @param {string} side - The side ('LEFT' or 'RIGHT')
   */
  startDragSelection(row, lineNumber, fileName, side = 'RIGHT') {
    // Clear any existing selection and ensure cleanup
    this.clearRangeSelection();

    // Set dragging state
    this.isDraggingRange = true;
    this.dragStartLine = lineNumber;
    this.dragEndLine = lineNumber;

    // Set start of range, including side for GitHub API
    this.rangeSelectionStart = {
      row: row,
      lineNumber: lineNumber,
      fileName: fileName,
      side: side
    };

    // Add visual indicator
    row.classList.add('line-range-selected');

    // Add global mouse up handler to catch mouseup outside of line numbers
    // Store as bound function for reliable cleanup
    this.handleGlobalMouseUp = (e) => {
      if (this.isDraggingRange) {
        this.completeDragSelection(row, this.dragEndLine || lineNumber, fileName);
      }
    };
    document.addEventListener('mouseup', this.handleGlobalMouseUp);
  }

  /**
   * Update drag selection as mouse moves
   * @param {HTMLElement} row - The current row
   * @param {number} lineNumber - The current line number
   * @param {string} fileName - The file name
   */
  updateDragSelection(row, lineNumber, fileName) {
    if (!this.isDraggingRange || !this.rangeSelectionStart) return;

    // Ensure we're in the same file
    if (this.rangeSelectionStart.fileName !== fileName) return;

    // Update end line
    this.dragEndLine = lineNumber;

    // Update end of range
    this.rangeSelectionEnd = {
      row: row,
      lineNumber: lineNumber,
      fileName: fileName
    };

    // Clear existing highlights
    document.querySelectorAll('.line-range-selected').forEach(r => {
      r.classList.remove('line-range-selected');
    });

    // Highlight all rows in range (pass side to avoid highlighting both deleted and added lines with same line number)
    const minLine = Math.min(this.dragStartLine, lineNumber);
    const maxLine = Math.max(this.dragStartLine, lineNumber);
    const side = this.rangeSelectionStart.side;
    this.highlightLineRange(this.rangeSelectionStart.row, row, fileName, minLine, maxLine, side);
  }

  /**
   * Complete drag selection
   * @param {HTMLElement} row - The ending row
   * @param {number} lineNumber - The ending line number
   * @param {string} fileName - The file name
   */
  completeDragSelection(row, lineNumber, fileName) {
    if (!this.isDraggingRange) return;

    try {
      // Update end of range
      this.rangeSelectionEnd = {
        row: row,
        lineNumber: lineNumber,
        fileName: fileName
      };

      // If we have a valid range (more than one line), keep selection
      const minLine = Math.min(this.dragStartLine, this.dragEndLine);
      const maxLine = Math.max(this.dragStartLine, this.dragEndLine);

      if (minLine === maxLine) {
        // Single line - clear selection
        this.clearRangeSelection();
      } else {
        // Multi-line - keep selection for user to click + button
        // The selection stays highlighted until they click a comment button or clear it
      }
    } finally {
      // Always clean up the global listener and dragging state
      if (this.handleGlobalMouseUp) {
        document.removeEventListener('mouseup', this.handleGlobalMouseUp);
        this.handleGlobalMouseUp = null;
      }
      this.isDraggingRange = false;
    }
  }

  /**
   * Check if there is an active range selection
   * @returns {boolean} True if there is an active range selection
   */
  hasActiveSelection() {
    return this.rangeSelectionStart !== null && this.rangeSelectionEnd !== null;
  }

  /**
   * Get the current selection range
   * @returns {{ start: number, end: number, fileName: string, side: string }|null}
   */
  getSelectionRange() {
    if (!this.hasActiveSelection()) return null;

    const minLine = Math.min(this.rangeSelectionStart.lineNumber, this.rangeSelectionEnd.lineNumber);
    const maxLine = Math.max(this.rangeSelectionStart.lineNumber, this.rangeSelectionEnd.lineNumber);

    return {
      start: minLine,
      end: maxLine,
      fileName: this.rangeSelectionStart.fileName,
      side: this.rangeSelectionStart.side
    };
  }
}

// Make LineTracker available globally
window.LineTracker = LineTracker;
