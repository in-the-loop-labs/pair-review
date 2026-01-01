const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs').promises;
const { getConfigDir } = require('./config');

const DB_PATH = path.join(getConfigDir(), 'database.db');

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
  'CREATE INDEX IF NOT EXISTS idx_worktrees_repo ON worktrees(repository)'
];

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
 * Run database migrations for existing databases
 * @param {sqlite3.Database} db - Database instance
 * @param {Function} callback - Callback function
 */
function runMigrations(db, callback) {
  // Check if diff_position column exists in comments table
  db.all(`PRAGMA table_info(comments)`, (error, columns) => {
    if (error) {
      return callback(error);
    }
    
    // Check if diff_position column exists
    const hasDiffPosition = columns && columns.some(col => col.name === 'diff_position');
    
    if (!hasDiffPosition) {
      console.log('Adding diff_position column to comments table...');
      db.run(`ALTER TABLE comments ADD COLUMN diff_position INTEGER`, (alterError) => {
        if (alterError && !alterError.message.includes('duplicate column name')) {
          console.error('Error adding diff_position column:', alterError.message);
          return callback(alterError);
        }
        console.log('Successfully added diff_position column');
        
        // Continue to check reviews table
        checkReviewsTableMigrations(db, callback);
      });
    } else {
      // Check reviews table migrations
      checkReviewsTableMigrations(db, callback);
    }
  });
}

/**
 * Check and run migrations for reviews table
 * @param {sqlite3.Database} db - Database instance
 * @param {Function} callback - Callback function
 */
function checkReviewsTableMigrations(db, callback) {
  // Check if review_id column exists in reviews table
  db.all(`PRAGMA table_info(reviews)`, (error, columns) => {
    if (error) {
      return callback(error);
    }

    // Check if review_id column exists
    const hasReviewId = columns && columns.some(col => col.name === 'review_id');

    if (!hasReviewId) {
      console.log('Adding review_id column to reviews table...');
      db.run(`ALTER TABLE reviews ADD COLUMN review_id INTEGER`, (alterError) => {
        if (alterError && !alterError.message.includes('duplicate column name')) {
          console.error('Error adding review_id column:', alterError.message);
          return callback(alterError);
        }
        console.log('Successfully added review_id column');
        checkCommentsSideMigration(db, callback);
      });
    } else {
      // Continue to next migration
      checkCommentsSideMigration(db, callback);
    }
  });
}

/**
 * Check and run migration for side column in comments table
 * The side field indicates LEFT (deleted lines) or RIGHT (added/context lines)
 * for proper GitHub API submission
 * @param {sqlite3.Database} db - Database instance
 * @param {Function} callback - Callback function
 */
function checkCommentsSideMigration(db, callback) {
  db.all(`PRAGMA table_info(comments)`, (error, columns) => {
    if (error) {
      return callback(error);
    }

    // Check if side column exists
    const hasSide = columns && columns.some(col => col.name === 'side');

    if (!hasSide) {
      console.log('Adding side column to comments table...');
      // Default to RIGHT since most comments are on added/context lines
      db.run(`ALTER TABLE comments ADD COLUMN side TEXT DEFAULT 'RIGHT' CHECK(side IN ('LEFT', 'RIGHT'))`, (alterError) => {
        if (alterError && !alterError.message.includes('duplicate column name')) {
          console.error('Error adding side column:', alterError.message);
          return callback(alterError);
        }
        console.log('Successfully added side column');
        callback(null);
      });
    } else {
      // No more migrations needed
      callback(null);
    }
  });
}

/**
 * Setup database schema and indexes
 * @param {sqlite3.Database} db - Database instance
 * @param {Function} resolve - Promise resolve function
 * @param {Function} reject - Promise reject function
 */
function setupSchema(db, resolve, reject) {
  db.serialize(() => {
    // Begin transaction
    db.run('BEGIN TRANSACTION');
    
    // Create tables (only if they don't exist)
    Object.values(SCHEMA_SQL).forEach(sql => {
      db.run(sql, (error) => {
        if (error) {
          console.error('Error creating table:', error.message);
          db.run('ROLLBACK');
          reject(error);
          return;
        }
      });
    });
    
    // Run migrations for existing databases
    runMigrations(db, (migrationError) => {
      if (migrationError) {
        console.error('Error running migrations:', migrationError.message);
        db.run('ROLLBACK');
        reject(migrationError);
        return;
      }
      
      // Create indexes (only if they don't exist)
      INDEX_SQL.forEach(sql => {
        db.run(sql, (error) => {
          if (error) {
            console.error('Error creating index:', error.message);
            db.run('ROLLBACK');
            reject(error);
            return;
          }
        });
      });
      
      // Commit transaction
      db.run('COMMIT', (error) => {
        if (error) {
          console.error('Error committing schema setup:', error.message);
          reject(error);
        } else {
          const isNew = !require('fs').existsSync(DB_PATH) || require('fs').statSync(DB_PATH).size === 0;
          console.log(isNew ? `Created new database at: ${DB_PATH}` : `Connected to existing database at: ${DB_PATH}`);
          resolve(db);
        }
      });
    });
  });
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
  getDatabaseStatus,
  DB_PATH,
  WorktreeRepository,
  generateWorktreeId,
  migrateExistingWorktrees
};