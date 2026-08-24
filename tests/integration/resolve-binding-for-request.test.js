// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * `resolveBindingForRequest` (PR-mode route chokepoint) is PR-aware: it reads
 * the stored `pr_metadata.host` for the request's PR and binds accordingly,
 * falling back to the ambiguity rule when no row exists and surfacing a stale
 * stored host as a throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { createTestDatabase, closeTestDatabase } = require('../utils/schema');
const { run } = require('../../src/database');
const prRoutes = require('../../src/routes/pr');
const { resolveBindingForRequest } = prRoutes._internals;

const ALT_HOST = 'https://alt.example/api/v3';

function makeReq(db, config, number) {
  const store = { db, config, githubToken: 'startup-tok' };
  return { app: { get: (k) => store[k] }, params: { number: String(number) } };
}

const dualConfig = {
  github_token: 'gh-tok',
  repos: { 'acme/widgets': { api_host: ALT_HOST, exclusive: false, token: 'alt-tok' } }
};
const exclusiveConfig = {
  github_token: 'gh-tok',
  repos: { 'acme/widgets': { api_host: ALT_HOST, token: 'alt-tok' } }
};
// Monorepo-style entry: its url_pattern probe claims EVERY owner/repo, so an
// existing review of a github.com PR resolves through it unless the lookup is
// host-aware.
const MONOREPO_PATTERN = '^https://alt\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>\\d+)';
const exclusiveMonorepoConfig = {
  github_token: 'gh-tok',
  repos: {
    'acme/platform': { api_host: ALT_HOST, url_pattern: MONOREPO_PATTERN, token: 'alt-tok' }
  }
};
const dualMonorepoConfig = {
  github_token: 'gh-tok',
  repos: {
    'acme/platform': { api_host: ALT_HOST, exclusive: false, url_pattern: MONOREPO_PATTERN, token: 'alt-tok' }
  }
};

/** Seed a pr_metadata row with a recorded html_url in pr_data. */
async function seedReview(db, { repository, number, host, htmlUrl }) {
  await run(db,
    'INSERT INTO pr_metadata (pr_number, repository, host, pr_data) VALUES (?, ?, ?, ?)',
    [number, repository, host, htmlUrl ? JSON.stringify({ html_url: htmlUrl }) : null]
  );
}

describe('resolveBindingForRequest — per-PR host', () => {
  let db;
  let savedEnvToken;
  beforeEach(() => {
    db = createTestDatabase();
    // Deterministic token resolution: GITHUB_TOKEN would short-circuit the chain.
    savedEnvToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });
  afterEach(() => {
    if (savedEnvToken !== undefined) process.env.GITHUB_TOKEN = savedEnvToken;
    if (db) closeTestDatabase(db);
  });

  it('no stored row → ambiguity rule (dual repo → github binding)', async () => {
    const resolved = await resolveBindingForRequest(makeReq(db, dualConfig, 42), 'acme/widgets');
    expect(resolved.binding.apiHost).toBe(null);
    expect(resolved.binding.host).toBe(null);
    expect(resolved.token).toBe('gh-tok');
  });

  it('stored alt host → alt binding with the repo-scoped token', async () => {
    await run(db, 'INSERT INTO pr_metadata (pr_number, repository, host) VALUES (?, ?, ?)', [42, 'acme/widgets', ALT_HOST]);
    const resolved = await resolveBindingForRequest(makeReq(db, dualConfig, 42), 'acme/widgets');
    expect(resolved.binding.apiHost).toBe(ALT_HOST);
    expect(resolved.binding.host).toBe(ALT_HOST);
    expect(resolved.token).toBe('alt-tok');
  });

  it('stored NULL host (dual repo) → github binding', async () => {
    await run(db, 'INSERT INTO pr_metadata (pr_number, repository, host) VALUES (?, ?, ?)', [42, 'acme/widgets', null]);
    const resolved = await resolveBindingForRequest(makeReq(db, dualConfig, 42), 'acme/widgets');
    expect(resolved.binding.apiHost).toBe(null);
    expect(resolved.token).toBe('gh-tok');
  });

  it('legacy NULL host on an exclusive repo → derives the alt binding (no throw)', async () => {
    await run(db, 'INSERT INTO pr_metadata (pr_number, repository, host) VALUES (?, ?, ?)', [42, 'acme/widgets', null]);
    const resolved = await resolveBindingForRequest(makeReq(db, exclusiveConfig, 42), 'acme/widgets');
    expect(resolved.binding.apiHost).toBe(ALT_HOST);
    expect(resolved.token).toBe('alt-tok');
  });

  it('stale stored host (no longer matches config) throws a targeted error', async () => {
    await run(db, 'INSERT INTO pr_metadata (pr_number, repository, host) VALUES (?, ?, ?)', [42, 'acme/widgets', 'https://old.example/api/v3']);
    await expect(
      resolveBindingForRequest(makeReq(db, dualConfig, 42), 'acme/widgets')
    ).rejects.toThrow(/stored host no longer matches config/);
  });

  it('an existing github.com review does not bind an exclusive entry that only pattern-claimed it', async () => {
    // The dashboard renders github.com links for this row; the review page must
    // reach the same host rather than the monorepo entry's alt host.
    await seedReview(db, {
      repository: 'acme/widgets',
      number: 42,
      host: null,
      htmlUrl: 'https://github.com/acme/widgets/pull/42'
    });

    const resolved = await resolveBindingForRequest(
      makeReq(db, exclusiveMonorepoConfig, 42), 'acme/widgets'
    );

    expect(resolved.bindingRepository).toBe('acme/widgets');
    expect(resolved.binding.apiHost).toBe(null);
    expect(resolved.token).toBe('gh-tok');
  });

  it('an existing alt-host review keeps the monorepo entry', async () => {
    await seedReview(db, {
      repository: 'acme/widgets',
      number: 43,
      host: ALT_HOST,
      htmlUrl: 'https://alt.example/acme/widgets/pull/43'
    });

    const resolved = await resolveBindingForRequest(
      makeReq(db, exclusiveMonorepoConfig, 43), 'acme/widgets'
    );

    expect(resolved.bindingRepository).toBe('acme/platform');
    expect(resolved.binding.apiHost).toBe(ALT_HOST);
    expect(resolved.token).toBe('alt-tok');
  });

  it('a pre-stamping NULL with an alt-host recorded URL still binds the alt host', async () => {
    // No regression for reviews recorded before host stamping existed: the
    // recorded URL contradicts github.com, so the monorepo entry is kept.
    await seedReview(db, {
      repository: 'acme/widgets',
      number: 44,
      host: null,
      htmlUrl: 'https://alt.example/acme/widgets/pull/44'
    });

    const resolved = await resolveBindingForRequest(
      makeReq(db, exclusiveMonorepoConfig, 44), 'acme/widgets'
    );

    expect(resolved.bindingRepository).toBe('acme/platform');
    expect(resolved.binding.apiHost).toBe(ALT_HOST);
  });

  it('a DUAL monorepo entry is kept for a github.com review, preserving its config', async () => {
    await seedReview(db, {
      repository: 'acme/widgets',
      number: 45,
      host: null,
      htmlUrl: 'https://github.com/acme/widgets/pull/45'
    });

    const resolved = await resolveBindingForRequest(
      makeReq(db, dualMonorepoConfig, 45), 'acme/widgets'
    );

    expect(resolved.bindingRepository).toBe('acme/platform');
    expect(resolved.binding.apiHost).toBe(null);
    expect(resolved.token).toBe('gh-tok');
  });

  it('a pre-stamping NULL with an alt-host URL binds the alt host on a DUAL repo', async () => {
    // The row's links resolve to the alt host from the same evidence, so the
    // binding must too — reapplying the raw NULL here would force github.com and
    // put the review page on a different system than its own links.
    await seedReview(db, {
      repository: 'acme/widgets',
      number: 46,
      host: null,
      htmlUrl: 'https://alt.example/acme/widgets/pull/46'
    });

    const resolved = await resolveBindingForRequest(makeReq(db, dualConfig, 46), 'acme/widgets');

    expect(resolved.binding.apiHost).toBe(ALT_HOST);
    expect(resolved.token).toBe('alt-tok');
  });

  it('a stamped NULL with a github URL still binds github on a DUAL repo', async () => {
    await seedReview(db, {
      repository: 'acme/widgets',
      number: 47,
      host: null,
      htmlUrl: 'https://github.com/acme/widgets/pull/47'
    });

    const resolved = await resolveBindingForRequest(makeReq(db, dualConfig, 47), 'acme/widgets');

    expect(resolved.binding.apiHost).toBe(null);
    expect(resolved.token).toBe('gh-tok');
  });
});
