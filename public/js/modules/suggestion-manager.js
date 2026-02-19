// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * SuggestionManager - AI suggestion handling
 * Handles display, adopt, dismiss, and restore of AI suggestions.
 */

class SuggestionManager {
  // Category to emoji mapping for formatting adopted comments
  static CATEGORY_EMOJI_MAP = {
    'bug': '\u{1F41B}',           // bug
    'improvement': '\u{1F4A1}',   // lightbulb
    'suggestion': '\u{1F4AD}',    // thought balloon
    'design': '\u{1F3D7}',        // building construction
    'performance': '\u{1F680}',   // rocket
    'security': '\u{1F512}',      // lock
    'code-style': '\u{1F3A8}',    // artist palette
    'style': '\u{1F3A8}',         // artist palette (alias)
    'praise': '\u{2B50}',         // star
    'comment': '\u{1F4AC}'        // speech bubble
  };

  constructor(prManagerRef) {
    // Reference to parent PRManager for API calls and state access
    this.prManager = prManagerRef;
    // Concurrency guard for displayAISuggestions
    this._isDisplayingSuggestions = false;

    // Event delegation for "Ask about this" chat button on suggestions
    document.addEventListener('click', (e) => {
      const chatBtn = e.target.closest('.ai-action-chat');
      if (chatBtn && chatBtn.closest('.file-comments-zone')) return; // handled by FileCommentManager
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
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path fill-rule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"></path></svg>
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
    return SuggestionManager.CATEGORY_EMOJI_MAP[category] || '\u{1F4AC}';
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
              ? `<span class="praise-badge" title="Nice Work"><svg viewBox="0 0 16 16"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>Nice Work</span>`
              : `<span class="ai-suggestion-badge" data-type="${suggestion.type}" title="${this.getTypeDescription(suggestion.type)}"><svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M9.6 2.279a.426.426 0 0 1 .8 0l.407 1.112a6.386 6.386 0 0 0 3.802 3.802l1.112.407a.426.426 0 0 1 0 .8l-1.112.407a6.386 6.386 0 0 0-3.802 3.802l-.407 1.112a.426.426 0 0 1-.8 0l-.407-1.112a6.386 6.386 0 0 0-3.802-3.802L4.279 8.4a.426.426 0 0 1 0-.8l1.112-.407a6.386 6.386 0 0 0 3.802-3.802L9.6 2.279Zm-4.267 8.837a.178.178 0 0 1 .334 0l.169.464a2.662 2.662 0 0 0 1.584 1.584l.464.169a.178.178 0 0 1 0 .334l-.464.169a2.662 2.662 0 0 0-1.584 1.584l-.169.464a.178.178 0 0 1-.334 0l-.169-.464a2.662 2.662 0 0 0-1.584-1.584l-.464-.169a.178.178 0 0 1 0-.334l.464-.169a2.662 2.662 0 0 0 1.584-1.584l.169-.464ZM2.8.14a.213.213 0 0 1 .4 0l.203.556a3.2 3.2 0 0 0 1.901 1.901l.556.203a.213.213 0 0 1 0 .4l-.556.203a3.2 3.2 0 0 0-1.901 1.901L3.2 5.86a.213.213 0 0 1-.4 0l-.203-.556A3.2 3.2 0 0 0 .696 3.403L.14 3.2a.213.213 0 0 1 0-.4l.556-.203A3.2 3.2 0 0 0 2.597.696L2.8.14Z"/></svg>AI Suggestion</span>`}
            ${categoryLabel ? `<span class="ai-suggestion-category">${escapeHtml(categoryLabel)}</span>` : ''}
            <span class="ai-title">${escapeHtml(suggestion.title || '')}</span>
          </div>
          <div class="ai-suggestion-header-right">
            ${suggestion.reasoning && suggestion.reasoning.length > 0 ? `
            <button class="btn-reasoning-toggle" title="View reasoning" data-suggestion-id="${suggestion.id}" data-reasoning="${encodeURIComponent(JSON.stringify(suggestion.reasoning))}">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M21.33 12.91c.09 1.55-.62 3.04-1.89 3.95l.77 1.49c.23.45.26.98.06 1.45c-.19.47-.58.84-1.06 1l-.79.25a1.69 1.69 0 0 1-1.86-.55L14.44 18c-.89-.15-1.73-.53-2.44-1.1c-.5.15-1 .23-1.5.23c-.88 0-1.76-.27-2.5-.79c-.53.16-1.07.23-1.62.22c-.79.01-1.57-.15-2.3-.45a4.1 4.1 0 0 1-2.43-3.61c-.08-.72.04-1.45.35-2.11c-.29-.75-.32-1.57-.07-2.33C2.3 7.11 3 6.32 3.87 5.82c.58-1.69 2.21-2.82 4-2.7c1.6-1.5 4.05-1.66 5.83-.37c.42-.11.86-.17 1.3-.17c1.36-.03 2.65.57 3.5 1.64c2.04.53 3.5 2.35 3.58 4.47c.05 1.11-.25 2.2-.86 3.13c.07.36.11.72.11 1.09m-5-1.41c.57.07 1.02.5 1.02 1.07a1 1 0 0 1-1 1h-.63c-.32.9-.88 1.69-1.62 2.29c.25.09.51.14.77.21c5.13-.07 4.53-3.2 4.53-3.25a2.59 2.59 0 0 0-2.69-2.49a1 1 0 0 1-1-1a1 1 0 0 1 1-1c1.23.03 2.41.49 3.33 1.3c.05-.29.08-.59.08-.89c-.06-1.24-.62-2.32-2.87-2.53c-1.25-2.96-4.4-1.32-4.4-.4c-.03.23.21.72.25.75a1 1 0 0 1 1 1c0 .55-.45 1-1 1c-.53-.02-1.03-.22-1.43-.56c-.48.31-1.03.5-1.6.56c-.57.05-1.04-.35-1.07-.9a.97.97 0 0 1 .88-1.1c.16-.02.94-.14.94-.77c0-.66.25-1.29.68-1.79c-.92-.25-1.91.08-2.91 1.29C6.75 5 6 5.25 5.45 7.2C4.5 7.67 4 8 3.78 9c1.08-.22 2.19-.13 3.22.25c.5.19.78.75.59 1.29c-.19.52-.77.78-1.29.59c-.73-.32-1.55-.34-2.3-.06c-.32.27-.32.83-.32 1.27c0 .74.37 1.43 1 1.83c.53.27 1.12.41 1.71.4q-.225-.39-.39-.81a1.038 1.038 0 0 1 1.96-.68c.4 1.14 1.42 1.92 2.62 2.05c1.37-.07 2.59-.88 3.19-2.13c.23-1.38 1.34-1.5 2.56-1.5m2 7.47l-.62-1.3l-.71.16l1 1.25zm-4.65-8.61a1 1 0 0 0-.91-1.03c-.71-.04-1.4.2-1.93.67c-.57.58-.87 1.38-.84 2.19a1 1 0 0 0 1 1c.57 0 1-.45 1-1c0-.27.07-.54.23-.76c.12-.1.27-.15.43-.15c.55.03 1.02-.38 1.02-.92"/></svg>
            </button>
            ` : ''}
          </div>
        </div>
        <div class="ai-suggestion-collapsed-content">
          ${suggestion.type === 'praise'
            ? `<span class="praise-badge" title="Nice Work"><svg viewBox="0 0 16 16"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>Nice Work</span>`
            : `<span class="ai-suggestion-badge collapsed" data-type="${suggestion.type}" title="${this.getTypeDescription(suggestion.type)}"><svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10"><path d="M9.6 2.279a.426.426 0 0 1 .8 0l.407 1.112a6.386 6.386 0 0 0 3.802 3.802l1.112.407a.426.426 0 0 1 0 .8l-1.112.407a6.386 6.386 0 0 0-3.802 3.802l-.407 1.112a.426.426 0 0 1-.8 0l-.407-1.112a6.386 6.386 0 0 0-3.802-3.802L4.279 8.4a.426.426 0 0 1 0-.8l1.112-.407a6.386 6.386 0 0 0 3.802-3.802L9.6 2.279Zm-4.267 8.837a.178.178 0 0 1 .334 0l.169.464a2.662 2.662 0 0 0 1.584 1.584l.464.169a.178.178 0 0 1 0 .334l-.464.169a2.662 2.662 0 0 0-1.584 1.584l-.169.464a.178.178 0 0 1-.334 0l-.169-.464a2.662 2.662 0 0 0-1.584-1.584l-.464-.169a.178.178 0 0 1 0-.334l.464-.169a2.662 2.662 0 0 0 1.584-1.584l.169-.464ZM2.8.14a.213.213 0 0 1 .4 0l.203.556a3.2 3.2 0 0 0 1.901 1.901l.556.203a.213.213 0 0 1 0 .4l-.556.203a3.2 3.2 0 0 0-1.901 1.901L3.2 5.86a.213.213 0 0 1-.4 0l-.203-.556A3.2 3.2 0 0 0 .696 3.403L.14 3.2a.213.213 0 0 1 0-.4l.556-.203A3.2 3.2 0 0 0 2.597.696L2.8.14Z"/></svg>AI Suggestion</span>`}
          <span class="collapsed-text">${isAdopted ? 'Suggestion adopted' : 'Hidden AI suggestion'}</span>
          <span class="collapsed-title">${escapeHtml(suggestion.title || '')}</span>
          <div class="ai-suggestion-header-right">
            ${suggestion.reasoning && suggestion.reasoning.length > 0 ? `
            <button class="btn-reasoning-toggle collapsed-reasoning" title="View reasoning" data-suggestion-id="${suggestion.id}" data-reasoning="${encodeURIComponent(JSON.stringify(suggestion.reasoning))}">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M21.33 12.91c.09 1.55-.62 3.04-1.89 3.95l.77 1.49c.23.45.26.98.06 1.45c-.19.47-.58.84-1.06 1l-.79.25a1.69 1.69 0 0 1-1.86-.55L14.44 18c-.89-.15-1.73-.53-2.44-1.1c-.5.15-1 .23-1.5.23c-.88 0-1.76-.27-2.5-.79c-.53.16-1.07.23-1.62.22c-.79.01-1.57-.15-2.3-.45a4.1 4.1 0 0 1-2.43-3.61c-.08-.72.04-1.45.35-2.11c-.29-.75-.32-1.57-.07-2.33C2.3 7.11 3 6.32 3.87 5.82c.58-1.69 2.21-2.82 4-2.7c1.6-1.5 4.05-1.66 5.83-.37c.42-.11.86-.17 1.3-.17c1.36-.03 2.65.57 3.5 1.64c2.04.53 3.5 2.35 3.58 4.47c.05 1.11-.25 2.2-.86 3.13c.07.36.11.72.11 1.09m-5-1.41c.57.07 1.02.5 1.02 1.07a1 1 0 0 1-1 1h-.63c-.32.9-.88 1.69-1.62 2.29c.25.09.51.14.77.21c5.13-.07 4.53-3.2 4.53-3.25a2.59 2.59 0 0 0-2.69-2.49a1 1 0 0 1-1-1a1 1 0 0 1 1-1c1.23.03 2.41.49 3.33 1.3c.05-.29.08-.59.08-.89c-.06-1.24-.62-2.32-2.87-2.53c-1.25-2.96-4.4-1.32-4.4-.4c-.03.23.21.72.25.75a1 1 0 0 1 1 1c0 .55-.45 1-1 1c-.53-.02-1.03-.22-1.43-.56c-.48.31-1.03.5-1.6.56c-.57.05-1.04-.35-1.07-.9a.97.97 0 0 1 .88-1.1c.16-.02.94-.14.94-.77c0-.66.25-1.29.68-1.79c-.92-.25-1.91.08-2.91 1.29C6.75 5 6 5.25 5.45 7.2C4.5 7.67 4 8 3.78 9c1.08-.22 2.19-.13 3.22.25c.5.19.78.75.59 1.29c-.19.52-.77.78-1.29.59c-.73-.32-1.55-.34-2.3-.06c-.32.27-.32.83-.32 1.27c0 .74.37 1.43 1 1.83c.53.27 1.12.41 1.71.4q-.225-.39-.39-.81a1.038 1.038 0 0 1 1.96-.68c.4 1.14 1.42 1.92 2.62 2.05c1.37-.07 2.59-.88 3.19-2.13c.23-1.38 1.34-1.5 2.56-1.5m2 7.47l-.62-1.3-.71.16l1 1.25zm-4.65-8.61a1 1 0 0 0-.91-1.03c-.71-.04-1.4.2-1.93.67c-.57.58-.87 1.38-.84 2.19a1 1 0 0 0 1 1c.57 0 1-.45 1-1c0-.27.07-.54.23-.76c.12-.1.27-.15.43-.15c.55.03 1.02-.38 1.02-.92"/></svg>
            </button>
            ` : ''}
            <button class="btn-restore" onclick="prManager.restoreSuggestion(${suggestion.id})" title="Show suggestion">
              <svg class="octicon octicon-eye" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M1.679 7.932c.412-.621 1.242-1.75 2.366-2.717C5.175 4.242 6.527 3.5 8 3.5c1.473 0 2.824.742 3.955 1.715 1.124.967 1.954 2.096 2.366 2.717a.119.119 0 010 .136c-.412.621-1.242 1.75-2.366 2.717C10.825 11.758 9.473 12.5 8 12.5c-1.473 0-2.824-.742-3.955-1.715C2.92 9.818 2.09 8.69 1.679 8.068a.119.119 0 010-.136zM8 2c-1.981 0-3.67.992-4.933 2.078C1.797 5.169.88 6.423.43 7.1a1.619 1.619 0 000 1.798c.45.678 1.367 1.932 2.637 3.024C4.329 13.008 6.019 14 8 14c1.981 0 3.67-.992 4.933-2.078 1.27-1.091 2.187-2.345 2.637-3.023a1.619 1.619 0 000-1.798c-.45-.678-1.367-1.932-2.637-3.023C11.671 2.992 9.981 2 8 2zm0 8a2 2 0 100-4 2 2 0 000 4z"></path>
              </svg>
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
            <svg viewBox="0 0 16 16" width="16" height="16"><path fill-rule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"></path></svg>
            Adopt
          </button>
          <button class="ai-action ai-action-edit" onclick="prManager.adoptAndEditSuggestion(${suggestion.id})">
            <svg viewBox="0 0 16 16" width="16" height="16"><path fill-rule="evenodd" d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"></path></svg>
            Edit
          </button>
          <button class="ai-action ai-action-chat" title="Chat about suggestion" data-suggestion-id="${suggestion.id}" data-file="${escapeHtml(suggestion.file || '')}" data-title="${escapeHtml(suggestion.title || '')}">
            <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>
            Chat
          </button>
          <button class="ai-action ai-action-dismiss" onclick="prManager.dismissSuggestion(${suggestion.id})">
            <svg viewBox="0 0 16 16" width="16" height="16"><path fill-rule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"></path></svg>
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

  /**
   * Helper function to update status and collapse AI suggestion
   * @param {number} suggestionId - Suggestion ID
   * @param {HTMLElement} suggestionRow - The suggestion row element
   * @param {string} collapsedText - Text to show when collapsed
   * @param {string} status - Status to set
   */
  async collapseAISuggestion(suggestionId, suggestionRow, collapsedText = 'Suggestion adopted', status = 'dismissed') {
    // Update the AI suggestion status via API
    const reviewId = this.prManager?.currentPR?.id;
    const response = await fetch(`/api/reviews/${reviewId}/suggestions/${suggestionId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status })
    });

    if (!response.ok) {
      throw new Error('Failed to update suggestion status');
    }

    // Collapse the AI suggestion in the UI
    // Use suggestionId (found by ID) not suggestionRow.querySelector('.ai-suggestion')
    // because multiple suggestions can share the same row when they target the same line
    if (suggestionRow) {
      const suggestionDiv = suggestionRow.querySelector(`[data-suggestion-id="${suggestionId}"]`);
      if (suggestionDiv) {
        suggestionDiv.classList.add('collapsed');
        // Update collapsed content text
        const collapsedContent = suggestionDiv.querySelector('.collapsed-text');
        if (collapsedContent) {
          collapsedContent.textContent = collapsedText;
        }
        // Update restore button - should say "Show" since suggestion is now collapsed
        const restoreButton = suggestionDiv.querySelector('.btn-restore');
        if (restoreButton) {
          restoreButton.title = 'Show suggestion';
          const btnText = restoreButton.querySelector('.btn-text');
          if (btnText) {
            btnText.textContent = 'Show';
          }
        }
        if (status === 'adopted') {
          suggestionDiv.dataset.hiddenForAdoption = 'true';
        }
      }
    }
  }

  /**
   * Helper function to create user comment from AI suggestion
   * @param {number} suggestionId - Suggestion ID
   * @param {string} fileName - File name
   * @param {string} lineNumber - Line number
   * @param {string} suggestionText - Suggestion text
   * @param {string} suggestionType - Suggestion type
   * @param {string} suggestionTitle - Suggestion title
   * @param {string} diffPosition - Diff position
   * @param {string} side - Side (LEFT or RIGHT)
   * @returns {Object} Created comment data
   */
  async createUserCommentFromSuggestion(suggestionId, fileName, lineNumber, suggestionText, suggestionType, suggestionTitle, diffPosition, side) {
    // Format the comment text with emoji and category prefix
    const formattedText = this.formatAdoptedComment(suggestionText, suggestionType);

    // Parse diff_position if it's a string (from dataset)
    const parsedDiffPosition = diffPosition ? parseInt(diffPosition) : null;

    const reviewId = this.prManager?.currentPR?.id;
    const headSha = this.prManager?.currentPR?.head_sha;

    const createResponse = await fetch(`/api/reviews/${reviewId}/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        file: fileName,
        line_start: parseInt(lineNumber),
        line_end: parseInt(lineNumber),
        diff_position: parsedDiffPosition,  // For GitHub API line-level comments
        side: side || 'RIGHT',              // For GitHub API (LEFT for deleted, RIGHT for added/context)
        body: formattedText,
        parent_id: suggestionId,  // Link to original AI suggestion
        type: suggestionType,     // Preserve the type
        title: suggestionTitle,   // Preserve the title
        commit_sha: headSha       // Anchor comment to PR head commit
      })
    });

    if (!createResponse.ok) {
      throw new Error('Failed to create user comment');
    }

    const result = await createResponse.json();
    return {
      id: result.commentId,
      file: fileName,
      line_start: parseInt(lineNumber),
      body: formattedText,
      type: suggestionType,
      title: suggestionTitle,
      parent_id: suggestionId,
      diff_position: parsedDiffPosition,  // Include for expanded context warning logic
      created_at: new Date().toISOString()
    };
  }
}

// Make SuggestionManager available globally
window.SuggestionManager = SuggestionManager;

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SuggestionManager };
}
