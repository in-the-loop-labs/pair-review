// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for UpdateBanner component.
 *
 * UpdateBanner fetches /api/config in its constructor and shows a
 * corner-card notification if `pending_update` is set. These tests pin the
 * constructor fetch chain, show() guards, and dismiss() lifecycle.
 *
 * jsdom notes:
 * - The jsdom environment provides a real DOM, so we do not stub
 *   document/sessionStorage/MutationObserver manually.
 * - The module-level singleton init at the bottom of UpdateBanner.js runs at
 *   import time (because jsdom defines `window`). We stub fetch BEFORE the
 *   first require so the singleton's fetch call is a harmless no-op.
 * - Each test creates its own UpdateBanner instance and asserts directly —
 *   the singleton is ignored.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub fetch BEFORE requiring the module. The module-load-time singleton init
// calls fetch('/api/config'), and jsdom's `window` is always defined, so we
// must have a safe mock in place before import.
global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

const { UpdateBanner } = require('../../public/js/components/UpdateBanner.js');

const DISMISS_KEY = 'update-banner-dismissed';

/** Flush the fetch -> .then() -> .then() promise chain used by the constructor. */
async function flushFetchChain() {
  // setImmediate runs after all microtasks, so any chain of .then()s scheduled
  // in the constructor will have completed by the time this resolves.
  await new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
  // Fresh fetch mock per test (default: empty config, no pending_update).
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

  // Reset DOM and sessionStorage between tests.
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UpdateBanner', () => {
  describe('constructor fetch-on-load', () => {
    it('appends banner when /api/config returns pending_update', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ pending_update: '3.3.0' })
      });

      new UpdateBanner();
      await flushFetchChain();

      const el = document.querySelector('[data-update-banner]');
      expect(el).not.toBeNull();
      expect(el.textContent).toContain('3.3.0');
      expect(el.textContent).toContain('Restart the server');
    });

    it('does not append banner when /api/config lacks pending_update', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({})
      });

      new UpdateBanner();
      await flushFetchChain();

      expect(document.querySelector('[data-update-banner]')).toBeNull();
    });

    it('does not append banner when fetch rejects', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('network down'));

      // Must not throw — the banner is non-critical, errors are swallowed.
      expect(() => new UpdateBanner()).not.toThrow();
      await flushFetchChain();

      expect(document.querySelector('[data-update-banner]')).toBeNull();
    });

    it('does not append banner when response is non-ok', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ pending_update: '3.3.0' })
      });

      new UpdateBanner();
      await flushFetchChain();

      expect(document.querySelector('[data-update-banner]')).toBeNull();
    });
  });

  describe('show() guards', () => {
    it('is a no-op when called with empty version', async () => {
      const ub = new UpdateBanner();
      await flushFetchChain();

      ub.show('');
      ub.show(null);
      ub.show(undefined);

      expect(document.querySelector('[data-update-banner]')).toBeNull();
    });

    it('is a no-op when this version was already dismissed in session', async () => {
      sessionStorage.setItem(DISMISS_KEY, '3.3.0');

      const ub = new UpdateBanner();
      await flushFetchChain();

      ub.show('3.3.0');

      expect(document.querySelector('[data-update-banner]')).toBeNull();
    });

    it('is idempotent when called twice with the same version', async () => {
      const ub = new UpdateBanner();
      await flushFetchChain();

      ub.show('3.3.0');
      ub.show('3.3.0');

      const banners = document.querySelectorAll('[data-update-banner]');
      expect(banners.length).toBe(1);
    });

    it('replaces the old banner when called with a newer version', async () => {
      const ub = new UpdateBanner();
      await flushFetchChain();

      ub.show('3.3.0');
      const first = document.querySelector('[data-update-banner]');
      expect(first.textContent).toContain('3.3.0');

      ub.show('3.4.0');
      const banners = document.querySelectorAll('[data-update-banner]');
      expect(banners.length).toBe(1);
      expect(banners[0].textContent).toContain('3.4.0');
      // The old banner node should no longer be attached to the DOM.
      expect(first.parentNode).toBeNull();
    });
  });

  describe('dismiss() lifecycle', () => {
    it('removes the banner from the DOM and writes sessionStorage', async () => {
      const ub = new UpdateBanner();
      await flushFetchChain();

      ub.show('3.3.0');
      expect(document.querySelector('[data-update-banner]')).not.toBeNull();

      ub.dismiss();

      expect(document.querySelector('[data-update-banner]')).toBeNull();
      expect(sessionStorage.getItem(DISMISS_KEY)).toBe('3.3.0');
    });

    it('dismiss button click removes the banner', async () => {
      const ub = new UpdateBanner();
      await flushFetchChain();
      ub.show('3.3.0');
      const btn = document.querySelector('[data-update-banner] button');
      btn.click();
      expect(document.querySelector('[data-update-banner]')).toBeNull();
      expect(sessionStorage.getItem(DISMISS_KEY)).toBe('3.3.0');
    });

    it('re-shows the banner for a newer version after a previous dismissal', async () => {
      const ub = new UpdateBanner();
      await flushFetchChain();

      ub.show('3.3.0');
      ub.dismiss();
      expect(document.querySelector('[data-update-banner]')).toBeNull();

      // A newer version is not suppressed by the old dismissal.
      ub.show('3.4.0');
      const el = document.querySelector('[data-update-banner]');
      expect(el).not.toBeNull();
      expect(el.textContent).toContain('3.4.0');
    });
  });
});
