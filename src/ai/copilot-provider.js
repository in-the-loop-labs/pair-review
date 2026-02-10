// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * GitHub Copilot AI Provider
 *
 * Implements the AI provider interface for GitHub's Copilot CLI.
 * Uses the `copilot -p` command for non-interactive execution.
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
 * Copilot model definitions with tier mappings
 *
 * GitHub Copilot CLI supports multiple AI models including OpenAI,
 * Anthropic, and Google models via the --model flag.
 * Available models (as of Feb 2026): claude-haiku-4.5, claude-sonnet-4.5,
 * gemini-3-pro-preview, gpt-5.2-codex, gpt-5.3-codex, claude-opus-4.5,
 * claude-opus-4.6. Default is claude-sonnet-4.5.
 */
const COPILOT_MODELS = [
  {
    id: 'claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    tier: 'fast',
    tagline: 'Quick Scan',
    description: 'Rapid feedback for obvious issues, style checks, and simple logic errors',
    badge: 'Speedy',
    badgeClass: 'badge-speed'
  },
  {
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    tier: 'balanced',
    tagline: 'Reliable Review',
    description: 'Copilot default—strong code understanding with excellent quality-to-cost ratio',
    badge: 'Recommended',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'gemini-3-pro-preview',
    name: 'Gemini 3 Pro',
    tier: 'balanced',
    tagline: 'Strong Alternative',
    description: "Google's most capable model—strong reasoning for cross-file analysis",
    badge: 'Balanced',
    badgeClass: 'badge-balanced'
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2 Codex',
    tier: 'balanced',
    tagline: 'Alternative View',
    description: 'OpenAI code-specialized model—different perspective for cross-file analysis',
    badge: 'Balanced',
    badgeClass: 'badge-balanced'
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    tier: 'thorough',
    tagline: 'Deep Code Analysis',
    description: 'Latest OpenAI code-specialized model with deep reasoning for complex reviews',
    badge: 'Thorough',
    badgeClass: 'badge-power'
  },
  {
    id: 'claude-opus-4.5',
    name: 'Claude Opus 4.5',
    tier: 'thorough',
    tagline: 'Deep Analysis',
    description: 'Highly capable model for critical code reviews—strong reasoning for security and architecture',
    badge: 'Premium',
    badgeClass: 'badge-premium'
  },
  {
    id: 'claude-opus-4.6',
    name: 'Claude Opus 4.6',
    tier: 'thorough',
    tagline: 'Most Capable',
    description: 'Most capable model for critical code reviews—deep reasoning for security and architecture',
    badge: 'Premium',
    badgeClass: 'badge-premium'
  }
];

class CopilotProvider extends AIProvider {
  /**
   * @param {string} model - Model identifier
   * @param {Object} configOverrides - Config overrides from providers config
   * @param {string} configOverrides.command - Custom CLI command
   * @param {string[]} configOverrides.extra_args - Additional CLI arguments
   * @param {Object} configOverrides.env - Additional environment variables
   * @param {Object[]} configOverrides.models - Custom model definitions
   */
  constructor(model = 'claude-sonnet-4.5', configOverrides = {}) {
    super(model);

    // Command precedence: ENV > config > default
    const envCmd = process.env.PAIR_REVIEW_COPILOT_CMD;
    const configCmd = configOverrides.command;
    const copilotCmd = envCmd || configCmd || 'copilot';

    // Store for use in getExtractionConfig and testAvailability
    this.copilotCmd = copilotCmd;
    this.configOverrides = configOverrides;

    // For multi-word commands, use shell mode (same pattern as other providers)
    this.useShell = copilotCmd.includes(' ');

    // Store base args for later - prompt value will be inserted after -p flag
    // -p: non-interactive prompt mode (exits after completion)
    // --model: specify the AI model
    // -s: silent mode (output only agent response, no stats)
    //
    // SECURITY: Use --allow-tool and --deny-tool to control tool permissions.
    //
    // Copilot CLI permission flags:
    // - --allow-tool <pattern>: Whitelist tools (supports glob patterns)
    // - --deny-tool <pattern>: Blacklist tools (takes precedence over allow)
    // - --allow-all-tools: Auto-approve all tools without prompts
    //
    // For shell commands, use shell(<prefix>) syntax to match command prefixes.
    // E.g., shell(git) allows "git status", "git diff", etc.
    // ============================================================================

    // In yolo mode, skip all deny rules: everything is permitted (including writes, rm, git push)
    const permissionArgs = configOverrides.yolo
      ? ['--allow-all-tools', '--allow-all-paths']
      : [
          // Allow specific read-only git commands (not blanket 'git' to block git commit, push, etc.)
          '--allow-tool', 'shell(git diff)',
          '--allow-tool', 'shell(git log)',
          '--allow-tool', 'shell(git show)',
          '--allow-tool', 'shell(git status)',
          '--allow-tool', 'shell(git branch)',
          '--allow-tool', 'shell(git rev-parse)',
          '--allow-tool', 'shell(git sparse-checkout)',
          // Custom tool for annotated diff line mapping (matches both direct and path invocations)
          '--allow-tool', 'shell(git-diff-lines)',
          '--allow-tool', 'shell(*/git-diff-lines)',  // Absolute path invocation
          // Allow read-only shell commands
          '--allow-tool', 'shell(ls)',            // Directory listing
          '--allow-tool', 'shell(cat)',           // File content viewing
          '--allow-tool', 'shell(pwd)',           // Current directory
          '--allow-tool', 'shell(head)',          // File head viewing
          '--allow-tool', 'shell(tail)',          // File tail viewing
          '--allow-tool', 'shell(wc)',            // Word/line count
          '--allow-tool', 'shell(find)',          // File finding
          '--allow-tool', 'shell(grep)',          // Pattern searching
          '--allow-tool', 'shell(rg)',            // Ripgrep (fast pattern searching)
          // Deny dangerous shell commands (takes precedence over allow)
          '--deny-tool', 'shell(rm)',
          '--deny-tool', 'shell(mv)',
          '--deny-tool', 'shell(chmod)',
          '--deny-tool', 'shell(chown)',
          '--deny-tool', 'shell(sudo)',
          '--deny-tool', 'shell(git commit)',
          '--deny-tool', 'shell(git push)',
          '--deny-tool', 'shell(git checkout)',
          '--deny-tool', 'shell(git reset)',
          '--deny-tool', 'shell(git rebase)',
          '--deny-tool', 'shell(git merge)',
          // Block file write tools
          '--deny-tool', 'write',
          // Auto-approve remaining tools to avoid interactive prompts
          '--allow-all-tools',
          // Allow access to all paths (needed for analyzing files outside cwd)
          '--allow-all-paths',
        ];

    // Build args: base args + provider extra_args + model extra_args
    const baseArgs = ['--model', model, ...permissionArgs, '-s'];
    const providerArgs = configOverrides.extra_args || [];
    const modelConfig = configOverrides.models?.find(m => m.id === model);
    const modelArgs = modelConfig?.extra_args || [];

    // Merge env: provider env + model env
    this.extraEnv = {
      ...(configOverrides.env || {}),
      ...(modelConfig?.env || {})
    };

    // Command and base args are the same regardless of shell mode
    // (shell mode only affects how command is built in execute())
    this.command = copilotCmd;
    // Args without the prompt - prompt will be added as value to -p flag in execute()
    this.baseArgs = [...baseArgs, ...providerArgs, ...modelArgs];
  }

  /**
   * Execute Copilot CLI with a prompt
   * @param {string} prompt - The prompt to send to Copilot
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      // Note: Copilot does not support streaming — output is plain text returned on process exit, not JSONL.
      // onStreamEvent is therefore not destructured here (no StreamParser integration).
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', analysisId, registerProcess } = options;

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
        // Build: copilot --model X --deny-tool ... -s -p 'prompt'
        fullCommand = `${this.command} ${this.baseArgs.join(' ')} -p '${escapedPrompt}'`;
        fullArgs = [];
      } else {
        // Build args array: --model X --deny-tool ... -s -p <prompt>
        fullArgs = [...this.baseArgs, '-p', prompt];
      }

      const copilot = spawn(fullCommand, fullArgs, {
        cwd,
        env: {
          ...process.env,
          ...this.extraEnv,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: this.useShell
      });

      const pid = copilot.pid;
      logger.info(`${levelPrefix} Spawned Copilot CLI process: PID ${pid}`);

      // Register process for cancellation tracking if analysisId provided
      if (analysisId && registerProcess) {
        registerProcess(analysisId, copilot);
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

        // Check for cancellation signals (SIGTERM=143, SIGKILL=137)
        const isCancellationCode = code === 143 || code === 137;
        if (isCancellationCode && analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} Copilot CLI terminated due to analysis cancellation (exit code ${code})`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

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
          // Regex extraction failed, try LLM-based extraction as fallback
          logger.warn(`${levelPrefix} Regex extraction failed: ${extracted.error}`);
          logger.info(`${levelPrefix} Raw response length: ${stdout.length} characters`);
          logger.info(`${levelPrefix} Attempting LLM-based JSON extraction fallback...`);

          // Use async IIFE to handle the async LLM extraction
          (async () => {
            try {
              const llmExtracted = await this.extractJSONWithLLM(stdout, { level, analysisId, registerProcess });
              if (llmExtracted.success) {
                logger.success(`${levelPrefix} LLM extraction fallback succeeded`);
                settle(resolve, llmExtracted.data);
              } else {
                logger.warn(`${levelPrefix} LLM extraction fallback also failed: ${llmExtracted.error}`);
                logger.info(`${levelPrefix} Raw response preview: ${stdout.substring(0, 500)}...`);
                settle(resolve, { raw: stdout, parsed: false });
              }
            } catch (llmError) {
              logger.warn(`${levelPrefix} LLM extraction fallback error: ${llmError.message}`);
              settle(resolve, { raw: stdout, parsed: false });
            }
          })();
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
   * Build args for Copilot CLI extraction, applying provider and model extra_args.
   * This ensures consistent arg construction for getExtractionConfig().
   *
   * Note: For extraction, we use simple args without tool restrictions since
   * extraction doesn't need tool access.
   *
   * @param {string} model - The model identifier to use
   * @returns {string[]} Complete args array for the CLI
   */
  buildArgsForModel(model) {
    // Base args for extraction (simple silent mode, no tools needed)
    const baseArgs = ['--model', model, '-s'];
    // Provider-level extra_args (from configOverrides)
    const providerArgs = this.configOverrides?.extra_args || [];
    // Model-specific extra_args (from the model config for the given model)
    const modelConfig = this.configOverrides?.models?.find(m => m.id === model);
    const modelArgs = modelConfig?.extra_args || [];

    return [...baseArgs, ...providerArgs, ...modelArgs];
  }

  /**
   * Get CLI configuration for LLM extraction.
   * Copilot reads from stdin when no -p argument is provided.
   * @param {string} model - The model to use for extraction
   * @returns {Object} Configuration for spawning extraction process
   */
  getExtractionConfig(model) {
    // Use the already-resolved command from the constructor (this.copilotCmd)
    // which respects: ENV > config > default precedence
    const copilotCmd = this.copilotCmd;
    const useShell = this.useShell;

    // Build args consistently using the shared method, applying provider and model extra_args
    const args = this.buildArgsForModel(model);

    // Use stdin for prompt - safer than command args for arbitrary content
    if (useShell) {
      return {
        command: `${copilotCmd} ${args.join(' ')}`,
        args: [],
        useShell: true,
        promptViaStdin: true
      };
    }
    return {
      command: copilotCmd,
      args,
      useShell: false,
      promptViaStdin: true
    };
  }

  /**
   * Test if Copilot CLI is available
   * Uses the command configured in the instance (respects ENV > config > default precedence)
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    return new Promise((resolve) => {
      // For availability test, check --version
      // Use the already-resolved command from the constructor (this.copilotCmd)
      // which respects: ENV > config > default precedence
      const useShell = this.useShell;
      const command = useShell ? `${this.copilotCmd} --version` : this.copilotCmd;
      const args = useShell ? [] : ['--version'];

      // Log the actual command for debugging config/override issues
      const fullCmd = useShell ? command : `${command} ${args.join(' ')}`;
      logger.debug(`Copilot availability check: ${fullCmd}`);

      const copilot = spawn(command, args, {
        env: {
          ...process.env,
          PATH: `${BIN_DIR}:${process.env.PATH}`
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
    return 'claude-sonnet-4.5';
  }

  static getInstallInstructions() {
    return 'Install GitHub Copilot CLI: npm install -g @github/copilot\n' +
           'Or visit: https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli';
  }
}

// Register this provider
registerProvider('copilot', CopilotProvider);

module.exports = CopilotProvider;
