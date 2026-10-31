// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Reloads triggered from outside the tab (the review:comments_changed event,
 * and the dirty-flag recovery when a hidden tab becomes visible) must keep
 * the comment panel's "show dismissed" filter, or dismissed comments vanish
 * from the panel until the filter is toggled again (issue #612).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');
const PostedComment = require('../../public/js/utils/posted-comment.js');

let hidden;
let listeners;

beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  // Track document listeners so each test starts with a clean document.
  listeners = [];
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
    listeners.push([type, fn, opts]);
    add(type, fn, opts);
  });
  window.chatPanel = undefined;
});

afterEach(() => {
  for (const [type, fn, opts] of listeners) document.removeEventListener(type, fn, opts);
  delete document.hidden;
  delete window.aiPanel;
  delete window.PostedComment;
  vi.restoreAllMocks();
});

const COMMENTS = [
  { id: 1, status: 'active', file: 'src/a.js', line_start: 10, body: 'Pending' },
  { id: 2, status: 'inactive', file: 'src/a.js', line_start: 11, body: 'Dismissed' }
];

function makeManager() {
  const manager = Object.create(PRManager.prototype);
  manager.currentPR = { id: 42, owner: 'acme', repo: 'widget', number: 7 };
  manager._clientId = 'this-tab';
  manager.ensureLinesVisible = vi.fn();
  manager.findFileElement = () => null;
  manager.updateCommentCount = vi.fn();
  manager._initReviewEventListeners();
  vi.spyOn(manager, '_loadUserComments');
  return manager;
}

function panel(showDismissed) {
  return { showDismissedComments: showDismissed, setComments: vi.fn() };
}

/** Ids of the comments the panel was last given. */
function panelIds() {
  return window.aiPanel.setComments.mock.lastCall[0].map(c => c.id);
}

function fireCommentsChanged(detail = {}) {
  document.dispatchEvent(new CustomEvent('review:comments_changed', {
    detail: { reviewId: 42, sourceClientId: 'other-tab', ...detail }
  }));
}

describe('event-triggered comment reloads keep "show dismissed"', () => {
  beforeEach(() => {
    window.PostedComment = PostedComment;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      // Every comment is fetched, dismissed ones included; the panel's
      // filter decides what shows.
      expect(url).toBe('/api/reviews/42/comments?includeDismissed=true');
      return { ok: true, json: async () => ({ comments: COMMENTS }) };
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([true, false])('review:comments_changed reload with showDismissed=%s keeps the panel filter', async (showDismissed) => {
    vi.useFakeTimers();
    let manager;
    try {
      window.aiPanel = panel(showDismissed);
      manager = makeManager();

      fireCommentsChanged();
      vi.runAllTimers(); // the listener debounces its reload
    } finally {
      vi.useRealTimers();
    }
    expect(manager._loadUserComments).toHaveBeenCalledTimes(1);
    await manager._latestUserCommentsLoad;
    expect(panelIds()).toEqual(showDismissed ? [1, 2] : [1]);
  });

  it.each([true, false])('dirty-flag recovery on becoming visible with showDismissed=%s keeps the panel filter', async (showDismissed) => {
    window.aiPanel = panel(showDismissed);
    const manager = makeManager();

    hidden = true;
    fireCommentsChanged();
    expect(manager._dirtyComments).toBe(true);
    expect(manager._loadUserComments).not.toHaveBeenCalled();

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));

    expect(manager._loadUserComments).toHaveBeenCalledTimes(1);
    await manager._latestUserCommentsLoad;
    expect(panelIds()).toEqual(showDismissed ? [1, 2] : [1]);
  });

  it('reads the filter at render time, not when the event arrived', async () => {
    window.aiPanel = panel(false);
    const manager = makeManager();

    hidden = true;
    fireCommentsChanged();
    window.aiPanel.showDismissedComments = true;
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));

    await manager._latestUserCommentsLoad;
    expect(panelIds()).toEqual([1, 2]);
  });

  it('prefers the panel filter state object when it has one', async () => {
    window.aiPanel = {
      ...panel(false),
      getCommentFilterState: () => ({ includeDismissed: true, showPosted: true })
    };
    const manager = makeManager();
    await manager.loadUserComments();
    expect(panelIds()).toEqual([1, 2]);
  });

  it('keeps dismissed comments in the cache but out of the panel by default', async () => {
    window.aiPanel = panel(false);
    const manager = makeManager();
    await expect(manager.loadUserComments()).resolves.toBe(true);
    expect(manager.userComments.map(c => c.id)).toEqual([1, 2]);
    expect(panelIds()).toEqual([1]);
  });
});
