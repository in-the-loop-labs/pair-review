// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const { createPierreEnv } = require('../utils/fake-code-view');

const RENDER_OPTIONS = {
  theme: { dark: 'github-dark', light: 'github-light' },
  useTokenTransformer: false,
  lineDiffType: 'word',
  maxLineDiffLength: 1000,
  tokenizeMaxLineLength: 1000,
};

function renderOne(bridge, document) {
  const root = document.createElement('div');
  bridge.renderAll(root, [
    { id: 'src/example.js', type: 'diff', fileName: 'src/example.js', patch: '@@ -1 +1 @@\n-old\n+new\n' },
  ]);
  return root;
}

describe('PierreBridge theme handling', () => {
  let env;

  afterEach(() => {
    env?.cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('propagates a theme change to the worker pool and re-publishes the CodeView', () => {
    const setRenderOptions = vi.fn(() => Promise.resolve());
    env = createPierreEnv({ worker: true, workerConfig: { setRenderOptions } });
    const bridge = new env.PierreBridge({ theme: 'light' });
    renderOne(bridge, env.document);
    const codeView = env.codeViews[0];
    const onThemeBefore = codeView.calls.onThemeChange;

    bridge.setTheme('dark');

    expect(setRenderOptions).toHaveBeenCalledWith(RENDER_OPTIONS);
    // The single CodeView is re-published with the new themeType.
    expect(codeView.calls.setOptions.length).toBeGreaterThan(0);
    expect(codeView.calls.setOptions.at(-1).themeType).toBe('dark');
    expect(codeView.calls.onThemeChange).toBe(onThemeBefore + 1);
    expect(bridge.theme).toBe('dark');
  });

  it('works worker-free: setTheme re-publishes the CodeView without a worker pool', () => {
    env = createPierreEnv({ worker: false });
    const bridge = new env.PierreBridge({ theme: 'light' });
    expect(bridge.workerManager).toBeNull();
    renderOne(bridge, env.document);
    const codeView = env.codeViews[0];

    expect(() => bridge.setTheme('dark')).not.toThrow();
    expect(codeView.calls.setOptions.at(-1).themeType).toBe('dark');
    expect(codeView.calls.onThemeChange).toBe(1);
  });

  it('renders through the worker-free path while startup is pending, then falls back on timeout', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const terminate = vi.fn();

    env = createPierreEnv({
      worker: true,
      workerConfig: {
        initialStats: { managerState: 'initializing', workersFailed: false },
        terminate,
      },
    });
    env.PierreBridge.WORKER_INIT_TIMEOUT_MS = 10;

    const bridge = new env.PierreBridge({ theme: 'light' });
    expect(bridge.workerManager).toBe(env.workerManagers[0]);
    expect(bridge._workerReady).toBe(false);

    renderOne(bridge, env.document);
    expect(env.codeViews).toHaveLength(1);

    vi.advanceTimersByTime(10);

    // The pool never initialized: workers are torn down and the CodeView is
    // recreated main-thread-only, preserving items.
    expect(bridge.workerManager).toBeNull();
    expect(env.workerManagers[0].terminated).toBe(true);
    expect(terminate).toHaveBeenCalled();
    expect(env.codeViews).toHaveLength(2);
    expect(env.codeViews[1].itemIds()).toEqual(['src/example.js']);
  });

  it('re-publishes every item once the worker pool reports initialized', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    env = createPierreEnv({
      worker: true,
      workerConfig: { initialStats: { managerState: 'initializing', workersFailed: false } },
    });

    const bridge = new env.PierreBridge({ theme: 'light' });
    expect(bridge._workerReady).toBe(false);
    renderOne(bridge, env.document);
    const codeView = env.codeViews[0];
    const setItemsBefore = codeView.calls.setItems.length;
    const versionBefore = codeView.getItem('src/example.js').version;

    // Pool finishes initializing → the bridge re-publishes all items so a fresh
    // render picks up worker highlighting.
    env.workerManagers[0].emitStats({ managerState: 'initialized', workersFailed: false });

    expect(bridge._workerReady).toBe(true);
    expect(codeView.calls.setItems.length).toBe(setItemsBefore + 1);
    expect(codeView.getItem('src/example.js').version).toBeGreaterThan(versionBefore);
  });

  it('falls back to main-thread rendering when the pool reports a failure', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    env = createPierreEnv({
      worker: true,
      workerConfig: { initialStats: { managerState: 'initializing', workersFailed: false } },
    });
    const bridge = new env.PierreBridge({ theme: 'light' });
    renderOne(bridge, env.document);

    env.workerManagers[0].emitStats({ managerState: 'failed', workersFailed: true });

    expect(bridge.workerManager).toBeNull();
    expect(env.workerManagers[0].terminated).toBe(true);
    // A fresh main-thread CodeView is created carrying the same item.
    expect(env.codeViews).toHaveLength(2);
    expect(env.codeViews[1].itemIds()).toEqual(['src/example.js']);
  });
});
