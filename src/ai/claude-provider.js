/**
 * Claude AI Provider
 *
 * Wraps the Claude CLI for use with the AI provider abstraction.
 */

const { spawn } = require('child_process');
const { AIProvider, registerProvider } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');

/**
 * Claude model definitions with tier mappings
 */
const CLAUDE_MODELS = [
  {
    id: 'haiku',
    name: 'Haiku',
    tier: 'fast',
    tagline: 'Lightning Fast',
    description: 'Quick analysis for simple changes',
    badge: 'Fastest',
    badgeClass: 'badge-speed'
  },
  {
    id: 'sonnet',
    name: 'Sonnet',
    tier: 'balanced',
    tagline: 'Best Balance',
    description: 'Recommended for most reviews',
    badge: 'Recommended',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'opus',
    name: 'Opus',
    tier: 'thorough',
    tagline: 'Most Capable',
    description: 'Deep analysis for complex code',
    badge: 'Most Thorough',
    badgeClass: 'badge-power'
  }
];

class ClaudeProvider extends AIProvider {
  constructor(model = 'sonnet') {
    super(model);

    // Check for environment variable to override default command
    const claudeCmd = process.env.PAIR_REVIEW_CLAUDE_CMD || 'claude';

    // For multi-word commands like "devx claude", use shell mode
    this.useShell = claudeCmd.includes(' ');

    if (this.useShell) {
      this.command = `${claudeCmd} -p --model ${model}`;
      this.args = [];
    } else {
      this.command = claudeCmd;
      this.args = ['-p', '--model', model];
    }
  }

  /**
   * Execute Claude CLI with a prompt
   * @param {string} prompt - The prompt to send to Claude
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown' } = options;

      const levelPrefix = `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing Claude CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} bytes`);

      const claude = spawn(this.command, this.args, {
        cwd,
        env: {
          ...process.env,
          PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin'
        },
        shell: this.useShell
      });

      const pid = claude.pid;
      logger.info(`${levelPrefix} Spawned Claude CLI process: PID ${pid}`);

      let stdout = '';
      let stderr = '';
      let timeoutId = null;

      // Set timeout
      if (timeout) {
        timeoutId = setTimeout(() => {
          logger.error(`${levelPrefix} Process ${pid} timed out after ${timeout}ms`);
          claude.kill('SIGTERM');
          reject(new Error(`${levelPrefix} Claude CLI timed out after ${timeout}ms`));
        }, timeout);
      }

      // Collect stdout
      claude.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      // Collect stderr
      claude.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      claude.on('close', (code) => {
        if (timeoutId) clearTimeout(timeoutId);

        // Always log stderr if present
        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} Claude CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.warn(`${levelPrefix} Claude CLI stderr (success): ${stderr}`);
          }
        }

        if (code !== 0) {
          logger.error(`${levelPrefix} Claude CLI exited with code ${code}`);
          reject(new Error(`${levelPrefix} Claude CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Extract JSON from the text response
        const extracted = extractJSON(stdout, level);
        if (extracted.success) {
          logger.success(`${levelPrefix} Successfully parsed JSON response`);
          resolve(extracted.data);
        } else {
          logger.warn(`${levelPrefix} Failed to extract JSON: ${extracted.error}`);
          logger.info(`${levelPrefix} Raw response length: ${stdout.length} characters`);
          logger.info(`${levelPrefix} Raw response preview: ${stdout.substring(0, 500)}...`);
          resolve({ raw: stdout, parsed: false });
        }
      });

      // Handle errors
      claude.on('error', (error) => {
        if (timeoutId) clearTimeout(timeoutId);

        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Claude CLI not found. Please ensure Claude CLI is installed.`);
          reject(new Error(`${levelPrefix} Claude CLI not found. ${ClaudeProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Claude process error: ${error}`);
          reject(error);
        }
      });

      // Send the prompt to stdin
      claude.stdin.write(prompt, (err) => {
        if (err) {
          logger.error(`${levelPrefix} Failed to write prompt to stdin: ${err}`);
          if (timeoutId) clearTimeout(timeoutId);
          claude.kill('SIGTERM');
          reject(new Error(`${levelPrefix} Failed to write prompt to stdin: ${err}`));
        }
      });
      claude.stdin.end();
    });
  }

  /**
   * Test if Claude CLI is available
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    try {
      const result = await this.execute('Respond with just: {"status": "ok"}', { timeout: 10000 });
      return result.status === 'ok' || result.raw?.includes('ok');
    } catch (error) {
      logger.warn(`Claude CLI not available: ${error.message}`);
      return false;
    }
  }

  static getProviderName() {
    return 'Claude';
  }

  static getProviderId() {
    return 'claude';
  }

  static getModels() {
    return CLAUDE_MODELS;
  }

  static getDefaultModel() {
    return 'sonnet';
  }

  static getInstallInstructions() {
    return 'Install Claude CLI: npm install -g @anthropic-ai/claude-code';
  }
}

// Register this provider
registerProvider('claude', ClaudeProvider);

module.exports = ClaudeProvider;
