// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Safe markdown renderer for comments
 * Uses markdown-it with security settings to prevent XSS
 */

/**
 * Escape HTML characters for use in HTML attribute values.
 * This escapes all characters that are special in attribute contexts:
 * <, >, &, ", and '
 * @param {string} text - Text to escape for attribute use
 * @returns {string} Escaped text safe for use in HTML attributes
 */
function escapeHtmlAttribute(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Browser-only code: markdown rendering requires markdown-it library
if (typeof window !== 'undefined' && window.markdownit) {
  (function() {
    // Initialize markdown-it with safe defaults
    const md = window.markdownit({
      html: false,        // Disable HTML tags to prevent XSS
      xhtmlOut: false,    // Don't use self-closing tags
      breaks: true,       // Convert \n to <br>
      langPrefix: 'language-',  // CSS class prefix for code blocks
      linkify: true,      // Auto-convert URLs to links
      typographer: true   // Enable smartquotes and other typographic replacements
    });

    // Configure link rendering to open in new tab and add security
    const defaultLinkRender = md.renderer.rules.link_open || function(tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };

    md.renderer.rules.link_open = function(tokens, idx, options, env, self) {
      const token = tokens[idx];
      token.attrPush(['target', '_blank']);
      token.attrPush(['rel', 'noopener noreferrer']);
      return defaultLinkRender(tokens, idx, options, env, self);
    };

    /**
     * Escape HTML characters (fallback for when markdown rendering fails)
     * NOTE: This only escapes <, >, and &. It does NOT escape quotes.
     * Use escapeHtmlAttribute() when placing content in HTML attributes.
     * @param {string} text - Text to escape
     * @returns {string} Escaped text
     */
    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    /**
     * Render markdown to safe HTML
     * @param {string} text - Markdown text to render
     * @returns {string} Safe HTML output
     */
    function renderMarkdown(text) {
      if (!text) return '';

      try {
        // Render markdown to HTML
        return md.render(text);
      } catch (error) {
        console.error('Markdown rendering error:', error);
        // Fall back to escaped text if rendering fails
        return escapeHtml(text);
      }
    }

    // Export functions to global scope
    window.renderMarkdown = renderMarkdown;

    // Also export markdown instance for advanced usage if needed
    window.markdownRenderer = md;
  })();
}

// Export escapeHtmlAttribute to window (browser) regardless of markdown-it availability
if (typeof window !== 'undefined') {
  window.escapeHtmlAttribute = escapeHtmlAttribute;
}

// Export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtmlAttribute };
}
