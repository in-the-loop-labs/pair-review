// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Keeps DiffRenderer.LANGUAGE_MAP honest: every language it maps to must be
 * registered by the Highlight.js bundles that pr.html and local.html load.
 *
 * The pages load the cdnjs `highlight.min.js` (Highlight.js's "common" language
 * set) plus one `languages/<name>.min.js` tag per extra grammar. Tests run
 * offline, so they rebuild that registry from the `highlight.js` dev
 * dependency: `lib/common` mirrors the cdnjs common bundle, and each extra
 * script tag maps to `lib/languages/<name>`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');

const PUBLIC_DIR = path.join(__dirname, '../../public');
const PAGES = ['pr.html', 'local.html'];
const HLJS_SCRIPT_RE = /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/highlight\.js\/([\d.]+)\/(highlight\.min\.js|languages\/([\w-]+)\.min\.js)"><\/script>/g;

function hljsScripts(page) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
  const versions = new Set();
  const extras = [];
  let hasCore = false;
  for (const match of html.matchAll(HLJS_SCRIPT_RE)) {
    versions.add(match[1]);
    if (match[3]) {
      extras.push(match[3]);
    } else {
      hasCore = true;
    }
  }
  return { versions: [...versions], extras, hasCore };
}

function buildPageHljs(extras) {
  // A fresh instance per call so registrations don't leak between tests.
  const hljs = require('highlight.js/lib/core').newInstance();
  const common = require('highlight.js/lib/common').listLanguages();
  for (const name of [...common, ...extras]) {
    hljs.registerLanguage(name, require(`highlight.js/lib/languages/${name}`));
  }
  return hljs;
}

describe('Highlight.js bundles loaded by the pages', () => {
  it.each(PAGES)('%s loads one Highlight.js version with the core bundle', (page) => {
    const { versions, hasCore } = hljsScripts(page);
    expect(hasCore).toBe(true);
    expect(versions).toHaveLength(1);
  });

  it('pr.html and local.html load the same Highlight.js scripts', () => {
    const [pr, local] = PAGES.map(hljsScripts);
    expect(local.versions).toEqual(pr.versions);
    expect([...local.extras].sort()).toEqual([...pr.extras].sort());
  });
});

describe('DiffRenderer.LANGUAGE_MAP', () => {
  it.each(PAGES)('every mapped language is registered by %s', (page) => {
    const hljs = buildPageHljs(hljsScripts(page).extras);
    const unregistered = Object.entries(DiffRenderer.LANGUAGE_MAP)
      .filter(([, language]) => !hljs.getLanguage(language))
      .map(([ext, language]) => `${ext} -> ${language}`);
    expect(unregistered).toEqual([]);
  });

  it('detects Dockerfile, ERB and Scala files', () => {
    expect(DiffRenderer.detectLanguage('Dockerfile')).toBe('dockerfile');
    expect(DiffRenderer.detectLanguage('app/views/show.html.erb')).toBe('erb');
    expect(DiffRenderer.detectLanguage('src/Main.scala')).toBe('scala');
  });
});

describe('renderDiffLine syntax highlighting', () => {
  const line = { type: 'insert', newNumber: 1, content: '+<%= @user_name %>' };
  let origHljs;
  let warn;

  beforeEach(() => {
    origHljs = window.hljs;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    window.hljs = origHljs;
    warn.mockRestore();
  });

  const contentOf = (row) => row.querySelector('.d2h-code-line-ctn');

  it('highlights ERB with the grammars the pages load', () => {
    window.hljs = buildPageHljs(hljsScripts('pr.html').extras);
    const row = DiffRenderer.renderDiffLine(null, line, 'app/views/show.html.erb', 1);
    expect(contentOf(row).innerHTML).toContain('hljs-');
    // fixRubyHighlighting still runs for ERB: the variable isn't split at "_name"
    expect(contentOf(row).textContent).toBe('<%= @user_name %>');
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to plain text without warning when a grammar is not registered', () => {
    // Core alone registers no languages, standing in for a missing script tag.
    window.hljs = require('highlight.js/lib/core').newInstance();
    const highlight = vi.spyOn(window.hljs, 'highlight');
    const row = DiffRenderer.renderDiffLine(null, line, 'app/views/show.html.erb', 1);
    expect(contentOf(row).innerHTML).not.toContain('hljs-');
    expect(contentOf(row).textContent).toBe('<%= @user_name %>');
    expect(highlight).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
