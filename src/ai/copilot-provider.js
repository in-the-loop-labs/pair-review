/**
 * GitHub Copilot AI Provider
 *
 * Implements the AI provider interface for GitHub's Copilot CLI.
 * Uses the `copilot -p` command for non-interactive execution.
 */

const { spawn } = require('child_process');
const { AIProvider, registerProvider } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');

/**
 * Copilot model definitions with tier mappings
 *
 * GitHub Copilot CLI supports multiple AI models including OpenAI,
 * Anthropic, and Google models via the --model flag.
 */
const COPILOT_MODELS = [
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1 Mini',
    tier: 'fast',
    tagline: 'Quick Scan',
    description: 'Rapid feedback for obvious issues and style checks',
    badge: 'Speedy',
    badgeClass: 'badge-speed'
  },
  {
    id: 'gemini-3-pro-preview',
    name: 'Gemini 3 Pro',
    tier: 'balanced',
    tagline: 'Reliable Review',
    description: 'Solid everyday reviews with good coverage',
    badge: 'Recommended',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'gpt-5.1-codex-max',
    name: 'GPT-5.1 Max',
    tier: 'thorough',
    tagline: 'Deep Analysis',
    description: 'Comprehensive reviews for complex changes',
    badge: 'Thorough',
    badgeClass: 'badge-power'
  },
  {
    id: 'claude-opus-4.5',
    name: 'Claude Opus 4.5',
    tier: 'premium',
    tagline: 'Ultimate Review',
    description: 'The most capable model for critical code reviews',
    badge: 'Premium',
    badgeClass: 'badge-premium'
  }
];

class CopilotProvider extends AIProvider {
  constructor(model = 'gemini-3-pro-preview') {
    super(model);

    // Check for environment variable to override default command
    // Supports multi-word commands like "gh copilot" or custom paths
    const copilotCmd = process.env.PAIR_REVIEW_COPILOT_CMD || 'copilot';

    // For multi-word commands, use shell mode (same pattern as other providers)
    this.useShell = copilotCmd.includes(' ');

    // Store base args for later - prompt value will be inserted after -p flag
    // -p: non-interactive prompt mode (exits after completion)
    // --model: specify the AI model
    // --allow-all-tools: required for non-interactive mode
    // -s: silent mode (output only agent response, no stats)
    if (this.useShell) {
      // In shell mode, we'll build the full command in execute()
      this.command = copilotCmd;
      this.baseArgs = ['--model', model, '--allow-all-tools', '-s'];
    } else {
      this.command = copilotCmd;
      // Args without the prompt - prompt will be added as value to -p flag in execute()
      this.baseArgs = ['--model', model, '--allow-all-tools', '-s'];
    }
  }

  /**
   * Execute Copilot CLI with a prompt
   * @param {string} prompt - The prompt to send to Copilot
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown' } = options;

      const levelPrefix = `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing Copilot CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} bytes`);

      // Build the command with other args first, then -p <prompt> at the end
      // The -p flag expects the prompt value immediately after it
      let fullCommand = this.command;
      let fullArgs;

      if (this.useShell) {
        // Escape the prompt for shell
        const escapedPrompt = prompt.replace(/'/g, "'\\''");
        // Build: copilot --model X --allow-all-tools -s -p 'prompt'
        fullCommand = `${this.command} ${this.baseArgs.join(' ')} -p '${escapedPrompt}'`;
        fullArgs = [];
      } else {
        // Build args array: --model X --allow-all-tools -s -p <prompt>
        fullArgs = [...this.baseArgs, '-p', prompt];
      }

      const copilot = spawn(fullCommand, fullArgs, {
        cwd,
        env: {
          ...process.env,
          PATH: process.env.PATH
        },
        shell: this.useShell
      });

      const pid = copilot.pid;
      logger.info(`${levelPrefix} Spawned Copilot CLI process: PID ${pid}`);

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
          copilot.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Copilot CLI timed out after ${timeout}ms`));
        }, timeout);
      }

      // Collect stdout
      copilot.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      // Collect stderr
      copilot.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      copilot.on('close', (code) => {
        if (settled) return;  // Already settled by timeout or error

        // Always log stderr if present
        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} Copilot CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.warn(`${levelPrefix} Copilot CLI stderr (success): ${stderr}`);
          }
        }

        if (code !== 0) {
          logger.error(`${levelPrefix} Copilot CLI exited with code ${code}`);
          settle(reject, new Error(`${levelPrefix} Copilot CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Extract JSON from the response
        const extracted = extractJSON(stdout, level);
        if (extracted.success) {
          logger.success(`${levelPrefix} Successfully parsed JSON response`);
          settle(resolve, extracted.data);
        } else {
          logger.warn(`${levelPrefix} Failed to extract JSON: ${extracted.error}`);
          logger.info(`${levelPrefix} Raw response length: ${stdout.length} characters`);
          logger.info(`${levelPrefix} Raw response preview: ${stdout.substring(0, 500)}...`);
          settle(resolve, { raw: stdout, parsed: false });
        }
      });

      // Handle errors
      copilot.on('error', (error) => {
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Copilot CLI not found. Please ensure Copilot CLI is installed.`);
          settle(reject, new Error(`${levelPrefix} Copilot CLI not found. ${CopilotProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Copilot process error: ${error}`);
          settle(reject, error);
        }
      });
    });
  }

  /**
   * Test if Copilot CLI is available
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    return new Promise((resolve) => {
      // For availability test, check --version
      const copilotCmd = process.env.PAIR_REVIEW_COPILOT_CMD || 'copilot';
      const useShell = copilotCmd.includes(' ');
      const command = useShell ? `${copilotCmd} --version` : copilotCmd;
      const args = useShell ? [] : ['--version'];

      const copilot = spawn(command, args, {
        env: {
          ...process.env,
          PATH: process.env.PATH
        },
        shell: useShell
      });

      let stdout = '';
      let settled = false;

      copilot.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      copilot.on('close', (code) => {
        if (settled) return;
        settled = true;
        // Copilot CLI typically outputs version info on success
        if (code === 0) {
          logger.info(`Copilot CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          logger.warn('Copilot CLI not available or returned unexpected output');
          resolve(false);
        }
      });

      copilot.on('error', (error) => {
        if (settled) return;
        settled = true;
        logger.warn(`Copilot CLI not available: ${error.message}`);
        resolve(false);
      });
    });
  }

  static getProviderName() {
    return 'Copilot';
  }

  static getProviderId() {
    return 'copilot';
  }

  static getModels() {
    return COPILOT_MODELS;
  }

  static getDefaultModel() {
    return 'gemini-3-pro-preview';
  }

  static getInstallInstructions() {
    return 'Install GitHub Copilot CLI: npm install -g @github/copilot\n' +
           'Or visit: https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli';
  }
}

// Register this provider
registerProvider('copilot', CopilotProvider);

module.exports = CopilotProvider;
