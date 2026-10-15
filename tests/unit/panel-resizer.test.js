// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * PanelResizer width limits. Regression: `|| 260` turned a 0 sidebar into 260px.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const PanelResizer = require('../../public/js/modules/panel-resizer.js');

describe('PanelResizer width limits', () => {
  let originalInnerWidth;

  beforeEach(() => {
    originalInnerWidth = window.innerWidth;
    document.documentElement.removeAttribute('style');
  });

  afterEach(() => {
    window.innerWidth = originalInnerWidth;
    document.documentElement.removeAttribute('style');
  });

  describe('getDockedSidebarWidth', () => {
    it('returns the --sidebar-width value', () => {
      document.documentElement.style.setProperty('--sidebar-width', '312px');
      expect(PanelResizer.getDockedSidebarWidth()).toBe(312);
    });

    it('keeps a real 0 (collapsed / slim-screen sidebar) as 0', () => {
      document.documentElement.style.setProperty('--sidebar-width', '0px');
      expect(PanelResizer.getDockedSidebarWidth()).toBe(0);
    });

    it('falls back to the sidebar default when the variable is missing', () => {
      expect(PanelResizer.getDockedSidebarWidth()).toBe(PanelResizer.getDefaultWidth('sidebar'));
    });

    it('falls back to the sidebar default when the variable is unparseable', () => {
      document.documentElement.style.setProperty('--sidebar-width', 'auto');
      expect(PanelResizer.getDockedSidebarWidth()).toBe(PanelResizer.getDefaultWidth('sidebar'));
    });
  });

  describe('getDynamicPanelMax', () => {
    it('subtracts the docked sidebar and a content minimum from the viewport', () => {
      window.innerWidth = 1280;
      document.documentElement.style.setProperty('--sidebar-width', '260px');
      expect(PanelResizer.getDynamicPanelMax()).toBe(1280 - 260 - 100);
    });

    it('does not reserve sidebar space on a slim screen where the sidebar is 0', () => {
      window.innerWidth = 600;
      document.documentElement.style.setProperty('--sidebar-width', '0px');
      // Previously 600 - 260 - 100 = 240, smaller than a 320px panel
      expect(PanelResizer.getDynamicPanelMax()).toBe(500);
    });
  });

  describe('getEffectiveMax', () => {
    it('uses the static max for the sidebar', () => {
      window.innerWidth = 600;
      expect(PanelResizer.getEffectiveMax('sidebar')).toBe(400);
    });

    it('uses the dynamic max for the AI panel', () => {
      window.innerWidth = 900;
      document.documentElement.style.setProperty('--sidebar-width', '0px');
      expect(PanelResizer.getEffectiveMax('ai-panel')).toBe(800);
    });

    it('is unbounded for unknown panels', () => {
      expect(PanelResizer.getEffectiveMax('nope')).toBe(Infinity);
    });
  });

  describe('getMinWidth', () => {
    it('returns each panel\'s configured minimum', () => {
      expect(PanelResizer.getMinWidth('ai-panel')).toBe(200);
      expect(PanelResizer.getMinWidth('sidebar')).toBe(150);
    });

    it('returns 0 for unknown panels', () => {
      expect(PanelResizer.getMinWidth('nope')).toBe(0);
    });
  });

  describe('setPanelWidth (AI panel) on a slim screen', () => {
    it('lets a panel grow past its current width when the sidebar is 0', () => {
      window.innerWidth = 600;
      document.documentElement.style.setProperty('--sidebar-width', '0px');
      PanelResizer.setPanelWidth('ai-panel', 420, false);
      expect(document.documentElement.style.getPropertyValue('--ai-panel-width')).toBe('420px');
    });
  });
});
