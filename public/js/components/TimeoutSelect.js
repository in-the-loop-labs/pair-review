// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * TimeoutSelect - Custom styled dropdown selector for timeout controls.
 *
 * Replaces native <select> elements with a compact pill-style dropdown that
 * supports both light and dark themes. Designed to sit inline with the clock
 * icon toggle button in council configuration tabs.
 *
 * Usage:
 *   // Using the static factory (preferred — handles mount-point replacement):
 *   const ts = TimeoutSelect.mount(mountSpan, {
 *     className: 'adv-timeout',
 *     id: 'adv-orchestration-timeout',
 *     title: 'Orchestration timeout',
 *   });
 *
 *   // Using the constructor directly (caller places ts.el in the DOM):
 *   const ts = new TimeoutSelect({
 *     options: TimeoutSelect.TIMEOUT_OPTIONS,
 *     className: 'adv-timeout',
 *     datasets: { level: '1', index: '0' },
 *     id: 'adv-orchestration-timeout',
 *     title: 'Per-reviewer timeout',
 *   });
 *   someParent.appendChild(ts.el);
 *
 *   ts.value;           // get current value
 *   ts.value = '900000' // set value programmatically
 *   ts.show() / ts.hide() / ts.toggle()
 *   ts.el               // root DOM element
 *   ts.destroy()         // clean up listeners
 */
class TimeoutSelect {
  /** Default timeout options shared across all tabs */
  static TIMEOUT_OPTIONS = [
    { value: '300000', label: '5m' },
    { value: '600000', label: '10m', selected: true },
    { value: '900000', label: '15m' },
    { value: '1800000', label: '30m' },
  ];

  /**
   * Static factory that creates a TimeoutSelect and replaces a mount-point
   * element in the DOM. The mount element's data-* attributes are copied to
   * the new component.
   *
   * @param {HTMLElement} mountEl - The placeholder <span> to replace
   * @param {Object} [opts] - Extra options forwarded to the constructor
   *   (className, id, title). `options` defaults to TIMEOUT_OPTIONS and
   *   `datasets` is read from mountEl.dataset automatically.
   * @returns {TimeoutSelect} The created instance (already in the DOM)
   */
  static mount(mountEl, opts = {}) {
    const parent = mountEl.parentNode;
    const ts = new TimeoutSelect({
      options: (opts.options || TimeoutSelect.TIMEOUT_OPTIONS).map(o => ({ ...o })),
      className: opts.className || '',
      datasets: { ...mountEl.dataset },
      id: opts.id || '',
      title: opts.title || '',
    });
    parent.insertBefore(ts.el, mountEl);
    parent.removeChild(mountEl);
    return ts;
  }

  /**
   * @param {Object} opts
   * @param {Array<{value: string, label: string, selected?: boolean}>} [opts.options]
   *   Defaults to TimeoutSelect.TIMEOUT_OPTIONS.
   * @param {string} [opts.className] - Extra CSS class(es) for the root element
   * @param {Object} [opts.datasets] - data-* attributes to set on the root element
   * @param {string} [opts.id] - Optional id attribute
   * @param {string} [opts.title] - Optional title (tooltip)
   */
  constructor(opts = {}) {
    this._options = opts.options || TimeoutSelect.TIMEOUT_OPTIONS;
    this._className = opts.className || '';
    this._datasets = opts.datasets || {};
    this._id = opts.id || '';
    this._title = opts.title || '';

    // Determine initial selected value
    const selectedOpt = this._options.find(o => o.selected) || this._options[0];
    this._value = selectedOpt ? selectedOpt.value : '';

    // Build DOM
    this._buildDOM();

    // Set data attributes
    for (const [key, val] of Object.entries(this._datasets)) {
      this.el.dataset[key] = val;
    }
    if (this._id) this.el.id = this._id;
    if (this._title) this.el.title = this._title;

    // Expose value on the DOM element itself so delegated change handlers
    // can read e.target.value just like a native <select>.
    const self = this;
    Object.defineProperty(this.el, 'value', {
      get() { return self._value; },
      set(v) { self._setValue(String(v)); },
      configurable: true,
    });

    // Hidden by default (matches old <select style="display:none">)
    this.el.style.display = 'none';

    // Bind event handlers (stored for cleanup)
    this._onTriggerClick = this._handleTriggerClick.bind(this);
    this._onDocumentClick = this._handleDocumentClick.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onMenuClick = this._handleMenuClick.bind(this);

    this._trigger.addEventListener('click', this._onTriggerClick);
    this._menu.addEventListener('click', this._onMenuClick);
    this.el.addEventListener('keydown', this._onKeyDown);

    this._isOpen = false;
  }

  /** Build the custom dropdown DOM structure */
  _buildDOM() {
    // Root container
    this.el = document.createElement('div');
    this.el.className = `timeout-select ${this._className}`.trim();

    // Trigger button (shows current value)
    this._trigger = document.createElement('button');
    this._trigger.type = 'button';
    this._trigger.className = 'timeout-select-trigger';
    this._trigger.setAttribute('aria-haspopup', 'listbox');
    this._trigger.setAttribute('aria-expanded', 'false');

    this._triggerLabel = document.createElement('span');
    this._triggerLabel.className = 'timeout-select-label';
    this._triggerLabel.textContent = this._getLabelForValue(this._value);

    this._triggerCaret = document.createElement('svg');
    this._triggerCaret.className = 'timeout-select-caret';
    this._triggerCaret.setAttribute('width', '10');
    this._triggerCaret.setAttribute('height', '10');
    this._triggerCaret.setAttribute('viewBox', '0 0 12 12');
    this._triggerCaret.setAttribute('fill', 'none');
    this._triggerCaret.innerHTML = '<path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';

    this._trigger.appendChild(this._triggerLabel);
    this._trigger.appendChild(this._triggerCaret);

    // Dropdown menu
    this._menu = document.createElement('div');
    this._menu.className = 'timeout-select-menu';
    this._menu.setAttribute('role', 'listbox');

    for (const opt of this._options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'timeout-select-option';
      item.setAttribute('role', 'option');
      item.setAttribute('data-value', opt.value);
      item.textContent = opt.label;
      if (opt.value === this._value) {
        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
      }
      this._menu.appendChild(item);
    }

    this.el.appendChild(this._trigger);
    this.el.appendChild(this._menu);
  }

  /** Get the display label for a value */
  _getLabelForValue(value) {
    const opt = this._options.find(o => o.value === value);
    return opt ? opt.label : value;
  }

  /** Handle trigger click */
  _handleTriggerClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (this._isOpen) {
      this._close();
    } else {
      this._open();
    }
  }

  /** Handle document click to close when clicking outside */
  _handleDocumentClick(e) {
    if (!this.el.contains(e.target)) {
      this._close();
    }
  }

  /** Handle menu item click */
  _handleMenuClick(e) {
    const item = e.target.closest('.timeout-select-option');
    if (!item) return;

    e.preventDefault();
    e.stopPropagation();

    const newValue = item.getAttribute('data-value');
    if (newValue !== this._value) {
      this._setValue(newValue);

      // Fire a change event that bubbles, so parent listeners can catch it
      const event = new Event('change', { bubbles: true });
      this.el.dispatchEvent(event);
    }

    this._close();
  }

  /** Handle keyboard navigation */
  _handleKeyDown(e) {
    if (!this._isOpen) {
      // Open on Enter, Space, ArrowDown, ArrowUp
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        this._open();
      }
      return;
    }

    const items = Array.from(this._menu.querySelectorAll('.timeout-select-option'));
    const currentIdx = items.findIndex(item => item.classList.contains('focused'));

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const nextIdx = currentIdx < items.length - 1 ? currentIdx + 1 : 0;
        this._focusItem(items, nextIdx);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prevIdx = currentIdx > 0 ? currentIdx - 1 : items.length - 1;
        this._focusItem(items, prevIdx);
        break;
      }
      case 'Enter':
      case ' ': {
        e.preventDefault();
        if (currentIdx >= 0) {
          items[currentIdx].click();
        }
        break;
      }
      case 'Escape': {
        e.preventDefault();
        this._close();
        this._trigger.focus();
        break;
      }
    }
  }

  /** Focus a menu item by index */
  _focusItem(items, idx) {
    items.forEach(item => item.classList.remove('focused'));
    if (items[idx]) {
      items[idx].classList.add('focused');
      items[idx].scrollIntoView({ block: 'nearest' });
    }
  }

  /** Open the dropdown */
  _open() {
    this._isOpen = true;
    this.el.classList.add('open');
    this._trigger.setAttribute('aria-expanded', 'true');

    // Register document click listener lazily to avoid leaks when the
    // component is removed from the DOM without calling destroy().
    document.addEventListener('click', this._onDocumentClick, true);

    // Focus the currently selected item
    const items = Array.from(this._menu.querySelectorAll('.timeout-select-option'));
    const selectedIdx = items.findIndex(item => item.classList.contains('selected'));
    this._focusItem(items, selectedIdx >= 0 ? selectedIdx : 0);
  }

  /** Close the dropdown */
  _close() {
    this._isOpen = false;
    this.el.classList.remove('open');
    this._trigger.setAttribute('aria-expanded', 'false');

    // Remove the lazily-registered document listener
    document.removeEventListener('click', this._onDocumentClick, true);

    // Clear focus state
    this._menu.querySelectorAll('.timeout-select-option').forEach(item => {
      item.classList.remove('focused');
    });
  }

  /** Set value internally and update DOM */
  _setValue(newValue) {
    this._value = newValue;
    this._triggerLabel.textContent = this._getLabelForValue(newValue);

    // Update selected state in menu
    this._menu.querySelectorAll('.timeout-select-option').forEach(item => {
      const isSelected = item.getAttribute('data-value') === newValue;
      item.classList.toggle('selected', isSelected);
      item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });
  }

  // --- Public API ---

  /** Get the current value */
  get value() {
    return this._value;
  }

  /** Set the current value (does NOT fire a change event) */
  set value(newValue) {
    this._setValue(String(newValue));
  }

  /** Show the component (sets display to inline-flex) */
  show() {
    this.el.style.display = '';
  }

  /** Hide the component */
  hide() {
    this.el.style.display = 'none';
    if (this._isOpen) this._close();
  }

  /** Toggle visibility */
  toggle() {
    if (this.el.style.display === 'none') {
      this.show();
    } else {
      this.hide();
    }
  }

  /** Whether the component is currently visible */
  get isVisible() {
    return this.el.style.display !== 'none';
  }

  /** Destroy the component and remove listeners */
  destroy() {
    this._trigger.removeEventListener('click', this._onTriggerClick);
    this._menu.removeEventListener('click', this._onMenuClick);
    document.removeEventListener('click', this._onDocumentClick, true);
    this.el.removeEventListener('keydown', this._onKeyDown);

    if (this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
  }
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.TimeoutSelect = TimeoutSelect;
}
