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
    });

    it('should count non-praise types as issues', () => {
      const rows = [
        { type: 'bug', count: 3 },
        { type: 'improvement', count: 2 },
        { type: 'security', count: 1 }
      ];
      const stats = calculateStats(rows);
      expect(stats.issues).toBe(6);
      expect(stats.praise).toBe(0);
    });

    it('should handle mixed types', () => {
      const rows = [
        { type: 'bug', count: 2 },
        { type: 'praise', count: 4 },
        { type: 'suggestion', count: 3 }
      ];
      const stats = calculateStats(rows);
      expect(stats.issues).toBe(5); // bug + suggestion
      expect(stats.praise).toBe(4);
    });

    it('should handle empty array', () => {
      const stats = calculateStats([]);
      expect(stats.issues).toBe(0);
      expect(stats.praise).toBe(0);
    });

    it('should be case-insensitive for praise', () => {
      const rows = [
        { type: 'PRAISE', count: 2 },
        { type: 'Praise', count: 3 }
      ];
      const stats = calculateStats(rows);
      expect(stats.praise).toBe(5);
      expect(stats.issues).toBe(0);
    });

    it('should handle null type as issue', () => {
      const rows = [
        { type: null, count: 2 },
        { type: undefined, count: 1 }
      ];
      const stats = calculateStats(rows);
      expect(stats.issues).toBe(3);
      expect(stats.praise).toBe(0);
    });
  });
});
