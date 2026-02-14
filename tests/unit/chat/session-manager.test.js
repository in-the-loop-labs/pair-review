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

  describe('sendMessage busy guard', () => {
    it('should throw when bridge is busy', async () => {
      const session = await manager.createSession({ provider: 'pi', reviewId: 1 });
      const bridge = _createdBridges[_createdBridges.length - 1];
      bridge.isBusy.mockReturnValue(true);

      await expect(manager.sendMessage(session.id, 'hello'))
        .rejects.toThrow('currently processing a message');
    });
  });
});
