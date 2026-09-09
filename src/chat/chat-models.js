// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Chat Model Catalog
 *
 * Chat sessions borrow the *review* provider model catalogs (`static getModels()` on the
 * classes in `src/ai/*-provider.js`, merged with user config by `applyModelOverrides`) so
 * there is only one model list to maintain. A chat provider names its catalog via
 * `models_from` (see `chat-providers.js`); when that key is absent, `type` is used if it
 * happens to name a registered review provider. A provider with no catalog still works —
 * it simply has no models to pick from.
 *
 * Two pure functions, no I/O:
 * - `getChatModelCatalog` builds the picker payload. It strips every CLI-facing and
 *   internal field (`cli_model`, `extra_args`, `env`, `aliases`, `supports_chat`) so the
 *   API never leaks spawn details to the browser.
 * - `resolveChatModel` turns a selector (canonical id, alias, or a raw CLI string from
 *   `chat_providers.<id>.model`) into what a bridge needs at spawn time.
 *
 * Runtime fields (`cli_model`, `extra_args`, `env`) are resolved against the built-in
 * definition and the config override SEPARATELY — never against the merged catalog
 * entry. `mergeModels` replaces a matched built-in wholesale, so a partial override such
 * as `{ id: 'opus-5-high', tier: 'thorough', name: 'Team Opus' }` erases `cli_model` and
 * `env` on the merged entry; resolving off it would spawn `claude --model opus-5-high`
 * (not a real CLI model) with no effort env. This mirrors `_resolveModelConfig` in the
 * review providers, which has always used the field-level ladder.
 */

const {
  getProviderClass,
  getProviderConfigOverrides,
  applyModelOverrides,
  modelMatches,
  inferModelDefaults,
  prettifyModelId,
  resolveCliModelConfig,
} = require('../ai');
const { getChatProvider } = require('./chat-providers');
const logger = require('../utils/logger');

/**
 * Fields exposed to the chat model picker. Whitelisted (not blacklisted) so a new
 * CLI-facing field added to a review provider's catalog can never leak by default.
 * @type {string[]}
 */
const CATALOG_FIELDS = ['id', 'name', 'tier', 'tagline', 'badge', 'badgeClass', 'description'];

/**
 * Chat provider ids already warned about for a bad `models_from`. `GET /api/chat/providers`
 * walks every provider on every request, so the warning must be once per process, not once
 * per request. Module-level (not per-call) on purpose: the misconfiguration is static.
 * @type {Set<string>}
 */
const warnedBadCatalogSource = new Set();

/**
 * `<chatProviderId>:<selector>` pairs already warned about for naming an analysis-only
 * model (`supports_chat: false`). Same rationale as `warnedBadCatalogSource`: the
 * misconfiguration is static, and the resolver runs on every session create/resume.
 * @type {Set<string>}
 */
const warnedChatUnsupported = new Set();

/**
 * Test seam: clear the "already warned" memos so a test can assert the once-per-id
 * behaviour without leaking state into the next test file.
 */
function _resetForTests() {
  warnedBadCatalogSource.clear();
  warnedChatUnsupported.clear();
}

/**
 * The shape returned for "no model selected" / "provider default".
 * @returns {{id: null, cliModel: null, extraArgs: string[], env: Object, known: boolean}}
 */
function defaultResolution() {
  return { id: null, cliModel: null, extraArgs: [], env: {}, known: false };
}

/**
 * Resolve which review provider supplies a chat provider's model catalog.
 * Precedence: explicit `models_from` > `type` when it names a registered review
 * provider > no catalog. An unknown `models_from` yields no catalog rather than
 * silently falling back to `type` — a typo should be visible, not papered over.
 *
 * @param {Object|null} providerDef - Chat provider definition from `getChatProvider`
 * @returns {string|null} Registered review provider id, or null when there is no catalog
 */
function resolveChatCatalogProviderId(providerDef) {
  if (!providerDef) return null;

  if (providerDef.models_from) {
    if (getProviderClass(providerDef.models_from)) {
      return providerDef.models_from;
    }
    // A typo here silently costs the user their whole model picker, so it is a warning,
    // not a debug line. Deduped per chat provider id: the catalog is rebuilt for every
    // provider on every `GET /api/chat/providers`, and a static misconfiguration should
    // not scroll the log.
    if (!warnedBadCatalogSource.has(providerDef.id)) {
      warnedBadCatalogSource.add(providerDef.id);
      logger.warn(
        `[ChatModels] Chat provider "${providerDef.id}" has models_from="${providerDef.models_from}", ` +
        'which is not a registered review provider; no model catalog.'
      );
    }
    return null;
  }

  if (providerDef.type && getProviderClass(providerDef.type)) {
    return providerDef.type;
  }

  return null;
}

/**
 * Everything needed to resolve a chat model for a chat provider, in one lookup.
 *
 * `builtInModels` and `overrides` are kept alongside the merged list on purpose:
 * runtime fields must be resolved field-by-field against those two (see the module
 * header), while the merged list stays the source of truth for display, canonical
 * ids, aliases, and `disabled_models` filtering.
 *
 * @param {Object|null} providerDef - Chat provider definition
 * @returns {{builtInModels: Array<Object>, overrides: Object|undefined,
 *   merged: Array<Object>, effective: Array<Object>}|null} null when there is no catalog
 */
function catalogSourcesFor(providerDef) {
  const reviewId = resolveChatCatalogProviderId(providerDef);
  if (!reviewId) return null;

  const ProviderClass = getProviderClass(reviewId);
  if (!ProviderClass || typeof ProviderClass.getModels !== 'function') return null;

  try {
    const builtInModels = ProviderClass.getModels();
    if (!Array.isArray(builtInModels)) return null;
    const overrides = getProviderConfigOverrides(reviewId);
    const merged = applyModelOverrides(builtInModels, overrides);
    if (!Array.isArray(merged)) return null;
    // `supports_chat: false` marks an analysis-only catalog entry (Pi's `multi-model`
    // and `review-roulette` pseudo-models, whose extra_args load review skills that
    // have no meaning in a conversation). Filtering here — the chat-only choke point —
    // hides them from the picker AND from `resolveChatModel`, so a stale
    // `chat_providers.pi.model` cannot resurrect the skill args. The analysis catalog
    // is untouched.
    const effective = merged.filter(m => m.supports_chat !== false);
    return { builtInModels, overrides, merged, effective };
  } catch (err) {
    logger.warn(`[ChatModels] Failed to build model catalog from review provider "${reviewId}": ${err.message}`);
    return null;
  }
}

/**
 * Resolve the CLI-facing fields for one catalog entry, against the built-in definition
 * and the config override separately (never the merged entry — see the module header).
 *
 * Precedence matches `_resolveModelConfig` in the review providers: the config override
 * wins for `cli_model`, and `extra_args`/`env` are merged built-in first, override last.
 * Provider-level `providers.<id>.extra_args`/`env` are deliberately NOT folded in — those
 * shape the *analysis* CLI invocation; a chat session's provider-level args and env come
 * from `chat_providers.<id>` and are applied by the session manager.
 *
 * @param {{builtInModels: Array<Object>, overrides: Object|undefined}} sources
 * @param {Object} entry - A merged catalog entry (supplies the canonical id)
 * @param {string} [selector] - The selector the caller matched with (may be an alias)
 * @returns {{cliModel: string|null, extraArgs: string[], env: Object}}
 */
function runtimeFieldsFor(sources, entry, selector) {
  const builtIn = sources.builtInModels.find(bm => modelMatches(bm, entry.id)) || null;

  // A config override may key the model by the canonical id, by any built-in alias, or
  // by an alias it declares itself; match on the union so no lookup diverges.
  const modelKeys = new Set(
    [entry.id, selector, builtIn?.id, ...(builtIn?.aliases || [])].filter(Boolean)
  );
  const configModel = sources.overrides?.models?.find(
    cm => modelKeys.has(cm.id) || (cm.aliases || []).some(a => modelKeys.has(a))
  ) || null;

  return {
    cliModel: resolveCliModelConfig(builtIn, configModel, entry.id) ?? null,
    extraArgs: [...(builtIn?.extra_args || []), ...(configModel?.extra_args || [])],
    env: { ...(builtIn?.env || {}), ...(configModel?.env || {}) },
  };
}

/**
 * Project a review model definition onto the picker-safe field set.
 * Entries missing display metadata are run through `inferModelDefaults` so the picker
 * never shows a bare id. `inferModelDefaults` throws on a missing/invalid `tier`
 * (possible for a hand-written config model), so it is guarded — a malformed entry
 * degrades to a prettified id instead of taking down the whole catalog.
 *
 * @param {Object} model - Review provider model definition
 * @returns {{id: string, name: string, tier: string|null, tagline: string, badge: string|null, badgeClass: string|null, description: string}}
 */
function toCatalogEntry(model) {
  let source = model;
  if (!model.name || !model.badge || !model.badgeClass) {
    try {
      source = inferModelDefaults(model);
    } catch {
      source = { ...model, name: model.name || prettifyModelId(String(model.id)) };
    }
  }

  const entry = {};
  for (const field of CATALOG_FIELDS) {
    entry[field] = source[field] ?? null;
  }
  entry.name = entry.name || prettifyModelId(String(model.id));
  entry.tagline = entry.tagline || '';
  entry.description = entry.description || '';
  return entry;
}

/**
 * Build the chat model catalog for a chat provider.
 *
 * @param {string} chatProviderId - Chat provider id (e.g. 'claude', 'cursor-acp')
 * @param {Object|null} [providerDef] - Pre-resolved definition; pass it to avoid a second
 *   `getChatProvider` lookup (callers that already hold the def should always pass it)
 * @returns {{models: Array<Object>, configuredModel: string|null, hasCatalog: boolean}}
 *   `models` is empty when the provider has no catalog. `configuredModel` is
 *   `chat_providers.<id>.model` resolved to its canonical catalog id, the raw string when
 *   it is not in the catalog, or null when unset. `hasCatalog` means "there is something to
 *   pick from" — i.e. `models.length > 0`. A provider whose `models_from` resolves to a
 *   review provider that returns no models (or an empty list after `disabled_models`
 *   filtering) reports false, because from the picker's point of view it has no catalog.
 */
function getChatModelCatalog(chatProviderId, providerDef) {
  const def = providerDef !== undefined ? providerDef : getChatProvider(chatProviderId);
  const sources = catalogSourcesFor(def);
  const effective = sources?.effective || null;

  // Suppress catalog rows that ARE "provider default": no CLI model, no flags, no env
  // (Pi's and OMP's `default` entries). The picker renders its own "Provider default"
  // row, so listing these would show the same choice twice. Suppression is display-only —
  // `resolveChatModel` still resolves the id, so a stored session keeps working.
  const shown = (effective || []).filter(m => {
    const runtime = runtimeFieldsFor(sources, m);
    return !(runtime.cliModel === null
      && runtime.extraArgs.length === 0
      && Object.keys(runtime.env).length === 0);
  });
  const models = shown.map(toCatalogEntry);

  let configuredModel = null;
  const configured = def?.model;
  if (typeof configured === 'string' && configured.length > 0) {
    const match = effective?.find(m => modelMatches(m, configured)) || null;
    if (match) {
      // A configured model that is not a listed row (a suppressed "provider default"
      // entry) reports null so the picker lands on its own "Provider default" option.
      configuredModel = models.some(m => m.id === match.id) ? match.id : null;
    } else {
      // Unknown selectors pass through verbatim, except one naming an analysis-only
      // model — that is not a raw CLI string, it is a stale selection.
      const excluded = sources?.merged.some(m => modelMatches(m, configured) && m.supports_chat === false);
      configuredModel = excluded ? null : configured;
    }
  }

  return { models, configuredModel, hasCatalog: models.length > 0 };
}

/**
 * Resolve a model selector into the pieces a chat bridge needs at spawn time.
 *
 * Unknown selectors pass through verbatim: `chat_providers.<id>.model` has always held
 * raw CLI strings, and power users may type a model the catalog does not list.
 *
 * @param {string} chatProviderId - Chat provider id
 * @param {string|null} [selector] - Canonical catalog id, alias, or raw CLI string
 * @param {Object|null} [providerDef] - Pre-resolved definition (avoids a second lookup)
 * @returns {{id: string|null, cliModel: string|null, extraArgs: string[], env: Object, known: boolean}}
 *   `cliModel` is the `cli_model` ladder's result (config override > built-in > id); null
 *   means "omit the model flag" (the bridges already treat a null model that way).
 *   `known` is false for a passthrough. `id` is exactly what a caller should persist:
 *   the canonical id when known, the raw selector for a passthrough, and null when the
 *   selector resolves to nothing (absent, or an analysis-only model).
 */
function resolveChatModel(chatProviderId, selector, providerDef) {
  if (selector === null || selector === undefined) {
    return defaultResolution();
  }

  const def = providerDef !== undefined ? providerDef : getChatProvider(chatProviderId);
  const sources = catalogSourcesFor(def);
  const match = sources?.effective.find(m => modelMatches(m, selector)) || null;

  if (!match) {
    // A selector naming an analysis-only model (`supports_chat: false`) must NOT fall
    // through to passthrough: `--model review-roulette` is not a real CLI model, and
    // passing its extra_args would load a review skill into the conversation. Degrade
    // to the provider's own default instead, loudly but once.
    const excluded = sources?.merged.find(m => modelMatches(m, selector) && m.supports_chat === false);
    if (excluded) {
      const warnKey = `${chatProviderId}:${selector}`;
      if (!warnedChatUnsupported.has(warnKey)) {
        warnedChatUnsupported.add(warnKey);
        logger.warn(
          `[ChatModels] Model "${selector}" is analysis-only (supports_chat: false) and cannot be used ` +
          `for chat with provider "${chatProviderId}"; falling back to the provider default.`
        );
      }
      return defaultResolution();
    }
    return { id: selector, cliModel: selector, extraArgs: [], env: {}, known: false };
  }

  const runtime = runtimeFieldsFor(sources, match, selector);
  return {
    id: match.id,
    cliModel: runtime.cliModel,
    extraArgs: runtime.extraArgs,
    env: runtime.env,
    known: true,
  };
}

/**
 * Canonicalise a stored session model for API responses.
 *
 * A `chat_sessions.model` value can predate canonicalisation (an alias written by an
 * older build) or be null (meaning "provider default"). Rows are never rewritten — the
 * read side canonicalises so the sessions list, the create response, and the picker all
 * agree on one id.
 *
 * @param {string} chatProviderId - Chat provider id from the session row
 * @param {string|null|undefined} storedModel - `chat_sessions.model`
 * @returns {string|null} Canonical catalog id, the raw string for a passthrough, or null
 */
function canonicalChatModel(chatProviderId, storedModel) {
  if (storedModel === null || storedModel === undefined) return null;
  return resolveChatModel(chatProviderId, storedModel).id ?? null;
}

module.exports = {
  getChatModelCatalog,
  resolveChatModel,
  canonicalChatModel,
  resolveChatCatalogProviderId,
  _resetForTests,
};
