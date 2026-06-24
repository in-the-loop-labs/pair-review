// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Bulk analysis configuration routes.
 *
 * The index page can open many PR tabs at once. Rather than placing a large
 * analysis configuration in every PR URL, the browser stores it here and passes
 * a short ID through the setup/review URL. Each PR tab then resolves the ID
 * before starting auto-analysis.
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../utils/logger');
const { VALID_TIERS } = require('../ai/prompts/config');
const { getAllProvidersInfo } = require('../ai');
const { normalizeCouncilConfig, validateCouncilConfig } = require('./councils');

const router = express.Router();

const configs = new Map();
const CONFIG_TTL_MS = 30 * 60 * 1000;
const MAX_CONFIGS = 1000;
const MAX_INSTRUCTIONS_LENGTH = 5000;
const VALID_TIER_SET = new Set(VALID_TIERS);
const VALID_CONFIG_TYPES = new Set(['council', 'advanced']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function pruneExpired(now = Date.now()) {
  for (const [id, entry] of configs.entries()) {
    if (entry.expiresAt <= now) {
      configs.delete(id);
    }
  }
}

function enforceMaxConfigs() {
  while (configs.size > MAX_CONFIGS) {
    const oldestId = configs.keys().next().value;
    if (!oldestId) return;
    configs.delete(oldestId);
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateString(value, field, { required = false, max = 200 } = {}) {
  if (value == null) {
    return required ? `${field} is required` : null;
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    return `${field} must be a non-empty string up to ${max} characters`;
  }
  return null;
}

function validateCustomInstructions(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return 'customInstructions must be a string';
  if (value.length > MAX_INSTRUCTIONS_LENGTH) {
    return `customInstructions exceed maximum length of ${MAX_INSTRUCTIONS_LENGTH} characters`;
  }
  return null;
}

function validateJsonShape(value, path = 'analysisConfig', depth = 0) {
  if (depth > 20) return `${path} is too deeply nested`;
  if (value == null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) return `${path} has too many items`;
    for (let i = 0; i < value.length; i++) {
      const error = validateJsonShape(value[i], `${path}[${i}]`, depth + 1);
      if (error) return error;
    }
    return null;
  }
  if (!isPlainObject(value)) return `${path} must contain only JSON values`;

  const entries = Object.entries(value);
  if (entries.length > 200) return `${path} has too many keys`;
  for (const [key, child] of entries) {
    if (FORBIDDEN_KEYS.has(key)) return `${path} contains forbidden key ${key}`;
    const error = validateJsonShape(child, `${path}.${key}`, depth + 1);
    if (error) return error;
  }
  return null;
}

function sanitizeExcludePrevious(value) {
  if (value == null) return { error: null, value: undefined };
  if (!isPlainObject(value)) return { error: 'excludePrevious must be an object' };
  return {
    error: null,
    value: {
      github: value.github === true,
      feedback: value.feedback === true
    }
  };
}

function sanitizeEnabledLevels(value) {
  if (value == null) return { error: null, value: undefined };
  if (!Array.isArray(value)) return { error: 'enabledLevels must be an array' };

  const levels = [];
  for (const level of value) {
    const number = Number(level);
    if (![1, 2, 3].includes(number)) {
      return { error: 'enabledLevels may only include levels 1, 2, and 3' };
    }
    if (!levels.includes(number)) levels.push(number);
  }

  if (levels.length === 0) return { error: 'enabledLevels must include at least one level' };
  return { error: null, value: levels };
}

function sanitizeSingleConfig(config) {
  let error = validateString(config.provider, 'provider', { required: true });
  if (error) return { error };

  error = validateString(config.model, 'model', { required: true });
  if (error) return { error };

  if (config.tier != null && (!VALID_TIER_SET.has(config.tier))) {
    return { error: `tier must be one of ${VALID_TIERS.join(', ')}` };
  }

  // The modal builds two related fields: `instructions` carries the *effective*
  // prompt (selected preset chips concatenated with the textarea) while
  // `customInstructions` is the raw textarea only. Persist the effective prompt
  // so bulk-launched analyses see the same prompt the modal showed the user —
  // otherwise any chosen preset chips are silently dropped.
  const effectiveInstructions = config.instructions || config.customInstructions;

  error = validateCustomInstructions(effectiveInstructions);
  if (error) return { error };

  const enabledLevels = sanitizeEnabledLevels(config.enabledLevels);
  if (enabledLevels.error) return { error: enabledLevels.error };

  const excludePrevious = sanitizeExcludePrevious(config.excludePrevious);
  if (excludePrevious.error) return { error: excludePrevious.error };

  // Defense in depth: the bulk replay path forwards this stored pair straight to
  // analysis with no client-side guard. If the model does not belong to the
  // provider (a mismatched pair that slipped past the client resolver), fall back
  // to the provider's own default rather than forwarding an invalid pair. Unknown
  // providers (custom/unavailable, not in the registry) pass through unchanged.
  let normalizedModel = config.model;
  const providerInfo = getAllProvidersInfo().find(p => p.id === config.provider);
  if (providerInfo && !providerInfo.models.some(m => m.id === config.model)) {
    normalizedModel = providerInfo.defaultModel || config.model;
  }

  return {
    error: null,
    config: {
      provider: config.provider,
      model: normalizedModel,
      tier: config.tier,
      customInstructions: effectiveInstructions || null,
      enabledLevels: enabledLevels.value,
      skipLevel3: config.skipLevel3 === true,
      noLevels: config.noLevels === true,
      excludePrevious: excludePrevious.value
    }
  };
}

function sanitizeCouncilConfig(config) {
  // configType selects which downstream validator runs, so reject unrecognized
  // values rather than silently coercing them (which could route councilConfig
  // through the wrong validator).
  if (config.configType != null && !VALID_CONFIG_TYPES.has(config.configType)) {
    return { error: `configType must be one of ${[...VALID_CONFIG_TYPES].join(', ')}` };
  }
  const configType = config.configType || 'advanced';

  let error = validateString(config.councilId, 'councilId', { max: 128 });
  if (error) return { error };

  if (config.councilName != null) {
    error = validateString(config.councilName, 'councilName', { max: 200 });
    if (error) return { error };
  }

  error = validateCustomInstructions(config.customInstructions);
  if (error) return { error };

  const excludePrevious = sanitizeExcludePrevious(config.excludePrevious);
  if (excludePrevious.error) return { error: excludePrevious.error };

  if (!config.councilId && !config.councilConfig) {
    return { error: 'Either councilId or councilConfig is required' };
  }

  let councilConfig;
  if (config.councilConfig != null) {
    const shapeError = validateJsonShape(config.councilConfig, 'councilConfig');
    if (shapeError) return { error: shapeError };

    councilConfig = normalizeCouncilConfig(config.councilConfig, configType);
    const councilError = validateCouncilConfig(councilConfig, configType);
    if (councilError) return { error: `Invalid council config: ${councilError}` };
  }

  return {
    error: null,
    config: {
      isCouncil: true,
      configType,
      // When an inline snapshot is stored, drop councilId so the downstream
      // analysis route is forced to use the exact modal-selected councilConfig
      // rather than re-fetching (and possibly diverging from) the DB record.
      councilId: councilConfig ? undefined : (config.councilId || undefined),
      councilName: config.councilName || null,
      councilConfig,
      customInstructions: config.customInstructions || null,
      excludePrevious: excludePrevious.value
    }
  };
}

function sanitizeAnalysisConfig(config) {
  if (!isPlainObject(config)) {
    return { error: 'analysisConfig object required' };
  }

  const shapeError = validateJsonShape(config);
  if (shapeError) return { error: shapeError };

  if (config.isCouncil === true) {
    return sanitizeCouncilConfig(config);
  }
  return sanitizeSingleConfig(config);
}

/**
 * Validate + store an analysis config, returning its short id. Single source of
 * truth for the in-memory store, shared by the HTTP POST handler (index-page bulk
 * launcher) and the CLI interactive `--instructions` flow, which stashes the
 * resolved config so the browser-side auto-analyze can pick it up via the
 * `analysisConfigId` URL param (same in-process Map the GET handler reads).
 *
 * @param {Object} analysisConfig - Raw analysis config (single or council shape)
 * @returns {{ id: string, expiresInMs: number }}
 * @throws {Error} with `.statusCode = 400` when the config fails validation
 */
function createBulkAnalysisConfig(analysisConfig) {
  const result = sanitizeAnalysisConfig(analysisConfig);
  if (result.error) {
    const err = new Error(result.error);
    err.statusCode = 400;
    throw err;
  }

  pruneExpired();

  const id = crypto.randomUUID();
  configs.set(id, {
    analysisConfig: result.config,
    expiresAt: Date.now() + CONFIG_TTL_MS
  });
  enforceMaxConfigs();

  return { id, expiresInMs: CONFIG_TTL_MS };
}

router.post('/api/bulk-analysis-configs', (req, res) => {
  try {
    const { id, expiresInMs } = createBulkAnalysisConfig(req.body?.analysisConfig);
    res.json({ success: true, id, expiresInMs });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('Failed to store bulk analysis config:', error);
    res.status(500).json({ error: 'Failed to store bulk analysis config' });
  }
});

router.get('/api/bulk-analysis-configs/:id', (req, res) => {
  const { id } = req.params;
  pruneExpired();

  const entry = configs.get(id);
  if (!entry) {
    return res.status(404).json({ error: 'Bulk analysis config not found' });
  }

  res.json({
    success: true,
    analysisConfig: entry.analysisConfig
  });
});

function _resetBulkAnalysisConfigs() {
  configs.clear();
}

function _getBulkAnalysisConfig(id) {
  const entry = configs.get(id);
  return entry ? entry.analysisConfig : null;
}

module.exports = router;
module.exports.createBulkAnalysisConfig = createBulkAnalysisConfig;
module.exports._resetBulkAnalysisConfigs = _resetBulkAnalysisConfigs;
module.exports._getBulkAnalysisConfig = _getBulkAnalysisConfig;
module.exports._pruneExpired = pruneExpired;
module.exports._CONFIG_TTL_MS = CONFIG_TTL_MS;
module.exports._MAX_CONFIGS = MAX_CONFIGS;
module.exports._sanitizeAnalysisConfig = sanitizeAnalysisConfig;
