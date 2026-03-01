// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Codex App-Server Bridge
 *
 * Manages a long-lived Codex agent process using the "app-server" protocol
 * (bidirectional JSON-RPC 2.0 over JSONL/stdio) for interactive chat sessions.
 * Mirrors the PiBridge/AcpBridge EventEmitter interface so all three can be
 * used interchangeably.
 *
 * Emits high-level events: delta, complete, error, tool_use, status, ready, close, session.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { createInterface } = require('readline');
const logger = require('../utils/logger');
const { version: pkgVersion } = require('../../package.json');

// Default dependencies (overridable for testing)
const defaults = {
  spawn,
  createInterface,
};

class CodexBridge extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} [options.model] - Model ID
   * @param {string} [options.cwd] - Working directory for agent process
   * @param {string} [options.systemPrompt] - System prompt text
   * @param {string} [options.codexCommand] - Codex binary (default: 'codex')
   * @param {Object} [options.env] - Extra env vars for subprocess
   * @param {string} [options.resumeThreadId] - Thread ID to resume
   * @param {Object} [options._deps] - Dependency injection for testing
   */
  constructor(options = {}) {
    super();
    this.model = options.model || null;
    this.cwd = options.cwd || process.cwd();
    this.systemPrompt = options.systemPrompt || null;
    this.env = options.env || {};
    this.resumeThreadId = options.resumeThreadId || null;

    // Command resolution: env var → constructor option → config → default
    this.codexCommand = process.env.PAIR_REVIEW_CODEX_CMD
      || options.codexCommand
      || 'codex';
    this.codexArgs = ['app-server'];

    this._deps = { ...defaults, ...options._deps };
    this._process = null;
    this._threadId = null;
    this._turnId = null;
    this._ready = false;
    this._closing = false;
    this._accumulatedText = '';
    this._inMessage = false;
    this._firstMessage = !options.resumeThreadId;

    // JSON-RPC state
    this._nextId = 1;
    this._pendingRequests = new Map(); // id -> { resolve, reject }
  }

  /**
   * Spawn the codex app-server process, perform handshake, and create a thread.
   * Resolves once the thread is established and the bridge is ready.
   * @returns {Promise<void>}
   */
  async start() {
    if (this._process) {
      throw new Error('CodexBridge already started');
    }

    const deps = this._deps;
    const command = this.codexCommand;
    const args = this.codexArgs;

    logger.info(`[CodexBridge] Starting Codex agent: ${command} ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const proc = deps.spawn(command, args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.env },
      });

      this._process = proc;

      // Handle spawn error (e.g., ENOENT)
      proc.on('error', (err) => {
        if (!this._ready) {
          this._ready = false;
          reject(new Error(`Failed to start Codex agent: ${err.message}`));
        } else {
          logger.error(`[CodexBridge] Process error: ${err.message}`);
          this.emit('error', { error: err });
        }
      });

      // Handle process exit
      proc.on('close', (code, signal) => {
        const wasReady = this._ready;
        this._ready = false;
        this._process = null;

        // Reject all pending requests
        for (const [id, pending] of this._pendingRequests) {
          pending.reject(new Error(`Process exited while awaiting response for request ${id}`));
        }
        this._pendingRequests.clear();

        if (!wasReady && !this._closing) {
          reject(new Error(`Codex agent exited before ready (code=${code}, signal=${signal})`));
        }

        if (!this._closing) {
          logger.warn(`[CodexBridge] Process exited unexpectedly (code=${code}, signal=${signal})`);
          this.emit('error', { error: new Error(`Codex agent exited (code=${code}, signal=${signal})`) });
        } else {
          logger.info(`[CodexBridge] Process exited (code=${code}, signal=${signal})`);
        }

        this.emit('close');
      });

      // Collect stderr for diagnostics
      proc.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) {
          logger.debug(`[CodexBridge] stderr: ${text}`);
        }
      });

      // Handle stdin errors (e.g., EPIPE if process dies)
      proc.stdin.on('error', (err) => {
        logger.error(`[CodexBridge] stdin error: ${err.message}`);
      });

      // Set up JSONL readline on stdout
      const rl = deps.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => this._handleLine(line));

      // Perform handshake
      this._initializeThread()
        .then(() => {
          this._ready = true;
          logger.info(`[CodexBridge] Ready (PID ${proc.pid})`);
          this.emit('ready');
          resolve();
        })
        .catch((err) => {
          if (!this._closing) {
            reject(new Error(`Codex initialization failed: ${err.message}`));
          }
        });
    });
  }

  /**
   * Perform the JSON-RPC handshake and create or resume a thread.
   * @returns {Promise<void>}
   */
  async _initializeThread() {
    // 1. Send initialize request
    await this._sendRequest('initialize', {
      clientInfo: { name: 'pair-review', version: pkgVersion },
    });

    // 2. Send initialized notification
    this._sendNotification('initialized');

    // 3. Start or resume thread
    if (this.resumeThreadId) {
      const result = await this._sendRequest('thread/resume', {
        threadId: this.resumeThreadId,
      });
      this._threadId = result.threadId || this.resumeThreadId;
      logger.info(`[CodexBridge] Thread resumed: ${this._threadId}`);
    } else {
      const result = await this._sendRequest('thread/start', {});
      this._threadId = result.threadId;
      logger.info(`[CodexBridge] Thread created: ${this._threadId}`);
    }

    // Emit session info so session-manager can store the threadId
    this.emit('session', { threadId: this._threadId });
  }

  /**
   * Send a user message to the Codex agent.
   * Fire-and-forget: returns immediately, emits events as the agent responds.
   * @param {string} content - The message text
   */
  async sendMessage(content) {
    if (!this.isReady()) {
      throw new Error('CodexBridge is not ready');
    }

    // Reset accumulated text for this new turn
    this._accumulatedText = '';
    this._inMessage = true;

    let messageContent = content;
    if (this.systemPrompt && this._firstMessage) {
      messageContent = this.systemPrompt + '\n\n' + content;
      this._firstMessage = false;
    }

    logger.debug(`[CodexBridge] Sending message (${messageContent.length} chars): ${messageContent.substring(0, 100)}${messageContent.length > 100 ? '...' : ''}`);

    // Send turn/start — completion is driven by turn/completed notification,
    // not by this response. Store turnId for abort support.
    this._sendRequest('turn/start', {
      threadId: this._threadId,
      input: messageContent,
      approvalPolicy: 'auto-edit',
    })
      .then((result) => {
        if (result && result.turnId) {
          this._turnId = result.turnId;
        }
      })
      .catch((err) => {
        this._inMessage = false;
        logger.error(`[CodexBridge] turn/start error: ${err.message}`);
        this.emit('error', { error: err });
      });
  }

  /**
   * Abort the current turn.
   */
  abort() {
    if (!this.isReady() || !this._threadId || !this._turnId) return;
    logger.debug('[CodexBridge] Sending turn/interrupt');
    this._sendRequest('turn/interrupt', {
      threadId: this._threadId,
      turnId: this._turnId,
    }).catch((err) => {
      logger.error(`[CodexBridge] turn/interrupt error: ${err.message}`);
    });
  }

  /**
   * Gracefully shut down the Codex agent process.
   * @returns {Promise<void>}
   */
  async close() {
    if (!this._process) return;

    this._closing = true;

    // Reject all pending requests
    for (const [id, pending] of this._pendingRequests) {
      pending.reject(new Error(`Bridge closing, rejecting pending request ${id}`));
    }
    this._pendingRequests.clear();

    // Attempt to interrupt any active turn
    if (this._threadId && this._turnId) {
      try {
        this._sendNotification('turn/interrupt', {
          threadId: this._threadId,
          turnId: this._turnId,
        });
      } catch {
        /* process may already be dead */
      }
    }

    this.removeAllListeners();

    return new Promise((resolve) => {
      const proc = this._process;
      if (!proc) {
        resolve();
        return;
      }

      // Give the process a moment to exit gracefully, then force kill
      const killTimeout = setTimeout(() => {
        if (this._process) {
          logger.warn('[CodexBridge] Force killing process');
          this._process.kill('SIGKILL');
        }
      }, 3000);

      const onClose = () => {
        clearTimeout(killTimeout);
        resolve();
      };

      proc.once('close', onClose);

      // Send SIGTERM
      proc.kill('SIGTERM');
    });
  }

  /**
   * Check if the Codex agent process is alive and ready.
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
  // JSON-RPC 2.0 transport
  // ---------------------------------------------------------------------------

  /**
   * Send a JSON-RPC request (expects a response).
   * @param {string} method
   * @param {Object} [params]
   * @returns {Promise<Object>} The result from the response
   */
  _sendRequest(method, params) {
    const id = this._nextId++;
    const message = { jsonrpc: '2.0', method, id };
    if (params !== undefined) {
      message.params = params;
    }

    return new Promise((resolve, reject) => {
      this._pendingRequests.set(id, { resolve, reject });
      this._writeLine(message);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   * @param {string} method
   * @param {Object} [params]
   */
  _sendNotification(method, params) {
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) {
      message.params = params;
    }
    this._writeLine(message);
  }

  /**
   * Write a JSON line to the process stdin.
   * @param {Object} obj
   */
  _writeLine(obj) {
    if (!this._process || !this._process.stdin.writable) {
      logger.warn('[CodexBridge] Cannot write — stdin not writable');
      return;
    }
    const line = JSON.stringify(obj) + '\n';
    this._process.stdin.write(line);
  }

  /**
   * Handle a single JSONL line from stdout.
   * Dispatches to pending request handlers, notification handler, or server request handler.
   * @param {string} line
   */
  _handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      logger.debug(`[CodexBridge] Non-JSON line: ${trimmed.substring(0, 200)}`);
      return;
    }

    // Response to a pending request (has id, has result or error, no method)
    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      const pending = this._pendingRequests.get(msg.id);
      if (pending) {
        this._pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result || {});
        }
      } else {
        logger.debug(`[CodexBridge] Response for unknown request id=${msg.id}`);
      }
      return;
    }

    // Server request (has method AND id) — needs a response
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      this._handleServerRequest(msg);
      return;
    }

    // Server notification (has method, no id)
    if (msg.method) {
      this._handleNotification(msg);
      return;
    }

    logger.debug(`[CodexBridge] Unrecognized message: ${trimmed.substring(0, 200)}`);
  }

  // ---------------------------------------------------------------------------
  // Notification handling
  // ---------------------------------------------------------------------------

  /**
   * Handle a server notification (no id, has method).
   * @param {Object} msg - Parsed JSON-RPC notification
   */
  _handleNotification(msg) {
    const { method, params } = msg;

    switch (method) {
      case 'item/agentMessage/delta':
        this._handleDelta(params);
        break;

      case 'turn/completed':
        this._handleTurnCompleted(params);
        break;

      case 'turn/started':
        this.emit('status', { status: 'working' });
        break;

      case 'item/started':
        this._handleItemStarted(params);
        break;

      case 'item/completed':
        this._handleItemCompleted(params);
        break;

      default:
        logger.debug(`[CodexBridge] Unhandled notification: ${method}`);
    }
  }

  /**
   * Handle streaming text delta.
   * @param {Object} params
   */
  _handleDelta(params) {
    if (!params) return;
    const text = params.delta || params.text;
    if (text) {
      this._accumulatedText += text;
      this.emit('delta', { text });
    }
  }

  /**
   * Handle turn completion.
   * @param {Object} params
   */
  _handleTurnCompleted(params) {
    const status = params?.status;

    if (status === 'failed') {
      this._inMessage = false;
      this._turnId = null;
      const errorMsg = params.error?.message || params.reason || 'Turn failed';
      logger.error(`[CodexBridge] Turn failed: ${errorMsg}`);
      this.emit('error', { error: new Error(errorMsg) });
      return;
    }

    // status === 'completed' or any other terminal status
    const fullText = this._accumulatedText;
    this._accumulatedText = '';
    this._inMessage = false;
    this._turnId = null;
    logger.debug(`[CodexBridge] Turn completed, accumulated ${fullText.length} chars`);
    this.emit('complete', { fullText });
  }

  /**
   * Handle item/started — emit tool_use for command-type items.
   * @param {Object} params
   */
  _handleItemStarted(params) {
    if (!params) return;
    const type = params.type || params.itemType;
    if (type === 'command' || type === 'tool_call' || type === 'function_call') {
      this.emit('tool_use', {
        toolCallId: params.itemId || params.id,
        toolName: params.name || params.title || type,
        status: 'start',
      });
    }
  }

  /**
   * Handle item/completed — emit tool_use end for command-type items.
   * @param {Object} params
   */
  _handleItemCompleted(params) {
    if (!params) return;
    const type = params.type || params.itemType;
    if (type === 'command' || type === 'tool_call' || type === 'function_call') {
      this.emit('tool_use', {
        toolCallId: params.itemId || params.id,
        toolName: params.name || params.title || type,
        status: 'end',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Server request handling (requests from the server that need a response)
  // ---------------------------------------------------------------------------

  /**
   * Handle a server-initiated request (has method AND id).
   * @param {Object} msg - Parsed JSON-RPC request
   */
  _handleServerRequest(msg) {
    const { method, id, params } = msg;

    if (method === 'requestApproval') {
      logger.debug(`[CodexBridge] Auto-approving requestApproval (id=${id})`);
      this._sendResponse(id, { decision: 'accept' });
      return;
    }

    // Unknown server request — respond with error to avoid hangs
    logger.warn(`[CodexBridge] Unknown server request: ${method} (id=${id})`);
    this._sendErrorResponse(id, -32601, `Method not found: ${method}`);
  }

  /**
   * Send a JSON-RPC success response.
   * @param {number|string} id - Request ID
   * @param {Object} result
   */
  _sendResponse(id, result) {
    this._writeLine({ jsonrpc: '2.0', id, result });
  }

  /**
   * Send a JSON-RPC error response.
   * @param {number|string} id - Request ID
   * @param {number} code - Error code
   * @param {string} message - Error message
   */
  _sendErrorResponse(id, code, message) {
    this._writeLine({ jsonrpc: '2.0', id, error: { code, message } });
  }
}

module.exports = CodexBridge;
