// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * AIPanel.js - AI Analysis Panel Component
 * Manages the right sidebar panel that displays AI analysis findings
 * with level filtering and navigation.
 */

class AIPanel {
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
            this.filterToggleBtn.innerHTML = window.Icons.icon('eye', 14, 14);
        } else {
            this.filterToggleBtn.title = 'Show dismissed user comments';
            this.filterToggleBtn.innerHTML = window.Icons.icon('eyeClosed', 14, 14);
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
                this.filterToggleBtn.innerHTML = window.Icons.icon('eye', 14, 14);
            } else {
                this.filterToggleBtn.title = 'Show dismissed user comments';
                this.filterToggleBtn.innerHTML = window.Icons.icon('eyeClosed', 14, 14);
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
        window.panelGroup?._onReviewVisibilityChanged(false);
    }

    expand() {
        this.isCollapsed = false;
        if (this.panel) {
            this.panel.classList.remove('collapsed');
        }
        // Restore CSS variable from saved width or default
        document.documentElement.style.setProperty('--ai-panel-width', `${this.getEffectivePanelWidth()}px`);
        window.panelGroup?._onReviewVisibilityChanged(true);
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
        const line = item.line_start || 0;
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

        // Bind chat button events for AI suggestions and comments
        this.findingsList.querySelectorAll('.quick-action-chat').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent triggering item click
                if (!window.chatPanel) return;

                const findingId = btn.dataset.findingId ? parseInt(btn.dataset.findingId, 10) : null;
                const commentId = btn.dataset.commentId ? parseInt(btn.dataset.commentId, 10) : null;
                const file = btn.dataset.findingFile || '';
                const title = btn.dataset.findingTitle || '';

                // Build context from the finding data
                let suggestionContext = { title, file };

                if (findingId && this.findings) {
                    const finding = this.findings.find(f => f.id === findingId);
                    if (finding) {
                        suggestionContext = {
                            title: finding.title || title,
                            body: finding.body || '',
                            type: finding.type || '',
                            file: finding.file || file,
                            line_start: finding.line_start || null,
                            line_end: finding.line_end || null,
                            side: 'RIGHT',
                            reasoning: null
                        };
                    }
                }

                window.chatPanel.open({
                    reviewId: window.prManager?.currentPR?.id,
                    suggestionId: findingId ? String(findingId) : (commentId ? String(commentId) : undefined),
                    suggestionContext
                });
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
                return window.Icons.icon('alertFilled', 12, 12);
            case 'praise':
                return window.Icons.icon('star', 12, 12);
            case 'comment':
                return window.Icons.icon('comment', 12, 12);
            default:
                return window.Icons.icon('infoFilled', 12, 12);
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
                return window.Icons.icon('sparkleSmall', 32, 32);
            case 'check':
                // Check circle icon for "No issues found"
                return window.Icons.icon('checkCircleFill', 32, 32);
            case 'comment':
                // Comment bubble icon for "No comments yet"
                return window.Icons.icon('comment', 32, 32);
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
                    ${window.Icons.icon('check', 14, 14)}
                </button>
                <button class="quick-action-btn quick-action-dismiss" data-finding-id="${finding.id}" title="Dismiss" aria-label="Dismiss suggestion">
                    ${window.Icons.icon('close', 14, 14)}
                </button>
            </div>
        `;
        } else if (finding.status === 'dismissed') {
            // Restore button for dismissed findings - undo/restore icon (counter-clockwise arrow)
            quickActions = `
            <div class="finding-quick-actions">
                <button class="quick-action-btn quick-action-restore" data-finding-id="${finding.id}" title="Restore" aria-label="Restore suggestion">
                    ${window.Icons.icon('restore', 14, 14)}
                </button>
            </div>
        `;
        }

        // Chat button for active and dismissed findings (upper-right corner)
        let chatAction = '';
        if (finding.status !== 'adopted' && document.documentElement.getAttribute('data-chat') === 'available') {
            chatAction = `
            <div class="finding-chat-action">
                <button class="quick-action-btn quick-action-chat" data-finding-id="${finding.id}" data-finding-file="${finding.file || ''}" data-finding-title="${this.escapeHtml(title)}" title="Chat" aria-label="Chat about suggestion">
                    ${window.Icons.icon('discussion', 12, 12)}
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
            ? window.Icons.icon('commentAi', 14, 14)
            : window.Icons.icon('person', 14, 14);

        // Build status class
        const dismissedClass = isDismissed ? ' comment-item-dismissed' : '';

        // Action button: restore for dismissed, delete for active
        // Dismissed comments use .finding-quick-actions wrapper for consistent hover-to-show behavior
        let actionButton;
        if (isDismissed) {
            actionButton = `
                <div class="finding-quick-actions">
                    <button class="quick-action-btn quick-action-restore-comment" data-comment-id="${comment.id}" title="Restore comment" aria-label="Restore comment">
                        ${window.Icons.icon('restore', 14, 14)}
                    </button>
                </div>
            `;
        } else {
            // Active comments use same hover-to-show pattern with X icon like AI suggestions
            actionButton = `
                <div class="finding-quick-actions">
                    <button class="quick-action-btn quick-action-dismiss-comment" data-comment-id="${comment.id}" title="Dismiss comment" aria-label="Dismiss comment">
                        ${window.Icons.icon('close', 14, 14)}
                    </button>
                </div>
            `;
        }

        // Chat button for active AI-originated comments
        let chatAction = '';
        if (!isDismissed && comment.parent_id && document.documentElement.getAttribute('data-chat') === 'available') {
            chatAction = `
            <div class="finding-chat-action">
                <button class="quick-action-btn quick-action-chat" data-comment-id="${comment.id}" data-finding-file="${comment.file || ''}" data-finding-title="${this.escapeHtml(title)}" title="Chat" aria-label="Chat about comment">
                    ${window.Icons.icon('discussion', 12, 12)}
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
                            ${window.Icons.icon('restore', 14, 14)}
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
                            ${window.Icons.icon('check', 14, 14)}
                        </button>
                        <button class="quick-action-btn quick-action-dismiss" data-finding-id="${findingId}" title="Dismiss" aria-label="Dismiss suggestion">
                            ${window.Icons.icon('close', 14, 14)}
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
                    ${window.Icons.icon('chevronUp', 12, 12)}
                </button>
                <span class="findings-counter" id="findings-count">${currentDisplay} of ${itemCount}</span>
                <button class="findings-nav-btn nav-next" title="Next item (j)">
                    ${window.Icons.icon('chevronDown', 12, 12)}
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
        const line = item.line_start;

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
