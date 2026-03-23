// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { safeParseJson } from '../../src/utils/safe-parse-json.js';

describe('safeParseJson', () => {
  describe('valid JSON input', () => {
    it('should parse valid JSON string', () => {
      const result = safeParseJson('{"key": "value"}');
      expect(result).toEqual({ key: 'value' });
    });

    it('should parse JSON arrays', () => {
      const result = safeParseJson('["step1", "step2", "step3"]');
      expect(result).toEqual(['step1', 'step2', 'step3']);
    });

    it('should parse JSON primitives', () => {
      expect(safeParseJson('42')).toBe(42);
      expect(safeParseJson('"hello"')).toBe('hello');
      expect(safeParseJson('true')).toBe(true);
      expect(safeParseJson('null')).toBe(null);
    });

    it('should parse nested JSON objects', () => {
      const input = '{"reasoning": ["step1", "step2"], "confidence": 0.85}';
      const result = safeParseJson(input);
      expect(result).toEqual({
        reasoning: ['step1', 'step2'],
        confidence: 0.85
      });
    });
  });

  describe('null/undefined input', () => {
    it('should return default fallback (null) for null input', () => {
      expect(safeParseJson(null)).toBe(null);
    });

    it('should return default fallback (null) for undefined input', () => {
      expect(safeParseJson(undefined)).toBe(null);
    });

    it('should return custom fallback for null input', () => {
      expect(safeParseJson(null, [])).toEqual([]);
      expect(safeParseJson(null, {})).toEqual({});
      expect(safeParseJson(null, 'default')).toBe('default');
    });

    it('should return custom fallback for undefined input', () => {
      expect(safeParseJson(undefined, [])).toEqual([]);
    });
  });

  describe('malformed JSON input', () => {
    it('should return default fallback for invalid JSON', () => {
      expect(safeParseJson('not valid json')).toBe(null);
      expect(safeParseJson('{broken')).toBe(null);
      expect(safeParseJson('{"key": undefined}')).toBe(null);
    });

    it('should return custom fallback for invalid JSON', () => {
      expect(safeParseJson('invalid', [])).toEqual([]);
      expect(safeParseJson('{broken}', { error: true })).toEqual({ error: true });
    });

    it('should handle empty strings gracefully', () => {
      expect(safeParseJson('')).toBe(null);
      expect(safeParseJson('', [])).toEqual([]);
    });

    it('should handle truncated JSON gracefully', () => {
      // Simulate database column truncation
      const truncated = '["step1", "step2", "step3';
      expect(safeParseJson(truncated)).toBe(null);
      expect(safeParseJson(truncated, [])).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('should handle whitespace-only strings', () => {
      expect(safeParseJson('   ')).toBe(null);
      expect(safeParseJson('\n\t')).toBe(null);
    });

    it('should handle JSON with special characters', () => {
      const result = safeParseJson('{"message": "Hello\\nWorld"}');
      expect(result).toEqual({ message: 'Hello\nWorld' });
    });

    it('should preserve falsy fallback values', () => {
      expect(safeParseJson(null, 0)).toBe(0);
      expect(safeParseJson(null, false)).toBe(false);
      expect(safeParseJson(null, '')).toBe('');
    });
  });
});
