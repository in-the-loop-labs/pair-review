// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Codex AI Provider
 *
 * Implements the AI provider interface for OpenAI's Codex CLI.
 * Uses the `codex exec` command for non-interactive execution.
 */

const path = require('path');
const { spawn } = require('child_process');
const { AIProvider, registerProvider, quoteShellArgs, resolveCliModelConfig } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { CancellationError, isAnalysisCancelled } = require('../routes/shared');
const { StreamParser, parseCodexLine } = require('./stream-parser');
const { wireAbortToChild, makeAbortError, killChildSafely } = require('./abort-signal-wiring');

// Directory containing bin scripts (git-diff-lines, etc.)
const BIN_DIR = path.join(__dirname, '..', '..', 'bin');

/**
 * Codex model definitions with tier mappings
 *
 * Based on OpenAI's GPT-6 launches (Astra in September 2026; Sol and Luna on
 * 2026-09-22) and the Models guide (developers.openai.com/api/docs/models).
 * Verified against the Codex CLI 0.155.1 model catalog with a ChatGPT sign-in.
 * - gpt-5.6-sol: the default (gpt-5.6-sol-high; $4/$20 per MTok). GPT-5.6 Sol
 *   stays the default, and GPT-5.6 Luna Low the first fast entry, while GPT-6
 *   access rolls out: GPT-6 Sol/Luna access depends on workspace settings and
 *   Enterprise admins must enable it, testAvailability() only checks
 *   `codex --version`, and nothing falls back to GPT-5.6 at runtime. A GPT-6
 *   default would fail every default analysis for users without access.
 * - gpt-6-astra: GPT-6 flagship, the most capable model for complex, demanding
 *   work ($10/$50 per MTok, same context as Sol). About five times GPT-6 Sol's
 *   price, so it stays an opt-in thorough choice rather than the default.
 * - gpt-6-sol: Frontier model built for complex coding and agentic workflows
 *   ($2/$10 per MTok; 1.05M API context, capped at 272K in the Codex catalog;
 *   128K output; API input above 272K bills at 2x, output at 1.5x). Newer than
 *   GPT-5.6 Sol at half its price, but opt-in until GPT-6 access is universal.
 * - gpt-6-luna: GPT-6's most efficient model for focused, high-volume work
 *   ($0.10/$0.50 per MTok, same context as Sol). Per OpenAI, GPT-6 Luna (max)
 *   exceeds GPT-5.6 Sol (medium) at a tenth of its cost. No `ultra` effort.
 *   Opt-in, like GPT-6 Sol.
 * - gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna: "legacy" in Codex but still
 *   available (no retirement date announced)
 * - gpt-5.5: older frontier model. OpenAI retires it from Codex on ALL plans
 *   on 2026-10-14 (the API is unaffected); remove the gpt-5.5-* entries then.
 * - Every model is exposed only through explicit reasoning-effort variants.
 *
 * Tiers: thorough (Astra, GPT-6 Sol, GPT-5.6 Sol, GPT-5.5), balanced (Terra,
 * GPT-5.6 Luna, GPT-6 Luna Max), fast (GPT-5.6 Luna Low, GPT-6 Luna Low). In
 * the balanced and fast tiers GPT-6 goes last: the first entry of a tier is an
 * automatic pick (provider switch in the UI, extraction, default fallback).
 * Entries are ordered thorough → balanced → fast; the first `fast` entry
 * serves JSON extraction and hunk summaries (see AIProvider.getFastTierModel).
 * Guided tours use the provider default, not the fast tier.
 *
 * Reasoning-effort variants (-low / -high / -xhigh / -max) use `cli_model` to pass
 * the base model ID to `codex exec -m` and add `-c model_reasoning_effort="..."`
 * via extra_args so Codex picks up the effort level through its config override.
 *
 * Deprecated (April 2026): gpt-5.1-codex-mini, gpt-5.1-codex-max, gpt-5.1-codex
 * Deprecated (August 2026): gpt-5.4 (gpt-5.4-high / gpt-5.4-xhigh), gpt-5.4-nano,
 *   gpt-5.3-codex — retired by OpenAI; Codex rejects them with a 400. They are
 *   intentionally NOT aliased onto other models so saved councils fail loudly
 *   instead of silently running a different model.
 * Deprecated (August 31, 2026): gpt-5.4-mini — retired for ChatGPT sign-in
 *   (Codex rejects it with a 400) but still valid for API keys. OpenAI names
 *   gpt-6-luna as its replacement; it is NOT aliased onto any Luna entry
 *   (different model line and price). An unrecognized id reaches `codex exec -m`
 *   verbatim with no effort override, so API-key users can still name it raw
 *   (`--model gpt-5.4-mini`, or a `providers.codex.models` entry for the web UI
 *   picker).
 */
const CODEX_MODELS = [
  // ── Thorough tier ───────────────────────────────────────────────────────
  {
    id: 'gpt-6-astra-high',
    cli_model: 'gpt-6-astra',
    extra_args: ['-c', 'model_reasoning_effort="high"'],
    name: 'GPT-6 Astra High',
    tier: 'thorough',
    tagline: 'Most Capable',
    description: 'OpenAI\'s GPT-6 flagship with high reasoning effort for the hardest reviews: deep cross-file analysis, subtle regressions, and demanding architectural work. Costs about five times more than GPT-6 Sol.',
    badge: 'Most Capable',
    badgeClass: 'badge-power'
  },
  {
    id: 'gpt-6-astra-xhigh',
    cli_model: 'gpt-6-astra',
    extra_args: ['-c', 'model_reasoning_effort="xhigh"'],
    name: 'GPT-6 Astra XHigh',
    tier: 'thorough',
    tagline: 'Maximum Depth',
    description: 'GPT-6 Astra with extra-high reasoning effort for the most difficult reviews: concurrency, security-sensitive changes, and large codebase context. Premium pricing, about five times GPT-6 Sol.',
    badge: 'Extra High',
    badgeClass: 'badge-power'
  },
  {
    id: 'gpt-6-sol-high',
    cli_model: 'gpt-6-sol',
    extra_args: ['-c', 'model_reasoning_effort="high"'],
    name: 'GPT-6 Sol High',
    tier: 'thorough',
    tagline: 'Newest Frontier',
    description: 'GPT-6 frontier model built for complex coding and agentic work, with high reasoning effort for demanding PR reviews and cross-file analysis, at about a fifth of Astra\'s price. Needs GPT-6 access, which is still rolling out (Enterprise admins must enable it).',
    badge: 'Newest',
    badgeClass: 'badge-power'
  },
  {
    id: 'gpt-6-sol-xhigh',
    cli_model: 'gpt-6-sol',
    extra_args: ['-c', 'model_reasoning_effort="xhigh"'],
    name: 'GPT-6 Sol XHigh',
    tier: 'thorough',
    tagline: 'Frontier Depth',
    description: 'GPT-6 Sol with extra-high reasoning effort for difficult architectural reviews, subtle regressions, and security-sensitive changes. Needs GPT-6 access, which is still rolling out (Enterprise admins must enable it).',
    badge: 'Extra High',
    badgeClass: 'badge-power'
  },
  {
    id: 'gpt-5.6-sol-high',
    cli_model: 'gpt-5.6-sol',
    extra_args: ['-c', 'model_reasoning_effort="high"'],
    name: 'GPT-5.6 Sol High',
    tier: 'thorough',
    tagline: 'Frontier Review',
    description: 'Strong frontier reviewer with high reasoning effort for demanding PR reviews, complex professional work, and cross-file analysis. The default while GPT-6 access rolls out.',
    badge: 'Recommended',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'gpt-5.6-sol-xhigh',
    cli_model: 'gpt-5.6-sol',
    extra_args: ['-c', 'model_reasoning_effort="xhigh"'],
    name: 'GPT-5.6 Sol XHigh',
    tier: 'thorough',
    tagline: 'Frontier Depth',
    description: 'GPT-5.6 Sol with extra-high reasoning effort for difficult architectural reviews, subtle regressions, and security-sensitive changes.',
    badge: 'Extra High',
    badgeClass: 'badge-power'
  },
  {
    id: 'gpt-5.5-high',
    cli_model: 'gpt-5.5',
    extra_args: ['-c', 'model_reasoning_effort="high"'],
    name: 'GPT-5.5 High',
    tier: 'thorough',
    tagline: 'Previous Flagship',
    description: 'Previous-generation GPT model with high reasoning effort for demanding PR reviews, strong code understanding, and careful cross-file analysis. OpenAI retires GPT-5.5 from Codex on 2026-10-14.',
    badge: 'Previous Gen',
    badgeClass: 'badge-power'
  },
  {
    id: 'gpt-5.5-xhigh',
    cli_model: 'gpt-5.5',
    extra_args: ['-c', 'model_reasoning_effort="xhigh"'],
    name: 'GPT-5.5 XHigh',
    tier: 'thorough',
    tagline: 'Frontier Depth',
    description: 'GPT-5.5 with extra-high reasoning effort for the hardest reviews: architecture, concurrency, security-sensitive changes, and large codebase context. OpenAI retires GPT-5.5 from Codex on 2026-10-14.',
    badge: 'Max Reasoning',
    badgeClass: 'badge-power'
  },
  // ── Balanced tier ───────────────────────────────────────────────────────
  // The first balanced entry is what the UI picks when a user switches to Codex
  // from a balanced model, and resolveDefaultModel's fallback when the flagged
  // default is disabled, so it must run for every account: GPT-6 goes last.
  {
    id: 'gpt-5.6-terra-xhigh',
    cli_model: 'gpt-5.6-terra',
    extra_args: ['-c', 'model_reasoning_effort="xhigh"'],
    name: 'GPT-5.6 Terra XHigh',
    tier: 'balanced',
    tagline: 'Intelligence & Value',
    description: 'GPT-5.6 balanced model with extra-high reasoning effort, combining strong intelligence and lower cost for careful everyday PR reviews.',
    badge: 'Best Balance',
    badgeClass: 'badge-balanced'
  },
  {
    id: 'gpt-5.6-luna-max',
    cli_model: 'gpt-5.6-luna',
    extra_args: ['-c', 'model_reasoning_effort="max"'],
    name: 'GPT-5.6 Luna Max',
    tier: 'balanced',
    tagline: 'Previous Gen',
    description: 'Previous-generation Luna, GPT-5.6\'s most cost-efficient model, with max reasoning effort for high-volume reviews and broad codebase scans.',
    badge: 'Previous Gen',
    badgeClass: 'badge-balanced'
  },
  {
    id: 'gpt-6-luna-max',
    cli_model: 'gpt-6-luna',
    extra_args: ['-c', 'model_reasoning_effort="max"'],
    name: 'GPT-6 Luna Max',
    tier: 'balanced',
    tagline: 'High-Volume Value',
    description: 'GPT-6\'s most efficient model at max reasoning effort. Per OpenAI it beats GPT-5.6 Sol (medium) at a tenth of the cost, for high-volume reviews and broad codebase scans. Needs GPT-6 access, which is still rolling out (Enterprise admins must enable it).',
    badge: 'Lowest Cost',
    badgeClass: 'badge-speed'
  },
  // ── Fast tier ───────────────────────────────────────────────────────────
  // The first fast entry serves JSON extraction and hunk summaries, so it must
  // run for every account: keep it on GPT-5.6 until GPT-6 access is universal.
  {
    id: 'gpt-5.6-luna-low',
    cli_model: 'gpt-5.6-luna',
    extra_args: ['-c', 'model_reasoning_effort="low"'],
    name: 'GPT-5.6 Luna Low',
    tier: 'fast',
    tagline: 'Quick Scan',
    description: 'GPT-5.6\'s most cost-efficient model at low reasoning effort for surface scans: obvious bugs, style issues, and lint-level feedback.',
    badge: 'Fastest',
    badgeClass: 'badge-speed'
  },
  {
    id: 'gpt-6-luna-low',
    cli_model: 'gpt-6-luna',
    extra_args: ['-c', 'model_reasoning_effort="low"'],
    name: 'GPT-6 Luna Low',
    tier: 'fast',
    tagline: 'Newest Quick Scan',
    description: 'GPT-6\'s most efficient model at low reasoning effort for surface scans: obvious bugs, style issues, and lint-level feedback. Needs GPT-6 access, which is still rolling out (Enterprise admins must enable it).',
    badge: 'Newest',
    badgeClass: 'badge-speed'
  }
];

class CodexProvider extends AIProvider {
  /**
   * @param {string} model - Model identifier
   * @param {Object} configOverrides - Config overrides from providers config
   * @param {string} configOverrides.command - Custom CLI command
   * @param {string[]} configOverrides.args - Replace default shell env args (default: login shell + env policy)
   * @param {string[]} configOverrides.extra_args - Additional CLI arguments (appended)
   * @param {Object} configOverrides.env - Additional environment variables
   * @param {Object[]} configOverrides.models - Custom model definitions
   */
  constructor(model = CodexProvider.getDefaultModel(), configOverrides = {}) {
    super(model);

    // Command precedence: ENV > config > default
    const envCmd = process.env.PAIR_REVIEW_CODEX_CMD;
    const configCmd = configOverrides.command;
    const codexCmd = envCmd || configCmd || 'codex';

    // Store for use in getExtractionConfig and testAvailability
    this.codexCmd = codexCmd;
    this.configOverrides = configOverrides;

    // For multi-word commands, use shell mode (same pattern as Claude provider)
    this.useShell = codexCmd.includes(' ');

    // SECURITY: Codex sandbox modes and shell execution
    //
    // Codex sandbox modes:
    // - read-only: Can browse files but CANNOT run shell commands (too restrictive)
    // - workspace-write: Can read, edit, run commands in working directory only
    // - danger-full-access: Full system access (too permissive)
    //
    // For code review, we need shell commands (git, git-diff-lines) but don't need
    // network access or writes outside the worktree. We use "workspace-write" because:
    // 1. We run in a dedicated worktree, not the main repo
    // 2. "read-only" prevents ALL shell commands including git-diff-lines
    // 3. The AI is instructed to only analyze code, not modify it
    //
    // Newer Codex CLI versions deprecate --full-auto; `codex exec` is already
    // non-interactive, and `--sandbox workspace-write` selects the required
    // sandbox policy.
    //
    // Shell environment config:
    // - allow_login_shell=false: Prevents zsh from using -l flag, which would
    //   reconstruct PATH from scratch and lose our BIN_DIR modification.
    // - shell_environment_policy.include_only: Whitelist PATH, HOME, USER to be
    //   inherited from the parent process, ensuring git-diff-lines is findable.

    // Build args: base args + provider extra_args + model extra_args
    // In yolo mode, bypass all sandbox restrictions and approval prompts
    // (--dangerously-bypass-approvals-and-sandbox is the Codex CLI equivalent of Claude's --dangerously-skip-permissions)
    const sandboxArgs = configOverrides.yolo
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', 'workspace-write'];
    // Shell env args prevent login shell from reconstructing PATH (orthogonal to
    // sandbox permissions). Overridable via configOverrides.args following the
    // same two-tier pattern as chat-providers.js: args replaces, extra_args appends.
    const defaultShellEnvArgs = ['-c', 'allow_login_shell=false', '-c', 'shell_environment_policy.include_only=["PATH","HOME","USER","GH_TOKEN","GITHUB_TOKEN"]'];
    const configArgs = configOverrides.args || defaultShellEnvArgs;

    // Resolve cli_model + extra_args + env from built-in model, provider config,
    // and per-model config. This is what lets reasoning variants like
    // gpt-6-astra-high pass `-m gpt-6-astra` plus `-c model_reasoning_effort="high"`.
    const { cliModel, extraArgs, env } = this._resolveModelConfig(model);

    // IMPORTANT: `-` (stdin marker) must come LAST, after any extra_args.
    // Reasoning variants contribute `-c model_reasoning_effort="..."` via
    // extraArgs; if '-' were placed inside baseArgs those flags would land
    // after the positional stdin marker and be ignored. `buildArgsForModel`
    // enforces the same invariant for the extraction path.
    const baseArgs = ['exec', '-m', cliModel, '--json', ...sandboxArgs, ...configArgs];

    this.extraEnv = env;

    if (this.useShell) {
      // In shell mode, build full command string with args
      this.command = `${codexCmd} ${quoteShellArgs([...baseArgs, ...extraArgs, '-']).join(' ')}`;
      this.args = [];
    } else {
      this.command = codexCmd;
      this.args = [...baseArgs, ...extraArgs, '-'];
    }
  }

  /**
   * Resolve model configuration by looking up built-in and config override definitions.
   * Produces the CLI model ID (for `-m`), merged extra_args, and merged env.
   *
   * Precedence for cli_model: config model > built-in model > modelId.
   * `cli_model` lets reasoning-effort variants (e.g. `gpt-6-astra-high`) pass the
   * base model (`gpt-6-astra`) to `codex exec -m` while adding reasoning overrides
   * via extra_args.
   *
   * @param {string} modelId
   * @returns {{ builtIn: Object|undefined, configModel: Object|undefined, cliModel: string, extraArgs: string[], env: Object }}
   * @private
   */
  _resolveModelConfig(modelId) {
    const configOverrides = this.configOverrides || {};

    const builtIn = CODEX_MODELS.find(m => m.id === modelId || (m.aliases && m.aliases.includes(modelId)));
    // A config override may target the built-in by any of its ids/aliases, or
    // declare its own aliases; match on the union so no lookup diverges.
    const modelKeys = new Set([modelId, builtIn?.id, ...(builtIn?.aliases || [])].filter(Boolean));
    const configModel = configOverrides.models?.find(
      m => modelKeys.has(m.id) || (m.aliases || []).some(a => modelKeys.has(a))
    );

    // Shared cli_model ladder (config model > built-in > id); see provider.js.
    const cliModel = resolveCliModelConfig(builtIn, configModel, modelId);

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
   * Execute Codex CLI with a prompt
   * @param {string} prompt - The prompt to send to Codex
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', analysisId, registerProcess, onStreamEvent, logPrefix, abortSignal } = options;

      const levelPrefix = logPrefix || `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing Codex CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} bytes`);

      const codex = spawn(this.command, this.args, {
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

      const pid = codex.pid;
      logger.info(`${levelPrefix} Spawned Codex CLI process: PID ${pid}`);

      // Register process for cancellation tracking if analysisId provided
      if (analysisId && registerProcess) {
        registerProcess(analysisId, codex);
        logger.info(`${levelPrefix} Registered process ${pid} for analysis ${analysisId}`);
      }

      // Wire AbortSignal -> SIGTERM for tour/summary cancellation.
      // shell flag triggers group-kill so the CLI grandchild dies with the shell.
      const abortWiring = wireAbortToChild(codex, abortSignal, { logPrefix: levelPrefix, shell: this.useShell });

      let stdout = '';
      let stderr = '';
      let timeoutId = null;
      let settled = false;  // Guard against multiple resolve/reject calls
      let lineBuffer = '';  // Buffer for incomplete JSONL lines
      let lineCount = 0;    // Count of JSONL events for progress tracking

      // Centralize detach in `settle` so the abort listener is removed
      // regardless of which exit path (close/timeout/error) wins. Avoids
      // leaking a listener on the per-job AbortSignal that tour/summary
      // generators reuse across many provider.execute() calls.
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        abortWiring.detach();
        fn(value);
      };

      // Set up side-channel stream parser for live progress events
      const streamParser = onStreamEvent
        ? new StreamParser(parseCodexLine, onStreamEvent, { cwd })
        : null;

      // Set timeout
      if (timeout) {
        timeoutId = setTimeout(() => {
          logger.error(`${levelPrefix} Process ${pid} timed out after ${timeout}ms`);
          killChildSafely(codex, { logPrefix: levelPrefix, shell: this.useShell });
          settle(reject, new Error(`${levelPrefix} Codex CLI timed out after ${timeout}ms`));
        }, timeout);
      }

      // Collect stdout with streaming JSONL parsing for debug visibility
      codex.stdout.on('data', (data) => {
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
      codex.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      codex.on('close', (code) => {
        if (settled) return;  // Already settled by timeout or error

        // Detach is centralized in `settle`.

        // Flush any remaining stream parser buffer
        if (streamParser) {
          streamParser.flush();
        }

        // BackgroundQueue-driven cancellation — mirror of claude-provider.
        if (abortWiring.cancelled()) {
          logger.info(`${levelPrefix} Codex CLI terminated by user cancel (exit code ${code})`);
          settle(reject, makeAbortError(`${levelPrefix} Cancelled by user`));
          return;
        }

        // Check for cancellation signals (SIGTERM=143, SIGKILL=137)
        const isCancellationCode = code === 143 || code === 137;
        if (isCancellationCode && analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} Codex CLI terminated due to analysis cancellation (exit code ${code})`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

        // Always log stderr if present
        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} Codex CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.warn(`${levelPrefix} Codex CLI stderr (success): ${stderr}`);
          }
        }

        if (code !== 0) {
          logger.error(`${levelPrefix} Codex CLI exited with code ${code}`);
          settle(reject, this.createExitError(code, stderr, levelPrefix));
          return;
        }

        // Log completion with event count (only for successful completion)
        logger.info(`${levelPrefix} Codex CLI completed: ${lineCount} JSONL events received`);

        // Process any remaining buffered line
        if (lineBuffer.trim()) {
          lineCount++;
          this.logStreamLine(lineBuffer, lineCount, levelPrefix);
        }

        // Parse the Codex JSONL response
        const parsed = this.parseCodexResponse(stdout, level, levelPrefix);
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
        } else {
          // Regex extraction failed, try LLM-based extraction as fallback
          logger.warn(`${levelPrefix} Regex extraction failed: ${parsed.error}`);
          const llmFallbackInput = parsed.textContent || stdout;
          logger.info(`${levelPrefix} LLM fallback input length: ${llmFallbackInput.length} characters (${parsed.textContent ? 'text content' : 'raw stdout'})`);
          logger.info(`${levelPrefix} Attempting LLM-based JSON extraction fallback...`);

          // The Codex child has already exited, so a cancel arriving now only
          // makes the abort wiring kill something already dead. Nothing else on
          // this path consults it, so without the checks below a cancelled
          // analysis would settle as a normal result. The signal is read
          // alongside the wiring flag as the source of truth.
          const cancelledDuringExtraction = () =>
            abortWiring.cancelled() || abortSignal?.aborted === true;

          // Use async IIFE to handle the async LLM extraction
          (async () => {
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
      codex.on('error', (error) => {
        // Detach happens inside `settle`.
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Codex CLI not found. Please ensure Codex CLI is installed.`);
          settle(reject, new Error(`${levelPrefix} Codex CLI not found. ${CodexProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Codex process error: ${error}`);
          settle(reject, error);
        }
      });

      // Handle stdin errors (e.g., EPIPE if process exits before write completes)
      codex.stdin.on('error', (err) => {
        logger.error(`${levelPrefix} stdin error: ${err.message}`);
      });

      // Send the prompt to stdin
      codex.stdin.write(prompt, (err) => {
        if (err) {
          logger.error(`${levelPrefix} Failed to write prompt to stdin: ${err}`);
          // A failed spawn (ENOENT) EPIPEs stdin and lands here with a pidless
          // child; killChildSafely skips the self-directed kill(0).
          killChildSafely(codex, { logPrefix: levelPrefix, shell: this.useShell });
          settle(reject, new Error(`${levelPrefix} Failed to write prompt to stdin: ${err}`));
        }
      });
      codex.stdin.end();
    });
  }

  /**
   * Build an actionable error for Codex CLI process failures.
   *
   * @param {number} code - Process exit code
   * @param {string} stderr - Captured stderr
   * @param {string} levelPrefix - Logging prefix
   * @returns {Error}
   */
  createExitError(code, stderr, levelPrefix) {
    const stderrText = stderr.trim();

    if (this.isAuthError(stderrText)) {
      return new Error(
        `${levelPrefix} Codex CLI authentication failed. Check Codex CLI authentication and try again. ` +
        `Original stderr: ${stderrText}`
      );
    }

    return new Error(`${levelPrefix} Codex CLI exited with code ${code}: ${stderr}`);
  }

  /**
   * Detect authentication failures reported by the Codex CLI.
   *
   * @param {string} stderr - Captured stderr
   * @returns {boolean}
   */
  isAuthError(stderr) {
    return /(?:401\s+Unauthorized|HTTP error:\s*401|Unauthorized)/i.test(stderr);
  }

  /**
   * Parse Codex CLI JSONL response
   * Codex outputs JSONL with multiple event types:
   * - thread.started: Session info
   * - turn.started: Turn begins
   * - item.completed: Contains reasoning or agent_message items
   * - turn.completed: Turn ends with usage stats
   *
   * We need to extract the agent_message content which contains the AI response.
   *
   * @param {string} stdout - Raw stdout from Codex CLI (JSONL format)
   * @param {string|number} level - Analysis level for logging
   * @returns {{success: boolean, data?: Object, error?: string}}
   */
  parseCodexResponse(stdout, level, logPrefix) {
    const levelPrefix = logPrefix || `[Level ${level}]`;

    try {
      // Split by newlines and parse each JSON line
      const lines = stdout.trim().split('\n').filter(line => line.trim());
      // Accumulate text from ALL agent_message events, not just the last one.
      // When Codex uses tools, there may be multiple item.completed events with
      // agent_message type, and the response text may be spread across them.
      let agentMessageText = '';

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Accumulate text from agent_message items which contain the AI response
          // Multiple agent_message events can occur when Codex uses tools
          if (event.type === 'item.completed' &&
              event.item?.type === 'agent_message' &&
              event.item?.text) {
            agentMessageText += event.item.text;
          }
        } catch (lineError) {
          // Skip malformed lines
          logger.debug(`${levelPrefix} Skipping malformed JSONL line: ${line.substring(0, 100)}`);
        }
      }

      if (agentMessageText) {
        // The accumulated agent_message text contains the AI's response
        // Try to extract JSON from it (the AI was asked to output JSON)
        logger.debug(`${levelPrefix} Extracted ${agentMessageText.length} chars of agent message text from JSONL`);
        const extracted = extractJSON(agentMessageText, level, levelPrefix);
        if (extracted.success) {
          return extracted;
        }

        // If no JSON found, return with textContent so the caller can
        // pass it (not raw JSONL stdout) to the LLM extraction fallback
        logger.warn(`${levelPrefix} Agent message is not JSON, treating as raw text`);
        return { success: false, error: 'Agent message is not valid JSON', textContent: agentMessageText };
      }

      // No agent message found, try extracting JSON directly from stdout
      const extracted = extractJSON(stdout, level, levelPrefix);
      return extracted;

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
   * Log a streaming JSONL line for debugging visibility
   * Codex JSONL format event types:
   * - thread.started: Session info
   * - turn.started: Turn begins
   * - item.completed: Contains reasoning, agent_message, or tool items
   * - turn.completed: Turn ends with usage stats
   *
   * Uses logger.streamDebug() which only logs when --debug-stream flag is enabled.
   *
   * @param {string} line - A single JSONL line
   * @param {number} lineNum - Line number for reference
   * @param {string} levelPrefix - Logging prefix
   */
  logStreamLine(line, lineNum, levelPrefix) {
    // Check stream debug status - branches exit early if disabled
    const streamEnabled = logger.isStreamDebugEnabled();

    try {
      const event = JSON.parse(line);
      const eventType = event.type;

      if (eventType === 'thread.started') {
        if (!streamEnabled) return;
        const threadId = event.thread_id || '';
        const idPart = threadId ? ` thread=${threadId.substring(0, 12)}` : '';
        logger.streamDebug(`${levelPrefix} [#${lineNum}] thread.started${idPart}`);

      } else if (eventType === 'turn.started') {
        if (!streamEnabled) return;
        const turnId = event.turn_id || '';
        const idPart = turnId ? ` turn=${turnId.substring(0, 8)}` : '';
        logger.streamDebug(`${levelPrefix} [#${lineNum}] turn.started${idPart}`);

      } else if (eventType === 'item.completed') {
        const item = event.item || {};
        const itemType = item.type || 'unknown';

        if (itemType === 'agent_message') {
          // Agent message - this is the AI's text response
          const text = item.text || '';
          if (text && streamEnabled) {
            const preview = text.replace(/\n/g, '\\n').substring(0, 60);
            logger.streamDebug(`${levelPrefix} [#${lineNum}] agent_message: ${preview}${text.length > 60 ? '...' : ''}`);
          } else if (streamEnabled) {
            logger.streamDebug(`${levelPrefix} [#${lineNum}] agent_message (empty)`);
          }

        } else if (itemType === 'function_call' || itemType === 'tool_call' || itemType === 'tool_use') {
          if (!streamEnabled) return;
          // Tool/function call - extract name and input
          const toolName = item.name || item.tool || 'unknown';
          const toolId = item.id || item.call_id || '';
          const toolArgs = item.arguments || item.input || item.args || null;

          let argsPreview = '';
          if (toolArgs) {
            // Try to parse if it's a string (Codex often stringifies arguments)
            let parsedArgs = toolArgs;
            if (typeof toolArgs === 'string') {
              try {
                parsedArgs = JSON.parse(toolArgs);
              } catch {
                parsedArgs = toolArgs;
              }
            }

            if (typeof parsedArgs === 'string') {
              argsPreview = parsedArgs.length > 50 ? parsedArgs.substring(0, 50) + '...' : parsedArgs;
            } else if (typeof parsedArgs === 'object' && parsedArgs !== null) {
              const keys = Object.keys(parsedArgs);
              if (parsedArgs.command) {
                const cmd = parsedArgs.command;
                argsPreview = `cmd="${cmd.substring(0, 50)}${cmd.length > 50 ? '...' : ''}"`;
              } else if (parsedArgs.file_path || parsedArgs.path) {
                argsPreview = `path="${parsedArgs.file_path || parsedArgs.path}"`;
              } else if (keys.length === 1 && typeof parsedArgs[keys[0]] === 'string') {
                const val = parsedArgs[keys[0]];
                argsPreview = `${keys[0]}="${val.length > 40 ? val.substring(0, 40) + '...' : val}"`;
              } else if (keys.length > 0) {
                argsPreview = `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}}`;
              }
            }
          }

          const idPart = toolId ? ` [${toolId.substring(0, 8)}]` : '';
          const argsPart = argsPreview ? ` ${argsPreview}` : '';
          logger.streamDebug(`${levelPrefix} [#${lineNum}] tool_call: ${toolName}${idPart}${argsPart}`);

        } else if (itemType === 'function_call_output' || itemType === 'tool_result') {
          if (!streamEnabled) return;
          // Tool result
          const toolId = item.call_id || item.tool_use_id || item.id || '';
          const output = item.output || item.result || item.content || '';
          const isError = item.is_error || item.error || false;

          let resultPreview = '';
          if (typeof output === 'string' && output.length > 0) {
            resultPreview = output.length > 60 ? output.substring(0, 60) + '...' : output;
            resultPreview = resultPreview.replace(/\n/g, '\\n');
          }

          const idPart = toolId ? ` [${toolId.substring(0, 8)}]` : '';
          const statusPart = isError ? ' ERROR' : ' OK';
          const previewPart = resultPreview ? ` ${resultPreview}` : '';
          logger.streamDebug(`${levelPrefix} [#${lineNum}] tool_result${idPart}${statusPart}${previewPart}`);

        } else if (itemType === 'reasoning') {
          if (!streamEnabled) return;
          // Reasoning item - show brief summary
          const summary = item.summary || '';
          const preview = summary ? summary.substring(0, 50) : '';
          logger.streamDebug(`${levelPrefix} [#${lineNum}] reasoning: ${preview}${summary.length > 50 ? '...' : ''}`);

        } else if (streamEnabled) {
          // Other item types
          logger.streamDebug(`${levelPrefix} [#${lineNum}] item.completed (${itemType})`);
        }

      } else if (eventType === 'turn.completed') {
        // Turn completed - always log this at info level for summary
        const usage = event.usage || {};
        const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
        const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
        const totalTokens = usage.total_tokens || (inputTokens + outputTokens);

        logger.info(`${levelPrefix} [turn.completed] tokens: ${inputTokens}in/${outputTokens}out (total: ${totalTokens})`);

      } else if (eventType && streamEnabled) {
        // Unknown event type - only log if we have an actual type and stream debug is on
        logger.streamDebug(`${levelPrefix} [#${lineNum}] ${eventType}`);
      }
      // Silently ignore events with no type

    } catch (parseError) {
      if (streamEnabled) {
        // Skip malformed lines
        logger.streamDebug(`${levelPrefix} [#${lineNum}] (malformed: ${line.substring(0, 50)}${line.length > 50 ? '...' : ''})`);
      }
    }
  }

  /**
   * Build args for Codex CLI extraction, applying provider and model extra_args.
   * This ensures consistent arg construction for getExtractionConfig().
   *
   * Note: For extraction, we use minimal sandbox (read-only) since we don't need
   * shell commands for JSON extraction.
   *
   * @param {string} model - The model identifier to use
   * @returns {string[]} Complete args array for the CLI
   */
  buildArgsForModel(model) {
    // Resolve cli_model + merged extra_args so reasoning-effort variants behave
    // the same for extraction as they do for the main analysis call.
    const { cliModel, extraArgs } = this._resolveModelConfig(model);

    // Base args for extraction (read-only sandbox, no shell access needed)
    // Note: '-' (stdin marker) must come LAST, after any extra_args
    const baseArgs = ['exec', '-m', cliModel, '--json', '--sandbox', 'read-only'];

    // Append stdin marker '-' at the end after all other args
    return [...baseArgs, ...extraArgs, '-'];
  }

  /**
   * Get CLI configuration for LLM extraction
   * @param {string} model - The model to use for extraction
   * @returns {Object} Configuration for spawning extraction process
   */
  getExtractionConfig(model) {
    // Use the already-resolved command from the constructor (this.codexCmd)
    // which respects: ENV > config > default precedence
    const codexCmd = this.codexCmd;
    const useShell = this.useShell;

    // Build args consistently using the shared method, applying provider and model extra_args
    const args = this.buildArgsForModel(model);
    // Surface merged env (built-in + provider + per-model) so the extraction
    // spawn matches the contract used by other providers.
    const { env } = this._resolveModelConfig(model);

    if (useShell) {
      return {
        command: `${codexCmd} ${quoteShellArgs(args).join(' ')}`,
        args: [],
        useShell: true,
        promptViaStdin: true,
        env
      };
    }
    return {
      command: codexCmd,
      args,
      useShell: false,
      promptViaStdin: true,
      env
    };
  }

  /**
   * Test if Codex CLI is available
   * Uses fast `--version` check instead of running a prompt.
   * Uses the command configured in the instance (respects ENV > config > default precedence)
   * @param {number} [timeoutMs=10000] - Timeout in milliseconds for the probe
   * @returns {Promise<boolean>}
   */
  async testAvailability(timeoutMs = 10000) {
    return new Promise((resolve) => {
      // For availability test, we just need to check --version
      // Use the already-resolved command from the constructor (this.codexCmd)
      // which respects: ENV > config > default precedence
      const useShell = this.useShell;
      const command = useShell ? `${this.codexCmd} --version` : this.codexCmd;
      const args = useShell ? [] : ['--version'];

      // Log the actual command for debugging config/override issues
      const fullCmd = useShell ? command : `${command} ${args.join(' ')}`;
      logger.debug(`Codex availability check: ${fullCmd}`);

      const codex = spawn(command, args, {
        env: {
          ...process.env,
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
        logger.warn(`Codex CLI availability check timed out after ${Math.round(timeoutMs / 1000)}s`);
        // Not `shell: useShell`: the probe spawn is not `detached`, so
        // group-kill would ESRCH and leave the child running.
        killChildSafely(codex, { logPrefix: '[availability]' });
        resolve(false);
      }, timeoutMs);

      codex.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      codex.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      codex.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        if (code === 0) {
          logger.info(`Codex CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          const stderrMsg = stderr.trim() ? `: ${stderr.trim()}` : '';
          logger.warn(`Codex CLI not available or returned unexpected output (exit code ${code})${stderrMsg}`);
          resolve(false);
        }
      });

      codex.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        logger.warn(`Codex CLI not available: ${error.message}`);
        resolve(false);
      });
    });
  }

  static getProviderName() {
    return 'Codex';
  }

  static getProviderId() {
    return 'codex';
  }

  static getModels() {
    return CODEX_MODELS;
  }

  static getInstallInstructions() {
    return 'Install Codex CLI: npm install -g @openai/codex\n' +
           'Or visit: https://github.com/openai/codex';
  }
}

// Register this provider
registerProvider('codex', CodexProvider);

module.exports = CodexProvider;
