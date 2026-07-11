// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * CouncilDropdown — a shared rich council picker.
 *
 * Extracted from the repo-settings page so the global settings page can reuse
 * the SAME control instead of a bare native <select>. It renders a styled
 * trigger + option list that surfaces each council's name and type badge
 * (Standard / Advanced), with full keyboard navigation and outside-click close.
 *
 * The component owns rendering + interaction only; it does NOT decide what a
 * selection means. On selection it calls `onSelect(value)` (value is the council
 * id, or '' for the optional "none" base option) and lets the consumer update
 * its own model / previews / persistence, then reflect the new selection back
 * via `setSelected()`.
 *
 * Consumers:
 *   - public/js/repo-settings.js — no base option; the single/council mode is a
 *     separate segmented control, so the dropdown only lists councils.
 *   - public/js/settings.js — includeNone:true renders a "Default Provider /
 *     Model" base option as the first row, so the one control expresses the
 *     "either the provider/model default OR a council" choice.
 *
 * Markup + CSS classes match the original repo-settings dropdown
 * (.custom-dropdown*, .council-type-badge*), now in public/css/council-dropdown.css
 * (loaded by both pages).
 */

class CouncilDropdown {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.container - Mount element (given `.custom-dropdown`).
   * @param {Array<{id:string,name:string,type:string}>} [opts.councils] - Council list.
   * @param {string} [opts.selectedId] - Currently selected council id ('' = none).
   * @param {Function} [opts.onSelect] - Called with the chosen value (id or '').
   * @param {boolean} [opts.includeNone] - Render a base/none option at the top.
   * @param {string} [opts.noneLabel] - Label for the none option + its trigger text.
   * @param {string} [opts.placeholder] - Trigger text when nothing is selected and
   *   there is no none option (repo-settings behavior).
   * @param {string} [opts.emptyText] - Trigger text when there are no councils and
   *   no none option.
   * @param {boolean} [opts.disabled] - Render non-interactive (e.g. a config
   *   `final` lock): the trigger is disabled and no listeners are wired.
   */
  constructor(opts = {}) {
    this.container = opts.container;
    this.councils = Array.isArray(opts.councils) ? opts.councils : [];
    this.selectedId = opts.selectedId || '';
    this.onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : () => {};
    this.includeNone = opts.includeNone === true;
    this.noneLabel = opts.noneLabel || 'None';
    this.placeholder = opts.placeholder || 'Select a council...';
    this.emptyText = opts.emptyText || 'No councils available';
    this.disabled = opts.disabled === true;

    // Bound document handler so we can add/remove the exact same reference.
    this._outsideClickHandler = null;
    this._focusedIndex = -1;

    if (this.container) this.render();
  }

  /**
   * Map a council type to its display badge. Shared so the dropdown and any
   * consumer (e.g. a card preview) label types identically.
   * @param {string} type
   * @returns {{ label: string, cssClass: string }}
   */
  static typeBadge(type) {
    if (type === 'advanced') return { label: 'Advanced', cssClass: 'badge-advanced' };
    return { label: 'Standard', cssClass: 'badge-standard' };
  }

  /** Replace the council list and re-render (preserving the current selection). */
  setCouncils(councils) {
    this.councils = Array.isArray(councils) ? councils : [];
    this.render();
  }

  /** Update the selected id and re-render the trigger/option states. */
  setSelected(id) {
    this.selectedId = id || '';
    this.render();
  }

  /** Escape text for safe interpolation into the option/trigger HTML. */
  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /**
   * Build the trigger inner HTML for the current selection.
   * @private
   */
  _triggerHtml() {
    if (this.selectedId === '' && this.includeNone) {
      return `<span class="trigger-text">${this.escapeHtml(this.noneLabel)}</span>`;
    }
    const selected = this.councils.find((c) => c.id === this.selectedId);
    if (selected) {
      const badge = CouncilDropdown.typeBadge(selected.type);
      return `<span class="trigger-text">${this.escapeHtml(selected.name)}</span>` +
        `<span class="council-type-badge ${badge.cssClass}">${badge.label}</span>`;
    }
    // Nothing selected and no (or unmatched) none option.
    const placeholder = this.councils.length > 0 ? this.placeholder : this.emptyText;
    return `<span class="trigger-text placeholder">${this.escapeHtml(placeholder)}</span>`;
  }

  /**
   * Build the option list HTML (optional none row first, then councils sorted
   * alphabetically by name).
   * @private
   */
  _optionsHtml() {
    let html = '';
    if (this.includeNone) {
      const selected = this.selectedId === '';
      html += `<div class="custom-dropdown-option${selected ? ' selected' : ''}" data-value="" role="option" aria-selected="${selected}">` +
        `<span class="option-name">${this.escapeHtml(this.noneLabel)}</span>` +
        `</div>`;
    }
    const sorted = [...this.councils].sort((a, b) =>
      (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
    );
    for (const council of sorted) {
      const badge = CouncilDropdown.typeBadge(council.type);
      const selected = council.id === this.selectedId;
      html += `<div class="custom-dropdown-option${selected ? ' selected' : ''}" data-value="${this.escapeHtml(council.id)}" role="option" aria-selected="${selected}">` +
        `<span class="option-name">${this.escapeHtml(council.name)}</span>` +
        `<span class="council-type-badge ${badge.cssClass}">${badge.label}</span>` +
        `</div>`;
    }
    return html;
  }

  /** Render (or re-render) the trigger + list and (re)wire listeners. */
  render() {
    if (!this.container) return;
    this.container.innerHTML = `
      <button type="button" class="custom-dropdown-trigger" aria-haspopup="listbox" aria-expanded="false"${this.disabled ? ' disabled' : ''}>
        ${this._triggerHtml()}
      </button>
      <div class="custom-dropdown-list" role="listbox">
        ${this._optionsHtml()}
      </div>
    `;
    // A disabled control shows its value but wires no interaction.
    if (!this.disabled) this._attachListeners();
  }

  /**
   * Wire trigger click, option click, keyboard navigation, and outside-click
   * close. Re-attached on every render; the document handler is de-duplicated by
   * removing the previous reference first (a render replaces the DOM but the
   * document listener would otherwise accumulate).
   * @private
   */
  _attachListeners() {
    const container = this.container;
    const trigger = container.querySelector('.custom-dropdown-trigger');
    const list = container.querySelector('.custom-dropdown-list');
    if (!trigger || !list) return;

    const getOptions = () => Array.from(list.querySelectorAll('.custom-dropdown-option'));
    const updateFocus = (options, index) => {
      options.forEach((opt) => opt.classList.remove('focused'));
      if (index >= 0 && index < options.length) {
        options[index].classList.add('focused');
        options[index].scrollIntoView({ block: 'nearest' });
      }
    };

    trigger.addEventListener('click', () => {
      if (container.classList.contains('open')) {
        this.close();
      } else {
        this.open();
        this._focusedIndex = -1;
      }
    });

    list.addEventListener('click', (e) => {
      const option = e.target.closest('.custom-dropdown-option');
      if (!option) return;
      this._choose(option.dataset.value);
    });

    trigger.addEventListener('keydown', (e) => {
      const isOpen = container.classList.contains('open');

      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        this.close();
        trigger.focus();
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!isOpen) {
          this.open();
          this._focusedIndex = -1;
        } else {
          const options = getOptions();
          if (this._focusedIndex >= 0 && this._focusedIndex < options.length) {
            this._choose(options[this._focusedIndex].dataset.value);
          }
        }
        return;
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && isOpen) {
        e.preventDefault();
        const options = getOptions();
        if (e.key === 'ArrowDown') {
          this._focusedIndex = Math.min(this._focusedIndex + 1, options.length - 1);
        } else {
          this._focusedIndex = Math.max(this._focusedIndex - 1, 0);
        }
        updateFocus(options, this._focusedIndex);
        return;
      }
      if (e.key === 'ArrowDown' && !isOpen) {
        e.preventDefault();
        this.open();
        this._focusedIndex = 0;
        updateFocus(getOptions(), this._focusedIndex);
      }
    });

    // Outside-click close — remove the previous reference before adding so
    // repeated renders don't stack listeners.
    if (this._outsideClickHandler && typeof document !== 'undefined') {
      document.removeEventListener('click', this._outsideClickHandler);
    }
    this._outsideClickHandler = (e) => {
      if (!container.contains(e.target) && container.classList.contains('open')) {
        this.close();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('click', this._outsideClickHandler);
    }
  }

  /**
   * Handle a chosen value: notify the consumer. The consumer updates its model
   * and calls setSelected() to reflect the new state, so we do not mutate
   * selectedId here (mirrors the original repo-settings flow).
   * @private
   */
  _choose(value) {
    this.close();
    this.onSelect(value || '');
  }

  open() {
    if (!this.container) return;
    this.container.classList.add('open');
    const trigger = this.container.querySelector('.custom-dropdown-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
  }

  close() {
    if (!this.container) return;
    this.container.classList.remove('open');
    const trigger = this.container.querySelector('.custom-dropdown-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    this.container.querySelectorAll('.custom-dropdown-option.focused').forEach(
      (opt) => opt.classList.remove('focused')
    );
  }

  /** Remove the document-level outside-click listener (call on teardown). */
  destroy() {
    if (this._outsideClickHandler && typeof document !== 'undefined') {
      document.removeEventListener('click', this._outsideClickHandler);
      this._outsideClickHandler = null;
    }
  }
}

// Browser global for the two pages that load this before their page script.
if (typeof window !== 'undefined') {
  window.CouncilDropdown = CouncilDropdown;
}

// Export for unit tests (jsdom), following the repo's component export pattern.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CouncilDropdown };
}
