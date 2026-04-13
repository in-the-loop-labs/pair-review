// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
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
        // Fetch repo settings so we honour the repository's default provider/council
        const manager = window.prManager;
        const [repoSettings, reviewSettings] = await Promise.all([
          manager.fetchRepoSettings().catch(() => null),
          manager.fetchLastReviewSettings().catch(() => ({ custom_instructions: '', last_council_id: null }))
        ]);
        const config = await manager._buildDefaultAnalysisConfig(repoSettings, reviewSettings);

        await this.startLocalAnalysis(null, config);
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
    const originalLoadAISuggestions = manager.loadAISuggestions.bind(manager);

    // Note: loadUserComments no longer needs patching because pr.js now uses the unified
    // /api/reviews/:reviewId/comments endpoint which works for both PR and local mode.

    // Override loadAISuggestions
    manager.loadAISuggestions = async function(level = null, runId = null) {
      if (!manager.currentPR) return;

      try {
        const filterLevel = level || manager.selectedLevel || 'final';
        // Use provided runId, or fall back to selectedRunId (which may be null for latest)
        const filterRunId = runId !== undefined ? runId : manager.selectedRunId;

        // First, check if analysis has been run and get summary data for the selected run
        try {
          let checkUrl = `/api/reviews/${reviewId}/suggestions/check`;
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

        let url = `/api/reviews/${reviewId}/suggestions?levels=${filterLevel}`;
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
      if (manager.isAnalyzing) {
        manager.reopenModal();
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

        // Run stale check and settings fetch in parallel to minimize dialog delay.
        // Reuse the on-load staleness promise if still available, otherwise fetch fresh.
        const _tParallel0 = performance.now();
        const staleCheckWithTimeout = manager._stalenessPromise
          ? manager._stalenessPromise
          : self._fetchLocalStaleness();
        manager._stalenessPromise = null; // consume it
        const [staleResult, repoSettings, reviewSettings, appConfig] = await Promise.all([
          staleCheckWithTimeout,
          manager.fetchRepoSettings().catch(() => null),
          manager.fetchLastReviewSettings().catch(() => ({ custom_instructions: '', last_council_id: null })),
          fetch('/api/config').then(r => r.ok ? r.json() : {}).catch(() => ({}))
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

        const lastCouncilId = reviewSettings.last_council_id;

        // Determine model and provider (priority: repo default > defaults)
        const currentModel = repoSettings?.default_model || 'opus';
        const currentProvider = repoSettings?.default_provider || 'claude';

        // Determine default tab (priority: localStorage > repo settings > 'single')
        const tabStorageKey = `pair-review-tab:local-${reviewId}`;
        const rememberedTab = localStorage.getItem(tabStorageKey);
        const defaultTab = rememberedTab || repoSettings?.default_tab || 'single';

        // Restore custom instructions (priority: database > localStorage)
        const instructionsStorageKey = `pair-review-instructions:local-${reviewId}`;
        const lastInstructions = reviewSettings.custom_instructions
          ?? localStorage.getItem(instructionsStorageKey)
          ?? '';

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
          hasPr: false,
          hasGithubToken: Boolean(appConfig.has_github_token)
        });

        if (!config) {
          return;
        }

        // Persist custom instructions to localStorage for immediate recall on next dialog open
        const submittedInstructions = config.customInstructions || '';
        if (submittedInstructions) {
          localStorage.setItem(instructionsStorageKey, submittedInstructions);
        } else {
          localStorage.removeItem(instructionsStorageKey);
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
        const response = await fetch(`/api/reviews/${reviewId}/analyses/status`);
        if (!response.ok) return;

        const data = await response.json();
        if (data.running && data.analysisId) {
          manager.currentAnalysisId = data.analysisId;
          manager.isAnalyzing = true;
          window.aiPanel?.setAnalysisState('loading');
          manager.setButtonAnalyzing(data.analysisId);

          // Show the appropriate progress modal
          if (window.councilProgressModal) {
            window.councilProgressModal.setLocalMode(reviewId);
            window.councilProgressModal.show(
              data.analysisId,
              data.status?.isCouncil ? data.status.councilConfig : null,
              null,
              {
                configType: data.status?.isCouncil ? (data.status.configType || 'advanced') : 'single',
                enabledLevels: data.status?.enabledLevels || [1, 2, 3],
                noLevels: data.status?.noLevels || false
              }
            );
          }
        }
      } catch (error) {
        console.warn('Error checking running analysis:', error);
      }
    };

    // Note: Comment-related method overrides (saveUserComment, deleteUserComment,
    // editUserComment, saveEditedUserComment, clearAllUserComments,
    // createUserCommentFromSuggestion, restoreUserComment) have been removed because
    // the base PRManager methods now use the unified /api/reviews/:reviewId/comments
    // endpoints which work for both PR and local mode.

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

    // Override handleWhitespaceToggle for local mode.
    // The base PRManager implementation calls loadAndDisplayFiles() which
    // uses the PR diff endpoint. In local mode we need to call loadLocalDiff()
    // instead, which uses the local diff endpoint.
    manager.handleWhitespaceToggle = async function(hide) {
      manager.hideWhitespace = hide;

      // Nothing to reload if we haven't loaded a review yet
      if (!manager.currentPR) return;

      const scrollY = window.scrollY;

      // Re-fetch and re-render the diff (loadLocalDiff reads hideWhitespace)
      await self.loadLocalDiff();

      // Re-anchor comments and suggestions on the fresh DOM
      const includeDismissed = window.aiPanel?.showDismissedComments || false;
      await manager.loadUserComments(includeDismissed);
      await manager.loadAISuggestions(null, manager.selectedRunId);

      // Restore scroll position after the DOM settles
      requestAnimationFrame(() => {
        window.scrollTo(0, scrollY);
      });
    };

    // Base branch override for stack-aware diff in local mode
    manager.currentBaseOverride = null;

    // Render the base branch selector dropdown for stacked branches.
    // When a local review has stack_data with 3+ entries, the user can pick
    // which ancestor branch to diff against.
    // Render the base branch selector when a Graphite stack has multiple ancestors.
    // When shown, the selector replaces the static base branch text in the toolbar.
    manager.renderBaseBranchSelector = function(pr) {
      const selectorWrap = document.getElementById('base-branch-selector-wrap');
      const sel = document.getElementById('base-branch-select');
      const staticBase = document.getElementById('toolbar-base-branch-static');
      if (!selectorWrap || !sel) return;

      // Hide selector if no stack data or fewer than 3 entries (need at least 2 ancestors to switch between)
      if (!pr.stack_data || pr.stack_data.length < 3) {
        selectorWrap.setAttribute('hidden', '');
        if (staticBase) staticBase.removeAttribute('hidden');
        return;
      }

      // Ancestors = all stack entries except the last (current branch)
      const ancestors = pr.stack_data.slice(0, -1);

      // Build options using createElement for XSS safety
      sel.innerHTML = '';
      for (const entry of ancestors) {
        const option = document.createElement('option');
        option.value = entry.branch;
        option.textContent = entry.prNumber ? `${entry.branch} (#${entry.prNumber})` : entry.branch;
        if (entry.branch === pr.base_branch) {
          option.selected = true;
        }
        sel.appendChild(option);
      }

      // Show selector, hide static text
      selectorWrap.removeAttribute('hidden');
      if (staticBase) staticBase.setAttribute('hidden', '');

      // Wire up change listener (idempotent via data-listener-added pattern)
      if (!sel.hasAttribute('data-listener-added')) {
        sel.setAttribute('data-listener-added', 'true');
        sel.addEventListener('change', async () => {
          manager.currentBaseOverride = sel.value;
          // If selection matches the original base, clear the override
          if (sel.value === manager.currentPR.base_branch) {
            manager.currentBaseOverride = null;
          }
          await self.loadLocalDiff();
        });
      }
    };

    console.log('PRManager patched for local mode');
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
        analyzeUrl = `/api/local/${this.reviewId}/analyses/council`;
        analyzeBody = {
          councilId: config.councilId || undefined,
          councilConfig: config.councilConfig || undefined,
          configType: config.configType || 'advanced',
          customInstructions: config.customInstructions || null,
          excludePrevious: config.excludePrevious || undefined
        };
      } else {
        analyzeUrl = `/api/local/${this.reviewId}/analyses`;
        analyzeBody = {
          provider: config.provider || 'claude',
          model: config.model || 'opus',
          tier: config.tier || 'balanced',
          customInstructions: config.customInstructions || null,
          enabledLevels: config.enabledLevels || [1, 2, 3],
          skipLevel3: config.skipLevel3 || false,
          excludePrevious: config.excludePrevious || undefined
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
            enabledLevels: config.enabledLevels || [1, 2, 3],
            noLevels: config.noLevels || false
          }
        );
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

    // Hide Graphite link (no PR to link to in local mode)
    const graphiteLink = document.getElementById('graphite-link');
    if (graphiteLink) {
      graphiteLink.style.display = 'none';
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
   * Refresh the diff from the working directory.
   * @param {Object} [opts] - Options
   * @param {boolean} [opts.silent] - When true, auto-update on HEAD change without dialog
   */
  async refreshDiff(opts = {}) {
    const manager = window.prManager;
    const refreshBtn = document.getElementById('local-refresh-btn');

    if (!refreshBtn || refreshBtn.disabled) return;

    try {
      // Show loading state
      refreshBtn.disabled = true;
      refreshBtn.classList.add('refreshing');

      const response = await fetch(`/api/local/${this.reviewId}/refresh`, {
        method: 'POST'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to refresh diff');
      }

      const result = await response.json();
      console.log('Diff refreshed:', result.stats);

      // HEAD change handling — branch scope is auto-updated by the backend;
      // non-branch scope requires user decision via resolve-head-change.
      if (result.headShaChanged) {
        const LS = window.LocalScope;
        const hasBranch = LS ? LS.scopeIncludes(this.scopeStart, this.scopeEnd, 'branch') : false;

        if (!hasBranch) {
          // Non-branch scope: let the user (or silent mode) decide
          const resolved = await this._resolveHeadChange(result, opts);
          if (!resolved) {
            // User cancelled — keep old diff, early return
            return;
          }
          // resolved is the response object — merge branchAvailable into result
          if (resolved.branchAvailable !== undefined) {
            result.branchAvailable = resolved.branchAvailable;
          }
        }
        // Branch scope: backend already updated SHA and persisted diff — fall through
      }

      // Reload the diff display
      await this._applyRefreshedDiff(manager, result);

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
        refreshBtn.classList.remove('refreshing');
      }
    }
  }

  /**
   * Handle a non-branch-scope HEAD SHA change.
   * Shows a 3-option dialog (or auto-updates in silent mode).
   * @returns {Object|false} The response data object if the session was updated in-place (caller should apply diff),
   *                    false if cancelled or redirecting away (caller should skip _applyRefreshedDiff)
   */
  async _resolveHeadChange(result, opts) {
    const abbrevLen = this.localData?.shaAbbrevLength || 7;
    const originalSha = result.previousHeadSha ? result.previousHeadSha.substring(0, abbrevLen) : 'unknown';
    const newSha = result.currentHeadSha ? result.currentHeadSha.substring(0, abbrevLen) : 'unknown';

    let action = 'update'; // default for silent mode

    if (!opts.silent && window.confirmDialog) {
      const dialogResult = await window.confirmDialog.show({
        title: 'New Commit Detected',
        message: `HEAD has moved from ${originalSha} to ${newSha}. Your review is based on the old commit.`,
        confirmText: 'Continue This Session',
        confirmDesc: 'Keep comments and suggestions, refresh diff to new HEAD',
        confirmClass: 'btn-primary',
        secondaryText: 'Start New Session',
        secondaryDesc: 'Begin a fresh review from the new commit',
        cancelText: 'Ignore the Change',
        cancelDesc: 'Continue reviewing using the previous diff'
      });

      if (dialogResult === 'confirm') {
        action = 'update';
      } else if (dialogResult === 'secondary') {
        action = 'new-session';
      } else {
        // Cancel — keep old diff
        if (window.toast) {
          window.toast.showInfo('Staying on current session with previous diff.');
        }
        return false;
      }
    } else if (!opts.silent) {
      // Fallback if confirmDialog is not available
      const switchSession = confirm(
        `HEAD has changed (${originalSha} \u2192 ${newSha}). ` +
        `Update this session with the new diff?`
      );
      action = switchSession ? 'update' : 'cancel';
      if (action === 'cancel') return false;
    }

    // Call resolve-head-change endpoint
    const resp = await fetch(`/api/local/${this.reviewId}/resolve-head-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, newHeadSha: result.currentHeadSha })
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || 'Failed to resolve head change');
    }

    const data = await resp.json();

    if (data.action === 'redirect') {
      // UNIQUE conflict — redirect to existing session
      window.location.href = `/local/${data.sessionId}`;
      return false; // navigating away — caller must not fire _applyRefreshedDiff
    }

    if (data.action === 'new-session') {
      window.location.href = `/local/${data.newSessionId}`;
      return false; // navigating away — caller must not fire _applyRefreshedDiff
    }

    // action === 'updated' — session SHA + diff updated, continue to reload.
    // Return the response data so the caller can extract branchAvailable, etc.
    return data;
  }

  /**
   * Reload the diff display, re-anchor comments, notify chat, clear stale state.
   * Shared by refreshDiff() for both normal refreshes and HEAD-change updates.
   */
  async _applyRefreshedDiff(manager, result) {
    // Notify chat agent about diff refresh
    if (window.chatPanel) {
      if (result.headShaChanged) {
        const prev = result.previousHeadSha;
        const abbrevLen = this.localData?.shaAbbrevLength || 7;
        window.chatPanel.queueDiffStateNotification(
          `HEAD SHA changed: ${prev ? prev.substring(0, abbrevLen) : 'unknown'} \u2192 ${result.currentHeadSha ? result.currentHeadSha.substring(0, abbrevLen) : 'unknown'}.`
        );
      }
      window.chatPanel.queueDiffStateNotification(
        'Local diff refreshed from working directory.'
      );
    }

    // Reset base branch override before reloading diff so the fetch uses the default base
    manager.currentBaseOverride = null;
    const baseSel = document.getElementById('base-branch-select');
    if (baseSel && manager.currentPR?.base_branch) {
      baseSel.value = manager.currentPR.base_branch;
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

    // Update branchAvailable on the scope selector if the backend sent an updated value
    if (result.branchAvailable !== undefined && manager.diffOptionsDropdown) {
      manager.diffOptionsDropdown.branchAvailable = result.branchAvailable;
    }

    // Clear stale state after successful refresh
    manager._hideStaleBadge();
    manager._stalenessPromise = null;

    // Show success toast
    if (window.toast) {
      window.toast.showSuccess('Diff refreshed successfully');
    } else if (window.showToast) {
      window.showToast('Diff refreshed successfully', 'success');
    }
  }

  /**
   * Check staleness on page load and show badge or auto-refresh.
   *
   * Logic mirrors PRManager._checkStalenessOnLoad but uses the local
   * GET endpoint and only supports the 'stale' badge type (no merged/closed).
   * @returns {Promise<Object|null>} The staleness result, or null on failure.
   */
  async _checkLocalStalenessOnLoad() {
    try {
      const result = await this._fetchLocalStaleness();
      if (!result) return null;

      // Notify chat of HEAD SHA change even when diff digest is unchanged
      // (e.g. git commit --amend with identical content, or rebase)
      const abbrevLen = this.localData?.shaAbbrevLength || 7;
      if (result.headShaChanged && window.chatPanel) {
        window.chatPanel.queueDiffStateNotification(
          `HEAD SHA changed (${result.previousHeadSha ? result.previousHeadSha.substring(0, abbrevLen) : 'unknown'} → ${result.currentHeadSha ? result.currentHeadSha.substring(0, abbrevLen) : 'unknown'}). The branch may have been rebased.`
        );
      }
      if (result.isStale !== true) return result;

      // Stale — decide: silent refresh or show badge
      const manager = window.prManager;
      const hasData = await manager._hasActiveSessionData();
      if (hasData) {
        console.debug('[Local] working directory stale, session has data — showing badge');
        manager._showStaleBadge('stale', 'Working directory has changed');
        if (window.chatPanel) {
          // Notify chat of HEAD SHA change only when we have session data to protect
          // (the !hasData path calls refreshDiff() which queues its own notification)
          if (result.headShaChanged) {
            window.chatPanel.queueDiffStateNotification(
              `HEAD SHA changed (${result.previousHeadSha ? result.previousHeadSha.substring(0, abbrevLen) : 'unknown'} → ${result.currentHeadSha ? result.currentHeadSha.substring(0, abbrevLen) : 'unknown'}). The branch may have been rebased.`
            );
          }
          window.chatPanel.queueDiffStateNotification(
            'Working directory has changed since the diff was captured.'
          );
        }
      } else {
        // No user work to protect — refresh silently (auto-update on HEAD change)
        console.debug('[Local] working directory stale, no session data — auto-refreshing');
        await this.refreshDiff({ silent: true });
      }
      return result;
    } catch {
      // Fail silently — staleness badge is best-effort
      return null;
    }
  }

  /**
   * Fetch staleness data from the local review endpoint with a timeout.
   * Uses GET to check the local review staleness endpoint.
   * @returns {Promise<Object|null>} The parsed staleness result, or null on failure/timeout.
   */
  async _fetchLocalStaleness() {
    try {
      const staleAbort = new AbortController();
      const staleTimer = setTimeout(() => staleAbort.abort(), STALE_TIMEOUT);
      const response = await fetch(
        `/api/local/${this.reviewId}/check-stale`,
        { signal: staleAbort.signal }
      );
      clearTimeout(staleTimer);
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
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

      // Read scope from metadata (backend now returns these)
      const LS = window.LocalScope;
      const scopeStart = reviewData.scopeStart || (LS ? LS.DEFAULT_SCOPE.start : 'unstaged');
      const scopeEnd = reviewData.scopeEnd || (LS ? LS.DEFAULT_SCOPE.end : 'untracked');
      this.scopeStart = scopeStart;
      this.scopeEnd = scopeEnd;

      // Create a currentPR-like object for compatibility
      const hasBranch = LS ? LS.scopeIncludes(scopeStart, scopeEnd, 'branch') : false;
      manager.currentPR = {
        id: reviewData.id,
        owner: 'local',
        repo: reviewData.repository,
        number: reviewData.id,
        title: hasBranch
          ? `Branch Changes - ${reviewData.branch} vs ${reviewData.baseBranch}`
          : `Local Changes - ${reviewData.branch}`,
        head_branch: reviewData.branch,
        base_branch: hasBranch ? reviewData.baseBranch : reviewData.branch,
        head_sha: reviewData.localHeadSha,
        shaAbbrevLength: reviewData.shaAbbrevLength || 7,
        reviewType: 'local',
        localPath: reviewData.localPath,
        stack_data: reviewData.stackData || null
      };

      // Re-initialize DiffOptionsDropdown with scope options
      const branchAvailable = Boolean(reviewData.branchAvailable);
      if (manager.diffOptionsDropdown) {
        manager.diffOptionsDropdown.destroy();
      }
      const diffOptionsBtn = document.getElementById('diff-options-btn');
      if (diffOptionsBtn && window.DiffOptionsDropdown) {
        manager.diffOptionsDropdown = new window.DiffOptionsDropdown(diffOptionsBtn, {
          onToggleWhitespace: (hide) => manager.handleWhitespaceToggle(hide),
          onToggleMinimize: (minimized) => manager.handleMinimizeToggle(minimized),
          onScopeChange: (start, end) => this._handleScopeChange(start, end),
          initialScope: { start: scopeStart, end: scopeEnd },
          branchAvailable
        });
      }

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

      // Set local context for AI Panel and Panel Group (restores per-review state from localStorage)
      if (window.aiPanel?.setPR) {
        window.aiPanel.setPR('local', reviewData.repository, this.reviewId);
      }
      window.panelGroup?.setPR(`local/${reviewData.repository}#${this.reviewId}`);

      // Load saved comments using the restored filter state from AI Panel
      const includeDismissed = window.aiPanel?.showDismissedComments || false;
      await manager.loadUserComments(includeDismissed);

      // Initialize analysis history manager for local mode
      if (window.AnalysisHistoryManager) {
        manager.analysisHistoryManager = new window.AnalysisHistoryManager({
          reviewId: this.reviewId,
          mode: 'local',
          shaAbbrevLength: reviewData.shaAbbrevLength || 7,
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

      // Listen for review mutation events via multiplexed SSE
      if (window.prManager?._initReviewEventListeners) {
        window.prManager._initReviewEventListeners();
      }

      // Fire-and-forget staleness check — shows badge or auto-refreshes
      manager._stalenessPromise = this._checkLocalStalenessOnLoad();

    } catch (error) {
      console.error('Error loading local review:', error);
      manager.showError(error.message);
    } finally {
      manager.setLoading(false);
    }
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

    // Update branch name in header badge
    const branchText = document.getElementById('local-branch-text');
    if (branchText) {
      branchText.textContent = reviewData.branch || 'unknown';
    }

    // Wire up header branch copy button
    const branchCopy = document.getElementById('local-branch-copy');
    if (branchCopy && !branchCopy.hasAttribute('data-listener-added')) {
      branchCopy.setAttribute('data-listener-added', 'true');
      branchCopy.addEventListener('click', async (e) => {
        e.stopPropagation();
        const branch = branchText ? branchText.textContent : '';
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

    // Set descriptive tab title
    if (window.tabTitle && reviewData.branch) {
      window.tabTitle.setBase(reviewData.branch);
    }

    // Show base branch in toolbar when branch is in scope
    const LS = window.LocalScope;
    const scopeStart = this.scopeStart || (LS ? LS.DEFAULT_SCOPE.start : 'unstaged');
    const scopeEnd = this.scopeEnd || (LS ? LS.DEFAULT_SCOPE.end : 'untracked');
    const hasBranch = LS ? LS.scopeIncludes(scopeStart, scopeEnd, 'branch') : false;

    // Toolbar base branch display (static text, selector is wired separately)
    const toolbarBaseWrap = document.getElementById('toolbar-base-branch-wrap');
    const toolbarBaseStatic = document.getElementById('toolbar-base-branch-static');
    const toolbarBaseText = document.getElementById('toolbar-base-branch-text');
    if (hasBranch && reviewData.baseBranch) {
      if (toolbarBaseText) toolbarBaseText.textContent = reviewData.baseBranch;
      if (toolbarBaseWrap) toolbarBaseWrap.removeAttribute('hidden');
    } else {
      if (toolbarBaseWrap) toolbarBaseWrap.setAttribute('hidden', '');
    }

    // Hide header branch display — toolbar now shows branch info
    const branchVs = document.getElementById('local-branch-vs');
    const baseBranchEl = document.getElementById('local-base-branch');
    const baseBranchText = document.getElementById('local-base-branch-text');
    if (branchVs) branchVs.style.display = 'none';
    if (baseBranchEl) baseBranchEl.style.display = 'none';
    // Keep baseBranchText updated for data purposes even though header is hidden
    if (baseBranchText && reviewData.baseBranch) {
      baseBranchText.textContent = reviewData.baseBranch;
    }

    // Update refresh button tooltip based on scope
    const refreshBtn = document.getElementById('local-refresh-btn');
    if (refreshBtn) {
      const scopeLabel = LS ? LS.scopeLabel(scopeStart, scopeEnd) : 'directory';
      refreshBtn.title = `Refresh diff (${scopeLabel})`;
    }

    // Update commit SHA and wire up copy button
    const commitSha = document.getElementById('pr-commit-sha');
    if (commitSha && reviewData.localHeadSha) {
      const abbrevLen = reviewData.shaAbbrevLength || 7;
      commitSha.textContent = reviewData.localHeadSha.substring(0, abbrevLen);
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

    // Render base branch selector for stacked branches
    const manager = window.prManager;
    if (manager?.renderBaseBranchSelector) {
      manager.renderBaseBranchSelector(manager.currentPR);
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
      const params = new URLSearchParams();
      if (manager.hideWhitespace) params.set('w', '1');
      if (manager.currentBaseOverride) params.set('base', manager.currentBaseOverride);
      const queryString = params.toString();
      const diffUrl = `/api/local/${this.reviewId}/diff${queryString ? '?' + queryString : ''}`;
      const response = await fetch(diffUrl);

      if (!response.ok) {
        throw new Error('Failed to load local diff');
      }

      const data = await response.json();
      const diffContent = data.diff || '';
      const stats = data.stats || {};
      const generatedFiles = new Set(data.generated_files || []);

      if (!diffContent) {
        const diffContainer = document.getElementById('diff-container');
        if (diffContainer) {
          const reviewData = this.localData;
          const branchInfo = reviewData?.branchInfo;
          const LS = window.LocalScope;
          const hasBranch = LS ? LS.scopeIncludes(this.scopeStart, this.scopeEnd, 'branch') : false;

          // Show scope-aware empty message
          if (!hasBranch && branchInfo) {
            const scopeLabel = LS ? LS.scopeLabel(this.scopeStart, this.scopeEnd) : 'current scope';
            diffContainer.innerHTML = `<div class="no-diff">No changes in ${scopeLabel} scope.</div>`;
          } else {
            const scopeLabel = LS ? LS.scopeLabel(this.scopeStart, this.scopeEnd) : 'current scope';
            diffContainer.innerHTML = `<div class="no-diff">No changes in ${scopeLabel} scope. Change <strong>Diff scope</strong> or make some changes and click <strong>Refresh</strong> to reload.</div>`;
          }

          // If branch has commits ahead and branch is not in scope, offer to expand
          if (!hasBranch && branchInfo) {
            this.showBranchReviewDialog(branchInfo);
          }
        }

        // Clear the file navigation sidebar
        manager.updateFileList([]);

        // Update stats to show zeros
        this.updateDiffStats({ additions: 0, deletions: 0, fileCount: 0 });

        return;
      }

      // Parse the unified diff to extract files
      const filePatchMap = manager.parseUnifiedDiff(diffContent);
      manager.filePatches = filePatchMap;

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
          status: (() => {
            const hdr = patch.substring(0, patch.indexOf('@@'));
            return hdr.includes('new file mode') ? 'added' :
                   hdr.includes('deleted file mode') ? 'removed' : 'modified';
          })()
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

      // Load viewed state before rendering so files can start collapsed
      // and so the sidebar viewed indicator renders on first paint
      await manager.loadViewedState();

      // Update file list sidebar
      manager.updateFileList(sortedFiles);

      // Render diff
      manager.renderDiff({ changed_files: sortedFiles });

      // Progressively fetch full file contents for hunk expansion
      manager._upgradeFilesWithContents(sortedFiles);

    } catch (error) {
      console.error('Error loading local diff:', error);
      const diffContainer = document.getElementById('diff-container');
      if (diffContainer) {
        diffContainer.innerHTML = '<div class="no-diff">Error loading changes</div>';
      }
    }
  }

  /**
   * Build a notification string describing a scope change for the chat agent.
   * @param {string} prefix - Leading message (e.g. "Diff scope changed to X.")
   * @param {{ description: string, diffCommand: string, excludes: string, includesUntracked: boolean }|null} hints - Scope git hints
   * @returns {string} Formatted notification text
   */
  _buildScopeNotification(prefix, hints) {
    const parts = [prefix];
    if (hints) {
      parts.push(`Scope: ${hints.description}`);
      parts.push(`Diff command: \`${hints.diffCommand}\``);
      if (hints.excludes) parts.push(hints.excludes);
      if (hints.includesUntracked) parts.push('Untracked files are included. List them with: `git ls-files --others --exclude-standard`');
    }
    return parts.join('\n');
  }

  /**
   * Apply the result of a scope-change POST to local state, UI, and diff.
   * Shared by _handleScopeChange and showBranchReviewDialog.handleConfirm.
   * @param {string} scopeStart - New start stop
   * @param {string} scopeEnd - New end stop
   * @param {Object} result - Response body from POST set-scope
   */
  async _applyScopeResult(scopeStart, scopeEnd, result) {
    const manager = window.prManager;
    const LS = window.LocalScope;

    // Update local state
    this.scopeStart = scopeStart;
    this.scopeEnd = scopeEnd;

    // Update localData
    if (this.localData) {
      this.localData.scopeStart = scopeStart;
      this.localData.scopeEnd = scopeEnd;
      if (result.baseBranch) {
        this.localData.baseBranch = result.baseBranch;
      }
      if (result.localMode) {
        this.localData.localMode = result.localMode;
      }
    }

    // Update currentPR
    const hasBranch = LS ? LS.includesBranch(scopeStart) : false;
    if (manager?.currentPR) {
      manager.currentPR.base_branch = hasBranch
        ? (result.baseBranch || this.localData?.baseBranch || manager.currentPR.head_branch)
        : manager.currentPR.head_branch;
      manager.currentPR.title = hasBranch
        ? `Branch Changes - ${manager.currentPR.head_branch} vs ${manager.currentPR.base_branch}`
        : `Local Changes - ${manager.currentPR.head_branch}`;
    }

    // Reset base branch override on scope change (base branch context may differ)
    if (manager) {
      manager.currentBaseOverride = null;
    }

    // Update header and reload diff
    this.updateLocalHeader(this.localData);
    await this.loadLocalDiff();

    // Re-anchor comments and suggestions
    const includeDismissed = window.aiPanel?.showDismissedComments || false;
    await manager.loadUserComments(includeDismissed);
    await manager.loadAISuggestions(null, manager.selectedRunId);

    // Only update dropdown if user hasn't clicked again since this request started
    if (manager?.diffOptionsDropdown) {
      const current = manager.diffOptionsDropdown.scope;
      if (current.start === scopeStart && current.end === scopeEnd) {
        manager.diffOptionsDropdown.clearScopeStatus();
      }
    }
  }

  /**
   * Handle scope change from DiffOptionsDropdown.
   * POSTs new scope to backend, reloads diff on success.
   * @param {string} scopeStart - New start stop
   * @param {string} scopeEnd - New end stop
   */
  async _handleScopeChange(scopeStart, scopeEnd) {
    const manager = window.prManager;
    const LS = window.LocalScope;
    const oldStart = this.scopeStart;
    const oldEnd = this.scopeEnd;

    try {
      const resp = await fetch(`/api/local/${this.reviewId}/set-scope`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopeStart, scopeEnd })
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || 'Failed to set scope');
      }

      const result = await resp.json();
      await this._applyScopeResult(scopeStart, scopeEnd, result);

      // Notify chat agent about scope change
      if (window.chatPanel) {
        const label = LS ? LS.scopeLabel(scopeStart, scopeEnd) : `${scopeStart}\u2013${scopeEnd}`;
        const hints = LS ? LS.scopeGitHints(scopeStart, scopeEnd, this.localData?.baseBranch) : null;
        const notification = this._buildScopeNotification(
          `Diff scope changed to ${label}. The set of reviewed files has changed.`, hints
        );
        window.chatPanel.queueDiffStateNotification(notification);
      }

      if (window.toast) {
        const label = LS ? LS.scopeLabel(scopeStart, scopeEnd) : `${scopeStart}\u2013${scopeEnd}`;
        window.toast.showSuccess(`Scope: ${label}`);
      }
    } catch (error) {
      console.error('Failed to change scope:', error);
      if (window.toast) {
        window.toast.showError('Failed to change scope: ' + error.message);
      }
      // Rollback dropdown only if user hasn't clicked again
      if (manager?.diffOptionsDropdown) {
        const current = manager.diffOptionsDropdown.scope;
        if (current.start === scopeStart && current.end === scopeEnd) {
          manager.diffOptionsDropdown.scope = { start: oldStart, end: oldEnd };
          manager.diffOptionsDropdown.clearScopeStatus();
        }
      }
    }
  }

  /**
   * Show a dialog prompting the user to review branch changes.
   * Uses the same modal pattern as ConfirmDialog/TextInputDialog.
   * @param {Object} branchInfo - Branch info with commitCount and baseBranch
   */
  showBranchReviewDialog(branchInfo) {
    // Remove any existing branch review dialog
    const existing = document.getElementById('branch-review-dialog');
    if (existing) existing.remove();

    const commitLabel = branchInfo.commitCount === 1 ? 'commit' : 'commits';

    const overlay = document.createElement('div');
    overlay.id = 'branch-review-dialog';
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';

    overlay.innerHTML = `
      <div class="modal-backdrop" data-action="cancel"></div>
      <div class="modal-container confirm-dialog-container" style="width: 440px; height: auto;">
        <div class="modal-header">
          <h3>Branch Has Changes</h3>
          <button class="modal-close-btn" data-action="cancel" title="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
            </svg>
          </button>
        </div>

        <div class="modal-body" style="padding: 16px 20px;">
          <p style="margin: 0 0 12px 0; font-size: 14px;">
            No uncommitted changes. This branch has <strong>${branchInfo.commitCount}</strong> ${commitLabel} ahead of <code style="padding: 2px 6px; background: var(--color-bg-tertiary); border-radius: 4px; font-size: 12px;">${branchInfo.baseBranch}</code>.
          </p>
          <label style="font-size: 12px; color: var(--color-text-tertiary); cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
            <input type="checkbox" id="branch-review-dont-ask" style="cursor: pointer;">
            Don't ask again for this repository
          </label>
        </div>

        <div class="modal-footer">
          <button class="btn btn-secondary" data-action="cancel">Cancel</button>
          <button class="btn btn-primary" id="branch-review-confirm-btn" data-action="confirm">
            Expand Scope to Branch
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const reviewId = this.reviewId;
    const self = this;

    const closeDialog = () => {
      overlay.style.display = 'none';
      overlay.remove();
      document.removeEventListener('keydown', keyHandler);
    };

    const handleConfirm = async () => {
      const confirmBtn = overlay.querySelector('#branch-review-confirm-btn');
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Expanding...';
      }

      // Save "don't ask" preference if checked
      const dontAsk = overlay.querySelector('#branch-review-dont-ask');
      if (dontAsk?.checked) {
        try {
          await fetch(`/api/local/${reviewId}/branch-review-preference`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preference: -1 })
          });
        } catch { /* non-fatal */ }
      }

      try {
        const LS = window.LocalScope;
        const newEnd = self.scopeEnd || (LS ? LS.DEFAULT_SCOPE.end : 'untracked');
        const resp = await fetch(`/api/local/${reviewId}/set-scope`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scopeStart: 'branch',
            scopeEnd: newEnd,
            baseBranch: branchInfo.baseBranch
          })
        });
        if (!resp.ok) {
          const err = await resp.json();
          throw new Error(err.error || 'Failed to expand scope');
        }

        const result = await resp.json();

        // Update the dropdown branchAvailable flag
        const manager = window.prManager;
        if (manager?.diffOptionsDropdown) {
          manager.diffOptionsDropdown.branchAvailable = true;
          manager.diffOptionsDropdown.scope = { start: 'branch', end: newEnd };
        }

        closeDialog();

        await self._applyScopeResult('branch', newEnd, result);

        if (window.chatPanel) {
          const label = LS ? LS.scopeLabel('branch', newEnd) : 'branch';
          const hints = LS ? LS.scopeGitHints('branch', newEnd, branchInfo.baseBranch) : null;
          const notification = self._buildScopeNotification(
            `Diff scope changed to ${label} via branch review. The set of reviewed files has changed.`, hints
          );
          window.chatPanel.queueDiffStateNotification(notification);
        }

        if (window.toast) {
          const label = LS ? LS.scopeLabel('branch', newEnd) : 'Branch';
          window.toast.showSuccess(`Scope expanded to ${label}`);
        }
      } catch (error) {
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Expand Scope to Branch';
        }
        console.error('Failed to expand scope to branch:', error);
        if (window.toast) {
          window.toast.showError('Failed to expand scope: ' + error.message);
        }
      }
    };

    // Event delegation for clicks
    overlay.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'confirm') {
        handleConfirm();
      } else if (action === 'cancel') {
        closeDialog();
      }
    });

    // Keyboard handler
    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        closeDialog();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const btn = overlay.querySelector('#branch-review-confirm-btn');
        if (!btn?.disabled) handleConfirm();
      }
    };
    document.addEventListener('keydown', keyHandler);
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
      4: 'orchestration', // Orchestration/finalization is level 4 in progress modal
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
if (typeof window !== 'undefined' && window.PAIR_REVIEW_LOCAL_MODE) {
  window.localManager = new LocalManager();
}

// Export for testing (Node.js environment)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LocalManager };
}
