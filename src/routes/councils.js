// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Council Routes
 *
 * CRUD endpoints for managing Review Council configurations.
 * Councils define multi-voice, multi-provider analysis configurations
 * that run in parallel and consolidate results.
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { CouncilRepository } = require('../database');
const { normalizeAndValidateCouncilConfig } = require('../councils/council-validation');
const { createCouncilStore, isFileCouncilId } = require('../councils/council-store');

const router = express.Router();

/**
 * Refuse a write against a file-backed council.
 *
 * File councils are owned by their file on disk — the API must never write
 * them, so the mutating routes bail out here before touching the repository.
 *
 * @param {Object} res - Express response
 * @param {string} id - Council id from the request
 * @param {string} action - Past-tense verb for the message ('updated', 'deleted')
 * @returns {boolean} true when the request was refused (caller must return)
 */
function refuseFileCouncil(res, id, action) {
  if (!isFileCouncilId(id)) return false;
  res.status(403).json({
    error: `This council is defined in a file and cannot be ${action} through the API. ` +
      'Change the file on disk instead.'
  });
  return true;
}

/**
 * GET /api/councils — List all saved councils
 */
router.get('/api/councils', async (req, res) => {
  try {
    const db = req.app.get('db');
    const store = await createCouncilStore(db);
    const councils = await store.list();

    res.json({ councils });
  } catch (error) {
    logger.error('Error listing councils:', error);
    res.status(500).json({ error: 'Failed to list councils' });
  }
});

/**
 * GET /api/councils/:id — Get a specific council
 */
router.get('/api/councils/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = req.app.get('db');
    const store = await createCouncilStore(db);
    const council = await store.getById(id);

    if (!council) {
      return res.status(404).json({ error: 'Council not found' });
    }

    res.json({ council });
  } catch (error) {
    logger.error('Error fetching council:', error);
    res.status(500).json({ error: 'Failed to fetch council' });
  }
});

/**
 * POST /api/councils — Create a new council
 */
router.post('/api/councils', async (req, res) => {
  try {
    const { name, config, type } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    if (!config) {
      return res.status(400).json({ error: 'config is required' });
    }

    const effectiveType = type || 'advanced';
    // Validate what the RUNTIME will actually run: every read path normalizes
    // before validating, so saving must too or save is stricter than run and
    // rejects councils the analyzer would happily execute. Note we validate the
    // normalized config but STORE exactly what the client sent.
    const { error: validationError } = normalizeAndValidateCouncilConfig(config, effectiveType);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const db = req.app.get('db');
    const councilRepo = new CouncilRepository(db);
    const id = uuidv4();
    const council = await councilRepo.create({ id, name: name.trim(), config, type: effectiveType });

    res.status(201).json({ council });
  } catch (error) {
    logger.error('Error creating council:', error);
    res.status(500).json({ error: 'Failed to create council' });
  }
});

/**
 * PUT /api/councils/:id — Update a council
 */
router.put('/api/councils/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (refuseFileCouncil(res, id, 'updated')) return;
    const { name, config, type } = req.body || {};

    const db = req.app.get('db');
    const councilRepo = new CouncilRepository(db);

    // Verify council exists
    const existing = await councilRepo.getById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Council not found' });
    }

    // Validate config if provided. As on create, validate the NORMALIZED config
    // (what the runtime will actually run) while storing what the client sent.
    if (config) {
      // A PUT might update config without changing type, so use the effective type:
      // prefer the explicitly provided type, fall back to the existing record's type
      const effectiveType = type !== undefined ? type : existing.type;
      const { error: validationError } = normalizeAndValidateCouncilConfig(config, effectiveType);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }
    } else if (type !== undefined && type !== existing.type) {
      // Type is changing without a new config — validate existing config against the new type
      const { error: validationError } = normalizeAndValidateCouncilConfig(existing.config, type);
      if (validationError) {
        return res.status(400).json({ error: `Existing config is incompatible with type '${type}': ${validationError}` });
      }
    }

    const updates = {};
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        return res.status(400).json({ error: 'name cannot be empty' });
      }
      updates.name = trimmed;
    }
    if (config !== undefined) updates.config = config;
    if (type !== undefined) updates.type = type;

    await councilRepo.update(id, updates);
    const updated = await councilRepo.getById(id);

    res.json({ council: updated });
  } catch (error) {
    logger.error('Error updating council:', error);
    res.status(500).json({ error: 'Failed to update council' });
  }
});

/**
 * DELETE /api/councils/:id — Delete a council
 */
router.delete('/api/councils/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (refuseFileCouncil(res, id, 'deleted')) return;
    const db = req.app.get('db');
    const councilRepo = new CouncilRepository(db);

    const existed = await councilRepo.delete(id);
    if (!existed) {
      return res.status(404).json({ error: 'Council not found' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting council:', error);
    res.status(500).json({ error: 'Failed to delete council' });
  }
});

module.exports = router;
