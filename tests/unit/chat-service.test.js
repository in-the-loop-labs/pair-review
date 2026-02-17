// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDatabase } from '../utils/schema.js';

const database = require('../../src/database.js');
const { run, queryOne, ChatRepository, CommentRepository, AnalysisRunRepository } = database;

// Mock logger to suppress output
const logger = require('../../src/utils/logger');
vi.spyOn(logger, 'info').mockImplementation(() => {});
vi.spyOn(logger, 'debug').mockImplementation(() => {});
vi.spyOn(logger, 'warn').mockImplementation(() => {});
vi.spyOn(logger, 'error').mockImplementation(() => {});

// Mock createProvider on the AI module
const aiModule = require('../../src/ai/index');
vi.spyOn(aiModule, 'createProvider');

const { ChatService } = require('../../src/services/chat-service');
const fs = require('fs').promises;

describe('ChatService', () => {
  let db;
  let chatRepo;
  let commentRepo;
  let analysisRunRepo;
  let chatService;

  // Seed helpers
  async function seedReview(id = 1) {
    await run(db, `
      INSERT OR IGNORE INTO reviews (id, repository, status)
      VALUES (?, 'test/repo', 'draft')
    `, [id]);
    return id;
  }

  async function seedAnalysisRun(reviewId = 1, runId = 'run-1', provider = 'claude', model = 'opus') {
    await seedReview(reviewId);
    await run(db, `
      INSERT INTO analysis_runs (id, review_id, provider, model, status)
      VALUES (?, ?, ?, ?, 'completed')
    `, [runId, reviewId, provider, model]);
    return runId;
  }

  async function seedComment(opts = {}) {
    const {
      reviewId = 1, source = 'ai', file = 'src/utils.js',
      lineStart = 10, lineEnd = 15, body = 'Consider refactoring',
      type = 'improvement', title = 'Refactor suggestion',
      aiRunId = null, parentId = null, isFileLevel = 0
    } = opts;

    await seedReview(reviewId);

    const result = await run(db, `
      INSERT INTO comments (review_id, source, file, line_start, line_end, body, status, type, title, ai_run_id, parent_id, is_file_level)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `, [reviewId, source, file, lineStart, lineEnd, body, type, title, aiRunId, parentId, isFileLevel]);

    return result.lastID;
  }

  beforeEach(async () => {
    db = await createTestDatabase();
    chatRepo = new ChatRepository(db);
    commentRepo = new CommentRepository(db);
    analysisRunRepo = new AnalysisRunRepository(db);
    chatService = new ChatService(db, chatRepo, commentRepo, analysisRunRepo);

    // Reset mocks
    vi.clearAllMocks();
  });

  describe('startChatSession', () => {
    it('should create a new session for an AI comment', async () => {
      const runId = await seedAnalysisRun(1, 'run-1', 'gemini', 'pro');
      const commentId = await seedComment({ aiRunId: runId });

      const session = await chatService.startChatSession(commentId, '/fake/path');

      expect(session.id).toBeDefined();
      expect(session.comment_id).toBe(commentId);
      expect(session.provider).toBe('gemini');
      expect(session.model).toBe('pro');
      expect(session.status).toBe('active');
      expect(session.comment).toBeDefined();
      expect(session.comment.id).toBe(commentId);
    });

    it('should fallback to claude/opus when no analysis run exists', async () => {
      const commentId = await seedComment({ aiRunId: null });

      const session = await chatService.startChatSession(commentId, '/fake/path');

      expect(session.provider).toBe('claude');
      expect(session.model).toBe('opus');
    });

    it('should respect provider/model overrides', async () => {
      const commentId = await seedComment();

      const session = await chatService.startChatSession(commentId, '/fake/path', {
        provider: 'codex',
        model: 'gpt-4'
      });

      expect(session.provider).toBe('codex');
      expect(session.model).toBe('gpt-4');
    });

    it('should throw when comment not found', async () => {
      await expect(
        chatService.startChatSession(999, '/fake/path')
      ).rejects.toThrow('Comment not found: 999');
    });

    it('should reuse parent session for adopted comments', async () => {
      const parentId = await seedComment({ source: 'ai' });

      // Create a session on the parent
      await chatRepo.createSession('parent-session', parentId, null, 'claude', 'opus');

      // Create an adopted child comment
      const childId = await seedComment({
        source: 'user', parentId, body: 'Adopted text'
      });

      const session = await chatService.startChatSession(childId, '/fake/path');

      expect(session.id).toBe('parent-session');
    });

    it('should create new session for adopted comment when parent has no sessions', async () => {
      const parentId = await seedComment({ source: 'ai' });
      const childId = await seedComment({ source: 'user', parentId });

      const session = await chatService.startChatSession(childId, '/fake/path');

      expect(session.id).not.toBe(undefined);
      expect(session.comment_id).toBe(childId);
    });

    it('should resolve provider from parent analysis run for adopted comments', async () => {
      const runId = await seedAnalysisRun(1, 'run-1', 'gemini', 'flash');
      const parentId = await seedComment({ source: 'ai', aiRunId: runId });
      const childId = await seedComment({ source: 'user', parentId, aiRunId: null });

      const session = await chatService.startChatSession(childId, '/fake/path');

      expect(session.provider).toBe('gemini');
      expect(session.model).toBe('flash');
    });
  });

  describe('sendMessage', () => {
    let commentId;
    let sessionId;
    const mockProvider = { execute: vi.fn() };

    beforeEach(async () => {
      commentId = await seedComment();
      const session = await chatRepo.createSession('test-session', commentId, null, 'claude', 'opus');
      sessionId = session.id;

      aiModule.createProvider.mockReturnValue(mockProvider);
    });

    it('should send a message and return AI response', async () => {
      mockProvider.execute.mockResolvedValue({ raw: 'This is the AI response' });

      // Mock file read for code snippet
      vi.spyOn(fs, 'readFile').mockResolvedValue('line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\nline13\nline14\nline15\nline16\nline17\nline18\nline19\nline20');

      const result = await chatService.sendMessage(sessionId, 'Why is this important?', '/fake/worktree');

      expect(result.response).toBe('This is the AI response');
      expect(result.messageId).toBeDefined();
      expect(result.sessionId).toBe(sessionId);
    });

    it('should persist both user and assistant messages', async () => {
      mockProvider.execute.mockResolvedValue({ raw: 'Response' });
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      await chatService.sendMessage(sessionId, 'Question', '/fake/worktree');

      const messages = await chatRepo.getMessages(sessionId);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Question');
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].content).toBe('Response');
    });

    it('should call onStreamEvent for streaming chunks', async () => {
      mockProvider.execute.mockImplementation(async (prompt, opts) => {
        if (opts.onStreamEvent) {
          opts.onStreamEvent({ type: 'assistant_text', text: 'chunk1' });
          opts.onStreamEvent({ type: 'assistant_text', text: 'chunk2' });
        }
        return { raw: 'Full response' };
      });
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      const streamEvents = [];
      await chatService.sendMessage(sessionId, 'Hi', '/fake/worktree', {
        onStreamEvent: (event) => streamEvents.push(event)
      });

      expect(streamEvents).toHaveLength(2);
      expect(streamEvents[0].text).toBe('chunk1');
      expect(streamEvents[1].text).toBe('chunk2');
    });

    it('should throw when session not found', async () => {
      await expect(
        chatService.sendMessage('non-existent', 'Hello', '/fake')
      ).rejects.toThrow('Chat session not found');
    });

    it('should pass correct options to provider.execute', async () => {
      mockProvider.execute.mockResolvedValue({ raw: 'OK' });
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      await chatService.sendMessage(sessionId, 'Test', '/fake/worktree');

      expect(aiModule.createProvider).toHaveBeenCalledWith('claude', 'opus');
      expect(mockProvider.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          cwd: '/fake/worktree',
          timeout: 120000,
          level: 'chat',
          skipJsonExtraction: true
        })
      );
    });

    // Response extraction fallback chain tests
    it('should extract response from result.raw', async () => {
      mockProvider.execute.mockResolvedValue({ raw: 'Raw response' });
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      const result = await chatService.sendMessage(sessionId, 'Q', '/fake');
      expect(result.response).toBe('Raw response');
    });

    it('should extract response from result.textContent', async () => {
      mockProvider.execute.mockResolvedValue({ textContent: 'Text content response' });
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      const result = await chatService.sendMessage(sessionId, 'Q', '/fake');
      expect(result.response).toBe('Text content response');
    });

    it('should extract response from direct string', async () => {
      mockProvider.execute.mockResolvedValue('Direct string');
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      const result = await chatService.sendMessage(sessionId, 'Q', '/fake');
      expect(result.response).toBe('Direct string');
    });

    it('should extract response from result.data wrapper', async () => {
      mockProvider.execute.mockResolvedValue({ success: true, data: { response: 'Wrapped response' } });
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      const result = await chatService.sendMessage(sessionId, 'Q', '/fake');
      expect(result.response).toBe('Wrapped response');
    });

    it('should extract response from text-like properties', async () => {
      mockProvider.execute.mockResolvedValue({ answer: 'Answer text' });
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      const result = await chatService.sendMessage(sessionId, 'Q', '/fake');
      expect(result.response).toBe('Answer text');
    });

    it('should handle AI execution error', async () => {
      mockProvider.execute.mockRejectedValue(new Error('API timeout'));
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      await expect(
        chatService.sendMessage(sessionId, 'Q', '/fake')
      ).rejects.toThrow('API timeout');

      // Should still persist messages (user + error response)
      const messages = await chatRepo.getMessages(sessionId);
      expect(messages).toHaveLength(2);
      expect(messages[1].content).toContain('Error: API timeout');

      // Session status should be updated to error
      const session = await chatRepo.getSession(sessionId);
      expect(session.status).toBe('error');
    });

    it('should throw when no response can be extracted', async () => {
      mockProvider.execute.mockResolvedValue({});
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      await expect(
        chatService.sendMessage(sessionId, 'Q', '/fake')
      ).rejects.toThrow('No response from AI provider');
    });
  });

  describe('_buildChatPrompt', () => {
    it('should include comment context in prompt', async () => {
      const comment = {
        file: 'src/utils.js', line_start: 10, line_end: 15,
        type: 'improvement', source: 'ai', title: 'Refactor', body: 'Consider refactoring', id: 1
      };

      vi.spyOn(fs, 'readFile').mockResolvedValue('line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\nline13\nline14\nline15\nline16\nline17\nline18\nline19\nline20');

      const prompt = await chatService._buildChatPrompt(comment, [], 'Why?', '/fake');

      expect(prompt).toContain('File: src/utils.js');
      expect(prompt).toContain('Lines: 10-15');
      expect(prompt).toContain('Type: improvement (ai)');
      expect(prompt).toContain('Title: Refactor');
      expect(prompt).toContain('Body: Consider refactoring');
      expect(prompt).toContain('Why?');
    });

    it('should include conversation history', async () => {
      const comment = { file: 'test.js', line_start: 5, body: 'Test', id: 1 };
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      const messages = [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' }
      ];

      const prompt = await chatService._buildChatPrompt(comment, messages, 'Follow-up?', '/fake');

      expect(prompt).toContain('Conversation History');
      expect(prompt).toContain('Human: First question');
      expect(prompt).toContain('Assistant: First answer');
    });

    it('should omit conversation history section when empty', async () => {
      const comment = { file: 'test.js', line_start: 5, body: 'Test', id: 1 };
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      const prompt = await chatService._buildChatPrompt(comment, [], 'First question', '/fake');

      expect(prompt).not.toContain('Conversation History');
    });

    it('should handle file-level comments', async () => {
      const comment = {
        file: 'test.js', line_start: null, line_end: null,
        body: 'File-level comment', id: 1, is_file_level: 1
      };
      vi.spyOn(fs, 'readFile').mockResolvedValue('line1\nline2\nline3');

      const prompt = await chatService._buildChatPrompt(comment, [], 'Why?', '/fake');

      expect(prompt).toContain('Scope: File-level comment');
      expect(prompt).not.toContain('Lines:');
    });

    it('should include adoption context when AI suggestion was adopted and edited', async () => {
      const parentId = await seedComment({ source: 'ai', body: 'Original suggestion' });
      // Create adopted child with edited text
      await seedComment({ source: 'user', parentId, body: 'Edited version' });

      const comment = await commentRepo.getComment(parentId);
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      const prompt = await chatService._buildChatPrompt(comment, [], 'What changed?', '/fake');

      expect(prompt).toContain('Adoption Context');
      expect(prompt).toContain('adopted as a user comment and edited');
      expect(prompt).toContain('Edited version');
    });

    it('should note adoption without edit when text is unchanged', async () => {
      const body = 'Same suggestion text';
      const parentId = await seedComment({ source: 'ai', body });
      await seedComment({ source: 'user', parentId, body });

      const comment = await commentRepo.getComment(parentId);
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      const prompt = await chatService._buildChatPrompt(comment, [], 'Thoughts?', '/fake');

      expect(prompt).toContain('Adoption Context');
      expect(prompt).toContain('kept as-is');
    });

    it('should not include adoption context for non-AI comments', async () => {
      const comment = {
        file: 'test.js', line_start: 5, body: 'User comment',
        source: 'user', id: 999
      };
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      const prompt = await chatService._buildChatPrompt(comment, [], 'Question', '/fake');

      expect(prompt).not.toContain('Adoption Context');
    });
  });

  describe('_getCodeSnippet', () => {
    it('should return code with line numbers and markers for affected lines', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      vi.spyOn(fs, 'readFile').mockResolvedValue(lines.join('\n'));

      const comment = { file: 'test.js', line_start: 10, line_end: 12 };
      const snippet = await chatService._getCodeSnippet(comment, '/fake');

      // Should include 5 lines before (5-9) and 5 lines after (13-17)
      expect(snippet).toContain('line 5');
      expect(snippet).toContain('line 17');

      // Affected lines should have arrow markers
      expect(snippet).toContain('→ line 10');
      expect(snippet).toContain('→ line 11');
      expect(snippet).toContain('→ line 12');

      // Non-affected lines should have space markers
      expect(snippet).toMatch(/\d+\s+line 5/);
    });

    it('should handle file-level comments with first 50 lines', async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
      vi.spyOn(fs, 'readFile').mockResolvedValue(lines.join('\n'));

      const comment = { file: 'test.js', line_start: null };
      const snippet = await chatService._getCodeSnippet(comment, '/fake');

      expect(snippet).toContain('line 1');
      expect(snippet).toContain('line 50');
      expect(snippet).toContain('50 more lines');
      expect(snippet).not.toContain('line 51');
    });

    it('should handle file-level comments for small files', async () => {
      vi.spyOn(fs, 'readFile').mockResolvedValue('line 1\nline 2\nline 3');

      const comment = { file: 'test.js', line_start: null };
      const snippet = await chatService._getCodeSnippet(comment, '/fake');

      expect(snippet).toContain('line 1');
      expect(snippet).toContain('line 3');
      expect(snippet).not.toContain('more lines');
    });

    it('should handle missing file gracefully', async () => {
      vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('ENOENT: no such file'));

      const comment = { file: 'missing.js', line_start: 5 };
      const snippet = await chatService._getCodeSnippet(comment, '/fake');

      expect(snippet).toContain('Could not read file');
    });

    it('should return placeholder for comment with no file', async () => {
      const comment = { file: null, line_start: null };
      const snippet = await chatService._getCodeSnippet(comment, '/fake');

      expect(snippet).toContain('No specific file');
    });

    it('should clamp to beginning of file when line_start is near start', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      vi.spyOn(fs, 'readFile').mockResolvedValue(lines.join('\n'));

      const comment = { file: 'test.js', line_start: 2, line_end: 2 };
      const snippet = await chatService._getCodeSnippet(comment, '/fake');

      // Should start from line 1 (clamped, not negative)
      expect(snippet).toContain('line 1');
      expect(snippet).toContain('→ line 2');
    });
  });

  describe('_getLanguageForExtension', () => {
    it('should map common extensions', () => {
      expect(chatService._getLanguageForExtension('js')).toBe('javascript');
      expect(chatService._getLanguageForExtension('ts')).toBe('typescript');
      expect(chatService._getLanguageForExtension('py')).toBe('python');
      expect(chatService._getLanguageForExtension('go')).toBe('go');
      expect(chatService._getLanguageForExtension('rb')).toBe('ruby');
      expect(chatService._getLanguageForExtension('rs')).toBe('rust');
    });

    it('should return extension as-is for unknown extensions', () => {
      expect(chatService._getLanguageForExtension('xyz')).toBe('xyz');
    });

    it('should return empty string for empty input', () => {
      expect(chatService._getLanguageForExtension('')).toBe('');
    });
  });

  describe('_formatJsonAsMarkdown', () => {
    it('should extract text-like properties first', () => {
      const result = chatService._formatJsonAsMarkdown({ response: 'Hello world', extra: 'data' });
      expect(result).toContain('Hello world');
      expect(result).toContain('**extra:** data');
    });

    it('should format arrays as bullet lists', () => {
      const result = chatService._formatJsonAsMarkdown({ items: ['a', 'b', 'c'] });
      expect(result).toContain('- a');
      expect(result).toContain('- b');
      expect(result).toContain('- c');
    });

    it('should handle null/undefined input', () => {
      expect(chatService._formatJsonAsMarkdown(null)).toBe('null');
      expect(chatService._formatJsonAsMarkdown(undefined)).toBe('undefined');
    });

    it('should format nested objects as JSON', () => {
      const result = chatService._formatJsonAsMarkdown({ meta: { key: 'value' } });
      expect(result).toContain('**meta:**');
      expect(result).toContain('"key"');
    });

    it('should convert camelCase keys to readable format', () => {
      const result = chatService._formatJsonAsMarkdown({ someKeyName: 'value' });
      expect(result).toContain('some Key Name');
    });
  });

  describe('generateRefinedSuggestion', () => {
    const mockProvider = { execute: vi.fn() };

    beforeEach(() => {
      aiModule.createProvider.mockReturnValue(mockProvider);
    });

    it('should generate a refined suggestion', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');
      await chatRepo.addMessage('session-1', 'user', 'Can you make this clearer?');
      await chatRepo.addMessage('session-1', 'assistant', 'Sure, here is a clearer version...');

      mockProvider.execute.mockResolvedValue({ raw: 'Refined suggestion text' });
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      const result = await chatService.generateRefinedSuggestion('session-1', '/fake');

      expect(result.refinedText).toBe('Refined suggestion text');
      expect(result.originalComment).toBeDefined();
      expect(result.sessionId).toBe('session-1');
    });

    it('should trim whitespace from refined text', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      mockProvider.execute.mockResolvedValue({ raw: '  Trimmed text  \n' });
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      const result = await chatService.generateRefinedSuggestion('session-1', '/fake');
      expect(result.refinedText).toBe('Trimmed text');
    });

    it('should throw when session not found', async () => {
      await expect(
        chatService.generateRefinedSuggestion('non-existent', '/fake')
      ).rejects.toThrow('Chat session not found');
    });

    it('should throw when refined text is empty', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      mockProvider.execute.mockResolvedValue({ raw: '' });
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      await expect(
        chatService.generateRefinedSuggestion('session-1', '/fake')
      ).rejects.toThrow('Failed to generate refined suggestion');
    });

    it('should not persist messages to chat history', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      mockProvider.execute.mockResolvedValue({ raw: 'Refined' });
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      await chatService.generateRefinedSuggestion('session-1', '/fake');

      const messages = await chatRepo.getMessages('session-1');
      expect(messages).toHaveLength(0);
    });

    it('should pass shorter timeout for refinement', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      mockProvider.execute.mockResolvedValue({ raw: 'Refined' });
      vi.spyOn(fs, 'readFile').mockResolvedValue('code');

      await chatService.generateRefinedSuggestion('session-1', '/fake');

      expect(mockProvider.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeout: 60000 })
      );
    });
  });

  describe('getChatSessions', () => {
    it('should return sessions for a comment', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');

      const { sessions, resolvedCommentId } = await chatService.getChatSessions(commentId);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('session-1');
      expect(resolvedCommentId).toBe(commentId);
    });

    it('should return parent sessions for adopted comments', async () => {
      const parentId = await seedComment({ source: 'ai' });
      await chatRepo.createSession('parent-session', parentId, null, 'claude', 'opus');

      const childId = await seedComment({ source: 'user', parentId });

      const { sessions, resolvedCommentId } = await chatService.getChatSessions(childId);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('parent-session');
      expect(resolvedCommentId).toBe(parentId);
    });

    it('should return empty when no sessions exist on comment or parent', async () => {
      const commentId = await seedComment();

      const { sessions, resolvedCommentId } = await chatService.getChatSessions(commentId);

      expect(sessions).toEqual([]);
      expect(resolvedCommentId).toBe(commentId);
    });

    it('should prefer own sessions over parent sessions', async () => {
      const parentId = await seedComment({ source: 'ai' });
      await chatRepo.createSession('parent-session', parentId, null, 'claude', 'opus');

      const childId = await seedComment({ source: 'user', parentId });
      await chatRepo.createSession('child-session', childId, null, 'claude', 'opus');

      const { sessions, resolvedCommentId } = await chatService.getChatSessions(childId);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('child-session');
      expect(resolvedCommentId).toBe(childId);
    });
  });

  describe('getChatSessionWithMessages', () => {
    it('should delegate to chatRepo.getSessionWithMessages', async () => {
      const commentId = await seedComment();
      await chatRepo.createSession('session-1', commentId, null, 'claude', 'opus');
      await chatRepo.addMessage('session-1', 'user', 'Hello');

      const result = await chatService.getChatSessionWithMessages('session-1');

      expect(result).toBeDefined();
      expect(result.id).toBe('session-1');
      expect(result.messages).toHaveLength(1);
    });

    it('should return null for non-existent session', async () => {
      const result = await chatService.getChatSessionWithMessages('non-existent');
      expect(result).toBeFalsy();
    });
  });
});
