// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';

const { buildSparseCheckoutGuidance } = require('../../src/ai/prompts/sparse-checkout-guidance');

describe('sparse-checkout-guidance.js', () => {
  describe('buildSparseCheckoutGuidance', () => {
    it('should return guidance with patterns listed', () => {
      const result = buildSparseCheckoutGuidance({
        patterns: ['packages/core', 'packages/shared']
      });

      expect(result).toContain('## Sparse Checkout Active');
      expect(result).toContain('  - packages/core');
      expect(result).toContain('  - packages/shared');
      expect(result).toContain('git sparse-checkout add <directory>');
    });

    it('should return fallback text when patterns array is empty', () => {
      const result = buildSparseCheckoutGuidance({ patterns: [] });

      expect(result).toContain('## Sparse Checkout Active');
      expect(result).toContain('(run `git sparse-checkout list` to see current patterns)');
      expect(result).not.toContain('  - ');
    });

    it('should return fallback text when no options provided', () => {
      const result = buildSparseCheckoutGuidance();

      expect(result).toContain('## Sparse Checkout Active');
      expect(result).toContain('(run `git sparse-checkout list` to see current patterns)');
    });

    it('should return fallback text when options is empty object', () => {
      const result = buildSparseCheckoutGuidance({});

      expect(result).toContain('## Sparse Checkout Active');
      expect(result).toContain('(run `git sparse-checkout list` to see current patterns)');
    });

    it('should include example for packages/shared-utils', () => {
      const result = buildSparseCheckoutGuidance({ patterns: ['packages/core'] });

      expect(result).toContain('packages/shared-utils');
      expect(result).toContain('This is non-destructive');
    });

    it('should handle single pattern', () => {
      const result = buildSparseCheckoutGuidance({
        patterns: ['src']
      });

      expect(result).toContain('  - src');
      expect(result).not.toContain('(run `git sparse-checkout list`');
    });

    it('should handle many patterns', () => {
      const patterns = [
        'packages/a',
        'packages/b',
        'packages/c',
        'libs/shared',
        'tools/build'
      ];
      const result = buildSparseCheckoutGuidance({ patterns });

      patterns.forEach(pattern => {
        expect(result).toContain(`  - ${pattern}`);
      });
    });
  });
});
