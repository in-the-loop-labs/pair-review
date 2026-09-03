// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Review Submit Provider
 *
 * The shared half of "turn this review's draft comments into a real GitHub
 * review" — used by all three callers:
 *   - `POST /api/pr/:owner/:repo/:number/submit-review`  (src/routes/pr.js)
 *   - `POST /api/local/:reviewId/submit-review`          (src/routes/local.js)
 *   - the headless `--ai-review` / `--ai-draft` flow      (src/main.js)
 *
 * See plans/bridge-local-and-pr-modes.md, Phase 5. This is the only phase that
 * WRITES to GitHub, so every caller shares one implementation of the write and
 * keeps only its own preconditions.
 *
 * The headless flow is the odd one out and is served by ONE explicit input,
 * `commentsOverride` — it submits AI suggestion rows it has already read and
 * re-bodied, not this review's active user comments. See `submitReview`.
 *
 * Follows the `defaults + _deps` DI pattern from `src/protocol-handler.js`.
 * Never re-resolves config internally — the caller passes a resolved credential
 * (a host binding or a bare token) and a resolved host display name down.
 *
 * WHAT STAYS IN THE ROUTES, AND WHY
 * ---------------------------------
 * Everything that answers "which pull request, and may we write to it": the
 * host binding, the PR record, the worktree, and — local mode only — the
 * live drift/lifecycle pre-check (`checkSubmitPreconditions` below). PR mode
 * reads its PR record from the `pr_metadata` cache exactly as it always has;
 * adopting the live pre-check there would change PR mode's behaviour, and 5a
 * is a pure extraction.
 *
 * The DIFF is a route input for the same reason: PR mode generates it from the
 * PR worktree, local mode from the user's own checkout. It is not decoration —
 * see `formatCommentsForGraphQL`, where it decides line-level versus
 * file-level for every comment.
 */

const { query, run, ReviewRepository, GitHubReviewRepository } = require('../database');
const { GitHubClient } = require('../github/client');
const { buildDiffLineSet } = require('../utils/diff-annotator');
const logger = require('../utils/logger');

const defaults = {
  GitHubClient,
  GitHubReviewRepository,
  ReviewRepository,
  // Injectable so a unit test can drive the whole flow — including the
  // transaction boundary and the comment status transitions — without a
  // database. The routes never override them.
  query,
  run,
  logger,
};

/** The four review events both routes accept. */
const SUBMIT_EVENTS = Object.freeze(['APPROVE', 'REQUEST_CHANGES', 'COMMENT', 'DRAFT']);

/**
 * A refusal this provider raises itself, carrying the HTTP status and a stable
 * machine code so both routes map it identically.
 *
 * Everything else — auth failures, rate limits, GraphQL errors — propagates
 * from `GitHubClient` unchanged, because each route already owns a catch
 * ladder that reads those messages. Wrapping them here would silently change
 * PR mode's response codes.
 */
class SubmitReviewError extends Error {
  constructor(message, { status = 400, code = 'submit_refused' } = {}) {
    super(message);
    this.name = 'SubmitReviewError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Read this review's active user comments, in submission order.
 *
 * `source = 'user'` and `status = 'active'`: AI suggestions the reviewer never
 * adopted are not part of the review, and an already-submitted comment must
 * not be posted twice.
 *
 * @param {Object} db
 * @param {number} reviewId
 * @param {Object} [deps]
 * @returns {Promise<Array<Object>>}
 */
async function loadSubmittableComments(db, reviewId, deps = defaults) {
  return deps.query(db, `
    SELECT
      id,
      file,
      line_start,
      line_end,
      body,
      diff_position,
      side,
      commit_sha,
      is_file_level
    FROM comments
    WHERE review_id = ? AND source = 'user' AND status = 'active'
    ORDER BY file, line_start
  `, [reviewId]);
}

/**
 * Shape stored comments into the objects the GraphQL/host review APIs take.
 *
 * GraphQL supports line-level comments (inside a diff hunk) and file-level
 * comments (`subjectType: FILE`), so a comment that cannot be anchored to a
 * hunk is not dropped — it is posted against the file with a `(Ref Line N)`
 * prefix so the reader still knows where it points.
 *
 * FOUR WAYS A COMMENT BECOMES FILE-LEVEL
 * --------------------------------------
 * 1. The reviewer wrote it as one (`is_file_level = 1`).
 * 2. Its target line is not in a diff hunk — an expanded-context comment.
 *    Checked against the diff rather than against `diff_position`, which is
 *    not set by every source (the chat agent leaves it null). For a range,
 *    BOTH endpoints must be inside the diff: a start outside a hunk with an
 *    end inside produces a position GitHub cannot render.
 * 3. Its file has uncommitted local edits (`filesWithLocalEdits`) — local
 *    mode only, and the Phase 5 addition to this function.
 * 4. It points at the LEFT column and the caller could not vouch for the left
 *    coordinate system (`trustLeftAnchors === false`) — local mode only.
 *
 * WHY (3) EXISTS. The route hard-refuses when local `HEAD` has drifted from
 * the PR head, so the committed content on both sides agrees. The WORKING TREE
 * is a separate question: local mode renders the working tree, so a comment's
 * line number describes the file as it is on disk. An uncommitted edit above
 * that line shifts it, and the shifted number still lands inside a hunk — the
 * check in (2) passes and GitHub renders the comment against the wrong line,
 * silently. Refusing the whole submission over an unrelated edit would be
 * worse (a dirty tree is the normal state of a local review), so the comment
 * survives at file level with its line spelled out in the text. Same rule the
 * external-comment anchor gate follows: when the anchor cannot be trusted,
 * degrade it, never guess it.
 *
 * WHY (4) EXISTS. (2) and (3) only ever settle the RIGHT column. A LEFT-side
 * comment's line number was authored in the LOCAL diff's OLD-side coordinates —
 * the merge base of the local base branch and HEAD, or HEAD/index on the
 * default scope — while it is validated here against the PULL REQUEST's
 * `baseSha..headSha` diff. Those two left columns are the same file only when
 * the two bases are the same commit; they diverge on a stacked PR, on a PR
 * whose base was changed on GitHub, and under the in-UI base-branch override
 * (which is never persisted, so nothing downstream can notice it). A shifted
 * LEFT number does NOT fail check (2): `buildDiffLineSet` records a LEFT entry
 * for every deleted AND context line, so almost any plausible number lands
 * inside some left-side hunk — and the comment posts, silently, against content
 * the reviewer never pointed at. Nothing about the RIGHT column is implicated,
 * which is why the gate is per-comment rather than a whole-submission refusal.
 *
 * The READ side already draws this exact line: `_externalAnchorContext` in
 * public/js/pr.js grants `trustLeftAnchors` only when the head shas match AND
 * the scope includes the branch AND `localBaseSha === prBaseSha`, and
 * `_applyBaseOverrideLeftAnchor` in public/js/local.js nulls `localBaseSha` on
 * an override so left threads fail safe. The WRITE side must not be more
 * trusting than the read side; the caller computes the same predicate and
 * passes it down. PR mode's comments are authored on the pull request's own
 * diff, so its default (`true`) keeps behaviour identical there.
 *
 * @param {Object} params
 * @param {Array<Object>} params.comments - Rows from `loadSubmittableComments`
 * @param {string} [params.diffContent] - Unified diff the comments' line
 *   numbers are read against. An empty/absent diff degrades EVERY line comment
 *   to file level, which is the deliberate fallback for "we could not
 *   determine the diff" — never a reason to post an unchecked line number.
 * @param {Set<string>|null} [params.filesWithLocalEdits] - Paths whose working
 *   tree differs from `HEAD`. Null/absent in PR mode (its worktree is pinned
 *   to the PR head and is never edited).
 * @param {Object} [params.diffLineSet] - A prebuilt `buildDiffLineSet` result,
 *   so a caller that already needed one (`submitReview`, for `filesNotInDiff`)
 *   does not parse the diff twice. Built from `diffContent` when absent.
 * @param {boolean} [params.trustLeftAnchors=true] - May a `side: 'LEFT'`
 *   comment keep its line number? False degrades every left-side comment to
 *   file level. Defaults TRUE because PR mode's left column is the pull
 *   request's own; local mode passes the computed predicate.
 * @param {Object} [deps]
 * @returns {Array<Object>} GraphQL comment inputs
 */
function formatCommentsForGraphQL(
  { comments, diffContent, filesWithLocalEdits, diffLineSet: prebuilt, trustLeftAnchors = true },
  deps = defaults
) {
  const diffLineSet = prebuilt || buildDiffLineSet(diffContent || '');
  const dirty = filesWithLocalEdits || null;

  return comments.map(comment => {
    const side = comment.side || 'RIGHT';
    const isRange = comment.line_end && comment.line_end !== comment.line_start;

    if (comment.is_file_level === 1) {
      deps.logger.debug(`Formatting file-level comment: ${comment.file}`);
      return {
        path: comment.file,
        body: comment.body,
        isFileLevel: true
      };
    }

    const fileHasLocalEdits = Boolean(dirty && dirty.has(comment.file));
    // Checked BEFORE the diff lookup, and independently of it: the whole point
    // of (4) is that the lookup answers "yes" for a number that means something
    // else here. See WHY (4) EXISTS.
    const untrustedLeftAnchor = side === 'LEFT' && trustLeftAnchors === false;
    const outsideDiff = isRange
      ? !diffLineSet.isLineInDiff(comment.file, comment.line_start, side) || !diffLineSet.isLineInDiff(comment.file, comment.line_end, side)
      : !diffLineSet.isLineInDiff(comment.file, comment.line_start, side);

    if (untrustedLeftAnchor || fileHasLocalEdits || outsideDiff) {
      const lineRef = isRange
        ? `(Ref Lines ${comment.line_start}-${comment.line_end})`
        : `(Ref Line ${comment.line_start})`;

      const reason = untrustedLeftAnchor
        ? 'untrusted LEFT anchor'
        : fileHasLocalEdits ? 'uncommitted local edits' : 'expanded context';
      deps.logger.debug(`Formatting file-level comment (${reason}): ${comment.file} ${lineRef}`);

      return {
        path: comment.file,
        body: `${lineRef} ${comment.body}`,
        isFileLevel: true
      };
    }

    deps.logger.debug(
      `Formatting line comment: ${comment.file}:${comment.line_start}${isRange ? `-${comment.line_end}` : ''} side=${side}`
    );

    const commentObj = {
      path: comment.file,
      line: isRange ? comment.line_end : comment.line_start,
      body: comment.body,
      side: side,
      isFileLevel: false
    };

    if (isRange) {
      commentObj.start_line = comment.line_start;
      // BOTH ENDPOINTS, BOTH SIDES. GitHub's `AddPullRequestReviewThreadInput`
      // defaults `startSide` to RIGHT independently of `side`, so a LEFT range
      // that sends only `side: LEFT` asks for a thread whose end is on the OLD
      // column and whose start is on the NEW one — a coordinate pair that means
      // nothing, and that GitHub either rejects or anchors somewhere the
      // reviewer never pointed at. The two endpoints were validated against the
      // SAME `side` a few lines above (see `outsideDiff`), so the same side is
      // the only honest answer for the start coordinate.
      //
      // The REST-shaped host transport already pairs `start_side` with
      // `start_line` (src/github/impl/host/pending-review-comments.js); the
      // GraphQL transport now emits `startSide` beside `startLine` too.
      commentObj.start_side = side;
    }

    return commentObj;
  });
}

/**
 * The files these comments target that the pull request does not touch at all.
 *
 * A comment outside every hunk is a DEGRADED anchor — it still posts, at file
 * level, with its line spelled out. A comment on a file the pull request never
 * changed is something else: GitHub refuses it, whether inline or file-level,
 * because the path is not part of the diff. `GitHubClient.createReviewGraphQL`
 * handles that safely — it deletes the pending review it created and throws —
 * so the outcome is a failed submission either way. Catching it HERE costs no
 * round trip and produces a message that names the files instead of a nested
 * GraphQL envelope.
 *
 * ONLY LOCAL MODE ASKS THIS (`refuseCommentsOutsideDiff`). The difference is
 * which diff the comments were authored against. PR mode's were written on the
 * PULL REQUEST's own diff, so a path outside it is an anomaly that route has
 * never refused — and 5a is an extraction, not a behaviour change; it keeps
 * whatever GitHub answers. Local mode's were written on a DIFFERENT diff — the
 * working tree, at a scope that can be narrower or wider than the branch — so a
 * file edited locally and never committed is routine, appears in the local diff
 * and in no pull request, and is worth catching before the write.
 *
 * An EMPTY diff answers nothing (`hasFile` is false for every path), so this
 * returns nothing rather than refusing everything — the same "unknown is not
 * no" rule the file-level fallback follows.
 *
 * @param {Array<Object>} comments
 * @param {Object} diffLineSet - A `buildDiffLineSet` result
 * @param {string} [diffContent] - Used only to tell an empty diff from a real
 *   one; `buildDiffLineSet` does not expose that.
 * @returns {Array<string>} unique paths, in the order first seen
 */
function filesNotInDiff(comments, diffLineSet, diffContent) {
  if (!diffContent || !diffContent.trim()) return [];
  const missing = [];
  for (const comment of comments) {
    if (!diffLineSet.hasFile(comment.file) && !missing.includes(comment.file)) {
      missing.push(comment.file);
    }
  }
  return missing;
}

/**
 * Turn a rejected PR read into the refusal it actually is.
 *
 * `fetchPullRequest` rejects with a `GitHubApiError` carrying the HTTP status,
 * so the status — never the message text — is what classifies it. Anything
 * without a status is a transport failure (DNS, socket, TLS, an octokit
 * plumbing bug), where the PR's state is genuinely unknown and 502 is honest.
 * The codes match the vocabulary both routes' catch ladders already speak, so a
 * pre-check refusal and a mid-write failure read the same to the client.
 *
 * @param {Error} error - The rejection from `fetchPullRequest`
 * @param {number} prNumber
 * @returns {{ok: false, status: number, code: string, error: string}}
 */
function classifyPRReadFailure(error, prNumber) {
  const status = Number(error && error.status);

  switch (status) {
    case 401:
      return {
        ok: false,
        status: 401,
        code: 'auth_failed',
        error: 'GitHub rejected the credential while checking the pull request state. '
          + `Please check your token in ~/.pair-review/config.json (${error.message})`
      };
    case 403:
      return {
        ok: false,
        status: 403,
        code: 'insufficient_permissions',
        error: `Insufficient permissions to read pull request #${prNumber}. `
          + `Your GitHub token may need additional scopes (${error.message})`
      };
    case 404:
      return {
        ok: false,
        status: 404,
        code: 'pr_not_found',
        error: `Pull request #${prNumber} not found, or the credential cannot see it.`
      };
    case 429:
      return {
        ok: false,
        status: 429,
        code: 'rate_limited',
        error: `GitHub rate limit reached while checking pull request #${prNumber}. `
          + `Please wait and try again (${error.message})`
      };
    default:
      return {
        ok: false,
        status: 502,
        code: 'pr_state_unknown',
        error: `Could not read pull request #${prNumber} from GitHub to verify it is still open `
          + `and at your local commit: ${error.message}`
      };
  }
}

/**
 * Is this pull request still writable, and does it describe the commit the
 * caller has locally?
 *
 * LOCAL MODE ONLY, and deliberately not folded into `submitReview`: PR mode's
 * handler has never made this call and 5a must not change what it does. It is
 * also a LIVE read — `pr_metadata` has no TTL, so the cached `head_sha` a
 * local session carries can be arbitrarily old, and a review submitted against
 * a stale head anchors every line comment to a commit the PR has moved past.
 *
 * Fails CLOSED. An unreachable GitHub means we do not know whether the PR
 * moved, and "do not know" may not authorise a write. That is the opposite of
 * every other PR-side check in local mode (the metadata pill, the stale badge,
 * the draft indicator all fail open), and the difference is the point: those
 * inform, this one writes.
 *
 * "FAILS CLOSED" IS NOT "ANSWERS 502". `GitHubClient.fetchPullRequest` REJECTS
 * with a `GitHubApiError` (src/github/errors.js) carrying `.status`; it does
 * not resolve null for a missing PR. A blanket catch therefore turned every
 * authoritative answer GitHub gave — gone, not yours, no scopes, rate-limited —
 * into one 502 `pr_state_unknown`, which tells the user to retry a request that
 * cannot succeed and leaves the routes' vocabulary (`auth_failed`,
 * `insufficient_permissions`, `rate_limited`) unreachable from here. So a
 * status-bearing failure is CLASSIFIED, and 502 `pr_state_unknown` is reserved
 * for what it names: a transport failure or any response that genuinely leaves
 * the PR's state unknown. All of them are still refusals — classification
 * changes the code the user sees, never the verdict.
 *
 * LIFECYCLE IS PER-EVENT, not per-PR. GitHub accepts a `COMMENT` review, and
 * inline review comments, on a closed or merged pull request; only the
 * approving events (`APPROVE`, `REQUEST_CHANGES`) and a new pending review
 * (`DRAFT`) are meaningless once it is settled. Refusing all four blocked
 * legitimate post-merge feedback and diverged from PR mode, which has no
 * lifecycle check at all. An ABSENT `event` still refuses everything: a caller
 * that did not say what it intends does not get the permissive branch.
 *
 * Full credential, NOT `withoutTokenRefresh`: this is a user-initiated write
 * with no client deadline, so an expired cached token SHOULD be refreshed
 * rather than turned into a refusal. `fetchRemotePRHead` in
 * src/providers/stale-check.js strips the refresh because it runs on an
 * advisory 1200ms budget; that reasoning does not transfer here.
 *
 * @param {Object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.prNumber
 * @param {Object|string} params.credential - Resolved binding or bare token
 * @param {string|null} params.localHeadSha - The commit the local review is
 *   rendering. Null (unreadable HEAD) is a refusal, not a pass.
 * @param {string} [params.event] - The review event the caller intends, one of
 *   `SUBMIT_EVENTS`. Only the lifecycle branches read it; omitting it keeps the
 *   original conservative behaviour (a settled PR refuses every event).
 * @param {Object} [_deps]
 * @returns {Promise<{ok: true, prData: Object}|{ok: false, status: number, code: string, error: string}>}
 */
async function checkSubmitPreconditions({ owner, repo, prNumber, credential, localHeadSha, event }, _deps) {
  const deps = { ...defaults, ..._deps };

  if (!localHeadSha) {
    return {
      ok: false,
      status: 409,
      code: 'local_head_unknown',
      error: 'Could not read the local HEAD commit, so it cannot be checked against the pull request head. '
        + 'Refusing to submit a review whose line numbers may describe a different commit.'
    };
  }

  let prData;
  try {
    const client = new deps.GitHubClient(credential);
    prData = await client.fetchPullRequest(owner, repo, prNumber);
  } catch (error) {
    return classifyPRReadFailure(error, prNumber);
  }

  // Kept for a client that ANSWERS null instead of rejecting — a mock, or an
  // alt-host transport that reports a missing PR that way. The production
  // client reaches the 404 above instead, via `GitHubApiError.status`.
  if (!prData) {
    return {
      ok: false,
      status: 404,
      code: 'pr_not_found',
      error: `Pull request #${prNumber} not found`
    };
  }

  // A COMMENT review is still legal on a settled pull request; see LIFECYCLE IS
  // PER-EVENT above. The comparison is against the literal 'COMMENT' so an
  // absent or unrecognised event falls to the refusal.
  const eventSurvivesSettledPR = event === 'COMMENT';

  if (prData.merged && !eventSurvivesSettledPR) {
    return {
      ok: false,
      status: 410,
      code: 'pr_merged',
      error: `Pull request #${prNumber} has been merged, so it can no longer be approved, `
        + 'have changes requested, or hold a new draft review. You can still submit a '
        + 'Comment review on it.'
    };
  }

  if (prData.state === 'closed' && !prData.merged && !eventSurvivesSettledPR) {
    return {
      ok: false,
      status: 410,
      code: 'pr_closed',
      error: `Pull request #${prNumber} is closed, so it can no longer be approved, `
        + 'have changes requested, or hold a new draft review. You can still submit a '
        + 'Comment review on it.'
    };
  }

  // HARD REFUSE on drift, no force override — plans/bridge-local-and-pr-modes.md
  // decision 1. Every line comment is a (path, line) pair resolved against the
  // PR's head commit; submitting from a different commit posts them against
  // lines that have moved, and there is no way for the reader to tell.
  if (prData.head_sha && prData.head_sha !== localHeadSha) {
    return {
      ok: false,
      status: 409,
      code: 'head_drift',
      error: `Your local HEAD (${localHeadSha.slice(0, 7)}) is not the head commit of pull request `
        + `#${prNumber} (${prData.head_sha.slice(0, 7)}). Push or pull so the two match, then submit again.`
    };
  }

  if (!prData.head_sha) {
    return {
      ok: false,
      status: 502,
      code: 'pr_state_unknown',
      error: `GitHub did not report a head commit for pull request #${prNumber}, `
        + 'so it cannot be checked against your local HEAD.'
    };
  }

  return { ok: true, prData };
}

/**
 * What, if anything, a failed GitHub write left behind on the pull request.
 *
 * THE FACTS COME FROM THE ORCHESTRATION, NOT FROM HERE. `GitHubClient` stamps
 * every failure it flattens with `error.reviewWriteProgress` — the phase that
 * failed, how many comments GitHub CONFIRMED, whether that count is exact,
 * whether the pending review pre-existed, and whether the cleanup delete
 * succeeded (see `newReviewWriteProgress` in src/github/client.js). Only that
 * layer knows any of it; this function reads the report and decides what to
 * tell the user.
 *
 * WHAT THE PREVIOUS GUESS GOT WRONG, in both directions:
 *   - It warned whenever a pre-existing draft was reused and any comment was
 *     SENT. An auth failure or a rate limit at the very first batch writes
 *     nothing, yet was relabelled 409 `partially_posted` — burying the routes'
 *     actionable 401/429 mapping under a generic "do not retry".
 *   - It stayed SILENT when the review was newly created. But cleanup only ever
 *     covered the comment phase: a failure of the FINAL SUBMIT mutation left a
 *     pending review holding every comment, with no warning at all. (The submit
 *     phase now deletes that review; this function reports the case where the
 *     delete itself failed.)
 *
 * THE THREE OUTCOMES
 *   null              — nothing is on GitHub. The original error propagates
 *                       UNCHANGED, so each route's catch ladder keeps its own
 *                       classification (auth, permission, not found, rate
 *                       limit) instead of a blanket 409.
 *   'reused_draft'    — comments landed, or may have, on the user's OWN pending
 *                       review. We never delete that (it can hold comments from
 *                       earlier sessions), so they stay.
 *   'orphaned_review' — comments landed on a review WE created and could not
 *                       delete. Same residue, different cleanup instruction.
 *
 * "MAY HAVE" IS RESIDUE TOO. When the comment transport throws mid-flight the
 * request may have been applied and only the response lost, so
 * `commentsWrittenExact === false` is treated as residue rather than as zero.
 * Warning about comments that turn out not to exist costs the user one look at
 * a draft; staying silent about comments that do exist costs them a duplicate
 * review.
 *
 * WITHOUT A REPORT (an uninstrumented client — a test double, a future
 * transport) the old structural guess is all there is, so it is kept as the
 * fallback: it errs toward warning, which is the safe direction.
 *
 * @param {Error} error - The rejection from the review-creating call
 * @param {Object} context
 * @param {Object|null} context.existingDraft - The reused pending review, if any
 * @param {number} context.sentComments - How many comments this call carried
 * @returns {{kind: string, written: number, exact: boolean}|null}
 */
function assessWriteResidue(error, { existingDraft, sentComments }) {
  const progress = error && error.reviewWriteProgress;

  if (!progress) {
    return (existingDraft && sentComments > 0)
      ? { kind: 'reused_draft', written: 0, exact: false }
      : null;
  }

  const written = Number(progress.commentsWritten) || 0;
  const exact = progress.commentsWrittenExact !== false;
  const mayHaveWritten = !exact && (Number(progress.commentsSent) || 0) > 0;

  // Nothing confirmed and nothing in doubt: the write never touched the PR.
  if (written === 0 && !mayHaveWritten) return null;

  if (progress.reviewPreExisted) return { kind: 'reused_draft', written, exact };

  // We created the review, and the client deleted it: the comments went with
  // it, so a retry is clean and the error keeps its own classification.
  if (progress.cleanupSucceeded === true) return null;

  return { kind: 'orphaned_review', written, exact };
}

/**
 * Re-label a failed GitHub write that LEFT COMMENTS BEHIND on the pull request.
 *
 * THE HAZARD. `submitReview` throws before touching a single `comments` row, so
 * every comment is still `active`; a retry reloads the SAME complete set and
 * sends it into the SAME place, duplicating whatever landed the first time. The
 * failure is silent to the user, and the second attempt makes it worse.
 *
 * WHY THIS IS THE FIX FOR NOW. Reconciling durably would mean persisting a
 * per-comment success identity (which comment became which GitHub node) inside
 * the failing write — that is a schema change and a real reconciliation pass,
 * out of scope for Phase 5. What IS in scope is not lying about the state: a
 * stable `partially_posted` code that names where the residue is and sends the
 * user to look before retrying. Loud and honest beats silent and doubled.
 *
 * ONE CODE, TWO MESSAGES. `partially_posted` (409) is the code for both residue
 * kinds because it carries the one instruction that matters and that no other
 * failure carries — DO NOT RETRY BLINDLY — and all three callers already route
 * on it (`src/main.js` matches the code, not the text). What differs is the
 * cleanup the user must do: check their own draft, or delete a pending review
 * we created and failed to remove.
 *
 * NO RESIDUE MEANS NO RE-LABEL. The error passes through UNCHANGED so both
 * routes' catch ladders classify it exactly as they do today — `auth_failed`,
 * `insufficient_permissions`, `rate_limited`, `not_found` all keep reporting as
 * themselves.
 *
 * @param {Error} error - The rejection from the review-creating call
 * @param {Object} context
 * @param {Object|null} context.existingDraft - The reused pending review, if any
 * @param {number} context.sentComments - How many comments this call carried
 * @param {number} context.prNumber
 * @param {string} context.hostName
 * @returns {Error} A `SubmitReviewError` when something was left behind, else
 *   the original error
 */
function describePartialWriteRisk(error, { existingDraft, sentComments, prNumber, hostName }) {
  const residue = assessWriteResidue(error, { existingDraft, sentComments });
  if (!residue) return error;

  // "3 of these 5 comments" when GitHub confirmed a count; "some of these 5"
  // when the transport died without answering.
  const countPhrase = residue.exact && residue.written > 0
    ? `${residue.written} of these ${sentComments} comment${sentComments === 1 ? '' : 's'} `
      + `${residue.written === 1 ? 'is' : 'are'} already`
    : `some of these ${sentComments} comment${sentComments === 1 ? '' : 's'} may already be`;

  let message;
  if (residue.kind === 'reused_draft') {
    const draftRef = existingDraft && existingDraft.url
      ? existingDraft.url
      : (existingDraft && existingDraft.databaseId != null)
        ? `pending review ${existingDraft.databaseId}`
        : 'your pending review';

    message =
      `The write to your existing pending review on pull request #${prNumber} failed part way through, `
      + `so ${countPhrase} on that draft: ${error.message} `
      + `Open the pending review on ${hostName} (${draftRef}) and check what it holds before submitting `
      + 'again — resubmitting now would post the comments that did land a second time.';
  } else {
    const progress = error.reviewWriteProgress || {};
    const reviewRef = progress.reviewUrl
      ? progress.reviewUrl
      : progress.reviewId != null
        ? `pending review ${progress.reviewId}`
        : 'the pending review';

    message =
      `The review write to pull request #${prNumber} failed, and the pending review it created could `
      + `NOT be deleted afterwards, so ${countPhrase} on it: ${error.message} `
      + `Open ${reviewRef} on ${hostName} and delete or submit it before trying again — resubmitting `
      + 'now would post the comments that did land a second time.';
  }

  const partial = new SubmitReviewError(message, { status: 409, code: 'partially_posted' });
  partial.cause = error;
  return partial;
}

/**
 * Submit (or draft) one review's comments to GitHub and record the outcome.
 *
 * THE WHOLE WRITE, so the two routes cannot drift into two write paths. What
 * the caller still owns: which PR, which credential, which diff, and — local
 * mode — `checkSubmitPreconditions`.
 *
 * ERROR CONTRACT
 *   - `SubmitReviewError` for refusals this provider decides (a missing
 *     GraphQL node id, comments outside the PR) and for the one failure it
 *     RE-LABELS: `partially_posted` (409), when the failed write LEFT COMMENTS
 *     ON GITHUB — either on the user's reused pending draft or on a review the
 *     client created and could not delete. The client reports which; this layer
 *     never guesses. Both routes map `.status` / `.message` straight through;
 *     the original rejection is kept on `.cause`. See
 *     `describePartialWriteRisk`.
 *   - Everything else propagates UNCHANGED from `GitHubClient` and the
 *     database, because each route's existing catch ladder classifies GitHub
 *     failures by message. Normalising them here would change PR mode's
 *     status codes.
 *
 * WHAT A NON-DRAFT SUBMISSION DOES TO A DRAFT'S COMMENTS. A `DRAFT` submission
 * marks this review's active comments `draft`. Finalising that same GitHub
 * draft later (any other event, consuming `existingDraft`) sends only the
 * comments that are still `active` — correct, the drafted ones are already on
 * GitHub — but GitHub submits the WHOLE pending review, drafted comments
 * included. So the finalising pass also promotes this review's earlier `draft`
 * rows to `submitted`, in the same transaction and with the same stamp, and
 * folds the draft's own comment count into the reported total. Without both,
 * the local record claims a smaller review than the one GitHub published.
 *
 * COMMENTS OVERRIDE (`commentsOverride`) — THE HEADLESS SEAM
 * ----------------------------------------------------------
 * The default answer to "which rows is this review made of" is
 * `loadSubmittableComments`: `source = 'user' AND status = 'active'`. The
 * headless `--ai-review` / `--ai-draft` flow answers it differently on all
 * three counts, so it hands the answer in rather than teaching this function
 * to sniff for a mode:
 *
 *   `{ comments, status }`
 *     `comments` — the rows to send, ALREADY SELECTED AND ALREADY BODIED by the
 *                  caller, in `loadSubmittableComments`'s column shape
 *                  (`id`, `file`, `line_start`, `line_end`, `body`, `side`,
 *                  `is_file_level`). Headless supplies unadopted AI suggestions
 *                  whose bodies went through `formatAISuggestion` first; that
 *                  formatting is a CLI presentation choice and has no business
 *                  in here. An EMPTY array is legal and means "submit a review
 *                  with no inline comments".
 *     `status`   — the `comments.status` those rows take after a successful
 *                  write. The default path derives it from the event
 *                  (`DRAFT` → `'draft'`, else `'submitted'`); headless carries
 *                  its own `options.commentStatus` and must not have it
 *                  re-derived underneath it.
 *
 * Everything else is unchanged: the same diff-line validation, the same
 * file-level degradation, the same GitHub write, the same transaction, the same
 * `github_reviews` mirror row. Gaining the validation is the POINT — a headless
 * AI suggestion whose line is outside a hunk now degrades to a file-level
 * `(Ref Line N)` comment instead of posting a position GitHub cannot render.
 *
 * WHAT THE OVERRIDE ALSO TURNS OFF: the "promote this review's earlier `draft`
 * rows" statement below. That statement is scoped to `source = 'user'` because
 * the default row set is, and it exists to keep the rows THIS function drafted
 * in step with the pending review it is now finalising. A caller that supplied
 * its own row set owns that bookkeeping too — this function will not reach past
 * the rows it was handed and update ones it has never seen.
 *
 * ORDER OF OPERATIONS: the GitHub write happens BEFORE the database
 * transaction opens, so a SQLite write lock is never held across a network
 * round-trip. The accepted consequence (unchanged from the original PR-mode
 * implementation) is that a GitHub success followed by a database failure
 * leaves a review on GitHub with no local record. For a DRAFT the pending-draft
 * sync recovers it on the next load; for a submitted review there is no
 * reconciliation path.
 *
 * @param {Object} params
 * @param {Object} params.db - Database handle
 * @param {number} params.reviewId - `reviews.id` whose comments are submitted
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.prNumber
 * @param {string} params.event - One of `SUBMIT_EVENTS`
 * @param {string} [params.body] - Review summary
 * @param {Object|string} params.credential - Resolved binding or bare token
 * @param {string|null} [params.prNodeId] - GraphQL node id of the PR. Required
 *   only when the dispatcher routes to GraphQL; see the refusal below.
 * @param {string|null} [params.headSha] - The PR's head commit. Required by
 *   the host pending-review-comments path, ignored by GraphQL on github.com.
 * @param {string} [params.diffContent] - See `formatCommentsForGraphQL`
 * @param {Set<string>|null} [params.filesWithLocalEdits] - See same
 * @param {boolean} [params.trustLeftAnchors=true] - May LEFT-side comments keep
 *   their line numbers? See `formatCommentsForGraphQL`, reason (4). The default
 *   is PR mode's answer; local mode must pass the same predicate its read side
 *   computes (`_externalAnchorContext`), never a bare `true`.
 * @param {boolean} [params.refuseCommentsOutsideDiff=false] - Refuse, before
 *   contacting GitHub, when a comment targets a file the diff does not touch.
 *   Local mode only; see `filesNotInDiff` for why PR mode does not ask.
 * @param {string} [params.hostName='GitHub'] - Display name of the host, for
 *   the success message. Resolve it with `resolveHostName`; never hardcode.
 * @param {{comments: Array<Object>, status: string}|null} [params.commentsOverride=null]
 *   THE HEADLESS SEAM. See COMMENTS OVERRIDE below.
 * @param {Object} [params._deps]
 * @returns {Promise<{success: true, message: string, github_url: string,
 *   comments_submitted: number, event: string, status: string|undefined}>}
 */
async function submitReview({
  db,
  reviewId,
  owner,
  repo,
  prNumber,
  event,
  body,
  credential,
  prNodeId = null,
  headSha = null,
  diffContent = '',
  filesWithLocalEdits = null,
  trustLeftAnchors = true,
  refuseCommentsOutsideDiff = false,
  hostName = 'GitHub',
  commentsOverride = null,
  _deps
} = {}) {
  const deps = { ...defaults, ..._deps };
  const githubClient = new deps.GitHubClient(credential);

  if (commentsOverride && !Array.isArray(commentsOverride.comments)) {
    throw new TypeError('commentsOverride.comments must be an array of comment rows');
  }
  if (commentsOverride && typeof commentsOverride.status !== 'string') {
    throw new TypeError('commentsOverride.status must be the comment status to apply after the write');
  }

  // See COMMENTS OVERRIDE above. Absent, this is the only row set there is.
  const comments = commentsOverride
    ? commentsOverride.comments
    : await loadSubmittableComments(db, reviewId, deps);

  // Built once and shared: `filesNotInDiff` and the per-comment shaping ask the
  // same parsed diff two different questions.
  const diffLineSet = buildDiffLineSet(diffContent || '');
  const orphanFiles = refuseCommentsOutsideDiff
    ? filesNotInDiff(comments, diffLineSet, diffContent)
    : [];
  if (orphanFiles.length > 0) {
    const shown = orphanFiles.slice(0, 5).join(', ');
    const rest = orphanFiles.length > 5 ? ` (and ${orphanFiles.length - 5} more)` : '';
    throw new SubmitReviewError(
      `${orphanFiles.length} file${orphanFiles.length === 1 ? '' : 's'} you commented on `
      + `${orphanFiles.length === 1 ? 'is' : 'are'} not part of pull request #${prNumber}: ${shown}${rest}. `
      + 'GitHub can only take comments on files the pull request changes — commit and push those '
      + 'changes, or remove those comments, then submit again.',
      { status: 409, code: 'comments_outside_pr' }
    );
  }

  const graphqlComments = formatCommentsForGraphQL(
    { comments, diffLineSet, filesWithLocalEdits, trustLeftAnchors }, deps
  );

  deps.logger.log(
    'API',
    `${event === 'DRAFT' ? 'Creating draft review' : 'Submitting review'} for PR #${prNumber} `
    + `with ${comments.length} comments`,
    'cyan'
  );

  // Always check for an existing pending draft first: GitHub allows only one
  // pending review per user per PR.
  const existingDraft = await githubClient.getPendingReviewForUser(owner, repo, prNumber);

  // The GraphQL PR node id is only required when the dispatcher actually routes
  // to a GraphQL implementation AND we will create a brand new review (rather
  // than reusing the existing draft) OR add GraphQL review comments. The REST
  // review-lifecycle and host pending-review-comments paths address the PR by
  // (owner, repo, prNumber) + numeric review id and ignore `prNodeId`; reusing
  // an existing GraphQL draft does not need it either, because the review node
  // id is sufficient. Computed AFTER `existingDraft` so the requirement is
  // narrowed correctly.
  const willCreateNewGraphQLReview =
    githubClient.features.review_lifecycle === 'graphql' && !existingDraft;
  const willAddGraphQLComments =
    graphqlComments.length > 0 && githubClient.features.pending_review_comments === 'graphql';

  if ((willCreateNewGraphQLReview || willAddGraphQLComments) && !prNodeId) {
    throw new SubmitReviewError(
      `GraphQL PR node id required for ${owner}/${repo}#${prNumber} `
      + `(features.review_lifecycle = "${githubClient.features.review_lifecycle}", `
      + `pending_review_comments = "${githubClient.features.pending_review_comments}"). `
      + 'PR record is missing node_id — refresh the PR data and try again.',
      { status: 400, code: 'missing_pr_node_id' }
    );
  }

  // `headSha` is required by the host pending-review-comments path
  // (GitHub-compatible alt-hosts validate each inline comment like
  // `pulls.createReviewComment`, which mandates `commit_id`). The GraphQL path
  // on github.com ignores it — the pending review pins the commit implicitly —
  // so threading it through is harmless there. Missing is not fatal, but warn
  // loudly so the resulting 422 is diagnosable.
  if (!headSha) {
    deps.logger.warn(
      `Submit review for ${owner}/${repo}#${prNumber}: PR head SHA is missing. `
      + 'Host inline-comment posting will likely fail with a 422 missing commit_id error.'
    );
  }

  const submitPrContext = {
    owner,
    repo,
    prNumber,
    reviewId: existingDraft?.databaseId,
    headSha: headSha || null
  };

  let githubReview;
  try {
    if (event === 'DRAFT') {
      // `createDraftReviewGraphQL` handles both new and existing drafts.
      githubReview = await githubClient.createDraftReviewGraphQL(
        prNodeId, body || '', graphqlComments, existingDraft?.id, submitPrContext
      );
    } else {
      githubReview = await githubClient.createReviewGraphQL(
        prNodeId, event, body || '', graphqlComments, existingDraft?.id, submitPrContext
      );
    }
  } catch (writeError) {
    // Unchanged pass-through unless the write left comments on GitHub — which
    // the CLIENT reports (`writeError.reviewWriteProgress`) rather than this
    // layer guessing. See `describePartialWriteRisk` / `assessWriteResidue`.
    throw describePartialWriteRisk(writeError, {
      existingDraft,
      sentComments: graphqlComments.length,
      prNumber,
      hostName
    });
  }

  // Whatever we just wrote joined a draft that already existed, so the draft's
  // own comments are part of the result: keep its URL when the mutation did not
  // return one, and report the TOTAL rather than only what this call added.
  // True for both events — a DRAFT grows the pending review, a non-DRAFT
  // submits the pending review whole. The client counts only the comments IT
  // added (`successfulComments`), so this addition cannot double-count.
  if (existingDraft) {
    githubReview.html_url = githubReview.html_url || existingDraft.url;
    githubReview.comments_count =
      (existingDraft.comments?.totalCount || 0) + githubReview.comments_count;
  }

  // ID storage strategy:
  // - github_reviews.github_review_id -> numeric database id (consistent with
  //   syncPendingDraftFromGitHub)
  // - github_reviews.github_node_id   -> GraphQL node id, always present
  // - reviewData JSON                 -> 'github_node_id' key
  // - reviews.review_id               -> legacy column, no longer written
  const githubNodeId = String(githubReview.id);
  const githubDatabaseId = githubReview.databaseId
    ? String(githubReview.databaseId)
    : (existingDraft && existingDraft.databaseId != null)
      ? String(existingDraft.databaseId)
      : null;   // absent means SQL NULL, never the string "null"

  const reviewData = {
    github_node_id: githubNodeId,
    github_url: githubReview.html_url,
    event: event,
    body: body || '',
    comments_count: githubReview.comments_count
  };
  if (event === 'DRAFT') {
    reviewData.created_at = new Date().toISOString();
  } else {
    reviewData.submitted_at = new Date().toISOString();
  }

  // Transaction opened only now — see ORDER OF OPERATIONS above.
  await deps.run(db, 'BEGIN TRANSACTION');

  try {
    const reviewRepo = new deps.ReviewRepository(db);
    await reviewRepo.updateAfterSubmission(reviewId, { event, reviewData });

    // UPSERT, not insert: submitting a draft keeps the SAME GitHub review id
    // and node id, so the row the draft sync already mirrored IS this row — a
    // second insert both duplicates it and violates the unique indexes
    // migration 57 added. This is the one writer for an identified
    // `github_reviews` row; see the hazard list in the plan.
    const githubReviewRepo = new deps.GitHubReviewRepository(db);
    await githubReviewRepo.upsertFromGitHub(reviewId, {
      github_review_id: githubDatabaseId,
      github_node_id: githubNodeId,
      state: event === 'DRAFT' ? 'pending' : 'submitted',
      event: event === 'DRAFT' ? null : event,
      body: body || '',
      submitted_at: event === 'DRAFT' ? null : new Date().toISOString(),
      github_url: githubReview.html_url
    });

    deps.logger.log(
      'API',
      `${event === 'DRAFT' ? 'Draft review created' : 'Review submitted'} successfully: `
      + `${githubReview.html_url}${event === 'DRAFT' ? ' (Review ID: ' + githubReview.id + ')' : ''}`,
      'green'
    );

    const commentStatus = commentsOverride
      ? commentsOverride.status
      : event === 'DRAFT' ? 'draft' : 'submitted';
    const commentUpdateTime = new Date().toISOString();
    for (const comment of comments) {
      await deps.run(db, `
        UPDATE comments
        SET status = ?, updated_at = ?
        WHERE id = ?
      `, [commentStatus, commentUpdateTime, comment.id]);
    }

    // Finalising a pending review submits everything already on it, including
    // the comments an earlier DRAFT pass marked `draft` locally and did NOT
    // resend. Promote them here or they stay `draft` forever while GitHub shows
    // them published — the parent review, the rows, and every count derived
    // from them would disagree with the host.
    //
    // Same transaction and the SAME stamp as the loop above, so one submission
    // reads as one event. Order is immaterial: the loop only ever touches rows
    // that were `active`, and this statement only ever touches rows that were
    // `draft`. Scoped to `source = 'user'` for the reason
    // `loadSubmittableComments` is — an unadopted AI suggestion is not part of
    // any review, whatever status it carries.
    //
    // SKIPPED under `commentsOverride`: that caller chose its own row set, so
    // this statement's `source = 'user'` predicate is not its predicate and the
    // rows it would touch are ones this call never loaded. See COMMENTS
    // OVERRIDE above.
    if (event !== 'DRAFT' && existingDraft && !commentsOverride) {
      await deps.run(db, `
        UPDATE comments
        SET status = 'submitted', updated_at = ?
        WHERE review_id = ? AND source = 'user' AND status = 'draft'
      `, [commentUpdateTime, reviewId]);
    }

    await deps.run(db, 'COMMIT');
  } catch (submitError) {
    await deps.run(db, 'ROLLBACK');
    throw submitError;
  }

  return {
    success: true,
    message: `${event === 'DRAFT' ? 'Draft review created' : 'Review submitted'} successfully `
      + `${event === 'DRAFT' ? 'on' : 'to'} ${hostName}`,
    github_url: githubReview.html_url,
    comments_submitted: githubReview.comments_count,
    event: event,
    // Drafts alone report their state; PR mode's client reads it.
    status: event === 'DRAFT' ? githubReview.state : undefined
  };
}

module.exports = {
  SUBMIT_EVENTS,
  SubmitReviewError,
  submitReview,
  checkSubmitPreconditions,
  _internals: {
    formatCommentsForGraphQL,
    loadSubmittableComments,
    filesNotInDiff,
    classifyPRReadFailure,
    describePartialWriteRisk,
    assessWriteResidue
  },
};
