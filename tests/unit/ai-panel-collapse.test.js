// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for AIPanel collapsed state persistence and auto-expand behavior.
 *
 * Uses Object.create(AIPanel.prototype) to test the actual production methods
 * without triggering the constructor's DOM dependencies.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Minimal globals required for AIPanel module to load
global.window = {};
global.document = {
  getElementById: vi.fn(() => null),
  addEventListener: vi.fn(),
  createElement: vi.fn(() => ({
    className: '', innerHTML: '', title: '',
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    setAttribute: vi.fn(),
    addEventListener: vi.fn(),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    insertBefore: vi.fn(),
    appendChild: vi.fn(),
  })),
  documentElement: { style: { setProperty: vi.fn() } },
  querySelector: vi.fn(() => null),
  querySelectorAll: vi.fn(() => []),
  dispatchEvent: vi.fn(),
};
global.localStorage = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
};
global.CustomEvent = class CustomEvent {};

// Import the actual AIPanel class from production code
const { AIPanel } = require('../../public/js/components/AIPanel.js');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let mockLocalStorage;

/**
 * Create a minimal AIPanel instance via Object.create to skip
 * the constructor's DOM initialization.
 */
function createTestPanel(overrides = {}) {
  const panel = Object.create(AIPanel.prototype);

  // Set essential properties that the constructor would normally set
  panel.isCollapsed = true;
  panel.currentPRKey = 'owner/repo#1';
  panel.findings = [];
  panel.selectedSegment = 'ai';
  panel.analysisState = 'unknown';
  panel.panel = {
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
      contains: vi.fn(),
    },
  };
  panel.renderFindings = vi.fn();
  panel.getEffectivePanelWidth = vi.fn(() => 320);

  // Apply overrides
  Object.assign(panel, overrides);
  return panel;
}

beforeEach(() => {
  mockLocalStorage = {};

  global.localStorage = {
    getItem: vi.fn((key) => mockLocalStorage[key] ?? null),
    setItem: vi.fn((key, val) => { mockLocalStorage[key] = val; }),
    removeItem: vi.fn((key) => { delete mockLocalStorage[key]; }),
  };

  global.document = {
    ...global.document,
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
      const panel = createTestPanel({ currentPRKey: 'foo/bar#42' });
      expect(panel._getCollapsedStorageKey()).toBe('pair-review-panel-collapsed_foo/bar#42');
    });

    it('returns null when currentPRKey is null', () => {
      const panel = createTestPanel({ currentPRKey: null });
      expect(panel._getCollapsedStorageKey()).toBeNull();
    });
  });

  describe('_saveCollapsedState', () => {
    it('saves "true" when panel is collapsed', () => {
      const panel = createTestPanel({ isCollapsed: true });
      panel._saveCollapsedState();
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'pair-review-panel-collapsed_owner/repo#1',
        'true'
      );
    });

    it('saves "false" when panel is expanded', () => {
      const panel = createTestPanel({ isCollapsed: false });
      panel._saveCollapsedState();
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'pair-review-panel-collapsed_owner/repo#1',
        'false'
      );
    });

    it('does not save when currentPRKey is null', () => {
      const panel = createTestPanel({ currentPRKey: null });
      panel._saveCollapsedState();
      expect(localStorage.setItem).not.toHaveBeenCalled();
    });
  });

  describe('_restoreOrCollapsePanel', () => {
    it('collapses when no saved state exists (new review)', () => {
      const panel = createTestPanel({ isCollapsed: false });
      panel._restoreOrCollapsePanel();
      expect(panel.isCollapsed).toBe(true);
      expect(panel.panel.classList.add).toHaveBeenCalledWith('collapsed');
    });

    it('expands when saved state is "false"', () => {
      mockLocalStorage['pair-review-panel-collapsed_owner/repo#1'] = 'false';
      const panel = createTestPanel({ isCollapsed: true });
      panel._restoreOrCollapsePanel();
      expect(panel.isCollapsed).toBe(false);
      expect(panel.panel.classList.remove).toHaveBeenCalledWith('collapsed');
    });

    it('collapses when saved state is "true"', () => {
      mockLocalStorage['pair-review-panel-collapsed_owner/repo#1'] = 'true';
      const panel = createTestPanel({ isCollapsed: false });
      panel._restoreOrCollapsePanel();
      expect(panel.isCollapsed).toBe(true);
      expect(panel.panel.classList.add).toHaveBeenCalledWith('collapsed');
    });

    it('collapses when currentPRKey is null', () => {
      const panel = createTestPanel({ currentPRKey: null, isCollapsed: false });
      panel._restoreOrCollapsePanel();
      expect(panel.isCollapsed).toBe(true);
    });
  });

  describe('collapse() and expand() save state', () => {
    it('collapse() saves "true" to localStorage', () => {
      const panel = createTestPanel({ isCollapsed: false });
      panel.collapse();
      expect(panel.isCollapsed).toBe(true);
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'pair-review-panel-collapsed_owner/repo#1',
        'true'
      );
    });

    it('expand() saves "false" to localStorage', () => {
      const panel = createTestPanel({ isCollapsed: true });
      panel.expand();
      expect(panel.isCollapsed).toBe(false);
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'pair-review-panel-collapsed_owner/repo#1',
        'false'
      );
    });

    it('collapse() sets CSS variable to 0px', () => {
      const panel = createTestPanel();
      panel.collapse();
      expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
        '--ai-panel-width',
        '0px'
      );
    });

    it('expand() sets CSS variable from getEffectivePanelWidth', () => {
      const panel = createTestPanel({ isCollapsed: true });
      panel.getEffectivePanelWidth = vi.fn(() => 450);
      panel.expand();
      expect(document.documentElement.style.setProperty).toHaveBeenCalledWith(
        '--ai-panel-width',
        '450px'
      );
    });

    it('collapse() notifies panelGroup', () => {
      const panel = createTestPanel();
      panel.collapse();
      expect(window.panelGroup._onReviewVisibilityChanged).toHaveBeenCalledWith(false);
    });

    it('expand() notifies panelGroup', () => {
      const panel = createTestPanel({ isCollapsed: true });
      panel.expand();
      expect(window.panelGroup._onReviewVisibilityChanged).toHaveBeenCalledWith(true);
    });
  });

  describe('setAnalysisState auto-expand', () => {
    it('auto-expands when state is "loading" and panel is collapsed', () => {
      const panel = createTestPanel({ isCollapsed: true });
      panel.setAnalysisState('loading');
      expect(panel.isCollapsed).toBe(false);
      expect(panel.analysisState).toBe('loading');
    });

    it('does NOT expand when state is "loading" and panel is already expanded', () => {
      const panel = createTestPanel({ isCollapsed: false });
      const expandSpy = vi.fn();
      panel.expand = expandSpy;
      panel.setAnalysisState('loading');
      expect(expandSpy).not.toHaveBeenCalled();
      expect(panel.analysisState).toBe('loading');
    });

    it('does NOT expand when state is "complete" and panel is collapsed', () => {
      const panel = createTestPanel({ isCollapsed: true });
      panel.setAnalysisState('complete');
      expect(panel.isCollapsed).toBe(true);
      expect(panel.analysisState).toBe('complete');
    });

    it('does NOT expand when state is "none"', () => {
      const panel = createTestPanel({ isCollapsed: true });
      panel.setAnalysisState('none');
      expect(panel.isCollapsed).toBe(true);
    });

    it('calls renderFindings when no findings and segment is "ai"', () => {
      const panel = createTestPanel({
        findings: [],
        selectedSegment: 'ai',
        isCollapsed: false,
      });
      panel.setAnalysisState('complete');
      expect(panel.renderFindings).toHaveBeenCalled();
    });

    it('does NOT call renderFindings when findings exist', () => {
      const panel = createTestPanel({
        findings: [{ id: 1 }],
        selectedSegment: 'ai',
        isCollapsed: false,
      });
      panel.setAnalysisState('complete');
      expect(panel.renderFindings).not.toHaveBeenCalled();
    });

    it('does NOT call renderFindings when segment is not "ai"', () => {
      const panel = createTestPanel({
        findings: [],
        selectedSegment: 'user',
        isCollapsed: false,
      });
      panel.setAnalysisState('complete');
      expect(panel.renderFindings).not.toHaveBeenCalled();
    });
  });
});
