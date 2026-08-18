// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * OMP (Oh My Pi) RPC Bridge
 *
 * Manages a long-lived OMP process in RPC mode for interactive chat sessions.
 * OMP is a fork of the Pi coding agent and speaks the same JSONL RPC protocol
 * (`--mode rpc`, prompt/abort/get_state commands, message_update/agent_end
 * events, and a get_state response containing `sessionFile`), so all process
 * lifecycle and event handling is inherited from PiBridge.
 *
 * This subclass covers OMP's CLI surface differences:
 * - Default command is `omp` (override via PAIR_REVIEW_OMP_CMD or config).
 * - Session resumption uses `--resume <path>` — OMP has no `--session` flag.
 * - Default tool set is read,grep,glob: OMP's file-listing tool is `glob`
 *   (no find/ls), and OMP errors on unknown tool names in --tools.
 * - No per-file `--skill` flag (OMP's `--skills` is a glob filter with
 *   different semantics), so the skills option is not supported.
 * - OMP's `autoResume` setting reopens the most recent session in the cwd
 *   when no session flag is passed, so new chats must explicitly request a
 *   fresh session via the `new_session` RPC command before session discovery.
 */

const PiBridge = require('./pi-bridge');
const logger = require('../utils/logger');

class OmpBridge extends PiBridge {
  /**
   * @param {Object} options - Same options as PiBridge, except:
   * @param {string} [options.piCommand] - Override OMP command (default: 'omp')
   * @param {string} [options.tools] - Comma-separated tool list (default: 'read,grep,glob')
   * @param {string[]} [options.skills] - Not supported by OMP; ignored with a warning
   */
  constructor(options = {}) {
    // OMP has no per-file --skill flag; drop skills so the inherited
    // _buildArgs never emits an unsupported flag.
    if (options.skills?.length) {
      logger.warn('[OmpBridge] OMP does not support per-file skill loading; ignoring skills option');
    }
    super({ ...options, skills: [] });

    // Command precedence mirrors PiBridge: explicit option > env > default.
    // The PiBridge constructor already consulted PAIR_REVIEW_PI_CMD, so an
    // absent option must be re-resolved against the OMP equivalents here.
    this.piCommand = options.piCommand || process.env.PAIR_REVIEW_OMP_CMD || 'omp';
    this.useShell = options.useShell || this.piCommand.includes(' ');
    this.tools = options.tools || 'read,grep,glob';

    this.logName = 'OmpBridge';
    this.cliName = 'OMP';
    this.sessionFlag = '--resume';
  }

  /**
   * No sessionPath means this is a new chat. Launching OMP without a session
   * flag would let its `autoResume` setting reopen the user's most recent
   * transcript in this cwd — and pair-review would then persist that file as
   * the chat's session, appending unrelated history. Request a fresh session
   * explicitly before discovering the file to persist.
   * @returns {Promise<void>}
   */
  async _querySessionFile() {
    if (!this.sessionPath) {
      await this._requestNewSession();
    }
    return super._querySessionFile();
  }

  /**
   * Send the `new_session` RPC command and wait for its response.
   * Resolves regardless of outcome — a timeout or write failure must never
   * wedge chat startup; the worst case is falling back to OMP's default
   * session behavior.
   * @returns {Promise<void>}
   */
  _requestNewSession() {
    if (!this.isReady()) return Promise.resolve();

    return new Promise((resolve) => {
      let timeout;
      this._pendingCallbacks.set('new_session', (event) => {
        clearTimeout(timeout);
        if (event.success) {
          logger.debug(`[${this.logName}] Started fresh session via new_session`);
        } else {
          logger.warn(`[${this.logName}] new_session failed: ${event.error || 'unknown error'}`);
        }
        resolve();
      });

      timeout = setTimeout(() => {
        if (this._pendingCallbacks.has('new_session')) {
          this._pendingCallbacks.delete('new_session');
          logger.debug(`[${this.logName}] new_session timed out`);
          resolve();
        }
      }, 5000);
      if (timeout.unref) timeout.unref();

      try {
        this._write(JSON.stringify({ type: 'new_session' }));
      } catch (err) {
        clearTimeout(timeout);
        this._pendingCallbacks.delete('new_session');
        logger.debug(`[${this.logName}] Failed to send new_session: ${err.message}`);
        resolve();
      }
    });
  }
}

module.exports = OmpBridge;
