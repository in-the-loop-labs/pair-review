// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Local Mode Manager
 *
 * Extends PRManager for local review mode by:
 * - Redirecting API calls to /api/local/:reviewId/* endpoints
 * - Hiding GitHub-specific UI elements
 * - Adapting the UI for local uncommitted changes review
 */
// STALE_TIMEOUT is declared in pr.js (shared global scope via script tags)

class LocalManager {
  /**
   * Create LocalManager instance.
   *
   * INITIALIZATION ORDER DEPENDENCY:
   * LocalManager requires PRManager to be fully initialized before patching.
   * The initialization order is:
   * 1. PRManager is created and attached to window.prManager (in pr.js)
   * 2. LocalManager is created (in local.js, loaded after pr.js)
   * 3. LocalManager.init() patches PRManager methods
   *
   * If PRManager is not ready when LocalManager is constructed, we defer
   * initialization until DOMContentLoaded with a setTimeout(0) to ensure
   * PRManager's constructor has completed.
   */
  constructor() {
    this.reviewId = null;
    this.localData = null;
    this.isInitialized = false;

    // Wait for PRManager to be ready, then initialize local mode
    if (window.prManager) {
      this.init();
    } else {
      // PRManager not yet created, wait for DOMContentLoaded
      document.addEventListener('DOMContentLoaded', () => {
        // Give PRManager time to initialize
        setTimeout(() => this.init(), 0);
      });
    }
  }

  /**
   * Initialize local mode
   */
  async init() {
    if (this.isInitialized) return;

    // Extract review ID from URL
    const pathMatch = window.location.pathname.match(/^\/local\/(\d+)$/);
    if (!pathMatch) {
      console.error('Invalid local review URL');
      return;
    }

    this.reviewId = parseInt(pathMatch[1]);
    console.log('Local mode initialized with review ID:', this.reviewId);

    // Override PRManager methods before it tries to load anything
    this.patchPRManager();

    // Hide PR-specific UI elements
    this.hideGitHubElements();

    // Initialize refresh button
    this.initRefreshButton();

    // Load local review data
    await this.loadLocalReview();

    // Auto-trigger analysis if ?analyze=true is present
    const autoAnalyze = new URLSearchParams(window.location.search).get('analyze');
    if (autoAnalyze === 'true' && !window.prManager.isAnalyzing) {
      try {
        await this.startLocalAnalysis(null, {});
      } finally {
        const cleanUrl = new URL(window.location);
        cleanUrl.searchParams.delete('analyze');
        history.replaceState(null, '', cleanUrl);
      }
    }

    this.isInitialized = true;
  }

  /**
   * Patch PRManager to use local API endpoints.
   *
   * NOTE: This method uses monkey patching to override PRManager methods at runtime.
   * While monkey patching is generally discouraged in favor of patterns like strategy/adapter,
   * it is acceptable here because:
   * 1. This is a local-only web application with a single entry point
   * 2. LocalManager is tightly coupled to PRManager by design
   * 3. The patching happens once at initialization, not dynamically
   * 4. A strategy pattern would require significant refactoring of PRManager for minimal benefit
   * 5. The current approach is working and well-tested
   */
  patchPRManager() {
    const manager = window.prManager;
    if (!manager) {
      console.error('PRManager not available for patching');
      return;
    }

    const reviewId = this.reviewId;

    // Store reference to this for closures
    const self = this;

    // Initialize collapse and viewed state Sets (ensure they exist)
    if (!manager.collapsedFiles) {
      manager.collapsedFiles = new Set();
    }
    if (!manager.viewedFiles) {
      manager.viewedFiles = new Set();
    }

    // Override saveViewedState to use localStorage with scoped key
    manager.saveViewedState = function() {
      if (!manager.currentPR || !manager.currentPR.localPath || !manager.currentPR.head_sha) return;

      const localPath = manager.currentPR.localPath;
      const headSha = manager.currentPR.head_sha;
      // Use encodeURIComponent + unescape for proper UTF-8 to Base64 conversion (handles non-Latin1 paths)
      const key = `pair-review-local-viewed:${btoa(unescape(encodeURIComponent(localPath)))}:${headSha}`;
      const viewedArray = Array.from(manager.viewedFiles);

      try {
        localStorage.setItem(key, JSON.stringify(viewedArray));
      } catch (error) {
        console.warn('Error saving viewed state to localStorage:', error);
      }
    };

    // Override loadViewedState to use localStorage with scoped key
    manager.loadViewedState = async function() {
      if (!manager.currentPR || !manager.currentPR.localPath || !manager.currentPR.head_sha) return;

      const localPath = manager.currentPR.localPath;
      const headSha = manager.currentPR.head_sha;
      // Use encodeURIComponent + unescape for proper UTF-8 to Base64 conversion (handles non-Latin1 paths)
      const key = `pair-review-local-viewed:${btoa(unescape(encodeURIComponent(localPath)))}:${headSha}`;

      try {
        const stored = localStorage.getItem(key);
        if (stored) {
          manager.viewedFiles = new Set(JSON.parse(stored));
        } else {
          manager.viewedFiles = new Set();
        }
      } catch (error) {
        console.warn('Error loading viewed state from localStorage:', error);
        manager.viewedFiles = new Set();
      }
    };

    // Override init to prevent default PR loading
    manager.init = async function() {
      // Local mode init is handled by LocalManager
      console.log('PRManager init skipped - local mode active');
    };

    // Override loadPR to load local review data
    manager.loadPR = async function() {
      // Delegate to LocalManager
      await self.loadLocalReview();
    };

    // Store original methods we need to patch
    const originalLoadUserComments = manager.loadUserComments.bind(manager);
    const originalLoadAISuggestions = manager.loadAISuggestions.bind(manager);

    // Override loadUserComments
    // DESIGN DECISION: Dismissed comments are NEVER shown in the diff panel.
    // They only appear in the AI/Review Panel when the "show dismissed" filter is ON.
    // This provides cleaner UX - the diff view shows only active comments, while
    // the AI Panel serves as the "inbox" where you can optionally see and restore dismissed items.
    manager.loadUserComments = async function(includeDismissed = false) {
      if (!manager.currentPR) return;

      try {
        const queryParam = includeDismissed ? '?includeDismissed=true' : '';
        const response = await fetch(`/api/local/${reviewId}/user-comments${queryParam}`);
        if (!response.ok) return;

        const data = await response.json();
        manager.userComments = data.comments || [];

        // Separate file-level and line-level comments for diff view rendering
        // Skip inactive (dismissed) comments - they should not appear in the diff view
        const fileLevelComments = [];
        const lineLevelComments = [];

        manager.userComments.forEach(comment => {
          // Skip inactive (dismissed) comments - they should not appear in the diff view
          if (comment.status === 'inactive') {
            return;
          }
          if (comment.is_file_level === 1) {
            fileLevelComments.push(comment);
          } else {
            lineLevelComments.push(comment);
          }
        });

        // Clear existing comment rows before re-rendering
        document.querySelectorAll('.user-comment-row').forEach(row => row.remove());

        // Display line-level comments inline with diff (only active comments reach here)
        lineLevelComments.forEach(comment => {
          const fileElement = manager.findFileElement(comment.file);
          if (!fileElement) return;

          // Use the comment's side to determine which coordinate system to search in
          // LEFT side = OLD coordinates (deleted lines or context lines in OLD coords)
          // RIGHT side = NEW coordinates (added lines or context lines in NEW coords)
          const side = comment.side || 'RIGHT';

          const lineRows = fileElement.querySelectorAll('tr');
          for (const row of lineRows) {
            // Pass side to getLineNumber() to get the correct coordinate system
            // This allows context lines (which have BOTH old and new line numbers) to be found
            // when the comment was placed on a LEFT-side line (old coordinate)
            const lineNum = manager.getLineNumber(row, side);
            if (lineNum === comment.line_start) {
              manager.displayUserComment(comment, row);
              break;
            }
          }
        });

        // Load file-level comments into their zones (only active comments reach here)
        if (manager.fileCommentManager && fileLevelComments.length > 0) {
          manager.fileCommentManager.loadFileComments(fileLevelComments, []);
        }

        // Populate AI Panel with all comments (including dismissed if requested)
        if (window.aiPanel?.setComments) {
          window.aiPanel.setComments(manager.userComments);
        }

        manager.updateCommentCount();
      } catch (error) {
        console.error('Error loading user comments:', error);
      }
    };

    // Override loadAISuggestions
    manager.loadAISuggestions = async function(level = null, runId = null) {
      if (!manager.currentPR) return;

      try {
        const filterLevel = level || manager.selectedLevel || 'final';
        // Use provided runId, or fall back to selectedRunId (which may be null for latest)
        const filterRunId = runId !== undefined ? runId : manager.selectedRunId;

        // First, check if analysis has been run and get summary data for the selected run
        try {
          let checkUrl = `/api/local/${reviewId}/has-ai-suggestions`;
          if (filterRunId) {
            checkUrl += `?runId=${filterRunId}`;
          }
          const checkResponse = await fetch(checkUrl);
          if (checkResponse.ok) {
            const checkData = await checkResponse.json();

            // Store summary data in the AI panel for the AI Summary modal
            if (window.aiPanel?.setSummaryData) {
              window.aiPanel.setSummaryData({
                summary: checkData.summary,
                stats: checkData.stats
              });
            }

            // Set analysis state based on whether analysis has run (not just whether we have suggestions)
            if (window.aiPanel?.setAnalysisState) {
              window.aiPanel.setAnalysisState(checkData.analysisHasRun ? 'complete' : 'unknown');
            }
          }
        } catch (checkError) {
          console.warn('Error checking analysis status:', checkError);
        }

        let url = `/api/local/${reviewId}/suggestions?levels=${filterLevel}`;
        if (filterRunId) {
          url += `&runId=${filterRunId}`;
        }

        const response = await fetch(url);
        if (!response.ok) return;

        const data = await response.json();
        if (data.suggestions && data.suggestions.length > 0) {
          await manager.displayAISuggestions(data.suggestions);
        } else {
          await manager.displayAISuggestions([]);
        }
      } catch (error) {
        console.error('Error loading AI suggestions:', error);
      }
    };

    // Override triggerAIAnalysis for local mode
    manager.triggerAIAnalysis = async function() {
      // Timeout (ms) for stale check — git commands can hang on locked repos.
      // Defined locally to avoid relying on cross-script const from pr.js.
      const STALE_TIMEOUT = 2000;

      if (manager.isAnalyzing) {
        manager.reopenProgressModal();
        return;
      }

      if (!manager.currentPR) {
        manager.showError('No local review loaded');
        return;
      }

      const btn = manager.getAnalyzeButton();
      if (btn && btn.disabled) {
        return;
      }

      try {
        // Show analysis config modal
        if (!manager.analysisConfigModal) {
          console.warn('AnalysisConfigModal not initialized, proceeding without config');
          await self.startLocalAnalysis(btn, {});
          return;
        }

        // Run stale check and settings fetch in parallel to minimize dialog delay
        // Use AbortController so the fetch is truly cancelled on timeout,
        // freeing the HTTP connection for subsequent requests.
        const _tParallel0 = performance.now();
        const staleAbort = new AbortController();
        const staleTimer = setTimeout(() => {
          console.debug(`[Analyze] stale-check timed out after ${STALE_TIMEOUT}ms, aborting`);
          staleAbort.abort();
        }, STALE_TIMEOUT);
        const staleCheckWithTimeout = fetch(`/api/local/${reviewId}/check-stale`, { signal: staleAbort.signal })
          .then(r => r.ok ? r.json() : null)
          .then(result => { clearTimeout(staleTimer); return result; })
          .catch(() => { clearTimeout(staleTimer); return null; });
        const [staleResult, repoSettings, reviewSettings] = await Promise.all([
          staleCheckWithTimeout,
          manager.fetchRepoSettings().catch(() => null),
          manager.fetchLastReviewSettings().catch(() => ({ custom_instructions: '', last_council_id: null }))
        ]);
        console.debug(`[Analyze] parallel-fetch (stale+settings): ${Math.round(performance.now() - _tParallel0)}ms`);

        // Handle staleness result — check for expected properties to distinguish
        // a valid response from a failed/timed-out fetch (which resolves to null)
        if (staleResult && 'isStale' in staleResult) {
          if (staleResult.isStale === null && staleResult.error) {
            if (window.toast) {
              window.toast.showWarning('Could not verify working directory is current.');
            }
          } else if (staleResult.isStale === true) {
            if (window.confirmDialog) {
              const choice = await window.confirmDialog.show({
                title: 'Files Have Changed',
                message: 'The working directory has changed since you loaded the diff. What would you like to do?',
                confirmText: 'Refresh & Analyze',
                confirmClass: 'btn-primary',
                secondaryText: 'Analyze Anyway',
                secondaryClass: 'btn-warning'
              });

              if (choice === 'confirm') {
                await self.refreshDiff();
              } else if (choice !== 'secondary') {
                return;
              }
            }
          }
        } else {
          // Network error, HTTP error, or timeout — fail open with warning
          if (window.toast) {
            window.toast.showWarning('Could not verify working directory is current.');
          }
        }

        const lastInstructions = reviewSettings.custom_instructions;
        const lastCouncilId = reviewSettings.last_council_id;

        // Determine model and provider
        const modelStorageKey = `pair-review-model:local-${reviewId}`;
        const providerStorageKey = `pair-review-provider:local-${reviewId}`;
        const rememberedModel = localStorage.getItem(modelStorageKey);
        const rememberedProvider = localStorage.getItem(providerStorageKey);
        const currentModel = rememberedModel || repoSettings?.default_model || 'opus';
        const currentProvider = rememberedProvider || repoSettings?.default_provider || 'claude';

        // Determine default tab (priority: localStorage > repo settings > 'single')
        const tabStorageKey = `pair-review-tab:local-${reviewId}`;
        const rememberedTab = localStorage.getItem(tabStorageKey);
        const defaultTab = rememberedTab || repoSettings?.default_tab || 'single';

        // Save tab selection to localStorage when user switches tabs
        manager.analysisConfigModal.onTabChange = (tabId) => {
          localStorage.setItem(tabStorageKey, tabId);
        };

        // Show config modal
        const config = await manager.analysisConfigModal.show({
          currentModel,
          currentProvider,
          defaultTab,
          repoInstructions: repoSettings?.default_instructions || '',
          lastInstructions: lastInstructions,
          lastCouncilId,
          defaultCouncilId: repoSettings?.default_council_id || null,
          rememberModel: !!(rememberedModel || rememberedProvider)
        });

        if (!config) {
          return;
        }

        // Save preferences if requested
        if (config.rememberModel) {
          localStorage.setItem(modelStorageKey, config.model);
          localStorage.setItem(providerStorageKey, config.provider);
        } else {
          localStorage.removeItem(modelStorageKey);
          localStorage.removeItem(providerStorageKey);
        }

        // Start analysis
        await self.startLocalAnalysis(btn, config);

      } catch (error) {
        console.error('Error triggering AI analysis:', error);
        manager.showError(`Failed to start AI analysis: ${error.message}`);
        manager.resetButton();
      }
    };

    // Override checkRunningAnalysis
    manager.checkRunningAnalysis = async function() {
      try {
        const response = await fetch(`/api/local/${reviewId}/analysis-status`);
        if (!response.ok) return;

        const data = await response.json();
        if (data.running && data.analysisId) {
          manager.currentAnalysisId = data.analysisId;
          manager.isAnalyzing = true;
          manager.setButtonAnalyzing(data.analysisId);

          // Show the appropriate progress modal
          if (data.status?.isCouncil && window.councilProgressModal && data.status?.councilConfig) {
            window.councilProgressModal.setLocalMode(reviewId);
            window.councilProgressModal.show(
              data.analysisId,
              data.status.councilConfig,
              null,
              { configType: data.status.configType || 'advanced' }
            );
          } else if (window.progressModal) {
            // Update the SSE endpoint for progress modal
            self.patchProgressModalForLocal();
            window.progressModal.show(data.analysisId);
          }
        }
      } catch (error) {
        console.warn('Error checking running analysis:', error);
      }
    };

    // Patch CommentManager.saveUserComment for local mode
    // This is the method that handles creating new comments via the form
    if (manager.commentManager) {
      const cm = manager.commentManager;
      const originalSaveUserComment = cm.saveUserComment.bind(cm);

      cm.saveUserComment = async function(textarea, formRow) {
        const fileName = textarea.dataset.file;
        const lineNumber = parseInt(textarea.dataset.line);
        const parsedEndLine = parseInt(textarea.dataset.lineEnd);
        const endLineNumber = !isNaN(parsedEndLine) ? parsedEndLine : lineNumber;
        const diffPosition = textarea.dataset.diffPosition ? parseInt(textarea.dataset.diffPosition) : null;
        const side = textarea.dataset.side || 'RIGHT';
        const content = textarea.value.trim();

        if (!content) {
          return;
        }

        // Prevent duplicate saves from rapid clicks or Cmd+Enter
        const saveBtn = formRow?.querySelector('.save-comment-btn');
        if (saveBtn?.dataset.saving === 'true') {
          return;
        }
        if (saveBtn) saveBtn.dataset.saving = 'true';
        if (saveBtn) saveBtn.disabled = true;

        try {
          const response = await fetch(`/api/local/${reviewId}/user-comments`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              file: fileName,
              line_start: lineNumber,
              line_end: endLineNumber,
              diff_position: diffPosition,
              side: side,
              body: content
            })
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to save comment');
          }

          const result = await response.json();

          // Build comment object
          const commentData = {
            id: result.commentId,
            file: fileName,
            line_start: lineNumber,
            line_end: endLineNumber,
            diff_position: diffPosition,
            side: side,  // Include side for suggestion code extraction
            body: content,
            created_at: new Date().toISOString()
          };

          // Create comment display row
          const targetRow = formRow.previousElementSibling;
          if (!targetRow) {
            console.error('Could not find target row for comment display');
            return;
          }
          cm.displayUserComment(commentData, targetRow);

          // Notify AI Panel about the new comment
          if (window.aiPanel?.addComment) {
            window.aiPanel.addComment(commentData);
          }

          // Hide form and clear selection
          cm.hideCommentForm();
          if (cm.prManager?.lineTracker) {
            cm.prManager.lineTracker.clearRangeSelection();
          }

          // Update comment count
          if (cm.prManager?.updateCommentCount) {
            cm.prManager.updateCommentCount();
          }
        } catch (error) {
          console.error('Error saving user comment:', error);
          alert('Failed to save comment: ' + error.message);
          // Re-enable save button on failure so the user can retry
          if (saveBtn) {
            saveBtn.dataset.saving = 'false';
            saveBtn.disabled = false;
          }
        }
      };
    }

    // Patch PRManager.deleteUserComment for local mode
    // DESIGN DECISION: Dismissed comments are NEVER shown in the diff panel.
    // They only appear in the AI/Review Panel when the "show dismissed" filter is ON.
    const originalDeleteUserComment = manager.deleteUserComment?.bind(manager);
    if (originalDeleteUserComment) {
      manager.deleteUserComment = async function(commentId) {
        try {
          const response = await fetch(`/api/local/${reviewId}/user-comments/${commentId}`, {
            method: 'DELETE'
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete comment');
          }

          const apiResult = await response.json();

          // Check if dismissed comments filter is enabled for AI Panel updates
          const showDismissed = window.aiPanel?.showDismissedComments || false;

          // Always remove the comment from the diff view (design decision: dismissed comments never shown in diff)
          const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
          if (commentRow) {
            commentRow.remove();
            manager.updateCommentCount();
          }

          // Also handle file-level comment cards
          const fileCommentCard = document.querySelector(`.file-comment-card[data-comment-id="${commentId}"]`);
          if (fileCommentCard) {
            const zone = fileCommentCard.closest('.file-comments-zone');
            fileCommentCard.remove();
            if (zone && manager.fileCommentManager) {
              manager.fileCommentManager.updateCommentCount(zone);
            }
            manager.updateCommentCount();
          }

          // Update AI Panel - transition to dismissed state or remove based on filter
          if (showDismissed && window.aiPanel?.updateComment) {
            // Update comment status to 'inactive' so it renders with dismissed styling in AI Panel
            window.aiPanel.updateComment(commentId, { status: 'inactive' });
          } else if (window.aiPanel?.removeComment) {
            window.aiPanel.removeComment(commentId);
          }

          // If a parent suggestion existed, the suggestion card is still collapsed/dismissed in the diff view.
          // Update AIPanel to show the suggestion as 'dismissed' (matching its visual state).
          // User can click "Show" to restore it to active state if they want to re-adopt.
          if (apiResult.dismissedSuggestionId && window.aiPanel?.updateFindingStatus) {
            window.aiPanel.updateFindingStatus(apiResult.dismissedSuggestionId, 'dismissed');
          }

          // Show success toast
          if (window.toast) {
            window.toast.showSuccess('Comment dismissed');
          }
        } catch (error) {
          console.error('Error deleting comment:', error);
          if (window.toast) {
            window.toast.showError('Failed to dismiss comment');
          }
        }
      };
    }

    // Patch PRManager.editUserComment for local mode
    // This method fetches comment data when editing
    const originalEditUserComment = manager.editUserComment?.bind(manager);
    if (originalEditUserComment) {
      manager.editUserComment = async function(commentId) {
        try {
          const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
          if (!commentRow) return;

          const commentDiv = commentRow.querySelector('.user-comment');
          const bodyDiv = commentDiv.querySelector('.user-comment-body');
          let currentText = bodyDiv.dataset.originalMarkdown || '';

          // Fetch from local endpoint if needed
          if (!currentText) {
            const response = await fetch(`/api/local/${reviewId}/user-comments/${commentId}`);
            if (response.ok) {
              const data = await response.json();
              currentText = data.body || bodyDiv.textContent.trim();
            } else {
              currentText = bodyDiv.textContent.trim();
            }
          }

          if (commentDiv.classList.contains('editing-mode')) return;

          commentDiv.classList.add('editing-mode');

          const fileName = commentRow.dataset.file || '';
          const lineStart = commentRow.dataset.lineStart || '';
          const lineEnd = commentRow.dataset.lineEnd || lineStart;
          const side = commentRow.dataset.side || '';

          const editFormHTML = `
            <div class="user-comment-edit-form">
              <div class="comment-form-toolbar">
                <button type="button" class="btn btn-sm suggestion-btn" title="Insert a suggestion">
                  ${CommentManager.SUGGESTION_ICON_SVG}
                </button>
              </div>
              <textarea
                id="edit-comment-${commentId}"
                class="comment-edit-textarea"
                placeholder="Enter your comment..."
                data-file="${fileName}"
                data-line="${lineStart}"
                data-line-end="${lineEnd}"
                data-side="${side || 'RIGHT'}"
              >${manager.escapeHtml(currentText)}</textarea>
              <div class="comment-edit-actions">
                <button class="btn btn-sm btn-primary save-edit-btn">Save</button>
                <button class="btn btn-sm btn-secondary cancel-edit-btn">Cancel</button>
              </div>
            </div>
          `;

          bodyDiv.style.display = 'none';
          bodyDiv.insertAdjacentHTML('afterend', editFormHTML);

          const editForm = commentDiv.querySelector('.user-comment-edit-form');
          const textarea = document.getElementById(`edit-comment-${commentId}`);
          const suggestionBtn = editForm.querySelector('.suggestion-btn');
          const saveBtn = editForm.querySelector('.save-edit-btn');
          const cancelBtn = editForm.querySelector('.cancel-edit-btn');

          if (textarea) {
            manager.autoResizeTextarea(textarea);
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            manager.updateSuggestionButtonState(textarea, suggestionBtn);

            suggestionBtn.addEventListener('click', () => {
              if (!suggestionBtn.disabled) {
                manager.insertSuggestionBlock(textarea, suggestionBtn);
              }
            });

            saveBtn.addEventListener('click', () => manager.saveEditedUserComment(commentId));
            cancelBtn.addEventListener('click', () => manager.cancelEditUserComment(commentId));

            textarea.addEventListener('input', () => {
              manager.autoResizeTextarea(textarea);
              manager.updateSuggestionButtonState(textarea, suggestionBtn);
            });
          }
        } catch (error) {
          console.error('Error editing comment:', error);
          alert('Failed to edit comment');
        }
      };
    }

    // Patch PRManager.saveEditedUserComment for local mode
    const originalSaveEditedUserComment = manager.saveEditedUserComment?.bind(manager);
    if (originalSaveEditedUserComment) {
      manager.saveEditedUserComment = async function(commentId) {
        // Prevent duplicate saves from rapid clicks or Cmd+Enter
        const editFormEl = document.querySelector(`#edit-comment-${commentId}`)?.closest('.user-comment-edit-form');
        const saveBtnEl = editFormEl?.querySelector('.save-edit-btn');
        if (saveBtnEl?.dataset.saving === 'true') {
          return;
        }
        if (saveBtnEl) saveBtnEl.dataset.saving = 'true';
        if (saveBtnEl) saveBtnEl.disabled = true;

        try {
          const textarea = document.getElementById(`edit-comment-${commentId}`);
          const editedText = textarea.value.trim();

          if (!editedText) {
            alert('Comment cannot be empty');
            textarea.focus();
            if (saveBtnEl) {
              saveBtnEl.dataset.saving = 'false';
              saveBtnEl.disabled = false;
            }
            return;
          }

          const response = await fetch(`/api/local/${reviewId}/user-comments/${commentId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: editedText })
          });

          if (!response.ok) throw new Error('Failed to update comment');

          const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
          if (!commentRow) {
            console.error('Comment element not found');
            return;
          }
          const commentDiv = commentRow.querySelector('.user-comment');
          let bodyDiv = commentDiv.querySelector('.user-comment-body');
          const editForm = commentDiv.querySelector('.user-comment-edit-form');

          if (!bodyDiv) {
            bodyDiv = document.createElement('div');
            bodyDiv.className = 'user-comment-body';
            commentDiv.appendChild(bodyDiv);
          }

          bodyDiv.innerHTML = window.renderMarkdown ? window.renderMarkdown(editedText) : manager.escapeHtml(editedText);
          bodyDiv.dataset.originalMarkdown = editedText;
          bodyDiv.style.display = '';

          if (editForm) editForm.remove();
          commentDiv.classList.remove('editing-mode');

          const timestamp = commentDiv.querySelector('.user-comment-timestamp');
          if (timestamp) timestamp.textContent = new Date().toLocaleString();

          // Notify AI Panel about the updated comment body
          if (window.aiPanel?.updateComment) {
            window.aiPanel.updateComment(commentId, { body: editedText });
          }

        } catch (error) {
          console.error('Error saving comment:', error);
          alert('Failed to save comment');
          // Re-enable save button on failure so the user can retry
          if (saveBtnEl) {
            saveBtnEl.dataset.saving = 'false';
            saveBtnEl.disabled = false;
          }
        }
      };
    }

    // Patch PRManager.clearAllUserComments for local mode
    const originalClearAllUserComments = manager.clearAllUserComments?.bind(manager);
    if (originalClearAllUserComments) {
      manager.clearAllUserComments = async function() {
        // Count both line-level and file-level user comments
        const lineCommentRows = document.querySelectorAll('.user-comment-row');
        const fileCommentCards = document.querySelectorAll('.file-comment-card.user-comment');
        const totalComments = lineCommentRows.length + fileCommentCards.length;

        if (totalComments === 0) {
          if (window.toast?.showInfo) {
            window.toast.showInfo('No comments to clear');
          }
          return;
        }

        if (!window.confirmDialog) {
          alert('Confirmation dialog unavailable. Please refresh the page.');
          return;
        }

        const dialogResult = await window.confirmDialog.show({
          title: 'Clear All Comments?',
          message: `This will dismiss all ${totalComments} comment${totalComments !== 1 ? 's' : ''}. You can restore them later.`,
          confirmText: 'Clear All',
          confirmClass: 'btn-danger'
        });

        if (dialogResult !== 'confirm') return;

        try {
          const response = await fetch(`/api/local/${reviewId}/user-comments`, {
            method: 'DELETE'
          });

          if (!response.ok) throw new Error('Failed to delete comments');

          const result = await response.json();
          const deletedCount = result.deletedCount || totalComments;

          // Remove line-level comment rows from DOM
          lineCommentRows.forEach(row => row.remove());

          // Remove file-level comment cards from DOM
          fileCommentCards.forEach(card => {
            const zone = card.closest('.file-comments-zone');
            card.remove();

            // Update the file comment zone header button state
            if (zone && manager.fileCommentManager) {
              manager.fileCommentManager.updateCommentCount(zone);
            }
          });

          // Remove line-level and file-level comment elements from diff view
          // (They have been soft-deleted, so should not appear in the diff panel per design decision)
          // The comments array will be reloaded below with proper dismissed state.

          // Reload comments to update both internal state and AI Panel
          // This shows dismissed comments in AI Panel if filter is enabled, matching individual deletion behavior
          const includeDismissed = window.aiPanel?.showDismissedComments || false;
          await manager.loadUserComments(includeDismissed);

          // Update dismissed suggestions in the diff view UI
          // (AI Panel is already updated by loadUserComments via setComments)
          if (result.dismissedSuggestionIds && result.dismissedSuggestionIds.length > 0 && manager.updateDismissedSuggestionUI) {
            for (const suggestionId of result.dismissedSuggestionIds) {
              manager.updateDismissedSuggestionUI(suggestionId);
            }
          }

          // Show success toast notification
          if (window.toast) {
            window.toast.showSuccess(`Cleared ${deletedCount} comment${deletedCount !== 1 ? 's' : ''}`);
          }
        } catch (error) {
          console.error('Error clearing user comments:', error);
          if (window.toast) {
            window.toast.showError('Failed to clear comments');
          } else {
            alert('Failed to clear comments');
          }
        }
      };
    }

    // Patch SuggestionManager.createUserCommentFromSuggestion for local mode
    // This method is called when adopting AI suggestions
    if (manager.suggestionManager) {
      const sm = manager.suggestionManager;

      sm.createUserCommentFromSuggestion = async function(suggestionId, fileName, lineNumber, suggestionText, suggestionType, suggestionTitle, diffPosition, side) {
        // Format the comment text with emoji and category prefix
        const formattedText = sm.formatAdoptedComment(suggestionText, suggestionType);

        // Parse diff_position if it's a string (from dataset)
        const parsedDiffPosition = diffPosition ? parseInt(diffPosition) : null;

        const createResponse = await fetch(`/api/local/${reviewId}/user-comments`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            file: fileName,
            line_start: parseInt(lineNumber),
            line_end: parseInt(lineNumber),
            diff_position: parsedDiffPosition,
            side: side || 'RIGHT',
            body: formattedText,
            parent_id: suggestionId,
            type: suggestionType,
            title: suggestionTitle
          })
        });

        if (!createResponse.ok) {
          throw new Error('Failed to create user comment');
        }

        const result = await createResponse.json();
        return {
          id: result.commentId,
          file: fileName,
          line_start: parseInt(lineNumber),
          body: formattedText,
          type: suggestionType,
          title: suggestionTitle,
          parent_id: suggestionId,
          diff_position: parsedDiffPosition,
          created_at: new Date().toISOString()
        };
      };
    }

    // Patch fetchRepoSettings to use the repository from local review data
    manager.fetchRepoSettings = async function() {
      if (!self.localData || !self.localData.repository) return null;

      // Parse owner/repo from repository name
      const repository = self.localData.repository;
      const parts = repository.split('/');
      if (parts.length !== 2) return null;

      const [owner, repo] = parts;
      try {
        const response = await fetch(`/api/repos/${owner}/${repo}/settings`);
        if (!response.ok) {
          if (response.status === 404) {
            return null;
          }
          console.warn('Failed to fetch repo settings:', response.statusText);
          return null;
        }
        return await response.json();
      } catch (error) {
        console.warn('Error fetching repo settings:', error);
        return null;
      }
    };

    // Patch fetchLastReviewSettings to use local API endpoint
    // Local mode uses a different endpoint pattern than PR mode because local reviews
    // don't have PR metadata (owner/repo/number). Instead, instructions are stored
    // directly on the review record and accessed via the review ID.
    manager.fetchLastReviewSettings = async function() {
      try {
        const response = await fetch(`/api/local/${reviewId}/review-settings`);
        if (!response.ok) {
          return { custom_instructions: '', last_council_id: null };
        }
        const data = await response.json();
        return {
          custom_instructions: data.custom_instructions || '',
          last_council_id: data.last_council_id || null
        };
      } catch (error) {
        console.warn('Error fetching last custom instructions:', error);
        return { custom_instructions: '', last_council_id: null };
      }
    };

    // Note: initSplitButton is NOT patched - it will use the standard SplitButton
    // which automatically detects local mode via window.PAIR_REVIEW_LOCAL_MODE
    // and hides the Submit Review option accordingly.

    // Note: openPreviewModal is NOT patched - PreviewModal now automatically
    // detects local mode and uses the correct API endpoint.

    // Add updateDismissedSuggestionUI method for local mode
    // Delegates to the shared SuggestionUI utility
    manager.updateDismissedSuggestionUI = function(suggestionId) {
      if (window.SuggestionUI?.updateDismissedSuggestionUI) {
        window.SuggestionUI.updateDismissedSuggestionUI(suggestionId);
      }
    };

    // Patch PRManager.restoreUserComment for local mode
    // Uses the local API endpoint to restore dismissed comments
    manager.restoreUserComment = async function(commentId) {
      try {
        const response = await fetch(`/api/local/${reviewId}/user-comments/${commentId}/restore`, {
          method: 'PUT'
        });
        if (!response.ok) throw new Error('Failed to restore comment');

        // Reload comments to update both the diff view and AI panel
        // Pass the current filter state from the AI panel
        const includeDismissed = window.aiPanel?.showDismissedComments || false;
        await manager.loadUserComments(includeDismissed);

        // Show success toast
        if (window.toast) {
          window.toast.showSuccess('Comment restored');
        }
      } catch (error) {
        console.error('Error restoring comment:', error);
        if (window.toast) {
          window.toast.showError('Failed to restore comment');
        } else {
          alert('Failed to restore comment');
        }
      }
    };

    console.log('PRManager patched for local mode');
  }

  /**
   * Patch ProgressModal to use local SSE endpoint
   */
  patchProgressModalForLocal() {
    const modal = window.progressModal;
    if (!modal) return;

    const reviewId = this.reviewId;
    const originalStartMonitoring = modal.startProgressMonitoring.bind(modal);

    modal.startProgressMonitoring = function() {
      if (modal.eventSource) {
        modal.eventSource.close();
      }

      if (!modal.currentAnalysisId) return;

      // Use local SSE endpoint
      modal.eventSource = new EventSource(`/api/local/${reviewId}/ai-suggestions/status`);

      modal.eventSource.onopen = () => {
        console.log('Connected to local progress stream');
      };

      modal.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'connected') {
            console.log('Local SSE connection established');
            return;
          }

          if (data.type === 'progress') {
            modal.updateProgress(data);

            if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
              modal.stopProgressMonitoring();
            }
          }
        } catch (error) {
          console.error('Error parsing SSE data:', error);
        }
      };

      modal.eventSource.onerror = (error) => {
        console.error('SSE connection error:', error);
        modal.fallbackToPolling();
      };
    };
  }

  /**
   * Start local AI analysis
   */
  async startLocalAnalysis(btn, config) {
    const manager = window.prManager;

    try {
      if (btn) {
        btn.disabled = true;
        btn.classList.add('btn-analyzing');
        const btnText = btn.querySelector('.btn-text');
        if (btnText) {
          btnText.textContent = 'Starting...';
        }
      }

      // Staleness is now checked in triggerAIAnalysis before showing config modal

      // Determine endpoint and body based on whether this is a council analysis
      let analyzeUrl, analyzeBody;
      if (config.isCouncil) {
        analyzeUrl = `/api/local/${this.reviewId}/analyze/council`;
        analyzeBody = {
          councilId: config.councilId || undefined,
          councilConfig: config.councilConfig || undefined,
          configType: config.configType || 'advanced',
          customInstructions: config.customInstructions || null
        };
      } else {
        analyzeUrl = `/api/local/${this.reviewId}/analyze`;
        analyzeBody = {
          provider: config.provider || 'claude',
          model: config.model || 'opus',
          tier: config.tier || 'balanced',
          customInstructions: config.customInstructions || null,
          enabledLevels: config.enabledLevels || [1, 2, 3],
          skipLevel3: config.skipLevel3 || false
        };
      }

      // Start AI analysis
      const response = await fetch(analyzeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(analyzeBody)
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'Failed to start AI analysis');
      }

      const result = await response.json();

      // Set AI Panel to loading state
      if (window.aiPanel?.setAnalysisState) {
        window.aiPanel.setAnalysisState('loading');
      }

      // Set analyzing state
      manager.setButtonAnalyzing(result.analysisId);

      // Always use the unified progress modal
      if (window.councilProgressModal) {
        window.councilProgressModal.setLocalMode(this.reviewId);
        window.councilProgressModal.show(
          result.analysisId,
          config.isCouncil ? config.councilConfig : null,
          config.isCouncil ? config.councilName : null,
          {
            configType: config.isCouncil ? (config.configType || 'advanced') : 'single',
            enabledLevels: config.enabledLevels || [1, 2, 3]
          }
        );
      } else {
        // Fallback to old progress modal if unified modal not available
        this.patchProgressModalForLocal();
        if (window.progressModal) {
          window.progressModal.show(result.analysisId);
        }
      }

    } catch (error) {
      console.error('Error starting local AI analysis:', error);
      manager.showError(`Failed to start AI analysis: ${error.message}`);
      manager.resetButton();
    }
  }

  /**
   * Hide GitHub-specific UI elements
   */
  hideGitHubElements() {
    // Hide GitHub link
    const githubLink = document.getElementById('github-link');
    if (githubLink) {
      githubLink.style.display = 'none';
    }

    // Hide refresh button (no remote to refresh from)
    const refreshBtn = document.getElementById('refresh-pr');
    if (refreshBtn) {
      refreshBtn.style.display = 'none';
    }

    // Hide breadcrumb (already replaced with local info)
    const breadcrumb = document.getElementById('pr-breadcrumb');
    if (breadcrumb) {
      breadcrumb.style.display = 'none';
    }

    // Note: Split button is updated in loadLocalReview() after diff is loaded
  }

  /**
   * Initialize the refresh button for local mode
   */
  initRefreshButton() {
    const refreshBtn = document.getElementById('local-refresh-btn');
    if (!refreshBtn) return;

    refreshBtn.addEventListener('click', () => this.refreshDiff());
  }

  /**
   * Reset the analysis button to its default enabled state
   * @param {HTMLElement} btn - The button element to reset
   */
  resetAnalysisButton(btn) {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('btn-analyzing');
      const btnText = btn.querySelector('.btn-text');
      if (btnText) {
        btnText.textContent = 'Start Analysis';
      }
    }
  }

  /**
   * Perform a refresh and prepare for re-analysis
   * This is the core refresh logic extracted for direct invocation
   * rather than depending on DOM button state
   */
  async performRefreshAndAnalysis() {
    await this.refreshDiff();
  }

  /**
   * Refresh the diff from the working directory
   */
  async refreshDiff() {
    const manager = window.prManager;
    const refreshBtn = document.getElementById('local-refresh-btn');

    if (!refreshBtn || refreshBtn.disabled) return;

    try {
      // Show loading state
      refreshBtn.disabled = true;
      refreshBtn.classList.add('btn-loading');

      const response = await fetch(`/api/local/${this.reviewId}/refresh`, {
        method: 'POST'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to refresh diff');
      }

      const result = await response.json();
      console.log('Diff refreshed:', result.stats);

      // Check if HEAD has changed (user made a commit)
      if (result.sessionChanged && result.newSessionId) {
        // Show confirmation dialog to user
        const originalSha = result.originalHeadSha ? result.originalHeadSha.substring(0, 7) : 'unknown';
        const newSha = result.newHeadSha ? result.newHeadSha.substring(0, 7) : 'unknown';

        if (window.confirmDialog) {
          const dialogResult = await window.confirmDialog.show({
            title: 'HEAD Has Changed',
            message: `A new commit was detected (${originalSha} -> ${newSha}). Your comments and AI suggestions are tied to the previous commit.\n\nWould you like to switch to the new session for the current HEAD?`,
            confirmText: 'Switch to New Session',
            cancelText: 'Stay on Current Session',
            confirmClass: 'btn-primary'
          });

          if (dialogResult === 'confirm') {
            // Redirect to the new session
            window.location.href = `/local/${result.newSessionId}`;
            return;
          }
        } else {
          // Fallback if confirmDialog is not available
          const switchSession = confirm(
            `HEAD has changed (${originalSha} -> ${newSha}). ` +
            `Your comments and AI suggestions are tied to the previous commit. ` +
            `Switch to the new session?`
          );

          if (switchSession) {
            window.location.href = `/local/${result.newSessionId}`;
            return;
          }
        }

        // User chose to stay, show info toast
        if (window.toast) {
          window.toast.showInfo('Staying on current session. Refresh again to see this option.');
        }
      }

      // Reload the diff display
      await this.loadLocalDiff();

      // Re-render comments and AI suggestions on the fresh DOM
      // (renderDiff clears the diff container, so we must re-populate)
      const includeDismissed = window.aiPanel?.showDismissedComments || false;
      await manager.loadUserComments(includeDismissed);
      // Note: Unlike loadLocalReview() which skips this when analysisHistoryManager exists
      // (because the manager triggers loadAISuggestions via onSelectionChange on init),
      // refresh must call unconditionally since the manager won't re-fire its callback.
      await manager.loadAISuggestions(null, manager.selectedRunId);

      // Show success toast
      if (window.toast) {
        window.toast.showSuccess('Diff refreshed successfully');
      } else if (window.showToast) {
        window.showToast('Diff refreshed successfully', 'success');
      }

    } catch (error) {
      console.error('Error refreshing diff:', error);
      if (window.toast) {
        window.toast.showError('Failed to refresh diff: ' + error.message);
      } else if (window.showToast) {
        window.showToast('Failed to refresh diff: ' + error.message, 'error');
      } else {
        alert('Failed to refresh diff: ' + error.message);
      }
    } finally {
      // Reset button state
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('btn-loading');
      }
    }
  }

  /**
   * Load local review data
   */
  async loadLocalReview() {
    const manager = window.prManager;
    if (!manager) {
      console.error('PRManager not available');
      return;
    }

    manager.setLoading(true);

    try {
      // Fetch local review metadata
      const response = await fetch(`/api/local/${this.reviewId}`);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to load local review');
      }

      const reviewData = await response.json();
      this.localData = reviewData;

      // Create a currentPR-like object for compatibility
      manager.currentPR = {
        id: reviewData.id,
        owner: 'local',
        repo: reviewData.repository,
        number: reviewData.id,
        title: `Local Changes - ${reviewData.branch}`,
        head_branch: reviewData.branch,
        base_branch: reviewData.branch,
        head_sha: reviewData.localHeadSha,
        reviewType: 'local',
        localPath: reviewData.localPath
      };

      // Update header with local info
      this.updateLocalHeader(reviewData);

      // Fetch and display diff
      await this.loadLocalDiff();

      // Initialize split button (uses standard SplitButton which auto-detects local mode)
      manager.initSplitButton();

      // Initialize AI Panel before loading comments so we can read the restored filter state
      if (window.AIPanel && !window.aiPanel) {
        window.aiPanel = new window.AIPanel();
      }

      // Set local context for AI Panel (restores filter state from localStorage)
      if (window.aiPanel?.setPR) {
        window.aiPanel.setPR('local', reviewData.repository, this.reviewId);
      }

      // Load saved comments using the restored filter state from AI Panel
      const includeDismissed = window.aiPanel?.showDismissedComments || false;
      await manager.loadUserComments(includeDismissed);

      // Initialize analysis history manager for local mode
      if (window.AnalysisHistoryManager) {
        manager.analysisHistoryManager = new window.AnalysisHistoryManager({
          reviewId: this.reviewId,
          mode: 'local',
          onSelectionChange: (runId, _run) => {
            manager.selectedRunId = runId;
            manager.loadAISuggestions(null, runId);
          }
        });
        manager.analysisHistoryManager.init();
        await manager.analysisHistoryManager.loadAnalysisRuns();
      }

      // Load saved AI suggestions
      // Note: If analysisHistoryManager is initialized, it will trigger loadAISuggestions
      // via onSelectionChange when selecting the latest run. Only call directly if no manager.
      if (!manager.analysisHistoryManager) {
        await manager.loadAISuggestions();
      }

      // Check for running analysis
      await manager.checkRunningAnalysis();

      // Open persistent SSE connection to detect externally-imported results
      this.startExternalResultsListener();

    } catch (error) {
      console.error('Error loading local review:', error);
      manager.showError(error.message);
    } finally {
      manager.setLoading(false);
    }
  }

  /**
   * Listen for externally-imported analysis results via SSE.
   * When the POST /api/analysis-results endpoint stores new suggestions,
   * it broadcasts on the `local-${reviewId}` key. This listener picks
   * that up and refreshes suggestions automatically.
   */
  startExternalResultsListener() {
    if (this._externalResultsSource) return;
    const reviewId = this.reviewId;

    this._externalResultsSource = new EventSource(
      `/api/local/${reviewId}/ai-suggestions/status`
    );

    this._externalResultsSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'progress' && data.status === 'completed' && data.source === 'external') {
          console.log('External analysis results detected, refreshing suggestions');
          const manager = window.prManager;
          if (manager?.analysisHistoryManager) {
            manager.analysisHistoryManager.refresh({ switchToNew: true })
              .then(() => manager.loadAISuggestions());
          } else if (manager?.loadAISuggestions) {
            manager.loadAISuggestions();
          }
        }
      } catch (e) { /* ignore parse errors */ }
    };

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
      if (this._externalResultsSource) {
        this._externalResultsSource.close();
        this._externalResultsSource = null;
      }
    });
  }

  /**
   * Initialize inline name editing for the review title in the header
   */
  initNameEditing() {
    const nameEl = document.getElementById('local-review-name');
    if (!nameEl || nameEl.dataset.listenerAttached) return;
    nameEl.dataset.listenerAttached = 'true';

    const reviewId = this.reviewId;

    nameEl.addEventListener('click', () => {
      if (nameEl.querySelector('input')) return; // already editing

      const currentName = nameEl.dataset.currentName || '';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'local-review-name-input';
      input.value = currentName;
      input.placeholder = 'Untitled';

      nameEl.textContent = '';
      nameEl.appendChild(input);
      input.focus();
      input.select();

      let saved = false;

      async function save() {
        if (saved) return;
        saved = true;
        const newName = input.value.trim() || null;
        try {
          const response = await fetch(`/api/local/${reviewId}/name`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
          });
          if (!response.ok) throw new Error('Save failed');
          nameEl.dataset.currentName = newName || '';
          nameEl.textContent = newName || 'Untitled';
          nameEl.classList.toggle('unnamed', !newName);
          nameEl.title = 'Click to rename';
        } catch (error) {
          // Revert the display to the previous name on failure
          cancel();
        }
      }

      function cancel() {
        nameEl.textContent = currentName || 'Untitled';
        nameEl.classList.toggle('unnamed', !currentName);
        nameEl.title = 'Click to rename';
      }

      input.addEventListener('blur', save);
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.removeEventListener('blur', save);
          save();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          input.removeEventListener('blur', save);
          cancel();
        }
      });
    });
  }

  /**
   * Update local header with review info
   */
  updateLocalHeader(reviewData) {
    // Update review name/title in header
    const nameEl = document.getElementById('local-review-name');
    if (nameEl) {
      const name = reviewData.name || '';
      nameEl.textContent = name || 'Untitled';
      nameEl.dataset.currentName = name;
      nameEl.classList.toggle('unnamed', !name);
      nameEl.title = 'Click to rename';
      this.initNameEditing();
    }

    // Update repository name
    const repoName = document.getElementById('local-repo-name');
    if (repoName) {
      repoName.textContent = reviewData.repository || 'Unknown';
    }

    // Update local path display in toolbar-meta
    const pathText = document.getElementById('local-path-text');
    const pathInner = document.getElementById('local-path-inner');
    if (pathText && pathInner && reviewData.localPath) {
      const fullPath = reviewData.localPath;
      pathInner.textContent = fullPath;
      pathText.title = fullPath;
    }

    // Update branch name (header badge)
    const branchText = document.getElementById('local-branch-text');
    if (branchText) {
      branchText.textContent = reviewData.branch || 'unknown';
    }

    // Update branch name (toolbar) and wire up copy button
    const branchName = document.getElementById('pr-branch-name');
    if (branchName) {
      branchName.textContent = reviewData.branch || 'unknown';
    }

    const branchCopy = document.getElementById('pr-branch-copy');
    if (branchCopy && !branchCopy.hasAttribute('data-listener-added')) {
      branchCopy.setAttribute('data-listener-added', 'true');
      branchCopy.addEventListener('click', async (e) => {
        e.stopPropagation();
        const branch = branchName ? branchName.textContent : '';
        if (!branch || branch === '--' || branch === 'unknown') return;
        try {
          await navigator.clipboard.writeText(branch);
          branchCopy.classList.add('copied');
          setTimeout(() => branchCopy.classList.remove('copied'), 2000);
        } catch (err) {
          console.error('Failed to copy branch name:', err);
        }
      });
    }

    // Update commit SHA and wire up copy button
    const commitSha = document.getElementById('pr-commit-sha');
    if (commitSha && reviewData.localHeadSha) {
      commitSha.textContent = reviewData.localHeadSha.substring(0, 7);
      commitSha.dataset.fullSha = reviewData.localHeadSha;
    }

    const commitCopy = document.getElementById('pr-commit-copy');
    if (commitCopy && !commitCopy.hasAttribute('data-listener-added')) {
      commitCopy.setAttribute('data-listener-added', 'true');
      commitCopy.addEventListener('click', async (e) => {
        e.stopPropagation();
        const fullSha = commitSha ? commitSha.dataset.fullSha : '';
        if (!fullSha) return;
        try {
          await navigator.clipboard.writeText(fullSha);
          commitCopy.classList.add('copied');
          setTimeout(() => commitCopy.classList.remove('copied'), 2000);
        } catch (err) {
          console.error('Failed to copy SHA:', err);
        }
      });
    }

    // Update settings link visibility and href
    const settingsLink = document.getElementById('settings-link');
    if (settingsLink) {
      const repository = reviewData.repository;
      const parts = repository ? repository.split('/') : [];

      if (repository && parts.length === 2) {
        // Valid owner/repo format - enable settings link
        const [owner, repo] = parts;
        settingsLink.href = `/settings/${owner}/${repo}`;
        settingsLink.style.display = '';
        settingsLink.classList.remove('disabled');
        settingsLink.title = 'Repository settings';

        // Store referrer data for back navigation from settings page
        // Key is scoped by repo to prevent collision between multiple tabs
        // Guard against adding duplicate listeners (updateLocalHeader can be called multiple times)
        if (!settingsLink.dataset.listenerAttached) {
          settingsLink.dataset.listenerAttached = 'true';
          settingsLink.addEventListener('click', () => {
            const referrerKey = `settingsReferrer:${owner}/${repo}`;
            localStorage.setItem(referrerKey, JSON.stringify({
              type: 'local',
              localReviewId: this.reviewId,
              owner: owner,
              repo: repo
            }));
          });
        }
      } else if (repository) {
        // Repository detected but not in owner/repo format - show disabled
        settingsLink.href = '#';
        settingsLink.style.display = '';
        settingsLink.classList.add('disabled');
        settingsLink.title = 'Repository settings unavailable (no repo identified)';
      } else {
        // No repository detected - hide the link
        settingsLink.style.display = 'none';
      }
    }
  }

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Update diff statistics display
   * @param {Object} stats - Stats object with additions, deletions, and fileCount
   */
  updateDiffStats(stats) {
    const { additions = 0, deletions = 0, fileCount = 0 } = stats;

    const additionsEl = document.getElementById('pr-additions');
    if (additionsEl) {
      additionsEl.textContent = `+${additions}`;
    }

    const deletionsEl = document.getElementById('pr-deletions');
    if (deletionsEl) {
      deletionsEl.textContent = `-${deletions}`;
    }

    const filesCountEl = document.getElementById('pr-files-count');
    if (filesCountEl) {
      filesCountEl.textContent = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
    }

    const sidebarFileCount = document.getElementById('sidebar-file-count');
    if (sidebarFileCount) {
      sidebarFileCount.textContent = fileCount;
    }
  }

  /**
   * Load and display local diff
   */
  async loadLocalDiff() {
    const manager = window.prManager;

    try {
      const response = await fetch(`/api/local/${this.reviewId}/diff`);

      if (!response.ok) {
        throw new Error('Failed to load local diff');
      }

      const data = await response.json();
      const diffContent = data.diff || '';
      const stats = data.stats || {};
      const generatedFiles = new Set(data.generated_files || []);

      if (!diffContent) {
        // Clear the diff container
        const diffContainer = document.getElementById('diff-container');
        if (diffContainer) {
          diffContainer.innerHTML = '<div class="no-diff">No unstaged changes to review. Make some changes to your files and click the <strong>Refresh</strong> button to reload.</div>';
        }

        // Clear the file navigation sidebar
        manager.updateFileList([]);

        // Update stats to show zeros
        this.updateDiffStats({ additions: 0, deletions: 0, fileCount: 0 });

        return;
      }

      // Parse the unified diff to extract files
      const filePatchMap = manager.parseUnifiedDiff(diffContent);

      // Build file list from diff
      const files = [];
      let totalAdditions = 0;
      let totalDeletions = 0;

      for (const [fileName, patch] of filePatchMap) {
        // Count additions and deletions
        const lines = patch.split('\n');
        let additions = 0;
        let deletions = 0;

        for (const line of lines) {
          if (line.startsWith('+') && !line.startsWith('+++')) {
            additions++;
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            deletions++;
          }
        }

        const isGenerated = generatedFiles.has(fileName);

        files.push({
          file: fileName,
          patch: patch,
          insertions: additions,
          deletions: deletions,
          generated: isGenerated,
          status: patch.includes('new file mode') ? 'added' :
                  patch.includes('deleted file mode') ? 'removed' : 'modified'
        });

        totalAdditions += additions;
        totalDeletions += deletions;
      }

      // Populate generatedFiles map (mirrors PR mode in loadAndDisplayFiles)
      manager.generatedFiles.clear();
      files.forEach(file => {
        if (file.generated) {
          manager.generatedFiles.set(file.file, {
            insertions: file.insertions || 0,
            deletions: file.deletions || 0
          });
        }
      });

      // Sort files alphabetically by path for consistent ordering across all components
      if (!window.FileOrderUtils) {
        console.warn('FileOrderUtils not loaded - file ordering will be inconsistent');
      }
      const sortedFiles = window.FileOrderUtils?.sortFilesByPath(files) || files;

      // Store canonical file order for use by AIPanel and other components
      manager.canonicalFileOrder = window.FileOrderUtils?.createFileOrderMap(sortedFiles) || new Map();

      // Pass file order to AIPanel
      if (window.aiPanel?.setFileOrder) {
        window.aiPanel.setFileOrder(manager.canonicalFileOrder);
      }

      // Update stats display
      this.updateDiffStats({
        additions: totalAdditions,
        deletions: totalDeletions,
        fileCount: sortedFiles.length
      });

      // Update file list sidebar
      manager.updateFileList(sortedFiles);

      // Load viewed state before rendering so files can start collapsed
      await manager.loadViewedState();

      // Render diff
      manager.renderDiff({ changed_files: sortedFiles });

    } catch (error) {
      console.error('Error loading local diff:', error);
      const diffContainer = document.getElementById('diff-container');
      if (diffContainer) {
        diffContainer.innerHTML = '<div class="no-diff">Error loading changes</div>';
      }
    }
  }

  /**
   * Get the progress dots container element
   * @returns {HTMLElement|null}
   */
  getProgressDotsContainer() {
    return document.getElementById('analysis-progress-dots');
  }

  /**
   * Update a specific progress dot during analysis
   * Maps level numbers to phase names:
   * - Level 4 -> orchestration (finalization)
   * - Level 1 -> level1
   * - Level 2 -> level2
   * - Level 3 -> level3
   * @param {number} level - The level number (1, 2, 3, or 4)
   * @param {string} status - The status ('running', 'completed', 'failed')
   */
  updateProgressDot(level, status) {
    const container = this.getProgressDotsContainer();
    if (!container) return;

    // Map levels to dot phases
    const phaseMap = {
      4: 'orchestration', // Orchestration/finalization is level 4 in ProgressModal
      1: 'level1',
      2: 'level2',
      3: 'level3'
    };

    const phase = phaseMap[level];
    if (!phase) return;

    const dot = container.querySelector(`[data-phase="${phase}"]`);
    if (!dot) return;

    // Remove existing states
    dot.classList.remove('active', 'completed', 'error');

    // Apply new state
    if (status === 'running') {
      dot.classList.add('active');
    } else if (status === 'completed') {
      dot.classList.add('completed');
    } else if (status === 'failed') {
      dot.classList.add('error');
    }
  }
}

// Initialize LocalManager when in local mode
if (window.PAIR_REVIEW_LOCAL_MODE) {
  window.localManager = new LocalManager();
}
