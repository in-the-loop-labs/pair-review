// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * SuggestionManager display coalescing and the full AI suggestion clear.
 *
 * - displayAISuggestions never interleaves. A call made while one runs
 *   records its list and returns at once; the latest recorded list is
 *   displayed when the running one ends. A failure in that queued display is
 *   logged, never rethrown over the first display's own outcome.
 * - clearAISuggestions removes inline rows, Pierre suggestion annotations,
 *   file-level AI cards and the navigator list, and abandons a display that
 *   is running or queued (it would bring the cleared findings back).
 * - PRManager.clearFindingsForNewAnalysis is the one analysis-start clear,
 *   used by PR mode (startAnalysis) and Local mode (startLocalAnalysis).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

global.STALE_TIMEOUT = 2000;

const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');
const { PRManager } = require('../../public/js/pr.js');
const { LocalManager } = require('../../public/js/local.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makePrManager(overrides = {}) {
  return {
    currentPR: { id: 'review-1' },
    pierreBridge: null,
    ensureFileBodyRendered: vi.fn(async () => null),
    ensureLinesVisible: vi.fn(async () => {}),
    findFileElement: vi.fn(() => null),
    fileCommentManager: { loadFileComments: vi.fn() },
    suggestionNavigator: { updateSuggestions: vi.fn(), isCollapsed: false },
    ...overrides
  };
}

const finding = id => ({ id, file: 'src/a.js', line_start: id, side: 'RIGHT', status: 'active' });

let pm;
let sm;

beforeEach(() => {
  document.body.innerHTML = '';
  window.aiPanel = { addFindings: vi.fn() };
  pm = makePrManager();
  sm = new SuggestionManager(pm);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.aiPanel;
  delete window.prManager;
});

const navigatorLists = () => pm.suggestionNavigator.updateSuggestions.mock.calls.map(call => call[0]);

describe('SuggestionManager.displayAISuggestions coalescing', () => {
  it('displays the latest list requested during a display, skipping the ones in between', async () => {
    const gate = deferred();
    pm.ensureLinesVisible = vi.fn(() => gate.promise);
    const first = [finding(1)];
    const middle = [finding(2)];
    const latest = [finding(3)];

    const running = sm.displayAISuggestions(first);
    expect(sm._isDisplayingSuggestions).toBe(true);
    // Queued calls return at once rather than waiting for the running one.
    await sm.displayAISuggestions(middle);
    await sm.displayAISuggestions(latest);
    expect(navigatorLists()).toEqual([]);

    gate.resolve();
    await running;
    await vi.waitFor(() => expect(sm._isDisplayingSuggestions).toBe(false));

    expect(navigatorLists()).toEqual([first, latest]);
    expect(window.aiPanel.addFindings.mock.calls.map(call => call[0])).toEqual([first, latest]);
    expect(sm._pendingSuggestions).toBeNull();
  });

  it('runs the queued display through PRManager.displayAISuggestions when present', async () => {
    const gate = deferred();
    pm.ensureLinesVisible = vi.fn(() => gate.promise);
    pm.displayAISuggestions = vi.fn(list => sm.displayAISuggestions(list));
    const latest = [finding(3)];

    const running = sm.displayAISuggestions([finding(1)]);
    await sm.displayAISuggestions(latest);
    gate.resolve();
    await running;

    await vi.waitFor(() => expect(navigatorLists()).toContain(latest));
    expect(pm.displayAISuggestions).toHaveBeenCalledExactlyOnceWith(latest);
  });

  it('keeps the first display error and only logs a failure of the queued display', async () => {
    const gate = deferred();
    pm.ensureLinesVisible = vi.fn()
      .mockImplementationOnce(() => gate.promise)
      .mockImplementation(async () => {});
    const queued = [finding(2)];
    pm.suggestionNavigator.updateSuggestions = vi.fn(list => {
      if (list === queued) throw new Error('queued boom');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const running = sm.displayAISuggestions([finding(1)]);
    await sm.displayAISuggestions(queued);
    gate.reject(new Error('first boom'));

    await expect(running).rejects.toThrow('first boom');
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
      '[UI] Queued suggestion display failed:',
      expect.objectContaining({ message: 'queued boom' })
    ));
    expect(sm._isDisplayingSuggestions).toBe(false);
  });

  it('keeps the navigator list while a display runs, so its selection survives', async () => {
    const list = [finding(1), finding(2)];
    await sm.displayAISuggestions(list);
    // Only the new list reaches the navigator: no interim empty list that
    // would drop the selection.
    expect(navigatorLists()).toEqual([list]);
  });

  it('replaces file-level AI cards without touching user cards', async () => {
    const fileLevel = { id: 9, file: 'src/a.js', is_file_level: 1, line_start: null };

    await sm.displayAISuggestions([finding(1), fileLevel]);

    const calls = pm.fileCommentManager.loadFileComments.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // Comments are always null, so user file-level cards are left alone.
    expect(calls.every(([comments]) => comments === null)).toBe(true);
    expect(calls[calls.length - 1]).toEqual([null, [fileLevel]]);
  });
});

describe('SuggestionManager.clearAISuggestions', () => {
  it('removes inline rows, Pierre suggestion annotations, file-level AI cards and the navigator list', () => {
    document.body.innerHTML = `
      <div class="main-content navigator-visible"></div>
      <table><tbody>
        <tr class="code-row"></tr>
        <tr class="ai-suggestion-row"></tr>
        <tr class="user-comment-row"></tr>
        <tr class="ai-suggestion-row"></tr>
      </tbody></table>
      <div class="reasoning-popover"></div>
    `;
    pm.pierreBridge = {
      files: new Map([['src/a.js', {}], ['src/b.js', {}]]),
      removeAnnotationsByType: vi.fn()
    };

    sm.clearAISuggestions();

    expect(document.querySelectorAll('.ai-suggestion-row')).toHaveLength(0);
    expect(document.querySelectorAll('.user-comment-row')).toHaveLength(1);
    expect(document.querySelector('.reasoning-popover')).toBeNull();
    expect(pm.pierreBridge.removeAnnotationsByType.mock.calls).toEqual([
      ['src/a.js', 'suggestion'],
      ['src/b.js', 'suggestion']
    ]);
    expect(pm.fileCommentManager.loadFileComments).toHaveBeenCalledExactlyOnceWith(null, []);
    expect(navigatorLists()).toEqual([[]]);
    expect(document.querySelector('.main-content').classList.contains('navigator-visible')).toBe(false);
  });

  it('works without a navigator, Pierre bridge or file comment manager', () => {
    sm = new SuggestionManager(makePrManager({ suggestionNavigator: null, fileCommentManager: null }));
    expect(() => sm.clearAISuggestions()).not.toThrow();
  });

  it('abandons a running display and the one queued behind it', async () => {
    const gate = deferred();
    pm.ensureLinesVisible = vi.fn(() => gate.promise);

    const running = sm.displayAISuggestions([finding(1)]);
    await sm.displayAISuggestions([finding(2)]);
    sm.clearAISuggestions();
    gate.resolve();
    await running;

    // Only the clear reached the navigator; the stale lists never showed.
    expect(navigatorLists()).toEqual([[]]);
    expect(window.aiPanel.addFindings).not.toHaveBeenCalled();
    expect(sm._pendingSuggestions).toBeNull();
    expect(sm._isDisplayingSuggestions).toBe(false);

    // The next display (the new run's results) shows normally.
    const fresh = [finding(5)];
    await sm.displayAISuggestions(fresh);
    expect(navigatorLists()).toEqual([[], fresh]);
    expect(window.aiPanel.addFindings).toHaveBeenCalledExactlyOnceWith(fresh);
  });
});

describe('PRManager.clearFindingsForNewAnalysis', () => {
  function makeManager() {
    const manager = Object.create(PRManager.prototype);
    manager.suggestionManager = { clearAISuggestions: vi.fn() };
    return manager;
  }

  it('clears through the AI panel, which also clears the diff view', () => {
    const manager = makeManager();
    window.aiPanel = { clearAllFindings: vi.fn() };

    manager.clearFindingsForNewAnalysis();

    expect(window.aiPanel.clearAllFindings).toHaveBeenCalledTimes(1);
    expect(manager.suggestionManager.clearAISuggestions).not.toHaveBeenCalled();
  });

  it('still clears the diff view when the AI panel fails', () => {
    const manager = makeManager();
    window.aiPanel = { clearAllFindings: vi.fn(() => { throw new Error('panel broke'); }) };

    manager.clearFindingsForNewAnalysis();

    expect(manager.suggestionManager.clearAISuggestions).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('Error clearing AI panel findings:', expect.any(Error));
  });

  it('clears the diff view when there is no AI panel', () => {
    const manager = makeManager();
    delete window.aiPanel;

    manager.clearFindingsForNewAnalysis();

    expect(manager.suggestionManager.clearAISuggestions).toHaveBeenCalledTimes(1);
  });

  it('runs before the PR-mode analysis request is sent', async () => {
    const manager = makeManager();
    const order = [];
    manager.clearFindingsForNewAnalysis = vi.fn(() => order.push('clear'));
    manager.showError = vi.fn();
    manager.resetButton = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => {
      order.push('fetch');
      return { ok: false, json: async () => ({ error: 'stop here' }) };
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await manager.startAnalysis('owner', 'repo', 1, null, { provider: 'claude' });

    expect(order).toEqual(['clear', 'fetch']);
  });
});

describe('Local mode analysis start', () => {
  it('clears the previous findings before the analysis request, like PR mode', async () => {
    const order = [];
    window.prManager = {
      clearFindingsForNewAnalysis: vi.fn(() => order.push('clear')),
      showError: vi.fn(),
      resetButton: vi.fn()
    };
    vi.stubGlobal('fetch', vi.fn(async () => {
      order.push('fetch');
      return { ok: false, json: async () => ({ error: 'stop here' }) };
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const localManager = Object.create(LocalManager.prototype);
    localManager.reviewId = 42;

    await localManager.startLocalAnalysis(null, { provider: 'claude' });

    expect(order).toEqual(['clear', 'fetch']);
    expect(window.prManager.showError).toHaveBeenCalledWith('Failed to start AI analysis: stop here');
  });
});
