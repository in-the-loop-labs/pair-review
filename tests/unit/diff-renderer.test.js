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
});
