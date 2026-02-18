// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Chat Routes
 *
 * Handles chat session endpoints:
 * - Creating chat sessions
 * - Sending messages
 * - SSE streaming for real-time responses
 * - Message history
 * - Closing sessions
 * - Listing sessions for a review
 */

const express = require('express');
const { queryOne, query } = require('../database');
const { buildChatPrompt, buildInitialContext } = require('../chat/prompt-builder');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Connected SSE clients for the multiplexed chat stream.
 * Each entry is an Express response object with an open SSE connection.
 */
const sseClients = new Set();

/**
 * Unsubscribe functions for SSE broadcast listeners, keyed by session ID.
 * Each value is an array of unsubscribe functions returned by the on* methods.
 * Used to clean up listeners when a session is closed.
 * @type {Map<number, function[]>}
 */
const sseUnsubscribers = new Map();

/**
 * Broadcast an SSE event to all connected clients.
 * @param {number} sessionId - Chat session ID to include in the event
 * @param {Object} payload - Event data (will be merged with sessionId)
 */
function broadcastSSE(sessionId, payload) {
  const data = JSON.stringify({ ...payload, sessionId });
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      // Client disconnected — remove from set
      sseClients.delete(client);
    }
  }
}

/**
 * Register SSE broadcast listeners on a chat session so that all events
 * (delta, tool_use, complete, status, error) are forwarded to connected SSE clients.
 * @param {Object} chatSessionManager
 * @param {number} sessionId
 */
function registerSSEBroadcast(chatSessionManager, sessionId) {
  // Guard against double-registration
  if (sseUnsubscribers.has(sessionId)) {
    logger.debug(`[ChatRoute] SSE broadcast already registered for session ${sessionId}, skipping`);
    return;
  }

  try {
    const unsubs = [];

    unsubs.push(chatSessionManager.onDelta(sessionId, (data) => {
      broadcastSSE(sessionId, { type: 'delta', text: data.text });
    }));

    unsubs.push(chatSessionManager.onToolUse(sessionId, (data) => {
      const event = { type: 'tool_use', toolName: data.toolName, status: data.status };
      if (data.args) {
        event.toolInput = data.args;
      }
      broadcastSSE(sessionId, event);
    }));

    unsubs.push(chatSessionManager.onComplete(sessionId, (data) => {
      logger.debug(`[ChatRoute] SSE broadcast complete for session ${sessionId}, messageId=${data.messageId}`);
      broadcastSSE(sessionId, { type: 'complete', messageId: data.messageId });
    }));

    unsubs.push(chatSessionManager.onStatus(sessionId, (data) => {
      broadcastSSE(sessionId, { type: 'status', status: data.status });
    }));

    unsubs.push(chatSessionManager.onError(sessionId, (data) => {
      logger.debug(`[ChatRoute] SSE broadcast error for session ${sessionId}: ${data.message}`);
      broadcastSSE(sessionId, { type: 'error', message: data.message });
    }));

    sseUnsubscribers.set(sessionId, unsubs);
    logger.debug(`[ChatRoute] SSE broadcast listeners registered for session ${sessionId}`);
  } catch (err) {
    logger.warn(`[ChatRoute] Failed to register SSE broadcast for session ${sessionId}: ${err.message}`);
  }
}

/**
 * Unsubscribe all SSE broadcast listeners for a session.
 * @param {number} sessionId
 */
function unregisterSSEBroadcast(sessionId) {
  const unsubs = sseUnsubscribers.get(sessionId);
  if (unsubs) {
    for (const unsub of unsubs) {
      try { unsub(); } catch { /* session may already be closed */ }
    }
    sseUnsubscribers.delete(sessionId);
    logger.debug(`[ChatRoute] SSE broadcast listeners unregistered for session ${sessionId}`);
  }
}

/**
 * Create a new chat session
 */
router.post('/api/chat/session', async (req, res) => {
  try {
    const { provider, model, contextCommentId, systemPrompt, cwd } = req.body || {};
    const reviewId = parseInt(req.body?.reviewId, 10);

    if (!provider || !reviewId || isNaN(reviewId)) {
      return res.status(400).json({
        error: 'Missing required fields: provider, reviewId'
      });
    }

    const chatSessionManager = req.app.chatSessionManager;
    const db = req.app.get('db');

    // Build system prompt if not provided directly
    let finalSystemPrompt = systemPrompt;
    let initialContext = null;
    let suggestions = null;
    let review = null;

    if (!finalSystemPrompt) {
      review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [reviewId]);
      if (!review) {
        return res.status(404).json({ error: 'Review not found' });
      }

      // Focused suggestion (if chat was triggered from a specific suggestion)
      let focusedSuggestion = null;
      if (contextCommentId) {
        focusedSuggestion = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [contextCommentId]);
      }

      finalSystemPrompt = buildChatPrompt({ review });

      // Fetch all AI suggestions from the latest analysis run
      suggestions = await query(db, `
        SELECT
          id, ai_run_id, ai_level, ai_confidence,
          file, line_start, line_end, type, title, body,
          reasoning, status, is_file_level
        FROM comments
        WHERE review_id = ?
          AND source = 'ai'
          -- ai_level IS NULL = orchestrated/final suggestions only
          -- TODO: If single-level results can be saved without orchestration,
          -- we may need an \`is_final\` flag to identify displayable suggestions.
          AND ai_level IS NULL
          AND (is_raw = 0 OR is_raw IS NULL)
          AND ai_run_id = (
            SELECT ai_run_id FROM comments
            WHERE review_id = ? AND source = 'ai' AND ai_run_id IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 1
          )
        ORDER BY file, line_start
      `, [reviewId, reviewId]);

      initialContext = buildInitialContext({
        suggestions,
        focusedSuggestion
      });
    }

    // Resolve cwd: explicit from request body, or local_path from review record
    const resolvedCwd = cwd || (review && review.local_path) || null;

    // Inject the server port into the initial context so the agent learns it
    // once at session start. This avoids wasting tokens by repeating the port
    // with every user message.  If the server restarts on a new port, the next
    // session will pick up the new value automatically.
    const serverPort = req.socket.localPort;
    const portContext = `[Server port: ${serverPort}] The pair-review API is at http://localhost:${serverPort}`;
    const initialContextWithPort = initialContext
      ? portContext + '\n\n' + initialContext
      : portContext;

    const session = await chatSessionManager.createSession({
      provider,
      model,
      reviewId,
      contextCommentId: contextCommentId || null,
      systemPrompt: finalSystemPrompt,
      cwd: resolvedCwd,
      initialContext: initialContextWithPort
    });

    logger.info(`Chat session created: ${session.id} (provider=${provider}, model=${model})`);

    // Register SSE broadcast listeners so events reach all connected clients
    registerSSEBroadcast(chatSessionManager, session.id);

    const responseData = { id: session.id, status: session.status };

    // Include analysis context metadata so the frontend can show a context indicator
    if (initialContext && suggestions && suggestions.length > 0) {
      responseData.context = {
        suggestionCount: suggestions.length
      };
    }

    res.json({ data: responseData });
  } catch (error) {
    logger.error(`Error creating chat session: ${error.message}`);
    res.status(500).json({ error: 'Failed to create chat session' });
  }
});

/**
 * Send a user message to a chat session (auto-resumes if needed)
 */
router.post('/api/chat/session/:id/message', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { content, context, contextData } = req.body || {};

    if (!content) {
      return res.status(400).json({ error: 'Missing required field: content' });
    }

    const chatSessionManager = req.app.chatSessionManager;
    const db = req.app.get('db');

    // Auto-resume: if session is not active in memory, try to resume it
    if (!chatSessionManager.isSessionActive(sessionId)) {
      const session = chatSessionManager.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Chat session not found' });
      }

      if (!session.agent_session_id) {
        return res.status(410).json({ error: 'Session is not resumable (no session file)' });
      }

      // Build system prompt and cwd from the review
      const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [session.review_id]);
      if (!review) {
        return res.status(404).json({ error: 'Review not found for session' });
      }
      const systemPrompt = buildChatPrompt({ review });
      const cwd = review?.local_path || null;

      try {
        await chatSessionManager.resumeSession(sessionId, { systemPrompt, cwd });
        unregisterSSEBroadcast(sessionId);
        registerSSEBroadcast(chatSessionManager, sessionId);
        logger.info(`[ChatRoute] Auto-resumed session ${sessionId} for message delivery`);
      } catch (err) {
        logger.error(`[ChatRoute] Failed to auto-resume session ${sessionId}: ${err.message}`);
        return res.status(410).json({ error: 'Failed to resume session: ' + err.message });
      }
    }

    logger.debug(`[ChatRoute] Forwarding message to session ${sessionId} (${content.length} chars)`);
    const result = await chatSessionManager.sendMessage(sessionId, content, { context, contextData });
    logger.debug(`[ChatRoute] Message stored as ID ${result.id}, awaiting agent response via SSE`);
    res.json({ data: { messageId: result.id } });
  } catch (error) {
    logger.error(`Error sending chat message: ${error.message}`);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * Multiplexed SSE stream for all chat sessions.
 * Clients connect once and receive events tagged with sessionId.
 */
router.get('/api/chat/stream', (req, res) => {
  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Send initial connection acknowledgement
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  logger.debug(`[ChatRoute] Multiplexed SSE client connected (total: ${sseClients.size + 1})`);

  sseClients.add(res);

  // Handle client disconnect
  const cleanup = () => {
    sseClients.delete(res);
    logger.debug(`[ChatRoute] Multiplexed SSE client disconnected (total: ${sseClients.size})`);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
});

/**
 * Abort the current agent turn in a chat session
 */
router.post('/api/chat/session/:id/abort', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const chatSessionManager = req.app.chatSessionManager;

    if (!chatSessionManager.isSessionActive(sessionId)) {
      return res.status(404).json({ error: 'Chat session not found or not active' });
    }

    chatSessionManager.abortSession(sessionId);
    res.json({ data: { success: true } });
  } catch (error) {
    logger.error(`Error aborting chat session: ${error.message}`);
    res.status(500).json({ error: 'Failed to abort' });
  }
});

/**
 * Get message history for a chat session
 */
router.get('/api/chat/session/:id/messages', (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const chatSessionManager = req.app.chatSessionManager;

    const session = chatSessionManager.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Chat session not found' });
    }

    const messages = chatSessionManager.getMessages(sessionId);
    res.json({ data: { messages } });
  } catch (error) {
    logger.error(`Error fetching chat messages: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

/**
 * Explicitly resume a chat session (pre-warm the bridge before sending a message)
 */
router.post('/api/chat/session/:id/resume', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const chatSessionManager = req.app.chatSessionManager;
    const db = req.app.get('db');

    // Already active
    if (chatSessionManager.isSessionActive(sessionId)) {
      return res.json({ data: { id: sessionId, status: 'active' } });
    }

    const session = chatSessionManager.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Chat session not found' });
    }

    if (!session.agent_session_id) {
      return res.status(410).json({ error: 'Session is not resumable (no session file)' });
    }

    const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [session.review_id]);
    if (!review) {
      return res.status(404).json({ error: 'Review not found for session' });
    }

    // Pi's --session replays the original conversation; --append-system-prompt
    // re-injects the review context so the agent retains awareness of the codebase
    // even if the system prompt was only in the initial session's context.
    const systemPrompt = buildChatPrompt({ review });
    const cwd = review?.local_path || null;

    await chatSessionManager.resumeSession(sessionId, { systemPrompt, cwd });
    unregisterSSEBroadcast(sessionId);
    registerSSEBroadcast(chatSessionManager, sessionId);

    logger.info(`[ChatRoute] Explicitly resumed session ${sessionId}`);
    res.json({ data: { id: sessionId, status: 'active' } });
  } catch (error) {
    logger.error(`Error resuming chat session: ${error.message}`);
    res.status(500).json({ error: 'Failed to resume session: ' + error.message });
  }
});

/**
 * Close a chat session
 */
router.delete('/api/chat/session/:id', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const chatSessionManager = req.app.chatSessionManager;

    // Unregister SSE broadcast listeners before closing the session
    unregisterSSEBroadcast(sessionId);

    await chatSessionManager.closeSession(sessionId);
    logger.info(`Chat session closed: ${sessionId}`);
    res.json({ data: { success: true } });
  } catch (error) {
    logger.error(`Error closing chat session: ${error.message}`);
    res.status(500).json({ error: 'Failed to close chat session' });
  }
});

/**
 * List chat sessions for a review (with message counts and live state annotations)
 */
router.get('/api/review/:reviewId/chat/sessions', (req, res) => {
  try {
    const { reviewId } = req.params;
    const chatSessionManager = req.app.chatSessionManager;

    const sessions = chatSessionManager.getSessionsWithMessageCount(parseInt(reviewId, 10));

    // Annotate each session with live state
    const annotated = sessions.map((s) => ({
      ...s,
      isActive: chatSessionManager.isSessionActive(s.id),
      isResumable: !chatSessionManager.isSessionActive(s.id) && !!s.agent_session_id
    }));

    res.json({ data: { sessions: annotated } });
  } catch (error) {
    logger.error(`Error fetching chat sessions: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch chat sessions' });
  }
});

module.exports = router;

// Expose internals for testing
module.exports._sseClients = sseClients;
module.exports._sseUnsubscribers = sseUnsubscribers;
