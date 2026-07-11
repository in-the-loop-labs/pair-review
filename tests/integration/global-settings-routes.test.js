// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for the global settings routes (src/routes/settings.js).
 *
 * Follows tests/CONVENTIONS.md: supertest targets a listening loopback server
 * (request(server), never request(app)); the DB comes from the shared test
 * schema; no fixed paths, no real network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const settingsRoutes = require('../../src/routes/settings');
const { GlobalSettingsService } = require('../../src/settings/global-settings-service');
const { GlobalSettingsRepository } = require('../../src/database');
const { createTestDatabase, closeTestDatabase } = require('../utils/schema');

function baseConfig(overrides = {}) {
  return {
    theme: 'light',
    default_provider: 'claude',
    default_model: 'opus',
    summaries: { enabled: false, auto_generate: true, max_files: 50 },
    github_token: '',
    github_token_command: '',
    providers: {},
    repos: {},
    // Restart-required keys, present so the boot snapshot in settings.js can
    // capture them (their consumers latch at launch and are never recomputed).
    dev_mode: false,
    worktree_retention_days: 7,
    external_comments: false,
    ...overrides
  };
}

function makeLayers(overrides = {}) {
  return [
    { name: 'default', data: { theme: 'light' } },
    { name: 'config', data: overrides.cfg || {} },
    { name: 'project.local', data: overrides.projectLocal || {} }
  ];
}

describe('global settings routes', () => {
  let db;
  let app;
  let server;

  beforeEach(async () => {
    db = createTestDatabase();
    const config = baseConfig();
    const service = new GlobalSettingsService({ db, baseConfig: config, layers: makeLayers() });
    Object.assign(config, service.buildEffectiveConfig());

    app = express();
    app.use(express.json({ limit: '200kb' }));
    app.set('db', db);
    app.set('config', config);
    app.set('globalSettings', service);
    // Probe route: reveals the live config object so tests can prove that a
    // write re-set app.get('config').
    app.get('/__config', (req, res) => res.json(req.app.get('config')));
    app.use('/', settingsRoutes);
    server = await listenOnLoopback(app);
  });

  afterEach(async () => {
    await closeServer(server);
    closeTestDatabase(db);
  });

  describe('GET /api/settings', () => {
    it('returns a descriptor for every registry entry with source badges', async () => {
      const res = await request(server).get('/api/settings').expect(200);
      expect(Array.isArray(res.body.settings)).toBe(true);
      expect(res.body.settings.length).toBeGreaterThan(0);
      const theme = res.body.settings.find((s) => s.key === 'theme');
      expect(theme).toMatchObject({ key: 'theme', type: 'enum', source: 'default', editable: true });
      expect(theme.values).toContain('dark');
      const gh = res.body.settings.find((s) => s.key === 'github_token');
      expect(gh.value).toBeNull();
      expect(gh.sensitive).toBe(true);
    });
  });

  describe('PUT /api/settings/:key', () => {
    it('sets a valid override, persists it, and re-sets the live config', async () => {
      const res = await request(server)
        .put('/api/settings/theme')
        .send({ value: 'dark' })
        .expect(200);
      expect(res.body.setting).toMatchObject({ key: 'theme', value: 'dark', source: 'app' });

      // Persisted across a fresh GET.
      const list = await request(server).get('/api/settings').expect(200);
      expect(list.body.settings.find((s) => s.key === 'theme').value).toBe('dark');

      // The live config object the app serves now reflects the override.
      const live = await request(server).get('/__config').expect(200);
      expect(live.body.theme).toBe('dark');
    });

    it('folds a nested override into the live config', async () => {
      await request(server)
        .put('/api/settings/summaries.max_files')
        .send({ value: 10 })
        .expect(200);
      const live = await request(server).get('/__config').expect(200);
      expect(live.body.summaries.max_files).toBe(10);
      expect(live.body.summaries.auto_generate).toBe(true);
    });

    it('rejects a missing value field', async () => {
      await request(server).put('/api/settings/theme').send({}).expect(400);
    });

    it('rejects an unknown key', async () => {
      await request(server).put('/api/settings/nope').send({ value: 1 }).expect(400);
    });

    it('rejects a read-only key', async () => {
      await request(server).put('/api/settings/port').send({ value: 8080 }).expect(400);
    });

    it('rejects an invalid enum/type value', async () => {
      await request(server).put('/api/settings/theme').send({ value: 'neon' }).expect(400);
      await request(server).put('/api/settings/summaries.max_files').send({ value: -1 }).expect(400);
    });
  });

  describe('DELETE /api/settings/:key', () => {
    it('clears an override and recomputes the source', async () => {
      await request(server).put('/api/settings/theme').send({ value: 'dark' }).expect(200);
      const del = await request(server).delete('/api/settings/theme').expect(200);
      expect(del.body.setting.source).toBe('default');
      expect(del.body.setting.value).toBe('light');

      const live = await request(server).get('/__config').expect(200);
      expect(live.body.theme).toBe('light');
    });

    it('is idempotent when no override exists', async () => {
      const del = await request(server).delete('/api/settings/default_model').expect(200);
      expect(del.body.setting.key).toBe('default_model');
    });

    it('rejects an unknown key', async () => {
      await request(server).delete('/api/settings/nope').expect(400);
    });
  });

  describe('GET /api/settings/repos', () => {
    beforeEach(() => {
      // A configured repo (has a user-facing setting).
      db.prepare(
        `INSERT INTO repo_settings (repository, default_provider) VALUES ('acme/configured', 'codex')`
      ).run();
      // A "known" repo — only a local_path, no user-facing settings.
      db.prepare(
        `INSERT INTO repo_settings (repository, local_path) VALUES ('acme/known', '/tmp/known')`
      ).run();
      // A bare pool-lease row (no local_path, no settings) — must NOT appear.
      db.prepare(
        `INSERT INTO repo_settings (repository, pool_fetch_started_at) VALUES ('acme/lease', '2020-01-01')`
      ).run();
      // A branch-review-only repo: the user saved ONLY the auto_branch_review
      // preference ("always" = 1), no other settings and no local_path.
      db.prepare(
        `INSERT INTO repo_settings (repository, auto_branch_review) VALUES ('acme/branchonly', 1)`
      ).run();
      // A row holding ONLY the auto_branch_review default (0 = "ask"): the default
      // is not a deliberate choice, so with no local_path this must NOT appear.
      db.prepare(
        `INSERT INTO repo_settings (repository, auto_branch_review) VALUES ('acme/defaultbranch', 0)`
      ).run();
    });

    it('unions DB and file-config repos and flags each correctly', async () => {
      // Add a file-config repo and one that overlaps a DB row.
      const config = app.get('config');
      config.repos = { 'acme/filerepo': { path: '~/x' }, 'acme/configured': { path: '~/y' } };

      const res = await request(server).get('/api/settings/repos').expect(200);
      const byRepo = Object.fromEntries(res.body.repos.map((r) => [r.repository, r]));

      expect(byRepo['acme/configured']).toMatchObject({ hasDbSettings: true, hasFileConfig: true });
      expect(byRepo['acme/known']).toMatchObject({ hasDbSettings: false, hasFileConfig: false, localPath: '/tmp/known' });
      expect(byRepo['acme/filerepo']).toMatchObject({ hasDbSettings: false, hasFileConfig: true });
      // The bare lease row is excluded.
      expect(byRepo['acme/lease']).toBeUndefined();
      // Sorted by repository.
      const names = res.body.repos.map((r) => r.repository);
      expect(names).toEqual([...names].sort());
    });

    it('keeps a branch-review-only repo but drops a repo holding only the auto_branch_review default', async () => {
      const res = await request(server).get('/api/settings/repos').expect(200);
      const byRepo = Object.fromEntries(res.body.repos.map((r) => [r.repository, r]));
      // Regression: auto_branch_review was omitted from the SELECT, so a repo
      // configured solely via the branch-review preference was dropped.
      expect(byRepo['acme/branchonly']).toMatchObject({ hasDbSettings: true, hasFileConfig: false });
      // The default (0) is indistinguishable from unset, so it doesn't configure.
      expect(byRepo['acme/defaultbranch']).toBeUndefined();
    });
  });

  describe('GET /api/settings — Phase 2 payload shape', () => {
    it('returns a sections array (ordered, tours "new" badge, summaries hidden flag) plus badge/final on each descriptor', async () => {
      const res = await request(server).get('/api/settings').expect(200);
      expect(Array.isArray(res.body.sections)).toBe(true);
      const sectionIds = res.body.sections.map((s) => s.id);
      // General precedes readonly; tours carries the "new" badge.
      expect(sectionIds.indexOf('general')).toBeLessThan(sectionIds.indexOf('readonly'));
      expect(res.body.sections.find((s) => s.id === 'tours').badge).toBe('new');
      // Summaries ships with the build-time hidden flag (the frontend omits it).
      expect(res.body.sections.find((s) => s.id === 'summaries').hidden).toBe(true);
      expect(res.body.sections.find((s) => s.id === 'general').hidden).toBe(false);
      // Every described setting gains badge + final.
      const theme = res.body.settings.find((s) => s.key === 'theme');
      expect(theme).toHaveProperty('badge', null);
      expect(theme).toHaveProperty('final', false);
    });
  });
});

// Phase 2 hidden/final behaviors need bespoke config + layers, so each test
// spins up its own loopback server (the shared beforeEach uses a fixed config).
describe('global settings routes — hidden & final', () => {
  const dbs = [];
  const servers = [];

  async function startServer({ config = baseConfig(), layers } = {}) {
    const db = createTestDatabase();
    dbs.push(db);
    const service = new GlobalSettingsService({ db, baseConfig: config, layers: layers || makeLayers() });
    const liveConfig = { ...config };
    Object.assign(liveConfig, service.buildEffectiveConfig());

    const app = express();
    app.use(express.json({ limit: '200kb' }));
    app.set('db', db);
    app.set('config', liveConfig);
    app.set('globalSettings', service);
    app.get('/__config', (req, res) => res.json(req.app.get('config')));
    app.use('/', settingsRoutes);
    const server = await listenOnLoopback(app);
    servers.push(server);
    return { db, server, service };
  }

  afterEach(async () => {
    for (const s of servers.splice(0)) await closeServer(s);
    for (const d of dbs.splice(0)) closeTestDatabase(d);
  });

  describe('settings_ui.hidden', () => {
    it('omits hidden entries and their (now-empty) section, and 400s on PUT and DELETE', async () => {
      const { server } = await startServer({
        config: baseConfig({ settings_ui: { hidden: ['summaries', 'theme'] } })
      });

      const res = await request(server).get('/api/settings').expect(200);
      const keys = res.body.settings.map((s) => s.key);
      expect(keys).not.toContain('theme');
      expect(keys.some((k) => k.startsWith('summaries'))).toBe(false);
      expect(res.body.sections.map((s) => s.id)).not.toContain('summaries');

      const put = await request(server).put('/api/settings/theme').send({ value: 'dark' }).expect(400);
      expect(put.body.error).toMatch(/hidden by configuration/);
      const del = await request(server).delete('/api/settings/theme').expect(400);
      expect(del.body.error).toMatch(/hidden by configuration/);
    });
  });

  describe('final', () => {
    it('resolves a finalized key from the file layer, 400s on PUT, and re-sets live config with _finalKeys', async () => {
      const { db, server } = await startServer({
        config: baseConfig({ default_model: 'file-model' }),
        layers: [
          { name: 'default', data: { theme: 'light' } },
          { name: 'config', data: { final: ['default_model'], default_model: 'file-model' } }
        ]
      });
      // A pre-existing DB row for the finalized key must be ignored, not applied.
      new GlobalSettingsRepository(db).set('default_model', 'app-model');

      const res = await request(server).get('/api/settings').expect(200);
      const dm = res.body.settings.find((s) => s.key === 'default_model');
      expect(dm).toMatchObject({ final: true, source: 'config', value: 'file-model' });
      expect(dm.overrideValue).toBeNull();

      // Live config folds the file value, carries _finalKeys, and omits the override.
      const live = await request(server).get('/__config').expect(200);
      expect(live.body.default_model).toBe('file-model');
      expect(live.body._finalKeys).toContain('default_model');
      expect(live.body._globalOverrides.default_model).toBeUndefined();

      const put = await request(server).put('/api/settings/default_model').send({ value: 'haiku' }).expect(400);
      expect(put.body.error).toMatch(/locked as final by configuration/);
    });

    it('ALLOWS DELETE on a finalized key (removes the ignored row) and returns final:true', async () => {
      const { db, server } = await startServer({
        config: baseConfig({ default_model: 'file-model' }),
        layers: [
          { name: 'default', data: { theme: 'light' } },
          { name: 'config', data: { final: ['default_model'], default_model: 'file-model' } }
        ]
      });
      new GlobalSettingsRepository(db).set('default_model', 'app-model');

      const del = await request(server).delete('/api/settings/default_model').expect(200);
      expect(del.body.setting).toMatchObject({ final: true, source: 'config', value: 'file-model' });
      // The ignored DB row is now gone.
      expect(new GlobalSettingsRepository(db).get('default_model')).toBeUndefined();
    });
  });
});

// Restart-required keys (route mounting, middleware, static cache, retention
// sweeps) latch at process startup. A post-boot write must persist the override
// and advertise "restart required", but the LIVE app config must keep the boot
// value — advertising the new value while behavior is unchanged is a lie. Each
// test boots its own server (seeding a pre-existing override where the scenario
// requires the running process to have latched it at launch).
describe('global settings routes — restart-required keys', () => {
  let db;
  let app;
  let server;

  async function boot({ seedOverrides = {}, config = baseConfig() } = {}) {
    db = createTestDatabase();
    const repo = new GlobalSettingsRepository(db);
    for (const [k, v] of Object.entries(seedOverrides)) repo.set(k, v);
    const service = new GlobalSettingsService({ db, baseConfig: config, layers: makeLayers() });
    const liveConfig = { ...config };
    Object.assign(liveConfig, service.buildEffectiveConfig());

    app = express();
    app.use(express.json({ limit: '200kb' }));
    app.set('db', db);
    app.set('config', liveConfig);
    app.set('globalSettings', service);
    app.get('/__config', (req, res) => res.json(req.app.get('config')));
    app.use('/', settingsRoutes);
    server = await listenOnLoopback(app);
  }

  afterEach(async () => {
    await closeServer(server);
    closeTestDatabase(db);
  });

  it('persists + flags a restart-required write but never folds it into the live config', async () => {
    await boot();
    const res = await request(server)
      .put('/api/settings/dev_mode')
      .send({ value: true })
      .expect(200);
    // Descriptor shows the NEW value and the restart flag...
    expect(res.body.setting).toMatchObject({
      key: 'dev_mode', value: true, source: 'app', restartRequired: true
    });
    // ...but the running server's config keeps the boot value.
    const live = await request(server).get('/__config').expect(200);
    expect(live.body.dev_mode).toBe(false);
    // The override is persisted and shown as the new value on a fresh GET.
    const list = await request(server).get('/api/settings').expect(200);
    expect(list.body.settings.find((s) => s.key === 'dev_mode').value).toBe(true);
  });

  it('a later DYNAMIC write does not re-fold a pending restart-required override into live config', async () => {
    await boot();
    await request(server).put('/api/settings/dev_mode').send({ value: true }).expect(200);
    await request(server).put('/api/settings/worktree_retention_days').send({ value: 30 }).expect(200);
    // Now write a DYNAMIC key — buildEffectiveConfig re-folds ALL overrides.
    await request(server).put('/api/settings/theme').send({ value: 'dark' }).expect(200);

    const live = await request(server).get('/__config').expect(200);
    expect(live.body.theme).toBe('dark');                 // dynamic write applied
    expect(live.body.dev_mode).toBe(false);               // restart-required boot value STILL live
    expect(live.body.worktree_retention_days).toBe(7);    // ...for every restart-required key
  });

  it('DELETE of a boot-latched restart-required override keeps the boot value live until restart', async () => {
    // Booted WITH the override, so the running process latched dev_mode=true.
    await boot({ seedOverrides: { dev_mode: true } });
    const before = await request(server).get('/__config').expect(200);
    expect(before.body.dev_mode).toBe(true);

    const del = await request(server).delete('/api/settings/dev_mode').expect(200);
    // Descriptor recomputes to the default (override cleared) with the restart flag.
    expect(del.body.setting).toMatchObject({ value: false, source: 'default', restartRequired: true });

    // Live config keeps the boot value — the process is still running with it.
    const after = await request(server).get('/__config').expect(200);
    expect(after.body.dev_mode).toBe(true);
  });
});
