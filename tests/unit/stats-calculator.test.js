// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for stats-calculator utility
 */

import { describe, it, expect } from 'vitest';
import { calculateStats } from '../../src/utils/stats-calculator.js';

describe('Stats Calculator', () => {
  describe('calculateStats', () => {
    it('should count praise type correctly', () => {
      const rows = [
        { type: 'praise', count: 5 }
      ];
      const stats = calculateStats(rows);
      expect(stats.praise).toBe(5);
      expect(stats.issues).toBe(0);
      expect(stats.suggestions).toBe(0);
    });

    it('should count issue types (bug, security, performance) as issues', () => {
      const rows = [
        { type: 'bug', count: 3 },
        { type: 'security', count: 2 },
        { type: 'performance', count: 1 }
      ];
      const stats = calculateStats(rows);
      expect(stats.issues).toBe(6);
      expect(stats.suggestions).toBe(0);
      expect(stats.praise).toBe(0);
    });

    it('should count recommendation types as suggestions', () => {
      const rows = [
        { type: 'suggestion', count: 3 },
        { type: 'improvement', count: 2 },
        { type: 'design', count: 1 },
        { type: 'code-style', count: 1 }
      ];
      const stats = calculateStats(rows);
      expect(stats.suggestions).toBe(7);
      expect(stats.issues).toBe(0);
      expect(stats.praise).toBe(0);
    });

    it('should handle mixed types across all three buckets', () => {
      const rows = [
        { type: 'bug', count: 2 },
        { type: 'praise', count: 4 },
        { type: 'suggestion', count: 3 },
        { type: 'security', count: 1 }
      ];
      const stats = calculateStats(rows);
      expect(stats.issues).toBe(3); // bug + security
      expect(stats.suggestions).toBe(3); // suggestion
      expect(stats.praise).toBe(4);
    });

    it('should handle empty array', () => {
      const stats = calculateStats([]);
      expect(stats.issues).toBe(0);
      expect(stats.suggestions).toBe(0);
      expect(stats.praise).toBe(0);
    });

    it('should be case-insensitive for all types', () => {
      const rows = [
        { type: 'PRAISE', count: 2 },
        { type: 'Praise', count: 3 },
        { type: 'BUG', count: 1 },
        { type: 'SUGGESTION', count: 2 }
      ];
      const stats = calculateStats(rows);
      expect(stats.praise).toBe(5);
      expect(stats.issues).toBe(1);
      expect(stats.suggestions).toBe(2);
    });

    it('should handle null/undefined type as suggestion', () => {
      const rows = [
        { type: null, count: 2 },
        { type: undefined, count: 1 }
      ];
      const stats = calculateStats(rows);
      expect(stats.suggestions).toBe(3);
      expect(stats.issues).toBe(0);
      expect(stats.praise).toBe(0);
    });
  });
});
