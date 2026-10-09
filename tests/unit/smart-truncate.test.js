// @vitest-environment jsdom
// jsdom has no layout, so widths/rects are stubbed. Real CSS is covered in e2e.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const { SmartTruncate } = require('../../public/js/components/SmartTruncate.js');

let controller;

function stubWidths(el, { scrollWidth, clientWidth }) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
}

function stubRect(el, rect) {
  const full = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, ...rect };
  el.getBoundingClientRect = () => full;
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

function unhover(el, relatedTarget = null) {
  el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget }));
}

function tooltip() {
  return document.querySelector(`.${SmartTruncate.TOOLTIP_CLASS}`);
}

function isTooltipVisible() {
  const tip = tooltip();
  return !!tip && !tip.hidden;
}

describe('SmartTruncate', () => {
  beforeAll(() => {
    // Tests use their own controller instead of the global one
    window.smartTruncate.destroy();
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    controller = new SmartTruncate(document);
  });

  afterEach(() => {
    vi.useRealTimers();
    controller.destroy();
  });

  it('exposes the class and a global instance on window', () => {
    expect(window.SmartTruncate).toBe(SmartTruncate);
    expect(window.smartTruncate).toBeInstanceOf(SmartTruncate);
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

  describe('hover tooltip', () => {
    it('shows the full text after the hover delay when truncated', () => {
      vi.useFakeTimers();
      const el = SmartTruncate.apply(makeEl('src/a/very/deep/path/file.js'), { mode: 'start' });
      hover(el.querySelector('.smart-truncate__text'));
      expect(isTooltipVisible()).toBe(false);
      vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      expect(isTooltipVisible()).toBe(true);
      expect(tooltip().textContent).toBe('src/a/very/deep/path/file.js');
      // Visual only; the full text is already in the DOM
      expect(tooltip().getAttribute('aria-hidden')).toBe('true');
    });

    it('does not show a tooltip when the text fits', () => {
      vi.useFakeTimers();
      const el = SmartTruncate.apply(makeEl('short.js', { truncated: false }), { mode: 'start' });
      hover(el);
      vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      expect(isTooltipVisible()).toBe(false);
    });

    it('re-checks truncation at show time (e.g. after a resize)', () => {
      vi.useFakeTimers();
      const el = SmartTruncate.apply(makeEl('title', { truncated: true }));
      hover(el);
      stubWidths(el, { scrollWidth: 200, clientWidth: 200 });
      vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      expect(isTooltipVisible()).toBe(false);
    });

    it('uses data-full-text for the tooltip when provided', () => {
      vi.useFakeTimers();
      const el = SmartTruncate.apply(makeEl('old.jsnew.js'), { mode: 'start', fullText: 'old.js → new.js' });
      hover(el);
      vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      expect(tooltip().textContent).toBe('old.js → new.js');
    });

    it('works for elements that only carry the class (innerHTML templates)', () => {
      vi.useFakeTimers();
      document.body.innerHTML = '<div><span class="ai-title smart-truncate">A very long suggestion title</span></div>';
      const el = document.querySelector('.ai-title');
      stubWidths(el, { scrollWidth: 500, clientWidth: 100 });
      hover(el);
      vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      expect(tooltip().textContent).toBe('A very long suggestion title');
    });

    it('cancels a pending tooltip when the pointer leaves before the delay', () => {
      vi.useFakeTimers();
      const el = SmartTruncate.apply(makeEl('long text'));
      hover(el);
      unhover(el, document.body);
      vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      expect(isTooltipVisible()).toBe(false);
    });

    it('stays open when moving between children of the same element', () => {
      vi.useFakeTimers();
      const el = SmartTruncate.apply(makeEl('a/b/c.js'), { mode: 'start' });
      const inner = el.querySelector('.smart-truncate__text');
      hover(el);
      vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      unhover(el, inner);
      hover(inner);
      expect(isTooltipVisible()).toBe(true);
    });

    it('hides on mouseout, Escape, scroll, and mousedown', () => {
      vi.useFakeTimers();
      const el = SmartTruncate.apply(makeEl('long text'));
      const showIt = () => {
        hover(document.body);
        hover(el);
        vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
        expect(isTooltipVisible()).toBe(true);
      };

      showIt();
      unhover(el, document.body);
      expect(isTooltipVisible()).toBe(false);

      showIt();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(isTooltipVisible()).toBe(false);

      showIt();
      el.dispatchEvent(new Event('scroll'));
      expect(isTooltipVisible()).toBe(false);

      showIt();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(isTooltipVisible()).toBe(false);
    });

    it('a scroll during the hover delay does not cancel the pending tooltip', () => {
      vi.useFakeTimers();
      const el = SmartTruncate.apply(makeEl('long text'));
      hover(el);
      document.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      expect(isTooltipVisible()).toBe(true);
    });

    it('can re-show on the same element after a scroll dismissed it', () => {
      vi.useFakeTimers();
      const el = SmartTruncate.apply(makeEl('long text'));
      hover(el);
      vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      document.dispatchEvent(new Event('scroll'));
      expect(isTooltipVisible()).toBe(false);
      hover(el);
      vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      expect(isTooltipVisible()).toBe(true);
    });

    it('switches directly to another truncated element', () => {
      vi.useFakeTimers();
      const a = SmartTruncate.apply(makeEl('first long text'));
      const b = SmartTruncate.apply(makeEl('second long text'));
      hover(a);
      vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      expect(tooltip().textContent).toBe('first long text');
      hover(b);
      expect(isTooltipVisible()).toBe(false);
      vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      expect(tooltip().textContent).toBe('second long text');
    });

    it('reuses a single tooltip element', () => {
      vi.useFakeTimers();
      const a = SmartTruncate.apply(makeEl('first long text'));
      const b = SmartTruncate.apply(makeEl('second long text'));
      for (const el of [a, b, a]) {
        hover(el);
        vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      }
      expect(document.querySelectorAll(`.${SmartTruncate.TOOLTIP_CLASS}`)).toHaveLength(1);
    });
  });

  describe('tooltip positioning', () => {
    function showFor(el) {
      controller.show(el);
      return tooltip();
    }

    function stubTooltipSize(width, height) {
      const probe = SmartTruncate.apply(makeEl('probe'));
      controller.show(probe);
      const tip = tooltip();
      Object.defineProperty(tip, 'offsetWidth', { configurable: true, value: width });
      Object.defineProperty(tip, 'offsetHeight', { configurable: true, value: height });
      controller.hide();
      probe.remove();
    }

    beforeEach(() => {
      Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1000 });
      Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
    });

    afterEach(() => {
      delete document.documentElement.clientWidth;
      delete document.documentElement.clientHeight;
    });

    it('places the tooltip below and left-aligned for end truncation', () => {
      stubTooltipSize(300, 30);
      const el = SmartTruncate.apply(makeEl('long title'));
      stubRect(el, { left: 100, right: 400, top: 100, bottom: 120 });
      const tip = showFor(el);
      expect(tip.dataset.placement).toBe('bottom');
      expect(tip.style.left).toBe('100px');
      expect(tip.style.top).toBe('126px');
    });

    it('right-aligns the tooltip for start (path) truncation', () => {
      stubTooltipSize(300, 30);
      const el = SmartTruncate.apply(makeEl('a/b/c.js'), { mode: 'start' });
      stubRect(el, { left: 100, right: 600, top: 100, bottom: 120 });
      expect(showFor(el).style.left).toBe('300px');
    });

    it('flips above when there is no room below', () => {
      stubTooltipSize(300, 30);
      const el = SmartTruncate.apply(makeEl('long title'));
      stubRect(el, { left: 100, right: 400, top: 770, bottom: 790 });
      const tip = showFor(el);
      expect(tip.dataset.placement).toBe('top');
      expect(tip.style.top).toBe('734px');
    });

    it('clamps to the viewport horizontally', () => {
      stubTooltipSize(300, 30);
      const right = SmartTruncate.apply(makeEl('long title'));
      stubRect(right, { left: 900, right: 990, top: 100, bottom: 120 });
      expect(showFor(right).style.left).toBe('692px');

      const left = SmartTruncate.apply(makeEl('a/b/c.js'), { mode: 'start' });
      stubRect(left, { left: 0, right: 50, top: 100, bottom: 120 });
      expect(showFor(left).style.left).toBe('8px');
    });
  });

  describe('destroy', () => {
    it('removes the tooltip and stops responding to hover', () => {
      vi.useFakeTimers();
      const el = SmartTruncate.apply(makeEl('long text'));
      hover(el);
      vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      controller.destroy();
      expect(tooltip()).toBeNull();
      hover(document.body);
      hover(el);
      vi.advanceTimersByTime(SmartTruncate.SHOW_DELAY_MS);
      expect(tooltip()).toBeNull();
    });

    it('makes show() a no-op and is safe to call twice', () => {
      controller.destroy();
      expect(controller.show(makeEl('long text'))).toBe(false);
      expect(tooltip()).toBeNull();
      expect(() => controller.destroy()).not.toThrow();
    });
  });
});
