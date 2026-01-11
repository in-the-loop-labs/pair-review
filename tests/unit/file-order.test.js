// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach } from 'vitest';

// Mock global.window before requiring the module.
// The file-order.js module is browser code that attaches itself to window.FileOrderUtils.
// Since Node.js doesn't have a window object, we create an empty one so the module
// can attach its exports, which we then import for testing.
global.window = {};

// Import the file-order module which exports to window.FileOrderUtils
require('../../public/js/utils/file-order.js');

const { sortFilesByPath, createFileOrderMap } = window.FileOrderUtils;

describe('FileOrderUtils', () => {
  describe('sortFilesByPath', () => {
    describe('basic sorting', () => {
      it('should sort files by directory first, then by filename', () => {
        const files = [
          { file: 'src/utils/helper.js' },
          { file: 'src/index.js' },
          { file: 'src/utils/api.js' }
        ];

        const sorted = sortFilesByPath(files);

        expect(sorted.map(f => f.file)).toEqual([
          'src/index.js',
          'src/utils/api.js',
          'src/utils/helper.js'
        ]);
      });

      it('should sort directories alphabetically before sorting filenames', () => {
        const files = [
          { file: 'tests/unit/foo.test.js' },
          { file: 'src/main.js' },
          { file: 'public/index.html' }
        ];

        const sorted = sortFilesByPath(files);

        expect(sorted.map(f => f.file)).toEqual([
          'public/index.html',
          'src/main.js',
          'tests/unit/foo.test.js'
        ]);
      });

      it('should handle files in same directory - sort by filename', () => {
        const files = [
          { file: 'src/zebra.js' },
          { file: 'src/alpha.js' },
          { file: 'src/beta.js' }
        ];

        const sorted = sortFilesByPath(files);

        expect(sorted.map(f => f.file)).toEqual([
          'src/alpha.js',
          'src/beta.js',
          'src/zebra.js'
        ]);
      });
    });

    describe('the specific bug case - directory-then-filename vs simple localeCompare', () => {
      it('should place public/local.html BEFORE public/js/components/AIPanel.js', () => {
        // This is the key test case that would fail with simple path.localeCompare
        // Simple localeCompare: 'public/js/...' < 'public/local.html' (j < l)
        // Correct behavior: 'public/' < 'public/js/', so local.html comes first
        const files = [
          { file: 'public/js/components/AIPanel.js' },
          { file: 'public/local.html' }
        ];

        const sorted = sortFilesByPath(files);

        expect(sorted.map(f => f.file)).toEqual([
          'public/local.html',
          'public/js/components/AIPanel.js'
        ]);
      });

      it('should handle the full original bug scenario with all affected files', () => {
        // These are actual files from the git status that showed the bug
        const files = [
          { file: 'public/js/components/AIPanel.js' },
          { file: 'public/js/components/ReviewModal.js' },
          { file: 'public/js/local.js' },
          { file: 'public/js/pr.js' },
          { file: 'public/local.html' },
          { file: 'public/pr.html' }
        ];

        const sorted = sortFilesByPath(files);

        // Files in public/ directory should come before files in public/js/
        // Within public/, sort alphabetically: local.html, pr.html
        // Within public/js/, sort alphabetically: local.js, pr.js
        // Within public/js/components/, sort alphabetically: AIPanel.js, ReviewModal.js
        expect(sorted.map(f => f.file)).toEqual([
          'public/local.html',
          'public/pr.html',
          'public/js/local.js',
          'public/js/pr.js',
          'public/js/components/AIPanel.js',
          'public/js/components/ReviewModal.js'
        ]);
      });

      it('should demonstrate difference from naive localeCompare on full path', () => {
        // This test documents what the BUG would have produced
        // With naive fullPath.localeCompare(), 'public/js' < 'public/local' because 'j' < 'l'
        const files = [
          { file: 'public/local.html' },
          { file: 'public/js/file.js' }
        ];

        // Naive sorting would be wrong:
        // const naiveSorted = [...files].sort((a, b) => a.file.localeCompare(b.file));
        // naiveSorted would be: ['public/js/file.js', 'public/local.html'] - WRONG!

        const sorted = sortFilesByPath(files);

        // Correct sorting: public/ files before public/js/ files
        expect(sorted.map(f => f.file)).toEqual([
          'public/local.html',
          'public/js/file.js'
        ]);
      });
    });

    describe('edge cases', () => {
      it('should return empty array for empty input', () => {
        expect(sortFilesByPath([])).toEqual([]);
      });

      it('should return empty array for non-array input', () => {
        expect(sortFilesByPath(null)).toEqual([]);
        expect(sortFilesByPath(undefined)).toEqual([]);
        expect(sortFilesByPath('string')).toEqual([]);
        expect(sortFilesByPath(123)).toEqual([]);
        expect(sortFilesByPath({})).toEqual([]);
      });

      it('should handle single file', () => {
        const files = [{ file: 'src/main.js' }];
        const sorted = sortFilesByPath(files);
        expect(sorted).toEqual([{ file: 'src/main.js' }]);
      });

      it('should handle files in root directory (no slashes)', () => {
        const files = [
          { file: 'README.md' },
          { file: 'package.json' },
          { file: '.gitignore' }
        ];

        const sorted = sortFilesByPath(files);

        // Root files should be sorted alphabetically
        // '.' directory is used for root files
        expect(sorted.map(f => f.file)).toEqual([
          '.gitignore',
          'package.json',
          'README.md'
        ]);
      });

      it('should place root files before subdirectory files', () => {
        const files = [
          { file: 'src/main.js' },
          { file: 'README.md' }
        ];

        const sorted = sortFilesByPath(files);

        // '.' (root) comes before 'src' alphabetically
        expect(sorted.map(f => f.file)).toEqual([
          'README.md',
          'src/main.js'
        ]);
      });

      it('should handle files with empty file property', () => {
        const files = [
          { file: 'src/main.js' },
          { file: '' },
          { file: 'README.md' }
        ];

        const sorted = sortFilesByPath(files);

        // Empty string has directory '.' and filename ''
        expect(sorted).toHaveLength(3);
        // Should not throw and should include all items
      });

      it('should handle files with missing file property', () => {
        const files = [
          { file: 'src/main.js' },
          { notFile: 'something' },
          { file: 'README.md' }
        ];

        const sorted = sortFilesByPath(files);

        // Missing file property treated as empty string
        expect(sorted).toHaveLength(3);
      });
    });

    describe('multiple directory depths', () => {
      it('should sort files across various directory depths correctly', () => {
        const files = [
          { file: 'src/components/ui/Button.js' },
          { file: 'src/components/Header.js' },
          { file: 'src/index.js' },
          { file: 'tests/unit/Button.test.js' },
          { file: 'package.json' }
        ];

        const sorted = sortFilesByPath(files);

        expect(sorted.map(f => f.file)).toEqual([
          'package.json',                     // root (.)
          'src/index.js',                     // src/
          'src/components/Header.js',         // src/components/
          'src/components/ui/Button.js',      // src/components/ui/
          'tests/unit/Button.test.js'         // tests/unit/
        ]);
      });

      it('should handle deeply nested directories', () => {
        const files = [
          { file: 'a/b/c/d/e/deep.js' },
          { file: 'a/b/shallow.js' },
          { file: 'a/top.js' }
        ];

        const sorted = sortFilesByPath(files);

        expect(sorted.map(f => f.file)).toEqual([
          'a/top.js',
          'a/b/shallow.js',
          'a/b/c/d/e/deep.js'
        ]);
      });
    });

    describe('preserves original array', () => {
      it('should not mutate the original array', () => {
        const original = [
          { file: 'b.js' },
          { file: 'a.js' }
        ];
        const originalCopy = [...original];

        sortFilesByPath(original);

        expect(original).toEqual(originalCopy);
      });

      it('should return a new array instance', () => {
        const original = [{ file: 'a.js' }];
        const sorted = sortFilesByPath(original);

        expect(sorted).not.toBe(original);
      });
    });

    describe('matches file navigator order', () => {
      it('should group files by directory matching groupFilesByDirectory behavior', () => {
        // The file navigator uses groupFilesByDirectory which groups by directory
        // then sorts directory keys alphabetically
        const files = [
          { file: 'public/css/pr.css' },
          { file: 'public/js/components/AIPanel.js' },
          { file: 'public/js/components/ReviewModal.js' },
          { file: 'public/js/local.js' },
          { file: 'public/js/pr.js' },
          { file: 'public/local.html' },
          { file: 'public/pr.html' },
          { file: 'src/routes/analysis.js' },
          { file: 'src/routes/local.js' }
        ];

        const sorted = sortFilesByPath(files);

        // Expected order by directory groups:
        // 1. public/css/ -> pr.css
        // 2. public/js/ -> local.js, pr.js
        // 3. public/js/components/ -> AIPanel.js, ReviewModal.js
        // 4. public/ -> local.html, pr.html
        // 5. src/routes/ -> analysis.js, local.js

        // Wait - 'public/' comes before 'public/css/' alphabetically
        // Let me reconsider: directory comparison
        // 'public' vs 'public/css' - 'public' < 'public/css' (shorter)
        // 'public' vs 'public/js' - 'public' < 'public/js'
        // So public/ files should come first!

        expect(sorted.map(f => f.file)).toEqual([
          'public/local.html',
          'public/pr.html',
          'public/css/pr.css',
          'public/js/local.js',
          'public/js/pr.js',
          'public/js/components/AIPanel.js',
          'public/js/components/ReviewModal.js',
          'src/routes/analysis.js',
          'src/routes/local.js'
        ]);
      });
    });
  });

  describe('createFileOrderMap', () => {
    describe('basic functionality', () => {
      it('should create a map with correct indices', () => {
        const files = [
          { file: 'src/a.js' },
          { file: 'src/b.js' },
          { file: 'src/c.js' }
        ];

        const orderMap = createFileOrderMap(files);

        expect(orderMap.get('src/a.js')).toBe(0);
        expect(orderMap.get('src/b.js')).toBe(1);
        expect(orderMap.get('src/c.js')).toBe(2);
      });

      it('should return a Map instance', () => {
        const files = [{ file: 'test.js' }];
        const orderMap = createFileOrderMap(files);

        expect(orderMap).toBeInstanceOf(Map);
      });

      it('should have size equal to number of files', () => {
        const files = [
          { file: 'a.js' },
          { file: 'b.js' },
          { file: 'c.js' }
        ];

        const orderMap = createFileOrderMap(files);

        expect(orderMap.size).toBe(3);
      });
    });

    describe('indices match sorted order', () => {
      it('should create indices that match the sorted order from sortFilesByPath', () => {
        const files = [
          { file: 'public/js/main.js' },
          { file: 'public/index.html' },
          { file: 'src/app.js' }
        ];

        const sorted = sortFilesByPath(files);
        const orderMap = createFileOrderMap(sorted);

        // Verify the map indices match the sorted array positions
        sorted.forEach((file, index) => {
          expect(orderMap.get(file.file)).toBe(index);
        });
      });
    });

    describe('edge cases', () => {
      it('should return empty map for empty array', () => {
        const orderMap = createFileOrderMap([]);
        expect(orderMap.size).toBe(0);
      });

      it('should return empty map for non-array input', () => {
        expect(createFileOrderMap(null).size).toBe(0);
        expect(createFileOrderMap(undefined).size).toBe(0);
        expect(createFileOrderMap('string').size).toBe(0);
        expect(createFileOrderMap(123).size).toBe(0);
        expect(createFileOrderMap({}).size).toBe(0);
      });

      it('should handle files with string paths directly (not objects)', () => {
        const files = ['src/a.js', 'src/b.js'];

        const orderMap = createFileOrderMap(files);

        expect(orderMap.get('src/a.js')).toBe(0);
        expect(orderMap.get('src/b.js')).toBe(1);
      });

      it('should handle mixed object and string inputs', () => {
        const files = [
          { file: 'src/a.js' },
          'src/b.js'
        ];

        const orderMap = createFileOrderMap(files);

        expect(orderMap.get('src/a.js')).toBe(0);
        expect(orderMap.get('src/b.js')).toBe(1);
      });

      it('should handle files with missing file property', () => {
        const files = [
          { file: 'src/a.js' },
          { notFile: 'something' }
        ];

        const orderMap = createFileOrderMap(files);

        expect(orderMap.get('src/a.js')).toBe(0);
        // When file.file is undefined/falsy, implementation uses file.file || file
        // which returns the whole object as the key
        expect(orderMap.size).toBe(2);
      });
    });

    describe('lookup performance', () => {
      it('should allow O(1) lookup of file order', () => {
        // Create a reasonably sized file list
        const files = [];
        for (let i = 0; i < 100; i++) {
          files.push({ file: `src/file${i}.js` });
        }

        const orderMap = createFileOrderMap(files);

        // Map.get should be O(1)
        expect(orderMap.get('src/file50.js')).toBe(50);
        expect(orderMap.get('src/file99.js')).toBe(99);
        expect(orderMap.get('src/file0.js')).toBe(0);
      });
    });
  });

  describe('integration: sortFilesByPath + createFileOrderMap', () => {
    it('should work together to provide consistent file ordering', () => {
      const unsortedFiles = [
        { file: 'public/js/main.js' },
        { file: 'README.md' },
        { file: 'public/index.html' },
        { file: 'src/utils/helper.js' },
        { file: 'src/app.js' }
      ];

      // Sort files first
      const sortedFiles = sortFilesByPath(unsortedFiles);

      // Create order map from sorted files
      const orderMap = createFileOrderMap(sortedFiles);

      // Verify we can use the map to sort items by the canonical file order
      const itemsToSort = [
        { path: 'src/app.js', data: 'app' },
        { path: 'README.md', data: 'readme' },
        { path: 'public/index.html', data: 'index' }
      ];

      const sortedItems = itemsToSort.sort((a, b) => {
        const orderA = orderMap.get(a.path) ?? Infinity;
        const orderB = orderMap.get(b.path) ?? Infinity;
        return orderA - orderB;
      });

      // Should match the order in sortedFiles
      const sortedPaths = sortedFiles.map(f => f.file);
      const itemPaths = sortedItems.map(i => i.path);

      // Filter sortedPaths to only include paths that are in itemPaths
      const expectedOrder = sortedPaths.filter(p => itemPaths.includes(p));
      expect(itemPaths).toEqual(expectedOrder);
    });
  });
});
