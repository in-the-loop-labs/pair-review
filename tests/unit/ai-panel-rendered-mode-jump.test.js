// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Regression coverage for "jump to comment" from the AI/Review panel while
 * the target file is in Rendered Markdown mode.
 *
 * Rendered mode does NOT tear the Diff surface down — it only CSS-hides it
 * (`.d2h-file-wrapper.rendered-mode-active .d2h-file-body,
 *   ... .pierre-diff-body { display: none }`). So the comment's
 * `.user-comment-row` is still in the DOM but invisible and unscrollable,
 * while a visible `.rendered-markdown-comment-card` carrying the SAME
 * `data-comment-id` sits in the rendered document. Previously
 * `scrollToComment` always preferred the row, so the click appeared to do
 * nothing.
 *
 * These tests drive the real production `AIPanel.scrollToComment` /
 * `_resolveLineCommentTarget` and assert on the element production actually
 * chose to scroll to. The choice is made from STATE (the
 * `.rendered-mode-active` class the hiding rule is keyed off), never from
 * layout measurement — jsdom has no layout, and `offsetParent` would be a
 * fragile signal in a real browser too.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { AIPanel } = require('../../public/js/components/AIPanel.js');

/**
 * Build a file wrapper containing a legacy (or Pierre) diff body with a
 * `.user-comment-row` for `commentId`, plus a rendered-markdown container
 * with a `.rendered-markdown-comment-card` for the same id.
 * @param {object} opts
 * @param {number} opts.commentId
 * @param {boolean} opts.renderedModeActive
 * @param {'legacy'|'pierre'} [opts.engine]
 * @param {boolean} [opts.withRenderedCard]
 */
function buildSurfaces({ commentId, renderedModeActive, engine = 'legacy', withRenderedCard = true }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'd2h-file-wrapper';
  wrapper.dataset.fileName = 'docs/guide.md';
  if (renderedModeActive) wrapper.classList.add('rendered-mode-active');

  const diffBody = document.createElement('div');
  // The legacy engine renders into `.d2h-file-body`; PierreBridge slots its
  // light-DOM annotation containers inside `.pierre-diff-body`. Both are
  // descendants of the file wrapper, so both are covered by the same
  // `.rendered-mode-active` state check.
  diffBody.className = engine === 'pierre' ? 'pierre-diff-body' : 'd2h-file-body';
  const diffRow = document.createElement('div');
  diffRow.className = 'user-comment-row';
  diffRow.dataset.commentId = String(commentId);
  diffRow.dataset.file = 'docs/guide.md';
  diffRow.dataset.lineStart = '11';
  const inner = document.createElement('div');
  inner.className = 'user-comment';
  diffRow.appendChild(inner);
  diffBody.appendChild(diffRow);
  wrapper.appendChild(diffBody);

  let renderedCard = null;
  const renderedContainer = document.createElement('div');
  renderedContainer.className = 'rendered-markdown-container';
  if (withRenderedCard) {
    renderedCard = document.createElement('div');
    renderedCard.className = 'rendered-markdown-comment-card comment-user-origin';
    renderedCard.dataset.commentId = String(commentId);
    renderedContainer.appendChild(renderedCard);
  }
  wrapper.appendChild(renderedContainer);

  document.body.appendChild(wrapper);
  return { wrapper, diffRow, renderedCard };
}

function makePanel(comments = []) {
  const inst = Object.create(AIPanel.prototype);
  inst._navGen = 0;
  inst.comments = comments;
  inst.expandFileIfCollapsed = vi.fn(() => undefined);
  inst._scrollDiffTarget = vi.fn();
  return inst;
}

describe('AIPanel jump-to-comment with Rendered Markdown mode', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.prManager = {
      ensureFileBodyRendered: vi.fn(async () => {}),
      ensureLinesVisible: vi.fn(async () => {})
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.prManager;
    document.body.innerHTML = '';
  });

  describe('_resolveLineCommentTarget', () => {
    it('prefers the Diff row when Rendered mode is OFF (unchanged behavior)', () => {
      const { diffRow } = buildSurfaces({ commentId: 11, renderedModeActive: false });
      expect(makePanel()._resolveLineCommentTarget(11)).toBe(diffRow);
    });

    it('prefers the visible Rendered card when the Diff row is hidden by Rendered mode (legacy engine)', () => {
      const { renderedCard } = buildSurfaces({ commentId: 11, renderedModeActive: true, engine: 'legacy' });
      expect(makePanel()._resolveLineCommentTarget(11)).toBe(renderedCard);
    });

    it('prefers the visible Rendered card when the Diff row is hidden by Rendered mode (Pierre engine)', () => {
      const { renderedCard } = buildSurfaces({ commentId: 11, renderedModeActive: true, engine: 'pierre' });
      expect(makePanel()._resolveLineCommentTarget(11)).toBe(renderedCard);
    });

    it('falls back to the hidden Diff row when Rendered mode is on but no card exists for that id', () => {
      const { diffRow } = buildSurfaces({
        commentId: 11, renderedModeActive: true, withRenderedCard: false
      });
      expect(makePanel()._resolveLineCommentTarget(11)).toBe(diffRow);
    });

    it('falls back to any [data-comment-id] element when there is no Diff row at all', () => {
      const other = document.createElement('div');
      other.dataset.commentId = '99';
      document.body.appendChild(other);
      expect(makePanel()._resolveLineCommentTarget(99)).toBe(other);
    });

    it('returns null for an unknown comment id', () => {
      expect(makePanel()._resolveLineCommentTarget(12345)).toBeNull();
    });

    it('does not mix up ids that share a prefix', () => {
      const { renderedCard: card1 } = buildSurfaces({ commentId: 1, renderedModeActive: true });
      buildSurfaces({ commentId: 12, renderedModeActive: true });
      expect(makePanel()._resolveLineCommentTarget(1)).toBe(card1);
      expect(makePanel()._resolveLineCommentTarget(1).dataset.commentId).toBe('1');
    });
  });

  describe('scrollToComment end-to-end', () => {
    it('scrolls to (and flashes) the Rendered card when the file is in Rendered mode', async () => {
      const { renderedCard, diffRow } = buildSurfaces({ commentId: 11, renderedModeActive: true });
      const panel = makePanel([{ id: 11, side: 'RIGHT' }]);

      await panel.scrollToComment('11', 'docs/guide.md', 11);

      expect(panel._scrollDiffTarget).toHaveBeenCalledTimes(1);
      expect(panel._scrollDiffTarget).toHaveBeenCalledWith(renderedCard);
      // The flash lands on the visible card, not on the hidden diff row.
      expect(renderedCard.classList.contains('highlight-flash')).toBe(true);
      expect(diffRow.classList.contains('highlight-flash')).toBe(false);
      expect(diffRow.querySelector('.user-comment').classList.contains('highlight-flash')).toBe(false);
    });

    it('still scrolls to the Diff row (and its .user-comment) when Rendered mode is off', async () => {
      const { renderedCard, diffRow } = buildSurfaces({ commentId: 11, renderedModeActive: false });
      const panel = makePanel([{ id: 11, side: 'RIGHT' }]);

      await panel.scrollToComment('11', 'docs/guide.md', 11);

      expect(panel._scrollDiffTarget).toHaveBeenCalledWith(diffRow);
      expect(diffRow.querySelector('.user-comment').classList.contains('highlight-flash')).toBe(true);
      expect(renderedCard.classList.contains('highlight-flash')).toBe(false);
    });

    it('still reveals the target line in the Diff surface first, so toggling back to Diff lands on the row', async () => {
      buildSurfaces({ commentId: 11, renderedModeActive: true });
      const panel = makePanel([{ id: 11, side: 'RIGHT' }]);

      await panel.scrollToComment('11', 'docs/guide.md', 11);

      expect(window.prManager.ensureFileBodyRendered).toHaveBeenCalledWith('docs/guide.md');
      expect(window.prManager.ensureLinesVisible).toHaveBeenCalledWith([
        { file: 'docs/guide.md', line_start: 11, line_end: 11, side: 'RIGHT' }
      ]);
    });

    it('file-level comments are unaffected by Rendered mode', async () => {
      const { wrapper } = buildSurfaces({ commentId: 11, renderedModeActive: true });
      const zone = document.createElement('div');
      zone.className = 'file-comments-zone collapsed';
      const fileCard = document.createElement('div');
      fileCard.className = 'file-comment-card user-comment';
      fileCard.dataset.commentId = '11';
      zone.appendChild(fileCard);
      wrapper.appendChild(zone);

      const panel = makePanel([{ id: 11, is_file_level: 1 }]);
      await panel.scrollToComment('11', 'docs/guide.md', 11);

      expect(panel._scrollDiffTarget).toHaveBeenCalledWith(fileCard);
      expect(zone.classList.contains('collapsed')).toBe(false);
    });
  });
});
