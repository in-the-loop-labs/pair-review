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
    this.messages = [];
    this._streamingContent = '';

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
        <div class="chat-panel__header">
          <span class="chat-panel__title">
            <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
              <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25H5c.414 0 .75.336.75.75v1.94l2.22-2.22a.75.75 0 0 1 .53-.22h4.75a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
            </svg>
            Chat with AI
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
        <div class="chat-panel__input-area">
          <textarea class="chat-panel__input" placeholder="Ask about this review..." rows="1"></textarea>
          <button class="chat-panel__send-btn" title="Send" disabled>
            <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
              <path d="M.989 8 .064 2.68a1.342 1.342 0 0 1 1.85-1.462l13.402 5.744a1.13 1.13 0 0 1 0 2.076L1.913 14.782a1.343 1.343 0 0 1-1.85-1.463L.99 8Zm.603-4.776L2.296 7.25h5.954a.75.75 0 0 1 0 1.5H2.296l-.704 4.026L13.788 8Z"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    // Cache element references
    this.panel = this.container.querySelector('#chat-panel');
    this.messagesEl = this.container.querySelector('#chat-messages');
    this.inputEl = this.container.querySelector('.chat-panel__input');
    this.sendBtn = this.container.querySelector('.chat-panel__send-btn');
    this.closeBtn = this.container.querySelector('.chat-panel__close-btn');
    this.newBtn = this.container.querySelector('.chat-panel__new-btn');
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

    // Textarea input handling
    this.inputEl.addEventListener('input', () => {
      this._autoResizeTextarea();
      this.sendBtn.disabled = !this.inputEl.value.trim() || this.isStreaming;
    });

    // Keyboard shortcuts
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (this.inputEl.value.trim() && !this.isStreaming) {
          this.sendMessage();
        }
      }
    });

    // Escape to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
      }
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
   * Open the chat panel
   * @param {Object} options - Optional context
   * @param {number} options.reviewId - Review ID
   * @param {number} options.suggestionId - Suggestion ID to ask about
   * @param {Object} options.suggestionContext - Suggestion details for context
   */
  async open(options = {}) {
    // Resolve reviewId from options or from prManager
    if (options.reviewId) {
      this.reviewId = options.reviewId;
    } else if (window.prManager?.currentPR?.id) {
      this.reviewId = window.prManager.currentPR.id;
    }

    this.isOpen = true;
    this.panel.classList.remove('chat-panel--closed');
    this.panel.classList.add('chat-panel--open');

    // If opening with suggestion context and no active session, start a new session
    if (options.suggestionContext) {
      await this._startNewConversation();
      // Pre-fill the input with context about the suggestion
      const ctx = options.suggestionContext;
      const contextMsg = `Regarding the ${ctx.type || 'AI'} suggestion "${ctx.title || ''}" on file ${ctx.file || ''}${ctx.line_start ? ` (line ${ctx.line_start}${ctx.line_end && ctx.line_end !== ctx.line_start ? '-' + ctx.line_end : ''})` : ''}:\n\n${ctx.body || ctx.reasoning?.join(', ') || ''}\n\nCan you explain this suggestion in more detail?`;
      this.inputEl.value = contextMsg;
      this._autoResizeTextarea();
      this.sendBtn.disabled = false;
    }

    this.inputEl.focus();
  }

  /**
   * Close the chat panel
   */
  close() {
    this.isOpen = false;
    this.panel.classList.remove('chat-panel--open');
    this.panel.classList.add('chat-panel--closed');
    this.disconnectSSE();
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
    this.disconnectSSE();
    this.currentSessionId = null;
    this.messages = [];
    this._streamingContent = '';
    this._clearMessages();
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
   * Create a new chat session via API
   * @param {number} contextCommentId - Optional AI suggestion ID for context
   * @returns {number|null} Session ID or null on failure
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
      return result.data.id;
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

    // Display user message
    this.addMessage('user', content);

    // Ensure we have a session and SSE is connected
    if (!this.currentSessionId) {
      const sessionId = await this.createSession();
      if (!sessionId) return;
      this.connectSSE(this.currentSessionId);
    } else if (!this.eventSource || this.eventSource.readyState === EventSource.CLOSED) {
      // Reconnect SSE if disconnected by close() or error
      this.connectSSE(this.currentSessionId);
    }

    // Prepare streaming UI
    this.isStreaming = true;
    this.sendBtn.disabled = true;
    this._streamingContent = '';
    this._addStreamingPlaceholder();

    // Send to API
    try {
      const response = await fetch(`/api/chat/session/${this.currentSessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to send message');
      }
    } catch (error) {
      console.error('[ChatPanel] Error sending message:', error);
      this._showError('Failed to send message. ' + error.message);
      this._finalizeStreaming();
    }
  }

  /**
   * Connect to SSE stream for a session
   * @param {number} sessionId - Session to stream from
   */
  connectSSE(sessionId) {
    // Don't reconnect if already connected to this session
    if (this.eventSource && this._sseSessionId === sessionId) return;

    this.disconnectSSE();
    this._sseSessionId = sessionId;

    const url = `/api/chat/session/${sessionId}/stream`;
    this.eventSource = new EventSource(url);

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'connected':
            // Session connected, waiting for response
            break;

          case 'delta':
            this._streamingContent += data.text;
            this.updateStreamingMessage(this._streamingContent);
            break;

          case 'tool_use':
            this._showToolUse(data.toolName, data.status);
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
      // Only finalize if the connection is truly closed, not on transient errors
      // (EventSource auto-reconnects on transient errors with readyState=CONNECTING)
      if (this.eventSource?.readyState === EventSource.CLOSED) {
        this._finalizeStreaming();
      }
    };
  }

  /**
   * Close SSE connection
   */
  disconnectSSE() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.isStreaming = false;
    this.sendBtn.disabled = !this.inputEl?.value?.trim();
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

      // Remove cursor
      const cursor = streamingMsg.querySelector('.chat-panel__cursor');
      if (cursor) cursor.remove();

      // Final render
      const bubble = streamingMsg.querySelector('.chat-panel__bubble');
      if (bubble && this._streamingContent) {
        bubble.innerHTML = this.renderMarkdown(this._streamingContent);
      }
    }

    // Store in messages array
    if (this._streamingContent) {
      this.messages.push({ role: 'assistant', content: this._streamingContent, id: messageId });
    }

    this._finalizeStreaming();
  }

  /**
   * Clean up streaming state
   */
  _finalizeStreaming() {
    this.isStreaming = false;
    this._streamingContent = '';
    this.sendBtn.disabled = !this.inputEl?.value?.trim();
    this.inputEl?.focus();
  }

  /**
   * Show a tool use indicator in the streaming message
   * @param {string} toolName - Name of the tool being used
   * @param {string} status - 'start' or 'end'
   */
  _showToolUse(toolName, status) {
    const streamingMsg = document.getElementById('chat-streaming-msg');
    if (!streamingMsg) return;

    if (status === 'start') {
      // Add tool badge before the bubble content
      const badge = document.createElement('div');
      badge.className = 'chat-panel__tool-badge';
      badge.dataset.tool = toolName;
      badge.innerHTML = `
        <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
          <path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
        </svg>
        <span>${this._escapeHtml(toolName)}</span>
        <span class="chat-panel__tool-spinner"></span>
      `;
      streamingMsg.insertBefore(badge, streamingMsg.querySelector('.chat-panel__bubble'));
    } else {
      // Remove spinner from completed tool
      const badges = streamingMsg.querySelectorAll(`.chat-panel__tool-badge[data-tool="${toolName}"]`);
      badges.forEach(b => {
        const spinner = b.querySelector('.chat-panel__tool-spinner');
        if (spinner) spinner.remove();
      });
    }
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
   * Clean up on page unload
   */
  destroy() {
    this.disconnectSSE();
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
