// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Repository Settings Page JavaScript
 * Handles loading, saving, and managing repository AI settings
 */

class RepoSettingsPage {
  constructor() {
    this.owner = null;
    this.repo = null;
    this.originalSettings = {};
    this.currentSettings = {};
    this.hasUnsavedChanges = false;
    this.providers = {};
    this.selectedProvider = null;
    this.councils = [];
    this.worktreeData = null;

    this.init();
  }

  async init() {
    // Parse URL to get owner/repo
    this.parseUrl();

    // Initialize theme
    this.initTheme();

    // Check for and display back to PR link
    this.initBackLink();

    // Setup event listeners
    this.setupEventListeners();

    // Load providers first (needed to render model cards)
    await this.loadProviders();

    // Load councils (for default council dropdown)
    await this.loadCouncils();

    // Load settings
    await this.loadSettings();

    // Load worktrees (non-blocking, section stays hidden on error)
    await this.loadWorktrees();
  }

  /**
   * Initialize back link if user navigated from a PR page or local review
   */
  initBackLink() {
    const backLink = document.getElementById('back-to-pr');
    const backLinkText = document.getElementById('back-to-pr-text');
    if (!backLink || !backLinkText) return;

    // Use scoped key to prevent collision between multiple tabs
    const referrerKey = `settingsReferrer:${this.owner}/${this.repo}`;

    try {
      const referrerData = localStorage.getItem(referrerKey);
      if (!referrerData) return;

      const data = JSON.parse(referrerData);

      // Check if this is a local review referrer
      if (data.type === 'local' && data.localReviewId) {
        backLink.href = `/local/${data.localReviewId}`;
        backLinkText.textContent = 'Return to Local Review';
        backLink.style.display = 'inline-flex';

        // Clear the referrer when clicking the back link
        backLink.addEventListener('click', () => {
          localStorage.removeItem(referrerKey);
        });
      } else if (data.prNumber) {
        // PR referrer - validate stored data matches current page context as sanity check
        // (Key is already scoped by repo, but this provides extra safety)
        if (data.owner && data.repo && (data.owner !== this.owner || data.repo !== this.repo)) {
          console.warn('PR referrer owner/repo mismatch - clearing stale data');
          localStorage.removeItem(referrerKey);
          return;
        }
        backLink.href = `/pr/${this.owner}/${this.repo}/${data.prNumber}`;
        backLinkText.textContent = `Return to PR #${data.prNumber}`;
        backLink.style.display = 'inline-flex';

        // Clear the referrer when clicking the back link
        backLink.addEventListener('click', () => {
          localStorage.removeItem(referrerKey);
        });
      }
      // No else clause needed - if format is unknown, just don't show the link
    } catch (error) {
      console.warn('Error parsing settings referrer:', error);
      localStorage.removeItem(referrerKey);
    }
  }

  parseUrl() {
    // URL format: /settings/:owner/:repo
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    if (pathParts.length >= 3 && pathParts[0] === 'settings') {
      this.owner = pathParts[1];
      this.repo = pathParts[2];
    } else {
      // Try query params as fallback
      const params = new URLSearchParams(window.location.search);
      this.owner = params.get('owner');
      this.repo = params.get('repo');
    }

    if (!this.owner || !this.repo) {
      this.showToast('error', 'Invalid repository URL');
      return;
    }

    // Update UI with repo name
    const repoFullName = `${this.owner}/${this.repo}`;
    document.getElementById('repo-name-breadcrumb').textContent = repoFullName;
    document.getElementById('repo-name-header').textContent = repoFullName;
    document.title = `Settings - ${repoFullName} - Pair Review`;
  }

  initTheme() {
    // Check for saved theme preference
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);

    // Theme toggle button
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
      });
    }
  }

  setupEventListeners() {
    // Provider select
    const providerSelect = document.getElementById('provider-select');
    if (providerSelect) {
      providerSelect.addEventListener('change', () => {
        const newProviderId = providerSelect.value;
        const previousProvider = this.selectedProvider;
        this.selectedProvider = newProviderId;
        this.currentSettings.default_provider = newProviderId;

        // Re-render model select for the new provider
        this.renderModelSelect();

        // Try to map the model tier to the new provider
        if (previousProvider && previousProvider !== newProviderId) {
          const oldProvider = this.providers[previousProvider];
          const newProvider = this.providers[newProviderId];

          if (oldProvider && newProvider) {
            const currentModel = oldProvider.models.find(m => m.id === this.currentSettings.default_model);
            if (currentModel) {
              const matchingModel = newProvider.models.find(m => m.tier === currentModel.tier);
              const defaultModel = newProvider.models.find(m => m.default);
              const fallbackModel = matchingModel || defaultModel || newProvider.models[0];
              this.currentSettings.default_model = fallbackModel.id;
            } else {
              const defaultModel = newProvider.models.find(m => m.default) || newProvider.models[0];
              this.currentSettings.default_model = defaultModel.id;
            }
          } else if (newProvider) {
            const defaultModel = newProvider.models.find(m => m.default) || newProvider.models[0];
            this.currentSettings.default_model = defaultModel.id;
          }

          // Update model select and card to reflect the mapped model
          const modelSelect = document.getElementById('model-select');
          if (modelSelect) {
            modelSelect.value = this.currentSettings.default_model;
          }
          this.renderModelCard();
        }

        this.checkForChanges();
      });
    }

    // Model select
    const modelSelect = document.getElementById('model-select');
    if (modelSelect) {
      modelSelect.addEventListener('change', () => {
        this.currentSettings.default_model = modelSelect.value;
        this.renderModelCard();
        this.checkForChanges();
      });
    }

    // Instructions textarea
    const textarea = document.getElementById('default-instructions');
    if (textarea) {
      textarea.addEventListener('input', () => {
        this.currentSettings.default_instructions = textarea.value;
        this.updateCharCount(textarea.value.length);
        this.checkForChanges();
      });
    }

    // Chat instructions textarea
    const chatTextarea = document.getElementById('chat-instructions');
    if (chatTextarea) {
      chatTextarea.addEventListener('input', () => {
        this.currentSettings.default_chat_instructions = chatTextarea.value;
        this.updateChatCharCount(chatTextarea.value.length);
        this.checkForChanges();
      });
    }

    // Analysis mode segmented control
    const modeToggle = document.getElementById('analysis-mode-toggle');
    if (modeToggle) {
      modeToggle.addEventListener('click', (e) => {
        const btn = e.target.closest('.mode-btn');
        if (!btn) return;
        this.setAnalysisMode(btn.dataset.mode);
      });
    }

    // Council custom dropdown listeners are attached in renderCouncilDropdown()

    // Form submission
    const form = document.getElementById('settings-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveSettings();
      });
    }

    // Cancel button
    const cancelBtn = document.getElementById('cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.handleCancel());
    }

    // Reset settings button
    const resetBtn = document.getElementById('reset-settings');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this.handleReset());
    }

    // Clear local path button
    const clearLocalPathBtn = document.getElementById('clear-local-path');
    if (clearLocalPathBtn) {
      clearLocalPathBtn.addEventListener('click', () => this.handleClearLocalPath());
    }

    // Worktree actions (delegated)
    const worktreesContent = document.getElementById('worktrees-content');
    if (worktreesContent) {
      worktreesContent.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.worktree-delete-btn');
        if (deleteBtn) {
          this.deleteWorktree(deleteBtn.dataset.worktreeId);
          return;
        }
        const deleteAllBtn = e.target.closest('.worktree-delete-all-btn');
        if (deleteAllBtn) {
          this.deleteAllWorktrees();
        }
      });
    }

    // Warn before leaving with unsaved changes
    window.addEventListener('beforeunload', (e) => {
      if (this.hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  /**
   * Load provider definitions from the backend API
   */
  async loadProviders() {
    try {
      const response = await fetch('/api/providers');
      if (!response.ok) {
        throw new Error('Failed to fetch providers');
      }

      const data = await response.json();

      // Convert array to object keyed by provider id
      // Filter out providers with no models configured (e.g., unconfigured OpenCode)
      this.providers = {};
      for (const provider of data.providers) {
        if (provider.models && provider.models.length > 0) {
          this.providers[provider.id] = provider;
        } else {
          console.warn(`Provider "${provider.name}" has no models configured and will not be available`);
        }
      }

      // Render provider buttons now that we have data
      this.renderProviderSelect();

    } catch (error) {
      console.error('Error loading providers:', error);
      // No hardcoded fallback — rely on the /api/providers endpoint as the single source of truth.
      // If the endpoint is unavailable, show an empty state rather than stale data.
      this.providers = {};
      this.renderProviderSelect();
      this.showToast('error', 'Failed to load AI providers. Please refresh the page.');
    }
  }

  /**
   * Load saved councils for the default council dropdown
   */
  async loadCouncils() {
    const container = document.getElementById('default-council-dropdown');
    if (!container) return;

    try {
      const response = await fetch('/api/councils');
      if (!response.ok) throw new Error('Failed to fetch councils');
      const data = await response.json();
      this.councils = data.councils || [];
    } catch (error) {
      console.error('Error loading councils:', error);
      this.councils = [];
    }
  }

  /**
   * Get the display label for a council type
   * @param {string} type - Council type ('council' or 'advanced')
   * @returns {{ label: string, cssClass: string }}
   */
  getCouncilTypeBadge(type) {
    if (type === 'advanced') {
      return { label: 'Advanced', cssClass: 'badge-advanced' };
    }
    return { label: 'Standard', cssClass: 'badge-standard' };
  }

  /**
   * Render the custom council dropdown
   */
  renderCouncilDropdown() {
    const container = document.getElementById('default-council-dropdown');
    if (!container) return;

    const selectedId = this.currentSettings.default_council_id || '';
    const selectedCouncil = this.councils.find(c => c.id === selectedId);

    // Build trigger display
    let triggerHTML;
    if (selectedCouncil) {
      const badge = this.getCouncilTypeBadge(selectedCouncil.type);
      triggerHTML = `<span class="trigger-text">${this.escapeHtml(selectedCouncil.name)}</span>
        <span class="council-type-badge ${badge.cssClass}">${badge.label}</span>`;
    } else if (this.councils.length > 0) {
      triggerHTML = '<span class="trigger-text placeholder">Select a council...</span>';
    } else {
      triggerHTML = '<span class="trigger-text placeholder">No councils yet — create one from the analysis config</span>';
    }

    // Build option list — sort alphabetically by name
    const sortedCouncils = [...this.councils].sort((a, b) =>
      (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
    );
    let optionsHTML = '';

    for (const council of sortedCouncils) {
      const badge = this.getCouncilTypeBadge(council.type);
      const isSelected = council.id === selectedId;
      optionsHTML += `<div class="custom-dropdown-option${isSelected ? ' selected' : ''}" data-value="${this.escapeHtml(council.id)}" role="option" aria-selected="${isSelected}">
        <span class="option-name">${this.escapeHtml(council.name)}</span>
        <span class="council-type-badge ${badge.cssClass}">${badge.label}</span>
      </div>`;
    }

    container.innerHTML = `
      <button type="button" class="custom-dropdown-trigger" aria-haspopup="listbox" aria-expanded="false">
        ${triggerHTML}
      </button>
      <div class="custom-dropdown-list" role="listbox">
        ${optionsHTML}
      </div>
    `;

    // Attach event listeners for the dropdown
    this.setupCouncilDropdownListeners(container);
  }

  /**
   * Set up event listeners for the custom council dropdown
   * @param {HTMLElement} container - The dropdown container element
   */
  setupCouncilDropdownListeners(container) {
    const trigger = container.querySelector('.custom-dropdown-trigger');
    const list = container.querySelector('.custom-dropdown-list');
    if (!trigger || !list) return;

    // Track focused option index for keyboard navigation
    let focusedIndex = -1;
    const getOptions = () => Array.from(list.querySelectorAll('.custom-dropdown-option'));

    const updateFocus = (options, index) => {
      options.forEach(opt => opt.classList.remove('focused'));
      if (index >= 0 && index < options.length) {
        options[index].classList.add('focused');
        options[index].scrollIntoView({ block: 'nearest' });
      }
    };

    // Toggle dropdown on trigger click
    trigger.addEventListener('click', () => {
      const isOpen = container.classList.contains('open');
      if (isOpen) {
        this.closeCouncilDropdown(container);
      } else {
        this.openCouncilDropdown(container);
        focusedIndex = -1;
      }
    });

    // Select option on click
    list.addEventListener('click', (e) => {
      const option = e.target.closest('.custom-dropdown-option');
      if (!option) return;
      this.selectCouncilOption(container, option.dataset.value);
    });

    // Keyboard navigation
    trigger.addEventListener('keydown', (e) => {
      const isOpen = container.classList.contains('open');

      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        this.closeCouncilDropdown(container);
        trigger.focus();
        return;
      }

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!isOpen) {
          this.openCouncilDropdown(container);
          focusedIndex = -1;
        } else {
          const options = getOptions();
          if (focusedIndex >= 0 && focusedIndex < options.length) {
            this.selectCouncilOption(container, options[focusedIndex].dataset.value);
          }
        }
        return;
      }

      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && isOpen) {
        e.preventDefault();
        const options = getOptions();
        if (e.key === 'ArrowDown') {
          focusedIndex = Math.min(focusedIndex + 1, options.length - 1);
        } else {
          focusedIndex = Math.max(focusedIndex - 1, 0);
        }
        updateFocus(options, focusedIndex);
        return;
      }

      // Open on arrow down when closed
      if (e.key === 'ArrowDown' && !isOpen) {
        e.preventDefault();
        this.openCouncilDropdown(container);
        focusedIndex = 0;
        updateFocus(getOptions(), focusedIndex);
      }
    });

    // Close on click outside (remove previous handler to avoid accumulation on re-render)
    if (this._councilDropdownOutsideClickHandler) {
      document.removeEventListener('click', this._councilDropdownOutsideClickHandler);
    }
    this._councilDropdownOutsideClickHandler = (e) => {
      if (!container.contains(e.target) && container.classList.contains('open')) {
        this.closeCouncilDropdown(container);
      }
    };
    document.addEventListener('click', this._councilDropdownOutsideClickHandler);
  }

  /**
   * Set the analysis mode (single model vs council) in the segmented control
   * @param {string} mode - 'single' or 'council'
   * @param {boolean} markChanged - Whether to trigger change detection (default true)
   */
  setAnalysisMode(mode, markChanged = true) {
    // Update button states
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.mode === mode);
    });
    // Show/hide panels
    const singlePanel = document.getElementById('mode-panel-single');
    const councilPanel = document.getElementById('mode-panel-council');
    const cardPreview = document.getElementById('model-card-preview');
    if (singlePanel) singlePanel.style.display = mode === 'single' ? '' : 'none';
    if (councilPanel) councilPanel.style.display = mode === 'council' ? '' : 'none';
    if (mode === 'single') {
      if (cardPreview) cardPreview.style.display = '';
      this.renderModelCard();
    } else {
      // Council mode: show council card if a council is selected
      const councilId = this.currentSettings.default_council_id;
      const council = councilId ? this.councils.find(c => c.id === councilId) : null;
      if (council && cardPreview) {
        cardPreview.style.display = '';
        this.renderCouncilCard(council);
      } else if (cardPreview) {
        cardPreview.style.display = 'none';
      }
    }
    // Map to default_tab: 'single' or 'council'
    this.currentSettings.default_tab = mode === 'council' ? 'council' : 'single';
    if (markChanged) {
      this.checkForChanges();
    }
  }

  /**
   * Open the custom council dropdown
   * @param {HTMLElement} container
   */
  openCouncilDropdown(container) {
    container.classList.add('open');
    const trigger = container.querySelector('.custom-dropdown-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
  }

  /**
   * Close the custom council dropdown
   * @param {HTMLElement} container
   */
  closeCouncilDropdown(container) {
    container.classList.remove('open');
    const trigger = container.querySelector('.custom-dropdown-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    // Clear focus highlights
    container.querySelectorAll('.custom-dropdown-option.focused').forEach(
      opt => opt.classList.remove('focused')
    );
  }

  /**
   * Select a council option in the custom dropdown
   * @param {HTMLElement} container
   * @param {string} value - Council ID or empty string for "None"
   */
  selectCouncilOption(container, value) {
    this.currentSettings.default_council_id = value || null;

    // Re-render the dropdown to update trigger display and selected state
    this.renderCouncilDropdown();
    this.closeCouncilDropdown(container);

    // Render council card preview or hide it
    const cardPreview = document.getElementById('model-card-preview');
    const council = value ? this.councils.find(c => c.id === value) : null;
    if (council && cardPreview) {
      cardPreview.style.display = '';
      this.renderCouncilCard(council);
    } else if (cardPreview) {
      cardPreview.style.display = 'none';
    }

    this.checkForChanges();
  }

  /**
   * Escape HTML to prevent XSS in dynamic content
   * @param {string} str
   * @returns {string}
   */
  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Render provider select dropdown
   */
  renderProviderSelect() {
    const select = document.getElementById('provider-select');
    if (!select) return;

    select.innerHTML = Object.entries(this.providers).map(([id, provider]) =>
      `<option value="${id}" ${id === this.selectedProvider ? 'selected' : ''}>${provider.name}</option>`
    ).join('');
  }

  /**
   * Set the selected provider (used by updateUI for initial load)
   */
  selectProvider(providerId) {
    if (!this.providers[providerId]) return;
    this.selectedProvider = providerId;
  }

  /**
   * Render model select dropdown for the currently selected provider
   */
  renderModelSelect() {
    const select = document.getElementById('model-select');
    if (!select) return;

    const provider = this.providers[this.selectedProvider];
    if (!provider) {
      select.innerHTML = '';
      this.renderModelCard();
      return;
    }

    select.innerHTML = provider.models.map(model =>
      `<option value="${model.id}" ${model.id === this.currentSettings.default_model ? 'selected' : ''}>${model.name}</option>`
    ).join('');

    this.renderModelCard();
  }

  /**
   * Render a model card preview for the currently selected provider + model.
   * Reuses the model-card design from the analysis config modal (styled in pr.css).
   */
  renderModelCard() {
    const container = document.getElementById('model-card-preview');
    if (!container) return;

    const provider = this.providers[this.selectedProvider];
    if (!provider) {
      container.innerHTML = '';
      return;
    }

    // Find the selected model, fall back to default or first
    const modelId = this.currentSettings.default_model;
    const model = provider.models.find(m => m.id === modelId)
      || provider.models.find(m => m.default)
      || provider.models[0];

    if (!model) {
      container.innerHTML = '';
      return;
    }

    const modelIcon = model.icon || (window.getTierIcon ? window.getTierIcon(model.tier) : '');

    container.innerHTML = `
      <div class="model-card selected settings-model-card-static" data-tier="${this.escapeHtml(model.tier || '')}">
        <div class="model-badge ${this.escapeHtml(model.badgeClass || '')}">${this.escapeHtml(model.badge || '')}</div>
        <div class="model-icon">${modelIcon}</div>
        <div class="model-info">
          <span class="model-name">${this.escapeHtml(model.name)}</span>
          <span class="model-tagline">${this.escapeHtml(model.tagline || '')}</span>
        </div>
        <p class="model-description">${this.escapeHtml(model.description || '')}</p>
      </div>
    `;
  }

  /**
   * Resolve provider/model IDs to display names using loaded provider data
   * @param {string} providerId
   * @param {string} modelId
   * @returns {{ providerName: string, modelName: string }}
   */
  resolveModelDisplay(providerId, modelId) {
    const provider = this.providers[providerId];
    if (!provider) {
      return { providerName: providerId || 'Unknown', modelName: modelId || 'Unknown' };
    }
    const model = provider.models?.find(m => m.id === modelId);
    return {
      providerName: provider.name,
      modelName: model ? model.name : (modelId || 'Unknown')
    };
  }

  /**
   * Render a council card preview into #model-card-preview
   * @param {object} council - Council object with id, name, type, config
   */
  renderCouncilCard(council) {
    if (!council) return;
    if (council.type === 'advanced') {
      this.renderAdvancedCouncilCard(council);
    } else {
      this.renderVoiceCouncilCard(council);
    }
  }

  /**
   * Render a standard (voice) council card
   * @param {object} council
   */
  renderVoiceCouncilCard(council) {
    const container = document.getElementById('model-card-preview');
    if (!container) return;

    const config = council.config || {};
    const voices = config.voices || [];
    const levels = config.levels || {};

    // Build summary: "Levels 1, 2" for enabled levels
    const enabledLevels = Object.entries(levels)
      .filter(([, enabled]) => enabled)
      .map(([level]) => level);
    const summaryText = enabledLevels.length > 0
      ? `Levels ${enabledLevels.join(', ')}`
      : 'No levels configured';

    // Build reviewer list
    const reviewerLines = voices.map(voice => {
      const display = this.resolveModelDisplay(voice.provider, voice.model);
      const tierLabel = voice.tier ? `<span class="council-card-tier">${this.escapeHtml(voice.tier)}</span>` : '';
      return `<div class="council-card-reviewer">
        <span class="council-card-reviewer-name">${this.escapeHtml(display.providerName)} / ${this.escapeHtml(display.modelName)}</span>
        ${tierLabel}
      </div>`;
    }).join('');

    // Build consolidation section
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

    container.innerHTML = `
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
   * Render an advanced council card with level-grouped reviewers
   * @param {object} council
   */
  renderAdvancedCouncilCard(council) {
    const container = document.getElementById('model-card-preview');
    if (!container) return;

    const config = council.config || {};
    const levels = config.levels || {};

    const levelLabels = {
      '1': 'Level 1 — Isolation',
      '2': 'Level 2 — File Context',
      '3': 'Level 3 — Codebase'
    };

    // Build level groups for enabled levels
    let levelGroupsHTML = '';
    for (const [levelNum, levelConfig] of Object.entries(levels)) {
      if (!levelConfig || !levelConfig.enabled) continue;
      const voices = levelConfig.voices || [];
      const header = levelLabels[levelNum] || `Level ${levelNum}`;
      const voiceLines = voices.map(voice => {
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

    // Build consolidation/orchestration section
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

    container.innerHTML = `
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

  async loadSettings() {
    if (!this.owner || !this.repo) return;

    try {
      const response = await fetch(`/api/repos/${this.owner}/${this.repo}/settings`);

      if (!response.ok) {
        throw new Error('Failed to load settings');
      }

      const settings = await response.json();

      // Store original settings for comparison
      this.originalSettings = {
        default_provider: settings.default_provider || null,
        default_model: settings.default_model || null,
        default_tab: settings.default_tab || 'single',
        default_council_id: settings.default_council_id || null,
        default_instructions: settings.default_instructions || '',
        local_path: settings.local_path || null,
        default_chat_instructions: settings.default_chat_instructions || '',
        pool_size: settings.pool_size ?? null,
        pool_fetch_interval_minutes: settings.pool_fetch_interval_minutes ?? null
      };

      // Set current settings
      this.currentSettings = { ...this.originalSettings };

      // Update UI
      this.updateUI();

    } catch (error) {
      console.error('Error loading settings:', error);
      // Use defaults if no settings exist
      this.originalSettings = {
        default_provider: null,
        default_model: null,
        default_tab: 'single',
        default_council_id: null,
        default_instructions: '',
        local_path: null,
        default_chat_instructions: '',
        pool_size: null,
        pool_fetch_interval_minutes: null
      };
      this.currentSettings = { ...this.originalSettings };
      this.updateUI();
    }
  }

  /**
   * Load worktree data for the current repository
   */
  async loadWorktrees() {
    if (!this.owner || !this.repo) return;

    try {
      const response = await fetch(`/api/repos/${this.owner}/${this.repo}/worktrees`);
      if (!response.ok) {
        throw new Error('Failed to load worktrees');
      }
      this.worktreeData = await response.json();

      // Seed pool settings from resolved config values when DB has no override
      const pool = this.worktreeData.pool || {};
      if (this.originalSettings.pool_size == null && pool.size) {
        this.originalSettings.pool_size = pool.size;
        this.currentSettings.pool_size = pool.size;
      }
      if (this.originalSettings.pool_fetch_interval_minutes == null && pool.fetch_interval_minutes) {
        this.originalSettings.pool_fetch_interval_minutes = pool.fetch_interval_minutes;
        this.currentSettings.pool_fetch_interval_minutes = pool.fetch_interval_minutes;
      }

      this.renderWorktrees();
    } catch (error) {
      console.error('Error loading worktrees:', error);
    }
  }

  /**
   * Render the worktrees section content
   */
  renderWorktrees() {
    const section = document.getElementById('worktrees-section');
    const content = document.getElementById('worktrees-content');
    if (!section || !content) return;

    if (!this.worktreeData) return;

    section.style.display = '';

    const pool = this.worktreeData.pool || {};
    const worktrees = this.worktreeData.worktrees || [];
    let html = '';

    // Pool settings (editable)
    const poolSizeValue = this.currentSettings.pool_size ?? '';
    const fetchIntervalValue = this.currentSettings.pool_fetch_interval_minutes ?? '';
    const currentCount = pool.current_count || 0;
    const countNote = poolSizeValue ? ` (${currentCount} active)` : '';

    html += `<div class="worktree-pool-config">
      <div class="worktree-pool-config-items">
        <div class="worktree-pool-config-item">
          <label class="worktree-pool-config-label" for="pool-size-input">Pool Size</label>
          <div class="worktree-pool-input-group">
            <input type="number" id="pool-size-input" class="worktree-pool-input"
              min="0" max="20" step="1" placeholder="0"
              value="${this.escapeHtml(String(poolSizeValue))}">
            <span class="worktree-pool-input-note">${this.escapeHtml(countNote)}</span>
          </div>
        </div>
        <div class="worktree-pool-config-item">
          <label class="worktree-pool-config-label" for="pool-fetch-interval-input">Fetch Interval</label>
          <div class="worktree-pool-input-group">
            <input type="number" id="pool-fetch-interval-input" class="worktree-pool-input"
              min="0" max="1440" step="1" placeholder="Off"
              value="${this.escapeHtml(String(fetchIntervalValue))}">
            <span class="worktree-pool-input-note">minutes</span>
          </div>
        </div>
      </div>
      <p class="worktree-pool-hint">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm6.5-.25A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75zM8 6a1 1 0 100-2 1 1 0 000 2z"/></svg>
        Pre-warms worktrees so PR reviews start instantly. Set size to 0 to disable.
      </p>
    </div>`;

    // Worktree list
    if (worktrees.length > 0) {
      html += '<div class="worktree-list">';
      for (const wt of worktrees) {
        const badgeHtml = wt.is_pool
          ? '<span class="worktree-pool-badge">Pool</span>'
          : '<span class="worktree-adhoc-badge">Ad-hoc</span>';
        const prInfo = wt.pr_number ? '#' + wt.pr_number : 'Unassigned';
        const branchInfo = wt.branch ? ' &middot; ' + this.escapeHtml(wt.branch) : '';
        const fullPath = wt.path || '';
        const diskWarning = !wt.disk_exists
          ? '<span class="worktree-disk-warning">Missing from disk</span>'
          : '';
        const statusIcon = this.getWorktreeStatusIcon(wt.status);
        const statusLabel = this.getWorktreeStatusLabel(wt.status);
        const fetchedHtml = wt.last_fetched_at
          ? `<span class="worktree-timestamp">Fetched ${this.formatRelativeTime(wt.last_fetched_at)}</span>`
          : '';

        html += `<div class="worktree-item">
          <div class="worktree-item-top">
            <div class="worktree-item-left">
              ${badgeHtml}
              <span class="worktree-pr-info">${prInfo}${branchInfo}</span>
              ${diskWarning}
            </div>
            <div class="worktree-item-right">
              <span class="worktree-status worktree-status--${this.escapeHtml(wt.status || 'unknown')}">
                ${statusIcon} ${statusLabel}
              </span>
              ${fetchedHtml}
              <button class="worktree-delete-btn" data-worktree-id="${this.escapeHtml(wt.id)}" title="Delete worktree">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19a1.75 1.75 0 001.741-1.575l.66-6.6a.75.75 0 00-1.492-.15l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="worktree-item-bottom">
            <span class="worktree-path">${this.escapeHtml(fullPath)}</span>
          </div>
        </div>`;
      }
      html += '</div>';

      // Delete all button
      html += `<div class="worktree-actions">
        <button class="worktree-delete-all-btn">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19a1.75 1.75 0 001.741-1.575l.66-6.6a.75.75 0 00-1.492-.15l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"/>
          </svg>
          Delete All Worktrees
        </button>
      </div>`;
    } else {
      html += '<div class="worktree-empty">No worktrees found for this repository.</div>';
    }

    content.innerHTML = html;

    // Wire up pool setting inputs
    const poolSizeInput = document.getElementById('pool-size-input');
    if (poolSizeInput) {
      poolSizeInput.addEventListener('input', () => {
        const val = poolSizeInput.value.trim();
        this.currentSettings.pool_size = val === '' ? null : parseInt(val, 10);
        this.checkForChanges();
      });
    }
    const poolFetchInput = document.getElementById('pool-fetch-interval-input');
    if (poolFetchInput) {
      poolFetchInput.addEventListener('input', () => {
        const val = poolFetchInput.value.trim();
        this.currentSettings.pool_fetch_interval_minutes = val === '' ? null : parseInt(val, 10);
        this.checkForChanges();
      });
    }
  }

  /**
   * Get the SVG icon for a worktree status
   * @param {string} status
   * @returns {string} Inline SVG string
   */
  getWorktreeStatusIcon(status) {
    switch (status) {
      case 'available':
        return '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="4" fill="#2da44e"/></svg>';
      case 'in_use':
        return '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4a4 4 0 0 1 8 0v2h.25c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-5.5C2 6.784 2.784 6 3.75 6H4Zm8.25 3.5h-8.5a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25ZM10.5 6V4a2.5 2.5 0 1 0-5 0v2Z"/></svg>';
      case 'switching':
        return '<svg class="worktree-icon-spin" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.5 5.5 0 00-5.23 3.79.75.75 0 01-1.42-.48A7.001 7.001 0 0115 8a7 7 0 01-13.65 2.19.75.75 0 011.42-.48A5.5 5.5 0 108 2.5z"/></svg>';
      case 'creating':
        return '<svg class="worktree-icon-spin" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5a5.5 5.5 0 00-5.23 3.79.75.75 0 01-1.42-.48A7.001 7.001 0 0115 8a7 7 0 01-13.65 2.19.75.75 0 011.42-.48A5.5 5.5 0 108 2.5z"/></svg>';
      case 'active':
        return '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="4" fill="#0969da"/></svg>';
      default:
        return '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="4" fill="#8b949e"/></svg>';
    }
  }

  /**
   * Get the display label for a worktree status
   * @param {string} status
   * @returns {string}
   */
  getWorktreeStatusLabel(status) {
    switch (status) {
      case 'available': return 'Available';
      case 'in_use': return 'In use';
      case 'switching': return 'Switching';
      case 'creating': return 'Creating';
      case 'active': return 'Active';
      default: return status || 'Unknown';
    }
  }



  /**
   * Format an ISO timestamp as a human-readable relative time string
   * @param {string} isoString
   * @returns {string}
   */
  formatRelativeTime(isoString) {
    if (!isoString) return '';
    const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    return days + 'd ago';
  }

  /**
   * Delete a single worktree by ID
   * @param {string} worktreeId
   */
  async deleteWorktree(worktreeId) {
    if (!confirm('Delete this worktree? This removes it from disk and cannot be undone.')) return;

    try {
      const response = await fetch(`/api/repos/${this.owner}/${this.repo}/worktrees/${worktreeId}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete worktree');
      }
      this.showToast('success', 'Worktree deleted');
      await this.loadWorktrees();
    } catch (error) {
      this.showToast('error', 'Failed to delete worktree: ' + error.message);
    }
  }

  /**
   * Delete all worktrees for the current repository
   */
  async deleteAllWorktrees() {
    const count = this.worktreeData && this.worktreeData.worktrees
      ? this.worktreeData.worktrees.length
      : 0;
    if (!confirm(`Delete all ${count} worktree(s)? This removes them from disk and cannot be undone.`)) return;

    try {
      const response = await fetch(`/api/repos/${this.owner}/${this.repo}/worktrees`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete worktrees');
      }
      const data = await response.json();
      this.showToast('success', `Deleted ${data.deleted} worktree(s)`);
      await this.loadWorktrees();
    } catch (error) {
      this.showToast('error', 'Failed to delete worktrees: ' + error.message);
    }
  }

  updateUI() {
    // Update provider selection - validate provider exists before selecting
    let providerId = this.currentSettings.default_provider;
    const availableProviders = Object.keys(this.providers);

    if (!providerId || !this.providers[providerId]) {
      // Provider doesn't exist, fall back to first available
      // Update both settings so no false dirty state on load
      providerId = availableProviders[0] || 'claude';
      this.currentSettings.default_provider = providerId;
      this.originalSettings.default_provider = providerId;
    }

    this.selectProvider(providerId);
    this.renderProviderSelect();

    // Validate saved model exists in current provider
    const provider = this.providers[this.selectedProvider];
    if (provider) {
      const modelExists = provider.models.some(m => m.id === this.currentSettings.default_model);
      if (!modelExists) {
        const fallbackModel = provider.models.find(m => m.default) || provider.models[0];
        if (fallbackModel) {
          this.currentSettings.default_model = fallbackModel.id;
          this.originalSettings.default_model = fallbackModel.id;
          const modelSelect = document.getElementById('model-select');
          if (modelSelect) modelSelect.value = fallbackModel.id;
        }
      }
    }

    this.renderModelSelect();

    // Update analysis mode segmented control (map 'advanced' to 'council')
    const defaultTab = this.currentSettings.default_tab || 'single';
    const mode = (defaultTab === 'council' || defaultTab === 'advanced') ? 'council' : 'single';
    this.setAnalysisMode(mode, false);

    // Update council custom dropdown
    this.renderCouncilDropdown();

    // Update instructions textarea
    const textarea = document.getElementById('default-instructions');
    if (textarea) {
      textarea.value = this.currentSettings.default_instructions || '';
      this.updateCharCount(textarea.value.length);
    }

    // Update chat instructions textarea
    const chatTextarea = document.getElementById('chat-instructions');
    if (chatTextarea) {
      chatTextarea.value = this.currentSettings.default_chat_instructions || '';
      this.updateChatCharCount(chatTextarea.value.length);
    }

    // Update local path display
    this.updateLocalPathDisplay();

    // Update pool setting inputs
    const poolSizeInput = document.getElementById('pool-size-input');
    if (poolSizeInput) {
      poolSizeInput.value = this.currentSettings.pool_size ?? '';
    }
    const poolFetchInput = document.getElementById('pool-fetch-interval-input');
    if (poolFetchInput) {
      poolFetchInput.value = this.currentSettings.pool_fetch_interval_minutes ?? '';
    }
  }

  /**
   * Update the local path display section
   */
  updateLocalPathDisplay() {
    const localPathValue = document.getElementById('local-path-value');
    const clearLocalPathBtn = document.getElementById('clear-local-path');
    const localPathHint = document.getElementById('local-path-hint');

    if (!localPathValue) return;

    const localPath = this.currentSettings.local_path;

    if (localPath) {
      localPathValue.textContent = localPath;
      localPathValue.classList.add('has-value');
      if (clearLocalPathBtn) clearLocalPathBtn.style.display = 'inline-flex';
      if (localPathHint) localPathHint.style.display = 'none';
    } else {
      localPathValue.textContent = 'Not set';
      localPathValue.classList.remove('has-value');
      if (clearLocalPathBtn) clearLocalPathBtn.style.display = 'none';
      if (localPathHint) localPathHint.style.display = 'flex';
    }
  }

  updateCharCount(count) {
    const charCountEl = document.getElementById('char-count');
    if (charCountEl) {
      charCountEl.textContent = count;
    }
  }

  updateChatCharCount(count) {
    const charCountEl = document.getElementById('chat-char-count');
    if (charCountEl) {
      charCountEl.textContent = count;
    }
  }

  checkForChanges() {
    // Use nullish coalescing to normalize null/undefined for consistent comparison
    const providerChanged = (this.currentSettings.default_provider ?? null) !== (this.originalSettings.default_provider ?? null);
    const modelChanged = (this.currentSettings.default_model ?? null) !== (this.originalSettings.default_model ?? null);
    const tabChanged = (this.currentSettings.default_tab ?? 'single') !== (this.originalSettings.default_tab ?? 'single');
    const councilChanged = (this.currentSettings.default_council_id ?? null) !== (this.originalSettings.default_council_id ?? null);
    const instructionsChanged = (this.currentSettings.default_instructions ?? '') !== (this.originalSettings.default_instructions ?? '');
    const chatInstructionsChanged = (this.currentSettings.default_chat_instructions ?? '') !== (this.originalSettings.default_chat_instructions ?? '');
    const poolSizeChanged = (this.currentSettings.pool_size ?? null) !== (this.originalSettings.pool_size ?? null);
    const poolFetchChanged = (this.currentSettings.pool_fetch_interval_minutes ?? null) !== (this.originalSettings.pool_fetch_interval_minutes ?? null);

    this.hasUnsavedChanges = providerChanged || modelChanged || tabChanged || councilChanged || instructionsChanged || chatInstructionsChanged || poolSizeChanged || poolFetchChanged;

    // Show/hide action bar
    const actionBar = document.getElementById('action-bar');
    if (actionBar) {
      actionBar.classList.toggle('visible', this.hasUnsavedChanges);
    }
  }

  async saveSettings() {
    if (!this.owner || !this.repo) return;

    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = `
        <svg class="spinner" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0a8 8 0 018 8h-2a6 6 0 00-6-6V0z"/>
        </svg>
        Saving...
      `;
    }

    try {
      const response = await fetch(`/api/repos/${this.owner}/${this.repo}/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          default_provider: this.currentSettings.default_provider,
          default_model: this.currentSettings.default_model,
          default_tab: this.currentSettings.default_tab,
          default_council_id: this.currentSettings.default_council_id,
          default_instructions: this.currentSettings.default_instructions,
          default_chat_instructions: this.currentSettings.default_chat_instructions,
          pool_size: this.currentSettings.pool_size,
          pool_fetch_interval_minutes: this.currentSettings.pool_fetch_interval_minutes
        })
      });

      if (!response.ok) {
        throw new Error('Failed to save settings');
      }

      // Update original settings
      this.originalSettings = { ...this.currentSettings };
      this.hasUnsavedChanges = false;

      // Hide action bar
      const actionBar = document.getElementById('action-bar');
      if (actionBar) {
        actionBar.classList.remove('visible');
      }

      this.showToast('success', 'Settings saved successfully');

    } catch (error) {
      console.error('Error saving settings:', error);
      this.showToast('error', 'Failed to save settings. Please try again.');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>
          </svg>
          Save Settings
        `;
      }
    }
  }

  handleCancel() {
    if (this.hasUnsavedChanges) {
      const confirmed = confirm('You have unsaved changes. Are you sure you want to discard them?');
      if (!confirmed) return;
    }

    // Reset to original settings
    this.currentSettings = { ...this.originalSettings };
    this.hasUnsavedChanges = false;
    this.updateUI();

    // Hide action bar
    const actionBar = document.getElementById('action-bar');
    if (actionBar) {
      actionBar.classList.remove('visible');
    }
  }

  async handleReset() {
    const confirmed = confirm(
      'This will remove all custom settings for this repository. The default provider and model will not be pre-selected and no default instructions will be used. Continue?'
    );

    if (!confirmed) return;

    try {
      // For now, just clear the settings by saving empty values
      const response = await fetch(`/api/repos/${this.owner}/${this.repo}/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          default_provider: null,
          default_model: null,
          default_tab: null,
          default_council_id: null,
          default_instructions: '',
          local_path: null,
          default_chat_instructions: '',
          pool_size: null,
          pool_fetch_interval_minutes: null
        })
      });

      if (!response.ok) {
        throw new Error('Failed to reset settings');
      }

      // Clear all settings
      this.originalSettings = {
        default_provider: null,
        default_model: null,
        default_tab: 'single',
        default_council_id: null,
        default_instructions: '',
        local_path: null,
        default_chat_instructions: '',
        pool_size: null,
        pool_fetch_interval_minutes: null
      };
      this.currentSettings = { ...this.originalSettings };
      this.hasUnsavedChanges = false;

      // Update UI using updateUI() which handles all the display logic
      this.updateUI();

      // Hide action bar
      const actionBar = document.getElementById('action-bar');
      if (actionBar) {
        actionBar.classList.remove('visible');
      }

      this.showToast('success', 'Settings reset to defaults');

    } catch (error) {
      console.error('Error resetting settings:', error);
      this.showToast('error', 'Failed to reset settings. Please try again.');
    }
  }

  /**
   * Handle clearing the local repository path
   */
  async handleClearLocalPath() {
    const confirmed = confirm(
      'This will clear the registered repository location. The next web UI review will need to clone the repository unless you run pair-review from the CLI again. Continue?'
    );

    if (!confirmed) return;

    try {
      const response = await fetch(`/api/repos/${this.owner}/${this.repo}/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          local_path: null
        })
      });

      if (!response.ok) {
        throw new Error('Failed to clear local path');
      }

      // Update settings
      this.originalSettings.local_path = null;
      this.currentSettings.local_path = null;

      // Update local path display
      this.updateLocalPathDisplay();

      this.showToast('success', 'Repository location cleared');

    } catch (error) {
      console.error('Error clearing local path:', error);
      this.showToast('error', 'Failed to clear repository location. Please try again.');
    }
  }

  showToast(type, message) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <div class="toast-icon">
        ${type === 'success'
          ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 11-2 0 1 1 0 012 0zM6.92 6.085c.081-.16.19-.299.34-.398.145-.097.371-.187.74-.187.302 0 .558.066.743.205a.677.677 0 01.26.514c0 .217-.062.376-.15.495-.083.112-.216.22-.436.345-.205.119-.36.234-.479.364a.788.788 0 00-.19.478v.413a.75.75 0 101.5 0v-.124c0-.05.024-.1.067-.14.052-.047.154-.113.333-.19.188-.083.37-.196.523-.35a1.724 1.724 0 00.437-1.18c0-.515-.177-.914-.504-1.199-.331-.289-.78-.447-1.3-.447-.531 0-.978.164-1.307.465-.323.295-.496.682-.558 1.093a.75.75 0 001.474.28.327.327 0 01.029-.073zM9 11a1 1 0 11-2 0 1 1 0 012 0z"/></svg>'
        }
      </div>
      <span class="toast-message">${message}</span>
      <button class="toast-close" onclick="this.parentElement.remove()">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
        </svg>
      </button>
    `;

    container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    // Auto-remove after 5 seconds
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.repoSettings = new RepoSettingsPage();
});
