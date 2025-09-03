/**
 * Safe markdown renderer for comments
 * Uses markdown-it with security settings to prevent XSS
 */

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

  /**
   * Escape HTML characters (fallback for when markdown rendering fails)
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Export functions to global scope
  window.renderMarkdown = renderMarkdown;
  
  // Also export markdown instance for advanced usage if needed
  window.markdownRenderer = md;
})();