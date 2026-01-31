// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Logger utility for AI analysis
 * Provides formatted console output that stands out
 */

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Foreground colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  
  // Background colors
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgRed: '\x1b[41m'
};

class AILogger {
  constructor() {
    this.enabled = true;
    this.debugEnabled = false;
    this.streamDebugEnabled = false;
    this._stdout = process.stdout;
  }

  /**
   * Redirect all non-error output to a different stream.
   * Used in MCP stdio mode to keep stdout reserved for the JSON-RPC protocol.
   * @param {NodeJS.WritableStream} stream - Target stream (e.g. process.stderr)
   */
  setOutputStream(stream) {
    this._stdout = stream;
  }

  /**
   * Enable or disable debug logging
   * @param {boolean} enabled - Whether debug logging should be enabled
   */
  setDebugEnabled(enabled) {
    this.debugEnabled = enabled;
  }

  /**
   * Check if debug logging is enabled
   * @returns {boolean} Whether debug logging is enabled
   */
  isDebugEnabled() {
    return this.debugEnabled;
  }

  /**
   * Enable or disable stream debug logging (--debug-stream flag)
   * @param {boolean} enabled - Whether stream debug logging should be enabled
   */
  setStreamDebugEnabled(enabled) {
    this.streamDebugEnabled = enabled;
  }

  /**
   * Check if stream debug logging is enabled
   * @returns {boolean} Whether stream debug logging is enabled
   */
  isStreamDebugEnabled() {
    return this.streamDebugEnabled;
  }

  /**
   * Log debug message (only shown when debug is enabled)
   */
  debug(message) {
    if (!this.enabled || !this.debugEnabled) return;
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    this._stdout.write(
      `${COLORS.cyan}[${timestamp}]${COLORS.reset} ` +
      `${COLORS.dim}[AI DBG]${COLORS.reset} ` +
      `${COLORS.dim}${message}${COLORS.reset}\n`
    );
  }

  /**
   * Log stream debug message (only shown when --debug-stream is enabled)
   * Used for streaming events from AI providers (tool calls, text chunks, etc.)
   */
  streamDebug(message) {
    if (!this.enabled || !this.streamDebugEnabled) return;
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    this._stdout.write(
      `${COLORS.cyan}[${timestamp}]${COLORS.reset} ` +
      `${COLORS.dim}[STREAM]${COLORS.reset} ` +
      `${COLORS.dim}${message}${COLORS.reset}\n`
    );
  }

  /**
   * Log AI analysis info
   */
  info(message) {
    if (!this.enabled) return;
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    this._stdout.write(
      `${COLORS.cyan}[${timestamp}]${COLORS.reset} ` +
      `${COLORS.bright}${COLORS.blue}[AI]${COLORS.reset} ` +
      `${message}\n`
    );
  }

  /**
   * Log AI analysis success
   */
  success(message) {
    if (!this.enabled) return;
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    this._stdout.write(
      `${COLORS.cyan}[${timestamp}]${COLORS.reset} ` +
      `${COLORS.bright}${COLORS.green}[AI ✓]${COLORS.reset} ` +
      `${COLORS.green}${message}${COLORS.reset}\n`
    );
  }

  /**
   * Log AI analysis error
   */
  error(message) {
    if (!this.enabled) return;
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    process.stderr.write(
      `${COLORS.cyan}[${timestamp}]${COLORS.reset} ` +
      `${COLORS.bright}${COLORS.red}[AI ✗]${COLORS.reset} ` +
      `${COLORS.red}${message}${COLORS.reset}\n`
    );
  }

  /**
   * Log AI analysis warning
   */
  warn(message) {
    if (!this.enabled) return;
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    this._stdout.write(
      `${COLORS.cyan}[${timestamp}]${COLORS.reset} ` +
      `${COLORS.bright}${COLORS.yellow}[AI ⚠]${COLORS.reset} ` +
      `${COLORS.yellow}${message}${COLORS.reset}\n`
    );
  }

  /**
   * Log with custom prefix
   */
  log(prefix, message, color = 'blue') {
    if (!this.enabled) return;
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const prefixColor = COLORS[color] || COLORS.blue;
    this._stdout.write(
      `${COLORS.cyan}[${timestamp}]${COLORS.reset} ` +
      `${COLORS.bright}${prefixColor}[${prefix}]${COLORS.reset} ` +
      `${message}\n`
    );
  }

  /**
   * Start a progress section
   */
  section(title) {
    if (!this.enabled) return;
    this._stdout.write(
      `\n${COLORS.bright}${COLORS.cyan}${'─'.repeat(60)}${COLORS.reset}\n` +
      `${COLORS.bright}${COLORS.cyan}▶ ${title}${COLORS.reset}\n` +
      `${COLORS.cyan}${'─'.repeat(60)}${COLORS.reset}\n`
    );
  }
}

module.exports = new AILogger();