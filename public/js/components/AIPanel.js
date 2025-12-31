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
        this.selectedLevel = 'final';

        this.initElements();
        this.bindEvents();
    }

    initElements() {
        // Panel elements
        this.closeBtn = document.getElementById('ai-panel-close');
        this.toggleBtn = document.getElementById('ai-panel-toggle');

        // Level filter
        this.levelFilter = document.getElementById('level-filter');
        this.levelPills = this.levelFilter?.querySelectorAll('.level-pill');

        // Findings
        this.findingsCount = document.getElementById('findings-count');
        this.findingsList = document.getElementById('findings-list');

        // Sidebar status
        this.sidebarStatus = document.getElementById('ai-sidebar-status');
        this.sidebarStatusText = document.getElementById('ai-status-text');
        this.findingsBadge = document.getElementById('ai-findings-badge');
    }

    bindEvents() {
        // Panel toggle
        if (this.closeBtn) {
            this.closeBtn.addEventListener('click', () => this.collapse());
        }

        if (this.toggleBtn) {
            this.toggleBtn.addEventListener('click', () => this.toggle());
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
        this.renderFindings();
        this.updateFindingsBadge();
    }

    renderFindings() {
        if (!this.findingsList) return;

        if (this.findings.length === 0) {
            this.findingsList.innerHTML = `
                <div class="findings-empty">
                    <p>No AI analysis yet. Click "Analyze" to get started.</p>
                </div>
            `;
            if (this.findingsCount) {
                this.findingsCount.textContent = '0 items';
            }
            return;
        }

        if (this.findingsCount) {
            this.findingsCount.textContent = `${this.findings.length} item${this.findings.length !== 1 ? 's' : ''}`;
        }

        this.findingsList.innerHTML = this.findings.map((finding, index) => {
            const type = this.getFindingType(finding);
            const iconSvg = this.getTypeIcon(type);
            const title = this.truncateText(finding.title || finding.body || 'Suggestion', 40);
            const fileName = finding.file ? finding.file.split('/').pop() : null;
            const lineNum = finding.line_start || finding.line;
            const location = fileName ? `${fileName}${lineNum ? ':' + lineNum : ''}` : '';
            const category = finding.type || finding.category || '';
            const statusClass = finding.status === 'dismissed' ? 'finding-dismissed' :
                               finding.status === 'adopted' ? 'finding-adopted' : '';

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
        const file = item.dataset.file;
        const line = item.dataset.line;

        // Remove active state from all
        this.findingsList.querySelectorAll('.finding-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');

        // Scroll to the suggestion in the diff view
        if (file) {
            // Try to find the corresponding suggestion element
            const suggestions = document.querySelectorAll('.ai-suggestion');
            for (const suggestion of suggestions) {
                const suggestionFile = suggestion.closest('[data-file-name]')?.dataset?.fileName;
                if (suggestionFile && suggestionFile.includes(file)) {
                    suggestion.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    suggestion.classList.add('current-suggestion');
                    setTimeout(() => suggestion.classList.remove('current-suggestion'), 2000);
                    break;
                }
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
            default:
                return `<svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                    <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm0 4a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 8 4Zm0 9a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>
                </svg>`;
        }
    }

    updateFindingsBadge() {
        if (!this.findingsBadge) return;

        const count = this.findings.length;
        if (count > 0) {
            this.findingsBadge.textContent = count;
            this.findingsBadge.style.display = 'flex';
        } else {
            this.findingsBadge.style.display = 'none';
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
            findingEl.classList.remove('finding-dismissed', 'finding-adopted');
            if (status === 'dismissed') {
                findingEl.classList.add('finding-dismissed');
            } else if (status === 'adopted') {
                findingEl.classList.add('finding-adopted');
            }
        }
    }

    /**
     * Clear all findings
     */
    clearAllFindings() {
        this.findings = [];
        this.renderFindings();
        this.updateFindingsBadge();
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
