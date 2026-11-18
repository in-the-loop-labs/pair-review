// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests for DiffRenderer utility functions
 * These test the pure logic functions used for function context visibility
 */

// Import the actual DiffRenderer module from production code
const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');

describe('DiffRenderer', () => {

  describe('findFileElement', () => {
    describe('file matching', () => {
      // Helper to mock document.querySelector and document.querySelectorAll
      // since tests run in Node environment (no real DOM)
      function setupDocumentMock(wrappers) {
        global.document = {
          querySelector: vi.fn().mockReturnValue(null),
          querySelectorAll: vi.fn().mockReturnValue(wrappers)
        };
      }

      function createMockWrapper(fileName) {
        return {
          dataset: { fileName }
        };
      }

      afterEach(() => {
        delete global.document;
      });

      it('should find file by exact data-file-name match', () => {
        const wrapper = createMockWrapper('tests/unit/new-name.test.js');
        global.document = {
          querySelector: vi.fn().mockReturnValue(wrapper),
          querySelectorAll: vi.fn().mockReturnValue([wrapper])
        };

        const result = DiffRenderer.findFileElement('tests/unit/new-name.test.js');
        expect(result).toBe(wrapper);
      });

      it('should find file by partial path matching', () => {
        const wrapper = createMockWrapper('src/utils/helper.js');
        setupDocumentMock([wrapper]);

        const result = DiffRenderer.findFileElement('utils/helper.js');
        expect(result).toBe(wrapper);
      });

      it('should normalize TanStack-style route paths before matching wrappers', () => {
        const tanstackPath = 'areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx';
        const wrapper = createMockWrapper(tanstackPath);
        setupDocumentMock([wrapper]);

        const result = DiffRenderer.findFileElement(`  ./${tanstackPath}  `);
        expect(result).toBe(wrapper);
      });

      it('should return null when no match found', () => {
        const wrapper = createMockWrapper('src/foo.js');
        setupDocumentMock([wrapper]);

        const result = DiffRenderer.findFileElement('src/nonexistent.js');
        expect(result).toBeNull();
      });

      it('should return null when no wrappers exist', () => {
        setupDocumentMock([]);

        const result = DiffRenderer.findFileElement('src/any-file.js');
        expect(result).toBeNull();
      });

      it('should find file by reverse partial path matching', () => {
        // data-file-name has short path, query has full path
        // filePath='src/utils/helper.js', fileName='helper.js'
        // filePath.endsWith('/helper.js') => true
        const wrapper = createMockWrapper('helper.js');
        setupDocumentMock([wrapper]);

        const result = DiffRenderer.findFileElement('src/utils/helper.js');
        expect(result).toBe(wrapper);
      });

      it('should find file by data-file-path attribute', () => {
        const wrapper = { dataset: { filePath: 'src/utils/helper.js' } };
        global.document = {
          querySelector: vi.fn().mockImplementation((selector) => {
            if (selector.includes('data-file-path')) return wrapper;
            return null;
          }),
          querySelectorAll: vi.fn().mockReturnValue([])
        };

        const result = DiffRenderer.findFileElement('src/utils/helper.js');
        expect(result).toBe(wrapper);
      });

      it('should fall back to wrapper iteration when selector lookup fails', () => {
        const weirdPath = 'src/routes/repos/"quoted"/route.tsx';
        const wrapper = createMockWrapper(weirdPath);
        global.document = {
          querySelector: vi.fn().mockImplementation(() => {
            throw new Error('Invalid selector');
          }),
          querySelectorAll: vi.fn().mockReturnValue([wrapper])
        };

        const result = DiffRenderer.findFileElement(weirdPath);
        expect(result).toBe(wrapper);
      });
    });
  });

  describe('normalizeFilePath', () => {
    it('iteratively strips interleaved leading slashes and ./ segments', () => {
      expect(DiffRenderer.normalizeFilePath('/./src/foo.js')).toBe('src/foo.js');
      expect(DiffRenderer.normalizeFilePath('./../src/foo.js')).toBe('../src/foo.js');
    });
  });
});
