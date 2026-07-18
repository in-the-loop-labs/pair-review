// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const logger = require('./utils/logger');

// Implementation matrix for per-area dispatch. Each operations module
// exports an `IMPLEMENTED_MODES` Set lifted from its dispatcher's if/else
// chain, so validateRepoConfig() and the dispatcher cannot drift.
const _stackWalkerOps = require('./github/operations/stack-walker');
const _pendingReviewOps = require('./github/operations/pending-review');
const _reviewLifecycleOps = require('./github/operations/review-lifecycle');
const _pendingReviewCommentsOps = require('./github/operations/pending-review-comments');
const IMPLEMENTATION_MATRIX = {
  stack_walker: _stackWalkerOps.IMPLEMENTED_MODES,
  pending_review_check: _pendingReviewOps.IMPLEMENTED_MODES,
  review_lifecycle: _reviewLifecycleOps.IMPLEMENTED_MODES,
  pending_review_comments: _pendingReviewCommentsOps.IMPLEMENTED_MODES
};

// Recognised `_endpoint` sub-keys. These ride alongside the area key in
// `features` (e.g. `pending_review_comments_endpoint`) and are validated
// separately from area modes. Listed explicitly so a typo like
// `pending_review_commentes_endpoint` is rejected at startup rather than
// silently ignored.
const KNOWN_ENDPOINT_SUBKEYS = new Set([
  'pending_review_comments_endpoint'
]);

let _cachedCommandToken = null;
// Per-(repository, command) cache for repo-scoped token_command shell-outs.
// Key format: `${repository ?? ""}|${command}`. Repo-aware resolution must
// not collapse different (repo, command) pairs to a single shared token,
// so we key on both. See plan Hazards: "Token caching across hosts".
const _cachedRepoTokens = new Map();

// Areas that have a GraphQL implementation in this codebase today. When
// `api_host` is unset, these default to "graphql"; all other areas default
// to "rest". When `api_host` is set, all areas default to "rest" regardless.
const FEATURE_AREAS = [
  'pending_review_check',
  'stack_walker',
  'review_lifecycle',
  'pending_review_comments'
];
const GRAPHQL_DEFAULT_AREAS = new Set([
  'pending_review_check',
  'stack_walker',
  'review_lifecycle',
  'pending_review_comments'
]);
const ALLOWED_FEATURE_VALUES = new Set(['graphql', 'rest', 'host']);

const CONFIG_DIR = path.join(os.homedir(), '.pair-review');
const DEFAULT_CHECKOUT_TIMEOUT_MS = 300000;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CONFIG_LOCAL_FILE = path.join(CONFIG_DIR, 'config.local.json');
const CONFIG_EXAMPLE_FILE = path.join(CONFIG_DIR, 'config.example.json');
const PACKAGE_ROOT = path.join(__dirname, '..');
const MANAGED_CONFIG_FILE = path.join(PACKAGE_ROOT, 'config.managed.json');

const DEFAULT_CONFIG = {
  github_token: "",
  github_token_command: "gh auth token",  // Shell command whose stdout is used as the GitHub token
  port: 7247,
  single_port: true,  // When true, reuse a single server on the configured port; new invocations delegate to the running server
  theme: "light",
  default_provider: "claude",  // AI provider: 'claude', 'antigravity', 'codex', 'copilot', 'opencode', 'cursor-agent', 'pi'
  default_model: "opus",       // Model within the provider (e.g., 'opus' for Claude, 'gemini-3.1-pro-low' for Antigravity)
  tours: {
    enabled: false,            // When true, the guided-tour feature is available (toolbar button visible, etc.)
    auto_generate: true,       // When true, a tour generation job is kicked off automatically on review load
    provider: "",              // Provider for agentic tour generation. Empty = falls back to summaries.provider, then default_provider
    model: ""                  // Model for tour generation. Empty = falls back to summaries.model resolution
  },
  summaries: {
    enabled: false,            // When true, the hunk-summaries feature is available (toolbar button + per-file toggles visible)
    auto_generate: true,       // When true, a summary generation job is kicked off automatically on review load
    provider: "",              // Provider for one-shot hunk summary AI tasks. Empty = falls back to default_provider
    model: "",                 // Model for hunk summary tasks. Empty = uses provider's fast-tier model, then default_model
    max_files: 50,             // Skip summary generation for reviews touching more than this many files (perf cap)
    max_lines_added: 3000      // Skip summary generation when the diff adds more than this many lines (perf cap)
  },
  worktree_retention_days: 7,
  review_retention_days: 21,
  dev_mode: false,  // When true, disables static file caching for development
  debug_stream: false,  // When true, logs AI provider streaming events (equivalent to --debug-stream CLI flag)
  db_name: "",  // Custom database filename (default: database.db). Useful for per-worktree isolation.
  yolo: false,  // When true, skips fine-grained AI provider permission setup (equivalent to --yolo CLI flag)
  enable_chat: true,  // When true, enables the chat panel feature (uses chat_provider)
  chat_provider: "pi",  // Chat provider: 'pi', 'copilot-acp', 'opencode-acp', 'cursor-acp', 'codex'
  comment_format: "legacy",  // Comment format preset or custom template for adopted suggestions
  chat: { enable_shortcuts: true, enter_to_send: true },  // Chat panel settings (enable_shortcuts: show action shortcut buttons, enter_to_send: Enter sends message instead of newline)
  providers: {},  // Custom AI analysis provider configurations (overrides built-in defaults)
  chat_providers: {},  // Custom chat provider configurations (overrides built-in defaults)
  repos: {},  // Repository configurations: { "owner/repo": { path: "~/path/to/clone" } }
  assisted_by_url: "https://github.com/in-the-loop-labs/pair-review",  // URL for "Review assisted by" footer link
  hooks: {},  // Hook commands per event: { "review.started": { "my_hook": { "command": "..." } } }
  enable_graphite: false,  // When true, shows Graphite links alongside GitHub links
  skip_update_notifier: false,  // When true, suppresses the "update available" notification on exit
  external_comments: false  // Opt-in: set to true to enable GitHub PR review-comment sync (External segment, refresh button, /api/reviews/*/external-comments routes)
};

/**
 * Validates port number
 * @param {number} port - Port number to validate
 * @returns {boolean} - True if valid
 */
function validatePort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/**
 * Recursively merges source into target for plain objects.
 * Arrays and scalars in source replace the corresponding value in target.
 * Null in source overwrites target. Returns a new object; inputs are not mutated.
 * @param {Object} target - Base object
 * @param {Object} source - Object to merge on top
 * @returns {Object} - Merged result
 */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return { ...source };

  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Gets a config value with fallback to legacy key names
 * Supports backwards compatibility without modifying the config file
 * @param {Object} config - Configuration object
 * @param {string} key - New key name
 * @param {string} legacyKey - Old key name (fallback)
 * @returns {*} - Value from new key, or legacy key if new key not present
 */
function getConfigValue(config, key, legacyKey) {
  if (key in config) {
    return config[key];
  }
  if (legacyKey && legacyKey in config) {
    logger.debug(`Using legacy config key "${legacyKey}" for "${key}"`);
    return config[legacyKey];
  }
  return undefined;
}

/**
 * Gets the default provider from config with legacy fallback
 * Checks 'default_provider' first, falls back to 'provider'
 * @param {Object} config - Configuration object
 * @returns {string} - Provider name
 */
function getDefaultProvider(config) {
  return getConfigValue(config, 'default_provider', 'provider') || DEFAULT_CONFIG.default_provider;
}

/**
 * Gets the default model from config with legacy fallback
 * Checks 'default_model' first, falls back to 'model'
 * @param {Object} config - Configuration object
 * @returns {string} - Model name
 */
function getDefaultModel(config) {
  return getConfigValue(config, 'default_model', 'model') || DEFAULT_CONFIG.default_model;
}

/**
 * Whether the summaries feature is enabled (toolbar button visible, kickoff allowed).
 * @param {Object} config - Configuration object
 * @returns {boolean}
 */
function getSummaryEnabled(config) {
  return Boolean(config && config.summaries && config.summaries.enabled === true);
}

/**
 * Whether summaries should auto-generate on review load. Defaults to true when
 * unset so the feature stays opt-out within the enabled flag.
 * @param {Object} config - Configuration object
 * @returns {boolean}
 */
function getSummaryAutoGenerate(config) {
  if (!config || !config.summaries) return true;
  return config.summaries.auto_generate !== false;
}

/**
 * Whether the tours feature is enabled (toolbar button visible, kickoff allowed).
 * @param {Object} config - Configuration object
 * @returns {boolean}
 */
function getTourEnabled(config) {
  return Boolean(config && config.tours && config.tours.enabled === true);
}

/**
 * Whether tours should auto-generate on review load. Defaults to true when
 * unset so the feature stays opt-out within the enabled flag.
 * @param {Object} config - Configuration object
 * @returns {boolean}
 */
function getTourAutoGenerate(config) {
  if (!config || !config.tours) return true;
  return config.tours.auto_generate !== false;
}

/**
 * Gets the summary provider for summary/tour generation
 * Falls back to default_provider when summaries.provider is not set
 * @param {Object} config - Configuration object
 * @returns {string} - Provider name
 */
function getSummaryProvider(config) {
  const explicit = config && config.summaries && config.summaries.provider;
  return explicit || getDefaultProvider(config);
}

/**
 * Gets the summary model for summary/tour generation
 * Resolution order: summaries.model → providerClass fast-tier → default_model
 * @param {Object} config - Configuration object
 * @param {Function} [providerClass] - Optional provider class with static getModels()
 * @returns {string} - Model name
 */
function getSummaryModel(config, providerClass = null) {
  const explicit = config && config.summaries && config.summaries.model;
  if (explicit) return explicit;
  if (providerClass && typeof providerClass.getModels === 'function') {
    const fast = providerClass.getModels().find(m => m.tier === 'fast');
    if (fast) return fast.id;
  }
  return getDefaultModel(config);
}

/**
 * Gets the provider for tour generation.
 * Resolution order: tours.provider → summaries.provider → default_provider
 * @param {Object} config - Configuration object
 * @returns {string} - Provider name
 */
function getTourProvider(config) {
  const explicit = config && config.tours && config.tours.provider;
  return explicit || getSummaryProvider(config);
}

/**
 * Gets the model for tour generation.
 * Resolution order: tours.model → summaries.model → providerClass fast-tier → default_model
 * @param {Object} config - Configuration object
 * @param {Function} [providerClass] - Optional provider class with static getModels()
 * @returns {string} - Model name
 */
function getTourModel(config, providerClass = null) {
  const explicit = config && config.tours && config.tours.model;
  if (explicit) return explicit;
  return getSummaryModel(config, providerClass);
}

/**
 * Copies the example config file to the user's config directory
 * @returns {Promise<boolean>} True if copied successfully, false if source doesn't exist
 */
async function copyExampleConfig() {
  const sourceExample = path.join(PACKAGE_ROOT, 'config.example.json');
  try {
    await fs.access(sourceExample);
    await fs.copyFile(sourceExample, CONFIG_EXAMPLE_FILE);
    logger.info(`Copied config.example.json to: ${CONFIG_EXAMPLE_FILE}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Source example file doesn't exist (shouldn't happen in normal install)
      logger.debug('config.example.json not found in package, skipping copy');
      return false;
    }
    // Log but don't fail for other errors
    logger.debug(`Failed to copy config.example.json: ${error.message}`);
    return false;
  }
}

/**
 * Ensures the config directory exists
 * @returns {Promise<boolean>} True if directory was newly created
 */
async function ensureConfigDir() {
  try {
    await fs.access(CONFIG_DIR);
    return false; // Directory already existed
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        await fs.mkdir(CONFIG_DIR, { recursive: true });
        logger.info(`Created config directory: ${CONFIG_DIR}`);
        // Copy example config to new directory
        await copyExampleConfig();
        return true; // Directory was newly created
      } catch (mkdirError) {
        if (mkdirError.code === 'EACCES' || mkdirError.code === 'EPERM') {
          logger.error(`Cannot create configuration directory at ~/.pair-review/`);
          process.exit(1);
        }
        throw mkdirError;
      }
    } else {
      throw error;
    }
  }
}

/**
 * Loads configuration from file or creates default
 * @returns {Promise<{config: Object, isFirstRun: boolean}>} Config and first-run flag
 */
async function loadConfig() {
  await ensureConfigDir();

  const localDir = path.join(process.cwd(), '.pair-review');
  const sources = [
    { path: MANAGED_CONFIG_FILE,                         label: 'managed config',       layerName: 'managed',       required: false },
    { path: CONFIG_FILE,                                label: 'global config',        layerName: 'config',        required: true  },
    { path: CONFIG_LOCAL_FILE,                           label: 'global local config',  layerName: 'config.local',  required: false },
    { path: path.join(localDir, 'config.json'),         label: 'project config',       layerName: 'project',       required: false },
    { path: path.join(localDir, 'config.local.json'),   label: 'project local config', layerName: 'project.local', required: false },
  ];

  let mergedConfig = { ...DEFAULT_CONFIG };
  let isFirstRun = false;
  let hasManagedConfig = false;

  // Per-layer raw data, ordered low->high precedence, for source attribution
  // by the global-settings service. Each layer holds the raw parsed file (NOT
  // the merged result) so a hasPath() walk can report the highest layer that
  // actually defined a given dot-path. The built-in defaults are the lowest
  // layer.
  const layers = [{ name: 'default', data: { ...DEFAULT_CONFIG } }];

  for (const source of sources) {
    try {
      const data = await fs.readFile(source.path, 'utf8');
      const parsed = JSON.parse(data);
      if (source.label === 'managed config' && Object.keys(parsed).length > 0) {
        hasManagedConfig = true;
      }
      layers.push({ name: source.layerName, data: parsed });
      mergedConfig = deepMerge(mergedConfig, parsed);
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (source.required && !hasManagedConfig) {
          // Global config doesn't exist — create it with defaults
          const config = { ...DEFAULT_CONFIG };
          await saveConfig(config);
          logger.debug(`Created default config file: ${CONFIG_FILE}`);
          isFirstRun = true;
        }
        // Optional files or managed-config-present: skip silently
      } else if (error instanceof SyntaxError) {
        if (source.required) {
          logger.error(`Invalid configuration file at ~/.pair-review/config.json`);
          process.exit(1);
        }
        logger.warn(`Malformed config at ${source.label}, skipping`);
      } else {
        throw error;
      }
    }
  }

  // Normalize legacy monorepos into one canonical repos map. Lowercase both
  // sides before merging so JS object identity matches DB COLLATE NOCASE.
  const lowercaseKeys = (obj) => {
    const out = {};
    for (const [key, value] of Object.entries(obj || {})) {
      out[key.toLowerCase()] = value;
    }
    return out;
  };
  const lowerMonorepos = lowercaseKeys(mergedConfig.monorepos);
  const lowerRepos = lowercaseKeys(mergedConfig.repos);
  mergedConfig.repos = deepMerge(lowerMonorepos, lowerRepos);
  delete mergedConfig.monorepos;

  // Validate per-repo config invariants. Throws on the first violation
  // so misconfiguration fails loudly at startup rather than at runtime.
  validateRepoConfig(mergedConfig);

  // PORT env var overrides all config layers (used by Preview and similar harnesses)
  if (process.env.PORT) {
    const envPort = Number(process.env.PORT);
    if (!validatePort(envPort)) {
      logger.error(`Invalid PORT env var "${process.env.PORT}" (must be an integer between 1024 and 65535)`);
      process.exit(1);
    }
    mergedConfig.port = envPort;
  }

  // Validate port
  if (!validatePort(mergedConfig.port)) {
    logger.error(`Invalid port number ${mergedConfig.port}`);
    process.exit(1);
  }

  // Load global instructions from ~/.pair-review/global-instructions.md
  const globalInstructionsPath = path.join(CONFIG_DIR, 'global-instructions.md');
  try {
    const content = await fs.readFile(globalInstructionsPath, 'utf-8');
    const trimmed = content.trim();
    if (trimmed) {
      mergedConfig.globalInstructions = trimmed;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn(`Could not read global instructions from ${globalInstructionsPath}: ${error.message}`);
    }
  }

  return { config: mergedConfig, isFirstRun, layers };
}

/**
 * Saves configuration to file
 * @param {Object} config - Configuration object to save
 */
async function saveConfig(config) {
  await ensureConfigDir();
  
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      logger.error(`Cannot create configuration directory at ~/.pair-review/`);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Gets the configuration directory path
 * @returns {string} - Config directory path
 */
function getConfigDir() {
  return CONFIG_DIR;
}

/**
 * Executes a shell command and returns its trimmed stdout as a token.
 * Returns '' on failure or empty output; logs warnings via the shared
 * logger.
 *
 * Results are cached in `_cachedRepoTokens` keyed on
 * `${repository ?? ""}|${command}` to avoid re-running expensive
 * helpers (e.g. `gh auth token`) on every API call while still
 * keeping per-repo tokens isolated.
 *
 * @param {string} command - Shell command to execute
 * @param {string|null|undefined} repository - Owner/repo for cache key (null for no-repo / top-level)
 * @param {string} logContext - Short label for log messages (e.g. "github_token_command", "repo:token_command")
 * @returns {string} - Token or empty string
 */
function _runTokenCommand(command, repository, logContext) {
  const cacheKey = `${repository ?? ''}|${command}`;
  if (_cachedRepoTokens.has(cacheKey)) {
    logger.debug(`Using token from ${logContext} (cached)`);
    return _cachedRepoTokens.get(cacheKey);
  }
  logger.debug(`Attempting token from ${logContext}: ${command}`);
  try {
    const result = childProcess.execSync(command, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    if (!result) {
      logger.warn(`${logContext} did not produce a token (command: ${command})`);
      return '';
    }
    logger.debug(`Using token from ${logContext}`);
    _cachedRepoTokens.set(cacheKey, result);
    return result;
  } catch (error) {
    logger.warn(`${logContext} failed (command: ${command}): ${error.message}`);
    return '';
  }
}

/**
 * Builds the `features` object for a host binding, filling in defaults.
 * Default value is "graphql" when `apiHost` is null AND a GraphQL impl
 * exists for that area; otherwise "rest". When `apiHost` is set, all
 * defaults shift to "rest", EXCEPT `pending_review_comments` which
 * defaults to "host" — the REST endpoint cannot reliably attach inline
 * comments to a pending review, so the host-extension contract is the
 * only supported alt-host mode (see docs/alt-host.md).
 *
 * @param {string|null} apiHost - Resolved api_host (null for github.com)
 * @param {Object} explicit - User-supplied features overrides
 * @returns {Object} - Features object with every known area populated
 */
function _resolveFeatures(apiHost, explicit) {
  const out = {};
  const overrides = (explicit && typeof explicit === 'object') ? explicit : {};
  for (const area of FEATURE_AREAS) {
    if (typeof overrides[area] === 'string') {
      out[area] = overrides[area];
      continue;
    }
    if (apiHost === null && GRAPHQL_DEFAULT_AREAS.has(area)) {
      out[area] = 'graphql';
    } else if (apiHost !== null && area === 'pending_review_comments') {
      // REST has no working pending-review comments path; default to
      // the host-extension contract for alt-hosts.
      out[area] = 'host';
    } else {
      out[area] = 'rest';
    }
  }
  // Preserve endpoint-override sub-keys (e.g. `pending_review_comments_endpoint`)
  // so the operations layer can read them at dispatch time. Validation of
  // these keys happens in `validateRepoConfig()` at startup.
  for (const [key, value] of Object.entries(overrides)) {
    if (key.endsWith('_endpoint') && typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Whether a repo config describes an *exclusive* alt-host repo — one whose
 * every PR lives on the configured `api_host` and which has no github.com
 * presence. True iff `api_host` is a non-empty string AND `exclusive` is not
 * explicitly `false`. Omitting `exclusive` therefore preserves today's
 * behaviour (an `api_host` repo is alt-host-only). Setting `exclusive: false`
 * marks a *dual* repo whose PRs may live on github.com OR the alt host.
 *
 * @param {Object|null|undefined} repoConfig - A single `repos[...]` entry
 * @returns {boolean}
 */
function isExclusiveAltHost(repoConfig) {
  if (!repoConfig || typeof repoConfig !== 'object') return false;
  const apiHost = typeof repoConfig.api_host === 'string' && repoConfig.api_host;
  if (!apiHost) return false;
  return repoConfig.exclusive !== false;
}

/**
 * Resolves the host binding for a given repository. The binding describes
 * which API host pair-review should talk to, the token to authenticate
 * with, and per-area dispatch flags.
 *
 * The optional `options.host` selects the binding *flavor* for repos that can
 * live on more than one host (dual repos, `exclusive: false`):
 *   - `undefined` (or no options) — legacy + ambiguity rule: an EXCLUSIVE
 *     alt-host repo binds to its alt host (today's behaviour); a DUAL repo or
 *     a plain github.com repo binds to github.com.
 *   - `null` — force a github.com binding. For an EXCLUSIVE alt-host repo this
 *     is a caller bug (that repo has no github.com presence) and throws.
 *   - `'<url>'` — force an alt-host binding; the string must equal the repo's
 *     configured `api_host`, otherwise the stored host no longer matches
 *     config and this throws.
 *
 * Token resolution priority for a github.com (github-flavored) binding of a
 * plain repo:
 *   1. GITHUB_TOKEN environment variable
 *   2. repo-level `token`
 *   3. repo-level `token_command` (cached per (repo, command))
 *   4. top-level `github_token`
 *   5. top-level `github_token_command` (cached per (repo, command))
 *
 * For an alt-host binding, the github.com top-level credentials are NOT used —
 * `GITHUB_TOKEN`, `config.github_token`, and `config.github_token_command` are
 * all github.com-only and would be the wrong token for an alt-host endpoint.
 * Only the repo-scoped `token` / `token_command` keys are consulted; missing
 * those, the lookup returns an empty token so the caller can surface a clear
 * "missing credential" error.
 *
 * For the github.com binding of a DUAL repo, the reverse holds: the repo-scoped
 * `token` / `token_command` are alt-host credentials and are NOT used — only
 * the top-level github.com chain (env → `github_token` → `github_token_command`)
 * is consulted. The repo's explicit `features` block (written for the alt host)
 * also does not apply to its github.com binding.
 *
 * Refreshable sources (`repo:token_command`, `config:github_token_command`)
 * additionally carry a `refresh` closure on the returned binding. Calling
 * `refresh()` busts the cached token for that exact source, re-runs the
 * command, and resolves to the fresh token (empty string if the command now
 * fails). For non-refreshable sources (`env:GITHUB_TOKEN`, `repo:token`,
 * `config:github_token`, `none`) `refresh` is `null` — re-running would not
 * change a literal token or env var.
 *
 * @param {string|null|undefined} repository - "owner/repo" identifier, or null/undefined for no-repo fallback
 * @param {Object} config - Configuration object from loadConfig()
 * @param {{ host?: string|null }} [options] - Per-PR host override (see above)
 * @returns {{ apiHost: string|null, host: string|null, token: string, features: Object, source: string, refresh: (function(): string)|null }}
 */
function resolveHostBinding(repository, config, options = {}) {
  const safeConfig = config || {};
  const repoConfig = repository ? getRepoConfig(safeConfig, repository) : null;
  const configuredApiHost = (repoConfig && typeof repoConfig.api_host === 'string' && repoConfig.api_host)
    ? repoConfig.api_host
    : null;
  const requestedHost = options ? options.host : undefined;
  const exclusive = isExclusiveAltHost(repoConfig);

  // Decide the binding flavor from the requested host + repo config.
  // `apiHost` null → github.com binding; non-null → alt-host binding.
  let apiHost;
  if (requestedHost === undefined) {
    // Ambiguity rule: exclusive alt-host repo → alt binding (legacy);
    // dual repo and plain github repo → github binding.
    apiHost = exclusive ? configuredApiHost : null;
  } else if (requestedHost === null) {
    if (exclusive) {
      throw new Error(
        `resolveHostBinding: repository "${repository}" is an exclusive alt-host repo (api_host "${configuredApiHost}") and has no github.com presence, but a github.com binding was requested (host=null). This is a caller bug; pass the api_host string, or set "exclusive": false on the repo config.`
      );
    }
    apiHost = null;
  } else {
    // A specific alt host was requested; it must match this repo's config.
    if (requestedHost !== configuredApiHost) {
      throw new Error(
        `resolveHostBinding: requested host "${requestedHost}" for repository "${repository}" does not match its configured api_host (${configuredApiHost === null ? 'none' : `"${configuredApiHost}"`}). The stored host no longer matches config — re-open the PR from a URL to re-resolve its host.`
      );
    }
    apiHost = configuredApiHost;
  }

  // Binding flavor booleans:
  //  - alt binding uses ONLY repo-scoped credentials + the repo's features.
  //  - github binding uses ONLY the top-level github.com chain.
  //  - the github binding of a DUAL repo must skip the repo-scoped
  //    credentials/features (they belong to the alt host).
  const isAltBinding = apiHost !== null;
  const isDualGithubBinding = !isAltBinding && configuredApiHost !== null;
  const useRepoScopedToken = !isDualGithubBinding;
  const useGithubChain = !isAltBinding;

  // A dual repo's explicit `features` block was authored for its alt host, so
  // it does not apply to the github.com binding; use plain github defaults.
  const explicitFeatures = isDualGithubBinding ? undefined : repoConfig?.features;
  const features = _resolveFeatures(apiHost, explicitFeatures);

  // Token resolution
  let token = '';
  let source = 'none';

  // 1. GITHUB_TOKEN env var, only for a github.com binding
  if (useGithubChain && process.env.GITHUB_TOKEN) {
    token = process.env.GITHUB_TOKEN;
    source = 'env:GITHUB_TOKEN';
    logger.debug('Using GitHub token from GITHUB_TOKEN environment variable');
    return { apiHost, host: apiHost, token, features, source, refresh: null };
  }

  // 2. Repo-level literal token (alt-host credential; not used for a dual
  // repo's github.com binding)
  if (useRepoScopedToken && repoConfig && typeof repoConfig.token === 'string' && repoConfig.token) {
    token = repoConfig.token;
    source = 'repo:token';
    logger.debug(`Using token from repos[${repository}].token`);
    return { apiHost, host: apiHost, token, features, source, refresh: null };
  }

  // 3. Repo-level token_command
  if (useRepoScopedToken && repoConfig && typeof repoConfig.token_command === 'string' && repoConfig.token_command) {
    const result = _runTokenCommand(repoConfig.token_command, repository, 'repo:token_command');
    if (result) {
      return {
        apiHost,
        host: apiHost,
        token: result,
        features,
        source: 'repo:token_command',
        refresh: _makeRefresh(repository, safeConfig, 'repo:token_command', options)
      };
    }
  }

  // 4. Top-level github_token. Only consulted for a github.com binding —
  // the top-level token is a github.com credential and would fail
  // authentication when sent to an alt-host.
  if (useGithubChain && typeof safeConfig.github_token === 'string' && safeConfig.github_token) {
    token = safeConfig.github_token;
    source = 'config:github_token';
    logger.debug('Using GitHub token from config.github_token');
    return { apiHost, host: apiHost, token, features, source, refresh: null };
  }

  // 5. Top-level github_token_command. Like step 4, github.com-only.
  // The top-level command is a SINGLE shared provider, so cache by
  // command only — keying on repository would re-invoke the (often
  // slow) command per repo per session. Repo-level `token_command`
  // above keeps its per-(repo, command) cache key.
  if (useGithubChain && typeof safeConfig.github_token_command === 'string' && safeConfig.github_token_command) {
    const result = _runTokenCommand(safeConfig.github_token_command, null, 'config:github_token_command');
    if (result) {
      return {
        apiHost,
        host: apiHost,
        token: result,
        features,
        source: 'config:github_token_command',
        refresh: _makeRefresh(repository, safeConfig, 'config:github_token_command', options)
      };
    }
  }

  if (isAltBinding && repository) {
    logger.debug(`No repo-scoped token resolved for alt-host repo ${repository} (${apiHost}); github.com top-level credentials are not used for alt-hosts`);
  } else {
    logger.debug('No token resolved for host binding');
  }
  return { apiHost, host: apiHost, token: '', features, source: 'none', refresh: null };
}

/**
 * Builds the `refresh` closure attached to a refreshable host binding.
 *
 * The closure busts the cached token for the exact (repository, command)
 * pair backing `source`, then re-resolves the binding and returns the
 * freshly-resolved token. Cache invalidation happens BEFORE re-resolving so
 * `_runTokenCommand` re-executes the command rather than returning the stale
 * cached value — without this ordering, refresh would be a no-op.
 *
 * @param {string|null|undefined} repository - "owner/repo" identifier as supplied to resolveHostBinding
 * @param {Object} config - Configuration object from loadConfig()
 * @param {('repo:token_command'|'config:github_token_command')} source - The refreshable source backing the binding
 * @param {{ host?: string|null }} [options] - The same host override the binding was resolved with, so the refresh re-resolves the SAME flavor (a two-arg re-resolve would apply the ambiguity rule and could pick the wrong host for a dual repo)
 * @returns {function(): string} - Closure resolving to the fresh token (empty string on failure)
 */
function _makeRefresh(repository, config, source, options = {}) {
  return function refresh() {
    invalidateTokenCache(repository, config, source);
    // Re-resolve after invalidation so _runTokenCommand re-executes the
    // command. Returns '' if the command now fails or yields nothing.
    return resolveHostBinding(repository, config, options).token;
  };
}

/**
 * Invalidates the cached token for a single refreshable source so the next
 * resolution re-runs its command. Surgical: deletes ONLY the cache key for
 * the supplied (repository, command) pair — other repos' cached tokens are
 * left intact.
 *
 *   - `repo:token_command`           → key `${repository}|${repoConfig.token_command}`
 *   - `config:github_token_command`  → key `|${config.github_token_command}`
 *     (also clears the single-slot `_cachedCommandToken` defensively, since
 *     the no-repo `getGitHubToken()` path caches the top-level command there)
 *
 * Literal-token and env sources are not refreshable, so calling this with
 * any other `source` is a no-op.
 *
 * @param {string|null|undefined} repository - "owner/repo" identifier
 * @param {Object} config - Configuration object from loadConfig()
 * @param {('repo:token_command'|'config:github_token_command')} source - Source to invalidate
 */
function invalidateTokenCache(repository, config, source) {
  const safeConfig = config || {};
  if (source === 'repo:token_command') {
    const repoConfig = repository ? getRepoConfig(safeConfig, repository) : null;
    const command = repoConfig && typeof repoConfig.token_command === 'string' ? repoConfig.token_command : '';
    if (!command) return;
    const cacheKey = `${repository ?? ''}|${command}`;
    _cachedRepoTokens.delete(cacheKey);
    logger.debug(`Invalidated cached token for repo:token_command (${repository})`);
    return;
  }
  if (source === 'config:github_token_command') {
    const command = typeof safeConfig.github_token_command === 'string' ? safeConfig.github_token_command : '';
    if (!command) return;
    const cacheKey = `|${command}`;
    _cachedRepoTokens.delete(cacheKey);
    // The no-repo getGitHubToken() path caches the same top-level command in
    // a separate single slot; clear it too so both paths re-run the command.
    _cachedCommandToken = null;
    logger.debug('Invalidated cached token for config:github_token_command');
  }
}

/**
 * Gets the GitHub token. When `repository` is supplied, the lookup is
 * delegated to `resolveHostBinding()` for repo-aware resolution. When
 * `repository` is omitted, the no-repo fallback shape is preserved
 * (top-level keys only, env var wins) so callers without repo context
 * (setup flows, auth-test) continue to work unchanged.
 *
 * Priority (no-repo case):
 *   1. GITHUB_TOKEN environment variable
 *   2. config.github_token
 *   3. config.github_token_command (cached on success)
 *
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} [repository] - Optional "owner/repo" identifier
 * @returns {string} - GitHub token or empty string if not configured
 */
function getGitHubToken(config, repository) {
  if (repository) {
    return resolveHostBinding(repository, config).token;
  }
  // No-repo fallback path. Preserves previous behaviour (and previous
  // single-slot cache via _cachedCommandToken) for callers that have no
  // repo context.
  if (process.env.GITHUB_TOKEN) {
    logger.debug('Using GitHub token from GITHUB_TOKEN environment variable');
    return process.env.GITHUB_TOKEN;
  }
  if (config && config.github_token) {
    logger.debug('Using GitHub token from config.github_token');
    return config.github_token;
  }
  if (config && config.github_token_command) {
    if (_cachedCommandToken !== null) {
      logger.debug('Using GitHub token from github_token_command (cached)');
      return _cachedCommandToken;
    }
    logger.debug(`Attempting GitHub token from command: ${config.github_token_command}`);
    try {
      const result = childProcess.execSync(config.github_token_command, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
      if (!result) {
        logger.warn(`github_token_command did not produce a token (command: ${config.github_token_command})`);
        return '';
      }
      logger.debug('Using GitHub token from github_token_command');
      _cachedCommandToken = result;
      return result;
    } catch (error) {
      logger.warn(`github_token_command failed (command: ${config.github_token_command}): ${error.message}`);
      return '';
    }
  }
  logger.debug('No GitHub token configured');
  return '';
}

/**
 * Validates per-repo configuration entries. Called from `loadConfig()`
 * after merging so that misconfiguration fails loudly at startup rather
 * than silently degrading at runtime. Throws on the first invariant
 * violation found.
 *
 * Invariants checked:
 *   - `api_host` set + any `features.<area>: "graphql"` → fail.
 *     Alt-hosts have no GraphQL endpoint; silently falling back would
 *     mislead.
 *   - `api_host` unset + any `features.<area>: "host"` → fail. Host
 *     extensions require a host.
 *   - `url_pattern` is present but not a valid regex → fail.
 *   - `git_remote_pattern` is present but not a valid regex → fail.
 *   - `links.external` is set but missing `label`/`url_template`, or
 *     the `url_template` doesn't start with `https://` → fail.
 *
 * @param {Object} config - Merged configuration object
 * @throws {Error} On the first invalid repo entry
 */
function validateRepoConfig(config) {
  const repos = (config && config.repos) || {};
  for (const [repoKey, repoEntry] of Object.entries(repos)) {
    if (!repoEntry || typeof repoEntry !== 'object') continue;

    const apiHost = (typeof repoEntry.api_host === 'string' && repoEntry.api_host) ? repoEntry.api_host : null;
    const features = (repoEntry.features && typeof repoEntry.features === 'object') ? repoEntry.features : {};

    // `exclusive` marks whether an alt-host repo's PRs live ONLY on its
    // `api_host` (default) or may also live on github.com (`exclusive: false`,
    // a dual repo). It is meaningless without `api_host`.
    if (repoEntry.exclusive !== undefined && repoEntry.exclusive !== null) {
      if (typeof repoEntry.exclusive !== 'boolean') {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].exclusive must be a boolean.`
        );
      }
      if (!apiHost) {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].exclusive is only valid when api_host is set.`
        );
      }
    }

    for (const [area, value] of Object.entries(features)) {
      // Endpoint-override sub-keys (e.g. `pending_review_comments_endpoint`)
      // are validated separately below. Reject anything that ends in
      // `_endpoint` but isn't a recognised override so typos surface here.
      if (area.endsWith('_endpoint')) {
        if (!KNOWN_ENDPOINT_SUBKEYS.has(area)) {
          throw new Error(
            `Invalid pair-review config: repos["${repoKey}"].features.${area} is not a recognised endpoint override. ` +
            `Valid endpoint overrides: ${Array.from(KNOWN_ENDPOINT_SUBKEYS).join(', ')}.`
          );
        }
        continue;
      }
      // Reject unknown feature keys (e.g. `pendin_review_check` typo).
      // Without this, the key is silently ignored by _resolveFeatures.
      if (!FEATURE_AREAS.includes(area)) {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].features.${area} is not a recognised feature area. ` +
          `Valid feature areas: ${FEATURE_AREAS.join(', ')}.`
        );
      }
      if (!ALLOWED_FEATURE_VALUES.has(value)) {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].features.${area} = "${value}" is not one of "graphql", "rest", or "host".`
        );
      }
      // Implementation-matrix check: refuse modes that have no dispatcher
      // entry. Without this, an unimplemented (area, mode) pair fails at
      // dispatch time — which for review_lifecycle/pending_review_comments
      // can happen AFTER a pending review has been created on GitHub.
      const implemented = IMPLEMENTATION_MATRIX[area];
      if (implemented && !implemented.has(value)) {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].features.${area} = "${value}" is not implemented. ` +
          `Implemented modes for ${area}: ${Array.from(implemented).join(', ')}.`
        );
      }
      if (apiHost && value === 'graphql') {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"] sets api_host but features.${area} = "graphql". Alt-hosts do not support GraphQL; use "rest" or "host".`
        );
      }
      if (!apiHost && value === 'host') {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].features.${area} = "host" requires api_host to be set.`
        );
      }
    }

    // Validate the resolved defaults so that areas the user did NOT
    // override are also checked against the implementation matrix.
    // Catches misconfigurations where the default for an area on a
    // particular host kind has no dispatcher (e.g. an area whose default
    // would resolve to a mode lacking a runtime implementation).
    const resolvedFeatures = _resolveFeatures(apiHost, features);
    for (const [area, value] of Object.entries(resolvedFeatures)) {
      if (area.endsWith('_endpoint')) continue;
      if (Object.prototype.hasOwnProperty.call(features, area)) continue; // already checked above
      const implemented = IMPLEMENTATION_MATRIX[area];
      if (implemented && !implemented.has(value)) {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"] resolves features.${area} to "${value}" by default, which is not implemented. ` +
          `Implemented modes for ${area}: ${Array.from(implemented).join(', ')}. ` +
          `Set features.${area} explicitly to an implemented mode.`
        );
      }
    }

    // Validate the optional endpoint override for the host-extension
    // `pending_review_comments` area. Only meaningful when that area is
    // set to "host" — applying it otherwise is a config error.
    const endpointOverride = features.pending_review_comments_endpoint;
    if (endpointOverride !== undefined && endpointOverride !== null) {
      if (typeof endpointOverride !== 'string' || !endpointOverride) {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].features.pending_review_comments_endpoint must be a non-empty string.`
        );
      }
      if (features.pending_review_comments !== 'host') {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].features.pending_review_comments_endpoint is only valid when pending_review_comments = "host".`
        );
      }
      // Must be a relative path (resolved against the configured baseUrl).
      // Absolute URLs would silently bypass the host's baseUrl.
      if (/^https?:\/\//i.test(endpointOverride) || /^\/\//.test(endpointOverride)) {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].features.pending_review_comments_endpoint must be a relative path (e.g. "/repos/{owner}/{repo}/..."), not an absolute URL.`
        );
      }
      // All four placeholders must be present so callers don't accidentally
      // send a request missing path components.
      const required = ['{owner}', '{repo}', '{pull_number}', '{review_id}'];
      const missing = required.filter(p => !endpointOverride.includes(p));
      if (missing.length > 0) {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].features.pending_review_comments_endpoint is missing required placeholder(s): ${missing.join(', ')}.`
        );
      }
    }

    if (repoEntry.url_pattern !== undefined && repoEntry.url_pattern !== null) {
      if (typeof repoEntry.url_pattern !== 'string') {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].url_pattern must be a string regex.`
        );
      }
      try {
        // eslint-disable-next-line no-new
        new RegExp(repoEntry.url_pattern);
      } catch (err) {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].url_pattern is not a valid regular expression: ${err.message}`
        );
      }

      // An `api_host`-bearing pattern must never match a canonical github.com /
      // Graphite URL — doing so pre-pins a github PR to the alt host and bypasses
      // the setup probe (a silent, durable wrong binding). Warn (do NOT throw —
      // we must not break existing configs; parsePRUrl also guards this at
      // runtime by discarding such matches) when the pattern is over-broad.
      if (typeof repoEntry.api_host === 'string' && repoEntry.api_host) {
        try {
          const rx = new RegExp(repoEntry.url_pattern);
          const canaries = [
            'https://github.com/o/r/pull/1',
            'https://app.graphite.dev/github/pr/o/r/1',
            'https://app.graphite.com/github/o/r/pull/1'
          ];
          if (canaries.some((u) => rx.test(u))) {
            logger.warn(
              `repos["${repoKey}"].url_pattern also matches canonical github.com / Graphite URLs; ` +
              `anchor it (e.g. start with "^https://<your-alt-host>/") so it never pre-pins a github.com ` +
              `PR to the alt host. pair-review will still route such URLs to github.com.`
            );
          }
        } catch {
          // Invalid regex already reported above; nothing more to check.
        }
      }
    }

    // Optional escape-hatch regex used by parseRepositoryFromURL to match
    // a non-standard git remote URL to this repo entry. Validated here
    // so misconfiguration fails loudly at startup rather than as a
    // silent fall-through at CLI parse time.
    if (repoEntry.git_remote_pattern !== undefined && repoEntry.git_remote_pattern !== null) {
      if (typeof repoEntry.git_remote_pattern !== 'string') {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].git_remote_pattern must be a string regex.`
        );
      }
      try {
        // eslint-disable-next-line no-new
        new RegExp(repoEntry.git_remote_pattern);
      } catch (err) {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].git_remote_pattern is not a valid regular expression: ${err.message}`
        );
      }
    }

    const links = repoEntry.links;
    if (links && typeof links === 'object' && links.external !== undefined && links.external !== null) {
      const ext = links.external;
      if (typeof ext !== 'object') {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].links.external must be an object with "label" and "url_template".`
        );
      }
      if (typeof ext.label !== 'string' || !ext.label) {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].links.external.label must be a non-empty string.`
        );
      }
      if (typeof ext.url_template !== 'string' || !ext.url_template) {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].links.external.url_template must be a non-empty string.`
        );
      }
      if (!ext.url_template.startsWith('https://')) {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].links.external.url_template must start with "https://".`
        );
      }
      // Optional display name for the host (e.g. "Meteorite"). Used in place
      // of the literal "GitHub" in user-facing text. When omitted, callers
      // fall back to "GitHub" (see resolveHostName in src/links/repo-links.js).
      if (ext.name !== undefined && ext.name !== null
          && (typeof ext.name !== 'string' || !ext.name)) {
        throw new Error(
          `Invalid pair-review config: repos["${repoKey}"].links.external.name must be a non-empty string when present.`
        );
      }
    }
  }
}

/**
 * Matches a URL against per-repo `url_pattern` regexes and returns the
 * resolved repo identifier and any named-group captures. Does NOT fall
 * back to GitHub URL parsing — callers should try `matchRepoByUrl()`
 * first and then `parseGitHubUrl()`.
 *
 * Repo configs are expected to be valid at this point (regex compilation
 * is checked at startup by `validateRepoConfig()`); invalid regexes are
 * silently skipped here as a defensive measure.
 *
 * The returned shape includes both:
 *   - `repository`: the canonical PR identity (`<owner>/<repo>`),
 *     preferring named-group captures so monorepo-style configs where one
 *     URL pattern maps to many sub-repos still return the captured PR.
 *   - `bindingRepository`: the matched `repos[...]` key. Use this when
 *     looking up host bindings (token, api_host, features) so a single
 *     monorepo-shaped binding can serve URLs whose captured
 *     owner/repo differ from the config key.
 *
 * When no pattern matches, this function returns `null`; callers are
 * expected to fall back to `bindingRepository = "<owner>/<repo>"` on
 * their own.
 *
 * @param {string} url - URL to match
 * @param {Object} config - Configuration object from loadConfig()
 * @returns {{ repository: string, bindingRepository: string, repoConfig: Object, owner?: string, repo?: string, number?: number }|null}
 */
function matchRepoByUrl(url, config) {
  if (!url || typeof url !== 'string') return null;
  const repos = (config && config.repos) || {};
  for (const [repoKey, repoEntry] of Object.entries(repos)) {
    if (!repoEntry || typeof repoEntry !== 'object' || !repoEntry.url_pattern) continue;
    let regex;
    try {
      regex = new RegExp(repoEntry.url_pattern);
    } catch {
      // Invalid regex — would have been caught at startup; skip.
      continue;
    }
    const match = regex.exec(url);
    if (!match) continue;

    const groups = match.groups || {};
    const result = {
      repository: groups.owner && groups.repo ? `${groups.owner}/${groups.repo}` : repoKey,
      bindingRepository: repoKey,
      repoConfig: repoEntry
    };
    if (groups.owner) result.owner = groups.owner;
    if (groups.repo) result.repo = groups.repo;
    if (groups.number !== undefined) {
      const n = Number(groups.number);
      if (!Number.isNaN(n)) result.number = n;
    }
    return result;
  }
  return null;
}

/**
 * Resolve the `repos[...]` binding-key for a PR identified by `<owner>/<repo>`.
 *
 * Most of the time the binding key is just `<owner>/<repo>` (lowercased)
 * and a direct lookup in `config.repos` suffices. For monorepo-style
 * configs where one `repos[...]` entry serves URLs whose captured
 * `owner/repo` differ from the config key (matched via `url_pattern`
 * named capture groups), the direct lookup misses. In that case we
 * scan `repos[...]` for an entry whose `url_pattern` regex captures
 * the supplied owner and repo via named groups when probed against a
 * candidate URL synthesized from its `api_host`.
 *
 * Returns the normalized `<owner>/<repo>` fallback when no monorepo
 * entry matches, so callers always have a stable lookup key to pass to
 * `resolveHostBinding()`.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {Object} config - Configuration object from loadConfig()
 * @returns {string} - The repository key to use with resolveHostBinding()
 */
function resolveBindingRepositoryFromPR(owner, repo, config) {
  const fallback = `${String(owner || '').toLowerCase()}/${String(repo || '').toLowerCase()}`;
  if (!owner || !repo) return fallback;
  const safeConfig = config || {};
  const repos = safeConfig.repos || {};

  // Fast path: direct key hit.
  if (repos[fallback]) return fallback;
  // Case-insensitive scan in case the user keyed their config with
  // mixed-case entries despite the loader's normalisation.
  for (const repoKey of Object.keys(repos)) {
    if (repoKey.toLowerCase() === fallback) return repoKey;
  }

  // Slow path: probe each entry's `url_pattern` against a synthetic URL
  // built from `api_host`. If the regex captures named groups whose
  // values equal the supplied owner/repo, the entry serves this PR.
  for (const [repoKey, repoEntry] of Object.entries(repos)) {
    if (!repoEntry || typeof repoEntry !== 'object') continue;
    const pattern = repoEntry.url_pattern;
    const apiHost = repoEntry.api_host;
    if (typeof pattern !== 'string' || !pattern) continue;
    if (typeof apiHost !== 'string' || !apiHost) continue;
    let regex;
    try { regex = new RegExp(pattern); } catch { continue; }
    // Strip api_host to a bare scheme + host to construct candidate
    // URLs the user's pattern might match. We try a couple of common
    // shapes; if the user's URL layout is exotic, they can set the
    // bindingRepository explicitly from the CLI parse path.
    const hostOnly = apiHost.replace(/\/api(\/v\d+)?\/?$/i, '');
    const candidates = [
      `${hostOnly}/${owner}/${repo}/pull/1`,
      `${apiHost}/${owner}/${repo}/pull/1`
    ];
    for (const candidate of candidates) {
      const m = regex.exec(candidate);
      if (m && m.groups && m.groups.owner === owner && m.groups.repo === repo) {
        return repoKey;
      }
    }
  }

  return fallback;
}

/**
 * Resets the cached command token. Exported for testing only.
 */
function _resetTokenCache() {
  _cachedCommandToken = null;
  _cachedRepoTokens.clear();
}

/**
 * Detect if running via npx vs a global npm install.
 * When running via npx, npm_execpath typically points to npm-cli.js or npx
 * @returns {boolean} True if running via npx
 */
function isRunningViaNpx() {
  const execPath = process.env.npm_execpath || '';
  const npmCommand = process.env.npm_command || '';
  // npx sets npm_command to 'exec' and npm_execpath to npm-cli.js
  // A global install would typically not have these set, or npm_command would be 'run'
  return npmCommand === 'exec' || execPath.includes('npx') || execPath.includes('npm-cli');
}

/**
 * Display the first-run welcome message.
 * Shows helpful getting started information on first run.
 */
function showWelcomeMessage() {
  const cmd = isRunningViaNpx() ? 'npx @in-the-loop-labs/pair-review' : 'pair-review';
  // Box width: 77 chars total (75 inner + 2 borders)
  // Inner content width: 75 chars
  // Command lines: 6 leading spaces + cmd + args + trailing padding + │
  const boxWidth = 75;
  const cmdIndent = 6;

  // Calculate padding for each command line (subtract content, leave space before │)
  const localPad = boxWidth - cmdIndent - cmd.length - ' --local'.length;
  const configPad = boxWidth - cmdIndent - cmd.length - ' --configure'.length;
  const helpPad = boxWidth - cmdIndent - cmd.length - ' --help'.length;

  console.log(`
┌───────────────────────────────────────────────────────────────────────────┐
│  Welcome to pair-review, your AI-assisted code review partner!            │
│                                                                           │
│  Try pair-review now to review local changes, no setup required:          │
│      ${cmd} --local${' '.repeat(Math.max(0, localPad))}│
│                                                                           │
│  To review PRs from GitHub and submit feedback, you'll need a token:      │
│      ${cmd} --configure${' '.repeat(Math.max(0, configPad))}│
│                                                                           │
│  See full usage help:                                                     │
│      ${cmd} --help${' '.repeat(Math.max(0, helpPad))}│
└───────────────────────────────────────────────────────────────────────────┘
`);
}

/**
 * Expands paths that start with ~/ to use the user's home directory.
 *
 * Note: Node.js does not have built-in tilde expansion. The os.homedir()
 * function returns the home directory path but doesn't expand tildes in
 * strings. This manual approach is the standard pattern; external packages
 * like 'expand-tilde' exist but add unnecessary dependencies for this
 * simple use case.
 *
 * @param {string} p - Path to expand
 * @returns {string} - Expanded path
 */
function expandPath(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Get repository configuration, checking `repos` key first, falling back to `monorepos`.
 * @param {object} config
 * @param {string} repository - owner/repo
 * @returns {object|null}
 */
function getRepoConfig(config, repository) {
  const key = String(repository).toLowerCase();
  const reposSection = config.repos || {};
  const repoEntry = reposSection[key] || reposSection[repository] || Object.entries(reposSection)
    .find(([repoName]) => repoName.toLowerCase() === key)?.[1];
  if (repoEntry) return repoEntry;

  const legacySection = config.monorepos || {};
  return legacySection[key] || legacySection[repository] || Object.entries(legacySection)
    .find(([repoName]) => repoName.toLowerCase() === key)?.[1] || null;
}

/**
 * Gets the configured repository path
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {string|null} - Expanded path or null if not configured
 */
function getRepoPath(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  if (repoConfig?.path) {
    return expandPath(repoConfig.path);
  }
  return null;
}

/**
 * Gets the configured checkout script for a repository
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {string|null} - Checkout script path or null if not configured
 */
function getRepoCheckoutScript(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  return repoConfig?.checkout_script || null;
}

/**
 * Gets the configured worktree directory for a repository
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {string|null} - Expanded worktree directory path or null if not configured
 */
function getRepoWorktreeDirectory(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  if (repoConfig?.worktree_directory) {
    return expandPath(repoConfig.worktree_directory);
  }
  return null;
}

/**
 * Gets the configured worktree name template for a repository
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {string|null} - Template string or null if not configured
 */
function getRepoWorktreeNameTemplate(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  return repoConfig?.worktree_name_template || null;
}

/**
 * Computes the display name for a worktree path by deriving the relative
 * path from the configured (or default) worktree base directory.
 * Falls back to the basename when the path lies outside the base directory.
 *
 * @param {string} worktreePath - Absolute path to the worktree
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {string|null} - Relative display name (e.g. "abc123/src") or basename fallback
 */
function getWorktreeDisplayName(worktreePath, config, repository) {
  if (!worktreePath) return null;
  const worktreeBaseDir = getRepoWorktreeDirectory(config, repository)
    || path.join(getConfigDir(), 'worktrees');
  const relativePath = path.relative(worktreeBaseDir, worktreePath);
  if (relativePath.startsWith('..')) {
    return path.basename(worktreePath);
  }
  return relativePath;
}

/**
 * Gets the configured checkout script timeout for a repository
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {number} - Timeout in milliseconds (default: 300000 = 5 minutes)
 */
function getRepoCheckoutTimeout(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  if (repoConfig?.checkout_timeout_seconds > 0) {
    return repoConfig.checkout_timeout_seconds * 1000;
  }
  return DEFAULT_CHECKOUT_TIMEOUT_MS; // 5 minutes default
}

/**
 * Gets the configured reset script for a repository
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {string|null} - Reset script path or null if not configured
 */
function getRepoResetScript(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  return repoConfig?.reset_script || null;
}

/**
 * Gets whether broad fetches should be skipped during worktree refresh and
 * periodic pool background fetching. Targeted base-SHA and PR-head fetches continue.
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {boolean} - true if broad fetches should be skipped (default: false)
 */
function getRepoSkipBulkFetch(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  return repoConfig?.skip_bulk_fetch === true;
}

/**
 * Gets the configured pool size for a repository from file config only.
 * Prefer resolvePoolConfig() when DB repo_settings are available.
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {number} - Pool size (0 if not configured or invalid)
 */
function getRepoPoolSize(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  const size = repoConfig?.pool_size;
  return (typeof size === 'number' && size > 0) ? size : 0;
}

/**
 * Gets the configured pool fetch interval for a repository from file config only.
 * Prefer resolvePoolConfig() when DB repo_settings are available.
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {number|null} - Interval in minutes or null if not configured
 */
function getRepoPoolFetchInterval(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  const minutes = repoConfig?.pool_fetch_interval_minutes;
  return (typeof minutes === 'number' && minutes > 0) ? minutes : null;
}

/**
 * Gets the configured load_skills setting for a repository from file config.
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {boolean|null} - true/false if set, null if not configured
 */
function getRepoLoadSkills(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  const val = repoConfig?.load_skills;
  return typeof val === 'boolean' ? val : null;
}

/**
 * Resolves the load_skills setting for a repository, checking DB repo_settings first,
 * then repo JSON config, then provider config. Returns a boolean suitable for passing
 * directly to provider constructors (which check `!== false`).
 *
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @param {Object|null} repoSettings - DB repo_settings row (from RepoSettingsRepository.getRepoSettings)
 * @param {boolean} [providerLoadSkills] - Provider-level load_skills from config.providers
 * @returns {boolean} - Resolved load_skills value
 */
function resolveLoadSkills(config, repository, repoSettings, providerLoadSkills) {
  // Tier 1: DB repo settings (1 = true, 0 = false, null = not set)
  const dbVal = repoSettings?.load_skills;
  if (typeof dbVal === 'number' && (dbVal === 0 || dbVal === 1)) {
    return dbVal === 1;
  }

  // Tier 2: Repo JSON config (config.repos["owner/repo"].load_skills)
  const repoVal = getRepoLoadSkills(config, repository);
  if (repoVal !== null) {
    return repoVal;
  }

  // Tier 3: Provider-level config
  if (typeof providerLoadSkills === 'boolean') {
    return providerLoadSkills;
  }

  // Tier 4: Default
  return true;
}

/**
 * Builds council-mode provider overrides: a shared (tier 1+2) base and a per-provider
 * map that includes tier 3 resolution for each configured provider.
 *
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @param {Object|null} repoSettings - DB repo_settings row
 * @returns {{ providerOverrides: Object, providerOverridesMap: Object }}
 */
function buildCouncilProviderOverrides(config, repository, repoSettings) {
  const baseLoadSkills = resolveLoadSkills(config, repository, repoSettings);
  const providerOverrides = { load_skills: baseLoadSkills };
  const providerOverridesMap = {};
  if (config.providers) {
    for (const [pid, pconf] of Object.entries(config.providers)) {
      providerOverridesMap[pid] = {
        load_skills: resolveLoadSkills(config, repository, repoSettings, pconf?.load_skills)
      };
    }
  }
  return { providerOverrides, providerOverridesMap };
}

/**
 * Resolves pool configuration for a repository, checking DB repo_settings first,
 * then falling back to file config. DB values take precedence when set (non-null).
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @param {Object|null} repoSettings - DB repo_settings row (from RepoSettingsRepository.getRepoSettings)
 * @returns {{ poolSize: number, poolFetchIntervalMinutes: number|null }}
 */
function resolvePoolConfig(config, repository, repoSettings) {
  const dbPoolSize = repoSettings?.pool_size;
  const dbFetchInterval = repoSettings?.pool_fetch_interval_minutes;

  const poolSize = (typeof dbPoolSize === 'number' && dbPoolSize >= 0)
    ? dbPoolSize
    : getRepoPoolSize(config, repository);

  const poolFetchIntervalMinutes = (typeof dbFetchInterval === 'number' && dbFetchInterval >= 0)
    ? (dbFetchInterval > 0 ? dbFetchInterval : null)
    : getRepoPoolFetchInterval(config, repository);

  return { poolSize, poolFetchIntervalMinutes };
}

/**
 * Resolves all repository worktree options into a single object.
 * Composite helper that combines the individual getters into the shape expected
 * by GitWorktreeManager and createWorktreeForPR.
 *
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @param {Object|null} [repoSettings=null] - DB repo_settings row (from RepoSettingsRepository.getRepoSettings)
 * @returns {{ checkoutScript: string|null, checkoutTimeout: number, worktreeConfig: Object|null, resetScript: string|null, poolSize: number, poolFetchIntervalMinutes: number|null }}
 */
function resolveRepoOptions(config, repository, repoSettings = null) {
  const checkoutScript = getRepoCheckoutScript(config, repository);
  const checkoutTimeout = getRepoCheckoutTimeout(config, repository);
  const worktreeDirectory = getRepoWorktreeDirectory(config, repository);
  const nameTemplate = getRepoWorktreeNameTemplate(config, repository);

  let worktreeConfig = null;
  if (worktreeDirectory || nameTemplate) {
    worktreeConfig = {};
    if (worktreeDirectory) worktreeConfig.worktreeBaseDir = worktreeDirectory;
    if (nameTemplate) worktreeConfig.nameTemplate = nameTemplate;
  }

  const resetScript = getRepoResetScript(config, repository);
  const { poolSize, poolFetchIntervalMinutes } = resolvePoolConfig(config, repository, repoSettings);

  return { checkoutScript, checkoutTimeout, worktreeConfig, resetScript, poolSize, poolFetchIntervalMinutes };
}

/**
 * Resolves the database filename to use.
 * Priority:
 *   1. PAIR_REVIEW_DB_NAME environment variable (highest priority)
 *   2. config.db_name from config files
 *   3. 'database.db' (default)
 *
 * @param {Object} config - Configuration object from loadConfig()
 * @returns {string} - Database filename
 */
function resolveDbName(config) {
  if (process.env.PAIR_REVIEW_DB_NAME) {
    return process.env.PAIR_REVIEW_DB_NAME;
  }
  return config.db_name || 'database.db';
}

/**
 * Warns if dev_mode is enabled but no custom db_name is configured.
 * Helps developers avoid accidentally corrupting the shared database
 * when switching between branches with different schemas.
 *
 * @param {Object} config - Configuration object from loadConfig()
 */
function warnIfDevModeWithoutDbName(config) {
  if (config.dev_mode && !config.db_name && !process.env.PAIR_REVIEW_DB_NAME) {
    logger.warn('dev_mode is enabled but no db_name is configured. Consider setting db_name in .pair-review/config.json or PAIR_REVIEW_DB_NAME env var to avoid schema conflicts between branches.');
  }
}

/**
 * Synchronously checks whether the update notifier should be skipped.
 * Reads config files in the standard merge order (managed → global → global.local
 * → project → project.local) and returns the resolved boolean value of
 * `skip_update_notifier`. Designed for use in bin/pair-review.js which runs
 * before the async main process.
 *
 * @returns {boolean} True if the update notifier should be suppressed
 */
function shouldSkipUpdateNotifier() {
  const fsSync = require('fs');
  const localDir = path.join(process.cwd(), '.pair-review');
  // Keep in sync with the sources list in loadConfig()
  const sources = [
    MANAGED_CONFIG_FILE,
    CONFIG_FILE,
    CONFIG_LOCAL_FILE,
    path.join(localDir, 'config.json'),
    path.join(localDir, 'config.local.json'),
  ];

  let skip = false;
  for (const filePath of sources) {
    try {
      const data = fsSync.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(data);
      if ('skip_update_notifier' in parsed) {
        skip = Boolean(parsed.skip_update_notifier);
      }
    } catch {
      // File missing or malformed — skip silently
    }
  }
  return skip;
}

module.exports = {
  DEFAULT_CONFIG,
  deepMerge,
  loadConfig,
  getConfigDir,
  validatePort,
  getGitHubToken,
  resolveHostBinding,
  isExclusiveAltHost,
  invalidateTokenCache,
  validateRepoConfig,
  matchRepoByUrl,
  resolveBindingRepositoryFromPR,
  getDefaultProvider,
  getDefaultModel,
  getSummaryProvider,
  getSummaryModel,
  getSummaryEnabled,
  getSummaryAutoGenerate,
  getTourProvider,
  getTourModel,
  getTourEnabled,
  getTourAutoGenerate,
  isRunningViaNpx,
  showWelcomeMessage,
  expandPath,
  // New repo-prefixed names
  getRepoConfig,
  getRepoPath,
  getRepoCheckoutScript,
  getRepoWorktreeDirectory,
  getRepoWorktreeNameTemplate,
  getWorktreeDisplayName,
  getRepoCheckoutTimeout,
  resolveRepoOptions,
  getRepoResetScript,
  getRepoSkipBulkFetch,
  getRepoPoolSize,
  getRepoPoolFetchInterval,
  getRepoLoadSkills,
  resolvePoolConfig,
  resolveLoadSkills,
  buildCouncilProviderOverrides,
  resolveDbName,
  warnIfDevModeWithoutDbName,
  shouldSkipUpdateNotifier,
  _resetTokenCache,
  DEFAULT_CHECKOUT_TIMEOUT_MS,
  // Canonical lists for per-area feature dispatch. Exported so tests
  // (and `src/github/client.js`'s `DEFAULT_FEATURES`) can assert against
  // a single source of truth.
  FEATURE_AREAS,
  GRAPHQL_DEFAULT_AREAS
};
