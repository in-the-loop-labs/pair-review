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
const path = require('path');
const { queryOne, query, AnalysisRunRepository, RepoSettingsRepository } = require('../database');
const { buildChatPrompt, buildInitialContext } = require('../chat/prompt-builder');
const { GitWorktreeManager } = require('../git/worktree');
const logger = require('../utils/logger');
const ws = require('../ws');

const pairReviewSkillPath = path.resolve(__dirname, '../../.pi/skills/pair-review-api/SKILL.md');

const router = express.Router();

/**
 * Resolve the working directory for a chat session.
 * - Local reviews: use review.local_path (the git root being reviewed)
 * - PR reviews: look up the worktree path from the worktrees table
 * @param {Object} db - Database instance
 * @param {Object} review - Review record from the database
 * @returns {Promise<string|null>} Absolute path to the code directory, or null
 */
async function resolveReviewCwd(db, review) {
  // Local reviews store the path directly
  if (review.local_path) {
    return review.local_path;
  }

  // PR reviews: resolve worktree via the worktree manager
  if (review.pr_number && review.repository) {
    const [owner, repo] = review.repository.split('/');
    if (owner && repo) {
      const worktreeManager = new GitWorktreeManager(db);
      return worktreeManager.getWorktreePath({ owner, repo, number: review.pr_number });
    }
  }

  return null;
}

/**
 * Fetch PR data (base_sha, head_sha) from pr_metadata for a PR review.
 * Returns null for local reviews or if pr_data is unavailable.
 * @param {Object} db - Database instance
 * @param {Object} review - Review record from the database
 * @returns {Promise<Object|null>} Parsed PR data with base_sha/head_sha, or null
 */
async function fetchPrData(db, review) {
  if (review.review_type === 'local' || !review.pr_number || !review.repository) {
    return null;
  }
  const row = await queryOne(db, `
    SELECT pr_data FROM pr_metadata
    WHERE pr_number = ? AND repository = ? COLLATE NOCASE
  `, [review.pr_number, review.repository]);
  if (row?.pr_data) {
    try {
      return JSON.parse(row.pr_data);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Unsubscribe functions for SSE broadcast listeners, keyed by session ID.
 * Each value is an array of unsubscribe functions returned by the on* methods.
 * Used to clean up listeners when a session is closed.
 * @type {Map<number, function[]>}
 */
const sseUnsubscribers = new Map();

/**
 * Build a regex that matches bash commands curling the pair-review
 * server's own API on a specific port.  The port is required so we
 * don't accidentally suppress tool badges for unrelated local services.
 * @param {number} port - The server's listening port
 * @returns {RegExp}
 */
function buildPairReviewApiRe(port) {
  return new RegExp(`\\bcurl\\b.*\\bhttps?://(?:localhost|127\\.0\\.0\\.1):${port}/api/`);
}

/**
 * Broadcast a chat event via WebSocket to all clients subscribed to `chat:{sessionId}`.
 * @param {number} sessionId - Chat session ID to include in the event
 * @param {Object} payload - Event data (will be merged with sessionId)
 */
function broadcastSSE(sessionId, payload) {
  ws.broadcast('chat:' + sessionId, { ...payload, sessionId });
}

/**
 * Register SSE broadcast listeners on a chat session so that all events
 * (delta, tool_use, complete, status, error) are forwarded to connected SSE clients.
 * @param {Object} chatSessionManager
 * @param {number} sessionId
 * @param {number} port - The server's listening port (used to scope API-call suppression)
 */
function registerSSEBroadcast(chatSessionManager, sessionId, port) {
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

    const hiddenToolCallIds = new Set();
    const pairReviewApiRe = buildPairReviewApiRe(port);

    unsubs.push(chatSessionManager.onToolUse(sessionId, (data) => {
      // Suppress tool badges for curl commands hitting the pair-review API
      if (data.toolName?.toLowerCase() === 'bash') {
        if (data.status === 'start' && pairReviewApiRe.test(data.args?.command || '')) {
          hiddenToolCallIds.add(data.toolCallId);
          return;
        }
        if (hiddenToolCallIds.has(data.toolCallId)) {
          if (data.status === 'end') hiddenToolCallIds.delete(data.toolCallId);
          return;
        }
      }

      // Suppress tool badges for reading the API skill file
      if (data.toolName?.toLowerCase() === 'read') {
        const readPath = data.args?.path || data.args?.file_path || '';
        if (readPath.endsWith('pair-review-api/SKILL.md')) {
          hiddenToolCallIds.add(data.toolCallId);
          return;
        }
      }

      // Suppress follow-up events (update/end) for any hidden tool call
      if (hiddenToolCallIds.has(data.toolCallId)) {
        if (data.status === 'end') hiddenToolCallIds.delete(data.toolCallId);
        return;
      }

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
 * Fetch chat instructions from repo settings for a review.
 * @param {Database} db - Database instance
 * @param {Object} review - Review record with repository field
 * @returns {Promise<string|null>} Chat instructions or null
 */
async function getChatInstructions(db, review) {
  if (!review || !review.repository) return null;
  const repoSettingsRepo = new RepoSettingsRepository(db);
  const repoSettings = await repoSettingsRepo.getRepoSettings(review.repository);
  return repoSettings ? repoSettings.default_chat_instructions : null;
}

/**
 * Create a new chat session
 */
router.post('/api/chat/session', async (req, res) => {
  try {
    // contextCommentId: stored in session metadata (no longer used for prompt enrichment)
    const { provider, model, contextCommentId, systemPrompt, cwd, skipAnalysisContext } = req.body || {};
    const reviewId = parseInt(req.body?.reviewId, 10);

    if (!provider || !reviewId || isNaN(reviewId)) {
      return res.status(400).json({
        error: 'Missing required fields: provider, reviewId'
      });
    }

    const chatSessionManager = req.app.chatSessionManager;
    const db = req.app.get('db');

    // Always load the review so we can resolve the worktree CWD
    const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [reviewId]);
    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // Build system prompt if not provided directly
    let finalSystemPrompt = systemPrompt;
    let initialContext = null;
    let suggestions = null;
    let analysisRun = null;

    if (!finalSystemPrompt) {

      const chatInstructions = await getChatInstructions(db, review);
      const prData = await fetchPrData(db, review);

      finalSystemPrompt = buildChatPrompt({ review, prData, skillPath: pairReviewSkillPath, chatInstructions });

      if (!skipAnalysisContext) {
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

        // Fetch the analysis run record for metadata and summary
        if (suggestions && suggestions.length > 0 && suggestions[0].ai_run_id) {
          const analysisRunRepo = new AnalysisRunRepository(db);
          analysisRun = await analysisRunRepo.getById(suggestions[0].ai_run_id);
        }

        initialContext = buildInitialContext({
          suggestions,
          analysisRun
        });
      }
    }

    // Resolve cwd: explicit from request body, or the review's code directory
    const resolvedCwd = cwd || await resolveReviewCwd(db, review);

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
    registerSSEBroadcast(chatSessionManager, session.id, serverPort);

    const responseData = { id: session.id, status: session.status };

    // Include analysis context metadata so the frontend can show a context indicator
    if (initialContext && suggestions && suggestions.length > 0) {
      responseData.context = {
        suggestionCount: suggestions.length,
        aiRunId: suggestions[0].ai_run_id || null
      };
      // Attach run metadata for richer frontend display
      if (analysisRun) {
        responseData.context.provider = analysisRun.provider || null;
        responseData.context.model = analysisRun.model || null;
        responseData.context.summary = analysisRun.summary || null;
        responseData.context.completedAt = analysisRun.completed_at || null;
        responseData.context.configType = analysisRun.config_type || null;
        responseData.context.parentRunId = analysisRun.parent_run_id || null;
      }
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
    const { content, context, contextData, actionContext } = req.body || {};

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
      const chatInstructions = await getChatInstructions(db, review);
      const prData = await fetchPrData(db, review);

      const systemPrompt = buildChatPrompt({ review, prData, skillPath: pairReviewSkillPath, chatInstructions });
      const cwd = await resolveReviewCwd(db, review);

      try {
        await chatSessionManager.resumeSession(sessionId, { systemPrompt, cwd });
        unregisterSSEBroadcast(sessionId);
        registerSSEBroadcast(chatSessionManager, sessionId, req.socket.localPort);
        logger.info(`[ChatRoute] Auto-resumed session ${sessionId} for message delivery`);
      } catch (err) {
        logger.error(`[ChatRoute] Failed to auto-resume session ${sessionId}: ${err.message}`);
        return res.status(410).json({ error: 'Failed to resume session: ' + err.message });
      }
    }

    logger.debug(`[ChatRoute] Forwarding message to session ${sessionId} (${content.length} chars)`);
    const result = await chatSessionManager.sendMessage(sessionId, content, { context, contextData, actionContext });
    logger.debug(`[ChatRoute] Message stored as ID ${result.id}, awaiting agent response via SSE`);
    res.json({ data: { messageId: result.id } });
  } catch (error) {
    logger.error(`Error sending chat message: ${error.message}`);
    res.status(500).json({ error: 'Failed to send message' });
  }
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
 * Save a context message to a chat session (e.g., analysis context card).
 * Used to persist context cards immediately without waiting for the next user message.
 */
router.post('/api/chat/session/:id/context', (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { contextData } = req.body || {};

    if (!contextData) {
      return res.status(400).json({ error: 'Missing required field: contextData' });
    }

    const chatSessionManager = req.app.chatSessionManager;
    const result = chatSessionManager.saveContextMessage(sessionId, contextData);
    res.json({ data: { messageId: result.id } });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    logger.error(`Error saving context message: ${error.message}`);
    res.status(500).json({ error: 'Failed to save context message' });
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
    const chatInstructions = await getChatInstructions(db, review);
    const prData = await fetchPrData(db, review);

    const systemPrompt = buildChatPrompt({ review, prData, skillPath: pairReviewSkillPath, chatInstructions });
    const cwd = await resolveReviewCwd(db, review);

    await chatSessionManager.resumeSession(sessionId, { systemPrompt, cwd });
    unregisterSSEBroadcast(sessionId);
    registerSSEBroadcast(chatSessionManager, sessionId, req.socket.localPort);

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

/**
 * Get formatted analysis context for a specific run.
 * Returns context text and run metadata so the chat panel can add it as pending context.
 */
router.get('/api/chat/analysis-context/:runId', async (req, res) => {
  try {
    const { runId } = req.params;
    const reviewId = parseInt(req.query.reviewId, 10);

    if (!runId || !reviewId || isNaN(reviewId)) {
      return res.status(400).json({ error: 'Missing required params: runId (path) and reviewId (query)' });
    }

    const db = req.app.get('db');

    // Fetch AI suggestions for this specific run (top-level only: ai_level IS NULL)
    const suggestions = await query(db, `
      SELECT
        id, ai_run_id, ai_level, ai_confidence,
        file, line_start, line_end, type, title, body,
        reasoning, status, is_file_level
      FROM comments
      WHERE review_id = ?
        AND source = 'ai'
        AND ai_level IS NULL
        AND (is_raw = 0 OR is_raw IS NULL)
        AND ai_run_id = ?
      ORDER BY file, line_start
    `, [reviewId, runId]);

    // Fetch the analysis run record for metadata
    const analysisRunRepo = new AnalysisRunRepository(db);
    const analysisRun = await analysisRunRepo.getById(runId);

    const text = buildInitialContext({ suggestions, analysisRun });

    res.json({
      data: {
        text,
        suggestionCount: suggestions ? suggestions.length : 0,
        run: analysisRun ? {
          id: analysisRun.id,
          provider: analysisRun.provider || null,
          model: analysisRun.model || null,
          summary: analysisRun.summary || null,
          completedAt: analysisRun.completed_at || null,
          configType: analysisRun.config_type || null
        } : null
      }
    });
  } catch (error) {
    logger.error(`Error fetching analysis context: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch analysis context' });
  }
});

module.exports = router;

// Expose internals for testing
module.exports._sseUnsubscribers = sseUnsubscribers;
module.exports._buildPairReviewApiRe = buildPairReviewApiRe;
