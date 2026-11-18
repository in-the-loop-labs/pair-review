// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for HunkSummaryRenderer.
 *
 * Verifies the card it gives the bridge, idempotent re-mount, removeByHash
 * and reset. Tests target the real production module — no duplicated logic.
 *
 * Visibility (review-level + per-file) is handled outside the renderer via
 * CSS classes; PRManager owns that wiring and is exercised through E2E tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const { HunkSummaryRenderer } = require('../../public/js/modules/hunk-summary-renderer.js');

/**
 * Minimal PierreBridge stand-in. Records annotations by id and actually invokes
 * the registered 'hunk-summary' renderer so tests can assert the produced card
 * DOM — exercising the real _buildPierreCard path, not a duplicate.
 */
function createFakeBridge(fileNames = ['a.js']) {
  let renderFn = null;
  const annotations = new Map();
  return {
    files: new Map(fileNames.map(f => [f, {}])),
    registeredType: null,
    registerAnnotationRenderer(type, fn) {
      this.registeredType = type;
      renderFn = fn;
    },
    addAnnotation(fileName, ann) {
      const el = renderFn ? renderFn(ann.data, ann.id, fileName) : null;
      annotations.set(ann.id, { fileName, ...ann, el });
    },
    removeAnnotation(fileName, id) {
      annotations.delete(id);
    },
    _annotations: annotations,
  };
}

describe('HunkSummaryRenderer', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.classList.remove('summaries-hidden');
  });

  describe('renderPierre (Pierre-rendered files)', () => {
    let bridge;
    let pierreRenderer;

    beforeEach(() => {
      bridge = createFakeBridge(['a.js']);
      pierreRenderer = new HunkSummaryRenderer({ pierreBridge: bridge });
    });

    it('registers the hunk-summary renderer with the bridge and mounts an annotation', () => {
      const id = pierreRenderer.renderPierre(
        'a.js',
        { lineNumber: 12, side: 'RIGHT' },
        { content_hash: 'hash-a', summary_text: 'Adds a helper.' }
      );

      expect(bridge.registeredType).toBe('hunk-summary');
      // Deterministic id derived from the content hash.
      expect(id).toBe('hunk-summary-hash-a');
      const ann = bridge._annotations.get('hunk-summary-hash-a');
      expect(ann).toBeTruthy();
      expect(ann.lineNumber).toBe(12);
      expect(ann.side).toBe('RIGHT');
      expect(ann.type).toBe('hunk-summary');
      // The card carries the shared class so page CSS (styling + visibility
      // toggles) applies, and holds the summary text.
      expect(ann.el.classList.contains('hunk-summary-row')).toBe(true);
      expect(ann.el.querySelector('.hunk-summary-text').textContent).toBe('Adds a helper.');
      expect(ann.el.dataset.contentHash).toBe('hash-a');
      // No dismiss button (deprecated in v3.4).
      expect(ann.el.querySelector('.hunk-summary-dismiss')).toBeNull();
    });

    it('anchors a pure-deletion hunk on the LEFT side', () => {
      pierreRenderer.renderPierre(
        'a.js',
        { lineNumber: 40, side: 'LEFT' },
        { content_hash: 'del', summary_text: 'Removes dead code.' }
      );
      const ann = bridge._annotations.get('hunk-summary-del');
      expect(ann.side).toBe('LEFT');
      expect(ann.lineNumber).toBe(40);
    });

    it('is idempotent — re-mounting the same hash replaces (removes then re-adds)', () => {
      pierreRenderer.renderPierre(
        'a.js', { lineNumber: 5, side: 'RIGHT' },
        { content_hash: 'h', summary_text: 'First.' }
      );
      pierreRenderer.renderPierre(
        'a.js', { lineNumber: 5, side: 'RIGHT' },
        { content_hash: 'h', summary_text: 'Updated.' }
      );
      // Exactly one annotation for the hash, with refreshed text.
      expect(bridge._annotations.size).toBe(1);
      expect(bridge._annotations.get('hunk-summary-h').el.querySelector('.hunk-summary-text').textContent)
        .toBe('Updated.');
    });

    it('removeByHash drops the bridge annotation', () => {
      pierreRenderer.renderPierre(
        'a.js', { lineNumber: 5, side: 'RIGHT' },
        { content_hash: 'h', summary_text: 'x' }
      );
      expect(bridge._annotations.has('hunk-summary-h')).toBe(true);
      expect(pierreRenderer.removeByHash('h')).toBe(true);
      expect(bridge._annotations.has('hunk-summary-h')).toBe(false);
      expect(pierreRenderer.removeByHash('h')).toBe(false);
    });

    it('reset removes all Pierre annotations from the bridge', () => {
      pierreRenderer.renderPierre('a.js', { lineNumber: 1, side: 'RIGHT' }, { content_hash: 'h1', summary_text: 'a' });
      pierreRenderer.renderPierre('a.js', { lineNumber: 2, side: 'RIGHT' }, { content_hash: 'h2', summary_text: 'b' });
      expect(bridge._annotations.size).toBe(2);
      pierreRenderer.reset();
      expect(bridge._annotations.size).toBe(0);
    });

    it('returns null for a falsy summary, missing hash, or empty text', () => {
      expect(pierreRenderer.renderPierre('a.js', { lineNumber: 1, side: 'RIGHT' }, null)).toBeNull();
      expect(pierreRenderer.renderPierre('a.js', { lineNumber: 1, side: 'RIGHT' }, { summary_text: 'x' })).toBeNull();
      expect(pierreRenderer.renderPierre('a.js', { lineNumber: 1, side: 'RIGHT' }, { content_hash: 'h', summary_text: '' })).toBeNull();
      expect(bridge._annotations.size).toBe(0);
    });
  });
});
