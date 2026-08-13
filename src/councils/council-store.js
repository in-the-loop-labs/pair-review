// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * CouncilStore — the single read surface for councils, merging the DB rows
 * (`CouncilRepository`) with the read-only file overlay (./file-councils.js).
 *
 * Every read path goes through this store so file councils appear everywhere a
 * DB council can: the councils API, `--council` handle resolution, repo/global
 * default-council tiers, the three analyze routes, and `--list-councils`.
 * Write paths stay on `CouncilRepository` and must refuse `file:` ids (use
 * `isFileCouncilId`).
 *
 * File councils are loaded ONCE per process at first use (no hot reload —
 * project policy; restart to pick up file changes) and cached module-wide.
 * They have no MRU (`last_used_at` is never persisted for them), which is why
 * `list()` appends them name-sorted after the repo's MRU-ordered DB rows.
 */

const { CouncilRepository } = require('../database');
const { loadFileCouncils } = require('./file-councils');
const logger = require('../utils/logger');

const FILE_ID_PREFIX = 'file:';

/**
 * @param {*} id
 * @returns {boolean} true when the id names a file-owned council
 */
function isFileCouncilId(id) {
  return typeof id === 'string' && id.startsWith(FILE_ID_PREFIX);
}

class CouncilStore {
  /**
   * @param {Object} db - Database instance
   * @param {Array<Object>} fileCouncils - Loaded file-council rows
   */
  constructor(db, fileCouncils) {
    this.repo = new CouncilRepository(db);
    this.fileCouncils = Array.isArray(fileCouncils) ? fileCouncils : [];
  }

  /**
   * List all councils: DB rows first (repository MRU order preserved, stamped
   * `source: 'db'`), then file councils sorted by name.
   * @returns {Promise<Array<Object>>}
   */
  async list() {
    const dbRows = await this.repo.list();
    const fileRows = [...this.fileCouncils].sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''))
    );
    return [
      ...dbRows.map(row => ({ ...row, source: 'db' })),
      // Overlay rows live for the whole process: a caller mutating a shared
      // nested config would poison every later read.
      ...fileRows.map(row => ({ ...row, config: structuredClone(row.config) }))
    ];
  }

  /**
   * Fetch one council by id. `file:` ids hit the overlay; anything else hits
   * the repository. Null passthrough on miss (callers keep their existing
   * 404/warn behavior).
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async getById(id) {
    if (isFileCouncilId(id)) {
      const found = this.fileCouncils.find(c => c.id === id);
      // Overlay rows live for the whole process: a caller mutating a shared
      // nested config would poison every later read.
      return found ? { ...found, config: structuredClone(found.config) } : null;
    }
    const row = await this.repo.getById(id);
    return row ? { ...row, source: 'db' } : null;
  }
}

// Module-level once-per-process cache of the file overlay.
let _cache = null;

/**
 * Load (once) and return the file councils. The loader is fail-soft, but an
 * unexpected rejection is caught here too so a poisoned cache can never take
 * down every subsequent request.
 * @returns {Promise<Array<Object>>}
 */
function getFileCouncils() {
  if (!_cache) {
    // In-process tests must never read the developer's real config dir
    // (`CONFIG_DIR` is fixed at module load from the real HOME). Vitest sets
    // this env var globally (vitest.config.js), making the overlay empty by
    // default; tests that want file councils prime rows via `_resetForTests`.
    // NOTE: child processes spawned by tests inherit it — a spawn-based test
    // that wants real file-council loading must delete it from the child env.
    if (process.env.PAIR_REVIEW_NO_FILE_COUNCILS === '1') {
      _cache = Promise.resolve([]);
    } else {
      _cache = loadFileCouncils().catch(error => {
        logger.warn(`Failed to load file councils: ${error.message}`);
        return [];
      });
    }
  }
  return _cache;
}

/**
 * Reset (or prime) the module cache. TESTS ONLY.
 * @param {Array<Object>} [fileCouncils] - When given, the cache is primed with
 *   these rows instead of cleared, so tests get a deterministic overlay without
 *   touching the real config dir.
 */
function _resetForTests(fileCouncils) {
  _cache = fileCouncils ? Promise.resolve(fileCouncils) : null;
}

/**
 * Build a CouncilStore over the given db and the process-wide file overlay.
 * @param {Object} db - Database instance
 * @returns {Promise<CouncilStore>}
 */
async function createCouncilStore(db) {
  return new CouncilStore(db, await getFileCouncils());
}

module.exports = {
  CouncilStore,
  createCouncilStore,
  isFileCouncilId,
  FILE_ID_PREFIX,
  _resetForTests
};
