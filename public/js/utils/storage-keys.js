// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared localStorage-key helpers.
 *
 * Single source of truth for repository-scoped storage keys. These keys are
 * shared ACROSS pages — the index/bulk page writes per-repo keys (e.g.
 * `pair-review-tab`, `pair-review-instructions`) that the PR page later reads
 * via `PRManager.getRepoStorageKey`. Any divergence in the base64 byte
 * assembly would silently break remembered-tab / instructions reuse with no
 * error, so the encoding lives here once rather than being copied per page.
 */

/**
 * Base64-encode a UTF-8 string in a byte-accurate way (btoa alone mangles
 * multibyte characters).
 * @param {string} value
 * @returns {string} Base64 (with '=' padding)
 */
function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Generate a safe localStorage key for repository-specific settings.
 * Uses base64 encoding to handle special characters in owner/repo names.
 * @param {string} prefix - Key prefix (e.g. 'pair-review-tab')
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {string} Safe localStorage key
 */
function getRepoStorageKey(prefix, owner, repo) {
  try {
    const repoId = encodeBase64Utf8(owner + '/' + repo).replace(/=/g, '');
    return prefix + ':' + repoId;
  } catch (_error) {
    return prefix + ':' + encodeURIComponent(owner + '/' + repo);
  }
}

if (typeof window !== 'undefined') {
  window.encodeBase64Utf8 = encodeBase64Utf8;
  window.getRepoStorageKey = getRepoStorageKey;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { encodeBase64Utf8, getRepoStorageKey };
}
