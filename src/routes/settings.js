// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Global Settings Routes
 *
 * Backs the /settings page. All effective-value resolution, validation, and
 * persistence live in the GlobalSettingsService (app.get('globalSettings')).
 * Write endpoints re-set the live config object via app.set('config', ...) so
 * every per-request `req.app.get('config')` reader immediately honors an
 * override (dynamic settings) — startup-captured settings are flagged
 * `restartRequired` and take effect on next launch.
 */

const express = require('express');
const { query } = require('../database');
const logger = require('../utils/logger');

const router = express.Router();

// Repo_settings columns that count as a user having *configured* a repo. Rows
// created solely by local_path auto-register or pool leases (local_path /
// pool_fetch_* timestamps) do NOT count — matching the plan's "known vs
// configured" distinction.
const CONFIGURED_REPO_COLUMNS = [
  'default_instructions',
  'default_provider',
  'default_model',
  'default_council_id',
  'default_tab',
  'default_chat_instructions',
  'pool_size',
  'pool_fetch_interval_minutes',
  'load_skills'
];

/**
 * GET /api/settings — `{ sections, settings }`. `settings` is the descriptor
 * list for every VISIBLE registry entry (hidden entries omitted); `sections` is
 * the ordered section metadata (title/description/badge) for sections that have
 * at least one visible setting.
 */
router.get('/api/settings', (req, res) => {
  const service = req.app.get('globalSettings');
  if (!service) {
    return res.status(503).json({ error: 'Global settings service unavailable' });
  }
  try {
    const settings = service.describe();
    // Sections drive the page nav (order, titles, badges); empty sections are
    // omitted. Descriptors are already hidden-filtered by describe().
    res.json({ sections: service.describeSections(settings), settings });
  } catch (error) {
    logger.error('Error describing global settings:', error);
    res.status(500).json({ error: 'Failed to load global settings' });
  }
});

/**
 * PUT /api/settings/:key — set an in-app override.
 * Body: { value: <typed> }. Rejects unknown/read-only keys and type/enum
 * validation failures with 400. On success re-sets the live config and returns
 * the updated descriptor.
 */
router.put('/api/settings/:key', async (req, res) => {
  const service = req.app.get('globalSettings');
  if (!service) {
    return res.status(503).json({ error: 'Global settings service unavailable' });
  }
  const { key } = req.params;
  if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'value')) {
    return res.status(400).json({ error: 'Request body must include a "value" field' });
  }
  try {
    const result = await service.setOverride(key, req.body.value);
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    req.app.set('config', result.effectiveConfig);
    logger.info(`Global setting "${key}" set via /settings`);
    res.json({ setting: result.setting });
  } catch (error) {
    logger.error(`Error setting global setting "${key}":`, error);
    res.status(500).json({ error: 'Failed to save setting' });
  }
});

/**
 * DELETE /api/settings/:key — clear an in-app override (idempotent). Unknown
 * key -> 400; clearing an unset override still returns 200 with the recomputed
 * descriptor + source.
 */
router.delete('/api/settings/:key', async (req, res) => {
  const service = req.app.get('globalSettings');
  if (!service) {
    return res.status(503).json({ error: 'Global settings service unavailable' });
  }
  const { key } = req.params;
  try {
    const result = await service.clearOverride(key);
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    req.app.set('config', result.effectiveConfig);
    logger.info(`Global setting "${key}" cleared via /settings`);
    res.json({ setting: result.setting });
  } catch (error) {
    logger.error(`Error clearing global setting "${key}":`, error);
    res.status(500).json({ error: 'Failed to clear setting' });
  }
});

/**
 * GET /api/settings/repos — the union of repos configured in the DB
 * (repo_settings) and in config files (config.repos). Each entry reports
 * whether it is configured in each store, its known local path, and when it
 * was last updated. Rows that are merely "known" (local_path only, no
 * user-facing settings) are included with hasDbSettings=false.
 */
router.get('/api/settings/repos', async (req, res) => {
  const db = req.app.get('db');
  const config = req.app.get('config') || {};
  try {
    const rows = await query(db, `
      SELECT repository, default_instructions, default_provider, default_model,
             default_council_id, default_tab, default_chat_instructions,
             pool_size, pool_fetch_interval_minutes, load_skills,
             local_path, updated_at
      FROM repo_settings
    `);

    const byRepo = new Map();

    for (const row of rows) {
      const hasDbSettings = CONFIGURED_REPO_COLUMNS.some(
        (col) => row[col] !== null && row[col] !== undefined
      );
      byRepo.set(row.repository.toLowerCase(), {
        repository: row.repository,
        hasDbSettings,
        hasFileConfig: false,
        localPath: row.local_path || null,
        updatedAt: row.updated_at || null
      });
    }

    // Fold in file-config repos. A repos[...] entry always counts as configured.
    const fileRepos = config.repos || {};
    for (const repoKey of Object.keys(fileRepos)) {
      const lower = repoKey.toLowerCase();
      const existing = byRepo.get(lower);
      if (existing) {
        existing.hasFileConfig = true;
      } else {
        byRepo.set(lower, {
          repository: repoKey,
          hasDbSettings: false,
          hasFileConfig: true,
          localPath: null,
          updatedAt: null
        });
      }
    }

    // Drop rows that are neither configured nor even "known" (no local path).
    const repos = Array.from(byRepo.values())
      .filter((r) => r.hasDbSettings || r.hasFileConfig || r.localPath)
      .sort((a, b) => a.repository.localeCompare(b.repository));

    res.json({ repos });
  } catch (error) {
    logger.error('Error listing configured repos:', error);
    res.status(500).json({ error: 'Failed to list repositories' });
  }
});

module.exports = router;
