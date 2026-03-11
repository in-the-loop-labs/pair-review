const { RemoteShell } = require('./shell');
const logger = require('../utils/logger');

const connections = new Map();   // key → RemoteShell (established)
const pending = new Map();       // key → Promise<RemoteShell> (in-flight)

/**
 * Get or create a RemoteShell for a repository + PR combination.
 * Deduplicates concurrent connect attempts for the same key.
 *
 * @param {string} repository - "owner/repo" format
 * @param {Object} config - Application config
 * @param {Object} [prContext] - PR context for template variables
 * @param {string} [prContext.owner] - Repository owner
 * @param {string} [prContext.repo] - Repository name
 * @param {number|string} [prContext.prNumber] - PR number
 * @returns {Promise<RemoteShell|null>}
 */
async function getRemoteShell(repository, config, prContext = {}) {
  const remoteEnv = config.monorepos?.[repository]?.remote_env;
  if (!remoteEnv) return null;

  // Key by repo + PR for per-PR session isolation
  const key = prContext.prNumber ? `${repository}#${prContext.prNumber}` : repository;

  // Return existing established connection
  const existing = connections.get(key);
  if (existing) {
    await existing.ensureConnected();
    return existing;
  }

  // Return in-flight connection promise (dedup concurrent callers)
  const inflight = pending.get(key);
  if (inflight) {
    return inflight;
  }

  // Start new connection and store the promise so concurrent callers share it
  const connectPromise = (async () => {
    const shell = new RemoteShell(remoteEnv, prContext);
    await shell.connect();
    connections.set(key, shell);
    pending.delete(key);
    return shell;
  })();

  pending.set(key, connectPromise);

  try {
    return await connectPromise;
  } catch (err) {
    pending.delete(key);
    throw err;
  }
}

async function disconnectAll() {
  for (const [key, shell] of connections) {
    logger.info(`Disconnecting remote shell for ${key}`);
    await shell.disconnect();
  }
  connections.clear();
  pending.clear();
}

function getConnectionForRepo(repository) {
  return connections.get(repository) || null;
}

module.exports = { getRemoteShell, disconnectAll, getConnectionForRepo };
