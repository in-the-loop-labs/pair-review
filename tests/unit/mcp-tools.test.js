// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const { ReviewRepository, CommentRepository, AnalysisRunRepository, run } = require('../../src/database.js');
const { resolveReview, createMCPServer } = require('../../src/routes/mcp');
const { activeAnalyses, localReviewToAnalysisId, prToAnalysisId, getLocalReviewKey, getPRKey } = require('../../src/routes/shared');
const Analyzer = require('../../src/ai/analyzer');
const { GitWorktreeManager } = require('../../src/git/worktree');

describe('resolveReview', () => {
  let db;

  beforeEach(async () => {
    db = createTestDatabase();
  });

  afterEach(async () => {
    if (db) closeTestDatabase(db);
  });

  it('should resolve a local review by path + headSha', async () => {
    const reviewRepo = new ReviewRepository(db);
    await reviewRepo.upsertLocalReview({
      localPath: '/tmp/my-repo',
      localHeadSha: 'abc123',
      repository: 'local',
    });

    const { review, error } = await resolveReview({ path: '/tmp/my-repo', headSha: 'abc123' }, db);
    expect(error).toBeNull();
    expect(review).not.toBeNull();
    expect(review.local_path).toBe('/tmp/my-repo');
    expect(review.local_head_sha).toBe('abc123');
  });

  it('should resolve a PR review by repo + prNumber', async () => {
    const reviewRepo = new ReviewRepository(db);
    await reviewRepo.createReview({ prNumber: 42, repository: 'owner/repo' });

    const { review, error } = await resolveReview({ repo: 'owner/repo', prNumber: 42 }, db);
    expect(error).toBeNull();
    expect(review).not.toBeNull();
    expect(review.pr_number).toBe(42);
    expect(review.repository).toBe('owner/repo');
  });

  it('should return error when no matching local review found', async () => {
    const { review, error } = await resolveReview({ path: '/nope', headSha: 'missing' }, db);
    expect(review).toBeNull();
    expect(error).toContain('No local review found');
  });

  it('should return error when no matching PR review found', async () => {
    const { review, error } = await resolveReview({ repo: 'owner/repo', prNumber: 999 }, db);
    expect(review).toBeNull();
    expect(error).toContain('No review found for PR #999');
  });

  it('should return error when neither lookup pair is provided', async () => {
    const { review, error } = await resolveReview({}, db);
    expect(review).toBeNull();
    expect(error).toContain('You must provide either');
  });

  it('should return error when only path is provided without headSha', async () => {
    const { review, error } = await resolveReview({ path: '/tmp/repo' }, db);
    expect(review).toBeNull();
    expect(error).toContain('You must provide either');
  });

  it('should return error when only repo is provided without prNumber', async () => {
    const { review, error } = await resolveReview({ repo: 'owner/repo' }, db);
    expect(review).toBeNull();
    expect(error).toContain('You must provide either');
  });
});

// Tests invoke tools through the MCP SDK's Client + InMemoryTransport,
// testing the actual handler logic including grouping, formatting, and filtering.
describe('MCP tools via in-memory client', () => {
  let db;
  let client;
  let mcpServer;

  beforeEach(async () => {
    db = createTestDatabase();

    // Seed a review with comments and an analysis run
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.createReview({ prNumber: 1, repository: 'test/repo' });

    // Seed user comments
    const commentRepo = new CommentRepository(db);
    await commentRepo.createLineComment({
      review_id: review.id,
      file: 'src/app.js',
      line_start: 10,
      line_end: 10,
      body: 'This needs a null check',
      type: 'issue',
      title: 'Missing null check',
    });
    await commentRepo.createLineComment({
      review_id: review.id,
      file: 'src/utils.js',
      line_start: 5,
      line_end: 8,
      body: 'Nice refactor',
      type: 'praise',
      title: 'Good work',
    });

    // Seed an analysis run
    const analysisRunRepo = new AnalysisRunRepository(db);
    await analysisRunRepo.create({
      id: 'run-001',
      reviewId: review.id,
      provider: 'claude',
      model: 'sonnet',
    });
    await analysisRunRepo.update('run-001', {
      status: 'completed',
      summary: 'Found 2 issues',
      totalSuggestions: 2,
      filesAnalyzed: 2,
    });

    // Seed AI suggestions (final/orchestrated level - ai_level IS NULL)
    await run(db, `
      INSERT INTO comments (review_id, source, author, file, line_start, line_end, side, type, title, body, status, ai_run_id, ai_level, ai_confidence)
      VALUES (?, 'ai', 'AI', 'src/app.js', 15, 18, 'RIGHT', 'bug', 'Potential null dereference', 'Variable x may be null here', 'active', 'run-001', NULL, 0.95)
    `, [review.id]);
    await run(db, `
      INSERT INTO comments (review_id, source, author, file, line_start, line_end, side, type, title, body, status, ai_run_id, ai_level, ai_confidence)
      VALUES (?, 'ai', 'AI', 'src/utils.js', 20, 22, 'RIGHT', 'improvement', 'Simplify logic', 'This could be simplified with optional chaining', 'active', 'run-001', NULL, 0.80)
    `, [review.id]);

    // Seed a level-1 suggestion
    await run(db, `
      INSERT INTO comments (review_id, source, author, file, line_start, line_end, side, type, title, body, status, ai_run_id, ai_level, ai_confidence)
      VALUES (?, 'ai', 'AI', 'src/app.js', 15, 18, 'RIGHT', 'bug', 'Level 1 bug', 'Level 1 detail', 'active', 'run-001', 1, 0.90)
    `, [review.id]);

    // Seed a dismissed suggestion
    await run(db, `
      INSERT INTO comments (review_id, source, author, file, line_start, line_end, side, type, title, body, status, ai_run_id, ai_level, ai_confidence)
      VALUES (?, 'ai', 'AI', 'src/app.js', 30, 32, 'RIGHT', 'nitpick', 'Dismissed nit', 'This was dismissed', 'dismissed', 'run-001', NULL, 0.50)
    `, [review.id]);

    // Connect MCP server and client via in-memory transport
    mcpServer = createMCPServer(db);
    client = new Client({ name: 'test-client', version: '1.0.0' });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await mcpServer.close();
    if (db) closeTestDatabase(db);
  });

  it('should list all tools (no port option)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('get_analysis_prompt');
    expect(names).toContain('get_user_comments');
    expect(names).toContain('get_ai_analysis_runs');
    expect(names).toContain('get_ai_suggestions');
    expect(names).toContain('start_analysis');
    expect(names).not.toContain('get_analysis_status');
    expect(names).not.toContain('get_ai_analysis_run');
    expect(tools).toHaveLength(5);
  });

  describe('get_analysis_prompt', () => {
    const PROMPT_TYPES = ['level1', 'level2', 'level3', 'orchestration'];

    for (const type of PROMPT_TYPES) {
      it(`should return non-empty text for ${type}`, async () => {
        const result = await client.callTool({
          name: 'get_analysis_prompt',
          arguments: { promptType: type },
        });
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text.length).toBeGreaterThan(100);
      });
    }

    it('should default to balanced tier when omitted', async () => {
      const withDefault = await client.callTool({
        name: 'get_analysis_prompt',
        arguments: { promptType: 'level1' },
      });
      const withExplicit = await client.callTool({
        name: 'get_analysis_prompt',
        arguments: { promptType: 'level1', tier: 'balanced' },
      });
      expect(withDefault.content[0].text).toBe(withExplicit.content[0].text);
    });

    it('should have no XML section tags in output', async () => {
      const result = await client.callTool({
        name: 'get_analysis_prompt',
        arguments: { promptType: 'level1', tier: 'thorough' },
      });
      expect(result.content[0].text).not.toMatch(/<section[\s>]/);
      expect(result.content[0].text).not.toMatch(/<\/section>/);
    });

    it('should include custom instructions when provided', async () => {
      const result = await client.callTool({
        name: 'get_analysis_prompt',
        arguments: {
          promptType: 'level2',
          tier: 'fast',
          customInstructions: 'Focus on error handling patterns',
        },
      });
      expect(result.content[0].text).toContain('Focus on error handling patterns');
    });

    it('should work without any database seeding (stateless tool)', async () => {
      // This test uses the same client/server setup which has DB seeding,
      // but the tool itself never touches the database.
      const result = await client.callTool({
        name: 'get_analysis_prompt',
        arguments: { promptType: 'orchestration', tier: 'thorough' },
      });
      expect(result.content[0].text.length).toBeGreaterThan(100);
    });
  });

  describe('get_ai_analysis_runs', () => {
    it('should return analysis runs for a review', async () => {
      const result = await client.callTool({
        name: 'get_ai_analysis_runs',
        arguments: { repo: 'test/repo', prNumber: 1 },
      });
      const content = JSON.parse(result.content[0].text);

      expect(content.review_id).toBe(1);
      expect(content.count).toBe(1);
      expect(content.runs[0].id).toBe('run-001');
      expect(content.runs[0].provider).toBe('claude');
      expect(content.runs[0].model).toBe('sonnet');
      expect(content.runs[0].status).toBe('completed');
      expect(content.runs[0].summary).toBe('Found 2 issues');
      expect(content.runs[0].head_sha).toBeNull();
      expect(content.runs[0].total_suggestions).toBe(2);
      expect(content.runs[0].files_analyzed).toBe(2);
      expect(content.runs[0].started_at).toBeDefined();
      expect(content.runs[0].completed_at).toBeDefined();
    });

    it('should return empty runs for review with no analysis', async () => {
      const reviewRepo = new ReviewRepository(db);
      await reviewRepo.createReview({ prNumber: 99, repository: 'empty/repo' });

      const result = await client.callTool({
        name: 'get_ai_analysis_runs',
        arguments: { repo: 'empty/repo', prNumber: 99 },
      });
      const content = JSON.parse(result.content[0].text);

      expect(content.count).toBe(0);
      expect(content.runs).toEqual([]);
    });

    it('should return error for missing review', async () => {
      const result = await client.callTool({
        name: 'get_ai_analysis_runs',
        arguments: { repo: 'nope/nope', prNumber: 999 },
      });
      const content = JSON.parse(result.content[0].text);

      expect(content.error).toContain('No review found');
    });

    it('should respect limit parameter', async () => {
      // Seed a second analysis run
      const analysisRunRepo = new AnalysisRunRepository(db);
      await analysisRunRepo.create({
        id: 'run-002',
        reviewId: 1,
        provider: 'claude',
        model: 'sonnet',
      });
      await analysisRunRepo.update('run-002', {
        status: 'completed',
        summary: 'Found 1 issue',
        totalSuggestions: 1,
        filesAnalyzed: 1,
      });

      // Without limit — should return both runs
      const allResult = await client.callTool({
        name: 'get_ai_analysis_runs',
        arguments: { repo: 'test/repo', prNumber: 1 },
      });
      const allContent = JSON.parse(allResult.content[0].text);
      expect(allContent.count).toBe(2);

      // With limit=1 — should return only most recent run
      const limitResult = await client.callTool({
        name: 'get_ai_analysis_runs',
        arguments: { repo: 'test/repo', prNumber: 1, limit: 1 },
      });
      const limitContent = JSON.parse(limitResult.content[0].text);
      expect(limitContent.count).toBe(1);
    });
  });

  describe('get_user_comments', () => {
    it('should return user comments grouped by file', async () => {
      const result = await client.callTool({
        name: 'get_user_comments',
        arguments: { repo: 'test/repo', prNumber: 1 },
      });
      const content = JSON.parse(result.content[0].text);

      expect(content.review_id).toBe(1);
      expect(Object.keys(content.comments)).toHaveLength(2);
      expect(content.comments['src/app.js']).toHaveLength(1);
      expect(content.comments['src/app.js'][0].body).toBe('This needs a null check');
      expect(content.comments['src/app.js'][0].type).toBe('issue');
      expect(content.comments['src/utils.js']).toHaveLength(1);
      expect(content.comments['src/utils.js'][0].body).toBe('Nice refactor');
    });

    it('should filter comments by file', async () => {
      const result = await client.callTool({
        name: 'get_user_comments',
        arguments: { repo: 'test/repo', prNumber: 1, file: 'src/app.js' },
      });
      const content = JSON.parse(result.content[0].text);

      expect(Object.keys(content.comments)).toHaveLength(1);
      expect(content.comments['src/app.js']).toHaveLength(1);
    });

    it('should return empty comments for non-existent file filter', async () => {
      const result = await client.callTool({
        name: 'get_user_comments',
        arguments: { repo: 'test/repo', prNumber: 1, file: 'nonexistent.js' },
      });
      const content = JSON.parse(result.content[0].text);

      expect(content.comments).toEqual({});
    });

    it('should return error for missing review', async () => {
      const result = await client.callTool({
        name: 'get_user_comments',
        arguments: { repo: 'nope/nope', prNumber: 999 },
      });
      const content = JSON.parse(result.content[0].text);

      expect(content.error).toContain('No review found');
    });

    it('should return error when no lookup params provided', async () => {
      const result = await client.callTool({
        name: 'get_user_comments',
        arguments: {},
      });
      const content = JSON.parse(result.content[0].text);

      expect(content.error).toContain('You must provide either');
    });
  });

  describe('get_ai_suggestions', () => {
    it('should return final suggestions from the latest run', async () => {
      const result = await client.callTool({
        name: 'get_ai_suggestions',
        arguments: { repo: 'test/repo', prNumber: 1 },
      });
      const content = JSON.parse(result.content[0].text);

      // Default excludes dismissed, so only the 2 active final suggestions
      expect(content.count).toBe(2);
      expect(content.run_id).toBe('run-001');
      expect(content.summary).toBe('Found 2 issues');
      expect(content.suggestions[0].file).toBe('src/app.js');
      expect(content.suggestions[0].ai_confidence).toBe(0.95);
      expect(content.suggestions[0].title).toBe('Potential null dereference');
      expect(content.suggestions[1].file).toBe('src/utils.js');
    });

    it('should exclude dismissed suggestions by default', async () => {
      const result = await client.callTool({
        name: 'get_ai_suggestions',
        arguments: { repo: 'test/repo', prNumber: 1 },
      });
      const content = JSON.parse(result.content[0].text);

      const titles = content.suggestions.map(s => s.title);
      expect(titles).not.toContain('Dismissed nit');
    });

    it('should return dismissed suggestions when explicitly requested', async () => {
      const result = await client.callTool({
        name: 'get_ai_suggestions',
        arguments: { repo: 'test/repo', prNumber: 1, status: 'dismissed' },
      });
      const content = JSON.parse(result.content[0].text);

      expect(content.count).toBe(1);
      expect(content.suggestions[0].title).toBe('Dismissed nit');
      expect(content.suggestions[0].status).toBe('dismissed');
    });

    it('should filter by file', async () => {
      const result = await client.callTool({
        name: 'get_ai_suggestions',
        arguments: { repo: 'test/repo', prNumber: 1, file: 'src/utils.js' },
      });
      const content = JSON.parse(result.content[0].text);

      expect(content.count).toBe(1);
      expect(content.suggestions[0].file).toBe('src/utils.js');
    });

    it('should return empty when no AI suggestions exist', async () => {
      const reviewRepo = new ReviewRepository(db);
      await reviewRepo.createReview({ prNumber: 99, repository: 'empty/repo' });

      const result = await client.callTool({
        name: 'get_ai_suggestions',
        arguments: { repo: 'empty/repo', prNumber: 99 },
      });
      const content = JSON.parse(result.content[0].text);

      expect(content.count).toBe(0);
      expect(content.run_id).toBeNull();
      expect(content.summary).toBeNull();
      expect(content.suggestions).toEqual([]);
    });

    it('should return suggestions from a specific run via runId', async () => {
      const result = await client.callTool({
        name: 'get_ai_suggestions',
        arguments: { repo: 'test/repo', prNumber: 1, runId: 'run-001' },
      });
      const content = JSON.parse(result.content[0].text);

      expect(content.count).toBe(2);
      expect(content.run_id).toBe('run-001');
      expect(content.summary).toBe('Found 2 issues');
      expect(content.suggestions[0].title).toBe('Potential null dereference');
    });

    it('should return suggestions using only runId (no review lookup)', async () => {
      const result = await client.callTool({
        name: 'get_ai_suggestions',
        arguments: { runId: 'run-001' },
      });
      const content = JSON.parse(result.content[0].text);

      // review_id is resolved from the analysis run
      expect(content.review_id).toBe(1);
      expect(content.run_id).toBe('run-001');
      expect(content.summary).toBe('Found 2 issues');
      expect(content.count).toBe(2);
      expect(content.suggestions[0].title).toBe('Potential null dereference');
    });

    it('should return empty suggestions for nonexistent runId', async () => {
      const result = await client.callTool({
        name: 'get_ai_suggestions',
        arguments: { runId: 'nonexistent-run' },
      });
      const content = JSON.parse(result.content[0].text);

      expect(content.count).toBe(0);
      expect(content.suggestions).toEqual([]);
    });

    it('should return error for missing review', async () => {
      const result = await client.callTool({
        name: 'get_ai_suggestions',
        arguments: { repo: 'nope/nope', prNumber: 999 },
      });
      const content = JSON.parse(result.content[0].text);

      expect(content.error).toContain('No review found');
    });
  });

});

describe('get_server_info tool', () => {
  let db;
  let client;
  let mcpServer;

  beforeEach(async () => {
    db = createTestDatabase();

    // Create MCP server WITH port option to enable get_server_info
    mcpServer = createMCPServer(db, { port: 3456 });
    client = new Client({ name: 'test-client', version: '1.0.0' });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await mcpServer.close();
    if (db) closeTestDatabase(db);
  });

  it('should register 6 tools when port option is provided', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('get_server_info');
    expect(names).toContain('get_analysis_prompt');
    expect(names).toContain('get_user_comments');
    expect(names).toContain('get_ai_analysis_runs');
    expect(names).toContain('get_ai_suggestions');
    expect(names).toContain('start_analysis');
    expect(tools).toHaveLength(6);
  });

  it('should return JSON with url, port, and version', async () => {
    const result = await client.callTool({
      name: 'get_server_info',
      arguments: {},
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.url).toBe('http://localhost:3456');
    expect(content.port).toBe(3456);
    expect(content.version).toBeDefined();
    expect(typeof content.version).toBe('string');
  });

  it('should not register get_server_info when no port option is provided', async () => {
    // Create a second server without port
    const serverNoPort = createMCPServer(db);
    const clientNoPort = new Client({ name: 'test-client-no-port', version: '1.0.0' });

    const [clientTransport2, serverTransport2] = InMemoryTransport.createLinkedPair();
    await serverNoPort.connect(serverTransport2);
    await clientNoPort.connect(clientTransport2);

    const { tools } = await clientNoPort.listTools();
    const names = tools.map(t => t.name);
    expect(names).not.toContain('get_server_info');
    expect(tools).toHaveLength(5);

    await clientNoPort.close();
    await serverNoPort.close();
  });
});

describe('start_analysis tool', () => {
  let db;
  let client;
  let mcpServer;
  let analyzeLevel1Spy;
  let getLocalChangedFilesSpy;
  let worktreeExistsSpy;
  let getWorktreePathSpy;

  beforeEach(async () => {
    db = createTestDatabase();

    // Mock Analyzer prototype methods
    analyzeLevel1Spy = vi.spyOn(Analyzer.prototype, 'analyzeLevel1').mockResolvedValue({
      runId: 'mock-run-id',
      suggestions: [{ type: 'bug', title: 'Test bug', file: 'test.js', line_start: 1 }],
      summary: 'Found 1 issue',
      level2Result: null,
    });
    getLocalChangedFilesSpy = vi.spyOn(Analyzer.prototype, 'getLocalChangedFiles').mockResolvedValue(['test.js']);

    // Mock GitWorktreeManager prototype methods
    worktreeExistsSpy = vi.spyOn(GitWorktreeManager.prototype, 'worktreeExists').mockResolvedValue(true);
    getWorktreePathSpy = vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue('/tmp/worktree/test');

    mcpServer = createMCPServer(db, { config: { default_provider: 'claude', default_model: 'sonnet' } });
    client = new Client({ name: 'test-client', version: '1.0.0' });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await mcpServer.close();
    if (db) closeTestDatabase(db);
    // Clean up any active analyses and tracking maps left by tests
    activeAnalyses.clear();
    localReviewToAnalysisId.clear();
    prToAnalysisId.clear();
    vi.restoreAllMocks();
  });

  it('should start analysis for a local review', async () => {
    // Seed a local review
    const reviewRepo = new ReviewRepository(db);
    await reviewRepo.upsertLocalReview({
      localPath: '/tmp/test-repo',
      localHeadSha: 'abc123',
      repository: 'test-repo',
    });

    const result = await client.callTool({
      name: 'start_analysis',
      arguments: { path: '/tmp/test-repo', headSha: 'abc123' },
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.status).toBe('started');
    expect(content.analysisId).toBeDefined();
    expect(content.runId).toBeDefined();
    expect(content.runId).toBe(content.analysisId);
    expect(content.reviewId).toBeDefined();
    expect(content.message).toContain('started');

    // Verify analyzer was called
    expect(getLocalChangedFilesSpy).toHaveBeenCalledWith('/tmp/test-repo');
    expect(analyzeLevel1Spy).toHaveBeenCalled();

    // Verify analysis is tracked in activeAnalyses
    const status = activeAnalyses.get(content.analysisId);
    expect(status).toBeDefined();
    // Status may already be 'completed' since mock resolves immediately
    expect(['running', 'completed']).toContain(status.status);
  });

  it('should create DB analysis_runs record immediately on start', async () => {
    const reviewRepo = new ReviewRepository(db);
    await reviewRepo.upsertLocalReview({
      localPath: '/tmp/db-record-repo',
      localHeadSha: 'dbr123',
      repository: 'db-record-repo',
    });

    const result = await client.callTool({
      name: 'start_analysis',
      arguments: { path: '/tmp/db-record-repo', headSha: 'dbr123' },
    });
    const content = JSON.parse(result.content[0].text);

    // The analysis_runs record should exist immediately
    const analysisRunRepo = new AnalysisRunRepository(db);
    const run = await analysisRunRepo.getById(content.runId);
    expect(run).not.toBeNull();
    expect(run.id).toBe(content.runId);
    expect(run.status).toBe('running');
  });

  it('should create a new local review if one does not exist', async () => {
    const result = await client.callTool({
      name: 'start_analysis',
      arguments: { path: '/tmp/new-repo', headSha: 'def456' },
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.status).toBe('started');
    expect(content.reviewId).toBeDefined();

    // Verify review was created
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReview('/tmp/new-repo', 'def456');
    expect(review).not.toBeNull();
  });

  it('should start analysis for a PR review', async () => {
    // Seed PR metadata and review
    const reviewRepo = new ReviewRepository(db);
    await reviewRepo.createReview({ prNumber: 42, repository: 'owner/repo' });

    await run(db, `
      INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch)
      VALUES (42, 'owner/repo', 'Test PR', 'Description', 'author', 'main', 'feature')
    `);

    const result = await client.callTool({
      name: 'start_analysis',
      arguments: { repo: 'owner/repo', prNumber: 42 },
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.status).toBe('started');
    expect(content.analysisId).toBeDefined();
    expect(content.reviewId).toBeDefined();

    // Verify analyzer was called
    expect(analyzeLevel1Spy).toHaveBeenCalled();
  });

  it('should return error when PR metadata not found', async () => {
    const result = await client.callTool({
      name: 'start_analysis',
      arguments: { repo: 'owner/repo', prNumber: 999 },
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.error).toContain('not found');
  });

  it('should return error when worktree not found', async () => {
    // Seed PR metadata but make worktree check fail
    await run(db, `
      INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch)
      VALUES (42, 'owner/repo', 'Test PR', 'Description', 'author', 'main', 'feature')
    `);
    worktreeExistsSpy.mockResolvedValue(false);

    const result = await client.callTool({
      name: 'start_analysis',
      arguments: { repo: 'owner/repo', prNumber: 42 },
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.error).toContain('Worktree not found');
  });

  it('should return error when no review mode specified', async () => {
    const result = await client.callTool({
      name: 'start_analysis',
      arguments: {},
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.error).toContain('You must provide either');
  });

  it('should accept customInstructions and skipLevel3 parameters', async () => {
    const reviewRepo = new ReviewRepository(db);
    await reviewRepo.upsertLocalReview({
      localPath: '/tmp/test-repo',
      localHeadSha: 'abc123',
      repository: 'test-repo',
    });

    const result = await client.callTool({
      name: 'start_analysis',
      arguments: {
        path: '/tmp/test-repo',
        headSha: 'abc123',
        customInstructions: 'Focus on security',
        skipLevel3: true,
        tier: 'fast',
      },
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.status).toBe('started');

    // Verify the analyzer was called with correct options
    const callArgs = analyzeLevel1Spy.mock.calls[0];
    // options is the 7th arg (index 6)
    expect(callArgs[6]).toMatchObject({
      tier: 'fast',
      skipLevel3: true,
    });
    // instructions is the 5th arg (index 4)
    expect(callArgs[4]).toMatchObject({
      requestInstructions: 'Focus on security',
    });
  });

  it('should return error for malformed repo format', async () => {
    const result = await client.callTool({
      name: 'start_analysis',
      arguments: { repo: 'invalid-format', prNumber: 1 },
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.error).toBeDefined();
  });

  it('should reject repo format with extra path segments', async () => {
    const result = await client.callTool({
      name: 'start_analysis',
      arguments: { repo: 'owner/repo/extra', prNumber: 1 },
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.error).toContain('owner/repo');
  });

  it('should return already_running for concurrent local analysis', async () => {
    const reviewRepo = new ReviewRepository(db);
    const reviewId = await reviewRepo.upsertLocalReview({
      localPath: '/tmp/test-repo',
      localHeadSha: 'abc123',
      repository: 'test-repo',
    });

    // Make analyzeLevel1 hang so the first analysis stays in "running" state
    analyzeLevel1Spy.mockReturnValue(new Promise(() => {}));

    const first = await client.callTool({
      name: 'start_analysis',
      arguments: { path: '/tmp/test-repo', headSha: 'abc123' },
    });
    const firstContent = JSON.parse(first.content[0].text);
    expect(firstContent.status).toBe('started');

    // Second call should detect the running analysis
    const second = await client.callTool({
      name: 'start_analysis',
      arguments: { path: '/tmp/test-repo', headSha: 'abc123' },
    });
    const secondContent = JSON.parse(second.content[0].text);

    expect(secondContent.status).toBe('already_running');
    expect(secondContent.analysisId).toBe(firstContent.analysisId);
    expect(secondContent.reviewId).toBe(firstContent.reviewId);
  });

  it('should return already_running for concurrent PR analysis', async () => {
    const reviewRepo = new ReviewRepository(db);
    await reviewRepo.createReview({ prNumber: 42, repository: 'owner/repo' });
    await run(db, `
      INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch)
      VALUES (42, 'owner/repo', 'Test PR', 'Description', 'author', 'main', 'feature')
    `);

    // Make analyzeLevel1 hang
    analyzeLevel1Spy.mockReturnValue(new Promise(() => {}));

    const first = await client.callTool({
      name: 'start_analysis',
      arguments: { repo: 'owner/repo', prNumber: 42 },
    });
    const firstContent = JSON.parse(first.content[0].text);
    expect(firstContent.status).toBe('started');

    // Second call should detect the running analysis
    const second = await client.callTool({
      name: 'start_analysis',
      arguments: { repo: 'owner/repo', prNumber: 42 },
    });
    const secondContent = JSON.parse(second.content[0].text);

    expect(secondContent.status).toBe('already_running');
    expect(secondContent.analysisId).toBe(firstContent.analysisId);
  });

  it('should clean up tracking state when getLocalChangedFiles throws', async () => {
    const reviewRepo = new ReviewRepository(db);
    const reviewId = await reviewRepo.upsertLocalReview({
      localPath: '/tmp/error-repo',
      localHeadSha: 'err123',
      repository: 'error-repo',
    });

    getLocalChangedFilesSpy.mockRejectedValue(new Error('git failed'));

    const result = await client.callTool({
      name: 'start_analysis',
      arguments: { path: '/tmp/error-repo', headSha: 'err123' },
    });

    // The error response should contain the error message
    const rawText = result.content[0].text;
    expect(rawText).toContain('git failed');

    // Tracking state should be cleaned up
    const reviewKey = getLocalReviewKey(reviewId);
    expect(localReviewToAnalysisId.has(reviewKey)).toBe(false);
    // activeAnalyses should also be cleaned up
    for (const [, status] of activeAnalyses) {
      if (status.reviewId === reviewId) {
        throw new Error('Stale activeAnalyses entry found');
      }
    }
  });

  it('should persist customInstructions in local mode', async () => {
    const reviewRepo = new ReviewRepository(db);
    const reviewId = await reviewRepo.upsertLocalReview({
      localPath: '/tmp/instructions-repo',
      localHeadSha: 'inst123',
      repository: 'instructions-repo',
    });

    const result = await client.callTool({
      name: 'start_analysis',
      arguments: {
        path: '/tmp/instructions-repo',
        headSha: 'inst123',
        customInstructions: 'Focus on performance',
      },
    });
    const content = JSON.parse(result.content[0].text);
    expect(content.status).toBe('started');

    // Verify custom instructions were persisted
    const review = await reviewRepo.getLocalReviewById(reviewId);
    expect(review.custom_instructions).toBe('Focus on performance');
  });

  it('should preserve skipped level status on completion', async () => {
    const reviewRepo = new ReviewRepository(db);
    await reviewRepo.upsertLocalReview({
      localPath: '/tmp/skip-repo',
      localHeadSha: 'skip123',
      repository: 'skip-repo',
    });

    // Mock analyzeLevel1 to return a result with level2Result indicating levels 1+2 completed
    analyzeLevel1Spy.mockResolvedValue({
      runId: 'mock-run-id',
      suggestions: [{ type: 'bug', title: 'Test bug', file: 'test.js', line_start: 1 }],
      summary: 'Found 1 issue',
      level2Result: {
        suggestions: [{ type: 'improvement', title: 'Improvement', file: 'test.js', line_start: 5 }],
      },
    });

    const result = await client.callTool({
      name: 'start_analysis',
      arguments: {
        path: '/tmp/skip-repo',
        headSha: 'skip123',
        skipLevel3: true,
      },
    });
    const content = JSON.parse(result.content[0].text);
    expect(content.status).toBe('started');

    // The mock resolves immediately, so wait a tick for the async completion handler to run
    await new Promise(r => setTimeout(r, 50));

    const status = activeAnalyses.get(content.analysisId);
    expect(status).toBeDefined();
    expect(status.status).toBe('completed');
    expect(status.levels[1].status).toBe('completed');
    expect(status.levels[2].status).toBe('completed');
    // Level 3 was skipped and should NOT be overwritten to 'completed'
    expect(status.levels[3].status).toBe('skipped');
    // Level 4 (orchestration) should be completed
    expect(status.levels[4].status).toBe('completed');
  });

  it('should mark uncompleted levels as failed when analysis fails immediately', async () => {
    const reviewRepo = new ReviewRepository(db);
    await reviewRepo.upsertLocalReview({
      localPath: '/tmp/fail-repo',
      localHeadSha: 'fail123',
      repository: 'fail-repo',
    });

    // Make analyzeLevel1 reject after a short delay so initial status is set up
    analyzeLevel1Spy.mockImplementation(() => new Promise((_, reject) =>
      setTimeout(() => reject(new Error('analysis failed')), 10)
    ));

    const result = await client.callTool({
      name: 'start_analysis',
      arguments: {
        path: '/tmp/fail-repo',
        headSha: 'fail123',
        skipLevel3: true,
      },
    });
    const content = JSON.parse(result.content[0].text);
    expect(content.status).toBe('started');

    // Wait for the rejection to propagate
    await new Promise(r => setTimeout(r, 50));

    const status = activeAnalyses.get(content.analysisId);
    expect(status).toBeDefined();
    expect(status.status).toBe('failed');
    expect(status.error).toBe('analysis failed');
    // Level 3 was 'skipped' and should retain that status, not be overwritten to 'failed'
    expect(status.levels[3].status).toBe('skipped');
    // Levels that were not yet completed should be marked as 'failed'
    expect(status.levels[1].status).toBe('failed');
    expect(status.levels[2].status).toBe('failed');
    expect(status.levels[4].status).toBe('failed');
  });

  it('should not mark as failed on cancellation error', async () => {
    const reviewRepo = new ReviewRepository(db);
    await reviewRepo.upsertLocalReview({
      localPath: '/tmp/cancel-repo',
      localHeadSha: 'cancel123',
      repository: 'cancel-repo',
    });

    // Create a mock cancellation error
    const cancelError = new Error('cancelled');
    cancelError.isCancellation = true;
    analyzeLevel1Spy.mockRejectedValue(cancelError);

    const result = await client.callTool({
      name: 'start_analysis',
      arguments: {
        path: '/tmp/cancel-repo',
        headSha: 'cancel123',
      },
    });
    const content = JSON.parse(result.content[0].text);
    expect(content.status).toBe('started');

    // Wait for the rejection to propagate
    await new Promise(r => setTimeout(r, 50));

    const status = activeAnalyses.get(content.analysisId);
    expect(status).toBeDefined();
    // Cancellation errors should NOT update status to 'failed'
    // handleAnalysisFailure returns early when error.isCancellation is true
    expect(status.status).toBe('running');
    // Levels should remain in their initial state, not overwritten to 'failed'
    expect(status.levels[1].status).toBe('running');
    expect(status.levels[2].status).toBe('running');
    expect(status.levels[3].status).toBe('running');
  });
});

