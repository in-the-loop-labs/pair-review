// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const bulkAnalysisConfigsRoutes = require('../../src/routes/bulk-analysis-configs');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '200kb' }));
  app.use('/', bulkAnalysisConfigsRoutes);
  return app;
}

describe('bulk analysis config routes', () => {
  let app;

  beforeEach(() => {
    bulkAnalysisConfigsRoutes._resetBulkAnalysisConfigs();
    app = createApp();
  });

  it('stores and retrieves a bulk analysis config by id', async () => {
    const analysisConfig = {
      provider: 'claude',
      model: 'opus',
      customInstructions: 'Focus on error handling.',
      enabledLevels: [1, 2],
      excludePrevious: { github: true, feedback: false }
    };

    const createResponse = await request(app)
      .post('/api/bulk-analysis-configs')
      .send({ analysisConfig })
      .expect(200);

    expect(createResponse.body.success).toBe(true);
    expect(createResponse.body.id).toMatch(/^[0-9a-f-]{36}$/);

    const getResponse = await request(app)
      .get(`/api/bulk-analysis-configs/${createResponse.body.id}`)
      .expect(200);

    expect(getResponse.body.success).toBe(true);
    expect(getResponse.body.analysisConfig).toMatchObject(analysisConfig);
    expect(getResponse.body.analysisConfig.skipLevel3).toBe(false);
    expect(getResponse.body.analysisConfig.noLevels).toBe(false);
  });

  it('rejects missing or non-object configs', async () => {
    await request(app)
      .post('/api/bulk-analysis-configs')
      .send({})
      .expect(400);

    await request(app)
      .post('/api/bulk-analysis-configs')
      .send({ analysisConfig: [] })
      .expect(400);
  });

  it('allows shared tier aliases accepted by regular analysis routes', async () => {
    const response = await request(app)
      .post('/api/bulk-analysis-configs')
      .send({ analysisConfig: { provider: 'claude', model: 'haiku', tier: 'free' } })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(bulkAnalysisConfigsRoutes._getBulkAnalysisConfig(response.body.id)).toMatchObject({
      provider: 'claude',
      model: 'haiku',
      tier: 'free'
    });
  });

  it('rejects invalid single-model configs', async () => {
    const response = await request(app)
      .post('/api/bulk-analysis-configs')
      .send({ analysisConfig: { provider: 'claude', model: 'opus', tier: 'slow' } })
      .expect(400);

    expect(response.body.error).toContain('tier');
  });

  it('rejects forbidden prototype-pollution keys', async () => {
    const response = await request(app)
      .post('/api/bulk-analysis-configs')
      .set('Content-Type', 'application/json')
      .send('{"analysisConfig":{"provider":"claude","model":"opus","__proto__":{"polluted":true}}}')
      .expect(400);

    expect(response.body.error).toContain('forbidden key __proto__');
  });

  it('returns 404 for unknown config ids', async () => {
    await request(app)
      .get('/api/bulk-analysis-configs/00000000-0000-0000-0000-000000000000')
      .expect(404);
  });

  it('prunes expired configs before lookups', async () => {
    const createResponse = await request(app)
      .post('/api/bulk-analysis-configs')
      .send({ analysisConfig: { provider: 'claude', model: 'opus' } })
      .expect(200);

    bulkAnalysisConfigsRoutes._pruneExpired(Date.now() + bulkAnalysisConfigsRoutes._CONFIG_TTL_MS + 1);

    await request(app)
      .get(`/api/bulk-analysis-configs/${createResponse.body.id}`)
      .expect(404);
  });
});
