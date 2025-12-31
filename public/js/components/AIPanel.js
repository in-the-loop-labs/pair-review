/**
 * AIPanel.js - AI Analysis Panel Component
 * Manages the right sidebar panel that displays AI analysis status,
 * findings summary, and review progress.
 */

class AIPanel {
    constructor() {
        this.panel = document.getElementById('ai-panel');
        this.isCollapsed = false;
        this.findings = [];
        this.addressedCount = 0;

        this.initElements();
        this.bindEvents();
    }

    initElements() {
        // Panel elements
        this.closeBtn = document.getElementById('ai-panel-close');
        this.toggleBtn = document.getElementById('ai-panel-toggle');

        // Depth indicators
        this.depthStatus = document.getElementById('depth-status');
        this.depthLevel1 = document.getElementById('depth-level-1');
        this.depthLevel2 = document.getElementById('depth-level-2');
        this.depthLevel3 = document.getElementById('depth-level-3');

        // Findings
        this.findingsCount = document.getElementById('findings-count');
        this.findingsList = document.getElementById('findings-list');

        // Progress
        this.progressCount = document.getElementById('progress-count');
        this.progressFill = document.getElementById('progress-fill');

        // Quick actions
        this.reanalyzeBtn = document.getElementById('reanalyze-btn');
        this.clearSuggestionsBtn = document.getElementById('clear-suggestions-btn');

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

        // Quick actions
        if (this.reanalyzeBtn) {
            this.reanalyzeBtn.addEventListener('click', () => {
                // Trigger re-analysis via analyze button
                const analyzeBtn = document.getElementById('analyze-btn');
                if (analyzeBtn) analyzeBtn.click();
            });
        }

        if (this.clearSuggestionsBtn) {
            this.clearSuggestionsBtn.addEventListener('click', () => {
                this.clearAllFindings();
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
     * Update the analysis depth status
     * @param {number} currentLevel - 0 = not started, 1 = line, 2 = file, 3 = codebase
     * @param {string} status - Status text to display
     */
    updateDepthStatus(currentLevel, status) {
        const isComplete = status.toLowerCase().includes('complete');

        // Update status text
        if (this.depthStatus) {
            this.depthStatus.textContent = status;
            this.depthStatus.classList.toggle('complete', isComplete);
        }

        // Update level indicators
        const levels = [this.depthLevel1, this.depthLevel2, this.depthLevel3];
        levels.forEach((level, index) => {
            if (!level) return;

            // Remove all state classes
            level.classList.remove('complete', 'active', 'depth-level-complete');

            // Determine level state (index is 0-based, levels are 1-based)
            const levelNum = index + 1;
            // When complete, all levels up to currentLevel are done
            // When in progress, levels below currentLevel are done, currentLevel is active
            const isLevelComplete = isComplete ? (levelNum <= currentLevel) : (levelNum < currentLevel);
            const isLevelActive = !isComplete && (levelNum === currentLevel);

            if (isLevelComplete) {
                level.classList.add('complete', 'depth-level-complete');
                // Update icon to checkmark
                const icon = level.querySelector('.depth-level-icon');
                if (icon) {
                    icon.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                        <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
                    </svg>`;
                }
            } else if (isLevelActive) {
                level.classList.add('active');
                // Show pulsing circle for active state
                const icon = level.querySelector('.depth-level-icon');
                if (icon) {
                    icon.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                        <path d="M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/>
                    </svg>`;
                }
            } else {
                // Reset to default empty circle icon
                const icon = level.querySelector('.depth-level-icon');
                if (icon) {
                    icon.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                        <path d="M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/>
                    </svg>`;
                }
            }
        });

        // Update sidebar status
        this.updateSidebarStatus(currentLevel, status);
    }

    /**
     * Update the sidebar AI status indicator
     */
    updateSidebarStatus(currentLevel, status) {
        if (!this.sidebarStatus || !this.sidebarStatusText) return;

        if (currentLevel > 0 && !status.toLowerCase().includes('complete')) {
            this.sidebarStatus.classList.add('analyzing');
            this.sidebarStatusText.textContent = `Analyzing (Level ${currentLevel})...`;
        } else if (status.toLowerCase().includes('complete')) {
            this.sidebarStatus.classList.remove('analyzing');
            this.sidebarStatusText.textContent = 'Analysis complete';
        } else {
            this.sidebarStatus.classList.remove('analyzing');
            this.sidebarStatusText.textContent = 'Ready to analyze';
        }
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
            const location = finding.file ? `${finding.file}${finding.line ? ':' + finding.line : ''}` : 'General';

            return `
                <button class="finding-item finding-${type}" data-index="${index}" data-file="${finding.file || ''}" data-line="${finding.line || ''}">
                    <div class="finding-icon">${iconSvg}</div>
                    <div class="finding-content">
                        <span class="finding-title">${this.escapeHtml(title)}</span>
                        <span class="finding-location">${this.escapeHtml(location)}</span>
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
     * Update review progress
     * @param {number} addressed - Number of addressed suggestions
     * @param {number} total - Total number of suggestions
     */
    updateProgress(addressed, total) {
        this.addressedCount = addressed;

        if (this.progressCount) {
            this.progressCount.textContent = `${addressed} of ${total} addressed`;
        }

        if (this.progressFill) {
            const percentage = total > 0 ? (addressed / total) * 100 : 0;
            this.progressFill.style.width = `${percentage}%`;
        }
    }

    /**
     * Clear all findings
     */
    clearAllFindings() {
        this.findings = [];
        this.renderFindings();
        this.updateFindingsBadge();
        this.updateProgress(0, 0);
        this.updateDepthStatus(0, 'Not started');

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
