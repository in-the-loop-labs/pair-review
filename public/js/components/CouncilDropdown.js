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
   * What a council control says when the stored council id no longer resolves to
   * a council — the council was deleted (DELETE /api/councils/:id deliberately
   * leaves the setting pointing at the dead id; src/review-config.js warns and
   * falls back to the provider/model default at run time) or a file-overlay
   * council stopped resolving.
   *
   * It lives HERE, on the one component both council surfaces already load
   * (settings.html and repo-settings.html), because the global settings page and
   * the repo settings page are separate page scripts that cannot import from each
   * other — the sentence would otherwise exist twice and drift. Consumers read
   * `CouncilDropdown.STALE_COUNCIL_LABEL` for the dropdown trigger AND the
   * preview beneath it, so the two cannot contradict each other.
   */
  static STALE_COUNCIL_LABEL = 'Selected council no longer exists — pick another';

  /**
   * What a council control says when the council list could not be LOADED — a
   * different state from "the council was deleted" and from "there are none",
   * and the only one of the three the UI cannot verify. Shared for the same
   * reason as STALE_COUNCIL_LABEL: the trigger and the preview beneath it are
   * rendered by different code on two pages, and an unloadable list must not
   * come out as "No councils available" in one and "we don't know" in the other.
   */
  static COUNCILS_UNAVAILABLE_LABEL = 'Could not load the council list';

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
   * consumer (e.g. a card preview, CouncilManager's list rows) label types
   * identically.
   *
   * ONLY `'council'` is Standard. Everything else — including a row with no
   * `type` at all — is Advanced: such a row holds a level-keyed config,
   * `AdvancedConfigTab.COUNCIL_CRUD_SPEC.councilFilter` claims it
   * (`!c.type || c.type === 'advanced'`), and POST /api/councils stores
   * `type || 'advanced'`. (Nothing writes an untyped row today — every writer
   * defaults the column — so tolerating one is defensive, not legacy support.)
   * Normalizing HERE rather than at each call site is what
   * stops the two renderers on /settings (CouncilManager's list row and the
   * "Default for Analysis" picker directly above it) from badging the same
   * council "Advanced" and "Standard" ~30px apart.
   *
   * @param {string|null|undefined} type
   * @returns {{ label: string, cssClass: string }}
   */
  static typeBadge(type) {
    if (type === 'council') return { label: 'Standard', cssClass: 'badge-standard' };
    return { label: 'Advanced', cssClass: 'badge-advanced' };
  }

  /**
   * Map a council's source to an extra badge: file-overlay councils
   * (`source: 'file'`, read-only, defined in ~/.pair-review/councils/) get a
   * "File" badge next to the type badge; DB councils get none.
   * @param {Object|null|undefined} council
   * @returns {{ label: string, cssClass: string }|null}
   */
  static sourceBadge(council) {
    if (council?.source === 'file') return { label: 'File', cssClass: 'badge-file' };
    return null;
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
      const source = CouncilDropdown.sourceBadge(selected);
      return `<span class="trigger-text">${this.escapeHtml(selected.name)}</span>` +
        `<span class="council-type-badge ${badge.cssClass}">${badge.label}</span>` +
        (source ? `<span class="council-type-badge ${source.cssClass}">${source.label}</span>` : '');
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
      const source = CouncilDropdown.sourceBadge(council);
      const selected = council.id === this.selectedId;
      html += `<div class="custom-dropdown-option${selected ? ' selected' : ''}" data-value="${this.escapeHtml(council.id)}" role="option" aria-selected="${selected}">` +
        `<span class="option-name">${this.escapeHtml(council.name)}</span>` +
        `<span class="council-type-badge ${badge.cssClass}">${badge.label}</span>` +
        (source ? `<span class="council-type-badge ${source.cssClass}">${source.label}</span>` : '') +
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
