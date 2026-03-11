const { exec, spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const logger = require('../utils/logger');

class RemoteShell {
  constructor(remoteEnvConfig) {
    this.config = remoteEnvConfig;
    this.socketPath = null;
    this._connected = false;
  }

  _generateSocketPath() {
    const id = crypto.randomBytes(4).toString('hex');
    return path.join(os.tmpdir(), `pair-review-ssh-${id}.sock`);
  }

  _substituteSocketPath(template) {
    return template.replace(/\{socket_path\}/g, this.socketPath);
  }

  async connect() {
    if (!this.socketPath) {
      this.socketPath = this._generateSocketPath();
    }
    const cmd = this._substituteSocketPath(this.config.connect_command);
    logger.info(`RemoteShell: connecting via: ${cmd}`);
    await execPromise(cmd, { timeout: 120000 });
    this._connected = true;
    logger.info(`RemoteShell: connected (socket: ${this.socketPath})`);
  }

  async disconnect() {
    if (!this.config.disconnect_command || !this.socketPath) return;
    try {
      const cmd = this._substituteSocketPath(this.config.disconnect_command);
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
      const execPrefix = this._substituteSocketPath(this.config.exec_prefix);
      await execPromise(`${execPrefix} -O check`, { timeout: 5000 });
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
    const execPrefix = this._substituteSocketPath(this.config.exec_prefix);
    const remoteCwd = cwd || this.config.remote_cwd;

    let envExports = '';
    if (env && Object.keys(env).length > 0) {
      envExports = Object.entries(env)
        .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
        .join(' && ') + ' && ';
    }

    const innerCmd = remoteCwd
      ? `cd ${shellQuote(remoteCwd)} && ${envExports}${command}`
      : `${envExports}${command}`;

    return `${execPrefix} bash -l -c ${shellQuote(innerCmd)}`;
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
