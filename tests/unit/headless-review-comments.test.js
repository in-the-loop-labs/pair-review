// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';

const { prepareHeadlessReviewComments } = require('../../src/main');
const logger = require('../../src/utils/logger');

afterEach(() => vi.restoreAllMocks());

const finding = (overrides = {}) => ({
  id: 1, file: 'changed.js', line_start: 12, body: 'Check this caller.',
  type: 'bug', ...overrides
});

describe('prepareHeadlessReviewComments', () => {
  it('keeps LEFT-side findings on the LEFT and defaults a missing side to RIGHT', () => {
    const result = prepareHeadlessReviewComments([
      finding({ side: 'LEFT' }), finding({ id: 2, side: 'RIGHT' }), finding({ id: 3 }), finding({ id: 4, side: null })
    ]);
    expect(result.githubComments.map(comment => comment.side)).toEqual(['LEFT', 'RIGHT', 'RIGHT', 'RIGHT']);
  });

  it('treats an unrecognized side as RIGHT', () => {
    const result = prepareHeadlessReviewComments([finding({ side: 'left-ish' })]);
    expect(result.githubComments[0].side).toBe('RIGHT');
  });

  it('builds a line comment with the formatted body', () => {
    const result = prepareHeadlessReviewComments([finding({ side: 'LEFT' })]);
    expect(result.githubComments).toEqual([{
      path: 'changed.js',
      line: 12,
      body: expect.stringContaining('**Bug**: Check this caller.'),
      side: 'LEFT',
      isFileLevel: false
    }]);
    expect(result.validSuggestions.map(s => s.id)).toEqual([1]);
  });

  it('skips and reports missing or invalid line/path data', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const result = prepareHeadlessReviewComments([
      null,
      finding({ line_start: null }),
      finding({ line_start: 0 }),
      finding({ line_start: -3 }),
      finding({ file: '' }),
      finding({ file: '   ' }),
      finding({ file: null })
    ]);

    expect(result).toEqual({ validSuggestions: [], githubComments: [] });
    expect(warn).toHaveBeenCalledTimes(7);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown file:unknown line'));
  });

  it('returns empty lists for no suggestions', () => {
    expect(prepareHeadlessReviewComments([])).toEqual({ validSuggestions: [], githubComments: [] });
    expect(prepareHeadlessReviewComments(null)).toEqual({ validSuggestions: [], githubComments: [] });
  });
});
