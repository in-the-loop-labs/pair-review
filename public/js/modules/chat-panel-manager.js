// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * ChatPanelManager - AI Chat Panel UI
 * Manages sidebar chat panel for asking follow-up questions about comments
 */

class ChatPanelManager {
  /**
   * Create a new ChatPanelManager instance
   * @param {Object} prManagerRef - Reference to PRManager
   */
  constructor(prManagerRef) {
    this.prManager = prManagerRef;
    this.activeChatSessions = new Map(); // chatId -> { commentId, eventSource, comment }
    this.currentChatId = null;
    this.panel = null;
    this.isLocalMode = false; // Will be set by LocalManager if needed
    this.streamingContent = ''; // Accumulate streaming text for markdown rendering
  }

  /**
   * Initialize the chat panel DOM structure
   */
  initializePanel() {
    // Check if panel already exists
    if (document.getElementById('chat-panel')) {
      this.panel = document.getElementById('chat-panel');
      return;
    }

    // Create panel HTML
    const panelHtml = `
      <div id="chat-panel" class="chat-panel collapsed">
        <div class="resize-handle resize-handle-left" data-panel="chat-panel"></div>
        <div class="chat-panel-header">
          <div class="chat-title">
            <span class="chat-header-title">Chat</span>
          </div>
          <button class="chat-close-btn" title="Close chat panel">×</button>
        </div>

        <div class="chat-comment-context">
          <!-- Comment context will be injected here -->
        </div>

        <div class="chat-messages">
          <!-- Messages will be added here -->
        </div>

        <div class="chat-input-container">
          <textarea class="chat-input" placeholder="Ask a follow-up question..." rows="3"></textarea>
          <div class="chat-input-actions">
            <span class="chat-input-hint"><kbd>Cmd</kbd>+<kbd>Enter</kbd> to send</span>
            <button class="chat-send-btn">Send</button>
          </div>
        </div>

        <div class="chat-actions" style="display: none;">
          <button class="chat-adopt-btn" title="Ask AI to refine the suggestion based on your conversation, then adopt it">
            <svg class="octicon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path fill-rule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"></path>
            </svg>
            Adopt with AI Edits
          </button>
        </div>
      </div>
    `;

    // Insert panel into DOM as direct child of body (outside app container)
    // This allows the panel to be positioned fixed on the right while
    // the main content shrinks to make room for it
    document.body.insertAdjacentHTML('beforeend', panelHtml);

    this.panel = document.getElementById('chat-panel');

    // Attach event listeners
    this._attachEventListeners();
  }

  /**
   * Attach event listeners to panel elements
   * @private
   */
  _attachEventListeners() {
    if (!this.panel) return;

    // Close button
    const closeBtn = this.panel.querySelector('.chat-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.closePanel());
    }

    // Send button and Enter key
    const sendBtn = this.panel.querySelector('.chat-send-btn');
    const input = this.panel.querySelector('.chat-input');

    if (sendBtn) {
      sendBtn.addEventListener('click', () => this._sendMessage());
    }

    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          this._sendMessage();
        }
      });
    }

    // Adopt with AI Edits button
    const adoptBtn = this.panel.querySelector('.chat-adopt-btn');
    if (adoptBtn) {
      adoptBtn.addEventListener('click', () => this._adoptWithAIEdits());
    }
  }

  /**
   * Open chat for a specific comment
   * @param {number} commentId - Comment ID
   * @param {Object} comment - Comment object with details
   */
  async openChat(commentId, comment) {
    // Initialize panel if not done yet
    if (!this.panel) {
      this.initializePanel();
    }

    // Check if we already have an active chat for this comment
    const existingSession = Array.from(this.activeChatSessions.values())
      .find(session => session.commentId === commentId);

    if (existingSession) {
      // Switch to existing chat
      this.switchChat(existingSession.chatId);
      return;
    }

    // Start a new chat session
    try {
      const endpoint = this.isLocalMode
        ? `/api/local/${this.prManager.reviewId}/chat/start`
        : '/api/chat/start';

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId })
      });

      if (!response.ok) {
        throw new Error(`Failed to start chat: ${response.statusText}`);
      }

      const data = await response.json();

      // Store session info
      this.activeChatSessions.set(data.chatId, {
        chatId: data.chatId,
        commentId: commentId,
        comment: data.comment || comment,
        provider: data.provider,
        model: data.model,
        eventSource: null
      });

      // Switch to this chat
      this.switchChat(data.chatId);

      // Setup SSE streaming
      this._setupEventStream(data.chatId);

      console.log(`Chat session started: ${data.chatId}`);

    } catch (error) {
      console.error('Error starting chat:', error);
      alert(`Failed to start chat: ${error.message}`);
    }
  }

  /**
   * Switch to a different active chat
   * @param {string} chatId - Chat session ID to switch to
   */
  async switchChat(chatId) {
    const session = this.activeChatSessions.get(chatId);
    if (!session) {
      console.error(`Chat session not found: ${chatId}`);
      return;
    }

    this.currentChatId = chatId;

    // Reset input state when switching chats
    this._resetInputState();

    // Update panel to show this chat
    this._renderChatContext(session);
    await this._loadChatMessages(chatId);

    // Expand panel if collapsed
    if (this.panel.classList.contains('collapsed')) {
      this.panel.classList.remove('collapsed');
      this.panel.classList.add('expanded');
    }

    // Add class to body to trigger layout shift (push content left)
    document.body.classList.add('chat-panel-open');

    // Highlight the comment in the diff
    this._highlightComment(session.commentId);
  }

  /**
   * Reset the input area to a clean state
   * @private
   */
  _resetInputState() {
    if (!this.panel) return;

    const input = this.panel.querySelector('.chat-input');
    const sendBtn = this.panel.querySelector('.chat-send-btn');

    if (input) {
      input.value = '';
      input.disabled = false;
    }

    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    }

    // Also reset streaming content accumulator
    this.streamingContent = '';
  }

  /**
   * Render the comment context in the panel
   * @private
   * @param {Object} session - Chat session object
   */
  _renderChatContext(session) {
    const contextDiv = this.panel.querySelector('.chat-comment-context');
    if (!contextDiv) return;

    const comment = session.comment;
    const lineInfo = comment.line_start
      ? `L${comment.line_start}${comment.line_end && comment.line_end !== comment.line_start ? `-${comment.line_end}` : ''}`
      : '';

    // Get file icon based on extension
    const fileIcon = this._getFileIcon(comment.file);

    const contextHtml = `
      <div class="chat-context-card">
        <div class="chat-context-file">
          <span class="chat-context-file-icon">${fileIcon}</span>
          <span class="chat-context-file-path">${this._escapeHtml(comment.file || 'File-level comment')}</span>
          ${lineInfo ? `<span class="chat-context-line-badge">${lineInfo}</span>` : ''}
        </div>
        <div class="chat-context-meta">
          <span class="chat-context-badge ${comment.type || 'comment'}">${comment.type || 'comment'}</span>
          <span class="chat-context-source">${comment.source === 'ai' ? 'AI Suggestion' : 'User Comment'}</span>
        </div>
      </div>
    `;

    contextDiv.innerHTML = contextHtml;

    // Always show the "Adopt with AI Edits" button for consistency
    const chatActionsDiv = this.panel.querySelector('.chat-actions');
    if (chatActionsDiv) {
      chatActionsDiv.style.display = 'block';
    }

    // Update header title to show the comment title (or fallback to filename)
    const titleSpan = this.panel.querySelector('.chat-header-title');
    if (titleSpan) {
      if (comment.title) {
        titleSpan.textContent = comment.title;
      } else {
        const filename = comment.file ? comment.file.split('/').pop() : 'Comment';
        titleSpan.textContent = filename;
      }
    }
  }

  /**
   * Get an appropriate icon for a file type
   * @private
   * @param {string} filePath - Path to the file
   * @returns {string} Icon SVG or character
   */
  _getFileIcon(filePath) {
    if (!filePath) return '';

    // Return a simple file icon SVG
    return '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 1.5a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 8 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v9.086A1.75 1.75 0 0 1 12.25 16h-8.5A1.75 1.75 0 0 1 2 14.25V1.75z"/></svg>';
  }

  /**
   * Load and display chat messages
   * @private
   * @param {string} chatId - Chat session ID
   */
  async _loadChatMessages(chatId) {
    try {
      const endpoint = this.isLocalMode
        ? `/api/local/${this.prManager.reviewId}/chat/${chatId}/messages`
        : `/api/chat/${chatId}/messages`;

      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error(`Failed to load messages: ${response.statusText}`);
      }

      const data = await response.json();
      const messages = data.session?.messages || [];

      this._renderMessages(messages);

    } catch (error) {
      console.error('Error loading chat messages:', error);
      this._addErrorMessage(`Failed to load messages: ${error.message}`);
    }
  }

  /**
   * Render messages in the chat panel
   * @private
   * @param {Array} messages - Array of message objects
   */
  _renderMessages(messages) {
    const messagesDiv = this.panel.querySelector('.chat-messages');
    if (!messagesDiv) return;

    messagesDiv.innerHTML = '';

    messages.forEach(msg => {
      this._appendMessage(msg.role, msg.content);
    });

    // Scroll to bottom
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  /**
   * Append a single message to the chat
   * @private
   * @param {string} role - 'user' or 'assistant'
   * @param {string} content - Message content
   */
  _appendMessage(role, content) {
    const messagesDiv = this.panel.querySelector('.chat-messages');
    if (!messagesDiv) return;

    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}`;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'chat-message-content';

    // Render markdown for assistant messages, plain text for user
    if (role === 'assistant') {
      contentDiv.innerHTML = this._renderMarkdown(content);
    } else {
      contentDiv.textContent = content;
    }

    messageDiv.appendChild(contentDiv);

    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  /**
   * Render markdown content to HTML
   * Uses the global renderMarkdown function from markdown.js (markdown-it based)
   * @private
   * @param {string} text - Markdown text
   * @returns {string} HTML string
   */
  _renderMarkdown(text) {
    if (!text) return '';

    // Use the global markdown renderer (from /js/utils/markdown.js)
    // which uses markdown-it with proper security settings
    if (typeof window !== 'undefined' && window.renderMarkdown) {
      return window.renderMarkdown(text);
    }

    // Fallback: escape HTML and convert basic formatting
    let html = this._escapeHtml(text);

    // Basic formatting fallback
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  /**
   * Send a message in the current chat
   * @private
   */
  async _sendMessage() {
    if (!this.currentChatId) {
      alert('No active chat session');
      return;
    }

    const input = this.panel.querySelector('.chat-input');
    const sendBtn = this.panel.querySelector('.chat-send-btn');

    if (!input) return;

    const content = input.value.trim();
    if (!content) return;

    // Disable input while sending
    input.disabled = true;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';

    try {
      // Add user message to UI immediately
      this._appendMessage('user', content);
      input.value = '';

      // Add a placeholder for the assistant's response
      const messagesDiv = this.panel.querySelector('.chat-messages');
      const assistantPlaceholder = document.createElement('div');
      assistantPlaceholder.className = 'chat-message assistant streaming';
      assistantPlaceholder.innerHTML = `
        <div class="chat-message-content">
          <span class="typing-indicator"><span></span><span></span><span></span></span>
        </div>
      `;
      messagesDiv.appendChild(assistantPlaceholder);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;

      // Send message to backend
      const endpoint = this.isLocalMode
        ? `/api/local/${this.prManager.reviewId}/chat/${this.currentChatId}/message`
        : `/api/chat/${this.currentChatId}/message`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });

      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.statusText}`);
      }

      const data = await response.json();

      // Remove placeholder and add actual response
      // (SSE stream should have already populated this, but fallback to response)
      assistantPlaceholder.remove();
      if (data.response) {
        this._appendMessage('assistant', data.response);
      }

    } catch (error) {
      console.error('Error sending message:', error);
      this._addErrorMessage(`Failed to send message: ${error.message}`);
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
      input.focus();
    }
  }

  /**
   * Setup SSE event stream for real-time responses
   * @private
   * @param {string} chatId - Chat session ID
   */
  _setupEventStream(chatId) {
    const session = this.activeChatSessions.get(chatId);
    if (!session) return;

    // Close existing event source if any
    if (session.eventSource) {
      session.eventSource.close();
    }

    const endpoint = this.isLocalMode
      ? `/api/local/${this.prManager.reviewId}/chat/${chatId}/stream`
      : `/api/chat/${chatId}/stream`;

    const eventSource = new EventSource(endpoint);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'connected') {
        console.log(`SSE connected for chat ${chatId}`);
      } else if (data.type === 'chunk') {
        // Update the streaming message content
        this._updateStreamingMessage(data.content);
      } else if (data.type === 'done') {
        // Finalize the streaming message
        this._finalizeStreamingMessage();
      } else if (data.type === 'error') {
        console.error('SSE error:', data.error);
        this._addErrorMessage(data.error);
      }
    };

    eventSource.onerror = (error) => {
      console.error('SSE connection error:', error);
      eventSource.close();
    };

    session.eventSource = eventSource;
  }

  /**
   * Update streaming message content
   * @private
   * @param {string} chunk - Text chunk to append
   */
  _updateStreamingMessage(chunk) {
    const messagesDiv = this.panel.querySelector('.chat-messages');
    if (!messagesDiv) return;

    let streamingMsg = messagesDiv.querySelector('.chat-message.streaming');

    if (!streamingMsg) {
      // Reset streaming content accumulator
      this.streamingContent = '';
      // Create new streaming message
      streamingMsg = document.createElement('div');
      streamingMsg.className = 'chat-message assistant streaming';
      streamingMsg.innerHTML = `
        <div class="chat-message-content"></div>
      `;
      messagesDiv.appendChild(streamingMsg);
    }

    // Accumulate the content
    this.streamingContent += chunk;

    const contentDiv = streamingMsg.querySelector('.chat-message-content');
    if (contentDiv) {
      // Render markdown as we stream (for better UX)
      contentDiv.innerHTML = this._renderMarkdown(this.streamingContent);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
  }

  /**
   * Finalize streaming message
   * @private
   */
  _finalizeStreamingMessage() {
    const messagesDiv = this.panel.querySelector('.chat-messages');
    if (!messagesDiv) return;

    const streamingMsg = messagesDiv.querySelector('.chat-message.streaming');
    if (streamingMsg) {
      // Final render of accumulated content
      const contentDiv = streamingMsg.querySelector('.chat-message-content');
      if (contentDiv && this.streamingContent) {
        contentDiv.innerHTML = this._renderMarkdown(this.streamingContent);
      }
      streamingMsg.classList.remove('streaming');
    }

    // Reset streaming content
    this.streamingContent = '';
  }

  /**
   * Add an error message to the chat
   * @private
   * @param {string} errorMsg - Error message
   */
  _addErrorMessage(errorMsg) {
    const messagesDiv = this.panel.querySelector('.chat-messages');
    if (!messagesDiv) return;

    const errorDiv = document.createElement('div');
    errorDiv.className = 'chat-message error';
    errorDiv.innerHTML = `
      <div class="chat-message-content">
        <strong>Error:</strong> ${this._escapeHtml(errorMsg)}
      </div>
    `;

    messagesDiv.appendChild(errorDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  /**
   * Highlight a comment in the diff view
   * @private
   * @param {number} commentId - Comment ID to highlight
   */
  _highlightComment(commentId) {
    // Remove previous highlights
    document.querySelectorAll('.comment-highlighted').forEach(el => {
      el.classList.remove('comment-highlighted');
    });

    // Find and highlight the comment
    const commentEl = document.querySelector(`[data-comment-id="${commentId}"]`);
    if (commentEl) {
      commentEl.classList.add('comment-highlighted');
      commentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /**
   * Adopt the suggestion with AI-refined edits based on the conversation
   * @private
   */
  async _adoptWithAIEdits() {
    if (!this.currentChatId) {
      alert('No active chat session');
      return;
    }

    const session = this.activeChatSessions.get(this.currentChatId);
    if (!session) {
      alert('Chat session not found');
      return;
    }

    const adoptBtn = this.panel.querySelector('.chat-adopt-btn');
    if (!adoptBtn) return;

    // Disable button and show loading state
    adoptBtn.disabled = true;
    const originalText = adoptBtn.innerHTML;
    adoptBtn.innerHTML = `
      <span class="typing-indicator"><span></span><span></span><span></span></span>
      Refining...
    `;

    try {
      // Call the backend to generate a refined suggestion
      const endpoint = this.isLocalMode
        ? `/api/local/${this.prManager.reviewId}/chat/${this.currentChatId}/adopt`
        : `/api/chat/${this.currentChatId}/adopt`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        throw new Error(`Failed to refine suggestion: ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.refinedText) {
        throw new Error('No refined text received from AI');
      }

      // Add the refined suggestion as a message in the chat
      this._appendMessage('assistant', `**Refined Suggestion:**\n\n${data.refinedText}`);

      // Now adopt the suggestion with the refined text
      // We need to update the suggestion's body text before adopting
      const suggestionId = comment.id;

      // Find the suggestion element and update its text
      const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);
      if (suggestionDiv) {
        const bodyDiv = suggestionDiv.querySelector('.ai-suggestion-body');
        if (bodyDiv) {
          // Store the refined text for adoption
          bodyDiv.dataset.refinedText = data.refinedText;
        }
      }

      // Call prManager to adopt with the refined text
      if (this.prManager?.adoptSuggestionWithText) {
        await this.prManager.adoptSuggestionWithText(suggestionId, data.refinedText);
      } else if (this.prManager?.adoptAndEditSuggestion) {
        // Fallback: adopt and edit so user can review
        await this.prManager.adoptAndEditSuggestion(suggestionId);
        // After adoption, update the textarea with refined text
        setTimeout(() => {
          const textarea = document.querySelector(`.user-comment-edit-form textarea`);
          if (textarea) {
            textarea.value = data.refinedText;
            textarea.dispatchEvent(new Event('input'));
          }
        }, 100);
      }

      // Close the chat panel after successful adoption
      this.closePanel();

    } catch (error) {
      console.error('Error adopting with AI edits:', error);
      this._addErrorMessage(`Failed to adopt with AI edits: ${error.message}`);
    } finally {
      adoptBtn.disabled = false;
      adoptBtn.innerHTML = originalText;
    }
  }

  /**
   * Close the chat panel
   */
  closePanel() {
    if (!this.panel) return;

    this.panel.classList.remove('expanded');
    this.panel.classList.add('collapsed');

    // Remove class from body to restore layout
    document.body.classList.remove('chat-panel-open');

    // Close all event sources
    this.activeChatSessions.forEach(session => {
      if (session.eventSource) {
        session.eventSource.close();
      }
    });
  }

  /**
   * Escape HTML to prevent XSS
   * @private
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChatPanelManager };
}

// Export to window for browser usage
if (typeof window !== 'undefined') {
  window.ChatPanelManager = ChatPanelManager;
  console.log('[ChatPanelManager] v12: Added Adopt with AI Edits feature');
}
