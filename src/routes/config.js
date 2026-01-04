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
const { RepoSettingsRepository, ReviewRepository } = require('../database');
const { getAllProvidersInfo, testProviderAvailability } = require('../ai');
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
    comment_button_action: config.comment_button_action || 'submit'
  });
});

/**
 * Update user configuration
 * Updates safe configuration values
 */
router.patch('/api/config', async (req, res) => {
  try {
    const { comment_button_action } = req.body;

    // Validate comment_button_action if provided
    if (comment_button_action !== undefined) {
      if (!['submit', 'preview'].includes(comment_button_action)) {
        return res.status(400).json({
          error: 'Invalid comment_button_action. Must be "submit" or "preview"'
        });
      }
    }

    // Get current config
    const config = req.app.get('config') || {};

    // Update allowed fields
    if (comment_button_action !== undefined) {
      config.comment_button_action = comment_button_action;
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
        comment_button_action: config.comment_button_action || 'submit'
      }
    });

  } catch (error) {
    console.error('Error updating config:', error);
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
    const repository = `${owner}/${repo}`;
    const db = req.app.get('db');

    const repoSettingsRepo = new RepoSettingsRepository(db);
    const settings = await repoSettingsRepo.getRepoSettings(repository);

    if (!settings) {
      // Return empty object if no settings exist
      return res.json({
        repository,
        default_instructions: null,
        default_provider: null,
        default_model: null
      });
    }

    res.json({
      repository: settings.repository,
      default_instructions: settings.default_instructions,
      default_provider: settings.default_provider,
      default_model: settings.default_model,
      created_at: settings.created_at,
      updated_at: settings.updated_at
    });

  } catch (error) {
    console.error('Error fetching repo settings:', error);
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
    const { default_instructions, default_provider, default_model } = req.body;
    const repository = `${owner}/${repo}`;
    const db = req.app.get('db');

    // Validate that at least one setting is provided
    if (default_instructions === undefined && default_provider === undefined && default_model === undefined) {
      return res.status(400).json({
        error: 'At least one setting (default_instructions, default_provider, or default_model) must be provided'
      });
    }

    const repoSettingsRepo = new RepoSettingsRepository(db);
    const settings = await repoSettingsRepo.saveRepoSettings(repository, {
      default_instructions,
      default_provider,
      default_model
    });

    logger.info(`Saved repo settings for ${repository}`);

    res.json({
      success: true,
      settings: {
        repository: settings.repository,
        default_instructions: settings.default_instructions,
        default_provider: settings.default_provider,
        default_model: settings.default_model,
        updated_at: settings.updated_at
      }
    });

  } catch (error) {
    console.error('Error saving repo settings:', error);
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

    const repository = `${owner}/${repo}`;
    const db = req.app.get('db');

    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getReviewByPR(prNumber, repository);

    if (!review) {
      return res.json({
        custom_instructions: null
      });
    }

    res.json({
      custom_instructions: review.custom_instructions || null
    });

  } catch (error) {
    console.error('Error fetching review settings:', error);
    res.status(500).json({
      error: 'Failed to fetch review settings'
    });
  }
});

/**
 * Get available AI providers and their models
 * Returns provider info including available models
 */
router.get('/api/providers', (req, res) => {
  try {
    const providers = getAllProvidersInfo();
    res.json({ providers });
  } catch (error) {
    console.error('Error fetching providers:', error);
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
    console.error('Error testing provider:', error);
    res.status(500).json({
      error: 'Failed to test provider availability'
    });
  }
});

module.exports = router;
