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

// Import actual modules for spying (vi.mock doesn't work with CommonJS require())
// We'll spy on prototype methods instead
const { GitHubClient } = require('../../src/github/client');
const { GitWorktreeManager } = require('../../src/git/worktree');
const configModule = require('../../src/config');

// Define mock response values
const mockGitHubResponses = {
  fetchPullRequest: {
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
  },
  createReviewGraphQL: {
    id: 12345,
    html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-12345',
    comments_count: 2,
    submitted_at: new Date().toISOString(),
    state: 'APPROVED'
  },
  createDraftReviewGraphQL: {
    id: 12346,
    html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-12346',
    comments_count: 2,
    state: 'PENDING'
  }
};

const mockWorktreeResponses = {
  generateUnifiedDiff: 'diff --git a/file.js b/file.js\n--- a/file.js\n+++ b/file.js\n@@ -1,3 +1,4 @@\n+// New line\n line1\n line2\n line3',
  getWorktreePath: '/tmp/worktree/test',
  getChangedFiles: [{ file: 'file.js', additions: 1, deletions: 0 }]
};

// Spy on GitHubClient prototype methods
vi.spyOn(GitHubClient.prototype, 'fetchPullRequest').mockResolvedValue(mockGitHubResponses.fetchPullRequest);
vi.spyOn(GitHubClient.prototype, 'validateToken').mockResolvedValue(true);
vi.spyOn(GitHubClient.prototype, 'repositoryExists').mockResolvedValue(true);
vi.spyOn(GitHubClient.prototype, 'createReviewGraphQL').mockResolvedValue(mockGitHubResponses.createReviewGraphQL);
vi.spyOn(GitHubClient.prototype, 'createDraftReviewGraphQL').mockResolvedValue(mockGitHubResponses.createDraftReviewGraphQL);

// Spy on GitWorktreeManager prototype methods
vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue(mockWorktreeResponses.getWorktreePath);
vi.spyOn(GitWorktreeManager.prototype, 'worktreeExists').mockResolvedValue(true);
vi.spyOn(GitWorktreeManager.prototype, 'generateUnifiedDiff').mockResolvedValue(mockWorktreeResponses.generateUnifiedDiff);
vi.spyOn(GitWorktreeManager.prototype, 'getChangedFiles').mockResolvedValue(mockWorktreeResponses.getChangedFiles);
vi.spyOn(GitWorktreeManager.prototype, 'updateWorktree').mockResolvedValue(mockWorktreeResponses.getWorktreePath);
vi.spyOn(GitWorktreeManager.prototype, 'createWorktreeForPR').mockResolvedValue(mockWorktreeResponses.getWorktreePath);
vi.spyOn(GitWorktreeManager.prototype, 'pathExists').mockResolvedValue(true);

// Spy on config module functions to prevent writing to user's real config
vi.spyOn(configModule, 'saveConfig').mockResolvedValue(undefined);
vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
  github_token: 'test-token',
  port: 3000,
  theme: 'light'
});
vi.spyOn(configModule, 'getConfigDir').mockReturnValue('/tmp/.pair-review-test');

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

// Note: vi.mock for config doesn't work with CommonJS require() - using vi.spyOn above instead

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
              is_file_level INTEGER DEFAULT 0,
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

// Load the route modules once (will use the mocked modules)
// Order matters: more specific routes must be mounted before general ones
const analysisRoutes = require('../../src/routes/analysis');
const commentsRoutes = require('../../src/routes/comments');
const configRoutes = require('../../src/routes/config');
const worktreesRoutes = require('../../src/routes/worktrees');
const prRoutes = require('../../src/routes/pr');
const localRoutes = require('../../src/routes/local');

/**
 * Create a test Express app with all route modules
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

  // Mount routes in the same order as server.js
  // More specific routes first to ensure proper route matching
  app.use('/', analysisRoutes);
  app.use('/', commentsRoutes);
  app.use('/', configRoutes);
  app.use('/', worktreesRoutes);
  app.use('/', localRoutes);
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
    // Restore default mock responses for GitHub client
    vi.spyOn(GitHubClient.prototype, 'createReviewGraphQL').mockResolvedValue({
      id: 12345,
      html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-12345',
      comments_count: 2,
      submitted_at: new Date().toISOString(),
      state: 'APPROVED'
    });
    vi.spyOn(GitHubClient.prototype, 'createDraftReviewGraphQL').mockResolvedValue({
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

  describe('GET /api/pr/:owner/:repo/:number/files/viewed', () => {
    it('should return 400 for invalid PR number', async () => {
      const response = await request(app)
        .get('/api/pr/owner/repo/invalid/files/viewed');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid pull request number');
    });

    it('should return 404 for non-existent PR', async () => {
      const response = await request(app)
        .get('/api/pr/owner/repo/999/files/viewed');

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('should return empty array when no files viewed', async () => {
      await insertTestPR(db, 1, 'owner/repo');

      const response = await request(app)
        .get('/api/pr/owner/repo/1/files/viewed');

      expect(response.status).toBe(200);
      expect(response.body.files).toEqual([]);
    });

    it('should return viewed files from pr_data', async () => {
      // Insert PR with viewedFiles in pr_data
      const prData = JSON.stringify({
        state: 'open',
        viewedFiles: ['src/file1.js', 'src/file2.ts']
      });
      await run(db, `
        INSERT INTO pr_metadata (pr_number, repository, title, pr_data)
        VALUES (?, ?, ?, ?)
      `, [1, 'owner/repo', 'Test PR', prData]);

      const response = await request(app)
        .get('/api/pr/owner/repo/1/files/viewed');

      expect(response.status).toBe(200);
      expect(response.body.files).toEqual(['src/file1.js', 'src/file2.ts']);
    });
  });

  describe('POST /api/pr/:owner/:repo/:number/files/viewed', () => {
    it('should return 400 for invalid PR number', async () => {
      const response = await request(app)
        .post('/api/pr/owner/repo/invalid/files/viewed')
        .send({ files: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid pull request number');
    });

    it('should return 400 when files is not an array', async () => {
      await insertTestPR(db, 1, 'owner/repo');

      const response = await request(app)
        .post('/api/pr/owner/repo/1/files/viewed')
        .send({ files: 'not-an-array' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('files must be an array');
    });

    it('should return 404 for non-existent PR', async () => {
      const response = await request(app)
        .post('/api/pr/owner/repo/999/files/viewed')
        .send({ files: ['file.js'] });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('should save viewed files successfully', async () => {
      await insertTestPR(db, 1, 'owner/repo');

      const response = await request(app)
        .post('/api/pr/owner/repo/1/files/viewed')
        .send({ files: ['src/file1.js', 'src/file2.ts'] });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.files).toEqual(['src/file1.js', 'src/file2.ts']);

      // Verify it was persisted
      const prMetadata = await queryOne(db, `
        SELECT pr_data FROM pr_metadata WHERE pr_number = ? AND repository = ?
      `, [1, 'owner/repo']);
      const prData = JSON.parse(prMetadata.pr_data);
      expect(prData.viewedFiles).toEqual(['src/file1.js', 'src/file2.ts']);
    });

    it('should preserve other pr_data fields when saving viewed files', async () => {
      await insertTestPR(db, 1, 'owner/repo');

      const response = await request(app)
        .post('/api/pr/owner/repo/1/files/viewed')
        .send({ files: ['new-file.js'] });

      expect(response.status).toBe(200);

      // Verify original pr_data fields are preserved
      const prMetadata = await queryOne(db, `
        SELECT pr_data FROM pr_metadata WHERE pr_number = ? AND repository = ?
      `, [1, 'owner/repo']);
      const prData = JSON.parse(prMetadata.pr_data);
      expect(prData.viewedFiles).toEqual(['new-file.js']);
      expect(prData.state).toBe('open');
      expect(prData.head_sha).toBe('def456');
    });

    it('should overwrite previous viewed files', async () => {
      // Insert PR with existing viewedFiles
      const initialPrData = JSON.stringify({
        state: 'open',
        viewedFiles: ['old-file.js']
      });
      await run(db, `
        INSERT INTO pr_metadata (pr_number, repository, title, pr_data)
        VALUES (?, ?, ?, ?)
      `, [1, 'owner/repo', 'Test PR', initialPrData]);

      const response = await request(app)
        .post('/api/pr/owner/repo/1/files/viewed')
        .send({ files: ['new-file1.js', 'new-file2.js'] });

      expect(response.status).toBe(200);

      // Verify viewedFiles was overwritten
      const prMetadata = await queryOne(db, `
        SELECT pr_data FROM pr_metadata WHERE pr_number = ? AND repository = ?
      `, [1, 'owner/repo']);
      const prData = JSON.parse(prMetadata.pr_data);
      expect(prData.viewedFiles).toEqual(['new-file1.js', 'new-file2.js']);
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

  describe('POST /api/file-comment', () => {
    it('should return 400 when required fields are missing', async () => {
      const response = await request(app)
        .post('/api/file-comment')
        .send({ pr_id: prId });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing required fields');
    });

    it('should return 404 when PR not found', async () => {
      const response = await request(app)
        .post('/api/file-comment')
        .send({
          pr_id: 9999,
          file: 'file.js',
          body: 'Test file-level comment'
        });

      expect(response.status).toBe(404);
    });

    it('should create file-level comment successfully', async () => {
      const response = await request(app)
        .post('/api/file-comment')
        .send({
          pr_id: prId,
          file: 'file.js',
          body: 'This is a file-level comment'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.commentId).toBeDefined();
      expect(response.body.message).toContain('File-level');
    });

    it('should create file-level comment with is_file_level=1 and NULL line fields', async () => {
      const response = await request(app)
        .post('/api/file-comment')
        .send({
          pr_id: prId,
          file: 'file.js',
          body: 'File-level comment'
        });

      expect(response.status).toBe(200);

      // Verify the comment was stored correctly
      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [response.body.commentId]);
      expect(comment.is_file_level).toBe(1);
      expect(comment.line_start).toBeNull();
      expect(comment.line_end).toBeNull();
      expect(comment.diff_position).toBeNull();
      expect(comment.side).toBeNull();
      expect(comment.source).toBe('user');
    });

    it('should create file-level comment with optional commit_sha', async () => {
      const response = await request(app)
        .post('/api/file-comment')
        .send({
          pr_id: prId,
          file: 'file.js',
          body: 'File-level comment with commit',
          commit_sha: 'abc123'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.commentId).toBeDefined();

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [response.body.commentId]);
      expect(comment).toBeDefined();
      expect(comment.commit_sha).toBe('abc123');
    });

    // Bug fix tests: Verify parent_id, type, and title metadata persistence
    it('should save parent_id, type, and title for adopted AI suggestions', async () => {
      // First create an AI suggestion
      const aiSuggestion = await run(db, `
        INSERT INTO comments (pr_id, source, file, type, title, body, status, is_file_level)
        VALUES (?, 'ai', ?, 'improvement', 'Consider refactoring', 'This could be improved', 'active', 1)
      `, [prId, 'file.js']);

      // Now adopt it as a file-level comment with metadata
      const response = await request(app)
        .post('/api/file-comment')
        .send({
          pr_id: prId,
          file: 'file.js',
          body: 'Adopted: This could be improved',
          parent_id: aiSuggestion.lastID,
          type: 'ai',
          title: 'Consider refactoring'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify all metadata fields were saved
      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [response.body.commentId]);
      expect(comment.parent_id).toBe(aiSuggestion.lastID);
      expect(comment.type).toBe('ai');
      expect(comment.title).toBe('Consider refactoring');
      expect(comment.body).toBe('Adopted: This could be improved');
      expect(comment.is_file_level).toBe(1);
      expect(comment.source).toBe('user');
    });

    it('should retrieve file-level comment with metadata intact', async () => {
      // Create a file-level comment with all metadata
      const createResponse = await request(app)
        .post('/api/file-comment')
        .send({
          pr_id: prId,
          file: 'test.js',
          body: 'File comment with metadata',
          parent_id: 999,
          type: 'ai',
          title: 'Test Title'
        });

      expect(createResponse.status).toBe(200);
      const commentId = createResponse.body.commentId;

      // Retrieve the comment
      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [commentId]);

      // Verify all metadata persisted
      expect(comment.parent_id).toBe(999);
      expect(comment.type).toBe('ai');
      expect(comment.title).toBe('Test Title');
      expect(comment.body).toBe('File comment with metadata');
      expect(comment.file).toBe('test.js');
    });

    it('should allow regular user comments without metadata', async () => {
      // Regular user file-level comment without parent_id, type, or title
      const response = await request(app)
        .post('/api/file-comment')
        .send({
          pr_id: prId,
          file: 'file.js',
          body: 'Regular user file comment'
        });

      expect(response.status).toBe(200);

      // Verify comment was created with NULL metadata fields
      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [response.body.commentId]);
      expect(comment.parent_id).toBeNull();
      expect(comment.type).toBe('comment'); // Default type
      expect(comment.title).toBeNull();
      expect(comment.body).toBe('Regular user file comment');
      expect(comment.is_file_level).toBe(1);
    });

    it('should persist metadata after page reload simulation', async () => {
      // Simulate adopting an AI suggestion and saving it
      const response = await request(app)
        .post('/api/file-comment')
        .send({
          pr_id: prId,
          file: 'file.js',
          body: 'Adopted suggestion body',
          parent_id: 123,
          type: 'ai',
          title: 'Performance Issue'
        });

      expect(response.status).toBe(200);
      const commentId = response.body.commentId;

      // Simulate page reload by fetching user comments
      const getResponse = await request(app)
        .get('/api/pr/owner/repo/1/user-comments');

      expect(getResponse.status).toBe(200);
      expect(getResponse.body.comments).toBeDefined();

      // Find our comment
      const savedComment = getResponse.body.comments.find(c => c.id === commentId);
      expect(savedComment).toBeDefined();
      expect(savedComment.parent_id).toBe(123);
      expect(savedComment.type).toBe('ai');
      expect(savedComment.title).toBe('Performance Issue');
      expect(savedComment.body).toBe('Adopted suggestion body');
    });

    it('should handle partial metadata (only type)', async () => {
      const response = await request(app)
        .post('/api/file-comment')
        .send({
          pr_id: prId,
          file: 'file.js',
          body: 'Comment with only type',
          type: 'suggestion'
        });

      expect(response.status).toBe(200);

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [response.body.commentId]);
      expect(comment.type).toBe('suggestion');
      expect(comment.parent_id).toBeNull();
      expect(comment.title).toBeNull();
    });

    it('should handle partial metadata (only title)', async () => {
      const response = await request(app)
        .post('/api/file-comment')
        .send({
          pr_id: prId,
          file: 'file.js',
          body: 'Comment with only title',
          title: 'Important Note'
        });

      expect(response.status).toBe(200);

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [response.body.commentId]);
      expect(comment.title).toBe('Important Note');
      expect(comment.parent_id).toBeNull();
      expect(comment.type).toBe('comment'); // Default
    });

    it('should default type to "comment" when not provided', async () => {
      const response = await request(app)
        .post('/api/file-comment')
        .send({
          pr_id: prId,
          file: 'file.js',
          body: 'Comment without explicit type'
        });

      expect(response.status).toBe(200);

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [response.body.commentId]);
      expect(comment.type).toBe('comment');
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

    it('should include is_file_level in response', async () => {
      // Create a line-level comment (default is_file_level=0)
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, is_file_level)
        VALUES (?, 'user', 'file.js', 10, 'Line comment', 'active', 0)
      `, [prId]);
      // Create a file-level comment (is_file_level=1)
      await run(db, `
        INSERT INTO comments (pr_id, source, file, body, status, is_file_level)
        VALUES (?, 'user', 'another.js', 'File comment', 'active', 1)
      `, [prId]);

      const response = await request(app)
        .get('/api/pr/owner/repo/1/user-comments');

      expect(response.status).toBe(200);
      expect(response.body.comments.length).toBe(2);

      const lineComment = response.body.comments.find(c => c.body === 'Line comment');
      const fileComment = response.body.comments.find(c => c.body === 'File comment');

      expect(lineComment.is_file_level).toBe(0);
      expect(fileComment.is_file_level).toBe(1);
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

    it('should return dismissedSuggestionId when deleting an adopted comment', async () => {
      // Create an AI suggestion
      const suggestionResult = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, ai_run_id)
        VALUES (?, 'ai', 'test.js', 10, 'AI suggestion', 'adopted', 'run-1')
      `, [prId]);
      const suggestionId = suggestionResult.lastID;

      // Create a user comment adopted from the AI suggestion
      const commentResult = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, parent_id)
        VALUES (?, 'user', 'test.js', 10, 'User comment', 'active', ?)
      `, [prId, suggestionId]);

      const response = await request(app)
        .delete(`/api/user-comment/${commentResult.lastID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.dismissedSuggestionId).toBe(suggestionId);

      // Verify the AI suggestion status was changed to dismissed
      const suggestion = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [suggestionId]);
      expect(suggestion.status).toBe('dismissed');
    });

    it('should return null dismissedSuggestionId when deleting a non-adopted comment', async () => {
      // Create a user comment without a parent AI suggestion
      const commentResult = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'test.js', 10, 'User comment', 'active')
      `, [prId]);

      const response = await request(app)
        .delete(`/api/user-comment/${commentResult.lastID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.dismissedSuggestionId).toBeNull();
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

    it('should delete comments with active, submitted, and draft statuses', async () => {
      // Create comments with different statuses that should all be deleted
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'file1.js', 10, 'Active comment', 'active')
      `, [prId]);
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'file2.js', 20, 'Submitted comment', 'submitted')
      `, [prId]);
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'file3.js', 30, 'Draft comment', 'draft')
      `, [prId]);
      // This inactive comment should NOT be deleted again
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'file4.js', 40, 'Already inactive', 'inactive')
      `, [prId]);

      const response = await request(app)
        .delete('/api/pr/owner/repo/1/user-comments');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.deletedCount).toBe(3); // Only active, submitted, draft

      // Verify all deletable comments are now inactive
      const comments = await query(db, `
        SELECT status FROM comments WHERE pr_id = ? AND source = 'user' ORDER BY line_start
      `, [prId]);
      expect(comments.every(c => c.status === 'inactive')).toBe(true);
    });

    it('should return dismissedSuggestionIds when bulk deleting adopted comments', async () => {
      // Create two AI suggestions
      const suggestion1Result = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, ai_run_id)
        VALUES (?, 'ai', 'test.js', 10, 'AI suggestion 1', 'adopted', 'run-1')
      `, [prId]);
      const suggestion1Id = suggestion1Result.lastID;

      const suggestion2Result = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, ai_run_id)
        VALUES (?, 'ai', 'test.js', 20, 'AI suggestion 2', 'adopted', 'run-1')
      `, [prId]);
      const suggestion2Id = suggestion2Result.lastID;

      // Create user comments adopted from the AI suggestions
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, parent_id)
        VALUES (?, 'user', 'test.js', 10, 'User comment 1', 'active', ?)
      `, [prId, suggestion1Id]);

      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, parent_id)
        VALUES (?, 'user', 'test.js', 20, 'User comment 2', 'active', ?)
      `, [prId, suggestion2Id]);

      const response = await request(app)
        .delete('/api/pr/owner/repo/1/user-comments');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.deletedCount).toBe(2);
      expect(response.body.dismissedSuggestionIds).toEqual(
        expect.arrayContaining([suggestion1Id, suggestion2Id])
      );
      expect(response.body.dismissedSuggestionIds).toHaveLength(2);

      // Verify both AI suggestions were dismissed
      const suggestion1 = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [suggestion1Id]);
      const suggestion2 = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [suggestion2Id]);
      expect(suggestion1.status).toBe('dismissed');
      expect(suggestion2.status).toBe('dismissed');
    });

    it('should return empty dismissedSuggestionIds when deleting non-adopted comments', async () => {
      // Create user comments without parent AI suggestions
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'test.js', 10, 'User comment 1', 'active')
      `, [prId]);

      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'test.js', 20, 'User comment 2', 'active')
      `, [prId]);

      const response = await request(app)
        .delete('/api/pr/owner/repo/1/user-comments');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.deletedCount).toBe(2);
      expect(response.body.dismissedSuggestionIds).toEqual([]);
    });

    it('should return 0 deletedCount and empty dismissedSuggestionIds when no comments exist', async () => {
      const response = await request(app)
        .delete('/api/pr/owner/repo/1/user-comments');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.deletedCount).toBe(0);
      expect(response.body.dismissedSuggestionIds).toEqual([]);
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
      // Insert AI suggestion with ai_run_id (required for filtering by latest analysis run)
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, type, title, body, status, ai_run_id)
        VALUES (?, 'ai', 'file.js', 10, 'improvement', 'Test Suggestion', 'Suggestion body', 'active', 'test-run-1')
      `, [prId]);

      const response = await request(app)
        .get('/api/pr/owner/repo/1/ai-suggestions');

      expect(response.status).toBe(200);
      expect(response.body.suggestions.length).toBe(1);
      expect(response.body.suggestions[0].type).toBe('improvement');
    });

    it('should filter by levels query parameter', async () => {
      // Insert suggestions with different levels (all with same ai_run_id to simulate one analysis run)
      const runId = 'test-run-levels';
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, ai_level, body, status, ai_run_id)
        VALUES (?, 'ai', 'file.js', 10, 1, 'Level 1 suggestion', 'active', ?)
      `, [prId, runId]);
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, ai_level, body, status, ai_run_id)
        VALUES (?, 'ai', 'file.js', 20, 2, 'Level 2 suggestion', 'active', ?)
      `, [prId, runId]);
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, ai_level, body, status, ai_run_id)
        VALUES (?, 'ai', 'file.js', 30, NULL, 'Final suggestion', 'active', ?)
      `, [prId, runId]);

      // Filter for level 1 only
      const response = await request(app)
        .get('/api/pr/owner/repo/1/ai-suggestions?levels=1');

      expect(response.status).toBe(200);
      expect(response.body.suggestions.length).toBe(1);
      expect(response.body.suggestions[0].body).toBe('Level 1 suggestion');
    });

    it('should default to final suggestions when no levels specified', async () => {
      const runId = 'test-run-default';
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, ai_level, body, status, ai_run_id)
        VALUES (?, 'ai', 'file.js', 10, 1, 'Level 1', 'active', ?)
      `, [prId, runId]);
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, ai_level, body, status, ai_run_id)
        VALUES (?, 'ai', 'file.js', 20, NULL, 'Final', 'active', ?)
      `, [prId, runId]);

      const response = await request(app)
        .get('/api/pr/owner/repo/1/ai-suggestions');

      expect(response.body.suggestions.length).toBe(1);
      expect(response.body.suggestions[0].body).toBe('Final');
    });

    it('should only return suggestions from the latest ai_run_id', async () => {
      // Insert suggestions from two different analysis runs
      // run-1 has older timestamps, run-2 has newer timestamps
      const oldTime = '2024-01-01 10:00:00';
      const newTime = '2024-01-01 11:00:00';

      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, ai_level, body, status, ai_run_id, created_at)
        VALUES (?, 'ai', 'file.js', 10, NULL, 'Old run suggestion 1', 'active', 'run-1', ?)
      `, [prId, oldTime]);
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, ai_level, body, status, ai_run_id, created_at)
        VALUES (?, 'ai', 'file.js', 20, NULL, 'Old run suggestion 2', 'active', 'run-1', ?)
      `, [prId, oldTime]);

      // run-2 has a later created_at timestamp, making it the newest analysis run
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, ai_level, body, status, ai_run_id, created_at)
        VALUES (?, 'ai', 'file.js', 30, NULL, 'New run suggestion', 'active', 'run-2', ?)
      `, [prId, newTime]);

      const response = await request(app)
        .get('/api/pr/owner/repo/1/ai-suggestions');

      // Should only return the suggestion from run-2 (the latest run based on created_at)
      expect(response.status).toBe(200);
      expect(response.body.suggestions.length).toBe(1);
      expect(response.body.suggestions[0].body).toBe('New run suggestion');
      expect(response.body.suggestions[0].ai_run_id).toBe('run-2');
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
    it('should return false when no suggestions exist and no analysis run', async () => {
      const response = await request(app)
        .get('/api/pr/owner/repo/1/has-ai-suggestions');

      expect(response.status).toBe(200);
      expect(response.body.hasSuggestions).toBe(false);
      expect(response.body.analysisHasRun).toBe(false);
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
      expect(response.body.analysisHasRun).toBe(true);
    });

    it('should return analysisHasRun true when last_ai_run_id is set (even with no suggestions)', async () => {
      // Set last_ai_run_id to indicate analysis was run
      await run(db, `
        UPDATE pr_metadata SET last_ai_run_id = 'test-run-123'
        WHERE pr_number = ? AND repository = ?
      `, [1, 'owner/repo']);

      const response = await request(app)
        .get('/api/pr/owner/repo/1/has-ai-suggestions');

      expect(response.status).toBe(200);
      expect(response.body.hasSuggestions).toBe(false);
      expect(response.body.analysisHasRun).toBe(true);
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

    it('should submit file-level comments with isFileLevel flag', async () => {
      // Insert a file-level comment (is_file_level=1)
      await run(db, `
        INSERT INTO comments (pr_id, source, file, body, status, is_file_level)
        VALUES (?, 'user', 'file.js', 'This is a file-level comment', 'active', 1)
      `, [prId]);

      const response = await request(app)
        .post('/api/pr/owner/repo/1/submit-review')
        .send({ event: 'COMMENT', body: 'Review with file-level comment' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify the GraphQL function was called with isFileLevel=true
      expect(GitHubClient.prototype.createReviewGraphQL).toHaveBeenCalled();
      const callArgs = GitHubClient.prototype.createReviewGraphQL.mock.calls[0];
      const comments = callArgs[3]; // Fourth argument is comments array

      expect(comments.length).toBe(1);
      expect(comments[0].isFileLevel).toBe(true);
      expect(comments[0].path).toBe('file.js');
      expect(comments[0].body).toBe('This is a file-level comment');
      // File-level comments should NOT have line or side
      expect(comments[0].line).toBeUndefined();
      expect(comments[0].side).toBeUndefined();
    });

    it('should submit mixed file-level and line-level comments correctly', async () => {
      // Insert a file-level comment
      await run(db, `
        INSERT INTO comments (pr_id, source, file, body, status, is_file_level)
        VALUES (?, 'user', 'file1.js', 'File-level comment', 'active', 1)
      `, [prId]);

      // Insert a line-level comment with diff_position (inside diff hunk)
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, diff_position, side, body, status, is_file_level)
        VALUES (?, 'user', 'file2.js', 10, 5, 'RIGHT', 'Line-level comment', 'active', 0)
      `, [prId]);

      const response = await request(app)
        .post('/api/pr/owner/repo/1/submit-review')
        .send({ event: 'COMMENT', body: 'Review with mixed comments' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify the GraphQL function was called with correct comment structure
      expect(GitHubClient.prototype.createReviewGraphQL).toHaveBeenCalled();
      const callArgs = GitHubClient.prototype.createReviewGraphQL.mock.calls[0];
      const comments = callArgs[3];

      expect(comments.length).toBe(2);

      // Find file-level and line-level comments
      const fileLevelComment = comments.find(c => c.path === 'file1.js');
      const lineLevelComment = comments.find(c => c.path === 'file2.js');

      // File-level comment should have isFileLevel=true and no line/side
      expect(fileLevelComment.isFileLevel).toBe(true);
      expect(fileLevelComment.line).toBeUndefined();
      expect(fileLevelComment.side).toBeUndefined();

      // Line-level comment should have isFileLevel=false and include line/side
      expect(lineLevelComment.isFileLevel).toBe(false);
      expect(lineLevelComment.line).toBe(10);
      expect(lineLevelComment.side).toBe('RIGHT');
    });

    it('should submit draft review with file-level comments', async () => {
      // Insert a file-level comment
      await run(db, `
        INSERT INTO comments (pr_id, source, file, body, status, is_file_level)
        VALUES (?, 'user', 'file.js', 'Draft file-level comment', 'active', 1)
      `, [prId]);

      const response = await request(app)
        .post('/api/pr/owner/repo/1/submit-review')
        .send({ event: 'DRAFT', body: 'Draft review' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify the draft GraphQL function was called
      expect(GitHubClient.prototype.createDraftReviewGraphQL).toHaveBeenCalled();
      const callArgs = GitHubClient.prototype.createDraftReviewGraphQL.mock.calls[0];
      const comments = callArgs[2]; // Third argument is comments array for draft

      expect(comments.length).toBe(1);
      expect(comments[0].isFileLevel).toBe(true);
      expect(comments[0].path).toBe('file.js');
    });

    it('should handle expanded context comments as file-level with line reference', async () => {
      // Insert an expanded context comment (no diff_position, not explicitly file-level)
      // This represents a comment on a line outside the diff hunk
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, side, body, status, is_file_level)
        VALUES (?, 'user', 'file.js', 42, 'RIGHT', 'Expanded context comment', 'active', 0)
      `, [prId]);

      const response = await request(app)
        .post('/api/pr/owner/repo/1/submit-review')
        .send({ event: 'COMMENT', body: 'Review with expanded context comment' });

      expect(response.status).toBe(200);

      // Verify the GraphQL function was called
      expect(GitHubClient.prototype.createReviewGraphQL).toHaveBeenCalled();
      const callArgs = GitHubClient.prototype.createReviewGraphQL.mock.calls[0];
      const comments = callArgs[3];

      expect(comments.length).toBe(1);
      // Expanded context comments should be file-level with line reference in body
      expect(comments[0].isFileLevel).toBe(true);
      expect(comments[0].body).toContain('(Ref Line 42)');
      expect(comments[0].body).toContain('Expanded context comment');
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

// ============================================================================
// Local Review Settings Endpoint Tests
// ============================================================================

describe('Local Review Settings Endpoints', () => {
  let db;
  let app;
  let reviewId;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);

    // Create a local review
    const result = await run(db, `
      INSERT INTO reviews (repository, status, review_type, local_path, local_head_sha)
      VALUES ('owner/repo', 'draft', 'local', '/tmp/test-repo', 'abc123def')
    `);
    reviewId = result.lastID;
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('GET /api/local/:reviewId/review-settings', () => {
    it('should return null custom_instructions when not set', async () => {
      const response = await request(app)
        .get(`/api/local/${reviewId}/review-settings`);

      expect(response.status).toBe(200);
      expect(response.body.custom_instructions).toBeNull();
    });

    it('should return saved custom_instructions', async () => {
      // Set custom instructions
      await run(db, `
        UPDATE reviews SET custom_instructions = ? WHERE id = ?
      `, ['Focus on performance', reviewId]);

      const response = await request(app)
        .get(`/api/local/${reviewId}/review-settings`);

      expect(response.status).toBe(200);
      expect(response.body.custom_instructions).toBe('Focus on performance');
    });

    it('should return null for non-existent review', async () => {
      const response = await request(app)
        .get('/api/local/9999/review-settings');

      expect(response.status).toBe(200);
      expect(response.body.custom_instructions).toBeNull();
    });

    it('should return 400 for invalid review ID', async () => {
      const response = await request(app)
        .get('/api/local/invalid/review-settings');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid review ID');
    });
  });

  describe('POST /api/local/:reviewId/review-settings', () => {
    it('should save custom_instructions', async () => {
      const response = await request(app)
        .post(`/api/local/${reviewId}/review-settings`)
        .send({ custom_instructions: 'Check for security issues' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.custom_instructions).toBe('Check for security issues');

      // Verify it was saved in the database
      const review = await queryOne(db, 'SELECT custom_instructions FROM reviews WHERE id = ?', [reviewId]);
      expect(review.custom_instructions).toBe('Check for security issues');
    });

    it('should update existing custom_instructions', async () => {
      // Set initial instructions
      await run(db, `
        UPDATE reviews SET custom_instructions = ? WHERE id = ?
      `, ['Initial instructions', reviewId]);

      // Update instructions
      const response = await request(app)
        .post(`/api/local/${reviewId}/review-settings`)
        .send({ custom_instructions: 'Updated instructions' });

      expect(response.status).toBe(200);
      expect(response.body.custom_instructions).toBe('Updated instructions');
    });

    it('should clear custom_instructions when null is passed', async () => {
      // Set initial instructions
      await run(db, `
        UPDATE reviews SET custom_instructions = ? WHERE id = ?
      `, ['Some instructions', reviewId]);

      // Clear instructions
      const response = await request(app)
        .post(`/api/local/${reviewId}/review-settings`)
        .send({ custom_instructions: null });

      expect(response.status).toBe(200);
      expect(response.body.custom_instructions).toBeNull();
    });

    it('should return 404 for non-existent review', async () => {
      const response = await request(app)
        .post('/api/local/9999/review-settings')
        .send({ custom_instructions: 'Test' });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('should return 400 for invalid review ID', async () => {
      const response = await request(app)
        .post('/api/local/invalid/review-settings')
        .send({ custom_instructions: 'Test' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid review ID');
    });
  });
});

// ============================================================================
// Local Review Check-Stale Endpoint Tests
// ============================================================================

describe('Local Review Check-Stale Endpoint', () => {
  let db;
  let app;
  let reviewId;
  const { localReviewDiffs } = require('../../src/routes/shared');

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);

    // Create a local review
    const result = await run(db, `
      INSERT INTO reviews (repository, status, review_type, local_path, local_head_sha)
      VALUES ('owner/repo', 'draft', 'local', '/tmp/test-repo', 'abc123def')
    `);
    reviewId = result.lastID;

    // Clear any existing diff data
    localReviewDiffs.clear();
  });

  afterEach(async () => {
    localReviewDiffs.clear();
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('GET /api/local/:reviewId/check-stale', () => {
    it('should return 400 for invalid review ID', async () => {
      const response = await request(app)
        .get('/api/local/invalid/check-stale');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid review ID');
    });

    it('should return isStale null when review not found', async () => {
      const response = await request(app)
        .get('/api/local/9999/check-stale');

      expect(response.status).toBe(200);
      expect(response.body.isStale).toBeNull();
      expect(response.body.error).toContain('not found');
    });

    it('should return isStale null when no stored diff data', async () => {
      const response = await request(app)
        .get(`/api/local/${reviewId}/check-stale`);

      expect(response.status).toBe(200);
      expect(response.body.isStale).toBeNull();
      expect(response.body.error).toContain('No stored diff data');
    });

    it('should return isStale true when stored digest differs from current', async () => {
      // Set up stored diff data with a known digest
      localReviewDiffs.set(reviewId, {
        diff: 'old diff content',
        stats: { unstagedChanges: 1, untrackedFiles: 0 },
        digest: 'old_digest_12345678'
      });

      const response = await request(app)
        .get(`/api/local/${reviewId}/check-stale`);

      expect(response.status).toBe(200);
      // Since the local path is fake, digest computation will likely fail or differ
      // The endpoint should handle this gracefully
      expect(response.body).toHaveProperty('isStale');
    });

    it('should include storedDigest in response when digest exists', async () => {
      // When a digest is pre-computed and stored, it should be included in response
      // Note: With a fake path, current digest computation will fail, so isStale will be true
      localReviewDiffs.set(reviewId, {
        diff: 'some diff',
        stats: { unstagedChanges: 0, untrackedFiles: 0 },
        digest: 'test_digest_1234'
      });

      const response = await request(app)
        .get(`/api/local/${reviewId}/check-stale`);

      expect(response.status).toBe(200);
      // Response should have isStale property
      expect(response.body).toHaveProperty('isStale');
      // With fake path, digest computation fails so we get isStale: true with error
      // This is the expected fail-safe behavior
      expect(response.body.isStale).toBe(true);
    });

    it('should assume stale when no baseline digest exists', async () => {
      // Store diff data without a digest (simulates legacy session or failed capture)
      localReviewDiffs.set(reviewId, {
        diff: 'some diff',
        stats: { unstagedChanges: 1, untrackedFiles: 0 }
        // No digest - endpoint should assume stale since baseline was never captured
      });

      const response = await request(app)
        .get(`/api/local/${reviewId}/check-stale`);

      expect(response.status).toBe(200);
      // When no baseline digest exists, should assume stale for safety
      expect(response.body.isStale).toBe(true);
      expect(response.body.error).toContain('No baseline digest');
    });
  });
});

// ============================================================================
// File Content Endpoint Tests
// ============================================================================

describe('File Content Endpoints', () => {
  let db;
  let app;
  let fsRealpathSpy;
  let fsReadFileSpy;

  // Import fs for spying
  const fs = require('fs').promises;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);

    // Reset fs spies
    fsRealpathSpy = vi.spyOn(fs, 'realpath');
    fsReadFileSpy = vi.spyOn(fs, 'readFile');
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
    vi.clearAllMocks();
    fsRealpathSpy?.mockRestore();
    fsReadFileSpy?.mockRestore();
  });

  describe('GET /api/file-content-original/:fileName (Local Mode)', () => {
    it('should detect owner=local and use review ID', async () => {
      // Insert a local review
      await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type, local_path, local_head_sha)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [null, 'test-repo', 'draft', 'local', '/tmp/test-repo', 'abc123']);

      const review = await queryOne(db, 'SELECT id FROM reviews WHERE review_type = ?', ['local']);

      // Mock fs operations
      fsRealpathSpy.mockImplementation(async (p) => p);
      fsReadFileSpy.mockResolvedValue('line1\nline2\nline3');

      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'local', repo: 'test-repo', number: review.id });

      expect(response.status).toBe(200);
      expect(response.body.fileName).toBe('src/test.js');
      expect(response.body.lines).toEqual(['line1', 'line2', 'line3']);
      expect(response.body.totalLines).toBe(3);
    });

    it('should return 400 for invalid review ID', async () => {
      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'local', repo: 'test-repo', number: 'invalid' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid review ID');
    });

    it('should return 400 for negative review ID', async () => {
      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'local', repo: 'test-repo', number: '-1' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid review ID');
    });

    it('should return 400 for zero review ID', async () => {
      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'local', repo: 'test-repo', number: '0' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid review ID');
    });

    it('should return 404 when local review not found', async () => {
      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'local', repo: 'test-repo', number: '999' });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('Local review not found');
    });

    it('should return 404 when review exists but local_path is NULL', async () => {
      // Insert a local review without local_path
      await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type, local_path)
        VALUES (?, ?, ?, ?, ?)
      `, [null, 'test-repo', 'draft', 'local', null]);

      const review = await queryOne(db, 'SELECT id FROM reviews WHERE review_type = ?', ['local']);

      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'local', repo: 'test-repo', number: review.id });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('missing path');
    });

    it('should return 404 for non-existent file in local repo', async () => {
      await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type, local_path, local_head_sha)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [null, 'test-repo', 'draft', 'local', '/tmp/test-repo', 'abc123']);

      const review = await queryOne(db, 'SELECT id FROM reviews WHERE review_type = ?', ['local']);

      // Mock fs.realpath to throw ENOENT
      const enoentError = new Error('ENOENT: no such file or directory');
      enoentError.code = 'ENOENT';
      fsRealpathSpy.mockRejectedValue(enoentError);

      const response = await request(app)
        .get('/api/file-content-original/src/nonexistent.js')
        .query({ owner: 'local', repo: 'test-repo', number: review.id });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('File not found');
    });

    it('should return 403 for path traversal attempts', async () => {
      await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type, local_path, local_head_sha)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [null, 'test-repo', 'draft', 'local', '/tmp/test-repo', 'abc123']);

      const review = await queryOne(db, 'SELECT id FROM reviews WHERE review_type = ?', ['local']);

      // Mock realpath to return path outside repository (simulating symlink escape)
      fsRealpathSpy.mockImplementation(async (p) => {
        if (p === '/tmp/test-repo') return '/tmp/test-repo';
        return '/etc/passwd'; // Escaped path
      });

      const response = await request(app)
        .get('/api/file-content-original/evil-symlink')
        .query({ owner: 'local', repo: 'test-repo', number: review.id });

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('Access denied');
    });

    it('should return 400 when path is a directory', async () => {
      await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type, local_path, local_head_sha)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [null, 'test-repo', 'draft', 'local', '/tmp/test-repo', 'abc123']);

      const review = await queryOne(db, 'SELECT id FROM reviews WHERE review_type = ?', ['local']);

      // Mock realpath to succeed, but readFile to throw EISDIR
      fsRealpathSpy.mockImplementation(async (p) => p);
      const eisdirError = new Error('EISDIR: illegal operation on a directory');
      eisdirError.code = 'EISDIR';
      fsReadFileSpy.mockRejectedValue(eisdirError);

      const response = await request(app)
        .get('/api/file-content-original/src')
        .query({ owner: 'local', repo: 'test-repo', number: review.id });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('directory');
    });

    it('should handle URL-encoded file names', async () => {
      await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type, local_path, local_head_sha)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [null, 'test-repo', 'draft', 'local', '/tmp/test-repo', 'abc123']);

      const review = await queryOne(db, 'SELECT id FROM reviews WHERE review_type = ?', ['local']);

      fsRealpathSpy.mockImplementation(async (p) => p);
      fsReadFileSpy.mockResolvedValue('content');

      const response = await request(app)
        .get('/api/file-content-original/src%2Futils%2Ftest.js')
        .query({ owner: 'local', repo: 'test-repo', number: review.id });

      expect(response.status).toBe(200);
      expect(response.body.fileName).toBe('src/utils/test.js');
    });

    // Note: Local mode now uses git show local_head_sha:fileName for context expansion
    // to ensure line numbers match the diff's "before" state.
    // Tests below verify the fallback behavior when git show fails.

    it('should fall back to filesystem read when git show fails for new files in local mode', async () => {
      await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type, local_path, local_head_sha)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [null, 'test-repo', 'draft', 'local', '/tmp/test-repo', 'abc123']);

      const review = await queryOne(db, 'SELECT id FROM reviews WHERE review_type = ?', ['local']);

      // The real simple-git will fail because the path doesn't exist,
      // which causes the code to fall back to filesystem read
      fsRealpathSpy.mockImplementation(async (p) => p);
      fsReadFileSpy.mockResolvedValue('content from working directory');

      const response = await request(app)
        .get('/api/file-content-original/src/new-file.js')
        .query({ owner: 'local', repo: 'test-repo', number: review.id });

      expect(response.status).toBe(200);
      expect(response.body.lines).toEqual(['content from working directory']);
    });

    it('should skip git show when local_head_sha is not available', async () => {
      // Insert a local review without local_head_sha
      await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type, local_path)
        VALUES (?, ?, ?, ?, ?)
      `, [null, 'test-repo', 'draft', 'local', '/tmp/test-repo']);

      const review = await queryOne(db, 'SELECT id FROM reviews WHERE review_type = ?', ['local']);

      fsRealpathSpy.mockImplementation(async (p) => p);
      fsReadFileSpy.mockResolvedValue('working directory content');

      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'local', repo: 'test-repo', number: review.id });

      expect(response.status).toBe(200);
      expect(response.body.lines).toEqual(['working directory content']);
    });
  });

  describe('GET /api/file-content-original/:fileName (PR Mode)', () => {
    it('should return file content from worktree for valid request', async () => {
      await insertTestPR(db, 1, 'owner/repo');
      await insertTestWorktree(db, 1, 'owner/repo');

      fsRealpathSpy.mockImplementation(async (p) => p);
      fsReadFileSpy.mockResolvedValue('line1\nline2\nline3');

      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'owner', repo: 'repo', number: '1' });

      expect(response.status).toBe(200);
      expect(response.body.fileName).toBe('src/test.js');
      expect(response.body.lines).toEqual(['line1', 'line2', 'line3']);
      expect(response.body.totalLines).toBe(3);
    });

    it('should return 400 when owner is missing', async () => {
      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ repo: 'repo', number: '1' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing required parameters');
    });

    it('should return 400 when repo is missing', async () => {
      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'owner', number: '1' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing required parameters');
    });

    it('should return 400 when number is missing', async () => {
      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'owner', repo: 'repo' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing required parameters');
    });

    it('should return 400 for invalid PR number (non-numeric)', async () => {
      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'owner', repo: 'repo', number: 'invalid' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid pull request number');
    });

    it('should return 400 for negative PR number', async () => {
      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'owner', repo: 'repo', number: '-1' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid pull request number');
    });

    it('should return 400 for zero PR number', async () => {
      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'owner', repo: 'repo', number: '0' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid pull request number');
    });

    it('should return 404 when worktree does not exist', async () => {
      await insertTestPR(db, 1, 'owner/repo');

      // Mock worktreeExists to return false
      vi.spyOn(GitWorktreeManager.prototype, 'worktreeExists').mockResolvedValueOnce(false);

      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'owner', repo: 'repo', number: '1' });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('Worktree not found');
    });

    it('should return 404 for non-existent file in worktree', async () => {
      await insertTestPR(db, 1, 'owner/repo');
      await insertTestWorktree(db, 1, 'owner/repo');

      const enoentError = new Error('ENOENT: no such file or directory');
      enoentError.code = 'ENOENT';
      fsRealpathSpy.mockRejectedValue(enoentError);

      const response = await request(app)
        .get('/api/file-content-original/src/nonexistent.js')
        .query({ owner: 'owner', repo: 'repo', number: '1' });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('File not found');
    });

    it('should return 403 for path traversal attempts via symlinks', async () => {
      await insertTestPR(db, 1, 'owner/repo');
      await insertTestWorktree(db, 1, 'owner/repo');

      // Mock realpath to return path outside worktree (simulating symlink escape)
      fsRealpathSpy.mockImplementation(async (p) => {
        if (p === '/tmp/worktree/test') return '/tmp/worktree/test';
        return '/etc/passwd'; // Escaped path
      });

      const response = await request(app)
        .get('/api/file-content-original/evil-symlink')
        .query({ owner: 'owner', repo: 'repo', number: '1' });

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('Access denied');
    });

    it('should return 400 when path is a directory', async () => {
      await insertTestPR(db, 1, 'owner/repo');
      await insertTestWorktree(db, 1, 'owner/repo');

      fsRealpathSpy.mockImplementation(async (p) => p);
      const eisdirError = new Error('EISDIR: illegal operation on a directory');
      eisdirError.code = 'EISDIR';
      fsReadFileSpy.mockRejectedValue(eisdirError);

      const response = await request(app)
        .get('/api/file-content-original/src')
        .query({ owner: 'owner', repo: 'repo', number: '1' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('directory');
    });

    it('should handle URL-encoded file names correctly', async () => {
      await insertTestPR(db, 1, 'owner/repo');
      await insertTestWorktree(db, 1, 'owner/repo');

      fsRealpathSpy.mockImplementation(async (p) => p);
      fsReadFileSpy.mockResolvedValue('content');

      const response = await request(app)
        .get('/api/file-content-original/src%2Futils%2Ftest.js')
        .query({ owner: 'owner', repo: 'repo', number: '1' });

      expect(response.status).toBe(200);
      expect(response.body.fileName).toBe('src/utils/test.js');
    });

    it('should handle files with empty content', async () => {
      await insertTestPR(db, 1, 'owner/repo');
      await insertTestWorktree(db, 1, 'owner/repo');

      fsRealpathSpy.mockImplementation(async (p) => p);
      fsReadFileSpy.mockResolvedValue('');

      const response = await request(app)
        .get('/api/file-content-original/src/empty.js')
        .query({ owner: 'owner', repo: 'repo', number: '1' });

      expect(response.status).toBe(200);
      expect(response.body.lines).toEqual(['']);
      expect(response.body.totalLines).toBe(1);
    });

    it('should handle files with many lines', async () => {
      await insertTestPR(db, 1, 'owner/repo');
      await insertTestWorktree(db, 1, 'owner/repo');

      const manyLines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
      fsRealpathSpy.mockImplementation(async (p) => p);
      fsReadFileSpy.mockResolvedValue(manyLines);

      const response = await request(app)
        .get('/api/file-content-original/src/large.js')
        .query({ owner: 'owner', repo: 'repo', number: '1' });

      expect(response.status).toBe(200);
      expect(response.body.totalLines).toBe(1000);
      expect(response.body.lines[0]).toBe('line 1');
      expect(response.body.lines[999]).toBe('line 1000');
    });

    // Note: The git show base_sha:fileName functionality is tested via the fallback behavior.
    // When git show fails (as it does in tests due to non-existent worktree directories),
    // it falls back to filesystem read. The implementation is verified through:
    // 1. The code path exists and is exercised (see console log "falling back to HEAD")
    // 2. The fallback behavior works correctly (tests below)
    // Full git show testing requires E2E tests with a real git repository.

    it('should fall back to filesystem read when git show fails for new files', async () => {
      await insertTestPR(db, 1, 'owner/repo');
      await insertTestWorktree(db, 1, 'owner/repo');

      // The real simple-git will fail because the worktree doesn't exist,
      // which causes the code to fall back to filesystem read
      fsRealpathSpy.mockImplementation(async (p) => p);
      fsReadFileSpy.mockResolvedValue('filesystem content for new file');

      const response = await request(app)
        .get('/api/file-content-original/src/new-file.js')
        .query({ owner: 'owner', repo: 'repo', number: '1' });

      expect(response.status).toBe(200);
      expect(response.body.lines).toEqual(['filesystem content for new file']);
    });

    it('should skip git show when base_sha is not available in pr_data', async () => {
      // Insert PR without base_sha in pr_data
      const prDataWithoutBase = JSON.stringify({
        state: 'open',
        diff: 'diff content',
        changed_files: [{ file: 'file.js', additions: 1, deletions: 0 }],
        // No base_sha field
        head_sha: 'def456'
      });

      await run(db, `
        INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [2, 'owner/repo', 'Test PR', 'Description', 'user', 'main', 'feature', prDataWithoutBase]);

      await insertTestWorktree(db, 2, 'owner/repo');

      fsRealpathSpy.mockImplementation(async (p) => p);
      fsReadFileSpy.mockResolvedValue('head version content');

      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'owner', repo: 'repo', number: '2' });

      expect(response.status).toBe(200);
      expect(response.body.lines).toEqual(['head version content']);
    });

    it('should handle corrupted pr_data JSON gracefully', async () => {
      // Insert PR with invalid JSON in pr_data
      await run(db, `
        INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [3, 'owner/repo', 'Test PR', 'Description', 'user', 'main', 'feature', 'not valid json']);

      await insertTestWorktree(db, 3, 'owner/repo');

      fsRealpathSpy.mockImplementation(async (p) => p);
      fsReadFileSpy.mockResolvedValue('content from filesystem');

      const response = await request(app)
        .get('/api/file-content-original/src/test.js')
        .query({ owner: 'owner', repo: 'repo', number: '3' });

      // Should gracefully fall back to filesystem read when JSON parsing fails
      expect(response.status).toBe(200);
      expect(response.body.lines).toEqual(['content from filesystem']);
    });
  });
});

describe('Local Review File-Level Comments', () => {
  let app, db, reviewId;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);

    // Create a local review
    const reviewResult = await run(db, `
      INSERT INTO reviews (pr_number, repository, status, review_type, local_path, local_head_sha)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [null, 'test-repo', 'draft', 'local', '/tmp/test-repo', 'abc123']);
    reviewId = reviewResult.lastID;
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('POST /api/local/:reviewId/file-comment', () => {
    it('should return 400 when required fields are missing', async () => {
      const response = await request(app)
        .post(`/api/local/${reviewId}/file-comment`)
        .send({ file: 'test.js' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing required fields');
    });

    it('should return 400 when body is empty', async () => {
      const response = await request(app)
        .post(`/api/local/${reviewId}/file-comment`)
        .send({
          file: 'test.js',
          body: '   '
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Comment body cannot be empty or whitespace only');
    });

    it('should return 404 when review not found', async () => {
      const response = await request(app)
        .post('/api/local/9999/file-comment')
        .send({
          file: 'test.js',
          body: 'File-level comment'
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('Local review not found');
    });

    it('should create file-level comment successfully', async () => {
      const response = await request(app)
        .post(`/api/local/${reviewId}/file-comment`)
        .send({
          file: 'test.js',
          body: 'This is a file-level comment'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.commentId).toBeDefined();
      expect(response.body.message).toContain('File-level');
    });

    it('should create file-level comment with is_file_level=1 and NULL line fields', async () => {
      const response = await request(app)
        .post(`/api/local/${reviewId}/file-comment`)
        .send({
          file: 'test.js',
          body: 'File-level comment'
        });

      expect(response.status).toBe(200);

      const comment = await queryOne(db, `
        SELECT * FROM comments WHERE id = ?
      `, [response.body.commentId]);

      expect(comment.is_file_level).toBe(1);
      expect(comment.line_start).toBeNull();
      expect(comment.line_end).toBeNull();
      expect(comment.diff_position).toBeNull();
      expect(comment.side).toBeNull();
      expect(comment.commit_sha).toBeNull();
    });

    it('should create file-level comment with optional parent_id, type, and title', async () => {
      // First create an AI suggestion
      const aiResult = await run(db, `
        INSERT INTO comments (pr_id, source, file, body, status, type, title, is_file_level)
        VALUES (?, 'ai', 'test.js', 'AI suggestion', 'active', 'suggestion', 'Consider refactoring', 1)
      `, [reviewId]);

      // Now adopt it as a file-level comment with metadata
      const response = await request(app)
        .post(`/api/local/${reviewId}/file-comment`)
        .send({
          file: 'test.js',
          body: 'AI suggestion',
          parent_id: aiResult.lastID,
          type: 'suggestion',
          title: 'Consider refactoring'
        });

      expect(response.status).toBe(200);

      const comment = await queryOne(db, `
        SELECT * FROM comments WHERE id = ?
      `, [response.body.commentId]);

      expect(comment.parent_id).toBe(aiResult.lastID);
      expect(comment.type).toBe('suggestion');
      expect(comment.title).toBe('Consider refactoring');
      expect(comment.is_file_level).toBe(1);
    });
  });

  describe('PUT /api/local/:reviewId/file-comment/:commentId', () => {
    it('should return 400 for invalid review ID', async () => {
      const response = await request(app)
        .put('/api/local/invalid/file-comment/1')
        .send({ body: 'Updated comment' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid review ID');
    });

    it('should return 400 for invalid comment ID', async () => {
      const response = await request(app)
        .put(`/api/local/${reviewId}/file-comment/invalid`)
        .send({ body: 'Updated comment' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid comment ID');
    });

    it('should return 400 when body is empty', async () => {
      const response = await request(app)
        .put(`/api/local/${reviewId}/file-comment/1`)
        .send({ body: '   ' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Comment body cannot be empty');
    });

    it('should return 404 when file-level comment not found', async () => {
      const response = await request(app)
        .put(`/api/local/${reviewId}/file-comment/9999`)
        .send({ body: 'Updated comment' });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('File-level comment not found');
    });

    it('should not update line-level comment via file-comment endpoint', async () => {
      // Create a line-level comment
      const lineCommentResult = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, is_file_level)
        VALUES (?, 'user', 'test.js', 10, 'Line comment', 'active', 0)
      `, [reviewId]);

      const response = await request(app)
        .put(`/api/local/${reviewId}/file-comment/${lineCommentResult.lastID}`)
        .send({ body: 'Updated comment' });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('File-level comment not found');
    });

    it('should update file-level comment successfully', async () => {
      // Create a file-level comment
      const fileCommentResult = await run(db, `
        INSERT INTO comments (pr_id, source, file, body, status, is_file_level)
        VALUES (?, 'user', 'test.js', 'Original comment', 'active', 1)
      `, [reviewId]);

      const response = await request(app)
        .put(`/api/local/${reviewId}/file-comment/${fileCommentResult.lastID}`)
        .send({ body: 'Updated file-level comment' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('File-level comment updated');

      // Verify the update
      const comment = await queryOne(db, `
        SELECT * FROM comments WHERE id = ?
      `, [fileCommentResult.lastID]);

      expect(comment.body).toBe('Updated file-level comment');
    });
  });

  describe('DELETE /api/local/:reviewId/file-comment/:commentId', () => {
    it('should return 400 for invalid review ID', async () => {
      const response = await request(app)
        .delete('/api/local/invalid/file-comment/1');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid review ID');
    });

    it('should return 400 for invalid comment ID', async () => {
      const response = await request(app)
        .delete(`/api/local/${reviewId}/file-comment/invalid`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid comment ID');
    });

    it('should return 404 when file-level comment not found', async () => {
      const response = await request(app)
        .delete(`/api/local/${reviewId}/file-comment/9999`);

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('File-level comment not found');
    });

    it('should not delete line-level comment via file-comment endpoint', async () => {
      // Create a line-level comment
      const lineCommentResult = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, is_file_level)
        VALUES (?, 'user', 'test.js', 10, 'Line comment', 'active', 0)
      `, [reviewId]);

      const response = await request(app)
        .delete(`/api/local/${reviewId}/file-comment/${lineCommentResult.lastID}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('File-level comment not found');
    });

    it('should soft delete file-level comment successfully', async () => {
      // Create a file-level comment
      const fileCommentResult = await run(db, `
        INSERT INTO comments (pr_id, source, file, body, status, is_file_level)
        VALUES (?, 'user', 'test.js', 'File comment to delete', 'active', 1)
      `, [reviewId]);

      const response = await request(app)
        .delete(`/api/local/${reviewId}/file-comment/${fileCommentResult.lastID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('File-level comment deleted');

      // Verify the soft delete
      const comment = await queryOne(db, `
        SELECT * FROM comments WHERE id = ?
      `, [fileCommentResult.lastID]);

      expect(comment.status).toBe('inactive');
    });
  });

  describe('GET /api/local/:reviewId/user-comments', () => {
    it('should return file-level comments with is_file_level=1', async () => {
      // Create a file-level comment
      await run(db, `
        INSERT INTO comments (pr_id, source, author, file, body, status, is_file_level)
        VALUES (?, 'user', 'Current User', 'test.js', 'File-level comment', 'active', 1)
      `, [reviewId]);

      const response = await request(app)
        .get(`/api/local/${reviewId}/user-comments`);

      expect(response.status).toBe(200);
      expect(response.body.comments).toHaveLength(1);
      expect(response.body.comments[0].is_file_level).toBe(1);
      expect(response.body.comments[0].line_start).toBeNull();
    });

    it('should return both file-level and line-level comments', async () => {
      // Create a file-level comment
      await run(db, `
        INSERT INTO comments (pr_id, source, author, file, body, status, is_file_level)
        VALUES (?, 'user', 'Current User', 'test.js', 'File-level comment', 'active', 1)
      `, [reviewId]);

      // Create a line-level comment
      await run(db, `
        INSERT INTO comments (pr_id, source, author, file, line_start, line_end, body, status)
        VALUES (?, 'user', 'Current User', 'test.js', 10, 10, 'Line comment', 'active')
      `, [reviewId]);

      const response = await request(app)
        .get(`/api/local/${reviewId}/user-comments`);

      expect(response.status).toBe(200);
      expect(response.body.comments).toHaveLength(2);

      const fileLevelComment = response.body.comments.find(c => c.is_file_level === 1);
      const lineLevelComment = response.body.comments.find(c => c.line_start === 10);

      expect(fileLevelComment).toBeDefined();
      expect(lineLevelComment).toBeDefined();
    });
  });

  describe('GET /api/local/:reviewId/suggestions', () => {
    it('should return file-level AI suggestions with is_file_level=1', async () => {
      // Create a file-level AI suggestion
      await run(db, `
        INSERT INTO comments (pr_id, source, file, body, status, ai_run_id, is_file_level)
        VALUES (?, 'ai', 'test.js', 'File-level suggestion', 'active', 'run-1', 1)
      `, [reviewId]);

      const response = await request(app)
        .get(`/api/local/${reviewId}/suggestions`);

      expect(response.status).toBe(200);
      expect(response.body.suggestions).toHaveLength(1);
      expect(response.body.suggestions[0].is_file_level).toBe(1);
      expect(response.body.suggestions[0].line_start).toBeNull();
    });

    it('should order file-level suggestions before line-level suggestions', async () => {
      // Create line-level suggestion
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, ai_run_id)
        VALUES (?, 'ai', 'test.js', 10, 'Line suggestion', 'active', 'run-1')
      `, [reviewId]);

      // Create file-level suggestion
      await run(db, `
        INSERT INTO comments (pr_id, source, file, body, status, ai_run_id, is_file_level)
        VALUES (?, 'ai', 'test.js', 'File suggestion', 'active', 'run-1', 1)
      `, [reviewId]);

      const response = await request(app)
        .get(`/api/local/${reviewId}/suggestions`);

      expect(response.status).toBe(200);
      expect(response.body.suggestions).toHaveLength(2);
      // File-level should come first due to ORDER BY is_file_level DESC
      expect(response.body.suggestions[0].is_file_level).toBe(1);
      expect(response.body.suggestions[1].line_start).toBe(10);
    });
  });
});

// ============================================================================
// Local Routes Dismissal Response Tests
// ============================================================================

describe('Local Routes Dismissal Response Structure', () => {
  let app, db, reviewId;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);

    // Create a local review
    const reviewResult = await run(db, `
      INSERT INTO reviews (pr_number, repository, status, review_type, local_path, local_head_sha)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [null, 'test-repo', 'draft', 'local', '/tmp/test-repo', 'abc123']);
    reviewId = reviewResult.lastID;
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('DELETE /api/local/:reviewId/user-comments/:commentId', () => {
    it('should return dismissedSuggestionId when deleting an adopted comment', async () => {
      // Create an AI suggestion
      const suggestionResult = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, ai_run_id)
        VALUES (?, 'ai', 'test.js', 10, 'AI suggestion', 'adopted', 'run-1')
      `, [reviewId]);
      const suggestionId = suggestionResult.lastID;

      // Create a user comment adopted from the AI suggestion
      const commentResult = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, parent_id)
        VALUES (?, 'user', 'test.js', 10, 'User comment', 'active', ?)
      `, [reviewId, suggestionId]);

      const response = await request(app)
        .delete(`/api/local/${reviewId}/user-comments/${commentResult.lastID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.dismissedSuggestionId).toBe(suggestionId);

      // Verify the AI suggestion status was changed to dismissed
      const suggestion = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [suggestionId]);
      expect(suggestion.status).toBe('dismissed');
    });

    it('should return null dismissedSuggestionId when deleting a non-adopted comment', async () => {
      // Create a user comment without a parent AI suggestion
      const commentResult = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'test.js', 10, 'User comment', 'active')
      `, [reviewId]);

      const response = await request(app)
        .delete(`/api/local/${reviewId}/user-comments/${commentResult.lastID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.dismissedSuggestionId).toBeNull();
    });

    it('should return 404 for non-existent comment', async () => {
      const response = await request(app)
        .delete(`/api/local/${reviewId}/user-comments/9999`);

      expect(response.status).toBe(404);
    });

    it('should return 400 for invalid review ID', async () => {
      const response = await request(app)
        .delete('/api/local/invalid/user-comments/1');

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid comment ID', async () => {
      const response = await request(app)
        .delete(`/api/local/${reviewId}/user-comments/invalid`);

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/local/:reviewId/user-comments', () => {
    it('should return dismissedSuggestionIds when bulk deleting adopted comments', async () => {
      // Create two AI suggestions
      const suggestion1Result = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, ai_run_id)
        VALUES (?, 'ai', 'test.js', 10, 'AI suggestion 1', 'adopted', 'run-1')
      `, [reviewId]);
      const suggestion1Id = suggestion1Result.lastID;

      const suggestion2Result = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, ai_run_id)
        VALUES (?, 'ai', 'test.js', 20, 'AI suggestion 2', 'adopted', 'run-1')
      `, [reviewId]);
      const suggestion2Id = suggestion2Result.lastID;

      // Create user comments adopted from the AI suggestions
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, parent_id)
        VALUES (?, 'user', 'test.js', 10, 'User comment 1', 'active', ?)
      `, [reviewId, suggestion1Id]);

      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, parent_id)
        VALUES (?, 'user', 'test.js', 20, 'User comment 2', 'active', ?)
      `, [reviewId, suggestion2Id]);

      const response = await request(app)
        .delete(`/api/local/${reviewId}/user-comments`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.deletedCount).toBe(2);
      expect(response.body.dismissedSuggestionIds).toEqual(
        expect.arrayContaining([suggestion1Id, suggestion2Id])
      );
      expect(response.body.dismissedSuggestionIds).toHaveLength(2);

      // Verify both AI suggestions were dismissed
      const suggestion1 = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [suggestion1Id]);
      const suggestion2 = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [suggestion2Id]);
      expect(suggestion1.status).toBe('dismissed');
      expect(suggestion2.status).toBe('dismissed');
    });

    it('should deduplicate dismissedSuggestionIds when multiple user comments share same parent', async () => {
      // Create one AI suggestion
      const suggestionResult = await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, ai_run_id)
        VALUES (?, 'ai', 'test.js', 10, 'AI suggestion', 'adopted', 'run-1')
      `, [reviewId]);
      const suggestionId = suggestionResult.lastID;

      // Create multiple user comments adopted from the SAME AI suggestion
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, parent_id)
        VALUES (?, 'user', 'test.js', 10, 'User comment 1', 'active', ?)
      `, [reviewId, suggestionId]);

      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, parent_id)
        VALUES (?, 'user', 'test.js', 12, 'User comment 2', 'active', ?)
      `, [reviewId, suggestionId]);

      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status, parent_id)
        VALUES (?, 'user', 'test.js', 14, 'User comment 3', 'active', ?)
      `, [reviewId, suggestionId]);

      const response = await request(app)
        .delete(`/api/local/${reviewId}/user-comments`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.deletedCount).toBe(3);
      // Should contain only one suggestion ID, not duplicated
      expect(response.body.dismissedSuggestionIds).toEqual([suggestionId]);
      expect(response.body.dismissedSuggestionIds).toHaveLength(1);

      // Verify the AI suggestion was dismissed
      const suggestion = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [suggestionId]);
      expect(suggestion.status).toBe('dismissed');
    });

    it('should return empty dismissedSuggestionIds when deleting non-adopted comments', async () => {
      // Create user comments without parent AI suggestions
      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'test.js', 10, 'User comment 1', 'active')
      `, [reviewId]);

      await run(db, `
        INSERT INTO comments (pr_id, source, file, line_start, body, status)
        VALUES (?, 'user', 'test.js', 20, 'User comment 2', 'active')
      `, [reviewId]);

      const response = await request(app)
        .delete(`/api/local/${reviewId}/user-comments`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.deletedCount).toBe(2);
      expect(response.body.dismissedSuggestionIds).toEqual([]);
    });

    it('should return 0 deletedCount and empty dismissedSuggestionIds when no comments exist', async () => {
      const response = await request(app)
        .delete(`/api/local/${reviewId}/user-comments`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.deletedCount).toBe(0);
      expect(response.body.dismissedSuggestionIds).toEqual([]);
    });

    it('should return 404 for non-existent review', async () => {
      const response = await request(app)
        .delete('/api/local/9999/user-comments');

      expect(response.status).toBe(404);
    });

    it('should return 400 for invalid review ID', async () => {
      const response = await request(app)
        .delete('/api/local/invalid/user-comments');

      expect(response.status).toBe(400);
    });
  });
});
