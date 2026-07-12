// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const STOPS = ['branch', 'staged', 'unstaged', 'untracked'];

const DEFAULT_SCOPE = { start: 'unstaged', end: 'untracked' };

// Canonical "the selected scope resolves to zero changed files" message, shared
// so every entry point reports it identically: the web routes' 409 guard
// (rejectIfEmptyScope) and the headless in-process guard, which now fails the
// run (exit non-zero) instead of recording a zero-suggestion success. A
// delegated headless run surfaces the same 409 body verbatim, so all three
// paths match byte-for-byte.
const EMPTY_SCOPE_MESSAGE = 'No changes found in the selected scope. Check that your scope includes files with modifications, or adjust the scope range.';

const UNSTAGED_INDEX = STOPS.indexOf('unstaged');

function isValidScope(start, end) {
  const si = STOPS.indexOf(start);
  const ei = STOPS.indexOf(end);
  // Scope must be contiguous AND must include the 'unstaged' stop.
  // This ensures the diff always covers the working tree state that AI models
  // see when reading files, since we cannot modify local git state.
  return si !== -1 && ei !== -1 && si <= ei && si <= UNSTAGED_INDEX && ei >= UNSTAGED_INDEX;
}

/**
 * The full set of valid scope ranges, formatted as `start..end` strings.
 * Computed from STOPS + isValidScope so it stays the single source of truth.
 * Ordered by STOPS position (branch-first).
 * @type {string[]}
 */
const VALID_SCOPE_RANGES = (() => {
  const ranges = [];
  for (const start of STOPS) {
    for (const end of STOPS) {
      if (isValidScope(start, end)) ranges.push(`${start}..${end}`);
    }
  }
  return ranges;
})();

/**
 * Parse a `--scope` CLI argument of the form `<start>..<end>` into a scope
 * object. Splits on `..`, trims each side, and delegates validation to
 * isValidScope (the single source of truth). Single tokens, missing `..`,
 * unknown stops, non-contiguous ranges, ranges excluding 'unstaged', and
 * reversed ranges all return null.
 *
 * @param {string} value - Raw CLI value (e.g. 'branch..untracked')
 * @returns {{ start: string, end: string }|null} Parsed scope, or null if invalid
 */
function parseScopeArg(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('..');
  if (parts.length !== 2) return null;
  const start = parts[0].trim();
  const end = parts[1].trim();
  if (!isValidScope(start, end)) return null;
  return { start, end };
}

function normalizeScope(start, end) {
  if (isValidScope(start, end)) return { start, end };
  const si = STOPS.indexOf(start);
  const ei = STOPS.indexOf(end);
  if (si === -1 || ei === -1) return { start: DEFAULT_SCOPE.start, end: DEFAULT_SCOPE.end };
  const newEi = Math.max(ei, UNSTAGED_INDEX);
  const newSi = Math.min(si, UNSTAGED_INDEX);
  const finalSi = Math.min(newSi, newEi);
  const newStart = STOPS[finalSi];
  const newEnd = STOPS[newEi];
  if (isValidScope(newStart, newEnd)) return { start: newStart, end: newEnd };
  return { start: DEFAULT_SCOPE.start, end: DEFAULT_SCOPE.end };
}

function scopeIncludes(start, end, stop) {
  if (!isValidScope(start, end)) return false;
  const si = STOPS.indexOf(start);
  const ei = STOPS.indexOf(end);
  const ti = STOPS.indexOf(stop);
  return ti !== -1 && ti >= si && ti <= ei;
}

function includesBranch(start) {
  return start === 'branch';
}

function fromLegacyMode(localMode) {
  if (localMode === 'uncommitted') {
    return { start: 'unstaged', end: 'untracked' };
  }
  if (localMode === 'branch') {
    return { start: 'branch', end: 'unstaged' };
  }
  return { start: DEFAULT_SCOPE.start, end: DEFAULT_SCOPE.end };
}

function reviewScope(review) {
  return normalizeScope(
    review.local_scope_start || DEFAULT_SCOPE.start,
    review.local_scope_end || DEFAULT_SCOPE.end
  );
}

function scopeLabel(start, end) {
  if (!isValidScope(start, end)) return '';
  const label = s => s.charAt(0).toUpperCase() + s.slice(1);
  if (start === end) return label(start);
  return `${label(start)}\u2013${label(end)}`;
}

/**
 * Return git command hints for a scope range.
 * @param {string} start - Scope start
 * @param {string} end - Scope end
 * @param {string} [baseBranch] - Base branch name (e.g. 'main'); used in merge-base commands
 * @returns {{ label: string, description: string, diffCommand: string, excludes: string, includesUntracked: boolean }|null}
 */
function scopeGitHints(start, end, baseBranch) {
  if (!isValidScope(start, end)) return null;

  const mb = baseBranch
    ? '$(git merge-base ' + baseBranch + ' HEAD)'
    : '<merge-base>';
  const incUntracked = scopeIncludes(start, end, 'untracked');
  const label = scopeLabel(start, end);

  const key = start + '-' + end;
  const hints = {
    'branch-unstaged': {
      description: 'All tracked changes (committed, staged, and unstaged) relative to the merge-base.',
      diffCommand: 'git diff --no-ext-diff ' + mb,
      excludes: 'Untracked files are NOT included in the review.'
    },
    'branch-untracked': {
      description: 'All changes (committed, staged, unstaged, and untracked) relative to the merge-base.',
      diffCommand: 'git diff --no-ext-diff ' + mb,
      excludes: ''
    },
    'staged-unstaged': {
      description: 'Staged and unstaged changes relative to HEAD.',
      diffCommand: 'git diff --no-ext-diff HEAD',
      excludes: 'Untracked files are NOT included in the review.'
    },
    'staged-untracked': {
      description: 'Staged, unstaged, and untracked changes relative to HEAD.',
      diffCommand: 'git diff --no-ext-diff HEAD',
      excludes: ''
    },
    'unstaged-unstaged': {
      description: 'Only unstaged working tree changes (not staged, not committed).',
      diffCommand: 'git diff --no-ext-diff',
      excludes: 'Staged changes (`git diff --no-ext-diff --cached`) are treated as already reviewed. Untracked files are NOT included in the review.'
    },
    'unstaged-untracked': {
      description: 'Unstaged and untracked local changes.',
      diffCommand: 'git diff --no-ext-diff',
      excludes: 'Staged changes (`git diff --no-ext-diff --cached`) are treated as already reviewed.'
    }
  };

  const entry = hints[key];
  if (!entry) return null;

  return {
    label: label,
    description: entry.description,
    diffCommand: entry.diffCommand,
    excludes: entry.excludes,
    includesUntracked: incUntracked
  };
}

const LocalScope = {
  STOPS,
  DEFAULT_SCOPE,
  EMPTY_SCOPE_MESSAGE,
  VALID_SCOPE_RANGES,
  isValidScope,
  parseScopeArg,
  normalizeScope,
  reviewScope,
  scopeIncludes,
  includesBranch,
  fromLegacyMode,
  scopeLabel,
  scopeGitHints,
};

if (typeof window !== 'undefined') {
  window.LocalScope = LocalScope;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LocalScope;
}
