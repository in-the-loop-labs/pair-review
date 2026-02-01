// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const { run, ReviewRepository, CommentRepository, AnalysisRunRepository } = require('../../src/database.js');

// We need a fresh MCP server per test to avoid state leakage
// Import only the route creator, not the cached singleton
const mcpRouteModule = require('../../src/routes/mcp');

/**
 * Create a minimal test Express app with just the MCP routes.
 */
function createTestApp(db) {
  const app = express();
  app.use(express.json());
  app.set('db', db);

  // Mount MCP routes
  app.use('/', mcpRouteModule);

  return app;
}

/**
 * Send a JSON-RPC request to the MCP endpoint.
 */
function mcpRequest(app, body) {
  return request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .send(body);
}

/**
 * Parse an SSE response body into JSON-RPC result objects.
 * The MCP SDK returns Server-Sent Events even in stateless mode.
 */
function parseSSEResponse(text) {
  const results = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        results.push(JSON.parse(line.slice(6)));
      } catch (e) {
        // Skip non-JSON data lines
      }
    }
  }
  return results;
}

/**
 * Extract the first JSON-RPC result from an SSE or JSON response.
 */
function extractResult(res) {
  const contentType = res.headers['content-type'] || '';
  if (contentType.includes('text/event-stream')) {
    const events = parseSSEResponse(res.text);
    return events.find(e => e.id !== undefined) || events[0];
  }
  return res.body;
}

describe('MCP Routes Integration', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = createTestDatabase();
    app = createTestApp(db);

    // Seed test data
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.createReview({ prNumber: 1, repository: 'test-owner/test-repo' });

    // User comment
    const commentRepo = new CommentRepository(db);
    await commentRepo.createLineComment({
      review_id: review.id,
      file: 'src/index.js',
      line_start: 10,
      line_end: 12,
      body: 'This logic is fragile',
      type: 'issue',
      title: 'Fragile logic',
    });

    // Analysis run
    const analysisRunRepo = new AnalysisRunRepository(db);
    await analysisRunRepo.create({
      id: 'test-run-1',
      reviewId: review.id,
      provider: 'claude',
      model: 'sonnet',
    });
    await analysisRunRepo.update('test-run-1', {
      status: 'completed',
      summary: 'Found 1 issue',
      totalSuggestions: 1,
      filesAnalyzed: 1,
    });

    // AI suggestion (final level)
    await run(db, `
      INSERT INTO comments (review_id, source, author, file, line_start, line_end, side, type, title, body, status, ai_run_id, ai_level, ai_confidence)
      VALUES (?, 'ai', 'AI', 'src/index.js', 15, 17, 'RIGHT', 'bug', 'Possible NPE', 'Dereferencing potentially null value', 'active', 'test-run-1', NULL, 0.92)
    `, [review.id]);
  });

  afterEach(async () => {
    if (db) closeTestDatabase(db);
  });

  describe('POST /mcp - initialize', () => {
    it('should handle MCP initialize handshake', async () => {
      const res = await mcpRequest(app, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0' }
        }
      });

      expect(res.status).toBe(200);
      const result = extractResult(res);
      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe(1);
      expect(result.result).toBeDefined();
      expect(result.result.serverInfo.name).toBe('pair-review');
      expect(result.result.protocolVersion).toBeDefined();
    });
  });

  describe('POST /mcp - tools/list', () => {
    it('should return all registered tools', async () => {
      const res = await mcpRequest(app, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      });

      expect(res.status).toBe(200);
      const result = extractResult(res);
      expect(result.result).toBeDefined();
      const toolNames = result.result.tools.map(t => t.name);
      expect(toolNames).toContain('get_analysis_prompt');
      expect(toolNames).toContain('get_user_comments');
      expect(toolNames).toContain('get_ai_analysis_runs');
      expect(toolNames).toContain('get_ai_suggestions');
      expect(result.result.tools).toHaveLength(4);
    });
  });

  describe('POST /mcp - tools/call', () => {
    it('should call get_user_comments and return user comments', async () => {
      const res = await mcpRequest(app, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'get_user_comments',
          arguments: { repo: 'test-owner/test-repo', prNumber: 1 }
        }
      });

      expect(res.status).toBe(200);
      const result = extractResult(res);
      expect(result.result).toBeDefined();
      const content = JSON.parse(result.result.content[0].text);
      expect(content.review_id).toBe(1);
      expect(content.comments['src/index.js']).toHaveLength(1);
      expect(content.comments['src/index.js'][0].body).toBe('This logic is fragile');
    });

    it('should call get_ai_analysis_runs and return runs', async () => {
      const res = await mcpRequest(app, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'get_ai_analysis_runs',
          arguments: { repo: 'test-owner/test-repo', prNumber: 1 }
        }
      });

      expect(res.status).toBe(200);
      const result = extractResult(res);
      expect(result.result).toBeDefined();
      const content = JSON.parse(result.result.content[0].text);
      expect(content.review_id).toBe(1);
      expect(content.count).toBe(1);
      expect(content.runs[0].id).toBe('test-run-1');
      expect(content.runs[0].provider).toBe('claude');
      expect(content.runs[0].status).toBe('completed');
      expect(content.runs[0].total_suggestions).toBe(1);
    });

    it('should call get_ai_suggestions and return suggestions', async () => {
      const res = await mcpRequest(app, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_ai_suggestions',
          arguments: { repo: 'test-owner/test-repo', prNumber: 1 }
        }
      });

      expect(res.status).toBe(200);
      const result = extractResult(res);
      expect(result.result).toBeDefined();
      const content = JSON.parse(result.result.content[0].text);
      expect(content.review_id).toBe(1);
      expect(content.run_id).toBe('test-run-1');
      expect(content.summary).toBe('Found 1 issue');
      expect(content.count).toBe(1);
      expect(content.suggestions[0].title).toBe('Possible NPE');
      expect(content.suggestions[0].ai_confidence).toBe(0.92);
    });

    it('should call get_ai_suggestions with runId filter', async () => {
      const res = await mcpRequest(app, {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'get_ai_suggestions',
          arguments: { repo: 'test-owner/test-repo', prNumber: 1, runId: 'test-run-1' }
        }
      });

      expect(res.status).toBe(200);
      const result = extractResult(res);
      const content = JSON.parse(result.result.content[0].text);
      expect(content.run_id).toBe('test-run-1');
      expect(content.summary).toBe('Found 1 issue');
      expect(content.count).toBe(1);
      expect(content.suggestions[0].title).toBe('Possible NPE');
    });

    it('should return empty suggestions for nonexistent runId', async () => {
      const res = await mcpRequest(app, {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'get_ai_suggestions',
          arguments: { repo: 'test-owner/test-repo', prNumber: 1, runId: 'nonexistent-run' }
        }
      });

      expect(res.status).toBe(200);
      const result = extractResult(res);
      const content = JSON.parse(result.result.content[0].text);
      expect(content.count).toBe(0);
      expect(content.suggestions).toEqual([]);
    });

    it('should return error for missing review', async () => {
      const res = await mcpRequest(app, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'get_user_comments',
          arguments: { repo: 'nonexistent/repo', prNumber: 999 }
        }
      });

      expect(res.status).toBe(200);
      const result = extractResult(res);
      expect(result.result).toBeDefined();
      const content = JSON.parse(result.result.content[0].text);
      expect(content.error).toContain('No review found');
    });

    it('should return error when no lookup params provided', async () => {
      const res = await mcpRequest(app, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'get_user_comments',
          arguments: {}
        }
      });

      expect(res.status).toBe(200);
      const result = extractResult(res);
      expect(result.result).toBeDefined();
      const content = JSON.parse(result.result.content[0].text);
      expect(content.error).toContain('You must provide either');
    });

    it('should filter comments by file', async () => {
      const res = await mcpRequest(app, {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'get_user_comments',
          arguments: { repo: 'test-owner/test-repo', prNumber: 1, file: 'nonexistent.js' }
        }
      });

      expect(res.status).toBe(200);
      const result = extractResult(res);
      const content = JSON.parse(result.result.content[0].text);
      expect(content.comments).toEqual({});
    });
  });

  describe('GET /mcp', () => {
    it('should return 405', async () => {
      const res = await request(app).get('/mcp');
      expect(res.status).toBe(405);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('DELETE /mcp', () => {
    it('should return 405', async () => {
      const res = await request(app).delete('/mcp');
      expect(res.status).toBe(405);
      expect(res.body.error).toBeDefined();
    });
  });
});
