// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { normalizePath, normalizeRepository, resolveRenamedFile } from '../../src/utils/paths.js';

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

describe('normalizeRepository', () => {
  describe('case normalization', () => {
    it('should lowercase owner and repo', () => {
      expect(normalizeRepository('Owner', 'Repo')).toBe('owner/repo');
    });

    it('should handle all uppercase', () => {
      expect(normalizeRepository('OWNER', 'REPO')).toBe('owner/repo');
    });

    it('should handle mixed case', () => {
      expect(normalizeRepository('OwNeR', 'RePo')).toBe('owner/repo');
    });

    it('should preserve already lowercase', () => {
      expect(normalizeRepository('owner', 'repo')).toBe('owner/repo');
    });
  });

  describe('format', () => {
    it('should return owner/repo format', () => {
      expect(normalizeRepository('myorg', 'myrepo')).toBe('myorg/myrepo');
    });

    it('should handle hyphenated names', () => {
      expect(normalizeRepository('my-org', 'my-repo')).toBe('my-org/my-repo');
    });

    it('should handle underscored names', () => {
      expect(normalizeRepository('my_org', 'my_repo')).toBe('my_org/my_repo');
    });

    it('should handle numeric characters', () => {
      expect(normalizeRepository('org123', 'repo456')).toBe('org123/repo456');
    });
  });

  describe('error handling', () => {
    it('should throw for null owner', () => {
      expect(() => normalizeRepository(null, 'repo')).toThrow('owner and repo must be non-empty strings');
    });

    it('should throw for undefined owner', () => {
      expect(() => normalizeRepository(undefined, 'repo')).toThrow('owner and repo must be non-empty strings');
    });

    it('should throw for empty owner', () => {
      expect(() => normalizeRepository('', 'repo')).toThrow('owner and repo must be non-empty strings');
    });

    it('should throw for null repo', () => {
      expect(() => normalizeRepository('owner', null)).toThrow('owner and repo must be non-empty strings');
    });

    it('should throw for undefined repo', () => {
      expect(() => normalizeRepository('owner', undefined)).toThrow('owner and repo must be non-empty strings');
    });

    it('should throw for empty repo', () => {
      expect(() => normalizeRepository('owner', '')).toThrow('owner and repo must be non-empty strings');
    });

    it('should throw for non-string owner', () => {
      expect(() => normalizeRepository(123, 'repo')).toThrow('owner and repo must be non-empty strings');
    });

    it('should throw for non-string repo', () => {
      expect(() => normalizeRepository('owner', 123)).toThrow('owner and repo must be non-empty strings');
    });
  });

  describe('whitespace handling', () => {
    it('should trim leading and trailing whitespace from owner', () => {
      expect(normalizeRepository('  owner  ', 'repo')).toBe('owner/repo');
    });

    it('should trim leading and trailing whitespace from repo', () => {
      expect(normalizeRepository('owner', '  repo  ')).toBe('owner/repo');
    });

    it('should trim whitespace from both owner and repo', () => {
      expect(normalizeRepository('  owner  ', '  repo  ')).toBe('owner/repo');
    });

    it('should throw for whitespace-only owner', () => {
      expect(() => normalizeRepository('   ', 'repo')).toThrow('owner and repo must be non-empty strings');
    });

    it('should throw for whitespace-only repo', () => {
      expect(() => normalizeRepository('owner', '   ')).toThrow('owner and repo must be non-empty strings');
    });

    it('should throw for whitespace-only owner and repo', () => {
      expect(() => normalizeRepository('   ', '   ')).toThrow('owner and repo must be non-empty strings');
    });

    it('should handle tabs and newlines in owner', () => {
      expect(normalizeRepository('\t\nowner\t\n', 'repo')).toBe('owner/repo');
    });

    it('should handle tabs and newlines in repo', () => {
      expect(normalizeRepository('owner', '\t\nrepo\t\n')).toBe('owner/repo');
    });
  });
});

describe('resolveRenamedFile', () => {
  describe('no rename syntax', () => {
    it('should return unchanged when no rename syntax present', () => {
      expect(resolveRenamedFile('src/foo.js')).toBe('src/foo.js');
    });

    it('should return unchanged for plain filename', () => {
      expect(resolveRenamedFile('file.txt')).toBe('file.txt');
    });

    it('should return unchanged for deeply nested path', () => {
      expect(resolveRenamedFile('a/b/c/d/e.js')).toBe('a/b/c/d/e.js');
    });
  });

  describe('file rename in directory', () => {
    it('should resolve simple file rename', () => {
      expect(resolveRenamedFile('tests/{old.js => new.js}')).toBe('tests/new.js');
    });

    it('should resolve real-world long filename rename', () => {
      expect(resolveRenamedFile(
        'tests/unit/{suggestion-manager-getfileandlineinfo.test.js => suggestion-manager.test.js}'
      )).toBe('tests/unit/suggestion-manager.test.js');
    });
  });

  describe('directory rename', () => {
    it('should resolve directory rename', () => {
      expect(resolveRenamedFile('{old-dir => new-dir}/file.js')).toBe('new-dir/file.js');
    });
  });

  describe('mid-path rename', () => {
    it('should resolve rename in middle of path', () => {
      expect(resolveRenamedFile('a/{b => c}/d.js')).toBe('a/c/d.js');
    });
  });

  describe('edge cases', () => {
    it('should return null for null input', () => {
      expect(resolveRenamedFile(null)).toBe(null);
    });

    it('should return undefined for undefined input', () => {
      expect(resolveRenamedFile(undefined)).toBe(undefined);
    });

    it('should return empty string for empty string input', () => {
      expect(resolveRenamedFile('')).toBe('');
    });
  });
});
