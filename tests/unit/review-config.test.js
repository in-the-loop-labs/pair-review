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

    // A repo's saved default is more specific than the config-file default, so
    // the repo default_model wins over config.default_model.
    it('prefers a repo default_model over the config default', async () => {
      seedRepoSettings(db, { default_model: 'repo-model' });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude', default_model: 'opus' }
      );
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'repo-model' });
    });

    // Symmetric: the repo default_provider beats the config default.
    it('prefers a repo default_provider over the config default', async () => {
      seedRepoSettings(db, { default_provider: 'antigravity', default_model: 'sonnet' });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude' }
      );
      expect(result).toEqual({ type: 'single', provider: 'antigravity', model: 'sonnet' });
    });

    // An explicit per-run flag (--provider/--model) is still supreme.
    it('lets an explicit --model/--provider win over repo/config defaults', async () => {
      seedRepoSettings(db, { default_provider: 'codex', default_model: 'gpt-5.5' });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { provider: 'antigravity', model: 'gemini-3.1-pro-low' },
        { default_provider: 'claude', default_model: 'opus' }
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
  });

  // The /settings page persists global provider/model overrides. The effective
  // config carries them on `config._globalOverrides` so the resolver can rank an
  // in-app override ABOVE the config-file default but BELOW a repo default.
  describe('6. global in-app override (config._globalOverrides)', () => {
    it('ranks an in-app override above the config-file default', async () => {
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
  });

  // When default_provider/default_model is locked as final by configuration, the
  // effective config (built upstream) already excludes the key from
  // _globalOverrides and folds its config-file value into cfg.default_*, so the
  // config value wins here without the resolver special-casing _finalKeys. A
  // repo-scoped default and an explicit flag are more specific and still win.
  describe('7. finalized config value resolves from the config file', () => {
    it('a finalized default_model resolves to the config-file value', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude', default_model: 'file-model', _finalKeys: ['default_model'] }
      );
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'file-model' });
    });

    it('a finalized default_provider resolves to the config-file value', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'file-provider', default_model: 'opus', _finalKeys: ['default_provider'] }
      );
      expect(result).toEqual({ type: 'single', provider: 'file-provider', model: 'opus' });
    });

    it('a repo default still beats a finalized config value (repo is more specific)', async () => {
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
  });

  // The /settings page can store a GLOBAL default council id, carried on
  // config._globalOverrides.default_council_id (or a config-file
  // default_council_id). It sits below a repo council but above the single
  // ladder — including a repo's single provider/model default.
  describe('8. global default council', () => {
    it('fires from an in-app override and outranks the single/config default', async () => {
      const id = uuidv4();
      await new CouncilRepository(db).create({ id, name: 'Global', config: advancedConfig, type: 'advanced' });

      const result = await resolveReviewConfig(
        db, REPOSITORY, {},
        { default_provider: 'claude', default_model: 'opus', _globalOverrides: { default_council_id: id } }
      );

      expect(result.type).toBe('council');
      expect(result.council.id).toBe(id);
      expect(result.configType).toBe('advanced');
    });

    it('fires from a config-file default_council_id (no _globalOverrides)', async () => {
      const id = uuidv4();
      await new CouncilRepository(db).create({ id, name: 'FileGlobal', config: voiceConfig, type: 'council' });

      const result = await resolveReviewConfig(db, REPOSITORY, {}, { default_council_id: id });

      expect(result.type).toBe('council');
      expect(result.council.id).toBe(id);
      expect(result.configType).toBe('council');
    });

    it('a repo default council beats the global default council', async () => {
      const globalId = uuidv4();
      const repoId = uuidv4();
      await new CouncilRepository(db).create({ id: globalId, name: 'Global', config: advancedConfig, type: 'advanced' });
      await new CouncilRepository(db).create({ id: repoId, name: 'Repo', config: voiceConfig, type: 'council' });
      seedRepoSettings(db, { default_council_id: repoId });

      const result = await resolveReviewConfig(
        db, REPOSITORY, {},
        { _globalOverrides: { default_council_id: globalId } }
      );

      expect(result.type).toBe('council');
      expect(result.council.id).toBe(repoId);
    });

    it('the global council outranks a repo single provider/model default', async () => {
      const globalId = uuidv4();
      await new CouncilRepository(db).create({ id: globalId, name: 'Global', config: advancedConfig, type: 'advanced' });
      // Repo has only a single default (no repo council).
      seedRepoSettings(db, { default_provider: 'antigravity', default_model: 'gemini-3.1-pro-low' });

      const result = await resolveReviewConfig(
        db, REPOSITORY, {},
        { _globalOverrides: { default_council_id: globalId } }
      );

      expect(result.type).toBe('council');
      expect(result.council.id).toBe(globalId);
    });

    it('an explicit --provider/--model still beats the global council', async () => {
      const globalId = uuidv4();
      await new CouncilRepository(db).create({ id: globalId, name: 'Global', config: advancedConfig, type: 'advanced' });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { provider: 'codex', model: 'gpt-5' },
        { _globalOverrides: { default_council_id: globalId } }
      );

      expect(result).toEqual({ type: 'single', provider: 'codex', model: 'gpt-5' });
    });

    it('falls back to the single default (with a warning) when the global council id is missing', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const result = await resolveReviewConfig(
        db, REPOSITORY, {},
        { default_provider: 'claude', default_model: 'opus', _globalOverrides: { default_council_id: uuidv4() } }
      );

      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'opus' });
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toMatch(/Global default council .* was not found/);
    });

    it('an empty default_council_id is inert (no council, single default resolves)', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY, {},
        { default_provider: 'claude', default_model: 'opus', _globalOverrides: { default_council_id: '' } }
      );
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'opus' });
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
