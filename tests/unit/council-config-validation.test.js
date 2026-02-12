// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for council config validation and normalization
 *
 * Tests the validateCouncilConfig and normalizeCouncilConfig functions
 * from the councils route module.
 * Covers valid configs, edge cases, normalization of legacy formats,
 * and all validation error paths.
 */

import { describe, it, expect } from 'vitest';
import { validateCouncilConfig, normalizeCouncilConfig } from '../../src/routes/councils.js';

describe('validateCouncilConfig', () => {
  const validConfig = {
    levels: {
      '1': {
        enabled: true,
        voices: [{ provider: 'claude', model: 'sonnet' }]
      },
      '2': { enabled: false, voices: [] },
      '3': { enabled: false, voices: [] }
    }
  };

  it('should return null for a valid config', () => {
    expect(validateCouncilConfig(validConfig)).toBeNull();
  });

  it('should return null for config with all levels enabled', () => {
    const config = {
      levels: {
        '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] },
        '2': { enabled: true, voices: [{ provider: 'gemini', model: 'pro' }] },
        '3': { enabled: true, voices: [{ provider: 'claude', model: 'opus' }] }
      }
    };
    expect(validateCouncilConfig(config)).toBeNull();
  });

  it('should return null for config with orchestration', () => {
    const config = {
      ...validConfig,
      orchestration: { provider: 'claude', model: 'opus' }
    };
    expect(validateCouncilConfig(config)).toBeNull();
  });

  it('should return null for multi-voice level', () => {
    const config = {
      levels: {
        '1': {
          enabled: true,
          voices: [
            { provider: 'claude', model: 'sonnet' },
            { provider: 'gemini', model: 'pro' }
          ]
        },
        '2': { enabled: false, voices: [] },
        '3': { enabled: false, voices: [] }
      }
    };
    expect(validateCouncilConfig(config)).toBeNull();
  });

  // Voice-centric council format (type: 'council')
  describe('council format (type: council)', () => {
    const validCouncilConfig = {
      voices: [
        { provider: 'claude', model: 'opus', tier: 'thorough' }
      ],
      levels: { '1': true, '2': true, '3': true },
      consolidation: { provider: 'claude', model: 'opus', tier: 'balanced' }
    };

    it('should return null for a valid council config', () => {
      expect(validateCouncilConfig(validCouncilConfig, 'council')).toBeNull();
    });

    it('should return null for council config without consolidation', () => {
      const config = {
        voices: [{ provider: 'claude', model: 'opus' }],
        levels: { '1': true, '2': false, '3': false }
      };
      expect(validateCouncilConfig(config, 'council')).toBeNull();
    });

    it('should return null for council config with multiple voices', () => {
      const config = {
        voices: [
          { provider: 'claude', model: 'opus', tier: 'thorough' },
          { provider: 'gemini', model: 'pro', tier: 'balanced' }
        ],
        levels: { '1': true, '2': true, '3': false }
      };
      expect(validateCouncilConfig(config, 'council')).toBeNull();
    });

    it('should return null for voice with optional fields (customInstructions, timeout)', () => {
      const config = {
        voices: [
          { provider: 'claude', model: 'opus', tier: 'thorough',
            customInstructions: 'Focus on security', timeout: 600000 }
        ],
        levels: { '1': true, '2': true, '3': true }
      };
      expect(validateCouncilConfig(config, 'council')).toBeNull();
    });

    it('should reject council config without voices', () => {
      const config = {
        levels: { '1': true }
      };
      expect(validateCouncilConfig(config, 'council')).toBe('config.voices must be a non-empty array');
    });

    it('should reject council config with empty voices array', () => {
      const config = {
        voices: [],
        levels: { '1': true }
      };
      expect(validateCouncilConfig(config, 'council')).toBe('config.voices must be a non-empty array');
    });

    it('should reject council voice without provider', () => {
      const config = {
        voices: [{ model: 'opus' }],
        levels: { '1': true }
      };
      expect(validateCouncilConfig(config, 'council')).toContain('voices[0].provider is required');
    });

    it('should reject council voice without model', () => {
      const config = {
        voices: [{ provider: 'claude' }],
        levels: { '1': true }
      };
      expect(validateCouncilConfig(config, 'council')).toContain('voices[0].model is required');
    });

    it('should identify the specific voice index in error', () => {
      const config = {
        voices: [
          { provider: 'claude', model: 'opus' },
          { provider: 'gemini' } // Missing model at index 1
        ],
        levels: { '1': true }
      };
      expect(validateCouncilConfig(config, 'council')).toContain('voices[1].model is required');
    });

    it('should reject council config without levels', () => {
      const config = {
        voices: [{ provider: 'claude', model: 'opus' }]
      };
      expect(validateCouncilConfig(config, 'council')).toBe('config.levels is required and must be an object');
    });

    it('should reject council config with no enabled levels', () => {
      const config = {
        voices: [{ provider: 'claude', model: 'opus' }],
        levels: { '1': false, '2': false, '3': false }
      };
      expect(validateCouncilConfig(config, 'council')).toBe('At least one level (1, 2, or 3) must be enabled');
    });

    it('should reject council config with empty levels', () => {
      const config = {
        voices: [{ provider: 'claude', model: 'opus' }],
        levels: {}
      };
      expect(validateCouncilConfig(config, 'council')).toBe('At least one level (1, 2, or 3) must be enabled');
    });

    it('should reject consolidation without provider', () => {
      const config = {
        voices: [{ provider: 'claude', model: 'opus' }],
        levels: { '1': true },
        consolidation: { model: 'opus' }
      };
      expect(validateCouncilConfig(config, 'council')).toContain('consolidation.provider and consolidation.model');
    });

    it('should reject consolidation without model', () => {
      const config = {
        voices: [{ provider: 'claude', model: 'opus' }],
        levels: { '1': true },
        consolidation: { provider: 'claude' }
      };
      expect(validateCouncilConfig(config, 'council')).toContain('consolidation.provider and consolidation.model');
    });
  });

  // Explicit type: 'advanced' should use the level-centric validation
  describe('explicit type: advanced', () => {
    it('should accept valid advanced config with explicit type', () => {
      const config = {
        levels: {
          '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] }
        }
      };
      expect(validateCouncilConfig(config, 'advanced')).toBeNull();
    });
  });

  // Type dispatch correctness: ensure type parameter determines which validator runs
  describe('type dispatch correctness', () => {
    it('should reject voice-centric config when type is advanced (mismatched format)', () => {
      // A voice-centric config shape sent with type: 'advanced' should fail
      // because advanced format expects levels.X.enabled and levels.X.voices structure
      const voiceCentricConfig = {
        voices: [{ provider: 'claude', model: 'opus' }],
        levels: { '1': true, '2': false, '3': false }
      };
      const error = validateCouncilConfig(voiceCentricConfig, 'advanced');
      expect(error).not.toBeNull();
    });

    it('should reject advanced config when type is council (mismatched format)', () => {
      // An advanced config shape sent with type: 'council' should fail
      // because council format expects config.voices array
      const advancedConfig = {
        levels: {
          '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] }
        }
      };
      const error = validateCouncilConfig(advancedConfig, 'council');
      expect(error).not.toBeNull();
    });

    it('should default to advanced validation when type is undefined', () => {
      // No type provided (legacy behavior) should use advanced validation
      expect(validateCouncilConfig(validConfig)).toBeNull();
    });

    it('should default to advanced validation when type is null', () => {
      expect(validateCouncilConfig(validConfig, null)).toBeNull();
    });
  });

  // Error cases
  describe('error cases', () => {
    it('should reject null config', () => {
      expect(validateCouncilConfig(null)).toBe('config must be an object');
    });

    it('should reject undefined config', () => {
      expect(validateCouncilConfig(undefined)).toBe('config must be an object');
    });

    it('should reject non-object config', () => {
      expect(validateCouncilConfig('string')).toBe('config must be an object');
    });

    it('should reject config without levels', () => {
      expect(validateCouncilConfig({})).toBe('config.levels is required and must be an object');
    });

    it('should reject non-object levels', () => {
      expect(validateCouncilConfig({ levels: 'string' })).toBe('config.levels is required and must be an object');
    });

    it('should reject invalid level keys', () => {
      const config = {
        levels: { '4': { enabled: false, voices: [] } }
      };
      expect(validateCouncilConfig(config)).toContain('Invalid level key: "4"');
    });

    it('should reject non-boolean enabled', () => {
      const config = {
        levels: { '1': { enabled: 'yes', voices: [] } }
      };
      expect(validateCouncilConfig(config)).toContain('enabled must be a boolean');
    });

    it('should reject enabled level without voices', () => {
      const config = {
        levels: { '1': { enabled: true, voices: [] } }
      };
      expect(validateCouncilConfig(config)).toContain('must be a non-empty array');
    });

    it('should reject enabled level with non-array voices', () => {
      const config = {
        levels: { '1': { enabled: true, voices: 'not-array' } }
      };
      expect(validateCouncilConfig(config)).toContain('must be a non-empty array');
    });

    it('should reject voice without provider', () => {
      const config = {
        levels: { '1': { enabled: true, voices: [{ model: 'sonnet' }] } }
      };
      expect(validateCouncilConfig(config)).toContain('provider is required');
    });

    it('should reject voice without model', () => {
      const config = {
        levels: { '1': { enabled: true, voices: [{ provider: 'claude' }] } }
      };
      expect(validateCouncilConfig(config)).toContain('model is required');
    });

    it('should identify the specific voice index in error messages', () => {
      const config = {
        levels: {
          '2': {
            enabled: true,
            voices: [
              { provider: 'claude', model: 'sonnet' },
              { provider: 'gemini' } // Missing model at index 1
            ]
          }
        }
      };
      expect(validateCouncilConfig(config)).toContain('levels.2.voices[1].model');
    });

    it('should reject orchestration without provider', () => {
      const config = {
        ...validConfig,
        orchestration: { model: 'opus' }
      };
      expect(validateCouncilConfig(config)).toContain('orchestration.provider and orchestration.model');
    });

    it('should reject orchestration without model', () => {
      const config = {
        ...validConfig,
        orchestration: { provider: 'claude' }
      };
      expect(validateCouncilConfig(config)).toContain('orchestration.provider and orchestration.model');
    });

    it('should reject config with all levels disabled', () => {
      const config = {
        levels: {
          '1': { enabled: false, voices: [] }
        }
      };
      expect(validateCouncilConfig(config)).toBe('At least one level must be enabled');
    });

    it('should reject config with empty levels object', () => {
      const config = {
        levels: {}
      };
      expect(validateCouncilConfig(config)).toBe('At least one level must be enabled');
    });

    it('should allow disabled levels alongside an enabled level', () => {
      const config = {
        levels: {
          '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] },
          '2': { enabled: false, voices: [] }
        }
      };
      expect(validateCouncilConfig(config)).toBeNull();
    });
  });
});

describe('normalizeCouncilConfig', () => {
  it('should return config unchanged when type is not council', () => {
    const config = { levels: { '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] } } };
    expect(normalizeCouncilConfig(config, 'advanced')).toBe(config);
  });

  it('should return config unchanged when type is undefined', () => {
    const config = { levels: { '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] } } };
    expect(normalizeCouncilConfig(config, undefined)).toBe(config);
  });

  it('should return config unchanged when config is null', () => {
    expect(normalizeCouncilConfig(null, 'council')).toBeNull();
  });

  it('should return config unchanged when config is not an object', () => {
    expect(normalizeCouncilConfig('string', 'council')).toBe('string');
  });

  it('should return config unchanged when it already has a non-empty voices array', () => {
    const config = {
      voices: [{ provider: 'claude', model: 'opus' }],
      levels: { '1': true, '2': true, '3': false }
    };
    expect(normalizeCouncilConfig(config, 'council')).toBe(config);
  });

  it('should convert advanced (levels-based) config to voice-centric format', () => {
    const advancedConfig = {
      levels: {
        '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] },
        '2': { enabled: true, voices: [{ provider: 'gemini', model: 'pro' }] },
        '3': { enabled: false, voices: [] }
      }
    };

    const result = normalizeCouncilConfig(advancedConfig, 'council');

    expect(result.voices).toEqual([
      { provider: 'claude', model: 'sonnet' },
      { provider: 'gemini', model: 'pro' }
    ]);
    expect(result.levels).toEqual({ '1': true, '2': true, '3': false });
  });

  it('should deduplicate voices across levels', () => {
    const advancedConfig = {
      levels: {
        '1': { enabled: true, voices: [
          { provider: 'claude', model: 'sonnet', tier: 'balanced' }
        ]},
        '2': { enabled: true, voices: [
          { provider: 'claude', model: 'sonnet', tier: 'balanced' },
          { provider: 'gemini', model: 'pro', tier: 'balanced' }
        ]}
      }
    };

    const result = normalizeCouncilConfig(advancedConfig, 'council');

    expect(result.voices).toHaveLength(2);
    expect(result.voices[0]).toEqual({ provider: 'claude', model: 'sonnet', tier: 'balanced' });
    expect(result.voices[1]).toEqual({ provider: 'gemini', model: 'pro', tier: 'balanced' });
  });

  it('should preserve orchestration as consolidation', () => {
    const advancedConfig = {
      levels: {
        '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] }
      },
      orchestration: { provider: 'claude', model: 'opus' }
    };

    const result = normalizeCouncilConfig(advancedConfig, 'council');

    expect(result.consolidation).toEqual({ provider: 'claude', model: 'opus' });
  });

  it('should preserve consolidation field if already present', () => {
    const advancedConfig = {
      levels: {
        '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] }
      },
      consolidation: { provider: 'gemini', model: 'pro' }
    };

    const result = normalizeCouncilConfig(advancedConfig, 'council');

    expect(result.consolidation).toEqual({ provider: 'gemini', model: 'pro' });
  });

  it('should handle config with empty voices array and advanced levels', () => {
    const config = {
      voices: [],
      levels: {
        '1': { enabled: true, voices: [{ provider: 'claude', model: 'opus' }] },
        '2': { enabled: false, voices: [] }
      }
    };

    const result = normalizeCouncilConfig(config, 'council');

    // Empty voices triggers normalization from advanced levels
    expect(result.voices).toEqual([{ provider: 'claude', model: 'opus' }]);
    expect(result.levels).toEqual({ '1': true, '2': false });
  });

  it('should not modify config with boolean levels (already voice-centric but empty voices)', () => {
    const config = {
      voices: [],
      levels: { '1': true, '2': false, '3': false }
    };

    // Boolean levels = already voice-centric format, no advanced levels to extract from
    const result = normalizeCouncilConfig(config, 'council');
    expect(result).toBe(config);
  });

  it('should handle config without levels gracefully', () => {
    const config = { voices: [] };
    const result = normalizeCouncilConfig(config, 'council');
    // No levels to extract from, returns as-is
    expect(result).toBe(config);
  });

  it('should produce a config that passes validateCouncilConfig after normalization', () => {
    // This is the key regression test: a levels-based config stored with type 'council'
    // should be normalizable to pass validation
    const legacyConfig = {
      levels: {
        '1': { enabled: true, voices: [{ provider: 'claude', model: 'opus', tier: 'thorough' }] },
        '2': { enabled: true, voices: [{ provider: 'gemini', model: 'pro', tier: 'balanced' }] },
        '3': { enabled: false, voices: [] }
      },
      orchestration: { provider: 'claude', model: 'opus' }
    };

    // Before normalization, this would fail council validation
    expect(validateCouncilConfig(legacyConfig, 'council')).toBe('config.voices must be a non-empty array');

    // After normalization, it should pass
    const normalized = normalizeCouncilConfig(legacyConfig, 'council');
    expect(validateCouncilConfig(normalized, 'council')).toBeNull();
  });

  it('should preserve voices with different timeouts (not deduplicate them)', () => {
    const advancedConfig = {
      levels: {
        '1': { enabled: true, voices: [
          { provider: 'claude', model: 'sonnet', tier: 'balanced', timeout: 120000 },
          { provider: 'claude', model: 'sonnet', tier: 'balanced', timeout: 600000 }
        ]},
        '2': { enabled: false, voices: [] }
      }
    };

    const result = normalizeCouncilConfig(advancedConfig, 'council');

    expect(result.voices).toHaveLength(2);
    expect(result.voices[0].timeout).toBe(120000);
    expect(result.voices[1].timeout).toBe(600000);
  });

  it('should not include orchestration key in normalized output', () => {
    const advancedConfig = {
      levels: {
        '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] }
      },
      orchestration: { provider: 'claude', model: 'opus' }
    };

    const result = normalizeCouncilConfig(advancedConfig, 'council');

    expect(result.consolidation).toEqual({ provider: 'claude', model: 'opus' });
    expect(result).not.toHaveProperty('orchestration');
  });

  it('should handle mixed level formats (some boolean, some object)', () => {
    const config = {
      levels: {
        '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] },
        '2': true,
        '3': false
      }
    };

    const result = normalizeCouncilConfig(config, 'council');

    expect(result.voices).toEqual([{ provider: 'claude', model: 'sonnet' }]);
    expect(result.levels).toEqual({ '1': true, '2': true, '3': false });
  });
});
