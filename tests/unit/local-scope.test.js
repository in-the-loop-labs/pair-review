// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import LocalScope from '../../src/local-scope.js';

const { STOPS, DEFAULT_SCOPE, isValidScope, normalizeScope, reviewScope, scopeIncludes, includesBranch, fromLegacyMode, scopeLabel, scopeGitHints } = LocalScope;

describe('LocalScope', () => {
  describe('STOPS', () => {
    it('has exactly four stops in order', () => {
      expect(STOPS).toEqual(['branch', 'staged', 'unstaged', 'untracked']);
    });
  });

  describe('DEFAULT_SCOPE', () => {
    it('defaults to unstaged–untracked', () => {
      expect(DEFAULT_SCOPE).toEqual({ start: 'unstaged', end: 'untracked' });
    });
  });

  describe('isValidScope', () => {
    const validCombinations = [
      ['branch', 'unstaged'],
      ['branch', 'untracked'],
      ['staged', 'unstaged'],
      ['staged', 'untracked'],
      ['unstaged', 'unstaged'],
      ['unstaged', 'untracked'],
    ];

    it.each(validCombinations)('accepts valid scope %s–%s', (start, end) => {
      expect(isValidScope(start, end)).toBe(true);
    });

    it('rejects scope that excludes unstaged', () => {
      expect(isValidScope('branch', 'branch')).toBe(false);
      expect(isValidScope('branch', 'staged')).toBe(false);
      expect(isValidScope('staged', 'staged')).toBe(false);
      expect(isValidScope('untracked', 'untracked')).toBe(false);
    });

    it('rejects reversed order (staged before branch)', () => {
      expect(isValidScope('staged', 'branch')).toBe(false);
    });

    it('rejects reversed order (untracked before unstaged)', () => {
      expect(isValidScope('untracked', 'unstaged')).toBe(false);
    });

    it('rejects reversed order (unstaged before staged)', () => {
      expect(isValidScope('unstaged', 'staged')).toBe(false);
    });

    it('rejects unknown stop name for start', () => {
      expect(isValidScope('bogus', 'branch')).toBe(false);
    });

    it('rejects unknown stop name for end', () => {
      expect(isValidScope('branch', 'bogus')).toBe(false);
    });

    it('rejects both unknown', () => {
      expect(isValidScope('foo', 'bar')).toBe(false);
    });

    it('rejects undefined inputs', () => {
      expect(isValidScope(undefined, 'branch')).toBe(false);
      expect(isValidScope('branch', undefined)).toBe(false);
    });

    it('rejects null inputs', () => {
      expect(isValidScope(null, 'branch')).toBe(false);
      expect(isValidScope('branch', null)).toBe(false);
    });
  });

  describe('normalizeScope', () => {
    it('passes through already-valid scopes unchanged', () => {
      expect(normalizeScope('branch', 'unstaged')).toEqual({ start: 'branch', end: 'unstaged' });
      expect(normalizeScope('branch', 'untracked')).toEqual({ start: 'branch', end: 'untracked' });
      expect(normalizeScope('staged', 'unstaged')).toEqual({ start: 'staged', end: 'unstaged' });
      expect(normalizeScope('staged', 'untracked')).toEqual({ start: 'staged', end: 'untracked' });
      expect(normalizeScope('unstaged', 'unstaged')).toEqual({ start: 'unstaged', end: 'unstaged' });
      expect(normalizeScope('unstaged', 'untracked')).toEqual({ start: 'unstaged', end: 'untracked' });
    });

    it('clamps branch..branch to branch..unstaged', () => {
      expect(normalizeScope('branch', 'branch')).toEqual({ start: 'branch', end: 'unstaged' });
    });

    it('clamps branch..staged to branch..unstaged', () => {
      expect(normalizeScope('branch', 'staged')).toEqual({ start: 'branch', end: 'unstaged' });
    });

    it('clamps staged..staged to staged..unstaged', () => {
      expect(normalizeScope('staged', 'staged')).toEqual({ start: 'staged', end: 'unstaged' });
    });

    it('clamps untracked..untracked to unstaged..untracked', () => {
      expect(normalizeScope('untracked', 'untracked')).toEqual({ start: 'unstaged', end: 'untracked' });
    });

    it('falls back to DEFAULT_SCOPE for unknown start', () => {
      expect(normalizeScope('bogus', 'unstaged')).toEqual(DEFAULT_SCOPE);
    });

    it('falls back to DEFAULT_SCOPE for unknown end', () => {
      expect(normalizeScope('branch', 'bogus')).toEqual(DEFAULT_SCOPE);
    });

    it('falls back to DEFAULT_SCOPE for both unknown', () => {
      expect(normalizeScope('foo', 'bar')).toEqual(DEFAULT_SCOPE);
    });
  });

  describe('reviewScope', () => {
    it('returns valid scope from review with valid fields', () => {
      const review = { local_scope_start: 'branch', local_scope_end: 'untracked' };
      expect(reviewScope(review)).toEqual({ start: 'branch', end: 'untracked' });
    });

    it('normalizes legacy scope that excludes unstaged (staged-only)', () => {
      // Regression: legacy reviews stored scope_start=staged, scope_end=staged
      // which excludes the mandatory 'unstaged' stop
      const review = { local_scope_start: 'staged', local_scope_end: 'staged' };
      expect(reviewScope(review)).toEqual({ start: 'staged', end: 'unstaged' });
    });

    it('normalizes legacy scope that excludes unstaged (branch-only)', () => {
      const review = { local_scope_start: 'branch', local_scope_end: 'branch' };
      expect(reviewScope(review)).toEqual({ start: 'branch', end: 'unstaged' });
    });

    it('normalizes legacy scope that excludes unstaged (branch-staged)', () => {
      const review = { local_scope_start: 'branch', local_scope_end: 'staged' };
      expect(reviewScope(review)).toEqual({ start: 'branch', end: 'unstaged' });
    });

    it('normalizes legacy scope that excludes unstaged (untracked-only)', () => {
      const review = { local_scope_start: 'untracked', local_scope_end: 'untracked' };
      expect(reviewScope(review)).toEqual({ start: 'unstaged', end: 'untracked' });
    });

    it('falls back to DEFAULT_SCOPE when fields are null', () => {
      const review = { local_scope_start: null, local_scope_end: null };
      expect(reviewScope(review)).toEqual(DEFAULT_SCOPE);
    });

    it('falls back to DEFAULT_SCOPE when fields are undefined', () => {
      const review = {};
      expect(reviewScope(review)).toEqual(DEFAULT_SCOPE);
    });

    it('falls back to DEFAULT_SCOPE when fields are empty strings', () => {
      const review = { local_scope_start: '', local_scope_end: '' };
      expect(reviewScope(review)).toEqual(DEFAULT_SCOPE);
    });
  });

  describe('scopeIncludes', () => {
    it('single-stop scope includes only that stop', () => {
      expect(scopeIncludes('unstaged', 'unstaged', 'unstaged')).toBe(true);
      expect(scopeIncludes('unstaged', 'unstaged', 'branch')).toBe(false);
      expect(scopeIncludes('unstaged', 'unstaged', 'untracked')).toBe(false);
    });

    it('returns false for scope that excludes unstaged', () => {
      expect(scopeIncludes('staged', 'staged', 'staged')).toBe(false);
    });

    it('branch–untracked includes all stops', () => {
      for (const stop of STOPS) {
        expect(scopeIncludes('branch', 'untracked', stop)).toBe(true);
      }
    });

    it('unstaged–untracked does not include branch or staged', () => {
      expect(scopeIncludes('unstaged', 'untracked', 'branch')).toBe(false);
      expect(scopeIncludes('unstaged', 'untracked', 'staged')).toBe(false);
    });

    it('unstaged–untracked includes unstaged and untracked', () => {
      expect(scopeIncludes('unstaged', 'untracked', 'unstaged')).toBe(true);
      expect(scopeIncludes('unstaged', 'untracked', 'untracked')).toBe(true);
    });

    it('returns false for invalid scope', () => {
      expect(scopeIncludes('untracked', 'branch', 'staged')).toBe(false);
    });

    it('returns false for unknown stop', () => {
      expect(scopeIncludes('branch', 'untracked', 'bogus')).toBe(false);
    });
  });

  describe('includesBranch', () => {
    it('returns true when start is branch', () => {
      expect(includesBranch('branch')).toBe(true);
    });

    it('returns false for other stops', () => {
      expect(includesBranch('staged')).toBe(false);
      expect(includesBranch('unstaged')).toBe(false);
      expect(includesBranch('untracked')).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(includesBranch(undefined)).toBe(false);
    });
  });

  describe('fromLegacyMode', () => {
    it('maps uncommitted to unstaged–untracked', () => {
      expect(fromLegacyMode('uncommitted')).toEqual({ start: 'unstaged', end: 'untracked' });
    });

    it('maps branch to branch–unstaged', () => {
      expect(fromLegacyMode('branch')).toEqual({ start: 'branch', end: 'unstaged' });
    });

    it('returns default scope for unknown mode', () => {
      expect(fromLegacyMode('whatever')).toEqual({ start: 'unstaged', end: 'untracked' });
    });

    it('returns default scope for undefined', () => {
      expect(fromLegacyMode(undefined)).toEqual({ start: 'unstaged', end: 'untracked' });
    });

    it('returns default scope for null', () => {
      expect(fromLegacyMode(null)).toEqual({ start: 'unstaged', end: 'untracked' });
    });
  });

  describe('scopeLabel', () => {
    it('returns single capitalized name for unstaged (only valid single-stop scope)', () => {
      expect(scopeLabel('unstaged', 'unstaged')).toBe('Unstaged');
    });

    it('returns empty string for invalid single-stop scopes', () => {
      expect(scopeLabel('branch', 'branch')).toBe('');
      expect(scopeLabel('staged', 'staged')).toBe('');
      expect(scopeLabel('untracked', 'untracked')).toBe('');
    });

    it('returns en-dash separated label for range', () => {
      expect(scopeLabel('unstaged', 'untracked')).toBe('Unstaged\u2013Untracked');
      expect(scopeLabel('branch', 'untracked')).toBe('Branch\u2013Untracked');
      expect(scopeLabel('staged', 'untracked')).toBe('Staged\u2013Untracked');
      expect(scopeLabel('branch', 'unstaged')).toBe('Branch\u2013Unstaged');
    });

    it('returns empty string for invalid scope', () => {
      expect(scopeLabel('untracked', 'branch')).toBe('');
      expect(scopeLabel('bogus', 'branch')).toBe('');
      expect(scopeLabel('branch', 'staged')).toBe('');
    });

    it('covers all 6 valid combinations', () => {
      const validCombinations = [
        ['branch', 'unstaged', 'Branch\u2013Unstaged'],
        ['branch', 'untracked', 'Branch\u2013Untracked'],
        ['staged', 'unstaged', 'Staged\u2013Unstaged'],
        ['staged', 'untracked', 'Staged\u2013Untracked'],
        ['unstaged', 'unstaged', 'Unstaged'],
        ['unstaged', 'untracked', 'Unstaged\u2013Untracked'],
      ];
      for (const [start, end, expected] of validCombinations) {
        expect(scopeLabel(start, end)).toBe(expected);
      }
    });
  });

  describe('scopeGitHints', () => {
    it('returns null for invalid scope', () => {
      expect(scopeGitHints('untracked', 'branch')).toBeNull();
      expect(scopeGitHints('bogus', 'branch')).toBeNull();
    });

    it('returns correct diff command for each scope', () => {
      const expected = [
        ['branch', 'unstaged', 'git diff --no-ext-diff <merge-base>'],
        ['branch', 'untracked', 'git diff --no-ext-diff <merge-base>'],
        ['staged', 'unstaged', 'git diff --no-ext-diff HEAD'],
        ['staged', 'untracked', 'git diff --no-ext-diff HEAD'],
        ['unstaged', 'unstaged', 'git diff --no-ext-diff'],
        ['unstaged', 'untracked', 'git diff --no-ext-diff'],
      ];
      for (const [start, end, cmd] of expected) {
        const hints = scopeGitHints(start, end);
        expect(hints).not.toBeNull();
        expect(hints.diffCommand).toBe(cmd);
      }
    });

    it('returns null for scopes that exclude unstaged', () => {
      expect(scopeGitHints('branch', 'branch')).toBeNull();
      expect(scopeGitHints('branch', 'staged')).toBeNull();
      expect(scopeGitHints('staged', 'staged')).toBeNull();
      expect(scopeGitHints('untracked', 'untracked')).toBeNull();
    });

    it('substitutes baseBranch into merge-base command', () => {
      const hints = scopeGitHints('branch', 'unstaged', 'main');
      expect(hints.diffCommand).toBe('git diff --no-ext-diff $(git merge-base main HEAD)');
    });

    it('uses placeholder when baseBranch is not provided', () => {
      const hints = scopeGitHints('branch', 'untracked');
      expect(hints.diffCommand).toContain('<merge-base>');
    });

    it('sets includesUntracked correctly', () => {
      expect(scopeGitHints('branch', 'untracked').includesUntracked).toBe(true);
      expect(scopeGitHints('unstaged', 'untracked').includesUntracked).toBe(true);
      expect(scopeGitHints('staged', 'untracked').includesUntracked).toBe(true);
      expect(scopeGitHints('branch', 'unstaged').includesUntracked).toBe(false);
      expect(scopeGitHints('staged', 'unstaged').includesUntracked).toBe(false);
      expect(scopeGitHints('unstaged', 'unstaged').includesUntracked).toBe(false);
    });

    it('label matches scopeLabel output', () => {
      const combos = [
        ['branch', 'unstaged'],
        ['branch', 'untracked'],
        ['staged', 'unstaged'],
        ['unstaged', 'untracked'],
      ];
      for (const [start, end] of combos) {
        expect(scopeGitHints(start, end).label).toBe(scopeLabel(start, end));
      }
    });

    it('excludes is empty for branch–untracked (nothing excluded)', () => {
      expect(scopeGitHints('branch', 'untracked').excludes).toBe('');
    });

    it('excludes is empty for staged–untracked (nothing excluded)', () => {
      expect(scopeGitHints('staged', 'untracked').excludes).toBe('');
    });

    it('excludes is non-empty for scopes that omit stops', () => {
      expect(scopeGitHints('branch', 'unstaged').excludes).toBeTruthy();
      expect(scopeGitHints('staged', 'unstaged').excludes).toBeTruthy();
      expect(scopeGitHints('unstaged', 'unstaged').excludes).toBeTruthy();
      expect(scopeGitHints('unstaged', 'untracked').excludes).toBeTruthy();
    });

    it('has non-empty description for all valid scopes', () => {
      const validCombinations = [
        ['branch', 'unstaged'], ['branch', 'untracked'],
        ['staged', 'unstaged'], ['staged', 'untracked'],
        ['unstaged', 'unstaged'], ['unstaged', 'untracked'],
      ];
      for (const [start, end] of validCombinations) {
        const hints = scopeGitHints(start, end);
        expect(hints.description).toBeTruthy();
      }
    });
  });
});
