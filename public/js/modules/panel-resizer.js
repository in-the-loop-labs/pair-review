// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Panel Resizer Module
 * Handles drag-to-resize functionality for the sidebar and AI panel
 */

window.PanelResizer = (function() {
  'use strict';

  // Configuration
  const CONFIG = {
    sidebar: {
      min: 150,
      max: 400,
      default: 260,
      storageKey: 'sidebar-width',
      cssVar: '--sidebar-width'
    },
    'ai-panel': {
      min: 200,
      max: null, // dynamic — computed from viewport in getEffectiveMax()
      default: 320,
      storageKey: 'ai-panel-width',
      cssVar: '--ai-panel-width'
    }
    // Note: chat-panel resize is handled by ChatPanel itself (see ChatPanel._bindResizeEvents)
  };

  // panel-group is a virtual panel used by the vertical-layout group resize handle.
  // In vertical mode the group width is `max(--ai-panel-width, --chat-panel-width)`,
  // so dragging the group handle must update BOTH CSS vars in tandem.
  //
  // Built lazily because ChatPanel.RESIZE_CONFIG is defined after this IIFE runs.
  let _panelGroupConfig = null;
  function getPanelGroupConfig() {
    if (!_panelGroupConfig) {
      const aiCfg = CONFIG['ai-panel'];
      // ChatPanel.RESIZE_CONFIG is the canonical source for chat-panel sizing.
      const chatCfg = window.ChatPanel?.RESIZE_CONFIG
        ?? { cssVar: '--chat-panel-width', storageKey: 'chat-panel-width', default: 400, min: 300 };
      const panels = [
        { cssVar: aiCfg.cssVar, storageKey: aiCfg.storageKey, default: aiCfg.default },
        { cssVar: chatCfg.cssVar, storageKey: chatCfg.storageKey, default: chatCfg.default }
      ];
      _panelGroupConfig = {
        min: Math.max(aiCfg.min, chatCfg.min),
        panels
      };
    }
    return _panelGroupConfig;
  }

  /**
   * Compute the effective max width for a panel.
   * For panels with a static max, returns that value.
   * For panels with max: null, computes a dynamic max from the viewport.
   */
  function getEffectiveMax(panelName) {
    const config = CONFIG[panelName];
    if (!config) return Infinity;
    if (config.max != null) return config.max;
    const sidebarWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || 260;
    return window.innerWidth - sidebarWidth - 100;
  }

  /**
   * Get the current panel-group width (the max of its sub-panel CSS vars).
   * This matches the CSS `max()` expression used in vertical layouts.
   * @returns {number} Current group width in pixels
   */
  function getPanelGroupWidth() {
    let maxWidth = 0;
    for (const p of getPanelGroupConfig().panels) {
      const val = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue(p.cssVar), 10
      ) || p.default;
      if (val > maxWidth) maxWidth = val;
    }
    return maxWidth;
  }

  /**
   * Set the panel-group width by updating ALL sub-panel CSS vars in tandem.
   * @param {number} width - Desired width in pixels
   * @param {boolean} save - Whether to persist to localStorage
   */
  function setPanelGroupWidth(width, save = true) {
    const effectiveMax = getEffectiveMax('ai-panel'); // same viewport constraint
    const clamped = Math.max(getPanelGroupConfig().min, Math.min(effectiveMax, width));

    for (const p of getPanelGroupConfig().panels) {
      document.documentElement.style.setProperty(p.cssVar, `${clamped}px`);
      if (save) {
        localStorage.setItem(p.storageKey, clamped.toString());
      }
    }
  }

  // State
  let isDragging = false;
  let currentPanel = null;
  let startX = 0;
  let startWidth = 0;

  /**
   * Initialize the panel resizer
   */
  function init() {
    // Apply saved widths on load
    applySavedWidths();

    // Set up event listeners for resize handles
    const handles = document.querySelectorAll('.resize-handle');
    handles.forEach(handle => {
      handle.addEventListener('mousedown', onMouseDown);
    });

    // Global mouse events for drag
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  /**
   * Apply saved widths from localStorage
   */
  function applySavedWidths() {
    Object.keys(CONFIG).forEach(panelName => {
      const config = CONFIG[panelName];
      const savedWidth = localStorage.getItem(config.storageKey);

      if (savedWidth) {
        const width = parseInt(savedWidth, 10);
        if (width >= config.min) {
          document.documentElement.style.setProperty(config.cssVar, `${width}px`);
        }
      }
    });
  }

  /**
   * Get the current width of a panel
   * @param {string} panelName - 'sidebar' or 'ai-panel'
   * @returns {number} Current width in pixels
   */
  function getPanelWidth(panelName) {
    const config = CONFIG[panelName];
    if (!config) return 0;

    const cssValue = getComputedStyle(document.documentElement)
      .getPropertyValue(config.cssVar)
      .trim();

    return parseInt(cssValue, 10) || config.default;
  }

  /**
   * Set the width of a panel
   * @param {string} panelName - 'sidebar' or 'ai-panel'
   * @param {number} width - Width in pixels
   * @param {boolean} save - Whether to save to localStorage
   */
  function setPanelWidth(panelName, width, save = true) {
    const config = CONFIG[panelName];
    if (!config) return;

    // Clamp to min/max (max may be dynamic)
    const clampedWidth = Math.max(config.min, Math.min(getEffectiveMax(panelName), width));

    // Apply to CSS
    document.documentElement.style.setProperty(config.cssVar, `${clampedWidth}px`);

    // Save to localStorage
    if (save) {
      localStorage.setItem(config.storageKey, clampedWidth.toString());
    }
  }

  /**
   * Handle mousedown on resize handle
   * @param {MouseEvent} e
   */
  function onMouseDown(e) {
    const handle = e.target.closest('.resize-handle');
    if (!handle) return;

    const panelName = handle.dataset.panel;

    // panel-group: virtual panel — start width is the max of the sub-panels
    if (panelName === 'panel-group') {
      isDragging = true;
      currentPanel = panelName;
      startX = e.clientX;
      startWidth = getPanelGroupWidth();

      handle.classList.add('dragging');
      document.body.classList.add('resizing');
      e.preventDefault();
      return;
    }

    const panelEl = panelName === 'sidebar'
      ? document.getElementById('files-sidebar')
      : panelName === 'chat-panel'
        ? document.querySelector('.chat-panel')
        : document.getElementById('ai-panel');

    // Don't allow resize if panel is collapsed
    if (panelEl && panelEl.classList.contains('collapsed')) {
      return;
    }

    isDragging = true;
    currentPanel = panelName;
    startX = e.clientX;
    startWidth = getPanelWidth(panelName);

    // Add visual feedback
    handle.classList.add('dragging');
    document.body.classList.add('resizing');

    e.preventDefault();
  }

  /**
   * Handle mousemove during drag
   * @param {MouseEvent} e
   */
  function onMouseMove(e) {
    if (!isDragging || !currentPanel) return;

    // panel-group: update both sub-panel CSS vars in tandem
    if (currentPanel === 'panel-group') {
      const delta = startX - e.clientX; // right-side panel: left = wider
      const newWidth = startWidth + delta;
      setPanelGroupWidth(newWidth, false);
      return;
    }

    const config = CONFIG[currentPanel];
    if (!config) return;

    // Calculate delta based on panel position
    // For sidebar (left panel): moving right increases width
    // For ai-panel (right panel): moving left increases width
    let delta;
    if (currentPanel === 'sidebar') {
      delta = e.clientX - startX;
    } else {
      delta = startX - e.clientX;
    }

    const newWidth = startWidth + delta;
    setPanelWidth(currentPanel, newWidth, false); // Don't save during drag
  }

  /**
   * Handle mouseup to end drag
   * @param {MouseEvent} e
   */
  function onMouseUp(e) {
    if (!isDragging) return;

    // Save final width
    if (currentPanel === 'panel-group') {
      // Persist both sub-panel widths
      const finalWidth = getPanelGroupWidth();
      setPanelGroupWidth(finalWidth, true);
    } else if (currentPanel) {
      const finalWidth = getPanelWidth(currentPanel);
      const config = CONFIG[currentPanel];
      if (config) {
        localStorage.setItem(config.storageKey, finalWidth.toString());
      }
    }

    // Clean up
    const handle = document.querySelector('.resize-handle.dragging');
    if (handle) {
      handle.classList.remove('dragging');
    }
    document.body.classList.remove('resizing');

    // Notify PanelGroup so --right-panel-group-width stays in sync
    window.panelGroup?._updateRightPanelGroupWidth();

    isDragging = false;
    currentPanel = null;
    startX = 0;
    startWidth = 0;
  }

  /**
   * Get saved width for a panel (useful for AIPanel integration)
   * @param {string} panelName - 'sidebar' or 'ai-panel'
   * @returns {number|null} Saved width or null if not saved
   */
  function getSavedWidth(panelName) {
    const config = CONFIG[panelName];
    if (!config) return null;

    const saved = localStorage.getItem(config.storageKey);
    if (saved) {
      const width = parseInt(saved, 10);
      if (width >= config.min) {
        return width;
      }
    }
    return null;
  }

  /**
   * Get default width for a panel
   * @param {string} panelName - 'sidebar' or 'ai-panel'
   * @returns {number} Default width
   */
  function getDefaultWidth(panelName) {
    const config = CONFIG[panelName];
    return config ? config.default : 0;
  }

  // Public API
  return {
    init,
    getPanelWidth,
    setPanelWidth,
    getSavedWidth,
    getDefaultWidth,
    applySavedWidths
  };
})();
