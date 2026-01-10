import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests for RepoSettingsPage
 * Tests provider/model selection logic, especially edge cases around
 * missing providers and state consistency
 */

// Mock document and DOM elements
function createMockDocument() {
  const elements = {};
  return {
    getElementById: vi.fn((id) => elements[id] || null),
    querySelectorAll: vi.fn(() => []),
    documentElement: {
      getAttribute: vi.fn(() => 'light'),
      setAttribute: vi.fn()
    },
    createElement: vi.fn(() => ({
      className: '',
      innerHTML: '',
      classList: { add: vi.fn(), remove: vi.fn() },
      appendChild: vi.fn(),
      remove: vi.fn()
    })),
    addEventListener: vi.fn(),
    _elements: elements,
    _setElement: (id, el) => { elements[id] = el; }
  };
}

function createMockElement(overrides = {}) {
  return {
    innerHTML: '',
    value: '',
    textContent: '',
    style: { display: '' },
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn(),
      contains: vi.fn(() => false)
    },
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
    ...overrides
  };
}

// Create a minimal RepoSettingsPage-like object for testing
// We test the logic directly rather than loading the full class
function createRepoSettingsInstance(options = {}) {
  const {
    providers = {},
    currentSettings = {},
    originalSettings = {},
    selectedProvider = null
  } = options;

  // Mock DOM elements
  const mockElements = {
    'provider-toggle': createMockElement(),
    'model-cards': createMockElement(),
    'default-instructions': createMockElement({ value: '' }),
    'char-count': createMockElement(),
    'action-bar': createMockElement()
  };

  // Create mock document
  const mockDocument = createMockDocument();
  Object.entries(mockElements).forEach(([id, el]) => {
    mockDocument._setElement(id, el);
  });

  // Create instance with test methods
  const instance = {
    owner: 'test-owner',
    repo: 'test-repo',
    providers: { ...providers },
    currentSettings: { ...currentSettings },
    originalSettings: { ...originalSettings },
    selectedProvider: selectedProvider,
    hasUnsavedChanges: false,
    _mockDocument: mockDocument,
    _mockElements: mockElements,

    // Simplified selectProvider that mirrors the production logic
    selectProvider(providerId, markAsChanged = true) {
      if (!this.providers[providerId]) return;

      const previousProvider = this.selectedProvider;
      this.selectedProvider = providerId;

      if (markAsChanged) {
        this.currentSettings.default_provider = providerId;
      }

      // Re-render model cards (simplified - just track the call)
      this._renderModelCardsCalled = true;

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
          this.selectModel(fallbackModel.id, markAsChanged);
        } else {
          // No current model selected, use default for new provider
          const defaultModel = newProvider.models.find(m => m.default) || newProvider.models[0];
          this.selectModel(defaultModel.id, markAsChanged);
        }

        this.checkForChanges();
      }
    },

    selectModel(modelId, markAsChanged = true) {
      if (markAsChanged) {
        this.currentSettings.default_model = modelId;
        this.checkForChanges();
      }
    },

    checkForChanges() {
      const providerChanged = (this.currentSettings.default_provider ?? null) !== (this.originalSettings.default_provider ?? null);
      const modelChanged = (this.currentSettings.default_model ?? null) !== (this.originalSettings.default_model ?? null);
      const instructionsChanged = (this.currentSettings.default_instructions ?? '') !== (this.originalSettings.default_instructions ?? '');

      this.hasUnsavedChanges = providerChanged || modelChanged || instructionsChanged;
    },

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
    },

    // Helper to get what would be saved
    getSavePayload() {
      return {
        default_provider: this.currentSettings.default_provider,
        default_model: this.currentSettings.default_model,
        default_instructions: this.currentSettings.default_instructions
      };
    }
  };

  return instance;
}

// Test provider definitions
const TEST_PROVIDERS = {
  claude: {
    id: 'claude',
    name: 'Claude',
    models: [
      { id: 'haiku', name: 'Haiku', tier: 'fast' },
      { id: 'sonnet', name: 'Sonnet', tier: 'balanced', default: true },
      { id: 'opus', name: 'Opus', tier: 'thorough' }
    ],
    defaultModel: 'sonnet'
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    models: [
      { id: 'flash', name: 'Flash', tier: 'fast' },
      { id: 'pro', name: 'Pro', tier: 'balanced', default: true }
    ],
    defaultModel: 'pro'
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', tier: 'fast' },
      { id: 'gpt-4o', name: 'GPT-4o', tier: 'balanced', default: true }
    ],
    defaultModel: 'gpt-4o'
  },
  copilot: {
    id: 'copilot',
    name: 'Copilot',
    models: [
      { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Mini', tier: 'fast' },
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', tier: 'balanced', default: true },
      { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Max', tier: 'thorough' },
      { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', tier: 'premium' }
    ],
    defaultModel: 'gemini-3-pro-preview'
  }
};

describe('RepoSettingsPage', () => {
  describe('selectProvider - missing previous provider scenario', () => {
    it('should fall back to new provider default model when previous provider no longer exists', () => {
      // Scenario: User had 'deletedProvider' selected, but it's no longer available
      // When switching to 'claude', the old provider lookup fails
      const instance = createRepoSettingsInstance({
        providers: { claude: TEST_PROVIDERS.claude, gemini: TEST_PROVIDERS.gemini },
        currentSettings: {
          default_provider: 'deletedProvider',
          default_model: 'some-model',
          default_instructions: ''
        },
        originalSettings: {
          default_provider: 'deletedProvider',
          default_model: 'some-model',
          default_instructions: ''
        },
        selectedProvider: 'deletedProvider'
      });

      // Switch to claude - the old 'deletedProvider' doesn't exist in providers
      instance.selectProvider('claude', true);

      // Should have selected claude as provider
      expect(instance.selectedProvider).toBe('claude');
      expect(instance.currentSettings.default_provider).toBe('claude');

      // Should have fallen back to claude's default model (sonnet)
      expect(instance.currentSettings.default_model).toBe('sonnet');

      // Should have detected changes
      expect(instance.hasUnsavedChanges).toBe(true);
    });

    it('should use first model if no default when previous provider is missing', () => {
      // Provider with no default model marked
      const providerNoDefault = {
        id: 'nodefault',
        name: 'No Default',
        models: [
          { id: 'model-a', name: 'Model A', tier: 'fast' },
          { id: 'model-b', name: 'Model B', tier: 'balanced' }
        ]
      };

      const instance = createRepoSettingsInstance({
        providers: { nodefault: providerNoDefault },
        currentSettings: {
          default_provider: 'deletedProvider',
          default_model: 'deleted-model',
          default_instructions: ''
        },
        originalSettings: {
          default_provider: 'deletedProvider',
          default_model: 'deleted-model',
          default_instructions: ''
        },
        selectedProvider: 'deletedProvider'
      });

      instance.selectProvider('nodefault', true);

      // Should use first model when no default is marked
      expect(instance.currentSettings.default_model).toBe('model-a');
    });

    it('should produce correct save payload when previous provider is missing', () => {
      const instance = createRepoSettingsInstance({
        providers: { claude: TEST_PROVIDERS.claude },
        currentSettings: {
          default_provider: 'deletedProvider',
          default_model: 'deleted-model',
          default_instructions: 'test instructions'
        },
        originalSettings: {
          default_provider: 'deletedProvider',
          default_model: 'deleted-model',
          default_instructions: 'test instructions'
        },
        selectedProvider: 'deletedProvider'
      });

      instance.selectProvider('claude', true);

      const payload = instance.getSavePayload();
      expect(payload.default_provider).toBe('claude');
      expect(payload.default_model).toBe('sonnet');
      expect(payload.default_instructions).toBe('test instructions');
    });
  });

  describe('updateUI - missing saved provider scenario', () => {
    it('should fall back to first available provider when saved provider does not exist', () => {
      const instance = createRepoSettingsInstance({
        providers: { claude: TEST_PROVIDERS.claude, gemini: TEST_PROVIDERS.gemini },
        currentSettings: {
          default_provider: 'nonexistent',
          default_model: 'some-model',
          default_instructions: ''
        },
        originalSettings: {
          default_provider: 'nonexistent',
          default_model: 'some-model',
          default_instructions: ''
        },
        selectedProvider: null
      });

      instance.updateUI();

      // Should have fallen back to first provider (claude)
      expect(instance.selectedProvider).toBe('claude');
      // currentSettings should be updated to reflect the fallback
      expect(instance.currentSettings.default_provider).toBe('claude');
    });

    it('should update currentSettings.default_provider when falling back', () => {
      const instance = createRepoSettingsInstance({
        providers: { gemini: TEST_PROVIDERS.gemini },
        currentSettings: {
          default_provider: null, // No provider saved
          default_model: null,
          default_instructions: ''
        },
        originalSettings: {
          default_provider: null,
          default_model: null,
          default_instructions: ''
        },
        selectedProvider: null
      });

      instance.updateUI();

      // Should have set both selectedProvider and currentSettings
      expect(instance.selectedProvider).toBe('gemini');
      expect(instance.currentSettings.default_provider).toBe('gemini');
    });

    it('should not mark as changed when falling back to default provider', () => {
      const instance = createRepoSettingsInstance({
        providers: { claude: TEST_PROVIDERS.claude },
        currentSettings: {
          default_provider: null,
          default_model: null,
          default_instructions: ''
        },
        originalSettings: {
          default_provider: null,
          default_model: null,
          default_instructions: ''
        },
        selectedProvider: null
      });

      instance.updateUI();

      // Fallback should not trigger unsaved changes indicator
      // (the original had no provider, so technically nothing "changed" from user's perspective)
      expect(instance.hasUnsavedChanges).toBe(false);
    });

    it('should produce correct save payload after fallback', () => {
      const instance = createRepoSettingsInstance({
        providers: { claude: TEST_PROVIDERS.claude },
        currentSettings: {
          default_provider: 'deletedProvider', // Provider that no longer exists
          default_model: 'opus',
          default_instructions: 'some instructions'
        },
        originalSettings: {
          default_provider: 'deletedProvider',
          default_model: 'opus',
          default_instructions: 'some instructions'
        },
        selectedProvider: null
      });

      instance.updateUI();

      const payload = instance.getSavePayload();
      // Save payload should reflect the fallback provider, not the deleted one
      expect(payload.default_provider).toBe('claude');
      // Model should be preserved since we're calling selectModel with the existing model
      expect(payload.default_model).toBe('opus');
    });

    it('should handle case when saved provider is undefined', () => {
      const instance = createRepoSettingsInstance({
        providers: { openai: TEST_PROVIDERS.openai },
        currentSettings: {
          default_provider: undefined,
          default_model: undefined,
          default_instructions: ''
        },
        originalSettings: {
          default_provider: undefined,
          default_model: undefined,
          default_instructions: ''
        },
        selectedProvider: null
      });

      instance.updateUI();

      expect(instance.selectedProvider).toBe('openai');
      expect(instance.currentSettings.default_provider).toBe('openai');
    });
  });

  describe('selectProvider - normal provider switching', () => {
    it('should map model tier when switching providers', () => {
      const instance = createRepoSettingsInstance({
        providers: { claude: TEST_PROVIDERS.claude, gemini: TEST_PROVIDERS.gemini },
        currentSettings: {
          default_provider: 'claude',
          default_model: 'haiku', // fast tier
          default_instructions: ''
        },
        originalSettings: {
          default_provider: 'claude',
          default_model: 'haiku',
          default_instructions: ''
        },
        selectedProvider: 'claude'
      });

      instance.selectProvider('gemini', true);

      // Should map to gemini's fast tier model
      expect(instance.currentSettings.default_model).toBe('flash');
    });

    it('should fall back to default when tier not found', () => {
      const instance = createRepoSettingsInstance({
        providers: { claude: TEST_PROVIDERS.claude, gemini: TEST_PROVIDERS.gemini },
        currentSettings: {
          default_provider: 'claude',
          default_model: 'opus', // thorough tier - gemini doesn't have this
          default_instructions: ''
        },
        originalSettings: {
          default_provider: 'claude',
          default_model: 'opus',
          default_instructions: ''
        },
        selectedProvider: 'claude'
      });

      instance.selectProvider('gemini', true);

      // Gemini has no thorough tier, should fall back to default (pro)
      expect(instance.currentSettings.default_model).toBe('pro');
    });

    it('should not change model when markAsChanged is false', () => {
      const instance = createRepoSettingsInstance({
        providers: { claude: TEST_PROVIDERS.claude, gemini: TEST_PROVIDERS.gemini },
        currentSettings: {
          default_provider: 'claude',
          default_model: 'haiku',
          default_instructions: ''
        },
        originalSettings: {
          default_provider: 'claude',
          default_model: 'haiku',
          default_instructions: ''
        },
        selectedProvider: 'claude'
      });

      instance.selectProvider('gemini', false);

      // Model should not be remapped when markAsChanged is false
      expect(instance.currentSettings.default_model).toBe('haiku');
      // Provider should not be updated in currentSettings
      expect(instance.currentSettings.default_provider).toBe('claude');
      // But selectedProvider UI state should be updated
      expect(instance.selectedProvider).toBe('gemini');
    });

    it('should reject invalid provider', () => {
      const instance = createRepoSettingsInstance({
        providers: { claude: TEST_PROVIDERS.claude },
        currentSettings: {
          default_provider: 'claude',
          default_model: 'sonnet',
          default_instructions: ''
        },
        selectedProvider: 'claude'
      });

      instance.selectProvider('invalid', true);

      // Should not change anything
      expect(instance.selectedProvider).toBe('claude');
      expect(instance.currentSettings.default_provider).toBe('claude');
    });
  });

  describe('checkForChanges', () => {
    it('should detect provider change', () => {
      const instance = createRepoSettingsInstance({
        providers: TEST_PROVIDERS,
        currentSettings: {
          default_provider: 'gemini',
          default_model: 'pro',
          default_instructions: ''
        },
        originalSettings: {
          default_provider: 'claude',
          default_model: 'pro',
          default_instructions: ''
        }
      });

      instance.checkForChanges();
      expect(instance.hasUnsavedChanges).toBe(true);
    });

    it('should detect model change', () => {
      const instance = createRepoSettingsInstance({
        providers: TEST_PROVIDERS,
        currentSettings: {
          default_provider: 'claude',
          default_model: 'opus',
          default_instructions: ''
        },
        originalSettings: {
          default_provider: 'claude',
          default_model: 'sonnet',
          default_instructions: ''
        }
      });

      instance.checkForChanges();
      expect(instance.hasUnsavedChanges).toBe(true);
    });

    it('should detect instructions change', () => {
      const instance = createRepoSettingsInstance({
        providers: TEST_PROVIDERS,
        currentSettings: {
          default_provider: 'claude',
          default_model: 'sonnet',
          default_instructions: 'new instructions'
        },
        originalSettings: {
          default_provider: 'claude',
          default_model: 'sonnet',
          default_instructions: ''
        }
      });

      instance.checkForChanges();
      expect(instance.hasUnsavedChanges).toBe(true);
    });

    it('should not detect changes when settings match', () => {
      const instance = createRepoSettingsInstance({
        providers: TEST_PROVIDERS,
        currentSettings: {
          default_provider: 'claude',
          default_model: 'sonnet',
          default_instructions: 'same'
        },
        originalSettings: {
          default_provider: 'claude',
          default_model: 'sonnet',
          default_instructions: 'same'
        }
      });

      instance.checkForChanges();
      expect(instance.hasUnsavedChanges).toBe(false);
    });

    it('should handle null values correctly', () => {
      const instance = createRepoSettingsInstance({
        providers: TEST_PROVIDERS,
        currentSettings: {
          default_provider: null,
          default_model: null,
          default_instructions: ''
        },
        originalSettings: {
          default_provider: null,
          default_model: null,
          default_instructions: ''
        }
      });

      instance.checkForChanges();
      expect(instance.hasUnsavedChanges).toBe(false);
    });
  });

  describe('premium tier settings', () => {
    it('should save and load premium tier model selection', () => {
      const instance = createRepoSettingsInstance({
        providers: { copilot: TEST_PROVIDERS.copilot },
        currentSettings: {
          default_provider: 'copilot',
          default_model: 'claude-opus-4.5',
          default_instructions: ''
        },
        originalSettings: {
          default_provider: 'copilot',
          default_model: 'claude-opus-4.5',
          default_instructions: ''
        },
        selectedProvider: 'copilot'
      });

      // Verify premium model is selected
      expect(instance.currentSettings.default_model).toBe('claude-opus-4.5');
      expect(instance.selectedProvider).toBe('copilot');

      // Verify payload includes premium model
      const payload = instance.getSavePayload();
      expect(payload.default_provider).toBe('copilot');
      expect(payload.default_model).toBe('claude-opus-4.5');
    });

    it('should map premium tier when switching between providers with premium support', () => {
      // Create a second provider with premium tier for testing tier mapping
      const premiumProvider = {
        id: 'premium-test',
        name: 'Premium Test',
        models: [
          { id: 'basic', name: 'Basic', tier: 'fast' },
          { id: 'standard', name: 'Standard', tier: 'balanced', default: true },
          { id: 'advanced', name: 'Advanced', tier: 'thorough' },
          { id: 'ultimate', name: 'Ultimate', tier: 'premium' }
        ],
        defaultModel: 'standard'
      };

      const instance = createRepoSettingsInstance({
        providers: { copilot: TEST_PROVIDERS.copilot, 'premium-test': premiumProvider },
        currentSettings: {
          default_provider: 'copilot',
          default_model: 'claude-opus-4.5', // premium tier
          default_instructions: ''
        },
        originalSettings: {
          default_provider: 'copilot',
          default_model: 'claude-opus-4.5',
          default_instructions: ''
        },
        selectedProvider: 'copilot'
      });

      // Switch to provider with premium tier support
      instance.selectProvider('premium-test', true);

      // Should map to premium-test's premium tier model (ultimate)
      expect(instance.currentSettings.default_model).toBe('ultimate');
    });

    it('should fall back to default when switching from premium tier to provider without premium', () => {
      const instance = createRepoSettingsInstance({
        providers: { copilot: TEST_PROVIDERS.copilot, claude: TEST_PROVIDERS.claude },
        currentSettings: {
          default_provider: 'copilot',
          default_model: 'claude-opus-4.5', // premium tier
          default_instructions: ''
        },
        originalSettings: {
          default_provider: 'copilot',
          default_model: 'claude-opus-4.5',
          default_instructions: ''
        },
        selectedProvider: 'copilot'
      });

      // Switch to claude which has no premium tier
      instance.selectProvider('claude', true);

      // Should fall back to claude's default model (sonnet) since no premium tier exists
      expect(instance.currentSettings.default_model).toBe('sonnet');
    });

    it('should detect changes when premium model is selected', () => {
      const instance = createRepoSettingsInstance({
        providers: { copilot: TEST_PROVIDERS.copilot },
        currentSettings: {
          default_provider: 'copilot',
          default_model: 'claude-opus-4.5', // changed to premium
          default_instructions: ''
        },
        originalSettings: {
          default_provider: 'copilot',
          default_model: 'gemini-3-pro-preview', // was balanced tier
          default_instructions: ''
        },
        selectedProvider: 'copilot'
      });

      instance.checkForChanges();
      expect(instance.hasUnsavedChanges).toBe(true);
    });

    it('should not detect changes when premium model matches original', () => {
      const instance = createRepoSettingsInstance({
        providers: { copilot: TEST_PROVIDERS.copilot },
        currentSettings: {
          default_provider: 'copilot',
          default_model: 'claude-opus-4.5',
          default_instructions: ''
        },
        originalSettings: {
          default_provider: 'copilot',
          default_model: 'claude-opus-4.5',
          default_instructions: ''
        },
        selectedProvider: 'copilot'
      });

      instance.checkForChanges();
      expect(instance.hasUnsavedChanges).toBe(false);
    });
  });
});
