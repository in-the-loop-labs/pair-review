// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

/**
 * Dual-host resolution from the local checkout's git remote.
 *
 * A DUAL repo (`api_host` set, `exclusive: false`) has PRs that may live on
 * github.com OR the alt host. The two-argument ambiguity rule picks the
 * github.com flavour — a GUESS. Before this, that guess propagated all the way
 * into the external-comments sync, which would fetch api.github.com PR #N and
 * UPSERT those rows against a local review whose PR #N lives on the alt host:
 * a stranger's comments anchored to the reviewer's code.
 *
 * Local mode does not have to guess — `remote.origin.url` is on disk. These
 * tests drive `resolveRepositoryBinding` directly (no Express app) and seed
 * the remote-hostname memo so nothing shells out to git.
 */
describe('resolveRepositoryBinding: dual-host resolution from the git remote', () => {
  const router = require('../../src/routes/local');
  const resolve = router._hostBindingCache.resolveRepositoryBinding;
  const remotes = router._remoteHostnameCache;

  const ALT_HOST = 'https://alt.example.com/api/v3';
  const REPO = 'owner/repo';

  /** DUAL: api_host present, exclusive:false, with an alt-host credential. */
  function dualConfig() {
    return {
      github_token: 'GH_TOKEN',
      repos: { [REPO]: { api_host: ALT_HOST, exclusive: false, token: 'ALT_TOKEN' } }
    };
  }

  beforeEach(() => {
    // resolveHostBinding consults GITHUB_TOKEN for github.com bindings; a
    // developer's real env must not decide the outcome.
    vi.stubEnv('GITHUB_TOKEN', '');
    router._hostBindingCache.clear();
    remotes.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    router._hostBindingCache.clear();
    remotes.clear();
  });

  it('binds the ALT host, unflagged, when the remote matches api_host', () => {
    remotes.set('/checkout/alt', 'alt.example.com');

    const binding = resolve(REPO, dualConfig(), { localPath: '/checkout/alt' });

    expect(binding.host).toBe(ALT_HOST);
    expect(binding.apiHost).toBe(ALT_HOST);
    // The repo-scoped credential is the alt-host credential.
    expect(binding.token).toBe('ALT_TOKEN');
    // Evidence, not a guess — this absence is what unblocks fetchPRMetadata's
    // write-through and the pr_metadata `host` stamp downstream.
    expect(binding.hostAmbiguous).toBeUndefined();
  });

  it('stamps hostAmbiguous when no localPath is supplied at all', () => {
    // The legacy call shape (and the PR-mode-ish callers that hold no
    // checkout) must keep the conservative behaviour.
    expect(resolve(REPO, dualConfig()).hostAmbiguous).toBe(true);
    expect(resolve(REPO, dualConfig(), {}).hostAmbiguous).toBe(true);
    expect(resolve(REPO, dualConfig(), { localPath: null }).hostAmbiguous).toBe(true);
  });

  it('leaves a NON-dual repo alone (nothing to disambiguate)', () => {
    remotes.set('/checkout/plain', 'github.com');
    const plain = resolve(REPO, { github_token: 'GH_TOKEN', repos: {} }, { localPath: '/checkout/plain' });
    expect(plain.host).toBeNull();
    expect(plain.hostAmbiguous).toBeUndefined();

    // EXCLUSIVE alt-host repo: the ambiguity rule already yields the alt
    // binding, and it was never flagged.
    remotes.set('/checkout/excl', 'alt.example.com');
    const exclusive = resolve(
      REPO,
      { github_token: 'GH_TOKEN', repos: { [REPO]: { api_host: ALT_HOST, token: 'ALT_TOKEN' } } },
      { localPath: '/checkout/excl' }
    );
    expect(exclusive.host).toBe(ALT_HOST);
    expect(exclusive.hostAmbiguous).toBeUndefined();
  });

  it('keeps the legacy positional `now` argument working (router-exposed helper)', () => {
    // tests/unit/wiring/local-host-binding.test.js calls the exported helper
    // as (association, config, 1_000). A bare number must still mean `now`.
    const binding = resolve(REPO, dualConfig(), 1_000);
    expect(binding.hostAmbiguous).toBe(true);
  });

  it('keys the token-less negative memo per checkout, so one path cannot answer for another', () => {
    // No repo-scoped credential → the ALT binding has an empty token and IS
    // memoized. If the memo ignored localPath, the github.com checkout below
    // would be served that alt binding.
    const config = {
      github_token: 'GH_TOKEN',
      repos: { [REPO]: { api_host: ALT_HOST, exclusive: false } }
    };
    remotes.set('/checkout/alt', 'alt.example.com');
    remotes.set('/checkout/gh', 'github.com');

    const alt = resolve(REPO, config, { localPath: '/checkout/alt', now: 1_000 });
    expect(alt).toMatchObject({ host: ALT_HOST, token: '' });

    const gh = resolve(REPO, config, { localPath: '/checkout/gh', now: 1_000 });
    expect(gh).toMatchObject({ host: null, token: 'GH_TOKEN' });
  });

  it('memoizes the remote lookup per path (no repeated shell-out)', () => {
    // The memo reads the remote through the host-resolution module namespace
    // (src/providers/pr-context.js), which is the spy seam. `local-review`
    // re-exports the same function for back-compat but is no longer the
    // callee, so spying there would silently observe nothing.
    const hostResolution = require('../../src/utils/host-resolution');
    const spy = vi.spyOn(hostResolution, 'getRemoteHostname').mockReturnValue('alt.example.com');
    try {
      resolve(REPO, dualConfig(), { localPath: '/checkout/memo' });
      resolve(REPO, dualConfig(), { localPath: '/checkout/memo' });
      resolve(REPO, dualConfig(), { localPath: '/checkout/memo' });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('memoizes a NULL remote too, so a remote-less repo is not re-probed', () => {
    const hostResolution = require('../../src/utils/host-resolution');
    const spy = vi.spyOn(hostResolution, 'getRemoteHostname').mockReturnValue(null);
    try {
      expect(resolve(REPO, dualConfig(), { localPath: '/checkout/bare' }).hostAmbiguous).toBe(true);
      expect(resolve(REPO, dualConfig(), { localPath: '/checkout/bare' }).hostAmbiguous).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

});

/**
 * `resolveAssociationBinding` is the association-shaped wrapper. It must pass
 * the options object (and therefore `localPath`) straight through, or the
 * association — the thing the sync actually targets — keeps guessing.
 */
describe('resolveAssociationBinding threads localPath through', () => {
  const router = require('../../src/routes/local');
  const resolveAssociation = router._hostBindingCache.resolveAssociationBinding;
  const remotes = router._remoteHostnameCache;
  const ALT_HOST = 'https://alt.example.com/api/v3';

  beforeEach(() => {
    vi.stubEnv('GITHUB_TOKEN', '');
    router._hostBindingCache.clear();
    remotes.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    router._hostBindingCache.clear();
    remotes.clear();
  });

  const config = () => ({
    github_token: 'GH_TOKEN',
    repos: { 'owner/repo': { api_host: ALT_HOST, exclusive: false, token: 'ALT_TOKEN' } }
  });

  it('resolves the alt host for an association whose checkout points there', () => {
    remotes.set('/checkout/alt', 'alt.example.com');
    const binding = resolveAssociation(
      { prNumber: 42, repository: 'owner/repo' },
      config(),
      { localPath: '/checkout/alt' }
    );
    expect(binding).toMatchObject({ host: ALT_HOST, token: 'ALT_TOKEN' });
    expect(binding.hostAmbiguous).toBeUndefined();
  });

});
