/**
 * Playwright Global Setup
 *
 * Starts a test server with mocked dependencies before all tests run.
 */

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3');

// Mock external dependencies
const mockGitHubResponses = {
  fetchPullRequest: {
    title: 'Test PR for E2E',
    body: 'This is a test PR description',
    author: 'testuser',
    base_branch: 'main',
    head_branch: 'feature-test',
    state: 'open',
    base_sha: 'abc123base',
    head_sha: 'def456head',
    node_id: 'PR_test_node_123',
    html_url: 'https://github.com/test-owner/test-repo/pull/1',
    additions: 25,
    deletions: 10
  }
};

const mockWorktreeResponses = {
  generateUnifiedDiff: `diff --git a/src/utils.js b/src/utils.js
--- a/src/utils.js
+++ b/src/utils.js
@@ -1,5 +1,8 @@
 // Utility functions
+
 function helper() {
-  return null;
+  // Improved implementation
+  const result = computeValue();
+  return result;
 }

diff --git a/src/main.js b/src/main.js
--- a/src/main.js
+++ b/src/main.js
@@ -10,6 +10,10 @@
 const config = loadConfig();

+// New feature: logging
+function log(message) {
+  console.log('[App]', message);
+}
+
 function initialize() {
   console.log('Starting app');
 }`,
  getWorktreePath: '/tmp/worktree/e2e-test',
  getChangedFiles: [
    { file: 'src/utils.js', additions: 4, deletions: 1 },
    { file: 'src/main.js', additions: 5, deletions: 0 }
  ]
};

/**
 * Database schema
 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_number INTEGER NOT NULL,
    repository TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    review_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    submitted_at DATETIME,
    review_data TEXT,
    custom_instructions TEXT,
    UNIQUE(pr_number, repository)
  );

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
    side TEXT DEFAULT 'RIGHT',
    commit_sha TEXT,
    type TEXT,
    title TEXT,
    body TEXT,
    status TEXT DEFAULT 'active',
    adopted_as_id INTEGER,
    parent_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

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
  );

  CREATE TABLE IF NOT EXISTS worktrees (
    id TEXT PRIMARY KEY,
    pr_number INTEGER NOT NULL,
    repository TEXT NOT NULL,
    branch TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL,
    UNIQUE(pr_number, repository)
  );

  CREATE TABLE IF NOT EXISTS repo_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository TEXT NOT NULL UNIQUE,
    default_instructions TEXT,
    default_provider TEXT,
    default_model TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_number, repository);
  CREATE INDEX IF NOT EXISTS idx_comments_pr_file ON comments(pr_id, file, line_start);
  CREATE INDEX IF NOT EXISTS idx_comments_ai_run ON comments(ai_run_id);
  CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
`;

let server = null;
let db = null;

/**
 * Create in-memory database
 */
function createTestDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(':memory:', (error) => {
      if (error) {
        reject(error);
        return;
      }
      db.exec(SCHEMA_SQL, (err) => {
        if (err) reject(err);
        else resolve(db);
      });
    });
  });
}

/**
 * Insert test data
 */
async function insertTestData() {
  const prData = JSON.stringify({
    state: 'open',
    diff: mockWorktreeResponses.generateUnifiedDiff,
    changed_files: mockWorktreeResponses.getChangedFiles,
    additions: 25,
    deletions: 10,
    html_url: 'https://github.com/test-owner/test-repo/pull/1',
    base_sha: 'abc123base',
    head_sha: 'def456head',
    node_id: 'PR_test_node_123'
  });

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Insert PR metadata
      db.run(`
        INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
        VALUES (1, 'test-owner/test-repo', 'Test PR for E2E', 'Test description', 'testuser', 'main', 'feature-test', ?)
      `, [prData]);

      // Insert worktree
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
        VALUES ('e2e-test-id', 1, 'test-owner/test-repo', 'feature-test', '/tmp/worktree/e2e-test', ?, ?)
      `, [now, now], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

/**
 * Global setup - starts server before all tests
 */
async function globalSetup() {
  console.log('Starting E2E test server...');

  // Create test database
  await createTestDatabase();
  await insertTestData();

  // Mock modules before requiring routes
  const { GitHubClient } = require('../../src/github/client');
  const { GitWorktreeManager } = require('../../src/git/worktree');
  const configModule = require('../../src/config');

  // Mock GitHub client
  GitHubClient.prototype.fetchPullRequest = async () => mockGitHubResponses.fetchPullRequest;
  GitHubClient.prototype.validateToken = async () => true;
  GitHubClient.prototype.repositoryExists = async () => true;
  GitHubClient.prototype.createReviewGraphQL = async () => ({
    id: 12345,
    html_url: 'https://github.com/test-owner/test-repo/pull/1#review-12345',
    state: 'APPROVED'
  });

  // Mock worktree manager
  GitWorktreeManager.prototype.getWorktreePath = async () => mockWorktreeResponses.getWorktreePath;
  GitWorktreeManager.prototype.worktreeExists = async () => true;
  GitWorktreeManager.prototype.generateUnifiedDiff = async () => mockWorktreeResponses.generateUnifiedDiff;
  GitWorktreeManager.prototype.getChangedFiles = async () => mockWorktreeResponses.getChangedFiles;
  GitWorktreeManager.prototype.updateWorktree = async () => mockWorktreeResponses.getWorktreePath;
  GitWorktreeManager.prototype.createWorktreeForPR = async () => mockWorktreeResponses.getWorktreePath;
  GitWorktreeManager.prototype.pathExists = async () => true;

  // Mock config
  configModule.loadConfig = async () => ({
    github_token: 'test-token-e2e',
    port: 3456,
    theme: 'light',
    model: 'sonnet'
  });
  configModule.saveConfig = async () => {};
  configModule.getConfigDir = () => '/tmp/.pair-review-e2e-test';

  // Create Express app
  const app = express();
  app.use(express.json());

  // Static files
  const publicDir = path.join(__dirname, '..', '..', 'public');
  app.use(express.static(publicDir, {
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store');
    }
  }));

  // HTML routes
  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.get('/pr/:owner/:repo/:number', (req, res) => res.sendFile(path.join(publicDir, 'pr.html')));
  app.get('/settings/:owner/:repo', (req, res) => res.sendFile(path.join(publicDir, 'repo-settings.html')));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Store database and config
  app.set('db', db);
  app.set('githubToken', 'test-token-e2e');
  app.set('config', { github_token: 'test-token-e2e', port: 3456, theme: 'light', model: 'sonnet' });

  // Load API routes
  const analysisRoutes = require('../../src/routes/analysis');
  const worktreesRoutes = require('../../src/routes/worktrees');
  const commentsRoutes = require('../../src/routes/comments');
  const configRoutes = require('../../src/routes/config');
  const prRoutes = require('../../src/routes/pr');

  app.use('/', analysisRoutes);
  app.use('/', commentsRoutes);
  app.use('/', configRoutes);
  app.use('/', worktreesRoutes);
  app.use('/', prRoutes);

  // Error handling
  app.use((error, req, res, next) => {
    console.error('Test server error:', error);
    res.status(500).json({ error: 'Internal server error' });
  });
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // Start server
  return new Promise((resolve) => {
    server = app.listen(3456, () => {
      console.log('E2E test server running on http://localhost:3456');
      // Store server reference for teardown
      process.env.E2E_SERVER_PID = process.pid.toString();
      resolve();
    });
  });
}

module.exports = globalSetup;
module.exports.server = server;
module.exports.db = db;
