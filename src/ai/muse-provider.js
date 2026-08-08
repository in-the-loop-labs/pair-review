// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Muse AI Provider
 *
 * Implements the AI provider interface for Meta's Muse Code CLI.
 * Uses the `muse exec` command for non-interactive (headless) execution.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { AIProvider, registerProvider, quoteShellArgs } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { CancellationError, isAnalysisCancelled } = require('../routes/shared');
const { StreamParser, parseMuseLine } = require('./stream-parser');
const { wireAbortToChild, makeAbortError, killChildSafely } = require('./abort-signal-wiring');

// Directory containing bin scripts (git-diff-lines, etc.)
const BIN_DIR = path.join(__dirname, '..', '..', 'bin');

/**
 * Split a configured command string into argv words so a multi-word command
 * (`docker exec container muse`, `devx muse --`) can be spawned WITHOUT a shell.
 *
 * Only quote grouping is honoured — enough for a path containing spaces
 * (`"/Applications/My Tools/muse"`). Shell expansions (`~`, `$VAR`, pipes,
 * `VAR=x` prefixes) are NOT interpreted; a command needing those must already be
 * a wrapper script, since single-word commands never went through a shell either.
 *
 * The configured command names the muse BINARY only — never muse's `exec`
 * subcommand, which the provider supplies itself (see stripExecSubcommand).
 *
 * Empty words are dropped rather than emitted: `foo "" bar` yields
 * `['foo', 'bar']`, because an empty argv element would reach muse as an empty
 * positional prompt (and `""` alone would become `spawn('')`). `current` cannot
 * distinguish "a quoted empty token" from "no token accumulated yet" — both are
 * the empty string — so emptiness is the only thing that decides, and the old
 * `started` flag (set by an opening quote) is gone.
 *
 * @param {string} command - Raw command string from env/config
 * @returns {string[]} argv words; never empty and never containing an empty word
 * @throws {Error} on an unterminated quote, or when nothing but quotes and
 *   whitespace was supplied. Both are unrunnable, and a named error beats
 *   spawning `''` or silently gluing `foo "bar baz` into one nonexistent
 *   command name.
 */
function splitCommandWords(command) {
  const words = [];
  let current = '';
  let quote = null;

  const flush = () => {
    if (current) words.push(current);
    current = '';
  };

  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    current += ch;
  }

  if (quote) {
    throw new Error(
      `Muse command has an unterminated ${quote === '"' ? 'double' : 'single'} quote: ${command}`
    );
  }
  flush();

  if (words.length === 0) {
    throw new Error(`Muse command is empty: ${JSON.stringify(command)}`);
  }
  return words;
}

/**
 * Drop muse's `exec` subcommand from a configured command string.
 *
 * The provider supplies `exec` itself — in `baseArgs` for the analysis path and
 * in `buildArgsForModel` for extraction — so a command configured as
 * `muse exec` would spawn `muse exec exec --json …` on BOTH paths, which muse
 * rejects. Normalizing here (rather than at each spawn site) is what keeps the
 * two paths consistent, and it runs before `useShell` is derived so a stripped
 * `muse exec` also stops needlessly going through a shell.
 *
 * DECISION — strip and warn, rather than only documenting "don't do that":
 * `<cmd> exec exec` has no valid meaning, so nothing is lost by removing it,
 * and the warning still tells the user their config is wrong. Nothing is
 * swallowed silently.
 *
 * This cannot damage a `docker exec`-style wrapper. Only a bare, unquoted,
 * TRAILING `exec` is removed, and a container-exec invocation can never end
 * with `exec` — the container and the command to run must follow it, so
 * `docker exec container muse` and `kubectl exec -it pod -- muse` both end at
 * the muse binary and are left untouched. A quoted trailing token
 * (`"/opt/my exec"`) ends with the quote character, so the pattern cannot match
 * inside quotes either.
 *
 * @param {string} command - Trimmed command string from env/config
 * @returns {string} The command without a trailing `exec` subcommand
 */
function stripExecSubcommand(command) {
  const stripped = command.replace(/\s+exec\s*$/, '');
  if (stripped !== command) {
    logger.warn(
      `Muse command "${command}" ends with the \`exec\` subcommand, which pair-review adds itself; ` +
      `using "${stripped}". Configure the muse binary only, with no subcommand.`
    );
  }
  return stripped;
}

/**
 * The attempt a Muse record belongs to — one `muse exec` run.
 *
 * Verified against real `muse exec --json` stdout (Muse Code 0.1.0): every
 * record of a run carries the same command UUID in three places — top-level
 * `causation_id`, `payload.command_id`, and `payload.run_stream.id` (whose
 * `kind` is `"run"`). A resumed or retried run is a new `turn.submit` command,
 * so it gets a new UUID and every one of those fields changes with it.
 *
 * Deliberately NOT the top-level `stream`: on stdout that is the SESSION stream
 * (`{kind: "session", id: …}`) and is identical for every attempt, so scoping by
 * it would scope to nothing. `sequence` is likewise session-scoped and
 * monotonic across attempts — it orders records but never delimits them.
 *
 * Reading all three fields is belt-and-braces against a future record that
 * carries only one of them; older fixtures carrying none yield null, which
 * callers treat as a single unnamed attempt.
 *
 * @param {Object} record - A parsed Muse JSONL record
 * @returns {string|null} Attempt identifier, or null when the record names none
 */
function attemptIdOf(record) {
  const payload = record?.payload;
  return payload?.run_stream?.id || payload?.command_id || record?.causation_id || null;
}

/**
 * The provider's default model.
 *
 * DELIBERATE: this is the NON-contributor model, even though the muse CLI's own
 * default is `muse-spark-1.2-contributor`. Pair-review sends potentially
 * proprietary source code to the model, and the contributor tier is discounted
 * precisely because Meta may use that content for product improvement. Opting
 * into data sharing must be an explicit user choice, never a silent default.
 */
const DEFAULT_MUSE_MODEL = 'muse-spark-1.2-high';

/**
 * Muse model definitions with tier mappings.
 *
 * Muse exposes exactly two real CLI model IDs; everything below is a
 * reasoning-effort variant over those two, using the same `cli_model` +
 * `extra_args` pattern as the Codex provider:
 * - muse-spark-1.2             — $1.25/$4.25 per MTok, ~1M context, 256k max output
 * - muse-spark-1.2-contributor — $0.10/$0.20 per MTok, discounted because
 *   submitted content may be used by Meta for product improvement
 *
 * `--reasoning-effort` accepts none|minimal|low|medium|high|xhigh|ultra
 * (muse's own default is `high`).
 *
 * Ordering matters: each reasoning effort is listed as a non-contributor entry
 * followed by its contributor twin, so that getFastTierModel() — which picks the
 * FIRST `fast` model — selects the non-data-sharing model for auxiliary work
 * like JSON extraction. Never put a contributor entry ahead of its twin.
 */
const MUSE_MODELS = [
  {
    id: 'muse-spark-1.2-ultra',
    cli_model: 'muse-spark-1.2',
    extra_args: ['--reasoning-effort', 'ultra'],
    name: 'Muse Spark 1.2 Ultra',
    tier: 'thorough',
    tagline: 'Maximum Depth',
    description: 'Muse Spark at the highest reasoning effort for the hardest reviews: architecture, concurrency, and security-sensitive changes.',
    badge: 'Max Reasoning',
    badgeClass: 'badge-power'
  },
  {
    id: 'muse-spark-1.2-contributor-ultra',
    cli_model: 'muse-spark-1.2-contributor',
    extra_args: ['--reasoning-effort', 'ultra'],
    name: 'Muse Spark 1.2 Contributor Ultra',
    tier: 'thorough',
    tagline: 'Discounted Depth',
    description: 'Same model and highest reasoning effort at roughly a tenth of the cost. Content you send on this tier may be used by Meta for product improvement—do not select it for proprietary code.',
    badge: 'Shares Data',
    badgeClass: 'badge-power'
  },
  {
    id: 'muse-spark-1.2-xhigh',
    cli_model: 'muse-spark-1.2',
    extra_args: ['--reasoning-effort', 'xhigh'],
    name: 'Muse Spark 1.2 XHigh',
    tier: 'thorough',
    tagline: 'Frontier Depth',
    description: 'Muse Spark with extra-high reasoning effort for difficult architectural reviews and subtle behavioral regressions.',
    badge: 'Extra High',
    badgeClass: 'badge-power'
  },
  {
    id: 'muse-spark-1.2-contributor-xhigh',
    cli_model: 'muse-spark-1.2-contributor',
    extra_args: ['--reasoning-effort', 'xhigh'],
    name: 'Muse Spark 1.2 Contributor XHigh',
    tier: 'thorough',
    tagline: 'Discounted Frontier',
    description: 'Same model and extra-high reasoning effort at roughly a tenth of the cost. Content you send on this tier may be used by Meta for product improvement—do not select it for proprietary code.',
    badge: 'Shares Data',
    badgeClass: 'badge-power'
  },
  {
    id: 'muse-spark-1.2-high',
    // Aliases keep results/councils saved under a bare model ID resolving here.
    aliases: ['muse-spark-1.2', 'muse-spark'],
    cli_model: 'muse-spark-1.2',
    extra_args: ['--reasoning-effort', 'high'],
    name: 'Muse Spark 1.2 High',
    tier: 'balanced',
    tagline: 'Best Balance',
    description: 'Meta\'s coding model with high reasoning effort and roughly 1M tokens of context—strong everyday PR review across large diffs.',
    badge: 'Recommended',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'muse-spark-1.2-contributor-high',
    aliases: ['muse-spark-1.2-contributor'],
    cli_model: 'muse-spark-1.2-contributor',
    extra_args: ['--reasoning-effort', 'high'],
    name: 'Muse Spark 1.2 Contributor High',
    tier: 'balanced',
    tagline: 'Discounted Tier',
    description: 'Same model and high reasoning effort at roughly a tenth of the cost. Content you send on this tier may be used by Meta for product improvement—do not select it for proprietary code.',
    badge: 'Shares Data',
    badgeClass: 'badge-balanced'
  },
  {
    id: 'muse-spark-1.2-low',
    cli_model: 'muse-spark-1.2',
    extra_args: ['--reasoning-effort', 'low'],
    name: 'Muse Spark 1.2 Low',
    tier: 'fast',
    tagline: 'Quick Pass',
    description: 'Muse Spark with low reasoning effort for fast surface scans of small, straightforward changes.',
    badge: 'Fastest',
    badgeClass: 'badge-speed'
  },
  {
    id: 'muse-spark-1.2-contributor-low',
    cli_model: 'muse-spark-1.2-contributor',
    extra_args: ['--reasoning-effort', 'low'],
    name: 'Muse Spark 1.2 Contributor Low',
    tier: 'fast',
    tagline: 'Lowest Cost',
    description: 'The cheapest option: low reasoning effort on the discounted tier. Content you send on this tier may be used by Meta for product improvement—do not select it for proprietary code.',
    badge: 'Shares Data',
    badgeClass: 'badge-speed'
  }
];

class MuseProvider extends AIProvider {
  /**
   * @param {string} model - Model identifier
   * @param {Object} configOverrides - Config overrides from providers config
   * @param {string} configOverrides.command - Custom CLI command
   * @param {string[]} configOverrides.extra_args - Additional CLI arguments (appended)
   * @param {Object} configOverrides.env - Additional environment variables
   * @param {Object[]} configOverrides.models - Custom model definitions
   * @param {boolean} configOverrides.yolo - Bypass approval and sandbox
   */
  constructor(model = DEFAULT_MUSE_MODEL, configOverrides = {}) {
    super(model);

    // Command precedence: ENV > config > default. A blank or whitespace-only
    // override is treated as absent rather than passed on as an unspawnable
    // command name.
    const envCmd = process.env.PAIR_REVIEW_MUSE_CMD;
    const configCmd = configOverrides.command;
    const rawCmd = [envCmd, configCmd]
      .map(c => (typeof c === 'string' ? c.trim() : ''))
      .find(c => c) || 'muse';

    // Normalize once, here, so the analysis path (baseArgs) and the extraction
    // path (buildArgsForModel) can never disagree about whether `exec` is
    // already present, and so `useShell` below is derived from the real command.
    const museCmd = stripExecSubcommand(rawCmd);

    // Store for use in execute, getExtractionConfig and testAvailability
    this.museCmd = museCmd;
    this.configOverrides = configOverrides;

    // For multi-word commands, use shell mode (same pattern as Claude/Codex)
    this.useShell = museCmd.includes(' ');

    // SECURITY: Muse approval and sandbox flags
    //
    // `muse exec` is already headless, and with DEFAULT flags its tools are
    // auto-approved by policy (side_effect_intent records report
    // policy_decision: "allow:policy") — nothing blocks waiting for input.
    // So the non-yolo path passes NO approval or sandbox flags at all.
    //
    // Do NOT add `--approval-mode never`: it DENIES every tool rather than
    // auto-approving, so no tool runs and the process never emits a terminal
    // record. `--yolo` is muse's documented "disable approval and sandbox and
    // trust this workspace" switch and is the equivalent of Claude's
    // --dangerously-skip-permissions.
    //
    // `--disable-write` blocks the write_file tool. It is defense in depth, not
    // a guarantee: it only covers NON-shell writes, and review analysis needs
    // shell so the model can run grep/find and the bundled git-diff-lines
    // helper. A determined model can still write via bash. Blocking that would
    // require `--disable-shell`, which also disables git-diff-lines and Level 3
    // codebase exploration — the same tradeoff Codex documents for its
    // workspace-write sandbox. Verified empirically: with `--disable-write`
    // alone the model falls back to bash and the write succeeds; adding
    // `--disable-shell` blocks it. See the writeBlockKnownLimitation note in
    // scripts/verify-ai-permissions.js.
    const safetyArgs = configOverrides.yolo ? ['--yolo'] : ['--disable-write'];

    // Resolve cli_model + extra_args + env from built-in model, provider config,
    // and per-model config. This is what lets reasoning variants like
    // muse-spark-1.2-ultra pass `--model muse-spark-1.2` plus
    // `--reasoning-effort ultra`.
    const { cliModel, extraArgs, env } = this._resolveModelConfig(model);

    // A cli_model of explicitly `null` omits --model entirely, letting muse pick
    // its own default (Codex convention).
    const modelArgs = cliModel === null ? [] : ['--model', cliModel];

    this.extraEnv = env;

    // Everything up to (but excluding) the `--prompt-file <path>` pair, which is
    // appended in execute() once the temp file exists. Keeping the pair strictly
    // last means no extra_args can displace the prompt.
    //
    // `extraArgs` is already the three-way merge (built-in model → provider
    // config → per-model config) performed by _resolveModelConfig, so provider
    // extra_args must NOT be spliced in again here.
    this.baseArgs = ['exec', '--json', ...modelArgs, ...safetyArgs, ...extraArgs];
  }

  /**
   * Resolve model configuration by looking up built-in and config override definitions.
   * Produces the CLI model ID (for `--model`), merged extra_args, and merged env.
   *
   * Precedence for cli_model: config model > built-in model > modelId.
   *
   * @param {string} modelId
   * @returns {{ builtIn: Object|undefined, configModel: Object|undefined, cliModel: string|null, extraArgs: string[], env: Object }}
   * @private
   */
  _resolveModelConfig(modelId) {
    const configOverrides = this.configOverrides || {};

    const builtIn = MUSE_MODELS.find(m => m.id === modelId || (m.aliases && m.aliases.includes(modelId)));
    const configModel = configOverrides.models?.find(m => m.id === modelId);

    const cliModel = configModel?.cli_model !== undefined
      ? configModel.cli_model
      : (builtIn?.cli_model !== undefined ? builtIn.cli_model : modelId);

    // Three-way merge for extra_args: built-in model → provider config → per-model config
    const builtInArgs = builtIn?.extra_args || [];
    const providerArgs = configOverrides.extra_args || [];
    const configModelArgs = configModel?.extra_args || [];
    const extraArgs = [...builtInArgs, ...providerArgs, ...configModelArgs];

    // Three-way merge for env: built-in model → provider config → per-model config
    const env = {
      ...(builtIn?.env || {}),
      ...(configOverrides.env || {}),
      ...(configModel?.env || {})
    };

    return { builtIn, configModel, cliModel, extraArgs, env };
  }

  /**
   * Build the command/args the ANALYSIS path spawns, wrapping for shell mode.
   *
   * `execute()` is the only other caller and routes through here, so an external
   * inspector — notably scripts/verify-ai-permissions.js, which must exercise the
   * real analysis invocation to make its findings meaningful — cannot drift from
   * what actually runs. Do NOT reconstruct the invocation from
   * getExtractionConfig(): that describes the JSON-extraction fallback, which is
   * free to adopt a different tool/safety posture.
   *
   * @param {string[]} [trailingArgs=[]] - Args appended after baseArgs. execute()
   *   passes `['--prompt-file', <tmp path>]`; callers without a per-run temp file
   *   can pass the prompt as a single positional instead, since
   *   `muse exec [OPTIONS] [PROMPT]` accepts one and never reads stdin.
   * @returns {{command: string, args: string[], useShell: boolean}}
   */
  getAnalysisSpawnConfig(trailingArgs = []) {
    const args = [...this.baseArgs, ...trailingArgs];

    if (this.useShell) {
      return {
        command: `${this.museCmd} ${quoteShellArgs(args).join(' ')}`,
        args: [],
        useShell: true
      };
    }
    return { command: this.museCmd, args, useShell: false };
  }

  /**
   * Execute Muse CLI with a prompt
   * @param {string} prompt - The prompt to send to Muse
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', analysisId, registerProcess, onStreamEvent, logPrefix, abortSignal } = options;

      const levelPrefix = logPrefix || `[Level ${level}]`;

      // Already cancelled before we started: reject before creating a temp dir,
      // writing a prompt that can run to megabytes, and spawning a process only
      // to SIGTERM it. This runs ahead of the mkdtempSync below, so the early
      // return cannot leak a temp dir — there is nothing yet to clean up.
      // Semantics are unchanged; wireAbortToChild already handled a pre-aborted
      // signal correctly, just after doing all that work.
      if (abortSignal?.aborted) {
        logger.info(`${levelPrefix} Skipping Muse CLI run: already cancelled`);
        reject(makeAbortError(`${levelPrefix} Cancelled by user`));
        return;
      }

      logger.info(`${levelPrefix} Executing Muse CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} bytes`);

      // `muse exec` takes the prompt either as a positional argument or via
      // --prompt-file; it does NOT read stdin (it exits 2 with "missing prompt").
      // Review prompts embed whole diffs, so a file is the only safe delivery —
      // a positional arg would risk E2BIG. mkdtempSync (never a fixed /tmp path)
      // keeps concurrent analyses from colliding.
      let tmpDir;
      let tmpFile;

      // Idempotent: called from settle() (covers close/timeout/error/abort), and
      // eagerly on close so the file is gone as soon as muse exits, even when the
      // async LLM-extraction fallback delays settling. Declared BEFORE the write
      // so the failure path below can use it: mkdtempSync creates the directory
      // first, so a failing writeFileSync (ENOSPC/EACCES/EIO/EROFS/quota) would
      // otherwise leak an empty directory with no child process to clean it up.
      let tmpCleaned = false;
      const cleanupTmpFile = () => {
        if (tmpCleaned || !tmpDir) return;
        tmpCleaned = true;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      };

      try {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-muse-'));
        tmpFile = path.join(tmpDir, 'prompt.txt');
        fs.writeFileSync(tmpFile, prompt);
      } catch (err) {
        cleanupTmpFile();
        reject(new Error(`${levelPrefix} Failed to write Muse prompt file: ${err.message}`));
        return;
      }

      const { command: fullCommand, args: fullArgs } = this.getAnalysisSpawnConfig(['--prompt-file', tmpFile]);

      const muse = spawn(fullCommand, fullArgs, {
        cwd,
        env: {
          ...process.env,
          ...this.extraEnv,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: this.useShell,
        // Detach in shell mode so wireAbortToChild can group-kill via
        // process.kill(-pid). See claude-provider for the rationale.
        detached: this.useShell
      });

      // Prompt is delivered via --prompt-file; close stdin so any wrapper script
      // waiting on it doesn't keep the process alive.
      muse.stdin.on('error', (err) => {
        logger.debug(`${levelPrefix} stdin error (ignorable, prompt goes via file): ${err.message}`);
      });
      muse.stdin.end();

      const pid = muse.pid;
      logger.debug(`${levelPrefix} Muse CLI command: ${fullCommand} ${fullArgs.join(' ')}`);
      logger.info(`${levelPrefix} Spawned Muse CLI process: PID ${pid}`);

      // Register process for cancellation tracking if analysisId provided
      if (analysisId && registerProcess) {
        registerProcess(analysisId, muse);
        logger.info(`${levelPrefix} Registered process ${pid} for analysis ${analysisId}`);
      }

      // Wire AbortSignal -> SIGTERM for tour/summary cancellation.
      // shell flag triggers group-kill so the CLI grandchild dies with the shell.
      const abortWiring = wireAbortToChild(muse, abortSignal, { logPrefix: levelPrefix, shell: this.useShell });

      let stdout = '';
      let stderr = '';
      let timeoutId = null;
      let settled = false;  // Guard against multiple resolve/reject calls
      let lineBuffer = '';  // Buffer for incomplete JSONL lines
      let lineCount = 0;    // Count of JSONL events for progress tracking

      // Centralize detach and temp-file cleanup in `settle` so they happen
      // regardless of which exit path (close/timeout/error/abort) wins. Avoids
      // leaking a listener on the per-job AbortSignal that tour/summary
      // generators reuse across many provider.execute() calls.
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        abortWiring.detach();
        cleanupTmpFile();
        fn(value);
      };

      // Set up side-channel stream parser for live progress events
      const streamParser = onStreamEvent
        ? new StreamParser(parseMuseLine, onStreamEvent, { cwd })
        : null;

      // Set timeout
      if (timeout) {
        timeoutId = setTimeout(() => {
          logger.error(`${levelPrefix} Process ${pid} timed out after ${timeout}ms`);
          // Shell-aware: in shell mode `muse` is the shell wrapper (spawned
          // detached above), so a bare kill would leave the real CLI running
          // after this promise has already rejected.
          killChildSafely(muse, { shell: this.useShell, logPrefix: levelPrefix });
          settle(reject, new Error(`${levelPrefix} Muse CLI timed out after ${timeout}ms`));
        }, timeout);
      }

      // Collect stdout with streaming JSONL parsing for debug visibility
      muse.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;

        // Feed side-channel stream parser for live progress events
        if (streamParser) {
          streamParser.feed(chunk);
        }

        // Parse JSONL lines as they arrive for streaming debug output
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        // Keep the last incomplete line in buffer
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            lineCount++;
            this.logStreamLine(line, lineCount, levelPrefix);
          }
        }
      });

      // Collect stderr
      muse.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      muse.on('close', (code) => {
        cleanupTmpFile();
        if (settled) return;  // Already settled by timeout or error

        // Flush any remaining stream parser buffer
        if (streamParser) {
          streamParser.flush();
        }

        // BackgroundQueue-driven cancellation — mirror of claude-provider.
        if (abortWiring.cancelled()) {
          logger.info(`${levelPrefix} Muse CLI terminated by user cancel (exit code ${code})`);
          settle(reject, makeAbortError(`${levelPrefix} Cancelled by user`));
          return;
        }

        // Check for cancellation signals (SIGTERM=143, SIGKILL=137)
        const isCancellationCode = code === 143 || code === 137;
        if (isCancellationCode && analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} Muse CLI terminated due to analysis cancellation (exit code ${code})`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

        // Muse writes all human-facing noise (workspace root notice, skills
        // warnings, untrusted-workspace notices) to stderr even on success, so
        // stderr content alone is NOT an error signal — only the exit code is.
        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} Muse CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.debug(`${levelPrefix} Muse CLI stderr (success): ${stderr}`);
          }
        }

        // The terminal record carries the authoritative outcome. On failure its
        // `reason` is far more useful than stderr, which only says
        // "run ended with Failed".
        const terminal = this.extractTerminalRecord(stdout);

        if (code !== 0) {
          logger.error(`${levelPrefix} Muse CLI exited with code ${code}`);
          settle(reject, this.createExitError(code, stderr, levelPrefix, terminal?.reason));
          return;
        }

        // Log completion with event count (only for successful completion)
        logger.info(`${levelPrefix} Muse CLI completed: ${lineCount} JSONL events received`);

        // Process any remaining buffered line
        if (lineBuffer.trim()) {
          lineCount++;
          this.logStreamLine(lineBuffer, lineCount, levelPrefix);
        }

        // Parse the Muse JSONL response
        const parsed = this.parseMuseResponse(stdout, level, levelPrefix);
        if (parsed.success) {
          logger.success(`${levelPrefix} Successfully parsed JSON response`);
          // Dump the parsed data for debugging
          const dataPreview = JSON.stringify(parsed.data, null, 2);
          logger.debug(`${levelPrefix} [parsed_data] ${dataPreview.substring(0, 3000)}${dataPreview.length > 3000 ? '...' : ''}`);
          // Log suggestion count if present
          if (parsed.data?.suggestions) {
            const count = Array.isArray(parsed.data.suggestions) ? parsed.data.suggestions.length : 0;
            logger.info(`${levelPrefix} [response] ${count} suggestions in parsed response`);
          }
          settle(resolve, parsed.data);
        } else if (!parsed.textContent) {
          // No model-authored text to extract from — only muse's own transport
          // envelopes. Feeding those to any extractor risks returning a
          // lifecycle/terminal frame as though it were the review payload, so
          // an empty run is reported as the failure it is.
          logger.warn(`${levelPrefix} Regex extraction failed: ${parsed.error}`);
          logger.warn(`${levelPrefix} No assistant text in Muse output; skipping LLM extraction fallback`);
          settle(resolve, { raw: stdout, parsed: false });
        } else {
          // Regex extraction failed, try LLM-based extraction as fallback
          logger.warn(`${levelPrefix} Regex extraction failed: ${parsed.error}`);
          const llmFallbackInput = parsed.textContent;
          logger.info(`${levelPrefix} LLM fallback input length: ${llmFallbackInput.length} characters`);
          logger.info(`${levelPrefix} Attempting LLM-based JSON extraction fallback...`);

          // A cancel that arrives while the extraction child is running reaches
          // the abort wiring, but by then the muse child has already exited, so
          // the wiring only kills something already dead. Nothing else here
          // consults it — so without this check a cancelled analysis still
          // settles with a normal result.
          //
          // Reads BOTH the wiring flag and the signal itself: `settle()` (which
          // detaches the listener) has not run on any path that reaches here, so
          // the flag is live — but the signal is the source of truth and stays
          // correct no matter how the wiring evolves.
          const cancelledDuringExtraction = () =>
            abortWiring.cancelled() || abortSignal?.aborted === true;

          // Use async IIFE to handle the async LLM extraction
          (async () => {
            try {
              // `abortSignal` also lets the extraction spawn itself be killed
              // rather than merely abandoned; providers that ignore the option
              // simply run to completion and are caught by the check below.
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
      muse.on('error', (error) => {
        cleanupTmpFile();
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Muse CLI not found. Please ensure Muse Code is installed.`);
          settle(reject, new Error(`${levelPrefix} Muse CLI not found. ${MuseProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Muse process error: ${error}`);
          settle(reject, error);
        }
      });
    });
  }

  /**
   * Find the run's terminal record in Muse JSONL output.
   *
   * Muse names the terminal record after its outcome — `run.terminal.completed`,
   * `run.terminal.failed`, `run.terminal.cancelled` — but all of them share
   * `payload.kind === 'run_terminal'` and carry `terminal`, `text` and `reason`.
   * Matching on the `kind` discriminator therefore catches failures too, which
   * matching only `run.terminal.completed` would miss.
   *
   * `attemptId` identifies which attempt this outcome belongs to, so the delta
   * fallback in parseMuseResponse can be scoped to the SAME attempt instead of
   * ranging over the whole transcript. See attemptIdOf.
   *
   * @param {string} stdout - Raw stdout from Muse CLI (JSONL format)
   * @returns {{terminal: string, text: string, reason: string|null, attemptId: string|null}|null}
   */
  extractTerminalRecord(stdout) {
    if (!stdout || !stdout.trim()) return null;

    let found = null;
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const payload = record.payload;
        if (payload?.kind === 'run_terminal') {
          // Keep the last one: a resumed/retried run can emit more than one.
          found = {
            terminal: payload.terminal || 'unknown',
            text: payload.text || '',
            reason: payload.reason || null,
            attemptId: attemptIdOf(record)
          };
        }
      } catch {
        // Skip malformed lines — the caller degrades to delta accumulation.
      }
    }
    return found;
  }

  /**
   * Parse Muse CLI JSONL response.
   *
   * Every record is an envelope keyed by `payload_type`. The authoritative
   * answer is the terminal record's `payload.text`; if that is missing we fall
   * back to concatenating `run.output.delta` chunks in `sequence` order — but
   * only those belonging to the SAME attempt the terminal record reports, so a
   * multi-attempt transcript can never answer with a superseded attempt's text.
   *
   * Only model-authored text is ever handed to an extractor. Muse's envelopes
   * are themselves valid JSON objects, so running the generic extractor over the
   * raw JSONL could return a lifecycle/terminal frame as though it were the
   * review payload — turning an empty or failed run into a false success. Raw
   * stdout is therefore only parsed when it contains no envelopes at all (a
   * wrapper that printed bare JSON, or output produced without `--json`).
   *
   * No outer try/catch: every JSON.parse below has its own, extractJSON returns
   * a result object rather than throwing, and the remaining string operations
   * are guarded by the type check at the top.
   *
   * @param {string} stdout - Raw stdout from Muse CLI (JSONL format)
   * @param {string|number} level - Analysis level for logging
   * @param {string} logPrefix - Logging prefix
   * @returns {{success: boolean, data?: Object, error?: string, textContent?: string}}
   *   `textContent` is set only when there is material safe to forward to the
   *   LLM extraction fallback; its absence means "nothing but transport frames".
   */
  parseMuseResponse(stdout, level, logPrefix) {
    const levelPrefix = logPrefix || `[Level ${level}]`;

    if (typeof stdout !== 'string' || !stdout.trim()) {
      return { success: false, error: 'Muse produced no output' };
    }

    const terminal = this.extractTerminalRecord(stdout);
    let responseText = terminal?.text || '';
    let source = 'terminal record';
    // Whether stdout looks like muse's JSONL transport at all.
    let sawEnvelope = terminal !== null;

    if (!responseText) {
      // Fall back to streamed deltas, ordered by the envelope's `sequence`
      // so out-of-order chunks can't scramble the text.
      const deltas = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record && (typeof record.payload_type === 'string' || typeof record.payload === 'object')) {
            sawEnvelope = true;
          }
          if (record.payload_type === 'run.output.delta' && record.payload?.text) {
            deltas.push({
              sequence: record.sequence ?? 0,
              attemptId: attemptIdOf(record),
              text: record.payload.text
            });
          }
        } catch {
          logger.debug(`${levelPrefix} Skipping malformed JSONL line: ${line.substring(0, 100)}`);
        }
      }
      deltas.sort((a, b) => a.sequence - b.sequence);

      // Scope the deltas to ONE attempt, the same way extractTerminalRecord
      // scopes the outcome to the last terminal record. Reading the two sources
      // with different scoping rules is what let a multi-attempt transcript
      // report a review the finishing attempt never produced: when the final
      // attempt ended with no text, an unscoped concatenation resurrected an
      // EARLIER attempt's deltas and presented them as that run's answer.
      //
      // The scope is the terminal record's attempt when there is one, otherwise
      // the attempt of the last delta — which mirrors "keep the last" for a
      // transcript that was cut off before any terminal record arrived.
      // Transcripts naming no attempt at all (older shapes, hand-written
      // fixtures) collapse to a single null scope, i.e. the previous behaviour.
      const scopeId = terminal?.attemptId ?? (deltas.length ? deltas[deltas.length - 1].attemptId : null);
      const scoped = deltas.filter(d => d.attemptId === scopeId);

      if (scoped.length !== deltas.length) {
        logger.info(
          `${levelPrefix} Ignoring ${deltas.length - scoped.length} output delta(s) from earlier Muse attempts ` +
          `(keeping attempt ${scopeId})`
        );
      }

      // A terminal record whose attempt contributed no deltas leaves this
      // empty on purpose: the run really did produce no answer, and the caller
      // reports that instead of mining another attempt's text.
      responseText = scoped.map(d => d.text).join('');
      source = `${scoped.length} output deltas`;
    }

    if (responseText) {
      logger.debug(`${levelPrefix} Extracted ${responseText.length} chars of assistant text from JSONL (${source})`);
      const extracted = extractJSON(responseText, level, levelPrefix);
      if (extracted.success) {
        return extracted;
      }

      // Return textContent so the caller feeds the assistant text — never the
      // raw JSONL — to the LLM extraction fallback.
      logger.warn(`${levelPrefix} Assistant text is not JSON, treating as raw text`);
      return { success: false, error: 'Assistant text is not valid JSON', textContent: responseText };
    }

    if (sawEnvelope) {
      // Envelopes but no assistant text: the run produced no answer. Report that
      // honestly rather than letting an extractor mine the transport frames.
      logger.warn(`${levelPrefix} Muse emitted no assistant text (terminal: ${terminal?.terminal || 'none'})`);
      return {
        success: false,
        error: `Muse produced no assistant text (terminal record: ${terminal?.terminal || 'none'}${terminal?.reason ? `, reason: ${terminal.reason}` : ''})`
      };
    }

    // Not muse JSONL at all — safe to treat the whole output as model text.
    const extracted = extractJSON(stdout, level, levelPrefix);
    if (extracted.success) {
      return extracted;
    }
    return { success: false, error: extracted.error || 'Output is not valid JSON', textContent: stdout };
  }

  /**
   * Log a streaming JSONL line for debugging visibility.
   *
   * Muse records are envelopes discriminated by `payload_type`. Uses
   * logger.streamDebug() which only logs when --debug-stream is enabled, except
   * for the terminal record which is summarized at info level.
   *
   * Muse emits NO token usage in any record, so there is no token line to log.
   *
   * @param {string} line - A single JSONL line
   * @param {number} lineNum - Line number for reference
   * @param {string} levelPrefix - Logging prefix
   */
  logStreamLine(line, lineNum, levelPrefix) {
    const streamEnabled = logger.isStreamDebugEnabled();

    try {
      const record = JSON.parse(line);
      const payloadType = record.payload_type;
      const payload = record.payload || {};

      if (payload.kind === 'run_terminal') {
        // Always summarize the terminal record at info level. Muse reports no
        // token usage anywhere, so there are no counts to include.
        const reasonPart = payload.reason ? ` reason=${payload.reason}` : '';
        logger.info(`${levelPrefix} [run.terminal] ${payload.terminal || 'unknown'} (tokens not reported by Muse)${reasonPart}`);
        return;
      }

      if (!streamEnabled) return;

      if (payloadType === 'run.model.configured') {
        const label = payload.display_label || payload.model_id || 'unknown';
        logger.streamDebug(`${levelPrefix} [#${lineNum}] model: ${label}`);

      } else if (payloadType === 'run.output.delta') {
        const text = payload.text || '';
        const preview = text.replace(/\n/g, '\\n').substring(0, 60);
        logger.streamDebug(`${levelPrefix} [#${lineNum}] output.delta: ${preview}${text.length > 60 ? '...' : ''}`);

      } else if (payloadType === 'task.lifecycle.side_effect_intent') {
        const operation = payload.event?.operation || 'unknown';
        const decision = payload.event?.policy_decision;
        const decisionPart = decision ? ` [${decision}]` : '';
        logger.streamDebug(`${levelPrefix} [#${lineNum}] side_effect_intent: ${operation}${decisionPart}`);

      } else if (payloadType === 'tool.result') {
        const callId = payload.call_id || '';
        const toolName = payload.correlation_facts?.tool_name || '';
        const outcome = payload.correlation_facts?.outcome || '';
        const text = payload.text || '';
        const preview = text.replace(/\n/g, '\\n').substring(0, 60);
        const idPart = callId ? ` [${callId.substring(0, 12)}]` : '';
        const namePart = toolName ? ` ${toolName}` : '';
        const outcomePart = outcome ? ` ${outcome}` : '';
        logger.streamDebug(`${levelPrefix} [#${lineNum}] tool.result${namePart}${idPart}${outcomePart} ${preview}${text.length > 60 ? '...' : ''}`);

      } else if (payloadType === 'task.lifecycle.output') {
        const chunk = payload.event?.chunk || '';
        const preview = chunk.replace(/\n/g, '\\n').substring(0, 60);
        logger.streamDebug(`${levelPrefix} [#${lineNum}] task.output: ${preview}${chunk.length > 60 ? '...' : ''}`);

      } else if (payloadType === 'task.lifecycle.rejected') {
        // `skip_if_running` is a benign internal reminder-task event — it is NOT
        // an error and must never be surfaced as one. Every OTHER reason is a
        // real tool/policy rejection, so it is logged visibly instead of being
        // buried at stream-debug level under a "benign" label.
        const reason = payload.event?.reason || 'unknown';
        if (reason === 'skip_if_running') {
          logger.streamDebug(`${levelPrefix} [#${lineNum}] task.rejected (benign): ${reason}`);
        } else {
          logger.warn(`${levelPrefix} [#${lineNum}] task.rejected: ${reason}`);
        }

      } else if (payloadType === 'task.lifecycle.failed') {
        // A single background task (e.g. a reminder plugin) can fail while the
        // run as a whole succeeds; the exit code and terminal record decide.
        const reason = payload.event?.reason || 'unknown';
        logger.streamDebug(`${levelPrefix} [#${lineNum}] task.failed: ${reason}`);

      } else if (payloadType) {
        logger.streamDebug(`${levelPrefix} [#${lineNum}] ${payloadType}`);
      }
      // Silently ignore records with no payload_type

    } catch (parseError) {
      if (streamEnabled) {
        logger.streamDebug(`${levelPrefix} [#${lineNum}] (malformed: ${line.substring(0, 50)}${line.length > 50 ? '...' : ''})`);
      }
    }
  }

  /**
   * Build args for Muse CLI extraction, applying provider and model extra_args.
   *
   * Note the deliberate absence of a trailing prompt marker: the shared
   * extraction helper appends `--prompt-file <path>` itself, from the
   * `promptFileArg` field getExtractionConfig sets.
   *
   * @param {string} model - The model identifier to use
   * @param {Object} [resolved] - Pre-resolved output of `_resolveModelConfig(model)`.
   *   Lets getExtractionConfig resolve once and reuse it for both args and env.
   * @returns {string[]} Complete args array for the CLI
   */
  buildArgsForModel(model, resolved = null) {
    const { cliModel, extraArgs } = resolved || this._resolveModelConfig(model);
    const modelArgs = cliModel === null ? [] : ['--model', cliModel];

    // Extraction only reformats already-captured text into JSON — it needs no
    // filesystem or shell access at all. So unlike the analysis path (which
    // keeps shell for grep/find and git-diff-lines), extraction is fully locked
    // down. This mirrors Codex's `--sandbox read-only` extraction posture.
    // Verified empirically: muse still returns bare JSON with both flags set.
    const safetyArgs = this.configOverrides?.yolo
      ? ['--yolo']
      : ['--disable-write', '--disable-shell'];

    return ['exec', '--json', ...modelArgs, ...safetyArgs, ...extraArgs];
  }

  /**
   * Get CLI configuration for LLM extraction.
   *
   * Prompt delivery: `--prompt-file <path>`, the same mechanism the analysis
   * path uses, and NEVER through a shell. Extraction input is an entire
   * malformed model response, so keeping it off argv is what stops a large one
   * from failing with E2BIG at the OS single-argument limit.
   *
   * The other two delivery modes the shared helper offers do not fit muse:
   * - promptViaStdin fails outright: `muse exec` with no prompt argument exits 2
   *   with "missing prompt"; it never reads stdin.
   * - promptViaFile appends `@<path>` as a positional arg — Pi's @file syntax.
   *   Muse would read the literal string "@/tmp/..." as the prompt.
   *
   * SECURITY — why `useShell` stays false here even now that the prompt is off
   * argv: this spawn is not `detached`, so under `shell: true` a cancel or
   * timeout would kill only the `/bin/sh` wrapper and orphan the real CLI (see
   * the kill comment in extractJSONWithLLM). A multi-word command needs no
   * shell anyway: `docker exec c muse` spawns `docker` with the rest as leading
   * args. Anything needing genuine shell expansion must be a wrapper script —
   * see splitCommandWords.
   *
   * @param {string} model - The model to use for extraction
   * @returns {Object} Configuration for spawning extraction process
   */
  getExtractionConfig(model) {
    // One resolve, reused for both the args and the merged env.
    const resolved = this._resolveModelConfig(model);
    const args = this.buildArgsForModel(model, resolved);

    const [command, ...commandArgs] = splitCommandWords(this.museCmd);

    return {
      command,
      args: [...commandArgs, ...args],
      useShell: false,
      promptViaStdin: false,
      promptFileArg: '--prompt-file',
      env: resolved.env
    };
  }

  /**
   * Build an actionable error for Muse CLI process failures.
   *
   * @param {number} code - Process exit code
   * @param {string} stderr - Captured stderr
   * @param {string} levelPrefix - Logging prefix
   * @param {string} [terminalReason] - `reason` from the run's terminal record,
   *   which carries the real failure detail when stderr only says
   *   "run ended with Failed".
   * @returns {Error}
   */
  createExitError(code, stderr, levelPrefix, terminalReason) {
    const stderrText = stderr.trim();
    // The terminal record's reason is the more specific diagnostic; check both
    // it and stderr when classifying.
    const diagnostic = [stderrText, terminalReason].filter(Boolean).join(' | ');

    if (this.isAuthError(diagnostic)) {
      return new Error(
        `${levelPrefix} Muse CLI authentication failed. Run \`muse login\` (or set META_API_KEY) and try again. ` +
        `Original error: ${diagnostic}`
      );
    }

    if (this.isUnknownModelError(diagnostic)) {
      return new Error(
        `${levelPrefix} Muse CLI rejected the model "${this.model}" as unknown. ` +
        `Check the model ID (and any cli_model override) against Muse's catalog. ` +
        `Original error: ${diagnostic}`
      );
    }

    const detail = diagnostic || '(no error output)';
    return new Error(`${levelPrefix} Muse CLI exited with code ${code}: ${detail}`);
  }

  /**
   * Detect authentication failures reported by the Muse CLI.
   *
   * Muse's own wording for an expired token is
   * "still unauthorized after a token refresh; run `muse login` again".
   *
   * @param {string} text - Captured stderr and/or terminal reason
   * @returns {boolean}
   */
  isAuthError(text) {
    return /(?:still unauthorized after a token refresh|no login to refresh a key from|run `muse login`|starting logged out|401\s+Unauthorized|HTTP error:\s*401|\bUnauthorized\b)/i.test(text || '');
  }

  /**
   * Detect an unknown/hidden model rejection. Muse fails fast with
   * "model `X` is not in the catalog".
   *
   * @param {string} text - Captured stderr and/or terminal reason
   * @returns {boolean}
   */
  isUnknownModelError(text) {
    return /is (?:not in|hidden in) the catalog/i.test(text || '');
  }

  /**
   * Test if Muse CLI is available.
   * Uses a fast `--version` check instead of running a prompt.
   * Uses the command configured in the instance (respects ENV > config > default).
   * @param {number} [timeoutMs=10000] - Timeout in milliseconds for the probe
   * @returns {Promise<boolean>}
   */
  async testAvailability(timeoutMs = 10000) {
    return new Promise((resolve) => {
      const useShell = this.useShell;
      const command = useShell ? `${this.museCmd} --version` : this.museCmd;
      const args = useShell ? [] : ['--version'];

      // Log the actual command for debugging config/override issues
      const fullCmd = useShell ? command : `${command} ${args.join(' ')}`;
      logger.debug(`Muse availability check: ${fullCmd}`);

      const muse = spawn(command, args, {
        env: {
          ...process.env,
          // Same merged env execute() and getExtractionConfig() use. A setup
          // whose muse only runs with `providers.muse.env` (or per-model env)
          // set would otherwise be reported unavailable while the real
          // invocation works fine.
          ...this.extraEnv,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: useShell
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      // Timeout guard: if the CLI hangs, resolve false
      const availabilityTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn(`Muse CLI availability check timed out after ${Math.round(timeoutMs / 1000)}s`);
        // No `shell` flag even in shell mode: this probe does not spawn
        // detached, so the child is not a process-group leader and a
        // `process.kill(-pid)` would fail with ESRCH instead of terminating
        // anything. The helper is still used for its pid guard, which stops a
        // failed spawn (pid undefined -> 0) from signalling our own group.
        killChildSafely(muse, { logPrefix: '[Muse availability]' });
        resolve(false);
      }, timeoutMs);

      muse.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      muse.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      muse.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        if (code === 0) {
          logger.info(`Muse CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          const stderrMsg = stderr.trim() ? `: ${stderr.trim()}` : '';
          logger.warn(`Muse CLI not available or returned unexpected output (exit code ${code})${stderrMsg}`);
          resolve(false);
        }
      });

      muse.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        logger.warn(`Muse CLI not available: ${error.message}`);
        resolve(false);
      });
    });
  }

  static getProviderName() {
    return 'Muse';
  }

  static getProviderId() {
    return 'muse';
  }

  static getModels() {
    return MUSE_MODELS;
  }

  static getDefaultModel() {
    return DEFAULT_MUSE_MODEL;
  }

  static getInstallInstructions() {
    // `muse` on PATH is a self-updating launcher script that downloads the real
    // binary alongside itself (macOS and Linux, arm64 and x86_64).
    return 'Install Muse Code (macOS/Linux):\n' +
           '  curl -fsSL https://api.meta.ai/muse-launcher.sh -o ~/.local/bin/muse && chmod +x ~/.local/bin/muse\n' +
           'Then authenticate: muse login (or set META_API_KEY)\n' +
           'Run `muse --help` for usage. Requires a directory on your PATH, e.g. ~/.local/bin.';
  }
}

// Register this provider
registerProvider('muse', MuseProvider);

module.exports = MuseProvider;
