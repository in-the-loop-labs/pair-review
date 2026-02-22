// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * SuggestionManager - AI suggestion handling
 * Handles display, adopt, dismiss, and restore of AI suggestions.
 */

class SuggestionManager {
  constructor(prManagerRef) {
    // Reference to parent PRManager for API calls and state access
    this.prManager = prManagerRef;
    // Concurrency guard for displayAISuggestions
    this._isDisplayingSuggestions = false;

    // Event delegation for "Ask about this" chat button on suggestions
    document.addEventListener('click', (e) => {
      const chatBtn = e.target.closest('.ai-action-chat');
      if (chatBtn && chatBtn.closest('.file-comments-zone')) return; // handled by FileCommentManager
      if (chatBtn && !chatBtn.closest('.ai-suggestion')) return; // not a suggestion chat button
      if (chatBtn && window.chatPanel) {
        e.stopPropagation();
        const suggestionDiv = chatBtn.closest('.ai-suggestion');
        const suggestionData = suggestionDiv ? this.extractSuggestionData(suggestionDiv) : {};
        window.chatPanel.open({
          reviewId: this.prManager?.currentPR?.id,
          suggestionId: chatBtn.dataset.suggestionId,
          suggestionContext: {
            title: chatBtn.dataset.title || suggestionData.suggestionTitle || '',
            body: suggestionData.suggestionText || '',
            type: suggestionData.suggestionType || '',
            file: chatBtn.dataset.file || '',
            line_start: suggestionDiv?.dataset?.lineNumber ? parseInt(suggestionDiv.dataset.lineNumber) : null,
            line_end: null,
            side: suggestionDiv?.dataset?.side || 'RIGHT',
            reasoning: null
          }
        });
        return;
      }
    });

    // Event delegation for reasoning brain icon popover (pinned to button)
    document.addEventListener('click', (e) => {
      const toggleBtn = e.target.closest('.btn-reasoning-toggle');

      if (toggleBtn) {
        e.stopPropagation();
        const existingPopover = document.querySelector('.reasoning-popover');
        const isOwnPopover = existingPopover && existingPopover._triggerBtn === toggleBtn;

        // Close any existing popover
        this._closeReasoningPopover();

        // If clicking the same button that was already open, just close
        if (isOwnPopover) return;

        // Create and show new popover
        this._openReasoningPopover(toggleBtn);
        return;
      }

      // Close popover when clicking outside
      if (!e.target.closest('.reasoning-popover')) {
        this._closeReasoningPopover();
      }
    });
  }

  /**
   * Open a reasoning popover pinned to the toggle button inside .ai-suggestion-header-right
   * @param {HTMLElement} toggleBtn - The brain icon button that was clicked
   */
  _openReasoningPopover(toggleBtn) {
    const reasoningData = toggleBtn.dataset.reasoning;
    if (!reasoningData) return;

    let reasoning;
    try {
      reasoning = JSON.parse(decodeURIComponent(reasoningData));
    } catch {
      return;
    }
    if (!Array.isArray(reasoning)) return;

    const escapeHtml = this.prManager?.escapeHtml?.bind(this.prManager) || ((s) => s);
    const bulletMd = reasoning.map(step => `- ${step}`).join('\n');
    const rendered = window.renderMarkdown
      ? window.renderMarkdown(bulletMd)
      : `<ul>${reasoning.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ul>`;

    const popover = document.createElement('div');
    popover.className = 'reasoning-popover';
    popover._triggerBtn = toggleBtn;
    popover.innerHTML = `
      <div class="reasoning-popover-arrow"></div>
      <div class="reasoning-popover-header">
        <span class="reasoning-popover-title">Reasoning</span>
        <button class="reasoning-popover-close" title="Close">
          ${window.Icons.icon('close', 14, 14)}
        </button>
      </div>
      <div class="reasoning-popover-content">${rendered}</div>
    `;

    // Close button handler
    popover.querySelector('.reasoning-popover-close').addEventListener('click', () => {
      this._closeReasoningPopover();
    });

    // Insert into the header-right container (next to the button)
    const headerRight = toggleBtn.closest('.ai-suggestion-header-right');
    if (headerRight) {
      headerRight.appendChild(popover);
    } else {
      // Fallback: append to button's parent
      toggleBtn.parentElement.appendChild(popover);
    }

    toggleBtn.classList.add('active');
  }

  /**
   * Close any open reasoning popover
   */
  _closeReasoningPopover() {
    const existing = document.querySelector('.reasoning-popover');
    if (existing) {
      existing._triggerBtn?.classList.remove('active');
      existing.remove();
    }
  }

  /**
   * Get description for suggestion type
   * @param {string} type - Suggestion type
   * @returns {string} Description
   */
  getTypeDescription(type) {
    const descriptions = {
      bug: "Errors, crashes, or incorrect behavior",
      improvement: "Enhancements to make code better",
      praise: "Good practices worth highlighting",
      suggestion: "General recommendations to consider",
      design: "Architecture and structural concerns",
      performance: "Speed and efficiency optimizations",
      security: "Vulnerabilities or safety issues",
      "code-style": "Formatting, naming, and conventions",
      style: "Formatting, naming, and conventions" // backward compatibility
    };

    return descriptions[type] || "General feedback";
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
   * Find suggestions that target lines currently hidden in gaps
   * @param {Array} suggestions - Array of suggestions
   * @returns {Array} Suggestions targeting hidden lines
   */
  findHiddenSuggestions(suggestions) {
    const hiddenItems = [];

    for (const suggestion of suggestions) {
      const file = suggestion.file;
      const line = suggestion.line_start;
      const lineEnd = suggestion.line_end || line;
      // Get side from suggestion, default to 'RIGHT' for backwards compatibility
      const side = suggestion.side || 'RIGHT';

      // Find the file wrapper
      const fileElement = window.DiffRenderer ?
        window.DiffRenderer.findFileElement(file) :
        document.querySelector(`[data-file-name="${file}"]`);

      if (!fileElement) {
        // File not in diff at all, not a hidden line issue
        continue;
      }

      // Check if any line in the range is visible (with matching side)
      let anyLineVisible = false;
      const lineTracker = this.prManager?.lineTracker || (window.LineTracker ? new window.LineTracker() : null);

      for (let checkLine = line; checkLine <= lineEnd; checkLine++) {
        const lineRows = fileElement.querySelectorAll('tr');
        for (const row of lineRows) {
          // Pass side to getLineNumber() to get the correct coordinate system
          // For LEFT side: returns old line number (deleted lines or context lines in OLD coords)
          // For RIGHT side: returns new line number (added lines or context lines in NEW coords)
          // Context lines have BOTH coordinates, so they can match either side when queried appropriately
          const lineNum = lineTracker ? lineTracker.getLineNumber(row, side) : null;
          // Match the line number returned for the requested side
          // Note: We no longer need to check rowSide separately because getLineNumber(row, side)
          // already returns the appropriate line number for the requested coordinate system
          if (lineNum === checkLine) {
            anyLineVisible = true;
            break;
          }
        }
        if (anyLineVisible) break;
      }

      if (!anyLineVisible) {
        console.log(`[findHiddenSuggestions] Hidden: ${file}:${line}-${lineEnd} (${side})`);
        hiddenItems.push({ file, line, lineEnd, side });
      }
    }

    return hiddenItems;
  }

  /**
   * Display AI suggestions inline with diff
   * Uses a concurrency guard to prevent multiple simultaneous executions
   * @param {Array} suggestions - Array of suggestions to display
   */
  async displayAISuggestions(suggestions) {
    // Concurrency guard: prevent multiple simultaneous executions
    // This avoids duplicated/interleaved suggestions when called rapidly
    if (this._isDisplayingSuggestions) {
      console.log('[UI] displayAISuggestions already in progress, skipping');
      return;
    }
    this._isDisplayingSuggestions = true;

    try {
      this._closeReasoningPopover();
      console.log(`[UI] Displaying ${suggestions.length} AI suggestions`);

      // Clear existing AI suggestion rows before displaying new ones
      const existingSuggestionRows = document.querySelectorAll('.ai-suggestion-row');
      existingSuggestionRows.forEach(row => row.remove());
      console.log(`[UI] Removed ${existingSuggestionRows.length} existing suggestion rows`);

      // Auto-expand hidden lines for suggestions that target non-visible lines
      // Pass the side parameter so expandForSuggestion knows which coordinate system to use:
      // - RIGHT side = NEW coordinates (modified file, most common for AI suggestions)
      // - LEFT side = OLD coordinates (deleted lines from original file)
      const hiddenSuggestions = this.findHiddenSuggestions(suggestions);
      if (hiddenSuggestions.length > 0) {
        console.log(`[UI] Found ${hiddenSuggestions.length} suggestions targeting hidden lines, expanding...`);
        for (const hidden of hiddenSuggestions) {
          if (this.prManager?.expandForSuggestion) {
            await this.prManager.expandForSuggestion(hidden.file, hidden.line, hidden.lineEnd, hidden.side);
          }
        }
        console.log(`[UI] Finished expanding hidden lines`);
      }

      // Create suggestion navigator if not already created
      if (!this.prManager?.suggestionNavigator && window.SuggestionNavigator) {
        console.log('[UI] Creating SuggestionNavigator instance');
        if (this.prManager) {
          this.prManager.suggestionNavigator = new window.SuggestionNavigator();
        }
      }

      // Update the suggestion navigator
      if (this.prManager?.suggestionNavigator) {
        this.prManager.suggestionNavigator.updateSuggestions(suggestions);
      }

      // Adjust main content layout when navigator is visible
      const mainContent = document.querySelector('.main-content');
      if (mainContent && this.prManager?.suggestionNavigator) {
        const visibleSuggestions = suggestions.filter(s => s.status !== 'dismissed');
        // Only add navigator-visible if we have suggestions AND the navigator is not collapsed
        if (visibleSuggestions.length > 0 && !this.prManager.suggestionNavigator.isCollapsed) {
          mainContent.classList.add('navigator-visible');
        } else {
          mainContent.classList.remove('navigator-visible');
        }
      }

      // Separate file-level and line-level suggestions
      const fileLevelSuggestions = [];
      const lineLevelSuggestions = [];

      suggestions.forEach(suggestion => {
        if (suggestion.is_file_level === 1 || suggestion.line_start === null) {
          fileLevelSuggestions.push(suggestion);
        } else {
          lineLevelSuggestions.push(suggestion);
        }
      });

      // Handle file-level suggestions via FileCommentManager
      if (fileLevelSuggestions.length > 0 && this.prManager?.fileCommentManager) {
        console.log('[UI] Routing file-level suggestions to FileCommentManager:', fileLevelSuggestions.length);
        this.prManager.fileCommentManager.loadFileComments([], fileLevelSuggestions);
      }

      // Group line-level suggestions by file, line, and side
      // Side is important because the same line number can exist in both OLD (LEFT/deleted)
      // and NEW (RIGHT/added) ranges when viewing a unified diff
      const suggestionsByLocation = {};

      lineLevelSuggestions.forEach(suggestion => {
        // Include side in the key to differentiate between OLD and NEW line coordinates
        // Default to 'RIGHT' for backwards compatibility with suggestions that don't have side
        const side = suggestion.side || 'RIGHT';
        const key = `${suggestion.file}:${suggestion.line_start}:${side}`;
        if (!suggestionsByLocation[key]) {
          suggestionsByLocation[key] = [];
        }
        suggestionsByLocation[key].push(suggestion);
      });

      console.log('[UI] Grouped line-level suggestions by location:', Object.keys(suggestionsByLocation));

      // Find diff rows and insert line-level suggestions
      Object.entries(suggestionsByLocation).forEach(([location, locationSuggestions]) => {
        // Parse the location key: "file:line:side"
        // We parse from the end because file paths may contain colons (e.g., Windows C:\path
        // or macOS/Linux paths with colons in directory names, though the latter is rare).
        // This handles typical cases but could fail for paths with colons in unusual positions.
        const parts = location.split(':');
        const side = parts.pop(); // Last part is side
        const lineStr = parts.pop(); // Second-to-last is line number
        const file = parts.join(':'); // Remaining parts are file path (may contain colons)
        const line = parseInt(lineStr);

        // Use helper method for file lookup
        const fileElement = window.DiffRenderer ?
          window.DiffRenderer.findFileElement(file) :
          document.querySelector(`[data-file-name="${file}"]`);

        if (!fileElement) {
          // This can happen when AI suggests a file path that doesn't exist in the diff
          // Common with level 3 (codebase context) analysis which may reference files outside the PR
          const availableFiles = Array.from(document.querySelectorAll('.d2h-file-wrapper')).map(w => w.dataset.fileName);
          console.warn(`[UI] File not found in diff: "${file}". This suggestion may reference a file outside the PR or an incorrectly analyzed path. Available files:`, availableFiles);
          // Mark these suggestions as needing attention - they'll appear in the navigator but not inline
          locationSuggestions.forEach(s => {
            if (!s._displayError) s._displayError = `File "${file}" not found in diff`;
          });
          return;
        }

        // Find the line in the diff using helper method
        // Must match both line number AND side to correctly place suggestions
        // on deleted (LEFT) vs added/context (RIGHT) lines
        const lineRows = fileElement.querySelectorAll('tr');
        let suggestionInserted = false;
        const lineTracker = this.prManager?.lineTracker;

        for (const row of lineRows) {
          if (suggestionInserted) break;

          // Pass side to getLineNumber() to get the correct coordinate system
          // This allows context lines (which have BOTH old and new line numbers) to be found
          // when searching by either LEFT (old) or RIGHT (new) side
          const lineNum = lineTracker ? lineTracker.getLineNumber(row, side) : null;

          // Match the line number returned for the requested side
          // For context lines, getLineNumber(row, 'LEFT') returns oldLineNumber
          // and getLineNumber(row, 'RIGHT') returns newLineNumber
          // This correctly handles the case where we're looking for a LEFT-side line number
          // that happens to be on a context line (not a deleted line)
          if (lineNum === line) {
            console.log(`[UI] Found line ${line} (${side}) in file ${file}, inserting suggestion`);
            // Insert suggestion after this row
            // Pass target info so getFileAndLineInfo can retrieve it without DOM traversal
            const diffPosition = row.dataset.diffPosition;
            const suggestionRow = this.createSuggestionRow(locationSuggestions, {
              fileName: file,
              lineNumber: line,
              side: side,
              diffPosition: diffPosition,
              isFileLevel: false
            });
            row.parentNode.insertBefore(suggestionRow, row.nextSibling);
            suggestionInserted = true;
          }
        }

        if (!suggestionInserted) {
          // Line not found - this could happen if:
          // 1. The expansion didn't reveal the target line
          // 2. The line number is outside the diff hunks
          // 3. The AI suggested an incorrect line number
          // 4. The side doesn't match (e.g., suggestion targets deleted line but row is added)
          console.warn(`[UI] Line ${line} (${side}) not found in file "${file}" after expansion. The line may be outside the diff context or the AI may have suggested an incorrect line number/side.`);
          locationSuggestions.forEach(s => {
            if (!s._displayError) s._displayError = `Line ${line} (${side}) not found in diff for file "${file}"`;
          });
        }
      });

      // Update AI panel with findings
      if (window.aiPanel?.addFindings) {
        window.aiPanel.addFindings(suggestions);
      }
    } finally {
      // Always clear the guard, even if an error occurred
      this._isDisplayingSuggestions = false;
    }
  }

  /**
   * Create a suggestion row for display
   * @param {Array} suggestions - Suggestions for this location
   * @param {Object} targetInfo - Optional target info for reliable retrieval in getFileAndLineInfo
   * @param {string} targetInfo.fileName - File name
   * @param {number} targetInfo.lineNumber - Line number
   * @param {string} targetInfo.side - Side (LEFT or RIGHT)
   * @param {string} targetInfo.diffPosition - Diff position for GitHub API
   * @param {boolean} targetInfo.isFileLevel - Whether this is a file-level suggestion
   * @returns {HTMLElement} The suggestion row element
   */
  createSuggestionRow(suggestions, targetInfo = null) {
    const tr = document.createElement('tr');
    tr.className = 'ai-suggestion-row';

    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'ai-suggestion-cell';

    const escapeHtml = this.prManager?.escapeHtml?.bind(this.prManager) || ((s) => s);
    const userComments = this.prManager?.userComments || [];

    suggestions.forEach(suggestion => {
      const suggestionDiv = document.createElement('div');
      suggestionDiv.className = `ai-suggestion ai-type-${suggestion.type}`;
      suggestionDiv.dataset.suggestionId = suggestion.id;
      // Store original markdown body for adopt functionality
      // Use JSON.stringify to preserve newlines and special characters
      suggestionDiv.dataset.originalBody = JSON.stringify(suggestion.body || '');

      // Store target info on the suggestion div for reliable retrieval in getFileAndLineInfo
      // This avoids fragile DOM traversal that fails when gap rows are between suggestion and target
      if (targetInfo) {
        suggestionDiv.dataset.fileName = targetInfo.fileName || '';
        // Stringify for data attribute storage; parsed back to number in getFileAndLineInfo
        suggestionDiv.dataset.lineNumber = targetInfo.lineNumber !== undefined ? String(targetInfo.lineNumber) : '';
        suggestionDiv.dataset.side = targetInfo.side || 'RIGHT';
        suggestionDiv.dataset.diffPosition = targetInfo.diffPosition || '';
        suggestionDiv.dataset.isFileLevel = targetInfo.isFileLevel ? 'true' : 'false';
      }

      // Convert suggestion.id to number for comparison since parent_id might be a number
      const suggestionIdNum = parseInt(suggestion.id);

      // Check if this suggestion was adopted by looking for user comments with matching parent_id
      const wasAdopted = userComments.some(comment =>
        comment.parent_id && (comment.parent_id === suggestion.id || comment.parent_id === suggestionIdNum)
      );

      // Log when a suggestion is detected as adopted
      if (wasAdopted) {
        console.log(`[UI] Suggestion ${suggestion.id} was adopted - showing as collapsed`);
      }

      // Apply collapsed class if the suggestion is dismissed or was adopted
      // Check both: wasAdopted (from user comments with parent_id) OR status='adopted' (from DB)
      const isAdopted = wasAdopted || suggestion.status === 'adopted';
      if (isAdopted) {
        suggestionDiv.classList.add('collapsed');
        // Mark the suggestion div as adopted after it's created
        suggestionDiv.dataset.hiddenForAdoption = 'true';
      } else if (suggestion.status === 'dismissed') {
        suggestionDiv.classList.add('collapsed');
      }

      // Get category label for display
      const categoryLabel = suggestion.type || suggestion.category || '';

      suggestionDiv.innerHTML = `
        <div class="ai-suggestion-header">
          <div class="ai-suggestion-header-left">
            ${suggestion.type === 'praise'
              ? `<span class="praise-badge" title="Nice Work">${window.Icons.icon('star')}Nice Work</span>`
              : `<span class="ai-suggestion-badge" data-type="${suggestion.type}" title="${this.getTypeDescription(suggestion.type)}">${window.Icons.icon('sparkles', 12, 12)}AI Suggestion</span>`}
            ${categoryLabel ? `<span class="ai-suggestion-category">${escapeHtml(categoryLabel)}</span>` : ''}
            <span class="ai-title">${escapeHtml(suggestion.title || '')}</span>
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
            ? `<span class="praise-badge" title="Nice Work">${window.Icons.icon('star')}Nice Work</span>`
            : `<span class="ai-suggestion-badge collapsed" data-type="${suggestion.type}" title="${this.getTypeDescription(suggestion.type)}">${window.Icons.icon('sparkles', 10, 10)}AI Suggestion</span>`}
          <span class="collapsed-text">${isAdopted ? 'Suggestion adopted' : 'Hidden AI suggestion'}</span>
          <span class="collapsed-title">${escapeHtml(suggestion.title || '')}</span>
          <div class="ai-suggestion-header-right">
            ${suggestion.reasoning && suggestion.reasoning.length > 0 ? `
            <button class="btn-reasoning-toggle collapsed-reasoning" title="View reasoning" data-suggestion-id="${suggestion.id}" data-reasoning="${encodeURIComponent(JSON.stringify(suggestion.reasoning))}">
              ${window.Icons.icon('brain', 12, 12)}
            </button>
            ` : ''}
            <button class="btn-collapsed-chat ai-action-chat" title="Chat about suggestion"
                    data-suggestion-id="${suggestion.id}"
                    data-file="${escapeHtml(suggestion.file || '')}"
                    data-title="${escapeHtml(suggestion.title || '')}">
              ${window.Icons.icon('discussion', 14, 14)}
            </button>
            <button class="btn-restore" onclick="prManager.restoreSuggestion(${suggestion.id})" title="Show suggestion">
              ${window.Icons.icon('eyeInner', { width: 16, height: 16, className: 'octicon octicon-eye' })}
              <span class="btn-text">Show</span>
            </button>
          </div>
        </div>
        <div class="ai-suggestion-body">
          ${(() => {
            const body = suggestion.body || '';
            // Debug: Log what we're rendering
            console.log('Rendering AI suggestion body:', body.substring(0, 200));
            return window.renderMarkdown ? window.renderMarkdown(body) : escapeHtml(body);
          })()}
        </div>
        <div class="ai-suggestion-actions">
          <button class="ai-action ai-action-adopt" onclick="prManager.adoptSuggestion(${suggestion.id})">
            ${window.Icons.icon('check')}
            Adopt
          </button>
          <button class="ai-action ai-action-edit" onclick="prManager.adoptAndEditSuggestion(${suggestion.id})">
            ${window.Icons.icon('pencil')}
            Edit
          </button>
          <button class="ai-action ai-action-chat" title="Chat about suggestion" data-suggestion-id="${suggestion.id}" data-file="${escapeHtml(suggestion.file || '')}" data-title="${escapeHtml(suggestion.title || '')}">
            ${window.Icons.icon('discussion')}
            Chat
          </button>
          <button class="ai-action ai-action-dismiss" onclick="prManager.dismissSuggestion(${suggestion.id})">
            ${window.Icons.icon('close')}
            Dismiss
          </button>
        </div>
      `;

      td.appendChild(suggestionDiv);
    });

    tr.appendChild(td);
    return tr;
  }

  /**
   * Helper function to extract suggestion data from DOM
   * @param {HTMLElement} suggestionDiv - The suggestion element
   * @returns {Object} Extracted data
   */
  extractSuggestionData(suggestionDiv) {
    const suggestionText = suggestionDiv.dataset?.originalBody ?
      JSON.parse(suggestionDiv.dataset.originalBody) : '';

    // Get type from ai-suggestion-badge data-type attribute or praise-badge
    const badgeElement = suggestionDiv.querySelector('.ai-suggestion-badge, .praise-badge');
    const titleElement = suggestionDiv.querySelector('.ai-title');
    const suggestionType = badgeElement?.dataset?.type || (badgeElement?.classList?.contains('praise-badge') ? 'praise' : '');
    const suggestionTitle = titleElement?.textContent?.trim() || '';

    return { suggestionText, suggestionType, suggestionTitle };
  }

  /**
   * Helper function to find the target diff row by skipping non-diff rows.
   * Walks backward through siblings, skipping ai-suggestion-row, user-comment-row,
   * and context-expand-row elements to find the actual diff line.
   * @private
   * @param {HTMLElement|null} startRow - The row to start searching from
   * @returns {HTMLElement|null} The target diff row, or null if not found
   */
  _findTargetDiffRow(startRow) {
    let targetRow = startRow;
    while (targetRow && (
      targetRow.classList.contains('ai-suggestion-row') ||
      targetRow.classList.contains('user-comment-row') ||
      targetRow.classList.contains('context-expand-row')
    )) {
      targetRow = targetRow.previousElementSibling;
    }
    return targetRow;
  }

  /**
   * Helper function to find target row and extract file/line info.
   *
   * IMPORTANT: Callers must check the `isFileLevel` property in the return value.
   * When `isFileLevel` is true, `lineNumber`, `diffPosition`, `side`, and `targetRow`
   * will all be null. File-level suggestions should be handled via FileCommentManager
   * rather than line-level comment APIs.
   *
   * @param {HTMLElement} suggestionDiv - The suggestion element
   * @returns {Object} File and line information
   * @returns {HTMLElement|null} returns.targetRow - The target diff row (null for file-level)
   * @returns {HTMLElement} returns.suggestionRow - The suggestion's containing row
   * @returns {number|null} returns.lineNumber - Line number as integer (null for file-level)
   * @returns {string} returns.fileName - The file path
   * @returns {string|null} returns.diffPosition - Diff position for GitHub API (null for file-level)
   * @returns {string|null} returns.side - 'LEFT' or 'RIGHT' (null for file-level)
   * @returns {boolean} returns.isFileLevel - True if this is a file-level suggestion
   */
  getFileAndLineInfo(suggestionDiv) {
    // First, try to read from data attributes stored at creation time
    // This is the reliable method that works even with gap rows between suggestion and target
    const storedFileName = suggestionDiv.dataset.fileName;
    const storedLineNumber = suggestionDiv.dataset.lineNumber;
    const storedSide = suggestionDiv.dataset.side;
    const storedDiffPosition = suggestionDiv.dataset.diffPosition;
    const storedIsFileLevel = suggestionDiv.dataset.isFileLevel;

    // If we have stored data attributes, use them (reliable path)
    if (storedFileName) {
      const suggestionRow = suggestionDiv.closest('tr');

      // For file-level suggestions, there is no target row
      if (storedIsFileLevel === 'true') {
        return {
          targetRow: null,
          suggestionRow,
          lineNumber: null,
          fileName: storedFileName,
          diffPosition: null,
          side: null,
          isFileLevel: true
        };
      }

      // For line-level suggestions with stored data, find the target row for display purposes
      // but use stored values for the actual data
      if (storedLineNumber) {
        // DOM traversal is still done for targetRow even when using stored data.
        // targetRow is needed for UI operations like highlighting and scrolling,
        // but is not critical if it fails - the stored data has the authoritative values.
        const targetRow = this._findTargetDiffRow(suggestionRow?.previousElementSibling);

        return {
          targetRow,
          suggestionRow,
          lineNumber: parseInt(storedLineNumber, 10),
          fileName: storedFileName,
          diffPosition: storedDiffPosition || null,
          side: storedSide || 'RIGHT',
          isFileLevel: false
        };
      }
    }

    // Fallback: DOM traversal for backward compatibility with suggestions created before this fix
    // This method fails when gap rows (context-expand-row) are between the suggestion and target
    const suggestionRow = suggestionDiv.closest('tr');
    const targetRow = this._findTargetDiffRow(suggestionRow?.previousElementSibling);

    if (!targetRow) {
      throw new Error('Could not find target line for comment');
    }

    // Get diff position and side from the target row (for GitHub API)
    const diffPosition = targetRow.dataset.diffPosition;
    const side = targetRow.dataset.side || 'RIGHT';

    // Get line number based on side - deleted lines (LEFT) use .line-num1, others use .line-num2
    const lineNumSelector = side === 'LEFT' ? '.line-num1' : '.line-num2';
    const lineNumberText = targetRow.querySelector(lineNumSelector)?.textContent?.trim();
    const fileWrapper = targetRow.closest('.d2h-file-wrapper');
    const fileName = fileWrapper?.dataset?.fileName || '';

    if (!lineNumberText || !fileName) {
      throw new Error('Could not determine file and line information');
    }

    // Parse line number to integer for type consistency with stored-data path
    const lineNumber = parseInt(lineNumberText, 10);

    return { targetRow, suggestionRow, lineNumber, fileName, diffPosition, side, isFileLevel: false };
  }

}

// Make SuggestionManager available globally
window.SuggestionManager = SuggestionManager;

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SuggestionManager };
}
