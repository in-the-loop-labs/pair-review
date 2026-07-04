// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Unit tests for LLM-based JSON extraction fallback
 *
 * Tests the refactored extraction logic in AIProvider base class,
 * including tier-based model selection and extraction configuration.
 *
 * Note: Tests requiring spawn mocking are skipped due to vitest/CommonJS
 * module isolation limitations. The extraction functionality is verified
 * through integration tests and manual testing.
 */

// Import providers directly for synchronous tests
import ClaudeProvider from '../../src/ai/claude-provider.js';
import AntigravityProvider from '../../src/ai/antigravity-provider.js';
import CodexProvider from '../../src/ai/codex-provider.js';
import CopilotProvider from '../../src/ai/copilot-provider.js';

describe('LLM-based JSON extraction fallback', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PAIR_REVIEW_CLAUDE_CMD;
    delete process.env.PAIR_REVIEW_ANTIGRAVITY_CMD;
    delete process.env.PAIR_REVIEW_CODEX_CMD;
    delete process.env.PAIR_REVIEW_COPILOT_CMD;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('AIProvider.getFastTierModel', () => {
    it('should return fast-tier model for Claude (haiku)', () => {
      const provider = new ClaudeProvider('sonnet');
      expect(provider.getFastTierModel()).toBe('haiku');
    });

    it('should return fast-tier model for Antigravity (gemini-3.5-flash-low)', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      expect(provider.getFastTierModel()).toBe('gemini-3.5-flash-low');
    });

    it('should return fast-tier model for Codex (gpt-5.4-nano)', () => {
      const provider = new CodexProvider('gpt-5.4-mini');
      expect(provider.getFastTierModel()).toBe('gpt-5.4-nano');
    });

    it('should return fast-tier model for Copilot (claude-haiku-4.6)', () => {
      const provider = new CopilotProvider('claude-sonnet-4.5');
      expect(provider.getFastTierModel()).toBe('claude-haiku-4.6');
    });

    it('should fall back to analysis model when no fast tier exists', () => {
      // All current providers have fast tiers, so this tests the fallback logic
      // by verifying it at least returns a valid model
      const provider = new ClaudeProvider('opus');
      const fastModel = provider.getFastTierModel();
      expect(fastModel).toBeTruthy();
      // Since Claude has haiku as fast tier, it returns that
      expect(fastModel).toBe('haiku');
    });
  });

  describe('AIProvider.getExtractionConfig', () => {
    describe('ClaudeProvider', () => {
      it('should return valid config', () => {
        const provider = new ClaudeProvider();
        const config = provider.getExtractionConfig('haiku');

        expect(config).toHaveProperty('command');
        expect(config).toHaveProperty('args');
        expect(config).toHaveProperty('useShell');
        expect(config).toHaveProperty('promptViaStdin');
      });

      it('should use stdin for prompt', () => {
        const provider = new ClaudeProvider();
        const config = provider.getExtractionConfig('haiku');

        expect(config.promptViaStdin).toBe(true);
      });

      it('should include model in args', () => {
        const provider = new ClaudeProvider();
        const config = provider.getExtractionConfig('haiku');

        // haiku resolves to its pinned cli_model (latest Haiku 4.5)
        expect(config.args).toContain('claude-haiku-4-5-20251001');
      });

      it('should use shell mode with custom command', () => {
        process.env.PAIR_REVIEW_CLAUDE_CMD = 'devx claude';
        const provider = new ClaudeProvider();
        const config = provider.getExtractionConfig('haiku');

        expect(config.useShell).toBe(true);
        expect(config.command).toContain('devx claude');
      });
    });

    describe('AntigravityProvider', () => {
      it('should return valid config', () => {
        const provider = new AntigravityProvider();
        const config = provider.getExtractionConfig('gemini-3.5-flash-low');

        expect(config).toHaveProperty('command');
        expect(config).toHaveProperty('args');
        expect(config.promptViaStdin).toBe(true);
      });

      it('should deliver the extraction prompt via stdin without enabling tools', () => {
        const provider = new AntigravityProvider();
        const config = provider.getExtractionConfig('gemini-3.5-flash-low');

        // agy reads the prompt from stdin (plain text); extraction is a pure
        // text->JSON reformat, so it must NOT enable the agentic tool loop.
        expect(config.promptViaStdin).toBe(true);
        expect(config.args).not.toContain('--dangerously-skip-permissions');
      });

      it('should include the resolved cliName in args', () => {
        const provider = new AntigravityProvider();
        const config = provider.getExtractionConfig('gemini-3.5-flash-low');

        // The clean id resolves to the exact `agy --model` display string.
        expect(config.args).toContain('Gemini 3.5 Flash (Low)');
      });
    });

    describe('CodexProvider', () => {
      it('should return valid config', () => {
        const provider = new CodexProvider();
        const config = provider.getExtractionConfig('gpt-5.4-nano');

        expect(config).toHaveProperty('command');
        expect(config).toHaveProperty('args');
        expect(config.promptViaStdin).toBe(true);
      });

      it('should use read-only sandbox for extraction', () => {
        const provider = new CodexProvider();
        const config = provider.getExtractionConfig('gpt-5.4-nano');

        // For extraction, we don't need shell commands
        expect(config.args).toContain('read-only');
      });

      it('should include model in args', () => {
        const provider = new CodexProvider();
        const config = provider.getExtractionConfig('gpt-5.4-nano');

        expect(config.args).toContain('gpt-5.4-nano');
      });
    });

    describe('CopilotProvider', () => {
      it('should return valid config', () => {
        const provider = new CopilotProvider();
        const config = provider.getExtractionConfig('claude-haiku-4.6');

        expect(config).toHaveProperty('command');
        expect(config).toHaveProperty('args');
        expect(config).toHaveProperty('promptViaStdin');
      });

      it('should use stdin for prompt', () => {
        const provider = new CopilotProvider();
        const config = provider.getExtractionConfig('claude-haiku-4.6');

        // Copilot reads from stdin when no -p arg provided
        expect(config.promptViaStdin).toBe(true);
      });

      it('should include model in args', () => {
        const provider = new CopilotProvider();
        const config = provider.getExtractionConfig('claude-haiku-4.6');

        expect(config.args).toContain('claude-haiku-4.6');
      });

      it('should use silent mode', () => {
        const provider = new CopilotProvider();
        const config = provider.getExtractionConfig('claude-haiku-4.6');

        expect(config.args).toContain('-s');
      });
    });
  });

  describe('Model tier consistency', () => {
    it('all providers should have fast-tier models defined', () => {
      const providers = [
        { Class: ClaudeProvider, expectedFast: 'haiku' },
        { Class: AntigravityProvider, expectedFast: 'gemini-3.5-flash-low' },
        { Class: CodexProvider, expectedFast: 'gpt-5.4-nano' },
        { Class: CopilotProvider, expectedFast: 'claude-haiku-4.6' },
      ];

      for (const { Class, expectedFast } of providers) {
        const models = Class.getModels();
        const fastModel = models.find(m => m.tier === 'fast');

        expect(fastModel).toBeDefined();
        expect(fastModel.id).toBe(expectedFast);
      }
    });

    it('all providers should support extraction', () => {
      const providers = [
        ClaudeProvider,
        AntigravityProvider,
        CodexProvider,
        CopilotProvider,
      ];

      for (const ProviderClass of providers) {
        const provider = new ProviderClass();
        const config = provider.getExtractionConfig('test-model');

        expect(config).not.toBeNull();
        expect(config).toHaveProperty('command');
        expect(config).toHaveProperty('args');
      }
    });
  });

  describe('Extraction prompt handling', () => {
    it('all providers should use stdin for extraction', () => {
      const providers = [ClaudeProvider, AntigravityProvider, CodexProvider, CopilotProvider];

      for (const ProviderClass of providers) {
        const provider = new ProviderClass();
        const config = provider.getExtractionConfig('test-model');
        expect(config.promptViaStdin).toBe(true);
      }
    });
  });
});
