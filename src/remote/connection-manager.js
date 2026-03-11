const { RemoteShell } = require('./shell');
const logger = require('../utils/logger');

const connections = new Map();

async function getRemoteShell(repository, config) {
  const remoteEnv = config.monorepos?.[repository]?.remote_env;
  if (!remoteEnv) return null;

  const existing = connections.get(repository);
  if (existing) {
    await existing.ensureConnected();
    return existing;
  }

  const shell = new RemoteShell(remoteEnv);
  await shell.connect();
  connections.set(repository, shell);
  return shell;
}

async function disconnectAll() {
  for (const [repo, shell] of connections) {
    logger.info(`Disconnecting remote shell for ${repo}`);
    await shell.disconnect();
  }
  connections.clear();
}

function getConnectionForRepo(repository) {
  return connections.get(repository) || null;
}

module.exports = { getRemoteShell, disconnectAll, getConnectionForRepo };
