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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      submitted_at DATETIME,
      review_data TEXT,
      UNIQUE(pr_number, repository)
    )
  `,
  
  comments: `
    CREATE TABLE IF NOT EXISTS comments (
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
  `
};

/**
 * Index SQL statements for performance
 */
const INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_number, repository)',
  'CREATE INDEX IF NOT EXISTS idx_comments_review ON comments(review_id)',
  'CREATE INDEX IF NOT EXISTS idx_comments_file ON comments(file_path, line_number)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_metadata_unique ON pr_metadata(pr_number, repository)'
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
        console.log(`Database initialized at: ${DB_PATH}`);
        resolve(db);
      }
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

module.exports = {
  initializeDatabase,
  closeDatabase,
  query,
  queryOne,
  run,
  getDatabaseStatus,
  DB_PATH
};