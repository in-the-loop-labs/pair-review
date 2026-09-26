// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Single-source invariant for the loop logo.
 *
 * The loop logo lives in exactly one file, public/logo.svg. Every page header
 * and the chat "loop" spinner draw it with an external
 * `<use href="/logo.svg#logo">`, which keeps `stroke="currentColor"` tied to
 * the page's CSS `color` (an `<img src>` would not), so the icon still follows
 * the theme. These tests read the real files and fail if an inline copy of
 * the path data comes back, or if a reference stops pointing at the file.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '../../public');
const LOGO_FILE = path.join(PUBLIC_DIR, 'logo.svg');
const VENDOR_DIR = path.join(PUBLIC_DIR, 'js', 'vendor');

// Each header page, the anchor that wraps its logo, and the icon's size.
const HEADER_PAGES = [
  { file: 'index.html', anchor: 'a.logo', size: '24' },
  { file: 'pr.html', anchor: 'a.logo', size: '24' },
  { file: 'local.html', anchor: 'a.logo', size: '24' },
  { file: 'setup.html', anchor: 'a.setup-logo', size: '28' },
  { file: 'settings.html', anchor: 'a.nav-logo', size: '24' },
  { file: 'repo-settings.html', anchor: 'a.nav-logo', size: '24' },
];

function loadLogo() {
  const text = fs.readFileSync(LOGO_FILE, 'utf8');
  return new JSDOM(text, { contentType: 'image/svg+xml' }).window.document;
}

function logoHref() {
  return `/logo.svg#${loadLogo().documentElement.getAttribute('id')}`;
}

function parseHtml(file) {
  const text = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  return new JSDOM(text).window.document;
}

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full !== VENDOR_DIR) out.push(...listFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

describe('public/logo.svg', () => {
  it('has id="logo" on its root svg so pages can reference it', () => {
    const root = loadLogo().documentElement;
    expect(root.localName).toBe('svg');
    expect(root.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(root.getAttribute('id')).toBe('logo');
  });

  it('strokes with currentColor so referencing pages control the color', () => {
    const root = loadLogo().documentElement;
    expect(root.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(root.getAttribute('fill')).toBe('none');
    expect(root.getAttribute('stroke')).toBe('currentColor');
    expect(root.querySelector('path')).not.toBeNull();
  });
});

describe('header logo references', () => {
  it.each(HEADER_PAGES)('$file draws its header logo from /logo.svg#logo', ({ file, anchor, size }) => {
    const doc = parseHtml(file);
    const icons = doc.querySelectorAll(`${anchor} svg.logo-icon`);
    expect(icons).toHaveLength(1);
    const icon = icons[0];

    expect(icon.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(icon.getAttribute('width')).toBe(size);
    expect(icon.getAttribute('height')).toBe(size);
    // Decorative: the visible "pairreview" text next to it names the link.
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(doc.querySelector(`${anchor} .logo-text`)).not.toBeNull();

    const uses = icon.querySelectorAll('use');
    expect(uses).toHaveLength(1);
    expect(uses[0].getAttribute('href')).toBe('/logo.svg#logo');
    expect(uses[0].getAttribute('href')).toBe(logoHref());
    expect(icon.querySelector('path')).toBeNull();
  });

  it('every .logo-icon on any public page uses the shared file', () => {
    const htmlFiles = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));
    let seen = 0;
    for (const file of htmlFiles) {
      for (const icon of parseHtml(file).querySelectorAll('.logo-icon')) {
        seen++;
        expect(icon.querySelector('use')?.getAttribute('href'), file).toBe(logoHref());
        expect(icon.querySelector('path'), file).toBeNull();
      }
    }
    expect(seen).toBeGreaterThanOrEqual(HEADER_PAGES.length);
  });
});

describe('single source for the logo path data', () => {
  it('no file under public/ other than logo.svg inlines the path data', () => {
    const pathData = loadLogo().querySelector('path').getAttribute('d');
    expect(pathData.startsWith('M18.178 8c5.096')).toBe(true);

    const files = listFiles(PUBLIC_DIR).filter((f) => f !== LOGO_FILE);
    // Guard against a vacuous scan (wrong root, everything excluded).
    const relative = files.map((f) => path.relative(PUBLIC_DIR, f));
    expect(relative).toEqual(expect.arrayContaining([
      ...HEADER_PAGES.map((p) => p.file),
      path.join('js', 'pr.js'),
      path.join('js', 'components', 'ChatPanel.js'),
    ]));
    expect(relative.some((f) => f.startsWith(path.join('js', 'vendor')))).toBe(false);

    const offenders = files
      .filter((f) => fs.readFileSync(f, 'utf8').includes(pathData))
      .map((f) => path.relative(PUBLIC_DIR, f));
    expect(offenders).toEqual([]);
  });
});

describe('chat "loop" spinner', () => {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  let getChatSpinnerHTML;

  beforeAll(() => {
    // ChatPanel.js assigns window.ChatPanel at load time.
    if (!hadWindow) globalThis.window = {};
    ({ getChatSpinnerHTML } = require('../../public/js/components/ChatPanel.js'));
  });

  afterEach(() => {
    delete globalThis.window.__pairReview;
  });

  afterAll(() => {
    if (!hadWindow) delete globalThis.window;
  });

  it('draws the loop spinner from /logo.svg#logo', () => {
    globalThis.window.__pairReview = { chatSpinner: 'loop' };
    const fragment = JSDOM.fragment(getChatSpinnerHTML());
    const svg = fragment.querySelector('.chat-panel__loop-spinner > svg');
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.querySelector('use').getAttribute('href')).toBe(logoHref());
    expect(svg.querySelector('path')).toBeNull();
  });

  it('keeps the dots spinner when the loop easter egg is off', () => {
    const html = getChatSpinnerHTML();
    expect(html).toContain('chat-panel__typing-indicator');
    expect(html).not.toContain('logo.svg');
  });
});
