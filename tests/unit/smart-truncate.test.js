// Copyright 2026 The pair-review Authors | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
// jsdom has no layout, so widths are stubbed. Real CSS is covered in e2e.

import { describe, it, expect, beforeEach } from 'vitest';

const { SmartTruncate } = require('../../public/js/utils/smart-truncate.js');

function stubWidths(el, { scrollWidth, clientWidth }) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
}

function makeEl(text, { truncated = true } = {}) {
  const el = document.createElement('span');
  el.textContent = text;
  document.body.appendChild(el);
  stubWidths(el, truncated ? { scrollWidth: 400, clientWidth: 200 } : { scrollWidth: 200, clientWidth: 200 });
  return el;
}

function hover(el) {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
}

describe('SmartTruncate', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('exposes the class on window', () => {
    expect(window.SmartTruncate).toBe(SmartTruncate);
  });

  describe('apply', () => {
    it('defaults to end truncation with no inner wrapper', () => {
      const el = makeEl('A long title');
      SmartTruncate.apply(el);
      expect(el.classList.contains('smart-truncate')).toBe(true);
      expect(el.classList.contains('smart-truncate--start')).toBe(false);
      expect(el.querySelector('.smart-truncate__text')).toBeNull();
      expect(el.textContent).toBe('A long title');
    });

    it('wraps content in an isolated text span for start (path) truncation', () => {
      const el = makeEl('src/deep/dir/file.js');
      SmartTruncate.apply(el, { mode: 'start' });
      expect(el.classList.contains('smart-truncate--start')).toBe(true);
      const inner = el.querySelector(':scope > .smart-truncate__text');
      expect(inner).not.toBeNull();
      expect(inner.textContent).toBe('src/deep/dir/file.js');
      expect(el.textContent).toBe('src/deep/dir/file.js');
    });

    it('preserves existing child elements when wrapping', () => {
      const el = document.createElement('span');
      el.innerHTML = '<span class="file-rename-old-path">old.js</span><span class="file-rename-arrow">→</span>new.js';
      document.body.appendChild(el);
      SmartTruncate.apply(el, { mode: 'start' });
      const inner = el.querySelector('.smart-truncate__text');
      expect(inner.querySelector('.file-rename-old-path').textContent).toBe('old.js');
      expect(inner.querySelector('.file-rename-arrow')).not.toBeNull();
      expect(inner.lastChild.nodeType).toBe(Node.TEXT_NODE);
    });

    it('is idempotent in start mode', () => {
      const el = makeEl('a/b/c.js');
      SmartTruncate.apply(el, { mode: 'start' });
      SmartTruncate.apply(el, { mode: 'start' });
      expect(el.querySelectorAll('.smart-truncate__text')).toHaveLength(1);
      expect(el.textContent).toBe('a/b/c.js');
    });

    it('unwraps and drops the start class when re-applied in end mode', () => {
      const el = makeEl('a/b/c.js');
      SmartTruncate.apply(el, { mode: 'start' });
      SmartTruncate.apply(el, { mode: 'end' });
      expect(el.classList.contains('smart-truncate--start')).toBe(false);
      expect(el.querySelector('.smart-truncate__text')).toBeNull();
      expect(el.textContent).toBe('a/b/c.js');
    });

    it('stores explicit fullText and clears it when omitted', () => {
      const el = makeEl('oldnew');
      SmartTruncate.apply(el, { fullText: 'old → new' });
      expect(el.dataset.fullText).toBe('old → new');
      SmartTruncate.apply(el);
      expect(el.dataset.fullText).toBeUndefined();
    });

    it('returns the element and tolerates null', () => {
      const el = makeEl('x');
      expect(SmartTruncate.apply(el)).toBe(el);
      expect(SmartTruncate.apply(null)).toBeNull();
    });
  });

  describe('isTruncated', () => {
    it('is true when content is wider than the box', () => {
      expect(SmartTruncate.isTruncated(makeEl('long', { truncated: true }))).toBe(true);
    });

    it('is false when content fits', () => {
      expect(SmartTruncate.isTruncated(makeEl('short', { truncated: false }))).toBe(false);
    });

    it('is false for detached or missing elements', () => {
      const el = document.createElement('span');
      stubWidths(el, { scrollWidth: 400, clientWidth: 200 });
      expect(SmartTruncate.isTruncated(el)).toBe(false);
      expect(SmartTruncate.isTruncated(null)).toBe(false);
    });
  });

  describe('getFullText', () => {
    it('prefers data-full-text, including an explicit empty string', () => {
      const el = makeEl('visible');
      el.dataset.fullText = 'tooltip text';
      expect(SmartTruncate.getFullText(el)).toBe('tooltip text');
      el.dataset.fullText = '';
      expect(SmartTruncate.getFullText(el)).toBe('');
    });

    it('falls back to trimmed textContent', () => {
      expect(SmartTruncate.getFullText(makeEl('  padded  '))).toBe('padded');
      expect(SmartTruncate.getFullText(null)).toBe('');
    });
  });

  describe('title on hover', () => {
    it('sets title to the full text when truncated', () => {
      const el = SmartTruncate.apply(makeEl('src/a/very/deep/path/file.js'), { mode: 'start' });
      hover(el.querySelector('.smart-truncate__text'));
      expect(el.title).toBe('src/a/very/deep/path/file.js');
    });

    it('does not set title when the text fits', () => {
      const el = SmartTruncate.apply(makeEl('short.js', { truncated: false }), { mode: 'start' });
      hover(el);
      expect(el.hasAttribute('title')).toBe(false);
    });

    it('removes a stale title once the text fits again', () => {
      const el = SmartTruncate.apply(makeEl('title'));
      hover(el);
      expect(el.title).toBe('title');
      stubWidths(el, { scrollWidth: 200, clientWidth: 200 });
      hover(el);
      expect(el.hasAttribute('title')).toBe(false);
    });

    it('uses data-full-text when provided', () => {
      const el = SmartTruncate.apply(makeEl('old.jsnew.js'), { mode: 'start', fullText: 'old.js → new.js' });
      hover(el);
      expect(el.title).toBe('old.js → new.js');
    });

    it('works for elements that only carry the class (innerHTML templates)', () => {
      document.body.innerHTML = '<div><span class="ai-title smart-truncate">A very long suggestion title</span></div>';
      const el = document.querySelector('.ai-title');
      stubWidths(el, { scrollWidth: 500, clientWidth: 100 });
      hover(el);
      expect(el.title).toBe('A very long suggestion title');
    });

    it("leaves an ancestor's title in effect when the text fits", () => {
      document.body.innerHTML = '<div class="ai-suggestion-collapsed-content" title="Dismissed"><span class="collapsed-title smart-truncate">Short</span></div>';
      const el = document.querySelector('.collapsed-title');
      stubWidths(el, { scrollWidth: 100, clientWidth: 100 });
      hover(el);
      expect(el.hasAttribute('title')).toBe(false);
      expect(el.parentElement.title).toBe('Dismissed');
    });

    it('never sets an empty title (it would hide an ancestor title)', () => {
      document.body.innerHTML = '<div title="Dismissed"><span class="smart-truncate" data-full-text="">x</span></div>';
      const el = document.querySelector('.smart-truncate');
      stubWidths(el, { scrollWidth: 400, clientWidth: 200 });
      hover(el);
      expect(el.hasAttribute('title')).toBe(false);
    });

    it('ignores hovers outside smart-truncate elements', () => {
      const other = makeEl('plain');
      hover(other);
      expect(other.hasAttribute('title')).toBe(false);
    });
  });
});
