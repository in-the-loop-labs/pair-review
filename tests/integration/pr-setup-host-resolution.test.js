// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Per-PR host resolution for dual (github + alt-host) repos.
 *
 * Exercises `resolvePrHostBinding` — the shared primitive used by every PR
 * setup entry point (web setup route + CLI) — across the precedence matrix
 * (explicit host > stored pr_metadata host > ambiguity/probe) and the probe
 * error taxonomy (alt 200 → alt, alt 404 → github fallback, alt 401 → loud
 * failure with NO fallback).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { createTestDatabase, closeTestDatabase } = require('../utils/schema');
const { run } = require('../../src/database');
const { resolvePrHostBinding } = require('../../src/setup/pr-setup');
const { GitHubApiError } = require('../../src/github/errors');

const ALT_HOST = 'https://alt.example/api/v3';

// A GitHubClient stand-in injected via `deps.GitHubClient`. Records every
// construction so tests can assert which hosts were contacted (and, for the
// no-fallback case, that a second host was NOT).
function makeFakeClient(fetchBehaviour) {
  const constructions = [];
  class FakeClient {
    constructor(arg) {
      // `arg` is a binding object (has `.apiHost`) or a bare token string.
      this.apiHost = (arg && typeof arg === 'object') ? arg.apiHost : null;
      constructions.push({ apiHost: this.apiHost });
    }
    async repositoryExists() { return true; }
    async fetchPullRequest(owner, repo, prNumber) {
      return fetchBehaviour(this.apiHost, { owner, repo, prNumber });
    }
  }
  return { FakeClient, constructions };
}

function insertPRHost(db, repository, prNumber, host) {
  // `host === undefined` inserts no row; `null` / string writes the column.
  return run(db, `INSERT INTO pr_metadata (pr_number, repository, host) VALUES (?, ?, ?)`,
    [prNumber, repository, host === undefined ? null : host]);
}

const dualConfig = {
  github_token: 'gh-tok',
  repos: {
    'acme/widgets': { api_host: ALT_HOST, exclusive: false, token: 'alt-tok' }
  }
};
const exclusiveConfig = {
  github_token: 'gh-tok',
  repos: {
    'acme/widgets': { api_host: ALT_HOST, token: 'alt-tok' }
  }
};
const plainConfig = { github_token: 'gh-tok', repos: {} };

const base = { bindingRepository: 'acme/widgets', owner: 'acme', repo: 'widgets', prNumber: 42, githubToken: 'gh-tok' };

describe('resolvePrHostBinding — precedence + probe', () => {
  let db;
  beforeEach(() => { db = createTestDatabase(); });
  afterEach(() => { if (db) closeTestDatabase(db); });

  it('explicit host (alt url) binds to the alt host with no probe', async () => {
    const { FakeClient, constructions } = makeFakeClient(() => ({ number: 42, title: 'x' }));
    const { binding, prData } = await resolvePrHostBinding({
      db, config: dualConfig, ...base, host: ALT_HOST, deps: { GitHubClient: FakeClient }
    });
    expect(binding.host).toBe(ALT_HOST);
    expect(binding.apiHost).toBe(ALT_HOST);
    expect(prData.number).toBe(42);
    expect(constructions).toEqual([{ apiHost: ALT_HOST }]); // single client, no probe
  });

  it('explicit host null binds to github.com (dual repo)', async () => {
    const { FakeClient, constructions } = makeFakeClient(() => ({ number: 42 }));
    const { binding } = await resolvePrHostBinding({
      db, config: dualConfig, ...base, host: null, deps: { GitHubClient: FakeClient }
    });
    expect(binding.host).toBe(null);
    expect(binding.apiHost).toBe(null);
    expect(constructions).toEqual([{ apiHost: null }]);
  });

  it('stored alt host wins when no explicit host is given', async () => {
    await insertPRHost(db, 'acme/widgets', 42, ALT_HOST);
    const { FakeClient, constructions } = makeFakeClient(() => ({ number: 42 }));
    const { binding } = await resolvePrHostBinding({
      db, config: dualConfig, ...base, host: undefined, deps: { GitHubClient: FakeClient }
    });
    expect(binding.host).toBe(ALT_HOST);
    expect(constructions).toEqual([{ apiHost: ALT_HOST }]); // no probe
  });

  it('stored NULL host (dual repo) binds to github.com', async () => {
    await insertPRHost(db, 'acme/widgets', 42, null);
    const { FakeClient, constructions } = makeFakeClient(() => ({ number: 42 }));
    const { binding } = await resolvePrHostBinding({
      db, config: dualConfig, ...base, host: undefined, deps: { GitHubClient: FakeClient }
    });
    expect(binding.host).toBe(null);
    expect(constructions).toEqual([{ apiHost: null }]);
  });

  it('probes the alt host first and binds there on success (dual, unknown)', async () => {
    const { FakeClient, constructions } = makeFakeClient((apiHost) => {
      if (apiHost === ALT_HOST) return { number: 42, title: 'on-alt' };
      throw new Error('github should not be contacted');
    });
    const { binding, prData } = await resolvePrHostBinding({
      db, config: dualConfig, ...base, host: undefined, deps: { GitHubClient: FakeClient }
    });
    expect(binding.host).toBe(ALT_HOST);
    expect(prData.title).toBe('on-alt');
    expect(constructions).toEqual([{ apiHost: ALT_HOST }]);
  });

  it('falls back to github.com when the alt host returns 404', async () => {
    const { FakeClient, constructions } = makeFakeClient((apiHost) => {
      if (apiHost === ALT_HOST) throw new GitHubApiError('Pull request #42 not found', 404);
      return { number: 42, title: 'on-github' };
    });
    const { binding, prData } = await resolvePrHostBinding({
      db, config: dualConfig, ...base, host: undefined, deps: { GitHubClient: FakeClient }
    });
    expect(binding.host).toBe(null);
    expect(prData.title).toBe('on-github');
    expect(constructions).toEqual([{ apiHost: ALT_HOST }, { apiHost: null }]); // probed alt, then github
  });

  it('does NOT fall back on a 401 from the alt host (fails loudly)', async () => {
    const { FakeClient, constructions } = makeFakeClient((apiHost) => {
      if (apiHost === ALT_HOST) throw new GitHubApiError('auth failed', 401);
      return { number: 42, title: 'wrong-pr' };
    });
    await expect(resolvePrHostBinding({
      db, config: dualConfig, ...base, host: undefined, deps: { GitHubClient: FakeClient }
    })).rejects.toThrow(/alt\.example/);
    // github.com must never be contacted — that could fetch a same-numbered PR.
    expect(constructions).toEqual([{ apiHost: ALT_HOST }]);
  });

  it('probe with a token-less alt binding fails loudly and does NOT probe github disguised as alt', async () => {
    // Dual repo whose alt host has NO configured token. The probe must not fall
    // back to the github token (which would hit api.github.com while recording
    // the result as the alt host). It must surface a clear missing-credential
    // error naming the alt host, and never construct a client.
    const dualNoAltToken = {
      github_token: 'gh-tok',
      repos: { 'acme/widgets': { api_host: ALT_HOST, exclusive: false } }
    };
    const { FakeClient, constructions } = makeFakeClient(() => ({ number: 42, title: 'should-not-fetch' }));

    await expect(resolvePrHostBinding({
      db, config: dualNoAltToken, ...base, host: undefined, deps: { GitHubClient: FakeClient }
    })).rejects.toThrow(/No token configured for alt host .*alt\.example/);
    // clientArgFor throws before any client is constructed — github never contacted.
    expect(constructions).toEqual([]);
  });

  it('explicit alt host with a token-less alt binding errors instead of retargeting github', async () => {
    const dualNoAltToken = {
      github_token: 'gh-tok',
      repos: { 'acme/widgets': { api_host: ALT_HOST, exclusive: false } }
    };
    const { FakeClient, constructions } = makeFakeClient(() => ({ number: 42 }));

    await expect(resolvePrHostBinding({
      db, config: dualNoAltToken, ...base, host: ALT_HOST, deps: { GitHubClient: FakeClient }
    })).rejects.toThrow(/No token configured for alt host/);
    expect(constructions).toEqual([]);
  });

  it('plain github repo never probes (single github binding)', async () => {
    const { FakeClient, constructions } = makeFakeClient(() => ({ number: 42 }));
    const { binding } = await resolvePrHostBinding({
      db, config: plainConfig, ...base, host: undefined, deps: { GitHubClient: FakeClient }
    });
    expect(binding.host).toBe(null);
    expect(constructions).toEqual([{ apiHost: null }]);
  });

  it('exclusive alt-host repo binds to the alt host with no probe', async () => {
    const { FakeClient, constructions } = makeFakeClient(() => ({ number: 42 }));
    const { binding } = await resolvePrHostBinding({
      db, config: exclusiveConfig, ...base, host: undefined, deps: { GitHubClient: FakeClient }
    });
    expect(binding.host).toBe(ALT_HOST);
    expect(constructions).toEqual([{ apiHost: ALT_HOST }]);
  });

  it('legacy NULL stored host on an exclusive repo derives the alt host (no throw)', async () => {
    await insertPRHost(db, 'acme/widgets', 42, null);
    const { FakeClient, constructions } = makeFakeClient(() => ({ number: 42 }));
    const { binding } = await resolvePrHostBinding({
      db, config: exclusiveConfig, ...base, host: undefined, deps: { GitHubClient: FakeClient }
    });
    expect(binding.host).toBe(ALT_HOST);
    expect(constructions).toEqual([{ apiHost: ALT_HOST }]);
  });
});
