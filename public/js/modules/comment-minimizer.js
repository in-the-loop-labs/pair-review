// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * CommentMinimizer - Manages "minimize comments" mode for the diff view.
 *
 * When active, all inline comment rows (.user-comment-row) and AI suggestion
 * rows (.ai-suggestion-row) are hidden via CSS class.  Small indicator buttons
 * are injected on the right edge of each diff line that has comments, showing
 * a person icon (user comments) or sparkles icon (AI suggestions).
 *
 * File-level comments (.file-comment-card inside .file-comments-zone) are also
 * hidden, with an indicator button injected into the file header bar.
 *
 * Clicking an indicator toggles visibility of that line's or file's comments.
 */

class CommentMinimizer {
  /** Person icon SVG (matches comment-manager.js octicon-person) */
  static PERSON_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/></svg>`;

  /** Sparkles icon SVG (matches AI suggestion badge) */
  static SPARKLES_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M9.6 2.279a.426.426 0 0 1 .8 0l.407 1.112a6.386 6.386 0 0 0 3.802 3.802l1.112.407a.426.426 0 0 1 0 .8l-1.112.407a6.386 6.386 0 0 0-3.802 3.802l-.407 1.112a.426.426 0 0 1-.8 0l-.407-1.112a6.386 6.386 0 0 0-3.802-3.802L4.279 8.4a.426.426 0 0 1 0-.8l1.112-.407a6.386 6.386 0 0 0 3.802-3.802L9.6 2.279Zm-4.267 8.837a.178.178 0 0 1 .334 0l.169.464a2.662 2.662 0 0 0 1.584 1.584l.464.169a.178.178 0 0 1 0 .334l-.464.169a2.662 2.662 0 0 0-1.584 1.584l-.169.464a.178.178 0 0 1-.334 0l-.169-.464a2.662 2.662 0 0 0-1.584-1.584l-.464-.169a.178.178 0 0 1 0-.334l.464-.169a2.662 2.662 0 0 0 1.584-1.584l.169-.464ZM2.8.14a.213.213 0 0 1 .4 0l.203.556a3.2 3.2 0 0 0 1.901 1.901l.556.203a.213.213 0 0 1 0 .4l-.556.203a3.2 3.2 0 0 0-1.901 1.901L3.2 5.86a.213.213 0 0 1-.4 0l-.203-.556A3.2 3.2 0 0 0 .696 3.403L.14 3.2a.213.213 0 0 1 0-.4l.556-.203A3.2 3.2 0 0 0 2.597.696L2.8.14Z"/></svg>`;

  /** AI comment icon SVG — speech bubble with sparkles (matches CommentManager.AI_ICON_SVG, different size) */
  static AI_COMMENT_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M7.75 1a.75.75 0 0 1 0 1.5h-5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2c.199 0 .39.079.53.22.141.14.22.331.22.53v2.19l2.72-2.72a.747.747 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-2a.75.75 0 0 1 1.5 0v2c0 .464-.184.909-.513 1.237A1.746 1.746 0 0 1 13.25 12H9.06l-2.573 2.573A1.457 1.457 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5C1 1.784 1.784 1 2.75 1h5Zm4.519-.837a.248.248 0 0 1 .466 0l.238.648a3.726 3.726 0 0 0 2.218 2.219l.649.238a.249.249 0 0 1 0 .467l-.649.238a3.725 3.725 0 0 0-2.218 2.218l-.238.649a.248.248 0 0 1-.466 0l-.239-.649a3.725 3.725 0 0 0-2.218-2.218l-.649-.238a.249.249 0 0 1 0-.467l.649-.238A3.726 3.726 0 0 0 12.03.811l.239-.648Z"/></svg>`;

  constructor() {
    this._active = false;
    // Track which diff lines have been expanded by the user (Set of diff row elements)
    this._expandedLines = new Set();
    // Track which file-comments-zones have been expanded (Set of zone elements)
    this._expandedFiles = new Set();
  }

  /** @returns {boolean} Whether minimize mode is active */
  get active() {
    return this._active;
  }

  /**
   * Enable or disable minimize mode.
   * @param {boolean} minimized
   */
  setMinimized(minimized) {
    this._active = minimized;
    this._expandedLines.clear();
    this._expandedFiles.clear();

    const diffContainer = document.getElementById('diff-container');
    if (!diffContainer) return;

    if (minimized) {
      diffContainer.classList.add('comments-minimized');
      this.refreshIndicators();
    } else {
      diffContainer.classList.remove('comments-minimized');
      this._removeAllIndicators();
      // Remove any per-line expansion overrides
      document.querySelectorAll('.comment-expanded').forEach(el => el.classList.remove('comment-expanded'));
      // Remove any per-file expansion overrides
      document.querySelectorAll('.file-comments-expanded').forEach(el => el.classList.remove('file-comments-expanded'));
    }
  }

  /**
   * Rebuild all indicator buttons on diff lines.
   * Call this after comments or suggestions are added/removed/re-rendered.
   */
  refreshIndicators() {
    if (!this._active) return;

    this._removeAllIndicators();

    // Find all comment and suggestion rows currently in the DOM
    const commentRows = document.querySelectorAll('.user-comment-row');
    const suggestionRows = document.querySelectorAll('.ai-suggestion-row');

    // Build a map: diff row element → { hasUser, hasAI, hasAdopted, userCount, aiCount, adoptedCount }
    const lineMap = new Map();

    for (const row of commentRows) {
      const diffRow = this._findDiffRowFor(row);
      if (!diffRow) continue;
      const entry = lineMap.get(diffRow) || { hasUser: false, hasAI: false, hasAdopted: false, userCount: 0, aiCount: 0, adoptedCount: 0 };
      if (row.querySelector('.adopted-comment')) {
        entry.hasAdopted = true;
        entry.adoptedCount++;
      } else {
        entry.hasUser = true;
        entry.userCount++;
      }
      lineMap.set(diffRow, entry);
    }

    for (const row of suggestionRows) {
      const diffRow = this._findDiffRowFor(row);
      if (!diffRow) continue;
      const entry = lineMap.get(diffRow) || { hasUser: false, hasAI: false, hasAdopted: false, userCount: 0, aiCount: 0, adoptedCount: 0 };
      // Count non-adopted suggestion divs only — adopted ones are already
      // represented by the adopted comment row (avoid double-counting)
      const allSuggestions = row.querySelectorAll('.ai-suggestion');
      let activeCount = 0;
      for (const s of allSuggestions) {
        if (!s.dataset?.hiddenForAdoption) {
          activeCount++;
        }
      }
      if (activeCount > 0) {
        entry.hasAI = true;
        entry.aiCount += activeCount;
      }
      lineMap.set(diffRow, entry);
    }

    // Inject line-level indicators
    for (const [diffRow, info] of lineMap) {
      this._injectIndicator(diffRow, info);
    }

    // Scan file-comments-zones and inject file-header indicators
    this._refreshFileIndicators();
  }

  /**
   * Walk backward from a comment/suggestion row to find its parent diff line.
   * Skips other comment rows, suggestion rows, and context-expand rows.
   * @param {HTMLElement} row
   * @returns {HTMLElement|null}
   */
  _findDiffRowFor(row) {
    let prev = row.previousElementSibling;
    while (prev) {
      if (
        !prev.classList.contains('user-comment-row') &&
        !prev.classList.contains('ai-suggestion-row') &&
        !prev.classList.contains('comment-form-row') &&
        !prev.classList.contains('context-expand-row')
      ) {
        return prev;
      }
      prev = prev.previousElementSibling;
    }
    return null;
  }

  /**
   * Inject an indicator button into a diff line's code cell.
   * @param {HTMLElement} diffRow - The diff table row
   * @param {Object} info - { hasUser, hasAI, hasAdopted, userCount, aiCount, adoptedCount }
   */
  _injectIndicator(diffRow, info) {
    const codeCell = diffRow.querySelector('.d2h-code-line-ctn');
    if (!codeCell) return;

    // Don't double-inject
    if (codeCell.querySelector('.comment-indicator')) return;

    const btn = document.createElement('button');
    btn.className = 'comment-indicator';
    btn.type = 'button';

    // Build icon content — three types:
    //   person (purple)   = user-originated comments
    //   ai-comment (purple) = adopted AI suggestions
    //   sparkles (amber)  = AI suggestions
    const icons = [];
    if (info.hasUser) {
      icons.push(`<span class="indicator-icon indicator-user" title="${info.userCount} comment${info.userCount !== 1 ? 's' : ''}">${CommentMinimizer.PERSON_ICON}</span>`);
    }
    if (info.hasAdopted) {
      icons.push(`<span class="indicator-icon indicator-adopted" title="${info.adoptedCount} adopted comment${info.adoptedCount !== 1 ? 's' : ''}">${CommentMinimizer.AI_COMMENT_ICON}</span>`);
    }
    if (info.hasAI) {
      icons.push(`<span class="indicator-icon indicator-ai" title="${info.aiCount} suggestion${info.aiCount !== 1 ? 's' : ''}">${CommentMinimizer.SPARKLES_ICON}</span>`);
    }

    const total = info.userCount + info.adoptedCount + info.aiCount;
    const countBadge = total > 1 ? `<span class="indicator-count">${total}</span>` : '';

    btn.innerHTML = icons.join('') + countBadge;

    const totalLabel = [];
    if (info.userCount) totalLabel.push(`${info.userCount} comment${info.userCount !== 1 ? 's' : ''}`);
    if (info.adoptedCount) totalLabel.push(`${info.adoptedCount} adopted comment${info.adoptedCount !== 1 ? 's' : ''}`);
    if (info.aiCount) totalLabel.push(`${info.aiCount} suggestion${info.aiCount !== 1 ? 's' : ''}`);
    btn.title = totalLabel.join(', ');

    // Check if this line was previously expanded
    if (this._expandedLines.has(diffRow)) {
      btn.classList.add('expanded');
    }

    // Click handler: toggle this line's comments
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this._toggleLineComments(diffRow, btn);
    });

    // Make the code cell position:relative for absolute positioning of the indicator
    codeCell.style.position = 'relative';
    codeCell.appendChild(btn);
  }

  /**
   * Toggle visibility of comment/suggestion rows for a specific diff line.
   * @param {HTMLElement} diffRow
   * @param {HTMLElement} btn - The indicator button
   */
  _toggleLineComments(diffRow, btn) {
    const isExpanded = this._expandedLines.has(diffRow);

    if (isExpanded) {
      // Collapse: remove .comment-expanded from this line's rows
      this._expandedLines.delete(diffRow);
      btn.classList.remove('expanded');
      this._getCommentRowsFor(diffRow).forEach(row => row.classList.remove('comment-expanded'));
    } else {
      // Expand: add .comment-expanded to this line's rows
      this._expandedLines.add(diffRow);
      btn.classList.add('expanded');
      this._getCommentRowsFor(diffRow).forEach(row => row.classList.add('comment-expanded'));
    }
  }

  /**
   * Get all comment/suggestion rows that belong to a diff line.
   * Walks forward from the diff row, collecting adjacent comment/suggestion rows.
   * @param {HTMLElement} diffRow
   * @returns {HTMLElement[]}
   */
  _getCommentRowsFor(diffRow) {
    const rows = [];
    let next = diffRow.nextElementSibling;
    while (next) {
      if (
        next.classList.contains('user-comment-row') ||
        next.classList.contains('ai-suggestion-row')
      ) {
        rows.push(next);
      } else if (
        next.classList.contains('comment-form-row') ||
        next.classList.contains('context-expand-row')
      ) {
        // Skip these but keep looking
        next = next.nextElementSibling;
        continue;
      } else {
        // Hit another diff line — stop
        break;
      }
      next = next.nextElementSibling;
    }
    return rows;
  }

  /**
   * Find the parent diff row for a given comment/suggestion element.
   * Public wrapper around _findDiffRowFor that first locates the containing
   * comment/suggestion row from any child element.
   * @param {HTMLElement} element - Any element inside (or equal to) a comment/suggestion row
   * @returns {HTMLElement|null} The parent diff row, or null
   */
  findDiffRowFor(element) {
    const commentRow = element.closest('.user-comment-row, .ai-suggestion-row') || element;
    if (!commentRow.classList.contains('user-comment-row') && !commentRow.classList.contains('ai-suggestion-row')) {
      return null;
    }
    return this._findDiffRowFor(commentRow);
  }

  // TODO: expose via API route so chat can programmatically expand findings when discussing them
  /**
   * Expand comments for a given element so it becomes visible when minimized.
   * Call this before scrolling to a comment/suggestion row that may be hidden.
   * @param {HTMLElement} element - The target comment/suggestion element (or row)
   */
  expandForElement(element) {
    if (!this._active) return;

    // Check if this element is inside a file-comments-zone (file-level comment)
    const zone = element.closest('.file-comments-zone');
    if (zone) {
      if (this._expandedFiles.has(zone)) return; // already expanded
      this._expandedFiles.add(zone);
      zone.classList.add('file-comments-expanded');
      // Update the file-header indicator button
      const wrapper = zone.closest('.d2h-file-wrapper');
      const btn = wrapper?.querySelector('.d2h-file-header .file-comment-indicator');
      if (btn) {
        btn.classList.add('expanded');
      }
      return;
    }

    // Line-level: find the containing comment/suggestion row
    const commentRow = element.closest('.user-comment-row, .ai-suggestion-row') || element;
    if (!commentRow.classList.contains('user-comment-row') && !commentRow.classList.contains('ai-suggestion-row')) {
      return;
    }

    // Find the parent diff row for this comment row
    const diffRow = this._findDiffRowFor(commentRow);
    if (!diffRow) return;

    // Already expanded — nothing to do
    if (this._expandedLines.has(diffRow)) return;

    // Expand all comment rows for this diff line
    this._expandedLines.add(diffRow);
    this._getCommentRowsFor(diffRow).forEach(row => row.classList.add('comment-expanded'));

    // Update the indicator button's expanded state
    const btn = diffRow.querySelector('.d2h-code-line-ctn .comment-indicator');
    if (btn) {
      btn.classList.add('expanded');
    }
  }

  // ---------------------------------------------------------------------------
  // File-level comment indicators
  // ---------------------------------------------------------------------------

  /**
   * Scan all file-comments-zones and inject indicator buttons into file headers.
   */
  _refreshFileIndicators() {
    const zones = document.querySelectorAll('.file-comments-zone');
    for (const zone of zones) {
      const cards = zone.querySelectorAll('.file-comment-card');
      if (cards.length === 0) continue;

      // Count comment types
      const info = { hasUser: false, hasAI: false, hasAdopted: false, userCount: 0, aiCount: 0, adoptedCount: 0 };
      for (const card of cards) {
        // Skip collapsed cards (adopted/dismissed originals remain in DOM)
        if (card.classList.contains('collapsed')) continue;

        if (card.classList.contains('ai-suggestion')) {
          info.hasAI = true;
          info.aiCount++;
        } else if (card.classList.contains('user-comment')) {
          if (card.classList.contains('adopted-comment')) {
            info.hasAdopted = true;
            info.adoptedCount++;
          } else {
            info.hasUser = true;
            info.userCount++;
          }
        }
      }

      if (info.userCount + info.aiCount + info.adoptedCount === 0) continue;

      // Find the file header — zone and header are siblings inside .d2h-file-wrapper
      const wrapper = zone.closest('.d2h-file-wrapper');
      const header = wrapper?.querySelector('.d2h-file-header');
      if (!header) continue;

      this._injectFileIndicator(header, zone, info);
    }
  }

  /**
   * Inject an indicator button into a file header, positioned before the comment button.
   * @param {HTMLElement} header - The .d2h-file-header element
   * @param {HTMLElement} zone - The .file-comments-zone element
   * @param {Object} info - { hasUser, hasAI, hasAdopted, userCount, aiCount, adoptedCount }
   */
  _injectFileIndicator(header, zone, info) {
    // Don't double-inject
    if (header.querySelector('.file-comment-indicator')) return;

    const btn = document.createElement('button');
    btn.className = 'file-comment-indicator';
    btn.type = 'button';

    // Build icon — pick the dominant type icon
    const icons = [];
    if (info.hasUser) {
      icons.push(`<span class="indicator-icon indicator-user">${CommentMinimizer.PERSON_ICON}</span>`);
    }
    if (info.hasAdopted) {
      icons.push(`<span class="indicator-icon indicator-adopted">${CommentMinimizer.AI_COMMENT_ICON}</span>`);
    }
    if (info.hasAI) {
      icons.push(`<span class="indicator-icon indicator-ai">${CommentMinimizer.SPARKLES_ICON}</span>`);
    }

    const total = info.userCount + info.adoptedCount + info.aiCount;
    const countBadge = total > 1 ? `<span class="indicator-count">${total}</span>` : '';

    btn.innerHTML = icons.join('') + countBadge;

    const totalLabel = [];
    if (info.userCount) totalLabel.push(`${info.userCount} file comment${info.userCount !== 1 ? 's' : ''}`);
    if (info.adoptedCount) totalLabel.push(`${info.adoptedCount} adopted`);
    if (info.aiCount) totalLabel.push(`${info.aiCount} suggestion${info.aiCount !== 1 ? 's' : ''}`);
    btn.title = totalLabel.join(', ');

    // Restore expanded state
    if (this._expandedFiles.has(zone)) {
      btn.classList.add('expanded');
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this._toggleFileComments(zone, btn);
    });

    // Insert before the file-header-comment-btn if present, otherwise append
    const commentBtn = header.querySelector('.file-header-comment-btn');
    if (commentBtn) {
      header.insertBefore(btn, commentBtn);
    } else {
      header.appendChild(btn);
    }
  }

  /**
   * Toggle visibility of file-level comments for a specific file.
   * @param {HTMLElement} zone - The .file-comments-zone element
   * @param {HTMLElement} btn - The indicator button
   */
  _toggleFileComments(zone, btn) {
    const isExpanded = this._expandedFiles.has(zone);

    if (isExpanded) {
      this._expandedFiles.delete(zone);
      btn.classList.remove('expanded');
      zone.classList.remove('file-comments-expanded');
    } else {
      this._expandedFiles.add(zone);
      btn.classList.add('expanded');
      zone.classList.add('file-comments-expanded');
    }
  }

  /** Remove all indicator buttons (both line-level and file-level) from the DOM. */
  _removeAllIndicators() {
    document.querySelectorAll('.comment-indicator').forEach(btn => btn.remove());
    document.querySelectorAll('.file-comment-indicator').forEach(btn => btn.remove());
  }
}

window.CommentMinimizer = CommentMinimizer;

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CommentMinimizer };
}
