// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for HunkSummaryRenderer.
 *
 * Verifies inline rendering, idempotent re-render, removeByHash, and reset
 * behaviour. Tests target the real production module — no duplicated logic.
 *
 * Visibility (review-level + per-file) is handled outside the renderer via
 * CSS classes; PRManager owns that wiring and is exercised through E2E tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const { HunkSummaryRenderer } = require('../../public/js/modules/hunk-summary-renderer.js');

/**
 * Build a minimal `<table><tbody>` containing two anchor `<tr>` rows the
 * renderer can attach annotations after.
 */
function buildAnchorRows() {
  document.body.innerHTML = `
    <table>
      <tbody id="tbody">
        <tr id="anchor-a" data-hunk-start="hash-a"><td>A</td></tr>
        <tr id="anchor-b" data-hunk-start="hash-b"><td>B</td></tr>
      </tbody>
    </table>
  `;
  return {
    tbody: document.getElementById('tbody'),
    anchorA: document.getElementById('anchor-a'),
    anchorB: document.getElementById('anchor-b')
  };
}

describe('HunkSummaryRenderer', () => {
  let renderer;

  beforeEach(() => {
    window.localStorage.clear();
    document.body.classList.remove('summaries-hidden');
    renderer = new HunkSummaryRenderer({});
  });

  describe('renderInline', () => {
    it('inserts an annotation row directly above the anchor', () => {
      const { anchorA } = buildAnchorRows();
      const row = renderer.renderInline(
        anchorA,
        { content_hash: 'hash-a', summary_text: 'Adds new helper.' }
      );
      expect(row).toBeTruthy();
      // The annotation lives immediately *before* the hunk's first code line
      // so a reader scrolling down sees the description before the change.
      expect(anchorA.previousElementSibling).toBe(row);
      expect(row.classList.contains('hunk-summary-row')).toBe(true);
      expect(row.querySelector('.hunk-summary-text').textContent).toBe('Adds new helper.');
      expect(row.dataset.contentHash).toBe('hash-a');
    });

    it('does not render a dismiss button (deprecated in v3.4)', () => {
      const { anchorA } = buildAnchorRows();
      const row = renderer.renderInline(
        anchorA,
        { content_hash: 'hash-a', summary_text: 'Adds new helper.' }
      );
      expect(row.querySelector('.hunk-summary-dismiss')).toBeNull();
    });

    it('is idempotent — re-rendering the same hash updates text in place', () => {
      const { anchorA, tbody } = buildAnchorRows();
      renderer.renderInline(
        anchorA,
        { content_hash: 'hash-a', summary_text: 'First.' }
      );
      renderer.renderInline(
        anchorA,
        { content_hash: 'hash-a', summary_text: 'Updated.' }
      );
      const annotationRows = tbody.querySelectorAll('.hunk-summary-row');
      expect(annotationRows).toHaveLength(1);
      expect(annotationRows[0].querySelector('.hunk-summary-text').textContent).toBe('Updated.');
    });

    it('refuses to render summaries with no summary_text', () => {
      const { anchorA, tbody } = buildAnchorRows();
      const row = renderer.renderInline(
        anchorA,
        { content_hash: 'hash-a', summary_text: null, trivial_reason: 'whitespace' }
      );
      expect(row).toBeNull();
      expect(tbody.querySelectorAll('.hunk-summary-row')).toHaveLength(0);
    });

    it('returns null when given a falsy summary or anchor', () => {
      const { anchorA } = buildAnchorRows();
      expect(renderer.renderInline(null, { summary_text: 'x', content_hash: 'h' })).toBeNull();
      expect(renderer.renderInline(anchorA, null)).toBeNull();
      expect(renderer.renderInline(anchorA, { summary_text: 'x' })).toBeNull();
    });
  });

  describe('removeByHash', () => {
    it('detaches an existing annotation and forgets it', () => {
      const { anchorA, tbody } = buildAnchorRows();
      renderer.renderInline(
        anchorA,
        { content_hash: 'hash-a', summary_text: 'Adds X.' }
      );
      expect(renderer.removeByHash('hash-a')).toBe(true);
      expect(tbody.querySelectorAll('.hunk-summary-row')).toHaveLength(0);
      expect(renderer.removeByHash('hash-a')).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears every mounted annotation across multiple anchors', () => {
      const { anchorA, anchorB, tbody } = buildAnchorRows();
      renderer.renderInline(anchorA, { content_hash: 'hash-a', summary_text: 'A' });
      renderer.renderInline(anchorB, { content_hash: 'hash-b', summary_text: 'B' });
      expect(tbody.querySelectorAll('.hunk-summary-row')).toHaveLength(2);
      renderer.reset();
      expect(tbody.querySelectorAll('.hunk-summary-row')).toHaveLength(0);
    });
  });
});
