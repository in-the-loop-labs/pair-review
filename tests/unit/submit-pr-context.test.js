// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * buildSubmitPrContext: the prContext both submit entry points (the web
 * submit route and headless --ai-draft / --ai-review) hand to the GitHub
 * client. Alt-hosts reject inline comments without commit_id (422), so the
 * PR head SHA must reach the host pending-review-comments request.
 *
 * The PR record is read the way headless reads it (PRMetadataRepository.getByPR
 * against the real test schema), and the end-to-end cases drive the real
 * GitHubClient + host comments impl with only octokit.request faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema.js';

const { buildSubmitPrContext } = require('../../src/github/submit-pr-context');
const { PRMetadataRepository } = require('../../src/database');
const { GitHubClient } = require('../../src/github/client');
const reviewLifecycleOps = require('../../src/github/operations/review-lifecycle');
const logger = require('../../src/utils/logger');

const HEAD_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const REPOSITORY = 'acme/widgets';
const PR_NUMBER = 7;

let db;

beforeEach(() => {
  db = createTestDatabase();
});

afterEach(() => {
  closeTestDatabase(db);
  vi.restoreAllMocks();
});

function storePR(prData) {
  db.prepare(
    'INSERT INTO pr_metadata (pr_number, repository, title, pr_data) VALUES (?, ?, ?, ?)'
  ).run(PR_NUMBER, REPOSITORY, 'Title', JSON.stringify(prData));
}

/** The headless shape: getByPR's record plus its parsed pr_data blob. */
async function loadHeadlessPR() {
  const prMetadata = await new PRMetadataRepository(db).getByPR(PR_NUMBER, REPOSITORY);
  return { prMetadata, prData: prMetadata.pr_data_parsed };
}

function altHostClient() {
  const client = new GitHubClient({
    token: 't',
    apiHost: 'https://althost.example/api/v3',
    features: {
      pending_review_check: 'rest',
      stack_walker: 'rest',
      review_lifecycle: 'rest',
      pending_review_comments: 'host'
    }
  });
  client.octokit.request = vi.fn(async () => ({ data: { added: 1, failed: [] } }));
  return client;
}

describe('buildSubmitPrContext', () => {
  it('carries the head SHA from the stored PR data the way headless reads it', async () => {
    storePR({ node_id: 'PR_node', head_sha: HEAD_SHA, base_sha: 'base' });
    const { prMetadata, prData } = await loadHeadlessPR();

    const ctx = buildSubmitPrContext({
      owner: 'acme', repo: 'widgets', prNumber: PR_NUMBER,
      existingDraft: null, prData, prMetadata
    });

    expect(ctx).toEqual({
      owner: 'acme',
      repo: 'widgets',
      prNumber: PR_NUMBER,
      reviewId: undefined,
      headSha: HEAD_SHA
    });
  });

  it('uses the existing draft\'s numeric databaseId as reviewId', () => {
    const ctx = buildSubmitPrContext({
      owner: 'acme', repo: 'widgets', prNumber: PR_NUMBER,
      existingDraft: { id: 'PRR_node', databaseId: 88 },
      prData: { head_sha: HEAD_SHA }
    });
    expect(ctx.reviewId).toBe(88);
  });

  it('falls back to prMetadata.head_sha when pr_data lacks it', () => {
    const ctx = buildSubmitPrContext({
      owner: 'acme', repo: 'widgets', prNumber: PR_NUMBER,
      prData: {}, prMetadata: { head_sha: HEAD_SHA }
    });
    expect(ctx.headSha).toBe(HEAD_SHA);
  });

  it('sets headSha to null and warns when no head SHA is stored', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    storePR({ node_id: 'PR_node' });
    const { prMetadata, prData } = await loadHeadlessPR();

    const ctx = buildSubmitPrContext({
      owner: 'acme', repo: 'widgets', prNumber: PR_NUMBER, prData, prMetadata
    });

    expect(ctx.headSha).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('acme/widgets#7: PR head SHA is missing'));
  });

  it('does not warn when the head SHA is present', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    buildSubmitPrContext({
      owner: 'acme', repo: 'widgets', prNumber: PR_NUMBER, prData: { head_sha: HEAD_SHA }
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('tolerates missing prData and prMetadata', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const ctx = buildSubmitPrContext({ owner: 'acme', repo: 'widgets', prNumber: PR_NUMBER });
    expect(ctx.headSha).toBeNull();
    expect(ctx.reviewId).toBeUndefined();
  });
});

describe('buildSubmitPrContext -> alt-host inline comments carry commit_id', () => {
  const comments = [{ path: 'a.js', line: 2, side: 'RIGHT', body: 'Check this.' }];

  async function contextForStoredPR() {
    storePR({ node_id: 'PR_node', head_sha: HEAD_SHA });
    const { prMetadata, prData } = await loadHeadlessPR();
    return buildSubmitPrContext({
      owner: 'acme', repo: 'widgets', prNumber: PR_NUMBER,
      existingDraft: { id: 'PRR_node', databaseId: 88 }, prData, prMetadata
    });
  }

  it('draft submit (--ai-draft) posts commit_id = PR head SHA', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = altHostClient();
    const ctx = await contextForStoredPR();

    await client.createDraftReviewGraphQL(null, 'summary', comments, 'PRR_node', ctx);

    expect(client.octokit.request).toHaveBeenCalledTimes(1);
    const [endpoint, options] = client.octokit.request.mock.calls[0];
    expect(endpoint).toBe('POST /repos/acme/widgets/pulls/7/reviews/88/comments');
    expect(options.data.comments).toHaveLength(1);
    expect(options.data.comments[0].commit_id).toBe(HEAD_SHA);
  });

  it('submitted review (--ai-review) posts commit_id = PR head SHA', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(reviewLifecycleOps, 'submitPullRequestReview')
      .mockResolvedValue({ id: 'PRR_node', databaseId: 88, url: 'u', state: 'COMMENTED' });
    const client = altHostClient();
    const ctx = await contextForStoredPR();

    await client.createReviewGraphQL(null, 'COMMENT', 'summary', comments, 'PRR_node', ctx);

    expect(client.octokit.request).toHaveBeenCalledTimes(1);
    const [, options] = client.octokit.request.mock.calls[0];
    expect(options.data.comments[0].commit_id).toBe(HEAD_SHA);
  });
});
