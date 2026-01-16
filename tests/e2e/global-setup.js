// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Playwright Global Setup
 *
 * Starts a test server with mocked dependencies before all tests run.
 */

const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

// Mock analysis timing - how long the simulated AI analysis takes
const MOCK_ANALYSIS_DURATION_MS = 500;

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

// Mock AI analysis suggestions for testing
const mockAISuggestions = [
  {
    id: 1001,
    source: 'ai',
    ai_run_id: 'test-run-001',
    ai_level: null, // Final/orchestrated suggestion
    file: 'src/utils.js',
    line_start: 3,
    line_end: 3,
    type: 'improvement',
    title: 'Consider using const for immutable values',
    body: 'The variable `result` could be declared with `const` since it is not reassigned after initialization. This makes the code more readable and prevents accidental reassignment.',
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  },
  {
    id: 1002,
    source: 'ai',
    ai_run_id: 'test-run-001',
    ai_level: null,
    file: 'src/main.js',
    line_start: 12,
    line_end: 14,
    type: 'praise',
    title: 'Good use of descriptive function naming',
    body: 'The `log` function has a clear, descriptive name that indicates its purpose. This improves code readability.',
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  },
  {
    id: 1003,
    source: 'ai',
    ai_run_id: 'test-run-001',
    ai_level: 1,
    file: 'src/utils.js',
    line_start: 5,
    line_end: 5,
    type: 'bug',
    title: 'Potential null reference',
    body: 'The `computeValue()` function may return null in some cases. Consider adding a null check before using the result.',
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  },
  {
    id: 1004,
    source: 'ai',
    ai_run_id: 'test-run-001',
    ai_level: 2,
    file: 'src/main.js',
    line_start: 13,
    line_end: 13,
    type: 'code-style',
    title: 'Consider using template literals',
    body: 'Using template literals instead of string concatenation would make this code cleaner: `console.log(`[App] ${message}`)`',
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
];

const mockWorktreeResponses = {
  // This diff tests the line number offset scenario:
  // - utils.js: First hunk at line 1-8 has +3 net change (adds 4, removes 1)
  // - utils.js: Second hunk at OLD line 50, NEW line 53 (offset = +3)
  //   The gap between hunks (lines 9-49 in OLD) should map to (lines 12-52 in NEW)
  // - The second hunk header includes function context "function exportSection()"
  //   which is defined at line 30 in the gap, for testing function context visibility
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
@@ -50,4 +53,4 @@ function exportSection()
 // Another section of code
 function exportData() {
-  return data;
+  return JSON.stringify(data);
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
    { file: 'src/utils.js', additions: 5, deletions: 2 },
    { file: 'src/main.js', additions: 5, deletions: 0 }
  ]
};

/**
 * Database schema - synchronized with production src/database.js
 * IMPORTANT: When updating production schema, also update this test schema to match
 */
const SCHEMA_SQL = `
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
    summary TEXT
  );

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
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'dismissed', 'adopted', 'submitted', 'draft', 'inactive')),
    adopted_as_id INTEGER,
    parent_id INTEGER,
    is_file_level INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (adopted_as_id) REFERENCES comments(id),
    FOREIGN KEY (parent_id) REFERENCES comments(id)
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

  CREATE TABLE IF NOT EXISTS analysis_runs (
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
  );

  CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_number, repository);
  CREATE INDEX IF NOT EXISTS idx_comments_review_file ON comments(review_id, file, line_start);
  CREATE INDEX IF NOT EXISTS idx_comments_ai_run ON comments(ai_run_id);
  CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
  CREATE INDEX IF NOT EXISTS idx_comments_file_level ON comments(review_id, file, is_file_level);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_metadata_unique ON pr_metadata(pr_number, repository);
  CREATE INDEX IF NOT EXISTS idx_worktrees_last_accessed ON worktrees(last_accessed_at);
  CREATE INDEX IF NOT EXISTS idx_worktrees_repo ON worktrees(repository);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_settings_repository ON repo_settings(repository);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_local ON reviews(local_path, local_head_sha) WHERE review_type = 'local';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_pr_unique ON reviews(pr_number, repository) WHERE review_type = 'pr';
  CREATE INDEX IF NOT EXISTS idx_analysis_runs_review_id ON analysis_runs(review_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_analysis_runs_status ON analysis_runs(status);
`;

let server = null;
let db = null;

/**
 * Create in-memory database
 *
 * Note: This database is shared across all test files for performance.
 * Tests run sequentially (workers: 1) to avoid race conditions.
 * For better isolation, see issue pair_review-3e6d.
 */
function createTestDatabase() {
  db = new Database(':memory:');
  // Enable foreign key enforcement to match production behavior
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

/**
 * Insert test data
 */
function insertTestData() {
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

  // Insert PR metadata
  db.prepare(`
    INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
    VALUES (1, 'test-owner/test-repo', 'Test PR for E2E', 'Test description', 'testuser', 'main', 'feature-test', ?)
  `).run(prData);

  // Insert review record (needed for comments to work - PR API returns review.id)
  db.prepare(`
    INSERT INTO reviews (pr_number, repository, status)
    VALUES (1, 'test-owner/test-repo', 'draft')
  `).run();

  // Insert worktree
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
    VALUES ('e2e-test-id', 1, 'test-owner/test-repo', 'feature-test', '/tmp/worktree/e2e-test', ?, ?)
  `).run(now, now);
}

/**
 * Global setup - starts server before all tests
 */
async function globalSetup() {
  console.log('Starting E2E test server...');

  // Create test database
  createTestDatabase();
  insertTestData();

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
    state: 'APPROVED',
    comments_count: 0,
    submitted_at: new Date().toISOString()
  });
  GitHubClient.prototype.createDraftReviewGraphQL = async () => ({
    id: 12346,
    html_url: 'https://github.com/test-owner/test-repo/pull/1#review-12346',
    state: 'PENDING',
    comments_count: 0
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

  // Track analysis state for mocking
  let analysisRunning = false;
  let analysisId = null;
  let analysisHasRun = false;

  // Mock AI analysis endpoint - responds with mock suggestions
  app.post('/api/analyze/:owner/:repo/:pr', (req, res) => {
    const { owner, repo, pr } = req.params;
    analysisId = `test-analysis-${Date.now()}`;
    analysisRunning = true;
    analysisHasRun = true;

    // Get PR metadata ID from database
    const prMetadata = db.prepare('SELECT id FROM pr_metadata WHERE pr_number = ? AND repository = ?')
      .get(parseInt(pr), `${owner}/${repo}`);

    if (prMetadata) {
      // Update last_ai_run_id to mark that analysis has been run
      db.prepare('UPDATE pr_metadata SET last_ai_run_id = ? WHERE id = ?')
        .run('test-run-001', prMetadata.id);

      // Insert mock AI suggestions into the database
      const insertStmt = db.prepare(`
        INSERT INTO comments (
          review_id, source, ai_run_id, ai_level, file, line_start, line_end,
          type, title, body, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const suggestion of mockAISuggestions) {
        insertStmt.run(
          prMetadata.id,
          'ai',
          suggestion.ai_run_id,
          suggestion.ai_level,
          suggestion.file,
          suggestion.line_start,
          suggestion.line_end,
          suggestion.type,
          suggestion.title,
          suggestion.body,
          suggestion.status,
          suggestion.created_at,
          suggestion.updated_at
        );
      }
    }

    // Return immediately (analysis "started")
    res.json({
      analysisId,
      status: 'started',
      message: 'AI analysis started in background'
    });

    // Simulate analysis completion after configured duration
    setTimeout(() => {
      analysisRunning = false;
    }, MOCK_ANALYSIS_DURATION_MS);
  });

  // Mock SSE endpoint for analysis progress
  app.get('/api/pr/:id/ai-suggestions/status', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // Send initial connection
    res.write('data: {"type":"connected"}\n\n');

    // Send running status after short delay
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({
        type: 'progress',
        status: 'running',
        levels: {
          1: { status: 'running', progress: 'Analyzing...' },
          2: { status: 'running', progress: 'Analyzing...' },
          3: { status: 'running', progress: 'Analyzing...' },
          4: { status: 'pending', progress: 'Pending' }
        },
        progress: 'Running analysis...'
      })}\n\n`);
    }, 100);

    // Send completion after configured duration
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({
        type: 'progress',
        status: 'completed',
        levels: {
          1: { status: 'completed', progress: 'Complete' },
          2: { status: 'completed', progress: 'Complete' },
          3: { status: 'completed', progress: 'Complete' },
          4: { status: 'completed', progress: 'Complete' }
        },
        progress: 'Analysis complete',
        completedLevel: 3,
        suggestionsCount: mockAISuggestions.length
      })}\n\n`);
      res.end();
    }, MOCK_ANALYSIS_DURATION_MS);
  });

  // Mock analysis status check endpoint
  app.get('/api/pr/:owner/:repo/:number/analysis-status', (req, res) => {
    if (analysisRunning && analysisId) {
      res.json({
        running: true,
        analysisId,
        status: { status: 'running', progress: 'Analyzing...' }
      });
    } else {
      res.json({
        running: false,
        analysisId: null,
        status: null
      });
    }
  });

  // Mock has-ai-suggestions endpoint
  app.get('/api/pr/:owner/:repo/:number/has-ai-suggestions', (req, res) => {
    const { owner, repo, number } = req.params;
    try {
      const result = db.prepare(`
        SELECT COUNT(*) as count FROM comments c
        JOIN pr_metadata p ON c.review_id = p.id
        WHERE p.pr_number = ? AND p.repository = ? AND c.source = 'ai'
      `).get(parseInt(number), `${owner}/${repo}`);
      res.json({
        hasSuggestions: result?.count > 0,
        analysisHasRun: analysisHasRun || result?.count > 0
      });
    } catch (e) {
      res.json({ hasSuggestions: false, analysisHasRun: false });
    }
  });

  // Mock check-stale endpoint (PR is never stale in tests)
  app.get('/api/pr/:owner/:repo/:number/check-stale', (req, res) => {
    res.json({
      isStale: false,
      prState: 'open',
      merged: false
    });
  });

  // Mock file-content-original endpoint for context expansion tests
  // Returns mock file content with predictable line contents for testing
  app.get('/api/file-content-original/:fileName(*)', (req, res) => {
    const fileName = decodeURIComponent(req.params.fileName);

    // Generate 60 lines of mock content for utils.js
    // Line 30 contains the function context text to test visibility feature
    if (fileName === 'src/utils.js') {
      const lines = [];
      for (let i = 1; i <= 60; i++) {
        if (i === 30) {
          // This matches the function context in the second hunk header
          lines.push('function exportSection() {');
        } else if (i <= 8) {
          // First few lines match the first hunk
          lines.push(`// Line ${i} of utils.js`);
        } else if (i >= 50) {
          // Last section for second hunk
          lines.push(`// Line ${i} of utils.js - export section`);
        } else {
          // Middle section (gap area)
          lines.push(`// Line ${i} - gap content`);
        }
      }
      return res.json({
        fileName,
        lines,
        totalLines: lines.length
      });
    }

    // For other files, return generic content
    const lines = Array.from({ length: 30 }, (_, i) => `// Line ${i + 1} of ${fileName}`);
    res.json({
      fileName,
      lines,
      totalLines: lines.length
    });
  });

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
