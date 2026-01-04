import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the dependencies before importing the Analyzer
vi.mock('../../src/ai/index', () => ({
  createProvider: vi.fn()
}));

vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({ getPatterns: () => [] })
}));

// Import the logger so we can spy on it
const logger = require('../../src/utils/logger');

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

describe('Analyzer.storeSuggestions database failsafe filter', () => {
  let analyzer;
  let mockDb;
  let warnSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create a mock database object with run and get methods
    mockDb = {
      run: vi.fn((sql, params, callback) => callback(null)),
      get: vi.fn((sql, params, callback) => callback(null, null))
    };
    analyzer = new Analyzer(mockDb, 'sonnet', 'claude');
    // Spy on logger.warn
    warnSpy = vi.spyOn(logger, 'warn');
  });

  describe('filtering suggestions with invalid paths', () => {
    it('should filter out suggestions with paths not in PR diff', async () => {
      // Mock the PR metadata with valid file paths
      mockDb.get.mockImplementation((sql, params, callback) => {
        callback(null, {
          pr_data: JSON.stringify({
            changed_files: ['src/valid.js', 'src/also-valid.js']
          })
        });
      });

      const suggestions = [
        { file: 'src/valid.js', title: 'Valid', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 },
        { file: 'src/invalid.js', title: 'Invalid', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 },
        { file: 'src/also-valid.js', title: 'Also Valid', type: 'improvement', description: 'Test', line_start: 5, line_end: 5, confidence: 0.9 }
      ];

      await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

      // Should have called run twice (once for each valid suggestion)
      expect(mockDb.run).toHaveBeenCalledTimes(2);

      // Verify the valid suggestions were stored - file is the 7th param (index 6) in the params array
      const storedFiles = mockDb.run.mock.calls.map(call => call[1][6]);
      expect(storedFiles).toContain('src/valid.js');
      expect(storedFiles).toContain('src/also-valid.js');
      expect(storedFiles).not.toContain('src/invalid.js');

      // Should log a warning about filtered suggestions
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[FAILSAFE] Filtered AI suggestion with invalid path')
      );
    });

    it('should filter all suggestions when none match valid paths', async () => {
      mockDb.get.mockImplementation((sql, params, callback) => {
        callback(null, {
          pr_data: JSON.stringify({
            changed_files: ['src/real-file.js']
          })
        });
      });

      const suggestions = [
        { file: 'src/fake1.js', title: 'Fake 1', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 },
        { file: 'src/fake2.js', title: 'Fake 2', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 }
      ];

      await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

      // Should not have stored any suggestions
      expect(mockDb.run).not.toHaveBeenCalled();

      // Should log warnings about filtered suggestions
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[FAILSAFE] Filtered 2 suggestions with invalid file paths')
      );
    });

    it('should handle path normalization in failsafe filter', async () => {
      mockDb.get.mockImplementation((sql, params, callback) => {
        callback(null, {
          pr_data: JSON.stringify({
            changed_files: ['src/foo.js']
          })
        });
      });

      const suggestions = [
        { file: './src/foo.js', title: 'With leading ./', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 },
        { file: '/src/foo.js', title: 'With leading /', type: 'bug', description: 'Test', line_start: 2, line_end: 2, confidence: 0.8 },
        { file: 'src//foo.js', title: 'With double slash', type: 'bug', description: 'Test', line_start: 3, line_end: 3, confidence: 0.8 }
      ];

      await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

      // All three should be stored (they all normalize to src/foo.js)
      expect(mockDb.run).toHaveBeenCalledTimes(3);
    });

    it('should allow all suggestions when PR metadata is missing (fail-open)', async () => {
      // Mock missing PR metadata
      mockDb.get.mockImplementation((sql, params, callback) => {
        callback(null, null);
      });

      const suggestions = [
        { file: 'any/file.js', title: 'Test', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 }
      ];

      await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

      // Should store the suggestion (fail-open behavior)
      expect(mockDb.run).toHaveBeenCalledTimes(1);

      // Should log a warning about bypassed validation
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[FAILSAFE] Path validation bypassed')
      );
    });

    it('should allow all suggestions when changed_files is empty (fail-open)', async () => {
      mockDb.get.mockImplementation((sql, params, callback) => {
        callback(null, {
          pr_data: JSON.stringify({
            changed_files: []
          })
        });
      });

      const suggestions = [
        { file: 'any/file.js', title: 'Test', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 }
      ];

      await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

      // Should store the suggestion (fail-open behavior)
      expect(mockDb.run).toHaveBeenCalledTimes(1);

      // Should log a warning about bypassed validation
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[FAILSAFE] Path validation bypassed')
      );
    });

    it('should handle changed_files as objects with file property', async () => {
      mockDb.get.mockImplementation((sql, params, callback) => {
        callback(null, {
          pr_data: JSON.stringify({
            changed_files: [
              { file: 'src/valid.js', additions: 10, deletions: 5 },
              { file: 'src/also-valid.js', additions: 3, deletions: 0 }
            ]
          })
        });
      });

      const suggestions = [
        { file: 'src/valid.js', title: 'Valid', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 },
        { file: 'src/invalid.js', title: 'Invalid', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 }
      ];

      await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

      // Should only store the valid suggestion
      expect(mockDb.run).toHaveBeenCalledTimes(1);
      expect(mockDb.run.mock.calls[0][1][6]).toBe('src/valid.js');
    });
  });

  describe('isValidSuggestionPath', () => {
    it('should return true for valid paths in Set', () => {
      const validPathsSet = new Set(['src/foo.js', 'src/bar.js']);
      expect(analyzer.isValidSuggestionPath('src/foo.js', validPathsSet)).toBe(true);
    });

    it('should return false for invalid paths in Set', () => {
      const validPathsSet = new Set(['src/foo.js', 'src/bar.js']);
      expect(analyzer.isValidSuggestionPath('src/invalid.js', validPathsSet)).toBe(false);
    });

    it('should normalize paths when checking against Set', () => {
      const validPathsSet = new Set(['src/foo.js']);
      expect(analyzer.isValidSuggestionPath('./src/foo.js', validPathsSet)).toBe(true);
      expect(analyzer.isValidSuggestionPath('/src/foo.js', validPathsSet)).toBe(true);
    });

    it('should return true and log warning when validPaths is empty Set (fail-open)', () => {
      warnSpy.mockClear(); // Clear spy before this specific test
      const emptySet = new Set();
      expect(analyzer.isValidSuggestionPath('any/path.js', emptySet)).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[FAILSAFE] Path validation bypassed')
      );
    });

    it('should return true and log warning when validPaths is empty array (fail-open)', () => {
      warnSpy.mockClear(); // Clear spy before this specific test
      expect(analyzer.isValidSuggestionPath('any/path.js', [])).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[FAILSAFE] Path validation bypassed')
      );
    });

    it('should return false for null or empty suggestion path', () => {
      const validPathsSet = new Set(['src/foo.js']);
      expect(analyzer.isValidSuggestionPath(null, validPathsSet)).toBe(false);
      expect(analyzer.isValidSuggestionPath('', validPathsSet)).toBe(false);
      expect(analyzer.isValidSuggestionPath(undefined, validPathsSet)).toBe(false);
    });

    it('should work with array input (legacy support)', () => {
      const validPaths = ['src/foo.js', 'src/bar.js'];
      expect(analyzer.isValidSuggestionPath('src/foo.js', validPaths)).toBe(true);
      expect(analyzer.isValidSuggestionPath('src/invalid.js', validPaths)).toBe(false);
    });
  });
});
