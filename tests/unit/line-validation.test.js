// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Import the logger so we can spy on it
const logger = require('../../src/utils/logger');
const { buildFileLineCountMap, validateSuggestionLineNumbers } = require('../../src/utils/line-validation');

// Create a spy for logger.warn
let warnSpy;

describe('buildFileLineCountMap', () => {
  // mkdtemp gives a unique, collision-free directory per test — a fixed
  // '/tmp/...-Date.now()' path at module scope can collide across parallel
  // workers/repeated runs and pollutes the real /tmp.
  let testDir;

  beforeEach(async () => {
    // Create test directory
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'line-validation-'));
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

  it('treats shell metacharacters in filenames literally during binary detection', async () => {
    const file = 'helper$(printf surprise).bin';
    await fs.promises.writeFile(path.join(testDir, file), Buffer.from([65, 0, 66]));

    const result = await buildFileLineCountMap(testDir, [file]);

    expect(result.get(file)).toBe(-1);
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

  it('counts text containing a non-NUL control byte and rejects UTF-16 NULs', async () => {
    await fs.promises.writeFile(path.join(testDir, 'control.txt'), Buffer.from([65, 1, 10, 66]));
    await fs.promises.writeFile(path.join(testDir, 'utf16.txt'), Buffer.from('first\nsecond', 'utf16le'));
    const counts = await buildFileLineCountMap(testDir, ['control.txt', 'utf16.txt']);
    expect(counts.get('control.txt')).toBe(2);
    expect(counts.get('utf16.txt')).toBe(-1);
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

  describe('bounded binary scan', () => {
    // Wrap fs.promises.open so each test can observe the FileHandle that
    // buildFileLineCountMap opens (readFile/close calls) without changing I/O.
    function spyOnOpenedHandles(mutate = () => {}) {
      const handles = [];
      const realOpen = fs.promises.open.bind(fs.promises);
      const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        const tracked = {
          readFile: vi.spyOn(handle, 'readFile'),
          close: vi.spyOn(handle, 'close'),
        };
        mutate(handle);
        handles.push(tracked);
        return handle;
      });
      return { handles, openSpy };
    }

    it('returns -1 for a large binary file without reading past the first 8 KB', async () => {
      const content = Buffer.alloc(64 * 1024, 0x41);
      content[100] = 0;
      await fs.promises.writeFile(path.join(testDir, 'asset.bin'), content);
      const { handles, openSpy } = spyOnOpenedHandles();

      try {
        const result = await buildFileLineCountMap(testDir, ['asset.bin']);

        expect(result.get('asset.bin')).toBe(-1);
        expect(handles).toHaveLength(1);
        expect(handles[0].readFile).not.toHaveBeenCalled();
        expect(handles[0].close).toHaveBeenCalledTimes(1);
      } finally {
        openSpy.mockRestore();
      }
    });

    it('detects a NUL on the last byte of the 8 KB scan window', async () => {
      const content = Buffer.alloc(8192 + 10, 0x41);
      content[8191] = 0;
      await fs.promises.writeFile(path.join(testDir, 'edge.bin'), content);

      const result = await buildFileLineCountMap(testDir, ['edge.bin']);

      expect(result.get('edge.bin')).toBe(-1);
    });

    it('counts a file whose only NUL lies past the 8 KB scan window as text', async () => {
      const content = Buffer.alloc(8192 + 10, 0x41);
      content[8192] = 0;
      await fs.promises.writeFile(path.join(testDir, 'late-nul.txt'), content);

      const result = await buildFileLineCountMap(testDir, ['late-nul.txt']);

      expect(result.get('late-nul.txt')).toBe(1);
    });

    it('counts lines in a text file larger than 8 KB, including lines spanning the boundary', async () => {
      // 1000 lines of 20 bytes ("line NNNN padded...\n") = 20000 bytes; line
      // 410 straddles byte 8192. A multi-byte character also straddles it.
      const lines = [];
      for (let i = 1; i <= 1000; i++) lines.push(`line ${String(i).padStart(4, '0')} padding.`);
      const text = `${lines.join('\n')}\n`;
      expect(Buffer.byteLength(text)).toBeGreaterThan(8192);
      await fs.promises.writeFile(path.join(testDir, 'big.txt'), text);
      await fs.promises.writeFile(path.join(testDir, 'big-no-eol.txt'), text.slice(0, -1));
      const prefix = 'a'.repeat(8191);
      await fs.promises.writeFile(path.join(testDir, 'split-char.txt'), `${prefix}é\nsecond`);

      const result = await buildFileLineCountMap(testDir, ['big.txt', 'big-no-eol.txt', 'split-char.txt']);

      expect(result.get('big.txt')).toBe(1000);
      expect(result.get('big-no-eol.txt')).toBe(1000);
      expect(result.get('split-char.txt')).toBe(2);
    });

    it('counts a text file of exactly 8 KB (EOF at the scan boundary)', async () => {
      const text = `${'x'.repeat(8190)}\n\n`;
      expect(Buffer.byteLength(text)).toBe(8192);
      await fs.promises.writeFile(path.join(testDir, 'exact.txt'), text);

      const result = await buildFileLineCountMap(testDir, ['exact.txt']);

      expect(result.get('exact.txt')).toBe(2);
    });

    it('returns 0 for an empty file and closes the handle', async () => {
      await fs.promises.writeFile(path.join(testDir, 'empty.txt'), '');
      const { handles, openSpy } = spyOnOpenedHandles();

      try {
        const result = await buildFileLineCountMap(testDir, ['empty.txt']);

        expect(result.get('empty.txt')).toBe(0);
        expect(handles[0].close).toHaveBeenCalledTimes(1);
      } finally {
        openSpy.mockRestore();
      }
    });

    it('returns -1 when the file cannot be opened', async () => {
      await fs.promises.writeFile(path.join(testDir, 'locked.txt'), 'text\n');
      const error = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      const openSpy = vi.spyOn(fs.promises, 'open').mockRejectedValue(error);

      try {
        const result = await buildFileLineCountMap(testDir, ['locked.txt']);

        expect(result.get('locked.txt')).toBe(-1);
      } finally {
        openSpy.mockRestore();
      }
    });

    it('returns -1 and still closes the handle when a read fails after opening', async () => {
      await fs.promises.writeFile(path.join(testDir, 'flaky.txt'), 'text\n');
      const { handles, openSpy } = spyOnOpenedHandles(handle => {
        vi.spyOn(handle, 'read').mockRejectedValue(new Error('EIO: i/o error'));
      });

      try {
        const result = await buildFileLineCountMap(testDir, ['flaky.txt']);

        expect(result.get('flaky.txt')).toBe(-1);
        expect(handles[0].close).toHaveBeenCalledTimes(1);
      } finally {
        openSpy.mockRestore();
      }
    });
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
