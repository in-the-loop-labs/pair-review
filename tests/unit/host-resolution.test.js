// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the shared per-PR host resolution helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { storedHostToOption, isDualHostRepo, getConfiguredApiHost, resolvePreflightBinding, hostSetupParamValue, hostnameMatchesApiHost, remoteHostnameToHostOption } = require('../../src/utils/host-resolution');

const ALT = 'https://alt.example/api/v3';
const dualConfig = { repos: { 'acme/widgets': { api_host: ALT, exclusive: false, token: 't' } } };
const exclusiveConfig = { repos: { 'acme/widgets': { api_host: ALT, token: 't' } } };
const plainConfig = { repos: {} };

describe('storedHostToOption', () => {
  it('undefined (no row) → undefined (ambiguity)', () => {
    expect(storedHostToOption(dualConfig, 'acme/widgets', undefined)).toBeUndefined();
  });

  it('a URL string → { host: <url> }', () => {
    expect(storedHostToOption(dualConfig, 'acme/widgets', ALT)).toEqual({ host: ALT });
  });

  it('null on a dual repo → { host: null } (github)', () => {
    expect(storedHostToOption(dualConfig, 'acme/widgets', null)).toEqual({ host: null });
  });

  it('null on a plain repo → { host: null } (github)', () => {
    expect(storedHostToOption(plainConfig, 'acme/widgets', null)).toEqual({ host: null });
  });

  it('null on an EXCLUSIVE alt-host repo → undefined (legacy NULL derives alt)', () => {
    expect(storedHostToOption(exclusiveConfig, 'acme/widgets', null)).toBeUndefined();
  });
});

describe('isDualHostRepo', () => {
  it('true only for api_host + exclusive:false', () => {
    expect(isDualHostRepo(dualConfig, 'acme/widgets')).toBe(true);
  });

  it('false for an exclusive alt-host repo (api_host, no exclusive key)', () => {
    expect(isDualHostRepo(exclusiveConfig, 'acme/widgets')).toBe(false);
  });

  it('false for a plain github repo (no api_host)', () => {
    expect(isDualHostRepo(plainConfig, 'acme/widgets')).toBe(false);
  });

  it('false for an unknown repo key', () => {
    expect(isDualHostRepo(dualConfig, 'nobody/here')).toBe(false);
  });
});

describe('getConfiguredApiHost', () => {
  it('returns the api_host for a dual/exclusive repo, null otherwise', () => {
    expect(getConfiguredApiHost(dualConfig, 'acme/widgets')).toBe(ALT);
    expect(getConfiguredApiHost(exclusiveConfig, 'acme/widgets')).toBe(ALT);
    expect(getConfiguredApiHost(plainConfig, 'acme/widgets')).toBe(null);
  });
});

describe('hostSetupParamValue (FINDING C)', () => {
  it('alt api_host string → that string', () => {
    expect(hostSetupParamValue(ALT, false)).toBe(ALT);
    expect(hostSetupParamValue(ALT, true)).toBe(ALT);
  });
  it('null on a dual repo → github sentinel', () => {
    expect(hostSetupParamValue(null, true)).toBe('github');
  });
  it('null on a non-dual repo → null (omit)', () => {
    expect(hostSetupParamValue(null, false)).toBe(null);
  });
  it('undefined (unknown) → null (omit)', () => {
    expect(hostSetupParamValue(undefined, true)).toBe(null);
    expect(hostSetupParamValue(undefined, false)).toBe(null);
  });
});

describe('resolvePreflightBinding (FINDING 2/3/4)', () => {
  let savedEnvToken;
  beforeEach(() => {
    // Deterministic: GITHUB_TOKEN would short-circuit the github chain.
    savedEnvToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });
  afterEach(() => {
    if (savedEnvToken !== undefined) process.env.GITHUB_TOKEN = savedEnvToken;
  });

  const altOnly = { repos: { 'acme/widgets': { api_host: ALT, exclusive: false, token: 'alt-tok' } } };
  const githubOnly = { github_token: 'gh-tok', repos: { 'acme/widgets': { api_host: ALT, exclusive: false } } };
  const neither = { repos: { 'acme/widgets': { api_host: ALT, exclusive: false } } };
  const plainWithToken = { github_token: 'gh-tok', repos: {} };

  it('dual repo, alt-only token, host unknown → returns the alt binding token (no false reject)', () => {
    const b = resolvePreflightBinding('acme/widgets', altOnly, undefined);
    expect(b.token).toBe('alt-tok');
    expect(b.apiHost).toBe(ALT);
  });

  it('dual repo, github-only token, host unknown → returns the github binding token', () => {
    const b = resolvePreflightBinding('acme/widgets', githubOnly, undefined);
    expect(b.token).toBe('gh-tok');
    expect(b.apiHost).toBe(null);
  });

  it('dual repo, neither token, host unknown → empty token (caller rejects)', () => {
    expect(resolvePreflightBinding('acme/widgets', neither, undefined).token).toBe('');
  });

  it('explicit alt bodyHost → resolves the alt binding token', () => {
    const b = resolvePreflightBinding('acme/widgets', altOnly, ALT);
    expect(b.token).toBe('alt-tok');
    expect(b.apiHost).toBe(ALT);
  });

  it('plain repo with a github token is unchanged', () => {
    const b = resolvePreflightBinding('acme/widgets', plainWithToken, undefined);
    expect(b.token).toBe('gh-tok');
    expect(b.apiHost).toBe(null);
  });
});

describe('hostnameMatchesApiHost', () => {
  it('matches an exact alt host against an api_host with a path', () => {
    expect(hostnameMatchesApiHost('git.corp', 'https://git.corp/api/v3')).toBe(true);
  });

  it('matches through an api. prefix on the api_host', () => {
    expect(hostnameMatchesApiHost('git.corp', 'https://api.git.corp')).toBe(true);
    expect(hostnameMatchesApiHost('github.com', 'https://api.github.com')).toBe(true);
  });

  it('matches an api.-prefixed remote against a bare api_host hostname', () => {
    expect(hostnameMatchesApiHost('api.git.corp', 'https://git.corp/api/v3')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(hostnameMatchesApiHost('GIT.CORP', 'https://Git.Corp/api/v3')).toBe(true);
  });

  it('does not match a different host', () => {
    expect(hostnameMatchesApiHost('github.com', 'https://git.corp/api/v3')).toBe(false);
    expect(hostnameMatchesApiHost('git.corp', 'https://other.corp/api/v3')).toBe(false);
    // Suffix-only overlap must NOT match (never a raw string comparison).
    expect(hostnameMatchesApiHost('evil-git.corp', 'https://git.corp/api/v3')).toBe(false);
    expect(hostnameMatchesApiHost('git.corp.evil.test', 'https://git.corp/api/v3')).toBe(false);
  });

  it('tolerates an api_host that is a bare hostname, not a URL', () => {
    expect(hostnameMatchesApiHost('git.corp', 'git.corp')).toBe(true);
    expect(hostnameMatchesApiHost('git.corp', 'api.git.corp')).toBe(true);
    expect(hostnameMatchesApiHost('github.com', 'git.corp')).toBe(false);
  });

  it('tolerates an api_host carrying a port', () => {
    expect(hostnameMatchesApiHost('git.corp', 'https://git.corp:8443/api/v3')).toBe(true);
    expect(hostnameMatchesApiHost('git.corp', 'git.corp:8443')).toBe(true);
  });

  it('returns false for a missing or empty remote hostname', () => {
    expect(hostnameMatchesApiHost(null, 'https://git.corp/api/v3')).toBe(false);
    expect(hostnameMatchesApiHost(undefined, 'https://git.corp/api/v3')).toBe(false);
    expect(hostnameMatchesApiHost('', 'https://git.corp/api/v3')).toBe(false);
    expect(hostnameMatchesApiHost('   ', 'https://git.corp/api/v3')).toBe(false);
  });

  it('returns false for a missing, empty, or unusable api_host', () => {
    expect(hostnameMatchesApiHost('git.corp', null)).toBe(false);
    expect(hostnameMatchesApiHost('git.corp', undefined)).toBe(false);
    expect(hostnameMatchesApiHost('git.corp', '')).toBe(false);
    expect(hostnameMatchesApiHost('git.corp', '   ')).toBe(false);
  });

});

describe('remoteHostnameToHostOption', () => {
  it('github.com → { host: null }', () => {
    expect(remoteHostnameToHostOption('github.com', null)).toEqual({ host: null });
    // ...even on a dual repo, where an api_host is configured.
    expect(remoteHostnameToHostOption('github.com', ALT)).toEqual({ host: null });
  });

  it('www.github.com → { host: null }', () => {
    expect(remoteHostnameToHostOption('www.github.com', ALT)).toEqual({ host: null });
  });

  it('an exact alt-host remote → { host: <api_host url> }', () => {
    expect(remoteHostnameToHostOption('alt.example', ALT)).toEqual({ host: ALT });
  });

  // Whatever form the api_host takes, the option carries it back VERBATIM —
  // never a hostname re-derived from it, which would drop a port or a path
  // the client needs. The matching itself is covered above.
  it('a matching remote yields the api_host string verbatim, in every api_host form', () => {
    expect(remoteHostnameToHostOption('git.corp', 'https://api.git.corp'))
      .toEqual({ host: 'https://api.git.corp' });
    expect(remoteHostnameToHostOption('git.corp', 'git.corp')).toEqual({ host: 'git.corp' });
    expect(remoteHostnameToHostOption('git.corp', 'https://git.corp:8443/api/v3'))
      .toEqual({ host: 'https://git.corp:8443/api/v3' });
  });

  it('a host matching neither → null (still ambiguous, do not guess)', () => {
    expect(remoteHostnameToHostOption('gitlab.example', ALT)).toBe(null);
  });

  it('a non-github remote with no api_host configured → null', () => {
    expect(remoteHostnameToHostOption('git.corp', null)).toBe(null);
    expect(remoteHostnameToHostOption('git.corp', undefined)).toBe(null);
    expect(remoteHostnameToHostOption('git.corp', '')).toBe(null);
  });

  it('a missing or empty remote hostname → null, even with an api_host', () => {
    expect(remoteHostnameToHostOption(null, ALT)).toBe(null);
    expect(remoteHostnameToHostOption(undefined, ALT)).toBe(null);
    expect(remoteHostnameToHostOption('', ALT)).toBe(null);
    expect(remoteHostnameToHostOption('   ', ALT)).toBe(null);
  });

});
