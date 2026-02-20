// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests for src/sse/review-events.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sseClients, broadcastReviewEvent } from '../../src/sse/review-events.js';

describe('review-events', () => {
  beforeEach(() => {
    sseClients.clear();
  });

  describe('sseClients', () => {
    it('should be a Set instance', () => {
      expect(sseClients).toBeInstanceOf(Set);
    });
  });

  describe('broadcastReviewEvent', () => {
    it('should broadcast to multiple connected clients', () => {
      const client1 = { write: vi.fn() };
      const client2 = { write: vi.fn() };
      const client3 = { write: vi.fn() };
      sseClients.add(client1);
      sseClients.add(client2);
      sseClients.add(client3);

      broadcastReviewEvent(42, { type: 'comment_added', commentId: 7 });

      expect(client1.write).toHaveBeenCalledTimes(1);
      expect(client2.write).toHaveBeenCalledTimes(1);
      expect(client3.write).toHaveBeenCalledTimes(1);
    });

    it('should include reviewId merged with the payload', () => {
      const client = { write: vi.fn() };
      sseClients.add(client);

      broadcastReviewEvent(99, { type: 'analysis_complete', score: 85 });

      const written = client.write.mock.calls[0][0];
      const parsed = JSON.parse(written.replace('data: ', '').trim());
      expect(parsed).toEqual({
        type: 'analysis_complete',
        score: 85,
        reviewId: 99
      });
    });

    it('should format the message as an SSE data line', () => {
      const client = { write: vi.fn() };
      sseClients.add(client);

      broadcastReviewEvent(1, { type: 'test' });

      const written = client.write.mock.calls[0][0];
      expect(written).toMatch(/^data: .+\n\n$/);
    });

    it('should remove disconnected clients that throw on write', () => {
      const goodClient = { write: vi.fn() };
      const badClient = {
        write: vi.fn(() => {
          throw new Error('Connection reset');
        })
      };
      sseClients.add(goodClient);
      sseClients.add(badClient);

      broadcastReviewEvent(10, { type: 'update' });

      expect(sseClients.has(goodClient)).toBe(true);
      expect(sseClients.has(badClient)).toBe(false);
      expect(sseClients.size).toBe(1);
      // Good client should still have received the event
      expect(goodClient.write).toHaveBeenCalledTimes(1);
    });

    it('should not throw when sseClients is empty', () => {
      expect(sseClients.size).toBe(0);

      expect(() => {
        broadcastReviewEvent(1, { type: 'noop' });
      }).not.toThrow();
    });

    it('should let reviewId in payload be overridden by the reviewId argument', () => {
      const client = { write: vi.fn() };
      sseClients.add(client);

      // Payload contains a reviewId, but the function spreads payload first
      // then sets reviewId, so the argument wins
      broadcastReviewEvent(123, { type: 'test', reviewId: 456 });

      const written = client.write.mock.calls[0][0];
      const parsed = JSON.parse(written.replace('data: ', '').trim());
      expect(parsed.reviewId).toBe(123);
    });
  });
});
