// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared Test Database Schema
 *
 * This module provides the database schema for test databases (E2E and integration).
 * It is synchronized with the production schema in src/database.js.
 *
 * IMPORTANT: When updating the production schema in src/database.js,
 * also update this file to match.
 */

const Database = require('better-sqlite3');

/**
 * Database table schema definitions
 * Synchronized with production src/database.js SCHEMA_SQL
 */
const SCHEMA_SQL = {
  reviews: `
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number INTEGER,
      repository TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'submitted', 'pending')),
      review_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      submitted_at DATETIME,
      review_data TEXT,
      custom_instructions TEXT,
      review_type TEXT DEFAULT 'pr' CHECK(review_type IN ('pr', 'local')),
      local_path TEXT,
      local_head_sha TEXT,
      summary TEXT,
      name TEXT
    )
  `,

  comments: `
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY,
      review_id INTEGER,
      source TEXT,
      author TEXT,
      ai_run_id TEXT,
      ai_level INTEGER,
      ai_confidence REAL,
      file TEXT,
      line_start INTEGER,
      line_end INTEGER,
      diff_position INTEGER,
      side TEXT DEFAULT 'RIGHT' CHECK(side IN ('LEFT', 'RIGHT')),
      commit_sha TEXT,
      type TEXT,
      title TEXT,
      body TEXT,
      reasoning TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'dismissed', 'adopted', 'submitted', 'draft', 'inactive')),
      adopted_as_id INTEGER,
      parent_id INTEGER,
      is_file_level INTEGER DEFAULT 0,
      voice_id TEXT,
      is_raw INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (adopted_as_id) REFERENCES comments(id),
      FOREIGN KEY (parent_id) REFERENCES comments(id)
    )
  `,

  pr_metadata: `
    CREATE TABLE IF NOT EXISTS pr_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number INTEGER NOT NULL,
      repository TEXT NOT NULL,
      title TEXT,
      description TEXT,
      author TEXT,
      base_branch TEXT,
      head_branch TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      pr_data TEXT,
      last_ai_run_id TEXT,
      UNIQUE(pr_number, repository)
    )
  `,

  worktrees: `
    CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY,
      pr_number INTEGER NOT NULL,
      repository TEXT NOT NULL,
      branch TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL,
      UNIQUE(pr_number, repository)
    )
  `,

  repo_settings: `
    CREATE TABLE IF NOT EXISTS repo_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository TEXT NOT NULL UNIQUE,
      default_instructions TEXT,
      default_provider TEXT,
      default_model TEXT,
      default_council_id TEXT,
      default_tab TEXT,
      local_path TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `,

  analysis_runs: `
    CREATE TABLE IF NOT EXISTS analysis_runs (
      id TEXT PRIMARY KEY,
      review_id INTEGER NOT NULL,
      provider TEXT,
      model TEXT,
      custom_instructions TEXT,
      repo_instructions TEXT,
      request_instructions TEXT,
      head_sha TEXT,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
      total_suggestions INTEGER DEFAULT 0,
      files_analyzed INTEGER DEFAULT 0,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP,
      parent_run_id TEXT,
      config_type TEXT DEFAULT 'single',
      levels_config TEXT,
      FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
    )
  `,

  local_diffs: `
    CREATE TABLE IF NOT EXISTS local_diffs (
      review_id INTEGER PRIMARY KEY,
      diff_text TEXT,
      stats TEXT,
      digest TEXT,
      captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
    )
  `,

  github_reviews: `
    CREATE TABLE IF NOT EXISTS github_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      github_review_id TEXT,
      github_node_id TEXT,
      state TEXT NOT NULL DEFAULT 'local' CHECK(state IN ('local', 'pending', 'submitted', 'dismissed')),
      event TEXT CHECK(event IN ('APPROVE', 'COMMENT', 'REQUEST_CHANGES')),
      body TEXT,
      submitted_at DATETIME,
      github_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,

  councils: `
    CREATE TABLE IF NOT EXISTS councils (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'advanced',
      config JSON NOT NULL,
      last_used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `
};

/**
 * Database index definitions
 * Synchronized with production src/database.js INDEX_SQL
 */
const INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_number, repository)',
  'CREATE INDEX IF NOT EXISTS idx_comments_review_file ON comments(review_id, file, line_start)',
  'CREATE INDEX IF NOT EXISTS idx_comments_ai_run ON comments(ai_run_id)',
  'CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status)',
  'CREATE INDEX IF NOT EXISTS idx_comments_file_level ON comments(review_id, file, is_file_level)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_metadata_unique ON pr_metadata(pr_number, repository)',
  'CREATE INDEX IF NOT EXISTS idx_worktrees_last_accessed ON worktrees(last_accessed_at)',
  'CREATE INDEX IF NOT EXISTS idx_worktrees_repo ON worktrees(repository)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_settings_repository ON repo_settings(repository)',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_local ON reviews(local_path, local_head_sha) WHERE review_type = 'local'",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_pr_unique ON reviews(pr_number, repository) WHERE review_type = 'pr'",
  'CREATE INDEX IF NOT EXISTS idx_analysis_runs_review_id ON analysis_runs(review_id, started_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_analysis_runs_status ON analysis_runs(status)',
  // GitHub reviews indexes
  'CREATE INDEX IF NOT EXISTS idx_github_reviews_review_id ON github_reviews(review_id)',
  'CREATE INDEX IF NOT EXISTS idx_github_reviews_state ON github_reviews(state)',
  // Local sessions listing performance
  'CREATE INDEX IF NOT EXISTS idx_reviews_type_updated ON reviews(review_type, updated_at DESC)',
  // Council indexes
  'CREATE INDEX IF NOT EXISTS idx_councils_name ON councils(name)',
  // Voice tracking indexes
  'CREATE INDEX IF NOT EXISTS idx_comments_voice ON comments(voice_id)',
  'CREATE INDEX IF NOT EXISTS idx_comments_is_raw ON comments(is_raw)',
  // Voice-centric council indexes
  'CREATE INDEX IF NOT EXISTS idx_analysis_runs_parent ON analysis_runs(parent_run_id)'
];

/**
 * Create an in-memory SQLite database with the full test schema.
 * Enables foreign key enforcement to match production behavior.
 *
 * @returns {Database} The initialized in-memory database
 */
function createTestDatabase() {
  const db = new Database(':memory:');

  // Enable foreign key enforcement to match production behavior
  db.pragma('foreign_keys = ON');

  // Create all tables
  for (const sql of Object.values(SCHEMA_SQL)) {
    db.exec(sql);
  }

  // Create all indexes
  for (const sql of INDEX_SQL) {
    db.exec(sql);
  }

  return db;
}

/**
 * Close a test database connection.
 *
 * @param {Database} db - The database to close
 */
function closeTestDatabase(db) {
  db.close();
}

module.exports = {
  SCHEMA_SQL,
  INDEX_SQL,
  createTestDatabase,
  closeTestDatabase
};
