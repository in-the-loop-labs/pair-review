// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared base class for Pi-style providers.
 *
 * Pi (pi-provider.js) and its fork OMP (omp-provider.js) emit the same
 * `--mode json` JSONL event stream and are driven through an identical
 * Node.js process lifecycle: spawn with @file prompt delivery, buffered
 * JSONL line accumulation, abort/cancellation wiring, timeout handling,
 * tmp-file cleanup, and the LLM-extraction fallback. That lifecycle lives
 * here so a fix lands in both providers at once.
 *
 * What deliberately does NOT live here is the CLI surface — argv
 * construction, model resolution, and env merging differ between the two
 * CLIs (advisor overlay, task extension, --provider splitting, tool sets)
 * and stay in the subclasses.
 *
 * Subclass contract — the subclass constructor must set:
 *   this.cliCmd    - resolved CLI command (ENV > config > default precedence)
 *   this.cliName   - display name used in log/error messages ('Pi', 'OMP')
 *   this.useShell  - true when cliCmd is multi-word and needs shell mode
 *   this.baseArgs  - full analysis argv (the prompt is appended via @file)
 *   this.extraEnv  - extra env vars merged into the child environment
 * and must implement:
 *   buildArgsForModel(model)   - extraction argv for a given model
 * and may override:
 *   _resolveEnvForModel(model) - extraction env for a given model
 *                                (defaults to the analysis-model extraEnv)
 */

const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { AIProvider, quoteShellArgs } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { CancellationError, isAnalysisCancelled } = require('../routes/shared');
const { createPiLineParser } = require('./stream-parser');
const { wireAbortToChild, makeAbortError, killChildSafely } = require('./abort-signal-wiring');
const {
  MAX_PI_CAPTURED_STDERR_CHARS,
  PI_STDERR_HEAD_CHARS,
  PI_STDERR_TAIL_CHARS,
  appendHeadTailBuffer,
  formatHeadTailBuffer,
  accumulatePiResponseLine,
  appendPiChunkToLineBuffer,
  finalizePiResponseParsing,
  logPiStreamLine
} = require('./pi-format');

// Directory containing bin scripts (git-diff-lines, etc.)
const BIN_DIR = path.join(__dirname, '..', '..', 'bin');

class PiStyleProvider extends AIProvider {
  /**
   * Execute the CLI with a prompt
   * @param {string} prompt - The prompt to send to the CLI
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 900000, level = 'unknown', analysisId, registerProcess, onStreamEvent, logPrefix, abortSignal } = options;

      const levelPrefix = logPrefix || `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing ${this.cliName} CLI...`);
      logger.info(`${levelPrefix} Prompt: ${prompt.length} bytes`);

      // Write prompt to a temp file and use the CLI's @file syntax as a positional arg.
      // This bypasses devx stdin interference that breaks --mode json output.
      const tmpFile = path.join(os.tmpdir(), `pair-review-prompt-${Date.now()}-${process.pid}-${crypto.randomUUID()}.txt`);
      fs.writeFileSync(tmpFile, prompt);
      const cleanupTmpFile = () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } };

      let fullCommand;
      let fullArgs;

      if (this.useShell) {
        fullCommand = `${this.cliCmd} ${quoteShellArgs([...this.baseArgs, `@${tmpFile}`]).join(' ')}`;
        fullArgs = [];
      } else {
        fullCommand = this.cliCmd;
        fullArgs = [...this.baseArgs, `@${tmpFile}`];
      }

      const child = spawn(fullCommand, fullArgs, {
        cwd,
        env: {
          ...process.env,
          ...this.extraEnv,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: this.useShell,
        detached: this.useShell
      });

      // Close stdin immediately — prompt is delivered via @file, but some
      // wrappers (e.g., devx) keep the process alive until stdin is closed.
      child.stdin.end();

      const pid = child.pid;
      logger.debug(`${levelPrefix} ${this.cliName} CLI command: ${fullCommand} ${fullArgs.join(' ')}`);
      logger.info(`${levelPrefix} Spawned ${this.cliName} CLI process: PID ${pid}`);

      // Register process for cancellation tracking if analysisId provided
      if (analysisId && registerProcess) {
        registerProcess(analysisId, child);
        logger.info(`${levelPrefix} Registered process ${pid} for analysis ${analysisId}`);
      }

      // Wire AbortSignal -> SIGTERM for tour/summary cancellation.
      const abortWiring = wireAbortToChild(child, abortSignal, { logPrefix: levelPrefix, shell: this.useShell });

      const stderrCapture = {
        head: '',
        tail: '',
        headFull: false,
        omittedChars: 0
      };
      let stderrTruncated = false;
      let timeoutId = null;
      let settled = false;  // Guard against multiple resolve/reject calls
      let lineCount = 0;    // Count of JSONL lines received
      const lineBufferState = {
        buffer: '',
        lineTruncated: false,
        warningLogged: false
      };
      const responseState = {
        textContent: '',
        seenTexts: new Set(),
        rawOutput: '',
        rawOutputTruncated: false
      };

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        abortWiring.detach();
        fn(value);
      };

      // Use the buffered Pi line parser to accumulate text_delta fragments
      // before emitting, preventing the UI from being flooded with tiny updates.
      const streamLineParser = onStreamEvent ? createPiLineParser() : null;
      const emitStreamLine = (line) => {
        if (!streamLineParser || !line?.trim()) return;

        const event = streamLineParser(line, { cwd });
        if (!event) return;

        try {
          onStreamEvent(event);
        } catch (error) {
          logger.warn(`${levelPrefix} ${this.cliName} stream event callback error: ${error.message}`);
        }
      };

      // Set timeout
      if (timeout) {
        timeoutId = setTimeout(() => {
          logger.error(`${levelPrefix} Process ${pid} timed out after ${timeout}ms`);
          killChildSafely(child, { logPrefix: levelPrefix, shell: this.useShell });
          settle(reject, new Error(`${levelPrefix} ${this.cliName} CLI timed out after ${timeout}ms`));
        }, timeout);
      }

      // Stream and log JSONL lines as they arrive for debugging visibility
      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        const lines = appendPiChunkToLineBuffer(lineBufferState, chunk, levelPrefix, this.cliName);

        for (const line of lines) {
          if (!line.trim()) continue;
          lineCount++;
          emitStreamLine(line);
          this.logStreamLine(line, lineCount, levelPrefix);
          accumulatePiResponseLine(line, responseState, levelPrefix, this.cliName);
        }
      });

      // Collect stderr
      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        appendHeadTailBuffer(stderrCapture, chunk, PI_STDERR_HEAD_CHARS, PI_STDERR_TAIL_CHARS);
        if (stderrCapture.omittedChars > 0 && !stderrTruncated) {
          stderrTruncated = true;
          logger.warn(
            `${levelPrefix} ${this.cliName} CLI stderr exceeded ${MAX_PI_CAPTURED_STDERR_CHARS} chars; retaining a head+tail excerpt (${stderrCapture.omittedChars} chars omitted so far)`
          );
        }
      });

      // Handle completion
      child.on('close', (code) => {
        cleanupTmpFile();
        if (settled) return;  // Already settled by timeout or error

        // Detach is centralized in `settle`.

        // BackgroundQueue-driven cancellation — mirror of claude-provider.
        if (abortWiring.cancelled()) {
          logger.info(`${levelPrefix} ${this.cliName} CLI terminated by user cancel (exit code ${code})`);
          settle(reject, makeAbortError(`${levelPrefix} Cancelled by user`));
          return;
        }

        // Check for cancellation signals (SIGTERM=143, SIGKILL=137)
        const isCancellationCode = code === 143 || code === 137;
        if (isCancellationCode && analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} ${this.cliName} CLI terminated due to analysis cancellation (exit code ${code})`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

        // Also check for cancellation even with exit code 0 (the CLI may handle
        // SIGTERM gracefully and exit cleanly rather than with code 143)
        if (analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} ${this.cliName} CLI exited with code ${code} but analysis was cancelled`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

        const stderr = formatHeadTailBuffer(stderrCapture);

        // Always log stderr if present
        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} ${this.cliName} CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.warn(`${levelPrefix} ${this.cliName} CLI stderr (success): ${stderr}`);
          }
        }

        if (code !== 0) {
          logger.error(`${levelPrefix} ${this.cliName} CLI exited with code ${code}`);
          settle(reject, new Error(`${levelPrefix} ${this.cliName} CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Process any remaining buffered line
        if (lineBufferState.buffer.trim()) {
          lineCount++;
          emitStreamLine(lineBufferState.buffer);
          this.logStreamLine(lineBufferState.buffer, lineCount, levelPrefix);
          accumulatePiResponseLine(lineBufferState.buffer, responseState, levelPrefix, this.cliName);
        }

        logger.info(`${levelPrefix} ${this.cliName} CLI completed - received ${lineCount} JSONL events`);

        // Parse the JSONL response
        const parsed = finalizePiResponseParsing({
          textContent: responseState.textContent,
          rawOutput: responseState.rawOutput,
          rawOutputTruncated: responseState.rawOutputTruncated
        }, level, levelPrefix, this.cliName);
        if (parsed.success) {
          logger.success(`${levelPrefix} Successfully parsed JSON response`);

          // Log a summary of the response
          if (parsed.data?.suggestions) {
            const count = Array.isArray(parsed.data.suggestions) ? parsed.data.suggestions.length : 0;
            logger.info(`${levelPrefix} [response] ${count} suggestions extracted`);
          } else if (parsed.data) {
            const jsonStr = JSON.stringify(parsed.data);
            logger.info(`${levelPrefix} [response] ${jsonStr.length} chars of JSON data`);
          }

          settle(resolve, parsed.data);
        } else {
          // Regex extraction failed, try LLM-based extraction as fallback
          logger.warn(`${levelPrefix} Regex extraction failed: ${parsed.error}`);
          // Pass extracted text content to LLM fallback (not raw JSONL stdout).
          // The text content is the actual LLM response text extracted from JSONL
          // events and is much smaller and more relevant than the full JSONL stream.
          const llmFallbackInput = parsed.textContent || responseState.rawOutput;
          logger.info(`${levelPrefix} LLM fallback input length: ${llmFallbackInput.length} characters (${parsed.textContent ? 'text content' : 'raw fallback output'})`);
          logger.info(`${levelPrefix} Attempting LLM-based JSON extraction fallback...`);

          // The CLI child has already exited, so a cancel arriving now only makes
          // the abort wiring kill something already dead. The `settled` guard
          // below only covers a cancel that landed BEFORE the await, so without
          // the checks below one landing during extraction would settle as a
          // normal result. The signal is read alongside the wiring flag as the
          // source of truth.
          const cancelledDuringExtraction = () =>
            abortWiring.cancelled() || abortSignal?.aborted === true;

          // Use async IIFE to handle the async LLM extraction
          (async () => {
            // Guard: if already settled (by timeout, process error, or cancellation),
            // skip the LLM extraction entirely to avoid misleading log output
            if (settled) return;

            try {
              // `abortSignal` lets the extraction spawn be killed rather than
              // merely abandoned until its own 60s timeout.
              const llmExtracted = await this.extractJSONWithLLM(llmFallbackInput, { level, analysisId, registerProcess, logPrefix: levelPrefix, abortSignal });
              if (cancelledDuringExtraction()) {
                logger.info(`${levelPrefix} Cancelled by user during LLM extraction fallback`);
                settle(reject, makeAbortError(`${levelPrefix} Cancelled by user`));
                return;
              }
              if (llmExtracted.success) {
                logger.success(`${levelPrefix} LLM extraction fallback succeeded`);
                settle(resolve, llmExtracted.data);
              } else {
                logger.warn(`${levelPrefix} LLM extraction fallback also failed: ${llmExtracted.error}`);
                logger.info(`${levelPrefix} Raw response preview: ${llmFallbackInput.substring(0, 500)}...`);
                settle(resolve, { raw: llmFallbackInput, parsed: false });
              }
            } catch (llmError) {
              // An abort that kills the extraction spawn surfaces here as a
              // thrown error; it is a cancellation, not a parse failure.
              if (cancelledDuringExtraction()) {
                logger.info(`${levelPrefix} Cancelled by user during LLM extraction fallback`);
                settle(reject, makeAbortError(`${levelPrefix} Cancelled by user`));
                return;
              }
              logger.warn(`${levelPrefix} LLM extraction fallback error: ${llmError.message}`);
              settle(resolve, { raw: llmFallbackInput, parsed: false });
            }
          })();
        }
      });

      // Handle errors
      child.on('error', (error) => {
        cleanupTmpFile();
        // Detach happens inside `settle`.
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} ${this.cliName} CLI not found. Please ensure ${this.cliName} CLI is installed.`);
          // Static lookup resolves against the runtime subclass, so this
          // reports the concrete provider's install instructions.
          settle(reject, new Error(`${levelPrefix} ${this.cliName} CLI not found. ${this.constructor.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} ${this.cliName} process error: ${error}`);
          settle(reject, error);
        }
      });
    });
  }

  /**
   * Log a streaming JSONL line for debugging visibility.
   * Extracts meaningful info from each event type without being too verbose.
   *
   * Uses logger.streamDebug() which only logs when --debug-stream flag is enabled.
   *
   * @param {string} line - A single JSONL line
   * @param {number} lineNum - Line number for reference
   * @param {string} levelPrefix - Level prefix for log messages
   */
  logStreamLine(line, lineNum, levelPrefix) {
    logPiStreamLine(line, lineNum, levelPrefix);
  }

  /**
   * Parse a CLI JSONL response.
   * With --mode json the CLI outputs JSONL with structured events.
   * Text content is in message_end events with content blocks,
   * and in message_update events with text_delta.
   *
   * @param {string} stdout - Raw stdout from the CLI (JSONL format)
   * @param {string|number} level - Analysis level for logging
   * @returns {{success: boolean, data?: Object, error?: string}}
   */
  parseResponse(stdout, level, logPrefix) {
    const levelPrefix = logPrefix || `[Level ${level}]`;

    try {
      // Split by newlines and parse each JSON line
      const lines = stdout.trim().split('\n').filter(line => line.trim());
      const responseState = {
        textContent: '',
        seenTexts: new Set(),
        rawOutput: '',
        rawOutputTruncated: false
      };

      for (const line of lines) {
        accumulatePiResponseLine(line, responseState, levelPrefix, this.cliName);
      }

      return finalizePiResponseParsing({
        textContent: responseState.textContent,
        rawOutput: responseState.rawOutput,
        rawOutputTruncated: responseState.rawOutputTruncated
      }, level, levelPrefix, this.cliName);

    } catch (parseError) {
      // stdout might not be valid JSONL at all, try extracting JSON from it
      const extracted = extractJSON(stdout, level, levelPrefix);
      if (extracted.success) {
        return extracted;
      }

      return { success: false, error: `JSONL parse error: ${parseError.message}` };
    }
  }

  /**
   * Resolve the extra env vars for a given model. The default returns the
   * analysis-model env computed in the constructor; subclasses override this
   * to re-merge env for the requested model so getExtractionConfig() picks up
   * model-specific env for the extraction model.
   *
   * @param {string} model - The model identifier
   * @returns {Object} Env vars to merge into the child environment
   */
  _resolveEnvForModel(model) {
    return this.extraEnv;
  }

  /**
   * Get CLI configuration for LLM extraction
   * @param {string} model - The model to use for extraction
   * @returns {Object} Configuration for spawning extraction process
   */
  getExtractionConfig(model) {
    // Use the already-resolved command from the constructor (this.cliCmd)
    // which respects: ENV > config > default precedence
    const cliCmd = this.cliCmd;
    const useShell = this.useShell;

    // Build args consistently using the shared method, applying provider and model extra_args
    const args = this.buildArgsForModel(model);

    // Resolve env for the extraction model (not the cached analysis-model env)
    // so a distinct fast-tier extraction model carries its own env.
    const env = this._resolveEnvForModel(model);

    // Use @file syntax for prompt delivery (bypasses devx stdin interference)
    if (useShell) {
      return {
        command: `${cliCmd} ${quoteShellArgs(args).join(' ')}`,
        args: [],
        useShell: true,
        promptViaFile: true,
        env
      };
    }
    return {
      command: cliCmd,
      args,
      useShell: false,
      promptViaFile: true,
      env
    };
  }

  /**
   * Test if the CLI is available
   * Uses the command configured in the instance (respects ENV > config > default precedence)
   * @param {number} [timeoutMs=10000] - Timeout in milliseconds for the probe
   * @returns {Promise<boolean>}
   */
  async testAvailability(timeoutMs = 10000) {
    return new Promise((resolve) => {
      // For availability test, we just need to check --version
      // Use the already-resolved command from the constructor (this.cliCmd)
      // which respects: ENV > config > default precedence
      const useShell = this.useShell;
      const command = useShell ? `${this.cliCmd} --version` : this.cliCmd;
      const args = useShell ? [] : ['--version'];

      // Log the actual command for debugging config/override issues
      const fullCmd = useShell ? command : `${command} ${args.join(' ')}`;
      const name = this.constructor.getProviderName();
      logger.debug(`${name} availability check: ${fullCmd}`);

      const child = spawn(command, args, {
        env: {
          ...process.env,
          ...this.extraEnv,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: useShell
      });

      let stdout = '';
      let settled = false;

      // Timeout guard: if the CLI hangs, resolve false
      const availabilityTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn(`${name} CLI availability check timed out after ${Math.round(timeoutMs / 1000)}s`);
        // Not `shell: useShell`: the probe spawn is not `detached`, so
        // group-kill would ESRCH and leave the child running.
        killChildSafely(child, { logPrefix: '[availability]' });
        resolve(false);
      }, timeoutMs);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        if (code === 0) {
          logger.info(`${name} CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          logger.warn(`${name} CLI not available or returned unexpected output`);
          resolve(false);
        }
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        logger.warn(`${name} CLI not available: ${error.message}`);
        resolve(false);
      });
    });
  }
}

module.exports = { PiStyleProvider };
