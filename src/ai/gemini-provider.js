/**
 * Gemini AI Provider
 *
 * Implements the AI provider interface for Google's Gemini CLI.
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
 * Gemini model definitions with tier mappings
 */
const GEMINI_MODELS = [
  {
    id: 'gemini-3-flash-preview',
    name: '3.0 Flash',
    tier: 'fast',
    tagline: 'Rapid Sanity Check',
    description: 'Best for catching syntax, typos, and simple logic errors',
    badge: 'Quick Look',
    badgeClass: 'badge-speed'
  },
  {
    id: 'gemini-2.5-pro',
    name: '2.5 Pro',
    tier: 'balanced',
    tagline: 'Standard PR Review',
    description: 'Reliable feedback on code style, features, and refactoring',
    badge: 'Daily Driver',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'gemini-3-pro-preview',
    name: '3.0 Pro',
    tier: 'thorough',
    tagline: 'Architectural Audit',
    description: 'Deep analysis for race conditions, security, and edge cases',
    badge: 'Deep Dive',
    badgeClass: 'badge-power'
  }
];

class GeminiProvider extends AIProvider {
  constructor(model = 'gemini-2.5-pro') {
    super(model);

    // Check for environment variable to override default command
    // Supports multi-word commands like "npx gemini" or "/path/to/gemini --verbose"
    const geminiCmd = process.env.PAIR_REVIEW_GEMINI_CMD || 'gemini';

    // For multi-word commands, use shell mode (same pattern as Claude provider)
    this.useShell = geminiCmd.includes(' ');

    // ============================================================================
    // SECURITY LIMITATION - READ CAREFULLY
    // ============================================================================
    //
    // IMPORTANT: Unlike Claude and Copilot providers, Gemini CLI does NOT have a
    // mechanism to restrict which tools the model can request. The --allowed-tools
    // flag only controls which tools are AUTO-APPROVED (no interactive prompt), but
    // all tools remain available to the model.
    //
    // Gemini tool names (from asking the CLI):
    // - list_directory, read_file, search_file_content, glob: File system read operations
    // - run_shell_command: Execute shell commands (needed for git, git-diff-lines)
    // - google_web_search: Web search
    // - write_file, replace: Write operations (NOT auto-approved but still available)
    //
    // In non-interactive mode (-o json), if the model requests a tool not in --allowed-tools,
    // the operation may fail or the tool may still execute without explicit user approval.
    //
    // MITIGATION STRATEGY:
    // 1. Prompt engineering: The analysis prompts in analyzer.js explicitly instruct
    //    the AI to only use read-only operations and never modify files
    // 2. Worktree isolation: Analysis runs in a git worktree, limiting blast radius
    // 3. Shell command restrictions: Use prefix-based allowlist for shell commands
    //
    // If a mechanism to restrict tool visibility becomes available in Gemini CLI,
    // it should be added here similar to Copilot's --excluded-tools flag.
    // ============================================================================
    //
    // SHELL COMMAND PREFIX SYNTAX:
    // The --allowed-tools flag supports prefix matching via run_shell_command(prefix).
    // E.g., run_shell_command(git) allows "git status", "git diff", etc.
    // Commands NOT matching any prefix will be denied in non-interactive mode.
    // ============================================================================
    const readOnlyTools = [
      // File system tools (read-only)
      'list_directory',
      'read_file',
      'glob',
      'search_file_content',
      // Specific read-only git commands (not blanket 'git' to avoid git commit, push, etc.)
      'run_shell_command(git diff)',
      'run_shell_command(git log)',
      'run_shell_command(git show)',
      'run_shell_command(git status)',
      'run_shell_command(git branch)',
      'run_shell_command(git rev-parse)',
      // Read-only shell commands
      'run_shell_command(ls)',           // Directory listing
      'run_shell_command(cat)',          // File content viewing
      'run_shell_command(pwd)',          // Current directory
      'run_shell_command(head)',         // File head viewing
      'run_shell_command(tail)',         // File tail viewing
      'run_shell_command(wc)',           // Word/line count
      'run_shell_command(find)',         // File finding
      'run_shell_command(grep)',         // Pattern searching
      'run_shell_command(rg)',           // Ripgrep (fast pattern searching)
      // git-diff-lines is added to PATH via BIN_DIR so bare command works
      'run_shell_command(git-diff-lines)', // Custom annotated diff tool
    ].join(',');
    if (this.useShell) {
      // In shell mode, build full command string with args
      this.command = `${geminiCmd} -m ${model} -o json --allowed-tools "${readOnlyTools}"`;
      this.args = [];
    } else {
      this.command = geminiCmd;
      this.args = ['-m', model, '-o', 'json', '--allowed-tools', readOnlyTools];
    }
  }

  /**
   * Execute Gemini CLI with a prompt
   * @param {string} prompt - The prompt to send to Gemini
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', analysisId, registerProcess } = options;

      const levelPrefix = `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing Gemini CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} bytes`);

      const gemini = spawn(this.command, this.args, {
        cwd,
        env: {
          ...process.env,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: this.useShell
      });

      const pid = gemini.pid;
      logger.info(`${levelPrefix} Spawned Gemini CLI process: PID ${pid}`);

      // Register process for cancellation tracking if analysisId provided
      if (analysisId && registerProcess) {
        registerProcess(analysisId, gemini);
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
          gemini.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Gemini CLI timed out after ${timeout}ms`));
        }, timeout);
      }

      // Collect stdout
      gemini.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      // Collect stderr
      gemini.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      gemini.on('close', (code) => {
        if (settled) return;  // Already settled by timeout or error

        // Check for cancellation signals (SIGTERM=143, SIGKILL=137)
        const isCancellationCode = code === 143 || code === 137;
        if (isCancellationCode && analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} Gemini CLI terminated due to analysis cancellation (exit code ${code})`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

        // Always log stderr if present
        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} Gemini CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.warn(`${levelPrefix} Gemini CLI stderr (success): ${stderr}`);
          }
        }

        if (code !== 0) {
          logger.error(`${levelPrefix} Gemini CLI exited with code ${code}`);
          settle(reject, new Error(`${levelPrefix} Gemini CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Parse the Gemini JSON response
        // Gemini CLI with -o json returns: { session_id, response, stats }
        const parsed = this.parseGeminiResponse(stdout, level);
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
      gemini.on('error', (error) => {
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Gemini CLI not found. Please ensure Gemini CLI is installed.`);
          settle(reject, new Error(`${levelPrefix} Gemini CLI not found. ${GeminiProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Gemini process error: ${error}`);
          settle(reject, error);
        }
      });

      // Send the prompt to stdin
      gemini.stdin.write(prompt, (err) => {
        if (err) {
          logger.error(`${levelPrefix} Failed to write prompt to stdin: ${err}`);
          gemini.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Failed to write prompt to stdin: ${err}`));
        }
      });
      gemini.stdin.end();
    });
  }

  /**
   * Parse Gemini CLI JSON response
   * Gemini returns { session_id, response, stats } where response contains the actual content
   * @param {string} stdout - Raw stdout from Gemini CLI
   * @param {string|number} level - Analysis level for logging
   * @returns {{success: boolean, data?: Object, error?: string}}
   */
  parseGeminiResponse(stdout, level) {
    const levelPrefix = `[Level ${level}]`;

    try {
      // First, try to parse the Gemini wrapper JSON
      const geminiWrapper = JSON.parse(stdout);

      if (geminiWrapper.response) {
        // The response field contains the actual AI response
        // Try to extract JSON from it (the AI was asked to output JSON)
        const extracted = extractJSON(geminiWrapper.response, level);
        if (extracted.success) {
          return extracted;
        }

        // If the response itself is already the data we need, return it
        logger.warn(`${levelPrefix} Gemini response is not JSON, treating as raw text`);
        return { success: false, error: 'Response is not valid JSON' };
      }

      // Maybe the stdout is directly the content we need
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
   * Test if Gemini CLI is available
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    return new Promise((resolve) => {
      // For availability test, we just need to check --version
      // Use shell mode if the command contains spaces
      const geminiCmd = process.env.PAIR_REVIEW_GEMINI_CMD || 'gemini';
      const useShell = geminiCmd.includes(' ');
      const command = useShell ? `${geminiCmd} --version` : geminiCmd;
      const args = useShell ? [] : ['--version'];

      const gemini = spawn(command, args, {
        env: {
          ...process.env,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: useShell
      });

      let stdout = '';
      let settled = false;

      gemini.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      gemini.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (code === 0 && stdout.includes('.')) {
          logger.info(`Gemini CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          logger.warn('Gemini CLI not available or returned unexpected output');
          resolve(false);
        }
      });

      gemini.on('error', (error) => {
        if (settled) return;
        settled = true;
        logger.warn(`Gemini CLI not available: ${error.message}`);
        resolve(false);
      });
    });
  }

  static getProviderName() {
    return 'Gemini';
  }

  static getProviderId() {
    return 'gemini';
  }

  static getModels() {
    return GEMINI_MODELS;
  }

  static getDefaultModel() {
    return 'gemini-2.5-pro';
  }

  static getInstallInstructions() {
    return 'Install Gemini CLI: npm install -g @google/gemini-cli\n' +
           'Or visit: https://github.com/google-gemini/gemini-cli';
  }
}

// Register this provider
registerProvider('gemini', GeminiProvider);

module.exports = GeminiProvider;
