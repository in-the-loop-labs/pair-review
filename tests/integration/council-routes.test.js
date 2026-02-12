// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Integration tests for council API routes
 *
 * Tests the CRUD endpoints for managing Review Council configurations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase } from '../utils/schema';

const councilRoutes = require('../../src/routes/councils');

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
    { provider: 'gemini', model: 'pro', tier: 'balanced' }
  ],
  levels: { '1': true, '2': true, '3': false },
  consolidation: { provider: 'claude', model: 'opus', tier: 'balanced' }
};

describe('Council Routes', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
  });

  describe('POST /api/councils', () => {
    it('should create a council and return 201', async () => {
      const res = await request(app)
        .post('/api/councils')
        .send({ name: 'Test Council', config: sampleConfig });

      expect(res.status).toBe(201);
      expect(res.body.council).toBeDefined();
      expect(res.body.council.name).toBe('Test Council');
      expect(res.body.council.config).toEqual(sampleConfig);
      expect(res.body.council.id).toBeDefined();
    });

    it('should return 400 for missing name', async () => {
      const res = await request(app)
        .post('/api/councils')
        .send({ config: sampleConfig });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name');
    });

    it('should return 400 for missing config', async () => {
      const res = await request(app)
        .post('/api/councils')
        .send({ name: 'No Config' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('config');
    });

    it('should return 400 for invalid config', async () => {
      const res = await request(app)
        .post('/api/councils')
        .send({ name: 'Bad Config', config: { levels: 'not-object' } });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should trim the council name', async () => {
      const res = await request(app)
        .post('/api/councils')
        .send({ name: '  Padded Name  ', config: sampleConfig });

      expect(res.status).toBe(201);
      expect(res.body.council.name).toBe('Padded Name');
    });

    it('should persist the type field when set to council', async () => {
      const res = await request(app)
        .post('/api/councils')
        .send({ name: 'Voice-Centric', config: sampleCouncilConfig, type: 'council' });

      expect(res.status).toBe(201);
      expect(res.body.council.type).toBe('council');
    });

    it('should validate voice-centric config when type is council', async () => {
      const res = await request(app)
        .post('/api/councils')
        .send({ name: 'Council Type', config: sampleCouncilConfig, type: 'council' });

      expect(res.status).toBe(201);
      expect(res.body.council.config).toEqual(sampleCouncilConfig);
    });

    it('should reject advanced config format when type is council', async () => {
      // sampleConfig is advanced format (levels.X.enabled + levels.X.voices structure)
      // When type is 'council', the voice-centric validator should reject it
      const res = await request(app)
        .post('/api/councils')
        .send({ name: 'Mismatched', config: sampleConfig, type: 'council' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('voices');
    });

    it('should reject voice-centric config format when type is advanced', async () => {
      // sampleCouncilConfig is voice-centric format
      // When type is 'advanced', the advanced validator should reject it
      const res = await request(app)
        .post('/api/councils')
        .send({ name: 'Mismatched', config: sampleCouncilConfig, type: 'advanced' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should default type to advanced when not provided', async () => {
      const res = await request(app)
        .post('/api/councils')
        .send({ name: 'No Type', config: sampleConfig });

      expect(res.status).toBe(201);
      expect(res.body.council.type).toBe('advanced');
    });
  });

  describe('GET /api/councils', () => {
    it('should return empty array when no councils exist', async () => {
      const res = await request(app).get('/api/councils');

      expect(res.status).toBe(200);
      expect(res.body.councils).toEqual([]);
    });

    it('should return all councils', async () => {
      await request(app).post('/api/councils').send({ name: 'First', config: sampleConfig });
      await request(app).post('/api/councils').send({ name: 'Second', config: sampleConfig });

      const res = await request(app).get('/api/councils');
      expect(res.status).toBe(200);
      expect(res.body.councils).toHaveLength(2);
    });

    it('should include type in listed councils', async () => {
      await request(app).post('/api/councils').send({ name: 'VC', config: sampleCouncilConfig, type: 'council' });
      await request(app).post('/api/councils').send({ name: 'Adv', config: sampleConfig, type: 'advanced' });

      const res = await request(app).get('/api/councils');
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
      const res1 = await request(app).post('/api/councils').send({ name: 'Old', config: sampleConfig });
      const res2 = await request(app).post('/api/councils').send({ name: 'New', config: sampleConfig });
      const id1 = res1.body.council.id;
      const id2 = res2.body.council.id;

      // Touch the first council's last_used_at directly via DB
      const { CouncilRepository } = require('../../src/database');
      const councilRepo = new CouncilRepository(db);
      await councilRepo.touchLastUsedAt(id1);

      const res = await request(app).get('/api/councils');
      expect(res.status).toBe(200);
      expect(res.body.councils).toHaveLength(2);
      // id1 was touched (has last_used_at), should come first
      expect(res.body.councils[0].id).toBe(id1);
    });
  });

  describe('GET /api/councils/:id', () => {
    it('should return a specific council', async () => {
      const createRes = await request(app)
        .post('/api/councils')
        .send({ name: 'Specific', config: sampleConfig });
      const id = createRes.body.council.id;

      const res = await request(app).get(`/api/councils/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.council.id).toBe(id);
      expect(res.body.council.name).toBe('Specific');
    });

    it('should return 404 for non-existent council', async () => {
      const res = await request(app).get('/api/councils/does-not-exist');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/councils/:id', () => {
    it('should update a council name', async () => {
      const createRes = await request(app)
        .post('/api/councils')
        .send({ name: 'Original', config: sampleConfig });
      const id = createRes.body.council.id;

      const res = await request(app)
        .put(`/api/councils/${id}`)
        .send({ name: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.council.name).toBe('Updated');
    });

    it('should update a council config', async () => {
      const createRes = await request(app)
        .post('/api/councils')
        .send({ name: 'Config Update', config: sampleConfig });
      const id = createRes.body.council.id;

      const newConfig = {
        ...sampleConfig,
        levels: {
          ...sampleConfig.levels,
          '2': { enabled: true, voices: [{ provider: 'gemini', model: 'pro' }] }
        }
      };

      const res = await request(app)
        .put(`/api/councils/${id}`)
        .send({ config: newConfig });

      expect(res.status).toBe(200);
      expect(res.body.council.config.levels['2'].enabled).toBe(true);
    });

    it('should update a council type with compatible config provided', async () => {
      // Create with advanced-format config
      const createRes = await request(app)
        .post('/api/councils')
        .send({ name: 'Type Update', config: sampleConfig, type: 'advanced' });
      const id = createRes.body.council.id;

      // Switch to 'council' by providing BOTH the new type and a compatible config
      const res = await request(app)
        .put(`/api/councils/${id}`)
        .send({ type: 'council', config: sampleCouncilConfig });

      expect(res.status).toBe(200);
      expect(res.body.council.type).toBe('council');
      expect(res.body.council.config).toEqual(sampleCouncilConfig);
    });

    it('should reject type change without config when existing config is incompatible', async () => {
      // Create with advanced-format config
      const createRes = await request(app)
        .post('/api/councils')
        .send({ name: 'Incompatible Type Change', config: sampleConfig, type: 'advanced' });
      const id = createRes.body.council.id;

      // Try to change type to 'council' without providing a council-format config
      const res = await request(app)
        .put(`/api/councils/${id}`)
        .send({ type: 'council' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Existing config is incompatible');
      expect(res.body.error).toContain('council');
    });

    it('should reject type change in reverse direction when config is incompatible', async () => {
      // Create with council-format config
      const createRes = await request(app)
        .post('/api/councils')
        .send({ name: 'Reverse Incompatible', config: sampleCouncilConfig, type: 'council' });
      const id = createRes.body.council.id;

      // Try to change type to 'advanced' without providing an advanced-format config
      const res = await request(app)
        .put(`/api/councils/${id}`)
        .send({ type: 'advanced' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Existing config is incompatible');
      expect(res.body.error).toContain('advanced');
    });

    it('should skip cross-type validation when type is unchanged', async () => {
      // Create with advanced-format config
      const createRes = await request(app)
        .post('/api/councils')
        .send({ name: 'Same Type', config: sampleConfig, type: 'advanced' });
      const id = createRes.body.council.id;

      // Send a PUT with the same type — no cross-type validation should fire
      const res = await request(app)
        .put(`/api/councils/${id}`)
        .send({ type: 'advanced' });

      expect(res.status).toBe(200);
      expect(res.body.council.type).toBe('advanced');
    });

    it('should return 404 for non-existent council', async () => {
      const res = await request(app)
        .put('/api/councils/does-not-exist')
        .send({ name: 'New' });

      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid config update', async () => {
      const createRes = await request(app)
        .post('/api/councils')
        .send({ name: 'To Update', config: sampleConfig });
      const id = createRes.body.council.id;

      const res = await request(app)
        .put(`/api/councils/${id}`)
        .send({ config: { levels: 'invalid' } });

      expect(res.status).toBe(400);
    });

    it('should validate config against the existing type when type is not provided in update', async () => {
      // Create a council with type: 'council' and voice-centric config
      const createRes = await request(app)
        .post('/api/councils')
        .send({ name: 'Council Type', config: sampleCouncilConfig, type: 'council' });
      const id = createRes.body.council.id;

      // Update config only (no type) -- should validate against existing type 'council'
      const updatedConfig = {
        voices: [{ provider: 'gemini', model: 'flash', tier: 'fast' }],
        levels: { '1': true, '2': false, '3': false }
      };
      const res = await request(app)
        .put(`/api/councils/${id}`)
        .send({ config: updatedConfig });

      expect(res.status).toBe(200);
      expect(res.body.council.config).toEqual(updatedConfig);
    });

    it('should reject advanced config format when existing type is council', async () => {
      // Create a council with type: 'council'
      const createRes = await request(app)
        .post('/api/councils')
        .send({ name: 'Council Type', config: sampleCouncilConfig, type: 'council' });
      const id = createRes.body.council.id;

      // Try to update with advanced-format config (should fail because existing type is 'council')
      const res = await request(app)
        .put(`/api/councils/${id}`)
        .send({ config: sampleConfig });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('voices');
    });

    it('should use explicitly provided type for validation even when existing type differs', async () => {
      // Create a council with type: 'advanced'
      const createRes = await request(app)
        .post('/api/councils')
        .send({ name: 'Advanced', config: sampleConfig, type: 'advanced' });
      const id = createRes.body.council.id;

      // Update with type: 'council' and voice-centric config -- should validate against new type
      const res = await request(app)
        .put(`/api/councils/${id}`)
        .send({ config: sampleCouncilConfig, type: 'council' });

      expect(res.status).toBe(200);
      expect(res.body.council.type).toBe('council');
      expect(res.body.council.config).toEqual(sampleCouncilConfig);
    });
  });

  describe('DELETE /api/councils/:id', () => {
    it('should delete an existing council', async () => {
      const createRes = await request(app)
        .post('/api/councils')
        .send({ name: 'To Delete', config: sampleConfig });
      const id = createRes.body.council.id;

      const res = await request(app).delete(`/api/councils/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify it is gone
      const getRes = await request(app).get(`/api/councils/${id}`);
      expect(getRes.status).toBe(404);
    });

    it('should return 404 for non-existent council', async () => {
      const res = await request(app).delete('/api/councils/does-not-exist');
      expect(res.status).toBe(404);
    });
  });
});
