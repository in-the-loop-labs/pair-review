import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Import the logger so we can spy on it
const logger = require('../../src/utils/logger');
const { buildFileLineCountMap, validateSuggestionLineNumbers } = require('../../src/utils/line-validation');

// Create a spy for logger.warn
let warnSpy;

describe('buildFileLineCountMap', () => {
  const testDir = '/tmp/line-validation-test-' + Date.now();

  beforeEach(async () => {
    // Create test directory
    await fs.promises.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    vi.clearAllMocks();
  });

  it('should return correct line counts for existing files', async () => {
    // Create test files
    await fs.promises.writeFile(path.join(testDir, 'one-line.js'), 'const x = 1;');
    await fs.promises.writeFile(path.join(testDir, 'three-lines.js'), 'line1\nline2\nline3');
    await fs.promises.writeFile(path.join(testDir, 'with-trailing-newline.js'), 'line1\nline2\n');

    const result = await buildFileLineCountMap(testDir, ['one-line.js', 'three-lines.js', 'with-trailing-newline.js']);

    expect(result.get('one-line.js')).toBe(1);
    expect(result.get('three-lines.js')).toBe(3);
    expect(result.get('with-trailing-newline.js')).toBe(2);
  });

  it('should return 0 for empty files', async () => {
    await fs.promises.writeFile(path.join(testDir, 'empty.js'), '');

    const result = await buildFileLineCountMap(testDir, ['empty.js']);

    expect(result.get('empty.js')).toBe(0);
  });

  it('should handle missing files gracefully with -1', async () => {
    const result = await buildFileLineCountMap(testDir, ['nonexistent.js']);

    expect(result.get('nonexistent.js')).toBe(-1);
  });

  it('should handle read errors gracefully', async () => {
    // Create a directory instead of a file (reading it will fail)
    await fs.promises.mkdir(path.join(testDir, 'not-a-file'));

    const result = await buildFileLineCountMap(testDir, ['not-a-file']);

    expect(result.get('not-a-file')).toBe(-1);
  });

  it('should handle binary files by returning -1', async () => {
    // Create a file with null bytes (binary indicator)
    const binaryContent = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]);
    await fs.promises.writeFile(path.join(testDir, 'binary.bin'), binaryContent);

    const result = await buildFileLineCountMap(testDir, ['binary.bin']);

    expect(result.get('binary.bin')).toBe(-1);
  });

  it('should return empty map for null validFiles', async () => {
    const result = await buildFileLineCountMap(testDir, null);

    expect(result.size).toBe(0);
  });

  it('should return empty map for empty validFiles array', async () => {
    const result = await buildFileLineCountMap(testDir, []);

    expect(result.size).toBe(0);
  });

  it('should skip null or invalid file paths', async () => {
    await fs.promises.writeFile(path.join(testDir, 'valid.js'), 'const x = 1;');

    const result = await buildFileLineCountMap(testDir, [null, '', undefined, 'valid.js']);

    expect(result.size).toBe(1);
    expect(result.get('valid.js')).toBe(1);
  });

  it('should handle files in subdirectories', async () => {
    await fs.promises.mkdir(path.join(testDir, 'src'), { recursive: true });
    await fs.promises.writeFile(path.join(testDir, 'src', 'nested.js'), 'line1\nline2');

    const result = await buildFileLineCountMap(testDir, ['src/nested.js']);

    expect(result.get('src/nested.js')).toBe(2);
  });
});

describe('validateSuggestionLineNumbers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(logger, 'warn');
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('passing valid suggestions unchanged', () => {
    it('should pass valid suggestions unchanged', () => {
      const fileLineCountMap = new Map([['src/foo.js', 100]]);
      const suggestions = [
        { file: 'src/foo.js', line_start: 10, line_end: 20, title: 'Valid suggestion', type: 'bug' }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap);

      expect(result.valid).toHaveLength(1);
      expect(result.valid[0]).toEqual(suggestions[0]);
      expect(result.converted).toHaveLength(0);
      expect(result.dropped).toHaveLength(0);
    });

    it('should pass file-level suggestions unchanged', () => {
      const fileLineCountMap = new Map([['src/foo.js', 100]]);
      const suggestions = [
        { file: 'src/foo.js', line_start: null, line_end: null, title: 'File-level suggestion', type: 'design', is_file_level: true }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap);

      expect(result.valid).toHaveLength(1);
      expect(result.valid[0]).toEqual(suggestions[0]);
      expect(result.converted).toHaveLength(0);
      expect(result.dropped).toHaveLength(0);
    });

    it('should pass suggestions with undefined line_start (file-level) unchanged', () => {
      const fileLineCountMap = new Map([['src/foo.js', 100]]);
      const suggestions = [
        { file: 'src/foo.js', title: 'No line specified', type: 'suggestion' }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap);

      expect(result.valid).toHaveLength(1);
    });

    it('should pass suggestions for files not in map (might be deleted files)', () => {
      const fileLineCountMap = new Map([['src/foo.js', 100]]);
      const suggestions = [
        { file: 'src/deleted.js', line_start: 10, line_end: 20, title: 'Suggestion on deleted file', type: 'bug' }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap);

      expect(result.valid).toHaveLength(1);
      expect(result.valid[0]).toEqual(suggestions[0]);
    });

    it('should pass suggestions for binary files (lineCount === -1)', () => {
      const fileLineCountMap = new Map([['assets/image.png', -1]]);
      const suggestions = [
        { file: 'assets/image.png', line_start: 1, line_end: 1, title: 'Binary file suggestion', type: 'bug' }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap);

      expect(result.valid).toHaveLength(1);
    });
  });

  describe('detecting invalid line numbers', () => {
    it('should detect line_start > file length', () => {
      const fileLineCountMap = new Map([['src/foo.js', 50]]);
      const suggestions = [
        { file: 'src/foo.js', line_start: 100, line_end: 100, title: 'Invalid start line', type: 'bug' }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap);

      expect(result.valid).toHaveLength(0);
      expect(result.dropped).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dropping suggestion')
      );
    });

    it('should detect line_end > file length', () => {
      const fileLineCountMap = new Map([['src/foo.js', 50]]);
      const suggestions = [
        { file: 'src/foo.js', line_start: 10, line_end: 100, title: 'Invalid end line', type: 'bug' }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap);

      expect(result.valid).toHaveLength(0);
      expect(result.dropped).toHaveLength(1);
    });

    it('should detect line_start <= 0', () => {
      const fileLineCountMap = new Map([['src/foo.js', 50]]);
      const suggestions = [
        { file: 'src/foo.js', line_start: 0, line_end: 10, title: 'Zero start line', type: 'bug' },
        { file: 'src/foo.js', line_start: -5, line_end: 10, title: 'Negative start line', type: 'bug' }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap);

      expect(result.valid).toHaveLength(0);
      expect(result.dropped).toHaveLength(2);
    });

    it('should detect line_end < line_start', () => {
      const fileLineCountMap = new Map([['src/foo.js', 50]]);
      const suggestions = [
        { file: 'src/foo.js', line_start: 20, line_end: 10, title: 'End before start', type: 'bug' }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap);

      expect(result.valid).toHaveLength(0);
      expect(result.dropped).toHaveLength(1);
    });

    it('should handle suggestions with only line_start (no line_end)', () => {
      const fileLineCountMap = new Map([['src/foo.js', 50]]);
      const suggestions = [
        { file: 'src/foo.js', line_start: 10, title: 'Single line valid', type: 'bug' },
        { file: 'src/foo.js', line_start: 100, title: 'Single line invalid', type: 'bug' }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap);

      expect(result.valid).toHaveLength(1);
      expect(result.valid[0].title).toBe('Single line valid');
      expect(result.dropped).toHaveLength(1);
      expect(result.dropped[0].title).toBe('Single line invalid');
    });
  });

  describe('convertToFileLevel option', () => {
    it('should convert invalid suggestions to file-level when option is true', () => {
      const fileLineCountMap = new Map([['src/foo.js', 50]]);
      const suggestions = [
        { file: 'src/foo.js', line_start: 100, line_end: 100, title: 'Invalid line', type: 'bug', description: 'Test description', confidence: 0.8 }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap, { convertToFileLevel: true });

      expect(result.valid).toHaveLength(0);
      expect(result.converted).toHaveLength(1);
      expect(result.dropped).toHaveLength(0);

      const converted = result.converted[0];
      expect(converted.line_start).toBeNull();
      expect(converted.line_end).toBeNull();
      expect(converted.is_file_level).toBe(true);
      expect(converted.title).toBe('Invalid line');
      expect(converted.description).toBe('Test description');
      expect(converted.type).toBe('bug');
      expect(converted.confidence).toBe(0.8);
      expect(converted.file).toBe('src/foo.js');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Converting suggestion to file-level')
      );
    });

    it('should not include original line context in converted suggestion', () => {
      const fileLineCountMap = new Map([['src/foo.js', 50]]);
      const suggestions = [
        { file: 'src/foo.js', line_start: 100, line_end: 110, title: 'Invalid line', type: 'bug', description: 'Original description' }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap, { convertToFileLevel: true });

      const converted = result.converted[0];
      // The description should remain unchanged - should NOT include "originally referenced line X"
      expect(converted.description).toBe('Original description');
      expect(converted.description).not.toContain('originally');
      expect(converted.description).not.toContain('100');
    });

    it('should drop invalid suggestions when convertToFileLevel is false (default)', () => {
      const fileLineCountMap = new Map([['src/foo.js', 50]]);
      const suggestions = [
        { file: 'src/foo.js', line_start: 100, line_end: 100, title: 'Invalid line', type: 'bug' }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap);

      expect(result.valid).toHaveLength(0);
      expect(result.converted).toHaveLength(0);
      expect(result.dropped).toHaveLength(1);
    });
  });

  describe('edge cases', () => {
    it('should return empty result for null suggestions', () => {
      const fileLineCountMap = new Map([['src/foo.js', 50]]);

      const result = validateSuggestionLineNumbers(null, fileLineCountMap);

      expect(result.valid).toHaveLength(0);
      expect(result.converted).toHaveLength(0);
      expect(result.dropped).toHaveLength(0);
    });

    it('should return empty result for undefined suggestions', () => {
      const fileLineCountMap = new Map([['src/foo.js', 50]]);

      const result = validateSuggestionLineNumbers(undefined, fileLineCountMap);

      expect(result.valid).toHaveLength(0);
      expect(result.converted).toHaveLength(0);
      expect(result.dropped).toHaveLength(0);
    });

    it('should return empty result for non-array suggestions', () => {
      const fileLineCountMap = new Map([['src/foo.js', 50]]);

      const result = validateSuggestionLineNumbers('not an array', fileLineCountMap);

      expect(result.valid).toHaveLength(0);
      expect(result.converted).toHaveLength(0);
      expect(result.dropped).toHaveLength(0);
    });

    it('should handle mixed valid and invalid suggestions', () => {
      const fileLineCountMap = new Map([
        ['src/foo.js', 50],
        ['src/bar.js', 100]
      ]);
      const suggestions = [
        { file: 'src/foo.js', line_start: 10, line_end: 20, title: 'Valid 1', type: 'bug' },
        { file: 'src/foo.js', line_start: 100, line_end: 100, title: 'Invalid', type: 'bug' },
        { file: 'src/bar.js', line_start: 50, line_end: 60, title: 'Valid 2', type: 'improvement' },
        { file: 'src/bar.js', line_start: null, title: 'File-level', type: 'design', is_file_level: true }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap);

      expect(result.valid).toHaveLength(3);
      expect(result.valid.map(s => s.title)).toEqual(['Valid 1', 'Valid 2', 'File-level']);
      expect(result.dropped).toHaveLength(1);
      expect(result.dropped[0].title).toBe('Invalid');
    });

    it('should validate line at exact file length boundary', () => {
      const fileLineCountMap = new Map([['src/foo.js', 50]]);
      const suggestions = [
        { file: 'src/foo.js', line_start: 50, line_end: 50, title: 'At boundary', type: 'bug' },
        { file: 'src/foo.js', line_start: 51, line_end: 51, title: 'Past boundary', type: 'bug' }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap);

      expect(result.valid).toHaveLength(1);
      expect(result.valid[0].title).toBe('At boundary');
      expect(result.dropped).toHaveLength(1);
      expect(result.dropped[0].title).toBe('Past boundary');
    });

    it('should allow line 1 as valid start', () => {
      const fileLineCountMap = new Map([['src/foo.js', 50]]);
      const suggestions = [
        { file: 'src/foo.js', line_start: 1, line_end: 1, title: 'First line', type: 'bug' }
      ];

      const result = validateSuggestionLineNumbers(suggestions, fileLineCountMap);

      expect(result.valid).toHaveLength(1);
    });
  });
});
