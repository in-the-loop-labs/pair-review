// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the real Toast component.
 *
 * Focus: the close button. Every toast gets one, a click removes the toast
 * after the fade without waiting for its timer, and the auto-dismiss timer
 * still closes toasts nobody clicks.
 *
 * jsdom notes:
 * - Requiring the module runs its `window.toast` bootstrap. Each test builds
 *   its own instance; `createContainer()` removes the previous
 *   `#toast-container` node, so the singleton never interferes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { Toast } = require('../../public/js/components/Toast.js');

/** @type {Toast} */
let toast;

/** The toast elements currently in the container. */
function renderedToasts() {
  return Array.from(toast.toastContainer.querySelectorAll('.toast'));
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  toast = new Toast();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Toast', () => {
  describe('close button', () => {
    it.each([
      ['showSuccess', 'toast-success'],
      ['showError', 'toast-error'],
      ['showWarning', 'toast-warning'],
      ['showInfo', 'toast-info'],
    ])('%s renders a close button at the end of the content row', (method, className) => {
      toast[method]('Hello');

      const [el] = renderedToasts();
      expect(el.classList.contains(className)).toBe(true);

      const content = el.querySelector('.toast-content');
      const button = content.querySelector('.toast-close');
      expect(button).not.toBeNull();
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-label')).toBe('Dismiss notification');
      expect(content.lastElementChild).toBe(button);
    });

    it('puts the close button after the success link', () => {
      toast.showSuccess('Review submitted successfully!', { link: 'https://example.com/review' });

      const content = renderedToasts()[0].querySelector('.toast-content');
      const link = content.querySelector('.toast-link');
      expect(link).not.toBeNull();
      expect(link.nextElementSibling).toBe(content.querySelector('.toast-close'));
    });

    it('removes the toast after the fade when clicked, well before its timer', () => {
      toast.showSuccess('Review submitted successfully!', { duration: 5000 });
      const [el] = renderedToasts();

      el.querySelector('.toast-close').click();
      expect(el.classList.contains('toast-fade-out')).toBe(true);

      vi.advanceTimersByTime(Toast.FADE_MS);
      expect(el.isConnected).toBe(false);
      expect(toast.activeToasts).toEqual([]);
    });

    it('clears the auto-dismiss timer when clicked', () => {
      toast.showInfo('Hello', 5000);
      const [el] = renderedToasts();
      vi.advanceTimersByTime(10); // entrance animation

      el.querySelector('.toast-close').click();
      vi.advanceTimersByTime(Toast.FADE_MS);

      expect(vi.getTimerCount()).toBe(0);
    });

    it('only dismisses the toast whose button was clicked', () => {
      toast.showInfo('First', 5000);
      toast.showInfo('Second', 5000);
      const [first, second] = renderedToasts();

      first.querySelector('.toast-close').click();
      vi.advanceTimersByTime(Toast.FADE_MS);

      expect(first.isConnected).toBe(false);
      expect(second.isConnected).toBe(true);
      expect(toast.activeToasts).toEqual([second]);
    });
  });

  describe('auto-dismiss', () => {
    it('still removes a toast nobody clicks after its duration and the fade', () => {
      toast.showError('Something failed', 2000);
      const [el] = renderedToasts();

      vi.advanceTimersByTime(1999);
      expect(el.classList.contains('toast-fade-out')).toBe(false);

      vi.advanceTimersByTime(1);
      expect(el.classList.contains('toast-fade-out')).toBe(true);

      vi.advanceTimersByTime(Toast.FADE_MS);
      expect(el.isConnected).toBe(false);
      expect(toast.activeToasts).toEqual([]);
    });
  });

  describe('dismissToast', () => {
    it('is a no-op when the toast is already fading out', () => {
      toast.showWarning('Careful', 5000);
      const [el] = renderedToasts();
      vi.advanceTimersByTime(10); // entrance animation

      toast.dismissToast(el);
      const timersAfterFirst = vi.getTimerCount();
      toast.dismissToast(el);

      expect(vi.getTimerCount()).toBe(timersAfterFirst);

      vi.advanceTimersByTime(Toast.FADE_MS);
      expect(el.isConnected).toBe(false);
      expect(toast.activeToasts).toEqual([]);
    });

    it('ignores a missing or detached toast', () => {
      expect(() => toast.dismissToast(null)).not.toThrow();
      expect(() => toast.dismissToast(document.createElement('div'))).not.toThrow();
    });
  });

  describe('clearAll', () => {
    it('removes every active toast', () => {
      toast.showSuccess('One');
      toast.showError('Two');

      toast.clearAll();
      vi.advanceTimersByTime(Toast.FADE_MS);

      expect(renderedToasts()).toEqual([]);
      expect(toast.activeToasts).toEqual([]);
    });
  });
});
