// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for TourBar.
 *
 * Verifies mount/unmount lifecycle, progress text, button callbacks, and the
 * completion-state chrome swap. Tests target the real production module —
 * no duplicated logic.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { TourBar } = require('../../public/js/components/TourBar.js');

function makeStops(n) {
  return Array.from({ length: n }, (_, i) => ({
    file_path: `src/file-${i}.js`,
    side: 'RIGHT',
    line_start: 10 + i,
    line_end: 10 + i,
    title: `Stop ${i + 1}`,
    description: `Description ${i + 1}`,
  }));
}

describe('TourBar', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('mount/unmount', () => {
    it('appends a .tour-bar to document.body on mount', () => {
      const bar = new TourBar({});
      expect(document.querySelector('.tour-bar')).toBeNull();
      bar.mount();
      expect(document.querySelector('.tour-bar')).not.toBeNull();
    });

    it('is idempotent — mounting twice keeps a single bar', () => {
      const bar = new TourBar({});
      bar.mount();
      bar.mount();
      expect(document.querySelectorAll('.tour-bar')).toHaveLength(1);
    });

    it('removes the bar on unmount', () => {
      const bar = new TourBar({});
      bar.mount();
      bar.unmount();
      expect(document.querySelector('.tour-bar')).toBeNull();
    });

    it('unmount is safe to call repeatedly', () => {
      const bar = new TourBar({});
      bar.mount();
      bar.unmount();
      expect(() => bar.unmount()).not.toThrow();
    });
  });

  describe('progress text', () => {
    it('shows "Stop N of M" when an active index is set', () => {
      const bar = new TourBar({}).mount();
      bar.setStops(makeStops(3));
      bar.setActiveIndex(1);
      expect(document.querySelector('.tour-bar__progress').textContent)
        .toBe('Stop 2 of 3');
    });

    it('shows the stop count before any stop is active', () => {
      const bar = new TourBar({}).mount();
      bar.setStops(makeStops(5));
      // No setActiveIndex call -> default -1.
      expect(document.querySelector('.tour-bar__progress').textContent)
        .toBe('5 stops');
    });

    it('shows "Tour complete" on completion', () => {
      const bar = new TourBar({}).mount();
      bar.setStops(makeStops(3));
      bar.setActiveIndex(2);
      bar.setCompleted(true);
      expect(document.querySelector('.tour-bar__progress').textContent)
        .toMatch(/Tour complete/);
    });

    it('re-renders correctly when state is set BEFORE mount', () => {
      const bar = new TourBar({});
      bar.setStops(makeStops(2));
      bar.setActiveIndex(0);
      bar.mount();
      expect(document.querySelector('.tour-bar__progress').textContent)
        .toBe('Stop 1 of 2');
    });
  });

  describe('callbacks', () => {
    it('Prev/Next/Exit fire their callbacks on click', () => {
      const onPrev = vi.fn();
      const onNext = vi.fn();
      const onExit = vi.fn();
      const bar = new TourBar({ onPrev, onNext, onExit }).mount();
      bar.setStops(makeStops(3));
      bar.setActiveIndex(1);

      document.querySelector('.tour-bar__prev').click();
      document.querySelector('.tour-bar__next').click();
      document.querySelector('.tour-bar__exit').click();

      expect(onPrev).toHaveBeenCalledTimes(1);
      expect(onNext).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledTimes(1);
    });

    it('disables Prev on the first stop and enables it on later stops', () => {
      const bar = new TourBar({}).mount();
      bar.setStops(makeStops(3));
      bar.setActiveIndex(0);
      const prev = document.querySelector('.tour-bar__prev');
      expect(prev.disabled).toBe(true);
      bar.setActiveIndex(1);
      expect(prev.disabled).toBe(false);
    });

    it('Restart fires its callback when in completed state', () => {
      const onRestart = vi.fn();
      const bar = new TourBar({ onRestart }).mount();
      bar.setStops(makeStops(2));
      bar.setActiveIndex(1);
      bar.setCompleted(true);
      document.querySelector('.tour-bar__restart').click();
      expect(onRestart).toHaveBeenCalledTimes(1);
    });

    it('Close in completed state fires onExit', () => {
      const onExit = vi.fn();
      const bar = new TourBar({ onExit }).mount();
      bar.setStops(makeStops(2));
      bar.setActiveIndex(1);
      bar.setCompleted(true);
      document.querySelector('.tour-bar__close').click();
      expect(onExit).toHaveBeenCalledTimes(1);
    });
  });

  describe('setCompleted', () => {
    it('swaps Prev/Next/Exit for Restart/Close', () => {
      const bar = new TourBar({}).mount();
      bar.setStops(makeStops(2));
      bar.setActiveIndex(0);

      const prev = document.querySelector('.tour-bar__prev');
      const next = document.querySelector('.tour-bar__next');
      const exit = document.querySelector('.tour-bar__exit');
      const restart = document.querySelector('.tour-bar__restart');
      const close = document.querySelector('.tour-bar__close');

      // Default chrome visible.
      expect(prev.style.display).toBe('');
      expect(next.style.display).toBe('');
      expect(exit.style.display).toBe('');
      expect(restart.style.display).toBe('none');
      expect(close.style.display).toBe('none');

      bar.setCompleted(true);
      expect(prev.style.display).toBe('none');
      expect(next.style.display).toBe('none');
      expect(exit.style.display).toBe('none');
      expect(restart.style.display).toBe('');
      expect(close.style.display).toBe('');

      bar.setCompleted(false);
      expect(prev.style.display).toBe('');
      expect(restart.style.display).toBe('none');
    });
  });
});
