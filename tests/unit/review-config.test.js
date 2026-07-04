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

    // PAIR_REVIEW_MODEL is a deliberate one-shot override (CI/agent), so it must
    // win over a repo's sticky persisted default_model. This matches the
    // pre-refactor performHeadlessReview ladder and the MCP ladder; --ai-draft /
    // --ai-review resolve through this resolver and must not silently change.
    it('prefers PAIR_REVIEW_MODEL over a repo default_model', async () => {
      process.env.PAIR_REVIEW_MODEL = 'env-model';
      seedRepoSettings(db, { default_model: 'repo-model' });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude', default_model: 'opus' }
      );
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'env-model' });
    });

    // Symmetric provider override: PAIR_REVIEW_PROVIDER beats a repo
    // default_provider for the same one-shot-override reason.
    it('prefers PAIR_REVIEW_PROVIDER over a repo default_provider', async () => {
      process.env.PAIR_REVIEW_PROVIDER = 'codex';
      seedRepoSettings(db, { default_provider: 'antigravity', default_model: 'sonnet' });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        {},
        { default_provider: 'claude' }
      );
      expect(result).toEqual({ type: 'single', provider: 'codex', model: 'sonnet' });
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
