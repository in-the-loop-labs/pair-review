// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for ScrollUtils.scrollIntoViewStable — the stable scroll used by
 * tour navigation, AI-panel/comment navigation, suggestion navigation, and
 * scroll-to-file. It must:
 *   - issue the caller's scroll, wait for the position to settle, then
 *     re-issue an instant corrective scroll,
 *   - keep correcting while the layout shifts under the scroll (bounded),
 *   - bail when the target leaves the DOM or the user scrolls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  scrollIntoViewStable,
  MAX_CORRECTIONS,
  SETTLE_FRAMES,
  SETTLE_TIMEOUT_MS
} = require('../../public/js/utils/scroll-into-view.js');

/**
 * Build a target element, optionally inside a .d2h-file-wrapper.
 * jsdom has no layout, so getBoundingClientRect is mocked; `state.top`
 * drives what the helper sees.
 */
function makeTarget({ wrapped = true } = {}) {
  const state = { top: 500, rendered: true };
  let parent = document.body;
  let wrapper = null;
  if (wrapped) {
    wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    document.body.appendChild(wrapper);
    parent = wrapper;
  }
  const target = document.createElement('tr');
  parent.appendChild(target);
  vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => ({
    top: state.rendered ? state.top : 0, bottom: state.rendered ? state.top + 20 : 0,
    left: 0, right: state.rendered ? 100 : 0,
    width: state.rendered ? 100 : 0, height: state.rendered ? 20 : 0
  }));
  target.scrollIntoView = vi.fn();
  return { target, wrapper, state };
}

beforeEach(() => {
  document.body.innerHTML = '';
  // Make frames immediate so settle waits resolve without real delays.
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  window.prManager = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.prManager;
});

describe('scrollIntoViewStable', () => {
  describe('delayed annotation paint', () => {
    let frames;

    beforeEach(() => {
      frames = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
        frames.push(callback);
        return frames.length;
      });
    });

    async function advanceFrames(count) {
      for (let i = 0; i < count; i++) {
        const callbacks = frames.splice(0);
        callbacks.forEach(callback => callback());
        await Promise.resolve();
      }
    }

    it('waits for a rendered box before settling and correcting the scroll', async () => {
      const { target, state } = makeTarget({ wrapped: false });
      state.rendered = false;
      target.scrollIntoView.mockImplementation(() => {
        if (state.rendered) state.top = 100;
      });
      let completed = false;
      const pending = scrollIntoViewStable(target, { behavior: 'smooth' })
        .then(() => { completed = true; });

      await advanceFrames(SETTLE_FRAMES + 3);
      expect(completed).toBe(false);
      expect(target.scrollIntoView).toHaveBeenCalledTimes(1);

      state.rendered = true;
      await advanceFrames(2 * (SETTLE_FRAMES + 1));
      await pending;
      expect(state.top).toBe(100);
      expect(target.scrollIntoView.mock.calls[1]).toEqual([{ behavior: 'auto' }]);
    });

    it('resets settling when a rendered target temporarily loses its box', async () => {
      const { target, state } = makeTarget({ wrapped: false });
      const pending = scrollIntoViewStable(target);
      await advanceFrames(SETTLE_FRAMES);
      state.rendered = false;
      await advanceFrames(SETTLE_FRAMES + 2);
      expect(target.scrollIntoView).toHaveBeenCalledTimes(1);

      state.rendered = true;
      await advanceFrames(SETTLE_FRAMES);
      expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
      await advanceFrames(1);
      await pending;
      expect(target.scrollIntoView).toHaveBeenCalledTimes(2);
    });

    it.each(['wheel', 'touchstart', 'keydown', 'detached', 'superseded'])(
      'cancels while waiting for paint: %s', async (reason) => {
        const { target, state } = makeTarget({ wrapped: false });
        state.rendered = false;
        const removed = vi.spyOn(window, 'removeEventListener');
        const pending = scrollIntoViewStable(target);
        let newer;
        if (reason === 'detached') target.remove();
        else if (reason === 'superseded') newer = scrollIntoViewStable(makeTarget({ wrapped: false }).target);
        else if (reason === 'keydown') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        else window.dispatchEvent(new Event(reason));

        await advanceFrames(SETTLE_FRAMES + 1);
        await pending;
        if (newer) await newer;
        expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
        for (const type of ['wheel', 'touchstart', 'keydown']) {
          expect(removed.mock.calls.some(([event]) => event === type)).toBe(true);
        }
      }
    );

    it('times out without corrective scrolling when the box never paints', async () => {
      const { target, state } = makeTarget({ wrapped: false });
      state.rendered = false;
      const now = vi.spyOn(Date, 'now').mockReturnValue(0);
      const removed = vi.spyOn(window, 'removeEventListener');
      const pending = scrollIntoViewStable(target);
      await advanceFrames(SETTLE_FRAMES + 1);
      now.mockReturnValue(SETTLE_TIMEOUT_MS + 1);
      await advanceFrames(1);
      await pending;
      expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
      expect(frames).toHaveLength(0);
      expect(removed).toHaveBeenCalledTimes(3);
    });
  });

  it('scrolls with the caller options, then probes once instantly when stable', async () => {
    const { target } = makeTarget();

    await scrollIntoViewStable(target, { behavior: 'smooth', block: 'center' });

    // Initial scroll + one corrective probe that found no movement.
    expect(target.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(target.scrollIntoView.mock.calls[0][0]).toEqual({ behavior: 'smooth', block: 'center' });
    expect(target.scrollIntoView.mock.calls[1][0]).toEqual({ behavior: 'auto', block: 'center' });
  });

  it('re-corrects when the corrective scroll moves the target (layout shifted)', async () => {
    const { target, state } = makeTarget();
    let scrollCount = 0;
    target.scrollIntoView = vi.fn(() => {
      scrollCount += 1;
      // Simulate the first corrective probe (call #2) snapping the target
      // to a new position because the layout shifted under the scroll.
      if (scrollCount === 2) state.top = 100;
    });

    await scrollIntoViewStable(target, { behavior: 'smooth', block: 'center' });

    // initial + moved probe + stable probe
    expect(target.scrollIntoView).toHaveBeenCalledTimes(3);
  });

  it('gives up after MAX_CORRECTIONS when layout never stabilizes', async () => {
    const { target, state } = makeTarget();
    target.scrollIntoView = vi.fn(() => { state.top -= 50; });

    await scrollIntoViewStable(target, {});

    expect(target.scrollIntoView).toHaveBeenCalledTimes(1 + MAX_CORRECTIONS);
  });

  it('does nothing for a disconnected target', async () => {
    const target = document.createElement('tr');
    target.scrollIntoView = vi.fn();

    await scrollIntoViewStable(target, {});

    expect(target.scrollIntoView).not.toHaveBeenCalled();
  });

  it('bails out without probing after the target is removed mid-settle', async () => {
    const { target } = makeTarget();
    target.scrollIntoView = vi.fn(() => {
      // Detach right after the initial scroll, as a tour exit / re-render would.
      target.remove();
    });

    await scrollIntoViewStable(target, {});

    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('stops correcting when the user scrolls (wheel input)', async () => {
    const { target } = makeTarget();
    target.scrollIntoView = vi.fn(() => {
      window.dispatchEvent(new Event('wheel'));
    });

    await scrollIntoViewStable(target, {});

    // Initial scroll only — the user's wheel cancels all corrections.
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('stops correcting when a scroll-intent key is pressed', async () => {
    const { target } = makeTarget();
    target.scrollIntoView = vi.fn(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    });

    await scrollIntoViewStable(target, {});

    // Initial scroll only — the keypress expresses scroll intent.
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('keeps correcting for non-scroll keys', async () => {
    const { target } = makeTarget();
    let n = 0;
    target.scrollIntoView = vi.fn(() => {
      if (++n === 1) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });

    await scrollIntoViewStable(target, {});

    // 'a' is not scroll intent — the corrective probe still runs.
    expect(target.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('does not cancel when a scroll key is typed into a form field', async () => {
    const { target } = makeTarget();
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    target.scrollIntoView = vi.fn(() => {
      // Space inside a textarea means "type a space", not "scroll the page".
      input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });

    await scrollIntoViewStable(target, {});

    expect(target.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('stops correcting on touchstart', async () => {
    const { target } = makeTarget();
    target.scrollIntoView = vi.fn(() => {
      window.dispatchEvent(new Event('touchstart'));
    });

    await scrollIntoViewStable(target, {});

    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('lets a newer scroll supersede an older in-flight one (latest-scroll-wins)', async () => {
    const a = makeTarget();
    const b = makeTarget();

    // Start A, then B before A settles. B bumps the active generation, so A
    // must bail out of its corrective probe instead of snapping back.
    const pA = scrollIntoViewStable(a.target, { behavior: 'smooth' });
    const pB = scrollIntoViewStable(b.target, { behavior: 'smooth' });
    await Promise.all([pA, pB]);

    // A: initial scroll only — superseded before its corrective probe.
    expect(a.target.scrollIntoView).toHaveBeenCalledTimes(1);
    // B: initial + one stable corrective probe.
    expect(b.target.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('removes every cancel listener after it resolves', async () => {
    const { target } = makeTarget();
    const added = [];
    const removed = [];
    vi.spyOn(window, 'addEventListener').mockImplementation((type) => added.push(type));
    vi.spyOn(window, 'removeEventListener').mockImplementation((type) => removed.push(type));

    await scrollIntoViewStable(target, {});

    for (const type of ['wheel', 'touchstart', 'keydown']) {
      expect(added.filter((t) => t === type)).toHaveLength(1);
      expect(removed.filter((t) => t === type)).toHaveLength(1);
    }
  });
});
