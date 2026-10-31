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
  vi.restoreAllMocks();
});

function makeManager() {
  const manager = Object.create(PRManager.prototype);
  manager.currentPR = { id: 42, owner: 'acme', repo: 'widget', number: 7 };
  manager._clientId = 'this-tab';
  manager._loadUserComments = vi.fn().mockResolvedValue(true);
  manager._initReviewEventListeners();
  return manager;
}

function fireCommentsChanged(detail = {}) {
  document.dispatchEvent(new CustomEvent('review:comments_changed', {
    detail: { reviewId: 42, sourceClientId: 'other-tab', ...detail }
  }));
}

describe('event-triggered comment reloads keep "show dismissed"', () => {
  it.each([true, false])('review:comments_changed reloads with includeDismissed=%s', (showDismissed) => {
    vi.useFakeTimers();
    try {
      window.aiPanel = { showDismissedComments: showDismissed };
      const manager = makeManager();

      fireCommentsChanged();
      vi.runAllTimers(); // the listener debounces its reload

      expect(manager._loadUserComments).toHaveBeenCalledTimes(1);
      expect(manager._loadUserComments).toHaveBeenCalledWith(showDismissed);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([true, false])('dirty-flag recovery on becoming visible reloads with includeDismissed=%s', (showDismissed) => {
    window.aiPanel = { showDismissedComments: showDismissed };
    const manager = makeManager();

    hidden = true;
    fireCommentsChanged();
    expect(manager._dirtyComments).toBe(true);
    expect(manager._loadUserComments).not.toHaveBeenCalled();

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));

    expect(manager._loadUserComments).toHaveBeenCalledTimes(1);
    expect(manager._loadUserComments).toHaveBeenCalledWith(showDismissed);
  });

  it('reads the filter at reload time, not when the event arrived', () => {
    window.aiPanel = { showDismissedComments: false };
    const manager = makeManager();

    hidden = true;
    fireCommentsChanged();
    window.aiPanel.showDismissedComments = true;
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));

    expect(manager._loadUserComments).toHaveBeenCalledWith(true);
  });

  it('defaults to no dismissed comments when the panel is missing', () => {
    const manager = makeManager();
    manager.loadUserComments();
    expect(manager._loadUserComments).toHaveBeenCalledWith(false);
  });

  it('still honours an explicit argument over the panel state', () => {
    window.aiPanel = { showDismissedComments: true };
    const manager = makeManager();
    manager.loadUserComments(false);
    expect(manager._loadUserComments).toHaveBeenCalledWith(false);
  });
});
