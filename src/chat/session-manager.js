// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Chat Session Manager
 *
 * Manages active chat sessions, each backed by a provider-specific bridge process.
 * Handles session lifecycle (create, message, close), persistence to SQLite,
 * and event dispatch (delta, complete, tool_use) to registered listeners.
 */

const fs = require('fs');
const path = require('path');
const PiBridge = require('./pi-bridge');
const AcpBridge = require('./acp-bridge');
const logger = require('../utils/logger');

const pairReviewSkillPath = path.resolve(__dirname, '../../.pi/skills/pair-review-api/SKILL.md');
const taskExtensionDir = path.resolve(__dirname, '../../.pi/extensions/task');

const CHAT_TOOLS = 'read,bash,grep,find,ls';

const ACP_PROVIDERS = new Set(['acp']);

class ChatSessionManager {
  /**
   * @param {Database} db - better-sqlite3 database instance
   */
  constructor(db) {
    this._db = db;
    this._sessions = new Map(); // sessionId -> { bridge, listeners }
  }

  /**
   * Create a new chat session and spawn the agent process.
   * @param {Object} options
   * @param {string} options.provider - any configured chat provider
   * @param {string} [options.model] - Model ID
   * @param {number} options.reviewId - Review ID
   * @param {number} [options.contextCommentId] - Optional suggestion ID that triggered chat
   * @param {string} [options.systemPrompt] - System prompt text
   * @param {string} [options.cwd] - Working directory for agent
   * @param {string} [options.initialContext] - Initial context to prepend to the first user message
   * @returns {Promise<{id: number, status: string}>}
   */
  async createSession({ provider, model, reviewId, contextCommentId, systemPrompt, cwd, initialContext }) {
    // Insert session record into DB
    const stmt = this._db.prepare(`
      INSERT INTO chat_sessions (review_id, context_comment_id, provider, model, status)
      VALUES (?, ?, ?, ?, 'active')
    `);
    const result = stmt.run(
      reviewId,
      contextCommentId || null,
      provider,
      model || null
    );
    const sessionId = Number(result.lastInsertRowid);

    logger.info(`[ChatSession] Creating session ${sessionId} (provider=${provider}, review=${reviewId})`);

    // Create and start the bridge
    // Chat sessions get bash for git commands; review analysis uses the safe default
    const bridge = this._createBridge(provider, {
      provider,
      model,
      cwd,
      systemPrompt,
    });

    const listeners = {
      delta: new Set(),
      complete: new Set(),
      toolUse: new Set(),
      status: new Set(),
      error: new Set()
    };

    // Store in map before starting so event handlers can find it
    this._sessions.set(sessionId, { bridge, listeners, initialContext: initialContext || null });

    // Wire up bridge events
    this._wireBridgeEvents(sessionId, bridge, listeners);

    // Start the bridge process
    try {
      await bridge.start();
    } catch (err) {
      // Bridge failed to start — clean up
      this._sessions.delete(sessionId);
      this._db.prepare(`
        UPDATE chat_sessions SET status = 'error', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(sessionId);
      logger.error(`[ChatSession] Failed to start bridge for session ${sessionId}: ${err.message}`);
      throw err;
    }

    logger.info(`[ChatSession] Session ${sessionId} active`);
    return { id: sessionId, status: 'active' };
  }

  /**
   * Send a user message to an active session.
   * Stores the user message in DB, forwards to bridge, and returns.
   * Bridge will emit 'delta' and 'complete' events that route handlers listen to.
   * @param {number} sessionId - Chat session ID
   * @param {string} content - User message text
   * @param {Object} [options]
   * @param {string} [options.context] - Per-message context to prepend (e.g., focused suggestion details).
   *   Sent to the agent but NOT stored in DB as part of the user message.
   * @param {Object} [options.contextData] - Structured context data (JSON-serializable) to persist
   *   in DB as a separate 'context' type message for session resumption UI reconstruction.
   * @returns {Promise<{id: number}>} The stored message ID
   */
  async sendMessage(sessionId, content, { context, contextData, actionContext } = {}) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }

    if (!session.bridge.isReady()) {
      throw new Error(`Session ${sessionId} bridge is not ready`);
    }

    if (session.bridge.isBusy()) {
      throw new Error(`Session ${sessionId} is currently processing a message`);
    }

    // Build the message for the agent: initialContext > context > userMessage
    // (broad session context first, then narrow per-message context, then user text)
    let messageForAgent = content;

    // Prepend per-message context first (focused suggestion — closer to user message)
    if (context) {
      messageForAgent = context + '\n\n---\n\n' + messageForAgent;
    }

    // Then prepend initial session context (all suggestions — outermost)
    if (session.initialContext) {
      messageForAgent = session.initialContext + '\n\n---\n\n' + messageForAgent;
      session.initialContext = null; // Only prepend once
    }

    // Inject action context (from action bar buttons: adopt, update, dismiss).
    // IMPORTANT: Item IDs are passed here as structured metadata for the agent only.
    // They must NEVER appear in user-visible message text (inputEl.value).
    // The frontend sets _pendingActionContext synchronously before sendMessage(),
    // which consumes and clears it before the async fetch — no race window.
    if (actionContext && actionContext.type && actionContext.itemId) {
      const actionHint = `[Action: ${actionContext.type}, target ID: ${actionContext.itemId}]`;
      messageForAgent = messageForAgent + '\n\n' + actionHint;
    } else if (actionContext && actionContext.type === 'create-comment' && actionContext.file) {
      const lineSpec = (!actionContext.line_end || actionContext.line_start === actionContext.line_end)
        ? `${actionContext.line_start}`
        : `${actionContext.line_start}-${actionContext.line_end}`;
      const actionHint = `[Action: create-comment, file: ${actionContext.file}, lines: ${lineSpec}]`;
      messageForAgent = messageForAgent + '\n\n' + actionHint;
    }

    // Store context + user message atomically
    const insertAll = this._db.transaction(() => {
      // 1. Insert context rows (for session resumption UI)
      if (contextData) {
        const ctxStmt = this._db.prepare(`
          INSERT INTO chat_messages (session_id, role, type, content)
          VALUES (?, 'user', 'context', ?)
        `);
        const items = Array.isArray(contextData) ? contextData : [contextData];
        for (const item of items) {
          ctxStmt.run(sessionId, typeof item === 'string' ? item : JSON.stringify(item));
        }
      }

      // 2. Insert user message
      const stmt = this._db.prepare(`
        INSERT INTO chat_messages (session_id, role, type, content)
        VALUES (?, 'user', 'message', ?)
      `);
      return stmt.run(sessionId, content);
    });

    const result = insertAll();
    const messageId = Number(result.lastInsertRowid);

    // Forward to bridge
    logger.debug(`[ChatSession] Session ${sessionId}: forwarding message to bridge (${messageForAgent.length} chars, delta listeners: ${session.listeners.delta.size})`);
    await session.bridge.sendMessage(messageForAgent);

    return { id: messageId };
  }

  /**
   * Register a callback for streaming text deltas from a session.
   * @param {number} sessionId
   * @param {function} callback - Called with {text} on each delta
   * @returns {function} Unsubscribe function
   */
  onDelta(sessionId, callback) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }
    session.listeners.delta.add(callback);
    return () => session.listeners.delta.delete(callback);
  }

  /**
   * Register a callback for turn completion.
   * When the agent completes, the assistant message is already stored in DB.
   * @param {number} sessionId
   * @param {function} callback - Called with {fullText, messageId}
   * @returns {function} Unsubscribe function
   */
  onComplete(sessionId, callback) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }
    session.listeners.complete.add(callback);
    return () => session.listeners.complete.delete(callback);
  }

  /**
   * Register a callback for tool use events.
   * @param {number} sessionId
   * @param {function} callback - Called with {toolCallId, toolName, status, ...}
   * @returns {function} Unsubscribe function
   */
  onToolUse(sessionId, callback) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }
    session.listeners.toolUse.add(callback);
    return () => session.listeners.toolUse.delete(callback);
  }

  /**
   * Register a callback for agent status events (working, turn_complete).
   * @param {number} sessionId
   * @param {function} callback - Called with {status}
   * @returns {function} Unsubscribe function
   */
  onStatus(sessionId, callback) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }
    session.listeners.status.add(callback);
    return () => session.listeners.status.delete(callback);
  }

  /**
   * Register a callback for error events from the bridge.
   * @param {number} sessionId
   * @param {function} callback - Called with {message}
   * @returns {function} Unsubscribe function
   */
  onError(sessionId, callback) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }
    session.listeners.error.add(callback);
    return () => session.listeners.error.delete(callback);
  }

  /**
   * Abort the current turn in an active session.
   * @param {number} sessionId
   */
  abortSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }
    session.bridge.abort();
    logger.info(`[ChatSession] Aborted session ${sessionId}`);
  }

  /**
   * Close a session and kill the agent process.
   * @param {number} sessionId
   * @returns {Promise<void>}
   */
  async closeSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      // Session may already be closed — just update DB to be safe
      this._db.prepare(`
        UPDATE chat_sessions SET status = 'closed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'active'
      `).run(sessionId);
      return;
    }

    // Remove from map first so the 'close' event handler doesn't double-update
    this._sessions.delete(sessionId);

    // Close the bridge process (PiBridge.close() handles listener cleanup internally)
    await session.bridge.close();

    // Update DB status
    this._db.prepare(`
      UPDATE chat_sessions SET status = 'closed', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(sessionId);

    logger.info(`[ChatSession] Session ${sessionId} closed`);
  }

  /**
   * Get session info from the database.
   * @param {number} sessionId
   * @returns {Object|null}
   */
  getSession(sessionId) {
    return this._db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId) || null;
  }

  /**
   * Check if a session has an active in-memory bridge.
   * Unlike getSession() which queries the DB, this checks the live session map.
   * @param {number} sessionId
   * @returns {boolean}
   */
  isSessionActive(sessionId) {
    return this._sessions.has(sessionId);
  }

  /**
   * List sessions for a review.
   * @param {number} reviewId
   * @returns {Array}
   */
  getSessionsForReview(reviewId) {
    return this._db.prepare(
      'SELECT * FROM chat_sessions WHERE review_id = ? ORDER BY created_at DESC'
    ).all(reviewId);
  }

  /**
   * Get message history for a session.
   * Returns all message types including rows with type='context' (used to
   * reconstruct context cards in the UI for session resumption). Consumers
   * building session replay should dispatch on the `type` field to distinguish
   * 'message' rows from 'context' rows.
   * @param {number} sessionId
   * @returns {Array}
   */
  getMessages(sessionId) {
    return this._db.prepare(
      'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC'
    ).all(sessionId);
  }

  /**
   * Save a context message to an existing session.
   * Used to persist analysis context cards (and potentially other context types)
   * immediately, without waiting for the next user message.
   * @param {number} sessionId
   * @param {Object|string} contextData - Context data to persist (will be JSON-stringified if object)
   * @returns {{ id: number }} The stored message ID
   */
  saveContextMessage(sessionId, contextData) {
    const session = this._db.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const content = typeof contextData === 'string' ? contextData : JSON.stringify(contextData);
    const stmt = this._db.prepare(`
      INSERT INTO chat_messages (session_id, role, type, content)
      VALUES (?, 'user', 'context', ?)
    `);
    const result = stmt.run(sessionId, content);
    return { id: Number(result.lastInsertRowid) };
  }

  /**
   * Resume a previously closed chat session by re-spawning the chat bridge
   * with the stored session file path.
   * @param {number} sessionId
   * @param {Object} options
   * @param {string} [options.systemPrompt] - System prompt text
   * @param {string} [options.cwd] - Working directory for agent
   * @returns {Promise<{id: number, status: string}>}
   */
  async resumeSession(sessionId, { systemPrompt, cwd } = {}) {
    // Already active — return immediately
    if (this._sessions.has(sessionId)) {
      return { id: sessionId, status: 'active' };
    }

    // Load session row from DB
    const row = this._db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId);
    if (!row) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const isAcp = ACP_PROVIDERS.has(row.provider);

    if (!isAcp) {
      // Pi sessions require a session file on disk
      if (!row.agent_session_id) {
        throw new Error(`Session ${sessionId} has no session file — cannot resume`);
      }
      if (!fs.existsSync(row.agent_session_id)) {
        this._db.prepare('UPDATE chat_sessions SET agent_session_id = NULL WHERE id = ?').run(sessionId);
        throw new Error(`Session file not found on disk: ${row.agent_session_id}`);
      }
    }

    logger.info(`[ChatSession] Resuming session ${sessionId}${isAcp ? ` (ACP session ${row.agent_session_id || 'new'})` : ` from ${row.agent_session_id}`}`);

    const bridge = this._createBridge(row.provider, {
      provider: row.provider,
      model: row.model,
      cwd,
      systemPrompt,
      ...(isAcp
        ? (row.agent_session_id ? { resumeSessionId: row.agent_session_id } : {})
        : { sessionPath: row.agent_session_id }),
    });

    const listeners = {
      delta: new Set(),
      complete: new Set(),
      toolUse: new Set(),
      status: new Set(),
      error: new Set()
    };

    this._sessions.set(sessionId, { bridge, listeners, initialContext: null });
    this._wireBridgeEvents(sessionId, bridge, listeners);

    // Start the bridge process
    try {
      await bridge.start();
    } catch (err) {
      this._sessions.delete(sessionId);
      this._db.prepare(`
        UPDATE chat_sessions SET status = 'error', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(sessionId);
      logger.error(`[ChatSession] Failed to resume bridge for session ${sessionId}: ${err.message}`);
      throw err;
    }

    // Update DB status back to active
    this._db.prepare(`
      UPDATE chat_sessions SET status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(sessionId);

    logger.info(`[ChatSession] Session ${sessionId} resumed`);
    return { id: sessionId, status: 'active' };
  }

  /**
   * Get the most recently updated session for a review.
   * @param {number} reviewId
   * @returns {Object|null}
   */
  getMRUSession(reviewId) {
    return this._db.prepare(
      'SELECT * FROM chat_sessions WHERE review_id = ? ORDER BY updated_at DESC LIMIT 1'
    ).get(reviewId) || null;
  }

  /**
   * Get sessions for a review with message counts (for session list UI).
   * @param {number} reviewId
   * @returns {Array<Object>}
   */
  getSessionsWithMessageCount(reviewId) {
    return this._db.prepare(`
      SELECT s.*, COUNT(m.id) AS message_count,
        (SELECT content FROM chat_messages
         WHERE session_id = s.id AND role = 'user' AND type = 'message'
         ORDER BY id ASC LIMIT 1
        ) AS first_message
      FROM chat_sessions s
      LEFT JOIN chat_messages m ON m.session_id = s.id AND m.type = 'message'
      WHERE s.review_id = ?
      GROUP BY s.id
      ORDER BY s.updated_at DESC
    `).all(reviewId);
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Create the appropriate bridge instance for a provider.
   * ACP providers get an AcpBridge; everything else gets a PiBridge with tools/skills.
   * @param {string} provider
   * @param {Object} options - Bridge constructor options
   * @returns {PiBridge|AcpBridge}
   */
  _createBridge(provider, options) {
    if (ACP_PROVIDERS.has(provider)) {
      return new AcpBridge(options);
    }
    return new PiBridge({
      ...options,
      tools: CHAT_TOOLS,
      skills: [pairReviewSkillPath],
      extensions: [taskExtensionDir],
    });
  }

  /**
   * Wire up bridge event handlers that dispatch to the session's listener sets
   * and handle DB persistence (e.g., storing assistant messages on completion).
   * @param {number} sessionId
   * @param {PiBridge|AcpBridge} bridge
   * @param {Object} listeners - Listener sets keyed by event type
   */
  _wireBridgeEvents(sessionId, bridge, listeners) {
    bridge.on('delta', (data) => {
      for (const cb of listeners.delta) {
        try {
          cb(data);
        } catch (err) {
          logger.error(`[ChatSession] Delta listener error: ${err.message}`);
        }
      }
    });

    bridge.on('complete', (data) => {
      logger.debug(`[ChatSession] Session ${sessionId} complete: ${(data.fullText || '').length} chars, ${listeners.complete.size} listener(s)`);
      // Store assistant message in DB
      const fullText = data.fullText || '';
      let messageId = null;
      if (fullText) {
        try {
          const msgStmt = this._db.prepare(`
            INSERT INTO chat_messages (session_id, role, type, content)
            VALUES (?, 'assistant', 'message', ?)
          `);
          const msgResult = msgStmt.run(sessionId, fullText);
          messageId = Number(msgResult.lastInsertRowid);
        } catch (err) {
          logger.error(`[ChatSession] Failed to store assistant message: ${err.message}`);
        }
      }

      for (const cb of listeners.complete) {
        try {
          cb({ fullText, messageId });
        } catch (err) {
          logger.error(`[ChatSession] Complete listener error: ${err.message}`);
        }
      }
    });

    bridge.on('tool_use', (data) => {
      for (const cb of listeners.toolUse) {
        try {
          cb(data);
        } catch (err) {
          logger.error(`[ChatSession] ToolUse listener error: ${err.message}`);
        }
      }
    });

    bridge.on('status', (data) => {
      for (const cb of listeners.status) {
        try {
          cb(data);
        } catch (err) {
          logger.error(`[ChatSession] Status listener error: ${err.message}`);
        }
      }
    });

    bridge.on('error', (data) => {
      logger.error(`[ChatSession] Bridge error for session ${sessionId}: ${data.error?.message || 'unknown'}`);
      for (const cb of listeners.error) {
        try {
          cb({ message: data.error?.message || 'Agent encountered an error' });
        } catch (err) {
          logger.error(`[ChatSession] Error listener error: ${err.message}`);
        }
      }
    });

    bridge.on('close', () => {
      // If the bridge closes unexpectedly (not via closeSession), update DB
      if (this._sessions.has(sessionId)) {
        for (const cb of listeners.error) {
          try {
            cb({ message: 'Agent process ended unexpectedly' });
          } catch (err) {
            logger.error(`[ChatSession] Error listener error: ${err.message}`);
          }
        }
        try {
          this._db.prepare(`
            UPDATE chat_sessions SET status = 'closed', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'active'
          `).run(sessionId);
        } catch (err) {
          logger.error(`[ChatSession] Failed to update session status on close: ${err.message}`);
        }
        this._sessions.delete(sessionId);
        logger.warn(`[ChatSession] Session ${sessionId} closed unexpectedly`);
      }
    });

    bridge.on('session', (event) => {
      const sessionRef = event.sessionFile || event.sessionId;
      if (sessionRef) {
        try {
          this._db.prepare('UPDATE chat_sessions SET agent_session_id = ? WHERE id = ?')
            .run(sessionRef, sessionId);
          logger.info(`[ChatSession] Session ${sessionId} agent ref: ${sessionRef}`);
        } catch (err) {
          logger.warn(`[ChatSession] Failed to store session ref: ${err.message}`);
        }
      }
    });
  }

  /**
   * Close all active sessions (for cleanup on server shutdown).
   * @returns {Promise<void>}
   */
  async closeAll() {
    const sessionIds = [...this._sessions.keys()];
    if (sessionIds.length === 0) return;

    logger.info(`[ChatSession] Closing ${sessionIds.length} active session(s)`);
    await Promise.all(sessionIds.map((id) => this.closeSession(id)));
  }
}

module.exports = ChatSessionManager;
