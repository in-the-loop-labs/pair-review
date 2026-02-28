// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for POST /api/reviews/:reviewId/expand-hunk
 *
 * Tests the endpoint that broadcasts a request to expand a hidden hunk
 * in the diff view. This is a transient UI command with no database writes.
 *
 * Validates:
 * - Request body validation (file, line_start, line_end, side)
 * - Correct SSE broadcast payload
 * - Success response format
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const { run } = require('../../src/database.js');

// Import the review-events module and spy on broadcastReviewEvent
const reviewEvents = require('../../src/events/review-events');
vi.spyOn(reviewEvents, 'broadcastReviewEvent').mockImplementation(() => {});

// Suppress logger output during tests
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

// Load the reviews route module
const reviewsRoutes = require('../../src/routes/reviews');

function createTestApp(db) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.use('/', reviewsRoutes);
  return app;
}

async function insertReview(db) {
  const result = await run(db, `
    INSERT INTO reviews (repository, status, review_type, created_at, updated_at)
    VALUES ('owner/repo', 'draft', 'local', datetime('now'), datetime('now'))
  `);
  return result.lastID;
}

describe('POST /api/reviews/:reviewId/expand-hunk', () => {
  let db, app, reviewId;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
    reviewId = await insertReview(db);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  // --- success ---

  it('should return { success: true } for a valid request', async () => {
    const response = await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: 'src/app.js', line_start: 10, line_end: 20 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
  });

  it('should default side to "right" when not provided', async () => {
    await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: 'src/app.js', line_start: 10, line_end: 20 });

    expect(reviewEvents.broadcastReviewEvent).toHaveBeenCalledWith(reviewId, {
      type: 'review:expand_hunk',
      file: 'src/app.js',
      line_start: 10,
      line_end: 20,
      side: 'right'
    });
  });

  it('should pass explicit side value through to the broadcast', async () => {
    await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: 'src/app.js', line_start: 5, line_end: 15, side: 'left' });

    expect(reviewEvents.broadcastReviewEvent).toHaveBeenCalledWith(reviewId, {
      type: 'review:expand_hunk',
      file: 'src/app.js',
      line_start: 5,
      line_end: 15,
      side: 'left'
    });
  });

  it('should accept line_start equal to line_end (single line)', async () => {
    const response = await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: 'x.js', line_start: 42, line_end: 42 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
  });

  // --- broadcastReviewEvent payload ---

  it('should call broadcastReviewEvent with type "review:expand_hunk"', async () => {
    await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: 'index.js', line_start: 1, line_end: 10, side: 'right' });

    expect(reviewEvents.broadcastReviewEvent).toHaveBeenCalledTimes(1);
    expect(reviewEvents.broadcastReviewEvent).toHaveBeenCalledWith(reviewId, {
      type: 'review:expand_hunk',
      file: 'index.js',
      line_start: 1,
      line_end: 10,
      side: 'right'
    });
  });

  // --- validation: file ---

  it('should return 400 when file is missing', async () => {
    const response = await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ line_start: 10, line_end: 20 });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/file/i);
  });

  it('should return 400 when file is empty string', async () => {
    const response = await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: '', line_start: 10, line_end: 20 });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/file/i);
  });

  it('should return 400 when file is not a string', async () => {
    const response = await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: 123, line_start: 10, line_end: 20 });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/file/i);
  });

  // --- validation: line_start ---

  it('should return 400 when line_start is missing', async () => {
    const response = await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: 'app.js', line_end: 20 });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/line_start/i);
  });

  it('should return 400 when line_start is zero', async () => {
    const response = await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: 'app.js', line_start: 0, line_end: 5 });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/line_start/i);
  });

  it('should return 400 when line_start is negative', async () => {
    const response = await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: 'app.js', line_start: -1, line_end: 5 });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/line_start/i);
  });

  it('should return 400 when line_start is a float', async () => {
    const response = await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: 'app.js', line_start: 1.5, line_end: 5 });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/line_start/i);
  });

  // --- validation: line_end ---

  it('should return 400 when line_end is missing', async () => {
    const response = await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: 'app.js', line_start: 10 });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/line_end/i);
  });

  it('should return 400 when line_end is less than line_start', async () => {
    const response = await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: 'app.js', line_start: 20, line_end: 10 });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/line_end/i);
  });

  // --- validation: side ---

  it('should return 400 when side is an invalid value', async () => {
    const response = await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: 'app.js', line_start: 1, line_end: 5, side: 'center' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/side/i);
  });

  it('should return 400 when side is an uppercase value', async () => {
    // The route only accepts lowercase 'left' or 'right'
    const response = await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ file: 'app.js', line_start: 1, line_end: 5, side: 'LEFT' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/side/i);
  });

  // --- validation: reviewId ---

  it('should return 404 for a non-existent review ID', async () => {
    const response = await request(app)
      .post('/api/reviews/99999/expand-hunk')
      .send({ file: 'app.js', line_start: 1, line_end: 5 });

    expect(response.status).toBe(404);
  });

  it('should return 400 for an invalid review ID', async () => {
    const response = await request(app)
      .post('/api/reviews/invalid/expand-hunk')
      .send({ file: 'app.js', line_start: 1, line_end: 5 });

    expect(response.status).toBe(400);
  });

  // --- no broadcast on validation failure ---

  it('should not call broadcastReviewEvent when validation fails', async () => {
    await request(app)
      .post(`/api/reviews/${reviewId}/expand-hunk`)
      .send({ line_start: 10, line_end: 20 }); // missing file

    expect(reviewEvents.broadcastReviewEvent).not.toHaveBeenCalled();
  });
});
