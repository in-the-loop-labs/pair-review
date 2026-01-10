/**
 * Local Mode Manager
 *
 * Extends PRManager for local review mode by:
 * - Redirecting API calls to /api/local/:reviewId/* endpoints
 * - Hiding GitHub-specific UI elements
 * - Adapting the UI for local uncommitted changes review
 */
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
    manager.loadUserComments = async function() {
      if (!manager.currentPR) return;

      try {
        const response = await fetch(`/api/local/${reviewId}/user-comments`);
        if (!response.ok) return;

        const data = await response.json();
        manager.userComments = data.comments || [];

        // Separate file-level and line-level comments
        const fileLevelComments = [];
        const lineLevelComments = [];

        manager.userComments.forEach(comment => {
          if (comment.is_file_level === 1) {
            fileLevelComments.push(comment);
          } else {
            lineLevelComments.push(comment);
          }
        });

        // Display line-level comments inline with diff
        lineLevelComments.forEach(comment => {
          const fileElement = manager.findFileElement(comment.file);
          if (!fileElement) return;

          const lineRows = fileElement.querySelectorAll('tr');
          for (const row of lineRows) {
            const lineNum = manager.getLineNumber(row);
            if (lineNum === comment.line_start) {
              manager.displayUserComment(comment, row);
              break;
            }
          }
        });

        // Load file-level comments into their zones
        if (manager.fileCommentManager && fileLevelComments.length > 0) {
          manager.fileCommentManager.loadFileComments(fileLevelComments, []);
        }

        // Populate AI Panel with comments
        if (window.aiPanel?.setComments) {
          window.aiPanel.setComments(manager.userComments);
        }

        manager.updateCommentCount();
      } catch (error) {
        console.error('Error loading user comments:', error);
      }
    };

    // Override loadAISuggestions
    manager.loadAISuggestions = async function(level = null) {
      if (!manager.currentPR) return;

      try {
        const filterLevel = level || manager.selectedLevel || 'final';
        const url = `/api/local/${reviewId}/suggestions?levels=${filterLevel}`;

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

      // Check staleness FIRST, before showing config modal
      try {
        const staleResponse = await fetch(`/api/local/${reviewId}/check-stale`);
        if (staleResponse.ok) {
          const staleData = await staleResponse.json();

          if (staleData.isStale === true) {
            // Working directory has changed - show dialog with options
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
                // User wants to refresh first, then continue to analysis
                await self.refreshDiff();
                // Continue to config modal after refresh (don't return)
              } else if (choice !== 'secondary') {
                // User cancelled
                return;
              }
              // Both 'confirm' (after refresh) and 'secondary' continue to config modal
            }
          } else if (staleData.isStale === null && staleData.error) {
            // Couldn't verify - show toast warning
            if (window.toast) {
              window.toast.showWarning('Could not verify working directory is current.');
            }
          }
        }
      } catch (staleError) {
        console.warn('[Local] Error checking staleness:', staleError);
        if (window.toast) {
          window.toast.showWarning('Could not verify working directory is current.');
        }
      }

      try {
        // Check if there are existing AI suggestions first
        let hasSuggestions = false;
        try {
          const checkResponse = await fetch(`/api/local/${reviewId}/has-ai-suggestions`);
          if (checkResponse.ok) {
            const data = await checkResponse.json();
            hasSuggestions = data.hasSuggestions;
          }
        } catch (checkError) {
          console.warn('Error checking for existing AI suggestions:', checkError);
        }

        // If there are existing suggestions, confirm replacement
        if (hasSuggestions) {
          if (!window.confirmDialog) {
            console.error('ConfirmDialog not loaded');
            manager.showError('Confirmation dialog unavailable. Please refresh the page.');
            return;
          }

          const replaceResult = await window.confirmDialog.show({
            title: 'Replace Existing Analysis?',
            message: 'This will replace all existing AI suggestions for this review. Continue?',
            confirmText: 'Continue',
            confirmClass: 'btn-danger'
          });

          if (replaceResult !== 'confirm') {
            return;
          }
        }

        // Show analysis config modal
        if (!manager.analysisConfigModal) {
          console.warn('AnalysisConfigModal not initialized, proceeding without config');
          await self.startLocalAnalysis(btn, {});
          return;
        }

        // Get repo settings for default instructions
        const repoSettings = await manager.fetchRepoSettings().catch(() => null);
        const lastInstructions = await manager.fetchLastCustomInstructions().catch(() => '');

        // Determine model and provider
        const modelStorageKey = `pair-review-model:local-${reviewId}`;
        const providerStorageKey = `pair-review-provider:local-${reviewId}`;
        const rememberedModel = localStorage.getItem(modelStorageKey);
        const rememberedProvider = localStorage.getItem(providerStorageKey);
        const currentModel = rememberedModel || repoSettings?.default_model || 'sonnet';
        const currentProvider = rememberedProvider || repoSettings?.default_provider || 'claude';

        // Show config modal
        const config = await manager.analysisConfigModal.show({
          currentModel,
          currentProvider,
          repoInstructions: repoSettings?.default_instructions || '',
          lastInstructions: lastInstructions,
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

          // Optionally reopen progress modal
          if (window.progressModal) {
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
        }
      };
    }

    // Patch PRManager.deleteUserComment for local mode
    const originalDeleteUserComment = manager.deleteUserComment?.bind(manager);
    if (originalDeleteUserComment) {
      manager.deleteUserComment = async function(commentId) {
        if (!window.confirmDialog) {
          alert('Confirmation dialog unavailable. Please refresh the page.');
          return;
        }

        const result = await window.confirmDialog.show({
          title: 'Delete Comment?',
          message: 'Are you sure you want to delete this comment? This action cannot be undone.',
          confirmText: 'Delete',
          confirmClass: 'btn-danger'
        });

        if (result !== 'confirm') return;

        try {
          const response = await fetch(`/api/local/${reviewId}/user-comments/${commentId}`, {
            method: 'DELETE'
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete comment');
          }

          const commentRow = document.querySelector(`[data-comment-id="${commentId}"]`);
          if (commentRow) {
            commentRow.remove();
            manager.updateCommentCount();
          }

          // Notify AI Panel about the deleted comment
          if (window.aiPanel?.removeComment) {
            window.aiPanel.removeComment(commentId);
          }
        } catch (error) {
          console.error('Error deleting comment:', error);
          alert('Failed to delete comment');
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

          const editFormHTML = `
            <div class="user-comment-edit-form">
              <div class="comment-form-toolbar">
                <button type="button" class="btn btn-sm suggestion-btn" title="Insert a suggestion">
                  <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                    <path fill-rule="evenodd" d="M14.064 0a8.75 8.75 0 00-6.187 2.563l-.459.458c-.314.314-.616.641-.904.979H3.31a1.75 1.75 0 00-1.49.833L.11 7.607a.75.75 0 00.418 1.11l3.102.954c.037.051.079.1.124.145l2.429 2.428c.046.046.094.088.145.125l.954 3.102a.75.75 0 001.11.418l2.774-1.707a1.75 1.75 0 00.833-1.49V9.485c.338-.288.665-.59.979-.904l.458-.459A8.75 8.75 0 0016 1.936V1.75A1.75 1.75 0 0014.25 0h-.186z"></path>
                  </svg>
                </button>
              </div>
              <textarea
                id="edit-comment-${commentId}"
                class="comment-edit-textarea"
                placeholder="Enter your comment..."
                data-file="${fileName}"
                data-line="${lineStart}"
                data-line-end="${lineEnd}"
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
        try {
          const textarea = document.getElementById(`edit-comment-${commentId}`);
          const editedText = textarea.value.trim();

          if (!editedText) {
            alert('Comment cannot be empty');
            textarea.focus();
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
          if (window.toast) {
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
          message: `This will delete all ${totalComments} user comment${totalComments !== 1 ? 's' : ''} from this review. This action cannot be undone.`,
          confirmText: 'Delete All',
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

            // Show empty state in the file comments zone if no more comments remain
            if (zone) {
              const container = zone.querySelector('.file-comments-container');
              const hasComments = container?.querySelectorAll('.file-comment-card').length > 0;
              if (!hasComments) {
                const emptyState = container?.querySelector('.file-comments-empty');
                if (emptyState) {
                  emptyState.style.display = 'block';
                }
              }
              // Update the file comment zone header button state
              if (manager.fileCommentManager) {
                manager.fileCommentManager.updateCommentCount(zone);
              }
            }
          });

          // Clear internal userComments array
          manager.userComments = [];

          // Clear comments from AI Panel
          if (window.aiPanel?.setComments) {
            window.aiPanel.setComments([]);
          }

          // Update comment count display
          manager.updateCommentCount();

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

    // Patch fetchLastCustomInstructions to use local API endpoint
    // Local mode uses a different endpoint pattern than PR mode because local reviews
    // don't have PR metadata (owner/repo/number). Instead, instructions are stored
    // directly on the review record and accessed via the review ID.
    manager.fetchLastCustomInstructions = async function() {
      try {
        const response = await fetch(`/api/local/${reviewId}/review-settings`);
        if (!response.ok) {
          return '';
        }
        const data = await response.json();
        return data.custom_instructions || '';
      } catch (error) {
        console.warn('Error fetching last custom instructions:', error);
        return '';
      }
    };

    // Note: initSplitButton is NOT patched - it will use the standard SplitButton
    // which automatically detects local mode via window.PAIR_REVIEW_LOCAL_MODE
    // and hides the Submit Review option accordingly.

    // Note: openPreviewModal is NOT patched - PreviewModal now automatically
    // detects local mode and uses the correct API endpoint.

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

            if (data.status === 'completed' || data.status === 'failed') {
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

      // Start AI analysis
      const response = await fetch(`/api/local/${this.reviewId}/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          provider: config.provider || 'claude',
          model: config.model || 'sonnet',
          customInstructions: config.customInstructions || null
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to start AI analysis');
      }

      const result = await response.json();

      // Set AI Panel to loading state
      if (window.aiPanel?.setAnalysisState) {
        window.aiPanel.setAnalysisState('loading');
      }

      // Set analyzing state
      manager.setButtonAnalyzing(result.analysisId);

      // Patch progress modal for local mode
      this.patchProgressModalForLocal();

      // Show progress modal
      if (window.progressModal) {
        window.progressModal.show(result.analysisId);
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

      // Load saved comments
      await manager.loadUserComments();

      // Initialize split button (uses standard SplitButton which auto-detects local mode)
      manager.initSplitButton();

      // Initialize AI Panel
      if (window.AIPanel && !window.aiPanel) {
        window.aiPanel = new window.AIPanel();
      }

      // Set local context for AI Panel
      if (window.aiPanel?.setPR) {
        window.aiPanel.setPR('local', reviewData.repository, this.reviewId);
      }

      // Load saved AI suggestions
      await manager.loadAISuggestions();

      // Check for running analysis
      await manager.checkRunningAnalysis();

    } catch (error) {
      console.error('Error loading local review:', error);
      manager.showError(error.message);
    } finally {
      manager.setLoading(false);
    }
  }

  /**
   * Update local header with review info
   */
  updateLocalHeader(reviewData) {
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

    // Update branch name
    const branchText = document.getElementById('local-branch-text');
    if (branchText) {
      branchText.textContent = reviewData.branch || 'unknown';
    }

    // Update commit SHA
    const commitSha = document.getElementById('pr-commit-sha');
    if (commitSha && reviewData.localHeadSha) {
      commitSha.textContent = reviewData.localHeadSha.substring(0, 7);
      commitSha.dataset.fullSha = reviewData.localHeadSha;
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

      if (!diffContent) {
        // Clear the diff container
        const diffContainer = document.getElementById('diff-container');
        if (diffContainer) {
          diffContainer.innerHTML = '<div class="no-diff">No unstaged changes to review</div>';
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

        files.push({
          file: fileName,
          patch: patch,
          insertions: additions,
          deletions: deletions,
          status: patch.includes('new file mode') ? 'added' :
                  patch.includes('deleted file mode') ? 'removed' : 'modified'
        });

        totalAdditions += additions;
        totalDeletions += deletions;
      }

      // Update stats display
      this.updateDiffStats({
        additions: totalAdditions,
        deletions: totalDeletions,
        fileCount: files.length
      });

      // Update file list sidebar
      manager.updateFileList(files);

      // Load viewed state before rendering so files can start collapsed
      await manager.loadViewedState();

      // Render diff
      manager.renderDiff({ changed_files: files });

    } catch (error) {
      console.error('Error loading local diff:', error);
      const diffContainer = document.getElementById('diff-container');
      if (diffContainer) {
        diffContainer.innerHTML = '<div class="no-diff">Error loading changes</div>';
      }
    }
  }
}

// Initialize LocalManager when in local mode
if (window.PAIR_REVIEW_LOCAL_MODE) {
  window.localManager = new LocalManager();
}
