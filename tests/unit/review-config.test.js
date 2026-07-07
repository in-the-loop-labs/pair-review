// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for resolveReviewConfig() in src/review-config.js.
 *
 * Exercises the full precedence ladder used by both the headless CLI path and
 * the interactive web analyze routes:
 *   1. explicit --council handle
 *   2. explicit --provider/--model
 *   3. repo_settings.default_council_id
 *   4. repo_settings.default_provider/default_model
 *   5. global config default (then hardcoded 'claude'/'opus')
 * plus graceful fallback when default_council_id points at a missing council.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createTestDatabase, closeTestDatabase } from '../utils/schema.js';

const { resolveReviewConfig } = require('../../src/review-config.js');
const { CouncilRepository, RepoSettingsRepository } = require('../../src/database.js');
const logger = require('../../src/utils/logger.js');

const REPOSITORY = 'test/repo';

// Advanced (level-centric) council config — valid for type 'advanced'.
const advancedConfig = {
  levels: {
    '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }] },
    '2': { enabled: false, voices: [] },
    '3': { enabled: false, voices: [] }
  }
};

// Voice-centric council config — valid for type 'council'.
const voiceConfig = {
  voices: [
    { provider: 'claude', model: 'sonnet', tier: 'balanced' },
    { provider: 'antigravity', model: 'gemini-3.1-pro-low' }
  ],
  levels: { '1': true, '2': false, '3': false }
};

/** Insert a repo_settings row for REPOSITORY with the given column overrides. */
function seedRepoSettings(db, overrides = {}) {
  const cols = {
    repository: REPOSITORY,
    default_provider: null,
    default_model: null,
    default_council_id: null,
    ...overrides
  };
  db.prepare(
    `INSERT INTO repo_settings (repository, default_provider, default_model, default_council_id)
     VALUES (@repository, @default_provider, @default_model, @default_council_id)`
  ).run(cols);
}

describe('resolveReviewConfig', () => {
  let db;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(() => {
    // Ensure the env overrides never leak between tests.
    delete process.env.PAIR_REVIEW_MODEL;
    delete process.env.PAIR_REVIEW_PROVIDER;
    vi.restoreAllMocks();
    closeTestDatabase(db);
  });

  describe('1. explicit --council handle', () => {
    it('resolves an explicit council handle to a council selection (advanced)', async () => {
      const id = uuidv4();
      await new CouncilRepository(db).create({ id, name: 'Security Review', config: advancedConfig, type: 'advanced' });

      const result = await resolveReviewConfig(db, REPOSITORY, { council: 'Security Review' }, {});

      expect(result.type).toBe('council');
      expect(result.council.id).toBe(id);
      expect(result.configType).toBe('advanced');
      expect(result.councilConfig).toEqual(advancedConfig);
    });

    it('resolves a voice-centric council and reports configType "council"', async () => {
      const id = uuidv4();
      await new CouncilRepository(db).create({ id, name: 'Voices', config: voiceConfig, type: 'council' });

      const result = await resolveReviewConfig(db, REPOSITORY, { council: id }, {});

      expect(result.type).toBe('council');
      expect(result.configType).toBe('council');
      expect(result.councilConfig.voices).toHaveLength(2);
    });

    it('takes precedence over an explicit model and over repo defaults', async () => {
      const councilId = uuidv4();
      await new CouncilRepository(db).create({ id: councilId, name: 'Wins', config: advancedConfig, type: 'advanced' });
      seedRepoSettings(db, { default_provider: 'antigravity', default_model: 'gemini-3.1-pro-low', default_council_id: uuidv4() });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { council: 'Wins', provider: 'codex', model: 'gpt-5' },
        { default_provider: 'claude', default_model: 'opus' }
      );

      expect(result.type).toBe('council');
      expect(result.council.id).toBe(councilId);
    });

    it('throws when the explicit handle matches no council', async () => {
      await expect(
        resolveReviewConfig(db, REPOSITORY, { council: 'does-not-exist' }, {})
      ).rejects.toThrow(/No council matches/);
    });
  });

  describe('2. explicit --provider/--model', () => {
    it('returns single with the explicit provider and model', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { provider: 'antigravity', model: 'gemini-3.1-pro-low' },
        { default_provider: 'claude', default_model: 'opus' }
      );
      expect(result).toEqual({ type: 'single', provider: 'antigravity', model: 'gemini-3.1-pro-low' });
    });

    it('when only model is given, resolves provider from repo defaults', async () => {
      seedRepoSettings(db, { default_provider: 'antigravity' });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { model: 'gemini-3.1-pro-low' },
        { default_provider: 'claude' }
      );
      expect(result).toEqual({ type: 'single', provider: 'antigravity', model: 'gemini-3.1-pro-low' });
    });

    it('when only model is given and no repo default, resolves provider from config', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { model: 'opus-special' },
        { default_provider: 'claude' }
      );
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'opus-special' });
    });

    it('when only provider is given, resolves model from repo defaults', async () => {
      seedRepoSettings(db, { default_model: 'sonnet' });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { provider: 'claude' },
        {}
      );
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'sonnet' });
    });

    it('explicit single pick takes precedence over a repo default council', async () => {
      const councilId = uuidv4();
      await new CouncilRepository(db).create({ id: councilId, name: 'Default', config: advancedConfig, type: 'advanced' });
      seedRepoSettings(db, { default_council_id: councilId });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { provider: 'antigravity', model: 'gemini-3.1-pro-low' },
        {}
      );
      expect(result).toEqual({ type: 'single', provider: 'antigravity', model: 'gemini-3.1-pro-low' });
    });
  });

  describe('3. repo_settings.default_council_id', () => {
    it('resolves the repo default council directly by id', async () => {
      const id = uuidv4();
      await new CouncilRepository(db).create({ id, name: 'Repo Default', config: advancedConfig, type: 'advanced' });
      seedRepoSettings(db, { default_council_id: id });

      const result = await resolveReviewConfig(db, REPOSITORY, {}, { default_provider: 'claude', default_model: 'opus' });

      expect(result.type).toBe('council');
      expect(result.council.id).toBe(id);
      expect(result.configType).toBe('advanced');
      expect(result.councilConfig).toEqual(advancedConfig);
    });

    it('derives configType "council" for a voice-centric repo default council', async () => {
      const id = uuidv4();
      await new CouncilRepository(db).create({ id, name: 'Repo Voices', config: voiceConfig, type: 'council' });
      seedRepoSettings(db, { default_council_id: id });

      const result = await resolveReviewConfig(db, REPOSITORY, {}, {});

      expect(result.type).toBe('council');
      expect(result.configType).toBe('council');
      expect(result.councilConfig.voices).toHaveLength(2);
    });

    it('falls back to single default (with a warning) when the council id is missing', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      seedRepoSettings(db, { default_council_id: uuidv4() });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude', default_model: 'opus' }
      );

      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'opus' });
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toMatch(/was not found/);
    });
  });

  describe('4. repo_settings.default_provider/default_model', () => {
    it('uses the repo default provider and model when no explicit pick or council', async () => {
      seedRepoSettings(db, { default_provider: 'antigravity', default_model: 'gemini-3.1-pro-low' });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude', default_model: 'opus' }
      );
      expect(result).toEqual({ type: 'single', provider: 'antigravity', model: 'gemini-3.1-pro-low' });
    });

    // A repo's saved default is now MORE specific than a process-wide env var,
    // so the repo default_model wins over PAIR_REVIEW_MODEL. The /settings work
    // deliberately reversed the prior env-above-repo ordering; CI callers that
    // need to beat a repo default must pass an explicit --model (still supreme).
    it('prefers a repo default_model over PAIR_REVIEW_MODEL', async () => {
      process.env.PAIR_REVIEW_MODEL = 'env-model';
      seedRepoSettings(db, { default_model: 'repo-model' });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude', default_model: 'opus' }
      );
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'repo-model' });
    });

    // Symmetric: the repo default_provider beats PAIR_REVIEW_PROVIDER.
    it('prefers a repo default_provider over PAIR_REVIEW_PROVIDER', async () => {
      process.env.PAIR_REVIEW_PROVIDER = 'codex';
      seedRepoSettings(db, { default_provider: 'antigravity', default_model: 'sonnet' });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude' }
      );
      expect(result).toEqual({ type: 'single', provider: 'antigravity', model: 'sonnet' });
    });

    // The env override is still below an explicit per-request pick.
    it('lets an explicit --model/--provider win over the env overrides', async () => {
      process.env.PAIR_REVIEW_MODEL = 'env-model';
      process.env.PAIR_REVIEW_PROVIDER = 'codex';

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { provider: 'antigravity', model: 'gemini-3.1-pro-low' },
        {}
      );
      expect(result).toEqual({ type: 'single', provider: 'antigravity', model: 'gemini-3.1-pro-low' });
    });
  });

  describe('5. global config default', () => {
    it('falls back to global config provider/model when no repo settings exist', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'antigravity', default_model: 'gemini-3.1-pro-low' }
      );
      expect(result).toEqual({ type: 'single', provider: 'antigravity', model: 'gemini-3.1-pro-low' });
    });

    it('honors the legacy config.provider / config.model keys', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { provider: 'codex', model: 'gpt-5' }
      );
      expect(result).toEqual({ type: 'single', provider: 'codex', model: 'gpt-5' });
    });

    it('falls back to hardcoded claude/opus when nothing is configured', async () => {
      const result = await resolveReviewConfig(db, REPOSITORY, {}, {});
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'opus' });
    });

    it('honors PAIR_REVIEW_MODEL over config defaults for the model field', async () => {
      process.env.PAIR_REVIEW_MODEL = 'env-model';
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude', default_model: 'opus' }
      );
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'env-model' });
    });
  });

  // The /settings page persists global provider/model overrides. The effective
  // config carries them on `config._globalOverrides` so the resolver can rank an
  // in-app override ABOVE env vars but BELOW a repo default — the config-file
  // value (folded into config.default_*) still sits below env.
  describe('6. global in-app override (config._globalOverrides)', () => {
    it('ranks an in-app override above PAIR_REVIEW_MODEL', async () => {
      process.env.PAIR_REVIEW_MODEL = 'env-model';
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude', default_model: 'opus', _globalOverrides: { default_model: 'app-model' } }
      );
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'app-model' });
    });

    it('ranks a repo default above an in-app override', async () => {
      seedRepoSettings(db, { default_model: 'repo-model' });
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude', default_model: 'opus', _globalOverrides: { default_model: 'app-model' } }
      );
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'repo-model' });
    });

    it('ranks env above the config-file default when no override is set', async () => {
      process.env.PAIR_REVIEW_PROVIDER = 'codex';
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude', default_model: 'opus' }
      );
      expect(result).toEqual({ type: 'single', provider: 'codex', model: 'opus' });
    });
  });

  // When default_provider/default_model is locked as final by configuration
  // (listed in config._finalKeys), the effective config already excludes it from
  // _globalOverrides AND the env tier must be skipped, so the config-file value
  // (folded into cfg.default_*) wins. A repo-scoped default and an explicit flag
  // are more specific and still win.
  describe('7. final config env-defeat (config._finalKeys)', () => {
    it('a finalized default_model beats PAIR_REVIEW_MODEL (config value wins)', async () => {
      process.env.PAIR_REVIEW_MODEL = 'env-model';
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude', default_model: 'file-model', _finalKeys: ['default_model'] }
      );
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'file-model' });
    });

    it('a finalized default_provider beats PAIR_REVIEW_PROVIDER (config value wins)', async () => {
      process.env.PAIR_REVIEW_PROVIDER = 'codex';
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'file-provider', default_model: 'opus', _finalKeys: ['default_provider'] }
      );
      expect(result).toEqual({ type: 'single', provider: 'file-provider', model: 'opus' });
    });

    it('a repo default still beats a finalized config value (repo is more specific)', async () => {
      process.env.PAIR_REVIEW_MODEL = 'env-model';
      seedRepoSettings(db, { default_model: 'repo-model' });
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude', default_model: 'file-model', _finalKeys: ['default_model'] }
      );
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'repo-model' });
    });

    it('an explicit --model still beats a finalized config value', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { model: 'flag-model' },
        { default_provider: 'claude', default_model: 'file-model', _finalKeys: ['default_model'] }
      );
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'flag-model' });
    });

    it('leaves the non-final field on its normal env-above-config ladder', async () => {
      // Only default_model is final; default_provider still honors env.
      process.env.PAIR_REVIEW_PROVIDER = 'codex';
      process.env.PAIR_REVIEW_MODEL = 'env-model';
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude', default_model: 'file-model', _finalKeys: ['default_model'] }
      );
      expect(result).toEqual({ type: 'single', provider: 'codex', model: 'file-model' });
    });
  });

  describe('edge cases', () => {
    it('treats a null/undefined repository as "no repo defaults"', async () => {
      const result = await resolveReviewConfig(
        db, null,
        {},
        { default_provider: 'antigravity', default_model: 'gemini-3.1-pro-low' }
      );
      expect(result).toEqual({ type: 'single', provider: 'antigravity', model: 'gemini-3.1-pro-low' });
    });

    it('defaults explicit and config args to empty objects', async () => {
      const result = await resolveReviewConfig(db, REPOSITORY);
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'opus' });
    });
  });
});
