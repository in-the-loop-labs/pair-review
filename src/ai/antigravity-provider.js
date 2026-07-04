// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Antigravity AI Provider
 *
 * Implements the AI provider interface for Google's Antigravity CLI (`agy`),
 * the official successor to the Gemini CLI.
 *
 * ============================================================================
 * HOW THIS ADAPTER DRIVES `agy` (verified against agy 1.0.16)
 * ============================================================================
 * The Antigravity CLI's non-interactive "print" mode (`agy -p`) IS a real
 * agentic loop — it reads files, searches the tree, and runs shell commands to
 * gather context, then prints a final answer. Verified empirically: given a
 * high-entropy random token written to a file (and NEVER shown in the prompt),
 * `agy -p` locates and reads that file and returns the exact token. So this is
 * a full agentic review harness, on par with what the Gemini adapter offered.
 *
 * Practical consequences we design around:
 *   - PLAIN-TEXT OUTPUT. There is no JSON/stream output-format flag, so we
 *     parse the final text block with extractJSON() and fall back to the
 *     inherited LLM-extraction path.
 *   - PROMPT VIA STDIN. `agy` reads the prompt from BOTH the `-p` value and
 *     stdin. We put a small directive on `-p` and stream the (potentially
 *     large) analysis prompt over stdin. Delivering the whole prompt on argv
 *     would hit the per-argument length limit (E2BIG, ~128 KB on Linux) for
 *     large diffs, so stdin is the robust transport.
 *   - THE AGENTIC LOOP TAKES TIME. A single level commonly runs ~40-90s (tree
 *     search + file reads + reasoning). Short timeouts cut the loop off
 *     mid-flight and surface as "Error: timeout waiting for response"; we give
 *     it the caller's full timeout budget via --print-timeout.
 *   - TOOL APPROVAL. Without --dangerously-skip-permissions, shell/write tool
 *     requests can block on an approval prompt that never arrives
 *     non-interactively and eventually time out. We pass that flag on the
 *     analysis path so the loop runs unattended. This mirrors the Gemini
 *     adapter's posture: `agy` exposes no read-only tool allowlist, so we rely
 *     on prompt engineering (the analysis prompts instruct read-only,
 *     no-mutation behaviour) and on running inside the throwaway git worktree
 *     (cwd) to bound blast radius.
 *   - NO ACP MODE, so there is no Antigravity chat-provider counterpart to the
 *     old `gemini-acp`.
 *
 * The JSON-extraction fallback (getExtractionConfig) does NOT enable tools or
 * skip permissions — it is a pure text->JSON reformat that needs no repo access.
 */

const path = require('path');
const { spawn } = require('child_process');
const { AIProvider, registerProvider, quoteShellArgs } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { CancellationError, isAnalysisCancelled } = require('../routes/shared');
const { wireAbortToChild, makeAbortError } = require('./abort-signal-wiring');

// Directory containing bin scripts (kept on PATH for parity with other providers)
const BIN_DIR = path.join(__dirname, '..', '..', 'bin');

/**
 * Fixed directive passed via `-p`. The real work lives in the prompt streamed
 * over stdin; this frames the task, permits read-only agentic exploration of
 * the worktree, and constrains the output shape.
 */
const ANALYSIS_DIRECTIVE =
  'Perform the code-review task described in the input provided on standard input. You are ' +
  'running non-interactively in the repository at the current working directory; you MAY use ' +
  'your read-only tools (reading files, searching, and read-only git/shell commands) to gather ' +
  'the context the instructions call for. Never create, modify, or delete files, and never run ' +
  'mutating commands. When finished, output ONLY the exact result the instructions request (for ' +
  'example, a single JSON object when JSON is requested), with no extra commentary and no ' +
  'surrounding markdown code fences.';

/** Directive for the LLM JSON-extraction fallback (base class supplies the text on stdin). */
const EXTRACTION_DIRECTIVE =
  'Read the input provided on standard input and return ONLY the raw JSON object it describes — ' +
  'no explanation, no markdown, no code fences. Do not use any tools.';

// agy self-terminates print mode at --print-timeout; extraction has a 60s cap
// in the base class, so ask agy to give up just before that.
const EXTRACTION_PRINT_TIMEOUT_SECS = 55;

// The JS-side execute() timeout is a backstop: it fires this many ms AFTER agy's
// own --print-timeout budget, so agy self-terminates first (with its own error
// and cleanup) and this only intervenes if agy ignores its own timeout.
const TIMEOUT_BACKSTOP_GRACE_MS = 15000;

/**
 * Antigravity model definitions with tier mappings.
 *
 * `id` is a clean, URL/attribute/config-safe slug used everywhere internally
 * (UI picker, config keys, disabled_models, query params). `cliName` is the
 * exact string the `agy --model` flag expects (as printed by `agy models`),
 * which contains spaces and parentheses and must never leak into ids.
 *
 * We curate the Gemini-family models here — Antigravity is the Gemini CLI's
 * successor and its native models are Gemini. `agy` also exposes Claude and
 * GPT-OSS models; those remain reachable via a `providers.antigravity.models`
 * config override but are intentionally left out of the default picker to keep
 * the cross-provider model-mismatch guard and the UX unambiguous.
 */
const ANTIGRAVITY_MODELS = [
  {
    id: 'gemini-3.5-flash-low',
    cliName: 'Gemini 3.5 Flash (Low)',
    aliases: ['gemini-3.5-flash'],
    name: '3.5 Flash (Low)',
    tier: 'fast',
    tagline: 'Rapid Sanity Check',
    description: 'Cheapest, fastest pass — quick scans and the JSON-extraction fallback',
    badge: 'Cheapest',
    badgeClass: 'badge-speed'
  },
  {
    id: 'gemini-3.5-flash-high',
    cliName: 'Gemini 3.5 Flash (High)',
    name: '3.5 Flash (High)',
    tier: 'fast',
    tagline: 'Quick Look',
    description: 'Flash speed with more reasoning effort for a sharper first pass',
    badge: 'Quick Look',
    badgeClass: 'badge-speed'
  },
  {
    id: 'gemini-3.1-pro-low',
    cliName: 'Gemini 3.1 Pro (Low)',
    aliases: ['gemini-3.1-pro'],
    name: '3.1 Pro (Low)',
    tier: 'balanced',
    tagline: 'Standard PR Review',
    description: 'Strong reasoning with a large context window — the reliable daily driver',
    badge: 'Daily Driver',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'gemini-3.1-pro-high',
    cliName: 'Gemini 3.1 Pro (High)',
    name: '3.1 Pro (High)',
    tier: 'thorough',
    tagline: 'Deep Dive',
    description: 'Maximum reasoning effort for complex, architectural reviews',
    badge: 'Deep Dive',
    badgeClass: 'badge-power'
  }
];

const DEFAULT_ANTIGRAVITY_MODEL = 'gemini-3.1-pro-low';

class AntigravityProvider extends AIProvider {
  /**
   * @param {string} model - Model identifier (clean id from ANTIGRAVITY_MODELS)
   * @param {Object} configOverrides - Config overrides from providers config
   * @param {string} configOverrides.command - Custom CLI command
   * @param {string[]} configOverrides.extra_args - Additional CLI arguments
   * @param {Object} configOverrides.env - Additional environment variables
   * @param {Object[]} configOverrides.models - Custom model definitions
   */
  constructor(model = DEFAULT_ANTIGRAVITY_MODEL, configOverrides = {}) {
    super(model);

    // Command precedence: ENV > config > default
    const envCmd = process.env.PAIR_REVIEW_ANTIGRAVITY_CMD;
    const configCmd = configOverrides.command;
    this.agyCmd = envCmd || configCmd || 'agy';
    this.configOverrides = configOverrides;

    // For multi-word commands, use shell mode (same pattern as the other providers)
    this.useShell = this.agyCmd.includes(' ');

    // Env for the analysis model (provider env + selected-model env), resolved
    // alias-aware through the shared helper so a model referenced by an alias
    // picks up the same override as its canonical id.
    this.extraEnv = this._resolveModelConfig(model).env;
  }

  /**
   * Resolve a model id (or alias) to everything a CLI invocation needs, in ONE
   * place. Consolidates the built-in and config-override lookups so the
   * constructor, _composeArgs(), and getExtractionConfig() resolve a model
   * identically. Mirrors claude-provider's _resolveModelConfig — the alternative
   * is silent divergence where the same id picks up a cliName in one lookup but
   * drops its env/extra_args in another.
   *
   * @param {string} model - The requested model id or alias.
   * @returns {{builtIn: (Object|undefined), configModel: (Object|undefined),
   *   cliModel: string, extraArgs: string[], env: Object}}
   * @private
   */
  _resolveModelConfig(model) {
    const configOverrides = this.configOverrides || {};

    const builtIn = ANTIGRAVITY_MODELS.find(
      m => m.id === model || (m.aliases || []).includes(model)
    );

    // A config override may target the built-in by any of its ids/aliases, or
    // declare its own aliases; match on the union so no lookup diverges.
    const modelKeys = new Set([model, builtIn?.id, ...(builtIn?.aliases || [])].filter(Boolean));
    const configModel = configOverrides.models?.find(
      m => modelKeys.has(m.id) || (m.aliases || []).some(a => modelKeys.has(a))
    );

    // Exact `agy --model` string. Config overrides honor the shared `cli_model`
    // contract used across providers (documented in config.example.json) and
    // fall back to `cliName`; built-ins carry `cliName`. Raw id is the last
    // resort — agy tolerates an unknown name by using its default.
    const cliModel =
      configModel?.cli_model ||
      configModel?.cliName ||
      builtIn?.cliName ||
      model;

    // Merge order (lowest -> highest precedence): built-in, provider, per-model.
    const extraArgs = [
      ...(builtIn?.extra_args || []),
      ...(configOverrides.extra_args || []),
      ...(configModel?.extra_args || [])
    ];
    const env = {
      ...(builtIn?.env || {}),
      ...(configOverrides.env || {}),
      ...(configModel?.env || {})
    };

    return { builtIn, configModel, cliModel, extraArgs, env };
  }

  /**
   * Translate a model id (or alias) into the exact string `agy --model` expects.
   * Thin wrapper over _resolveModelConfig for call sites that only need the name.
   * @param {string} model
   * @returns {string}
   */
  _resolveCliModel(model) {
    return this._resolveModelConfig(model).cliModel;
  }

  /**
   * Build the argument list (before any shell wrapping) for a single agy print
   * invocation. The heavy prompt travels over stdin; `directive` is the small
   * fixed `-p` value.
   * @param {Object} opts
   * @param {string} opts.model - Model id
   * @param {string} opts.directive - The `-p` directive
   * @param {number} opts.printTimeoutSecs - Value for --print-timeout
   * @param {boolean} [opts.agentic=false] - If true, pass --dangerously-skip-permissions
   *   so the tool loop runs unattended (analysis path). Extraction leaves it off.
   * @returns {string[]}
   */
  _composeArgs({ model, directive, printTimeoutSecs, agentic = false }) {
    const { cliModel, extraArgs } = this._resolveModelConfig(model);
    const baseArgs = ['--print-timeout', `${printTimeoutSecs}s`, '--model', cliModel];
    if (agentic) {
      // agy has no fine-grained tool allowlist; auto-approve so read-only
      // exploration (and git-diff-lines / git reads the prompts rely on) does
      // not block non-interactively. Blast radius is bounded by the worktree.
      baseArgs.push('--dangerously-skip-permissions');
    }
    baseArgs.push('-p', directive);
    return [...baseArgs, ...extraArgs];
  }

  /**
   * Wrap args for shell vs direct spawn, mirroring the Claude provider pattern:
   * multi-word commands run through a shell with fully quoted args.
   * @param {string[]} args
   * @returns {{command: string, args: string[]}}
   */
  _wrapCommand(args) {
    if (this.useShell) {
      return { command: `${this.agyCmd} ${quoteShellArgs(args).join(' ')}`, args: [] };
    }
    return { command: this.agyCmd, args };
  }

  /**
   * Execute Antigravity CLI with a prompt.
   * @param {string} prompt - The full analysis prompt (delivered via stdin)
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or raw fallback
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const {
        cwd = process.cwd(),
        timeout = 600000,
        level = 'unknown',
        analysisId,
        registerProcess,
        logPrefix,
        abortSignal
      } = options;

      const levelPrefix = logPrefix || `[Level ${level}]`;
      // The caller's (council/advanced) configured timeout is the budget: agy
      // receives it as its own --print-timeout and self-terminates there. The JS
      // timer below is only a backstop for a process that ignores its own timeout.
      const budgetMs = timeout || 600000;
      const printTimeoutSecs = Math.max(1, Math.ceil(budgetMs / 1000));
      const composed = this._composeArgs({ model: this.model, directive: ANALYSIS_DIRECTIVE, printTimeoutSecs, agentic: true });
      const { command, args } = this._wrapCommand(composed);

      logger.info(`${levelPrefix} Executing Antigravity CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} bytes`);

      const agy = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          ...this.extraEnv,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: this.useShell,
        detached: this.useShell
      });

      const pid = agy.pid;
      logger.info(`${levelPrefix} Spawned Antigravity CLI process: PID ${pid}`);

      if (analysisId && registerProcess) {
        registerProcess(analysisId, agy);
        logger.info(`${levelPrefix} Registered process ${pid} for analysis ${analysisId}`);
      }

      // Wire AbortSignal -> SIGTERM for tour/summary cancellation.
      const abortWiring = wireAbortToChild(agy, abortSignal, { logPrefix: levelPrefix, shell: this.useShell });

      let stdout = '';
      let stderr = '';
      let timeoutId = null;
      let settled = false;

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        abortWiring.detach();
        fn(value);
      };

      const backstopMs = budgetMs + TIMEOUT_BACKSTOP_GRACE_MS;
      timeoutId = setTimeout(() => {
        logger.error(`${levelPrefix} Process ${pid} exceeded its ${budgetMs}ms timeout budget (backstop fired at ${backstopMs}ms)`);
        agy.kill('SIGTERM');
        settle(reject, new Error(`${levelPrefix} Antigravity CLI timed out after ${budgetMs}ms`));
      }, backstopMs);

      agy.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      agy.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      agy.on('close', (code) => {
        if (settled) return;

        // BackgroundQueue-driven cancellation — see claude-provider for rationale.
        if (abortWiring.cancelled()) {
          logger.info(`${levelPrefix} Antigravity CLI terminated by user cancel (exit code ${code})`);
          settle(reject, makeAbortError(`${levelPrefix} Cancelled by user`));
          return;
        }

        // Check for cancellation signals (SIGTERM=143, SIGKILL=137)
        const isCancellationCode = code === 143 || code === 137;
        if (isCancellationCode && analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} Antigravity CLI terminated due to analysis cancellation (exit code ${code})`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} Antigravity CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.warn(`${levelPrefix} Antigravity CLI stderr (success): ${stderr}`);
          }
        }

        if (code !== 0) {
          // agy prints "Error: timeout waiting for response" here if the
          // agentic loop exceeded --print-timeout before producing an answer.
          logger.error(`${levelPrefix} Antigravity CLI exited with code ${code}`);
          settle(reject, new Error(`${levelPrefix} Antigravity CLI exited with code ${code}: ${stderr}`));
          return;
        }

        logger.info(`${levelPrefix} Antigravity CLI completed: ${stdout.length} bytes of output`);

        // Print mode emits a single plain-text block; extract the JSON directly.
        const extracted = extractJSON(stdout, level, levelPrefix);
        if (extracted.success) {
          logger.success(`${levelPrefix} Successfully parsed JSON response`);
          const dataPreview = JSON.stringify(extracted.data, null, 2);
          logger.debug(`${levelPrefix} [parsed_data] ${dataPreview.substring(0, 3000)}${dataPreview.length > 3000 ? '...' : ''}`);
          if (extracted.data?.suggestions) {
            const count = Array.isArray(extracted.data.suggestions) ? extracted.data.suggestions.length : 0;
            logger.info(`${levelPrefix} [response] ${count} suggestions in parsed response`);
          }
          settle(resolve, extracted.data);
          return;
        }

        // Regex extraction failed — try the LLM-based extraction fallback.
        logger.warn(`${levelPrefix} Regex extraction failed: ${extracted.error}`);
        logger.info(`${levelPrefix} LLM fallback input length: ${stdout.length} characters (raw stdout)`);
        logger.info(`${levelPrefix} Attempting LLM-based JSON extraction fallback...`);

        // agy exited cleanly; the process backstop has nothing left to supervise.
        // Disarm it before the LLM fallback (which spawns and supervises its own
        // child) so a slow extraction can't trip an "agy timed out" rejection
        // after agy already succeeded.
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        (async () => {
          try {
            const llmExtracted = await this.extractJSONWithLLM(stdout, { level, analysisId, registerProcess, logPrefix: levelPrefix });
            if (llmExtracted.success) {
              logger.success(`${levelPrefix} LLM extraction fallback succeeded`);
              settle(resolve, llmExtracted.data);
            } else {
              logger.warn(`${levelPrefix} LLM extraction fallback also failed: ${llmExtracted.error}`);
              logger.info(`${levelPrefix} Raw response preview: ${stdout.substring(0, 500)}...`);
              settle(resolve, { raw: stdout, parsed: false });
            }
          } catch (llmError) {
            logger.warn(`${levelPrefix} LLM extraction fallback error: ${llmError.message}`);
            settle(resolve, { raw: stdout, parsed: false });
          }
        })();
      });

      agy.on('error', (error) => {
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Antigravity CLI not found. Please ensure the Antigravity CLI is installed.`);
          settle(reject, new Error(`${levelPrefix} Antigravity CLI not found. ${AntigravityProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Antigravity process error: ${error}`);
          settle(reject, error);
        }
      });

      // Handle stdin errors (e.g., EPIPE if the process exits before the write completes)
      agy.stdin.on('error', (err) => {
        logger.error(`${levelPrefix} stdin error: ${err.message}`);
      });

      // Deliver the full prompt via stdin (avoids argv length limits on large diffs)
      agy.stdin.write(prompt, (err) => {
        if (err) {
          logger.error(`${levelPrefix} Failed to write prompt to stdin: ${err}`);
          agy.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Failed to write prompt to stdin: ${err}`));
        }
      });
      agy.stdin.end();
    });
  }

  /**
   * Build the exact { command, args } that execute() spawns for analysis.
   * Exposed so out-of-band callers (e.g. the security verifier) can reproduce
   * the real analysis invocation — including the shell-wrapping branch and the
   * --dangerously-skip-permissions flag — without reaching into `_`-internals.
   * The heavy prompt still travels over stdin; this covers argv only.
   * @param {number} [printTimeoutSecs=60] - Value for --print-timeout.
   * @returns {{command: string, args: string[]}}
   */
  getAnalysisSpawnConfig(printTimeoutSecs = 60) {
    const composed = this._composeArgs({
      model: this.model,
      directive: ANALYSIS_DIRECTIVE,
      printTimeoutSecs,
      agentic: true
    });
    return this._wrapCommand(composed);
  }

  /**
   * Get CLI configuration for LLM extraction. The base class writes the
   * extraction prompt to stdin; we bake the extraction directive into `-p`.
   * @param {string} model - The model to use for extraction
   * @returns {Object} Configuration for spawning the extraction process
   */
  getExtractionConfig(model) {
    const args = this._composeArgs({
      model,
      directive: EXTRACTION_DIRECTIVE,
      printTimeoutSecs: EXTRACTION_PRINT_TIMEOUT_SECS
    });
    const { command, args: wrappedArgs } = this._wrapCommand(args);
    // The LLM-extraction fallback is the COMMON path here (agy emits plain text,
    // no JSON mode), so it must run with the same env analysis uses. Resolve env
    // for the EXTRACTION model — which may be a different fast-tier model than
    // this.model — rather than reusing this.extraEnv (the analysis model's env).
    const { env } = this._resolveModelConfig(model);
    return {
      command,
      args: wrappedArgs,
      useShell: this.useShell,
      promptViaStdin: true,
      env
    };
  }

  /**
   * Test if the Antigravity CLI is available (respects ENV > config > default).
   * @param {number} [timeoutMs=10000] - Timeout for the probe.
   * @returns {Promise<boolean>}
   */
  async testAvailability(timeoutMs = 10000) {
    return new Promise((resolve) => {
      const useShell = this.useShell;
      const command = useShell ? `${this.agyCmd} --version` : this.agyCmd;
      const args = useShell ? [] : ['--version'];

      const fullCmd = useShell ? command : `${command} ${args.join(' ')}`;
      logger.debug(`Antigravity availability check: ${fullCmd}`);

      const agy = spawn(command, args, {
        env: {
          ...process.env,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: useShell
      });

      let stdout = '';
      let settled = false;

      const availabilityTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn(`Antigravity CLI availability check timed out after ${Math.round(timeoutMs / 1000)}s`);
        try { agy.kill(); } catch { /* ignore */ }
        resolve(false);
      }, timeoutMs);

      agy.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      agy.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        if (code === 0 && stdout.includes('.')) {
          logger.info(`Antigravity CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          logger.warn('Antigravity CLI not available or returned unexpected output');
          resolve(false);
        }
      });

      agy.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        logger.warn(`Antigravity CLI not available: ${error.message}`);
        resolve(false);
      });
    });
  }

  static getProviderName() {
    return 'Antigravity';
  }

  static getProviderId() {
    return 'antigravity';
  }

  static getModels() {
    return ANTIGRAVITY_MODELS;
  }

  static getDefaultModel() {
    return DEFAULT_ANTIGRAVITY_MODEL;
  }

  static getInstallInstructions() {
    return 'Install the Antigravity CLI: curl -fsSL https://antigravity.google/cli/install.sh | bash\n' +
           'Or visit: https://antigravity.google/docs';
  }
}

// Register this provider
registerProvider('antigravity', AntigravityProvider);

module.exports = AntigravityProvider;
