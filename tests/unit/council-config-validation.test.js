// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for council config validation
 *
 * Tests the validateCouncilConfig function from the councils route module.
 * Covers valid configs, edge cases, and all validation error paths.
 */

import { describe, it, expect } from 'vitest';
import { validateCouncilConfig } from '../../src/routes/councils.js';

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
