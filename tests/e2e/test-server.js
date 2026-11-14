// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Per-worker E2E test server
 *
 * Extracted from global-setup.js so each Playwright worker can spin up its
 * own Express server with an isolated in-memory SQLite database.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createTestDatabase } = require('../utils/schema');
const { installGitHubReviewMock } = require('../utils/github-review-mock');
const { defaultFixture, fileContentsFor, fileLinesFor } = require('./fixtures/diffs');

// ---------------------------------------------------------------------------
// Work a route does after it has answered
// ---------------------------------------------------------------------------
//
// `POST /api/reviews/:id/comments` answers and THEN adds a context file for a
// comment on a file outside the diff (`ensureContextFileForComment`, "fire and
// forget"). For the Local fixture review that first runs git in a directory
// which does not exist, so the row is written a child-process failure after
// the answer. Nothing orders that against the test, which is told "saved" by
// the browser in the same event loop this server runs in. Measured at four
// workers the row was always there by then (16 of 16); a cleanup that ran
// before it would remove nothing and hand the row to the worker's next test.
//
// The call is wrapped here, before any route module is loaded (the route
// takes the function when it is required), only to know when it has finished.
// `whenBackgroundWorkDone()` is what the fixture's reset waits for
// (tests/e2e/fixtures.js). fixture-isolation.spec.js reads
// `backgroundWorkStarted()` and fails if a comment save no longer comes
// through the wrapper.
const autoContext = require('../../src/utils/auto-context');
const backgroundWork = new Set();
let backgroundWorkCount = 0;
if (!autoContext.ensureContextFileForComment.e2eTracked) {
  const real = autoContext.ensureContextFileForComment;
  const tracked = (...args) => {
    const work = Promise.resolve(real(...args));
    backgroundWorkCount++;
    backgroundWork.add(work);
    const done = () => backgroundWork.delete(work);
    work.then(done, done);
    return work;
  };
  tracked.e2eTracked = true;
  autoContext.ensureContextFileForComment = tracked;
}

/** How many pieces of after-the-answer work this process has started. */
const backgroundWorkStarted = () => backgroundWorkCount;

/** Resolves once every piece of after-the-answer work started so far has finished. */
async function whenBackgroundWorkDone() {
  while (backgroundWork.size > 0) {
    await Promise.allSettled([...backgroundWork]);
  }
}

// Mock analysis timing - how long the simulated AI analysis takes
const MOCK_ANALYSIS_DURATION_MS = 50;

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
    reasoning: [
      'The variable `result` is assigned once and never reassigned.',
      'Using `const` communicates immutability intent to other developers.',
      'This is a minor readability improvement with no behavioral change.'
    ],
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
  },
  // Two additional suggestions on the same line for regression test (pair_review-nzu7)
  // Tests that restoring the second dismissed suggestion on the same line works correctly
  // Note: This creates THREE total suggestions on line 3 (1001, 1005, and 1006)
  {
    id: 1005,
    source: 'ai',
    ai_run_id: 'test-run-001',
    ai_level: null, // Final/orchestrated suggestion (must be null to be displayed by default)
    file: 'src/utils.js',
    line_start: 3, // Same line as suggestion 1001
    line_end: 3,
    type: 'security',
    title: 'First suggestion on line 3 (for same-line test)',
    body: 'This is the first of two suggestions targeting the same line, used for testing the restore functionality when multiple suggestions share a line.',
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  },
  {
    id: 1006,
    source: 'ai',
    ai_run_id: 'test-run-001',
    ai_level: null, // Final/orchestrated suggestion (must be null to be displayed by default)
    file: 'src/utils.js',
    line_start: 3, // Same line as suggestion 1001 and 1005
    line_end: 3,
    type: 'performance',
    title: 'Second suggestion on line 3 (for same-line test)',
    body: 'This is the second of two suggestions targeting the same line, used for testing the restore functionality when multiple suggestions share a line.',
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
];

const mockWorktreeResponses = {
  // The shared two-file fixture diff. Its shape (hunk positions, the hidden
  // gap in utils.js, the function context on the second hunk header) and the
  // full contents that belong to it are documented where they are built:
  // defaultFixture() in tests/e2e/fixtures/diffs.js.
  generateUnifiedDiff: defaultFixture().diff,
  getWorktreePath: '/tmp/worktree/e2e-test',
  getChangedFiles: [
    { file: 'src/utils.js', additions: 5, deletions: 2 },
    { file: 'src/main.js', additions: 5, deletions: 0 }
  ]
};

/**
 * Insert test data into the given database
 */
function insertTestData(db) {
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

  // Insert chat session and messages for E2E chat panel tests
  // The review record inserted above has id=1
  db.prepare(`
    INSERT INTO chat_sessions (id, review_id, provider, model, status, created_at, updated_at)
    VALUES (1, 1, 'pi', 'claude-sonnet-4', 'active', ?, ?)
  `).run(now, now);

  db.prepare(`
    INSERT INTO chat_messages (id, session_id, role, content, created_at)
    VALUES (1, 1, 'user', 'What does the computeValue function do?', ?)
  `).run(now);

  db.prepare(`
    INSERT INTO chat_messages (id, session_id, role, content, created_at)
    VALUES (2, 1, 'assistant', 'The computeValue() function computes a derived value. Based on the diff, it was introduced to replace a bare return null with a more meaningful computation.', ?)
  `).run(now);

  // Insert local review for Local mode E2E tests
  db.prepare(`
    INSERT INTO reviews (repository, status, review_type, local_path, local_head_sha, created_at, updated_at)
    VALUES ('test-repo', 'draft', 'local', '/tmp/test-local-repo', 'abc123localhead', ?, ?)
  `).run(now, now);

  // Insert a minimal diff for the local review (id=2)
  db.prepare(`
    INSERT INTO local_diffs (review_id, diff_text, stats, captured_at)
    VALUES (2, ?, ?, ?)
  `).run(
    mockWorktreeResponses.generateUnifiedDiff,
    JSON.stringify({ files_changed: 1, additions: 25, deletions: 10 }),
    now
  );
}

/**
 * Start a test server on the given port with its own isolated database.
 *
 * @param {number} port - TCP port to listen on
 * @returns {Promise<{ server: import('http').Server, db: import('better-sqlite3').Database, app: import('express').Express, port: number }>}
 */
async function startTestServer(port) {
  // Create the mock worktree directory so fs.access checks pass
  // (the /api/worktrees/recent endpoint filters out paths that don't exist)
  fs.mkdirSync(mockWorktreeResponses.getWorktreePath, { recursive: true });

  // Create test database using shared schema module
  const db = createTestDatabase();
  insertTestData(db);

  // Mock modules before requiring routes
  const { GitHubClient } = require('../../src/github/client');
  const { GitWorktreeManager } = require('../../src/git/worktree');
  const configModule = require('../../src/config');

  // Mock GitHub client
  GitHubClient.prototype.fetchPullRequest = async () => mockGitHubResponses.fetchPullRequest;
  GitHubClient.prototype.repositoryExists = async () => true;
  installGitHubReviewMock(GitHubClient);

  // Mock worktree manager
  GitWorktreeManager.prototype.getWorktreePath = async () => mockWorktreeResponses.getWorktreePath;
  GitWorktreeManager.prototype.worktreeExists = async () => true;
  GitWorktreeManager.prototype.generateUnifiedDiff = async () => mockWorktreeResponses.generateUnifiedDiff;
  GitWorktreeManager.prototype.getChangedFiles = async () => mockWorktreeResponses.getChangedFiles;
  GitWorktreeManager.prototype.updateWorktree = async () => mockWorktreeResponses.getWorktreePath;
  GitWorktreeManager.prototype.createWorktreeForPR = async () => ({ path: mockWorktreeResponses.getWorktreePath, id: 'test-wt-id' });
  GitWorktreeManager.prototype.pathExists = async () => true;

  // Mock config — use the port parameter directly
  configModule.loadConfig = async () => ({
    github_token: 'test-token-e2e',
    port: port,
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
    maxAge: '1h',
    etag: true,
  }));

  // HTML routes
  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.get('/pr/:owner/:repo/:number', (req, res) => res.sendFile(path.join(publicDir, 'pr.html')));
  app.get('/settings', (req, res) => res.sendFile(path.join(publicDir, 'settings.html')));
  app.get('/settings/:owner/:repo', (req, res) => res.sendFile(path.join(publicDir, 'repo-settings.html')));
  // Local review SETUP page (query-param form), mirrors production server.js. Serves
  // setup.html so E2E can exercise the delegated /local?path=...&scope=... flow.
  app.get('/local', (req, res) => {
    if (!req.query.path) return res.redirect('/');
    res.sendFile(path.join(publicDir, 'setup.html'));
  });
  app.get('/local/:reviewId', (req, res) => res.sendFile(path.join(publicDir, 'local.html')));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Store database and config. Build the global-settings service and overlay
  // in-app DB overrides so the effective config the routes read mirrors
  // production wiring (src/server.js).
  const { GlobalSettingsService } = require('../../src/settings/global-settings-service');
  const e2eBaseConfig = { github_token: 'test-token-e2e', port, theme: 'light', model: 'sonnet' };
  // Production-shaped layers: the raw `config` layer must carry the SAME values
  // as e2eBaseConfig so /api/settings source attribution (which walks the raw
  // layers) agrees with /api/config (the merged effective config). A bare
  // `default`-only layer would attribute port/theme/etc. to "default" while the
  // effective config reports the E2E values — a disagreement the settings page
  // would surface. Keys left out (e.g. summaries.enabled) intentionally stay at
  // their registry default.
  const e2eGlobalSettings = new GlobalSettingsService({
    db,
    baseConfig: e2eBaseConfig,
    layers: [
      { name: 'default', data: {} },
      { name: 'config', data: { github_token: 'test-token-e2e', port, theme: 'light', model: 'sonnet' } }
    ]
  });
  app.set('db', db);
  app.set('githubToken', 'test-token-e2e');
  app.set('config', e2eGlobalSettings.buildEffectiveConfig());
  app.set('globalSettings', e2eGlobalSettings);

  // Track analysis state for mocking
  let analysisRunning = false;
  let analysisId = null;
  let analysisHasRun = false;

  /**
   * What the mock analysis endpoints do for a review: record a completed
   * analysis run and insert the deterministic mock suggestions. Shared by the
   * PR-mode and Local-mode endpoints so both modes get the same rows.
   */
  function recordMockAnalysis(reviewId, requestInstructions) {
    const aiRunId = `test-run-${Date.now()}`;
    const now = new Date().toISOString();

    // Insert into analysis_runs table (required for AnalysisHistoryManager)
    db.prepare(`
      INSERT INTO analysis_runs (
        id, review_id, provider, model, custom_instructions, repo_instructions, request_instructions,
        head_sha, status, total_suggestions, files_analyzed, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      aiRunId,
      reviewId,
      'claude',
      'sonnet',
      requestInstructions || null,
      'Repository default instructions for testing',
      requestInstructions || 'Test custom instructions',
      'def456head',
      'completed',
      mockAISuggestions.length,
      2,
      now,
      now
    );

    // Insert mock AI suggestions into the database for this review
    const insertStmt = db.prepare(`
      INSERT INTO comments (
        review_id, source, ai_run_id, ai_level, file, line_start, line_end,
        type, title, body, reasoning, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const suggestion of mockAISuggestions) {
      insertStmt.run(
        reviewId,
        'ai',
        aiRunId,
        suggestion.ai_level,
        suggestion.file,
        suggestion.line_start,
        suggestion.line_end,
        suggestion.type,
        suggestion.title,
        suggestion.body,
        suggestion.reasoning ? JSON.stringify(suggestion.reasoning) : null,
        suggestion.status,
        now,
        now
      );
    }
    return aiRunId;
  }

  /** Answer "analysis started" and let the status endpoint report completion a moment later. */
  function respondAnalysisStarted(res) {
    res.json({
      analysisId,
      status: 'started',
      message: 'AI analysis started in background'
    });
    setTimeout(() => {
      analysisRunning = false;
    }, MOCK_ANALYSIS_DURATION_MS);
  }

  // Mock AI analysis endpoint - responds with mock suggestions
  app.post('/api/pr/:owner/:repo/:number/analyses', (req, res) => {
    const { owner, repo, number } = req.params;
    analysisId = `test-analysis-${Date.now()}`;
    analysisRunning = true;
    analysisHasRun = true;

    const repository = `${owner}/${repo}`;
    const prNumber = parseInt(number);

    // Get review record (which is what AnalysisHistoryManager uses)
    const review = db.prepare('SELECT id FROM reviews WHERE pr_number = ? AND repository = ?')
      .get(prNumber, repository);

    // Get PR metadata for updating last_ai_run_id
    const prMetadata = db.prepare('SELECT id FROM pr_metadata WHERE pr_number = ? AND repository = ?')
      .get(prNumber, repository);

    if (review && prMetadata) {
      const { customInstructions: requestInstructions } = req.body || {};
      const aiRunId = recordMockAnalysis(review.id, requestInstructions);
      // Update last_ai_run_id to mark that analysis has been run
      db.prepare('UPDATE pr_metadata SET last_ai_run_id = ? WHERE id = ?')
        .run(aiRunId, prMetadata.id);
    }

    respondAnalysisStarted(res);
  });

  // The same mock for Local mode (the endpoint the Local page's Analyze button
  // posts to). Without it the request would reach the real route and start a
  // real analysis of a working directory the fixture review does not have.
  app.post('/api/local/:reviewId/analyses', (req, res) => {
    const reviewId = parseInt(req.params.reviewId, 10);
    const review = db.prepare("SELECT id FROM reviews WHERE id = ? AND review_type = 'local'").get(reviewId);
    if (!review) {
      return res.status(404).json({ error: `Local review #${reviewId} not found` });
    }
    analysisId = `test-analysis-${Date.now()}`;
    analysisRunning = true;
    analysisHasRun = true;
    const { customInstructions: requestInstructions } = req.body || {};
    recordMockAnalysis(review.id, requestInstructions);
    respondAnalysisStarted(res);
  });

  // Test-only endpoint: seed a dismissed AI suggestion carrying a status_reason.
  // The loop/chat agent sets status_reason when it dismisses a finding; there is
  // no UI affordance for it (human dismissals are reason-less), so tests inject
  // one directly rather than perturbing the shared mock suggestion fixtures.
  app.post('/test/seed-dismissed-suggestion', (req, res) => {
    const {
      owner = 'test-owner',
      repo = 'test-repo',
      number = 1,
      status_reason = 'Dismissed by the agent: already handled upstream.',
      file = 'src/utils.js',
      line_start = 3,
      title = 'Seeded dismissed finding',
      type = 'bug'
    } = req.body || {};

    const repository = `${owner}/${repo}`;
    const review = db.prepare('SELECT id FROM reviews WHERE pr_number = ? AND repository = ?')
      .get(parseInt(number), repository);
    if (!review) {
      return res.status(404).json({ error: 'review not found' });
    }

    // Attach to the most recent analysis run so it appears in the default view.
    const latestRun = db.prepare(
      'SELECT id FROM analysis_runs WHERE review_id = ? ORDER BY started_at DESC LIMIT 1'
    ).get(review.id);

    const now = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO comments (
        review_id, source, ai_run_id, ai_level, file, line_start, line_end,
        type, title, body, reasoning, status, status_reason, created_at, updated_at
      ) VALUES (?, 'ai', ?, NULL, ?, ?, ?, ?, ?, ?, NULL, 'dismissed', ?, ?, ?)
    `).run(
      review.id,
      latestRun ? latestRun.id : null,
      file,
      line_start,
      line_start,
      type,
      title,
      'Body of the seeded dismissed finding.',
      status_reason,
      now,
      now
    );

    res.json({ id: Number(info.lastInsertRowid), reviewId: review.id });
  });

  // Test-only endpoint: seed AI suggestions a scenario describes itself (a
  // file of a routed corpus, a hidden line, a file-level finding), under one
  // completed analysis run, as real rows. Real rows matter: adopting a
  // suggestion saves a user comment whose parent_id is a foreign key to it,
  // and the status route updates the row. Returns the new ids in order.
  app.post('/test/seed-suggestions', (req, res) => {
    const { reviewId, suggestions = [] } = req.body || {};
    const review = db.prepare('SELECT id FROM reviews WHERE id = ?').get(parseInt(reviewId, 10));
    if (!review) {
      return res.status(404).json({ error: 'review not found' });
    }
    const now = new Date().toISOString();
    const aiRunId = `test-seeded-run-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const seed = db.transaction(() => {
      db.prepare(`
        INSERT INTO analysis_runs (
          id, review_id, provider, model, head_sha, status, total_suggestions, files_analyzed, started_at, completed_at
        ) VALUES (?, ?, 'claude', 'sonnet', 'def456head', 'completed', ?, ?, ?, ?)
      `).run(aiRunId, review.id, suggestions.length, new Set(suggestions.map((s) => s.file)).size, now, now);
      const insert = db.prepare(`
        INSERT INTO comments (
          review_id, source, ai_run_id, ai_level, file, line_start, line_end, side,
          type, title, body, status, is_file_level, created_at, updated_at
        ) VALUES (?, 'ai', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      return suggestions.map((s) => Number(insert.run(
        review.id,
        aiRunId,
        s.file,
        s.is_file_level ? null : s.line_start,
        s.is_file_level ? null : (s.line_end ?? s.line_start),
        s.side || 'RIGHT',
        s.type || 'improvement',
        s.title || 'Seeded finding',
        s.body || 'Body of the seeded finding.',
        s.status || 'active',
        s.is_file_level ? 1 : 0,
        now,
        now
      ).lastInsertRowid));
    });
    analysisHasRun = true;
    res.json({ ids: seed(), aiRunId, reviewId: review.id });
  });

  // Mock SSE endpoint for analysis progress
  app.get('/api/analyses/:id/progress', (req, res) => {
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
  app.get('/api/reviews/:reviewId/analyses/status', (req, res) => {
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

  // Mock suggestions check endpoint (unified)
  app.get('/api/reviews/:reviewId/suggestions/check', (req, res) => {
    const { reviewId } = req.params;
    try {
      const result = db.prepare(`
        SELECT COUNT(*) as count FROM comments
        WHERE review_id = ? AND source = 'ai'
      `).get(parseInt(reviewId));
      res.json({
        hasSuggestions: result?.count > 0,
        analysisHasRun: analysisHasRun || result?.count > 0
      });
    } catch (e) {
      res.json({ hasSuggestions: false, analysisHasRun: false });
    }
  });

  // Mock suggestions endpoint (unified)
  app.get('/api/reviews/:reviewId/suggestions', (req, res) => {
    const { reviewId } = req.params;
    try {
      const rows = db.prepare(`
        SELECT id, source, author, ai_run_id, ai_level, ai_confidence,
               file, line_start, line_end, side, type, title, body,
               reasoning, status, status_reason, is_file_level, created_at, updated_at
        FROM comments
        WHERE review_id = ? AND source = 'ai'
          AND (ai_level IS NULL)
          AND status IN ('active', 'dismissed', 'adopted', 'draft', 'submitted')
          AND (is_raw = 0 OR is_raw IS NULL)
        ORDER BY is_file_level DESC, file, line_start
      `).all(parseInt(reviewId));

      const suggestions = rows.map(row => ({
        ...row,
        reasoning: row.reasoning ? JSON.parse(row.reasoning) : null
      }));

      res.json({ suggestions });
    } catch (e) {
      res.json({ suggestions: [] });
    }
  });

  // Mock suggestion status update endpoint (unified)
  app.post('/api/reviews/:reviewId/suggestions/:id/status', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['adopted', 'dismissed', 'active'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    try {
      // Mirror production (updateSuggestionStatus): a status_reason may only
      // live on a dismissed row. Set it when dismissing; clear it (NULL) when
      // restoring to active or adopting. `req.body.reason` may be undefined for
      // human/adopt/restore actions, so default it to null.
      const { reason = null } = req.body;
      const statusReason = status === 'dismissed' ? reason : null;
      db.prepare('UPDATE comments SET status = ?, status_reason = ? WHERE id = ?')
        .run(status, statusReason, parseInt(id));
      res.json({ success: true, status });
    } catch (e) {
      res.status(500).json({ error: 'Failed to update status' });
    }
  });

  // E2E-only cleanup hook: delete AI-seeded suggestion + analysis-run rows for
  // a review. The mock analyses POST above inserts AI rows straight into the
  // `comments` table (source='ai') plus an `analysis_runs` row; production has
  // no route that deletes those (the user-comment DELETE routes are scoped to
  // source='user'). A describe block that seeds AI suggestions uses this so it
  // can tear down symmetrically and not leak AI rows into later tests that
  // revisit the same review on the shared per-worker DB.
  //
  // An adopted suggestion leaves a user comment whose `parent_id` points at the
  // AI row, and the user-comment DELETE route only soft-deletes (the row stays,
  // status 'inactive'). `comments.parent_id` is a foreign key without an
  // ON DELETE action, so deleting the AI row while such a child exists fails
  // with "FOREIGN KEY constraint failed". That made this route answer 500 for
  // the rest of a worker's life once any earlier test had adopted a suggestion
  // on the review. The children are detached first, in the same transaction.
  // `adopted_as_id` points the other way (AI row to user comment) and goes
  // with the AI row.
  app.delete('/api/reviews/:reviewId/ai-suggestions', (req, res) => {
    const reviewId = parseInt(req.params.reviewId, 10);
    try {
      const sweep = db.transaction(() => {
        db.prepare(`
          UPDATE comments SET parent_id = NULL
          WHERE parent_id IN (SELECT id FROM comments WHERE review_id = ? AND source = 'ai')
        `).run(reviewId);
        const info = db.prepare("DELETE FROM comments WHERE review_id = ? AND source = 'ai'").run(reviewId);
        db.prepare('DELETE FROM analysis_runs WHERE review_id = ?').run(reviewId);
        return info.changes;
      });
      res.json({ success: true, deleted: sweep() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // A Local review is never stale in tests either. The fixture review points
  // at a directory that does not exist, so the real route reports "stale",
  // the page then refreshes its diff on load, and that refresh fails (it
  // cannot run git there): an error toast on every Local page load. A spec
  // that is about staleness routes this endpoint itself.
  app.get('/api/local/:reviewId/check-stale', (req, res) => {
    res.json({ isStale: false });
  });

  // Mock check-stale endpoint (PR is never stale in tests)
  app.get('/api/pr/:owner/:repo/:number/check-stale', (req, res) => {
    res.json({
      isStale: false,
      prState: 'open',
      merged: false
    });
  });

  // Stub external-comments endpoints. The pr.js page wiring fires a
  // fire-and-forget sync + fetch on every PR load (see _loadExternalComments).
  // Without these stubs, the requests 404 against the catch-all error handler
  // below, which surfaces as a leaking ".toast-error: Failed to load github
  // review comments" toast and breaks unrelated tests that assert on toast
  // visibility. Tests that exercise the real external-comment flow override
  // these via `page.route(...)` — see tests/e2e/external-comments.spec.js.
  app.post('/api/reviews/:reviewId/external-comments/sync', (req, res) => {
    res.json({ count: 0, lostAnchors: 0, syncedAt: new Date().toISOString() });
  });
  app.get('/api/reviews/:reviewId/external-comments', (req, res) => {
    res.json({ threads: [] });
  });

  // Mock file-content-original endpoint for context expansion tests.
  // Corpus paths get their real lines; anything else 30 generic lines.
  app.get('/api/file-content-original/:fileName(*)', (req, res) => {
    const fileName = decodeURIComponent(req.params.fileName);

    // A corpus path (tests/e2e/fixtures/diffs.js) gets its real new-side lines.
    const corpusLines = fileLinesFor(fileName);
    if (corpusLines) {
      return res.json({ fileName, lines: corpusLines, totalLines: corpusLines.length });
    }

    const lines = Array.from({ length: 30 }, (_, i) => `// Line ${i + 1} of ${fileName}`);
    res.json({
      fileName,
      lines,
      totalLines: lines.length
    });
  });

  // New reviewId-centric file content endpoint (mirrors the legacy mock above)
  app.get('/api/reviews/:reviewId/file-content/:fileName(*)', (req, res) => {
    const fileName = decodeURIComponent(req.params.fileName);

    // A corpus path (tests/e2e/fixtures/diffs.js) gets its real new-side lines.
    const corpusLines = fileLinesFor(fileName);
    if (corpusLines) {
      return res.json({ fileName, lines: corpusLines, totalLines: corpusLines.length });
    }

    const lines = Array.from({ length: 30 }, (_, i) => `// Line ${i + 1} of ${fileName}`);
    res.json({ fileName, lines, totalLines: lines.length });
  });

  // File-contents endpoint: the frontend fetches a file's full old and new
  // contents after rendering its patch and upgrades the diff with them, which
  // is what enables hunk expansion. The real route (src/routes/reviews.js)
  // reads git blobs from a worktree; E2E has no worktree.
  //
  // Every path of the default fixture and of the corpora in
  // tests/e2e/fixtures/diffs.js is answered with the contents its patch was
  // generated from, so the upgraded diff is the diff the patch describes.
  //
  // Any other path gets a generic 40-line pair with one changed line. That is
  // NOT truthful for whatever patch the test routed under that path: the
  // upgrade then re-lays the file out with a different diff. A spec that
  // routes its own diff and cares about what is rendered after the upgrade
  // routes this endpoint too (see inline-feedback-context.spec.js).
  // E2E_CONTENTS_LOG=<file> records the unregistered paths that were asked for.
  app.get('/api/reviews/:reviewId/file-contents/:fileName(*)', (req, res) => {
    const fileName = decodeURIComponent(req.params.fileName);

    const registered = fileContentsFor(fileName);
    if (registered) return res.json(registered);

    if (process.env.E2E_CONTENTS_LOG) {
      try {
        fs.appendFileSync(process.env.E2E_CONTENTS_LOG, `${JSON.stringify({ fileName, query: req.query })}\n`);
      } catch {
        // A survey aid; failing to write it must not fail a request.
      }
    }
    const base = Array.from({ length: 40 }, (_, i) => `// ${fileName} line ${i + 1}`);
    const oldContents = base.join('\n') + '\n';
    const newBase = base.slice();
    newBase[20] = `// ${fileName} line 21 (modified)`;
    const newContents = newBase.join('\n') + '\n';
    res.json({ fileName, oldContents, newContents });
  });

  // Load API routes
  const analysisRoutes = require('../../src/routes/analyses');
  const worktreesRoutes = require('../../src/routes/worktrees');
  const reviewsRoutes = require('../../src/routes/reviews');
  const configRoutes = require('../../src/routes/config');
  const prRoutes = require('../../src/routes/pr');
  const councilRoutes = require('../../src/routes/councils');
  const chatRoutes = require('../../src/routes/chat');
  const localRoutes = require('../../src/routes/local');
  const contextFilesRoutes = require('../../src/routes/context-files');
  const bulkAnalysisConfigsRoutes = require('../../src/routes/bulk-analysis-configs');
  const settingsRoutes = require('../../src/routes/settings');
  const snippetsRoutes = require('../../src/routes/snippets');

  // Mock chat session manager for E2E (reads from DB, no real bridge).
  // createSession/sendMessage write to the DB so multi-tab tests that open
  // additional sessions can observe distinct ids via /api/review/.../chat/sessions.
  app.chatSessionManager = {
    createSession: async ({ reviewId, provider = 'pi', model = 'claude-sonnet-4' }) => {
      const now = new Date().toISOString();
      // Stamp a fake agent_session_id so the chat route treats this as a
      // resumable session (without it, the /message route bails with 410
      // and tests can never exercise sendMessage).
      const info = db.prepare(`
        INSERT INTO chat_sessions (review_id, provider, model, status, agent_session_id, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?)
      `).run(reviewId, provider, model, `mock-agent-session-${Date.now()}`, now, now);
      return { id: info.lastInsertRowid, status: 'active' };
    },
    // Match production sendMessage signature: (sessionId, content, options).
    // Persist contextData rows FIRST (mirrors production) so message history
    // round-trips show context cards in the right order, then the user
    // message row. Real WS bridge isn't running in E2E so no broadcast.
    sendMessage: async (sessionId, content, options = {}) => {
      const { contextData } = options;
      const insertAll = db.transaction(() => {
        if (contextData) {
          const ctxStmt = db.prepare(`
            INSERT INTO chat_messages (session_id, role, type, content)
            VALUES (?, 'user', 'context', ?)
          `);
          const items = Array.isArray(contextData) ? contextData : [contextData];
          for (const item of items) {
            ctxStmt.run(sessionId, typeof item === 'string' ? item : JSON.stringify(item));
          }
        }
        return db.prepare(`
          INSERT INTO chat_messages (session_id, role, type, content)
          VALUES (?, 'user', 'message', ?)
        `).run(sessionId, content);
      });
      const info = insertAll();
      return { id: Number(info.lastInsertRowid) };
    },
    closeSession: async (sessionId) => {
      db.prepare("UPDATE chat_sessions SET status='closed', updated_at=CURRENT_TIMESTAMP WHERE id = ?").run(sessionId);
    },
    getSession: (id) => db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) || null,
    getSessionsWithMessageCount: (reviewId) =>
      db.prepare(`
        SELECT s.*, COUNT(m.id) AS message_count,
          (SELECT content FROM chat_messages
           WHERE session_id = s.id AND role = 'user' AND type = 'message'
           ORDER BY id ASC LIMIT 1
          ) AS first_message
        FROM chat_sessions s
        LEFT JOIN chat_messages m ON m.session_id = s.id AND m.type = 'message'
        WHERE s.review_id = ?
        GROUP BY s.id
        ORDER BY s.updated_at DESC
      `).all(reviewId),
    getSessionsForReview: (reviewId) =>
      db.prepare('SELECT * FROM chat_sessions WHERE review_id = ? ORDER BY created_at DESC').all(reviewId),
    // Mirror production: order by id ASC. Using created_at ASC would let two
    // rows inserted in the same millisecond return out of order.
    getMessages: (sessionId) =>
      db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC').all(sessionId),
    resumeSession: async () => {},
    saveContextMessage: () => ({ id: 0 }),
    onDelta: () => () => {},
    onComplete: () => () => {},
    onToolUse: () => () => {},
    onStatus: () => () => {},
    onError: () => () => {},
    // Mark the seeded session as active so the chat route forwards messages
    // straight to sendMessage instead of trying the resume branch.
    isSessionActive: () => true,
    abortSession: () => {}
  };

  app.use('/', analysisRoutes);
  app.use('/', reviewsRoutes);
  app.use('/', configRoutes);
  app.use('/', worktreesRoutes);
  app.use('/', prRoutes);
  app.use('/', councilRoutes);
  app.use('/', chatRoutes);
  app.use('/', localRoutes);
  app.use('/', contextFilesRoutes);
  app.use('/', bulkAnalysisConfigsRoutes);
  app.use('/', settingsRoutes);
  app.use('/', snippetsRoutes);

  // Error handling
  app.use((error, req, res, next) => {
    console.error('Test server error:', error);
    res.status(500).json({ error: 'Internal server error' });
  });
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // Start server on the given port. On failure (EADDRINUSE when a previous run's
  // socket has not released yet) close the database before rejecting, so the
  // caller's retry does not leak a handle per attempt.
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const srv = app.listen(port, () => resolve(srv));
      srv.on('error', (err) => reject(err));
    });
  } catch (err) {
    try { db.close(); } catch { /* already closed */ }
    throw err;
  }

  console.log(`E2E test server (worker) running on http://localhost:${port}`);

  return { server, db, app, port, whenBackgroundWorkDone, backgroundWorkStarted };
}

module.exports = { startTestServer };
