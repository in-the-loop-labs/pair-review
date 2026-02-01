// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const { ReviewRepository, CommentRepository, AnalysisRunRepository, run } = require('../../src/database.js');
const { resolveReview, createMCPServer } = require('../../src/routes/mcp');

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
    expect(tools).toHaveLength(4);
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

  it('should register 5 tools when port option is provided', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('get_server_info');
    expect(names).toContain('get_analysis_prompt');
    expect(names).toContain('get_user_comments');
    expect(names).toContain('get_ai_analysis_runs');
    expect(names).toContain('get_ai_suggestions');
    expect(tools).toHaveLength(5);
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
    expect(tools).toHaveLength(4);

    await clientNoPort.close();
    await serverNoPort.close();
  });
});
