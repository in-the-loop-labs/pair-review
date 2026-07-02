// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const reviewsRouter = require('../../src/routes/reviews');
const { handleJobCancel, CANCELLABLE_JOB_PREFIXES } = reviewsRouter;
const { backgroundQueue } = require('../../src/ai/background-queue');
const logger = require('../../src/utils/logger');

function makeReq({ reviewId, jobKey }) {
  return {
    reviewId,
    params: { jobKey: String(jobKey) },
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

describe('POST /api/reviews/:reviewId/jobs/:jobKey/cancel', () => {
  let cancelSpy;

  beforeEach(() => {
    cancelSpy = vi.spyOn(backgroundQueue, 'cancel');
  });

  afterEach(() => {
    cancelSpy.mockRestore();
  });

  it('exposes the allow-list of cancellable prefixes', () => {
    expect(CANCELLABLE_JOB_PREFIXES.has('tour')).toBe(true);
    expect(CANCELLABLE_JOB_PREFIXES.has('summaries')).toBe(true);
    expect(CANCELLABLE_JOB_PREFIXES.has('analysis')).toBe(false);
  });

  it('returns 200 with { cancelled: true, count } when a tour job is in flight', async () => {
    cancelSpy.mockReturnValue({ cancelled: 1 });
    const req = makeReq({ reviewId: 42, jobKey: 'tour' });
    const res = makeRes();
    await handleJobCancel(req, res);
    expect(cancelSpy).toHaveBeenCalledWith(42, 'tour');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ cancelled: true, count: 1 });
  });

  it('returns 200 when a bare-prefix cancel matches multiple summaries variants', async () => {
    cancelSpy.mockReturnValue({ cancelled: 3 });
    const req = makeReq({ reviewId: 7, jobKey: 'summaries' });
    const res = makeRes();
    await handleJobCancel(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ cancelled: true, count: 3 });
  });

  it('accepts a full composite key (summaries:<digest>) as a valid jobKey', async () => {
    cancelSpy.mockReturnValue({ cancelled: 1 });
    const req = makeReq({ reviewId: 7, jobKey: 'summaries:abc123' });
    const res = makeRes();
    await handleJobCancel(req, res);
    expect(cancelSpy).toHaveBeenCalledWith(7, 'summaries:abc123');
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when no matching job is in flight', async () => {
    cancelSpy.mockReturnValue({ cancelled: 0 });
    const req = makeReq({ reviewId: 1, jobKey: 'tour' });
    const res = makeRes();
    await handleJobCancel(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ cancelled: false });
  });

  it('returns 400 for an empty jobKey', async () => {
    const req = makeReq({ reviewId: 1, jobKey: '' });
    const res = makeRes();
    await handleJobCancel(req, res);
    expect(res.statusCode).toBe(400);
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for a jobKey containing path separators', async () => {
    const req = makeReq({ reviewId: 1, jobKey: 'tour/../secret' });
    const res = makeRes();
    await handleJobCancel(req, res);
    expect(res.statusCode).toBe(400);
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for a jobKey with a prefix not on the allow-list', async () => {
    const req = makeReq({ reviewId: 1, jobKey: 'analysis' });
    const res = makeRes();
    await handleJobCancel(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/analysis/);
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for a composite jobKey whose prefix is not allow-listed', async () => {
    const req = makeReq({ reviewId: 1, jobKey: 'analysis:digest' });
    const res = makeRes();
    await handleJobCancel(req, res);
    expect(res.statusCode).toBe(400);
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});

/**
 * Local-mode wrapper coverage for POST /api/local/:reviewId/jobs/:jobKey/cancel
 * defined in src/routes/local.js. The wrapper re-parses reviewId, looks up the
 * review row, attaches req.reviewId/req.review, and delegates to the shared
 * handleJobCancel in reviews.js. CLAUDE.md mandates Local + PR parity, so we
 * exercise the wrapper through Express directly.
 */
describe('POST /api/local/:reviewId/jobs/:jobKey/cancel (local wrapper)', () => {
  let app;
  let server;
  let db;
  let cancelSpy;
  let loggerErrorSpy;

  function seedLocalReview(reviewId) {
    db.prepare(
      "INSERT INTO reviews (id, repository, status, review_type, local_path) VALUES (?, 'owner/repo', 'draft', 'local', '/tmp/repo')"
    ).run(reviewId);
  }

  beforeEach(async () => {
    db = createTestDatabase();
    cancelSpy = vi.spyOn(backgroundQueue, 'cancel').mockReturnValue({ cancelled: 0 });
    loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    app = express();
    app.use(express.json());
    app.set('db', db);
    const localRouter = require('../../src/routes/local');
    app.use(localRouter);

    server = await listenOnLoopback(app);
  });

  afterEach(async () => {
    await closeServer(server);
    cancelSpy.mockRestore();
    loggerErrorSpy.mockRestore();
    closeTestDatabase(db);
    vi.restoreAllMocks();
  });

  it('returns 400 on a non-numeric reviewId', async () => {
    const res = await request(server).post('/api/local/abc/jobs/tour/cancel');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid review ID' });
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('returns 400 on a negative reviewId', async () => {
    const res = await request(server).post('/api/local/-5/jobs/tour/cancel');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid review ID' });
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('returns 400 on a zero reviewId', async () => {
    const res = await request(server).post('/api/local/0/jobs/tour/cancel');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid review ID' });
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('returns 404 when the review row is not in the DB', async () => {
    const res = await request(server).post('/api/local/12345/jobs/tour/cancel');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Review #12345 not found' });
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('returns 200 happy path for a seeded local review with an in-flight tour job', async () => {
    seedLocalReview(4242);
    cancelSpy.mockReturnValue({ cancelled: 1 });

    const res = await request(server).post('/api/local/4242/jobs/tour/cancel');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: true, count: 1 });
    expect(cancelSpy).toHaveBeenCalledWith(4242, 'tour');
  });

  it('returns 200 for a seeded local review with a summaries job', async () => {
    seedLocalReview(4243);
    cancelSpy.mockReturnValue({ cancelled: 3 });

    const res = await request(server).post('/api/local/4243/jobs/summaries/cancel');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: true, count: 3 });
    expect(cancelSpy).toHaveBeenCalledWith(4243, 'summaries');
  });

  it('delegates jobKey validation to handleJobCancel (400 for empty jobKey)', async () => {
    seedLocalReview(4244);
    // Express collapses empty path segments, so use a clearly invalid prefix.
    const res = await request(server).post('/api/local/4244/jobs/analysis/cancel');
    expect(res.status).toBe(400);
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('returns 500 and logs via logger.error when the db query rejects', async () => {
    // Force the underlying queryOne (which calls db.prepare(...).get(...)) to throw.
    // Simulates a transient SQLite lock or db-closed-during-shutdown rejection.
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(() => {
      throw new Error('database is locked');
    });

    const res = await request(server).post('/api/local/4245/jobs/tour/cancel');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to cancel background job' });
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy.mock.calls[0][0]).toMatch(/database is locked/);

    prepareSpy.mockRestore();
  });

  it('returns 500 and logs when delegated handleJobCancel throws', async () => {
    seedLocalReview(4246);
    cancelSpy.mockImplementation(() => {
      throw new Error('queue exploded');
    });

    const res = await request(server).post('/api/local/4246/jobs/tour/cancel');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to cancel background job' });
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy.mock.calls[0][0]).toMatch(/queue exploded/);
  });
});
