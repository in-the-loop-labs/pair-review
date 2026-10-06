// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const express = require('express');
const request = require('supertest');
const previewRoutes = require('../../src/routes/code-preview');
const contextRoutes = require('../../src/routes/context-files');
const { normalizePreviewPath, MAX_PREVIEW_BYTES } = require('../../src/utils/code-preview');
const { run } = require('../../src/database');

describe('Code preview API', () => {
  let db, server, root, temp, headSha;
  const original = 'export function canViewReport(user) {\n  return user.role === "admin";\n}\n';
  function git(...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Preview Test', GIT_COMMITTER_NAME: 'Preview Test',
      GIT_AUTHOR_EMAIL: 'preview@example.test', GIT_COMMITTER_EMAIL: 'preview@example.test'
    }}).trim();
  }
  async function localReview() {
    await run(db, "INSERT INTO reviews (id, repository, review_type, local_path, local_head_sha, status) VALUES (1, 'owner/repo', 'local', ?, ?, 'draft')", [root, headSha]);
  }
  async function prReview() {
    await run(db, "INSERT INTO reviews (id, repository, review_type, pr_number, status) VALUES (1, 'owner/repo', 'pr', 1, 'draft')");
    await run(db, "INSERT INTO pr_metadata (pr_number, repository, pr_data) VALUES (1, 'owner/repo', ?)", [JSON.stringify({head_sha: headSha, changed_files: []})]);
    await run(db, "INSERT INTO worktrees (pr_number, repository, path, branch, created_at, last_accessed_at) VALUES (1, 'owner/repo', ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)", [root]);
  }
  function get(file, id = 1) { return request(server).get(`/api/reviews/${id}/code-preview/${encodeURIComponent(file)}`); }

  beforeEach(async () => {
    temp = mkdtempSync(path.join(tmpdir(), 'code-preview-'));
    root = path.join(temp, 'repo');
    mkdirSync(path.join(root, 'src'), {recursive: true});
    writeFileSync(path.join(root, 'src/helper.js'), original);
    git('init', '-q');
    git('add', 'src/helper.js');
    git('commit', '-qm', 'Preview fixture');
    headSha = git('rev-parse', 'HEAD');
    db = createTestDatabase();
    const app = express();
    app.use(express.json());
    app.set('db', db);
    app.use(previewRoutes);
    app.use(contextRoutes);
    server = await listenOnLoopback(app);
  });
  afterEach(async () => {
    if (server) await closeServer(server);
    if (db) closeTestDatabase(db);
    rmSync(temp, {recursive: true, force: true});
  });

  it('reads local working tree content and creates no context files', async () => {
    await localReview();
    writeFileSync(path.join(root, 'src/helper.js'), 'new working tree content\n');
    const response = await get('src/helper.js');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({fileName: 'src/helper.js', lines: ['new working tree content'], source: 'Working tree', revision: null});
    expect(db.prepare('SELECT COUNT(*) AS count FROM context_files').get().count).toBe(0);
  });
  it('reads a pinned PR commit even when HEAD and the filesystem have moved', async () => {
    await prReview();
    writeFileSync(path.join(root, 'src/helper.js'), 'later content\n');
    git('add', 'src/helper.js'); git('commit', '-qm', 'Later commit');
    const response = await get('src/helper.js');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({lines: original.trimEnd().split('\n'), source: 'Review head', revision: headSha});
  });
  it.each(['local', 'pr'])('reads tracked files absent from a %s checkout', async mode => {
    await (mode === 'local' ? localReview() : prReview());
    rmSync(path.join(root, 'src/helper.js'));
    const response = await get('src/helper.js');
    expect(response.status).toBe(200);
    expect(response.body.lines).toEqual(original.trimEnd().split('\n'));
    expect(response.body.source).toBe('Review head');
  });
  it('normalizes in-repository absolute paths', async () => {
    await localReview();
    expect((await get(path.join(root, 'src/helper.js'))).body.fileName).toBe('src/helper.js');
    expect(normalizePreviewPath('//areas/tools/example.js', root, 'shop/world')).toBe('areas/tools/example.js');
  });
  it('can explicitly keep a PR file absent from the checkout', async () => {
    await prReview();
    rmSync(path.join(root, 'src/helper.js'));
    const response = await request(server).post('/api/reviews/1/context-files')
      .send({file: 'src/helper.js', line_start: 1, line_end: 3});
    expect(response.status).toBe(201);
    expect(db.prepare('SELECT file FROM context_files').get().file).toBe('src/helper.js');
  });
  it.each(['../outside.txt', '.git/config', 'src/../../outside.txt', 'src\u0000/helper.js'])('rejects unsafe paths: %s', async file => {
    await localReview();
    expect((await get(file)).status).toBe(400);
  });
  it('rejects symlinks outside the local repository', async () => {
    await localReview();
    writeFileSync(path.join(temp, 'outside.txt'), 'private data');
    symlinkSync(path.join(temp, 'outside.txt'), path.join(root, 'src/link.js'));
    expect((await get('src/link.js')).status).toBe(403);
  });
  it('rejects symlinks into Git metadata', async () => {
    await localReview();
    symlinkSync(path.join(root, '.git/config'), path.join(root, 'src/link.js'));
    expect((await get('src/link.js')).status).toBe(403);
  });
  it('reports missing and directory paths', async () => {
    await localReview();
    expect((await get('missing.js')).status).toBe(404);
    expect((await get('src')).status).toBe(400);
  });
  it('rejects binary and oversized content', async () => {
    await localReview();
    writeFileSync(path.join(root, 'binary'), Buffer.from([1, 0, 2]));
    expect((await get('binary')).status).toBe(415);
    writeFileSync(path.join(root, 'large'), 'x'.repeat(MAX_PREVIEW_BYTES + 1));
    expect((await get('large')).status).toBe(413);
  });
  it('requires a known review', async () => {
    expect((await get('src/helper.js', 404)).status).toBe(404);
  });
  it('requires the pinned PR commit instead of silently showing HEAD', async () => {
    await prReview();
    await run(db, "UPDATE pr_metadata SET pr_data = '{}' WHERE pr_number = 1");
    expect((await get('src/helper.js')).status).toBe(409);
  });
});
