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
    this.selectedModel = 'sonnet';
    this.selectedPresets = new Set();
    this.rememberModel = false;
    this.repoInstructions = '';
    this.lastInstructions = '';
    this.providersLoaded = false;

    // Character limit constants (must match backend limit)
    this.CHAR_LIMIT = 5000;
    this.CHAR_WARNING_THRESHOLD = 4500;

    // Provider definitions - loaded from backend API
    // Initialize empty, will be populated by loadProviders()
    this.providers = {};

    // Models for current provider (updated when provider changes)
    this.models = [];

    this.presets = [
      { id: 'security', label: 'Security', instruction: 'Focus on security vulnerabilities, injection risks, and authentication issues.' },
      { id: 'performance', label: 'Performance', instruction: 'Focus on performance bottlenecks, memory issues, and optimization opportunities.' },
      { id: 'quality', label: 'Code Quality', instruction: 'Focus on code clarity, maintainability, and best practices.' },
      { id: 'bugs', label: 'Bug Detection', instruction: 'Focus on potential bugs, edge cases, and error handling.' }
    ];

    this.createModal();
    this.setupEventListeners();
  }

  /**
   * Load provider definitions from the backend API
   * This makes the backend the single source of truth for provider/model configs
   * @returns {Promise<void>}
   */
  async loadProviders() {
    if (this.providersLoaded) return;

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
            { id: 'sonnet', name: 'Sonnet', tier: 'balanced', default: true }
          ],
          defaultModel: 'sonnet'
        }
      };
      this.models = this.providers.claude.models;
      this.providersLoaded = true;
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

    // Custom instructions character count and validation
    const textarea = this.modal.querySelector('#custom-instructions');
    textarea?.addEventListener('input', () => {
      this.updateCharacterCount(textarea.value.length);
    });

    // Keyboard shortcut: Cmd+Enter / Ctrl+Enter to start analysis
    textarea?.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        // Only submit if not over character limit (button would be disabled)
        const submitBtn = this.modal.querySelector('[data-action="submit"]');
        if (submitBtn && !submitBtn.disabled) {
          this.handleSubmit();
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
        this.handleSubmit();
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
   */
  renderProviderButtons() {
    const container = this.modal.querySelector('#provider-toggle-container');
    if (!container) return;

    const providerIds = Object.keys(this.providers);
    container.innerHTML = providerIds.map(providerId => {
      const provider = this.providers[providerId];
      return `
        <button class="provider-btn ${providerId === this.selectedProvider ? 'selected' : ''}" data-provider="${providerId}">
          ${provider.name}
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
  handleSubmit() {
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
      repoInstructions: this.repoInstructions
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

    // Load providers from backend before showing modal
    await this.loadProviders();

    // Render provider buttons and model cards now that we have provider data
    this.renderProviderButtons();
    this.renderModelCards();

    return new Promise((resolve) => {
      // Store callbacks
      this.onSubmit = (config) => {
        resolve(config);
      };
      this.onCancel = () => {
        resolve(null);
      };

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

      // Show modal with animation
      this.modal.style.display = 'flex';
      requestAnimationFrame(() => {
        this.modal.classList.add('visible');
      });
      this.isVisible = true;

      // Add escape key listener when modal is shown
      document.addEventListener('keydown', this.escapeHandler);

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
      }, 200);
    });
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
      // Clear callbacks
      this.onSubmit = null;
      this.onCancel = null;
    }, 200);
  }

  /**
   * Cleanup event listeners
   */
  destroy() {
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
