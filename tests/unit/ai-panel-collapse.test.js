// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
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
      getAttribute: vi.fn((name) => (name === 'data-chat' ? 'available' : null)),
      style: {
        setProperty: vi.fn(),
      },
    },
  };

  global.window = {
    chatPanel: { open: vi.fn() },
    prManager: { currentPR: { id: 123 } },
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

  describe('clearAllFindings preserves user comments', () => {
    it('clears AI findings but preserves user comments', () => {
      const panel = createTestPanel({
        findings: [{ id: 1, title: 'AI suggestion' }],
        comments: [
          { id: 10, body: 'user comment 1' },
          { id: 11, body: 'user comment 2' },
        ],
      });
      panel.segmentBtns = [];
      panel.resetLevelFilter = vi.fn();
      global.document.querySelectorAll = vi.fn(() => []);

      panel.clearAllFindings();

      expect(panel.findings).toEqual([]);
      expect(panel.comments).toEqual([
        { id: 10, body: 'user comment 1' },
        { id: 11, body: 'user comment 2' },
      ]);
    });

    it('resets navigation index when clearing findings', () => {
      const panel = createTestPanel({
        findings: [{ id: 1 }],
        comments: [],
        currentIndex: 3,
      });
      panel.segmentBtns = [];
      panel.resetLevelFilter = vi.fn();
      global.document.querySelectorAll = vi.fn(() => []);

      panel.clearAllFindings();

      expect(panel.currentIndex).toBe(-1);
    });
  });

  describe('comment chat actions', () => {
    it('renders a chat button for active user-originated comments', () => {
      const panel = createTestPanel();

      const html = panel.renderCommentItem({
        id: 7,
        body: 'Please tighten this check',
        file: 'src/app.js',
        line_start: 12,
        status: 'active',
      }, 0);

      expect(html).toContain('quick-action-chat');
      expect(html).toContain('data-comment-id="7"');
    });

    it('does not render a chat button for dismissed user comments', () => {
      const panel = createTestPanel();

      const html = panel.renderCommentItem({
        id: 7,
        body: 'Please tighten this check',
        file: 'src/app.js',
        line_start: 12,
        status: 'inactive',
      }, 0);

      expect(html).not.toContain('quick-action-chat');
    });

    it('opens chat with commentContext for line-level user comments', () => {
      const panel = createTestPanel({
        comments: [{
          id: 7,
          body: 'Please tighten this check',
          file: 'src/app.js',
          line_start: 12,
          line_end: 14,
          status: 'active',
          parent_id: null,
        }],
      });

      panel.openQuickActionChat({
        dataset: {
          commentId: '7',
        },
      });

      expect(window.chatPanel.open).toHaveBeenCalledWith({
        reviewId: 123,
        commentContext: {
          commentId: '7',
          body: 'Please tighten this check',
          file: 'src/app.js',
          line_start: 12,
          line_end: 14,
          parentId: null,
          source: 'user',
          isFileLevel: false,
        },
      });
    });

    it('opens chat with commentContext for file-level user comments', () => {
      const panel = createTestPanel({
        comments: [{
          id: 9,
          body: 'This file needs a follow-up pass',
          file: 'src/app.js',
          line_start: null,
          line_end: null,
          status: 'active',
          is_file_level: 1,
          parent_id: null,
        }],
      });

      panel.openQuickActionChat({
        dataset: {
          commentId: '9',
        },
      });

      expect(window.chatPanel.open).toHaveBeenCalledWith({
        reviewId: 123,
        commentContext: {
          commentId: '9',
          body: 'This file needs a follow-up pass',
          file: 'src/app.js',
          line_start: null,
          line_end: null,
          parentId: null,
          source: 'user',
          isFileLevel: true,
        },
      });
    });

    it('preserves parentId for adopted comments', () => {
      const panel = createTestPanel({
        comments: [{
          id: 10,
          body: 'Adjusted adopted comment text',
          file: 'src/app.js',
          line_start: 18,
          line_end: 18,
          status: 'active',
          parent_id: 42,
        }],
      });

      panel.openQuickActionChat({
        dataset: {
          commentId: '10',
        },
      });

      expect(window.chatPanel.open).toHaveBeenCalledWith({
        reviewId: 123,
        commentContext: {
          commentId: '10',
          body: 'Adjusted adopted comment text',
          file: 'src/app.js',
          line_start: 18,
          line_end: 18,
          parentId: 42,
          source: 'user',
          isFileLevel: false,
        },
      });
    });

    it('normalizes empty dataset parentId to null for user comments', () => {
      const panel = createTestPanel({
        comments: [],
      });

      panel.openQuickActionChat({
        dataset: {
          commentId: '12',
          commentFile: 'src/app.js',
          commentLineStart: '5',
          commentLineEnd: '5',
          commentParentId: '',
        },
      });

      expect(window.chatPanel.open).toHaveBeenCalledWith({
        reviewId: 123,
        commentContext: {
          commentId: '12',
          body: '',
          file: 'src/app.js',
          line_start: 5,
          line_end: 5,
          parentId: null,
          source: 'user',
          isFileLevel: false,
        },
      });
    });

    it('keeps suggestion chat behavior for AI findings', () => {
      const panel = createTestPanel({
        findings: [{
          id: 5,
          title: 'Null guard missing',
          formattedBody: 'Check for null before accessing name',
          type: 'bug',
          file: 'src/app.js',
          line_start: 21,
          line_end: 21,
        }],
      });

      panel.openQuickActionChat({
        dataset: {
          findingId: '5',
          findingFile: 'src/app.js',
          findingTitle: 'Null guard missing',
        },
      });

      expect(window.chatPanel.open).toHaveBeenCalledWith({
        reviewId: 123,
        suggestionId: '5',
        suggestionContext: {
          suggestionId: '5',
          title: 'Null guard missing',
          body: 'Check for null before accessing name',
          type: 'bug',
          file: 'src/app.js',
          line_start: 21,
          line_end: 21,
          side: 'RIGHT',
          reasoning: null,
        },
      });
    });

    it('opens adopted findings as commentContext when linked comment exists', () => {
      const panel = createTestPanel({
        findings: [{
          id: 42,
          title: 'Original AI suggestion title',
          formattedBody: 'Original AI suggestion body',
          type: 'bug',
          file: 'src/app.js',
          line_start: 18,
          line_end: 18,
          status: 'adopted',
        }],
        comments: [{
          id: 10,
          body: 'Adjusted adopted comment text',
          file: 'src/app.js',
          line_start: 18,
          line_end: 18,
          status: 'active',
          parent_id: 42,
        }],
      });

      panel.openQuickActionChat({
        dataset: {
          findingId: '42',
          findingFile: 'src/app.js',
          findingTitle: 'Original AI suggestion title',
        },
      });

      expect(window.chatPanel.open).toHaveBeenCalledWith({
        reviewId: 123,
        commentContext: {
          commentId: '10',
          body: 'Adjusted adopted comment text',
          file: 'src/app.js',
          line_start: 18,
          line_end: 18,
          parentId: 42,
          source: 'user',
          isFileLevel: false,
        },
      });
    });

    it('prefers the active adopted comment over inactive history for adopted findings', () => {
      const panel = createTestPanel({
        findings: [{
          id: 42,
          title: 'Original AI suggestion title',
          formattedBody: 'Original AI suggestion body',
          type: 'bug',
          file: 'src/app.js',
          line_start: 18,
          line_end: 18,
          status: 'adopted',
        }],
        comments: [{
          id: 10,
          body: 'Old dismissed adopted comment',
          file: 'src/app.js',
          line_start: 18,
          line_end: 18,
          status: 'inactive',
          parent_id: 42,
        }, {
          id: 11,
          body: 'Current active adopted comment',
          file: 'src/app.js',
          line_start: 18,
          line_end: 18,
          status: 'active',
          parent_id: 42,
        }],
      });

      panel.openQuickActionChat({
        dataset: {
          findingId: '42',
          findingFile: 'src/app.js',
          findingTitle: 'Original AI suggestion title',
        },
      });

      expect(window.chatPanel.open).toHaveBeenCalledWith({
        reviewId: 123,
        commentContext: {
          commentId: '11',
          body: 'Current active adopted comment',
          file: 'src/app.js',
          line_start: 18,
          line_end: 18,
          parentId: 42,
          source: 'user',
          isFileLevel: false,
        },
      });
    });
  });

  describe('finding chat actions', () => {
    it('renders a chat button for adopted suggestions', () => {
      const panel = createTestPanel();

      const html = panel.renderFindingItem({
        id: 11,
        title: 'Use stricter validation',
        body: 'Tighten the schema before persisting',
        type: 'bug',
        file: 'src/app.js',
        line_start: 9,
        status: 'adopted',
      }, 0);

      expect(html).toContain('quick-action-chat');
      expect(html).toContain('data-finding-id="11"');
    });
  });
});
