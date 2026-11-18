// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * The page's card resolvers and the data-first writes behind them.
 *
 * PRManager.findCommentCard and findSuggestionCard are the one way to get a
 * card: from the bridge (which hands back the element it built whether or
 * not the diff has it on screen), then from the file-comment zone registry
 * (which also holds zones that are not attached). The document is never
 * asked: an element there that neither of the two holds is not a card of
 * the page. patchUserComment and _setSuggestionStatus
 * write the change to the data a card is built from, so a card built later
 * is right, and a dismissed comment is not drawn again.
 *
 * The bridge is the production one without the vendor
 * (tests/utils/pierre-bridge-harness.js); nothing is ever drawn.
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';

const { makePageManager } = require('../utils/page-manager.js');
const { createBridgeHarness, restoreBridgeHarnesses } = require('../utils/pierre-bridge-harness.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});
afterEach(() => restoreBridgeHarnesses());
const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');
const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');
const PostedComment = require('../../public/js/utils/posted-comment.js');

function lineComment(id, overrides = {}) {
  return { id, file: 'a.js', line_start: 10, side: 'RIGHT', status: 'active', body: `comment ${id}`, ...overrides };
}

function commentAnnotation(comment) {
  return { lineNumber: comment.line_start, side: comment.side, type: 'comment', id: `comment-${comment.id}`, data: comment };
}

function suggestionAnnotation(suggestion) {
  return { lineNumber: suggestion.line_start, side: 'RIGHT', type: 'suggestion', id: `suggestion-${suggestion.id}`, data: suggestion };
}

/** A page manager with a real bridge holding a.js and b.js, and a real zone registry. */
function makeManager(overrides = {}) {
  const bridge = createBridgeHarness(vi, vendor, { files: ['a.js', 'b.js'] });
  const manager = makePageManager({ pierreBridge: bridge, ...overrides });
  manager.fileCommentManager = Object.create(FileCommentManager.prototype);
  manager.fileCommentManager.prManager = manager;
  manager.updateCommentCount = vi.fn();
  window.prManager = manager;
  return { manager, bridge };
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.PostedComment = PostedComment;
});

afterEach(() => {
  delete window.prManager;
  delete window.aiPanel;
  delete window.PostedComment;
  vi.restoreAllMocks();
});

describe('PRManager.findCommentCard', () => {
  it('returns the card the bridge holds for a line comment, attached or not, and the same one every time', () => {
    const { manager, bridge } = makeManager();
    const comment = lineComment(7);
    manager.userComments = [comment];
    bridge.addAnnotation('a.js', commentAnnotation(comment));

    const card = manager.findCommentCard(7);

    expect(card.classList.contains('user-comment-row')).toBe(true);
    expect(card.dataset.commentId).toBe('7');
    expect(card.isConnected).toBe(false);
    expect(manager.findCommentCard('7')).toBe(card);
    expect(bridge.getAnnotationElement).toHaveBeenCalledWith('a.js', 'comment-7', { create: true });
  });

  it('finds the annotation by its data when the cache does not know the comment or names another file', () => {
    const { manager, bridge } = makeManager();
    bridge.addAnnotation('b.js', commentAnnotation(lineComment(8, { file: 'b.js' })));
    manager.userComments = [lineComment(8, { file: 'a.js' })];

    expect(manager.findCommentCard(8).dataset.commentId).toBe('8');
    manager.userComments = [];
    expect(manager.findCommentCard(8).dataset.commentId).toBe('8');
  });

  it('finds a file-level card in its zone, also when the zone is not attached to the document', () => {
    const { manager } = makeManager();
    const zone = document.createElement('div');
    zone.innerHTML = '<div class="file-comments-container"><div class="file-comment-card" data-comment-id="9"></div></div>';
    manager.fileCommentManager._registerZone(zone, 'a.js', false);

    const card = manager.findCommentCard(9);
    expect(card).toBe(zone.querySelector('.file-comment-card'));
    expect(manager.findCommentCard(9, { fileLevel: true })).toBe(card);
    // Asked for a line comment only: a file-level card is not one.
    expect(manager.findCommentCard(9, { fileLevel: false })).toBeNull();
  });

  it('does not ask the document: an element there that the bridge and the zones do not hold is not a card', () => {
    const { manager } = makeManager();
    document.body.innerHTML = '<div class="user-comment-row" data-comment-id="12"></div>'
      + '<div class="file-comment-card" data-comment-id="13"></div>';

    expect(manager.findCommentCard(12)).toBeNull();
    expect(manager.findCommentCard(12, { fileLevel: false })).toBeNull();
    expect(manager.findCommentCard(13)).toBeNull();
    expect(manager.findCommentCard(13, { fileLevel: true })).toBeNull();
  });

  it('returns null for a missing id, an unknown comment, and without a bridge or zones', () => {
    const { manager } = makeManager();
    expect(manager.findCommentCard(null)).toBeNull();
    expect(manager.findCommentCard(undefined)).toBeNull();
    expect(manager.findCommentCard('')).toBeNull();
    expect(manager.findCommentCard(404)).toBeNull();

    const bare = makePageManager();
    expect(bare.findCommentCard(1)).toBeNull();
  });

  it('does not let a quote in an id break the lookup', () => {
    const { manager } = makeManager();
    expect(() => manager.findCommentCard('x"] , [data-x="')).not.toThrow();
    expect(manager.findCommentCard('x"] , [data-x="')).toBeNull();
  });
});

describe('PRManager._findCommentEditTextarea', () => {
  it('finds the open edit form\'s textarea inside the comment\'s card, attached or not', () => {
    const { manager, bridge } = makeManager();
    const comment = lineComment(7);
    manager.userComments = [comment];
    bridge.addAnnotation('a.js', commentAnnotation(comment));
    const card = manager.findCommentCard(7);
    card.querySelector('.user-comment').insertAdjacentHTML('beforeend',
      '<div class="user-comment-edit-form"><textarea id="edit-comment-7"></textarea></div>');

    expect(card.isConnected).toBe(false);
    expect(manager._findCommentEditTextarea(7)).toBe(card.querySelector('textarea'));
    expect(manager._findCommentEditTextarea('7', card)).toBe(card.querySelector('textarea'));
  });

  it('is null when no edit form is open, the comment is unknown, or the textarea is not in the comment\'s card', () => {
    const { manager, bridge } = makeManager();
    document.body.innerHTML = '<textarea id="edit-comment-12"></textarea>';
    expect(manager._findCommentEditTextarea(12)).toBeNull();

    const comment = lineComment(7);
    manager.userComments = [comment];
    bridge.addAnnotation('a.js', commentAnnotation(comment));
    expect(manager._findCommentEditTextarea(7)).toBeNull();
    expect(manager._findCommentEditTextarea(404)).toBeNull();
    expect(() => manager._findCommentEditTextarea('x"]')).not.toThrow();
  });
});

describe('PRManager.findSuggestionCard', () => {
  function withSuggestionManager(manager) {
    const sm = Object.create(SuggestionManager.prototype);
    sm.prManager = manager;
    manager.suggestionManager = sm;
    return sm;
  }

  it('returns the card the bridge holds for a line suggestion', () => {
    const { manager, bridge } = makeManager();
    bridge.addAnnotation('b.js', suggestionAnnotation({ id: 3, file: 'b.js', line_start: 5, type: 'bug', title: 't', body: 'b' }));

    const card = manager.findSuggestionCard(3);

    expect(card.classList.contains('ai-suggestion')).toBe(true);
    expect(card.dataset.suggestionId).toBe('3');
    expect(manager.findSuggestionCard('3')).toBe(card);
  });

  it('finds a file-level AI card in a zone that is not attached, and does not ask the document', () => {
    const { manager } = makeManager();
    const zone = document.createElement('div');
    zone.innerHTML = '<div class="file-comment-card ai-suggestion" data-suggestion-id="4"></div>';
    manager.fileCommentManager._registerZone(zone, 'a.js', false);
    document.body.innerHTML = '<div class="ai-suggestion" data-suggestion-id="5"></div>';

    expect(manager.findSuggestionCard(4)).toBe(zone.firstElementChild);
    expect(manager.findSuggestionCard(5)).toBeNull();
  });

  it('returns null for a missing id and an unknown suggestion', () => {
    const { manager } = makeManager();
    expect(manager.findSuggestionCard(null)).toBeNull();
    expect(manager.findSuggestionCard('')).toBeNull();
    expect(manager.findSuggestionCard(404)).toBeNull();
  });

  it('_setSuggestionStatus writes the status to the suggestion the card is built from', () => {
    const { manager, bridge } = makeManager();
    const sm = withSuggestionManager(manager);
    const suggestion = { id: 3, file: 'a.js', line_start: 5, type: 'bug', title: 't', body: 'b', status: 'active' };
    bridge.addAnnotation('a.js', suggestionAnnotation(suggestion));
    const mark = vi.spyOn(sm, 'markSuggestionSynced');

    manager._setSuggestionStatus(3, 'dismissed');
    expect(suggestion.status).toBe('dismissed');
    // No card has been built: nothing to mark, and none was built for it.
    expect(mark).toHaveBeenCalledWith(undefined, suggestion);

    // A card built afterwards shows the status it has now.
    const card = manager.findSuggestionCard(3);
    expect(card.classList.contains('collapsed')).toBe(true);

    manager._setSuggestionStatus('3', 'active');
    expect(suggestion.status).toBe('active');
    expect(mark).toHaveBeenLastCalledWith(card, suggestion);
  });

  describe('a lookup leaves the card as the reader left it', () => {
    const label = card => card.querySelector('.btn-restore .btn-text').textContent;

    /** A line suggestion whose card the diff has drawn, with the real suggestion manager. */
    function drawnSuggestion() {
      const { manager, bridge } = makeManager();
      withSuggestionManager(manager);
      const suggestion = { id: 3, file: 'a.js', line_start: 5, type: 'bug', title: 't', body: 'b', status: 'active' };
      bridge.addAnnotation('a.js', suggestionAnnotation(suggestion));
      const [annotation] = bridge.getAnnotations('a.js', 'suggestion');
      // What the viewer does when it draws the file: its render callback.
      const draw = () => bridge._renderAnnotation(annotation, { item: { id: 'a.js' } });
      const element = draw();
      const card = element.matches('.ai-suggestion') ? element : element.querySelector('.ai-suggestion');
      // The review panel holds the same suggestion object and writes its status.
      window.aiPanel = { updateFindingStatus: vi.fn((id, status) => { suggestion.status = status; }) };
      return { manager, bridge, suggestion, card, draw };
    }

    /** The adopt flow's own steps on the card and the data, as adoptSuggestion runs them. */
    function adopt(manager, suggestion) {
      manager.collapseSuggestionForAdoption(suggestion.id);
      const comment = lineComment(9, { line_start: 5, parent_id: suggestion.id });
      manager.pierreBridge.addAnnotation('a.js', commentAnnotation(comment));
      manager._notifyAdoption(suggestion.id, comment);
      return comment;
    }

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ dismissedSuggestionId: 3 }) })));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('an adopted suggestion the reader chose to show again stays open when its adopting comment is deleted', async () => {
      const { manager, suggestion, card, draw } = drawnSuggestion();
      const comment = adopt(manager, suggestion);
      expect(card.classList.contains('collapsed')).toBe(true);
      expect(card.dataset.hiddenForAdoption).toBe('true');

      // "Show": the reader opens the adopted suggestion again.
      await manager.restoreSuggestion(3);
      expect(card.classList.contains('collapsed')).toBe(false);
      expect(label(card)).toBe('Hide');
      // The diff draws the file meanwhile: the card is left open.
      draw();
      expect(card.classList.contains('collapsed')).toBe(false);

      await manager.deleteUserComment(comment.id);

      expect(suggestion.status).toBe('dismissed');
      expect(manager.findSuggestionCard(3)).toBe(card);
      expect(card.classList.contains('collapsed')).toBe(false);
      expect(label(card)).toBe('Hide');
      expect('hiddenForAdoption' in card.dataset).toBe(false);

      // And it is still open after the next draw of the file.
      expect(draw().contains(card)).toBe(true);
      expect(card.classList.contains('collapsed')).toBe(false);
      expect(label(card)).toBe('Hide');
      expect('hiddenForAdoption' in card.dataset).toBe(false);
    });

    it('dismissing a suggestion collapses it and leaves no adoption marker on the card', async () => {
      const { manager, suggestion, card, draw } = drawnSuggestion();

      await manager.dismissSuggestion(3);

      expect(suggestion.status).toBe('dismissed');
      expect(card.classList.contains('collapsed')).toBe(true);
      expect(label(card)).toBe('Show');
      expect('hiddenForAdoption' in card.dataset).toBe(false);
      draw();
      expect('hiddenForAdoption' in card.dataset).toBe(false);

      await manager.restoreSuggestion(3);
      expect(suggestion.status).toBe('active');
      expect(card.classList.contains('collapsed')).toBe(false);
      draw();
      expect(card.classList.contains('collapsed')).toBe(false);
    });

    it('findSuggestionCard and _setSuggestionStatus do not run the card\'s sync', () => {
      const { manager, suggestion, card } = drawnSuggestion();
      const sync = vi.spyOn(manager.suggestionManager, 'syncSuggestionElement');

      // The status changes in the data (another holder of the object wrote it).
      suggestion.status = 'dismissed';
      expect(manager.findSuggestionCard(3)).toBe(card);
      manager._setSuggestionStatus(3, 'dismissed');

      expect(sync).not.toHaveBeenCalled();
      expect(card.classList.contains('collapsed')).toBe(false);
    });

    it('a card the flows never saw is still corrected when the diff draws it', () => {
      const { suggestion, card, draw } = drawnSuggestion();
      // A status change that reached the data and not the card.
      suggestion.status = 'dismissed';
      draw();
      expect(card.classList.contains('collapsed')).toBe(true);
      expect(label(card)).toBe('Show');
    });
  });

  it('_setSuggestionStatus ignores a missing id, an unknown suggestion and a missing bridge', () => {
    const { manager } = makeManager();
    expect(() => manager._setSuggestionStatus(null, 'dismissed')).not.toThrow();
    expect(() => manager._setSuggestionStatus(404, 'dismissed')).not.toThrow();
    expect(() => makePageManager()._setSuggestionStatus(1, 'dismissed')).not.toThrow();
  });
});

describe('PRManager.patchUserComment keeps the diff\'s record of a comment in step', () => {
  beforeEach(() => {
    window.aiPanel = { removeComment: vi.fn(), updateComment: vi.fn(), setHiddenCommentCounts: vi.fn() };
  });

  it('a dismissal removes the annotation, so a re-render of the file cannot draw the comment again', () => {
    const { manager, bridge } = makeManager();
    const comment = lineComment(7);
    const other = lineComment(8, { line_start: 20 });
    manager.userComments = [comment, other];
    bridge.addAnnotations('a.js', [commentAnnotation(comment), commentAnnotation(other)]);

    manager.patchUserComment(7, { status: 'inactive' });

    expect(bridge.removeAnnotation).toHaveBeenCalledWith('a.js', 'comment-7');
    expect(bridge.getAnnotations('a.js', 'comment').map(a => a.metadata.id)).toEqual(['comment-8']);
    expect(manager.findCommentCard(7)).toBeNull();
    expect(manager.userComments.find(c => c.id === 7).status).toBe('inactive');
    expect(window.aiPanel.removeComment).toHaveBeenCalledWith(7);
  });

  it('an edit is written to the object the annotation holds, so a card built later shows it', () => {
    const { manager, bridge } = makeManager();
    const comment = lineComment(7, { body: 'before' });
    manager.userComments = [comment];
    bridge.addAnnotation('a.js', commentAnnotation(comment));

    manager.patchUserComment(7, { body: 'after' });

    expect(bridge.removeAnnotation).not.toHaveBeenCalled();
    expect(bridge.getAnnotations('a.js', 'comment')[0].metadata.data.body).toBe('after');
    expect(manager.findCommentCard(7).querySelector('.user-comment-body').textContent).toContain('after');
  });

  it('does nothing to the bridge for a file-level comment, an unknown comment, or without a bridge', () => {
    const { manager, bridge } = makeManager();
    manager.userComments = [{ id: 9, file: 'a.js', is_file_level: 1, status: 'active' }];

    manager.patchUserComment(9, { status: 'inactive' });
    manager.patchUserComment(404, { status: 'inactive' });
    expect(bridge.removeAnnotation).not.toHaveBeenCalled();

    const bare = makePageManager({ userComments: [lineComment(1)], updateCommentCount: vi.fn() });
    expect(() => bare.patchUserComment(1, { status: 'inactive' })).not.toThrow();
  });

  it('finds the annotation by its data when the cached comment names no file', () => {
    const { manager, bridge } = makeManager();
    const annotated = lineComment(7, { file: 'b.js' });
    bridge.addAnnotation('b.js', commentAnnotation(annotated));
    manager.userComments = [{ id: 7, status: 'active' }];

    manager.patchUserComment(7, { status: 'inactive' });

    expect(bridge.getAnnotations('b.js', 'comment')).toHaveLength(0);
  });
});

describe('PRManager.isFileInDiffPane', () => {
  afterEach(() => { delete window.DiffRenderer; });

  it('answers from the changed files and the context files, never from an element', () => {
    const manager = makePageManager({
      changedFilesByPath: new Map([['src/a.js', {}]]),
      contextFiles: [{ id: 1, file: 'docs/readme.md' }],
      findFileElement: vi.fn(() => { throw new Error('the DOM must not be asked'); }),
    });

    expect(manager.isFileInDiffPane('src/a.js')).toBe(true);
    expect(manager.isFileInDiffPane('docs/readme.md')).toBe(true);
    expect(manager.isFileInDiffPane('src/missing.js')).toBe(false);
    expect(manager.isFileInDiffPane('')).toBe(false);
    expect(manager.isFileInDiffPane(undefined)).toBe(false);
  });

  it('tolerates the path variants findFileElement accepts, and works before a diff is loaded', () => {
    window.DiffRenderer = {
      normalizeFilePath: path => path.replace(/^\.\//, ''),
      pathsMatch: (a, b) => a === b || a.endsWith(`/${b}`),
    };
    const manager = makePageManager({ changedFilesByPath: new Map([['src/a.js', {}]]) });
    expect(manager.isFileInDiffPane('./src/a.js')).toBe(true);
    expect(manager.isFileInDiffPane('a.js')).toBe(true);

    const empty = makePageManager({ changedFilesByPath: undefined, contextFiles: undefined });
    expect(empty.isFileInDiffPane('src/a.js')).toBe(false);
  });
});
