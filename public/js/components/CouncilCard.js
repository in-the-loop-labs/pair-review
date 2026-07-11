// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * CouncilCard — a shared council composition preview.
 *
 * Extracted from the repo-settings page so the global settings page can show the
 * same "what does this council run" preview (reviewers/models, levels, and
 * consolidation) when a council is chosen as the Default for Analysis. It renders
 * into a caller-supplied container and dispatches on council type
 * (voice/standard vs. advanced), exactly like the original.
 *
 * Provider/model id → display-name resolution differs per page (repo settings
 * keys providers by id; the global settings page holds an array from
 * /api/providers), so the consumer injects a `resolveModelDisplay(providerId,
 * modelId) => { providerName, modelName }` callback rather than the component
 * reaching for page-specific data.
 *
 * Consumers:
 *   - public/js/repo-settings.js — renderVoiceCouncilCard / renderAdvancedCouncilCard
 *     delegate here; resolveModelDisplay uses its own alias-aware lookup.
 *   - public/js/settings.js — renders the preview beneath the "Default for
 *     Analysis" dropdown when a council is selected.
 *
 * CSS classes (.council-card*) live in public/css/council-card.css (loaded by
 * both pages). The component only sets innerHTML + calls the injected resolver,
 * so it also runs under the repo-settings mock-DOM unit tests.
 */

class CouncilCard {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.container - Element to render the card into.
   * @param {Function} [opts.resolveModelDisplay] - (providerId, modelId) =>
   *   { providerName, modelName }. Defaults to echoing the raw ids.
   */
  constructor(opts = {}) {
    this.container = opts.container;
    this.resolveModelDisplay = typeof opts.resolveModelDisplay === 'function'
      ? opts.resolveModelDisplay
      : (providerId, modelId) => ({
          providerName: providerId || 'Unknown',
          modelName: modelId || 'Unknown'
        });
  }

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /** Empty the container. */
  clear() {
    if (this.container) this.container.innerHTML = '';
  }

  /**
   * Render the preview for `council`, dispatching by type. A falsy council
   * clears the container.
   * @param {Object|null} council - { id, name, type, config }
   */
  render(council) {
    if (!this.container) return;
    if (!council) {
      this.clear();
      return;
    }
    if (council.type === 'advanced') {
      this.renderAdvanced(council);
    } else {
      this.renderVoice(council);
    }
  }

  /**
   * Render a standard (voice-centric) council card.
   * @param {Object} council
   */
  renderVoice(council) {
    if (!this.container) return;

    const config = council.config || {};
    const voices = config.voices || [];
    const levels = config.levels || {};

    // Build summary: "Levels 1, 2" for enabled levels.
    const enabledLevels = Object.entries(levels)
      .filter(([, enabled]) => enabled)
      .map(([level]) => level);
    const summaryText = enabledLevels.length > 0
      ? `Levels ${enabledLevels.join(', ')}`
      : 'No levels configured';

    const reviewerLines = voices.map((voice) => {
      const display = this.resolveModelDisplay(voice.provider, voice.model);
      const tierLabel = voice.tier ? `<span class="council-card-tier">${this.escapeHtml(voice.tier)}</span>` : '';
      return `<div class="council-card-reviewer">
        <span class="council-card-reviewer-name">${this.escapeHtml(display.providerName)} / ${this.escapeHtml(display.modelName)}</span>
        ${tierLabel}
      </div>`;
    }).join('');

    let consolidationHTML = '';
    if (config.consolidation && config.consolidation.provider) {
      const consolDisplay = this.resolveModelDisplay(config.consolidation.provider, config.consolidation.model);
      const consolTier = config.consolidation.tier ? `<span class="council-card-tier">${this.escapeHtml(config.consolidation.tier)}</span>` : '';
      consolidationHTML = `
        <div class="council-card-divider"></div>
        <div class="council-card-consolidation">
          <div class="council-card-consolidation-label">Consolidation</div>
          <div class="council-card-reviewer">
            <span class="council-card-reviewer-name">${this.escapeHtml(consolDisplay.providerName)} / ${this.escapeHtml(consolDisplay.modelName)}</span>
            ${consolTier}
          </div>
        </div>`;
    }

    this.container.innerHTML = `
      <div class="council-card">
        <div class="council-card-name">${this.escapeHtml(council.name)}</div>
        <div class="council-card-summary">${summaryText}</div>
        <div class="council-card-reviewers">
          ${reviewerLines}
        </div>
        ${consolidationHTML}
      </div>
    `;
  }

  /**
   * Render an advanced council card with level-grouped reviewers.
   * @param {Object} council
   */
  renderAdvanced(council) {
    if (!this.container) return;

    const config = council.config || {};
    const levels = config.levels || {};

    const levelLabels = {
      '1': 'Level 1 — Isolation',
      '2': 'Level 2 — File Context',
      '3': 'Level 3 — Codebase'
    };

    let levelGroupsHTML = '';
    for (const [levelNum, levelConfig] of Object.entries(levels)) {
      if (!levelConfig || !levelConfig.enabled) continue;
      const voices = levelConfig.voices || [];
      const header = levelLabels[levelNum] || `Level ${levelNum}`;
      const voiceLines = voices.map((voice) => {
        const display = this.resolveModelDisplay(voice.provider, voice.model);
        const tierLabel = voice.tier ? `<span class="council-card-tier">${this.escapeHtml(voice.tier)}</span>` : '';
        return `<div class="council-card-reviewer">
          <span class="council-card-reviewer-name">${this.escapeHtml(display.providerName)} / ${this.escapeHtml(display.modelName)}</span>
          ${tierLabel}
        </div>`;
      }).join('');
      levelGroupsHTML += `
        <div class="council-card-level-header">${this.escapeHtml(header)}</div>
        ${voiceLines}`;
    }

    let consolidationHTML = '';
    if (config.consolidation && config.consolidation.provider) {
      const consolDisplay = this.resolveModelDisplay(config.consolidation.provider, config.consolidation.model);
      const consolTier = config.consolidation.tier ? `<span class="council-card-tier">${this.escapeHtml(config.consolidation.tier)}</span>` : '';
      consolidationHTML = `
        <div class="council-card-divider"></div>
        <div class="council-card-consolidation">
          <div class="council-card-consolidation-label">Orchestration</div>
          <div class="council-card-reviewer">
            <span class="council-card-reviewer-name">${this.escapeHtml(consolDisplay.providerName)} / ${this.escapeHtml(consolDisplay.modelName)}</span>
            ${consolTier}
          </div>
        </div>`;
    }

    this.container.innerHTML = `
      <div class="council-card">
        <div class="council-card-name">
          ${this.escapeHtml(council.name)}
          <span class="council-card-badge-advanced">Advanced</span>
        </div>
        <div class="council-card-reviewers">
          ${levelGroupsHTML}
        </div>
        ${consolidationHTML}
      </div>
    `;
  }
}

// Browser global for the pages that load this before their page script.
if (typeof window !== 'undefined') {
  window.CouncilCard = CouncilCard;
}

// Export for unit tests, following the repo's component export pattern.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CouncilCard };
}
