// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Chat Routes (PR Mode)
 *
 * Handles all chat-related endpoints for PR mode:
 * - Starting chat sessions about comments
 * - Sending messages and getting AI responses
 * - Retrieving conversation history
 * - Server-Sent Events (SSE) for streaming responses
 */

const express = require('express');
const { ChatRepository, CommentRepository, AnalysisRunRepository, WorktreeRepository, queryOne } = require('../database');
const { ChatService } = require('../services/chat-service');
const { normalizeRepository } = require('../utils/paths');
const logger = require('../utils/logger');

const router = express.Router();

// Store active SSE clients for each chat session
// Maps chatSessionId -> Set of response objects
const chatStreamClients = new Map();

/**
 * Start a new chat session about a comment
 * POST /api/chat/start
 * Body: { commentId, provider?, model? }
 */
router.post('/api/chat/start', async (req, res) => {
  try {
    const { commentId, provider, model } = req.body;

    if (!commentId) {
      return res.status(400).json({
        error: 'commentId is required'
      });
    }

    const db = req.app.get('db');
    const chatRepo = new ChatRepository(db);
    const commentRepo = new CommentRepository(db);
    const analysisRunRepo = new AnalysisRunRepository(db);
    const worktreeRepo = new WorktreeRepository(db);

    // Get the comment to find the associated review
    const comment = await commentRepo.getComment(commentId);
    if (!comment) {
      return res.status(404).json({
        error: 'Comment not found'
      });
    }

    // Get the worktree path for this review's PR
    // First, get the review to find the PR number and repository
    const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [comment.review_id]);
    if (!review) {
      return res.status(404).json({
        error: 'Review not found for comment'
      });
    }

    // Get worktree info
    const worktree = await worktreeRepo.findByPR(review.pr_number, review.repository);
    if (!worktree) {
      return res.status(404).json({
        error: 'Worktree not found for this PR'
      });
    }

    // Create the chat service
    const chatService = new ChatService(db, chatRepo, commentRepo, analysisRunRepo);

    // Start the session
    const session = await chatService.startChatSession(
      commentId,
      worktree.path,
      { provider, model }
    );

    logger.info(`Chat session started: ${session.id} for comment ${commentId}`);

    res.json({
      success: true,
      chatId: session.id,
      provider: session.provider,
      model: session.model,
      comment: session.comment
    });

  } catch (error) {
    logger.error('Error starting chat session:', error);
    res.status(500).json({
      error: error.message || 'Failed to start chat session'
    });
  }
});

/**
 * Send a message in a chat session
 * POST /api/chat/:chatId/message
 * Body: { content }
 */
router.post('/api/chat/:chatId/message', async (req, res) => {
  try {
    const { chatId } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({
        error: 'Message content is required'
      });
    }

    const db = req.app.get('db');
    const chatRepo = new ChatRepository(db);
    const commentRepo = new CommentRepository(db);
    const analysisRunRepo = new AnalysisRunRepository(db);
    const worktreeRepo = new WorktreeRepository(db);

    // Get session
    const session = await chatRepo.getSession(chatId);
    if (!session) {
      return res.status(404).json({
        error: 'Chat session not found'
      });
    }

    // Get the comment to find the review and worktree
    const comment = await commentRepo.getComment(session.comment_id);
    if (!comment) {
      return res.status(404).json({
        error: 'Comment not found'
      });
    }

    const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [comment.review_id]);
    if (!review) {
      return res.status(404).json({
        error: 'Review not found'
      });
    }

    const worktree = await worktreeRepo.findByPR(review.pr_number, review.repository);
    if (!worktree) {
      return res.status(404).json({
        error: 'Worktree not found'
      });
    }

    // Create the chat service
    const chatService = new ChatService(db, chatRepo, commentRepo, analysisRunRepo);

    // Send the message (will stream to SSE clients if any are connected)
    const clients = chatStreamClients.get(chatId) || new Set();

    let streamedResponse = '';
    const result = await chatService.sendMessage(
      chatId,
      content,
      worktree.path,
      {
        onStreamEvent: (event) => {
          // Stream to all connected SSE clients
          if (event.type === 'assistant_text' && event.text) {
            streamedResponse += event.text;
            clients.forEach(client => {
              if (!client.closed) {
                client.write(`data: ${JSON.stringify({ type: 'chunk', content: event.text })}\n\n`);
              }
            });
          }
        }
      }
    );

    // Send completion event to SSE clients
    clients.forEach(client => {
      if (!client.closed) {
        client.write(`data: ${JSON.stringify({ type: 'done', messageId: result.messageId })}\n\n`);
      }
    });

    logger.info(`Chat message sent in session ${chatId}`);

    res.json({
      success: true,
      messageId: result.messageId,
      response: result.response
    });

  } catch (error) {
    logger.error('Error sending chat message:', error);

    // Send error event to SSE clients
    const clients = chatStreamClients.get(req.params.chatId) || new Set();
    clients.forEach(client => {
      if (!client.closed) {
        client.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      }
    });

    res.status(500).json({
      error: error.message || 'Failed to send message'
    });
  }
});

/**
 * Get messages for a chat session
 * GET /api/chat/:chatId/messages
 */
router.get('/api/chat/:chatId/messages', async (req, res) => {
  try {
    const { chatId } = req.params;

    const db = req.app.get('db');
    const chatRepo = new ChatRepository(db);

    const sessionWithMessages = await chatRepo.getSessionWithMessages(chatId);

    if (!sessionWithMessages) {
      return res.status(404).json({
        error: 'Chat session not found'
      });
    }

    res.json({
      success: true,
      session: sessionWithMessages
    });

  } catch (error) {
    logger.error('Error fetching chat messages:', error);
    res.status(500).json({
      error: error.message || 'Failed to fetch messages'
    });
  }
});

/**
 * Server-Sent Events (SSE) stream for chat responses
 * GET /api/chat/:chatId/stream
 */
router.get('/api/chat/:chatId/stream', async (req, res) => {
  const { chatId } = req.params;

  try {
    const db = req.app.get('db');
    const chatRepo = new ChatRepository(db);

    // Verify session exists
    const session = await chatRepo.getSession(chatId);
    if (!session) {
      return res.status(404).json({
        error: 'Chat session not found'
      });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add this client to the set for this chat session
    if (!chatStreamClients.has(chatId)) {
      chatStreamClients.set(chatId, new Set());
    }
    chatStreamClients.get(chatId).add(res);

    logger.info(`SSE client connected for chat session ${chatId}`);

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: 'connected', chatId })}\n\n`);

    // Handle client disconnect
    req.on('close', () => {
      const clients = chatStreamClients.get(chatId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) {
          chatStreamClients.delete(chatId);
        }
      }
      logger.info(`SSE client disconnected from chat session ${chatId}`);
    });

  } catch (error) {
    logger.error('Error setting up SSE stream:', error);
    res.status(500).json({
      error: error.message || 'Failed to set up stream'
    });
  }
});

/**
 * Get all chat sessions for a comment
 * GET /api/chat/comment/:commentId/sessions
 */
router.get('/api/chat/comment/:commentId/sessions', async (req, res) => {
  try {
    const { commentId } = req.params;

    const db = req.app.get('db');
    const chatRepo = new ChatRepository(db);
    const commentRepo = new CommentRepository(db);

    // Verify comment exists
    const comment = await commentRepo.getComment(commentId);
    if (!comment) {
      return res.status(404).json({
        error: 'Comment not found'
      });
    }

    const sessions = await chatRepo.getSessionsByComment(commentId);

    res.json({
      success: true,
      sessions
    });

  } catch (error) {
    logger.error('Error fetching chat sessions:', error);
    res.status(500).json({
      error: error.message || 'Failed to fetch chat sessions'
    });
  }
});

module.exports = router;
