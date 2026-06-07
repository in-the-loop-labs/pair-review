// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Regression tests for alt-host clone URL plumbing through findRepositoryPath.
 *
 * Bug history: the Tier 3 fallback in findRepositoryPath hard-coded
 * `https://github.com/${owner}/${repo}.git` for the fresh-clone URL. For
 * alt-host (GitHub Enterprise) PRs with no configured monorepo path, no
 * known/cached clone, and no existing worktree, this caused the fallback
 * clone to attempt github.com — which fails for repositories that only
 * exist on the alt host.
 *
 * The fix threads `cloneUrl` through findRepositoryPath, sourced from
 * `prData.repository.clone_url` (populated by GitHubClient.fetchPullRequest
 * from the resolved host binding). When `cloneUrl` is undefined (older
 * restore snapshots, defensive callers) the Tier 3 fallback keeps the
 * github.com URL so behaviour is unchanged for the simple case.
 *
 * These tests pin (textually — runtime end-to-end is exercised in
 * tests/integration/pr-setup.test.js):
 *   1. findRepositoryPath accepts `cloneUrl` and uses it for the Tier 3 clone.
 *   2. setupPRReview forwards `prData?.repository?.clone_url`.
 *   3. src/main.js headless path forwards the clone URL too.
 *   4. The Tier 3 resolution falls back to the github.com pattern when
 *      `cloneUrl` is undefined (legacy / restore snapshots).
 */
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../../', relativePath), 'utf-8');
}

// ---------------------------------------------------------------------------
// Source-level assertions
// ---------------------------------------------------------------------------

describe('findRepositoryPath — cloneUrl parameter wiring (source level)', () => {
  it('signature accepts cloneUrl alongside bindingRepository', () => {
    const src = readSource('src/setup/pr-setup.js');
    // The signature is `async function findRepositoryPath({ db, owner, repo, repository, bindingRepository, prNumber, config, cloneUrl, onProgress })`.
    expect(src).toMatch(/async function findRepositoryPath\(\{[^}]*\bbindingRepository\b[^}]*\bcloneUrl\b[^}]*\}\)/s);
  });

  it('Tier 3 clone uses the cloneUrl parameter when provided', () => {
    const src = readSource('src/setup/pr-setup.js');
    // The clone() call should reference cloneUrl (not hard-code github.com).
    expect(src).toMatch(/cloneUrl\s*\|\|\s*`https:\/\/github\.com\/\$\{owner\}\/\$\{repo\}\.git`/);
    // And the variable must flow into the actual git.clone() invocation.
    expect(src).toMatch(/git\.clone\(\s*resolvedCloneUrl/);
  });

  it('JSDoc documents the cloneUrl parameter', () => {
    const src = readSource('src/setup/pr-setup.js');
    expect(src).toMatch(/@param\s+\{string\}\s+\[params\.cloneUrl\]/);
  });
});

describe('setupPRReview — forwards prData.repository.clone_url to findRepositoryPath', () => {
  it('passes cloneUrl: prData?.repository?.clone_url through the call', () => {
    const src = readSource('src/setup/pr-setup.js');
    // Find the destructured-args call to findRepositoryPath inside setupPRReview.
    const callBlock = src.match(/await findRepositoryPath\(\{[\s\S]*?\}\)/);
    expect(callBlock).toBeTruthy();
    expect(callBlock[0]).toMatch(/cloneUrl:\s*prData\?\.repository\?\.clone_url/);
  });
});

describe('src/main.js — headless setup forwards prData.repository.clone_url', () => {
  it('passes cloneUrl when calling findRepositoryPath from performHeadlessReview', () => {
    const src = readSource('src/main.js');
    // The headless path's findRepositoryPath call should include cloneUrl.
    const callBlock = src.match(/await findRepositoryPath\(\{[\s\S]*?\}\)/);
    expect(callBlock).toBeTruthy();
    expect(callBlock[0]).toMatch(/cloneUrl:\s*prData\?\.repository\?\.clone_url/);
  });
});

// ---------------------------------------------------------------------------
// Source-level assertion for the Tier 3 branch — the runtime invocation of
// simple-git's clone() is captured by integration tests in
// `tests/integration/pr-setup.test.js`. Here we pin the textual shape so the
// `cloneUrl || …github.com…` resolution stays correct for both branches:
// the explicit alt-host case and the legacy fallback.
// ---------------------------------------------------------------------------

describe('findRepositoryPath — Tier 3 clone URL resolution (textual)', () => {
  const src = readSource('src/setup/pr-setup.js');

  it('Tier 3 declares resolvedCloneUrl = cloneUrl || <github.com>', () => {
    expect(src).toMatch(
      /const\s+resolvedCloneUrl\s*=\s*cloneUrl\s*\|\|\s*`https:\/\/github\.com\/\$\{owner\}\/\$\{repo\}\.git`/
    );
  });

  it('Tier 3 passes resolvedCloneUrl to git.clone with the existing args', () => {
    expect(src).toMatch(
      /git\.clone\(resolvedCloneUrl,\s*cachedRepoPath,\s*\['--filter=blob:none',\s*'--no-checkout'\]\)/
    );
  });
});
