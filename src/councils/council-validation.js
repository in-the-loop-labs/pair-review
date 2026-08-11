// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Council config normalization and validation.
 *
 * These functions used to live in `src/routes/councils.js`; they moved here so
 * non-route consumers (council files on disk, the CLI) can require them without
 * pulling in Express. Every consumer — the councils route included — now
 * requires them from here, so no back-compat re-export remains on the route
 * module.
 *
 * PROVIDER-REGISTRY INVARIANT: the voice-centric validator asks the provider
 * registry whether every voice is an executable provider (executable councils
 * are allowed to have all levels disabled). `src/ai/provider.js` owns the
 * registry but registers nothing itself — the concrete providers self-register
 * at the bottom of their own files, which only `src/ai/index.js` pulls in.
 * This module deliberately does NOT require `../ai` (that would drag
 * `../routes/shared` and Express back in, defeating the move), so a caller
 * relying on the DEFAULT registry must have loaded `src/ai` first — the CLI
 * does, via `src/main.js`. A caller that cannot guarantee that (or a test)
 * should inject its own lookup through the `_deps` parameter:
 * `validateCouncilConfig(config, type, { getProviderClass })`. With an empty
 * registry the lookup returns undefined, `allExecutable` collapses to false,
 * and an all-executable council with every level disabled is wrongly rejected.
 */

const { getProviderClass } = require('../ai/provider');

/**
 * Injectable dependencies (see `src/protocol-handler.js` for the pattern).
 * Callers may override any subset via the trailing `_deps` parameter.
 */
const defaults = {
  getProviderClass
};

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
          // NOT "stringify with sorted keys" — the second argument to
          // JSON.stringify is a REPLACER ARRAY, i.e. a property allowlist whose
          // ORDER drives the output order. Passing the voice's own keys sorted
          // therefore emits `{"model":...,"provider":...,"tier":...}` regardless
          // of the order the keys were authored in, which is precisely what
          // makes this de-dup signature key-order independent.
          //
          // CAVEAT — assumes voices are FLAT (scalar fields only). Per spec the
          // allowlist applies at every nesting depth, so a nested object field
          // whose own keys are not in the allowlist serializes as `{}`. Two
          // voices differing ONLY inside such a nested field would produce the
          // same signature and the second would be silently dropped as a
          // duplicate. Unreachable today (voices are `{ provider, model, tier,
          // ... }` scalars). If a nested voice field is ever added, replace this
          // with a signature that recurses — e.g. a stable-sort-then-stringify
          // helper, or `JSON.stringify(v, (k, val) => ...)` with a replacer
          // FUNCTION that sorts plain-object keys at every level.
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
 * Normalize a council config and validate the NORMALIZED result — the exact
 * two-step sequence every consumer performs. Returns the normalized config plus
 * an error string (null when valid) so each caller can wrap failure in the
 * shape it needs.
 *
 * @param {Object} config - Council configuration
 * @param {string} [type] - The council type ('council' or 'advanced')
 * @param {Object} [_deps] - Dependency overrides (see `defaults`)
 * @returns {{ config: Object, error: string|null }}
 */
function normalizeAndValidateCouncilConfig(config, type, _deps) {
  const normalized = normalizeCouncilConfig(config, type);
  return { config: normalized, error: validateCouncilConfig(normalized, type, _deps) };
}

/**
 * Validate a council config object
 * @param {Object} config - Council configuration
 * @param {string} [type] - The council type ('council' or 'advanced'), provided as a sibling field from req.body
 * @param {Object} [_deps] - Dependency overrides (see `defaults`); `getProviderClass`
 *   is only consulted for type 'council'. See the PROVIDER-REGISTRY INVARIANT above.
 * @returns {string|null} Error message or null if valid
 */
function validateCouncilConfig(config, type, _deps) {
  if (!config || typeof config !== 'object') {
    return 'config must be an object';
  }

  // Dispatch based on explicit type parameter (from req.body.type, not config.type)
  if (type === 'council') {
    return validateCouncilFormat(config, _deps);
  }

  // Legacy configs (no type) and type === 'advanced' use level-centric format
  return validateAdvancedFormat(config);
}

/**
 * Validate the voice-centric council format (type: 'council')
 * @param {Object} config
 * @param {Object} [_deps] - Dependency overrides (see `defaults`)
 * @returns {string|null} Error message or null if valid
 */
function validateCouncilFormat(config, _deps) {
  const deps = { ...defaults, ..._deps };
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

  // Skip level requirement when all voices are executable providers
  const allExecutable = config.voices.every(v => {
    const ProviderClass = deps.getProviderClass(v.provider);
    return ProviderClass?.isExecutable;
  });

  if (!allExecutable) {
    const validLevels = ['1', '2', '3'];
    const hasEnabled = Object.entries(config.levels).some(([key, val]) =>
      validLevels.includes(key) && val === true
    );
    if (!hasEnabled) {
      return 'At least one level (1, 2, or 3) must be enabled for non-executable providers';
    }
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

module.exports = {
  normalizeCouncilConfig,
  validateCouncilConfig,
  normalizeAndValidateCouncilConfig,
  validateCouncilFormat,
  validateAdvancedFormat
};
