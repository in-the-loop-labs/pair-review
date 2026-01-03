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
        this.selectedSegment = 'all';

        this.initElements();
        this.bindEvents();
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
     * Handle segment button selection
     */
    onSegmentSelect(btn) {
        const segment = btn.dataset.segment;
        if (segment === this.selectedSegment) return;

        // Update UI
        this.segmentBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedSegment = segment;

        // Show/hide level filter based on segment
        // Level filter only applies to AI findings
        if (this.levelFilter) {
            if (segment === 'comments') {
                this.levelFilter.classList.add('hidden');
            } else {
                this.levelFilter.classList.remove('hidden');
            }
        }

        // Re-render findings to filter by segment
        this.renderFindings();

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
        this.findings = suggestions || [];
        this.updateSegmentCounts();
        this.renderFindings();
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
     */
    getFilteredItems() {
        switch (this.selectedSegment) {
            case 'ai':
                return this.findings;
            case 'comments':
                return this.comments;
            case 'all':
            default:
                // Combine and return both - for now just findings since comments not implemented
                return this.findings;
        }
    }

    renderFindings() {
        if (!this.findingsList) return;

        const items = this.getFilteredItems();

        // Show empty state based on segment
        if (items.length === 0) {
            let emptyMessage;
            if (this.selectedSegment === 'comments') {
                emptyMessage = 'No comments yet. Add comments using the + button in the diff view.';
            } else if (this.selectedSegment === 'ai') {
                emptyMessage = 'No AI analysis yet. Click "Analyze" to get started.';
            } else {
                emptyMessage = 'No items yet. Click "Analyze" for AI suggestions or add comments in the diff view.';
            }

            this.findingsList.innerHTML = `
                <div class="findings-empty">
                    <p>${emptyMessage}</p>
                </div>
            `;
            if (this.findingsCount) {
                this.findingsCount.textContent = '0 items';
            }
            return;
        }

        if (this.findingsCount) {
            this.findingsCount.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;
        }

        this.findingsList.innerHTML = items.map((finding, index) => {
            const type = this.getFindingType(finding);
            const iconSvg = this.getTypeIcon(type);
            const title = this.truncateText(finding.title || finding.body || 'Suggestion', 40);
            const fileName = finding.file ? finding.file.split('/').pop() : null;
            const lineNum = finding.line_start || finding.line;
            const location = fileName ? `${fileName}${lineNum ? ':' + lineNum : ''}` : '';
            const category = finding.type || finding.category || '';
            const statusClass = finding.status === 'dismissed' ? 'finding-dismissed' :
                               finding.status === 'adopted' ? 'finding-adopted' : 'finding-active';

            return `
                <button class="finding-item finding-${type} ${statusClass}" data-index="${index}" data-id="${finding.id || ''}" data-file="${finding.file || ''}" data-line="${lineNum || ''}" title="${location}">
                    <div class="finding-icon">${iconSvg}</div>
                    <div class="finding-content">
                        <span class="finding-title">${this.escapeHtml(title)}</span>
                        <div class="finding-meta">
                            ${category ? `<span class="finding-category">${this.escapeHtml(category)}</span>` : ''}
                            ${category && location ? '<span class="finding-separator">·</span>' : ''}
                            ${location ? `<span class="finding-location">${this.escapeHtml(location)}</span>` : ''}
                        </div>
                    </div>
                </button>
            `;
        }).join('');

        // Bind click events
        this.findingsList.querySelectorAll('.finding-item').forEach(item => {
            item.addEventListener('click', () => this.onFindingClick(item));
        });
    }

    onFindingClick(item) {
        const findingId = item.dataset.id;
        const file = item.dataset.file;
        const line = item.dataset.line;

        // Remove active state from all
        this.findingsList.querySelectorAll('.finding-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');

        // Scroll to the suggestion in the diff view
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
            default:
                return `<svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                    <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm0 4a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 8 4Zm0 9a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>
                </svg>`;
        }
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
        this.updateSegmentCounts();
        this.renderFindings();
        this.resetLevelFilter();

        // Also clear suggestions from the diff view
        document.querySelectorAll('.ai-suggestion-row').forEach(row => row.remove());
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
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    window.aiPanel = new AIPanel();
});
