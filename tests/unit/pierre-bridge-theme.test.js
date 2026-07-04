// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const BRIDGE_PATH = '../../public/js/modules/pierre-bridge.js';

let originalWindow;
let originalWorker;
let originalDocument;
let originalRaf;

function loadPierreBridge({
  setRenderOptions = vi.fn(() => Promise.resolve()),
  FileDiff = function FileDiff() {},
  subscribeToStatChanges = vi.fn((callback) => {
    callback({ managerState: 'initialized', workersFailed: false });
    return () => {};
  }),
} = {}) {
  delete require.cache[require.resolve(BRIDGE_PATH)];
  const workerManagers = [];

  class WorkerPoolManager {
    constructor(poolOptions, renderOptions) {
      this.poolOptions = poolOptions;
      this.renderOptions = renderOptions;
      this.setRenderOptions = setRenderOptions;
      this.subscribeToStatChanges = subscribeToStatChanges;
      this.terminate = vi.fn();
      workerManagers.push(this);
    }
  }

  global.Worker = function Worker() {};
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  global.document = dom.window.document;
  global.window = {
    matchMedia: vi.fn(() => ({ matches: false })),
    navigator: { hardwareConcurrency: 4 },
    PierreDiffs: {
      FileDiff,
      WorkerPoolManager,
      parsePatchFiles: vi.fn(() => ([{
        files: [{ name: 'file', hunks: [] }],
      }])),
      getSingularPatch: vi.fn(() => ({ name: 'file', hunks: [] })),
    },
  };

  return {
    PierreBridge: require(BRIDGE_PATH),
    setRenderOptions,
    workerManagers,
  };
}

describe('PierreBridge theme handling', () => {
  beforeEach(() => {
    originalWindow = global.window;
    originalWorker = global.Worker;
    originalDocument = global.document;
    originalRaf = global.requestAnimationFrame;
  });

  afterEach(() => {
    delete require.cache[require.resolve(BRIDGE_PATH)];
    if (originalWindow === undefined) {
      delete global.window;
    } else {
      global.window = originalWindow;
    }
    if (originalWorker === undefined) {
      delete global.Worker;
    } else {
      global.Worker = originalWorker;
    }
    if (originalDocument === undefined) {
      delete global.document;
    } else {
      global.document = originalDocument;
    }
    if (originalRaf === undefined) {
      delete global.requestAnimationFrame;
    } else {
      global.requestAnimationFrame = originalRaf;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('propagates theme changes to the worker pool render options', () => {
    const { PierreBridge, setRenderOptions } = loadPierreBridge();
    const bridge = new PierreBridge({ theme: 'light' });
    const instance = { setThemeType: vi.fn() };
    bridge.files.set('src/example.js', { instance });

    bridge.setTheme('dark');

    expect(setRenderOptions).toHaveBeenCalledWith({
      theme: {
        dark: 'github-dark',
        light: 'github-light',
      },
      useTokenTransformer: false,
      lineDiffType: 'word',
      maxLineDiffLength: 1000,
      tokenizeMaxLineLength: 1000,
    });
    expect(instance.setThemeType).toHaveBeenCalledWith('dark');
  });

  it('uses non-worker rendering while startup is pending and disables workers on timeout', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const renderCalls = [];
    const instances = [];
    class FileDiff {
      constructor(_options, workerManager) {
        this.workerManager = workerManager;
        this.cleanUp = vi.fn();
        instances.push(this);
      }

      render(payload) {
        renderCalls.push({ workerManager: this.workerManager, payload });
        payload.containerWrapper.appendChild(document.createElement('diffs-container'));
        return !this.workerManager;
      }
    }

    const { PierreBridge, workerManagers } = loadPierreBridge({
      FileDiff,
      subscribeToStatChanges: vi.fn((callback) => {
        callback({ managerState: 'initializing', workersFailed: false });
        return () => {};
      }),
    });
    PierreBridge.WORKER_INIT_TIMEOUT_MS = 10;

    const bridge = new PierreBridge({ theme: 'light' });
    const container = document.createElement('div');
    bridge.renderFile('src/example.js', container, '@@ -1 +1 @@\n-old\n+new\n');

    expect(bridge.workerManager).toBe(workerManagers[0]);
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0].workerManager).toBeUndefined();
    vi.advanceTimersByTime(10);

    expect(bridge.workerManager).toBeNull();
    expect(workerManagers[0].terminate).toHaveBeenCalled();
    expect(instances[0].cleanUp).not.toHaveBeenCalled();
    expect(renderCalls).toHaveLength(1);
  });

  it('rebuilds pre-init files through the worker path once the pool initializes', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Capture requestAnimationFrame callbacks so we can prove the rebuild is
    // deferred (scheduled) and flush it deterministically.
    const rafCallbacks = [];
    global.requestAnimationFrame = (cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };
    const flushRaf = () => rafCallbacks.splice(0).forEach((cb) => cb());

    const instances = [];
    class FileDiff {
      constructor(_options, workerManager) {
        this.workerManager = workerManager;
        this.cleanUp = vi.fn();
        this.rerender = vi.fn();
        instances.push(this);
      }

      render(payload) {
        this.lastPayload = payload;
        payload.containerWrapper.appendChild(document.createElement('diffs-container'));
        return true;
      }
    }

    // Hold the pool in the "initializing" state at construction; capture the
    // stats callback so the test can drive the initialized transition later.
    let statsCallback = null;
    const { PierreBridge, workerManagers } = loadPierreBridge({
      FileDiff,
      subscribeToStatChanges: vi.fn((callback) => {
        statsCallback = callback;
        callback({ managerState: 'initializing', workersFailed: false });
        return () => {};
      }),
    });

    const bridge = new PierreBridge({ theme: 'light' });
    expect(bridge.workerManager).toBe(workerManagers[0]);
    expect(bridge._workerReady).toBe(false);

    // Render a file WHILE the worker pool is still initializing.
    const container = document.createElement('div');
    const fileState = bridge.renderFile('src/example.js', container, '@@ -1 +1 @@\n-old\n+new\n');

    // It rendered without a worker: instance built with an undefined manager.
    expect(instances).toHaveLength(1);
    expect(instances[0].workerManager).toBeUndefined();
    expect(fileState.usesWorkerManager).toBe(false);

    // Pool finishes initializing.
    statsCallback({ managerState: 'initialized', workersFailed: false });

    // Rebuild must be deferred to requestAnimationFrame, not run synchronously.
    expect(instances).toHaveLength(1);

    flushRaf();

    // The pre-init file is FULLY REBUILT through the worker path: a new FileDiff
    // instance is constructed with the real worker manager, the old one is torn
    // down, and usesWorkerManager flips to true.
    expect(instances).toHaveLength(2);
    expect(instances[0].cleanUp).toHaveBeenCalled();
    expect(instances[1].workerManager).toBe(workerManagers[0]);
    const rebuilt = bridge.files.get('src/example.js');
    expect(rebuilt.instance).toBe(instances[1]);
    expect(rebuilt.usesWorkerManager).toBe(true);
  });

  it('skips forcePlainText files when rebuilding after worker init', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const rafCallbacks = [];
    global.requestAnimationFrame = (cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };
    const flushRaf = () => rafCallbacks.splice(0).forEach((cb) => cb());

    const instances = [];
    class FileDiff {
      constructor(_options, workerManager) {
        this.workerManager = workerManager;
        this.cleanUp = vi.fn();
        this.rerender = vi.fn();
        instances.push(this);
      }

      render(payload) {
        payload.containerWrapper.appendChild(document.createElement('diffs-container'));
        return true;
      }
    }

    let statsCallback = null;
    const { PierreBridge } = loadPierreBridge({
      FileDiff,
      subscribeToStatChanges: vi.fn((callback) => {
        statsCallback = callback;
        callback({ managerState: 'initializing', workersFailed: false });
        return () => {};
      }),
    });

    const bridge = new PierreBridge({ theme: 'light' });
    const container = document.createElement('div');
    bridge.renderFile('big/file.js', container, '@@ -1 +1 @@\n-old\n+new\n', { forcePlainText: true });

    expect(instances).toHaveLength(1);

    statsCallback({ managerState: 'initialized', workersFailed: false });
    flushRaf();

    // A deliberately-plain file is not rebuilt — no new instance, still plain.
    expect(instances).toHaveLength(1);
    expect(bridge.files.get('big/file.js').usesWorkerManager).toBe(false);
  });
});
