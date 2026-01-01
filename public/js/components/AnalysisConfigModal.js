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
    this.selectedModel = 'sonnet';
    this.selectedPresets = new Set();
    this.rememberModel = false;
    this.repoInstructions = '';
    this.lastInstructions = '';

    this.models = [
      {
        id: 'haiku',
        name: 'Haiku',
        tagline: 'Lightning Fast',
        description: 'Quick analysis for simple changes',
        icon: '⚡',
        badge: 'Fastest',
        badgeClass: 'badge-speed'
      },
      {
        id: 'sonnet',
        name: 'Sonnet',
        tagline: 'Best Balance',
        description: 'Recommended for most reviews',
        icon: '✦',
        badge: 'Recommended',
        badgeClass: 'badge-recommended',
        default: true
      },
      {
        id: 'opus',
        name: 'Opus',
        tagline: 'Most Capable',
        description: 'Deep analysis for complex code',
        icon: '◆',
        badge: 'Most Thorough',
        badgeClass: 'badge-power'
      }
    ];

    this.presets = [
      { id: 'security', label: 'Security', icon: '🔒', instruction: 'Focus on security vulnerabilities, injection risks, and authentication issues.' },
      { id: 'performance', label: 'Performance', icon: '🚀', instruction: 'Focus on performance bottlenecks, memory issues, and optimization opportunities.' },
      { id: 'quality', label: 'Code Quality', icon: '✨', instruction: 'Focus on code clarity, maintainability, and best practices.' },
      { id: 'bugs', label: 'Bug Detection', icon: '🐛', instruction: 'Focus on potential bugs, edge cases, and error handling.' }
    ];

    this.createModal();
    this.setupEventListeners();
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
          <!-- Model Selection -->
          <section class="config-section">
            <h4 class="section-title">
              <span class="section-icon">🤖</span>
              Select Model
            </h4>
            <div class="model-cards">
              ${this.models.map(model => `
                <button class="model-card ${model.default ? 'selected' : ''}" data-model="${model.id}">
                  <div class="model-badge ${model.badgeClass}">${model.badge}</div>
                  <div class="model-icon">${model.icon}</div>
                  <div class="model-info">
                    <span class="model-name">${model.name}</span>
                    <span class="model-tagline">${model.tagline}</span>
                  </div>
                  <p class="model-description">${model.description}</p>
                  <div class="model-selected-indicator">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>
                    </svg>
                  </div>
                </button>
              `).join('')}
            </div>
            <label class="remember-toggle">
              <input type="checkbox" id="remember-model" />
              <span class="toggle-switch"></span>
              <span class="toggle-label">Remember model choice for this repository</span>
            </label>
          </section>

          <!-- Focus Presets -->
          <section class="config-section">
            <h4 class="section-title">
              <span class="section-icon">🎯</span>
              Focus Areas
              <span class="section-hint">(optional)</span>
            </h4>
            <div class="preset-chips">
              ${this.presets.map(preset => `
                <button class="preset-chip" data-preset="${preset.id}" title="${preset.instruction}">
                  <span class="preset-icon">${preset.icon}</span>
                  <span class="preset-label">${preset.label}</span>
                </button>
              `).join('')}
            </div>
          </section>

          <!-- Custom Instructions -->
          <section class="config-section">
            <h4 class="section-title">
              <span class="section-icon">📝</span>
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
                <span class="char-count"><span id="char-count">0</span> characters</span>
              </div>
            </div>
          </section>
        </div>

        <div class="modal-footer analysis-config-footer">
          <button class="btn btn-secondary" data-action="cancel">Cancel</button>
          <button class="btn btn-primary btn-analyze" data-action="submit">
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
   */
  setupEventListeners() {
    // Model card selection
    this.modal.querySelectorAll('.model-card').forEach(card => {
      card.addEventListener('click', () => this.selectModel(card.dataset.model));
    });

    // Preset chip toggle
    this.modal.querySelectorAll('.preset-chip').forEach(chip => {
      chip.addEventListener('click', () => this.togglePreset(chip.dataset.preset));
    });

    // Remember toggle
    const rememberCheckbox = this.modal.querySelector('#remember-model');
    rememberCheckbox?.addEventListener('change', (e) => {
      this.rememberModel = e.target.checked;
    });

    // Custom instructions character count
    const textarea = this.modal.querySelector('#custom-instructions');
    textarea?.addEventListener('input', () => {
      const count = textarea.value.length;
      this.modal.querySelector('#char-count').textContent = count;
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

    // Escape key handler
    this.escapeHandler = (e) => {
      if (e.key === 'Escape' && this.isVisible) {
        this.hide();
      }
    };
    document.addEventListener('keydown', this.escapeHandler);
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
    const config = {
      model: this.selectedModel,
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
   * @param {string} options.currentModel - Currently selected model
   * @param {string} options.repoInstructions - Default instructions from repo settings
   * @param {string} options.lastInstructions - Last used custom instructions
   * @param {boolean} options.rememberModel - Whether model was remembered
   * @param {Function} options.onSubmit - Callback when analysis is started
   * @returns {Promise<Object|null>} Promise that resolves to config or null if cancelled
   */
  show(options = {}) {
    if (!this.modal) return Promise.resolve(null);

    return new Promise((resolve) => {
      // Store callbacks
      this.onSubmit = (config) => {
        resolve(config);
      };
      this.onCancel = () => {
        resolve(null);
      };

      // Set initial values
      if (options.currentModel) {
        this.selectModel(options.currentModel);
      }

      if (options.repoInstructions) {
        this.repoInstructions = options.repoInstructions;
        this.modal.querySelector('#repo-instructions-banner').style.display = 'flex';
        this.modal.querySelector('#repo-instructions-text').textContent = options.repoInstructions;
      } else {
        this.modal.querySelector('#repo-instructions-banner').style.display = 'none';
      }

      if (options.lastInstructions) {
        const textarea = this.modal.querySelector('#custom-instructions');
        textarea.value = options.lastInstructions;
        this.modal.querySelector('#char-count').textContent = options.lastInstructions.length;
      }

      if (options.rememberModel) {
        this.rememberModel = true;
        this.modal.querySelector('#remember-model').checked = true;
      }

      // Show modal with animation
      this.modal.style.display = 'flex';
      requestAnimationFrame(() => {
        this.modal.classList.add('visible');
      });
      this.isVisible = true;

      // Focus the textarea
      setTimeout(() => {
        this.modal.querySelector('#custom-instructions')?.focus();
      }, 200);
    });
  }

  /**
   * Hide the modal
   * @param {boolean} wasSubmitted - Whether the modal was closed via submit (not cancel)
   */
  hide(wasSubmitted = false) {
    if (!this.modal || !this.isVisible) return;

    // Resolve the promise with null if cancelled (not submitted)
    if (!wasSubmitted && this.onCancel) {
      this.onCancel();
    }

    this.modal.classList.remove('visible');
    this.isVisible = false;

    setTimeout(() => {
      this.modal.style.display = 'none';
      // Reset state
      this.selectedPresets.clear();
      this.modal.querySelectorAll('.preset-chip').forEach(chip => {
        chip.classList.remove('active');
      });
      const textarea = this.modal.querySelector('#custom-instructions');
      if (textarea) {
        textarea.value = '';
        this.modal.querySelector('#char-count').textContent = '0';
      }
      this.modal.querySelector('#repo-instructions-expanded').style.display = 'none';
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
