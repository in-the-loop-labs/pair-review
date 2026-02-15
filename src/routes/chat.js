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

    if (!finalSystemPrompt) {
      const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [reviewId]);
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
      const suggestions = await query(db, `
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

    const session = await chatSessionManager.createSession({
      provider,
      model,
      reviewId,
      contextCommentId: contextCommentId || null,
      systemPrompt: finalSystemPrompt,
      cwd: cwd || null,
      initialContext
    });

    logger.info(`Chat session created: ${session.id} (provider=${provider}, model=${model})`);
    res.json({ data: { id: session.id, status: session.status } });
  } catch (error) {
    logger.error(`Error creating chat session: ${error.message}`);
    res.status(500).json({ error: 'Failed to create chat session' });
  }
});

/**
 * Send a user message to a chat session
 */
router.post('/api/chat/session/:id/message', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { content, context, contextData } = req.body || {};

    if (!content) {
      return res.status(400).json({ error: 'Missing required field: content' });
    }

    const chatSessionManager = req.app.chatSessionManager;
    if (!chatSessionManager.isSessionActive(sessionId)) {
      return res.status(404).json({ error: 'Chat session not found or not active' });
    }

    const result = await chatSessionManager.sendMessage(sessionId, content, { context, contextData });
    res.json({ data: { messageId: result.id } });
  } catch (error) {
    logger.error(`Error sending chat message: ${error.message}`);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * SSE stream for real-time chat responses
 */
router.get('/api/chat/session/:id/stream', (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  const chatSessionManager = req.app.chatSessionManager;

  if (!chatSessionManager.isSessionActive(sessionId)) {
    return res.status(404).json({ error: 'Chat session not found or not active' });
  }

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);

  // Register event listeners (session may have closed between DB check and registration)
  let unsubDelta, unsubToolUse, unsubComplete;
  try {
    unsubDelta = chatSessionManager.onDelta(sessionId, (data) => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'delta', text: data.text })}\n\n`);
      } catch {
        // Client disconnected
      }
    });

    unsubToolUse = chatSessionManager.onToolUse(sessionId, (data) => {
      try {
        const event = { type: 'tool_use', toolName: data.toolName, status: data.status };
        if (data.args) {
          event.toolInput = data.args;
        }
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client disconnected
      }
    });

    unsubComplete = chatSessionManager.onComplete(sessionId, (data) => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'complete', messageId: data.messageId })}\n\n`);
      } catch {
        // Client disconnected
      }
    });
  } catch {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Session is no longer active' })}\n\n`);
    res.end();
    return;
  }

  // Handle client disconnect
  const cleanup = () => {
    if (unsubDelta) unsubDelta();
    if (unsubToolUse) unsubToolUse();
    if (unsubComplete) unsubComplete();
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
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
 * Close a chat session
 */
router.delete('/api/chat/session/:id', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const chatSessionManager = req.app.chatSessionManager;

    await chatSessionManager.closeSession(sessionId);
    logger.info(`Chat session closed: ${sessionId}`);
    res.json({ data: { success: true } });
  } catch (error) {
    logger.error(`Error closing chat session: ${error.message}`);
    res.status(500).json({ error: 'Failed to close chat session' });
  }
});

/**
 * List chat sessions for a review
 */
router.get('/api/review/:reviewId/chat/sessions', (req, res) => {
  try {
    const { reviewId } = req.params;
    const chatSessionManager = req.app.chatSessionManager;

    const sessions = chatSessionManager.getSessionsForReview(parseInt(reviewId, 10));
    res.json({ data: { sessions } });
  } catch (error) {
    logger.error(`Error fetching chat sessions: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch chat sessions' });
  }
});

module.exports = router;
