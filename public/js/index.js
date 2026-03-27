// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Index Page Manager
 *
 * Handles the main index page functionality including:
 * - Theme management (light/dark toggle)
 * - Help modal
 * - PR review start flow
 * - Local review start flow
 * - Recent reviews listing with pagination
 * - Local review sessions listing with pagination and deletion
 * - Tab switching (PR / Local)
 */
(function () {
  'use strict';

  // ─── Theme Management ───────────────────────────────────────────────────────

  function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = savedTheme || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  }

  function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
  }

  // Initialize theme on page load
  initTheme();

  // Set up theme toggle button
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // ─── Help Modal ─────────────────────────────────────────────────────────────

  function openHelpModal() {
    const overlay = document.getElementById('help-modal-overlay');
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function closeHelpModal() {
    const overlay = document.getElementById('help-modal-overlay');
    overlay.classList.remove('visible');
    document.body.style.overflow = '';
  }

  // Set up help button
  document.getElementById('help-btn').addEventListener('click', openHelpModal);

  // Set up close button
  document.getElementById('help-modal-close').addEventListener('click', closeHelpModal);

  // Close on overlay click (but not modal click)
  document.getElementById('help-modal-overlay').addEventListener('click', function (e) {
    if (e.target === this) {
      closeHelpModal();
    }
  });

  // Close on Escape key
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      // Exit selection mode first (higher priority)
      if (activeSelection && activeSelection.active) {
        activeSelection.exit();
        return;
      }
      // Then try closing help modal
      const overlay = document.getElementById('help-modal-overlay');
      if (overlay.classList.contains('visible')) {
        closeHelpModal();
      }
    }
  });

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
    if (!localStorage.getItem('theme')) {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    }
  });

  // ─── Shared Utilities ───────────────────────────────────────────────────────

  /** localStorage key for persisting the active tab */
  const TAB_STORAGE_KEY = 'pair-review-active-tab';

  /**
   * Format a relative time string from a date
   * @param {string} dateString - ISO date string
   * @returns {string} Human-readable relative time
   */
  function formatRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) {
      return 'Just now';
    } else if (diffMins < 60) {
      return diffMins + ' minute' + (diffMins !== 1 ? 's' : '') + ' ago';
    } else if (diffHours < 24) {
      return diffHours + ' hour' + (diffHours !== 1 ? 's' : '') + ' ago';
    } else if (diffDays < 7) {
      return diffDays + ' day' + (diffDays !== 1 ? 's' : '') + ' ago';
    } else if (diffDays < 30) {
      const weeks = Math.floor(diffDays / 7);
      return weeks + ' week' + (weeks !== 1 ? 's' : '') + ' ago';
    } else {
      const months = Math.floor(diffDays / 30);
      return months + ' month' + (months !== 1 ? 's' : '') + ' ago';
    }
  }

  /**
   * Escape HTML special characters
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  /**
   * Set loading state for a tab's form
   * @param {string} tab - 'pr' or 'local'
   * @param {boolean} loading - Whether to show loading state
   * @param {string} [text] - Optional loading text
   */
  function setFormLoading(tab, loading, text) {
    const ids = tab === 'pr'
      ? { input: 'pr-url-input', btn: 'start-review-btn', loadingEl: 'start-review-loading-pr', loadingText: 'start-review-loading-text-pr', errorEl: 'start-review-error-pr', btnLabel: 'Start Review' }
      : { input: 'local-path-input', btn: 'start-local-btn', loadingEl: 'start-review-loading-local', loadingText: 'start-review-loading-text-local', errorEl: 'start-review-error-local', btnLabel: 'Review Local' };

    const inputEl = document.getElementById(ids.input);
    const btnEl = document.getElementById(ids.btn);
    const loadingEl = document.getElementById(ids.loadingEl);
    const loadingTextEl = document.getElementById(ids.loadingText);
    const errorEl = document.getElementById(ids.errorEl);

    if (loading) {
      if (inputEl) inputEl.disabled = true;
      if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Starting...'; }
      if (loadingEl) loadingEl.classList.add('visible');
      if (loadingTextEl && text) loadingTextEl.textContent = text;
      if (errorEl) errorEl.classList.remove('visible', 'info');
    } else {
      if (inputEl) inputEl.disabled = false;
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = ids.btnLabel; }
      if (loadingEl) loadingEl.classList.remove('visible');
    }
  }

  /**
   * Show error message for a specific tab's form
   * @param {string} tab - 'pr' or 'local'
   * @param {string} message - Error message to display
   */
  function showError(tab, message) {
    const elId = tab === 'pr' ? 'start-review-error-pr' : 'start-review-error-local';
    const errorEl = document.getElementById(elId);
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.remove('info');
      errorEl.classList.add('visible');
    }
  }

  /**
   * Show an informational (non-error) message to the user.
   * Uses the same element as showError but with neutral info styling.
   * @param {string} tab - 'pr' or 'local'
   * @param {string} message - Informational message to display
   */
  function showInfo(tab, message) {
    const elId = tab === 'pr' ? 'start-review-error-pr' : 'start-review-error-local';
    const errorEl = document.getElementById(elId);
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.add('visible', 'info');
    }
  }

  // ─── Tab Switching ──────────────────────────────────────────────────────────

  /**
   * Generic tab switching handler
   * Activates the clicked tab and its corresponding pane
   * @param {HTMLElement} tabBar - The tab bar container
   * @param {HTMLElement} clickedBtn - The clicked tab button
   * @param {Function} [onActivate] - Optional callback when a tab is activated
   */
  function switchTab(tabBar, clickedBtn, onActivate) {
    const tabId = clickedBtn.dataset.tab;
    if (!tabId) return;

    // Deactivate all tabs in this bar
    tabBar.querySelectorAll('.tab-btn').forEach(function (btn) { btn.classList.remove('active'); });
    clickedBtn.classList.add('active');

    // Find the parent container that holds the tab panes
    const container = tabBar.closest('.recent-reviews-section');
    if (!container) return;

    // Hide all panes, show the target
    container.querySelectorAll('.tab-pane').forEach(function (pane) { pane.classList.remove('active'); });
    const targetPane = container.querySelector('#' + tabId);
    if (targetPane) {
      targetPane.classList.add('active');
    }

    if (onActivate) onActivate(tabId);
  }

  // ─── Local Reviews ──────────────────────────────────────────────────────────

  /**
   * Render a single local review session table row
   * @param {Object} session - Session data
   * @returns {string} HTML string for the table row
   */
  function renderLocalReviewRow(session) {
    const link = '/local/' + session.id;
    const relativeTime = formatRelativeTime(session.updated_at);
    const pathDisplay = session.local_path || '';
    const abbrevLen = session.sha_abbrev_length || 7;
    const sha = session.local_head_sha
      ? session.local_head_sha.substring(0, abbrevLen)
      : '';
    const hasName = !!session.name;
    const nameDisplay = hasName ? escapeHtml(session.name) : '<em>Untitled</em>';

    // Build repo settings link if repository looks like owner/repo
    var settingsHtml = '';
    if (session.repository && session.repository.includes('/')) {
      var repoParts = session.repository.split('/');
      var settingsLink = '/repo-settings.html?owner=' + encodeURIComponent(repoParts[0]) + '&repo=' + encodeURIComponent(repoParts[1]);
      settingsHtml =
        '<a href="' + settingsLink + '" class="btn-repo-settings" title="Repository settings">' +
          '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">' +
            '<path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"/>' +
          '</svg>' +
        '</a>';
    }

    return '' +
      '<tr data-session-id="' + session.id + '">' +
        '<td class="col-local-name" title="' + escapeHtml(session.name || 'Untitled') + '"><a href="' + link + '">' + nameDisplay + '</a></td>' +
        '<td class="col-local-sha" title="' + escapeHtml(session.local_head_sha || '') + '">' + escapeHtml(sha) + '</td>' +
        '<td class="col-local-path" title="' + escapeHtml(pathDisplay) + '">' + escapeHtml(pathDisplay) + '</td>' +
        '<td class="col-repo">' + escapeHtml(session.repository || '') + '</td>' +
        '<td class="col-time">' + relativeTime + '</td>' +
        '<td class="col-actions">' +
          settingsHtml +
          '<button' +
            ' class="btn-delete-session"' +
            ' data-session-id="' + session.id + '"' +
            ' data-session-path="' + escapeHtml(pathDisplay) + '"' +
            ' title="Delete session"' +
          '>' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">' +
              '<path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19a1.75 1.75 0 001.741-1.575l.66-6.6a.75.75 0 00-1.492-.15l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"></path>' +
            '</svg>' +
          '</button>' +
        '</td>' +
      '</tr>';
  }

  /** Pagination state for the local reviews list */
  const localReviewsPagination = {
    lastTimestamp: null,
    pageSize: 10,
    hasMore: false,
    loaded: false
  };

  // ─── GitHub PR Collections (My Review Requests / My PRs) ───────────────────

  var reviewRequestsState = {
    loaded: false,
    prs: [],
    fetchedAt: null
  };

  var myPrsState = {
    loaded: false,
    prs: [],
    fetchedAt: null
  };

  /**
   * Render a single row for a collection PR table.
   * @param {Object} pr - PR object from the API
   * @param {string} collection - The collection name ('review-requests' or 'my-prs')
   * @returns {string} HTML string for the table row
   */
  function renderCollectionPrRow(pr, collection) {
    var repoFull = pr.owner + '/' + pr.repo;
    var prUrl = pr.html_url || ('https://github.com/' + repoFull + '/pull/' + pr.number);
    var relativeTime = formatRelativeTime(pr.updated_at);

    var authorDisplay = pr.author
      ? '<a href="https://github.com/' + encodeURIComponent(pr.author) + '" target="_blank" rel="noopener">' + escapeHtml(pr.author) + '</a>'
      : '';

    var githubLinkHtml =
      '<a href="' + escapeHtml(pr.html_url || prUrl) + '" target="_blank" rel="noopener" class="btn-github-link" title="Open on GitHub">' +
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>' +
      '</a>';

    var graphiteLinkHtml = '';
    if (window.__pairReview?.enableGraphite && pr.html_url) {
      // Derive from html_url to preserve GitHub's original casing (Graphite URLs are case-sensitive)
      var graphiteUrl = window.__pairReview.toGraphiteUrl(pr.html_url);
      graphiteLinkHtml =
        '<a href="' + escapeHtml(graphiteUrl) + '" target="_blank" rel="noopener" class="btn-github-link" title="Open on Graphite">' +
          '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9.7932,1.3079L3.101,3.101l-1.7932,6.6921,4.899,4.899,6.6921-1.7931,1.7932-6.6921L9.7932,1.3079Zm1.0936,11.6921H5.1133l-2.8867-5L5.1133,3h5.7735l2.8867,5-2.8867,5Z"/><polygon points="11.3504 4.6496 6.7737 3.4232 3.4232 6.7737 4.6496 11.3504 9.2263 12.5768 12.5768 9.2263 11.3504 4.6496"/></svg>' +
        '</a>';
    }

    var authorTd = collection === 'my-prs'
      ? ''
      : '<td class="col-author">' + authorDisplay + '</td>';

    return '' +
      '<tr class="collection-pr-row" data-pr-url="' + escapeHtml(prUrl) + '" data-owner="' + escapeHtml(pr.owner) + '" data-repo="' + escapeHtml(pr.repo) + '" data-number="' + pr.number + '">' +
        '<td class="col-repo">' + escapeHtml(repoFull) + '</td>' +
        '<td class="col-pr"><span class="collection-pr-number">#' + pr.number + '</span></td>' +
        '<td class="col-title" title="' + escapeHtml(pr.title || '') + '">' + escapeHtml(pr.title || '') + '</td>' +
        authorTd +
        '<td class="col-time">' + relativeTime + '</td>' +
        '<td class="col-actions">' + githubLinkHtml + graphiteLinkHtml + '</td>' +
      '</tr>';
  }

  /**
   * Render the collection table into a container element.
   * @param {HTMLElement} container - The container element
   * @param {Object} state - The collection state object
   * @param {string} collection - The collection name ('review-requests' or 'my-prs')
   */
  function renderCollectionTable(container, state, collection) {
    var sel = collection === 'review-requests' ? reviewRequestsSelection : myPrsSelection;
    sel.exit();

    var fetchedAtId = collection === 'review-requests' ? 'review-requests-fetched-at' : 'my-prs-fetched-at';
    var fetchedAtEl = document.getElementById(fetchedAtId);
    if (fetchedAtEl) {
      var lsKey = 'github-collection-fetched-at:' + collection;
      var displayTs = localStorage.getItem(lsKey) || state.fetchedAt;
      fetchedAtEl.textContent = displayTs
        ? 'Updated ' + formatRelativeTime(displayTs)
        : '';
    }

    if (state.prs.length === 0) {
      var emptyMsg = collection === 'review-requests'
        ? 'No pull requests awaiting your review.'
        : 'You have no open pull requests.';

      if (!state.fetchedAt) {
        emptyMsg = 'Click refresh to fetch from GitHub.';
      }

      container.innerHTML =
        '<div class="recent-reviews-empty">' +
          '<p>' + emptyMsg + '</p>' +
        '</div>';
      container.classList.remove('recent-reviews-loading');
      return;
    }

    var authorTh = collection === 'my-prs' ? '' : '<th>Author</th>';

    var tbodyId = collection === 'review-requests' ? 'review-requests-tbody' : 'my-prs-tbody';

    container.innerHTML =
      '<table class="recent-reviews-table">' +
        '<thead>' +
          '<tr>' +
            '<th>Repository</th>' +
            '<th>PR</th>' +
            '<th>Title</th>' +
            authorTh +
            '<th>Updated</th>' +
            '<th>Actions</th>' +
          '</tr>' +
        '</thead>' +
        '<tbody id="' + tbodyId + '">' +
          state.prs.map(function (pr) { return renderCollectionPrRow(pr, collection); }).join('') +
        '</tbody>' +
      '</table>';
    container.classList.remove('recent-reviews-loading');
  }

  /**
   * Load collection PRs from cached backend data.
   * @param {string} collection - 'review-requests' or 'my-prs'
   * @param {string} containerId - DOM id of the container element
   * @param {Object} state - The collection state object
   */
  async function loadCollectionPrs(collection, containerId, state) {
    var container = document.getElementById(containerId);

    try {
      var response = await fetch('/api/github/' + collection);
      if (!response.ok) throw new Error('Failed to fetch');
      var data = await response.json();

      state.loaded = true;
      state.prs = data.prs || [];
      state.fetchedAt = data.fetched_at;

      renderCollectionTable(container, state, collection);
    } catch (error) {
      console.error('Error loading ' + collection + ':', error);
      container.innerHTML =
        '<div class="recent-reviews-empty">' +
          '<p>Failed to load. Click refresh to try again.</p>' +
        '</div>';
      container.classList.remove('recent-reviews-loading');
    }
  }

  /**
   * Refresh collection PRs by fetching fresh data from GitHub.
   * @param {string} collection - 'review-requests' or 'my-prs'
   * @param {string} containerId - DOM id of the container element
   * @param {Object} state - The collection state object
   */
  async function refreshCollectionPrs(collection, containerId, state) {
    var container = document.getElementById(containerId);
    var btnId = collection === 'review-requests' ? 'refresh-review-requests' : 'refresh-my-prs';
    var btn = document.getElementById(btnId);

    if (btn) btn.classList.add('refreshing');

    // Show loading state only if this is the first load (no existing data)
    if (state.prs.length === 0) {
      container.innerHTML = '<div class="recent-reviews-loading">Fetching from GitHub...</div>';
    }

    try {
      var response = await fetch('/api/github/' + collection + '/refresh', { method: 'POST' });

      if (!response.ok) {
        var errData = await response.json().catch(function() { return {}; });
        if (response.status === 401) {
          container.innerHTML =
            '<div class="recent-reviews-empty">' +
              '<p>Configure a GitHub token to see ' +
              (collection === 'review-requests' ? 'review requests' : 'your pull requests') +
              '.</p>' +
            '</div>';
          container.classList.remove('recent-reviews-loading');
          return;
        }
        throw new Error(errData.error || 'Refresh failed');
      }

      var data = await response.json();
      state.prs = data.prs || [];
      state.fetchedAt = data.fetched_at;
      state.loaded = true;
      localStorage.setItem('github-collection-fetched-at:' + collection, new Date().toISOString());

      renderCollectionTable(container, state, collection);
    } catch (error) {
      console.error('Error refreshing ' + collection + ':', error);
      // If we had existing data, keep showing it
      if (state.prs.length > 0) {
        renderCollectionTable(container, state, collection);
      } else {
        container.innerHTML =
          '<div class="recent-reviews-empty">' +
            '<p>Failed to fetch from GitHub. Check your token and try again.</p>' +
          '</div>';
        container.classList.remove('recent-reviews-loading');
      }
    } finally {
      if (btn) btn.classList.remove('refreshing');
    }
  }

  /**
   * Fetch and display local review sessions (initial load).
   */
  async function loadLocalReviews() {
    localSelection.exit();

    const container = document.getElementById('local-reviews-container');
    if (!container) return;

    // Reset pagination
    localReviewsPagination.lastTimestamp = null;
    localReviewsPagination.hasMore = false;

    try {
      const response = await fetch('/api/local/sessions?limit=' + localReviewsPagination.pageSize);
      if (!response.ok) throw new Error('Failed to fetch local sessions');

      const data = await response.json();

      if (!data.success || !data.sessions || data.sessions.length === 0) {
        container.innerHTML =
          '<div class="recent-reviews-empty">' +
            '<p>No local review sessions yet. Enter a directory path above or run <code>pair-review --local</code> from the CLI.</p>' +
          '</div>';
        container.classList.remove('recent-reviews-loading');
        return;
      }

      // Update pagination
      localReviewsPagination.lastTimestamp = data.sessions[data.sessions.length - 1].updated_at;
      localReviewsPagination.hasMore = !!data.hasMore;

      container.innerHTML =
        '<table class="recent-reviews-table local-table">' +
          '<thead>' +
            '<tr>' +
              '<th>Name</th>' +
              '<th>Head</th>' +
              '<th>Path</th>' +
              '<th>Repo</th>' +
              '<th>Last Updated</th>' +
              '<th></th>' +
            '</tr>' +
          '</thead>' +
          '<tbody id="local-reviews-tbody">' +
            data.sessions.map(renderLocalReviewRow).join('') +
          '</tbody>' +
        '</table>' +
        (data.hasMore
          ? '<div class="show-more-container" id="local-show-more-container">' +
              '<button class="btn-show-more" id="btn-local-show-more" type="button">' +
                '<span class="btn-show-more-text">Show more</span>' +
                '<span class="spinner"></span>' +
              '</button>' +
            '</div>'
          : '');
      container.classList.remove('recent-reviews-loading');
      localReviewsPagination.loaded = true;

    } catch (error) {
      console.error('Error loading local reviews:', error);
      container.innerHTML =
        '<div class="recent-reviews-empty">' +
          '<p>Failed to load local reviews.</p>' +
        '</div>';
      container.classList.remove('recent-reviews-loading');
    }
  }

  /**
   * Load more local review sessions (pagination)
   */
  async function loadMoreLocalReviews() {
    const btn = document.getElementById('btn-local-show-more');
    const tbody = document.getElementById('local-reviews-tbody');
    if (!btn || !tbody) return;

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      const params = new URLSearchParams({ limit: localReviewsPagination.pageSize });
      if (localReviewsPagination.lastTimestamp) params.set('before', localReviewsPagination.lastTimestamp);
      const response = await fetch('/api/local/sessions?' + params);
      if (!response.ok) throw new Error('Failed to fetch more sessions');

      const data = await response.json();
      if (!document.contains(btn)) return;

      if (!data.success || !data.sessions || data.sessions.length === 0) {
        const showMoreContainer = document.getElementById('local-show-more-container');
        if (showMoreContainer) showMoreContainer.remove();
        localReviewsPagination.hasMore = false;
        return;
      }

      tbody.insertAdjacentHTML('beforeend', data.sessions.map(renderLocalReviewRow).join(''));
      if (localSelection.active) localSelection.onRowsAdded();

      localReviewsPagination.lastTimestamp = data.sessions[data.sessions.length - 1].updated_at;
      localReviewsPagination.hasMore = !!data.hasMore;

      if (!data.hasMore) {
        const container = document.getElementById('local-show-more-container');
        if (container) container.remove();
      } else {
        btn.classList.remove('loading');
        btn.disabled = false;
      }

    } catch (error) {
      console.error('Error loading more local reviews:', error);
      btn.classList.remove('loading');
      btn.disabled = false;
      const textEl = btn.querySelector('.btn-show-more-text');
      if (textEl) {
        textEl.textContent = 'Failed to load \u2014 click to retry';
        setTimeout(function () { textEl.textContent = 'Show more'; }, 4000);
      }
    }
  }

  /**
   * Show inline delete confirmation for a local session row
   * @param {HTMLElement} button - The delete button element
   */
  function showDeleteSessionConfirm(button) {
    const sessionId = button.dataset.sessionId;
    const sessionPath = button.dataset.sessionPath || '';
    const row = button.closest('tr');
    if (!row) return;

    // If already showing confirmation, do nothing
    if (row.classList.contains('delete-confirm-row')) return;

    // Remember original HTML so we can restore on cancel.
    // Note: restoring innerHTML is safe because all click handlers use event delegation.
    const originalHTML = row.innerHTML;
    const colCount = row.children.length;

    row.classList.add('delete-confirm-row');
    row.innerHTML =
      '<td colspan="' + colCount + '">' +
        '<div class="delete-confirm-inner">' +
          '<span>Delete session for ' + escapeHtml(sessionPath) + '?</span>' +
          '<button class="btn-confirm-yes" data-session-id="' + sessionId + '">Delete</button>' +
          '<button class="btn-confirm-no">Cancel</button>' +
        '</div>' +
      '</td>';

    // Wire up buttons
    row.querySelector('.btn-confirm-yes').addEventListener('click', async function () {
      try {
        const response = await fetch('/api/local/sessions/' + sessionId, {
          method: 'DELETE'
        });
        if (!response.ok) {
          const respData = await response.json().catch(function () { return {}; });
          throw new Error(respData.error || 'Failed to delete session');
        }
        // Remove the row from DOM
        row.remove();
        // If no more rows, reload to show empty state
        const tbody = document.getElementById('local-reviews-tbody');
        if (tbody && tbody.children.length === 0) {
          await loadLocalReviews();
        }
      } catch (error) {
        console.error('Error deleting local session:', error);
        // Restore row on failure
        row.classList.remove('delete-confirm-row');
        row.innerHTML = originalHTML;
      }
    });

    row.querySelector('.btn-confirm-no').addEventListener('click', function () {
      row.classList.remove('delete-confirm-row');
      row.innerHTML = originalHTML;
    });
  }

  // ─── Local Review Start ─────────────────────────────────────────────────────

  /**
   * Handle start local review form submission.
   * Navigates to the setup page which shows step-by-step progress,
   * matching the flow used when reviews are started from the MCP/CLI.
   * @param {Event} event - Form submit event
   */
  async function handleStartLocal(event) {
    event.preventDefault();

    const input = document.getElementById('local-path-input');
    const pathValue = input.value.trim();

    // Clear previous errors/info messages
    const errorEl = document.getElementById('start-review-error-local');
    if (errorEl) errorEl.classList.remove('visible', 'info');

    if (!pathValue) {
      showError('local', 'Please enter a directory path');
      input.focus();
      return;
    }

    // Navigate to the setup page which shows step-by-step progress
    // The /local?path= route serves setup.html which handles the full setup flow
    window.location.href = '/local?path=' + encodeURIComponent(pathValue);
  }

  // ─── Browse Directory ──────────────────────────────────────────────────────

  /**
   * Handle Browse button click — open native OS directory picker via backend API
   */
  async function handleBrowseLocal() {
    const browseBtn = document.getElementById('browse-local-btn');
    const input = document.getElementById('local-path-input');
    if (!browseBtn || !input) return;

    // Disable button while dialog is open
    browseBtn.disabled = true;
    browseBtn.textContent = 'Browsing...';

    try {
      const response = await fetch('/api/local/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json();

      if (!response.ok) {
        showError('local', data.error || 'Failed to open directory picker');
        return;
      }

      if (!data.cancelled && data.path) {
        input.value = data.path;
        input.focus();
      }

    } catch (error) {
      console.error('Error browsing for directory:', error);
      showError('local', 'Failed to open directory picker');
    } finally {
      browseBtn.disabled = false;
      browseBtn.textContent = 'Browse';
    }
  }

  // ─── PR Reviews ─────────────────────────────────────────────────────────────

  /**
   * Render a single recent review table row
   * @param {Object} review - Review data
   * @returns {string} HTML string for the table row
   */
  function renderRecentReviewRow(review) {
    const parts = review.repository.split('/');
    const owner = parts[0];
    const repo = parts[1];
    const link = '/pr/' + owner + '/' + repo + '/' + review.pr_number;
    const settingsLink = '/repo-settings.html?owner=' + encodeURIComponent(owner) + '&repo=' + encodeURIComponent(repo);
    const relativeTime = formatRelativeTime(review.last_accessed_at);

    const authorDisplay = review.author
      ? '<a href="https://github.com/' + encodeURIComponent(review.author) + '" target="_blank" rel="noopener">' + escapeHtml(review.author) + '</a>'
      : '';

    return '' +
      '<tr data-review-id="' + review.id + '">' +
        '<td class="col-repo">' + escapeHtml(review.repository) + '</td>' +
        '<td class="col-pr"><a href="' + link + '">#' + review.pr_number + '</a></td>' +
        '<td class="col-title" title="' + escapeHtml(review.pr_title) + '">' + escapeHtml(review.pr_title) + '</td>' +
        '<td class="col-author">' + authorDisplay + '</td>' +
        '<td class="col-time">' + relativeTime + '</td>' +
        '<td class="col-actions">' +
          '<a href="https://github.com/' + escapeHtml(review.repository) + '/pull/' + review.pr_number + '" target="_blank" rel="noopener" class="btn-github-link" title="Open on GitHub">' +
            '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>' +
          '</a>' +
          (window.__pairReview?.enableGraphite && review.html_url
            ? '<a href="' + escapeHtml(window.__pairReview.toGraphiteUrl(review.html_url)) + '" target="_blank" rel="noopener" class="btn-github-link" title="Open on Graphite">' +
                '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9.7932,1.3079L3.101,3.101l-1.7932,6.6921,4.899,4.899,6.6921-1.7931,1.7932-6.6921L9.7932,1.3079Zm1.0936,11.6921H5.1133l-2.8867-5L5.1133,3h5.7735l2.8867,5-2.8867,5Z"/><polygon points="11.3504 4.6496 6.7737 3.4232 3.4232 6.7737 4.6496 11.3504 9.2263 12.5768 12.5768 9.2263 11.3504 4.6496"/></svg>' +
              '</a>'
            : '') +
          '<a href="' + settingsLink + '" class="btn-repo-settings" title="Repository settings">' +
            '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">' +
              '<path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"/>' +
            '</svg>' +
          '</a>' +
          '<button' +
            ' class="btn-delete-review"' +
            ' data-review-id="' + review.id + '"' +
            ' data-repository="' + escapeHtml(review.repository) + '"' +
            ' data-pr-number="' + review.pr_number + '"' +
            ' title="Delete review"' +
          '>' +
            '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">' +
              '<path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19a1.75 1.75 0 001.741-1.575l.66-6.6a.75.75 0 00-1.492-.15l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"></path>' +
            '</svg>' +
          '</button>' +
        '</td>' +
      '</tr>';
  }

  /**
   * Show inline delete confirmation for a PR review row
   * @param {HTMLElement} button - The delete button element
   */
  function showDeleteReviewConfirm(button) {
    const reviewId = button.dataset.reviewId;
    const repository = button.dataset.repository;
    const prNumber = button.dataset.prNumber;
    const row = button.closest('tr');
    if (!row) return;

    // If already showing confirmation, do nothing
    if (row.classList.contains('delete-confirm-row')) return;

    // Remember original HTML so we can restore on cancel.
    // Note: restoring innerHTML is safe because all click handlers use event delegation.
    const originalHTML = row.innerHTML;
    const colCount = row.children.length;

    row.classList.add('delete-confirm-row');
    row.innerHTML =
      '<td colspan="' + colCount + '">' +
        '<div class="delete-confirm-inner">' +
          '<span>Delete review for ' + escapeHtml(repository) + ' #' + escapeHtml(String(prNumber)) + '?</span>' +
          '<button class="btn-confirm-yes" data-review-id="' + reviewId + '">Delete</button>' +
          '<button class="btn-confirm-no">Cancel</button>' +
        '</div>' +
      '</td>';

    // Wire up buttons
    row.querySelector('.btn-confirm-yes').addEventListener('click', async function () {
      try {
        const response = await fetch('/api/worktrees/' + reviewId, {
          method: 'DELETE'
        });

        if (!response.ok) {
          const data = await response.json().catch(function () { return {}; });
          throw new Error(data.error || 'Failed to delete review');
        }

        // Reload the recent reviews list
        await loadRecentReviews();

      } catch (error) {
        console.error('Error deleting review:', error);
        // Restore row on failure
        row.classList.remove('delete-confirm-row');
        row.innerHTML = originalHTML;
      }
    });

    row.querySelector('.btn-confirm-no').addEventListener('click', function () {
      row.classList.remove('delete-confirm-row');
      row.innerHTML = originalHTML;
    });
  }

  /** Pagination state for the recent reviews list */
  const recentReviewsPagination = {
    /** ISO timestamp of the last loaded item (cursor for next fetch) */
    lastTimestamp: null,
    /** Number of reviews to fetch per page */
    pageSize: 10,
    /** Whether the server has indicated more results exist */
    hasMore: false
  };

  /**
   * Fetch and display recent reviews (initial load).
   * Resets pagination state and renders the full table from scratch.
   */
  async function loadRecentReviews() {
    prSelection.exit();

    const container = document.getElementById('recent-reviews-container');
    const section = document.getElementById('recent-reviews-section');
    // Reset pagination state
    recentReviewsPagination.lastTimestamp = null;
    recentReviewsPagination.hasMore = false;

    try {
      const response = await fetch('/api/worktrees/recent?limit=' + recentReviewsPagination.pageSize);

      if (!response.ok) {
        throw new Error('Failed to fetch recent reviews');
      }

      const data = await response.json();

      if (!data.success || !data.reviews || data.reviews.length === 0) {
        // Show friendly empty state
        container.innerHTML =
          '<div class="recent-reviews-empty">' +
            '<p>No PR reviews yet. Paste a PR URL above to get started.</p>' +
          '</div>';
        container.classList.remove('recent-reviews-loading');
        // Show help modal when no reviews exist
        openHelpModal();
        return;
      }

      // Update pagination state - track the cursor for the next page
      recentReviewsPagination.lastTimestamp = data.reviews[data.reviews.length - 1].last_accessed_at;
      recentReviewsPagination.hasMore = !!data.hasMore;

      // Render the table of recent reviews
      const html =
        '<table class="recent-reviews-table">' +
          '<thead>' +
            '<tr>' +
              '<th>Repository</th>' +
              '<th>PR</th>' +
              '<th>Title</th>' +
              '<th>Author</th>' +
              '<th>Last Opened</th>' +
              '<th>Actions</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody id="recent-reviews-tbody">' +
            data.reviews.map(renderRecentReviewRow).join('') +
          '</tbody>' +
        '</table>' +
        renderShowMoreButton(data.hasMore);
      container.innerHTML = html;
      container.classList.remove('recent-reviews-loading');

    } catch (error) {
      console.error('Error loading recent reviews:', error);
      container.innerHTML =
        '<div class="recent-reviews-empty">' +
          '<p>Failed to load recent reviews. Please try refreshing the page.</p>' +
        '</div>';
      container.classList.remove('recent-reviews-loading');
    }
  }

  /**
   * Render the "Show more" button HTML.
   * @param {boolean} hasMore - Whether more results are available
   * @returns {string} HTML string for the show-more container
   */
  function renderShowMoreButton(hasMore) {
    if (!hasMore) return '';
    return '' +
      '<div class="show-more-container" id="show-more-container">' +
        '<button class="btn-show-more" id="btn-show-more" type="button">' +
          '<span class="btn-show-more-text">Show more</span>' +
          '<span class="spinner"></span>' +
        '</button>' +
      '</div>';
  }

  /**
   * Load the next page of reviews and append them to the existing table.
   * Called when the "Show more" button is clicked.
   */
  async function loadMoreReviews() {
    const btn = document.getElementById('btn-show-more');
    const tbody = document.getElementById('recent-reviews-tbody');
    if (!btn || !tbody) return;

    // Show loading state on the button
    btn.classList.add('loading');
    btn.disabled = true;

    try {
      const params = new URLSearchParams({ limit: recentReviewsPagination.pageSize });
      if (recentReviewsPagination.lastTimestamp) params.set('before', recentReviewsPagination.lastTimestamp);
      const response = await fetch('/api/worktrees/recent?' + params);

      if (!response.ok) {
        throw new Error('Failed to fetch more reviews');
      }

      const data = await response.json();

      // Guard against stale response if the table was refreshed (e.g. by a delete) while loading
      if (!document.contains(btn)) return;

      if (!data.success || !data.reviews || data.reviews.length === 0) {
        // No more results - remove the button
        const showMoreContainer = document.getElementById('show-more-container');
        if (showMoreContainer) showMoreContainer.remove();
        recentReviewsPagination.hasMore = false;
        return;
      }

      // Append new rows to the existing table body
      tbody.insertAdjacentHTML('beforeend', data.reviews.map(renderRecentReviewRow).join(''));
      if (prSelection.active) prSelection.onRowsAdded();

      // Update pagination state - advance the cursor
      recentReviewsPagination.lastTimestamp = data.reviews[data.reviews.length - 1].last_accessed_at;
      recentReviewsPagination.hasMore = !!data.hasMore;

      // Update or remove the "Show more" button
      if (!data.hasMore) {
        const container = document.getElementById('show-more-container');
        if (container) container.remove();
      } else {
        // Reset button state
        btn.classList.remove('loading');
        btn.disabled = false;
      }

    } catch (error) {
      console.error('Error loading more reviews:', error);
      // Reset button state and show error so the user knows what happened
      btn.classList.remove('loading');
      btn.disabled = false;
      const textEl = btn.querySelector('.btn-show-more-text');
      if (textEl) {
        textEl.textContent = 'Failed to load \u2014 click to retry';
        // Restore original text after a brief delay so the user sees the error
        setTimeout(function () { textEl.textContent = 'Show more'; }, 4000);
      }
    }
  }

  // ─── PR Start Flow ──────────────────────────────────────────────────────────

  /**
   * Parse a PR URL using the backend API
   * Supports GitHub and Graphite URLs (with or without protocol)
   * @param {string} url - The PR URL to parse
   * @returns {Promise<Object|null>} { owner, repo, prNumber } or null if invalid
   */
  async function parsePRUrl(url) {
    if (!url || typeof url !== 'string') {
      return null;
    }

    try {
      const response = await fetch('/api/parse-pr-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: url.trim() })
      });

      const data = await response.json();

      if (data.valid) {
        return {
          owner: data.owner,
          repo: data.repo,
          prNumber: data.prNumber
        };
      }

      return null;
    } catch (e) {
      console.error('Error parsing PR URL:', e);
      return null;
    }
  }

  /**
   * Handle start review form submission.
   * Parses the PR URL, then navigates to the PR route which serves the
   * setup page with step-by-step progress for new PRs, or the review page
   * directly for PRs that already exist in the database.
   * @param {Event} event - Form submit event
   */
  async function handleStartReview(event) {
    event.preventDefault();

    const input = document.getElementById('pr-url-input');
    const url = input.value.trim();

    // Clear previous errors
    const errorEl = document.getElementById('start-review-error-pr');
    if (errorEl) errorEl.classList.remove('visible');

    // Validate input
    if (!url) {
      showError('pr', 'Please enter a GitHub PR URL');
      input.focus();
      return;
    }

    // Show loading state while parsing
    setFormLoading('pr', true, 'Validating PR URL...');

    // Parse the URL using the backend API
    const parsed = await parsePRUrl(url);
    if (!parsed) {
      setFormLoading('pr', false);
      showError('pr', 'Invalid PR URL. Please enter a GitHub or Graphite PR URL (e.g., https://github.com/owner/repo/pull/123)');
      input.focus();
      return;
    }

    // Navigate to the PR route which serves setup.html (with step-by-step progress)
    // for new PRs, or pr.html directly for PRs already in the database
    window.location.href = '/pr/' + encodeURIComponent(parsed.owner) + '/' + encodeURIComponent(parsed.repo) + '/' + encodeURIComponent(parsed.prNumber);
  }

  // ─── Config & Command Examples ──────────────────────────────────────────────

  /**
   * Update command examples based on whether running via npx or installed
   * @param {boolean} isNpx - True if running via npx
   */
  function updateCommandExamples(isNpx) {
    const baseCmd = isNpx ? 'npx @in-the-loop-labs/pair-review' : 'pair-review';
    const cmdExamples = document.querySelectorAll('.cmd-example');
    cmdExamples.forEach(function (el) {
      const args = el.dataset.args || '';
      el.textContent = args ? baseCmd + ' ' + args : baseCmd;
    });
  }

  /**
   * Fetch config from server and update UI accordingly
   */
  async function loadConfigAndUpdateUI() {
    try {
      const response = await fetch('/api/config');
      if (response.ok) {
        const config = await response.json();
        updateCommandExamples(config.is_running_via_npx);

        // Display version in header
        if (config.version) {
          const versionEl = document.getElementById('app-version');
          if (versionEl) versionEl.textContent = 'v' + config.version;
        }

        // Expose chat provider config to components (ChatPanel reads these)
        window.__pairReview = window.__pairReview || {};
        window.__pairReview.chatProvider = config.chat_provider || 'pi';
        const chatProviders = config.chat_providers || [];
        window.__pairReview.chatProviders = chatProviders;
        window.__pairReview.enableGraphite = config.enable_graphite === true;
        window.__pairReview.chatSpinner = config.chat_spinner || 'dots';
        window.__pairReview.chatEnterToSend = config.chat_enter_to_send !== false;

        // Set chat feature state based on config and provider availability
        let chatState = 'disabled';
        if (config.enable_chat) {
          const anyAvailable = chatProviders.some(p => p.available);
          chatState = anyAvailable ? 'available' : 'unavailable';
        }
        document.documentElement.setAttribute('data-chat', chatState);
        window.dispatchEvent(new CustomEvent('chat-state-changed', { detail: { state: chatState } }));
      } else {
        // Fallback: assume installed (shorter command)
        updateCommandExamples(false);
      }
    } catch (error) {
      console.error('Error loading config:', error);
      // Fallback: assume installed (shorter command)
      updateCommandExamples(false);
    }
  }

  // ─── Selection Mode ──────────────────────────────────────────────────────

  /** Currently active SelectionMode instance (only one tab at a time) */
  var activeSelection = null;

  /**
   * SelectionMode manages checkbox-based selection for a single tab's table.
   *
   * @param {Object} config
   * @param {string} config.tabId - Tab pane element ID (e.g. 'pr-tab')
   * @param {string} config.containerId - Table container ID (e.g. 'recent-reviews-container')
   * @param {string} config.tbodyId - Table body ID (e.g. 'recent-reviews-tbody')
   * @param {string} config.rowIdAttr - data attribute name on <tr> for the row's ID (e.g. 'reviewId' reads tr.dataset.reviewId)
   * @param {Array} config.actions - [{ label: string, className: string, handler: function(selectedIds, selectionInstance) }]
   */
  function SelectionMode(config) {
    this.config = config;
    this.active = false;
    this.selectedIds = new Set();
    this._actionBar = null;
    this._toggleBtn = null;
    this._confirming = false;
  }

  SelectionMode.prototype.enter = function () {
    if (this.active) return;
    this.active = true;
    this.selectedIds.clear();
    this._confirming = false;

    // Deactivate any other active selection
    if (activeSelection && activeSelection !== this) {
      activeSelection.exit();
    }
    activeSelection = this;

    var container = document.getElementById(this.config.containerId);
    if (container) container.classList.add('selection-mode');

    // Hide the Select button, show inline action controls
    if (this._toggleBtn) {
      this._toggleBtn.style.display = 'none';
    }
    this._ensureInlineActions();
    this._showInlineActions();

    this._injectCheckboxes();
    this._updateInlineActions();
  };

  SelectionMode.prototype.exit = function () {
    if (!this.active) return;
    this.active = false;
    this.selectedIds.clear();
    this._confirming = false;

    if (activeSelection === this) activeSelection = null;

    var container = document.getElementById(this.config.containerId);
    if (container) container.classList.remove('selection-mode');

    // Show Select button, hide inline action controls
    if (this._toggleBtn) {
      this._toggleBtn.style.display = '';
    }
    this._hideInlineActions();

    this._removeCheckboxes();
  };

  SelectionMode.prototype.toggle = function () {
    if (this.active) {
      this.exit();
    } else {
      this.enter();
    }
  };

  SelectionMode.prototype._getTable = function () {
    var container = document.getElementById(this.config.containerId);
    return container ? container.querySelector('table') : null;
  };

  SelectionMode.prototype._getTbody = function () {
    return document.getElementById(this.config.tbodyId);
  };

  SelectionMode.prototype._injectCheckboxes = function () {
    var table = this._getTable();
    if (!table) return;

    // Add select-all checkbox to thead
    var thead = table.querySelector('thead tr');
    if (thead) {
      var th = document.createElement('th');
      th.className = 'col-select';
      th.innerHTML = '<input type="checkbox" class="select-all-checkbox" title="Select all">';
      thead.insertBefore(th, thead.firstChild);

      var self = this;
      th.querySelector('input').addEventListener('change', function () {
        self._handleSelectAll(this.checked);
      });
    }

    // Add checkboxes to all existing rows
    var tbody = this._getTbody();
    if (tbody) {
      var rows = tbody.querySelectorAll('tr');
      for (var i = 0; i < rows.length; i++) {
        this._injectCheckboxIntoRow(rows[i]);
      }
    }
  };

  SelectionMode.prototype._injectCheckboxIntoRow = function (tr) {
    // Skip rows that already have a checkbox (e.g. delete-confirm rows)
    if (tr.querySelector('.col-select')) return;
    // Skip delete confirmation rows
    if (tr.classList.contains('delete-confirm-row')) return;

    var rowId = tr.dataset[this.config.rowIdAttr];
    var td = document.createElement('td');
    td.className = 'col-select';
    td.innerHTML = '<input type="checkbox" data-select-id="' + (rowId || '') + '">';
    tr.insertBefore(td, tr.firstChild);

    var self = this;
    td.querySelector('input').addEventListener('change', function () {
      self._handleRowCheckbox(this.dataset.selectId, this.checked, tr);
    });
  };

  SelectionMode.prototype._removeCheckboxes = function () {
    var table = this._getTable();
    if (!table) return;

    // Remove all .col-select cells
    var cells = table.querySelectorAll('.col-select');
    for (var i = 0; i < cells.length; i++) {
      cells[i].remove();
    }

    // Remove selected class from all rows
    var rows = table.querySelectorAll('tr.bulk-selected');
    for (var j = 0; j < rows.length; j++) {
      rows[j].classList.remove('bulk-selected');
    }
  };

  SelectionMode.prototype._handleSelectAll = function (checked) {
    var tbody = this._getTbody();
    if (!tbody) return;

    var checkboxes = tbody.querySelectorAll('.col-select input[type="checkbox"]');
    for (var i = 0; i < checkboxes.length; i++) {
      var cb = checkboxes[i];
      cb.checked = checked;
      var id = cb.dataset.selectId;
      var row = cb.closest('tr');
      if (checked) {
        if (id) this.selectedIds.add(id);
        if (row) row.classList.add('bulk-selected');
      } else {
        this.selectedIds.delete(id);
        if (row) row.classList.remove('bulk-selected');
      }
    }
    this._updateInlineActions();
  };

  SelectionMode.prototype._handleRowCheckbox = function (id, checked, tr) {
    if (checked) {
      if (id) this.selectedIds.add(id);
      tr.classList.add('bulk-selected');
    } else {
      this.selectedIds.delete(id);
      tr.classList.remove('bulk-selected');
    }

    // Update select-all checkbox state
    var table = this._getTable();
    if (table) {
      var selectAllCb = table.querySelector('.select-all-checkbox');
      if (selectAllCb) {
        var tbody = this._getTbody();
        var total = tbody ? tbody.querySelectorAll('.col-select input[type="checkbox"]').length : 0;
        selectAllCb.checked = total > 0 && this.selectedIds.size === total;
        selectAllCb.indeterminate = !selectAllCb.checked && this.selectedIds.size > 0;
      }
    }

    this._updateInlineActions();
  };

  SelectionMode.prototype.onRowsAdded = function () {
    if (!this.active) return;
    var tbody = this._getTbody();
    if (!tbody) return;

    var rows = tbody.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].querySelector('.col-select')) {
        this._injectCheckboxIntoRow(rows[i]);
      }
    }

    // Uncheck select-all since new rows are not selected
    var table = this._getTable();
    if (table) {
      var selectAllCb = table.querySelector('.select-all-checkbox');
      if (selectAllCb) {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = this.selectedIds.size > 0;
      }
    }
  };

  /**
   * Build the inline action controls (action buttons + count + cancel) and
   * insert them next to the Select toggle button. Created once, then
   * shown/hidden on enter/exit.
   */
  SelectionMode.prototype._ensureInlineActions = function () {
    if (this._inlineEl) return;
    if (!this._toggleBtn) return;

    var wrapper = document.createElement('span');
    wrapper.className = 'bulk-inline-actions';

    // Count label
    var countSpan = document.createElement('span');
    countSpan.className = 'bulk-action-count';
    wrapper.appendChild(countSpan);

    // Action buttons (disabled by default — enabled when selection count > 0)
    var buttonsSpan = document.createElement('span');
    buttonsSpan.className = 'bulk-action-buttons';
    var self = this;
    this._actionBtns = [];
    for (var i = 0; i < this.config.actions.length; i++) {
      var action = this.config.actions[i];
      var btn = document.createElement('button');
      btn.className = action.className;
      btn.textContent = action.label;
      btn.disabled = true;
      btn.addEventListener('click', (function (act) {
        return function () {
          act.handler(new Set(self.selectedIds), self);
        };
      })(action));
      buttonsSpan.appendChild(btn);
      this._actionBtns.push(btn);
    }
    wrapper.appendChild(buttonsSpan);

    // Confirm buttons (hidden by default, shown when confirming)
    var confirmSpan = document.createElement('span');
    confirmSpan.className = 'bulk-confirm-buttons';
    var confirmYes = document.createElement('button');
    confirmYes.className = 'btn-bulk-delete';
    confirmYes.textContent = 'Confirm';
    var confirmNo = document.createElement('button');
    confirmNo.className = 'btn-bulk-cancel';
    confirmNo.textContent = 'Cancel';
    confirmSpan.appendChild(confirmYes);
    confirmSpan.appendChild(confirmNo);
    wrapper.appendChild(confirmSpan);

    // Cancel button (exits selection mode)
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-bulk-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function () {
      self.exit();
    });
    wrapper.appendChild(cancelBtn);

    // Insert after the toggle button
    this._toggleBtn.parentNode.insertBefore(wrapper, this._toggleBtn.nextSibling);
    this._inlineEl = wrapper;
    this._countEl = countSpan;
    this._confirmYes = confirmYes;
    this._confirmNo = confirmNo;
  };

  SelectionMode.prototype._showInlineActions = function () {
    if (this._inlineEl) this._inlineEl.style.display = '';
  };

  SelectionMode.prototype._hideInlineActions = function () {
    if (this._inlineEl) {
      this._inlineEl.style.display = 'none';
      this._inlineEl.classList.remove('confirming');
      this._confirming = false;
    }
  };

  SelectionMode.prototype._updateInlineActions = function () {
    if (!this._inlineEl) return;

    var count = this.selectedIds.size;

    // Update count label
    // Clear count text when not confirming (only used for confirm message)
    if (this._countEl && !this._confirming) {
      this._countEl.textContent = '';
    }

    // Enable/disable action buttons
    for (var i = 0; i < this._actionBtns.length; i++) {
      this._actionBtns[i].disabled = count === 0;
    }

    // Exit confirming state if count drops to 0
    if (count === 0 && this._confirming) {
      this._inlineEl.classList.remove('confirming');
      this._confirming = false;
    }
  };

  /**
   * Show confirmation state in the inline action controls.
   * @param {string} message - Confirmation message (e.g. "Delete 3 reviews?")
   * @param {Function} onConfirm - Called when user confirms
   */
  SelectionMode.prototype.showConfirm = function (message, onConfirm) {
    if (!this._inlineEl) return;

    this._confirming = true;
    if (this._countEl) this._countEl.textContent = message;
    this._inlineEl.classList.add('confirming');

    var self = this;

    // Wire up confirm/cancel buttons (replace nodes to avoid stacking listeners)
    var newConfirmYes = this._confirmYes.cloneNode(true);
    this._confirmYes.parentNode.replaceChild(newConfirmYes, this._confirmYes);
    this._confirmYes = newConfirmYes;

    var newConfirmNo = this._confirmNo.cloneNode(true);
    this._confirmNo.parentNode.replaceChild(newConfirmNo, this._confirmNo);
    this._confirmNo = newConfirmNo;

    newConfirmYes.addEventListener('click', function () {
      self._inlineEl.classList.remove('confirming');
      self._confirming = false;
      onConfirm();
    });

    newConfirmNo.addEventListener('click', function () {
      self._inlineEl.classList.remove('confirming');
      self._confirming = false;
      self._updateInlineActions();
    });
  };

  // ─── Selection Mode Instances & Handlers ────────────────────────────────────

  var prSelection = new SelectionMode({
    tabId: 'pr-tab',
    containerId: 'recent-reviews-container',
    tbodyId: 'recent-reviews-tbody',
    rowIdAttr: 'reviewId',
    actions: [
      { label: 'Delete', className: 'btn-bulk-delete', handler: handleBulkDeletePR }
    ]
  });

  var localSelection = new SelectionMode({
    tabId: 'local-tab',
    containerId: 'local-reviews-container',
    tbodyId: 'local-reviews-tbody',
    rowIdAttr: 'sessionId',
    actions: [
      { label: 'Delete', className: 'btn-bulk-delete', handler: handleBulkDeleteLocal }
    ]
  });

  var reviewRequestsSelection = new SelectionMode({
    tabId: 'review-requests-tab',
    containerId: 'review-requests-container',
    tbodyId: 'review-requests-tbody',
    rowIdAttr: 'prUrl',
    actions: [
      { label: 'Open', className: 'btn-bulk-open', handler: handleBulkOpen },
      { label: 'Analyze', className: 'btn-bulk-analyze', handler: handleBulkAnalyze }
    ]
  });

  var myPrsSelection = new SelectionMode({
    tabId: 'my-prs-tab',
    containerId: 'my-prs-container',
    tbodyId: 'my-prs-tbody',
    rowIdAttr: 'prUrl',
    actions: [
      { label: 'Open', className: 'btn-bulk-open', handler: handleBulkOpen },
      { label: 'Analyze', className: 'btn-bulk-analyze', handler: handleBulkAnalyze }
    ]
  });

  async function handleBulkDeletePR(selectedIds, selectionInstance) {
    var count = selectedIds.size;
    selectionInstance.showConfirm('Delete ' + count + ' review' + (count === 1 ? '' : 's') + '?', async function () {
      try {
        var response = await fetch('/api/worktrees/bulk-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: Array.from(selectedIds).map(Number) })
        });
        var data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Bulk delete failed');

        if (data.failed > 0) {
          if (window.toast) window.toast.error(data.failed + ' of ' + count + ' failed to delete');
        } else {
          if (window.toast) window.toast.success('Deleted ' + data.deleted + ' review' + (data.deleted === 1 ? '' : 's'));
        }

        selectionInstance.exit();
        await loadRecentReviews();
      } catch (error) {
        console.error('Bulk delete PR error:', error);
        if (window.toast) window.toast.error('Bulk delete failed: ' + error.message);
        selectionInstance.exit();
        await loadRecentReviews();
      }
    });
  }

  async function handleBulkDeleteLocal(selectedIds, selectionInstance) {
    var count = selectedIds.size;
    selectionInstance.showConfirm('Delete ' + count + ' session' + (count === 1 ? '' : 's') + '?', async function () {
      try {
        var response = await fetch('/api/local/sessions/bulk-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: Array.from(selectedIds).map(Number) })
        });
        var data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Bulk delete failed');

        if (data.failed > 0) {
          if (window.toast) window.toast.error(data.failed + ' of ' + count + ' failed to delete');
        } else {
          if (window.toast) window.toast.success('Deleted ' + data.deleted + ' session' + (data.deleted === 1 ? '' : 's'));
        }

        selectionInstance.exit();
        await loadLocalReviews();
      } catch (error) {
        console.error('Bulk delete local error:', error);
        if (window.toast) window.toast.error('Bulk delete failed: ' + error.message);
        selectionInstance.exit();
        await loadLocalReviews();
      }
    });
  }

  /**
   * Build pair-review URLs from selected collection rows.
   * @param {Set} selectedIds - PR URLs (data-pr-url values)
   * @param {string} tbodyId - tbody element ID
   * @param {string} [query] - optional query string (e.g. '?analyze=true')
   * @returns {string[]} array of pair-review URLs
   */
  function buildReviewUrls(selectedIds, tbodyId, query) {
    var tbody = document.getElementById(tbodyId);
    if (!tbody) return [];
    var urls = [];
    selectedIds.forEach(function (prUrl) {
      var row = tbody.querySelector('tr[data-pr-url="' + CSS.escape(prUrl) + '"]');
      if (!row) return;
      var owner = row.dataset.owner;
      var repo = row.dataset.repo;
      var number = row.dataset.number;
      if (owner && repo && number) {
        urls.push('/pr/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/' + number + (query || ''));
      }
    });
    return urls;
  }

  /**
   * Open multiple review URLs via the server-side /api/bulk-open endpoint.
   * The server uses the OS `open` command to launch each URL in the default
   * browser, bypassing popup blockers entirely.
   */
  function bulkOpenUrls(urls) {
    if (urls.length === 0) return;
    fetch('/api/bulk-open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: urls })
    }).catch(function (err) {
      console.error('Bulk open failed:', err);
      if (window.toast) window.toast.error('Failed to open reviews');
    });
  }

  function handleBulkOpen(selectedIds, selectionInstance) {
    var urls = buildReviewUrls(selectedIds, selectionInstance.config.tbodyId);
    selectionInstance.exit();
    bulkOpenUrls(urls);
  }

  function handleBulkAnalyze(selectedIds, selectionInstance) {
    var urls = buildReviewUrls(selectedIds, selectionInstance.config.tbodyId, '?analyze=true');
    selectionInstance.exit();
    bulkOpenUrls(urls);
  }

  // ─── Event Delegation ───────────────────────────────────────────────────────

  // Event delegation for buttons, show-more, tab switching
  document.addEventListener('click', function (event) {
    // Delete review (PR mode)
    const deleteBtn = event.target.closest('.btn-delete-review');
    if (deleteBtn) {
      event.preventDefault();
      event.stopPropagation();
      showDeleteReviewConfirm(deleteBtn);
      return;
    }

    // Delete local session
    const deleteSessionBtn = event.target.closest('.btn-delete-session');
    if (deleteSessionBtn) {
      event.preventDefault();
      event.stopPropagation();
      showDeleteSessionConfirm(deleteSessionBtn);
      return;
    }

    // Refresh buttons for GitHub collections
    var refreshReviewRequestsBtn = event.target.closest('#refresh-review-requests');
    if (refreshReviewRequestsBtn) {
      event.preventDefault();
      refreshCollectionPrs('review-requests', 'review-requests-container', reviewRequestsState);
      return;
    }

    var refreshMyPrsBtn = event.target.closest('#refresh-my-prs');
    if (refreshMyPrsBtn) {
      event.preventDefault();
      refreshCollectionPrs('my-prs', 'my-prs-container', myPrsState);
      return;
    }

    // Select toggle button
    var selectToggle = event.target.closest('.btn-select-toggle');
    if (selectToggle) {
      event.preventDefault();
      var tabId = selectToggle.dataset.selectionTab;
      var instances = { 'pr-tab': prSelection, 'local-tab': localSelection, 'review-requests-tab': reviewRequestsSelection, 'my-prs-tab': myPrsSelection };
      var instance = instances[tabId];
      if (instance) instance.toggle();
      return;
    }

    // Click on a collection PR row — toggle checkbox in selection mode, else start review
    var collectionRow = event.target.closest('.collection-pr-row');
    if (collectionRow && !event.target.closest('a') && !event.target.closest('.col-select')) {
      // If in selection mode, toggle the row's checkbox
      if (activeSelection && activeSelection.active && collectionRow.closest('.selection-mode')) {
        var cb = collectionRow.querySelector('.col-select input[type="checkbox"]');
        if (cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        }
        return;
      }

      var prUrl = collectionRow.dataset.prUrl;
      if (prUrl) {
        // Switch to PR tab to show loading state (do NOT persist to
        // localStorage – the user's intentional tab choice should be preserved)
        var tabBar = document.getElementById('unified-tab-bar');
        var prTabBtn = tabBar.querySelector('[data-tab="pr-tab"]');
        switchTab(tabBar, prTabBtn);

        // Populate input and submit the form programmatically
        var input = document.getElementById('pr-url-input');
        if (input) {
          input.value = prUrl;
          // Trigger the form submit
          var form = document.getElementById('start-review-form');
          if (form) {
            form.dispatchEvent(new Event('submit', { cancelable: true }));
          }
        }
      }
      return;
    }

    // Show more (PR reviews)
    const showMoreBtn = event.target.closest('#btn-show-more');
    if (showMoreBtn) {
      event.preventDefault();
      loadMoreReviews();
      return;
    }

    // Show more (local reviews)
    const localShowMoreBtn = event.target.closest('#btn-local-show-more');
    if (localShowMoreBtn) {
      event.preventDefault();
      loadMoreLocalReviews();
      return;
    }

    // Unified tab switching
    const unifiedTabBtn = event.target.closest('#unified-tab-bar .tab-btn');
    if (unifiedTabBtn) {
      const tabBar = document.getElementById('unified-tab-bar');
      switchTab(tabBar, unifiedTabBtn, async function (tabId) {
        // Exit any active selection mode when switching tabs
        if (activeSelection) activeSelection.exit();
        // Persist tab choice
        localStorage.setItem(TAB_STORAGE_KEY, tabId);
        // Lazy-load local reviews on first switch
        if (tabId === 'local-tab' && !localReviewsPagination.loaded) {
          loadLocalReviews();
        }
        // Load cached data on first switch, then always refresh from GitHub
        if (tabId === 'review-requests-tab') {
          if (!reviewRequestsState.loaded) {
            await loadCollectionPrs('review-requests', 'review-requests-container', reviewRequestsState);
          }
          refreshCollectionPrs('review-requests', 'review-requests-container', reviewRequestsState);
        }
        if (tabId === 'my-prs-tab') {
          if (!myPrsState.loaded) {
            await loadCollectionPrs('my-prs', 'my-prs-container', myPrsState);
          }
          refreshCollectionPrs('my-prs', 'my-prs-container', myPrsState);
        }
      });
      return;
    }
  });

  // ─── DOMContentLoaded Initialization ────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async function () {
    // Load config and update command examples based on npx detection.
    // Await so that window.__pairReview.enableGraphite (and other config
    // values) are available before any tab content is rendered.
    await loadConfigAndUpdateUI();

    // Restore saved tab from localStorage (default: 'pr-tab')
    const savedTab = localStorage.getItem(TAB_STORAGE_KEY) || 'pr-tab';
    const tabBar = document.getElementById('unified-tab-bar');
    if (tabBar) {
      const targetBtn = tabBar.querySelector('[data-tab="' + savedTab + '"]');
      if (targetBtn && savedTab !== 'pr-tab') {
        // Switch to saved tab (pr-tab is already active by default in HTML)
        switchTab(tabBar, targetBtn);
      }
    }

    // Always load PR reviews (they show on initial load)
    loadRecentReviews();

    // If local tab is active, load local reviews immediately
    if (savedTab === 'local-tab') {
      loadLocalReviews();
    }

    // If a GitHub collection tab is active, load cached data then refresh from GitHub
    if (savedTab === 'review-requests-tab') {
      loadCollectionPrs('review-requests', 'review-requests-container', reviewRequestsState)
        .then(function () { refreshCollectionPrs('review-requests', 'review-requests-container', reviewRequestsState); });
    }
    if (savedTab === 'my-prs-tab') {
      loadCollectionPrs('my-prs', 'my-prs-container', myPrsState)
        .then(function () { refreshCollectionPrs('my-prs', 'my-prs-container', myPrsState); });
    }

    // Set up start review form handler
    const form = document.getElementById('start-review-form');
    if (form) {
      form.addEventListener('submit', handleStartReview);
    }

    // Set up local review form handler
    const localForm = document.getElementById('start-local-form');
    if (localForm) {
      localForm.addEventListener('submit', handleStartLocal);
    }

    // Set up browse button handler
    const browseBtn = document.getElementById('browse-local-btn');
    if (browseBtn) {
      browseBtn.addEventListener('click', handleBrowseLocal);
    }

    // Note: No explicit Enter keypress handlers are needed here.
    // Both inputs are inside <form> elements, so pressing Enter
    // natively triggers form submission.

    // ─── Create Select toggle buttons for each tab ──────────────────────────

    function createSelectButton(tabId) {
      var btn = document.createElement('button');
      btn.className = 'btn-select-toggle';
      btn.type = 'button';
      btn.textContent = 'Select';
      btn.dataset.selectionTab = tabId;
      return btn;
    }

    // PR tab: insert header between form and container
    var prTab = document.getElementById('pr-tab');
    if (prTab) {
      var prContainer = document.getElementById('recent-reviews-container');
      var prHeader = document.createElement('div');
      prHeader.className = 'select-mode-header visible';
      var prBtn = createSelectButton('pr-tab');
      prSelection._toggleBtn = prBtn;
      prHeader.appendChild(prBtn);
      prTab.insertBefore(prHeader, prContainer);
    }

    // Local tab: insert header between form and container
    var localTab = document.getElementById('local-tab');
    if (localTab) {
      var localContainer = document.getElementById('local-reviews-container');
      var localHeader = document.createElement('div');
      localHeader.className = 'select-mode-header visible';
      var localBtn = createSelectButton('local-tab');
      localSelection._toggleBtn = localBtn;
      localHeader.appendChild(localBtn);
      localTab.insertBefore(localHeader, localContainer);
    }

    // Review Requests tab: add to existing header
    var rrHeader = document.querySelector('#review-requests-tab .tab-pane-header');
    if (rrHeader) {
      var rrBtn = createSelectButton('review-requests-tab');
      reviewRequestsSelection._toggleBtn = rrBtn;
      rrHeader.insertBefore(rrBtn, rrHeader.firstChild);
    }

    // My PRs tab: add to existing header
    var mpHeader = document.querySelector('#my-prs-tab .tab-pane-header');
    if (mpHeader) {
      var mpBtn = createSelectButton('my-prs-tab');
      myPrsSelection._toggleBtn = mpBtn;
      mpHeader.insertBefore(mpBtn, mpHeader.firstChild);
    }
  });

  // ─── bfcache Restoration ───────────────────────────────────────────────────

  // When the browser restores this page from bfcache (e.g. user hits the back
  // button after navigating away), any in-progress loading state on the forms
  // will still be visible because the DOM snapshot is preserved as-is.  Reset
  // both forms so the user is not stuck with a disabled input and spinner.
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
      setFormLoading('pr', false);
      setFormLoading('local', false);
    }
  });

})();
