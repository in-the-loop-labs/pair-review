// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const express = require('express');
const validateReviewId = require('./middleware/validate-review-id');
const { readCodePreview, resolvePreviewRepository } = require('../utils/code-preview');
const logger = require('../utils/logger');

const router = express.Router();
router.get('/api/reviews/:reviewId/code-preview/:fileName(*)', validateReviewId, async (req, res) => {
  try {
    const location = await resolvePreviewRepository(req.app.get('db'), req.review);
    const preview = await readCodePreview(req.review, location, req.params.fileName);
    res.json(preview);
  } catch (error) {
    if (!error.statusCode) logger.error('Error loading code preview:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not load this file.' });
  }
});
module.exports = router;
