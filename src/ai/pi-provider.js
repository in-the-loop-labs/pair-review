// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Pi AI Provider
 *
 * Implements the AI provider interface for the Pi coding agent CLI.
 * Uses `pi -p --mode json` for non-interactive execution with structured output.
 *
 * Pi outputs JSONL with event types: session, turn_start, message_start,
 * message_update, message_end, tool_execution_start/update/end, etc.
 * Text content is extracted from message_end events which contain the
 * complete assistant message with content blocks.
 *
 * The process lifecycle (spawn/parse/abort/timeout) is shared with the OMP
 * provider via PiStyleProvider (pi-style-provider.js); this file defines
 * Pi's CLI surface: argv construction, model resolution, and env merging.
 *
 * Pi provides built-in analysis modes (default, multi-model) and supports
 * additional models via config.providers.pi.models in ~/.pair-review/config.json.
 * User-configured models can use `provider/model` format (e.g., 'google/gemini-2.5-flash')
 * for cross-provider switching, which translates to `--provider <provider> --model <model>`.
 */

const path = require('path');
const { registerProvider } = require('./provider');
const { PiStyleProvider } = require('./pi-style-provider');

// Path to the bundled Pi task extension, which provides a generic subagent tool
// for delegating work to isolated pi subprocesses during analysis
const TASK_EXTENSION_DIR = path.join(__dirname, '..', '..', '.pi', 'extensions', 'task');

// Path to the review model guidance skill, which teaches Pi to select
// appropriate models for different review tasks (bug finding, security, etc.)
const REVIEW_SKILL_PATH = path.join(__dirname, '..', '..', '.pi', 'skills', 'review-model-guidance', 'SKILL.md');

// Path to the review roulette skill, which runs three random premium models
// in parallel for diverse multi-perspective code review
const ROULETTE_SKILL_PATH = path.join(__dirname, '..', '..', '.pi', 'skills', 'review-roulette', 'SKILL.md');

/**
 * Pi model definitions
 *
 * Pi delegates model selection to the user's Pi configuration (~/.pi/).
 * These entries define analysis modes rather than specific models:
 * - 'default' uses whatever model the user has configured as their Pi default
 * - 'multi-model' loads the review guidance skill, teaching Pi to autonomously
 *    switch between models for different review tasks
 * - 'review-roulette' loads the roulette skill, running three random premium
 *    models in parallel for diverse multi-perspective review
 *
 * Users can also add specific models via config.json providers.pi.models.
 * Use `provider/model` format in cli_model for cross-provider switching
 * (e.g., 'google/gemini-2.5-flash' becomes --provider google --model gemini-2.5-flash).
 */
const PI_MODELS = [
  {
    id: 'default',
    cli_model: null,
    name: 'Default',
    tier: 'balanced',
    tagline: 'Your Pi Default',
    description: 'Uses your configured Pi default model',
    badge: 'Default',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'multi-model',
    cli_model: null,
    name: 'Multi-Model',
    tier: 'thorough',
    tagline: 'Smart Routing',
    description: 'Pi autonomously selects the best model for each review task',
    badge: 'Smart Routing',
    badgeClass: 'badge-power',
    extra_args: ['--thinking', 'high', '--skill', REVIEW_SKILL_PATH]
  },
  {
    id: 'review-roulette',
    cli_model: null,
    name: 'Review Roulette',
    tier: 'thorough',
    tagline: '3× Reasoning',
    description: 'Three random premium models review your changes in parallel',
    badge: 'Surprise',
    badgeClass: 'badge-power',
    extra_args: ['--thinking', 'high', '--skill', ROULETTE_SKILL_PATH],
    env: { PI_TASK_MAX_DEPTH: '2' }
  }
];

class PiProvider extends PiStyleProvider {
  /**
   * @param {string|null} [model='default'] - Model identifier or null/undefined for default mode
   * @param {Object} configOverrides - Config overrides from providers config
   * @param {string} configOverrides.command - Custom CLI command
   * @param {string[]} configOverrides.extra_args - Additional CLI arguments
   * @param {Object} configOverrides.env - Additional environment variables
   * @param {Object[]} configOverrides.models - Custom model definitions
   * @param {boolean} [configOverrides.load_skills=true] - When false, adds --no-skills to suppress skill auto-discovery
   * @param {boolean} [configOverrides.app_extensions=true] - When false, omits the -e task extension flag
   */
  constructor(model, configOverrides = {}) {
    super(model || 'default');

    // Store config overrides early so _resolveCliModelArgs can use them
    this.configOverrides = configOverrides;

    // Resolve model configuration from built-in definitions and config overrides
    const resolvedModel = model || 'default';
    const builtIn = PI_MODELS.find(m => m.id === resolvedModel);
    const configModel = configOverrides.models?.find(m => m.id === resolvedModel);

    // Conditionally include --model (null = suppress, let Pi use its default)
    const cliModelArgs = this._resolveCliModelArgs(resolvedModel);

    // Command precedence: ENV > config > default
    const envCmd = process.env.PAIR_REVIEW_PI_CMD;
    const configCmd = configOverrides.command;
    const piCmd = envCmd || configCmd || 'pi';

    // For multi-word commands, use shell mode
    this.useShell = piCmd.includes(' ');

    // ============================================================================
    // SECURITY: Pi CLI tool permissions
    // ============================================================================
    //
    // Pi's --tools flag controls which built-in tools are available to the model.
    // When --tools is specified, ONLY the listed tools are loaded; unlisted tools
    // (edit, write) are not available at all — they cannot be requested or executed.
    //
    // Enabled tools: read, bash, grep, find, ls
    // Excluded tools: edit, write (file modification)
    //
    // Task extension: The `task` tool is loaded via `-e` as a Pi extension,
    // not via --tools. Subtasks spawned by the extension inherit the same
    // tool restrictions from the parent process environment.
    //
    // LIMITATION: The `bash` tool grants arbitrary shell command execution.
    // Unlike Claude (Bash(git diff*) prefixes) or Copilot (shell(git diff) prefixes),
    // Pi does not support fine-grained bash command restrictions. The model could
    // theoretically execute destructive commands (rm, git push, etc.).
    //
    // MITIGATION STRATEGY:
    // 1. Prompt engineering: Analysis prompts explicitly instruct the AI to only
    //    use read-only operations and never modify files
    // 2. Worktree isolation: Analysis runs in a git worktree, limiting blast radius
    // 3. Tool exclusion: edit and write tools are not loaded at all
    //
    // If Pi CLI adds prefix-based bash restrictions in the future, they should
    // be adopted here to match the granularity of other providers.
    // ============================================================================

    // pi -p --mode json --model <model> --tools read,bash,grep,find,ls <prompt-via-stdin>
    // -p: Non-interactive mode (process prompt and exit)
    // --mode json: Output JSONL events
    // --model: Specify the model (omitted when cli_model is null to use Pi's default)
    // --tools: Enable read-only tools for Level 2/3 analysis (excludes edit,write for safety).
    //          The task extension is loaded separately via `-e` (not part of --tools).
    // --no-session: Each pi invocation is an ephemeral analysis — there's no need to
    //               persist session state between runs. Set PAIR_REVIEW_PI_SESSION=1
    //               to enable session saving for debugging (sessions saved to ~/.pi/sessions/).
    // Build args: base args + built-in extra_args + provider extra_args + model extra_args
    // In yolo mode, omit --tools entirely to allow all tools (including edit, write)
    // The task extension is loaded to give the model a subagent tool for delegating
    // work to isolated subprocesses, preserving the main context window.
    // --no-prompt-templates: prompt templates can't be triggered in -p mode, so suppress
    // them to avoid wasting context.
    // load_skills (default true): when false, adds --no-skills to suppress auto-discovery.
    //   Explicit --skill args from built-in models (e.g. multi-model) still load.
    // app_extensions (default true): when false, omits the -e task extension flag.
    //   Useful when auto-discovery already loads the extension (e.g. developing pair-review).
    const loadSkills = configOverrides.load_skills !== false;
    const appExtensions = configOverrides.app_extensions !== false;
    const sessionArgs = process.env.PAIR_REVIEW_PI_SESSION ? [] : ['--no-session'];
    const extensionArgs = appExtensions ? ['-e', TASK_EXTENSION_DIR] : [];
    const skillArgs = loadSkills ? [] : ['--no-skills'];
    let baseArgs;
    if (configOverrides.yolo) {
      baseArgs = ['-p', '--mode', 'json', ...cliModelArgs, ...sessionArgs,
        '--no-prompt-templates',
        ...extensionArgs, ...skillArgs];
    } else {
      baseArgs = ['-p', '--mode', 'json', ...cliModelArgs, '--tools', 'read,bash,grep,find,ls', ...sessionArgs,
        '--no-prompt-templates',
        ...extensionArgs, ...skillArgs];
    }
    const builtInArgs = builtIn?.extra_args || [];
    const providerArgs = configOverrides.extra_args || [];
    const modelArgs = configModel?.extra_args || [];

    // Store base command (used by the shared execute/extraction/availability
    // paths in PiStyleProvider) and args (prompt added in execute)
    this.cliCmd = piCmd;
    this.cliName = 'Pi';
    this.extraEnv = this._resolveEnvForModel(resolvedModel);
    this.baseArgs = [...baseArgs, ...builtInArgs, ...providerArgs, ...modelArgs];
  }

  /**
   * Resolve the extra env vars for a given model.
   * Merge order: defaults → built-in model → provider config → per-model config.
   * Later entries override earlier ones, so model-specific settings (e.g.,
   * review-roulette's PI_TASK_MAX_DEPTH=2) take precedence over defaults.
   *
   * PI_CMD tells the task extension how to invoke pi for subtasks.
   * This is essential when pi is invoked through a wrapper (e.g., 'devx pi --').
   *
   * Used both by the constructor (analysis model) and by the shared
   * getExtractionConfig() (extraction model), so the extraction fallback picks
   * up env configured on its own (possibly fast-tier) model.
   *
   * @param {string} modelId - Model identifier
   * @returns {Object} Env vars to merge into the child environment
   */
  _resolveEnvForModel(modelId) {
    const builtIn = PI_MODELS.find(m => m.id === modelId);
    const configModel = this.configOverrides?.models?.find(m => m.id === modelId);
    return {
      PI_TASK_MAX_DEPTH: '1',
      ...(builtIn?.env || {}),
      ...(this.configOverrides?.env || {}),
      ...(configModel?.env || {}),
      PI_CMD: this.cliCmd
    };
  }

  /**
   * Resolve the --model (and optionally --provider) CLI arguments for a given model ID.
   * Checks config model overrides, then built-in definitions, then falls back to the raw ID.
   * Returns an empty array when cli_model is null (Pi uses its configured default).
   * Supports `provider/model` format (e.g., 'google/gemini-2.5-flash') which produces
   * ['--provider', 'google', '--model', 'gemini-2.5-flash'] for cross-provider switching.
   *
   * @param {string|null} modelId - Model identifier
   * @returns {string[]} CLI arguments (e.g., ['--model', 'x'], ['--provider', 'p', '--model', 'm'], or [])
   */
  _resolveCliModelArgs(modelId) {
    const builtIn = PI_MODELS.find(m => m.id === modelId);
    const configModel = this.configOverrides?.models?.find(m => m.id === modelId);
    const resolvedCliModel = configModel?.cli_model !== undefined
      ? configModel.cli_model
      : (builtIn?.cli_model !== undefined ? builtIn.cli_model : modelId);
    if (resolvedCliModel === null) return [];
    // Support provider/model format (e.g., 'google/gemini-2.5-flash')
    if (typeof resolvedCliModel === 'string' && resolvedCliModel.includes('/')) {
      const [provider, ...rest] = resolvedCliModel.split('/');
      return ['--provider', provider, '--model', rest.join('/')];
    }
    return ['--model', resolvedCliModel];
  }

  /**
   * Build args for Pi CLI execution, applying provider and model extra_args.
   * This ensures consistent arg construction for both execute() and getExtractionConfig().
   *
   * @param {string} model - The model identifier to use
   * @returns {string[]} Complete args array for the CLI
   */
  buildArgsForModel(model) {
    const cliModelArgs = this._resolveCliModelArgs(model);

    // Note: built-in extra_args (e.g., --skill for multi-model) are intentionally
    // excluded for extraction. Extraction is a simple JSON-parsing task that doesn't
    // need skills or other analysis-specific configuration.

    // Base args for pi non-interactive JSON mode (extraction only -- no tools needed).
    // load_skills: mirror the analysis run — when the user disabled skill
    // auto-discovery, the extraction fallback must not re-enable it.
    const sessionArgs = process.env.PAIR_REVIEW_PI_SESSION ? [] : ['--no-session'];
    const skillArgs = this.configOverrides?.load_skills === false ? ['--no-skills'] : [];
    const baseArgs = ['-p', '--mode', 'json', ...cliModelArgs, '--no-tools', ...sessionArgs, ...skillArgs];
    const configModel = this.configOverrides?.models?.find(m => m.id === model);
    const providerArgs = this.configOverrides?.extra_args || [];
    const modelArgs = configModel?.extra_args || [];
    return [...baseArgs, ...providerArgs, ...modelArgs];
  }

  static getProviderName() {
    return 'Pi';
  }

  static getProviderId() {
    return 'pi';
  }

  static getModels() {
    return PI_MODELS;
  }

  static getDefaultModel() {
    const defaultModel = PI_MODELS.find(m => m.default);
    return defaultModel ? defaultModel.id : null;
  }

  static getInstallInstructions() {
    return 'Install Pi: npm install -g @mariozechner/pi-coding-agent\n' +
           'Or visit: https://github.com/badlogic/pi-mono';
  }

  /** Default timeout in ms (15 minutes) — Pi is slower than most providers */
  static defaultTimeout = 900000;
}

// Register this provider
registerProvider('pi', PiProvider);

module.exports = PiProvider;
