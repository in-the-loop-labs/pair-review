/**
 * Claude AI Provider
 *
 * Wraps the Claude CLI for use with the AI provider abstraction.
 */

const { spawn } = require('child_process');
const { AIProvider, registerProvider } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { CancellationError, isAnalysisCancelled } = require('../routes/shared');

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

    // SECURITY: Claude CLI with -p (print mode) requires explicit tool permissions.
    // We use --allowedTools to grant only read-only operations needed for code review:
    // - Read: Read file contents
    // - Bash(git *): Git commands (read operations like diff, log, show, status)
    // - Bash(*git-diff-lines*): Our annotated diff script
    // - Bash(cat *), Bash(ls *), Bash(grep *), Bash(find *): Read-only shell commands
    //
    // Dangerous operations (Write, Edit, Bash(rm *), Bash(git push*), etc.) are NOT allowed.
    const allowedTools = [
      'Read',
      'Bash(git diff*)',
      'Bash(git log*)',
      'Bash(git show*)',
      'Bash(git status*)',
      'Bash(git branch*)',
      'Bash(git rev-parse*)',
      'Bash(*git-diff-lines*)',
      'Bash(cat *)',
      'Bash(ls *)',
      'Bash(head *)',
      'Bash(tail *)',
      'Bash(grep *)',
      'Bash(find *)',
    ].join(',');

    if (this.useShell) {
      this.command = `${claudeCmd} -p --model ${model} --allowedTools "${allowedTools}"`;
      this.args = [];
    } else {
      this.command = claudeCmd;
      this.args = ['-p', '--model', model, '--allowedTools', allowedTools];
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
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', analysisId, registerProcess } = options;

      const levelPrefix = `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing Claude CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} bytes`);

      const claude = spawn(this.command, this.args, {
        cwd,
        env: {
          ...process.env,
          PATH: process.env.PATH
        },
        shell: this.useShell
      });

      const pid = claude.pid;
      logger.info(`${levelPrefix} Spawned Claude CLI process: PID ${pid}`);

      // Register process for cancellation tracking if analysisId provided
      if (analysisId && registerProcess) {
        registerProcess(analysisId, claude);
        logger.info(`${levelPrefix} Registered process ${pid} for analysis ${analysisId}`);
      }

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
          claude.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Claude CLI timed out after ${timeout}ms`));
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
        if (settled) return;  // Already settled by timeout or error

        // Check for cancellation signals (SIGTERM=143, SIGKILL=137)
        const isCancellationCode = code === 143 || code === 137;
        if (isCancellationCode && analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} Claude CLI terminated due to analysis cancellation (exit code ${code})`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

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
          settle(reject, new Error(`${levelPrefix} Claude CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Extract JSON from the text response
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
      claude.on('error', (error) => {
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Claude CLI not found. Please ensure Claude CLI is installed.`);
          settle(reject, new Error(`${levelPrefix} Claude CLI not found. ${ClaudeProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Claude process error: ${error}`);
          settle(reject, error);
        }
      });

      // Send the prompt to stdin
      claude.stdin.write(prompt, (err) => {
        if (err) {
          logger.error(`${levelPrefix} Failed to write prompt to stdin: ${err}`);
          claude.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Failed to write prompt to stdin: ${err}`));
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
