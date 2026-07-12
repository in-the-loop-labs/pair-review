// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Chat Snippet Routes
 *
 * CRUD endpoints for the reusable chat prompt snippets library. Snippets are
 * global (user-level) body-only prompts inserted into the chat input, ordered
 * most-recently-used first.
 */

const express = require('express');
const logger = require('../utils/logger');
const { ChatSnippetRepository } = require('../database');

const router = express.Router();

const MAX_BODY_LENGTH = 10000;

/**
 * Validate a snippet body value.
 * @param {*} body - Candidate body
 * @returns {string|null} Error message or null if valid
 */
function validateBody(body) {
  if (typeof body !== 'string' || !body.trim()) {
    return 'body is required and must be a non-empty string';
  }
  if (body.length > MAX_BODY_LENGTH) {
    return `body must be ${MAX_BODY_LENGTH} characters or fewer`;
  }
  return null;
}

/**
 * Parse a route :id param into an integer, or null if not a valid number.
 * @param {string} raw - Raw param value
 * @returns {number|null}
 */
function parseId(raw) {
  const id = Number.parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}

/**
 * GET /api/snippets — List all snippets in MRU order
 */
router.get('/api/snippets', async (req, res) => {
  try {
    const repo = new ChatSnippetRepository(req.app.get('db'));
    const snippets = await repo.list();
    res.json({ snippets });
  } catch (error) {
    logger.error('Error listing snippets:', error);
    res.status(500).json({ error: 'Failed to list snippets' });
  }
});

/**
 * POST /api/snippets — Create a new snippet
 */
router.post('/api/snippets', async (req, res) => {
  try {
    const { body } = req.body || {};

    const validationError = validateBody(body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const repo = new ChatSnippetRepository(req.app.get('db'));
    const snippet = await repo.create({ body });
    res.status(201).json({ snippet });
  } catch (error) {
    logger.error('Error creating snippet:', error);
    res.status(500).json({ error: 'Failed to create snippet' });
  }
});

/**
 * PUT /api/snippets/:id — Update a snippet's body
 */
router.put('/api/snippets/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(400).json({ error: 'Invalid snippet id' });
    }

    const { body } = req.body || {};
    const validationError = validateBody(body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const repo = new ChatSnippetRepository(req.app.get('db'));
    const updated = await repo.update(id, { body });
    if (!updated) {
      return res.status(404).json({ error: 'Snippet not found' });
    }

    const snippet = await repo.getById(id);
    res.json({ snippet });
  } catch (error) {
    logger.error('Error updating snippet:', error);
    res.status(500).json({ error: 'Failed to update snippet' });
  }
});

/**
 * DELETE /api/snippets/:id — Delete a snippet
 */
router.delete('/api/snippets/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(400).json({ error: 'Invalid snippet id' });
    }

    const repo = new ChatSnippetRepository(req.app.get('db'));
    const existed = await repo.delete(id);
    if (!existed) {
      return res.status(404).json({ error: 'Snippet not found' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting snippet:', error);
    res.status(500).json({ error: 'Failed to delete snippet' });
  }
});

/**
 * POST /api/snippets/:id/touch — Bump last_used_at for MRU tracking
 */
router.post('/api/snippets/:id/touch', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(400).json({ error: 'Invalid snippet id' });
    }

    const repo = new ChatSnippetRepository(req.app.get('db'));
    const touched = await repo.touchLastUsedAt(id);
    if (!touched) {
      return res.status(404).json({ error: 'Snippet not found' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error touching snippet:', error);
    res.status(500).json({ error: 'Failed to touch snippet' });
  }
});

module.exports = router;
