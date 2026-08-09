// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Regression tests for the PR-metadata shape contract (issue #557).
 *
 * `prMetadata` reaches the analyzer in two shapes:
 *
 *   1. the NORMALIZED `pr_metadata` row (`PRMetadataRepository.getByPR`) — what
 *      the web routes and, since #557, the headless CLI paths pass. `repository`
 *      is the "owner/repo" string, the number is `pr_number`, the body is
 *      `description`.
 *   2. the RAW stored `pr_data` blob (the GitHub API shape) — what the headless
 *      paths used to pass. `repository` is an OBJECT
 *      (`{ full_name, clone_url, ... }`), the number is `number`, the body is
 *      `body`.
 *
 * The bug: `buildDedupContext` did `prMetadata.repository?.split('/')`, which
 * threw `TypeError: prMetadata.repository?.split is not a function` on shape 2.
 * Because every consolidation/orchestration stage builds its dedup context
 * FIRST, that one throw was caught by the store-everything fallback, so runs
 * completed "successfully" while emitting the unmerged union of all levels (and
 * all council voices).
 *
 * These tests pin BOTH halves of the fix: the shape-tolerant resolvers, and the
 * producer/consumer contract between `getByPR` and `buildDedupContext`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema.js';

const {
  buildDedupContext,
  resolveRepositorySlug,
  resolveReviewDescription
} = require('../../src/ai/analyzer');
const Analyzer = require('../../src/ai/analyzer');
const { PRMetadataRepository } = require('../../src/database.js');

const IDS = { reviewId: 42, serverPort: 7247, runId: 'run-1' };

/** The normalized `pr_metadata` row shape (what getByPR returns). */
const NORMALIZED_METADATA = {
  id: 7,
  pr_number: 123,
  repository: 'in-the-loop-labs/pair-review',
  title: 'Add a thing',
  description: 'This PR adds a thing.',
  author: 'tjwp',
  base_branch: 'main',
  head_branch: 'feature',
  base_sha: 'base123',
  head_sha: 'head456'
};

/** The raw stored `pr_data` blob shape (GitHub API shape). */
const RAW_BLOB_METADATA = {
  number: 123,
  node_id: 'PR_kwDO123',
  title: 'Add a thing',
  body: 'This PR adds a thing.',
  author: 'tjwp',
  base_branch: 'main',
  head_branch: 'feature',
  base_sha: 'base123',
  head_sha: 'head456',
  repository: {
    full_name: 'in-the-loop-labs/pair-review',
    clone_url: 'https://github.com/in-the-loop-labs/pair-review.git',
    ssh_url: 'git@github.com:in-the-loop-labs/pair-review.git',
    default_branch: 'main'
  }
};

describe('resolveRepositorySlug', () => {
  it('returns the string form unchanged', () => {
    expect(resolveRepositorySlug({ repository: 'owner/repo' })).toBe('owner/repo');
  });

  it('returns a bare local directory name unchanged (local reviews have no slash)', () => {
    expect(resolveRepositorySlug({ repository: 'pair-review' })).toBe('pair-review');
  });

  it('unwraps full_name from the GitHub API object shape', () => {
    expect(resolveRepositorySlug({ repository: { full_name: 'owner/repo', clone_url: 'x' } }))
      .toBe('owner/repo');
  });

  it('returns null for an object with no usable full_name', () => {
    expect(resolveRepositorySlug({ repository: { clone_url: 'x' } })).toBeNull();
  });

  it('returns null for missing, empty, and nullish metadata', () => {
    expect(resolveRepositorySlug({})).toBeNull();
    expect(resolveRepositorySlug({ repository: '' })).toBeNull();
    expect(resolveRepositorySlug({ repository: null })).toBeNull();
    expect(resolveRepositorySlug(null)).toBeNull();
    expect(resolveRepositorySlug(undefined)).toBeNull();
  });
});

describe('resolveReviewDescription', () => {
  it('prefers the normalized `description` field', () => {
    expect(resolveReviewDescription({ description: 'normalized', body: 'raw' })).toBe('normalized');
  });

  it('falls back to the raw blob `body` field', () => {
    expect(resolveReviewDescription({ body: 'raw' })).toBe('raw');
  });

  it('treats a null description as unset and falls through to body', () => {
    expect(resolveReviewDescription({ description: null, body: 'raw' })).toBe('raw');
  });

  it('preserves an empty-string description rather than falling through to body', () => {
    // `??` (not `||`) — an empty description is a deliberate value, not "unset".
    expect(resolveReviewDescription({ description: '', body: 'raw' })).toBe('');
  });

  it('is nullish when neither field is present', () => {
    // Local reviews pass `description: null` with no `body`; the prompt builder
    // treats nullish the same as it always has (section omitted / placeholder).
    expect(resolveReviewDescription({ description: null })).toBeUndefined();
    expect(resolveReviewDescription({})).toBeUndefined();
    expect(resolveReviewDescription(null)).toBeUndefined();
  });
});

describe('buildDedupContext', () => {
  it('extracts owner/repo/pullNumber from the normalized row shape', () => {
    expect(buildDedupContext(NORMALIZED_METADATA, IDS)).toEqual({
      owner: 'in-the-loop-labs',
      repo: 'pair-review',
      pullNumber: 123,
      reviewId: 42,
      serverPort: 7247,
      runId: 'run-1',
      excludeRunIds: undefined
    });
  });

  it('does not throw on the raw pr_data blob shape (#557 regression)', () => {
    // The exact failure: `prMetadata.repository?.split is not a function`.
    // Optional chaining did NOT help — the value is present, just not a string.
    expect(() => buildDedupContext(RAW_BLOB_METADATA, IDS)).not.toThrow();
  });

  it('resolves owner/repo/pullNumber from the raw pr_data blob shape', () => {
    expect(buildDedupContext(RAW_BLOB_METADATA, IDS)).toEqual({
      owner: 'in-the-loop-labs',
      repo: 'pair-review',
      pullNumber: 123,
      reviewId: 42,
      serverPort: 7247,
      runId: 'run-1',
      excludeRunIds: undefined
    });
  });

  it('produces an identical dedup context from either metadata shape', () => {
    expect(buildDedupContext(RAW_BLOB_METADATA, IDS))
      .toEqual(buildDedupContext(NORMALIZED_METADATA, IDS));
  });

  it('prefers pr_number over number when both are present', () => {
    const ctx = buildDedupContext({ repository: 'o/r', pr_number: 1, number: 999 }, IDS);
    expect(ctx.pullNumber).toBe(1);
  });

  it('passes excludeRunIds through', () => {
    const ctx = buildDedupContext(NORMALIZED_METADATA, { ...IDS, excludeRunIds: ['a', 'b'] });
    expect(ctx.excludeRunIds).toEqual(['a', 'b']);
  });

  it('yields undefined owner/repo/pullNumber for local metadata (no repo slug, no PR number)', () => {
    const localMetadata = {
      repository: 'pair-review',
      reviewType: 'local',
      title: 'Local changes in pair-review',
      description: 'Reviewing uncommitted changes',
      head_sha: 'abc'
    };
    const ctx = buildDedupContext(localMetadata, IDS);
    expect(ctx.owner).toBe('pair-review');
    expect(ctx.repo).toBeUndefined();
    expect(ctx.pullNumber).toBeUndefined();
  });

  it('does not throw when repository is missing entirely', () => {
    const ctx = buildDedupContext({ head_sha: 'abc' }, IDS);
    expect(ctx.owner).toBeUndefined();
    expect(ctx.repo).toBeUndefined();
    expect(ctx.pullNumber).toBeUndefined();
  });
});

describe('buildPRContextSection metadata rendering', () => {
  /** buildPRContextSection is an instance method but reads no instance state. */
  const analyzer = Object.create(Analyzer.prototype);

  it('renders owner/repo, PR number, and description from the normalized shape', () => {
    const out = analyzer.buildPRContextSection(NORMALIZED_METADATA, 'note');
    expect(out).toContain('**Repository:** in-the-loop-labs/pair-review');
    expect(out).toContain('**PR #:** 123');
    expect(out).toContain('This PR adds a thing.');
  });

  it('renders the same fields from the raw pr_data blob shape', () => {
    const out = analyzer.buildPRContextSection(RAW_BLOB_METADATA, 'note');
    // Previously rendered "**Repository:** [object Object]", omitted the PR
    // number (stored under `number`), and lost the body (stored under `body`).
    expect(out).not.toContain('[object Object]');
    expect(out).toContain('**Repository:** in-the-loop-labs/pair-review');
    expect(out).toContain('**PR #:** 123');
    expect(out).toContain('This PR adds a thing.');
    expect(out).not.toContain('(No description provided)');
  });

  it('omits PR-only fields for local reviews', () => {
    const out = analyzer.buildPRContextSection({
      reviewType: 'local',
      repository: 'pair-review',
      title: 'Local changes',
      description: 'Uncommitted work'
    }, 'note');
    expect(out).toContain('## Review Context');
    expect(out).toContain('**Repository:** pair-review');
    expect(out).not.toContain('**PR #:**');
  });
});

describe('getByPR → buildDedupContext contract', () => {
  let db;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  /**
   * The cross-boundary contract that broke in #557: the headless paths read PR
   * metadata from the DB and hand it straight to the analyzer. Assert the
   * PRODUCER (`getByPR`) emits a shape the CONSUMER (`buildDedupContext`)
   * resolves to a real owner/repo/pullNumber — so dedup and, with it,
   * consolidation actually run.
   */
  it('getByPR output yields a fully-populated dedup context', async () => {
    db.prepare(`
      INSERT INTO pr_metadata
        (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      123,
      'in-the-loop-labs/pair-review',
      'Add a thing',
      'This PR adds a thing.',
      'tjwp',
      'main',
      'feature',
      JSON.stringify(RAW_BLOB_METADATA)
    );

    const row = await new PRMetadataRepository(db).getByPR(123, 'in-the-loop-labs/pair-review');
    const ctx = buildDedupContext(row, IDS);

    expect(ctx.owner).toBe('in-the-loop-labs');
    expect(ctx.repo).toBe('pair-review');
    expect(ctx.pullNumber).toBe(123);
  });

  it('getByPR output carries the analyzer prompt fields (description, author, SHAs)', async () => {
    db.prepare(`
      INSERT INTO pr_metadata
        (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      123,
      'in-the-loop-labs/pair-review',
      'Add a thing',
      'This PR adds a thing.',
      'tjwp',
      'main',
      'feature',
      JSON.stringify(RAW_BLOB_METADATA)
    );

    const row = await new PRMetadataRepository(db).getByPR(123, 'in-the-loop-labs/pair-review');

    expect(row.description).toBe('This PR adds a thing.');
    expect(row.author).toBe('tjwp');
    expect(row.base_sha).toBe('base123');
    expect(row.head_sha).toBe('head456');
    // The raw blob stays reachable for pr_data-only fields (e.g. node_id).
    expect(row.pr_data_parsed.node_id).toBe('PR_kwDO123');
  });
});
