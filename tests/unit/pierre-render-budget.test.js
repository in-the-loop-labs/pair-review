// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const { PRManager } = require('../../public/js/pr.js');

const DEFAULTS = {
  PIERRE_HIGHLIGHT_MAX_PATCH_CHARS: PRManager.PIERRE_HIGHLIGHT_MAX_PATCH_CHARS,
  PIERRE_HIGHLIGHT_MAX_PATCH_LINES: PRManager.PIERRE_HIGHLIGHT_MAX_PATCH_LINES,
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

function createManager() {
  const manager = Object.create(PRManager.prototype);
  manager.pierreBridge = {
    files: new Map(),
  };
  // The files the viewer has mounted: background upgrades go to those.
  manager._mountedDiffItems = new Set();
  manager._renderGen = 1;
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
    const manager = createManager();
    const sourceFile = Array.from({ length: 6500 }, (_, index) => `line ${index + 1}`).join('\n');

    expect(PRManager.PIERRE_UPGRADE_MAX_PATCH_LINES).toBeGreaterThanOrEqual(
      PRManager.PIERRE_HIGHLIGHT_MAX_PATCH_LINES
    );
    expect(manager._isPatchEligibleForContentUpgrade(fileWithPatch('@@ -1 +1 @@\n-old\n+new\n'))).toBe(true);
    expect(manager._isContentEligibleForPierreUpgrade(sourceFile, sourceFile)).toBe(true);
  });

  it('draws a file over the per-file limit as plain text, by characters or by lines', () => {
    const manager = createManager();
    expect(manager._getPierreRenderDecision(fileWithPatch('x'.repeat(40)))).toEqual({ forcePlainText: false, deferDiff: false });
    expect(manager._getPierreRenderDecision(fileWithPatch('x'.repeat(60)))).toEqual({ forcePlainText: true, deferDiff: false });
    expect(manager._getPierreRenderDecision(fileWithPatch('l\n'.repeat(12)))).toEqual({ forcePlainText: true, deferDiff: false });
  });

  it('has no limit on the page as a whole: every file under the per-file limit is highlighted, however many there are', () => {
    // The viewer highlights what is mounted, so a total budget protects
    // nothing (decision D3 of plans/codeview-virtualized-diff.md).
    const manager = createManager();
    for (let index = 0; index < 50; index++) {
      const file = fileWithPatch(String.fromCharCode(97 + (index % 26)).repeat(45));
      file.file = `src/file-${index}.js`;
      expect(manager._getPierreRenderDecision(file), file.file).toEqual({ forcePlainText: false, deferDiff: false });
    }
    expect(PRManager.PIERRE_HIGHLIGHT_TOTAL_CHARS).toBeUndefined();
    expect(PRManager.PIERRE_HIGHLIGHT_TOTAL_LINES).toBeUndefined();
  });

  it('holds a diff back when its patch is over the automatic render limit', () => {
    const manager = createManager();
    expect(manager._getPierreRenderDecision(fileWithPatch('x'.repeat(220)))).toEqual({ forcePlainText: true, deferDiff: true });
    expect(manager._getPierreRenderDecision(fileWithPatch('l\n'.repeat(60)))).toEqual({ forcePlainText: true, deferDiff: true });
  });

  it('decides nothing for a file without a patch or a binary file', () => {
    const manager = createManager();
    expect(manager._getPierreRenderDecision({ file: 'a.bin', binary: true, patch: 'x'.repeat(500) })).toEqual({ forcePlainText: false, deferDiff: false });
    expect(manager._getPierreRenderDecision({ file: 'empty.js' })).toEqual({ forcePlainText: false, deferDiff: false });
    expect(manager._getPierreRenderDecision(null)).toEqual({ forcePlainText: false, deferDiff: false });
  });

  it('skips full-content upgrades for large patches and large file contents', () => {
    const manager = createManager();

    expect(manager._isPatchEligibleForContentUpgrade(fileWithPatch('small\n'))).toBe(true);
    expect(manager._isPatchEligibleForContentUpgrade(fileWithPatch('x'.repeat(45)))).toBe(false);

    expect(manager._isContentEligibleForPierreUpgrade('one\ntwo\n', 'three\nfour\n')).toBe(true);
    expect(manager._isContentEligibleForPierreUpgrade('x'.repeat(65), 'ok')).toBe(false);
    expect(manager._isContentEligibleForPierreUpgrade('1\n2\n3\n4\n5\n6\n', 'ok')).toBe(false);
  });

  it('does not cap the total number of eligible full-content upgrades', () => {
    const manager = createManager();
    const files = Array.from({ length: 20 }, (_, index) => {
      const file = fileWithPatch(`@@ -1 +1 @@\n-old ${index}\n+new ${index}\n`);
      file.file = `src/file-${index}.js`;
      manager.pierreBridge.files.set(file.file, { forcePlainText: false });
      manager._mountedDiffItems.add(file.file);
      return file;
    });

    expect(manager._getPierreContentUpgradeFiles(files)).toHaveLength(20);
  });

  it('keeps plain-text Pierre files eligible for full-content upgrades', () => {
    const manager = createManager();
    const file = fileWithPatch('@@ -1 +1 @@\n-old\n+new\n');
    manager.pierreBridge.files.set(file.file, { forcePlainText: true });
    manager._mountedDiffItems.add(file.file);

    expect(manager._getPierreContentUpgradeFiles([file])).toEqual([file]);
  });

  it('upgrades only the files the viewer has mounted: a record alone is not a drawn file', () => {
    const manager = createManager();
    const drawn = fileWithPatch('@@ -1 +1 @@\n-old\n+new\n');
    const far = { ...fileWithPatch('@@ -1 +1 @@\n-old\n+new\n'), file: 'src/far.js' };
    manager.pierreBridge.files.set(drawn.file, {});
    manager.pierreBridge.files.set(far.file, {});
    manager._mountedDiffItems.add(drawn.file);

    expect(manager._getPierreContentUpgradeFiles([drawn, far])).toEqual([drawn]);
    expect(manager._isDiffFileRendered(far.file)).toBe(false);
  });

  it('moves a navigated file to the front of the pending full-content queue', () => {
    const manager = createManager();
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
    const manager = createManager();
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
    const manager = createManager();
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

  it('waits for as long as the reader is typing in the file, past the pointer\'s limit, and goes on when the focus leaves', async () => {
    vi.useFakeTimers();
    const manager = createManager();
    let typing = true;
    manager.pierreBridge.isPointerOverFile = vi.fn(() => false);
    manager.pierreBridge.isEditingInside = vi.fn(() => typing);

    let resolved = false;
    const waitPromise = manager
      ._waitForPierrePointerIdle('src/typed-in.js', { aborted: false })
      .then(() => {
        resolved = true;
      });

    // Three times the limit a resting pointer has.
    await vi.advanceTimersByTimeAsync(30000);
    expect(resolved).toBe(false);
    expect(manager.pierreBridge.isEditingInside).toHaveBeenCalledWith('src/typed-in.js');

    typing = false;
    await vi.advanceTimersByTimeAsync(100);
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it('the wait for typing ends with the render, and a pointer that stays is let go after its limit', async () => {
    vi.useFakeTimers();
    const manager = createManager();
    manager.pierreBridge.isPointerOverFile = vi.fn(() => false);
    manager.pierreBridge.isEditingInside = vi.fn(() => true);
    const signal = { aborted: false };
    let resolved = false;
    const typingWait = manager._waitForPierrePointerIdle('src/typed-in.js', signal).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(false);
    signal.aborted = true;
    await vi.advanceTimersByTimeAsync(100);
    await typingWait;
    expect(resolved).toBe(true);

    manager.pierreBridge.isPointerOverFile = vi.fn(() => true);
    manager.pierreBridge.isEditingInside = vi.fn(() => false);
    let pointerDone = false;
    const pointerWait = manager._waitForPierrePointerIdle('src/hovered.js', { aborted: false }).then(() => { pointerDone = true; });
    await vi.advanceTimersByTimeAsync(9900);
    expect(pointerDone).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    await pointerWait;
    expect(pointerDone).toBe(true);
  });

  it('a bridge that cannot tell whether the reader is typing is not asked', async () => {
    const manager = createManager();
    manager.pierreBridge.isPointerOverFile = vi.fn(() => false);
    delete manager.pierreBridge.isEditingInside;
    await manager._waitForPierrePointerIdle('src/any.js', { aborted: false });
  });

  it('forces a full-content upgrade when hidden Pierre line anchoring needs metadata', async () => {
    const manager = createManager();
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

  it('ensures Pierre metadata before adding hidden-line context ranges', async () => {
    const manager = createManager();
    manager._materializeDeferredDiff = vi.fn(async () => true);
    manager._ensurePierreContentUpgrade = vi.fn(async () => true);
    manager.pierreBridge = {
      files: new Map([['src/needs-anchor.js', { baseMetadata: null }]]),
      isLineInDiff: vi.fn(() => false),
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
    const manager = createManager();
    manager._materializeDeferredDiff = vi.fn(async () => true);
    manager._ensurePierreContentUpgrade = vi.fn(async () => true);
    const isLineInDiff = vi.fn((_file, line) => line === 40); // start visible, end hidden
    manager.pierreBridge = {
      files: new Map([['src/partial.js', { baseMetadata: { hunks: [] } }]]),
      isLineInDiff,
      addContextRanges: vi.fn(() => true),
    };

    await manager.ensureLinesVisible([{
      file: 'src/partial.js',
      line_start: 40,
      line_end: 50,
      side: 'RIGHT',
    }]);

    expect(isLineInDiff).toHaveBeenCalledWith('src/partial.js', 40, 'RIGHT');
    expect(isLineInDiff).toHaveBeenCalledWith('src/partial.js', 50, 'RIGHT');
    expect(manager.pierreBridge.addContextRanges).toHaveBeenCalledWith(
      'src/partial.js',
      [{ startLine: 40, endLine: 50 }]
    );
  });

  it('skips Pierre context expansion when the whole range is already visible', async () => {
    // Preserve the skip-when-fully-visible optimization: both endpoints visible
    // must NOT trigger addContextRanges (avoids needless re-render churn).
    const manager = createManager();
    manager._materializeDeferredDiff = vi.fn(async () => true);
    manager._ensurePierreContentUpgrade = vi.fn(async () => true);
    manager.pierreBridge = {
      files: new Map([['src/visible.js', { baseMetadata: { hunks: [] } }]]),
      isLineInDiff: vi.fn(() => true),
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

  describe('a diff that is held back for its size', () => {
    function deferredManager() {
      const manager = createManager();
      const file = fileWithPatch('x'.repeat(220));
      file.file = 'src/huge.js';
      manager.changedFilesByPath.set(file.file, file);
      const record = { deferred: true };
      manager.pierreBridge.files.set(file.file, record);
      manager.pierreBridge.materializeDeferred = vi.fn(() => {
        record.deferred = false;
        return true;
      });
      manager._registerPierreHunkAnchorsForFile = vi.fn();
      manager._reanchorInlineFeedbackAfterDeferredRender = vi.fn(async () => {});
      return { manager, file, record };
    }

    it('is shown for a path that reveals a line, without reloading comments and suggestions (the caller does)', async () => {
      const { manager, file } = deferredManager();

      await expect(manager._materializeDeferredDiff(file.file)).resolves.toBe(true);

      expect(manager.pierreBridge.materializeDeferred).toHaveBeenCalledWith(file.file);
      expect(manager._registerPierreHunkAnchorsForFile).toHaveBeenCalledWith(file);
      expect(manager._reanchorInlineFeedbackAfterDeferredRender).not.toHaveBeenCalled();
    });

    it('answers true for a file that shows its diff and false for a path that is not a file of the pane, asking the viewer nothing', async () => {
      const { manager, file, record } = deferredManager();
      record.deferred = false;

      await expect(manager._materializeDeferredDiff(file.file)).resolves.toBe(true);
      await expect(manager._materializeDeferredDiff('src/unknown.js')).resolves.toBe(false);
      await expect(manager._materializeDeferredDiff('')).resolves.toBe(false);
      expect(manager.pierreBridge.materializeDeferred).not.toHaveBeenCalled();
    });

    it('the "Load diff" button goes through _materializeDeferredDiff and reloads comments and suggestions', async () => {
      // A click is not inside a loadUserComments / loadAISuggestions flow, so
      // the comments and suggestions of the file must be put on the diff that
      // is now drawn.
      const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
      global.window = dom.window;
      global.document = dom.window.document;
      const { manager, file } = deferredManager();

      const placeholder = manager._createDeferredDiffPlaceholder(file);
      const materializeSpy = vi.spyOn(manager, '_materializeDeferredDiff');
      const button = placeholder.querySelector('.large-diff-load-btn');
      button.click();
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe('Loading...');
      await materializeSpy.mock.results[0].value;

      expect(materializeSpy).toHaveBeenCalledWith('src/huge.js', { reanchor: true });
      expect(manager.pierreBridge.materializeDeferred).toHaveBeenCalledTimes(1);
      expect(manager._reanchorInlineFeedbackAfterDeferredRender).toHaveBeenCalledTimes(1);
    });

    it('two requests for the same file are one change of the viewer; the first decides about the reload', async () => {
      const { manager, file } = deferredManager();
      let releaseYield;
      manager._yieldForDiffWork = vi.fn(() => new Promise((resolve) => { releaseYield = resolve; }));

      const first = manager._materializeDeferredDiff(file.file, { reanchor: true });
      const second = manager._materializeDeferredDiff(file.file); // defaults reanchor:false
      releaseYield();
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

      expect(manager.pierreBridge.materializeDeferred).toHaveBeenCalledTimes(1);
      expect(manager._reanchorInlineFeedbackAfterDeferredRender).toHaveBeenCalledTimes(1);
      // The shared promise is forgotten once it has settled.
      expect(manager._deferredDiffRenderPromises.size).toBe(0);
    });

    it('does nothing when the diff was rendered again while it waited for an idle moment', async () => {
      // renderDiff during the wait replaced every record: the file this was
      // asked for belongs to a diff that is gone.
      const { manager, file } = deferredManager();
      let releaseYield;
      manager._yieldForDiffWork = vi.fn(() => new Promise((resolve) => { releaseYield = resolve; }));

      const materialize = manager._materializeDeferredDiff(file.file, { reanchor: true });
      manager._renderGen += 1;
      releaseYield();

      await expect(materialize).resolves.toBe(false);
      expect(manager.pierreBridge.materializeDeferred).not.toHaveBeenCalled();
      expect(manager._reanchorInlineFeedbackAfterDeferredRender).not.toHaveBeenCalled();
    });

    it('answers false when the viewer could not show the diff', async () => {
      const { manager, file } = deferredManager();
      manager.pierreBridge.materializeDeferred = vi.fn(() => false);

      await expect(manager._materializeDeferredDiff(file.file, { reanchor: true })).resolves.toBe(false);
      expect(manager._reanchorInlineFeedbackAfterDeferredRender).not.toHaveBeenCalled();
    });
  });
});
