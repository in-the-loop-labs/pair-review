// SPDX-License-Identifier: GPL-3.0-or-later
const { spawn } = require('child_process');
const path = require('path');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');

class ClaudeCLI {
  constructor(model = 'opus') {
    // Check for environment variable to override default command
    // Use PAIR_REVIEW_CLAUDE_CMD environment variable if set, otherwise default to 'claude'
    const claudeCmd = process.env.PAIR_REVIEW_CLAUDE_CMD || 'claude';

    // Store model for use in commands
    this.model = model;

    // For multi-word commands like "devx claude", we need to use shell mode
    this.useShell = claudeCmd.includes(' ');

    if (this.useShell) {
      // Use the full command string with -p and --model appended
      // Disable hooks to prevent project hooks from running during SDK mode invocation
      this.command = `${claudeCmd} -p --model ${model} --settings '{"disableAllHooks":true}'`;
      this.args = [];
    } else {
      // Single command, use normal spawn mode
      // Disable hooks to prevent project hooks from running during SDK mode invocation
      this.command = claudeCmd;
      this.args = ['-p', '--model', model, '--settings', '{"disableAllHooks":true}'];
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
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', logPrefix } = options; // 5 minute default timeout

      const levelPrefix = logPrefix || `[Level ${level}]`;
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

        // Always log stderr if present (helps debug issues even on successful exit)
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

        // Extract JSON from the text response using robust extraction strategies
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
          reject(new Error(`${levelPrefix} Claude CLI not found. Please install it and ensure it's in your PATH.`));
        } else {
          logger.error(`${levelPrefix} Claude process error: ${error}`);
          reject(error);
        }
      });

      // Handle stdin errors (e.g., EPIPE if process exits before write completes)
      claude.stdin.on('error', (err) => {
        logger.error(`${levelPrefix} stdin error: ${err.message}`);
      });

      // Send the prompt to stdin with backpressure handling
      claude.stdin.write(prompt, (err) => {
        if (err) {
          logger.error(`${levelPrefix} Failed to write prompt to stdin: ${err}`);
          if (timeoutId) clearTimeout(timeoutId);
          claude.kill('SIGTERM'); // Prevent resource leak
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
}

module.exports = ClaudeCLI;