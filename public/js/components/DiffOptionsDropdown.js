// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * DiffOptionsDropdown - Gear-icon popover for diff display options.
 *
 * Anchors a small dropdown below the gear button (#diff-options-btn) with
 * checkbox toggles that control diff rendering.  Supports:
 *   - "Hide whitespace changes"
 *   - "Minimize comments" (collapse inline comments to line indicators)
 *   - Scope range selector (local mode only)
 *
 * Follows the same popover pattern used by PanelGroup._showPopover() /
 * _hidePopover() (fixed positioning via getBoundingClientRect, click-outside
 * and Escape to dismiss, opacity+transform animation).
 *
 * IMPORTANT: This dropdown is constructed in BOTH pr.js and local.js.
 * LocalManager (local.js) destroys the pr.js instance and recreates it
 * with scope-selector support. Any new callback added here MUST be
 * threaded through both construction sites or it will silently no-op
 * in local mode.
 *
 * Usage:
 *   const dropdown = new DiffOptionsDropdown(
 *     document.getElementById('diff-options-btn'),
 *     {
 *       onToggleWhitespace: (hidden) => { … },
 *       onToggleMinimize: (minimized) => { … },
 *       onScopeChange: (start, end) => { … },
 *       initialScope: { start: 'unstaged', end: 'untracked' },
 *       branchAvailable: false
 *     }
 *   );
 */

const STORAGE_KEY = 'pair-review-hide-whitespace';
const MINIMIZE_STORAGE_KEY = 'pair-review-minimize-comments';

class DiffOptionsDropdown {
  /**
   * @param {HTMLElement} buttonElement - The gear icon button already in the DOM
   * @param {Object}      callbacks
   * @param {function(boolean):void} callbacks.onToggleWhitespace
   * @param {function(boolean):void} [callbacks.onToggleMinimize]
   * @param {function(string,string):void} [callbacks.onScopeChange]
   * @param {{start:string,end:string}} [callbacks.initialScope]
   * @param {boolean} [callbacks.branchAvailable]
   */
  constructor(buttonElement, { onToggleWhitespace, onToggleMinimize, onScopeChange, initialScope, branchAvailable }) {
    this._btn = buttonElement;
    this._onToggleWhitespace = onToggleWhitespace;
    this._onToggleMinimize = onToggleMinimize || (() => {});
    this._onScopeChange = onScopeChange || null;

    this._popoverEl = null;
    this._checkbox = null;
    this._minimizeCheckbox = null;
    this._visible = false;
    this._outsideClickHandler = null;
    this._escapeHandler = null;

    // Scope state — resolve LocalScope with inline fallback so the scope selector
    // renders even if window.LocalScope failed to load (race condition guard).
    const FALLBACK_STOPS = ['branch', 'staged', 'unstaged', 'untracked']; // Keep in sync with local-scope.js:STOPS
    const FALLBACK_DEFAULT = { start: 'unstaged', end: 'untracked' };
    this._localScope = window.LocalScope || {
      STOPS: FALLBACK_STOPS,
      DEFAULT_SCOPE: FALLBACK_DEFAULT,
      isValidScope: (s, e) => {
        const si = FALLBACK_STOPS.indexOf(s);
        const ei = FALLBACK_STOPS.indexOf(e);
        return si !== -1 && ei !== -1 && si <= ei;
      },
      scopeIncludes: (s, e, stop) => {
        const si = FALLBACK_STOPS.indexOf(s);
        const ei = FALLBACK_STOPS.indexOf(e);
        const ti = FALLBACK_STOPS.indexOf(stop);
        return ti !== -1 && ti >= si && ti <= ei;
      }
    };
    const LS = this._localScope;
    this._branchAvailable = Boolean(branchAvailable);
    this._scopeStart = (initialScope && initialScope.start) || LS.DEFAULT_SCOPE.start;
    this._scopeEnd = (initialScope && initialScope.end) || LS.DEFAULT_SCOPE.end;
    this._scopeStops = [];
    this._scopeTrackEl = null;
    this._scopeDebounceTimer = null;
    this._scopeStatusEl = null;

    // Read persisted state
    this._hideWhitespace = localStorage.getItem(STORAGE_KEY) === 'true';
    this._minimizeComments = localStorage.getItem(MINIMIZE_STORAGE_KEY) === 'true';

    this._renderPopover();
    this._syncButtonActive();

    // Toggle popover on button click
    this._btnClickHandler = (e) => {
      e.stopPropagation();
      if (this._visible) {
        this._hide();
      } else {
        this._show();
      }
    };
    this._btn.addEventListener('click', this._btnClickHandler);

    // Fire initial callbacks so the consumer can apply persisted state
    if (this._hideWhitespace) {
      this._onToggleWhitespace(true);
    }
    if (this._minimizeComments) {
      this._onToggleMinimize(true);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** @returns {boolean} Whether whitespace changes are currently hidden */
  get hideWhitespace() {
    return this._hideWhitespace;
  }

  /** Programmatically set the whitespace toggle (updates UI + storage). */
  set hideWhitespace(value) {
    const bool = Boolean(value);
    if (bool === this._hideWhitespace) return;
    this._hideWhitespace = bool;
    if (this._checkbox) this._checkbox.checked = bool;
    this._persist();
    this._syncButtonActive();
    this._onToggleWhitespace(bool);
  }

  /** @returns {boolean} Whether comments are currently minimized */
  get minimizeComments() {
    return this._minimizeComments;
  }

  /** Programmatically set the minimize toggle (updates UI + storage). */
  set minimizeComments(value) {
    const bool = Boolean(value);
    if (bool === this._minimizeComments) return;
    this._minimizeComments = bool;
    if (this._minimizeCheckbox) this._minimizeCheckbox.checked = bool;
    this._persist();
    this._syncButtonActive();
    this._onToggleMinimize(bool);
  }

  /** Update branch availability (e.g. after base branch is set). */
  set branchAvailable(value) {
    this._branchAvailable = Boolean(value);
    this._updateScopeUI();
  }

  /** Get current scope as {start, end}. */
  get scope() {
    return { start: this._scopeStart, end: this._scopeEnd };
  }

  /** Programmatically set scope. */
  set scope(val) {
    if (!val) return;
    const LS = this._localScope;
    if (LS && !LS.isValidScope(val.start, val.end)) return;
    this._scopeStart = val.start;
    this._scopeEnd = val.end;
    this._updateScopeUI();
  }

  /** Clear the scope status indicator (call after scope change completes). */
  clearScopeStatus() {
    if (this._scopeStatusEl) {
      this._scopeStatusEl.style.display = 'none';
      this._scopeStatusEl.textContent = '';
    }
  }

  /** Remove all DOM elements and event listeners. Safe to call multiple times. */
  destroy() {
    this._hide();
    clearTimeout(this._scopeDebounceTimer);
    if (this._popoverEl) {
      this._popoverEl.remove();
      this._popoverEl = null;
    }
    if (this._btn && this._btnClickHandler) {
      this._btn.removeEventListener('click', this._btnClickHandler);
      this._btnClickHandler = null;
    }
  }

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  _renderPopover() {
    const popover = document.createElement('div');
    popover.className = 'diff-options-popover';
    // Start hidden (opacity 0, shifted up)
    popover.style.opacity = '0';
    popover.style.transform = 'translateY(-4px)';
    popover.style.pointerEvents = 'none';
    popover.style.position = 'fixed';
    popover.style.zIndex = '1100';
    popover.style.transition = 'opacity 0.15s ease, transform 0.15s ease';

    // Scope selector first — only in local mode.
    // Belt-and-suspenders: also render when scope callbacks were explicitly provided,
    // in case a race condition prevents the globals from being set in time.
    const hasLocalScope = (window.PAIR_REVIEW_LOCAL_MODE && window.LocalScope) || this._onScopeChange;
    if (hasLocalScope) {
      this._renderScopeSelector(popover);

      // Divider between scope selector and whitespace checkbox
      const divider = document.createElement('div');
      divider.style.height = '1px';
      divider.style.background = 'var(--color-border-primary, #d0d7de)';
      divider.style.margin = '0 20px';
      popover.appendChild(divider);
    }

    // --- Whitespace checkbox ---
    const wsLabel = this._createCheckboxLabel('Hide whitespace changes', this._hideWhitespace);
    const wsCheckbox = wsLabel.querySelector('input');
    popover.appendChild(wsLabel);

    // --- Minimize comments checkbox ---
    const minLabel = this._createCheckboxLabel('Minimize comments', this._minimizeComments);
    const minCheckbox = minLabel.querySelector('input');
    popover.appendChild(minLabel);

    document.body.appendChild(popover);

    this._popoverEl = popover;
    this._checkbox = wsCheckbox;
    this._minimizeCheckbox = minCheckbox;

    // Respond to checkbox changes
    wsCheckbox.addEventListener('change', () => {
      this._hideWhitespace = wsCheckbox.checked;
      this._persist();
      this._syncButtonActive();
      this._onToggleWhitespace(this._hideWhitespace);
    });

    minCheckbox.addEventListener('change', () => {
      this._minimizeComments = minCheckbox.checked;
      this._persist();
      this._syncButtonActive();
      this._onToggleMinimize(this._minimizeComments);
    });
  }

  /**
   * Create a label element wrapping a checkbox.
   * @param {string} text - Label text
   * @param {boolean} checked - Initial checked state
   * @returns {HTMLLabelElement}
   */
  _createCheckboxLabel(text, checked) {
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '8px';
    label.style.cursor = 'pointer';
    label.style.fontSize = '0.8125rem';
    label.style.whiteSpace = 'nowrap';
    label.style.padding = '8px 12px';
    label.style.userSelect = 'none';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checked;
    checkbox.style.margin = '0';
    checkbox.style.cursor = 'pointer';

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(text));
    return label;
  }

  _renderScopeSelector(popover) {
    const LS = this._localScope;

    // Section container — generous horizontal padding so dots/labels breathe
    const section = document.createElement('div');
    section.style.padding = '8px 20px 12px';
    section.className = 'scope-selector-section';

    // Title row with status indicator
    const titleRow = document.createElement('div');
    titleRow.style.display = 'flex';
    titleRow.style.alignItems = 'center';
    titleRow.style.justifyContent = 'space-between';
    titleRow.style.marginBottom = '10px';

    const title = document.createElement('div');
    title.textContent = 'Diff scope';
    title.style.fontSize = '0.8125rem';
    title.style.fontWeight = '600';
    title.style.color = 'var(--color-text-primary, #24292f)';

    const statusEl = document.createElement('div');
    statusEl.style.fontSize = '11px';
    statusEl.style.color = 'var(--color-text-secondary, #656d76)';
    statusEl.style.display = 'none';
    this._scopeStatusEl = statusEl;

    titleRow.appendChild(title);
    titleRow.appendChild(statusEl);
    section.appendChild(titleRow);

    // Track container
    const trackContainer = document.createElement('div');
    trackContainer.style.position = 'relative';
    trackContainer.style.padding = '0';
    this._numStops = LS.STOPS.length;

    // Track background line — spans between centers of first and last columns.
    // With N equal flex columns each 1/N wide, first center is at 1/(2N) and
    // last center is at 1 - 1/(2N), so the line inset is 100%/(2N) on each side.
    const trackInset = `calc(100% / ${this._numStops * 2})`;
    const trackLine = document.createElement('div');
    trackLine.style.position = 'absolute';
    trackLine.style.top = '6px';
    trackLine.style.left = trackInset;
    trackLine.style.right = trackInset;
    trackLine.style.height = '2px';
    trackLine.style.background = 'var(--color-border-primary, #d0d7de)';
    trackLine.style.borderRadius = '1px';
    trackContainer.appendChild(trackLine);

    // Highlighted range bar — positioned relative to the track line span
    const rangeBar = document.createElement('div');
    rangeBar.style.position = 'absolute';
    rangeBar.style.top = '6px';
    rangeBar.style.height = '2px';
    rangeBar.style.background = 'var(--ai-primary, #8b5cf6)';
    rangeBar.style.borderRadius = '1px';
    rangeBar.style.transition = 'left 0.15s ease, width 0.15s ease';
    trackContainer.appendChild(rangeBar);
    this._rangeBarEl = rangeBar;

    // Stops row — equal-width columns so dots are evenly spaced
    const stopsRow = document.createElement('div');
    stopsRow.style.display = 'flex';
    stopsRow.style.position = 'relative';

    this._scopeStops = [];

    LS.STOPS.forEach((stop, i) => {
      const stopEl = document.createElement('div');
      stopEl.style.display = 'flex';
      stopEl.style.flexDirection = 'column';
      stopEl.style.alignItems = 'center';
      stopEl.style.cursor = 'pointer';
      stopEl.style.userSelect = 'none';
      stopEl.style.flex = '1';
      stopEl.dataset.stop = stop;

      const dot = document.createElement('div');
      dot.style.width = '14px';
      dot.style.height = '14px';
      dot.style.borderRadius = '50%';
      dot.style.border = '2px solid var(--color-border-primary, #d0d7de)';
      dot.style.boxSizing = 'border-box';
      dot.style.background = 'var(--color-bg-primary, #ffffff)';
      dot.style.transition = 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease';
      dot.style.position = 'relative';
      dot.style.zIndex = '1';
      dot.style.marginBottom = '6px';

      const labelEl = document.createElement('div');
      labelEl.textContent = stop.charAt(0).toUpperCase() + stop.slice(1);
      labelEl.style.fontSize = '11px';
      labelEl.style.lineHeight = '1.2';
      labelEl.style.color = 'var(--color-text-secondary, #656d76)';
      labelEl.style.whiteSpace = 'nowrap';
      labelEl.style.transition = 'color 0.15s ease';

      stopEl.appendChild(dot);
      stopEl.appendChild(labelEl);

      // Custom tooltip element (positioned above the dot, hidden by default)
      const tooltipEl = document.createElement('div');
      tooltipEl.style.position = 'absolute';
      tooltipEl.style.bottom = '100%';
      tooltipEl.style.left = '50%';
      tooltipEl.style.transform = 'translateX(-50%)';
      tooltipEl.style.marginBottom = '6px';
      tooltipEl.style.padding = '4px 8px';
      tooltipEl.style.fontSize = '11px';
      tooltipEl.style.lineHeight = '1.3';
      tooltipEl.style.color = 'var(--color-text-on-emphasis, #ffffff)';
      tooltipEl.style.background = 'var(--color-neutral-emphasis, #24292f)';
      tooltipEl.style.borderRadius = '4px';
      tooltipEl.style.whiteSpace = 'nowrap';
      tooltipEl.style.pointerEvents = 'none';
      tooltipEl.style.opacity = '0';
      tooltipEl.style.transition = 'opacity 0.12s ease';
      tooltipEl.style.zIndex = '2';
      stopEl.style.position = 'relative';
      stopEl.appendChild(tooltipEl);

      stopEl.addEventListener('mouseenter', () => {
        if (tooltipEl.textContent) {
          tooltipEl.style.opacity = '1';
        }
      });
      stopEl.addEventListener('mouseleave', () => {
        tooltipEl.style.opacity = '0';
      });

      stopEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this._handleStopClick(stop, e);
      });

      stopsRow.appendChild(stopEl);
      this._scopeStops.push({ stop, dotEl: dot, labelEl, containerEl: stopEl, tooltipEl });
    });

    trackContainer.appendChild(stopsRow);
    section.appendChild(trackContainer);

    this._scopeTrackEl = trackContainer;
    popover.appendChild(section);

    // Initial UI sync
    this._updateScopeUI();
  }

  _handleStopClick(clickedStop, event) {
    const LS = this._localScope;
    if (!LS) return;

    // Branch disabled? Ignore.
    if (clickedStop === 'branch' && !this._branchAvailable) return;

    const stops = LS.STOPS;
    const ci = stops.indexOf(clickedStop);
    const si = stops.indexOf(this._scopeStart);
    const ei = stops.indexOf(this._scopeEnd);

    let newStart = this._scopeStart;
    let newEnd = this._scopeEnd;

    // 'unstaged' is always included — the AI reads files from the working
    // tree, so the diff must always cover at least the unstaged state.
    const ui = stops.indexOf('unstaged');

    // Alt/Option-click: select this stop with minimum scope including unstaged
    if (event && event.altKey) {
      newStart = stops[Math.min(ci, ui)];
      newEnd = stops[Math.max(ci, ui)];
    } else {
      // Checkbox-like toggle with contiguity constraint
      const included = ci >= si && ci <= ei;

      if (included) {
        // Toggling OFF — only allowed at boundaries, and range must have >1 stop
        if (si === ei) return;
        if (clickedStop === 'unstaged') return; // unstaged is mandatory
        if (ci === si) {
          newStart = stops[si + 1];
        } else if (ci === ei) {
          newEnd = stops[ei - 1];
        } else {
          return; // Interior — can't break contiguity
        }
      } else {
        // Toggling ON — only allowed if adjacent to current range
        if (ci === si - 1) {
          newStart = clickedStop;
        } else if (ci === ei + 1) {
          newEnd = clickedStop;
        } else {
          return; // Not adjacent — can't break contiguity
        }
      }
    }

    // If branch not available and start would be branch, clamp
    if (!this._branchAvailable && newStart === 'branch') {
      newStart = 'staged';
    }

    if (!LS.isValidScope(newStart, newEnd)) return;
    if (newStart === this._scopeStart && newEnd === this._scopeEnd) return;

    this._scopeStart = newStart;
    this._scopeEnd = newEnd;
    this._updateScopeUI();

    // Show pending status and debounce the backend call
    this._setScopeStatus('Updating\u2026');

    clearTimeout(this._scopeDebounceTimer);
    this._scopeDebounceTimer = setTimeout(() => {
      this._setScopeStatus('Loading diff\u2026');
      if (this._onScopeChange) {
        this._onScopeChange(this._scopeStart, this._scopeEnd);
      }
    }, 600);
  }

  _setScopeStatus(text) {
    if (!this._scopeStatusEl) return;
    this._scopeStatusEl.textContent = text;
    this._scopeStatusEl.style.display = text ? 'block' : 'none';
  }

  _updateScopeUI() {
    const LS = this._localScope;
    if (!LS || !this._scopeStops.length) return;

    const stops = LS.STOPS;
    const si = stops.indexOf(this._scopeStart);
    const ei = stops.indexOf(this._scopeEnd);

    this._scopeStops.forEach(({ stop, dotEl, labelEl, containerEl, tooltipEl }, i) => {
      const included = LS.scopeIncludes(this._scopeStart, this._scopeEnd, stop);
      const isBranch = stop === 'branch';
      const disabled = isBranch && !this._branchAvailable;

      // Determine if clicking this stop would do anything (for cursor hint).
      // 'unstaged' is mandatory and cannot be toggled off, so it is never a
      // clickable boundary even when it sits at a range edge.
      const isMandatory = stop === 'unstaged';
      const atRangeEdge = included && (i === si || i === ei) && si !== ei;
      const isBoundary = atRangeEdge && !isMandatory;
      const isAdjacent = !included && (i === si - 1 || i === ei + 1);
      const clickable = !disabled && (isBoundary || isAdjacent);

      // Tooltip for disabled branch stop
      containerEl.title = disabled ? 'No feature branch detected' : '';

      // Mandatory stop sitting at a range edge — user might expect to toggle
      // it off but can't.  Show not-allowed cursor and explanatory tooltip.
      const mandatoryEdge = isMandatory && atRangeEdge;

      // Update tooltip text (empty string hides the tooltip on hover)
      if (tooltipEl) {
        tooltipEl.textContent = mandatoryEdge
          ? 'Unstaged changes are always included \u2014 the agent reads from your working tree'
          : '';
      }

      if (disabled) {
        // Disabled state
        dotEl.style.background = 'var(--color-bg-tertiary, #f6f8fa)';
        dotEl.style.borderColor = 'var(--color-border-secondary, #e1e4e8)';
        dotEl.style.boxShadow = 'none';
        labelEl.style.color = 'var(--color-text-tertiary, #8b949e)';
        containerEl.style.cursor = 'default';
        containerEl.style.opacity = '0.5';
      } else if (included) {
        // Included (filled) state
        dotEl.style.background = 'var(--ai-primary, #8b5cf6)';
        dotEl.style.borderColor = 'var(--ai-primary, #8b5cf6)';
        dotEl.style.boxShadow = '0 0 0 2px rgba(139, 92, 246, 0.2)';
        labelEl.style.color = 'var(--color-text-primary, #24292f)';
        labelEl.style.fontWeight = '600';
        containerEl.style.cursor = clickable ? 'pointer' : (mandatoryEdge ? 'not-allowed' : 'default');
        containerEl.style.opacity = '1';
      } else {
        // Excluded (empty) state
        dotEl.style.background = 'var(--color-bg-primary, #ffffff)';
        dotEl.style.borderColor = 'var(--color-border-primary, #d0d7de)';
        dotEl.style.boxShadow = 'none';
        labelEl.style.color = 'var(--color-text-secondary, #656d76)';
        labelEl.style.fontWeight = 'normal';
        containerEl.style.cursor = clickable ? 'pointer' : 'default';
        containerEl.style.opacity = clickable ? '1' : '0.6';
      }
    });

    // Update range bar position.
    // With N equal flex columns, center of column i = (2*i + 1) / (2*N).
    // Range bar spans from center of start column to center of end column.
    if (this._rangeBarEl && this._scopeStops.length >= 2) {
      const N = stops.length;
      const startCenter = (2 * si + 1) / (2 * N);
      const endCenter = (2 * ei + 1) / (2 * N);
      this._rangeBarEl.style.left = `calc(100% * ${startCenter})`;
      this._rangeBarEl.style.width = `calc(100% * ${endCenter - startCenter})`;
    }
  }

  // ---------------------------------------------------------------------------
  // Show / Hide (mirrors PanelGroup pattern)
  // ---------------------------------------------------------------------------

  _show() {
    if (!this._popoverEl || !this._btn) return;

    // Position below the button
    const rect = this._btn.getBoundingClientRect();
    this._popoverEl.style.top = `${rect.bottom + 4}px`;
    this._popoverEl.style.left = `${rect.left + rect.width / 2}px`;
    this._popoverEl.style.transform = 'translateX(-50%) translateY(-4px)';

    // Make visible
    this._popoverEl.style.opacity = '1';
    this._popoverEl.style.pointerEvents = 'auto';
    this._visible = true;

    // Animate into final position
    requestAnimationFrame(() => {
      if (this._popoverEl) {
        this._popoverEl.style.transform = 'translateX(-50%) translateY(0)';
      }
    });

    // Click-outside-to-close
    this._outsideClickHandler = (e) => {
      if (!this._popoverEl.contains(e.target) && !this._btn.contains(e.target)) {
        this._hide();
      }
    };
    document.addEventListener('click', this._outsideClickHandler, true);

    // Escape to dismiss
    this._escapeHandler = (e) => {
      if (e.key === 'Escape') {
        this._hide();
      }
    };
    document.addEventListener('keydown', this._escapeHandler, true);
  }

  _hide() {
    if (!this._popoverEl) return;

    this._popoverEl.style.opacity = '0';
    this._popoverEl.style.transform = 'translateX(-50%) translateY(-4px)';
    this._popoverEl.style.pointerEvents = 'none';
    this._visible = false;

    if (this._outsideClickHandler) {
      document.removeEventListener('click', this._outsideClickHandler, true);
      this._outsideClickHandler = null;
    }
    if (this._escapeHandler) {
      document.removeEventListener('keydown', this._escapeHandler, true);
      this._escapeHandler = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _persist() {
    localStorage.setItem(STORAGE_KEY, String(this._hideWhitespace));
    localStorage.setItem(MINIMIZE_STORAGE_KEY, String(this._minimizeComments));
  }

  /** Add/remove `.active` on the gear button as a visual cue that filtering is on. */
  _syncButtonActive() {
    if (!this._btn) return;
    this._btn.classList.toggle('active', this._hideWhitespace || this._minimizeComments);
  }
}

window.DiffOptionsDropdown = DiffOptionsDropdown;
