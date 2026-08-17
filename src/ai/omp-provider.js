// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * OMP (Oh My Pi) AI Provider
 *
 * Implements the AI provider interface for the OMP coding agent CLI, a fork
 * of the Pi coding agent. Uses `omp -p --mode json` for non-interactive
 * execution with structured output.
 *
 * OMP emits the same JSONL event stream as Pi (session, turn_start,
 * message_start, message_update, message_end, tool_execution_start/update/end,
 * agent_end, etc.), so parsing is shared with the Pi provider via pi-format.js
 * and the process lifecycle (spawn/parse/abort/timeout) via PiStyleProvider
 * (pi-style-provider.js). This file defines OMP's CLI surface: argv
 * construction, model resolution, and env merging.
 *
 * Differences from the Pi provider:
 * - Model selection: OMP's --model accepts fuzzy matches and full
 *   `provider/model` strings directly (--provider is legacy), so cli_model
 *   values are passed to --model verbatim instead of being split.
 * - Advisor runtime: OMP can passively review each turn and inject notes
 *   (advisor.enabled in ~/.omp/agent/config.yml). Reviews disable it by
 *   default via a bundled --config overlay; set `"advisor": true` in
 *   config.json providers.omp to opt in (passes --advisor instead).
 * - Tools: OMP's read-only tool set is read,bash,grep,glob (no find/ls).
 * - No bundled task extension or --no-prompt-templates flag (Pi-specific).
 *
 * OMP provides a 'default' analysis mode and supports additional models via
 * config.providers.omp.models in ~/.pair-review/config.json.
 */

const path = require('path');
const { registerProvider } = require('./provider');
const { PiStyleProvider } = require('./pi-style-provider');

// Config overlay that disables the advisor runtime for review runs.
// Loaded with `--config`, which merges on top of ~/.omp/agent/config.yml,
// so reviews stay deterministic even when the user enables the advisor
// globally. There is no --no-advisor flag, so the overlay is the only
// per-run off switch.
const REVIEW_CONFIG_OVERLAY_PATH = path.join(__dirname, 'omp', 'review-config.yml');

/**
 * OMP model definitions
 *
 * OMP delegates model selection to the user's OMP configuration
 * (~/.omp/agent/config.yml). The built-in 'default' entry uses whatever model
 * the user has configured as their OMP default.
 *
 * Users can add specific models via config.json providers.omp.models.
 * cli_model values are passed verbatim to --model, which fuzzy-matches
 * ("opus", "gpt-5.2") and accepts full `provider/model` strings
 * (e.g., 'anthropic/claude-opus-5'). Run `omp models` to list the catalog.
 */
const OMP_MODELS = [
  {
    id: 'default',
    cli_model: null,
    name: 'Default',
    tier: 'balanced',
    tagline: 'Your OMP Default',
    description: 'Uses your configured OMP default model',
    badge: 'Default',
    badgeClass: 'badge-recommended',
    default: true
  }
];

class OmpProvider extends PiStyleProvider {
  /**
   * @param {string|null} [model='default'] - Model identifier or null/undefined for default mode
   * @param {Object} configOverrides - Config overrides from providers config
   * @param {string} configOverrides.command - Custom CLI command
   * @param {string[]} configOverrides.extra_args - Additional CLI arguments
   * @param {Object} configOverrides.env - Additional environment variables
   * @param {Object[]} configOverrides.models - Custom model definitions
   * @param {boolean} [configOverrides.load_skills=true] - When false, adds --no-skills to suppress skill auto-discovery
   * @param {boolean} [configOverrides.advisor=false] - When true, enables OMP's advisor runtime
   *   (--advisor) instead of disabling it via the bundled config overlay
   */
  constructor(model, configOverrides = {}) {
    super(model || 'default');

    // Store config overrides early so _resolveCliModelArgs can use them
    this.configOverrides = configOverrides;

    // Resolve model configuration from built-in definitions and config overrides
    const resolvedModel = model || 'default';
    const builtIn = OMP_MODELS.find(m => m.id === resolvedModel);
    const configModel = configOverrides.models?.find(m => m.id === resolvedModel);

    // Conditionally include --model (null = suppress, let OMP use its default)
    const cliModelArgs = this._resolveCliModelArgs(resolvedModel);

    // Command precedence: ENV > config > default
    const envCmd = process.env.PAIR_REVIEW_OMP_CMD;
    const configCmd = configOverrides.command;
    const ompCmd = envCmd || configCmd || 'omp';

    // For multi-word commands, use shell mode
    this.useShell = ompCmd.includes(' ');

    // ============================================================================
    // SECURITY: OMP CLI tool permissions
    // ============================================================================
    //
    // OMP's --tools flag controls which built-in tools are available to the model.
    // When --tools is specified, ONLY the listed tools are loaded; unlisted tools
    // (edit, write) are not available at all — they cannot be requested or executed.
    // MCP tools configured in the user's OMP setup are likewise excluded because
    // they are not on the allowlist.
    //
    // Enabled tools: read, bash, grep, glob
    // Excluded tools: edit, write (file modification), task, MCP tools
    //
    // LIMITATION: The `bash` tool grants arbitrary shell command execution.
    // Unlike Claude (Bash(git diff*) prefixes) or Copilot (shell(git diff) prefixes),
    // OMP does not support fine-grained bash command restrictions. The model could
    // theoretically execute destructive commands (rm, git push, etc.).
    //
    // MITIGATION STRATEGY:
    // 1. Prompt engineering: Analysis prompts explicitly instruct the AI to only
    //    use read-only operations and never modify files
    // 2. Worktree isolation: Analysis runs in a git worktree, limiting blast radius
    // 3. Tool exclusion: edit and write tools are not loaded at all
    //
    // If OMP CLI adds prefix-based bash restrictions in the future, they should
    // be adopted here to match the granularity of other providers.
    // ============================================================================

    // omp -p --mode json --model <model> --tools read,bash,grep,glob <prompt-via-@file>
    // -p: Non-interactive mode (process prompt and exit)
    // --mode json: Output JSONL events
    // --model: Specify the model (omitted when cli_model is null to use OMP's default)
    // --tools: Enable read-only tools for Level 2/3 analysis (excludes edit,write for safety)
    // --no-session: Each omp invocation is an ephemeral analysis — there's no need to
    //               persist session state between runs. Set PAIR_REVIEW_OMP_SESSION=1
    //               to enable session saving for debugging (sessions saved under ~/.omp/).
    // Advisor: disabled by default via the bundled --config overlay (see
    //   REVIEW_CONFIG_OVERLAY_PATH); configOverrides.advisor === true opts in via --advisor.
    // Build args: base args + built-in extra_args + provider extra_args + model extra_args
    // In yolo mode, omit --tools entirely to allow all tools (including edit, write)
    // load_skills (default true): when false, adds --no-skills to suppress skill
    //   auto-discovery.
    const loadSkills = configOverrides.load_skills !== false;
    const sessionArgs = process.env.PAIR_REVIEW_OMP_SESSION ? [] : ['--no-session'];
    const skillArgs = loadSkills ? [] : ['--no-skills'];
    const advisorArgs = configOverrides.advisor === true
      ? ['--advisor']
      : ['--config', REVIEW_CONFIG_OVERLAY_PATH];
    let baseArgs;
    if (configOverrides.yolo) {
      baseArgs = ['-p', '--mode', 'json', ...cliModelArgs, ...sessionArgs,
        ...advisorArgs, ...skillArgs];
    } else {
      baseArgs = ['-p', '--mode', 'json', ...cliModelArgs, '--tools', 'read,bash,grep,glob',
        ...sessionArgs, ...advisorArgs, ...skillArgs];
    }
    const builtInArgs = builtIn?.extra_args || [];
    const providerArgs = configOverrides.extra_args || [];
    const modelArgs = configModel?.extra_args || [];

    // Store base command (used by the shared execute/extraction/availability
    // paths in PiStyleProvider) and args (prompt added in execute)
    this.cliCmd = ompCmd;
    this.cliName = 'OMP';
    this.extraEnv = this._resolveEnvForModel(resolvedModel);
    this.baseArgs = [...baseArgs, ...builtInArgs, ...providerArgs, ...modelArgs];
  }

  /**
   * Resolve the extra env vars for a given model.
   * Merge order: built-in model → provider config → per-model config.
   * Later entries override earlier ones, so model-specific settings take
   * precedence over provider-level ones. Unlike Pi, no task-extension env
   * vars (PI_CMD, PI_TASK_MAX_DEPTH) are set — OMP has no bundled extension.
   *
   * Used both by the constructor (analysis model) and by the shared
   * getExtractionConfig() (extraction model), so the extraction fallback picks
   * up env configured on its own (possibly fast-tier) model.
   *
   * @param {string} modelId - Model identifier
   * @returns {Object} Env vars to merge into the child environment
   */
  _resolveEnvForModel(modelId) {
    const builtIn = OMP_MODELS.find(m => m.id === modelId);
    const configModel = this.configOverrides?.models?.find(m => m.id === modelId);
    return {
      ...(builtIn?.env || {}),
      ...(this.configOverrides?.env || {}),
      ...(configModel?.env || {})
    };
  }

  /**
   * Resolve the --model CLI arguments for a given model ID.
   * Checks config model overrides, then built-in definitions, then falls back
   * to the raw ID. Returns an empty array when cli_model is null (OMP uses its
   * configured default).
   *
   * Unlike Pi, `provider/model` strings are passed to --model verbatim: OMP's
   * --model fuzzy-matches and accepts full provider-qualified names directly
   * (its --provider flag is legacy).
   *
   * @param {string|null} modelId - Model identifier
   * @returns {string[]} CLI arguments (e.g., ['--model', 'x'] or [])
   */
  _resolveCliModelArgs(modelId) {
    const builtIn = OMP_MODELS.find(m => m.id === modelId);
    const configModel = this.configOverrides?.models?.find(m => m.id === modelId);
    const resolvedCliModel = configModel?.cli_model !== undefined
      ? configModel.cli_model
      : (builtIn?.cli_model !== undefined ? builtIn.cli_model : modelId);
    if (resolvedCliModel === null) return [];
    return ['--model', resolvedCliModel];
  }

  /**
   * Build args for OMP CLI execution, applying provider and model extra_args.
   * This ensures consistent arg construction for both execute() and getExtractionConfig().
   *
   * @param {string} model - The model identifier to use
   * @returns {string[]} Complete args array for the CLI
   */
  buildArgsForModel(model) {
    const cliModelArgs = this._resolveCliModelArgs(model);

    // Note: built-in extra_args are intentionally excluded for extraction.
    // Extraction is a simple JSON-parsing task that doesn't need
    // analysis-specific configuration.

    // Base args for omp non-interactive JSON mode (extraction only — no tools needed).
    // The advisor overlay is always applied here: advisor notes cannot help a
    // JSON-parsing task, they only add cost, so extraction never opts in even
    // when configOverrides.advisor is true.
    // load_skills: mirror the analysis run — when the user disabled skill
    // auto-discovery, the extraction fallback must not re-enable it.
    const sessionArgs = process.env.PAIR_REVIEW_OMP_SESSION ? [] : ['--no-session'];
    const skillArgs = this.configOverrides?.load_skills === false ? ['--no-skills'] : [];
    const baseArgs = ['-p', '--mode', 'json', ...cliModelArgs, '--no-tools', ...sessionArgs,
      '--config', REVIEW_CONFIG_OVERLAY_PATH, ...skillArgs];
    const configModel = this.configOverrides?.models?.find(m => m.id === model);
    const providerArgs = this.configOverrides?.extra_args || [];
    const modelArgs = configModel?.extra_args || [];
    return [...baseArgs, ...providerArgs, ...modelArgs];
  }

  static getProviderName() {
    return 'OMP';
  }

  static getProviderId() {
    return 'omp';
  }

  static getModels() {
    return OMP_MODELS;
  }

  static getDefaultModel() {
    const defaultModel = OMP_MODELS.find(m => m.default);
    return defaultModel ? defaultModel.id : null;
  }

  static getInstallInstructions() {
    return 'Install OMP (Oh My Pi): npm install -g @oh-my-pi/pi-coding-agent\n' +
           'Or visit: https://github.com/can1357/oh-my-pi';
  }

  /** Default timeout in ms (15 minutes) — matches Pi, which OMP is a fork of */
  static defaultTimeout = 900000;
}

// Register this provider
registerProvider('omp', OmpProvider);

module.exports = OmpProvider;
// Test-only export. Underscore prefix signals an internal constant that should
// not be consumed from production code paths.
module.exports._REVIEW_CONFIG_OVERLAY_PATH = REVIEW_CONFIG_OVERLAY_PATH;
