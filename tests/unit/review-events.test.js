// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests for src/events/review-events.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ws = require('../../src/ws');
const { broadcastReviewEvent } = require('../../src/events/review-events');

describe('review-events', () => {
  let broadcastSpy;

  beforeEach(() => {
    broadcastSpy = vi.spyOn(ws, 'broadcast').mockImplementation(() => {});
  });

  afterEach(() => {
    broadcastSpy.mockRestore();
  });

  describe('broadcastReviewEvent', () => {
    it('should broadcast with correct topic and payload', () => {
      broadcastReviewEvent(42, { type: 'comment_added', commentId: 7 });

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect(broadcastSpy).toHaveBeenCalledWith('review:42', {
        type: 'comment_added',
        commentId: 7,
        reviewId: 42
      });
    });

    it('should include reviewId merged with the payload', () => {
      broadcastReviewEvent(99, { type: 'analysis_complete', score: 85 });

      expect(broadcastSpy).toHaveBeenCalledWith('review:99', {
        type: 'analysis_complete',
        score: 85,
        reviewId: 99
      });
    });

    it('should include sourceClientId when provided in options', () => {
      broadcastReviewEvent(10, { type: 'update' }, { sourceClientId: 'client-abc' });

      expect(broadcastSpy).toHaveBeenCalledWith('review:10', {
        type: 'update',
        reviewId: 10,
        sourceClientId: 'client-abc'
      });
    });

    it('should not include sourceClientId when not provided', () => {
      broadcastReviewEvent(10, { type: 'update' });

      const payload = broadcastSpy.mock.calls[0][1];
      expect(payload).not.toHaveProperty('sourceClientId');
    });

    it('should not throw when called (ws module handles missing subscribers)', () => {
      expect(() => {
        broadcastReviewEvent(1, { type: 'noop' });
      }).not.toThrow();
    });

    it('should let reviewId argument override reviewId in payload', () => {
      broadcastReviewEvent(123, { type: 'test', reviewId: 456 });

      const payload = broadcastSpy.mock.calls[0][1];
      expect(payload.reviewId).toBe(123);
    });
  });
});
