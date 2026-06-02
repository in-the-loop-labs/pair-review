/*
 * Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
 */
/** @vitest-environment jsdom */

/**
 * Unit tests for PRManager._startGenerationJob and startOrToggleTour.
 *
 * These methods reference `fetch` and `window` as bare globals inside the
 * vm-evaluated code. Because vm.createContext isolates the sandbox from
 * jsdom's global, we must control behavior via `sandbox.fetch` and
 * `sandbox.toast` — NOT `global.fetch` or `window.toast`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const code = fs.readFileSync(
    path.join(__dirname, '../../public/js/pr.js'),
    'utf8'
  );
  const moduleExports = {};
  const sandbox = {
    window: {},
    document: { addEventListener() {} },
    console,
    localStorage: { getItem() { return null; }, setItem() {} },
    fetch: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
    navigator: { clipboard: {} },
    setTimeout,
    clearTimeout,
    URLSearchParams,
    module: { exports: moduleExports },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { filename: 'pr.js' });
  const PRManager = sandbox.module.exports.PRManager;
  return { PRManager, sandbox };
}

// -----------------------------------------------------------------------
// _startGenerationJob
// -----------------------------------------------------------------------
describe('PRManager._startGenerationJob', () => {
  let PRManager, sandbox, mgr;

  beforeEach(() => {
    ({ PRManager, sandbox } = load());
    mgr = Object.create(PRManager.prototype);
    mgr._syncSummaryToolbarButton = vi.fn();
    mgr._syncTourToolbarButton = vi.fn();
    mgr._summariesGenerating = false;
    mgr._tourGenerating = false;
  });

  it('PR-mode URL: posts to /api/pr/:owner/:repo/:number/jobs/summary/start and sets flag', async () => {
    mgr.currentPR = { id: 7, owner: 'o', repo: 'r', number: 3, reviewType: 'pr' };
    sandbox.PAIR_REVIEW_LOCAL_MODE = false;
    sandbox.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ started: true }),
    });

    await mgr._startGenerationJob('summary');

    expect(sandbox.fetch).toHaveBeenCalledTimes(1);
    expect(sandbox.fetch.mock.calls[0][0]).toBe('/api/pr/o/r/3/jobs/summary/start');
    expect(sandbox.fetch.mock.calls[0][1]).toEqual({ method: 'POST' });
    expect(mgr._summariesGenerating).toBe(true);
    expect(mgr._syncSummaryToolbarButton).toHaveBeenCalledTimes(1);
  });

  it('local-mode URL: posts to /api/local/:id/jobs/tour/start and sets flag', async () => {
    mgr.currentPR = { id: 7, owner: 'o', repo: 'r', number: 3, reviewType: 'local' };
    sandbox.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ started: true }),
    });

    await mgr._startGenerationJob('tour');

    expect(sandbox.fetch).toHaveBeenCalledTimes(1);
    expect(sandbox.fetch.mock.calls[0][0]).toBe('/api/local/7/jobs/tour/start');
    expect(sandbox.fetch.mock.calls[0][1]).toEqual({ method: 'POST' });
    expect(mgr._tourGenerating).toBe(true);
    expect(mgr._syncTourToolbarButton).toHaveBeenCalledTimes(1);
  });

  it('409 disabled: calls toast.error and sets no generating flag', async () => {
    mgr.currentPR = { id: 7, owner: 'o', repo: 'r', number: 3, reviewType: 'pr' };
    sandbox.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({}),
    });
    sandbox.toast = { error: vi.fn() };

    await mgr._startGenerationJob('summary');

    expect(sandbox.toast.error).toHaveBeenCalledTimes(1);
    expect(sandbox.toast.error).toHaveBeenCalledWith('This feature is disabled in config.');
    expect(mgr._summariesGenerating).toBe(false);
    expect(mgr._syncSummaryToolbarButton).not.toHaveBeenCalled();
  });

  it('200 no-diff (started:false, no alreadyRunning): sets no flag and does not sync', async () => {
    mgr.currentPR = { id: 7, owner: 'o', repo: 'r', number: 3, reviewType: 'pr' };
    sandbox.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ started: false, reason: 'no-diff' }),
    });

    await mgr._startGenerationJob('summary');

    expect(mgr._summariesGenerating).toBe(false);
    expect(mgr._syncSummaryToolbarButton).not.toHaveBeenCalled();
  });

  it('alreadyRunning:true sets the generating flag', async () => {
    mgr.currentPR = { id: 7, owner: 'o', repo: 'r', number: 3, reviewType: 'pr' };
    sandbox.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ started: false, alreadyRunning: true }),
    });

    await mgr._startGenerationJob('summary');

    expect(mgr._summariesGenerating).toBe(true);
    expect(mgr._syncSummaryToolbarButton).toHaveBeenCalledTimes(1);
  });

  it('non-409 !ok (500): sets no flag and does not throw', async () => {
    mgr.currentPR = { id: 7, owner: 'o', repo: 'r', number: 3, reviewType: 'pr' };
    sandbox.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await expect(mgr._startGenerationJob('summary')).resolves.toBeUndefined();
    expect(mgr._summariesGenerating).toBe(false);
    expect(mgr._syncSummaryToolbarButton).not.toHaveBeenCalled();
  });

  it('returns early without fetching when currentPR is null', async () => {
    mgr.currentPR = null;
    sandbox.fetch = vi.fn();

    await mgr._startGenerationJob('summary');

    expect(sandbox.fetch).not.toHaveBeenCalled();
  });

  it('returns early without fetching when currentPR.id is null', async () => {
    mgr.currentPR = { id: null, owner: 'o', repo: 'r', number: 3, reviewType: 'pr' };
    sandbox.fetch = vi.fn();

    await mgr._startGenerationJob('summary');

    expect(sandbox.fetch).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// startOrToggleTour
// -----------------------------------------------------------------------
describe('PRManager.startOrToggleTour', () => {
  let PRManager, sandbox, mgr;

  beforeEach(() => {
    ({ PRManager, sandbox } = load());
    mgr = Object.create(PRManager.prototype);
    mgr._tourStops = [];
    mgr._tourGenerating = false;
    mgr._toursAutoGenerate = false;
    mgr._tourIsActive = vi.fn().mockReturnValue(false);
    mgr._exitTour = vi.fn();
    mgr._loadAndStashTour = vi.fn().mockResolvedValue(null);
    mgr._openTourAtStart = vi.fn().mockResolvedValue(undefined);
    mgr._startGenerationJob = vi.fn().mockResolvedValue(undefined);
  });

  it('manual-gen branch: calls _startGenerationJob("tour") when auto_generate=false and no stops after load', async () => {
    mgr._toursAutoGenerate = false;
    mgr._tourGenerating = false;
    mgr._tourStops = [];
    // _loadAndStashTour leaves stops empty (returns null, doesn't set _tourStops)
    mgr._loadAndStashTour = vi.fn().mockImplementation(async () => {
      // Intentionally leave mgr._tourStops as []
      return null;
    });

    await mgr.startOrToggleTour();

    expect(mgr._startGenerationJob).toHaveBeenCalledTimes(1);
    expect(mgr._startGenerationJob).toHaveBeenCalledWith('tour');
    expect(mgr._openTourAtStart).not.toHaveBeenCalled();
  });

  it('auto-generate=true: does NOT call _startGenerationJob even with empty stops', async () => {
    mgr._toursAutoGenerate = true;
    mgr._tourGenerating = false;
    mgr._tourStops = [];
    mgr._loadAndStashTour = vi.fn().mockImplementation(async () => {
      // Leave mgr._tourStops as []
      return null;
    });

    await mgr.startOrToggleTour();

    expect(mgr._startGenerationJob).not.toHaveBeenCalled();
    expect(mgr._openTourAtStart).not.toHaveBeenCalled();
  });

  it('active tour: calls _exitTour and returns without opening', async () => {
    mgr._tourIsActive = vi.fn().mockReturnValue(true);

    await mgr.startOrToggleTour();

    expect(mgr._exitTour).toHaveBeenCalledTimes(1);
    expect(mgr._openTourAtStart).not.toHaveBeenCalled();
    expect(mgr._startGenerationJob).not.toHaveBeenCalled();
  });

  it('stops exist: skips load and opens the tour', async () => {
    mgr._tourStops = [{ title: 's0' }, { title: 's1' }];

    await mgr.startOrToggleTour();

    expect(mgr._loadAndStashTour).not.toHaveBeenCalled();
    expect(mgr._openTourAtStart).toHaveBeenCalledTimes(1);
    expect(mgr._startGenerationJob).not.toHaveBeenCalled();
  });

  it('no stops + already generating: does NOT call _startGenerationJob', async () => {
    mgr._toursAutoGenerate = false;
    mgr._tourGenerating = true;
    mgr._tourStops = [];
    mgr._loadAndStashTour = vi.fn().mockImplementation(async () => null);

    await mgr.startOrToggleTour();

    expect(mgr._startGenerationJob).not.toHaveBeenCalled();
  });

  it('null _tourStops: treats as empty and attempts load', async () => {
    mgr._tourStops = null;
    mgr._toursAutoGenerate = false;
    mgr._tourGenerating = false;
    mgr._loadAndStashTour = vi.fn().mockImplementation(async () => null);

    await mgr.startOrToggleTour();

    expect(mgr._loadAndStashTour).toHaveBeenCalledTimes(1);
    expect(mgr._startGenerationJob).toHaveBeenCalledWith('tour');
  });
});

// -----------------------------------------------------------------------
// _summariesGenerated reset on re-render
// -----------------------------------------------------------------------
describe('_summariesGenerated reset on re-render', () => {
  let PRManager, sandbox, mgr;

  beforeEach(() => {
    ({ PRManager, sandbox } = load());
    mgr = Object.create(PRManager.prototype);

    // Minimal state required by renderDiff
    mgr.generatedFiles = new Map();
    mgr._renderGen = 0;
    mgr._toursEnabled = false;
    mgr._tourIsActive = vi.fn().mockReturnValue(false);
    mgr.hunkSummaryRenderer = null; // disables _kickOffHunkSummaries branch
    mgr.validatePendingEofGaps = vi.fn();
    mgr.loadContextFiles = vi.fn();
    mgr.currentPR = { id: 1, owner: 'o', repo: 'r', number: 1, reviewType: 'pr' };

    // Stubs for methods called AFTER the reset block when files.length === 0
    // (renderFileDiff is not called with empty files)
  });

  it('renderDiff resets _summariesGenerated; click then routes to _startGenerationJob("summary")', async () => {
    // renderDiff calls `document.getElementById('diff-container')` where
    // `document` resolves to sandbox.document (the vm context global).
    // Provide a minimal stub with getElementById returning a fake element.
    const fakeContainer = { innerHTML: '', appendChild: vi.fn() };
    sandbox.document = {
      addEventListener() {},
      getElementById(id) {
        return id === 'diff-container' ? fakeContainer : null;
      },
    };

    // Simulate a prior successful generation
    mgr._summariesGenerated = true;
    mgr._summariesGenerating = false;

    // Drive renderDiff with empty files — reaches and executes the reset block
    mgr.renderDiff({ changed_files: [] });

    // The reset must have fired
    expect(mgr._summariesGenerated).toBe(false);

    // Now stub the routing targets and verify _handleSummaryToggleClick routes
    // to _startGenerationJob (generate path), NOT toggleSummariesVisibility (toggle path)
    mgr._startGenerationJob = vi.fn().mockResolvedValue(undefined);
    mgr.toggleSummariesVisibility = vi.fn();

    await mgr._handleSummaryToggleClick();

    expect(mgr._startGenerationJob).toHaveBeenCalledTimes(1);
    expect(mgr._startGenerationJob).toHaveBeenCalledWith('summary');
    expect(mgr.toggleSummariesVisibility).not.toHaveBeenCalled();
  });
});
