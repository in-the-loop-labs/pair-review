// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Phase 10 regression tests: every route call site that constructs a
 * `GitHubClient` for a known repository routes through `resolveHostBinding`
 * so alt-host repos talk to the configured `api_host` with the configured
 * per-repo token — not the server-startup github.com token.
 *
 * These are source-level checks (matching the pattern used by
 * analyzer-github-client-wiring.test.js) and runtime checks that verify
 * the Octokit baseUrl is set when the binding includes an apiHost.
 */
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const { GitHubClient } = require('../../src/github/client');
const { resolveHostBinding } = require('../../src/config');

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../../', relativePath), 'utf-8');
}

describe('PR-mode route call sites use host bindings (alt-host safety)', () => {
  it('src/routes/pr.js — every new GitHubClient(...) takes a binding or binding-derived arg', () => {
    const src = readSource('src/routes/pr.js');
    const lines = src.split('\n');
    const offenders = [];
    lines.forEach((line, idx) => {
      const match = line.match(/new GitHubClient\(([^)]*)\)/);
      if (!match) return;
      const arg = match[1].trim();
      // Accept binding shapes only; reject bare-token variables.
      const ok = /\.binding\b/.test(arg) || /\bbinding\b/.test(arg);
      if (!ok) offenders.push(`L${idx + 1}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });

  it('src/routes/pr.js — never falls back to req.app.get("githubToken") for alt-host repos', () => {
    const src = readSource('src/routes/pr.js');
    // The old pattern `getGitHubToken(config) || req.app.get('githubToken')`
    // is now centralised in `resolveBindingForRequest()`, which throws on
    // alt-host misconfiguration. Direct `req.app.get('githubToken')` reads
    // must not appear outside that helper — count code lines only (strip
    // single-line comments so JSDoc references don't fail the assertion).
    const codeOnly = src
      .split('\n')
      .map(line => {
        const trimmed = line.trim();
        // Drop lines that are comments
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
        return line;
      })
      .join('\n');
    const directReads = (codeOnly.match(/req\.app\.get\(['"]githubToken['"]\)/g) || []).length;
    expect(directReads).toBeLessThanOrEqual(1); // only inside resolveBindingForRequest
  });

  it('src/main.js — headless PR paths resolve a per-PR host binding before fetching', () => {
    const src = readSource('src/main.js');
    // Preflight resolves a binding (tolerating dual repos with an alt-only token)
    // for the fail-fast credential check...
    expect(src).toMatch(/resolvePreflightBinding\(/);
    // ...and the fetch routes through the shared host-aware helper (which
    // constructs the GitHubClient from the chosen binding, never a bare token).
    expect(src).toMatch(/resolvePrHostBinding\(/);
    expect(src).not.toMatch(/new GitHubClient\(githubToken\)/);
  });

  it('src/setup/pr-setup.js — setupPRReview routes through a host binding', () => {
    const src = readSource('src/setup/pr-setup.js');
    expect(src).toMatch(/resolveHostBinding\(/);
  });

  it('src/setup/stack-setup.js — accepts a binding parameter alongside githubToken', () => {
    const src = readSource('src/setup/stack-setup.js');
    expect(src).toMatch(/\bbinding\b/);
    expect(src).toMatch(/new GitHubClient\(binding\s*\|\|\s*githubToken\)/);
  });

  it('src/routes/stack-analysis.js — resolves the binding for the stack repo', () => {
    const src = readSource('src/routes/stack-analysis.js');
    // Must resolve the config-binding key first (handles monorepo url_pattern
    // configs where the config key differs from `${owner}/${repo}`), then
    // pass that key into `resolveHostBinding`.
    expect(src).toMatch(/resolveBindingRepositoryFromPR\(owner, repo, config\)/);
    // Now host-aware: the third arg pins the main PR's stored host for the stack.
    expect(src).toMatch(/resolveHostBinding\(bindingRepository, config, stackHostOption \|\| \{\}\)/);
    expect(src).toMatch(/new deps\.GitHubClient\(stackBinding\)/);
  });

  it('src/routes/mcp.js — PR-mode analysis uses the per-repo binding', () => {
    const src = readSource('src/routes/mcp.js');
    expect(src).toMatch(/resolveHostBinding\(repository, config\)/);
    expect(src).toMatch(/new GitHubClient\(prAnalysisBinding\)/);
  });

  it('src/git/base-branch.js — accepts a host binding via _deps.getHostBinding', () => {
    const src = readSource('src/git/base-branch.js');
    expect(src).toMatch(/getHostBinding/);
  });
});

describe('GitHubClient honours binding.apiHost', () => {
  it('uses Octokit baseUrl when binding.apiHost is set', () => {
    const binding = resolveHostBinding('owner/alt', {
      repos: {
        'owner/alt': {
          api_host: 'https://althost.example/api/v3',
          token: 'alt-token',
          features: { stack_walker: 'rest', pending_review_check: 'rest', review_lifecycle: 'rest', pending_review_comments: 'host' }
        }
      }
    });
    const client = new GitHubClient(binding);
    // The exposed `.binding.apiHost` should match what was configured.
    expect(client.binding.apiHost).toBe('https://althost.example/api/v3');
    expect(client.apiHost).toBe('https://althost.example/api/v3');
    // Octokit options carry the same value.
    // (Octokit normalises trailing slashes; an undefined baseUrl is the
    // default https://api.github.com — verify it isn't defaulted here.)
    const optsBaseUrl = (client.octokit?.request?.endpoint?.DEFAULTS || {}).baseUrl
      || client.octokit?.request?.endpoint?.baseUrl;
    if (optsBaseUrl) {
      expect(String(optsBaseUrl)).toMatch(/althost\.example/);
    }
  });

  it('defaults to github.com when no apiHost is configured', () => {
    const client = new GitHubClient('plain-token');
    expect(client.binding.apiHost).toBe(null);
    expect(client.apiHost).toBe(null);
  });

  it('threads features from the binding into the client', () => {
    const binding = resolveHostBinding('owner/alt', {
      repos: {
        'owner/alt': {
          api_host: 'https://althost.example/api/v3',
          token: 'alt-token',
          features: {
            stack_walker: 'rest',
            pending_review_check: 'rest',
            review_lifecycle: 'rest',
            pending_review_comments: 'host'
          }
        }
      }
    });
    const client = new GitHubClient(binding);
    expect(client.features.stack_walker).toBe('rest');
    expect(client.features.pending_review_comments).toBe('host');
    // The dispatcher path reads `client.binding.features.stack_walker` —
    // verify the binding accessor exposes it.
    expect(client.binding.features.stack_walker).toBe('rest');
  });
});
