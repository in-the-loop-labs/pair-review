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

// Keep synchronous highlighting bounded. Rendered documents already have a
// whole-file limit, but comments and chat messages use this renderer too.
const MAX_HIGHLIGHT_CODE_LENGTH = 50_000;
const MAX_HIGHLIGHT_OUTPUT_LENGTH = 1_000_000;

// Only token scopes styled by the bundled GitHub palettes may survive raw
// repository HTML. Keep this explicit rather than accepting arbitrary
// `hljs-*` names that merely resemble highlighter output.
const HLJS_TOKEN_CLASSES = new Set([
  'hljs-addition', 'hljs-attr', 'hljs-attribute', 'hljs-built_in',
  'hljs-bullet', 'hljs-code', 'hljs-comment', 'hljs-deletion',
  'hljs-doctag', 'hljs-emphasis', 'hljs-formula', 'hljs-keyword',
  'hljs-literal', 'hljs-meta', 'hljs-name', 'hljs-number',
  'hljs-operator', 'hljs-quote', 'hljs-regexp', 'hljs-section',
  'hljs-selector-attr', 'hljs-selector-class', 'hljs-selector-id',
  'hljs-selector-pseudo', 'hljs-selector-tag', 'hljs-string',
  'hljs-strong', 'hljs-subst', 'hljs-symbol', 'hljs-template-tag',
  'hljs-template-variable', 'hljs-title', 'hljs-type', 'hljs-variable'
]);

// highlight.js emits these secondary scope modifiers alongside a token class,
// and the bundled GitHub themes use them in compound selectors.
const HLJS_AUXILIARY_CLASSES = new Set([
  'class_', 'function_', 'inherited__', 'language_'
]);

/**
 * Configure a markdown-it instance with the project's rendering options.
 * Raw HTML is enabled here; sanitization happens separately via DOMPurify.
 * @param {function} markdownit - the markdown-it factory (window.markdownit)
 * @param {object} [opts]
 * @param {boolean} [opts.html=true] - allow raw HTML tokens
 * @param {object} [opts.emoji] - markdown-it-emoji plugin (optional)
 * @param {object} [opts.purify] - final DOMPurify boundary required for highlighting
 * @param {object} [opts.highlighter] - highlight.js-compatible API (optional)
 * @returns {object} configured markdown-it instance
 */
function configureMarkdownIt(markdownit, opts = {}) {
  const html = opts.html !== undefined ? opts.html : true;
  // A non-empty markdown-it highlight result is trusted HTML even when
  // html:false. Require the purifier that will be used by createRenderMarkdown
  // before enabling that callback through this exported configuration API.
  const highlighter = opts.purify ? opts.highlighter : undefined;

  const md = markdownit({
    html,               // Allow raw HTML; DOMPurify sanitizes the output
    xhtmlOut: false,    // Don't use self-closing tags
    breaks: true,       // Convert \n to <br>
    langPrefix: 'language-',  // CSS class prefix for code blocks
    linkify: true,      // Auto-convert URLs to links
    typographer: true,  // Enable smartquotes and other typographic replacements
    highlight(code, language) {
      return highlightCode(highlighter, code, language);
    }
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
 * Highlight a reasonably sized fenced code block when its explicit language
 * is supported. Returning an empty string tells markdown-it to use its own
 * escaped fallback for unknown, unlabeled, oversized, or failed highlights.
 *
 * @param {object} highlighter - highlight.js-compatible API
 * @param {string} code - raw fenced code
 * @param {string} language - explicit fence language
 * @returns {string} highlighted token markup, or an empty fallback signal
 */
function highlightCode(highlighter, code, language) {
  const requestedLanguage = typeof language === 'string'
    ? language.trim().split(/\s+/)[0]
    : '';

  if (
    !requestedLanguage ||
    typeof code !== 'string' ||
    code.length > MAX_HIGHLIGHT_CODE_LENGTH ||
    !highlighter
  ) {
    return '';
  }

  try {
    // Property access stays inside the guard because a proxy or accessor can
    // throw before either method is called.
    if (
      typeof highlighter.getLanguage !== 'function' ||
      typeof highlighter.highlight !== 'function' ||
      !highlighter.getLanguage(requestedLanguage)
    ) {
      return '';
    }
    const result = highlighter.highlight(code, {
      language: requestedLanguage,
      ignoreIllegals: true
    });
    return typeof result?.value === 'string' &&
      result.value.length <= MAX_HIGHLIGHT_OUTPUT_LENGTH
      ? result.value
      : '';
  } catch (_error) {
    return '';
  }
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
    // Scope `class` to expected markdown output. Code/pre may keep only a
    // punctuation-safe language hint. A token span may keep `hljs-*` and the
    // small set of theme modifiers above, but only when an `hljs-*` scope is
    // present. This retains compound syntax scopes without admitting app or
    // layout classes from repository-controlled raw HTML.
    if (node.hasAttribute('class')) {
      const classes = node.getAttribute('class').split(/\s+/);
      let kept = [];
      if (tag === 'CODE' || tag === 'PRE') {
        kept = classes.filter((c) => /^language-[\w+.#-]+$/.test(c));
      } else if (tag === 'SPAN') {
        const hasHighlightScope = classes.some((c) => HLJS_TOKEN_CLASSES.has(c));
        if (hasHighlightScope) {
          kept = classes.filter((c) =>
            HLJS_TOKEN_CLASSES.has(c) || HLJS_AUXILIARY_CLASSES.has(c)
          );
        }
      }
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
    emoji: win.markdownitEmoji || undefined,
    purify,
    // Highlight.js returns HTML. configureMarkdownIt only enables it when
    // this purifier is present for the final renderMarkdown boundary.
    highlighter: win.hljs || undefined
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
    highlightCode,
    sanitizeHtml,
    createRenderMarkdown,
    initMarkdownGlobals,
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    MAX_HIGHLIGHT_CODE_LENGTH,
    MAX_HIGHLIGHT_OUTPUT_LENGTH
  };
}
