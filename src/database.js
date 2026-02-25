// SPDX-License-Identifier: GPL-3.0-or-later
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs').promises;
const { getConfigDir } = require('./config');

let dbPath = null;

/**
 * Gets the database file path, lazily defaulting to the standard location.
 * @returns {string} - Database file path
 */
function getDbPath() {
  if (!dbPath) {
    dbPath = path.join(getConfigDir(), 'database.db');
  }
  return dbPath;
}

/**
 * Current schema version - increment this when adding new migrations
 */
const CURRENT_SCHEMA_VERSION = 24;

/**
 * Database schema SQL statements
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

  comments_old: `
    CREATE TABLE IF NOT EXISTS comments_old (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      line_number INTEGER,
      comment_text TEXT NOT NULL,
      comment_type TEXT NOT NULL DEFAULT 'user' CHECK(comment_type IN ('user', 'ai', 'system')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'adopted', 'discarded')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (review_id) REFERENCES reviews (id) ON DELETE CASCADE
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
      default_chat_instructions TEXT,
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
      tier TEXT,
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
  `,

  chat_sessions: `
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL,
      context_comment_id INTEGER,
      agent_session_id TEXT, -- Reserved: agent session ID for future reconnection support
      provider TEXT NOT NULL,
      model TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'closed', 'error')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (review_id) REFERENCES reviews(id),
      FOREIGN KEY (context_comment_id) REFERENCES comments(id)
    )
  `,

  chat_messages: `
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      type TEXT DEFAULT 'message',
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    )
  `,

  context_files: `
    CREATE TABLE IF NOT EXISTS context_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL,
      file TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      label TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
    )
  `
};

/**
 * Index SQL statements for performance
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
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_local ON reviews(local_path, local_head_sha) WHERE review_type = \'local\'',
  // Partial unique index for PR reviews only (NULL pr_number values for local reviews should not conflict)
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_pr_unique ON reviews(pr_number, repository) WHERE review_type = \'pr\'',
  // Analysis runs indexes
  'CREATE INDEX IF NOT EXISTS idx_analysis_runs_review_id ON analysis_runs(review_id, started_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_analysis_runs_status ON analysis_runs(status)',
  'CREATE INDEX IF NOT EXISTS idx_analysis_runs_parent ON analysis_runs(parent_run_id)',
  // GitHub reviews indexes
  'CREATE INDEX IF NOT EXISTS idx_github_reviews_review_id ON github_reviews(review_id)',
  'CREATE INDEX IF NOT EXISTS idx_github_reviews_state ON github_reviews(state)',
  // Council indexes
  'CREATE INDEX IF NOT EXISTS idx_councils_name ON councils(name)',
  // Voice tracking indexes
  'CREATE INDEX IF NOT EXISTS idx_comments_voice ON comments(voice_id)',
  'CREATE INDEX IF NOT EXISTS idx_comments_is_raw ON comments(is_raw)',
  // Chat indexes
  'CREATE INDEX IF NOT EXISTS idx_chat_sessions_review ON chat_sessions(review_id)',
  'CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)',
  // Context files indexes
  'CREATE INDEX IF NOT EXISTS idx_context_files_review ON context_files(review_id)'
];

/**
 * Migration definitions - each migration brings the database from version N-1 to N
 * Migrations are run sequentially based on schema version
 *
 * Migration 0->1: Initial migration for existing databases
 * - Adds diff_position column to comments table
 * - Adds review_id column to reviews table
 * - Adds side column to comments table
 * - Adds commit_sha column to comments table
 * - Adds custom_instructions column to reviews table
 * - Creates repo_settings table if not exists
 */

/**
 * Helper to check if a column exists in a table
 * Used by migrations to safely add columns idempotently
 * @param {Database} db - Database instance
 * @param {string} table - Table name
 * @param {string} column - Column name
 * @returns {boolean} True if column exists
 */
function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows ? rows.some(row => row.name === column) : false;
}

/**
 * Helper to check if a table exists in the database
 * Used by migrations to safely create tables idempotently
 * @param {Database} db - Database instance
 * @param {string} tableName - Table name
 * @returns {boolean} True if table exists
 */
function tableExists(db, tableName) {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(tableName);
  return !!row;
}

const MIGRATIONS = {
  // Migration to version 1: handles all legacy column additions
  1: (db) => {
    console.log('Running migration to schema version 1...');

    // Helper to add column if not exists (idempotent)
    const addColumnIfNotExists = (table, column, definition) => {
      const exists = columnExists(db, table, column);
      if (!exists) {
        console.log(`  Adding ${column} column to ${table} table...`);
        try {
          db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
          console.log(`  Successfully added ${column} column`);
        } catch (error) {
          // Ignore duplicate column errors (race condition protection)
          if (!error.message.includes('duplicate column name')) {
            throw error;
          }
        }
      }
    };

    // Add columns to comments table
    addColumnIfNotExists('comments', 'diff_position', 'INTEGER');
    addColumnIfNotExists('comments', 'side', "TEXT DEFAULT 'RIGHT'");
    addColumnIfNotExists('comments', 'commit_sha', 'TEXT');

    // Add columns to reviews table
    addColumnIfNotExists('reviews', 'review_id', 'INTEGER');
    addColumnIfNotExists('reviews', 'custom_instructions', 'TEXT');

    // Create repo_settings table if not exists
    const hasRepoSettings = tableExists(db, 'repo_settings');
    if (!hasRepoSettings) {
      console.log('  Creating repo_settings table...');
      db.exec(SCHEMA_SQL.repo_settings);
      console.log('  Successfully created repo_settings table');
    }

    console.log('Migration to schema version 1 complete');
  },

  // Migration to version 2: adds default_provider column to repo_settings
  2: (db) => {
    console.log('Running migration to schema version 2...');

    // Add default_provider column to repo_settings if it doesn't exist
    const hasDefaultProvider = columnExists(db, 'repo_settings', 'default_provider');
    if (!hasDefaultProvider) {
      db.prepare(`ALTER TABLE repo_settings ADD COLUMN default_provider TEXT`).run();
      console.log('  Added default_provider column to repo_settings');
    }

    console.log('Migration to schema version 2 complete');
  },

  // Migration to version 3: adds last_ai_run_id column to pr_metadata
  3: (db) => {
    console.log('Running migration to schema version 3...');

    // First ensure pr_metadata table exists
    const hasPrMetadata = tableExists(db, 'pr_metadata');
    if (!hasPrMetadata) {
      console.log('  Creating pr_metadata table...');
      db.exec(SCHEMA_SQL.pr_metadata);
      console.log('  Successfully created pr_metadata table');
    }

    // Add last_ai_run_id column to pr_metadata if it doesn't exist
    const hasLastAiRunId = columnExists(db, 'pr_metadata', 'last_ai_run_id');
    if (!hasLastAiRunId) {
      try {
        db.prepare(`ALTER TABLE pr_metadata ADD COLUMN last_ai_run_id TEXT`).run();
        console.log('  Added last_ai_run_id column to pr_metadata');
      } catch (error) {
        // Ignore duplicate column errors (race condition protection)
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column last_ai_run_id already exists (race condition)');
      }
    } else {
      console.log('  Column last_ai_run_id already exists');
    }

    console.log('Migration to schema version 3 complete');
  },

  // Migration to version 4: adds local review support columns to reviews table
  4: (db) => {
    console.log('Running migration to schema version 4...');

    // Helper to add column if not exists (idempotent)
    const addColumnIfNotExists = (table, column, definition) => {
      const exists = columnExists(db, table, column);
      if (!exists) {
        console.log(`  Adding ${column} column to ${table} table...`);
        try {
          db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
          console.log(`  Successfully added ${column} column`);
        } catch (error) {
          // Ignore duplicate column errors (race condition protection)
          if (!error.message.includes('duplicate column name')) {
            throw error;
          }
        }
      }
    };

    // Add local review columns to reviews table
    addColumnIfNotExists('reviews', 'review_type', "TEXT DEFAULT 'pr'");
    addColumnIfNotExists('reviews', 'local_path', 'TEXT');
    addColumnIfNotExists('reviews', 'local_head_sha', 'TEXT');

    console.log('Migration to schema version 4 complete');
  },

  // Migration to version 5: Make pr_number nullable in reviews table
  // SQLite doesn't support ALTER COLUMN, so we recreate the table
  5: (db) => {
    console.log('Running migration to schema version 5...');

    // Recreate reviews table with pr_number as nullable
    console.log('  Recreating reviews table with nullable pr_number...');

    db.exec(`
      -- Create new table with correct schema
      CREATE TABLE IF NOT EXISTS reviews_new (
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
        local_head_sha TEXT
      );

      -- Copy data from old table
      INSERT INTO reviews_new (id, pr_number, repository, status, review_id, created_at, updated_at, submitted_at, review_data, custom_instructions, review_type, local_path, local_head_sha)
      SELECT id, pr_number, repository, status, review_id, created_at, updated_at, submitted_at, review_data, custom_instructions,
             COALESCE(review_type, 'pr'), local_path, local_head_sha
      FROM reviews;

      -- Drop old table
      DROP TABLE reviews;

      -- Rename new table
      ALTER TABLE reviews_new RENAME TO reviews;

      -- Recreate indexes
      CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_number, repository);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_local ON reviews(local_path, local_head_sha) WHERE review_type = 'local';
    `);

    // Add partial unique index for PR reviews only
    console.log('  Creating partial unique index for PR reviews...');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_pr_unique
      ON reviews(pr_number, repository)
      WHERE review_type = 'pr'
    `);

    console.log('Migration to schema version 5 complete');
  },

  // Migration to version 6: adds is_file_level column to comments for file-level comments support
  6: (db) => {
    console.log('Running migration to schema version 6...');

    // Add is_file_level column to comments if it doesn't exist
    const hasIsFileLevel = columnExists(db, 'comments', 'is_file_level');
    if (!hasIsFileLevel) {
      try {
        db.prepare(`ALTER TABLE comments ADD COLUMN is_file_level INTEGER DEFAULT 0`).run();
        console.log('  Added is_file_level column to comments');
      } catch (error) {
        // Ignore duplicate column errors (race condition protection)
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column is_file_level already exists (race condition)');
      }
    } else {
      console.log('  Column is_file_level already exists');
    }

    console.log('Migration to schema version 6 complete');
  },

  // Migration to version 7: adds summary column to reviews table for storing AI analysis summary
  7: (db) => {
    console.log('Running migration to schema version 7...');

    // Add summary column to reviews if it doesn't exist
    const hasSummary = columnExists(db, 'reviews', 'summary');
    if (!hasSummary) {
      try {
        db.prepare(`ALTER TABLE reviews ADD COLUMN summary TEXT`).run();
        console.log('  Added summary column to reviews');
      } catch (error) {
        // Ignore duplicate column errors (race condition protection)
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column summary already exists (race condition)');
      }
    } else {
      console.log('  Column summary already exists');
    }

    console.log('Migration to schema version 7 complete');
  },

  // Migration to version 8: adds analysis_runs table to track AI analysis run history
  8: (db) => {
    console.log('Running migration to schema version 8...');

    // Create analysis_runs table if it doesn't exist
    if (!tableExists(db, 'analysis_runs')) {
      db.exec(`
        CREATE TABLE analysis_runs (
          id TEXT PRIMARY KEY,
          review_id INTEGER NOT NULL,
          provider TEXT,
          model TEXT,
          custom_instructions TEXT,
          summary TEXT,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
          total_suggestions INTEGER DEFAULT 0,
          files_analyzed INTEGER DEFAULT 0,
          started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP,
          FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
        )
      `);
      console.log('  Created analysis_runs table');

      // Create indexes
      db.exec('CREATE INDEX idx_analysis_runs_review_id ON analysis_runs(review_id, started_at DESC)');
      db.exec('CREATE INDEX idx_analysis_runs_status ON analysis_runs(status)');
      console.log('  Created indexes for analysis_runs table');
    } else {
      console.log('  Table analysis_runs already exists');
    }

    console.log('Migration to schema version 8 complete');
  },

  // Migration to version 9: rename pr_id column to review_id in comments table
  9: (db) => {
    console.log('Running migration to schema version 9...');

    // Check if already migrated (review_id exists)
    if (columnExists(db, 'comments', 'review_id')) {
      console.log('  Column review_id already exists, skipping rename');
    } else if (columnExists(db, 'comments', 'pr_id')) {
      // Rename pr_id to review_id
      db.prepare('ALTER TABLE comments RENAME COLUMN pr_id TO review_id').run();
      console.log('  Renamed pr_id column to review_id in comments table');
    } else {
      console.log('  Neither pr_id nor review_id column found - table may have different schema');
    }

    // Drop old indexes if they exist and create new ones
    // Note: SQLite doesn't have DROP INDEX IF EXISTS in all versions,
    // so we ignore errors when dropping
    try {
      db.exec('DROP INDEX idx_comments_pr_file');
    } catch (e) {
      // Index may not exist, that's fine
    }
    try {
      db.exec('DROP INDEX idx_comments_file_level');
    } catch (e) {
      // Index may not exist, that's fine
    }

    // Create new indexes with review_id
    db.exec('CREATE INDEX IF NOT EXISTS idx_comments_review_file ON comments(review_id, file, line_start)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_comments_file_level ON comments(review_id, file, is_file_level)');
    console.log('  Updated indexes to use review_id');

    console.log('Migration to schema version 9 complete');
  },

  // Migration to version 10: adds local_path column to repo_settings for known repository location tracking
  10: (db) => {
    console.log('Running migration to schema version 10...');

    // Add local_path column to repo_settings if it doesn't exist
    const hasLocalPath = columnExists(db, 'repo_settings', 'local_path');
    if (!hasLocalPath) {
      try {
        db.prepare(`ALTER TABLE repo_settings ADD COLUMN local_path TEXT`).run();
        console.log('  Added local_path column to repo_settings');
      } catch (error) {
        // Ignore duplicate column errors (race condition protection)
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column local_path already exists (race condition)');
      }
    } else {
      console.log('  Column local_path already exists');
    }

    console.log('Migration to schema version 10 complete');
  },

  // Migration to version 11: adds separate instruction columns to analysis_runs
  11: (db) => {
    console.log('Running migration to schema version 11...');

    // Helper to add column if not exists (idempotent)
    const addColumnIfNotExists = (table, column, definition) => {
      const exists = columnExists(db, table, column);
      if (!exists) {
        console.log(`  Adding ${column} column to ${table} table...`);
        try {
          db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
          console.log(`  Successfully added ${column} column`);
        } catch (error) {
          // Ignore duplicate column errors (race condition protection)
          if (!error.message.includes('duplicate column name')) {
            throw error;
          }
        }
      }
    };

    // Add repo_instructions column to analysis_runs if it doesn't exist
    addColumnIfNotExists('analysis_runs', 'repo_instructions', 'TEXT');

    // Add request_instructions column to analysis_runs if it doesn't exist
    addColumnIfNotExists('analysis_runs', 'request_instructions', 'TEXT');

    console.log('Migration to schema version 11 complete');
  },

  // Migration to version 12: adds head_sha column to analysis_runs for traceability
  12: (db) => {
    console.log('Running migration to schema version 12...');

    // Add head_sha column to analysis_runs if it doesn't exist
    const hasHeadSha = columnExists(db, 'analysis_runs', 'head_sha');
    if (!hasHeadSha) {
      try {
        db.prepare(`ALTER TABLE analysis_runs ADD COLUMN head_sha TEXT`).run();
        console.log('  Added head_sha column to analysis_runs');
      } catch (error) {
        // Ignore duplicate column errors (race condition protection)
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column head_sha already exists (race condition)');
      }
    } else {
      console.log('  Column head_sha already exists');
    }

    console.log('Migration to schema version 12 complete');
  },

  // Migration to version 13: adds github_reviews table for tracking GitHub review submissions
  13: (db) => {
    console.log('Running migration to schema version 13...');

    // Create github_reviews table if it doesn't exist
    if (!tableExists(db, 'github_reviews')) {
      db.exec(`
        CREATE TABLE github_reviews (
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
      `);
      console.log('  Created github_reviews table');

      // Create indexes
      db.exec('CREATE INDEX IF NOT EXISTS idx_github_reviews_review_id ON github_reviews(review_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_github_reviews_state ON github_reviews(state)');
      console.log('  Created indexes for github_reviews table');
    } else {
      console.log('  Table github_reviews already exists');
    }

    console.log('Migration to schema version 13 complete');
  },

  // Migration to version 14: adds name column to reviews and creates local_diffs table
  14: (db) => {
    console.log('Running migration to schema version 14...');

    // Add name column to reviews if it doesn't exist
    const hasName = columnExists(db, 'reviews', 'name');
    if (!hasName) {
      try {
        db.prepare(`ALTER TABLE reviews ADD COLUMN name TEXT`).run();
        console.log('  Added name column to reviews');
      } catch (error) {
        // Ignore duplicate column errors (race condition protection)
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column name already exists (race condition)');
      }
    } else {
      console.log('  Column name already exists');
    }

    // Create local_diffs table if it doesn't exist
    if (!tableExists(db, 'local_diffs')) {
      db.exec(`
        CREATE TABLE local_diffs (
          review_id INTEGER PRIMARY KEY,
          diff_text TEXT,
          stats TEXT,
          digest TEXT,
          captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
        )
      `);
      console.log('  Created local_diffs table');
    } else {
      console.log('  Table local_diffs already exists');
    }

    // Add index for listing local sessions (WHERE review_type = 'local' ORDER BY updated_at DESC)
    db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_type_updated ON reviews(review_type, updated_at DESC)');
    console.log('  Created index idx_reviews_type_updated');

    console.log('Migration to schema version 14 complete');
  },

  // Migration to version 15: adds councils table and voice tracking columns to comments
  15: (db) => {
    console.log('Running migration to schema version 15...');

    // Create councils table if it doesn't exist
    if (!tableExists(db, 'councils')) {
      db.exec(`
        CREATE TABLE councils (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          config JSON NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_councils_name ON councils(name)');
      console.log('  Created councils table');
    } else {
      console.log('  Table councils already exists');
    }

    // Add voice_id column to comments if it doesn't exist
    const hasVoiceId = columnExists(db, 'comments', 'voice_id');
    if (!hasVoiceId) {
      try {
        db.prepare(`ALTER TABLE comments ADD COLUMN voice_id TEXT`).run();
        db.exec('CREATE INDEX IF NOT EXISTS idx_comments_voice ON comments(voice_id)');
        console.log('  Added voice_id column to comments');
      } catch (error) {
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column voice_id already exists (race condition)');
      }
    } else {
      console.log('  Column voice_id already exists');
    }

    // Add is_raw column to comments if it doesn't exist
    const hasIsRaw = columnExists(db, 'comments', 'is_raw');
    if (!hasIsRaw) {
      try {
        db.prepare(`ALTER TABLE comments ADD COLUMN is_raw INTEGER DEFAULT 0`).run();
        db.exec('CREATE INDEX IF NOT EXISTS idx_comments_is_raw ON comments(is_raw)');
        console.log('  Added is_raw column to comments');
      } catch (error) {
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column is_raw already exists (race condition)');
      }
    } else {
      console.log('  Column is_raw already exists');
    }

    console.log('Migration to schema version 15 complete');
  },

  // Migration to version 16: Add council MRU tracking and repo default council
  16: (db) => {
    console.log('Running migration to schema version 16...');

    // Add last_used_at column to councils for MRU ordering
    const hasLastUsedAt = columnExists(db, 'councils', 'last_used_at');
    if (!hasLastUsedAt) {
      try {
        db.prepare(`ALTER TABLE councils ADD COLUMN last_used_at DATETIME`).run();
        console.log('  Added last_used_at column to councils');
      } catch (error) {
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column last_used_at already exists (race condition)');
      }
    } else {
      console.log('  Column last_used_at already exists');
    }

    // Add default_council_id column to repo_settings
    const hasDefaultCouncilId = columnExists(db, 'repo_settings', 'default_council_id');
    if (!hasDefaultCouncilId) {
      try {
        db.prepare(`ALTER TABLE repo_settings ADD COLUMN default_council_id TEXT`).run();
        console.log('  Added default_council_id column to repo_settings');
      } catch (error) {
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column default_council_id already exists (race condition)');
      }
    } else {
      console.log('  Column default_council_id already exists');
    }

    console.log('Migration to schema version 16 complete');
  },

  // Migration to version 17: Add voice-centric council columns and repo default_tab
  17: (db) => {
    console.log('Running migration to schema version 17...');

    // Add parent_run_id to analysis_runs for child voice runs
    const hasParentRunId = columnExists(db, 'analysis_runs', 'parent_run_id');
    if (!hasParentRunId) {
      try {
        db.prepare(`ALTER TABLE analysis_runs ADD COLUMN parent_run_id TEXT`).run();
        console.log('  Added parent_run_id column to analysis_runs');
      } catch (error) {
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column parent_run_id already exists (race condition)');
      }
    } else {
      console.log('  Column parent_run_id already exists');
    }

    // Add config_type to analysis_runs
    const hasConfigType = columnExists(db, 'analysis_runs', 'config_type');
    if (!hasConfigType) {
      try {
        db.prepare(`ALTER TABLE analysis_runs ADD COLUMN config_type TEXT DEFAULT 'single'`).run();
        console.log('  Added config_type column to analysis_runs');
      } catch (error) {
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column config_type already exists (race condition)');
      }
    } else {
      console.log('  Column config_type already exists');
    }

    // Add levels_config to analysis_runs
    const hasLevelsConfig = columnExists(db, 'analysis_runs', 'levels_config');
    if (!hasLevelsConfig) {
      try {
        db.prepare(`ALTER TABLE analysis_runs ADD COLUMN levels_config TEXT`).run();
        console.log('  Added levels_config column to analysis_runs');
      } catch (error) {
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column levels_config already exists (race condition)');
      }
    } else {
      console.log('  Column levels_config already exists');
    }

    // Add default_tab to repo_settings
    const hasDefaultTab = columnExists(db, 'repo_settings', 'default_tab');
    if (!hasDefaultTab) {
      try {
        db.prepare(`ALTER TABLE repo_settings ADD COLUMN default_tab TEXT`).run();
        console.log('  Added default_tab column to repo_settings');
      } catch (error) {
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column default_tab already exists (race condition)');
      }
    } else {
      console.log('  Column default_tab already exists');
    }

    // Add index for parent_run_id lookups
    try {
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_analysis_runs_parent ON analysis_runs(parent_run_id)`).run();
      console.log('  Created idx_analysis_runs_parent index');
    } catch (error) {
      console.log('  Index idx_analysis_runs_parent already exists');
    }

    console.log('Migration to schema version 17 complete');
  },

  // Migration to version 18: Add type column to councils table
  18: (db) => {
    console.log('Running migration to schema version 18...');

    // Add type column to councils for distinguishing 'council' (voice-centric) from 'advanced' (level-centric)
    const hasType = columnExists(db, 'councils', 'type');
    if (!hasType) {
      try {
        db.prepare(`ALTER TABLE councils ADD COLUMN type TEXT DEFAULT 'advanced'`).run();
        console.log('  Added type column to councils');
      } catch (error) {
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column type already exists (race condition)');
      }
    } else {
      console.log('  Column type already exists');
    }

    console.log('Migration to schema version 18 complete');
  },

  // Migration to version 19: adds reasoning column to comments for AI reasoning chains
  19: (db) => {
    console.log('Running migration to schema version 19...');

    const hasReasoning = columnExists(db, 'comments', 'reasoning');
    if (!hasReasoning) {
      try {
        db.prepare(`ALTER TABLE comments ADD COLUMN reasoning TEXT`).run();
        console.log('  Added reasoning column to comments');
      } catch (error) {
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column reasoning already exists (race condition)');
      }
    } else {
      console.log('  Column reasoning already exists');
    }

    console.log('Migration to schema version 19 complete');
  },

  // Migration to version 20: adds chat_sessions and chat_messages tables
  20: (db) => {
    console.log('Running migration to schema version 20...');

    // Create chat_sessions table if it doesn't exist
    if (!tableExists(db, 'chat_sessions')) {
      db.exec(`
        CREATE TABLE chat_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          review_id INTEGER NOT NULL,
          context_comment_id INTEGER,
          agent_session_id TEXT, -- Reserved: agent session ID for future reconnection support
          provider TEXT NOT NULL,
          model TEXT,
          status TEXT DEFAULT 'active' CHECK(status IN ('active', 'closed', 'error')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (review_id) REFERENCES reviews(id),
          FOREIGN KEY (context_comment_id) REFERENCES comments(id)
        )
      `);
      console.log('  Created chat_sessions table');

      // Create index
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_sessions_review ON chat_sessions(review_id)');
      console.log('  Created index for chat_sessions table');
    } else {
      console.log('  Table chat_sessions already exists');
    }

    // Create chat_messages table if it doesn't exist
    if (!tableExists(db, 'chat_messages')) {
      db.exec(`
        CREATE TABLE chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          type TEXT DEFAULT 'message',
          content TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
        )
      `);
      console.log('  Created chat_messages table');

      // Create index
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)');
      console.log('  Created index for chat_messages table');
    } else {
      console.log('  Table chat_messages already exists');
    }

    console.log('Migration to schema version 20 complete');
  },

  // Migration to version 21: adds type column to chat_messages for distinguishing context vs message
  21: (db) => {
    console.log('Running migration to schema version 21...');

    const hasType = columnExists(db, 'chat_messages', 'type');
    if (!hasType) {
      try {
        db.prepare(`ALTER TABLE chat_messages ADD COLUMN type TEXT DEFAULT 'message'`).run();
        console.log('  Added type column to chat_messages');
      } catch (error) {
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column type already exists (race condition)');
      }
    } else {
      console.log('  Column type already exists');
    }

    console.log('Migration to schema version 21 complete');
  },

  22: (db) => {
    console.log('Migrating to schema version 22: Add tier column to analysis_runs');

    const columns = db.prepare('PRAGMA table_info(analysis_runs)').all();
    if (!columns.some(c => c.name === 'tier')) {
      try {
        db.prepare('ALTER TABLE analysis_runs ADD COLUMN tier TEXT').run();
        console.log('  Added tier column to analysis_runs');
      } catch (error) {
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column tier already exists (race condition)');
      }
    } else {
      console.log('  Column tier already exists');
    }

    console.log('Migration to schema version 22 complete');
  },

  23: (db) => {
    console.log('Migrating to schema version 23: Add default_chat_instructions to repo_settings');

    const columns = db.prepare('PRAGMA table_info(repo_settings)').all();
    if (!columns.some(c => c.name === 'default_chat_instructions')) {
      try {
        db.prepare('ALTER TABLE repo_settings ADD COLUMN default_chat_instructions TEXT').run();
        console.log('  Added default_chat_instructions column to repo_settings');
      } catch (error) {
        if (!error.message.includes('duplicate column name')) {
          throw error;
        }
        console.log('  Column default_chat_instructions already exists (race condition)');
      }
    } else {
      console.log('  Column default_chat_instructions already exists');
    }

    console.log('Migration to schema version 23 complete');
  },

  // Migration to version 24: adds context_files table for pinning non-diff file ranges to the diff panel
  24: (db) => {
    console.log('Migrating to schema version 24: Add context_files table');

    if (!tableExists(db, 'context_files')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS context_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          review_id INTEGER NOT NULL,
          file TEXT NOT NULL,
          line_start INTEGER NOT NULL,
          line_end INTEGER NOT NULL,
          label TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_context_files_review ON context_files(review_id)');
      console.log('  Created context_files table');
    } else {
      console.log('  Table context_files already exists');
    }

    console.log('Migration to schema version 24 complete');
  }
};

/**
 * Get current schema version from database
 * @param {Database} db - Database instance
 * @returns {number} Current schema version (0 if not set)
 */
function getSchemaVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return row ? row.user_version : 0;
}

/**
 * Set schema version in database
 * @param {Database} db - Database instance
 * @param {number} version - Version to set
 */
function setSchemaVersion(db, version) {
  db.exec(`PRAGMA user_version = ${version}`);
}

/**
 * Run all pending migrations
 * @param {Database} db - Database instance
 */
function runVersionedMigrations(db) {
  const currentVersion = getSchemaVersion(db);

  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    console.log(`Database schema is up to date (version ${currentVersion})`);
    return;
  }

  console.log(`Database schema version: ${currentVersion}, target: ${CURRENT_SCHEMA_VERSION}`);

  // Run migrations sequentially
  for (let version = currentVersion + 1; version <= CURRENT_SCHEMA_VERSION; version++) {
    const migration = MIGRATIONS[version];
    if (migration) {
      migration(db);
      setSchemaVersion(db, version);
      console.log(`Database schema updated to version ${version}`);
    } else {
      console.warn(`Warning: No migration defined for version ${version}`);
    }
  }
}

/**
 * Initialize database with schema
 * @returns {Promise<Database>} - Database instance
 */
async function initializeDatabase(dbName) {
  if (dbName) {
    dbPath = path.join(getConfigDir(), dbName);
  }
  try {
    const db = new Database(getDbPath());
    // Enable foreign key enforcement (required for CASCADE to work)
    db.pragma('foreign_keys = ON');
    setupSchema(db);
    return db;
  } catch (error) {
    console.error('Database connection error:', error.message);

    // If database is corrupted, try to recreate it
    if (error.code === 'SQLITE_CORRUPT' || error.code === 'SQLITE_NOTADB') {
      console.log('Database appears corrupted, recreating with fresh schema...');
      await recreateDatabase();
      // Retry connection
      const newDb = new Database(getDbPath());
      // Enable foreign key enforcement (required for CASCADE to work)
      newDb.pragma('foreign_keys = ON');
      setupSchema(newDb);
      return newDb;
    }

    throw error;
  }
}

/**
 * Setup database schema and indexes
 * @param {Database} db - Database instance
 */
function setupSchema(db) {
  // Check current schema version before any changes
  const currentVersion = getSchemaVersion(db);
  const isFreshInstall = currentVersion === 0;

  // Create tables (only if they don't exist) - this is safe for both fresh and existing installs
  for (const sql of Object.values(SCHEMA_SQL)) {
    db.exec(sql);
  }

  // Run versioned migrations for existing databases
  // For fresh installs, tables already have all columns, so migrations are no-ops
  // but we still run them to ensure the schema version gets set correctly
  runVersionedMigrations(db);

  // Create indexes (only if they don't exist)
  for (const sql of INDEX_SQL) {
    db.exec(sql);
  }

  console.log(isFreshInstall
    ? `Created new database at: ${getDbPath()}`
    : `Connected to existing database at: ${getDbPath()}`);
}

/**
 * Recreate database from scratch
 */
async function recreateDatabase() {
  try {
    await fs.unlink(getDbPath());
    console.log('Removed corrupted database file');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Close database connection
 * @param {Database} db - Database instance
 */
function closeDatabase(db) {
  db.close();
  console.log('Database connection closed');
}

/**
 * Execute a database query
 *
 * Note: async is retained for backward compatibility with existing callers,
 * but the underlying better-sqlite3 operation is synchronous.
 *
 * @param {Database} db - Database instance
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<any>} - Query result
 */
async function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

/**
 * Execute a database query that returns a single row
 * @param {Database} db - Database instance
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<any>} - Query result
 */
async function queryOne(db, sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.get(...params);
}

/**
 * Execute a database query that modifies data
 * @param {Database} db - Database instance
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<any>} - Query result with lastID and changes
 */
async function run(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const result = stmt.run(...params);
  // Map lastInsertRowid to lastID for backward compatibility
  return { lastID: result.lastInsertRowid, changes: result.changes };
}

/**
 * Begin a database transaction
 * @param {Database} db - Database instance
 * @returns {Promise<void>}
 */
async function beginTransaction(db) {
  db.exec('BEGIN TRANSACTION');
}

/**
 * Commit a database transaction
 * @param {Database} db - Database instance
 * @returns {Promise<void>}
 */
async function commit(db) {
  db.exec('COMMIT');
}

/**
 * Rollback a database transaction
 * @param {Database} db - Database instance
 * @returns {Promise<void>}
 */
async function rollback(db) {
  try {
    db.exec('ROLLBACK');
  } catch (error) {
    // Log but don't reject - rollback failures are usually because
    // there's no active transaction (already rolled back or committed)
    console.warn('Rollback warning:', error.message);
  }
}

/**
 * Execute a function within a database transaction
 * Automatically commits on success or rolls back on error
 * @param {Database} db - Database instance
 * @param {Function} fn - Async function to execute within the transaction
 * @returns {Promise<any>} - Result of the function
 */
async function withTransaction(db, fn) {
  await beginTransaction(db);
  try {
    const result = await fn();
    await commit(db);
    return result;
  } catch (error) {
    await rollback(db);
    throw error;
  }
}

/**
 * Check database status and table counts (for debugging)
 * @param {Database} db - Database instance
 * @returns {Promise<Object>} Database status information
 */
async function getDatabaseStatus(db) {
  try {
    const tables = await query(db, `
      SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `);

    const status = { tables: {}, total_records: 0 };

    for (const table of tables) {
      const count = await queryOne(db, `SELECT COUNT(*) as count FROM ${table.name}`);
      status.tables[table.name] = count.count;
      status.total_records += count.count;
    }

    return status;
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Generate a worktree ID with pair-review prefix
 * Format: pair-review--{random} where random is alphanumeric
 * @param {number} length - Length of the random part (default: 3)
 * @returns {string} Worktree ID in format "pair-review--xyz"
 */
function generateWorktreeId(length = 3) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let randomPart = '';
  for (let i = 0; i < length; i++) {
    randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `pair-review--${randomPart}`;
}

/**
 * WorktreeRepository class for managing worktree database records
 */
class WorktreeRepository {
  /**
   * Create a new WorktreeRepository instance
   * @param {Database} db - Database instance
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Create a new worktree record
   * @param {Object} prInfo - PR information { prNumber, repository, branch, path }
   * @returns {Promise<Object>} Created worktree record
   */
  async create(prInfo) {
    const { prNumber, repository, branch, path: worktreePath } = prInfo;

    // Generate unique ID (retry if collision)
    let id;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      id = generateWorktreeId();
      const existing = await queryOne(this.db,
        'SELECT id FROM worktrees WHERE id = ?',
        [id]
      );
      if (!existing) break;
      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new Error('Failed to generate unique worktree ID after maximum attempts');
    }

    const now = new Date().toISOString();

    await run(this.db, `
      INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, prNumber, repository, branch, worktreePath, now, now]);

    return {
      id,
      pr_number: prNumber,
      repository,
      branch,
      path: worktreePath,
      created_at: now,
      last_accessed_at: now
    };
  }

  /**
   * Find a worktree by PR number and repository
   * @param {number} prNumber - Pull request number
   * @param {string} repository - Repository in owner/repo format
   * @returns {Promise<Object|null>} Worktree record or null if not found
   */
  async findByPR(prNumber, repository) {
    const row = await queryOne(this.db, `
      SELECT id, pr_number, repository, branch, path, created_at, last_accessed_at
      FROM worktrees
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, repository]);

    return row || null;
  }

  /**
   * Find a worktree by its ID
   * @param {string} id - Worktree ID
   * @returns {Promise<Object|null>} Worktree record or null if not found
   */
  async findById(id) {
    const row = await queryOne(this.db, `
      SELECT id, pr_number, repository, branch, path, created_at, last_accessed_at
      FROM worktrees
      WHERE id = ?
    `, [id]);

    return row || null;
  }

  /**
   * Update the last_accessed_at timestamp for a worktree
   * @param {string} id - Worktree ID
   * @returns {Promise<boolean>} True if record was updated
   */
  async updateLastAccessed(id) {
    const now = new Date().toISOString();
    const result = await run(this.db, `
      UPDATE worktrees
      SET last_accessed_at = ?
      WHERE id = ?
    `, [now, id]);

    return result.changes > 0;
  }

  /**
   * Find worktrees that haven't been accessed since a given date
   * @param {Date|string} olderThan - Date threshold (worktrees not accessed since this date)
   * @returns {Promise<Array<Object>>} Array of stale worktree records
   */
  async findStale(olderThan) {
    const dateStr = olderThan instanceof Date ? olderThan.toISOString() : olderThan;

    const rows = await query(this.db, `
      SELECT id, pr_number, repository, branch, path, created_at, last_accessed_at
      FROM worktrees
      WHERE last_accessed_at < ?
      ORDER BY last_accessed_at ASC
    `, [dateStr]);

    return rows;
  }

  /**
   * Delete a worktree record by ID
   * @param {string} id - Worktree ID
   * @returns {Promise<boolean>} True if record was deleted
   */
  async delete(id) {
    const result = await run(this.db, `
      DELETE FROM worktrees WHERE id = ?
    `, [id]);

    return result.changes > 0;
  }

  /**
   * List recently accessed worktrees
   * @param {number} limit - Maximum number of records to return (default: 10)
   * @returns {Promise<Array<Object>>} Array of worktree records ordered by last_accessed_at DESC
   */
  async listRecent(limit = 10) {
    const rows = await query(this.db, `
      SELECT id, pr_number, repository, branch, path, created_at, last_accessed_at
      FROM worktrees
      ORDER BY last_accessed_at DESC
      LIMIT ?
    `, [limit]);

    return rows;
  }

  /**
   * Update the path of an existing worktree record
   * @param {string} id - Worktree ID
   * @param {string} newPath - New filesystem path
   * @returns {Promise<boolean>} True if record was updated
   */
  async updatePath(id, newPath) {
    const now = new Date().toISOString();
    const result = await run(this.db, `
      UPDATE worktrees
      SET path = ?, last_accessed_at = ?
      WHERE id = ?
    `, [newPath, now, id]);

    return result.changes > 0;
  }

  /**
   * Get or create a worktree record (upsert-like behavior)
   * If a worktree exists for the PR, update its last_accessed_at and return it
   * Otherwise, create a new record
   * @param {Object} prInfo - PR information { prNumber, repository, branch, path }
   * @returns {Promise<Object>} Worktree record (existing or newly created)
   */
  async getOrCreate(prInfo) {
    const { prNumber, repository } = prInfo;

    // Check if worktree already exists
    const existing = await this.findByPR(prNumber, repository);

    if (existing) {
      // Update last_accessed_at and potentially the path
      const now = new Date().toISOString();
      await run(this.db, `
        UPDATE worktrees
        SET path = ?, branch = ?, last_accessed_at = ?
        WHERE id = ?
      `, [prInfo.path, prInfo.branch, now, existing.id]);

      return {
        ...existing,
        path: prInfo.path,
        branch: prInfo.branch,
        last_accessed_at: now
      };
    }

    // Create new record
    return this.create(prInfo);
  }

  /**
   * Count total worktrees in the database
   * @returns {Promise<number>} Total count
   */
  async count() {
    const result = await queryOne(this.db, 'SELECT COUNT(*) as count FROM worktrees');
    return result ? result.count : 0;
  }
}

/**
 * RepoSettingsRepository class for managing per-repository AI settings
 */
class RepoSettingsRepository {
  /**
   * Create a new RepoSettingsRepository instance
   * @param {Database} db - Database instance
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Get settings for a repository
   * @param {string} repository - Repository in owner/repo format
   * @returns {Promise<Object|null>} Settings object or null if not found
   */
  async getRepoSettings(repository) {
    const row = await queryOne(this.db, `
      SELECT id, repository, default_instructions, default_provider, default_model, default_council_id, default_tab, default_chat_instructions, local_path, created_at, updated_at
      FROM repo_settings
      WHERE repository = ? COLLATE NOCASE
    `, [repository]);

    return row || null;
  }

  /**
   * Get the known local path for a repository
   * @param {string} repository - Repository in owner/repo format
   * @returns {Promise<string|null>} Local path or null if not set
   */
  async getLocalPath(repository) {
    const row = await queryOne(this.db, `
      SELECT local_path FROM repo_settings WHERE repository = ? COLLATE NOCASE
    `, [repository]);

    return row ? row.local_path : null;
  }

  /**
   * Set or update the known local path for a repository
   * Creates a new repo_settings record if one doesn't exist
   * @param {string} repository - Repository in owner/repo format
   * @param {string|null} localPath - The git root directory path (or null to clear)
   * @returns {Promise<void>}
   */
  async setLocalPath(repository, localPath) {
    const now = new Date().toISOString();

    // Check if settings already exist
    const existing = await this.getRepoSettings(repository);

    if (existing) {
      // Update existing settings
      await run(this.db, `
        UPDATE repo_settings
        SET local_path = ?, updated_at = ?
        WHERE repository = ? COLLATE NOCASE
      `, [localPath, now, repository]);
    } else {
      // Insert new settings with just local_path
      await run(this.db, `
        INSERT INTO repo_settings (repository, local_path, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `, [repository, localPath, now, now]);
    }
  }

  /**
   * Save settings for a repository (upsert)
   * @param {string} repository - Repository in owner/repo format
   * @param {Object} settings - Settings object { default_instructions?, default_provider?, default_model?, local_path? }
   * @returns {Promise<Object>} Saved settings object
   */
  async saveRepoSettings(repository, settings) {
    const { default_instructions, default_provider, default_model, default_council_id, default_tab, default_chat_instructions, local_path } = settings;
    const now = new Date().toISOString();

    // Check if settings already exist
    const existing = await this.getRepoSettings(repository);

    if (existing) {
      // Update existing settings
      await run(this.db, `
        UPDATE repo_settings
        SET default_instructions = ?,
            default_provider = ?,
            default_model = ?,
            default_council_id = ?,
            default_tab = ?,
            default_chat_instructions = ?,
            local_path = ?,
            updated_at = ?
        WHERE repository = ? COLLATE NOCASE
      `, [
        default_instructions !== undefined ? default_instructions : existing.default_instructions,
        default_provider !== undefined ? default_provider : existing.default_provider,
        default_model !== undefined ? default_model : existing.default_model,
        default_council_id !== undefined ? default_council_id : existing.default_council_id,
        default_tab !== undefined ? default_tab : existing.default_tab,
        default_chat_instructions !== undefined ? default_chat_instructions : existing.default_chat_instructions,
        local_path !== undefined ? local_path : existing.local_path,
        now,
        repository
      ]);

      return {
        ...existing,
        default_instructions: default_instructions !== undefined ? default_instructions : existing.default_instructions,
        default_provider: default_provider !== undefined ? default_provider : existing.default_provider,
        default_model: default_model !== undefined ? default_model : existing.default_model,
        default_council_id: default_council_id !== undefined ? default_council_id : existing.default_council_id,
        default_tab: default_tab !== undefined ? default_tab : existing.default_tab,
        default_chat_instructions: default_chat_instructions !== undefined ? default_chat_instructions : existing.default_chat_instructions,
        local_path: local_path !== undefined ? local_path : existing.local_path,
        updated_at: now
      };
    } else {
      // Insert new settings
      const result = await run(this.db, `
        INSERT INTO repo_settings (repository, default_instructions, default_provider, default_model, default_council_id, default_tab, default_chat_instructions, local_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [repository, default_instructions || null, default_provider || null, default_model || null, default_council_id || null, default_tab || null, default_chat_instructions || null, local_path || null, now, now]);

      return {
        id: result.lastID,
        repository,
        default_instructions: default_instructions || null,
        default_provider: default_provider || null,
        default_model: default_model || null,
        default_council_id: default_council_id || null,
        default_tab: default_tab || null,
        default_chat_instructions: default_chat_instructions || null,
        local_path: local_path || null,
        created_at: now,
        updated_at: now
      };
    }
  }

  /**
   * Delete settings for a repository
   * @param {string} repository - Repository in owner/repo format
   * @returns {Promise<boolean>} True if settings were deleted
   */
  async deleteRepoSettings(repository) {
    const result = await run(this.db, `
      DELETE FROM repo_settings WHERE repository = ? COLLATE NOCASE
    `, [repository]);

    return result.changes > 0;
  }
}

/**
 * CommentRepository class for managing comment database records
 */
class CommentRepository {
  /**
   * Create a new CommentRepository instance
   * @param {Database} db - Database instance
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Create a line-level user comment
   * @param {Object} commentData - Comment data
   * @param {number} commentData.review_id - Review ID (from reviews table)
   * @param {string} commentData.file - File path
   * @param {number} commentData.line_start - Starting line number
   * @param {number} [commentData.line_end] - Ending line number (defaults to line_start)
   * @param {string} commentData.body - Comment body text
   * @param {number} [commentData.diff_position] - Diff position for GitHub API
   * @param {string} [commentData.side='RIGHT'] - Side of diff (LEFT or RIGHT)
   * @param {string} [commentData.commit_sha] - Commit SHA
   * @param {string} [commentData.type='comment'] - Comment type
   * @param {string} [commentData.title] - Comment title
   * @param {number} [commentData.parent_id] - Parent AI suggestion ID if adopted
   * @param {string} [commentData.author='Current User'] - Comment author
   * @returns {Promise<number>} Created comment ID
   */
  async createLineComment({
    review_id,
    file,
    line_start,
    line_end,
    body,
    diff_position = null,
    side = 'RIGHT',
    commit_sha = null,
    type = 'comment',
    title = null,
    parent_id = null,
    author = 'Current User'
  }) {
    // Validate required fields
    if (!review_id || !file || !line_start || !body) {
      throw new Error('Missing required fields: review_id, file, line_start, body');
    }

    // Validate side
    const validSide = side === 'LEFT' ? 'LEFT' : 'RIGHT';

    const result = await run(this.db, `
      INSERT INTO comments (
        review_id, source, author, file, line_start, line_end, diff_position, side, commit_sha,
        type, title, body, status, parent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      review_id,
      'user',
      author,
      file,
      line_start,
      line_end || line_start,
      diff_position,
      validSide,
      commit_sha,
      type,
      title,
      body.trim(),
      'active',
      parent_id
    ]);

    return result.lastID;
  }

  /**
   * Create a file-level user comment
   * @param {Object} commentData - Comment data
   * @param {number} commentData.review_id - Review ID (from reviews table)
   * @param {string} commentData.file - File path
   * @param {string} commentData.body - Comment body text
   * @param {string} [commentData.commit_sha] - Commit SHA
   * @param {string} [commentData.type='comment'] - Comment type
   * @param {string} [commentData.title] - Comment title
   * @param {number} [commentData.parent_id] - Parent AI suggestion ID if adopted
   * @param {string} [commentData.author='Current User'] - Comment author
   * @returns {Promise<number>} Created comment ID
   */
  async createFileComment({
    review_id,
    file,
    body,
    commit_sha = null,
    type = 'comment',
    title = null,
    parent_id = null,
    author = 'Current User'
  }) {
    // Validate required fields
    if (!review_id || !file || !body) {
      throw new Error('Missing required fields: review_id, file, body');
    }

    const result = await run(this.db, `
      INSERT INTO comments (
        review_id, source, author, file, line_start, line_end, diff_position, side, commit_sha,
        type, title, body, status, parent_id, is_file_level
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 1)
    `, [
      review_id,
      'user',
      author,
      file,
      commit_sha,
      type,
      title,
      body.trim(),
      'active',
      parent_id
    ]);

    return result.lastID;
  }

  /**
   * Adopt an AI suggestion as a user comment (with optional edits)
   * Creates a new user comment linked to the AI suggestion via parent_id
   * @param {number} suggestionId - AI suggestion comment ID
   * @param {string} editedBody - The adopted/edited comment body
   * @returns {Promise<number>} Created user comment ID
   */
  async adoptSuggestion(suggestionId, editedBody) {
    // Validate inputs
    if (!suggestionId || !editedBody || !editedBody.trim()) {
      throw new Error('Missing required fields: suggestionId, editedBody');
    }

    // Get the AI suggestion
    const suggestion = await queryOne(this.db, `
      SELECT * FROM comments WHERE id = ? AND source = 'ai'
    `, [suggestionId]);

    if (!suggestion) {
      throw new Error('AI suggestion not found');
    }

    if (suggestion.status !== 'active') {
      throw new Error('This suggestion has already been processed');
    }

    // Check for an existing inactive comment from a prior adoption cycle
    // (adopt → dismiss comment → restore suggestion → adopt again)
    const existingComment = await queryOne(this.db, `
      SELECT id FROM comments
      WHERE parent_id = ? AND source = 'user' AND status = 'inactive'
    `, [suggestionId]);

    if (existingComment) {
      // Reactivate the existing comment with the (possibly edited) body
      await run(this.db, `
        UPDATE comments
        SET status = 'active', body = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [editedBody.trim(), existingComment.id]);
      return existingComment.id;
    }

    // Create user comment preserving metadata from the suggestion
    const result = await run(this.db, `
      INSERT INTO comments (
        review_id, source, author, file, line_start, line_end,
        diff_position, side, commit_sha,
        type, title, body, status, parent_id, is_file_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      suggestion.review_id,
      'user',
      'Current User',
      suggestion.file,
      suggestion.line_start,
      suggestion.line_end,
      suggestion.diff_position,
      suggestion.side || 'RIGHT',
      suggestion.commit_sha,
      'comment',
      suggestion.title,
      editedBody.trim(),
      'active',
      suggestionId,
      suggestion.is_file_level || 0
    ]);

    return result.lastID;
  }

  /**
   * Update AI suggestion status and link to adopted comment
   * @param {number} suggestionId - AI suggestion comment ID
   * @param {string} status - New status ('adopted', 'dismissed', 'active')
   * @param {number} [adoptedAsId] - ID of the user comment if adopted
   * @returns {Promise<boolean>} True if updated successfully
   */
  async updateSuggestionStatus(suggestionId, status, adoptedAsId = null) {
    const validStatuses = ['adopted', 'dismissed', 'active'];
    if (!validStatuses.includes(status)) {
      throw new Error('Invalid status. Must be "adopted", "dismissed", or "active"');
    }

    // When restoring to active, clear adopted_as_id
    if (status === 'active') {
      const result = await run(this.db, `
        UPDATE comments
        SET status = ?, adopted_as_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [status, suggestionId]);
      return result.changes > 0;
    }

    // For adopted/dismissed, optionally set adopted_as_id
    const result = await run(this.db, `
      UPDATE comments
      SET status = ?, adopted_as_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [status, adoptedAsId, suggestionId]);

    return result.changes > 0;
  }

  /**
   * Get a single comment by ID
   * @param {number} id - Comment ID
   * @param {string} [source] - Optional filter by source ('user' or 'ai')
   * @returns {Promise<Object|null>} Comment record or null if not found
   */
  async getComment(id, source = null) {
    let sql = 'SELECT * FROM comments WHERE id = ?';
    const params = [id];

    if (source) {
      sql += ' AND source = ?';
      params.push(source);
    }

    return await queryOne(this.db, sql, params);
  }

  /**
   * Update a user comment's body
   * @param {number} id - Comment ID
   * @param {string} body - New comment body
   * @returns {Promise<boolean>} True if updated successfully
   */
  async updateComment(id, body) {
    if (!body || !body.trim()) {
      throw new Error('Comment body cannot be empty');
    }

    // Verify it's a user comment
    const comment = await this.getComment(id, 'user');
    if (!comment) {
      throw new Error('User comment not found');
    }

    const result = await run(this.db, `
      UPDATE comments
      SET body = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [body.trim(), id]);

    return result.changes > 0;
  }

  /**
   * Soft delete a user comment (set status to inactive)
   * If the comment was adopted from an AI suggestion (has parent_id),
   * the parent AI suggestion is automatically transitioned to 'dismissed' state.
   * @param {number} id - Comment ID
   * @returns {Promise<{deleted: boolean, dismissedSuggestionId: number|null}>} Result with deleted status and dismissed suggestion ID if applicable
   */
  async deleteComment(id) {
    // Verify it's a user comment
    const comment = await this.getComment(id, 'user');
    if (!comment) {
      throw new Error('User comment not found');
    }

    // Soft delete the user comment
    const result = await run(this.db, `
      UPDATE comments
      SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [id]);

    let dismissedSuggestionId = null;

    // If this comment was adopted from an AI suggestion, dismiss the parent suggestion
    if (comment.parent_id) {
      await this.updateSuggestionStatus(comment.parent_id, 'dismissed');
      dismissedSuggestionId = comment.parent_id;
    }

    return { deleted: result.changes > 0, dismissedSuggestionId };
  }

  /**
   * Bulk delete all user comments for a review
   * Also dismisses any AI suggestions that were parents of the deleted comments.
   * @param {number} reviewId - Review ID (from reviews table)
   * @returns {Promise<{deletedCount: number, dismissedSuggestionIds: number[]}>} Number of comments deleted and list of dismissed suggestion IDs
   */
  async bulkDeleteComments(reviewId) {
    // Implementation note: We use a two-query approach (SELECT then UPDATE) because:
    // 1. SQLite's RETURNING clause was added in v3.35 (2021) and may not be available
    //    on all systems, especially older deployments
    // 2. We need to return the dismissed suggestion IDs to the frontend so it can
    //    update the UI (collapse suggestions, update AI panel status)
    // 3. A single UPDATE with subquery would dismiss the suggestions but not return
    //    the IDs to the caller
    // The caller is responsible for wrapping this in a transaction if atomicity
    // with other operations is required.

    // First, find all user comments with parent_id (adopted from AI suggestions)
    const adoptedComments = await query(this.db, `
      SELECT parent_id FROM comments
      WHERE review_id = ? AND source = 'user' AND parent_id IS NOT NULL
        AND status IN ('active', 'submitted', 'draft')
    `, [reviewId]);

    // Soft delete all user comments
    const result = await run(this.db, `
      UPDATE comments
      SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE review_id = ? AND source = 'user' AND status IN ('active', 'submitted', 'draft')
    `, [reviewId]);

    // Dismiss all parent AI suggestions with a single UPDATE statement
    // Note: parent_id is already guaranteed non-null by the SQL query above
    // Use a Set to deduplicate IDs in case multiple user comments share the same parent
    const dismissedSuggestionIds = Array.from(
      new Set(adoptedComments.map(c => c.parent_id))
    );

    if (dismissedSuggestionIds.length > 0) {
      const placeholders = dismissedSuggestionIds.map(() => '?').join(',');
      await run(this.db, `
        UPDATE comments
        SET status = 'dismissed', updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
      `, dismissedSuggestionIds);
    }

    return { deletedCount: result.changes, dismissedSuggestionIds };
  }

  /**
   * Get all user comments for a review
   * @param {number} reviewId - Review ID (from reviews table)
   * @param {Object} [options] - Query options
   * @param {boolean} [options.includeDismissed=false] - Include dismissed (inactive) comments
   * @returns {Promise<Array<Object>>} Array of comment records
   */
  async getUserComments(reviewId, options = {}) {
    const { includeDismissed = false } = options;
    const statusFilter = includeDismissed
      ? "status IN ('active', 'submitted', 'draft', 'inactive')"
      : "status IN ('active', 'submitted', 'draft')";

    return await query(this.db, `
      SELECT
        id,
        source,
        author,
        file,
        line_start,
        line_end,
        side,
        diff_position,
        type,
        title,
        body,
        status,
        parent_id,
        is_file_level,
        created_at,
        updated_at
      FROM comments
      WHERE review_id = ? AND source = 'user' AND ${statusFilter}
      ORDER BY file, line_start, created_at
    `, [reviewId]);
  }

  /**
   * Restore a soft-deleted user comment (set status from 'inactive' back to 'active')
   * @param {number} id - Comment ID
   * @returns {Promise<boolean>} True if restored successfully
   */
  async restoreComment(id) {
    // Verify it's a user comment with inactive status
    const comment = await queryOne(this.db, `
      SELECT id, status FROM comments WHERE id = ? AND source = 'user'
    `, [id]);

    if (!comment) {
      throw new Error('User comment not found');
    }

    if (comment.status !== 'inactive') {
      throw new Error('Comment is not dismissed');
    }

    const result = await run(this.db, `
      UPDATE comments
      SET status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [id]);

    return result.changes > 0;
  }

  /**
   * Bulk insert AI suggestions into the comments table
   * @param {number} reviewId - Review ID (from reviews table)
   * @param {string} runId - Analysis run ID
   * @param {Array<Object>} suggestions - Normalized suggestion array (with is_file_level already set)
   */
  async bulkInsertAISuggestions(reviewId, runId, suggestions, level = null) {
    // Normalize: convert single 'line' field to 'line_start'/'line_end'
    // Work with shallow copies to avoid mutating the caller's array
    const normalized = suggestions.map(s => ({ ...s }));
    for (const s of normalized) {
      if (s.line !== undefined && s.line_start === undefined) {
        s.line_start = s.line;
        s.line_end = s.line_end ?? s.line_start;
        delete s.line;
      }
    }

    for (const suggestion of normalized) {
      const body = suggestion.description +
        (suggestion.suggestion ? '\n\n**Suggestion:** ' + suggestion.suggestion : '');

      // File-level suggestions have is_file_level=true or have null line_start
      const isFileLevel = suggestion.is_file_level === true || suggestion.line_start === null ? 1 : 0;
      // Map old_or_new to database side column: OLD -> LEFT, NEW -> RIGHT
      // File-level suggestions (null old_or_new) default to RIGHT
      const side = suggestion.old_or_new === 'OLD' ? 'LEFT' : 'RIGHT';

      await run(this.db, `
        INSERT INTO comments (
          review_id, source, author, ai_run_id, ai_level, ai_confidence,
          file, line_start, line_end, side, type, title, body, reasoning, status, is_file_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        reviewId,
        'ai',
        'AI Assistant',
        runId,
        level,
        suggestion.confidence ?? null,
        suggestion.file,
        suggestion.line_start ?? null,
        suggestion.line_end ?? null,
        side,
        suggestion.type,
        suggestion.title,
        body,
        suggestion.reasoning ? JSON.stringify(suggestion.reasoning) : null,
        'active',
        isFileLevel
      ]);
    }
  }
}

/**
 * ReviewRepository class for managing review database records
 */
class ReviewRepository {
  /**
   * Create a new ReviewRepository instance
   * @param {Database} db - Database instance
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Create a new review record
   * @param {Object} reviewInfo - Review information
   * @param {number} reviewInfo.prNumber - Pull request number
   * @param {string} reviewInfo.repository - Repository in owner/repo format
   * @param {string} [reviewInfo.status='draft'] - Review status
   * @param {Object} [reviewInfo.reviewData] - Additional review data (will be JSON stringified)
   * @param {string} [reviewInfo.customInstructions] - Custom instructions used for AI analysis
   * @param {string} [reviewInfo.summary] - AI analysis summary
   * @returns {Promise<Object>} Created review record
   */
  async createReview({ prNumber, repository, status = 'draft', reviewData = null, customInstructions = null, summary = null }) {
    const result = await run(this.db, `
      INSERT INTO reviews (pr_number, repository, status, review_data, custom_instructions, summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      prNumber,
      repository,
      status,
      reviewData ? JSON.stringify(reviewData) : null,
      customInstructions,
      summary
    ]);

    return {
      id: result.lastID,
      pr_number: prNumber,
      repository,
      status,
      review_data: reviewData,
      custom_instructions: customInstructions,
      summary,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }

  /**
   * Update an existing review record
   * @param {number} id - Review ID
   * @param {Object} updates - Fields to update
   * @param {string} [updates.status] - Review status
   * @param {number} [updates.reviewId] - GitHub review ID after submission
   * @param {Object} [updates.reviewData] - Additional review data (will be JSON stringified)
   * @param {string} [updates.customInstructions] - Custom instructions used for AI analysis
   * @param {string} [updates.summary] - AI analysis summary
   * @param {Date|string} [updates.submittedAt] - Submission timestamp
   * @returns {Promise<boolean>} True if record was updated
   */
  async updateReview(id, updates) {
    const setClauses = [];
    const params = [];

    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      params.push(updates.status);
    }

    if (updates.reviewId !== undefined) {
      setClauses.push('review_id = ?');
      params.push(updates.reviewId);
    }

    if (updates.reviewData !== undefined) {
      setClauses.push('review_data = ?');
      params.push(updates.reviewData ? JSON.stringify(updates.reviewData) : null);
    }

    if (updates.customInstructions !== undefined) {
      setClauses.push('custom_instructions = ?');
      params.push(updates.customInstructions);
    }

    if (updates.summary !== undefined) {
      setClauses.push('summary = ?');
      params.push(updates.summary);
    }

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      params.push(updates.name);
    }

    if (updates.submittedAt !== undefined) {
      setClauses.push('submitted_at = ?');
      const submittedAt = updates.submittedAt instanceof Date
        ? updates.submittedAt.toISOString()
        : updates.submittedAt;
      params.push(submittedAt);
    }

    if (setClauses.length === 0) {
      return false;
    }

    // Always update updated_at
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const result = await run(this.db, `
      UPDATE reviews
      SET ${setClauses.join(', ')}
      WHERE id = ?
    `, params);

    return result.changes > 0;
  }

  /**
   * Get a review by its ID
   * @param {number} id - Review ID
   * @returns {Promise<Object|null>} Review record or null if not found
   */
  async getReview(id) {
    const row = await queryOne(this.db, `
      SELECT id, pr_number, repository, status, review_id,
             created_at, updated_at, submitted_at, review_data, custom_instructions, summary,
             review_type, local_path, local_head_sha
      FROM reviews
      WHERE id = ?
    `, [id]);

    if (!row) return null;

    // Parse review_data JSON if present
    return {
      ...row,
      review_data: row.review_data ? JSON.parse(row.review_data) : null
    };
  }

  /**
   * Get a review by PR number and repository
   * @param {number} prNumber - Pull request number
   * @param {string} repository - Repository in owner/repo format
   * @returns {Promise<Object|null>} Review record or null if not found
   */
  async getReviewByPR(prNumber, repository) {
    const row = await queryOne(this.db, `
      SELECT id, pr_number, repository, status, review_id,
             created_at, updated_at, submitted_at, review_data, custom_instructions, summary
      FROM reviews
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, repository]);

    if (!row) return null;

    // Parse review_data JSON if present
    return {
      ...row,
      review_data: row.review_data ? JSON.parse(row.review_data) : null
    };
  }

  /**
   * Get or create a review record (upsert-like behavior)
   * If a review exists for the PR, return it
   * Otherwise, create a new record
   * @param {Object} reviewInfo - Review information
   * @param {number} reviewInfo.prNumber - Pull request number
   * @param {string} reviewInfo.repository - Repository in owner/repo format
   * @param {Object} [reviewInfo.reviewData] - Additional review data
   * @param {string} [reviewInfo.customInstructions] - Custom instructions
   * @returns {Promise<Object>} Review record (existing or newly created)
   */
  async getOrCreate({ prNumber, repository, reviewData = null, customInstructions = null }) {
    const existing = await this.getReviewByPR(prNumber, repository);

    if (existing) {
      return existing;
    }

    return this.createReview({ prNumber, repository, reviewData, customInstructions });
  }

  /**
   * Upsert custom instructions for a review - creates if not exists, updates if exists
   * Uses SQLite's INSERT OR REPLACE for atomic operation
   * @param {number} prNumber - Pull request number
   * @param {string} repository - Repository in owner/repo format
   * @param {string} customInstructions - Custom instructions to save
   * @returns {Promise<Object>} The updated or created review record
   */
  async upsertCustomInstructions(prNumber, repository, customInstructions) {
    const existing = await this.getReviewByPR(prNumber, repository);

    if (existing) {
      await this.updateReview(existing.id, { customInstructions });
      return { ...existing, custom_instructions: customInstructions };
    }

    return this.createReview({ prNumber, repository, customInstructions });
  }

  /**
   * Update a review record after submission to GitHub
   *
   * This method is used after submitting a review (draft or final) to GitHub.
   * It updates the review record with the submission status and metadata.
   *
   * IMPORTANT: This method uses UPDATE, not INSERT OR REPLACE. Using INSERT OR REPLACE
   * would trigger a DELETE+INSERT sequence, which cascade-deletes all associated
   * comments and analysis_runs due to foreign key constraints.
   *
   * @param {number} id - Review ID (from reviews table)
   * @param {Object} submissionData - Submission result data
   * @param {string} submissionData.event - Review event type ('DRAFT', 'APPROVE', 'REQUEST_CHANGES', 'COMMENT')
   * @param {Object} submissionData.reviewData - Additional review metadata (github_node_id, github_url, comments_count, etc.)
   * @returns {Promise<boolean>} True if record was updated
   */
  async updateAfterSubmission(id, { event, reviewData }) {
    const now = new Date().toISOString();
    const status = event === 'DRAFT' ? 'draft' : 'submitted';

    // Note: reviews.review_id is legacy and no longer written.
    // GitHub review IDs are now tracked in the github_reviews table.
    if (event === 'DRAFT') {
      const result = await run(this.db, `
        UPDATE reviews
        SET status = ?, updated_at = ?, review_data = ?
        WHERE id = ?
      `, [status, now, JSON.stringify(reviewData), id]);

      return result.changes > 0;
    } else {
      const result = await run(this.db, `
        UPDATE reviews
        SET status = ?, updated_at = ?, submitted_at = ?, review_data = ?
        WHERE id = ?
      `, [status, now, now, JSON.stringify(reviewData), id]);

      return result.changes > 0;
    }
  }

  /**
   * Delete a review record by ID
   * @param {number} id - Review ID
   * @returns {Promise<boolean>} True if record was deleted
   */
  async deleteReview(id) {
    const result = await run(this.db, `
      DELETE FROM reviews WHERE id = ?
    `, [id]);

    return result.changes > 0;
  }

  /**
   * List reviews for a repository
   * @param {string} repository - Repository in owner/repo format
   * @param {number} [limit=50] - Maximum number of records to return
   * @returns {Promise<Array<Object>>} Array of review records
   */
  async listByRepository(repository, limit = 50) {
    const rows = await query(this.db, `
      SELECT id, pr_number, repository, status, review_id,
             created_at, updated_at, submitted_at, review_data, custom_instructions,
             review_type, local_path, local_head_sha, summary
      FROM reviews
      WHERE repository = ? COLLATE NOCASE
      ORDER BY updated_at DESC
      LIMIT ?
    `, [repository, limit]);

    return rows.map(row => ({
      ...row,
      review_data: row.review_data ? JSON.parse(row.review_data) : null
    }));
  }

  /**
   * Create or resume a local review session
   * Finds existing session by path+sha or creates a new one
   * @param {Object} context - Local review context
   * @param {string} context.localPath - Absolute path to the local repository
   * @param {string} context.localHeadSha - Current HEAD SHA of the repository
   * @param {string} context.repository - Repository identifier (can be derived from path)
   * @returns {Promise<number>} The review ID
   */
  async upsertLocalReview({ localPath, localHeadSha, repository }) {
    // Try to find existing local review by path and SHA
    const existing = await this.getLocalReview(localPath, localHeadSha);

    if (existing) {
      // Update the updated_at timestamp
      await run(this.db, `
        UPDATE reviews
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [existing.id]);
      return existing.id;
    }

    // Create new local review
    const result = await run(this.db, `
      INSERT INTO reviews (pr_number, repository, status, review_type, local_path, local_head_sha)
      VALUES (NULL, ?, 'draft', 'local', ?, ?)
    `, [repository, localPath, localHeadSha]);

    return result.lastID;
  }

  /**
   * Get a local review by path and HEAD SHA
   * @param {string} localPath - Absolute path to the local repository
   * @param {string} localHeadSha - Current HEAD SHA of the repository
   * @returns {Promise<Object|null>} Review record or null if not found
   */
  async getLocalReview(localPath, localHeadSha) {
    const row = await queryOne(this.db, `
      SELECT id, pr_number, repository, status, review_id,
             created_at, updated_at, submitted_at, review_data, custom_instructions,
             review_type, local_path, local_head_sha, summary, name
      FROM reviews
      WHERE review_type = 'local' AND local_path = ? AND local_head_sha = ?
    `, [localPath, localHeadSha]);

    if (!row) return null;

    return {
      ...row,
      review_data: row.review_data ? JSON.parse(row.review_data) : null
    };
  }

  /**
   * Get a local review by its database ID
   * @param {number} id - Review ID
   * @returns {Promise<Object|null>} Review record or null if not found
   */
  async getLocalReviewById(id) {
    const row = await queryOne(this.db, `
      SELECT id, pr_number, repository, status, review_id,
             created_at, updated_at, submitted_at, review_data, custom_instructions,
             review_type, local_path, local_head_sha, summary, name
      FROM reviews
      WHERE id = ? AND review_type = 'local'
    `, [id]);

    if (!row) return null;

    return {
      ...row,
      review_data: row.review_data ? JSON.parse(row.review_data) : null
    };
  }

  /**
   * Update the summary for a review
   * @param {number} id - Review ID
   * @param {string} summary - AI analysis summary
   * @returns {Promise<boolean>} True if record was updated
   */
  async updateSummary(id, summary) {
    return this.updateReview(id, { summary });
  }

  /**
   * Upsert summary for a review - creates if not exists, updates if exists
   * @param {number} prNumber - Pull request number
   * @param {string} repository - Repository in owner/repo format
   * @param {string} summary - AI analysis summary to save
   * @returns {Promise<Object>} The updated or created review record
   */
  async upsertSummary(prNumber, repository, summary) {
    const existing = await this.getReviewByPR(prNumber, repository);

    if (existing) {
      await this.updateReview(existing.id, { summary });
      return this.getReview(existing.id);
    }

    return this.createReview({ prNumber, repository, summary });
  }

  /**
   * List local review sessions with cursor-based pagination
   * @param {Object} options - Pagination options
   * @param {number} [options.limit=10] - Maximum number of sessions to return
   * @param {string} [options.before] - ISO timestamp cursor (return sessions updated before this)
   * @returns {Promise<{sessions: Array<Object>, hasMore: boolean}>}
   */
  async listLocalSessions({ limit = 10, before } = {}) {
    const params = [];
    let whereClause = "WHERE review_type = 'local'";

    if (before) {
      whereClause += ' AND updated_at < ?';
      params.push(before);
    }

    // Fetch one extra to determine hasMore
    params.push(limit + 1);

    const rows = await query(this.db, `
      SELECT id, name, repository, local_path, local_head_sha, created_at, updated_at
      FROM reviews
      ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ?
    `, params);

    const hasMore = rows.length > limit;
    const sessions = hasMore ? rows.slice(0, limit) : rows;

    return { sessions, hasMore };
  }

  /**
   * Save or update a local diff snapshot in the database
   * Uses INSERT OR REPLACE for upsert behavior
   * @param {number} reviewId - Review ID
   * @param {Object} diffData - Diff data to persist
   * @param {string} diffData.diff - The diff text content
   * @param {Object} diffData.stats - Stats object (will be JSON-stringified)
   * @param {string} [diffData.digest] - Content digest for staleness detection
   * @returns {Promise<void>}
   */
  async saveLocalDiff(reviewId, { diff, stats, digest }) {
    await run(this.db, `
      INSERT OR REPLACE INTO local_diffs (review_id, diff_text, stats, digest, captured_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [reviewId, diff || '', JSON.stringify(stats || {}), digest || null]);
  }

  /**
   * Get a persisted local diff from the database
   * @param {number} reviewId - Review ID
   * @returns {Promise<{diff: string, stats: Object, digest: string|null}|null>}
   */
  async getLocalDiff(reviewId) {
    const row = await queryOne(this.db, `
      SELECT diff_text, stats, digest FROM local_diffs WHERE review_id = ?
    `, [reviewId]);

    if (!row) return null;

    return {
      diff: row.diff_text || '',
      stats: row.stats ? JSON.parse(row.stats) : {},
      digest: row.digest || null
    };
  }

  /**
   * Delete a local review session and all associated data.
   * Only deletes DB records; does NOT remove files on disk.
   *
   * Because the schema uses ON DELETE CASCADE for foreign keys on local_diffs,
   * comments, and analysis_runs, deleting the review row cascades automatically.
   *
   * @param {number} reviewId - Review ID
   * @returns {Promise<boolean>} True if a record was deleted
   */
  async deleteLocalSession(reviewId) {
    const result = await run(this.db, `
      DELETE FROM reviews WHERE id = ? AND review_type = 'local'
    `, [reviewId]);
    return result.changes > 0;
  }
}

/**
 * Migrate existing worktrees from filesystem to database
 * Scans the worktrees directory and creates records for any worktrees not in the DB
 * @param {Database} db - Database instance
 * @param {string} worktreeBaseDir - Base directory for worktrees
 * @returns {Promise<Object>} Migration result with counts
 */
async function migrateExistingWorktrees(db, worktreeBaseDir) {
  const result = { migrated: 0, skipped: 0, errors: [] };

  try {
    // Check if worktree directory exists
    try {
      await fs.access(worktreeBaseDir);
    } catch (e) {
      // Directory doesn't exist, nothing to migrate
      return result;
    }

    // Get list of existing worktree directories
    const entries = await fs.readdir(worktreeBaseDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // New format worktrees use short alphanumeric IDs (like 'dfa', 'peh')
      // and are created with proper database records at creation time.
      // Legacy owner-repo-number directories can't be reliably migrated
      // because repos with dashes (like 'pair-review') are ambiguous.
      // Just skip everything - migration is no longer needed.
      result.skipped++;
    }
  } catch (error) {
    result.errors.push({ directory: 'root', error: error.message });
  }

  return result;
}

/**
 * PRMetadataRepository class for managing PR metadata database records
 */
class PRMetadataRepository {
  /**
   * Create a new PRMetadataRepository instance
   * @param {Database} db - Database instance
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Get PR metadata by PR number and repository
   * Returns the full pr_metadata record with parsed pr_data JSON
   * @param {number} prNumber - Pull request number
   * @param {string} repository - Repository in owner/repo format
   * @returns {Promise<Object|null>} PR metadata record or null if not found
   */
  async getByPR(prNumber, repository) {
    const row = await queryOne(this.db, `
      SELECT id, pr_number, repository, author, base_branch, head_branch,
             title, description, pr_data, last_ai_run_id, created_at, updated_at
      FROM pr_metadata
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, repository]);

    if (!row) return null;

    // Parse pr_data JSON and merge base_sha/head_sha into the record
    let prData = {};
    try {
      prData = row.pr_data ? JSON.parse(row.pr_data) : {};
    } catch (error) {
      console.warn('Error parsing PR data JSON:', error);
    }

    return {
      ...row,
      base_sha: prData.base_sha,
      head_sha: prData.head_sha,
      pr_data_parsed: prData
    };
  }

  /**
   * Update the last_ai_run_id for a PR metadata record
   * @param {number} id - PR metadata record ID
   * @param {string} runId - Analysis run ID
   * @returns {Promise<boolean>} True if record was updated
   */
  async updateLastAiRunId(id, runId) {
    const result = await run(this.db, `
      UPDATE pr_metadata SET last_ai_run_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [runId, id]);

    return result.changes > 0;
  }
}

/**
 * AnalysisRunRepository class for managing AI analysis run records
 */
class AnalysisRunRepository {
  /**
   * Create a new AnalysisRunRepository instance
   * @param {Database} db - Database instance
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Create a new analysis run record
   * @param {Object} runInfo - Run information
   * @param {string} runInfo.id - Unique run ID (UUID)
   * @param {number} runInfo.reviewId - Review ID (references reviews.id, works for both PR and local modes)
   * @param {string} [runInfo.provider] - AI provider (claude, gemini, etc.)
   * @param {string} [runInfo.model] - AI model name
   * @param {string} [runInfo.customInstructions] - Merged custom instructions (kept for backward compatibility)
   * @param {string} [runInfo.repoInstructions] - Repository-level instructions from repo_settings
   * @param {string} [runInfo.requestInstructions] - Request-level instructions from the analyze request
   * @param {string} [runInfo.headSha] - Git HEAD SHA at the time of analysis (PR head commit or local HEAD)
   * @param {string} [runInfo.status='running'] - Initial status (default 'running'; pass 'completed' for externally-produced results)
   * @returns {Promise<Object>} Created analysis run record
   */
  async create({ id, reviewId, provider = null, model = null, tier = null, customInstructions = null, repoInstructions = null, requestInstructions = null, headSha = null, status = 'running', parentRunId = null, configType = 'single', levelsConfig = null }) {
    const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
    const completedAt = isTerminal ? 'CURRENT_TIMESTAMP' : 'NULL';
    const levelsConfigJson = levelsConfig ? JSON.stringify(levelsConfig) : null;
    await run(this.db, `
      INSERT INTO analysis_runs (id, review_id, provider, model, tier, custom_instructions, repo_instructions, request_instructions, head_sha, status, completed_at, parent_run_id, config_type, levels_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${completedAt}, ?, ?, ?)
    `, [id, reviewId, provider, model, tier, customInstructions, repoInstructions, requestInstructions, headSha, status, parentRunId, configType, levelsConfigJson]);

    // Query back the inserted row to return actual database values (including timestamps)
    return await this.getById(id);
  }

  /**
   * Update an analysis run with completion data
   * @param {string} id - Analysis run ID
   * @param {Object} updates - Fields to update
   * @param {string} [updates.status] - New status
   * @param {string} [updates.summary] - Analysis summary
   * @param {number} [updates.totalSuggestions] - Total suggestions count
   * @param {number} [updates.filesAnalyzed] - Files analyzed count
   * @param {Object} [options] - Update options
   * @param {string} [options.skipIfStatus] - Skip the update if the record already has this status (prevents redundant writes)
   * @returns {Promise<boolean>} True if record was updated
   */
  async update(id, updates, options = {}) {
    const setClauses = [];
    const params = [];

    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      params.push(updates.status);

      // Set completed_at when status becomes terminal
      if (['completed', 'failed', 'cancelled'].includes(updates.status)) {
        setClauses.push('completed_at = CURRENT_TIMESTAMP');
      }
    }

    if (updates.summary !== undefined) {
      setClauses.push('summary = ?');
      params.push(updates.summary);
    }

    if (updates.totalSuggestions !== undefined) {
      setClauses.push('total_suggestions = ?');
      params.push(updates.totalSuggestions);
    }

    if (updates.filesAnalyzed !== undefined) {
      setClauses.push('files_analyzed = ?');
      params.push(updates.filesAnalyzed);
    }

    if (setClauses.length === 0) {
      return false;
    }

    params.push(id);

    let whereClause = 'WHERE id = ?';
    if (options.skipIfStatus) {
      whereClause += ' AND status != ?';
      params.push(options.skipIfStatus);
    }

    const result = await run(this.db, `
      UPDATE analysis_runs
      SET ${setClauses.join(', ')}
      ${whereClause}
    `, params);

    return result.changes > 0;
  }

  /**
   * Get an analysis run by ID
   * @param {string} id - Analysis run ID
   * @returns {Promise<Object|null>} Analysis run record or null
   */
  async getById(id) {
    const row = await queryOne(this.db, `
      SELECT id, review_id, provider, model, tier, custom_instructions, repo_instructions, request_instructions,
             head_sha, summary, status, total_suggestions, files_analyzed, started_at, completed_at,
             parent_run_id, config_type, levels_config
      FROM analysis_runs
      WHERE id = ?
    `, [id]);

    if (!row) return null;
    return row;
  }

  /**
   * Get analysis runs for a review, ordered by most recent first
   * @param {number} reviewId - Review ID (works for both PR and local modes)
   * @param {Object} [options] - Optional query options
   * @param {number} [options.limit] - Maximum number of runs to return
   * @returns {Promise<Array<Object>>} Array of analysis run records
   */
  async getByReviewId(reviewId, { limit } = {}) {
    const params = [reviewId];
    let sql = `
      SELECT id, review_id, provider, model, tier, custom_instructions, repo_instructions, request_instructions,
             head_sha, summary, status, total_suggestions, files_analyzed, started_at, completed_at,
             parent_run_id, config_type, levels_config
      FROM analysis_runs
      WHERE review_id = ?
      ORDER BY COALESCE(completed_at, started_at) DESC, CASE WHEN parent_run_id IS NULL THEN 0 ELSE 1 END, started_at DESC, id DESC`;
    if (limit) {
      sql += `\n      LIMIT ?`;
      params.push(limit);
    }
    return query(this.db, sql, params);
  }

  /**
   * Get the most recent analysis run for a review
   * @param {number} reviewId - Review ID (works for both PR and local modes)
   * @returns {Promise<Object|null>} Most recent analysis run or null
   */
  async getLatestByReviewId(reviewId) {
    const rows = await this.getByReviewId(reviewId, { limit: 1 });
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Get child runs for a parent council run, ordered by start time ascending
   * @param {string} parentRunId - Parent analysis run ID
   * @returns {Promise<Array<Object>>} Array of child analysis run records
   */
  async getChildRuns(parentRunId) {
    return query(this.db, `
      SELECT id, review_id, provider, model, tier, custom_instructions, repo_instructions, request_instructions,
             head_sha, summary, status, total_suggestions, files_analyzed, started_at, completed_at,
             parent_run_id, config_type, levels_config
      FROM analysis_runs
      WHERE parent_run_id = ?
      ORDER BY started_at ASC
    `, [parentRunId]);
  }

  /**
   * Delete an analysis run by ID
   * @param {string} id - Analysis run ID
   * @returns {Promise<boolean>} True if record was deleted
   */
  async delete(id) {
    const result = await run(this.db, `
      DELETE FROM analysis_runs WHERE id = ?
    `, [id]);

    return result.changes > 0;
  }

  /**
   * Delete all analysis runs for a review
   * @param {number} reviewId - Review ID (works for both PR and local modes)
   * @returns {Promise<number>} Number of records deleted
   */
  async deleteByReviewId(reviewId) {
    const result = await run(this.db, `
      DELETE FROM analysis_runs WHERE review_id = ?
    `, [reviewId]);

    return result.changes;
  }
}

/**
 * GitHubReviewRepository class for managing GitHub review submission records
 */
class GitHubReviewRepository {
  /**
   * Create a new GitHubReviewRepository instance
   * @param {Database} db - Database instance
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Create a new github_review record
   * @param {number} reviewId - Review ID (from reviews table)
   * @param {Object} data - GitHub review data
   * @param {string} [data.github_review_id] - GitHub's review ID
   * @param {string} [data.github_node_id] - GraphQL node ID
   * @param {string} [data.state='local'] - State: 'local', 'pending', or 'submitted'
   * @param {string} [data.event] - Event type: 'APPROVE', 'COMMENT', or 'REQUEST_CHANGES'
   * @param {string} [data.body] - Review body/summary
   * @param {Date|string} [data.submitted_at] - Submission timestamp
   * @param {string} [data.github_url] - GitHub URL for the review
   * @returns {Promise<Object>} Created github_review record
   */
  async create(reviewId, data = {}) {
    const {
      github_review_id = null,
      github_node_id = null,
      state = 'local',
      event = null,
      body = null,
      submitted_at = null,
      github_url = null
    } = data;

    const submittedAtStr = submitted_at instanceof Date
      ? submitted_at.toISOString()
      : submitted_at;

    const result = await run(this.db, `
      INSERT INTO github_reviews (review_id, github_review_id, github_node_id, state, event, body, submitted_at, github_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [reviewId, github_review_id, github_node_id, state, event, body, submittedAtStr, github_url]);

    return this.getById(result.lastID);
  }

  /**
   * Get a single github_review record by ID
   * @param {number} id - GitHub review record ID
   * @returns {Promise<Object|null>} GitHub review record or null if not found
   */
  async getById(id) {
    const row = await queryOne(this.db, `
      SELECT id, review_id, github_review_id, github_node_id, state, event, body, submitted_at, github_url, created_at
      FROM github_reviews
      WHERE id = ?
    `, [id]);

    return row || null;
  }

  /**
   * Get all github_reviews for a local review
   * @param {number} reviewId - Review ID (from reviews table)
   * @returns {Promise<Array<Object>>} Array of github_review records
   */
  async findByReviewId(reviewId) {
    return query(this.db, `
      SELECT id, review_id, github_review_id, github_node_id, state, event, body, submitted_at, github_url, created_at
      FROM github_reviews
      WHERE review_id = ?
      ORDER BY created_at DESC
    `, [reviewId]);
  }

  /**
   * Get pending drafts for a review
   * @param {number} reviewId - Review ID (from reviews table)
   * @returns {Promise<Array<Object>>} Array of pending github_review records
   */
  async findPendingByReviewId(reviewId) {
    return query(this.db, `
      SELECT id, review_id, github_review_id, github_node_id, state, event, body, submitted_at, github_url, created_at
      FROM github_reviews
      WHERE review_id = ? AND state = 'pending'
      ORDER BY created_at DESC
    `, [reviewId]);
  }

  /**
   * Find a github_review record by GitHub's GraphQL node ID
   * @param {number} reviewId - Review ID (from reviews table)
   * @param {string} githubNodeId - GitHub's GraphQL node ID for the review
   * @returns {Promise<Object|null>} GitHub review record or null if not found
   */
  async findByGitHubNodeId(reviewId, githubNodeId) {
    const row = await queryOne(this.db, `
      SELECT id, review_id, github_review_id, github_node_id, state, event, body, submitted_at, github_url, created_at
      FROM github_reviews
      WHERE review_id = ? AND github_node_id = ?
    `, [reviewId, githubNodeId]);

    return row || null;
  }

  /**
   * Update a github_review record
   * @param {number} id - GitHub review record ID
   * @param {Object} data - Fields to update
   * @param {string} [data.github_review_id] - GitHub's review ID
   * @param {string} [data.github_node_id] - GraphQL node ID
   * @param {string} [data.state] - State: 'local', 'pending', or 'submitted'
   * @param {string} [data.event] - Event type: 'APPROVE', 'COMMENT', or 'REQUEST_CHANGES'
   * @param {string} [data.body] - Review body/summary
   * @param {Date|string} [data.submitted_at] - Submission timestamp
   * @param {string} [data.github_url] - GitHub URL for the review
   * @returns {Promise<boolean>} True if record was updated
   */
  async update(id, data) {
    const setClauses = [];
    const params = [];

    if (data.github_review_id !== undefined) {
      setClauses.push('github_review_id = ?');
      params.push(data.github_review_id);
    }

    if (data.github_node_id !== undefined) {
      setClauses.push('github_node_id = ?');
      params.push(data.github_node_id);
    }

    if (data.state !== undefined) {
      setClauses.push('state = ?');
      params.push(data.state);
    }

    if (data.event !== undefined) {
      setClauses.push('event = ?');
      params.push(data.event);
    }

    if (data.body !== undefined) {
      setClauses.push('body = ?');
      params.push(data.body);
    }

    if (data.submitted_at !== undefined) {
      setClauses.push('submitted_at = ?');
      const submittedAtStr = data.submitted_at instanceof Date
        ? data.submitted_at.toISOString()
        : data.submitted_at;
      params.push(submittedAtStr);
    }

    if (data.github_url !== undefined) {
      setClauses.push('github_url = ?');
      params.push(data.github_url);
    }

    if (setClauses.length === 0) {
      return false;
    }

    params.push(id);

    const result = await run(this.db, `
      UPDATE github_reviews
      SET ${setClauses.join(', ')}
      WHERE id = ?
    `, params);

    return result.changes > 0;
  }
}

/**
 * CouncilRepository class for managing council configurations
 */
class CouncilRepository {
  /**
   * Create a new CouncilRepository instance
   * @param {Database} db - Database instance
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Create a new council
   * @param {Object} councilData - Council data
   * @param {string} councilData.id - Unique ID (UUID)
   * @param {string} councilData.name - Council name
   * @param {Object} councilData.config - Council configuration JSON
   * @param {string} [councilData.type='advanced'] - Council type ('council' for voice-centric, 'advanced' for level-centric)
   * @returns {Promise<Object>} Created council record
   */
  async create({ id, name, config, type = 'advanced' }) {
    if (!id || !name || !config) {
      throw new Error('Missing required fields: id, name, config');
    }

    const configJson = typeof config === 'string' ? config : JSON.stringify(config);

    await run(this.db, `
      INSERT INTO councils (id, name, type, config)
      VALUES (?, ?, ?, ?)
    `, [id, name, type, configJson]);

    return this.getById(id);
  }

  /**
   * Get a council by ID
   * @param {string} id - Council ID
   * @returns {Promise<Object|null>} Council record with parsed config, or null
   */
  async getById(id) {
    const row = await queryOne(this.db, `
      SELECT id, name, type, config, last_used_at, created_at, updated_at
      FROM councils
      WHERE id = ?
    `, [id]);

    if (!row) return null;
    return this._parseRow(row);
  }

  /**
   * List all councils
   * @returns {Promise<Array<Object>>} Array of council records with parsed configs
   */
  async list() {
    const rows = await query(this.db, `
      SELECT id, name, type, config, last_used_at, created_at, updated_at
      FROM councils
      ORDER BY last_used_at DESC NULLS LAST, updated_at DESC
    `);

    return rows.map(row => this._parseRow(row));
  }

  /**
   * Update the last_used_at timestamp for a council (for MRU tracking)
   * @param {string} id - Council ID
   * @returns {Promise<boolean>} True if record was updated (council exists)
   */
  async touchLastUsedAt(id) {
    const result = await run(this.db, `
      UPDATE councils SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?
    `, [id]);

    return result.changes > 0;
  }

  /**
   * Update a council
   * @param {string} id - Council ID
   * @param {Object} updates - Fields to update
   * @param {string} [updates.name] - New name
   * @param {Object} [updates.config] - New configuration
   * @param {string} [updates.type] - New type ('council' or 'advanced')
   * @returns {Promise<boolean>} True if record was updated
   */
  async update(id, updates) {
    const setClauses = ['updated_at = CURRENT_TIMESTAMP'];
    const params = [];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      params.push(updates.name);
    }

    if (updates.type !== undefined) {
      setClauses.push('type = ?');
      params.push(updates.type);
    }

    if (updates.config !== undefined) {
      setClauses.push('config = ?');
      const configJson = typeof updates.config === 'string' ? updates.config : JSON.stringify(updates.config);
      params.push(configJson);
    }

    params.push(id);

    const result = await run(this.db, `
      UPDATE councils
      SET ${setClauses.join(', ')}
      WHERE id = ?
    `, params);

    return result.changes > 0;
  }

  /**
   * Delete a council
   * @param {string} id - Council ID
   * @returns {Promise<boolean>} True if record was deleted
   */
  async delete(id) {
    const result = await run(this.db, `
      DELETE FROM councils WHERE id = ?
    `, [id]);

    return result.changes > 0;
  }

  /**
   * Parse a database row, converting JSON config string to object
   * @param {Object} row - Raw database row
   * @returns {Object} Row with parsed config
   * @private
   */
  _parseRow(row) {
    try {
      return {
        ...row,
        config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config
      };
    } catch (e) {
      return { ...row, config: {} };
    }
  }
}

/**
 * ContextFileRepository class for managing context file range records.
 * Context files allow pinning specific line ranges from non-diff files
 * into the diff panel for review.
 */
class ContextFileRepository {
  /**
   * Create a new ContextFileRepository instance
   * @param {Database} db - Database instance
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Add a context file range for a review
   * @param {number} reviewId - Review ID
   * @param {string} file - File path
   * @param {number} lineStart - Start line number
   * @param {number} lineEnd - End line number
   * @param {string|null} [label=null] - Optional label for the range
   * @returns {Promise<Object>} The newly created context file record
   */
  async add(reviewId, file, lineStart, lineEnd, label = null) {
    const result = await run(this.db, `
      INSERT INTO context_files (review_id, file, line_start, line_end, label)
      VALUES (?, ?, ?, ?, ?)
    `, [reviewId, file, lineStart, lineEnd, label]);

    return queryOne(this.db, `
      SELECT id, review_id, file, line_start, line_end, label, created_at
      FROM context_files
      WHERE id = ?
    `, [result.lastID]);
  }

  /**
   * Get all context file ranges for a review, ordered by id
   * @param {number} reviewId - Review ID
   * @returns {Promise<Array<Object>>} Array of context file records
   */
  async getByReviewId(reviewId) {
    return query(this.db, `
      SELECT id, review_id, file, line_start, line_end, label, created_at
      FROM context_files
      WHERE review_id = ?
      ORDER BY id
    `, [reviewId]);
  }

  /**
   * Get context file ranges for a specific file within a review, ordered by line_start
   * @param {number} reviewId - Review ID
   * @param {string} file - File path
   * @returns {Promise<Array<Object>>} Array of context file records
   */
  async getByReviewIdAndFile(reviewId, file) {
    return query(this.db, `
      SELECT id, review_id, file, line_start, line_end, label, created_at
      FROM context_files
      WHERE review_id = ? AND file = ?
      ORDER BY line_start
    `, [reviewId, file]);
  }

  /**
   * Update the line range of an existing context file record
   * @param {number} id - Context file record ID
   * @param {number} lineStart - New start line number
   * @param {number} lineEnd - New end line number
   * @returns {Promise<boolean>} True if record was updated
   */
  async updateRange(id, lineStart, lineEnd) {
    const result = await run(this.db, `
      UPDATE context_files SET line_start = ?, line_end = ? WHERE id = ?
    `, [lineStart, lineEnd, id]);

    return result.changes > 0;
  }

  /**
   * Remove a context file range by ID, scoped to a specific review
   * @param {number} id - Context file record ID
   * @param {number} reviewId - Review ID (ensures deletion is scoped to the correct review)
   * @returns {Promise<boolean>} True if record was deleted
   */
  async remove(id, reviewId) {
    const result = await run(this.db, `
      DELETE FROM context_files WHERE id = ? AND review_id = ?
    `, [id, reviewId]);

    return result.changes > 0;
  }

  /**
   * Remove all context file ranges for a review
   * @param {number} reviewId - Review ID
   * @returns {Promise<number>} Number of records deleted
   */
  async removeAll(reviewId) {
    const result = await run(this.db, `
      DELETE FROM context_files WHERE review_id = ?
    `, [reviewId]);

    return result.changes;
  }
}

module.exports = {
  initializeDatabase,
  closeDatabase,
  query,
  queryOne,
  run,
  beginTransaction,
  commit,
  rollback,
  withTransaction,
  getDatabaseStatus,
  getSchemaVersion,
  CURRENT_SCHEMA_VERSION,
  getDbPath,
  WorktreeRepository,
  RepoSettingsRepository,
  ReviewRepository,
  CommentRepository,
  PRMetadataRepository,
  AnalysisRunRepository,
  GitHubReviewRepository,
  CouncilRepository,
  ContextFileRepository,
  generateWorktreeId,
  migrateExistingWorktrees
};
