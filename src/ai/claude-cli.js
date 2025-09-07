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

        // Try multiple strategies to extract JSON from response
        const extracted = this.extractJSON(stdout);
        if (extracted.success) {
          logger.success('Successfully parsed JSON response');
          resolve(extracted.data);
        } else {
          logger.warn(`Failed to extract JSON: ${extracted.error}`);
          logger.info(`Raw response length: ${stdout.length} characters`);
          logger.info(`Raw response preview: ${stdout.substring(0, 500)}...`);
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
   * Extract JSON from Claude's response using multiple strategies
   * @param {string} response - Raw response from Claude
   * @returns {Object} Extraction result with success flag and data/error
   */
  extractJSON(response) {
    if (!response || !response.trim()) {
      return { success: false, error: 'Empty response' };
    }

    const strategies = [
      // Strategy 1: Look for markdown code blocks with 'json' label
      () => {
        const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch && codeBlockMatch[1]) {
          return JSON.parse(codeBlockMatch[1].trim());
        }
        throw new Error('No JSON code block found');
      },
      
      // Strategy 2: Look for JSON between first { and last }
      () => {
        const firstBrace = response.indexOf('{');
        const lastBrace = response.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
          return JSON.parse(response.substring(firstBrace, lastBrace + 1));
        }
        throw new Error('No valid JSON braces found');
      },
      
      // Strategy 3: Try to find JSON-like structure with bracket matching
      () => {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          // Try to find the complete JSON by matching brackets
          const jsonStr = jsonMatch[0];
          let braceCount = 0;
          let endIndex = -1;
          
          for (let i = 0; i < jsonStr.length; i++) {
            if (jsonStr[i] === '{') braceCount++;
            else if (jsonStr[i] === '}') {
              braceCount--;
              if (braceCount === 0) {
                endIndex = i;
                break;
              }
            }
          }
          
          if (endIndex > -1) {
            return JSON.parse(jsonStr.substring(0, endIndex + 1));
          }
        }
        throw new Error('No balanced JSON structure found');
      },
      
      // Strategy 4: Try the entire response as JSON (for simple cases)
      () => {
        return JSON.parse(response.trim());
      }
    ];

    for (let i = 0; i < strategies.length; i++) {
      try {
        const data = strategies[i]();
        if (data && typeof data === 'object') {
          logger.info(`JSON extraction successful using strategy ${i + 1}`);
          return { success: true, data };
        }
      } catch (error) {
        logger.info(`Strategy ${i + 1} failed: ${error.message}`);
        continue;
      }
    }

    return { 
      success: false, 
      error: 'All JSON extraction strategies failed'
    };
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