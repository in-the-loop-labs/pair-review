// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for TabTitle component
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let TabTitle;

beforeEach(() => {
  vi.useFakeTimers();

  global.document = {
    title: '',
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };

  // Fresh import each test
  vi.resetModules();
  return import('../../public/js/components/TabTitle.js').then(mod => {
    TabTitle = mod.TabTitle;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete global.document;
});

describe('TabTitle', () => {
  describe('setBase', () => {
    it('should set document.title with prefix', () => {
      const tt = new TabTitle();
      tt.setBase('PR #42');
      expect(document.title).toBe('pair-review - PR #42');
    });

    it('should handle empty identifier', () => {
      const tt = new TabTitle();
      tt.setBase('');
      expect(document.title).toBe('pair-review');
    });
  });

  describe('flashComplete (tab visible)', () => {
    it('should show message then revert after 3s', () => {
      const tt = new TabTitle();
      tt.setBase('PR #42');
      tt.flashComplete();

      expect(document.title).toBe('pair-review - ✓ Review Complete');

      vi.advanceTimersByTime(3000);
      expect(document.title).toBe('pair-review - PR #42');
    });

    it('should not start an interval or add visibilitychange listener', () => {
      const tt = new TabTitle();
      tt.setBase('PR #42');
      tt.flashComplete();

      // No visibilitychange listener added (only added for hidden tabs)
      expect(document.addEventListener).not.toHaveBeenCalled();
    });
  });

  describe('flashComplete (tab hidden)', () => {
    it('should alternate title on interval', () => {
      document.hidden = true;
      const tt = new TabTitle();
      tt.setBase('my-branch');
      tt.flashComplete();

      expect(document.title).toBe('pair-review - ✓ Review Complete');

      vi.advanceTimersByTime(1000);
      expect(document.title).toBe('pair-review - my-branch');

      vi.advanceTimersByTime(1000);
      expect(document.title).toBe('pair-review - ✓ Review Complete');
    });

    it('should register visibilitychange listener', () => {
      document.hidden = true;
      const tt = new TabTitle();
      tt.setBase('PR #1');
      tt.flashComplete();

      expect(document.addEventListener).toHaveBeenCalledWith(
        'visibilitychange',
        expect.any(Function)
      );
    });

    it('should stop flashing and revert when tab becomes visible', () => {
      document.hidden = true;
      const tt = new TabTitle();
      tt.setBase('PR #1');
      tt.flashComplete();

      // Simulate tab becoming visible
      document.hidden = false;
      const handler = document.addEventListener.mock.calls[0][1];
      handler();

      expect(document.title).toBe('pair-review - PR #1');
      expect(document.removeEventListener).toHaveBeenCalledWith(
        'visibilitychange',
        handler
      );
    });
  });

  describe('flashFailed', () => {
    it('should show failure message', () => {
      const tt = new TabTitle();
      tt.setBase('PR #99');
      tt.flashFailed();

      expect(document.title).toBe('pair-review - ✗ Review Failed');
    });

    it('should alternate when tab hidden', () => {
      document.hidden = true;
      const tt = new TabTitle();
      tt.setBase('PR #99');
      tt.flashFailed();

      vi.advanceTimersByTime(1000);
      expect(document.title).toBe('pair-review - PR #99');

      vi.advanceTimersByTime(1000);
      expect(document.title).toBe('pair-review - ✗ Review Failed');
    });
  });

  describe('successive flashes', () => {
    it('should stop previous flash before starting new one', () => {
      document.hidden = true;
      const tt = new TabTitle();
      tt.setBase('PR #1');
      tt.flashComplete();

      // Start a new flash — should clean up the first
      tt.flashFailed();
      expect(document.title).toBe('pair-review - ✗ Review Failed');

      vi.advanceTimersByTime(1000);
      // Should alternate with base, not with complete message
      expect(document.title).toBe('pair-review - PR #1');
    });

    it('should not let first visible-tab timeout revert a second flash', () => {
      // Tab is visible for both flashes
      document.hidden = false;
      const tt = new TabTitle();
      tt.setBase('PR #7');

      // First flash — starts a 3s timeout to revert
      tt.flashComplete();
      expect(document.title).toBe('pair-review - ✓ Review Complete');

      // 500ms later, a second flash arrives before the first timeout fires
      vi.advanceTimersByTime(500);
      tt.flashFailed();
      expect(document.title).toBe('pair-review - ✗ Review Failed');

      // Advance past the original 3s mark — the old timeout must have been cancelled
      vi.advanceTimersByTime(2500);
      expect(document.title).toBe('pair-review - ✗ Review Failed');

      // After the second timeout's full 3s, title reverts to base
      vi.advanceTimersByTime(500);
      expect(document.title).toBe('pair-review - PR #7');
    });
  });
});
