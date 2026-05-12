// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

const {
  LOCAL_REVIEW_PATH_URL_ERROR,
  isUrlLikeLocalReviewPath,
  rejectUrlLikeLocalReviewPath
} = require('../../src/utils/local-path-input');

describe('local path input validation', () => {
  it('detects URL inputs', () => {
    expect(isUrlLikeLocalReviewPath('https://github.com/owner/repo/pull/123')).toBe(true);
    expect(isUrlLikeLocalReviewPath('github.com/owner/repo/pull/123')).toBe(true);
    expect(isUrlLikeLocalReviewPath('app.graphite.com/github/pr/owner/repo/123')).toBe(true);
    expect(isUrlLikeLocalReviewPath('app.graphite.dev/github/owner/repo/pull/123')).toBe(true);
    expect(isUrlLikeLocalReviewPath('http://localhost:7247/local')).toBe(true);
    expect(isUrlLikeLocalReviewPath('file:///Users/test/repo')).toBe(true);
  });

  it('detects SSH remote-style inputs', () => {
    expect(isUrlLikeLocalReviewPath('git@github.com:owner/repo.git')).toBe(true);
  });

  it('allows filesystem path forms', () => {
    expect(isUrlLikeLocalReviewPath('/Users/test/repo')).toBe(false);
    expect(isUrlLikeLocalReviewPath('~/src/repo')).toBe(false);
    expect(isUrlLikeLocalReviewPath('relative/path')).toBe(false);
    expect(isUrlLikeLocalReviewPath('/tmp/git@github.com:owner/repo')).toBe(false);
    expect(isUrlLikeLocalReviewPath('nested/git@github.com:owner/repo')).toBe(false);
    expect(isUrlLikeLocalReviewPath('C:\\Users\\test\\repo')).toBe(false);
    expect(isUrlLikeLocalReviewPath('C:\\Users\\git@github.com:owner\\repo')).toBe(false);
    expect(isUrlLikeLocalReviewPath('')).toBe(false);
    expect(isUrlLikeLocalReviewPath(null)).toBe(false);
  });

  it('throws a user-facing error for URL inputs', () => {
    expect(() => rejectUrlLikeLocalReviewPath('https://github.com/owner/repo/pull/123'))
      .toThrow(LOCAL_REVIEW_PATH_URL_ERROR);
  });
});
