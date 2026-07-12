// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for chat snippet API routes
 *
 * Tests the CRUD + touch endpoints backing the chat prompt snippets library.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const snippetsRoutes = require('../../src/routes/snippets');

function createTestApp(db) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.use('/', snippetsRoutes);
  return app;
}

describe('Snippet Routes', () => {
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
    closeTestDatabase(db);
  });

  async function createSnippet(body) {
    const res = await request(server).post('/api/snippets').send({ body });
    return res.body.snippet;
  }

  describe('POST /api/snippets', () => {
    it('should create a snippet and return 201', async () => {
      const res = await request(server)
        .post('/api/snippets')
        .send({ body: 'Check for edge cases' });

      expect(res.status).toBe(201);
      expect(res.body.snippet).toBeDefined();
      expect(res.body.snippet.id).toBeDefined();
      expect(res.body.snippet.body).toBe('Check for edge cases');
    });

    it('should return 400 for a missing body', async () => {
      const res = await request(server).post('/api/snippets').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('body');
    });

    it('should return 400 for an empty body', async () => {
      const res = await request(server).post('/api/snippets').send({ body: '   ' });
      expect(res.status).toBe(400);
    });

    it('should return 400 for a non-string body', async () => {
      const res = await request(server).post('/api/snippets').send({ body: 42 });
      expect(res.status).toBe(400);
    });

    it('should return 400 for a body over 10000 characters', async () => {
      const res = await request(server)
        .post('/api/snippets')
        .send({ body: 'x'.repeat(10001) });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/snippets', () => {
    it('should return an empty array when no snippets exist', async () => {
      const res = await request(server).get('/api/snippets');
      expect(res.status).toBe(200);
      expect(res.body.snippets).toEqual([]);
    });

    it('should return all snippets', async () => {
      await createSnippet('First');
      await createSnippet('Second');

      const res = await request(server).get('/api/snippets');
      expect(res.status).toBe(200);
      expect(res.body.snippets).toHaveLength(2);
    });

    it('should reflect MRU order after a touch', async () => {
      const first = await createSnippet('First');
      await createSnippet('Second');

      // Touch the first snippet — it should jump to the front
      const touchRes = await request(server).post(`/api/snippets/${first.id}/touch`);
      expect(touchRes.status).toBe(200);

      const res = await request(server).get('/api/snippets');
      expect(res.status).toBe(200);
      expect(res.body.snippets[0].id).toBe(first.id);
    });
  });

  describe('PUT /api/snippets/:id', () => {
    it('should update a snippet body', async () => {
      const snippet = await createSnippet('Original');

      const res = await request(server)
        .put(`/api/snippets/${snippet.id}`)
        .send({ body: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.snippet.body).toBe('Updated');
    });

    it('should return 400 for an invalid body', async () => {
      const snippet = await createSnippet('Original');
      const res = await request(server)
        .put(`/api/snippets/${snippet.id}`)
        .send({ body: '' });
      expect(res.status).toBe(400);
    });

    it('should return 400 for a non-numeric id', async () => {
      const res = await request(server)
        .put('/api/snippets/not-a-number')
        .send({ body: 'Updated' });
      expect(res.status).toBe(400);
    });

    it('should return 404 for a non-existent snippet', async () => {
      const res = await request(server)
        .put('/api/snippets/99999')
        .send({ body: 'Updated' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/snippets/:id', () => {
    it('should delete an existing snippet', async () => {
      const snippet = await createSnippet('Delete me');

      const res = await request(server).delete(`/api/snippets/${snippet.id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const getRes = await request(server).get('/api/snippets');
      expect(getRes.body.snippets).toHaveLength(0);
    });

    it('should return 400 for a non-numeric id', async () => {
      const res = await request(server).delete('/api/snippets/not-a-number');
      expect(res.status).toBe(400);
    });

    it('should return 404 for a non-existent snippet', async () => {
      const res = await request(server).delete('/api/snippets/99999');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/snippets/:id/touch', () => {
    it('should touch an existing snippet and return success', async () => {
      const snippet = await createSnippet('Touch me');

      const res = await request(server).post(`/api/snippets/${snippet.id}/touch`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 400 for a non-numeric id', async () => {
      const res = await request(server).post('/api/snippets/not-a-number/touch');
      expect(res.status).toBe(400);
    });

    it('should return 404 for a non-existent snippet', async () => {
      const res = await request(server).post('/api/snippets/99999/touch');
      expect(res.status).toBe(404);
    });
  });
});
