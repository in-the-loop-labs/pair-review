// Copyright 2026 The pair-review Authors | SPDX-License-Identifier: Apache-2.0
/**
 * SmartTruncate - single-line truncation; the full text shows as a native
 * `title` only when clipped. Modes: 'end' (titles) and 'start' (paths, keeps
 * the file name). Use SmartTruncate.apply(el, opts), or just the
 * `smart-truncate` class for 'end'.
 */
class SmartTruncate {
  static ROOT_CLASS = 'smart-truncate';
  static START_CLASS = 'smart-truncate--start';
  static TEXT_CLASS = 'smart-truncate__text';

  /**
   * @param {HTMLElement} el
   * @param {Object} [options]
   * @param {'start'|'end'} [options.mode='end']
   * @param {string} [options.fullText] - Tooltip text; defaults to textContent
   * @returns {HTMLElement} el
   */
  static apply(el, options = {}) {
    if (!el) return el;
    const { mode = 'end', fullText } = options;

    el.classList.add(SmartTruncate.ROOT_CLASS);

    // 'start' needs an isolated LTR wrapper inside the RTL box (see pr.css)
    const first = el.firstElementChild;
    const wrapper = el.childNodes.length === 1 && first?.classList.contains(SmartTruncate.TEXT_CLASS)
      ? first
      : null;
    if (mode === 'start') {
      el.classList.add(SmartTruncate.START_CLASS);
      if (!wrapper) {
        const inner = el.ownerDocument.createElement('span');
        inner.className = SmartTruncate.TEXT_CLASS;
        inner.append(...el.childNodes);
        el.appendChild(inner);
      }
    } else {
      el.classList.remove(SmartTruncate.START_CLASS);
      wrapper?.replaceWith(...wrapper.childNodes);
    }

    if (typeof fullText === 'string') {
      el.dataset.fullText = fullText;
    } else {
      delete el.dataset.fullText;
    }
    return el;
  }

  static isTruncated(el) {
    return !!el?.isConnected && el.scrollWidth > el.clientWidth;
  }

  static getFullText(el) {
    if (!el) return '';
    if (typeof el.dataset?.fullText === 'string') return el.dataset.fullText;
    return (el.textContent || '').trim();
  }

  // Runs on every hover, before the browser reads `title` for its tooltip,
  // so it stays correct after resizes. With no `title`, an ancestor's title
  // (e.g. a collapsed card's "Dismissed") shows as before.
  static onMouseOver(event) {
    const el = event.target.closest?.(`.${SmartTruncate.ROOT_CLASS}`);
    if (!el) return;
    const text = SmartTruncate.isTruncated(el) ? SmartTruncate.getFullText(el) : '';
    // An empty `title` would also hide an ancestor's tooltip, so remove it
    if (text) {
      el.title = text;
    } else {
      el.removeAttribute('title');
    }
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('mouseover', SmartTruncate.onMouseOver);
}

if (typeof window !== 'undefined') {
  window.SmartTruncate = SmartTruncate;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SmartTruncate };
}
