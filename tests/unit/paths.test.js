import { describe, it, expect } from 'vitest';
import { normalizePath } from '../../src/utils/paths.js';

describe('normalizePath', () => {
  describe('leading ./ removal', () => {
    it('should remove leading ./ from paths', () => {
      expect(normalizePath('./src/foo.js')).toBe('src/foo.js');
    });

    it('should remove multiple leading ./ sequences', () => {
      expect(normalizePath('././src/foo.js')).toBe('src/foo.js');
      expect(normalizePath('./././file.txt')).toBe('file.txt');
    });

    it('should handle ./ only', () => {
      expect(normalizePath('./')).toBe('');
    });

    it('should handle multiple ./ only', () => {
      expect(normalizePath('././')).toBe('');
    });
  });

  describe('leading / removal', () => {
    it('should remove leading / from paths', () => {
      expect(normalizePath('/src/foo.js')).toBe('src/foo.js');
    });

    it('should remove multiple leading slashes', () => {
      expect(normalizePath('//src/foo.js')).toBe('src/foo.js');
      expect(normalizePath('///file.txt')).toBe('file.txt');
    });

    it('should handle / only', () => {
      expect(normalizePath('/')).toBe('');
    });

    it('should handle multiple / only', () => {
      expect(normalizePath('//')).toBe('');
      expect(normalizePath('///')).toBe('');
    });
  });

  describe('double slash collapsing', () => {
    it('should collapse double slashes in the middle of paths', () => {
      expect(normalizePath('src//foo.js')).toBe('src/foo.js');
    });

    it('should collapse multiple consecutive slashes', () => {
      expect(normalizePath('src///foo.js')).toBe('src/foo.js');
      expect(normalizePath('src////foo.js')).toBe('src/foo.js');
    });

    it('should handle multiple groups of consecutive slashes', () => {
      expect(normalizePath('src//utils//foo.js')).toBe('src/utils/foo.js');
      expect(normalizePath('a//b//c//d.js')).toBe('a/b/c/d.js');
    });
  });

  describe('whitespace trimming', () => {
    it('should trim leading whitespace', () => {
      expect(normalizePath('  src/foo.js')).toBe('src/foo.js');
      expect(normalizePath('\tsrc/foo.js')).toBe('src/foo.js');
      expect(normalizePath('\n src/foo.js')).toBe('src/foo.js');
    });

    it('should trim trailing whitespace', () => {
      expect(normalizePath('src/foo.js  ')).toBe('src/foo.js');
      expect(normalizePath('src/foo.js\t')).toBe('src/foo.js');
      expect(normalizePath('src/foo.js\n ')).toBe('src/foo.js');
    });

    it('should trim both leading and trailing whitespace', () => {
      expect(normalizePath('  src/foo.js  ')).toBe('src/foo.js');
      expect(normalizePath('\t\nsrc/foo.js\t\n')).toBe('src/foo.js');
    });
  });

  describe('edge cases', () => {
    it('should return empty string for null', () => {
      expect(normalizePath(null)).toBe('');
    });

    it('should return empty string for undefined', () => {
      expect(normalizePath(undefined)).toBe('');
    });

    it('should return empty string for empty string', () => {
      expect(normalizePath('')).toBe('');
    });

    it('should return empty string for whitespace-only string', () => {
      expect(normalizePath('   ')).toBe('');
      expect(normalizePath('\t\n')).toBe('');
    });

    it('should return empty string for non-string types', () => {
      expect(normalizePath(123)).toBe('');
      expect(normalizePath({})).toBe('');
      expect(normalizePath([])).toBe('');
      expect(normalizePath(true)).toBe('');
    });
  });

  describe('combined transformations', () => {
    it('should handle leading ./ with double slashes', () => {
      expect(normalizePath('./src//foo.js')).toBe('src/foo.js');
    });

    it('should handle leading / with double slashes', () => {
      expect(normalizePath('/src//foo.js')).toBe('src/foo.js');
    });

    it('should handle whitespace with leading ./', () => {
      expect(normalizePath('  ./src/foo.js  ')).toBe('src/foo.js');
    });

    it('should handle whitespace with leading /', () => {
      expect(normalizePath('  /src/foo.js  ')).toBe('src/foo.js');
    });

    it('should handle all transformations together', () => {
      expect(normalizePath('  ./src//utils//foo.js  ')).toBe('src/utils/foo.js');
      expect(normalizePath('\t/src//foo.js\n')).toBe('src/foo.js');
    });

    it('should handle leading // followed by ./', () => {
      // After collapsing //, we get /./ then after removing leading /, we get ./
      // then after removing leading ./, we get empty or the rest
      expect(normalizePath('//./src/foo.js')).toBe('src/foo.js');
    });
  });

  describe('paths that should not change', () => {
    it('should not modify already normalized paths', () => {
      expect(normalizePath('src/foo.js')).toBe('src/foo.js');
      expect(normalizePath('file.txt')).toBe('file.txt');
      expect(normalizePath('src/utils/helper.js')).toBe('src/utils/helper.js');
    });

    it('should preserve relative parent references in middle of path', () => {
      expect(normalizePath('src/../utils/foo.js')).toBe('src/../utils/foo.js');
    });

    it('should preserve dots in filenames', () => {
      expect(normalizePath('file.test.js')).toBe('file.test.js');
      expect(normalizePath('.gitignore')).toBe('.gitignore');
      expect(normalizePath('.env.local')).toBe('.env.local');
    });

    it('should preserve hidden directories', () => {
      expect(normalizePath('.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
    });
  });
});
