const { exec, spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const logger = require('../utils/logger');

class RemoteShell {
  /**
   * @param {Object} remoteEnvConfig - remote_env config object
   * @param {Object} [context] - Template variable context
   * @param {string} [context.owner] - Repository owner
   * @param {string} [context.repo] - Repository name
   * @param {number|string} [context.prNumber] - PR number
   */
  constructor(remoteEnvConfig, context = {}) {
    this.config = remoteEnvConfig;
    this.context = {
      user: os.userInfo().username,
      owner: context.owner || '',
      repo: context.repo || '',
      pr_number: String(context.prNumber || ''),
    };
    this.socketPath = null;
    this._connected = false;
  }

  _generateSocketPath() {
    const id = crypto.randomBytes(4).toString('hex');
    return path.join(os.tmpdir(), `pair-review-ssh-${id}.sock`);
  }

  _substituteVars(template) {
    let result = template.replace(/\{socket_path\}/g, this.socketPath);
    result = result.replace(/\{user\}/g, this.context.user);
    result = result.replace(/\{owner\}/g, this.context.owner);
    result = result.replace(/\{repo\}/g, this.context.repo);
    result = result.replace(/\{pr_number\}/g, this.context.pr_number);
    return result;
  }

  async connect() {
    if (!this.socketPath) {
      this.socketPath = this._generateSocketPath();
    }
    const cmd = this._substituteVars(this.config.connect_command);
    logger.info(`RemoteShell: connecting via: ${cmd}`);
    await execPromise(cmd, { timeout: 120000 });
    this._connected = true;
    logger.info(`RemoteShell: connected (socket: ${this.socketPath})`);
  }

  async disconnect() {
    if (!this.config.disconnect_command || !this.socketPath) return;
    try {
      const cmd = this._substituteVars(this.config.disconnect_command);
      logger.info(`RemoteShell: disconnecting via: ${cmd}`);
      await execPromise(cmd, { timeout: 10000 });
    } catch (err) {
      logger.debug(`RemoteShell: disconnect best-effort error: ${err.message}`);
    }
    this._connected = false;
  }

  async isConnected() {
    if (!this.socketPath || !this._connected) return false;
    try {
      // -O check must come before the hostname in the SSH command.
      // exec_prefix ends with the hostname, so split and insert.
      const execPrefix = this._substituteVars(this.config.exec_prefix);
      const parts = execPrefix.split(' ');
      const host = parts.pop();
      await execPromise(`${parts.join(' ')} -O check ${host}`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async ensureConnected() {
    if (await this.isConnected()) return;
    logger.info('RemoteShell: connection lost, reconnecting...');
    await this.connect();
  }

  _buildRemoteCommand(command, { cwd, env } = {}) {
    const execPrefix = this._substituteVars(this.config.exec_prefix);
    const remoteCwd = cwd || this.config.remote_cwd;

    let envExports = '';
    if (env && Object.keys(env).length > 0) {
      envExports = Object.entries(env)
        .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
        .join('; ') + '; ';
    }

    // Build the command to run inside bash -l on the remote
    let innerCmd = '';
    if (remoteCwd) {
      // Handle tilde: use $HOME expansion (double-quoted so it expands on remote)
      if (remoteCwd.startsWith('~/')) {
        innerCmd += `cd "$HOME/${remoteCwd.slice(2)}" && `;
      } else {
        innerCmd += `cd ${shellQuote(remoteCwd)} && `;
      }
    }
    innerCmd += envExports + command;

    // Two levels of quoting needed for SSH transport:
    // 1. shellQuote(innerCmd) makes it a single argument to `bash -l -c`
    // 2. shellQuote(bashCmd) survives SSH's arg concatenation + remote shell parsing
    const bashCmd = `bash -l -c ${shellQuote(innerCmd)}`;
    return `${execPrefix} ${shellQuote(bashCmd)}`;
  }

  async exec(command, options = {}) {
    await this.ensureConnected();
    const fullCmd = this._buildRemoteCommand(command, options);
    logger.debug(`RemoteShell exec: ${fullCmd}`);
    const timeout = options.timeout || 300000;
    return execPromise(fullCmd, { timeout, maxBuffer: 50 * 1024 * 1024 });
  }

  spawn(command, options = {}) {
    const fullCmd = this._buildRemoteCommand(command, options);
    logger.debug(`RemoteShell spawn: ${fullCmd}`);
    return spawn('bash', ['-c', fullCmd], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  getConnectionInfo() {
    return {
      socketPath: this.socketPath,
      remoteCwd: this.config.remote_cwd,
      connected: this._connected
    };
  }
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

module.exports = { RemoteShell, shellQuote };
