// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

const {
  resolveKnownHostNames,
  formatHostList,
  resolveHostListText,
  resolveAltHostHostnames,
  resolveUrlLikeHostnames
} = require('../../src/links/host-names');

function altHostRepo(overrides = {}) {
  return {
    api_host: 'https://api.althost.example/api/v3',
    links: {
      external: {
        name: 'AltHost',
        label: 'Open on AltHost',
        url_template: 'https://althost.example/{owner}/{repo}/pull/{number}'
      }
    },
    ...overrides
  };
}

describe('resolveKnownHostNames', () => {
  it('returns GitHub alone for an empty or missing config', () => {
    expect(resolveKnownHostNames()).toEqual(['GitHub']);
    expect(resolveKnownHostNames(null)).toEqual(['GitHub']);
    expect(resolveKnownHostNames({})).toEqual(['GitHub']);
  });

  it('omits Graphite unless enable_graphite is exactly true', () => {
    expect(resolveKnownHostNames({ enable_graphite: false })).toEqual(['GitHub']);
    expect(resolveKnownHostNames({ enable_graphite: 'yes' })).toEqual(['GitHub']);
    expect(resolveKnownHostNames({ enable_graphite: true })).toEqual(['GitHub', 'Graphite']);
  });

  it('appends the alt-host display name for api_host repos', () => {
    const config = { repos: { 'myteam/myproject': altHostRepo() } };
    expect(resolveKnownHostNames(config)).toEqual(['GitHub', 'AltHost']);
  });

  it('places Graphite before alt hosts when both apply', () => {
    const config = {
      enable_graphite: true,
      repos: { 'myteam/myproject': altHostRepo() }
    };
    expect(resolveKnownHostNames(config)).toEqual(['GitHub', 'Graphite', 'AltHost']);
  });

  it('de-duplicates a name shared by several repos, preserving config order', () => {
    const config = {
      repos: {
        'a/one': altHostRepo(),
        'b/two': altHostRepo(),
        'c/three': altHostRepo({
          links: {
            external: {
              name: 'Second',
              label: 'Open on Second',
              url_template: 'https://second.example/{owner}/{repo}/pull/{number}'
            }
          }
        })
      }
    };
    expect(resolveKnownHostNames(config)).toEqual(['GitHub', 'AltHost', 'Second']);
  });

  it('ignores repos with no api_host even when they name an external link', () => {
    const config = {
      repos: {
        'plain/repo': {
          links: {
            external: {
              name: 'NotAHost',
              label: 'Open elsewhere',
              url_template: 'https://elsewhere.example/{owner}/{repo}/pull/{number}'
            }
          }
        }
      }
    };
    expect(resolveKnownHostNames(config)).toEqual(['GitHub']);
  });

  it('does not add a second "GitHub" for an alt-host repo with no external name', () => {
    const config = { repos: { 'myteam/myproject': { api_host: 'https://api.althost.example' } } };
    expect(resolveKnownHostNames(config)).toEqual(['GitHub']);
  });

  it('drops an external name whose link is not usable', () => {
    // resolveRepoLinks requires a label and an https url_template, so a
    // name-only entry never registers as an external link.
    const config = {
      repos: {
        'myteam/myproject': { api_host: 'https://api.althost.example', links: { external: { name: 'AltHost' } } }
      }
    };
    expect(resolveKnownHostNames(config)).toEqual(['GitHub']);
  });

  // loadConfig() merges `monorepos` into `repos` and deletes it, so this branch
  // only fires for a raw/hand-built config — as does getRepoConfig's fallback.
  it("reads a raw config's legacy monorepos section", () => {
    const config = { monorepos: { 'myteam/myproject': altHostRepo() } };
    expect(resolveKnownHostNames(config)).toEqual(['GitHub', 'AltHost']);
  });

  it('tolerates malformed repo entries', () => {
    const config = { repos: { 'a/one': null, 'b/two': 'nope', 'c/three': altHostRepo() } };
    expect(resolveKnownHostNames(config)).toEqual(['GitHub', 'AltHost']);
  });
});

describe('formatHostList', () => {
  it('formats zero through three names', () => {
    expect(formatHostList([])).toBe('GitHub');
    expect(formatHostList(['GitHub'])).toBe('GitHub');
    expect(formatHostList(['GitHub', 'Graphite'])).toBe('GitHub or Graphite');
    expect(formatHostList(['GitHub', 'Graphite', 'Meteorite']))
      .toBe('GitHub, Graphite, or Meteorite');
  });

  it('uses an Oxford comma beyond three names', () => {
    expect(formatHostList(['A', 'B', 'C', 'D'])).toBe('A, B, C, or D');
  });

  it('ignores non-string and empty entries', () => {
    expect(formatHostList(['GitHub', '', null, 'Meteorite'])).toBe('GitHub or Meteorite');
    expect(formatHostList(null)).toBe('GitHub');
  });
});

describe('resolveHostListText', () => {
  it('composes the derived list', () => {
    expect(resolveHostListText()).toBe('GitHub');
    expect(resolveHostListText({
      enable_graphite: true,
      repos: { 'myteam/myproject': altHostRepo() }
    })).toBe('GitHub, Graphite, or AltHost');
  });
});

describe('resolveAltHostHostnames', () => {
  it('returns nothing without alt-host repos', () => {
    expect(resolveAltHostHostnames()).toEqual([]);
    expect(resolveAltHostHostnames({ repos: { 'plain/repo': { path: '~/src/repo' } } })).toEqual([]);
  });

  it('derives both the api and web hostnames', () => {
    const config = { repos: { 'myteam/myproject': altHostRepo() } };
    expect(resolveAltHostHostnames(config).sort())
      .toEqual(['althost.example', 'api.althost.example']);
  });

  it('lowercases and de-duplicates', () => {
    const config = {
      repos: {
        'a/one': altHostRepo({ api_host: 'https://AltHost.Example/api/v3' }),
        'b/two': altHostRepo({ api_host: 'https://althost.example/api/v3' })
      }
    };
    expect(resolveAltHostHostnames(config)).toEqual(['althost.example']);
  });

  it('skips unparseable values rather than throwing', () => {
    const config = {
      repos: {
        'myteam/myproject': altHostRepo({
          api_host: 'not a url',
          links: { external: { name: 'X', label: 'X', url_template: 'https://web.example/{owner}' } }
        })
      }
    };
    expect(resolveAltHostHostnames(config)).toEqual(['web.example']);
  });

  // `api_host` is validated only as a non-empty string, so a bare hostname is
  // a legitimate configuration — and one that already appears in-repo.
  it('derives a hostname from a scheme-less api_host', () => {
    const config = {
      repos: { 'myteam/myproject': { api_host: 'ghe.example.com' } }
    };
    expect(resolveAltHostHostnames(config)).toEqual(['ghe.example.com']);
  });

  it('derives a hostname from a scheme-less api_host with a path', () => {
    const config = {
      repos: { 'myteam/myproject': { api_host: 'ghe.example.com/api/v3' } }
    };
    expect(resolveAltHostHostnames(config)).toEqual(['ghe.example.com']);
  });

  // A user pastes the host WITH its port, so both shapes must be recognised.
  it('records a non-default port alongside the bare hostname', () => {
    const config = {
      repos: { 'myteam/myproject': { api_host: 'https://ghe.example.com:8443/api/v3' } }
    };
    expect(resolveAltHostHostnames(config).sort())
      .toEqual(['ghe.example.com', 'ghe.example.com:8443']);
  });

  it('drops a template whose authority section is a placeholder', () => {
    // `new URL('https://{owner}.example/...')` parses rather than throwing, so
    // without the guard `{owner}.example` would be published to the browser.
    const config = {
      repos: {
        'myteam/myproject': altHostRepo({
          links: {
            external: {
              name: 'X',
              label: 'X',
              url_template: 'https://{owner}.example/{repo}/pull/{number}'
            }
          }
        })
      }
    };
    expect(resolveAltHostHostnames(config)).toEqual(['api.althost.example']);
  });
});

describe('resolveUrlLikeHostnames', () => {
  it('always includes the built-in hosts', () => {
    expect(resolveUrlLikeHostnames()).toEqual([
      'github.com', 'app.graphite.dev', 'app.graphite.com'
    ]);
  });

  it('appends configured alt hosts', () => {
    const config = { repos: { 'myteam/myproject': altHostRepo() } };
    const hostnames = resolveUrlLikeHostnames(config);
    expect(hostnames).toContain('github.com');
    expect(hostnames).toContain('althost.example');
    expect(hostnames).toContain('api.althost.example');
  });
});
