// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';

/**
 * Unit tests for HTML escaping utilities
 * Tests the escapeHtmlAttribute function which properly escapes
 * all characters that are special in HTML attribute contexts.
 */

// Import the actual production code
const { escapeHtmlAttribute } = require('../../public/js/utils/markdown.js');

describe('escapeHtmlAttribute', () => {
  describe('basic escaping', () => {
    it('should escape double quotes', () => {
      expect(escapeHtmlAttribute('Check the "variable" assignment'))
        .toBe('Check the &quot;variable&quot; assignment');
    });

    it('should escape single quotes', () => {
      expect(escapeHtmlAttribute("It's a test"))
        .toBe('It&#39;s a test');
    });

    it('should escape ampersands', () => {
      expect(escapeHtmlAttribute('foo & bar'))
        .toBe('foo &amp; bar');
    });

    it('should escape less than signs', () => {
      expect(escapeHtmlAttribute('a < b'))
        .toBe('a &lt; b');
    });

    it('should escape greater than signs', () => {
      expect(escapeHtmlAttribute('a > b'))
        .toBe('a &gt; b');
    });
  });

  describe('combined escaping', () => {
    it('should escape all special characters together', () => {
      expect(escapeHtmlAttribute('Check "foo" & \'bar\' for <value>'))
        .toBe('Check &quot;foo&quot; &amp; &#39;bar&#39; for &lt;value&gt;');
    });

    it('should handle code suggestions with quotes', () => {
      const codeWithQuotes = 'The variable "count" should be initialized to 0';
      expect(escapeHtmlAttribute(codeWithQuotes))
        .toBe('The variable &quot;count&quot; should be initialized to 0');
    });

    it('should handle nested quotes', () => {
      expect(escapeHtmlAttribute('He said "She said \'hello\'"'))
        .toBe('He said &quot;She said &#39;hello&#39;&quot;');
    });
  });

  describe('edge cases', () => {
    it('should handle empty string', () => {
      expect(escapeHtmlAttribute('')).toBe('');
    });

    it('should handle null', () => {
      expect(escapeHtmlAttribute(null)).toBe('');
    });

    it('should handle undefined', () => {
      expect(escapeHtmlAttribute(undefined)).toBe('');
    });

    it('should handle text with no special characters', () => {
      expect(escapeHtmlAttribute('Hello World'))
        .toBe('Hello World');
    });

    it('should handle multiline text', () => {
      expect(escapeHtmlAttribute('Line 1\nLine 2 with "quotes"'))
        .toBe('Line 1\nLine 2 with &quot;quotes&quot;');
    });
  });

  describe('HTML attribute safety', () => {
    it('should produce safe output for HTML attributes', () => {
      // This test verifies that the escaped output won't break HTML attributes
      const dangerousInput = 'value" onclick="alert(1)';
      const escaped = escapeHtmlAttribute(dangerousInput);

      // The output should not contain unescaped quotes
      expect(escaped).not.toContain('"');
      expect(escaped).toBe('value&quot; onclick=&quot;alert(1)');
    });

    it('should handle attribute injection attempts', () => {
      const injection = '"><script>alert("xss")</script><div class="';
      const escaped = escapeHtmlAttribute(injection);

      expect(escaped).not.toContain('"');
      expect(escaped).not.toContain('<');
      expect(escaped).not.toContain('>');
    });
  });
});
