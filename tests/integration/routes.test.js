import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import sqlite3 from 'sqlite3';

/**
 * API Route Integration Tests
 *
 * These tests verify the API contract (request/response format, status codes,
 * error handling) rather than internal implementation. They should continue
 * to pass even when routes are refactored into separate files.
 *
 * External dependencies (GitHub API, Claude CLI, filesystem operations) are
 * mocked to ensure tests are fast, deterministic, and isolated.
 */

// Create mock instances that we can control
const mockGitHubClient = {
  fetchPullRequest: vi.fn().mockResolvedValue({
    title: 'Test PR',
    body: 'Test description',
    author: 'testuser',
    base_branch: 'main',
    head_branch: 'feature-branch',
    state: 'open',
    base_sha: 'abc123',
    head_sha: 'def456',
    node_id: 'PR_node123',
    html_url: 'https://github.com/owner/repo/pull/1',
    additions: 10,
    deletions: 5
  }),
  validateToken: vi.fn().mockResolvedValue(true),
  repositoryExists: vi.fn().mockResolvedValue(true),
  createReviewGraphQL: vi.fn().mockResolvedValue({
    id: 12345,
    html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-12345',
    comments_count: 2,
    submitted_at: new Date().toISOString(),
    state: 'APPROVED'
  }),
  createDraftReviewGraphQL: vi.fn().mockResolvedValue({
    id: 12346,
    html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-12346',
    comments_count: 2,
    state: 'PENDING'
  })
};

const mockWorktreeManager = {
  getWorktreePath: vi.fn().mockResolvedValue('/tmp/worktree/test'),
  worktreeExists: vi.fn().mockResolvedValue(true),
  generateUnifiedDiff: vi.fn().mockResolvedValue('diff --git a/file.js b/file.js\n--- a/file.js\n+++ b/file.js\n@@ -1,3 +1,4 @@\n+// New line\n line1\n line2\n line3'),
  getChangedFiles: vi.fn().mockResolvedValue([{ file: 'file.js', additions: 1, deletions: 0 }]),
  updateWorktree: vi.fn().mockResolvedValue('/tmp/worktree/test'),
  createWorktreeForPR: vi.fn().mockResolvedValue('/tmp/worktree/test'),
  pathExists: vi.fn().mockResolvedValue(true)
};

// Mock external dependencies before importing the routes
vi.mock('../../src/github/client', () => ({
  GitHubClient: vi.fn().mockImplementation(() => mockGitHubClient)
}));

vi.mock('../../src/git/worktree', () => ({
  GitWorktreeManager: vi.fn().mockImplementation(() => mockWorktreeManager)
}));

vi.mock('../../src/ai/analyzer', () => ({
  default: vi.fn().mockImplementation(() => ({
    analyzeLevel1: vi.fn().mockResolvedValue({
      suggestions: [
        { type: 'improvement', title: 'Test suggestion', file: 'file.js', line_start: 1 }
      ],
      level2Result: null
    }),
    analyzeLevel2: vi.fn().mockResolvedValue({
      suggestions: []
    }),
    analyzeLevel3: vi.fn().mockResolvedValue({
      suggestions: []
    })
  }))
}));

vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({
    isGenerated: vi.fn().mockReturnValue(false)
  })
}));

vi.mock('../../src/config', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    github_token: 'test-token',
    port: 3000,
    theme: 'light'
  }),
  saveConfig: vi.fn().mockResolvedValue(undefined),
  getConfigDir: vi.fn().mockReturnValue('/tmp/.pair-review')
}));

// Import the database utilities
const database = require('../../src/database.js');
const { query, queryOne, run, WorktreeRepository, RepoSettingsRepository, ReviewRepository } = database;

/**
 * Create an in-memory SQLite database with proper schema for testing.
 */
async function createTestDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', async (error) => {
      if (error) {
        reject(error);
        return;
      }

      try {
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
              default_model TEXT,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
          `
        };

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

        for (const sql of Object.values(SCHEMA_SQL)) {
          await new Promise((res, rej) => {
            db.run(sql, (err) => err ? rej(err) : res());
          });
        }

        for (const sql of INDEX_SQL) {
          await new Promise((res, rej) => {
            db.run(sql, (err) => err ? rej(err) : res());
          });
        }

        resolve(db);
      } catch (err) {
        reject(err);
      }
    });
  });
}

function closeTestDatabase(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

// Load the PR routes once (will use the mocked modules)
const prRoutes = require('../../src/routes/pr');

/**
 * Create a test Express app with the PR routes
 */
function createTestApp(db) {
  const app = express();
  app.use(express.json());

  // Set up app context like the real server
  app.set('db', db);
  app.set('githubToken', 'test-token');
  app.set('config', {
    github_token: 'test-token',
    port: 3000,
    theme: 'light',
    model: 'sonnet'
  });

  // Use the pre-loaded routes
  app.use('/', prRoutes);

  return app;
}

/**
 * Insert test PR data into the database
 */
async function insertTestPR(db, prNumber = 1, repository = 'owner/repo') {
  const prData = JSON.stringify({
    state: 'open',
    diff: 'diff content',
    changed_files: [{ file: 'file.js', additions: 1, deletions: 0 }],
    additions: 10,
    deletions: 5,
    html_url: `https://github.com/${repository}/pull/${prNumber}`,
    base_sha: 'abc123',
    head_sha: 'def456',
    node_id: 'PR_node123'
  });

  const result = await run(db, `
    INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [prNumber, repository, 'Test PR Title', 'Test Description', 'testuser', 'main', 'feature-branch', prData]);

  return result.lastID;
}

/**
 * Insert test worktree data
 */
async function insertTestWorktree(db, prNumber = 1, repository = 'owner/repo') {
  const now = new Date().toISOString();
  await run(db, `
    INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, ['abc', prNumber, repository, 'feature-branch', '/tmp/worktree/test', now, now]);
}

// ============================================================================
// PR Management Endpoint Tests
// ============================================================================

describe('PR Management Endpoints', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
    // Reset all mock implementations to their defaults
    vi.clearAllMocks();
    mockGitHubClient.createReviewGraphQL.mockResolvedValue({
      id: 12345,
      html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-12345',
      comments_count: 2,
      submitted_at: new Date().toISOString(),
      state: 'APPROVED'
    });
    mockGitHubClient.createDraftReviewGraphQL.mockResolvedValue({
      id: 12346,
      html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-12346',
      comments_count: 2,
      state: 'PENDING'
    });
  });

  describe('GET /api/pr/:owner/:repo/:number', () => {
    it('should return 400 for invalid PR number', async () => {
      const response = await request(app)
        .get('/api/pr/owner/repo/invalid');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid pull request number');
    });

    it('should return 400 for negative PR number', async () => {
      const response = await request(app)
        .get('/api/pr/owner/repo/-1');

      expect(response.status).toBe(400);
    });

    it('should return 404 for non-existent PR', async () => {
      const response = await request(app)
        .get('/api/pr/owner/repo/999');

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('should return PR data successfully', async () => {
      await insertTestPR(db, 1, 'owner/repo');

      const response = await request(app)
        .get('/api/pr/owner/repo/1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.number).toBe(1);
      expect(response.body.data.title).toBe('Test PR Title');
      expect(response.body.data.owner).toBe('owner');
      expect(response.body.data.repo).toBe('repo');
    });

    it('should include PR metadata in response', async () => {
      await insertTestPR(db, 1, 'owner/repo');

      const response = await request(app)
        .get('/api/pr/owner/repo/1');

      expect(response.body.data.author).toBe('testuser');
      expect(response.body.data.base_branch).toBe('main');
      expect(response.body.data.head_branch).toBe('feature-branch');
    });
  });

  describe('GET /api/pr/:owner/:repo/:number/diff', () => {
    it('should return 400 for invalid PR number', async () => {
      const response = await request(app)
        .get('/api/pr/owner/repo/invalid/diff');

      expect(response.status).toBe(400);
    });

    it('should return 404 when PR not found', async () => {
      const response = await request(app)
        .get('/api/pr/owner/repo/999/diff');

      expect(response.status).toBe(404);
    });

    it('should return diff data successfully', async () => {
      await insertTestPR(db, 1, 'owner/repo');
      await insertTestWorktree(db, 1, 'owner/repo');

      const response = await request(app)
        .get('/api/pr/owner/repo/1/diff');

      expect(response.status).toBe(200);
      expect(response.body.diff).toBeDefined();
      expect(response.body.changed_files).toBeDefined();
      expect(response.body.stats).toBeDefined();
    });
  });

  describe('GET /api/prs', () => {
    it('should return empty array when no PRs exist', async () => {
      const response = await request(app)
        .get('/api/prs');

      expect(response.status).toBe(200);
      expect(response.body.prs).toEqual([]);
      expect(response.body.pagination).toBeDefined();
    });

    it('should return PRs with pagination', async () => {
      await insertTestPR(db, 1, 'owner/repo1');
      await insertTestPR(db, 2, 'owner/repo2');

      const response = await request(app)
        .get('/api/prs?limit=10&offset=0');

      expect(response.status).toBe(200);
      expect(response.body.prs.length).toBe(2);
      expect(response.body.pagination.limit).toBe(10);
      expect(response.body.pagination.offset).toBe(0);
    });

    it('should respect limit parameter', async () => {
      await insertTestPR(db, 1, 'owner/repo1');
      await insertTestPR(db, 2, 'owner/repo2');
      await insertTestPR(db, 3, 'owner/repo3');

      const response = await request(app)
        .get('/api/prs?limit=2');

      expect(response.body.prs.length).toBe(2);
    });
  });
});

// ============================================================================
// User Comment Endpoint Tests
// ============================================================================

describe('User Comment Endpoints', () => {
  let db;
  let app;
  let prId;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
    prId = await insertTestPR(db, 1, 'owner/repo');
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('POST /api/user-comment', () => {
    it('should return 400 when required fields are missing', async () => {
      const response = await request(app)
        .post('/api/user-comment')
        .send({ pr_id: prId });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing required fields');
    });

    it('should return 404 when PR not found', async () => {
      const response = await request(app)
        .post('/api/user-comment')
        .send({
          pr_id: 9999,
          file: 'file.js',
          line_start: 10,
          body: 'Test comment'
        });

      expect(response.status).toBe(404);
    });

    it('should create user comment successfully', async () => {
      const response = await request(app)
        .post('/api/user-comment')
        .send({
          pr_id: prId,
          file: 'file.js',
          line_start: 10,
          line_end: 15,
          body: 'Test comment body'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.commentId).toBeDefined();
    });

    it('should create comment with optional fields', async () => {
      const response = await request(app)
        .post('/api/user-comment')
        .send({
          pr_id: prId,
          file: 'file.js',
          line_start: 10,
          body: 'Test comment',
          diff_position: 42,
          side: 'LEFT',
          commit_sha: 'abc123',
          type: 'suggestion',
          title: 'Test Title'
        });

      expect(response.status).toBe(200);

      // Verify the comment was stored correctly
      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [response.body.commentId]);
      expect(comment.side).toBe('LEFT');
      expect(comment.diff_position).toBe(42);
      expect(comment.type).toBe('suggestion');
    });
  });

  describe('GET /api/pr/:owner/:repo/:number/user-comments', () => {
    it('should return empty array when no comments exist', async () => {
      const response = await request(app)
        .get('/api/pr/owner/repo/1/user-comments');

      expect(response.status).toBe(200);
      expect(response.body.comments).toEqual([]);
    });

    it('should return user comments for PR', async () => {
      // Create a user comment
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'file.js', 10, 'Test comment', 'active')
      `, [prId]);

      const response = await request(app)
        .get('/api/pr/owner/repo/1/user-comments');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.comments.length).toBe(1);
      expect(response.body.comments[0].body).toBe('Test comment');
    });

    it('should not return inactive comments', async () => {
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'file.js', 10, 'Active comment', 'active')
      `, [prId]);
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'file.js', 20, 'Inactive comment', 'inactive')
      `, [prId]);

      const response = await request(app)
        .get('/api/pr/owner/repo/1/user-comments');

      expect(response.body.comments.length).toBe(1);
      expect(response.body.comments[0].body).toBe('Active comment');
    });
  });

  describe('PUT /api/user-comment/:id', () => {
    it('should return 400 when body is empty', async () => {
      const { lastID } = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'file.js', 10, 'Original', 'active')
      `, [prId]);

      const response = await request(app)
        .put(`/api/user-comment/${lastID}`)
        .send({ body: '' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('cannot be empty');
    });

    it('should return 404 for non-existent comment', async () => {
      const response = await request(app)
        .put('/api/user-comment/9999')
        .send({ body: 'Updated' });

      expect(response.status).toBe(404);
    });

    it('should return 404 for AI comment (not user)', async () => {
      const { lastID } = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'ai', 'file.js', 10, 'AI suggestion', 'active')
      `, [prId]);

      const response = await request(app)
        .put(`/api/user-comment/${lastID}`)
        .send({ body: 'Updated' });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('should update user comment successfully', async () => {
      const { lastID } = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'file.js', 10, 'Original comment', 'active')
      `, [prId]);

      const response = await request(app)
        .put(`/api/user-comment/${lastID}`)
        .send({ body: 'Updated comment' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify update in database
      const comment = await queryOne(db, 'SELECT body FROM comments WHERE id = ?', [lastID]);
      expect(comment.body).toBe('Updated comment');
    });
  });

  describe('DELETE /api/user-comment/:id', () => {
    it('should return 404 for non-existent comment', async () => {
      const response = await request(app)
        .delete('/api/user-comment/9999');

      expect(response.status).toBe(404);
    });

    it('should soft-delete user comment (set status to inactive)', async () => {
      const { lastID } = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'file.js', 10, 'To delete', 'active')
      `, [prId]);

      const response = await request(app)
        .delete(`/api/user-comment/${lastID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify soft delete (status should be inactive, not actually deleted)
      const comment = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [lastID]);
      expect(comment.status).toBe('inactive');
    });
  });

  describe('DELETE /api/pr/:owner/:repo/:number/user-comments', () => {
    it('should return 404 for non-existent PR', async () => {
      const response = await request(app)
        .delete('/api/pr/owner/repo/999/user-comments');

      expect(response.status).toBe(404);
    });

    it('should bulk delete all user comments for PR', async () => {
      // Create multiple comments
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'file1.js', 10, 'Comment 1', 'active')
      `, [prId]);
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'file2.js', 20, 'Comment 2', 'active')
      `, [prId]);

      const response = await request(app)
        .delete('/api/pr/owner/repo/1/user-comments');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.deletedCount).toBe(2);
    });
  });
});

// ============================================================================
// AI Suggestion Endpoint Tests
// ============================================================================

describe('AI Suggestion Endpoints', () => {
  let db;
  let app;
  let prId;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
    prId = await insertTestPR(db, 1, 'owner/repo');
    await insertTestWorktree(db, 1, 'owner/repo');
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
    vi.clearAllMocks();
  });

  describe('GET /api/pr/:owner/:repo/:number/ai-suggestions', () => {
    it('should return 404 for non-existent PR', async () => {
      const response = await request(app)
        .get('/api/pr/owner/repo/999/ai-suggestions');

      expect(response.status).toBe(404);
    });

    it('should return empty array when no suggestions exist', async () => {
      const response = await request(app)
        .get('/api/pr/owner/repo/1/ai-suggestions');

      expect(response.status).toBe(200);
      expect(response.body.suggestions).toEqual([]);
    });

    it('should return AI suggestions for PR', async () => {
      // Insert AI suggestion
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, type, title, body, status)
        VALUES (?, 'ai', 'file.js', 10, 'improvement', 'Test Suggestion', 'Suggestion body', 'active')
      `, [prId]);

      const response = await request(app)
        .get('/api/pr/owner/repo/1/ai-suggestions');

      expect(response.status).toBe(200);
      expect(response.body.suggestions.length).toBe(1);
      expect(response.body.suggestions[0].type).toBe('improvement');
    });

    it('should filter by levels query parameter', async () => {
      // Insert suggestions with different levels
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, ai_level, body, status)
        VALUES (?, 'ai', 'file.js', 10, 1, 'Level 1 suggestion', 'active')
      `, [prId]);
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, ai_level, body, status)
        VALUES (?, 'ai', 'file.js', 20, 2, 'Level 2 suggestion', 'active')
      `, [prId]);
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, ai_level, body, status)
        VALUES (?, 'ai', 'file.js', 30, NULL, 'Final suggestion', 'active')
      `, [prId]);

      // Filter for level 1 only
      const response = await request(app)
        .get('/api/pr/owner/repo/1/ai-suggestions?levels=1');

      expect(response.status).toBe(200);
      expect(response.body.suggestions.length).toBe(1);
      expect(response.body.suggestions[0].body).toBe('Level 1 suggestion');
    });

    it('should default to final suggestions when no levels specified', async () => {
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, ai_level, body, status)
        VALUES (?, 'ai', 'file.js', 10, 1, 'Level 1', 'active')
      `, [prId]);
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, ai_level, body, status)
        VALUES (?, 'ai', 'file.js', 20, NULL, 'Final', 'active')
      `, [prId]);

      const response = await request(app)
        .get('/api/pr/owner/repo/1/ai-suggestions');

      expect(response.body.suggestions.length).toBe(1);
      expect(response.body.suggestions[0].body).toBe('Final');
    });
  });

  describe('POST /api/ai-suggestion/:id/status', () => {
    it('should return 400 for invalid status', async () => {
      const { lastID } = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'ai', 'file.js', 10, 'Suggestion', 'active')
      `, [prId]);

      const response = await request(app)
        .post(`/api/ai-suggestion/${lastID}/status`)
        .send({ status: 'invalid_status' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid status');
    });

    it('should return 404 for non-existent suggestion', async () => {
      const response = await request(app)
        .post('/api/ai-suggestion/9999/status')
        .send({ status: 'dismissed' });

      expect(response.status).toBe(404);
    });

    it('should update suggestion status to dismissed', async () => {
      const { lastID } = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'ai', 'file.js', 10, 'Suggestion', 'active')
      `, [prId]);

      const response = await request(app)
        .post(`/api/ai-suggestion/${lastID}/status`)
        .send({ status: 'dismissed' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.status).toBe('dismissed');

      const suggestion = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [lastID]);
      expect(suggestion.status).toBe('dismissed');
    });

    it('should update suggestion status to adopted', async () => {
      const { lastID } = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'ai', 'file.js', 10, 'Suggestion', 'active')
      `, [prId]);

      const response = await request(app)
        .post(`/api/ai-suggestion/${lastID}/status`)
        .send({ status: 'adopted' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('adopted');
    });

    it('should restore suggestion to active and clear adopted_as_id', async () => {
      const { lastID } = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, adopted_as_id)
        VALUES (?, 'ai', 'file.js', 10, 'Suggestion', 'adopted', 999)
      `, [prId]);

      const response = await request(app)
        .post(`/api/ai-suggestion/${lastID}/status`)
        .send({ status: 'active' });

      expect(response.status).toBe(200);

      const suggestion = await queryOne(db, 'SELECT status, adopted_as_id FROM comments WHERE id = ?', [lastID]);
      expect(suggestion.status).toBe('active');
      expect(suggestion.adopted_as_id).toBeNull();
    });
  });

  describe('GET /api/pr/:owner/:repo/:number/has-ai-suggestions', () => {
    it('should return false when no suggestions exist', async () => {
      const response = await request(app)
        .get('/api/pr/owner/repo/1/has-ai-suggestions');

      expect(response.status).toBe(200);
      expect(response.body.hasSuggestions).toBe(false);
    });

    it('should return true when suggestions exist', async () => {
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'ai', 'file.js', 10, 'Suggestion', 'active')
      `, [prId]);

      const response = await request(app)
        .get('/api/pr/owner/repo/1/has-ai-suggestions');

      expect(response.status).toBe(200);
      expect(response.body.hasSuggestions).toBe(true);
    });
  });
});

// ============================================================================
// Review Submission Endpoint Tests
// ============================================================================

describe('Review Submission Endpoint', () => {
  let db;
  let app;
  let prId;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
    prId = await insertTestPR(db, 1, 'owner/repo');
    await insertTestWorktree(db, 1, 'owner/repo');
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
    vi.clearAllMocks();
  });

  describe('POST /api/pr/:owner/:repo/:number/submit-review', () => {
    it('should return 400 for invalid PR number', async () => {
      const response = await request(app)
        .post('/api/pr/owner/repo/invalid/submit-review')
        .send({ event: 'APPROVE' });

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid event type', async () => {
      const response = await request(app)
        .post('/api/pr/owner/repo/1/submit-review')
        .send({ event: 'INVALID_EVENT' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid review event');
    });

    it('should return 404 for non-existent PR', async () => {
      const response = await request(app)
        .post('/api/pr/owner/repo/999/submit-review')
        .send({ event: 'APPROVE' });

      expect(response.status).toBe(404);
    });

    it('should accept valid event types', async () => {
      // Test that valid event types are accepted (they pass validation)
      // Note: These may fail with 500 due to mocked GitHub API, but they shouldn't return 400
      const validEvents = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT', 'DRAFT'];

      for (const event of validEvents) {
        const response = await request(app)
          .post('/api/pr/owner/repo/1/submit-review')
          .send({ event, body: 'Test' });

        // Should not be a 400 validation error
        expect(response.status).not.toBe(400);
      }
    });

    it('should validate that comments are collected for submission', async () => {
      // Add user comments
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, diff_position, body, status)
        VALUES (?, 'user', 'file.js', 10, 5, 'Comment 1', 'active')
      `, [prId]);
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, diff_position, body, status)
        VALUES (?, 'user', 'file.js', 20, 10, 'Comment 2', 'active')
      `, [prId]);

      // Verify comments exist before submission attempt
      const comments = await query(db, `
        SELECT * FROM comments WHERE pr_id = ? AND source = 'user' AND status = 'active'
      `, [prId]);

      expect(comments.length).toBe(2);
    });

    it('should reject reviews with too many comments', async () => {
      // Insert more than 50 comments (GitHub API limit)
      for (let i = 0; i < 55; i++) {
        await run(db, `
          INSERT INTO comments (pr_id, source, file, line_start, diff_position, body, status)
          VALUES (?, 'user', 'file.js', ?, ?, 'Comment', 'active')
        `, [prId, i + 1, i + 1]);
      }

      const response = await request(app)
        .post('/api/pr/owner/repo/1/submit-review')
        .send({ event: 'APPROVE' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Too many comments');
    });
  });
});

// ============================================================================
// Config Endpoint Tests
// ============================================================================

describe('Config Endpoints', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
    vi.clearAllMocks();
  });

  describe('GET /api/config', () => {
    it('should return config without sensitive data', async () => {
      const response = await request(app)
        .get('/api/config');

      expect(response.status).toBe(200);
      expect(response.body.theme).toBeDefined();
      // Should NOT include github_token
      expect(response.body.github_token).toBeUndefined();
    });

    it('should return default values', async () => {
      const response = await request(app)
        .get('/api/config');

      expect(response.body.theme).toBe('light');
      expect(response.body.comment_button_action).toBe('submit');
    });
  });

  describe('PATCH /api/config', () => {
    it('should return 400 for invalid comment_button_action', async () => {
      const response = await request(app)
        .patch('/api/config')
        .send({ comment_button_action: 'invalid' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid comment_button_action');
    });

    it('should update comment_button_action to preview', async () => {
      const response = await request(app)
        .patch('/api/config')
        .send({ comment_button_action: 'preview' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.config.comment_button_action).toBe('preview');
    });

    it('should update comment_button_action to submit', async () => {
      const response = await request(app)
        .patch('/api/config')
        .send({ comment_button_action: 'submit' });

      expect(response.status).toBe(200);
      expect(response.body.config.comment_button_action).toBe('submit');
    });
  });
});

// ============================================================================
// Repository Settings Endpoint Tests
// ============================================================================

describe('Repository Settings Endpoints', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('GET /api/repos/:owner/:repo/settings', () => {
    it('should return null values when no settings exist', async () => {
      const response = await request(app)
        .get('/api/repos/owner/repo/settings');

      expect(response.status).toBe(200);
      expect(response.body.repository).toBe('owner/repo');
      expect(response.body.default_instructions).toBeNull();
      expect(response.body.default_model).toBeNull();
    });

    it('should return existing settings', async () => {
      const repoSettingsRepo = new RepoSettingsRepository(db);
      await repoSettingsRepo.saveRepoSettings('owner/repo', {
        default_instructions: 'Focus on security',
        default_model: 'claude-opus'
      });

      const response = await request(app)
        .get('/api/repos/owner/repo/settings');

      expect(response.status).toBe(200);
      expect(response.body.default_instructions).toBe('Focus on security');
      expect(response.body.default_model).toBe('claude-opus');
    });
  });

  describe('POST /api/repos/:owner/:repo/settings', () => {
    it('should return 400 when no settings provided', async () => {
      const response = await request(app)
        .post('/api/repos/owner/repo/settings')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('At least one setting');
    });

    it('should save default_instructions', async () => {
      const response = await request(app)
        .post('/api/repos/owner/repo/settings')
        .send({ default_instructions: 'Be thorough' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.settings.default_instructions).toBe('Be thorough');
    });

    it('should save default_model', async () => {
      const response = await request(app)
        .post('/api/repos/owner/repo/settings')
        .send({ default_model: 'sonnet' });

      expect(response.status).toBe(200);
      expect(response.body.settings.default_model).toBe('sonnet');
    });

    it('should update existing settings', async () => {
      // Create initial settings
      await request(app)
        .post('/api/repos/owner/repo/settings')
        .send({ default_instructions: 'Initial' });

      // Update settings
      const response = await request(app)
        .post('/api/repos/owner/repo/settings')
        .send({ default_instructions: 'Updated' });

      expect(response.status).toBe(200);
      expect(response.body.settings.default_instructions).toBe('Updated');
    });
  });
});

// ============================================================================
// Health Check Endpoint Tests
// ============================================================================

describe('Health Check Endpoints', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('GET /api/pr/health', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/api/pr/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.service).toBe('pr-api');
      expect(response.body.timestamp).toBeDefined();
    });
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('Error Handling', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  it('should handle malformed JSON gracefully', async () => {
    const response = await request(app)
      .post('/api/user-comment')
      .set('Content-Type', 'application/json')
      .send('not valid json');

    expect(response.status).toBe(400);
  });

  it('should return consistent error format', async () => {
    const response = await request(app)
      .get('/api/pr/owner/repo/invalid');

    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty('error');
    expect(typeof response.body.error).toBe('string');
  });
});

// ============================================================================
// Analysis Status Endpoint Tests
// ============================================================================

describe('Analysis Status Endpoints', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
    vi.clearAllMocks();
  });

  describe('GET /api/pr/:owner/:repo/:number/analysis-status', () => {
    it('should return not running when no analysis in progress', async () => {
      const response = await request(app)
        .get('/api/pr/owner/repo/1/analysis-status');

      expect(response.status).toBe(200);
      expect(response.body.running).toBe(false);
      expect(response.body.analysisId).toBeNull();
    });
  });

  describe('GET /api/analyze/status/:id', () => {
    it('should return 404 for non-existent analysis', async () => {
      const response = await request(app)
        .get('/api/analyze/status/non-existent-id');

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });
  });
});
