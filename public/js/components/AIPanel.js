// SPDX-License-Identifier: GPL-3.0-or-later
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
        this.selectedLevel = 'final';
        this.selectedSegment = 'ai'; // Default to AI segment until PR loads
        this.currentIndex = -1; // Current navigation index
        this.currentPRKey = null; // PR-specific key for localStorage
        this.analysisState = 'unknown'; // 'unknown' | 'loading' | 'complete' | 'none'

        // Track selected item by stable identifier for restoration
        this.selectedItemKey = null; // Format: "file:lineNumber:itemType"

        // Canonical file order for consistent sorting across components
        this.fileOrder = new Map(); // Map of file path -> index

        // Filter toggle state for showing dismissed comments (default: hidden)
        this.showDismissedComments = false;

        this.initElements();
        this.bindEvents();
        this.setupKeyboardNavigation();
        // Don't restore segment on init - wait for setPR() call

        // If panel is collapsed on init, ensure CSS variable reflects that
        if (this.isCollapsed) {
            document.documentElement.style.setProperty('--ai-panel-width', '0px');
        }
    }

    initElements() {
        // Panel elements
        this.closeBtn = document.getElementById('ai-panel-close');
        this.toggleBtn = document.getElementById('ai-panel-toggle');
        this.summaryBtn = document.getElementById('ai-summary-btn');

        // Segment control
        this.segmentControl = document.getElementById('segment-control');
        this.segmentBtns = this.segmentControl?.querySelectorAll('.segment-btn');

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

        // Insert inside segment-control container, after segment-control-inner
        // This positions it on the same row as the segment buttons
        const innerControl = this.segmentControl.querySelector('.segment-control-inner');
        if (innerControl) {
            this.segmentControl.insertBefore(this.filterToggleBtn, innerControl.nextSibling);
        } else {
            // Fallback: append to the segment control container
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
    }

    expand() {
        this.isCollapsed = false;
        if (this.panel) {
            this.panel.classList.remove('collapsed');
        }
        // Restore CSS variable from saved width or default
        const savedWidth = window.PanelResizer?.getSavedWidth('ai-panel')
            || window.PanelResizer?.getDefaultWidth('ai-panel')
            || 320;
        document.documentElement.style.setProperty('--ai-panel-width', `${savedWidth}px`);
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
        this.restoreSegmentSelection();
        this.restoreFilterState();
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
        if (this.findings.length > 0 || this.comments.length > 0) {
            this.renderFindings();
        }
    }

    /**
     * Set the analysis state for empty state display
     * @param {string} state - 'unknown' | 'loading' | 'complete' | 'none'
     */
    setAnalysisState(state) {
        this.analysisState = state;
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

        // Only restore if we have a PR key
        if (this.currentPRKey) {
            const stored = localStorage.getItem(`reviewPanelSegment_${this.currentPRKey}`);
            if (stored) {
                this.selectedSegment = stored;
            } else {
                // Default to 'ai' for new PRs
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
        const line = item.line_start || item.line || 0;
        const type = item._itemType || 'finding';
        return `${file}:${line}:${type}`;
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
     */
    updateSegmentCounts() {
        const aiCount = this.findings.length;
        const commentsCount = this.comments.length;
        const allCount = aiCount + commentsCount;

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
                    }
                    // Dim the count when zero
                    countSpan.classList.toggle('segment-count--zero', count === 0);
                }
            });
        }
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
            case 'all':
            default:
                // Combine findings and comments
                items = [
                    ...this.findings.map(f => ({ ...f, _itemType: 'finding' })),
                    ...this.comments.map(c => ({ ...c, _itemType: 'comment' }))
                ];
                break;
        }

        // Sort by canonical file order, then file-level first, then line number
        return this.sortItemsByFileOrder(items);
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
            const lineA = a.line_start ?? a.line ?? 0;
            const lineB = b.line_start ?? b.line ?? 0;
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
            // Check if this is a comment or a finding
            if (item._itemType === 'comment') {
                return this.renderCommentItem(item, index);
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

        // Handle findings/suggestions
        this.scrollToFinding(itemId, file, line);
    }

    /**
     * Expand a file if it is collapsed
     * @param {string} file - The file path
     * @returns {boolean} True if the file was expanded
     */
    expandFileIfCollapsed(file) {
        if (!file) return false;

        // Find the file wrapper - try exact match first, then partial match
        let fileWrapper = document.querySelector(`[data-file-name="${file}"]`);

        // Fallback: partial path match
        if (!fileWrapper) {
            const allWrappers = document.querySelectorAll('.d2h-file-wrapper');
            for (const wrapper of allWrappers) {
                const wrapperFile = wrapper.dataset.fileName;
                if (wrapperFile && (wrapperFile.includes(file) || file.includes(wrapperFile))) {
                    fileWrapper = wrapper;
                    break;
                }
            }
        }

        if (!fileWrapper) return false;

        // Check if collapsed
        if (fileWrapper.classList.contains('collapsed')) {
            // Use prManager's toggle method if available (keeps state in sync)
            const filePath = fileWrapper.dataset.fileName;
            if (window.prManager?.toggleFileCollapse) {
                window.prManager.toggleFileCollapse(filePath);
            } else {
                // Fallback: directly manipulate the DOM
                fileWrapper.classList.remove('collapsed');
                const header = fileWrapper.querySelector('.d2h-file-header');
                if (header && window.DiffRenderer) {
                    window.DiffRenderer.updateFileHeaderState(header, true);
                }
            }
            return true;
        }

        return false;
    }

    /**
     * Scroll to an AI finding/suggestion in the diff view
     */
    scrollToFinding(findingId, file, line) {
        // Expand the file first if it's collapsed
        const wasExpanded = this.expandFileIfCollapsed(file);

        // Small delay if we expanded to allow DOM to update
        const doScroll = () => {
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
                targetSuggestion.scrollIntoView({ behavior: 'smooth', block: 'center' });
                targetSuggestion.classList.add('current-suggestion');
                setTimeout(() => targetSuggestion.classList.remove('current-suggestion'), 2000);
            }
        };

        if (wasExpanded) {
            // Give the DOM a moment to update after expanding
            setTimeout(doScroll, 50);
        } else {
            doScroll();
        }
    }

    /**
     * Scroll to a user comment in the diff view
     */
    scrollToComment(commentId, file, line) {
        // Expand the file first if it's collapsed
        const wasExpanded = this.expandFileIfCollapsed(file);

        const doScroll = () => {
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

            // For line-level comments, try to find by exact comment ID
            if (!targetElement && commentId) {
                targetElement = document.querySelector(`.user-comment-row[data-comment-id="${commentId}"]`);
            }

            // Fallback: find by file and line if no direct match
            if (!targetElement && file && line) {
                const commentRows = document.querySelectorAll('.user-comment-row');
                for (const row of commentRows) {
                    if (row.dataset.file === file && row.dataset.lineStart === line) {
                        targetElement = row;
                        break;
                    }
                }
            }

            if (targetElement) {
                targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                // Add highlight effect
                const commentDiv = isFileLevel ? targetElement : targetElement.querySelector('.user-comment');
                if (commentDiv) {
                    commentDiv.classList.add('highlight-flash');
                    setTimeout(() => commentDiv.classList.remove('highlight-flash'), 2000);
                }
            }
        };

        if (wasExpanded) {
            // Give the DOM a moment to update after expanding
            setTimeout(doScroll, 50);
        } else {
            doScroll();
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
        const lineNum = finding.line_start || finding.line;
        // Full location for tooltip, filename only for display
        const fullLocation = fileName ? `${fileName}${lineNum ? ':' + lineNum : ''}` : '';
        const statusClass = finding.status === 'dismissed' ? 'finding-dismissed' :
                           finding.status === 'adopted' ? 'finding-adopted' : 'finding-active';
        const category = finding.category || finding.type || '';
        const isActive = finding.status !== 'dismissed' && finding.status !== 'adopted';

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

        return `
            <div class="finding-item-wrapper">
                <button class="finding-item finding-${type} ${statusClass}" data-index="${index}" data-id="${finding.id || ''}" data-file="${finding.file || ''}" data-line="${lineNum || ''}" data-item-type="finding" title="${fullLocation}">
                    ${indicator}
                    <div class="finding-content">
                        <span class="finding-title">${this.escapeHtml(title)}</span>
                        ${category ? `<span class="finding-category">${this.escapeHtml(category)}</span>` : ''}
                        ${fileName ? `<span class="finding-location">${this.escapeHtml(fileName)}</span>` : ''}
                    </div>
                </button>
                ${quickActions}
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
        this.comments = [];
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
     * Update an existing comment
     * @param {number} commentId - The comment ID
     * @param {Object} updates - Updated comment properties
     */
    updateComment(commentId, updates) {
        const comment = this.comments.find(c => c.id === commentId);
        if (comment) {
            Object.assign(comment, updates);
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

        // Always get the .findings-header element directly to avoid parent reference issues
        const headerContainer = document.querySelector('.findings-header');
        if (!headerContainer) return;

        // Hide navigation section entirely when there are no items
        if (itemCount === 0) {
            headerContainer.innerHTML = '';
            this.findingsCount = null;
            return;
        }

        // Update or create the header content (no label - segments already indicate content type)
        headerContainer.innerHTML = `
            <div class="findings-nav">
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
            </div>
        `;

        // Re-bind reference to findings count
        this.findingsCount = headerContainer.querySelector('#findings-count');

        // Bind nav button events
        const prevBtn = headerContainer.querySelector('.nav-prev');
        const nextBtn = headerContainer.querySelector('.nav-next');
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
        const line = item.line_start || item.line;

        if (item._itemType === 'comment') {
            this.scrollToComment(itemId, file, line);
        } else {
            this.scrollToFinding(itemId, file, line);
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
