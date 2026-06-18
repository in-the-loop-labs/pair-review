// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared UI utilities for AI suggestion management
 * Used by both PR mode (pr.js) and Local mode (local.js)
 */

(function() {
  /**
   * Text shown when an AI suggestion is hidden/dismissed
   * @constant {string}
   */
  const HIDDEN_SUGGESTION_TEXT = 'Hidden AI suggestion';
  const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/>
    <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
  </svg>`;
  const COPIED_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
  </svg>`;

  function normalizeText(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  function humanizeLabel(value) {
    return normalizeText(value)
      .replace(/[-_]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  function normalizeReasoning(reasoning) {
    if (Array.isArray(reasoning)) {
      return reasoning.map(normalizeText).filter(Boolean);
    }

    const text = normalizeText(reasoning);
    return text ? [text] : [];
  }

  function normalizeLocation(data) {
    const explicitLocation = normalizeText(data.location);
    if (explicitLocation) return explicitLocation;

    if (data.isFileLevel) return 'file-level';

    const lineStart = Number.parseInt(data.lineStart ?? data.line_start, 10);
    const lineEnd = Number.parseInt(data.lineEnd ?? data.line_end, 10);

    if (Number.isFinite(lineStart) && Number.isFinite(lineEnd) && lineEnd !== lineStart) {
      return `lines ${lineStart}-${lineEnd}`;
    }

    if (Number.isFinite(lineStart)) {
      return `line ${lineStart}`;
    }

    return 'file-level';
  }

  function formatInlineCode(value) {
    const text = normalizeText(value) || 'unknown';
    return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
  }

  /**
   * Format an AI suggestion as copy-safe Markdown.
   *
   * @param {Object} data - Suggestion data
   * @returns {string} Markdown representation
   */
  function formatSuggestionMarkdown(data = {}) {
    const title = normalizeText(data.title) || 'AI Suggestion';
    const file = normalizeText(data.file || data.fileName);
    const type = humanizeLabel(data.type);
    const severity = humanizeLabel(data.severity);
    const body = normalizeText(data.formattedBody || data.body);
    const reasoning = normalizeReasoning(data.reasoning);

    const lines = [
      `## ${title}`,
      `- File: ${formatInlineCode(file)}`,
      `- Location: ${normalizeLocation(data)}`
    ];

    if (type) lines.push(`- Type: ${type}`);
    if (severity) lines.push(`- Severity: ${severity}`);

    if (body) {
      lines.push('', body);
    }

    if (reasoning.length > 0) {
      lines.push('', '### Reasoning', ...reasoning.map(step => `- ${step}`));
    }

    return lines.join('\n');
  }

  function renderSuggestionCopyButton(options = {}) {
    const collapsedClass = options.collapsed ? ' collapsed-copy' : '';
    return `
      <button type="button" class="btn-suggestion-copy${collapsedClass}" title="Copy suggestion" aria-label="Copy suggestion">
        ${COPY_ICON}
      </button>
    `;
  }

  /**
   * Update the UI for a dismissed AI suggestion.
   * Collapses the suggestion in the diff view and updates the AI panel status.
   *
   * This is called when:
   * - A user comment adopted from an AI suggestion is deleted (orphaned adoption)
   * - Bulk delete clears comments that were adopted from AI suggestions
   *
   * @param {number|string} suggestionId - The suggestion ID that was dismissed
   */
  function updateDismissedSuggestionUI(suggestionId) {
    // Find the suggestion in the diff view
    const suggestionDiv = document.querySelector(`.ai-suggestion[data-suggestion-id="${suggestionId}"]`);
    if (suggestionDiv) {
      // Collapse the suggestion
      suggestionDiv.classList.add('collapsed');

      // Update collapsed content text to indicate dismissed state
      const collapsedText = suggestionDiv.querySelector('.collapsed-text');
      if (collapsedText) {
        collapsedText.textContent = HIDDEN_SUGGESTION_TEXT;
      }

      // Update the suggestion div dataset
      suggestionDiv.dataset.hiddenForAdoption = 'false';
    }

    // Update AI Panel status
    if (window.aiPanel?.updateFindingStatus) {
      window.aiPanel.updateFindingStatus(suggestionId, 'dismissed');
    }
  }

  // Export to global scope
  window.SuggestionUI = {
    HIDDEN_SUGGESTION_TEXT,
    COPY_ICON,
    COPIED_ICON,
    formatSuggestionMarkdown,
    renderSuggestionCopyButton,
    updateDismissedSuggestionUI
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.SuggestionUI;
  }
})();
