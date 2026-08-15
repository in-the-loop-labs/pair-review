// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

const {
  LOCAL_PATH_IS_URL_CODE,
  localReviewPathUrlError,
  isUrlLikeLocalReviewPath,
  rejectUrlLikeLocalReviewPath,
  isLocalPathUrlError
} = require('../../src/utils/local-path-input');

const ALT_HOST_CONFIG = {
  enable_graphite: true,
  repos: {
    'myteam/myproject': {
      api_host: 'https://api.althost.example/api/v3',
      links: {
        external: {
          name: 'AltHost',
          label: 'Open on AltHost',
          url_template: 'https://althost.example/{owner}/{repo}/pull/{number}'
        }
      }
    }
  }
};

describe('local path input validation', () => {
  it('detects URL inputs', () => {
    expect(isUrlLikeLocalReviewPath('https://github.com/owner/repo/pull/123')).toBe(true);
    expect(isUrlLikeLocalReviewPath('github.com/owner/repo/pull/123')).toBe(true);
    expect(isUrlLikeLocalReviewPath('app.graphite.com/github/pr/owner/repo/123')).toBe(true);
    expect(isUrlLikeLocalReviewPath('app.graphite.dev/github/owner/repo/pull/123')).toBe(true);
    expect(isUrlLikeLocalReviewPath('http://localhost:7247/local')).toBe(true);
    expect(isUrlLikeLocalReviewPath('file:///Users/test/repo')).toBe(true);
  });

  it('detects SSH remote-style inputs', () => {
    expect(isUrlLikeLocalReviewPath('git@github.com:owner/repo.git')).toBe(true);
  });

  it('allows filesystem path forms', () => {
    expect(isUrlLikeLocalReviewPath('/Users/test/repo')).toBe(false);
    expect(isUrlLikeLocalReviewPath('~/src/repo')).toBe(false);
    expect(isUrlLikeLocalReviewPath('relative/path')).toBe(false);
    expect(isUrlLikeLocalReviewPath('/tmp/git@github.com:owner/repo')).toBe(false);
    expect(isUrlLikeLocalReviewPath('nested/git@github.com:owner/repo')).toBe(false);
    expect(isUrlLikeLocalReviewPath('C:\\Users\\test\\repo')).toBe(false);
    expect(isUrlLikeLocalReviewPath('C:\\Users\\git@github.com:owner\\repo')).toBe(false);
    expect(isUrlLikeLocalReviewPath('')).toBe(false);
    expect(isUrlLikeLocalReviewPath(null)).toBe(false);
  });

  it('throws a user-facing error for URL inputs', () => {
    expect(() => rejectUrlLikeLocalReviewPath('https://github.com/owner/repo/pull/123'))
      .toThrow(localReviewPathUrlError());
  });

  it('stamps a stable error code so callers need not match on message text', () => {
    let caught = null;
    try {
      rejectUrlLikeLocalReviewPath('https://github.com/owner/repo/pull/123', ALT_HOST_CONFIG);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe(LOCAL_PATH_IS_URL_CODE);
    expect(isLocalPathUrlError(caught)).toBe(true);
    expect(isLocalPathUrlError(new Error('Path does not exist: /nope'))).toBe(false);
    expect(isLocalPathUrlError(null)).toBe(false);
  });

  describe('host-aware messaging', () => {
    // Without a config the message must NOT name the built-ins: config-free
    // callers (parseArgs) would then claim Graphite/alt-host URLs are
    // unsupported on installs where they are accepted.
    it('stays host-neutral with no config', () => {
      expect(localReviewPathUrlError()).toBe(
        'Local reviews require a filesystem path, not a URL. '
        + 'Pass PR URLs as PR review inputs instead.'
      );
      expect(localReviewPathUrlError(null)).toBe(localReviewPathUrlError());
    });

    it('names only GitHub for a config with no extra hosts', () => {
      expect(localReviewPathUrlError({})).toBe(
        'Local reviews require a filesystem path, not a URL. '
        + 'Pass GitHub URLs as PR review inputs instead.'
      );
    });

    it('names Graphite only when it is enabled', () => {
      expect(localReviewPathUrlError({ enable_graphite: false }))
        .toContain('Pass GitHub URLs');
      expect(localReviewPathUrlError({ enable_graphite: true }))
        .toContain('Pass GitHub or Graphite URLs');
    });

    it('names configured alt hosts', () => {
      expect(localReviewPathUrlError(ALT_HOST_CONFIG))
        .toContain('Pass GitHub, Graphite, or AltHost URLs');
    });
  });

  describe('alt-host URL detection', () => {
    it('does not recognise a scheme-less alt-host URL without config', () => {
      expect(isUrlLikeLocalReviewPath('althost.example/myteam/myproject/pull/42')).toBe(false);
    });

    it('recognises the alt host web domain from links.external.url_template', () => {
      expect(isUrlLikeLocalReviewPath('althost.example/myteam/myproject/pull/42', ALT_HOST_CONFIG))
        .toBe(true);
    });

    it('recognises the alt host api domain from api_host', () => {
      expect(isUrlLikeLocalReviewPath('api.althost.example/api/v3/repos/x', ALT_HOST_CONFIG))
        .toBe(true);
    });

    it('is case-insensitive on the hostname', () => {
      expect(isUrlLikeLocalReviewPath('AltHost.Example/myteam/myproject/pull/42', ALT_HOST_CONFIG))
        .toBe(true);
    });

    it('still treats a hostname-shaped directory name as a path', () => {
      expect(isUrlLikeLocalReviewPath('althost.example', ALT_HOST_CONFIG)).toBe(false);
      expect(isUrlLikeLocalReviewPath('/src/althost.example/repo', ALT_HOST_CONFIG)).toBe(false);
    });

    // `api_host` is only validated as a non-empty string, so a bare hostname
    // (no scheme) is a supported configuration and must still be detected.
    it('recognises a scheme-less api_host', () => {
      const config = { repos: { 'owner/repo': { api_host: 'ghe.example.com' } } };
      expect(isUrlLikeLocalReviewPath('ghe.example.com/owner/repo/pull/1', config)).toBe(true);
    });

    // A user pastes the host with its port; URL.hostname alone would drop it.
    it('recognises an alt host pasted with its port', () => {
      const config = {
        repos: { 'owner/repo': { api_host: 'https://ghe.example.com:8443/api/v3' } }
      };
      expect(isUrlLikeLocalReviewPath('ghe.example.com:8443/owner/repo/pull/1', config)).toBe(true);
      expect(isUrlLikeLocalReviewPath('ghe.example.com/owner/repo/pull/1', config)).toBe(true);
    });
  });
});
