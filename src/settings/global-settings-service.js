// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * GlobalSettingsService
 *
 * Owns the effective value + source attribution for every global setting, and
 * the read/write of in-app overrides (the `global_settings` table). It is the
 * single authority the /settings API talks to.
 *
 * Precedence (highest first), per the design plan:
 *   in-app (DB override) > env/CLI > project config.local > project config >
 *   ~/.pair-review config.local > ~/.pair-review config > managed config >
 *   built-in default
 *
 * `buildEffectiveConfig()` produces the object stored via `app.set('config')`.
 * It folds DB overrides into the merged file config so every per-request
 * `req.app.get('config')` reader honors them. It does NOT fold env vars — those
 * have always been consumed at their point of use (e.g. the review-config
 * ladder, resolveDbName), and folding them would double-apply.
 *
 * Two config-driven controls layer on top:
 *   - `settings_ui.hidden` (a PREFERENCE, read from the merged effective config
 *     so a higher layer can un-hide with `[]`): omits entries from the API and
 *     rejects both PUT and DELETE. Mixes section ids and setting keys.
 *   - `final` (a LOCK, computed as the UNION across all RAW layers so a higher
 *     layer cannot un-final): a finalized key ignores the app + env tiers, is
 *     excluded from `_globalOverrides`, and rejects PUT (DELETE is allowed —
 *     it just removes the ignored DB row). The finalized registry keys are
 *     carried on the effective config as `_finalKeys` for point-of-use
 *     env-defeat (review-config.js, routes/shared.js getModel).
 */

const logger = require('../utils/logger');
const {
  getRegistry, getSections, getEntry, getPath, hasPath, setPath, validateValue
} = require('./registry');
const { GlobalSettingsRepository } = require('../database');

/**
 * File layers below env, ordered highest-precedence first for attribution.
 * `default` is handled as the final fallback (registry default), not scanned
 * here, so a raw layer's missing key falls through to the registry default.
 */
const FILE_LAYER_ORDER = ['project.local', 'project', 'config.local', 'config', 'managed'];

/** JSON deep clone — config is always JSON-serializable (files + DEFAULT_CONFIG). */
function deepClone(obj) {
  return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
}

/**
 * Validate a candidate hidden/final declaration into a clean array of strings.
 * Anything that is not an array is logged and treated as empty; non-string
 * members are dropped. Used for both `settings_ui.hidden` (merged config) and
 * per-layer `final` arrays.
 * @param {*} value
 * @param {string} label - For diagnostics (e.g. 'settings_ui.hidden').
 * @returns {string[]}
 */
function toStringList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    logger.warn(`GlobalSettingsService: ${label} must be an array of strings; ignoring`);
    return [];
  }
  const out = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else logger.warn(`GlobalSettingsService: ${label} entry ${JSON.stringify(item)} is not a string; ignoring`);
  }
  return out;
}

/**
 * Property names whose values are secrets and must never be shipped to the
 * client. Matched case-insensitively as a substring of the key, so `token`,
 * `github_token`, `apiKey`, `api_key`, `client_secret`, `password`,
 * `authorization`, and `passphrase` all redact. Read-only object settings
 * (providers / chat_providers / hooks) can embed these under config files.
 */
const SECRET_KEY_PATTERN = /(token|secret|password|passphrase|api[-_]?key|apikey|auth|credential|bearer)/i;

/** The literal used in place of a redacted secret value in API payloads. */
const REDACTED = '***redacted***';

/**
 * Deep-clone a JSON-serializable value, replacing any property whose key looks
 * like a secret (SECRET_KEY_PATTERN) with a fixed redaction marker. Used before
 * shipping object-type read-only settings to the client so config-file secrets
 * (tokens, API keys) never leave the server. Arrays are walked element-wise;
 * primitives pass through unchanged.
 * @param {*} value
 * @returns {*}
 */
function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        // Redact regardless of the value's shape — a nested secret object is
        // just as sensitive as a string token.
        out[k] = REDACTED;
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * Coerce a raw env-var string into the entry's type for display. Env vars are
 * always strings; this is best-effort for the settings page only.
 * @param {Object} entry
 * @param {string} raw
 * @returns {*}
 */
function coerceEnvValue(entry, raw) {
  switch (entry.type) {
    case 'boolean': {
      const lower = String(raw).toLowerCase();
      if (lower === 'true' || lower === '1') return true;
      if (lower === 'false' || lower === '0') return false;
      return Boolean(raw);
    }
    case 'integer': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    default:
      return raw;
  }
}

class GlobalSettingsService {
  /**
   * @param {Object} opts
   * @param {Object} opts.db - Database handle
   * @param {Object} opts.baseConfig - Fully merged file config (post loadConfig,
   *   env PORT/single_port already applied). Deep-cloned on construction.
   * @param {Array<{name: string, data: Object}>} opts.layers - Ordered raw
   *   config layers (low->high) from loadConfig, for source attribution.
   */
  constructor({ db, baseConfig, layers }) {
    this.db = db;
    this.repo = new GlobalSettingsRepository(db);
    this.baseConfig = deepClone(baseConfig) || {};
    // Index layers by name for O(1) lookup; keep only known layer names.
    this.layersByName = {};
    for (const layer of (layers || [])) {
      if (layer && layer.name) this.layersByName[layer.name] = layer.data || {};
    }

    // Config-driven hiding (`settings_ui.hidden`): a personal/org PREFERENCE
    // read from the MERGED effective config (normal deepMerge, arrays replace
    // wholesale — a higher layer can un-hide with `"hidden": []`). Mixes section
    // ids and setting keys. Hidden entries are omitted from the API and reject
    // both PUT and DELETE.
    this.hiddenIds = new Set(
      toStringList(getPath(this.baseConfig, 'settings_ui.hidden'), 'settings_ui.hidden')
    );

    // Config-driven locking (`final`): a LOCK computed as the UNION across ALL
    // RAW layers (deliberately NOT the deepMerged array — a higher layer cannot
    // un-final; the declaration must be removed where it lives). Mixes section
    // ids and setting keys. A finalized key ignores the app + env tiers.
    this.finalIds = new Set();
    for (const layerName of Object.keys(this.layersByName)) {
      const list = toStringList(this.layersByName[layerName].final, `final (layer "${layerName}")`);
      for (const id of list) this.finalIds.add(id);
    }

    // Expand finalized section ids / keys to the concrete registry keys they
    // lock, for `_finalKeys` on the effective config (consulted by point-of-use
    // env-defeat in review-config.js / routes/shared.js getModel).
    this.finalKeys = getRegistry()
      .filter((entry) => this._isFinal(entry))
      .map((entry) => entry.key);
  }

  /**
   * Whether a registry entry is hidden by configuration (its key or its group
   * is listed in `settings_ui.hidden`).
   * @param {Object} entry
   * @returns {boolean}
   * @private
   */
  _isHidden(entry) {
    return this.hiddenIds.has(entry.key) || this.hiddenIds.has(entry.group);
  }

  /**
   * Whether a registry entry is locked as final by configuration (its key or
   * its group appears in the union of layer `final` arrays).
   * @param {Object} entry
   * @returns {boolean}
   * @private
   */
  _isFinal(entry) {
    return this.finalIds.has(entry.key) || this.finalIds.has(entry.group);
  }

  /**
   * Read the persisted overrides, filtered to editable registry keys with
   * type-valid values. Invalid or unknown rows are ignored (and logged) so a
   * stale/corrupt row can never break resolution.
   * @returns {Object} map of key -> parsed value
   */
  getOverrides() {
    let raw;
    try {
      raw = this.repo.getAll();
    } catch (error) {
      logger.warn(`GlobalSettingsService: failed to read overrides: ${error.message}`);
      return {};
    }
    const out = {};
    for (const [key, value] of Object.entries(raw || {})) {
      const entry = getEntry(key);
      if (!entry) {
        logger.debug(`GlobalSettingsService: ignoring override for unknown key "${key}"`);
        continue;
      }
      if (!entry.editable) {
        logger.debug(`GlobalSettingsService: ignoring override for non-editable key "${key}"`);
        continue;
      }
      if (this._isFinal(entry)) {
        // The key is locked as final by configuration. The row is ignored (so
        // it never affects resolution) but NOT deleted — un-finalizing later
        // restores it. clearOverride() can still remove it explicitly.
        logger.warn(`GlobalSettingsService: ignoring in-app override for "${key}" — locked as final by configuration`);
        continue;
      }
      const { valid, error } = validateValue(entry, value);
      if (!valid) {
        logger.warn(`GlobalSettingsService: ignoring invalid override for "${key}": ${error}`);
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  /**
   * Build the effective config object: a clone of the merged file config with
   * in-app overrides applied by dot-path. Carries a `_globalOverrides` map of
   * the applied overrides so the review-config ladder can rank an in-app
   * default_provider/default_model override above env vars (see
   * src/review-config.js). `_globalOverrides` is read by key, never serialized
   * wholesale by any route.
   *
   * ORDERING CONTRACT — read before adding a new call site.
   * Every entry point (src/server.js, src/main.js, src/mcp-stdio.js) MUST fold
   * this overlay into its config object IMMEDIATELY after opening the database
   * and BEFORE any consumer that latches a config value into module-level or
   * closure-captured state. Applying it late means an in-app override silently
   * never takes effect, even after the restart its `restartRequired` badge
   * promises. Known latching consumers:
   *   - `applyConfigOverrides(config)` (src/ai) snapshots `config.yolo` into the
   *     module-level `yoloMode` in the provider runtime (src/ai/provider.js).
   *   - `logger.setStreamDebugEnabled(config.debug_stream)` flips a logger flag.
   *   - The `devMode = config.dev_mode === true` const in src/server.js is
   *     captured by the static-file `setHeaders` closure.
   *   - `warnIfDevModeWithoutDbName(config)` reads `config.dev_mode`.
   *   - The MCP `start_analysis` tool reads `config._globalOverrides` for its
   *     provider/model ladder (src/routes/mcp.js) — a config passed without this
   *     overlay resolves as if no in-app override existed.
   * `buildEffectiveConfig` deep-clones its base internally, so reordering a
   * caller to fold it earlier is always safe.
   *
   * @param {Object} [overrides] - Pre-read overrides (avoids a second DB read)
   * @returns {Object}
   */
  buildEffectiveConfig(overrides = this.getOverrides()) {
    const effective = deepClone(this.baseConfig) || {};
    // `getOverrides()` already excludes finalized keys, so neither the applied
    // dot-path sets nor `_globalOverrides` can carry a locked key.
    for (const [key, value] of Object.entries(overrides)) {
      setPath(effective, key, value);
    }
    effective._globalOverrides = { ...overrides };
    // Finalized registry keys, for point-of-use consumers that read env/CLI
    // directly (review-config ladder, routes/shared.js getModel) and must skip
    // env for a locked key.
    effective._finalKeys = [...this.finalKeys];
    return effective;
  }

  /**
   * Resolve a single setting's effective value and source.
   * @param {string} key
   * @param {Object} [overrides] - Pre-read overrides (avoids a DB read per key)
   * @returns {{ value: *, source: string }|null} null when key is unknown
   */
  resolve(key, overrides = this.getOverrides()) {
    const entry = getEntry(key);
    if (!entry) return null;

    // A finalized key ignores the app AND env tiers: the value comes from the
    // highest file layer that defines it, else the built-in default. (The row,
    // if any, was already dropped from `overrides` by getOverrides().)
    const isFinal = this._isFinal(entry);

    // 1. In-app DB override (editable keys only; never for final keys).
    if (!isFinal && entry.editable && Object.prototype.hasOwnProperty.call(overrides, key)) {
      return { value: overrides[key], source: 'app' };
    }

    // 2. Env var (registry-declared; skipped for final keys). Empty string counts as unset.
    if (!isFinal && entry.envVar) {
      const raw = process.env[entry.envVar];
      if (raw !== undefined && raw !== '') {
        return { value: coerceEnvValue(entry, raw), source: 'env' };
      }
    }

    // 3. File layers, highest precedence first (own-property presence, not
    //    truthiness, so false/0/'' still attribute correctly).
    for (const layerName of FILE_LAYER_ORDER) {
      const data = this.layersByName[layerName];
      if (data && hasPath(data, key)) {
        return { value: getPath(data, key), source: layerName };
      }
    }

    // 4. Built-in default.
    return { value: entry.default, source: 'default' };
  }

  /**
   * Build the API descriptor array for every VISIBLE registry entry. Entries
   * hidden by `settings_ui.hidden` (by key or by group) are omitted entirely.
   * @returns {Array<Object>}
   */
  describe() {
    const overrides = this.getOverrides();
    const effective = this.buildEffectiveConfig(overrides);
    return getRegistry()
      .filter((entry) => !this._isHidden(entry))
      .map((entry) => this._describeEntry(entry, overrides, effective));
  }

  /**
   * Build the ordered section metadata for the API, omitting any section that
   * has zero visible settings. Titles/descriptions/badges come from the
   * registry SECTIONS catalog.
   * @param {Array<Object>} [settings] - Pre-computed descriptors (from describe())
   * @returns {Array<{id: string, title: string, description: string|null, badge: string|null}>}
   */
  describeSections(settings = this.describe()) {
    const present = new Set((settings || []).map((s) => s.group));
    return getSections()
      .filter((section) => present.has(section.id))
      .map((section) => ({
        id: section.id,
        title: section.title,
        description: section.description || null,
        badge: section.badge || null,
        // Build-time visibility default (registry SECTIONS `hidden: true`). The
        // settings page renderer omits hidden sections; kept separate from the
        // config-driven `settings_ui.hidden` preference.
        hidden: Boolean(section.hidden)
      }));
  }

  /**
   * Describe a single registry entry (metadata + effective value + source).
   * @private
   */
  _describeEntry(entry, overrides, effective) {
    const resolved = this.resolve(entry.key, overrides);
    const descriptor = {
      key: entry.key,
      label: entry.label,
      description: entry.description,
      group: entry.group,
      type: entry.type,
      values: entry.values || null,
      default: entry.default,
      editable: Boolean(entry.editable),
      restartRequired: Boolean(entry.restartRequired),
      sensitive: Boolean(entry.sensitive),
      badge: entry.badge || null,
      final: this._isFinal(entry),
      source: resolved ? resolved.source : 'default',
      overrideValue: Object.prototype.hasOwnProperty.call(overrides, entry.key)
        ? overrides[entry.key]
        : null
    };

    if (entry.sensitive) {
      // Never leak the secret; report only whether one is configured. Consider
      // the env var, the literal value, and the token command all as "set".
      const envSet = entry.envVar && process.env[entry.envVar];
      const literalSet = getPath(effective, entry.key);
      const commandSet = entry.key === 'github_token' ? getPath(effective, 'github_token_command') : null;
      descriptor.value = null;
      descriptor.configured = Boolean(envSet || literalSet || commandSet);
    } else if (entry.type === 'object') {
      // Ship the FULL object (not just a count) so the page can render its
      // contents inline — but redact any embedded secrets first. providers /
      // chat_providers / hooks can carry tokens/API keys from config files;
      // those must never reach the client.
      const obj = getPath(effective, entry.key);
      const isPlainObject = obj && typeof obj === 'object' && !Array.isArray(obj);
      descriptor.value = isPlainObject ? redactSecrets(obj) : {};
    } else {
      descriptor.value = resolved ? resolved.value : entry.default;
    }

    return descriptor;
  }

  /**
   * Validate + persist an in-app override, returning the fresh descriptor and
   * the recomputed effective config for the caller to `app.set('config')`.
   * @param {string} key
   * @param {*} value
   * @returns {{ ok: boolean, status?: number, error?: string, setting?: Object, effectiveConfig?: Object }}
   */
  async setOverride(key, value) {
    const entry = getEntry(key);
    if (!entry) return { ok: false, status: 400, error: `Unknown setting "${key}"` };
    // Hidden blocks both PUT and DELETE; final blocks PUT only. Check hidden
    // first so a key that is both reports the preference-level reason.
    if (this._isHidden(entry)) return { ok: false, status: 400, error: 'hidden by configuration' };
    if (this._isFinal(entry)) return { ok: false, status: 400, error: 'locked as final by configuration' };
    if (!entry.editable) return { ok: false, status: 400, error: `Setting "${key}" is read-only` };
    const { valid, error } = validateValue(entry, value);
    if (!valid) return { ok: false, status: 400, error };

    // An empty string on a key with a non-empty default can never win: every
    // consumer resolves these via `||` chains, so env/files would still apply
    // while the source badge claimed "in-app". Treat it as clearing the
    // override instead. Keys whose default IS '' keep '' as a real value
    // ("inherit" semantics for provider/model sub-keys).
    if (entry.type === 'string' && value === '' && entry.default !== '') {
      return this.clearOverride(key);
    }

    await this.repo.set(key, value);
    const overrides = this.getOverrides();
    const effectiveConfig = this.buildEffectiveConfig(overrides);
    const setting = this._describeEntry(entry, overrides, effectiveConfig);
    return { ok: true, setting, effectiveConfig };
  }

  /**
   * Clear an in-app override (idempotent — clearing an unset key still succeeds).
   * @param {string} key
   * @returns {{ ok: boolean, status?: number, error?: string, setting?: Object, effectiveConfig?: Object }}
   */
  async clearOverride(key) {
    const entry = getEntry(key);
    if (!entry) return { ok: false, status: 400, error: `Unknown setting "${key}"` };
    // Hidden blocks DELETE too. Final does NOT: clearing a finalized key removes
    // the ignored DB row (no effective-value change), which is allowed.
    if (this._isHidden(entry)) return { ok: false, status: 400, error: 'hidden by configuration' };

    await this.repo.delete(key);
    const overrides = this.getOverrides();
    const effectiveConfig = this.buildEffectiveConfig(overrides);
    const setting = this._describeEntry(entry, overrides, effectiveConfig);
    return { ok: true, setting, effectiveConfig };
  }
}

module.exports = { GlobalSettingsService, coerceEnvValue, redactSecrets, FILE_LAYER_ORDER };
