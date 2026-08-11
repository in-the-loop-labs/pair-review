// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Task #19 F1: on the CodeView path, loadFileComments must resolve each
 * file-level comment's zone via prManager._getOrCreateFileCommentsZone (which
 * CREATES + CACHES the zone), not findZoneForFile (DOM query / cached GET). A
 * file that was virtualized out at load time never built its zone on mount, so
 * findZoneForFile finds nothing and the card is dropped with nothing to
 * re-hydrate it. getOrCreate makes the cached zone now; the 'file-comments'
 * renderer returns that SAME element when the file scrolls in, so the card is
 * already present. Legacy mode renders zones in the DOM and must NOT spawn
 * detached ones, so it keeps findZoneForFile.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');

afterEach(() => {
  document.body.innerHTML = '';
  delete window.CommentManager;
  delete window.renderMarkdown;
  vi.restoreAllMocks();
});

describe('FileCommentManager.loadFileComments() CodeView hydration', () => {
  it('creates + caches the zone via getOrCreate and lands the card when no DOM zone exists', () => {
    const manager = Object.create(FileCommentManager.prototype);
    manager.escapeHtml = (s) => String(s ?? '');
    manager.updateCommentCount = vi.fn();
    // displayUserComment reads these globals.
    window.CommentManager = { PERSON_ICON_SVG: '', AI_ICON_SVG: '' };
    window.escapeHtmlAttribute = (s) => String(s ?? '');

    const cache = new Map();
    manager.prManager = {
      _usesPierreCodeView: () => true,
      _fileCommentZones: cache,
      // Mirror pr.js:4386 — lazily build via createFileCommentsZone and cache.
      _getOrCreateFileCommentsZone(file) {
        let zone = cache.get(file);
        if (!zone) {
          zone = manager.createFileCommentsZone(file);
          cache.set(file, zone);
        }
        return zone;
      },
    };

    // No .file-comments-zone in the document — the file is virtualized out.
    expect(document.querySelector('.file-comments-zone')).toBeNull();

    manager.loadFileComments(
      [{ id: 'c1', file: 'x.js', is_file_level: 1, body: 'hi', source: 'user' }],
      []
    );

    // The zone was created + cached, and the card landed in that cached element.
    expect(cache.has('x.js')).toBe(true);
    const zone = cache.get('x.js');
    expect(zone.querySelectorAll('.file-comment-card')).toHaveLength(1);
    expect(zone.querySelector('.file-comment-card').dataset.commentId).toBe('c1');
  });

  it('legacy mode uses findZoneForFile (no getOrCreate) and skips the card when no DOM zone exists', () => {
    const manager = Object.create(FileCommentManager.prototype);
    const getOrCreate = vi.fn();
    const cache = new Map();
    manager.prManager = {
      _usesPierreCodeView: () => false,
      _getOrCreateFileCommentsZone: getOrCreate,
      _fileCommentZones: cache,
    };
    manager.findZoneForFile = vi.fn(() => null); // no live DOM zone
    manager.displayUserComment = vi.fn();
    manager.updateCommentCount = vi.fn();

    manager.loadFileComments(
      [{ id: 'c1', file: 'x.js', is_file_level: 1, body: 'hi' }],
      []
    );

    expect(getOrCreate).not.toHaveBeenCalled();               // legacy never creates zones
    expect(manager.findZoneForFile).toHaveBeenCalledWith('x.js');
    expect(manager.displayUserComment).not.toHaveBeenCalled(); // card skipped
    expect(cache.size).toBe(0);                                // no detached zone spawned
  });
});
