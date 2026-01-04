import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the dependencies before importing the Analyzer
vi.mock('../../src/ai/index', () => ({
  createProvider: vi.fn()
}));

vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({ getPatterns: () => [] })
}));

vi.mock('../../src/utils/logger', () => ({
  default: {
    section: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    log: vi.fn()
  }
}));

// Import the Analyzer class after mocks are set up
const Analyzer = require('../../src/ai/analyzer');

describe('Analyzer.validateSuggestionFilePaths', () => {
  let analyzer;

  beforeEach(() => {
    // Create an analyzer instance with a mock database
    analyzer = new Analyzer({}, 'sonnet', 'claude');
  });

  describe('basic validation', () => {
    it('should return empty array when suggestions is empty', () => {
      const result = analyzer.validateSuggestionFilePaths([], ['src/foo.js']);
      expect(result).toEqual([]);
    });

    it('should return empty array when suggestions is null', () => {
      const result = analyzer.validateSuggestionFilePaths(null, ['src/foo.js']);
      expect(result).toEqual([]);
    });

    it('should return all suggestions when validPaths is empty (with warning)', () => {
      const suggestions = [
        { file: 'src/foo.js', title: 'Test', type: 'bug' }
      ];
      const result = analyzer.validateSuggestionFilePaths(suggestions, []);
      expect(result).toEqual(suggestions);
    });

    it('should return all suggestions when validPaths is null (with warning)', () => {
      const suggestions = [
        { file: 'src/foo.js', title: 'Test', type: 'bug' }
      ];
      const result = analyzer.validateSuggestionFilePaths(suggestions, null);
      expect(result).toEqual(suggestions);
    });
  });

  describe('path matching', () => {
    it('should keep suggestions with valid file paths', () => {
      const suggestions = [
        { file: 'src/foo.js', title: 'Test 1', type: 'bug' },
        { file: 'src/bar.js', title: 'Test 2', type: 'improvement' }
      ];
      const validPaths = ['src/foo.js', 'src/bar.js', 'src/baz.js'];

      const result = analyzer.validateSuggestionFilePaths(suggestions, validPaths);

      expect(result).toHaveLength(2);
      expect(result[0].file).toBe('src/foo.js');
      expect(result[1].file).toBe('src/bar.js');
    });

    it('should filter out suggestions with invalid file paths', () => {
      const suggestions = [
        { file: 'src/foo.js', title: 'Valid', type: 'bug' },
        { file: 'src/invalid.js', title: 'Invalid', type: 'improvement' },
        { file: 'src/bar.js', title: 'Also Valid', type: 'suggestion' }
      ];
      const validPaths = ['src/foo.js', 'src/bar.js'];

      const result = analyzer.validateSuggestionFilePaths(suggestions, validPaths);

      expect(result).toHaveLength(2);
      expect(result.map(s => s.file)).toEqual(['src/foo.js', 'src/bar.js']);
    });

    it('should filter out all suggestions when none match valid paths', () => {
      const suggestions = [
        { file: 'src/invalid1.js', title: 'Invalid 1', type: 'bug' },
        { file: 'src/invalid2.js', title: 'Invalid 2', type: 'bug' }
      ];
      const validPaths = ['src/foo.js', 'src/bar.js'];

      const result = analyzer.validateSuggestionFilePaths(suggestions, validPaths);

      expect(result).toHaveLength(0);
    });
  });

  describe('path normalization', () => {
    it('should match paths with leading ./ in suggestion', () => {
      const suggestions = [
        { file: './src/foo.js', title: 'Test', type: 'bug' }
      ];
      const validPaths = ['src/foo.js'];

      const result = analyzer.validateSuggestionFilePaths(suggestions, validPaths);

      expect(result).toHaveLength(1);
    });

    it('should match paths with leading ./ in valid paths', () => {
      const suggestions = [
        { file: 'src/foo.js', title: 'Test', type: 'bug' }
      ];
      const validPaths = ['./src/foo.js'];

      const result = analyzer.validateSuggestionFilePaths(suggestions, validPaths);

      expect(result).toHaveLength(1);
    });

    it('should match paths with leading / in suggestion', () => {
      const suggestions = [
        { file: '/src/foo.js', title: 'Test', type: 'bug' }
      ];
      const validPaths = ['src/foo.js'];

      const result = analyzer.validateSuggestionFilePaths(suggestions, validPaths);

      expect(result).toHaveLength(1);
    });

    it('should match paths with double slashes', () => {
      const suggestions = [
        { file: 'src//foo.js', title: 'Test', type: 'bug' }
      ];
      const validPaths = ['src/foo.js'];

      const result = analyzer.validateSuggestionFilePaths(suggestions, validPaths);

      expect(result).toHaveLength(1);
    });

    it('should match paths with mixed normalization issues', () => {
      const suggestions = [
        { file: './src//foo.js', title: 'Test 1', type: 'bug' },
        { file: '/./src/bar.js', title: 'Test 2', type: 'improvement' }
      ];
      const validPaths = ['src/foo.js', './src/bar.js'];

      const result = analyzer.validateSuggestionFilePaths(suggestions, validPaths);

      expect(result).toHaveLength(2);
    });
  });

  describe('edge cases', () => {
    it('should handle suggestions with empty file paths', () => {
      const suggestions = [
        { file: '', title: 'Empty path', type: 'bug' },
        { file: 'src/foo.js', title: 'Valid', type: 'bug' }
      ];
      const validPaths = ['src/foo.js'];

      const result = analyzer.validateSuggestionFilePaths(suggestions, validPaths);

      expect(result).toHaveLength(1);
      expect(result[0].file).toBe('src/foo.js');
    });

    it('should handle suggestions with null file paths', () => {
      const suggestions = [
        { file: null, title: 'Null path', type: 'bug' },
        { file: 'src/foo.js', title: 'Valid', type: 'bug' }
      ];
      const validPaths = ['src/foo.js'];

      const result = analyzer.validateSuggestionFilePaths(suggestions, validPaths);

      expect(result).toHaveLength(1);
      expect(result[0].file).toBe('src/foo.js');
    });

    it('should preserve suggestion properties', () => {
      const suggestions = [
        {
          file: 'src/foo.js',
          title: 'Test Title',
          type: 'bug',
          description: 'Test description',
          line_start: 10,
          line_end: 15,
          confidence: 0.9
        }
      ];
      const validPaths = ['src/foo.js'];

      const result = analyzer.validateSuggestionFilePaths(suggestions, validPaths);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(suggestions[0]);
    });
  });
});
