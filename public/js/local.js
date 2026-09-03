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

/**
 * The working-tree half of the PR-drift chat notification — one sentence per
 * thing we can actually know about the tree.
 *
 * These strings go into the AI agent's context as FACT, so each may assert only
 * what somebody actually answered. There is no "unknown" default: the caller
 * that has no working-tree answer to give passes `null` and the clause is
 * omitted, which is not the same statement as "could not be determined".
 * See `_workingTreeNote` and `_applyPRHeadStaleState`.
 */
const TREE_CURRENT_NOTE =
  'The working tree is current; refreshing the diff will not close this gap';
const TREE_CHANGED_NOTE =
  'The working tree has also changed since the diff was captured; '
  + 'refreshing it will not close this gap';
const TREE_UNKNOWN_NOTE =
  'Whether the working tree still matches the captured diff could not be determined; '
  + 'refreshing it will not close this gap either';
const RECAPTURED_TREE_NOTE =
  'The diff was just re-captured from the working tree, so refreshing again will not close this gap';

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
    // Populated by loadLocalReview() from the backend response. Always
    // present (defaults to all-false) so feature checks never throw.
    // Mirrors the shape returned by providers/pr-context.js
    // `buildCapabilities` and matches the PRManager surface in pr.js.
    this.capabilities = {
      // Prerequisite state
      hasAssociatedPR: false,
      hasGitHubToken: false,
      // Action contracts — flipped true only when each phase ships.
      canShowPRMetadata: false,   // Phase 1
      canViewPRComments: false,   // Phase 2
      canCheckStaleVsPR: false,   // Phase 3
      canSyncDrafts: false,       // Phase 4
      canSubmitToGitHub: false    // Phase 5
    };
    // Cold-cache PR metadata warm-up state; see _maybeWarmPRMetadata().
    // `_prMetadataWarmHolder` is an in-flight HOLD: null when free, otherwise
    // the token of the path holding it. A token rather than a boolean because
    // TWO paths take this hold and can overlap, so a release must not clear a
    // hold somebody else is still relying on.
    // `_prMetadataWarmAttempts` is the hard per-page-load retry budget.
    this._prMetadataWarmHolder = null;
    this._prMetadataWarmAttempts = 0;

    // Phase 4 draft sync. `_draftSyncPromise` is an in-flight join point, not
    // a latch: the button and the automatic load-time sync can fire within
    // milliseconds of each other (the capability can flip late), and two
    // concurrent POSTs would race each other's `github_reviews` reconciliation
    // — the loser can create a SECOND pending row for one GitHub draft.
    // Cleared in a `finally` so a failure never blocks a retry.
    this._draftSyncPromise = null;
    // One automatic sync per page load. The button is the only way to ask
    // again; see `_syncGitHubDrafts`.
    this._draftSyncAutoDone = false;

    // Per-repo header links, and the substitution context every link reader
    // (including the pending-draft URL) resolves against. The promise is
    // awaited before rendering the draft indicator; the signature keeps a
    // re-apply free when the association has not moved. See `_applyRepoLinks`.
    this._repoLinksPromise = null;
    this._repoLinksSignature = null;

    // The most recent thing anybody actually learned about the working tree,
    // as the sentence `_applyPRHeadStaleState` composes into its notification.
    // Kept SEPARATELY from PR-head state because the two are answered by
    // different requests: `?prHeadOnly=1` never asks about the tree, so
    // composing its `isStale: null` as "could not be determined" would destroy
    // a known fact — the chat panel stores ONE snapshot per tab and every
    // queue call replaces it. Null until something answers.
    this._workingTreeNote = null;

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
    const searchParams = new URLSearchParams(window.location.search);
    const autoAnalyze = searchParams.get('analyze');
    if (autoAnalyze === 'true' && !window.prManager.isAnalyzing) {
      const manager = window.prManager;
      // Provider/model override carried on the URL by single-port delegation
      // (the delegated-to server is a different process whose env never saw the
      // CLI flag). Prepended ahead of repo settings in _buildDefaultAnalysisConfig.
      const urlOverride = {
        provider: searchParams.get('provider'),
        model: searchParams.get('model')
      };
      try {
        // Prefer a stashed bulk-analysis config (threaded via analysisConfigId).
        // The CLI uses it to carry --instructions plus the resolved
        // provider/model or council snapshot into the browser auto-analyze;
        // mirrors PRManager._maybeAutoAnalyze.
        const storedConfig = await manager._fetchAutoAnalysisConfigFromUrl();
        let config;
        if (storedConfig.requested) {
          if (!storedConfig.config) {
            // The stored config expired (TTL/eviction/restart). The diff has
            // already rendered, so leave the review usable for manual analysis
            // rather than failing; warn and bail.
            const message = 'Could not load the selected analysis settings. Start analysis manually to choose new settings.';
            if (window.toast) window.toast.showWarning(message);
            return;
          }
          config = storedConfig.config;
        } else {
          // Fetch repo settings so we honour the repository's default provider/council
          const [repoSettings, reviewSettings, appConfig] = await Promise.all([
            manager.fetchRepoSettings().catch(() => null),
            manager.fetchLastReviewSettings().catch(() => ({ custom_instructions: '', last_council_id: null })),
            manager._getAppConfig()
          ]);
          config = await manager._buildDefaultAnalysisConfig(repoSettings, reviewSettings, appConfig, null, urlOverride);
        }

        await this.startLocalAnalysis(null, config);
      } finally {
        const cleanUrl = new URL(window.location);
        // Strip the whole auto-analyze intent bundle (analyze/analysisConfigId/
        // council/provider/model) so a manual refresh does not replay the intent.
        window.stripAnalyzeParams(cleanUrl);
        history.replaceState(null, '', cleanUrl);
      }
    }

    this.isInitialized = true;
  }

  /**
   * Check whether the backend says this local review has a given capability.
   * Use this instead of mode-sniffing (e.g. `window.location.pathname.startsWith('/local')`)
   * when gating PR-only features in local mode.
   *
   * Mirrors `PRManager.hasCapability(name)` so shared components can call
   * `window.prManager.hasCapability(...)` regardless of which manager owns
   * the page — see loadLocalReview() which copies this.capabilities onto
   * the PRManager instance.
   *
   * @param {string} name - One of 'hasAssociatedPR', 'hasGitHubToken',
   *   'canShowPRMetadata', 'canViewPRComments', 'canCheckStaleVsPR',
   *   'canSyncDrafts', 'canSubmitToGitHub'
   * @returns {boolean}
   */
  hasCapability(name) {
    return Boolean(this.capabilities && this.capabilities[name]);
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

    // THE capability contract for local mode. Two halves:
    //
    // FLOOR — push the all-false capabilities onto PRManager at patch time,
    // the point where this page stops being a PR page. PRManager's constructor
    // defaults every flag TRUE (correct for PR mode) and loadLocalReview only
    // overwrites them once its fetch succeeds, so a failed or slow load would
    // otherwise leave shared components told canSubmitToGitHub is available.
    //
    // LATE FLIP — some flags (`hasAssociatedPR`, `canViewPRComments`) only
    // become true after `/pr-metadata` resolves an association the page-load
    // GET could not see. So every consumer must RE-READ `hasCapability` on
    // each call and never latch a false answer: guards, affordance toggles and
    // overlay re-renders are all written that way on purpose.
    manager.capabilities = { ...this.capabilities };

    // Initialize collapse and viewed state Sets (ensure they exist)
    if (!manager.collapsedFiles) {
      manager.collapsedFiles = new Set();
    }
    if (!manager.viewedFiles) {
      manager.viewedFiles = new Set();
    }

    // Viewed-state storage keys.
    //
    // Scoped to the LOCAL SESSION (review id), NOT to the commit. The key used
    // to end in `head_sha`, so every refresh that moved HEAD produced a key
    // MISS — and a miss does not leave the in-memory set alone, it hard-resets
    // `viewedFiles` to empty, silently wiping every viewed checkmark. That
    // could fire with zero user interaction (`_checkLocalStalenessOnLoad` calls
    // `refreshDiff({silent:true})`) and on the "Continue This Session — keep
    // comments and suggestions" branch, where the user was just promised the
    // opposite.
    //
    // `localPath` stays in the key: review ids are unique within one database
    // and there is one database per working directory, so the path segment is
    // what keeps two directories' id 42 apart.
    const viewedKeyPrefix = () => {
      const localPath = manager.currentPR?.localPath;
      if (!localPath) return null;
      // encodeURIComponent + unescape gives proper UTF-8 to Base64 conversion
      // (handles non-Latin1 paths).
      return `pair-review-local-viewed:${btoa(unescape(encodeURIComponent(localPath)))}`;
    };
    const viewedKey = () => {
      const prefix = viewedKeyPrefix();
      return prefix ? `${prefix}:review-${reviewId}` : null;
    };

    // Override saveViewedState to use localStorage with a session-scoped key
    manager.saveViewedState = function() {
      const key = viewedKey();
      if (!key) return;

      const viewedArray = Array.from(manager.viewedFiles);

      try {
        localStorage.setItem(key, JSON.stringify(viewedArray));
      } catch (error) {
        console.warn('Error saving viewed state to localStorage:', error);
      }
    };

    // Override loadViewedState to use localStorage with a session-scoped key
    manager.loadViewedState = async function() {
      const key = viewedKey();
      if (!key) return;

      try {
        let stored = localStorage.getItem(key);
        let adoptedLegacy = false;
        if (!stored) {
          // One-time read-through for sessions that started before the key was
          // session-scoped: adopt the legacy commit-scoped value for the
          // CURRENT head. Costs one extra miss-path read and needs no
          // migration step.
          const headSha = manager.currentPR?.head_sha;
          const prefix = headSha ? viewedKeyPrefix() : null;
          if (prefix) {
            stored = localStorage.getItem(`${prefix}:${headSha}`);
            adoptedLegacy = Boolean(stored);
          }
        }
        if (stored) {
          manager.viewedFiles = new Set(JSON.parse(stored));
          // WRITE THROUGH, immediately. Reading a legacy value into memory and
          // waiting for the next save to persist it is a fallback that fails on
          // the one path it exists for: the legacy key is derived from the
          // CURRENT head, so a HEAD change before the user happens to toggle a
          // file makes the next load derive a different legacy key, miss, and
          // reset the set to empty. `_applyRefreshedDiff` moves `head_sha` and
          // then reloads the diff with zero interaction, so that window is the
          // normal case, not a corner. The legacy key is deliberately left in
          // place — this is an adoption, not a migration, and a rollback must
          // still find its value.
          if (adoptedLegacy) manager.saveViewedState();
        } else {
          manager.viewedFiles = new Set();
        }
      } catch (error) {
        console.warn('Error loading viewed state from localStorage:', error);
        manager.viewedFiles = new Set();
      }
    };

    // Pre-refresh hook for the External-segment refresh button; see the
    // `_onBeforeExternalCommentsRefresh` declaration in pr.js. Local mode
    // uses it to re-read the TTL-less PR head anchor trust is derived from.
    manager._onBeforeExternalCommentsRefresh = () => self._refreshPRMetadata({ force: true });

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
        // Pass owner+repo to /api/config (when we have a remote) so
        // has_github_token reflects the repo's actual auth — covers
        // repo-scoped tokens, token_command, and alt-host bindings.
        // Local sessions without a remote origin fall back to the
        // global-only response (has_global_github_token), which the
        // modal already treats as no-GitHub-auth for dedup purposes.
        let configUrl = '/api/config';
        const localRepo = self.localData?.repository;
        if (typeof localRepo === 'string' && localRepo.includes('/')) {
          const [lOwner, lRepo] = localRepo.split('/');
          if (lOwner && lRepo) {
            configUrl = `/api/config?owner=${encodeURIComponent(lOwner)}&repo=${encodeURIComponent(lRepo)}`;
          }
        }
        const [staleResult, repoSettings, reviewSettings, appConfig] = await Promise.all([
          staleCheckWithTimeout,
          manager.fetchRepoSettings().catch(() => null),
          manager.fetchLastReviewSettings().catch(() => ({ custom_instructions: '', last_council_id: null })),
          fetch(configUrl).then(r => r.ok ? r.json() : {}).catch(() => ({}))
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

        // Resolve provider and model as a MATCHED pair so the council/advanced tabs
        // are never seeded with a cross-provider model (e.g. antigravity + opus), which
        // would blank the model <select> and be rejected by the backend.
        // buildProviderModelScopes prepends any CLI/env override ahead of repo
        // settings so `--provider` seeds the modal as the default selection.
        const providersInfo = await manager._getProvidersInfo();
        const { provider: currentProvider, model: currentModel } = window.resolveProviderModelPair(
          window.buildProviderModelScopes(repoSettings, appConfig),
          providersInfo
        );

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
          // Prefer the repo-aware field when present (we passed owner+repo
          // to /api/config). For local sessions without a remote origin
          // we fall back to the global capability — there is no repo
          // binding to honour, so the global token is the only token a
          // dedup operation could use anyway.
          hasGithubToken: Boolean(
            appConfig.has_github_token ?? appConfig.has_global_github_token
          )
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

    // Note: initSplitButton is NOT patched — the standard SplitButton reads
    // `canSubmitToGitHub` off whichever manager owns the page, so local mode
    // with an associated PR (Phase 5) shows Submit and one without hides it.
    // It reads that flag ONCE, in its constructor; a late flip is applied by
    // `PRManager.updateSubmitAffordance` (a mutator, not a rebuild), which
    // `_refreshPRMetadata` calls on every metadata read.

    // Phase 5 — the lifecycle re-read behind `ReviewModal`'s `pr_merged` /
    // `pr_closed` race handling. PR mode asks its own check-stale endpoint;
    // a local session has no `owner/repo/number` to ask with, and the
    // association's lifecycle arrives on the metadata endpoint instead.
    //
    // `_refreshPRMetadata({force: true})` is the whole job: it re-reads
    // `associatedPR` (state and merged included), repaints the header pill and
    // ends by calling `updateSubmitAffordance`, which re-applies the open
    // modal's allowed events. Forced, because the backend's metadata cache has
    // no TTL — an unforced read would answer with the very state that was
    // just proven stale.
    manager.refreshPRLifecycle = async function() {
      await self._refreshPRMetadata({ force: true });
    };

    // Phase 5 — where ReviewModal POSTs the review. PR mode addresses the PR by
    // owner/repo/number; a local session is addressed by its own review id, and
    // the backend resolves the association from the row. Overriding the method
    // (rather than teaching the shared modal about modes) is what keeps
    // ReviewModal free of mode-sniffing.
    manager.getSubmitReviewEndpoint = function() {
      return `/api/local/${reviewId}/submit-review`;
    };

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

      await self._rerenderLocalOverlays();

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
          // Changes the diff's LEFT column; must precede the re-render.
          self._applyBaseOverrideLeftAnchor(manager);
          await self.loadLocalDiff();
          // ALL layers: this path used to restore only the external rows, so
          // switching base branch dropped draft comments and AI suggestions.
          await self._rerenderLocalOverlays();
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
   * @returns {Promise<{forcedPRMetadataRead: boolean}|undefined>} The outcome of
   *   `_applyRefreshedDiff`, or undefined when the refresh never got that far
   *   (button missing or busy, HEAD-change dialog cancelled, request failed).
   *   Only `_checkLocalStalenessOnLoad` reads it; every other caller ignores it.
   */
  async refreshDiff(opts = {}) {
    const manager = window.prManager;
    const refreshBtn = document.getElementById('local-refresh-btn');

    if (!refreshBtn || refreshBtn.disabled) return;

    try {
      // Show loading state
      refreshBtn.disabled = true;
      refreshBtn.classList.add('refreshing');

      // Stamped HERE, before the POST — a working-tree answer taken before a
      // recapture starts is spent, and the on-load check parks on awaits long
      // enough to still be holding one. Waiting until `_applyRefreshedDiff`
      // would leave a window in which that parked check can fire a SECOND,
      // concurrent refresh of the diff this one is already recapturing.
      // `_applyRefreshedDiff` stamps again for the answers that landed during
      // the round trip; both bumps are correct and a counter is idempotent
      // under repetition.
      this._nextWorkingTreeCheckGeneration();

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

      return await this._applyRefreshedDiff(manager, result, { userInitiated: !opts.silent });

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
   *
   * @param {Object} manager - window.prManager
   * @param {Object} result - response body from POST /api/local/:reviewId/refresh
   *   (possibly merged with the resolve-head-change response)
   * @param {Object} [options]
   * @param {boolean} [options.userInitiated=false] - False for the silent
   *   on-load staleness refresh. Its only effect is the forced PR-metadata
   *   re-read below (the PUSH trigger).
   * @returns {Promise<{forcedPRMetadataRead: boolean}>} Whether this call
   *   issued a forced (`?refresh=1`) PR-metadata read. `_checkLocalStalenessOnLoad`
   *   needs the answer to avoid issuing a second, identical one — and it is a
   *   genuine question, not a constant: the read fires only when local HEAD
   *   moved or the user asked.
   */
  async _applyRefreshedDiff(manager, result, { userInitiated = false } = {}) {
    // The recapture has landed: every working-tree answer computed against the
    // OLD baseline digest — including one whose request left before this
    // refresh started — is now obsolete. `refreshDiff` stamped once already;
    // this second bump covers the answers that arrived while the POST was in
    // flight. PR-head answers are untouched: a refresh cannot move a commit on
    // GitHub. See `_nextWorkingTreeCheckGeneration`.
    this._nextWorkingTreeCheckGeneration();

    // ...and the tree the user is now looking at was read moments ago. Remember
    // that, because the `prHeadOnly` recheck below is answered `isStale: null`
    // ("not asked") and a later PR-side notification must not launder that into
    // "could not be determined". See `_workingTreeNote`.
    this._workingTreeNote = RECAPTURED_TREE_NOTE;

    // Notify chat agent about diff refresh.
    //
    // ONE message, composed — `queueDiffStateNotification` is not a queue. It
    // stores a single snapshot per tab (see ChatPanel), so each call REPLACES
    // the last: the HEAD-change sentence was being erased by the refresh
    // sentence before the agent could ever read it. The composed text is also
    // handed to `_recheckPRHeadState` below, whose own message lands a network
    // round-trip later and would otherwise overwrite the only signal the agent
    // has that the diff underneath it was re-captured.
    const refreshNotes = [];
    if (result.headShaChanged) {
      const prev = result.previousHeadSha;
      const abbrevLen = this.localData?.shaAbbrevLength || 7;
      refreshNotes.push(
        `HEAD SHA changed: ${prev ? prev.substring(0, abbrevLen) : 'unknown'} \u2192 ${result.currentHeadSha ? result.currentHeadSha.substring(0, abbrevLen) : 'unknown'}.`
      );
    }
    refreshNotes.push('Local diff refreshed from working directory.');
    const refreshNote = refreshNotes.join(' ');
    if (window.chatPanel) {
      window.chatPanel.queueDiffStateNotification(refreshNote);
    }

    // Needed by the "did local HEAD move?" trigger below, which cannot be
    // asked once the field is overwritten.
    const previousHeadSha = manager.currentPR?.head_sha || null;

    // `currentPR.head_sha` was set once at page load and is read as "the commit
    // this diff is" — `_externalAnchorContext` decides whether GitHub's line
    // numbers may be trusted from it. Leaving it stale after a refresh that
    // moved HEAD is how a mismatch starts looking like a match.
    if (result.currentHeadSha && manager.currentPR) {
      manager.currentPR.head_sha = result.currentHeadSha;
    }
    if (result.currentHeadSha && this.localData) {
      this.localData.localHeadSha = result.currentHeadSha;
    }

    // LEFT-side anchor inputs move with the diff too (a refresh can change the
    // merge base without changing scope).
    this._applyLeftAnchorInputs(result);

    // Reset base branch override before reloading diff so the fetch uses the default base
    manager.currentBaseOverride = null;
    const baseSel = document.getElementById('base-branch-select');
    if (baseSel && manager.currentPR?.base_branch) {
      baseSel.value = manager.currentPR.base_branch;
    }

    // Re-read the PR metadata when the anchor-trust comparison could have gone
    // stale. Two triggers, because the two sides move independently:
    //   - local HEAD moved (the PULL case: we committed or pulled), and
    //   - the user asked for this refresh (the PUSH case: a push leaves local
    //     HEAD untouched while the PR head advances, so a HEAD-change trigger
    //     alone could never fire for it).
    // The silent on-load refresh with an unchanged HEAD is deliberately left
    // out: nothing has moved, and it runs without the user asking.
    const headMoved = Boolean(
      result.currentHeadSha && previousHeadSha && result.currentHeadSha !== previousHeadSha
    );
    const forceMetadataRead = headMoved || userInitiated;

    // Hold the warm-up across BOTH the forced read AND the header re-render
    // below. `updateLocalHeader` -> `renderAssociatedPRPill` calls back into
    // `_maybeWarmPRMetadata` whenever the pill is still hidden, so releasing
    // before the header re-rendered started a second, unforced fetch on the
    // very next statement and burned one of the three per-page-load attempts.
    //
    // Concurrency: the on-load staleness check can enter this method while a
    // warm-up from the initial render is STILL in flight. Acquire returns null
    // then, and release is a no-op for a null token, so this path can neither
    // steal nor clear the other's hold — which a bare boolean did. The forced
    // read runs regardless; it does not depend on owning the hold.
    const warmHold = forceMetadataRead ? this._acquirePRMetadataWarmHold() : null;
    try {
      if (forceMetadataRead) {
        await this._refreshPRMetadata({ force: true });
      }

      // `updateLocalHeader` is the only thing that writes `#pr-commit-sha`
      // (and its `dataset.fullSha`); without this the SHA adopted above and
      // the SHA on screen diverge. Safe to re-run mid-refresh: every listener
      // it attaches is guarded, and both things it re-renders are idempotent.
      if (this.localData) {
        this.updateLocalHeader(this.localData);
      }
    } finally {
      this._releasePRMetadataWarmHold(warmHold);
    }

    // Reload the diff display
    await this.loadLocalDiff();

    // Refresh re-fetched the diff from disk, so upstream may have moved too:
    // sync before re-anchoring, matching PR mode's refreshPR path.
    await this._rerenderLocalOverlays({ sync: true });

    // Update branchAvailable on the scope selector if the backend sent an updated value
    if (result.branchAvailable !== undefined && manager.diffOptionsDropdown) {
      manager.diffOptionsDropdown.branchAvailable = result.branchAvailable;
    }

    // Clear stale state after successful refresh — the FRESHNESS slot only.
    // The badge group is what makes that possible: PR DRIFT and MERGED/CLOSED
    // are not things a refresh fixed, and clearing the whole element meant a
    // user who saw the drift badge and reached for the only visible affordance
    // made it disappear while it was still true. The README promises the
    // opposite ("informational, not a call to refresh").
    manager._hideStaleBadge('stale');
    manager._stalenessPromise = null;

    // ...and re-ask about the PR side, which a refresh cannot change but which
    // may have moved on its own since page load. `prHeadOnly` because that is
    // all this consumes: the refresh route has just rebuilt the diff and its
    // digest, so recomputing the working-tree digest here would repeat the
    // whole tree walk to produce an answer nobody reads. Fire-and-forget so the
    // refresh's own toast is not held up by a network round trip.
    void this._recheckPRHeadState({
      // Restates what the composed refresh message said, because this call
      // replaces it (see above).
      preface: `${refreshNote} `,
      // ...and the backend's `isStale: null` here means "not asked", not
      // "unknown": the diff on screen was re-captured from the tree moments
      // ago. Say that instead of "could not be determined".
      workingTreeNote: RECAPTURED_TREE_NOTE
    });

    // Show success toast
    if (window.toast) {
      window.toast.showSuccess('Diff refreshed successfully');
    } else if (window.showToast) {
      window.showToast('Diff refreshed successfully', 'success');
    }

    return { forcedPRMetadataRead: forceMetadataRead };
  }

  /**
   * Check staleness on page load and show badge or auto-refresh.
   *
   * Logic mirrors PRManager._checkStalenessOnLoad but uses the local
   * GET endpoint. Badge types: 'stale' (working tree moved) plus, when the
   * review has an associated PR, 'merged' / 'closed' / 'pr-drift'.
   *
   * NO BADGE PRIORITY — the badges are a GROUP of independent slots (see
   * `_showStaleBadge` in public/js/pr.js), so a tree that moved AND a PR that
   * moved render side by side. There is no ordering to get wrong, which is the
   * point: the single shared element used to let whichever fact was evaluated
   * last erase the others.
   *
   * `result.isStale` means working-tree staleness ONLY and must stay that way:
   * `isStale === true` with no session data triggers `refreshDiff({silent:true})`,
   * and re-capturing the local diff cannot make the PR stop having advanced.
   * OR-ing PR drift into `isStale` would re-capture the diff on every single
   * page load, forever.
   *
   * @returns {Promise<Object|null>} The staleness result, or null on failure.
   */
  async _checkLocalStalenessOnLoad() {
    // Stamp BEFORE the fetch, ONE PER DOMAIN: this is the only request that
    // answers both questions, and the two are superseded by different events.
    // Several unawaited paths write each side, and whichever answer landed
    // last used to win regardless of which was asked last.
    const prHeadGeneration = this._nextPRHeadCheckGeneration();
    const workingTreeGeneration = this._nextWorkingTreeCheckGeneration();

    // ...and the working-tree branch needs its stamp re-checked at every await
    // it parks on, not just where the PR stamp is handed to
    // `_applyPRHeadStaleState`. The ordering that got through: this check reads
    // `isStale: true`, parks on the session-data query, the user hits Refresh —
    // which clears the STALE slot and recaptures the diff — and then the parked
    // query resolves and repaints STALE, or fires a second silent refresh, over
    // a diff that was re-captured while it waited.
    //
    // A `prHeadOnly` recheck must NOT trip this guard; see
    // `_nextWorkingTreeCheckGeneration`.
    //
    // SIDE EFFECTS ONLY: every guard below returns `result`, never null. This
    // promise is `_stalenessPromise`, which the Analyze dialog awaits and reads
    // (see `patchPRManager`) — a superseded badge is a lie, but a superseded
    // answer is still a true statement about the moment it was asked, and
    // swallowing it would make the dialog fall back to a second fetch.
    const superseded = () => workingTreeGeneration !== this._workingTreeCheckGeneration;

    try {
      const result = await this._fetchLocalStaleness();
      if (!result) return null;
      // Nothing past this line — chat snapshot, badge, `refreshDiff`, forced
      // metadata read — may run on an answer a newer request has replaced.
      // Dropping `_refreshPRMetadataIfPRAdvanced` with them drops no
      // convergence: the only thing that advances the WORKING-TREE stamp is a
      // refresh (or a newer full check), and `_applyRefreshedDiff` issues its
      // own forced `?refresh=1` whenever the refresh was user-initiated — and a
      // refresh running against this check can only be user-initiated, since
      // the sole silent one is the branch below. A `prHeadOnly` recheck no
      // longer reaches this guard at all, and it now drives that same
      // convergence itself.
      if (superseded()) return result;

      // This is the only request that ASKS about the working tree, so it is the
      // only one that may update the remembered statement — including to `null`
      // when the backend could not tell. A later `prHeadOnly` recheck composes
      // whatever is remembered here rather than inventing an answer of its own.
      this._workingTreeNote = LocalManager.workingTreeNoteFor(result.isStale);

      // Notify chat of HEAD SHA change even when diff digest is unchanged
      // (e.g. git commit --amend with identical content, or rebase)
      const abbrevLen = this.localData?.shaAbbrevLength || 7;
      if (result.headShaChanged && window.chatPanel) {
        window.chatPanel.queueDiffStateNotification(
          `HEAD SHA changed (${result.previousHeadSha ? result.previousHeadSha.substring(0, abbrevLen) : 'unknown'} → ${result.currentHeadSha ? result.currentHeadSha.substring(0, abbrevLen) : 'unknown'}). The branch may have been rebased.`
        );
      }

      // Set by the silent-refresh branch below. `_applyRefreshedDiff` performs
      // its own forced `?refresh=1` read, and reports whether it did — it only
      // does so when local HEAD actually moved, so this cannot be assumed.
      let metadataAlreadyRefreshed = false;

      if (result.isStale === true) {
        // Stale — decide: silent refresh or show badge
        const manager = window.prManager;
        const hasData = await manager._hasActiveSessionData();
        if (superseded()) return result;
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
          // The PR side is a different question and gets its own badge slot,
          // so it is applied on this branch too. Its chat message restates the
          // working-tree fact (the `isStale === true` arm of the note below),
          // because it replaces the snapshot just queued.
          this._applyPRHeadStaleState(result, abbrevLen, { generation: prHeadGeneration });
        } else {
          // No user work to protect — refresh silently (auto-update on HEAD change).
          // `_applyRefreshedDiff` re-asks about the PR head itself, so this
          // branch deliberately does not.
          console.debug('[Local] working directory stale, no session data — auto-refreshing');
          const refreshOutcome = await this.refreshDiff({ silent: true });
          metadataAlreadyRefreshed = Boolean(refreshOutcome && refreshOutcome.forcedPRMetadataRead);
          // NO `superseded()` guard on this await, deliberately. The refresh we
          // just awaited stamps the working-tree generation itself — twice, in
          // `refreshDiff` and again in `_applyRefreshedDiff` — so OUR OWN
          // descendant has always advanced the counter by the time this line
          // runs, and the check would be a constant `true`. It would then skip
          // `_refreshPRMetadataIfPRAdvanced` on precisely the path that still
          // needs it: a silent refresh whose local HEAD did not move makes no
          // forced read (`forceMetadataRead = headMoved || userInitiated`), so a
          // `pr_metadata.head_sha` left behind by an upstream push would stay
          // behind — and that is one operand of the anchor-trust gate.
          // `metadataAlreadyRefreshed` already asks the real question.
        }
      } else {
        // Everything that is NOT `isStale === true` lands here, and that is two
        // different answers, not one:
        //   - `false` — the working tree matches the captured diff, so nothing
        //     here is fixable by refreshing;
        //   - `null` — the backend could not tell (no stored diff data, or the
        //     handler threw). It still ships a fully populated `prHead`.
        // Either way the PR may have moved under us and that fact is
        // independently true, so the badge is shown for both. Only the wording
        // differs — see `_applyPRHeadStaleState`, which must not claim the
        // working tree is current on the `null` answer.
        this._applyPRHeadStaleState(result, abbrevLen, { generation: prHeadGeneration });
      }

      // Independent of the badge, and of working-tree staleness: `pr_metadata`
      // has no TTL, so a PR that advanced upstream leaves the cached head_sha
      // behind — and that cached value is one operand of Phase 2's anchor-trust
      // gate. `prAdvanced` is precisely "our cache is behind". Fire-and-forget:
      // this promise is `_stalenessPromise`, which the Analyze dialog awaits,
      // and a metadata round trip must not sit in front of that dialog.
      //
      // Skipped only when the silent refresh above reported that it already
      // issued a forced read — the cache is then current as of a moment LATER
      // than the `prAdvanced` flag we are still holding, so a second
      // `?refresh=1` could only re-fetch what was just fetched. Every other
      // path (badge shown, not stale, refresh declined, refresh failed, or a
      // refresh that did not need the forced read) still calls.
      if (!metadataAlreadyRefreshed) {
        void this._refreshPRMetadataIfPRAdvanced(result.prHead);
      }

      return result;
    } catch {
      // Fail silently — staleness badge is best-effort
      return null;
    }
  }

  /**
   * Monotonic stamp for PR-HEAD answers.
   *
   * TWO unawaited paths end in `_applyPRHeadStaleState` writing the PR-side
   * badges — the on-load `_checkLocalStalenessOnLoad` (whose promise is parked
   * on `_stalenessPromise`) and `_recheckPRHeadState`. The refresh button
   * re-enables in `refreshDiff`'s `finally`, which runs before the recheck it
   * fired has settled, so a second refresh can start with the first recheck
   * still outstanding. Without a stamp, whichever RESPONSE landed last won the
   * badge and the chat snapshot, regardless of which REQUEST was newer — and
   * the failure is invisible when it happens.
   *
   * A counter rather than an AbortController because the requests are already
   * bounded (`STALE_TIMEOUT`) and cheap; what matters is not spending the
   * answer, it is not APPLYING a superseded one.
   *
   * ONE COUNTER PER DOMAIN — see `_nextWorkingTreeCheckGeneration`.
   *
   * @returns {number} the stamp this caller must present when applying.
   */
  _nextPRHeadCheckGeneration() {
    this._prHeadCheckGeneration = (this._prHeadCheckGeneration || 0) + 1;
    return this._prHeadCheckGeneration;
  }

  /**
   * Monotonic stamp for WORKING-TREE answers, deliberately separate from the
   * PR-head one above.
   *
   * A single shared counter made every `?prHeadOnly=1` recheck supersede the
   * working-tree half of an on-load check that was still parked — and that
   * request never asks about the working tree (it answers `isStale: null`,
   * "not asked") and cannot recapture it, so it has no standing to cancel
   * anything on that side. The path that produced it is routine: a late
   * association resolves, `_refreshPRMetadata` fires `_recheckPRHeadState`,
   * and the on-load check's `isStale: true` is discarded before it can show
   * STALE, notify chat, or silently refresh an empty session. Nothing later
   * restores those effects.
   *
   * So only something that genuinely invalidates a working-tree answer bumps
   * this: a newer full check, or a refresh (`refreshDiff`, which recaptures
   * the tree and rebaselines the digest the answer was compared against).
   *
   * @returns {number} the stamp this caller must present when applying.
   */
  _nextWorkingTreeCheckGeneration() {
    this._workingTreeCheckGeneration = (this._workingTreeCheckGeneration || 0) + 1;
    return this._workingTreeCheckGeneration;
  }

  /**
   * Badges + chat notification for the associated PR's state.
   *
   * Called on EVERY branch of the staleness check, including `isStale === true`.
   * That is safe — and correct — only because the header renders a badge GROUP
   * (see `_showStaleBadge` in public/js/pr.js): the PR-side facts live in their
   * own slots and cannot overwrite the actionable STALE badge. While one shared
   * element was in play this method carried an unwritten precondition that only
   * one of its callers enforced.
   *
   * Driven entirely by `result.prHead`, never by a capability check: the
   * backend already returns `prHead: null` when it did not (or could not)
   * look — no association, no credential, ambiguous host. A second gate here
   * could only disagree with the answer we were given.
   *
   * `prHead.error` (a fetch that was attempted and failed) is treated as
   * "we do not know", not as "no drift": showing nothing beats showing a
   * badge derived from a null `remoteHeadSha`, and an unknown must not clear a
   * badge a KNOWN answer put up.
   *
   * @param {Object} result - check-stale response body.
   * @param {number} abbrevLen - SHA abbreviation length for this review.
   * @param {Object} [options]
   * @param {string} [options.preface=''] - Text to prepend to the chat
   *   notification. `queueDiffStateNotification` REPLACES the stored snapshot
   *   rather than appending, so a caller that already queued something must
   *   hand it over here or lose it.
   * @param {string|null} [options.workingTreeNote=null] - Overrides the
   *   sentence derived from `result.isStale`. For callers that know something
   *   the response does not — the post-refresh recheck asks `prHeadOnly`, so
   *   its `isStale: null` means "not asked", not "unknown".
   * @param {number|null} [options.generation=null] - Stamp from
   *   `_nextPRHeadCheckGeneration`. A superseded answer applies nothing.
   */
  _applyPRHeadStaleState(result, abbrevLen, { preface = '', workingTreeNote = null, generation = null } = {}) {
    const manager = window.prManager;
    if (!manager) return;
    if (generation !== null && generation !== this._prHeadCheckGeneration) return;

    const prHead = result?.prHead;
    if (!prHead || prHead.error) return;

    // The tooltip explains every condition the backend reported, in its own
    // words, so the badge never has to guess at the wording.
    const reasonText = LocalManager.formatStaleReasons(result.reasons);

    // Lifecycle slot, write-back included, through the ONE implementation both
    // modes share (`PRManager._applyPRLifecycleBadge`). This response is the
    // FRESHEST lifecycle answer local mode gets — fresher than the `pr_metadata`
    // row `associatedPR` was built from — and the badge is no longer its only
    // reader: `PRManager.getPRLifecycle` feeds ReviewModal's allowed review
    // events off exactly these two fields, so a PR that merged since page load
    // has to take Approve away as well as raise the badge.
    //
    // This block used to be a hand-copied twin of the PR-mode sequence and had
    // already drifted from it (it converted an unreported `merged` to `false`
    // and cleared the badge on an unreported `state`). The reconciler owns all
    // of it now: which object to write, "unknown is not open", the MERGED /
    // CLOSED ordering, and the `updateSubmitAffordance` that follows.
    //
    // `prHead.error` is already refused above, so this only ever hands over an
    // answer the backend actually made.
    const lifecycle = PRManager.lifecycleFromStaleness(prHead);
    if (lifecycle) {
      manager._applyPRLifecycleBadge(lifecycle, reasonText || undefined);
    }

    // Commit-alignment slot, likewise self-healing: a "no longer drifted"
    // answer must be able to retract the badge an earlier one painted.
    //
    // `drifted` is TRI-STATE (see `respond` in src/routes/local.js): `null`
    // means one of the two SHAs was unknown, so the comparison was never made.
    // Only an explicit `false` retracts the badge — clearing on `null` let a
    // half-answered check erase a badge a fully-answered one put up, which is
    // the same "an unknown must not clear a known" rule `prHead.error` follows
    // above.
    if (prHead.drifted !== true) {
      if (prHead.drifted === false) manager._hideStaleBadge('drift');
      return;
    }

    const localSha = prHead.localHeadSha ? prHead.localHeadSha.substring(0, abbrevLen) : 'unknown';
    const prSha = prHead.remoteHeadSha ? prHead.remoteHeadSha.substring(0, abbrevLen) : 'unknown';
    const shaDetail = `Local HEAD ${localSha}, PR #${prHead.prNumber} head ${prSha}.`;
    manager._showStaleBadge('pr-drift', reasonText ? `${reasonText} ${shaDetail}` : shaDetail);

    if (window.chatPanel) {
      // ChatPanel keeps ONE diff-state snapshot, not a queue —
      // queueDiffStateNotification REPLACES the stored string. Everything this
      // call would otherwise erase is therefore restated here: `preface` for
      // whatever the caller queued, `headChangeNote` for the local-HEAD move,
      // and the working-tree sentence below.
      //
      // Distinct from the `headShaChanged` message, which says the LOCAL head
      // moved since we captured the diff. This one says local and PR heads are
      // different commits — a different fact, deliberately worded so the two
      // cannot be read as contradicting each other.
      const headChangeNote = result.headShaChanged
        ? `HEAD SHA changed (${result.previousHeadSha ? result.previousHeadSha.substring(0, abbrevLen) : 'unknown'} → ${result.currentHeadSha ? result.currentHeadSha.substring(0, abbrevLen) : 'unknown'}). The branch may have been rebased. `
        : '';
      // This string is fed to the AI agent as fact, so it may only assert what
      // somebody actually answered. `result.isStale` carries three of those
      // answers — `false` is a positive "the working tree matches the captured
      // diff", `true` is the opposite and must not be reported as unknown, and
      // `null` from a FULL check is genuinely "could not determine" (no stored
      // diff data, or the handler threw).
      //
      // `prHeadOnly: true` is the fourth case and is NOT any of those: that
      // request never asked, so its `isStale: null` is no evidence at all.
      // Answering it as "could not be determined" overwrote a known working-tree
      // fact with a false unknown — the chat panel keeps ONE snapshot per tab,
      // so the drift message REPLACES whatever the full check (or a refresh that
      // just recaptured the tree) had already established. It composes the
      // remembered statement instead, and omits the clause entirely when there
      // is nothing to remember yet.
      //
      // The push-or-pull half holds in every case — no working-tree refresh can
      // move the PR's head commit.
      let treeNote = workingTreeNote;
      if (typeof treeNote !== 'string') {
        treeNote = result.prHeadOnly === true
          ? this._workingTreeNote
          : LocalManager.workingTreeNoteFor(result.isStale);
      }
      const treeClause = treeNote ? `${treeNote} — ` : '';
      window.chatPanel.queueDiffStateNotification(
        `${preface}${headChangeNote}PR #${prHead.prNumber} head differs from local HEAD (local ${localSha}, PR ${prSha}). `
        + `${treeClause}push or pull so the two agree.`
      );
    }
  }

  /**
   * Re-read PR metadata when the backend reports our cached `head_sha` is
   * behind the PR's real head (`prHead.prAdvanced`).
   *
   * Phase 2's anchor-trust gate compares local HEAD against the `head_sha` in
   * the TTL-less `pr_metadata` cache, so a PR that advances mid-session leaves
   * that comparison answering about a commit that is no longer the PR head.
   * Reuses `_refreshPRMetadata({force:true})` — the single apply block that
   * updates capabilities, `associatedPR`, the header pill and the external
   * comment overlay — rather than adding a second refresh implementation.
   *
   * Respects the warm-up hold the same way `_applyRefreshedDiff` does: acquire
   * it so a concurrent `_maybeWarmPRMetadata` cannot start a duplicate fetch,
   * but run regardless of whether we won it (a forced read is not subject to
   * the cold-cache retry budget, which exists for unforced warm-ups).
   *
   * Running without the hold means a forced read can OVERLAP an unforced
   * warm-up that started earlier. `_refreshPRMetadata` settles that with a
   * generation stamp: the newest request's answer wins whatever order the two
   * responses arrive in, so an older warm-up can no longer revert the
   * `head_sha` this read exists to bring forward.
   *
   * @param {Object|null} prHead - `prHead` from the check-stale response.
   * @returns {Promise<void>}
   */
  async _refreshPRMetadataIfPRAdvanced(prHead) {
    if (!prHead || prHead.error) return;
    // NO CAPABILITY GATE HERE — deliberately, and this is the same argument
    // `_applyPRHeadStaleState` makes. `prAdvanced === true` IS the backend's
    // statement that it reached GitHub, compared the PR's real head against our
    // cached `head_sha`, and found the cache behind. Reaching GitHub already
    // required the association and a usable credential, so the flag can only
    // ever agree — except when it is WRONG, and then it is wrong in the
    // direction that hurts. `this.capabilities` is a page-load snapshot: on a
    // dirty tree the association is backfilled AFTER the page-load GET
    // responded, so `canCheckStaleVsPR` is false while check-stale happily
    // resolves the association and reports `prAdvanced: true`. Gating here
    // skipped the forced re-read, leaving the TTL-less `pr_metadata.head_sha`
    // behind — and that value is one operand of the anchor-trust gate, so
    // external comments kept anchoring against a commit that is no longer the
    // PR head. Nothing else re-fires it (`_maybeWarmPRMetadata` bails once
    // `canShowPRMetadata` is true, and never asks for `?refresh=1`).
    // A stale snapshot must not be allowed to veto a fresher answer.
    if (prHead.prAdvanced !== true) return;

    const hold = this._acquirePRMetadataWarmHold();
    try {
      await this._refreshPRMetadata({ force: true });
    } finally {
      this._releasePRMetadataWarmHold(hold);
    }
  }

  /**
   * Re-ask the backend about the associated PR's head after a refresh, and
   * re-apply the PR-side badge if drift is still true.
   *
   * DELIBERATELY NOT `_checkLocalStalenessOnLoad`
   * ---------------------------------------------
   * That method can call `refreshDiff({ silent: true })`, which re-enters
   * `_applyRefreshedDiff`, which is what calls this — an unbounded loop. This
   * method touches ONLY `_applyPRHeadStaleState` and the `prAdvanced`
   * convergence: no working-tree branch, no `_hasActiveSessionData`, and above
   * all no `refreshDiff`.
   *
   * It also re-fetches rather than recomputing drift from `manager.currentPR`
   * and the freshly-refreshed local HEAD. The backend already owns that
   * comparison (`prHead.drifted`), and a second client-side implementation of
   * the same predicate is exactly the duplication that lets the two answers
   * drift apart. One `prHeadOnly` GET per refresh buys a single source of
   * truth — and `prHeadOnly` is what keeps that GET from re-walking the whole
   * working tree for a digest this method never reads.
   *
   * Also the recovery path for a LATE association: on a dirty tree the review
   * row carries no `associated_pr_*` at page load, so the on-load check can
   * answer `prHead: null` and nothing would ever ask again. `_refreshPRMetadata`
   * calls this the moment the association appears.
   *
   * @param {Object} [options] - Forwarded to `_applyPRHeadStaleState`; see
   *   `preface` / `workingTreeNote` there.
   * @returns {Promise<void>} Never rejects — the badge is best-effort.
   */
  async _recheckPRHeadState({ preface = '', workingTreeNote = null } = {}) {
    // PR-head domain ONLY. This request does not ask about the working tree
    // and cannot recapture it, so it must not stamp that side — see
    // `_nextWorkingTreeCheckGeneration`.
    const generation = this._nextPRHeadCheckGeneration();
    try {
      const result = await this._fetchLocalStaleness({ prHeadOnly: true });
      if (!result) return;
      const abbrevLen = this.localData?.shaAbbrevLength || 7;
      this._applyPRHeadStaleState(result, abbrevLen, { preface, workingTreeNote, generation });
      // Badges are not the whole job. `prAdvanced` says the TTL-less
      // `pr_metadata.head_sha` is behind the PR's real head, and that value is
      // one operand of the anchor-trust gate — so a recheck that reports it
      // must drive the same convergence the on-load check drives, or a session
      // that gained its association late keeps anchoring external comments
      // against a commit that is no longer the PR head until a manual refresh.
      // (A late association resolved from an existing-but-stale `pr_metadata`
      // row is exactly that case: the on-load check saw no association, so it
      // never got to ask.) Bounded: `_refreshPRMetadata({force:true})` can only
      // re-fire this method on a false -> true `hasAssociatedPR` transition,
      // which the apply block it just ran has already made true.
      void this._refreshPRMetadataIfPRAdvanced(result.prHead);
    } catch {
      // Best-effort: a failed recheck leaves the badge hidden, which is the
      // pre-fix behaviour rather than a new failure mode.
    }
  }

  /**
   * The sentence a FULL check's `isStale` earns.
   *
   * Only ever fed `isStale` from a request that actually walked the working
   * tree — `?prHeadOnly=1` answers `null` without asking, and that is not an
   * input to this function. See `_workingTreeNote`.
   *
   * @param {boolean|null|undefined} isStale
   * @returns {string} one of the three note constants
   */
  static workingTreeNoteFor(isStale) {
    if (isStale === false) return TREE_CURRENT_NOTE;
    if (isStale === true) return TREE_CHANGED_NOTE;
    return TREE_UNKNOWN_NOTE;
  }

  /**
   * Join the backend's `reasons[]` messages into one tooltip string.
   *
   * Delegates to `PRManager.formatStaleReasons`, which is where the renderer
   * lives so PR mode can reach it too — only pr.js is loaded by both pages.
   * Kept here as the local-mode entry point.
   *
   * @param {Array<{code: string, message: string}>} reasons
   * @returns {string} Joined messages, or '' when there are none.
   */
  static formatStaleReasons(reasons) {
    return PRManager.formatStaleReasons(reasons);
  }

  /**
   * Fetch staleness data from the local review endpoint with a timeout.
   * Uses GET to check the local review staleness endpoint.
   *
   * @param {Object} [options]
   * @param {boolean} [options.prHeadOnly=false] - Ask the backend to skip the
   *   working-tree digest and answer about the associated PR's head only. For
   *   callers that read `prHead` and nothing else; the response carries
   *   `isStale: null`, meaning "not asked". See the route's docblock in
   *   src/routes/local.js.
   * @returns {Promise<Object|null>} The parsed staleness result, or null on failure/timeout.
   */
  async _fetchLocalStaleness({ prHeadOnly = false } = {}) {
    try {
      const staleAbort = new AbortController();
      const staleTimer = setTimeout(() => staleAbort.abort(), STALE_TIMEOUT);
      const response = await fetch(
        `/api/local/${this.reviewId}/check-stale${prHeadOnly ? '?prHeadOnly=1' : ''}`,
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

      // Capability flags from the backend — single source of truth for
      // gating PR-only features in local mode. DO NOT mode-sniff via
      // window.location.pathname; use hasCapability() instead.
      //
      // Also push the capability surface onto PRManager so shared
      // components (SplitButton, PreviewModal, AIPanel, etc.) can call
      // `window.prManager.hasCapability(...)` in either mode without
      // knowing which manager they're attached to.
      this.capabilities = reviewData.capabilities || {
        hasAssociatedPR: false,
        hasGitHubToken: false,
        canShowPRMetadata: false,
        canViewPRComments: false,
        canCheckStaleVsPR: false,
        canSyncDrafts: false,
        canSubmitToGitHub: false
      };
      if (manager) {
        manager.capabilities = this.capabilities;
      }

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
        stack_data: reviewData.stackData || null,
        // Mirror the association, not just the capability flags, so shared
        // code can answer PR-shaped questions without knowing which manager it
        // is attached to — `_externalAnchorContext` reads it.
        associatedPR: reviewData.associatedPR || null,
        // The associated PR's canonical page, under the key PR mode uses.
        //
        // Phase 5 made `ReviewModal.resolveDraftPrUrl` reachable from local
        // mode, and its middle tier — "the PR's own `html_url`" — was
        // STRUCTURALLY unreachable here, because nothing ever wrote that key on
        // this synthetic object. An alt-host draft submit therefore fell
        // through to the response's `github_url`, which some hosts return as a
        // github.com `/issues/<n>` URL: wrong host, wrong page. The tier-1
        // template is not a general cover either — it is null unless a repo has
        // `links.external.url_template` configured.
        //
        // The correct value was already in hand under a different name:
        // `associatedPR.url`, mapped from the host API in
        // src/providers/pr-context.js and already the PR pill's href. Flatten
        // it rather than teaching the shared modal about local mode. Kept in
        // step with `associatedPR` in `_refreshPRMetadata`'s apply block.
        html_url: reviewData.associatedPR?.url || null
      };

      this._applyLeftAnchorInputs(reviewData);

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
          // Diff view (Unified / Split) — the handler lives on PRManager and is
          // shared with PR mode (no re-fetch, so local mode needs no override).
          onDiffViewChange: (mode) => manager.handleDiffViewChange(mode),
          diffView: window.readPersistedDiffView
            ? window.readPersistedDiffView()
            : (localStorage.getItem('pair-review-diff-view') === 'split' ? 'split' : 'unified'),
          // Match PR mode: only offer the control when the Pierre render path
          // can apply the swap (see pr.js construction site).
          diffViewAvailable: Boolean(manager.pierreBridge && !manager.pierreBridge._disabled),
          initialScope: { start: scopeStart, end: scopeEnd },
          branchAvailable
        });
      }

      // Update header with local info
      this.updateLocalHeader(reviewData);

      // Apply per-repo header link customisation (Phase 7: alt-host support).
      this._applyRepoLinks(reviewData);

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

      // Must run AFTER the AI panel exists (above) — it is what gets toggled.
      // PR mode calls the same PRManager method from loadPR.
      manager._updateExternalCommentsAffordances();

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

      // Fire-and-forget, last, so the diff and user comments already own their
      // DOM anchors — same contract as PR mode's tail call in loadPR.
      void this._renderExternalComments({ sync: true });

      // Phase 4, also fire-and-forget: PR mode learns about a pending draft
      // inside its page-load GET, but the local GET must never block on a
      // GitHub round-trip, so the client asks for itself. No-op when the
      // capability is off; `_refreshPRMetadata` retries after a late flip.
      void this._maybeAutoSyncGitHubDrafts();

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

    // Phase 1: associated PR pill — only when the backend says this local
    // review has reachable PR metadata. Read the capability flag, not
    // mode/path. When the flag is off the pill stays hidden even if
    // associatedPR is populated; on a cold cache the renderer asks the
    // blocking /pr-metadata endpoint once and re-renders itself.
    this.renderAssociatedPRPill(reviewData);

    // Phase 4: the draft-sync button lives in the toolbar, not the pill, but
    // it is gated on the same association — render both from one place so a
    // capability change can never move one without the other.
    this._updateDraftSyncAffordance();

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
   * Render the associated-PR pill in the local header. Gated on
   * `canShowPRMetadata` so the pill stays hidden when the metadata cache is
   * cold, even though `associatedPR` may already be set.
   *
   * Hiding relies on the `hidden` attribute, which only works because
   * `.local-header-info .info-item[hidden] { display: none }` in
   * public/local.html overrides the sibling `display: flex` — an author-origin
   * `display` always beats the UA's `[hidden]` rule, so without that override
   * this early return is a no-op and an empty pill renders for every review.
   *
   * Cold cache: `GET /api/local/:reviewId` reads metadata from cache only and
   * never blocks on GitHub, so a first load can arrive with the flag off. Ask
   * the blocking endpoint — nothing else re-renders this header in-session
   * (no poll; `refreshDiff` only touches diff/stats), so otherwise the pill
   * would not appear until a full page reload. `_maybeWarmPRMetadata` owns the
   * retry budget; calling it on every hidden render is intentional and bounded.
   *
   * @param {Object} reviewData - response body from GET /api/local/:reviewId
   */
  renderAssociatedPRPill(reviewData) {
    const container = document.getElementById('local-pr-info');
    if (!container) return;

    if (!this.hasCapability('canShowPRMetadata') || !reviewData.associatedPR) {
      container.setAttribute('hidden', '');
      this._maybeWarmPRMetadata();
      return;
    }

    const pr = reviewData.associatedPR;
    const link = document.getElementById('local-pr-link');
    const numberEl = document.getElementById('local-pr-number');
    const titleEl = document.getElementById('local-pr-title');
    const authorEl = document.getElementById('local-pr-author');

    // GitHub's `state` is only 'open' or 'closed'; `merged` is a separate
    // boolean. Derive the display value here rather than storing a fabricated
    // state — `pr_data.state` is shared with PR mode and the AI chat context.
    // Used for BOTH the class and the tooltip, or a merged PR would get
    // merged-purple styling with a '(closed)' label.
    const displayState = pr.merged ? 'merged' : pr.state;

    if (numberEl) numberEl.textContent = `#${pr.prNumber}`;
    if (titleEl) titleEl.textContent = pr.title || '';
    if (authorEl) authorEl.textContent = pr.author ? `by ${pr.author}` : '';
    if (link) {
      const parts = (pr.repository || '').split('/');
      const fallback = parts.length === 2
        ? `https://github.com/${parts[0]}/${parts[1]}/pull/${pr.prNumber}`
        : '#';
      link.href = pr.url || fallback;
      const tooltipParts = [pr.title, pr.author ? `by ${pr.author}` : null, displayState ? `(${displayState})` : null].filter(Boolean);
      link.title = tooltipParts.join(' ') || `View PR #${pr.prNumber} on GitHub`;
      link.classList.remove('state-open', 'state-closed', 'state-merged');
      if (displayState) link.classList.add(`state-${displayState.toLowerCase()}`);
    }

    container.removeAttribute('hidden');
  }

  /**
   * Warm-up for the associated-PR pill when it is hidden ONLY because the
   * metadata cache is cold: the backend knows about the PR and has a
   * credential, but `GET /api/local/:reviewId` returned before the write-through
   * landed. Hits the blocking `/pr-metadata` endpoint and re-renders the header
   * alone — never the diff or comments.
   *
   * Retry policy — two guards, doing different jobs:
   *
   *   `_prMetadataWarmHolder` is an IN-FLIGHT hold, not a one-shot. It was
   *   one-shot, which meant a single failed warm (network blip, or the loser of
   *   a concurrent-write race answering `canShowPRMetadata: false`) cost the
   *   pill for the entire page session — precisely the guarantee this endpoint
   *   exists to provide, failing on the first load of a cold review. It is now
   *   released again whenever the attempt failed in a way a later legitimate
   *   trigger could recover from.
   *
   *   `_prMetadataWarmAttempts` is the hard budget that keeps that release from
   *   becoming a spin: a permanently-failing PR gets at most
   *   MAX_PR_METADATA_WARM_ATTEMPTS calls per page load, no matter how often
   *   the header re-renders. The server's five-minute negative cache makes
   *   those few retries cheap (it answers from cache without calling GitHub).
   *
   * The hold is released on `metadataReady` ALONE — never on the broader
   * `progressed`; see `_refreshPRMetadata` for what went wrong when it did.
   *
   * The release happens in `finally`, AFTER the re-render below. That ordering
   * is load-bearing: `renderAssociatedPRPill` calls back into this method when
   * the pill stays hidden, so releasing the hold first would recurse straight
   * into another fetch.
   *
   * @returns {Promise<void>}
   */
  async _maybeWarmPRMetadata() {
    if (this._prMetadataWarmHolder) return;
    // No credential means the endpoint genuinely has nothing to add.
    //
    // A missing ASSOCIATION deliberately does NOT disqualify the call. On a
    // dirty tree the backend writes the association from a backfill that fires
    // AFTER the GET responded, so the client renders with
    // `hasAssociatedPR: false` — and guarding this call on that very flag was
    // a self-sustaining deadlock the user could only escape by reloading.
    // `/pr-metadata` now runs detection server-side, so this call breaks it.
    if (!this.hasCapability('hasGitHubToken')) return;
    if (this.hasCapability('canShowPRMetadata')) return;
    const attempts = this._prMetadataWarmAttempts || 0;
    if (attempts >= LocalManager.MAX_PR_METADATA_WARM_ATTEMPTS) return;
    const hold = this._acquirePRMetadataWarmHold();
    // Lost the race against another warm-up between the guard above and here.
    if (!hold) return;
    this._prMetadataWarmAttempts = attempts + 1;

    let metadataReady = false;
    try {
      const outcome = await this._refreshPRMetadata();
      metadataReady = Boolean(outcome && outcome.metadataReady);
    } finally {
      // Released whenever the pill still cannot render, so a later legitimate
      // trigger can retry within the budget above. Ordering is load-bearing —
      // see the docblock.
      if (!metadataReady) this._releasePRMetadataWarmHold(hold);
    }
  }

  /**
   * @returns {Object|null} Hold token for `_releasePRMetadataWarmHold`, or
   *   null when another path holds it — then the caller owes no release.
   */
  _acquirePRMetadataWarmHold() {
    if (this._prMetadataWarmHolder) return null;
    this._prMetadataWarmHolder = { held: true };
    return this._prMetadataWarmHolder;
  }

  /** No-op unless `token` is the hold in effect — see `_acquirePRMetadataWarmHold`. */
  _releasePRMetadataWarmHold(token) {
    if (token && this._prMetadataWarmHolder === token) {
      this._prMetadataWarmHolder = null;
    }
  }

  /**
   * Fetch `/api/local/:reviewId/pr-metadata` and apply the response to every
   * mirror that depends on it.
   *
   * Two callers, one apply block on purpose — `_maybeWarmPRMetadata` (cold
   * cache / association backfill) and the forced re-read that
   * `_applyRefreshedDiff` and the External-segment refresh button drive.
   *
   * @param {Object} [options]
   * @param {boolean} [options.force=false] - Ask the backend to skip its
   *   metadata cache (`?refresh=1`) and re-fetch from GitHub. The cache has no
   *   TTL, so this is the only way a PR head that advanced upstream (a push)
   *   ever reaches `_externalAnchorContext`.
   * @returns {Promise<{metadataReady: boolean, progressed: boolean}>} Two
   *   deliberately separate answers:
   *   - `metadataReady`: the header pill can render. The ONLY input to the
   *     warm-up hold in `_maybeWarmPRMetadata`. Overloading it with
   *     `progressed` cost the pill its retry budget — `canViewPRComments` is
   *     true even when GitHub 5xx'd and metadata is null, so the warm-up
   *     latched on a call that fetched nothing.
   *   - `progressed`: the call moved *something* forward (metadata, comment
   *     viewing, or a newly-resolved association). Never latches the pill.
   *   Both false on any failure and on a 200 that changed nothing.
   */
  async _refreshPRMetadata({ force = false } = {}) {
    // A fresh object per return: callers must never share (or be able to
    // mutate) another caller's outcome.
    const noProgress = () => ({ metadataReady: false, progressed: false });

    // Ordering stamp. A FORCED read (`?refresh=1`, driven by a refresh or by
    // `prAdvanced`) is deliberately allowed to run while an unforced warm-up is
    // still in flight — see `_refreshPRMetadataIfPRAdvanced` — so two responses
    // can be outstanding at once, and this apply block writes `associatedPR`
    // (head_sha included), the header pill and the external-comment overlay.
    // If the older warm-up landed last it reverted the head_sha the forced read
    // was issued to bring forward — and that field is one operand of the
    // anchor-trust gate. Newest answer wins, regardless of arrival order.
    const generation = (this._prMetadataGeneration = (this._prMetadataGeneration || 0) + 1);

    // Both captured before the merge below, because the TRANSITIONS matter: a
    // newly-resolved association counts as progress even with no metadata, and
    // a false -> true on canViewPRComments decides GET vs SYNC.
    const hadAssociation = this.hasCapability('hasAssociatedPR');
    const hadViewPRComments = this.hasCapability('canViewPRComments');
    const hadSyncDrafts = this.hasCapability('canSyncDrafts');

    try {
      const url = `/api/local/${this.reviewId}/pr-metadata${force ? '?refresh=1' : ''}`;
      const response = await fetch(url);
      if (!response.ok) return noProgress();
      const data = await response.json();
      if (!data || !data.capabilities) return noProgress();
      // Superseded: a newer read has already applied its answer. Reporting no
      // progress is also correct for `_maybeWarmPRMetadata`'s retry budget —
      // this call contributed nothing, and the newer one reported for itself.
      if (generation !== this._prMetadataGeneration) return noProgress();

      // MERGE, never overwrite. _applyScopeResult mutates this.localData in
      // place, so a scope change made while this request was in flight would
      // be silently reverted by a wholesale assignment.
      this.capabilities = { ...(this.capabilities || {}), ...data.capabilities };
      if (this.localData) {
        this.localData.capabilities = this.capabilities;
        // A null association in the response means "could not resolve one",
        // not "there is none" — keep whatever we already had.
        this.localData.associatedPR = data.associatedPR || this.localData.associatedPR || null;
      }
      const manager = window.prManager;
      if (manager) {
        manager.capabilities = this.capabilities;
        // The one path that changes the anchor-trust answer mid-session: it
        // brings the PR's `head_sha` back (and moves it forward after a push),
        // and `_externalAnchorContext` degrades every thread to file level
        // while that is unknown.
        if (manager.currentPR) {
          manager.currentPR.associatedPR = data.associatedPR || manager.currentPR.associatedPR || null;
          // Kept in step with the flattened key `loadLocalReview` writes, or a
          // late association would leave `html_url` null and send an alt-host
          // draft submit to the wrong host — see the docblock there.
          manager.currentPR.html_url = manager.currentPR.associatedPR?.url || null;
        }
        manager._updateExternalCommentsAffordances?.();
      }

      // The External segment just switched on: this call is the ONLY thing
      // that can flip `canViewPRComments` mid-session.
      const gainedPRComments = !hadViewPRComments && Boolean(this.capabilities.canViewPRComments);
      const gainedAssociation = !hadAssociation && Boolean(this.capabilities.hasAssociatedPR);
      // Tracked separately from `gainedPRComments` even though the two flags
      // share their inputs today: they are independent contracts, and one of
      // them changing shape must not silently take the other's affordance
      // with it.
      const gainedSyncDrafts = !hadSyncDrafts && Boolean(this.capabilities.canSyncDrafts);

      // Header only — this.localData may have moved on, so render from it
      // rather than from the response body.
      this.renderAssociatedPRPill(this.localData || data);
      // Cheap and idempotent (signature-guarded): a late association changes
      // the link context from "this checkout" to "this pull request", and the
      // draft indicator resolves its URL from that context.
      this._applyRepoLinks(this.localData || data);
      // Unconditional, and NOT folded into `gainedSyncDrafts`: the capability
      // can go false as well as true (an association cleared by a force-push
      // to unrelated history), and the button has to retract for that too.
      this._updateDraftSyncAffordance();

      // Phase 5, and unconditional for the same reason as the call above: the
      // Submit capability can go false as well as true (an association cleared
      // by a force-push to unrelated history), and a stale Submit control
      // POSTs a review to a PR this session is no longer tied to.
      //
      // NOT `initSplitButton()`. That zero-argument constructor path cannot
      // carry state across a rebuild: it re-ran `loadSavedAction()` and could
      // promote the primary action from Preview to Submit as association
      // metadata arrived, and it destroyed an open dropdown. It also reached
      // only the toolbar, leaving an open Preview or Review modal on the
      // answer it was opened with. `updateSubmitAffordance` mutates all three
      // in place — see public/js/pr.js.
      manager?.updateSubmitAffordance?.();

      // Fire-and-forget: never let an external-comment re-render delay or fail
      // the metadata read it is piggy-backing on.
      //
      // SYNC vs GET turns on that transition, and only on it. A GET renders
      // the `external_comments` mirror table, which on a first-ever load has
      // never been populated — so a late capability flip (dirty tree, PR
      // resolved by the post-response backfill, the tail sync in
      // `loadLocalReview` already bailed) would reveal the External segment
      // and draw it EMPTY. Syncing unconditionally instead would POST on every
      // ordinary warm metadata refresh.
      //
      // Overlap is safe: the manager's `syncAndRender` in-flight guard makes a
      // concurrent sync join the same promise.
      void this._renderExternalComments({ sync: gainedPRComments });

      // A LATE association is the only way the PR-side badges ever get a
      // second chance. `startPRHeadCheck` reads the persisted
      // `associated_pr_*` columns once per request, and on a dirty tree those
      // columns are empty when `_checkLocalStalenessOnLoad` runs — detection is
      // asynchronous and this endpoint is what lands it. Without this the
      // session shows no PR DRIFT / MERGED / CLOSED badge and never re-drives
      // `prAdvanced` at all, unless the user happens to press Refresh. Routed
      // through the guarded recheck, which never re-enters the refresh path.
      if (gainedAssociation) void this._recheckPRHeadState();

      // A LATE flip is also the only chance the automatic draft sync gets: the
      // tail call in `loadLocalReview` ran while the capability was still
      // false and did nothing. Silent, like that one — the user did not ask.
      if (gainedSyncDrafts) void this._maybeAutoSyncGitHubDrafts();

      return {
        metadataReady: Boolean(this.capabilities.canShowPRMetadata),
        progressed: Boolean(
          this.capabilities.canShowPRMetadata
          || gainedPRComments
          || gainedAssociation
        )
      };
    } catch (error) {
      console.warn('PR metadata refresh failed:', error);
      return noProgress();
    }
  }

  /**
   * Restore all three overlay layers onto a freshly-rebuilt diff DOM.
   *
   * `PRManager.renderDiff` empties `#diff-container` and restores nothing, so
   * every path that rebuilds the diff owes the user their draft comments, AI
   * suggestion rows and the PR's comment rows back. Local mode's counterpart
   * to `PRManager._rerenderAllOverlays`, and it exists for the same reason:
   * the sequence had been hand-copied at four call sites and drifted.
   *
   * `loadLocalReview`'s initial load is deliberately NOT routed through here —
   * it is a different sequence with setup interleaved between the steps.
   *
   * @param {Object} [options]
   * @param {boolean} [options.sync=false] - Fire the external-comments sync
   *   POST before re-rendering (the refresh path, where upstream may have
   *   moved too) rather than re-anchoring the existing local mirror.
   * @returns {Promise<void>}
   */
  async _rerenderLocalOverlays({ sync = false } = {}) {
    const manager = window.prManager;
    if (!manager) return;

    const includeDismissed = window.aiPanel?.showDismissedComments || false;
    await manager.loadUserComments(includeDismissed);
    // Note: Unlike loadLocalReview(), which skips this when
    // analysisHistoryManager exists (that manager fires loadAISuggestions from
    // onSelectionChange on init), a rebuild must call unconditionally — the
    // history manager will not re-fire its callback.
    await manager.loadAISuggestions(null, manager.selectedRunId);
    // Kept as a separate leg rather than inlined: `_renderExternalComments`
    // owns the capability + kill-switch guards for the ECM singleton.
    await this._renderExternalComments({ sync });
  }

  /**
   * Mirror the LEFT-side anchor inputs from a local API payload onto
   * `PRManager.currentPR`.
   *
   * `_externalAnchorContext` (pr.js) decides LEFT-side anchor trust from
   * `currentPR.localBaseSha` + `currentPR.scopeIncludesBranch` +
   * `associatedPR.base_sha`, so both fields must be refreshed at EVERY point
   * they can change — initial load, refresh, and scope change — and BEFORE the
   * overlay re-render, or the re-anchor runs against a stale policy.
   *
   * Both are normalised to null when absent: PR mode never sends them, and the
   * backend sends null when the scope excludes the branch. Leaving a stale
   * value behind would keep trusting a merge base the diff no longer shows.
   *
   * A FOURTH site writes `currentPR.localBaseSha` without going through here:
   * `_applyBaseOverrideLeftAnchor`. Any change to the normalisation here
   * belongs there too.
   *
   * @param {Object} [source] - A payload carrying `mergeBaseSha` /
   *   `scopeIncludesBranch` (GET /api/local/:reviewId, POST .../refresh, or
   *   POST .../set-scope).
   */
  _applyLeftAnchorInputs(source = {}) {
    const localBaseSha = source?.mergeBaseSha ?? null;
    const scopeIncludesBranch = source?.scopeIncludesBranch ?? null;

    if (this.localData) {
      this.localData.mergeBaseSha = localBaseSha;
      this.localData.scopeIncludesBranch = scopeIncludesBranch;
    }

    const manager = window.prManager;
    if (manager?.currentPR) {
      manager.currentPR.localBaseSha = localBaseSha;
      manager.currentPR.scopeIncludesBranch = scopeIncludesBranch;
    }
  }

  /**
   * Re-derive the LEFT-side merge-base anchor input after the base-branch
   * selector changed `currentBaseOverride`.
   *
   * An override rebuilds the diff against a DIFFERENT base, and
   * `GET /api/local/:reviewId/diff?base=` returns no `mergeBaseSha` for it, so
   * the left column's sha genuinely becomes unknown. Keeping the load-time
   * merge base would leave `trustLeftAnchors` true for what is now another
   * coordinate system — the "line found, wrong content" case that gate exists
   * to prevent. Unknown degrades those threads to the file zone: fail safe.
   *
   * Clearing the override restores from `localData.mergeBaseSha`, which IS the
   * default diff's merge base — hence this writes only the PRManager mirror
   * and leaves `localData` alone. `scopeIncludesBranch` is untouched: an
   * override changes which base the branch is diffed against, not whether the
   * scope includes the branch.
   *
   * @param {Object} manager - window.prManager (already resolved by the caller)
   */
  _applyBaseOverrideLeftAnchor(manager) {
    if (!manager?.currentPR) return;
    manager.currentPR.localBaseSha = manager.currentBaseOverride
      ? null
      : (this.localData?.mergeBaseSha ?? null);
  }

  /**
   * Fetch and apply this review's per-repo header links, and remember the
   * substitution context every other link reader resolves against.
   *
   * Local mode used to pass the CHECKOUT's `owner/repo` and deliberately no
   * `{number}` — there was no PR to name. With an associated PR there is, and
   * three things depend on it:
   *
   *   - the server resolves a DUAL-host repo's link set per PR (`?number=`),
   *     so without it a dual repo answers with the repository-level default
   *     and `RepoLinks.hostName()` can name the wrong host;
   *   - a `url_template` that names `{number}` only substitutes when the
   *     number is present — otherwise it is dropped;
   *   - `RepoLinks.draftUrl`, shared with PR mode, resolves the pending-draft
   *     link from that same template. Without `{number}` a template that does
   *     not name it resolves to the REPOSITORY, which is why local mode used
   *     to opt out of the configured URL entirely.
   *
   * The association's repository wins over the checkout's when both are
   * known: a fork (or a `url_pattern` monorepo entry) puts the PR somewhere
   * other than `origin`, and the links belong to wherever the PR lives.
   *
   * Called twice at most per page load: once from `loadLocalReview`, and
   * again from `_refreshPRMetadata` if the association resolved late (dirty
   * tree). The signature guard makes the second call free when nothing moved.
   *
   * @param {Object} [source] - A local review payload (`GET /api/local/:id`)
   *   or `this.localData` after a metadata refresh.
   * @returns {Promise<void>|null} resolves once the links have been applied,
   *   or null when there is nothing to fetch.
   */
  _applyRepoLinks(source) {
    if (!window.RepoLinks || typeof window.RepoLinks.fetchAndApplyRepoLinks !== 'function') return null;

    const data = source || {};
    const associated = data.associatedPR || null;
    const looksLikeRepo = (value) => typeof value === 'string' && value.includes('/');
    const repository = looksLikeRepo(associated?.repository)
      ? associated.repository
      : (looksLikeRepo(data.repository) ? data.repository : null);
    // Local sessions without a remote origin have no `repos` entry to resolve.
    if (!repository) return null;

    const [linkOwner, linkRepo] = repository.split('/');
    const context = {
      owner: linkOwner,
      repo: linkRepo,
      branch: data.branch,
      base_branch: data.baseBranch,
      head_sha: data.localHeadSha,
    };
    // Only when the association is USABLE — a template substituting a
    // half-known number would resolve to a stranger PR.
    if (associated && Number.isInteger(associated.prNumber)) context.number = associated.prNumber;

    const signature = `${repository}#${context.number ?? ''}`;
    if (this._repoLinksSignature === signature && this._repoLinksPromise) return this._repoLinksPromise;
    this._repoLinksSignature = signature;
    // Never rejects: a failed links fetch leaves the "GitHub" defaults in
    // place, and every reader falls back on its own.
    this._repoLinksPromise = Promise.resolve(
      window.RepoLinks.fetchAndApplyRepoLinks(linkOwner, linkRepo, context)
    ).catch((error) => { console.warn('Repo links refresh failed:', error); });
    return this._repoLinksPromise;
  }

  /**
   * Show or hide the "sync draft review from GitHub" button, and wire its
   * click handler exactly once.
   *
   * Re-reads `canSyncDrafts` on EVERY call and never latches a false answer —
   * the LATE FLIP half of the capability contract in `patchPRManager`. On a
   * dirty tree the association is written by a backfill that runs AFTER the
   * page-load GET responded, so the first render legitimately sees false.
   *
   * Toggles inline `display` rather than the `hidden` attribute: `.btn` sets
   * an author-origin `display`, which beats the UA `[hidden] { display: none }`
   * rule, so `hidden` alone would leave the button visible. Same collision the
   * PR pill's container documents in public/local.html.
   */
  _updateDraftSyncAffordance() {
    const btn = document.getElementById('local-sync-drafts-btn');
    if (!btn) return;

    if (!btn.dataset.listenerAttached) {
      btn.dataset.listenerAttached = 'true';
      btn.addEventListener('click', () => {
        void this._syncGitHubDrafts({ manual: true });
      });
    }

    const canSync = this.hasCapability('canSyncDrafts');
    // Retracting the button is not enough. The rendered indicator is removed
    // by exactly one call — `updatePendingDraftIndicator(null)` — and the sync
    // path can no longer make it: `_syncGitHubDrafts` bails on the lost
    // capability. Without this, an association cleared by a force-push leaves
    // a live "Draft on GitHub (N comments)" link to a draft on a PR this
    // session is no longer tied to, with the one control that could have
    // refreshed it just hidden. PR mode already clears both together after a
    // submission (ReviewModal.js).
    if (!canSync) {
      const manager = window.prManager;
      if (manager) {
        if (manager.currentPR) manager.currentPR.pendingDraft = null;
        manager.updatePendingDraftIndicator?.(null);
      }
    }
    btn.style.display = canSync ? '' : 'none';
  }

  /**
   * Phase 4 — pull the pending draft review started in the GitHub UI into this
   * local session and surface it in the toolbar.
   *
   * Reuses `PRManager.updatePendingDraftIndicator` rather than growing a
   * local-mode twin: local.html loads pr.css and has the `#toolbar-meta` /
   * `#pr-commit` anchors that method inserts against, so the indicator is
   * genuinely shared. `currentPR.pendingDraft` is written alongside it because
   * that is where every other reader looks (ReviewModal's draft notice).
   *
   * @param {Object} [options]
   * @param {boolean} [options.manual=false] - Driven by the button. Reports
   *   the outcome with a toast, and re-syncs the external comments: a draft
   *   that was SUBMITTED on GitHub since the page loaded stops being pending
   *   and its comments become visible to the ordinary comment sync, so the two
   *   answers belong to the same click. The automatic load-time call stays
   *   silent and skips that leg — `loadLocalReview` already syncs external
   *   comments on its own tail.
   * @returns {Promise<Object|null>} the pending draft, or null. A response
   *   carrying `syncSucceeded: false` (GitHub unreachable) changes NOTHING —
   *   the indicator, `currentPR.pendingDraft` and the return value all stay at
   *   what was last actually known.
   */
  async _syncGitHubDrafts({ manual = false } = {}) {
    if (!this.hasCapability('canSyncDrafts')) return null;

    // Join an in-flight sync instead of opening a second one — see
    // `_draftSyncPromise`. The joiner still gets the answer.
    if (this._draftSyncPromise) return this._draftSyncPromise;

    const run = (async () => {
      const btn = document.getElementById('local-sync-drafts-btn');
      if (btn) btn.disabled = true;
      try {
        const response = await fetch(`/api/local/${this.reviewId}/sync-drafts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        if (!response.ok) {
          let message = `Draft sync failed (${response.status})`;
          try {
            const errorData = await response.json();
            if (errorData && errorData.error) message = errorData.error;
          } catch {
            // Non-JSON error body — keep the status-derived message.
          }
          throw new Error(message);
        }

        const data = await response.json();
        const pendingDraft = data.pendingDraft || null;
        const manager = window.prManager;

        // The endpoint answers 200 with the LOCAL mirror when GitHub could not
        // be reached — draft state is supplementary and must not fail the
        // page. `pendingDraft: null` therefore means two different things, and
        // only one of them may clear a rendered indicator: telling the user
        // "no draft review on GitHub" because GitHub was unreachable, and
        // dropping the link to the draft they are in the middle of writing, is
        // strictly worse than saying nothing.
        if (data.syncSucceeded === false) {
          if (manual && window.toast) {
            window.toast.showWarning('Could not reach GitHub — draft status may be out of date');
          }
          return manager?.currentPR?.pendingDraft || null;
        }

        if (manager) {
          if (manager.currentPR) manager.currentPR.pendingDraft = pendingDraft;
          // Host-correct via `RepoLinks.draftUrl`; `_applyRepoLinks` has
          // already been given the association's `{number}`, so awaiting it
          // here is what keeps a late-resolved template from being missed.
          if (this._repoLinksPromise) {
            try { await this._repoLinksPromise; } catch { /* falls back to github_url */ }
          }
          manager.updatePendingDraftIndicator?.(pendingDraft);
        }

        if (manual) {
          if (window.toast) {
            if (pendingDraft) {
              const count = pendingDraft.comments_count || 0;
              window.toast.showSuccess(
                `Draft review synced (${count} comment${count === 1 ? '' : 's'})`
              );
            } else {
              window.toast.showInfo('No draft review on GitHub');
            }
          }
          // See the `manual` docblock: a draft submitted upstream turns into
          // ordinary review comments, so re-ask for those too.
          void this._renderExternalComments({ sync: true });
        }

        return pendingDraft;
      } catch (error) {
        console.warn('GitHub draft sync failed:', error);
        if (manual && window.toast) {
          window.toast.showError(`Failed to sync draft review: ${error.message}`);
        }
        return null;
      } finally {
        if (btn) btn.disabled = false;
      }
    })();

    this._draftSyncPromise = run;
    try {
      return await run;
    } finally {
      this._draftSyncPromise = null;
    }
  }

  /**
   * The one automatic draft sync per page load.
   *
   * Two callers with the same job and different timing: `loadLocalReview`'s
   * tail (warm association) and `_refreshPRMetadata`'s late flip (the
   * association only just resolved). Whichever gets there first spends the
   * budget; PR mode does the same fetch once inside its page-load GET.
   *
   * @returns {Promise<void>}
   */
  async _maybeAutoSyncGitHubDrafts() {
    if (this._draftSyncAutoDone) return;
    if (!this.hasCapability('canSyncDrafts')) return;
    this._draftSyncAutoDone = true;
    await this._syncGitHubDrafts();
  }

  /**
   * Render the associated PR's existing review comments into the local diff.
   *
   * Local mode's counterpart to `PRManager._rerenderAllOverlays`'s external
   * leg. Re-reads the capability on EVERY call and never latches — the LATE
   * FLIP half of the contract in `patchPRManager`.
   *
   * @param {Object} [options]
   * @param {boolean} [options.sync=false] - Sync from GitHub first (initial
   *   load, explicit refresh, and the late-flip call from
   *   `_refreshPRMetadata` — see there for why that one must sync). False for
   *   diff rebuilds, where only the anchors moved.
   * @returns {Promise<void>}
   */
  async _renderExternalComments({ sync = false } = {}) {
    const manager = window.prManager;
    if (!manager || typeof manager.hasCapability !== 'function') return;
    if (!manager.hasCapability('canViewPRComments')) return;
    if (!manager._externalCommentsEnabled?.()) return;
    if (typeof window === 'undefined' || !window.externalCommentManager) return;

    try {
      if (sync) {
        // Canonical entry point — owns the in-flight guard, the anchor
        // context, and the sync-result / error toasts.
        await manager._loadExternalComments();
      } else {
        manager._prepareExternalCommentManager?.();
        await window.externalCommentManager.loadAndRender();
      }
    } catch (err) {
      console.warn('[external-comments] local re-render failed', err);
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
      // Server-computed per-file hunk hashes (computed from the canonical
      // diff so they remain stable across whitespace-filtered renders).
      const hunkHashesByFile = data.hunk_hashes_by_file || {};

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
          // Pass through the server-computed canonical hunk hashes; renderPatch
          // requires these to anchor persisted summaries (no client-side fallback).
          hunk_hashes: hunkHashesByFile[fileName] || null,
          // Inspect only the header (before the first @@) so file contents
          // containing "new file mode" / "deleted file mode" can't spoof status.
          status: (() => {
            const atIdx = patch.indexOf('@@');
            const hdr = atIdx === -1 ? patch : patch.substring(0, atIdx);
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

    // A scope change flips the LEFT-trust answer; must precede the re-render.
    this._applyLeftAnchorInputs(result);

    // Update header and reload diff
    this.updateLocalHeader(this.localData);
    await this.loadLocalDiff();

    await this._rerenderLocalOverlays();

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
}

/**
 * Hard per-page-load budget for the cold-cache PR-metadata warm-up; see
 * _maybeWarmPRMetadata(). A static rather than a file-level const because this
 * file is a plain <script> sharing global scope with pr.js.
 */
LocalManager.MAX_PR_METADATA_WARM_ATTEMPTS = 3;

// Initialize LocalManager when in local mode
if (typeof window !== 'undefined' && window.PAIR_REVIEW_LOCAL_MODE) {
  window.localManager = new LocalManager();
}

// Export for testing (Node.js environment)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LocalManager };
}
