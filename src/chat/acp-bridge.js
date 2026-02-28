// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * ACP (Agent Client Protocol) Bridge
 *
 * Manages a long-lived agent process using the ACP protocol for interactive
 * chat sessions. Communicates over stdin/stdout using newline-delimited JSON-RPC.
 * Mirrors the PiBridge EventEmitter interface so both can be used interchangeably.
 *
 * Emits high-level events: delta, complete, error, tool_use, status, ready, close, session.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { Writable, Readable } = require('stream');
const logger = require('../utils/logger');
const { version: pkgVersion } = require('../../package.json');

// Default dependencies (overridable for testing)
const defaults = {
  spawn,
  acp: require('@agentclientprotocol/sdk'),
  Writable,
  Readable,
};

class AcpBridge extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} [options.model] - Model ID
   * @param {string} [options.cwd] - Working directory for agent process
   * @param {string} [options.systemPrompt] - System prompt text
   * @param {string} [options.acpCommand] - Agent binary (default: env PAIR_REVIEW_ACP_CMD or 'copilot')
   * @param {string[]} [options.acpArgs] - Extra CLI args (default: ['--acp', '--stdio'])
   * @param {Object} [options.env] - Extra env vars for subprocess
   * @param {string} [options.resumeSessionId] - ACP session ID to resume via loadSession
   * @param {Object} [options._deps] - Dependency injection for testing
   */
  constructor(options = {}) {
    super();
    this.model = options.model || null;
    this.cwd = options.cwd || process.cwd();
    this.systemPrompt = options.systemPrompt || null;
    this.acpCommand = options.acpCommand || process.env.PAIR_REVIEW_ACP_CMD || 'copilot';
    this.acpArgs = options.acpArgs || ['--acp', '--stdio'];
    this.env = options.env || {};
    this.resumeSessionId = options.resumeSessionId || null;

    this._deps = { ...defaults, ...options._deps };
    this._process = null;
    this._connection = null;
    this._sessionId = null;
    this._ready = false;
    this._closing = false;
    this._accumulatedText = '';
    this._inMessage = false;
    this._firstMessage = true;
  }

  /**
   * Spawn the agent subprocess, perform ACP handshake, and create a session.
   * Resolves once the session is established and the bridge is ready.
   * @returns {Promise<void>}
   */
  async start() {
    if (this._process) {
      throw new Error('AcpBridge already started');
    }

    const deps = this._deps;
    const command = this.acpCommand;
    const args = this.acpArgs;

    logger.info(`[AcpBridge] Starting ACP agent: ${command} ${args.join(' ')}`);

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
          reject(new Error(`Failed to start ACP agent: ${err.message}`));
        } else {
          logger.error(`[AcpBridge] Process error: ${err.message}`);
          this.emit('error', { error: err });
        }
      });

      // Handle process exit
      proc.on('close', (code, signal) => {
        const wasReady = this._ready;
        this._ready = false;
        this._process = null;

        if (!wasReady && !this._closing) {
          reject(new Error(`ACP agent exited before ready (code=${code}, signal=${signal})`));
        }

        if (!this._closing) {
          logger.warn(`[AcpBridge] Process exited unexpectedly (code=${code}, signal=${signal})`);
          this.emit('error', { error: new Error(`ACP agent exited (code=${code}, signal=${signal})`) });
        } else {
          logger.info(`[AcpBridge] Process exited (code=${code}, signal=${signal})`);
        }

        this.emit('close');
      });

      // Collect stderr for diagnostics
      proc.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) {
          logger.debug(`[AcpBridge] stderr: ${text}`);
        }
      });

      // Handle stdin errors (e.g., EPIPE if process dies)
      proc.stdin.on('error', (err) => {
        logger.error(`[AcpBridge] stdin error: ${err.message}`);
      });

      // Set up ACP connection
      this._initializeConnection(proc, deps)
        .then(() => {
          this._ready = true;
          logger.info(`[AcpBridge] Ready (PID ${proc.pid})`);
          this.emit('ready');
          resolve();
        })
        .catch((err) => {
          if (!this._closing) {
            reject(new Error(`ACP initialization failed: ${err.message}`));
          }
        });
    });
  }

  /**
   * Initialize the ACP connection, perform handshake, and create session.
   * @param {ChildProcess} proc - The spawned agent process
   * @param {Object} deps - Dependencies
   * @returns {Promise<void>}
   */
  async _initializeConnection(proc, deps) {
    const stream = deps.acp.ndJsonStream(
      deps.Writable.toWeb(proc.stdin),
      deps.Readable.toWeb(proc.stdout)
    );

    const bridge = this;
    const clientHandler = {
      sessionUpdate(params) {
        bridge._handleSessionUpdate(params);
      },
      requestPermission(params) {
        return bridge._handlePermission(params);
      },
    };

    this._connection = new deps.acp.ClientSideConnection(
      (_agent) => clientHandler,
      stream
    );

    await this._connection.initialize({
      protocolVersion: deps.acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'pair-review', version: pkgVersion },
    });

    if (this.resumeSessionId) {
      // Resume a previous session — agent restores conversation history
      await this._connection.loadSession({
        sessionId: this.resumeSessionId,
        cwd: this.cwd,
        mcpServers: [],
      });
      this._sessionId = this.resumeSessionId;
      logger.info(`[AcpBridge] Session resumed: ${this.resumeSessionId}`);
    } else {
      const { sessionId } = await this._connection.newSession({
        cwd: this.cwd,
        mcpServers: [],
      });
      this._sessionId = sessionId;
      logger.info(`[AcpBridge] Session created: ${sessionId}`);
    }

    // Emit session info once so session-manager can store the agent_session_id
    this.emit('session', { sessionId: this._sessionId });
  }

  /**
   * Send a user message to the ACP agent.
   * Fire-and-forget: returns immediately, emits events as the agent responds.
   * @param {string} content - The message text
   */
  sendMessage(content) {
    if (!this.isReady()) {
      throw new Error('AcpBridge is not ready');
    }

    // Reset accumulated text for this new turn
    this._accumulatedText = '';
    this._inMessage = true;

    let messageContent = content;
    if (this.systemPrompt && this._firstMessage) {
      messageContent = this.systemPrompt + '\n\n' + content;
      this._firstMessage = false;
    }

    logger.debug(`[AcpBridge] Sending prompt (${messageContent.length} chars): ${messageContent.substring(0, 100)}${messageContent.length > 100 ? '...' : ''}`);

    this._connection.prompt({
      sessionId: this._sessionId,
      prompt: [{ type: 'text', text: messageContent }],
    })
      .then(() => {
        const fullText = this._accumulatedText;
        this._accumulatedText = '';
        this._inMessage = false;
        logger.debug(`[AcpBridge] Prompt completed, accumulated ${fullText.length} chars`);
        this.emit('complete', { fullText });
      })
      .catch((err) => {
        this._inMessage = false;
        logger.error(`[AcpBridge] Prompt error: ${err.message}`);
        this.emit('error', { error: err });
      });

  }

  /**
   * Abort the current operation.
   */
  abort() {
    if (!this.isReady() || !this._sessionId) return;
    logger.debug('[AcpBridge] Sending cancel');
    this._connection.cancel({ sessionId: this._sessionId }).catch((err) => {
      logger.error(`[AcpBridge] Cancel error: ${err.message}`);
    });
  }

  /**
   * Gracefully shut down the ACP agent process.
   * @returns {Promise<void>}
   */
  async close() {
    if (!this._process) return;

    this._closing = true;

    // Cancel any in-flight prompt before tearing down
    if (this._connection && this._sessionId) {
      try { await this._connection.cancel({ sessionId: this._sessionId }); } catch { /* already dead */ }
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
          logger.warn('[AcpBridge] Force killing process');
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
   * Check if the ACP agent process is alive and ready.
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
   * Handle a sessionUpdate notification from the ACP agent.
   * @param {Object} params - { sessionId, update }
   */
  _handleSessionUpdate(params) {
    const update = params.update;
    if (!update) return;

    const type = update.sessionUpdate;

    switch (type) {
      case 'agent_message_chunk':
        this._handleMessageChunk(update);
        break;

      case 'tool_call':
        this.emit('tool_use', {
          toolCallId: update.toolCallId,
          toolName: update.title,
          status: 'start',
          kind: update.kind,
        });
        break;

      case 'tool_call_update':
        this._handleToolCallUpdate(update);
        break;

      case 'plan':
        this.emit('status', { status: 'working' });
        break;

      default:
        logger.debug(`[AcpBridge] Unhandled sessionUpdate type: ${type}`);
    }
  }

  /**
   * Handle an agent_message_chunk update containing streaming content.
   * @param {Object} update - The agent_message_chunk update
   */
  _handleMessageChunk(update) {
    const content = update.content;
    if (!content) return;

    if (content.type === 'text' && content.text) {
      // ACP sends chunks as fragments of a continuous stream,
      // so accumulate directly without paragraph separation.
      this._accumulatedText += content.text;
      this.emit('delta', { text: content.text });
    }
  }

  /**
   * Handle a tool_call_update, mapping ACP status to bridge status.
   * @param {Object} update - The tool_call_update
   */
  _handleToolCallUpdate(update) {
    let status;
    switch (update.status) {
      case 'completed':
        status = 'end';
        break;
      case 'in_progress':
        status = 'update';
        break;
      case 'failed':
        status = 'end';
        break;
      default:
        status = 'update';
    }

    this.emit('tool_use', {
      toolCallId: update.toolCallId,
      toolName: update.title,
      status,
    });
  }

  /**
   * Handle a permission request from the ACP agent.
   * Auto-approves by selecting the allow_once or allow_always option.
   * @param {Object} params - { sessionId, toolCall, options }
   * @returns {Object} - Permission outcome
   */
  _handlePermission(params) {
    const options = params.options || [];

    // Prefer allow_once, fall back to allow_always
    const allowOnce = options.find((o) => o.kind === 'allow_once');
    if (allowOnce) {
      logger.debug(`[AcpBridge] Auto-approving permission (allow_once): ${allowOnce.name || allowOnce.optionId}`);
      return { outcome: { outcome: 'selected', optionId: allowOnce.optionId } };
    }

    const allowAlways = options.find((o) => o.kind === 'allow_always');
    if (allowAlways) {
      logger.debug(`[AcpBridge] Auto-approving permission (allow_always): ${allowAlways.name || allowAlways.optionId}`);
      return { outcome: { outcome: 'selected', optionId: allowAlways.optionId } };
    }

    logger.warn('[AcpBridge] No allow option found, cancelling permission request');
    return { outcome: { outcome: 'cancelled' } };
  }
}

module.exports = AcpBridge;
