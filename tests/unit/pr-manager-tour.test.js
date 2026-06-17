// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for PRManager's tour orchestrator branches.
 *
 * We instantiate PRManager bare (via `Object.create(PRManager.prototype)`) so
 * the constructor's heavy init (fetch interceptor, event handlers, etc.)
 * doesn't run. Each test fills in only the state the branch under test reads.
 *
 * Covered branches:
 *   - _advanceTour skip-loop (probe-then-mount, completion flip,
 *     backward-exhaustion no-op).
 *   - Escape keydown branch guards (input field, modal open, chat panel open).
 *   - background_job_finished `hasActiveForType` guard.
 *   - _loadAndStashTour guard branches (no PR id, disabled, !ok, throw,
 *     generating).
 *   - review:tour_ready mid-tour stashes to pendingRestart.
 *   - renderDiff calls _exitTour when a tour is active.
 *   - Initial probe is NOT fired from the constructor.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Load modal-detection FIRST so it attaches to window — pr.js's tour
// handler defers to `window.ModalDetection?.isModalOpen()` and the
// existing "Escape with an open modal" test relies on that returning true.
require('../../public/js/utils/modal-detection.js');
const { PRManager } = require('../../public/js/pr.js');

function makeBareManager() {
  const m = Object.create(PRManager.prototype);
  m.currentPR = { id: 123 };
  m._toursEnabled = true;
  m._tourStops = null;
  m._tourGenerating = false;
  m._tourActiveIndex = -1;
  m._tourRenderer = null;
  m._tourBar = null;
  m._tourKeydownHandler = null;
  m._tourStopsPendingRestart = null;
  m._summariesGenerating = false;
  m._syncSummaryToolbarButton = vi.fn();
  // Re-entry guard slot for _promptCancelJob.
  m._cancelPromptOpen = false;
  // Generation-aware latch slot for _advanceTour. -1 means no in-flight
  // call; any other value pins the call to the `_tourGen` it entered on.
  // Must be initialized so `_advanceInFlightGen === _tourGen` is false on
  // first call (otherwise both default-undefined and the latch blocks
  // the very first invocation).
  m._advanceInFlightGen = -1;
  // Drain stash for the previous tour's async teardown (context-file
  // DELETEs). `_openTourAtStart` awaits this before reading wrappers.
  m._tourCleanupPending = null;
  return m;
}

function buildToolbar() {
  document.body.innerHTML = '';
  const btn = document.createElement('button');
  btn.id = 'tour-toggle-btn';
  document.body.appendChild(btn);
  return btn;
}

describe('PRManager._advanceTour skip-loop', () => {
  let m;
  beforeEach(() => {
    buildToolbar();
    m = makeBareManager();
    m._tourStops = [
      { title: 's0' }, { title: 's1' }, { title: 's2' }
    ];
    m._tourBar = {
      setCompleted: vi.fn(),
      setActiveIndex: vi.fn(),
      setStops: vi.fn(),
      mount: vi.fn(),
      unmount: vi.fn(),
    };
    m._tourRenderer = {
      // prepareStop is the async "ensure the stop is mountable" step the
      // navigator awaits before mountStop. Stub it to a resolved no-op so
      // the existing probe tests still drive mountStop's return value.
      prepareStop: vi.fn().mockResolvedValue(true),
      mountStop: vi.fn(),
      unmountStop: vi.fn(),
      unmountAll: vi.fn(),
      highlightActive: vi.fn(),
      scrollToStop: vi.fn(),
      setActive: vi.fn(),
      setStops: vi.fn(),
    };
  });

  it('probes forward past unmountable stops without unmounting current first', async () => {
    // Indices 0 and 1 unmountable; 2 mounts. From -1, _advanceTour(1)
    // should walk to 2 without ever calling unmountStop (no prior active).
    m._tourActiveIndex = -1;
    let calls = 0;
    m._tourRenderer.mountStop = vi.fn((i) => {
      calls++;
      return i === 2 ? { tagName: 'TR' } : null;
    });
    await m._advanceTour(1);
    expect(m._tourActiveIndex).toBe(2);
    expect(calls).toBe(3);
    expect(m._tourRenderer.unmountStop).not.toHaveBeenCalled();
    expect(m._tourBar.setActiveIndex).toHaveBeenCalledWith(2);
  });

  it('does NOT unmount current stop until a replacement is confirmed', async () => {
    // Active at 0; ask for next. Only index 2 mounts (1 is unmountable).
    m._tourActiveIndex = 0;
    m._tourRenderer.mountStop = vi.fn((i) => (i === 2 ? { tagName: 'TR' } : null));
    await m._advanceTour(1);
    expect(m._tourActiveIndex).toBe(2);
    // Unmount of previous happens AFTER the candidate is confirmed.
    expect(m._tourRenderer.unmountStop).toHaveBeenCalledWith(0);
  });

  it('flips to completion using last-mounted index when no forward stop is mountable', async () => {
    // Active at 1; forward candidates (2) fail. Bar must flip to completion
    // using the last-mounted index — NOT 2 — and tour must NOT exit.
    m._tourActiveIndex = 1;
    m._tourRenderer.mountStop = vi.fn(() => null);
    const exitSpy = vi.spyOn(m, '_exitTour').mockImplementation(() => {});
    await m._advanceTour(1);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(m._tourBar.setCompleted).toHaveBeenCalledWith(true);
    expect(m._tourBar.setActiveIndex).toHaveBeenCalledWith(1);
  });

  it('exits cleanly when no stop ever mounts (initial open with all stops filtered)', async () => {
    m._tourActiveIndex = -1;
    m._tourRenderer.mountStop = vi.fn(() => null);
    const exitSpy = vi.spyOn(m, '_exitTour').mockImplementation(() => {});
    await m._advanceTour(1);
    expect(exitSpy).toHaveBeenCalled();
  });

  it('backward exhaustion leaves the current stop mounted (no half-stuck UI)', async () => {
    m._tourActiveIndex = 2;
    // All earlier indices unmountable.
    m._tourRenderer.mountStop = vi.fn(() => null);
    const exitSpy = vi.spyOn(m, '_exitTour').mockImplementation(() => {});
    await m._advanceTour(-1);
    expect(exitSpy).not.toHaveBeenCalled();
    // Active index unchanged.
    expect(m._tourActiveIndex).toBe(2);
    // Unmount of the current stop must NOT happen.
    expect(m._tourRenderer.unmountStop).not.toHaveBeenCalled();
  });

  it('forward past the last stop flips completion without re-mounting', async () => {
    m._tourActiveIndex = 2;
    m._tourRenderer.mountStop = vi.fn(() => { throw new Error('should not mount'); });
    await m._advanceTour(1);
    expect(m._tourBar.setCompleted).toHaveBeenCalledWith(true);
    expect(m._tourBar.setActiveIndex).toHaveBeenCalledWith(2);
  });

  // ----------------------------------------------------------------------
  // The new prepareStop hook + re-entrance / staleness guards added when
  // _advanceTour became async (to support file-add + gap-expand on the
  // path to mounting).
  // ----------------------------------------------------------------------
  it('awaits prepareStop before each mount attempt so files / lines can be loaded', async () => {
    m._tourActiveIndex = 0;
    const order = [];
    m._tourRenderer.prepareStop = vi.fn(async (i) => { order.push(`prepare:${i}`); });
    m._tourRenderer.mountStop = vi.fn((i) => {
      order.push(`mount:${i}`);
      return i === 2 ? { tagName: 'TR' } : null;
    });
    await m._advanceTour(1);
    // Each probed index has prepare-before-mount ordering.
    expect(order).toEqual(['prepare:1', 'mount:1', 'prepare:2', 'mount:2']);
  });

  it('drops re-entrant Next presses while a prepareStop await is in flight', async () => {
    m._tourActiveIndex = 0;
    let resolvePrepare;
    const prepareGate = new Promise((res) => { resolvePrepare = res; });
    m._tourRenderer.prepareStop = vi.fn(() => prepareGate);
    m._tourRenderer.mountStop = vi.fn(() => ({ tagName: 'TR' }));

    const first = m._advanceTour(1);
    // While the first call sits on prepareGate, a second Next should be
    // dropped — not queued — so we don't get two interleaved probe loops.
    const second = m._advanceTour(1);
    await second; // resolves immediately (early return)
    expect(m._tourRenderer.mountStop).not.toHaveBeenCalled();
    resolvePrepare();
    await first;
    expect(m._tourRenderer.mountStop).toHaveBeenCalledTimes(1);
  });

  it('bails out without mutating state when the tour is exited mid-prepareStop', async () => {
    m._tourActiveIndex = 0;
    m._tourGen = 1;
    let resolvePrepare;
    m._tourRenderer.prepareStop = vi.fn(() => new Promise((res) => { resolvePrepare = res; }));
    m._tourRenderer.mountStop = vi.fn(() => { throw new Error('must not mount on stale tour'); });

    const advance = m._advanceTour(1);
    // Simulate an exit happening while prepareStop is awaited (bumps gen).
    m._tourGen += 1;
    resolvePrepare();
    await advance;

    // No mount, no active-index mutation, no bar update.
    expect(m._tourRenderer.mountStop).not.toHaveBeenCalled();
    expect(m._tourActiveIndex).toBe(0);
    expect(m._tourBar.setActiveIndex).not.toHaveBeenCalled();
  });

  it('releases the in-flight latch after early-return on forward exhaustion (no permanent wedge)', async () => {
    m._tourActiveIndex = 2; // last stop; Next should flip to completion
    m._tourRenderer.mountStop = vi.fn(() => ({ tagName: 'TR' }));
    await m._advanceTour(1);
    // The completion path returns early; if the finally didn't run, the
    // next Prev would silently no-op forever. The slot must be released
    // back to the sentinel value (-1), not the generation it ran on.
    expect(m._advanceInFlightGen).toBe(-1);
    // And a follow-up Prev is honored.
    await m._advanceTour(-1);
    expect(m._tourRenderer.mountStop).toHaveBeenCalled();
  });

  // ----------------------------------------------------------------------
  // Regression: the latch must be generation-aware. A boolean latch left
  // set by an exit-during-prepareStop wedges the next reopen, because
  // `_exitTour` only bumps `_tourGen` — it never clears the in-flight
  // flag, and the resumed _advanceTour bails (via isStale) BEFORE its
  // finally can release it. Reopen then hits the latch and no-ops.
  // ----------------------------------------------------------------------
  it('does not wedge the next open when exit happens during prepareStop await', async () => {
    m._tourActiveIndex = 0;
    m._tourGen = 1;
    let resolveFirst;
    // First prepareStop call stalls; subsequent calls resolve so the
    // second _advanceTour can probe to a mountable stop.
    let prepareCallCount = 0;
    m._tourRenderer.prepareStop = vi.fn(() => {
      prepareCallCount++;
      if (prepareCallCount === 1) {
        return new Promise((res) => { resolveFirst = res; });
      }
      return Promise.resolve(true);
    });
    m._tourRenderer.mountStop = vi.fn(() => ({ tagName: 'TR' }));

    // 1) Start an advance — it parks on the first prepareStop await,
    //    holding the latch slot for gen=1.
    const first = m._advanceTour(1);

    // 2) Exit happens (bumps _tourGen) → the parked advance is stale.
    //    Crucially, a boolean latch would still be set here.
    m._tourGen += 1;
    // 3) Reopen bumps gen again, the way _openTourAtStart would.
    m._tourGen += 1;

    // 4) Reopen's first _advanceTour MUST acquire the latch — the prior
    //    call's holder pins gen=1 and we're now on gen=3, so the latch
    //    check (`_advanceInFlightGen === _tourGen`) is false. Proceed
    //    to mount stop 0.
    m._tourActiveIndex = -1;
    await m._advanceTour(1);
    expect(m._tourRenderer.mountStop).toHaveBeenCalledWith(0);
    expect(m._tourActiveIndex).toBe(0);
    // After the fresh call's finally, the latch is released (the call
    // owned the slot for gen=3 and reset it).
    expect(m._advanceInFlightGen).toBe(-1);

    // 5) Let the stale first call finally resume — its continuation
    //    detects staleness (gen=3 !== startGen=1) and bails. Its
    //    finally check (`_advanceInFlightGen === startGen`) is false
    //    (slot is -1, not 1), so it must NOT clobber the slot.
    resolveFirst();
    await first;
    expect(m._advanceInFlightGen).toBe(-1);
  });
});

describe('PRManager tour Escape keydown guards', () => {
  let m, handler;
  beforeEach(() => {
    buildToolbar();
    m = makeBareManager();
    m._tourActiveIndex = 0;
    m._tourRenderer = {
      mountStop: vi.fn(() => ({})),
      unmountStop: vi.fn(),
      unmountAll: vi.fn(),
      highlightActive: vi.fn(),
      scrollToStop: vi.fn(),
      setActive: vi.fn(),
    };
    m._tourBar = { unmount: vi.fn(), setCompleted: vi.fn(), setActiveIndex: vi.fn() };
    // Capture the bound handler.
    const origAdd = document.addEventListener;
    document.addEventListener = function(type, fn) {
      if (type === 'keydown') handler = fn;
      return origAdd.call(this, type, fn);
    };
    m._registerTourKeyboardHandlers();
    document.addEventListener = origAdd;
  });
  afterEach(() => {
    document.removeEventListener('keydown', handler);
  });

  it('Escape in a focused TEXTAREA does NOT exit the tour', () => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    const exitSpy = vi.spyOn(m, '_exitTour').mockImplementation(() => {});
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    Object.defineProperty(ev, 'target', { value: ta });
    handler(ev);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('ArrowRight in a focused INPUT does NOT advance', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const advSpy = vi.spyOn(m, '_advanceTour').mockImplementation(() => {});
    const ev = new KeyboardEvent('keydown', { key: 'ArrowRight' });
    Object.defineProperty(ev, 'target', { value: input });
    handler(ev);
    expect(advSpy).not.toHaveBeenCalled();
  });

  it('Escape with an open modal does NOT exit the tour', () => {
    const modal = document.createElement('div');
    modal.className = 'review-modal-overlay';
    document.body.appendChild(modal);
    const exitSpy = vi.spyOn(m, '_exitTour').mockImplementation(() => {});
    const ev = new KeyboardEvent('keydown', { key: 'Escape' });
    Object.defineProperty(ev, 'target', { value: document.body });
    handler(ev);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('Escape with chat panel open does NOT exit the tour', () => {
    const chat = document.createElement('div');
    chat.className = 'chat-panel chat-panel--open';
    document.body.appendChild(chat);
    const exitSpy = vi.spyOn(m, '_exitTour').mockImplementation(() => {});
    const ev = new KeyboardEvent('keydown', { key: 'Escape' });
    Object.defineProperty(ev, 'target', { value: document.body });
    handler(ev);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('ArrowRight with chat panel open does NOT advance the tour', () => {
    // The chat panel guard must be unconditional — earlier it only
    // blocked Escape, so arrow keys silently advanced the tour while
    // chat was open.
    const chat = document.createElement('div');
    chat.className = 'chat-panel chat-panel--open';
    document.body.appendChild(chat);
    const advSpy = vi.spyOn(m, '_advanceTour').mockImplementation(() => {});
    const ev = new KeyboardEvent('keydown', { key: 'ArrowRight' });
    Object.defineProperty(ev, 'target', { value: document.body });
    handler(ev);
    expect(advSpy).not.toHaveBeenCalled();
  });

  it('ArrowLeft with chat panel open does NOT advance the tour', () => {
    const chat = document.createElement('div');
    chat.className = 'chat-panel chat-panel--open';
    document.body.appendChild(chat);
    const advSpy = vi.spyOn(m, '_advanceTour').mockImplementation(() => {});
    const ev = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
    Object.defineProperty(ev, 'target', { value: document.body });
    handler(ev);
    expect(advSpy).not.toHaveBeenCalled();
  });

  it('Escape with no modal/chat/input exits the tour', () => {
    const exitSpy = vi.spyOn(m, '_exitTour').mockImplementation(() => {});
    const ev = new KeyboardEvent('keydown', { key: 'Escape' });
    Object.defineProperty(ev, 'target', { value: document.body });
    handler(ev);
    expect(exitSpy).toHaveBeenCalled();
  });
});

describe('PRManager._loadAndStashTour guard branches', () => {
  let m;
  beforeEach(() => {
    buildToolbar();
    m = makeBareManager();
  });

  it('returns null without fetching when currentPR is missing', async () => {
    m.currentPR = null;
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) });
    const out = await m._loadAndStashTour();
    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns null without fetching when tours are disabled', async () => {
    m._toursEnabled = false;
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) });
    const out = await m._loadAndStashTour();
    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns null without state mutation on non-ok response', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, json: async () => ({}) });
    m._tourStops = ['preexisting'];
    const out = await m._loadAndStashTour();
    expect(out).toBeNull();
    expect(m._tourStops).toEqual(['preexisting']);
    fetchSpy.mockRestore();
  });

  it('returns null and logs without throwing when fetch rejects', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('net'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m._tourStops = ['preexisting'];
    const out = await m._loadAndStashTour();
    expect(out).toBeNull();
    expect(m._tourStops).toEqual(['preexisting']);
    expect(warnSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('sets _tourGenerating=true and syncs button when generating', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ generating: true, tour: null })
    });
    await m._loadAndStashTour();
    expect(m._tourGenerating).toBe(true);
    const btn = document.getElementById('tour-toggle-btn');
    expect(btn.classList.contains('generating')).toBe(true);
    fetchSpy.mockRestore();
  });

  it('stashes pendingRestart instead of overwriting when deferIfActive and tour active', async () => {
    m._tourStops = [{ title: 'old' }];
    m._tourActiveIndex = 0;
    m._tourRenderer = {}; // makes _tourIsActive() truthy
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ tour: { stops: [{ title: 'new' }] }, generating: false })
    });
    await m._loadAndStashTour({ deferIfActive: true });
    expect(m._tourStops).toEqual([{ title: 'old' }]);
    expect(m._tourStopsPendingRestart).toEqual([{ title: 'new' }]);
    const btn = document.getElementById('tour-toggle-btn');
    expect(btn.classList.contains('tour-updated-pending')).toBe(true);
    fetchSpy.mockRestore();
  });

  it('happy path: assigns stops, clears pendingRestart, clears generating', async () => {
    // ITEM 11 — happy-path coverage for the assignment branch.
    m._tourActiveIndex = -1;
    m._tourStops = null;
    m._tourStopsPendingRestart = [{ title: 'leftover' }];
    m._tourGenerating = true;
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ tour: { stops: [{ title: 'a' }] }, generating: false })
    });
    await m._loadAndStashTour();
    expect(m._tourStops).toEqual([{ title: 'a' }]);
    expect(m._tourStopsPendingRestart).toBeNull();
    expect(m._tourGenerating).toBe(false);
    fetchSpy.mockRestore();
  });

  it('renderGen guard: does NOT touch state when _renderGen bumps between fetch and json', async () => {
    // ITEM 4 — guard against stale renders.
    m._renderGen = 1;
    m._tourStops = ['preexisting'];
    let resolveJson;
    const jsonPromise = new Promise((resolve) => { resolveJson = resolve; });
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () => jsonPromise
    });
    const loadPromise = m._loadAndStashTour();
    // Simulate a fresh renderDiff bumping _renderGen mid-flight.
    m._renderGen = 2;
    resolveJson({ tour: { stops: [{ title: 'stale' }] }, generating: false });
    const result = await loadPromise;
    expect(result).toBeNull();
    expect(m._tourStops).toEqual(['preexisting']);
    fetchSpy.mockRestore();
  });

  it('renderGen guard: does NOT abort when cancelOnRender is false', async () => {
    // ITEM 3/4 coordination — the deferred config-resolve probe is a
    // one-shot recovery path. Bumping _renderGen between awaits must NOT
    // make it bail.
    m._renderGen = 1;
    let resolveJson;
    const jsonPromise = new Promise((resolve) => { resolveJson = resolve; });
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () => jsonPromise
    });
    const loadPromise = m._loadAndStashTour({ cancelOnRender: false });
    m._renderGen = 99; // would be stale for cancelOnRender:true callers
    resolveJson({ tour: { stops: [{ title: 'ok' }] }, generating: false });
    const result = await loadPromise;
    expect(result).toEqual([{ title: 'ok' }]);
    expect(m._tourStops).toEqual([{ title: 'ok' }]);
    fetchSpy.mockRestore();
  });
});

// ----------------------------------------------------------------------
// Regression: the prior tour's context-file DELETEs are fire-and-forget,
// so without an explicit drain the next open can race against them. A
// DELETE's loadContextFiles reload landing mid-open would rip the new
// tour's wrapper out from under an active stop.
// ----------------------------------------------------------------------
describe('PRManager._openTourAtStart drains prior teardown before mounting', () => {
  let m;
  beforeEach(() => {
    buildToolbar();
    m = makeBareManager();
    m._tourStops = [{ title: 's0' }];
    m._tourBar = {
      setCompleted: vi.fn(),
      setActiveIndex: vi.fn(),
      setStops: vi.fn(),
      mount: vi.fn(),
      unmount: vi.fn(),
    };
    m._tourRenderer = {
      prepareStop: vi.fn().mockResolvedValue(true),
      mountStop: vi.fn(() => ({ tagName: 'TR' })),
      unmountStop: vi.fn(),
      unmountAll: vi.fn(),
      highlightActive: vi.fn(),
      scrollToStop: vi.fn(),
      setActive: vi.fn(),
      setStops: vi.fn(),
    };
    m._registerTourKeyboardHandlers = vi.fn();
    m._unregisterTourKeyboardHandlers = vi.fn();
    m._syncTourToolbarButton = vi.fn();
  });

  it('does not begin mounting until the prior teardown DELETE settles', async () => {
    // _exitTour stashes the drain promise returned by unmountAll. Stall
    // it to model an in-flight context-file DELETE + its loadContextFiles.
    let resolveDrain;
    const drain = new Promise((res) => { resolveDrain = res; });
    m._tourRenderer.unmountAll = vi.fn(() => drain);
    m._exitTour();
    expect(m._tourCleanupPending).toBe(drain);

    // Reopen — _openTourAtStart must park on the drain BEFORE reading
    // any wrappers (i.e. before setStops, setActive, mount).
    const open = m._openTourAtStart();
    // One microtask is enough for the `await _tourCleanupPending` line
    // to run; the body past that point would only execute once drain
    // resolves.
    await Promise.resolve();
    expect(m._tourRenderer.setStops).not.toHaveBeenCalled();
    expect(m._tourBar.mount).not.toHaveBeenCalled();

    // Drain resolves — reopen proceeds.
    resolveDrain();
    await open;
    expect(m._tourRenderer.setStops).toHaveBeenCalledWith(m._tourStops);
    expect(m._tourBar.mount).toHaveBeenCalled();
    // Pending slot is consumed exactly once.
    expect(m._tourCleanupPending).toBeNull();
  });

  it('is a no-op drain when no prior tour was exited (fresh open)', async () => {
    // No _exitTour was called — _tourCleanupPending should still be null
    // and the open proceeds without parking.
    expect(m._tourCleanupPending).toBeNull();
    await m._openTourAtStart();
    expect(m._tourRenderer.setStops).toHaveBeenCalledWith(m._tourStops);
  });
});

describe('PRManager._restartTour consumes pendingRestart', () => {
  // ITEM 10 — verify _restartTour swaps to the pending stops and clears them.
  it('swaps _tourStopsPendingRestart into _tourStops and re-opens', () => {
    buildToolbar();
    const m = makeBareManager();
    m._tourStops = [{ title: 'old' }];
    m._tourActiveIndex = 0;
    m._tourRenderer = {
      unmountAll: vi.fn(),
      setActive: vi.fn(),
    };
    m._tourBar = { unmount: vi.fn() };
    m._tourStopsPendingRestart = [{ title: 'new' }];
    const openSpy = vi.spyOn(m, '_openTourAtStart').mockImplementation(() => {});
    m._restartTour();
    expect(m._tourStops).toEqual([{ title: 'new' }]);
    expect(m._tourStopsPendingRestart).toBeNull();
    expect(openSpy).toHaveBeenCalledTimes(1);
  });
});

describe('PRManager renderDiff tear-down', () => {
  let m;
  beforeEach(() => {
    buildToolbar();
    document.body.insertAdjacentHTML('beforeend', '<div id="diff-container"></div>');
    m = makeBareManager();
    m.generatedFiles = new Map();
    m.contextFiles = [];
    m.loadContextFiles = vi.fn();
    m.validatePendingEofGaps = vi.fn();
    m.hunkSummaryRenderer = { reset: vi.fn() };
    m._fetchHunkSummaryMap = vi.fn().mockResolvedValue(null);
    m._loadAndStashTour = vi.fn().mockResolvedValue(null);
  });

  it('calls _exitTour when tour is active and clears _tourStops', () => {
    m._tourActiveIndex = 0;
    m._tourRenderer = { unmountAll: vi.fn(), setActive: vi.fn() };
    m._tourBar = { unmount: vi.fn() };
    m._tourStops = [{ title: 'whatever' }];
    const exitSpy = vi.spyOn(m, '_exitTour');
    m.renderDiff({ changed_files: [] });
    expect(exitSpy).toHaveBeenCalled();
    expect(m._tourStops).toBeNull();
  });

  it('does not call _exitTour when no tour is active', () => {
    const exitSpy = vi.spyOn(m, '_exitTour').mockImplementation(() => {});
    m.renderDiff({ changed_files: [] });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('tears down the tour BEFORE wiping diff DOM so unmountAll can re-collapse', () => {
    // Regression: if innerHTML='' runs first, unmountAll's
    // `.d2h-file-wrapper[data-file-name=...]` lookups all miss and
    // pre-tour collapse state is silently lost.
    const diffContainer = document.getElementById('diff-container');
    diffContainer.insertAdjacentHTML(
      'beforeend',
      '<div class="d2h-file-wrapper" data-file-name="foo.js"></div>'
    );
    m._tourActiveIndex = 0;
    m._tourRenderer = { unmountAll: vi.fn(), setActive: vi.fn() };
    m._tourBar = { unmount: vi.fn() };
    m._tourStops = [{ title: 'whatever' }];

    let wrapperPresentAtExit = null;
    vi.spyOn(m, '_exitTour').mockImplementation(() => {
      wrapperPresentAtExit = !!diffContainer.querySelector(
        '.d2h-file-wrapper[data-file-name="foo.js"]'
      );
    });

    m.renderDiff({ changed_files: [] });

    expect(wrapperPresentAtExit).toBe(true);
  });
});

describe('PRManager review:tour_ready handler stashes pendingRestart mid-tour', () => {
  let m;
  beforeEach(async () => {
    document.body.innerHTML = '';
    buildToolbar();
    m = makeBareManager();
    m._reviewEventsBound = false;
    // Mark tour active so the deferIfActive branch fires.
    m._tourActiveIndex = 0;
    m._tourRenderer = {};
    m._tourStops = [{ title: 'old' }];

    // Stub _loadAndStashTour to verify it's called with deferIfActive.
    m._loadAndStashTour = vi.fn().mockResolvedValue(null);

    // Stub deps used by _initReviewEventListeners.
    window.chatPanel = {
      _ensureSubscriptions: vi.fn(),
      _lateBindReview: vi.fn().mockResolvedValue(undefined)
    };
    m._initReviewEventListeners();
  });

  it('forwards deferIfActive:true so live tour is preserved', () => {
    const ev = new CustomEvent('review:tour_ready', { detail: { reviewId: m.currentPR.id } });
    document.dispatchEvent(ev);
    expect(m._loadAndStashTour).toHaveBeenCalledWith({ deferIfActive: true });
  });

  it('background_job_finished honors hasActiveForType=true (pulse stays)', () => {
    m._tourGenerating = true;
    const ev = new CustomEvent('review:background_job_finished', {
      detail: { reviewId: m.currentPR.id, jobType: 'tour', hasActiveForType: true }
    });
    document.dispatchEvent(ev);
    expect(m._tourGenerating).toBe(true);
  });

  it('background_job_finished clears _tourGenerating when no sibling job in flight', () => {
    m._tourGenerating = true;
    const ev = new CustomEvent('review:background_job_finished', {
      detail: { reviewId: m.currentPR.id, jobType: 'tour', hasActiveForType: false }
    });
    document.dispatchEvent(ev);
    expect(m._tourGenerating).toBe(false);
  });
});

describe('PRManager initial tour probe is deferred', () => {
  it('setupEventHandlers does NOT call _loadAndStashTour even when tours are enabled', async () => {
    // The setupEventHandlers tour block must only flip toolbar visibility
    // — the probe is deferred to renderDiff because `currentPR.id` is not
    // set yet during constructor wiring.
    document.body.innerHTML = '';
    document.body.insertAdjacentHTML('beforeend', `
      <button id="theme-toggle"></button>
      <button id="analyze-btn"></button>
      <button id="refresh-pr"></button>
      <button id="summary-toggle-btn"></button>
      <button id="tour-toggle-btn" style="display:none"></button>
    `);

    const m = Object.create(PRManager.prototype);
    m._getAppConfig = vi.fn().mockResolvedValue({
      tours: { enabled: true },
      summaries: { enabled: true }
    });
    m.toggleSummariesVisibility = vi.fn();
    m.toggleTheme = vi.fn();
    m.triggerAIAnalysis = vi.fn();
    m.refreshPR = vi.fn();
    m.startOrToggleTour = vi.fn();
    m.setupPRDescriptionPopover = vi.fn();
    m.setupCommentFormDelegation = vi.fn();
    m._syncSummaryToolbarButton = vi.fn();
    m._syncTourToolbarButton = vi.fn();
    m._restoreSummariesHiddenFiles = vi.fn();
    const probeSpy = vi.spyOn(m, '_loadAndStashTour').mockResolvedValue(null);

    m.setupEventHandlers();
    // Drain the _getAppConfig().then promise.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(probeSpy).not.toHaveBeenCalled();
    // Toolbar should be revealed since tours.enabled === true.
    const btn = document.getElementById('tour-toggle-btn');
    expect(btn.style.display).toBe('');
    // _toursEnabled is gated on tours.enabled ALONE (not summaries).
    expect(m._toursEnabled).toBe(true);
  });

  it('_toursEnabled is true even when summaries.enabled is false', async () => {
    document.body.innerHTML = '';
    document.body.insertAdjacentHTML('beforeend', `
      <button id="theme-toggle"></button>
      <button id="analyze-btn"></button>
      <button id="refresh-pr"></button>
      <button id="summary-toggle-btn"></button>
      <button id="tour-toggle-btn" style="display:none"></button>
    `);
    const m = Object.create(PRManager.prototype);
    m._getAppConfig = vi.fn().mockResolvedValue({
      tours: { enabled: true },
      summaries: { enabled: false }
    });
    m.toggleSummariesVisibility = vi.fn();
    m.toggleTheme = vi.fn();
    m.triggerAIAnalysis = vi.fn();
    m.refreshPR = vi.fn();
    m.startOrToggleTour = vi.fn();
    m.setupPRDescriptionPopover = vi.fn();
    m.setupCommentFormDelegation = vi.fn();
    m._syncSummaryToolbarButton = vi.fn();
    m._syncTourToolbarButton = vi.fn();
    m.setupEventHandlers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(m._toursEnabled).toBe(true);
  });

  it('config-resolve probe fires _loadAndStashTour when renderDiff already ran', async () => {
    // ITEM 3 — when /api/config resolves AFTER the first renderDiff
    // already finished (so its `_toursEnabled === true` check failed and
    // skipped the probe), the deferred config handler must fire the probe
    // exactly once.
    document.body.innerHTML = '';
    document.body.insertAdjacentHTML('beforeend', `
      <button id="theme-toggle"></button>
      <button id="analyze-btn"></button>
      <button id="refresh-pr"></button>
      <button id="summary-toggle-btn"></button>
      <button id="tour-toggle-btn" style="display:none"></button>
    `);
    const m = Object.create(PRManager.prototype);
    m._getAppConfig = vi.fn().mockResolvedValue({
      tours: { enabled: true },
      summaries: { enabled: true }
    });
    m.toggleSummariesVisibility = vi.fn();
    m.toggleTheme = vi.fn();
    m.triggerAIAnalysis = vi.fn();
    m.refreshPR = vi.fn();
    m.startOrToggleTour = vi.fn();
    m.setupPRDescriptionPopover = vi.fn();
    m.setupCommentFormDelegation = vi.fn();
    m._syncSummaryToolbarButton = vi.fn();
    m._syncTourToolbarButton = vi.fn();
    // Simulate renderDiff having already run before /api/config resolves.
    m._renderGen = 1;
    const probeSpy = vi.spyOn(m, '_loadAndStashTour').mockResolvedValue(null);
    m.setupEventHandlers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(probeSpy).toHaveBeenCalledTimes(1);
    // And it must opt out of the renderGen guard so it doesn't
    // false-abort.
    expect(probeSpy).toHaveBeenCalledWith({ cancelOnRender: false });
  });
});

// ----------------------------------------------------------------------
// Regression: _promptCancelJob must be re-entrant-safe. The pulsing toolbar
// button stays clickable while ConfirmDialog is open; without a guard a
// rapid second click overwrites the singleton dialog's callbacks and
// orphans the first invocation's Promise.
// ----------------------------------------------------------------------
describe('PRManager._promptCancelJob re-entry guard', () => {
  let m;
  let origCancelHelper;

  beforeEach(() => {
    document.body.innerHTML = '';
    m = makeBareManager();
    origCancelHelper = window.CancelBackgroundJob;
  });

  afterEach(() => {
    window.CancelBackgroundJob = origCancelHelper;
  });

  it('drops a second click while the first dialog is still open', async () => {
    let resolveFirst;
    const firstDialog = new Promise((res) => { resolveFirst = res; });
    const showCancelTourDialog = vi.fn(() => firstDialog);
    window.CancelBackgroundJob = {
      showCancelTourDialog,
      showCancelSummariesDialog: vi.fn(),
    };

    const onCleared = vi.fn();
    const first = m._promptCancelJob({ kind: 'tour', onCleared });
    // Second click while first awaits the dialog — must NOT call show again.
    const second = m._promptCancelJob({ kind: 'tour', onCleared });
    await second; // second returns immediately
    expect(showCancelTourDialog).toHaveBeenCalledTimes(1);
    expect(m._cancelPromptOpen).toBe(true);

    // Resolve the first dialog and finish the first call.
    resolveFirst();
    await first;
    expect(m._cancelPromptOpen).toBe(false);
  });

  it('releases the guard after dialog close so subsequent clicks work', async () => {
    const showCancelTourDialog = vi.fn().mockResolvedValue(undefined);
    window.CancelBackgroundJob = {
      showCancelTourDialog,
      showCancelSummariesDialog: vi.fn(),
    };
    await m._promptCancelJob({ kind: 'tour', onCleared: vi.fn() });
    expect(m._cancelPromptOpen).toBe(false);
    await m._promptCancelJob({ kind: 'tour', onCleared: vi.fn() });
    expect(showCancelTourDialog).toHaveBeenCalledTimes(2);
  });

  it('releases the guard even when the dialog show() rejects', async () => {
    const showCancelTourDialog = vi.fn().mockRejectedValue(new Error('boom'));
    window.CancelBackgroundJob = {
      showCancelTourDialog,
      showCancelSummariesDialog: vi.fn(),
    };
    await expect(
      m._promptCancelJob({ kind: 'tour', onCleared: vi.fn() })
    ).rejects.toThrow('boom');
    expect(m._cancelPromptOpen).toBe(false);
  });

  it('summary handler also respects the guard (shared singleton)', async () => {
    // A user mashing the summaries pulse must not stack two dialogs either.
    let resolveFirst;
    const firstDialog = new Promise((res) => { resolveFirst = res; });
    const showCancelSummariesDialog = vi.fn(() => firstDialog);
    window.CancelBackgroundJob = {
      showCancelTourDialog: vi.fn(),
      showCancelSummariesDialog,
    };
    const first = m._promptCancelJob({ kind: 'summaries', onCleared: vi.fn() });
    const second = m._promptCancelJob({ kind: 'summaries', onCleared: vi.fn() });
    await second;
    expect(showCancelSummariesDialog).toHaveBeenCalledTimes(1);
    resolveFirst();
    await first;
  });

  it('returns early without setting the guard when no helper is registered', async () => {
    window.CancelBackgroundJob = null;
    await m._promptCancelJob({ kind: 'tour', onCleared: vi.fn() });
    // Guard must NOT remain stuck on after an early-return path.
    expect(m._cancelPromptOpen).toBe(false);
  });

  it('returns early without setting the guard when currentPR.id is missing', async () => {
    m.currentPR = null;
    const showCancelTourDialog = vi.fn();
    window.CancelBackgroundJob = {
      showCancelTourDialog,
      showCancelSummariesDialog: vi.fn(),
    };
    await m._promptCancelJob({ kind: 'tour', onCleared: vi.fn() });
    expect(showCancelTourDialog).not.toHaveBeenCalled();
    expect(m._cancelPromptOpen).toBe(false);
  });
});

describe('PRManager toggle-click handlers', () => {
  let m;
  let origCancelHelper;

  beforeEach(() => {
    document.body.innerHTML = '';
    m = makeBareManager();
    origCancelHelper = window.CancelBackgroundJob;
    window.CancelBackgroundJob = {
      showCancelTourDialog: vi.fn().mockResolvedValue(undefined),
      showCancelSummariesDialog: vi.fn().mockResolvedValue(undefined),
    };
  });
  afterEach(() => {
    window.CancelBackgroundJob = origCancelHelper;
  });

  it('_handleSummaryToggleClick falls through to toggleSummariesVisibility when not generating and summaries exist', async () => {
    // Post-generation: summaries exist (and mounted), so a click toggles
    // visibility.
    m._summariesGenerating = false;
    m._summariesAvailable = true;
    m._summariesGenerated = true;
    m.toggleSummariesVisibility = vi.fn();
    m._startGenerationJob = vi.fn();
    await m._handleSummaryToggleClick();
    expect(m.toggleSummariesVisibility).toHaveBeenCalledTimes(1);
    expect(m._startGenerationJob).not.toHaveBeenCalled();
    expect(window.CancelBackgroundJob.showCancelSummariesDialog).not.toHaveBeenCalled();
  });

  it('_handleSummaryToggleClick toggles visibility when summaries are available but not yet mounted', async () => {
    // Regression: with lazy file bodies a valid summary can be queued (its
    // anchor isn't rendered yet) so `_summariesGenerated` stays false. The
    // click must still toggle visibility — gating on `_summariesGenerated`
    // here would dispatch a duplicate generation job for summaries that
    // already exist server-side.
    m._summariesGenerating = false;
    m._summariesAvailable = true;
    m._summariesGenerated = false;
    m.toggleSummariesVisibility = vi.fn();
    m._startGenerationJob = vi.fn();
    await m._handleSummaryToggleClick();
    expect(m.toggleSummariesVisibility).toHaveBeenCalledTimes(1);
    expect(m._startGenerationJob).not.toHaveBeenCalled();
  });

  it('_handleSummaryToggleClick triggers manual generation when nothing generated yet', async () => {
    // Pre-generated state (auto_generate off, no summaries): a click kicks off
    // generation rather than toggling visibility.
    m._summariesGenerating = false;
    m._summariesAvailable = false;
    m._summariesGenerated = false;
    m.toggleSummariesVisibility = vi.fn();
    m._startGenerationJob = vi.fn().mockResolvedValue(undefined);
    await m._handleSummaryToggleClick();
    expect(m._startGenerationJob).toHaveBeenCalledTimes(1);
    expect(m._startGenerationJob).toHaveBeenCalledWith('summary');
    expect(m.toggleSummariesVisibility).not.toHaveBeenCalled();
  });

  it('_handleSummaryToggleClick routes to the cancel flow when generating', async () => {
    m._summariesGenerating = true;
    m.toggleSummariesVisibility = vi.fn();
    await m._handleSummaryToggleClick();
    expect(window.CancelBackgroundJob.showCancelSummariesDialog).toHaveBeenCalledTimes(1);
    expect(m.toggleSummariesVisibility).not.toHaveBeenCalled();
  });

  it('_handleTourToggleClick falls through to startOrToggleTour when not generating', async () => {
    m._tourGenerating = false;
    m.startOrToggleTour = vi.fn().mockResolvedValue(undefined);
    await m._handleTourToggleClick();
    expect(m.startOrToggleTour).toHaveBeenCalledTimes(1);
    expect(window.CancelBackgroundJob.showCancelTourDialog).not.toHaveBeenCalled();
  });

  it('_handleTourToggleClick routes to the cancel flow when generating', async () => {
    m._tourGenerating = true;
    m.startOrToggleTour = vi.fn().mockResolvedValue(undefined);
    await m._handleTourToggleClick();
    expect(window.CancelBackgroundJob.showCancelTourDialog).toHaveBeenCalledTimes(1);
    expect(m.startOrToggleTour).not.toHaveBeenCalled();
  });
});

describe('PRManager._syncTourToolbarButton label', () => {
  let m;
  let btn;

  beforeEach(() => {
    btn = buildToolbar();
    m = makeBareManager();
  });

  it('reads "Generate guided tour" when no stops exist and auto-generate is off', () => {
    // Auto-generation off: clicking kicks off manual generation, so the verb
    // is "Generate" rather than "Start".
    m._tourStops = null;
    m._toursAutoGenerate = false;
    m._syncTourToolbarButton();
    expect(btn.title).toBe('Generate guided tour');
    expect(btn.getAttribute('aria-label')).toBe('Generate guided tour');
  });

  it('reads "(none available yet)" when no stops exist and auto-generate is on', () => {
    // Auto-generation on: the tour is produced for us, so the inert button
    // keeps its passive label.
    m._tourStops = null;
    m._toursAutoGenerate = true;
    m._syncTourToolbarButton();
    expect(btn.title).toBe('Guided tour (none available yet)');
  });

  it('reads "Start guided tour" once stops exist regardless of auto-generate', () => {
    m._tourStops = [{ title: 's0' }];
    m._toursAutoGenerate = false;
    m._syncTourToolbarButton();
    expect(btn.title).toBe('Start guided tour');
  });
});
