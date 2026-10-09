// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for PanelGroup's docked-vs-floating (overlay drawer) decision.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { PanelGroup } = require('../../public/js/components/PanelGroup.js');
// Real PanelResizer (sets window.PanelResizer) supplies the docked sidebar width
require('../../public/js/modules/panel-resizer.js');

describe('PanelGroup.shouldOverlay', () => {
  const MIN = PanelGroup.MIN_DOCKED_DIFF_WIDTH;

  it('always floats on a slim viewport', () => {
    expect(PanelGroup.shouldOverlay({
      slimViewport: true, layoutWidth: 850, dockedSidebarWidth: 0, groupWidth: 0
    })).toBe(true);
  });

  it('docks when nothing is visible', () => {
    expect(PanelGroup.shouldOverlay({
      slimViewport: false, layoutWidth: 950, dockedSidebarWidth: 0, groupWidth: 0
    })).toBe(false);
  });

  it('docks when the layout has not been measured yet', () => {
    expect(PanelGroup.shouldOverlay({
      slimViewport: false, layoutWidth: 0, dockedSidebarWidth: 0, groupWidth: 720
    })).toBe(false);
  });

  it('floats when docking would squeeze the diff below the minimum', () => {
    // 901px, Review (320) + Chat (400) side by side: diff would be 181px
    expect(PanelGroup.shouldOverlay({
      slimViewport: false, layoutWidth: 901, dockedSidebarWidth: 0, groupWidth: 720
    })).toBe(true);
  });

  it('docks when the diff keeps exactly the minimum width', () => {
    expect(PanelGroup.shouldOverlay({
      slimViewport: false, layoutWidth: 720 + MIN, dockedSidebarWidth: 0, groupWidth: 720
    })).toBe(false);
  });

  it('accounts for the docked file navigator', () => {
    // Just past the 1200px breakpoint the sidebar docks again (260px)
    expect(PanelGroup.shouldOverlay({
      slimViewport: false, layoutWidth: 1201, dockedSidebarWidth: 260, groupWidth: 720
    })).toBe(true);
    // ...but a collapsed sidebar leaves plenty of room
    expect(PanelGroup.shouldOverlay({
      slimViewport: false, layoutWidth: 1201, dockedSidebarWidth: 0, groupWidth: 720
    })).toBe(false);
  });

  it('keeps the default 1280px layout (navigator + both panels) docked', () => {
    expect(PanelGroup.shouldOverlay({
      slimViewport: false, layoutWidth: 1280, dockedSidebarWidth: 260, groupWidth: 720
    })).toBe(false);
  });

  it('treats a missing sidebar width as 0', () => {
    expect(PanelGroup.shouldOverlay({
      slimViewport: false, layoutWidth: 1000, dockedSidebarWidth: undefined, groupWidth: 320
    })).toBe(false);
  });
});

describe('PanelGroup.shouldStack', () => {
  const MINS = { aiMin: 200, chatMin: 300 };

  it('keeps side by side when both panels fit at full width', () => {
    expect(PanelGroup.shouldStack({ availableWidth: 850, aiWidth: 320, chatWidth: 400, ...MINS })).toBe(false);
  });

  it('keeps side by side when shrinking still respects both minimums', () => {
    // 600 / 720: Review 267, Chat 333
    expect(PanelGroup.shouldStack({ availableWidth: 600, aiWidth: 320, chatWidth: 400, ...MINS })).toBe(false);
  });

  it('stacks when a panel would shrink below its minimum', () => {
    // 360 / 720: Review 160 (< 200), Chat 200 (< 300)
    expect(PanelGroup.shouldStack({ availableWidth: 360, aiWidth: 320, chatWidth: 400, ...MINS })).toBe(true);
    // Only Chat drops below its minimum
    expect(PanelGroup.shouldStack({ availableWidth: 520, aiWidth: 320, chatWidth: 400, ...MINS })).toBe(true);
  });

  it('never stacks a single panel or an unmeasured layout', () => {
    expect(PanelGroup.shouldStack({ availableWidth: 300, aiWidth: 320, chatWidth: 0, ...MINS })).toBe(false);
    expect(PanelGroup.shouldStack({ availableWidth: 300, aiWidth: 0, chatWidth: 400, ...MINS })).toBe(false);
    expect(PanelGroup.shouldStack({ availableWidth: 0, aiWidth: 320, chatWidth: 400, ...MINS })).toBe(false);
  });
});

describe('PanelGroup._updateRightPanelGroupWidth', () => {
  let group;
  let layout;

  /**
   * Build a PanelGroup without its constructor (which wires the whole page).
   */
  function makePanelGroup({ layoutWidth, slim = false, review = true, chat = true, layoutName = 'h-review-chat' }) {
    document.body.innerHTML = '<div class="main-layout"><div id="right-panel-group" class="right-panel-group"></div></div>';
    layout = document.querySelector('.main-layout');
    Object.defineProperty(layout, 'clientWidth', { configurable: true, value: layoutWidth });
    group = Object.create(PanelGroup.prototype);
    group.groupEl = document.getElementById('right-panel-group');
    group._reviewVisible = review;
    group._chatVisible = chat;
    group._layout = layoutName;
    // pr.css sets this flag below its slim breakpoint
    document.documentElement.style.setProperty('--right-panel-group-overlay-only', slim ? '1' : '0');
    return group;
  }

  beforeEach(() => {
    document.documentElement.removeAttribute('style');
    document.documentElement.style.setProperty('--ai-panel-width', '320px');
    document.documentElement.style.setProperty('--chat-panel-width', '400px');
    document.documentElement.style.setProperty('--sidebar-width', '0px');
  });

  afterEach(() => {
    document.documentElement.removeAttribute('style');
    document.body.innerHTML = '';
  });

  const rootVar = (name) => document.documentElement.style.getPropertyValue(name);

  it('docks and reserves the summed width when there is room', () => {
    makePanelGroup({ layoutWidth: 1400 })._updateRightPanelGroupWidth();
    expect(group.groupEl.classList.contains('right-panel-group--overlay')).toBe(false);
    expect(rootVar('--right-panel-group-width')).toBe('720px');
  });

  it('floats and reserves no width when docking would squeeze the diff', () => {
    makePanelGroup({ layoutWidth: 950 })._updateRightPanelGroupWidth();
    expect(group.groupEl.classList.contains('right-panel-group--overlay')).toBe(true);
    expect(rootVar('--right-panel-group-width')).toBe('0px');
  });

  it('floats on a slim viewport even with room to spare', () => {
    makePanelGroup({ layoutWidth: 850, slim: true, chat: false })._updateRightPanelGroupWidth();
    expect(group.groupEl.classList.contains('right-panel-group--overlay')).toBe(true);
    expect(rootVar('--right-panel-group-width')).toBe('0px');
  });

  it('uses the wider panel (not the sum) for vertical layouts', () => {
    // 950 - 400 = 550 of diff: docks, where side by side (720) would float
    makePanelGroup({ layoutWidth: 950, layoutName: 'v-review-chat' })._updateRightPanelGroupWidth();
    expect(group.groupEl.classList.contains('right-panel-group--overlay')).toBe(false);
    expect(rootVar('--right-panel-group-width')).toBe('400px');
  });

  it('subtracts the docked file navigator width', () => {
    document.documentElement.style.setProperty('--sidebar-width', '260px');
    // 1201 - 260 - 720 = 221px of diff
    makePanelGroup({ layoutWidth: 1201 })._updateRightPanelGroupWidth();
    expect(group.groupEl.classList.contains('right-panel-group--overlay')).toBe(true);
  });

  const layoutClass = () => [...group.groupEl.classList].find((c) => c.startsWith('layout-'));

  it('applies the chosen layout class', () => {
    makePanelGroup({ layoutWidth: 1400 })._updateRightPanelGroupWidth();
    expect(layoutClass()).toBe('layout-h-review-chat');
  });

  it('stacks side-by-side panels in a drawer too narrow for them, keeping the chosen layout', () => {
    makePanelGroup({ layoutWidth: 360, slim: true })._updateRightPanelGroupWidth();
    expect(layoutClass()).toBe('layout-v-review-chat');
    expect(group._layout).toBe('h-review-chat');
  });

  it('keeps the panel order when stacking', () => {
    makePanelGroup({ layoutWidth: 360, slim: true, layoutName: 'h-chat-review' })._updateRightPanelGroupWidth();
    expect(layoutClass()).toBe('layout-v-chat-review');
  });

  it('does not stack while docked, or with a single panel', () => {
    makePanelGroup({ layoutWidth: 1400 })._updateRightPanelGroupWidth();
    expect(layoutClass()).toBe('layout-h-review-chat');
    makePanelGroup({ layoutWidth: 360, slim: true, chat: false })._updateRightPanelGroupWidth();
    expect(layoutClass()).toBe('layout-h-review-chat');
  });

  it('goes back to side by side once the drawer is wide enough', () => {
    makePanelGroup({ layoutWidth: 360, slim: true })._updateRightPanelGroupWidth();
    expect(layoutClass()).toBe('layout-v-review-chat');
    Object.defineProperty(layout, 'clientWidth', { configurable: true, value: 850 });
    group._updateRightPanelGroupWidth();
    expect(layoutClass()).toBe('layout-h-review-chat');
  });

  describe('layout popover options', () => {
    const popoverState = () => [...document.querySelectorAll('.layout-popover__thumb')].map((t) => ({
      layout: t.dataset.layout,
      shown: t.style.display !== 'none',
      active: t.classList.contains('layout-popover__thumb--active')
    }));
    const shownLayouts = () => popoverState().filter((t) => t.shown).map((t) => t.layout);
    const activeLayout = () => popoverState().find((t) => t.active)?.layout;

    function withPopover(opts) {
      makePanelGroup(opts);
      group._renderPopover();
      group._updateRightPanelGroupWidth();
    }

    it('offers every layout when the panels fit side by side', () => {
      withPopover({ layoutWidth: 850, slim: true });
      expect(shownLayouts()).toEqual(PanelGroup.LAYOUTS);
      expect(activeLayout()).toBe('h-review-chat');
    });

    it('hides the side-by-side layouts and marks the stacked one while forced to stack', () => {
      withPopover({ layoutWidth: 360, slim: true });
      expect(shownLayouts()).toEqual(['v-review-chat', 'v-chat-review']);
      expect(activeLayout()).toBe('v-review-chat');
    });

    it('hides them for a chosen vertical layout too', () => {
      withPopover({ layoutWidth: 360, slim: true, layoutName: 'v-chat-review' });
      expect(shownLayouts()).toEqual(['v-review-chat', 'v-chat-review']);
      expect(activeLayout()).toBe('v-chat-review');
    });

    it('brings the side-by-side layouts back once there is room', () => {
      withPopover({ layoutWidth: 360, slim: true });
      Object.defineProperty(layout, 'clientWidth', { configurable: true, value: 850 });
      group._updateRightPanelGroupWidth();
      expect(shownLayouts()).toEqual(PanelGroup.LAYOUTS);
      expect(activeLayout()).toBe('h-review-chat');
    });
  });

  it('returns to docked once there is room again', () => {
    makePanelGroup({ layoutWidth: 950 })._updateRightPanelGroupWidth();
    expect(group.groupEl.classList.contains('right-panel-group--overlay')).toBe(true);

    Object.defineProperty(layout, 'clientWidth', { configurable: true, value: 1400 });
    group._updateRightPanelGroupWidth();
    expect(group.groupEl.classList.contains('right-panel-group--overlay')).toBe(false);
    expect(rootVar('--right-panel-group-width')).toBe('720px');
  });
});
