// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePrRange, loadConfig } from '../src/config.js';

// ===========================================================================
// parsePrRange
// ===========================================================================
describe('parsePrRange', () => {
  it('parses a single number', () => {
    expect(parsePrRange('3')).toEqual([3]);
  });

  it('parses a simple range', () => {
    expect(parsePrRange('1-5')).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses comma-separated numbers', () => {
    expect(parsePrRange('1,3,5')).toEqual([1, 3, 5]);
  });

  it('parses mixed ranges and numbers', () => {
    expect(parsePrRange('1-3,7,9-10')).toEqual([1, 2, 3, 7, 9, 10]);
  });

  it('handles whitespace around segments', () => {
    expect(parsePrRange(' 1 - 3 , 7 , 9 - 10 ')).toEqual([1, 2, 3, 7, 9, 10]);
  });

  it('throws on empty string', () => {
    expect(() => parsePrRange('')).toThrow(/Invalid PR range/);
  });

  it('throws on non-string input', () => {
    expect(() => parsePrRange(undefined)).toThrow(/Invalid PR range/);
    expect(() => parsePrRange(null)).toThrow(/Invalid PR range/);
    expect(() => parsePrRange(42)).toThrow(/Invalid PR range/);
  });

  it('throws on invalid characters', () => {
    expect(() => parsePrRange('abc')).toThrow(/Invalid PR number/);
    expect(() => parsePrRange('1,abc,3')).toThrow(/Invalid PR number/);
  });

  it('throws on negative numbers', () => {
    expect(() => parsePrRange('-1')).toThrow();
  });

  it('throws on reversed range', () => {
    expect(() => parsePrRange('5-1')).toThrow(/start.*must be <= end/i);
  });

  it('throws on zero', () => {
    expect(() => parsePrRange('0')).toThrow(/positive integer/);
  });

  it('handles single-element range like "3-3"', () => {
    expect(parsePrRange('3-3')).toEqual([3]);
  });
});

// ===========================================================================
// loadConfig
// ===========================================================================
describe('loadConfig', () => {
  /** @type {string} temp directory for test config files */
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pair-review-config-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(filename, content) {
    const filePath = join(tmpDir, filename);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  const VALID_YAML = `
repos:
  - name: test-repo
    github: org/test-repo
    prs: [1, 2, 3]

defaults:
  provider: claude
  model: sonnet
  tier: balanced

matching:
  line_tolerance: 5

scoring:
  severity_weights:
    critical: 4
    high: 3
    medium: 2
    low: 1
`;

  it('loads a valid config from a YAML file', () => {
    const configPath = writeConfig('eval-config.yaml', VALID_YAML);
    const config = loadConfig({ configPath });

    expect(config.repos).toHaveLength(1);
    expect(config.repos[0].name).toBe('test-repo');
    expect(config.repos[0].github).toBe('org/test-repo');
    expect(config.repos[0].prs).toEqual([1, 2, 3]);
    expect(config.defaults.provider).toBe('claude');
    expect(config.defaults.model).toBe('sonnet');
    expect(config.defaults.tier).toBe('balanced');
    expect(config.matching.line_tolerance).toBe(5);
    expect(config.scoring.severity_weights.critical).toBe(4);
  });

  it('loads the default config from eval-config.yaml', () => {
    // Load without specifying configPath — uses the real default
    const config = loadConfig();

    expect(config.repos).toBeDefined();
    expect(Array.isArray(config.repos)).toBe(true);
    expect(config.repos.length).toBeGreaterThan(0);
    expect(config.defaults).toBeDefined();
    expect(config.defaults.provider).toBe('claude');
  });

  it('applies provider override', () => {
    const configPath = writeConfig('config.yaml', VALID_YAML);
    const config = loadConfig({ configPath, provider: 'gemini' });
    expect(config.defaults.provider).toBe('gemini');
  });

  it('applies model override', () => {
    const configPath = writeConfig('config.yaml', VALID_YAML);
    const config = loadConfig({ configPath, model: 'opus' });
    expect(config.defaults.model).toBe('opus');
  });

  it('applies tier override', () => {
    const configPath = writeConfig('config.yaml', VALID_YAML);
    const config = loadConfig({ configPath, tier: 'thorough' });
    expect(config.defaults.tier).toBe('thorough');
  });

  it('applies PR range override that replaces repo prs', () => {
    const configPath = writeConfig('config.yaml', VALID_YAML);
    const config = loadConfig({ configPath, prs: '5-7' });
    expect(config.repos[0].prs).toEqual([5, 6, 7]);
  });

  it('filters to a specific repo by name', () => {
    const multiRepoYaml = `
repos:
  - name: alpha
    github: org/alpha
    prs: [1, 2]
  - name: beta
    github: org/beta
    prs: [3, 4]

defaults:
  provider: claude
  model: sonnet
  tier: balanced
`;
    const configPath = writeConfig('multi.yaml', multiRepoYaml);
    const config = loadConfig({ configPath, repo: 'beta' });
    expect(config.repos).toHaveLength(1);
    expect(config.repos[0].name).toBe('beta');
    expect(config.repos[0].prs).toEqual([3, 4]);
  });

  it('throws a helpful error when filtering to a nonexistent repo', () => {
    const configPath = writeConfig('config.yaml', VALID_YAML);
    expect(() => loadConfig({ configPath, repo: 'nonexistent' })).toThrow(
      /Repo "nonexistent" not found.*Available repos: test-repo/,
    );
  });

  it('throws when the config file does not exist', () => {
    expect(() => loadConfig({ configPath: '/tmp/does-not-exist-ever.yaml' })).toThrow(
      /Config file not found/,
    );
  });

  it('throws on invalid YAML', () => {
    const configPath = writeConfig('bad.yaml', '{{{{invalid yaml::::');
    expect(() => loadConfig({ configPath })).toThrow(/Invalid YAML/);
  });

  it('throws when repos array is missing', () => {
    const configPath = writeConfig('no-repos.yaml', `
defaults:
  provider: claude
  model: sonnet
  tier: balanced
`);
    expect(() => loadConfig({ configPath })).toThrow(/non-empty "repos" array/);
  });

  it('throws when defaults object is missing', () => {
    const configPath = writeConfig('no-defaults.yaml', `
repos:
  - name: test
    github: org/test
    prs: [1]
`);
    expect(() => loadConfig({ configPath })).toThrow(/"defaults" object/);
  });

  it('throws when a repo entry is missing required fields', () => {
    const noName = writeConfig('no-name.yaml', `
repos:
  - github: org/test
    prs: [1]
defaults:
  provider: claude
  model: sonnet
  tier: balanced
`);
    expect(() => loadConfig({ configPath: noName })).toThrow(/"name" field/);

    const noGithub = writeConfig('no-github.yaml', `
repos:
  - name: test
    prs: [1]
defaults:
  provider: claude
  model: sonnet
  tier: balanced
`);
    expect(() => loadConfig({ configPath: noGithub })).toThrow(/"github" field/);

    const noPrs = writeConfig('no-prs.yaml', `
repos:
  - name: test
    github: org/test
defaults:
  provider: claude
  model: sonnet
  tier: balanced
`);
    expect(() => loadConfig({ configPath: noPrs })).toThrow(/"prs" array/);
  });

  it('returns empty matching and scoring when not specified in YAML', () => {
    const minimalYaml = `
repos:
  - name: test
    github: org/test
    prs: [1]
defaults:
  provider: claude
  model: sonnet
  tier: balanced
`;
    const configPath = writeConfig('minimal.yaml', minimalYaml);
    const config = loadConfig({ configPath });
    expect(config.matching).toEqual({});
    expect(config.scoring).toEqual({});
  });
});
