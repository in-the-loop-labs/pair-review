// SPDX-License-Identifier: GPL-3.0-or-later
const { promisify } = require('util');
const { exec } = require('child_process');
const { queryOne } = require('../database');

const execPromise = promisify(exec);

/**
 * Return the list of file paths that belong to the review's diff.
 * Works for both PR-mode and local-mode reviews.
 *
 * @param {object} db   - SQLite database handle
 * @param {object} review - Review row from the database
 * @returns {Promise<string[]>} Array of relative file paths in the diff
 */
async function getDiffFileList(db, review) {
  // PR mode – pull from pr_metadata table
  if (review.pr_number && review.repository) {
    try {
      const prRecord = await queryOne(db, `
        SELECT pr_data FROM pr_metadata
        WHERE pr_number = ? AND repository = ? COLLATE NOCASE
      `, [review.pr_number, review.repository]);

      if (prRecord?.pr_data) {
        const prData = JSON.parse(prRecord.pr_data);
        return (prData.changed_files || []).map(f => f.file);
      }
    } catch {
      // parse / query error – fall through to empty list
    }
    return [];
  }

  // Local mode – ask git for changed / untracked files
  if (review.local_path) {
    try {
      const opts = { cwd: review.local_path };
      const [{ stdout: unstaged }, { stdout: untracked }] = await Promise.all([
        execPromise('git diff --name-only', opts),
        execPromise('git ls-files --others --exclude-standard', opts),
      ]);
      const combined = `${unstaged}\n${untracked}`
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      return [...new Set(combined)];
    } catch {
      // git error – fall through to empty list
    }
    return [];
  }

  return [];
}

module.exports = { getDiffFileList };
