// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const { spawn } = require('child_process');
const logger = require('../utils/logger');

/**
 * Attach an `AbortSignal` to a spawned child process so that aborting the
 * signal kills the child with `SIGTERM`. Returns a cleanup function that
 * detaches the abort listener — call it from the `close` / `error` /
 * `settle` handler so the listener never outlives the process.
 *
 * Pattern: every provider that spawns an upstream CLI for tour/summary
 * generation calls this once right after `spawn(...)`. The returned
 * `cancelled` getter is included so the post-exit path can distinguish a
 * user-initiated cancel (exit due to SIGTERM we sent) from a real failure.
 *
 * If `signal` is already aborted at the time of wiring, the child is
 * killed immediately and `cancelled` is set to true. Callers should still
 * check `cancelled` before treating the eventual exit as a "real" error.
 *
 * Shell-mode caveat: when the caller spawned with `shell: true`, the
 * `child` we hold is the shell, not the underlying CLI. `child.kill()`
 * only terminates the shell; the grandchild CLI keeps burning tokens.
 * Pass `{ shell: true }` here so we signal the whole process group via
 * `process.kill(-pid, 'SIGTERM')` instead. On Windows we fall back to
 * `taskkill /T /F /PID`. Prefer `shell: false` invocation when an
 * abortSignal is in play — fewer moving parts.
 *
 * @param {import('child_process').ChildProcess} child - Spawned process.
 * @param {AbortSignal | null | undefined} signal - Signal to listen on.
 * @param {Object} [opts]
 * @param {string} [opts.logPrefix] - Log prefix for diagnostics.
 * @param {boolean} [opts.shell=false] - True when the child was spawned
 *   with `shell: true`. Causes group-kill semantics so the grandchild CLI
 *   dies along with the shell wrapper.
 * @returns {{cancelled: () => boolean, detach: () => void}}
 */
function wireAbortToChild(child, signal, opts = {}) {
  let cancelled = false;
  if (!signal) {
    return { cancelled: () => cancelled, detach: () => {} };
  }
  const prefix = opts.logPrefix || '';
  const isShell = opts.shell === true;

  const killChild = () => {
    // `kill` / process group signaling returns false (or throws ESRCH) if
    // the process is already gone, which is fine — we just need the side
    // effect when it IS still alive.
    if (isShell && child.pid && process.platform !== 'win32') {
      // Group-kill the shell AND its CLI descendant. Requires the caller
      // to have spawned with `detached: true` so the child became a
      // process-group leader (`-pid` targets the group).
      try {
        process.kill(-child.pid, 'SIGTERM');
        return;
      } catch (err) {
        if (err && err.code === 'ESRCH') {
          // Group already gone — nothing to kill.
          return;
        }
        // Fall through to single-process kill as a best effort.
        logger.warn(
          `${prefix} process.kill(-pid) failed (${err.message}); falling back to child.kill`
        );
      }
    }
    if (isShell && child.pid && process.platform === 'win32') {
      // Windows has no process groups: spawn taskkill /T /F to wipe the
      // tree rooted at our shell pid.
      try {
        spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
          .on('error', (err) => {
            logger.warn(`${prefix} taskkill failed: ${err.message}`);
          });
        return;
      } catch (err) {
        logger.warn(
          `${prefix} spawn(taskkill) failed (${err.message}); falling back to child.kill`
        );
      }
    }
    child.kill('SIGTERM');
  };

  const onAbort = () => {
    cancelled = true;
    try {
      killChild();
    } catch (err) {
      logger.warn(`${prefix} child.kill on abort failed: ${err.message}`);
    }
  };

  if (signal.aborted) {
    // Pre-aborted: trigger the kill immediately. The eventual `close`
    // handler will see `cancelled === true` and short-circuit.
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    cancelled: () => cancelled,
    detach: () => {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // Older AbortSignal polyfills may lack removeEventListener; safe to ignore.
      }
    },
  };
}

/**
 * Build a standardized cancellation error. Providers should throw this
 * (or reject with it) when they detect the abort wiring fired, so the
 * BackgroundQueue's broadcast can mark the job as `cancelled: true`.
 *
 * @param {string} [message] - Human-readable context (defaults to 'cancelled').
 * @returns {Error}
 */
function makeAbortError(message) {
  const err = new Error(message || 'cancelled');
  err.name = 'AbortError';
  err.isCancellation = true;
  return err;
}

module.exports = { wireAbortToChild, makeAbortError };
