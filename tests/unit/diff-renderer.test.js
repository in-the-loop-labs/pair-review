// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests for DiffRenderer utility functions
 * These test the pure logic functions used for function context visibility
 */

// Import the actual DiffRenderer module from production code
const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');

describe('DiffRenderer', () => {
  describe('isFunctionDefinitionLine', () => {
    describe('basic matching', () => {
      it('should match when line starts with function context', () => {
        expect(DiffRenderer.isFunctionDefinitionLine(
          'function myFunction() {',
          'function myFunction()'
        )).toBe(true);
      });

      it('should match when line starts with function context after trimming', () => {
        expect(DiffRenderer.isFunctionDefinitionLine(
          '  function myFunction() {',
          'function myFunction()'
        )).toBe(true);
      });

      it('should match function context with opening paren pattern', () => {
        expect(DiffRenderer.isFunctionDefinitionLine(
          'export function myFunction(arg1, arg2) {',
          'function myFunction'
        )).toBe(true);
      });

      it('should match function context with space pattern', () => {
        expect(DiffRenderer.isFunctionDefinitionLine(
          'async function myFunction()',
          'function myFunction'
        )).toBe(true);
      });
    });

    describe('different languages', () => {
      it('should match JavaScript arrow functions', () => {
        expect(DiffRenderer.isFunctionDefinitionLine(
          'const myFunc = () => {',
          'const myFunc'
        )).toBe(true);
      });

      it('should match Python function definitions', () => {
        expect(DiffRenderer.isFunctionDefinitionLine(
          'def process_data(input):',
          'def process_data'
        )).toBe(true);
      });

      it('should match class methods', () => {
        expect(DiffRenderer.isFunctionDefinitionLine(
          '  async submitReview() {',
          'async submitReview()'
        )).toBe(true);
      });

      it('should match Go function definitions', () => {
        expect(DiffRenderer.isFunctionDefinitionLine(
          'func (s *Server) handleRequest(w http.ResponseWriter) {',
          'func (s *Server) handleRequest'
        )).toBe(true);
      });
    });

    describe('false positive prevention', () => {
      it('should not match when function name appears mid-line without pattern', () => {
        // The function name appears but not at start and not followed by ( or space
        expect(DiffRenderer.isFunctionDefinitionLine(
          'console.log("calling myFunction");',
          'myFunction'
        )).toBe(false);
      });

      it('should not match partial function names', () => {
        expect(DiffRenderer.isFunctionDefinitionLine(
          'function myFunctionExtended() {',
          'function myFunction()'
        )).toBe(false);
      });

      it('should not match when pattern is not followed by ( or space', () => {
        // The function name appears but not followed by ( or space
        expect(DiffRenderer.isFunctionDefinitionLine(
          'console.log("myFunctionX");',
          'myFunction'
        )).toBe(false);
      });

      it('should match false positive when function name + space appears in string (limitation)', () => {
        // Note: This is a known limitation - if a string literal contains the function name
        // followed by a space, it will match. In practice, function context from git
        // includes the full signature (e.g., "function myFunction()") not just the name,
        // making false positives extremely rare.
        expect(DiffRenderer.isFunctionDefinitionLine(
          'console.log("myFunction was called");',
          'myFunction'
        )).toBe(true);
      });

      it('should match when function name starts the line (limitation: comments)', () => {
        // Note: This is a known limitation - if a comment starts with the function name
        // followed by a space, it will match. In practice this is rare and acceptable.
        expect(DiffRenderer.isFunctionDefinitionLine(
          '// myFunction does something',
          'myFunction'
        )).toBe(true);
      });
    });

    describe('edge cases', () => {
      it('should return false for null lineText', () => {
        expect(DiffRenderer.isFunctionDefinitionLine(null, 'function test')).toBe(false);
      });

      it('should return false for null functionContext', () => {
        expect(DiffRenderer.isFunctionDefinitionLine('function test() {', null)).toBe(false);
      });

      it('should return false for empty lineText', () => {
        expect(DiffRenderer.isFunctionDefinitionLine('', 'function test')).toBe(false);
      });

      it('should return false for empty functionContext', () => {
        expect(DiffRenderer.isFunctionDefinitionLine('function test() {', '')).toBe(false);
      });

      it('should return false for whitespace-only lineText', () => {
        expect(DiffRenderer.isFunctionDefinitionLine('   ', 'function test')).toBe(false);
      });

      it('should match any line when functionContext is whitespace-only (edge case)', () => {
        // Note: This is an edge case - whitespace-only function context trims to empty string
        // and startsWith('') is always true. In practice, function context from git
        // will never be whitespace-only.
        expect(DiffRenderer.isFunctionDefinitionLine('function test', '   ')).toBe(true);
      });

      it('should handle function context with extra whitespace', () => {
        expect(DiffRenderer.isFunctionDefinitionLine(
          'function myFunction() {',
          '  function myFunction()  '
        )).toBe(true);
      });
    });
  });

  describe('removeFunctionContextHeader', () => {
    it('should call remove on valid header row', () => {
      const mockRow = {
        classList: {
          contains: vi.fn().mockReturnValue(true)
        },
        remove: vi.fn()
      };

      DiffRenderer.removeFunctionContextHeader(mockRow);
      expect(mockRow.remove).toHaveBeenCalled();
    });

    it('should not call remove if row is null', () => {
      // Should not throw
      expect(() => DiffRenderer.removeFunctionContextHeader(null)).not.toThrow();
    });

    it('should not call remove if row does not have d2h-info class', () => {
      const mockRow = {
        classList: {
          contains: vi.fn().mockReturnValue(false)
        },
        remove: vi.fn()
      };

      DiffRenderer.removeFunctionContextHeader(mockRow);
      expect(mockRow.remove).not.toHaveBeenCalled();
    });
  });

  describe('removeStrandedHunkHeaders', () => {
    // NOTE: The mock wires up static previousElementSibling pointers once at
    // creation time. This is sufficient for single-mutation scenarios (one
    // header relocated or removed per test), but sibling pointers are NOT
    // updated after DOM mutations (remove/insertAdjacentElement). For tests
    // that verify multi-mutation interactions, either enhance the mock with
    // a linked-list that re-wires on mutation, or use jsdom.
    function createMockRow(type, options = {}) {
      const classList = new Set();
      if (type === 'header') classList.add('d2h-info');
      if (type === 'gap') classList.add('context-expand-row');

      return {
        classList: {
          contains: (className) => classList.has(className),
          add: (className) => classList.add(className)
        },
        dataset: options.dataset || {},
        previousElementSibling: null,
        remove: vi.fn(),
        insertAdjacentElement: vi.fn()
      };
    }

    function createMockTbody(rows) {
      // Wire up previousElementSibling for each row
      for (let i = 0; i < rows.length; i++) {
        rows[i].previousElementSibling = i > 0 ? rows[i - 1] : null;
      }
      return {
        querySelectorAll: vi.fn().mockReturnValue(
          rows.filter(r => r.classList.contains('d2h-info'))
        )
      };
    }

    it('should not throw on null tbody', () => {
      expect(() => DiffRenderer.removeStrandedHunkHeaders(null)).not.toThrow();
    });

    it('should keep header that is the first row in the tbody', () => {
      const header = createMockRow('header');
      const tbody = createMockTbody([header]);

      DiffRenderer.removeStrandedHunkHeaders(tbody);
      expect(header.remove).not.toHaveBeenCalled();
    });

    it('should keep header preceded by a gap row', () => {
      const gap = createMockRow('gap');
      const header = createMockRow('header');
      const tbody = createMockTbody([gap, header]);

      DiffRenderer.removeStrandedHunkHeaders(tbody);
      expect(header.remove).not.toHaveBeenCalled();
    });

    it('should remove header preceded by a content row (stranded, no function context)', () => {
      const content = createMockRow('content');
      const header = createMockRow('header');
      const tbody = createMockTbody([content, header]);

      DiffRenderer.removeStrandedHunkHeaders(tbody);
      expect(header.remove).toHaveBeenCalled();
    });

    it('should handle mix of stranded and boundary headers', () => {
      const gap = createMockRow('gap');
      const header1 = createMockRow('header'); // preceded by gap → keep
      const content = createMockRow('content');
      const header2 = createMockRow('header'); // preceded by content → remove
      const tbody = createMockTbody([gap, header1, content, header2]);

      DiffRenderer.removeStrandedHunkHeaders(tbody);
      expect(header1.remove).not.toHaveBeenCalled();
      expect(header2.remove).toHaveBeenCalled();
    });

    it('should remove header preceded by another header (no gap between)', () => {
      const gap = createMockRow('gap');
      const header1 = createMockRow('header');
      const header2 = createMockRow('header'); // preceded by header → remove
      const tbody = createMockTbody([gap, header1, header2]);

      DiffRenderer.removeStrandedHunkHeaders(tbody);
      expect(header1.remove).not.toHaveBeenCalled();
      expect(header2.remove).toHaveBeenCalled();
    });

    describe('function context relocation', () => {
      it('should relocate stranded header with function context to nearest gap above', () => {
        // Scenario: expand up created [gap] [code...] [_f_ header] [code...]
        const gap = createMockRow('gap');
        const code1 = createMockRow('content');
        const code2 = createMockRow('content');
        const header = createMockRow('header', {
          dataset: { functionContext: 'function foo()' }
        });
        const tbody = createMockTbody([gap, code1, code2, header]);

        DiffRenderer.removeStrandedHunkHeaders(tbody);
        // Should relocate, not remove
        expect(header.remove).not.toHaveBeenCalled();
        expect(gap.insertAdjacentElement).toHaveBeenCalledWith('afterend', header);
      });

      it('should remove stranded header with function context when no gap above', () => {
        // Scenario: expand all removed the entire gap, no gap remains
        const code = createMockRow('content');
        const header = createMockRow('header', {
          dataset: { functionContext: 'function foo()' }
        });
        const tbody = createMockTbody([code, header]);

        DiffRenderer.removeStrandedHunkHeaders(tbody);
        expect(header.remove).toHaveBeenCalled();
      });

      it('should not cross hunk header boundaries when searching for gap', () => {
        // [gap] [otherHeader] [code] [header with functionContext]
        // Search from header should stop at otherHeader, not find the gap
        const gap = createMockRow('gap');
        const otherHeader = createMockRow('header');
        const code = createMockRow('content');
        const header = createMockRow('header', {
          dataset: { functionContext: 'function foo()' }
        });
        const tbody = createMockTbody([gap, otherHeader, code, header]);

        DiffRenderer.removeStrandedHunkHeaders(tbody);
        // otherHeader is kept (preceded by gap)
        expect(otherHeader.remove).not.toHaveBeenCalled();
        // header can't reach the gap (blocked by otherHeader) → removed
        expect(header.remove).toHaveBeenCalled();
        expect(gap.insertAdjacentElement).not.toHaveBeenCalled();
      });

      it('should still remove stranded ... dividers even when gap exists above', () => {
        // A header without function context (... divider) should be removed, not relocated
        const gap = createMockRow('gap');
        const code = createMockRow('content');
        const header = createMockRow('header'); // no functionContext in dataset
        const tbody = createMockTbody([gap, code, header]);

        DiffRenderer.removeStrandedHunkHeaders(tbody);
        expect(header.remove).toHaveBeenCalled();
        expect(gap.insertAdjacentElement).not.toHaveBeenCalled();
      });

      it('should relocate to immediately preceding gap (single code row between)', () => {
        // [gap] [code] [header with functionContext]
        const gap = createMockRow('gap');
        const code = createMockRow('content');
        const header = createMockRow('header', {
          dataset: { functionContext: 'class MyClass' }
        });
        const tbody = createMockTbody([gap, code, header]);

        DiffRenderer.removeStrandedHunkHeaders(tbody);
        expect(header.remove).not.toHaveBeenCalled();
        expect(gap.insertAdjacentElement).toHaveBeenCalledWith('afterend', header);
      });
    });
  });

  describe('updateFunctionContextVisibility', () => {
    // Helper to create mock DOM structure
    function createMockTbody(rows) {
      return {
        querySelectorAll: vi.fn().mockReturnValue(rows)
      };
    }

    function createMockRow(type, options = {}) {
      const classList = new Set();
      if (type === 'header') classList.add('d2h-info');
      if (type === 'gap') classList.add('context-expand-row');

      return {
        classList: {
          contains: (className) => classList.has(className),
          add: (className) => classList.add(className)
        },
        dataset: options.dataset || {},
        querySelector: vi.fn().mockReturnValue(options.contentCell || null),
        remove: vi.fn()
      };
    }

    it('should not throw on null tbody', () => {
      expect(() => DiffRenderer.updateFunctionContextVisibility(null)).not.toThrow();
    });

    it('should do nothing if no headers have function context', () => {
      const header = createMockRow('header', { dataset: {} });
      const tbody = createMockTbody([header]);

      DiffRenderer.updateFunctionContextVisibility(tbody);
      expect(header.remove).not.toHaveBeenCalled();
    });

    it('should remove header when function definition is found above it', () => {
      const contentRow = createMockRow('content', {
        contentCell: { textContent: 'function myFunction() {' }
      });
      const header = createMockRow('header', {
        dataset: { functionContext: 'function myFunction()' }
      });

      const tbody = createMockTbody([contentRow, header]);

      DiffRenderer.updateFunctionContextVisibility(tbody);
      expect(header.remove).toHaveBeenCalled();
    });

    it('should not remove header when function definition is not found', () => {
      const contentRow = createMockRow('content', {
        contentCell: { textContent: 'const x = 5;' }
      });
      const header = createMockRow('header', {
        dataset: { functionContext: 'function myFunction()' }
      });

      const tbody = createMockTbody([contentRow, header]);

      DiffRenderer.updateFunctionContextVisibility(tbody);
      expect(header.remove).not.toHaveBeenCalled();
    });

    it('should stop searching at another hunk header', () => {
      const contentRow = createMockRow('content', {
        contentCell: { textContent: 'function myFunction() {' }
      });
      const firstHeader = createMockRow('header', { dataset: {} });
      const secondHeader = createMockRow('header', {
        dataset: { functionContext: 'function myFunction()' }
      });

      // Content is before the first header, second header is after first header
      // So the function definition is not "above" the second header within its hunk
      const tbody = createMockTbody([contentRow, firstHeader, secondHeader]);

      DiffRenderer.updateFunctionContextVisibility(tbody);
      // Second header should not be removed because search stops at firstHeader
      expect(secondHeader.remove).not.toHaveBeenCalled();
    });

    it('should skip gap rows when searching', () => {
      const gapRow = createMockRow('gap');
      const contentRow = createMockRow('content', {
        contentCell: { textContent: 'function myFunction() {' }
      });
      const header = createMockRow('header', {
        dataset: { functionContext: 'function myFunction()' }
      });

      // Gap is between content and header
      const tbody = createMockTbody([contentRow, gapRow, header]);

      DiffRenderer.updateFunctionContextVisibility(tbody);
      // Should find content row by skipping gap
      expect(header.remove).toHaveBeenCalled();
    });

    it('should handle multiple headers independently', () => {
      const content1 = createMockRow('content', {
        contentCell: { textContent: 'function first() {' }
      });
      const header1 = createMockRow('header', {
        dataset: { functionContext: 'function first()' }
      });
      const content2 = createMockRow('content', {
        contentCell: { textContent: 'const x = 5;' }
      });
      const header2 = createMockRow('header', {
        dataset: { functionContext: 'function second()' }
      });

      const tbody = createMockTbody([content1, header1, content2, header2]);

      DiffRenderer.updateFunctionContextVisibility(tbody);
      // First header should be removed (function found above)
      expect(header1.remove).toHaveBeenCalled();
      // Second header should not be removed (no matching function above it within its hunk)
      expect(header2.remove).not.toHaveBeenCalled();
    });
  });

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
    });
  });

  describe('fixRubyHighlighting', () => {
    // Workaround for highlight.js Ruby grammar limitation:
    // Variables at end-of-line truncate at last underscore due to lookahead constraints
    // e.g., @foo_bar_baz becomes <span class="hljs-variable">@foo_bar</span>_baz

    describe('instance variables', () => {
      it('should fix single trailing segment', () => {
        const input = '<span class="hljs-variable">@foo_bar</span>_baz';
        const expected = '<span class="hljs-variable">@foo_bar_baz</span>';
        expect(DiffRenderer.fixRubyHighlighting(input)).toBe(expected);
      });

      it('should fix variable with multiple segments', () => {
        const input = '<span class="hljs-variable">@previous_deployed_release_cycle_start</span>_commit';
        const expected = '<span class="hljs-variable">@previous_deployed_release_cycle_start_commit</span>';
        expect(DiffRenderer.fixRubyHighlighting(input)).toBe(expected);
      });

      it('should fix variable with simple name', () => {
        const input = '<span class="hljs-variable">@simple</span>_var';
        const expected = '<span class="hljs-variable">@simple_var</span>';
        expect(DiffRenderer.fixRubyHighlighting(input)).toBe(expected);
      });

      it('should handle multiple variables on same line', () => {
        const input = '<span class="hljs-variable">@first</span>_var = <span class="hljs-variable">@second</span>_var';
        const expected = '<span class="hljs-variable">@first_var</span> = <span class="hljs-variable">@second_var</span>';
        expect(DiffRenderer.fixRubyHighlighting(input)).toBe(expected);
      });
    });

    describe('class variables', () => {
      it('should fix class variables with @@', () => {
        const input = '<span class="hljs-variable">@@class_variable</span>_commit';
        const expected = '<span class="hljs-variable">@@class_variable_commit</span>';
        expect(DiffRenderer.fixRubyHighlighting(input)).toBe(expected);
      });
    });

    describe('global variables', () => {
      it('should fix global variables with $', () => {
        const input = '<span class="hljs-variable">$LOAD</span>_PATH';
        const expected = '<span class="hljs-variable">$LOAD_PATH</span>';
        expect(DiffRenderer.fixRubyHighlighting(input)).toBe(expected);
      });

      it('should fix global variables with multiple segments', () => {
        const input = '<span class="hljs-variable">$foo_bar</span>_baz';
        const expected = '<span class="hljs-variable">$foo_bar_baz</span>';
        expect(DiffRenderer.fixRubyHighlighting(input)).toBe(expected);
      });
    });

    describe('edge cases', () => {
      it('should not modify correctly highlighted variables', () => {
        const input = '<span class="hljs-variable">@correct_var</span> = 1';
        expect(DiffRenderer.fixRubyHighlighting(input)).toBe(input);
      });

      it('should not modify non-variable spans followed by underscores', () => {
        const input = '<span class="hljs-keyword">def</span>_something';
        expect(DiffRenderer.fixRubyHighlighting(input)).toBe(input);
      });

      it('should handle empty input', () => {
        expect(DiffRenderer.fixRubyHighlighting('')).toBe('');
      });

      it('should handle input with no variables', () => {
        const input = 'plain text without variables';
        expect(DiffRenderer.fixRubyHighlighting(input)).toBe(input);
      });

      it('should handle variable at end of line without trailing segment', () => {
        const input = '<span class="hljs-variable">@valid_var</span>';
        expect(DiffRenderer.fixRubyHighlighting(input)).toBe(input);
      });

      it('should not merge if followed by space then underscore', () => {
        // Space breaks the variable - should not merge
        const input = '<span class="hljs-variable">@foo</span> _bar';
        expect(DiffRenderer.fixRubyHighlighting(input)).toBe(input);
      });
    });
  });

  describe('fixMarkdownHighlighting', () => {
    // Workaround for highlight.js Markdown grammar limitation:
    // Mid-word underscores are incorrectly treated as emphasis/strong markers
    // e.g., update_policy => update<span class="hljs-emphasis">_policy</span>

    describe('mid-word emphasis (single underscore)', () => {
      it('should strip emphasis when preceded by word character', () => {
        const input = 'update<span class="hljs-emphasis">_policy</span>';
        const expected = 'update_policy';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(expected);
      });

      it('should strip emphasis for snake_case pairs', () => {
        const input = 'snake<span class="hljs-emphasis">_case_</span>var';
        const expected = 'snake_case_var';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(expected);
      });

      it('should strip emphasis spanning multiple words when preceded by word char', () => {
        const input = 'update<span class="hljs-emphasis">_policy and another_</span>var';
        const expected = 'update_policy and another_var';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(expected);
      });

      it('should handle multiple mid-word emphasis spans on same line', () => {
        const input = 'first<span class="hljs-emphasis">_var</span> and second<span class="hljs-emphasis">_var</span>';
        const expected = 'first_var and second_var';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(expected);
      });

      it('should strip emphasis after digits', () => {
        const input = 'v2<span class="hljs-emphasis">_release</span>';
        const expected = 'v2_release';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(expected);
      });
    });

    describe('legitimate emphasis preservation', () => {
      it('should preserve emphasis at start of text', () => {
        const input = '<span class="hljs-emphasis">_italic_</span> text';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(input);
      });

      it('should preserve emphasis after space', () => {
        const input = 'this is <span class="hljs-emphasis">_italic_</span> text';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(input);
      });
    });

    describe('mid-word strong (double underscore)', () => {
      it('should strip strong when preceded by word character', () => {
        const input = 'mid<span class="hljs-strong">__word__</span>bold';
        const expected = 'mid__word__bold';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(expected);
      });

      it('should preserve strong at start of text', () => {
        const input = '<span class="hljs-strong">__bold__</span> text';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(input);
      });

      it('should preserve strong after space', () => {
        const input = 'this is <span class="hljs-strong">__bold__</span> text';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(input);
      });
    });

    describe('edge cases', () => {
      it('should handle empty input', () => {
        expect(DiffRenderer.fixMarkdownHighlighting('')).toBe('');
      });

      it('should handle input with no emphasis spans', () => {
        const input = 'plain text without emphasis';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(input);
      });

      it('should handle bullet list with snake_case', () => {
        // highlight.js wraps bullet then emphasis separately
        const input = '<span class="hljs-bullet">-</span> update<span class="hljs-emphasis">_policy: description</span>';
        const expected = '<span class="hljs-bullet">-</span> update_policy: description';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(expected);
      });

      it('should not modify non-emphasis spans', () => {
        const input = 'word<span class="hljs-keyword">_something</span>';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(input);
      });

      it('should not break when emphasis span contains nested markup', () => {
        // If highlight.js nests spans (e.g., bold inside italic), the regex
        // should leave the outer span untouched rather than producing broken HTML
        const input = 'word<span class="hljs-emphasis">_text <span class="hljs-strong">**bold**</span> more_</span>';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(input);
      });

      it('should not break when strong span contains nested markup', () => {
        const input = 'word<span class="hljs-strong">__text <span class="hljs-emphasis">_ital_</span> more__</span>';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(input);
      });

      it('should handle underscore after another underscore (word char)', () => {
        const input = 'a<span class="hljs-emphasis">_b</span>';
        const expected = 'a_b';
        expect(DiffRenderer.fixMarkdownHighlighting(input)).toBe(expected);
      });
    });
  });

  describe('renderDiffLine — chat button', () => {
    // Minimal DOM mock for renderDiffLine which calls document.createElement
    let origDocument, origWindow;

    beforeEach(() => {
      origDocument = global.document;
      origWindow = global.window;

      // Lightweight DOM element factory
      function createElement(tag) {
        const children = [];
        let _innerHTML = '';
        let _className = '';
        const _dataset = {};
        const el = {
          tagName: tag.toUpperCase(),
          children,
          childNodes: children,
          style: {},
          dataset: _dataset,
          get className() { return _className; },
          set className(v) { _className = v; },
          get innerHTML() { return _innerHTML; },
          set innerHTML(v) { _innerHTML = v; },
          textContent: '',
          title: '',
          disabled: false,
          onmousedown: null,
          onmouseover: null,
          onmouseup: null,
          onclick: null,
          appendChild(child) { children.push(child); return child; },
          insertBefore(child, ref) {
            const idx = children.indexOf(ref);
            if (idx >= 0) children.splice(idx, 0, child);
            else children.push(child);
            return child;
          },
          querySelector(sel) {
            // Depth-first search through children
            for (const c of children) {
              if (c.className && sel.startsWith('.') && c.className.includes(sel.slice(1))) return c;
              if (c.querySelector) {
                const found = c.querySelector(sel);
                if (found) return found;
              }
            }
            return null;
          },
        };
        return el;
      }

      global.document = { createElement: vi.fn(createElement) };
      global.window = {
        Icons: { icon: (name, w, h) => `<svg data-icon="${name}"></svg>` },
      };
    });

    afterEach(() => {
      global.document = origDocument;
      global.window = origWindow;
    });

    const baseLine = { type: 'insert', newNumber: 10, content: '+hello' };
    const baseOptions = {
      onCommentButtonClick: vi.fn(),
      lineTracker: { potentialDragStart: null },
    };

    it('creates chat-line-btn when onChatButtonClick provided', () => {
      const row = DiffRenderer.renderDiffLine(null, baseLine, 'src/app.js', 5, {
        ...baseOptions,
        onChatButtonClick: vi.fn(),
      });

      // The line-number-content div is inside the first td
      const lineNumCell = row.children[0]; // td.d2h-code-linenumber
      const lineNumContent = lineNumCell.children[0]; // div.line-number-content
      const chatBtn = lineNumContent.children.find(c => c.className?.includes('chat-line-btn'));

      expect(chatBtn).toBeDefined();
      expect(chatBtn.className).toContain('chat-line-btn');
      expect(chatBtn.className).toContain('ai-action-chat');
    });

    it('does NOT create chat-line-btn when onChatButtonClick missing', () => {
      const row = DiffRenderer.renderDiffLine(null, baseLine, 'src/app.js', 5, baseOptions);

      const lineNumCell = row.children[0];
      const lineNumContent = lineNumCell.children[0];
      const chatBtn = lineNumContent.children.find(c => c.className?.includes('chat-line-btn'));

      expect(chatBtn).toBeUndefined();
    });

    it('chat-line-btn is before add-comment-btn in DOM', () => {
      const row = DiffRenderer.renderDiffLine(null, baseLine, 'src/app.js', 5, {
        ...baseOptions,
        onChatButtonClick: vi.fn(),
      });

      const lineNumCell = row.children[0];
      const lineNumContent = lineNumCell.children[0];
      const chatIdx = lineNumContent.children.findIndex(c => c.className?.includes('chat-line-btn'));
      const commentIdx = lineNumContent.children.findIndex(c => c.className?.includes('add-comment-btn'));

      expect(chatIdx).toBeGreaterThanOrEqual(0);
      expect(commentIdx).toBeGreaterThanOrEqual(0);
      expect(chatIdx).toBeLessThan(commentIdx);
    });

    it('mousedown sets potentialDragStart with isChat: true', () => {
      const lineTracker = { potentialDragStart: null };
      const row = DiffRenderer.renderDiffLine(null, baseLine, 'src/app.js', 5, {
        ...baseOptions,
        lineTracker,
        onChatButtonClick: vi.fn(),
      });

      const lineNumCell = row.children[0];
      const lineNumContent = lineNumCell.children[0];
      const chatBtn = lineNumContent.children.find(c => c.className?.includes('chat-line-btn'));

      // Simulate mousedown
      const mockEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
      chatBtn.onmousedown(mockEvent);

      expect(lineTracker.potentialDragStart).toBeDefined();
      expect(lineTracker.potentialDragStart.isChat).toBe(true);
      expect(lineTracker.potentialDragStart.lineNumber).toBe(10);
      expect(lineTracker.potentialDragStart.fileName).toBe('src/app.js');
    });

    it('comment button mousedown does NOT set isChat', () => {
      const lineTracker = { potentialDragStart: null };
      const row = DiffRenderer.renderDiffLine(null, baseLine, 'src/app.js', 5, {
        ...baseOptions,
        lineTracker,
        onChatButtonClick: vi.fn(),
      });

      const lineNumCell = row.children[0];
      const lineNumContent = lineNumCell.children[0];
      const commentBtn = lineNumContent.children.find(c => c.className?.includes('add-comment-btn'));

      const mockEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
      commentBtn.onmousedown(mockEvent);

      expect(lineTracker.potentialDragStart).toBeDefined();
      expect(lineTracker.potentialDragStart.isChat).toBeUndefined();
    });
  });
});
