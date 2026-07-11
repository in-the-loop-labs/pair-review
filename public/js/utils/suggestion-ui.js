// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared UI utilities for AI suggestion management
 * Used by both PR mode (pr.js) and Local mode (local.js)
 */

(function() {
  /**
   * Label shown above a dismissal reason note.
   * @constant {string}
   */
  const DISMISSAL_NOTE_LABEL = 'Dismissal note';

  /**
   * Heading shown above the dismissal reason inside the reasoning popover.
   * @constant {string}
   */
  const POPOVER_DISMISSAL_HEADING = 'Dismissal';

  /**
   * Minimal HTML escaper. Self-contained so the reason builders can be called
   * from any render path (suggestion cards, file-comment cards, AI panel)
   * without depending on the caller's escape helper.
   * @param {*} text
   * @returns {string}
   */
  function escapeReasonHtml(text) {
    if (text == null) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Build the expanded reply-styled dismissal note block. Rendered under the
   * suggestion body of a dismissed AI suggestion when a reason is present.
   * Returns an empty string when there is no reason so callers can inline it.
   *
   * @param {string|null|undefined} statusReason - The dismissal reason
   * @returns {string} HTML string (empty when no reason)
   */
  function buildDismissalNoteHtml(statusReason) {
    if (!statusReason) return '';
    const safe = escapeReasonHtml(statusReason);
    return `
      <div class="ai-dismissal-note" role="note">
        <span class="ai-dismissal-note-label">${DISMISSAL_NOTE_LABEL}</span>
        <span class="ai-dismissal-note-body">${safe}</span>
      </div>`;
  }

  /**
   * Build the inner HTML for a reasoning popover's content area.
   *
   * Renders the reasoning steps as a markdown bullet list (as before) and, when
   * a dismissal reason is present, appends a "Dismissal" section beneath it.
   * Either part may be absent: a reason-only popover renders just the Dismissal
   * section, and a reasoning-only popover renders just the bullets. Returns an
   * empty string when neither is present.
   *
   * Content is rendered through window.renderMarkdown when available (which uses
   * markdown-it with html:false, so agent-controlled text stays inert). When it
   * is unavailable the text is HTML-escaped instead, matching the reasoning
   * bullets' own fallback.
   *
   * @param {Array<string>|null|undefined} reasoning - Reasoning steps
   * @param {string|null|undefined} dismissalReason - The dismissal reason
   * @returns {string} HTML string for the popover content (empty when neither)
   */
  function buildReasoningPopoverContentHtml(reasoning, dismissalReason) {
    const renderMd = (typeof window !== 'undefined' && window.renderMarkdown)
      ? window.renderMarkdown
      : null;

    let html = '';

    if (Array.isArray(reasoning) && reasoning.length > 0) {
      const bulletMd = reasoning.map(step => `- ${step}`).join('\n');
      html += renderMd
        ? renderMd(bulletMd)
        : `<ul>${reasoning.map(step => `<li>${escapeReasonHtml(step)}</li>`).join('')}</ul>`;
    }

    if (dismissalReason) {
      const reasonHtml = renderMd
        ? renderMd(dismissalReason)
        : `<p>${escapeReasonHtml(dismissalReason)}</p>`;
      html += `
        <div class="reasoning-popover-dismissal">
          <span class="reasoning-popover-dismissal-heading">${POPOVER_DISMISSAL_HEADING}</span>
          ${reasonHtml}
        </div>`;
    }

    return html;
  }

  /**
   * Set (or clear) the collapsed-bar state tooltip on a suggestion card.
   *
   * The collapsed bar no longer shows inline state text; the dismissed/adopted
   * signal now lives in a tooltip on the collapsed-content container. Pass a
   * falsy label to clear it (e.g. when restoring a suggestion to active).
   *
   * @param {HTMLElement|null} suggestionDiv - The .ai-suggestion element
   * @param {string} [label] - 'Dismissed', 'Adopted', or '' to clear
   */
  function setCollapsedStateTooltip(suggestionDiv, label) {
    if (!suggestionDiv) return;
    const collapsedContent = suggestionDiv.querySelector('.ai-suggestion-collapsed-content');
    if (!collapsedContent) return;
    if (label) {
      collapsedContent.title = label;
    } else {
      collapsedContent.removeAttribute('title');
    }
  }

  /**
   * Strip stale dismissal-reason UI from a suggestion card when it is restored
   * to active. While dismissed, the reason is baked into the card markup in two
   * places: the expanded reply-styled note (`.ai-dismissal-note`) and the
   * reasoning popover (via `data-dismissal-reason` on the brain buttons). Restore
   * paths only flip the `collapsed` class, so without this the reason survives on
   * a now-active suggestion.
   *
   * Shared by the line-level card (pr.js `restoreSuggestion`) and the file-level
   * card (file-comment-manager `restoreAISuggestion`), which have identical
   * reason markup.
   *
   * @param {HTMLElement|null} cardEl - The `.ai-suggestion` card element
   */
  function clearDismissalReasonUI(cardEl) {
    if (!cardEl) return;

    // Remove the expanded reply-styled note(s).
    cardEl.querySelectorAll('.ai-dismissal-note').forEach(el => el.remove());

    // Clear the stale reason from both reasoning-toggle buttons (expanded +
    // collapsed). A brain button that exists ONLY because of the reason (no
    // reasoning steps, so an empty data-reasoning) is removed entirely; one that
    // also carries reasoning steps stays but drops its Dismissal section.
    cardEl.querySelectorAll('.btn-reasoning-toggle').forEach(btn => {
      btn.removeAttribute('data-dismissal-reason');
      if (!btn.getAttribute('data-reasoning')) {
        btn.remove();
      }
    });
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

      // Signal the dismissed state via the collapsed-bar tooltip
      setCollapsedStateTooltip(suggestionDiv, 'Dismissed');

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
    DISMISSAL_NOTE_LABEL,
    POPOVER_DISMISSAL_HEADING,
    escapeReasonHtml,
    buildDismissalNoteHtml,
    buildReasoningPopoverContentHtml,
    setCollapsedStateTooltip,
    clearDismissalReasonUI,
    updateDismissedSuggestionUI
  };

  // Support CommonJS require() in unit tests (jsdom / vm sandbox) while keeping
  // the browser IIFE behavior of assigning to window.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.SuggestionUI;
  }
})();
