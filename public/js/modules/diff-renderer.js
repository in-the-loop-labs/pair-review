/**
 * DiffRenderer - Diff parsing and line rendering
 * Handles rendering of diff content, syntax highlighting,
 * and diff line display.
 */

class DiffRenderer {
  // Chevron icon for expand/collapse (pointing right when collapsed)
  static CHEVRON_RIGHT_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path fill-rule="evenodd" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/>
    </svg>
  `;

  // Chevron icon pointing down (when expanded)
  static CHEVRON_DOWN_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path fill-rule="evenodd" d="M12.78 6.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 7.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L8 9.94l3.72-3.72a.75.75 0 0 1 1.06 0Z"/>
    </svg>
  `;

  // Eye icon for showing hidden content (GitHub Octicons "eye")
  static EYE_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.831.88 9.577.43 8.899a1.62 1.62 0 0 1 0-1.798c.45-.678 1.367-1.932 2.637-3.023C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.824.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"/>
    </svg>
  `;

  // Eye-closed icon for hiding content (GitHub Octicons "eye-closed")
  static EYE_CLOSED_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M.143 2.31a.75.75 0 0 1 1.047-.167l14.5 10.5a.75.75 0 1 1-.88 1.214l-2.248-1.628C11.346 13.19 9.792 14 8 14c-1.981 0-3.67-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.797c.353-.533 1.063-1.502 2.063-2.487L.31 3.357A.75.75 0 0 1 .143 2.31Zm3.386 3.378a14.21 14.21 0 0 0-1.85 2.244.12.12 0 0 0 0 .136c.412.621 1.242 1.75 2.366 2.717C5.175 11.758 6.527 12.5 8 12.5c1.195 0 2.31-.488 3.29-1.191L9.063 9.695A2 2 0 0 1 6.058 7.52L3.529 5.688Zm6.728 4.873-1.676-1.214a.5.5 0 1 0 .798.59l.878.624ZM8 3.5c-.516 0-1.017.09-1.499.251a.75.75 0 0 1-.473-1.423A6.23 6.23 0 0 1 8 2c1.981 0 3.67.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.11.166-.248.365-.41.587a.75.75 0 1 1-1.21-.887c.148-.201.272-.382.371-.53a.119.119 0 0 0 0-.137c-.412-.621-1.242-1.75-2.366-2.717C10.825 4.242 9.473 3.5 8 3.5Z"/>
    </svg>
  `;

  // Generated file indicator icon (gear/cog icon)
  static GENERATED_FILE_ICON = `
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.585.52a2.678 2.678 0 0 0-3.17 0l-.928.68a1.178 1.178 0 0 1-.518.215L3.83 1.59a2.678 2.678 0 0 0-2.24 2.24l-.175 1.14a1.178 1.178 0 0 1-.215.518l-.68.928a2.678 2.678 0 0 0 0 3.17l.68.928c.113.153.186.33.215.518l.175 1.138a2.678 2.678 0 0 0 2.24 2.24l1.138.175c.187.029.365.102.518.215l.928.68a2.678 2.678 0 0 0 3.17 0l.928-.68a1.17 1.17 0 0 1 .518-.215l1.138-.175a2.678 2.678 0 0 0 2.241-2.241l.175-1.138c.029-.187.102-.365.215-.518l.68-.928a2.678 2.678 0 0 0 0-3.17l-.68-.928a1.179 1.179 0 0 1-.215-.518L14.41 3.83a2.678 2.678 0 0 0-2.24-2.24l-1.138-.175a1.179 1.179 0 0 1-.518-.215L9.585.52ZM7.303 1.728c.415-.305.979-.305 1.394 0l.928.68c.348.256.752.423 1.18.489l1.136.174c.51.078.909.478.987.987l.174 1.137c.066.427.233.831.489 1.18l.68.927c.305.415.305.98 0 1.394l-.68.928a2.678 2.678 0 0 0-.489 1.18l-.174 1.136a1.178 1.178 0 0 1-.987.987l-1.137.174a2.678 2.678 0 0 0-1.18.489l-.927.68c-.415.305-.98.305-1.394 0l-.928-.68a2.678 2.678 0 0 0-1.18-.489l-1.136-.174a1.178 1.178 0 0 1-.987-.987l-.174-1.137a2.678 2.678 0 0 0-.489-1.18l-.68-.927a1.178 1.178 0 0 1 0-1.394l.68-.928c.256-.348.423-.752.489-1.18l.174-1.136c.078-.51.478-.909.987-.987l1.137-.174a2.678 2.678 0 0 0 1.18-.489l.927-.68ZM8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4Z"/>
    </svg>
  `;

  // Map of file extensions to highlight.js language names
  static LANGUAGE_MAP = {
    // JavaScript/TypeScript
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'mjs': 'javascript',
    'cjs': 'javascript',
    // Web
    'html': 'html',
    'htm': 'html',
    'xml': 'xml',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass',
    'less': 'less',
    // Python
    'py': 'python',
    'pyw': 'python',
    // Ruby
    'rb': 'ruby',
    'erb': 'erb',
    // PHP
    'php': 'php',
    // Java/Kotlin/Scala
    'java': 'java',
    'kt': 'kotlin',
    'kts': 'kotlin',
    'scala': 'scala',
    // C/C++
    'c': 'c',
    'h': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'hpp': 'cpp',
    'hh': 'cpp',
    // C#
    'cs': 'csharp',
    // Go
    'go': 'go',
    // Rust
    'rs': 'rust',
    // Swift
    'swift': 'swift',
    // Shell
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    // SQL
    'sql': 'sql',
    // JSON/YAML
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    // Markdown
    'md': 'markdown',
    'markdown': 'markdown',
    // Config files
    'toml': 'toml',
    'ini': 'ini',
    'conf': 'ini',
    // Docker
    'dockerfile': 'dockerfile',
    // Others
    'r': 'r',
    'lua': 'lua',
    'perl': 'perl',
    'pl': 'perl',
    'vim': 'vim'
  };

  /**
   * Detect language from file name for syntax highlighting
   * @param {string} fileName - The file name
   * @returns {string} The highlight.js language name
   */
  static detectLanguage(fileName) {
    if (!fileName) return 'plaintext';
    const extension = fileName.split('.').pop().toLowerCase();
    return DiffRenderer.LANGUAGE_MAP[extension] || 'plaintext';
  }

  /**
   * Escape HTML characters
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  static escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Render a single diff line
   * @param {HTMLElement|DocumentFragment} container - Container to append to
   * @param {Object} line - Diff line data
   * @param {string} fileName - The file name for this diff
   * @param {number} diffPosition - The diff position for GitHub API
   * @param {Object} options - Rendering options
   * @param {Function} options.onCommentButtonClick - Callback for comment button clicks
   * @param {Function} options.onMouseOver - Callback for mouseover events
   * @param {Function} options.onMouseUp - Callback for mouseup events
   * @param {Object} options.lineTracker - LineTracker instance for range selection
   * @returns {HTMLElement} The created row element
   */
  static renderDiffLine(container, line, fileName, diffPosition, options = {}) {
    const row = document.createElement('tr');
    row.className = line.type === 'insert' ? 'd2h-ins' :
                   line.type === 'delete' ? 'd2h-del' :
                   'd2h-cntx';

    // Add data attributes for comment functionality
    // Track side (LEFT for deleted lines, RIGHT for added/context lines) for GitHub API
    if (line.type === 'delete') {
      // Deleted lines: use oldNumber and LEFT side
      row.dataset.lineNumber = line.oldNumber;
      row.dataset.oldLineNumber = line.oldNumber;
      row.dataset.side = 'LEFT';
      row.dataset.fileName = fileName;
      if (diffPosition !== undefined) {
        row.dataset.diffPosition = diffPosition;
      }
    } else if (line.newNumber) {
      // Added/context lines: use newNumber and RIGHT side
      row.dataset.lineNumber = line.newNumber;
      row.dataset.newLineNumber = line.newNumber;
      row.dataset.side = 'RIGHT';
      row.dataset.fileName = fileName;
      if (diffPosition !== undefined) {
        row.dataset.diffPosition = diffPosition;
      }
    }

    // Line numbers
    const lineNumCell = document.createElement('td');
    lineNumCell.className = 'd2h-code-linenumber';

    // Add comment button container to line number cell
    const lineNumContent = document.createElement('div');
    lineNumContent.className = 'line-number-content';
    lineNumContent.innerHTML = `<span class="line-num1">${line.oldNumber || ''}</span><span class="line-num2">${line.newNumber || ''}</span>`;

    // Add comment button for all line types (insert, context, delete)
    // Use newNumber for insert/context, oldNumber for delete
    const lineNumber = line.newNumber || line.oldNumber;
    if (lineNumber && options.onCommentButtonClick) {
      const commentButton = document.createElement('button');
      commentButton.className = 'add-comment-btn';
      commentButton.innerHTML = '+';

      // Lines without diff_position (expanded context) may not be submittable to GitHub
      // GitHub's position-based API only works for lines in the original diff
      const hasDiffPosition = diffPosition !== undefined && diffPosition !== null;
      if (hasDiffPosition) {
        commentButton.title = 'Add comment (drag to select range)';
      } else {
        commentButton.title = 'Add comment (expanded context - may not submit to GitHub)';
        commentButton.classList.add('expanded-context-comment');
      }

      // Track mousedown for drag selection
      commentButton.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();

        const side = line.type === 'delete' ? 'LEFT' : 'RIGHT';
        if (options.lineTracker) {
          options.lineTracker.potentialDragStart = {
            row: row,
            lineNumber: lineNumber,
            fileName: fileName,
            button: commentButton,
            isDeletedLine: line.type === 'delete',
            side: side
          };
        }
      };

      // Handle click (mouseup on same element without drag)
      commentButton.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        options.onCommentButtonClick(e, row, lineNumber, fileName, line);
      };

      lineNumContent.appendChild(commentButton);
    }

    // Add mouseover/mouseup handlers for drag selection
    if (lineNumber && options.lineTracker) {
      // Note: We intentionally do NOT set user-select: none on the row
      // Text selection in code is important for users to copy/paste code snippets
      // The drag-to-select-lines feature uses mousedown on the comment button
      // which already calls e.preventDefault() to prevent text selection interference

      if (options.onMouseOver) {
        row.onmouseover = (e) => options.onMouseOver(e, row, lineNumber, fileName);
      }

      if (options.onMouseUp) {
        row.onmouseup = (e) => options.onMouseUp(e, row, lineNumber, fileName);
      }
    }

    lineNumCell.appendChild(lineNumContent);

    // Content - remove ONLY the first +/- prefix from the raw diff, preserve all other whitespace
    const contentCell = document.createElement('td');
    contentCell.className = 'd2h-code-line-ctn';
    let content = line.content || '';
    // Strip only the first character if it's a diff marker (+, -, or space)
    // This preserves the actual indentation of the code
    if (content.length > 0 && (content[0] === '+' || content[0] === '-' || content[0] === ' ')) {
      content = content.substring(1);
    }

    // Apply syntax highlighting if highlight.js is available
    if (window.hljs && fileName) {
      try {
        const language = DiffRenderer.detectLanguage(fileName);
        const highlighted = window.hljs.highlight(content, { language, ignoreIllegals: true });
        contentCell.innerHTML = highlighted.value;
      } catch (e) {
        // If highlighting fails, fall back to plain text
        console.warn('Syntax highlighting failed:', e);
        contentCell.textContent = content;
      }
    } else {
      contentCell.textContent = content;
    }

    row.appendChild(lineNumCell);
    row.appendChild(contentCell);

    if (container) {
      container.appendChild(row);
    }

    return row;
  }

  /**
   * Create file header element
   * @param {string} filePath - File path
   * @param {Object} options - Header options
   * @param {boolean} [options.isGenerated=false] - Whether file is generated
   * @param {boolean} [options.isExpanded=true] - Whether file is expanded
   * @param {boolean} [options.isViewed=false] - Whether file is marked as viewed
   * @param {Object} [options.generatedInfo] - Info about generated file (insertions, deletions)
   * @param {Object} [options.fileStats] - File stats for collapsed view {insertions, deletions}
   * @param {Function} [options.onToggleCollapse] - Callback for toggling collapse state
   * @param {Function} [options.onToggleViewed] - Callback for toggling viewed state
   * @returns {HTMLElement} File header element
   */
  static createFileHeader(filePath, options = {}) {
    const {
      isGenerated = false,
      isExpanded = true,
      isViewed = false,
      generatedInfo = null,
      fileStats = null,
      onToggleCollapse = null,
      onToggleViewed = null
    } = options;

    const fileHeader = document.createElement('div');
    fileHeader.className = 'd2h-file-header';

    // Chevron toggle button for expand/collapse (all files)
    const chevronBtn = document.createElement('button');
    chevronBtn.className = 'file-collapse-toggle';
    chevronBtn.title = isExpanded ? 'Collapse file' : 'Expand file';
    chevronBtn.innerHTML = isExpanded ? DiffRenderer.CHEVRON_DOWN_ICON : DiffRenderer.CHEVRON_RIGHT_ICON;
    chevronBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onToggleCollapse) onToggleCollapse(filePath);
    });
    fileHeader.appendChild(chevronBtn);

    // Add generated file indicators if applicable
    if (isGenerated) {
      // Add generated badge
      const badge = document.createElement('span');
      badge.className = 'generated-badge';
      badge.textContent = 'Generated file';
      badge.title = 'This file is marked as generated in .gitattributes';
      fileHeader.appendChild(badge);
    }

    // File name
    const fileName = document.createElement('span');
    fileName.className = 'd2h-file-name';
    fileName.textContent = filePath;
    fileHeader.appendChild(fileName);

    // File stats summary (visible in collapsed view)
    const stats = generatedInfo || fileStats;
    if (stats) {
      const statsSummary = document.createElement('span');
      statsSummary.className = 'file-stats-summary';
      statsSummary.innerHTML = `<span class="additions">+${stats.insertions || 0}</span> <span class="deletions">-${stats.deletions || 0}</span>`;
      fileHeader.appendChild(statsSummary);
    }

    // Viewed checkbox (right side)
    const viewedLabel = document.createElement('label');
    viewedLabel.className = 'file-viewed-label';
    viewedLabel.title = 'Mark file as viewed';

    const viewedCheckbox = document.createElement('input');
    viewedCheckbox.type = 'checkbox';
    viewedCheckbox.className = 'file-viewed-checkbox';
    viewedCheckbox.checked = isViewed;
    viewedCheckbox.addEventListener('change', (e) => {
      e.stopPropagation();
      if (onToggleViewed) onToggleViewed(filePath, viewedCheckbox.checked);
    });

    viewedLabel.appendChild(viewedCheckbox);
    viewedLabel.appendChild(document.createTextNode('Viewed'));
    fileHeader.appendChild(viewedLabel);

    // Add click handler to header for collapse toggle (excluding checkbox area)
    fileHeader.addEventListener('click', (e) => {
      // Ignore clicks on the checkbox, label, or chevron button (which has its own handler)
      if (e.target.closest('.file-viewed-label') || e.target.closest('.file-collapse-toggle')) {
        return;
      }
      if (onToggleCollapse) onToggleCollapse(filePath);
    });

    return fileHeader;
  }

  /**
   * Update file header expand/collapse state
   * @param {HTMLElement} header - The file header element
   * @param {boolean} isExpanded - Whether the file is now expanded
   */
  static updateFileHeaderState(header, isExpanded) {
    const chevronBtn = header.querySelector('.file-collapse-toggle');
    if (chevronBtn) {
      chevronBtn.innerHTML = isExpanded ? DiffRenderer.CHEVRON_DOWN_ICON : DiffRenderer.CHEVRON_RIGHT_ICON;
      chevronBtn.title = isExpanded ? 'Collapse file' : 'Expand file';
    }
  }

  /**
   * Update file viewed checkbox state
   * @param {HTMLElement} header - The file header element
   * @param {boolean} isViewed - Whether the file is marked as viewed
   */
  static updateFileViewedState(header, isViewed) {
    const checkbox = header.querySelector('.file-viewed-checkbox');
    if (checkbox) {
      checkbox.checked = isViewed;
    }
  }

  /**
   * Create hunk header row
   * @param {string} header - Raw hunk header string
   * @returns {HTMLElement} The header row element
   */
  static createHunkHeaderRow(header) {
    const headerRow = document.createElement('tr');
    headerRow.className = 'd2h-info';

    // Extract only function context, hide raw @@ syntax
    const functionContext = window.HunkParser ?
      window.HunkParser.extractFunctionContext(header) :
      null;

    // Store function context in data attribute for later visibility checks
    if (functionContext) {
      headerRow.dataset.functionContext = functionContext;
    }

    const headerContent = functionContext
      ? `<span class="hunk-context-icon" aria-label="Function context">f</span><span class="hunk-context-text">${DiffRenderer.escapeHtml(functionContext)}</span>`
      : '<span class="hunk-divider" aria-label="Code section divider">...</span>';

    headerRow.innerHTML = `<td colspan="2" class="d2h-info">${headerContent}</td>`;
    return headerRow;
  }

  /**
   * Remove a hunk header row when function context becomes visible
   * Matches GitHub's behavior of removing the header entirely
   * @param {HTMLElement} headerRow - The hunk header row to remove
   */
  static removeFunctionContextHeader(headerRow) {
    if (!headerRow || !headerRow.classList.contains('d2h-info')) return;
    headerRow.remove();
  }

  /**
   * Check if a function context string matches a line of code
   * Uses anchored matching to avoid false positives
   * @param {string} lineText - The text content of the code line
   * @param {string} functionContext - The function context from the hunk header
   * @returns {boolean} True if the line contains the function definition
   */
  static isFunctionDefinitionLine(lineText, functionContext) {
    if (!lineText || !functionContext) return false;

    // Trim the line to handle leading whitespace
    const trimmedLine = lineText.trim();
    const trimmedContext = functionContext.trim();

    // The function context should appear at or near the start of the line
    // Check if the line starts with the function context (allowing for minor variations)
    return trimmedLine.startsWith(trimmedContext) ||
           trimmedLine.includes(trimmedContext + '(') ||
           trimmedLine.includes(trimmedContext + ' ');
  }

  /**
   * Update function context visibility for all hunk headers in a file's tbody
   * Called once after any expansion in a file - checks all headers efficiently
   * @param {HTMLElement} tbody - The table body containing the diff
   */
  static updateFunctionContextVisibility(tbody) {
    if (!tbody) return;

    // Get all rows once for efficiency
    const rows = Array.from(tbody.querySelectorAll('tr'));

    // Find all hunk headers with function context
    const headersToCheck = rows.filter(row =>
      row.classList.contains('d2h-info') && row.dataset.functionContext
    );

    if (headersToCheck.length === 0) return;

    // For each header, check if its function context is visible above it
    for (const headerRow of headersToCheck) {
      const functionContext = headerRow.dataset.functionContext;
      const headerIndex = rows.indexOf(headerRow);
      if (headerIndex <= 0) continue;

      // Search lines above the header for the function context
      for (let i = headerIndex - 1; i >= 0; i--) {
        const row = rows[i];

        // Stop at another hunk header - don't cross hunk boundaries
        if (row.classList.contains('d2h-info')) break;

        // Skip gap rows
        if (row.classList.contains('context-expand-row')) continue;

        // Check the content cell for matching text
        const contentCell = row.querySelector('.d2h-code-line-ctn');
        if (contentCell) {
          const lineText = contentCell.textContent || '';
          if (DiffRenderer.isFunctionDefinitionLine(lineText, functionContext)) {
            DiffRenderer.removeFunctionContextHeader(headerRow);
            break; // Found it, move to next header
          }
        }
      }
    }
  }

  /**
   * Find a file wrapper element by file path
   * Tries multiple selectors and partial path matching for robustness
   * @param {string} filePath - File path to find
   * @returns {Element|null} The file wrapper element or null if not found
   */
  static findFileElement(filePath) {
    // Try exact match first
    let fileElement = document.querySelector(`[data-file-name="${filePath}"]`);
    if (fileElement) return fileElement;

    fileElement = document.querySelector(`[data-file-path="${filePath}"]`);
    if (fileElement) return fileElement;

    // Try partial match for path segments
    const allFileWrappers = document.querySelectorAll('.d2h-file-wrapper');
    for (const wrapper of allFileWrappers) {
      const fileName = wrapper.dataset.fileName;
      if (fileName && (fileName === filePath || fileName.endsWith('/' + filePath) || filePath.endsWith('/' + fileName))) {
        return wrapper;
      }
    }

    return null;
  }
}

// Make DiffRenderer available globally in browser
if (typeof window !== 'undefined') {
  window.DiffRenderer = DiffRenderer;
}

// Export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DiffRenderer };
}
