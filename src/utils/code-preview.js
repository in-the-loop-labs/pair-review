// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('fs').promises;
const path = require('path');
const simpleGit = require('simple-git');
const { WorktreeRepository, queryOne } = require('../database');
const { safeParseJson } = require('./safe-parse-json');

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const defaults = { fs, git: simpleGit };

function previewError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function resolvePreviewRepository(db, review) {
  if (review.local_path) return { root: review.local_path, headSha: review.local_head_sha };
  const worktree = await new WorktreeRepository(db).findByPR(review.pr_number, review.repository);
  if (!worktree?.path) throw previewError('Worktree not found. Reload this review.', 404);
  const metadata = await queryOne(db,
    'SELECT pr_data FROM pr_metadata WHERE pr_number = ? AND repository = ? COLLATE NOCASE',
    [review.pr_number, review.repository]);
  return { root: worktree.path, headSha: safeParseJson(metadata?.pr_data, null)?.head_sha };
}

function normalizePreviewPath(file, root, repository) {
  if (typeof file !== 'string' || !file.trim() || file.includes('\0')) {
    throw previewError('A file path is required.');
  }
  let relative = file.trim();
  if (relative.startsWith('//') && repository?.toLowerCase() === 'shop/world') {
    relative = relative.slice(2);
  } else if (path.isAbsolute(relative)) {
    relative = path.relative(root, relative);
  }
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\\')) {
    throw previewError('The file must be inside this repository.');
  }
  const segments = relative.split('/');
  if (segments.some(segment => segment === '..' || segment.toLowerCase() === '.git')) {
    throw previewError('The file must be inside this repository.');
  }
  relative = path.posix.normalize(relative);
  if (relative === '.') throw previewError('The path must identify a file.');
  return relative;
}

/** Read the version the agent sees, without expanding a sparse checkout. */
async function readCodePreview(review, location, requestedFile, _deps = {}) {
  const deps = { ...defaults, ..._deps };
  const fileName = normalizePreviewPath(requestedFile, location.root, review.repository);
  let contents;
  let source;
  let revision = null;
  if (review.local_path) {
    try {
      const [realRoot, realFile] = await Promise.all([
        deps.fs.realpath(location.root), deps.fs.realpath(path.join(location.root, fileName))
      ]);
      if (!realFile.startsWith(realRoot + path.sep)) {
        throw previewError('The file must be inside this repository.', 403);
      }
      if (path.relative(realRoot, realFile).split(path.sep).some(segment => segment.toLowerCase() === '.git')) {
        throw previewError('The file must be inside this repository.', 403);
      }
      const stat = await deps.fs.stat(realFile);
      if (!stat.isFile()) throw previewError('The path is a directory, not a file.');
      if (stat.size > MAX_PREVIEW_BYTES) throw previewError('This file is too large to preview.', 413);
      contents = await deps.fs.readFile(realFile, 'utf8');
      source = 'Working tree';
    } catch (error) {
      // Missing tracked files can still be read from Git in sparse checkouts.
      // Do not fall back after access errors or a path validation failure.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (contents == null) {
    const git = deps.git(location.root);
    revision = location.headSha;
    if (!revision && review.local_path) revision = (await git.revparse(['HEAD'])).trim();
    if (!/^[a-f0-9]{7,40}$/i.test(revision || '')) {
      throw previewError('The review commit is unavailable. Reload this review.', 409);
    }
    const spec = `${revision}:${fileName}`;
    try {
      if ((await git.raw(['cat-file', '-t', spec])).trim() !== 'blob') {
        throw previewError('The path is a directory, not a file.');
      }
      const size = Number((await git.raw(['cat-file', '-s', spec])).trim());
      if (!Number.isFinite(size)) throw previewError('Could not read this file.', 404);
      if (size > MAX_PREVIEW_BYTES) throw previewError('This file is too large to preview.', 413);
      contents = await git.show([spec]);
    } catch (error) {
      if (error.statusCode) throw error;
      throw previewError('File not found at the review commit.', 404);
    }
    source = 'Review head';
  }
  if (Buffer.byteLength(contents, 'utf8') > MAX_PREVIEW_BYTES) {
    throw previewError('This file is too large to preview.', 413);
  }
  if (contents.includes('\0')) throw previewError('Binary files cannot be previewed.', 415);
  const lines = contents.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return { fileName, lines, totalLines: lines.length, source, revision };
}

module.exports = { readCodePreview, resolvePreviewRepository, normalizePreviewPath, MAX_PREVIEW_BYTES };
