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

    try {
      const referrerData = localStorage.getItem('settingsReferrer');
      if (!referrerData) return;

      const data = JSON.parse(referrerData);

      // Check if this is a local review referrer
      if (data.type === 'local' && data.localReviewId) {
        // Only show the link if it matches the current repo
        if (data.owner === this.owner && data.repo === this.repo) {
          backLink.href = `/local/${data.localReviewId}`;
          backLinkText.textContent = 'Return to Local Review';
          backLink.style.display = 'inline-flex';

          // Clear the referrer when clicking the back link
          backLink.addEventListener('click', () => {
            localStorage.removeItem('settingsReferrer');
          });
        } else {
          // Different repo, clear the stale referrer
          localStorage.removeItem('settingsReferrer');
        }
      } else if (data.prNumber) {
        // PR referrer (original behavior)
        const { prNumber, owner, repo } = data;

        // Only show the link if it matches the current repo
        if (owner === this.owner && repo === this.repo && prNumber) {
          backLink.href = `/pr/${owner}/${repo}/${prNumber}`;
          backLinkText.textContent = `Return to PR #${prNumber}`;
          backLink.style.display = 'inline-flex';

          // Clear the referrer when clicking the back link
          backLink.addEventListener('click', () => {
            localStorage.removeItem('settingsReferrer');
          });
        } else {
          // Different repo, clear the stale referrer
          localStorage.removeItem('settingsReferrer');
        }
      } else {
        // Unknown referrer format, clear it
        localStorage.removeItem('settingsReferrer');
      }
    } catch (error) {
      console.warn('Error parsing settings referrer:', error);
      localStorage.removeItem('settingsReferrer');
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
    // Model card and provider button listeners are attached dynamically
    // when renderProviderButtons() and renderModelCards() are called

    // Instructions textarea
    const textarea = document.getElementById('default-instructions');
    if (textarea) {
      textarea.addEventListener('input', () => {
        this.currentSettings.default_instructions = textarea.value;
        this.updateCharCount(textarea.value.length);
        this.checkForChanges();
      });
    }

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
      this.providers = {};
      for (const provider of data.providers) {
        this.providers[provider.id] = provider;
      }

      // Render provider buttons now that we have data
      this.renderProviderButtons();

    } catch (error) {
      console.error('Error loading providers:', error);
      // Last-resort degraded mode: hardcoded Claude fallback when the /api/providers
      // endpoint is unavailable. This allows basic functionality even if the backend
      // is partially broken. The canonical provider definitions live in
      // src/ai/claude-provider.js - this fallback should mirror those values.
      this.providers = {
        claude: {
          id: 'claude',
          name: 'Claude',
          models: [
            { id: 'haiku', name: 'Haiku', tier: 'fast', badge: 'Fastest', badgeClass: 'badge-speed', tagline: 'Lightning Fast', description: 'Quick analysis for simple changes' },
            { id: 'sonnet', name: 'Sonnet', tier: 'balanced', default: true, badge: 'Recommended', badgeClass: 'badge-recommended', tagline: 'Best Balance', description: 'Recommended for most reviews' },
            { id: 'opus', name: 'Opus', tier: 'thorough', badge: 'Most Thorough', badgeClass: 'badge-power', tagline: 'Most Capable', description: 'Deep analysis for complex code' }
          ],
          defaultModel: 'sonnet'
        }
      };
      this.renderProviderButtons();
    }
  }

  /**
   * Render provider toggle buttons
   */
  renderProviderButtons() {
    const container = document.getElementById('provider-toggle');
    if (!container) return;

    const providerIds = Object.keys(this.providers);
    container.innerHTML = providerIds.map(providerId => {
      const provider = this.providers[providerId];
      return `
        <button type="button" class="provider-btn ${providerId === this.selectedProvider ? 'selected' : ''}" data-provider="${providerId}">
          ${provider.name}
        </button>
      `;
    }).join('');

    // Attach event listeners
    container.querySelectorAll('.provider-btn').forEach(btn => {
      btn.addEventListener('click', () => this.selectProvider(btn.dataset.provider));
    });
  }

  /**
   * Select a provider and update model cards
   */
  selectProvider(providerId, markAsChanged = true) {
    if (!this.providers[providerId]) return;

    const previousProvider = this.selectedProvider;
    this.selectedProvider = providerId;

    if (markAsChanged) {
      this.currentSettings.default_provider = providerId;
    }

    // Update provider buttons UI
    document.querySelectorAll('.provider-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.provider === providerId);
    });

    // Re-render model cards for the new provider
    this.renderModelCards();

    // If provider changed and we're tracking changes, try to map the model to the new provider
    if (markAsChanged && previousProvider && previousProvider !== providerId) {
      const oldProvider = this.providers[previousProvider];
      const newProvider = this.providers[providerId];

      // If old provider no longer exists (e.g., was removed from available providers),
      // fall back to the new provider's default model
      if (!oldProvider) {
        const defaultModel = newProvider.models.find(m => m.default) || newProvider.models[0];
        this.selectModel(defaultModel.id, markAsChanged);
        this.checkForChanges();
        return;
      }

      // Find the model with same tier as currently selected
      const currentModel = oldProvider.models.find(m => m.id === this.currentSettings.default_model);

      if (currentModel) {
        const matchingModel = newProvider.models.find(m => m.tier === currentModel.tier);
        const defaultModel = newProvider.models.find(m => m.default);
        const fallbackModel = matchingModel || defaultModel || newProvider.models[0];

        if (!matchingModel && !defaultModel) {
          console.warn(`No matching tier or default model found for provider "${providerId}", using first available model`);
        }

        this.selectModel(fallbackModel.id, markAsChanged);
      } else {
        // No current model selected, use default for new provider
        const defaultModel = newProvider.models.find(m => m.default) || newProvider.models[0];
        this.selectModel(defaultModel.id, markAsChanged);
      }

      this.checkForChanges();
    }
  }

  /**
   * Render model cards for the currently selected provider
   */
  renderModelCards() {
    const container = document.getElementById('model-cards');
    if (!container) return;

    const provider = this.providers[this.selectedProvider];
    if (!provider) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = provider.models.map(model => `
      <button type="button" class="model-card ${model.id === this.currentSettings.default_model ? 'selected' : ''}" data-model="${model.id}" data-tier="${model.tier}">
        <div class="model-badge ${model.badgeClass || ''}">${model.badge || ''}</div>
        <div class="model-icon">${this.getModelIcon(model.tier)}</div>
        <div class="model-info">
          <span class="model-name">${model.name}</span>
          <span class="model-tagline">${model.tagline || ''}</span>
        </div>
        <p class="model-description">${model.description || ''}</p>
        <div class="model-selected-indicator">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>
          </svg>
        </div>
      </button>
    `).join('');

    // Attach event listeners
    container.querySelectorAll('.model-card').forEach(card => {
      card.addEventListener('click', () => this.selectModel(card.dataset.model));
    });
  }

  /**
   * Get model icon based on tier
   */
  getModelIcon(tier) {
    switch (tier) {
      case 'fast': return '⚡';
      case 'balanced': return '✦';
      case 'thorough': return '◆';
      default: return '●';
    }
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
        default_instructions: settings.default_instructions || ''
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
        default_instructions: ''
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
      // Update currentSettings directly so state is consistent for saves,
      // but don't mark as changed (no unsaved changes indicator)
      providerId = availableProviders[0] || 'claude';
      this.currentSettings.default_provider = providerId;
    }

    this.selectProvider(providerId, false);

    // Update model selection
    if (this.currentSettings.default_model) {
      this.selectModel(this.currentSettings.default_model, false);
    }

    // Update instructions textarea
    const textarea = document.getElementById('default-instructions');
    if (textarea) {
      textarea.value = this.currentSettings.default_instructions || '';
      this.updateCharCount(textarea.value.length);
    }
  }

  selectModel(modelId, markAsChanged = true) {
    // Update current settings
    if (markAsChanged) {
      this.currentSettings.default_model = modelId;
      this.checkForChanges();
    }

    // Update UI
    document.querySelectorAll('.model-card').forEach(card => {
      card.classList.toggle('selected', card.dataset.model === modelId);
    });
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
    const instructionsChanged = (this.currentSettings.default_instructions ?? '') !== (this.originalSettings.default_instructions ?? '');

    this.hasUnsavedChanges = providerChanged || modelChanged || instructionsChanged;

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
          default_instructions: ''
        })
      });

      if (!response.ok) {
        throw new Error('Failed to reset settings');
      }

      // Clear all settings
      this.originalSettings = {
        default_provider: null,
        default_model: null,
        default_instructions: ''
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
