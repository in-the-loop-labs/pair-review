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
 *   5. global config default (then 'claude' + that provider's own default
 *      model, with hardcoded 'opus' as the last-resort floor)
 * plus graceful fallback when default_council_id points at a missing council.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createTestDatabase, closeTestDatabase } from '../utils/schema.js';

const { resolveReviewConfig } = require('../../src/review-config.js');
const { applyConfigOverrides } = require('../../src/ai');
const { CouncilRepository, RepoSettingsRepository } = require('../../src/database.js');
const { _resetForTests } = require('../../src/councils/council-store.js');
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

    it('falls back to claude with the provider\'s own default model when nothing is configured', async () => {
      // The provider-default rung ranks above the hardcoded 'claude'/'opus'
      // rescue, so the zero-config case resolves Claude's canonical default id
      // (of which 'opus' is an alias) — functionally the same model.
      const result = await resolveReviewConfig(db, REPOSITORY, {}, {});
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'opus-4.8-xhigh' });
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

  // A tier's default_model is saved as a pair with that tier's default_provider,
  // so a provider-only pick must not inherit a model configured for a DIFFERENT
  // provider — it lands on the provider's own default instead (matching the
  // default the settings UI derives via models.find(m => m.default)).
  describe('9. provider-default model for provider-only selections', () => {
    it('resolves --provider omp to OMP\'s default mode, not the global default_model', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { provider: 'omp' },
        { default_provider: 'claude', default_model: 'opus' }
      );
      expect(result).toEqual({ type: 'single', provider: 'omp', model: 'default' });
    });

    it('resolves --provider pi to Pi\'s default mode, not the global default_model', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { provider: 'pi' },
        { default_provider: 'claude', default_model: 'opus' }
      );
      expect(result).toEqual({ type: 'single', provider: 'pi', model: 'default' });
    });

    it('passes an explicit --model through verbatim even for fuzzy-matching providers', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { provider: 'omp', model: 'opus' },
        { default_provider: 'claude', default_model: 'opus' }
      );
      expect(result).toEqual({ type: 'single', provider: 'omp', model: 'opus' });
    });

    it('keeps the global default_model when its paired provider matches the pick', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { provider: 'pi' },
        { default_provider: 'pi', default_model: 'multi-model' }
      );
      expect(result).toEqual({ type: 'single', provider: 'pi', model: 'multi-model' });
    });

    it('skips a repo default_model saved for a different provider', async () => {
      seedRepoSettings(db, { default_provider: 'claude', default_model: 'sonnet' });

      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { provider: 'omp' },
        { default_provider: 'claude', default_model: 'opus' }
      );
      expect(result).toEqual({ type: 'single', provider: 'omp', model: 'default' });
    });

    it('still applies a provider-agnostic model-only in-app override', async () => {
      // An override tier that names no provider is treated as provider-agnostic.
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { provider: 'omp' },
        { default_provider: 'claude', default_model: 'opus', _globalOverrides: { default_model: 'app-model' } }
      );
      expect(result).toEqual({ type: 'single', provider: 'omp', model: 'app-model' });
    });

    it('falls back to the global model when the provider has no built-in default (opencode)', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { provider: 'opencode' },
        { default_provider: 'claude', default_model: 'opus' }
      );
      expect(result).toEqual({ type: 'single', provider: 'opencode', model: 'opus' });
    });

    it('falls back to the hardcoded model for an unregistered provider', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY,
        { provider: 'not-a-provider' },
        {}
      );
      expect(result).toEqual({ type: 'single', provider: 'not-a-provider', model: 'opus' });
    });
  });

  // The provider-default rung ranks ABOVE the hardcoded 'claude'/'opus' rescue,
  // and it resolves via _resolveProviderDefaultModel, which honors per-provider
  // config overrides (providers.<id>.default_model / disabled_models) the same
  // way createProvider(id, null) does.
  describe('10. provider config overrides on the provider-default rung', () => {
    afterEach(() => {
      // applyConfigOverrides clears + repopulates the module-level override map;
      // reset it so other tests in this file see pristine built-in defaults.
      applyConfigOverrides({ providers: {} });
    });

    it('honors a configured providers.claude.default_model on a provider-only pick', async () => {
      applyConfigOverrides({ providers: { claude: { default_model: 'sonnet-5-xhigh' } } });

      const result = await resolveReviewConfig(db, REPOSITORY, { provider: 'claude' }, {});
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'sonnet-5-xhigh' });
    });

    it('does not resurrect a disabled default: opus in disabled_models resolves another model', async () => {
      applyConfigOverrides({ providers: { claude: { disabled_models: ['opus'] } } });

      const result = await resolveReviewConfig(db, REPOSITORY, { provider: 'claude' }, {});
      // With the default (opus-4.8-xhigh, alias 'opus') disabled, resolution
      // falls to the first balanced-tier model in Claude's built-in list.
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'sonnet-5-xhigh' });
    });
  });

  // `cfg` is the FLATTENED effective config: buildEffectiveConfig() dot-path-
  // writes in-app overrides into the merged file config, so a provider-only
  // /settings override leaves cfg.default_provider (new) paired with
  // cfg.default_model (inherited from a lower layer). The tier guard cannot see
  // that — cfg's provider matches by construction — so the resolver skips the
  // cfg tier when the overrides prove the pair incoherent (provider set, model
  // not).
  describe('11. provider-only in-app override (incoherent flattened cfg pair)', () => {
    it('skips the inherited cfg model and uses the new provider\'s own default', async () => {
      // Simulates flipping only "Default provider" to omp on /settings over a
      // claude/opus config file: the override is folded into cfg AND carried on
      // _globalOverrides without a model.
      const result = await resolveReviewConfig(
        db, REPOSITORY, {},
        { default_provider: 'omp', default_model: 'opus', _globalOverrides: { default_provider: 'omp' } }
      );
      expect(result).toEqual({ type: 'single', provider: 'omp', model: 'default' });
    });

    it('applies the override pair when the override sets provider AND model (pair is coherent)', async () => {
      const result = await resolveReviewConfig(
        db, REPOSITORY, {},
        {
          default_provider: 'omp',
          default_model: 'app-model',
          _globalOverrides: { default_provider: 'omp', default_model: 'app-model' }
        }
      );
      expect(result).toEqual({ type: 'single', provider: 'omp', model: 'app-model' });
    });

    it('a repo default_model for the same provider still wins over the provider default', async () => {
      seedRepoSettings(db, { default_provider: 'omp', default_model: 'repo-omp-model' });

      const result = await resolveReviewConfig(
        db, REPOSITORY, {},
        { default_provider: 'omp', default_model: 'opus', _globalOverrides: { default_provider: 'omp' } }
      );
      expect(result).toEqual({ type: 'single', provider: 'omp', model: 'repo-omp-model' });
    });
  });

  // Both default-council tiers resolve through CouncilStore, so a `file:` id
  // from the read-only overlay (`~/.pair-review/councils/*.json`) is a valid
  // default. Vitest sets PAIR_REVIEW_NO_FILE_COUNCILS=1, so the overlay is empty
  // unless a test primes it via `_resetForTests(rows)`.
  describe('11. file councils as repo/global defaults', () => {
    /** A file-overlay row shaped exactly like `loadFileCouncils` returns. */
    function fileCouncilRow({ stem = 'dream-team', name = 'Dream Team', type = 'advanced', config = advancedConfig } = {}) {
      return {
        id: `file:${stem}`,
        name,
        type,
        config,
        description: 'From a file',
        last_used_at: null,
        created_at: null,
        updated_at: null,
        source: 'file',
        readOnly: true,
        filePath: `/councils/${stem}.council.json`
      };
    }

    // Mandatory: the overlay cache is module-level and would otherwise leak into
    // every later test in this file.
    afterEach(() => {
      _resetForTests();
    });

    it('resolves a repo default_council_id pointing at a file council', async () => {
      _resetForTests([fileCouncilRow()]);
      seedRepoSettings(db, { default_council_id: 'file:dream-team' });

      const result = await resolveReviewConfig(db, REPOSITORY, {}, { default_provider: 'claude', default_model: 'opus' });

      expect(result.type).toBe('council');
      expect(result.council.id).toBe('file:dream-team');
      expect(result.council.source).toBe('file');
      expect(result.configType).toBe('advanced');
      expect(result.councilConfig).toEqual(advancedConfig);
    });

    it('resolves a global default_council_id pointing at a voice-centric file council', async () => {
      _resetForTests([fileCouncilRow({ stem: 'voices', name: 'Voices', type: 'council', config: voiceConfig })]);

      const result = await resolveReviewConfig(
        db, REPOSITORY, {},
        { default_provider: 'claude', default_model: 'opus', _globalOverrides: { default_council_id: 'file:voices' } }
      );

      expect(result.type).toBe('council');
      expect(result.council.id).toBe('file:voices');
      expect(result.configType).toBe('council');
      expect(result.councilConfig.voices).toHaveLength(2);
    });

    it('resolves a config-file default_council_id pointing at a file council', async () => {
      _resetForTests([fileCouncilRow()]);

      const result = await resolveReviewConfig(db, REPOSITORY, {}, { default_council_id: 'file:dream-team' });

      expect(result.type).toBe('council');
      expect(result.council.id).toBe('file:dream-team');
    });

    it('a repo file council beats a global default council', async () => {
      const globalId = uuidv4();
      await new CouncilRepository(db).create({ id: globalId, name: 'Global', config: advancedConfig, type: 'advanced' });
      _resetForTests([fileCouncilRow()]);
      seedRepoSettings(db, { default_council_id: 'file:dream-team' });

      const result = await resolveReviewConfig(
        db, REPOSITORY, {},
        { _globalOverrides: { default_council_id: globalId } }
      );

      expect(result.council.id).toBe('file:dream-team');
    });

    // A council file the user renamed or deleted must not break the run: the
    // stale-id behavior is identical to a deleted DB council.
    it('falls back to the single default (with a warning) when a repo file: id is stale', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      _resetForTests([]);
      seedRepoSettings(db, { default_council_id: 'file:deleted-council' });

      const result = await resolveReviewConfig(
        db, REPOSITORY, {},
        { default_provider: 'claude', default_model: 'opus' }
      );

      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'opus' });
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toMatch(/file:deleted-council.*was not found/);
    });

    it('falls back to the single default (with a warning) when a global file: id is stale', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      _resetForTests([]);

      const result = await resolveReviewConfig(
        db, REPOSITORY, {},
        { default_provider: 'claude', default_model: 'opus', _globalOverrides: { default_council_id: 'file:deleted-council' } }
      );

      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'opus' });
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toMatch(/Global default council "file:deleted-council" was not found/);
    });

    it('resolves an explicit --council handle naming a file council', async () => {
      _resetForTests([fileCouncilRow()]);

      const result = await resolveReviewConfig(db, REPOSITORY, { council: 'file:dream' }, {});

      expect(result.type).toBe('council');
      expect(result.council.id).toBe('file:dream-team');
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
      expect(result).toEqual({ type: 'single', provider: 'claude', model: 'opus-4.8-xhigh' });
    });
  });
});
