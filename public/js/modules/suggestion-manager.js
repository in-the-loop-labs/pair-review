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

      // Find the file wrapper
      const fileElement = window.DiffRenderer ?
        window.DiffRenderer.findFileElement(file) :
        document.querySelector(`[data-file-name="${file}"]`);

      if (!fileElement) {
        // File not in diff at all, not a hidden line issue
        continue;
      }

      // Check if any line in the range is visible
      let anyLineVisible = false;
      const lineTracker = this.prManager?.lineTracker || (window.LineTracker ? new window.LineTracker() : null);

      for (let checkLine = line; checkLine <= lineEnd; checkLine++) {
        const lineRows = fileElement.querySelectorAll('tr');
        for (const row of lineRows) {
          const lineNum = lineTracker ? lineTracker.getLineNumber(row) : null;
          if (lineNum === checkLine) {
            anyLineVisible = true;
            break;
          }
        }
        if (anyLineVisible) break;
      }

      if (!anyLineVisible) {
        console.log(`[findHiddenSuggestions] Hidden: ${file}:${line}-${lineEnd}`);
        hiddenItems.push({ file, line, lineEnd });
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
      console.log(`[UI] Displaying ${suggestions.length} AI suggestions`);

      // Clear existing AI suggestion rows before displaying new ones
      const existingSuggestionRows = document.querySelectorAll('.ai-suggestion-row');
      existingSuggestionRows.forEach(row => row.remove());
      console.log(`[UI] Removed ${existingSuggestionRows.length} existing suggestion rows`);

      // Auto-expand hidden lines for suggestions that target non-visible lines
      const hiddenSuggestions = this.findHiddenSuggestions(suggestions);
      if (hiddenSuggestions.length > 0) {
        console.log(`[UI] Found ${hiddenSuggestions.length} suggestions targeting hidden lines, expanding...`);
        for (const hidden of hiddenSuggestions) {
          if (this.prManager?.expandForSuggestion) {
            await this.prManager.expandForSuggestion(hidden.file, hidden.line, hidden.lineEnd);
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

      // Group suggestions by file and line
      const suggestionsByLocation = {};

      suggestions.forEach(suggestion => {
        const key = `${suggestion.file}:${suggestion.line_start}`;
        if (!suggestionsByLocation[key]) {
          suggestionsByLocation[key] = [];
        }
        suggestionsByLocation[key].push(suggestion);
      });

      console.log('[UI] Grouped suggestions by location:', Object.keys(suggestionsByLocation));

      // Find diff rows and insert suggestions
      Object.entries(suggestionsByLocation).forEach(([location, locationSuggestions]) => {
        const [file, lineStr] = location.split(':');
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
        const lineRows = fileElement.querySelectorAll('tr');
        let suggestionInserted = false;
        const lineTracker = this.prManager?.lineTracker;

        for (const row of lineRows) {
          if (suggestionInserted) break;

          const lineNum = lineTracker ? lineTracker.getLineNumber(row) : null;

          if (lineNum === line) {
            console.log(`[UI] Found line ${line} in file ${file}, inserting suggestion`);
            // Insert suggestion after this row
            const suggestionRow = this.createSuggestionRow(locationSuggestions);
            row.parentNode.insertBefore(suggestionRow, row.nextSibling);
            suggestionInserted = true;
          }
        }

        if (!suggestionInserted) {
          // Line not found - this could happen if:
          // 1. The expansion didn't reveal the target line
          // 2. The line number is outside the diff hunks
          // 3. The AI suggested an incorrect line number
          console.warn(`[UI] Line ${line} not found in file "${file}" after expansion. The line may be outside the diff context or the AI may have suggested an incorrect line number.`);
          locationSuggestions.forEach(s => {
            if (!s._displayError) s._displayError = `Line ${line} not found in diff for file "${file}"`;
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
   * @returns {HTMLElement} The suggestion row element
   */
  createSuggestionRow(suggestions) {
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
        // Mark the row as adopted after it's created
        setTimeout(() => {
          const suggestionRow = suggestionDiv.closest('tr');
          if (suggestionRow) {
            suggestionRow.dataset.hiddenForAdoption = 'true';
          }
        }, 0);
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
        </div>
        <div class="ai-suggestion-collapsed-content">
          ${suggestion.type === 'praise'
            ? `<span class="praise-badge" title="Nice Work"><svg viewBox="0 0 16 16"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>Nice Work</span>`
            : `<span class="ai-suggestion-badge collapsed" data-type="${suggestion.type}" title="${this.getTypeDescription(suggestion.type)}"><svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10"><path d="M9.6 2.279a.426.426 0 0 1 .8 0l.407 1.112a6.386 6.386 0 0 0 3.802 3.802l1.112.407a.426.426 0 0 1 0 .8l-1.112.407a6.386 6.386 0 0 0-3.802 3.802l-.407 1.112a.426.426 0 0 1-.8 0l-.407-1.112a6.386 6.386 0 0 0-3.802-3.802L4.279 8.4a.426.426 0 0 1 0-.8l1.112-.407a6.386 6.386 0 0 0 3.802-3.802L9.6 2.279Zm-4.267 8.837a.178.178 0 0 1 .334 0l.169.464a2.662 2.662 0 0 0 1.584 1.584l.464.169a.178.178 0 0 1 0 .334l-.464.169a2.662 2.662 0 0 0-1.584 1.584l-.169.464a.178.178 0 0 1-.334 0l-.169-.464a2.662 2.662 0 0 0-1.584-1.584l-.464-.169a.178.178 0 0 1 0-.334l.464-.169a2.662 2.662 0 0 0 1.584-1.584l.169-.464ZM2.8.14a.213.213 0 0 1 .4 0l.203.556a3.2 3.2 0 0 0 1.901 1.901l.556.203a.213.213 0 0 1 0 .4l-.556.203a3.2 3.2 0 0 0-1.901 1.901L3.2 5.86a.213.213 0 0 1-.4 0l-.203-.556A3.2 3.2 0 0 0 .696 3.403L.14 3.2a.213.213 0 0 1 0-.4l.556-.203A3.2 3.2 0 0 0 2.597.696L2.8.14Z"/></svg>AI Suggestion</span>`}
          <span class="collapsed-text">${isAdopted ? 'Suggestion adopted' : 'Hidden AI suggestion'}</span>
          <span class="collapsed-title">${escapeHtml(suggestion.title || '')}</span>
          <button class="btn-restore" onclick="prManager.restoreSuggestion(${suggestion.id})" title="Show suggestion">
            <svg class="octicon octicon-eye" viewBox="0 0 16 16" width="16" height="16">
              <path fill-rule="evenodd" d="M1.679 7.932c.412-.621 1.242-1.75 2.366-2.717C5.175 4.242 6.527 3.5 8 3.5c1.473 0 2.824.742 3.955 1.715 1.124.967 1.954 2.096 2.366 2.717a.119.119 0 010 .136c-.412.621-1.242 1.75-2.366 2.717C10.825 11.758 9.473 12.5 8 12.5c-1.473 0-2.824-.742-3.955-1.715C2.92 9.818 2.09 8.69 1.679 8.068a.119.119 0 010-.136zM8 2c-1.981 0-3.67.992-4.933 2.078C1.797 5.169.88 6.423.43 7.1a1.619 1.619 0 000 1.798c.45.678 1.367 1.932 2.637 3.024C4.329 13.008 6.019 14 8 14c1.981 0 3.67-.992 4.933-2.078 1.27-1.091 2.187-2.345 2.637-3.023a1.619 1.619 0 000-1.798c-.45-.678-1.367-1.932-2.637-3.023C11.671 2.992 9.981 2 8 2zm0 8a2 2 0 100-4 2 2 0 000 4z"></path>
            </svg>
            <span class="btn-text">Show</span>
          </button>
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
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>
            Adopt
          </button>
          <button class="ai-action ai-action-edit" onclick="prManager.adoptAndEditSuggestion(${suggestion.id})">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"/></svg>
            Edit
          </button>
          <button class="ai-action ai-action-dismiss" onclick="prManager.dismissSuggestion(${suggestion.id})">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>
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
   * Helper function to find target row and extract file/line info
   * @param {HTMLElement} suggestionDiv - The suggestion element
   * @returns {Object} File and line information
   */
  getFileAndLineInfo(suggestionDiv) {
    const suggestionRow = suggestionDiv.closest('tr');
    let targetRow = suggestionRow?.previousElementSibling;

    // Find the actual diff line row (skip other suggestion/comment rows)
    while (targetRow && (targetRow.classList.contains('ai-suggestion-row') || targetRow.classList.contains('user-comment-row'))) {
      targetRow = targetRow.previousElementSibling;
    }

    if (!targetRow) {
      throw new Error('Could not find target line for comment');
    }

    // Get diff position and side from the target row (for GitHub API)
    const diffPosition = targetRow.dataset.diffPosition;
    const side = targetRow.dataset.side || 'RIGHT';

    // Get line number based on side - deleted lines (LEFT) use .line-num1, others use .line-num2
    const lineNumSelector = side === 'LEFT' ? '.line-num1' : '.line-num2';
    const lineNumber = targetRow.querySelector(lineNumSelector)?.textContent?.trim();
    const fileWrapper = targetRow.closest('.d2h-file-wrapper');
    const fileName = fileWrapper?.dataset?.fileName || '';

    if (!lineNumber || !fileName) {
      throw new Error('Could not determine file and line information');
    }

    return { targetRow, suggestionRow, lineNumber, fileName, diffPosition, side };
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
    const response = await fetch(`/api/ai-suggestion/${suggestionId}/status`, {
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
    if (suggestionRow) {
      const suggestionDiv = suggestionRow.querySelector('.ai-suggestion');
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
      }
      suggestionRow.dataset.hiddenForAdoption = 'true';
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

    const prId = this.prManager?.currentPR?.id;
    const headSha = this.prManager?.currentPR?.head_sha;

    const createResponse = await fetch('/api/user-comment', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        pr_id: prId,
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
