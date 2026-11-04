// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
'use strict';

/**
 * Process liveness helpers.
 *
 * Used to decide whether a pair-review process recorded as the holder of a
 * shared resource (e.g. a worktree_pool row) is still running. Every
 * uncertain answer errs toward "alive": wrongly treating a live holder as
 * dead lets this process reclaim a worktree another process is using, which
 * is far worse than leaving a dead holder's worktree parked until the next
 * startup.
 */

const os = require('os');

const defaults = {
  kill: (pid, signal) => process.kill(pid, signal),
  now: () => Date.now(),
  uptime: () => os.uptime(),
};

/**
 * Return whether a process with the given PID currently exists.
 *
 * Uses signal 0, which performs the existence/permission check without
 * delivering a signal.
 *
 * @param {number} pid - Process ID to probe
 * @param {Object} [_deps] - Dependency overrides for testing ({ kill })
 * @returns {boolean} false for an invalid PID or ESRCH; true otherwise
 *   (success, EPERM — exists but owned by another user — and any other error,
 *   so an unexpected failure never causes a live holder to be treated as dead)
 */
function isProcessAlive(pid, _deps = {}) {
  const deps = { ...defaults, ..._deps };
  if (pid == null || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    deps.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    // EPERM: the process exists but we may not signal it.
    // Anything else: unknown — fail safe and treat the holder as alive.
    return true;
  }
}

/**
 * Approximate wall-clock time (ms since epoch) at which the OS booted.
 * A holder claim stamped before this moment cannot belong to a process that
 * is running now, regardless of what PID it recorded.
 *
 * @param {Object} [_deps] - Dependency overrides for testing ({ now, uptime })
 * @returns {number}
 */
function getBootTimeMs(_deps = {}) {
  const deps = { ...defaults, ..._deps };
  return deps.now() - deps.uptime() * 1000;
}

module.exports = { isProcessAlive, getBootTimeMs };
