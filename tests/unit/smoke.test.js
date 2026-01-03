import { describe, it, expect } from 'vitest';

describe('Smoke Tests', () => {
  describe('Test Framework', () => {
    it('should run a basic test', () => {
      expect(true).toBe(true);
    });

    it('should perform basic assertions', () => {
      expect(1 + 1).toBe(2);
      expect('hello').toContain('ell');
      expect([1, 2, 3]).toHaveLength(3);
    });

    it('should handle async tests', async () => {
      const result = await Promise.resolve('async works');
      expect(result).toBe('async works');
    });

    it('should support object matchers', () => {
      const obj = { name: 'pair-review', version: '1.0.0' };
      expect(obj).toMatchObject({ name: 'pair-review' });
      expect(obj).toHaveProperty('version');
    });
  });

  describe('Node Environment', () => {
    it('should have access to Node.js globals', () => {
      expect(typeof process).toBe('object');
      expect(typeof process.env).toBe('object');
    });

    it('should be able to import Node.js modules', async () => {
      const path = await import('path');
      expect(typeof path.join).toBe('function');
    });
  });
});
