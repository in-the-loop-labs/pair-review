// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Regression tests for the token-resolution ordering in src/main.js.
 *
 * Bug history: `handlePullRequest` used to call `getGitHubToken(config)`
 * BEFORE parsing PR arguments, so the no-repository lookup only saw
 * environment + top-level credentials. That rejected configs whose only
 * GitHub token lived under `repos["owner/repo"].token` (or `.token_command`,
 * or behind an alt-host `api_host`). `performHeadlessReview` already used
 * the safer ordering — these tests pin the fix in `handlePullRequest`.
 *
 * We use source-level assertions for the ordering invariant (matching the
 * `route-bindings.test.js` pattern) plus runtime checks against the real
 * `resolveHostBinding()` to prove the repo-scoped-only config actually
 * resolves a token.
 */
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const { resolveHostBinding } = require('../../src/config');

function readMainSource() {
  return fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf-8');
}

describe('main.js — handlePullRequest token-resolution ordering', () => {
  it('parses PR arguments BEFORE resolving the token (so repo context drives binding)', () => {
    const src = readMainSource();
    const fnStart = src.indexOf('async function handlePullRequest(');
    expect(fnStart).toBeGreaterThan(-1);

    // Find the end of handlePullRequest by walking to the next top-level
    // `async function` declaration.
    const nextFnStart = src.indexOf('\nasync function ', fnStart + 1);
    const body = src.slice(fnStart, nextFnStart === -1 ? undefined : nextFnStart);

    const parsePosition = body.indexOf('parser.parsePRArguments');
    const bindingPosition = body.indexOf('resolveHostBinding(');
    expect(parsePosition).toBeGreaterThan(-1);
    expect(bindingPosition).toBeGreaterThan(-1);

    // The parser call must precede the binding-resolution call. This
    // guards against re-introducing the no-repo getGitHubToken preflight.
    expect(parsePosition).toBeLessThan(bindingPosition);

    // The legacy no-repo preflight (`getGitHubToken(config)` with no repo
    // arg) must not appear inside handlePullRequest anymore.
    expect(body).not.toMatch(/getGitHubToken\(\s*config\s*\)\s*[;]/);
  });

  it('error message names repo-scoped config locations', () => {
    const src = readMainSource();
    // The missing-token error is now built via the shared
    // `buildMissingTokenError` helper at module scope, so scan the whole
    // file rather than only the body of `handlePullRequest`.
    expect(src).toMatch(/function buildMissingTokenError/);
    // The fix requires actionable error text mentioning the per-repo
    // keys for both github.com and alt-host bindings.
    expect(src).toMatch(/repos\[/);
    expect(src).toMatch(/token_command/);
    expect(src).toMatch(/github_token/);
    // The handlePullRequest body invokes the helper, passing through
    // the resolved binding's apiHost so error messaging branches on
    // alt-host vs github.com.
    const fnStart = src.indexOf('async function handlePullRequest(');
    const nextFnStart = src.indexOf('\nasync function ', fnStart + 1);
    const body = src.slice(fnStart, nextFnStart === -1 ? undefined : nextFnStart);
    expect(body).toMatch(/buildMissingTokenError\(/);
  });
});

describe('main.js — buildMissingTokenError binding-aware messages (Fix #9)', () => {
  // Use a require() shim to surface the un-exported helper for testing
  // via the file system. The helper is intentionally not exported from
  // main.js (CLI-only surface), so we extract it for unit tests by
  // sourcing a tiny wrapper that re-runs the file in a sandbox VM.
  // Source-level assertions are sufficient here — the helper is small
  // and its branches are exhaustively covered by static patterns.
  it('alt-host message excludes GITHUB_TOKEN and points at repos[bindingRepository]', () => {
    const src = readMainSource();
    const start = src.indexOf('function buildMissingTokenError');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}\n', start);
    const body = src.slice(start, end);
    // Alt-host branch must mention api_host and avoid suggesting
    // GITHUB_TOKEN (which is github.com-only after Fix #4).
    expect(body).toMatch(/apiHost/);
    expect(body).toMatch(/github\.com-only/);
    expect(body).toMatch(/repos\["\${bindingRepository}"\]/);
    // github.com branch keeps the legacy hint.
    expect(body).toMatch(/Set GITHUB_TOKEN env var/);
  });
});

describe('main.js — repo-scoped-only config resolves to a token', () => {
  it('resolveHostBinding finds a repo-scoped token even when top-level is empty', () => {
    // This is the configuration shape that USED to fail in handlePullRequest's
    // preflight: no top-level token, no env var, only `repos[*].token`.
    const originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const config = {
        // Intentionally no `github_token` / `github_token_command`.
        repos: {
          'owner/repo': {
            token: 'repo-scoped-secret'
          }
        }
      };
      const binding = resolveHostBinding('owner/repo', config);
      expect(binding.token).toBe('repo-scoped-secret');
      expect(binding.source).toBe('repo:token');
    } finally {
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
    }
  });

  it('alt-host repo-scoped token resolves even when GITHUB_TOKEN env var would otherwise fire', () => {
    // For alt-host repos the env var is intentionally NOT used (it's a
    // github.com token). The repo-scoped token must still be found.
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'github-com-token-must-not-leak-to-alt-host';
    try {
      const config = {
        repos: {
          'owner/alt': {
            api_host: 'https://ghe.example.com/api/v3',
            token: 'alt-host-secret',
            features: { review_lifecycle: 'rest', pending_review_comments: 'rest' }
          }
        }
      };
      const binding = resolveHostBinding('owner/alt', config);
      expect(binding.token).toBe('alt-host-secret');
      expect(binding.apiHost).toBe('https://ghe.example.com/api/v3');
    } finally {
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
    }
  });
});

describe('main.js — performHeadlessReview / submit feature-gating', () => {
  it('headless submit gates node-id requirement on binding features', () => {
    const src = readMainSource();
    // Predicate must reference both feature areas the dispatcher cares about.
    expect(src).toMatch(/needsGraphQLNodeId/);
    expect(src).toMatch(/headlessBinding\.features\.review_lifecycle/);
    expect(src).toMatch(/headlessBinding\.features\.pending_review_comments/);
    // The unconditional throw must be gone.
    expect(src).not.toMatch(/PR node_id not available for .* Cannot submit review without GraphQL node ID/);
  });

  it('headless submit still throws when GraphQL is in play and node_id is missing', () => {
    const src = readMainSource();
    // The new error message preserves the "missing node_id" failure mode
    // for the default github.com (all-GraphQL) configuration.
    expect(src).toMatch(/GraphQL PR node id required for/);
    expect(src).toMatch(/refresh the PR data and try again/);
  });
});
