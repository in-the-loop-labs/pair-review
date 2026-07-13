// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * CommentMinimizer - Manages "minimize comments" mode for the diff view.
 *
 * When active, all inline comment cards (.user-comment-row), AI suggestion
 * cards (.ai-suggestion) and external review threads (.external-comment-row)
 * anchored to diff lines are hidden via CSS. A single small clickable
 * indicator is injected for each diff line that has hidden cards, showing a
 * person icon (user comments), AI-comment icon (adopted suggestions),
 * sparkles icon (AI suggestions) or chat-bubble icon (external comments),
 * with a count badge when a line holds more than one card.
 *
 * File-level comments (.file-comment-card inside .file-comments-zone) are also
 * hidden, with an indicator button injected into the file header bar.
 *
 * Clicking an indicator toggles visibility of that line's or file's cards.
 *
 * ── @pierre/diffs rendering ──────────────────────────────────────────────
 * Diff lines are shadow-DOM elements owned by the vendor renderer; annotation
 * cards live in the LIGHT DOM, each wrapped by the vendor in a
 * `<div data-annotation-slot slot="annotation-{side}-{lineNumber}">` that is a
 * child of the file's `<diffs-container>` host and projected into the matching
 * shadow annotation cell. All cards anchored to the same line+side share the
 * same `slot` value, so we group by `{fileName}\0{slot}` — a STABLE string key
 * that survives the vendor's card-recreating rerenders (element identity does
 * NOT survive them). The line-level indicator is injected into the first
 * wrapper of each group (light DOM, so page CSS reaches it).
 */

class CommentMinimizer {
  /** Person icon SVG (matches comment-manager.js octicon-person) */
  static PERSON_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/></svg>`;

  /** Sparkles icon SVG (matches AI suggestion badge) */
  static SPARKLES_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M9.6 2.279a.426.426 0 0 1 .8 0l.407 1.112a6.386 6.386 0 0 0 3.802 3.802l1.112.407a.426.426 0 0 1 0 .8l-1.112.407a6.386 6.386 0 0 0-3.802 3.802l-.407 1.112a.426.426 0 0 1-.8 0l-.407-1.112a6.386 6.386 0 0 0-3.802-3.802L4.279 8.4a.426.426 0 0 1 0-.8l1.112-.407a6.386 6.386 0 0 0 3.802-3.802L9.6 2.279Zm-4.267 8.837a.178.178 0 0 1 .334 0l.169.464a2.662 2.662 0 0 0 1.584 1.584l.464.169a.178.178 0 0 1 0 .334l-.464.169a2.662 2.662 0 0 0-1.584 1.584l-.169.464a.178.178 0 0 1-.334 0l-.169-.464a2.662 2.662 0 0 0-1.584-1.584l-.464-.169a.178.178 0 0 1 0-.334l.464-.169a2.662 2.662 0 0 0 1.584-1.584l.169-.464ZM2.8.14a.213.213 0 0 1 .4 0l.203.556a3.2 3.2 0 0 0 1.901 1.901l.556.203a.213.213 0 0 1 0 .4l-.556.203a3.2 3.2 0 0 0-1.901 1.901L3.2 5.86a.213.213 0 0 1-.4 0l-.203-.556A3.2 3.2 0 0 0 .696 3.403L.14 3.2a.213.213 0 0 1 0-.4l.556-.203A3.2 3.2 0 0 0 2.597.696L2.8.14Z"/></svg>`;

  /** AI comment icon SVG — speech bubble with sparkles (matches CommentManager.AI_ICON_SVG, different size) */
  static AI_COMMENT_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M7.75 1a.75.75 0 0 1 0 1.5h-5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2c.199 0 .39.079.53.22.141.14.22.331.22.53v2.19l2.72-2.72a.747.747 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-2a.75.75 0 0 1 1.5 0v2c0 .464-.184.909-.513 1.237A1.746 1.746 0 0 1 13.25 12H9.06l-2.573 2.573A1.457 1.457 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5C1 1.784 1.784 1 2.75 1h5Zm4.519-.837a.248.248 0 0 1 .466 0l.238.648a3.726 3.726 0 0 0 2.218 2.219l.649.238a.249.249 0 0 1 0 .467l-.649.238a3.725 3.725 0 0 0-2.218 2.218l-.238.649a.248.248 0 0 1-.466 0l-.239-.649a3.725 3.725 0 0 0-2.218-2.218l-.649-.238a.249.249 0 0 1 0-.467l.649-.238A3.726 3.726 0 0 0 12.03.811l.239-.648Z"/></svg>`;

  /** External comment icon SVG — plain chat bubble (octicon-comment). Matches the chat-comment glyph used elsewhere for external rows. */
  static EXTERNAL_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Z"/></svg>`;

  constructor() {
    this._active = false;
    // Diff lines the user has expanded, keyed by the STABLE string
    // `${fileName}\0${slot}` (see class doc). NOT element references — the
    // vendor recreates annotation wrappers on every rerender.
    this._expandedLines = new Set();
    // Files whose file-level zone has been expanded (Set of zone elements —
    // zones are pr.js light DOM, not vendor-managed, so they persist).
    this._expandedFiles = new Set();
    // MutationObserver that re-injects indicators after vendor rerenders
    // (diffStyle switch, hunk expansion, worker-highlight streaming, lazy file
    // render) that are NOT followed by an explicit refreshIndicators() call.
    this._observer = null;
    this._refreshScheduled = false;
  }

  /** @returns {boolean} Whether minimize mode is active */
  get active() {
    return this._active;
  }

  /**
   * Enable or disable minimize mode.
   * @param {boolean} minimized
   */
  setMinimized(minimized) {
    this._active = minimized;
    this._expandedLines.clear();
    this._expandedFiles.clear();

    const diffContainer = document.getElementById('diff-container');
    if (!diffContainer) return;

    if (minimized) {
      diffContainer.classList.add('comments-minimized');
      this.refreshIndicators();
      this._startObserving();
    } else {
      this._stopObserving();
      diffContainer.classList.remove('comments-minimized');
      this._removeAllIndicators();
      // Remove any per-line expansion overrides
      document.querySelectorAll('.comment-expanded').forEach(el => el.classList.remove('comment-expanded'));
      // Remove any per-file expansion overrides
      document.querySelectorAll('.file-comments-expanded').forEach(el => el.classList.remove('file-comments-expanded'));
    }
  }

  /**
   * Rebuild all indicator buttons on diff lines and file headers.
   * Call this after comments or suggestions are added/removed/re-rendered.
   * Idempotent: starts by removing every existing indicator.
   */
  refreshIndicators() {
    if (!this._active) return;

    // The vendor recreates annotation wrappers as we inject indicators; pause
    // the observer so our own DOM writes don't re-trigger a refresh loop.
    this._stopObserving();
    try {
      this._removeAllIndicators();

      // Line-level: group the vendor annotation wrappers by file + slot.
      for (const group of this._buildLineGroups().values()) {
        this._injectLineIndicator(group);
      }

      // File-level indicators (pr.js light DOM — unchanged path).
      this._refreshFileIndicators();
    } finally {
      if (this._active) this._startObserving();
    }
  }

  /**
   * Build a map of line-level groups keyed by `${fileName}\0${slot}`.
   * Each group aggregates the hidden cards anchored to one line+side and keeps
   * references to their vendor wrappers (`[data-annotation-slot]`).
   * @returns {Map<string, {key: string, wrappers: HTMLElement[], info: Object}>}
   * @private
   */
  _buildLineGroups() {
    const groups = new Map();
    const newEntry = () => ({
      hasUser: false, hasAI: false, hasAdopted: false, hasExternal: false,
      userCount: 0, aiCount: 0, adoptedCount: 0, externalCount: 0
    });

    const wrappers = document.querySelectorAll('#diff-container [data-annotation-slot]');
    for (const wrapper of wrappers) {
      const card = this._cardOf(wrapper);
      if (!card) continue;

      const isComment = card.classList.contains('user-comment-row');
      const isSuggestion = card.classList.contains('ai-suggestion');
      const isExternal = card.classList.contains('external-comment-row');
      // Skip comment forms, tour stops, hunk summaries — those stay visible.
      if (!isComment && !isSuggestion && !isExternal) continue;

      const key = this._lineKeyFor(wrapper);
      if (!key) continue;

      let group = groups.get(key);
      if (!group) {
        group = { key, wrappers: [], info: newEntry() };
        groups.set(key, group);
      }
      group.wrappers.push(wrapper);
      const info = group.info;

      if (isComment) {
        // Adopted AI suggestions render with an inner `.adopted-comment` card.
        if (card.querySelector('.adopted-comment')) {
          info.hasAdopted = true;
          info.adoptedCount++;
        } else {
          info.hasUser = true;
          info.userCount++;
        }
      } else if (isSuggestion) {
        // A suggestion hidden for adoption is already represented by its
        // adopted comment card — don't double-count it. The flag is a string:
        // 'true' when adopted, and suggestion-ui.js writes the literal 'false'
        // on runtime restore, so compare against 'true' (not truthiness) or a
        // restored suggestion would be wrongly dropped from the count.
        if (card.dataset?.hiddenForAdoption !== 'true') {
          info.hasAI = true;
          info.aiCount++;
        }
      } else {
        // External thread: count root + replies so the badge matches the
        // total the thread card itself shows.
        const bubbles = card.querySelectorAll('.external-comment');
        info.hasExternal = true;
        info.externalCount += (bubbles.length || 1);
      }
    }

    return groups;
  }

  /**
   * The annotation card element inside a vendor `[data-annotation-slot]`
   * wrapper (the element returned by PierreBridge's renderAnnotation).
   * @param {HTMLElement} wrapper
   * @returns {HTMLElement|null}
   * @private
   */
  _cardOf(wrapper) {
    return wrapper.firstElementChild || null;
  }

  /**
   * Stable grouping key for a vendor annotation wrapper: the owning file plus
   * the vendor slot name (`annotation-{side}-{lineNumber}`). Wrappers on the
   * same line+side share a slot, so they share a key.
   * @param {HTMLElement} wrapper
   * @returns {string|null}
   * @private
   */
  _lineKeyFor(wrapper) {
    const slot = wrapper.getAttribute('slot');
    if (!slot) return null;
    const fileWrapper = wrapper.closest('.d2h-file-wrapper');
    const file = fileWrapper?.dataset?.fileName || '';
    return `${file}\0${slot}`;
  }

  /**
   * All vendor annotation wrappers that share a group key (a line+side).
   * @param {string} key
   * @returns {HTMLElement[]}
   * @private
   */
  _wrappersForKey(key) {
    const out = [];
    for (const wrapper of document.querySelectorAll('#diff-container [data-annotation-slot]')) {
      if (this._lineKeyFor(wrapper) === key) out.push(wrapper);
    }
    return out;
  }

  /**
   * Inject a single indicator button for a line group into the first wrapper,
   * and sync the group's expanded/collapsed card visibility.
   * @param {{key: string, wrappers: HTMLElement[], info: Object}} group
   * @private
   */
  _injectLineIndicator(group) {
    const first = group.wrappers[0];
    if (!first) return;

    // Nothing to represent — e.g. the line's only card is a suggestion hidden
    // for adoption (represented by its adopted comment elsewhere). Injecting
    // here would produce an empty button with no icon, count, or title.
    const info = group.info;
    const total = info.userCount + info.adoptedCount + info.aiCount + info.externalCount;
    if (total === 0) return;

    // Sync card visibility to the persisted expanded state (survives rerenders
    // because the state is keyed by the stable group key).
    const expanded = this._expandedLines.has(group.key);
    this._applyExpanded(group.wrappers, expanded);

    // Don't double-inject.
    if (first.querySelector(':scope > .comment-indicator')) return;

    const btn = document.createElement('button');
    btn.className = 'comment-indicator';
    btn.type = 'button';

    // Build icon content — four types:
    //   person (purple)     = user-originated comments
    //   ai-comment (purple) = adopted AI suggestions
    //   sparkles (amber)    = AI suggestions
    //   chat bubble (blue)  = external review comments (e.g. GitHub)
    const icons = [];
    if (info.hasUser) {
      icons.push(`<span class="indicator-icon indicator-user" title="${info.userCount} comment${info.userCount !== 1 ? 's' : ''}">${CommentMinimizer.PERSON_ICON}</span>`);
    }
    if (info.hasAdopted) {
      icons.push(`<span class="indicator-icon indicator-adopted" title="${info.adoptedCount} adopted comment${info.adoptedCount !== 1 ? 's' : ''}">${CommentMinimizer.AI_COMMENT_ICON}</span>`);
    }
    if (info.hasAI) {
      icons.push(`<span class="indicator-icon indicator-ai" title="${info.aiCount} suggestion${info.aiCount !== 1 ? 's' : ''}">${CommentMinimizer.SPARKLES_ICON}</span>`);
    }
    if (info.hasExternal) {
      icons.push(`<span class="indicator-icon indicator-external" title="${info.externalCount} external comment${info.externalCount !== 1 ? 's' : ''}">${CommentMinimizer.EXTERNAL_ICON}</span>`);
    }

    const countBadge = total > 1 ? `<span class="indicator-count">${total}</span>` : '';

    btn.innerHTML = icons.join('') + countBadge;

    const totalLabel = [];
    if (info.userCount) totalLabel.push(`${info.userCount} comment${info.userCount !== 1 ? 's' : ''}`);
    if (info.adoptedCount) totalLabel.push(`${info.adoptedCount} adopted comment${info.adoptedCount !== 1 ? 's' : ''}`);
    if (info.aiCount) totalLabel.push(`${info.aiCount} suggestion${info.aiCount !== 1 ? 's' : ''}`);
    if (info.externalCount) totalLabel.push(`${info.externalCount} external comment${info.externalCount !== 1 ? 's' : ''}`);
    btn.title = totalLabel.join(', ');

    if (expanded) {
      btn.classList.add('expanded');
    }

    // Click handler toggles this line's cards. Closes over the current
    // wrappers; a rerender replaces both wrappers and handler together.
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this._toggleLineComments(group.key, btn);
    });

    first.appendChild(btn);
  }

  /**
   * Show or hide the cards of a line group by toggling `.comment-expanded` on
   * each wrapper's card element.
   * @param {HTMLElement[]} wrappers
   * @param {boolean} expanded
   * @private
   */
  _applyExpanded(wrappers, expanded) {
    for (const wrapper of wrappers) {
      const card = this._cardOf(wrapper);
      if (card) card.classList.toggle('comment-expanded', expanded);
    }
  }

  /**
   * Toggle visibility of the cards for one line group.
   * @param {string} key - The stable group key
   * @param {HTMLElement} btn - The indicator button
   * @private
   */
  _toggleLineComments(key, btn) {
    const wrappers = this._wrappersForKey(key);
    if (this._expandedLines.has(key)) {
      this._expandedLines.delete(key);
      btn.classList.remove('expanded');
      this._applyExpanded(wrappers, false);
    } else {
      this._expandedLines.add(key);
      btn.classList.add('expanded');
      this._applyExpanded(wrappers, true);
    }
  }

  /**
   * Find the vendor annotation wrapper (`[data-annotation-slot]`) that holds a
   * given card element. Used by navigation callers as a stable scroll anchor;
   * returns null for elements not slotted onto a diff line (callers fall back
   * to the element itself).
   * @param {HTMLElement} element - A card element (or a child of one)
   * @returns {HTMLElement|null}
   */
  findDiffRowFor(element) {
    return element?.closest?.('[data-annotation-slot]') || null;
  }

  // TODO: expose via API route so chat can programmatically expand findings when discussing them
  /**
   * Expand the comments for a given element so it becomes visible when
   * minimized. Call this before scrolling to a card that may be hidden.
   * @param {HTMLElement} element - The target card element (or a child of one)
   */
  expandForElement(element) {
    if (!this._active || !element) return;

    // File-level comment inside a file-comments-zone.
    const zone = element.closest('.file-comments-zone');
    if (zone) {
      if (this._expandedFiles.has(zone)) return; // already expanded
      this._expandedFiles.add(zone);
      zone.classList.add('file-comments-expanded');
      const wrapper = zone.closest('.d2h-file-wrapper');
      const btn = wrapper?.querySelector('.d2h-file-header .file-comment-indicator');
      if (btn) {
        btn.classList.add('expanded');
      }
      return;
    }

    // Line-level: resolve the containing vendor annotation wrapper.
    const annotationWrapper = element.closest('[data-annotation-slot]');
    if (!annotationWrapper) return;
    const key = this._lineKeyFor(annotationWrapper);
    if (!key) return;

    this._expandedLines.add(key);
    const wrappers = this._wrappersForKey(key);
    this._applyExpanded(wrappers, true);

    // Mark the indicator (injected into the group's first wrapper) as expanded.
    const btn = wrappers[0]?.querySelector(':scope > .comment-indicator');
    if (btn) {
      btn.classList.add('expanded');
    }
  }

  // ---------------------------------------------------------------------------
  // File-level comment indicators
  // ---------------------------------------------------------------------------

  /**
   * Scan all file-comments-zones and inject indicator buttons into file headers.
   */
  _refreshFileIndicators() {
    const zones = document.querySelectorAll('.file-comments-zone');
    for (const zone of zones) {
      const cards = zone.querySelectorAll('.file-comment-card');
      if (cards.length === 0) continue;

      // Count comment types
      const info = { hasUser: false, hasAI: false, hasAdopted: false, userCount: 0, aiCount: 0, adoptedCount: 0 };
      for (const card of cards) {
        // Skip collapsed cards (adopted/dismissed originals remain in DOM)
        if (card.classList.contains('collapsed')) continue;

        if (card.classList.contains('ai-suggestion')) {
          info.hasAI = true;
          info.aiCount++;
        } else if (card.classList.contains('user-comment')) {
          if (card.classList.contains('adopted-comment')) {
            info.hasAdopted = true;
            info.adoptedCount++;
          } else {
            info.hasUser = true;
            info.userCount++;
          }
        }
      }

      if (info.userCount + info.aiCount + info.adoptedCount === 0) continue;

      // Find the file header — zone and header are siblings inside .d2h-file-wrapper
      const wrapper = zone.closest('.d2h-file-wrapper');
      const header = wrapper?.querySelector('.d2h-file-header');
      if (!header) continue;

      this._injectFileIndicator(header, zone, info);
    }
  }

  /**
   * Inject an indicator button into a file header, positioned before the comment button.
   * @param {HTMLElement} header - The .d2h-file-header element
   * @param {HTMLElement} zone - The .file-comments-zone element
   * @param {Object} info - { hasUser, hasAI, hasAdopted, userCount, aiCount, adoptedCount }
   */
  _injectFileIndicator(header, zone, info) {
    // Don't double-inject
    if (header.querySelector('.file-comment-indicator')) return;

    const btn = document.createElement('button');
    btn.className = 'file-comment-indicator';
    btn.type = 'button';

    // Build icon — pick the dominant type icon
    const icons = [];
    if (info.hasUser) {
      icons.push(`<span class="indicator-icon indicator-user">${CommentMinimizer.PERSON_ICON}</span>`);
    }
    if (info.hasAdopted) {
      icons.push(`<span class="indicator-icon indicator-adopted">${CommentMinimizer.AI_COMMENT_ICON}</span>`);
    }
    if (info.hasAI) {
      icons.push(`<span class="indicator-icon indicator-ai">${CommentMinimizer.SPARKLES_ICON}</span>`);
    }

    const total = info.userCount + info.adoptedCount + info.aiCount;
    const countBadge = total > 1 ? `<span class="indicator-count">${total}</span>` : '';

    btn.innerHTML = icons.join('') + countBadge;

    const totalLabel = [];
    if (info.userCount) totalLabel.push(`${info.userCount} file comment${info.userCount !== 1 ? 's' : ''}`);
    if (info.adoptedCount) totalLabel.push(`${info.adoptedCount} adopted`);
    if (info.aiCount) totalLabel.push(`${info.aiCount} suggestion${info.aiCount !== 1 ? 's' : ''}`);
    btn.title = totalLabel.join(', ');

    // Restore expanded state
    if (this._expandedFiles.has(zone)) {
      btn.classList.add('expanded');
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this._toggleFileComments(zone, btn);
    });

    // Insert before the file-header-comment-btn if present, otherwise append
    const commentBtn = header.querySelector('.file-header-comment-btn');
    if (commentBtn) {
      header.insertBefore(btn, commentBtn);
    } else {
      header.appendChild(btn);
    }
  }

  /**
   * Toggle visibility of file-level comments for a specific file.
   * @param {HTMLElement} zone - The .file-comments-zone element
   * @param {HTMLElement} btn - The indicator button
   */
  _toggleFileComments(zone, btn) {
    const isExpanded = this._expandedFiles.has(zone);

    if (isExpanded) {
      this._expandedFiles.delete(zone);
      btn.classList.remove('expanded');
      zone.classList.remove('file-comments-expanded');
    } else {
      this._expandedFiles.add(zone);
      btn.classList.add('expanded');
      zone.classList.add('file-comments-expanded');
    }
  }

  /** Remove all indicator buttons (both line-level and file-level) from the DOM. */
  _removeAllIndicators() {
    document.querySelectorAll('.comment-indicator').forEach(btn => btn.remove());
    document.querySelectorAll('.file-comment-indicator').forEach(btn => btn.remove());
  }

  // ---------------------------------------------------------------------------
  // Rerender resilience
  // ---------------------------------------------------------------------------

  /**
   * Observe the diff container for the vendor's card-recreating rerenders and
   * re-inject indicators. Debounced via rAF and idempotent (refreshIndicators
   * clears first). Paused during our own refresh so injecting indicators does
   * not loop. No-op without a DOM (tests may run headless without MutationObserver).
   * @private
   */
  _startObserving() {
    if (this._observer || typeof MutationObserver === 'undefined') return;
    const container = document.getElementById('diff-container');
    if (!container) return;
    this._observer = new MutationObserver(() => this._onDomMutation());
    this._observer.observe(container, { childList: true, subtree: true });
  }

  /** Stop observing the diff container. @private */
  _stopObserving() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
  }

  /** Debounced reaction to diff-container mutations. @private */
  _onDomMutation() {
    if (!this._active || this._refreshScheduled) return;
    this._refreshScheduled = true;
    const raf = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    raf(() => {
      this._refreshScheduled = false;
      if (this._active) this.refreshIndicators();
    });
  }
}

window.CommentMinimizer = CommentMinimizer;

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CommentMinimizer };
}
