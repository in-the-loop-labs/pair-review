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

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);

// The frontend module guards its `window.RepoLinks = ...` assignment so
// it can be required from Node without throwing. The module.exports
// includes substituteUrlTemplate.
const { substituteUrlTemplate } = require2('../../public/js/repo-links.js');

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
