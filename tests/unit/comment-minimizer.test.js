// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for CommentMinimizer
 *
 * Tests the minimize-comments mode for the diff view, including:
 * - _findDiffRowFor: backward walk to find parent diff row
 * - _getCommentRowsFor: forward walk to collect comment/suggestion rows
 * - refreshIndicators: lineMap building with correct counts
 * - Toggle expand/collapse: _expandedLines Set and CSS classes
 * - findDiffRowFor (public): locates diff row from child element
 * - expandForElement: expands comments and updates indicator state
 *
 * IMPORTANT: These tests import the actual CommentMinimizer class from
 * production code to ensure tests verify real behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Setup global.window before importing production code
global.window = global.window || {};

const { CommentMinimizer } = require('../../public/js/modules/comment-minimizer.js');

// ---------------------------------------------------------------------------
// DOM Helpers
// ---------------------------------------------------------------------------

/**
 * Build a linked list of table rows (simulating <tbody> children).
 * Each entry is { classes: [...], children: { '.selector': element } }.
 * Returns the array of row objects with previousElementSibling / nextElementSibling set.
 */
function buildRows(specs) {
  const rows = specs.map((spec) => {
    const classSet = new Set(spec.classes || []);
    const childElements = spec.children || {};
    const innerHTML = spec.innerHTML || '';

    const row = {
      _tag: 'tr',
      _spec: spec,
      classList: {
        contains(cls) { return classSet.has(cls); },
        add(cls) { classSet.add(cls); },
        remove(cls) { classSet.delete(cls); },
        _set: classSet,
      },
      querySelector(selector) {
        if (childElements[selector]) return childElements[selector];
        // Search children by class match (simple .class selector)
        if (selector.startsWith('.')) {
          const cls = selector.slice(1);
          for (const child of Object.values(childElements)) {
            if (child && child.classList && child.classList.contains(cls)) {
              return child;
            }
          }
        }
        return null;
      },
      querySelectorAll(selector) {
        const cls = selector.startsWith('.') ? selector.slice(1) : null;
        if (!cls) return [];
        const matches = [];
        for (const child of Object.values(childElements)) {
          if (child && child.classList && child.classList.contains(cls)) {
            matches.push(child);
          }
        }
        return matches;
      },
      innerHTML,
      previousElementSibling: null,
      nextElementSibling: null,
      closest(selector) {
        // CommentMinimizer uses closest('.user-comment-row, .ai-suggestion-row')
        const selectors = selector.split(',').map(s => s.trim());
        for (const s of selectors) {
          if (s.startsWith('.') && classSet.has(s.slice(1))) {
            return row;
          }
        }
        return null;
      },
    };
    return row;
  });

  // Wire up sibling links
  for (let i = 0; i < rows.length; i++) {
    rows[i].previousElementSibling = i > 0 ? rows[i - 1] : null;
    rows[i].nextElementSibling = i < rows.length - 1 ? rows[i + 1] : null;
  }

  return rows;
}

/**
 * Build a simple mock element that can act as a code cell (.d2h-code-line-ctn).
 */
function buildCodeCell() {
  const children = [];
  return {
    style: {},
    children,
    classList: {
      _set: new Set(['d2h-code-line-ctn']),
      contains(cls) { return this._set.has(cls); },
      add(cls) { this._set.add(cls); },
      remove(cls) { this._set.delete(cls); },
    },
    appendChild(child) { children.push(child); },
    querySelector(selector) {
      if (selector === '.comment-indicator') {
        return children.find(c => c.className === 'comment-indicator') || null;
      }
      return null;
    },
  };
}

/**
 * Build a mock element that can act as a child inside a comment row.
 * Uses closest() to walk up to the provided parentRow.
 */
function buildChildElement(parentRow) {
  return {
    closest(selector) {
      const selectors = selector.split(',').map(s => s.trim());
      for (const s of selectors) {
        if (s.startsWith('.') && parentRow.classList.contains(s.slice(1))) {
          return parentRow;
        }
      }
      return null;
    },
    classList: {
      _set: new Set(),
      contains(cls) { return this._set.has(cls); },
    },
  };
}

// ---------------------------------------------------------------------------
// Global DOM mock
// ---------------------------------------------------------------------------

let diffContainer;
let allIndicators;

beforeEach(() => {
  allIndicators = [];
  diffContainer = {
    classList: {
      _set: new Set(),
      add(cls) { this._set.add(cls); },
      remove(cls) { this._set.delete(cls); },
      contains(cls) { return this._set.has(cls); },
    },
  };

  global.document = {
    getElementById: vi.fn((id) => {
      if (id === 'diff-container') return diffContainer;
      return null;
    }),
    querySelectorAll: vi.fn((selector) => {
      // Default: return empty arrays — tests override via vi.fn().mockReturnValue(...)
      return [];
    }),
    createElement: vi.fn((tag) => {
      const el = {
        _tag: tag,
        className: '',
        type: '',
        innerHTML: '',
        title: '',
        classList: {
          _set: new Set(),
          add(cls) { this._set.add(cls); },
          remove(cls) { this._set.delete(cls); },
          contains(cls) { return this._set.has(cls); },
        },
        addEventListener: vi.fn(),
        style: {},
      };
      allIndicators.push(el);
      return el;
    }),
  };
});

afterEach(() => {
  delete global.document;
});

// ===========================================================================
// Tests
// ===========================================================================

describe('CommentMinimizer', () => {
  // -------------------------------------------------------------------------
  // _findDiffRowFor
  // -------------------------------------------------------------------------
  describe('_findDiffRowFor', () => {
    it('should return the immediate previous sibling when it is a diff row', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },          // diff row
        { classes: ['user-comment-row'] },   // comment row
      ]);

      const cm = new CommentMinimizer();
      const result = cm._findDiffRowFor(rows[1]);
      expect(result).toBe(rows[0]);
    });

    it('should skip comment rows to find the diff row', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
        { classes: ['user-comment-row'] },
        { classes: ['user-comment-row'] },
      ]);

      const cm = new CommentMinimizer();
      expect(cm._findDiffRowFor(rows[2])).toBe(rows[0]);
    });

    it('should skip suggestion rows to find the diff row', () => {
      const rows = buildRows([
        { classes: ['d2h-ins'] },
        { classes: ['ai-suggestion-row'] },
        { classes: ['ai-suggestion-row'] },
        { classes: ['user-comment-row'] },
      ]);

      const cm = new CommentMinimizer();
      expect(cm._findDiffRowFor(rows[3])).toBe(rows[0]);
    });

    it('should skip form rows to find the diff row', () => {
      const rows = buildRows([
        { classes: ['d2h-del'] },
        { classes: ['comment-form-row'] },
        { classes: ['ai-suggestion-row'] },
      ]);

      const cm = new CommentMinimizer();
      expect(cm._findDiffRowFor(rows[2])).toBe(rows[0]);
    });

    it('should skip context-expand rows to find the diff row', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
        { classes: ['context-expand-row'] },
        { classes: ['user-comment-row'] },
      ]);

      const cm = new CommentMinimizer();
      expect(cm._findDiffRowFor(rows[2])).toBe(rows[0]);
    });

    it('should skip mixed intermediate rows (comment, form, expand, suggestion)', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
        { classes: ['user-comment-row'] },
        { classes: ['comment-form-row'] },
        { classes: ['context-expand-row'] },
        { classes: ['ai-suggestion-row'] },
        { classes: ['user-comment-row'] },
      ]);

      const cm = new CommentMinimizer();
      expect(cm._findDiffRowFor(rows[5])).toBe(rows[0]);
    });

    it('should return null when no diff row is found', () => {
      const rows = buildRows([
        { classes: ['user-comment-row'] },
        { classes: ['ai-suggestion-row'] },
      ]);

      const cm = new CommentMinimizer();
      expect(cm._findDiffRowFor(rows[1])).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // _getCommentRowsFor
  // -------------------------------------------------------------------------
  describe('_getCommentRowsFor', () => {
    it('should collect adjacent user-comment-row siblings', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
        { classes: ['user-comment-row'] },
        { classes: ['user-comment-row'] },
        { classes: ['d2h-cntx'] },
      ]);

      const cm = new CommentMinimizer();
      const result = cm._getCommentRowsFor(rows[0]);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(rows[1]);
      expect(result[1]).toBe(rows[2]);
    });

    it('should collect adjacent ai-suggestion-row siblings', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
        { classes: ['ai-suggestion-row'] },
        { classes: ['ai-suggestion-row'] },
        { classes: ['d2h-cntx'] },
      ]);

      const cm = new CommentMinimizer();
      const result = cm._getCommentRowsFor(rows[0]);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(rows[1]);
      expect(result[1]).toBe(rows[2]);
    });

    it('should collect mixed comment and suggestion rows', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
        { classes: ['user-comment-row'] },
        { classes: ['ai-suggestion-row'] },
        { classes: ['d2h-cntx'] },
      ]);

      const cm = new CommentMinimizer();
      const result = cm._getCommentRowsFor(rows[0]);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(rows[1]);
      expect(result[1]).toBe(rows[2]);
    });

    it('should skip comment-form-row but continue collecting', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
        { classes: ['user-comment-row'] },
        { classes: ['comment-form-row'] },
        { classes: ['ai-suggestion-row'] },
        { classes: ['d2h-cntx'] },
      ]);

      const cm = new CommentMinimizer();
      const result = cm._getCommentRowsFor(rows[0]);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(rows[1]);
      expect(result[1]).toBe(rows[3]);
    });

    it('should skip context-expand-row but continue collecting', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
        { classes: ['ai-suggestion-row'] },
        { classes: ['context-expand-row'] },
        { classes: ['user-comment-row'] },
        { classes: ['d2h-cntx'] },
      ]);

      const cm = new CommentMinimizer();
      const result = cm._getCommentRowsFor(rows[0]);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(rows[1]);
      expect(result[1]).toBe(rows[3]);
    });

    it('should stop at the next diff row', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
        { classes: ['user-comment-row'] },
        { classes: ['d2h-ins'] },
        { classes: ['user-comment-row'] },
      ]);

      const cm = new CommentMinimizer();
      const result = cm._getCommentRowsFor(rows[0]);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(rows[1]);
    });

    it('should return empty array when no comment rows follow', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
        { classes: ['d2h-ins'] },
      ]);

      const cm = new CommentMinimizer();
      const result = cm._getCommentRowsFor(rows[0]);
      expect(result).toHaveLength(0);
    });

    it('should return empty array when diff row is the last row', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
      ]);

      const cm = new CommentMinimizer();
      const result = cm._getCommentRowsFor(rows[0]);
      expect(result).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // refreshIndicators - lineMap counts
  // -------------------------------------------------------------------------
  describe('refreshIndicators', () => {
    /** Set up document.querySelectorAll to return the given rows by selector. */
    function mockQuerySelectorAll(commentRows, suggestionRows) {
      global.document.querySelectorAll = vi.fn((selector) => {
        if (selector === '.user-comment-row') return commentRows;
        if (selector === '.ai-suggestion-row') return suggestionRows;
        if (selector === '.comment-indicator') return [];
        if (selector === '.comment-expanded') return [];
        return [];
      });
    }

    it('should inject indicator for a user-comment-only line', () => {
      const codeCell = buildCodeCell();
      const rows = buildRows([
        { classes: ['d2h-cntx'], children: { '.d2h-code-line-ctn': codeCell } },
        { classes: ['user-comment-row'] },
      ]);

      mockQuerySelectorAll([rows[1]], []);

      const cm = new CommentMinimizer();
      cm._active = true;
      cm.refreshIndicators();

      // An indicator button should have been appended
      expect(codeCell.children.length).toBe(1);
      const btn = codeCell.children[0];
      expect(btn.className).toBe('comment-indicator');
      // Should contain person icon, not sparkles
      expect(btn.innerHTML).toContain('indicator-user');
      expect(btn.innerHTML).not.toContain('indicator-ai');
      expect(btn.title).toBe('1 comment');
    });

    it('should inject indicator for an AI-suggestion-only line', () => {
      // Build suggestion row with one .ai-suggestion child div
      const suggestionDiv = {
        classList: { _set: new Set(['ai-suggestion']), contains(c) { return this._set.has(c); } },
      };
      const codeCell = buildCodeCell();
      const rows = buildRows([
        { classes: ['d2h-cntx'], children: { '.d2h-code-line-ctn': codeCell } },
        {
          classes: ['ai-suggestion-row'],
          children: { '.ai-suggestion': suggestionDiv },
        },
      ]);
      // Override querySelectorAll on the suggestion row to return 1 item
      rows[1].querySelectorAll = (selector) => {
        if (selector === '.ai-suggestion') return [suggestionDiv];
        return [];
      };

      mockQuerySelectorAll([], [rows[1]]);

      const cm = new CommentMinimizer();
      cm._active = true;
      cm.refreshIndicators();

      expect(codeCell.children.length).toBe(1);
      const btn = codeCell.children[0];
      expect(btn.innerHTML).toContain('indicator-ai');
      expect(btn.innerHTML).not.toContain('indicator-user');
      expect(btn.title).toBe('1 suggestion');
    });

    it('should inject indicator for an adopted-comment-only line', () => {
      // Build user-comment-row that contains an .adopted-comment div
      const adoptedDiv = {
        classList: { _set: new Set(['adopted-comment']), contains(c) { return this._set.has(c); } },
      };
      const codeCell = buildCodeCell();
      const rows = buildRows([
        { classes: ['d2h-cntx'], children: { '.d2h-code-line-ctn': codeCell } },
        {
          classes: ['user-comment-row'],
          children: { '.adopted-comment': adoptedDiv },
        },
      ]);

      mockQuerySelectorAll([rows[1]], []);

      const cm = new CommentMinimizer();
      cm._active = true;
      cm.refreshIndicators();

      expect(codeCell.children.length).toBe(1);
      const btn = codeCell.children[0];
      expect(btn.innerHTML).toContain('indicator-adopted');
      expect(btn.innerHTML).not.toContain('indicator-user');
      expect(btn.title).toBe('1 adopted');
    });

    it('should combine counts for mixed comment types on the same diff line', () => {
      const adoptedDiv = {
        classList: { _set: new Set(['adopted-comment']), contains(c) { return this._set.has(c); } },
      };
      const suggestionDiv = {
        classList: { _set: new Set(['ai-suggestion']), contains(c) { return this._set.has(c); } },
      };
      const codeCell = buildCodeCell();

      const rows = buildRows([
        { classes: ['d2h-cntx'], children: { '.d2h-code-line-ctn': codeCell } },
        { classes: ['user-comment-row'] },                                       // plain user comment
        { classes: ['user-comment-row'], children: { '.adopted-comment': adoptedDiv } },  // adopted
        { classes: ['ai-suggestion-row'], children: { '.ai-suggestion': suggestionDiv } }, // AI
      ]);
      rows[3].querySelectorAll = (selector) => {
        if (selector === '.ai-suggestion') return [suggestionDiv];
        return [];
      };

      mockQuerySelectorAll([rows[1], rows[2]], [rows[3]]);

      const cm = new CommentMinimizer();
      cm._active = true;
      cm.refreshIndicators();

      expect(codeCell.children.length).toBe(1);
      const btn = codeCell.children[0];
      // All three types present
      expect(btn.innerHTML).toContain('indicator-user');
      expect(btn.innerHTML).toContain('indicator-adopted');
      expect(btn.innerHTML).toContain('indicator-ai');
      // Total = 1 user + 1 adopted + 1 AI = 3
      expect(btn.innerHTML).toContain('indicator-count');
      expect(btn.title).toBe('1 comment, 1 adopted, 1 suggestion');
    });

    it('should count multiple AI suggestions within a single suggestion row', () => {
      const s1 = {
        classList: { _set: new Set(['ai-suggestion']), contains(c) { return this._set.has(c); } },
      };
      const s2 = {
        classList: { _set: new Set(['ai-suggestion']), contains(c) { return this._set.has(c); } },
      };
      const codeCell = buildCodeCell();

      const rows = buildRows([
        { classes: ['d2h-cntx'], children: { '.d2h-code-line-ctn': codeCell } },
        { classes: ['ai-suggestion-row'] },
      ]);
      rows[1].querySelectorAll = (selector) => {
        if (selector === '.ai-suggestion') return [s1, s2];
        return [];
      };

      mockQuerySelectorAll([], [rows[1]]);

      const cm = new CommentMinimizer();
      cm._active = true;
      cm.refreshIndicators();

      const btn = codeCell.children[0];
      expect(btn.title).toBe('2 suggestions');
    });

    it('should be a no-op when not active', () => {
      mockQuerySelectorAll([], []);

      const cm = new CommentMinimizer();
      cm._active = false;
      cm.refreshIndicators();

      // querySelectorAll should not have been called for comment rows
      expect(global.document.querySelectorAll).not.toHaveBeenCalledWith('.user-comment-row');
    });

    it('should not inject indicators when comment row has no parent diff row', () => {
      // Comment row is first — no previous sibling
      const rows = buildRows([
        { classes: ['user-comment-row'] },
      ]);

      mockQuerySelectorAll([rows[0]], []);

      const cm = new CommentMinimizer();
      cm._active = true;
      cm.refreshIndicators();

      // createElement should not have been called (no indicator injected)
      expect(global.document.createElement).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Toggle expand/collapse
  // -------------------------------------------------------------------------
  describe('toggle expand/collapse', () => {
    it('should expand then collapse comment rows via _toggleLineComments', () => {
      const codeCell = buildCodeCell();
      const rows = buildRows([
        { classes: ['d2h-cntx'], children: { '.d2h-code-line-ctn': codeCell } },
        { classes: ['user-comment-row'] },
        { classes: ['ai-suggestion-row'] },
      ]);

      const cm = new CommentMinimizer();
      const btn = { classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } } };

      // Expand
      cm._toggleLineComments(rows[0], btn);
      expect(cm._expandedLines.has(rows[0])).toBe(true);
      expect(btn.classList.contains('expanded')).toBe(true);
      expect(rows[1].classList.contains('comment-expanded')).toBe(true);
      expect(rows[2].classList.contains('comment-expanded')).toBe(true);

      // Collapse
      cm._toggleLineComments(rows[0], btn);
      expect(cm._expandedLines.has(rows[0])).toBe(false);
      expect(btn.classList.contains('expanded')).toBe(false);
      expect(rows[1].classList.contains('comment-expanded')).toBe(false);
      expect(rows[2].classList.contains('comment-expanded')).toBe(false);
    });

    it('should track multiple expanded lines independently', () => {
      const cell1 = buildCodeCell();
      const cell2 = buildCodeCell();
      const rows = buildRows([
        { classes: ['d2h-cntx'], children: { '.d2h-code-line-ctn': cell1 } },
        { classes: ['user-comment-row'] },
        { classes: ['d2h-ins'], children: { '.d2h-code-line-ctn': cell2 } },
        { classes: ['ai-suggestion-row'] },
      ]);

      const cm = new CommentMinimizer();
      const btn1 = { classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } } };
      const btn2 = { classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } } };

      cm._toggleLineComments(rows[0], btn1);
      cm._toggleLineComments(rows[2], btn2);

      expect(cm._expandedLines.size).toBe(2);

      // Collapse only the first
      cm._toggleLineComments(rows[0], btn1);
      expect(cm._expandedLines.has(rows[0])).toBe(false);
      expect(cm._expandedLines.has(rows[2])).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // setMinimized
  // -------------------------------------------------------------------------
  describe('setMinimized', () => {
    it('should add comments-minimized class and refresh when enabled', () => {
      const codeCell = buildCodeCell();
      const rows = buildRows([
        { classes: ['d2h-cntx'], children: { '.d2h-code-line-ctn': codeCell } },
        { classes: ['user-comment-row'] },
      ]);

      global.document.querySelectorAll = vi.fn((selector) => {
        if (selector === '.user-comment-row') return [rows[1]];
        if (selector === '.ai-suggestion-row') return [];
        if (selector === '.comment-indicator') return [];
        if (selector === '.comment-expanded') return [];
        return [];
      });

      const cm = new CommentMinimizer();
      cm.setMinimized(true);

      expect(cm.active).toBe(true);
      expect(diffContainer.classList.contains('comments-minimized')).toBe(true);
      // Indicator should have been injected
      expect(codeCell.children.length).toBe(1);
    });

    it('should remove comments-minimized class and indicators when disabled', () => {
      const removedIndicators = [];
      global.document.querySelectorAll = vi.fn((selector) => {
        if (selector === '.comment-indicator') return removedIndicators.map(i => ({ remove: vi.fn() }));
        if (selector === '.comment-expanded') return [];
        return [];
      });

      const cm = new CommentMinimizer();
      // First enable
      cm._active = true;
      diffContainer.classList.add('comments-minimized');

      cm.setMinimized(false);

      expect(cm.active).toBe(false);
      expect(diffContainer.classList.contains('comments-minimized')).toBe(false);
    });

    it('should clear _expandedLines when toggling', () => {
      global.document.querySelectorAll = vi.fn(() => []);

      const cm = new CommentMinimizer();
      cm._expandedLines.add('fake-row');

      cm.setMinimized(true);
      expect(cm._expandedLines.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // findDiffRowFor (public)
  // -------------------------------------------------------------------------
  describe('findDiffRowFor', () => {
    it('should locate the diff row from a child element inside a comment row', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
        { classes: ['user-comment-row'] },
      ]);

      // Build child element that closest() resolves to the comment row
      const child = buildChildElement(rows[1]);

      const cm = new CommentMinimizer();
      expect(cm.findDiffRowFor(child)).toBe(rows[0]);
    });

    it('should locate the diff row from a child element inside a suggestion row', () => {
      const rows = buildRows([
        { classes: ['d2h-ins'] },
        { classes: ['ai-suggestion-row'] },
      ]);

      const child = buildChildElement(rows[1]);

      const cm = new CommentMinimizer();
      expect(cm.findDiffRowFor(child)).toBe(rows[0]);
    });

    it('should return null if element is not inside a comment or suggestion row', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
      ]);

      // A child that is not inside a comment/suggestion row
      const unrelated = {
        closest() { return null; },
        classList: {
          _set: new Set(),
          contains(cls) { return this._set.has(cls); },
        },
      };

      const cm = new CommentMinimizer();
      expect(cm.findDiffRowFor(unrelated)).toBeNull();
    });

    it('should skip intermediate rows between the comment row and diff row', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
        { classes: ['comment-form-row'] },
        { classes: ['ai-suggestion-row'] },
        { classes: ['user-comment-row'] },
      ]);

      const child = buildChildElement(rows[3]);

      const cm = new CommentMinimizer();
      expect(cm.findDiffRowFor(child)).toBe(rows[0]);
    });
  });

  // -------------------------------------------------------------------------
  // expandForElement
  // -------------------------------------------------------------------------
  describe('expandForElement', () => {
    it('should expand comments for a given element and update indicator button', () => {
      const indicatorBtn = {
        className: 'comment-indicator',
        classList: {
          _set: new Set(),
          add(c) { this._set.add(c); },
          remove(c) { this._set.delete(c); },
          contains(c) { return this._set.has(c); },
        },
      };
      const codeCell = buildCodeCell();
      codeCell.children.push(indicatorBtn);
      // Override querySelector so it finds the indicator
      const origQS = codeCell.querySelector;
      codeCell.querySelector = (selector) => {
        if (selector === '.d2h-code-line-ctn .comment-indicator') return indicatorBtn;
        return origQS(selector);
      };

      const rows = buildRows([
        { classes: ['d2h-cntx'], children: { '.d2h-code-line-ctn': codeCell } },
        { classes: ['user-comment-row'] },
        { classes: ['ai-suggestion-row'] },
      ]);

      // Wire up the diff row's querySelector to find the indicator inside codeCell
      rows[0].querySelector = (selector) => {
        if (selector === '.d2h-code-line-ctn .comment-indicator') return indicatorBtn;
        if (selector === '.d2h-code-line-ctn') return codeCell;
        return null;
      };

      const child = buildChildElement(rows[1]);

      const cm = new CommentMinimizer();
      cm._active = true;
      cm.expandForElement(child);

      // Should have expanded
      expect(cm._expandedLines.has(rows[0])).toBe(true);
      expect(rows[1].classList.contains('comment-expanded')).toBe(true);
      expect(rows[2].classList.contains('comment-expanded')).toBe(true);
      expect(indicatorBtn.classList.contains('expanded')).toBe(true);
    });

    it('should be a no-op when not active', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
        { classes: ['user-comment-row'] },
      ]);

      const child = buildChildElement(rows[1]);

      const cm = new CommentMinimizer();
      cm._active = false;
      cm.expandForElement(child);

      expect(cm._expandedLines.size).toBe(0);
      expect(rows[1].classList.contains('comment-expanded')).toBe(false);
    });

    it('should be a no-op if element is not inside a comment/suggestion row', () => {
      const unrelated = {
        closest() { return null; },
        classList: {
          _set: new Set(),
          contains(cls) { return this._set.has(cls); },
        },
      };

      const cm = new CommentMinimizer();
      cm._active = true;
      cm.expandForElement(unrelated);

      expect(cm._expandedLines.size).toBe(0);
    });

    it('should not re-expand if already expanded', () => {
      const rows = buildRows([
        { classes: ['d2h-cntx'] },
        { classes: ['user-comment-row'] },
      ]);

      const child = buildChildElement(rows[1]);

      const cm = new CommentMinimizer();
      cm._active = true;

      // Pre-expand
      cm._expandedLines.add(rows[0]);

      // Should exit early — comment-expanded should NOT be added because the
      // early return prevents the forEach call
      cm.expandForElement(child);

      expect(cm._expandedLines.has(rows[0])).toBe(true);
      // The row's class was not modified (no add call)
      expect(rows[1].classList.contains('comment-expanded')).toBe(false);
    });

    it('should handle missing indicator button gracefully', () => {
      const codeCell = buildCodeCell();
      const rows = buildRows([
        { classes: ['d2h-cntx'], children: { '.d2h-code-line-ctn': codeCell } },
        { classes: ['user-comment-row'] },
      ]);

      // No indicator button exists — querySelector returns null
      rows[0].querySelector = (selector) => {
        if (selector === '.d2h-code-line-ctn .comment-indicator') return null;
        if (selector === '.d2h-code-line-ctn') return codeCell;
        return null;
      };

      const child = buildChildElement(rows[1]);

      const cm = new CommentMinimizer();
      cm._active = true;

      // Should not throw
      cm.expandForElement(child);

      expect(cm._expandedLines.has(rows[0])).toBe(true);
      expect(rows[1].classList.contains('comment-expanded')).toBe(true);
    });
  });
});
