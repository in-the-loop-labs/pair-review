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

/**
 * Helper to create a better-sqlite3 compatible mock database.
 *
 * Usage:
 *   const { mockDb, runCalls, getCalls } = createBetterSqliteMock();
 *   // Configure get results:
 *   mockDb.setGetResult({ pr_data: '...' });
 *   // After test:
 *   expect(runCalls).toHaveLength(2);
 *   expect(runCalls[0].params[6]).toBe('src/foo.js');
 */
function createBetterSqliteMock() {
  const runCalls = [];
  const getCalls = [];
  const allCalls = [];

  let getResult = null;
  let allResult = [];

  const mockDb = {
    prepare: vi.fn((sql) => ({
      run: vi.fn((...params) => {
        runCalls.push({ sql, params });
        return { changes: 1, lastInsertRowid: runCalls.length };
      }),
      get: vi.fn((...params) => {
        getCalls.push({ sql, params });
        return getResult;
      }),
      all: vi.fn((...params) => {
        allCalls.push({ sql, params });
        return allResult;
      })
    })),
    setGetResult: (result) => { getResult = result; },
    setAllResult: (result) => { allResult = result; }
  };

  return { mockDb, runCalls, getCalls, allCalls };
}

describe('Analyzer.storeSuggestions database failsafe filter', () => {
  let analyzer;
  let mockDb;
  let runCalls;
  let warnSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create a mock database object using better-sqlite3's API
    const mock = createBetterSqliteMock();
    mockDb = mock.mockDb;
    runCalls = mock.runCalls;
    analyzer = new Analyzer(mockDb, 'sonnet', 'claude');
    // Spy on logger.warn
    warnSpy = vi.spyOn(logger, 'warn');
  });

  describe('filtering suggestions with invalid paths', () => {
    it('should filter out suggestions with paths not in PR diff', async () => {
      // Mock the PR metadata with valid file paths
      mockDb.setGetResult({
        pr_data: JSON.stringify({
          changed_files: ['src/valid.js', 'src/also-valid.js']
        })
      });

      const suggestions = [
        { file: 'src/valid.js', title: 'Valid', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 },
        { file: 'src/invalid.js', title: 'Invalid', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 },
        { file: 'src/also-valid.js', title: 'Also Valid', type: 'improvement', description: 'Test', line_start: 5, line_end: 5, confidence: 0.9 }
      ];

      await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

      // Should have called run twice (once for each valid suggestion)
      expect(runCalls).toHaveLength(2);

      // Verify the valid suggestions were stored - file is the 7th param (index 6) in the params array
      const storedFiles = runCalls.map(call => call.params[6]);
      expect(storedFiles).toContain('src/valid.js');
      expect(storedFiles).toContain('src/also-valid.js');
      expect(storedFiles).not.toContain('src/invalid.js');

      // Should log a warning about filtered suggestions
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[FAILSAFE] Filtered AI suggestion with invalid path')
      );
    });

    it('should filter all suggestions when none match valid paths', async () => {
      mockDb.setGetResult({
        pr_data: JSON.stringify({
          changed_files: ['src/real-file.js']
        })
      });

      const suggestions = [
        { file: 'src/fake1.js', title: 'Fake 1', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 },
        { file: 'src/fake2.js', title: 'Fake 2', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 }
      ];

      await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

      // Should not have stored any suggestions
      expect(runCalls).toHaveLength(0);

      // Should log warnings about filtered suggestions
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[FAILSAFE] Filtered 2 suggestions with invalid file paths')
      );
    });

    it('should handle path normalization in failsafe filter', async () => {
      mockDb.setGetResult({
        pr_data: JSON.stringify({
          changed_files: ['src/foo.js']
        })
      });

      const suggestions = [
        { file: './src/foo.js', title: 'With leading ./', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 },
        { file: '/src/foo.js', title: 'With leading /', type: 'bug', description: 'Test', line_start: 2, line_end: 2, confidence: 0.8 },
        { file: 'src//foo.js', title: 'With double slash', type: 'bug', description: 'Test', line_start: 3, line_end: 3, confidence: 0.8 }
      ];

      await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

      // All three should be stored (they all normalize to src/foo.js)
      expect(runCalls).toHaveLength(3);
    });

    it('should allow all suggestions when PR metadata is missing (fail-open)', async () => {
      // Mock missing PR metadata - leave default null
      mockDb.setGetResult(null);

      const suggestions = [
        { file: 'any/file.js', title: 'Test', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 }
      ];

      await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

      // Should store the suggestion (fail-open behavior)
      expect(runCalls).toHaveLength(1);

      // Should log a warning about bypassed validation
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[FAILSAFE] Path validation bypassed')
      );
    });

    it('should allow all suggestions when changed_files is empty (fail-open)', async () => {
      mockDb.setGetResult({
        pr_data: JSON.stringify({
          changed_files: []
        })
      });

      const suggestions = [
        { file: 'any/file.js', title: 'Test', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 }
      ];

      await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

      // Should store the suggestion (fail-open behavior)
      expect(runCalls).toHaveLength(1);

      // Should log a warning about bypassed validation
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[FAILSAFE] Path validation bypassed')
      );
    });

    it('should handle changed_files as objects with file property', async () => {
      mockDb.setGetResult({
        pr_data: JSON.stringify({
          changed_files: [
            { file: 'src/valid.js', additions: 10, deletions: 5 },
            { file: 'src/also-valid.js', additions: 3, deletions: 0 }
          ]
        })
      });

      const suggestions = [
        { file: 'src/valid.js', title: 'Valid', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 },
        { file: 'src/invalid.js', title: 'Invalid', type: 'bug', description: 'Test', line_start: 1, line_end: 1, confidence: 0.8 }
      ];

      await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

      // Should only store the valid suggestion
      expect(runCalls).toHaveLength(1);
      expect(runCalls[0].params[6]).toBe('src/valid.js');
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

describe('Analyzer.validateFileLevelSuggestions', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new Analyzer({}, 'sonnet', 'claude');
  });

  it('should return empty array for null input', () => {
    const result = analyzer.validateFileLevelSuggestions(null);
    expect(result).toEqual([]);
  });

  it('should return empty array for undefined input', () => {
    const result = analyzer.validateFileLevelSuggestions(undefined);
    expect(result).toEqual([]);
  });

  it('should return empty array for non-array input', () => {
    const result = analyzer.validateFileLevelSuggestions('not an array');
    expect(result).toEqual([]);
  });

  it('should validate file-level suggestions without line numbers', () => {
    const suggestions = [
      {
        file: 'src/foo.js',
        type: 'design',
        title: 'Consider restructuring this file',
        description: 'This file has grown large and could benefit from being split.',
        confidence: 0.8
      }
    ];

    const result = analyzer.validateFileLevelSuggestions(suggestions);

    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('src/foo.js');
    expect(result[0].line_start).toBeNull();
    expect(result[0].line_end).toBeNull();
    expect(result[0].is_file_level).toBe(true);
    expect(result[0].type).toBe('design');
  });

  it('should filter out suggestions missing required fields', () => {
    const suggestions = [
      { file: 'src/foo.js', type: 'design', confidence: 0.8 }, // missing title
      { type: 'design', title: 'Test', confidence: 0.8 }, // missing file
      { file: 'src/bar.js', title: 'Test', confidence: 0.8 }, // missing type
      { file: 'src/valid.js', type: 'suggestion', title: 'Valid suggestion', confidence: 0.8 } // valid
    ];

    const result = analyzer.validateFileLevelSuggestions(suggestions);

    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('src/valid.js');
  });

  it('should filter out low confidence suggestions', () => {
    const suggestions = [
      {
        file: 'src/foo.js',
        type: 'design',
        title: 'Low confidence suggestion',
        description: 'Test',
        confidence: 0.2
      },
      {
        file: 'src/bar.js',
        type: 'design',
        title: 'High confidence suggestion',
        description: 'Test',
        confidence: 0.8
      }
    ];

    const result = analyzer.validateFileLevelSuggestions(suggestions);

    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('src/bar.js');
  });

  it('should normalize title from description if missing', () => {
    const suggestions = [
      {
        file: 'src/foo.js',
        type: 'design',
        description: 'This is the first sentence. This is more detail.',
        confidence: 0.8
      }
    ];

    const result = analyzer.validateFileLevelSuggestions(suggestions);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('This is the first sentence');
  });

  it('should filter out suggestions without confidence (low quality)', () => {
    const suggestions = [
      {
        file: 'src/foo.js',
        type: 'design',
        title: 'Test without confidence'
        // No confidence provided - should be filtered
      },
      {
        file: 'src/bar.js',
        type: 'design',
        title: 'Test with zero confidence',
        confidence: 0
      },
      {
        file: 'src/baz.js',
        type: 'design',
        title: 'Test with valid confidence',
        confidence: 0.5
      }
    ];

    const result = analyzer.validateFileLevelSuggestions(suggestions);

    // Only suggestion with valid confidence (> 0.3) should pass
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('src/baz.js');
    expect(result[0].confidence).toBe(0.5);
  });

  it('should set old_or_new to null for file-level suggestions', () => {
    const suggestions = [
      {
        file: 'src/foo.js',
        type: 'design',
        title: 'File-level concern',
        description: 'Test',
        confidence: 0.8
      }
    ];

    const result = analyzer.validateFileLevelSuggestions(suggestions);

    expect(result).toHaveLength(1);
    expect(result[0].old_or_new).toBeNull();
  });
});

describe('Analyzer.validateSuggestions old_or_new field', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new Analyzer({}, 'sonnet', 'claude');
  });

  it('should preserve old_or_new=OLD from AI response', () => {
    const suggestions = [
      {
        file: 'src/foo.js',
        line: 10,
        old_or_new: 'OLD',
        type: 'bug',
        title: 'Issue on deleted line',
        description: 'Test',
        confidence: 0.8
      }
    ];

    const result = analyzer.validateSuggestions(suggestions);

    expect(result).toHaveLength(1);
    expect(result[0].old_or_new).toBe('OLD');
  });

  it('should preserve old_or_new=NEW from AI response', () => {
    const suggestions = [
      {
        file: 'src/foo.js',
        line: 10,
        old_or_new: 'NEW',
        type: 'bug',
        title: 'Issue on added line',
        description: 'Test',
        confidence: 0.8
      }
    ];

    const result = analyzer.validateSuggestions(suggestions);

    expect(result).toHaveLength(1);
    expect(result[0].old_or_new).toBe('NEW');
  });

  it('should default old_or_new to NEW when not specified', () => {
    const suggestions = [
      {
        file: 'src/foo.js',
        line: 10,
        // old_or_new not specified
        type: 'bug',
        title: 'Some issue',
        description: 'Test',
        confidence: 0.8
      }
    ];

    const result = analyzer.validateSuggestions(suggestions);

    expect(result).toHaveLength(1);
    expect(result[0].old_or_new).toBe('NEW');
  });
});

describe('Analyzer.parseResponse with file-level suggestions', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new Analyzer({}, 'sonnet', 'claude');
  });

  it('should parse both line-level and file-level suggestions from response object', () => {
    const response = {
      suggestions: [
        { file: 'src/foo.js', line: 10, type: 'bug', title: 'Line issue', confidence: 0.8 }
      ],
      fileLevelSuggestions: [
        { file: 'src/foo.js', type: 'design', title: 'File issue', confidence: 0.8 }
      ]
    };

    const result = analyzer.parseResponse(response, 2);

    expect(result).toHaveLength(2);
    // Line-level suggestion
    expect(result[0].line_start).toBe(10);
    expect(result[0].is_file_level).toBeUndefined();
    // File-level suggestion
    expect(result[1].line_start).toBeNull();
    expect(result[1].is_file_level).toBe(true);
  });

  it('should handle response with only line-level suggestions', () => {
    const response = {
      suggestions: [
        { file: 'src/foo.js', line: 10, type: 'bug', title: 'Line issue', confidence: 0.8 }
      ]
    };

    const result = analyzer.parseResponse(response, 2);

    expect(result).toHaveLength(1);
    expect(result[0].line_start).toBe(10);
  });

  it('should handle response with only file-level suggestions', () => {
    const response = {
      suggestions: [],
      fileLevelSuggestions: [
        { file: 'src/foo.js', type: 'design', title: 'File issue', confidence: 0.8 }
      ]
    };

    const result = analyzer.parseResponse(response, 2);

    expect(result).toHaveLength(1);
    expect(result[0].is_file_level).toBe(true);
  });
});

describe('Analyzer.storeSuggestions with file-level suggestions', () => {
  let analyzer;
  let mockDb;
  let runCalls;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createBetterSqliteMock();
    mockDb = mock.mockDb;
    runCalls = mock.runCalls;
    // Configure default PR metadata with valid file path
    mockDb.setGetResult({
      pr_data: JSON.stringify({
        changed_files: ['src/foo.js']
      })
    });
    analyzer = new Analyzer(mockDb, 'sonnet', 'claude');
  });

  it('should set is_file_level=1 for file-level suggestions', async () => {
    const suggestions = [
      {
        file: 'src/foo.js',
        line_start: null,
        line_end: null,
        type: 'design',
        title: 'File-level concern',
        description: 'Test',
        confidence: 0.8,
        is_file_level: true
      }
    ];

    await analyzer.storeSuggestions(1, 'run-123', suggestions, 2);

    expect(runCalls).toHaveLength(1);
    // Parameter indices after adding 'side' at index 9:
    // 0:pr_id, 1:source, 2:author, 3:ai_run_id, 4:ai_level, 5:ai_confidence,
    // 6:file, 7:line_start, 8:line_end, 9:side, 10:type, 11:title, 12:body, 13:status, 14:is_file_level
    const params = runCalls[0].params;
    expect(params[14]).toBe(1); // is_file_level should be 1
    expect(params[7]).toBeNull(); // line_start should be null
    expect(params[8]).toBeNull(); // line_end should be null
    expect(params[9]).toBe('RIGHT'); // side defaults to RIGHT for file-level (null old_or_new)
  });

  it('should set is_file_level=0 for line-level suggestions', async () => {
    const suggestions = [
      {
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'bug',
        title: 'Line-level concern',
        description: 'Test',
        confidence: 0.8
      }
    ];

    await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

    expect(runCalls).toHaveLength(1);
    const params = runCalls[0].params;
    expect(params[14]).toBe(0); // is_file_level should be 0
    expect(params[7]).toBe(10); // line_start should be 10
    expect(params[9]).toBe('RIGHT'); // side defaults to RIGHT (NEW is default)
  });

  it('should handle mixed line-level and file-level suggestions', async () => {
    const suggestions = [
      {
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'bug',
        title: 'Line issue',
        description: 'Test',
        confidence: 0.8
      },
      {
        file: 'src/foo.js',
        line_start: null,
        line_end: null,
        type: 'design',
        title: 'File issue',
        description: 'Test',
        confidence: 0.8,
        is_file_level: true
      }
    ];

    await analyzer.storeSuggestions(1, 'run-123', suggestions, 2);

    expect(runCalls).toHaveLength(2);
    // First call (line-level)
    expect(runCalls[0].params[14]).toBe(0);
    // Second call (file-level)
    expect(runCalls[1].params[14]).toBe(1);
  });

  it('should map old_or_new=OLD to side=LEFT', async () => {
    const suggestions = [
      {
        file: 'src/foo.js',
        line_start: 10,
        line_end: 10,
        old_or_new: 'OLD',
        type: 'bug',
        title: 'Deleted line issue',
        description: 'Issue on deleted line',
        confidence: 0.8
      }
    ];

    await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

    expect(runCalls).toHaveLength(1);
    const params = runCalls[0].params;
    expect(params[9]).toBe('LEFT'); // side should be LEFT for OLD
  });

  it('should map old_or_new=NEW to side=RIGHT', async () => {
    const suggestions = [
      {
        file: 'src/foo.js',
        line_start: 10,
        line_end: 10,
        old_or_new: 'NEW',
        type: 'bug',
        title: 'Added line issue',
        description: 'Issue on added line',
        confidence: 0.8
      }
    ];

    await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

    expect(runCalls).toHaveLength(1);
    const params = runCalls[0].params;
    expect(params[9]).toBe('RIGHT'); // side should be RIGHT for NEW
  });

  it('should default to side=RIGHT when old_or_new is not specified', async () => {
    const suggestions = [
      {
        file: 'src/foo.js',
        line_start: 10,
        line_end: 10,
        // old_or_new not specified
        type: 'bug',
        title: 'Line issue',
        description: 'Issue',
        confidence: 0.8
      }
    ];

    await analyzer.storeSuggestions(1, 'run-123', suggestions, 1);

    expect(runCalls).toHaveLength(1);
    const params = runCalls[0].params;
    expect(params[9]).toBe('RIGHT'); // side defaults to RIGHT
  });
});

describe('Analyzer.getAnnotatedDiffScriptPath', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new Analyzer({}, 'sonnet', 'claude');
  });

  it('should return an absolute path', () => {
    const result = analyzer.getAnnotatedDiffScriptPath();
    expect(result.startsWith('/')).toBe(true);
  });

  it('should return path ending with bin/git-diff-lines', () => {
    const result = analyzer.getAnnotatedDiffScriptPath();
    expect(result.endsWith('bin/git-diff-lines')).toBe(true);
  });
});

describe('Analyzer.buildLineNumberGuidance', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new Analyzer({}, 'sonnet', 'claude');
  });

  it('should return markdown formatted guidance', () => {
    const result = analyzer.buildLineNumberGuidance();
    expect(result).toContain('## Viewing Code Changes');
    expect(result).toContain('## Line Number Precision');
  });

  it('should include the script path in the output', () => {
    const result = analyzer.buildLineNumberGuidance();
    const scriptPath = analyzer.getAnnotatedDiffScriptPath();
    expect(result).toContain(scriptPath);
  });

  it('should include line number column explanations', () => {
    const result = analyzer.buildLineNumberGuidance();
    expect(result).toContain('OLD | NEW');
    expect(result).toContain('[+]');
    expect(result).toContain('[-]');
  });

  it('should include guidance for each line type', () => {
    const result = analyzer.buildLineNumberGuidance();
    expect(result).toContain('ADDED lines [+]: use the NEW column number');
    expect(result).toContain('CONTEXT lines: use the NEW column number');
    expect(result).toContain('DELETED lines [-]: use the OLD column number');
  });

  describe('--cwd option handling', () => {
    it('should include --cwd option when worktreePath is provided', () => {
      const worktreePath = '/path/to/worktree';
      const result = analyzer.buildLineNumberGuidance(worktreePath);

      expect(result).toContain('--cwd "/path/to/worktree"');
    });

    it('should omit --cwd when worktreePath is null', () => {
      const result = analyzer.buildLineNumberGuidance(null);

      // Should contain the script path but not --cwd
      const scriptPath = analyzer.getAnnotatedDiffScriptPath();
      expect(result).toContain(scriptPath);
      expect(result).not.toContain('--cwd');
    });

    it('should omit --cwd when worktreePath is undefined (default)', () => {
      const result = analyzer.buildLineNumberGuidance();

      expect(result).not.toContain('--cwd');
    });

    it('should omit --cwd when worktreePath is empty string', () => {
      const result = analyzer.buildLineNumberGuidance('');

      expect(result).not.toContain('--cwd');
    });

    it('should properly quote worktreePath in the command', () => {
      const worktreePath = '/path/with spaces/to/worktree';
      const result = analyzer.buildLineNumberGuidance(worktreePath);

      // The path should be quoted to handle spaces
      expect(result).toContain('--cwd "/path/with spaces/to/worktree"');
    });

    it('should include --cwd in both the command block and example usage', () => {
      const worktreePath = '/my/worktree';
      const result = analyzer.buildLineNumberGuidance(worktreePath);
      const scriptPath = analyzer.getAnnotatedDiffScriptPath();

      // The command with --cwd should appear in the code block
      const fullCommand = `${scriptPath} --cwd "/my/worktree"`;
      expect(result).toContain(fullCommand);

      // It should also appear in the example usage lines
      expect(result).toContain(`${fullCommand} HEAD~1`);
      expect(result).toContain(`${fullCommand} -- src/`);
    });

    it('should format command correctly with typical worktree path', () => {
      const worktreePath = '/Users/dev/.pair-review/worktrees/pr-123';
      const result = analyzer.buildLineNumberGuidance(worktreePath);
      const scriptPath = analyzer.getAnnotatedDiffScriptPath();

      const expectedCommand = `${scriptPath} --cwd "/Users/dev/.pair-review/worktrees/pr-123"`;
      expect(result).toContain(expectedCommand);
    });
  });
});

describe('Analyzer.buildFileLineCountsSection', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new Analyzer({}, 'sonnet', 'claude');
  });

  it('should return empty string for null map', () => {
    const result = analyzer.buildFileLineCountsSection(null);
    expect(result).toBe('');
  });

  it('should return empty string for empty map', () => {
    const result = analyzer.buildFileLineCountsSection(new Map());
    expect(result).toBe('');
  });

  it('should format files with line counts', () => {
    const map = new Map([
      ['src/foo.js', 50],
      ['src/bar.js', 100]
    ]);
    const result = analyzer.buildFileLineCountsSection(map);
    expect(result).toContain('- src/foo.js: 50 lines');
    expect(result).toContain('- src/bar.js: 100 lines');
  });

  it('should include empty files with special notation', () => {
    const map = new Map([
      ['src/empty.js', 0],
      ['src/normal.js', 10]
    ]);
    const result = analyzer.buildFileLineCountsSection(map);
    expect(result).toContain('- src/empty.js: 0 lines (empty file)');
    expect(result).toContain('- src/normal.js: 10 lines');
  });

  it('should skip binary/missing files (lineCount === -1)', () => {
    const map = new Map([
      ['image.png', -1],
      ['src/code.js', 25]
    ]);
    const result = analyzer.buildFileLineCountsSection(map);
    expect(result).not.toContain('image.png');
    expect(result).toContain('- src/code.js: 25 lines');
  });

  it('should include validation instructions', () => {
    const map = new Map([['src/foo.js', 10]]);
    const result = analyzer.buildFileLineCountsSection(map);
    expect(result).toContain('Verify that all suggestion line numbers are within these bounds');
    expect(result).toContain('file-level suggestion');
  });

  it('should handle map with only binary files', () => {
    const map = new Map([
      ['image.png', -1],
      ['data.bin', -1]
    ]);
    const result = analyzer.buildFileLineCountsSection(map);
    // Should still have header but no file entries
    expect(result).toContain('## File Line Counts for Validation');
    expect(result).not.toContain('image.png');
    expect(result).not.toContain('data.bin');
  });
});

describe('Analyzer.validateAndFinalizeSuggestions', () => {
  let analyzer;
  let warnSpy;
  let infoSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    analyzer = new Analyzer({}, 'sonnet', 'claude');
    warnSpy = vi.spyOn(logger, 'warn');
    infoSpy = vi.spyOn(logger, 'info');
  });

  it('should validate suggestions through both file path and line number validation', () => {
    const suggestions = [
      { file: 'src/valid.js', line_start: 5, line_end: 10, title: 'Valid suggestion', type: 'bug' }
    ];
    const fileLineCountMap = new Map([['src/valid.js', 100]]);
    const validFiles = ['src/valid.js'];

    const result = analyzer.validateAndFinalizeSuggestions(suggestions, fileLineCountMap, validFiles);

    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('src/valid.js');
  });

  it('should filter out suggestions with invalid file paths', () => {
    const suggestions = [
      { file: 'src/valid.js', line_start: 5, line_end: 10, title: 'Valid', type: 'bug' },
      { file: 'src/invalid.js', line_start: 5, line_end: 10, title: 'Invalid path', type: 'bug' }
    ];
    const fileLineCountMap = new Map([['src/valid.js', 100]]);
    const validFiles = ['src/valid.js'];

    const result = analyzer.validateAndFinalizeSuggestions(suggestions, fileLineCountMap, validFiles);

    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('src/valid.js');
  });

  it('should convert suggestions with invalid line numbers to file-level', () => {
    const suggestions = [
      { file: 'src/foo.js', line_start: 500, line_end: 510, title: 'Invalid lines', type: 'bug' }
    ];
    const fileLineCountMap = new Map([['src/foo.js', 100]]);
    const validFiles = ['src/foo.js'];

    const result = analyzer.validateAndFinalizeSuggestions(suggestions, fileLineCountMap, validFiles);

    expect(result).toHaveLength(1);
    expect(result[0].line_start).toBeNull();
    expect(result[0].line_end).toBeNull();
    expect(result[0].is_file_level).toBe(true);
  });

  it('should log info about validation steps', () => {
    const suggestions = [
      { file: 'src/foo.js', line_start: 5, line_end: 10, title: 'Test', type: 'bug' }
    ];
    const fileLineCountMap = new Map([['src/foo.js', 100]]);
    const validFiles = ['src/foo.js'];

    analyzer.validateAndFinalizeSuggestions(suggestions, fileLineCountMap, validFiles);

    expect(infoSpy).toHaveBeenCalledWith('[Validation] Starting validation with 1 input suggestions');
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('[Validation] Final:'));
  });

  it('should log warning when all suggestions are filtered out', () => {
    const suggestions = [
      { file: 'src/invalid.js', line_start: 5, line_end: 10, title: 'Invalid', type: 'bug' }
    ];
    const fileLineCountMap = new Map([['src/valid.js', 100]]);
    const validFiles = ['src/valid.js'];

    const result = analyzer.validateAndFinalizeSuggestions(suggestions, fileLineCountMap, validFiles);

    expect(result).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith('[Validation] WARNING: All 1 suggestions were filtered out!');
  });

  it('should log filtering breakdown when suggestions are filtered', () => {
    const suggestions = [
      { file: 'src/invalid.js', line_start: 5, line_end: 10, title: 'Invalid path', type: 'bug' },
      { file: 'src/valid.js', line_start: 5, line_end: 10, title: 'Valid', type: 'bug' }
    ];
    const fileLineCountMap = new Map([['src/valid.js', 100]]);
    const validFiles = ['src/valid.js'];

    analyzer.validateAndFinalizeSuggestions(suggestions, fileLineCountMap, validFiles);

    expect(infoSpy).toHaveBeenCalledWith('[Validation] After file path validation: 1 suggestions (1 filtered)');
  });

  it('should handle empty suggestions array', () => {
    const result = analyzer.validateAndFinalizeSuggestions([], new Map(), []);
    expect(result).toEqual([]);
  });

  it('should handle null suggestions', () => {
    const result = analyzer.validateAndFinalizeSuggestions(null, new Map(), []);
    expect(result).toEqual([]);
  });
});
