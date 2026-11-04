// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Per-PR cache of the blob info the PR-mode file-content endpoints need.
 *
 * `pr_metadata.pr_data` holds the whole PR diff, and the file-content
 * endpoints are hit on every lazy file body, gap expansion, context file and
 * chat snippet. Parsing the row and scanning the diff on each request is
 * wasteful on large PRs, so this module parses it once per PR into a
 * path -> blob info index plus the base SHA, and serves lookups from that.
 *
 * Staleness guards (every one must hold for a cache hit):
 * - Writers of `pr_data` on this connection call invalidatePRFileBlobCache().
 * - The row's `(id, updated_at)` must match. These columns precede `pr_data`
 *   in the row, so reading them does not load the diff. A deleted row serves
 *   no specs; a recreated row has a new id.
 * - `PRAGMA data_version` must be unchanged. SQLite bumps it whenever another
 *   connection (e.g. a `--headless --no-server` CLI run sharing the database
 *   file) commits, which an in-process invalidation cannot see and which a
 *   1-second `updated_at` can miss.
 *
 * The lookup runs synchronously (better-sqlite3), so no write can interleave
 * between reading the row and storing the index.
 */

const logger = require('./logger');
const { safeParseJson } = require('./safe-parse-json');
const { buildFileBlobIndex, buildOriginalFileContentSpecs } = require('./diff-file-content');

// Upper bound on cached PRs per database, evicted least recently used.
const MAX_CACHED_PRS = 50;

// Keyed by database handle so separate databases (and tests) never share entries.
const cachesByDb = new WeakMap();

function cacheKey(repository, prNumber) {
  return `${String(repository).toLowerCase()}#${Number(prNumber)}`;
}

function getDbCache(db) {
  let cache = cachesByDb.get(db);
  if (!cache) {
    cache = new Map();
    cachesByDb.set(db, cache);
  }
  return cache;
}

function loadEntry(db, row, dataVersion) {
  const record = db.prepare('SELECT pr_data FROM pr_metadata WHERE id = ?').get(row.id);
  const prData = safeParseJson(record?.pr_data, null);
  if (record?.pr_data && !prData) {
    logger.warn('Could not parse pr_data for file-content route');
  }

  const isObject = prData && typeof prData === 'object';
  return {
    id: row.id,
    updatedAt: row.updated_at,
    dataVersion,
    hasPrData: Boolean(isObject),
    baseSha: isObject ? prData.base_sha || null : null,
    blobIndex: isObject ? buildFileBlobIndex(prData.diff) : new Map()
  };
}

/**
 * Resolve the ordered git specs for a file's original content in a PR:
 * exact diff blob, then base_sha. An empty array means the caller should read
 * the worktree (no stored PR data, or the file has neither source).
 *
 * @param {Database} db - better-sqlite3 database handle
 * @param {string} repository - Repository in owner/repo form
 * @param {number} prNumber - Pull request number
 * @param {string} fileName - Path to resolve (old or new path in the diff)
 * @returns {Array<{gitSpec: string, source: string}>}
 */
function getPRFileContentSpecs(db, repository, prNumber, fileName) {
  const row = db.prepare(`
    SELECT id, updated_at FROM pr_metadata
    WHERE pr_number = ? AND repository = ? COLLATE NOCASE
  `).get(prNumber, repository);

  const cache = getDbCache(db);
  const key = cacheKey(repository, prNumber);

  if (!row) {
    cache.delete(key);
    return [];
  }

  const dataVersion = db.pragma('data_version', { simple: true });
  let entry = cache.get(key);
  const fresh = entry
    && entry.id === row.id
    && entry.updatedAt === row.updated_at
    && entry.dataVersion === dataVersion;

  if (fresh) {
    // Re-insert to mark as most recently used.
    cache.delete(key);
  } else {
    entry = loadEntry(db, row, dataVersion);
  }
  cache.set(key, entry);

  if (cache.size > MAX_CACHED_PRS) {
    cache.delete(cache.keys().next().value);
  }

  if (!entry.hasPrData) {
    return [];
  }

  const blobInfo = entry.blobIndex.get(fileName) ?? null;
  return buildOriginalFileContentSpecs(blobInfo, entry.baseSha, fileName);
}

/**
 * Drop the cached blob info for a PR. Call after every write to its
 * `pr_metadata.pr_data`.
 *
 * @param {Database} db - better-sqlite3 database handle the write used
 * @param {string} repository - Repository in owner/repo form
 * @param {number} prNumber - Pull request number
 */
function invalidatePRFileBlobCache(db, repository, prNumber) {
  cachesByDb.get(db)?.delete(cacheKey(repository, prNumber));
}

module.exports = {
  getPRFileContentSpecs,
  invalidatePRFileBlobCache,
  MAX_CACHED_PRS
};
