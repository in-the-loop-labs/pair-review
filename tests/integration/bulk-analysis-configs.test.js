// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const bulkAnalysisConfigsRoutes = require('../../src/routes/bulk-analysis-configs');
const { getAllProvidersInfo } = require('../../src/ai');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '200kb' }));
  app.use('/', bulkAnalysisConfigsRoutes);
  return app;
}

describe('bulk analysis config routes', () => {
  let app;
  let server;

  beforeEach(async () => {
    bulkAnalysisConfigsRoutes._resetBulkAnalysisConfigs();
    app = createApp();
    server = await listenOnLoopback(app);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('stores and retrieves a bulk analysis config by id', async () => {
    const analysisConfig = {
      provider: 'claude',
      model: 'opus',
      customInstructions: 'Focus on error handling.',
      enabledLevels: [1, 2],
      excludePrevious: { github: true, feedback: false }
    };

    const createResponse = await request(server)
      .post('/api/bulk-analysis-configs')
      .send({ analysisConfig })
      .expect(200);

    expect(createResponse.body.success).toBe(true);
    expect(createResponse.body.id).toMatch(/^[0-9a-f-]{36}$/);

    const getResponse = await request(server)
      .get(`/api/bulk-analysis-configs/${createResponse.body.id}`)
      .expect(200);

    expect(getResponse.body.success).toBe(true);
    expect(getResponse.body.analysisConfig).toMatchObject(analysisConfig);
    expect(getResponse.body.analysisConfig.skipLevel3).toBe(false);
    expect(getResponse.body.analysisConfig.noLevels).toBe(false);
  });

  it('rejects missing or non-object configs', async () => {
    await request(server)
      .post('/api/bulk-analysis-configs')
      .send({})
      .expect(400);

    await request(server)
      .post('/api/bulk-analysis-configs')
      .send({ analysisConfig: [] })
      .expect(400);
  });

  it('allows shared tier aliases accepted by regular analysis routes', async () => {
    const response = await request(server)
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

  it('stores the effective prompt (presets + textarea), not just the raw textarea', async () => {
    // The modal sends `instructions` (effective: presets concatenated with the
    // textarea) alongside the raw `customInstructions`. The effective prompt must
    // win so preset chips are not silently dropped.
    const response = await request(server)
      .post('/api/bulk-analysis-configs')
      .send({
        analysisConfig: {
          provider: 'claude',
          model: 'opus',
          instructions: 'Focus on security vulnerabilities.\n\nAlso check error handling.',
          customInstructions: 'Also check error handling.'
        }
      })
      .expect(200);

    expect(bulkAnalysisConfigsRoutes._getBulkAnalysisConfig(response.body.id).customInstructions)
      .toBe('Focus on security vulnerabilities.\n\nAlso check error handling.');
  });

  it('falls back to customInstructions when no effective instructions are sent', async () => {
    const response = await request(server)
      .post('/api/bulk-analysis-configs')
      .send({
        analysisConfig: { provider: 'claude', model: 'opus', customInstructions: 'Only textarea.' }
      })
      .expect(200);

    expect(bulkAnalysisConfigsRoutes._getBulkAnalysisConfig(response.body.id).customInstructions)
      .toBe('Only textarea.');
  });

  it('rejects an invalid configType instead of coercing it to advanced', async () => {
    const response = await request(server)
      .post('/api/bulk-analysis-configs')
      .send({
        analysisConfig: {
          isCouncil: true,
          configType: 'counsel',
          councilId: 'abc123'
        }
      })
      .expect(400);

    expect(response.body.error).toContain('configType must be one of');
  });

  it('drops councilId when an inline councilConfig snapshot is provided', async () => {
    const councilConfig = {
      levels: {
        '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] },
        '2': { enabled: false, voices: [] },
        '3': { enabled: false, voices: [] }
      }
    };

    const response = await request(server)
      .post('/api/bulk-analysis-configs')
      .send({
        analysisConfig: {
          isCouncil: true,
          configType: 'advanced',
          councilId: 'db-council-id',
          councilName: 'My Council',
          councilConfig
        }
      })
      .expect(200);

    const stored = bulkAnalysisConfigsRoutes._getBulkAnalysisConfig(response.body.id);
    expect(stored.councilId).toBeUndefined();
    expect(stored.councilName).toBe('My Council');
    expect(stored.councilConfig).toBeTruthy();
  });

  it('keeps councilId when only an id (no inline snapshot) is provided', async () => {
    const response = await request(server)
      .post('/api/bulk-analysis-configs')
      .send({
        analysisConfig: { isCouncil: true, configType: 'advanced', councilId: 'db-council-id' }
      })
      .expect(200);

    const stored = bulkAnalysisConfigsRoutes._getBulkAnalysisConfig(response.body.id);
    expect(stored.councilId).toBe('db-council-id');
    expect(stored.councilConfig).toBeUndefined();
  });

  it('rejects invalid single-model configs', async () => {
    const response = await request(server)
      .post('/api/bulk-analysis-configs')
      .send({ analysisConfig: { provider: 'claude', model: 'opus', tier: 'slow' } })
      .expect(400);

    expect(response.body.error).toContain('tier');
  });

  it('rejects forbidden prototype-pollution keys', async () => {
    const response = await request(server)
      .post('/api/bulk-analysis-configs')
      .set('Content-Type', 'application/json')
      .send('{"analysisConfig":{"provider":"claude","model":"opus","__proto__":{"polluted":true}}}')
      .expect(400);

    expect(response.body.error).toContain('forbidden key __proto__');
  });

  it('normalizes a foreign model to the provider default (defense in depth)', async () => {
    // The bulk replay path forwards the stored single-model pair straight to
    // analysis with no client-side guard. A mismatched pair (real provider but a
    // model that belongs to a different provider) must be normalized server-side
    // to the provider's own default rather than stored as-is.
    const providers = getAllProvidersInfo();
    const claude = providers.find(p => p.id === 'claude');
    // Pick any non-claude provider whose model list does NOT contain claude's
    // default model, so claude.defaultModel is a genuinely foreign model for it.
    const foreign = providers.find(
      p => p.id !== 'claude' && !p.models.some(m => m.id === claude.defaultModel)
    );
    expect(foreign, 'expected a non-claude provider for this test').toBeTruthy();

    const response = await request(server)
      .post('/api/bulk-analysis-configs')
      .send({
        analysisConfig: {
          provider: foreign.id,
          model: claude.defaultModel,
          enabledLevels: [1, 2]
        }
      })
      .expect(200);

    const stored = bulkAnalysisConfigsRoutes._getBulkAnalysisConfig(response.body.id);
    expect(stored.provider).toBe(foreign.id);
    expect(stored.model).not.toBe(claude.defaultModel);
    expect(stored.model).toBe(foreign.defaultModel);
  });

  it('stores a correctly-matched single-model pair unchanged', async () => {
    const providers = getAllProvidersInfo();
    const claude = providers.find(p => p.id === 'claude');
    const validModel = claude.models[0].id;

    const response = await request(server)
      .post('/api/bulk-analysis-configs')
      .send({
        analysisConfig: { provider: 'claude', model: validModel, enabledLevels: [1, 2] }
      })
      .expect(200);

    const stored = bulkAnalysisConfigsRoutes._getBulkAnalysisConfig(response.body.id);
    expect(stored.provider).toBe('claude');
    expect(stored.model).toBe(validModel);
  });

  it('preserves a valid model alias instead of coercing it to the provider default', async () => {
    // Regression: the server-side "does this model belong to the provider" guard must
    // recognize aliases (e.g. 'opus' is an alias of the canonical 'opus-4.8-xhigh'),
    // not just canonical ids. Matching id-only treated valid aliases as mismatched
    // pairs and silently rewrote them to the provider default.
    const claude = getAllProvidersInfo().find(p => p.id === 'claude');
    const aliasedModel = claude.models.find(m => Array.isArray(m.aliases) && m.aliases.length > 0);
    expect(aliasedModel, 'expected a claude model with at least one alias').toBeTruthy();
    const alias = aliasedModel.aliases[0];

    const response = await request(server)
      .post('/api/bulk-analysis-configs')
      .send({
        analysisConfig: { provider: 'claude', model: alias, enabledLevels: [1, 2] }
      })
      .expect(200);

    const stored = bulkAnalysisConfigsRoutes._getBulkAnalysisConfig(response.body.id);
    expect(stored.provider).toBe('claude');
    // The alias is preserved verbatim — neither canonicalized to the model id nor
    // coerced to the provider default.
    expect(stored.model).toBe(alias);
  });

  it('returns 404 for unknown config ids', async () => {
    await request(server)
      .get('/api/bulk-analysis-configs/00000000-0000-0000-0000-000000000000')
      .expect(404);
  });

  it('prunes expired configs before lookups', async () => {
    const createResponse = await request(server)
      .post('/api/bulk-analysis-configs')
      .send({ analysisConfig: { provider: 'claude', model: 'opus' } })
      .expect(200);

    bulkAnalysisConfigsRoutes._pruneExpired(Date.now() + bulkAnalysisConfigsRoutes._CONFIG_TTL_MS + 1);

    await request(server)
      .get(`/api/bulk-analysis-configs/${createResponse.body.id}`)
      .expect(404);
  });
});
