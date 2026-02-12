// SPDX-License-Identifier: GPL-3.0-or-later
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

    // Build option list
    let optionsHTML = '';

    for (const council of this.councils) {
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
    if (cardPreview) cardPreview.style.display = mode === 'single' ? '' : 'none';
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

    const tierIcon = window.getTierIcon ? window.getTierIcon(model.tier) : '';

    container.innerHTML = `
      <div class="model-card selected settings-model-card-static" data-tier="${this.escapeHtml(model.tier || '')}">
        <div class="model-badge ${this.escapeHtml(model.badgeClass || '')}">${this.escapeHtml(model.badge || '')}</div>
        <div class="model-icon">${tierIcon}</div>
        <div class="model-info">
          <span class="model-name">${this.escapeHtml(model.name)}</span>
          <span class="model-tagline">${this.escapeHtml(model.tagline || '')}</span>
        </div>
        <p class="model-description">${this.escapeHtml(model.description || '')}</p>
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
        local_path: settings.local_path || null
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
        local_path: null
      };
      this.currentSettings = { ...this.originalSettings };
      this.updateUI();
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

    // Update local path display
    this.updateLocalPathDisplay();
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

  checkForChanges() {
    // Use nullish coalescing to normalize null/undefined for consistent comparison
    const providerChanged = (this.currentSettings.default_provider ?? null) !== (this.originalSettings.default_provider ?? null);
    const modelChanged = (this.currentSettings.default_model ?? null) !== (this.originalSettings.default_model ?? null);
    const tabChanged = (this.currentSettings.default_tab ?? 'single') !== (this.originalSettings.default_tab ?? 'single');
    const councilChanged = (this.currentSettings.default_council_id ?? null) !== (this.originalSettings.default_council_id ?? null);
    const instructionsChanged = (this.currentSettings.default_instructions ?? '') !== (this.originalSettings.default_instructions ?? '');

    this.hasUnsavedChanges = providerChanged || modelChanged || tabChanged || councilChanged || instructionsChanged;

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
          default_instructions: this.currentSettings.default_instructions
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
          local_path: null
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
        local_path: null
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
