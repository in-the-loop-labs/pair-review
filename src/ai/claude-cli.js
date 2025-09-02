const { spawn } = require('child_process');
const path = require('path');
const logger = require('../utils/logger');

class ClaudeCLI {
  constructor() {
    // Check for environment variable to override default command
    // Use PAIR_REVIEW_CLAUDE_CMD environment variable if set, otherwise default to 'claude'
    const claudeCmd = process.env.PAIR_REVIEW_CLAUDE_CMD || 'claude';
    
    // For multi-word commands like "devx claude", we need to use shell mode
    this.useShell = claudeCmd.includes(' ');
    
    if (this.useShell) {
      // Use the full command string with -p appended
      this.command = `${claudeCmd} -p`;
      this.args = [];
    } else {
      // Single command, use normal spawn mode
      this.command = claudeCmd;
      this.args = ['-p'];
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

        // Try to parse as JSON first
        try {
          const jsonMatch = stdout.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            logger.success('Successfully parsed JSON response');
            resolve(parsed);
          } else {
            // Return raw text if no JSON found
            logger.info('Returning raw text response');
            resolve({ raw: stdout, parsed: false });
          }
        } catch (error) {
          logger.warn(`Failed to parse JSON, returning raw text: ${error.message}`);
          resolve({ raw: stdout, parsed: false });
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