// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the frontend repo-links helper
 * (public/js/repo-links.js).
 *
 * Only the pure URL-template substitution logic is exercised here.
 * DOM-touching code paths (parseSvgIcon, buildExternalLink,
 * applyRepoLinks) require a browser context and are covered by the
 * Playwright E2E suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);

// The frontend module guards its `window.RepoLinks = ...` assignment so
// it can be required from Node without throwing. The module.exports
// includes substituteUrlTemplate and the host-identity accessors.
const RepoLinks = require2('../../public/js/repo-links.js');
const { substituteUrlTemplate } = RepoLinks;

describe('frontend substituteUrlTemplate', () => {
  it('substitutes all whitelisted placeholders', () => {
    const url = substituteUrlTemplate(
      'https://althost.example/{owner}/{repo}/pull/{number}',
      { owner: 'acme', repo: 'widget', number: 42 }
    );
    expect(url).toBe('https://althost.example/acme/widget/pull/42');
  });

  it('URL-encodes special characters in values', () => {
    const url = substituteUrlTemplate(
      'https://althost.example/branch/{branch}',
      { branch: 'feat/test & demo' }
    );
    expect(url).toBe('https://althost.example/branch/feat%2Ftest%20%26%20demo');
  });

  it('rejects http URLs', () => {
    expect(substituteUrlTemplate(
      'http://althost.example/{owner}',
      { owner: 'acme' }
    )).toBeNull();
  });

  it('returns null when a required placeholder is missing', () => {
    expect(substituteUrlTemplate(
      'https://h/{owner}/{repo}/pull/{number}',
      { owner: 'acme', repo: 'widget' }
    )).toBeNull();
  });

  it('returns null when the substituted url no longer starts with https://', () => {
    // Pathological — substitution should never strip the prefix, but the
    // post-substitution guard re-checks anyway.
    expect(substituteUrlTemplate(
      '{owner}://althost.example',
      { owner: 'http' }
    )).toBeNull();
  });

  it('returns null for non-string templates', () => {
    expect(substituteUrlTemplate(null, {})).toBeNull();
    expect(substituteUrlTemplate(undefined, {})).toBeNull();
    expect(substituteUrlTemplate('', {})).toBeNull();
  });

  it('treats empty-string placeholder values as missing', () => {
    expect(substituteUrlTemplate(
      'https://h/{owner}',
      { owner: '' }
    )).toBeNull();
  });

  it('leaves unknown placeholders as literal text', () => {
    const url = substituteUrlTemplate(
      'https://h/{owner}/{some_unknown}',
      { owner: 'acme', some_unknown: 'x' }
    );
    expect(url).toBe('https://h/acme/{some_unknown}');
  });
});

describe('frontend host accessors (hostName / externalUrl / externalIcon)', () => {
  // Drive fetchAndApplyRepoLinks with a mocked fetch. The accessors read
  // module-scope state set before applyRepoLinks runs; applyRepoLinks
  // harmlessly throws without a DOM and is caught internally.
  function mockLinks(links) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ links })
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('exposes configured name, substituted url, and icon', async () => {
    mockLinks({
      external: {
        name: 'Meteorite',
        label: 'Open on Meteorite',
        url_template: 'https://meteorite.example/{owner}/{repo}/pulls/{number}',
        icon: '<svg><path d="M1 1"/></svg>',
      },
      github: false,
      graphite: false,
    });
    await RepoLinks.fetchAndApplyRepoLinks('acme', 'widget', {
      owner: 'acme', repo: 'widget', number: 7
    });
    expect(RepoLinks.hostName()).toBe('Meteorite');
    expect(RepoLinks.externalUrl()).toBe('https://meteorite.example/acme/widget/pulls/7');
    expect(RepoLinks.externalIcon()).toBe('<svg><path d="M1 1"/></svg>');
  });

  it('falls back to GitHub defaults when no external link is configured', async () => {
    mockLinks({ external: null, github: true, graphite: true });
    await RepoLinks.fetchAndApplyRepoLinks('acme', 'widget', {
      owner: 'acme', repo: 'widget', number: 7
    });
    expect(RepoLinks.hostName()).toBe('GitHub');
    expect(RepoLinks.externalUrl()).toBeNull();
    expect(RepoLinks.externalIcon()).toBeNull();
  });

  it('externalUrl is null when the template needs {number} but Local mode omits it', async () => {
    mockLinks({
      external: {
        name: 'Meteorite',
        label: 'Open on Meteorite',
        url_template: 'https://meteorite.example/{owner}/{repo}/pulls/{number}',
      },
      github: false,
      graphite: false,
    });
    // Local-mode context: no `number`.
    await RepoLinks.fetchAndApplyRepoLinks('acme', 'widget', {
      owner: 'acme', repo: 'widget'
    });
    expect(RepoLinks.hostName()).toBe('Meteorite');   // name still works
    expect(RepoLinks.externalUrl()).toBeNull();        // url substitution fails
  });
});
