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
