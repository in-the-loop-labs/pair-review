const { spawn } = require('child_process');
const path = require('path');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');

class ClaudeCLI {
  constructor() {
    // Check for environment variable to override default command
    // Use PAIR_REVIEW_CLAUDE_CMD environment variable if set, otherwise default to 'claude'
    const claudeCmd = process.env.PAIR_REVIEW_CLAUDE_CMD || 'claude';
    
    // For multi-word commands like "devx claude", we need to use shell mode
    this.useShell = claudeCmd.includes(' ');
    
    if (this.useShell) {
      // Use the full command string with -p and --output-format json appended
      this.command = `${claudeCmd} -p --output-format json`;
      this.args = [];
    } else {
      // Single command, use normal spawn mode
      this.command = claudeCmd;
      this.args = ['-p', '--output-format', 'json'];
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
      const { cwd = process.cwd(), timeout = 300000 } = options; // 5 minute default timeout
      
      logger.info('Executing Claude CLI...');
      
      const claude = spawn(this.command, this.args, {
        cwd,
        env: { 
          ...process.env,
          PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin'
        },
        shell: this.useShell
      });

      let stdout = '';
      let stderr = '';
      let timeoutId = null;

      // Set timeout
      if (timeout) {
        timeoutId = setTimeout(() => {
          claude.kill('SIGTERM');
          reject(new Error(`Claude CLI timed out after ${timeout}ms`));
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
        
        if (code !== 0) {
          logger.error(`Claude CLI error: ${stderr}`);
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Try to parse the outer JSON envelope first
        try {
          const envelope = JSON.parse(stdout);
          if (envelope.result !== undefined) {
            // Extract JSON from the result field (may still have markdown)
            const extracted = extractJSON(envelope.result);
            if (extracted.success) {
              logger.success('Successfully parsed JSON response');
              resolve(extracted.data);
            } else {
              logger.warn(`Failed to extract JSON from result field: ${extracted.error}`);
              logger.info(`Raw result length: ${envelope.result.length} characters`);
              logger.info(`Raw result preview: ${envelope.result.substring(0, 500)}...`);
              resolve({ raw: envelope.result, parsed: false });
            }
          } else if (envelope.error) {
            // Handle error response
            logger.error(`Claude API error: ${envelope.error}`);
            reject(new Error(`Claude API error: ${envelope.error}`));
          } else {
            // Unexpected envelope structure
            logger.warn('Unexpected JSON envelope structure');
            resolve({ raw: stdout, parsed: false });
          }
        } catch (e) {
          // Fallback to existing extraction for backwards compatibility
          logger.info('Falling back to direct JSON extraction (no envelope detected)');
          const extracted = extractJSON(stdout);
          if (extracted.success) {
            logger.success('Successfully parsed JSON response');
            resolve(extracted.data);
          } else {
            logger.warn(`Failed to extract JSON: ${extracted.error}`);
            logger.info(`Raw response length: ${stdout.length} characters`);
            logger.info(`Raw response preview: ${stdout.substring(0, 500)}...`);
            resolve({ raw: stdout, parsed: false });
          }
        }
      });

      // Handle errors
      claude.on('error', (error) => {
        if (timeoutId) clearTimeout(timeoutId);
        
        if (error.code === 'ENOENT') {
          logger.error('Claude CLI not found. Please ensure Claude CLI is installed.');
          reject(new Error('Claude CLI not found. Please install it and ensure it\'s in your PATH.'));
        } else {
          logger.error(`Claude process error: ${error}`);
          reject(error);
        }
      });

      // Send the prompt to stdin
      claude.stdin.write(prompt);
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