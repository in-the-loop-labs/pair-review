// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Configuration Routes
 *
 * Handles all configuration-related endpoints:
 * - User configuration (theme, comment button action)
 * - Repository-specific settings (default instructions, default model, default provider)
 * - Review settings for PRs
 * - AI provider information
 */

const express = require('express');
const { RepoSettingsRepository, ReviewRepository, queryOne } = require('../database');
const {
  getAllProvidersInfo,
  testProviderAvailability,
  getCachedAvailability,
  getAllCachedAvailability,
  checkAllProviders,
  isCheckInProgress
} = require('../ai');
const { normalizeRepository } = require('../utils/paths');
const {
  isRunningViaNpx,
  getGitHubToken,
  getDefaultProvider,
  getDefaultModel,
  resolveHostBinding,
  resolveBindingRepositoryFromPR,
  getSummaryEnabled,
  getSummaryAutoGenerate,
  getTourEnabled,
  getTourAutoGenerate
} = require('../config');
const { resolveRepoLinks } = require('../links/repo-links');
const { version } = require('../../package.json');
const semver = require('semver');
const { getAllChatProviders, getAllCachedChatAvailability } = require('../chat/chat-providers');
const logger = require('../utils/logger');

const router = express.Router();

// Module-level state: the most recent version we've been told about that's
// newer than the running server. Plain string, not an object. `null` means
// nothing is pending. Reset on process restart — which is fine because a
// restart either IS the update (running version is now newer) or loses no
// information (the next notifier will re-populate it).
let pendingUpdateVersion = null;

/**
 * Runtime configuration script
 *
 * Returns a tiny JS file that sets `window.PAIR_REVIEW_RUNTIME_CONFIG`
 * synchronously, plus an `external-comments-disabled` class on
 * `documentElement` when the feature is off. Loaded via a `<script>` tag
 * BEFORE the main app JS so components like AIPanel can check the flag
 * at construction time (avoids FOUC of UI elements that should be hidden).
 *
 * No-store so each page load reflects current config without restart.
 */
router.get('/runtime-config.js', (req, res) => {
  const config = req.app.get('config') || {};
  const externalCommentsEnabled = config.external_comments !== false;
  const runtimeConfig = { external_comments_enabled: externalCommentsEnabled };
  const body = [
    `window.PAIR_REVIEW_RUNTIME_CONFIG = ${JSON.stringify(runtimeConfig)};`,
    `if (!window.PAIR_REVIEW_RUNTIME_CONFIG.external_comments_enabled) {`,
    `  document.documentElement.classList.add('external-comments-disabled');`,
    `}`,
  ].join('\n');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(body);
});

/**
 * Get user configuration (for frontend use)
 * Returns safe-to-expose configuration values.
 *
 * GitHub token presence is reported with two distinct fields:
 *   - has_global_github_token: always present. True iff `getGitHubToken(config)`
 *     resolves a token from the top-level config / env (no repo context).
 *   - has_github_token: present ONLY when both ?owner and ?repo query
 *     parameters are supplied. True iff a token can be resolved for that
 *     specific repository via `resolveHostBinding(repo, config)` — this
 *     covers repo-scoped `token`, `token_command`, alt-host bindings, AND
 *     falls through to the global lookup. Callers that know which repo
 *     they're rendering should pass these params so that repo-scoped
 *     authentication is reflected accurately (e.g. for deciding whether
 *     to enable GitHub-comment dedup). When the params are absent, the
 *     repo-aware field is omitted entirely — there is no safe default
 *     that doesn't risk silently meaning the wrong thing.
 */
/**
 * Resolve a coherent default provider/model PAIR for the frontend.
 *
 * `default_provider` and `default_model` seed the bulk modal, auto-analyze, and
 * the manual analyze dialog as a single selection, so they must belong together.
 * An explicitly configured model wins (the user opted into it). When no model is
 * configured, derive it from the selected provider's own default rather than the
 * provider-agnostic global default — otherwise a provider-only override (e.g.
 * `default_provider: 'gemini'`) would pair with an Anthropic model like 'opus'.
 *
 * @param {Object} config - Configuration object
 * @returns {{ provider: string, model: string }}
 */
function resolveDefaultProviderModel(config) {
  const provider = getDefaultProvider(config);
  const providerInfo = getAllProvidersInfo().find(p => p.id === provider);
  const explicitModel = config.default_model || config.model;
  // Only honour an explicit model if it actually belongs to the selected provider.
  // `DEFAULT_CONFIG.default_model` is always populated (e.g. 'opus'), so a
  // provider-only override like `default_provider: 'gemini'` would otherwise inherit
  // a foreign Anthropic model and return a mismatched pair. When the model does not
  // belong to the provider, derive a coherent default from the provider itself.
  const modelBelongs = explicitModel && providerInfo?.models?.some(m => m.id === explicitModel);
  if (modelBelongs) {
    return { provider, model: explicitModel };
  }
  return { provider, model: providerInfo?.defaultModel || getDefaultModel(config) };
}

router.get('/api/config', (req, res) => {
  const config = req.app.get('config') || {};
  const defaultPair = resolveDefaultProviderModel(config);

  // Build chat_providers array with availability
  const chatAvailability = getAllCachedChatAvailability();
  const chatProviders = getAllChatProviders().map(p => ({
    id: p.id, name: p.name, type: p.type, available: chatAvailability[p.id]?.available || false
  }));

  // Repo-aware token resolution (opt-in via ?owner & ?repo query params).
  // Both must be non-empty strings; missing/partial params fall back to the
  // global-only response shape.
  const { owner, repo } = req.query;
  const hasRepoContext = typeof owner === 'string' && owner.length > 0
    && typeof repo === 'string' && repo.length > 0;

  const hasGlobalGithubToken = Boolean(getGitHubToken(config));
  let hasRepoGithubToken = null;
  if (hasRepoContext) {
    const repository = `${owner}/${repo}`;
    // resolveHostBinding already falls through to top-level config when
    // no repo-scoped token is configured, so this is a true union of
    // "repo-scoped binding works" OR "global token works".
    hasRepoGithubToken = Boolean(resolveHostBinding(repository, config).token);
  }

  // Only return safe configuration values (not secrets like github_token)
  res.json({
    version,
    theme: config.theme || 'light',
    has_global_github_token: hasGlobalGithubToken,
    // Repo-aware field — only included when owner+repo were supplied.
    ...(hasRepoContext ? { has_github_token: hasRepoGithubToken } : {}),
    comment_button_action: config.comment_button_action || 'submit',
    comment_format: config.comment_format || 'legacy',
    default_provider: defaultPair.provider,
    default_model: defaultPair.model,
    // Include npx detection for frontend command examples
    is_running_via_npx: isRunningViaNpx(),
    enable_chat: config.enable_chat !== false,
    chat_provider: config.chat_provider || 'pi',
    chat_providers: chatProviders,
    chat_enable_shortcuts: config.chat?.enable_shortcuts !== false,
    chat_enter_to_send: config.chat?.enter_to_send !== false,
    pi_available: getCachedAvailability('pi')?.available || false,
    assisted_by_url: config.assisted_by_url || 'https://github.com/in-the-loop-labs/pair-review',
    enable_graphite: config.enable_graphite === true,
    external_comments: config.external_comments !== false,
    chat_spinner: config.chat_spinner || 'dots',
    summaries: {
      enabled: getSummaryEnabled(config),
      auto_generate: getSummaryAutoGenerate(config)
    },
    tours: {
      enabled: getTourEnabled(config),
      auto_generate: getTourAutoGenerate(config)
    },
    // Share configuration for external review viewers.
    // - url: The base URL of the external share site
    // - method: Plumbed through for future use (e.g., POST-based share flows).
    //           The current implementation only uses GET via window.open().
    // - icon: Optional custom SVG icon for the share button
    // - label: Optional custom label for the share menu item (e.g., "Share to Acme")
    // - description: Optional tooltip text shown on hover (e.g., "Share to Acme review board")
    share: config.share ? {
      url: config.share.url || null,
      method: config.share.method || 'GET',
      icon: config.share.icon || null,
      label: config.share.label || null,
      description: config.share.description || null
    } : null,
    pending_update: pendingUpdateVersion
  });
});

/**
 * Notify the running server that a newer version is available.
 * Called by a newer CLI invocation delegating to this server.
 * Stores state so browser tabs can pick it up via GET /api/config.
 *
 * Suppression is version-based, not time-based: a POST is accepted only
 * when the incoming version is strictly newer than both the running version
 * and any currently-pending version. This means `pendingUpdateVersion`
 * monotonically increases for the life of the process.
 */
router.post('/api/notify-update', (req, res) => {
  const incomingVersion = req.body?.version;
  if (!incomingVersion || !semver.valid(incomingVersion)) {
    return res.status(400).json({ error: 'Invalid version' });
  }

  if (!semver.gt(incomingVersion, version)) {
    return res.json({ ok: true, notified: false, reason: 'not_newer' });
  }

  // Suppress unless the incoming version is STRICTLY newer than what's
  // already pending. Handles three cases at once:
  //   - incoming == pending  → suppressed (nothing new)
  //   - incoming  > pending  → accepted (genuinely newer, falls through)
  //   - incoming  < pending  → suppressed (downgrade — user already knows)
  if (pendingUpdateVersion && !semver.gt(incomingVersion, pendingUpdateVersion)) {
    return res.json({ ok: true, notified: false, reason: 'not_newer_than_pending' });
  }

  pendingUpdateVersion = incomingVersion;
  logger.info(`New version available: ${incomingVersion} (running ${version})`);

  res.json({ ok: true, notified: true });
});

/**
 * Get repository-specific settings
 * Returns default_instructions, default_provider, and default_model for the repository
 */
router.get('/api/repos/:owner/:repo/settings', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const repository = normalizeRepository(owner, repo);
    const db = req.app.get('db');

    const repoSettingsRepo = new RepoSettingsRepository(db);
    const settings = await repoSettingsRepo.getRepoSettings(repository);

    if (!settings) {
      // Return empty object if no settings exist
      return res.json({
        repository,
        default_instructions: null,
        default_provider: null,
        default_model: null,
        local_path: null,
        default_council_id: null,
        default_tab: null,
        default_chat_instructions: null,
        pool_size: null,
        pool_fetch_interval_minutes: null,
        load_skills: null
      });
    }

    res.json({
      repository: settings.repository,
      default_instructions: settings.default_instructions,
      default_provider: settings.default_provider,
      default_model: settings.default_model,
      local_path: settings.local_path,
      default_council_id: settings.default_council_id,
      default_tab: settings.default_tab,
      default_chat_instructions: settings.default_chat_instructions,
      pool_size: settings.pool_size ?? null,
      pool_fetch_interval_minutes: settings.pool_fetch_interval_minutes ?? null,
      load_skills: settings.load_skills ?? null,
      created_at: settings.created_at,
      updated_at: settings.updated_at
    });

  } catch (error) {
    logger.error('Error fetching repo settings:', error);
    res.status(500).json({
      error: 'Failed to fetch repository settings'
    });
  }
});

/**
 * Get repository-specific header link configuration.
 * Reads `config.repos["owner/repo"].links` and returns:
 *   - external: { label, url_template, icon } | null
 *   - github: boolean (false means hide the default GitHub link)
 *   - graphite: boolean (false means hide the Graphite link)
 *
 * The icon SVG is sanitised server-side (script tags, on* handlers, and
 * `javascript:` URLs stripped). The url_template is NOT substituted here —
 * the frontend has the live PR/branch context, so it performs the
 * whitelisted substitution at render time.
 */
router.get('/api/repos/:owner/:repo/links', (req, res) => {
  try {
    const { owner, repo } = req.params;
    const repository = normalizeRepository(owner, repo);
    const config = req.app.get('config') || {};
    // Resolve via bindingRepository so monorepo-style configs (one
    // `repos[...]` entry serving many captured owner/repo via
    // url_pattern) surface the right link config.
    const bindingRepository = resolveBindingRepositoryFromPR(owner, repo, config);
    const links = resolveRepoLinks(config, bindingRepository);
    res.json({ repository, links });
  } catch (error) {
    logger.error('Error resolving repo links:', error);
    res.status(500).json({ error: 'Failed to resolve repository links' });
  }
});

/**
 * Save repository-specific settings
 * Saves default_instructions, default_provider, and/or default_model for the repository
 */
router.post('/api/repos/:owner/:repo/settings', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { default_instructions, default_provider, default_model, local_path, default_council_id, default_tab, default_chat_instructions, pool_size, pool_fetch_interval_minutes, load_skills } = req.body;
    const repository = normalizeRepository(owner, repo);
    const db = req.app.get('db');

    // Validate that at least one setting is provided
    if (default_instructions === undefined && default_provider === undefined && default_model === undefined && local_path === undefined && default_council_id === undefined && default_tab === undefined && default_chat_instructions === undefined && pool_size === undefined && pool_fetch_interval_minutes === undefined && load_skills === undefined) {
      return res.status(400).json({
        error: 'At least one setting must be provided'
      });
    }

    const repoSettingsRepo = new RepoSettingsRepository(db);
    const settings = await repoSettingsRepo.saveRepoSettings(repository, {
      default_instructions,
      default_provider,
      default_model,
      local_path,
      default_council_id,
      default_tab,
      default_chat_instructions,
      pool_size,
      pool_fetch_interval_minutes,
      load_skills
    });

    logger.info(`Saved repo settings for ${repository}`);

    res.json({
      success: true,
      settings: {
        repository: settings.repository,
        default_instructions: settings.default_instructions,
        default_provider: settings.default_provider,
        default_model: settings.default_model,
        local_path: settings.local_path,
        default_council_id: settings.default_council_id,
        default_tab: settings.default_tab,
        default_chat_instructions: settings.default_chat_instructions,
        pool_size: settings.pool_size ?? null,
        pool_fetch_interval_minutes: settings.pool_fetch_interval_minutes ?? null,
        load_skills: settings.load_skills ?? null,
        updated_at: settings.updated_at
      }
    });

  } catch (error) {
    logger.error('Error saving repo settings:', error);
    res.status(500).json({
      error: 'Failed to save repository settings'
    });
  }
});

/**
 * Get review settings for a PR
 * Returns the custom_instructions from the most recent review
 */
router.get('/api/pr/:owner/:repo/:number/review-settings', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = normalizeRepository(owner, repo);
    const db = req.app.get('db');

    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getReviewByPR(prNumber, repository);

    if (!review) {
      return res.json({
        custom_instructions: null,
        last_council_id: null
      });
    }

    // Find the last council used for this review
    let last_council_id = null;
    const lastCouncilRun = await queryOne(db, `
      SELECT model FROM analysis_runs
      WHERE review_id = ? AND provider = 'council' AND model != 'inline-config'
      ORDER BY started_at DESC LIMIT 1
    `, [review.id]);
    if (lastCouncilRun) {
      last_council_id = lastCouncilRun.model;
    }

    res.json({
      custom_instructions: review.custom_instructions || null,
      last_council_id
    });

  } catch (error) {
    logger.error('Error fetching review settings:', error);
    res.status(500).json({
      error: 'Failed to fetch review settings'
    });
  }
});

/**
 * Get available AI providers and their models
 * Returns provider info including available models and cached availability status
 */
router.get('/api/providers', (req, res) => {
  try {
    const providers = getAllProvidersInfo();
    const availability = getAllCachedAvailability();

    // Enrich providers with availability status
    const enrichedProviders = providers.map(provider => ({
      ...provider,
      availability: availability[provider.id] || null
    }));

    res.json({
      providers: enrichedProviders,
      checkInProgress: isCheckInProgress()
    });
  } catch (error) {
    logger.error('Error fetching providers:', error);
    res.status(500).json({
      error: 'Failed to fetch AI providers'
    });
  }
});

/**
 * Test if a specific AI provider is available
 * Checks if the provider's CLI is installed and accessible
 */
router.get('/api/providers/:providerId/test', async (req, res) => {
  try {
    const { providerId } = req.params;
    const result = await testProviderAvailability(providerId);

    res.json({
      provider: providerId,
      available: result.available,
      error: result.error || null,
      installInstructions: result.installInstructions || null
    });
  } catch (error) {
    logger.error('Error testing provider:', error);
    res.status(500).json({
      error: 'Failed to test provider availability'
    });
  }
});

/**
 * Refresh provider availability status
 * Re-checks all providers and returns updated status
 */
router.post('/api/providers/refresh-availability', async (req, res) => {
  try {
    // Check if already in progress
    if (isCheckInProgress()) {
      return res.json({
        success: true,
        message: 'Availability check already in progress',
        checkInProgress: true
      });
    }

    // Get config for default provider priority
    const config = req.app.get('config') || {};
    const defaultProvider = config.default_provider || 'claude';

    // Start the check (don't await - return immediately)
    checkAllProviders(defaultProvider).catch(err => {
      logger.warn('Provider availability refresh failed:', err.message);
    });

    res.json({
      success: true,
      message: 'Availability check started',
      checkInProgress: true
    });
  } catch (error) {
    logger.error('Error refreshing provider availability:', error);
    res.status(500).json({
      error: 'Failed to refresh provider availability'
    });
  }
});

/**
 * Test-only helper: reset the in-memory pending-update state.
 * Not exported from index — intended for use by integration tests that
 * share the same module instance and need isolation between cases.
 */
function _resetPendingUpdate() {
  pendingUpdateVersion = null;
}

module.exports = router;
module.exports._resetPendingUpdate = _resetPendingUpdate;
module.exports._resolveDefaultProviderModel = resolveDefaultProviderModel;
