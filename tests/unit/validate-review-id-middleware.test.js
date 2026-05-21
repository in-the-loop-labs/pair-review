// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest';

const validateReviewId = require('../../src/routes/middleware/validate-review-id');
const { ReviewRepository } = require('../../src/database');

describe('validateReviewId middleware', () => {
  let req;
  let res;
  let next;
  let getReviewSpy;

  function makeReqRes(reviewId) {
    req = {
      params: { reviewId },
      app: { get: vi.fn().mockReturnValue({ /* fake db handle */ }) }
    };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis()
    };
    next = vi.fn();
  }

  beforeEach(() => {
    getReviewSpy = vi.spyOn(ReviewRepository.prototype, 'getReview');
  });

  it('exports the middleware as the default export', () => {
    expect(typeof validateReviewId).toBe('function');
  });

  it('also exposes a named export for backwards-compatible imports', () => {
    expect(typeof validateReviewId.validateReviewId).toBe('function');
    expect(validateReviewId.validateReviewId).toBe(validateReviewId);
  });

  it('returns 400 when reviewId is not a number', async () => {
    makeReqRes('not-a-number');

    await validateReviewId(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid review ID' });
    expect(next).not.toHaveBeenCalled();
    expect(getReviewSpy).not.toHaveBeenCalled();
  });

  it('returns 400 when reviewId is zero', async () => {
    makeReqRes('0');

    await validateReviewId(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid review ID' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 when reviewId is negative', async () => {
    makeReqRes('-7');

    await validateReviewId(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid review ID' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 when reviewId param is missing', async () => {
    makeReqRes(undefined);

    await validateReviewId(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid review ID' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 404 when review row does not exist', async () => {
    makeReqRes('42');
    getReviewSpy.mockResolvedValue(undefined);

    await validateReviewId(req, res, next);

    expect(getReviewSpy).toHaveBeenCalledWith(42);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Review #42 not found' });
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches req.review and req.reviewId then calls next() when review exists', async () => {
    makeReqRes('77');
    const fakeReview = { id: 77, review_type: 'local', repository: 'foo/bar' };
    getReviewSpy.mockResolvedValue(fakeReview);

    await validateReviewId(req, res, next);

    expect(getReviewSpy).toHaveBeenCalledWith(77);
    expect(req.reviewId).toBe(77);
    expect(req.review).toBe(fakeReview);
    expect(next).toHaveBeenCalledTimes(1);
    // next() called with no args means "continue to next handler"
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('forwards repository errors to next(error)', async () => {
    makeReqRes('100');
    const dbError = new Error('boom');
    getReviewSpy.mockRejectedValue(dbError);

    await validateReviewId(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(dbError);
    expect(res.status).not.toHaveBeenCalled();
  });
});
