// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../utils/logger');

// Default dependencies (overridable for testing)
const defaults = {
  fs,
  os,
  logger,
  process,
};

// `.keep` bodies are written by git as "<program> <pid> on <hostname>",
// e.g. "fetch-pack 20739 on Hostname.local".
const KEEP_CONTENT_RE = /^(\S+)\s+(\d+)\s+on\s+(.+?)\s*$/;

/**
 * Check whether a process id is still running on this machine.
 * Signal 0 performs the permission/existence check without delivering a signal.
 * EPERM means the process exists but belongs to another user — still alive.
 *
 * @param {number} pid
 * @param {object} [_deps] - Internal: dependency overrides for testing
 * @returns {boolean}
 */
function isPidAlive(pid, _deps) {
  const deps = { ...defaults, ..._deps };
  try {
    deps.process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Remove `pack-*.keep` markers left behind by git processes that no longer
 * exist.
 *
 * A `.keep` file tells git "a process is actively depending on this pack, do
 * not touch it". `git repack`/`git gc` silently skip kept packs and still exit
 * 0, so a marker orphaned by a killed `git fetch` permanently prevents the
 * pack's disk space from ever being reclaimed.
 *
 * Only the marker is removed, never the pack or its index: git can be killed
 * between updating refs and removing the `.keep`, so an orphan-kept pack may
 * hold objects that live refs point at. Dropping the marker makes the pack a
 * normal candidate for `git repack`/`gc`, which will keep whatever is still
 * reachable and discard the rest — deleting the pack ourselves would corrupt
 * the repository.
 *
 * A marker is removed only when its contents parse, name this host, and name a
 * pid that is no longer alive. Anything else is left alone.
 *
 * @param {string} packDir - Path to the repository's objects/pack directory
 * @param {object} [_deps] - Internal: dependency overrides for testing
 * @returns {Promise<{scanned: number, removed: number, skipped: number, errors: number}>}
 */
async function cleanupOrphanedKeepFiles(packDir, _deps) {
  const deps = { ...defaults, ..._deps };
  const summary = { scanned: 0, removed: 0, skipped: 0, errors: 0 };

  let entries;
  try {
    entries = deps.fs.readdirSync(packDir);
  } catch (err) {
    // A missing pack directory is normal (fresh/empty object store).
    if (err?.code !== 'ENOENT') {
      summary.errors++;
      deps.logger.warn(`Could not scan pack directory ${packDir}: ${err.message}`);
    }
    return summary;
  }

  const hostname = deps.os.hostname();
  const removedNames = [];

  for (const name of entries) {
    if (!name.endsWith('.keep')) continue;
    summary.scanned++;

    const keepPath = path.join(packDir, name);
    try {
      const content = deps.fs.readFileSync(keepPath, 'utf-8').trim();
      const match = KEEP_CONTENT_RE.exec(content);
      if (!match) {
        summary.skipped++;
        continue;
      }

      const pid = Number(match[2]);
      const keepHost = match[3];
      // A pid from another machine says nothing about our process table.
      if (keepHost !== hostname || isPidAlive(pid, _deps)) {
        summary.skipped++;
        continue;
      }

      deps.fs.unlinkSync(keepPath);
      summary.removed++;
      removedNames.push(name);
    } catch (err) {
      summary.errors++;
      deps.logger.warn(`Could not process keep file ${keepPath}: ${err.message}`);
    }
  }

  if (summary.removed > 0) {
    deps.logger.info(`Removed ${summary.removed} orphaned pack .keep file(s) in ${packDir}: ${removedNames.join(', ')}`);
  }

  return summary;
}

module.exports = {
  isPidAlive,
  cleanupOrphanedKeepFiles,
};
