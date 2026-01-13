// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Unit tests for CursorAgentProvider
 *
 * These tests focus on static methods, constructor behavior, and model definitions
 * which don't require spawning actual CLI processes.
 */

// Mock logger to suppress output during tests
vi.mock('../../src/utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn()
  },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  debug: vi.fn()
}));

// Import after mocks are set up
const CursorAgentProvider = require('../../src/ai/cursor-agent-provider');

describe('CursorAgentProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment for each test
    delete process.env.PAIR_REVIEW_CURSOR_AGENT_CMD;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('static methods', () => {
    it('should return correct provider name', () => {
      expect(CursorAgentProvider.getProviderName()).toBe('Cursor Agent');
    });

    it('should return correct provider ID', () => {
      expect(CursorAgentProvider.getProviderId()).toBe('cursor-agent');
    });

    it('should return default model as auto', () => {
      expect(CursorAgentProvider.getDefaultModel()).toBe('auto');
    });

    it('should return array of models', () => {
      const models = CursorAgentProvider.getModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });

    it('should have models with required properties', () => {
      const models = CursorAgentProvider.getModels();
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
      const models = CursorAgentProvider.getModels();
      const defaultModels = models.filter(m => m.default);
      expect(defaultModels).toHaveLength(1);
      expect(defaultModels[0].id).toBe('auto');
    });

    it('should return install instructions', () => {
      const instructions = CursorAgentProvider.getInstallInstructions();
      expect(instructions).toContain('npm install');
      expect(instructions).toContain('cursor');
    });
  });

  describe('model definitions', () => {
    it('should have auto model as free tier', () => {
      const models = CursorAgentProvider.getModels();
      const autoModel = models.find(m => m.id === 'auto');
      expect(autoModel).toBeDefined();
      expect(autoModel.name).toContain('Free');
      expect(autoModel.badge).toBe('Free');
    });

    it('should have fast tier model', () => {
      const models = CursorAgentProvider.getModels();
      const fastModels = models.filter(m => m.tier === 'fast');
      expect(fastModels.length).toBeGreaterThan(0);
      expect(fastModels[0].id).toBe('gemini-3-flash');
    });

    it('should have free tier model', () => {
      const models = CursorAgentProvider.getModels();
      const freeModels = models.filter(m => m.tier === 'free');
      expect(freeModels.length).toBeGreaterThan(0);
      // auto is the default free model
      expect(freeModels.some(m => m.id === 'auto')).toBe(true);
    });

    it('should have balanced tier model', () => {
      const models = CursorAgentProvider.getModels();
      const balancedModels = models.filter(m => m.tier === 'balanced');
      expect(balancedModels.length).toBeGreaterThan(0);
      expect(balancedModels[0].id).toBe('sonnet-4.5');
    });

    it('should have thorough tier model', () => {
      const models = CursorAgentProvider.getModels();
      const thoroughModels = models.filter(m => m.tier === 'thorough');
      expect(thoroughModels.length).toBeGreaterThan(0);
      expect(thoroughModels[0].id).toBe('opus-4.5-thinking');
    });

    it('should have exactly 4 models', () => {
      const models = CursorAgentProvider.getModels();
      expect(models).toHaveLength(4);
    });
  });

  describe('constructor', () => {
    it('should create instance with default model (auto)', () => {
      const provider = new CursorAgentProvider();
      expect(provider.model).toBe('auto');
    });

    it('should create instance with custom model', () => {
      const provider = new CursorAgentProvider('sonnet-4.5');
      expect(provider.model).toBe('sonnet-4.5');
    });

    it('should use default cursor-agent command', () => {
      const provider = new CursorAgentProvider();
      expect(provider.command).toBe('cursor-agent');
      expect(provider.useShell).toBe(false);
    });

    it('should respect PAIR_REVIEW_CURSOR_AGENT_CMD environment variable', () => {
      process.env.PAIR_REVIEW_CURSOR_AGENT_CMD = '/custom/path/cursor-agent';
      const provider = new CursorAgentProvider();
      expect(provider.command).toBe('/custom/path/cursor-agent');
      expect(provider.useShell).toBe(false);
    });

    it('should use shell mode for multi-word commands', () => {
      process.env.PAIR_REVIEW_CURSOR_AGENT_CMD = 'npx cursor-agent';
      const provider = new CursorAgentProvider();
      expect(provider.useShell).toBe(true);
      expect(provider.command).toContain('npx cursor-agent');
    });

    it('should configure args correctly for non-shell mode', () => {
      const provider = new CursorAgentProvider('sonnet-4.5');
      expect(provider.args).toContain('-p');
      expect(provider.args).toContain('--output-format');
      expect(provider.args).toContain('json');
      expect(provider.args).toContain('--model');
      expect(provider.args).toContain('sonnet-4.5');
      expect(provider.args).toContain('-f');
      expect(provider.args).toContain('--sandbox');
      expect(provider.args).toContain('enabled');
      expect(provider.args).toContain('--approve-mcps');
    });

    it('should include sandbox and force flags for security and non-interactive mode', () => {
      const provider = new CursorAgentProvider();
      const args = provider.args;

      // Should use print mode for non-interactive execution
      expect(args).toContain('-p');

      // Should use JSON output format
      expect(args).toContain('--output-format');
      expect(args).toContain('json');

      // Should use force mode for auto-approval
      expect(args).toContain('-f');

      // Should enable sandbox for safety
      expect(args).toContain('--sandbox');
      expect(args).toContain('enabled');

      // Should auto-approve MCP servers in headless mode
      expect(args).toContain('--approve-mcps');
    });

    it('should include model in shell command for shell mode', () => {
      process.env.PAIR_REVIEW_CURSOR_AGENT_CMD = 'npx cursor-agent';
      const provider = new CursorAgentProvider('opus-4.5-thinking');
      expect(provider.command).toContain('--model opus-4.5-thinking');
      expect(provider.command).toContain('-p');
      expect(provider.command).toContain('--output-format json');
      expect(provider.command).toContain('-f');
      expect(provider.command).toContain('--sandbox enabled');
    });
  });

  describe('model metadata', () => {
    it('should have appropriate badge classes for each tier', () => {
      const models = CursorAgentProvider.getModels();

      const freeModel = models.find(m => m.tier === 'free');
      expect(freeModel.badgeClass).toBe('badge-recommended');

      const fastModel = models.find(m => m.tier === 'fast');
      expect(fastModel.badgeClass).toBe('badge-speed');

      const balancedModel = models.find(m => m.tier === 'balanced');
      expect(balancedModel.badgeClass).toBe('badge-recommended');

      const thoroughModel = models.find(m => m.tier === 'thorough');
      expect(thoroughModel.badgeClass).toBe('badge-power');
    });

    it('should have meaningful taglines for each model', () => {
      const models = CursorAgentProvider.getModels();
      for (const model of models) {
        expect(model.tagline).toBeTruthy();
        expect(model.tagline.length).toBeGreaterThan(0);
      }
    });

    it('should have meaningful descriptions for each model', () => {
      const models = CursorAgentProvider.getModels();
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
      const RegisteredProvider = getProviderClass('cursor-agent');
      expect(RegisteredProvider).toBe(CursorAgentProvider);
    });

    it('should be listed in registered providers', () => {
      const { getRegisteredProviderIds } = require('../../src/ai/provider');
      const ids = getRegisteredProviderIds();
      expect(ids).toContain('cursor-agent');
    });
  });

  describe('parseCursorAgentResponse', () => {
    it('should parse valid JSON response directly', () => {
      const provider = new CursorAgentProvider();
      const validJson = JSON.stringify({
        level: 1,
        findings: [{ type: 'issue', message: 'Test issue' }]
      });

      const result = provider.parseCursorAgentResponse(validJson, 1);
      expect(result.success).toBe(true);
      expect(result.data.level).toBe(1);
      expect(result.data.findings).toHaveLength(1);
    });

    it('should extract JSON from response field', () => {
      const provider = new CursorAgentProvider();
      const wrappedJson = JSON.stringify({
        response: JSON.stringify({
          level: 2,
          findings: []
        })
      });

      const result = provider.parseCursorAgentResponse(wrappedJson, 2);
      expect(result.success).toBe(true);
      expect(result.data.level).toBe(2);
    });

    it('should extract JSON from content field', () => {
      const provider = new CursorAgentProvider();
      const wrappedJson = JSON.stringify({
        content: JSON.stringify({
          level: 3,
          findings: [{ type: 'praise', message: 'Good work' }]
        })
      });

      const result = provider.parseCursorAgentResponse(wrappedJson, 3);
      expect(result.success).toBe(true);
      expect(result.data.level).toBe(3);
    });

    it('should extract JSON from text field', () => {
      const provider = new CursorAgentProvider();
      const wrappedJson = JSON.stringify({
        text: JSON.stringify({
          level: 1,
          findings: []
        })
      });

      const result = provider.parseCursorAgentResponse(wrappedJson, 1);
      expect(result.success).toBe(true);
    });

    it('should handle raw text with embedded JSON', () => {
      const provider = new CursorAgentProvider();
      const textWithJson = 'Here is my analysis:\n```json\n{"level": 1, "findings": []}\n```\nEnd of response.';

      const result = provider.parseCursorAgentResponse(textWithJson, 1);
      expect(result.success).toBe(true);
      expect(result.data.level).toBe(1);
    });

    it('should return error for invalid response', () => {
      const provider = new CursorAgentProvider();
      const invalidResponse = 'This is not JSON at all, just plain text without any structured data.';

      const result = provider.parseCursorAgentResponse(invalidResponse, 1);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
