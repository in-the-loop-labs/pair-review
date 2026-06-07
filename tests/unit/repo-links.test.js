// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for src/links/repo-links.js
 *
 * Covers the three exported functions:
 *   - substituteUrlTemplate
 *   - sanitizeSvgIcon
 *   - resolveRepoLinks
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

// Use require for the production modules so vi.spyOn on the singleton
// logger intercepts calls from the module under test (it shares the
// same CommonJS instance).
const require2 = createRequire(import.meta.url);
const {
  substituteUrlTemplate,
  sanitizeSvgIcon,
  resolveRepoLinks,
  resolveHostName,
} = require2('../../src/links/repo-links');
const logger = require2('../../src/utils/logger');

describe('substituteUrlTemplate', () => {
  it('substitutes all whitelisted placeholders', () => {
    const url = substituteUrlTemplate(
      'https://althost.example/{owner}/{repo}/pull/{number}',
      { owner: 'acme', repo: 'widget', number: 42 }
    );
    expect(url).toBe('https://althost.example/acme/widget/pull/42');
  });

  it('URL-encodes substituted values', () => {
    const url = substituteUrlTemplate(
      'https://althost.example/{owner}/{repo}/branch/{branch}',
      { owner: 'acme', repo: 'widget', branch: 'feat/spaces & slash' }
    );
    expect(url).toBe(
      'https://althost.example/acme/widget/branch/feat%2Fspaces%20%26%20slash'
    );
  });

  it('supports {base_branch} and {head_sha} placeholders', () => {
    const url = substituteUrlTemplate(
      'https://althost.example/compare/{base_branch}...{head_sha}',
      { base_branch: 'main', head_sha: 'abcdef1234567' }
    );
    expect(url).toBe('https://althost.example/compare/main...abcdef1234567');
  });

  it('rejects non-https URLs', () => {
    expect(substituteUrlTemplate(
      'http://althost.example/{owner}/{repo}',
      { owner: 'acme', repo: 'widget' }
    )).toBeNull();
  });

  it('rejects javascript: URLs', () => {
    expect(substituteUrlTemplate(
      'javascript:alert(1)',
      {}
    )).toBeNull();
  });

  it('returns null for empty or non-string templates', () => {
    expect(substituteUrlTemplate('', {})).toBeNull();
    expect(substituteUrlTemplate(null, {})).toBeNull();
    expect(substituteUrlTemplate(undefined, {})).toBeNull();
    expect(substituteUrlTemplate(42, {})).toBeNull();
  });

  it('returns null when a whitelisted placeholder is missing from context', () => {
    // Incomplete substitution leaves a `{owner}` in the result, which would
    // render as a broken link. Reject instead.
    expect(substituteUrlTemplate(
      'https://althost.example/{owner}/{repo}/pull/{number}',
      { repo: 'widget', number: 42 }
    )).toBeNull();
  });

  it('leaves unknown placeholders as literal text (encoded if substituted elsewhere)', () => {
    // Misconfigurations should be visible (broken link), not silently
    // substituted with arbitrary fields. The `{evil_attribute}` literal
    // is encoded by the URL parser only after a known placeholder is
    // substituted around it; here it remains a literal segment in the
    // path.
    const url = substituteUrlTemplate(
      'https://althost.example/{owner}/{evil_attribute}',
      { owner: 'acme', evil_attribute: 'hijacked' }
    );
    expect(url).toBe('https://althost.example/acme/{evil_attribute}');
  });

  it('handles all whitelisted placeholders together', () => {
    const url = substituteUrlTemplate(
      'https://h/{owner}/{repo}/{number}/{branch}/{base_branch}/{head_sha}',
      {
        owner: 'o', repo: 'r', number: 1,
        branch: 'b', base_branch: 'main', head_sha: 'aaaaaaa'
      }
    );
    expect(url).toBe('https://h/o/r/1/b/main/aaaaaaa');
  });

  it('coerces number to string for encoding', () => {
    const url = substituteUrlTemplate(
      'https://h/p/{number}',
      { number: 7 }
    );
    expect(url).toBe('https://h/p/7');
  });

  it('rejects empty-string placeholder values (treats as missing)', () => {
    expect(substituteUrlTemplate(
      'https://h/{owner}/{repo}',
      { owner: '', repo: 'r' }
    )).toBeNull();
  });
});

describe('sanitizeSvgIcon', () => {
  it('returns null for non-string or empty inputs', () => {
    expect(sanitizeSvgIcon(null)).toBeNull();
    expect(sanitizeSvgIcon(undefined)).toBeNull();
    expect(sanitizeSvgIcon('')).toBeNull();
    expect(sanitizeSvgIcon('   ')).toBeNull();
    expect(sanitizeSvgIcon(42)).toBeNull();
  });

  it('returns null for input that does not look like SVG', () => {
    expect(sanitizeSvgIcon('<div>not svg</div>')).toBeNull();
    expect(sanitizeSvgIcon('just text')).toBeNull();
  });

  it('passes through a benign SVG unchanged', () => {
    const input = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></svg>';
    expect(sanitizeSvgIcon(input)).toBe(input);
  });

  it('strips paired <script> blocks', () => {
    const input = '<svg><script>alert(1)</script><path d="M1 1"/></svg>';
    const out = sanitizeSvgIcon(input);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<path');
  });

  it('strips unpaired <script> open tags', () => {
    const input = '<svg><script src="evil.js"><path d="M1 1"/></svg>';
    const out = sanitizeSvgIcon(input);
    expect(out).not.toContain('<script');
    expect(out).toContain('<path');
  });

  it('strips on* event handler attributes', () => {
    const input = '<svg onload="alert(1)" onclick="evil()"><path d="M1 1"/></svg>';
    const out = sanitizeSvgIcon(input);
    expect(out).not.toMatch(/\son[a-zA-Z]+\s*=/);
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<path');
  });

  it('strips javascript: URLs', () => {
    const input = '<svg><a href="javascript:alert(1)"><path d="M1 1"/></a></svg>';
    const out = sanitizeSvgIcon(input);
    expect(out).not.toContain('javascript:');
    expect(out).toContain('<path');
  });

  it('strips multiple threats in one icon', () => {
    const input = `<svg onload="x()">
      <script>bad()</script>
      <a href="javascript:also()"><path d="M1 1"/></a>
    </svg>`;
    const out = sanitizeSvgIcon(input);
    expect(out).not.toContain('<script');
    expect(out).not.toMatch(/\son[a-zA-Z]+\s*=/);
    expect(out).not.toContain('javascript:');
    expect(out).toContain('<path');
  });

  it('returns a non-null result for a clean SVG', () => {
    const out = sanitizeSvgIcon('<svg><path></path></svg>');
    expect(out).not.toBeNull();
  });
});

describe('resolveRepoLinks', () => {
  it('returns defaults when no config is provided', () => {
    const result = resolveRepoLinks(null, 'acme/widget');
    expect(result).toEqual({ external: null, github: true, graphite: true });
  });

  it('returns defaults when repository is not provided', () => {
    const result = resolveRepoLinks({ repos: {} }, '');
    expect(result).toEqual({ external: null, github: true, graphite: true });
  });

  it('returns defaults when repo has no entry', () => {
    const config = { repos: { 'other/repo': { links: { github: false } } } };
    const result = resolveRepoLinks(config, 'acme/widget');
    expect(result).toEqual({ external: null, github: true, graphite: true });
  });

  it('returns defaults when repo has no links key', () => {
    const config = { repos: { 'acme/widget': {} } };
    const result = resolveRepoLinks(config, 'acme/widget');
    expect(result).toEqual({ external: null, github: true, graphite: true });
  });

  it('honours links.github = false', () => {
    const config = { repos: { 'acme/widget': { links: { github: false } } } };
    const result = resolveRepoLinks(config, 'acme/widget');
    expect(result.github).toBe(false);
    expect(result.graphite).toBe(true);
  });

  it('honours links.graphite = false', () => {
    const config = { repos: { 'acme/widget': { links: { graphite: false } } } };
    const result = resolveRepoLinks(config, 'acme/widget');
    expect(result.github).toBe(true);
    expect(result.graphite).toBe(false);
  });

  it('treats links.github = true as enabled', () => {
    const config = { repos: { 'acme/widget': { links: { github: true } } } };
    expect(resolveRepoLinks(config, 'acme/widget').github).toBe(true);
  });

  it('returns external link with sanitised icon', () => {
    const config = {
      repos: {
        'acme/widget': {
          links: {
            external: {
              label: 'Open on AltHost',
              url_template: 'https://althost.example/{owner}/{repo}/pull/{number}',
              icon: '<svg><script>bad()</script><path d="M1 1"/></svg>',
            }
          }
        }
      }
    };
    const result = resolveRepoLinks(config, 'acme/widget');
    expect(result.external).not.toBeNull();
    expect(result.external.label).toBe('Open on AltHost');
    expect(result.external.url_template).toBe(
      'https://althost.example/{owner}/{repo}/pull/{number}'
    );
    expect(result.external.icon).toContain('<path');
    expect(result.external.icon).not.toContain('<script');
  });

  it('returns the configured name, and null when name is omitted', () => {
    const withName = {
      repos: {
        'acme/widget': {
          links: {
            external: {
              name: 'Meteorite',
              label: 'Open on Meteorite',
              url_template: 'https://meteorite.example/{owner}/{repo}/pulls/{number}',
            }
          }
        }
      }
    };
    expect(resolveRepoLinks(withName, 'acme/widget').external.name).toBe('Meteorite');

    const withoutName = {
      repos: {
        'acme/widget': {
          links: {
            external: {
              label: 'Open on AltHost',
              url_template: 'https://althost.example/x',
            }
          }
        }
      }
    };
    expect(resolveRepoLinks(withoutName, 'acme/widget').external.name).toBeNull();
  });

  it('returns external link with null icon when icon is missing', () => {
    const config = {
      repos: {
        'acme/widget': {
          links: {
            external: {
              label: 'Open on AltHost',
              url_template: 'https://althost.example/x',
            }
          }
        }
      }
    };
    const result = resolveRepoLinks(config, 'acme/widget');
    expect(result.external).not.toBeNull();
    expect(result.external.icon).toBeNull();
  });

  it('logs a warning when an icon fails sanitisation and drops it', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const config = {
        repos: {
          'acme/widget': {
            links: {
              external: {
                label: 'Open on AltHost',
                url_template: 'https://althost.example/x',
                // Not SVG markup — sanitizer rejects.
                icon: '<div>not svg</div>',
              }
            }
          }
        }
      };
      const result = resolveRepoLinks(config, 'acme/widget');
      expect(result.external).not.toBeNull();
      expect(result.external.icon).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('acme/widget');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rejects an external block with missing label', () => {
    const config = {
      repos: {
        'acme/widget': {
          links: {
            external: { url_template: 'https://althost.example/x' }
          }
        }
      }
    };
    expect(resolveRepoLinks(config, 'acme/widget').external).toBeNull();
  });

  it('rejects an external block with non-https template', () => {
    const config = {
      repos: {
        'acme/widget': {
          links: {
            external: {
              label: 'Open',
              url_template: 'http://althost.example/x',
            }
          }
        }
      }
    };
    expect(resolveRepoLinks(config, 'acme/widget').external).toBeNull();
  });

  it('is case-insensitive on the repo key', () => {
    const config = {
      repos: { 'Acme/Widget': { links: { github: false } } }
    };
    expect(resolveRepoLinks(config, 'acme/widget').github).toBe(false);
  });
});

describe('resolveHostName', () => {
  it('returns the configured host name', () => {
    const config = {
      repos: {
        'acme/widget': {
          links: {
            external: {
              name: 'Meteorite',
              label: 'Open on Meteorite',
              url_template: 'https://meteorite.example/{owner}/{repo}/pulls/{number}',
            }
          }
        }
      }
    };
    expect(resolveHostName(config, 'acme/widget')).toBe('Meteorite');
  });

  it('falls back to "GitHub" when no name is configured', () => {
    const noName = {
      repos: {
        'acme/widget': {
          links: {
            external: {
              label: 'Open on AltHost',
              url_template: 'https://althost.example/x',
            }
          }
        }
      }
    };
    expect(resolveHostName(noName, 'acme/widget')).toBe('GitHub');
  });

  it('falls back to "GitHub" with no config / no external link', () => {
    expect(resolveHostName(null, 'acme/widget')).toBe('GitHub');
    expect(resolveHostName({ repos: {} }, 'acme/widget')).toBe('GitHub');
  });
});
