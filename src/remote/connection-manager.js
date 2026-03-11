const { RemoteShell } = require('./shell');
const logger = require('../utils/logger');

const connections = new Map();

/**
 * Get or create a RemoteShell for a repository + PR combination.
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

  const existing = connections.get(key);
  if (existing) {
    await existing.ensureConnected();
    return existing;
  }

  const shell = new RemoteShell(remoteEnv, prContext);
  await shell.connect();
  connections.set(key, shell);
  return shell;
}

async function disconnectAll() {
  for (const [key, shell] of connections) {
    logger.info(`Disconnecting remote shell for ${key}`);
    await shell.disconnect();
  }
  connections.clear();
}

function getConnectionForRepo(repository) {
  return connections.get(repository) || null;
}

module.exports = { getRemoteShell, disconnectAll, getConnectionForRepo };
