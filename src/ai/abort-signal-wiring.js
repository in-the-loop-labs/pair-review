// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const { spawn } = require('child_process');
const logger = require('../utils/logger');

/**
 * Terminate a spawned child safely.
 *
 * Use this instead of a bare `child.kill('SIGTERM')` anywhere a child might
 * not have started. Two hazards it exists to prevent:
 *
 * 1. **Self-signalling.** A child whose spawn failed (ENOENT from a missing or
 *    misconfigured CLI command) has no pid. Node coerces the undefined pid to
 *    `0`, and `kill(0, SIGTERM)` signals the CALLER'S OWN process group — so
 *    pair-review terminates itself. Verified directly: the call returns `true`
 *    and the current process receives SIGTERM.
 * 2. **Orphaned grandchildren.** Under `shell: true` the child is the shell
 *    wrapper, not the CLI. Killing only the wrapper leaves the real CLI running
 *    and burning tokens, so shell-mode children are group-killed instead
 *    (requires the caller to have spawned with `detached: true`).
 *
 * Never throws — that is a contract callers rely on, not just a hope. Every
 * dispatch path has its own catch, and the whole body is wrapped so even a
 * malformed `child` (missing `kill`, throwing `pid` getter) or a non-object
 * `opts` returns false instead of propagating. `wireAbortToChild`'s abort
 * listener depends on this: a throw there would escape into the AbortSignal
 * dispatch with no caller frame to catch it.
 *
 * @param {import('child_process').ChildProcess} child - Spawned process.
 * @param {Object} [opts]
 * @param {boolean} [opts.shell=false] - True when spawned with `shell: true`.
 * @param {string} [opts.logPrefix] - Log prefix for diagnostics.
 * @returns {boolean} True if a signal was actually dispatched.
 */
function killChildSafely(child, opts = {}) {
  if (!child) return false;
  const options = (opts && typeof opts === 'object') ? opts : {};
  const prefix = options.logPrefix || '';
  const isShell = options.shell === true;

  try {
    if (!child.pid) {
      // Spawn failed or has not completed — nothing to signal. See hazard 1.
      return false;
    }

    if (isShell && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGTERM');
        return true;
      } catch (err) {
        if (err && err.code === 'ESRCH') {
          return false;  // Group already gone.
        }
        logger.warn(
          `${prefix} process.kill(-pid) failed (${err.message}); falling back to child.kill`
        );
      }
    }

    if (isShell && process.platform === 'win32') {
      // Windows has no process groups: wipe the tree rooted at the shell pid.
      try {
        spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
          .on('error', (err) => {
            logger.warn(`${prefix} taskkill failed: ${err.message}`);
          });
        return true;
      } catch (err) {
        logger.warn(
          `${prefix} spawn(taskkill) failed (${err.message}); falling back to child.kill`
        );
      }
    }

    try {
      child.kill('SIGTERM');
      return true;
    } catch (err) {
      logger.warn(`${prefix} child.kill failed: ${err.message}`);
      return false;
    }
  } catch (err) {
    // Reached only by a child that misbehaves outside the guarded calls above
    // (e.g. a throwing `pid` getter). Enforces the never-throws contract.
    logger.warn(`${prefix} kill dispatch failed unexpectedly: ${err && err.message}`);
    return false;
  }
}

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

  const onAbort = () => {
    // `cancelled` is set FIRST so the close/error handler short-circuits even
    // if the kill dispatch does nothing (pidless child, group already gone).
    cancelled = true;
    // killChildSafely owns the pid guard, the shell group-kill semantics and
    // the never-throws contract, so no catch is needed here.
    killChildSafely(child, { shell: isShell, logPrefix: prefix });
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

module.exports = { wireAbortToChild, makeAbortError, killChildSafely };
