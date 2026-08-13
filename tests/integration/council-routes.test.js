// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for council API routes
 *
 * Tests the CRUD endpoints for managing Review Council configurations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const councilRoutes = require('../../src/routes/councils');
const { CouncilRepository } = require('../../src/database');
const { _resetForTests } = require('../../src/councils/council-store');

function createTestApp(db) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.use('/', councilRoutes);
  return app;
}

const sampleConfig = {
  levels: {
    '1': {
      enabled: true,
      voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }]
    },
    '2': { enabled: false, voices: [] },
    '3': { enabled: false, voices: [] }
  }
};

const sampleCouncilConfig = {
  voices: [
    { provider: 'claude', model: 'opus', tier: 'thorough' },
    { provider: 'antigravity', model: 'pro', tier: 'balanced' }
  ],
  levels: { '1': true, '2': true, '3': false },
  consolidation: { provider: 'claude', model: 'opus', tier: 'balanced' }
};

describe('Council Routes', () => {
  let db;
  let app;
  let server;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
    server = await listenOnLoopback(app);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  describe('POST /api/councils', () => {
    it('should create a council and return 201', async () => {
      const res = await request(server)
        .post('/api/councils')
        .send({ name: 'Test Council', config: sampleConfig });

      expect(res.status).toBe(201);
      expect(res.body.council).toBeDefined();
      expect(res.body.council.name).toBe('Test Council');
      expect(res.body.council.config).toEqual(sampleConfig);
      expect(res.body.council.id).toBeDefined();
    });

    it('should return 400 for missing name', async () => {
      const res = await request(server)
        .post('/api/councils')
        .send({ config: sampleConfig });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name');
    });

    it('should return 400 for missing config', async () => {
      const res = await request(server)
        .post('/api/councils')
        .send({ name: 'No Config' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('config');
    });

    it('should return 400 for invalid config', async () => {
      const res = await request(server)
        .post('/api/councils')
        .send({ name: 'Bad Config', config: { levels: 'not-object' } });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should trim the council name', async () => {
      const res = await request(server)
        .post('/api/councils')
        .send({ name: '  Padded Name  ', config: sampleConfig });

      expect(res.status).toBe(201);
      expect(res.body.council.name).toBe('Padded Name');
    });

    it('should persist the type field when set to council', async () => {
      const res = await request(server)
        .post('/api/councils')
        .send({ name: 'Voice-Centric', config: sampleCouncilConfig, type: 'council' });

      expect(res.status).toBe(201);
      expect(res.body.council.type).toBe('council');
    });

    it('should validate voice-centric config when type is council', async () => {
      const res = await request(server)
        .post('/api/councils')
        .send({ name: 'Council Type', config: sampleCouncilConfig, type: 'council' });

      expect(res.status).toBe(201);
      expect(res.body.council.config).toEqual(sampleCouncilConfig);
    });

    // Save must be no stricter than run: every runtime consumer normalizes
    // before validating, so an advanced-format config sent with type 'council'
    // is normalized (voices lifted out of the levels, levels coerced to
    // booleans) and accepted — the analyzer would have executed it happily.
    it('should normalize an advanced-format config when type is council', async () => {
      // sampleConfig is advanced format (levels.X.enabled + levels.X.voices structure)
      const res = await request(server)
        .post('/api/councils')
        .send({ name: 'Normalizable', config: sampleConfig, type: 'council' });

      expect(res.status).toBe(201);
      // Validated normalized, but STORED verbatim — the client's config is kept as-sent.
      expect(res.body.council.config).toEqual(sampleConfig);
    });

    it('should reject a config that is still invalid after normalization when type is council', async () => {
      // Advanced-shaped but every level disabled: normalization yields an empty
      // voices array, so the voice-centric validator still rejects it.
      const res = await request(server)
        .post('/api/councils')
        .send({
          name: 'Unnormalizable',
          config: {
            levels: {
              '1': { enabled: false, voices: [] },
              '2': { enabled: false, voices: [] }
            }
          },
          type: 'council'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('config.voices must be a non-empty array');
    });

    it('should reject voice-centric config format when type is advanced', async () => {
      // sampleCouncilConfig is voice-centric format
      // When type is 'advanced', the advanced validator should reject it
      const res = await request(server)
        .post('/api/councils')
        .send({ name: 'Mismatched', config: sampleCouncilConfig, type: 'advanced' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should default type to advanced when not provided', async () => {
      const res = await request(server)
        .post('/api/councils')
        .send({ name: 'No Type', config: sampleConfig });

      expect(res.status).toBe(201);
      expect(res.body.council.type).toBe('advanced');
    });
  });

  describe('GET /api/councils', () => {
    it('should return empty array when no councils exist', async () => {
      const res = await request(server).get('/api/councils');

      expect(res.status).toBe(200);
      expect(res.body.councils).toEqual([]);
    });

    it('should return all councils', async () => {
      await request(server).post('/api/councils').send({ name: 'First', config: sampleConfig });
      await request(server).post('/api/councils').send({ name: 'Second', config: sampleConfig });

      const res = await request(server).get('/api/councils');
      expect(res.status).toBe(200);
      expect(res.body.councils).toHaveLength(2);
    });

    it('should include type in listed councils', async () => {
      await request(server).post('/api/councils').send({ name: 'VC', config: sampleCouncilConfig, type: 'council' });
      await request(server).post('/api/councils').send({ name: 'Adv', config: sampleConfig, type: 'advanced' });

      const res = await request(server).get('/api/councils');
      expect(res.status).toBe(200);
      const vc = res.body.councils.find(c => c.name === 'VC');
      const adv = res.body.councils.find(c => c.name === 'Adv');
      expect(vc.type).toBe('council');
      expect(adv.type).toBe('advanced');
    });
  });

  describe('GET /api/councils (MRU ordering)', () => {
    it('should return councils in MRU order (most recently used first)', async () => {
      // Create two councils
      const res1 = await request(server).post('/api/councils').send({ name: 'Old', config: sampleConfig });
      const res2 = await request(server).post('/api/councils').send({ name: 'New', config: sampleConfig });
      const id1 = res1.body.council.id;
      const id2 = res2.body.council.id;

      // Touch the first council's last_used_at directly via DB
      const { CouncilRepository } = require('../../src/database');
      const councilRepo = new CouncilRepository(db);
      await councilRepo.touchLastUsedAt(id1);

      const res = await request(server).get('/api/councils');
      expect(res.status).toBe(200);
      expect(res.body.councils).toHaveLength(2);
      // id1 was touched (has last_used_at), should come first
      expect(res.body.councils[0].id).toBe(id1);
    });
  });

  describe('GET /api/councils/:id', () => {
    it('should return a specific council', async () => {
      const createRes = await request(server)
        .post('/api/councils')
        .send({ name: 'Specific', config: sampleConfig });
      const id = createRes.body.council.id;

      const res = await request(server).get(`/api/councils/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.council.id).toBe(id);
      expect(res.body.council.name).toBe('Specific');
    });

    it('should return 404 for non-existent council', async () => {
      const res = await request(server).get('/api/councils/does-not-exist');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/councils/:id', () => {
    it('should update a council name', async () => {
      const createRes = await request(server)
        .post('/api/councils')
        .send({ name: 'Original', config: sampleConfig });
      const id = createRes.body.council.id;

      const res = await request(server)
        .put(`/api/councils/${id}`)
        .send({ name: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.council.name).toBe('Updated');
    });

    it('should update a council config', async () => {
      const createRes = await request(server)
        .post('/api/councils')
        .send({ name: 'Config Update', config: sampleConfig });
      const id = createRes.body.council.id;

      const newConfig = {
        ...sampleConfig,
        levels: {
          ...sampleConfig.levels,
          '2': { enabled: true, voices: [{ provider: 'antigravity', model: 'pro' }] }
        }
      };

      const res = await request(server)
        .put(`/api/councils/${id}`)
        .send({ config: newConfig });

      expect(res.status).toBe(200);
      expect(res.body.council.config.levels['2'].enabled).toBe(true);
    });

    it('should update a council type with compatible config provided', async () => {
      // Create with advanced-format config
      const createRes = await request(server)
        .post('/api/councils')
        .send({ name: 'Type Update', config: sampleConfig, type: 'advanced' });
      const id = createRes.body.council.id;

      // Switch to 'council' by providing BOTH the new type and a compatible config
      const res = await request(server)
        .put(`/api/councils/${id}`)
        .send({ type: 'council', config: sampleCouncilConfig });

      expect(res.status).toBe(200);
      expect(res.body.council.type).toBe('council');
      expect(res.body.council.config).toEqual(sampleCouncilConfig);
    });

    // Regression: the type-change check used to validate the RAW stored config
    // against the new type's validator, so switching an advanced council to
    // type 'council' without sending a config failed on
    // 'config.voices must be a non-empty array' — even though normalization
    // derives voices from the level voices and the analyzer would run it.
    it('should accept a type change to council when the existing advanced config normalizes cleanly', async () => {
      // Create with advanced-format config
      const createRes = await request(server)
        .post('/api/councils')
        .send({ name: 'Normalizable Type Change', config: sampleConfig, type: 'advanced' });
      const id = createRes.body.council.id;

      // Change type to 'council' without providing a council-format config
      const res = await request(server)
        .put(`/api/councils/${id}`)
        .send({ type: 'council' });

      expect(res.status).toBe(200);
      expect(res.body.council.type).toBe('council');
      // Stored config is untouched — only the type changed.
      expect(res.body.council.config).toEqual(sampleConfig);
    });

    it('should reject type change without config when the existing config is invalid even normalized', async () => {
      // Persist a config the routes would never accept (legacy/hand-edited row):
      // advanced-shaped with every level disabled, so normalization to
      // voice-centric yields an empty voices array.
      const councilRepo = new CouncilRepository(db);
      const id = 'unnormalizable-council';
      await councilRepo.create({
        id,
        name: 'Unnormalizable Existing',
        type: 'advanced',
        config: { levels: { '1': { enabled: false, voices: [] } } }
      });

      const res = await request(server)
        .put(`/api/councils/${id}`)
        .send({ type: 'council' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Existing config is incompatible');
      expect(res.body.error).toContain('council');
    });

    it('should reject type change in reverse direction when config is incompatible', async () => {
      // Create with council-format config
      const createRes = await request(server)
        .post('/api/councils')
        .send({ name: 'Reverse Incompatible', config: sampleCouncilConfig, type: 'council' });
      const id = createRes.body.council.id;

      // Try to change type to 'advanced' without providing an advanced-format config
      const res = await request(server)
        .put(`/api/councils/${id}`)
        .send({ type: 'advanced' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Existing config is incompatible');
      expect(res.body.error).toContain('advanced');
    });

    it('should skip cross-type validation when type is unchanged', async () => {
      // Create with advanced-format config
      const createRes = await request(server)
        .post('/api/councils')
        .send({ name: 'Same Type', config: sampleConfig, type: 'advanced' });
      const id = createRes.body.council.id;

      // Send a PUT with the same type — no cross-type validation should fire
      const res = await request(server)
        .put(`/api/councils/${id}`)
        .send({ type: 'advanced' });

      expect(res.status).toBe(200);
      expect(res.body.council.type).toBe('advanced');
    });

    it('should return 404 for non-existent council', async () => {
      const res = await request(server)
        .put('/api/councils/does-not-exist')
        .send({ name: 'New' });

      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid config update', async () => {
      const createRes = await request(server)
        .post('/api/councils')
        .send({ name: 'To Update', config: sampleConfig });
      const id = createRes.body.council.id;

      const res = await request(server)
        .put(`/api/councils/${id}`)
        .send({ config: { levels: 'invalid' } });

      expect(res.status).toBe(400);
    });

    it('should validate config against the existing type when type is not provided in update', async () => {
      // Create a council with type: 'council' and voice-centric config
      const createRes = await request(server)
        .post('/api/councils')
        .send({ name: 'Council Type', config: sampleCouncilConfig, type: 'council' });
      const id = createRes.body.council.id;

      // Update config only (no type) -- should validate against existing type 'council'
      const updatedConfig = {
        voices: [{ provider: 'antigravity', model: 'flash', tier: 'fast' }],
        levels: { '1': true, '2': false, '3': false }
      };
      const res = await request(server)
        .put(`/api/councils/${id}`)
        .send({ config: updatedConfig });

      expect(res.status).toBe(200);
      expect(res.body.council.config).toEqual(updatedConfig);
    });

    it('should normalize an advanced config format update when existing type is council', async () => {
      // Create a council with type: 'council'
      const createRes = await request(server)
        .post('/api/councils')
        .send({ name: 'Council Type', config: sampleCouncilConfig, type: 'council' });
      const id = createRes.body.council.id;

      // Update with advanced-format config: validated against the existing type
      // 'council' AFTER normalization, so it is accepted and stored verbatim.
      const res = await request(server)
        .put(`/api/councils/${id}`)
        .send({ config: sampleConfig });

      expect(res.status).toBe(200);
      expect(res.body.council.config).toEqual(sampleConfig);
    });

    it('should reject a config update that is still invalid after normalization', async () => {
      const createRes = await request(server)
        .post('/api/councils')
        .send({ name: 'Council Type', config: sampleCouncilConfig, type: 'council' });
      const id = createRes.body.council.id;

      const res = await request(server)
        .put(`/api/councils/${id}`)
        .send({ config: { levels: { '1': { enabled: false, voices: [] } } } });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('config.voices must be a non-empty array');
    });

    it('should use explicitly provided type for validation even when existing type differs', async () => {
      // Create a council with type: 'advanced'
      const createRes = await request(server)
        .post('/api/councils')
        .send({ name: 'Advanced', config: sampleConfig, type: 'advanced' });
      const id = createRes.body.council.id;

      // Update with type: 'council' and voice-centric config -- should validate against new type
      const res = await request(server)
        .put(`/api/councils/${id}`)
        .send({ config: sampleCouncilConfig, type: 'council' });

      expect(res.status).toBe(200);
      expect(res.body.council.type).toBe('council');
      expect(res.body.council.config).toEqual(sampleCouncilConfig);
    });
  });

  describe('DELETE /api/councils/:id', () => {
    it('should delete an existing council', async () => {
      const createRes = await request(server)
        .post('/api/councils')
        .send({ name: 'To Delete', config: sampleConfig });
      const id = createRes.body.council.id;

      const res = await request(server).delete(`/api/councils/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify it is gone
      const getRes = await request(server).get(`/api/councils/${id}`);
      expect(getRes.status).toBe(404);
    });

    it('should return 404 for non-existent council', async () => {
      const res = await request(server).delete('/api/councils/does-not-exist');
      expect(res.status).toBe(404);
    });
  });

  // The read-only file overlay (`~/.pair-review/councils/*.json`) is served by
  // the same endpoints as DB councils, but the FILE owns those rows: PUT and
  // DELETE must refuse them. Vitest sets PAIR_REVIEW_NO_FILE_COUNCILS=1, so the
  // overlay is empty unless a test primes it via `_resetForTests(rows)`.
  describe('file council overlay', () => {
    const readOnlyError = (action) =>
      `This council is defined in a file and cannot be ${action} through the API. ` +
      'Change the file on disk instead.';

    /** A file-overlay row shaped exactly like `loadFileCouncils` returns. */
    function fileCouncilRow(stem, name, overrides = {}) {
      return {
        id: `file:${stem}`,
        name,
        type: 'advanced',
        config: sampleConfig,
        description: `${name} from a file`,
        last_used_at: null,
        created_at: null,
        updated_at: null,
        source: 'file',
        readOnly: true,
        filePath: `/councils/${stem}.council.json`,
        ...overrides
      };
    }

    beforeEach(() => {
      _resetForTests([
        fileCouncilRow('zed', 'Zed File'),
        fileCouncilRow('alpha', 'Alpha File')
      ]);
    });

    // Mandatory: the overlay cache is module-level and would otherwise leak into
    // every later test in this file (and every ordering assumption in them).
    afterEach(() => {
      _resetForTests();
    });

    it('GET /api/councils lists DB rows (source db) first, then file rows name-sorted', async () => {
      await request(server).post('/api/councils').send({ name: 'Saved', config: sampleConfig });

      const res = await request(server).get('/api/councils');
      expect(res.status).toBe(200);
      expect(res.body.councils).toHaveLength(3);

      const [dbRow, first, second] = res.body.councils;
      expect(dbRow.name).toBe('Saved');
      expect(dbRow.source).toBe('db');
      // DB rows carry no overlay fields.
      expect(dbRow.readOnly).toBeUndefined();
      expect(dbRow.filePath).toBeUndefined();

      // File rows are appended, sorted by name (Alpha before Zed) — they have no
      // MRU to order by.
      expect([first.id, second.id]).toEqual(['file:alpha', 'file:zed']);
      expect(first.source).toBe('file');
      expect(first.readOnly).toBe(true);
      expect(first.filePath).toBe('/councils/alpha.council.json');
      expect(first.description).toBe('Alpha File from a file');
    });

    it('GET /api/councils/:id returns a file council by its file: id', async () => {
      const res = await request(server).get('/api/councils/file:alpha');

      expect(res.status).toBe(200);
      expect(res.body.council.id).toBe('file:alpha');
      expect(res.body.council.name).toBe('Alpha File');
      expect(res.body.council.source).toBe('file');
      expect(res.body.council.readOnly).toBe(true);
      expect(res.body.council.config).toEqual(sampleConfig);
    });

    it('GET /api/councils/:id returns 404 for an unknown file: id', async () => {
      const res = await request(server).get('/api/councils/file:not-there');
      expect(res.status).toBe(404);
    });

    it('PUT /api/councils/:id refuses a file council with 403', async () => {
      const res = await request(server)
        .put('/api/councils/file:alpha')
        .send({ name: 'Renamed' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe(readOnlyError('updated'));
    });

    // The guard runs BEFORE any db work, so an unknown `file:` id is a 403
    // (read-only), never the 404 the repository lookup would produce.
    it('PUT /api/councils/:id refuses an unknown file: id with 403, not 404', async () => {
      const res = await request(server)
        .put('/api/councils/file:not-there')
        .send({ name: 'Renamed' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe(readOnlyError('updated'));
    });

    it('DELETE /api/councils/:id refuses a file council with 403', async () => {
      const res = await request(server).delete('/api/councils/file:alpha');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe(readOnlyError('deleted'));

      // Still listed afterwards — nothing was removed.
      const listRes = await request(server).get('/api/councils');
      expect(listRes.body.councils.map(c => c.id)).toContain('file:alpha');
    });

    it('DELETE /api/councils/:id refuses an unknown file: id with 403, not 404', async () => {
      const res = await request(server).delete('/api/councils/file:not-there');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe(readOnlyError('deleted'));
    });

    it('POST /api/councils still creates a DB council while the overlay is populated', async () => {
      const res = await request(server)
        .post('/api/councils')
        .send({ name: 'Alpha File', config: sampleConfig });

      // A name collision with a file council is not a conflict — the POST is the
      // "duplicate this file council into the DB" flow.
      expect(res.status).toBe(201);
      expect(res.body.council.name).toBe('Alpha File');
      expect(res.body.council.id).not.toMatch(/^file:/);

      const getRes = await request(server).get(`/api/councils/${res.body.council.id}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.council.source).toBe('db');
    });
  });
});
