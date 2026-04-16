// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';

const { isShaNotFoundError } = require('../../src/setup/pr-setup');
const { MISSING_COMMIT_ERROR_CODE } = require('../../src/git/worktree');

describe('isShaNotFoundError', () => {
  it('recognizes the stable missing-commit error code', () => {
    const error = new Error('Base SHA deadbeef is not available locally');
    error.code = MISSING_COMMIT_ERROR_CODE;

    expect(isShaNotFoundError(error)).toBe(true);
  });

  it('recognizes missing-commit errors through wrapped causes', () => {
    const cause = new Error('Base SHA deadbeef is not available locally');
    cause.code = MISSING_COMMIT_ERROR_CODE;
    const wrapped = new Error(`Failed to generate diff: ${cause.message}`);
    wrapped.cause = cause;

    expect(isShaNotFoundError(wrapped)).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isShaNotFoundError(new Error('network timeout'))).toBe(false);
  });
});
