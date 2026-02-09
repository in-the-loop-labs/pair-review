// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * AI Analysis Configuration Modal Component
 * Displays model selection, custom instructions, and presets before analysis
 */
class AnalysisConfigModal {
  constructor() {
    this.modal = null;
    this.isVisible = false;
    this.onSubmit = null;
    this.onCancel = null;
    this.escapeHandler = null;
    this.selectedProvider = 'claude';
    this.selectedModel = 'opus';
    this.selectedPresets = new Set();
    this.rememberModel = false;
    this.repoInstructions = '';
    this.lastInstructions = '';
    this.providersLoaded = false;
    this.skipLevel3 = false;

    // Character limit constants (must match backend limit)
    this.CHAR_LIMIT = 5000;
    this.CHAR_WARNING_THRESHOLD = 4500;

    // Provider definitions - loaded from backend API
    // Initialize empty, will be populated by loadProviders()
    this.providers = {};

    // Track if availability check is in progress
    this.availabilityCheckInProgress = false;

    // Track pending poll timeouts for cleanup
    this.pendingPollTimeouts = [];

    // Models for current provider (updated when provider changes)
    this.models = [];

    this.presets = [
      { id: 'security', label: 'Security', instruction: 'Focus on security vulnerabilities, injection risks, and authentication issues.' },
      { id: 'performance', label: 'Performance', instruction: 'Focus on performance bottlenecks, memory issues, and optimization opportunities.' },
      { id: 'quality', label: 'Code Quality', instruction: 'Focus on code clarity, maintainability, and best practices.' },
      { id: 'bugs', label: 'Bug Detection', instruction: 'Focus on potential bugs, edge cases, and error handling.' }
    ];

    // Council tab (lazily initialized after createModal)
    this.councilTab = null;

    this.createModal();
    this.setupEventListeners();

    // Initialize council tab if CouncilConfigTab is available
    if (typeof CouncilConfigTab !== 'undefined') {
      this.councilTab = new CouncilConfigTab(this.modal);
    }
  }

  /**
   * Load provider definitions from the backend API
   * This makes the backend the single source of truth for provider/model configs
   * @param {boolean} forceRefresh - Force reload even if already loaded
   * @returns {Promise<void>}
   */
  async loadProviders(forceRefresh = false) {
    if (this.providersLoaded && !forceRefresh) return;

    try {
      const response = await fetch('/api/providers');
      if (!response.ok) {
        throw new Error('Failed to fetch providers');
      }

      const data = await response.json();

      // Track availability check status
      this.availabilityCheckInProgress = data.checkInProgress || false;

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

      this.providersLoaded = true;

      // Update models for current provider
      if (this.providers[this.selectedProvider]) {
        this.models = this.providers[this.selectedProvider].models;
      }
    } catch (error) {
      console.error('Error loading providers:', error);
      // Fall back to minimal defaults if API fails
      this.providers = {
        claude: {
          id: 'claude',
          name: 'Claude',
          models: [
            { id: 'opus', name: 'Opus 4.6 High', tier: 'thorough', default: true }
          ],
          defaultModel: 'opus'
        }
      };
      this.models = this.providers.claude.models;
      this.providersLoaded = true;
    }
  }

  /**
   * Refresh provider availability status
   * Triggers a background check and updates the UI
   */
  async refreshProviderAvailability() {
    const refreshBtn = this.modal.querySelector('#refresh-providers-btn');
    if (!refreshBtn) return;

    // Add spinning animation
    refreshBtn.classList.add('refreshing');
    refreshBtn.disabled = true;

    try {
      // Trigger the refresh endpoint
      const response = await fetch('/api/providers/refresh-availability', { method: 'POST' });
      if (!response.ok) {
        throw new Error('Failed to refresh availability');
      }

      // Poll for completion (check every 500ms for up to 15 seconds)
      let attempts = 0;
      const maxAttempts = 30;
      const pollInterval = 500;

      const poll = async () => {
        attempts++;
        await this.loadProviders(true);
        this.renderProviderButtons();

        if (this.availabilityCheckInProgress && attempts < maxAttempts) {
          const timeoutId = setTimeout(poll, pollInterval);
          this.pendingPollTimeouts.push(timeoutId);
        } else {
          // Done - remove spinning animation
          refreshBtn.classList.remove('refreshing');
          refreshBtn.disabled = false;
        }
      };

      // Start polling with a short initial delay
      const initialTimeoutId = setTimeout(poll, 100);
      this.pendingPollTimeouts.push(initialTimeoutId);
    } catch (error) {
      console.error('Error refreshing provider availability:', error);
      this.pendingPollTimeouts.forEach(id => clearTimeout(id));
      this.pendingPollTimeouts = [];
      refreshBtn.classList.remove('refreshing');
      refreshBtn.disabled = false;
    }
  }

  /**
   * Create the modal DOM structure
   */
  createModal() {
    // Remove existing modal if it exists
    const existing = document.getElementById('analysis-config-modal');
    if (existing) {
      existing.remove();
    }

    // Create modal container
    const modalContainer = document.createElement('div');
    modalContainer.id = 'analysis-config-modal';
    modalContainer.className = 'modal-overlay analysis-config-overlay';
    modalContainer.style.display = 'none';

    modalContainer.innerHTML = `
      <div class="modal-backdrop" data-action="cancel"></div>
      <div class="modal-container analysis-config-container">
        <div class="modal-header analysis-config-header">
          <div class="header-title-section">
            <div class="header-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
            </div>
            <div>
              <h3>Configure AI Analysis</h3>
              <p class="header-subtitle">Customize how the AI reviews this PR</p>
            </div>
          </div>
          <button class="modal-close-btn" data-action="cancel" title="Close (Esc)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
            </svg>
          </button>
        </div>

        <div class="modal-body analysis-config-body">
          <!-- Provider Selection -->
          <section class="config-section">
            <h4 class="section-title">
              AI Provider
              <button class="provider-refresh-btn" id="refresh-providers-btn" title="Refresh provider availability">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
                  <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
                </svg>
              </button>
            </h4>
            <div class="provider-toggle" id="provider-toggle-container">
              <!-- Provider buttons rendered dynamically -->
            </div>
          </section>

          <!-- Model Selection -->
          <section class="config-section">
            <h4 class="section-title">
              Select Model
            </h4>
            <div class="model-cards" id="model-cards-container">
              <!-- Model cards rendered dynamically -->
            </div>
            <label class="remember-toggle">
              <input type="checkbox" id="remember-model" />
              <span class="toggle-switch"></span>
              <span class="toggle-label">Remember choices for this repository</span>
            </label>
          </section>

          <!-- Skip Level 3 Analysis -->
          <section class="config-section">
            <h4 class="section-title">
              Analysis Scope
            </h4>
            <div class="skip-level3-info" id="skip-level3-info" style="display: none;">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm6.5-.25A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75zM8 6a1 1 0 100-2 1 1 0 000 2z"/>
              </svg>
              <span>Codebase-wide analysis is automatically skipped for fast-tier models.</span>
            </div>
            <label class="remember-toggle" id="skip-level3-toggle">
              <input type="checkbox" id="skip-level3" />
              <span class="toggle-switch"></span>
              <span class="toggle-label">Skip codebase-wide analysis (Level 3)</span>
            </label>
          </section>

          <!-- Focus Presets - Hidden for now, may reintroduce later -->
          <section class="config-section" style="display: none;">
            <h4 class="section-title">
              Focus Areas
              <span class="section-hint">(optional)</span>
            </h4>
            <div class="preset-chips">
              ${this.presets.map(preset => `
                <button class="preset-chip" data-preset="${preset.id}" title="${preset.instruction}">
                  <span class="preset-label">${preset.label}</span>
                </button>
              `).join('')}
            </div>
          </section>

          <!-- Custom Instructions -->
          <section class="config-section">
            <h4 class="section-title">
              Custom Instructions
              <span class="section-hint">(optional)</span>
            </h4>
            <div class="instructions-container">
              <div class="repo-instructions-banner" id="repo-instructions-banner" style="display: none;">
                <div class="banner-icon">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1h-8a1 1 0 00-1 1v6.708A2.486 2.486 0 014.5 9h8V1.5zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"/>
                  </svg>
                </div>
                <div class="banner-content">
                  <span class="banner-label">Repository default instructions active</span>
                  <button class="banner-toggle" id="toggle-repo-instructions" title="Show repository instructions">
                    <span>View</span>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"/>
                    </svg>
                  </button>
                </div>
              </div>
              <div class="repo-instructions-expanded" id="repo-instructions-expanded" style="display: none;">
                <div class="expanded-header">
                  <span>Repository Instructions</span>
                  <button class="collapse-btn" id="collapse-repo-instructions" title="Collapse">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M3.72 8.72a.75.75 0 011.06 0L8 11.94l3.22-3.22a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L3.72 9.78a.75.75 0 010-1.06z"/>
                    </svg>
                  </button>
                </div>
                <div class="expanded-content" id="repo-instructions-text"></div>
              </div>
              <textarea
                id="custom-instructions"
                class="instructions-textarea"
                placeholder="Add specific guidance for this review...&#10;&#10;Examples:&#10;• Pay extra attention to the authentication logic&#10;• Check for proper error handling in the API calls&#10;• This is a performance-critical section"
                rows="4"
              ></textarea>
              <div class="instructions-footer">
                <span class="char-count" id="char-count-container">
                  <span id="char-count">0</span> / 5,000 characters
                </span>
              </div>
            </div>
          </section>
        </div>

        <div class="modal-footer analysis-config-footer">
          <div class="council-footer-left" id="council-footer-left" style="display: none;">
            <span class="council-dirty-hint" id="council-dirty-hint">Unsaved council changes</span>
            <button class="btn btn-sm btn-secondary" id="council-footer-save-btn"
              title="Save council changes. Unsaved changes will be auto-saved as a new council when you analyze.">Save Council</button>
          </div>
          <button class="btn btn-secondary" data-action="cancel">Cancel</button>
          <button class="btn btn-primary btn-analyze" data-action="submit" title="Start Analysis (Cmd/Ctrl+Enter)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <span>Start Analysis</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modalContainer);
    this.modal = modalContainer;
  }

  /**
   * Setup event listeners
   * Note: Provider buttons and model cards have their listeners attached in their render methods
   */
  setupEventListeners() {
    // Preset chip toggle
    this.modal.querySelectorAll('.preset-chip').forEach(chip => {
      chip.addEventListener('click', () => this.togglePreset(chip.dataset.preset));
    });

    // Remember toggle
    const rememberCheckbox = this.modal.querySelector('#remember-model');
    rememberCheckbox?.addEventListener('change', (e) => {
      this.rememberModel = e.target.checked;
    });

    // Skip Level 3 toggle
    const skipLevel3Checkbox = this.modal.querySelector('#skip-level3');
    skipLevel3Checkbox?.addEventListener('change', (e) => {
      this.skipLevel3 = e.target.checked;
    });

    // Refresh providers button
    const refreshBtn = this.modal.querySelector('#refresh-providers-btn');
    refreshBtn?.addEventListener('click', () => this.refreshProviderAvailability());

    // Custom instructions character count and validation
    const textarea = this.modal.querySelector('#custom-instructions');
    textarea?.addEventListener('input', () => {
      this.updateCharacterCount(textarea.value.length);
    });

    // Keyboard shortcut: Cmd+Enter / Ctrl+Enter to start analysis
    // Listen on the entire modal so it works from both Single and Council tabs
    this.modal.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        // Don't intercept Cmd+Enter inside comment form textareas
        if (e.target.matches('.comment-textarea, .comment-edit-textarea')) return;
        e.preventDefault();
        const submitBtn = this.modal.querySelector('[data-action="submit"]');
        if (submitBtn && !submitBtn.disabled) {
          this.handleSubmit().catch(err => {
            console.error('Error in handleSubmit:', err);
          });
        }
      }
    });

    // Repo instructions toggle
    this.modal.querySelector('#toggle-repo-instructions')?.addEventListener('click', () => {
      this.modal.querySelector('#repo-instructions-banner').style.display = 'none';
      this.modal.querySelector('#repo-instructions-expanded').style.display = 'block';
    });

    this.modal.querySelector('#collapse-repo-instructions')?.addEventListener('click', () => {
      this.modal.querySelector('#repo-instructions-banner').style.display = 'flex';
      this.modal.querySelector('#repo-instructions-expanded').style.display = 'none';
    });

    // Action buttons (cancel, submit)
    this.modal.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'cancel') {
        this.hide();
      } else if (action === 'submit') {
        this.handleSubmit().catch(err => {
          console.error('Error in handleSubmit:', err);
        });
      }
    });

    // Escape key handler - bound function for add/remove symmetry
    this.escapeHandler = (e) => {
      if (e.key === 'Escape' && this.isVisible) {
        this.hide();
      }
    };
    // Note: Event listener is added in show() and removed in hide() to prevent memory leaks
  }

  /**
   * Render provider toggle buttons into the container
   * Only shows available providers as clickable buttons
   */
  renderProviderButtons() {
    const container = this.modal.querySelector('#provider-toggle-container');
    if (!container) return;

    // Filter to only show available providers
    const availableProviderIds = Object.keys(this.providers).filter(providerId => {
      const provider = this.providers[providerId];
      // Show provider if no availability info (check pending) or if explicitly available
      return !provider.availability || provider.availability.available;
    });

    // If selected provider is no longer available, select first available
    if (availableProviderIds.length > 0 && !availableProviderIds.includes(this.selectedProvider)) {
      this.selectProvider(availableProviderIds[0]);
      return; // selectProvider calls renderProviderButtons
    }

    // Show message if no providers are available
    if (availableProviderIds.length === 0) {
      container.innerHTML = '<span class="no-providers-message">No AI providers available. Check CLI installation and authentication.</span>';
      return;
    }

    container.innerHTML = availableProviderIds.map(providerId => {
      const provider = this.providers[providerId];
      // Escape provider name for use in HTML attributes and content
      const escapedName = window.escapeHtmlAttribute(provider.name);

      return `
        <button class="provider-btn ${providerId === this.selectedProvider ? 'selected' : ''}" data-provider="${providerId}" title="${escapedName}">
          ${escapedName}
        </button>
      `;
    }).join('');

    // Re-attach event listeners
    container.querySelectorAll('.provider-btn').forEach(btn => {
      btn.addEventListener('click', () => this.selectProvider(btn.dataset.provider));
    });
  }

  /**
   * Render model cards into the container
   */
  renderModelCards() {
    const container = this.modal.querySelector('#model-cards-container');
    if (!container) return;

    container.innerHTML = this.models.map(model => `
      <button class="model-card ${model.id === this.selectedModel ? 'selected' : ''}" data-model="${model.id}" data-tier="${model.tier}">
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
   * Select a provider and update model cards
   */
  selectProvider(providerId) {
    if (!this.providers[providerId]) return;

    this.selectedProvider = providerId;
    this.models = this.providers[providerId].models;

    // Find the model with same tier as currently selected, or use default
    const currentModel = this.models.find(m => m.id === this.selectedModel);
    if (!currentModel) {
      // Current model doesn't exist in new provider, find one with same tier
      const currentTier = Object.values(this.providers)
        .flatMap(p => p.models)
        .find(m => m.id === this.selectedModel)?.tier;

      const matchingModel = this.models.find(m => m.tier === currentTier);
      const defaultModel = this.models.find(m => m.default) || this.models[0];
      this.selectedModel = matchingModel?.id || defaultModel.id;
    }

    // Update provider buttons
    this.modal.querySelectorAll('.provider-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.provider === providerId);
    });

    // Re-render model cards (handles its own event listeners)
    this.renderModelCards();

    // Update selection state for the selected model
    if (this.selectedModel) {
      this.selectModel(this.selectedModel);
    }
  }

  /**
   * Select a model
   */
  selectModel(modelId) {
    this.selectedModel = modelId;

    // Update UI
    this.modal.querySelectorAll('.model-card').forEach(card => {
      card.classList.toggle('selected', card.dataset.model === modelId);
    });

    // Get the tier of the selected model
    const selectedCard = this.modal.querySelector(`.model-card[data-model="${modelId}"]`);
    const tier = selectedCard?.dataset?.tier;

    // Update skip level 3 checkbox based on tier
    const skipLevel3Checkbox = this.modal.querySelector('#skip-level3');
    const skipLevel3Info = this.modal.querySelector('#skip-level3-info');

    if (tier === 'fast') {
      // Always check for fast tier models and show info banner
      if (skipLevel3Checkbox) {
        skipLevel3Checkbox.checked = true;
        this.skipLevel3 = true;
      }
      if (skipLevel3Info) {
        skipLevel3Info.style.display = 'flex';
      }
    } else {
      // Always uncheck for non-fast tiers and hide info banner
      if (skipLevel3Checkbox) {
        skipLevel3Checkbox.checked = false;
        this.skipLevel3 = false;
      }
      if (skipLevel3Info) {
        skipLevel3Info.style.display = 'none';
      }
    }
  }

  /**
   * Get model icon based on tier
   * Delegates to shared utility in utils/tier-icons.js
   */
  getModelIcon(tier) {
    return window.getTierIcon(tier);
  }

  /**
   * Toggle a preset
   */
  togglePreset(presetId) {
    if (this.selectedPresets.has(presetId)) {
      this.selectedPresets.delete(presetId);
    } else {
      this.selectedPresets.add(presetId);
    }

    // Update UI
    this.modal.querySelectorAll('.preset-chip').forEach(chip => {
      chip.classList.toggle('active', this.selectedPresets.has(chip.dataset.preset));
    });
  }

  /**
   * Update character count display and validation state
   * @param {number} count - Current character count
   */
  updateCharacterCount(count) {
    const charCountEl = this.modal.querySelector('#char-count');
    const charCountContainer = this.modal.querySelector('#char-count-container');
    const textarea = this.modal.querySelector('#custom-instructions');
    const submitBtn = this.modal.querySelector('[data-action="submit"]');

    if (charCountEl) {
      charCountEl.textContent = count.toLocaleString();
    }

    // Determine validation state
    const isOverLimit = count > this.CHAR_LIMIT;
    const isNearLimit = count > this.CHAR_WARNING_THRESHOLD && count <= this.CHAR_LIMIT;

    // Update container styling
    if (charCountContainer) {
      charCountContainer.classList.remove('char-count-warning', 'char-count-error');
      if (isOverLimit) {
        charCountContainer.classList.add('char-count-error');
      } else if (isNearLimit) {
        charCountContainer.classList.add('char-count-warning');
      }
    }

    // Update textarea styling
    if (textarea) {
      textarea.classList.remove('textarea-warning', 'textarea-error');
      if (isOverLimit) {
        textarea.classList.add('textarea-error');
      } else if (isNearLimit) {
        textarea.classList.add('textarea-warning');
      }
    }

    // Enable/disable submit button
    if (submitBtn) {
      submitBtn.disabled = isOverLimit;
      if (isOverLimit) {
        submitBtn.title = 'Custom instructions exceed 5,000 character limit';
      } else {
        submitBtn.title = 'Start Analysis (Cmd/Ctrl+Enter)';
      }
    }
  }

  /**
   * Build combined instructions from presets and custom text
   */
  buildInstructions() {
    const parts = [];

    // Add preset instructions
    this.selectedPresets.forEach(presetId => {
      const preset = this.presets.find(p => p.id === presetId);
      if (preset) {
        parts.push(preset.instruction);
      }
    });

    // Add custom instructions
    const customText = this.modal.querySelector('#custom-instructions')?.value?.trim();
    if (customText) {
      parts.push(customText);
    }

    return parts.join('\n\n');
  }

  /**
   * Handle form submission
   */
  async handleSubmit() {
    // Check if council tab is active
    if (this.councilTab && this.councilTab.getActiveTab() === 'council') {
      // Validate council config before proceeding
      if (!this.councilTab.validate()) return;

      // Auto-save council if dirty
      await this.councilTab.autoSaveIfDirty();

      const councilConfig = this.councilTab.getCouncilConfig();
      const councilId = this.councilTab.getSelectedCouncilId();
      const selectedCouncil = this.councilTab.councils.find(c => c.id === councilId);

      const config = {
        isCouncil: true,
        councilId: councilId,
        councilName: selectedCouncil?.name || null,
        councilConfig: councilConfig,
        customInstructions: this.modal.querySelector('#council-custom-instructions')?.value?.trim() || '',
        repoInstructions: this.repoInstructions
      };

      if (this.onSubmit) {
        this.onSubmit(config);
      }

      this.hide(true);
      return;
    }

    // Extract tier from the selected model's data-tier attribute
    const selectedModelCard = this.modal.querySelector('.model-card.selected');
    const tier = selectedModelCard?.dataset?.tier || 'balanced';

    const config = {
      provider: this.selectedProvider,
      model: this.selectedModel,
      tier: tier,
      instructions: this.buildInstructions(),
      customInstructions: this.modal.querySelector('#custom-instructions')?.value?.trim() || '',
      presets: Array.from(this.selectedPresets),
      rememberModel: this.rememberModel,
      repoInstructions: this.repoInstructions,
      skipLevel3: this.skipLevel3
    };

    if (this.onSubmit) {
      this.onSubmit(config);
    }

    // Hide with wasSubmitted=true to avoid calling onCancel
    this.hide(true);
  }

  /**
   * Show the modal
   * @param {Object} options - Configuration options
   * @param {string} options.currentProvider - Currently selected provider
   * @param {string} options.currentModel - Currently selected model
   * @param {string} options.repoInstructions - Default instructions from repo settings
   * @param {string} options.lastInstructions - Last used custom instructions
   * @param {boolean} options.rememberModel - Whether model was remembered
   * @param {Function} options.onSubmit - Callback when analysis is started
   * @returns {Promise<Object|null>} Promise that resolves to config or null if cancelled
   */
  async show(options = {}) {
    if (!this.modal) return null;

    return new Promise((resolve) => {
      // Store callbacks
      this.onSubmit = (config) => {
        resolve(config);
      };
      this.onCancel = () => {
        resolve(null);
      };

      // Show modal immediately with loading state (providers may take a moment)
      this._showLoading(true);
      this.modal.style.display = 'flex';
      requestAnimationFrame(() => {
        this.modal.classList.add('visible');
      });
      this.isVisible = true;

      // Add escape key listener when modal is shown
      document.addEventListener('keydown', this.escapeHandler);

      // Load providers and populate content in the background
      this._initializeContent(options);
    });
  }

  /**
   * Initialize modal content after it's visible.
   * Loads providers, renders UI, and configures options.
   * @param {Object} options - Configuration options passed to show()
   * @private
   */
  async _initializeContent(options) {
    try {
      await this.loadProviders();
    } catch (error) {
      console.error('Error loading providers:', error);
    }

    // Render provider buttons and model cards now that we have provider data
    this.renderProviderButtons();
    this.renderModelCards();

    // Inject council tab after providers are loaded
    if (this.councilTab) {
      this.councilTab.inject();
      this.councilTab.setProviders(this.providers);

      // Pass repo and last instructions to council tab
      if (options.repoInstructions) {
        this.councilTab.setRepoInstructions(options.repoInstructions);
      }
      if (options.lastInstructions) {
        this.councilTab.setLastInstructions(options.lastInstructions);
      }

      // Pass resolved provider/model so new councils inherit the user's default
      this.councilTab.setDefaultOrchestration(options.currentProvider, options.currentModel);

      // Set council default (priority: last used > repo default)
      const councilDefault = options.lastCouncilId || options.defaultCouncilId || null;
      if (councilDefault) {
        this.councilTab.setDefaultCouncilId(councilDefault);
      }
    }

    // Set initial provider and model
    if (options.currentProvider && this.providers[options.currentProvider]) {
      this.selectProvider(options.currentProvider);
    } else if (Object.keys(this.providers).length > 0) {
      // Default to first available provider
      this.selectProvider(Object.keys(this.providers)[0]);
    }
    if (options.currentModel) {
      this.selectModel(options.currentModel);
    }

    if (options.repoInstructions) {
      this.repoInstructions = options.repoInstructions;
      const repoBanner = this.modal.querySelector('#repo-instructions-banner');
      if (repoBanner) repoBanner.style.display = 'flex';
      const repoText = this.modal.querySelector('#repo-instructions-text');
      if (repoText) repoText.textContent = options.repoInstructions;
    } else {
      const repoBanner = this.modal.querySelector('#repo-instructions-banner');
      if (repoBanner) repoBanner.style.display = 'none';
    }

    // Always get textarea reference and set its value
    // This ensures any stale content from race conditions is cleared
    const textarea = this.modal.querySelector('#custom-instructions');
    if (textarea) {
      if (options.lastInstructions) {
        textarea.value = options.lastInstructions;
        this.updateCharacterCount(options.lastInstructions.length);
      } else {
        textarea.value = '';
        this.updateCharacterCount(0);
      }
    }

    if (options.rememberModel) {
      this.rememberModel = true;
      const rememberCheckbox = this.modal.querySelector('#remember-model');
      if (rememberCheckbox) rememberCheckbox.checked = true;
    }

    // Remove loading state and reveal content
    this._showLoading(false);

    // Focus the textarea without scrolling the modal body
    setTimeout(() => {
      const textarea = this.modal.querySelector('#custom-instructions');
      const modalBody = this.modal.querySelector('.analysis-config-body');
      if (textarea) {
        textarea.focus({ preventScroll: true });
        // Ensure modal body is scrolled to top
        if (modalBody) {
          modalBody.scrollTop = 0;
        }
      }
    }, 50);
  }

  /**
   * Toggle loading state overlay on the modal body
   * @param {boolean} loading - Whether to show the loading state
   * @private
   */
  _showLoading(loading) {
    const body = this.modal.querySelector('.analysis-config-body');
    const footer = this.modal.querySelector('.analysis-config-footer');
    const submitBtn = this.modal.querySelector('[data-action="submit"]');

    if (loading) {
      // Add loading overlay to body
      let overlay = this.modal.querySelector('.config-loading-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'config-loading-overlay';
        overlay.innerHTML = `
          <div class="config-loading-spinner"></div>
          <span>Loading providers…</span>
        `;
        body.style.position = 'relative';
        body.appendChild(overlay);
      }
      overlay.style.display = '';
      if (submitBtn) submitBtn.disabled = true;
    } else {
      const overlay = this.modal.querySelector('.config-loading-overlay');
      if (overlay) overlay.style.display = 'none';
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  /**
   * Hide the modal
   * @param {boolean} wasSubmitted - Whether the modal was closed via submit (not cancel)
   */
  hide(wasSubmitted = false) {
    if (!this.modal || !this.isVisible) return;

    // Remove escape key listener when modal is hidden
    document.removeEventListener('keydown', this.escapeHandler);

    // Resolve the promise with null if cancelled (not submitted)
    if (!wasSubmitted && this.onCancel) {
      this.onCancel();
    }

    this.modal.classList.remove('visible');
    this.isVisible = false;

    setTimeout(() => {
      // Guard against race condition: if modal was reopened before this timeout fired,
      // don't reset the state (it would clear the newly populated values)
      if (this.isVisible) return;

      this.modal.style.display = 'none';
      // Reset state
      this.selectedPresets.clear();
      this.modal.querySelectorAll('.preset-chip').forEach(chip => {
        chip.classList.remove('active');
      });
      const textarea = this.modal.querySelector('#custom-instructions');
      if (textarea) {
        textarea.value = '';
      }
      // Reset character count and validation state
      this.updateCharacterCount(0);
      const repoExpanded = this.modal.querySelector('#repo-instructions-expanded');
      if (repoExpanded) repoExpanded.style.display = 'none';
      // Reset rememberModel state to prevent stale values on next show
      this.rememberModel = false;
      const rememberCheckbox = this.modal.querySelector('#remember-model');
      if (rememberCheckbox) {
        rememberCheckbox.checked = false;
      }
      // Reset skipLevel3 state
      this.skipLevel3 = false;
      const skipLevel3Checkbox = this.modal.querySelector('#skip-level3');
      if (skipLevel3Checkbox) {
        skipLevel3Checkbox.checked = false;
      }
      const skipLevel3Info = this.modal.querySelector('#skip-level3-info');
      if (skipLevel3Info) {
        skipLevel3Info.style.display = 'none';
      }
      // Reset council tab to single-model view for next open
      if (this.councilTab) {
        this.councilTab.activeTab = 'single';
        this.councilTab._isDirty = false;
        const tabBar = this.modal.querySelector('.analysis-tab-bar');
        if (tabBar) {
          tabBar.querySelectorAll('.analysis-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === 'single');
          });
        }
        const singlePanel = this.modal.querySelector('#tab-panel-single');
        const councilPanel = this.modal.querySelector('#tab-panel-council');
        if (singlePanel) singlePanel.style.display = '';
        if (councilPanel) councilPanel.style.display = 'none';
        // Note: council custom instructions are NOT cleared here;
        // they are repopulated from lastInstructions on next show()
        // Reset dirty hint container (includes hint text + save button)
        const dirtyHintContainer = this.modal.querySelector('#council-footer-left');
        if (dirtyHintContainer) dirtyHintContainer.style.display = 'none';
        // Reset submit button text to single-model default
        const submitBtnSpan = this.modal.querySelector('[data-action="submit"] span');
        if (submitBtnSpan) submitBtnSpan.textContent = 'Start Analysis';
      }
      // Clear loading overlay if still present
      const loadingOverlay = this.modal.querySelector('.config-loading-overlay');
      if (loadingOverlay) loadingOverlay.style.display = 'none';
      // Clear callbacks
      this.onSubmit = null;
      this.onCancel = null;
    }, 200);
  }

  /**
   * Cleanup event listeners and pending timeouts
   */
  destroy() {
    // Clear any pending poll timeouts
    this.pendingPollTimeouts.forEach(id => clearTimeout(id));
    this.pendingPollTimeouts = [];

    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler);
    }
    if (this.modal) {
      this.modal.remove();
    }
  }
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.AnalysisConfigModal = AnalysisConfigModal;
}
