const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs').promises;
const { getConfigDir } = require('./config');

const DB_PATH = path.join(getConfigDir(), 'database.db');

/**
 * Current schema version - increment this when adding new migrations
 */
const CURRENT_SCHEMA_VERSION = 2;

/**
 * Database schema SQL statements
 */
const SCHEMA_SQL = {
  reviews: `
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number INTEGER NOT NULL,
      repository TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'submitted', 'pending')),
      review_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      submitted_at DATETIME,
      review_data TEXT,
      custom_instructions TEXT,
      UNIQUE(pr_number, repository)
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
      pr_id INTEGER,
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

      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'dismissed', 'adopted', 'submitted', 'draft', 'inactive')),
      adopted_as_id INTEGER,
      parent_id INTEGER,

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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `
};

/**
 * Index SQL statements for performance
 */
const INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_number, repository)',
  'CREATE INDEX IF NOT EXISTS idx_comments_pr_file ON comments(pr_id, file, line_start)',
  'CREATE INDEX IF NOT EXISTS idx_comments_ai_run ON comments(ai_run_id)',
  'CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_metadata_unique ON pr_metadata(pr_number, repository)',
  'CREATE INDEX IF NOT EXISTS idx_worktrees_last_accessed ON worktrees(last_accessed_at)',
  'CREATE INDEX IF NOT EXISTS idx_worktrees_repo ON worktrees(repository)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_settings_repository ON repo_settings(repository)'
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
const MIGRATIONS = {
  // Migration to version 1: handles all legacy column additions
  1: async (db) => {
    console.log('Running migration to schema version 1...');

    // Helper to check if column exists
    const columnExists = async (table, column) => {
      return new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(${table})`, (error, columns) => {
          if (error) reject(error);
          else resolve(columns && columns.some(col => col.name === column));
        });
      });
    };

    // Helper to run SQL safely
    const runSql = (sql) => {
      return new Promise((resolve, reject) => {
        db.run(sql, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    };

    // Helper to add column if not exists (idempotent)
    const addColumnIfNotExists = async (table, column, definition) => {
      const exists = await columnExists(table, column);
      if (!exists) {
        console.log(`  Adding ${column} column to ${table} table...`);
        try {
          await runSql(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
          console.log(`  Successfully added ${column} column`);
        } catch (error) {
          // Ignore duplicate column errors (race condition protection)
          if (!error.message.includes('duplicate column name')) {
            throw error;
          }
        }
      }
    };

    // Helper to check if table exists
    const tableExists = async (tableName) => {
      return new Promise((resolve, reject) => {
        db.get(
          `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
          [tableName],
          (error, row) => {
            if (error) reject(error);
            else resolve(!!row);
          }
        );
      });
    };

    // Add columns to comments table
    await addColumnIfNotExists('comments', 'diff_position', 'INTEGER');
    await addColumnIfNotExists('comments', 'side', "TEXT DEFAULT 'RIGHT'");
    await addColumnIfNotExists('comments', 'commit_sha', 'TEXT');

    // Add columns to reviews table
    await addColumnIfNotExists('reviews', 'review_id', 'INTEGER');
    await addColumnIfNotExists('reviews', 'custom_instructions', 'TEXT');

    // Create repo_settings table if not exists
    const hasRepoSettings = await tableExists('repo_settings');
    if (!hasRepoSettings) {
      console.log('  Creating repo_settings table...');
      await runSql(SCHEMA_SQL.repo_settings);
      console.log('  Successfully created repo_settings table');
    }

    console.log('Migration to schema version 1 complete');
  },

  // Migration to version 2: adds default_provider column to repo_settings
  2: async (db) => {
    console.log('Running migration to schema version 2...');

    // Helper to check if column exists
    const columnExists = async (table, column) => {
      return new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(${table})`, (error, rows) => {
          if (error) reject(error);
          else resolve(rows ? rows.some(row => row.name === column) : false);
        });
      });
    };

    // Add default_provider column to repo_settings if it doesn't exist
    const hasDefaultProvider = await columnExists('repo_settings', 'default_provider');
    if (!hasDefaultProvider) {
      await new Promise((resolve, reject) => {
        db.run(`ALTER TABLE repo_settings ADD COLUMN default_provider TEXT`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      console.log('  Added default_provider column to repo_settings');
    }

    console.log('Migration to schema version 2 complete');
  }
};

/**
 * Get current schema version from database
 * @param {sqlite3.Database} db - Database instance
 * @returns {Promise<number>} Current schema version (0 if not set)
 */
function getSchemaVersion(db) {
  return new Promise((resolve, reject) => {
    db.get('PRAGMA user_version', (error, row) => {
      if (error) reject(error);
      else resolve(row ? row.user_version : 0);
    });
  });
}

/**
 * Set schema version in database
 * @param {sqlite3.Database} db - Database instance
 * @param {number} version - Version to set
 * @returns {Promise<void>}
 */
function setSchemaVersion(db, version) {
  return new Promise((resolve, reject) => {
    db.run(`PRAGMA user_version = ${version}`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Run all pending migrations
 * @param {sqlite3.Database} db - Database instance
 * @returns {Promise<void>}
 */
async function runVersionedMigrations(db) {
  const currentVersion = await getSchemaVersion(db);

  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    console.log(`Database schema is up to date (version ${currentVersion})`);
    return;
  }

  console.log(`Database schema version: ${currentVersion}, target: ${CURRENT_SCHEMA_VERSION}`);

  // Run migrations sequentially
  for (let version = currentVersion + 1; version <= CURRENT_SCHEMA_VERSION; version++) {
    const migration = MIGRATIONS[version];
    if (migration) {
      await migration(db);
      await setSchemaVersion(db, version);
      console.log(`Database schema updated to version ${version}`);
    } else {
      console.warn(`Warning: No migration defined for version ${version}`);
    }
  }
}

/**
 * Initialize database with schema
 * @returns {Promise<sqlite3.Database>} - Database instance
 */
function initializeDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, async (error) => {
      if (error) {
        console.error('Database connection error:', error.message);
        
        // If database is corrupted, try to recreate it
        if (error.code === 'SQLITE_CORRUPT' || error.code === 'SQLITE_NOTADB') {
          console.log('Database appears corrupted, recreating with fresh schema...');
          try {
            await recreateDatabase();
            // Retry connection
            const newDb = new sqlite3.Database(DB_PATH, (retryError) => {
              if (retryError) {
                reject(retryError);
              } else {
                setupSchema(newDb, resolve, reject);
              }
            });
          } catch (recreateError) {
            reject(recreateError);
          }
        } else {
          reject(error);
        }
      } else {
        setupSchema(db, resolve, reject);
      }
    });
  });
}

/**
 * Setup database schema and indexes
 * @param {sqlite3.Database} db - Database instance
 * @param {Function} resolve - Promise resolve function
 * @param {Function} reject - Promise reject function
 */
async function setupSchema(db, resolve, reject) {
  try {
    // Check current schema version before any changes
    const currentVersion = await getSchemaVersion(db);
    const isFreshInstall = currentVersion === 0;

    // Create tables (only if they don't exist) - this is safe for both fresh and existing installs
    for (const sql of Object.values(SCHEMA_SQL)) {
      await new Promise((res, rej) => {
        db.run(sql, (error) => {
          if (error) {
            console.error('Error creating table:', error.message);
            rej(error);
          } else {
            res();
          }
        });
      });
    }

    // Run versioned migrations for existing databases
    // For fresh installs, tables already have all columns, so migrations are no-ops
    // but we still run them to ensure the schema version gets set correctly
    await runVersionedMigrations(db);

    // Create indexes (only if they don't exist)
    for (const sql of INDEX_SQL) {
      await new Promise((res, rej) => {
        db.run(sql, (error) => {
          if (error) {
            console.error('Error creating index:', error.message);
            rej(error);
          } else {
            res();
          }
        });
      });
    }

    console.log(isFreshInstall
      ? `Created new database at: ${DB_PATH}`
      : `Connected to existing database at: ${DB_PATH}`);
    resolve(db);
  } catch (error) {
    console.error('Error in schema setup:', error.message);
    reject(error);
  }
}

/**
 * Recreate database from scratch
 */
async function recreateDatabase() {
  try {
    await fs.unlink(DB_PATH);
    console.log('Removed corrupted database file');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Close database connection
 * @param {sqlite3.Database} db - Database instance
 * @returns {Promise<void>}
 */
function closeDatabase(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) {
        reject(error);
      } else {
        console.log('Database connection closed');
        resolve();
      }
    });
  });
}

/**
 * Execute a database query
 * @param {sqlite3.Database} db - Database instance
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<any>} - Query result
 */
function query(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
      } else {
        resolve(rows);
      }
    });
  });
}

/**
 * Execute a database query that returns a single row
 * @param {sqlite3.Database} db - Database instance
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<any>} - Query result
 */
function queryOne(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
      } else {
        resolve(row);
      }
    });
  });
}

/**
 * Execute a database query that modifies data
 * @param {sqlite3.Database} db - Database instance
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<any>} - Query result with lastID and changes
 */
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(error) {
      if (error) {
        reject(error);
      } else {
        resolve({ lastID: this.lastID, changes: this.changes });
      }
    });
  });
}

/**
 * Begin a database transaction
 * @param {sqlite3.Database} db - Database instance
 * @returns {Promise<void>}
 */
function beginTransaction(db) {
  return new Promise((resolve, reject) => {
    db.run('BEGIN TRANSACTION', (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Commit a database transaction
 * @param {sqlite3.Database} db - Database instance
 * @returns {Promise<void>}
 */
function commit(db) {
  return new Promise((resolve, reject) => {
    db.run('COMMIT', (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Rollback a database transaction
 * @param {sqlite3.Database} db - Database instance
 * @returns {Promise<void>}
 */
function rollback(db) {
  return new Promise((resolve, reject) => {
    db.run('ROLLBACK', (error) => {
      if (error) {
        // Log but don't reject - rollback failures are usually because
        // there's no active transaction (already rolled back or committed)
        console.warn('Rollback warning:', error.message);
        resolve();
      } else {
        resolve();
      }
    });
  });
}

/**
 * Execute a function within a database transaction
 * Automatically commits on success or rolls back on error
 * @param {sqlite3.Database} db - Database instance
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
 * @param {sqlite3.Database} db - Database instance
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
 * Generate a random alphanumeric ID (beads-style)
 * @param {number} length - Length of the ID (default: 3)
 * @returns {string} Random alphanumeric ID
 */
function generateWorktreeId(length = 3) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * WorktreeRepository class for managing worktree database records
 */
class WorktreeRepository {
  /**
   * Create a new WorktreeRepository instance
   * @param {sqlite3.Database} db - Database instance
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
      WHERE pr_number = ? AND repository = ?
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
   * @param {sqlite3.Database} db - Database instance
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
      SELECT id, repository, default_instructions, default_provider, default_model, created_at, updated_at
      FROM repo_settings
      WHERE repository = ?
    `, [repository]);

    return row || null;
  }

  /**
   * Save settings for a repository (upsert)
   * @param {string} repository - Repository in owner/repo format
   * @param {Object} settings - Settings object { default_instructions?, default_provider?, default_model? }
   * @returns {Promise<Object>} Saved settings object
   */
  async saveRepoSettings(repository, settings) {
    const { default_instructions, default_provider, default_model } = settings;
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
            updated_at = ?
        WHERE repository = ?
      `, [
        default_instructions !== undefined ? default_instructions : existing.default_instructions,
        default_provider !== undefined ? default_provider : existing.default_provider,
        default_model !== undefined ? default_model : existing.default_model,
        now,
        repository
      ]);

      return {
        ...existing,
        default_instructions: default_instructions !== undefined ? default_instructions : existing.default_instructions,
        default_provider: default_provider !== undefined ? default_provider : existing.default_provider,
        default_model: default_model !== undefined ? default_model : existing.default_model,
        updated_at: now
      };
    } else {
      // Insert new settings
      const result = await run(this.db, `
        INSERT INTO repo_settings (repository, default_instructions, default_provider, default_model, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [repository, default_instructions || null, default_provider || null, default_model || null, now, now]);

      return {
        id: result.lastID,
        repository,
        default_instructions: default_instructions || null,
        default_provider: default_provider || null,
        default_model: default_model || null,
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
      DELETE FROM repo_settings WHERE repository = ?
    `, [repository]);

    return result.changes > 0;
  }
}

/**
 * ReviewRepository class for managing review database records
 */
class ReviewRepository {
  /**
   * Create a new ReviewRepository instance
   * @param {sqlite3.Database} db - Database instance
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
   * @returns {Promise<Object>} Created review record
   */
  async createReview({ prNumber, repository, status = 'draft', reviewData = null, customInstructions = null }) {
    const result = await run(this.db, `
      INSERT INTO reviews (pr_number, repository, status, review_data, custom_instructions)
      VALUES (?, ?, ?, ?, ?)
    `, [
      prNumber,
      repository,
      status,
      reviewData ? JSON.stringify(reviewData) : null,
      customInstructions
    ]);

    return {
      id: result.lastID,
      pr_number: prNumber,
      repository,
      status,
      review_data: reviewData,
      custom_instructions: customInstructions,
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
             created_at, updated_at, submitted_at, review_data, custom_instructions
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
             created_at, updated_at, submitted_at, review_data, custom_instructions
      FROM reviews
      WHERE pr_number = ? AND repository = ?
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
             created_at, updated_at, submitted_at, review_data, custom_instructions
      FROM reviews
      WHERE repository = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `, [repository, limit]);

    return rows.map(row => ({
      ...row,
      review_data: row.review_data ? JSON.parse(row.review_data) : null
    }));
  }
}

/**
 * Migrate existing worktrees from filesystem to database
 * Scans the worktrees directory and creates records for any worktrees not in the DB
 * @param {sqlite3.Database} db - Database instance
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
  DB_PATH,
  WorktreeRepository,
  RepoSettingsRepository,
  ReviewRepository,
  generateWorktreeId,
  migrateExistingWorktrees
};