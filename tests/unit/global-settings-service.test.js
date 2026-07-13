// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for GlobalSettingsService (src/settings/global-settings-service.js).
 *
 * Covers source attribution across every config layer, override precedence
 * (in-app > env > files > default), dot-path effective-config construction
 * with falsy values, validation rejections on write, and sensitive masking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { GlobalSettingsService, redactSecrets } = require('../../src/settings/global-settings-service.js');
const { GlobalSettingsRepository } = require('../../src/database.js');
const { resolveSingleProviderModel } = require('../../src/review-config.js');
const { createTestDatabase, closeTestDatabase } = require('../utils/schema.js');
const logger = require('../../src/utils/logger.js');

// A base config resembling a fully-merged file config.
function baseConfig(overrides = {}) {
  return {
    theme: 'light',
    comment_format: 'legacy',
    default_provider: 'claude',
    default_model: 'opus',
    summaries: { enabled: false, auto_generate: true, max_files: 50 },
    tours: { enabled: false },
    chat: { enable_shortcuts: true },
    enable_chat: true,
    github_token: '',
    github_token_command: '',
    providers: {},
    repos: {},
    ...overrides
  };
}

// Ordered raw layers, low->high, as loadConfig produces them.
function makeLayers({ managed = {}, cfg = {}, cfgLocal = {}, project = {}, projectLocal = {} } = {}) {
  return [
    { name: 'default', data: { theme: 'light', default_provider: 'claude' } },
    { name: 'managed', data: managed },
    { name: 'config', data: cfg },
    { name: 'config.local', data: cfgLocal },
    { name: 'project', data: project },
    { name: 'project.local', data: projectLocal }
  ];
}

describe('GlobalSettingsService', () => {
  let db;
  const savedEnv = {};
  const ENV_KEYS = ['GITHUB_TOKEN', 'PAIR_REVIEW_YOLO', 'PORT'];

  beforeEach(() => {
    db = createTestDatabase();
    // Capture AND clear each key: tests assert default/file-layer sources, which
    // an inherited value in the developer/CI env would silently override into an
    // "env" attribution. afterEach restores the captured values.
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.restoreAllMocks();
    closeTestDatabase(db);
  });

  function makeService(opts = {}) {
    return new GlobalSettingsService({
      db,
      baseConfig: opts.baseConfig || baseConfig(),
      layers: opts.layers || makeLayers()
    });
  }

  describe('source attribution', () => {
    it('reports "default" when no layer, env, or override defines the value', () => {
      const svc = makeService();
      expect(svc.resolve('comment_button_action')).toEqual({ value: 'submit', source: 'default' });
    });

    it('attributes to the highest file layer that defines the path', () => {
      const layers = makeLayers({
        cfg: { comment_format: 'minimal' },
        projectLocal: { comment_format: 'plain' }
      });
      const svc = makeService({ layers });
      expect(svc.resolve('comment_format')).toEqual({ value: 'plain', source: 'project.local' });
    });

    it('uses own-property presence so a false/0 value still attributes', () => {
      const layers = makeLayers({ cfg: { summaries: { enabled: false } } });
      const svc = makeService({ layers });
      expect(svc.resolve('summaries.enabled')).toEqual({ value: false, source: 'config' });
    });

    it('ranks managed below config', () => {
      const layers = makeLayers({ managed: { comment_format: 'minimal' }, cfg: { comment_format: 'plain' } });
      const svc = makeService({ layers });
      expect(svc.resolve('comment_format').source).toBe('config');
    });

    it('ranks env above every file layer', () => {
      // Uses an env-backed registry setting (yolo → PAIR_REVIEW_YOLO); the
      // provider/model settings no longer declare an envVar.
      process.env.PAIR_REVIEW_YOLO = 'true';
      const layers = makeLayers({ projectLocal: { yolo: false } });
      const svc = makeService({ layers });
      expect(svc.resolve('yolo')).toEqual({ value: true, source: 'env' });
    });

    it('ranks an in-app override above env and files', () => {
      process.env.PAIR_REVIEW_YOLO = 'true';
      new GlobalSettingsRepository(db).set('yolo', false);
      const layers = makeLayers({ cfg: { yolo: true } });
      const svc = makeService({ layers });
      expect(svc.resolve('yolo')).toEqual({ value: false, source: 'app' });
    });

    it('coerces env values for display by type', () => {
      process.env.PAIR_REVIEW_YOLO = 'true';
      const svc = makeService();
      expect(svc.resolve('yolo')).toEqual({ value: true, source: 'env' });
    });
  });

  describe('buildEffectiveConfig', () => {
    it('folds overrides in by dot-path and carries _globalOverrides', () => {
      const repo = new GlobalSettingsRepository(db);
      repo.set('comment_format', 'minimal');
      repo.set('summaries.enabled', true);
      repo.set('summaries.max_files', 10);
      const svc = makeService();
      const eff = svc.buildEffectiveConfig();
      expect(eff.comment_format).toBe('minimal');
      expect(eff.summaries.enabled).toBe(true);
      expect(eff.summaries.max_files).toBe(10);
      // Untouched nested sibling preserved.
      expect(eff.summaries.auto_generate).toBe(true);
      expect(eff._globalOverrides).toMatchObject({ comment_format: 'minimal', 'summaries.enabled': true, 'summaries.max_files': 10 });
    });

    it('does not mutate the base config', () => {
      new GlobalSettingsRepository(db).set('comment_format', 'minimal');
      const base = baseConfig();
      const svc = new GlobalSettingsService({ db, baseConfig: base, layers: makeLayers() });
      svc.buildEffectiveConfig();
      expect(base.comment_format).toBe('legacy');
    });

    it('ignores invalid or non-editable persisted rows', () => {
      const repo = new GlobalSettingsRepository(db);
      repo.set('summaries.max_files', -5);      // invalid (negative)
      repo.set('port', 9999);                    // non-editable
      repo.set('not.a.real.key', 'x');           // unknown
      const svc = makeService();
      const overrides = svc.getOverrides();
      expect(overrides).toEqual({});
      const eff = svc.buildEffectiveConfig();
      expect(eff.summaries.max_files).toBe(50);
    });
  });

  // The startup entry points (src/server.js, src/main.js, src/mcp-stdio.js) fold
  // this overlay into config BEFORE the consumers that latch a config value
  // (applyConfigOverrides → yoloMode, logger stream-debug, the dev_mode static
  // closure, and the MCP provider ladder). These tests lock the values those
  // reordered consumers must observe — a regression here means an in-app override
  // silently never takes effect even after the restart its badge promises.
  describe('overlay carries values that latching consumers read', () => {
    it('folds boolean advanced settings (yolo, dev_mode, debug_stream) onto the effective config', () => {
      const repo = new GlobalSettingsRepository(db);
      repo.set('yolo', true);
      repo.set('dev_mode', true);
      repo.set('debug_stream', true);
      const eff = makeService().buildEffectiveConfig();
      // These are exactly the fields applyConfigOverrides()/warnIfDevModeWithoutDbName()/
      // logger.setStreamDebugEnabled() read AFTER the overlay in the reordered startup.
      expect(eff.yolo).toBe(true);
      expect(eff.dev_mode).toBe(true);
      expect(eff.debug_stream).toBe(true);
    });

    it('lets the MCP single-provider ladder honor a default_provider/model in-app override', () => {
      // Regression for the mcp-stdio path: it used to hand createMCPServer a
      // plain loadConfig() result with no `_globalOverrides`, so start_analysis
      // ignored a /settings default_provider/default_model override. The overlay
      // populates `_globalOverrides`, which resolveSingleProviderModel ranks above
      // the config file.
      const repo = new GlobalSettingsRepository(db);
      repo.set('default_provider', 'codex');
      repo.set('default_model', 'gpt-5.1-codex');

      // Base file config points elsewhere; without the overlay this is what wins.
      const base = baseConfig({ default_provider: 'claude', default_model: 'opus' });
      const svc = new GlobalSettingsService({ db, baseConfig: base, layers: makeLayers() });

      // Pre-overlay (the old mcp-stdio bug): file defaults win, override ignored.
      const preOverlay = resolveSingleProviderModel({}, null, base);
      expect(preOverlay).toMatchObject({ provider: 'claude', model: 'opus' });

      // Post-overlay: the in-app override wins via `_globalOverrides`.
      const eff = svc.buildEffectiveConfig();
      const postOverlay = resolveSingleProviderModel({}, null, eff);
      expect(postOverlay).toMatchObject({ provider: 'codex', model: 'gpt-5.1-codex' });
    });
  });

  describe('describe', () => {
    it('masks sensitive values and reports configured', () => {
      const svc = makeService({ baseConfig: baseConfig({ github_token: 'ghp_secret' }) });
      const gh = svc.describe().find((d) => d.key === 'github_token');
      expect(gh.value).toBeNull();
      expect(gh.sensitive).toBe(true);
      expect(gh.configured).toBe(true);
    });

    it('reports github_token configured via the token command', () => {
      const svc = makeService({ baseConfig: baseConfig({ github_token: '', github_token_command: 'gh auth token' }) });
      const gh = svc.describe().find((d) => d.key === 'github_token');
      expect(gh.configured).toBe(true);
    });

    it('ships the full object for object read-onlys (not just a count)', () => {
      const svc = makeService({ baseConfig: baseConfig({ providers: { a: { model: 'x' }, b: {} } }) });
      const providers = svc.describe().find((d) => d.key === 'providers');
      expect(providers.value).toEqual({ a: { model: 'x' }, b: {} });
      expect(providers.editable).toBe(false);
    });

    it('redacts embedded secrets in object read-onlys before shipping', () => {
      const svc = makeService({
        baseConfig: baseConfig({
          providers: {
            custom: { command: 'my-cli', api_key: 'sk-live-123', nested: { token: 'ghp_zzz' } }
          },
          hooks: { 'pre-review': 'run --authorization deadbeef' }
        })
      });
      const described = svc.describe();
      const providers = described.find((d) => d.key === 'providers');
      // Secret-looking keys are masked; benign keys pass through intact.
      expect(providers.value.custom.command).toBe('my-cli');
      expect(providers.value.custom.api_key).toBe('***redacted***');
      expect(providers.value.custom.nested.token).toBe('***redacted***');
      // The raw secret must not appear anywhere in the serialized payload.
      expect(JSON.stringify(described)).not.toContain('sk-live-123');
      expect(JSON.stringify(described)).not.toContain('ghp_zzz');
    });

    it('renders an empty object read-only as {}', () => {
      const svc = makeService({ baseConfig: baseConfig({ providers: {} }) });
      const providers = svc.describe().find((d) => d.key === 'providers');
      expect(providers.value).toEqual({});
    });

    it('surfaces overrideValue only when an override is present', () => {
      new GlobalSettingsRepository(db).set('comment_format', 'minimal');
      const svc = makeService();
      const described = svc.describe();
      expect(described.find((d) => d.key === 'comment_format').overrideValue).toBe('minimal');
      expect(described.find((d) => d.key === 'default_model').overrideValue).toBeNull();
    });
  });

  describe('redactSecrets', () => {
    it('masks secret-looking keys at every depth, keeps benign keys', () => {
      const out = redactSecrets({
        command: 'cli',
        api_key: 'sk-1',
        apiKey: 'sk-2',
        client_secret: 's',
        password: 'p',
        github_token: 't',
        authorization: 'a',
        nested: { token: 'x', label: 'ok' }
      });
      expect(out.command).toBe('cli');
      expect(out.nested.label).toBe('ok');
      for (const k of ['api_key', 'apiKey', 'client_secret', 'password', 'github_token', 'authorization']) {
        expect(out[k]).toBe('***redacted***');
      }
      expect(out.nested.token).toBe('***redacted***');
    });

    it('walks arrays and passes primitives through', () => {
      expect(redactSecrets([{ token: 'x' }, { name: 'y' }])).toEqual([
        { token: '***redacted***' }, { name: 'y' }
      ]);
      expect(redactSecrets('plain')).toBe('plain');
      expect(redactSecrets(42)).toBe(42);
      expect(redactSecrets(null)).toBe(null);
    });
  });

  describe('setOverride / clearOverride', () => {
    it('rejects unknown, read-only, and invalid values', async () => {
      const svc = makeService();
      expect((await svc.setOverride('nope', 1)).status).toBe(400);
      expect((await svc.setOverride('port', 8080)).status).toBe(400);
      expect((await svc.setOverride('summaries.max_files', -1)).status).toBe(400);
      expect((await svc.setOverride('comment_format', 'neon')).status).toBe(400);
    });

    it('persists a valid override and returns fresh effective config + descriptor', async () => {
      const svc = makeService();
      const result = await svc.setOverride('comment_format', 'minimal');
      expect(result.ok).toBe(true);
      expect(result.setting.value).toBe('minimal');
      expect(result.setting.source).toBe('app');
      expect(result.effectiveConfig.comment_format).toBe('minimal');
      // Persisted.
      expect(new GlobalSettingsRepository(db).get('comment_format')).toBe('minimal');
    });

    it('clearOverride is idempotent and recomputes source', async () => {
      const svc = makeService({ layers: makeLayers({ cfg: { comment_format: 'plain' } }) });
      await svc.setOverride('comment_format', 'minimal');
      const cleared = await svc.clearOverride('comment_format');
      expect(cleared.ok).toBe(true);
      expect(cleared.setting.source).toBe('config');
      expect(cleared.setting.value).toBe('plain');
      // Clearing again still succeeds.
      const again = await svc.clearOverride('comment_format');
      expect(again.ok).toBe(true);
    });

    it('rejects clearing an unknown key', async () => {
      const svc = makeService();
      expect((await svc.clearOverride('does.not.exist')).status).toBe(400);
    });

    it('treats an empty string as a clear for string keys with non-empty defaults', async () => {
      // Consumers resolve default_model via || chains, so an '' override can
      // never actually win — storing it would show an "in-app" badge while
      // env/files still applied. setOverride must clear instead.
      const svc = makeService();
      await svc.setOverride('default_model', 'haiku');
      const result = await svc.setOverride('default_model', '');
      expect(result.ok).toBe(true);
      expect(result.setting.source).toBe('default');
      expect(new GlobalSettingsRepository(db).get('default_model')).toBeUndefined();
    });

    it('keeps an empty string as a real override for keys whose default is empty', async () => {
      // '' means "inherit" for provider/model sub-keys; it is a valid value.
      const svc = makeService({ layers: makeLayers({ cfg: { summaries: { provider: 'codex' } } }) });
      const result = await svc.setOverride('summaries.provider', '');
      expect(result.ok).toBe(true);
      expect(result.setting.source).toBe('app');
      expect(result.setting.value).toBe('');
      expect(new GlobalSettingsRepository(db).get('summaries.provider')).toBe('');
    });
  });

  describe('describe / describeSections (badges + sections payload)', () => {
    it('every descriptor carries badge (null default) and final:false', () => {
      const svc = makeService();
      const described = svc.describe();
      const cf = described.find((d) => d.key === 'comment_format');
      expect(cf.badge).toBeNull();
      expect(cf.final).toBe(false);
    });

    it('describeSections omits sections with zero visible settings', () => {
      // Hide the entire summaries group -> the summaries section must vanish.
      const svc = makeService({ baseConfig: baseConfig({ settings_ui: { hidden: ['summaries'] } }) });
      const sections = svc.describeSections();
      const ids = sections.map((s) => s.id);
      expect(ids).not.toContain('summaries');
      // Still includes populated sections, and carries the tours new badge.
      expect(ids).toContain('general');
      expect(sections.find((s) => s.id === 'tours').badge).toBe('new');
    });

    it('forwards the build-time hidden flag on the sections payload', () => {
      const sections = makeService().describeSections();
      // Summaries ships hidden by default (registry SECTIONS hidden:true); the
      // frontend renderer omits it. It still appears in the payload with the flag.
      const summaries = sections.find((s) => s.id === 'summaries');
      expect(summaries).toBeTruthy();
      expect(summaries.hidden).toBe(true);
      // Visible sections carry hidden:false.
      expect(sections.find((s) => s.id === 'general').hidden).toBe(false);
      expect(sections.find((s) => s.id === 'tours').hidden).toBe(false);
    });

    it('describeSections preserves registry order', () => {
      const svc = makeService();
      const ids = svc.describeSections().map((s) => s.id);
      const generalIdx = ids.indexOf('general');
      const readonlyIdx = ids.indexOf('readonly');
      expect(generalIdx).toBeLessThan(readonlyIdx);
    });
  });

  describe('config-driven hiding (settings_ui.hidden)', () => {
    it('omits an entry hidden by key', () => {
      const svc = makeService({ baseConfig: baseConfig({ settings_ui: { hidden: ['tours.model'] } }) });
      const keys = svc.describe().map((d) => d.key);
      expect(keys).not.toContain('tours.model');
      // Sibling in the same group still present.
      expect(keys).toContain('tours.enabled');
    });

    it('omits every entry in a hidden group', () => {
      const svc = makeService({ baseConfig: baseConfig({ settings_ui: { hidden: ['summaries'] } }) });
      const keys = svc.describe().map((d) => d.key);
      expect(keys.some((k) => k.startsWith('summaries'))).toBe(false);
    });

    it('rejects PUT and DELETE on a hidden key with 400', async () => {
      const svc = makeService({ baseConfig: baseConfig({ settings_ui: { hidden: ['comment_format'] } }) });
      const put = await svc.setOverride('comment_format', 'minimal');
      expect(put.status).toBe(400);
      expect(put.error).toMatch(/hidden by configuration/);
      const del = await svc.clearOverride('comment_format');
      expect(del.status).toBe(400);
      expect(del.error).toMatch(/hidden by configuration/);
    });

    it('logs and ignores an invalid settings_ui.hidden shape (nothing hidden)', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const svc = makeService({ baseConfig: baseConfig({ settings_ui: { hidden: 'summaries' } }) });
      expect(svc.describe().length).toBe(makeService().describe().length);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('config-driven locking (final)', () => {
    it('resolve on a final key skips the app override, using the highest file layer', () => {
      new GlobalSettingsRepository(db).set('default_model', 'app-model');
      const layers = makeLayers({ cfg: { final: ['default_model'], default_model: 'file-model' } });
      const svc = makeService({ layers });
      expect(svc.resolve('default_model')).toEqual({ value: 'file-model', source: 'config' });
    });

    it('resolve on a final env-backed key skips both the app and env tiers', () => {
      // yolo declares an envVar; finalizing it must defeat the env tier too.
      process.env.PAIR_REVIEW_YOLO = 'true';
      new GlobalSettingsRepository(db).set('yolo', true);
      const layers = makeLayers({ cfg: { final: ['yolo'], yolo: false } });
      const svc = makeService({ layers });
      expect(svc.resolve('yolo')).toEqual({ value: false, source: 'config' });
    });

    it('resolve on a final key with no file layer falls to the default', () => {
      const layers = makeLayers({ cfg: { final: ['default_model'] } });
      const svc = makeService({ layers });
      expect(svc.resolve('default_model')).toEqual({ value: 'opus', source: 'default' });
    });

    it('is a union across raw layers — a higher layer cannot un-final', () => {
      // Low layer finalizes; a higher layer declaring final:[] does NOT undo it.
      const layers = makeLayers({
        cfg: { final: ['default_model'], default_model: 'file-model' },
        projectLocal: { final: [] }
      });
      const svc = makeService({ layers });
      expect(svc.resolve('default_model').source).toBe('config');
      expect(svc.describe().find((d) => d.key === 'default_model').final).toBe(true);
    });

    it('does not apply a DB override for a final key and excludes it from _globalOverrides', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      new GlobalSettingsRepository(db).set('default_model', 'app-model');
      const layers = makeLayers({ cfg: { final: ['default_model'], default_model: 'file-model' } });
      const svc = makeService({ baseConfig: baseConfig({ default_model: 'file-model' }), layers });
      const eff = svc.buildEffectiveConfig();
      expect(eff.default_model).toBe('file-model');
      expect(eff._globalOverrides.default_model).toBeUndefined();
      expect(eff._finalKeys).toContain('default_model');
      // The row is ignored (warned) but NOT deleted.
      expect(warnSpy.mock.calls.some((c) => /locked as final/.test(c[0]))).toBe(true);
      expect(new GlobalSettingsRepository(db).get('default_model')).toBe('app-model');
    });

    it('_finalKeys expands a finalized section id to its member keys', () => {
      const layers = makeLayers({ cfg: { final: ['ai'] } });
      const svc = makeService({ layers });
      const finalKeys = svc.buildEffectiveConfig()._finalKeys;
      expect(finalKeys).toContain('default_provider');
      expect(finalKeys).toContain('default_model');
    });

    it('rejects PUT on a final key but ALLOWS DELETE (removing the ignored row)', async () => {
      new GlobalSettingsRepository(db).set('default_model', 'app-model');
      const layers = makeLayers({ cfg: { final: ['default_model'], default_model: 'file-model' } });
      const svc = makeService({ baseConfig: baseConfig({ default_model: 'file-model' }), layers });

      const put = await svc.setOverride('default_model', 'haiku');
      expect(put.status).toBe(400);
      expect(put.error).toMatch(/locked as final by configuration/);

      const del = await svc.clearOverride('default_model');
      expect(del.ok).toBe(true);
      expect(del.setting.final).toBe(true);
      expect(del.setting.source).toBe('config');
      expect(del.setting.value).toBe('file-model');
      // Row removed.
      expect(new GlobalSettingsRepository(db).get('default_model')).toBeUndefined();
    });

    it('logs and ignores an invalid per-layer final shape', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const layers = makeLayers({ cfg: { final: 'default_model' } });
      const svc = makeService({ layers });
      expect(svc.describe().find((d) => d.key === 'default_model').final).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
