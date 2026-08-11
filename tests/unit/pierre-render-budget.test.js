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
  PIERRE_POINTER_UPGRADE_RETRY_MS: PRManager.PIERRE_POINTER_UPGRADE_RETRY_MS,
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
  manager.currentPR = { id: 42 };
  manager.changedFilesByPath = new Map();
  manager._pierreContentUpgradePromises = new Map();
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
    const manager = createManager({ worker: true });
    const sourceFile = Array.from({ length: 6500 }, (_, index) => `line ${index + 1}`).join('\n');

    expect(PRManager.PIERRE_UPGRADE_MAX_PATCH_LINES).toBeGreaterThanOrEqual(
      PRManager.PIERRE_HIGHLIGHT_MAX_PATCH_LINES
    );
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

  // There is deliberately NO shared cross-file highlight pool: the decision
  // runs for every file up front (in file-list order, not view order) and the
  // verdict is baked into the CodeView item with no re-highlight path, so a
  // pool would permanently downgrade files the user may open — to save work
  // virtualization never performs for unmounted items anyway.
  it('does not downgrade later files once earlier files have been highlighted', () => {
    const manager = createManager({ worker: true });

    const decisions = Array.from({ length: 5 }, (_, i) =>
      manager._getPierreRenderDecision(fileWithPatch(String(i).repeat(45)))
    );

    for (const decision of decisions) {
      expect(decision).toEqual({ usePierre: true, forcePlainText: false, deferDiff: false });
    }
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

  // Background full-content upgrades re-render the diff (patch-only → full-
  // contents flip = a shadow-DOM rebuild that moves the hovered gutter button).
  // _fetchAndUpgradePierreFileContents re-checks isPointerOverFile IMMEDIATELY
  // before the per-file publish: a hovered file is deferred + requeued (so the
  // rebuild never lands mid hover/click — the comment-family E2E flake), an
  // offscreen file upgrades freely, and the user-driven waitForPointerIdle:false
  // path (jump-to-comment) upgrades now regardless.
  describe('pointer-idle content-upgrade gating', () => {
    const PATCH = '@@ -1 +1 @@\n-a\n+b\n';

    function upgradeManager({ hovered }) {
      const manager = createManager({ worker: true });
      manager._fileContentsAbort = { signal: { aborted: false } };
      manager.pierreBridge.isPointerOverFile = vi.fn(() => hovered);
      manager.pierreBridge.upgradeFileContents = vi.fn(() => true);
      global.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ oldContents: 'o\n', newContents: 'n\n' }),
      }));
      return manager;
    }

    it('defers instead of publishing while the pointer is over the file', async () => {
      const manager = upgradeManager({ hovered: true });
      const deferSpy = vi.spyOn(manager, '_deferPierreUpgrade').mockImplementation(() => {});
      const file = { file: 'src/hovered.js', patch: PATCH };

      const result = await manager._fetchAndUpgradePierreFileContents(file, { aborted: false });

      expect(result).toBe(false);
      expect(manager.pierreBridge.upgradeFileContents).not.toHaveBeenCalled();
      expect(deferSpy).toHaveBeenCalledWith(file);
    });

    it('publishes immediately for an offscreen (non-hovered) file', async () => {
      const manager = upgradeManager({ hovered: false });
      const deferSpy = vi.spyOn(manager, '_deferPierreUpgrade');
      const file = { file: 'src/off.js', patch: PATCH };

      const result = await manager._fetchAndUpgradePierreFileContents(file, { aborted: false });

      expect(result).toBe(true);
      expect(deferSpy).not.toHaveBeenCalled();
      expect(manager.pierreBridge.upgradeFileContents).toHaveBeenCalledWith(
        'src/off.js', expect.any(Object), expect.any(Object)
      );
    });

    it('skips the pointer gate on the user-driven immediate path (waitForPointerIdle:false)', async () => {
      const manager = upgradeManager({ hovered: true }); // hovered, but user asked
      const deferSpy = vi.spyOn(manager, '_deferPierreUpgrade');
      const file = { file: 'src/jump.js', patch: PATCH };

      const result = await manager._fetchAndUpgradePierreFileContents(
        file, { aborted: false }, { waitForPointerIdle: false }
      );

      expect(result).toBe(true);
      expect(deferSpy).not.toHaveBeenCalled();
      expect(manager.pierreBridge.upgradeFileContents).toHaveBeenCalledWith(
        'src/jump.js', expect.any(Object), expect.any(Object)
      );
    });

    it('requeues a deferred upgrade after the retry window (pointer-leave path)', async () => {
      vi.useFakeTimers();
      try {
        const manager = createManager({ worker: true });
        manager._fileContentsAbort = { signal: { aborted: false } };
        manager._pierreUpgradeCandidates = new Set(['src/hovered.js']);
        // The drain marked the deferred file completed; the retry must clear it.
        manager._fileContentsUpgradeState = { completed: new Set(['src/hovered.js']) };
        const enqueueSpy = vi.spyOn(manager, '_enqueuePierreContentUpgrade').mockImplementation(() => {});
        const file = { file: 'src/hovered.js', patch: PATCH };

        manager._deferPierreUpgrade(file);

        await vi.advanceTimersByTimeAsync(PRManager.PIERRE_POINTER_UPGRADE_RETRY_MS - 1);
        expect(enqueueSpy).not.toHaveBeenCalled(); // not before the window elapses

        await vi.advanceTimersByTimeAsync(1);
        expect(manager._fileContentsUpgradeState.completed.has('src/hovered.js')).toBe(false);
        expect(enqueueSpy).toHaveBeenCalledWith(file);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not requeue a deferred upgrade once the queue is aborted', async () => {
      vi.useFakeTimers();
      try {
        const manager = createManager({ worker: true });
        const signal = { aborted: false };
        manager._fileContentsAbort = { signal };
        const enqueueSpy = vi.spyOn(manager, '_enqueuePierreContentUpgrade').mockImplementation(() => {});
        const file = { file: 'src/hovered.js', patch: PATCH };

        manager._deferPierreUpgrade(file);
        signal.aborted = true; // a newer render aborted the queue mid-wait

        await vi.advanceTimersByTimeAsync(PRManager.PIERRE_POINTER_UPGRADE_RETRY_MS);
        expect(enqueueSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    // Regression: the requeue must re-establish a queue when the previous one
    // drained to empty and nulled _fileContentsUpgradeState. A push-only enqueue
    // would silently drop the retry.
    it('re-establishes a drained/nulled queue on requeue', () => {
      const manager = createManager({ worker: true });
      const signal = { aborted: false };
      manager._fileContentsAbort = { signal };
      manager._pierreUpgradeCandidates = new Set(['src/drained.js']);
      manager._fileContentsUpgradeState = null; // queue drained empty and nulled
      const startSpy = vi.spyOn(manager, '_startFileContentUpgradeQueue').mockImplementation(() => {});
      const file = { file: 'src/drained.js', patch: PATCH };

      manager._enqueuePierreContentUpgrade(file);

      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(startSpy).toHaveBeenCalledWith([file], expect.any(Function), signal);
    });

    it('reuses a live queue on requeue instead of starting a new one', () => {
      const manager = createManager({ worker: true });
      const signal = { aborted: false };
      manager._fileContentsAbort = { signal };
      manager._pierreUpgradeCandidates = new Set(['src/live.js']);
      const state = { signal, completed: new Set(), inFlight: new Set(), pending: [] };
      manager._fileContentsUpgradeState = state;
      const startSpy = vi.spyOn(manager, '_startFileContentUpgradeQueue').mockImplementation(() => {});
      const drainSpy = vi.spyOn(manager, '_drainFileContentUpgradeQueue').mockImplementation(() => {});
      const file = { file: 'src/live.js', patch: PATCH };

      manager._enqueuePierreContentUpgrade(file);

      expect(startSpy).not.toHaveBeenCalled();
      expect(state.pending).toContainEqual(file);
      expect(drainSpy).toHaveBeenCalledWith(state);
    });

    // The contents fetched for a deferred attempt are parked and reused: the
    // pointer moving does not invalidate them, and the baseMetadata early-out
    // cannot cover the retry (metadata only lands on a successful upgrade), so
    // without the cache a pointer parked over a file re-downloads and re-parses
    // it on every retry tick.
    it('reuses the fetched contents on a deferred retry instead of re-fetching', async () => {
      const manager = upgradeManager({ hovered: true });
      vi.spyOn(manager, '_deferPierreUpgrade').mockImplementation(() => {});
      const file = { file: 'src/hovered.js', patch: PATCH };

      await manager._fetchAndUpgradePierreFileContents(file, { aborted: false });
      await manager._fetchAndUpgradePierreFileContents(file, { aborted: false });
      await manager._fetchAndUpgradePierreFileContents(file, { aborted: false });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(manager._deferredUpgradeContents.get('src/hovered.js')).toEqual({
        oldFile: { name: 'src/hovered.js', contents: 'o\n' },
        newFile: { name: 'src/hovered.js', contents: 'n\n' },
      });
    });

    it('publishes the cached contents (no second fetch) once the pointer leaves', async () => {
      const manager = upgradeManager({ hovered: true });
      vi.spyOn(manager, '_deferPierreUpgrade').mockImplementation(() => {});
      const file = { file: 'src/hovered.js', patch: PATCH };

      expect(await manager._fetchAndUpgradePierreFileContents(file, { aborted: false })).toBe(false);
      manager.pierreBridge.isPointerOverFile.mockReturnValue(false);
      expect(await manager._fetchAndUpgradePierreFileContents(file, { aborted: false })).toBe(true);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(manager.pierreBridge.upgradeFileContents).toHaveBeenCalledWith(
        'src/hovered.js',
        { name: 'src/hovered.js', contents: 'o\n' },
        { name: 'src/hovered.js', contents: 'n\n' }
      );
      // Published — nothing left to park.
      expect(manager._deferredUpgradeContents.has('src/hovered.js')).toBe(false);
    });

    it('drops parked contents when a new render replaces the abort controller', () => {
      vi.useFakeTimers();
      try {
        global.window = { requestIdleCallback: null };
        const manager = createManager({ worker: true });
        manager._deferredUpgradeContents = new Map([['src/stale.js', { oldFile: null, newFile: {} }]]);

        // The catch-up sweep is scheduled, not run — only the controller swap
        // (and the cache drop that goes with it) is under test here.
        manager._upgradeFilesWithContents([{ file: 'src/stale.js', patch: PATCH }]);

        expect(manager._fileContentsAbort).toBeInstanceOf(AbortController);
        expect(manager._deferredUpgradeContents).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    // End-to-end: a file deferred while hovered upgrades on its own once the
    // pointer leaves — through the real defer timer → requeue → drained-queue
    // re-establish → worker → re-fetch → publish chain (no method mocked).
    it('upgrades a deferred file end-to-end after the pointer leaves', async () => {
      vi.useFakeTimers();
      try {
        const manager = createManager({ worker: true });
        const signal = { aborted: false };
        manager._fileContentsAbort = { signal };
        manager._pierreUpgradeCandidates = new Set(['e2e.js']);
        let hovered = true;
        manager.pierreBridge.isPointerOverFile = vi.fn(() => hovered);
        manager.pierreBridge.upgradeFileContents = vi.fn((filePath) => {
          manager.pierreBridge.files.set(filePath, { baseMetadata: { hunks: [] } });
          return true;
        });
        global.fetch = vi.fn(async () => ({
          ok: true,
          json: async () => ({ oldContents: 'o\n', newContents: 'n\n' }),
        }));
        const file = { file: 'e2e.js', patch: PATCH };

        // First background attempt while hovered → deferred (retry timer armed).
        const deferred = await manager._fetchAndUpgradePierreFileContents(file, signal);
        expect(deferred).toBe(false);
        expect(manager.pierreBridge.upgradeFileContents).not.toHaveBeenCalled();

        // Pointer leaves; the retry re-enqueues, re-fetches, and now publishes.
        hovered = false;
        await vi.advanceTimersByTimeAsync(PRManager.PIERRE_POINTER_UPGRADE_RETRY_MS);
        await vi.advanceTimersByTimeAsync(0);

        expect(manager.pierreBridge.upgradeFileContents).toHaveBeenCalledWith(
          'e2e.js', expect.any(Object), expect.any(Object)
        );
      } finally {
        vi.useRealTimers();
      }
    });
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

  it('ensures Pierre metadata before adding hidden-line context ranges', async () => {
    const manager = createManager({ worker: true });
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

});
