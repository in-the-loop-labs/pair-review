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
});
