/**
 * AI Suggestion Navigation Sidebar Component
 * Shows navigation controls and list of all AI suggestions
 */
class SuggestionNavigator {
  constructor() {
    this.suggestions = [];
    this.currentSuggestionIndex = -1;
    this.isCollapsed = false;
    this.element = null;
    this.collapseToggle = null;
    
    this.init();
    this.bindEvents();
  }

  /**
   * Initialize the navigator component
   */
  init() {
    this.createElement();
    this.setupKeyboardShortcuts();
  }

  /**
   * Create the navigator DOM structure
   */
  createElement() {
    // Main sidebar container
    this.element = document.createElement('div');
    this.element.className = 'suggestion-navigator';
    this.element.innerHTML = `
      <div class="navigator-header">
        <h3>AI Suggestions</h3>
        <button class="navigator-toggle" title="Collapse sidebar">
          <svg viewBox="0 0 16 16">
            <path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0114.25 14H1.75A1.75 1.75 0 010 12.25v-8.5zm1.75-.25a.25.25 0 00-.25.25v8.5c0 .138.112.25.25.25H9.5v-9H1.75zm9.25 9h3.25a.25.25 0 00.25-.25v-8.5a.25.25 0 00-.25-.25H11v9z"/>
          </svg>
        </button>
      </div>
      <div class="navigator-controls">
        <div class="suggestion-counter">
          <span id="current-suggestion">0</span> of <span id="total-suggestions">0</span> suggestions
        </div>
        <div class="navigation-buttons">
          <button class="nav-btn nav-prev" title="Previous suggestion (k)">
            <svg viewBox="0 0 16 16">
              <path d="M3.22 9.78a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0l4.25 4.25a.75.75 0 01-1.06 1.06L8 6.06 4.28 9.78a.75.75 0 01-1.06 0z"/>
            </svg>
          </button>
          <button class="nav-btn nav-next" title="Next suggestion (j)">
            <svg viewBox="0 0 16 16">
              <path d="M12.78 6.22a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06 0L3.22 7.28a.75.75 0 011.06-1.06L8 9.94l3.72-3.72a.75.75 0 011.06 0z"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="suggestions-list">
        <!-- Suggestions will be populated here -->
      </div>
    `;

    // Collapsed toggle button
    this.collapseToggle = document.createElement('button');
    this.collapseToggle.className = 'navigator-toggle-collapsed';
    this.collapseToggle.style.display = 'none';
    this.collapseToggle.title = 'Show AI suggestions sidebar';
    this.collapseToggle.innerHTML = `
      <svg viewBox="0 0 16 16">
        <path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0114.25 14H1.75A1.75 1.75 0 010 12.25v-8.5zm1.75-.25a.25.25 0 00-.25.25v8.5c0 .138.112.25.25.25H9.5v-9H1.75zm9.25 9h3.25a.25.25 0 00.25-.25v-8.5a.25.25 0 00-.25-.25H11v9z"/>
      </svg>
    `;

    // Append to body
    document.body.appendChild(this.element);
    document.body.appendChild(this.collapseToggle);
  }

  /**
   * Bind event handlers
   */
  bindEvents() {
    // Toggle collapse/expand
    const toggleBtn = this.element.querySelector('.navigator-toggle');
    toggleBtn.addEventListener('click', () => this.toggleCollapse());
    
    this.collapseToggle.addEventListener('click', () => this.toggleCollapse());

    // Navigation buttons
    const prevBtn = this.element.querySelector('.nav-prev');
    const nextBtn = this.element.querySelector('.nav-next');
    
    prevBtn.addEventListener('click', () => this.goToPrevious());
    nextBtn.addEventListener('click', () => this.goToNext());
  }

  /**
   * Setup keyboard shortcuts
   */
  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Only handle shortcuts when not in input fields
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return;
      }

      if (e.key === 'j' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        this.goToNext();
      } else if (e.key === 'k' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        this.goToPrevious();
      }
    });
  }

  /**
   * Update suggestions and rebuild the list
   */
  updateSuggestions(suggestions) {
    this.suggestions = suggestions.filter(s => s.status !== 'dismissed');
    this.currentSuggestionIndex = -1;
    this.renderSuggestionsList();
    this.updateCounter();
    this.updateNavigationButtons();
    
    // Show/hide navigator based on suggestions
    if (this.suggestions.length === 0) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Render the suggestions list
   */
  renderSuggestionsList() {
    const listContainer = this.element.querySelector('.suggestions-list');
    
    if (this.suggestions.length === 0) {
      listContainer.innerHTML = '<div class="no-suggestions">No AI suggestions available</div>';
      return;
    }

    listContainer.innerHTML = this.suggestions.map((suggestion, index) => {
      const typeIcon = this.getTypeIcon(suggestion.type);
      const preview = this.truncateText(suggestion.title || suggestion.body || '', 60);
      
      return `
        <div class="suggestion-item" data-index="${index}" data-id="${suggestion.id}" data-type="${suggestion.type}">
          <div class="suggestion-type-icon">${typeIcon}</div>
          <div class="suggestion-content">
            <div class="suggestion-preview">${this.escapeHtml(preview)}</div>
            <span class="type-badge type-${suggestion.type}">${suggestion.type}</span>
          </div>
        </div>
      `;
    }).join('');

    // Add click handlers to suggestion items
    listContainer.querySelectorAll('.suggestion-item').forEach((item, index) => {
      item.addEventListener('click', () => this.goToSuggestion(index));
    });
  }

  /**
   * Get icon SVG for suggestion type
   */
  getTypeIcon(type) {
    const icons = {
      praise: `<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M14 6l-4.9-.64L7 1 4.9 5.36 0 6l3.6 3.26L2.67 14 7 11.67 11.33 14l-.93-4.74z"/></svg>`,
      bug: `<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M4.72.22a.75.75 0 0 1 1.06 0l1 .999a3.488 3.488 0 0 1 2.441 0l.999-1a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.775.776c.616.63.995 1.493.995 2.444v.327c0 .1-.009.197-.025.292.408.14.764.392 1.029.722l1.968-.787a.75.75 0 0 1 .556 1.392L13 7.258V9h2.25a.75.75 0 0 1 0 1.5H13v.5c0 .409-.049.806-.141 1.186l2.17.868a.75.75 0 0 1-.557 1.392l-2.184-.873A4.997 4.997 0 0 1 8 16a4.997 4.997 0 0 1-4.288-2.427l-2.183.873a.75.75 0 0 1-.558-1.392l2.17-.868A5.036 5.036 0 0 1 3 11v-.5H.75a.75.75 0 0 1 0-1.5H3V7.258L.971 6.446a.75.75 0 0 1 .558-1.392l1.967.787c.265-.33.62-.583 1.03-.722a1.677 1.677 0 0 1-.026-.292V4.5c0-.951.38-1.814.995-2.444L4.72 1.28a.75.75 0 0 1 0-1.06Zm.53 6.28a.75.75 0 0 0-.75.75V11a3.5 3.5 0 1 0 7 0V7.25a.75.75 0 0 0-.75-.75Zm-.75 3.5A2 2 0 0 0 6.5 12a2 2 0 0 0 2-2Z"/></svg>`,
      security: `<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M7.467.133a1.748 1.748 0 0 1 1.066 0l5.25 1.68A1.75 1.75 0 0 1 15 3.48V7c0 1.566-.32 3.182-1.303 4.682-.983 1.498-2.585 2.813-5.032 3.855a1.697 1.697 0 0 1-1.33 0c-2.447-1.042-4.049-2.357-5.032-3.855C1.32 10.182 1 8.566 1 7V3.48a1.75 1.75 0 0 1 1.217-1.667Zm.61 1.429a.25.25 0 0 0-.153 0l-5.25 1.68a.25.25 0 0 0-.174.238V7c0 1.358.275 2.666 1.057 3.86.784 1.194 2.121 2.34 4.366 3.297a.196.196 0 0 0 .154 0c2.245-.956 3.582-2.104 4.366-3.298C13.225 9.666 13.5 8.36 13.5 7V3.48a.251.251 0 0 0-.174-.237l-5.25-1.68ZM8.75 4.75v3a.75.75 0 0 1-1.5 0v-3a.75.75 0 0 1 1.5 0ZM9 10.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>`,
      design: `<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>`,
      improvement: `<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 01-1.484.211c-.04-.282-.163-.547-.37-.847a8.695 8.695 0 00-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.75.75 0 01-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75zM6 15.25a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75zM5.75 12a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5z"/></svg>`,
      performance: `<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 01-1.484.211c-.04-.282-.163-.547-.37-.847a8.695 8.695 0 00-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.75.75 0 01-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75zM6 15.25a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75zM5.75 12a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5z"/></svg>`
    };
    
    return icons[type] || icons.improvement;
  }

  /**
   * Navigate to specific suggestion by index
   */
  goToSuggestion(index) {
    if (index < 0 || index >= this.suggestions.length) {
      return;
    }

    this.currentSuggestionIndex = index;
    this.updateCounter();
    this.updateNavigationButtons();
    this.highlightCurrentSuggestion();
    this.scrollToSuggestion();
  }

  /**
   * Navigate to next suggestion
   */
  goToNext() {
    if (this.suggestions.length === 0) return;
    
    const nextIndex = (this.currentSuggestionIndex + 1) % this.suggestions.length;
    this.goToSuggestion(nextIndex);
  }

  /**
   * Navigate to previous suggestion
   */
  goToPrevious() {
    if (this.suggestions.length === 0) return;
    
    const prevIndex = this.currentSuggestionIndex <= 0 
      ? this.suggestions.length - 1 
      : this.currentSuggestionIndex - 1;
    this.goToSuggestion(prevIndex);
  }

  /**
   * Update suggestion counter display
   */
  updateCounter() {
    const currentEl = this.element.querySelector('#current-suggestion');
    const totalEl = this.element.querySelector('#total-suggestions');
    
    currentEl.textContent = this.currentSuggestionIndex >= 0 ? this.currentSuggestionIndex + 1 : 0;
    totalEl.textContent = this.suggestions.length;
  }

  /**
   * Update navigation button states
   */
  updateNavigationButtons() {
    const prevBtn = this.element.querySelector('.nav-prev');
    const nextBtn = this.element.querySelector('.nav-next');
    
    prevBtn.disabled = this.suggestions.length === 0;
    nextBtn.disabled = this.suggestions.length === 0;
  }

  /**
   * Highlight current suggestion in list and diff
   */
  highlightCurrentSuggestion() {
    // Clear previous highlights
    this.element.querySelectorAll('.suggestion-item').forEach(item => {
      item.classList.remove('current');
    });

    // Highlight current suggestion in list
    if (this.currentSuggestionIndex >= 0) {
      const currentItem = this.element.querySelector(`[data-index="${this.currentSuggestionIndex}"]`);
      if (currentItem) {
        currentItem.classList.add('current');
      }
    }

    // Highlight in diff view
    this.highlightSuggestionInDiff();
  }

  /**
   * Highlight current suggestion in the diff view
   */
  highlightSuggestionInDiff() {
    // Remove previous highlights
    document.querySelectorAll('.ai-suggestion').forEach(el => {
      el.classList.remove('current-suggestion');
    });

    if (this.currentSuggestionIndex >= 0) {
      const currentSuggestion = this.suggestions[this.currentSuggestionIndex];
      const suggestionEl = document.querySelector(`[data-suggestion-id="${currentSuggestion.id}"]`);
      
      if (suggestionEl) {
        suggestionEl.classList.add('current-suggestion');
        // Add pulsing animation
        suggestionEl.style.animation = 'pulse 2s ease-in-out';
        setTimeout(() => {
          suggestionEl.style.animation = '';
        }, 2000);
      }
    }
  }

  /**
   * Scroll to current suggestion in diff view
   */
  scrollToSuggestion() {
    if (this.currentSuggestionIndex >= 0) {
      const currentSuggestion = this.suggestions[this.currentSuggestionIndex];
      const suggestionEl = document.querySelector(`[data-suggestion-id="${currentSuggestion.id}"]`);
      
      if (suggestionEl) {
        suggestionEl.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'center',
          inline: 'nearest'
        });
      }
    }
  }

  /**
   * Toggle collapsed state
   */
  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
    
    if (this.isCollapsed) {
      this.element.style.display = 'none';
      this.collapseToggle.style.display = 'flex';
      
      // Adjust main content
      const mainContent = document.querySelector('.main-content');
      if (mainContent) {
        mainContent.classList.add('navigator-collapsed');
      }
    } else {
      this.element.style.display = 'flex';
      this.collapseToggle.style.display = 'none';
      
      // Adjust main content
      const mainContent = document.querySelector('.main-content');
      if (mainContent) {
        mainContent.classList.remove('navigator-collapsed');
      }
    }
  }

  /**
   * Show the navigator
   */
  show() {
    if (!this.isCollapsed) {
      this.element.style.display = 'flex';
    }
    this.collapseToggle.style.display = this.isCollapsed ? 'flex' : 'none';
  }

  /**
   * Hide the navigator
   */
  hide() {
    this.element.style.display = 'none';
    this.collapseToggle.style.display = 'none';
  }

  /**
   * Truncate text to specified length
   */
  truncateText(text, maxLength) {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * Escape HTML characters
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Export for use
window.SuggestionNavigator = SuggestionNavigator;