// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// Optional publication transform: prepare locally, preview, then publish the frozen payload.
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { z } = require('zod');
const { getRepoConfig } = require('./config');
const { buildDiffLineSet } = require('./utils/diff-annotator');

const defaults = { fs, execFile: promisify(execFile) };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };
const anchorSchema = z.object({
  id: z.number().int().positive(), path: z.string().min(1),
  line: z.number().int().positive(), side: z.enum(['LEFT', 'RIGHT']),
  start_line: z.number().int().positive().optional(),
  start_side: z.enum(['LEFT', 'RIGHT']).optional(), body: z.string().trim().min(1)
}).strict();
const payloadSchema = z.object({ body: z.string(), comments: z.array(anchorSchema) }).strict();

function publicationPolicy(config, repository) {
  return getRepoConfig(config, repository)?.review_submission || config.review_submission || null;
}

function assertInteractivePublication(config, repository, flags) {
  if (publicationPolicy(config, repository) && (flags.aiDraft || flags.aiReview)) {
    fail('This repository requires a publication preview. Open Pair Review to review and publish the transformed comments.');
  }
}

async function transformPublication(input, policy, _deps = {}) {
  const deps = { ...defaults, ..._deps };
  if (!policy || typeof policy.command !== 'string' || !Array.isArray(policy.args) ||
      !policy.args.every(arg => typeof arg === 'string') ||
      !policy.args.includes('{input}') || !policy.args.includes('{output}')) {
    fail('review_submission requires a command and args containing {input} and {output} as separate arguments.');
  }
  const directory = await deps.fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-publication-'));
  try {
    const inputPath = path.join(directory, 'input.json');
    const outputPath = path.join(directory, 'output.json');
    await deps.fs.writeFile(inputPath, JSON.stringify(input), { flag: 'wx', mode: 0o600 });
    const args = policy.args.map(arg => arg === '{input}' ? inputPath : arg === '{output}' ? outputPath : arg);
    try {
      await deps.execFile(policy.command, args, {
        cwd: directory, timeout: policy.timeout || 300000, maxBuffer: 1024 * 1024,
        env: { ...process.env, ...policy.env }, killSignal: 'SIGKILL'
      });
      const stat = await deps.fs.lstat(outputPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error();
      return validateTransformed(input, JSON.parse(await deps.fs.readFile(outputPath, 'utf8')));
    } catch {
      // A subprocess error may include private input or stderr. Never return it to the client.
      fail('Publication transform failed. Nothing was published; fix the transform and prepare again.');
    }
  } finally {
    await deps.fs.rm(directory, { recursive: true, force: true });
  }
}

function validateTransformed(input, output) {
  const parsed = payloadSchema.safeParse(output);
  if (!parsed.success) fail('Invalid transformed publication.');
  const originals = new Map(input.comments.map(comment => [comment.id, comment]));
  const seen = new Set();
  for (const comment of parsed.data.comments) {
    const original = originals.get(comment.id);
    const anchor = ({ body, ...rest }) => rest;
    if (!original || seen.has(comment.id) || hash(anchor(original)) !== hash(anchor(comment))) {
      fail('Publication transform changed a comment anchor or identifier.');
    }
    seen.add(comment.id);
  }
  return parsed.data;
}

function readState(db, reviewId) {
  return JSON.parse(db.prepare('SELECT review_data FROM reviews WHERE id = ?').get(reviewId)?.review_data || '{}').publication;
}

function writeState(db, reviewId, state) {
  db.prepare("UPDATE reviews SET review_data = json_set(COALESCE(review_data, '{}'), '$.publication', json(?)) WHERE id = ?")
    .run(JSON.stringify(state), reviewId);
}

function readSnapshot(db, reviewId, target, request, policy) {
  if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(request.event) || typeof request.body !== 'string') {
    fail('Choose Comment, Approve, or Request changes. Previewed publication does not send pending drafts.');
  }
  const row = db.prepare('SELECT pr_data FROM pr_metadata WHERE repository = ? COLLATE NOCASE AND pr_number = ?')
    .get(target.repository, target.number);
  const pr = JSON.parse(row?.pr_data || '{}');
  if (!request.headSha || !request.baseSha || request.headSha !== pr.head_sha || request.baseSha !== pr.base_sha) {
    fail('The displayed PR revision changed. Refresh and review it before preparing publication.');
  }
  const comments = db.prepare(`SELECT id, file, line_start, line_end, body, side, commit_sha, is_file_level
    FROM comments WHERE review_id = ? AND source = 'user' AND status = 'active' ORDER BY id`).all(reviewId);
  if (comments.some(c => c.commit_sha && c.commit_sha !== request.headSha)) {
    fail('Some comments were reviewed on an older commit. Re-review them against the current revision.');
  }
  return { target, event: request.event, body: request.body, headSha: request.headSha,
    baseSha: request.baseSha, comments, policyHash: hash(policy) };
}

async function assertFresh(client, target, snapshot) {
  const pr = await client.fetchPullRequest(target.owner, target.repo, target.number);
  if (pr.state !== 'open' || pr.head_sha !== snapshot.headSha || pr.base_sha !== snapshot.baseSha) {
    fail('The upstream PR revision changed or closed. Refresh and review it before publishing.');
  }
}

function buildInput(snapshot, diff) {
  const lines = buildDiffLineSet(diff);
  return { body: snapshot.body, comments: snapshot.comments.map(c => {
    const side = c.side || 'RIGHT';
    const end = c.line_end || c.line_start;
    if (c.is_file_level || !lines.isLineInDiff(c.file, c.line_start, side) || !lines.isLineInDiff(c.file, end, side)) {
      fail('A comment is outside the reviewed diff. Move it into the review summary before preparing publication.');
    }
    return { id: c.id, path: c.file, line: end, side,
      ...(end !== c.line_start ? { start_line: c.line_start, start_side: side } : {}), body: c.body };
  }) };
}

async function publicationReviews(client, target) {
  return client.octokit.paginate(client.octokit.rest.pulls.listReviews,
    { owner: target.owner, repo: target.repo, pull_number: target.number, per_page: 100 });
}

function receiptFor(review, state) {
  return { success: true, github_url: review.html_url, github_review_id: review.id,
    comments_submitted: state.payload.comments.length, event: state.event };
}

function recordReceipt(db, reviewId, state, receipt) {
  db.transaction(() => {
    writeState(db, reviewId, { ...state, status: 'submitted', receipt });
    for (const id of state.payload.comments.map(c => c.id)) {
      // Edits made while the provider request was in flight remain drafts.
      const originalHash = state.commentHashes[id];
      const row = db.prepare(`SELECT id, file, line_start, line_end, body, side, commit_sha, is_file_level
        FROM comments WHERE id = ? AND review_id = ? AND status = 'active'`).get(id, reviewId);
      if (row && hash(row) === originalHash) {
        db.prepare("UPDATE comments SET status = 'submitted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
      }
    }
  })();
  return receipt;
}

/**
 * No token prepares a preview. A token publishes only the saved payload.
 * SQLite claims serialize concurrent submitters. An ambiguous external write
 * stays locked until its public marker is reconciled, including across restarts.
 */
async function reviewPublication({ db, reviewId, target, request, policy, client }, _deps = {}) {
  const transform = _deps.transform || transformPublication;
  if (client.apiHost) fail('Previewed publication currently supports github.com repositories.');
  let previous = readState(db, reviewId);
  const token = request.publicationToken;
  if (token) {
    if (!previous || token !== previous.token) fail('The publication preview expired. Prepare it again.');
    if (previous.status === 'submitted') return previous.receipt;
    if (['submitting', 'uncertain'].includes(previous.status)) {
      const reviews = await publicationReviews(client, target);
      const found = reviews.find(r => r.user.id === previous.actorId && r.body?.includes(previous.marker) &&
        r.commit_id === previous.headSha && r.state !== 'PENDING');
      if (found) return recordReceipt(db, reviewId, previous, receiptFor(found, previous));
      fail('Publication may still be in progress. Retry to check its receipt; no second review will be sent.');
    }
  } else if (previous && ['submitting', 'uncertain'].includes(previous.status)) {
    return { previewRequired: true, publicationToken: previous.token, target: previous.target,
      headSha: previous.headSha, baseSha: previous.baseSha, event: previous.event,
      ...previous.payload, omittedComments: 0 };
  }
  const snapshot = readSnapshot(db, reviewId, target, request, policy);
  const fingerprint = hash(snapshot);
  if (token && fingerprint !== previous.fingerprint) fail('The draft changed after preview. Prepare and review it again.');
  const { data: actor } = await client.octokit.rest.users.getAuthenticated();
  await assertFresh(client, target, snapshot);
  if (await client.getPendingReviewForUser(target.owner, target.repo, target.number)) {
    fail('A pending remote review exists. Finish or remove it on GitHub before preparing this review.');
  }
  if (!token) {
    const { data: diff } = await client.octokit.rest.pulls.get({
      owner: target.owner, repo: target.repo, pull_number: target.number,
      mediaType: { format: 'diff' }
    });
    const input = buildInput(snapshot, diff);
    const payload = validateTransformed(input, await transform(input, policy));
    if (!payload.body.trim() && !payload.comments.length && snapshot.event !== 'APPROVE') {
      fail('The transformed review is empty. Nothing to publish.');
    }
    const marker = `<!-- pair-review-publication:${hash({ target, headSha: snapshot.headSha, event: snapshot.event, payload })} -->`;
    payload.body += `${payload.body ? '\n\n' : ''}${marker}`;
    const state = { token: crypto.randomUUID(), status: 'prepared', fingerprint,
      target, headSha: snapshot.headSha, baseSha: snapshot.baseSha, event: snapshot.event,
      actorId: actor.id, payload, marker, commentHashes: Object.fromEntries(snapshot.comments.map(c => [c.id, hash(c)])) };
    db.transaction(() => {
      previous = readState(db, reviewId);
      if (previous && ['submitting', 'uncertain'].includes(previous.status)) fail('Another publication is in progress.');
      if (hash(readSnapshot(db, reviewId, target, request, policy)) !== fingerprint) fail('The draft changed during preparation. Prepare again.');
      writeState(db, reviewId, state);
    })();
    return { previewRequired: true, publicationToken: state.token, target, headSha: state.headSha,
      baseSha: state.baseSha, event: state.event, ...payload,
      omittedComments: input.comments.length - payload.comments.length };
  }
  if (actor.id !== previous.actorId) fail('The publishing account changed. Prepare again.');
  // Reconcile identical public content even if a previous local receipt was lost.
  const reviews = await publicationReviews(client, target);
  const found = reviews.find(r => r.user.id === previous.actorId && r.body?.includes(previous.marker) &&
    r.commit_id === previous.headSha && r.state !== 'PENDING');
  if (found) return recordReceipt(db, reviewId, previous, receiptFor(found, previous));
  await assertFresh(client, target, snapshot);
  db.transaction(() => {
    const current = readState(db, reviewId);
    if (current?.token !== token || current.status !== 'prepared') fail('Another publication is in progress. Retry to check its receipt.');
    if (hash(readSnapshot(db, reviewId, target, request, policy)) !== fingerprint) fail('The draft changed after preview. Prepare again.');
    writeState(db, reviewId, { ...previous, status: 'submitting' });
  })();
  try {
    // Pin the review to the inspected commit. GitHub has no conditional-head write;
    // a push during this request can mark it outdated, never move it to a new commit.
    const { data: review } = await client.octokit.rest.pulls.createReview({
      owner: target.owner, repo: target.repo, pull_number: target.number,
      commit_id: previous.headSha, event: previous.event, body: previous.payload.body,
      comments: previous.payload.comments.map(({ id, ...comment }) => comment)
    });
    return recordReceipt(db, reviewId, previous, receiptFor(review, previous));
  } catch (error) {
    if ([400, 401, 403, 404, 422, 429].includes(error.status)) {
      writeState(db, reviewId, previous);
      fail('The provider rejected this review. Check its content and your permissions, then prepare again.');
    }
    writeState(db, reviewId, { ...previous, status: 'uncertain' });
    fail('The provider did not confirm publication. Retry to check its receipt; the review will not be sent twice.');
  }
}

module.exports = { publicationPolicy, assertInteractivePublication, transformPublication,
  validateTransformed, reviewPublication };
