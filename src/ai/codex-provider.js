/**
 * Codex AI Provider
 *
 * Implements the AI provider interface for OpenAI's Codex CLI.
 * Uses the `codex exec` command for non-interactive execution.
 */

const path = require('path');
const { spawn } = require('child_process');
const { AIProvider, registerProvider } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { CancellationError, isAnalysisCancelled } = require('../routes/shared');

// Directory containing bin scripts (git-diff-lines, etc.)
const BIN_DIR = path.join(__dirname, '..', '..', 'bin');

/**
 * Codex model definitions with tier mappings
 *
 * Based on OpenAI Codex Models guide (developers.openai.com/codex/models)
 * - gpt-5.1-codex-mini: Smaller, cost-effective variant for quick scans
 * - gpt-5.1-codex-max: Optimized for long-horizon agentic coding tasks
 * - gpt-5.2-codex: Most advanced agentic coding model for real-world engineering
 */
const CODEX_MODELS = [
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1 Mini',
    tier: 'fast',
    tagline: 'Blazing Fast',
    description: 'Quick, low-cost reviews for style issues, obvious bugs, and lint-level feedback.',
    badge: 'Fastest',
    badgeClass: 'badge-speed'
  },
  {
    id: 'gpt-5.1-codex-max',
    name: 'GPT-5.1 Max',
    tier: 'balanced',
    tagline: 'Best Balance',
    description: 'Strong everyday reviewer—quality + speed for PR-sized changes and practical suggestions.',
    badge: 'Recommended',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2',
    tier: 'thorough',
    tagline: 'Deep Review',
    description: 'Most capable for complex diffs—finds subtle issues, reasons across files, and proposes step-by-step fixes.',
    badge: 'Most Thorough',
    badgeClass: 'badge-power'
  }
];

class CodexProvider extends AIProvider {
  constructor(model = 'gpt-5.1-codex-max') {
    super(model);

    // Check for environment variable to override default command
    // Supports multi-word commands like "npx codex" or "/path/to/codex --verbose"
    const codexCmd = process.env.PAIR_REVIEW_CODEX_CMD || 'codex';

    // For multi-word commands, use shell mode (same pattern as Claude provider)
    this.useShell = codexCmd.includes(' ');

    // SECURITY: Codex sandbox modes and shell execution
    //
    // Codex sandbox modes:
    // - read-only: Can browse files but CANNOT run shell commands (too restrictive)
    // - workspace-write: Can read, edit, run commands in working directory only
    // - danger-full-access: Full system access (too permissive)
    //
    // For code review, we need shell commands (git, git-diff-lines) but don't need
    // network access or writes outside the worktree. We use "workspace-write" because:
    // 1. We run in a dedicated worktree, not the main repo
    // 2. "read-only" prevents ALL shell commands including git-diff-lines
    // 3. The AI is instructed to only analyze code, not modify it
    //
    // --full-auto: Non-interactive mode that auto-approves within sandbox bounds.
    // Combined with workspace-write sandbox, this limits damage to the worktree only.
    // Note: The -a flag is for interactive mode only; exec subcommand uses --full-auto.
    if (this.useShell) {
      // In shell mode, build full command string with args
      this.command = `${codexCmd} exec -m ${model} --json --sandbox workspace-write --full-auto -`;
      this.args = [];
    } else {
      this.command = codexCmd;
      this.args = ['exec', '-m', model, '--json', '--sandbox', 'workspace-write', '--full-auto', '-'];
    }
  }

  /**
   * Execute Codex CLI with a prompt
   * @param {string} prompt - The prompt to send to Codex
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', analysisId, registerProcess } = options;

      const levelPrefix = `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing Codex CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} bytes`);

      const codex = spawn(this.command, this.args, {
        cwd,
        env: {
          ...process.env,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: this.useShell
      });

      const pid = codex.pid;
      logger.info(`${levelPrefix} Spawned Codex CLI process: PID ${pid}`);

      // Register process for cancellation tracking if analysisId provided
      if (analysisId && registerProcess) {
        registerProcess(analysisId, codex);
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
          codex.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Codex CLI timed out after ${timeout}ms`));
        }, timeout);
      }

      // Collect stdout
      codex.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      // Collect stderr
      codex.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      codex.on('close', (code) => {
        if (settled) return;  // Already settled by timeout or error

        // Check for cancellation signals (SIGTERM=143, SIGKILL=137)
        const isCancellationCode = code === 143 || code === 137;
        if (isCancellationCode && analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} Codex CLI terminated due to analysis cancellation (exit code ${code})`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

        // Always log stderr if present
        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} Codex CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.warn(`${levelPrefix} Codex CLI stderr (success): ${stderr}`);
          }
        }

        if (code !== 0) {
          logger.error(`${levelPrefix} Codex CLI exited with code ${code}`);
          settle(reject, new Error(`${levelPrefix} Codex CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Parse the Codex JSONL response
        const parsed = this.parseCodexResponse(stdout, level);
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
      codex.on('error', (error) => {
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Codex CLI not found. Please ensure Codex CLI is installed.`);
          settle(reject, new Error(`${levelPrefix} Codex CLI not found. ${CodexProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Codex process error: ${error}`);
          settle(reject, error);
        }
      });

      // Send the prompt to stdin
      codex.stdin.write(prompt, (err) => {
        if (err) {
          logger.error(`${levelPrefix} Failed to write prompt to stdin: ${err}`);
          codex.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Failed to write prompt to stdin: ${err}`));
        }
      });
      codex.stdin.end();
    });
  }

  /**
   * Parse Codex CLI JSONL response
   * Codex outputs JSONL with multiple event types:
   * - thread.started: Session info
   * - turn.started: Turn begins
   * - item.completed: Contains reasoning or agent_message items
   * - turn.completed: Turn ends with usage stats
   *
   * We need to extract the agent_message content which contains the AI response.
   *
   * @param {string} stdout - Raw stdout from Codex CLI (JSONL format)
   * @param {string|number} level - Analysis level for logging
   * @returns {{success: boolean, data?: Object, error?: string}}
   */
  parseCodexResponse(stdout, level) {
    const levelPrefix = `[Level ${level}]`;

    try {
      // Split by newlines and parse each JSON line
      const lines = stdout.trim().split('\n').filter(line => line.trim());
      let agentMessage = null;

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Look for agent_message items which contain the actual response
          if (event.type === 'item.completed' &&
              event.item?.type === 'agent_message' &&
              event.item?.text) {
            agentMessage = event.item.text;
          }
        } catch (lineError) {
          // Skip malformed lines
          logger.debug(`${levelPrefix} Skipping malformed JSONL line: ${line.substring(0, 100)}`);
        }
      }

      if (agentMessage) {
        // The agent_message contains the AI's text response
        // Try to extract JSON from it (the AI was asked to output JSON)
        const extracted = extractJSON(agentMessage, level);
        if (extracted.success) {
          return extracted;
        }

        // If no JSON found, return the raw message
        logger.warn(`${levelPrefix} Agent message is not JSON, treating as raw text`);
        return { success: false, error: 'Agent message is not valid JSON' };
      }

      // No agent message found, try extracting JSON directly from stdout
      const extracted = extractJSON(stdout, level);
      return extracted;

    } catch (parseError) {
      // stdout might not be valid JSONL at all, try extracting JSON from it
      const extracted = extractJSON(stdout, level);
      if (extracted.success) {
        return extracted;
      }

      return { success: false, error: `JSONL parse error: ${parseError.message}` };
    }
  }

  /**
   * Test if Codex CLI is available
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    return new Promise((resolve) => {
      // For availability test, we just need to check --version
      // Use shell mode if the command contains spaces
      const codexCmd = process.env.PAIR_REVIEW_CODEX_CMD || 'codex';
      const useShell = codexCmd.includes(' ');
      const command = useShell ? `${codexCmd} --version` : codexCmd;
      const args = useShell ? [] : ['--version'];

      const codex = spawn(command, args, {
        env: {
          ...process.env,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: useShell
      });

      let stdout = '';
      let settled = false;

      codex.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      codex.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (code === 0 && stdout.includes('codex')) {
          logger.info(`Codex CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          logger.warn('Codex CLI not available or returned unexpected output');
          resolve(false);
        }
      });

      codex.on('error', (error) => {
        if (settled) return;
        settled = true;
        logger.warn(`Codex CLI not available: ${error.message}`);
        resolve(false);
      });
    });
  }

  static getProviderName() {
    return 'Codex';
  }

  static getProviderId() {
    return 'codex';
  }

  static getModels() {
    return CODEX_MODELS;
  }

  static getDefaultModel() {
    return 'gpt-5.1-codex-max';
  }

  static getInstallInstructions() {
    return 'Install Codex CLI: npm install -g @openai/codex\n' +
           'Or visit: https://github.com/openai/codex';
  }
}

// Register this provider
registerProvider('codex', CodexProvider);

module.exports = CodexProvider;
