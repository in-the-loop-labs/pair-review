// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Regression tests for the `gh` CLI removal in src/ai/analyzer.js.
 *
 * Previously the analyzer embedded a `gh api repos/.../comments --paginate`
 * shell command into the dedup prompt, forcing the AI to spawn the `gh` CLI
 * to fetch existing PR review comments. The alt-host work removed that
 * dependency by pre-fetching the comments server-side via an injected
 * GitHubClient (Octokit).
 *
 * These tests pin the new behaviour:
 *   - fetchExistingReviewComments delegates to octokit.paginate with the
 *     pulls.listReviewComments endpoint.
 *   - It returns a simplified shape and handles failures/missing clients
 *     gracefully.
 *   - The analyzer source no longer contains a literal `gh api` shell
 *     invocation (only documentation references in comments).
 */
import { describe, it, expect, vi } from 'vitest';

const fs = require('fs');
const path = require('path');

const {
  fetchExistingReviewComments,
  buildDedupInstructions,
} = require('../../src/ai/analyzer');

/**
 * Build a fake GitHubClient that exposes an Octokit-shaped surface with a
 * spyable `paginate` and the `rest.pulls.listReviewComments` endpoint we
 * delegate to.
 */
function createFakeGithubClient(paginateImpl) {
  const listReviewComments = vi.fn();
  const paginate = vi.fn(paginateImpl);
  return {
    paginate,
    listReviewComments,
    octokit: {
      paginate,
      rest: {
        pulls: { listReviewComments },
      },
    },
  };
}

describe('fetchExistingReviewComments', () => {
  it('calls octokit.paginate with rest.pulls.listReviewComments and the target args', async () => {
    const raw = [
      { path: 'a.js', line: 10, original_line: 9, body: 'one', extra: 'ignored' },
      { path: 'b.js', line: null, original_line: 22, body: 'two' },
    ];
    const client = createFakeGithubClient(async () => raw);

    const result = await fetchExistingReviewComments(
      client,
      { owner: 'acme', repo: 'widgets', pullNumber: 42 },
      '[test]'
    );

    expect(client.paginate).toHaveBeenCalledTimes(1);
    const [endpoint, args] = client.paginate.mock.calls[0];
    expect(endpoint).toBe(client.octokit.rest.pulls.listReviewComments);
    expect(args).toEqual({
      owner: 'acme',
      repo: 'widgets',
      pull_number: 42,
      per_page: 100,
    });

    // Returned shape is the simplified projection used by the prompt.
    // Both single-line endpoint (`line`/`original_line`) and multi-line
    // endpoint (`start_line`/`original_start_line`) fields are preserved
    // so dedup can match range comments correctly.
    expect(result).toEqual([
      { path: 'a.js', line: 10, start_line: null, original_line: 9, original_start_line: null, body: 'one' },
      { path: 'b.js', line: null, start_line: null, original_line: 22, original_start_line: null, body: 'two' },
    ]);
  });

  it('returns null when no githubClient is provided', async () => {
    expect(await fetchExistingReviewComments(null, { owner: 'a', repo: 'b', pullNumber: 1 })).toBeNull();
    expect(await fetchExistingReviewComments(undefined, { owner: 'a', repo: 'b', pullNumber: 1 })).toBeNull();
  });

  it('returns null when the client lacks an octokit field', async () => {
    expect(await fetchExistingReviewComments({}, { owner: 'a', repo: 'b', pullNumber: 1 })).toBeNull();
  });

  it('returns null when owner, repo, or pullNumber is missing', async () => {
    const client = createFakeGithubClient(async () => []);
    expect(await fetchExistingReviewComments(client, { repo: 'b', pullNumber: 1 })).toBeNull();
    expect(await fetchExistingReviewComments(client, { owner: 'a', pullNumber: 1 })).toBeNull();
    expect(await fetchExistingReviewComments(client, { owner: 'a', repo: 'b' })).toBeNull();
    expect(await fetchExistingReviewComments(client, undefined)).toBeNull();
    expect(client.paginate).not.toHaveBeenCalled();
  });

  it('returns null and does not throw when octokit.paginate rejects', async () => {
    const client = createFakeGithubClient(async () => {
      throw new Error('network down');
    });

    const result = await fetchExistingReviewComments(
      client,
      { owner: 'acme', repo: 'widgets', pullNumber: 42 }
    );
    expect(result).toBeNull();
  });

  it('returns an empty array when there are no existing comments', async () => {
    const client = createFakeGithubClient(async () => []);
    const result = await fetchExistingReviewComments(
      client,
      { owner: 'acme', repo: 'widgets', pullNumber: 42 }
    );
    expect(result).toEqual([]);
  });

  it('normalises missing line/original_line fields to null', async () => {
    const client = createFakeGithubClient(async () => [
      { path: 'x.js', body: 'no lines provided' },
    ]);

    const result = await fetchExistingReviewComments(
      client,
      { owner: 'acme', repo: 'widgets', pullNumber: 1 }
    );
    expect(result).toEqual([
      { path: 'x.js', line: null, start_line: null, original_line: null, original_start_line: null, body: 'no lines provided' },
    ]);
  });

  it('preserves multi-line range endpoints (start_line / original_start_line)', async () => {
    const client = createFakeGithubClient(async () => [
      {
        path: 'src/foo.js',
        line: 30,
        start_line: 25,
        original_line: 28,
        original_start_line: 23,
        body: 'consider extracting this block'
      }
    ]);

    const result = await fetchExistingReviewComments(
      client,
      { owner: 'acme', repo: 'widgets', pullNumber: 1 }
    );
    expect(result).toEqual([
      {
        path: 'src/foo.js',
        line: 30,
        start_line: 25,
        original_line: 28,
        original_start_line: 23,
        body: 'consider extracting this block'
      }
    ]);
  });

  it('the fetched comments flow into the GitHub dedup section without any gh CLI mention', async () => {
    const client = createFakeGithubClient(async () => [
      { path: 'src/foo.js', line: 12, original_line: 12, body: 'add validation' },
    ]);

    const comments = await fetchExistingReviewComments(
      client,
      { owner: 'acme', repo: 'widgets', pullNumber: 5 }
    );

    const section = buildDedupInstructions(
      { github: true },
      { githubComments: comments }
    );
    expect(section).toContain('### GitHub PR Review Comments');
    expect(section).toContain('src/foo.js');
    expect(section).toContain('add validation');
    expect(section).not.toContain('gh api');
    expect(section).not.toMatch(/\bgh\b\s+\w/);
  });
});

describe('analyzer source no longer shells out to the gh CLI', () => {
  const analyzerPath = path.join(__dirname, '../../src/ai/analyzer.js');
  const source = fs.readFileSync(analyzerPath, 'utf-8');

  it('does not contain a live `gh api` invocation', () => {
    // Strip block and line comments so we only inspect executable code.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .join('\n');

    expect(stripped).not.toMatch(/gh\s+api\s+repos/);
    expect(stripped).not.toMatch(/`gh\s+api/);
  });

  it('does not invoke execSync/exec/execPromise with a gh command', () => {
    expect(source).not.toMatch(/exec(Sync|Promise)?\(\s*['"`]gh\s/);
    expect(source).not.toMatch(/spawn(Sync)?\(\s*['"`]gh['"`]/);
  });

  it('imports octokit pagination via the GitHubClient (does not instantiate Octokit inline)', () => {
    // The analyzer must use the caller-supplied githubClient. Confirm we
    // never construct a new Octokit ourselves inside this module.
    expect(source).not.toMatch(/new\s+Octokit\s*\(/);
    expect(source).not.toMatch(/require\(\s*['"`]@octokit\/rest['"`]\s*\)/);
  });

  it('all three analysis paths accept a githubClient option', () => {
    // analyzeAllLevels, runReviewerCentricCouncil, runCouncilAnalysis must
    // each thread githubClient through to the prompt-building step. We
    // assert each method destructures `githubClient` from its options.
    expect(source).toMatch(/async\s+analyzeAllLevels\([\s\S]*?const\s*\{[^}]*githubClient[^}]*\}\s*=\s*options/);
    expect(source).toMatch(/async\s+runReviewerCentricCouncil\([\s\S]*?const\s*\{[^}]*githubClient[^}]*\}\s*=\s*options/);
    expect(source).toMatch(/async\s+runCouncilAnalysis\([\s\S]*?const\s*\{[^}]*githubClient[^}]*\}\s*=\s*options/);
  });
});
