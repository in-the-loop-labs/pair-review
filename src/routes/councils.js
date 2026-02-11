// SPDX-License-Identifier: GPL-3.0-or-later
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

const router = express.Router();

/**
 * Normalize a council config to match the expected shape for its type.
 *
 * When type is 'council' (voice-centric) but the config is in the levels-based
 * (advanced) format — e.g. from a previously saved council or a migration — this
 * extracts the voices and converts the levels to booleans so it passes validation.
 *
 * When type is anything else, or the config already matches, returns the config
 * as-is.
 *
 * @param {Object} config - Council configuration
 * @param {string} [type] - The council type ('council' or 'advanced')
 * @returns {Object} Normalized config (may be the original object if no changes needed)
 */
function normalizeCouncilConfig(config, type) {
  if (!config || typeof config !== 'object' || type !== 'council') {
    return config;
  }

  // If it already has a voices array, it's already in voice-centric format
  if (Array.isArray(config.voices) && config.voices.length > 0) {
    return config;
  }

  // Check if levels are in the advanced format (objects with enabled/voices)
  if (!config.levels || typeof config.levels !== 'object') {
    return config;
  }

  const hasAdvancedLevels = Object.values(config.levels).some(
    val => typeof val === 'object' && val !== null && 'enabled' in val
  );

  if (!hasAdvancedLevels) {
    return config;
  }

  // Convert from advanced (levels-based) to voice-centric format
  const normalizedVoices = [];
  const seenVoices = new Set();
  const normalizedLevels = {};

  for (const [key, levelConfig] of Object.entries(config.levels)) {
    if (typeof levelConfig === 'object' && levelConfig !== null) {
      normalizedLevels[key] = levelConfig.enabled !== false;
      if (levelConfig.enabled !== false && Array.isArray(levelConfig.voices)) {
        for (const v of levelConfig.voices) {
          const voiceSig = JSON.stringify(v, Object.keys(v).sort());
          if (!seenVoices.has(voiceSig)) {
            seenVoices.add(voiceSig);
            normalizedVoices.push(v);
          }
        }
      }
    } else {
      // Already boolean — keep as-is
      normalizedLevels[key] = levelConfig !== false;
    }
  }

  // Destructure out orchestration so it does not leak into the normalized output
  const { orchestration, ...rest } = config;
  return {
    ...rest,
    voices: normalizedVoices,
    levels: normalizedLevels,
    consolidation: config.consolidation || orchestration || undefined
  };
}

/**
 * Validate a council config object
 * @param {Object} config - Council configuration
 * @param {string} [type] - The council type ('council' or 'advanced'), provided as a sibling field from req.body
 * @returns {string|null} Error message or null if valid
 */
function validateCouncilConfig(config, type) {
  if (!config || typeof config !== 'object') {
    return 'config must be an object';
  }

  // Dispatch based on explicit type parameter (from req.body.type, not config.type)
  if (type === 'council') {
    return validateCouncilFormat(config);
  }

  // Legacy configs (no type) and type === 'advanced' use level-centric format
  return validateAdvancedFormat(config);
}

/**
 * Validate the voice-centric council format (type: 'council')
 * @param {Object} config
 * @returns {string|null} Error message or null if valid
 */
function validateCouncilFormat(config) {
  // Validate voices array
  if (!Array.isArray(config.voices) || config.voices.length === 0) {
    return 'config.voices must be a non-empty array';
  }

  for (const [i, voice] of config.voices.entries()) {
    if (!voice.provider) {
      return `voices[${i}].provider is required`;
    }
    if (!voice.model) {
      return `voices[${i}].model is required`;
    }
  }

  // Validate levels
  if (!config.levels || typeof config.levels !== 'object') {
    return 'config.levels is required and must be an object';
  }

  const validLevels = ['1', '2', '3'];
  const hasEnabled = Object.entries(config.levels).some(([key, val]) =>
    validLevels.includes(key) && val === true
  );
  if (!hasEnabled) {
    return 'At least one level (1, 2, or 3) must be enabled';
  }

  // Validate consolidation (optional)
  if (config.consolidation) {
    if (!config.consolidation.provider || !config.consolidation.model) {
      return 'consolidation.provider and consolidation.model are required when consolidation is specified';
    }
  }

  return null;
}

/**
 * Validate the level-centric advanced format (type: 'advanced' or legacy no-type)
 * @param {Object} config
 * @returns {string|null} Error message or null if valid
 */
function validateAdvancedFormat(config) {
  // Validate levels
  if (!config.levels || typeof config.levels !== 'object') {
    return 'config.levels is required and must be an object';
  }

  const validLevels = ['1', '2', '3'];
  for (const [levelKey, level] of Object.entries(config.levels)) {
    if (!validLevels.includes(levelKey)) {
      return `Invalid level key: "${levelKey}". Valid keys: ${validLevels.join(', ')}`;
    }

    if (typeof level.enabled !== 'boolean') {
      return `levels.${levelKey}.enabled must be a boolean`;
    }

    if (level.enabled) {
      if (!Array.isArray(level.voices) || level.voices.length === 0) {
        return `levels.${levelKey}.voices must be a non-empty array when enabled`;
      }

      for (const [i, voice] of level.voices.entries()) {
        if (!voice.provider) {
          return `levels.${levelKey}.voices[${i}].provider is required`;
        }
        if (!voice.model) {
          return `levels.${levelKey}.voices[${i}].model is required`;
        }
      }
    }
  }

  // Ensure at least one level is enabled with voices
  const hasEnabledLevel = Object.values(config.levels).some(l => l.enabled);
  if (!hasEnabledLevel) {
    return 'At least one level must be enabled';
  }

  // Validate orchestration (optional — defaults will be applied at runtime)
  if (config.orchestration) {
    if (!config.orchestration.provider || !config.orchestration.model) {
      return 'orchestration.provider and orchestration.model are required when orchestration is specified';
    }
  }

  return null;
}

/**
 * GET /api/councils — List all saved councils
 */
router.get('/api/councils', async (req, res) => {
  try {
    const db = req.app.get('db');
    const councilRepo = new CouncilRepository(db);
    const councils = await councilRepo.list();

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
    const councilRepo = new CouncilRepository(db);
    const council = await councilRepo.getById(id);

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
    const validationError = validateCouncilConfig(config, effectiveType);
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
    const { name, config, type } = req.body || {};

    const db = req.app.get('db');
    const councilRepo = new CouncilRepository(db);

    // Verify council exists
    const existing = await councilRepo.getById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Council not found' });
    }

    // Validate config if provided
    if (config) {
      // A PUT might update config without changing type, so use the effective type:
      // prefer the explicitly provided type, fall back to the existing record's type
      const effectiveType = type !== undefined ? type : existing.type;
      const validationError = validateCouncilConfig(config, effectiveType);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }
    } else if (type !== undefined && type !== existing.type) {
      // Type is changing without a new config — validate existing config against the new type
      const validationError = validateCouncilConfig(existing.config, type);
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
module.exports.validateCouncilConfig = validateCouncilConfig;
module.exports.normalizeCouncilConfig = normalizeCouncilConfig;
