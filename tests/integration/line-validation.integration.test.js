import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const { buildFileLineCountMap, validateSuggestionLineNumbers } = require('../../src/utils/line-validation');

describe('Line Validation Integration', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-validation-'));
    // Create test files with varying content
    // Note: 'small.js' has trailing newline to verify line counting logic handles it correctly
    // (a file with "a\nb\nc\n" should count as 3 lines, not 4)
    fs.writeFileSync(path.join(tempDir, 'small.js'), 'line1\nline2\nline3\n');
    fs.writeFileSync(path.join(tempDir, 'large.js'), Array(100).fill('// line').join('\n'));
    fs.writeFileSync(path.join(tempDir, 'empty.js'), '');
    fs.writeFileSync(path.join(tempDir, 'single-line.js'), 'const x = 1;');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('End-to-end validation flow', () => {
    it('should build line count map and validate suggestions correctly', async () => {
      const lineCountMap = await buildFileLineCountMap(tempDir, ['small.js', 'large.js']);

      expect(lineCountMap.get('small.js')).toBe(3);
      expect(lineCountMap.get('large.js')).toBe(100);

      const suggestions = [
        { file: 'small.js', line_start: 2, line_end: 2, title: 'Valid single line', type: 'bug' },
        { file: 'small.js', line_start: 10, line_end: 10, title: 'Invalid - line 10 does not exist', type: 'bug' },
        { file: 'large.js', line_start: 50, line_end: 60, title: 'Valid range in middle', type: 'improvement' },
        { file: 'large.js', line_start: 90, line_end: 110, title: 'Invalid - end exceeds file length', type: 'improvement' },
      ];

      const result = validateSuggestionLineNumbers(suggestions, lineCountMap, { convertToFileLevel: true });

      expect(result.valid).toHaveLength(2);
      expect(result.converted).toHaveLength(2);
      expect(result.dropped).toHaveLength(0);

      // Check valid suggestions are unchanged
      expect(result.valid[0].title).toBe('Valid single line');
      expect(result.valid[0].line_start).toBe(2);
      expect(result.valid[1].title).toBe('Valid range in middle');
      expect(result.valid[1].line_start).toBe(50);
      expect(result.valid[1].line_end).toBe(60);

      // Check converted suggestions are file-level
      result.converted.forEach(s => {
        expect(s.line_start).toBeNull();
        expect(s.line_end).toBeNull();
        expect(s.is_file_level).toBe(true);
      });

      // Verify specific converted suggestions
      const convertedTitles = result.converted.map(s => s.title);
      expect(convertedTitles).toContain('Invalid - line 10 does not exist');
      expect(convertedTitles).toContain('Invalid - end exceeds file length');
    });

    it('should handle missing files gracefully', async () => {
      const lineCountMap = await buildFileLineCountMap(tempDir, ['small.js', 'nonexistent.js']);

      expect(lineCountMap.get('small.js')).toBe(3);
      expect(lineCountMap.get('nonexistent.js')).toBe(-1); // missing file

      const suggestions = [
        { file: 'nonexistent.js', line_start: 5, line_end: 5, title: 'On missing file', type: 'bug' },
      ];

      const result = validateSuggestionLineNumbers(suggestions, lineCountMap, { convertToFileLevel: true });

      // Suggestions for files with -1 line count should pass through (might be deleted)
      expect(result.valid).toHaveLength(1);
      expect(result.valid[0].title).toBe('On missing file');
    });

    it('should handle empty files correctly', async () => {
      const lineCountMap = await buildFileLineCountMap(tempDir, ['empty.js']);

      expect(lineCountMap.get('empty.js')).toBe(0);

      const suggestions = [
        { file: 'empty.js', line_start: 1, line_end: 1, title: 'On empty file', type: 'bug' },
      ];

      const result = validateSuggestionLineNumbers(suggestions, lineCountMap, { convertToFileLevel: true });

      // Line 1 doesn't exist in empty file (0 lines)
      expect(result.valid).toHaveLength(0);
      expect(result.converted).toHaveLength(1);
      expect(result.converted[0].is_file_level).toBe(true);
    });

    it('should validate boundary conditions correctly', async () => {
      const lineCountMap = await buildFileLineCountMap(tempDir, ['small.js']);

      expect(lineCountMap.get('small.js')).toBe(3);

      const suggestions = [
        { file: 'small.js', line_start: 1, line_end: 1, title: 'First line', type: 'bug' },
        { file: 'small.js', line_start: 3, line_end: 3, title: 'Last line', type: 'bug' },
        { file: 'small.js', line_start: 1, line_end: 3, title: 'Full file range', type: 'improvement' },
        { file: 'small.js', line_start: 0, line_end: 0, title: 'Zero line (invalid)', type: 'bug' },
        { file: 'small.js', line_start: 4, line_end: 4, title: 'One past end (invalid)', type: 'bug' },
      ];

      const result = validateSuggestionLineNumbers(suggestions, lineCountMap, { convertToFileLevel: true });

      expect(result.valid).toHaveLength(3);
      expect(result.converted).toHaveLength(2);

      const validTitles = result.valid.map(s => s.title);
      expect(validTitles).toContain('First line');
      expect(validTitles).toContain('Last line');
      expect(validTitles).toContain('Full file range');

      const convertedTitles = result.converted.map(s => s.title);
      expect(convertedTitles).toContain('Zero line (invalid)');
      expect(convertedTitles).toContain('One past end (invalid)');
    });

    it('should handle files in subdirectories', async () => {
      // Create a subdirectory structure
      const subdir = path.join(tempDir, 'src', 'utils');
      fs.mkdirSync(subdir, { recursive: true });
      fs.writeFileSync(path.join(subdir, 'helper.js'), 'function help() {}\n\nmodule.exports = { help };');

      const lineCountMap = await buildFileLineCountMap(tempDir, ['src/utils/helper.js']);

      expect(lineCountMap.get('src/utils/helper.js')).toBe(3);

      const suggestions = [
        { file: 'src/utils/helper.js', line_start: 1, line_end: 3, title: 'Valid subdirectory file', type: 'design' },
        { file: 'src/utils/helper.js', line_start: 10, line_end: 10, title: 'Invalid line in subdirectory file', type: 'bug' },
      ];

      const result = validateSuggestionLineNumbers(suggestions, lineCountMap, { convertToFileLevel: true });

      expect(result.valid).toHaveLength(1);
      expect(result.valid[0].title).toBe('Valid subdirectory file');
      expect(result.converted).toHaveLength(1);
      expect(result.converted[0].title).toBe('Invalid line in subdirectory file');
    });

    it('should drop invalid suggestions when convertToFileLevel is false', async () => {
      const lineCountMap = await buildFileLineCountMap(tempDir, ['small.js']);

      const suggestions = [
        { file: 'small.js', line_start: 2, line_end: 2, title: 'Valid', type: 'bug' },
        { file: 'small.js', line_start: 100, line_end: 100, title: 'Invalid', type: 'bug' },
      ];

      const result = validateSuggestionLineNumbers(suggestions, lineCountMap, { convertToFileLevel: false });

      expect(result.valid).toHaveLength(1);
      expect(result.converted).toHaveLength(0);
      expect(result.dropped).toHaveLength(1);
      expect(result.dropped[0].title).toBe('Invalid');
    });

    it('should preserve all suggestion properties when converting', async () => {
      const lineCountMap = await buildFileLineCountMap(tempDir, ['small.js']);

      const suggestions = [
        {
          file: 'small.js',
          line_start: 100,
          line_end: 110,
          title: 'Test suggestion',
          type: 'bug',
          description: 'This is a detailed description',
          confidence: 0.85,
          severity: 'high',
          category: 'security',
          customField: 'custom value'
        },
      ];

      const result = validateSuggestionLineNumbers(suggestions, lineCountMap, { convertToFileLevel: true });

      expect(result.converted).toHaveLength(1);
      const converted = result.converted[0];

      // Line numbers should be nullified
      expect(converted.line_start).toBeNull();
      expect(converted.line_end).toBeNull();
      expect(converted.is_file_level).toBe(true);

      // All other properties should be preserved
      expect(converted.file).toBe('small.js');
      expect(converted.title).toBe('Test suggestion');
      expect(converted.type).toBe('bug');
      expect(converted.description).toBe('This is a detailed description');
      expect(converted.confidence).toBe(0.85);
      expect(converted.severity).toBe('high');
      expect(converted.category).toBe('security');
      expect(converted.customField).toBe('custom value');
    });

    it('should handle a mix of all validation scenarios', async () => {
      const lineCountMap = await buildFileLineCountMap(tempDir, [
        'small.js',
        'large.js',
        'empty.js',
        'single-line.js',
        'nonexistent.js'
      ]);

      const suggestions = [
        // Valid suggestions
        { file: 'small.js', line_start: 1, line_end: 2, title: 'Valid in small', type: 'bug' },
        { file: 'large.js', line_start: 50, line_end: 75, title: 'Valid in large', type: 'improvement' },
        { file: 'single-line.js', line_start: 1, line_end: 1, title: 'Valid single line file', type: 'design' },
        // File-level suggestions (always valid)
        { file: 'small.js', line_start: null, line_end: null, title: 'File-level explicit', type: 'praise', is_file_level: true },
        { file: 'large.js', title: 'File-level implicit', type: 'design' },
        // Suggestions for unknown files (pass through)
        { file: 'deleted.js', line_start: 10, line_end: 20, title: 'Unknown file', type: 'bug' },
        // Suggestions for binary/unreadable files (pass through)
        { file: 'nonexistent.js', line_start: 5, line_end: 5, title: 'Missing file', type: 'bug' },
        // Invalid suggestions
        { file: 'small.js', line_start: 100, line_end: 100, title: 'Invalid in small', type: 'bug' },
        { file: 'large.js', line_start: 200, line_end: 300, title: 'Invalid in large', type: 'bug' },
        { file: 'empty.js', line_start: 1, line_end: 1, title: 'Invalid in empty', type: 'bug' },
        { file: 'single-line.js', line_start: 2, line_end: 2, title: 'Past end of single-line', type: 'bug' },
        { file: 'small.js', line_start: 0, line_end: 0, title: 'Zero line', type: 'bug' },
        { file: 'small.js', line_start: -1, line_end: -1, title: 'Negative line', type: 'bug' },
        { file: 'large.js', line_start: 50, line_end: 30, title: 'End before start', type: 'bug' },
      ];

      const result = validateSuggestionLineNumbers(suggestions, lineCountMap, { convertToFileLevel: true });

      // Valid: 3 line-specific + 2 file-level + 2 unknown/missing files = 7
      expect(result.valid).toHaveLength(7);

      // Converted: 7 invalid suggestions
      expect(result.converted).toHaveLength(7);

      // Dropped: 0 (we're using convertToFileLevel)
      expect(result.dropped).toHaveLength(0);

      // Verify all converted have correct structure
      result.converted.forEach(s => {
        expect(s.line_start).toBeNull();
        expect(s.line_end).toBeNull();
        expect(s.is_file_level).toBe(true);
        expect(s.file).toBeDefined();
        expect(s.title).toBeDefined();
        expect(s.type).toBeDefined();
      });
    });
  });

  describe('Real-world simulation', () => {
    it('should handle AI-style suggestions with extra properties', async () => {
      const lineCountMap = await buildFileLineCountMap(tempDir, ['small.js', 'large.js']);

      // Simulate suggestions like those from an AI analysis
      const aiSuggestions = [
        {
          file: 'small.js',
          line_start: 1,
          line_end: 3,
          title: 'Consider adding error handling',
          type: 'improvement',
          description: 'The function lacks try-catch blocks for potential errors.',
          confidence: 0.8,
          level: 2,
          rationale: 'File context analysis suggests error handling would improve robustness.'
        },
        {
          file: 'large.js',
          line_start: 999,  // Invalid - file only has 100 lines
          line_end: 1000,
          title: 'Performance optimization opportunity',
          type: 'performance',
          description: 'Consider using memoization here.',
          confidence: 0.6,
          level: 1
        },
        {
          file: 'large.js',
          line_start: null,
          line_end: null,
          title: 'Overall architecture is sound',
          type: 'praise',
          is_file_level: true,
          description: 'Good separation of concerns.',
          confidence: 0.9,
          level: 3
        }
      ];

      const result = validateSuggestionLineNumbers(aiSuggestions, lineCountMap, { convertToFileLevel: true });

      expect(result.valid).toHaveLength(2);
      expect(result.converted).toHaveLength(1);

      // Verify the valid suggestions maintain their properties
      const validTitles = result.valid.map(s => s.title);
      expect(validTitles).toContain('Consider adding error handling');
      expect(validTitles).toContain('Overall architecture is sound');

      // Verify converted suggestion maintains properties except lines
      const converted = result.converted[0];
      expect(converted.title).toBe('Performance optimization opportunity');
      expect(converted.type).toBe('performance');
      expect(converted.description).toBe('Consider using memoization here.');
      expect(converted.confidence).toBe(0.6);
      expect(converted.level).toBe(1);
      expect(converted.line_start).toBeNull();
      expect(converted.is_file_level).toBe(true);
    });
  });
});
