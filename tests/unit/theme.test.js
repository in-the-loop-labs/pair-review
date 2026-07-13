// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the shared theme helper (public/js/theme.js).
 *
 * Covers the pure resolution/cycling/label/icon logic and the browser-facing
 * helpers (preference storage, applying data-theme, the toggle wiring, and the
 * live OS-change listener). matchMedia is stubbed since jsdom does not
 * implement it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const Theme = require('../../public/js/theme.js');

/**
 * Build a controllable matchMedia stub. Only the dark-scheme query is
 * meaningful; `.matches` is driven by the shared `state.dark` flag and
 * `setDark()` fires registered change listeners.
 */
function installMatchMedia() {
  const state = { dark: false, listeners: new Set() };
  const mql = {
    get matches() {
      return state.dark;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type, fn) => state.listeners.add(fn),
    removeEventListener: (_type, fn) => state.listeners.delete(fn),
    // legacy API intentionally omitted so tests exercise the modern path
  };
  window.matchMedia = vi.fn(() => mql);
  return {
    setDark(value) {
      state.dark = value;
      for (const fn of state.listeners) fn({ matches: value });
    },
    listenerCount: () => state.listeners.size,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.matchMedia;
});

describe('resolveTheme (pure)', () => {
  it('resolves system to the OS scheme', () => {
    expect(Theme.resolveTheme('system', true)).toBe('dark');
    expect(Theme.resolveTheme('system', false)).toBe('light');
  });

  it('passes through explicit light/dark regardless of OS', () => {
    expect(Theme.resolveTheme('dark', false)).toBe('dark');
    expect(Theme.resolveTheme('light', true)).toBe('light');
  });

  it('falls back to light for unknown preferences', () => {
    expect(Theme.resolveTheme('solarized', true)).toBe('light');
    expect(Theme.resolveTheme(undefined, true)).toBe('light');
  });
});

describe('nextPreference (pure)', () => {
  it('cycles light -> dark -> system -> light', () => {
    expect(Theme.nextPreference('light')).toBe('dark');
    expect(Theme.nextPreference('dark')).toBe('system');
    expect(Theme.nextPreference('system')).toBe('light');
  });

  it('starts the cycle for unknown values', () => {
    expect(Theme.nextPreference('nonsense')).toBe('light');
  });
});

describe('labelFor / describe (pure)', () => {
  it('names the current preference and the next one', () => {
    expect(Theme.labelFor('light')).toBe('Theme: Light (click for Dark)');
    expect(Theme.labelFor('dark')).toBe('Theme: Dark (click for System)');
    expect(Theme.labelFor('system')).toBe('Theme: System (click for Light)');
  });

  it('falls back to the default for unknown preferences', () => {
    expect(Theme.labelFor('bogus')).toBe('Theme: Light (click for Dark)');
  });
});

describe('iconSvg (pure)', () => {
  it('returns distinct svg markup per preference', () => {
    const light = Theme.iconSvg('light');
    const dark = Theme.iconSvg('dark');
    const system = Theme.iconSvg('system');
    for (const svg of [light, dark, system]) {
      expect(svg).toContain('<svg');
      expect(svg).toContain('aria-hidden="true"');
    }
    expect(new Set([light, dark, system]).size).toBe(3);
  });

  it('treats unknown preferences as light', () => {
    expect(Theme.iconSvg('bogus')).toBe(Theme.iconSvg('light'));
  });
});

describe('getPreference / setPreference', () => {
  it('defaults to system (follow OS) when unset', () => {
    expect(Theme.getPreference()).toBe('system');
  });

  it('round-trips a valid preference', () => {
    Theme.setPreference('system');
    expect(window.localStorage.getItem('theme')).toBe('system');
    expect(Theme.getPreference()).toBe('system');
  });

  it('ignores an invalid stored value, falling back to the default', () => {
    window.localStorage.setItem('theme', 'solarized');
    expect(Theme.getPreference()).toBe('system');
  });
});

describe('resolvePreference / applyResolved (browser)', () => {
  it('resolves system against matchMedia', () => {
    const mm = installMatchMedia();
    Theme.setPreference('system');
    mm.setDark(true);
    expect(Theme.resolvePreference()).toBe('dark');
    mm.setDark(false);
    expect(Theme.resolvePreference()).toBe('light');
  });

  it('writes the resolved theme to data-theme', () => {
    installMatchMedia();
    expect(Theme.applyResolved('dark')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('setup (browser wiring)', () => {
  function addButton() {
    const btn = document.createElement('button');
    btn.id = 'theme-toggle';
    document.body.appendChild(btn);
    return btn;
  }

  it('applies the stored preference and paints the button on init', () => {
    const mm = installMatchMedia();
    mm.setDark(true);
    Theme.setPreference('system');
    const btn = addButton();
    const onChange = vi.fn();

    Theme.setup({ onChange });

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(btn.getAttribute('aria-label')).toBe('Theme: System (click for Light)');
    expect(btn.innerHTML).toContain('<svg');
    expect(onChange).toHaveBeenCalledWith('dark', 'system');
  });

  it('cycles the preference and persists on click', () => {
    installMatchMedia();
    Theme.setPreference('light'); // known starting point, independent of default
    const btn = addButton();
    const onChange = vi.fn();
    Theme.setup({ onChange });

    btn.click();
    expect(window.localStorage.getItem('theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(onChange).toHaveBeenLastCalledWith('dark', 'dark');

    btn.click();
    expect(window.localStorage.getItem('theme')).toBe('system');

    btn.click();
    expect(window.localStorage.getItem('theme')).toBe('light');
  });

  it('follows OS changes only while preference is system', () => {
    const mm = installMatchMedia();
    const onChange = vi.fn();
    Theme.setPreference('system');
    const btn = addButton();
    Theme.setup({ onChange });

    mm.setDark(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(onChange).toHaveBeenLastCalledWith('dark', 'system');

    // Toggle away from system (system → light). OS changes must no longer
    // override the now-explicit preference.
    btn.click();
    expect(Theme.getPreference()).toBe('light');
    onChange.mockClear();
    mm.setDark(false);
    mm.setDark(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('keeps cycling to system even if localStorage writes fail', () => {
    installMatchMedia();
    const btn = addButton();
    Theme.setPreference('light'); // real write, so setup starts at a known light
    // Now simulate a storage backend that silently drops subsequent writes.
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {});
    Theme.setup({});

    btn.click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    btn.click(); // must reach system despite persistence failing
    expect(btn.getAttribute('aria-label')).toBe('Theme: System (click for Light)');
  });

  it('dispose removes the OS-change listener', () => {
    const mm = installMatchMedia();
    addButton();
    const dispose = Theme.setup({});
    expect(mm.listenerCount()).toBe(1);
    dispose();
    expect(mm.listenerCount()).toBe(0);
  });

  it('works without a toggle button present', () => {
    installMatchMedia();
    Theme.setPreference('dark');
    expect(() => Theme.setup({})).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
