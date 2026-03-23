// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const STOPS = ['branch', 'staged', 'unstaged', 'untracked'];

const DEFAULT_SCOPE = { start: 'unstaged', end: 'untracked' };

function isValidScope(start, end) {
  const si = STOPS.indexOf(start);
  const ei = STOPS.indexOf(end);
  return si !== -1 && ei !== -1 && si <= ei;
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
    return { start: 'branch', end: 'branch' };
  }
  return { start: DEFAULT_SCOPE.start, end: DEFAULT_SCOPE.end };
}

function scopeLabel(start, end) {
  if (!isValidScope(start, end)) return '';
  const label = s => s.charAt(0).toUpperCase() + s.slice(1);
  if (start === end) return label(start);
  return `${label(start)}\u2013${label(end)}`;
}

const LocalScope = {
  STOPS,
  DEFAULT_SCOPE,
  isValidScope,
  scopeIncludes,
  includesBranch,
  fromLegacyMode,
  scopeLabel,
};

if (typeof window !== 'undefined') {
  window.LocalScope = LocalScope;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LocalScope;
}
