// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Cursor Agent AI Provider
 *
 * Implements the AI provider interface for Cursor's Agent CLI.
 * Uses the `cursor-agent -p` command for non-interactive execution.
 */

const { spawn } = require('child_process');
const { AIProvider, registerProvider } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');

/**
 * Cursor Agent model definitions with tier mappings
 *
 * Cursor Agent supports multiple AI models via the --model flag.
 * The "auto" model provides free access with automatic model selection.
 */
const CURSOR_AGENT_MODELS = [
  {
    id: 'auto',
    name: 'Auto (Free)',
    tier: 'free',
    tagline: 'Free Tier',
    description: 'Automatic model selection - free to use with Cursor subscription',
    badge: 'Free',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    tier: 'fast',
    tagline: 'Lightning Fast',
    description: 'Rapid feedback for quick code scans and obvious issues',
    badge: 'Fastest',
    badgeClass: 'badge-speed'
  },
  {
    id: 'sonnet-4.5',
    name: 'Claude 4.5 Sonnet',
    tier: 'balanced',
    tagline: 'Everyday Reviews',
    description: 'Solid balance of speed and depth for everyday code reviews',
    badge: 'Balanced',
    badgeClass: 'badge-recommended'
  },
  {
    id: 'opus-4.5-thinking',
    name: 'Claude 4.5 Opus (Thinking)',
    tier: 'thorough',
    tagline: 'Deep Analysis',
    description: 'Extended reasoning for comprehensive, nuanced code reviews',
    badge: 'Thorough',
    badgeClass: 'badge-power'
  }
];

class CursorAgentProvider extends AIProvider {
  constructor(model = 'auto') {
    super(model);

    // Check for environment variable to override default command
    // Supports multi-word commands or custom paths
    const cursorAgentCmd = process.env.PAIR_REVIEW_CURSOR_AGENT_CMD || 'cursor-agent';

    // For multi-word commands, use shell mode (same pattern as other providers)
    this.useShell = cursorAgentCmd.includes(' ');

    // SECURITY: Cursor Agent uses --sandbox flag to control environment access.
    //
    // Cursor Agent sandbox modes:
    // - enabled: Runs in restricted sandbox (but details are not fully documented)
    // - disabled: Full system access
    //
    // Since cursor-agent is primarily designed for agentic coding tasks and the
    // sandbox behavior is not fully documented, we rely on:
    // 1. Prompt engineering: Analysis prompts instruct AI to only read, not modify
    // 2. Worktree isolation: Analysis runs in a git worktree, limiting blast radius
    // 3. Force mode (-f): Auto-approves commands to enable non-interactive execution
    //
    // Note: Unlike some other CLIs, cursor-agent doesn't expose fine-grained
    // tool permission flags. The sandbox flag is the main security control.
    //
    // -p/--print: Non-interactive mode
    // --output-format json: JSON output for parsing
    // -f/--force: Auto-approve commands (required for non-interactive)
    // --sandbox enabled: Enable sandbox mode for safety
    // --approve-mcps: Auto-approve MCP servers in headless mode
    if (this.useShell) {
      // In shell mode, build full command string with args
      this.command = `${cursorAgentCmd} -p --output-format json --model ${model} -f --sandbox enabled --approve-mcps`;
      this.args = [];
    } else {
      this.command = cursorAgentCmd;
      this.args = ['-p', '--output-format', 'json', '--model', model, '-f', '--sandbox', 'enabled', '--approve-mcps'];
    }
  }

  /**
   * Execute Cursor Agent CLI with a prompt
   * @param {string} prompt - The prompt to send to Cursor Agent
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown' } = options;

      const levelPrefix = `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing Cursor Agent CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} bytes`);

      // Build command with prompt as positional argument
      let fullCommand = this.command;
      let fullArgs;

      if (this.useShell) {
        // Escape the prompt for shell
        const escapedPrompt = prompt.replace(/'/g, "'\\''");
        // Build: cursor-agent -p --output-format json ... 'prompt'
        fullCommand = `${this.command} '${escapedPrompt}'`;
        fullArgs = [];
      } else {
        // Build args array with prompt as positional argument
        fullArgs = [...this.args, prompt];
      }

      const cursorAgent = spawn(fullCommand, fullArgs, {
        cwd,
        env: {
          ...process.env,
          PATH: process.env.PATH
        },
        shell: this.useShell
      });

      const pid = cursorAgent.pid;
      logger.info(`${levelPrefix} Spawned Cursor Agent CLI process: PID ${pid}`);

      let stdout = '';
      let stderr = '';
      let timeoutId = null;
      let settled = false;  // Guard against multiple resolve/reject calls

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        fn(value);
      };

      // Set timeout
      if (timeout) {
        timeoutId = setTimeout(() => {
          logger.error(`${levelPrefix} Process ${pid} timed out after ${timeout}ms`);
          cursorAgent.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Cursor Agent CLI timed out after ${timeout}ms`));
        }, timeout);
      }

      // Collect stdout
      cursorAgent.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      // Collect stderr
      cursorAgent.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      cursorAgent.on('close', (code) => {
        if (settled) return;  // Already settled by timeout or error

        // Always log stderr if present
        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} Cursor Agent CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.warn(`${levelPrefix} Cursor Agent CLI stderr (success): ${stderr}`);
          }
        }

        if (code !== 0) {
          logger.error(`${levelPrefix} Cursor Agent CLI exited with code ${code}`);
          settle(reject, new Error(`${levelPrefix} Cursor Agent CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Parse the Cursor Agent JSON response
        const parsed = this.parseCursorAgentResponse(stdout, level);
        if (parsed.success) {
          logger.success(`${levelPrefix} Successfully parsed JSON response`);
          settle(resolve, parsed.data);
        } else {
          logger.warn(`${levelPrefix} Failed to extract JSON: ${parsed.error}`);
          logger.info(`${levelPrefix} Raw response length: ${stdout.length} characters`);
          logger.info(`${levelPrefix} Raw response preview: ${stdout.substring(0, 500)}...`);
          settle(resolve, { raw: stdout, parsed: false });
        }
      });

      // Handle errors
      cursorAgent.on('error', (error) => {
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Cursor Agent CLI not found. Please ensure Cursor Agent CLI is installed.`);
          settle(reject, new Error(`${levelPrefix} Cursor Agent CLI not found. ${CursorAgentProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Cursor Agent process error: ${error}`);
          settle(reject, error);
        }
      });
    });
  }

  /**
   * Parse Cursor Agent CLI JSON response
   * Cursor Agent with --output-format json returns structured output.
   * The response content may contain our review JSON that needs extraction.
   *
   * @param {string} stdout - Raw stdout from Cursor Agent CLI
   * @param {string|number} level - Analysis level for logging
   * @returns {{success: boolean, data?: Object, error?: string}}
   */
  parseCursorAgentResponse(stdout, level) {
    const levelPrefix = `[Level ${level}]`;

    try {
      // First, try to parse as JSON directly
      const cursorResponse = JSON.parse(stdout);

      // If the response has a specific structure, extract the content
      // Cursor Agent JSON output format may vary - adapt as needed
      if (cursorResponse.response) {
        // Try to extract our review JSON from the response field
        const extracted = extractJSON(cursorResponse.response, level);
        if (extracted.success) {
          return extracted;
        }
      }

      if (cursorResponse.content) {
        // Alternative structure with content field
        const extracted = extractJSON(cursorResponse.content, level);
        if (extracted.success) {
          return extracted;
        }
      }

      if (cursorResponse.text) {
        // Alternative structure with text field
        const extracted = extractJSON(cursorResponse.text, level);
        if (extracted.success) {
          return extracted;
        }
      }

      // Maybe the parsed JSON is the content we need directly
      if (cursorResponse.findings || cursorResponse.level) {
        return { success: true, data: cursorResponse };
      }

      // Try extracting JSON from the stringified response
      const extracted = extractJSON(stdout, level);
      return extracted;

    } catch (parseError) {
      // stdout might not be valid JSON at all, try extracting JSON from it
      const extracted = extractJSON(stdout, level);
      if (extracted.success) {
        return extracted;
      }

      return { success: false, error: `JSON parse error: ${parseError.message}` };
    }
  }

  /**
   * Test if Cursor Agent CLI is available
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    return new Promise((resolve) => {
      // For availability test, check --version
      const cursorAgentCmd = process.env.PAIR_REVIEW_CURSOR_AGENT_CMD || 'cursor-agent';
      const useShell = cursorAgentCmd.includes(' ');
      const command = useShell ? `${cursorAgentCmd} --version` : cursorAgentCmd;
      const args = useShell ? [] : ['--version'];

      const cursorAgent = spawn(command, args, {
        env: {
          ...process.env,
          PATH: process.env.PATH
        },
        shell: useShell
      });

      let stdout = '';
      let settled = false;

      cursorAgent.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      cursorAgent.on('close', (code) => {
        if (settled) return;
        settled = true;
        // Cursor Agent should return version info on success
        if (code === 0) {
          logger.info(`Cursor Agent CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          logger.warn('Cursor Agent CLI not available or returned unexpected output');
          resolve(false);
        }
      });

      cursorAgent.on('error', (error) => {
        if (settled) return;
        settled = true;
        logger.warn(`Cursor Agent CLI not available: ${error.message}`);
        resolve(false);
      });
    });
  }

  static getProviderName() {
    return 'Cursor Agent';
  }

  static getProviderId() {
    return 'cursor-agent';
  }

  static getModels() {
    return CURSOR_AGENT_MODELS;
  }

  static getDefaultModel() {
    return 'auto';
  }

  static getInstallInstructions() {
    return 'Install Cursor Agent CLI: npm install -g cursor-agent\n' +
           'Or visit: https://www.cursor.com/downloads';
  }
}

// Register this provider
registerProvider('cursor-agent', CursorAgentProvider);

module.exports = CursorAgentProvider;
