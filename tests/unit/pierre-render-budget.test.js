// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const { PRManager } = require('../../public/js/pr.js');

const DEFAULTS = {
  PIERRE_HIGHLIGHT_MAX_PATCH_CHARS: PRManager.PIERRE_HIGHLIGHT_MAX_PATCH_CHARS,
  PIERRE_HIGHLIGHT_MAX_PATCH_LINES: PRManager.PIERRE_HIGHLIGHT_MAX_PATCH_LINES,
  PIERRE_HIGHLIGHT_TOTAL_CHARS: PRManager.PIERRE_HIGHLIGHT_TOTAL_CHARS,
  PIERRE_HIGHLIGHT_TOTAL_LINES: PRManager.PIERRE_HIGHLIGHT_TOTAL_LINES,
  PIERRE_AUTO_RENDER_MAX_PATCH_CHARS: PRManager.PIERRE_AUTO_RENDER_MAX_PATCH_CHARS,
  PIERRE_AUTO_RENDER_MAX_PATCH_LINES: PRManager.PIERRE_AUTO_RENDER_MAX_PATCH_LINES,
  PIERRE_UPGRADE_MAX_PATCH_CHARS: PRManager.PIERRE_UPGRADE_MAX_PATCH_CHARS,
  PIERRE_UPGRADE_MAX_PATCH_LINES: PRManager.PIERRE_UPGRADE_MAX_PATCH_LINES,
  PIERRE_UPGRADE_MAX_CONTENT_CHARS: PRManager.PIERRE_UPGRADE_MAX_CONTENT_CHARS,
  PIERRE_UPGRADE_MAX_CONTENT_LINES: PRManager.PIERRE_UPGRADE_MAX_CONTENT_LINES,
  PIERRE_UPGRADE_CONCURRENCY: PRManager.PIERRE_UPGRADE_CONCURRENCY,
  PIERRE_BACKGROUND_UPGRADE_DELAY_MS: PRManager.PIERRE_BACKGROUND_UPGRADE_DELAY_MS,
  PIERRE_POINTER_UPGRADE_DELAY_MS: PRManager.PIERRE_POINTER_UPGRADE_DELAY_MS,
};

let originalFetch;
let originalWindow;
let originalDocument;

function createManager({ worker = true } = {}) {
  const manager = Object.create(PRManager.prototype);
  manager.pierreBridge = {
    _disabled: false,
    workerManager: worker ? {} : null,
    files: new Map(),
  };
  manager._pierreRenderBudget = manager._createPierreRenderBudget();
  manager.currentPR = { id: 42 };
  manager.changedFilesByPath = new Map();
  manager._pierreContentUpgradePromises = new Map();
  manager._deferredDiffRenderPromises = new Map();
  manager._yieldForDiffWork = () => Promise.resolve();
  return manager;
}

function fileWithPatch(patch) {
  return {
    file: 'src/large.js',
    patch,
    binary: false,
  };
}

describe('PRManager Pierre render budgeting', () => {
  beforeEach(() => {
    originalFetch = global.fetch;
    originalWindow = global.window;
    originalDocument = global.document;
    PRManager.PIERRE_HIGHLIGHT_MAX_PATCH_CHARS = 50;
    PRManager.PIERRE_HIGHLIGHT_MAX_PATCH_LINES = 10;
    PRManager.PIERRE_HIGHLIGHT_TOTAL_CHARS = 80;
    PRManager.PIERRE_HIGHLIGHT_TOTAL_LINES = 20;
    PRManager.PIERRE_AUTO_RENDER_MAX_PATCH_CHARS = 200;
    PRManager.PIERRE_AUTO_RENDER_MAX_PATCH_LINES = 50;
    PRManager.PIERRE_UPGRADE_MAX_PATCH_CHARS = 40;
    PRManager.PIERRE_UPGRADE_MAX_PATCH_LINES = 8;
    PRManager.PIERRE_UPGRADE_MAX_CONTENT_CHARS = 60;
    PRManager.PIERRE_UPGRADE_MAX_CONTENT_LINES = 5;
  });

  afterEach(() => {
    Object.assign(PRManager, DEFAULTS);
    if (originalFetch === undefined) {
      delete global.fetch;
    } else {
      global.fetch = originalFetch;
    }
    if (originalWindow === undefined) {
      delete global.window;
    } else {
      global.window = originalWindow;
    }
    if (originalDocument === undefined) {
      delete global.document;
    } else {
      global.document = originalDocument;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps default upgrade budgets broad enough for small patches in large source files', () => {
    Object.assign(PRManager, DEFAULTS);
    const manager = createManager({ worker: true });
    const sourceFile = Array.from({ length: 6500 }, (_, index) => `line ${index + 1}`).join('\n');

    expect(PRManager.PIERRE_UPGRADE_MAX_PATCH_LINES).toBeGreaterThanOrEqual(
      PRManager.PIERRE_HIGHLIGHT_MAX_PATCH_LINES
    );
    expect(PRManager.PIERRE_HIGHLIGHT_TOTAL_LINES).toBeGreaterThanOrEqual(15000);
    expect(manager._isPatchEligibleForContentUpgrade(fileWithPatch('@@ -1 +1 @@\n-old\n+new\n'))).toBe(true);
    expect(manager._isContentEligibleForPierreUpgrade(sourceFile, sourceFile)).toBe(true);
  });

  it('forces large files to plain Pierre rendering when a worker is available', () => {
    const manager = createManager({ worker: true });
    const decision = manager._getPierreRenderDecision(fileWithPatch('x'.repeat(60)));

    expect(decision).toEqual({
      usePierre: true,
      forcePlainText: true,
      deferDiff: false,
    });
  });

  it('keeps plain Pierre rendering for large files when no worker is available', () => {
    const manager = createManager({ worker: false });
    const decision = manager._getPierreRenderDecision(fileWithPatch('x'.repeat(60)));

    expect(decision).toEqual({
      usePierre: true,
      forcePlainText: true,
      deferDiff: false,
    });
  });

  it('forces plain rendering after the total syntax-highlight budget is exhausted', () => {
    const manager = createManager({ worker: true });

    const first = manager._getPierreRenderDecision(fileWithPatch('a'.repeat(45)));
    const second = manager._getPierreRenderDecision(fileWithPatch('b'.repeat(45)));

    expect(first.forcePlainText).toBe(false);
    expect(first.usePierre).toBe(true);
    expect(second.forcePlainText).toBe(true);
    expect(second.usePierre).toBe(true);
  });

  it('defers automatic inline rendering for patches above the automatic render budget', () => {
    const manager = createManager({ worker: true });
    const decision = manager._getPierreRenderDecision(fileWithPatch('x'.repeat(220)));

    expect(decision).toEqual({
      usePierre: false,
      forcePlainText: true,
      deferDiff: true,
    });
  });

  it('allows deferred large patches to render on explicit request', () => {
    const manager = createManager({ worker: true });
    const decision = manager._getPierreRenderDecision(fileWithPatch('x'.repeat(220)), {
      forceRender: true,
    });

    expect(decision).toEqual({
      usePierre: true,
      forcePlainText: true,
      deferDiff: false,
    });
  });

  it('uses plain Pierre for explicit deferred rendering even without a worker', () => {
    const manager = createManager({ worker: false });
    const decision = manager._getPierreRenderDecision(fileWithPatch('x'.repeat(220)), {
      forceRender: true,
    });

    expect(decision).toEqual({
      usePierre: true,
      forcePlainText: true,
      deferDiff: false,
    });
  });

  it('skips full-content upgrades for large patches and large file contents', () => {
    const manager = createManager({ worker: true });

    expect(manager._isPatchEligibleForContentUpgrade(fileWithPatch('small\n'))).toBe(true);
    expect(manager._isPatchEligibleForContentUpgrade(fileWithPatch('x'.repeat(45)))).toBe(false);

    expect(manager._isContentEligibleForPierreUpgrade('one\ntwo\n', 'three\nfour\n')).toBe(true);
    expect(manager._isContentEligibleForPierreUpgrade('x'.repeat(65), 'ok')).toBe(false);
    expect(manager._isContentEligibleForPierreUpgrade('1\n2\n3\n4\n5\n6\n', 'ok')).toBe(false);
  });

  it('does not cap the total number of eligible full-content upgrades', () => {
    const manager = createManager({ worker: true });
    const files = Array.from({ length: 20 }, (_, index) => {
      const file = fileWithPatch(`@@ -1 +1 @@\n-old ${index}\n+new ${index}\n`);
      file.file = `src/file-${index}.js`;
      manager.pierreBridge.files.set(file.file, { forcePlainText: false });
      return file;
    });

    expect(manager._getPierreContentUpgradeFiles(files)).toHaveLength(20);
  });

  it('keeps plain-text Pierre files eligible for full-content upgrades', () => {
    const manager = createManager({ worker: true });
    const file = fileWithPatch('@@ -1 +1 @@\n-old\n+new\n');
    manager.pierreBridge.files.set(file.file, { forcePlainText: true });

    expect(manager._getPierreContentUpgradeFiles([file])).toEqual([file]);
  });

  it('moves a navigated file to the front of the pending full-content queue', () => {
    const manager = createManager({ worker: true });
    manager._fileContentsUpgradeState = {
      pending: [
        { file: 'src/one.js' },
        { file: 'src/two.js' },
        { file: 'src/three.js' },
      ],
      inFlight: new Set(),
      completed: new Set(),
      // Saturate the queue so prioritization only reorders (no draining),
      // regardless of the configured PIERRE_UPGRADE_CONCURRENCY value.
      active: PRManager.PIERRE_UPGRADE_CONCURRENCY,
      worker: async () => {},
      signal: { aborted: false },
    };

    expect(manager._prioritizePierreContentUpgrade('src/three.js')).toBe(true);
    expect(manager._fileContentsUpgradeState.pending.map(file => file.file)).toEqual([
      'src/three.js',
      'src/one.js',
      'src/two.js',
    ]);
  });

  it('does not install stale or aborted full-content upgrade queues', () => {
    const manager = createManager({ worker: true });
    const existingState = { pending: [], inFlight: new Set(), completed: new Set() };
    manager._fileContentsUpgradeState = existingState;
    manager._fileContentsAbort = { signal: { aborted: false } };

    manager._startFileContentUpgradeQueue([{ file: 'src/old.js' }], async () => {}, { aborted: true });
    expect(manager._fileContentsUpgradeState).toBe(existingState);

    manager._startFileContentUpgradeQueue([{ file: 'src/stale.js' }], async () => {}, { aborted: false });
    expect(manager._fileContentsUpgradeState).toBe(existingState);
  });

  it('waits to apply background full-content upgrades while the pointer is over the file', async () => {
    vi.useFakeTimers();
    const manager = createManager({ worker: true });
    let pointerOverFile = true;
    manager.pierreBridge.isPointerOverFile = vi.fn(() => pointerOverFile);

    let resolved = false;
    const waitPromise = manager
      ._waitForPierrePointerIdle('src/hovered.js', { aborted: false })
      .then(() => {
        resolved = true;
      });

    await vi.advanceTimersByTimeAsync(200);
    expect(resolved).toBe(false);

    pointerOverFile = false;
    await vi.advanceTimersByTimeAsync(100);
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it('forces a full-content upgrade when hidden Pierre line anchoring needs metadata', async () => {
    const manager = createManager({ worker: true });
    const file = fileWithPatch('x'.repeat(45));
    file.file = 'src/large-but-rendered.js';
    manager.changedFilesByPath.set(file.file, file);

    const fileState = { baseMetadata: null };
    manager.pierreBridge.files.set(file.file, fileState);
    manager.pierreBridge.upgradeFileContents = vi.fn((_filePath, oldFile, newFile) => {
      fileState.baseMetadata = { hunks: [] };
      fileState.oldFile = oldFile;
      fileState.newFile = newFile;
      return true;
    });
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        oldContents: 'old\n',
        newContents: 'new\n',
      }),
    }));

    expect(manager._isPatchEligibleForContentUpgrade(file)).toBe(false);
    await expect(manager._ensurePierreContentUpgrade(file.file)).resolves.toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/reviews/42/file-contents/src%2Flarge-but-rendered.js?status=modified',
      undefined
    );
    expect(manager.pierreBridge.upgradeFileContents).toHaveBeenCalledWith(
      file.file,
      { name: file.file, contents: 'old\n' },
      { name: file.file, contents: 'new\n' }
    );
  });

  it('materializes deferred diffs for line-targeting paths without recursive reanchor', async () => {
    const dom = new JSDOM(`
      <!doctype html>
      <div class="d2h-file-wrapper" data-file-name="src/huge.js">
        <div class="large-diff-placeholder"></div>
      </div>
    `, { url: 'http://localhost/' });
    global.window = dom.window;
    global.document = dom.window.document;

    const manager = createManager({ worker: true });
    const file = fileWithPatch('x'.repeat(220));
    file.file = 'src/huge.js';
    manager.changedFilesByPath.set(file.file, file);
    manager.findFileElement = vi.fn(() => document.querySelector('.d2h-file-wrapper'));
    manager._renderDeferredDiff = vi.fn(async () => {});

    await expect(manager._materializeDeferredDiff(file.file)).resolves.toBe(true);

    const placeholder = document.querySelector('.large-diff-placeholder');
    expect(manager._renderDeferredDiff).toHaveBeenCalledWith(
      file,
      document.querySelector('.d2h-file-wrapper'),
      placeholder,
      { reanchor: false }
    );
  });

  it('ensures Pierre metadata before adding hidden-line context ranges', async () => {
    const manager = createManager({ worker: true });
    manager._materializeDeferredDiff = vi.fn(async () => true);
    manager._ensurePierreContentUpgrade = vi.fn(async () => true);
    manager.pierreBridge = {
      files: new Map([['src/needs-anchor.js', { baseMetadata: null }]]),
      isLineVisible: vi.fn(() => false),
      addContextRanges: vi.fn(() => true),
    };

    await manager.ensureLinesVisible([{
      file: 'src/needs-anchor.js',
      line_start: 25,
      line_end: 26,
      side: 'RIGHT',
    }]);

    expect(manager._materializeDeferredDiff).toHaveBeenCalledWith('src/needs-anchor.js');
    expect(manager._ensurePierreContentUpgrade).toHaveBeenCalledWith('src/needs-anchor.js');
    expect(manager.pierreBridge.addContextRanges).toHaveBeenCalledWith(
      'src/needs-anchor.js',
      [{ startLine: 25, endLine: 26 }]
    );
  });

  it('expands a Pierre range when line_end is hidden even though line_start is visible', async () => {
    // Regression for finding 4: the visibility guard must test the WHOLE range.
    // Before the fix, only line_start was checked, so a range with a visible
    // start but a hidden end skipped addContextRanges and never revealed line_end.
    const manager = createManager({ worker: true });
    manager._materializeDeferredDiff = vi.fn(async () => true);
    manager._ensurePierreContentUpgrade = vi.fn(async () => true);
    const isLineVisible = vi.fn((_file, line) => line === 40); // start visible, end hidden
    manager.pierreBridge = {
      files: new Map([['src/partial.js', { baseMetadata: { hunks: [] } }]]),
      isLineVisible,
      addContextRanges: vi.fn(() => true),
    };

    await manager.ensureLinesVisible([{
      file: 'src/partial.js',
      line_start: 40,
      line_end: 50,
      side: 'RIGHT',
    }]);

    expect(isLineVisible).toHaveBeenCalledWith('src/partial.js', 40, 'RIGHT');
    expect(isLineVisible).toHaveBeenCalledWith('src/partial.js', 50, 'RIGHT');
    expect(manager.pierreBridge.addContextRanges).toHaveBeenCalledWith(
      'src/partial.js',
      [{ startLine: 40, endLine: 50 }]
    );
  });

  it('skips Pierre context expansion when the whole range is already visible', async () => {
    // Preserve the skip-when-fully-visible optimization: both endpoints visible
    // must NOT trigger addContextRanges (avoids needless re-render churn).
    const manager = createManager({ worker: true });
    manager._materializeDeferredDiff = vi.fn(async () => true);
    manager._ensurePierreContentUpgrade = vi.fn(async () => true);
    manager.pierreBridge = {
      files: new Map([['src/visible.js', { baseMetadata: { hunks: [] } }]]),
      isLineVisible: vi.fn(() => true),
      addContextRanges: vi.fn(() => true),
    };

    await manager.ensureLinesVisible([{
      file: 'src/visible.js',
      line_start: 10,
      line_end: 20,
      side: 'RIGHT',
    }]);

    expect(manager.pierreBridge.addContextRanges).not.toHaveBeenCalled();
    expect(manager._ensurePierreContentUpgrade).not.toHaveBeenCalled();
  });

  it('routes the deferred "Load diff" click through _materializeDeferredDiff with reanchor', async () => {
    // Finding 3: the click handler must go through _materializeDeferredDiff so it
    // shares the render-promise cache and de-dupes with auto-materialize. Because
    // a manual click is not inside a loadUserComments/loadAISuggestions flow, it
    // must render with reanchor:true.
    const dom = new JSDOM(`
      <!doctype html>
      <div class="d2h-file-wrapper" data-file-name="src/huge.js"></div>
    `, { url: 'http://localhost/' });
    global.window = dom.window;
    global.document = dom.window.document;

    const manager = createManager({ worker: true });
    const file = fileWithPatch('x'.repeat(220));
    file.file = 'src/huge.js';
    manager.changedFilesByPath.set(file.file, file);
    const wrapper = document.querySelector('.d2h-file-wrapper');
    manager.findFileElement = vi.fn(() => wrapper);
    manager._renderDeferredDiff = vi.fn(async () => {});

    const placeholder = manager._createDeferredDiffPlaceholder(file, wrapper);
    wrapper.appendChild(placeholder);

    const materializeSpy = vi.spyOn(manager, '_materializeDeferredDiff');
    const button = placeholder.querySelector('.large-diff-load-btn');
    button.click();

    // Let the async click handler and the queued render microtasks drain.
    await new Promise(resolve => setTimeout(resolve, 0));
    await Promise.resolve();

    expect(materializeSpy).toHaveBeenCalledWith('src/huge.js', { reanchor: true });
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Loading...');
    expect(manager._renderDeferredDiff).toHaveBeenCalledWith(
      file,
      wrapper,
      placeholder,
      { reanchor: true }
    );
  });

  it('de-dupes concurrent materialize calls for the same file into a single render', async () => {
    // Finding 3: two concurrent triggers for the same file must share the
    // _deferredDiffRenderPromises cache and produce exactly one _renderDeferredDiff.
    // The first call wins its reanchor setting.
    const dom = new JSDOM(`
      <!doctype html>
      <div class="d2h-file-wrapper" data-file-name="src/huge.js">
        <div class="large-diff-placeholder"></div>
      </div>
    `, { url: 'http://localhost/' });
    global.window = dom.window;
    global.document = dom.window.document;

    const manager = createManager({ worker: true });
    const file = fileWithPatch('x'.repeat(220));
    file.file = 'src/huge.js';
    manager.changedFilesByPath.set(file.file, file);
    manager.findFileElement = vi.fn(() => document.querySelector('.d2h-file-wrapper'));

    let resolveRender;
    const renderGate = new Promise(resolve => { resolveRender = resolve; });
    manager._renderDeferredDiff = vi.fn(() => renderGate);

    const first = manager._materializeDeferredDiff(file.file, { reanchor: true });
    const second = manager._materializeDeferredDiff(file.file); // defaults reanchor:false
    resolveRender();
    await Promise.all([first, second]);

    expect(manager._renderDeferredDiff).toHaveBeenCalledTimes(1);
    expect(manager._renderDeferredDiff).toHaveBeenCalledWith(
      file,
      document.querySelector('.d2h-file-wrapper'),
      document.querySelector('.large-diff-placeholder'),
      { reanchor: true }
    );
  });

  it('bails without clobbering file state when the review is rebuilt during the idle yield', async () => {
    // A deferred materialize snapshots wrapper/placeholder, then yields. If
    // renderDiff() re-runs during that idle window it clears the container,
    // detaching the captured placeholder. The stale task must return early and
    // never call renderFile/_renderDeferredDiff, or it would destroy the freshly
    // rebuilt pierreBridge.files entry and replace it with a detached-DOM node.
    const dom = new JSDOM(`
      <!doctype html>
      <div class="d2h-file-wrapper" data-file-name="src/huge.js">
        <div class="large-diff-placeholder"></div>
      </div>
    `, { url: 'http://localhost/' });
    global.window = dom.window;
    global.document = dom.window.document;

    const manager = createManager({ worker: true });
    const file = fileWithPatch('x'.repeat(220));
    file.file = 'src/huge.js';
    manager.changedFilesByPath.set(file.file, file);
    const wrapper = document.querySelector('.d2h-file-wrapper');
    const placeholder = document.querySelector('.large-diff-placeholder');
    manager.findFileElement = vi.fn(() => wrapper);
    manager._renderDeferredDiff = vi.fn(async () => {});

    // Idle yield held open so we can simulate the teardown mid-flight. A null
    // abort signal is deliberate: the isConnected checks — not the abort flag —
    // are the load-bearing guard (the signal is null when pierreBridge is off).
    manager._fileContentsAbort = null;
    let releaseYield;
    const yieldGate = new Promise(resolve => { releaseYield = resolve; });
    manager._yieldForDiffWork = vi.fn(() => yieldGate);

    const materialize = manager._materializeDeferredDiff(file.file);
    // renderDiff() clears diffContainer.innerHTML, detaching the placeholder.
    placeholder.remove();
    releaseYield();

    await expect(materialize).resolves.toBe(false);
    expect(manager._renderDeferredDiff).not.toHaveBeenCalled();
    expect(manager.pierreBridge.files.has(file.file)).toBe(false);
  });
});
