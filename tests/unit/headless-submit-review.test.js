// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `submitHeadlessAIReview` in src/main.js — the GitHub write of
 * the headless `--ai-review` / `--ai-draft` flow.
 *
 * WHY THIS FILE EXISTS. Phase 5 of plans/bridge-local-and-pr-modes.md moved the
 * review write into `src/providers/review-submit.js` and pointed both web routes
 * at it, but left this flow as a third hand-rolled copy that had already
 * drifted: no `headSha` (alt-host inline comments 422 without a `commit_id`),
 * no diff-line validation (an out-of-hunk suggestion posted at a position GitHub
 * cannot render), and thinner review metadata. These tests pin the fold-in.
 *
 * NO CLI IS SPAWNED and no network is touched. `submitHeadlessAIReview` takes
 * its collaborators through `_deps` (the `defaults` + `_deps` pattern), so the
 * comment query is a fake and `submitReview` is a spy that forwards to the REAL
 * provider with a fake `GitHubClient`. That gives both halves of the contract in
 * one call: what the CLI hands down, and what the provider ultimately sends.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { submitHeadlessAIReview } = require('../../src/main.js');
const { submitReview } = require('../../src/providers/review-submit');

const silentLogger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * `a.js` gains a line at 2. Line 99 is expanded context as far as GitHub is
 * concerned — the case the old headless path posted unchecked.
 */
const DIFF = [
  'diff --git a/a.js b/a.js',
  '--- a/a.js',
  '+++ b/a.js',
  '@@ -1,3 +1,4 @@',
  ' one',
  '+two',
  ' three',
  ' four',
  ''
].join('\n');

const AI_REVIEW_OPTIONS = {
  mode: 'review',
  reviewEvent: 'COMMENT',
  commentStatus: 'submitted',
  modeLabel: 'action review mode'
};

const AI_DRAFT_OPTIONS = {
  mode: 'draft',
  reviewEvent: 'DRAFT',
  commentStatus: 'draft',
  modeLabel: 'draft mode'
};

/** A row as the orchestrated-AI-suggestion query returns it. */
function suggestion(overrides = {}) {
  return {
    id: 501,
    file: 'a.js',
    line_start: 2,
    body: 'off by one',
    diff_position: null,
    title: 'Off by one',
    type: 'bug',
    ...overrides
  };
}

/** A `GitHubClient` stand-in; records every argument the provider passes it. */
function makeClient({ existingDraft = null, features } = {}) {
  const calls = { create: [], draft: [], pending: [] };
  class FakeClient {
    constructor(credential) {
      this.credential = credential;
      this.features = features
        || { review_lifecycle: 'graphql', pending_review_comments: 'graphql' };
    }
    async getPendingReviewForUser(owner, repo, prNumber) {
      calls.pending.push({ owner, repo, prNumber });
      return existingDraft;
    }
    async createReviewGraphQL(prNodeId, event, body, comments, draftId, prContext) {
      calls.create.push({ prNodeId, event, body, comments, draftId, prContext });
      return {
        id: 'PRR_node1',
        databaseId: 555,
        html_url: 'https://example.test/o/r/pull/7#pullrequestreview-555',
        comments_count: comments.length,
        state: 'COMMENTED'
      };
    }
    async createDraftReviewGraphQL(prNodeId, body, comments, draftId, prContext) {
      calls.draft.push({ prNodeId, body, comments, draftId, prContext });
      return {
        id: 'PRR_draft1',
        databaseId: 777,
        html_url: 'https://example.test/o/r/pull/7#pullrequestreview-777',
        comments_count: comments.length,
        state: 'PENDING'
      };
    }
  }
  return { FakeClient, calls };
}

/** Fake `query`/`run`, recording every statement. */
function makeDbDeps() {
  const statements = [];
  return {
    statements,
    run: async (_db, sql, params) => {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { changes: 1 };
    }
  };
}

function makeRepos() {
  const calls = { update: [], upsert: [] };
  class FakeReviewRepository {
    async updateAfterSubmission(id, data) { calls.update.push({ id, data }); return true; }
  }
  class FakeGitHubReviewRepository {
    async upsertFromGitHub(reviewId, data) { calls.upsert.push({ reviewId, data }); return { id: 1 }; }
  }
  return { FakeReviewRepository, FakeGitHubReviewRepository, calls };
}

/**
 * Drive `submitHeadlessAIReview` end-to-end through the real provider.
 *
 * @returns everything worth asserting on: what the CLI handed the provider
 *   (`submitCalls`), what the provider handed GitHub (`clientCalls`), and what
 *   it wrote to the database (`statements`, `repoCalls`).
 */
function drive({
  suggestions = [suggestion()],
  storedPRData = { node_id: 'PR_node', head_sha: 'head-sha-1' },
  options = AI_REVIEW_OPTIONS,
  diffContent = DIFF,
  analysisSummary = null,
  hostName = 'GitHub',
  clientOptions = {}
} = {}) {
  const { FakeClient, calls: clientCalls } = makeClient(clientOptions);
  const { statements, run } = makeDbDeps();
  const { FakeReviewRepository, FakeGitHubReviewRepository, calls: repoCalls } = makeRepos();
  const submitCalls = [];
  const queryCalls = [];

  const providerDeps = {
    GitHubClient: FakeClient,
    ReviewRepository: FakeReviewRepository,
    GitHubReviewRepository: FakeGitHubReviewRepository,
    logger: silentLogger,
    query: async () => { throw new Error('the provider must not load comments under an override'); },
    run
  };

  const promise = submitHeadlessAIReview({
    db: {},
    reviewId: 42,
    prInfo: { owner: 'o', repo: 'r', number: 7 },
    storedPRData,
    credential: { token: 'tok', apiHost: null },
    hostName,
    diffContent,
    analysisSummary,
    options,
    _deps: {
      query: async (_db, sql, params) => {
        queryCalls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return suggestions;
      },
      submitReview: async (params) => {
        submitCalls.push(params);
        return submitReview({ ...params, _deps: providerDeps });
      }
    }
  });

  return { promise, submitCalls, clientCalls, statements, repoCalls, queryCalls };
}

describe('submitHeadlessAIReview', () => {
  let logs;
  let warns;

  beforeEach(() => {
    logs = [];
    warns = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...args) => { warns.push(args.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('what it hands the shared provider', () => {
    it('passes headSha, node id, diff and host name down', async () => {
      const { promise, submitCalls } = drive({ hostName: 'Meteorite' });
      await promise;

      expect(submitCalls).toHaveLength(1);
      expect(submitCalls[0]).toMatchObject({
        reviewId: 42,
        owner: 'o',
        repo: 'r',
        prNumber: 7,
        event: 'COMMENT',
        prNodeId: 'PR_node',
        headSha: 'head-sha-1',
        diffContent: DIFF,
        filesWithLocalEdits: null,
        hostName: 'Meteorite'
      });
    });

    it('supplies the AI rows as an explicit override, formatted and RIGHT-sided', async () => {
      const { promise, submitCalls } = drive();
      await promise;

      expect(submitCalls[0].commentsOverride).toEqual({
        status: 'submitted',
        comments: [{
          id: 501,
          file: 'a.js',
          line_start: 2,
          // Single-line: an AI suggestion never carries a range.
          line_end: 2,
          body: '\u{1F41B} **Bug**: off by one',
          diff_position: null,
          side: 'RIGHT',
          commit_sha: 'head-sha-1',
          is_file_level: 0
        }]
      });
    });

    it('does not pass trustLeftAnchors — every row is RIGHT, so the default is the answer', async () => {
      const { promise, submitCalls } = drive();
      await promise;
      expect(submitCalls[0].trustLeftAnchors).toBeUndefined();
      expect(submitCalls[0].commentsOverride.comments.every(c => c.side === 'RIGHT')).toBe(true);
    });

    it('carries the caller’s comment status for --ai-draft', async () => {
      const { promise, submitCalls, clientCalls } = drive({ options: AI_DRAFT_OPTIONS });
      await promise;
      expect(submitCalls[0].event).toBe('DRAFT');
      expect(submitCalls[0].commentsOverride.status).toBe('draft');
      expect(clientCalls.draft).toHaveLength(1);
      expect(clientCalls.create).toHaveLength(0);
    });

    it('reads AI suggestions by reviews.id, orchestrated and active only', async () => {
      const { promise, queryCalls } = drive();
      await promise;
      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].params).toEqual([42]);
      expect(queryCalls[0].sql).toContain("source = 'ai'");
      expect(queryCalls[0].sql).toContain('ai_level IS NULL');
      expect(queryCalls[0].sql).toContain("status = 'active'");
    });
  });

  describe('what GitHub actually receives', () => {
    it('sends the head SHA in the prContext — the alt-host commit_id regression', async () => {
      // The old hand-rolled `submitPrContext` omitted `headSha` entirely, so a
      // GitHub-compatible alt host rejected every inline comment with a 422.
      const { promise, clientCalls } = drive({
        storedPRData: { node_id: 'PR_node', head_sha: 'alt-host-head' }
      });
      await promise;

      expect(clientCalls.create[0].prContext).toEqual({
        owner: 'o',
        repo: 'r',
        prNumber: 7,
        reviewId: undefined,
        headSha: 'alt-host-head'
      });
    });

    it('degrades an out-of-hunk AI suggestion to a file-level (Ref Line N) comment', async () => {
      // The behaviour change the fold-in buys: line 99 is expanded context, and
      // the old path posted it as a line comment GitHub could not render.
      const { promise, clientCalls } = drive({
        suggestions: [suggestion({ line_start: 99 })]
      });
      await promise;

      expect(clientCalls.create[0].comments).toEqual([{
        path: 'a.js',
        body: '(Ref Line 99) \u{1F41B} **Bug**: off by one',
        isFileLevel: true
      }]);
    });

    it('keeps the line number for a suggestion inside a hunk', async () => {
      const { promise, clientCalls } = drive();
      await promise;
      expect(clientCalls.create[0].comments).toEqual([{
        path: 'a.js',
        line: 2,
        body: '\u{1F41B} **Bug**: off by one',
        side: 'RIGHT',
        isFileLevel: false
      }]);
    });

    it('degrades EVERY suggestion when the diff is empty', async () => {
      // Documented consequence of an unavailable diff: file level, never an
      // unverified line number.
      const { promise, clientCalls } = drive({ diffContent: '' });
      await promise;
      expect(clientCalls.create[0].comments.every(c => c.isFileLevel)).toBe(true);
    });

    it('builds the review body from the AI summary with the mode footer', async () => {
      const { promise, clientCalls } = drive({ analysisSummary: 'Two nits.' });
      await promise;
      expect(clientCalls.create[0].body).toContain('## AI Analysis Summary');
      expect(clientCalls.create[0].body).toContain('Two nits.');
      expect(clientCalls.create[0].body).toContain('`--ai-review` mode');
    });

    it('falls back to a count-based body, and names --ai-draft in draft mode', async () => {
      const { promise, clientCalls } = drive({ options: AI_DRAFT_OPTIONS });
      await promise;
      expect(clientCalls.draft[0].body).toContain('Found 1 suggestion from automated analysis.');
      expect(clientCalls.draft[0].body).toContain('`--ai-draft` mode');
    });
  });

  describe('what it records locally', () => {
    it('writes the fuller review metadata the routes write', async () => {
      // The old path stamped `created_at` even for a submitted review and left
      // `event` / `submitted_at` off the mirror row.
      const { promise, repoCalls } = drive();
      await promise;

      expect(repoCalls.update[0].data.event).toBe('COMMENT');
      expect(repoCalls.update[0].data.reviewData.submitted_at).toEqual(expect.any(String));
      expect(repoCalls.update[0].data.reviewData.created_at).toBeUndefined();
      expect(repoCalls.upsert[0].data).toMatchObject({
        github_node_id: 'PRR_node1',
        github_review_id: '555',
        state: 'submitted',
        event: 'COMMENT'
      });
      expect(repoCalls.upsert[0].data.submitted_at).toEqual(expect.any(String));
    });

    it('flips the submitted suggestions to the mode’s comment status', async () => {
      const { promise, statements } = drive({ options: AI_DRAFT_OPTIONS });
      await promise;
      const update = statements.find(s => s.sql.startsWith('UPDATE comments SET status'));
      expect(update.params[0]).toBe('draft');
      expect(update.params[2]).toBe(501);
    });

    it('never promotes unrelated draft rows — it submitted only its own set', async () => {
      const { promise, statements } = drive({
        clientOptions: {
          existingDraft: { id: 'PRR_existing', databaseId: 999, url: 'u', comments: { totalCount: 2 } }
        }
      });
      await promise;
      expect(statements.some(s => s.sql.includes("status = 'draft'"))).toBe(false);
    });
  });

  describe('stdout contract (this runs in CI)', () => {
    it('prints the found/filtered/submitting/success lines unchanged', async () => {
      const { promise } = drive();
      await promise;

      expect(logs).toEqual([
        'Found 1 AI suggestions to submit',
        'Filtered to 1 suggestions with valid line information',
        'Submitting review with 1 comments...',
        '\n✅ Review submitted successfully!',
        '   Review URL: https://example.test/o/r/pull/7#pullrequestreview-555',
        '   Comments submitted: 1\n'
      ]);
    });

    it('says "Draft review created" in draft mode', async () => {
      const { promise } = drive({ options: AI_DRAFT_OPTIONS });
      await promise;
      expect(logs).toContain('\n✅ Draft review created successfully!');
    });

    it('exits gracefully, and silently, when there are no AI suggestions', async () => {
      const { promise, submitCalls } = drive({ suggestions: [] });
      await expect(promise).resolves.toBeNull();
      expect(submitCalls).toHaveLength(0);
      expect(logs).toEqual([
        'Found 0 AI suggestions to submit',
        'No AI suggestions to submit. Exiting without creating review.'
      ]);
    });

    it('warns per unusable suggestion and exits when none survive the filter', async () => {
      const { promise, submitCalls } = drive({
        suggestions: [suggestion({ line_start: 0 }), suggestion({ id: 502, file: '  ' })]
      });
      await expect(promise).resolves.toBeNull();
      expect(submitCalls).toHaveLength(0);
      expect(warns).toHaveLength(2);
      expect(logs).toContain('Filtered to 0 suggestions with valid line information');
      expect(logs).toContain('No suggestions with valid line information. Exiting without creating review.');
    });

    it('reports the TOTAL when it joined an existing pending draft', async () => {
      const { promise } = drive({
        clientOptions: {
          existingDraft: { id: 'PRR_existing', databaseId: 999, url: 'u', comments: { totalCount: 3 } }
        }
      });
      await promise;
      expect(logs).toContain('   Comments submitted: 4\n');
    });
  });

  describe('failures', () => {
    it('propagates a partially_posted refusal with its CODE intact', async () => {
      // `performHeadlessReview`'s catch ladder matches on `error.code`, not on
      // message text (the message embeds the underlying GitHub failure, which
      // can contain "not found" or "rate limit"). If this ever arrives as a
      // bare Error the operator gets "try again" for the one failure where
      // trying again duplicates comments.
      const { SubmitReviewError } = require('../../src/providers/review-submit');
      const boom = new SubmitReviewError('partial write, PR not found in cache', {
        status: 409, code: 'partially_posted'
      });

      const promise = submitHeadlessAIReview({
        db: {},
        reviewId: 42,
        prInfo: { owner: 'o', repo: 'r', number: 7 },
        storedPRData: { node_id: 'PR_node', head_sha: 'head-sha-1' },
        credential: { token: 'tok', apiHost: null },
        hostName: 'GitHub',
        diffContent: DIFF,
        options: AI_REVIEW_OPTIONS,
        _deps: {
          query: async () => [suggestion()],
          submitReview: async () => { throw boom; }
        }
      });

      await expect(promise).rejects.toBe(boom);
      expect(boom.code).toBe('partially_posted');
      expect(boom).toBeInstanceOf(SubmitReviewError);
    });
  });

  /**
   * The point of the fold-in: a headless submission and a web-route submission
   * of the SAME comments must reach GitHub identically. Asserted at the
   * provider's own boundary, so the two paths are compared where they actually
   * converge rather than through two different HTTP stacks.
   */
  describe('equivalence with the web routes', () => {
    /** Run the provider the way `POST /api/pr/.../submit-review` does. */
    async function viaRoute(rows) {
      const { FakeClient, calls } = makeClient();
      const { run } = makeDbDeps();
      const { FakeReviewRepository, FakeGitHubReviewRepository } = makeRepos();
      await submitReview({
        db: {},
        reviewId: 42,
        owner: 'o',
        repo: 'r',
        prNumber: 7,
        event: 'COMMENT',
        body: 'shared body',
        credential: { token: 'tok', apiHost: null },
        prNodeId: 'PR_node',
        headSha: 'alt-host-head',
        diffContent: DIFF,
        filesWithLocalEdits: null,
        hostName: 'Meteorite',
        _deps: {
          GitHubClient: FakeClient,
          ReviewRepository: FakeReviewRepository,
          GitHubReviewRepository: FakeGitHubReviewRepository,
          logger: silentLogger,
          query: async () => rows,
          run
        }
      });
      return calls.create[0];
    }

    it('produces the same GraphQL comments and prContext as the route would', async () => {
      const rows = [
        // In-hunk: keeps its line.
        {
          id: 501, file: 'a.js', line_start: 2, line_end: 2,
          body: '\u{1F41B} **Bug**: off by one', diff_position: null,
          side: 'RIGHT', commit_sha: 'alt-host-head', is_file_level: 0
        },
        // Out-of-hunk: must degrade on BOTH paths.
        {
          id: 502, file: 'a.js', line_start: 99, line_end: 99,
          body: '\u{2B50} **Praise**: nice', diff_position: null,
          side: 'RIGHT', commit_sha: 'alt-host-head', is_file_level: 0
        }
      ];

      const routeCall = await viaRoute(rows);

      const { promise, clientCalls } = drive({
        storedPRData: { node_id: 'PR_node', head_sha: 'alt-host-head' },
        hostName: 'Meteorite',
        suggestions: [
          suggestion(),
          suggestion({ id: 502, line_start: 99, body: 'nice', type: 'praise', title: 'Nice' })
        ]
      });
      await promise;
      const headlessCall = clientCalls.create[0];

      expect(headlessCall.comments).toEqual(routeCall.comments);
      expect(headlessCall.prContext).toEqual(routeCall.prContext);
      expect(headlessCall.prNodeId).toBe(routeCall.prNodeId);
      expect(headlessCall.event).toBe(routeCall.event);
      // The head SHA is present on both — the divergence this fold-in closed.
      expect(headlessCall.prContext.headSha).toBe('alt-host-head');
    });
  });
});
