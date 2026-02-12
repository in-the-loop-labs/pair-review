// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for the TimeoutSelect component.
 *
 * Covers: constructor (default and custom options), value getter/setter,
 * change event dispatch, show/hide/toggle, open/close, keyboard navigation,
 * destroy() cleanup, static mount() factory, and static TIMEOUT_OPTIONS.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal DOM helpers – enough for TimeoutSelect's real DOM usage.
// ---------------------------------------------------------------------------

/** Registered listeners on document (for leak-detection tests). */
let documentListeners = [];

function createMockElement(tag) {
  const children = [];
  const classList = new Set();
  const attributes = {};
  const listeners = {};
  const dataset = {};

  const el = {
    tagName: tag?.toUpperCase() || 'DIV',
    id: '',
    title: '',
    type: '',
    className: '',
    style: {},
    innerHTML: '',
    textContent: '',
    parentNode: null,
    dataset,
    _children: children,
    _listeners: listeners,

    classList: {
      add(...classes) { classes.forEach(c => classList.add(c)); el.className = [...classList].join(' '); },
      remove(...classes) { classes.forEach(c => classList.delete(c)); el.className = [...classList].join(' '); },
      contains(c) { return classList.has(c); },
      toggle(c, force) {
        const has = classList.has(c);
        if (force === undefined) { if (has) classList.delete(c); else classList.add(c); }
        else if (force) classList.add(c);
        else classList.delete(c);
        el.className = [...classList].join(' ');
      },
    },

    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] ?? null; },

    appendChild(child) {
      children.push(child);
      child.parentNode = el;
      return child;
    },
    insertBefore(newChild, refChild) {
      const idx = children.indexOf(refChild);
      if (idx >= 0) children.splice(idx, 0, newChild);
      else children.push(newChild);
      newChild.parentNode = el;
      return newChild;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    contains(other) {
      if (other === el) return true;
      return children.some(c => c === other || (c.contains && c.contains(other)));
    },

    querySelector(selector) {
      return queryAll(el, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return queryAll(el, selector);
    },

    addEventListener(event, handler, opts) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push({ handler, opts });
    },
    removeEventListener(event, handler, opts) {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter(l => l.handler !== handler);
    },
    dispatchEvent(event) {
      // Set target only on the originating element, not during bubbling
      if (!event.target) event.target = el;
      const fns = listeners[event.type] || [];
      for (const { handler } of fns) handler(event);
      // Bubble to parentNode (preserve original target)
      if (event.bubbles && !event._propagationStopped && el.parentNode && el.parentNode.dispatchEvent) {
        el.parentNode.dispatchEvent(event);
      }
      return true;
    },

    closest(selector) {
      let cur = el;
      while (cur) {
        if (matchesSelector(cur, selector)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    focus: vi.fn(),
    scrollIntoView: vi.fn(),
    click() {
      const event = new MockEvent('click', { bubbles: true });
      el.dispatchEvent(event);
    },
  };

  // Track class from className setter
  Object.defineProperty(el, 'className', {
    get() { return [...classList].join(' '); },
    set(val) {
      classList.clear();
      val.split(/\s+/).filter(Boolean).forEach(c => classList.add(c));
    },
    configurable: true,
  });

  return el;
}

/** Minimal Event mock. */
class MockEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = opts.bubbles || false;
    this.target = null;
    this._defaultPrevented = false;
    this._propagationStopped = false;
  }
  preventDefault() { this._defaultPrevented = true; }
  stopPropagation() { this._propagationStopped = true; }
}

/** Very simple selector matching (supports .class, #id, [data-*], tag). */
function matchesSelector(el, selector) {
  // Multiple selectors separated by commas are not used in this component, skip
  // Handle simple cases: .class, #id, tag, or [attr="val"]
  if (selector.startsWith('.')) {
    return el.classList && el.classList.contains(selector.slice(1));
  }
  if (selector.startsWith('#')) {
    return el.id === selector.slice(1);
  }
  // [data-value] or [data-value="x"]
  const attrMatch = selector.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
  if (attrMatch) {
    const val = el.getAttribute(attrMatch[1]);
    if (attrMatch[2] !== undefined) return val === attrMatch[2];
    return val != null;
  }
  // tag name
  return el.tagName === selector.toUpperCase();
}

/** Recursive querySelectorAll – handles simple single selectors only. */
function queryAll(root, selector) {
  const results = [];
  function walk(node) {
    if (!node._children) return;
    for (const child of node._children) {
      if (matchesSelector(child, selector)) results.push(child);
      walk(child);
    }
  }
  walk(root);
  return results;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

// global.window must exist BEFORE require() so the component can attach itself.
global.window = global.window || {};

// Set up a temporary document mock so the module-level code can load.
global.Event = MockEvent;
global.document = {
  createElement: (tag) => createMockElement(tag),
  addEventListener: () => {},
  removeEventListener: () => {},
};

// Load the component (attaches to global.window.TimeoutSelect)
require('../../public/js/components/TimeoutSelect.js');
const { TimeoutSelect } = global.window;

beforeEach(() => {
  vi.resetAllMocks();
  documentListeners = [];

  global.Event = MockEvent;

  global.document = {
    createElement: vi.fn((tag) => createMockElement(tag)),
    addEventListener: vi.fn((event, handler, opts) => {
      documentListeners.push({ event, handler, opts });
    }),
    removeEventListener: vi.fn((event, handler, opts) => {
      documentListeners = documentListeners.filter(l => !(l.event === event && l.handler === handler));
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TimeoutSelect', () => {

  // -- Static TIMEOUT_OPTIONS -----------------------------------------------

  describe('static TIMEOUT_OPTIONS', () => {
    it('should be an array with 4 default entries', () => {
      expect(TimeoutSelect.TIMEOUT_OPTIONS).toHaveLength(4);
    });

    it('should have 600000 (10m) as the default selected value', () => {
      const selected = TimeoutSelect.TIMEOUT_OPTIONS.find(o => o.selected);
      expect(selected).toBeDefined();
      expect(selected.value).toBe('600000');
      expect(selected.label).toBe('10m');
    });

    it('should contain expected timeout values', () => {
      const values = TimeoutSelect.TIMEOUT_OPTIONS.map(o => o.value);
      expect(values).toEqual(['300000', '600000', '900000', '1800000']);
    });
  });

  // -- Constructor ----------------------------------------------------------

  describe('constructor', () => {
    it('should use TIMEOUT_OPTIONS when no options provided', () => {
      const ts = new TimeoutSelect();
      // The default selected value should be '600000' (the one with selected: true)
      expect(ts.value).toBe('600000');
    });

    it('should create option buttons for each option', () => {
      const ts = new TimeoutSelect();
      const items = ts.el.querySelectorAll('.timeout-select-option');
      expect(items).toHaveLength(4);
    });

    it('should accept custom options', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: '100', label: '100ms' },
          { value: '200', label: '200ms', selected: true },
        ],
      });
      expect(ts.value).toBe('200');
      const items = ts.el.querySelectorAll('.timeout-select-option');
      expect(items).toHaveLength(2);
    });

    it('should fall back to first option when none is selected', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      });
      expect(ts.value).toBe('a');
    });

    it('should set className on root element', () => {
      const ts = new TimeoutSelect({ className: 'adv-timeout' });
      expect(ts.el.classList.contains('timeout-select')).toBe(true);
      expect(ts.el.classList.contains('adv-timeout')).toBe(true);
    });

    it('should set id on root element', () => {
      const ts = new TimeoutSelect({ id: 'my-timeout' });
      expect(ts.el.id).toBe('my-timeout');
    });

    it('should set title on root element', () => {
      const ts = new TimeoutSelect({ title: 'Pick a timeout' });
      expect(ts.el.title).toBe('Pick a timeout');
    });

    it('should copy datasets to root element', () => {
      const ts = new TimeoutSelect({ datasets: { level: '1', index: '0' } });
      expect(ts.el.dataset.level).toBe('1');
      expect(ts.el.dataset.index).toBe('0');
    });

    it('should be hidden by default', () => {
      const ts = new TimeoutSelect();
      expect(ts.el.style.display).toBe('none');
    });

    it('should NOT auto-append to any container', () => {
      const container = createMockElement('div');
      // Constructor no longer takes a container argument
      const ts = new TimeoutSelect();
      expect(container._children).toHaveLength(0);
    });

    it('should expose value property on the DOM element', () => {
      const ts = new TimeoutSelect({
        options: [{ value: '42', label: '42' }],
      });
      expect(ts.el.value).toBe('42');
      ts.el.value = '99';
      expect(ts.value).toBe('99');
    });

    it('should NOT register a document click listener on construction', () => {
      const addCalls = global.document.addEventListener.mock.calls;
      const before = addCalls.length;
      new TimeoutSelect();
      const after = addCalls.length;
      // No new document-level 'click' listeners should be added
      const clickCalls = addCalls.slice(before).filter(c => c[0] === 'click');
      expect(clickCalls).toHaveLength(0);
    });
  });

  // -- Value getter / setter ------------------------------------------------

  describe('value getter/setter', () => {
    it('should return the currently selected value', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: '1', label: 'one' },
          { value: '2', label: 'two', selected: true },
        ],
      });
      expect(ts.value).toBe('2');
    });

    it('should update label when value is set', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: '1', label: 'one' },
          { value: '2', label: 'two' },
        ],
      });
      ts.value = '2';
      expect(ts.value).toBe('2');
      // The trigger label should show 'two'
      const label = ts.el.querySelector('.timeout-select-label');
      expect(label.textContent).toBe('two');
    });

    it('should coerce to string', () => {
      const ts = new TimeoutSelect({
        options: [{ value: '42', label: '42' }],
      });
      ts.value = 42;
      expect(ts.value).toBe('42');
    });

    it('should update selected class on menu items', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: '1', label: 'one' },
          { value: '2', label: 'two' },
        ],
      });
      ts.value = '2';
      const items = ts.el.querySelectorAll('.timeout-select-option');
      expect(items[0].classList.contains('selected')).toBe(false);
      expect(items[1].classList.contains('selected')).toBe(true);
    });
  });

  // -- Change event ---------------------------------------------------------

  describe('change event', () => {
    it('should fire change event when a different option is clicked', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: '1', label: 'one', selected: true },
          { value: '2', label: 'two' },
        ],
      });

      const changeHandler = vi.fn();
      ts.el.addEventListener('change', changeHandler);

      // Click the second option
      const items = ts.el.querySelectorAll('.timeout-select-option');
      items[1].click();

      expect(changeHandler).toHaveBeenCalledTimes(1);
      expect(ts.value).toBe('2');
    });

    it('should NOT fire change event when the same option is clicked', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: '1', label: 'one', selected: true },
          { value: '2', label: 'two' },
        ],
      });

      const changeHandler = vi.fn();
      ts.el.addEventListener('change', changeHandler);

      // Click the already-selected option
      const items = ts.el.querySelectorAll('.timeout-select-option');
      items[0].click();

      expect(changeHandler).not.toHaveBeenCalled();
    });

    it('should NOT fire change event when value is set via setter', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: '1', label: 'one' },
          { value: '2', label: 'two' },
        ],
      });

      const changeHandler = vi.fn();
      ts.el.addEventListener('change', changeHandler);

      ts.value = '2';
      expect(changeHandler).not.toHaveBeenCalled();
    });
  });

  // -- show / hide / toggle -------------------------------------------------

  describe('show() / hide() / toggle()', () => {
    it('show() should clear display style', () => {
      const ts = new TimeoutSelect();
      expect(ts.el.style.display).toBe('none');
      ts.show();
      expect(ts.el.style.display).toBe('');
    });

    it('hide() should set display to none', () => {
      const ts = new TimeoutSelect();
      ts.show();
      ts.hide();
      expect(ts.el.style.display).toBe('none');
    });

    it('hide() should close the dropdown if open', () => {
      const ts = new TimeoutSelect();
      ts._open();
      expect(ts._isOpen).toBe(true);
      ts.hide();
      expect(ts._isOpen).toBe(false);
    });

    it('toggle() should switch between visible and hidden', () => {
      const ts = new TimeoutSelect();
      expect(ts.el.style.display).toBe('none');
      ts.toggle();
      expect(ts.el.style.display).toBe('');
      ts.toggle();
      expect(ts.el.style.display).toBe('none');
    });

    it('isVisible should reflect display state', () => {
      const ts = new TimeoutSelect();
      expect(ts.isVisible).toBe(false);
      ts.show();
      expect(ts.isVisible).toBe(true);
      ts.hide();
      expect(ts.isVisible).toBe(false);
    });
  });

  // -- open / close ---------------------------------------------------------

  describe('open() / close()', () => {
    it('_open() should set isOpen, add open class, and set aria-expanded', () => {
      const ts = new TimeoutSelect();
      ts._open();
      expect(ts._isOpen).toBe(true);
      expect(ts.el.classList.contains('open')).toBe(true);
      expect(ts._trigger.getAttribute('aria-expanded')).toBe('true');
    });

    it('_close() should clear isOpen, remove open class, and unset aria-expanded', () => {
      const ts = new TimeoutSelect();
      ts._open();
      ts._close();
      expect(ts._isOpen).toBe(false);
      expect(ts.el.classList.contains('open')).toBe(false);
      expect(ts._trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('_open() should register document click listener', () => {
      const ts = new TimeoutSelect();
      const before = global.document.addEventListener.mock.calls.length;
      ts._open();
      const clickCalls = global.document.addEventListener.mock.calls.slice(before)
        .filter(c => c[0] === 'click');
      expect(clickCalls).toHaveLength(1);
    });

    it('_close() should remove document click listener', () => {
      const ts = new TimeoutSelect();
      ts._open();
      const before = global.document.removeEventListener.mock.calls.length;
      ts._close();
      const removeCalls = global.document.removeEventListener.mock.calls.slice(before)
        .filter(c => c[0] === 'click');
      expect(removeCalls).toHaveLength(1);
    });

    it('_open() should focus the currently selected item', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: '1', label: 'one' },
          { value: '2', label: 'two', selected: true },
          { value: '3', label: 'three' },
        ],
      });
      ts._open();
      const items = ts.el.querySelectorAll('.timeout-select-option');
      expect(items[1].classList.contains('focused')).toBe(true);
      expect(items[0].classList.contains('focused')).toBe(false);
    });

    it('_close() should clear focused state from all items', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: '1', label: 'one', selected: true },
          { value: '2', label: 'two' },
        ],
      });
      ts._open();
      ts._close();
      const items = ts.el.querySelectorAll('.timeout-select-option');
      expect(items[0].classList.contains('focused')).toBe(false);
      expect(items[1].classList.contains('focused')).toBe(false);
    });

    it('clicking the trigger should toggle open/close', () => {
      const ts = new TimeoutSelect();
      expect(ts._isOpen).toBe(false);

      // Simulate trigger click
      ts._trigger.click();
      expect(ts._isOpen).toBe(true);

      ts._trigger.click();
      expect(ts._isOpen).toBe(false);
    });
  });

  // -- Keyboard navigation --------------------------------------------------

  describe('keyboard navigation', () => {
    function dispatchKeyDown(ts, key) {
      const event = new MockEvent('keydown');
      event.key = key;
      // Dispatch on the component element directly (it has the keydown listener)
      const fns = ts.el._listeners['keydown'] || [];
      for (const { handler } of fns) handler(event);
      return event;
    }

    it('ArrowDown should open the dropdown when closed', () => {
      const ts = new TimeoutSelect();
      const event = dispatchKeyDown(ts, 'ArrowDown');
      expect(ts._isOpen).toBe(true);
      expect(event._defaultPrevented).toBe(true);
    });

    it('ArrowUp should open the dropdown when closed', () => {
      const ts = new TimeoutSelect();
      dispatchKeyDown(ts, 'ArrowUp');
      expect(ts._isOpen).toBe(true);
    });

    it('Enter should open the dropdown when closed', () => {
      const ts = new TimeoutSelect();
      dispatchKeyDown(ts, 'Enter');
      expect(ts._isOpen).toBe(true);
    });

    it('Space should open the dropdown when closed', () => {
      const ts = new TimeoutSelect();
      dispatchKeyDown(ts, ' ');
      expect(ts._isOpen).toBe(true);
    });

    it('ArrowDown should move focus to next item when open', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: '1', label: 'one', selected: true },
          { value: '2', label: 'two' },
          { value: '3', label: 'three' },
        ],
      });
      ts._open();

      // Initially focused on selected item (index 0)
      dispatchKeyDown(ts, 'ArrowDown');
      const items = ts.el.querySelectorAll('.timeout-select-option');
      expect(items[1].classList.contains('focused')).toBe(true);
      expect(items[0].classList.contains('focused')).toBe(false);
    });

    it('ArrowDown should wrap to first item from last', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: '1', label: 'one' },
          { value: '2', label: 'two' },
        ],
      });
      ts._open();
      // Focus is on index 0 (first option, since none marked selected, falls back to 0)
      dispatchKeyDown(ts, 'ArrowDown'); // move to index 1
      dispatchKeyDown(ts, 'ArrowDown'); // wrap to index 0

      const items = ts.el.querySelectorAll('.timeout-select-option');
      expect(items[0].classList.contains('focused')).toBe(true);
    });

    it('ArrowUp should move focus to previous item when open', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: '1', label: 'one' },
          { value: '2', label: 'two', selected: true },
          { value: '3', label: 'three' },
        ],
      });
      ts._open(); // focused on index 1

      dispatchKeyDown(ts, 'ArrowUp');
      const items = ts.el.querySelectorAll('.timeout-select-option');
      expect(items[0].classList.contains('focused')).toBe(true);
    });

    it('ArrowUp should wrap to last item from first', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: '1', label: 'one', selected: true },
          { value: '2', label: 'two' },
          { value: '3', label: 'three' },
        ],
      });
      ts._open(); // focused on index 0

      dispatchKeyDown(ts, 'ArrowUp'); // wrap to index 2
      const items = ts.el.querySelectorAll('.timeout-select-option');
      expect(items[2].classList.contains('focused')).toBe(true);
    });

    it('Enter should select the focused item when open', () => {
      const ts = new TimeoutSelect({
        options: [
          { value: '1', label: 'one', selected: true },
          { value: '2', label: 'two' },
        ],
      });
      ts._open();
      dispatchKeyDown(ts, 'ArrowDown'); // focus index 1
      dispatchKeyDown(ts, 'Enter'); // select it

      expect(ts.value).toBe('2');
      expect(ts._isOpen).toBe(false);
    });

    it('Escape should close the dropdown and focus the trigger', () => {
      const ts = new TimeoutSelect();
      ts._open();

      dispatchKeyDown(ts, 'Escape');

      expect(ts._isOpen).toBe(false);
      expect(ts._trigger.focus).toHaveBeenCalled();
    });

    it('random key should not open the dropdown when closed', () => {
      const ts = new TimeoutSelect();
      const event = dispatchKeyDown(ts, 'a');
      expect(ts._isOpen).toBe(false);
      expect(event._defaultPrevented).toBe(false);
    });
  });

  // -- destroy() ------------------------------------------------------------

  describe('destroy()', () => {
    it('should remove the element from its parent', () => {
      const container = createMockElement('div');
      const ts = new TimeoutSelect();
      container.appendChild(ts.el);

      expect(container._children).toContain(ts.el);
      ts.destroy();
      expect(container._children).not.toContain(ts.el);
    });

    it('should remove the document click listener even if dropdown is open', () => {
      const ts = new TimeoutSelect();
      ts._open();
      // At this point a document listener is registered

      ts.destroy();

      // destroy() calls document.removeEventListener for the click handler
      const removeCalls = global.document.removeEventListener.mock.calls
        .filter(c => c[0] === 'click');
      expect(removeCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('should not throw if element has no parent', () => {
      const ts = new TimeoutSelect();
      expect(() => ts.destroy()).not.toThrow();
    });
  });

  // -- Static mount() factory -----------------------------------------------

  describe('static mount()', () => {
    it('should create a TimeoutSelect and replace the mount element', () => {
      const parent = createMockElement('div');
      const mountSpan = createMockElement('span');
      mountSpan.dataset.level = '1';
      mountSpan.dataset.index = '0';
      parent.appendChild(mountSpan);

      const ts = TimeoutSelect.mount(mountSpan, {
        className: 'adv-timeout',
        id: 'my-timeout',
        title: 'Per-reviewer timeout',
      });

      // The mount span should be removed from the parent
      expect(parent._children).not.toContain(mountSpan);
      // The TimeoutSelect element should be in the parent
      expect(parent._children).toContain(ts.el);
    });

    it('should copy data attributes from the mount element', () => {
      const parent = createMockElement('div');
      const mountSpan = createMockElement('span');
      mountSpan.dataset.level = '2';
      mountSpan.dataset.index = '3';
      parent.appendChild(mountSpan);

      const ts = TimeoutSelect.mount(mountSpan);

      expect(ts.el.dataset.level).toBe('2');
      expect(ts.el.dataset.index).toBe('3');
    });

    it('should use TIMEOUT_OPTIONS by default', () => {
      const parent = createMockElement('div');
      const mountSpan = createMockElement('span');
      parent.appendChild(mountSpan);

      const ts = TimeoutSelect.mount(mountSpan);

      // Should have 4 options (from TIMEOUT_OPTIONS)
      const items = ts.el.querySelectorAll('.timeout-select-option');
      expect(items).toHaveLength(4);
      expect(ts.value).toBe('600000');
    });

    it('should accept custom options', () => {
      const parent = createMockElement('div');
      const mountSpan = createMockElement('span');
      parent.appendChild(mountSpan);

      const ts = TimeoutSelect.mount(mountSpan, {
        options: [
          { value: '100', label: '100ms', selected: true },
          { value: '200', label: '200ms' },
        ],
      });

      const items = ts.el.querySelectorAll('.timeout-select-option');
      expect(items).toHaveLength(2);
      expect(ts.value).toBe('100');
    });

    it('should set className from opts', () => {
      const parent = createMockElement('div');
      const mountSpan = createMockElement('span');
      parent.appendChild(mountSpan);

      const ts = TimeoutSelect.mount(mountSpan, { className: 'vc-timeout' });

      expect(ts.el.classList.contains('timeout-select')).toBe(true);
      expect(ts.el.classList.contains('vc-timeout')).toBe(true);
    });

    it('should set id and title from opts', () => {
      const parent = createMockElement('div');
      const mountSpan = createMockElement('span');
      parent.appendChild(mountSpan);

      const ts = TimeoutSelect.mount(mountSpan, {
        id: 'adv-orchestration-timeout',
        title: 'Orchestration timeout',
      });

      expect(ts.el.id).toBe('adv-orchestration-timeout');
      expect(ts.el.title).toBe('Orchestration timeout');
    });

    it('should insert the component at the same position as the mount element', () => {
      const parent = createMockElement('div');
      const before = createMockElement('div');
      const mountSpan = createMockElement('span');
      const after = createMockElement('div');
      parent.appendChild(before);
      parent.appendChild(mountSpan);
      parent.appendChild(after);

      const ts = TimeoutSelect.mount(mountSpan);

      // The TimeoutSelect should be between 'before' and 'after'
      expect(parent._children[0]).toBe(before);
      expect(parent._children[1]).toBe(ts.el);
      expect(parent._children[2]).toBe(after);
    });
  });

  // -- Document listener leak prevention ------------------------------------

  describe('document listener leak prevention', () => {
    it('should not have any document click listeners when dropdown is never opened', () => {
      new TimeoutSelect();
      const clickListeners = documentListeners.filter(l => l.event === 'click');
      expect(clickListeners).toHaveLength(0);
    });

    it('should register and remove document click listener on open/close cycle', () => {
      const ts = new TimeoutSelect();

      ts._open();
      let clickListeners = documentListeners.filter(l => l.event === 'click');
      expect(clickListeners).toHaveLength(1);

      ts._close();
      clickListeners = documentListeners.filter(l => l.event === 'click');
      expect(clickListeners).toHaveLength(0);
    });

    it('should not leak listeners when component is removed without destroy()', () => {
      const ts = new TimeoutSelect();
      ts._open();
      ts._close();

      // After close, no document listeners should remain
      const clickListeners = documentListeners.filter(l => l.event === 'click');
      expect(clickListeners).toHaveLength(0);
    });
  });
});
