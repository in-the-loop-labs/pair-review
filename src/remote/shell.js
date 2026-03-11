const { exec, spawn: nodeSpawn, execFile } = require('child_process');
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

  /**
   * Build a shell script to run on the remote.
   * Returns plain text — no quoting for SSH transport needed
   * because we pipe it through stdin.
   */
  _buildScript(command, { cwd, env } = {}) {
    const remoteCwd = cwd || this.config.remote_cwd;
    const lines = [];

    if (remoteCwd) {
      // cd with || exit so we fail fast if the path doesn't exist
      lines.push(`cd ${shellQuote(remoteCwd)} || exit 1`);
    }

    if (env && Object.keys(env).length > 0) {
      for (const [k, v] of Object.entries(env)) {
        lines.push(`export ${k}=${shellQuote(v)}`);
      }
    }

    lines.push(command);
    return lines.join('\n') + '\n';
  }

  /**
   * Parse exec_prefix into SSH args array.
   * exec_prefix is e.g. "ssh -S /tmp/sock river@tunnel"
   */
  _sshArgs() {
    const execPrefix = this._substituteVars(this.config.exec_prefix);
    const parts = execPrefix.split(/\s+/);
    // First element is 'ssh', rest are args
    return { bin: parts[0], args: parts.slice(1) };
  }

  /**
   * Execute a command remotely, capturing stdout/stderr.
   * Pipes the script through stdin to avoid shell quoting issues.
   */
  async exec(command, options = {}) {
    await this.ensureConnected();
    const script = this._buildScript(command, options);
    const { bin, args } = this._sshArgs();
    const sshArgs = [...args, 'bash', '-l'];

    logger.debug(`RemoteShell exec: ${bin} ${sshArgs.join(' ')} <<< ${JSON.stringify(script)}`);

    const timeout = options.timeout || 300000;

    return new Promise((resolve, reject) => {
      const child = execFile(bin, sshArgs, {
        timeout,
        maxBuffer: 50 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          // Attach stderr to the error for better debugging
          error.stderr = stderr;
          logger.error(`RemoteShell exec failed: ${error.message}\nstderr: ${stderr}`);
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });

      child.stdin.write(script);
      child.stdin.end();
    });
  }

  /**
   * Spawn a command remotely with streaming stdio.
   * Used for AI providers (pi) that stream JSONL.
   */
  spawn(command, options = {}) {
    const script = this._buildScript(command, options);
    const { bin, args } = this._sshArgs();
    // Use exec in the script so the command replaces bash and stdio flows through
    const execScript = this._buildScript(`exec ${command}`, options);
    const sshArgs = [...args, 'bash', '-l'];

    logger.debug(`RemoteShell spawn: ${bin} ${sshArgs.join(' ')}`);

    const child = nodeSpawn(bin, sshArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.write(execScript);
    child.stdin.end();

    return child;
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
