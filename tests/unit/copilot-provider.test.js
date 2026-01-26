// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Unit tests for CopilotProvider
 *
 * These tests focus on static methods, constructor behavior, and model definitions
 * which don't require spawning actual CLI processes.
 */

// Mock logger to suppress output during tests
// Note: Logger exports directly via CommonJS (module.exports = new AILogger()),
// so mock must export methods at top level, not under 'default'
vi.mock('../../src/utils/logger', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  debug: vi.fn(),
  streamDebug: vi.fn(),
  section: vi.fn()
}));

// Import after mocks are set up
const CopilotProvider = require('../../src/ai/copilot-provider');

describe('CopilotProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment for each test
    delete process.env.PAIR_REVIEW_COPILOT_CMD;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('static methods', () => {
    it('should return correct provider name', () => {
      expect(CopilotProvider.getProviderName()).toBe('Copilot');
    });

    it('should return correct provider ID', () => {
      expect(CopilotProvider.getProviderId()).toBe('copilot');
    });

    it('should return default model', () => {
      expect(CopilotProvider.getDefaultModel()).toBe('gemini-3-pro-preview');
    });

    it('should return array of models', () => {
      const models = CopilotProvider.getModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });

    it('should have models with required properties', () => {
      const models = CopilotProvider.getModels();
      for (const model of models) {
        expect(model).toHaveProperty('id');
        expect(model).toHaveProperty('name');
        expect(model).toHaveProperty('tier');
        expect(model).toHaveProperty('tagline');
        expect(model).toHaveProperty('description');
        expect(model).toHaveProperty('badge');
        expect(model).toHaveProperty('badgeClass');
      }
    });

    it('should have one default model marked', () => {
      const models = CopilotProvider.getModels();
      const defaultModels = models.filter(m => m.default);
      expect(defaultModels).toHaveLength(1);
      expect(defaultModels[0].id).toBe('gemini-3-pro-preview');
    });

    it('should return install instructions with correct GitHub Copilot package', () => {
      const instructions = CopilotProvider.getInstallInstructions();
      expect(instructions).toContain('npm install');
      expect(instructions).toContain('@github/copilot');
      expect(instructions).toContain('https://docs.github.com/en/copilot');
    });

    it('should not reference Anthropic in install instructions', () => {
      const instructions = CopilotProvider.getInstallInstructions();
      expect(instructions.toLowerCase()).not.toContain('anthropic');
      expect(instructions).not.toContain('claude-code');
    });
  });

  describe('model tiers', () => {
    it('should have fast tier model', () => {
      const models = CopilotProvider.getModels();
      const fastModels = models.filter(m => m.tier === 'fast');
      expect(fastModels.length).toBeGreaterThan(0);
      expect(fastModels[0].id).toBe('gpt-5.1-codex-mini');
    });

    it('should have balanced tier model', () => {
      const models = CopilotProvider.getModels();
      const balancedModels = models.filter(m => m.tier === 'balanced');
      expect(balancedModels.length).toBeGreaterThan(0);
      expect(balancedModels[0].id).toBe('gemini-3-pro-preview');
    });

    it('should have thorough tier model', () => {
      const models = CopilotProvider.getModels();
      const thoroughModels = models.filter(m => m.tier === 'thorough');
      expect(thoroughModels.length).toBeGreaterThan(0);
      expect(thoroughModels[0].id).toBe('gpt-5.1-codex-max');
    });

    it('should have premium tier model', () => {
      const models = CopilotProvider.getModels();
      const premiumModels = models.filter(m => m.tier === 'premium');
      expect(premiumModels.length).toBeGreaterThan(0);
      expect(premiumModels[0].id).toBe('claude-opus-4.5');
    });

    it('should have exactly 4 models covering all tiers', () => {
      const models = CopilotProvider.getModels();
      expect(models).toHaveLength(4);

      const tiers = models.map(m => m.tier);
      expect(tiers).toContain('fast');
      expect(tiers).toContain('balanced');
      expect(tiers).toContain('thorough');
      expect(tiers).toContain('premium');
    });
  });

  describe('constructor', () => {
    it('should create instance with default model', () => {
      const provider = new CopilotProvider();
      expect(provider.model).toBe('gemini-3-pro-preview');
    });

    it('should create instance with custom model', () => {
      const provider = new CopilotProvider('claude-opus-4.5');
      expect(provider.model).toBe('claude-opus-4.5');
    });

    it('should use default copilot command', () => {
      const provider = new CopilotProvider();
      expect(provider.command).toBe('copilot');
      expect(provider.useShell).toBe(false);
    });

    it('should respect PAIR_REVIEW_COPILOT_CMD environment variable', () => {
      process.env.PAIR_REVIEW_COPILOT_CMD = 'gh copilot';
      const provider = new CopilotProvider();
      expect(provider.command).toBe('gh copilot');
      expect(provider.useShell).toBe(true);
    });

    it('should use shell mode for multi-word commands', () => {
      process.env.PAIR_REVIEW_COPILOT_CMD = '/custom/path/copilot --verbose';
      const provider = new CopilotProvider();
      expect(provider.useShell).toBe(true);
    });

    it('should configure base args correctly', () => {
      const provider = new CopilotProvider('gpt-5.1-codex-max');
      expect(provider.baseArgs).toContain('--model');
      expect(provider.baseArgs).toContain('gpt-5.1-codex-max');
      expect(provider.baseArgs).toContain('-s');
    });

    it('should use read-only tool restrictions for security', () => {
      const provider = new CopilotProvider();
      const args = provider.baseArgs;

      // SECURITY: Should use --allow-tool with specific git command prefixes (not blanket 'git')
      expect(args).toContain('--allow-tool');
      expect(args).toContain('shell(git diff)');     // git diff commands
      expect(args).toContain('shell(git status)');   // git status commands
      expect(args).toContain('shell(git-diff-lines)'); // custom line mapping tool
      expect(args).toContain('shell(*/git-diff-lines)'); // absolute path invocation
      expect(args).toContain('shell(ls)');           // directory listing
      expect(args).toContain('shell(cat)');          // file reading

      // Should NOT allow blanket 'git' (too permissive, allows git commit, push, etc.)
      expect(args).not.toContain('shell(git)');

      // Should deny dangerous shell commands
      expect(args).toContain('--deny-tool');
      expect(args).toContain('shell(rm)');           // block destructive commands
      expect(args).toContain('shell(git commit)');   // block git commit
      expect(args).toContain('shell(git push)');     // block git push

      // Should deny write tools
      expect(args).toContain('write');

      // Should have --allow-all-tools to auto-approve remaining tools for non-interactive mode
      expect(args).toContain('--allow-all-tools');

      // Should NOT use --available-tools (too restrictive, blocks external scripts)
      expect(args).not.toContain('--available-tools');
    });

    it('should not include -p in base args (added in execute)', () => {
      const provider = new CopilotProvider();
      expect(provider.baseArgs).not.toContain('-p');
    });
  });

  describe('model metadata', () => {
    it('should have appropriate badge classes for each tier', () => {
      const models = CopilotProvider.getModels();

      const fastModel = models.find(m => m.tier === 'fast');
      expect(fastModel.badgeClass).toBe('badge-speed');

      const balancedModel = models.find(m => m.tier === 'balanced');
      expect(balancedModel.badgeClass).toBe('badge-recommended');

      const thoroughModel = models.find(m => m.tier === 'thorough');
      expect(thoroughModel.badgeClass).toBe('badge-power');

      const premiumModel = models.find(m => m.tier === 'premium');
      expect(premiumModel.badgeClass).toBe('badge-premium');
    });

    it('should have meaningful taglines for each model', () => {
      const models = CopilotProvider.getModels();
      for (const model of models) {
        expect(model.tagline).toBeTruthy();
        expect(model.tagline.length).toBeGreaterThan(0);
      }
    });

    it('should have meaningful descriptions for each model', () => {
      const models = CopilotProvider.getModels();
      for (const model of models) {
        expect(model.description).toBeTruthy();
        expect(model.description.length).toBeGreaterThan(10);
      }
    });
  });

  describe('provider registration', () => {
    it('should be registered with the correct ID', () => {
      // The provider self-registers on import
      const { getProviderClass } = require('../../src/ai/provider');
      const RegisteredProvider = getProviderClass('copilot');
      expect(RegisteredProvider).toBe(CopilotProvider);
    });

    it('should be listed in registered providers', () => {
      const { getRegisteredProviderIds } = require('../../src/ai/provider');
      const ids = getRegisteredProviderIds();
      expect(ids).toContain('copilot');
    });
  });
});
