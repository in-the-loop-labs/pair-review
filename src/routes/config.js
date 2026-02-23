// SPDX-License-Identifier: GPL-3.0-or-later
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
const { isRunningViaNpx } = require('../config');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Get user configuration (for frontend use)
 * Returns safe-to-expose configuration values
 */
router.get('/api/config', (req, res) => {
  const config = req.app.get('config') || {};

  // Only return safe configuration values (not secrets like github_token)
  res.json({
    theme: config.theme || 'light',
    comment_button_action: config.comment_button_action || 'submit',
    // Include npx detection for frontend command examples
    is_running_via_npx: isRunningViaNpx(),
    enable_chat: config.enable_chat !== false,
    chat_enable_shortcuts: config.chat?.enable_shortcuts !== false,
    pi_available: getCachedAvailability('pi')?.available || false
  });
});

/**
 * Update user configuration
 * Updates safe configuration values
 */
router.patch('/api/config', async (req, res) => {
  try {
    const { comment_button_action, chat_enable_shortcuts } = req.body;

    // Validate comment_button_action if provided
    if (comment_button_action !== undefined) {
      if (!['submit', 'preview'].includes(comment_button_action)) {
        return res.status(400).json({
          error: 'Invalid comment_button_action. Must be "submit" or "preview"'
        });
      }
    }

    if (chat_enable_shortcuts !== undefined) {
      if (typeof chat_enable_shortcuts !== 'boolean') {
        return res.status(400).json({
          error: 'Invalid chat_enable_shortcuts. Must be a boolean'
        });
      }
    }

    // Get current config
    const config = req.app.get('config') || {};

    // Update allowed fields
    if (comment_button_action !== undefined) {
      config.comment_button_action = comment_button_action;
    }

    if (chat_enable_shortcuts !== undefined) {
      if (!config.chat) config.chat = {};
      config.chat.enable_shortcuts = chat_enable_shortcuts;
    }

    // Save config to file
    const { saveConfig } = require('../config');
    await saveConfig(config);

    // Update app config
    req.app.set('config', config);

    res.json({
      success: true,
      config: {
        theme: config.theme || 'light',
        comment_button_action: config.comment_button_action || 'submit',
        chat_enable_shortcuts: config.chat?.enable_shortcuts !== false
      }
    });

  } catch (error) {
    logger.error('Error updating config:', error);
    res.status(500).json({
      error: 'Failed to update configuration'
    });
  }
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
        default_chat_instructions: null
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
 * Save repository-specific settings
 * Saves default_instructions, default_provider, and/or default_model for the repository
 */
router.post('/api/repos/:owner/:repo/settings', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { default_instructions, default_provider, default_model, local_path, default_council_id, default_tab, default_chat_instructions } = req.body;
    const repository = normalizeRepository(owner, repo);
    const db = req.app.get('db');

    // Validate that at least one setting is provided
    if (default_instructions === undefined && default_provider === undefined && default_model === undefined && local_path === undefined && default_council_id === undefined && default_tab === undefined && default_chat_instructions === undefined) {
      return res.status(400).json({
        error: 'At least one setting (default_instructions, default_provider, default_model, local_path, default_council_id, default_tab, or default_chat_instructions) must be provided'
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
      default_chat_instructions
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

module.exports = router;
