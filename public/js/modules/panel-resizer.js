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
      max: 600,
      default: 320,
      storageKey: 'ai-panel-width',
      cssVar: '--ai-panel-width'
    },
    'chat-panel': {
      min: 320,
      max: 800,
      default: 420,
      storageKey: 'chat-panel-width',
      cssVar: '--chat-panel-width'
    }
  };

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

    // Use event delegation for resize handles (supports dynamically created panels)
    document.addEventListener('mousedown', onMouseDown);

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
        if (width >= config.min && width <= config.max) {
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

    // Clamp to min/max
    const clampedWidth = Math.max(config.min, Math.min(config.max, width));

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
    let panelEl;
    if (panelName === 'sidebar') {
      panelEl = document.getElementById('files-sidebar');
    } else if (panelName === 'ai-panel') {
      panelEl = document.getElementById('ai-panel');
    } else if (panelName === 'chat-panel') {
      panelEl = document.getElementById('chat-panel');
    }

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

    const config = CONFIG[currentPanel];
    if (!config) return;

    // Calculate delta based on panel position
    // For sidebar (left panel): moving right increases width
    // For ai-panel and chat-panel (right panels): moving left increases width
    let delta;
    if (currentPanel === 'sidebar') {
      delta = e.clientX - startX;
    } else {
      // Right-side panels (ai-panel, chat-panel)
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
    if (currentPanel) {
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
      if (width >= config.min && width <= config.max) {
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
