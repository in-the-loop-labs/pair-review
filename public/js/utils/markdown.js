// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Safe markdown renderer for comments.
 *
 * Uses markdown-it to render markdown and DOMPurify to sanitize the result.
 * Enabling raw HTML (`html: true`) lets us render the GitHub-supported inline
 * HTML subset (e.g. <sub>, <sup>, <kbd>) and lets DOMPurify strip HTML comments
 * (e.g. tracking markers) from the rendered view. DOMPurify is what keeps this
 * safe from XSS — it must be present before we enable raw HTML.
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

/**
 * GitHub-like allowlist for inline HTML permitted in comment bodies.
 * Standard markdown output tags plus the safe inline subset GitHub renders.
 */
const ALLOWED_TAGS = [
  // Standard markdown output
  'p', 'a', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'em', 'strong', 's', 'hr', 'br', 'span',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'img',
  // GitHub-supported inline HTML subset
  'sub', 'sup', 'kbd', 'ins', 'del', 'mark',
  'details', 'summary', 'abbr'
];

const ALLOWED_ATTR = [
  'href', 'title', 'target', 'rel',
  'src', 'alt', 'align', 'class',
  'start', 'colspan', 'rowspan'
];

/**
 * Configure a markdown-it instance with the project's rendering options.
 * Raw HTML is enabled here; sanitization happens separately via DOMPurify.
 * @param {function} markdownit - the markdown-it factory (window.markdownit)
 * @param {object} [opts]
 * @param {boolean} [opts.html=true] - allow raw HTML tokens
 * @param {object} [opts.emoji] - markdown-it-emoji plugin (optional)
 * @returns {object} configured markdown-it instance
 */
function configureMarkdownIt(markdownit, opts = {}) {
  const html = opts.html !== undefined ? opts.html : true;

  const md = markdownit({
    html,               // Allow raw HTML; DOMPurify sanitizes the output
    xhtmlOut: false,    // Don't use self-closing tags
    breaks: true,       // Convert \n to <br>
    langPrefix: 'language-',  // CSS class prefix for code blocks
    linkify: true,      // Auto-convert URLs to links
    typographer: true   // Enable smartquotes and other typographic replacements
  });

  // Enable emoji shortcode support (e.g., :smile: -> 😄)
  if (opts.emoji) {
    md.use(opts.emoji);
  }

  // Configure link rendering to open in new tab and add security.
  // (DOMPurify's afterSanitizeAttributes hook re-applies these as a backstop.)
  const defaultLinkRender = md.renderer.rules.link_open || function(tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };

  md.renderer.rules.link_open = function(tokens, idx, options, env, self) {
    const token = tokens[idx];
    token.attrPush(['target', '_blank']);
    token.attrPush(['rel', 'noopener noreferrer']);
    return defaultLinkRender(tokens, idx, options, env, self);
  };

  return md;
}

/**
 * Sanitize rendered HTML with DOMPurify using the project allowlist.
 * Removes HTML comments (default) and dangerous tags/attributes, converts
 * markdown-it's table-alignment inline style into the allowlisted `align`
 * attribute (so arbitrary inline styles never need to be permitted), forces
 * safe link attributes on anchors, and scopes `class` to markdown code
 * language hints only.
 * @param {object} purify - a configured DOMPurify instance
 * @param {string} html - HTML to sanitize
 * @returns {string} sanitized HTML
 */
function sanitizeHtml(purify, html) {
  // Hooks are registered idempotently (removed then re-added) so repeated
  // sanitize() calls on the same instance don't stack duplicates.

  // markdown-it encodes table column alignment as an inline `text-align` style.
  // Convert it to the allowlisted `align` attribute BEFORE sanitization so we
  // never have to permit arbitrary inline styles (which could hide or cover
  // review UI via position/z-index/display). The `style` attribute itself is
  // then dropped by the allowlist.
  purify.removeHook('beforeSanitizeAttributes');
  purify.addHook('beforeSanitizeAttributes', function (node) {
    const tag = node.tagName;
    if (tag === 'TH' || tag === 'TD') {
      const align = node.style && node.style.textAlign;
      if (align === 'left' || align === 'center' || align === 'right') {
        node.setAttribute('align', align);
      }
    }
  });

  purify.removeHook('afterSanitizeAttributes');
  purify.addHook('afterSanitizeAttributes', function (node) {
    const tag = node.tagName;
    // Force safe rel/target on links regardless of DOMPurify version defaults.
    if (tag === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    // Scope `class` to expected markdown output: only `language-*` on code/pre.
    // Stops rendered repo content from reusing layout-sensitive app classes.
    if (node.hasAttribute('class')) {
      const kept =
        tag === 'CODE' || tag === 'PRE'
          ? node.getAttribute('class').split(/\s+/).filter((c) => /^language-[\w-]+$/.test(c))
          : [];
      if (kept.length) {
        node.setAttribute('class', kept.join(' '));
      } else {
        node.removeAttribute('class');
      }
    }
  });

  return purify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * Create the renderMarkdown function.
 * When a DOMPurify instance is provided, the markdown-it output is sanitized
 * (safe to enable raw HTML). Without it, callers should pass an md configured
 * with `html: false` so no unsanitized HTML is ever emitted.
 * @param {object} config
 * @param {object} config.md - configured markdown-it instance
 * @param {object} [config.purify] - DOMPurify instance (optional)
 * @param {function} [config.escape] - fallback escaper for render errors
 * @returns {function(string): string} renderMarkdown
 */
function createRenderMarkdown(config) {
  const { md, purify, escape } = config;
  const fallbackEscape = escape || ((text) => escapeHtmlAttribute(text));

  return function renderMarkdown(text) {
    if (!text) return '';

    try {
      const rendered = md.render(text);
      return purify ? sanitizeHtml(purify, rendered) : rendered;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Markdown rendering error:', error);
      // Fall back to escaped text if rendering fails
      return fallbackEscape(text);
    }
  };
}

/**
 * Wire the markdown renderer onto a window/global object.
 * Raw HTML is only enabled when a DOMPurify instance is present to sanitize it;
 * otherwise we fall back to html:false so unsanitized HTML is never emitted.
 * Defines `win.renderMarkdown` and `win.markdownRenderer`. No-op without
 * `win.markdownit`.
 * @param {object} win - a window-like object (expects markdownit, optionally
 *   DOMPurify, markdownitEmoji, and document)
 */
function initMarkdownGlobals(win) {
  if (!win || !win.markdownit) return;

  /**
   * Escape HTML characters (fallback for when markdown rendering fails).
   * NOTE: This only escapes <, >, and &. It does NOT escape quotes.
   * Use escapeHtmlAttribute() when placing content in HTML attributes.
   */
  function escapeHtml(text) {
    if (!text) return '';
    const div = win.document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Only enable raw HTML when DOMPurify is available to sanitize it.
  const purify = win.DOMPurify || null;
  const md = configureMarkdownIt(win.markdownit, {
    html: !!purify,
    emoji: win.markdownitEmoji || undefined
  });

  win.renderMarkdown = createRenderMarkdown({ md, purify, escape: escapeHtml });
  // Also expose the markdown instance for advanced usage if needed.
  win.markdownRenderer = md;
}

// Browser-only code: markdown rendering requires the markdown-it library.
if (typeof window !== 'undefined') {
  initMarkdownGlobals(window);
  // Export escapeHtmlAttribute regardless of markdown-it availability.
  window.escapeHtmlAttribute = escapeHtmlAttribute;
}

// Export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    escapeHtmlAttribute,
    configureMarkdownIt,
    sanitizeHtml,
    createRenderMarkdown,
    initMarkdownGlobals,
    ALLOWED_TAGS,
    ALLOWED_ATTR
  };
}
