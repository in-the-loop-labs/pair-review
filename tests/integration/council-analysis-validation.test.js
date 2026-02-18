// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Integration tests for council analysis config validation in analysis routes
 *
 * Verifies that the analysis endpoints correctly pass the `type` parameter
 * to validateCouncilConfig, so that voice-centric council configs (type: 'council')
 * are not incorrectly rejected.
 *
 * Regression test for: validateCouncilConfig call sites in analysis.js
 * not passing the type parameter after the function signature was updated.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

// Mock modules that analysis routes depend on but we don't need
vi.mock('../../src/ai/analyzer', () => ({
  default: vi.fn().mockImplementation(() => ({
    getLocalChangedFiles: vi.fn().mockResolvedValue([])
  }))
}));

vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({
    isGenerated: vi.fn().mockReturnValue(false)
  })
}));

vi.mock('../../src/local-review', () => ({
  generateLocalDiff: vi.fn().mockResolvedValue({ diff: '', stats: {} }),
  computeLocalDiffDigest: vi.fn().mockResolvedValue('abc123')
}));

const { GitWorktreeManager } = require('../../src/git/worktree');
vi.spyOn(GitWorktreeManager.prototype, 'worktreeExists').mockResolvedValue(true);
vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue('/tmp/worktree/test');

const configModule = require('../../src/config');
vi.spyOn(configModule, 'saveConfig').mockResolvedValue(undefined);
vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
  github_token: 'test-token',
  port: 7247,
  theme: 'light'
});
vi.spyOn(configModule, 'getConfigDir').mockReturnValue('/tmp/.pair-review-test');

const { run } = require('../../src/database');

const analysisRoutes = require('../../src/routes/analyses');
const prRoutes = require('../../src/routes/pr');
const localRoutes = require('../../src/routes/local');

function createTestApp(db) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('githubToken', 'test-token');
  app.set('config', {
    github_token: 'test-token',
    port: 7247,
    theme: 'light',
    model: 'sonnet'
  });
  app.use('/', analysisRoutes);
  app.use('/', prRoutes);
  app.use('/', localRoutes);
  return app;
}

/** A valid voice-centric council config (type: 'council') */
const voiceCentricConfig = {
  voices: [
    { provider: 'claude', model: 'opus', tier: 'thorough' },
    { provider: 'gemini', model: 'pro', tier: 'balanced' }
  ],
  levels: { '1': true, '2': true, '3': false },
  consolidation: { provider: 'claude', model: 'opus', tier: 'balanced' }
};

/** A valid level-centric advanced config (type: 'advanced') */
const advancedConfig = {
  levels: {
    '1': {
      enabled: true,
      voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }]
    },
    '2': { enabled: false, voices: [] },
    '3': { enabled: false, voices: [] }
  }
};

describe('Council analysis config validation in analysis routes', () => {
  let db;
  let app;

  beforeEach(() => {
    db = createTestDatabase();
    app = createTestApp(db);
  });

  afterEach(() => {
    if (db) {
      closeTestDatabase(db);
    }
    vi.clearAllMocks();
  });

  describe('POST /api/pr/:owner/:repo/:number/analyses/council (PR mode)', () => {
    it('should accept voice-centric inline config when configType is council', async () => {
      // Without the fix, this would return 400 because validateCouncilConfig
      // would not receive the type parameter and default to advanced validation,
      // which rejects voice-centric configs.
      // With the fix, validation passes and the request proceeds to the next
      // check (PR metadata lookup), returning 404 since no PR exists.
      const response = await request(app)
        .post('/api/pr/test-owner/test-repo/42/analyses/council')
        .send({
          councilConfig: voiceCentricConfig,
          configType: 'council'
        });

      // Should NOT be a 400 validation error
      expect(response.status).not.toBe(400);
      // Should proceed past validation to PR metadata check (404)
      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('should reject voice-centric inline config when configType is advanced', async () => {
      const response = await request(app)
        .post('/api/pr/test-owner/test-repo/42/analyses/council')
        .send({
          councilConfig: voiceCentricConfig,
          configType: 'advanced'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid council config');
    });

    it('should accept advanced inline config when configType is advanced', async () => {
      const response = await request(app)
        .post('/api/pr/test-owner/test-repo/42/analyses/council')
        .send({
          councilConfig: advancedConfig,
          configType: 'advanced'
        });

      // Should pass validation and hit 404 for PR not found
      expect(response.status).not.toBe(400);
      expect(response.status).toBe(404);
    });

    it('should normalize and accept advanced inline config when configType is council', async () => {
      // Normalization converts advanced format to voice-centric, so it passes validation
      const response = await request(app)
        .post('/api/pr/test-owner/test-repo/42/analyses/council')
        .send({
          councilConfig: advancedConfig,
          configType: 'council'
        });

      // Should NOT be a 400 validation error (normalization converts the config)
      expect(response.status).not.toBe(400);
      // Should proceed past validation to PR metadata check (404)
      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('should default to advanced validation when configType is omitted', async () => {
      // Advanced config should pass with default type
      const response = await request(app)
        .post('/api/pr/test-owner/test-repo/42/analyses/council')
        .send({
          councilConfig: advancedConfig
        });

      expect(response.status).not.toBe(400);
      expect(response.status).toBe(404);
    });

    it('should use saved council type when configType is not in request body', async () => {
      // Create a saved council with type: 'council'
      const councilId = 'test-council-id';
      await run(db, `
        INSERT INTO councils (id, name, type, config)
        VALUES (?, ?, ?, ?)
      `, [councilId, 'Test Voice Council', 'council', JSON.stringify(voiceCentricConfig)]);

      // Send request without configType -- should use the saved council's type ('council')
      const response = await request(app)
        .post('/api/pr/test-owner/test-repo/42/analyses/council')
        .send({
          councilId
        });

      // Should NOT be a 400 validation error (the saved council's type should be used)
      expect(response.status).not.toBe(400);
      // Should proceed past validation to PR metadata check
      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('should normalize and accept saved advanced config when configType overridden to council', async () => {
      // Create a saved council with type: 'advanced' (levels-based format)
      const councilId = 'test-advanced-council';
      await run(db, `
        INSERT INTO councils (id, name, type, config)
        VALUES (?, ?, ?, ?)
      `, [councilId, 'Test Advanced Council', 'advanced', JSON.stringify(advancedConfig)]);

      // Override with configType: 'council' -- normalization should convert
      // the advanced config to voice-centric format before validation
      const response = await request(app)
        .post('/api/pr/test-owner/test-repo/42/analyses/council')
        .send({
          councilId,
          configType: 'council'
        });

      // Should NOT be a 400 validation error (normalization converts the config)
      expect(response.status).not.toBe(400);
      // Should proceed past validation to PR metadata check (404)
      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('should normalize saved council with type council but levels-based config', async () => {
      // Regression test: a council saved with type 'council' but config in levels-based format
      // (could happen from a migration or previous version of the code)
      const councilId = 'test-legacy-council';
      await run(db, `
        INSERT INTO councils (id, name, type, config)
        VALUES (?, ?, ?, ?)
      `, [councilId, 'Legacy Council', 'council', JSON.stringify(advancedConfig)]);

      const response = await request(app)
        .post('/api/pr/test-owner/test-repo/42/analyses/council')
        .send({
          councilId
          // No configType override; uses saved council's type ('council')
        });

      // Should NOT be a 400 validation error
      expect(response.status).not.toBe(400);
      // Should proceed past validation to PR metadata check (404)
      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });
  });

  describe('POST /api/local/:reviewId/analyses/council (local mode)', () => {
    let localReviewId;

    beforeEach(async () => {
      // Create a local review record
      await run(db, `
        INSERT INTO reviews (pr_number, repository, review_type, local_path, local_head_sha)
        VALUES (NULL, 'local-repo', 'local', '/tmp/test-project', 'abc123')
      `);
      // Get the auto-incremented ID
      const row = db.prepare('SELECT id FROM reviews WHERE review_type = ? ORDER BY id DESC LIMIT 1').get('local');
      localReviewId = row.id;
    });

    it('should accept voice-centric inline config when configType is council', async () => {
      // Without the fix, this would return 400 because validateCouncilConfig
      // would default to advanced validation.
      const response = await request(app)
        .post(`/api/local/${localReviewId}/analyses/council`)
        .send({
          councilConfig: voiceCentricConfig,
          configType: 'council'
        });

      // Should NOT be a 400 validation error
      expect(response.status).not.toBe(400);
      // Should proceed past validation (may be 200 with analysisId or similar)
      expect([200, 201]).toContain(response.status);
      expect(response.body.analysisId).toBeDefined();
      expect(response.body.isCouncil).toBe(true);
    });

    it('should reject voice-centric inline config when configType is advanced', async () => {
      const response = await request(app)
        .post(`/api/local/${localReviewId}/analyses/council`)
        .send({
          councilConfig: voiceCentricConfig,
          configType: 'advanced'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid council config');
    });

    it('should accept advanced inline config when configType is advanced', async () => {
      const response = await request(app)
        .post(`/api/local/${localReviewId}/analyses/council`)
        .send({
          councilConfig: advancedConfig,
          configType: 'advanced'
        });

      expect(response.status).not.toBe(400);
      expect([200, 201]).toContain(response.status);
      expect(response.body.analysisId).toBeDefined();
    });

    it('should normalize and accept advanced inline config when configType is council', async () => {
      // Normalization converts advanced format to voice-centric, so it passes validation
      const response = await request(app)
        .post(`/api/local/${localReviewId}/analyses/council`)
        .send({
          councilConfig: advancedConfig,
          configType: 'council'
        });

      // Should NOT be a 400 validation error (normalization converts the config)
      expect(response.status).not.toBe(400);
      expect([200, 201]).toContain(response.status);
      expect(response.body.isCouncil).toBe(true);
    });

    it('should default to advanced validation when configType is omitted', async () => {
      const response = await request(app)
        .post(`/api/local/${localReviewId}/analyses/council`)
        .send({
          councilConfig: advancedConfig
        });

      expect(response.status).not.toBe(400);
      expect([200, 201]).toContain(response.status);
    });

    it('should use saved council type when configType is not in request body', async () => {
      // Create a saved council with type: 'council'
      const councilId = 'test-local-council-id';
      await run(db, `
        INSERT INTO councils (id, name, type, config)
        VALUES (?, ?, ?, ?)
      `, [councilId, 'Local Voice Council', 'council', JSON.stringify(voiceCentricConfig)]);

      // Send request without configType -- should use the saved council's type
      const response = await request(app)
        .post(`/api/local/${localReviewId}/analyses/council`)
        .send({
          councilId
        });

      // Should NOT be a 400 validation error
      expect(response.status).not.toBe(400);
      expect([200, 201]).toContain(response.status);
      expect(response.body.isCouncil).toBe(true);
    });

    it('should normalize and accept saved advanced config when configType overridden to council', async () => {
      // Create a saved council with type: 'advanced'
      const councilId = 'test-local-advanced-council';
      await run(db, `
        INSERT INTO councils (id, name, type, config)
        VALUES (?, ?, ?, ?)
      `, [councilId, 'Local Advanced Council', 'advanced', JSON.stringify(advancedConfig)]);

      // Override with configType: 'council' -- normalization should convert
      const response = await request(app)
        .post(`/api/local/${localReviewId}/analyses/council`)
        .send({
          councilId,
          configType: 'council'
        });

      // Should NOT be a 400 validation error (normalization converts the config)
      expect(response.status).not.toBe(400);
      expect([200, 201]).toContain(response.status);
      expect(response.body.isCouncil).toBe(true);
    });

    it('should normalize saved council with type council but levels-based config (local mode)', async () => {
      // Regression test: a council saved with type 'council' but config in levels-based format
      const councilId = 'test-local-legacy-council';
      await run(db, `
        INSERT INTO councils (id, name, type, config)
        VALUES (?, ?, ?, ?)
      `, [councilId, 'Local Legacy Council', 'council', JSON.stringify(advancedConfig)]);

      const response = await request(app)
        .post(`/api/local/${localReviewId}/analyses/council`)
        .send({
          councilId
        });

      // Should NOT be a 400 validation error
      expect(response.status).not.toBe(400);
      expect([200, 201]).toContain(response.status);
      expect(response.body.isCouncil).toBe(true);
    });
  });
});
