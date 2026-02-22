// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pi RPC Bridge
 *
 * Manages a long-lived Pi process in RPC mode for interactive chat sessions.
 * Communicates over stdin/stdout using Pi's JSONL RPC protocol:
 * - Sends JSON commands (prompt, abort, get_state) on stdin
 * - Receives JSONL events (message_update, agent_end, etc.) on stdout
 *
 * Emits high-level events: delta, complete, error, tool_use, ready, close.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { createInterface } = require('readline');
const logger = require('../utils/logger');

/**
 * Dialog methods in extension_ui_request that expect a response.
 * We auto-cancel these since there's no interactive UI in the bridge.
 */
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

class PiBridge extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} [options.model] - Model ID (e.g., 'claude-sonnet-4')
   * @param {string} [options.provider] - Provider name (e.g., 'anthropic')
   * @param {string} [options.cwd] - Working directory for Pi process
   * @param {string} [options.systemPrompt] - System prompt text
   * @param {string} [options.tools] - Comma-separated tool list (default: 'read,grep,find,ls')
   * @param {string} [options.piCommand] - Override Pi command (default: 'pi')
   * @param {string[]} [options.skills] - Array of skill file paths to load via --skill
   * @param {string[]} [options.extensions] - Array of extension directory paths to load via -e
   * @param {string} [options.sessionPath] - Path to a session file for resumption
   */
  constructor(options = {}) {
    super();
    this.model = options.model || null;
    this.provider = options.provider || null;
    this.cwd = options.cwd || process.cwd();
    this.systemPrompt = options.systemPrompt || null;
    this.tools = options.tools || 'read,grep,find,ls';
    this.piCommand = options.piCommand || process.env.PAIR_REVIEW_PI_CMD || 'pi';
    this.skills = options.skills || [];
    this.extensions = options.extensions || [];
    this.sessionPath = options.sessionPath || null;

    this._process = null;
    this._readline = null;
    this._ready = false;
    this._closing = false;
    // Accumulate text across streaming deltas for each turn
    this._accumulatedText = '';
    this._inMessage = false;
  }

  /**
   * Spawn the Pi RPC process and wait for it to be ready.
   * Resolves once the process is started and the readline interface is set up.
   * @returns {Promise<void>}
   */
  async start() {
    if (this._process) {
      throw new Error('PiBridge already started');
    }

    const args = this._buildArgs();
    const command = this.piCommand;
    const spawnArgs = args;

    logger.info(`[PiBridge] Starting Pi RPC: ${command} ${spawnArgs.join(' ')}`);

    return new Promise((resolve, reject) => {
      const proc = spawn(command, spawnArgs, {
        cwd: this.cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this._process = proc;

      // Handle spawn error (e.g., ENOENT)
      proc.on('error', (err) => {
        if (!this._ready) {
          this._ready = false;
          reject(new Error(`Failed to start Pi RPC: ${err.message}`));
        } else {
          logger.error(`[PiBridge] Process error: ${err.message}`);
          this.emit('error', { error: err });
        }
      });

      // Handle process exit
      proc.on('close', (code, signal) => {
        const wasReady = this._ready;
        this._ready = false;
        this._process = null;

        if (!wasReady && !this._closing) {
          reject(new Error(`Pi RPC exited before ready (code=${code}, signal=${signal})`));
        }

        if (!this._closing) {
          logger.warn(`[PiBridge] Process exited unexpectedly (code=${code}, signal=${signal})`);
          this.emit('error', { error: new Error(`Pi process exited (code=${code}, signal=${signal})`) });
        } else {
          logger.info(`[PiBridge] Process exited (code=${code}, signal=${signal})`);
        }

        this.emit('close');
      });

      // Collect stderr for diagnostics
      proc.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) {
          logger.debug(`[PiBridge] stderr: ${text}`);
        }
      });

      // Set up line-by-line parsing of stdout
      this._readline = createInterface({
        input: proc.stdout,
        crlfDelay: Infinity
      });

      this._readline.on('line', (line) => {
        this._handleLine(line);
      });

      // Handle stdin errors (e.g., EPIPE if process dies)
      proc.stdin.on('error', (err) => {
        logger.error(`[PiBridge] stdin error: ${err.message}`);
      });

      // Pi RPC doesn't emit a specific "ready" event, so we consider it ready
      // once the process is spawned and stdout is being read. We give it a
      // small tick to detect immediate spawn failures.
      setImmediate(() => {
        if (this._process && !this._ready) {
          this._ready = true;
          logger.info(`[PiBridge] Ready (PID ${proc.pid})`);
          this.emit('ready');
          resolve();
        }
      });
    });
  }

  /**
   * Send a user message to the Pi RPC process.
   * @param {string} content - The message text
   * @returns {Promise<void>}
   */
  async sendMessage(content) {
    if (!this.isReady()) {
      throw new Error('PiBridge is not ready');
    }

    // Reset accumulated text for this new turn
    this._accumulatedText = '';
    this._inMessage = false;

    const command = JSON.stringify({ type: 'prompt', message: content });
    logger.debug(`[PiBridge] Sending prompt (${content.length} chars): ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
    this._write(command);
    logger.debug(`[PiBridge] Prompt written to stdin (${command.length} bytes)`);
  }

  /**
   * Abort the current operation.
   */
  abort() {
    if (!this.isReady()) return;
    const command = JSON.stringify({ type: 'abort' });
    logger.debug('[PiBridge] Sending abort');
    this._write(command);
  }

  /**
   * Gracefully shut down the Pi RPC process.
   * @returns {Promise<void>}
   */
  async close() {
    if (!this._process) return;

    this._closing = true;
    this.removeAllListeners();

    // Try to abort any in-flight work first
    try {
      const command = JSON.stringify({ type: 'abort' });
      this._write(command);
    } catch {
      // Process may already be dead
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
          logger.warn('[PiBridge] Force killing process');
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
   * Check if the RPC process is alive and ready.
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
   * Build CLI arguments for the Pi RPC process.
   * @returns {string[]}
   */
  _buildArgs() {
    const args = ['--mode', 'rpc', '--tools', this.tools];

    if (this.sessionPath) {
      args.push('--session', this.sessionPath);
    }

    if (this.provider) {
      args.push('--provider', this.provider);
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    if (this.systemPrompt) {
      args.push('--append-system-prompt', this.systemPrompt);
    }

    for (const skill of this.skills) {
      args.push('--skill', skill);
    }

    // Load extensions via -e (e.g., task extension for subagent delegation).
    // --no-extensions prevents auto-discovery; only explicitly listed ones load.
    if (this.extensions.length > 0) {
      args.push('--no-extensions');
      for (const ext of this.extensions) {
        args.push('-e', ext);
      }
    }

    return args;
  }

  /**
   * Write a JSON command line to the process stdin.
   * @param {string} jsonLine - The JSON string (without trailing newline)
   */
  _write(jsonLine) {
    if (!this._process || !this._process.stdin.writable) {
      throw new Error('Pi RPC process stdin is not writable');
    }
    this._process.stdin.write(jsonLine + '\n');
  }

  /**
   * Handle a single JSONL line from Pi RPC stdout.
   * @param {string} line - A single line of output
   */
  _handleLine(line) {
    if (!line.trim()) return;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      logger.debug(`[PiBridge] Ignoring unparseable line: ${line.substring(0, 100)}`);
      return;
    }

    const type = event.type;

    switch (type) {
      case 'message_start':
        this._inMessage = true;
        break;

      case 'message_update':
        this._handleMessageUpdate(event);
        break;

      case 'message_end':
        this._inMessage = false;
        break;

      case 'agent_end':
        this._handleAgentEnd(event);
        break;

      case 'tool_execution_start':
        this.emit('tool_use', {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          status: 'start'
        });
        break;

      case 'tool_execution_update':
        this.emit('tool_use', {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: 'update',
          partialResult: event.partialResult
        });
        break;

      case 'tool_execution_end':
        this.emit('tool_use', {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: 'end',
          result: event.result,
          isError: event.isError || false
        });
        break;

      case 'extension_ui_request':
        this._handleExtensionUiRequest(event);
        break;

      case 'response':
        // Response to a command (prompt, abort)
        if (!event.success) {
          logger.error(`[PiBridge] Command failed: ${event.error}`);
          this.emit('error', { error: new Error(event.error || 'Unknown command error') });
        } else {
          logger.debug(`[PiBridge] Command acknowledged: ${JSON.stringify(event).substring(0, 200)}`);
        }
        break;

      case 'agent_start':
      case 'turn_start':
        logger.debug(`[PiBridge] ${type}`);
        this.emit('status', { status: 'working' });
        break;
      case 'turn_end':
        logger.debug(`[PiBridge] ${type}`);
        this.emit('status', { status: 'turn_complete' });
        break;
      case 'session':
        logger.debug(`[PiBridge] ${type}: ${JSON.stringify(event).substring(0, 200)}`);
        if (event.sessionFile) {
          this.sessionPath = event.sessionFile;
        }
        this.emit('session', event);
        break;

      default:
        logger.debug(`[PiBridge] Unhandled event type: ${type}`);
    }
  }

  /**
   * Handle a message_update event containing streaming content deltas.
   * @param {Object} event - The message_update event
   */
  _handleMessageUpdate(event) {
    const assistantEvent = event.assistantMessageEvent;
    if (!assistantEvent) return;

    switch (assistantEvent.type) {
      case 'text_delta': {
        const text = assistantEvent.delta || '';
        if (text) {
          this._accumulatedText += text;
          this.emit('delta', { text });
        }
        break;
      }
      case 'text_start':
        // When a new text block starts and we already have accumulated text
        // from a previous block, inject paragraph separation so the markdown
        // renderer doesn't smash the blocks together (e.g., "it.Done").
        if (this._accumulatedText) {
          this._accumulatedText += '\n\n';
          this.emit('delta', { text: '\n\n' });
        }
        break;
      case 'text_end':
        // Boundary marker - no action needed
        break;
      case 'thinking_start':
      case 'thinking_delta':
      case 'thinking_end':
        // Thinking events - could be extended later
        break;
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end':
        // Tool call deltas within message_update - the actual execution
        // events (tool_execution_start/end) are more useful for our purposes
        break;
      case 'done':
        // Message streaming is complete
        break;
      case 'error': {
        const errorMsg = assistantEvent.error || assistantEvent.delta || 'Unknown streaming error';
        logger.error(`[PiBridge] Streaming error: ${errorMsg}`);
        this.emit('error', { error: new Error(errorMsg) });
        break;
      }
      default:
        logger.debug(`[PiBridge] Unhandled assistantMessageEvent type: ${assistantEvent.type}`);
    }
  }

  /**
   * Handle agent_end event which signals the completion of the agent's work.
   * Emits 'complete' with the full accumulated text.
   * @param {Object} _event - The agent_end event
   */
  _handleAgentEnd(_event) {
    const fullText = this._accumulatedText;
    this._accumulatedText = '';
    this._inMessage = false;

    logger.debug(`[PiBridge] Agent ended, accumulated ${fullText.length} chars`);
    this.emit('complete', { fullText });
  }

  /**
   * Handle extension_ui_request events.
   * Dialog methods (select, confirm, input, editor) are auto-cancelled.
   * Fire-and-forget methods are ignored.
   * @param {Object} event - The extension_ui_request event
   */
  _handleExtensionUiRequest(event) {
    const method = event.method;
    const id = event.id;

    if (DIALOG_METHODS.has(method) && id) {
      logger.debug(`[PiBridge] Auto-cancelling dialog: ${method} (${id})`);
      // Respond with cancellation
      const response = JSON.stringify({
        type: 'extension_ui_response',
        id,
        cancelled: true
      });
      try {
        this._write(response);
      } catch {
        // Process may be dead
      }
    } else {
      logger.debug(`[PiBridge] Ignoring extension_ui_request: ${method}`);
    }
  }
}

module.exports = PiBridge;
