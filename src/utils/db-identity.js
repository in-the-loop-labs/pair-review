// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * Database identity helpers shared by the server (/health) and the headless
 * CLI delegation handshake. Two processes may only delegate work to each
 * other when they resolve the same SQLite database file; comparing digests
 * of the resolved absolute path avoids exposing the raw filesystem path
 * over HTTP.
 */

const crypto = require('crypto');
const path = require('path');
const { getConfigDir, resolveDbName } = require('../config');

/**
 * Resolves the absolute path of the SQLite database for the given config,
 * using the same precedence as server startup (PAIR_REVIEW_DB_NAME env >
 * config.db_name > 'database.db', inside the pair-review config dir).
 *
 * @param {Object} config - Configuration object from loadConfig()
 * @returns {string} - Absolute database file path
 */
function resolveDbPath(config) {
  // getConfigDir() is already absolute and computeDbId() resolves the path
  // again, so an outer path.resolve here is a no-op — join is enough.
  return path.join(getConfigDir(), resolveDbName(config));
}

/**
 * Computes a stable identity digest for a database path. Both sides of the
 * delegation handshake must use this exact function so digests compare
 * equal by construction.
 *
 * @param {string} dbPath - Database file path (absolute or relative)
 * @returns {string} - Hex SHA-256 digest of the resolved absolute path
 */
function computeDbId(dbPath) {
  return crypto.createHash('sha256').update(path.resolve(dbPath)).digest('hex');
}

module.exports = {
  resolveDbPath,
  computeDbId,
};
