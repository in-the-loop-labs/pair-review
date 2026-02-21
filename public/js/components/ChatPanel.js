// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * ChatPanel - AI chat sidebar component
 * Provides a sliding chat panel for conversing with AI about the current review.
 * Works in both PR mode and Local mode.
 */

const DISMISS_ICON = `<svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>`;

class ChatPanel {
  constructor(containerId) {
    this.containerId = containerId;
    this.container = document.getElementById(containerId);
    this.currentSessionId = null;
    this.reviewId = null;
    this.isOpen = false;
    this.isStreaming = false;
    this.eventSource = null;
    this._sseReconnectTimer = null;
    this.messages = [];
    this._streamingContent = '';
    this._pendingContext = [];
    this._pendingContextData = [];
    this._contextSource = null;   // 'suggestion' or 'user' — set when opened with context
    this._contextItemId = null;   // suggestion ID or comment ID from context
    this._pendingActionContext = null;  // { type, itemId } — set by action button handlers, consumed by sendMessage
    this._resizeConfig = { min: 300, max: 800, default: 400, storageKey: 'chat-panel-width' };
    this._analysisContextRemoved = false;
    this._sessionAnalysisRunId = null; // tracks which AI run ID's context is loaded in the current session
    this._openPromise = null; // concurrency guard for open()

    this._render();
    this._bindEvents();
    this._initContextTooltip();
  }

  /**
   * Render the chat panel DOM structure into the container
   */
  _render() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div id="chat-panel" class="chat-panel chat-panel--closed">
        <div class="chat-panel__resize-handle" title="Drag to resize"></div>
        <div class="chat-panel__header">
          <div class="chat-panel__session-picker">
            <button class="chat-panel__session-picker-btn" title="Switch conversation">
              <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                <path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/>
              </svg>
              <span class="chat-panel__title-text">Chat &middot; Pi</span>
              <span class="chat-panel__chevron-sep">&middot;</span>
              <svg class="chat-panel__chevron" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                <path d="m.427 1.927 1.215 1.215a8.002 8.002 0 1 1-1.6 5.685.75.75 0 1 1 1.493-.154 6.5 6.5 0 1 0 1.18-4.458l1.358 1.358A.25.25 0 0 1 3.896 6H.25A.25.25 0 0 1 0 5.75V2.104a.25.25 0 0 1 .427-.177ZM7.75 4a.75.75 0 0 1 .75.75v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5A.75.75 0 0 1 7.75 4Z"/>
              </svg>
            </button>
            <div class="chat-panel__session-dropdown" style="display: none;"></div>
          </div>
          <div class="chat-panel__actions">
            <button class="chat-panel__new-btn" title="New conversation">
              <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/>
              </svg>
            </button>
            <button class="chat-panel__close-btn" title="Close">
              <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="chat-panel__messages" id="chat-messages">
          <div class="chat-panel__empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
              <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
            </svg>
            <p>Ask questions about this review, or the changes</p>
          </div>
        </div>
        <div class="chat-panel__action-bar" style="display: none;">
          <button class="chat-panel__action-btn chat-panel__action-btn--adopt" style="display: none;" title="Adopt this suggestion with edits based on the conversation">
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
            </svg>
            Adopt with AI edits
          </button>
          <button class="chat-panel__action-btn chat-panel__action-btn--update" style="display: none;" title="Update the comment based on the conversation">
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
              <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/>
            </svg>
            Update comment
          </button>
          <button class="chat-panel__action-btn chat-panel__action-btn--dismiss-suggestion" style="display: none;" title="Dismiss this AI suggestion">
            ${DISMISS_ICON}
            Dismiss suggestion
          </button>
          <button class="chat-panel__action-btn chat-panel__action-btn--dismiss-comment" style="display: none;" title="Dismiss this comment">
            ${DISMISS_ICON}
            Dismiss comment
          </button>
        </div>
        <div class="chat-panel__input-area">
          <textarea class="chat-panel__input" placeholder="Ask about this review..." rows="1"></textarea>
          <div class="chat-panel__input-footer">
            <span class="chat-panel__input-hint">${typeof navigator !== 'undefined' && navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter to send</span>
            <div class="chat-panel__input-actions">
              <button class="chat-panel__send-btn" title="Send" disabled>
                <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                  <path d="M.989 8 .064 2.68a1.342 1.342 0 0 1 1.85-1.462l13.402 5.744a1.13 1.13 0 0 1 0 2.076L1.913 14.782a1.343 1.343 0 0 1-1.85-1.463L.99 8Zm.603-4.776L2.296 7.25h5.954a.75.75 0 0 1 0 1.5H2.296l-.704 4.026L13.788 8Z"/>
                </svg>
              </button>
              <button class="chat-panel__stop-btn" title="Stop" style="display: none;">
                <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                  <path d="M4.5 2A2.5 2.5 0 0 0 2 4.5v7A2.5 2.5 0 0 0 4.5 14h7a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 11.5 2h-7Z"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Cache element references
    this.panel = this.container.querySelector('#chat-panel');
    this.messagesEl = this.container.querySelector('#chat-messages');
    this.inputEl = this.container.querySelector('.chat-panel__input');
    this.sendBtn = this.container.querySelector('.chat-panel__send-btn');
    this.stopBtn = this.container.querySelector('.chat-panel__stop-btn');
    this.closeBtn = this.container.querySelector('.chat-panel__close-btn');
    this.newBtn = this.container.querySelector('.chat-panel__new-btn');
    this.actionBar = this.container.querySelector('.chat-panel__action-bar');
    this.adoptBtn = this.container.querySelector('.chat-panel__action-btn--adopt');
    this.updateBtn = this.container.querySelector('.chat-panel__action-btn--update');
    this.dismissSuggestionBtn = this.container.querySelector('.chat-panel__action-btn--dismiss-suggestion');
    this.dismissCommentBtn = this.container.querySelector('.chat-panel__action-btn--dismiss-comment');
    this.sessionPickerEl = this.container.querySelector('.chat-panel__session-picker');
    this.sessionPickerBtn = this.container.querySelector('.chat-panel__session-picker-btn');
    this.sessionDropdown = this.container.querySelector('.chat-panel__session-dropdown');
    this.titleTextEl = this.container.querySelector('.chat-panel__title-text');
  }

  /**
   * Bind event listeners
   */
  _bindEvents() {
    if (!this.panel) return;

    // Close button
    this.closeBtn.addEventListener('click', () => this.close());

    // New conversation button
    this.newBtn.addEventListener('click', () => this._startNewConversation());

    // Session picker button
    this.sessionPickerBtn.addEventListener('click', () => this._toggleSessionDropdown());

    // Send button
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    // Stop button
    this.stopBtn.addEventListener('click', () => this._stopAgent());

    // Action buttons
    this.adoptBtn.addEventListener('click', () => this._handleAdoptClick());
    this.updateBtn.addEventListener('click', () => this._handleUpdateClick());
    this.dismissSuggestionBtn.addEventListener('click', () => this._handleDismissSuggestionClick());
    this.dismissCommentBtn.addEventListener('click', () => this._handleDismissCommentClick());

    // Textarea input handling
    this.inputEl.addEventListener('input', () => {
      this._autoResizeTextarea();
      this.sendBtn.disabled = !this.inputEl.value.trim() || this.isStreaming;
    });

    // Keyboard shortcuts
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (this.inputEl.value.trim() && !this.isStreaming) {
          this.sendMessage();
        }
      }
    });

    // Escape: close dropdown if open, stop agent if streaming, blur textarea if focused, otherwise close panel
    this._onKeydown = (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        if (this._isSessionDropdownOpen()) {
          this._hideSessionDropdown();
        } else if (this.isStreaming) {
          this._stopAgent();
        } else if (document.activeElement === this.inputEl) {
          this.inputEl.blur();
        } else {
          this.close();
        }
      }
    };
    document.addEventListener('keydown', this._onKeydown);

    // Chat file link click handler (event delegation)
    this.messagesEl?.addEventListener('click', (e) => {
      const link = e.target.closest('.chat-file-link');
      if (link) {
        e.preventDefault();
        this._handleFileLinkClick(link);
      }
    });

    this._bindResizeEvents();
  }

  /**
   * Bind resize drag events on the left edge handle
   */
  _bindResizeEvents() {
    const handle = this.panel.querySelector('.chat-panel__resize-handle');
    if (!handle) return;

    const { min, max, storageKey } = this._resizeConfig;

    let startX = 0;
    let startWidth = 0;

    const onMouseMove = (e) => {
      // Panel is right-anchored, so dragging left (decreasing clientX) should increase width
      const delta = startX - e.clientX;
      const newWidth = Math.max(min, Math.min(max, startWidth + delta));
      document.documentElement.style.setProperty('--chat-panel-width', newWidth + 'px');
    };

    const onMouseUp = () => {
      // Persist the final width
      const finalWidth = this.panel.getBoundingClientRect().width;
      localStorage.setItem(storageKey, Math.round(finalWidth));

      handle.classList.remove('dragging');
      this.panel.classList.remove('chat-panel--resizing');
      document.body.classList.remove('resizing');

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      // Notify PanelGroup so --right-panel-group-width stays in sync
      window.panelGroup?._updateRightPanelGroupWidth();
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = this.panel.getBoundingClientRect().width;

      handle.classList.add('dragging');
      this.panel.classList.add('chat-panel--resizing');
      document.body.classList.add('resizing');

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  /**
   * Auto-resize textarea based on content.
   * Grows with content up to maxHeight, then switches to scrollable overflow.
   * Shrinks back down when content is deleted.
   */
  _autoResizeTextarea() {
    const el = this.inputEl;
    const maxHeight = 120;

    // Collapse to auto so scrollHeight reflects actual content height
    el.style.height = 'auto';
    el.style.overflowY = 'hidden';

    const contentHeight = el.scrollHeight;
    if (contentHeight > maxHeight) {
      el.style.height = maxHeight + 'px';
      el.style.overflowY = 'auto';
    } else {
      el.style.height = contentHeight + 'px';
    }
  }

  /**
   * Disable chat input and send button (e.g. while reviewId is unavailable).
   * Saves the original placeholder so _enableInput() can restore it.
   */
  _disableInput() {
    this._savedPlaceholder = this.inputEl.placeholder;
    this.inputEl.disabled = true;
    this.inputEl.placeholder = 'Connecting to review\u2026';
    this.sendBtn.disabled = true;
  }

  /**
   * Re-enable chat input and send button after reviewId becomes available.
   * Restores the original placeholder saved by _disableInput().
   */
  _enableInput() {
    this.inputEl.disabled = false;
    this.inputEl.placeholder = this._savedPlaceholder || 'Ask about this review...';
    this._savedPlaceholder = null;
    this.sendBtn.disabled = !this.inputEl.value.trim() || this.isStreaming;
  }

  /**
   * Update the chat panel title with provider and model info.
   * @param {string} [provider='Pi'] - Provider display name
   * @param {string} [model] - Model ID or display name (e.g. 'default', 'multi-model')
   */
  _updateTitle(provider = 'Pi', model) {
    if (!this.titleTextEl) return;
    const modelDisplay = model
      ? model.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      : null;
    const parts = ['Chat', provider];
    if (modelDisplay) parts.push(modelDisplay);
    this.titleTextEl.textContent = parts.join(' \u00b7 ');
  }

  /**
   * Open the chat panel
   * @param {Object} options - Optional context
   * @param {number} options.reviewId - Review ID
   * @param {number} options.suggestionId - Suggestion ID to ask about
   * @param {Object} options.suggestionContext - AI suggestion details for context
   * @param {Object} options.commentContext - User comment details for context
   * @param {string} options.commentContext.commentId - Comment ID
   * @param {string} options.commentContext.body - Comment body text
   * @param {string} options.commentContext.file - File path
   * @param {number} options.commentContext.line_start - Start line number
   * @param {number} options.commentContext.line_end - End line number
   * @param {string} options.commentContext.source - 'user' for user comments
   * @param {boolean} options.commentContext.isFileLevel - True if file-level comment
   */
  async open(options = {}) {
    // Concurrency guard: if a previous open() is still loading MRU / messages,
    // wait for it to finish before proceeding.  This prevents a race where a
    // second open() call sees `currentSessionId` already set (by the first
    // call's _loadMRUSession midway through) and skips MRU loading, causing
    // _ensureAnalysisContext to run before message history is rendered.
    if (this._openPromise) {
      await this._openPromise;
    }

    // Wrap the async body in a tracked promise so subsequent callers can wait
    this._openPromise = this._openInner(options);
    try {
      await this._openPromise;
    } finally {
      this._openPromise = null;
    }
  }

  /**
   * Inner implementation of open(), separated so the concurrency guard in
   * open() can track the full async lifecycle.
   * @param {Object} options - Same options as open()
   */
  async _openInner(options) {
    // Resolve reviewId from options or from prManager
    if (options.reviewId) {
      this.reviewId = options.reviewId;
    } else if (window.prManager?.currentPR?.id) {
      this.reviewId = window.prManager.currentPR.id;
    }

    // Restore persisted width before opening (mirrors AIPanel.expand pattern)
    const { min, max, default: defaultWidth, storageKey } = this._resizeConfig;
    const savedWidth = localStorage.getItem(storageKey);
    if (savedWidth) {
      const width = parseInt(savedWidth, 10);
      if (width >= min && width <= max) {
        document.documentElement.style.setProperty('--chat-panel-width', width + 'px');
      } else {
        document.documentElement.style.setProperty('--chat-panel-width', defaultWidth + 'px');
      }
    } else {
      document.documentElement.style.setProperty('--chat-panel-width', defaultWidth + 'px');
    }

    this.isOpen = true;
    this.panel.classList.remove('chat-panel--closed');
    this.panel.classList.add('chat-panel--open');

    // Ensure SSE is connected (but don't create a session yet — lazy creation)
    this._ensureGlobalSSE();

    // Load MRU session with message history (if any previous sessions exist).
    // Skip when opening with explicit context (suggestion/comment/file) — the
    // user wants a *new* conversation about that item, not to resume the last one.
    const hasExplicitContext = !!(options.suggestionContext || options.commentContext || options.fileContext);
    if (!this.currentSessionId && !hasExplicitContext) {
      await this._loadMRUSession();
    }

    // Ensure analysis context is added on every expand — not just when opening
    // with suggestion/comment context. This detects new analysis runs that
    // completed while the panel was closed and adds them as pending context.
    this._ensureAnalysisContext();

    // If opening with suggestion context, inject it as a context card
    if (options.suggestionContext) {
      this._sendContextMessage(options.suggestionContext);
      this._contextSource = 'suggestion';
      this._contextItemId = options.suggestionId || null;
    } else if (options.commentContext) {
      // If opening with user comment context, inject it as a context card
      this._sendCommentContextMessage(options.commentContext);
      this._contextSource = 'user';
      this._contextItemId = options.commentContext.commentId || null;
    } else if (options.fileContext) {
      // If opening with file context, inject it as a context card
      this._sendFileContextMessage(options.fileContext);
      this._contextSource = 'file';
      this._contextItemId = null;
    }

    // Gate input when reviewId is not yet available (PanelGroup auto-restore race)
    if (!this.reviewId) {
      this._disableInput();
    }

    this._updateActionButtons();
    window.panelGroup?._onChatVisibilityChanged(true);
    if (!options.suppressFocus) {
      this.inputEl.focus();
    }
  }

  /**
   * Close the chat panel
   */
  close() {
    this._hideSessionDropdown();
    // Reset UI streaming state (buttons) but keep isStreaming and _streamingContent
    // intact so the background SSE handler can continue accumulating events.
    this.sendBtn.style.display = '';
    this.stopBtn.style.display = 'none';
    this.sendBtn.disabled = !this.inputEl?.value?.trim();

    this.isOpen = false;
    this.panel.classList.remove('chat-panel--open');
    this.panel.classList.add('chat-panel--closed');
    this._pendingContext = [];
    this._pendingContextData = [];
    this._contextSource = null;
    this._contextItemId = null;
    // Zero out CSS variable so max-width calcs don't reserve space (mirrors AIPanel.collapse)
    document.documentElement.style.setProperty('--chat-panel-width', '0px');
    // Preserve _analysisContextRemoved and _sessionAnalysisRunId across
    // close/reopen so _ensureAnalysisContext can detect NEW runs on the next
    // expand. These are reset by _startNewConversation() or when a new run
    // is detected in _ensureAnalysisContext().
    window.panelGroup?._onChatVisibilityChanged(false);
  }

  /**
   * Toggle panel visibility
   */
  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Start a new conversation (reset session)
   * Preserves any unsent pending context cards and re-adds them to the new conversation.
   */
  async _startNewConversation() {
    this._hideSessionDropdown();
    // 1. Snapshot pending context before clearing (these are unsent context cards)
    const savedContext = this._pendingContext.slice();
    const savedContextData = this._pendingContextData.slice();
    const savedContextSource = this._contextSource;
    const savedContextItemId = this._contextItemId;

    // 2. Clear everything as normal
    this._finalizeStreaming();
    this.currentSessionId = null;
    this.messages = [];
    this._streamingContent = '';
    this._pendingContext = [];
    this._pendingContextData = [];
    this._contextSource = null;
    this._contextItemId = null;
    this._analysisContextRemoved = false;
    this._sessionAnalysisRunId = null;
    this._clearMessages();
    this._updateActionButtons();
    this._updateTitle(); // Reset title for new conversation
    // SSE stays connected — it's multiplexed and will filter by sessionId

    // 3. Re-add analysis context (appears first, handled separately from pending arrays)
    this._ensureAnalysisContext();

    // 4. Re-add saved pending context cards (if any were unsent)
    if (savedContext.length > 0) {
      // Remove empty state since we're about to add context cards
      const emptyState = this.messagesEl.querySelector('.chat-panel__empty');
      if (emptyState) emptyState.remove();

      // Restore context metadata
      this._contextSource = savedContextSource;
      this._contextItemId = savedContextItemId;

      for (let i = 0; i < savedContextData.length; i++) {
        const ctxData = savedContextData[i];
        this._pendingContext.push(savedContext[i]);
        this._pendingContextData.push(ctxData);

        // Render the appropriate card type based on the context data
        if (ctxData.type === 'file') {
          this._addFileContextCard(ctxData, { removable: true });
        } else if (ctxData.type === 'comment') {
          this._addCommentContextCard(ctxData, { removable: true });
        } else if (ctxData.type === 'analysis-run') {
          this._addAnalysisRunContextCard(ctxData, { removable: true });
        } else {
          this._addContextCard(ctxData, { removable: true });
        }
      }

      this._updateActionButtons();
    }
  }

  /**
   * Fetch sessions for the current review.
   * Extracted from _loadMRUSession for reuse by the session picker dropdown.
   * @returns {Promise<Array>} Array of session objects with message_count and first_message
   */
  async _fetchSessions() {
    if (!this.reviewId) return [];
    try {
      const response = await fetch(`/api/review/${this.reviewId}/chat/sessions`);
      if (!response.ok) return [];
      const result = await response.json();
      return result.data?.sessions || [];
    } catch (err) {
      console.warn('[ChatPanel] Failed to fetch sessions:', err);
      return [];
    }
  }

  /**
   * Load the most recently used session for the current review.
   * Picks the first session (MRU) and loads its message history.
   */
  async _loadMRUSession() {
    if (!this.reviewId) return;

    try {
      const sessions = await this._fetchSessions();
      if (sessions.length === 0) return;

      const mru = sessions[0];
      this.currentSessionId = mru.id;
      console.debug('[ChatPanel] Loaded MRU session:', mru.id, 'messages:', mru.message_count);

      if (mru.provider) {
        const providerName = mru.provider.charAt(0).toUpperCase() + mru.provider.slice(1);
        this._updateTitle(providerName, mru.model);
      }

      if (mru.message_count > 0) {
        await this._loadMessageHistory(mru.id);
      }
    } catch (err) {
      console.warn('[ChatPanel] Failed to load MRU session:', err);
    }
  }

  /**
   * Load and render message history for a session.
   * Fetches messages from the API and renders context cards and message bubbles.
   * @param {number} sessionId
   */
  async _loadMessageHistory(sessionId) {
    try {
      const response = await fetch(`/api/chat/session/${sessionId}/messages`);
      if (!response.ok) return;

      const result = await response.json();
      const messages = result.data?.messages || [];
      if (messages.length === 0) return;

      // Remove empty state
      const emptyState = this.messagesEl.querySelector('.chat-panel__empty');
      if (emptyState) emptyState.remove();

      for (const msg of messages) {
        if (msg.type === 'context') {
          // Render context card from stored context data
          try {
            const ctxData = JSON.parse(msg.content);
            if (ctxData.type === 'analysis') {
              this._addAnalysisContextCard(ctxData);
            } else if (ctxData.type === 'file') {
              this._addFileContextCard(ctxData);
            } else if (ctxData.type === 'comment') {
              this._addCommentContextCard(ctxData);
            } else {
              this._addContextCard(ctxData);
            }
          } catch {
            // Not JSON — skip malformed context
          }
        } else if (msg.type === 'message') {
          this.addMessage(msg.role, msg.content, msg.id);
        }
      }
    } catch (err) {
      console.warn('[ChatPanel] Failed to load message history:', err);
    }
  }

  // ── Session picker dropdown ────────────────────────────────────────────

  _isSessionDropdownOpen() {
    return this.sessionDropdown && this.sessionDropdown.style.display !== 'none';
  }

  _toggleSessionDropdown() {
    if (this._isSessionDropdownOpen()) {
      this._hideSessionDropdown();
    } else {
      this._showSessionDropdown();
    }
  }

  async _showSessionDropdown() {
    if (!this.sessionDropdown) return;

    const sessions = await this._fetchSessions();
    this._renderSessionDropdown(sessions);
    this.sessionDropdown.style.display = '';
    this.sessionPickerBtn.classList.add('chat-panel__session-picker-btn--open');

    // Bind outside-click-to-close (one-shot)
    this._outsideClickHandler = (e) => {
      if (!this.sessionPickerEl.contains(e.target)) {
        this._hideSessionDropdown();
      }
    };
    // Use setTimeout so the current click event doesn't immediately trigger close
    setTimeout(() => {
      document.addEventListener('click', this._outsideClickHandler);
    }, 0);
  }

  _hideSessionDropdown() {
    if (!this.sessionDropdown) return;
    this.sessionDropdown.style.display = 'none';
    this.sessionPickerBtn.classList.remove('chat-panel__session-picker-btn--open');
    if (this._outsideClickHandler) {
      document.removeEventListener('click', this._outsideClickHandler);
      this._outsideClickHandler = null;
    }
  }

  _renderSessionDropdown(sessions) {
    if (!this.sessionDropdown) return;

    if (sessions.length === 0) {
      this.sessionDropdown.innerHTML = `
        <div class="chat-panel__session-empty">No conversations yet</div>
      `;
      return;
    }

    const items = sessions.map(s => {
      const isActive = s.id === this.currentSessionId;
      const preview = s.first_message
        ? this._truncate(s.first_message, 60)
        : 'New conversation';
      const timeAgo = this._formatRelativeTime(s.updated_at);

      return `
        <button class="chat-panel__session-item${isActive ? ' chat-panel__session-item--active' : ''}"
                data-session-id="${s.id}">
          <span class="chat-panel__session-preview">${this._escapeHtml(preview)}</span>
          <span class="chat-panel__session-meta">${this._escapeHtml(timeAgo)}</span>
        </button>
      `;
    }).join('');

    this.sessionDropdown.innerHTML = items;

    // Bind click handlers on each item
    this.sessionDropdown.querySelectorAll('.chat-panel__session-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const sessionId = parseInt(btn.dataset.sessionId, 10);
        const sessionData = sessions.find(s => s.id === sessionId);
        if (sessionData) {
          this._switchToSession(sessionId, sessionData);
        }
        this._hideSessionDropdown();
      });
    });
  }

  /**
   * Switch to a different chat session.
   * Tears down current state and loads the target session.
   * @param {number} sessionId - The session ID to switch to
   * @param {Object} sessionData - Session metadata (provider, model, message_count, etc.)
   */
  async _switchToSession(sessionId, sessionData) {
    if (sessionId === this.currentSessionId) return;

    // 1. Finalize any active stream
    this._finalizeStreaming();

    // 2. Reset state
    this.currentSessionId = sessionId;
    this.messages = [];
    this._streamingContent = '';
    this._pendingContext = [];
    this._pendingContextData = [];
    this._contextSource = null;
    this._contextItemId = null;
    this._pendingActionContext = null;
    this._analysisContextRemoved = false;
    this._sessionAnalysisRunId = null;

    // 3. Clear UI
    this._clearMessages();
    this._updateActionButtons();

    // 4. Update title
    if (sessionData.provider) {
      const providerName = sessionData.provider.charAt(0).toUpperCase() + sessionData.provider.slice(1);
      this._updateTitle(providerName, sessionData.model);
    } else {
      this._updateTitle();
    }

    // 5. Load message history
    if (sessionData.message_count > 0) {
      await this._loadMessageHistory(sessionId);
    }

    // 6. Ensure analysis context for the new session
    this._ensureAnalysisContext();
  }

  /**
   * Format a timestamp as relative time (same logic as AnalysisHistoryManager.formatRelativeTime).
   * @param {string} timestamp - ISO or SQLite timestamp
   * @returns {string} Relative time string
   */
  _formatRelativeTime(timestamp) {
    if (!timestamp) return 'Unknown';

    const now = new Date();
    const date = window.parseTimestamp ? window.parseTimestamp(timestamp) : new Date(timestamp);
    const diffMs = now - date;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffHours < 1) {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } else if (diffHours < 24) {
      return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    } else if (diffDays < 7) {
      return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    } else {
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
  }

  /**
   * Truncate text to maxLen characters with ellipsis.
   * @param {string} text
   * @param {number} maxLen
   * @returns {string}
   */
  _truncate(text, maxLen) {
    if (!text || text.length <= maxLen) return text || '';
    return text.substring(0, maxLen) + '\u2026';
  }

  /**
   * Clear all messages from the display and show empty state
   */
  _clearMessages() {
    this.messagesEl.innerHTML = `
      <div class="chat-panel__empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
          <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
        </svg>
        <p>Ask questions about this review, or click "Ask about this" on any suggestion.</p>
      </div>
    `;
  }

  /**
   * Ensure the global SSE connection is active.
   * No longer creates sessions — that happens lazily on first message.
   * @returns {{sessionData: null}}
   */
  _ensureConnected() {
    this._ensureGlobalSSE();
    return { sessionData: null };
  }

  /**
   * Late-bind a reviewId after the panel has already been opened.
   * Called by PRManager._initReviewEventListeners() (or equivalent in local.js)
   * to handle the race condition where PanelGroup auto-restores an open chat
   * panel during DOMContentLoaded, before prManager has loaded the review.
   * If the panel is open and has no reviewId yet, this sets it and loads
   * the MRU session so the user sees their previous conversation.
   * @param {number} reviewId - The review ID from prManager
   */
  async _lateBindReview(reviewId) {
    if (!reviewId) return;
    if (this.reviewId) return; // already bound
    this.reviewId = reviewId;
    console.debug('[ChatPanel] Late-bound reviewId:', reviewId);

    // Re-enable input now that reviewId is available
    if (this.inputEl.disabled) {
      this._enableInput();
    }

    // If the panel is already open, load the MRU session now
    if (this.isOpen && !this.currentSessionId) {
      await this._loadMRUSession();
      this._ensureAnalysisContext();
    }
  }

  /**
   * Create a new chat session via API
   * @param {number} contextCommentId - Optional AI suggestion ID for context
   * @returns {Object|null} Session data ({ id, status, context? }) or null on failure
   */
  async createSession(contextCommentId) {
    if (!this.reviewId) {
      console.warn('[ChatPanel] No reviewId available');
      return null;
    }

    try {
      const body = {
        provider: 'pi',
        reviewId: this.reviewId
      };
      if (contextCommentId) {
        body.contextCommentId = contextCommentId;
      }
      if (this._analysisContextRemoved) {
        body.skipAnalysisContext = true;
      }

      console.debug('[ChatPanel] Creating session for review', this.reviewId);
      const response = await fetch('/api/chat/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to create chat session');
      }

      const result = await response.json();
      this.currentSessionId = result.data.id;
      console.debug('[ChatPanel] Session created:', this.currentSessionId);
      return result.data;
    } catch (error) {
      console.error('[ChatPanel] Error creating session:', error);
      this._showError('Failed to start chat session. ' + error.message);
      return null;
    }
  }

  /**
   * Send the current input text as a message
   */
  async sendMessage() {
    const content = this.inputEl.value.trim();
    if (!content || this.isStreaming) return;

    // Save message text before clearing (for error recovery)
    const messageText = content;

    // Clear input
    this.inputEl.value = '';
    this._autoResizeTextarea();
    this.sendBtn.disabled = true;

    // Remove empty state if present
    const emptyState = this.messagesEl.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    // Display user message (just the user's actual text)
    const msgElRef = this.addMessage('user', content);

    // Lazy session creation: create on first message, not on panel open
    if (!this.currentSessionId) {
      this._ensureGlobalSSE();
      const sessionData = await this.createSession();
      if (!sessionData) {
        // Restore the user's message text into the input
        this.inputEl.value = messageText;
        this._autoResizeTextarea();
        this.sendBtn.disabled = false;
        // Remove the phantom message bubble
        if (msgElRef) msgElRef.remove();
        this.messages.pop();
        // Show error
        this._showError('Unable to start chat session. Please try again.');
        return;
      }
      this._showAnalysisContextIfPresent(sessionData);
    }
    // If currentSessionId is set (from MRU), just send — server auto-resumes

    // Prepare streaming UI
    this.isStreaming = true;
    this.sendBtn.disabled = true;
    this.sendBtn.style.display = 'none';
    this.stopBtn.style.display = '';
    this._updateActionButtons();
    this._streamingContent = '';
    this._addStreamingPlaceholder();

    // Build the API payload — may include pending context from "Ask about this"
    const payload = { content };
    const savedContext = this._pendingContext;
    const savedContextData = this._pendingContextData;
    if (this._pendingContext.length > 0) {
      payload.context = this._pendingContext.join('\n\n');
      payload.contextData = this._pendingContextData;
      this._pendingContext = [];
      this._pendingContextData = [];

      // Lock context cards — remove close buttons and index attributes
      const removableCards = this.messagesEl.querySelectorAll('.chat-panel__context-card[data-context-index]');
      removableCards.forEach((card) => {
        const btn = card.querySelector('.chat-panel__context-remove');
        if (btn) btn.remove();
        delete card.dataset.contextIndex;
      });
    }

    // Lock analysis context card (not indexed, handled separately from pending context)
    const analysisRemoveBtn = this.messagesEl.querySelector('.chat-panel__context-card[data-analysis] .chat-panel__context-remove');
    if (analysisRemoveBtn) analysisRemoveBtn.remove();

    // Attach action context (set by action button handlers — adopt, update, dismiss)
    if (this._pendingActionContext) {
      payload.actionContext = this._pendingActionContext;
      this._pendingActionContext = null;
    }

    // Send to API
    try {
      console.debug('[ChatPanel] Sending message to session', this.currentSessionId);
      let response = await fetch(`/api/chat/session/${this.currentSessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      // Handle 410 Gone: session is not resumable — transparently create a new one and retry once
      if (response.status === 410) {
        console.debug('[ChatPanel] Session not resumable (410), creating new session and retrying');
        this.currentSessionId = null;
        this._ensureGlobalSSE();
        const sessionData = await this.createSession();
        if (!sessionData) {
          throw new Error('Failed to create replacement session');
        }

        response = await fetch(`/api/chat/session/${this.currentSessionId}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to send message');
      }
      console.debug('[ChatPanel] Message accepted, waiting for SSE events');
    } catch (error) {
      // Restore pending context so it's not lost
      this._pendingContext = savedContext;
      this._pendingContextData = savedContextData;
      // Restore removability on context cards that were locked before the failed send
      this._restoreRemovableCards();
      console.error('[ChatPanel] Error sending message:', error);
      this._showError('Failed to send message. ' + error.message);
      this._finalizeStreaming();
    }
  }

  /**
   * Store pending context and render a compact context card in the UI.
   * Called when the user clicks "Ask about this" on a suggestion.
   * The context is NOT sent to the agent immediately — it is prepended
   * to the next user message so the agent receives question + context together.
   * @param {Object} ctx - Suggestion context {title, type, file, line_start, line_end, body}
   */
  _sendContextMessage(ctx) {
    // Remove empty state if present
    const emptyState = this.messagesEl.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    // Store structured context data for DB persistence (session resumption)
    const contextData = {
      type: ctx.type || 'general',
      title: ctx.title || 'Untitled',
      file: ctx.file || null,
      line_start: ctx.line_start || null,
      line_end: ctx.line_end || null,
      side: ctx.side || null,
      body: ctx.body || null
    };
    this._pendingContextData.push(contextData);

    // Build the plain text context for the agent (will be prepended to next message)
    const lines = ['The user wants to discuss this specific suggestion:'];
    lines.push(`- Type: ${contextData.type}`);
    lines.push(`- Title: ${contextData.title}`);
    if (contextData.file) {
      let fileLine = `- File: ${contextData.file}`;
      if (contextData.line_start) {
        fileLine += ` (line ${contextData.line_start}${contextData.line_end && contextData.line_end !== contextData.line_start ? '-' + contextData.line_end : ''})`;
      }
      lines.push(fileLine);
    }
    if (contextData.body) {
      lines.push(`- Details: ${contextData.body}`);
    }

    // Enrich with diff hunk if available
    const patch = window.prManager?.filePatches?.get(contextData.file);
    if (patch && window.DiffContext) {
      if (contextData.line_start) {
        const hunk = window.DiffContext.extractHunkForLines(
          patch, contextData.line_start, contextData.line_end || contextData.line_start, contextData.side
        );
        if (hunk) {
          lines.push(`- Diff hunk:\n\`\`\`\n${hunk}\n\`\`\``);
        }
      } else {
        const ranges = window.DiffContext.extractHunkRangesForFile(patch);
        if (ranges.length) {
          lines.push(`- Diff hunk ranges: ${JSON.stringify(ranges)}`);
        }
      }
    }

    this._pendingContext.push(lines.join('\n'));

    // Render the compact context card in the UI
    this._addContextCard(ctx, { removable: true });
  }

  /**
   * Store pending context and render a compact context card for a user comment.
   * Called when the user clicks "Ask about this" on a user comment.
   * The context is NOT sent to the agent immediately -- it is prepended
   * to the next user message so the agent receives question + context together.
   * @param {Object} ctx - Comment context {commentId, body, file, line_start, line_end, source, isFileLevel}
   */
  _sendCommentContextMessage(ctx) {
    // Remove empty state if present
    const emptyState = this.messagesEl.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    // Store structured context data for DB persistence
    const contextData = {
      type: 'comment',
      title: ctx.isFileLevel ? 'File comment' : `Comment on line ${ctx.line_start || '?'}`,
      file: ctx.file || null,
      line_start: ctx.line_start || null,
      line_end: ctx.line_end || null,
      body: ctx.body || null,
      source: 'user'
    };
    this._pendingContextData.push(contextData);

    // Build the plain text context for the agent
    const lines = ['The user wants to discuss their own review comment:'];
    if (contextData.file) {
      let fileLine = `- File: ${contextData.file}`;
      if (contextData.line_start) {
        fileLine += ` (line ${contextData.line_start}${contextData.line_end && contextData.line_end !== contextData.line_start ? '-' + contextData.line_end : ''})`;
      }
      lines.push(fileLine);
    }
    if (ctx.isFileLevel) {
      lines.push('- Scope: File-level comment');
    }
    if (contextData.body) {
      lines.push(`- Comment: ${contextData.body}`);
    }

    // Enrich with diff hunk if available
    const patch = window.prManager?.filePatches?.get(contextData.file);
    if (patch && window.DiffContext) {
      if (contextData.line_start && !ctx.isFileLevel) {
        const hunk = window.DiffContext.extractHunkForLines(
          patch, contextData.line_start, contextData.line_end || contextData.line_start
        );
        if (hunk) {
          lines.push(`- Diff hunk:\n\`\`\`\n${hunk}\n\`\`\``);
        }
      } else {
        const ranges = window.DiffContext.extractHunkRangesForFile(patch);
        if (ranges.length) {
          lines.push(`- Diff hunk ranges: ${JSON.stringify(ranges)}`);
        }
      }
    }

    this._pendingContext.push(lines.join('\n'));

    // Render the compact context card in the UI
    this._addCommentContextCard(ctx, { removable: true });
  }

  /**
   * Send a file context message to the chat panel.
   * Called when the user clicks "Chat about file" on a file header.
   * @param {Object} fileContext - File context data
   * @param {string} fileContext.file - File path
   */
  _sendFileContextMessage(fileContext) {
    let contextText = `The user wants to discuss ${fileContext.file}`;

    // Check for duplicate context (use startsWith because contextText may
    // get enriched with diff hunk ranges after this check)
    const isDuplicate = this._pendingContext.some(c => c === contextText || c.startsWith(contextText)) ||
      this.messages.some(m => m.role === 'context' && (m.content === contextText || m.content.startsWith(contextText)));
    if (isDuplicate) return;

    // Remove empty state if present
    const emptyState = this.messagesEl.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    // Store structured context data for DB persistence
    const contextData = {
      type: 'file',
      title: fileContext.file,
      file: fileContext.file,
      line_start: null,
      line_end: null,
      body: null
    };
    this._pendingContextData.push(contextData);

    // Enrich with diff hunk ranges if available
    const patch = window.prManager?.filePatches?.get(fileContext.file);
    if (patch && window.DiffContext) {
      const ranges = window.DiffContext.extractHunkRangesForFile(patch);
      if (ranges.length) {
        contextText += `\n- Diff hunk ranges: ${JSON.stringify(ranges)}`;
      }
    }

    this._pendingContext.push(contextText);

    // Render the compact context card in the UI
    this._addFileContextCard(contextData, { removable: true });
  }

  /**
   * Add an analysis run as context for the chat conversation.
   * Fetches run metadata from the backend and creates a removable context card
   * that participates in the pending context arrays (data-context-index path).
   * Unlike the auto-added analysis card (data-analysis="true"), this is a
   * manually-added card that goes through the standard pending context flow.
   * @param {string} runId - The analysis run ID to add as context
   */
  async addAnalysisRunContext(runId) {
    // 1. Check for duplicate - look for any card with this run ID (both auto-added and manually-added)
    const existingCard = this.messagesEl?.querySelector(`[data-analysis-run-id="${runId}"]`);
    if (existingCard) {
      this._showToast('Analysis run already added');
      return;
    }

    // 2. Open panel if closed
    await this.open({ suppressFocus: true });

    // Re-check: open() may have auto-added a card for this run via _ensureAnalysisContext
    const existingCardPostOpen = this.messagesEl?.querySelector(
      `[data-analysis-run-id="${runId}"]`
    );
    if (existingCardPostOpen) {
      this._showToast('Analysis run already added');
      return;
    }

    // 3. Fetch context from backend
    const response = await fetch(`/api/chat/analysis-context/${runId}?reviewId=${this.reviewId}`);
    if (!response.ok) {
      console.error('[ChatPanel] Failed to fetch analysis context:', response.statusText);
      return;
    }
    const result = await response.json();
    const data = result.data;

    // 4. Push to pending context arrays
    this._pendingContext.push(data.text);
    const contextData = {
      type: 'analysis-run',
      aiRunId: runId,
      provider: data.run.provider,
      model: data.run.model,
      summary: data.run.summary,
      suggestionCount: data.suggestionCount,
      configType: data.run.configType,
      completedAt: data.run.completedAt
    };
    this._pendingContextData.push(contextData);

    // 5. Remove empty state if present
    const emptyState = this.messagesEl?.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    // 6. Create the card and append
    this._addAnalysisRunContextCard(contextData, { removable: true });

    // 7. Focus input
    if (this.inputEl) this.inputEl.focus();
  }

  /**
   * Make a context card removable by adding a data-context-index and a remove button.
   * Shared helper used by _addContextCard, _addCommentContextCard, and _addFileContextCard.
   * @param {HTMLElement} card - The context card element
   */
  _makeCardRemovable(card) {
    const idx = this._pendingContextData.length - 1;
    card.dataset.contextIndex = idx;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'chat-panel__context-remove';
    removeBtn.title = 'Remove context';
    removeBtn.innerHTML = '\u00d7';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._removeContextCard(card);
    });
    card.appendChild(removeBtn);
  }

  /**
   * Add a compact file context card to the messages area.
   * @param {Object} ctx - File context data { file, title }
   * @param {Object} [options] - Options
   * @param {boolean} [options.removable=false] - Whether the card should have a remove button
   */
  _addFileContextCard(ctx, { removable = false } = {}) {
    const card = document.createElement('div');
    card.className = 'chat-panel__context-card';

    const filePath = ctx.file || ctx.title || '';

    card.innerHTML = `
      <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
        <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/>
      </svg>
      <span class="chat-panel__context-label"><strong>FILE</strong></span>
      <span class="chat-panel__context-title">${this._escapeHtml(filePath)}</span>
    `;

    if (removable) this._makeCardRemovable(card);

    this.messagesEl.appendChild(card);
    requestAnimationFrame(() => this.scrollToBottom());
  }

  /**
   * Ensure the latest AI analysis context is added as the first context item.
   * Called on every panel expand (not just when opening with specific context).
   * Detects new analysis runs by comparing the latest completed run ID
   * against the one already loaded in the session. Only adds if suggestions exist.
   */
  _ensureAnalysisContext() {
    // Determine the latest completed run ID from the analysis history manager or prManager
    const currentRunId = this._getLatestCompletedRunId();

    // Detect whether a NEW analysis run has appeared since we last loaded context.
    // If the run ID changed, we need to replace the old card with a new one.
    // This handles the case where _sessionAnalysisRunId was explicitly set.
    const isNewRunVsSession = currentRunId && this._sessionAnalysisRunId &&
      String(currentRunId) !== String(this._sessionAnalysisRunId);

    if (isNewRunVsSession) {
      console.debug('[ChatPanel] _ensureAnalysisContext: new run detected:', currentRunId, '(was:', this._sessionAnalysisRunId + ')');
      // Remove the old analysis card from the DOM (if present)
      const oldCard = this.messagesEl.querySelector('.chat-panel__context-card[data-analysis]');
      if (oldCard) oldCard.remove();
      // Reset flags — the user removed the OLD run's context, but this is a different run
      this._analysisContextRemoved = false;
      this._sessionAnalysisRunId = null;
    }

    // Check for an existing card in the DOM (e.g., loaded from MRU session history).
    // If _sessionAnalysisRunId is not set, this card may be stale — compare its
    // stamped run ID against the latest completed run to detect new analyses that
    // completed while the panel was closed.
    const existingCard = this.messagesEl.querySelector('.chat-panel__context-card[data-analysis]');
    if (existingCard) {
      if (!this._sessionAnalysisRunId && currentRunId) {
        const cardRunId = existingCard.dataset.analysisRunId || null;
        if (cardRunId && String(cardRunId) === String(currentRunId)) {
          // Card matches the latest run — adopt its run ID so future opens can detect changes
          console.debug('[ChatPanel] _ensureAnalysisContext: adopting existing card runId:', cardRunId);
          this._sessionAnalysisRunId = String(currentRunId);
          return;
        }
        // Card has no run ID stamp or a different run ID — it's stale.
        // Remove it so a fresh card for the current run is added below.
        console.debug('[ChatPanel] _ensureAnalysisContext: replacing stale DOM card (card:', cardRunId, 'latest:', currentRunId + ')');
        existingCard.remove();
        this._analysisContextRemoved = false;
      } else {
        console.debug('[ChatPanel] _ensureAnalysisContext: skipped — card already in DOM');
        return;
      }
    }

    // Skip if the current session already has analysis context loaded (by run ID)
    // and no new run was detected (handled above)
    if (this._sessionAnalysisRunId) {
      console.debug('[ChatPanel] _ensureAnalysisContext: skipped — runId already set:', this._sessionAnalysisRunId);
      return;
    }

    // Skip if analysis context was explicitly removed in this conversation
    if (this._analysisContextRemoved) {
      console.debug('[ChatPanel] _ensureAnalysisContext: skipped — explicitly removed');
      return;
    }

    // Count suggestions from the DOM (from the latest analysis run)
    const suggestionEls = typeof document !== 'undefined' && document.querySelectorAll
      ? document.querySelectorAll('.ai-suggestion[data-suggestion-id]')
      : [];
    const count = suggestionEls.length;
    if (count === 0) {
      console.debug('[ChatPanel] _ensureAnalysisContext: skipped — no suggestions in DOM');
      return;
    }
    console.debug('[ChatPanel] _ensureAnalysisContext: adding card with', count, 'suggestions');

    // Remove empty state
    const emptyState = this.messagesEl.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    // Render the analysis context card (removable).
    // Prepend only when the messages area is empty (fresh conversation) so the card
    // appears first.  When re-opening an existing chat that already has messages,
    // append instead so the card lands at the bottom where the user can see it
    // (prepending + scrollToBottom would hide it above the fold).
    // Note: analysis card is NOT added to _pendingContext/_pendingContextData —
    // the backend includes full suggestion data via initialContext at session creation.
    // The card is a visual indicator that controls whether the backend includes it.
    const hasExistingMessages = this.messagesEl.querySelectorAll('.chat-panel__message').length > 0;
    const contextData = this._buildAnalysisContextData(currentRunId, count);
    this._addAnalysisContextCard(contextData, { removable: true, prepend: !hasExistingMessages });

    // Persist to DB so the card is restored on session reload
    this._persistAnalysisContext(contextData);

    // Mark that analysis context is loaded for this session.
    // Use the actual run ID if available, otherwise fall back to 'dom'.
    this._sessionAnalysisRunId = currentRunId || 'dom';
  }

  /**
   * Build enriched analysis context data for the card.
   * Pulls metadata (provider, model, summary, configType) from the
   * cached runs in analysisHistoryManager so the card's tooltip
   * shows rich info even before a session is created.
   * @param {string|null} runId - The run ID to look up metadata for
   * @param {number} count - Number of suggestions in the DOM
   * @returns {Object} Context data with type, suggestionCount, and optional metadata
   */
  _buildAnalysisContextData(runId, count) {
    const contextData = { type: 'analysis', suggestionCount: count };

    if (!runId) return contextData;

    // Look up the run in the cached analysisHistoryManager.runs array
    const mgr = window.prManager;
    const historyMgr = mgr?.analysisHistoryManager;
    if (!historyMgr?.runs?.length) return contextData;

    const run = historyMgr.runs.find(r => String(r.id) === String(runId));
    if (!run) return contextData;

    // Enrich with available metadata
    if (run.provider) contextData.provider = run.provider;
    if (run.model) contextData.model = run.model;
    if (run.summary) contextData.summary = run.summary;
    if (run.config_type) contextData.configType = run.config_type;
    if (run.completed_at) contextData.completedAt = run.completed_at;
    contextData.aiRunId = String(run.id);

    return contextData;
  }

  /**
   * Get the ID of the latest completed (successful) analysis run.
   * Looks at the cached runs in analysisHistoryManager (sorted by date DESC)
   * and returns the first one with status 'completed'.
   * Falls back to the selected run ID or prManager.selectedRunId for
   * backward compatibility when the runs array is not available.
   * @returns {string|null}
   */
  _getLatestCompletedRunId() {
    const mgr = window.prManager;
    if (!mgr) return null;

    // Prefer the analysisHistoryManager's runs array — find latest completed run
    const historyMgr = mgr.analysisHistoryManager;
    if (historyMgr?.runs?.length > 0) {
      // Runs are sorted by date DESC; find the first completed one
      const completedRun = historyMgr.runs.find(r => r.status === 'completed');
      if (completedRun) return String(completedRun.id);
    }

    // Fall back to selectedRunId on the history manager (for cases where
    // runs array is empty but a selection exists)
    if (historyMgr?.getSelectedRunId) {
      const id = historyMgr.getSelectedRunId();
      if (id) return String(id);
    }

    // Fall back to prManager.selectedRunId
    if (mgr.selectedRunId) return String(mgr.selectedRunId);
    return null;
  }

  /**
   * Remove the analysis context card and mark it as explicitly removed.
   * When removed, the backend will skip including analysis suggestions in the session.
   * @param {HTMLElement} cardEl - The analysis context card element
   */
  _removeAnalysisContextCard(cardEl) {
    this._analysisContextRemoved = true;
    cardEl.remove();

    // If no pending context, no messages, and no other context cards, restore empty state
    if (this._pendingContext.length === 0 && this.messages.length === 0 &&
        !this.messagesEl.querySelector('.chat-panel__context-card')) {
      this._clearMessages();
    }
  }

  /**
   * Add a compact context card for a user comment to the messages area.
   * @param {Object} ctx - Comment context {commentId, body, file, line_start, line_end, isFileLevel}
   */
  _addCommentContextCard(ctx, { removable = false } = {}) {
    const card = document.createElement('div');
    card.className = 'chat-panel__context-card';

    const label = ctx.isFileLevel ? 'file comment' : 'comment';
    const bodyPreview = ctx.body ? (ctx.body.length > 60 ? ctx.body.substring(0, 60) + '...' : ctx.body) : 'Comment';
    const fileInfo = ctx.file
      ? `${ctx.file}${ctx.line_start ? ':' + ctx.line_start : ''}`
      : '';

    card.innerHTML = `
      <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
        <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
      </svg>
      <span class="chat-panel__context-label">${this._escapeHtml(label)}</span>
      <span class="chat-panel__context-title">${this._renderInlineMarkdown(bodyPreview)}</span>
      ${fileInfo ? `<span class="chat-panel__context-file">${this._escapeHtml(fileInfo)}</span>` : ''}
    `;

    // Store tooltip data for rich hover preview
    if (ctx.body) card.dataset.tooltipBody = ctx.body;

    if (removable) this._makeCardRemovable(card);

    this.messagesEl.appendChild(card);
    requestAnimationFrame(() => this.scrollToBottom());
  }

  /**
   * Add a compact context card to the messages area.
   * Visually indicates which suggestion the user is asking about,
   * without taking up space as a full message bubble.
   * @param {Object} ctx - Suggestion context {title, type, file, line_start, line_end, body}
   */
  _addContextCard(ctx, { removable = false } = {}) {
    const card = document.createElement('div');
    card.className = 'chat-panel__context-card';

    const typeLabel = ctx.type || 'suggestion';
    const fileInfo = ctx.file ? `${ctx.file}${ctx.line_start ? ':' + ctx.line_start : ''}` : '';

    card.innerHTML = `
      <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
        <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>
      </svg>
      <span class="chat-panel__context-label">${this._renderInlineMarkdown(typeLabel)}</span>
      <span class="chat-panel__context-title">${this._renderInlineMarkdown(ctx.title || 'Untitled')}</span>
      ${fileInfo ? `<span class="chat-panel__context-file">${this._escapeHtml(fileInfo)}</span>` : ''}
    `;

    // Store tooltip data for rich hover preview
    if (ctx.body) card.dataset.tooltipBody = ctx.body;
    if (ctx.type) card.dataset.tooltipType = ctx.type;
    if (ctx.title) card.dataset.tooltipTitle = ctx.title;

    if (removable) this._makeCardRemovable(card);

    this.messagesEl.appendChild(card);
    requestAnimationFrame(() => this.scrollToBottom());
  }

  /**
   * Restore remove buttons and data-context-index on all pending context cards.
   * Called after a failed send to unlock cards that were locked prematurely.
   */
  _restoreRemovableCards() {
    // Restore analysis context card if it was locked
    const analysisCard = this.messagesEl.querySelector('.chat-panel__context-card[data-analysis]');
    if (analysisCard && !analysisCard.querySelector('.chat-panel__context-remove')) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'chat-panel__context-remove';
      removeBtn.title = 'Remove context';
      removeBtn.innerHTML = '\u00d7';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._removeAnalysisContextCard(analysisCard);
      });
      analysisCard.appendChild(removeBtn);
    }

    const cards = this.messagesEl.querySelectorAll('.chat-panel__context-card:not([data-analysis])');
    let idx = 0;
    cards.forEach((card) => {
      // Only restore cards that don't already have a remove button
      if (!card.querySelector('.chat-panel__context-remove')) {
        card.dataset.contextIndex = idx;
        const removeBtn = document.createElement('button');
        removeBtn.className = 'chat-panel__context-remove';
        removeBtn.title = 'Remove context';
        removeBtn.innerHTML = '\u00d7';
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._removeContextCard(card);
        });
        card.appendChild(removeBtn);
      } else {
        card.dataset.contextIndex = idx;
      }
      idx++;
    });
  }

  /**
   * Remove a pending context card from the UI and data arrays.
   * Re-indexes remaining cards so data-context-index stays in sync.
   * @param {HTMLElement} cardEl - The context card element to remove
   */
  _removeContextCard(cardEl) {
    const idx = parseInt(cardEl.dataset.contextIndex, 10);
    if (!isNaN(idx) && idx >= 0 && idx < this._pendingContext.length) {
      this._pendingContext.splice(idx, 1);
      this._pendingContextData.splice(idx, 1);
    }
    // Hide context tooltip – mouseleave won't fire on a removed element
    clearTimeout(this._ctxTooltipTimer);
    if (this._ctxTooltipEl) this._ctxTooltipEl.style.display = 'none';

    cardEl.remove();

    // Re-index remaining removable context cards
    const remainingCards = this.messagesEl.querySelectorAll('.chat-panel__context-card[data-context-index]');
    remainingCards.forEach((card, i) => {
      card.dataset.contextIndex = i;
    });

    // If no pending context, no messages, and no other context cards, restore empty state
    if (this._pendingContext.length === 0 && this.messages.length === 0 &&
        !this.messagesEl.querySelector('.chat-panel__context-card')) {
      this._clearMessages();
    }
  }

  /**
   * Show analysis context card if the session response includes context metadata.
   * Removes the empty state first so the card appears as the first element.
   * @param {Object} sessionData - Response data from createSession ({ id, status, context? })
   */
  _showAnalysisContextIfPresent(sessionData) {
    if (sessionData.context && sessionData.context.suggestionCount > 0) {
      const existingCard = this.messagesEl.querySelector('.chat-panel__context-card[data-analysis]');
      if (existingCard) {
        // Upgrade a bare-bones card (no metadata) with richer data from the backend.
        // Update IN-PLACE to preserve the card's DOM position (avoids jumping below user message).
        const hasRicherContext = !existingCard.dataset.hasMetadata &&
          (sessionData.context.provider || sessionData.context.model || sessionData.context.summary);
        if (!hasRicherContext) return;
        this._updateAnalysisCardContent(existingCard, sessionData.context);
      } else {
        const emptyState = this.messagesEl.querySelector('.chat-panel__empty');
        if (emptyState) emptyState.remove();
        this._addAnalysisContextCard(sessionData.context);
      }

      // Persist richer analysis context to DB (includes provider, model, summary, etc.)
      const contextData = { type: 'analysis', ...sessionData.context };
      this._persistAnalysisContext(contextData);

      // Track which run's context is loaded so _ensureAnalysisContext can skip if already present
      this._sessionAnalysisRunId = sessionData.context.aiRunId || 'session';
    }
  }

  /**
   * Build the inner HTML string for an analysis context card.
   * Shared by _addAnalysisContextCard (new card) and _updateAnalysisCardContent (in-place upgrade).
   * @param {Object} context - Context metadata { suggestionCount, provider, model, summary, configType }
   * @returns {string} HTML string for the card's content (SVG icon + label + title span)
   */
  _buildAnalysisCardInnerHTML(context) {
    const count = context.suggestionCount;
    const title = count === 1 ? '1 suggestion loaded' : `${count} suggestions loaded`;

    // Build metadata details string (model/provider info)
    const metaParts = [];
    if (context.provider) metaParts.push(this._escapeHtml(context.provider));
    if (context.model) metaParts.push(this._escapeHtml(context.model));
    const metaStr = metaParts.length > 0 ? ` (${metaParts.join(' / ')})` : '';

    // Build tooltip with provider, model, config, and summary (no title, no completedAt here since it's formatted for display)
    const tooltipParts = [];
    if (context.provider || context.model) {
      tooltipParts.push(`Provider: ${context.provider || 'unknown'}, Model: ${context.model || 'unknown'}`);
    }
    if (context.configType) tooltipParts.push(`Config: ${context.configType}`);
    if (context.completedAt) {
      const completedDate = window.parseTimestamp(context.completedAt);
      tooltipParts.push(`Completed: ${completedDate.toLocaleString()}`);
    }
    if (context.summary) tooltipParts.push(`Summary: ${context.summary}`);
    const tooltip = tooltipParts.join('\n');

    return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
        <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
      </svg>
      <span class="chat-panel__context-label">analysis run</span>
      <span class="chat-panel__context-title" title="${window.escapeHtmlAttribute(tooltip)}">${this._escapeHtml(title)}${metaStr}</span>
    `;
  }

  /**
   * Update an existing analysis context card's content and dataset in-place.
   * Preserves the card's DOM position (avoids remove+recreate which causes ordering bugs).
   * @param {HTMLElement} card - The existing analysis context card element
   * @param {Object} context - Richer context metadata from the backend
   */
  _updateAnalysisCardContent(card, context) {
    // Preserve existing remove button (if card is removable) before replacing innerHTML
    const removeBtn = card.querySelector('.chat-panel__context-remove');

    // Rebuild card innerHTML with richer metadata
    card.innerHTML = this._buildAnalysisCardInnerHTML(context);

    // Re-append the remove button if it existed
    if (removeBtn) {
      card.appendChild(removeBtn);
    }

    // Update dataset attributes
    if (context.aiRunId) {
      card.dataset.analysisRunId = context.aiRunId;
    }
    if (context.provider || context.model || context.summary) {
      card.dataset.hasMetadata = 'true';
    }
  }

  /**
   * Add a compact analysis-run context card to the messages area.
   * Used for manually-added analysis run cards that participate in the pending
   * context arrays (data-context-index path).  Unlike _addAnalysisContextCard
   * (auto-added, data-analysis="true"), these cards use _removeContextCard.
   * @param {Object} ctxData - Context data { type, aiRunId, provider, model, summary, suggestionCount, configType }
   * @param {Object} [opts] - Options
   * @param {boolean} [opts.removable=false] - Whether the card should have a remove button
   */
  _addAnalysisRunContextCard(ctxData, { removable = false } = {}) {
    const card = document.createElement('div');
    card.className = 'chat-panel__context-card';
    card.dataset.contextIndex = this._pendingContext.length - 1;
    card.dataset.analysisRunId = ctxData.aiRunId;
    card.innerHTML = this._buildAnalysisCardInnerHTML(ctxData);

    if (removable) this._makeCardRemovable(card);

    this.messagesEl.appendChild(card);
    requestAnimationFrame(() => this.scrollToBottom());
  }

  /**
   * Add a compact analysis context card to the messages area.
   * Visually indicates that the agent has analysis suggestions loaded as context.
   * Displays run metadata (model, provider, summary) when available.
   * @param {Object} context - Context metadata { suggestionCount, aiRunId, provider, model, summary, completedAt, configType, parentRunId }
   */
  _addAnalysisContextCard(context, { removable = false, prepend = false } = {}) {
    const card = document.createElement('div');
    card.className = 'chat-panel__context-card';
    card.dataset.analysis = 'true';
    if (context.aiRunId) {
      card.dataset.analysisRunId = context.aiRunId;
    }
    if (context.provider || context.model || context.summary) {
      card.dataset.hasMetadata = 'true';
    }

    card.innerHTML = this._buildAnalysisCardInnerHTML(context);

    if (removable) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'chat-panel__context-remove';
      removeBtn.title = 'Remove context';
      removeBtn.innerHTML = '\u00d7';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._removeAnalysisContextCard(card);
      });
      card.appendChild(removeBtn);
    }

    if (prepend) {
      const firstChild = this.messagesEl.firstChild;
      if (firstChild) {
        this.messagesEl.insertBefore(card, firstChild);
      } else {
        this.messagesEl.appendChild(card);
      }
    } else {
      this.messagesEl.appendChild(card);
    }
    requestAnimationFrame(() => this.scrollToBottom());
  }

  /**
   * Persist an analysis context card to the backend as a 'context' message.
   * Called immediately when an analysis context card is added, so it appears
   * in the conversation history on reload.
   * @param {Object} contextData - Analysis context metadata (type, suggestionCount, etc.)
   */
  async _persistAnalysisContext(contextData) {
    if (!this.currentSessionId) return;

    try {
      const response = await fetch(`/api/chat/session/${this.currentSessionId}/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextData })
      });
      if (!response.ok) {
        console.warn('[ChatPanel] Failed to persist analysis context:', response.status);
      }
    } catch (err) {
      console.warn('[ChatPanel] Failed to persist analysis context:', err);
    }
  }

  /**
   * Ensure the global multiplexed SSE connection is established.
   * Creates the EventSource once; subsequent calls are no-ops if already connected.
   * Events are filtered by sessionId to dispatch only to the active session.
   */
  _ensureGlobalSSE() {
    // Already connected or connecting — nothing to do
    if (this.eventSource &&
        this.eventSource.readyState !== EventSource.CLOSED) {
      return;
    }

    // Clear any pending reconnect timer
    clearTimeout(this._sseReconnectTimer);
    this._sseReconnectTimer = null;

    const url = '/api/chat/stream';
    console.debug('[ChatPanel] Connecting multiplexed SSE:', url);
    this.eventSource = new EventSource(url);

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Initial connection acknowledgement — no sessionId, just log
        if (data.type === 'connected' && !data.sessionId) {
          console.debug('[ChatPanel] Multiplexed SSE connected');
          return;
        }

        // Route review-scoped events to document as CustomEvents
        if (data.reviewId && data.type?.startsWith('review:')) {
          document.dispatchEvent(new CustomEvent(data.type, {
            detail: { reviewId: data.reviewId, sourceClientId: data.sourceClientId }
          }));
          return;
        }

        // Filter: only process events for the active session
        if (data.sessionId !== this.currentSessionId) return;

        if (data.type !== 'delta') {
          console.debug('[ChatPanel] SSE event:', data.type, 'session:', data.sessionId);
        }

        // When the panel is closed, still accumulate internal state
        // so messages are available when the panel reopens.
        if (!this.isOpen) {
          switch (data.type) {
            case 'delta':
              this._streamingContent += data.text;
              break;
            case 'complete':
              if (this._streamingContent) {
                this.messages.push({ role: 'assistant', content: this._streamingContent, id: data.messageId });
              }
              this._streamingContent = '';
              this.isStreaming = false;
              break;
            case 'error':
              this._streamingContent = '';
              this.isStreaming = false;
              break;
            // tool_use, status: purely visual, skip when closed
          }
          return;
        }

        switch (data.type) {
          case 'delta':
            this._hideThinkingIndicator();
            this._streamingContent += data.text;
            this.updateStreamingMessage(this._streamingContent);
            break;

          case 'tool_use':
            this._showToolUse(data.toolName, data.status, data.toolInput);
            break;

          case 'status':
            this._handleAgentStatus(data.status);
            break;

          case 'complete':
            this.finalizeStreamingMessage(data.messageId);
            break;

          case 'error':
            this._showError(data.message || 'An error occurred');
            this._finalizeStreaming();
            break;
        }
      } catch (e) {
        console.error('[ChatPanel] SSE parse error:', e);
      }
    };

    this.eventSource.onerror = () => {
      if (this.eventSource?.readyState === EventSource.CLOSED) {
        console.warn('[ChatPanel] Multiplexed SSE connection closed, reconnecting in 2s');
        this.eventSource = null;
        this._sseReconnectTimer = setTimeout(() => {
          this._ensureGlobalSSE();
        }, 2000);
      }
    };
  }

  /**
   * Close the global SSE connection and cancel any reconnect timer.
   */
  _closeGlobalSSE() {
    clearTimeout(this._sseReconnectTimer);
    this._sseReconnectTimer = null;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /**
   * Add a message to the display
   * @param {string} role - 'user' or 'assistant'
   * @param {string} content - Message text
   * @param {number} id - Optional message ID
   * @returns {HTMLElement} The message element that was appended
   */
  addMessage(role, content, id) {
    const msg = { role, content, id };
    this.messages.push(msg);

    const msgEl = document.createElement('div');
    msgEl.className = `chat-panel__message chat-panel__message--${role}`;
    if (id) msgEl.dataset.messageId = id;

    const bubble = document.createElement('div');
    bubble.className = 'chat-panel__bubble';

    if (role === 'assistant') {
      bubble.innerHTML = this.renderMarkdown(content);
      this._linkifyFileReferences(bubble);
      bubble.appendChild(this._createCopyButton(content));
    } else {
      bubble.textContent = content;
    }

    msgEl.appendChild(bubble);
    this.messagesEl.appendChild(msgEl);
    this.scrollToBottom();
    return msgEl;
  }

  /**
   * Create a copy-to-clipboard button for an assistant message bubble.
   * @param {string} rawContent - Raw markdown to copy
   * @returns {HTMLButtonElement}
   */
  _createCopyButton(rawContent) {
    const btn = document.createElement('button');
    btn.className = 'chat-panel__copy-btn';
    btn.title = 'Copy message';
    const clipboardIcon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/>
      <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
    </svg>`;
    const checkIcon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
    </svg>`;
    btn.innerHTML = clipboardIcon;

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(rawContent);
        btn.innerHTML = checkIcon;
        btn.classList.add('chat-panel__copy-btn--success');
        setTimeout(() => {
          btn.innerHTML = clipboardIcon;
          btn.classList.remove('chat-panel__copy-btn--success');
        }, 2000);
      } catch (err) {
        console.error('[ChatPanel] Copy failed:', err);
        btn.title = 'Copy failed';
        setTimeout(() => { btn.title = 'Copy message'; }, 2000);
      }
    });

    return btn;
  }

  /**
   * Add a streaming placeholder for the assistant's response
   */
  _addStreamingPlaceholder() {
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-panel__message chat-panel__message--assistant chat-panel__message--streaming';
    msgEl.id = 'chat-streaming-msg';

    const bubble = document.createElement('div');
    bubble.className = 'chat-panel__bubble';
    bubble.innerHTML = '<span class="chat-panel__typing-indicator"><span></span><span></span><span></span></span>';

    msgEl.appendChild(bubble);
    this.messagesEl.appendChild(msgEl);
    this.scrollToBottom();
  }

  /**
   * Update the currently streaming message
   * @param {string} text - Full accumulated text so far
   */
  updateStreamingMessage(text) {
    const streamingMsg = document.getElementById('chat-streaming-msg');
    if (!streamingMsg) return;

    // Remove transient tool badge when real text arrives
    const transient = streamingMsg.querySelector('.chat-panel__tool-badge--transient');
    if (transient) transient.remove();

    const bubble = streamingMsg.querySelector('.chat-panel__bubble');
    if (bubble) {
      bubble.innerHTML = this.renderMarkdown(text) + '<span class="chat-panel__cursor"></span>';
    }
    this.scrollToBottom();
  }

  /**
   * Finalize the streaming message with final ID
   * @param {number} messageId - Database message ID
   */
  finalizeStreamingMessage(messageId) {
    const streamingMsg = document.getElementById('chat-streaming-msg');
    if (streamingMsg) {
      streamingMsg.classList.remove('chat-panel__message--streaming');
      streamingMsg.id = '';
      if (messageId) streamingMsg.dataset.messageId = messageId;

      // Remove cursor and thinking indicator
      const cursor = streamingMsg.querySelector('.chat-panel__cursor');
      if (cursor) cursor.remove();
      const thinking = streamingMsg.querySelector('.chat-panel__thinking');
      if (thinking) thinking.remove();

      // Remove transient tool badge
      const transientBadge = streamingMsg.querySelector('.chat-panel__tool-badge--transient');
      if (transientBadge) transientBadge.remove();

      // Remove any active tool spinners (e.g. abort mid-tool-execution)
      const spinners = streamingMsg.querySelectorAll('.chat-panel__tool-spinner');
      spinners.forEach(s => s.remove());

      // Final render
      const bubble = streamingMsg.querySelector('.chat-panel__bubble');
      if (bubble) {
        if (this._streamingContent) {
          bubble.innerHTML = this.renderMarkdown(this._streamingContent);
          this._linkifyFileReferences(bubble);
          bubble.appendChild(this._createCopyButton(this._streamingContent));
        } else {
          // Empty response - show a subtle message
          bubble.innerHTML = '<em class="chat-panel__empty-response">No response generated.</em>';
        }
      }
    }

    // Store in messages array
    if (this._streamingContent) {
      this.messages.push({ role: 'assistant', content: this._streamingContent, id: messageId });
    }

    this._finalizeStreaming();
  }

  /**
   * Abort the current agent turn
   */
  async _stopAgent() {
    if (!this.isStreaming || !this.currentSessionId) return;

    try {
      await fetch(`/api/chat/session/${this.currentSessionId}/abort`, {
        method: 'POST'
      });
    } catch (error) {
      console.error('[ChatPanel] Error aborting:', error);
    }

    // Finalize the streaming message with whatever content we have so far
    this.finalizeStreamingMessage(null);
  }

  /**
   * Clean up streaming state
   */
  _finalizeStreaming() {
    this.isStreaming = false;
    this._streamingContent = '';
    this.sendBtn.style.display = '';
    this.stopBtn.style.display = 'none';
    this.sendBtn.disabled = !this.inputEl?.value?.trim();
    this._updateActionButtons();
    this.inputEl?.focus();
  }

  /**
   * Show a tool use indicator in the streaming message
   * @param {string} toolName - Name of the tool being used
   * @param {string} status - 'start' or 'end'
   * @param {Object} [toolInput] - Tool input/arguments (optional)
   */
  _showToolUse(toolName, status, toolInput) {
    const streamingMsg = document.getElementById('chat-streaming-msg');
    if (!streamingMsg) return;

    const isTask = toolName.toLowerCase() === 'task';

    if (status === 'start') {
      this._hideThinkingIndicator();
      const argSummary = this._summarizeToolInput(toolName, toolInput);

      const badgeHTML = `
        <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
          <path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
        </svg>
        <span>${this._escapeHtml(toolName)}</span>${argSummary ? `<span class="chat-panel__tool-args" title="${window.escapeHtmlAttribute(argSummary)}">${this._escapeHtml(argSummary)}</span>` : ''}
        <span class="chat-panel__tool-spinner"></span>
      `;

      if (isTask) {
        // Task tools get persistent badges (meaningful delegated work)
        const badge = document.createElement('div');
        badge.className = 'chat-panel__tool-badge';
        badge.dataset.tool = toolName;
        badge.innerHTML = badgeHTML;
        const bubble = streamingMsg.querySelector('.chat-panel__bubble');
        streamingMsg.insertBefore(badge, bubble);
      } else {
        // Non-Task tools reuse a single transient badge
        let badge = streamingMsg.querySelector('.chat-panel__tool-badge--transient');
        if (!badge) {
          badge = document.createElement('div');
          badge.className = 'chat-panel__tool-badge chat-panel__tool-badge--transient';
          const bubble = streamingMsg.querySelector('.chat-panel__bubble');
          streamingMsg.insertBefore(badge, bubble);
        }
        badge.dataset.tool = toolName;
        badge.innerHTML = badgeHTML;
      }
    } else {
      if (isTask) {
        // Remove spinner from completed Task badge
        const badges = streamingMsg.querySelectorAll('.chat-panel__tool-badge[data-tool="Task"]:not(.chat-panel__tool-badge--transient)');
        badges.forEach(b => {
          const spinner = b.querySelector('.chat-panel__tool-spinner');
          if (spinner) spinner.remove();
        });
      } else {
        // Remove spinner from transient badge (badge stays until text arrives or next tool starts)
        const transient = streamingMsg.querySelector('.chat-panel__tool-badge--transient');
        if (transient) {
          const spinner = transient.querySelector('.chat-panel__tool-spinner');
          if (spinner) spinner.remove();
        }
      }
      this._showThinkingIndicator();
    }
  }

  /**
   * Extract a compact summary string from tool input for display.
   * @param {string} toolName - Name of the tool
   * @param {Object} [input] - Tool input/arguments
   * @returns {string} Compact summary or empty string
   */
  _summarizeToolInput(toolName, input) {
    if (!input || typeof input !== 'object') return '';

    const name = toolName.toLowerCase();
    switch (name) {
      case 'bash': {
        let cmd = input.command || '';
        // Strip "cd <path> && " prefix — the actual command is more interesting
        cmd = cmd.replace(/^cd\s+\S+\s*&&\s*/, '');
        return cmd;
      }
      case 'read':
        return input.file_path || input.path || '';
      case 'grep':
        return input.pattern || '';
      case 'glob':
        return input.pattern || '';
      case 'find':
      case 'ls':
        return input.path || '';
      case 'write':
      case 'edit':
        return input.file_path || input.path || '';
      default: {
        // For unknown tools, show the first string-valued argument
        const vals = Object.values(input);
        for (const v of vals) {
          if (typeof v === 'string' && v.length > 0) return v;
        }
        return '';
      }
    }
  }

  /**
   * Handle agent status events from the backend.
   * @param {string} status - 'working' or 'turn_complete'
   */
  _handleAgentStatus(status) {
    if (status === 'working') {
      this._showThinkingIndicator();
    }
    // 'turn_complete' is informational; the agent may start another turn
  }

  /**
   * Show the pulsing thinking indicator in/below the streaming message.
   * If there's already content, append it after the content. If no content, it's the typing dots.
   */
  _showThinkingIndicator() {
    const streamingMsg = document.getElementById('chat-streaming-msg');
    if (!streamingMsg) return;

    // Don't add duplicate
    if (streamingMsg.querySelector('.chat-panel__thinking')) return;

    // Don't add if the bubble still has its initial typing indicator (no content yet).
    // The bubble's own dots are sufficient — adding a second set would show two pulsing indicators.
    const bubble = streamingMsg.querySelector('.chat-panel__bubble');
    if (bubble && bubble.querySelector('.chat-panel__typing-indicator')) return;

    // Remove the cursor — the thinking indicator replaces it as the "working" signal.
    // When new text arrives, updateStreamingMessage() will re-add the cursor naturally.
    const cursor = bubble?.querySelector('.chat-panel__cursor');
    if (cursor) cursor.remove();

    const indicator = document.createElement('div');
    indicator.className = 'chat-panel__thinking';
    indicator.innerHTML = '<span class="chat-panel__typing-indicator"><span></span><span></span><span></span></span>';
    streamingMsg.appendChild(indicator);
    this.scrollToBottom();
  }

  /**
   * Hide the thinking indicator from the streaming message.
   */
  _hideThinkingIndicator() {
    const streamingMsg = document.getElementById('chat-streaming-msg');
    if (!streamingMsg) return;
    const thinking = streamingMsg.querySelector('.chat-panel__thinking');
    if (thinking) thinking.remove();
  }

  /**
   * Show an error message in the chat
   * @param {string} message - Error text
   */
  _showError(message) {
    const errorEl = document.createElement('div');
    errorEl.className = 'chat-panel__message chat-panel__message--error';
    errorEl.innerHTML = `
      <div class="chat-panel__error-bubble">
        <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
          <path d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z"/>
        </svg>
        ${this._escapeHtml(message)}
      </div>
    `;
    this.messagesEl.appendChild(errorEl);
    this.scrollToBottom();
  }

  /**
   * Show an auto-dismissing toast notification overlaid at the border between
   * the header and messages area.  Appended to the outer .chat-panel container
   * (which has position:relative) so it stays visible regardless of scroll
   * position in the messages area.
   * @param {string} message - Text to display
   */
  _showToast(message) {
    // Remove any existing toast
    const existing = this.panel?.querySelector('.chat-panel__toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'chat-panel__toast';
    toast.textContent = message;

    // Append to the outer chat-panel container so the toast is positioned
    // relative to it (not inside the scrollable messages area).
    if (this.panel) {
      this.panel.appendChild(toast);
    }

    // Auto-dismiss after 2.5 seconds
    setTimeout(() => {
      toast.classList.add('chat-panel__toast--dismissing');
      toast.addEventListener('animationend', () => toast.remove());
    }, 2500);
  }

  /**
   * Post-process a container element to convert [[file:...]] tokens into
   * clickable links that scroll to the file in the diff.
   *
   * Supported formats:
   *   [[file:path/to/file.ext]]           -> file only
   *   [[file:path/to/file.ext:42]]        -> file + line
   *   [[file:path/to/file.ext:42-78]]     -> file + line range
   *
   * Tokens inside <pre> blocks are left untouched.
   *
   * @param {HTMLElement} container - Element whose text nodes to scan
   */
  _linkifyFileReferences(container) {
    if (!container || typeof document.createTreeWalker !== 'function') return;

    const FILE_TOKEN = /\[\[file:([^\]]+?)(?::(\d+)(?:-(\d+))?)?\]\]/g;

    // Collect text nodes that contain tokens (avoid mutating during traversal)
    // NodeFilter.SHOW_TEXT === 4; use literal for environments without NodeFilter global
    const SHOW_TEXT = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4;
    const walker = document.createTreeWalker(container, SHOW_TEXT);
    const candidates = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      // Skip anything inside a <pre> (code block)
      if (node.parentElement?.closest('pre')) continue;
      FILE_TOKEN.lastIndex = 0;
      if (FILE_TOKEN.test(node.textContent)) {
        candidates.push(node);
      }
    }

    for (const node of candidates) {
      const fragment = document.createDocumentFragment();
      const text = node.textContent;
      let lastIndex = 0;

      FILE_TOKEN.lastIndex = 0;
      let match;
      while ((match = FILE_TOKEN.exec(text)) !== null) {
        // Add any text before this match
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const filePath = match[1];
        const lineStart = match[2] || null;
        const lineEnd = match[3] || null;

        // Build the clickable link
        const link = document.createElement('a');
        link.className = 'chat-file-link';
        link.dataset.file = filePath;
        if (lineStart) link.dataset.lineStart = lineStart;
        if (lineEnd) link.dataset.lineEnd = lineEnd;
        link.title = 'View in diff';

        // File icon SVG
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 16 16');
        icon.setAttribute('fill', 'currentColor');
        icon.setAttribute('width', '12');
        icon.setAttribute('height', '12');
        icon.classList.add('chat-file-link__icon');
        const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathEl.setAttribute('d', 'M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z');
        icon.appendChild(pathEl);

        // Display text: show the file reference naturally
        let displayText = filePath;
        if (lineStart && lineEnd) {
          displayText += `:${lineStart}-${lineEnd}`;
        } else if (lineStart) {
          displayText += `:${lineStart}`;
        }

        link.appendChild(icon);
        link.appendChild(document.createTextNode(' ' + displayText));

        fragment.appendChild(link);
        lastIndex = match.index + match[0].length;
      }

      // Add any remaining text after the last match
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }

      node.parentNode.replaceChild(fragment, node);
    }
  }

  /**
   * Handle click on a chat file link. Scrolls to the referenced file and line
   * in the diff view.
   * @param {HTMLElement} linkEl - The clicked .chat-file-link element
   */
  _handleFileLinkClick(linkEl) {
    const file = linkEl.dataset.file;
    if (!file) return;

    const lineStart = linkEl.dataset.lineStart ? parseInt(linkEl.dataset.lineStart, 10) : null;

    if (!window.prManager) return;

    if (lineStart) {
      // When a line is specified, scroll directly to the target row (skip file-level scroll
      // to avoid double-scroll bounce from two competing scrollIntoView calls)
      const escaped = CSS.escape(file);
      const fileWrapper = document.querySelector(`[data-file-name="${escaped}"]`) ||
        document.querySelector(`[data-file-name$="/${escaped}"]`);
      if (!fileWrapper) {
        // File not visible yet — fall back to file-level scroll and retry
        window.prManager.scrollToFile(file);
        setTimeout(() => this._scrollToLine(file, lineStart), 400);
        return;
      }

      this._scrollToLine(file, lineStart, fileWrapper);
    } else {
      window.prManager.scrollToFile(file);
    }
  }

  /**
   * Scroll to a specific line within a file wrapper, with micro-feedback
   * when the target is already visible.
   * @param {string} file - File path
   * @param {number} lineStart - Target line number
   * @param {HTMLElement} [fileWrapper] - Pre-resolved file wrapper element
   */
  _scrollToLine(file, lineStart, fileWrapper) {
    if (!fileWrapper) {
      const escaped = CSS.escape(file);
      fileWrapper = document.querySelector(`[data-file-name="${escaped}"]`) ||
        document.querySelector(`[data-file-name$="/${escaped}"]`);
    }
    if (!fileWrapper) return;

    // Find the target row by line number
    const lineNums = fileWrapper.querySelectorAll('.line-num2');
    let targetRow = null;
    for (const ln of lineNums) {
      if (ln.textContent.trim() === String(lineStart)) {
        targetRow = ln.closest('tr');
        break;
      }
    }
    if (!targetRow) return;

    // Check if the target row is already visible in the viewport
    const rect = targetRow.getBoundingClientRect();
    const isVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;

    if (isVisible) {
      // Already visible — provide micro-feedback instead of scrolling
      this._showLineFeedback(targetRow, lineStart);
    } else {
      // Scroll to the row, then apply highlight
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetRow.classList.add('chat-file-link--highlight');
      setTimeout(() => targetRow.classList.remove('chat-file-link--highlight'), 2000);
    }
  }

  /**
   * Show micro-feedback when a target line is already visible:
   * 1. A brief hop animation (scroll nudge)
   * 2. A temporary gutter arrow indicator
   * @param {HTMLElement} row - The target table row
   * @param {number} lineNum - The line number
   */
  _showLineFeedback(row, lineNum) {
    // Highlight the row
    row.classList.add('chat-file-link--highlight');
    setTimeout(() => row.classList.remove('chat-file-link--highlight'), 2000);

    // Inject a temporary gutter arrow
    const lineNumCell = row.querySelector('.d2h-code-linenumber');
    if (lineNumCell) {
      const arrow = document.createElement('span');
      arrow.className = 'chat-gutter-arrow';
      arrow.textContent = '\u2192'; // →
      lineNumCell.appendChild(arrow);
      // Fade out and remove after 1.5s
      setTimeout(() => {
        arrow.classList.add('chat-gutter-arrow--fade');
        arrow.addEventListener('transitionend', () => arrow.remove(), { once: true });
        // Safety cleanup in case transitionend doesn't fire
        setTimeout(() => arrow.remove(), 500);
      }, 1500);
    }

    // Hop animation — small vertical nudge
    const scrollContainer = document.getElementById('diff-container') ||
      row.closest('.d2h-wrapper') || document.documentElement;
    const currentScroll = scrollContainer.scrollTop;
    scrollContainer.scrollTo({ top: currentScroll - 30, behavior: 'smooth' });
    setTimeout(() => {
      scrollContainer.scrollTo({ top: currentScroll, behavior: 'smooth' });
    }, 150);
  }

  /**
   * Render markdown text to HTML
   * @param {string} text - Markdown text
   * @returns {string} HTML string
   */
  renderMarkdown(text) {
    if (!text) return '';
    // Use the global renderMarkdown if available (from markdown.js utility)
    if (window.renderMarkdown) {
      return window.renderMarkdown(text);
    }
    // Basic fallback: escape and convert newlines
    return this._escapeHtml(text).replace(/\n/g, '<br>');
  }

  /**
   * Render markdown to inline HTML (strips outer <p> wrapper).
   * Useful for context card labels/titles where block-level wrapping is unwanted.
   * @param {string} text - Markdown text
   * @returns {string} Inline HTML string
   */
  _renderInlineMarkdown(text) {
    if (!text) return '';
    const html = this.renderMarkdown(text);
    return html.replace(/^<p>([\s\S]*?)<\/p>\s*$/, '$1');
  }

  /**
   * Escape HTML special characters
   * @param {string} text - Raw text
   * @returns {string} Escaped text
   */
  _escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Auto-scroll messages to bottom
   */
  scrollToBottom() {
    if (this.messagesEl) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }

  /**
   * Update visibility and disabled state of action buttons based on context and streaming state.
   */
  _updateActionButtons() {
    const hasSuggestion = this._contextSource === 'suggestion' && this._contextItemId;
    const hasComment = this._contextSource === 'user' && this._contextItemId;

    // Show the bar only if at least one button is relevant
    const showBar = hasSuggestion || hasComment;
    this.actionBar.style.display = showBar ? '' : 'none';
    this.adoptBtn.style.display = hasSuggestion ? '' : 'none';
    this.dismissSuggestionBtn.style.display = hasSuggestion ? '' : 'none';
    this.updateBtn.style.display = hasComment ? '' : 'none';
    this.dismissCommentBtn.style.display = hasComment ? '' : 'none';

    // Disable while streaming
    this.adoptBtn.disabled = this.isStreaming;
    this.updateBtn.disabled = this.isStreaming;
    this.dismissSuggestionBtn.disabled = this.isStreaming;
    this.dismissCommentBtn.disabled = this.isStreaming;
  }

  /**
   * Handle click on "Adopt with AI edits" button.
   * Sends a message asking the agent to refine and adopt the suggestion.
   */
  _handleAdoptClick() {
    if (this.isStreaming || !this._contextItemId) return;
    this._pendingActionContext = { type: 'adopt', itemId: this._contextItemId };
    this.inputEl.value = 'Based on our conversation, please refine and adopt this AI suggestion.';
    this.sendMessage();
  }

  /**
   * Handle click on "Update comment" button.
   * Sends a message asking the agent to update the user's comment.
   */
  _handleUpdateClick() {
    if (this.isStreaming || !this._contextItemId) return;
    this._pendingActionContext = { type: 'update', itemId: this._contextItemId };
    this.inputEl.value = 'Based on our conversation, please update my comment.';
    this.sendMessage();
  }

  /**
   * Handle click on "Dismiss suggestion" button.
   * Sends a message asking the agent to dismiss the AI suggestion.
   */
  _handleDismissSuggestionClick() {
    if (this.isStreaming || !this._contextItemId) return;
    this._pendingActionContext = { type: 'dismiss-suggestion', itemId: this._contextItemId };
    this.inputEl.value = 'Please dismiss this AI suggestion.';
    this.sendMessage();
  }

  /**
   * Handle click on "Dismiss comment" button.
   * Sends a message asking the agent to dismiss the user comment.
   */
  _handleDismissCommentClick() {
    if (this.isStreaming || !this._contextItemId) return;
    this._pendingActionContext = { type: 'dismiss-comment', itemId: this._contextItemId };
    this.inputEl.value = 'Please delete this comment.';
    this.sendMessage();
  }

  /**
   * Initialize the shared context tooltip with event delegation on the messages area.
   * Uses mouseenter/mouseleave with a short delay to avoid flickering.
   */
  _initContextTooltip() {
    this._ctxTooltipEl = document.createElement('div');
    this._ctxTooltipEl.className = 'chat-panel__ctx-tooltip';
    this._ctxTooltipEl.style.display = 'none';
    document.body.appendChild(this._ctxTooltipEl);
    this._ctxTooltipTimer = null;

    if (!this.messagesEl) return;

    this._onCtxCardEnter = (e) => {
      const card = e.target.closest('.chat-panel__context-card[data-tooltip-body]');
      if (!card) return;
      clearTimeout(this._ctxTooltipTimer);
      this._ctxTooltipTimer = setTimeout(() => this._showContextTooltip(card), 200);
    };

    this._onCtxCardLeave = (e) => {
      const card = e.target.closest('.chat-panel__context-card[data-tooltip-body]');
      if (!card) return;
      clearTimeout(this._ctxTooltipTimer);
      this._ctxTooltipEl.style.display = 'none';
    };

    this.messagesEl.addEventListener('mouseenter', this._onCtxCardEnter, true);
    this.messagesEl.addEventListener('mouseleave', this._onCtxCardLeave, true);
  }

  /**
   * Show the context tooltip positioned relative to a context card element.
   * @param {HTMLElement} card - The context card to show tooltip for
   */
  _showContextTooltip(card) {
    const body = card.dataset.tooltipBody;
    if (!body) return;

    const type = card.dataset.tooltipType;
    const title = card.dataset.tooltipTitle;

    let headerHTML = '';
    if (type || title) {
      headerHTML = `<div class="chat-panel__ctx-tooltip-header">${type ? `<span class="chat-panel__ctx-tooltip-type">${this._renderInlineMarkdown(type)}</span>` : ''}${title ? `<span class="chat-panel__ctx-tooltip-title">${this._renderInlineMarkdown(title)}</span>` : ''}</div>`;
    }

    this._ctxTooltipEl.innerHTML = `${headerHTML}<div class="chat-panel__ctx-tooltip-body">${this.renderMarkdown(body)}</div>`;

    const rect = card.getBoundingClientRect();
    const tooltipHeight = 300; // max-height
    const spaceBelow = window.innerHeight - rect.bottom;

    this._ctxTooltipEl.style.display = '';
    this._ctxTooltipEl.style.left = `${rect.left}px`;

    if (spaceBelow >= tooltipHeight || spaceBelow >= rect.top) {
      // Show below
      this._ctxTooltipEl.style.top = `${rect.bottom + 4}px`;
      this._ctxTooltipEl.style.bottom = '';
    } else {
      // Flip above
      this._ctxTooltipEl.style.top = '';
      this._ctxTooltipEl.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    }
  }

  /**
   * Clean up on page unload
   */
  destroy() {
    document.removeEventListener('keydown', this._onKeydown);
    this._closeGlobalSSE();
    this.messages = [];

    // Clean up context tooltip
    clearTimeout(this._ctxTooltipTimer);
    if (this._ctxTooltipEl && this._ctxTooltipEl.parentNode) {
      this._ctxTooltipEl.parentNode.removeChild(this._ctxTooltipEl);
    }
    this._ctxTooltipEl = null;

    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}

// Make ChatPanel available globally
window.ChatPanel = ChatPanel;

// Export for CommonJS testing environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChatPanel };
}
