// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared launch-time council plumbing.
 *
 * Five call sites used to hand-roll the same three steps before starting a
 * council run — resolve the id through `CouncilStore`, normalize+validate the
 * config, and derive the `levelsConfig` recorded on the run row — each with its
 * own subtly different copy. They live here so the file-council rules (a `file:`
 * id that the process never loaded is a distinct kind of miss; a `file:` id has
 * no DB row to touch) are stated once instead of five times.
 *
 * Callers keep their own error SHAPE (404/400 JSON for the routes, thrown
 * Errors for the stack runner); this module only decides what happened.
 */

const { CouncilRepository } = require('../database');
const { createCouncilStore, isFileCouncilId } = require('./council-store');
const { normalizeAndValidateCouncilConfig } = require('./council-validation');

/**
 * Resolve the config a council run should execute, from either a saved/file
 * council id or an inline config, and validate it.
 *
 * @param {Object} db - Database instance
 * @param {Object} params
 * @param {string} [params.councilId] - Council id (DB uuid or `file:<stem>`)
 * @param {Object} [params.inlineConfig] - Ad-hoc config, used when no id is given
 * @param {string} [params.requestConfigType] - Caller-supplied type override
 * @returns {Promise<{ notFound: true } | { councilConfig: Object, configType: string, error: string|null }>}
 *   `{ notFound: true }` when `councilId` matches nothing. Otherwise the
 *   NORMALIZED config (what the runtime executes), the effective type, and the
 *   validation error (null when valid).
 */
async function resolveCouncilConfigForRun(db, { councilId, inlineConfig, requestConfigType } = {}) {
  let councilConfig;
  let configType;

  if (councilId) {
    const council = await (await createCouncilStore(db)).getById(councilId);
    if (!council) {
      return { notFound: true };
    }
    councilConfig = council.config;
    configType = requestConfigType || council.type || 'advanced';
  } else {
    councilConfig = inlineConfig;
    configType = requestConfigType || 'advanced';
  }

  const { config, error } = normalizeAndValidateCouncilConfig(councilConfig, configType);
  return { councilConfig: config, configType, error };
}

/**
 * The user-facing "no such council" message for an id that did not resolve.
 *
 * File councils are loaded once per process, so a `file:` miss usually means the
 * file was added after this server started rather than that it does not exist —
 * worth saying, because the fix (restart) is not the fix for a missing DB row.
 *
 * @param {string} councilId
 * @returns {string}
 */
function councilNotFoundMessage(councilId) {
  if (isFileCouncilId(councilId)) {
    return `Council "${councilId}" is defined in a file this server has not loaded. ` +
      'Restart pair-review to pick up new council files.';
  }
  return 'Council not found';
}

/**
 * Warning text for a `file:` council resolved by a CLI process that delegates
 * the run to an already-running server.
 *
 * Council files are read once per process, so the CLI can hold a fresher
 * overlay than the server it hands the run to. Delegation carries only the id,
 * so the server runs whatever it loaded at startup: an ADDED file 404s loudly
 * (see `councilNotFoundMessage`), but an EDITED one resolves and silently runs
 * the stale version. Returns null for DB councils — those are re-read from
 * SQLite per resolve and cannot go stale — so callers can
 * `if (msg) console.warn(msg)`.
 *
 * @param {string} [councilId]
 * @returns {string|null}
 */
function fileCouncilStalenessWarning(councilId) {
  if (!isFileCouncilId(councilId)) {
    return null;
  }
  return `Warning: council "${councilId}" comes from a council file. The running ` +
    'pair-review server loaded its council files at startup and may not have this ' +
    'version; restart it if the council does not apply.';
}

/**
 * Derive the `levels_config` recorded on the `analysis_runs` row.
 *
 * Voice-centric configs already carry per-level booleans, so they are stored
 * as-is; advanced (level-centric) configs are flattened to booleans, where a
 * level counts as enabled unless it explicitly says `enabled: false`.
 *
 * @param {Object} councilConfig - The normalized council config
 * @param {string} configType - 'council' (voice-centric) or 'advanced'
 * @returns {Object|null}
 */
function getLevelsConfigForRun(councilConfig, configType) {
  if (configType === 'council') {
    return councilConfig?.levels || null;
  }
  if (!councilConfig?.levels) {
    return null;
  }
  const levelsConfig = {};
  for (const [key, val] of Object.entries(councilConfig.levels)) {
    levelsConfig[key] = val?.enabled !== false;
  }
  return levelsConfig;
}

/**
 * Bump a council's MRU timestamp, if it has one.
 *
 * File councils have no DB row and no MRU, and an inline config has no id at
 * all — both are no-ops here so callers need no guard of their own.
 *
 * @param {Object} db - Database instance
 * @param {string} [councilId]
 * @returns {Promise<boolean>} false when there was nothing to touch
 */
async function touchCouncilLastUsedAt(db, councilId) {
  if (!councilId || isFileCouncilId(councilId)) {
    return false;
  }
  return new CouncilRepository(db).touchLastUsedAt(councilId);
}

module.exports = {
  resolveCouncilConfigForRun,
  councilNotFoundMessage,
  fileCouncilStalenessWarning,
  getLevelsConfigForRun,
  touchCouncilLastUsedAt
};
