// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Repo Links UI Renderer
 *
 * Fetches `/api/repos/:owner/:repo/links` and renders the resulting
 * configuration into the review header:
 *
 *   - `links.external`: insert a new anchor button into the header icon
 *     group with the configured label, icon, and substituted URL.
 *   - `links.github === false`: hide `#github-link`.
 *   - `links.graphite === false`: hide `#graphite-link`.
 *
 * Shared between PR mode (public/js/pr.js) and Local mode
 * (public/js/local.js). Local mode only calls this when the review is
 * associated with a `repos` entry whose `owner/repo` is known.
 *
 * URL templates are substituted client-side because only the frontend
 * has the live PR/branch context (head_sha may change at any refresh).
 */
(function () {
  // Whitelist of allowed `{placeholder}` names in `url_template`. Must
  // match `ALLOWED_PLACEHOLDERS` in src/links/repo-links.js — kept in
  // sync because mismatch produces silent template drift.
  const ALLOWED_PLACEHOLDERS = [
    'owner', 'repo', 'number', 'branch', 'base_branch', 'head_sha'
  ];

  // The most recently resolved links + substitution context for the
  // current review. Stored so other code (ReviewModal, pr.js) can read
  // the configured host name / external URL / icon instead of hardcoding
  // "GitHub". `fetchAndApplyRepoLinks` refreshes these on every load.
  let _currentLinks = null;
  let _currentContext = null;

  /**
   * Substitute whitelisted placeholders in a URL template. Returns the
   * substituted URL, or null if any required placeholder is missing or
   * the result does not start with `https://`. Mirrors the server-side
   * implementation as defence-in-depth.
   *
   * @param {string} template
   * @param {Object} context
   * @returns {string|null}
   */
  function substituteUrlTemplate(template, context) {
    if (typeof template !== 'string' || !template) return null;
    const ctx = context || {};

    const substituted = template.replace(/\{([a-zA-Z_]+)\}/g, (match, name) => {
      if (!ALLOWED_PLACEHOLDERS.includes(name)) return match;
      const value = ctx[name];
      if (value === undefined || value === null || value === '') return match;
      return encodeURIComponent(String(value));
    });

    if (!substituted.startsWith('https://')) return null;
    for (const placeholder of ALLOWED_PLACEHOLDERS) {
      if (substituted.includes('{' + placeholder + '}')) return null;
    }
    return substituted;
  }

  /**
   * Parse a sanitised SVG string and return its root `<svg>` element,
   * or null if parsing fails. The server sanitises the SVG before
   * sending it down (strips scripts, on* handlers, javascript: URLs).
   * We DOMParse here as a second filter, and also so the DOM we insert
   * doesn't go through `innerHTML` on the live document.
   *
   * @param {string} svgString
   * @returns {SVGElement|null}
   */
  function parseSvgIcon(svgString) {
    if (typeof svgString !== 'string' || !svgString) return null;
    try {
      const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
      // image/svg+xml mode returns a <parsererror> root on bad input.
      const root = doc.documentElement;
      if (!root || root.nodeName !== 'svg') return null;
      // Belt-and-braces: strip dangerous attributes/elements even though
      // the server already removed them.
      stripDangerousAttributes(root);
      return root;
    } catch {
      return null;
    }
  }

  /**
   * Recursively strip on* event handlers and `javascript:` URLs from an
   * SVG element tree, and remove any `<script>` descendants. Defensive
   * second pass after server sanitisation.
   */
  function stripDangerousAttributes(element) {
    if (!element || !element.attributes) return;
    const attrs = Array.from(element.attributes);
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      const value = String(attr.value || '').toLowerCase();
      if (name.startsWith('on') || value.includes('javascript:')) {
        element.removeAttribute(attr.name);
      }
    }
    const children = Array.from(element.children || []);
    for (const child of children) {
      if (child.nodeName && child.nodeName.toLowerCase() === 'script') {
        child.remove();
        continue;
      }
      stripDangerousAttributes(child);
    }
  }

  /**
   * Build the external-link anchor element. Returns null if the URL
   * substitution fails (invalid template or missing required values).
   *
   * @param {Object} external  { label, url_template, icon }
   * @param {Object} context   substitution context
   * @returns {HTMLAnchorElement|null}
   */
  function buildExternalLink(external, context) {
    if (!external || typeof external !== 'object') return null;
    const url = substituteUrlTemplate(external.url_template, context);
    if (!url) {
      console.warn(
        '[repo-links] Dropping external link: url_template substitution failed',
        { template: external.url_template, context }
      );
      return null;
    }

    const anchor = document.createElement('a');
    anchor.className = 'btn btn-icon';
    anchor.id = 'external-link';
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.title = external.label;
    anchor.setAttribute('aria-label', external.label);

    if (external.icon) {
      const svg = parseSvgIcon(external.icon);
      if (svg) {
        // Ensure the icon scales like the existing header icons.
        if (!svg.getAttribute('width')) svg.setAttribute('width', '16');
        if (!svg.getAttribute('height')) svg.setAttribute('height', '16');
        anchor.appendChild(svg);
      } else {
        appendFallbackIcon(anchor);
      }
    } else {
      appendFallbackIcon(anchor);
    }

    return anchor;
  }

  /**
   * Append a generic "external link" SVG icon (an arrow leaving a box)
   * when no icon is configured or sanitisation rejected the supplied
   * SVG. Keeps the button visually consistent with the others.
   */
  function appendFallbackIcon(anchor) {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS(svgNs, 'path');
    // "open in new tab" icon: box with arrow leaving top-right corner.
    path.setAttribute('d', 'M3.75 2A1.75 1.75 0 0 0 2 3.75v8.5C2 13.216 2.784 14 3.75 14h8.5A1.75 1.75 0 0 0 14 12.25v-3a.75.75 0 0 0-1.5 0v3a.25.25 0 0 1-.25.25h-8.5a.25.25 0 0 1-.25-.25v-8.5a.25.25 0 0 1 .25-.25h3a.75.75 0 0 0 0-1.5h-3Zm6.97-.53a.75.75 0 0 0 0 1.06l1.72 1.72-4.97 4.97a.75.75 0 1 0 1.06 1.06l4.97-4.97 1.72 1.72a.75.75 0 0 0 1.28-.53V2.75A.75.75 0 0 0 14.75 2h-3.5a.75.75 0 0 0-.53 1.28Z');
    svg.appendChild(path);
    anchor.appendChild(svg);
  }

  /**
   * Apply the resolved links config to the header DOM.
   *
   *   - Hide `#github-link` if links.github === false.
   *   - Hide `#graphite-link` if links.graphite === false.
   *   - Insert an `#external-link` anchor before `#github-link` when
   *     `links.external` is set and substitution succeeds.
   *
   * Idempotent: a pre-existing `#external-link` is replaced rather than
   * duplicated. Safe to call multiple times (e.g. after a refresh).
   *
   * @param {Object} links     resolved links config from the server
   * @param {Object} context   substitution context for url_template
   */
  function applyRepoLinks(links, context) {
    if (!links || typeof links !== 'object') return;

    const githubLink = document.getElementById('github-link');
    if (githubLink) {
      if (links.github === false) {
        githubLink.style.display = 'none';
      }
    }

    const graphiteLink = document.getElementById('graphite-link');
    if (graphiteLink) {
      if (links.graphite === false) {
        // Permanently hide — overrides the enable_graphite toggle for
        // this repo. Stored on a data attribute so pr.js can detect the
        // suppression and skip the show-on-load codepath.
        graphiteLink.style.display = 'none';
        graphiteLink.dataset.suppressed = 'true';
      }
    }

    // Remove any previously inserted external link before re-inserting.
    const existing = document.getElementById('external-link');
    if (existing) existing.remove();

    if (links.external) {
      const anchor = buildExternalLink(links.external, context);
      if (anchor) {
        // Insert just before #github-link if present; otherwise append to
        // the icon group. Falls back to header-right > div if needed.
        if (githubLink && githubLink.parentNode) {
          githubLink.parentNode.insertBefore(anchor, githubLink);
        } else {
          const iconGroup = document.querySelector('.header .header-icon-group')
            || document.querySelector('.header-icon-group');
          if (iconGroup) iconGroup.appendChild(anchor);
        }
      }
    }
  }

  /**
   * Fetch the resolved links config for an owner/repo and apply it.
   *
   * @param {string} owner
   * @param {string} repo
   * @param {Object} context  substitution context (owner, repo, number,
   *                          branch, base_branch, head_sha)
   * @returns {Promise<void>}
   */
  async function fetchAndApplyRepoLinks(owner, repo, context) {
    if (!owner || !repo) return;
    // Reset so a failed fetch (or a repo with no links) falls back to the
    // "GitHub" defaults rather than carrying a previous review's host name.
    _currentLinks = null;
    _currentContext = context || null;
    try {
      const response = await fetch(
        '/api/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/links'
      );
      if (!response.ok) {
        console.warn('[repo-links] Failed to fetch repo links:', response.status);
        return;
      }
      const data = await response.json();
      _currentLinks = (data && data.links) || null;
      applyRepoLinks(_currentLinks, context);
    } catch (err) {
      console.warn('[repo-links] Error fetching repo links:', err);
    }
  }

  /**
   * Display name of the remote code host for the current review, for use
   * in user-facing text in place of the literal "GitHub". Returns the
   * configured `links.external.name`, or "GitHub" when unset. Server-side
   * counterpart: `resolveHostName` in src/links/repo-links.js.
   *
   * @returns {string}
   */
  function hostName() {
    if (_currentLinks && _currentLinks.external && _currentLinks.external.name) {
      return _currentLinks.external.name;
    }
    return 'GitHub';
  }

  /**
   * The substituted external URL for the current review (built from
   * `links.external.url_template` and the stored context), or null when no
   * external link is configured or substitution fails (e.g. Local mode,
   * which has no `{number}`).
   *
   * @returns {string|null}
   */
  function externalUrl() {
    if (!_currentLinks || !_currentLinks.external || !_currentLinks.external.url_template) {
      return null;
    }
    return substituteUrlTemplate(_currentLinks.external.url_template, _currentContext || {});
  }

  /**
   * The configured (server-sanitised) external host icon SVG string for the
   * current review, or null when none is configured.
   *
   * @returns {string|null}
   */
  function externalIcon() {
    if (_currentLinks && _currentLinks.external && _currentLinks.external.icon) {
      return _currentLinks.external.icon;
    }
    return null;
  }

  const api = {
    substituteUrlTemplate,
    parseSvgIcon,
    buildExternalLink,
    applyRepoLinks,
    fetchAndApplyRepoLinks,
    hostName,
    externalUrl,
    externalIcon,
  };

  // Expose on window for use by pr.js and local.js.
  if (typeof window !== 'undefined') {
    window.RepoLinks = api;
  }

  // Also export for Node.js/test environments. Tests that only need the
  // pure functions (substituteUrlTemplate) don't need a DOM.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
