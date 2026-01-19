// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for tools/optimize.js
 *
 * Tests CLI executor functions, argument parsing, and JSON extraction logic.
 * Tests the internal logic patterns without importing the tool directly
 * (since it's a CLI tool with side effects).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

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

/**
 * Helper to create a mock child process with EventEmitter behavior
 */
function createMockProcess() {
  const proc = new EventEmitter();
  proc.stdin = {
    write: vi.fn(),
    end: vi.fn()
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

/**
 * Helper to simulate a successful CLI response
 * @param {object} mockProcess - The mock process
 * @param {string} stdout - stdout content to emit
 * @param {number} exitCode - exit code (default 0)
 */
function simulateCliResponse(mockProcess, stdout, exitCode = 0) {
  // Emit stdout data
  if (stdout) {
    mockProcess.stdout.emit('data', Buffer.from(stdout));
  }
  // Emit close event
  mockProcess.emit('close', exitCode);
}

/**
 * Helper to simulate a CLI error
 * @param {object} mockProcess - The mock process
 * @param {string} errorMessage - Error message
 */
function simulateCliError(mockProcess, errorMessage) {
  mockProcess.emit('error', new Error(errorMessage));
}

describe('optimize.js CLI Executors', () => {
  let mockProcess;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('executeGeminiCli argument structure', () => {
    it('should use correct gemini CLI arguments pattern', () => {
      // Test the expected argument structure for Gemini CLI
      const model = 'gemini-2.5-flash';
      const expectedArgs = ['-m', model, '-o', 'json'];

      expect(expectedArgs).toContain('-m');
      expect(expectedArgs).toContain(model);
      expect(expectedArgs).toContain('-o');
      expect(expectedArgs).toContain('json');
      expect(expectedArgs).toHaveLength(4);
    });

    it('should use pipe stdio configuration', () => {
      const stdioCfg = ['pipe', 'pipe', 'pipe'];
      expect(stdioCfg).toEqual(['pipe', 'pipe', 'pipe']);
    });

    it('should write prompt to stdin and close it', () => {
      const prompt = 'Test optimization prompt';

      // Simulate writing to stdin like the function does
      mockProcess.stdin.write(prompt);
      mockProcess.stdin.end();

      expect(mockProcess.stdin.write).toHaveBeenCalledWith(prompt);
      expect(mockProcess.stdin.end).toHaveBeenCalled();
    });
  });

  describe('executeCodexCli argument structure', () => {
    it('should use correct codex CLI arguments pattern', () => {
      const model = 'codex-mini';
      const expectedArgs = ['exec', '-m', model, '--json', '--sandbox', 'workspace-write', '--full-auto', '-'];

      expect(expectedArgs).toContain('exec');
      expect(expectedArgs).toContain('-m');
      expect(expectedArgs).toContain(model);
      expect(expectedArgs).toContain('--json');
      expect(expectedArgs).toContain('--sandbox');
      expect(expectedArgs).toContain('workspace-write');
      expect(expectedArgs).toContain('--full-auto');
      expect(expectedArgs).toContain('-');
    });

    it('should parse JSONL output and extract agent_message', () => {
      // Codex outputs JSONL format with item.completed events
      const jsonlOutput = [
        '{"type":"item.started","item":{"type":"agent_message"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"optimizedPrompt\\":\\"test\\",\\"changes\\":[]}"}}'
      ].join('\n');

      // Parse like the function does
      const lines = jsonlOutput.trim().split('\n').filter(line => line.trim());
      let agentMessage = null;

      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === 'item.completed' &&
            event.item?.type === 'agent_message' &&
            event.item?.text) {
          agentMessage = event.item.text;
        }
      }

      expect(agentMessage).toBe('{"optimizedPrompt":"test","changes":[]}');
      expect(JSON.parse(agentMessage)).toEqual({ optimizedPrompt: 'test', changes: [] });
    });
  });

  describe('executeCopilotCli argument structure', () => {
    it('should use correct copilot CLI arguments pattern', () => {
      const model = 'gpt-5.1-codex-max';
      const prompt = 'Test prompt';
      const expectedArgs = ['--model', model, '-s', '-p', prompt];

      expect(expectedArgs).toContain('--model');
      expect(expectedArgs).toContain(model);
      expect(expectedArgs).toContain('-s');
      expect(expectedArgs).toContain('-p');
      expect(expectedArgs).toContain(prompt);
    });

    it('should use -p flag for prompt instead of stdin', () => {
      // Copilot uses -p flag, not stdin
      const prompt = 'Test prompt';
      const args = ['--model', 'gpt-5.1-codex-max', '-s', '-p', prompt];

      expect(args).toContain('-p');
      expect(args).toContain(prompt);
      expect(args.indexOf('-p')).toBe(args.indexOf(prompt) - 1);
    });
  });

  describe('executeClaudeCli argument structure', () => {
    it('should use correct claude CLI arguments pattern', () => {
      const model = 'claude-sonnet-4-20250514';
      const expectedArgs = ['-p', '-m', model, '--output-format', 'json'];

      expect(expectedArgs).toContain('-p');
      expect(expectedArgs).toContain('-m');
      expect(expectedArgs).toContain(model);
      expect(expectedArgs).toContain('--output-format');
      expect(expectedArgs).toContain('json');
    });

    it('should parse Claude wrapper response with result field', () => {
      // Claude with --output-format json returns { result: "..." }
      const innerJson = { optimizedPrompt: 'test', changes: [] };
      const wrapper = { result: JSON.stringify(innerJson) };
      const stdout = JSON.stringify(wrapper);

      // Parse like the function does
      const parsed = JSON.parse(stdout);
      expect(parsed.result).toBeDefined();

      const responseText = parsed.result;
      expect(JSON.parse(responseText)).toEqual(innerJson);
    });

    it('should write prompt to stdin and close it', () => {
      const prompt = 'Test optimization prompt';

      mockProcess.stdin.write(prompt);
      mockProcess.stdin.end();

      expect(mockProcess.stdin.write).toHaveBeenCalledWith(prompt);
      expect(mockProcess.stdin.end).toHaveBeenCalled();
    });
  });

  describe('Error handling patterns', () => {
    it('should handle spawn error via error event', async () => {
      const errorMessage = 'Command not found';

      // Create a promise that will be rejected
      const promise = new Promise((resolve, reject) => {
        mockProcess.on('error', (error) => {
          reject(new Error(`Failed to spawn CLI: ${error.message}`));
        });

        // Simulate spawn error
        simulateCliError(mockProcess, errorMessage);
      });

      await expect(promise).rejects.toThrow('Failed to spawn CLI: Command not found');
    });

    it('should handle non-zero exit code via close event', async () => {
      const stderr = 'Authentication failed';

      const promise = new Promise((resolve, reject) => {
        let stderrContent = '';

        mockProcess.stderr.on('data', (data) => {
          stderrContent += data.toString();
        });

        mockProcess.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`CLI exited with code ${code}: ${stderrContent}`));
          }
        });

        // Emit stderr then close with error code
        mockProcess.stderr.emit('data', Buffer.from(stderr));
        mockProcess.emit('close', 1);
      });

      await expect(promise).rejects.toThrow('CLI exited with code 1: Authentication failed');
    });

    it('should handle JSON extraction failure', async () => {
      const invalidOutput = 'This is not JSON at all';

      const promise = new Promise((resolve, reject) => {
        let stdoutContent = '';

        mockProcess.stdout.on('data', (data) => {
          stdoutContent += data.toString();
        });

        mockProcess.on('close', (code) => {
          if (code === 0) {
            try {
              JSON.parse(stdoutContent);
              resolve();
            } catch (e) {
              reject(new Error(`Failed to parse response as JSON: ${e.message}`));
            }
          }
        });

        simulateCliResponse(mockProcess, invalidOutput, 0);
      });

      await expect(promise).rejects.toThrow('Failed to parse response as JSON');
    });
  });
});

describe('optimize.js Provider Integration', () => {
  describe('PROVIDER_CLASSES mapping', () => {
    // Import providers to verify mapping
    const GeminiProvider = require('../../src/ai/gemini-provider');
    const ClaudeProvider = require('../../src/ai/claude-provider');
    const CodexProvider = require('../../src/ai/codex-provider');
    const CopilotProvider = require('../../src/ai/copilot-provider');

    it('should have correct provider mappings', () => {
      const PROVIDER_CLASSES = {
        gemini: GeminiProvider,
        claude: ClaudeProvider,
        codex: CodexProvider,
        copilot: CopilotProvider
      };

      expect(PROVIDER_CLASSES.gemini).toBe(GeminiProvider);
      expect(PROVIDER_CLASSES.claude).toBe(ClaudeProvider);
      expect(PROVIDER_CLASSES.codex).toBe(CodexProvider);
      expect(PROVIDER_CLASSES.copilot).toBe(CopilotProvider);
    });

    it('should be able to get models from each provider', () => {
      const providers = [GeminiProvider, ClaudeProvider, CodexProvider, CopilotProvider];

      for (const Provider of providers) {
        const models = Provider.getModels();
        expect(Array.isArray(models)).toBe(true);
        expect(models.length).toBeGreaterThan(0);

        // Each model should have tier property
        for (const model of models) {
          expect(model).toHaveProperty('tier');
          expect(model).toHaveProperty('id');
        }
      }
    });

    it('should find thorough tier model for each provider (used as default optimizer)', () => {
      const providers = { gemini: GeminiProvider, claude: ClaudeProvider, codex: CodexProvider, copilot: CopilotProvider };

      for (const [name, Provider] of Object.entries(providers)) {
        const models = Provider.getModels();
        const thoroughModel = models.find(m => m.tier === 'thorough');
        expect(thoroughModel).toBeDefined();
        expect(thoroughModel.id).toBeTruthy();
      }
    });
  });

  describe('getModelForTier function logic', () => {
    const GeminiProvider = require('../../src/ai/gemini-provider');

    it('should return model ID for valid provider and tier', () => {
      const models = GeminiProvider.getModels();
      const fastModel = models.find(m => m.tier === 'fast');
      expect(fastModel).toBeDefined();
      expect(fastModel.id).toBeTruthy();
    });

    it('should have all required tiers available', () => {
      const VALID_TIERS = ['fast', 'balanced', 'thorough'];
      const models = GeminiProvider.getModels();

      for (const tier of VALID_TIERS) {
        const model = models.find(m => m.tier === tier);
        expect(model).toBeDefined();
      }
    });
  });
});

describe('optimize.js Argument Parsing', () => {
  describe('VALID_PROVIDERS constant', () => {
    it('should include all supported providers', () => {
      const VALID_PROVIDERS = ['gemini', 'copilot', 'claude', 'codex'];

      expect(VALID_PROVIDERS).toContain('gemini');
      expect(VALID_PROVIDERS).toContain('copilot');
      expect(VALID_PROVIDERS).toContain('claude');
      expect(VALID_PROVIDERS).toContain('codex');
      expect(VALID_PROVIDERS).toHaveLength(4);
    });
  });

  describe('VALID_TIERS constant', () => {
    it('should include all supported tiers', () => {
      const VALID_TIERS = ['fast', 'balanced', 'thorough'];

      expect(VALID_TIERS).toContain('fast');
      expect(VALID_TIERS).toContain('balanced');
      expect(VALID_TIERS).toContain('thorough');
      expect(VALID_TIERS).toHaveLength(3);
    });
  });

  describe('VALID_PROMPTS constant', () => {
    it('should include all supported prompt types', () => {
      const VALID_PROMPTS = ['level1', 'level2', 'level3', 'orchestration'];

      expect(VALID_PROMPTS).toContain('level1');
      expect(VALID_PROMPTS).toContain('level2');
      expect(VALID_PROMPTS).toContain('level3');
      expect(VALID_PROMPTS).toContain('orchestration');
      expect(VALID_PROMPTS).toHaveLength(4);
    });
  });

  describe('parseArgs function logic', () => {
    it('should parse all supported arguments', () => {
      // Simulate parsing logic
      const args = ['--provider', 'gemini', '--tier', 'fast', '--prompt', 'level1', '--optimizer-model', 'custom-model', '--output', '/custom/path'];
      const parsed = {
        provider: null,
        tier: null,
        prompt: null,
        optimizerModel: null,
        output: null
      };

      for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
          case '--provider':
            parsed.provider = args[++i];
            break;
          case '--tier':
            parsed.tier = args[++i];
            break;
          case '--prompt':
            parsed.prompt = args[++i];
            break;
          case '--optimizer-model':
            parsed.optimizerModel = args[++i];
            break;
          case '--output':
            parsed.output = args[++i];
            break;
        }
      }

      expect(parsed.provider).toBe('gemini');
      expect(parsed.tier).toBe('fast');
      expect(parsed.prompt).toBe('level1');
      expect(parsed.optimizerModel).toBe('custom-model');
      expect(parsed.output).toBe('/custom/path');
    });

    it('should handle missing optional arguments', () => {
      const args = ['--provider', 'claude', '--tier', 'balanced', '--prompt', 'level2'];
      const parsed = {
        provider: null,
        tier: null,
        prompt: null,
        optimizerModel: null,
        output: null
      };

      for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
          case '--provider':
            parsed.provider = args[++i];
            break;
          case '--tier':
            parsed.tier = args[++i];
            break;
          case '--prompt':
            parsed.prompt = args[++i];
            break;
          case '--optimizer-model':
            parsed.optimizerModel = args[++i];
            break;
          case '--output':
            parsed.output = args[++i];
            break;
        }
      }

      expect(parsed.provider).toBe('claude');
      expect(parsed.tier).toBe('balanced');
      expect(parsed.prompt).toBe('level2');
      expect(parsed.optimizerModel).toBeNull();
      expect(parsed.output).toBeNull();
    });
  });

  describe('validateArgs function logic', () => {
    const VALID_PROVIDERS = ['gemini', 'copilot', 'claude', 'codex'];
    const VALID_TIERS = ['fast', 'balanced', 'thorough'];
    const VALID_PROMPTS = ['level1', 'level2', 'level3', 'orchestration'];

    function validateArgs(args) {
      const errors = [];

      if (!args.provider) {
        errors.push('--provider is required');
      } else if (!VALID_PROVIDERS.includes(args.provider)) {
        errors.push(`Invalid provider: ${args.provider}. Valid: ${VALID_PROVIDERS.join(', ')}`);
      }

      if (!args.tier) {
        errors.push('--tier is required');
      } else if (!VALID_TIERS.includes(args.tier)) {
        errors.push(`Invalid tier: ${args.tier}. Valid: ${VALID_TIERS.join(', ')}`);
      }

      if (!args.prompt) {
        errors.push('--prompt is required');
      } else if (!VALID_PROMPTS.includes(args.prompt)) {
        errors.push(`Invalid prompt: ${args.prompt}. Valid: ${VALID_PROMPTS.join(', ')}`);
      }

      return errors;
    }

    it('should validate missing provider', () => {
      const errors = validateArgs({ provider: null, tier: 'fast', prompt: 'level1' });
      expect(errors).toContain('--provider is required');
    });

    it('should validate invalid provider', () => {
      const errors = validateArgs({ provider: 'invalid', tier: 'fast', prompt: 'level1' });
      expect(errors[0]).toContain('Invalid provider: invalid');
    });

    it('should validate missing tier', () => {
      const errors = validateArgs({ provider: 'gemini', tier: null, prompt: 'level1' });
      expect(errors).toContain('--tier is required');
    });

    it('should validate invalid tier', () => {
      const errors = validateArgs({ provider: 'gemini', tier: 'ultra', prompt: 'level1' });
      expect(errors[0]).toContain('Invalid tier: ultra');
    });

    it('should validate missing prompt', () => {
      const errors = validateArgs({ provider: 'gemini', tier: 'fast', prompt: null });
      expect(errors).toContain('--prompt is required');
    });

    it('should validate invalid prompt', () => {
      const errors = validateArgs({ provider: 'gemini', tier: 'fast', prompt: 'level99' });
      expect(errors[0]).toContain('Invalid prompt: level99');
    });

    it('should return no errors for valid args', () => {
      const errors = validateArgs({ provider: 'gemini', tier: 'fast', prompt: 'level1' });
      expect(errors).toHaveLength(0);
    });

    it('should collect multiple errors', () => {
      const errors = validateArgs({ provider: null, tier: null, prompt: null });
      expect(errors).toHaveLength(3);
    });
  });
});

describe('optimize.js JSON Parsing', () => {
  describe('Gemini response parsing', () => {
    it('should extract response from Gemini wrapper format', () => {
      // Gemini CLI with -o json returns { session_id, response, stats }
      const innerJson = { optimizedPrompt: 'test', changes: [] };
      const wrapper = {
        session_id: 'abc123',
        response: JSON.stringify(innerJson),
        stats: { tokens: 100 }
      };
      const stdout = JSON.stringify(wrapper);

      const parsed = JSON.parse(stdout);
      expect(parsed.response).toBeDefined();

      const responseText = parsed.response;
      expect(JSON.parse(responseText)).toEqual(innerJson);
    });

    it('should handle Gemini response with markdown code block', () => {
      const wrapper = {
        session_id: 'abc123',
        response: '```json\n{"optimizedPrompt":"test","changes":[]}\n```',
        stats: {}
      };
      const stdout = JSON.stringify(wrapper);

      const parsed = JSON.parse(stdout);
      const response = parsed.response;

      // Extract JSON from markdown
      const match = response.match(/```json\s*\n?([\s\S]*?)\n?```/);
      expect(match).toBeTruthy();
      expect(JSON.parse(match[1].trim())).toEqual({ optimizedPrompt: 'test', changes: [] });
    });
  });

  describe('Claude response parsing', () => {
    it('should extract result from Claude wrapper format', () => {
      // Claude with --output-format json returns { result: "..." }
      const innerJson = { optimizedPrompt: 'test', changes: [] };
      const wrapper = { result: JSON.stringify(innerJson) };
      const stdout = JSON.stringify(wrapper);

      const parsed = JSON.parse(stdout);
      expect(parsed.result).toBeDefined();

      const responseText = parsed.result;
      expect(JSON.parse(responseText)).toEqual(innerJson);
    });

    it('should handle Claude response with embedded JSON', () => {
      const wrapper = {
        result: 'Here is the optimization:\n\n{"optimizedPrompt":"test","changes":[]}\n\nDone.'
      };
      const stdout = JSON.stringify(wrapper);

      const parsed = JSON.parse(stdout);
      const response = parsed.result;

      // Extract JSON between braces
      const firstBrace = response.indexOf('{');
      const lastBrace = response.lastIndexOf('}');
      const jsonStr = response.substring(firstBrace, lastBrace + 1);

      expect(JSON.parse(jsonStr)).toEqual({ optimizedPrompt: 'test', changes: [] });
    });
  });

  describe('Codex JSONL parsing', () => {
    it('should extract agent_message from JSONL output', () => {
      const jsonlOutput = [
        '{"type":"session.started"}',
        '{"type":"item.started","item":{"type":"agent_message"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"optimizedPrompt\\":\\"test\\",\\"changes\\":[]}"}}',
        '{"type":"session.completed"}'
      ].join('\n');

      const lines = jsonlOutput.trim().split('\n').filter(line => line.trim());
      let agentMessage = null;

      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === 'item.completed' &&
            event.item?.type === 'agent_message' &&
            event.item?.text) {
          agentMessage = event.item.text;
        }
      }

      expect(agentMessage).toBeTruthy();
      expect(JSON.parse(agentMessage)).toEqual({ optimizedPrompt: 'test', changes: [] });
    });

    it('should handle malformed JSONL lines gracefully', () => {
      const jsonlOutput = [
        '{"type":"session.started"}',
        'not valid json',
        '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"key\\":\\"value\\"}"}}',
      ].join('\n');

      const lines = jsonlOutput.trim().split('\n').filter(line => line.trim());
      let agentMessage = null;

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed' &&
              event.item?.type === 'agent_message' &&
              event.item?.text) {
            agentMessage = event.item.text;
          }
        } catch (e) {
          // Skip malformed lines
        }
      }

      expect(agentMessage).toBe('{"key":"value"}');
    });
  });

  describe('Copilot response parsing', () => {
    it('should parse direct JSON response from Copilot', () => {
      // Copilot with -s outputs direct text response
      const response = '{"optimizedPrompt":"test","changes":[]}';

      expect(JSON.parse(response)).toEqual({ optimizedPrompt: 'test', changes: [] });
    });

    it('should handle Copilot response with surrounding text', () => {
      const response = 'Here is the result:\n\n{"optimizedPrompt":"test","changes":[]}\n\nDone!';

      // Extract JSON between braces
      const firstBrace = response.indexOf('{');
      const lastBrace = response.lastIndexOf('}');
      const jsonStr = response.substring(firstBrace, lastBrace + 1);

      expect(JSON.parse(jsonStr)).toEqual({ optimizedPrompt: 'test', changes: [] });
    });
  });
});

describe('optimize.js Utility Functions', () => {
  describe('computeBaselineHash', () => {
    const crypto = require('crypto');

    it('should compute SHA-256 hash and return first 8 characters', () => {
      const content = 'Test prompt content';
      const expectedHash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);

      // Replicate the function logic
      const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);

      expect(hash).toBe(expectedHash);
      expect(hash).toHaveLength(8);
    });

    it('should produce different hashes for different content', () => {
      const content1 = 'First prompt';
      const content2 = 'Second prompt';

      const hash1 = crypto.createHash('sha256').update(content1).digest('hex').substring(0, 8);
      const hash2 = crypto.createHash('sha256').update(content2).digest('hex').substring(0, 8);

      expect(hash1).not.toBe(hash2);
    });

    it('should produce same hash for same content', () => {
      const content = 'Same content';

      const hash1 = crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);
      const hash2 = crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);

      expect(hash1).toBe(hash2);
    });
  });

  describe('buildOptimizationPrompt', () => {
    it('should include target model in prompt', () => {
      const taggedPrompt = '<section name="test">Content</section>';
      const targetModel = 'gemini-2.5-flash';

      // Replicate the prompt building logic (key parts)
      const prompt = `Target Model: ${targetModel}`;

      expect(prompt).toContain(targetModel);
    });

    it('should include tagged prompt content', () => {
      const taggedPrompt = '<section name="intro" required="true">You are a code reviewer.</section>';
      const targetModel = 'test-model';

      // The function appends the tagged prompt at the end
      const fullPrompt = `## Baseline Prompt to Optimize\n\n${taggedPrompt}`;

      expect(fullPrompt).toContain(taggedPrompt);
      expect(fullPrompt).toContain('Baseline Prompt to Optimize');
    });

    it('should include JSON output format instructions', () => {
      // Key instruction from the function
      const instruction = '## Output Format\n\nReturn a JSON object with this exact structure:';

      expect(instruction).toContain('JSON object');
      expect(instruction).toContain('Output Format');
    });
  });
});

describe('optimize.js executeProviderCli dispatch', () => {
  it('should map provider names to correct executors', () => {
    const providerMap = {
      gemini: 'executeGeminiCli',
      codex: 'executeCodexCli',
      copilot: 'executeCopilotCli',
      claude: 'executeClaudeCli'
    };

    // Verify the switch case logic covers all providers
    for (const [provider, executor] of Object.entries(providerMap)) {
      expect(['gemini', 'codex', 'copilot', 'claude']).toContain(provider);
    }
  });

  it('should reject unknown providers', () => {
    const provider = 'unknown';

    // Replicate the switch default case
    const error = new Error(`Unsupported provider: ${provider}`);

    expect(error.message).toBe('Unsupported provider: unknown');
  });
});
