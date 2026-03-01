// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Claude Code Bridge
 *
 * Manages a long-lived Claude Code CLI process in stream-json mode for
 * interactive chat sessions. Communicates over stdin/stdout using NDJSON:
 * - Sends JSON user messages on stdin
 * - Receives NDJSON events (system, assistant, stream_event, result, etc.) on stdout
 *
 * Mirrors the PiBridge / AcpBridge EventEmitter interface so all bridges
 * can be used interchangeably.
 *
 * Emits high-level events: delta, complete, error, tool_use, status, ready, close, session.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { createInterface } = require('readline');
const crypto = require('crypto');
const logger = require('../utils/logger');

const CLAUDE_CHAT_TOOLS = 'Read,Bash,Grep,Glob,Edit,Write,Agent';

// Default dependencies (overridable for testing)
const defaults = {
  spawn,
  createInterface,
};

class ClaudeCodeBridge extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} [options.model] - Model ID (e.g., 'claude-sonnet-4-6')
   * @param {string} [options.cwd] - Working directory for Claude process
   * @param {string} [options.systemPrompt] - System prompt text (prepended to first message)
   * @param {string} [options.claudeCommand] - Override binary (default: env PAIR_REVIEW_CLAUDE_CMD or 'claude')
   * @param {Object} [options.env] - Extra env vars for subprocess
   * @param {string} [options.resumeSessionId] - Session ID for resumption
   * @param {Object} [options._deps] - { spawn, createInterface } for testing
   */
  constructor(options = {}) {
    super();
    this.model = options.model || null;
    this.cwd = options.cwd || process.cwd();
    this.systemPrompt = options.systemPrompt || null;
    this.claudeCommand = options.claudeCommand || process.env.PAIR_REVIEW_CLAUDE_CMD || 'claude';
    this.env = options.env || {};
    this.resumeSessionId = options.resumeSessionId || null;

    this._deps = { ...defaults, ...options._deps };
    this._process = null;
    this._readline = null;
    this._sessionId = null;
    this._ready = false;
    this._closing = false;
    this._accumulatedText = '';
    this._inMessage = false;
    this._firstMessage = !options.resumeSessionId;
    this._activeTools = new Map();
  }

  /**
   * Spawn the Claude CLI subprocess in stream-json mode.
   *
   * With --input-format stream-json, the CLI does NOT emit system/init until
   * the first user message is sent on stdin. So start() spawns the process,
   * wires up I/O, and marks the bridge as ready immediately. The session ID
   * is captured later when system/init arrives with the first response.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this._process) {
      throw new Error('ClaudeCodeBridge already started');
    }

    const deps = this._deps;
    const command = this.claudeCommand;
    const args = this._buildArgs();

    logger.info(`[ClaudeCodeBridge] Starting: ${command} ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      // Remove CLAUDECODE env var to avoid "nested session" error
      const env = { ...process.env, ...this.env };
      delete env.CLAUDECODE;

      const proc = deps.spawn(command, args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      this._process = proc;
      let spawned = false;

      // Handle spawn error (e.g., ENOENT)
      proc.on('error', (err) => {
        if (!spawned) {
          reject(new Error(`Failed to start Claude CLI: ${err.message}`));
        } else {
          logger.error(`[ClaudeCodeBridge] Process error: ${err.message}`);
          this.emit('error', { error: err });
        }
      });

      // Handle process exit
      proc.on('close', (code, signal) => {
        this._ready = false;
        this._process = null;

        if (!this._closing) {
          logger.warn(`[ClaudeCodeBridge] Process exited unexpectedly (code=${code}, signal=${signal})`);
          this.emit('error', { error: new Error(`Claude CLI exited (code=${code}, signal=${signal})`) });
        } else {
          logger.info(`[ClaudeCodeBridge] Process exited (code=${code}, signal=${signal})`);
        }

        this.emit('close');
      });

      // Collect stderr for diagnostics
      proc.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) {
          logger.debug(`[ClaudeCodeBridge] stderr: ${text}`);
        }
      });

      // Handle stdin errors (e.g., EPIPE if process dies)
      proc.stdin.on('error', (err) => {
        logger.error(`[ClaudeCodeBridge] stdin error: ${err.message}`);
      });

      // Set up line-by-line parsing of stdout for NDJSON
      this._readline = deps.createInterface({
        input: proc.stdout,
        crlfDelay: Infinity,
      });

      this._readline.on('line', (line) => {
        if (!line.trim()) return;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          logger.debug(`[ClaudeCodeBridge] Ignoring unparseable line: ${line.substring(0, 100)}`);
          return;
        }

        this._handleMessage(msg);
      });

      // The CLI with --input-format stream-json doesn't emit anything until
      // the first user message is sent. Mark ready immediately after spawn
      // succeeds — the session ID will arrive with system/init on first response.
      spawned = true;
      this._ready = true;
      logger.info(`[ClaudeCodeBridge] Spawned (PID ${proc.pid}), ready for messages`);
      this.emit('ready');
      resolve();
    });
  }

  /**
   * Send a user message to the Claude CLI process.
   * @param {string} content - The message text
   */
  async sendMessage(content) {
    if (!this.isReady()) {
      throw new Error('ClaudeCodeBridge is not ready');
    }
    if (this.isBusy()) {
      throw new Error('ClaudeCodeBridge is busy');
    }

    this._accumulatedText = '';
    this._inMessage = true;

    let messageContent = content;
    if (this.systemPrompt && this._firstMessage) {
      messageContent = this.systemPrompt + '\n\n' + content;
      this._firstMessage = false;
    }

    logger.debug(`[ClaudeCodeBridge] Sending prompt (${messageContent.length} chars): ${messageContent.substring(0, 100)}${messageContent.length > 100 ? '...' : ''}`);

    this._write({
      type: 'user',
      message: { role: 'user', content: messageContent },
      session_id: this._sessionId || '',
      parent_tool_use_id: null,
    });
  }

  /**
   * Abort the current operation by sending an interrupt control request.
   */
  abort() {
    if (!this.isReady() || !this._sessionId) return;

    logger.debug('[ClaudeCodeBridge] Sending interrupt');
    this._write({
      type: 'control_request',
      request: { subtype: 'interrupt' },
      request_id: crypto.randomUUID(),
    });
  }

  /**
   * Gracefully shut down the Claude CLI process.
   * @returns {Promise<void>}
   */
  async close() {
    if (!this._process) return;

    this._closing = true;
    this._activeTools.clear();
    this.removeAllListeners();

    // Close readline if it exists
    if (this._readline) {
      this._readline.close();
      this._readline = null;
    }

    return new Promise((resolve) => {
      const proc = this._process;
      if (!proc) {
        resolve();
        return;
      }

      // Give the process a moment to exit gracefully, then force kill
      const killTimeout = setTimeout(() => {
        if (this._process) {
          logger.warn('[ClaudeCodeBridge] Force killing process');
          this._process.kill('SIGKILL');
        }
      }, 3000);

      const onClose = () => {
        clearTimeout(killTimeout);
        resolve();
      };

      proc.once('close', onClose);

      // Close stdin then send SIGTERM
      try {
        proc.stdin.end();
      } catch {
        // stdin may already be closed
      }
      proc.kill('SIGTERM');
    });
  }

  /**
   * Check if the CLI process is alive and ready.
   * @returns {boolean}
   */
  isReady() {
    return this._ready && this._process !== null && !this._closing;
  }

  /**
   * Check if the bridge is currently processing a message.
   * @returns {boolean}
   */
  isBusy() {
    return this._inMessage;
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Build CLI arguments for the Claude process.
   * @returns {string[]}
   */
  _buildArgs() {
    const args = [
      '-p', '',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--allowedTools', CLAUDE_CHAT_TOOLS,
      '--settings', '{"disableAllHooks":true}',
    ];

    if (this.resumeSessionId) {
      args.unshift('--resume', this.resumeSessionId);
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    return args;
  }

  /**
   * Write a JSON object as NDJSON to the process stdin.
   * @param {Object} obj - The object to serialize and write
   */
  _write(obj) {
    if (!this._process || !this._process.stdin.writable) {
      throw new Error('Claude CLI process stdin is not writable');
    }
    this._process.stdin.write(JSON.stringify(obj) + '\n');
  }

  /**
   * Route an incoming NDJSON message to the appropriate handler.
   * @param {Object} msg - Parsed JSON message from Claude CLI stdout
   */
  _handleMessage(msg) {
    const type = msg.type;
    const subtype = msg.subtype;

    switch (type) {
      case 'system':
        this._handleSystemMessage(msg, subtype);
        break;

      case 'assistant':
        this.emit('status', { status: 'working' });
        break;

      case 'stream_event':
        this._handleStreamEvent(msg);
        break;

      case 'user':
        // tool_result content blocks signal tool execution completed
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const toolName = this._activeTools.get(block.tool_use_id) || null;
              this._activeTools.delete(block.tool_use_id);
              this.emit('tool_use', {
                toolCallId: block.tool_use_id,
                toolName,
                status: 'end',
              });
            }
          }
        }
        break;

      case 'tool_progress':
        this.emit('tool_use', {
          toolCallId: msg.tool_use_id,
          toolName: msg.tool_name,
          status: 'update',
        });
        break;

      case 'result':
        this._handleResult(msg, subtype);
        break;

      case 'keep_alive':
        // Ignore keep-alive pings
        break;

      default:
        logger.debug(`[ClaudeCodeBridge] Unhandled message type: ${type}`);
    }
  }

  /**
   * Handle system messages (init, status, etc.).
   * @param {Object} msg - The system message
   * @param {string} subtype - The system message subtype
   */
  _handleSystemMessage(msg, subtype) {
    switch (subtype) {
      case 'init':
        // The CLI emits system/init at the start of every response turn.
        // Only capture and emit on the first one.
        if (!this._sessionId) {
          this._sessionId = msg.session_id || null;
          logger.info(`[ClaudeCodeBridge] Session initialized (session ${this._sessionId})`);
          this.emit('session', { sessionId: this._sessionId });
        }
        break;

      case 'status':
        this.emit('status', { status: 'working' });
        break;

      default:
        logger.debug(`[ClaudeCodeBridge] Unhandled system subtype: ${subtype}`);
    }
  }

  /**
   * Handle stream_event messages (content deltas, tool use starts, etc.).
   * @param {Object} msg - The stream_event message
   */
  _handleStreamEvent(msg) {
    const event = msg.event;
    if (!event) return;

    switch (event.type) {
      case 'content_block_delta':
        if (event.delta && event.delta.type === 'text_delta') {
          const text = event.delta.text || '';
          if (text) {
            this._accumulatedText += text;
            this.emit('delta', { text });
          }
        }
        break;

      case 'content_block_start':
        if (event.content_block && event.content_block.type === 'tool_use') {
          const { id, name } = event.content_block;
          this._activeTools.set(id, name);
          this.emit('tool_use', {
            toolCallId: id,
            toolName: name,
            status: 'start',
          });
        }
        break;

      default:
        logger.debug(`[ClaudeCodeBridge] Unhandled stream_event type: ${event.type}`);
    }
  }

  /**
   * Handle result messages (success or error).
   * @param {Object} msg - The result message
   * @param {string} subtype - The result subtype
   */
  _handleResult(msg, subtype) {
    this._inMessage = false;
    const fullText = this._accumulatedText;
    this._accumulatedText = '';
    this._activeTools.clear();

    if (subtype && subtype !== 'success') {
      const errorMessage = (Array.isArray(msg.errors) && msg.errors.length)
        ? msg.errors.join('\n')
        : subtype;
      logger.error(`[ClaudeCodeBridge] Result error: ${errorMessage}`);
      this.emit('error', { error: new Error(errorMessage) });
    } else {
      this.emit('complete', { fullText });
    }
  }
}

module.exports = ClaudeCodeBridge;
