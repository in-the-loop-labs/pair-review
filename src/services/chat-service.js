// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * ChatService - Handles AI chat functionality for review comments
 *
 * This service manages AI chat sessions about specific review comments,
 * providing context-aware prompts and streaming responses.
 */

const { createProvider } = require('../ai');
const { v4: uuidv4 } = require('uuid');
const { queryOne } = require('../database');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');

class ChatService {
  /**
   * Create a new ChatService instance
   * @param {Object} db - Database instance
   * @param {Object} chatRepo - ChatRepository instance
   * @param {Object} commentRepo - CommentRepository instance
   * @param {Object} analysisRunRepo - AnalysisRunRepository instance
   */
  constructor(db, chatRepo, commentRepo, analysisRunRepo) {
    this.db = db;
    this.chatRepo = chatRepo;
    this.commentRepo = commentRepo;
    this.analysisRunRepo = analysisRunRepo;
  }

  /**
   * Start a new chat session about a comment
   * @param {number} commentId - Comment ID
   * @param {string} worktreePath - Path to git worktree (for reading code context)
   * @param {Object} options - Additional options
   * @param {string} [options.provider] - Override provider (defaults to comment's analysis provider)
   * @param {string} [options.model] - Override model (defaults to comment's analysis model)
   * @returns {Promise<Object>} Created session with provider/model info
   */
  async startChatSession(commentId, worktreePath, options = {}) {
    // Get the comment from the database
    const comment = await this.commentRepo.getComment(commentId);
    if (!comment) {
      throw new Error(`Comment not found: ${commentId}`);
    }

    // If this comment was adopted from an AI suggestion, check for an existing
    // session on the parent so the conversation continues seamlessly.
    if (comment.parent_id) {
      const parentSessions = await this.chatRepo.getSessionsByComment(comment.parent_id);
      if (parentSessions.length > 0) {
        const existingSession = parentSessions[0];
        logger.info(`Comment ${commentId} adopted from ${comment.parent_id}, reusing session ${existingSession.id}`);
        const parentComment = await this.commentRepo.getComment(comment.parent_id);
        return {
          ...existingSession,
          comment: parentComment || comment
        };
      }
    }

    // Get provider and model from the original analysis run
    let provider = options.provider;
    let model = options.model;

    if (!provider || !model) {
      // For adopted comments, try the parent's analysis run
      const aiRunId = comment.ai_run_id || (comment.parent_id
        ? (await this.commentRepo.getComment(comment.parent_id))?.ai_run_id
        : null);

      if (aiRunId) {
        const analysisRun = await this.analysisRunRepo.getById(aiRunId);
        if (analysisRun) {
          provider = provider || analysisRun.provider || 'claude';
          model = model || analysisRun.model || 'opus';
        }
      }

      // Fallback if no analysis run or missing provider/model
      provider = provider || 'claude';
      model = model || 'opus';
    }

    // Generate session ID
    const sessionId = uuidv4();

    // Create chat session in database
    const session = await this.chatRepo.createSession(
      sessionId,
      commentId,
      comment.ai_run_id,
      provider,
      model
    );

    logger.info(`Started chat session ${sessionId} for comment ${commentId} (${provider}/${model})`);

    return {
      ...session,
      comment
    };
  }

  /**
   * Send a message in a chat session and get AI response
   * @param {string} sessionId - Chat session ID
   * @param {string} userMessage - User's question
   * @param {string} worktreePath - Path to git worktree
   * @param {Object} options - Additional options
   * @param {Function} [options.onStreamEvent] - Callback for streaming events
   * @returns {Promise<Object>} Response with message ID and AI response
   */
  async sendMessage(sessionId, userMessage, worktreePath, options = {}) {
    const { onStreamEvent } = options;

    // Get session
    const session = await this.chatRepo.getSession(sessionId);
    if (!session) {
      throw new Error(`Chat session not found: ${sessionId}`);
    }

    // Get comment
    const comment = await this.commentRepo.getComment(session.comment_id);
    if (!comment) {
      throw new Error(`Comment not found: ${session.comment_id}`);
    }

    // Get conversation history
    const messages = await this.chatRepo.getMessages(sessionId);

    // Add user message to database
    await this.chatRepo.addMessage(sessionId, 'user', userMessage);

    // Build prompt with context
    const prompt = await this._buildChatPrompt(comment, messages, userMessage, worktreePath);

    logger.info(`Sending chat message in session ${sessionId}`);
    logger.debug(`Prompt length: ${prompt.length} characters`);

    // Create AI provider
    const provider = createProvider(session.provider, session.model);

    // Execute AI request
    let aiResponse = '';
    let streamError = null;

    try {
      const result = await provider.execute(prompt, {
        cwd: worktreePath,
        timeout: 120000, // 2 minute timeout for chat (shorter than full analysis)
        level: 'chat',
        skipJsonExtraction: true, // Chat responses are plain text, not JSON
        onStreamEvent: onStreamEvent ? (event) => {
          if (event.type === 'assistant_text' && event.text) {
            // Note: event.text from StreamParser is truncated for display purposes
            // We only use it for SSE progress updates, not for building the full response
            onStreamEvent(event);
          }
        } : null
      });

      // Extract the full response from the result
      // With skipJsonExtraction: true, we always get { raw: string, parsed: false }
      // But we keep the fallback handling for other providers that may not support this option
      //
      // For chat, we want the raw text response, but the LLM fallback may have
      // converted it to JSON. In that case, we need to stringify it back or
      // extract meaningful text from it.

      logger.debug(`Chat result type: ${typeof result}, keys: ${result ? Object.keys(result).join(', ') : 'null'}`);

      if (result.raw) {
        // Non-JSON response - use the raw text content (ideal case for chat)
        aiResponse = result.raw;
        logger.debug('Extracted response from result.raw');
      } else if (result.textContent) {
        // Extracted text content (before JSON extraction was attempted)
        aiResponse = result.textContent;
        logger.debug('Extracted response from result.textContent');
      } else if (typeof result === 'string') {
        // Direct string response
        aiResponse = result;
        logger.debug('Result was a direct string');
      } else if (result && typeof result === 'object') {
        // The LLM fallback succeeded and converted the response to JSON
        // For chat, this is not ideal - we wanted the raw text
        // But we can work with it by either:
        // 1. Using text-like properties if they exist
        // 2. Formatting the JSON object as a readable response

        if (result.success && result.data) {
          // Wrapper format - extract data
          const data = result.data;
          aiResponse = data.response || data.text || data.content || data.message;
          if (!aiResponse && typeof data === 'object') {
            // No text property, format as markdown
            aiResponse = this._formatJsonAsMarkdown(data);
          }
          logger.debug('Extracted response from result.data');
        } else if (result.parsed === false && result.raw) {
          // Explicit raw format
          aiResponse = result.raw;
          logger.debug('Extracted response from result with parsed=false');
        } else {
          // Direct object result (LLM extraction converted our text to structured data)
          // Try to extract text-like properties first
          aiResponse = result.response || result.text || result.content || result.message ||
                       result.answer || result.explanation || result.summary || result.reply;
          if (!aiResponse) {
            // Format the object as a readable response
            aiResponse = this._formatJsonAsMarkdown(result);
          }
          logger.debug(`Extracted from object result, aiResponse length: ${aiResponse ? aiResponse.length : 0}`);
        }
      }

      if (!aiResponse) {
        logger.error(`Failed to extract response. Result: ${JSON.stringify(result).substring(0, 1000)}`);
        throw new Error('No response from AI provider');
      }

      logger.debug(`Chat response received: ${aiResponse.length} characters`);

    } catch (error) {
      logger.error(`Chat AI execution error: ${error.message}`);
      streamError = error;
      aiResponse = `Error: ${error.message}`;

      // Update session status to error
      await this.chatRepo.updateSessionStatus(sessionId, 'error');
    }

    // Add assistant response to database
    const responseMessage = await this.chatRepo.addMessage(sessionId, 'assistant', aiResponse);

    if (streamError) {
      throw streamError;
    }

    return {
      messageId: responseMessage.id,
      response: aiResponse,
      sessionId
    };
  }

  /**
   * Build a chat prompt with comment context and conversation history
   * @private
   * @param {Object} comment - Comment object
   * @param {Array<Object>} messages - Previous messages in conversation
   * @param {string} userQuestion - Current user question
   * @param {string} worktreePath - Path to git worktree
   * @returns {Promise<string>} Complete prompt
   */
  async _buildChatPrompt(comment, messages, userQuestion, worktreePath) {
    // Get code snippet around the comment
    const codeSnippet = await this._getCodeSnippet(comment, worktreePath);

    // Determine language for syntax highlighting
    const fileExt = comment.file ? path.extname(comment.file).slice(1) : '';
    const language = this._getLanguageForExtension(fileExt) || '';

    // Build conversation history
    const conversationHistory = messages.map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`).join('\n\n');

    // Check if this AI suggestion was adopted — the adopted comment may have edited text
    let adoptionContext = '';
    if (comment.source === 'ai') {
      const adoptedComment = await this._getAdoptedChild(comment.id);
      if (adoptedComment) {
        const bodyChanged = adoptedComment.body !== comment.body;
        adoptionContext = `\n## Adoption Context
This AI suggestion was adopted as a user comment${bodyChanged ? ' and edited' : ''}.
${bodyChanged ? `Adopted comment (current): ${adoptedComment.body}` : 'The comment text was kept as-is.'}`;
      }
    }

    // Build the prompt
    const prompt = `You are assisting with a code review follow-up question.

## Original Comment Context
File: ${comment.file || 'N/A'}
${comment.line_start ? `Lines: ${comment.line_start}${comment.line_end && comment.line_end !== comment.line_start ? `-${comment.line_end}` : ''}` : 'Scope: File-level comment (applies to the entire file)'}
Type: ${comment.type || 'comment'} (${comment.source || 'unknown'})${comment.title ? `\nTitle: ${comment.title}` : ''}
Body: ${comment.body || 'No comment body'}${adoptionContext}

## Code Context
\`\`\`${language}
${codeSnippet}
\`\`\`
${conversationHistory ? `
## Conversation History
${conversationHistory}
` : ''}
## Current Question
${userQuestion}

Instructions: Provide concise, actionable answers focused on this specific comment. If asked to refine or improve the suggestion, output the improved comment text clearly. Be helpful and precise.

You are running in a non-interactive browser context. You have read-only access to the codebase via Read and Bash (git, cat, grep, find, rg). You cannot write or modify files, and any tool not pre-approved will be automatically denied. Focus on reading code and reasoning about it rather than attempting modifications.`;

    return prompt;
  }

  /**
   * Get code snippet around a comment's location
   * @private
   * @param {Object} comment - Comment object
   * @param {string} worktreePath - Path to git worktree
   * @returns {Promise<string>} Code snippet
   */
  async _getCodeSnippet(comment, worktreePath) {
    if (!comment.file) {
      return '(No specific file - general comment)';
    }

    const filePath = path.join(worktreePath, comment.file);
    const isFileLevel = !comment.line_start;

    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const lines = fileContent.split('\n');

      if (isFileLevel) {
        // File-level comment: include beginning of file for context, with a note
        // The AI has tool access to read the full file if needed
        const maxLines = 50;
        const snippet = lines.slice(0, maxLines);
        const numberedSnippet = snippet.map((line, idx) => {
          return `${String(idx + 1).padStart(4, ' ')}  ${line}`;
        }).join('\n');
        const truncationNote = lines.length > maxLines
          ? `\n... (${lines.length - maxLines} more lines — use Read tool to see the full file)`
          : '';
        return numberedSnippet + truncationNote;
      }

      // Line-level comment: 5 lines before and after
      const contextLines = 5;
      const startLine = Math.max(0, comment.line_start - 1 - contextLines);
      const endLine = Math.min(lines.length, (comment.line_end || comment.line_start) + contextLines);

      const snippet = lines.slice(startLine, endLine);

      // Add line numbers
      const numberedSnippet = snippet.map((line, idx) => {
        const lineNum = startLine + idx + 1;
        const marker = lineNum >= comment.line_start && lineNum <= (comment.line_end || comment.line_start) ? '→' : ' ';
        return `${String(lineNum).padStart(4, ' ')}${marker} ${line}`;
      }).join('\n');

      return numberedSnippet;
    } catch (error) {
      logger.warn(`Failed to read code snippet from ${comment.file}: ${error.message}`);
      return `(Could not read file: ${error.message})`;
    }
  }

  /**
   * Get language identifier for syntax highlighting
   * @private
   * @param {string} extension - File extension
   * @returns {string} Language identifier
   */
  _getLanguageForExtension(extension) {
    const languageMap = {
      js: 'javascript',
      jsx: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      py: 'python',
      rb: 'ruby',
      go: 'go',
      rs: 'rust',
      java: 'java',
      c: 'c',
      cpp: 'cpp',
      h: 'c',
      hpp: 'cpp',
      cs: 'csharp',
      php: 'php',
      sh: 'bash',
      md: 'markdown',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      xml: 'xml',
      html: 'html',
      css: 'css',
      scss: 'scss',
      sql: 'sql'
    };

    return languageMap[extension] || extension;
  }

  /**
   * Format a JSON object as readable markdown
   * Used when the LLM extraction converts a text response to structured data
   * @private
   * @param {Object} obj - JSON object to format
   * @returns {string} Markdown-formatted string
   */
  _formatJsonAsMarkdown(obj) {
    if (!obj || typeof obj !== 'object') {
      return String(obj);
    }

    const lines = [];

    // Handle common text-like properties first
    const textProps = ['response', 'text', 'content', 'message', 'answer', 'explanation', 'summary'];
    for (const prop of textProps) {
      if (obj[prop] && typeof obj[prop] === 'string') {
        lines.push(obj[prop]);
        delete obj[prop]; // Remove so we don't duplicate below
      }
    }

    // Format remaining properties
    const remainingKeys = Object.keys(obj).filter(k => obj[k] !== undefined);
    if (remainingKeys.length > 0 && lines.length > 0) {
      lines.push(''); // Add spacing
    }

    for (const key of remainingKeys) {
      const value = obj[key];
      const formattedKey = key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

      if (Array.isArray(value)) {
        if (value.length > 0) {
          lines.push(`**${formattedKey}:**`);
          for (const item of value) {
            if (typeof item === 'string') {
              lines.push(`- ${item}`);
            } else if (typeof item === 'object') {
              lines.push(`- ${JSON.stringify(item)}`);
            }
          }
        }
      } else if (typeof value === 'object' && value !== null) {
        lines.push(`**${formattedKey}:** ${JSON.stringify(value)}`);
      } else if (value !== null && value !== undefined) {
        lines.push(`**${formattedKey}:** ${value}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate a refined version of an AI suggestion based on the chat conversation
   * @param {string} sessionId - Chat session ID
   * @param {string} worktreePath - Path to git worktree
   * @returns {Promise<Object>} Object with refinedText
   */
  async generateRefinedSuggestion(sessionId, worktreePath) {
    // Get session
    const session = await this.chatRepo.getSession(sessionId);
    if (!session) {
      throw new Error(`Chat session not found: ${sessionId}`);
    }

    // Get comment
    const comment = await this.commentRepo.getComment(session.comment_id);
    if (!comment) {
      throw new Error(`Comment not found: ${session.comment_id}`);
    }

    // Get conversation history
    const messages = await this.chatRepo.getMessages(sessionId);

    // Get code snippet
    const codeSnippet = await this._getCodeSnippet(comment, worktreePath);
    const fileExt = comment.file ? path.extname(comment.file).slice(1) : '';
    const language = this._getLanguageForExtension(fileExt) || '';

    // Build conversation history for context
    const conversationHistory = messages.map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`).join('\n\n');

    // Build prompt for refinement
    const prompt = `You are helping to refine a code review comment based on a conversation.

## Original Suggestion
File: ${comment.file || 'N/A'}
Lines: ${comment.line_start || 'N/A'}${comment.line_end && comment.line_end !== comment.line_start ? `-${comment.line_end}` : ''}
Type: ${comment.type || 'comment'}
${comment.title ? `Title: ${comment.title}\n` : ''}
Original Body:
${comment.body || 'No comment body'}

## Code Context
\`\`\`${language}
${codeSnippet}
\`\`\`

## Conversation
${conversationHistory}

## Task
Based on the conversation above, generate a refined and improved version of the code review comment. The refined comment should:
1. Incorporate any feedback, corrections, or improvements discussed
2. Be clear, concise, and actionable
3. Maintain the same general intent as the original
4. Be suitable for posting as a GitHub review comment

Output ONLY the refined comment text. Do not include any preamble, explanation, or formatting markers. Just the final comment text that should be posted.`;

    logger.info(`Generating refined suggestion for session ${sessionId}`);

    // Create AI provider
    const provider = createProvider(session.provider, session.model);

    // Execute AI request
    const result = await provider.execute(prompt, {
      cwd: worktreePath,
      timeout: 60000,
      level: 'chat',
      skipJsonExtraction: true
    });

    // Extract the refined text
    let refinedText = '';
    if (result.raw) {
      refinedText = result.raw.trim();
    } else if (typeof result === 'string') {
      refinedText = result.trim();
    } else if (result.response || result.text || result.content) {
      refinedText = (result.response || result.text || result.content).trim();
    }

    if (!refinedText) {
      throw new Error('Failed to generate refined suggestion');
    }

    logger.info(`Generated refined suggestion: ${refinedText.length} characters`);

    // Note: We intentionally don't persist the refinement exchange to chat history.
    // The adoption closes the panel, and showing "[System: ...]" messages in the
    // conversation on reopen is confusing. The refined text is returned to the caller.

    return {
      refinedText,
      originalComment: comment,
      sessionId
    };
  }

  /**
   * Get all chat sessions for a comment.
   * If the comment has a parent_id (adopted suggestion) and no sessions of its own,
   * returns the parent's sessions so the conversation continues seamlessly.
   * @param {number} commentId - Comment ID
   * @returns {Promise<{sessions: Array<Object>, resolvedCommentId: number}>}
   */
  async getChatSessions(commentId) {
    const sessions = await this.chatRepo.getSessionsByComment(commentId);
    if (sessions.length > 0) {
      return { sessions, resolvedCommentId: commentId };
    }

    // Check if this comment was adopted from a parent (AI suggestion)
    const comment = await this.commentRepo.getComment(commentId);
    if (comment?.parent_id) {
      const parentSessions = await this.chatRepo.getSessionsByComment(comment.parent_id);
      if (parentSessions.length > 0) {
        logger.info(`Comment ${commentId} has no sessions, using parent ${comment.parent_id} sessions`);
        return { sessions: parentSessions, resolvedCommentId: comment.parent_id };
      }
    }

    return { sessions: [], resolvedCommentId: commentId };
  }

  /**
   * Get a chat session with its messages
   * @param {string} sessionId - Chat session ID
   * @returns {Promise<Object|null>} Session with messages
   */
  async getChatSessionWithMessages(sessionId) {
    return await this.chatRepo.getSessionWithMessages(sessionId);
  }

  /**
   * Find the adopted user comment for an AI suggestion (child with parent_id pointing here)
   * @private
   * @param {number} commentId - The AI suggestion's comment ID
   * @returns {Promise<Object|null>} The adopted comment, or null
   */
  async _getAdoptedChild(commentId) {
    return await queryOne(this.db,
      `SELECT * FROM comments WHERE parent_id = ? AND source = 'user' ORDER BY created_at DESC LIMIT 1`,
      [commentId]
    );
  }
}

module.exports = { ChatService };
