// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * File-level AI suggestion cards and user comment reloads.
 *
 * FileCommentManager.loadFileComments(comments, suggestions) treats the
 * suggestions argument as a replacement list: any array (even an empty one)
 * replaces the rendered AI cards, and null leaves them alone. Its two callers
 * rely on that:
 *   - PRManager.loadUserComments (PR and Local mode share it) passes null, so
 *     reloading user comments never wipes the AI cards.
 *   - SuggestionManager.displayAISuggestions (PR and Local mode share it)
 *     always passes the current file-level list, so a new run or level with
 *     no file-level findings clears the previous cards.
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

  it('clears AI cards when suggestions is an empty array', () => {
    const { zone, container } = buildZone();
    const fcm = makeFileCommentManager(zone);

    fcm.loadFileComments([], []);

    // User comments are managed independently: an empty comments list
    // leaves them in place.
    expect(cardIds(container)).toEqual(['old-user']);
    expect(fcm.displayAISuggestion).not.toHaveBeenCalled();
    expect(fcm.updateCommentCount).toHaveBeenCalledWith(zone);
  });

  it('replaces AI cards with a non-empty suggestions list', () => {
    const { zone, container } = buildZone();
    const fcm = makeFileCommentManager(zone);
    const suggestion = { id: 'new-ai', file: 'src/a.js', is_file_level: 1 };

    fcm.loadFileComments([], [suggestion]);

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

    expect(loadSpy).toHaveBeenCalledWith([], []);
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

    expect(loadSpy).toHaveBeenCalledWith([], [fileLevel]);
    expect(fcm.displayAISuggestion).toHaveBeenCalledWith(zone, fileLevel);
  });
});
