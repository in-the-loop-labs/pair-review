// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import LocalScope from '../../src/local-scope.js';

const { STOPS, DEFAULT_SCOPE, isValidScope, scopeIncludes, includesBranch, fromLegacyMode, scopeLabel } = LocalScope;

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
      ['branch', 'branch'],
      ['branch', 'staged'],
      ['branch', 'unstaged'],
      ['branch', 'untracked'],
      ['staged', 'staged'],
      ['staged', 'unstaged'],
      ['staged', 'untracked'],
      ['unstaged', 'unstaged'],
      ['unstaged', 'untracked'],
      ['untracked', 'untracked'],
    ];

    it.each(validCombinations)('accepts valid scope %s–%s', (start, end) => {
      expect(isValidScope(start, end)).toBe(true);
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

  describe('scopeIncludes', () => {
    it('single-stop scope includes only that stop', () => {
      expect(scopeIncludes('staged', 'staged', 'staged')).toBe(true);
      expect(scopeIncludes('staged', 'staged', 'branch')).toBe(false);
      expect(scopeIncludes('staged', 'staged', 'unstaged')).toBe(false);
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

    it('maps branch to branch–branch', () => {
      expect(fromLegacyMode('branch')).toEqual({ start: 'branch', end: 'branch' });
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
    it('returns single capitalized name for same start/end', () => {
      expect(scopeLabel('branch', 'branch')).toBe('Branch');
      expect(scopeLabel('staged', 'staged')).toBe('Staged');
      expect(scopeLabel('unstaged', 'unstaged')).toBe('Unstaged');
      expect(scopeLabel('untracked', 'untracked')).toBe('Untracked');
    });

    it('returns en-dash separated label for range', () => {
      expect(scopeLabel('branch', 'staged')).toBe('Branch\u2013Staged');
      expect(scopeLabel('unstaged', 'untracked')).toBe('Unstaged\u2013Untracked');
      expect(scopeLabel('branch', 'untracked')).toBe('Branch\u2013Untracked');
      expect(scopeLabel('staged', 'untracked')).toBe('Staged\u2013Untracked');
    });

    it('returns empty string for invalid scope', () => {
      expect(scopeLabel('untracked', 'branch')).toBe('');
      expect(scopeLabel('bogus', 'branch')).toBe('');
    });

    it('covers all 10 valid combinations', () => {
      const validCombinations = [
        ['branch', 'branch', 'Branch'],
        ['branch', 'staged', 'Branch\u2013Staged'],
        ['branch', 'unstaged', 'Branch\u2013Unstaged'],
        ['branch', 'untracked', 'Branch\u2013Untracked'],
        ['staged', 'staged', 'Staged'],
        ['staged', 'unstaged', 'Staged\u2013Unstaged'],
        ['staged', 'untracked', 'Staged\u2013Untracked'],
        ['unstaged', 'unstaged', 'Unstaged'],
        ['unstaged', 'untracked', 'Unstaged\u2013Untracked'],
        ['untracked', 'untracked', 'Untracked'],
      ];
      for (const [start, end, expected] of validCombinations) {
        expect(scopeLabel(start, end)).toBe(expected);
      }
    });
  });
});
