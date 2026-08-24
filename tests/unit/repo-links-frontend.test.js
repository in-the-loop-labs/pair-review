// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the frontend repo-links helper
 * (public/js/repo-links.js).
 *
 * URL-template substitution, SVG sanitisation, and host accessors are exercised
 * against the production helper. DOM-backed tests use Vitest's jsdom runtime.
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

describe('frontend SVG parsing', () => {
  it('removes active HTML embedded through foreignObject', () => {
    const svg = RepoLinks.parseSvgIcon(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<foreignObject width="1" height="1">' +
          '<iframe xmlns="http://www.w3.org/1999/xhtml" srcdoc="&lt;script&gt;parent.document.body.dataset.pwned=1&lt;/script&gt;"></iframe>' +
        '</foreignObject>' +
        '<path d="M1 1h14v14H1z"/>' +
      '</svg>'
    );

    expect(svg).not.toBeNull();
    expect(svg.querySelector('foreignObject')).toBeNull();
    expect(svg.querySelector('iframe')).toBeNull();
    expect(svg.querySelector('path')).not.toBeNull();
  });

  it('keeps local fragment references in every equivalent url() form', () => {
    const svg = RepoLinks.parseSvgIcon(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<defs><linearGradient id="paint0"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
        '<path id="bare" d="M1 1h1v1H1z" fill="url(#paint0)"/>' +
        '<path id="dquote" d="M2 2h1v1H2z" fill="url(&quot;#paint0&quot;)"/>' +
        "<path id='squote' d='M3 3h1v1H3z' fill=\"url('#paint0')\"/>" +
        '<path id="spaced" d="M4 4h1v1H4z" fill=" url(#paint0) "/>' +
      '</svg>'
    );

    expect(svg).not.toBeNull();
    for (const id of ['bare', 'dquote', 'squote', 'spaced']) {
      expect(svg.querySelector('#' + id).getAttribute('fill')).toContain('#paint0');
    }
  });

  it('strips url() references that leave the document', () => {
    const svg = RepoLinks.parseSvgIcon(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<path id="remote" d="M1 1h1v1H1z" fill="url(https://evil.example/x)"/>' +
        '<path id="scheme" d="M2 2h1v1H2z" fill="url(//evil.example/x)"/>' +
        '<path id="data" d="M3 3h1v1H3z" fill="url(data:image/svg+xml,%3Csvg/%3E)"/>' +
        '<path id="mixedquotes" d="M4 4h1v1H4z" fill="url(&quot;#a\')"/>' +
      '</svg>'
    );

    expect(svg).not.toBeNull();
    for (const id of ['remote', 'scheme', 'data', 'mixedquotes']) {
      expect(svg.querySelector('#' + id).hasAttribute('fill')).toBe(false);
    }
  });

  it('still strips scripts and event handlers', () => {
    const svg = RepoLinks.parseSvgIcon(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="window.pwned=1">' +
        '<script>window.pwned = 1</script>' +
        '<path d="M1 1h14v14H1z" onmouseover="window.pwned=1"/>' +
      '</svg>'
    );

    expect(svg).not.toBeNull();
    expect(svg.hasAttribute('onload')).toBe(false);
    expect(svg.querySelector('script')).toBeNull();
    expect(svg.querySelector('path').hasAttribute('onmouseover')).toBe(false);
  });

  it('warns once when sanitisation changes the icon, and stays silent otherwise', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      RepoLinks.parseSvgIcon(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
          '<path d="M1 1h14v14H1z" fill="url(#paint0)"/>' +
        '</svg>'
      );
      expect(warn).not.toHaveBeenCalled();

      RepoLinks.parseSvgIcon(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="window.pwned=1">' +
          '<script>window.pwned = 1</script>' +
          '<path d="M1 1h14v14H1z" fill="url(https://evil.example/x)"/>' +
        '</svg>'
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('[repo-links] Sanitised configured icon');
    } finally {
      warn.mockRestore();
    }
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

  it('passes the PR number as a query param so the server resolves per-PR host', async () => {
    mockLinks({ external: null, github: true, graphite: true });
    await RepoLinks.fetchAndApplyRepoLinks('acme', 'widget', {
      owner: 'acme', repo: 'widget', number: 42
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/repos/acme/widget/links?number=42');
  });

  it('omits the number query when no PR number is known (Local mode)', async () => {
    mockLinks({ external: null, github: true, graphite: true });
    await RepoLinks.fetchAndApplyRepoLinks('acme', 'widget', {
      owner: 'acme', repo: 'widget'
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/repos/acme/widget/links');
  });
});
