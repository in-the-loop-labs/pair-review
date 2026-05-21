// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared middleware for /api/reviews/:reviewId/* routes.
 *
 * Validates that the :reviewId path parameter is a positive integer that
 * corresponds to an existing review. On success it attaches:
 *   - req.reviewId — parsed integer reviewId
 *   - req.review   — the full review row from the DB
 *
 * On failure it short-circuits with:
 *   - 400 when :reviewId is not a positive integer
 *   - 404 when no matching review exists
 *
 * This is the canonical implementation; route modules should import this
 * rather than re-defining their own copy.
 */

const { ReviewRepository } = require('../../database');

/**
 * Express middleware: validate that :reviewId exists in the reviews table.
 * Attaches the review record to req.review and the parsed id to req.reviewId.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function validateReviewId(req, res, next) {
  try {
    const reviewId = parseInt(req.params.reviewId, 10);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getReview(reviewId);

    if (!review) {
      return res.status(404).json({ error: `Review #${reviewId} not found` });
    }

    req.review = review;
    req.reviewId = reviewId;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = validateReviewId;
module.exports.validateReviewId = validateReviewId;
