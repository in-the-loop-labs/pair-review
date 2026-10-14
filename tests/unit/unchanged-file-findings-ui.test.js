// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Browser side of AI findings on unchanged files: context panels for them,
 * the remove lock on panels that show feedback, voice selection, jumps,
 * overlapping suggestion displays and the retained-comments notice.
 * PR and Local mode share all of this (local.js reuses these PRManager
 * methods), so these tests cover both modes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');
const { PRManager } = require('../../public/js/pr.js');
const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');
const { AIPanel } = require('../../public/js/components/AIPanel.js');
require('../../public/js/modules/analysis-history.js');
const AnalysisHistoryManager = window.AnalysisHistoryManager;
const { ReviewModal } = require('../../public/js/components/ReviewModal.js');
global.STALE_TIMEOUT = 2000;
const { LocalManager } = require('../../public/js/local.js');

if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.escape !== 'function') {
  globalThis.CSS = window.CSS && typeof window.CSS.escape === 'function'
    ? window.CSS
    : { escape: (s) => String(s).replace(/[^a-zA-Z0-9_\-]/g, (c) => `\\${c}`) };
}

afterEach(() => {
  document.body.innerHTML = '';
  delete window.prManager;
  delete window.aiPanel;
  delete window.toast;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function contextWrapper(file) {
  const wrapper = document.createElement('div');
  wrapper.className = 'd2h-file-wrapper context-file';
  wrapper.dataset.fileName = file;
  const button = document.createElement('button');
  button.className = 'context-file-dismiss';
  button.title = 'Remove context file';
  wrapper.appendChild(button);
  document.body.appendChild(wrapper);
  return wrapper;
}

// The latest-wins display queue itself is covered by
// suggestion-display-queue.test.js; these cover redisplaySuggestions on it.
describe('SuggestionManager redisplay', () => {
  function createSuggestionManager({ ensureLinesVisible } = {}) {
    const sm = Object.create(SuggestionManager.prototype);
    sm._isDisplayingSuggestions = false;
    sm._pendingSuggestions = null;
    sm._latestSuggestions = null;
    sm._closeReasoningPopover = vi.fn();
    sm.prManager = {
      ensureFileBodyRendered: vi.fn(async () => {}),
      ensureLinesVisible: vi.fn(ensureLinesVisible || (async () => {})),
      pierreBridge: null,
      fileCommentManager: null
    };
    window.aiPanel = { addFindings: vi.fn() };
    return sm;
  }
  const findings = id => [{ id, file: 'a.js', line_start: 1, line_end: 1 }];

  it('does not deadlock when a running display waits on work that requests a display', async () => {
    const sm = createSuggestionManager();
    // e.g. a deferred diff render whose re-anchor reloads the suggestions
    sm.prManager.ensureLinesVisible.mockImplementationOnce(async () => {
      await sm.displayAISuggestions(findings('reanchored'));
    }).mockImplementation(async () => {});

    await sm.displayAISuggestions(findings('initial'));
    await vi.waitFor(() => expect(window.aiPanel.addFindings.mock.calls.at(-1)[0][0].id).toBe('reanchored'));
    expect(sm._isDisplayingSuggestions).toBe(false);
  });

  it('redisplays the most recently requested list, and nothing before any request', async () => {
    const sm = createSuggestionManager();
    await sm.redisplaySuggestions();
    expect(window.aiPanel.addFindings).not.toHaveBeenCalled();

    await sm.displayAISuggestions(findings('shown'));
    await sm.redisplaySuggestions();
    expect(window.aiPanel.addFindings).toHaveBeenCalledTimes(2);
    expect(window.aiPanel.addFindings.mock.calls.at(-1)[0][0].id).toBe('shown');
  });

  // Regression: a context-file reload during a new run redisplays the
  // remembered list. Starting the analysis cleared the findings through
  // clearAISuggestions (PR startAnalysis and Local startLocalAnalysis both go
  // through clearFindingsForNewAnalysis), which must forget that list.
  it('redisplays nothing once the findings were cleared for a new analysis', async () => {
    const sm = createSuggestionManager();
    await sm.displayAISuggestions(findings('previous run'));
    sm._pendingSuggestions = findings('queued');

    const manager = Object.create(PRManager.prototype);
    manager.suggestionManager = sm;
    manager.showError = vi.fn();
    manager.resetButton = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await manager.startAnalysis('o', 'r', 1, null, {});

    expect(sm._latestSuggestions).toBeNull();
    expect(sm._pendingSuggestions).toBeNull();
    await sm.redisplaySuggestions();
    expect(window.aiPanel.addFindings).toHaveBeenCalledTimes(1);
  });

  it('redisplays nothing once a Local analysis start cleared the findings', async () => {
    const sm = createSuggestionManager();
    await sm.displayAISuggestions(findings('previous run'));

    const manager = Object.create(PRManager.prototype);
    manager.suggestionManager = sm;
    manager.showError = vi.fn();
    manager.resetButton = vi.fn();
    window.prManager = manager;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: 'stop here' }) })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const localManager = Object.create(LocalManager.prototype);
    localManager.reviewId = 42;
    await localManager.startLocalAnalysis(null, { provider: 'claude' });

    expect(sm._latestSuggestions).toBeNull();
    await sm.redisplaySuggestions();
    expect(window.aiPanel.addFindings).toHaveBeenCalledTimes(1);
  });

  it('forgets the remembered list when the AI panel clears its findings', async () => {
    const sm = createSuggestionManager();
    await sm.displayAISuggestions(findings('previous run'));
    window.prManager = { suggestionManager: sm };
    const panel = Object.create(AIPanel.prototype);
    panel.updateSegmentCounts = vi.fn();
    panel.renderFindings = vi.fn();
    panel._notifyFeedbackChanged = vi.fn();
    panel.resetLevelFilter = vi.fn();

    panel.clearAllFindings();

    expect(sm._latestSuggestions).toBeNull();
    await sm.redisplaySuggestions();
    expect(window.aiPanel.addFindings).toHaveBeenCalledTimes(1);
  });

  it('abandons a redisplay that a clear interrupts', async () => {
    let release;
    const sm = createSuggestionManager();
    await sm.displayAISuggestions(findings('shown'));
    sm.prManager.ensureLinesVisible.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));

    const redisplay = sm.redisplaySuggestions();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    sm.clearAISuggestions();
    release();
    await redisplay;

    expect(window.aiPanel.addFindings).toHaveBeenCalledTimes(1);
    expect(sm._latestSuggestions).toBeNull();
    await sm.redisplaySuggestions();
    expect(window.aiPanel.addFindings).toHaveBeenCalledTimes(1);
  });
});

describe('context file remove lock', () => {
  it('explains why a file with active feedback cannot be removed', () => {
    const blocker = PRManager.getContextFileRemovalBlocker;
    expect(blocker('a.js', [], [])).toBeNull();
    expect(blocker('a.js', [{ file: 'a.js', status: 'dismissed' }], [{ file: 'a.js', status: 'inactive' }])).toBeNull();
    expect(blocker('a.js', [{ file: 'b.js', status: 'active' }], [])).toBeNull();
    expect(blocker('a.js', [{ file: 'a.js', status: 'active' }], []))
      .toBe("Can't remove: this file has 1 active AI finding. Dismiss or delete it to remove the file.");
    expect(blocker('a.js', [{ file: 'a.js', status: 'active' }, { file: 'a.js', status: 'adopted' }], [{ file: 'a.js', status: 'active' }]))
      .toBe("Can't remove: this file has 2 active AI findings and 1 comment. Dismiss or delete them to remove the file.");
  });

  it('checks a file against the feedback the AI panel shows', () => {
    const manager = Object.create(PRManager.prototype);
    expect(manager.contextFileRemovalBlocker('a.js')).toBeNull();
    window.aiPanel = { findings: [], comments: [{ file: 'a.js', status: 'active' }] };
    expect(manager.contextFileRemovalBlocker('a.js')).toContain('1 comment');
    expect(manager.contextFileRemovalBlocker('b.js')).toBeNull();
  });

  it('locks and unlocks each context file as its feedback changes', () => {
    const manager = Object.create(PRManager.prototype);
    const a = contextWrapper('a.js');
    const b = contextWrapper('b.js');
    window.aiPanel = { findings: [{ file: 'a.js', status: 'active' }], comments: [] };

    manager.updateContextFileRemovability();
    expect(a.querySelector('.context-file-dismiss').getAttribute('aria-disabled')).toBe('true');
    expect(a.querySelector('.context-file-dismiss').title).toContain('1 active AI finding');
    expect(b.querySelector('.context-file-dismiss').hasAttribute('aria-disabled')).toBe(false);

    // The finding is dismissed: the panel holds nothing and becomes removable
    window.aiPanel.findings[0].status = 'dismissed';
    manager.updateContextFileRemovability();
    expect(a.querySelector('.context-file-dismiss').hasAttribute('aria-disabled')).toBe(false);
    expect(a.querySelector('.context-file-dismiss').title).toBe('Remove context file');
  });

  it('ignores a click on a locked remove button and removes once unlocked', async () => {
    document.body.innerHTML = '<div id="diff-container"></div>';
    window.DiffRenderer = DiffRenderer;
    const manager = Object.create(PRManager.prototype);
    manager.collapsedFiles = new Set();
    manager.viewedFiles = new Set();
    manager.fileCommentManager = null;
    manager.fetchFileContent = vi.fn().mockResolvedValue({ lines: ['a'] });
    manager._buildContextChunkTbody = vi.fn(() => {
      const tbody = document.createElement('tbody');
      tbody.className = 'context-chunk';
      tbody.dataset.contextId = '7';
      return tbody;
    });
    manager.removeContextFile = vi.fn(async () => {});
    await manager.renderContextFile({ id: 7, file: 'a.js', line_start: 1, line_end: 1 });

    window.aiPanel = { findings: [{ file: 'a.js', status: 'active' }], comments: [] };
    manager.updateContextFileRemovability();
    const button = document.querySelector('.context-file-dismiss');
    button.click();
    expect(manager.removeContextFile).not.toHaveBeenCalled();

    window.aiPanel.findings = [];
    manager.updateContextFileRemovability();
    button.click();
    await vi.waitFor(() => expect(manager.removeContextFile).toHaveBeenCalledWith('7'));
  });

  it('is re-evaluated whenever the AI panel findings or comments change', () => {
    window.prManager = { updateContextFileRemovability: vi.fn() };
    const panel = Object.create(AIPanel.prototype);
    panel.findings = [];
    panel.comments = [];
    panel.updateSegmentCounts = vi.fn();
    panel.renderFindings = vi.fn();
    panel.saveCurrentSelection = vi.fn();
    panel.restoreSelection = vi.fn(() => true);
    panel.resetLevelFilter = vi.fn();

    panel.addFindings([{ id: 1, file: 'a.js', status: 'active' }]);
    panel.updateFindingStatus(1, 'dismissed');
    panel.clearAllFindings();
    panel.addComment({ id: 2, file: 'a.js' });
    panel.updateComment(2, { status: 'inactive' });
    panel.removeComment(2);
    panel.setComments([]);
    expect(window.prManager.updateContextFileRemovability).toHaveBeenCalledTimes(7);
  });
});

describe('loadContextFiles', () => {
  function createManager(contextFiles) {
    const manager = Object.create(PRManager.prototype);
    manager.currentPR = { id: 5 };
    manager.contextFiles = [];
    manager.diffFiles = [];
    manager.renderContextFile = vi.fn(async cf => contextWrapper(cf.file));
    manager._scrubRemovedContextState = vi.fn();
    manager.rebuildFileListWithContext = vi.fn();
    manager.loadUserComments = vi.fn(async () => {});
    manager.suggestionManager = { redisplaySuggestions: vi.fn(async () => {}) };
    manager.loadAISuggestions = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ contextFiles }) })));
    window.aiPanel = { findings: [{ file: 'a.js', status: 'active' }], comments: [] };
    return manager;
  }

  it('places the displayed findings in new panels without refetching them', async () => {
    const manager = createManager([{ id: 1, file: 'a.js', line_start: 1, line_end: 20 }]);
    await manager.loadContextFiles();

    expect(manager.loadUserComments).toHaveBeenCalledTimes(1);
    expect(manager.suggestionManager.redisplaySuggestions).toHaveBeenCalledTimes(1);
    expect(manager.loadAISuggestions).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.context-file-dismiss').getAttribute('aria-disabled')).toBe('true');
  });

  it('does not re-anchor when no new panel rendered', async () => {
    const manager = createManager([{ id: 1, file: 'a.js', line_start: 1, line_end: 20 }]);
    manager.contextFiles = [{ id: 1, file: 'a.js', line_start: 1, line_end: 20 }];
    await manager.loadContextFiles();

    expect(manager.renderContextFile).not.toHaveBeenCalled();
    expect(manager.suggestionManager.redisplaySuggestions).not.toHaveBeenCalled();
  });
});

describe('ensureContextPanelForJump', () => {
  function createManager() {
    const manager = Object.create(PRManager.prototype);
    manager.currentPR = { id: 5 };
    manager.diffFiles = [{ file: 'changed.js' }];
    manager.ensureContextFile = vi.fn(async () => ({ type: 'context' }));
    return manager;
  }

  it('reuses an existing panel even when the target line is not rendered yet', async () => {
    const manager = createManager();
    contextWrapper('helper.js');
    await manager.ensureContextPanelForJump('helper.js', 400);
    expect(manager.ensureContextFile).not.toHaveBeenCalled();
  });

  it('opens a panel around the target line when the file has none', async () => {
    const manager = createManager();
    await manager.ensureContextPanelForJump('helper.js', 40);
    expect(manager.ensureContextFile).toHaveBeenCalledWith('helper.js', 40);
  });

  it('does nothing for diff files or without a review', async () => {
    const manager = createManager();
    await manager.ensureContextPanelForJump('changed.js', 1);
    manager.currentPR = null;
    await manager.ensureContextPanelForJump('helper.js', 1);
    expect(manager.ensureContextFile).not.toHaveBeenCalled();
  });

  it('finds a rendered context line by its number', () => {
    const manager = createManager();
    manager.getLineNumber = (row, side) => (side === 'RIGHT' ? Number(row.dataset.line) : null);
    const wrapper = contextWrapper('helper.js');
    const table = document.createElement('table');
    for (const line of [10, 11]) {
      const row = document.createElement('tr');
      row.dataset.line = String(line);
      table.appendChild(row);
    }
    wrapper.appendChild(table);
    expect(manager._findRenderedLineRow(wrapper, 11, 'RIGHT')).toBe(table.rows[1]);
    expect(manager._findRenderedLineRow(wrapper, 12, 'RIGHT')).toBeNull();
  });

  it.each([['scrollToFinding', 'findings'], ['scrollToComment', 'comments']])(
    'AIPanel.%s opens a panel before revealing the target', async (method, collection) => {
      const panel = Object.create(AIPanel.prototype);
      panel._navGen = 0;
      panel[collection] = [{ id: 1, file: 'helper.js', line_start: 40, line_end: 41 }];
      panel.expandFileIfCollapsed = vi.fn();
      panel._scrollDiffTarget = vi.fn();
      const order = [];
      window.prManager = {
        ensureContextPanelForJump: vi.fn(async () => { order.push('panel'); }),
        ensureLinesVisible: vi.fn(async () => { order.push('reveal'); })
      };
      await panel[method]('1', 'helper.js', '40');
      expect(window.prManager.ensureContextPanelForJump).toHaveBeenCalledWith('helper.js', 40);
      expect(order).toEqual(['panel', 'reveal']);
    });
});

describe('selecting an analysis run', () => {
  function createManager() {
    const manager = Object.create(PRManager.prototype);
    manager.currentPR = { id: 5 };
    manager.loadAISuggestions = vi.fn(async () => {});
    manager.loadContextFiles = vi.fn(async () => {});
    return manager;
  }

  it('adds context panels before showing an explicitly selected council voice', async () => {
    const manager = createManager();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, created: 2 }) }));
    vi.stubGlobal('fetch', fetchMock);

    await manager.selectAnalysisRun('voice-1', { id: 'voice-1', parent_run_id: 'parent' }, { explicit: true });

    expect(fetchMock).toHaveBeenCalledWith('/api/reviews/5/analysis-runs/voice-1/context-files', expect.objectContaining({ method: 'POST' }));
    expect(manager.loadContextFiles).toHaveBeenCalledTimes(1);
    expect(manager.loadAISuggestions).toHaveBeenCalledWith(null, 'voice-1');
    expect(manager.selectedRunId).toBe('voice-1');
  });

  it('skips reloading context files when the voice added none', async () => {
    const manager = createManager();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, created: 0 }) })));
    await manager.selectAnalysisRun('voice-1', { parent_run_id: 'parent' }, { explicit: true });
    expect(manager.loadContextFiles).not.toHaveBeenCalled();
    expect(manager.loadAISuggestions).toHaveBeenCalledWith(null, 'voice-1');
  });

  it.each([
    ['a top-level run', { id: 'run-1' }, { explicit: true }],
    ['a voice restored on load', { id: 'run-1', parent_run_id: 'parent' }, { explicit: false }],
    ['a voice with no selection info', { id: 'run-1', parent_run_id: 'parent' }, undefined]
  ])('adds no panels for %s', async (_label, run, selection) => {
    const manager = createManager();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await manager.selectAnalysisRun('run-1', run, selection);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(manager.loadAISuggestions).toHaveBeenCalledWith(null, 'run-1');
  });

  it('does not show a voice that was replaced while its panels were being added', async () => {
    const manager = createManager();
    let respond;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { respond = resolve; })));
    const first = manager.selectAnalysisRun('voice-1', { parent_run_id: 'parent' }, { explicit: true });
    await vi.waitFor(() => expect(respond).toBeTypeOf('function'));
    await manager.selectAnalysisRun('run-2', { id: 'run-2' }, { explicit: true });
    respond({ ok: true, json: async () => ({ created: 0 }) });
    await first;
    expect(manager.loadAISuggestions.mock.calls).toEqual([[null, 'run-2']]);
  });

  it('still shows the voice when adding panels fails', async () => {
    const manager = createManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await manager.selectAnalysisRun('voice-1', { parent_run_id: 'parent' }, { explicit: true });
    expect(manager.loadAISuggestions).toHaveBeenCalledWith(null, 'voice-1');
  });

  it('the history dropdown reports a click as an explicit selection', async () => {
    const onSelectionChange = vi.fn();
    const history = Object.create(AnalysisHistoryManager.prototype);
    history.runs = [{ id: 'voice-1', parent_run_id: 'parent' }];
    history.onSelectionChange = onSelectionChange;
    history.updateSelectedLabel = vi.fn();
    history.listElement = null;
    history.newRunId = null;

    await history.selectRun('voice-1', true, { explicit: true });
    await history.selectRun('voice-1', true);
    expect(onSelectionChange.mock.calls).toEqual([
      ['voice-1', history.runs[0], { explicit: true }],
      ['voice-1', history.runs[0], { explicit: false }]
    ]);
  });
});

describe('comments retained after review submission', () => {
  it('lists comments safely outside the diff and supports dismissal', () => {
    document.body.innerHTML = '<main><div id="diff-container"></div></main>';
    const manager = Object.create(PRManager.prototype);
    manager.showRetainedCommentsNotice([{ file: 'helper.js', line_start: 10, line_end: 12, body: '<script>bad()</script>' }]);
    const notice = document.getElementById('retained-review-comments');
    expect(notice.textContent).toContain('1 comment kept in pair-review');
    expect(notice.textContent).toContain('helper.js:10–12');
    expect(notice.textContent).toContain('<script>bad()</script>');
    expect(notice.querySelector('script')).toBeNull();
    notice.querySelector('button').click();
    expect(document.getElementById('retained-review-comments')).toBeNull();
    manager.showRetainedCommentsNotice([{ file: 'helper.js', body: 'Remaining feedback' }]);
    manager.showRetainedCommentsNotice([]);
    expect(document.getElementById('retained-review-comments')).toBeNull();
  });

  it('handles file-level comments and pages without a diff', () => {
    const manager = Object.create(PRManager.prototype);
    expect(() => manager.showRetainedCommentsNotice([{ file: 'helper.js' }])).not.toThrow();
    document.body.innerHTML = '<div id="diff-container"></div>';
    manager.showRetainedCommentsNotice([{ file: 'helper.js', line_start: null, body: 'File feedback' }]);
    expect(document.querySelector('#retained-review-comments strong').textContent).toBe('helper.js');
  });

  describe('ReviewModal', () => {
    function createModal(submitResponse) {
      const fetchMock = vi.fn(async (url) => {
        if (String(url).includes('submit-review')) return submitResponse;
        return { ok: true, json: async () => ({}) };
      });
      vi.stubGlobal('fetch', fetchMock);
      const modal = new ReviewModal();
      modal.show = vi.fn();
      window.prManager = {
        currentPR: { owner: 'o', repo: 'r', number: 1 },
        showRetainedCommentsNotice: vi.fn(),
        updatePendingDraftIndicator: vi.fn()
      };
      window.toast = { showSuccess: vi.fn(), showWarning: vi.fn() };
      return modal;
    }

    it('shows the retained-comments notice after a successful submission', async () => {
      const skipped = [{ id: 3, file: 'helper.js', line_start: 4, body: 'Kept' }];
      const modal = createModal({ ok: true, json: async () => ({ success: true, skipped_comments: skipped }) });
      modal.modal.querySelector('#review-body-modal').value = 'Summary';
      await modal.submitReview();
      expect(window.prManager.showRetainedCommentsNotice).toHaveBeenCalledWith(skipped);
    });

    it('closes and shows the notice when every comment was outside the diff', async () => {
      const skipped = [{ id: 3, file: 'helper.js', line_start: 4, body: 'Kept' }];
      const modal = createModal({ ok: false, json: async () => ({ error: 'Nothing to submit', skippedComments: skipped }) });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      modal.hide = vi.fn();
      modal.showError = vi.fn();
      await modal.submitReview();
      expect(modal.hide).toHaveBeenCalled();
      expect(window.prManager.showRetainedCommentsNotice).toHaveBeenCalledWith(skipped);
      expect(window.toast.showWarning).toHaveBeenCalledWith('Nothing to submit');
      expect(modal.showError).not.toHaveBeenCalled();
    });

    it('keeps showing other submission errors in the dialog', async () => {
      const modal = createModal({ ok: false, json: async () => ({ error: 'GitHub is down' }) });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      modal.showError = vi.fn();
      await modal.submitReview();
      expect(modal.showError).toHaveBeenCalledWith('GitHub is down');
      expect(window.prManager.showRetainedCommentsNotice).not.toHaveBeenCalled();
    });
  });
});
