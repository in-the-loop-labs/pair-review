// SPDX-License-Identifier: GPL-3.0-or-later
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

      // Update the parent row dataset
      const suggestionRow = suggestionDiv.closest('tr');
      if (suggestionRow) {
        suggestionRow.dataset.hiddenForAdoption = 'false';
      }
    }

    // Update AI Panel status
    if (window.aiPanel?.updateFindingStatus) {
      window.aiPanel.updateFindingStatus(suggestionId, 'dismissed');
    }
  }

  // Export to global scope
  window.SuggestionUI = {
    HIDDEN_SUGGESTION_TEXT,
    updateDismissedSuggestionUI
  };
})();
