// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const path = require('path');
const fs = require('fs').promises;
const { WorktreeRepository, queryOne } = require('../database');

async function existingDirectory(candidate) {
  try {
    return (await fs.stat(candidate)).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

/** Resolve the same repository root for context files and AI findings. */
async function resolveRepoRoot(db, review) {
  if (review?.local_path) return review.local_path;
  if (review?.pr_number && review.repository) {
    const worktreeRepo = new WorktreeRepository(db);
    const worktree = await worktreeRepo.findByPR(review.pr_number, review.repository);
    if (worktree?.path) {
      const currentPath = await existingDirectory(worktree.path);
      if (currentPath) return currentPath;
    }
    // --use-checkout deliberately skips the worktrees row, but persists the
    // checkout path with the PR metadata for both analysis and context files.
    const metadata = await queryOne(db, `
      SELECT pr_data FROM pr_metadata
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [review.pr_number, review.repository]);
    try {
      const checkoutPath = metadata?.pr_data ? JSON.parse(metadata.pr_data)?.worktree_path : null;
      if (!checkoutPath || typeof checkoutPath !== 'string') return null;
      // A pooled worktree can be reassigned after metadata records its path.
      // findByPR already missed, so any owner here belongs to another review.
      if (await worktreeRepo.findByPath(checkoutPath)) return null;
      return await existingDirectory(checkoutPath);
    } catch {
      return null;
    }
  }
  return null;
}

function isSafeRelativePath(file) {
  if (typeof file !== 'string') return false;
  const trimmed = file.trim();
  return trimmed.length > 0 && !trimmed.includes('\0') &&
    !path.isAbsolute(trimmed) && !path.win32.isAbsolute(trimmed) &&
    !trimmed.split(/[\\/]/).includes('..');
}

module.exports = { resolveRepoRoot, isSafeRelativePath };
