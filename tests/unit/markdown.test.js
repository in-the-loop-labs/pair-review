// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll } from 'vitest';

const markdownit = require('markdown-it');
const hljs = require('highlight.js');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

const {
  escapeHtmlAttribute,
  configureMarkdownIt,
  highlightCode,
  createRenderMarkdown,
  sanitizeHtml,
  initMarkdownGlobals,
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  MAX_HIGHLIGHT_CODE_LENGTH,
  MAX_HIGHLIGHT_OUTPUT_LENGTH,
} = require('../../public/js/utils/markdown.js');

/**
 * Build the sanitized renderer the browser uses (html:true + DOMPurify),
 * using the real markdown-it and a DOMPurify instance backed by jsdom —
 * i.e. the actual production code paths, never a duplicate.
 */
function buildRenderer({ highlighter = hljs } = {}) {
  const purify = createDOMPurify(new JSDOM('').window);
  const md = configureMarkdownIt(markdownit, { html: true, highlighter, purify });
  return createRenderMarkdown({ md, purify });
}

/**
 * Build the safe fallback renderer used when DOMPurify is unavailable
 * (html:false, no sanitizer).
 */
function buildFallbackRenderer() {
  const md = configureMarkdownIt(markdownit, { html: false });
  return createRenderMarkdown({ md });
}

describe('renderMarkdown (sanitized, html enabled)', () => {
  let render;
  beforeAll(() => {
    render = buildRenderer();
  });

  describe('HTML comments', () => {
    it('strips block-level HTML comments (e.g. tracking markers)', () => {
      const html = render('Hello\n\n<!-- thread-id:abc123 -->\n\nWorld');
      expect(html).not.toContain('<!--');
      expect(html).not.toContain('thread-id');
      expect(html).toContain('Hello');
      expect(html).toContain('World');
    });

    it('strips inline HTML comments', () => {
      const html = render('Line one <!-- line-ref:35 --> still here');
      expect(html).not.toContain('<!--');
      expect(html).not.toContain('line-ref');
      expect(html).toContain('Line one');
      expect(html).toContain('still here');
    });

    it('strips multiple consecutive comment markers', () => {
      const body =
        'text\n\n<!-- track-thread:x -->\n<!-- track-review-head:y -->\n<!-- track-review-base:z -->';
      const html = render(body);
      expect(html).not.toContain('<!--');
      expect(html).not.toContain('track-');
      expect(html).toContain('text');
    });
  });

  describe('GitHub-style inline HTML', () => {
    it('renders <sub> as a real subscript element', () => {
      expect(render('H<sub>2</sub>O')).toContain('<sub>2</sub>');
    });

    it('renders <sup> as a real superscript element', () => {
      expect(render('x<sup>2</sup>')).toContain('<sup>2</sup>');
    });

    it('renders <kbd>', () => {
      expect(render('Press <kbd>Ctrl</kbd>')).toContain('<kbd>Ctrl</kbd>');
    });

    it('renders <ins>, <del>, <mark>', () => {
      const html = render('<ins>added</ins> <del>removed</del> <mark>note</mark>');
      expect(html).toContain('<ins>added</ins>');
      expect(html).toContain('<del>removed</del>');
      expect(html).toContain('<mark>note</mark>');
    });
  });

  describe('XSS protection', () => {
    it('removes <script> tags', () => {
      const html = render('before <script>alert(1)</script> after');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('alert(1)');
    });

    it('strips event-handler attributes and dangerous tags', () => {
      const html = render('<img src="x" onerror="alert(1)">');
      expect(html).not.toContain('onerror');
      expect(html).not.toContain('alert(1)');
    });

    it('does not emit an anchor for a javascript: markdown link', () => {
      // markdown-it's validateLink refuses dangerous schemes, so no <a> is produced.
      const html = render('[click](javascript:alert(1))');
      expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
      expect(html).not.toContain('<a ');
    });

    it('strips the javascript: scheme from raw HTML anchors', () => {
      // Exercises DOMPurify's scheme filtering on passed-through HTML.
      const html = render('<a href="javascript:alert(1)">x</a>');
      expect(html).not.toContain('javascript:');
    });

    it('does not allow arbitrary tags outside the allowlist', () => {
      const html = render('<iframe src="https://evil.example"></iframe>');
      expect(html).not.toContain('<iframe');
    });
  });

  describe('link safety', () => {
    it('adds target=_blank and rel=noopener noreferrer to links', () => {
      const html = render('[GitHub](https://github.com)');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain('href="https://github.com"');
    });
  });

  describe('standard markdown still works', () => {
    it('renders bold, code, and lists', () => {
      expect(render('**bold**')).toContain('<strong>bold</strong>');
      expect(render('`code`')).toContain('<code>code</code>');
      expect(render('- a\n- b')).toContain('<li>a</li>');
    });

    it('renders tables', () => {
      const html = render('| a | b |\n| - | - |\n| 1 | 2 |');
      expect(html).toContain('<table>');
      expect(html).toContain('<td>1</td>');
    });

    it('renders strikethrough as <s>', () => {
      expect(render('~~gone~~')).toContain('<s>gone</s>');
    });

    it('preserves table column alignment as align attribute (no inline style)', () => {
      const html = render('| a | b |\n| :-: | --: |\n| 1 | 2 |');
      expect(html).toContain('align="center"');
      expect(html).toContain('align="right"');
      expect(html).not.toContain('style=');
      expect(html).not.toContain('text-align');
    });
  });

  describe('layout-injection protection', () => {
    it('strips layout-changing inline styles', () => {
      const html = render(
        '<p style="position:fixed;top:0;z-index:99999;display:none">overlay</p>'
      );
      expect(html).toContain('overlay');
      expect(html).not.toContain('style=');
      expect(html).not.toContain('position');
      expect(html).not.toContain('z-index');
      expect(html).not.toContain('display:none');
    });
  });

  describe('class scoping', () => {
    it('keeps language hints and compound highlight scopes on supported fences', () => {
      const html = render('```c++\nclass Example {};\n```');
      expect(html).toContain('class="language-c++"');
      expect(html).toContain('class="hljs-keyword"');
      expect(html).toContain('class="hljs-title class_"');
    });

    it('falls back to escaped code for an unsupported fenced language', () => {
      const html = render('```not-a-real-language\nconst x = "<tag>";\n```');
      expect(html).toContain('class="language-not-a-real-language"');
      expect(html).toContain('&lt;tag&gt;');
      expect(html).not.toContain('hljs-');
    });

    it('falls back when the highlighter throws or returns malformed output', () => {
      const throwing = { getLanguage: () => true, highlight: () => { throw new Error('failed'); } };
      const malformed = { getLanguage: () => true, highlight: () => ({ value: { unsafe: true } }) };
      for (const highlighter of [throwing, malformed]) {
        const html = buildRenderer({ highlighter })('```js\nconst x = "<tag>";\n```');
        expect(html).toContain('&lt;tag&gt;');
        expect(html).not.toContain('hljs-');
      }
    });

    it('renders safely without a highlighting runtime', () => {
      const html = buildRenderer({ highlighter: null })('```js\nconst x = 1;\n```');
      expect(html).toContain('class="language-js"');
      expect(html).not.toContain('hljs-');
    });

    it('strips class from non-code raw elements', () => {
      const html = render('<span class="app-toolbar danger">hi</span>');
      expect(html).toContain('<span');
      expect(html).toContain('hi');
      expect(html).not.toContain('app-toolbar');
      expect(html).not.toContain('class=');
    });

    it('filters code classes down to punctuation-safe language hints only', () => {
      const html = render('<code class="language-c# hljs sneaky-overlay">x</code>');
      expect(html).toContain('language-c#');
      expect(html).not.toContain('class="hljs"');
      expect(html).not.toContain('sneaky-overlay');
    });

    it('keeps only known token classes and modifiers on highlight spans', () => {
      const html = render(
        '<span class="hljs-title class_ inherited__ app-toolbar">Example</span>' +
        '<span class="hljs-not-a-real-scope language_">fake</span>' +
        '<span class="language_ app-toolbar">unsafe</span>'
      );
      expect(html).toContain('class="hljs-title class_ inherited__"');
      expect(html).not.toContain('app-toolbar');
      expect(html).not.toContain('hljs-not-a-real-scope');
      expect(html).not.toContain('class="language_"');
    });
  });

  describe('edge cases', () => {
    it('returns empty string for empty input', () => {
      expect(render('')).toBe('');
    });

    it('returns empty string for null/undefined', () => {
      expect(render(null)).toBe('');
      expect(render(undefined)).toBe('');
    });
  });
});

describe('renderMarkdown fallback (no DOMPurify, html disabled)', () => {
  let render;
  beforeAll(() => {
    render = buildFallbackRenderer();
  });

  it('escapes raw HTML tags instead of rendering them (safe degraded mode)', () => {
    const html = render('<sub>2</sub>');
    expect(html).not.toContain('<sub>');
    expect(html).toContain('&lt;sub&gt;');
  });

  it('escapes script tags', () => {
    const html = render('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
  });

  it('still renders standard markdown', () => {
    expect(render('**bold**')).toContain('<strong>bold</strong>');
  });

  it('returns empty string for empty input', () => {
    expect(render('')).toBe('');
  });
});

describe('highlightCode', () => {
  it('does not auto-detect unlabeled code', () => {
    expect(highlightCode(hljs, 'const x = 1;', '')).toBe('');
  });

  it('uses the explicit language before any fence metadata', () => {
    expect(highlightCode(hljs, 'const x = 1;', 'js extra')).toContain('hljs-keyword');
  });

  it('highlights at the input limit but skips oversized fences', () => {
    let calls = 0;
    const spy = {
      getLanguage: () => true,
      highlight: () => {
        calls += 1;
        return { value: 'highlighted' };
      }
    };
    expect(highlightCode(spy, 'x'.repeat(MAX_HIGHLIGHT_CODE_LENGTH), 'js')).toBe('highlighted');
    expect(highlightCode(spy, 'x'.repeat(MAX_HIGHLIGHT_CODE_LENGTH + 1), 'js')).toBe('');
    expect(calls).toBe(1);
  });

  it('falls back when method access throws or highlighted output is amplified', () => {
    const throwingAccessor = Object.defineProperty({}, 'getLanguage', {
      get() { throw new Error('revoked'); }
    });
    const amplified = {
      getLanguage: () => true,
      highlight: () => ({ value: 'x'.repeat(MAX_HIGHLIGHT_OUTPUT_LENGTH + 1) })
    };
    expect(highlightCode(throwingAccessor, 'const x = 1;', 'js')).toBe('');
    expect(highlightCode(amplified, 'const x = 1;', 'js')).toBe('');
  });

  it('requires a purifier before configureMarkdownIt enables highlighter HTML', () => {
    let called = false;
    const hostile = {
      getLanguage: () => true,
      highlight: () => {
        called = true;
        return { value: '<img src=x onerror="alert(1)">' };
      }
    };
    const md = configureMarkdownIt(markdownit, { html: false, highlighter: hostile });
    const html = md.render('```js\n<img src=x onerror="alert(1)">\n```');
    expect(called).toBe(false);
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });
});

describe('sanitizeHtml', () => {
  it('applies the allowlist and removes comments', () => {
    const purify = createDOMPurify(new JSDOM('').window);
    const out = sanitizeHtml(
      purify,
      '<sub>x</sub><script>alert(1)</script><!-- marker -->'
    );
    expect(out).toContain('<sub>x</sub>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<!--');
  });
});

describe('exported allowlists', () => {
  it('includes the GitHub inline HTML subset', () => {
    for (const tag of ['sub', 'sup', 'kbd', 'ins', 'del', 'mark', 'details', 'summary']) {
      expect(ALLOWED_TAGS).toContain(tag);
    }
  });

  it('permits link attributes', () => {
    expect(ALLOWED_ATTR).toContain('href');
    expect(ALLOWED_ATTR).toContain('target');
    expect(ALLOWED_ATTR).toContain('rel');
  });
});

describe('initMarkdownGlobals (browser wiring)', () => {
  /**
   * Build a window-like object mirroring what the browser exposes when
   * markdown.js runs, optionally including DOMPurify.
   */
  function makeWindow({ withPurify, highlighter = hljs }) {
    const dom = new JSDOM('');
    const win = dom.window;
    win.markdownit = markdownit;
    if (withPurify) {
      win.DOMPurify = createDOMPurify(win);
    }
    if (highlighter) {
      win.hljs = highlighter;
    }
    return win;
  }

  it('defines a sanitizing renderer when DOMPurify is present', () => {
    const win = makeWindow({ withPurify: true });
    initMarkdownGlobals(win);
    expect(typeof win.renderMarkdown).toBe('function');
    expect(win.renderMarkdown('H<sub>2</sub>O')).toContain('<sub>2</sub>');
    expect(win.renderMarkdown('x <!-- thread-id:z -->')).not.toContain('<!--');
    expect(win.renderMarkdown('```js\nconst x = 1;\n```')).toContain('hljs-keyword');
  });

  it('does not invoke or trust a highlighter when DOMPurify is unavailable', () => {
    let called = false;
    const hostileHighlighter = {
      getLanguage: () => true,
      highlight: () => {
        called = true;
        return { value: '<img src=x onerror="alert(1)">' };
      }
    };
    const win = makeWindow({ withPurify: false, highlighter: hostileHighlighter });
    initMarkdownGlobals(win);
    const html = win.renderMarkdown('```js\n<img src=x onerror="alert(1)">\n```');
    expect(called).toBe(false);
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });

  it('falls back to escaping raw HTML when DOMPurify is absent (safe degraded mode)', () => {
    const win = makeWindow({ withPurify: false });
    initMarkdownGlobals(win);
    expect(typeof win.renderMarkdown).toBe('function');
    const html = win.renderMarkdown('<sub>2</sub>');
    expect(html).not.toContain('<sub>');
    expect(html).toContain('&lt;sub&gt;');
  });

  it('is a no-op when markdownit is unavailable', () => {
    const dom = new JSDOM('');
    initMarkdownGlobals(dom.window);
    expect(dom.window.renderMarkdown).toBeUndefined();
  });
});

describe('escapeHtmlAttribute', () => {
  it('escapes all attribute-special characters', () => {
    expect(escapeHtmlAttribute(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('returns empty string for falsy input', () => {
    expect(escapeHtmlAttribute('')).toBe('');
    expect(escapeHtmlAttribute(null)).toBe('');
    expect(escapeHtmlAttribute(undefined)).toBe('');
  });
});
