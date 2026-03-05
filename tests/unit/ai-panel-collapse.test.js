// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for AIPanel collapsed state persistence and auto-expand behavior.
 *
 * Since AIPanel is a browser-only class (no module exports), we test the method
 * logic by binding the actual implementations to minimal mock objects.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Method implementations extracted from AIPanel.js — kept in sync with the
// production code so that tests verify real logic, not a reimplementation.
// We bind these to mock panel objects in each test.
// ---------------------------------------------------------------------------

/** AIPanel.prototype._getCollapsedStorageKey */
function _getCollapsedStorageKey() {
  if (!this.currentPRKey) return null;
  return `pair-review-panel-collapsed_${this.currentPRKey}`;
}

/** AIPanel.prototype._saveCollapsedState */
function _saveCollapsedState() {
  const key = this._getCollapsedStorageKey();
  if (key) {
    localStorage.setItem(key, this.isCollapsed ? 'true' : 'false');
  }
}

/** AIPanel.prototype._restoreOrCollapsePanel */
function _restoreOrCollapsePanel() {
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

/** AIPanel.prototype.setAnalysisState */
function setAnalysisState(state) {
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

/** AIPanel.prototype.collapse */
function collapse() {
  this.isCollapsed = true;
  if (this.panel) {
    this.panel.classList.add('collapsed');
  }
  document.documentElement.style.setProperty('--ai-panel-width', '0px');
  window.panelGroup?._onReviewVisibilityChanged(false);
  this._saveCollapsedState();
}

/** AIPanel.prototype.expand */
function expand() {
  this.isCollapsed = false;
  if (this.panel) {
    this.panel.classList.remove('collapsed');
  }
  document.documentElement.style.setProperty('--ai-panel-width', `${this.getEffectivePanelWidth()}px`);
  window.panelGroup?._onReviewVisibilityChanged(true);
  this._saveCollapsedState();
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a mock panel with the real methods bound to it. */
function createMockPanel(overrides = {}) {
  const panel = {
    isCollapsed: true,
    currentPRKey: 'owner/repo#1',
    findings: [],
    selectedSegment: 'ai',
    analysisState: 'unknown',
    panel: {
      classList: {
        add: vi.fn(),
        remove: vi.fn(),
        contains: vi.fn(),
      },
    },
    renderFindings: vi.fn(),
    getEffectivePanelWidth: vi.fn(() => 320),
    ...overrides,
  };

  // Bind real method implementations
  panel._getCollapsedStorageKey = _getCollapsedStorageKey.bind(panel);
  panel._saveCollapsedState = _saveCollapsedState.bind(panel);
  panel._restoreOrCollapsePanel = _restoreOrCollapsePanel.bind(panel);
  panel.setAnalysisState = setAnalysisState.bind(panel);
  panel.collapse = collapse.bind(panel);
  panel.expand = expand.bind(panel);

  return panel;
}

// ---------------------------------------------------------------------------
// Globals setup
// ---------------------------------------------------------------------------

let mockLocalStorage;

beforeEach(() => {
  mockLocalStorage = {};

  global.localStorage = {
    getItem: vi.fn((key) => mockLocalStorage[key] ?? null),
    setItem: vi.fn((key, val) => { mockLocalStorage[key] = val; }),
    removeItem: vi.fn((key) => { delete mockLocalStorage[key]; }),
  };

  global.document = {
    documentElement: {
      style: {
        setProperty: vi.fn(),
      },
    },
  };

  global.window = {
    panelGroup: {
      _onReviewVisibilityChanged: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AIPanel collapsed state persistence', () => {
  describe('_getCollapsedStorageKey', () => {
    it('returns key with currentPRKey when set', () => {
      const panel = createMockPanel({ currentPRKey: 'foo/bar#42' });
      expect(panel._getCollapsedStorageKey()).toBe('pair-review-panel-collapsed_foo/bar#42');
    });

    it('returns null when currentPRKey is null', () => {
      const panel = createMockPanel({ currentPRKey: null });
      expect(panel._getCollapsedStorageKey()).toBeNull();
    });
  });

  describe('_saveCollapsedState', () => {
    it('saves "true" when panel is collapsed', () => {
      const panel = createMockPanel({ isCollapsed: true });
      panel._saveCollapsedState();
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'pair-review-panel-collapsed_owner/repo#1',
        'true'
      );
    });

    it('saves "false" when panel is expanded', () => {
      const panel = createMockPanel({ isCollapsed: false });
      panel._saveCollapsedState();
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'pair-review-panel-collapsed_owner/repo#1',
        'false'
      );
    });

    it('does not save when currentPRKey is null', () => {
      const panel = createMockPanel({ currentPRKey: null });
      panel._saveCollapsedState();
      expect(localStorage.setItem).not.toHaveBeenCalled();
    });
  });

  describe('_restoreOrCollapsePanel', () => {
    it('collapses when no saved state exists (new review)', () => {
      const panel = createMockPanel({ isCollapsed: false });
      panel._restoreOrCollapsePanel();
      expect(panel.isCollapsed).toBe(true);
      expect(panel.panel.classList.add).toHaveBeenCalledWith('collapsed');
    });

    it('expands when saved state is "false"', () => {
      mockLocalStorage['pair-review-panel-collapsed_owner/repo#1'] = 'false';
      const panel = createMockPanel({ isCollapsed: true });
      panel._restoreOrCollapsePanel();
      expect(panel.isCollapsed).toBe(false);
      expect(panel.panel.classList.remove).toHaveBeenCalledWith('collapsed');
    });

    it('collapses when saved state is "true"', () => {
      mockLocalStorage['pair-review-panel-collapsed_owner/repo#1'] = 'true';
      const panel = createMockPanel({ isCollapsed: false });
      panel._restoreOrCollapsePanel();
      expect(panel.isCollapsed).toBe(true);
      expect(panel.panel.classList.add).toHaveBeenCalledWith('collapsed');
    });

    it('collapses when currentPRKey is null', () => {
      const panel = createMockPanel({ currentPRKey: null, isCollapsed: false });
      panel._restoreOrCollapsePanel();
      expect(panel.isCollapsed).toBe(true);
    });
  });

  describe('collapse() and expand() save state', () => {
    it('collapse() saves "true" to localStorage', () => {
      const panel = createMockPanel({ isCollapsed: false });
      panel.collapse();
      expect(panel.isCollapsed).toBe(true);
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'pair-review-panel-collapsed_owner/repo#1',
        'true'
      );
    });

    it('expand() saves "false" to localStorage', () => {
      const panel = createMockPanel({ isCollapsed: true });
      panel.expand();
      expect(panel.isCollapsed).toBe(false);
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'pair-review-panel-collapsed_owner/repo#1',
        'false'
      );
    });

    it('collapse() sets CSS variable to 0px', () => {
      const panel = createMockPanel();
      panel.collapse();
      expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
        '--ai-panel-width',
        '0px'
      );
    });

    it('expand() sets CSS variable from getEffectivePanelWidth', () => {
      const panel = createMockPanel({ isCollapsed: true });
      panel.getEffectivePanelWidth = vi.fn(() => 450);
      panel.expand();
      expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
        '--ai-panel-width',
        '450px'
      );
    });

    it('collapse() notifies panelGroup', () => {
      const panel = createMockPanel();
      panel.collapse();
      expect(window.panelGroup._onReviewVisibilityChanged).toHaveBeenCalledWith(false);
    });

    it('expand() notifies panelGroup', () => {
      const panel = createMockPanel({ isCollapsed: true });
      panel.expand();
      expect(window.panelGroup._onReviewVisibilityChanged).toHaveBeenCalledWith(true);
    });
  });

  describe('setAnalysisState auto-expand', () => {
    it('auto-expands when state is "loading" and panel is collapsed', () => {
      const panel = createMockPanel({ isCollapsed: true });
      panel.setAnalysisState('loading');
      expect(panel.isCollapsed).toBe(false);
      expect(panel.analysisState).toBe('loading');
    });

    it('does NOT expand when state is "loading" and panel is already expanded', () => {
      const panel = createMockPanel({ isCollapsed: false });
      // Spy to verify expand is NOT called
      const expandSpy = vi.fn();
      panel.expand = expandSpy;
      panel.setAnalysisState('loading');
      expect(expandSpy).not.toHaveBeenCalled();
      expect(panel.analysisState).toBe('loading');
    });

    it('does NOT expand when state is "complete" and panel is collapsed', () => {
      const panel = createMockPanel({ isCollapsed: true });
      panel.setAnalysisState('complete');
      // Panel should remain collapsed
      expect(panel.isCollapsed).toBe(true);
      expect(panel.analysisState).toBe('complete');
    });

    it('does NOT expand when state is "none"', () => {
      const panel = createMockPanel({ isCollapsed: true });
      panel.setAnalysisState('none');
      expect(panel.isCollapsed).toBe(true);
    });

    it('calls renderFindings when no findings and segment is "ai"', () => {
      const panel = createMockPanel({
        findings: [],
        selectedSegment: 'ai',
        isCollapsed: false,
      });
      panel.setAnalysisState('complete');
      expect(panel.renderFindings).toHaveBeenCalled();
    });

    it('does NOT call renderFindings when findings exist', () => {
      const panel = createMockPanel({
        findings: [{ id: 1 }],
        selectedSegment: 'ai',
        isCollapsed: false,
      });
      panel.setAnalysisState('complete');
      expect(panel.renderFindings).not.toHaveBeenCalled();
    });

    it('does NOT call renderFindings when segment is not "ai"', () => {
      const panel = createMockPanel({
        findings: [],
        selectedSegment: 'user',
        isCollapsed: false,
      });
      panel.setAnalysisState('complete');
      expect(panel.renderFindings).not.toHaveBeenCalled();
    });
  });
});
