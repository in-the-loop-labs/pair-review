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
const { getRegistry, getPath, hasPath, setPath } = require('../settings/registry');

const router = express.Router();

// Repo_settings columns that count as a user having *configured* a repo. Rows
// created solely by local_path auto-register or pool leases (local_path /
// pool_fetch_* timestamps) do NOT count — matching the plan's "known vs
// configured" distinction. auto_branch_review is handled separately below: its
// schema default is 0 ("ask"), so mere presence of a value is NOT configuration
// — only an explicit 1 ("always") or -1 ("never") counts.
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

// auto_branch_review values that represent a deliberate user choice (vs. the
// schema default of 0 = "ask each time", which is indistinguishable from unset).
const CONFIGURED_AUTO_BRANCH_REVIEW_VALUES = new Set([1, -1]);

// Registry keys whose consumers latch their value at process startup (route
// mounting, middleware, static-file caching, retention sweeps). These are
// flagged restartRequired in the registry. A post-boot write persists the
// override and advertises "restart required" in the UI, but the value MUST NOT
// be folded into the live app config — the running process cannot honor it, so
// app.get('config') advertising the new value while behavior is unchanged is a
// lie. We snapshot the boot values once and re-apply them over every rebuilt
// effective config before app.set('config', ...).
const RESTART_REQUIRED_KEYS = getRegistry()
  .filter((entry) => entry.restartRequired)
  .map((entry) => entry.key);

/** JSON deep clone so snapshotted object values (providers/repos/hooks) can't alias the live config. */
function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Snapshot the boot-time value of every restart-required key, memoized on the
 * app. Captured lazily on the first write: no prior write can have mutated the
 * config (a write is the only thing that re-sets it), so app.get('config') still
 * holds the values the process actually latched at launch — including any DB
 * override that was present at boot and folded in then.
 * @param {import('express').Application} app
 * @returns {Object} map of restart-required key -> boot value (present keys only)
 */
function bootRestartValues(app) {
  let snapshot = app.get('restartRequiredBootConfig');
  if (!snapshot) {
    const config = app.get('config') || {};
    snapshot = {};
    for (const key of RESTART_REQUIRED_KEYS) {
      if (hasPath(config, key)) {
        snapshot[key] = cloneValue(getPath(config, key));
      }
    }
    app.set('restartRequiredBootConfig', snapshot);
  }
  return snapshot;
}

/**
 * Overlay boot-time restart-required values onto a freshly rebuilt effective
 * config so the live config never advertises a post-boot value the running
 * process cannot honor. Also strips a same-request restart-required override
 * (setOverride folds ALL persisted overrides, so a later write to a DYNAMIC key
 * would otherwise re-fold a pending restart-required override). Mutates and
 * returns `effectiveConfig`.
 * @param {import('express').Application} app
 * @param {Object} effectiveConfig
 * @returns {Object}
 */
function preserveBootRestartValues(app, effectiveConfig) {
  const snapshot = bootRestartValues(app);
  for (const key of Object.keys(snapshot)) {
    setPath(effectiveConfig, key, cloneValue(snapshot[key]));
  }
  return effectiveConfig;
}

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
    // The returned descriptor (result.setting) already reflects the NEW value +
    // restartRequired flag; only the LIVE config keeps boot values for
    // restart-required keys (see preserveBootRestartValues).
    req.app.set('config', preserveBootRestartValues(req.app, result.effectiveConfig));
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
    // Clearing a restart-required override doesn't un-latch the running process,
    // so the live config keeps the boot value until restart (the descriptor
    // shows the recomputed value + restartRequired flag).
    req.app.set('config', preserveBootRestartValues(req.app, result.effectiveConfig));
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
             auto_branch_review, local_path, updated_at
      FROM repo_settings
    `);

    const byRepo = new Map();

    for (const row of rows) {
      const hasDbSettings =
        CONFIGURED_REPO_COLUMNS.some(
          (col) => row[col] !== null && row[col] !== undefined
        ) ||
        // auto_branch_review defaults to 0 ("ask"); only an explicit always/never
        // choice counts, so a row holding just the default doesn't look configured.
        CONFIGURED_AUTO_BRANCH_REVIEW_VALUES.has(row.auto_branch_review);
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
