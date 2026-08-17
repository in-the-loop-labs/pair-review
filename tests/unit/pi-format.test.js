// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for the shared Pi JSONL format helpers (src/ai/pi-format.js).
 *
 * These helpers are consumed by both the Pi provider and the OMP provider
 * (a Pi fork emitting an identical event stream). The full streaming paths
 * (chunked line buffering, raw-output caps) are exercised through the real
 * spawn pipeline in pi-provider.test.js; this file covers the helpers'
 * unit-level contracts directly, including the `cliName` used in messages.
 */

// Mock logger to suppress output during tests
// Note: Logger exports directly via CommonJS (module.exports = new AILogger()),
// so mock must export methods at top level, not under 'default'
vi.mock('../../src/utils/logger', () => {
  let streamDebugEnabled = false;
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    streamDebug: vi.fn(),
    section: vi.fn(),
    isStreamDebugEnabled: () => streamDebugEnabled,
    setStreamDebugEnabled: (enabled) => { streamDebugEnabled = enabled; }
  };
});

const {
  extractAssistantText,
  isPiEventEnvelope,
  appendWithLimit,
  appendHeadTailBuffer,
  formatHeadTailBuffer,
  finalizePiResponseParsing
} = require('../../src/ai/pi-format');

describe('pi-format', () => {
  describe('isPiEventEnvelope', () => {
    it('should return false for a review-like object without a type field', () => {
      expect(isPiEventEnvelope({ result: { comments: [] } })).toBe(false);
    });

    it('should return true for event types ending in _start/_update/_end', () => {
      expect(isPiEventEnvelope({ type: 'tool_execution_end' })).toBe(true);
      expect(isPiEventEnvelope({ type: 'message_update' })).toBe(true);
    });

    it('should return true for session events', () => {
      expect(isPiEventEnvelope({ type: 'session' })).toBe(true);
    });

    it('should return false for non-objects and arrays', () => {
      expect(isPiEventEnvelope(null)).toBe(false);
      expect(isPiEventEnvelope('string')).toBe(false);
      expect(isPiEventEnvelope([{ type: 'message_end' }])).toBe(false);
    });
  });

  describe('appendWithLimit', () => {
    it('should return the existing string unchanged for empty chunks', () => {
      expect(appendWithLimit('abc', '', 5)).toEqual({ value: 'abc', truncated: false });
    });

    it('should append when the chunk fits within the limit', () => {
      expect(appendWithLimit('ab', 'cd', 4)).toEqual({ value: 'abcd', truncated: false });
    });

    it('should report truncation on an exact full buffer followed by more data', () => {
      expect(appendWithLimit('abcd', 'z', 4)).toEqual({ value: 'abcd', truncated: true });
    });

    it('should truncate overflowing chunks to the remaining capacity', () => {
      expect(appendWithLimit('ab', 'cdef', 4)).toEqual({ value: 'abcd', truncated: true });
    });
  });

  describe('appendHeadTailBuffer / formatHeadTailBuffer', () => {
    const fresh = () => ({ head: '', tail: '', headFull: false, omittedChars: 0 });

    it('should keep the full content when it fits within head+tail capacity', () => {
      const buffer = fresh();
      appendHeadTailBuffer(buffer, 'a'.repeat(140), 100, 50);

      expect(buffer.headFull).toBe(true);
      expect(buffer.omittedChars).toBe(0);
      expect(formatHeadTailBuffer(buffer)).toBe('a'.repeat(140));
    });

    it('should treat an exact head fill as no data loss', () => {
      const buffer = fresh();
      appendHeadTailBuffer(buffer, 'a'.repeat(100), 100, 50);

      expect(buffer.headFull).toBe(true);
      expect(buffer.omittedChars).toBe(0);
      expect(formatHeadTailBuffer(buffer)).toBe('a'.repeat(100));
    });

    it('should record omitted chars once the tail overflows', () => {
      const buffer = fresh();
      appendHeadTailBuffer(buffer, 'H'.repeat(100), 100, 50);
      appendHeadTailBuffer(buffer, 'T'.repeat(200), 100, 50);

      expect(buffer.omittedChars).toBe(150);
      expect(formatHeadTailBuffer(buffer)).toContain('...[150 chars omitted]...');
    });
  });

  describe('finalizePiResponseParsing', () => {
    it('should prefer valid textContent over rawOutput', () => {
      const result = finalizePiResponseParsing({
        textContent: '{"findings":[]}',
        rawOutput: '{"ignored":true}'
      }, 1, '[Level 1]');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ findings: [] });
    });

    it('should parse raw output when no assistant text exists', () => {
      const result = finalizePiResponseParsing({
        textContent: '',
        rawOutput: '{"findings":[{"title":"x"}]}'
      }, 1, '[Level 1]');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ findings: [{ title: 'x' }] });
    });

    it('should fail closed when raw output was truncated before assistant text was recovered', () => {
      const result = finalizePiResponseParsing({
        textContent: '',
        rawOutput: '{"type":"session"}',
        rawOutputTruncated: true
      }, 1, '[Level 1]');

      expect(result.success).toBe(false);
      expect(result.error).toContain('truncated before assistant text could be recovered');
    });

    it('should default to naming the Pi CLI in the truncation error', () => {
      const result = finalizePiResponseParsing({
        textContent: '',
        rawOutput: '{"type":"session"}',
        rawOutputTruncated: true
      }, 1, '[Level 1]');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Pi CLI raw-output fallback was truncated before assistant text could be recovered');
    });

    it('should name the supplied cliName in the truncation error (OMP)', () => {
      const result = finalizePiResponseParsing({
        textContent: '',
        rawOutput: '{"type":"session"}',
        rawOutputTruncated: true
      }, 1, '[L1]', 'OMP');

      expect(result.success).toBe(false);
      expect(result.error).toBe('OMP CLI raw-output fallback was truncated before assistant text could be recovered');
    });
  });

  describe('extractAssistantText', () => {
    it('should extract text from array content blocks', () => {
      const seenTexts = new Set();
      const content = [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' World' }
      ];
      const result = extractAssistantText(content, seenTexts);
      expect(result).toBe('Hello World');
    });

    it('should extract text from string content', () => {
      const seenTexts = new Set();
      const result = extractAssistantText('Simple string', seenTexts);
      expect(result).toBe('Simple string');
    });

    it('should skip non-text blocks', () => {
      const seenTexts = new Set();
      const content = [
        { type: 'tool_use', text: 'should be ignored' },
        { type: 'text', text: 'real text' }
      ];
      const result = extractAssistantText(content, seenTexts);
      expect(result).toBe('real text');
    });

    it('should skip blocks without text', () => {
      const seenTexts = new Set();
      const content = [
        { type: 'text' },
        { type: 'text', text: null },
        { type: 'text', text: 'valid' }
      ];
      const result = extractAssistantText(content, seenTexts);
      expect(result).toBe('valid');
    });

    it('should dedup identical text blocks using Set', () => {
      const seenTexts = new Set();
      const content = [
        { type: 'text', text: 'same text' },
        { type: 'text', text: 'same text' }
      ];
      const result = extractAssistantText(content, seenTexts);
      expect(result).toBe('same text');
    });

    it('should dedup across multiple calls with shared Set', () => {
      const seenTexts = new Set();
      const content1 = [{ type: 'text', text: 'first pass' }];
      const content2 = [{ type: 'text', text: 'first pass' }];
      const r1 = extractAssistantText(content1, seenTexts);
      const r2 = extractAssistantText(content2, seenTexts);
      expect(r1).toBe('first pass');
      expect(r2).toBe('');
    });

    it('should not incorrectly dedup substring matches', () => {
      // This is the key fix: substring "abc" is contained in "abcdef",
      // but they are different text blocks and should NOT be deduped
      const seenTexts = new Set();
      const content1 = [{ type: 'text', text: 'abcdef' }];
      const content2 = [{ type: 'text', text: 'abc' }];
      const r1 = extractAssistantText(content1, seenTexts);
      const r2 = extractAssistantText(content2, seenTexts);
      expect(r1).toBe('abcdef');
      expect(r2).toBe('abc');
    });

    it('should handle null content', () => {
      const seenTexts = new Set();
      const result = extractAssistantText(null, seenTexts);
      expect(result).toBe('');
    });

    it('should handle undefined content', () => {
      const seenTexts = new Set();
      const result = extractAssistantText(undefined, seenTexts);
      expect(result).toBe('');
    });

    it('should handle empty array', () => {
      const seenTexts = new Set();
      const result = extractAssistantText([], seenTexts);
      expect(result).toBe('');
    });

    it('should handle empty string', () => {
      const seenTexts = new Set();
      const result = extractAssistantText('', seenTexts);
      // Empty string is falsy, handled by the typeof check
      expect(result).toBe('');
    });

    it('should handle number content (not array or string)', () => {
      const seenTexts = new Set();
      const result = extractAssistantText(42, seenTexts);
      expect(result).toBe('');
    });
  });
});
