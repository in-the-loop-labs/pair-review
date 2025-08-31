const { spawn } = require('child_process');
const path = require('path');

class ClaudeCLI {
  constructor() {
    this.command = 'claude';
    this.args = ['-p']; // Print mode for non-interactive output
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
      
      console.log('[AI] Executing Claude CLI...');
      
      const claude = spawn(this.command, this.args, {
        cwd,
        env: { ...process.env },
        shell: false
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
          console.error('[AI] Claude CLI error:', stderr);
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Try to parse as JSON first
        try {
          const jsonMatch = stdout.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            console.log('[AI] Successfully parsed JSON response');
            resolve(parsed);
          } else {
            // Return raw text if no JSON found
            console.log('[AI] Returning raw text response');
            resolve({ raw: stdout, parsed: false });
          }
        } catch (error) {
          console.warn('[AI] Failed to parse JSON, returning raw text:', error.message);
          resolve({ raw: stdout, parsed: false });
        }
      });

      // Handle errors
      claude.on('error', (error) => {
        if (timeoutId) clearTimeout(timeoutId);
        
        if (error.code === 'ENOENT') {
          console.error('[AI] Claude CLI not found. Please ensure Claude CLI is installed.');
          reject(new Error('Claude CLI not found. Please install it and ensure it\'s in your PATH.'));
        } else {
          console.error('[AI] Claude process error:', error);
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
      console.error('[AI] Claude CLI not available:', error.message);
      return false;
    }
  }
}

module.exports = ClaudeCLI;