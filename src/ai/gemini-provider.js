/**
 * Gemini AI Provider
 *
 * Implements the AI provider interface for Google's Gemini CLI.
 */

const { spawn } = require('child_process');
const { AIProvider, registerProvider } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');

/**
 * Gemini model definitions with tier mappings
 */
const GEMINI_MODELS = [
  {
    id: 'gemini-2.5-flash',
    name: '2.5 Flash',
    tier: 'fast',
    tagline: 'Lightning Fast',
    description: 'Quick analysis for simple changes',
    badge: 'Fastest',
    badgeClass: 'badge-speed'
  },
  {
    id: 'gemini-2.5-pro',
    name: '2.5 Pro',
    tier: 'balanced',
    tagline: 'Best Balance',
    description: 'Recommended for most reviews',
    badge: 'Recommended',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'gemini-2.5-pro',
    name: '2.5 Pro',
    tier: 'thorough',
    tagline: 'Most Capable',
    description: 'Deep analysis for complex code',
    badge: 'Most Thorough',
    badgeClass: 'badge-power',
    // Note: Using same model as balanced since Gemini doesn't have a clear 3-tier structure
    // The thorough tier could use extended thinking or different parameters in the future
    sameAsBalanced: true
  }
];

class GeminiProvider extends AIProvider {
  constructor(model = 'gemini-2.5-pro') {
    super(model);

    // Check for environment variable to override default command
    this.geminiCmd = process.env.PAIR_REVIEW_GEMINI_CMD || 'gemini';
  }

  /**
   * Execute Gemini CLI with a prompt
   * @param {string} prompt - The prompt to send to Gemini
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown' } = options;

      const levelPrefix = `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing Gemini CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} bytes`);

      // Gemini CLI args:
      // -m <model> : specify model
      // -o json    : output format as JSON
      // -y         : auto-accept actions (YOLO mode) for non-interactive use
      // The prompt is passed via stdin
      const args = [
        '-m', this.model,
        '-o', 'json',
        '-y'  // Auto-accept for non-interactive use
      ];

      const gemini = spawn(this.geminiCmd, args, {
        cwd,
        env: {
          ...process.env,
          PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin'
        }
      });

      const pid = gemini.pid;
      logger.info(`${levelPrefix} Spawned Gemini CLI process: PID ${pid}`);

      let stdout = '';
      let stderr = '';
      let timeoutId = null;

      // Set timeout
      if (timeout) {
        timeoutId = setTimeout(() => {
          logger.error(`${levelPrefix} Process ${pid} timed out after ${timeout}ms`);
          gemini.kill('SIGTERM');
          reject(new Error(`${levelPrefix} Gemini CLI timed out after ${timeout}ms`));
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
        if (timeoutId) clearTimeout(timeoutId);

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
          reject(new Error(`${levelPrefix} Gemini CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Parse the Gemini JSON response
        // Gemini CLI with -o json returns: { session_id, response, stats }
        const parsed = this.parseGeminiResponse(stdout, level);
        if (parsed.success) {
          logger.success(`${levelPrefix} Successfully parsed JSON response`);
          resolve(parsed.data);
        } else {
          logger.warn(`${levelPrefix} Failed to extract JSON: ${parsed.error}`);
          logger.info(`${levelPrefix} Raw response length: ${stdout.length} characters`);
          logger.info(`${levelPrefix} Raw response preview: ${stdout.substring(0, 500)}...`);
          resolve({ raw: stdout, parsed: false });
        }
      });

      // Handle errors
      gemini.on('error', (error) => {
        if (timeoutId) clearTimeout(timeoutId);

        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Gemini CLI not found. Please ensure Gemini CLI is installed.`);
          reject(new Error(`${levelPrefix} Gemini CLI not found. ${GeminiProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Gemini process error: ${error}`);
          reject(error);
        }
      });

      // Send the prompt to stdin
      gemini.stdin.write(prompt, (err) => {
        if (err) {
          logger.error(`${levelPrefix} Failed to write prompt to stdin: ${err}`);
          if (timeoutId) clearTimeout(timeoutId);
          gemini.kill('SIGTERM');
          reject(new Error(`${levelPrefix} Failed to write prompt to stdin: ${err}`));
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
      const gemini = spawn(this.geminiCmd, ['--version'], {
        env: {
          ...process.env,
          PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin'
        }
      });

      let stdout = '';

      gemini.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      gemini.on('close', (code) => {
        if (code === 0 && stdout.includes('.')) {
          logger.info(`Gemini CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          logger.warn('Gemini CLI not available or returned unexpected output');
          resolve(false);
        }
      });

      gemini.on('error', (error) => {
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
    return 'Install Gemini CLI: npm install -g @anthropic-ai/gemini-cli\n' +
           'Or visit: https://github.com/google-gemini/gemini-cli';
  }
}

// Register this provider
registerProvider('gemini', GeminiProvider);

module.exports = GeminiProvider;
