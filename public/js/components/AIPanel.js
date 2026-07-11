// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * AIPanel.js - AI Analysis Panel Component
 * Manages the right sidebar panel that displays AI analysis findings
 * with level filtering and navigation.
 */

class AIPanel {
    // Icon SVG constants for reuse
    static ICONS = {
        adopt: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path fill-rule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"></path>
        </svg>`,
        dismiss: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path fill-rule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"></path>
        </svg>`,
        restore: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M1.705 8.005a.75.75 0 01.834.656 5.5 5.5 0 009.592 2.97l-1.204-1.204a.25.25 0 01.177-.427h3.646a.25.25 0 01.25.25v3.646a.25.25 0 01-.427.177l-1.38-1.38A7.002 7.002 0 011.05 8.84a.75.75 0 01.656-.834zM8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25a.25.25 0 01-.25-.25V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0114.95 7.16a.75.75 0 11-1.49.178A5.5 5.5 0 008 2.5z"></path>
        </svg>`,
        filter: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M.75 3h14.5a.75.75 0 010 1.5H.75a.75.75 0 010-1.5zM3 7.75A.75.75 0 013.75 7h8.5a.75.75 0 010 1.5h-8.5A.75.75 0 013 7.75zm3 4a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75z"></path>
        </svg>`,
        eye: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"></path>
        </svg>`,
        eyeClosed: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M.143 2.31a.75.75 0 0 1 1.047-.167l14.5 10.5a.75.75 0 1 1-.88 1.214l-2.248-1.628C11.346 13.19 9.792 14 8 14c-1.981 0-3.67-.992-4.933-2.078C1.797 10.832.88 9.577.43 8.9a1.619 1.619 0 0 1 0-1.797c.353-.533.995-1.42 1.868-2.305L.31 3.357A.75.75 0 0 1 .143 2.31Zm1.536 5.622A.12.12 0 0 0 1.657 8c0 .021.006.045.022.068.412.621 1.242 1.75 2.366 2.717C5.175 11.758 6.527 12.5 8 12.5c1.195 0 2.31-.488 3.29-1.191L9.063 9.695A2 2 0 0 1 6.058 7.52L3.529 5.688a14.207 14.207 0 0 0-1.85 2.244ZM8 3.5c-.516 0-1.017.09-1.499.251a.75.75 0 1 1-.473-1.423A6.207 6.207 0 0 1 8 2c1.981 0 3.67.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.11.166-.248.365-.41.587a.75.75 0 1 1-1.21-.887c.148-.201.272-.382.371-.53a.119.119 0 0 0 0-.137c-.412-.621-1.242-1.75-2.366-2.717C10.825 4.242 9.473 3.5 8 3.5Z"></path>
        </svg>`
    };

    constructor() {
        this.panel = document.getElementById('ai-panel');
        // Check actual DOM state for collapsed status
        this.isCollapsed = this.panel?.classList.contains('collapsed') ?? false;
        this.findings = [];
        this.comments = [];
        this.externalThreads = [];
        this.selectedLevel = 'final';
        this.selectedSegment = 'ai'; // Default to AI segment until PR loads
        this.currentIndex = -1; // Current navigation index
        this.currentPRKey = null; // PR-specific key for localStorage
        this.analysisState = 'unknown'; // 'unknown' | 'loading' | 'complete' | 'none'

        // Track selected item by stable identifier for restoration
        this.selectedItemKey = null; // Format: "file:lineNumber:itemType:identity"

        // Monotonic token so a fast move between items that supersedes an
        // in-flight scrollTo* can tell the older call to bail after its await.
        this._navGen = 0;

        // Canonical file order for consistent sorting across components
        this.fileOrder = new Map(); // Map of file path -> index

        // Filter toggle state for showing dismissed comments (default: hidden)
        this.showDismissedComments = false;

        this.initElements();
        this.bindEvents();
        this.setupKeyboardNavigation();
        this.setupSegmentOverflow();
        // Hide the External segment when:
        //   1. Local mode — no external source exists for local reviews.
        //   2. The `external_comments` feature toggle is off in config.
        // Both are synchronous flags (set before this constructor runs) so
        // the segment never flashes into view when it shouldn't.
        if (typeof window !== 'undefined') {
            const localMode = window.PAIR_REVIEW_LOCAL_MODE;
            const externalDisabled = window.PAIR_REVIEW_RUNTIME_CONFIG?.external_comments_enabled === false;
            if (localMode || externalDisabled) {
                this.segmentExternalBtn?.setAttribute('hidden', '');
            }
        }
        // Don't restore segment on init - wait for setPR() call

        // Set CSS variable immediately based on collapsed state to prevent flicker
        if (this.isCollapsed) {
            document.documentElement.style.setProperty('--ai-panel-width', '0px');
        } else {
            document.documentElement.style.setProperty('--ai-panel-width', `${this.getEffectivePanelWidth()}px`);
        }
    }

    /**
     * Get the effective panel width from saved preferences or defaults
     * @returns {number} Width in pixels
     */
    getEffectivePanelWidth() {
        return window.PanelResizer?.getSavedWidth('ai-panel')
            || window.PanelResizer?.getDefaultWidth('ai-panel')
            || 320;
    }

    initElements() {
        // Panel elements
        this.closeBtn = document.getElementById('ai-panel-close');
        this.toggleBtn = document.getElementById('ai-panel-toggle');
        this.summaryBtn = document.getElementById('ai-summary-btn');

        // Segment control
        this.segmentControl = document.getElementById('segment-control');
        this.segmentControlScroll = document.getElementById('segment-control-scroll');
        this.segmentBtns = this.segmentControl?.querySelectorAll('.segment-btn');
        this.segmentScrollLeft = document.getElementById('segment-scroll-left');
        this.segmentScrollRight = document.getElementById('segment-scroll-right');
        this.segmentExternalBtn = this.segmentControl?.querySelector('.segment-btn[data-segment="external"]');

        // Create filter toggle button (will be inserted after segment control)
        this.filterToggleBtn = null; // Created dynamically in createFilterToggle()

        // Level filter
        this.levelFilter = document.getElementById('level-filter');
        this.levelPills = this.levelFilter?.querySelectorAll('.level-pill');

        // Findings
        this.findingsCount = document.getElementById('findings-count');
        this.findingsList = document.getElementById('findings-list');

        // AI Summary data
        this.summaryData = null;

        // Create filter toggle if segment control exists
        if (this.segmentControl) {
            this.createFilterToggle();
        }
    }

    /**
     * Create the filter toggle button for showing dismissed comments
     */
    createFilterToggle() {
        // Create filter toggle button
        this.filterToggleBtn = document.createElement('button');
        this.filterToggleBtn.className = 'filter-toggle-btn';

        // Apply restored state from constructor
        // Use eye icon when dismissed comments are visible, eye-closed when hidden
        if (this.showDismissedComments) {
            this.filterToggleBtn.classList.add('active');
            this.filterToggleBtn.title = 'Hide dismissed user comments';
            this.filterToggleBtn.innerHTML = AIPanel.ICONS.eye;
        } else {
            this.filterToggleBtn.title = 'Show dismissed user comments';
            this.filterToggleBtn.innerHTML = AIPanel.ICONS.eyeClosed;
        }
        this.filterToggleBtn.setAttribute('aria-label', this.filterToggleBtn.title);

        // Insert as the LAST child of segment-control so it sits at the
        // right edge of the row, after the segment buttons and the right
        // overflow chevron. Previous versions used insertBefore relative
        // to .segment-control-inner — that breaks now that the inner row
        // is nested inside a scroll wrapper. Append-to-end is correct for
        // both old and new structures and avoids the cross-parent
        // insertBefore footgun.
        if (this.segmentControl) {
            this.segmentControl.appendChild(this.filterToggleBtn);
        }

        // Button is always visible - no conditional hiding to prevent layout shift
    }

    bindEvents() {
        // Panel toggle
        if (this.closeBtn) {
            this.closeBtn.addEventListener('click', () => this.collapse());
        }

        if (this.toggleBtn) {
            this.toggleBtn.addEventListener('click', () => this.toggle());
        }

        // AI Summary button
        if (this.summaryBtn) {
            this.summaryBtn.addEventListener('click', () => this.showSummaryModal());
        }

        // Segment control buttons
        if (this.segmentBtns) {
            this.segmentBtns.forEach(btn => {
                btn.addEventListener('click', () => this.onSegmentSelect(btn));
            });
        }

        // Level filter pills
        if (this.levelPills) {
            this.levelPills.forEach(pill => {
                pill.addEventListener('click', () => this.onLevelSelect(pill));
            });
        }

        // Filter toggle button
        if (this.filterToggleBtn) {
            this.filterToggleBtn.addEventListener('click', () => this.onFilterToggle());
        }

        // Segment overflow scroll chevrons
        if (this.segmentScrollLeft) {
            this.segmentScrollLeft.addEventListener('click', () => this.scrollSegmentRow(-1));
        }
        if (this.segmentScrollRight) {
            this.segmentScrollRight.addEventListener('click', () => this.scrollSegmentRow(1));
        }
    }

    /**
     * Handle filter toggle button click
     */
    onFilterToggle() {
        this.showDismissedComments = !this.showDismissedComments;

        // Update button visual state
        this.updateFilterToggleVisual();

        // Persist to localStorage (per-review)
        this.saveFilterState();

        // Dispatch event for prManager to reload comments with new filter
        const event = new CustomEvent('filterDismissedChanged', {
            detail: { showDismissed: this.showDismissedComments }
        });
        document.dispatchEvent(event);
    }

    /**
     * Update the filter toggle button visual state
     */
    updateFilterToggleVisual() {
        if (this.filterToggleBtn) {
            this.filterToggleBtn.classList.toggle('active', this.showDismissedComments);
            // Use eye icon when dismissed comments are visible, eye-closed when hidden
            if (this.showDismissedComments) {
                this.filterToggleBtn.title = 'Hide dismissed user comments';
                this.filterToggleBtn.innerHTML = AIPanel.ICONS.eye;
            } else {
                this.filterToggleBtn.title = 'Show dismissed user comments';
                this.filterToggleBtn.innerHTML = AIPanel.ICONS.eyeClosed;
            }
            this.filterToggleBtn.setAttribute('aria-label', this.filterToggleBtn.title);
        }
    }

    /**
     * Get the localStorage key for the collapsed state (per-review)
     * @returns {string|null} Storage key or null if no PR context
     */
    _getCollapsedStorageKey() {
        if (!this.currentPRKey) return null;
        return `pair-review-panel-collapsed_${this.currentPRKey}`;
    }

    /**
     * Save the collapsed state to localStorage (per-review)
     */
    _saveCollapsedState() {
        const key = this._getCollapsedStorageKey();
        if (key) {
            localStorage.setItem(key, this.isCollapsed ? 'true' : 'false');
        }
    }

    /**
     * Restore the collapsed state from localStorage, or collapse for new reviews.
     * If the user had the panel expanded for this review, expand it.
     * Otherwise (new review or previously collapsed), collapse it.
     */
    _restoreOrCollapsePanel() {
        const key = this._getCollapsedStorageKey();
        if (key) {
            const stored = localStorage.getItem(key);
            if (stored === 'false') {
                this.expand();
            } else {
                // 'true' or no saved state (new review) → collapse
                this.collapse();
            }
        } else {
            this.collapse();
        }
    }

    /**
     * Get the localStorage key for the filter state (per-review)
     * @returns {string|null} Storage key or null if no PR context
     */
    getFilterStorageKey() {
        if (!this.currentPRKey) return null;
        return `pair-review-show-dismissed_${this.currentPRKey}`;
    }

    /**
     * Save the filter state to localStorage (per-review)
     */
    saveFilterState() {
        const key = this.getFilterStorageKey();
        if (key) {
            localStorage.setItem(key, this.showDismissedComments ? 'true' : 'false');
        }
    }

    /**
     * Restore the filter state from localStorage (per-review)
     * Note: This method only updates internal state and button visual.
     * It does NOT dispatch the filterDismissedChanged event because:
     * 1. During initial setup (setPR), loadUserComments is called explicitly by the caller
     *    (pr.js or local.js) with the appropriate filter state.
     * 2. Dispatching here would cause a duplicate loadUserComments call that could
     *    override the filter state with an incorrect value.
     *
     * The event is only dispatched from onFilterToggle() when the user clicks the button.
     */
    restoreFilterState() {
        const key = this.getFilterStorageKey();
        if (key) {
            const stored = localStorage.getItem(key);
            if (stored !== null) {
                this.showDismissedComments = stored === 'true';
            } else {
                // Default to false (hidden) for new reviews
                this.showDismissedComments = false;
            }
        } else {
            this.showDismissedComments = false;
        }

        // Update button visual to match restored state
        this.updateFilterToggleVisual();

        // NOTE: We intentionally do NOT dispatch filterDismissedChanged here.
        // The caller (pr.js or local.js) is responsible for calling loadUserComments
        // with the restored filter state after setPR() completes.
    }

    toggle() {
        if (this.isCollapsed) {
            this.expand();
        } else {
            this.collapse();
        }
    }

    collapse() {
        this.isCollapsed = true;
        if (this.panel) {
            this.panel.classList.add('collapsed');
        }
        // Set CSS variable to 0 so width calculations don't reserve space
        document.documentElement.style.setProperty('--ai-panel-width', '0px');
        window.panelGroup?._onReviewVisibilityChanged(false);
        this._saveCollapsedState();
    }

    expand() {
        this.isCollapsed = false;
        if (this.panel) {
            this.panel.classList.remove('collapsed');
        }
        // Restore CSS variable from saved width or default
        document.documentElement.style.setProperty('--ai-panel-width', `${this.getEffectivePanelWidth()}px`);
        window.panelGroup?._onReviewVisibilityChanged(true);
        this._saveCollapsedState();
    }

    /**
     * Set the current PR for PR-specific storage
     * Call this when a PR loads to restore segment selection and filter state for that specific PR
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {number} number - PR number (or reviewId for local mode)
     */
    setPR(owner, repo, number) {
        this.currentPRKey = `${owner}/${repo}#${number}`;
        this._restoreOrCollapsePanel();
        this.restoreSegmentSelection();
        this.restoreFilterState();

        // If the external-comment manager finished its initial fetch BEFORE
        // the panel was wired up (race on slow loads), pull the threads it
        // already has so the External segment count is correct on first
        // paint. Guarded behind a function check so tests that stub the
        // manager don't blow up.
        if (typeof window !== 'undefined'
            && window.externalCommentManager
            && typeof window.externalCommentManager.getAllThreads === 'function') {
            try {
                this.setExternalThreads(window.externalCommentManager.getAllThreads());
            } catch (err) {
                if (typeof console !== 'undefined') {
                    console.warn('[AIPanel] initial external thread sync failed', err);
                }
            }
        }
    }

    /**
     * Set the canonical file order for consistent sorting across components.
     * Call this when files are loaded to ensure AIPanel sorts items in the same order.
     *
     * Lifecycle: This method should be called during file loading (by LocalManager or
     * PRManager), before or shortly after findings/comments arrive. The file order
     * establishes the canonical sort order that will be used when rendering items.
     *
     * This method should only be called once per file load. Multiple calls with the
     * same data will trigger unnecessary re-renders.
     *
     * @param {Map<string, number>|null|undefined} orderMap - Map of file path to index
     */
    setFileOrder(orderMap) {
        this.fileOrder = orderMap || new Map();
        // Re-render to apply new ordering
        if (this.findings.length > 0 || this.comments.length > 0 || (this.externalThreads?.length ?? 0) > 0) {
            this.renderFindings();
        }
    }

    /**
     * Set the analysis state for empty state display
     * @param {string} state - 'unknown' | 'loading' | 'complete' | 'none'
     */
    setAnalysisState(state) {
        this.analysisState = state;
        // Auto-expand panel when analysis starts
        if (state === 'loading' && this.isCollapsed) {
            this.expand();
        }
        // Re-render if currently showing empty state
        if (this.findings.length === 0 && this.selectedSegment === 'ai') {
            this.renderFindings();
        }
    }

    /**
     * Restore segment selection from localStorage (PR-specific)
     */
    restoreSegmentSelection() {
        if (!this.segmentBtns) return;

        // Set of segment values currently available in the DOM. In Local mode
        // the External button is hidden — never restore to it. Any stored
        // value not present in the bar (legacy or hidden) falls back to 'ai'.
        const availableSegments = new Set();
        this.segmentBtns.forEach(btn => {
            if (!btn.hasAttribute('hidden')) {
                availableSegments.add(btn.dataset.segment);
            }
        });

        // Only restore if we have a PR key
        if (this.currentPRKey) {
            const stored = localStorage.getItem(`reviewPanelSegment_${this.currentPRKey}`);
            if (stored && availableSegments.has(stored)) {
                this.selectedSegment = stored;
            } else {
                // Default to 'ai' for new PRs or unknown/hidden stored values
                this.selectedSegment = 'ai';
            }
        }

        // Update UI to match stored segment
        this.segmentBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.segment === this.selectedSegment);
        });

        // Level filter is now hidden by default
        // Could be shown via config in the future
        if (this.levelFilter) {
            this.levelFilter.classList.add('hidden');
        }

        // Re-render findings with restored segment
        this.renderFindings();
    }

    /**
     * Handle segment button selection
     */
    onSegmentSelect(btn) {
        const segment = btn.dataset.segment;
        if (segment === this.selectedSegment) return;

        // Update UI
        this.segmentBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedSegment = segment;

        // Persist selection with PR-specific key
        if (this.currentPRKey) {
            localStorage.setItem(`reviewPanelSegment_${this.currentPRKey}`, segment);
        }

        // Reset selected item key when segment changes
        this.selectedItemKey = null;
        this.currentIndex = -1;

        // Level filter remains hidden (hidden by default now)

        // Filter toggle is always visible - no visibility update needed

        // Re-render findings to filter by segment
        this.renderFindings();
        this.autoSelectFirst();

        // Dispatch event for other components to respond
        const event = new CustomEvent('segmentChanged', {
            detail: { segment }
        });
        document.dispatchEvent(event);
    }

    /**
     * Handle level pill selection
     */
    onLevelSelect(pill) {
        const level = pill.dataset.level;
        if (level === this.selectedLevel) return;

        // Update UI
        this.levelPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.selectedLevel = level;

        // Dispatch event for PRManager to reload suggestions
        const event = new CustomEvent('levelChanged', {
            detail: { level }
        });
        document.dispatchEvent(event);
    }

    /**
     * Reset level filter to default
     */
    resetLevelFilter() {
        this.selectedLevel = 'final';
        this.levelPills?.forEach(p => {
            p.classList.toggle('active', p.dataset.level === 'final');
        });
    }

    /**
     * Add findings to the panel
     * @param {Array} suggestions - Array of AI suggestions
     */
    addFindings(suggestions) {
        // Save current selection before updating
        this.saveCurrentSelection();

        this.findings = suggestions || [];
        // Only update analysisState if there are suggestions (analysis definitely ran).
        // If no suggestions, the caller (loadAISuggestions) should have already set
        // the correct state based on whether analysis has ever been run.
        if (suggestions?.length > 0) {
            this.analysisState = 'complete';
        }
        this.updateSegmentCounts();
        this.renderFindings();

        // Try to restore previous selection, or auto-select first
        if (!this.restoreSelection()) {
            this.autoSelectFirst();
        }
    }

    /**
     * Auto-select the first item so counter shows "1 of N" instead of "— of N"
     */
    autoSelectFirst() {
        const items = this.getFilteredItems();
        if (items.length > 0 && this.currentIndex < 0) {
            this.currentIndex = 0;
            this.highlightCurrentItem();
            this.updateNavigationCounter();
            // Update selected item key for future restoration
            const item = items[0];
            if (item) {
                this.selectedItemKey = this.getItemKey(item);
            }
        }
    }

    /**
     * Generate a stable key for an item (file + line + type)
     * @param {Object} item - Finding or comment item
     * @returns {string} Stable identifier
     */
    getItemKey(item) {
        const file = item.file || '';
        const line = item.line_start || 0;
        const type = item._itemType || 'finding';
        // External threads can share a (file, line) anchor — multiple GitHub
        // review threads on the same line collide otherwise. Disambiguate
        // with source + external_id (falling back to id) so selection survives
        // re-render to the thread the reviewer actually picked.
        const identity = item._itemType === 'external'
            ? `${item.source || ''}:${item.external_id ?? item.id ?? ''}`
            : (item.id ?? '');
        return `${file}:${line}:${type}:${identity}`;
    }

    /**
     * Save the current selection for restoration after re-render
     */
    saveCurrentSelection() {
        if (this.currentIndex < 0) {
            this.selectedItemKey = null;
            return;
        }

        const items = this.getFilteredItems();
        if (this.currentIndex < items.length) {
            const item = items[this.currentIndex];
            this.selectedItemKey = this.getItemKey(item);
        }
    }

    /**
     * Restore selection after re-render if the item still exists
     * @returns {boolean} True if selection was restored
     */
    restoreSelection() {
        if (!this.selectedItemKey) return false;

        const items = this.getFilteredItems();
        const matchIndex = items.findIndex(item => this.getItemKey(item) === this.selectedItemKey);

        if (matchIndex >= 0) {
            this.currentIndex = matchIndex;
            this.highlightCurrentItem();
            this.updateNavigationCounter();
            return true;
        }

        return false;
    }

    /**
     * Update segment counts in the segment control
     * Dims counts when they are zero
     *
     * Design note: These counts reflect "inbox size" (total items in this.comments),
     * which may include dismissed comments when the "show dismissed" filter is enabled.
     * This differs from SplitButton/ReviewModal which use DOM-based counting to show
     * only active comments (what will actually be submitted). The difference is intentional:
     * - Segment counts = "how many items are in this panel view"
     * - SplitButton counts = "how many comments will be submitted"
     */
    updateSegmentCounts() {
        const aiCount = this.findings.length;
        const commentsCount = this.comments.length;
        // External threads are PR-only; hidden in Local mode. The button is
        // [hidden], but the count is harmless to compute either way.
        // Defensive: legacy test fixtures construct panels via Object.create
        // without externalThreads — fall back to an empty array length.
        const externalCount = this.externalThreads?.length ?? 0;
        // 'All' = every visible category. In Local mode the External button
        // is hidden and externalThreads stays at length 0 anyway, so the sum
        // collapses naturally.
        const allCount = aiCount + commentsCount + externalCount;

        if (this.segmentBtns) {
            this.segmentBtns.forEach(btn => {
                const segment = btn.dataset.segment;
                const countSpan = btn.querySelector('.segment-count');
                if (countSpan) {
                    let count = 0;
                    if (segment === 'all') {
                        count = allCount;
                        countSpan.textContent = `(${allCount})`;
                    } else if (segment === 'ai') {
                        count = aiCount;
                        countSpan.textContent = `(${aiCount})`;
                    } else if (segment === 'comments') {
                        count = commentsCount;
                        countSpan.textContent = `(${commentsCount})`;
                    } else if (segment === 'external') {
                        count = externalCount;
                        countSpan.textContent = `(${externalCount})`;
                    }
                    // Dim the count when zero
                    countSpan.classList.toggle('segment-count--zero', count === 0);
                }
            });
        }
        // Count text changes (e.g. "(0)" → "(12)") can alter scrollWidth
        // without triggering resize/scroll listeners, so re-check chevrons.
        this.updateSegmentScrollChevrons?.();
    }

    /**
     * Get items to display based on selected segment
     * @returns {Array} Array of items with an added _itemType property
     */
    getFilteredItems() {
        let items;
        switch (this.selectedSegment) {
            case 'ai':
                items = this.findings.map(f => ({ ...f, _itemType: 'finding' }));
                break;
            case 'comments':
                items = this.comments.map(c => ({ ...c, _itemType: 'comment' }));
                break;
            case 'external':
                items = (this.externalThreads || []).map(t => this._normalizeExternalThread(t));
                break;
            case 'all':
            default:
                // Combine findings, comments, and external threads.
                // In Local mode externalThreads is always empty so this
                // collapses to findings + comments, matching prior behavior.
                items = [
                    ...this.findings.map(f => ({ ...f, _itemType: 'finding' })),
                    ...this.comments.map(c => ({ ...c, _itemType: 'comment' })),
                    ...(this.externalThreads || []).map(t => this._normalizeExternalThread(t))
                ];
                break;
        }

        // Sort by canonical file order, then file-level first, then line number
        return this.sortItemsByFileOrder(items);
    }

    /**
     * Project an external thread root onto the same shape sortItemsByFileOrder
     * uses (file + line_start), preferring live coordinates and falling back
     * to original_* when the thread is outdated. Returns an object that
     * preserves the source thread fields for downstream renderers.
     * @private
     */
    _normalizeExternalThread(thread) {
        if (!thread) return { _itemType: 'external' };
        const outdated = thread.is_outdated === 1 || thread.is_outdated === true;
        const liveStart = Number.isFinite(thread.line_start) ? thread.line_start : null;
        const origStart = Number.isFinite(thread.original_line_start) ? thread.original_line_start : null;
        const liveEnd = Number.isFinite(thread.line_end) ? thread.line_end : null;
        const origEnd = Number.isFinite(thread.original_line_end) ? thread.original_line_end : null;
        const lineStart = outdated ? (origStart ?? liveStart) : (liveStart ?? origStart);
        const lineEnd = outdated ? (origEnd ?? liveEnd) : (liveEnd ?? origEnd);
        return {
            ...thread,
            _itemType: 'external',
            // Surface line_start at the top level so sort + display helpers
            // do not have to know about the outdated fallback rule.
            line_start: lineStart,
            line_end: lineEnd,
            is_outdated: outdated
        };
    }

    /**
     * Sort items by canonical file order, with file-level comments first, then by line number.
     * @param {Array} items - Array of items to sort
     * @returns {Array} New sorted array (does not modify input)
     */
    sortItemsByFileOrder(items) {
        const fileOrder = this.fileOrder;
        const maxOrder = fileOrder.size || 0;

        // Create a defensive copy to avoid mutating the input array
        return [...items].sort((a, b) => {
            const fileA = a.file || '';
            const fileB = b.file || '';

            // First, sort by file order (canonical order from file navigator)
            const orderA = fileOrder.has(fileA) ? fileOrder.get(fileA) : maxOrder;
            const orderB = fileOrder.has(fileB) ? fileOrder.get(fileB) : maxOrder;
            if (orderA !== orderB) return orderA - orderB;

            // Within the same file, file-level comments come first
            const isFileLevelA = a.is_file_level === 1 || a.is_file_level === true;
            const isFileLevelB = b.is_file_level === 1 || b.is_file_level === true;
            if (isFileLevelA && !isFileLevelB) return -1;
            if (!isFileLevelA && isFileLevelB) return 1;

            // Then sort by line number (null/undefined treated as file-level, comes first)
            const lineA = a.line_start ?? 0;
            const lineB = b.line_start ?? 0;
            return lineA - lineB;
        });
    }

    renderFindings() {
        if (!this.findingsList) return;

        const items = this.getFilteredItems();

        // Show empty state based on segment and analysis state
        if (items.length === 0) {
            let emptyContent;
            if (this.selectedSegment === 'comments') {
                emptyContent = `
                    <div class="empty-state-icon">${this.getEmptyStateIcon('comment')}</div>
                    <div class="empty-state-title">No comments yet</div>
                    <div class="empty-state-description">Click the <strong>+</strong> button next to any line to add a comment.</div>
                `;
            } else if (this.selectedSegment === 'ai') {
                // Show different states based on analysis status
                if (this.analysisState === 'loading') {
                    emptyContent = `
                        <div class="loading-indicator">
                            <div class="loading-spinner-small"></div>
                            <p>Analyzing PR...</p>
                        </div>
                    `;
                } else if (this.analysisState === 'complete') {
                    // Analysis ran, but no issues found
                    emptyContent = `
                        <div class="empty-state-icon empty-state-icon--success">${this.getEmptyStateIcon('check')}</div>
                        <div class="empty-state-title">No issues found</div>
                        <div class="empty-state-description">AI analysis complete</div>
                    `;
                } else {
                    // 'unknown' or 'none' state - analysis hasn't been run yet
                    emptyContent = `
                        <div class="empty-state-icon empty-state-icon--amber">${this.getEmptyStateIcon('sparkle')}</div>
                        <div class="empty-state-title">Ready for AI Review</div>
                        <div class="empty-state-description">Click <strong>Analyze</strong> to get AI suggestions</div>
                    `;
                }
            } else if (this.selectedSegment === 'external') {
                // External threads come from GitHub PR review activity. There
                // is no in-app action that creates them — surface that
                // expectation rather than the generic "no items yet" copy.
                emptyContent = `
                    <div class="empty-state-icon">${this.getEmptyStateIcon('comment')}</div>
                    <div class="empty-state-title">No external review comments</div>
                    <div class="empty-state-description">Comments from GitHub PR reviews appear here once reviewers leave them.</div>
                `;
            } else {
                // 'all' segment - check analysis state to determine empty message
                if (this.analysisState === 'complete') {
                    // Analysis already ran - don't prompt to run again
                    emptyContent = `
                        <div class="empty-state-icon">${this.getEmptyStateIcon('comment')}</div>
                        <div class="empty-state-title">No items yet</div>
                        <div class="empty-state-description">Add comments in the diff view.</div>
                    `;
                } else {
                    // Analysis not run yet ('unknown' or 'none')
                    emptyContent = `
                        <div class="empty-state-icon empty-state-icon--amber">${this.getEmptyStateIcon('sparkle')}</div>
                        <div class="empty-state-title">No items yet</div>
                        <div class="empty-state-description">Click <strong>Analyze</strong> for AI suggestions or add comments in the diff view.</div>
                    `;
                }
            }

            this.findingsList.innerHTML = `
                <div class="findings-empty empty-state">
                    ${emptyContent}
                </div>
            `;
            this.updateFindingsHeader(0);
            return;
        }

        this.updateFindingsHeader(items.length);

        this.findingsList.innerHTML = items.map((item, index) => {
            // Dispatch on _itemType so each renderer owns its DOM contract.
            if (item._itemType === 'comment') {
                return this.renderCommentItem(item, index);
            } else if (item._itemType === 'external') {
                return this.renderExternalThreadItem(item, index);
            } else {
                return this.renderFindingItem(item, index);
            }
        }).join('');

        // Bind click events
        this.findingsList.querySelectorAll('.finding-item').forEach(item => {
            item.addEventListener('click', () => this.onFindingClick(item));
        });

        // Bind dismiss button events for user comments
        this.findingsList.querySelectorAll('.quick-action-dismiss-comment').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent triggering item click
                const commentId = parseInt(btn.dataset.commentId, 10);
                this.onDeleteComment(commentId);
            });
        });

        // Bind quick-action button events for AI suggestions
        this.findingsList.querySelectorAll('.quick-action-adopt').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent triggering item click
                const findingId = parseInt(btn.dataset.findingId, 10);
                this.onAdoptSuggestion(findingId);
            });
        });

        this.findingsList.querySelectorAll('.quick-action-dismiss').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent triggering item click
                const findingId = parseInt(btn.dataset.findingId, 10);
                this.onDismissSuggestion(findingId);
            });
        });

        // Bind restore button events for dismissed AI suggestions
        this.findingsList.querySelectorAll('.quick-action-restore').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent triggering item click
                const findingId = parseInt(btn.dataset.findingId, 10);
                this.onRestoreSuggestion(findingId);
            });
        });

        // Bind restore button events for dismissed user comments
        this.findingsList.querySelectorAll('.quick-action-restore-comment').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent triggering item click
                const commentId = parseInt(btn.dataset.commentId, 10);
                this.onRestoreComment(commentId);
            });
        });

        // Bind chat button events for AI suggestions and comments
        this.findingsList.querySelectorAll('.quick-action-chat').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent triggering item click
                this.openQuickActionChat(btn);
            });
        });

        // Restore active state if we have a current index
        this.highlightCurrentItem();
    }

    /**
     * Handle delete comment button click
     * @param {number} commentId - The comment ID to delete
     */
    onDeleteComment(commentId) {
        // Use prManager's delete method which handles both UI and API
        if (window.prManager?.deleteUserComment) {
            window.prManager.deleteUserComment(commentId);
        }
    }

    /**
     * Handle restore comment button click
     * @param {number} commentId - The comment ID to restore
     */
    onRestoreComment(commentId) {
        // Use prManager's restore method which handles both UI and API
        if (window.prManager?.restoreUserComment) {
            window.prManager.restoreUserComment(commentId);
        }
    }

    /**
     * Handle adopt suggestion button click
     * @param {number} findingId - The finding ID to adopt
     */
    onAdoptSuggestion(findingId) {
        // Use prManager's adopt method which handles both UI and API
        if (window.prManager?.adoptSuggestion) {
            window.prManager.adoptSuggestion(findingId);
        }
    }

    /**
     * Handle dismiss suggestion button click
     * @param {number} findingId - The finding ID to dismiss
     */
    onDismissSuggestion(findingId) {
        // Use prManager's dismiss method which handles both UI and API
        if (window.prManager?.dismissSuggestion) {
            window.prManager.dismissSuggestion(findingId);
        }
    }

    /**
     * Handle restore suggestion button click
     * @param {number} findingId - The finding ID to restore
     */
    onRestoreSuggestion(findingId) {
        // Use prManager's restore method which handles both UI and API
        if (window.prManager?.restoreSuggestion) {
            window.prManager.restoreSuggestion(findingId);
        }
    }

    /**
     * Handle chat button clicks from review panel quick actions.
     * Suggestions use suggestionContext; comments use commentContext.
     * @param {HTMLButtonElement} btn - The clicked chat button
     */
    openQuickActionChat(btn) {
        if (!window.chatPanel) return;

        const findingId = btn.dataset.findingId ? parseInt(btn.dataset.findingId, 10) : null;
        const commentId = btn.dataset.commentId ? parseInt(btn.dataset.commentId, 10) : null;
        const reviewId = window.prManager?.currentPR?.id;

        const buildCommentContext = (comment, fallbackDataset = {}) => ({
            commentId: comment?.id ? String(comment.id) : String(commentId),
            body: comment?.body || '',
            file: comment?.file || fallbackDataset.commentFile || '',
            line_start: comment?.line_start ?? (fallbackDataset.commentLineStart ? parseInt(fallbackDataset.commentLineStart, 10) : null),
            line_end: comment?.line_end ?? (fallbackDataset.commentLineEnd ? parseInt(fallbackDataset.commentLineEnd, 10) : null),
            parentId: comment?.parent_id ?? (fallbackDataset.commentParentId ? parseInt(fallbackDataset.commentParentId, 10) : null),
            side: comment?.side || fallbackDataset.commentSide || 'RIGHT',
            source: 'user',
            isFileLevel: comment?.is_file_level === 1 || comment?.is_file_level === true
        });

        if (commentId) {
            const comment = this.comments?.find(c => c.id === commentId);

            window.chatPanel.open({
                reviewId,
                commentContext: buildCommentContext(comment, btn.dataset)
            });
            return;
        }

        // External thread chat — mirrors ExternalCommentManager._openThreadChat.
        // The button carries data-thread-id + data-source; the full thread is
        // looked up from this.externalThreads so replies are included.
        if (btn.dataset.itemType === 'external') {
            const threadId = btn.dataset.threadId;
            const numericId = threadId != null && threadId !== '' ? Number(threadId) : null;
            const thread = (this.externalThreads || []).find(t =>
                String(t.id) === String(threadId) ||
                (numericId != null && t.id === numericId)
            );
            if (thread) {
                const outdated = thread.is_outdated === 1 || thread.is_outdated === true;
                const replies = Array.isArray(thread.replies) ? thread.replies : [];
                window.chatPanel.open({
                    reviewId,
                    threadContext: {
                        rootId: thread.id,
                        source: 'external',
                        externalSource: thread.source,
                        file: thread.file,
                        side: thread.side || 'RIGHT',
                        line_start: outdated ? thread.original_line_start : thread.line_start,
                        line_end: outdated ? thread.original_line_end : thread.line_end,
                        comments: [
                            {
                                author: thread.author,
                                body: thread.body,
                                isOutdated: !!outdated,
                                externalUrl: thread.external_url,
                                externalCreatedAt: thread.external_created_at,
                            },
                            ...replies.map((r) => ({
                                author: r.author,
                                body: r.body,
                                isOutdated: !!(r.is_outdated === 1 || r.is_outdated === true),
                                externalUrl: r.external_url,
                                externalCreatedAt: r.external_created_at,
                            })),
                        ],
                    },
                });
            }
            return;
        }

        const file = btn.dataset.findingFile || '';
        const title = btn.dataset.findingTitle || '';
        let suggestionContext = { title, file };

        if (findingId && this.findings) {
            const finding = this.findings.find(f => f.id === findingId);
            if (finding) {
                if (finding.status === 'adopted') {
                    const adoptedComment = this.comments?.find(c => c.parent_id === findingId && c.status !== 'inactive')
                        || this.comments?.find(c => c.parent_id === findingId);
                    if (adoptedComment) {
                        window.chatPanel.open({
                            reviewId,
                            commentContext: buildCommentContext(adoptedComment)
                        });
                        return;
                    }
                }

                suggestionContext = {
                    suggestionId: String(findingId),
                    title: finding.title || title,
                    body: finding.formattedBody || finding.body || '',
                    type: finding.type || '',
                    file: finding.file || file,
                    line_start: finding.line_start ?? null,
                    line_end: finding.line_end ?? null,
                    side: finding.side || 'RIGHT',
                    reasoning: null
                };
            }
        }

        window.chatPanel.open({
            reviewId,
            suggestionId: findingId ? String(findingId) : undefined,
            suggestionContext
        });
    }

    onFindingClick(item) {
        const itemId = item.dataset.id;
        const itemType = item.dataset.itemType;
        const file = item.dataset.file;
        const line = item.dataset.line;
        const index = parseInt(item.dataset.index, 10);

        // Update current index and highlight
        this.currentIndex = index;
        this.highlightCurrentItem();
        this.updateNavigationCounter();

        // Save selected item key for restoration after re-renders
        const items = this.getFilteredItems();
        if (index < items.length) {
            this.selectedItemKey = this.getItemKey(items[index]);
        }

        // Handle comments - scroll to user comment row
        if (itemType === 'comment') {
            this.scrollToComment(itemId, file, line);
            return;
        }

        // Handle external threads - scroll to inline external-comment-row
        if (itemType === 'external') {
            const source = item.dataset.source || '';
            const threadId = item.dataset.threadId || itemId;
            this.scrollToExternalThread(threadId, source, file, line);
            return;
        }

        // Handle findings/suggestions
        this.scrollToFinding(itemId, file, line);
    }

    /**
     * Expand a file if it is collapsed.
     *
     * Return contract (callers must handle both):
     *   - `false` when nothing was expanded (no file, no wrapper, or already
     *     expanded), OR a truthy non-thenable for the DOM-only fallback.
     *   - a Promise when it routed through `prManager.toggleFileCollapse`,
     *     which is async (it renders the lazy file body before revealing it).
     * Scroll callers await the Promise so the row lookup runs against a
     * rendered, visible body; the synchronous fast path is preserved when no
     * expansion is needed.
     *
     * @param {string} file - The file path
     * @returns {boolean|Promise<*>} See contract above.
     */
    expandFileIfCollapsed(file) {
        if (!file) return false;

        const fileWrapper = window.prManager?.findFileElement
            ? window.prManager.findFileElement(file)
            : window.DiffRenderer?.findFileElement?.(file);

        if (!fileWrapper) return false;

        // Check if collapsed
        if (fileWrapper.classList.contains('collapsed')) {
            // Use prManager's toggle method if available (keeps state in sync).
            const filePath = fileWrapper.dataset.fileName;
            if (window.prManager?.toggleFileCollapse) {
                // Async: renders the lazy body + removes `collapsed`. Hand the
                // Promise back so the caller can await render completion rather
                // than guessing with a fixed timeout.
                return window.prManager.toggleFileCollapse(filePath);
            }
            // Fallback: directly manipulate the DOM (no lazy render path).
            fileWrapper.classList.remove('collapsed');
            const header = fileWrapper.querySelector('.d2h-file-header');
            if (header && window.DiffRenderer) {
                window.DiffRenderer.updateFileHeaderState(header, true);
            }
            return true;
        }

        return false;
    }

    /**
     * Scroll to an AI finding/suggestion in the diff view
     * @param {string} findingId
     * @param {string} file
     * @param {number|string} line
     * @param {('LEFT'|'RIGHT')} [side] - Diff side; resolved from the finding
     *   model (finding.side) when omitted, defaulting to 'RIGHT'.
     */
    async scrollToFinding(findingId, file, line, side) {
        const myGen = ++this._navGen;
        // Resolve the diff side: explicit arg wins, else the finding's own side,
        // else RIGHT. Deletions live on the LEFT, so a hardcoded RIGHT would
        // reveal the wrong line for deletion-side findings.
        const resolvedSide = side
            || this.findings?.find(f => String(f.id) === String(findingId))?.side
            || 'RIGHT';
        // Expand the file first if it's collapsed
        const expansion = this.expandFileIfCollapsed(file);
        if (expansion && typeof expansion.then === 'function') await expansion;
        // Always render the target's lazy body — an expanded-but-offscreen
        // body has no suggestion rows until rendered, so the lookup below
        // would miss on the first attempt (expansion only covers the
        // collapsed case).
        if (file && window.prManager?.ensureFileBodyRendered) {
            try { await window.prManager.ensureFileBodyRendered(file); } catch { /* best effort */ }
        }

        const doScroll = async () => {
            // Reveal the target line first — for Pierre-rendered files this
            // materializes deferred diffs and expands collapsed gaps.
            if (file && line && window.prManager?.ensureLinesVisible) {
                await window.prManager.ensureLinesVisible([
                    { file, line_start: parseInt(line, 10), line_end: parseInt(line, 10), side: resolvedSide }
                ]);
            }

            let targetSuggestion = null;

            // First, try to find by exact ID match (most reliable)
            if (findingId) {
                targetSuggestion = document.querySelector(`.ai-suggestion[data-suggestion-id="${findingId}"]`);
            }

            // Fallback: match by file and line (for suggestions without IDs)
            if (!targetSuggestion && file) {
                const suggestions = document.querySelectorAll('.ai-suggestion');
                for (const suggestion of suggestions) {
                    const suggestionFile = suggestion.closest('[data-file-name]')?.dataset?.fileName;
                    if (suggestionFile && suggestionFile.includes(file)) {
                        // If we have a line number, try to match more precisely
                        if (line) {
                            const row = suggestion.closest('tr');
                            const prevRow = row?.previousElementSibling;
                            const rowLine = prevRow?.querySelector('.line-num2')?.textContent?.trim();
                            if (rowLine === line) {
                                targetSuggestion = suggestion;
                                break;
                            }
                        } else {
                            // No line specified, take first match in file
                            targetSuggestion = suggestion;
                            break;
                        }
                    }
                }
            }

            if (targetSuggestion) {
                const minimizer = window.prManager?.commentMinimizer;
                let scrollTarget = targetSuggestion;
                if (minimizer?.active) {
                    // Expand file-level comments so the target becomes visible
                    minimizer.expandForElement(targetSuggestion);
                    // Comments are minimized — scroll to the parent diff line instead
                    scrollTarget = minimizer.findDiffRowFor(targetSuggestion) || targetSuggestion;
                }
                this._scrollDiffTarget(scrollTarget);
                targetSuggestion.classList.add('current-suggestion');
                setTimeout(() => targetSuggestion.classList.remove('current-suggestion'), 2000);
            }
        };

        // A newer navigation took over while we awaited — let it win.
        if (myGen !== this._navGen) return;
        doScroll();
    }

    /**
     * Scroll a diff-panel element into view, preferring the stable helper
     * (re-corrects after lazy file bodies render mid-scroll and shift
     * layout). Fire-and-forget.
     * @param {Element} target
     */
    _scrollDiffTarget(target) {
        // Land the target at the top of the diff panel (scroll-margin-top in
        // pr.css offsets it below the sticky toolbar + file header).
        const options = { behavior: 'smooth', block: 'start' };
        if (window.ScrollUtils?.scrollIntoViewStable) {
            window.ScrollUtils.scrollIntoViewStable(target, options);
        } else {
            target.scrollIntoView(options);
        }
    }

    /**
     * Scroll to a user comment in the diff view
     * @param {string} commentId
     * @param {string} file
     * @param {number|string} line
     * @param {('LEFT'|'RIGHT')} [side] - Diff side; resolved from the comment
     *   model (comment.side) when omitted, defaulting to 'RIGHT'.
     */
    async scrollToComment(commentId, file, line, side) {
        const myGen = ++this._navGen;
        // Resolve the diff side: explicit arg wins, else the comment's own side,
        // else RIGHT.
        const resolvedSide = side
            || this.comments?.find(c => String(c.id) === String(commentId))?.side
            || 'RIGHT';
        // Expand the file first if it's collapsed
        const expansion = this.expandFileIfCollapsed(file);
        if (expansion && typeof expansion.then === 'function') await expansion;
        // Always render the target's lazy body — comment rows don't exist
        // inside an unrendered body, so the lookup below would miss.
        if (file && window.prManager?.ensureFileBodyRendered) {
            try { await window.prManager.ensureFileBodyRendered(file); } catch { /* best effort */ }
        }

        const doScroll = async () => {
            if (file && line && window.prManager?.ensureLinesVisible) {
                await window.prManager.ensureLinesVisible([
                    { file, line_start: parseInt(line, 10), line_end: parseInt(line, 10), side: resolvedSide }
                ]);
            }

            let targetElement = null;
            let isFileLevel = false;

            // Check if this is a file-level comment
            const comment = this.comments.find(c => String(c.id) === String(commentId));
            if (comment && (comment.is_file_level === 1 || comment.is_file_level === true)) {
                isFileLevel = true;
            }

            // For file-level comments, find the comment card in the file-comments-zone
            if (isFileLevel && commentId) {
                targetElement = document.querySelector(`.file-comment-card[data-comment-id="${commentId}"]`);

                // If found, make sure the zone is expanded
                if (targetElement) {
                    const zone = targetElement.closest('.file-comments-zone');
                    if (zone && zone.classList.contains('collapsed')) {
                        zone.classList.remove('collapsed');
                    }
                }
            }

            // For line-level comments, try to find by exact comment ID.
            // Legacy path uses .user-comment-row (table rows), annotation path
            // uses [data-comment-id] on light-DOM divs slotted into @pierre/diffs.
            if (!targetElement && commentId) {
                targetElement = document.querySelector(`.user-comment-row[data-comment-id="${commentId}"]`)
                    || document.querySelector(`[data-comment-id="${commentId}"]`);
            }

            // Fallback: find by file and line if no direct match
            if (!targetElement && file && line) {
                const commentRows = document.querySelectorAll('.user-comment-row, [data-comment-id]');
                for (const row of commentRows) {
                    if (row.dataset.file === file && row.dataset.lineStart === line) {
                        targetElement = row;
                        break;
                    }
                }
            }

            if (targetElement) {
                const minimizer = window.prManager?.commentMinimizer;
                let scrollTarget = targetElement;
                if (minimizer?.active) {
                    minimizer.expandForElement(targetElement);
                    const diffRow = isFileLevel ? null : minimizer.findDiffRowFor(targetElement);
                    scrollTarget = diffRow || targetElement;
                }
                this._scrollDiffTarget(scrollTarget);
                // Add highlight effect — find .user-comment inside (works for both
                // legacy rows and @pierre/diffs annotation divs)
                const commentDiv = isFileLevel ? targetElement : (targetElement.querySelector('.user-comment') || targetElement);
                if (commentDiv) {
                    commentDiv.classList.add('highlight-flash');
                    setTimeout(() => commentDiv.classList.remove('highlight-flash'), 2000);
                }
            }
        };

        // A newer navigation took over while we awaited — let it win.
        if (myGen !== this._navGen) return;
        doScroll();
    }

    /**
     * Scroll to an external review-comment thread in the diff view.
     *
     * Mirrors `scrollToComment`: expand the file if collapsed, find the
     * `.external-comment-row` for the (threadId, source) pair, scroll it into
     * view, and add a transient focus class for the visual flash.
     *
     * @param {string|number} threadId - Root comment id of the thread
     * @param {string} source - External source key (e.g. 'github')
     * @param {string} file - File path for collapse-expand fallback
     * @param {string|number} line - Anchor line; used for file/line fallback
     */
    async scrollToExternalThread(threadId, source, file, line) {
        const myGen = ++this._navGen;
        // Expand the file first if it's collapsed
        const expansion = this.expandFileIfCollapsed(file);
        if (expansion && typeof expansion.then === 'function') await expansion;
        // Always render the target's lazy body — external thread rows don't
        // exist inside an unrendered body, so the lookup below would miss.
        if (file && window.prManager?.ensureFileBodyRendered) {
            try { await window.prManager.ensureFileBodyRendered(file); } catch { /* best effort */ }
        }

        const doScroll = () => {
            let target = null;

            // Most reliable: match on (threadId, source). `data-thread-id`
            // and `data-source` are written by ExternalCommentManager._buildThreadRow.
            if (threadId) {
                const idAttr = (typeof globalThis !== 'undefined' && globalThis.CSS?.escape)
                    ? globalThis.CSS.escape(String(threadId))
                    : String(threadId);
                if (source) {
                    const srcAttr = (typeof globalThis !== 'undefined' && globalThis.CSS?.escape)
                        ? globalThis.CSS.escape(String(source))
                        : String(source);
                    target = document.querySelector(
                        `.external-comment-row[data-thread-id="${idAttr}"][data-source="${srcAttr}"]`
                    );
                }
                if (!target) {
                    target = document.querySelector(
                        `.external-comment-row[data-thread-id="${idAttr}"]`
                    );
                }
            }

            // Fallback: scan within the matching file by anchor line. Useful
            // when the row was rebuilt and IDs are momentarily missing.
            if (!target && file) {
                const rows = document.querySelectorAll('.external-comment-row');
                for (const row of rows) {
                    const rowFile = row.closest('[data-file-name]')?.dataset?.fileName;
                    if (rowFile && rowFile === file) {
                        target = row;
                        break;
                    }
                }
            }

            if (target) {
                const minimizer = window.prManager?.commentMinimizer;
                let scrollTarget = target;
                if (minimizer?.active) {
                    minimizer.expandForElement(target);
                    scrollTarget = minimizer.findDiffRowFor(target) || target;
                }
                this._scrollDiffTarget(scrollTarget);

                // Transient focus flash. The class is removed after 2s — if
                // the row is rebuilt before then, the class is lost with it,
                // which is fine: the flash is purely cosmetic.
                target.classList.add('external-comment-row--focused');
                setTimeout(() => target.classList.remove('external-comment-row--focused'), 2000);
            }
        };

        // A newer navigation took over while we awaited — let it win.
        if (myGen !== this._navGen) return;
        doScroll();
    }

    // ========================================
    // Segment overflow scroll
    // ========================================

    /**
     * Set up horizontal overflow scroll for the segment row.
     *
     * When the segment buttons don't all fit in the panel width, show
     * chevron buttons on either side that scroll the row horizontally.
     * Watches via ResizeObserver (panel width can change with the resizer
     * handle) and the scroll container's own scroll event (to update
     * chevron visibility at each end of travel).
     */
    setupSegmentOverflow() {
        if (!this.segmentControlScroll) return;

        const update = () => this.updateSegmentScrollChevrons();

        // Wire the scroll container's scroll event for visibility updates.
        this.segmentControlScroll.addEventListener('scroll', update, { passive: true });

        // Observe size changes on the scroll container itself. Triggered by
        // panel resize, segment hidden/shown (e.g. local-mode gate), and
        // window resize.
        if (typeof ResizeObserver !== 'undefined') {
            this._segmentResizeObserver = new ResizeObserver(update);
            this._segmentResizeObserver.observe(this.segmentControlScroll);
        } else if (typeof window !== 'undefined') {
            // Fallback for very old browsers — react to window resize at least.
            window.addEventListener('resize', update);
        }

        // Initial measurement after layout settles.
        update();
    }

    /**
     * Show or hide the segment overflow chevrons based on current scroll
     * geometry. Idempotent — safe to call from resize, scroll, or after a
     * segment button is hidden/shown.
     */
    updateSegmentScrollChevrons() {
        const container = this.segmentControlScroll;
        if (!container) return;

        const overflow = container.scrollWidth > container.clientWidth + 1;
        const scrollLeft = container.scrollLeft;
        const maxScroll = container.scrollWidth - container.clientWidth;
        const atStart = scrollLeft <= 0;
        const atEnd = scrollLeft >= maxScroll - 1;

        if (this.segmentScrollLeft) {
            // Hide left chevron when not overflowing or already at start.
            if (!overflow || atStart) {
                this.segmentScrollLeft.setAttribute('hidden', '');
            } else {
                this.segmentScrollLeft.removeAttribute('hidden');
            }
        }
        if (this.segmentScrollRight) {
            if (!overflow || atEnd) {
                this.segmentScrollRight.setAttribute('hidden', '');
            } else {
                this.segmentScrollRight.removeAttribute('hidden');
            }
        }
    }

    /**
     * Scroll the segment row horizontally by approximately one segment width.
     * @param {number} direction - -1 for left, 1 for right
     */
    scrollSegmentRow(direction) {
        const container = this.segmentControlScroll;
        if (!container) return;
        const amount = 150 * (direction < 0 ? -1 : 1);
        if (typeof container.scrollBy === 'function') {
            container.scrollBy({ left: amount, behavior: 'smooth' });
        } else {
            container.scrollLeft += amount;
        }
    }

    getFindingType(finding) {
        const type = (finding.type || finding.category || '').toLowerCase();
        if (type.includes('bug') || type.includes('error') || type.includes('security')) {
            return 'issue';
        }
        if (type.includes('praise') || type.includes('good')) {
            return 'praise';
        }
        return 'info';
    }

    getTypeIcon(type) {
        switch (type) {
            case 'issue':
                return `<svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                    <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575L6.457 1.047Z"/>
                </svg>`;
            case 'praise':
                return `<svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                    <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/>
                </svg>`;
            case 'comment':
                // Chat bubble icon for comments
                return `<svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                    <path fill-rule="evenodd" d="M2.75 2.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.75.75 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75zM1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.457 1.457 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z"/>
                </svg>`;
            default:
                return `<svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                    <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm0 4a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 8 4Zm0 9a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>
                </svg>`;
        }
    }

    /**
     * Get icon SVG for empty state displays
     * @param {string} type - Icon type: 'sparkle', 'check', 'comment'
     * @returns {string} SVG HTML string
     */
    getEmptyStateIcon(type) {
        switch (type) {
            case 'sparkle':
                // Sparkle/stars icon for "Ready for AI Review"
                return `<svg viewBox="0 0 16 16" fill="currentColor" width="32" height="32">
                    <path d="M7.53 1.282a.5.5 0 0 1 .94 0l.478 1.306a7.492 7.492 0 0 0 4.464 4.464l1.305.478a.5.5 0 0 1 0 .94l-1.305.478a7.492 7.492 0 0 0-4.464 4.464l-.478 1.305a.5.5 0 0 1-.94 0l-.478-1.305a7.492 7.492 0 0 0-4.464-4.464L1.282 8.47a.5.5 0 0 1 0-.94l1.306-.478a7.492 7.492 0 0 0 4.464-4.464l.478-1.306Z"/>
                </svg>`;
            case 'check':
                // Check circle icon for "No issues found"
                return `<svg viewBox="0 0 16 16" fill="currentColor" width="32" height="32">
                    <path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0Z"/>
                </svg>`;
            case 'comment':
                // Comment bubble icon for "No comments yet"
                return `<svg viewBox="0 0 16 16" fill="currentColor" width="32" height="32">
                    <path fill-rule="evenodd" d="M2.75 2.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.75.75 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75zM1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.457 1.457 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z"/>
                </svg>`;
            default:
                return '';
        }
    }

    /**
     * Render a single finding item (AI suggestion)
     * @param {Object} finding - The finding data
     * @param {number} index - The item index
     * @returns {string} HTML string
     */
    renderFindingItem(finding, index) {
        const type = this.getFindingType(finding);
        const title = this.truncateText(finding.title || finding.body || 'Suggestion', 50);
        const fileName = finding.file ? finding.file.split('/').pop() : null;
        const lineNum = finding.line_start;
        // Full location for tooltip, filename only for display
        const fullLocation = fileName ? `${fileName}${lineNum ? ':' + lineNum : ''}` : '';
        const statusClass = finding.status === 'dismissed' ? 'finding-dismissed' :
                           finding.status === 'adopted' ? 'finding-adopted' : 'finding-active';
        const category = finding.category || finding.type || '';
        const isActive = finding.status !== 'dismissed' && finding.status !== 'adopted';

        // Dismissal reason: only shown for dismissed findings that carry one.
        // Full text goes in the item tooltip; a truncated muted line renders
        // under the title.
        const dismissalReason = finding.status === 'dismissed' ? (finding.status_reason || '') : '';
        const itemTitle = dismissalReason
            ? (fullLocation ? `${fullLocation} — ${dismissalReason}` : dismissalReason)
            : fullLocation;

        // Use star icon for praise, dot for other types
        const indicator = type === 'praise'
            ? `<span class="finding-star">${this.getTypeIcon('praise')}</span>`
            : `<span class="finding-dot"></span>`;

        // Quick-action buttons for active items (adopt/dismiss)
        // For dismissed items, show restore button
        let quickActions = '';
        if (isActive) {
            quickActions = `
            <div class="finding-quick-actions">
                <button class="quick-action-btn quick-action-adopt" data-finding-id="${finding.id}" title="Adopt" aria-label="Adopt suggestion">
                    ${this.getAdoptIcon()}
                </button>
                <button class="quick-action-btn quick-action-dismiss" data-finding-id="${finding.id}" title="Dismiss" aria-label="Dismiss suggestion">
                    ${this.getDismissIcon()}
                </button>
            </div>
        `;
        } else if (finding.status === 'dismissed') {
            // Restore button for dismissed findings - undo/restore icon (counter-clockwise arrow)
            quickActions = `
            <div class="finding-quick-actions">
                <button class="quick-action-btn quick-action-restore" data-finding-id="${finding.id}" title="Restore" aria-label="Restore suggestion">
                    ${this.getRestoreIcon()}
                </button>
            </div>
        `;
        }

        // Chat button for all findings when chat is available
        let chatAction = '';
        if (document.documentElement.getAttribute('data-chat') === 'available') {
            chatAction = `
            <div class="finding-chat-action">
                <button class="quick-action-btn quick-action-chat" data-finding-id="${finding.id}" data-finding-file="${finding.file || ''}" data-finding-title="${this.escapeHtml(title)}" title="Chat" aria-label="Chat about suggestion">
                    <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>
                </button>
            </div>
        `;
        }

        return `
            <div class="finding-item-wrapper">
                <button class="finding-item finding-${type} ${statusClass}" data-index="${index}" data-id="${finding.id || ''}" data-file="${finding.file || ''}" data-line="${lineNum || ''}" data-item-type="finding" title="${window.escapeHtmlAttribute(itemTitle)}">
                    ${indicator}
                    <div class="finding-content">
                        <span class="finding-title">${this.escapeHtml(title)}</span>
                        ${category || finding.severity ? `<span class="finding-meta">${category ? `<span class="finding-category">${this.escapeHtml(category)}</span>` : ''}${finding.severity ? `<span class="severity-badge severity-${finding.severity}">${this.escapeHtml(finding.severity.toUpperCase())}</span>` : ''}</span>` : ''}
                        ${fileName ? `<span class="finding-location">${this.escapeHtml(fileName)}</span>` : ''}
                        ${dismissalReason ? `<span class="finding-dismissal-reason">${this.escapeHtml(this.truncateText(dismissalReason, 60))}</span>` : ''}
                    </div>
                </button>
                ${quickActions}
                ${chatAction}
            </div>
        `;
    }

    /**
     * Render a single comment item
     * @param {Object} comment - The comment data
     * @param {number} index - The item index
     * @returns {string} HTML string
     */
    renderCommentItem(comment, index) {
        // Strip markdown from body for clean display
        const rawTitle = this.stripMarkdown(comment.body || 'Comment');
        const title = this.truncateText(rawTitle, 50);
        const fileName = comment.file ? comment.file.split('/').pop() : null;
        const lineNum = comment.line_start;
        const isFileLevel = comment.is_file_level === 1 || comment.is_file_level === true;
        const isDismissed = comment.status === 'inactive';
        // Full location for tooltip, filename only for display
        const fullLocation = fileName ? `${fileName}${lineNum ? ':' + lineNum : (isFileLevel ? ' (file)' : '')}` : '';

        // Choose icon based on whether comment originated from AI (has parent_id) or user
        const icon = comment.parent_id
            ? this.getCommentAIIcon()
            : this.getPersonIcon();

        // Build status class
        const dismissedClass = isDismissed ? ' comment-item-dismissed' : '';

        // Action button: restore for dismissed, delete for active
        // Dismissed comments use .finding-quick-actions wrapper for consistent hover-to-show behavior
        let actionButton;
        if (isDismissed) {
            actionButton = `
                <div class="finding-quick-actions">
                    <button class="quick-action-btn quick-action-restore-comment" data-comment-id="${comment.id}" title="Restore comment" aria-label="Restore comment">
                        ${AIPanel.ICONS.restore}
                    </button>
                </div>
            `;
        } else {
            // Active comments use same hover-to-show pattern with X icon like AI suggestions
            actionButton = `
                <div class="finding-quick-actions">
                    <button class="quick-action-btn quick-action-dismiss-comment" data-comment-id="${comment.id}" title="Dismiss comment" aria-label="Dismiss comment">
                        ${AIPanel.ICONS.dismiss}
                    </button>
                </div>
            `;
        }

        // Chat button for active comments
        let chatAction = '';
        if (!isDismissed && document.documentElement.getAttribute('data-chat') === 'available') {
            chatAction = `
            <div class="finding-chat-action">
                <button class="quick-action-btn quick-action-chat" data-comment-id="${comment.id}" data-comment-file="${this.escapeHtml(comment.file || '')}" data-comment-line-start="${comment.line_start ?? ''}" data-comment-line-end="${comment.line_end ?? ''}" data-comment-parent-id="${comment.parent_id || ''}" data-comment-side="${comment.side || 'RIGHT'}" title="Chat" aria-label="Chat about comment">
                    <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>
                </button>
            </div>
        `;
        }

        return `
            <div class="finding-item-wrapper">
                <button class="finding-item finding-comment ${comment.parent_id ? 'comment-ai-origin' : 'comment-user-origin'}${isFileLevel ? ' file-level' : ''}${dismissedClass}" data-index="${index}" data-id="${comment.id || ''}" data-file="${comment.file || ''}" data-line="${lineNum || ''}" data-is-file-level="${isFileLevel ? '1' : '0'}" data-item-type="comment" title="${fullLocation}">
                    <span class="comment-icon">${icon}</span>
                    <div class="finding-content">
                        <span class="finding-title">${this.escapeHtml(title)}</span>
                        ${fileName ? `<span class="finding-location">${this.escapeHtml(fileName)}${isFileLevel ? ' <span class="file-level-indicator">(file)</span>' : ''}</span>` : ''}
                    </div>
                </button>
                ${actionButton}
                ${chatAction}
            </div>
        `;
    }

    /**
     * Render a single external review-comment thread item.
     *
     * Modeled on `renderCommentItem` so the panel list stays visually
     * consistent. Differs from comments in:
     *   - no quick-action (adopt/dismiss) buttons — external threads are
     *     read-only mirrors from GitHub.
     *   - a reply-count badge when the thread has replies.
     *   - `data-thread-id` + `data-source` so `scrollToExternalThread` can
     *     find the inline `.external-comment-row` element.
     *   - `.source-<name>` modifier so the blue --ec-* color block applies.
     *
     * @param {Object} thread - Normalized external thread (root + replies)
     * @param {number} index - Item index in the rendered list
     * @returns {string} HTML string
     */
    renderExternalThreadItem(thread, index) {
        const source = thread.source || 'github';
        const author = thread.author || 'reviewer';
        // Plain-text snippet of the root body for the title slot. Markdown
        // formatting is stripped so the line stays compact.
        const rawBody = this.stripMarkdown(thread.body || '');
        const snippet = this.truncateText(rawBody, 80);

        const fileName = thread.file ? thread.file.split('/').pop() : null;
        const lineNum = thread.line_start;
        // File-level threads (GitHub subject_type='file') have no line — label
        // them "(file)" like native file-level comments instead of a line no.
        const isFileLevel = thread.is_file_level === 1 || thread.is_file_level === true;
        const locationSuffix = lineNum ? ':' + lineNum : (isFileLevel ? ' (file)' : '');
        const fullLocation = fileName ? `${fileName}${locationSuffix}` : '';

        const replies = Array.isArray(thread.replies) ? thread.replies : [];
        // Strict count of comments in the thread (root + replies). Always
        // shown — replaces the static author dot to give a left-side anchor
        // that conveys thread size at a glance.
        const totalComments = 1 + replies.length;
        const commentNoun = totalComments === 1 ? 'comment' : 'comments';

        const outdatedClass = thread.is_outdated ? ' is-outdated' : '';

        // Compose the tooltip: author + body snippet for quick context.
        const tooltipBits = [];
        if (author) tooltipBits.push(author);
        if (fullLocation) tooltipBits.push(fullLocation);
        if (rawBody) tooltipBits.push(rawBody.length > 200 ? rawBody.substring(0, 200) + '…' : rawBody);
        const tooltip = tooltipBits.join(' — ');

        const threadId = thread.id != null ? String(thread.id) : '';

        // Chat button — mirrors the finding/comment quick-action pattern.
        // Dispatches threadContext (not commentContext) so the chat receives
        // the full thread + replies, matching the inline header button.
        // External threads carry GitHub-sourced strings (author, body, file,
        // source, id). Anything that lands inside a quoted HTML attribute must
        // be escaped with the attribute-safe helper (escapes ", ', <, >, &) —
        // the local escapeHtml is text-node-only and leaves quotes intact,
        // which would let a crafted body break out of the attribute.
        const attr = window.escapeHtmlAttribute;
        let chatAction = '';
        if (document.documentElement.getAttribute('data-chat') === 'available') {
            chatAction = `
            <div class="finding-chat-action">
                <button class="quick-action-btn quick-action-chat" data-thread-id="${attr(threadId)}" data-source="${attr(source)}" data-item-type="external" title="Chat about thread" aria-label="Chat about thread">
                    <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>
                </button>
            </div>
        `;
        }

        return `
            <div class="finding-item-wrapper">
                <button class="finding-item ai-panel__list-item ai-panel__list-item--external source-${attr(source)}${outdatedClass}" data-index="${index}" data-id="${attr(threadId)}" data-thread-id="${attr(threadId)}" data-source="${attr(source)}" data-file="${attr(thread.file || '')}" data-line="${lineNum != null ? lineNum : ''}" data-item-type="external" title="${attr(tooltip)}">
                    <span class="external-list-count" title="${totalComments} ${commentNoun}" aria-label="${totalComments} ${commentNoun} in thread">${totalComments}</span>
                    <div class="finding-content">
                        <span class="finding-title"><span class="external-list-author">${this.escapeHtml(author)}</span><span class="external-list-snippet">${snippet ? ' — ' + this.escapeHtml(snippet) : ''}</span></span>
                        ${thread.is_outdated ? '<span class="finding-meta"><span class="external-list-outdated-badge">outdated</span></span>' : ''}
                        ${fileName ? `<span class="finding-location">${this.escapeHtml(fileName)}${locationSuffix}</span>` : ''}
                    </div>
                </button>
                ${chatAction}
            </div>
        `;
    }

    /**
     * Get the comment-ai Octicon SVG for AI-adopted comments
     * @returns {string} SVG HTML string
     */
    getCommentAIIcon() {
        return `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
            <path d="M7.75 1a.75.75 0 0 1 0 1.5h-5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2c.199 0 .39.079.53.22.141.14.22.331.22.53v2.19l2.72-2.72a.747.747 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-2a.75.75 0 0 1 1.5 0v2c0 .464-.184.909-.513 1.237A1.746 1.746 0 0 1 13.25 12H9.06l-2.573 2.573A1.457 1.457 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5C1 1.784 1.784 1 2.75 1h5Zm4.519-.837a.248.248 0 0 1 .466 0l.238.648a3.726 3.726 0 0 0 2.218 2.219l.649.238a.249.249 0 0 1 0 .467l-.649.238a3.725 3.725 0 0 0-2.218 2.218l-.238.649a.248.248 0 0 1-.466 0l-.239-.649a3.725 3.725 0 0 0-2.218-2.218l-.649-.238a.249.249 0 0 1 0-.467l.649-.238A3.726 3.726 0 0 0 12.03.811l.239-.648Z"/>
        </svg>`;
    }

    /**
     * Get the person Octicon SVG for user-originated comments
     * @returns {string} SVG HTML string
     */
    getPersonIcon() {
        return `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
            <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
        </svg>`;
    }

    /**
     * Get the adopt (checkmark) icon SVG for quick-action buttons
     * @returns {string} SVG HTML string
     */
    getAdoptIcon() {
        return AIPanel.ICONS.adopt;
    }

    /**
     * Get the dismiss (X) icon SVG for quick-action buttons
     * @returns {string} SVG HTML string
     */
    getDismissIcon() {
        return AIPanel.ICONS.dismiss;
    }

    /**
     * Get the restore (counter-clockwise arrow) icon SVG for quick-action buttons
     * @returns {string} SVG HTML string
     */
    getRestoreIcon() {
        return AIPanel.ICONS.restore;
    }

    /**
     * Update finding status by ID
     * @param {number} findingId - The finding ID
     * @param {string} status - The new status ('dismissed', 'adopted', or 'active')
     */
    updateFindingStatus(findingId, status) {
        // Update in our findings array
        const finding = this.findings.find(f => f.id === findingId);
        if (finding) {
            finding.status = status;
        }

        // Update the DOM directly for performance (avoid full re-render)
        const findingEl = this.findingsList?.querySelector(`[data-id="${findingId}"]`);
        if (findingEl) {
            findingEl.classList.remove('finding-dismissed', 'finding-adopted', 'finding-active');
            if (status === 'dismissed') {
                findingEl.classList.add('finding-dismissed');
            } else if (status === 'adopted') {
                findingEl.classList.add('finding-adopted');
            } else {
                findingEl.classList.add('finding-active');
            }

            // Leaving the dismissed state: strip the stale dismissal-reason line
            // and reset the tooltip to the plain location. renderFindingItem only
            // adds these for dismissed findings, so an in-place status swap must
            // undo them here (the finding may keep a status_reason in the array).
            if (status !== 'dismissed') {
                const reasonSpan = findingEl.querySelector('.finding-dismissal-reason');
                if (reasonSpan) reasonSpan.remove();
                const filePath = finding?.file || findingEl.dataset.file || '';
                const fileName = filePath ? filePath.split('/').pop() : null;
                const lineNum = finding?.line_start || findingEl.dataset.line || '';
                findingEl.title = fileName ? `${fileName}${lineNum ? ':' + lineNum : ''}` : '';
            }

            const wrapper = findingEl.closest('.finding-item-wrapper');
            if (!wrapper) {
                console.warn(`AIPanel.updateFindingStatus: wrapper element not found for finding ${findingId}. DOM structure may have changed.`);
                return;
            }
            const existingQuickActions = wrapper.querySelector('.finding-quick-actions');

            if (status === 'dismissed') {
                // Replace adopt/dismiss buttons with restore button
                if (existingQuickActions) {
                    existingQuickActions.remove();
                }
                const restoreHtml = `
                    <div class="finding-quick-actions">
                        <button class="quick-action-btn quick-action-restore" data-finding-id="${findingId}" title="Restore" aria-label="Restore suggestion">
                            ${this.getRestoreIcon()}
                        </button>
                    </div>
                `;
                wrapper.insertAdjacentHTML('beforeend', restoreHtml);

                // Bind click event for the new restore button
                const restoreBtn = wrapper.querySelector('.quick-action-restore');
                if (restoreBtn) {
                    restoreBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.onRestoreSuggestion(findingId);
                    });
                }
            } else if (status === 'adopted') {
                // Remove all quick-action buttons for adopted findings
                if (existingQuickActions) {
                    existingQuickActions.remove();
                }
            } else if (status === 'active') {
                // Replace restore button with adopt/dismiss buttons
                if (existingQuickActions) {
                    existingQuickActions.remove();
                }
                const activeHtml = `
                    <div class="finding-quick-actions">
                        <button class="quick-action-btn quick-action-adopt" data-finding-id="${findingId}" title="Adopt" aria-label="Adopt suggestion">
                            ${this.getAdoptIcon()}
                        </button>
                        <button class="quick-action-btn quick-action-dismiss" data-finding-id="${findingId}" title="Dismiss" aria-label="Dismiss suggestion">
                            ${this.getDismissIcon()}
                        </button>
                    </div>
                `;
                wrapper.insertAdjacentHTML('beforeend', activeHtml);

                // Bind click events for the new buttons
                const adoptBtn = wrapper.querySelector('.quick-action-adopt');
                const dismissBtn = wrapper.querySelector('.quick-action-dismiss');
                if (adoptBtn) {
                    adoptBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.onAdoptSuggestion(findingId);
                    });
                }
                if (dismissBtn) {
                    dismissBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.onDismissSuggestion(findingId);
                    });
                }
            }
        }
    }

    /**
     * Clear all findings
     */
    clearAllFindings() {
        this.findings = [];
        // NOTE: Do NOT clear this.comments or this.externalThreads here.
        // User comments and external review-comment threads are independent
        // of AI analysis and must persist across analysis runs.
        this.currentIndex = -1; // Reset navigation
        this.updateSegmentCounts();
        this.renderFindings();
        this.resetLevelFilter();

        // Also clear suggestions from the diff view
        document.querySelectorAll('.ai-suggestion-row').forEach(row => row.remove());
    }

    // ========================================
    // Comment Management Methods
    // ========================================

    /**
     * Add a comment to the panel
     * @param {Object} comment - Comment data with id, file, line_start, line_end, body, parent_id, type, title
     */
    addComment(comment) {
        if (!comment || !comment.id) return;

        // Avoid duplicates
        const existingIndex = this.comments.findIndex(c => c.id === comment.id);
        if (existingIndex >= 0) {
            // Update existing comment
            this.comments[existingIndex] = comment;
        } else {
            this.comments.push(comment);
        }

        this.updateSegmentCounts();
        this.renderFindings();
    }

    /**
     * Add multiple comments to the panel (for initial load)
     * @param {Array} comments - Array of comment objects
     */
    setComments(comments) {
        // Save current selection before updating
        this.saveCurrentSelection();

        this.comments = comments || [];
        this.updateSegmentCounts();
        this.renderFindings();

        // Try to restore previous selection, or auto-select first
        if (!this.restoreSelection()) {
            this.autoSelectFirst();
        }
    }

    /**
     * Replace the set of external comment threads displayed in the External
     * segment. Mirrors {@link setComments}: replaces state, recomputes the
     * count badge, re-renders the visible list (if the user is on External
     * or All), and preserves any restorable selection.
     *
     * The panel never owns inline external rows — they live in
     * `.external-comment-row` elements rendered by ExternalCommentManager.
     * Pass the flattened union of `threadsBySource.values()`.
     *
     * @param {Array<Object>} threads - Flattened external threads (roots).
     */
    setExternalThreads(threads) {
        // Save current selection before updating so the active item survives
        // a re-render when its identity is still in the new list.
        this.saveCurrentSelection();

        this.externalThreads = Array.isArray(threads) ? threads : [];
        this.updateSegmentCounts();
        this.renderFindings();

        // Try to restore previous selection, or auto-select first
        if (!this.restoreSelection()) {
            this.autoSelectFirst();
        }
    }

    /**
     * Update an existing comment
     * @param {number} commentId - The comment ID
     * @param {Object} updates - Updated comment properties
     */
    updateComment(commentId, updates) {
        const comment = this.comments.find(c => c.id === commentId);
        if (comment) {
            Object.assign(comment, updates);
            // Note: updateSegmentCounts() counts this.comments.length which won't change
            // when status changes. This is intentional - segment counts show "inbox size"
            // (total items in panel) while SplitButton uses DOM-based counting for
            // submission validation (active comments only). We still call it here to
            // trigger any button state updates (e.g., enabling/disabling).
            this.updateSegmentCounts();
            this.renderFindings();
        }
    }

    /**
     * Remove a comment from the panel
     * @param {number} commentId - The comment ID to remove
     */
    removeComment(commentId) {
        const index = this.comments.findIndex(c => c.id === commentId);
        if (index >= 0) {
            this.comments.splice(index, 1);
            this.updateSegmentCounts();
            this.renderFindings();
        }
    }

    /**
     * Truncate text to a maximum length
     */
    truncateText(text, maxLength) {
        if (!text) return '';
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength) + '...';
    }

    /**
     * Strip common markdown formatting from text for display
     * Removes **bold**, *italic*, `code`, and emoji prefixes
     * @param {string} text - Text to strip
     * @returns {string} Plain text
     */
    stripMarkdown(text) {
        if (!text) return '';
        return text
            .replace(/^\s*[\u{1F300}-\u{1F9FF}]\s*/u, '') // Remove leading emoji
            .replace(/\*\*([^*]+)\*\*/g, '$1')  // **bold** -> bold
            .replace(/\*([^*]+)\*/g, '$1')      // *italic* -> italic
            .replace(/__([^_]+)__/g, '$1')      // __bold__ -> bold
            .replace(/_([^_]+)_/g, '$1')        // _italic_ -> italic
            .replace(/`([^`]+)`/g, '$1')        // `code` -> code
            .replace(/^#+\s+/, '')              // # Header -> Header
            .trim();
    }

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ========================================
    // Navigation Methods
    // ========================================

    /**
     * Setup keyboard navigation (j/k keys)
     */
    setupKeyboardNavigation() {
        document.addEventListener('keydown', (e) => {
            // Don't navigate when typing in input fields
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }

            // Don't navigate when a modal is open
            if (document.querySelector('.modal.show, .comment-form-overlay, [role="dialog"]:not([hidden])')) {
                return;
            }

            // Don't navigate when panel is collapsed
            if (this.isCollapsed) {
                return;
            }

            if (e.key === 'j' && !e.metaKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault();
                this.goToNext();
            } else if (e.key === 'k' && !e.metaKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault();
                this.goToPrevious();
            }
        });
    }

    /**
     * Update the findings header with navigation controls and counter
     * Hides the entire navigation section when there are no items
     */
    updateFindingsHeader(totalCount) {
        const items = this.getFilteredItems();
        const itemCount = items.length;
        const currentDisplay = this.currentIndex >= 0 ? (this.currentIndex + 1) : '\u2014';

        // Target the .findings-nav slot only; the sibling .findings-header-actions
        // (refresh button in PR mode) must persist across re-renders so its
        // statically-bound click handler stays valid.
        const navContainer = document.getElementById('findings-nav')
            || document.querySelector('.findings-nav');
        if (!navContainer) return;

        // Empty state: blank the nav slot so it collapses, but leave the
        // sibling actions container alone. The refresh button stays available
        // even when there are zero items (the reviewer may want to fetch).
        if (itemCount === 0) {
            navContainer.innerHTML = '';
            this.findingsCount = null;
            return;
        }

        navContainer.innerHTML = `
            <button class="findings-nav-btn nav-prev" title="Previous item (k)">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                    <path d="M3.22 9.78a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0l4.25 4.25a.75.75 0 01-1.06 1.06L8 6.06 4.28 9.78a.75.75 0 01-1.06 0z"/>
                </svg>
            </button>
            <span class="findings-counter" id="findings-count">${currentDisplay} of ${itemCount}</span>
            <button class="findings-nav-btn nav-next" title="Next item (j)">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                    <path d="M12.78 6.22a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06 0L3.22 7.28a.75.75 0 011.06-1.06L8 9.94l3.72-3.72a.75.75 0 011.06 0z"/>
                </svg>
            </button>
        `;

        this.findingsCount = navContainer.querySelector('#findings-count');

        const prevBtn = navContainer.querySelector('.nav-prev');
        const nextBtn = navContainer.querySelector('.nav-next');
        if (prevBtn) {
            prevBtn.addEventListener('click', () => this.goToPrevious());
        }
        if (nextBtn) {
            nextBtn.addEventListener('click', () => this.goToNext());
        }
    }

    /**
     * Navigate to the next item (purely positional through visible items)
     */
    goToNext() {
        const items = this.getFilteredItems();
        if (items.length === 0) return;

        if (this.currentIndex < 0) {
            // No selection yet, go to first
            this.goToIndex(0);
        } else {
            // Go to next item, wrap to start
            this.goToIndex((this.currentIndex + 1) % items.length);
        }
    }

    /**
     * Navigate to the previous item (purely positional through visible items)
     */
    goToPrevious() {
        const items = this.getFilteredItems();
        if (items.length === 0) return;

        if (this.currentIndex < 0) {
            // No selection yet, go to last
            this.goToIndex(items.length - 1);
        } else {
            // Go to previous item, wrap to end
            this.goToIndex(this.currentIndex <= 0 ? items.length - 1 : this.currentIndex - 1);
        }
    }

    /**
     * Navigate to a specific index
     */
    goToIndex(index) {
        const items = this.getFilteredItems();
        if (index < 0 || index >= items.length) return;

        this.currentIndex = index;
        this.highlightCurrentItem();
        this.scrollToCurrentItem();
        this.updateNavigationCounter();
    }

    /**
     * Highlight the current item in the panel list
     */
    highlightCurrentItem() {
        if (!this.findingsList) return;

        // Remove active class from all items
        this.findingsList.querySelectorAll('.finding-item').forEach(item => {
            item.classList.remove('active');
        });

        // Add active class to current item
        if (this.currentIndex >= 0) {
            const currentItem = this.findingsList.querySelector(`[data-index="${this.currentIndex}"]`);
            if (currentItem) {
                currentItem.classList.add('active');
                // Ensure the item is visible in the panel's scroll area
                currentItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    }

    /**
     * Scroll to the current item in the diff view
     */
    scrollToCurrentItem() {
        const items = this.getFilteredItems();
        if (this.currentIndex < 0 || this.currentIndex >= items.length) return;

        const item = items[this.currentIndex];
        const itemId = item.id;
        const file = item.file;
        const line = item.line_start;

        if (item._itemType === 'comment') {
            this.scrollToComment(itemId, file, line, item.side);
        } else if (item._itemType === 'external') {
            this.scrollToExternalThread(itemId, item.source, file, line);
        } else {
            this.scrollToFinding(itemId, file, line, item.side);
        }
    }

    /**
     * Update the navigation counter display
     */
    updateNavigationCounter() {
        const items = this.getFilteredItems();
        const currentDisplay = this.currentIndex >= 0 ? (this.currentIndex + 1) : '\u2014';

        if (this.findingsCount) {
            this.findingsCount.textContent = `${currentDisplay} of ${items.length}`;
        }
    }

    // ========================================
    // AI Summary Methods
    // ========================================

    /**
     * Set AI summary data for the panel
     * @param {Object} data - Summary data { summary, stats }
     */
    setSummaryData(data) {
        this.summaryData = data;
        // Update modal if it exists
        if (window.aiSummaryModal) {
            window.aiSummaryModal.setData(data);
        }
    }

    /**
     * Get AI summary data
     * @returns {Object|null} Summary data or null
     */
    getSummaryData() {
        return this.summaryData;
    }

    /**
     * Get AI summary text
     * @returns {string|null} Summary text or null
     */
    getSummary() {
        return this.summaryData?.summary || null;
    }

    /**
     * Show the AI Summary modal
     */
    showSummaryModal() {
        if (window.aiSummaryModal) {
            window.aiSummaryModal.setData(this.summaryData);
            window.aiSummaryModal.show();
        }
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    window.aiPanel = new AIPanel();
});

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AIPanel };
}
