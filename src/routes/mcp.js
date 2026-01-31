// SPDX-License-Identifier: GPL-3.0-or-later
const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { ReviewRepository, CommentRepository, query } = require('../database');

const router = express.Router();

/**
 * Resolve a review from the database using either local (path + headSha) or PR (repo + prNumber) params.
 *
 * @param {Object} args - Tool arguments
 * @param {Object} db - Database instance
 * @returns {Promise<{review: Object|null, error: string|null}>}
 */
async function resolveReview(args, db) {
  const reviewRepo = new ReviewRepository(db);

  if (args.path && args.headSha) {
    const review = await reviewRepo.getLocalReview(args.path, args.headSha);
    if (!review) {
      return { review: null, error: `No local review found for path "${args.path}" with HEAD SHA "${args.headSha}"` };
    }
    return { review, error: null };
  }

  if (args.repo && args.prNumber) {
    const review = await reviewRepo.getReviewByPR(args.prNumber, args.repo);
    if (!review) {
      return { review: null, error: `No review found for PR #${args.prNumber} in ${args.repo}` };
    }
    return { review, error: null };
  }

  return {
    review: null,
    error: 'You must provide either (path + headSha) for local reviews or (repo + prNumber) for GitHub PR reviews'
  };
}

// Shared input schema for review lookup
const reviewLookupSchema = {
  path: z.string().optional().describe('Local path (for local reviews)'),
  headSha: z.string().optional().describe('HEAD SHA (for local reviews)'),
  repo: z.string().optional().describe('"owner/repo" (for PR reviews)'),
  prNumber: z.number().optional().describe('PR number (for PR reviews)'),
};

/**
 * Create and configure an MCP server with tools bound to the given database.
 *
 * @param {Object} db - Database instance
 * @param {Object} [options] - Optional configuration
 * @param {number} [options.port] - When provided, enables the get_server_info tool with this port
 * @returns {McpServer}
 */
function createMCPServer(db, options = {}) {
  const packageJson = require('../../package.json');

  const server = new McpServer({
    name: 'pair-review',
    version: packageJson.version,
  }, {
    capabilities: { tools: {} }
  });

  // --- Tool: get_server_info (when port is provided) ---
  if (options.port) {
    server.tool(
      'get_server_info',
      'Get pair-review server info including the web UI URL. ' +
      'Use this to find the URL that the human reviewer can open in their browser.',
      {},
      async () => {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              url: `http://localhost:${options.port}`,
              port: options.port,
              version: packageJson.version,
            }, null, 2)
          }]
        };
      }
    );
  }

  // --- Tool: get_review_comments ---
  server.tool(
    'get_review_comments',
    'Get user-authored review comments for a pair-review code review. ' +
    'Returns comments grouped by file. Provide (path + headSha) for local reviews or (repo + prNumber) for PR reviews.',
    {
      ...reviewLookupSchema,
      file: z.string().optional().describe('Filter results to a single file path'),
    },
    async (args) => {
      const { review, error } = await resolveReview(args, db);
      if (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error }) }] };
      }

      const commentRepo = new CommentRepository(db);
      let comments = await commentRepo.getUserComments(review.id, { includeDismissed: false });

      if (args.file) {
        comments = comments.filter(c => c.file === args.file);
      }

      // Group by file for readability
      const grouped = {};
      for (const c of comments) {
        const file = c.file || '(file-level)';
        if (!grouped[file]) grouped[file] = [];
        grouped[file].push({
          file: c.file,
          line_start: c.line_start,
          line_end: c.line_end,
          side: c.side,
          body: c.body,
          type: c.type,
          title: c.title,
          status: c.status,
          created_at: c.created_at,
        });
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ review_id: review.id, comments: grouped }, null, 2)
        }]
      };
    }
  );

  // --- Tool: get_ai_suggestions ---
  server.tool(
    'get_ai_suggestions',
    'Get AI-generated review suggestions for a pair-review code review. ' +
    'Returns suggestions from the latest analysis run, optionally filtered by status. ' +
    'Provide (path + headSha) for local reviews or (repo + prNumber) for PR reviews.',
    {
      ...reviewLookupSchema,
      file: z.string().optional().describe('Filter results to a single file path'),
      status: z.enum(['active', 'adopted', 'dismissed']).optional()
        .describe('Filter by suggestion status. Defaults to active and adopted (dismissed excluded).'),
    },
    async (args) => {
      const { review, error } = await resolveReview(args, db);
      if (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error }) }] };
      }

      // Build parameterized WHERE conditions
      const params = [review.id];
      const conditions = ["review_id = ?", "source = 'ai'", 'ai_level IS NULL'];

      if (args.status) {
        conditions.push('status = ?');
        params.push(args.status);
      } else {
        // Exclude dismissed by default — dismissed suggestions were explicitly
        // rejected by the reviewer and would be noise for an iterating agent.
        conditions.push("status IN ('active', 'adopted')");
      }

      // Latest run subquery (needs review_id param)
      conditions.push(`ai_run_id = (
            SELECT ai_run_id FROM comments
            WHERE review_id = ? AND source = 'ai' AND ai_run_id IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 1
          )`);
      params.push(review.id);

      const suggestions = await query(db, `
        SELECT
          id, ai_run_id, ai_level, ai_confidence,
          file, line_start, line_end, type, title, body,
          status, is_file_level, created_at
        FROM comments
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY file, line_start
      `, params);

      let filtered = suggestions;
      if (args.file) {
        filtered = suggestions.filter(s => s.file === args.file);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            review_id: review.id,
            count: filtered.length,
            suggestions: filtered.map(s => ({
              file: s.file,
              line_start: s.line_start,
              line_end: s.line_end,
              title: s.title,
              body: s.body,
              type: s.type,
              ai_confidence: s.ai_confidence,
              status: s.status,
            }))
          }, null, 2)
        }]
      };
    }
  );

  return server;
}

// Stateless mode: both McpServer and transport are created per request.
// McpServer.connect() permanently binds the server to one transport,
// and there is no public disconnect API, so reuse is not possible.
// req.body is passed as pre-parsed body since Express json middleware already consumed the stream.
router.post('/mcp', async (req, res) => {
  try {
    const db = req.app.get('db');
    const server = createMCPServer(db);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error('MCP request error:', error);
    if (!res.headersSent) {
      const requestId = (req.body && req.body.id !== undefined) ? req.body.id : null;
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: requestId });
    }
  }
});

// GET /mcp — not supported in stateless mode
router.get('/mcp', (req, res) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Server-sent events not supported in stateless mode' }, id: null });
});

// DELETE /mcp — not supported in stateless mode
router.delete('/mcp', (req, res) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Session termination not supported in stateless mode' }, id: null });
});

module.exports = router;
module.exports.createMCPServer = createMCPServer;
module.exports.resolveReview = resolveReview;
