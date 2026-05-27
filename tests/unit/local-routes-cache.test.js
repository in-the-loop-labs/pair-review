// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';

// We require the router only for its attached cache helpers — no Express
// app is instantiated. The cache is per-process module state.
const router = require('../../src/routes/local');

describe('PR detection negative cache', () => {
  const cache = router._prDetectionCache;

  beforeEach(() => cache.clear());

  it('reports not-recently-negative on first lookup', () => {
    expect(cache.isPRDetectionRecentlyNegative('owner/repo', 'branch-a')).toBe(false);
  });

  it('reports recently-negative immediately after recording', () => {
    cache.recordPRDetectionNegative('owner/repo', 'branch-a');
    expect(cache.isPRDetectionRecentlyNegative('owner/repo', 'branch-a')).toBe(true);
  });

  it('treats different (repo, branch) pairs independently', () => {
    cache.recordPRDetectionNegative('owner/repo', 'branch-a');
    expect(cache.isPRDetectionRecentlyNegative('owner/repo', 'branch-b')).toBe(false);
    expect(cache.isPRDetectionRecentlyNegative('other/repo', 'branch-a')).toBe(false);
  });

  it('expires the entry after TTL elapses', () => {
    const now = 1_000_000_000_000;
    // Record at a fixed timestamp.
    cache.recordPRDetectionNegative('owner/repo', 'branch-a', now);
    // Still fresh at TTL boundary.
    expect(cache.isPRDetectionRecentlyNegative('owner/repo', 'branch-a', now + cache.ttlMs)).toBe(true);
    // Stale just past TTL — the lookup also evicts the entry.
    expect(cache.isPRDetectionRecentlyNegative('owner/repo', 'branch-a', now + cache.ttlMs + 1)).toBe(false);
    // Confirm eviction: next lookup at the same time is still false (cache
    // doesn't keep a phantom entry around).
    expect(cache.isPRDetectionRecentlyNegative('owner/repo', 'branch-a', now + cache.ttlMs + 2)).toBe(false);
  });

  it('clear() empties the cache', () => {
    cache.recordPRDetectionNegative('owner/repo', 'branch-a');
    cache.clear();
    expect(cache.isPRDetectionRecentlyNegative('owner/repo', 'branch-a')).toBe(false);
  });
});
