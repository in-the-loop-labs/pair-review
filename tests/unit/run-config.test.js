// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the launch-time council message helpers in
 * src/councils/run-config.js — the two strings that tell a user why a `file:`
 * council did not do what they expected (never loaded vs. loaded stale).
 */

import { describe, it, expect } from 'vitest';

const {
  councilNotFoundMessage,
  fileCouncilStalenessWarning
} = require('../../src/councils/run-config');

describe('fileCouncilStalenessWarning', () => {
  it('warns for a file council id, naming the council and the fix', () => {
    const msg = fileCouncilStalenessWarning('file:dream-team');
    expect(msg).toContain('file:dream-team');
    expect(msg).toContain('council file');
    expect(msg).toMatch(/restart/i);
  });

  it('returns null for a DB council id — DB councils are re-read per resolve', () => {
    expect(fileCouncilStalenessWarning('4f2c9d0e-1111-2222-3333-444455556666')).toBeNull();
  });

  it('returns null for a missing id so callers need no guard of their own', () => {
    expect(fileCouncilStalenessWarning(null)).toBeNull();
    expect(fileCouncilStalenessWarning(undefined)).toBeNull();
    expect(fileCouncilStalenessWarning('')).toBeNull();
  });

  it('does not treat an id that merely contains "file:" as a file council', () => {
    expect(fileCouncilStalenessWarning('a-file:council')).toBeNull();
  });
});

describe('councilNotFoundMessage', () => {
  it('explains the startup-load rule for a file council id', () => {
    const msg = councilNotFoundMessage('file:dream-team');
    expect(msg).toContain('file:dream-team');
    expect(msg).toMatch(/restart/i);
  });

  it('is the generic message for a DB council id', () => {
    expect(councilNotFoundMessage('4f2c9d0e-1111-2222-3333-444455556666')).toBe('Council not found');
    expect(councilNotFoundMessage(null)).toBe('Council not found');
  });
});
