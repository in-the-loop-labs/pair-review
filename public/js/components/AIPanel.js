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

        this.initElements();
        this.bindEvents();
        this.setupKeyboardNavigation();
        // Don't restore segment on init - wait for setPR() call
    }

    initElements() {
        // Panel elements
        this.closeBtn = document.getElementById('ai-panel-close');
        this.toggleBtn = document.getElementById('ai-panel-toggle');

        // Segment control
        this.segmentControl = document.getElementById('segment-control');
        this.segmentBtns = this.segmentControl?.querySelectorAll('.segment-btn');

        // Level filter
        this.levelFilter = document.getElementById('level-filter');
        this.levelPills = this.levelFilter?.querySelectorAll('.level-pill');

        // Findings
        this.findingsCount = document.getElementById('findings-count');
        this.findingsList = document.getElementById('findings-list');
    }

    bindEvents() {
        // Panel toggle
        if (this.closeBtn) {
            this.closeBtn.addEventListener('click', () => this.collapse());
        }

        if (this.toggleBtn) {
            this.toggleBtn.addEventListener('click', () => this.toggle());
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
    }

    expand() {
        this.isCollapsed = false;
        if (this.panel) {
            this.panel.classList.remove('collapsed');
        }
    }

    /**
     * Set the current PR for PR-specific storage
     * Call this when a PR loads to restore segment selection for that specific PR
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {number} number - PR number
     */
    setPR(owner, repo, number) {
        this.currentPRKey = `${owner}/${repo}#${number}`;
        this.restoreSegmentSelection();
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
        this.analysisState = suggestions?.length > 0 ? 'complete' : 'none';
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
                    if (segment === 'all') {
                        countSpan.textContent = `(${allCount})`;
                    } else if (segment === 'ai') {
                        countSpan.textContent = `(${aiCount})`;
                    } else if (segment === 'comments') {
                        countSpan.textContent = `(${commentsCount})`;
                    }
                }
            });
        }
    }

    /**
     * Get items to display based on selected segment
     * @returns {Array} Array of items with an added _itemType property
     */
    getFilteredItems() {
        switch (this.selectedSegment) {
            case 'ai':
                return this.findings.map(f => ({ ...f, _itemType: 'finding' }));
            case 'comments':
                return this.comments.map(c => ({ ...c, _itemType: 'comment' }));
            case 'all':
            default:
                // Combine findings and comments, sorted by file and line for logical grouping
                const allItems = [
                    ...this.findings.map(f => ({ ...f, _itemType: 'finding' })),
                    ...this.comments.map(c => ({ ...c, _itemType: 'comment' }))
                ];
                // Sort by file, then by line number
                return allItems.sort((a, b) => {
                    const fileA = a.file || '';
                    const fileB = b.file || '';
                    if (fileA !== fileB) return fileA.localeCompare(fileB);
                    const lineA = a.line_start || a.line || 0;
                    const lineB = b.line_start || b.line || 0;
                    return lineA - lineB;
                });
        }
    }

    renderFindings() {
        if (!this.findingsList) return;

        const items = this.getFilteredItems();

        // Show empty state based on segment and analysis state
        if (items.length === 0) {
            let emptyContent;
            if (this.selectedSegment === 'comments') {
                emptyContent = `<p>No comments yet.</p><p class="empty-action">Click the <strong>+</strong> button next to any line to add a comment.</p>`;
            } else if (this.selectedSegment === 'ai') {
                // Show different states based on analysis status
                if (this.analysisState === 'loading') {
                    emptyContent = `
                        <div class="loading-indicator">
                            <div class="loading-spinner-small"></div>
                            <p>Analyzing PR...</p>
                        </div>
                    `;
                } else if (this.analysisState === 'complete' || this.analysisState === 'none') {
                    emptyContent = `<p>No AI suggestions for this PR.</p>`;
                } else {
                    // 'unknown' state - analysis hasn't been run yet
                    emptyContent = `<p>No AI analysis yet.</p><p class="empty-action">Click <strong>Analyze</strong> to get started.</p>`;
                }
            } else {
                emptyContent = `<p>No items yet.</p><p class="empty-action">Click <strong>Analyze</strong> for AI suggestions or add comments in the diff view.</p>`;
            }

            this.findingsList.innerHTML = `
                <div class="findings-empty">
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

        // Bind delete button events for comments
        this.findingsList.querySelectorAll('.finding-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent triggering item click
                const commentId = parseInt(btn.dataset.commentId, 10);
                this.onDeleteComment(commentId);
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
     * Scroll to an AI finding/suggestion in the diff view
     */
    scrollToFinding(findingId, file, line) {
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
    }

    /**
     * Scroll to a user comment in the diff view
     */
    scrollToComment(commentId, file, line) {
        let targetComment = null;

        // First, try to find by exact comment ID (most reliable)
        if (commentId) {
            targetComment = document.querySelector(`.user-comment-row[data-comment-id="${commentId}"]`);
        }

        // Fallback: find by file and line if no direct match
        if (!targetComment && file && line) {
            const commentRows = document.querySelectorAll('.user-comment-row');
            for (const row of commentRows) {
                if (row.dataset.file === file && row.dataset.lineStart === line) {
                    targetComment = row;
                    break;
                }
            }
        }

        if (targetComment) {
            targetComment.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Add highlight effect
            const commentDiv = targetComment.querySelector('.user-comment');
            if (commentDiv) {
                commentDiv.classList.add('highlight-flash');
                setTimeout(() => commentDiv.classList.remove('highlight-flash'), 2000);
            }
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

        // Use star icon for praise, dot for other types
        const indicator = type === 'praise'
            ? `<span class="finding-star">${this.getTypeIcon('praise')}</span>`
            : `<span class="finding-dot"></span>`;

        return `
            <button class="finding-item finding-${type} ${statusClass}" data-index="${index}" data-id="${finding.id || ''}" data-file="${finding.file || ''}" data-line="${lineNum || ''}" data-item-type="finding" title="${fullLocation}">
                ${indicator}
                <div class="finding-content">
                    <span class="finding-title">${this.escapeHtml(title)}</span>
                    ${category ? `<span class="finding-category">${this.escapeHtml(category)}</span>` : ''}
                    ${fileName ? `<span class="finding-location">${this.escapeHtml(fileName)}</span>` : ''}
                </div>
            </button>
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
        // Full location for tooltip, filename only for display
        const fullLocation = fileName ? `${fileName}${lineNum ? ':' + lineNum : ''}` : '';

        // Choose icon based on whether comment originated from AI (has parent_id) or user
        const icon = comment.parent_id
            ? this.getCommentAIIcon()
            : this.getPersonIcon();

        return `
            <div class="finding-item-wrapper">
                <button class="finding-item finding-comment ${comment.parent_id ? 'comment-ai-origin' : 'comment-user-origin'}" data-index="${index}" data-id="${comment.id || ''}" data-file="${comment.file || ''}" data-line="${lineNum || ''}" data-item-type="comment" title="${fullLocation}">
                    <span class="comment-icon">${icon}</span>
                    <div class="finding-content">
                        <span class="finding-title">${this.escapeHtml(title)}</span>
                        ${fileName ? `<span class="finding-location">${this.escapeHtml(fileName)}</span>` : ''}
                    </div>
                </button>
                <button class="finding-delete-btn" data-comment-id="${comment.id}" title="Delete comment">
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                        <path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19c.9 0 1.652-.681 1.741-1.576l.66-6.6a.75.75 0 00-1.492-.149l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"/>
                    </svg>
                </button>
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
     * Update finding status by ID
     * @param {number} findingId - The finding ID
     * @param {string} status - The new status ('dismissed' or 'adopted')
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
     */
    updateFindingsHeader(totalCount) {
        const items = this.getFilteredItems();
        const itemCount = items.length;
        const currentDisplay = this.currentIndex >= 0 ? (this.currentIndex + 1) : '\u2014';

        // Always get the .findings-header element directly to avoid parent reference issues
        const headerContainer = document.querySelector('.findings-header');
        if (!headerContainer) return;

        // Update or create the header content (no label - segments already indicate content type)
        headerContainer.innerHTML = `
            <div class="findings-nav">
                <button class="findings-nav-btn nav-prev" title="Previous item (k)" ${itemCount === 0 ? 'disabled' : ''}>
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                        <path d="M3.22 9.78a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0l4.25 4.25a.75.75 0 01-1.06 1.06L8 6.06 4.28 9.78a.75.75 0 01-1.06 0z"/>
                    </svg>
                </button>
                <span class="findings-counter" id="findings-count">${currentDisplay} of ${itemCount}</span>
                <button class="findings-nav-btn nav-next" title="Next item (j)" ${itemCount === 0 ? 'disabled' : ''}>
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
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    window.aiPanel = new AIPanel();
});
