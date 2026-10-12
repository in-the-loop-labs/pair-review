// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * File-level AI suggestion cards and user comment reloads.
 *
 * FileCommentManager.loadFileComments(comments, suggestions) treats both
 * arguments the same way: any array (even an empty one) replaces that kind
 * of card, and null leaves it alone. Its callers rely on that:
 *   - PRManager.loadUserComments (PR and Local mode share it) always passes
 *     the file-level comment list and null suggestions, so reloading user
 *     comments never wipes the AI cards, and removing the last file-level
 *     comment removes its card.
 *   - SuggestionManager.displayAISuggestions and clearAISuggestions (PR and
 *     Local mode share them) pass null comments and the current file-level
 *     list (empty to clear), so a new run or level with no file-level
 *     findings clears the previous AI cards without touching user cards.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');
const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');
const { PRManager } = require('../../public/js/pr.js');

/** Build a file comments zone holding one AI card and one user comment card. */
function buildZone(fileName = 'src/a.js') {
  const zone = document.createElement('div');
  zone.className = 'file-comments-zone';
  zone.dataset.fileName = fileName;
  const container = document.createElement('div');
  container.className = 'file-comments-container';
  container.innerHTML = `
    <div class="file-comment-card ai-suggestion" data-id="old-ai"></div>
    <div class="file-comment-card user-comment" data-id="old-user"></div>
  `;
  zone.appendChild(container);
  document.body.appendChild(zone);
  return { zone, container };
}

function makeFileCommentManager(zone) {
  const fcm = Object.create(FileCommentManager.prototype);
  fcm.prManager = { currentPR: { id: 'review-1' } };
  fcm.findZoneForFile = vi.fn(() => zone);
  fcm.displayAISuggestion = vi.fn();
  fcm.displayUserComment = vi.fn();
  fcm.updateCommentCount = vi.fn();
  return fcm;
}

const cardIds = container =>
  Array.from(container.querySelectorAll('.file-comment-card')).map(card => card.dataset.id);

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FileCommentManager.loadFileComments suggestion replacement', () => {
  it('leaves AI cards untouched when suggestions is null', () => {
    const { zone, container } = buildZone();
    const fcm = makeFileCommentManager(zone);
    const comment = { id: 'new-user', file: 'src/a.js', is_file_level: 1 };

    fcm.loadFileComments([comment], null);

    // The old user comment is replaced; the AI card survives.
    expect(cardIds(container)).toEqual(['old-ai']);
    expect(fcm.displayUserComment).toHaveBeenCalledWith(zone, comment);
    expect(fcm.displayAISuggestion).not.toHaveBeenCalled();
  });

  it('clears AI cards when suggestions is an empty array and comments is null', () => {
    const { zone, container } = buildZone();
    const fcm = makeFileCommentManager(zone);

    fcm.loadFileComments(null, []);

    expect(cardIds(container)).toEqual(['old-user']);
    expect(fcm.displayAISuggestion).not.toHaveBeenCalled();
    expect(fcm.updateCommentCount).toHaveBeenCalledWith(zone);
  });

  it('clears user comment cards when comments is an empty array and suggestions is null', () => {
    const { zone, container } = buildZone();
    const fcm = makeFileCommentManager(zone);

    fcm.loadFileComments([], null);

    expect(cardIds(container)).toEqual(['old-ai']);
    expect(fcm.displayUserComment).not.toHaveBeenCalled();
    expect(fcm.updateCommentCount).toHaveBeenCalledWith(zone);
  });

  it('clears both kinds of card when both arguments are empty arrays', () => {
    const { zone, container } = buildZone();
    const fcm = makeFileCommentManager(zone);

    fcm.loadFileComments([], []);

    expect(cardIds(container)).toEqual([]);
  });

  it('replaces AI cards with a non-empty suggestions list', () => {
    const { zone, container } = buildZone();
    const fcm = makeFileCommentManager(zone);
    const suggestion = { id: 'new-ai', file: 'src/a.js', is_file_level: 1 };

    fcm.loadFileComments(null, [suggestion]);

    expect(cardIds(container)).toEqual(['old-user']);
    expect(fcm.displayAISuggestion).toHaveBeenCalledWith(zone, suggestion);
  });

  it('leaves both kinds of card alone when both arguments are null', () => {
    const { zone, container } = buildZone();
    const fcm = makeFileCommentManager(zone);

    fcm.loadFileComments(null, null);

    expect(cardIds(container)).toEqual(['old-ai', 'old-user']);
  });
});

describe('PRManager.loadUserComments', () => {
  it('passes null suggestions so file-level AI cards survive the reload', async () => {
    const fileComment = { id: 7, file: 'src/a.js', is_file_level: 1, status: 'active' };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ comments: [fileComment] })
    })));

    const { zone, container } = buildZone();
    const fcm = makeFileCommentManager(zone);
    const loadSpy = vi.spyOn(fcm, 'loadFileComments');

    const manager = Object.create(PRManager.prototype);
    manager.currentPR = { id: 'review-1' };
    manager.pierreBridge = null;
    manager.fileCommentManager = fcm;
    manager.updateCommentCount = vi.fn();

    await manager.loadUserComments();

    expect(loadSpy).toHaveBeenCalledWith([fileComment], null);
    expect(cardIds(container)).toEqual(['old-ai']);
    expect(fcm.displayUserComment).toHaveBeenCalledWith(zone, fileComment);
  });
});

describe('PRManager.loadUserComments with no file-level comments', () => {
  it('passes an empty list so the card of a deleted last comment is removed', async () => {
    const lineComment = { id: 8, file: 'src/a.js', line_start: 4, side: 'RIGHT', is_file_level: 0, status: 'active' };
    const dismissedFileComment = { id: 9, file: 'src/a.js', is_file_level: 1, status: 'inactive' };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ comments: [lineComment, dismissedFileComment] })
    })));

    const { zone, container } = buildZone();
    const fcm = makeFileCommentManager(zone);
    const loadSpy = vi.spyOn(fcm, 'loadFileComments');

    const manager = Object.create(PRManager.prototype);
    manager.currentPR = { id: 'review-1' };
    manager.pierreBridge = null;
    manager.fileCommentManager = fcm;
    manager.updateCommentCount = vi.fn();
    manager.ensureLinesVisible = vi.fn(async () => {});
    manager.findFileElement = vi.fn(() => null);

    await manager.loadUserComments(true);

    expect(loadSpy).toHaveBeenCalledWith([], null);
    // The stale user card is gone; the AI card stays.
    expect(cardIds(container)).toEqual(['old-ai']);
    expect(fcm.displayUserComment).not.toHaveBeenCalled();
  });
});

describe('SuggestionManager.displayAISuggestions file-level routing', () => {
  function makeSuggestionManager(fileCommentManager) {
    const sm = Object.create(SuggestionManager.prototype);
    sm.prManager = {
      currentPR: { id: 'review-1' },
      ensureFileBodyRendered: vi.fn(async () => null),
      ensureLinesVisible: vi.fn(async () => {}),
      suggestionNavigator: null,
      fileCommentManager
    };
    sm._closeReasoningPopover = vi.fn();
    sm.findFileElement = vi.fn(() => null);
    return sm;
  }

  it('clears stale file-level AI cards when the new set has no file-level findings', async () => {
    const { zone, container } = buildZone();
    const fcm = makeFileCommentManager(zone);
    const loadSpy = vi.spyOn(fcm, 'loadFileComments');
    const sm = makeSuggestionManager(fcm);

    await sm.displayAISuggestions([{ id: 1, file: 'src/a.js', line_start: 3, side: 'RIGHT' }]);

    expect(loadSpy).toHaveBeenLastCalledWith(null, []);
    expect(loadSpy).not.toHaveBeenCalledWith([], expect.anything());
    expect(cardIds(container)).toEqual(['old-user']);
  });

  it('clears stale file-level AI cards when there are no suggestions at all', async () => {
    const { zone, container } = buildZone();
    const fcm = makeFileCommentManager(zone);
    const sm = makeSuggestionManager(fcm);

    await sm.displayAISuggestions([]);

    expect(cardIds(container)).toEqual(['old-user']);
  });

  it('routes file-level suggestions to the file comment manager', async () => {
    const { zone } = buildZone();
    const fcm = makeFileCommentManager(zone);
    const loadSpy = vi.spyOn(fcm, 'loadFileComments');
    const sm = makeSuggestionManager(fcm);
    const fileLevel = { id: 2, file: 'src/a.js', is_file_level: 1, line_start: null };

    await sm.displayAISuggestions([fileLevel]);

    expect(loadSpy).toHaveBeenLastCalledWith(null, [fileLevel]);
    expect(fcm.displayAISuggestion).toHaveBeenCalledWith(zone, fileLevel);
  });
});
