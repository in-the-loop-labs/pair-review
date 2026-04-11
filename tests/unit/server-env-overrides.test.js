// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for applyEnvOverrides — the small helper that bridges
 * PAIR_REVIEW_SINGLE_PORT (and future env vars) into the loaded config
 * object. Extracted from startServer() so it can be tested in isolation
 * without spinning up Express, the database, or any other real deps.
 *
 * Contract: only the literal string "false" flips config.single_port to
 * false. Any other value (unset, "true", "1", empty string, etc.) leaves
 * the existing value untouched. Matches the PAIR_REVIEW_YOLO bridge.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { applyEnvOverrides } = require('../../src/server.js');

describe('applyEnvOverrides', () => {
  let savedSinglePortEnv;

  beforeEach(() => {
    savedSinglePortEnv = process.env.PAIR_REVIEW_SINGLE_PORT;
    delete process.env.PAIR_REVIEW_SINGLE_PORT;
  });

  afterEach(() => {
    if (savedSinglePortEnv === undefined) {
      delete process.env.PAIR_REVIEW_SINGLE_PORT;
    } else {
      process.env.PAIR_REVIEW_SINGLE_PORT = savedSinglePortEnv;
    }
  });

  describe('PAIR_REVIEW_SINGLE_PORT bridge', () => {
    it('flips config.single_port to false when env var is the literal string "false"', () => {
      process.env.PAIR_REVIEW_SINGLE_PORT = 'false';
      const config = { single_port: true };
      applyEnvOverrides(config);
      expect(config.single_port).toBe(false);
    });

    it('preserves single_port=true when env var is unset', () => {
      const config = { single_port: true };
      applyEnvOverrides(config);
      expect(config.single_port).toBe(true);
    });

    it('preserves single_port=false when env var is unset', () => {
      const config = { single_port: false };
      applyEnvOverrides(config);
      expect(config.single_port).toBe(false);
    });

    it('preserves existing value when env var is "true"', () => {
      process.env.PAIR_REVIEW_SINGLE_PORT = 'true';
      const config = { single_port: true };
      applyEnvOverrides(config);
      expect(config.single_port).toBe(true);
    });

    it('preserves existing value when env var is "1"', () => {
      process.env.PAIR_REVIEW_SINGLE_PORT = '1';
      const config = { single_port: true };
      applyEnvOverrides(config);
      expect(config.single_port).toBe(true);
    });

    it('preserves existing value when env var is an empty string', () => {
      process.env.PAIR_REVIEW_SINGLE_PORT = '';
      const config = { single_port: true };
      applyEnvOverrides(config);
      expect(config.single_port).toBe(true);
    });

    it('does not flip when env var is "False" (case-sensitive contract)', () => {
      process.env.PAIR_REVIEW_SINGLE_PORT = 'False';
      const config = { single_port: true };
      applyEnvOverrides(config);
      expect(config.single_port).toBe(true);
    });
  });

  it('returns the same config object it was given (chainable)', () => {
    const config = { single_port: true };
    const result = applyEnvOverrides(config);
    expect(result).toBe(config);
  });
});
