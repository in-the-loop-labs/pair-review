// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Global Settings Registry
 *
 * Single catalog of every global (non-repo) setting the /settings page can
 * surface. It drives three things that must never drift apart:
 *   1. Validation of in-app override writes (type, enum membership, bounds).
 *   2. Source attribution (which config layer / env var / DB an effective
 *      value came from) — via each entry's dot-path `key` and optional
 *      `envVar`.
 *   3. The settings UI (label, description, group, control type).
 *
 * Each entry:
 *   {
 *     key:            dot-path into the merged config object (e.g. 'summaries.enabled')
 *     label:          human label for the UI
 *     description:    one-line help text
 *     group:          general | ai | summaries | tours | chat | advanced | readonly
 *     type:           boolean | string | integer | enum | object
 *     values:         [...] (enum only) — allowed values
 *     default:        built-in default; MUST match DEFAULT_CONFIG / the inline
 *                     default used by the value's consumer
 *     editable:       whether the value can be set in-app (false => read-only row)
 *     restartRequired: true when the value is captured at startup, so an in-app
 *                     change is stored but only takes effect on next launch
 *     envVar:         env var that overrides this value (for source attribution)
 *     sensitive:      mask the value in API/UI (return "configured" only)
 *     badge:          optional 'new' | 'beta' pill for the UI (null default)
 *   }
 *
 * SECTIONS is the ordered catalog of UI groups. Each entry's `id` matches a
 * registry entry's `group`; titles/descriptions are the single source of truth
 * the settings page renders (lifted out of public/js/settings.js so the two can
 * never drift). A section may carry a `badge` ('new' | 'beta' | null).
 *
 * Defaults are verified against src/config.js DEFAULT_CONFIG and the inline
 * defaults in src/routes/config.js. Enum value sets are verified against the
 * actual consumer code (comment-formatter PRESETS, SplitButton actions,
 * ChatPanel spinner, theme toggle).
 */

const REGISTRY = [
  // ---- General -----------------------------------------------------------
  {
    key: 'theme',
    label: 'Default theme',
    description: 'Initial theme for the UI. The header toggle still switches themes client-side per session.',
    group: 'general',
    type: 'enum',
    values: ['light', 'dark'],
    default: 'light',
    editable: true,
    restartRequired: false
  },
  {
    key: 'comment_format',
    label: 'Comment format',
    description: 'Template preset used when adopting an AI suggestion into a review comment.',
    group: 'general',
    type: 'enum',
    values: ['legacy', 'minimal', 'plain', 'emoji-only', 'maximal'],
    default: 'legacy',
    editable: true,
    restartRequired: false
  },
  {
    key: 'comment_button_action',
    label: 'Default review button action',
    description: 'Primary action of the split submit button (Submit vs. Preview).',
    group: 'general',
    type: 'enum',
    values: ['submit', 'preview'],
    default: 'submit',
    editable: true,
    restartRequired: false
  },
  {
    key: 'enable_graphite',
    label: 'Show Graphite links',
    description: 'Show Graphite links alongside GitHub links in the PR header.',
    group: 'general',
    type: 'boolean',
    default: false,
    editable: true,
    restartRequired: false
  },
  {
    key: 'external_comments',
    label: 'GitHub comment sync',
    description: 'Enable syncing GitHub PR review comments into the External segment. Mounts extra routes at startup.',
    group: 'general',
    type: 'boolean',
    default: false,
    editable: true,
    restartRequired: true
  },
  {
    key: 'assisted_by_url',
    label: 'Assisted-by URL',
    description: 'URL for the "Review assisted by" footer link.',
    group: 'general',
    type: 'string',
    default: 'https://github.com/in-the-loop-labs/pair-review',
    editable: true,
    restartRequired: false
  },

  // ---- AI defaults -------------------------------------------------------
  {
    key: 'default_provider',
    label: 'Default provider',
    description: 'AI provider used for analysis when none is picked explicitly.',
    group: 'ai',
    type: 'string',
    default: 'claude',
    editable: true,
    restartRequired: false
  },
  {
    key: 'default_model',
    label: 'Default model',
    description: 'Model within the default provider used when none is picked explicitly.',
    group: 'ai',
    type: 'string',
    default: 'opus',
    editable: true,
    restartRequired: false
  },

  // ---- Summaries ---------------------------------------------------------
  {
    key: 'summaries.enabled',
    label: 'Enable summaries',
    description: 'Make the hunk-summaries feature available (toolbar button + per-file toggles).',
    group: 'summaries',
    type: 'boolean',
    default: false,
    editable: true,
    restartRequired: false
  },
  {
    key: 'summaries.auto_generate',
    label: 'Auto-generate summaries',
    description: 'Kick off summary generation automatically on review load.',
    group: 'summaries',
    type: 'boolean',
    default: true,
    editable: true,
    restartRequired: false
  },
  {
    key: 'summaries.provider',
    label: 'Summaries provider',
    description: 'Provider for hunk-summary tasks. Empty falls back to the default provider.',
    group: 'summaries',
    type: 'string',
    default: '',
    editable: true,
    restartRequired: false
  },
  {
    key: 'summaries.model',
    label: 'Summaries model',
    description: "Model for hunk-summary tasks. Empty uses the provider's fast tier, then the default model.",
    group: 'summaries',
    type: 'string',
    default: '',
    editable: true,
    restartRequired: false
  },
  {
    key: 'summaries.max_files',
    label: 'Summaries file cap',
    description: 'Skip summary generation for reviews touching more than this many files.',
    group: 'summaries',
    type: 'integer',
    default: 50,
    editable: true,
    restartRequired: false
  },
  {
    key: 'summaries.max_lines_added',
    label: 'Summaries added-line cap',
    description: 'Skip summary generation when the diff adds more than this many lines.',
    group: 'summaries',
    type: 'integer',
    default: 3000,
    editable: true,
    restartRequired: false
  },

  // ---- Tours -------------------------------------------------------------
  {
    key: 'tours.enabled',
    label: 'Enable tours',
    description: 'Make the guided-tour feature available (toolbar button visible).',
    group: 'tours',
    type: 'boolean',
    default: false,
    editable: true,
    restartRequired: false
  },
  {
    key: 'tours.auto_generate',
    label: 'Auto-generate tours',
    description: 'Kick off tour generation automatically on review load.',
    group: 'tours',
    type: 'boolean',
    default: true,
    editable: true,
    restartRequired: false
  },
  {
    key: 'tours.provider',
    label: 'Tours provider',
    description: 'Provider for tour generation. Empty falls back to the summaries provider, then the default provider.',
    group: 'tours',
    type: 'string',
    default: '',
    editable: true,
    restartRequired: false
  },
  {
    key: 'tours.model',
    label: 'Tours model',
    description: 'Model for tour generation. Empty falls back to summaries model resolution.',
    group: 'tours',
    type: 'string',
    default: '',
    editable: true,
    restartRequired: false
  },

  // ---- Chat --------------------------------------------------------------
  {
    key: 'enable_chat',
    label: 'Enable chat',
    description: 'Enable the chat panel feature.',
    group: 'chat',
    type: 'boolean',
    default: true,
    editable: true,
    restartRequired: false
  },
  {
    key: 'chat_provider',
    label: 'Chat provider',
    description: "Chat provider ('pi', 'copilot-acp', 'opencode-acp', 'cursor-acp', 'codex').",
    group: 'chat',
    type: 'string',
    default: 'pi',
    editable: true,
    restartRequired: false
  },
  {
    key: 'chat.enable_shortcuts',
    label: 'Chat action shortcuts',
    description: 'Show action shortcut buttons in the chat panel.',
    group: 'chat',
    type: 'boolean',
    default: true,
    editable: true,
    restartRequired: false
  },
  {
    key: 'chat.enter_to_send',
    label: 'Enter to send',
    description: 'Pressing Enter sends the chat message (instead of inserting a newline).',
    group: 'chat',
    type: 'boolean',
    default: true,
    editable: true,
    restartRequired: false
  },
  {
    key: 'chat_spinner',
    label: 'Chat spinner style',
    description: 'Animation shown while the chat agent is working.',
    group: 'chat',
    type: 'enum',
    values: ['dots', 'loop'],
    default: 'dots',
    editable: true,
    restartRequired: false
  },

  // ---- Advanced (restart required) --------------------------------------
  {
    key: 'worktree_retention_days',
    label: 'Worktree retention (days)',
    description: 'Delete stale PR worktrees older than this many days.',
    group: 'advanced',
    type: 'integer',
    default: 7,
    editable: true,
    restartRequired: true
  },
  {
    key: 'review_retention_days',
    label: 'Review retention (days)',
    description: 'Delete stale reviews older than this many days.',
    group: 'advanced',
    type: 'integer',
    default: 21,
    editable: true,
    restartRequired: true
  },
  {
    key: 'dev_mode',
    label: 'Dev mode',
    description: 'Disable static file caching for development.',
    group: 'advanced',
    type: 'boolean',
    default: false,
    editable: true,
    restartRequired: true
  },
  {
    key: 'debug_stream',
    label: 'Debug provider streaming',
    description: 'Log AI provider streaming events (equivalent to --debug-stream).',
    group: 'advanced',
    type: 'boolean',
    default: false,
    editable: true,
    restartRequired: true
  },
  {
    key: 'yolo',
    label: 'YOLO mode',
    description: 'Skip fine-grained AI provider permission setup (equivalent to --yolo).',
    group: 'advanced',
    type: 'boolean',
    default: false,
    editable: true,
    restartRequired: true,
    envVar: 'PAIR_REVIEW_YOLO'
  },

  // ---- Read-only (bootstrap / sensitive / complex) ----------------------
  {
    key: 'skip_update_notifier',
    label: 'Skip update notifier',
    description: 'Suppress the "update available" notification on exit. Read from config files at startup by the CLI wrapper (bin/pair-review.js) BEFORE the database opens, so an in-app override can never take effect — set it in a config file.',
    group: 'readonly',
    type: 'boolean',
    default: false,
    editable: false,
    restartRequired: true
  },
  {
    key: 'port',
    label: 'Port',
    description: 'Server port. Bootstrap value; edit via config file or PORT env var.',
    group: 'readonly',
    type: 'integer',
    default: 7247,
    editable: false,
    restartRequired: true,
    envVar: 'PORT'
  },
  {
    key: 'single_port',
    label: 'Single-port mode',
    description: 'Reuse a single server on the configured port; new invocations delegate to it.',
    group: 'readonly',
    type: 'boolean',
    default: true,
    editable: false,
    restartRequired: true,
    envVar: 'PAIR_REVIEW_SINGLE_PORT'
  },
  {
    key: 'db_name',
    label: 'Database filename',
    description: 'Custom database filename. Selects the DB that would hold these overrides, so it cannot be set in-app.',
    group: 'readonly',
    type: 'string',
    default: '',
    editable: false,
    restartRequired: true,
    envVar: 'PAIR_REVIEW_DB_NAME'
  },
  {
    key: 'github_token',
    label: 'GitHub token',
    description: 'GitHub Personal Access Token. Never editable in-app; set via config file or GITHUB_TOKEN.',
    group: 'readonly',
    type: 'string',
    default: '',
    editable: false,
    restartRequired: true,
    sensitive: true,
    envVar: 'GITHUB_TOKEN'
  },
  {
    key: 'github_token_command',
    label: 'GitHub token command',
    description: 'Shell command whose stdout is used as the GitHub token.',
    group: 'readonly',
    type: 'string',
    default: 'gh auth token',
    editable: false,
    restartRequired: true
  },
  {
    key: 'providers',
    label: 'AI providers',
    description: 'Custom AI analysis provider configurations from config files.',
    group: 'readonly',
    type: 'object',
    default: {},
    editable: false,
    restartRequired: true
  },
  {
    key: 'chat_providers',
    label: 'Chat providers',
    description: 'Custom chat provider configurations from config files.',
    group: 'readonly',
    type: 'object',
    default: {},
    editable: false,
    restartRequired: true
  },
  {
    key: 'repos',
    label: 'Repositories',
    description: 'Per-repository configurations from config files.',
    group: 'readonly',
    type: 'object',
    default: {},
    editable: false,
    restartRequired: true
  },
  {
    key: 'hooks',
    label: 'Hooks',
    description: 'Hook commands per event from config files.',
    group: 'readonly',
    type: 'object',
    default: {},
    editable: false,
    restartRequired: true
  }
];

const REGISTRY_BY_KEY = new Map(REGISTRY.map((e) => [e.key, e]));

/** Allowed badge values for both sections and individual settings (null = none). */
const BADGE_VALUES = new Set(['new', 'beta']);

/**
 * Ordered UI sections. `id` matches an entry's `group`. Titles/descriptions are
 * lifted verbatim from the frontend so /api/settings can drive the section nav
 * (order, titles, badges) instead of the page deriving them locally.
 *
 * Tours ships with a 'beta' badge (feature-gated, off by default) — a product
 * call, trivially changed here without touching the frontend.
 */
const SECTIONS = [
  { id: 'general', title: 'General', description: 'Basic application preferences.', badge: null },
  { id: 'ai', title: 'AI Defaults', description: 'Default provider and model used for analysis and chat.', badge: null },
  { id: 'summaries', title: 'Summaries', description: 'Automatic PR summary generation.', badge: null },
  { id: 'tours', title: 'Tours', description: 'Automatic code tour generation.', badge: 'beta' },
  { id: 'chat', title: 'Chat', description: 'The AI chat assistant.', badge: null },
  { id: 'advanced', title: 'Advanced', description: 'These are captured at startup — changes take effect after you restart pair-review.', badge: null },
  { id: 'readonly', title: 'From config files & environment', description: 'Read-only here. Set these via config files, CLI flags, or environment variables.', badge: null }
];

const SECTION_IDS = new Set(SECTIONS.map((s) => s.id));

/** @returns {Array<Object>} The full registry catalog (shared reference — do not mutate). */
function getRegistry() {
  return REGISTRY;
}

/** @returns {Array<Object>} The ordered section catalog (shared reference — do not mutate). */
function getSections() {
  return SECTIONS;
}

/**
 * @param {string} id - Section id
 * @returns {boolean} Whether the id is a known section.
 */
function isSectionId(id) {
  return SECTION_IDS.has(id);
}

/**
 * @param {string} key - Dot-path key
 * @returns {Object|null} The registry entry, or null when the key is unknown.
 */
function getEntry(key) {
  return REGISTRY_BY_KEY.get(key) || null;
}

/**
 * Read a dot-path value out of a plain object. Returns undefined when any
 * segment is missing. Walks own-property presence via `hasPath` semantics
 * only where needed; this getter tolerates absent intermediate objects.
 * @param {Object} obj
 * @param {string} dotPath
 * @returns {*}
 */
function getPath(obj, dotPath) {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = dotPath.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Whether a dot-path is defined as an own property at every level of `obj`.
 * Uses hasOwnProperty (NOT truthiness) so that a value of `false`, `0`, or
 * `''` still counts as "defined" — essential for correct source attribution.
 * @param {Object} obj
 * @param {string} dotPath
 * @returns {boolean}
 */
function hasPath(obj, dotPath) {
  if (!obj || typeof obj !== 'object') return false;
  const parts = dotPath.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) {
      return false;
    }
    cur = cur[part];
  }
  return true;
}

/**
 * Set a dot-path value on a plain object, creating intermediate plain objects
 * as needed. Mutates `obj` in place.
 * @param {Object} obj
 * @param {string} dotPath
 * @param {*} value
 */
function setPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cur[part] === null || typeof cur[part] !== 'object' || Array.isArray(cur[part])) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Validate a candidate value against a registry entry's type/enum/bounds.
 * Does NOT check `editable` — callers decide whether a non-editable key may be
 * written (the API rejects those before reaching here).
 *
 * @param {Object} entry - Registry entry
 * @param {*} value - Candidate value
 * @returns {{ valid: boolean, error?: string }}
 */
function validateValue(entry, value) {
  if (!entry) return { valid: false, error: 'Unknown setting' };
  switch (entry.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        return { valid: false, error: `${entry.key} must be a boolean` };
      }
      return { valid: true };
    case 'string':
      if (typeof value !== 'string') {
        return { valid: false, error: `${entry.key} must be a string` };
      }
      return { valid: true };
    case 'integer':
      if (!Number.isInteger(value) || value < 0) {
        return { valid: false, error: `${entry.key} must be a non-negative integer` };
      }
      return { valid: true };
    case 'enum':
      if (!Array.isArray(entry.values) || !entry.values.includes(value)) {
        return { valid: false, error: `${entry.key} must be one of: ${(entry.values || []).join(', ')}` };
      }
      return { valid: true };
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { valid: false, error: `${entry.key} must be an object` };
      }
      return { valid: true };
    default:
      return { valid: false, error: `Unsupported type for ${entry.key}` };
  }
}

module.exports = {
  getRegistry,
  getSections,
  isSectionId,
  getEntry,
  getPath,
  hasPath,
  setPath,
  validateValue,
  REGISTRY,
  SECTIONS,
  BADGE_VALUES
};
