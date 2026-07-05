// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Repo Links Resolver
 *
 * Resolves per-repo header link configuration. Configuration shape:
 *
 *   "links": {
 *     "external": { "label": "...", "url_template": "https://...", "icon": "<svg ...>...</svg>" },
 *     "github": false,    // hide default GitHub link
 *     "graphite": false   // hide Graphite stack link
 *   }
 *
 * Public API:
 *
 *   substituteUrlTemplate(template, context)
 *       — Replace whitelisted placeholders `{owner}`, `{repo}`, `{number}`,
 *         `{branch}`, `{base_branch}`, `{head_sha}` with URL-encoded values
 *         from `context`. Returns `null` if the resulting URL does not start
 *         with `https://` or if the template is malformed.
 *
 *   sanitizeSvgIcon(svg)
 *       — Strip `<script>` tags, on* event-handler attributes, and
 *         `javascript:` URLs. Returns the sanitised SVG string, or null if
 *         the value is not a string that looks like SVG markup.
 *
 *   resolveRepoLinks(config, repository)
 *       — Returns `{ external, github, graphite }` for the given
 *         `owner/repo`. The booleans are normalised: any non-false value (or
 *         absence) becomes `true`. `external` is `null` unless valid, with
 *         the icon already sanitised.
 */

const { getRepoConfig } = require('../config');
const { isDualHostRepoConfig } = require('../utils/host-resolution');
const logger = require('../utils/logger');

// Whitelist of allowed `{placeholder}` names. Anything else in the template
// is left unsubstituted (so a malformed template surfaces visually rather
// than silently producing the wrong URL).
const ALLOWED_PLACEHOLDERS = new Set([
  'owner', 'repo', 'number', 'branch', 'base_branch', 'head_sha'
]);

// Matches HTML on* event-handler attributes regardless of quoting style.
// Used to strip dangerous attributes from user-supplied SVG icons.
const ON_HANDLER_RE = /\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g;

// Matches a complete `<script ...>...</script>` block (including the open
// and close tags) with case-insensitive, dot-matches-newline semantics so
// payload bodies that span lines are removed in one pass.
const SCRIPT_BLOCK_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;

// Matches standalone <script ...> open tags missing a closing tag — strip
// them as well so a half-broken payload can't slip through.
const SCRIPT_OPEN_RE = /<script\b[^>]*>/gi;

// Matches values that begin with `javascript:` (anchor href, attribute
// values). Captures the leading quote so we can preserve attribute syntax.
const JS_URL_RE = /(["'=])\s*javascript:[^"'\s>]*/gi;

/**
 * Substitute whitelisted `{placeholder}` tokens in a URL template.
 *
 * Behaviour:
 *   - Only `{owner}`, `{repo}`, `{number}`, `{branch}`, `{base_branch}`,
 *     and `{head_sha}` are substituted. Other tokens are left as-is so
 *     misconfigurations are visible.
 *   - Each substituted value is run through `encodeURIComponent()` to
 *     prevent injection of additional path segments or query params.
 *   - The result is rejected (returns `null`) unless it starts with
 *     `https://`, the same invariant `validateRepoConfig` enforces at
 *     startup. This is defence-in-depth: a template like
 *     `https://{owner}.example/foo` is technically `https://` at config
 *     time but could be subverted at substitution time if `{owner}` were
 *     unescaped — `encodeURIComponent` protects against that.
 *
 * @param {string} template
 * @param {Object} context
 * @param {string} [context.owner]
 * @param {string} [context.repo]
 * @param {number|string} [context.number]
 * @param {string} [context.branch]
 * @param {string} [context.base_branch]
 * @param {string} [context.head_sha]
 * @returns {string|null} Substituted URL, or null if it fails validation
 */
function substituteUrlTemplate(template, context) {
  if (typeof template !== 'string' || !template) return null;
  const ctx = context || {};

  const substituted = template.replace(/\{([a-zA-Z_]+)\}/g, (match, name) => {
    if (!ALLOWED_PLACEHOLDERS.has(name)) return match;
    const value = ctx[name];
    if (value === undefined || value === null || value === '') return match;
    return encodeURIComponent(String(value));
  });

  if (!substituted.startsWith('https://')) return null;
  // If any unsubstituted whitelisted placeholders remain, the URL is
  // incomplete — reject rather than producing a broken link.
  for (const placeholder of ALLOWED_PLACEHOLDERS) {
    if (substituted.includes(`{${placeholder}}`)) return null;
  }
  return substituted;
}

/**
 * Strip dangerous content from user-supplied SVG markup.
 *
 * Removes:
 *   - `<script>...</script>` blocks (paired or unpaired)
 *   - All `on*=` event-handler attributes
 *   - Attribute values starting with `javascript:` (sets them to empty)
 *
 * This is the bare-minimum sanitisation called out in the plan. The
 * frontend additionally re-parses the SVG via DOMParser before injecting
 * it into the DOM, so any script-like content that slips through gets a
 * second filter at insertion time.
 *
 * @param {string} svg
 * @returns {string|null} Sanitised SVG, or null if the input is not a
 *                        string that looks like SVG markup.
 */
function sanitizeSvgIcon(svg) {
  if (typeof svg !== 'string' || !svg.trim()) return null;
  // Sanity check: the value should at least look like SVG markup. If it
  // doesn't, refuse — `<svg ...>` is the only contract.
  if (!/<svg\b/i.test(svg)) return null;

  let cleaned = svg
    .replace(SCRIPT_BLOCK_RE, '')
    .replace(SCRIPT_OPEN_RE, '')
    .replace(ON_HANDLER_RE, '')
    // Replace dangerous javascript: URLs with empty strings, preserving
    // the surrounding quote character so the attribute remains parseable.
    .replace(JS_URL_RE, (_match, lead) => `${lead}`);

  // Final guard: if any of the dangerous patterns survived (e.g.
  // mismatched encoding tricks), reject the whole icon.
  if (/<script\b/i.test(cleaned)) return null;
  if (/\son[a-zA-Z]+\s*=/i.test(cleaned)) return null;
  if (/javascript:/i.test(cleaned)) return null;

  return cleaned;
}

/**
 * Resolve link configuration for a repo. Reads `repos[owner/repo].links`
 * and produces a normalised object the frontend can act on without
 * further interpretation.
 *
 * `links.github` and `links.graphite` are booleans that gate the default
 * built-in links. Anything that isn't an explicit `false` (including
 * `undefined` and `true`) leaves the link enabled — preserving current
 * behaviour for repos that omit the `links` block entirely.
 *
 * For the external link, the icon is sanitised here, server-side. If
 * sanitisation strips the icon entirely (e.g. the input was hostile or
 * malformed), a warning is logged and `icon` becomes `null` — the link
 * is still rendered, just without a custom icon.
 *
 * **Per-PR host awareness (dual-host repos only).** `host` is the PR's
 * resolved host: `null` = github.com, an `api_host` URL string = the alt
 * host, `undefined` = unknown / not applicable. It only affects a
 * *dual-host* repo (`api_host` + `exclusive: false`):
 *   - `host === null` (github-hosted PR) → keep the GitHub/Graphite links
 *     (subject to any explicit `links.github/graphite: false`) and hide the
 *     alt-host external link.
 *   - `host === '<url>'` (alt-hosted PR) → keep the external link and hide
 *     the GitHub/Graphite links.
 * Exclusive alt-host repos and plain github repos ignore `host` entirely, so
 * existing two-arg callers (and `host === undefined`) render byte-identically
 * to before this parameter existed.
 *
 * @param {Object} config
 * @param {string} repository  Canonical `owner/repo` identifier
 * @param {string|null} [host]  PR's resolved host: null=github, url=alt,
 *                              undefined=unknown/not applicable
 * @returns {{ external: { label: string, url_template: string, icon: string|null }|null,
 *             github: boolean,
 *             graphite: boolean }}
 */
function resolveRepoLinks(config, repository, host = undefined) {
  const result = { external: null, github: true, graphite: true };
  if (!config || !repository) return result;

  const repoConfig = getRepoConfig(config, repository);
  if (!repoConfig || typeof repoConfig !== 'object') return result;

  const links = repoConfig.links;
  if (links && typeof links === 'object') {
    if (links.github === false) result.github = false;
    if (links.graphite === false) result.graphite = false;

    const ext = links.external;
    if (ext && typeof ext === 'object'
        && typeof ext.label === 'string' && ext.label
        && typeof ext.url_template === 'string'
        && ext.url_template.startsWith('https://')) {
      let icon = null;
      if (ext.icon !== undefined && ext.icon !== null && ext.icon !== '') {
        icon = sanitizeSvgIcon(ext.icon);
        if (icon === null) {
          logger.warn(
            `Dropping links.external.icon for "${repository}" — failed sanitisation.`
          );
        }
      }
      result.external = {
        // Optional host display name (e.g. "Meteorite"). When absent, the
        // field is null and consumers fall back to "GitHub" via resolveHostName.
        name: (typeof ext.name === 'string' && ext.name) ? ext.name : null,
        label: ext.label,
        url_template: ext.url_template,
        icon
      };
    }
  }

  // Per-PR host awareness for dual-host repos. A `host` of `undefined`
  // (omitted arg, unknown host) leaves the repo-level result untouched, so
  // non-dual repos and legacy two-arg callers are unaffected.
  if (host !== undefined && isDualHostRepoConfig(repoConfig)) {
    if (host === null) {
      // github-hosted PR: the alt-host external link does not apply.
      result.external = null;
    } else {
      // alt-hosted PR: hide the GitHub/Graphite links, keep the external one.
      result.github = false;
      result.graphite = false;
    }
  }

  return result;
}

/**
 * Resolve the display name of the remote code host for a repo, for use in
 * user-facing text in place of the literal "GitHub".
 *
 * Returns `repos[owner/repo].links.external.name` when configured, otherwise
 * `"GitHub"`. This is the server-side counterpart to the frontend
 * `window.RepoLinks.hostName()` accessor.
 *
 * Host-aware for dual-host repos: a github-hosted PR (`host === null`)
 * reports "GitHub" even when an external name is configured, because
 * `resolveRepoLinks` clears the external link for that host. See
 * `resolveRepoLinks` for the `host` semantics. Non-dual repos and two-arg
 * callers behave exactly as before.
 *
 * @param {Object} config
 * @param {string} repository  Canonical `owner/repo` identifier
 * @param {string|null} [host]  PR's resolved host: null=github, url=alt,
 *                              undefined=unknown/not applicable
 * @returns {string} The configured host name, or "GitHub" by default
 */
function resolveHostName(config, repository, host = undefined) {
  const links = resolveRepoLinks(config, repository, host);
  return (links.external && links.external.name) ? links.external.name : 'GitHub';
}

module.exports = {
  substituteUrlTemplate,
  sanitizeSvgIcon,
  resolveRepoLinks,
  resolveHostName,
  ALLOWED_PLACEHOLDERS,
};
