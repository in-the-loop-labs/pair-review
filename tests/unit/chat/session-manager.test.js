// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import { createTestDatabase, closeTestDatabase } from '../../utils/schema.js';

// Mock logger
vi.mock('../../../src/utils/logger', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  section: vi.fn()
}));

// --- Patch PiBridge via require.cache (CJS pattern) ---
// session-manager.js does: const PiBridge = require('./pi-bridge')
// We replace the cached module export before session-manager is loaded.
const piBridgePath = require.resolve('../../../src/chat/pi-bridge');
const originalExport = require(piBridgePath);

// Shared state for controlling mock behavior per-test
let _nextStartFail = false;
const _createdBridges = [];

function MockPiBridge() {
  const bridge = new EventEmitter();
  bridge.start = vi.fn().mockImplementation(() => {
    if (_nextStartFail) {
      _nextStartFail = false;
      return Promise.reject(new Error('spawn failed'));
    }
    return Promise.resolve();
  });
  bridge.close = vi.fn().mockResolvedValue(undefined);
  bridge.sendMessage = vi.fn().mockResolvedValue(undefined);
  bridge.isReady = vi.fn().mockReturnValue(true);
  bridge.isBusy = vi.fn().mockReturnValue(false);
  bridge.abort = vi.fn();
  _createdBridges.push(bridge);
  return bridge;
}

// Replace the cached export
require.cache[piBridgePath].exports = MockPiBridge;

// Now import session-manager (it will use our mock PiBridge)
const ChatSessionManager = require('../../../src/chat/session-manager');

describe('ChatSessionManager', () => {
  let db;
  let manager;

  afterAll(() => {
    // Restore original module
    require.cache[piBridgePath].exports = originalExport;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    _createdBridges.length = 0;
    _nextStartFail = false;
    db = createTestDatabase();
    // Insert a review to satisfy foreign key constraints
    db.prepare(
      "INSERT INTO reviews (id, repository, status, review_type) VALUES (1, 'owner/repo', 'draft', 'pr')"
    ).run();
    manager = new ChatSessionManager(db);
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  describe('createSession', () => {
    it('should create a session and store in database', async () => {
      const result = await manager.createSession({
        provider: 'pi',
        model: 'claude-sonnet-4',
        reviewId: 1
      });

      expect(result).toHaveProperty('id');
      expect(result.status).toBe('active');

      // Verify DB record
      const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(result.id);
      expect(row).toBeDefined();
      expect(row.provider).toBe('pi');
      expect(row.model).toBe('claude-sonnet-4');
      expect(row.review_id).toBe(1);
      expect(row.status).toBe('active');
    });

    it('should return session ID and status', async () => {
      const result = await manager.createSession({
        provider: 'pi',
        reviewId: 1
      });

      expect(typeof result.id).toBe('number');
      expect(result.status).toBe('active');
    });

    it('should handle bridge start failure (updates DB status to error)', async () => {
      _nextStartFail = true;

      await expect(
        manager.createSession({ provider: 'pi', reviewId: 1 })
      ).rejects.toThrow('spawn failed');

      // DB should show 'error' status for the session
      const row = db.prepare("SELECT * FROM chat_sessions WHERE status = 'error'").get();
      expect(row).toBeDefined();
      expect(row.status).toBe('error');
    });

    it('should store context_comment_id when provided', async () => {
      // Insert a comment to satisfy FK
      db.prepare(
        "INSERT INTO comments (id, review_id, source, file, body, type) VALUES (10, 1, 'ai', 'test.js', 'test', 'issue')"
      ).run();

      const result = await manager.createSession({
        provider: 'pi',
        reviewId: 1,
        contextCommentId: 10
      });

      const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(result.id);
      expect(row.context_comment_id).toBe(10);
    });
  });

  describe('sendMessage', () => {
    it('should store user message in DB and forward to bridge', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      const result = await manager.sendMessage(session.id, 'What does this code do?');

      expect(result).toHaveProperty('id');

      // Verify DB record
      const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(result.id);
      expect(msg).toBeDefined();
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('What does this code do?');
      expect(msg.session_id).toBe(session.id);

      // Verify bridge received the message
      const bridge = _createdBridges[0];
      expect(bridge.sendMessage).toHaveBeenCalledWith('What does this code do?');
    });

    it('should prepend initial context on the first message', async () => {
      const session = await manager.createSession({
        provider: 'pi',
        reviewId: 1,
        initialContext: 'Here are the suggestions...'
      });
      const bridge = _createdBridges[0];

      await manager.sendMessage(session.id, 'Tell me about this bug');

      // Bridge should receive context + message
      expect(bridge.sendMessage).toHaveBeenCalledWith(
        'Here are the suggestions...\n\n---\n\nTell me about this bug'
      );

      // DB should store only the user's original message
      const msgs = db.prepare("SELECT * FROM chat_messages WHERE session_id = ? AND role = 'user'").all(session.id);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('Tell me about this bug');
    });

    it('should only prepend initial context on the first message, not subsequent ones', async () => {
      const session = await manager.createSession({
        provider: 'pi',
        reviewId: 1,
        initialContext: 'Context here'
      });
      const bridge = _createdBridges[0];

      await manager.sendMessage(session.id, 'first message');
      await manager.sendMessage(session.id, 'second message');

      // First call should have context prepended
      expect(bridge.sendMessage).toHaveBeenNthCalledWith(1,
        'Context here\n\n---\n\nfirst message'
      );

      // Second call should be plain
      expect(bridge.sendMessage).toHaveBeenNthCalledWith(2, 'second message');
    });

    it('should not prepend anything when initialContext is null', async () => {
      const session = await manager.createSession({
        provider: 'pi',
        reviewId: 1,
        initialContext: null
      });
      const bridge = _createdBridges[0];

      await manager.sendMessage(session.id, 'plain message');

      expect(bridge.sendMessage).toHaveBeenCalledWith('plain message');
    });

    it('should prepend per-message context when provided', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      const bridge = _createdBridges[0];

      await manager.sendMessage(session.id, 'What is wrong here?', {
        context: 'Suggestion: Null check missing on line 42'
      });

      // Bridge should receive context + message
      expect(bridge.sendMessage).toHaveBeenCalledWith(
        'Suggestion: Null check missing on line 42\n\n---\n\nWhat is wrong here?'
      );

      // DB should store only the user's original message (type='message')
      const msgs = db.prepare("SELECT * FROM chat_messages WHERE session_id = ? AND role = 'user' AND type = 'message'").all(session.id);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('What is wrong here?');
    });

    it('should prepend both initialContext and per-message context', async () => {
      const session = await manager.createSession({
        provider: 'pi',
        reviewId: 1,
        initialContext: 'All suggestions: ...'
      });
      const bridge = _createdBridges[0];

      await manager.sendMessage(session.id, 'Explain this', {
        context: 'Focused: Bug on line 10'
      });

      // initialContext (broad) wraps outermost, per-message context (focused) is closer to user text
      expect(bridge.sendMessage).toHaveBeenCalledWith(
        'All suggestions: ...\n\n---\n\nFocused: Bug on line 10\n\n---\n\nExplain this'
      );
    });

    it('should not prepend context when context option is undefined', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      const bridge = _createdBridges[0];

      await manager.sendMessage(session.id, 'plain message', {});

      expect(bridge.sendMessage).toHaveBeenCalledWith('plain message');
    });

    it('should store contextData as a context-type message in DB before the user message', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });

      const ctxData = { type: 'bug', title: 'Null check missing', file: 'src/app.js', line_start: 42, line_end: 42, body: 'Variable may be null' };
      await manager.sendMessage(session.id, 'Tell me about this', {
        context: 'Suggestion: Null check missing on line 42',
        contextData: ctxData
      });

      // Should have a context message and a user message
      const allMsgs = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC').all(session.id);
      expect(allMsgs).toHaveLength(2);

      // First message: context
      expect(allMsgs[0].role).toBe('user');
      expect(allMsgs[0].type).toBe('context');
      expect(JSON.parse(allMsgs[0].content)).toEqual(ctxData);

      // Second message: user message
      expect(allMsgs[1].role).toBe('user');
      expect(allMsgs[1].type).toBe('message');
      expect(allMsgs[1].content).toBe('Tell me about this');
    });

    it('should store contextData as string if already stringified', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });

      const ctxString = '{"type":"bug","title":"Already stringified"}';
      await manager.sendMessage(session.id, 'Check this', { contextData: ctxString });

      const ctxMsg = db.prepare("SELECT * FROM chat_messages WHERE session_id = ? AND type = 'context'").get(session.id);
      expect(ctxMsg).toBeDefined();
      expect(ctxMsg.content).toBe(ctxString);
    });

    it('should not store context message when contextData is not provided', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });

      await manager.sendMessage(session.id, 'No context here');

      const ctxMsgs = db.prepare("SELECT * FROM chat_messages WHERE session_id = ? AND type = 'context'").all(session.id);
      expect(ctxMsgs).toHaveLength(0);

      const userMsgs = db.prepare("SELECT * FROM chat_messages WHERE session_id = ? AND type = 'message'").all(session.id);
      expect(userMsgs).toHaveLength(1);
    });

    it('should store contextData object as a context row before the message row', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });

      await manager.sendMessage(session.id, 'text', {
        contextData: { type: 'bug', title: 'Null check' }
      });

      const allMsgs = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC').all(session.id);
      expect(allMsgs).toHaveLength(2);

      // First row: context
      expect(allMsgs[0].role).toBe('user');
      expect(allMsgs[0].type).toBe('context');
      expect(JSON.parse(allMsgs[0].content)).toEqual({ type: 'bug', title: 'Null check' });

      // Second row: user message
      expect(allMsgs[1].role).toBe('user');
      expect(allMsgs[1].type).toBe('message');
      expect(allMsgs[1].content).toBe('text');

      // Context row appears before message row (by id ordering)
      expect(allMsgs[0].id).toBeLessThan(allMsgs[1].id);
    });

    it('should store each item in a contextData array as a separate context row', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });

      const ctxArray = [
        { type: 'bug', title: 'Null check missing', file: 'app.js' },
        { type: 'improvement', title: 'Use const', file: 'utils.js' }
      ];
      await manager.sendMessage(session.id, 'Tell me about these', {
        contextData: ctxArray
      });

      const allMsgs = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC').all(session.id);
      expect(allMsgs).toHaveLength(3); // 2 context + 1 message

      // First two rows: context
      expect(allMsgs[0].type).toBe('context');
      expect(JSON.parse(allMsgs[0].content)).toEqual(ctxArray[0]);
      expect(allMsgs[1].type).toBe('context');
      expect(JSON.parse(allMsgs[1].content)).toEqual(ctxArray[1]);

      // Third row: user message
      expect(allMsgs[2].type).toBe('message');
      expect(allMsgs[2].content).toBe('Tell me about these');

      // Both context rows appear before the message row
      expect(allMsgs[0].id).toBeLessThan(allMsgs[2].id);
      expect(allMsgs[1].id).toBeLessThan(allMsgs[2].id);
    });

    it('should throw on sendMessage to non-existent session', async () => {
      await expect(
        manager.sendMessage(999, 'hello')
      ).rejects.toThrow('Session 999 not found');
    });
  });

  describe('event callbacks', () => {
    it('should register delta callback and return unsubscribe function', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      const callback = vi.fn();

      const unsub = manager.onDelta(session.id, callback);
      expect(typeof unsub).toBe('function');

      // Simulate bridge emitting delta
      const bridge = _createdBridges[0];
      bridge.emit('delta', { text: 'chunk' });

      expect(callback).toHaveBeenCalledWith({ text: 'chunk' });

      // Unsubscribe
      unsub();
      bridge.emit('delta', { text: 'more' });
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should call onComplete callback with fullText and messageId after bridge complete', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      const callback = vi.fn();
      manager.onComplete(session.id, callback);

      // Simulate bridge emitting complete
      const bridge = _createdBridges[0];
      bridge.emit('complete', { fullText: 'The answer is 42' });

      expect(callback).toHaveBeenCalledWith({
        fullText: 'The answer is 42',
        messageId: expect.any(Number)
      });
    });

    it('should store assistant message in DB on bridge complete', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });

      // Simulate bridge emitting complete
      const bridge = _createdBridges[0];
      bridge.emit('complete', { fullText: 'Response from AI' });

      const messages = db.prepare(
        "SELECT * FROM chat_messages WHERE session_id = ? AND role = 'assistant'"
      ).all(session.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Response from AI');
    });

    it('should throw onDelta for non-existent session', () => {
      expect(() => manager.onDelta(999, vi.fn())).toThrow('Session 999 not found');
    });

    it('should throw onComplete for non-existent session', () => {
      expect(() => manager.onComplete(999, vi.fn())).toThrow('Session 999 not found');
    });

    it('should throw onToolUse for non-existent session', () => {
      expect(() => manager.onToolUse(999, vi.fn())).toThrow('Session 999 not found');
    });
  });

  describe('closeSession', () => {
    it('should close bridge and update DB status', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      const bridge = _createdBridges[0];

      await manager.closeSession(session.id);

      expect(bridge.close).toHaveBeenCalled();

      const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(session.id);
      expect(row.status).toBe('closed');
    });

    it('should handle closing already-closed session gracefully', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      await manager.closeSession(session.id);

      // Closing again should not throw
      await expect(manager.closeSession(session.id)).resolves.toBeUndefined();
    });
  });

  describe('getSession', () => {
    it('should return session from DB', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });

      const result = manager.getSession(session.id);
      expect(result).toBeDefined();
      expect(result.id).toBe(session.id);
      expect(result.provider).toBe('pi');
    });

    it('should return null for non-existent session', () => {
      const result = manager.getSession(999);
      expect(result).toBeNull();
    });
  });

  describe('getSessionsForReview', () => {
    it('should return sessions for the given review', async () => {
      await manager.createSession({ provider: 'pi', reviewId: 1 });
      await manager.createSession({ provider: 'pi', model: 'opus', reviewId: 1 });

      const sessions = manager.getSessionsForReview(1);
      expect(sessions).toHaveLength(2);
    });

    it('should return empty array when no sessions exist', () => {
      const sessions = manager.getSessionsForReview(999);
      expect(sessions).toEqual([]);
    });
  });

  describe('getMessages', () => {
    it('should return messages ordered by created_at ASC', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });

      await manager.sendMessage(session.id, 'first');
      await manager.sendMessage(session.id, 'second');

      const messages = manager.getMessages(session.id);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('first');
      expect(messages[1].content).toBe('second');
    });

    it('should return empty array when no messages exist', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      const messages = manager.getMessages(session.id);
      expect(messages).toEqual([]);
    });
  });

  describe('closeAll', () => {
    it('should close all active sessions', async () => {
      await manager.createSession({ provider: 'pi', reviewId: 1 });
      await manager.createSession({ provider: 'pi', reviewId: 1 });

      const bridge1 = _createdBridges[0];
      const bridge2 = _createdBridges[1];

      await manager.closeAll();

      expect(bridge1.close).toHaveBeenCalled();
      expect(bridge2.close).toHaveBeenCalled();

      expect(manager._sessions.size).toBe(0);
    });

    it('should do nothing when no active sessions', async () => {
      await expect(manager.closeAll()).resolves.toBeUndefined();
    });
  });

  describe('isSessionActive', () => {
    it('should return true for active sessions', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      expect(manager.isSessionActive(session.id)).toBe(true);
    });

    it('should return false for non-existent sessions', () => {
      expect(manager.isSessionActive(999)).toBe(false);
    });

    it('should return false after session is closed', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      await manager.closeSession(session.id);
      expect(manager.isSessionActive(session.id)).toBe(false);
    });
  });

  describe('resumeSession', () => {
    it('should return immediately if session is already active', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      const result = await manager.resumeSession(session.id);
      expect(result).toEqual({ id: session.id, status: 'active' });
    });

    it('should throw when session does not exist', async () => {
      await expect(manager.resumeSession(999)).rejects.toThrow('Session 999 not found');
    });

    it('should throw when session has no agent_session_id', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      await manager.closeSession(session.id);

      await expect(manager.resumeSession(session.id)).rejects.toThrow('has no session file');
    });

    it('should throw when session file does not exist on disk', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      // Manually set agent_session_id to a non-existent path
      db.prepare('UPDATE chat_sessions SET agent_session_id = ? WHERE id = ?')
        .run('/tmp/nonexistent-session-file-xyz.json', session.id);
      await manager.closeSession(session.id);

      await expect(manager.resumeSession(session.id)).rejects.toThrow('Session file not found on disk');

      // Should have nulled out the stale path
      const row = db.prepare('SELECT agent_session_id FROM chat_sessions WHERE id = ?').get(session.id);
      expect(row.agent_session_id).toBeNull();
    });

    it('should resume session with valid session file', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      const sessionFilePath = '/tmp/test-resume-session.json';

      // Write a temporary file so existsSync returns true
      const fs = require('fs');
      fs.writeFileSync(sessionFilePath, '{}');

      try {
        db.prepare('UPDATE chat_sessions SET agent_session_id = ? WHERE id = ?')
          .run(sessionFilePath, session.id);
        await manager.closeSession(session.id);

        const result = await manager.resumeSession(session.id, { systemPrompt: 'test', cwd: '/tmp' });
        expect(result).toEqual({ id: session.id, status: 'active' });
        expect(manager.isSessionActive(session.id)).toBe(true);

        // DB should show active status
        const row = db.prepare('SELECT status FROM chat_sessions WHERE id = ?').get(session.id);
        expect(row.status).toBe('active');
      } finally {
        try { fs.unlinkSync(sessionFilePath); } catch { /* ignore */ }
      }
    });
  });

  describe('getMRUSession', () => {
    it('should return the most recently updated session', async () => {
      await manager.createSession({ provider: 'pi', reviewId: 1 });
      const second = await manager.createSession({ provider: 'pi', reviewId: 1 });

      // Update the second session's timestamp to make it MRU
      db.prepare("UPDATE chat_sessions SET updated_at = datetime('now', '+1 second') WHERE id = ?").run(second.id);

      const mru = manager.getMRUSession(1);
      expect(mru).toBeDefined();
      expect(mru.id).toBe(second.id);
    });

    it('should return null when no sessions exist', () => {
      const mru = manager.getMRUSession(999);
      expect(mru).toBeNull();
    });
  });

  describe('getSessionsWithMessageCount', () => {
    it('should return sessions with message_count', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      await manager.sendMessage(session.id, 'hello');
      await manager.sendMessage(session.id, 'world');

      const sessions = manager.getSessionsWithMessageCount(1);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].message_count).toBe(2);
    });

    it('should return 0 message_count for sessions with no messages', async () => {
      await manager.createSession({ provider: 'pi', reviewId: 1 });

      const sessions = manager.getSessionsWithMessageCount(1);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].message_count).toBe(0);
    });

    it('should only count message-type rows (not context)', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      await manager.sendMessage(session.id, 'hello', {
        contextData: { type: 'bug', title: 'test' }
      });

      const sessions = manager.getSessionsWithMessageCount(1);
      expect(sessions).toHaveLength(1);
      // Should count only the 'message' row, not the 'context' row
      expect(sessions[0].message_count).toBe(1);
    });

    it('should return empty array when no sessions exist', () => {
      const sessions = manager.getSessionsWithMessageCount(999);
      expect(sessions).toEqual([]);
    });
  });

  describe('session file persistence via session event', () => {
    it('should store agent_session_id when bridge emits session event', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      const bridge = _createdBridges[_createdBridges.length - 1];

      // Simulate Pi emitting a session event with the session file path
      bridge.emit('session', { sessionFile: '/tmp/pi-session-abc.json' });

      const row = db.prepare('SELECT agent_session_id FROM chat_sessions WHERE id = ?').get(session.id);
      expect(row.agent_session_id).toBe('/tmp/pi-session-abc.json');
    });

    it('should not update DB when session event has no sessionFile', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      const bridge = _createdBridges[_createdBridges.length - 1];

      bridge.emit('session', { type: 'session' });

      const row = db.prepare('SELECT agent_session_id FROM chat_sessions WHERE id = ?').get(session.id);
      expect(row.agent_session_id).toBeNull();
    });
  });

  describe('sendMessage busy guard', () => {
    it('should throw when bridge is busy', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      const bridge = _createdBridges[_createdBridges.length - 1];
      bridge.isBusy.mockReturnValue(true);

      await expect(manager.sendMessage(session.id, 'hello'))
        .rejects.toThrow('currently processing a message');
    });
  });

  describe('saveContextMessage', () => {
    it('should save a context message with object data', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });

      const contextData = { type: 'analysis', suggestionCount: 5, aiRunId: 'run-abc' };
      const result = manager.saveContextMessage(session.id, contextData);

      expect(result).toHaveProperty('id');
      expect(typeof result.id).toBe('number');

      // Verify DB record
      const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(result.id);
      expect(msg).toBeDefined();
      expect(msg.role).toBe('user');
      expect(msg.type).toBe('context');
      expect(msg.session_id).toBe(session.id);
      expect(JSON.parse(msg.content)).toEqual(contextData);
    });

    it('should save a context message with string data', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });

      const contextString = '{"type":"analysis","suggestionCount":3}';
      const result = manager.saveContextMessage(session.id, contextString);

      const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(result.id);
      expect(msg.content).toBe(contextString);
    });

    it('should throw when session does not exist', () => {
      expect(() => manager.saveContextMessage(999, { type: 'analysis' }))
        .toThrow('Session 999 not found');
    });

    it('should be visible in getMessages results', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });

      const contextData = { type: 'analysis', suggestionCount: 2 };
      manager.saveContextMessage(session.id, contextData);

      // Also send a regular message
      await manager.sendMessage(session.id, 'hello');

      const messages = manager.getMessages(session.id);
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('context');
      expect(JSON.parse(messages[0].content)).toEqual(contextData);
      expect(messages[1].type).toBe('message');
      expect(messages[1].content).toBe('hello');
    });

    it('should not count context messages in getSessionsWithMessageCount', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });

      manager.saveContextMessage(session.id, { type: 'analysis', suggestionCount: 5 });

      const sessions = manager.getSessionsWithMessageCount(1);
      expect(sessions).toHaveLength(1);
      // Context messages are NOT counted (only type='message' rows)
      expect(sessions[0].message_count).toBe(0);
    });
  });
});
