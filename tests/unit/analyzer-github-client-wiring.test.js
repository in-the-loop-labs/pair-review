// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Phase 6.5 regression tests: verify that every analyzer call site that runs
 * in PR mode supplies a `githubClient` via options. Without this wiring,
 * `excludePrevious.github` is a silent no-op — the analyzer drops the GitHub
 * dedup section because no client is available to pre-fetch existing
 * comments.
 *
 * The Local-mode call sites intentionally do NOT pass a `githubClient` (no
 * associated PR), so we assert their surrounding code documents that
 * omission rather than asserting on the call shape.
 */
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../../', relativePath), 'utf-8');
}

describe('PR-mode analyzer call sites pass githubClient', () => {
  it('src/main.js — analyzeAllLevels receives githubClient via options', () => {
    const src = readSource('src/main.js');
    expect(src).toMatch(
      /analyzer\.analyzeAllLevels\([^)]*\{\s*githubClient\s*\}\s*\)/
    );
  });

  it('src/routes/pr.js — analyzeLevel1 forwards a constructed analyzerGithubClient', () => {
    const src = readSource('src/routes/pr.js');
    // The route builds analyzerGithubClient from the resolved host binding
    // and forwards it on the analyzer options bag.
    expect(src).toMatch(/analyzerGithubClient\s*=\s*resolved\s*\?\s*new\s+GitHubClient\(resolved\.binding\)/);
    expect(src).toMatch(/analyzer\.analyzeLevel1\([\s\S]*?githubClient:\s*analyzerGithubClient/);
  });

  it('src/routes/pr.js — council launch threads githubClient via modeContext', () => {
    const src = readSource('src/routes/pr.js');
    expect(src).toMatch(/councilGithubClient\s*=\s*resolved\s*\?\s*new\s+GitHubClient\(resolved\.binding\)/);
    expect(src).toMatch(/githubClient:\s*councilGithubClient/);
  });

  it('src/routes/analyses.js — launchCouncilAnalysis destructures and forwards githubClient', () => {
    const src = readSource('src/routes/analyses.js');
    // Destructured from modeContext (multi-line destructure)
    expect(src).toMatch(/const\s*\{[\s\S]*?\bgithubClient\b[\s\S]*?\}\s*=\s*modeContext/);
    // Forwarded to both council analyzer methods
    expect(src).toMatch(
      /runReviewerCentricCouncil\([\s\S]*?githubClient[\s\S]*?\)/
    );
    expect(src).toMatch(
      /runCouncilAnalysis\([\s\S]*?githubClient[\s\S]*?\)/
    );
  });

  it('src/routes/stack-analysis.js — stack analyses build a GitHubClient from the resolved binding', () => {
    const src = readSource('src/routes/stack-analysis.js');
    // Now constructs from a binding-or-token clientArg so alt-host stack
    // analyses route to the configured api_host.
    expect(src).toMatch(
      /stackGithubClient\s*=\s*clientArg\s*\?\s*new\s+deps\.GitHubClient/
    );
    // Passed into both single and council launchers
    expect(src).toMatch(
      /launchStackSingleAnalysis\([^)]*githubClient:\s*stackGithubClient[\s\S]*?\}\s*\);/
    );
    expect(src).toMatch(
      /launchStackCouncilAnalysis\([^)]*githubClient:\s*stackGithubClient[\s\S]*?\}\s*\);/
    );
    // The single launcher hands it to analyzeLevel1
    expect(src).toMatch(/analyzer\.analyzeLevel1\([\s\S]*?githubClient[\s\S]*?\)/);
    // The council launcher hands it to launchCouncilAnalysis via modeContext
    expect(src).toMatch(/launchCouncilAnalysis\([\s\S]*?githubClient[\s\S]*?\}/);
  });

  it('src/routes/mcp.js — PR-mode analyzeLevel1 receives a constructed GitHubClient', () => {
    const src = readSource('src/routes/mcp.js');
    // Imports added for client construction
    expect(src).toMatch(/require\('\.\.\/github\/client'\)/);
    // Now uses resolveHostBinding for per-repo (alt-host) routing.
    expect(src).toMatch(/resolveHostBinding/);
    // PR-mode call site wires it explicitly
    expect(src).toMatch(
      /githubClient:\s*prAnalysisGithubClient/
    );
  });
});

describe('Local-mode analyzer call sites do not pass githubClient', () => {
  it('src/routes/local.js — analyzeLevel1 omits githubClient with a documenting comment', () => {
    const src = readSource('src/routes/local.js');
    expect(src).not.toMatch(/analyzer\.analyzeLevel1\([^)]*githubClient/);
    // A short, near-call comment documents the intentional omission.
    expect(src).toMatch(/[Ll]ocal mode[^\n]*(githubClient|no associated GitHub PR)/);
  });

  it('src/routes/local.js — launchCouncilAnalysis omits githubClient with a documenting comment', () => {
    const src = readSource('src/routes/local.js');
    // Find the council launch site and confirm it has no githubClient on the
    // immediately-preceding 20 lines.
    const idx = src.indexOf('analysesRouter.launchCouncilAnalysis');
    expect(idx).toBeGreaterThan(-1);
    const preamble = src.slice(Math.max(0, idx - 600), idx);
    expect(preamble).toMatch(/[Ll]ocal mode[^\n]*(githubClient|no associated GitHub PR)/);
  });

  it('src/routes/mcp.js — local-mode analyzeLevel1 omits githubClient and is documented', () => {
    const src = readSource('src/routes/mcp.js');
    // Local mode launches use `localMetadata` and `localPath`; verify the
    // local launch has no githubClient and the doc comment is present.
    const localLaunchPattern = /analyzer\.analyzeLevel1\(reviewId, localPath[^)]*\)/g;
    const localLaunches = src.match(localLaunchPattern) || [];
    expect(localLaunches.length).toBeGreaterThan(0);
    for (const call of localLaunches) {
      expect(call).not.toMatch(/githubClient/);
    }
    expect(src).toMatch(/[Ll]ocal mode[^\n]*(githubClient|no associated GitHub PR)/);
  });
});
