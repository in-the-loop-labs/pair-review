// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Hook execution engine.
 *
 * Spawns user-configured commands for lifecycle events, piping a JSON
 * payload to each command's stdin.  All hooks are fire-and-forget —
 * failures are logged but never block the caller.
 */

const { spawn } = require('child_process');
const logger = require('../utils/logger');

const HOOK_TIMEOUT_MS = 5000;

const defaults = {
  spawn,
  logger,
};

/**
 * Fire all hooks registered for `eventName`.
 *
 * @param {string} eventName  - e.g. 'review.started', 'analysis.completed'
 * @param {Object} payload    - JSON-serialisable event data
 * @param {Object} config     - app config (must contain `hooks` key)
 * @param {Object} [_deps]    - dependency overrides (testing)
 */
function fireHooks(eventName, payload, config, _deps) {
  const deps = { ...defaults, ..._deps };
  const hookMap = config?.hooks?.[eventName];
  if (!hookMap || typeof hookMap !== 'object') return;

  const json = JSON.stringify(payload);

  for (const [name, hook] of Object.entries(hookMap)) {
    if (!hook?.command) continue;
    spawnHook(name, hook.command, json, deps);
  }
}

/**
 * Spawn a single hook command, pipe `json` to its stdin, and enforce a timeout.
 */
function spawnHook(name, command, json, deps) {
  const label = `${name} (${command})`;
  try {
    const child = deps.spawn(command, [], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      deps.logger.warn(`Hook timed out after ${HOOK_TIMEOUT_MS}ms, killing: ${label}`);
      child.kill('SIGTERM');
    }, HOOK_TIMEOUT_MS);

    child.on('close', () => clearTimeout(timer));

    child.on('error', (err) => {
      clearTimeout(timer);
      deps.logger.warn(`Hook error (${label}): ${err.message}`);
    });

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        deps.logger.debug(`Hook stdout [${name}]: ${data.toString().trimEnd()}`);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        deps.logger.warn(`Hook stderr [${name}]: ${data.toString().trimEnd()}`);
      });
    }

    child.stdin.on('error', (err) => {
      deps.logger.warn(`Hook stdin error (${label}): ${err.message}`);
    });

    child.stdin.write(json);
    child.stdin.end();
  } catch (err) {
    deps.logger.warn(`Hook spawn failed (${label}): ${err.message}`);
  }
}

/**
 * Check whether any hooks are registered for `eventName`.
 * Use this to skip expensive async work (e.g. getCachedUser) when no hooks exist.
 *
 * @param {string} eventName - e.g. 'chat.started'
 * @param {Object} config    - app config
 * @returns {boolean}
 */
function hasHooks(eventName, config) {
  const hookMap = config?.hooks?.[eventName];
  return hookMap && typeof hookMap === 'object' && Object.keys(hookMap).length > 0;
}

module.exports = { fireHooks, hasHooks };
