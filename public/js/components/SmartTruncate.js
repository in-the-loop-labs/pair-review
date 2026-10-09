/**
 * SmartTruncate - single-line truncation with a full-text tooltip shown only
 * when clipped. Modes: 'end' (titles) and 'start' (paths, keeps the file name).
 * Use SmartTruncate.apply(el, opts), or just the `smart-truncate` class for 'end'.
 * One global instance (window.smartTruncate) owns the tooltip via delegation.
 */
class SmartTruncate {
  static ROOT_CLASS = 'smart-truncate';
  static START_CLASS = 'smart-truncate--start';
  static TEXT_CLASS = 'smart-truncate__text';
  static TOOLTIP_CLASS = 'smart-truncate-tooltip';
  static SHOW_DELAY_MS = 300;
  static TOOLTIP_OFFSET_PX = 6;
  static VIEWPORT_MARGIN_PX = 8;

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
    if (mode === 'start') {
      el.classList.add(SmartTruncate.START_CLASS);
      const first = el.firstElementChild;
      const wrapped = el.childNodes.length === 1 && first?.classList.contains(SmartTruncate.TEXT_CLASS);
      if (!wrapped) {
        const inner = el.ownerDocument.createElement('span');
        inner.className = SmartTruncate.TEXT_CLASS;
        inner.append(...el.childNodes);
        el.appendChild(inner);
      }
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

  constructor(doc = document) {
    this.doc = doc;
    this.tooltip = null;
    this.activeTarget = null;
    this.showTimer = null;

    this.hide = this.hide.bind(this);
    this.onMouseOver = this.onMouseOver.bind(this);
    this.onMouseOut = this.onMouseOut.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onScroll = this.onScroll.bind(this);

    const view = doc.defaultView;
    this.listeners = [
      [doc, 'mouseover', this.onMouseOver, false],
      [doc, 'mouseout', this.onMouseOut, false],
      [doc, 'keydown', this.onKeyDown, false],
      [doc, 'scroll', this.onScroll, true], // capture: container scrolls don't bubble
      [doc, 'mousedown', this.hide, true],
      ...(view ? [[view, 'resize', this.hide, false], [view, 'blur', this.hide, false]] : [])
    ];
    for (const [node, type, fn, capture] of this.listeners) {
      node.addEventListener(type, fn, capture);
    }
  }

  /** @returns {boolean} Whether the tooltip was shown */
  show(target) {
    if (!this.listeners || !SmartTruncate.isTruncated(target)) return false;
    const text = SmartTruncate.getFullText(target);
    if (!text) return false;

    const tip = this.ensureTooltip();
    tip.textContent = text;
    tip.hidden = false;
    this.positionTooltip(tip, target);
    return true;
  }

  hide() {
    clearTimeout(this.showTimer);
    this.showTimer = null;
    this.activeTarget = null;
    if (this.tooltip) this.tooltip.hidden = true;
  }

  destroy() {
    this.hide();
    for (const [node, type, fn, capture] of this.listeners || []) {
      node.removeEventListener(type, fn, capture);
    }
    this.listeners = null;
    this.tooltip?.remove();
    this.tooltip = null;
  }

  ensureTooltip() {
    if (this.tooltip?.isConnected) return this.tooltip;
    this.tooltip = this.doc.createElement('div');
    this.tooltip.className = SmartTruncate.TOOLTIP_CLASS;
    // Visual only: the full text is already in the DOM for assistive tech
    this.tooltip.setAttribute('aria-hidden', 'true');
    this.tooltip.hidden = true;
    this.doc.body.appendChild(this.tooltip);
    return this.tooltip;
  }

  // Below the target (above if no room), clamped to the viewport.
  // Paths right-align so the file name lines up with the visible tail.
  positionTooltip(tip, target) {
    const OFFSET = SmartTruncate.TOOLTIP_OFFSET_PX;
    const MARGIN = SmartTruncate.VIEWPORT_MARGIN_PX;
    const rect = target.getBoundingClientRect();
    const viewportWidth = this.doc.documentElement.clientWidth || this.doc.defaultView.innerWidth;
    const viewportHeight = this.doc.documentElement.clientHeight || this.doc.defaultView.innerHeight;

    tip.style.left = '0px';
    tip.style.top = '0px';
    const tipWidth = tip.offsetWidth;
    const tipHeight = tip.offsetHeight;

    let placement = 'bottom';
    let top = rect.bottom + OFFSET;
    const aboveTop = rect.top - OFFSET - tipHeight;
    if (top + tipHeight > viewportHeight - MARGIN && aboveTop >= MARGIN) {
      placement = 'top';
      top = aboveTop;
    }

    let left = target.classList.contains(SmartTruncate.START_CLASS) ? rect.right - tipWidth : rect.left;
    left = Math.max(MARGIN, Math.min(left, viewportWidth - MARGIN - tipWidth));

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.dataset.placement = placement;
  }

  findTarget(event) {
    const origin = event.composedPath?.()[0] || event.target;
    return origin?.closest?.(`.${SmartTruncate.ROOT_CLASS}`) || null;
  }

  onMouseOver(event) {
    const target = this.findTarget(event);
    if (target === this.activeTarget) return;
    this.hide();
    if (!target) return;
    this.activeTarget = target;
    this.showTimer = setTimeout(() => {
      this.showTimer = null;
      if (this.activeTarget === target) this.show(target);
    }, SmartTruncate.SHOW_DELAY_MS);
  }

  onMouseOut(event) {
    if (!this.activeTarget) return;
    if (event.relatedTarget && this.activeTarget.contains(event.relatedTarget)) return;
    this.hide();
  }

  onKeyDown(event) {
    if (event.key === 'Escape') this.hide();
  }

  // Only dismiss a visible tooltip: cancelling a pending one would drop it
  // when an element scrolls in under the pointer (no new mouseover follows).
  onScroll() {
    if (this.tooltip && !this.tooltip.hidden) this.hide();
  }
}

if (typeof window !== 'undefined') {
  window.SmartTruncate = SmartTruncate;
  if (!window.smartTruncate) window.smartTruncate = new SmartTruncate(document);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SmartTruncate };
}
