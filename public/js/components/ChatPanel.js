// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * ChatPanel - AI chat sidebar component
 * Provides a sliding chat panel for conversing with AI about the current review.
 * Works in both PR mode and Local mode.
 */

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
    this._resizeConfig = { min: 300, max: 800, default: 400, storageKey: 'chat-panel-width' };
    this._analysisContextRemoved = false;
    this._sessionAnalysisRunId = null; // tracks which AI run ID's context is loaded in the current session

    this._render();
    this._bindEvents();
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
          <span class="chat-panel__title">
            <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
              <path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/>
            </svg>
            Chat &middot; Pi
          </span>
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
            <p>Ask questions about this review, or click "Ask about this" on any suggestion.</p>
          </div>
        </div>
        <div class="chat-panel__action-bar" style="display: none;">
          <button class="chat-panel__action-btn chat-panel__action-btn--adopt" style="display: none;" title="Ask the agent to refine and adopt this suggestion">
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
            </svg>
            Adopt with AI edits
          </button>
          <button class="chat-panel__action-btn chat-panel__action-btn--update" style="display: none;" title="Ask the agent to update your comment based on the conversation">
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
              <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/>
            </svg>
            Update comment
          </button>
        </div>
        <div class="chat-panel__input-area">
          <textarea class="chat-panel__input" placeholder="Ask about this review..." rows="1"></textarea>
          <div class="chat-panel__input-footer">
            <span class="chat-panel__input-hint">${navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter to send</span>
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
    this.titleEl = this.container.querySelector('.chat-panel__title');
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

    // Send button
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    // Stop button
    this.stopBtn.addEventListener('click', () => this._stopAgent());

    // Action buttons
    this.adoptBtn.addEventListener('click', () => this._handleAdoptClick());
    this.updateBtn.addEventListener('click', () => this._handleUpdateClick());

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

    // Escape: stop agent if streaming, otherwise close panel
    this._onKeydown = (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        if (this.isStreaming) {
          this._stopAgent();
        } else {
          this.close();
        }
      }
    };
    document.addEventListener('keydown', this._onKeydown);

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
      this.panel.style.width = newWidth + 'px';
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
   * Auto-resize textarea based on content
   */
  _autoResizeTextarea() {
    const el = this.inputEl;
    el.style.height = 'auto';
    const maxHeight = 120;
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
  }

  /**
   * Update the chat panel title with provider and model info.
   * @param {string} [provider='Pi'] - Provider display name
   * @param {string} [model] - Model ID or display name (e.g. 'default', 'multi-model')
   */
  _updateTitle(provider = 'Pi', model) {
    if (!this.titleEl) return;
    const svg = this.titleEl.querySelector('svg')?.outerHTML || '';
    const modelDisplay = model && model !== 'default'
      ? model.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      : null;
    const parts = ['Chat', provider];
    if (modelDisplay) parts.push(modelDisplay);
    this.titleEl.innerHTML = `${svg}\n            ${this._escapeHtml(parts.join(' \u00b7 '))}`;
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
    // Resolve reviewId from options or from prManager
    if (options.reviewId) {
      this.reviewId = options.reviewId;
    } else if (window.prManager?.currentPR?.id) {
      this.reviewId = window.prManager.currentPR.id;
    }

    // Restore persisted width before opening
    const { min, max, storageKey } = this._resizeConfig;
    const savedWidth = localStorage.getItem(storageKey);
    if (savedWidth) {
      const width = parseInt(savedWidth, 10);
      if (width >= min && width <= max) {
        this.panel.style.width = width + 'px';
      }
    }

    this.isOpen = true;
    this.panel.classList.remove('chat-panel--closed');
    this.panel.classList.add('chat-panel--open');

    // Ensure SSE is connected (but don't create a session yet — lazy creation)
    this._ensureGlobalSSE();

    // Load MRU session with message history (if any previous sessions exist)
    if (!this.currentSessionId) {
      await this._loadMRUSession();
    }

    // If opening with context, ensure analysis context is added first
    if (options.suggestionContext || options.commentContext) {
      this._ensureAnalysisContext();
    }

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

    this._updateActionButtons();
    this.inputEl.focus();
  }

  /**
   * Close the chat panel
   */
  close() {
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
    this._analysisContextRemoved = false;
    this._sessionAnalysisRunId = null;
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
   */
  async _startNewConversation() {
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
  }

  /**
   * Load the most recently used session for the current review.
   * Fetches the session list, picks the MRU, and loads its message history
   * so the user sees their previous conversation when reopening the panel.
   */
  async _loadMRUSession() {
    if (!this.reviewId) return;

    try {
      const response = await fetch(`/api/review/${this.reviewId}/chat/sessions`);
      if (!response.ok) return;

      const result = await response.json();
      const sessions = result.data?.sessions || [];
      if (sessions.length === 0) return;

      // Pick the MRU session (list is already sorted by updated_at DESC)
      const mru = sessions[0];
      this.currentSessionId = mru.id;
      console.debug('[ChatPanel] Loaded MRU session:', mru.id, 'messages:', mru.message_count);

      // Update title with provider/model from the session
      if (mru.provider) {
        const providerName = mru.provider.charAt(0).toUpperCase() + mru.provider.slice(1);
        this._updateTitle(providerName, mru.model);
      }

      // Load message history if the session has messages
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
            if (ctxData.source === 'user') {
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

    // Clear input
    this.inputEl.value = '';
    this._autoResizeTextarea();
    this.sendBtn.disabled = true;

    // Remove empty state if present
    const emptyState = this.messagesEl.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    // Display user message (just the user's actual text)
    this.addMessage('user', content);

    // Lazy session creation: create on first message, not on panel open
    if (!this.currentSessionId) {
      this._ensureGlobalSSE();
      const sessionData = await this.createSession();
      if (!sessionData) return;
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

    // Send to API
    try {
      console.debug('[ChatPanel] Sending message to session', this.currentSessionId);
      const response = await fetch(`/api/chat/session/${this.currentSessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

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
    const contextText = `The user wants to discuss ${fileContext.file}`;

    // Check for duplicate context
    const isDuplicate = this._pendingContext.some(c => c === contextText) ||
      this.messages.some(m => m.role === 'context' && m.content === contextText);
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

    this._pendingContext.push(contextText);

    // Render the compact context card in the UI
    const card = document.createElement('div');
    card.className = 'chat-panel__context-card';

    const idx = this._pendingContextData.length - 1;
    card.dataset.contextIndex = idx;

    card.innerHTML = `
      <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
        <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/>
      </svg>
      <span class="chat-panel__context-label"><strong>FILE</strong></span>
      <span class="chat-panel__context-title">${this._escapeHtml(fileContext.file)}</span>
    `;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'chat-panel__context-remove';
    removeBtn.title = 'Remove context';
    removeBtn.innerHTML = '\u00d7';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._removeContextCard(card);
    });
    card.appendChild(removeBtn);

    this.messagesEl.appendChild(card);
    this.scrollToBottom();
  }

  /**
   * Ensure the latest AI analysis context is added as the first context item.
   * Called when opening the chat with specific context (suggestion or comment).
   * Only adds if not already present and suggestions exist.
   */
  _ensureAnalysisContext() {
    // Skip if analysis context card already exists in the DOM
    if (this.messagesEl.querySelector('.chat-panel__context-card[data-analysis]')) return;

    // Skip if the current session already has analysis context loaded (by run ID)
    if (this._sessionAnalysisRunId) return;

    // Skip if analysis context was explicitly removed in this conversation
    if (this._analysisContextRemoved) return;

    // Count suggestions from the DOM (from the latest analysis run)
    const suggestionEls = typeof document !== 'undefined' && document.querySelectorAll
      ? document.querySelectorAll('.ai-suggestion[data-suggestion-id]')
      : [];
    const count = suggestionEls.length;
    if (count === 0) return;

    // Remove empty state
    const emptyState = this.messagesEl.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    // Render the analysis context card (removable, prepended at the top)
    // Note: analysis card is NOT added to _pendingContext/_pendingContextData —
    // the backend includes full suggestion data via initialContext at session creation.
    // The card is a visual indicator that controls whether the backend includes it.
    this._addAnalysisContextCard({ suggestionCount: count }, { removable: true, prepend: true });

    // Mark that analysis context is loaded for this session (prevents re-adding on reopen)
    this._sessionAnalysisRunId = 'dom';
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
    const fileInfo = ctx.file
      ? `${ctx.file}${ctx.line_start ? ':' + ctx.line_start : ''}`
      : '';

    card.innerHTML = `
      <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
        <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
      </svg>
      <span class="chat-panel__context-label">${this._escapeHtml(label)}</span>
      <span class="chat-panel__context-title">${this._escapeHtml(ctx.body ? (ctx.body.length > 60 ? ctx.body.substring(0, 60) + '...' : ctx.body) : 'Comment')}</span>
      ${fileInfo ? `<span class="chat-panel__context-file">${this._escapeHtml(fileInfo)}</span>` : ''}
    `;

    if (removable) {
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

    this.messagesEl.appendChild(card);
    this.scrollToBottom();
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
      <span class="chat-panel__context-label">${this._escapeHtml(typeLabel)}</span>
      <span class="chat-panel__context-title">${this._escapeHtml(ctx.title || 'Untitled')}</span>
      ${fileInfo ? `<span class="chat-panel__context-file">${this._escapeHtml(fileInfo)}</span>` : ''}
    `;

    if (removable) {
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

    this.messagesEl.appendChild(card);
    this.scrollToBottom();
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
      // Skip if analysis context card already exists (e.g. added by _ensureAnalysisContext on open)
      if (this.messagesEl.querySelector('.chat-panel__context-card[data-analysis]')) return;
      const emptyState = this.messagesEl.querySelector('.chat-panel__empty');
      if (emptyState) emptyState.remove();
      this._addAnalysisContextCard(sessionData.context);

      // Track which run's context is loaded so _ensureAnalysisContext can skip if already present
      this._sessionAnalysisRunId = sessionData.context.aiRunId || 'session';
    }
  }

  /**
   * Add a compact analysis context card to the messages area.
   * Visually indicates that the agent has analysis suggestions loaded as context.
   * @param {Object} context - Context metadata { suggestionCount }
   */
  _addAnalysisContextCard(context, { removable = false, prepend = false } = {}) {
    const card = document.createElement('div');
    card.className = 'chat-panel__context-card';
    card.dataset.analysis = 'true';
    if (context.aiRunId) {
      card.dataset.analysisRunId = context.aiRunId;
    }

    const count = context.suggestionCount;
    const title = count === 1 ? '1 suggestion loaded' : `${count} suggestions loaded`;

    card.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
        <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
      </svg>
      <span class="chat-panel__context-label">analysis run</span>
      <span class="chat-panel__context-title">${this._escapeHtml(title)}</span>
    `;

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
    this.scrollToBottom();
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
    } else {
      bubble.textContent = content;
    }

    msgEl.appendChild(bubble);
    this.messagesEl.appendChild(msgEl);
    this.scrollToBottom();
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

      // Remove any active tool spinners (e.g. abort mid-tool-execution)
      const spinners = streamingMsg.querySelectorAll('.chat-panel__tool-spinner');
      spinners.forEach(s => s.remove());

      // Final render
      const bubble = streamingMsg.querySelector('.chat-panel__bubble');
      if (bubble) {
        if (this._streamingContent) {
          bubble.innerHTML = this.renderMarkdown(this._streamingContent);
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

    if (status === 'start') {
      this._hideThinkingIndicator();
      const argSummary = this._summarizeToolInput(toolName, toolInput);

      // Add tool badge before the bubble content
      const badge = document.createElement('div');
      badge.className = 'chat-panel__tool-badge';
      badge.dataset.tool = toolName;
      badge.innerHTML = `
        <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
          <path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
        </svg>
        <span>${this._escapeHtml(toolName)}</span>${argSummary ? `<span class="chat-panel__tool-args" title="${this._escapeHtml(argSummary)}">${this._escapeHtml(argSummary)}</span>` : ''}
        <span class="chat-panel__tool-spinner"></span>
      `;
      // Insert before the bubble so tool calls stack above the response text
      const bubble = streamingMsg.querySelector('.chat-panel__bubble');
      streamingMsg.insertBefore(badge, bubble);
    } else {
      // Remove spinner from completed tool
      const badges = streamingMsg.querySelectorAll(`.chat-panel__tool-badge[data-tool="${toolName}"]`);
      badges.forEach(b => {
        const spinner = b.querySelector('.chat-panel__tool-spinner');
        if (spinner) spinner.remove();
      });
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
    this.updateBtn.style.display = hasComment ? '' : 'none';

    // Disable while streaming
    this.adoptBtn.disabled = this.isStreaming;
    this.updateBtn.disabled = this.isStreaming;
  }

  /**
   * Handle click on "Adopt with AI edits" button.
   * Sends a message asking the agent to refine and adopt the suggestion.
   */
  _handleAdoptClick() {
    if (this.isStreaming || !this._contextItemId) return;
    const id = this._contextItemId;
    this.inputEl.value = `Based on our conversation, please refine the original AI suggestion and adopt it using the pair-review API. The suggestion ID is ${id}.`;
    this.sendMessage();
  }

  /**
   * Handle click on "Update comment" button.
   * Sends a message asking the agent to update the user's comment.
   */
  _handleUpdateClick() {
    if (this.isStreaming || !this._contextItemId) return;
    const id = this._contextItemId;
    this.inputEl.value = `Based on our conversation, please update my comment using the pair-review API. The comment ID is ${id}.`;
    this.sendMessage();
  }

  /**
   * Clean up on page unload
   */
  destroy() {
    document.removeEventListener('keydown', this._onKeydown);
    this._closeGlobalSSE();
    this.messages = [];
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
