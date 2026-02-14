// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Chat Session Manager
 *
 * Manages active chat sessions, each backed by a Pi RPC bridge process.
 * Handles session lifecycle (create, message, close), persistence to SQLite,
 * and event dispatch (delta, complete, tool_use) to registered listeners.
 */

const PiBridge = require('./pi-bridge');
const logger = require('../utils/logger');

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
   * @param {string} options.provider - 'pi' (and later 'claude')
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
    const bridge = new PiBridge({
      provider,
      model,
      cwd,
      systemPrompt,
      tools: 'read,bash,grep,find,ls'
    });

    const listeners = {
      delta: new Set(),
      complete: new Set(),
      toolUse: new Set()
    };

    // Store in map before starting so event handlers can find it
    this._sessions.set(sessionId, { bridge, listeners, initialContext: initialContext || null });

    // Wire up bridge events
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
      // Store assistant message in DB
      const fullText = data.fullText || '';
      let messageId = null;
      if (fullText) {
        try {
          const msgStmt = this._db.prepare(`
            INSERT INTO chat_messages (session_id, role, content)
            VALUES (?, 'assistant', ?)
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

    bridge.on('error', (data) => {
      logger.error(`[ChatSession] Bridge error for session ${sessionId}: ${data.error?.message || 'unknown'}`);
    });

    bridge.on('close', () => {
      // If the bridge closes unexpectedly (not via closeSession), update DB
      if (this._sessions.has(sessionId)) {
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
   * @returns {Promise<{id: number}>} The stored message ID
   */
  async sendMessage(sessionId, content) {
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

    // On the first message, prepend initial context (suggestions, etc.)
    let messageForAgent = content;
    if (session.initialContext) {
      messageForAgent = session.initialContext + '\n\n---\n\n' + content;
      session.initialContext = null; // Only prepend once
    }

    // Store user message in DB
    const stmt = this._db.prepare(`
      INSERT INTO chat_messages (session_id, role, content)
      VALUES (?, 'user', ?)
    `);
    const result = stmt.run(sessionId, content);
    const messageId = Number(result.lastInsertRowid);

    // Forward to bridge
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
   * @param {number} sessionId
   * @returns {Array}
   */
  getMessages(sessionId) {
    return this._db.prepare(
      'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId);
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
