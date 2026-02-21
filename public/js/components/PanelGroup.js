// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * PanelGroup - Manages the right panel group layout
 * Coordinates the AI Review panel and Chat panel within a shared flex container.
 * Supports four layout arrangements: horizontal and vertical, each with two orderings.
 * Provides a popover layout picker and keyboard shortcuts for quick switching.
 */

class PanelGroup {
  static LAYOUTS = ['h-review-chat', 'h-chat-review', 'v-review-chat', 'v-chat-review'];
  static STORAGE_KEY = 'panel-group-layout';
  static CHAT_VISIBLE_KEY = 'panel-group-chat-visible';
  static V_RATIO_KEY = 'panel-group-v-ratio';
  static MIN_PANEL_HEIGHT = 150;

  // Tooltip text for each layout
  static LAYOUT_LABELS = {
    'h-review-chat': 'Review left, Chat right',
    'h-chat-review': 'Chat left, Review right',
    'v-review-chat': 'Review top, Chat bottom',
    'v-chat-review': 'Chat top, Review bottom'
  };

  // SVG icons for popover thumbnails
  static POPOVER_ICONS = {
    sparkle: `<svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
      <path d="M7.53 1.282a.5.5 0 0 1 .94 0l.478 1.306a7.492 7.492 0 0 0 4.464 4.464l1.305.478a.5.5 0 0 1 0 .94l-1.305.478a7.492 7.492 0 0 0-4.464 4.464l-.478 1.305a.5.5 0 0 1-.94 0l-.478-1.305a7.492 7.492 0 0 0-4.464-4.464L1.282 8.47a.5.5 0 0 1 0-.94l1.306-.478a7.492 7.492 0 0 0 4.464-4.464l.478-1.306Z"/>
    </svg>`,
    discussion: `<svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
      <path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/>
    </svg>`
  };

  constructor() {
    // DOM elements
    this.groupEl = document.getElementById('right-panel-group');
    this.chatToggleBtn = document.getElementById('chat-toggle-btn');
    this.layoutToggleBtn = document.getElementById('panel-layout-toggle');

    // State
    this._reviewVisible = !document.getElementById('ai-panel')?.classList.contains('collapsed');
    this._chatVisible = false;
    this._popoverVisible = false;

    // Read persisted layout
    const savedLayout = localStorage.getItem(PanelGroup.STORAGE_KEY);
    this._layout = PanelGroup.LAYOUTS.includes(savedLayout) ? savedLayout : PanelGroup.LAYOUTS[0];

    // Restore direction preferences from localStorage
    const savedLastH = localStorage.getItem('panel-group-last-h');
    this._lastHorizontalLayout = PanelGroup.LAYOUTS.includes(savedLastH) && savedLastH.startsWith('h-')
      ? savedLastH : 'h-review-chat';

    const savedLastV = localStorage.getItem('panel-group-last-v');
    this._lastVerticalLayout = PanelGroup.LAYOUTS.includes(savedLastV) && savedLastV.startsWith('v-')
      ? savedLastV : 'v-review-chat';

    // Create ChatPanel instance
    this.chatPanel = new ChatPanel('chat-panel-container');
    window.chatPanel = this.chatPanel;

    // Create a full-height group resize handle for vertical layouts.
    // Uses data-panel="ai-panel" so the existing PanelResizer picks it up automatically.
    if (this.groupEl) {
      this._groupResizeHandle = document.createElement('div');
      this._groupResizeHandle.className = 'panel-group-resize-handle resize-handle resize-handle-left';
      this._groupResizeHandle.dataset.panel = 'ai-panel';
      this.groupEl.insertBefore(this._groupResizeHandle, this.groupEl.firstChild);
    }

    // Create the vertical resize divider between panels
    this._createVerticalDivider();

    // Render the popover DOM
    this._renderPopover();

    // Apply initial layout
    this._applyLayout(this._layout);

    // Restore chat visibility from last session (only if chat is available)
    const chatState = document.documentElement.getAttribute('data-chat');
    if (chatState === 'available') {
      this._restoreChatFromStorage();
    } else {
      // Chat not available yet — zero out CSS variable so max-width calcs are correct.
      document.documentElement.style.setProperty('--chat-panel-width', '0px');
    }

    // Listen for late chat-state transitions (config fetch may complete after constructor)
    window.addEventListener('chat-state-changed', (e) => {
      const state = e.detail?.state;
      if (state === 'available') {
        this._restoreChatFromStorage();
      } else if (state === 'unavailable' && this.chatToggleBtn) {
        this.chatToggleBtn.title = 'Install and configure Pi to enable chat';
      }
    });

    // Bind events
    this._bindEvents();

    // Initial state update
    this._updateGroupState();
    this._updateLayoutToggleVisibility();
    this._updateRightPanelGroupWidth();

    // Register shortcuts after KeyboardShortcuts is initialized
    requestAnimationFrame(() => this._registerKeyboardShortcuts());
  }

  /**
   * Bind event listeners
   */
  _bindEvents() {
    // Chat toggle button
    if (this.chatToggleBtn) {
      this.chatToggleBtn.addEventListener('click', () => this.toggleChat());
    }

    // Layout toggle button opens popover
    if (this.layoutToggleBtn) {
      this.layoutToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this._popoverVisible) {
          this._hidePopover();
        } else {
          this._showPopover();
        }
      });
    }
  }

  /**
   * Apply a layout arrangement to the panel group
   * @param {string} layout - One of PanelGroup.LAYOUTS
   */
  _applyLayout(layout) {
    if (!this.groupEl) return;

    // Remove all layout classes
    PanelGroup.LAYOUTS.forEach(l => {
      this.groupEl.classList.remove(`layout-${l}`);
    });

    // Add the current layout class
    this.groupEl.classList.add(`layout-${layout}`);
    this._layout = layout;

    // Update direction preferences
    if (layout.startsWith('h-')) {
      this._lastHorizontalLayout = layout;
      localStorage.setItem('panel-group-last-h', layout);
      // Clear explicit heights when switching to horizontal so panels revert to flex defaults
      this._clearVerticalHeights();
    } else {
      this._lastVerticalLayout = layout;
      localStorage.setItem('panel-group-last-v', layout);
      // Restore persisted vertical split ratio
      this._restoreVerticalRatio();
    }

    // Update popover active state and recalculate group width
    this._updatePopoverActiveState();
    this._updateRightPanelGroupWidth();
  }

  /**
   * Render the popover DOM element and append to document.body
   */
  _renderPopover() {
    const popover = document.createElement('div');
    popover.className = 'layout-popover';
    popover.id = 'layout-popover';

    const grid = document.createElement('div');
    grid.className = 'layout-popover__grid';

    PanelGroup.LAYOUTS.forEach((layout, i) => {
      const isHorizontal = layout.startsWith('h-');
      const isReviewFirst = layout.endsWith('-review-chat');

      const btn = document.createElement('button');
      btn.className = 'layout-popover__thumb';
      btn.dataset.layout = layout;
      btn.title = PanelGroup.LAYOUT_LABELS[layout];
      if (layout === this._layout) {
        btn.classList.add('layout-popover__thumb--active');
      }

      // Badge with number
      const badge = document.createElement('span');
      badge.className = 'layout-popover__badge';
      badge.textContent = String(i + 1);

      // Preview container
      const preview = document.createElement('div');
      preview.className = `layout-popover__preview layout-popover__preview--${isHorizontal ? 'h' : 'v'}`;

      // First pane and second pane depend on order
      const firstType = isReviewFirst ? 'review' : 'chat';
      const secondType = isReviewFirst ? 'chat' : 'review';

      const firstPane = document.createElement('div');
      firstPane.className = `layout-popover__pane layout-popover__pane--${firstType}`;
      firstPane.innerHTML = firstType === 'review'
        ? PanelGroup.POPOVER_ICONS.sparkle
        : PanelGroup.POPOVER_ICONS.discussion;

      const secondPane = document.createElement('div');
      secondPane.className = `layout-popover__pane layout-popover__pane--${secondType}`;
      secondPane.innerHTML = secondType === 'review'
        ? PanelGroup.POPOVER_ICONS.sparkle
        : PanelGroup.POPOVER_ICONS.discussion;

      preview.appendChild(firstPane);
      preview.appendChild(secondPane);

      btn.appendChild(badge);
      btn.appendChild(preview);

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._selectLayout(layout);
      });

      grid.appendChild(btn);
    });

    popover.appendChild(grid);
    document.body.appendChild(popover);
    this._popoverEl = popover;
  }

  /**
   * Show the popover positioned below the layout toggle button
   */
  _showPopover() {
    if (!this._popoverEl || !this.layoutToggleBtn) return;

    // Position below the button
    const rect = this.layoutToggleBtn.getBoundingClientRect();
    this._popoverEl.style.top = `${rect.bottom + 4}px`;
    this._popoverEl.style.left = `${rect.left + rect.width / 2}px`;
    this._popoverEl.style.transform = 'translateX(-50%) translateY(-4px)';

    // Update active state before showing
    this._updatePopoverActiveState();

    // Show with animation
    this._popoverEl.classList.add('layout-popover--visible');
    this._popoverVisible = true;

    // Override transform after making visible for animation
    requestAnimationFrame(() => {
      if (this._popoverEl) {
        this._popoverEl.style.transform = 'translateX(-50%) translateY(0)';
      }
    });

    // Click-outside-to-close handler
    this._outsideClickHandler = (e) => {
      if (!this._popoverEl.contains(e.target) && !this.layoutToggleBtn.contains(e.target)) {
        this._hidePopover();
      }
    };
    document.addEventListener('click', this._outsideClickHandler, true);
  }

  /**
   * Hide the popover
   */
  _hidePopover() {
    if (!this._popoverEl) return;

    this._popoverEl.classList.remove('layout-popover--visible');
    this._popoverVisible = false;

    // Remove click-outside handler
    if (this._outsideClickHandler) {
      document.removeEventListener('click', this._outsideClickHandler, true);
      this._outsideClickHandler = null;
    }
  }

  /**
   * Update the --active class on popover thumbnails
   */
  _updatePopoverActiveState() {
    if (!this._popoverEl) return;

    const thumbs = this._popoverEl.querySelectorAll('.layout-popover__thumb');
    thumbs.forEach(thumb => {
      thumb.classList.toggle(
        'layout-popover__thumb--active',
        thumb.dataset.layout === this._layout
      );
    });
  }

  /**
   * Select a layout, apply it, persist, update popover, hide popover.
   * Also auto-opens both panels if only one is visible.
   * @param {string} layout - One of PanelGroup.LAYOUTS
   */
  _selectLayout(layout) {
    this._ensureBothPanelsVisible();
    this._applyLayout(layout);
    localStorage.setItem(PanelGroup.STORAGE_KEY, layout);
    this._hidePopover();
  }

  /**
   * Ensure both review and chat panels are visible
   */
  _ensureBothPanelsVisible() {
    if (!this._reviewVisible) {
      window.aiPanel?.expand();
    }
    if (!this._chatVisible && this._isChatAvailable()) {
      this.chatPanel.open();
    }
  }

  /**
   * Register keyboard shortcuts on the global KeyboardShortcuts instance
   */
  _registerKeyboardShortcuts() {
    const ks = window.prManager?.keyboardShortcuts;
    if (!ks) return;

    // Panel visibility
    ks.registerShortcut(['p', 'n'], 'Toggle file navigator', () => this._toggleSidebar());
    ks.registerShortcut(['p', 'r'], 'Toggle Review panel', () => this._toggleReviewPanel());
    ks.registerShortcut(['p', 'c'], 'Toggle Chat panel', () => {
      if (this._isChatAvailable()) this.toggleChat();
    });

    // Direction shortcuts
    ks.registerShortcut(['p', 'h'], 'Horizontal layout', () => this._switchToHorizontal());
    ks.registerShortcut(['p', 'v'], 'Vertical layout', () => this._switchToVertical());
    ks.registerShortcut(['p', 'f'], 'Flip panel order', () => this._flipPanelOrder());

    // Direct layout selection
    PanelGroup.LAYOUTS.forEach((layout, i) => {
      ks.registerShortcut(['p', String(i + 1)], PanelGroup.LAYOUT_LABELS[layout], () => this._selectLayout(layout));
    });

    // Recreate help overlay to include new shortcuts
    ks.createHelpOverlay();
  }

  /**
   * Toggle the file sidebar open/closed
   */
  _toggleSidebar() {
    const sidebar = document.getElementById('files-sidebar');
    if (!sidebar) return;

    const isCollapsed = sidebar.classList.contains('collapsed');
    if (isCollapsed) {
      // Click the expand button in the diff toolbar
      const expandBtn = document.getElementById('sidebar-toggle-collapsed');
      if (expandBtn) expandBtn.click();
    } else {
      // Click the collapse button in the sidebar header
      const collapseBtn = document.getElementById('sidebar-collapse-btn');
      if (collapseBtn) collapseBtn.click();
    }
  }

  /**
   * Toggle the Review (AI) panel
   */
  _toggleReviewPanel() {
    window.aiPanel?.toggle();
  }

  /**
   * Switch to horizontal layout, using the last-used horizontal arrangement
   */
  _switchToHorizontal() {
    this._ensureBothPanelsVisible();
    const layout = this._lastHorizontalLayout || 'h-review-chat';
    this._applyLayout(layout);
    localStorage.setItem(PanelGroup.STORAGE_KEY, layout);
  }

  /**
   * Switch to vertical layout, using the last-used vertical arrangement
   */
  _switchToVertical() {
    this._ensureBothPanelsVisible();
    const layout = this._lastVerticalLayout || 'v-review-chat';
    this._applyLayout(layout);
    localStorage.setItem(PanelGroup.STORAGE_KEY, layout);
  }

  /**
   * Flip the panel order within the current direction
   * e.g. h-review-chat -> h-chat-review, v-chat-review -> v-review-chat
   */
  _flipPanelOrder() {
    this._ensureBothPanelsVisible();
    let newLayout;
    if (this._layout.endsWith('-review-chat')) {
      newLayout = this._layout.replace('-review-chat', '-chat-review');
    } else {
      newLayout = this._layout.replace('-chat-review', '-review-chat');
    }
    this._applyLayout(newLayout);
    localStorage.setItem(PanelGroup.STORAGE_KEY, newLayout);
  }

  /**
   * Check if chat is currently available (data-chat="available")
   * @returns {boolean}
   */
  _isChatAvailable() {
    return document.documentElement.getAttribute('data-chat') === 'available';
  }

  /**
   * Restore chat visibility from localStorage (called when chat becomes available)
   */
  _restoreChatFromStorage() {
    const savedChatVisible = localStorage.getItem(PanelGroup.CHAT_VISIBLE_KEY);
    if (savedChatVisible === 'true') {
      this._chatVisible = true;
      this.chatPanel.open({ suppressFocus: true });
      if (this.chatToggleBtn) {
        this.chatToggleBtn.classList.add('active');
      }
    } else {
      document.documentElement.style.setProperty('--chat-panel-width', '0px');
    }
    this._updateGroupState();
    this._updateLayoutToggleVisibility();
    this._updateRightPanelGroupWidth();
  }

  /**
   * Toggle chat panel visibility
   */
  toggleChat() {
    if (!this._isChatAvailable()) return;
    if (this._chatVisible) {
      this.chatPanel.close();
    } else {
      this.chatPanel.open();
    }
  }

  /**
   * Ensure chat is visible (for external callers like "Ask about this")
   * @param {Object} [options] - Options to pass to ChatPanel.open()
   */
  showChat(options) {
    if (!this._isChatAvailable()) return;
    if (!this._chatVisible) {
      this.chatPanel.open(options);
    } else if (options) {
      // Already visible, but re-open with new context
      this.chatPanel.open(options);
    }
  }

  /**
   * Called by ChatPanel when it opens or closes
   * @param {boolean} visible
   */
  _onChatVisibilityChanged(visible) {
    this._chatVisible = visible;

    // Update toolbar button active state
    if (this.chatToggleBtn) {
      this.chatToggleBtn.classList.toggle('active', visible);
    }

    // Persist chat visibility
    localStorage.setItem(PanelGroup.CHAT_VISIBLE_KEY, visible ? 'true' : 'false');

    // Clear inline flex heights so the remaining panel fills the space
    if (this._layout.startsWith('v-')) {
      this._clearVerticalHeights();
    }

    this._updateGroupState();
    this._updateLayoutToggleVisibility();
    this._updateRightPanelGroupWidth();
  }

  /**
   * Called by AIPanel when it collapses or expands
   * @param {boolean} visible
   */
  _onReviewVisibilityChanged(visible) {
    this._reviewVisible = visible;

    // Clear inline flex heights so the remaining panel fills the space
    if (this._layout.startsWith('v-')) {
      this._clearVerticalHeights();
    }

    this._updateGroupState();
    this._updateLayoutToggleVisibility();
    this._updateRightPanelGroupWidth();
  }

  /**
   * Update the group-collapsed class based on panel visibility
   */
  _updateGroupState() {
    if (!this.groupEl) return;

    const bothHidden = !this._reviewVisible && !this._chatVisible;
    this.groupEl.classList.toggle('group-collapsed', bothHidden);
  }

  /**
   * Compute and set --right-panel-group-width based on current layout and panel visibility.
   * In horizontal layouts, the group width is the SUM of visible panels.
   * In vertical layouts, the group width is the MAX of visible panels.
   * This single variable is used by max-width calcs on .ai-suggestion and .user-comment.
   */
  _updateRightPanelGroupWidth() {
    const aiWidth = this._reviewVisible
      ? parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ai-panel-width'), 10) || 0
      : 0;
    const chatWidth = this._chatVisible
      ? parseInt(getComputedStyle(document.documentElement).getPropertyValue('--chat-panel-width'), 10) || 0
      : 0;

    const isVertical = this._layout.startsWith('v-');
    const groupWidth = isVertical
      ? Math.max(aiWidth, chatWidth)
      : aiWidth + chatWidth;

    document.documentElement.style.setProperty('--right-panel-group-width', `${groupWidth}px`);
  }

  /**
   * Show/hide the layout toggle button.
   * Only shown when both panels are visible (layout switching only matters with two panels).
   */
  _updateLayoutToggleVisibility() {
    if (!this.layoutToggleBtn) return;

    const bothVisible = this._reviewVisible && this._chatVisible;
    this.layoutToggleBtn.style.display = bothVisible ? '' : 'none';
  }

  // ---------------------------------------------------------------------------
  // Vertical resize divider
  // ---------------------------------------------------------------------------

  /**
   * Create the vertical resize divider element and insert it into the panel group.
   * The divider sits between the AI panel and chat panel container in the DOM.
   * CSS order rules position it correctly for each layout arrangement.
   */
  _createVerticalDivider() {
    if (!this.groupEl) return;

    this._dividerEl = document.createElement('div');
    this._dividerEl.className = 'panel-group-divider';
    this._dividerEl.title = 'Drag to resize';

    // Insert between the ai-panel aside and chat-panel-container div
    const chatContainer = document.getElementById('chat-panel-container');
    if (chatContainer) {
      this.groupEl.insertBefore(this._dividerEl, chatContainer);
    } else {
      this.groupEl.appendChild(this._dividerEl);
    }

    this._bindVerticalResizeEvents();
  }

  /**
   * Bind mousedown/mousemove/mouseup drag events on the vertical divider.
   * Adjusts the flex-basis of both panels to resize the vertical split.
   */
  _bindVerticalResizeEvents() {
    if (!this._dividerEl) return;

    let startY = 0;
    let startTopHeight = 0;
    let startBottomHeight = 0;

    const onMouseMove = (e) => {
      const deltaY = e.clientY - startY;
      const totalHeight = startTopHeight + startBottomHeight;
      const minH = PanelGroup.MIN_PANEL_HEIGHT;

      let newTopHeight = startTopHeight + deltaY;
      let newBottomHeight = startBottomHeight - deltaY;

      // Enforce minimum heights
      if (newTopHeight < minH) {
        newTopHeight = minH;
        newBottomHeight = totalHeight - minH;
      } else if (newBottomHeight < minH) {
        newBottomHeight = minH;
        newTopHeight = totalHeight - minH;
      }

      const { topPanel, bottomPanel } = this._getOrderedPanels();
      if (topPanel) topPanel.style.flex = `0 0 ${newTopHeight}px`;
      if (bottomPanel) bottomPanel.style.flex = `0 0 ${newBottomHeight}px`;
    };

    const onMouseUp = () => {
      this._dividerEl.classList.remove('dragging');
      document.body.classList.remove('resizing');

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      // Persist the ratio (top panel proportion of total height)
      const { topPanel, bottomPanel } = this._getOrderedPanels();
      if (topPanel && bottomPanel) {
        const topH = topPanel.getBoundingClientRect().height;
        const bottomH = bottomPanel.getBoundingClientRect().height;
        const ratio = topH / (topH + bottomH);
        localStorage.setItem(PanelGroup.V_RATIO_KEY, ratio.toFixed(4));
      }
    };

    this._dividerEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;

      const { topPanel, bottomPanel } = this._getOrderedPanels();
      if (!topPanel || !bottomPanel) return;

      startTopHeight = topPanel.getBoundingClientRect().height;
      startBottomHeight = bottomPanel.getBoundingClientRect().height;

      this._dividerEl.classList.add('dragging');
      document.body.classList.add('resizing');

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  /**
   * Get the two panels in visual order (top panel first, bottom panel second)
   * based on the current vertical layout arrangement.
   * @returns {{ topPanel: HTMLElement|null, bottomPanel: HTMLElement|null }}
   */
  _getOrderedPanels() {
    const aiPanel = document.getElementById('ai-panel');
    const chatPanel = this.groupEl?.querySelector('.chat-panel');

    if (!aiPanel || !chatPanel) return { topPanel: null, bottomPanel: null };

    if (this._layout === 'v-review-chat') {
      return { topPanel: aiPanel, bottomPanel: chatPanel };
    }
    // v-chat-review
    return { topPanel: chatPanel, bottomPanel: aiPanel };
  }

  /**
   * Restore the persisted vertical split ratio from localStorage.
   * Applied when switching to a vertical layout.
   */
  _restoreVerticalRatio() {
    const saved = localStorage.getItem(PanelGroup.V_RATIO_KEY);
    if (!saved) return;

    const ratio = parseFloat(saved);
    if (isNaN(ratio) || ratio <= 0 || ratio >= 1) return;

    // Defer to next frame so flex container has settled
    requestAnimationFrame(() => {
      if (!this.groupEl || !this._layout.startsWith('v-')) return;

      const groupHeight = this.groupEl.clientHeight;
      const dividerHeight = this._dividerEl ? this._dividerEl.offsetHeight : 6;
      const available = groupHeight - dividerHeight;
      if (available <= 0) return;

      const minH = PanelGroup.MIN_PANEL_HEIGHT;
      let topHeight = Math.round(available * ratio);
      let bottomHeight = available - topHeight;

      // Enforce minimums
      if (topHeight < minH) { topHeight = minH; bottomHeight = available - minH; }
      if (bottomHeight < minH) { bottomHeight = minH; topHeight = available - minH; }

      const { topPanel, bottomPanel } = this._getOrderedPanels();
      if (topPanel) topPanel.style.flex = `0 0 ${topHeight}px`;
      if (bottomPanel) bottomPanel.style.flex = `0 0 ${bottomHeight}px`;
    });
  }

  /**
   * Clear explicit flex heights set during vertical resize.
   * Called when switching back to horizontal layout so panels revert to
   * their normal width-based flex behavior.
   */
  _clearVerticalHeights() {
    const aiPanel = document.getElementById('ai-panel');
    const chatPanel = this.groupEl?.querySelector('.chat-panel');
    if (aiPanel) aiPanel.style.flex = '';
    if (chatPanel) chatPanel.style.flex = '';
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.panelGroup = new PanelGroup();
});

// Export for CommonJS testing environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PanelGroup };
}
